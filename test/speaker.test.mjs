import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSpeakerPrompt, parseSpeakerLines } from '../lib/speaker.js'

test('spoken lines drop bullets, headings and noise', () => {
  const raw = ['## 结论', '- 先说结论。', '1. 再说理由。', '', '***', '   ', '最后一句。'].join('\n')
  assert.deepEqual(parseSpeakerLines(raw), ['先说结论。', '再说理由。', '最后一句。'])
})

test('machine text never reaches the speaker', () => {
  const raw = ['D:\\work\\a.ts', 'src/index.ts', '好。'].join('\n')
  assert.deepEqual(parseSpeakerLines(raw), ['好。'])
})

test('the prompt carries what was already said and what to say', () => {
  const prompt = buildSpeakerPrompt('第一段。第二段。', ['开头。'], '你问的')
  assert.ok(prompt.includes('你问的'))
  assert.ok(prompt.includes('开头。'))
  assert.ok(prompt.includes('第一段。第二段。'))
})
