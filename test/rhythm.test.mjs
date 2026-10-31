import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  baseGapMs, rhythmGapMs, RHYTHM_DEFAULTS, splitInnerPause, trimSpoken, variationOf,
} from '../lib/rhythm.js'
import {
  DEFAULT_SPEECH_PROFILE, normalizeSpeechProfile, resolveSpeechProfile,
} from '../lib/speech-profile.js'
import { SentenceSegmenter } from '../lib/segmenter.js'
import { buildSpeakerPrompt } from '../lib/speaker.js'
import { FastLaneServo } from '../lib/fast-lane.js'

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('rhythm: a sentence end pauses longer than a comma cut', () => {
  const sentence = rhythmGapMs('我先看一下这个。')
  const clause = rhythmGapMs('我先看一下这个，')
  const breath = rhythmGapMs('我先看一下这个')
  assert.ok(sentence > clause, sentence + ' > ' + clause)
  assert.ok(clause > breath, clause + ' > ' + breath)
  assert.ok(sentence >= 150 && sentence <= 320, String(sentence))
  assert.ok(clause >= 50 && clause <= 140, String(clause))
})

test('rhythm: gaps vary by text and stay deterministic', () => {
  const a = rhythmGapMs('好的。')
  const b = rhythmGapMs('好的。')
  assert.equal(a, b)
  const values = new Set()
  for (const text of ['第一句。', '第二句话。', '第三句长一点的话。', '再来一句。']) {
    values.add(rhythmGapMs(text))
  }
  assert.ok(values.size > 1, 'gaps must not be a metronome')
  assert.equal(variationOf('同一个句子', 0, 0), 0)
})

test('rhythm: empty text and zero settings never invent a pause', () => {
  assert.equal(rhythmGapMs(''), 0)
  assert.equal(rhythmGapMs('   '), 0)
  assert.equal(rhythmGapMs('好的。', { sentenceMs: 0, clauseMs: 0 }), 0)
  assert.ok(rhythmGapMs('好的。', { maxMs: 50 }) <= 50)
  assert.equal(trimSpoken('好的。”'), '好的。')
  assert.equal(trimSpoken('“好的。”'), '“好的。')
  assert.equal(baseGapMs('嗯，'), RHYTHM_DEFAULTS.clauseMs)
})

test('rhythm: inner pause is opt-in and splits at the middle comma', () => {
  assert.equal(splitInnerPause('这一句很长，需要中间换口气，才能说完'), undefined)
  const seam = splitInnerPause('这一句很长，需要中间换口气，才能说完', { innerMs: 140 })
  assert.ok(seam, 'declared inner pause must split')
  assert.ok(seam.head.endsWith('，'), seam.head)
  assert.ok(seam.tail.length > 3, seam.tail)
  assert.ok(seam.gapMs > 0 && seam.gapMs <= RHYTHM_DEFAULTS.maxMs, String(seam.gapMs))
  assert.equal(splitInnerPause('没有标点的长句子需要中间换口气才能说完', { innerMs: 140 }), undefined)
  assert.equal(splitInnerPause('短短一句，', { innerMs: 140 }), undefined)
})

test('speech profile: the new knobs default to today\'s behaviour', () => {
  assert.equal(DEFAULT_SPEECH_PROFILE.rhythm, 'natural')
  assert.equal(DEFAULT_SPEECH_PROFILE.innerPauseMs, 0)
  assert.equal(DEFAULT_SPEECH_PROFILE.backchannel, '')
  assert.equal(DEFAULT_SPEECH_PROFILE.backchannelAfterMs, 0)
  assert.equal(DEFAULT_SPEECH_PROFILE.warmOpen, false)
  assert.equal(DEFAULT_SPEECH_PROFILE.chunkMaxChars, 0)
  assert.equal(DEFAULT_SPEECH_PROFILE.firstBlockChars, 8)
  assert.equal(DEFAULT_SPEECH_PROFILE.firstBlockDeadlineMs, 0)
  // Nothing declared: the resolved profile is byte-for-byte the default.
  assert.deepEqual(resolveSpeechProfile(), { ...DEFAULT_SPEECH_PROFILE })
  assert.deepEqual(normalizeSpeechProfile({}), {})
})

test('speech profile: new knobs are validated and clamped', () => {
  const declared = normalizeSpeechProfile({
    rhythm: 'off', innerPauseMs: 900, backchannel: '嗯', backchannelAfterMs: 9000,
    warmOpen: true, firstBlockChars: 1, firstBlockDeadlineMs: 9000,
  })
  assert.equal(declared.rhythm, 'off')
  assert.equal(declared.innerPauseMs, 400)
  assert.equal(declared.backchannel, '嗯')
  assert.equal(declared.backchannelAfterMs, 5000)
  assert.equal(declared.warmOpen, true)
  assert.equal(declared.firstBlockChars, 4)
  assert.equal(declared.firstBlockDeadlineMs, 2000)
  const garbage = normalizeSpeechProfile({
    rhythm: 'fast', backchannel: 42, warmOpen: 'yes', firstBlockChars: 'x',
  })
  assert.deepEqual(garbage, {})
  // The wording is the model's: any short line survives, nothing is preselected.
  assert.equal(normalizeSpeechProfile({ backchannel: '  对 我 在 听  ' }).backchannel, '对 我 在 听')
  assert.equal(normalizeSpeechProfile({ backchannel: '嗯' }).backchannel, '嗯')
  assert.equal(normalizeSpeechProfile({ backchannel: '长'.repeat(40) }).backchannel.length, 24)
  assert.equal(normalizeSpeechProfile({ backchannel: 'none' }).backchannel, '')
})

test('segmenter: forcePartial releases early without punctuation', () => {
  const segmenter = new SentenceSegmenter({ firstClauseChars: 8 })
  assert.deepEqual(segmenter.forcePartial(4), [])
  segmenter.feedBlocks('这个我得先想想')
  const released = segmenter.forcePartial(4)
  assert.equal(released.length, 1)
  assert.equal(released[0].text, '这个我得先想想')
  assert.equal(released[0].sentenceId, 0)
  assert.equal(released[0].chunkIndex, 0)
  // The released text is gone from the buffer, so the stream cannot repeat it.
  assert.deepEqual(segmenter.flushBlocks(), [])
})

test('segmenter: forcePartial refuses a fragment too short to be speech', () => {
  const segmenter = new SentenceSegmenter({ firstClauseChars: 8 })
  segmenter.feedBlocks('好')
  assert.deepEqual(segmenter.forcePartial(4), [])
  assert.equal(segmenter.flushBlocks().length, 1)
})

test('speaker prompt: warm open is opt-in and adds exactly one rule', () => {
  const plain = buildSpeakerPrompt('回答正文', [])
  const warm = buildSpeakerPrompt('回答正文', [], undefined, undefined, { warmOpen: true })
  assert.equal(plain.includes('接话方式'), false)
  assert.equal(warm.includes('接话方式'), true)
  assert.ok(warm.includes('半句'), 'the rule must ask for a half sentence')
})

test('servo placeholder: said once, only when declared', async () => {
  const said = []
  const servo = new FastLaneServo({
    say: (line) => said.push(line),
    now: () => 1000,
    startAt: 0,
    placeholder: { text: '嗯', afterMs: 300 },
  })
  await wait(20)
  servo.stop('test')
  assert.deepEqual(said, ['嗯'])

  const silent = []
  const quiet = new FastLaneServo({ say: (line) => silent.push(line), now: () => 1000, startAt: 0 })
  await wait(20)
  quiet.stop('test')
  assert.deepEqual(silent, [])

  // No declared time: nothing is fixed, the servo's own first opening decides.
  const floating = []
  const open = new FastLaneServo({
    say: (line) => floating.push(line),
    now: () => 0,
    startAt: 0,
    placeholder: { text: '我在想' },
  })
  await wait(20)
  open.stop('test')
  assert.deepEqual(floating, [], 'it must not jump the queue before the wait is real')
})

test('servo placeholder: a stop before the delay keeps it quiet', async () => {
  const said = []
  const servo = new FastLaneServo({
    say: (line) => said.push(line),
    now: () => 0,
    startAt: 0,
    placeholder: { text: '在', afterMs: 500 },
  })
  servo.stop('answer')
  await wait(20)
  assert.deepEqual(said, [])
})
