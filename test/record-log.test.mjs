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
