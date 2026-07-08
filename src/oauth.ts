import type { Context } from 'hono'
import { PLOID_SCOPES, baseUrl } from './config.js'
import { log } from './log.js'
import { seal, sha256base64url, unseal } from './seal.js'

/**
 * Minimal OAuth 2.1 authorization server so Claude/ChatGPT connectors can
 * authenticate users who only have a Ploid API key.
 *
 * Flow: the client registers via DCR (/register), sends the user to
 * /authorize where they paste their Ploid API key, and exchanges the
 * resulting code at /token. The access token is the API key sealed with
 * MCP_TOKEN_SECRET (see seal.ts) — no database, fully stateless.
 *
 * When ploid.com ships a real login/consent flow (Better Auth), only the
 * /authorize page needs to change: redirect to ploid.com, get the user's API
 * key (or a user-scoped key) back, and mint the same sealed tokens.
 *
 * Statelessness trade-off: authorization codes can't be strictly single-use
 * without shared storage. Mitigated with a 60-second TTL + PKCE binding.
 */

const CLIENT_PREFIX = 'pmclient_'
const CODE_PREFIX = 'pmcode_'
const ACCESS_PREFIX = 'pmat_'
const REFRESH_PREFIX = 'pmrt_'

const CODE_TTL_S = 60
const ACCESS_TTL_S = 30 * 24 * 3600 // 30 days
const REFRESH_TTL_S = 365 * 24 * 3600 // 1 year

// ── Discovery ───────────────────────────────────────────────────────────────

/** RFC 8414 authorization server metadata. */
export function authorizationServerMetadata(c: Context) {
  const base = baseUrl(c)
  return c.json({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: PLOID_SCOPES,
    service_documentation: 'https://ploid.com/docs/mcp',
  })
}

// ── Dynamic client registration (RFC 7591) ──────────────────────────────────

/**
 * Stateless DCR: the client_id itself is a sealed record of the registration
 * (redirect URIs + display name), so nothing is stored server-side.
 */
export async function registerClient(c: Context) {
  const body = (await c.req.json().catch(() => null)) as {
    redirect_uris?: unknown
    client_name?: unknown
  } | null
  const uris = Array.isArray(body?.redirect_uris) ? (body.redirect_uris as unknown[]) : []
  const redirectUris = uris.filter(
    (u): u is string => typeof u === 'string' && u.length <= 2000 && isAllowedRedirectUri(u)
  )
  if (redirectUris.length === 0 || redirectUris.length > 10) {
    return c.json(
      {
        error: 'invalid_client_metadata',
        error_description: 'redirect_uris must contain 1-10 https:// (or http://localhost) URLs.',
      },
      400
    )
  }
  const clientName = typeof body?.client_name === 'string' ? body.client_name.slice(0, 100) : undefined

  const clientId = seal({ t: 'client', ru: redirectUris, n: clientName }, CLIENT_PREFIX)
  log('oauth_client_registered', { clientName, redirectUris })
  return c.json(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      ...(clientName && { client_name: clientName }),
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    },
    201
  )
}

function isAllowedRedirectUri(uri: string): boolean {
  try {
    const url = new URL(uri)
    if (url.protocol === 'https:') return true
    return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
  } catch {
    return false
  }
}

// ── /authorize ───────────────────────────────────────────────────────────────

interface AuthRequest {
  clientId: string
  clientName?: string
  redirectUri: string
  state?: string
  codeChallenge: string
  scope?: string
}

/**
 * Validates authorize parameters. Returns a Response for fatal errors (bad
 * client / redirect URI — never redirect to an unverified URI), a redirect
 * for protocol errors, or the parsed request.
 */
function parseAuthRequest(c: Context, params: Record<string, string | undefined>): AuthRequest | Response {
  const clientId = params.client_id ?? ''
  const client = unseal(clientId, CLIENT_PREFIX)
  if (!client || client.t !== 'client' || !Array.isArray(client.ru)) {
    return c.html(errorPage('Unknown client. The connecting app must register with this server first.'), 400)
  }
  const redirectUri = params.redirect_uri ?? ''
  if (!(client.ru as string[]).includes(redirectUri)) {
    return c.html(errorPage('The redirect URL does not match the one this app registered.'), 400)
  }
  const fail = (error: string, description: string) => {
    const to = new URL(redirectUri)
    to.searchParams.set('error', error)
    to.searchParams.set('error_description', description)
    if (params.state) to.searchParams.set('state', params.state)
    return c.redirect(to.toString(), 302)
  }
  if (params.response_type !== 'code') {
    return fail('unsupported_response_type', 'Only response_type=code is supported.')
  }
  if (!params.code_challenge || (params.code_challenge_method ?? 'S256') !== 'S256') {
    return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required.')
  }
  return {
    clientId,
    clientName: typeof client.n === 'string' ? client.n : undefined,
    redirectUri,
    state: params.state,
    codeChallenge: params.code_challenge,
    scope: params.scope,
  }
}

export function authorizePage(c: Context) {
  const req = parseAuthRequest(c, c.req.query())
  if (req instanceof Response) return req
  return c.html(keyForm(req))
}

export async function authorizeSubmit(c: Context) {
  const body = await c.req.parseBody()
  const params = Object.fromEntries(
    Object.entries(body).filter(([, v]) => typeof v === 'string')
  ) as Record<string, string>
  const req = parseAuthRequest(c, params)
  if (req instanceof Response) return req

  const apiKey = (params.api_key ?? '').trim()
  const problem = await validateApiKey(apiKey)
  if (problem) {
    log('oauth_key_rejected', { reason: problem })
    return c.html(keyForm(req, problem), 401)
  }

  const code = seal(
    {
      t: 'code',
      k: apiKey,
      cid: sha256base64url(req.clientId),
      ru: req.redirectUri,
      cc: req.codeChallenge,
      exp: Math.floor(Date.now() / 1000) + CODE_TTL_S,
    },
    CODE_PREFIX
  )
  const to = new URL(req.redirectUri)
  to.searchParams.set('code', code)
  if (req.state) to.searchParams.set('state', req.state)
  log('oauth_code_issued', { client: req.clientName ?? 'unknown' })
  return c.redirect(to.toString(), 302)
}

/** Returns a user-facing problem description, or null when the key is good. */
async function validateApiKey(apiKey: string): Promise<string | null> {
  if (!/^sk_[A-Za-z0-9_-]{8,}$/.test(apiKey)) {
    return 'That does not look like a Ploid API key (they start with "sk_").'
  }
  // Mock mode has no upstream to validate against; format check is enough.
  if (process.env.PLOID_MODE !== 'live') return null

  const base = process.env.PLOID_API_BASE_URL ?? 'https://api.ploid.com'
  try {
    const res = await fetch(new URL('/v1/account/credits', base), {
      headers: { 'x-api-key': apiKey },
      signal: AbortSignal.timeout(10_000),
    })
    if (res.ok) return null
    if (res.status === 401) return 'Ploid rejected this API key. Check for typos or create a new key.'
    if (res.status === 403) {
      return 'This key is valid but missing the account:read scope. Use a key with scopes: people:search, people:lookup, people:enrich, account:read.'
    }
    return `Could not verify the key with Ploid (HTTP ${res.status}). Try again in a moment.`
  } catch {
    return 'Could not reach the Ploid API to verify the key. Try again in a moment.'
  }
}

// ── /token ───────────────────────────────────────────────────────────────────

export async function tokenEndpoint(c: Context) {
  const body: Record<string, string | File> = await c.req.parseBody().catch(() => ({}))
  const param = (name: string) => {
    const v = body[name]
    return typeof v === 'string' ? v : undefined
  }
  const clientIdHash = sha256base64url(param('client_id') ?? '')
  const grantType = param('grant_type')
  c.header('Cache-Control', 'no-store')

  if (grantType === 'authorization_code') {
    const code = unseal(param('code') ?? '', CODE_PREFIX)
    if (!code || code.t !== 'code' || typeof code.k !== 'string') {
      return c.json({ error: 'invalid_grant', error_description: 'Invalid or expired authorization code.' }, 400)
    }
    if (code.cid !== clientIdHash) {
      return c.json({ error: 'invalid_grant', error_description: 'Code was issued to a different client.' }, 400)
    }
    if (code.ru !== param('redirect_uri')) {
      return c.json({ error: 'invalid_grant', error_description: 'redirect_uri does not match.' }, 400)
    }
    const verifier = param('code_verifier') ?? ''
    if (!verifier || sha256base64url(verifier) !== code.cc) {
      return c.json({ error: 'invalid_grant', error_description: 'PKCE verification failed.' }, 400)
    }
    log('oauth_token_issued', { grant: 'authorization_code' })
    return c.json(issueTokens(code.k, clientIdHash))
  }

  if (grantType === 'refresh_token') {
    const refresh = unseal(param('refresh_token') ?? '', REFRESH_PREFIX)
    if (!refresh || refresh.t !== 'rt' || typeof refresh.k !== 'string' || refresh.cid !== clientIdHash) {
      return c.json({ error: 'invalid_grant', error_description: 'Invalid or expired refresh token.' }, 400)
    }
    log('oauth_token_issued', { grant: 'refresh_token' })
    return c.json(issueTokens(refresh.k, clientIdHash))
  }

  return c.json(
    { error: 'unsupported_grant_type', error_description: 'Use authorization_code or refresh_token.' },
    400
  )
}

function issueTokens(apiKey: string, clientIdHash: string) {
  const now = Math.floor(Date.now() / 1000)
  return {
    access_token: seal({ t: 'at', k: apiKey, cid: clientIdHash, exp: now + ACCESS_TTL_S }, ACCESS_PREFIX),
    token_type: 'bearer',
    expires_in: ACCESS_TTL_S,
    refresh_token: seal({ t: 'rt', k: apiKey, cid: clientIdHash, exp: now + REFRESH_TTL_S }, REFRESH_PREFIX),
  }
}

/** Opens an access token minted above. Returns the Ploid API key, or null. */
export function openAccessToken(token: string): string | null {
  const payload = unseal(token, ACCESS_PREFIX)
  return payload && payload.t === 'at' && typeof payload.k === 'string' ? payload.k : null
}

// ── HTML ─────────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function page(body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Connect Ploid</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font: 15px/1.5 system-ui, -apple-system, sans-serif;
         background: light-dark(#f6f6f4, #111213); color: light-dark(#1a1a1a, #ececec); }
  .card { width: min(400px, calc(100vw - 2rem)); padding: 2rem;
          background: light-dark(#fff, #1b1d1e); border-radius: 12px;
          border: 1px solid light-dark(#e4e4e0, #2c2f30); box-sizing: border-box; }
  .wordmark { font-weight: 700; font-size: 1.15rem; letter-spacing: -0.02em; margin-bottom: 1rem; }
  h1 { font-size: 1.05rem; margin: 0 0 .5rem; }
  p { margin: .5rem 0; color: light-dark(#555, #a8a8a8); }
  a { color: inherit; }
  input[type=password] { width: 100%; box-sizing: border-box; margin: .75rem 0; padding: .6rem .7rem;
          font: inherit; border-radius: 8px; border: 1px solid light-dark(#ccc, #3a3d3e);
          background: light-dark(#fff, #111213); color: inherit; }
  button { width: 100%; padding: .6rem; font: inherit; font-weight: 600; border: 0; border-radius: 8px;
           background: #4f46e5; color: #fff; cursor: pointer; }
  button:hover { background: #4338ca; }
  .error { color: #dc2626; margin: .5rem 0; }
  .fine { font-size: .8rem; }
</style>
</head>
<body><div class="card"><div class="wordmark">Ploid</div>${body}</div></body>
</html>`
}

function keyForm(req: AuthRequest, error?: string): string {
  const who = req.clientName ? `<strong>${esc(req.clientName)}</strong>` : 'An app'
  const hidden = (name: string, value: string | undefined) =>
    value ? `<input type="hidden" name="${name}" value="${esc(value)}">` : ''
  return page(`
<h1>Connect your Ploid account</h1>
<p>${who} wants to search people and reveal contact info using your Ploid account and credits.</p>
${error ? `<p class="error">${esc(error)}</p>` : ''}
<form method="post" action="/authorize">
  ${hidden('response_type', 'code')}
  ${hidden('client_id', req.clientId)}
  ${hidden('redirect_uri', req.redirectUri)}
  ${hidden('state', req.state)}
  ${hidden('code_challenge', req.codeChallenge)}
  ${hidden('code_challenge_method', 'S256')}
  ${hidden('scope', req.scope)}
  <input type="password" name="api_key" placeholder="sk_live_..." autocomplete="off" required autofocus>
  <button type="submit">Connect</button>
</form>
<p class="fine">Find or create a key in the <a href="https://ploid.com/dashboard/settings/api-keys" target="_blank" rel="noopener">Ploid dashboard</a> (Settings &rarr; API&nbsp;Keys). It needs the people:search, people:lookup, people:enrich, and account:read scopes. Your key is stored only inside the encrypted token issued to the app.</p>`)
}

function errorPage(message: string): string {
  return page(`<h1>Can&rsquo;t continue</h1><p>${esc(message)}</p>`)
}
