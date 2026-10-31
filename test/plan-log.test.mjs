import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PLAN_LOG_ROUTES, PLAN_TEXT_LIMIT, sanitizePlanItem,
} from '../lib/plan-log.js'

test('plan log: only a replayable item survives the whitelist', () => {
  const item = sanitizePlanItem({
    sessionId: 'session-1', replyId: 'reply-9', seq: 4, at: 1000,
    kind: 'reply', lane: 'fast', priority: -1, delayMs: 250,
    text: '好的', reason: 'owner-floor', source: 'rule',
    audio: 'never stored', transcript: 'never stored',
  })
  assert.deepEqual(item, {
    sessionId: 'session-1', replyId: 'reply-9', seq: 4, at: 1000,
    kind: 'reply', lane: 'fast', priority: -1, delayMs: 250,
    text: '好的', reason: 'owner-floor', source: 'rule',
  })
  assert.equal('audio' in item, false)
})

test('plan log: text is a summary, never a paragraph', () => {
  const long = '这是一段很长的话'.repeat(20)
  const item = sanitizePlanItem({ kind: 'reply', lane: 'slow', text: long })
  assert.equal(item.text.length, PLAN_TEXT_LIMIT)
  assert.equal(PLAN_TEXT_LIMIT, 40)
})

test('plan log: unknown kind or lane is dropped, numbers are clamped', () => {
  assert.equal(sanitizePlanItem({ kind: 'shout', lane: 'fast' }), null)
  assert.equal(sanitizePlanItem({ kind: 'reply', lane: 'sideways' }), null)
  assert.equal(sanitizePlanItem(null), null)
  assert.equal(sanitizePlanItem('reply'), null)
  const item = sanitizePlanItem({ kind: 'ack', lane: 'fast', priority: 'high', delayMs: -5 })
  assert.equal(item.priority, 0)
  assert.equal(item.delayMs, 0)
})

test('plan log: the host route exists under the plan path', () => {
  assert.deepEqual(PLAN_LOG_ROUTES.map(([route]) => route), ['/plan-log'])
})
