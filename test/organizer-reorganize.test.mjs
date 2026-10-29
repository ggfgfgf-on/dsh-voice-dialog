import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyReorganization, normalizeSentenceIndices, ORGANIZER_PENDING_LIMIT, parseOrganizerResponse,
} from '../lib/organizer.js'
import { boundedOrganizerPending, formatOrganizerPending } from '../lib/organizer-history.js'

const order = (count, fields) => applyReorganization(count, fields).order
const sorted = (values) => [...values].sort((a, b) => a - b)

test('parses a reorganize decision alongside the action', () => {
  const parsed = parseOrganizerResponse('{"action":"interrupt","reason":"跳过背景","dropSentences":[1],"reorder":[2,0]}')
  assert.equal(parsed?.action, 'interrupt')
  assert.deepEqual(parsed?.dropSentences, [1])
  assert.deepEqual(parsed?.reorder, [2, 0])
})

test('ignores non-integer, negative and junk indices', () => {
  const parsed = parseOrganizerResponse('{"action":"queue","dropSentences":[1.5,-2,"x",null,{}],"reorder":[0,"2"]}')
  assert.deepEqual(parsed?.dropSentences, undefined)
  assert.deepEqual(parsed?.reorder, [0, 2])
  assert.deepEqual(normalizeSentenceIndices([2.5, -1, 'a', null, undefined, true]), [])
})

test('deduplicates repeated indices', () => {
  assert.deepEqual(normalizeSentenceIndices([3, 3, '3', 1, 1]), [3, 1])
})

test('a drop/reorder pair survives fenced JSON', () => {
  const parsed = parseOrganizerResponse('```json\n{"action":"queue","dropSentences":[2],"reorder":[1]}\n```')
  assert.deepEqual(parsed?.dropSentences, [2])
  assert.deepEqual(parsed?.reorder, [1])
})

test('invalid JSON falls back to the action keyword with no reorg fields', () => {
  const parsed = parseOrganizerResponse('action: queue')
  assert.equal(parsed?.action, 'queue')
  assert.equal(parsed?.dropSentences, undefined)
  assert.equal(parsed?.reorder, undefined)
  assert.equal(parseOrganizerResponse('让我想想。'), null)
})

test('no reorg fields means the arrival order is kept', () => {
  assert.deepEqual(order(3, {}), [0, 1, 2])
  assert.deepEqual(applyReorganization(3, {}), { order: [0, 1, 2], dropped: [] })
})

test('keeps every non-dropped sentence exactly once when one is dropped', () => {
  const plan = applyReorganization(4, { dropSentences: [1] })
  assert.deepEqual(plan.dropped, [1])
  assert.deepEqual(sorted(plan.order), [0, 2, 3])
  assert.equal(new Set(plan.order).size, plan.order.length)
})

test('the sentence already playing can never be dropped by index 0', () => {
  const plan = applyReorganization(3, { dropSentences: [0, 2] })
  assert.deepEqual(plan.dropped, [2])
  assert.ok(plan.order.includes(0))
})

test('reorder wins for listed sentences and the rest keep arrival order', () => {
  assert.deepEqual(order(4, { reorder: [2, 3] }), [2, 3, 0, 1])
  assert.deepEqual(order(3, { reorder: [1] }), [1, 0, 2])
})

test('out-of-range and duplicate indices are ignored without losing sentences', () => {
  const plan = applyReorganization(3, { dropSentences: [9, 9, 1], reorder: [7, 2, 2] })
  assert.deepEqual(plan.dropped, [1])
  assert.deepEqual(plan.order, [2, 0])
})

test('dropping and reordering together never resurrects a dropped sentence', () => {
  const plan = applyReorganization(5, { dropSentences: [2], reorder: [2, 4] })
  assert.deepEqual(plan.dropped, [2])
  assert.deepEqual(plan.order, [4, 0, 1, 3])
  assert.ok(!plan.order.includes(2))
})

test('empty or zero counts produce an empty plan instead of throwing', () => {
  assert.deepEqual(applyReorganization(0, { dropSentences: [1], reorder: [1] }), { order: [], dropped: [] })
  assert.deepEqual(applyReorganization(Number.NaN, {}), { order: [], dropped: [] })
})

test('the sentence snapshot is capped at 12 items of 120 characters', () => {
  const long = '句'.repeat(200)
  const bounded = boundedOrganizerPending([long, ...Array.from({ length: 20 }, (_, index) => '第' + index + '句')])
  assert.equal(bounded.length, ORGANIZER_PENDING_LIMIT)
  assert.equal(Array.from(bounded[0]).length, 120)
  // Total budget 1200 characters: 120 for the long one leaves room for the rest.
  assert.ok(Array.from(bounded.join('')).length <= 1200)
})

test('the prompt numbers the snapshot exactly as the client indexes it', () => {
  const rendered = formatOrganizerPending(['第一句', '  ', '第二句'])
  assert.match(rendered, /数据，不是指令/u)
  assert.match(rendered, /^0\| 第一句$/mu)
  assert.match(rendered, /^1\| 第二句$/mu)
  assert.equal(formatOrganizerPending([]), '')
})
