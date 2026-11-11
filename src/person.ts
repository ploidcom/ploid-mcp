import type { PublicEnrichContact } from "./contracts.js";
import type { PublicPersonRecord, PublicPersonResponse, PublicPersonRunResponse } from "./contracts.js";
import { z } from "zod";
import { type ApiResult, type PloidMcpOptions, type Tolerant, type TolerantStrings, PloidApiError, PloidRunEndedError, callApi } from "./api.js";
import { type ToolResult, cancelledResult, json, notActiveResult, pendingResult } from "./results.js";
import { RUN_ID_PATTERN, formatRunId } from "./run-id.js";

type PersonRun = PublicPersonRunResponse["data"];
type PersonIdentity = PublicPersonRecord["identity"];
type PersonSourceLink = PublicPersonRecord["source_links"][number];
type PersonMeta = PublicPersonResponse["meta"];

const PersonRunSchema = z
    .object({
        run_id: z.string().regex(RUN_ID_PATTERN),
        status: z.enum({ queued: "queued", running: "running", cancelled: "cancelled" } satisfies { [S in PersonRun["status"]]: S }),
    })
    .passthrough() satisfies z.ZodType<PersonRun>;

const PersonRecordSchema = z
    .object({
        person_id: z.string(),
        summary: z.string().optional(),
        identity: z
            .object({
                name: z.string().nullish(),
                headline: z.string().nullish(),
                company: z.string().nullish(),
                location: z.string().nullish(),
                linkedin_url: z.string().nullish(),
            })
            .passthrough()
            .optional(),
        source_links: z.array(z.object({ title: z.string(), url: z.string(), status: z.string().optional() }).passthrough()).optional(),
        contact: z.record(z.string(), z.object({ value: z.string().nullable(), status: z.string() }).passthrough()).optional(),
    })
    .passthrough() satisfies z.ZodType<
    Pick<PublicPersonRecord, "person_id"> &
        Tolerant<PublicPersonRecord, "summary"> & {
            contact?: Record<string, Pick<PublicEnrichContact, "value"> & TolerantStrings<PublicEnrichContact, "status">>;
            identity?: Tolerant<PersonIdentity, "name" | "headline" | "company" | "location" | "linkedin_url">;
            source_links?: Array<Pick<PersonSourceLink, "title" | "url"> & TolerantStrings<PersonSourceLink, "status">>;
        }
>;

const PersonMetaSchema = z
    .object({
        found: z.boolean().optional(),
        stale: z.boolean().optional(),
        access_expires_at: z.string().optional(),
        resolution: z.string().optional(),
        reason: z.string().optional(),
        message: z.string().optional(),
        suggested_clues: z.array(z.string()).optional(),
        usage: z.unknown().optional(),
    })
    .passthrough() satisfies z.ZodType<
    Tolerant<PersonMeta, "found" | "stale" | "access_expires_at" | "message"> &
        TolerantStrings<PersonMeta, "resolution" | "reason" | "suggested_clues"> & { [K in keyof Pick<PersonMeta, "usage">]?: unknown }
>;

export function personResult(result: ApiResult, knownRunId?: string): ToolResult {
    const run = PersonRunSchema.safeParse(result.data);
    if (run.success) {
        const runId = formatRunId("person", run.data.run_id);
        if (run.data.status === "cancelled") return cancelledResult(runId, result.meta);
        const pending = pendingResult(runId, run.data.status, 10, { usage: result.meta.usage ?? {} });
        pending.content[0]!.text += " A pending zero-usage response is not a promise of free completion; successful profile access can cost 25 ACU.";
        return pending;
    }

    const meta = PersonMetaSchema.safeParse(result.meta);
    const metaData = meta.success ? meta.data : {};
    const usage = meta.success ? meta.data.usage : undefined;
    const runField = knownRunId ? { run_id: knownRunId } : {};
    if (result.data === null && meta.success && meta.data.found === false) {
        const text =
            meta.data.resolution === "unsure"
                ? [
                      `Ploid could not establish this person's identity (${meta.data.reason ?? "insufficient_evidence"}). ${meta.data.message ?? ""}`.trim(),
                      meta.data.suggested_clues?.length ? `Suggested clues for a retry: ${meta.data.suggested_clues.join(", ")}.` : "",
                      "Do not treat a same-name profile as a confirmed match. Retry with a LinkedIn URL when one is known.",
                  ]
                : ["Ploid found no reviewed profile for this person."];
        return {
            content: [{ type: "text", text: [...text, usage ? `\nUsage:\n${json(usage)}` : ""].filter(Boolean).join("\n") }],
            structuredContent: { status: "completed", found: false, ...runField, ...meta.data },
        };
    }

    const person = PersonRecordSchema.safeParse(result.data);
    if (!person.success) throw new Error("Ploid returned neither a person result nor a pending run.");
    const identity = person.data.identity;
    const role = [identity?.headline, identity?.company ? `at ${identity.company}` : null].filter(Boolean).join(" ");
    const heading = [identity?.name ?? "Person", role ? `— ${role}` : "", identity?.location ? `(${identity.location})` : ""].filter(Boolean).join(" ");
    const sources = (person.data.source_links ?? []).map((link) => `- ${link.title}: ${link.url}${link.status ? ` (${link.status})` : ""}`);
    const contacts = Object.entries(person.data.contact ?? {}).map(
        ([field, entry]) => `- ${field}: ${entry.status === "found" && entry.value ? entry.value : entry.status}`,
    );
    const text = [
        `Person research completed: ${heading}`,
        contacts.length ? `\nContact (requested with this research; already billed where found):\n${contacts.join("\n")}` : "",
        person.data.summary ? `\n${person.data.summary}` : "",
        sources.length ? `\nSources:\n${sources.join("\n")}` : "",
        meta.success && meta.data.stale ? "\nThis profile is being refreshed in the background; some evidence may be older." : "",
        meta.success && meta.data.access_expires_at ? `\nRereads of this person are free until ${meta.data.access_expires_at}.` : "",
        `\nPerson record:\n${json(person.data)}`,
        usage ? `\nUsage:\n${json(usage)}` : "",
    ]
        .filter(Boolean)
        .join("\n");
    return {
        content: [{ type: "text", text }],
        structuredContent: { status: "completed", found: true, ...runField, person: person.data, ...metaData },
    };
}

function runPath(id: string): string {
    return `/v1/person/runs/${encodeURIComponent(id)}`;
}

/**
 * Codes GET /v1/person/runs/:id answers from the stored run, not from an outage. The API
 * reports a failed run as 409 and an unreviewable run as 503; neither is transient.
 */
const ENDED_RUN_CODES = new Set([
    "person_unavailable",
    "person_review_required",
    "person_billing_reconciliation_required",
    "insufficient_acu",
    "run_expired",
    "run_not_found",
]);

export async function personStatus(options: PloidMcpOptions, id: string, runId: string, signal: AbortSignal): Promise<ToolResult> {
    try {
        return personResult(await callApi(options, "GET", runPath(id), { signal }), runId);
    } catch (error) {
        if (error instanceof PloidApiError && (error.code === "run_cancelled" || error.payload?.error?.status === "cancelled")) {
            return cancelledResult(runId, { ...error.payload, http_status: error.status });
        }
        if (error instanceof PloidApiError && (error.payload?.error?.status === "failed" || (error.code && ENDED_RUN_CODES.has(error.code)))) {
            throw new PloidRunEndedError(error.message, { cause: error });
        }
        throw error;
    }
}

export async function cancelPerson(options: PloidMcpOptions, id: string, runId: string, signal: AbortSignal): Promise<ToolResult> {
    try {
        return personResult(await callApi(options, "DELETE", runPath(id), { signal }), runId);
    } catch (error) {
        if (error instanceof PloidApiError && error.code === "run_not_active") return notActiveResult(runId);
        throw error;
    }
}
