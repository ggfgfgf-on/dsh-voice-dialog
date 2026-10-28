import assert from 'node:assert/strict'
import test from 'node:test'
import { SentenceSegmenter } from '../lib/segmenter.js'

test('splits Chinese and English terminal punctuation', () => {
  const s = new SentenceSegmenter()
  assert.deepEqual(s.feed('你好。'), ['你好。'])
  assert.deepEqual(s.feed('世界! Next?'), ['世界!', 'Next?'])
  assert.deepEqual(s.flush(), [])
})

test('keeps markdown fences out of speech', () => {
  const s = new SentenceSegmenter()
  assert.deepEqual(s.feed('说明：\n```ts\nconst x = 1\n```\n结束。'), ['说明：', '结束。'])
})

test('flushes a partial final sentence', () => {
  const s = new SentenceSegmenter()
  assert.deepEqual(s.feed('没有句号'), [])
  assert.deepEqual(s.flush(), ['没有句号'])
})

test('splits a long unpunctuated run at a natural separator', () => {
  const s = new SentenceSegmenter({ maxSentenceChars: 20 })
  const out = s.feed('这是一个很长的句子，但是一直没有结束也没有标点')
  assert.ok(out.length >= 1)
  assert.ok(out[0].length > 0)
})
