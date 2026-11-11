import { createMcpHandler, isLegacyRequest, McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
    type ApiResult,
    type PloidMcpOptions,
    PloidApiError,
    PloidRunEndedError,
    authenticatedRequestScope,
    callApi,
    errorText,
    isTransient,
    mcpIdempotencyKey,
} from "./api.js";
import { boundedArray, boundedInt, boundedString, rangeNote } from "./bounds.js";
import { CONTACT_ACU, CONTACT_REQUEST_TIMEOUT_MS, type ContactField, contactLookup, emailFallbackApplies, withPriorUsage } from "./contact-tools.js";
import { cancelPerson, personResult, personStatus } from "./person.js";
import {
    contactPersonInputSchema,
    researchInputs,
    researchPersonInputSchema,
    searchPeopleInputSchema,
    searchPeopleResult,
    selectedPerson,
} from "./person-tools.js";
import { type ToolResult, errorResult } from "./results.js";
import { type RunKind, RUN_ID_PATTERN, parseRunId } from "./run-id.js";
import { DECISION_MAKER_TITLES, cancelSet, decisionMakersSearch, setCreatedResult, setStatus } from "./sets.js";
import { MCP_SERVER_VERSION } from "./version.js";

export { type PloidMcpOptions, mcpIdempotencyKey } from "./api.js";

const FIND_PEOPLE_COUNT = { min: 1, max: 25, default: 10 } as const;
const DECISION_MAKERS_COUNT = { min: 1, max: 20, default: 5 } as const;

export const BILLABLE_TOOL_ANNOTATIONS = {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
} as const;

type RunHandler = (options: PloidMcpOptions, id: string, runId: string, signal: AbortSignal) => Promise<ToolResult>;

const RUN_HANDLERS: Record<RunKind, { status: RunHandler; cancel: RunHandler }> = {
    person: { status: personStatus, cancel: cancelPerson },
    set: { status: setStatus, cancel: cancelSet },
};

function runErrorText(runId: string, error: unknown): string {
    const detail = errorText(error).replace(/\.$/, "");
    const status = error instanceof PloidApiError ? error.payload?.error?.status : undefined;
    if (error instanceof PloidRunEndedError || status === "failed" || status === "cancelled") {
        return `Run ${runId}: ${detail}. This run has ended; stop polling it.`;
    }
    if (isTransient(error)) return `Run ${runId}: ${detail}. The run continues; check its status again shortly.`;
    return `Run ${runId}: ${detail}.`;
}

export function createPloidMcpServer(options: PloidMcpOptions = {}): McpServer {
    // JSON-RPC ids are local to a connection and are reused after restarting
    // Claude. A new connection must not replay last session's stale research.
    return createServer(options, `stdio:${randomUUID()}`);
}

function createServer(options: PloidMcpOptions, requestNamespace: string, operationKey?: string): McpServer {
    const requestIdentity = (id: string | number) => (operationKey ? `http-key:${operationKey}` : `rpc:${JSON.stringify(id)}`);
    const requestScope = (sessionId?: string) => (sessionId ? `session:${sessionId}` : requestNamespace);
    const server = new McpServer(
        { name: "ploid-people-intelligence", version: MCP_SERVER_VERSION, websiteUrl: "https://ploid.com" },
        {
            instructions:
                "Use Ploid for source-reviewed person research, verified contact details (get_email, get_phone) and for finding verified lists of people and decision-makers. For a name, use search_people first (1 ACU per completed search, including no matches) and ask the user to choose a candidate, even if only one is returned. research_person needs that selected person_id or an explicit LinkedIn person URL; first workspace access costs 25 ACU for deep research (the default) or 10 ACU for standard, moving from standard to deep costs the 15 ACU difference, and rereads at the same or a lower level within 90 days are free. find_people and find_decision_makers bill per verified match. Starting these tools consumes the connected workspace's ACU balance. Pending tools return a run_id, not an answer. Use get_research_status to retrieve the result; keep the run_id for resuming later. Only cancel research when the user asks to stop it.",
        },
    );

    type StartExtra = { mcpReq: { id: string | number; signal: AbortSignal }; sessionId?: string };

    function post(operation: string, path: string, body: unknown, extra: StartExtra, timeoutMs?: number): Promise<ApiResult> {
        const idempotencyKey = mcpIdempotencyKey(
            requestIdentity(extra.mcpReq.id),
            operation,
            body,
            authenticatedRequestScope(options, requestScope(extra.sessionId)),
        );
        return callApi(options, "POST", path, { body, signal: extra.mcpReq.signal, idempotencyKey, timeoutMs });
    }

    async function start(operation: string, path: string, body: unknown, extra: StartExtra, toResult: (result: ApiResult) => ToolResult): Promise<ToolResult> {
        try {
            return toResult(await post(operation, path, body, extra));
        } catch (error) {
            return errorResult(errorText(error), error);
        }
    }

    /** One contact field through POST /v1/person include; the profile reread is free, the contact bills only when found. */
    async function contact(tool: string, identifier: unknown, field: ContactField, extra: StartExtra) {
        return contactLookup(
            await post(`${tool}:${field}`, "/v1/person", { identifier, include: [field], type: "standard" }, extra, CONTACT_REQUEST_TIMEOUT_MS),
            field,
            tool,
        );
    }

    server.registerTool(
        "search_people",
        {
            title: "Search people by name",
            description:
                "Find up to 10 matching profiles in Ploid's people index for 1 ACU per completed search, including no matches, without starting research. Failed searches are not charged. Results are bounded, not exhaustive, and indexed details may be stale; identity_verified is always false here (research_person verifies) and profile_url is only set for a non-LinkedIn profile. A company filter matches that employer exactly, including its aliases. Show the candidates and ask the user to choose before research_person, even for a single match. Use company, location or title to narrow a name.",
            inputSchema: searchPeopleInputSchema,
            annotations: BILLABLE_TOOL_ANNOTATIONS,
        },
        (input, extra) => start("search_people", "/v1/search/candidates", input, extra, searchPeopleResult),
    );

    server.registerTool(
        "research_person",
        {
            title: "Research a person",
            description:
                "Start source-reviewed research on one person, identified by exactly one of person_id (selected from search_people) or linkedin_url (an explicit HTTPS LinkedIn person profile URL); never pass both. For a name, search and ask the user to choose first. Set type to standard for lighter research (10 ACU) or leave the default deep (25 ACU); moving a standard profile up to deep costs the 15 ACU difference. Optionally pass goal (what to look for), website_url (their own site) and up to 10 anchors (public URLs you know belong to them, such as an X profile or a podcast episode); a run with these is not served from or saved to the shared profile. First workspace access is charged even for an already-cached profile; rereads at the same or a lower level within 90 days are free. Not-found and uncertain results are free. Returns a resumable run_id when pending; use get_research_status for the result.",
            inputSchema: researchPersonInputSchema,
            annotations: BILLABLE_TOOL_ANNOTATIONS,
        },
        (input, extra) =>
            start("research_person", "/v1/person", { identifier: selectedPerson(input), ...researchInputs(input) }, extra, (result) => personResult(result)),
    );

    server.registerTool(
        "get_email",
        {
            title: "Get a person's email",
            description: `Look up one person's email, identified by exactly one of person_id (from search_people) or linkedin_url. Tries the work email first (${CONTACT_ACU.work_email} ACU when found); only when no work email exists does it look up the personal email (${CONTACT_ACU.personal_email} ACU when found). Misses are free. Never upgrades an existing profile: a person researched at any level is reread for free. An unresearched person starts standard research_person (10 ACU on success; deep later costs the 15 ACU difference) and returns a run_id; the work email then arrives with the completed get_research_status result (call get_email again only if that result has no work email, to try the personal one).`,
            inputSchema: contactPersonInputSchema,
            annotations: BILLABLE_TOOL_ANNOTATIONS,
        },
        async (input, extra) => {
            try {
                const identifier = selectedPerson(input);
                const work = await contact("get_email", identifier, "work_email", extra);
                if (!emailFallbackApplies(work)) return work.result;
                const personal = await contact("get_email", identifier, "personal_email", extra);
                if (personal.kind === "found") {
                    personal.result.content[0]!.text = `No work email is available; falling back to the personal email. ${personal.result.content[0]!.text}`;
                    personal.result.structuredContent = {
                        ...personal.result.structuredContent,
                        work_email: work.result.structuredContent?.["contact"] ?? null,
                    };
                }
                return withPriorUsage(personal.result, "work_email", work.result.structuredContent?.["usage"]);
            } catch (error) {
                return errorResult(errorText(error), error);
            }
        },
    );

    server.registerTool(
        "get_phone",
        {
            title: "Get a person's phone number",
            description: `Look up one person's mobile phone number, identified by exactly one of person_id (from search_people) or linkedin_url: ${CONTACT_ACU.phone} ACU when found, free when not. Never upgrades an existing profile: a person researched at any level is reread for free. An unresearched person starts standard research_person (10 ACU on success; deep later costs the 15 ACU difference) and returns a run_id; the phone then arrives with the completed get_research_status result, so do not call get_phone again for it.`,
            inputSchema: contactPersonInputSchema,
            annotations: BILLABLE_TOOL_ANNOTATIONS,
        },
        async (input, extra) => {
            try {
                return (await contact("get_phone", selectedPerson(input), "phone", extra)).result;
            } catch (error) {
                return errorResult(errorText(error), error);
            }
        },
    );

    server.registerTool(
        "find_people",
        {
            title: "Find people",
            description:
                "Build a verified list of people from a natural-language sales or research query. Each match is checked against criteria derived from the query. count must be 1 to 25; other values are rejected without starting a job. Returns a resumable run_id; use get_research_status for the list.",
            inputSchema: z.object({
                query: boundedString(1, 4_000).describe("Natural-language description of the people to find, up to 4000 characters."),
                count: boundedInt(FIND_PEOPLE_COUNT.min, FIND_PEOPLE_COUNT.max)
                    .default(FIND_PEOPLE_COUNT.default)
                    .describe(`People to find. ${rangeNote(FIND_PEOPLE_COUNT.min, FIND_PEOPLE_COUNT.max, FIND_PEOPLE_COUNT.default)}`),
            }),
            annotations: BILLABLE_TOOL_ANNOTATIONS,
        },
        (input, extra) =>
            start("find_people", "/v1/sets", { search: { query: input.query, count: input.count }, metadata: { source: "mcp" } }, extra, setCreatedResult),
    );

    server.registerTool(
        "find_decision_makers",
        {
            title: "Find decision-makers",
            description:
                "Build a verified list of likely buyers and influencers at a company for a specific product. count must be 1 to 20; other values are rejected without starting a job. Returns a resumable run_id; use get_research_status for the list.",
            inputSchema: z.object({
                company: boundedString(1, 200).describe("The company to search, up to 200 characters."),
                product: boundedString(1, 300).describe("The product or service being sold, up to 300 characters."),
                count: boundedInt(DECISION_MAKERS_COUNT.min, DECISION_MAKERS_COUNT.max)
                    .default(DECISION_MAKERS_COUNT.default)
                    .describe(`People to find. ${rangeNote(DECISION_MAKERS_COUNT.min, DECISION_MAKERS_COUNT.max, DECISION_MAKERS_COUNT.default)}`),
                titles: boundedArray(boundedString(1, DECISION_MAKER_TITLES.maxLength), DECISION_MAKER_TITLES.max)
                    .describe(`Job titles to prioritize, up to ${DECISION_MAKER_TITLES.max} titles of ${DECISION_MAKER_TITLES.maxLength} characters each.`)
                    .optional(),
            }),
            annotations: BILLABLE_TOOL_ANNOTATIONS,
        },
        (input, extra) =>
            start(
                "find_decision_makers",
                "/v1/sets",
                { search: { ...decisionMakersSearch(input), count: input.count }, metadata: { source: "mcp" } },
                extra,
                setCreatedResult,
            ),
    );

    const runInput = z.object({
        run_id: boundedString(1, 200)
            .regex(RUN_ID_PATTERN)
            .describe("A run_id returned by a research tool, such as person-<id> or set-<id>, up to 200 characters."),
    });
    const runTool =
        (action: "status" | "cancel") =>
        async ({ run_id }: { run_id: string }, extra: { mcpReq: { signal: AbortSignal } }) => {
            const run = parseRunId(run_id);
            if (!run) {
                return errorResult(
                    `Run ${run_id} is not a current Ploid run ID. Run IDs from retired Ploid research tools can no longer be retrieved; start a new request with research_person, find_people, or find_decision_makers.`,
                );
            }
            try {
                return await RUN_HANDLERS[run.kind][action](options, run.id, run_id, extra.mcpReq.signal);
            } catch (error) {
                return errorResult(runErrorText(run_id, error), error, run_id);
            }
        };

    server.registerTool(
        "get_research_status",
        {
            title: "Get research status or result",
            description:
                "Retrieve a pending or completed research_person, find_people, or find_decision_makers run by run_id, including after reconnecting. Pending runs should be checked no more often than every 5 seconds. Does not start or cancel research.",
            inputSchema: runInput,
            annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
        },
        runTool("status"),
    );

    server.registerTool(
        "cancel_research",
        {
            title: "Cancel research",
            description:
                "Stop a research run when the user asks to cancel. Work already completed may still be charged, including people a search admitted before it stopped.",
            inputSchema: runInput,
            annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
        },
        runTool("cancel"),
    );
    return server;
}

/** Handle one stateless Streamable HTTP request (ChatGPT, Claude, or any MCP client). */
export async function handlePloidMcpRequest(request: Request, options: PloidMcpOptions): Promise<Response> {
    // Stateless HTTP has no server lifetime to identify a retry. Bind to the
    // authenticated caller and stable client session when one is supplied.
    // Same caller/session/id/arguments means retry; a fresh operation needs a
    // new JSON-RPC id or Idempotency-Key. Never use a per-request random salt.
    const sessionId = request.headers.get("mcp-session-id");
    const namespace = sessionId ? `session:${sessionId}` : "http";
    const operationKey = request.headers.get("idempotency-key") ?? undefined;
    if (!(await isLegacyRequest(request))) {
        return createMcpHandler(() => createServer(options, namespace, operationKey)).fetch(request);
    }
    // Preserve the standalone SSE GET used by existing 2025 clients.
    const transport = new WebStandardStreamableHTTPServerTransport();
    const server = createServer(options, namespace, operationKey);
    await server.connect(transport);
    return transport.handleRequest(request);
}

export async function serveMcp(): Promise<void> {
    const server = createPloidMcpServer();
    await server.connect(new StdioServerTransport());
}
