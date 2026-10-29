import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FAST_LANE_GAP_MS, FAST_LANE_MAX_LINES, FAST_LANE_MIN_CHARS, FAST_LANE_MIN_SILENT_MS,
  FastLaneServo, buildFastLanePrompt, buildServoPrompt, fastLaneDelay, parseFastLaneAnswer,
  shouldRunFastLane, shouldServe, spokenMs,
} from '../lib/fast-lane.js'

test('the fast lane waits for a real silence before the first line', () => {
  const base = { reasoningChars: FAST_LANE_MIN_CHARS, spoken: 0, inFlight: false }
  assert.equal(shouldRunFastLane({ ...base, silentMs: FAST_LANE_MIN_SILENT_MS - 1 }), false)
  assert.equal(shouldRunFastLane({ ...base, silentMs: FAST_LANE_MIN_SILENT_MS }), true)
  // Short reasoning is not a decision yet.
  assert.equal(shouldRunFastLane({ ...base, silentMs: 9000, reasoningChars: FAST_LANE_MIN_CHARS - 1 }), false)
})

test('later lines need a longer gap, and the cap ends the lane', () => {
  assert.equal(fastLaneDelay(0), FAST_LANE_MIN_SILENT_MS)
  assert.equal(fastLaneDelay(1), FAST_LANE_GAP_MS)
  const second = { reasoningChars: 400, spoken: 1, inFlight: false }
  assert.equal(shouldRunFastLane({ ...second, silentMs: FAST_LANE_MIN_SILENT_MS }), false)
  assert.equal(shouldRunFastLane({ ...second, silentMs: FAST_LANE_GAP_MS }), true)
  assert.equal(shouldRunFastLane({ ...second, spoken: FAST_LANE_MAX_LINES, silentMs: 60000 }), false)
})

test('a stop command, a running request or a disabled lane never speak', () => {
  const ready = { reasoningChars: 400, silentMs: 60000, spoken: 0, inFlight: false }
  assert.equal(shouldRunFastLane({ ...ready, directed: true }), false)
  assert.equal(shouldRunFastLane({ ...ready, inFlight: true }), false)
  assert.equal(shouldRunFastLane({ ...ready, enabled: false }), false)
  assert.equal(shouldRunFastLane(ready), true)
})

test('the prompt carries the reasoning tail and asks for one JSON line', () => {
  const prompt = buildFastLanePrompt('A'.repeat(50) + '构建已通过，但启动还是慢')
  assert.ok(prompt.includes('构建已通过'))
  assert.ok(prompt.includes('{"say":'))
})

test('the answer is one short spoken line, or silence', () => {
  assert.equal(parseFastLaneAnswer('{"say":"构建过了，启动还慢。"}'), '构建过了，启动还慢。')
  assert.equal(parseFastLaneAnswer('{"say":""}'), '')
  assert.equal(parseFastLaneAnswer('not json'), '')
  // Fillers are exactly what this lane must never add.
  assert.equal(parseFastLaneAnswer('{"say":"好的，稍等一下。"}'), '')
  assert.equal(parseFastLaneAnswer('{"say":"稍等，我看下日志。"}'), '')
  // Paths and identifiers cannot be read aloud.
  assert.equal(parseFastLaneAnswer('{"say":"看看 D:/work/a.ts 这个文件。"}'), '')
  assert.equal(parseFastLaneAnswer('{"say":"跑 npm run build 就行。"}'), '')
  // Over-long lines fall back to their first clause or to silence.
  assert.equal(parseFastLaneAnswer('{"say":"构建是通过了。但是启动还是很慢，还得再看看。"}'), '构建是通过了。')
  assert.equal(parseFastLaneAnswer('{"say":"' + '很长的句子'.repeat(12) + '"}'), '')
})

test('the servo refills just before the line runs out, not on a fixed beat', () => {
  const base = { unseenChars: 200, spoken: 1 }
  assert.equal(shouldServe({ ...base, lineEndsIn: 2000 }), false)
  assert.equal(shouldServe({ ...base, lineEndsIn: 1400 }), true)
  assert.equal(shouldServe({ ...base, unseenChars: 10, lineEndsIn: 0 }), false)
  assert.equal(shouldServe({ ...base, spoken: 8, lineEndsIn: 0 }), false)
  // A twenty-character line is a few seconds of audio, not a syllable.
  assert.ok(spokenMs('一二三四五六七八九十一二三四五六七八九十') > 5000)
})

test('the servo prompt carries the previous line so the next one connects', () => {
  const prompt = buildServoPrompt('构建是通过了，启动还慢', '先说构建。')
  assert.ok(prompt.includes('先说构建。'))
  assert.ok(prompt.includes('构建是通过了'))
  assert.ok(prompt.includes('{"say":'))
})

test('the servo speaks its first line only after a real quiet stretch', async () => {
  const said = []
  let calls = 0
  const servo = new FastLaneServo({
    startAt: Date.now(),
    call: async () => { calls += 1; return '{"say":"构建是通过了。"}' },
    say: (line) => said.push(line),
  })
  servo.push('思考'.repeat(40))
  assert.equal(said.length, 0)
  await new Promise((resolve) => setTimeout(resolve, 1600))
  assert.deepEqual(said, ['构建是通过了。'])
  assert.equal(calls, 1)
  servo.stop('test')
})

test('after speaking, the servo stays quiet until the line nears its end', async () => {
  const said = []
  let calls = 0
  const servo = new FastLaneServo({
    startAt: Date.now(),
    call: async () => { calls += 1; return '{"say":"第二句接上。"}' },
    say: (line) => said.push(line),
  })
  servo.push('思考'.repeat(40))
  await new Promise((resolve) => setTimeout(resolve, 1600))
  assert.equal(said.length, 1)
  // Fresh reasoning arrives immediately: it must not talk over the line.
  servo.push('更多'.repeat(60))
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(said.length, 1)
  assert.equal(calls, 1)
  servo.stop('test')
})

test('an empty answer never becomes a request loop', async () => {
  let calls = 0
  const said = []
  const servo = new FastLaneServo({
    startAt: Date.now(),
    call: async () => { calls += 1; return '{"say":""}' },
    say: (line) => said.push(line),
  })
  servo.push('思考'.repeat(40))
  await new Promise((resolve) => setTimeout(resolve, 1600))
  const afterFirst = calls
  servo.push('更多'.repeat(60))
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(said.length, 0)
  assert.equal(calls, afterFirst)
  servo.stop('test')
})

test('stopping the servo ends it for the reply', async () => {
  const said = []
  const servo = new FastLaneServo({
    startAt: Date.now(),
    call: async () => '{"say":"不该说。"}',
    say: (line) => said.push(line),
  })
  servo.push('思考'.repeat(40))
  servo.stop('answer')
  await new Promise((resolve) => setTimeout(resolve, 1700))
  assert.equal(said.length, 0)
  assert.equal(servo.isStopped, true)
})
