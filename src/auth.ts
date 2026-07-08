import type { Context, MiddlewareHandler } from 'hono'
import { PLOID_SCOPES, baseUrl } from './config.js'
import { log } from './log.js'
import { openAccessToken } from './oauth.js'

export { PLOID_SCOPES } from './config.js'
export { baseUrl } from './config.js'

/**
 * Resource-server layer for /mcp.
 *
 * Every request carries a bearer token; a TokenVerifier turns it into an
 * AuthContext (whose apiKey is forwarded to the Ploid API) or rejects with
 * 401. AUTH_MODE=oauth uses sealed tokens minted by the built-in OAuth flow
 * (src/oauth.ts) and also accepts raw sk_… Ploid API keys for clients that
 * support custom Authorization headers. AUTH_MODE=dev accepts everything.
 */

/** Identity attached to a request after token verification. */
export interface AuthContext {
  subject: string
  scopes: string[]
  /** Ploid API key to call the API with on this user's behalf. Empty in dev mode when none was sent. */
  apiKey: string
}

export interface TokenVerifier {
  /** Resolve a bearer token to an identity, or throw to reject with 401. */
  verify(token: string): Promise<AuthContext>
}

/** Dev-mode bypass: accepts any request; a bearer token, if sent, is treated as an API key. */
class DevTokenVerifier implements TokenVerifier {
  async verify(token: string): Promise<AuthContext> {
    return { subject: 'dev-user', scopes: [...PLOID_SCOPES], apiKey: token }
  }
}

/**
 * Production verifier: opens sealed access tokens from the built-in OAuth
 * flow, and passes raw Ploid API keys straight through.
 */
class SealedTokenVerifier implements TokenVerifier {
  async verify(token: string): Promise<AuthContext> {
    if (token.startsWith('sk_')) {
      return { subject: 'api-key', scopes: [...PLOID_SCOPES], apiKey: token }
    }
    const apiKey = openAccessToken(token)
    if (!apiKey) {
      throw new Error('invalid, expired, or tampered access token')
    }
    return { subject: 'oauth-user', scopes: [...PLOID_SCOPES], apiKey }
  }
}

export function createTokenVerifier(): TokenVerifier {
  if (process.env.AUTH_MODE === 'oauth') {
    return new SealedTokenVerifier()
  }
  log('auth_mode', { mode: 'dev', warning: 'token verification bypassed' })
  return new DevTokenVerifier()
}

function unauthorized(c: Context, description: string) {
  const metadataUrl = `${baseUrl(c)}/.well-known/oauth-protected-resource`
  c.header(
    'WWW-Authenticate',
    `Bearer resource_metadata="${metadataUrl}", error="invalid_token", error_description="${description}"`
  )
  return c.json(
    { jsonrpc: '2.0', error: { code: -32001, message: `Unauthorized: ${description}` }, id: null },
    401
  )
}

/** Hono middleware: verifies the bearer token and stores AuthContext in `c`. */
export function bearerAuth(verifier: TokenVerifier): MiddlewareHandler {
  const devMode = process.env.AUTH_MODE !== 'oauth'
  return async (c, next) => {
    const header = c.req.header('authorization') ?? ''
    const token = header.match(/^Bearer\s+(.+)$/i)?.[1] ?? ''
    if (!token && !devMode) {
      return unauthorized(c, 'missing bearer token')
    }
    try {
      c.set('auth', await verifier.verify(token))
    } catch (err) {
      log('auth_rejected', { reason: String(err) })
      return unauthorized(c, 'token verification failed')
    }
    await next()
  }
}

/**
 * RFC 9728 protected-resource metadata. The authorization server is this
 * same service (built-in OAuth flow) unless AUTH_ISSUER points elsewhere.
 */
export function protectedResourceMetadata(c: Context) {
  const base = baseUrl(c)
  return c.json({
    resource: `${base}/mcp`,
    authorization_servers: [process.env.AUTH_ISSUER ?? base],
    bearer_methods_supported: ['header'],
    scopes_supported: PLOID_SCOPES,
    resource_name: 'Ploid MCP Server',
    resource_documentation: 'https://ploid.com/docs/mcp',
  })
}
