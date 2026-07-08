import type { Context } from 'hono'

/** Ploid API key scopes this server's tools need (docs/README.md → Authentication). */
export const PLOID_SCOPES = ['people:search', 'people:lookup', 'people:enrich', 'account:read'] as const

/** External base URL of this server, for discovery metadata and OAuth endpoints. */
export function baseUrl(c: Context): string {
  return process.env.BASE_URL ?? new URL(c.req.url).origin
}
