import assert from 'node:assert/strict'
import test from 'node:test'
import { applyChunkReorganization, applyReorganization } from '../lib/organizer.js'
import { planChunkOutputOrder } from '../lib/arrange.js'
import { buildPlannerPrompt } from '../lib/planner.js'

const chunk = (text, sentenceId, chunkIndex) => ({ text, sentenceId, chunkIndex })

test('cross-sentence reorder is allowed while same-sentence blocks keep order', () => {
  const chunks = [
    chunk('甲句前半，', 0, 0),
    chunk('甲句后半。', 0, 1),
    chunk('乙句前半，', 1, 0),
    chunk('乙句后半。', 1, 1),
  ]
  const plan = applyChunkReorganization(chunks, { reorder: [2, 3, 0, 1] })
  assert.deepEqual(plan.order, [2, 3, 0, 1])
  assert.deepEqual(plan.dropped, [])

  const reversed = applyChunkReorganization(chunks, { reorder: [3, 2, 1, 0] })
  const positions = new Map(reversed.order.map((index, position) => [index, position]))
  assert.ok(positions.get(0) < positions.get(1), 'same sentence: chunk 0 stays before chunk 1')
  assert.ok(positions.get(2) < positions.get(3), 'same sentence: chunk 2 stays before chunk 3')
  assert.deepEqual([...reversed.order].sort(), [0, 1, 2, 3], 'nothing is lost')
})

test('dropping one block keeps every remaining block once and in order', () => {
  const chunks = [
    chunk('零。', 0, 0),
    chunk('一。', 1, 0),
    chunk('二。', 2, 0),
    chunk('三。', 3, 0),
  ]
  const plan = applyChunkReorganization(chunks, { dropSentences: [1] })
  assert.deepEqual(plan.dropped, [1])
  assert.deepEqual(plan.order, [0, 2, 3])
  assert.equal(new Set(plan.order).size, plan.order.length)
  assert.ok(applyReorganization(3, { dropSentences: [0, 2] }).order.includes(0), 'index 0 stays')
})

test('rule fallback moves conclusion sentences first and drops background sentences', () => {
  const chunks = [
    chunk('这次重构改了三处代码。', 0, 0),
    chunk('背景是上一版把队列写死了。', 1, 0),
    chunk('背景补充说旧实现还有历史包袱。', 1, 1),
    chunk('结论是先把输出顺序管起来。', 2, 0),
    chunk('下一步跑一遍全量测试。', 3, 0),
  ]
  const plan = planChunkOutputOrder(chunks, '先说结论，别讲背景')
  assert.deepEqual(plan.dropped, [1, 2])
  assert.deepEqual(plan.order, [3, 0, 4])
  assert.equal(plan.reason, 'rule')
})

test('planner prompt numbers each block and marks its sentence/chunk', () => {
  const prompt = buildPlannerPrompt({
    text: '先说结论', lane: 'owner', playing: true, queued: 0, queue: [],
    assistantPending: [
      chunk('第一块，', 0, 0),
      chunk('第二块。', 0, 1),
      chunk('第三块。', 1, 0),
    ],
    history: [],
  })
  assert.match(prompt, /待说 0\|第一块，（句0块1）/u)
  assert.match(prompt, /待说 1\|第二块。（句0块2）/u)
  assert.match(prompt, /待说 2\|第三块。（句1块1）/u)
})
