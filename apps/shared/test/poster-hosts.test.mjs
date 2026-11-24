import assert from 'node:assert/strict'
import test from 'node:test'
import { isPosterImageUrl, isPosterRequestAllowed } from '../src/index.ts'

test('只允许 https 的白名单主机', () => {
  assert.equal(isPosterImageUrl('https://t.vndb.org/cv/1.jpg'), true)
  assert.equal(isPosterImageUrl('http://t.vndb.org/cv/1.jpg'), false)
  assert.equal(isPosterImageUrl('https://t.vndb.org.example.com/1.jpg'), false)
  assert.equal(isPosterImageUrl('https://user@t.vndb.org/1.jpg'), false)
  assert.equal(
    isPosterRequestAllowed({ method: 'GET', url: 'https://example.com/', headers: {}, body: null }),
    false,
  )
})
