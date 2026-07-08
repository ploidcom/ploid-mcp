import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodePersonId, encodePersonId } from '../src/ploid/ids.js'

test('encode/decode round trip', () => {
  const ref = {
    id: 'per_123',
    name: 'Ana Novak',
    company: 'Brightpath',
    linkedinUrl: 'https://www.linkedin.com/in/ana',
  }
  const token = encodePersonId(ref)
  assert.ok(token.startsWith('pld_'))
  assert.deepEqual(decodePersonId(token), ref)
})

test('optional fields survive as undefined', () => {
  const token = encodePersonId({ name: 'Solo Name' })
  assert.deepEqual(decodePersonId(token), {
    id: undefined,
    name: 'Solo Name',
    company: undefined,
    linkedinUrl: undefined,
  })
})

test('non-ASCII names round trip', () => {
  const token = encodePersonId({ name: 'Tomás Herrera-Ðorđević 王' })
  assert.equal(decodePersonId(token)?.name, 'Tomás Herrera-Ðorđević 王')
})

test('garbage inputs decode to null', () => {
  assert.equal(decodePersonId('per_raw_ploid_id'), null)
  assert.equal(decodePersonId('pld_!!!not-base64'), null)
  assert.equal(decodePersonId('pld_' + Buffer.from('"just a string"').toString('base64url')), null)
  assert.equal(decodePersonId('pld_' + Buffer.from('[null,null]').toString('base64url')), null)
  assert.equal(decodePersonId(''), null)
})
