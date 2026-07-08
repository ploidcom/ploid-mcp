process.env.MCP_TOKEN_SECRET = 'test-secret'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { seal, sha256base64url, unseal } from '../src/seal.js'

test('seal/unseal round trip', () => {
  const token = seal({ t: 'at', k: 'sk_live_abc', n: 42 }, 'px_')
  assert.ok(token.startsWith('px_'))
  assert.deepEqual(unseal(token, 'px_'), { t: 'at', k: 'sk_live_abc', n: 42 })
})

test('payload is not readable from the token', () => {
  const token = seal({ k: 'sk_live_supersecret' }, 'px_')
  assert.ok(!token.includes('supersecret'))
  assert.ok(!Buffer.from(token.slice(3), 'base64url').toString('latin1').includes('supersecret'))
})

test('wrong prefix returns null', () => {
  const token = seal({ a: 1 }, 'px_')
  assert.equal(unseal(token, 'py_'), null)
})

test('tampered token returns null', () => {
  const token = seal({ a: 1 }, 'px_')
  const tampered = token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA')
  assert.equal(unseal(tampered, 'px_'), null)
})

test('garbage returns null', () => {
  assert.equal(unseal('px_not-base64-!!!', 'px_'), null)
  assert.equal(unseal('px_', 'px_'), null)
  assert.equal(unseal('', 'px_'), null)
})

test('expired payload returns null, future exp survives', () => {
  const past = seal({ a: 1, exp: Math.floor(Date.now() / 1000) - 5 }, 'px_')
  assert.equal(unseal(past, 'px_'), null)
  const future = seal({ a: 1, exp: Math.floor(Date.now() / 1000) + 60 }, 'px_')
  assert.ok(unseal(future, 'px_'))
})

test('sha256base64url matches PKCE S256 semantics', () => {
  // RFC 7636 appendix B test vector
  assert.equal(
    sha256base64url('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
  )
})
