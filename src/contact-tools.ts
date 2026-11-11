import type { PublicEnrichContact, PublicEnrichField } from "./contracts.js";
import { z } from "zod";
import type { ApiResult, Tolerant, TolerantStrings } from "./api.js";
import { type ToolResult, json, pendingResult } from "./results.js";
import { RUN_ID_PATTERN, formatRunId } from "./run-id.js";

export type ContactField = Exclude<PublicEnrichField, "linkedin_url">;

/** ACU billed only when the contact is found; a miss, an unavailable lookup and the profile reread are free. */
export const CONTACT_ACU: Record<ContactField, number> = { work_email: 1, personal_email: 3, phone: 10 };

/** A contact lookup on an already-researched person waits for the API's provider deadline (80 s request cap), longer than the 20 s default. */
export const CONTACT_REQUEST_TIMEOUT_MS = 90_000;

const ContactSchema = z
    .object({
        value: z.string().nullable(),
        status: z.enum(["found", "not_found", "unavailable"]),
        confidence: z.string().nullish(),
        source: z.string().nullish(),
        last_seen: z.string().nullish(),
        employer: z.object({ name: z.string().nullable(), domain: z.string() }).nullish(),
    })
    .passthrough() satisfies z.ZodType<
    Pick<PublicEnrichContact, "value" | "status"> &
        TolerantStrings<PublicEnrichContact, "confidence" | "source"> &
        Tolerant<PublicEnrichContact, "last_seen" | "employer">
>;

const ContactResponseSchema = z
    .object({
        person_id: z.string(),
        identity: z.object({ name: z.string().nullish(), company: z.string().nullish() }).passthrough().optional(),
        contact: z.record(z.string(), ContactSchema).optional(),
    })
    .passthrough();

const PendingRunSchema = z.object({ run_id: z.string().regex(RUN_ID_PATTERN), status: z.enum(["queued", "running", "cancelled"]) }).passthrough();

export type ContactLookup =
    | { kind: "pending"; result: ToolResult }
    | { kind: "not_found"; result: ToolResult }
    | { kind: "found"; result: ToolResult }
    | { kind: "unavailable"; result: ToolResult }
    | { kind: "still_looking"; result: ToolResult };

function label(field: ContactField): string {
    return field === "work_email" ? "work email" : field === "personal_email" ? "personal email" : "phone number";
}

/** Classifies one POST /v1/person answer for the requested contact field. */
export function contactLookup(result: ApiResult, field: ContactField, tool: string): ContactLookup {
    const run = PendingRunSchema.safeParse(result.data);
    if (run.success) {
        const runId = formatRunId("person", run.data.run_id);
        const pending = pendingResult(runId, run.data.status, 10, { usage: result.meta.usage ?? {} });
        pending.content[0]!.text += ` This person has not been researched yet, so a standard profile is being established first (10 ACU on success; research_person at deep later costs only the 15 ACU difference). The ${label(field)} was requested with it and arrives in the completed get_research_status result under contact.${field}; do not call ${tool} again for it, since every found contact is billed on every request.`;
        pending.structuredContent = { ...pending.structuredContent, requested_contact: field };
        return { kind: "pending", result: pending };
    }
    const meta = result.meta as { found?: boolean; usage?: unknown; warnings?: string[]; message?: string };
    if (result.data === null) {
        return {
            kind: "not_found",
            result: {
                content: [
                    {
                        type: "text",
                        text: `Ploid could not establish this person's identity, so no ${label(field)} was looked up. ${meta.message ?? ""}`.trim(),
                    },
                ],
                structuredContent: { status: "completed", found: false, field, ...meta },
            },
        };
    }
    const person = ContactResponseSchema.safeParse(result.data);
    if (!person.success) throw new Error("Ploid returned neither a person result nor a pending run.");
    const contact = person.data.contact?.[field];
    const name = person.data.identity?.name ?? "this person";
    const usage = meta.usage ? `\nUsage:\n${json(meta.usage)}` : "";
    const base = { person_id: person.data.person_id, name: person.data.identity?.name ?? null, field };
    if (contact?.status === "found" && contact.value) {
        const detail = [
            contact.confidence ? `confidence ${contact.confidence}` : null,
            contact.source ? `source ${contact.source}` : null,
            contact.employer?.domain ? `employer domain ${contact.employer.domain}` : null,
        ]
            .filter(Boolean)
            .join(", ");
        return {
            kind: "found",
            result: {
                content: [
                    {
                        type: "text",
                        text: `${label(field)[0]!.toUpperCase()}${label(field).slice(1)} for ${name}: ${contact.value}${detail ? ` (${detail})` : ""}.${usage}`,
                    },
                ],
                structuredContent: { status: "completed", found: true, ...base, value: contact.value, contact, usage: meta.usage ?? {} },
            },
        };
    }
    const stillLooking = (meta.warnings ?? []).some((warning) => warning.startsWith(`${field} is still being looked up`));
    if (stillLooking) {
        return {
            kind: "still_looking",
            result: {
                content: [
                    {
                        type: "text",
                        text: `The ${label(field)} for ${name} is still being looked up. Call ${tool} again in about 30 seconds; nothing was charged.${usage}`,
                    },
                ],
                structuredContent: { status: "still_looking", found: false, ...base, retry_after_seconds: 30, usage: meta.usage ?? {} },
            },
        };
    }
    return {
        kind: contact?.status === "unavailable" ? "unavailable" : "not_found",
        result: {
            content: [{ type: "text", text: `No ${label(field)} is available for ${name}; nothing was charged for it.${usage}` }],
            structuredContent: { status: "completed", found: false, ...base, contact: contact ?? null, usage: meta.usage ?? {} },
        },
    };
}

/** Carries the usage of an earlier step (for example the work-email request that also unlocked the profile) into the final result. */
export function withPriorUsage(result: ToolResult, step: string, usage: unknown): ToolResult {
    if (!usage) return result;
    result.content[0]!.text += `\nUsage of the earlier ${step} request (already charged):\n${json(usage)}`;
    result.structuredContent = { ...result.structuredContent, prior_usage: { [step]: usage } };
    return result;
}

/** The personal-email fallback runs only after a definite work-email miss, so a found work email never also bills the personal one. */
export function emailFallbackApplies(lookup: ContactLookup): boolean {
    return lookup.kind === "not_found" || lookup.kind === "unavailable";
}
