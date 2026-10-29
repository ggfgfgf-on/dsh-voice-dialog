import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_SPEECH_PROFILE, normalizeSpeechProfile, resolveSpeechProfile } from '../lib/speech-profile.js'
import { DEFAULT_SYNTHESIS_LIMITS, mergeSynthesisRun } from '../lib/tts-queue.js'

const DEFAULT_PROFILE = {
  interruption: 'sentence',
  mergeMaxChars: 40,
  mergeRunMaxChars: 160,
  mergeRunMaxItems: 6,
  betweenBlocksMs: 0,
  micSilenceMs: 900,
  separationSilenceMs: 1600,
}

test('no declaration resolves to exactly today\'s behaviour', () => {
  assert.deepEqual(DEFAULT_SPEECH_PROFILE, DEFAULT_PROFILE)
  assert.deepEqual(resolveSpeechProfile(null), DEFAULT_PROFILE)
  assert.deepEqual(resolveSpeechProfile(undefined, undefined), DEFAULT_PROFILE)
})

test('the queue defaults cannot drift from the profile defaults', () => {
  assert.equal(DEFAULT_SYNTHESIS_LIMITS.mergeMaxChars, DEFAULT_SPEECH_PROFILE.mergeMaxChars)
  assert.equal(DEFAULT_SYNTHESIS_LIMITS.mergeRunMaxChars, DEFAULT_SPEECH_PROFILE.mergeRunMaxChars)
  assert.equal(DEFAULT_SYNTHESIS_LIMITS.mergeRunMaxItems, DEFAULT_SPEECH_PROFILE.mergeRunMaxItems)
})

test('normalize drops garbage, unknown keys and clamps out-of-range numbers', () => {
  assert.deepEqual(normalizeSpeechProfile(null), {})
  assert.deepEqual(normalizeSpeechProfile([]), {})
  assert.deepEqual(normalizeSpeechProfile('loud'), {})
  assert.deepEqual(
    normalizeSpeechProfile({
      interruption: 'loud',
      mergeMaxChars: 'x',
      mergeRunMaxItems: 0,
      mergeRunMaxChars: 99999,
      betweenBlocksMs: -5,
      micSilenceMs: 12345,
      separationSilenceMs: 250.4,
      bogus: 1,
    }),
    {
      mergeRunMaxItems: 1,
      mergeRunMaxChars: 1200,
      betweenBlocksMs: 0,
      micSilenceMs: 4000,
      separationSilenceMs: 400,
    },
  )
  assert.deepEqual(normalizeSpeechProfile({ interruption: 'immediate' }), { interruption: 'immediate' })
})

test('resolve lets a declaration win field by field and keeps the rest', () => {
  const resolved = resolveSpeechProfile({ mergeMaxChars: 80, betweenBlocksMs: 150 })
  assert.equal(resolved.mergeMaxChars, 80)
  assert.equal(resolved.betweenBlocksMs, 150)
  assert.equal(resolved.mergeRunMaxChars, DEFAULT_PROFILE.mergeRunMaxChars)
  assert.equal(resolved.interruption, 'sentence')

  const layered = resolveSpeechProfile({ micSilenceMs: 700 }, { micSilenceMs: 1200, mergeMaxChars: 60 })
  assert.equal(layered.micSilenceMs, 700)
  assert.equal(layered.mergeMaxChars, 60)
})

test('a declared larger cap merges more than the default; the default is unchanged', () => {
  const line = '字'.repeat(30)
  const items = Array.from({ length: 8 }, () => ({ text: line, replyId: 'reply-a', round: 0 }))

  const byDefault = mergeSynthesisRun(items)
  assert.ok(byDefault.count < 8)
  assert.ok(Array.from(byDefault.text).length <= 160)

  const declared = mergeSynthesisRun(items, {
    mergeMaxChars: 100,
    mergeRunMaxChars: 300,
    mergeRunMaxItems: 16,
  })
  assert.equal(declared.count, 8)
  assert.ok(Array.from(declared.text).length <= 300)
  assert.ok(declared.count > byDefault.count)
})

test('existing default fixtures still merge the same way', () => {
  const item = (text, replyId = 'reply-a') => ({ text, replyId, round: 0 })
  assert.deepEqual(
    mergeSynthesisRun([item('第一句。'), item('第二句。'), item('第三句。')]),
    { text: '第一句。第二句。第三句。', count: 3 },
  )
  assert.equal(mergeSynthesisRun(Array.from({ length: 8 }, (_, i) => item('短句' + i + '。'))).count, 6)
})
