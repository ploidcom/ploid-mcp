// Dev mode + mock data: the default local configuration.
process.env.AUTH_MODE = 'dev'
process.env.PLOID_MODE = 'mock'

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { callTool, rpc, startServer } from './helpers.js'
import type { TestServer } from './helpers.js'

let srv: TestServer

before(async () => {
  srv = await startServer()
})
after(async () => {
  await srv.close()
})

test('tools/list exposes exactly the six tools', async () => {
  const res = (await rpc(srv.url, 'tools/list', {})) as {
    result: { tools: Array<{ name: string; annotations?: Record<string, unknown> }> }
  }
  const names = res.result.tools.map((t) => t.name)
  assert.deepEqual(names, ['search_people', 'get_person_profile', 'reveal_contact', 'check_credits', 'search', 'fetch'])

  const byName = Object.fromEntries(res.result.tools.map((t) => [t.name, t]))
  for (const readOnly of ['search_people', 'get_person_profile', 'check_credits', 'search', 'fetch']) {
    assert.equal(byName[readOnly].annotations?.readOnlyHint, true, `${readOnly} must be read-only`)
  }
  assert.equal(byName.reveal_contact.annotations?.readOnlyHint, false, 'reveal_contact must NOT be read-only')
})

test('search -> profile -> reveal chain works end to end', async () => {
  const search = await callTool(srv.url, 'search_people', { query: 'fintech engineering Slovenia', limit: 3 })
  assert.equal(search.isError, false)
  assert.ok(typeof search.payload.notice === 'string', 'search results carry the untrusted-content notice')
  const results = search.payload.results as Array<{ person_id: string; name: string }>
  assert.ok(results.length > 0)
  assert.equal(results[0].name, 'Ana Novak')
  assert.ok(typeof search.payload.credits_charged === 'number')

  const personId = results[0].person_id
  const profile = await callTool(srv.url, 'get_person_profile', { person_id: personId })
  assert.equal(profile.isError, false)
  const p = profile.payload.profile as Record<string, unknown>
  assert.equal(p.name, 'Ana Novak')
  assert.equal(p.person_id, personId)
  assert.ok(!('id' in p), 'raw Ploid id must not leak into tool results')

  const reveal = await callTool(srv.url, 'reveal_contact', { person_id: personId, channels: ['work_email'] })
  assert.equal(reveal.isError, false)
  const revealed = reveal.payload.revealed as Record<string, { status: string; value: string | null }>
  assert.equal(revealed.work_email.status, 'found')
  assert.ok(revealed.work_email.value?.includes('@'))
  assert.equal(reveal.payload.credits_charged, 1)
})

test('reveal bills per channel and never bills missing fields', async () => {
  const search = await callTool(srv.url, 'search_people', { query: 'Tomás Herrera Verdania' })
  const personId = (search.payload.results as Array<{ person_id: string }>)[0].person_id
  // Tomás has work_email (1) + personal_email (3) but no mobile_phone (10, unbilled).
  const reveal = await callTool(srv.url, 'reveal_contact', {
    person_id: personId,
    channels: ['work_email', 'personal_email', 'mobile_phone'],
  })
  assert.equal(reveal.isError, false)
  const revealed = reveal.payload.revealed as Record<string, { status: string }>
  assert.equal(revealed.mobile_phone.status, 'not_found')
  assert.equal(reveal.payload.credits_charged, 4)
})

test('invalid person_id returns a model-actionable error result', async () => {
  const res = await callTool(srv.url, 'get_person_profile', { person_id: 'per_raw_id_from_nowhere' })
  assert.equal(res.isError, true)
  assert.equal(res.payload.error, 'invalid_request')
  assert.match(String(res.payload.message), /re-run a search/)
})

test('unknown person returns not_found guidance', async () => {
  const validButUnknown = 'pld_' + Buffer.from(JSON.stringify([null, 'Nobody Here', null, null])).toString('base64url')
  const res = await callTool(srv.url, 'reveal_contact', { person_id: validButUnknown })
  assert.equal(res.isError, true)
  assert.equal(res.payload.error, 'not_found')
})

test('check_credits returns the balance', async () => {
  const res = await callTool(srv.url, 'check_credits', {})
  assert.equal(res.isError, false)
  assert.equal((res.payload.credits as Record<string, unknown>).balance_credits, 420)
})

test('ChatGPT compat: search returns {results:[{id,title,url}]}', async () => {
  const res = await callTool(srv.url, 'search', { query: 'machine learning san francisco' })
  assert.equal(res.isError, false)
  const results = res.payload.results as Array<Record<string, string>>
  assert.ok(results.length > 0)
  assert.deepEqual(Object.keys(results[0]).sort(), ['id', 'title', 'url'])
  assert.match(results[0].title, /Priya Raghavan/)
})

test('ChatGPT compat: fetch returns a full record by search id', async () => {
  const search = await callTool(srv.url, 'search', { query: 'backend engineer ploid' })
  const id = (search.payload.results as Array<{ id: string }>)[0].id
  const res = await callTool(srv.url, 'fetch', { id })
  assert.equal(res.isError, false)
  for (const key of ['id', 'title', 'text', 'url', 'metadata']) assert.ok(key in res.payload, `fetch result has ${key}`)
  assert.match(String(res.payload.text), /UNTRUSTED/)
})

test('GET and DELETE /mcp are rejected (stateless server)', async () => {
  for (const method of ['GET', 'DELETE']) {
    const res = await fetch(`${srv.url}/mcp`, { method })
    assert.equal(res.status, 405)
  }
})

test('invalid JSON body is a 400 parse error', async () => {
  const res = await fetch(`${srv.url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not json{',
  })
  assert.equal(res.status, 400)
})

test('healthz is up', async () => {
  const res = await fetch(`${srv.url}/healthz`)
  assert.equal(res.status, 200)
})
