import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError, parseQuery, resolveServer } from '../dist/query.js'

test('query defaults to cnprod and rejects malformed ids', () => {
  assert.deepEqual(parseQuery(new URLSearchParams('id=1789050904818899')), {
    id: '1789050904818899',
    server: 'cnprod',
    includeFrames: false,
  })
  assert.throws(() => parseQuery(new URLSearchParams('')), (error) => error instanceof ApiError && error.status === 400)
  assert.throws(() => parseQuery(new URLSearchParams('id=abc')), /id 必须是/)
  assert.throws(() => parseQuery(new URLSearchParams(`id=${'1'.repeat(33)}`)), /id 必须是/)
})

test('server aliases resolve to the four replay CDNs', () => {
  assert.equal(resolveServer(null), 'cnprod')
  assert.equal(resolveServer('3'), 'cnprod')
  assert.equal(resolveServer('jp'), 'jpprod')
  assert.equal(resolveServer('JPPROD'), 'jpprod')
  assert.throws(() => resolveServer('korea'), /server 只能是/)
})

test('includeFrames only accepts explicit truthy values', () => {
  assert.equal(parseQuery(new URLSearchParams('id=1&includeFrames=1')).includeFrames, true)
  assert.equal(parseQuery(new URLSearchParams('id=1&includeFrames=true')).includeFrames, true)
  assert.equal(parseQuery(new URLSearchParams('id=1&includeFrames=0')).includeFrames, false)
})
