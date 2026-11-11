import { afterEach, describe, expect, it, vi } from "vitest";
import { handlePloidMcpRequest } from "../src/server.js";

afterEach(() => vi.unstubAllGlobals());

const usage = { acu_used: 0, billed: [], free: [], not_found: [] };
const searchUsage = { ...usage, acu_used: 1, billed: ["candidate_preview"] };
const candidate = {
    person_id: "person_ada",
    name: "Ada Lovelace",
    title: "Mathematician",
    company: null,
    location: "London",
    linkedin_url: null,
    profile_url: "https://example.org/ada",
    identity_verified: false,
};

function apiResponse(payload: unknown, status = 200) {
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

async function callTool(name: string, args: Record<string, unknown>) {
    const response = await handlePloidMcpRequest(
        new Request("https://ploid.invalid/mcp", {
            method: "POST",
            headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 42, method: "tools/call", params: { name, arguments: args } }),
        }),
        { apiKey: "test", baseUrl: "http://localhost:3001" },
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    const json =
        text
            .split("\n")
            .find((line) => line.startsWith("data:"))
            ?.slice(5)
            .trim() ?? text;
    return JSON.parse(json).result;
}

describe("paid candidate search", () => {
    it.each([0, 1, 2])("returns %i indexed candidates with honest selection guidance and no research submission", async (count) => {
        const matches = Array.from({ length: count }, (_, index) => ({ ...candidate, person_id: `person_${index}` }));
        const fetchMock = vi.fn().mockResolvedValue(
            apiResponse({
                data: { source: "ploid_people_index", matches, returned: count, limit: 5, usage: { acu_used: 1 } },
                meta: { usage: searchUsage },
            }),
        );
        vi.stubGlobal("fetch", fetchMock);
        const result = await callTool("search_people", { name: " Ada Lovelace ", company: " Engines " });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ matches, returned: count, usage: searchUsage });
        expect(result.structuredContent.guidance).toContain(count ? "ask the user to choose" : "does not establish that the person does not exist");
        if (count) expect(result.structuredContent.guidance).toContain("25 ACU");
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Idempotency-Key")).toMatch(/^mcp:[a-f0-9]{32}$/);
        expect(fetchMock).toHaveBeenCalledWith(
            "http://localhost:3001/v1/search/candidates",
            expect.objectContaining({
                method: "POST",
                body: JSON.stringify({ name: "Ada Lovelace", company: "Engines", limit: 5 }),
                redirect: "error",
            }),
        );
    });

    it.each([
        [{ name: "x" }, "name"],
        [{ name: "" }, "name"],
        [{ name: "Ada", limit: 0 }, "limit: must be a whole number between 1 and 10 (got 0)"],
        [{ name: "Ada", limit: -1 }, "limit: must be a whole number between 1 and 10 (got -1)"],
        [{ name: "Ada", limit: 11 }, "limit: must be a whole number between 1 and 10 (got 11)"],
        [{ name: "Ada", limit: 1.5 }, "limit: must be a whole number between 1 and 10 (got 1.5)"],
        [{ name: "A".repeat(201) }, "name: must be at most 200 characters (got 201)"],
        [{ name: "Ada", company: "B".repeat(201) }, "company: must be at most 200 characters (got 201)"],
        [{ name: "Ada", goal: "Research" }, "goal"],
    ])("rejects invalid lookup arguments without an API call (%j)", async (input, message) => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        const result = await callTool("search_people", input);
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain(message);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("returns only basic candidate fields and rejects inconsistent counts", async () => {
        const data = { source: "ploid_people_index", matches: [{ ...candidate, email: "private@example.org", raw: "unrequested" }], returned: 1, limit: 5 };
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(apiResponse({ data, meta: { usage: searchUsage } })));
        const result = await callTool("search_people", { name: "Ada Lovelace" });
        expect(result.structuredContent.matches).toEqual([candidate]);
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(apiResponse({ data: { ...data, returned: 2 } })));
        expect((await callTool("search_people", { name: "Ada Lovelace" })).isError).toBe(true);
    });

    it.each([200, 503])("keeps API errors distinct from no matches even with HTTP %i", async (status) => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(apiResponse({ error: { code: "index_unavailable", message: "Try again later" } }, status)));
        const result = await callTool("search_people", { name: "Ada" });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({ error: { code: "index_unavailable" }, http_status: status });
        expect(result.structuredContent).not.toHaveProperty("matches");
    });

    it("preserves insufficient ACU errors without reporting a completed search or invented usage", async () => {
        const error = { code: "insufficient_acu", message: "At least 1 ACU is required for candidate search." };
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(apiResponse({ error }, 402)));
        const result = await callTool("search_people", { name: "Ada Lovelace" });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({ error, http_status: 402 });
        expect(result.structuredContent).not.toHaveProperty("matches");
        expect(result.structuredContent).not.toHaveProperty("usage");
    });
});

describe("deep person research", () => {
    it.each([
        {},
        { name: "Ada Lovelace" },
        { person_id: "person_ada", depth: "deep" },
        { website_url: "https://example.org/ada" },
        { person_id: "person_ada", linkedin_url: "https://linkedin.com/in/ada" },
    ])("rejects missing, conflicting or legacy identifiers with migration guidance (%j)", async (identifier) => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        const result = await callTool("research_person", identifier);
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).toContain("search_people");
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each(["Ada Lovelace", "https://example.org/ada"])("rejects an arbitrary value passed as a public person ID (%s)", async (person_id) => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        expect((await callTool("research_person", { person_id })).isError).toBe(true);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
        "not a URL",
        "https://linkedin.com/company/ploid",
        "https://linkedin.com.evil.invalid/in/ada",
        "https://evil.invalid/in/ada",
        "https://user:password@linkedin.com/in/ada",
        "http://linkedin.com/in/ada",
        "https://linkedin.com/in/ada/posts",
    ])("rejects a non-profile LinkedIn URL (%s)", async (linkedin_url) => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        expect((await callTool("research_person", { linkedin_url })).isError).toBe(true);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each(["get_research_status", "cancel_research"])("keeps failed person runs terminal during %s", async (tool) => {
        const error = { code: "person_unavailable", message: "The research run failed.", status: "failed", run_id: "run_1", usage };
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(apiResponse({ error }, 503)));
        const result = await callTool(tool, { run_id: "person-run_1" });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({ error, status: "failed", run_id: "person-run_1", http_status: 503 });
        expect(result.content[0].text).toContain("stop polling");
        expect(result.content[0].text).not.toContain("did not automatically cancel");
    });

    it("retains a billing reconciliation error without manufacturing zero usage", async () => {
        const error = {
            code: "person_billing_reconciliation_required",
            message: "Stop polling and contact support",
            billing_status: "reconciliation_required",
            run_id: "run_1",
        };
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(apiResponse({ error }, 409)));
        const result = await callTool("get_research_status", { run_id: "person-run_1" });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({ error, http_status: 409, run_id: "person-run_1" });
        expect(JSON.stringify(result)).not.toContain("acu_used");
        expect(result.content[0].text).toContain("Stop polling");
    });

    it("gives existing grants actionable reconnection instructions without falling back to Agent", async () => {
        const fetchMock = vi.fn().mockResolvedValue(apiResponse({ error: { code: "insufficient_scope", message: "Requires people:enrich" } }, 403));
        vi.stubGlobal("fetch", fetchMock);
        const result = await callTool("research_person", { person_id: "person_ada" });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("Reconnect Ploid");
        expect(result.structuredContent.error.code).toBe("insufficient_scope");
        expect(fetchMock).toHaveBeenCalledOnce();
    });
});
