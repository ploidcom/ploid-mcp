# Hosted architecture

The public endpoint is `https://api.ploid.com/mcp`. It runs this repository's stateless Streamable HTTP adapter inside the Ploid API service, where account identity and billing already live.

```text
ChatGPT / Claude
      │ OAuth access token (audience: https://api.ploid.com/mcp)
      ▼
Ploid MCP endpoint
      │ private same-process capability + approved workspace key ID
      ▼
Ploid Agent API
```

The OAuth token and the Ploid API billing principal are different credentials. Access and refresh tokens are opaque random values stored only as SHA-256 hashes. The MCP endpoint validates the grant, then uses a private per-process capability to select the server-side workspace key. It never forwards the caller's OAuth bearer token to `/v1/agent` or any other upstream service.

The production authorization server provides:

- RFC 9728 protected-resource metadata
- OAuth authorization-server metadata
- dynamic client registration
- authorization code flow with S256 PKCE
- exact registered redirect URI validation
- five-minute, single-use authorization codes
- one-hour, audience-bound access tokens
- rotating 90-day refresh tokens
- token and underlying workspace-key revocation

OAuth and consent remain part of the hosted Ploid service because they require Ploid user sessions, workspace membership, billing eligibility, and the production database. This repository contains the reusable MCP protocol and tool layer; local stdio use authenticates directly with a Ploid API key.
