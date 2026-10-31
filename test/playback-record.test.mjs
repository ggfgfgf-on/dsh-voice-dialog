import test from 'node:test'
import assert from 'node:assert/strict'
import { createPlaybackRecorder, playbackTransition } from '../lib/playback-record.js'
import { createRecordStream } from '../lib/record-stream.js'

test('playback: only a phase change is a transition', () => {
  assert.deepEqual(playbackTransition(undefined, 'playing'), { phase: 'playing', changed: true })
  assert.deepEqual(playbackTransition('playing', 'playing'), { phase: 'playing', changed: false })
  assert.deepEqual(playbackTransition('playing', 'idle'), { phase: 'idle', changed: true })
  assert.equal(playbackTransition('playing', 'singing'), null)
  assert.equal(playbackTransition(undefined, ''), null)
})

test('playback: the heartbeat does not flood the record stream', () => {
  const stream = createRecordStream({ capacity: 32 })
  const recorder = createPlaybackRecorder(stream)
  assert.equal(recorder.note('s1', 'playing'), true)
  assert.equal(recorder.note('s1', 'playing'), false)
  assert.equal(recorder.note('s1', 'playing'), false)
  assert.equal(recorder.note('s1', 'idle'), true)
  assert.equal(stream.tail().length, 2)
  assert.deepEqual(stream.tail().map((event) => event.kind), ['playback', 'playback'])
  assert.deepEqual(stream.tail().map((event) => event.phase), ['playing', 'idle'])
})

test('playback: sessions are tracked separately and can be forgotten', () => {
  const stream = createRecordStream({ capacity: 32 })
  const recorder = createPlaybackRecorder(stream)
  recorder.note('a', 'playing')
  recorder.note('b', 'playing')
  assert.equal(stream.tail().length, 2, 'a heartbeat on another session is not a duplicate')
  recorder.reset('a')
  assert.equal(recorder.lastPhase('a'), undefined)
  assert.equal(recorder.lastPhase('b'), 'playing')
  recorder.reset()
  assert.equal(recorder.lastPhase('b'), undefined)
})

test('voiceprint: a label is its own record, with confidence', () => {
  const stream = createRecordStream({ capacity: 16 })
  stream.append('voiceprint', {
    label: '我', speaker: 'owner', confidence: 0.71, owner: true, enrolled: true,
  })
  const [event] = stream.tail(1)
  assert.equal(event.kind, 'voiceprint')
  assert.equal(event.label, '我')
  assert.equal(event.speaker, 'owner')
  assert.equal(event.confidence, 0.71)
  // The stream owns seq/at/kind: a caller cannot forge them.
  const forged = stream.append('voiceprint', { seq: 999, at: 1, kind: 'transcript', label: 'x' })
  assert.equal(forged.seq, 2)
  assert.equal(forged.kind, 'voiceprint')
})
