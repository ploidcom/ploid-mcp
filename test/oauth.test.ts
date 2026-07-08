// OAuth mode with mock data: the full connect flow, no upstream needed.
process.env.AUTH_MODE = 'oauth'
process.env.PLOID_MODE = 'mock'
process.env.MCP_TOKEN_SECRET = 'oauth-test-secret'

import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { after, before, test } from 'node:test'
import { callTool, form, rpc, startServer } from './helpers.js'
import type { TestServer } from './helpers.js'

let srv: TestServer
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback'

before(async () => {
  srv = await startServer()
})
after(async () => {
  await srv.close()
})

async function registerTestClient(): Promise<string> {
  const res = await fetch(`${srv.url}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'Test App' }),
  })
  assert.equal(res.status, 201)
  return ((await res.json()) as { client_id: string }).client_id
}

function pkce() {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

async function runAuthorizeFlow(clientId: string, apiKey: string) {
  const { verifier, challenge } = pkce()
  const submit = await form(`${srv.url}/authorize`, {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    state: 'xyz',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    api_key: apiKey,
  })
  return { ...submit, verifier }
}

async function exchange(fields: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${srv.url}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

test('discovery: protected resource points at this server as AS', async () => {
  const res = (await (await fetch(`${srv.url}/.well-known/oauth-protected-resource`)).json()) as Record<string, unknown>
  assert.deepEqual(res.authorization_servers, [srv.url])
  const as = (await (await fetch(`${srv.url}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>
  assert.equal(as.issuer, srv.url)
  assert.deepEqual(as.code_challenge_methods_supported, ['S256'])
})

test('full flow: register -> authorize -> token -> authenticated tool call', async () => {
  const clientId = await registerTestClient()

  // The authorize page renders with the client name.
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: pkce().challenge,
    code_challenge_method: 'S256',
  })
  const page = await fetch(`${srv.url}/authorize?${q}`)
  assert.equal(page.status, 200)
  const html = await page.text()
  assert.match(html, /Test App/)
  assert.match(html, /api_key/)

  const submit = await runAuthorizeFlow(clientId, 'sk_live_test_key_1')
  assert.equal(submit.status, 302)
  assert.ok(submit.location.startsWith(REDIRECT))
  const url = new URL(submit.location)
  const code = url.searchParams.get('code') ?? ''
  assert.equal(url.searchParams.get('state'), 'xyz')
  assert.ok(!code.includes('sk_live'), 'code must not contain the raw key')

  const token = await exchange({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    client_id: clientId,
    code_verifier: submit.verifier,
  })
  assert.equal(token.status, 200)
  const accessToken = token.body.access_token as string
  assert.ok(!accessToken.includes('sk_live'), 'access token must not contain the raw key')
  assert.equal(token.body.token_type, 'bearer')
  assert.ok(typeof token.body.refresh_token === 'string')

  const credits = await callTool(srv.url, 'check_credits', {}, accessToken)
  assert.equal(credits.isError, false)

  // Refresh grant issues a fresh working token.
  const refreshed = await exchange({
    grant_type: 'refresh_token',
    refresh_token: token.body.refresh_token,
    client_id: clientId,
  })
  assert.equal(refreshed.status, 200)
  const again = await callTool(srv.url, 'check_credits', {}, refreshed.body.access_token as string)
  assert.equal(again.isError, false)
})

test('PKCE: wrong verifier is rejected', async () => {
  const clientId = await registerTestClient()
  const submit = await runAuthorizeFlow(clientId, 'sk_live_test_key_2')
  const code = new URL(submit.location).searchParams.get('code') ?? ''
  const token = await exchange({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    client_id: clientId,
    code_verifier: 'completely-wrong-verifier-aaaaaaaaaaaaaaaaaaa',
  })
  assert.equal(token.status, 400)
  assert.equal(token.body.error, 'invalid_grant')
})

test('code issued to one client cannot be redeemed by another', async () => {
  const clientA = await registerTestClient()
  const clientB = await registerTestClient()
  const submit = await runAuthorizeFlow(clientA, 'sk_live_test_key_3')
  const code = new URL(submit.location).searchParams.get('code') ?? ''
  const token = await exchange({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    client_id: clientB,
    code_verifier: submit.verifier,
  })
  assert.equal(token.status, 400)
  assert.equal(token.body.error, 'invalid_grant')
})

test('unregistered redirect_uri gets an error page, never a redirect', async () => {
  const clientId = await registerTestClient()
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: 'https://evil.example/cb',
    code_challenge: pkce().challenge,
    code_challenge_method: 'S256',
  })
  const res = await fetch(`${srv.url}/authorize?${q}`, { redirect: 'manual' })
  assert.equal(res.status, 400)
  assert.equal(res.headers.get('location'), null)
})

test('malformed API key is rejected on the form', async () => {
  const clientId = await registerTestClient()
  const submit = await runAuthorizeFlow(clientId, 'not-a-key')
  assert.equal(submit.status, 401)
  assert.match(submit.body, /does not look like/)
})

test('registration rejects non-https redirect URIs', async () => {
  const res = await fetch(`${srv.url}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['http://evil.example/cb'] }),
  })
  assert.equal(res.status, 400)
})

test('/mcp: raw sk_ bearer key is accepted, garbage and missing tokens are not', async () => {
  const ok = await callTool(srv.url, 'check_credits', {}, 'sk_live_direct_key')
  assert.equal(ok.isError, false)

  const garbage = await fetch(`${srv.url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer pmat_tampered',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  })
  assert.equal(garbage.status, 401)
  assert.match(garbage.headers.get('www-authenticate') ?? '', /resource_metadata=/)

  const missing = (await rpc(srv.url, 'tools/list', {})) as { error?: { message?: string } }
  assert.match(missing.error?.message ?? '', /Unauthorized/)
})
