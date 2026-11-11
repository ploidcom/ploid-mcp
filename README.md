# Ploid MCP

Give ChatGPT, Claude, and other MCP clients source-reviewed person research and verified lists of people and decision-makers.

## Connect the hosted server

Use this Streamable HTTP endpoint:

```text
https://api.ploid.com/mcp
```

The endpoint supports MCP `2026-07-28` discovery and requests alongside the
older `initialize` flow and standalone SSE stream. Existing connections can
continue using their negotiated protocol version.

The first tool call opens Ploid's OAuth login and consent page. Access is tied to the workspace you choose, tokens are scoped and expiring, and tool calls use that workspace's ACU balance.

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

No client ID, client secret, or API key is required. The server supports OAuth 2.1 discovery, dynamic client registration, authorization code + S256 PKCE, refresh-token rotation, and revocation.

## Tools

| Tool                   | Ploid API                                                    | Purpose                                                       |
| ---------------------- | ------------------------------------------------------------ | ------------------------------------------------------------- |
| `search_people`        | `POST /v1/search/candidates`                                 | Name lookup to choose a person before research (1 ACU)        |
| `research_person`      | `POST /v1/person`                                            | Source-reviewed deep research on one person                   |
| `get_email`            | `POST /v1/person` (`include`)                                | Work email (1 ACU), else personal email (3 ACU); misses free  |
| `get_phone`            | `POST /v1/person` (`include`)                                | Mobile phone number (10 ACU when found, free when not)        |
| `find_people`          | `POST /v1/sets`                                              | Build a verified list of people from a natural-language query |
| `find_decision_makers` | `POST /v1/sets`                                              | Build a verified list of likely buyers at a company           |
| `get_research_status`  | `GET /v1/person/runs/{id}` or `GET /v1/sets/{id}`            | Retrieve a pending or completed run by ID                     |
| `cancel_research`      | `DELETE /v1/person/runs/{id}` or `POST /v1/sets/{id}/cancel` | Stop a run on an explicit user request                        |

`search_people` costs 1 ACU per completed search, including searches with no
matches. Failed searches are not charged. The three research tools also consume paid usage. Status
retrieval is read-only; cancellation stops a run and does not refund work already done.

Version 0.3.0 removed `personalize_message`, `research_company`, and
`run_agent`, which depended on the retired Agent API, and removed the `depth`,
`goal`, `company`, and `website_url` inputs of `research_person`.

### Research a person

For a name such as "Rahul Garg", call `search_people` first. It accepts `name`
with optional `company`, `location`, and `title` filters; `limit` defaults to 5
and must be 1 to 10. It returns basic indexed profiles, not verified research.
Results are bounded and may omit matches. No matches does not mean the person
does not exist.

Show the candidates and ask the user to choose, even if there is only one.
Then call `research_person` with exactly one of `person_id` from the chosen
result or an explicit HTTPS LinkedIn `/in/` profile URL as `linkedin_url`; the
schema's `anyOf` and the error text both say so. Name and company arguments
are no longer accepted. Do not research every candidate to
resolve an ambiguous name.

`/v1/person` has one deep mode. The first successful profile of a person costs
a fixed 25 ACU in the connected workspace; the same workspace can reread it
free for 90 days. Not-found and uncertain-identity results are free. An
uncertain result returns `found: false` with suggested clues rather than a
same-name biography.

### Find people and decision-makers

`find_people` (`count` 1 to 25) and `find_decision_makers` (`count` 1 to 20)
create a Ploid Set. Each candidate is checked against criteria: derived from the query
for `find_people`, and built from the company, product, and optional `titles`
for `find_decision_makers`. Sets prices search at 1 ACU per 10 people; the
pending and final results include the Sets API's pricing object.

### Input ranges are checked, not clamped

Tool schemas state each range in the field description instead of JSON-schema
`minimum`, `maximum`, or `maxLength`, because some LLM clients clamp arguments
to advertised bounds before the call reaches the server, turning an
out-of-range request into a billable in-range one. `src/bounds.ts` checks the
range on the server and returns an `isError` result naming it (for example
`limit: must be a whole number between 1 and 10 (got 11)`) before any API
request, so nothing is charged. The API repeats the check with a 422.

### Long research and timeouts

Research tools return a `run_id` promptly. Person runs look like
`person-<id>` and searches look like `set-<id>`; the prefix routes status and
cancellation to the right API. A pending response is not a research answer.
Call `get_research_status` with that ID no more often than every five seconds
until it returns `status: completed` and the result. Keep the ID to resume from
another MCP process or after restarting Claude. The API authorizes every lookup
against the connected workspace. Run IDs from the removed Agent tools can no
longer be retrieved.

Stop polling a failed or cancelled run. A pending response's 0 ACU is usage so
far; a successful completion may still charge 25 ACU.

`get_email` and `get_phone` request the person at the `standard` level, so a profile researched at either level is reread for free and an unresearched person starts standard research (10 ACU on success) with the contact attached to the completed run; they never upgrade a standard profile to deep.

Each MCP-to-API HTTP request has a 20-second deadline, except `get_email` and `get_phone` on an already-researched person, which wait up to 90 seconds for the API's provider lookup. The investigation runs in
the API's durable job, independently of these short calls. Disconnecting or a
status-request timeout does not automatically cancel it. The API's execution
deadline and result retention still apply; MCP itself does not guarantee
unlimited runtime or that a client will poll forever.

Hosted HTTP retries reuse the same result or job without a second charge for the same authenticated connection,
MCP session (when supplied), JSON-RPC ID, tool and arguments during the API's
24-hour idempotency window. If the initial acknowledgement is lost, retry those
values. For an intentional new operation, use a new JSON-RPC ID or
`Idempotency-Key` header; preserve that header across retries. Once a `run_id`
is known, resume with `get_research_status`. Restarted stdio processes have
separate namespaces.

Only call `cancel_research` on an explicit user request. Cancelling a search
keeps, and bills, people it admitted before stopping.

After rebuilding a local stdio server, reconnect it in Claude to load the new
tool definitions. A hosted server continues using its deployed build.

## Run locally (stdio)

Node.js 20+ and pnpm are required.

```bash
pnpm install
pnpm test
pnpm build
node dist/cli.js login     # or: export PLOID_API_KEY=ploid_live_...
node dist/cli.js           # start the stdio server
```

Or with Docker:

```bash
docker build -t ploid-mcp .
docker run -i --rm -e PLOID_API_KEY=ploid_live_... ploid-mcp
```

`PLOID_API_BASE_URL` overrides the API (default `https://api.ploid.com`).
The reusable Streamable HTTP entry point is `handlePloidMcpRequest(request, { apiKey, baseUrl })` from `src/server.ts`. The hosted service authenticates the bearer token before calling it.

This repository is a mirror of the server in Ploid's private monorepo. Open
issues and pull requests here; accepted changes are applied upstream and
mirrored back. `src/contracts.d.ts` holds the Ploid API wire types the server
uses, generated from the private package; it contains types only.

## Security

- The MCP endpoint requires a bearer token before initialization or tool discovery.
- OAuth access is limited to `agent:chat`, `people:enrich`, `people:search`, and `account:read`. Connections authorized before 0.3.0 were upgraded to the people scopes on the server, so they keep working.
- `ploid-mcp login` writes the key the Ploid CLI also uses, so it receives the CLI's default scopes: `people:enrich`, `people:search`, `linkedin:read`, `account:read`, and `account:write`. Older full-access keys (`people:enrich` + `agent:chat`) can still build Sets. Keys from `ploid-mcp login` 0.2.0 or earlier (only `agent:chat` + `account:read`) must log in again.
- Authorization codes expire after five minutes and can be redeemed only once.
- PKCE uses `S256`; redirect URIs must exactly match the registered client.
- Access tokens expire after one hour; refresh tokens rotate on every use.
- Ploid stores only hashes of client secrets, authorization codes, access tokens, refresh tokens, and API keys.
- The MCP bearer token is audience-bound and is never passed through to Ploid's upstream API.

See [LICENSE](./LICENSE) and [SECURITY.md](./SECURITY.md). Security reports: security@ploid.com.
