import assert from 'node:assert/strict'
import test from 'node:test'
import { TtsQueue } from '../lib/tts-queue.js'

test('switching voices on an unopened queue is safe', async () => {
  const queue = new TtsQueue()
  await queue.setVoice('zh-CN-YunxiNeural')
  await queue.setVoice('zh-CN-XiaoxiaoNeural')
  await queue.close()
  assert.ok(true)
})

test('a failed synthesis emits a text frame for the system-voice fallback', async () => {
  const queue = new TtsQueue({ voice: 'zh-CN-XiaoxiaoNeural' })
  queue.tts = {
    setMetadata: async () => undefined,
    toStream: async () => { throw new Error('edge offline') },
    close: async () => undefined,
  }
  const frames = []
  queue.subscribe((frame) => frames.push(frame))
  queue.enqueue('session-test', '这一句不能被静默丢掉。')
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(frames.length, 1)
  assert.equal(frames[0].text, '这一句不能被静默丢掉。')
  assert.equal(frames[0].audio, '')
  assert.match(frames[0].error, /edge offline/)
  await queue.close()
})
