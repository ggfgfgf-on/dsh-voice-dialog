import assert from 'node:assert/strict'
import test from 'node:test'
import { CHUNK_PAUSE_MS, chunkRawSegments } from '../lib/chunker.js'

const seg = (text, at, lane = 'owner', canonical = '我') => ({ text, at, lane, canonical })

test('chunker: consecutive segments from one speaker merge into one chunk', () => {
  const chunks = chunkRawSegments([seg('我', 0), seg('觉得', 300), seg('可以', 600)])
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].text, '我觉得可以')
  assert.equal(chunks[0].segments, 3)
  assert.equal(chunks[0].from, 0)
  assert.equal(chunks[0].to, 600)
})

test('chunker: a pause longer than the window starts a new chunk', () => {
  const chunks = chunkRawSegments([seg('第一句', 0), seg('第二句', CHUNK_PAUSE_MS + 1)])
  assert.equal(chunks.length, 2)
  assert.deepEqual(chunks.map((chunk) => chunk.text), ['第一句', '第二句'])
})

test('chunker: a different speaker or lane starts a new chunk', () => {
  const a = chunkRawSegments([seg('我说', 0), seg('他说', 100, 'guest', '客人1')])
  assert.equal(a.length, 2)
  assert.deepEqual(a.map((chunk) => chunk.canonical), ['我', '客人1'])
  const b = chunkRawSegments([seg('我说', 0), seg('客人插话', 100, 'guest', '我')])
  assert.equal(b.length, 2, 'the lane alone is enough to split')
})

test('chunker: by default nothing is split inside a chunk', () => {
  const chunks = chunkRawSegments([seg('这是一句，有逗号，也有句号。还是同一块', 0)])
  assert.equal(chunks.length, 1, 'commas must not become separate blocks')
  assert.equal(chunks[0].text, '这是一句，有逗号，也有句号。还是同一块')
})

test('chunker: an optional cap splits at sentence punctuation only when asked', () => {
  const hard = chunkRawSegments([seg('一句话。第二句话。第三句', 0)], { maxChars: 4 })
  assert.equal(hard.length, 1, 'without splitOnPunctuation the cap is not enforced by cutting')
  const soft = chunkRawSegments([seg('一句话。第二句话。第三句', 0)], { maxChars: 4, splitOnPunctuation: true })
  assert.ok(soft.length > 1)
  assert.equal(soft[0].text, '一句话。')
})

test('chunker: empty segments are dropped, not turned into empty chunks', () => {
  assert.deepEqual(chunkRawSegments([]), [])
  assert.deepEqual(chunkRawSegments([seg('   ', 0)]), [])
})
