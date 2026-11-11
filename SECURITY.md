# Security

Report vulnerabilities privately to security@ploid.com. Please do not open a
public issue for a suspected vulnerability.

## What this code does

- It is a thin client for the Ploid HTTP API. Every tool call is one or more
  HTTPS requests to `PLOID_API_BASE_URL` (default `https://api.ploid.com`)
  through `src/api.ts`. It makes no other network calls and runs no shell
  commands, except `ploid-mcp login`, which opens your browser for the device
  login.
- Credentials: the stdio server reads `PLOID_API_KEY`, or the key saved by
  `ploid-mcp login` in `$XDG_CONFIG_HOME/ploid/config.json` (default
  `~/.config/ploid/config.json`), written with mode `0600`. `ploid-mcp logout`
  revokes the key and removes it from that file.
- The key is sent only as a bearer token to the configured Ploid API. It is
  never logged or returned in tool results.
- Tool inputs are validated with zod before any request is sent. Out-of-range
  values are rejected, not clamped, so they are never billed.

The hosted server at `https://api.ploid.com/mcp` runs this same code behind
Ploid's OAuth 2.1 layer; see the Security section of the README.
