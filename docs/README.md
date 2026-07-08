# Ploid Public API — Docs

Agent-native people search and enrichment API.

- **Base URL:** `https://api.ploid.com`
- **Live spec:** `GET https://api.ploid.com/v1/openapi.json`
- **This repo:** the full OpenAPI 3.1 spec + a ready-to-run Postman collection.

## Contents

| File                                                                         | What it is                                                                                                           |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| [`openapi.yaml`](./openapi.yaml)                                             | Complete OpenAPI 3.1 spec for every `/v1` endpoint. Import into Swagger UI / Redoc / Stoplight, or any OpenAPI tool. |
| [`ploid-api.postman_collection.json`](./ploid-api.postman_collection.json)   | Postman collection with every endpoint, example bodies, and collection-level auth.                                   |
| [`ploid-api.postman_environment.json`](./ploid-api.postman_environment.json) | Postman environment with `baseUrl` + `apiKey`.                                                                       |

## Quickstart

### Postman

1. Import `ploid-api.postman_collection.json` **and** `ploid-api.postman_environment.json`.
2. Select the **Ploid Public API** environment (top-right).
3. Set `apiKey` to your key (Ploid dashboard → Settings → API Keys).
4. Send any request. Auth is applied automatically via the `x-api-key` header.

### Swagger / Redoc

Open [`openapi.yaml`](./openapi.yaml) in the [Swagger Editor](https://editor.swagger.io/), or serve it locally:

```bash
npx @redocly/cli preview-docs openapi.yaml
# or
npx swagger-ui-watcher openapi.yaml
```

### cURL

```bash
curl -X POST https://api.ploid.com/v1/people/search \
  -H "x-api-key: $PLOID_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "natural",
    "query": "founders of YC-backed devtools startups",
    "page": { "size": 25 }
  }'
```

## Authentication

Send your API key on every request, either way:

```
x-api-key: sk_live_...
Authorization: Bearer sk_live_...
```

Keys are **scoped**. Hitting an endpoint your key isn't scoped for returns `403 insufficient_scope`.

| Scope            | Grants                                                                      |
| ---------------- | --------------------------------------------------------------------------- |
| `people:search`  | `/v1/people/search*`, `/v1/searches*`, `/v1/monitors*`                      |
| `people:lookup`  | `/v1/people/lookup`                                                         |
| `people:enrich`  | `/v1/people/enrich`, `/v1/people/estimate`, `/v1/searches/{id}/enrichments` |
| `batch:write`    | `/v1/people/batch/*`                                                        |
| `linkedin:read`  | `/v1/linkedin/*`                                                            |
| `webhooks:write` | `/v1/webhooks*`                                                             |
| `account:read`   | `/v1/account/*`                                                             |
| `agent:chat`     | `/v1/agent/chat`                                                            |
| `agent:cancel`   | `/v1/agent/chat/cancel`                                                     |

An active paid plan (or a Free plan with a saved card for pay-as-you-go) is required.

## Response format

Success wraps the payload in `data`, with request metadata in `meta`:

```json
{ "data": { "...": "..." }, "meta": { "request_id": "req_..." } }
```

Errors use a consistent shape:

```json
{
  "error": {
    "code": "insufficient_credits",
    "message": "Out of credits. Top up to continue.",
    "request_id": "req_..."
  }
}
```

## Endpoints at a glance

| Group                    | Endpoints                                                                                                                                                                                                                                                                                    |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Agent**                | `POST /v1/agent/chat` · `POST /v1/agent/chat/cancel`                                                                                                                                                                                                                                         |
| **People**               | `POST /v1/people/search` · `POST /v1/people/search/criteria` · `GET /v1/people/search/criteria/{id}` · `POST /v1/people/lookup` · `POST /v1/people/enrich` · `POST /v1/people/estimate` · `POST /v1/people/batch/enrich` · `GET /v1/people/batch/{id}` · `GET /v1/people/batch/{id}/results` |
| **Search (People Sets)** | `POST /v1/searches` · `GET /v1/searches` · `GET /v1/searches/{id}` · `GET /v1/searches/{id}/items` · `POST /v1/searches/{id}/refine` · `POST /v1/searches/{id}/enrichments` · `POST /v1/searches/{id}/exports`                                                                               |
| **LinkedIn**             | `GET /v1/linkedin/profile` · `POST /v1/linkedin/search` · `GET /v1/linkedin/posts`                                                                                                                                                                                                           |
| **Monitors**             | `GET /v1/monitors` · `POST /v1/monitors` · `DELETE /v1/monitors/{id}`                                                                                                                                                                                                                        |
| **Webhooks**             | `GET /v1/webhooks` · `POST /v1/webhooks` · `DELETE /v1/webhooks/{id}`                                                                                                                                                                                                                        |
| **Account**              | `GET /v1/account/credits` · `GET /v1/account/usage` · `DELETE /v1/account/key`                                                                                                                                                                                                               |
| **Meta**                 | `GET /v1/openapi.json`                                                                                                                                                                                                                                                                       |

## Credits & billing

Usage is metered in credits (**1 credit = $0.10**).

| Action                                                   | Cost          |
| -------------------------------------------------------- | ------------- |
| Search (per 10 matched results, rounded up)              | 1 credit / 10 |
| LinkedIn profile / posts                                 | 1 credit      |
| Social enrichment (github, x, instagram, tiktok, reddit) | 1 credit each |
| Work email reveal                                        | 1 credit      |
| Personal email reveal                                    | 3 credits     |
| Mobile phone reveal                                      | 10 credits    |

Failed enrichment fields are never billed. Async jobs reserve the worst-case cost up front and settle to the actual amount on completion.

## Rate limits

Two-tier limiting: a per-organization/plan bucket (Free 10/min … Enterprise 1000/min) and a per-key fairness bucket (default 100/min, configurable per key). Over the limit returns `429 rate_limited` with a `Retry-After` header.

## Webhooks

Register an HTTPS endpoint via `POST /v1/webhooks`. Deliveries are `POST` with body:

```json
{
  "event": "batch.completed",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "data": { "...": "..." }
}
```

If you set a `secret`, each delivery is signed with `X-Ploid-Signature: sha256=<hmac>` (HMAC-SHA256 over the raw body). Events: `batch.completed`, `people_set.completed`, `people_set.failed`, `set.item.created`, `set.item.enriched`, `set.search.completed`, `set.idle`, `set.export.completed`.
