import test from 'node:test'
import assert from 'node:assert/strict'
import {
  arrangementChanged, planOutputOrder, sanitizeArrangement,
} from '../lib/arrange.js'

const lines = [
  '这次重构改了三处代码。',   // 0 概况
  '背景是上一版把队列写死了。', // 1 背景
  '之前还有一段历史原因。',   // 2 背景
  '结论是先把输出顺序管起来。', // 3 结论
  '下一步跑一遍全量测试。',   // 4 收尾
]

test('先说结论/别讲背景: conclusion first, only background dropped, nothing invented', () => {
  const plan = planOutputOrder(lines, '先说结论，别讲背景')
  assert.equal(plan.order[0], 3, 'conclusion sentence must come first')
  assert.deepEqual([...plan.dropped].sort(), [1, 2], 'only the two background sentences are dropped')
  const kept = plan.order.filter((index) => !plan.dropped.includes(index))
  assert.deepEqual([...kept].sort(), [0, 3, 4], 'every other sentence is kept')
  assert.equal(new Set(plan.order).size, plan.order.length, 'no sentence appears twice')
  assert.deepEqual([...plan.order].sort(), [0, 3, 4])
  assert.equal(plan.reason, 'rule')
})

test('别讲背景 alone only drops background lines, order untouched', () => {
  const plan = planOutputOrder(lines, '别讲背景，直接说')
  assert.deepEqual([...plan.dropped].sort(), [1, 2])
  assert.deepEqual(plan.order, [0, 3, 4])
  for (const index of plan.order) assert.ok(lines[index] !== undefined, 'indices stay inside the snapshot')
})

test('an ordinary line changes nothing', () => {
  const plan = planOutputOrder(lines, '把音量调小一点')
  assert.deepEqual(plan.order, [0, 1, 2, 3, 4])
  assert.deepEqual(plan.dropped, [])
  assert.equal(arrangementChanged(plan), false)
})

test('index 0 is never dropped (it may already be playing)', () => {
  const plan = planOutputOrder(['背景说明', '背景补充', '结论是这个'], '先说结论，别讲背景')
  assert.equal(plan.dropped.includes(0), false)
  assert.equal(plan.order[0], 2)
})

test('sanitizeArrangement cannot invent sentences or duplicate them', () => {
  const clean = sanitizeArrangement(5, [3, 3, 9, 0], [1, 1, 99])
  assert.deepEqual(clean.order, [3, 0, 2, 4])
  assert.deepEqual(clean.dropped, [1])
  for (const index of clean.order) assert.ok(index >= 0 && index < 5)
  const dropAll = sanitizeArrangement(3, [], [0, 1, 2])
  assert.equal(dropAll.order.length, 1, 'at least one sentence always survives')
})
