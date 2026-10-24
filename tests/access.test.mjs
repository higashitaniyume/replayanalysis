import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveClientIp } from '../dist/access.js'

test('access log resolves the forwarded client IP and keeps the socket IP', () => {
  const result = resolveClientIp({
    'x-forwarded-for': '203.0.113.7, 10.0.0.2',
    'x-real-ip': '198.51.100.4',
  }, '::ffff:10.0.0.9')
  assert.equal(result.ip, '203.0.113.7')
  assert.equal(result.socketIp, '10.0.0.9')
  assert.equal(result.forwardedFor, '203.0.113.7, 10.0.0.2')
})

test('access log falls back to real IP, Cloudflare IP, then socket', () => {
  assert.equal(resolveClientIp({ 'x-real-ip': '198.51.100.4' }, '10.0.0.9').ip, '198.51.100.4')
  assert.equal(resolveClientIp({ 'cf-connecting-ip': '192.0.2.8' }, '10.0.0.9').ip, '192.0.2.8')
  assert.equal(resolveClientIp({}, '::ffff:127.0.0.1').ip, '127.0.0.1')
  assert.equal(resolveClientIp({}, undefined).ip, 'unknown')
})
