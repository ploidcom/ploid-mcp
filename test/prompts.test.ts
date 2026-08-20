import { describe, expect, it } from "vitest";
import { decisionMakersPrompt, personalizePrompt, researchPersonPrompt } from "../src/prompts.js";
import { BILLABLE_TOOL_ANNOTATIONS } from "../src/server.js";
import { revokeApiKey } from "../src/logout.js";

describe("Ploid MCP prompt builders", () => {
  it("builds identity research with evidence and inference boundaries", () => {
    const prompt = researchPersonPrompt({ name: "Manny Hernandez", company: "Ploid" });
    expect(prompt).toContain("Manny Hernandez at Ploid");
    expect(prompt).toContain("source URLs");
    expect(prompt).toContain("Separate confirmed facts from inference");
  });

  it("frames decision-maker discovery around the product being sold", () => {
    const prompt = decisionMakersPrompt({ company: "Acme", product: "an AI sales copilot", count: 5 });
    expect(prompt).toContain("decision-makers at Acme");
    expect(prompt).toContain("AI sales copilot");
    expect(prompt).toContain("Do not invent identities");
  });

  it("requires sourced, non-creepy personalization", () => {
    const prompt = personalizePrompt({ person: "Ada Lovelace", offering: "developer tooling", channel: "email", tone: "direct" });
    expect(prompt).toContain("avoid creepy observations");
    expect(prompt).toContain("verified evidence");
  });

  it("does not advertise ACU-spending tools as read-only", () => {
    expect(BILLABLE_TOOL_ANNOTATIONS).toMatchObject({
      readOnlyHint: false,
      openWorldHint: true,
    });
  });

  it("revokes the device API key through the account endpoint", async () => {
    const fetchMock = async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.example.test/v1/account/key");
      expect(init).toMatchObject({
        method: "DELETE",
        headers: {
          Authorization: "Bearer ploid_test_key",
          Accept: "application/json",
        },
      });
      return new Response(null, { status: 200 });
    };

    await expect(revokeApiKey("https://api.example.test", "ploid_test_key", fetchMock)).resolves.toBe(true);
  });
});
