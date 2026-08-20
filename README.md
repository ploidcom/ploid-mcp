# Ploid MCP

Give ChatGPT, Claude, and other MCP clients sourced people research, company research, decision-maker discovery, and evidence-grounded outreach.

## Connect the hosted server

Use this public Streamable HTTP endpoint:

```text
https://api.ploid.com/mcp
```

No API key, OAuth client ID, or client secret needs to be copied into your AI client. Ploid handles OAuth login and consent, scopes the connection to the workspace you approve, and charges tool calls to that workspace's ACU balance.

### ChatGPT

1. Open **Settings → Security and login** and enable **Developer mode**.
2. Open **ChatGPT Plugins**, select **+**, and create a connection.
3. Enter `https://api.ploid.com/mcp` as the MCP server URL.
4. Sign in to Ploid, choose a workspace, and approve access.

### Claude

1. Open **Customize → Connectors**.
2. Select **+ → Add custom connector**.
3. Enter `Ploid` and `https://api.ploid.com/mcp`.
4. Select **Connect**, then sign in to Ploid and approve access.

## Tools

| Tool | Purpose |
| --- | --- |
| `research_person` | Resolve a professional identity and return sourced context plus safe personalization angles |
| `find_people` | Find a sourced cohort from a natural-language query |
| `find_decision_makers` | Identify likely buyers and influencers at a company |
| `personalize_message` | Research a person and draft evidence-grounded outreach |
| `research_company` | Build a sourced company and buyer brief |
| `run_agent` | Run a broader Ploid people-intelligence task |

Tool calls can consume paid usage. They are deliberately marked non-read-only and open-world, while remaining non-destructive.

## How authentication works

The hosted service supports OAuth 2.1 discovery, dynamic client registration, authorization code with S256 PKCE, short-lived audience-bound access tokens, refresh-token rotation, and revocation.

The MCP bearer token is a separate credential from the Ploid API billing principal. It is never passed through to the upstream API. See [Hosted architecture](docs/architecture.md) for the trust boundary and token lifecycle.

## Local stdio development

Requirements: Node.js 20+ and pnpm 9.

```bash
pnpm install
pnpm check
```

Run the local stdio adapter with a Ploid API key:

```bash
export PLOID_API_KEY=ploid_live_...
pnpm dev
```

Configure a local MCP host to run the built CLI:

```json
{
  "mcpServers": {
    "ploid": {
      "command": "node",
      "args": ["/absolute/path/to/ploid-mcp/dist/cli.js"],
      "env": {
        "PLOID_API_KEY": "ploid_live_..."
      }
    }
  }
}
```

Build before using that configuration:

```bash
pnpm build
```

The CLI also supports the Ploid device flow:

```bash
pnpm dev login
pnpm dev logout
```

## Embed the Streamable HTTP adapter

The package exports a fresh, stateless Web Standard handler for each request:

```ts
import { handlePloidMcpRequest } from "@ploid/mcp";

const response = await handlePloidMcpRequest(request, {
  apiKey: process.env.PLOID_API_KEY,
  baseUrl: "https://api.ploid.com",
});
```

Authenticate the HTTP request before invoking the handler. The hosted Ploid service uses its server-only `requestHeaders` option to map an approved OAuth grant to a private same-process credential; never populate that option from client input.

## Source layout

```text
src/
  cli.ts       stdio entry point and local login/logout commands
  config.ts    local credential and API URL resolution
  device.ts    browser device authorization for local stdio use
  logout.ts    API-key revocation for local stdio use
  prompts.ts   evidence and safety constraints for focused tools
  server.ts    MCP tools plus stateless Streamable HTTP handler
test/
  prompts.test.ts
  server.test.ts
```

## Security

- The public MCP endpoint requires OAuth before initialization or tool discovery.
- Authorization codes expire after five minutes and can be redeemed only once.
- Access tokens expire after one hour; refresh tokens rotate on every use.
- Access tokens are bound to `https://api.ploid.com/mcp`.
- Ploid stores only hashes of OAuth secrets, codes, tokens, and API keys.
- The OAuth bearer token is never forwarded to the Ploid API.

Report vulnerabilities to [security@ploid.com](mailto:security@ploid.com). Licensed under [MIT](LICENSE).
