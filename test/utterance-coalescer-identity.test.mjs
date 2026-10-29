import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createUtteranceCoalescer } from '../lib/utterance-coalescer.js'

function harness() {
  const submissions = []
  const timers = []
  const coalescer = createUtteranceCoalescer({
    windowMs: 1500,
    dedupeTranscript: (previous, next) => (next === previous ? '' : next),
    submit: (batch) => submissions.push(batch),
    setTimer: (callback) => { timers.push(callback); return timers.length },
    clearTimer: () => {},
  })
  return { coalescer, submissions, timers }
}

function fire(timers) { for (const timer of timers.splice(0)) timer() }

test('a label flip from a slot guess to an enrolled name keeps one sentence', async () => {
  const h = harness()
  h.coalescer.append({ lane: 'owner', canonical: '说话人1', text: Promise.resolve('前半句'), meta: null, at: 1000 })
  h.coalescer.append({ lane: 'owner', canonical: '我', text: Promise.resolve('后半句'), meta: null, at: 2000 })
  fire(h.timers)
  assert.equal(h.submissions.length, 1)
  assert.equal(h.submissions[0].canonical, '我')
  assert.equal(await h.submissions[0].text, '前半句后半句')
})

test('a flip back to a slot guess still merges under the known name', async () => {
  const h = harness()
  h.coalescer.append({ lane: 'owner', canonical: '我', text: Promise.resolve('第一段'), meta: null, at: 1000 })
  h.coalescer.append({ lane: 'owner', canonical: '说话人2', text: Promise.resolve('第二段'), meta: null, at: 2100 })
  fire(h.timers)
  assert.equal(h.submissions.length, 1)
  assert.equal(h.submissions[0].canonical, '我')
})

test('two enrolled identities still flush apart', async () => {
  const h = harness()
  h.coalescer.append({ lane: 'guest', canonical: '老婆', text: Promise.resolve('甲'), meta: null, at: 1000 })
  h.coalescer.append({ lane: 'guest', canonical: '客人1', text: Promise.resolve('乙'), meta: null, at: 1200 })
  fire(h.timers)
  assert.equal(h.submissions.length, 2)
  assert.deepEqual(h.submissions.map((s) => s.canonical), ['老婆', '客人1'])
})

test('a real pause still ends the sentence', async () => {
  const h = harness()
  h.coalescer.append({ lane: 'owner', canonical: '我', text: Promise.resolve('甲'), meta: null, at: 1000 })
  h.coalescer.append({ lane: 'owner', canonical: '说话人1', text: Promise.resolve('乙'), meta: null, at: 4000 })
  fire(h.timers)
  assert.equal(h.submissions.length, 2)
})
