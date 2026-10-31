import { test } from 'node:test'
import assert from 'node:assert/strict'
import { expressionSsmlChunks, normalizeVoiceUnits, resolveMarks } from '../lib/expression.js'

const ZERO = { rate: 0, pitch: 0, volume: 0 }
const unitOf = (row) => {
  const units = normalizeVoiceUnits([row])
  assert.equal(units.length, 1)
  return units[0]
}
const elements = (fragment) => (fragment.match(/<prosody/gu) ?? []).length

test('by default a curve is fitted into two spans and one request', () => {
  const unit = unitOf({ say: '一二三四五六', curve: { pitch: [0, 5, 10, 15, 10, 0] } })
  const chunks = expressionSsmlChunks(unit, ZERO)
  assert.equal(chunks.length, 1)
  assert.ok(elements(chunks[0].ssml) <= 2)
  const spans = resolveMarks(unit)
  assert.equal(spans.map((span) => span.text).join(''), '一二三四五六')
  assert.ok(spans.length <= 2)
})

test('fine granularity keeps one value per character', () => {
  const unit = unitOf({ say: '一二三四五六', granularity: 'fine', curve: { pitch: [0, 5, 10, 15, 10, 0] } })
  assert.deepEqual(resolveMarks(unit).map((span) => [span.text, span.pitch]),
    [['一', 0], ['二', 5], ['三', 10], ['四', 15], ['五', 10], ['六', 0]])
})

test('the two-span fit puts the cut where the contour turns', () => {
  const unit = unitOf({ say: '一二三四五六七八', curve: { pitch: [0, 0, 0, 0, 12, 12, 12, 12] } })
  const spans = resolveMarks(unit)
  assert.equal(spans.length, 2)
  assert.equal(spans[0].pitch, 0)
  assert.equal(spans[1].pitch, 12)
})

test('a curve and an explicit mark stack', () => {
  const unit = unitOf({ say: '一二三', granularity: 'fine', curve: { pitch: [0, 4, 0] }, mark: [{ at: 1, to: 2, pitch: 6 }] })
  assert.deepEqual(resolveMarks(unit).map((span) => span.pitch), [0, 10, 0])
})

test('every request still carries at most two prosody elements', () => {
  const unit = unitOf({ say: '我真的不知道你在说什么', granularity: 'fine', curve: { pitch: [0, 4, 8, 12, 8, 4, 0, -4, -8, -4, 0] } })
  const chunks = expressionSsmlChunks(unit, ZERO)
  for (const chunk of chunks) assert.ok(elements(chunk.ssml) <= 2)
  assert.equal(chunks.map((chunk) => chunk.text).join(''), '我真的不知道你在说什么')
})

test('an all-zero curve paints nothing and a plain step stays byte identical', () => {
  const unit = unitOf({ say: '一二三', curve: { pitch: [0, 0, 0] } })
  assert.equal(unit.curve, undefined)
  assert.equal(unit.mark, undefined)
  assert.equal(expressionSsmlChunks(unit, ZERO), undefined)
  assert.equal(expressionSsmlChunks(unitOf({ say: '你好' }), ZERO), undefined)
})
