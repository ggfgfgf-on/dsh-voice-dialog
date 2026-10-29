import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ADJUSTMENTS, applyExpression, CONSTRUCTS, effectiveProsody, EXPRESS_TOKENS, normalizeVoiceUnits,
  PACE_DELTAS, PAUSE_MS, pauseMsFor, splitStress, STEP_LIMITS, TONE_DELTAS, VOCABULARY,
} from '../lib/expression.js'
import { mergeSynthesisRun } from '../lib/tts-queue.js'

const ZERO = { rate: 0, pitch: 0, volume: 0 }

test('the published vocabulary is generated from the synthesis tables', () => {
  assert.deepEqual(Object.keys(TONE_DELTAS), VOCABULARY.tone.map((entry) => entry.value))
  assert.deepEqual(Object.keys(PACE_DELTAS), VOCABULARY.pace.map((entry) => entry.value))
  assert.deepEqual(Object.keys(PAUSE_MS), VOCABULARY.pause.map((entry) => entry.value))
  assert.deepEqual(Object.keys(TONE_DELTAS), EXPRESS_TOKENS.tone)
  for (const entry of [...VOCABULARY.tone, ...VOCABULARY.pace, ...VOCABULARY.pause]) {
    assert.equal(typeof entry.meaning, 'string')
    assert.ok(entry.meaning.length > 2)
  }
})

test('capabilities publish all three layers from the same constants', () => {
  assert.deepEqual(ADJUSTMENTS.map((entry) => entry.field), Object.keys(STEP_LIMITS))
  for (const entry of ADJUSTMENTS) {
    assert.equal(entry.min, STEP_LIMITS[entry.field].min)
    assert.equal(entry.max, STEP_LIMITS[entry.field].max)
  }
  assert.deepEqual(CONSTRUCTS.map((entry) => entry.value), ['lengthen', 'breath'])
  assert.equal(VOCABULARY.tone.length, Object.keys(TONE_DELTAS).length)
})

test('intent tokens map to the documented acoustics', () => {
  const tone = (name) => ({
    rate: TONE_DELTAS[name].rate ?? 0,
    pitch: TONE_DELTAS[name].pitch ?? 0,
    volume: TONE_DELTAS[name].volume ?? 0,
  })
  assert.deepEqual(effectiveProsody({ say: 'x', tone: 'soft' }, ZERO), tone('soft'))
  assert.deepEqual(effectiveProsody({ say: 'x', tone: 'urgent' }, ZERO), tone('urgent'))
  assert.deepEqual(effectiveProsody({ say: 'x', pace: 'slower' }, ZERO), { rate: -10, pitch: 0, volume: 0 })
  assert.deepEqual(effectiveProsody({ say: 'x' }, ZERO), ZERO)
})

test('numbers are adjustments on top of a non-default base', () => {
  const base = { rate: 10, pitch: -4, volume: 20 }
  assert.deepEqual(effectiveProsody({ say: 'x', rate: 30 }, base), { rate: 40, pitch: -4, volume: 20 })
})

test('numbers then tokens, clamped once at the end', () => {
  const base = { rate: 10, pitch: 0, volume: 0 }
  // 10 base + 20 step + 14 urgent = 44
  assert.equal(effectiveProsody({ say: 'x', rate: 20, tone: 'urgent' }, base).rate, 44)
  // 45 base + 40 step + 14 urgent = 99 -> clamped to 50
  assert.equal(effectiveProsody({ say: 'x', rate: 40, tone: 'urgent' }, { rate: 45, pitch: 0, volume: 0 }).rate, 50)
  assert.equal(effectiveProsody({ say: 'x', volume: 90 }, { rate: 0, pitch: 0, volume: 90 }).volume, 100)
})

test('out-of-range numbers are clamped, unknown tokens rejected', () => {
  assert.equal(normalizeVoiceUnits([{ say: 'x', rate: 999 }])[0].rate, 50)
  assert.equal(normalizeVoiceUnits([{ say: 'x', volume: -500 }])[0].volume, -100)
  assert.equal(normalizeVoiceUnits([{ say: '你好', tone: 'loud' }]).length, 0)
  assert.equal(normalizeVoiceUnits([{ say: '你好', pace: 'quick' }]).length, 0)
  assert.equal(normalizeVoiceUnits([{ pause: 'longer' }]).length, 0)
  assert.equal(normalizeVoiceUnits([{ pause: 'long' }]).length, 1)
})

test('normalize keeps at most twelve steps and drops empty ones', () => {
  const many = Array.from({ length: 20 }, (_, index) => ({ say: 'L' + index }))
  assert.equal(normalizeVoiceUnits(many).length, 12)
  assert.equal(normalizeVoiceUnits([{ say: '   ' }, { pause: 'beat' }]).length, 1)
})

test('adjacent units with the same intent merge into one request', () => {
  const same = [
    { text: '第一句', round: 0, replyId: 'r', prosody: { rate: '+10%', pitch: 'default', volume: 'default' } },
    { text: '第二句', round: 0, replyId: 'r', prosody: { rate: '+10%', pitch: 'default', volume: 'default' } },
  ]
  assert.equal(mergeSynthesisRun(same).count, 2)
  const different = [
    { text: '第一句', round: 0, replyId: 'r', prosody: { rate: '+10%', pitch: 'default', volume: 'default' } },
    { text: '第二句', round: 0, replyId: 'r', prosody: { rate: '-10%', pitch: 'default', volume: 'default' } },
  ]
  assert.equal(mergeSynthesisRun(different).count, 1)
  const gapped = [
    { text: '第一句', round: 0, replyId: 'r', prosody: { rate: '+10%' }, gapAfterMs: 280 },
    { text: '第二句', round: 0, replyId: 'r', prosody: { rate: '+10%' } },
  ]
  assert.equal(mergeSynthesisRun(gapped).count, 1)
})

test('a pause step asks for a silent gap', () => {
  assert.equal(pauseMsFor('beat'), 280)
  assert.equal(pauseMsFor('short'), 140)
  assert.equal(pauseMsFor('long'), 600)
})

test('a stressed word splits the unit into three, the middle one firm', () => {
  const pieces = splitStress({ say: '我真的很喜欢这个方案', stress: ['喜欢'], breath: true })
  assert.equal(pieces.length, 3)
  assert.equal(pieces[0].say, '我真的很')
  assert.equal(pieces[1].say, '喜欢')
  assert.equal(pieces[1].tone, 'firm')
  assert.equal(pieces[2].say, '这个方案')
  assert.equal(pieces[2].breath, true)
  assert.equal(pieces[0].breath, undefined)
  assert.equal(splitStress({ say: '没有这个词', stress: ['缺'] }).length, 1)
})

test('text constructs are idempotent', () => {
  const lengthen = { say: '好的。', lengthen: true }
  assert.equal(applyExpression(lengthen), '好的——')
  assert.equal(applyExpression({ ...lengthen, say: applyExpression(lengthen) }), '好的——')
  const breath = { say: '今天天气不错我们出去走走吧', breath: true }
  const once = applyExpression(breath)
  assert.equal(applyExpression({ ...breath, say: once }), once)
  const both = { say: '我明白了。', lengthen: true, breath: true }
  const bothOnce = applyExpression(both)
  assert.equal(applyExpression({ ...both, say: bothOnce }), bothOnce)
  assert.equal(applyExpression({ say: '已经——' }), '已经——')
})
