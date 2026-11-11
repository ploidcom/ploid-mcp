import type {
    PublicSetCancelResult,
    PublicSetCreated,
    PublicSetDetail,
    PublicSetItem,
    PublicSetItemsPage,
    PublicSetSearch,
    SetSearchStatus,
} from "./contracts.js";
import { z } from "zod";
import { type ApiResult, type PloidMcpOptions, type Tolerant, type TolerantStrings, PloidApiError, PloidRunEndedError, callApi } from "./api.js";
import { type ToolResult, json, notActiveResult, pendingResult } from "./results.js";
import { RUN_ID_PATTERN, formatRunId } from "./run-id.js";

const SearchStatusSchema = z.enum({
    created: "created",
    running: "running",
    completed: "completed",
    canceled: "canceled",
    failed: "failed",
} satisfies { [S in SetSearchStatus]: S });

/** Passed through to the tool result without interpretation. */
const PricingSchema = z.record(z.string(), z.unknown());

const SetCreatedSchema = z
    .object({
        id: z.string().regex(RUN_ID_PATTERN),
        search: z
            .object({ count: z.number().optional(), query: z.string().optional(), criteria: z.array(z.string()).optional() })
            .passthrough()
            .optional(),
        pricing: PricingSchema.optional(),
    })
    .passthrough() satisfies z.ZodType<
    Pick<PublicSetCreated, "id"> & { search?: Tolerant<PublicSetCreated["search"], "count" | "query" | "criteria">; pricing?: Record<string, unknown> }
>;

const SetStatusSchema = z
    .object({
        id: z.string(),
        admitted_count: z.number().optional(),
        pricing: PricingSchema.optional(),
        searches: z.array(
            z
                .object({
                    id: z.string(),
                    status: SearchStatusSchema,
                    count: z.number().int().positive().optional(),
                    query: z.string().optional(),
                    criteria: z.unknown().optional(),
                    stop_reason: z.string().nullish(),
                    queue: z.object({ position: z.number(), estimated_wait_seconds: z.number() }).nullish(),
                })
                .passthrough(),
        ),
    })
    .passthrough() satisfies z.ZodType<
    Pick<PublicSetDetail, "id"> &
        Tolerant<PublicSetDetail, "admitted_count"> & {
            pricing?: Record<string, unknown>;
            searches: Array<
                Pick<PublicSetSearch, "id" | "status"> &
                    Tolerant<PublicSetSearch, "count" | "query" | "criteria" | "queue"> &
                    TolerantStrings<PublicSetSearch, "stop_reason">
            >;
        }
>;

const SetItemsSchema = z
    .object({
        items: z.array(
            z
                .object({
                    id: z.string(),
                    name: z.string().nullish(),
                    title: z.string().nullish(),
                    company: z.string().nullish(),
                    location: z.string().nullish(),
                    linkedin_url: z.string().nullish(),
                    verification: z.unknown().optional(),
                })
                .passthrough(),
        ),
    })
    .passthrough() satisfies z.ZodType<{
    [K in keyof Pick<PublicSetItemsPage, "items">]: Array<
        Pick<PublicSetItem, "id"> & Tolerant<PublicSetItem, "name" | "title" | "company" | "location" | "linkedin_url" | "verification">
    >;
}>;

/** GET /v1/sets/:id/items returns at most 200 items per page. */
const MAX_ITEMS_PAGE = 200;

const SetCancelSchema = z.object({ searches: z.array(z.string()).optional() }).passthrough() satisfies z.ZodType<Tolerant<PublicSetCancelResult, "searches">>;

/** Keeps the titles criterion under the Sets 500-character criterion limit without truncating. */
export const DECISION_MAKER_TITLES = { max: 8, maxLength: 50 } as const;

export function decisionMakersSearch(input: { company: string; product: string; titles?: string[] }) {
    const titles = input.titles ?? [];
    return {
        query: `Decision-makers and buying influencers for ${input.product}${titles.length ? `, such as ${titles.join(", ")}` : ""}`,
        criteria: [
            `Currently works at ${input.company}`,
            `Holds a role that would evaluate, buy, or influence the purchase of ${input.product}`,
            ...(titles.length ? [`Role matches or is equivalent to one of: ${titles.join(", ")}`] : []),
        ],
        // Sets appends this as "at <company>" and uses it as a retrieval hint.
        filters: { company: input.company },
    };
}

export function setCreatedResult(result: ApiResult): ToolResult {
    const created = SetCreatedSchema.safeParse(result.data);
    if (!created.success) throw new Error("Ploid returned an invalid people search response.");
    return pendingResult(formatRunId("set", created.data.id), "running", 5, {
        ...(created.data.search ? { search: created.data.search } : {}),
        ...(created.data.pricing ? { pricing: created.data.pricing } : {}),
    });
}

/** A rough wait in words; the estimate is not precise enough for seconds. */
export function queueProgress(queue: { position: number; estimated_wait_seconds: number }): string {
    const place = queue.position <= 1 ? "It is next in the queue" : `It is number ${queue.position} in the queue`;
    if (queue.estimated_wait_seconds < 45) return `${place} and should start within a minute.`;
    const minutes = Math.round(queue.estimated_wait_seconds / 60);
    return `${place} and should start in about ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
}

function setPath(setId: string, suffix = ""): string {
    return `/v1/sets/${encodeURIComponent(setId)}${suffix}`;
}

/** The Set and the search this MCP tool started: its original (oldest) search, since searches come newest first. */
async function originalSearch(options: PloidMcpOptions, setId: string, signal: AbortSignal) {
    let result: ApiResult;
    try {
        result = await callApi(options, "GET", setPath(setId), { signal });
    } catch (error) {
        // A Set that no longer exists (or was never created) is gone for good.
        if (error instanceof PloidApiError && error.status === 404) throw new PloidRunEndedError("This people search no longer exists.", { cause: error });
        throw error;
    }
    const parsed = SetStatusSchema.safeParse(result.data);
    if (!parsed.success) throw new Error("Ploid returned an invalid people search status.");
    const search = parsed.data.searches.at(-1);
    if (!search) throw new Error("This people search has no search to report.");
    return { set: parsed.data, search };
}

export async function setStatus(options: PloidMcpOptions, setId: string, runId: string, signal: AbortSignal): Promise<ToolResult> {
    const { set, search } = await originalSearch(options, setId, signal);
    if (search.status === "created") {
        const wait = search.queue?.estimated_wait_seconds;
        return pendingResult(
            runId,
            "queued",
            // No point polling every few seconds through a wait of minutes.
            wait === undefined ? 5 : Math.min(60, Math.max(5, Math.round(wait / 4))),
            {
                set_admitted_so_far: set.admitted_count ?? 0,
                ...(search.queue ? { queue_position: search.queue.position, estimated_wait_seconds: search.queue.estimated_wait_seconds } : {}),
            },
            search.queue ? queueProgress(search.queue) : undefined,
        );
    }
    if (search.status === "running") {
        const admitted = set.admitted_count ?? 0;
        return pendingResult(
            runId,
            "running",
            5,
            { set_admitted_so_far: admitted, ...(search.count ? { requested_count: search.count } : {}) },
            // The count is the whole list's: a Set can hold people from other searches too.
            `${admitted} ${admitted === 1 ? "person is" : "people are"} in the Ploid list so far${search.count ? `; this search is looking for ${search.count}` : ""}. Each person is added as soon as they are verified, so the list can be read before the search finishes.`,
        );
    }
    if (search.status === "failed") {
        throw new PloidRunEndedError("The people search could not finish. People already admitted remain in the Ploid workspace list.");
    }

    const query = new URLSearchParams({ status: "admitted", limit: String(Math.min(MAX_ITEMS_PAGE, search.count ?? MAX_ITEMS_PAGE)), search_id: search.id });
    const items = SetItemsSchema.safeParse((await callApi(options, "GET", setPath(setId, `/items?${query}`), { signal })).data);
    if (!items.success) throw new Error("Ploid returned invalid people search results.");
    const people = items.data.items.map((item) => ({
        id: item.id,
        name: item.name ?? null,
        title: item.title ?? null,
        company: item.company ?? null,
        location: item.location ?? null,
        linkedin_url: item.linkedin_url ?? null,
        verification: item.verification ?? null,
    }));
    const status = search.status === "canceled" ? "cancelled" : "completed";
    const matches = `${people.length} verified ${people.length === 1 ? "match" : "matches"}`;
    const summary =
        status === "cancelled"
            ? `People search ${runId} was cancelled. ${people.length} people were admitted before it stopped.`
            : search.stop_reason === "budget"
              ? `People search ${runId} stopped at its budget limit with ${matches}${search.query ? ` for: ${search.query}` : ""}.`
              : `People search ${runId} completed with ${matches}${search.query ? ` for: ${search.query}` : ""}.`;
    const lines = people.map((person, index) => {
        const role = [person.title, person.company ? `at ${person.company}` : null].filter(Boolean).join(" ");
        return `${index + 1}. ${person.name ?? "Unnamed person"}${role ? ` — ${role}` : ""}${person.location ? ` (${person.location})` : ""}${person.linkedin_url ? ` · ${person.linkedin_url}` : ""}`;
    });
    const text = [
        summary,
        lines.length ? `\n${lines.join("\n")}` : "",
        `\nResults with verification:\n${json(people)}`,
        set.pricing ? `\nPricing:\n${json(set.pricing)}` : "",
    ]
        .filter(Boolean)
        .join("\n");
    return {
        content: [{ type: "text", text }],
        structuredContent: {
            status,
            run_id: runId,
            query: search.query ?? null,
            criteria: search.criteria ?? null,
            ...(search.stop_reason ? { stop_reason: search.stop_reason } : {}),
            people,
            ...(set.pricing ? { pricing: set.pricing } : {}),
        },
    };
}

export async function cancelSet(options: PloidMcpOptions, setId: string, runId: string, signal: AbortSignal): Promise<ToolResult> {
    // The cancel endpoint stops every active search in the Set. Only send it while the search
    // this tool started is still active; a finished search never cancels later workspace searches.
    const { search } = await originalSearch(options, setId, signal);
    if (search.status !== "created" && search.status !== "running") return notActiveResult(runId);
    const parsed = SetCancelSchema.safeParse((await callApi(options, "POST", setPath(setId, "/cancel"), { signal })).data);
    if (!parsed.success) throw new Error("Ploid returned an invalid cancellation response.");
    if (!parsed.data.searches?.length) return notActiveResult(runId);
    return {
        content: [
            {
                type: "text",
                text: `Cancellation requested for people search ${runId}. People admitted before it stops are kept and billed. Call get_research_status to see the final state.`,
            },
        ],
        structuredContent: { status: "cancel_requested", run_id: runId },
    };
}
