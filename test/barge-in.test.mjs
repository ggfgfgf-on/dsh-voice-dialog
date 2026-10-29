import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decideBargeIn, decideSpeechOnset, isSameSentence, orderBargeInFrames,
  shouldFallbackCut, splitAtSentenceBoundary,
} from '../lib/barge-in.js'

const frame = (sentenceId, chunkIndex, text) => ({ sentenceId, chunkIndex, text, replyId: 'old' })

test('owner speech while reading is reported but never cuts the page', () => {
  const decision = decideBargeIn({ lane: 'owner', playing: true })
  assert.equal(decision.action, 'queue')
  assert.equal(decision.finishSentence, false)
  assert.equal(decision.keepRemainder, true)
})

test('short echo inside the 300 ms playback guard is not reported and does not cut', () => {
  const decision = decideSpeechOnset({
    playing: true, playbackStartedAt: 0, onsetAt: 100, voicedMs: 120,
  })
  assert.equal(decision.action, 'ignore')
  assert.equal(decision.reason, 'playback-echo-guard')
  assert.equal(decision.selfEcho, true)
  // No report means no fallback either; the page keeps playing.
  assert.equal(shouldFallbackCut({
    playing: true, reported: false, voicedMs: 120,
  }), false)
})

test('owner speech after the guard is reported but playback is not cut', () => {
  const onset = decideSpeechOnset({
    playing: true, playbackStartedAt: 0, onsetAt: 600, voicedMs: 400,
  })
  assert.equal(onset.action, 'report')
  assert.equal(onset.reason, 'playback-sustained-onset')
  assert.equal(decideBargeIn({ lane: 'owner', playing: true }).action, 'queue')
})

test('unanswered speech triggers exactly one fallback cut after 1000 ms', () => {
  const onset = decideSpeechOnset({
    playing: true, playbackStartedAt: 0, onsetAt: 600, voicedMs: 1_200,
  })
  assert.equal(onset.action, 'report')
  assert.equal(shouldFallbackCut({
    playing: true, reported: true, voicedMs: 1_200, alreadyCut: false,
  }), true)
  assert.equal(shouldFallbackCut({
    playing: true, reported: true, voicedMs: 1_200, alreadyCut: true,
  }), false)
  assert.equal(shouldFallbackCut({
    playing: false, reported: true, voicedMs: 1_200, alreadyCut: false,
  }), false)
})

test('playback idle keeps the old owner and guest decisions', () => {
  assert.equal(decideBargeIn({ lane: 'owner', playing: false }).action, 'none')
  assert.equal(decideBargeIn({ lane: 'guest', playing: false }).action, 'none')
  assert.equal(decideSpeechOnset({ playing: false, onsetAt: 0, voicedMs: 0 }).action, 'report')
  assert.equal(shouldFallbackCut({ playing: false, reported: true, voicedMs: 2_000 }), false)
})

test('guest speech defaults to queue and never interrupts playback', () => {
  const decision = decideBargeIn({ lane: 'guest', playing: true })
  assert.equal(decision.action, 'queue')
  assert.equal(decision.finishSentence, false)
  assert.equal(decision.keepRemainder, false)
})

test('a sentence boundary keeps same-sentence blocks and preserves every later block', () => {
  const current = frame(7, 0, '正在念第一块')
  const queued = [
    frame(7, 1, '同一句第二块'),
    frame(7, 2, '同一句第三块'),
    frame(8, 0, '下一句旧回答'),
    frame(9, 0, '再下一句旧回答'),
  ]
  const plan = splitAtSentenceBoundary(current, queued)
  assert.deepEqual(plan.finish.map((item) => item.text), ['同一句第二块', '同一句第三块'])
  assert.deepEqual(plan.remainder.map((item) => item.text), ['下一句旧回答', '再下一句旧回答'])
  assert.equal(plan.stopAfterCurrent, true)
  assert.equal(plan.finish.length + plan.remainder.length, queued.length)
  assert.ok(isSameSentence(current, plan.finish[0]))
})

test('a frame without a sentence id is treated as a complete sentence', () => {
  const current = { sentenceId: undefined, text: '完整的一句' }
  const queued = [{ sentenceId: 2, text: '下一句' }]
  const plan = splitAtSentenceBoundary(current, queued)
  assert.deepEqual(plan.finish, [])
  assert.deepEqual(plan.remainder, queued)
})

test('owner new answer is placed before the preserved old remainder', () => {
  const fresh = [{ text: '主人新问题答案一' }, { text: '主人新问题答案二' }]
  const old = [{ text: '旧回答余下内容' }]
  const ordered = orderBargeInFrames(fresh, old)
  assert.deepEqual(ordered.map((item) => item.text), [
    '主人新问题答案一', '主人新问题答案二', '旧回答余下内容',
  ])
  assert.equal(ordered.length, fresh.length + old.length)
})

test('an explicit drop rule can discard the old remainder without resurrecting it', () => {
  const ordered = orderBargeInFrames([{ text: '新的' }], [{ text: '旧的' }], false)
  assert.deepEqual(ordered.map((item) => item.text), ['新的'])
})
