import assert from 'node:assert/strict'
import test from 'node:test'
import { confirmPlan, decidePartial, decidePlan } from '../lib/plan.js'
import { createLanes } from '../lib/lanes.js'
import { createEarlyStart, earlyStartEnabled } from '../lib/early-start.js'
import { sanitizeRecordEvent } from '../lib/record-log.js'
import { DEFAULT_SPEECH_PROFILE, normalizeSpeechProfile } from '../lib/speech-profile.js'

const owner = { lane: 'owner', canonical: '我' }

test('early start is off unless the model declares it', () => {
  // The master switch is on by default: the turnTaking declaration decides when
  // it may be used, so the switch itself must not silently block 'immediate'.
  assert.equal(DEFAULT_SPEECH_PROFILE.earlyStart, 'partial')
  assert.equal(earlyStartEnabled(null), false)
  assert.equal(earlyStartEnabled({}), false)
  assert.equal(earlyStartEnabled({ earlyStart: 'off' }), false)
  assert.equal(earlyStartEnabled({ earlyStart: 'partial' }), true)
  assert.deepEqual(normalizeSpeechProfile({ earlyStart: 'partial' }), { earlyStart: 'partial' })
  assert.deepEqual(normalizeSpeechProfile({ earlyStart: 'on' }), {})
})

test('a provisional plan is marked; decidePlan itself never changes', () => {
  const partial = decidePartial(['帮我看一下那个报告'], owner)
  assert.equal(partial.length, 1)
  assert.equal(partial[0].provisional, true)
  const final = decidePlan({ text: '帮我看一下那个报告' }, owner)
  assert.equal(final[0].provisional, undefined, 'the ordinary path never marks an item provisional')
})

test('confirmation keeps a plan that still says the same thing', () => {
  const provisional = decidePartial(['帮我看一下那个报告'], owner)
  const result = confirmPlan(provisional, '帮我看一下那个报告', owner, '帮我看一下那个报告')
  assert.equal(result.confirmed, true)
  assert.equal(result.reason, 'confirmed')
  assert.equal(result.items[0].provisional, undefined, 'a confirmed item runs as a normal item')
})

test('confirmation withdraws on a topic shift and on a duplicate', () => {
  const provisional = decidePartial(['帮我看一下那个报告'], owner)
  const shifted = confirmPlan(provisional, '明天天气怎么样', owner, '帮我看一下那个报告')
  assert.equal(shifted.confirmed, false)
  assert.equal(shifted.reason, 'topic-shift')
  const duplicate = confirmPlan(
    provisional, '帮我看一下那个报告',
    { ...owner, previousText: '帮我看一下那个报告' }, '帮我看一下那个报告',
  )
  assert.equal(duplicate.confirmed, false)
  assert.equal(duplicate.reason, 'rejected')
})

test('supersede withdraws only what has not been spoken', () => {
  const spoken = []
  const retracted = []
  let timer = 1
  const lanes = createLanes({
    speak: (line) => spoken.push(line),
    enqueue: () => {},
    retract: (item) => retracted.push(item.seq),
    setTimer: () => 1,
    clearTimer: () => { timer = null },
  })
  lanes.execute([
    { kind: 'ack', lane: 'fast', text: '嗯', delayMs: 300, seq: 7, reason: 'test', source: 'rule' },
    { kind: 'reply', lane: 'fast', text: '已经出声', seq: 8, reason: 'test', source: 'rule' },
  ])
  assert.deepEqual(spoken, ['已经出声'])
  assert.equal(lanes.supersede(7), 1)
  assert.equal(timer, null, 'the delayed line is cancelled before it can sound')
  assert.deepEqual(retracted, [])
  assert.equal(lanes.supersede(8), 0, 'a line already spoken is never taken back')
  lanes.dispose()
})

test('a queued provisional item is withdrawn through retract', () => {
  const retracted = []
  const lanes = createLanes({
    speak: () => {},
    enqueue: () => {},
    retract: (item) => retracted.push(item.seq),
  })
  lanes.execute([{ kind: 'reply', lane: 'slow', seq: 11, reason: 'test', source: 'rule' }])
  assert.equal(lanes.supersede(11), 1)
  assert.deepEqual(retracted, [11])
  lanes.dispose()
})

test('the early start seam records the partial, plans it and withdraws on a change', () => {
  const recorded = []
  const spoken = []
  const ctx = createEarlyStart({
    speak: (line) => spoken.push(line),
    record: (text, meta) => recorded.push({ text, meta }),
    recordPlan: () => 1,
    setTimer: () => 1,
    clearTimer: () => {},
  })
  const items = ctx.partial(['帮我看一下那个报告'], owner)
  assert.equal(items.length, 1)
  assert.equal(items[0].provisional, true)
  assert.equal(recorded[0].text, '帮我看一下那个报告')
  assert.equal(recorded[0].meta.lane, 'owner')
  const settled = ctx.settle('明天天气怎么样', owner)
  assert.equal(settled.confirmed, false)
  assert.equal(settled.reason, 'topic-shift')
  assert.equal(settled.provisional.length, 1)
  ctx.dispose()
})

test('a partial transcript is a record kind the host keeps', () => {
  const item = sanitizeRecordEvent({ kind: 'partial', seq: 3, at: 1, text: '帮我', lane: 'owner', final: false })
  assert.ok(item)
  assert.equal(item.kind, 'partial')
  assert.equal(item.text, '帮我')
})
