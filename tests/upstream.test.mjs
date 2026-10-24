import assert from 'node:assert/strict'
import test from 'node:test'
import { replayUrl } from '../dist/upstream.js'

test('downloads directly from the official replay CDN for every server', () => {
  assert.equal(replayUrl('cnprod', '1789050904818899'), 'https://sereplaycn.feimogames.com/prod/1789050904818899')
  assert.equal(replayUrl('cndev', '1789050904818899'), 'https://sereplaycn.feimogames.com/dev/1789050904818899')
  assert.equal(replayUrl('jpprod', '1789050904818899'), 'https://sereplayjp.feimogames.com/prod/1789050904818899')
  assert.equal(replayUrl('jpdev', '1789050904818899'), 'https://sereplayjp.feimogames.com/dev/1789050904818899')
})
