import { describe, expect, it } from "vitest";
import { handlePloidMcpRequest } from "../src/server.js";

describe("Ploid Streamable HTTP MCP", () => {
  it("initializes and advertises the focused tool surface", async () => {
    const initialize = await handlePloidMcpRequest(new Request("https://api.ploid.com/mcp", {
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
    }), { apiKey: "test", baseUrl: "https://api.ploid.com" });

    expect(initialize.status).toBe(200);
    expect(await initialize.text()).toContain("ploid-people-intelligence");

    const tools = await handlePloidMcpRequest(new Request("https://api.ploid.com/mcp", {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    }), { apiKey: "test", baseUrl: "https://api.ploid.com" });
    const body = await tools.text();
    expect(tools.status).toBe(200);
    expect(body).toContain("research_person");
    expect(body).toContain("find_people");
  });
});
