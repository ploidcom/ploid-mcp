#!/usr/bin/env node
// Live stdio test. Requires an explicit API target; completed search costs 1 ACU, research may cost 25 ACU.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const [mode, input, outputPath] = process.argv.slice(2);
if (!process.env.PLOID_API_BASE_URL || !["search", "start", "resume"].includes(mode) || !input || !outputPath) {
    console.error(
        "Set PLOID_API_BASE_URL. Usage: node scripts/research-smoke.mjs search <input.json> <output.json> OR start <identifier.json> <output.json> OR resume <run_id> <output.json>",
    );
    process.exit(1);
}
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
let nextId = Date.now();
function connect() {
    const child = spawn(process.execPath, [cli], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    const pending = new Map();
    const lines = createInterface({ input: child.stdout });
    // Do not echo arbitrary server stderr, which can contain credentialed SDK errors.
    child.stderr.resume();
    lines.on("line", (line) => {
        try {
            const message = JSON.parse(line);
            const entry = pending.get(message.id);
            if (entry) {
                clearTimeout(entry.timer);
                pending.delete(message.id);
                entry.resolve(message);
            }
        } catch {
            /* Ignore non-protocol log lines. */
        }
    });
    function fail(error) {
        for (const entry of pending.values()) {
            clearTimeout(entry.timer);
            entry.reject(error);
        }
        pending.clear();
    }
    child.on("error", fail);
    child.on("exit", () => fail(new Error("MCP process exited")));
    return {
        async request(method, params) {
            const id = ++nextId;
            const result = new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    pending.delete(id);
                    reject(new Error("MCP request exceeded 30 seconds"));
                }, 30_000);
                pending.set(id, { resolve, reject, timer });
            });
            child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
            return result;
        },
        notify(method) {
            child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
        },
        close() {
            lines.close();
            child.kill();
        },
    };
}
async function initialize(client) {
    await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ploid-research-smoke", version: "1" } });
    client.notify("notifications/initialized");
}
const started = Date.now();
const record = { date: new Date().toISOString(), api_origin: new URL(process.env.PLOID_API_BASE_URL).origin, mode, restarted_mcp: false, responses: [] };
let client = connect();
try {
    await initialize(client);
    let runId = mode === "resume" ? input : undefined;
    let response =
        mode !== "resume"
            ? await client.request("tools/call", {
                  name: mode === "search" ? "search_people" : "research_person",
                  arguments: JSON.parse(await readFile(input, "utf8")),
              })
            : await client.request("tools/call", { name: "get_research_status", arguments: { run_id: runId } });
    while (true) {
        record.responses.push({ elapsed_ms: Date.now() - started, ...response });
        await writeFile(outputPath, JSON.stringify(record, null, 2), { mode: 0o600 });
        if (response.error || response.result?.isError) throw new Error(JSON.stringify(response.error ?? response.result.content));
        const result = response.result?.structuredContent;
        if (mode === "search") {
            console.log(response.result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"));
            break;
        }
        runId ??= result?.run_id;
        console.log(JSON.stringify({ elapsed_ms: Date.now() - started, run_id: runId, status: result?.status }));
        if (result?.status === "completed") {
            console.log(response.result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"));
            break;
        }
        if (!runId || !["queued", "running"].includes(result?.status)) throw new Error("Unexpected research result");
        if (Date.now() - started > 16 * 60_000) throw new Error(`Smoke test stopped waiting; resume run ${runId}. The run was not cancelled.`);
        if (!record.restarted_mcp) {
            // Exercise a real process disconnect while the backend job is running.
            client.close();
            client = connect();
            await initialize(client);
            record.restarted_mcp = true;
            console.log("Reconnected a new MCP process; resuming the same run.");
        }
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        response = await client.request("tools/call", { name: "get_research_status", arguments: { run_id: runId } });
    }
} finally {
    await writeFile(outputPath, JSON.stringify(record, null, 2), { mode: 0o600 });
    client.close();
}
