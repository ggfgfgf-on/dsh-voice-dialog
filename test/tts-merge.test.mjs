import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeSynthesisRun, TtsQueue } from '../lib/tts-queue.js'

const item = (text, replyId = 'reply-a') => ({ text, replyId, round: 0 })
const magicMp3 = () => Buffer.from([0xff, 0xfb, 0x90, 0x64])

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

async function until(predicate, timeoutMs = 1000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for TTS state')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('short consecutive lines merge into one synthesis run', () => {
  const run = mergeSynthesisRun([
    item('第一句。'),
    item('第二句。'),
    item('第三句。'),
  ])
  assert.deepEqual(run, { text: '第一句。第二句。第三句。', count: 3 })
})

test('a different reply id stops the merge', () => {
  const run = mergeSynthesisRun([
    item('第一句。', 'reply-a'),
    item('第二句。', 'reply-b'),
    item('第三句。', 'reply-b'),
  ])
  assert.deepEqual(run, { text: '第一句。', count: 1 })
})

test('a long line stops the merge at the queue head', () => {
  const long = '长'.repeat(41) + '。'
  assert.deepEqual(
    mergeSynthesisRun([item('短句。'), item(long), item('后句。')]),
    { text: '短句。', count: 1 },
  )
  assert.deepEqual(
    mergeSynthesisRun([item(long), item('短句。')]),
    { text: long, count: 1 },
  )
})

test('merge caps at six items and 160 characters', () => {
  const six = mergeSynthesisRun(Array.from({ length: 8 }, (_, index) => item('短句' + index + '。')))
  assert.equal(six.count, 6)

  const longLine = '字'.repeat(40)
  const limited = mergeSynthesisRun(Array.from({ length: 4 }, () => item(longLine)))
  assert.deepEqual(limited, { text: Array(3).fill(longLine).join('，'), count: 3 })
  assert.ok(Array.from(limited.text).length <= 160)
})

test('seam punctuation is joined without doubling', () => {
  assert.equal(mergeSynthesisRun([item('第一句。'), item('第二句。')]).text, '第一句。第二句。')
  assert.equal(mergeSynthesisRun([item('第一句'), item('第二句')]).text, '第一句，第二句')
  assert.equal(mergeSynthesisRun([item('第一句，'), item('第二句')]).text, '第一句，第二句')
  assert.equal(mergeSynthesisRun([item('第一句'), item('，第二句')]).text, '第一句，第二句')
  assert.equal(mergeSynthesisRun([item('第一句，'), item('。第二句')]).text, '第一句。第二句')
})

test('pump synthesizes a short run once and keeps items queued during the request', async () => {
  const queue = new TtsQueue({ voice: 'zh-CN-XiaoxiaoNeural', synthAttempts: 1 })
  const gate = deferred()
  const started = deferred()
  const calls = []
  queue.tts = {
    setMetadata: async () => undefined,
    toStream: async (text) => {
      calls.push(text)
      started.resolve()
      return {
        audioStream: (async function* () {
          await gate.promise
          yield magicMp3()
        })(),
      }
    },
    close: async () => undefined,
  }
  const frames = []
  queue.subscribe((frame) => frames.push(frame))

  queue.enqueue('session-merge', '第一句。', 'reply-merge')
  queue.enqueue('session-merge', '第二句。', 'reply-merge')
  await started.promise
  assert.deepEqual(queue.snapshot('session-merge'), {
    busy: true,
    active: true,
    pending: 1,
    items: [{ text: '第二句。', round: 0, replyId: 'reply-merge' }],
    text: '第一句。',
    replyId: 'reply-merge',
  })

  // This arrives while the merged request is in flight and must survive the
  // post-synthesis cleanup.
  queue.enqueue('session-merge', '第三句。', 'reply-merge')
  gate.resolve()
  await until(() => frames.length === 2)

  assert.deepEqual(calls, ['第一句。第二句。', '第三句。'])
  assert.equal(frames.length, 2)
  assert.equal(frames[0].text, '第一句。第二句。')
  assert.equal(frames[1].text, '第三句。')
  await queue.close()
})
