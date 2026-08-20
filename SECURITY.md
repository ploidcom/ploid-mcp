# Security

Please report vulnerabilities privately to [security@ploid.com](mailto:security@ploid.com). Do not open a public issue for a suspected vulnerability.

Ploid's hosted MCP service uses OAuth 2.1 with S256 PKCE, exact redirect URI matching, audience-bound access tokens, rotating refresh tokens, and revocation. OAuth bearer tokens are never forwarded to the Ploid API. See [the architecture notes](docs/architecture.md) for the trust boundary.
