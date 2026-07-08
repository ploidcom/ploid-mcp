# ploid-mcp

Remote MCP server for [Ploid](https://ploid.com) — people search, profile enrichment, and contact reveal on top of the [Ploid Public API](docs/openapi.yaml), usable as a connector in Claude and ChatGPT.

Streamable HTTP transport at `POST /mcp`, fully **stateless** (no sessions, safe behind a load balancer).

## Tools

| Tool | Ploid endpoint | Credits |
| --- | --- | --- |
| `search_people` | `POST /v1/people/search` (natural mode) | ~1 per 10 results |
| `get_person_profile` | `POST /v1/people/lookup` | free |
| `reveal_contact` | `POST /v1/people/enrich` | work_email 1 · personal_email 3 · mobile_phone 10 |
| `check_credits` | `GET /v1/account/credits` | free |
| `search` / `fetch` | [OpenAI connector-compat](https://platform.openai.com/docs/mcp) aliases | same as above |

Design notes:

- **`person_id` is a self-contained token.** Ploid has no profile-by-id endpoint (lookup/enrich identify people by name/company/LinkedIn), and this server keeps no state — so the IDs returned by search encode `[id, name, company, linkedin_url]` as base64url ([src/ploid/ids.ts](src/ploid/ids.ts)). Any tool can re-identify a person from the ID alone, and ChatGPT's `fetch(id)` contract holds.
- **`reveal_contact` is deliberately separate** from search/lookup, never annotated read-only, defaults to the cheapest channel (`work_email`), and its description tells models to request only what the user asked for. Failed fields aren't billed (Ploid billing rule).
- **Credit accounting is surfaced everywhere**: search and reveal results include `credits_charged` / `remaining_credits`, and `check_credits` supports pre-flight balance checks.

## Run locally

```sh
pnpm install
pnpm dev          # tsx watch, port 3000
pnpm test         # integration + unit tests (node:test, no test framework deps)
pnpm lint         # eslint (typescript-eslint, type-checked rules)
pnpm typecheck    # tsc --noEmit over src + test
pnpm build        # compiles src/ to dist/
```

Environment variables (all optional in dev — defaults give you mock data with no auth; see [.env.example](.env.example)):

| Var | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Listen port |
| `BASE_URL` | request origin | External URL, used in OAuth discovery metadata |
| `PLOID_MODE` | `mock` | `mock` = in-repo fake data, `live` = real Ploid API |
| `PLOID_API_BASE_URL` | `https://api.ploid.com` | Ploid API base (live mode) |
| `PLOID_API_KEY` | — | Server-level `sk_live_…` key, used only when a request has no per-user key. Needs scopes: `people:search`, `people:lookup`, `people:enrich`, `account:read` |
| `AUTH_MODE` | `dev` | `dev` = accept every request, `oauth` = require bearer tokens (built-in OAuth flow) |
| `MCP_TOKEN_SECRET` | random per boot | Secret that encrypts OAuth tokens. **Set this in production** — without it, tokens die on restart and don't work across instances. Rotating it forces all users to reconnect |
| `AUTH_ISSUER` | this server | Override only to delegate OAuth to an external authorization server |

To exercise the **real API** locally: `PLOID_MODE=live PLOID_API_KEY=sk_live_... pnpm dev`.

Logs are JSON lines on stdout: every tool call (name, latency, result size, error code) and every upstream Ploid API call (path, status, latency, `request_id`).

## Testing

Three layers, cheapest first:

1. **`pnpm test`** — the suite in [test/](test/) boots the real server on an ephemeral port per file and drives it over HTTP: the full tool chain against mock data ([test/mcp.test.ts](test/mcp.test.ts)), the complete OAuth flow including PKCE/redirect/tamper rejections ([test/oauth.test.ts](test/oauth.test.ts)), the live client against a fake Ploid API implementing the documented contract — envelope, error shapes, key forwarding ([test/live-client.test.ts](test/live-client.test.ts)) — and unit tests for the sealed-token crypto and person-ID codec. Runs in under a second; no network, no real API key.
2. **MCP Inspector** — interactive manual poking (below).
3. **A real client over a tunnel** — the only way to see the OAuth screen and tool descriptions the way users do (below).

## Test with MCP Inspector

```sh
npx @modelcontextprotocol/inspector
```

Open the Inspector UI, choose transport **Streamable HTTP**, URL `http://localhost:3000/mcp`, connect, and exercise the tools. In dev mode no token is required.

Or curl directly:

```sh
curl -s localhost:3000/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_people","arguments":{"query":"fintech engineers in Slovenia"}}}'
```

## Connect from Claude / ChatGPT

Both need a public HTTPS URL. For local testing, tunnel:

```sh
ngrok http 3000   # or: cloudflared tunnel --url http://localhost:3000
```

**Claude** (claude.ai → Settings → Connectors → Add custom connector): enter `https://<tunnel-host>/mcp`. With `AUTH_MODE=oauth`, Claude discovers the built-in authorization server, registers itself, and opens the connect page where the user pastes their Ploid API key. In dev mode there's no auth step at all.

**ChatGPT** (Settings → Apps & Connectors → Advanced → Developer mode → Create): enter `https://<tunnel-host>/mcp`, auth "OAuth" (or "None" in dev mode). The `search`/`fetch` compat tools satisfy ChatGPT's connector schema; developer-mode chats can also call the primary tools.

**Clients with custom headers** (Claude Code, Cursor, scripts): skip OAuth and send the Ploid API key directly — `Authorization: Bearer sk_live_…`.

## Architecture

```
docs/             Ploid Public API reference (OpenAPI 3.1 + Postman)
src/
  index.ts        Hono app: CORS, auth middleware, /mcp, OAuth routes, /.well-known, health
  mcp.ts          Tool definitions (descriptions are the product — edit with care)
  auth.ts         Bearer-token middleware + TokenVerifier (sealed tokens / raw sk_ keys / dev bypass)
  oauth.ts        Built-in OAuth 2.1 authorization server (DCR, paste-key /authorize page, /token)
  seal.ts         AES-256-GCM sealed tokens (how the server stays stateless)
  config.ts       Base URL + Ploid scopes
  log.ts          JSON-lines logger
  ploid/
    types.ts      PloidClient interface + domain types (mirror Ploid's Person schema) + PloidError
    ids.ts        person_id token encode/decode
    client.ts     Per-request factory + live HTTP client (envelope + error mapping)
    mock.ts       Mock client with the same shapes and billing behavior (dev default)
```

### How auth works

The Ploid API only accepts API keys, but Claude/ChatGPT connectors only speak OAuth — so this server bridges: it is its own OAuth 2.1 authorization server. Clients register via dynamic client registration (`POST /register`), the user pastes their Ploid API key on the hosted `/authorize` page (validated live against `GET /v1/account/credits`), and `/token` issues an access token that is the **API key encrypted with `MCP_TOKEN_SECRET`** (AES-256-GCM). Nothing is stored server-side: client registrations, auth codes, and tokens are all self-contained sealed payloads, so any instance behind the load balancer can serve any step. Per request, the verifier decrypts the token and forwards the key upstream as `x-api-key`. Raw `sk_…` bearer tokens are accepted too.

Trade-offs, made deliberately: auth codes are not strictly single-use (60s TTL + PKCE instead — add Redis if that ever matters), and revocation = revoking the API key in the Ploid dashboard. When ploid.com ships a real login/consent flow, only the `/authorize` page changes; token format, verifier, and discovery stay identical.

Ploid API behaviors handled for you: the `{data, meta}` envelope, error mapping (`insufficient_credits`, `insufficient_scope`, `rate_limited` with `Retry-After`, 404, 422) into structured, model-readable tool errors with recovery guidance, natural-search minimum page size (25), and `request_id` propagation into logs. Profile data is treated as untrusted third-party content: every result carrying it leads with a prompt-injection notice.
