import test from 'node:test'
import assert from 'node:assert/strict'
import {
  RECORD_LABEL_LIMIT, RECORD_LOG_PATH, RECORD_LOG_ROUTES, RECORD_TEXT_LIMIT, sanitizeRecordEvent,
} from '../lib/record-log.js'
import { createRecordStream } from '../lib/record-stream.js'

test('record log: the route the page posts to is exported', () => {
  assert.deepEqual(RECORD_LOG_ROUTES.map(([route]) => route), ['/record-log'])
  assert.ok(RECORD_LOG_PATH.endsWith('dsh-voice-record.jsonl'))
  assert.equal(RECORD_TEXT_LIMIT, 40)
})

test('record log: only whitelisted fields survive', () => {
  const item = sanitizeRecordEvent({
    sessionId: 'session-1', seq: 7, at: 1000, kind: 'transcript', lane: 'owner',
    canonical: '我', text: '帮我看一下报告', reason: 'arrived',
    audio: 'AAAA', prompt: 'system prompt', samples: [1, 2, 3],
  })
  assert.deepEqual(item, {
    sessionId: 'session-1', seq: 7, at: 1000, kind: 'transcript', lane: 'owner',
    canonical: '我', text: '帮我看一下报告', reason: 'arrived',
  })
})

test('record log: text is a snippet, never the paragraph', () => {
  const long = '啊'.repeat(200)
  assert.equal(sanitizeRecordEvent({ kind: 'transcript', text: long }).text.length, RECORD_TEXT_LIMIT)
  assert.equal(
    sanitizeRecordEvent({ kind: 'transcript', canonical: '名'.repeat(80) }).canonical.length,
    RECORD_LABEL_LIMIT,
  )
})

test('record log: unknown kinds, unknown lanes and junk are dropped', () => {
  assert.equal(sanitizeRecordEvent({ kind: 'audio', text: 'x' }), null)
  assert.equal(sanitizeRecordEvent({ text: 'no kind' }), null)
  assert.equal(sanitizeRecordEvent(null), null)
  assert.equal(sanitizeRecordEvent({ kind: 'transcript', lane: 'boss' }).lane, '')
  assert.equal(sanitizeRecordEvent({ kind: 'plan', seq: -4 }).seq, 0)
})

test('record log: the batch can supply the session id', () => {
  assert.equal(sanitizeRecordEvent({ kind: 'plan' }, 'session-9').sessionId, 'session-9')
  assert.equal(sanitizeRecordEvent({ kind: 'plan', sessionId: 'own' }, 'session-9').sessionId, 'own')
})

test('record log: a voiceprint keeps its confidence and enrolment flags', () => {
  const item = sanitizeRecordEvent({
    kind: 'voiceprint', lane: 'owner', canonical: '我', speaker: '我',
    confidence: 0.873, owner: true, enrolled: true,
    audio: 'AAAA', embedding: [0.1, 0.2],
  })
  assert.equal(item.confidence, 0.873)
  assert.equal(item.owner, true)
  assert.equal(item.enrolled, true)
  assert.equal(item.speaker, '我')
  assert.equal('audio' in item, false)
  assert.equal('embedding' in item, false)
  // Out of range is clamped, wrong types are dropped rather than coerced.
  assert.equal(sanitizeRecordEvent({ kind: 'voiceprint', confidence: 3 }).confidence, 1)
  assert.equal(sanitizeRecordEvent({ kind: 'voiceprint', confidence: -2 }).confidence, 0)
  assert.equal('confidence' in sanitizeRecordEvent({ kind: 'voiceprint', confidence: 'high' }), false)
  assert.equal('owner' in sanitizeRecordEvent({ kind: 'voiceprint', owner: 'yes' }), false)
})

test('record log: a separation outcome carries every source lane', () => {
  const item = sanitizeRecordEvent({
    kind: 'source', lane: 'owner', canonical: '我', separated: true, sources: 2,
    mode: 'full', elapsedMs: 412,
    lanes: [{ lane: 'owner', similarity: 0.71 }, { lane: 'guest', similarity: 0.32 }],
    audio: 'AAAA',
  })
  assert.equal(item.separated, true)
  assert.equal(item.sources, 2)
  assert.equal(item.mode, 'full')
  assert.equal(item.elapsedMs, 412)
  assert.deepEqual(item.lanes, [
    { lane: 'owner', similarity: 0.71 }, { lane: 'guest', similarity: 0.32 },
  ])
  assert.equal('audio' in item, false)
  // The list is bounded, and a forged lane name is not a lane.
  assert.equal(sanitizeRecordEvent({
    kind: 'source', lanes: [{ lane: 'a' }, { lane: 'b' }, { lane: 'c' }, { lane: 'd' }, { lane: 'e' }],
  }).lanes.length, 4)
  assert.equal('lanes' in sanitizeRecordEvent({ kind: 'source', lanes: [{ similarity: 0.5 }] }), false)
  assert.equal(sanitizeRecordEvent({ kind: 'source', sources: 99 }).sources, 16)
})

test('record log: an event without the new detail stays exactly as before', () => {
  const plain = sanitizeRecordEvent({ kind: 'transcript', lane: 'owner', text: '一句' })
  assert.deepEqual(Object.keys(plain), ['sessionId', 'seq', 'at', 'kind', 'lane', 'canonical', 'text', 'reason'])
})

test('record log: a throwing sink never reaches the caller', () => {
  const flushed = []
  const stream = createRecordStream({
    sink: (lines) => { flushed.push(lines.length); throw new Error('disk full') },
    flushMs: 1,
  })
  assert.doesNotThrow(() => stream.append('transcript', { text: '一句' }))
  stream.flush()
  assert.deepEqual(flushed, [1])
})
