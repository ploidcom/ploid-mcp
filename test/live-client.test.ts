// Live mode against a fake Ploid API implementing the documented contract
// (docs/openapi.yaml): envelope, error shapes, key forwarding.
process.env.AUTH_MODE = 'dev'
process.env.PLOID_MODE = 'live'

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo, Server } from 'node:net'
import { after, before, test } from 'node:test'
import { callTool, startServer } from './helpers.js'
import type { TestServer } from './helpers.js'

let srv: TestServer
let fakePloid: Server
/** Captures what the fake upstream received, per path. */
const seen: Record<string, { headers: Record<string, string | string[] | undefined>; body: unknown }> = {}

before(async () => {
  fakePloid = createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => (raw += c.toString()))
    req.on('end', () => {
      seen[req.url ?? ''] = { headers: req.headers, body: raw ? JSON.parse(raw) : undefined }
      const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers })
        res.end(JSON.stringify(payload))
      }
      switch (req.url) {
        case '/v1/people/search':
          return send(200, {
            data: [
              {
                id: 'per_live1',
                name: 'Live Person',
                headline: 'CTO at LiveCo',
                company: 'LiveCo',
                linkedin_url: 'https://linkedin.com/in/liveperson',
                profile_url: 'https://ploid.com/p/per_live1',
              },
            ],
            meta: { request_id: 'req_1', total: 137, credits_charged: 3, remaining_credits: 97 },
          })
        case '/v1/people/lookup':
          return send(200, { data: null, meta: { request_id: 'req_2' } })
        case '/v1/people/enrich':
          return send(402, {
            error: {
              code: 'insufficient_credits',
              message: 'Out of credits.',
              request_id: 'req_3',
              available_credits: 0,
              required_credits: 10,
            },
          })
        case '/v1/account/credits':
          return send(
            429,
            { error: { code: 'rate_limited', message: 'Slow down.', request_id: 'req_4', retry_after_seconds: 12 } },
            { 'retry-after': '12' }
          )
        default:
          return send(404, { error: { code: 'not_found', message: 'Unknown route' } })
      }
    })
  })
  await new Promise<void>((resolve) => fakePloid.listen(0, resolve))
  process.env.PLOID_API_BASE_URL = `http://localhost:${(fakePloid.address() as AddressInfo).port}`
  srv = await startServer()
})

after(async () => {
  await srv.close()
  await new Promise((resolve) => fakePloid.close(resolve))
})

const KEY = 'sk_live_e2e_key'

test('search: natural mode, min page size 25, envelope unwrapped, credits surfaced', async () => {
  const res = await callTool(srv.url, 'search_people', { query: 'ctos', limit: 5 }, KEY)
  assert.equal(res.isError, false)
  const upstream = seen['/v1/people/search']
  assert.equal(upstream.headers['x-api-key'], KEY, 'bearer key forwarded as x-api-key')
  assert.deepEqual(upstream.body, { mode: 'natural', query: 'ctos', page: { size: 25 } })
  assert.equal(res.payload.total_matches, 137)
  assert.equal(res.payload.credits_charged, 3)
  assert.equal(res.payload.remaining_credits, 97)
  const person = (res.payload.results as Array<Record<string, unknown>>)[0]
  assert.ok(String(person.person_id).startsWith('pld_'))
  assert.ok(!('id' in person), 'raw upstream id must not leak')
})

test('lookup data:null maps to a not_found tool error', async () => {
  const search = await callTool(srv.url, 'search_people', { query: 'ctos' }, KEY)
  const personId = (search.payload.results as Array<{ person_id: string }>)[0].person_id
  const res = await callTool(srv.url, 'get_person_profile', { person_id: personId }, KEY)
  assert.equal(res.isError, true)
  assert.equal(res.payload.error, 'not_found')
  // The lookup was identified by the fields packed into the person_id token.
  const upstream = seen['/v1/people/lookup'].body as Record<string, unknown>
  assert.equal(upstream.name, 'Live Person')
  assert.equal(upstream.company, 'LiveCo')
  assert.equal(upstream.linkedin_url, 'https://linkedin.com/in/liveperson')
})

test('402 maps to insufficient_credits with credit details', async () => {
  const search = await callTool(srv.url, 'search_people', { query: 'ctos' }, KEY)
  const personId = (search.payload.results as Array<{ person_id: string }>)[0].person_id
  const res = await callTool(srv.url, 'reveal_contact', { person_id: personId, channels: ['mobile_phone'] }, KEY)
  assert.equal(res.isError, true)
  assert.equal(res.payload.error, 'insufficient_credits')
  assert.equal(res.payload.available_credits, 0)
  assert.equal(res.payload.required_credits, 10)
  assert.equal(res.payload.request_id, 'req_3')
  assert.match(String(res.payload.message), /Do not retry/)
  const upstream = seen['/v1/people/enrich'].body as Record<string, unknown>
  assert.deepEqual(upstream.fields, ['mobile_phone'])
  assert.equal(upstream.person_id, 'per_live1')
})

test('429 maps to rate_limited with retry_after_seconds', async () => {
  const res = await callTool(srv.url, 'check_credits', {}, KEY)
  assert.equal(res.isError, true)
  assert.equal(res.payload.error, 'rate_limited')
  assert.equal(res.payload.retry_after_seconds, 12)
})

test('no key anywhere yields an unauthorized tool error', async () => {
  delete process.env.PLOID_API_KEY
  const res = await callTool(srv.url, 'search_people', { query: 'anyone' })
  assert.equal(res.isError, true)
  assert.equal(res.payload.error, 'unauthorized')
})
