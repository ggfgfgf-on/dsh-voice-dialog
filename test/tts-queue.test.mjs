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
