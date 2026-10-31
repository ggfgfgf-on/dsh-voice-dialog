import assert from 'node:assert/strict'
import test from 'node:test'
import { decideChunks, decidePlan, planAck, planFromVerdict } from '../lib/plan.js'

const owner = { lane: 'owner', canonical: '我' }

test('plan: an ordinary owner line is the floor and takes the slow lane', () => {
  const items = decidePlan({ text: '帮我看一下那个报告' }, owner)
  assert.equal(items.length, 1)
  assert.deepEqual(items[0], {
    kind: 'reply', lane: 'slow', reason: 'owner-floor', source: 'rule',
  })
})

test('plan: noise and duplicates are ignored here, not at the microphone', () => {
  assert.equal(decidePlan({ text: '嗯' }, owner)[0].kind, 'ignore')
  assert.equal(decidePlan({ text: '。。' }, owner)[0].reason, 'empty-or-punctuation')
  const repeat = decidePlan({ text: '帮我看一下那个报告' }, { ...owner, previousText: '帮我看一下那个报告' })
  assert.equal(repeat[0].kind, 'ignore')
  assert.equal(repeat[0].reason, 'duplicate-previous')
})

test('plan: an explicit stop takes the fast lane at the head of the queue', () => {
  const items = decidePlan({ text: '别说了' }, owner)
  assert.equal(items[0].kind, 'reply')
  assert.equal(items[0].lane, 'fast')
  assert.equal(items[0].priority, -1)
  assert.equal(items[0].reason, 'explicit-interrupt')
})

test('plan: a supplement parks instead of interrupting', () => {
  const items = decidePlan({ text: '另外还有一点' }, owner)
  assert.equal(items[0].kind, 'hold')
  assert.equal(items[0].reason, 'supplement')
})

test('plan: the guest policy is applied here, so the lane never guesses', () => {
  const guest = { lane: 'guest', canonical: '客人1' }
  assert.equal(decidePlan({ text: '老板在哪里' }, { ...guest, guestMode: 'ignore' })[0].kind, 'ignore')
  const steer = decidePlan({ text: '老板在哪里' }, { ...guest, guestMode: 'steer' })[0]
  assert.equal(steer.lane, 'fast')
  assert.equal(steer.priority, -1)
  assert.equal(steer.source, 'policy')
  const queue = decidePlan({ text: '老板在哪里' }, { ...guest, guestMode: 'queue' })[0]
  assert.equal(queue.kind, 'reply')
  assert.equal(queue.lane, 'slow')
})

test('plan: a split corpus plans every chunk, the tail included', () => {
  const planned = decideChunks(['帮我把报告打开', '然后翻到第三页'], owner)
  assert.equal(planned.length, 2)
  assert.equal(planned[0].item.kind, 'reply')
  // A continuation tail is planned as a hold by the rule engine, not skipped.
  assert.equal(planned[1].item.kind, 'hold')
  assert.equal(planned[1].item.source, 'rule')
  // The duplicate rule carries across chunks: a repeated tail is ignored, not replayed.
  const repeated = decideChunks(['打开报告', '打开报告'], owner)
  assert.equal(repeated[1].item.kind, 'ignore')
  assert.equal(repeated[1].item.reason, 'duplicate-previous')
})

test('plan: a late model verdict maps into the same vocabulary', () => {
  assert.equal(planFromVerdict('steer').priority, -1)
  assert.equal(planFromVerdict('queue').kind, 'hold')
  assert.equal(planFromVerdict('drop').kind, 'ignore')
  assert.equal(planFromVerdict('drop').source, 'model')
})

test('plan: an acknowledgement is a shape, the wording stays with the model', () => {
  assert.equal(planAck(''), null)
  assert.equal(planAck('none'), null)
  const item = planAck('  嗯，我想一下  ', 800)
  assert.equal(item.kind, 'ack')
  assert.equal(item.lane, 'fast')
  assert.equal(item.text, '嗯，我想一下')
  assert.equal(item.delayMs, 800)
  assert.equal(planAck('我在听').delayMs, undefined, 'no time declared means the wait decides')
})
