import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BREATH_GAP_MS, breathSeam, normalizeVoiceUnits, resolveMarks, STYLES, STYLE_TOKENS,
} from '../lib/expression.js'

const ZERO = { rate: 0, pitch: 0, volume: 0 }

const unitOf = (row) => {
  const units = normalizeVoiceUnits([row])
  assert.equal(units.length, 1)
  return units[0]
}

test('every published style has a meaning and a resolver entry', () => {
  assert.deepEqual(STYLE_TOKENS, Object.keys(STYLES))
  for (const token of STYLE_TOKENS) assert.ok(STYLES[token].meaning.length > 4)
})

test('a style fills what the step left open', () => {
  const unit = unitOf({ say: '你就答应我嘛，好不好呀。', style: 'coy' })
  assert.equal(unit.pace, 'slower')
  assert.equal(unit.pitch, 4)
})

test('a style paints an ending contour on the last characters', () => {
  const rising = unitOf({ say: '你就答应我嘛', style: 'coy' })
  const marks = resolveMarks(rising)
  assert.ok(marks.length > 1)
  assert.equal(marks[marks.length - 1].pitch, STYLES.coy.tail)
  assert.ok(marks[0].pitch < marks[marks.length - 1].pitch)
  const falling = unitOf({ say: '算了那下次再说吧', style: 'disappointed' })
  const tail = resolveMarks(falling)
  assert.ok(tail[tail.length - 1].pitch < 0)
})

test('the step always wins over its style', () => {
  const unit = unitOf({ say: '就这样吧，晚安。', style: 'sleepy', rate: 0 })
  assert.equal(unit.rate, 0)
  assert.equal(unit.lengthen, true)
})

test('an explicit mark sequence owns the contour', () => {
  const unit = unitOf({ say: '好的好的', style: 'coy', mark: [{ at: 0, pitch: -4 }] })
  assert.deepEqual(unit.mark, [{ at: 0, pitch: -4 }])
})

test('an unknown style rejects the step instead of speaking neutral', () => {
  assert.equal(normalizeVoiceUnits([{ say: '你好', style: 'sassy' }]).length, 0)
})

test('a breath seam splits at the comma it inserted', () => {
  const seam = breathSeam('你这也太逗了，我笑个不停')
  assert.deepEqual(seam, ['你这也太逗了，', '我笑个不停'])
  assert.equal(breathSeam('好'), undefined)
  assert.ok(BREATH_GAP_MS > 0)
})
