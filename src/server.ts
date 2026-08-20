import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { resolveConfig } from "./config.js";
import {
  decisionMakersPrompt,
  findPeoplePrompt,
  personalizePrompt,
  researchCompanyPrompt,
  researchPersonPrompt,
} from "./prompts.js";

type AgentData = { output?: string; artifacts?: unknown[]; structured_output?: unknown };
type AgentEnvelope = { data?: AgentData; meta?: Record<string, unknown>; error?: { code?: string; message?: string } };

export type PloidMcpOptions = {
  apiKey?: string;
  baseUrl?: string;
  /** Server-only headers for a trusted upstream hop. Never populate this from MCP client input. */
  requestHeaders?: Record<string, string>;
};

export const BILLABLE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: true,
} as const;

async function runAgent(options: PloidMcpOptions, prompt: string, maxAcu = 0.8): Promise<AgentEnvelope> {
  const local = options.baseUrl && (options.apiKey || options.requestHeaders) ? undefined : resolveConfig();
  const apiKey = options.apiKey ?? local?.apiKey;
  const baseUrl = (options.baseUrl ?? local?.baseUrl ?? "https://api.ploid.com").replace(/\/+$/, "");
  if (!apiKey && !options.requestHeaders) {
    throw new Error("Ploid is not connected. Sign in through your MCP client or set PLOID_API_KEY.");
  }
  const response = await fetch(`${baseUrl}/v1/agent`, {
    method: "POST",
    headers: {
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      "Content-Type": "application/json",
      Accept: "application/json",
      ...options.requestHeaders,
    },
    body: JSON.stringify({
      prompt,
      max_acu: maxAcu,
      max_output_tokens: Math.min(8_000, Math.floor(maxAcu * 10_000)),
      response_format: "standard",
    }),
  });
  const payload = await response.json().catch(() => ({})) as AgentEnvelope;
  if (!response.ok) {
    throw new Error(payload.error?.message ?? `Ploid request failed (${response.status}).`);
  }
  return payload;
}

function toolResult(payload: AgentEnvelope) {
  const output = payload.data?.output?.trim();
  const artifacts = payload.data?.artifacts ?? [];
  const structuredOutput = payload.data?.structured_output;
  const text = [
    output || "Ploid completed the request without a text synthesis.",
    structuredOutput !== undefined ? `\nStructured result:\n${JSON.stringify(structuredOutput, null, 2)}` : "",
    artifacts.length > 0 ? `\nStructured artifacts:\n${JSON.stringify(artifacts, null, 2)}` : "",
    payload.meta ? `\nUsage:\n${JSON.stringify(payload.meta, null, 2)}` : "",
  ].filter(Boolean).join("\n");
  return { content: [{ type: "text" as const, text }] };
}

async function safeRun(options: PloidMcpOptions, prompt: string, maxAcu?: number) {
  try {
    return toolResult(await runAgent(options, prompt, maxAcu));
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
    };
  }
}

export function createPloidMcpServer(options: PloidMcpOptions = {}): McpServer {
  const server = new McpServer(
    { name: "ploid-people-intelligence", version: "0.2.0", websiteUrl: "https://ploid.com" },
    {
      instructions:
        "Use Ploid for sourced people and company research, decision-maker discovery, and evidence-grounded outreach. Tool calls consume the connected Ploid workspace's ACU balance.",
    },
  );

  server.registerTool("research_person", {
    title: "Research a person",
    description: "Resolve a professional identity and return sourced context plus safe personalization angles.",
    inputSchema: {
      name: z.string().min(1),
      company: z.string().optional(),
      linkedin_url: z.string().url().optional(),
      goal: z.string().optional(),
    },
    annotations: BILLABLE_TOOL_ANNOTATIONS,
  }, (input) => safeRun(options, researchPersonPrompt({ name: input.name, company: input.company, linkedinUrl: input.linkedin_url, goal: input.goal })));

  server.registerTool("find_people", {
    title: "Find people",
    description: "Find a sourced cohort of people from a natural-language sales or research query.",
    inputSchema: { query: z.string().min(1), count: z.number().int().min(1).max(50).default(10) },
    annotations: BILLABLE_TOOL_ANNOTATIONS,
  }, (input) => safeRun(options, findPeoplePrompt(input)));

  server.registerTool("find_decision_makers", {
    title: "Find decision-makers",
    description: "Identify likely buyers and influencers at a company for a specific product.",
    inputSchema: {
      company: z.string().min(1),
      product: z.string().min(1),
      count: z.number().int().min(1).max(20).default(5),
      titles: z.array(z.string()).max(20).optional(),
    },
    annotations: BILLABLE_TOOL_ANNOTATIONS,
  }, (input) => safeRun(options, decisionMakersPrompt(input)));

  server.registerTool("personalize_message", {
    title: "Personalize a message",
    description: "Research a person and draft evidence-grounded outreach without creepy personalization.",
    inputSchema: {
      person: z.string().min(1),
      company: z.string().optional(),
      offering: z.string().min(1),
      channel: z.enum(["email", "linkedin", "sms"]).default("email"),
      tone: z.string().default("concise, direct, and human"),
    },
    annotations: BILLABLE_TOOL_ANNOTATIONS,
  }, (input) => safeRun(options, personalizePrompt(input)));

  server.registerTool("research_company", {
    title: "Research a company",
    description: "Build a sourced company brief with buyer and decision-maker hypotheses.",
    inputSchema: { company: z.string().min(1), domain: z.string().optional(), goal: z.string().optional() },
    annotations: BILLABLE_TOOL_ANNOTATIONS,
  }, (input) => safeRun(options, researchCompanyPrompt(input)));

  server.registerTool("run_agent", {
    title: "Run Ploid agent",
    description: "Run a broader people-research, decision-maker, or personalization job in natural language.",
    inputSchema: { prompt: z.string().min(1), max_acu: z.number().min(0.2).max(6.4).default(0.8) },
    annotations: BILLABLE_TOOL_ANNOTATIONS,
  }, (input) => safeRun(options, input.prompt, input.max_acu));

  return server;
}

/** Handle one stateless Streamable HTTP request (ChatGPT, Claude, or any MCP client). */
export async function handlePloidMcpRequest(request: Request, options: PloidMcpOptions): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport();
  const server = createPloidMcpServer(options);
  await server.connect(transport);
  return transport.handleRequest(request);
}

export async function serveMcp(): Promise<void> {
  const server = createPloidMcpServer();
  await server.connect(new StdioServerTransport());
}
