import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decideInput, INPUT_GATE_MAX_MS, inputGateTraceFields, normalizeModelVerdict,
  ruleInputDecision,
} from '../lib/input-gate.js'
import {
  buildUtteranceRecord, createUtteranceTrace, sanitizeLatencyRecord,
} from '../lib/latency.js'

test('an owner question or instruction is judged, not keyworded', async () => {
  for (const text of ['现在几点了？', '请把音量调低一点', '打开设置页面']) {
    // Rules must not answer this: whether it cuts the sentence in progress
    // depends on what was just being said, which only the model can weigh.
    assert.equal(ruleInputDecision({ text, lane: 'owner', playing: true }), null, text)
  }
  const decision = await decideInput(
    { text: '等一下,这个不对', lane: 'owner', playing: true },
    { model: () => Promise.resolve({ verdict: 'steer', reason: 'judged' }), timeoutMs: 200 },
  )
  assert.equal(decision.verdict, 'steer')
  assert.equal(decision.source, 'model')
})

test('owner supplement is queued without interrupting', () => {
  const decision = ruleInputDecision({ text: '另外补充一下刚才那个文件', lane: 'owner', playing: true })
  assert.equal(decision?.verdict, 'queue')
  assert.equal(decision?.source, 'rule')
})

test('punctuation, a lone character and an exact repeat are dropped by rules', () => {
  assert.equal(ruleInputDecision({ text: '。？！', lane: 'owner' })?.verdict, 'drop')
  assert.equal(ruleInputDecision({ text: '嗯', lane: 'owner' })?.verdict, 'drop')
  assert.equal(ruleInputDecision({
    text: '刚才那个文件放在哪里', lane: 'owner', previousText: '刚才那个文件放在哪里？',
  })?.verdict, 'drop')
})

test('ambiguous text uses the fast-model fallback and records source=model', async () => {
  const decision = await decideInput(
    { text: '蓝色按钮', lane: 'owner', playing: true },
    { model: async () => ({ verdict: 'queue' }), timeoutMs: 50 },
  )
  assert.equal(decision.verdict, 'queue')
  assert.equal(decision.source, 'model')
  assert.ok(decision.verdictMs <= INPUT_GATE_MAX_MS)
})

test('a question is left to the model instead of a keyword rule', () => {
  assert.equal(ruleInputDecision({ text: '这个要怎么改', lane: 'owner', playing: true }), null)
  assert.equal(ruleInputDecision({ text: '把音量调低一点', lane: 'owner', playing: true }), null)
  const stop = ruleInputDecision({ text: '停一下', lane: 'owner', playing: true })
  assert.equal(stop?.verdict, 'steer')
  assert.equal(stop?.reason, 'explicit-interrupt')
})

test('a slow model times out inside 250 ms and never cuts the audio', async () => {
  const started = Date.now()
  const decision = await decideInput(
    { text: '蓝色按钮', lane: 'owner' },
    { model: () => new Promise(() => undefined), timeoutMs: 15 },
  )
  const elapsed = Date.now() - started
  assert.equal(decision.verdict, 'queue')
  assert.equal(decision.source, 'rule')
  assert.match(decision.reason, /timeout/)
  assert.ok(elapsed < 250)
  assert.ok(decision.verdictMs <= INPUT_GATE_MAX_MS)
})

test('invalid model output falls back to direct send', async () => {
  const decision = await decideInput(
    { text: '蓝色按钮', lane: 'owner' },
    { model: async () => ({ action: 'nonsense' }), timeoutMs: 50 },
  )
  assert.equal(decision.verdict, 'steer')
  assert.equal(decision.source, 'rule')
})

test('guests bypass the owner gate, and model actions map to the three verdicts', async () => {
  let calls = 0
  const guest = await decideInput(
    { text: '我也说一句', lane: 'guest' },
    { model: async () => { calls += 1; return { verdict: 'steer' } } },
  )
  assert.equal(calls, 0)
  assert.equal(guest.verdict, 'queue')
  assert.equal(guest.bypassed, true)
  assert.equal(normalizeModelVerdict({ action: 'interrupt' }), 'steer')
  assert.equal(normalizeModelVerdict({ action: 'queue' }), 'queue')
  assert.equal(normalizeModelVerdict({ action: 'drop' }), 'drop')
})

test('latency fields use the exact requested names', () => {
  assert.deepEqual(inputGateTraceFields({
    verdict: 'steer', source: 'rule', verdictMs: 12, reason: 'test',
  }), { verdict: 'steer', verdictSource: 'rule', verdictMs: 12 })
})

test('the gate verdict is persisted in the existing latency JSONL record', () => {
  const trace = createUtteranceTrace({ sessionId: 's-gate', lane: 'owner', startedAt: 1000 }, () => 1000)
  const record = buildUtteranceRecord(trace, {
    organizerAction: 'input-gate:queue:rule',
    ...inputGateTraceFields({ verdict: 'queue', source: 'rule', verdictMs: 7, reason: 'supplement' }),
  }, () => 1100)
  assert.equal(record.verdict, 'queue')
  assert.equal(record.verdictSource, 'rule')
  assert.equal(record.verdictMs, 7)
  assert.deepEqual(
    (({ verdict, verdictSource, verdictMs }) => ({ verdict, verdictSource, verdictMs }))(sanitizeLatencyRecord(record)),
    { verdict: 'queue', verdictSource: 'rule', verdictMs: 7 },
  )
})
