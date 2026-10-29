import test from 'node:test'
import assert from 'node:assert/strict'
import { PlanLedger, shouldApplyPlan, SpeechPlanner } from '../lib/planner.js'

const request = {
  sessionId: 'session-1', turnId: 'turn-1', text: '这个先别讲了', lane: 'owner',
  playing: true, queued: 2,
  queue: [{ id: 3, lane: 'owner', text: '队列一句' }],
  assistantPending: ['正在说的这句', '还没说的那句'],
}

test('a plan is applied at most once per turn and version', () => {
  const ledger = new PlanLedger()
  const plan = { version: 1, turnId: 'turn-1', reason: 'x', interrupt: false, queuePlan: [{ id: 3, action: 'drop' }] }
  assert.equal(ledger.tryClaim(plan), true)
  assert.equal(ledger.tryClaim({ ...plan }), false)
  assert.equal(ledger.tryClaim({ ...plan, version: 2 }), true)
})

test('a plan whose turn already ended is discarded whole', () => {
  const plan = { version: 1, turnId: 't', reason: '', interrupt: false, queuePlan: [{ id: 1, action: 'drop' }] }
  // Turn over: nothing playing and nothing queued, so nothing may be revived.
  assert.equal(shouldApplyPlan(plan, { playing: false, queued: 0, ids: [] }), false)
  // Still playing, but the addressed entry is already gone.
  assert.equal(shouldApplyPlan(plan, { playing: true, queued: 0, ids: [] }), false)
  assert.equal(shouldApplyPlan(plan, { playing: false, queued: 1, ids: [1] }), true)
  assert.equal(shouldApplyPlan(plan, { playing: false, queued: 1, ids: [9] }), false)
  // A plan that only touches pending sentences applies while anything plays.
  const pendingOnly = { version: 2, turnId: 't', reason: '', interrupt: false, dropSentences: [1] }
  assert.equal(shouldApplyPlan(pendingOnly, { playing: true, queued: 0, ids: [] }), true)
  assert.equal(shouldApplyPlan(null, { playing: true, queued: 1, ids: [1] }), false)
})

test('a hung planner returns null at the deadline instead of hanging the caller', async () => {
  const planner = new SpeechPlanner(() => new Promise(() => undefined), { timeoutMs: 40 })
  const startedAt = Date.now()
  const plan = await planner.plan(request)
  assert.equal(plan, null)
  assert.ok(Date.now() - startedAt < 2000)
})

test('a plan with no actionable field is ignored', async () => {
  const planner = new SpeechPlanner(async () => ({ reason: '不变' }), { timeoutMs: 200 })
  assert.equal(await planner.plan(request), null)
})

test('a queue plan is parsed, bounded and kept when it changes something', async () => {
  const planner = new SpeechPlanner(async () => ({
    queuePlan: [{ id: 3, action: 'drop' }, { id: 'junk', action: 'drop' }, { id: 4, action: 'raise', priority: 10 }],
    reason: '过时了',
  }), { timeoutMs: 200 })
  const plan = await planner.plan(request)
  assert.equal(plan.queuePlan.length, 2)
  assert.deepEqual(plan.queuePlan[0], { id: 3, action: 'drop' })
  assert.deepEqual(plan.queuePlan[1], { id: 4, action: 'raise', priority: 10 })
})
