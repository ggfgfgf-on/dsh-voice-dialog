import test from 'node:test'
import assert from 'node:assert/strict'
import { parseQueueControl, stripVoicePrefix } from '../lib/queue-control.js'

test('strips speaker prefixes before parsing', () => {
  assert.equal(stripVoicePrefix('[声纹：我] 打断，先看这个'), '打断，先看这个')
  assert.equal(stripVoicePrefix('[声纹：客人1] [声纹：我] 忽略客人1'), '忽略客人1')
})

test('interrupt carries the remaining request', () => {
  assert.deepEqual(parseQueueControl('[声纹：我] 打断，先看这个'), { action: 'interrupt', rest: '先看这个' })
  assert.deepEqual(parseQueueControl('停一下'), { action: 'interrupt', rest: '' })
})

test('ignore resolves explicit and wildcard targets', () => {
  assert.deepEqual(parseQueueControl('[声纹：我] 忽略客人1'), { action: 'speaker', target: '客人1', policy: 'ignore' })
  assert.deepEqual(parseQueueControl('别理老婆'), { action: 'speaker', target: '老婆', policy: 'ignore' })
  assert.deepEqual(parseQueueControl('忽略所有人'), { action: 'speaker', target: '*', policy: 'ignore' })
  assert.deepEqual(parseQueueControl('忽略'), { action: 'speaker', target: '', policy: 'ignore' })
})

test('restore means queue, while negated interrupt is ignored', () => {
  assert.deepEqual(parseQueueControl('别忽略客人1'), { action: 'speaker', target: '客人1', policy: 'queue' })
  assert.deepEqual(parseQueueControl('恢复'), { action: 'speaker', target: '*', policy: 'queue' })
  assert.equal(parseQueueControl('不要打断我'), null)
  assert.equal(parseQueueControl('这个功能会打断我'), null)
})

test('ordinary speech is not a queue command', () => {
  assert.equal(parseQueueControl('[声纹：我] 今天天气不错'), null)
  assert.equal(parseQueueControl('我们继续做这个功能'), null)
})
