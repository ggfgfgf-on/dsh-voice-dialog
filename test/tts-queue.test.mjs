import assert from 'node:assert/strict'
import test from 'node:test'
import { rateToProsody, TtsQueue } from '../lib/tts-queue.js'

test('switching voices on an unopened queue is safe', async () => {
  const queue = new TtsQueue()
  await queue.setVoice('zh-CN-YunxiNeural')
  await queue.setVoice('zh-CN-XiaoxiaoNeural')
  await queue.close()
  assert.ok(true)
})

test('a failed synthesis emits a text frame for the system-voice fallback', async () => {
  const queue = new TtsQueue({ voice: 'zh-CN-XiaoxiaoNeural', synthAttempts: 1 })
  queue.tts = {
    setMetadata: async () => undefined,
    toStream: async () => { throw new Error('edge offline') },
    close: async () => undefined,
  }
  const frames = []
  queue.subscribe((frame) => frames.push(frame))
  queue.enqueue('session-test', '这一句不能被静默丢掉。', 'reply-test')
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(frames.length, 1)
  assert.equal(frames[0].replyId, 'reply-test')
  assert.equal(frames[0].text, '这一句不能被静默丢掉。')
  assert.equal(frames[0].audio, '')
  assert.match(frames[0].error, /edge offline/)
  await queue.close()
})

test('synthesized frames keep the reply id used by repeat', async () => {
  const queue = new TtsQueue({ voice: 'zh-CN-XiaoxiaoNeural' })
  queue.tts = {
    setMetadata: async () => undefined,
    toStream: async () => ({
      audioStream: (async function* () { yield Buffer.from([0xff, 0xfb, 0x90, 0x64]) })(),
    }),
    close: async () => undefined,
  }
  const frames = []
  queue.subscribe((frame) => frames.push(frame))
  queue.enqueue('session-test', '这一句会正常合成。', 'reply-ok')
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(frames.length, 1)
  assert.equal(frames[0].replyId, 'reply-ok')
  assert.ok(frames[0].audio.length > 0)
  await queue.close()
})
test('rate is forwarded to each synthesis call', async () => {
  assert.equal(rateToProsody(0), 'default')
  assert.equal(rateToProsody(20), '+20%')
  assert.equal(rateToProsody(-5), '-5%')
  assert.equal(rateToProsody(99), '+50%')
  const queue = new TtsQueue({ voice: 'zh-CN-XiaoxiaoNeural' })
  let seen
  queue.tts = {
    setMetadata: async () => undefined,
    toStream: async (_text, options) => {
      seen = options
      return { audioStream: (async function* () { yield Buffer.from([0xff, 0xfb, 0x90, 0x64]) })() }
    },
    close: async () => undefined,
  }
  queue.setRate(20)
  queue.enqueue('session-rate', '这一句用新的语速。', 'reply-rate')
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(seen.rate, '+20%')
  await queue.close()
})

test('block metadata survives the frame and a length-cut block gets a pause', async () => {
  const queue = new TtsQueue({ voice: 'zh-CN-XiaoxiaoNeural' })
  let synthesized = ''
  queue.tts = {
    setMetadata: async () => undefined,
    toStream: async (text) => {
      synthesized = text
      return { audioStream: (async function* () { yield Buffer.from([0xff, 0xfb, 0x90, 0x64]) })() }
    },
    close: async () => undefined,
  }
  const frames = []
  queue.subscribe((frame) => frames.push(frame))
  queue.enqueue('session-block', '没有标点的块', 'reply-block', 7, { sentenceId: 3, chunkIndex: 1 })
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(synthesized, '没有标点的块，')
  assert.equal(frames.length, 1)
  assert.equal(frames[0].text, '没有标点的块')
  assert.equal(frames[0].sentenceId, 3)
  assert.equal(frames[0].chunkIndex, 1)
  await queue.close()
})

test('a transient synthesis failure retries on a fresh attempt', async () => {
  const queue = new TtsQueue({ voice: 'zh-CN-XiaoxiaoNeural', synthAttempts: 2, retryDelayMs: 1 })
  let calls = 0
  queue.tts = {
    setMetadata: async () => undefined,
    toStream: async () => {
      calls++
      if (calls === 1) throw new Error('read ECONNRESET')
      return { audioStream: (async function* () { yield Buffer.from([0xff, 0xfb, 0x90, 0x64]) })() }
    },
    close: async () => undefined,
  }
  // Keep the mock in place: the production reset replaces this.tts with a real client.
  queue.resetConnection = () => undefined
  const frames = []
  queue.subscribe((frame) => frames.push(frame))
  queue.enqueue('session-retry', '第一次断线，第二次应该成功。', 'reply-retry')
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(calls, 2)
  assert.equal(frames.length, 1)
  assert.ok(frames[0].audio.length > 0)
  assert.equal(frames[0].error, undefined)
  await queue.close()
})

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

const magicMp3 = () => Buffer.from([0xff, 0xfb, 0x90, 0x64])

test('cancelReply drops only the targeted reply and keeps the active one', async () => {
  const queue = new TtsQueue({ voice: 'zh-CN-XiaoxiaoNeural', synthAttempts: 1 })
  const gate = deferred()
  const started = deferred()
  queue.tts = {
    setMetadata: async () => undefined,
    toStream: async (text) => {
      if (text.startsWith('第一句')) {
        started.resolve()
        return {
          audioStream: (async function* () {
            await gate.promise
            yield magicMp3()
          })(),
        }
      }
      return { audioStream: (async function* () { yield magicMp3() })() }
    },
    close: async () => undefined,
  }
  const frames = []
  queue.subscribe((frame) => frames.push(frame))
  queue.enqueue('session-cancel-pending', '第一句', 'reply-keep')
  queue.enqueue('session-cancel-pending', '第二句', 'reply-drop')
  await started.promise
  const result = queue.cancelReply('session-cancel-pending', 'reply-drop')
  assert.deepEqual(result, { pending: 1, active: false })
  gate.resolve()
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(frames.map((frame) => frame.replyId), ['reply-keep'])
  await queue.close()
})

test('cancelReply invalidates a sentence already inside the synthesizer', async () => {
  const queue = new TtsQueue({ voice: 'zh-CN-XiaoxiaoNeural', synthAttempts: 1 })
  const gate = deferred()
  const started = deferred()
  let first = true
  queue.tts = {
    setMetadata: async () => undefined,
    toStream: async () => {
      if (first) {
        first = false
        started.resolve()
        return {
          audioStream: (async function* () {
            yield magicMp3()
            await gate.promise
            yield magicMp3()
          })(),
        }
      }
      return { audioStream: (async function* () { yield magicMp3() })() }
    },
    close: async () => undefined,
  }
  const frames = []
  queue.subscribe((frame) => frames.push(frame))
  queue.enqueue('session-cancel-active', '旧回答', 'reply-old')
  await started.promise
  const result = queue.cancelReply('session-cancel-active', 'reply-old')
  assert.deepEqual(result, { pending: 1, active: true })
  gate.resolve()
  queue.enqueue('session-cancel-active', '新回答', 'reply-new')
  await new Promise((resolve) => setTimeout(resolve, 70))
  assert.deepEqual(frames.map((frame) => frame.replyId), ['reply-new'])
  await queue.close()
})

test('cancel stops the whole session and reports active plus pending work', async () => {
  const queue = new TtsQueue({ voice: 'zh-CN-XiaoxiaoNeural', synthAttempts: 1 })
  const gate = deferred()
  const started = deferred()
  queue.tts = {
    setMetadata: async () => undefined,
    toStream: async () => {
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
  queue.enqueue('session-cancel-all', '第一句', 'reply-a')
  queue.enqueue('session-cancel-all', '第二句', 'reply-b')
  await started.promise
  const result = queue.cancel('session-cancel-all')
  assert.deepEqual(result, { pending: 2, active: true })
  gate.resolve()
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(frames, [])
  await queue.close()
})

test('snapshot exposes the current sentence and the waiting count', async () => {
  const queue = new TtsQueue({ voice: 'zh-CN-XiaoxiaoNeural', synthAttempts: 1 })
  const gate = deferred()
  const started = deferred()
  queue.tts = {
    setMetadata: async () => undefined,
    toStream: async () => {
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
  queue.enqueue('session-state', '正在合成的一句', 'reply-state')
  queue.enqueue('session-state', '后面排队的一句', 'reply-state')
  await started.promise
  assert.deepEqual(queue.snapshot('session-state'), {
    busy: true,
    active: true,
    pending: 1,
    text: '正在合成的一句',
    replyId: 'reply-state',
  })
  queue.cancel('session-state')
  gate.resolve()
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(queue.snapshot('session-state'), {
    busy: false,
    active: false,
    pending: 0,
  })
  await queue.close()
})
