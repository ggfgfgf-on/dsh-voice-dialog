import assert from 'node:assert/strict'
import test from 'node:test'
import { VoiceProtocol, parseVoiceCommand } from '../lib/voice-protocol.js'

test('parses say, volume, repeat and stop directives', () => {
  assert.deepEqual(parseVoiceCommand('你好，我是小晓。'), { action: 'say', text: '你好，我是小晓。' })
  assert.deepEqual(parseVoiceCommand('volume +0.15'), { action: 'volume', delta: 0.15 })
  assert.deepEqual(parseVoiceCommand('volume -0.2'), { action: 'volume', delta: -0.2 })
  assert.deepEqual(parseVoiceCommand('volume = 0.6'), { action: 'volume', level: 0.6 })
  assert.deepEqual(parseVoiceCommand('volume down'), { action: 'volume', delta: -0.15 })
  assert.deepEqual(parseVoiceCommand('repeat'), { action: 'repeat' })
  assert.deepEqual(parseVoiceCommand('stop'), { action: 'stop' })
})

test('streaming parser tolerates markers split across reasoning deltas', () => {
  const parser = new VoiceProtocol()
  assert.deepEqual(parser.feed('先想一下 [[vo'), [])
  assert.deepEqual(parser.feed('ice: 这句话要读出来'), [])
  assert.deepEqual(parser.feed(']] 再继续'), [{ action: 'say', text: '这句话要读出来' }])
  assert.deepEqual(parser.feed('[[voice: volume +0.1]][[voice: stop]]'), [
    { action: 'volume', delta: 0.1 },
    { action: 'stop' },
  ])
  parser.flush()
})

test('accepts a full-width colon in a voice marker', () => {
  const parser = new VoiceProtocol()
  assert.deepEqual(parser.feed('[[voice：这句话要读出来]]'), [{ action: 'say', text: '这句话要读出来' }])
  parser.flush()
})

test('ordinary chain-of-thought text is not spoken', () => {
  const parser = new VoiceProtocol()
  assert.deepEqual(parser.feed('用户问的是天气，我需要先检查温度。'.repeat(20)), [])
  assert.deepEqual(parser.feed('继续推理'), [])
  parser.flush()
})
