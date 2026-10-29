import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildUtteranceRecord, createUtteranceTrace, latencyPreview, markUtteranceStage,
  noteUtteranceText, sanitizeLatencyRecord,
} from '../lib/latency.js'

function clockAt(start = 1000) {
  let now = start
  const clock = () => now
  clock.set = (value) => { now = value }
  clock.advance = (ms) => { now += ms }
  return clock
}

test('records every stage relative to the utterance end', () => {
  const clock = clockAt(1000)
  const trace = createUtteranceTrace({ sessionId: 's1', lane: 'owner' }, clock)
  markUtteranceStage(trace, 'utterance_end', clock)
  clock.set(1300); markUtteranceStage(trace, 'separation_done', clock)
  clock.set(1800); markUtteranceStage(trace, 'asr_done', clock)
  clock.set(1800); markUtteranceStage(trace, 'organize_start', clock)
  clock.set(2600); markUtteranceStage(trace, 'organize_done', clock)
  clock.set(2600); markUtteranceStage(trace, 'enqueue', clock)
  clock.set(3200); markUtteranceStage(trace, 'first_token', clock)
  clock.set(3900); markUtteranceStage(trace, 'play_start', clock)
  noteUtteranceText(trace, '  帮我  看看这个  ')
  const record = buildUtteranceRecord(trace, { organizerAction: 'queue', fastPath: true }, clock)
  assert.equal(record.kind, 'utterance')
  assert.equal(record.sessionId, 's1')
  assert.equal(record.lane, 'owner')
  assert.equal(record.textLength, 7)
  assert.equal(record.preview, '帮我 看看这个')
  assert.deepEqual(record.stagesMs, {
    utterance_end: 0,
    separation_done: 300,
    asr_start: null,
    asr_done: 800,
    organize_start: 800,
    organize_done: 1600,
    enqueue: 1600,
    first_token: 2200,
    play_start: 2900,
  })
  assert.equal(record.totalMs, 2900)
  assert.equal(record.organizerAction, 'queue')
  assert.equal(record.fastPath, true)
  assert.equal(record.clamped, undefined)
})

test('missing stages stay null and never invent timings', () => {
  const clock = clockAt(500)
  const trace = createUtteranceTrace({ sessionId: 's2', lane: 'guest' }, clock)
  markUtteranceStage(trace, 'utterance_end', clock)
  markUtteranceStage(trace, 'enqueue', clock)
  const record = buildUtteranceRecord(trace, {}, clock)
  assert.equal(record.stagesMs.asr_done, null)
  assert.equal(record.stagesMs.organize_start, null)
  assert.equal(record.totalMs, 0)
})

test('the first mark wins for a repeated stage', () => {
  const clock = clockAt(1000)
  const trace = createUtteranceTrace({ sessionId: 's3', lane: 'owner' }, clock)
  markUtteranceStage(trace, 'utterance_end', clock)
  clock.set(1100); markUtteranceStage(trace, 'asr_done', clock)
  clock.set(1900); markUtteranceStage(trace, 'asr_done', clock)
  assert.equal(trace.marks.asr_done, 1100)
})

test('concurrent stages keep their own timestamps instead of being forced backwards', () => {
  const clock = clockAt(1000)
  const trace = createUtteranceTrace({ sessionId: 's4', lane: 'owner' }, clock)
  markUtteranceStage(trace, 'utterance_end', clock)
  clock.set(1500); markUtteranceStage(trace, 'separation_done', clock)
  clock.set(1200); markUtteranceStage(trace, 'asr_done', clock)
  const record = buildUtteranceRecord(trace, {}, clock)
  assert.equal(record.stagesMs.separation_done, 500)
  assert.equal(record.stagesMs.asr_done, 200)
  assert.equal(record.clamped, undefined, 'honest numbers, nothing to clamp')
})

test('the optimistic enqueue is recorded before the organizer answers', () => {
  const clock = clockAt(1000)
  const trace = createUtteranceTrace({ sessionId: 's6', lane: 'owner' }, clock)
  markUtteranceStage(trace, 'utterance_end', clock)
  clock.set(1900); markUtteranceStage(trace, 'organize_start', clock)
  clock.set(1901); markUtteranceStage(trace, 'enqueue', clock)
  clock.set(2600); markUtteranceStage(trace, 'organize_done', clock)
  const record = buildUtteranceRecord(trace, { fastPath: true }, clock)
  assert.equal(record.stagesMs.enqueue, 901)
  assert.equal(record.stagesMs.organize_done, 1600)
  assert.equal(record.clamped, undefined)
  assert.equal(record.totalMs, 1600)
})

test('a mark before the utterance end is clamped to zero and flagged', () => {
  const clock = clockAt(1000)
  const trace = createUtteranceTrace({ sessionId: 's7', lane: 'owner' }, clock)
  markUtteranceStage(trace, 'utterance_end', clock)
  clock.set(900); markUtteranceStage(trace, 'separation_done', clock)
  const record = buildUtteranceRecord(trace, {}, clock)
  assert.equal(record.stagesMs.separation_done, 0)
  assert.equal(record.clamped, true)
})

test('preview keeps twenty printable characters and never audio', () => {
  assert.equal(latencyPreview('  一二三四五六七八九十一二三四五六七八九十多余  ').length, 20)
  assert.equal(latencyPreview('a\nb\tc'), 'a b c')
})

test('sanitizer keeps known fields, drops the rest and bounds text', () => {
  const clean = sanitizeLatencyRecord({
    kind: 'utterance',
    sessionId: 's5',
    preview: 'x'.repeat(80),
    textLength: 12,
    totalMs: 950,
    fastPath: true,
    retracted: false,
    stagesMs: { utterance_end: 0, separation_done: 300, asr_done: 'nope' },
    audio: 'AAAA',
    secret: 'nope',
  })
  assert.equal(clean.kind, 'utterance')
  assert.equal(clean.preview.length, 20)
  assert.equal(clean.textLength, 12)
  assert.equal(clean.fastPath, true)
  assert.equal(clean.audio, undefined)
  assert.equal(clean.secret, undefined)
  assert.equal(clean.stagesMs.separation_done, 300)
  assert.equal(clean.stagesMs.asr_done, null)
  assert.equal(clean.stagesMs.play_start, null)
})

test('sanitizer rejects records without a kind', () => {
  assert.equal(sanitizeLatencyRecord(null), null)
  assert.equal(sanitizeLatencyRecord('x'), null)
  assert.equal(sanitizeLatencyRecord({ sessionId: 's' }), null)
})


test('the four waits add up to the enqueue time', () => {
  const clock = clockAt(10_000)
  // speech ends at 10_000; the VAD waits 900 ms of tail before closing the utterance.
  const trace = createUtteranceTrace({ sessionId: 's8', lane: 'owner', startedAt: 10_900 }, clock)
  markUtteranceStage(trace, 'utterance_end', () => 10_900)
  const record = buildUtteranceRecord(trace, {
    timing: {
      speechEndAt: 10_000,
      separationDoneAt: 11_000,
      asrStartAt: 11_120,
      asrDoneAt: 11_520,
      asrInferMs: 210,
    },
  }, clock)
  assert.equal(record.stagesMs.utterance_end, 900)
  assert.equal(record.stagesMs.separation_done, 1000)
  assert.equal(record.stagesMs.asr_start, 1120)
  assert.equal(record.stagesMs.asr_done, 1520)
  assert.equal(record.endpointWaitMs, 900)
  assert.equal(record.separationWaitMs, 100)
  assert.equal(record.asrQueueMs, 120)
  assert.equal(record.asrWallMs, 400)
  assert.equal(record.asrInferMs, 210)
  assert.equal(record.asrTransportMs, 190)
  assert.equal(record.decomposedMs, 1520)
  assert.equal(record.residualMs, 0, 'the split must explain the enqueue time')
})

test('fast path records concurrent gate and ASR without double counting', () => {
  const clock = clockAt(10_000)
  const trace = createUtteranceTrace({ sessionId: 's10', lane: 'owner', startedAt: 10_900 }, clock)
  markUtteranceStage(trace, 'utterance_end', () => 10_900)
  markUtteranceStage(trace, 'separation_done', () => 10_965)
  markUtteranceStage(trace, 'asr_start', () => 10_905)
  markUtteranceStage(trace, 'asr_done', () => 11_080)
  markUtteranceStage(trace, 'enqueue', () => 11_080)
  const record = buildUtteranceRecord(trace, {
    fastPath: true,
    timing: {
      speechEndAt: 10_000,
      separationDoneAt: 10_965,
      asrStartAt: 10_905,
      asrDoneAt: 11_080,
      asrInferMs: 70,
      separation: {
        mode: 'fast', gateReason: 'same-voice', modelCalls: 0,
        wallMs: 60, selfSimilarity: 0.81, ownerSimilarity: 0.77,
      },
    },
  }, clock)
  assert.equal(record.separationMode, 'fast')
  assert.equal(record.separationGate, 'same-voice')
  assert.equal(record.separationSelfSimilarity, 0.81)
  assert.equal(record.separationWaitMs, 65)
  assert.equal(record.asrQueueMs, 0)
  assert.equal(record.decomposedMs, 1080, 'endpoint + max(gate, asr), not their sum')
  assert.equal(record.residualMs, 0)
})

test('a provider that reports no inference time still records the wall time', () => {
  const clock = clockAt(1000)
  const trace = createUtteranceTrace({ sessionId: 's9', lane: 'owner' }, clock)
  markUtteranceStage(trace, 'utterance_end', clock)
  const record = buildUtteranceRecord(trace, {
    timing: { asrStartAt: 1000, asrDoneAt: 1400 },
  }, clock)
  assert.equal(record.asrWallMs, 400)
  assert.equal(record.asrTransportMs, undefined)
  assert.equal(record.decomposedMs, undefined)
})