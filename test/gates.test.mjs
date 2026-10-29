import test from 'node:test'
import assert from 'node:assert/strict'
import { echoGate, noiseGate } from '../lib/gates.js'

test('guest fillers are noise, the same word from the owner is not', () => {
  for (const text of ['嗯', '啊', '呃', '嗯嗯', '哦。']) assert.equal(noiseGate('guest', text).drop, true, text)
  for (const text of ['嗯', '啊', '好']) assert.equal(noiseGate('owner', text).drop, false, text)
})

test('a lone short latin word from a guest is noise, a sentence is not', () => {
  for (const text of ['The.', 'Yeah!', 'ok', ' Uh ']) assert.equal(noiseGate('guest', text).drop, true, text)
  assert.equal(noiseGate('guest', '等一下').drop, false)
  assert.equal(noiseGate('guest', '3 个').drop, false)
  assert.equal(noiseGate('guest', '这个不要').drop, false)
})

test('explicit commands are never noise whoever says them', () => {
  for (const text of ['停一下', '打断', '别说这个了', '先停']) assert.equal(noiseGate('guest', text).drop, false, text)
})

test('the speaker prefix is not part of the content', () => {
  assert.equal(noiseGate('guest', '[声纹：客人1] The.').drop, true)
  assert.equal(noiseGate('guest', '[声纹：客人1] 明天几点开会').drop, false)
})

test('echo of the sentence just spoken is dropped', () => {
  const spoken = [{ text: '分离模型现在走显卡，一次推理三百七十四毫秒', at: 1000 }]
  const verdict = echoGate('分离模型现在走显卡 一次推理三百七十四毫秒', spoken, 2000)
  assert.equal(verdict.drop, true)
  assert.equal(verdict.reason, 'echo-contained')
})

test('a short genuine follow-up survives the echo gate', () => {
  const spoken = [{ text: '分离模型现在走显卡，一次推理三百七十四毫秒', at: 1000 }]
  assert.equal(echoGate('那识别呢', spoken, 2000).drop, false)
  assert.equal(echoGate('显卡是哪个', spoken, 2000).drop, false)
})

test('speech older than the window cannot cause a drop', () => {
  const spoken = [{ text: '分离模型现在走显卡，一次推理三百七十四毫秒', at: 1000 }]
  assert.equal(echoGate('分离模型现在走显卡，一次推理三百七十四毫秒', spoken, 20_000).drop, false)
})

test('repeat and interrupt commands are never echo-dropped', () => {
  const spoken = [{ text: '再说一遍刚才那句分离模型的性能', at: 1000 }]
  assert.equal(echoGate('再说一遍刚才那句分离模型的性能', spoken, 2000).drop, false)
})
