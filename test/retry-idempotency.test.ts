import { InMemoryTransport, type JSONRPCMessage } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPloidMcpServer, handlePloidMcpRequest, type PloidMcpOptions } from "../src/server.js";

const options = { apiKey: "test-key", baseUrl: "https://api.invalid" };
const args = { person_id: "person_ada" };
const originalFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = originalFetch;
});

function response(runId: string) {
    return new Response(JSON.stringify({ data: { run_id: runId, status: "queued" } }), {
        status: 202,
        headers: { "content-type": "application/json" },
    });
}

function searchResponse() {
    return new Response(
        JSON.stringify({
            data: { source: "ploid_people_index", matches: [], returned: 0, limit: 5, usage: { acu_used: 1 } },
            meta: { usage: { acu_used: 1, billed: ["candidate_preview"], free: [], not_found: [] } },
        }),
        { headers: { "content-type": "application/json" } },
    );
}

type CallInput = {
    tool?: "research_person" | "search_people";
    version?: string;
    id?: string | number;
    args?: Record<string, unknown>;
    headers?: Record<string, string>;
    options?: PloidMcpOptions;
};

async function call(input: CallInput = {}) {
    const version = input.version;
    const tool = input.tool ?? "research_person";
    const res = await handlePloidMcpRequest(
        new Request("https://ploid.invalid/mcp", {
            method: "POST",
            headers: {
                Accept: "application/json, text/event-stream",
                "Content-Type": "application/json",
                ...(version ? { "MCP-Protocol-Version": version, "Mcp-Method": "tools/call", "Mcp-Name": tool } : {}),
                ...input.headers,
            },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: input.id ?? 42,
                method: "tools/call",
                params: {
                    name: tool,
                    arguments: input.args ?? args,
                    ...(version
                        ? {
                              _meta: {
                                  "io.modelcontextprotocol/protocolVersion": version,
                                  "io.modelcontextprotocol/clientInfo": { name: "retry-test", version: "1" },
                                  "io.modelcontextprotocol/clientCapabilities": {},
                              },
                          }
                        : {}),
                },
            }),
        }),
        input.options ?? options,
    );
    expect(res.status).toBe(200);
    return res.text();
}

function captureKeys() {
    const keys: string[] = [];
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url, init) => {
            keys.push(new Headers(init.headers).get("Idempotency-Key")!);
            return String(url).endsWith("/v1/search/candidates") ? searchResponse() : response("run_1");
        }),
    );
    return keys;
}

describe("billable tool idempotency", () => {
    it.each([undefined, "2026-07-28"])("recovers a lost HTTP acknowledgement with the same run (%s)", async (version) => {
        const jobs = new Map<string, string>();
        let loseAcknowledgement = true;
        vi.stubGlobal(
            "fetch",
            vi.fn(async (_url, init) => {
                const key = new Headers(init.headers).get("Idempotency-Key")!;
                if (!jobs.has(key)) jobs.set(key, `run_${jobs.size + 1}`);
                if (loseAcknowledgement) {
                    loseAcknowledgement = false;
                    throw new DOMException("Acknowledgement lost", "TimeoutError");
                }
                return response(jobs.get(key)!);
            }),
        );
        expect(await call({ version })).toContain('"isError":true');
        expect(await call({ version })).toContain("run_1");
        expect(jobs.size).toBe(1);
    });

    it.each([undefined, "2026-07-28"])("retries a lost candidate-search response without a second charge (%s)", async (version) => {
        const billedKeys = new Set<string>();
        let loseAcknowledgement = true;
        const fetchMock = vi.fn(async (_url, init) => {
            const key = new Headers(init.headers).get("Idempotency-Key");
            expect(key).toMatch(/^mcp:[a-f0-9]{32}$/);
            billedKeys.add(key!);
            if (loseAcknowledgement) {
                loseAcknowledgement = false;
                throw new DOMException("Acknowledgement lost after billing", "TimeoutError");
            }
            return searchResponse();
        });
        vi.stubGlobal("fetch", fetchMock);
        const input: CallInput = { version, tool: "search_people", args: { name: "Ada Lovelace" } };
        expect(await call(input)).toContain('"isError":true');
        const retried = await call(input);
        expect(retried).not.toContain('"isError":true');
        expect(retried).toContain('"acu_used":1');
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(billedKeys.size).toBe(1);

        expect(await call({ ...input, id: 43 })).not.toContain('"isError":true');
        expect(billedKeys.size).toBe(2);
    });

    it.each<CallInput>([
        { id: 43 },
        { args: { person_id: "person_grace" } },
        { args: { linkedin_url: "https://www.linkedin.com/in/ada" } },
        { options: { ...options, apiKey: "another-user-key" } },
        { headers: { "Mcp-Session-Id": "another-session" } },
        { headers: { "Idempotency-Key": "intentional-new-operation" } },
    ])("distinguishes a new request or caller (%j)", async (change) => {
        const keys = captureKeys();
        await call();
        await call(change);
        expect(keys).toHaveLength(2);
        expect(keys[0]).not.toBe(keys[1]);
    });

    it("keeps a hosted grant stable across reconnects, token refreshes and loopback restarts", async () => {
        const keys = captureKeys();
        const hosted = (grant: string, token: string) => ({
            baseUrl: options.baseUrl,
            idempotencyScope: grant,
            requestHeaders: {
                "x-ploid-loopback-token": token,
                "x-ploid-loopback-api-key-id": grant,
            },
        });
        await call({ options: hosted("grant-a", "process-one"), headers: { Authorization: "Bearer oauth-token-one", "Mcp-Session-Id": "session-a" } });
        await call({ options: hosted("grant-a", "process-two"), headers: { Authorization: "Bearer refreshed-token", "Mcp-Session-Id": "session-a" } });
        await call({ options: hosted("grant-b", "process-two"), headers: { "Mcp-Session-Id": "session-a" } });
        expect(keys).toHaveLength(3);
        expect(keys[1]).toBe(keys[0]);
        expect(keys[2]).not.toBe(keys[0]);
        expect(keys.every((key) => /^mcp:[a-f0-9]{32}$/.test(key))).toBe(true);
    });

    it("binds an explicit retry key to the caller and arguments, independently of RPC IDs", async () => {
        const keys = captureKeys();
        const headers = { "Idempotency-Key": "operation-a" };
        await call({ headers });
        await call({ headers, id: 99 });
        await call({ headers, args: { person_id: "person_grace" } });
        await call({ headers, options: { ...options, apiKey: "other-key" } });
        expect(keys).toHaveLength(4);
        expect(keys[1]).toBe(keys[0]);
        expect(new Set([keys[0], keys[2], keys[3]]).size).toBe(3);
    });

    it("does not accept client headers as the hosted caller identity", async () => {
        const keys = captureKeys();
        const body = await call({
            headers: { Authorization: "Bearer forged", "x-ploid-loopback-api-key-id": "forged" },
            options: {
                baseUrl: options.baseUrl,
                requestHeaders: { "x-ploid-loopback-token": "server-only" },
            },
        });
        expect(body).toContain('"isError":true');
        expect(keys).toEqual([]);
    });

    it.each([
        { tool: "research_person", input: args, resultText: "run_1" },
        { tool: "search_people", input: { name: "Ada Lovelace" }, resultText: "ploid_people_index" },
    ])("preserves $tool retries within a stdio server but separates restarted servers", async ({ tool, input, resultText }) => {
        const keys = captureKeys();
        for (let index = 0; index < 2; index++) {
            const server = createPloidMcpServer(options);
            const [client, transport] = InMemoryTransport.createLinkedPair();
            await server.connect(transport);
            await client.start();
            try {
                for (let attempt = 0; attempt < 2; attempt++) {
                    const result = new Promise<JSONRPCMessage>((resolve) => {
                        client.onmessage = resolve;
                    });
                    await client.send({ jsonrpc: "2.0", id: 42, method: "tools/call", params: { name: tool, arguments: input } });
                    expect(JSON.stringify(await result)).toContain(resultText);
                }
            } finally {
                await server.close();
                await client.close();
            }
        }
        expect(keys).toHaveLength(4);
        expect(keys[1]).toBe(keys[0]);
        expect(keys[3]).toBe(keys[2]);
        expect(keys[2]).not.toBe(keys[0]);
    });
});
