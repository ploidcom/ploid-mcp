import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { BILLABLE_TOOL_ANNOTATIONS, handlePloidMcpRequest, mcpIdempotencyKey } from "../src/server.js";

const originalFetch = globalThis.fetch;
const packageVersion = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

afterEach(() => {
    globalThis.fetch = originalFetch;
});

const person = {
    person_id: "person_ada",
    summary: "Ada Lovelace wrote the first published algorithm for the Analytical Engine.",
    identity: { name: "Ada Lovelace", linkedin_url: null, headline: "Mathematician", company: "Analytical Engines", location: "London", confidence: 0.9 },
    source_links: [{ title: "Biography", url: "https://example.org/ada", categories: ["identity"], status: "found", confidence: 0.9 }],
};

describe("Ploid Streamable HTTP MCP", () => {
    it("does not advertise ACU-spending tools as read-only", () => {
        expect(BILLABLE_TOOL_ANNOTATIONS).toMatchObject({ readOnlyHint: false, openWorldHint: true });
    });

    it.each([
        [{ linkedin_url: "https://www.linkedin.com/in/ada" }, { linkedin_url: "https://www.linkedin.com/in/ada" }],
        [{ person_id: "person_ada" }, { person_id: "person_ada" }],
    ])("starts /v1/person with a valid identifier (%j)", async (input, identifier) => {
        const fetchMock = vi.fn().mockResolvedValue(apiResponse({ data: { run_id: "run_1", status: "queued", poll_url: "/v1/person/runs/run_1" } }, 202));
        vi.stubGlobal("fetch", fetchMock);
        const response = await callTool("research_person", input);
        expect(response).not.toContain('"isError":true');
        expect(response).toContain("person-run_1");
        expect(response).toContain("25 ACU");
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.ploid.com/v1/person");
        expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ identifier });
        const headers = (fetchMock.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
        expect(headers["Idempotency-Key"]).toMatch(/^mcp:[a-f0-9]{32}$/);
    });

    it("passes the research level, goal, website and anchors to /v1/person", async () => {
        const fetchMock = vi.fn().mockResolvedValue(apiResponse({ data: { run_id: "run_1", status: "queued", poll_url: "/v1/person/runs/run_1" } }, 202));
        vi.stubGlobal("fetch", fetchMock);
        const input = {
            person_id: "person_ada",
            type: "standard",
            goal: "What has she said about hiring?",
            website_url: "https://ada.example/",
            anchors: ["https://x.com/ada", "https://x.com/ada"],
        };
        expect(await callTool("research_person", input)).not.toContain('"isError":true');
        expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
            identifier: { person_id: "person_ada" },
            type: "standard",
            goal: "What has she said about hiring?",
            website_url: "https://ada.example/",
            anchors: ["https://x.com/ada"],
        });
    });

    it.each([
        {},
        { person_id: "person_ada", anchors: ["http://x.com/ada"] },
        { person_id: "person_ada", type: "fast" },
        { company_domain: "analytical.example" },
        { name: " " },
        { name: "Ada Lovelace" },
        { name: "Ada Lovelace", company_domain: "Analytical Engines" },
        { linkedin_url: "https://ada.example/about" },
    ])("rejects input that cannot form a /v1/person identifier (%j)", async (input) => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        expect(await callTool("research_person", input)).toContain('"isError":true');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("tells the model which identifiers research_person needs", async () => {
        vi.stubGlobal("fetch", vi.fn());
        const body = await callTool("research_person", { name: "Ada Lovelace" });
        expect(body).toContain("linkedin_url");
        expect(body).toContain("search_people");
    });

    it("returns a found person with its reviewed summary and sources", async () => {
        const usage = { acu_used: 25, acu_value_usd: 0.1, billed: ["person.deep"], free: [], not_found: [] };
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                apiResponse({
                    data: person,
                    meta: { request_id: "req_1", found: true, stale: false, access_expires_at: "2026-12-24T00:00:00.000Z", usage },
                }),
            ),
        );
        const body = await callTool("research_person", { linkedin_url: "https://www.linkedin.com/in/ada" });
        expect(body).toContain("Person research completed: Ada Lovelace");
        expect(body).toContain("first published algorithm");
        expect(body).toContain("https://example.org/ada");
        expect(body).toContain('"status":"completed"');
        expect(body).toContain('"found":true');
        expect(body).toContain("person.deep");
    });

    it("keeps an uncertain identity distinct from a found person", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                apiResponse({
                    data: null,
                    meta: {
                        request_id: "req_1",
                        found: false,
                        stale: false,
                        resolution: "unsure",
                        reason: "ambiguous_identity",
                        message: "The available evidence does not reliably distinguish between matching people.",
                        limitations: [],
                        suggested_clues: ["linkedin_url"],
                        usage: { acu_used: 0, billed: [], free: [], not_found: [] },
                    },
                }),
            ),
        );
        const body = await callTool("research_person", { person_id: "person_ada" });
        expect(body).toContain("could not establish this person's identity");
        expect(body).toContain("Suggested clues for a retry: linkedin_url");
        expect(body).toContain('"found":false');
        expect(body).not.toContain('"isError":true');
    });

    it("starts a Set for find_people and returns its resumable run ID", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValue(
                apiResponse({ data: { id: "set_1", status: "running", search: { id: "search_1", status: "created", count: 12, query: "AI founders" } } }, 201),
            );
        vi.stubGlobal("fetch", fetchMock);
        const body = await callTool("find_people", { query: "AI founders in Berlin", count: 12 });
        expect(body).toContain("set-set_1");
        expect(body).toContain("get_research_status");
        expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.ploid.com/v1/sets");
        expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
            search: { query: "AI founders in Berlin", count: 12 },
            metadata: { source: "mcp" },
        });
    });

    it("composes a decision-maker Set from the company, product and roles", async () => {
        const fetchMock = vi.fn().mockResolvedValue(apiResponse({ data: { id: "set_2", status: "running" } }, 201));
        vi.stubGlobal("fetch", fetchMock);
        const body = await callTool("find_decision_makers", { company: "Acme", product: "sales software", titles: ["CRO"], count: 3 });
        expect(body).toContain("set-set_2");
        const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
        expect(request.search).toMatchObject({ count: 3, filters: { company: "Acme" } });
        expect(request.search.query).toContain("sales software");
        expect(request.search.criteria).toContain("Currently works at Acme");
    });

    it.each([
        ["find_people", { query: "AI founders", count: 0 }, "count: must be a whole number between 1 and 25 (got 0)"],
        ["find_people", { query: "AI founders", count: -5 }, "count: must be a whole number between 1 and 25 (got -5)"],
        ["find_people", { query: "AI founders", count: 26 }, "count: must be a whole number between 1 and 25 (got 26)"],
        ["find_people", { query: "AI founders", count: 2.5 }, "count: must be a whole number between 1 and 25 (got 2.5)"],
        ["find_people", { query: "a".repeat(4_001), count: 5 }, "query: must be at most 4000 characters (got 4001)"],
        ["find_decision_makers", { company: "Acme", product: "CRM", count: 0 }, "count: must be a whole number between 1 and 20 (got 0)"],
        ["find_decision_makers", { company: "Acme", product: "CRM", count: 21 }, "count: must be a whole number between 1 and 20 (got 21)"],
        [
            "find_decision_makers",
            { company: "Acme", product: "CRM", titles: Array.from({ length: 9 }, () => "CRO") },
            "titles: must have at most 8 items (got 9)",
        ],
        ["find_decision_makers", { company: "Acme", product: "CRM", titles: ["x".repeat(51)] }, "must be at most 50 characters (got 51)"],
    ])("rejects out-of-range %s input before starting billable work (%j)", async (tool, input, message) => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        const result = JSON.parse(sseData(await callTool(tool, input))).result as { isError?: boolean; content: Array<{ text: string }> };
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain(message);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("advertises ranges in descriptions, not as JSON-schema bounds a client could clamp to", async () => {
        const response = await handlePloidMcpRequest(
            new Request("https://api.ploid.com/mcp", {
                method: "POST",
                headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
                body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
            }),
            { apiKey: "test", baseUrl: "https://api.ploid.com" },
        );
        const tools = JSON.parse(sseData(await response.text())).result.tools as Array<{
            name: string;
            description: string;
            inputSchema: { properties: Record<string, Record<string, unknown>>; anyOf?: unknown };
        }>;
        const schema = Object.fromEntries(tools.map((tool) => [tool.name, tool.inputSchema]));
        for (const [tool, properties] of Object.entries(schema)) {
            for (const [field, property] of Object.entries(properties.properties)) {
                for (const bound of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "maxLength", "maxItems"]) {
                    expect(property, `${tool}.${field}.${bound}`).not.toHaveProperty(bound);
                }
                if (property.type === "array") expect(property.items).not.toHaveProperty("maxLength");
            }
        }
        expect(schema.search_people?.properties.limit?.description).toContain("from 1 to 10");
        expect(schema.find_people?.properties.count?.description).toContain("from 1 to 25");
        expect(schema.find_decision_makers?.properties.count?.description).toContain("from 1 to 20");
        expect(schema.search_people?.properties.name?.description).toContain("200 characters");
        expect(schema.research_person?.anyOf).toEqual([{ required: ["person_id"] }, { required: ["linkedin_url"] }]);
        expect(tools.find((tool) => tool.name === "research_person")?.description).toContain("exactly one of person_id");
    });

    it("accepts modern discovery and tool listing without a failed negotiation probe", async () => {
        for (const method of ["server/discover", "tools/list"]) {
            const response = await handlePloidMcpRequest(
                new Request("https://api.ploid.com/mcp", {
                    method: "POST",
                    headers: {
                        Accept: "application/json, text/event-stream",
                        "Content-Type": "application/json",
                        "MCP-Protocol-Version": "2026-07-28",
                        "Mcp-Method": method,
                    },
                    body: JSON.stringify({
                        jsonrpc: "2.0",
                        id: 1,
                        method,
                        params: {
                            _meta: {
                                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                                "io.modelcontextprotocol/clientInfo": { name: "claude-code", version: "test" },
                                "io.modelcontextprotocol/clientCapabilities": {},
                            },
                        },
                    }),
                }),
                { apiKey: "test", baseUrl: "https://api.invalid" },
            );
            expect(response.status).toBe(200);
            const body = await response.text();
            expect(body).toContain(method === "server/discover" ? "2026-07-28" : "research_person");
            expect(body).not.toContain('"error"');
        }
    });

    it("initializes and advertises the focused tool surface", async () => {
        const initialize = await handlePloidMcpRequest(
            new Request("https://api.ploid.com/mcp", {
                method: "POST",
                headers: {
                    Accept: "application/json, text/event-stream",
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    method: "initialize",
                    params: {
                        protocolVersion: "2025-06-18",
                        capabilities: {},
                        clientInfo: { name: "test", version: "1.0.0" },
                    },
                }),
            }),
            { apiKey: "test", baseUrl: "https://api.ploid.com" },
        );

        expect(initialize.status).toBe(200);
        const initialized = await initialize.text();
        expect(initialized).toContain("ploid-people-intelligence");
        expect(initialized).toContain(`"version":"${packageVersion}"`);

        const tools = await handlePloidMcpRequest(
            new Request("https://api.ploid.com/mcp", {
                method: "POST",
                headers: {
                    Accept: "application/json, text/event-stream",
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
            }),
            { apiKey: "test", baseUrl: "https://api.ploid.com" },
        );
        const body = await tools.text();
        expect(tools.status).toBe(200);
        for (const tool of ["search_people", "research_person", "find_people", "find_decision_makers", "get_research_status", "cancel_research"]) {
            expect(body).toContain(`"${tool}"`);
        }
        const event = body
            .split("\n")
            .find((line) => line.startsWith("data:"))
            ?.slice(5)
            .trim();
        const advertised = JSON.parse(event ?? body).result.tools as Array<{ name: string; description: string; annotations: Record<string, boolean> }>;
        const search = advertised.find((tool) => tool.name === "search_people");
        expect(search?.annotations).toEqual(BILLABLE_TOOL_ANNOTATIONS);
        expect(search?.description).toContain("1 ACU per completed search, including no matches");
        expect(search?.description).not.toContain("free");
        expect(advertised.find((tool) => tool.name === "get_research_status")?.annotations.readOnlyHint).toBe(true);
        for (const removed of ["personalize_message", "research_company", "run_agent", '"depth"']) {
            expect(body).not.toContain(removed);
        }

        const stream = await handlePloidMcpRequest(
            new Request("https://api.ploid.com/mcp", {
                headers: { Accept: "text/event-stream", "MCP-Protocol-Version": "2025-11-25" },
            }),
            { apiKey: "test", baseUrl: "https://api.invalid" },
        );
        expect(stream.status).toBe(200);
        await stream.body?.cancel();
    });

    it.each([undefined, "2026-07-28"])(
        "returns a durable run handle without waiting for completion (%s)",
        async (version) => {
            const fetchMock = vi
                .fn()
                .mockResolvedValueOnce(apiResponse({ data: { run_id: "run_1", status: "queued", poll_url: "/v1/person/runs/run_1" }, meta: {} }, 202))
                .mockResolvedValueOnce(apiResponse({ data: person, meta: { found: true } }));
            vi.stubGlobal("fetch", fetchMock);

            const response = await handlePloidMcpRequest(
                new Request("https://api.ploid.com/mcp", {
                    method: "POST",
                    headers: {
                        Accept: "application/json, text/event-stream",
                        "Content-Type": "application/json",
                        ...(version ? { "MCP-Protocol-Version": version, "Mcp-Method": "tools/call", "Mcp-Name": "research_person" } : {}),
                    },
                    body: JSON.stringify({
                        jsonrpc: "2.0",
                        id: 42,
                        method: "tools/call",
                        params: {
                            name: "research_person",
                            arguments: { linkedin_url: "https://www.linkedin.com/in/ada" },
                            ...(version
                                ? {
                                      _meta: {
                                          "io.modelcontextprotocol/protocolVersion": version,
                                          "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
                                          "io.modelcontextprotocol/clientCapabilities": {},
                                      },
                                  }
                                : {}),
                        },
                    }),
                }),
                { apiKey: "test", baseUrl: "https://api.ploid.com" },
            );

            expect(response.status).toBe(200);
            const body = await response.text();
            expect(body).toContain("person-run_1");
            expect(body).toContain("get_research_status");
            expect(body).not.toContain("first published algorithm");
            expect(fetchMock).toHaveBeenCalledTimes(1);
            const firstHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
            expect(firstHeaders["Idempotency-Key"]).toMatch(/^mcp:[a-f0-9]{32}$/);
            expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
        },
        5_000,
    );

    it("does not collide when another MCP client reuses the same JSON-RPC id", () => {
        const body = { identifier: { linkedin_url: "https://www.linkedin.com/in/ada" } };
        const first = mcpIdempotencyKey(7, "research_person", body);
        expect(first).toBe(mcpIdempotencyKey(7, "research_person", body));
        expect(first).not.toBe(mcpIdempotencyKey(7, "research_person", { identifier: { linkedin_url: "https://www.linkedin.com/in/grace" } }));
        expect(first).not.toBe(mcpIdempotencyKey(7, "find_people", body));
        expect(first).toMatch(/^mcp:[a-f0-9]{32}$/);
        expect(mcpIdempotencyKey(7, "research_person", body, "connection-1")).not.toBe(mcpIdempotencyKey(7, "research_person", body, "connection-2"));
    });
});

describe("contact tools", () => {
    const found = (field: string, value: string) => ({
        data: { ...person, contact: { [field]: { value, status: "found", confidence: "verified", source: "contact_network", last_seen: null } } },
        meta: { found: true, usage: { acu_used: 1, billed: [field], free: ["reread_90d"], not_found: [] } },
    });
    const missing = (field: string) => ({
        data: { ...person, contact: { [field]: { value: null, status: "not_found", confidence: null, source: null, last_seen: null } } },
        meta: { found: true, usage: { acu_used: 0, billed: [], free: ["reread_90d"], not_found: [field] } },
    });

    it("get_email returns the work email and never asks for the personal one", async () => {
        const fetchMock = vi.fn().mockResolvedValue(apiResponse(found("work_email", "ada@analytical.example")));
        vi.stubGlobal("fetch", fetchMock);
        const body = await callTool("get_email", { person_id: "person_ada" });
        expect(body).toContain("ada@analytical.example");
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
            identifier: { person_id: "person_ada" },
            include: ["work_email"],
            type: "standard",
        });
    });

    it("get_email falls back to the personal email only after a work-email miss", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(apiResponse(missing("work_email")))
            .mockResolvedValueOnce(apiResponse(found("personal_email", "ada@gmail.example")));
        vi.stubGlobal("fetch", fetchMock);
        const body = await callTool("get_email", { linkedin_url: "https://www.linkedin.com/in/ada" });
        expect(body).toContain("No work email is available");
        expect(body).toContain("ada@gmail.example");
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
            identifier: { linkedin_url: "https://www.linkedin.com/in/ada" },
            include: ["personal_email"],
            type: "standard",
        });
    });

    it("get_email reports both misses as free", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(apiResponse(missing("work_email")))
            .mockResolvedValueOnce(apiResponse(missing("personal_email")));
        vi.stubGlobal("fetch", fetchMock);
        const body = await callTool("get_email", { person_id: "person_ada" });
        expect(body).toContain("No personal email is available");
        expect(body).toContain('"found":false');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("get_email hands back the research run for an unresearched person", async () => {
        const fetchMock = vi.fn().mockResolvedValue(apiResponse({ data: { run_id: "run_7", status: "queued", poll_url: "/v1/person/runs/run_7" } }, 202));
        vi.stubGlobal("fetch", fetchMock);
        const body = await callTool("get_email", { person_id: "person_ada" });
        expect(body).toContain("person-run_7");
        expect(body).toContain("contact.work_email");
        expect(body).toContain("10 ACU");
        expect(body).not.toContain("25 ACU");
        expect(body).toContain("do not call get_email again");
        expect(fetchMock).toHaveBeenCalledOnce();
    });

    it("get_email carries the work-email step's usage into the personal fallback", async () => {
        const unlocked = {
            ...missing("work_email"),
            meta: { found: true, usage: { acu_used: 10, billed: ["person_standard"], free: [], not_found: ["work_email"] } },
        };
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(apiResponse(unlocked))
            .mockResolvedValueOnce(apiResponse(found("personal_email", "ada@gmail.example")));
        vi.stubGlobal("fetch", fetchMock);
        const body = await callTool("get_email", { person_id: "person_ada" });
        expect(body).toContain("ada@gmail.example");
        expect(body).toContain("person_standard");
        expect(body).toContain("prior_usage");
    });

    it("get_research_status shows the contact a research run was started with", async () => {
        const fetchMock = vi.fn().mockResolvedValue(apiResponse(found("phone", "+1 555 0100")));
        vi.stubGlobal("fetch", fetchMock);
        const body = await callTool("get_research_status", { run_id: "person-run_7" });
        expect(body).toContain("+1 555 0100");
        expect(body).toContain("already billed");
    });

    it("get_phone asks for the phone only and rejects a missing identifier without a request", async () => {
        const fetchMock = vi.fn().mockResolvedValue(apiResponse(found("phone", "+1 555 0100")));
        vi.stubGlobal("fetch", fetchMock);
        expect(await callTool("get_phone", { person_id: "person_ada" })).toContain("+1 555 0100");
        expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
            identifier: { person_id: "person_ada" },
            include: ["phone"],
            type: "standard",
        });
        fetchMock.mockClear();
        expect(await callTool("get_phone", {})).toContain('"isError":true');
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

async function callTool(name: string, args: Record<string, unknown>) {
    const response = await handlePloidMcpRequest(
        new Request("https://api.ploid.com/mcp", {
            method: "POST",
            headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name, arguments: args } }),
        }),
        { apiKey: "test", baseUrl: "https://api.ploid.com" },
    );
    return response.text();
}

function apiResponse(data: unknown, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function sseData(body: string): string {
    return (
        body
            .split("\n")
            .find((line) => line.startsWith("data:"))
            ?.slice(5)
            .trim() ?? body
    );
}

describe("resumable research", () => {
    it("retrieves a completed person run on a fresh MCP server without starting another job", async () => {
        const fetchMock = vi.fn().mockResolvedValue(apiResponse({ data: person, meta: { found: true, stale: false, usage: { acu_used: 25 } } }));
        vi.stubGlobal("fetch", fetchMock);
        const body = await callTool("get_research_status", { run_id: "person-run_1" });
        expect(body).toContain("first published algorithm");
        expect(body).toContain('"status":"completed"');
        expect(body).toContain('"run_id":"person-run_1"');
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(fetchMock).toHaveBeenCalledWith("https://api.ploid.com/v1/person/runs/run_1", expect.objectContaining({ method: "GET", redirect: "error" }));
    });

    it("does not follow an upstream poll URL or poll again when still running", async () => {
        const fetchMock = vi.fn().mockResolvedValue(apiResponse({ data: { run_id: "run_1", status: "running", poll_url: "https://attacker.invalid/steal" } }));
        vi.stubGlobal("fetch", fetchMock);
        const body = await callTool("get_research_status", { run_id: "person-run_1" });
        expect(body).toContain('"status":"running"');
        expect(body).not.toContain("completed");
        expect(body).not.toContain("attacker.invalid");
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.ploid.com/v1/person/runs/run_1");
    });

    it("rejects URLs, path traversal and unprefixed legacy run IDs before sending credentials", async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        for (const run_id of ["https://attacker.invalid", "../account", "..", "x?token=y", "person-../x", "run_1", "person-", "set-"]) {
            expect(await callTool("get_research_status", { run_id })).toContain('"isError":true');
            expect(await callTool("cancel_research", { run_id })).toContain('"isError":true');
        }
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("only sends DELETE for an explicit person cancel request", async () => {
        const fetchMock = vi.fn().mockResolvedValue(apiResponse({ data: { run_id: "run_1", status: "cancelled" }, meta: { usage: { acu_used: 0 } } }));
        vi.stubGlobal("fetch", fetchMock);
        const body = await callTool("cancel_research", { run_id: "person-run_1" });
        expect(body).toContain('"status":"cancelled"');
        expect(body).toContain('"acu_used":0');
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(fetchMock).toHaveBeenCalledWith("https://api.ploid.com/v1/person/runs/run_1", expect.objectContaining({ method: "DELETE" }));
    });

    it("reports a cancelled person run as cancelled rather than failed", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(apiResponse({ error: { code: "run_cancelled", message: "The person run was cancelled.", usage: { acu_used: 0 } } }, 409)),
        );
        const body = await callTool("get_research_status", { run_id: "person-run_1" });
        expect(body).toContain('"status":"cancelled"');
        expect(body).not.toContain('"isError":true');
        expect(body).toContain('"acu_used":0');
        expect(body).toContain("Stop polling");
    });

    it("reports a pending Set with its progress", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValue(
                apiResponse({ data: { id: "set_1", status: "running", admitted_count: 3, searches: [{ id: "s1", status: "running", count: 10 }] } }),
            );
        vi.stubGlobal("fetch", fetchMock);
        const body = await callTool("get_research_status", { run_id: "set-set_1" });
        expect(body).toContain('"status":"running"');
        expect(body).toContain('"set_admitted_so_far":3');
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(fetchMock).toHaveBeenCalledWith("https://api.ploid.com/v1/sets/set_1", expect.objectContaining({ method: "GET", redirect: "error" }));
    });

    it("tells a running Set's caller how many people are already in the list", async () => {
        vi.stubGlobal(
            "fetch",
            vi
                .fn()
                .mockResolvedValue(
                    apiResponse({ data: { id: "set_1", status: "running", admitted_count: 3, searches: [{ id: "s1", status: "running", count: 10 }] } }),
                ),
        );
        const body = await callTool("get_research_status", { run_id: "set-set_1" });
        expect(body).toContain("3 people are in the Ploid list so far; this search is looking for 10.");
        expect(body).toContain('"requested_count":10');
    });

    it.each([
        [{ position: 1, estimated_wait_seconds: 0 }, "It is next in the queue and should start within a minute.", 5],
        [{ position: 7, estimated_wait_seconds: 130 }, "It is number 7 in the queue and should start in about 2 minutes.", 33],
        [{ position: 40, estimated_wait_seconds: 1_500 }, "It is number 40 in the queue and should start in about 25 minutes.", 60],
    ])("reports a queued Set's place in the queue and a rough wait (%o)", async (queue, sentence, retryAfter) => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(apiResponse({ data: { id: "set_1", status: "running", searches: [{ id: "s1", status: "created", count: 2, queue }] } })),
        );
        const body = await callTool("get_research_status", { run_id: "set-set_1" });
        expect(body).toContain('"status":"queued"');
        expect(body).toContain(sentence);
        expect(body).toContain(`"queue_position":${queue.position}`);
        expect(body).toContain(`"estimated_wait_seconds":${queue.estimated_wait_seconds}`);
        expect(body).toContain(`"retry_after_seconds":${retryAfter}`);
    });

    it("still reports a queued Set from an API that sends no queue place", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(apiResponse({ data: { id: "set_1", searches: [{ id: "s1", status: "created", count: 2 }] } })));
        const body = await callTool("get_research_status", { run_id: "set-set_1" });
        expect(body).toContain('"status":"queued"');
        expect(body).toContain('"retry_after_seconds":5');
        expect(body).not.toContain("queue_position");
    });

    it("reports the Set's original search even after later searches were added", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(
                apiResponse({
                    data: {
                        id: "set_1",
                        searches: [
                            { id: "s2", status: "running", count: 50, query: "a later search" },
                            { id: "s1", status: "completed", count: 5, query: "the MCP search" },
                        ],
                    },
                }),
            )
            .mockResolvedValueOnce(apiResponse({ data: { items: [], next_cursor: null } }));
        vi.stubGlobal("fetch", fetchMock);
        const body = await callTool("get_research_status", { run_id: "set-set_1" });
        expect(body).toContain("the MCP search");
        expect(fetchMock.mock.calls[1]?.[0]).toBe("https://api.ploid.com/v1/sets/set_1/items?status=admitted&limit=5&search_id=s1");
    });

    it("says when a Set search was cancelled or stopped at its budget", async () => {
        for (const [search, expected] of [
            [{ id: "s1", status: "canceled", count: 5 }, "was cancelled"],
            [{ id: "s1", status: "completed", count: 5, stop_reason: "budget" }, "stopped at its budget limit"],
        ] as const) {
            vi.stubGlobal(
                "fetch",
                vi
                    .fn()
                    .mockResolvedValueOnce(apiResponse({ data: { id: "set_1", searches: [search] } }))
                    .mockResolvedValueOnce(apiResponse({ data: { items: [], next_cursor: null } })),
            );
            expect(await callTool("get_research_status", { run_id: "set-set_1" })).toContain(expected);
        }
    });

    it("does not report an unknown Set status as completed", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(apiResponse({ data: { id: "set_1", searches: [{ id: "s1", status: "paused" }] } })));
        const body = await callTool("get_research_status", { run_id: "set-set_1" });
        expect(body).toContain('"isError":true');
        expect(body).not.toContain('"status":"completed"');
    });

    it("treats cancelling a finished person run like a finished Set", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValueOnce(apiResponse({ error: { code: "run_not_active", message: "The person run is no longer active." } }, 409)),
        );
        const body = await callTool("cancel_research", { run_id: "person-run_1" });
        expect(body).toContain('"status":"not_active"');
        expect(body).not.toContain('"isError":true');
    });

    it("tells the model to keep polling after a transient server error", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(apiResponse({ error: { code: "unavailable", message: "Service unavailable." } }, 503)));
        const body = await callTool("get_research_status", { run_id: "person-run_1" });
        expect(body).toContain("The run continues; check its status again shortly.");
    });

    it("keeps polling after a 503 that names no error code", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(apiResponse({ error: { message: "Service unavailable." } }, 503)));
        const body = await callTool("get_research_status", { run_id: "person-run_1" });
        expect(body).toContain("Run person-run_1: Service unavailable. The run continues; check its status again shortly.");
        expect(body).not.toContain("stop polling");
    });

    it("stops polling a failed person run even though the API answers 503", async () => {
        vi.stubGlobal(
            "fetch",
            vi
                .fn()
                .mockResolvedValueOnce(apiResponse({ error: { code: "person_unavailable", message: "The person profile is temporarily unavailable." } }, 503)),
        );
        const body = await callTool("get_research_status", { run_id: "person-run_1" });
        expect(body).toContain('"isError":true');
        expect(body).toContain("Run person-run_1: The person profile is temporarily unavailable. This run has ended; stop polling it.");
        expect(body).not.toContain("check its status again");
    });

    it("stops polling a people search whose Set was deleted", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(apiResponse({ error: { code: "not_found", message: "Set not found." } }, 404)));
        const body = await callTool("get_research_status", { run_id: "set-set_1" });
        expect(body).toContain('"isError":true');
        expect(body).toContain("Run set-set_1: This people search no longer exists. This run has ended; stop polling it.");
        vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(apiResponse({ error: { code: "not_found", message: "Set not found." } }, 404)));
        expect(await callTool("cancel_research", { run_id: "set-set_1" })).toContain("This people search no longer exists. This run has ended");
    });

    it("stops polling a person result that must be requested again", async () => {
        const message = "This older result predates source review. Submit the person request again to refresh it under the existing access receipt.";
        vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(apiResponse({ error: { code: "person_review_required", message } }, 503)));
        const body = await callTool("get_research_status", { run_id: "person-run_1" });
        expect(body).toContain(`${message} This run has ended; stop polling it.`);
        expect(body).not.toContain("check its status again");
    });

    it("does not report a failed research start as a run that continues or has ended", async () => {
        vi.stubGlobal(
            "fetch",
            vi
                .fn()
                .mockResolvedValueOnce(apiResponse({ error: { code: "person_unavailable", message: "The person profile is temporarily unavailable." } }, 503)),
        );
        const body = await callTool("research_person", { linkedin_url: "https://www.linkedin.com/in/ada" });
        expect(body).toContain('"isError":true');
        expect(body).toContain("The person profile is temporarily unavailable.");
        expect(body).not.toContain("run continues");
        expect(body).not.toContain("stop polling");
    });

    it("keeps polling after a gateway error with an HTML body", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValueOnce(new Response("<html><body>502 Bad Gateway</body></html>", { status: 502, headers: { "content-type": "text/html" } })),
        );
        const body = await callTool("get_research_status", { run_id: "person-run_1" });
        expect(body).toContain("Ploid request failed (502).");
        expect(body).toContain("The run continues; check its status again shortly.");
    });

    it("keeps polling after a network failure", async () => {
        vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")));
        const body = await callTool("get_research_status", { run_id: "person-run_1" });
        expect(body).toContain("Could not reach Ploid (fetch failed).");
        expect(body).toContain("The run continues; check its status again shortly.");
    });

    it("does not treat an invalid success body as transient", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("<html></html>", { status: 200 })));
        const body = await callTool("get_research_status", { run_id: "person-run_1" });
        expect(body).toContain("Ploid returned an invalid response (200).");
        expect(body).not.toContain("check its status again");
    });

    it("reports final run errors once, without transport advice", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(apiResponse({ error: { code: "run_expired", message: "This Person run has expired." } }, 410)));
        const body = await callTool("get_research_status", { run_id: "person-run_1" });
        expect(body).toContain("Run person-run_1: This Person run has expired. This run has ended; stop polling it.");
        expect(body).not.toContain("..");
        expect(body).not.toContain("check its status again");
    });

    it("returns a completed Set's verified people", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(
                apiResponse({
                    data: {
                        id: "set_1",
                        status: "idle",
                        admitted_count: 1,
                        pricing: { credits_used: 1 },
                        searches: [{ id: "s1", status: "completed", count: 10, query: "AI founders in Berlin", criteria: ["Founder of an AI company"] }],
                    },
                }),
            )
            .mockResolvedValueOnce(
                apiResponse({
                    data: {
                        items: [
                            {
                                id: "item_1",
                                status: "admitted",
                                name: "Grace Hopper",
                                title: "Founder",
                                company: "Compilers AI",
                                location: "Berlin",
                                linkedin_url: "https://www.linkedin.com/in/grace",
                                properties: { raw: "not forwarded" },
                                verification: { passed: true },
                            },
                        ],
                        next_cursor: null,
                    },
                }),
            );
        vi.stubGlobal("fetch", fetchMock);
        const body = await callTool("get_research_status", { run_id: "set-set_1" });
        expect(body).toContain('"status":"completed"');
        expect(body).toContain("Grace Hopper — Founder at Compilers AI (Berlin)");
        expect(body).toContain('"credits_used":1');
        expect(body).not.toContain("not forwarded");
        expect(fetchMock.mock.calls[1]?.[0]).toBe("https://api.ploid.com/v1/sets/set_1/items?status=admitted&limit=10&search_id=s1");
    });

    it("treats a failed Set search as a tool error", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(apiResponse({ data: { id: "set_1", status: "idle", searches: [{ id: "s1", status: "failed", count: 10 }] } })),
        );
        const body = await callTool("get_research_status", { run_id: "set-set_1" });
        expect(body).toContain('"isError":true');
        expect(body).toContain("set-set_1");
        expect(body).toContain("This run has ended; stop polling it.");
        expect(body).not.toContain("check its status again");
    });

    it("requests Set cancellation without claiming it already stopped", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(apiResponse({ data: { id: "set_1", searches: [{ id: "s1", status: "running" }] } }))
            .mockResolvedValueOnce(apiResponse({ data: { id: "set_1", canceling: true, searches: ["s1"] } }));
        vi.stubGlobal("fetch", fetchMock);
        const body = await callTool("cancel_research", { run_id: "set-set_1" });
        expect(body).toContain('"status":"cancel_requested"');
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock).toHaveBeenLastCalledWith("https://api.ploid.com/v1/sets/set_1/cancel", expect.objectContaining({ method: "POST" }));
    });

    it("does not cancel other searches in the Set once its own search has finished", async () => {
        const fetchMock = vi.fn().mockResolvedValueOnce(
            apiResponse({
                data: {
                    id: "set_1",
                    searches: [
                        { id: "s2", status: "running" },
                        { id: "s1", status: "completed" },
                    ],
                },
            }),
        );
        vi.stubGlobal("fetch", fetchMock);
        const body = await callTool("cancel_research", { run_id: "set-set_1" });
        expect(body).toContain('"status":"not_active"');
        expect(fetchMock).toHaveBeenCalledOnce();
    });

    it("preserves the run ID on transient failure and never cancels automatically", async () => {
        const fetchMock = vi.fn().mockRejectedValue(new DOMException("Request timed out", "TimeoutError"));
        vi.stubGlobal("fetch", fetchMock);
        const body = await callTool("get_research_status", { run_id: "person-run_1" });
        expect(body).toContain("person-run_1");
        expect(body).toContain('"isError":true');
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("GET");
    });

    it("explains how to re-authorize when a legacy credential lacks the new scopes", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(apiResponse({ error: { code: "insufficient_scope", message: "API key is missing the people:enrich scope." } }, 403)),
        );
        const body = await callTool("research_person", { linkedin_url: "https://www.linkedin.com/in/ada" });
        expect(body).toContain("missing the people:enrich scope");
        expect(body).toContain("ploid-mcp login");
        expect(body).toContain('"isError":true');
    });

    it("does not mistake an empty or incomplete envelope for completion", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(apiResponse({ data: {} })));
        expect(await callTool("get_research_status", { run_id: "person-run_1" })).toContain('"isError":true');
        expect(await callTool("get_research_status", { run_id: "set-set_1" })).toContain('"isError":true');
    });
});
