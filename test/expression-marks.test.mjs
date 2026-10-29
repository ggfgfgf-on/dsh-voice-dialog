import { test } from 'node:test'
import assert from 'node:assert/strict'
import { expressionSsmlChunks, normalizeVoiceUnits, resolveMarks, splitStress } from '../lib/expression.js'
import { mergeSynthesisRun } from '../lib/tts-queue.js'

const ZERO = { rate: 0, pitch: 0, volume: 0 }

const unitOf = (row) => {
  const units = normalizeVoiceUnits([row])
  assert.equal(units.length, 1)
  return units[0]
}

const elements = (fragment) => (fragment.match(/<prosody/gu) ?? []).length

test('a bare at paints exactly one character', () => {
  const unit = unitOf({ say: '我真的不知道', mark: [{ at: 3, pitch: 10 }] })
  assert.deepEqual(resolveMarks(unit).map((span) => [span.text, span.pitch]),
    [['我真的', 0], ['不', 10], ['知道', 0]])
})

test('a range folds into one span and overlapping marks add up', () => {
  const unit = unitOf({ say: '一二三四', mark: [{ at: 0, to: 2, pitch: 10 }, { at: 1, to: 3, pitch: 5 }] })
  assert.deepEqual(resolveMarks(unit).map((span) => span.pitch), [10, 15, 5, 0])
})

test('a chunk carries full resolved values for both of its spans', () => {
  const chunks = expressionSsmlChunks(unitOf({ say: '真好', mark: [{ at: 0, pitch: 8 }] }), ZERO)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].ssml,
    '<prosody rate="default" pitch="+8%" volume="default">真</prosody>'
    + '<prosody rate="default" pitch="default" volume="default">好</prosody>')
  assert.equal(chunks[0].text, '真好')
})

test('no request ever carries more than two prosody elements', () => {
  const unit = unitOf({ say: '我真的不知道', mark: [{ at: 0, pitch: 8 }, { at: 3, pitch: 8 }] })
  const chunks = expressionSsmlChunks(unit, ZERO)
  for (const chunk of chunks) assert.ok(elements(chunk.ssml) <= 2)
  assert.equal(chunks.map((chunk) => chunk.text).join(''), '我真的不知道')
})

test('smooth mode never splices a phrase: cuts land on punctuation', () => {
  const unit = unitOf({ say: '太好了，我就知道你能行！', style: 'happy' })
  const chunks = expressionSsmlChunks(unit, ZERO)
  for (const chunk of chunks.slice(0, -1)) assert.match(chunk.text, /[，,。！？!?、；;：:]$/u)
  assert.equal(chunks.map((chunk) => chunk.text).join(''), '太好了，我就知道你能行！')
})

test('fine mode trades the phrase for per-character bends', () => {
  const marks = [{ at: 0, pitch: 8 }, { at: 1, pitch: -4 }, { at: 3, pitch: 8 }]
  const smooth = expressionSsmlChunks(unitOf({ say: '我真的不知道', mark: marks }), ZERO)
  const fine = expressionSsmlChunks(unitOf({ say: '我真的不知道', granularity: 'fine', mark: marks }), ZERO)
  assert.ok(fine.length > smooth.length)
  for (const chunk of fine) assert.ok(elements(chunk.ssml) <= 2)
})

test('the queue base is added into every span', () => {
  const chunks = expressionSsmlChunks(
    unitOf({ say: '好', mark: [{ at: 0, pitch: 4 }] }),
    { rate: 10, pitch: 0, volume: 0 },
  )
  assert.equal(chunks[0].ssml, '<prosody rate="+10%" pitch="+4%" volume="default">好</prosody>')
})

test('marked text is escaped before it reaches SSML', () => {
  const chunks = expressionSsmlChunks(unitOf({ say: 'a&b<c', mark: [{ at: 0, rate: -10 }] }), ZERO)
  assert.equal(chunks[0].ssml,
    '<prosody rate="-10%" pitch="default" volume="default">a</prosody>'
    + '<prosody rate="default" pitch="default" volume="default">&amp;b&lt;c</prosody>')
})

test('a punctuation-only region folds into its neighbour instead of silencing a request', () => {
  const chunks = expressionSsmlChunks(unitOf({ say: '好的。', mark: [{ at: 0, pitch: 8 }] }), ZERO)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].text, '好的。')
  assert.equal((chunks[0].ssml.match(/<prosody/gu) ?? []).length, 2)
  assert.ok(chunks[0].ssml.includes('>的。</prosody>'))
})

test('an unmarked step has no SSML at all and keeps the plain path', () => {
  assert.equal(expressionSsmlChunks(unitOf({ say: '真好' }), ZERO), undefined)
})

test('an unusable mark is dropped without losing the step', () => {
  assert.equal(unitOf({ say: '好', mark: [{ at: 0, tone: 'shouting' }] }).mark, undefined)
})

test('a marked step is never split on a stressed word', () => {
  const unit = unitOf({ say: '我很生气', stress: ['生气'], mark: [{ at: 0, pitch: 6 }] })
  assert.equal(splitStress(unit).length, 1)
})

test('a marked block never joins a merged synthesis request', () => {
  const prosody = { rate: 'default', pitch: 'default', volume: 'default' }
  const items = [
    { text: '一', replyId: 'r', round: 0, prosody, ssml: '<prosody pitch="+5%">一</prosody>' },
    { text: '二', replyId: 'r', round: 0, prosody },
  ]
  assert.deepEqual(mergeSynthesisRun(items), { text: '一', count: 1 })
})
