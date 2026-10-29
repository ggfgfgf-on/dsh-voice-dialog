
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts'
import { normalizeVoiceUnits, expressionProsody, expressionSsmlChunks, applyExpression } from '../lib/expression.js'
const VOICE = 'zh-CN-XiaoxiaoNeural'
const BASE = { rate: 0, pitch: 0, volume: 0 }
const doc = (inner) => '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" '
  + 'xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="zh-CN"><voice name="' + VOICE + '">' + inner + '</voice></speak>'
const cases = {
  coy: [{ say: '你就答应我嘛，好不好呀。', tone: 'bright', pace: 'slower', mark: [
    { at: 5, pitch: 10 }, { at: 8, pitch: 12 }, { at: 9, pitch: 20 }, { at: 10, pitch: 28 }] }],
  expect: [{ say: '明天就要出发了，你兴奋吗？', tone: 'bright', mark: [{ at: 9, to: 12, pitch: 16 }] }],
  hesitate: [{ say: '我觉得……', pace: 'slower' }, { pause: 'long' }, { say: '大概……', pace: 'slower' }, { pause: 'beat' }, { say: '也许可以吧。', tone: 'soft' }],
  rising: [{ say: '一二三四五六。', mark: [{ at: 0, pitch: -12 }, { at: 1, pitch: -7 }, { at: 2, pitch: -2 }, { at: 3, pitch: 4 }, { at: 4, pitch: 10 }, { at: 5, pitch: 18 }] }],
}
const k = String(process.argv[2])
const units = normalizeVoiceUnits(cases[k])
const chunks = units.flatMap((unit) => {
  const c = expressionSsmlChunks(unit, BASE)
  return c === undefined ? [{ text: applyExpression(unit), ssml: undefined, prosody: expressionProsody(unit, BASE) }] : c
})
console.log(k + ' chunks=' + chunks.length)
for (const [i, chunk] of chunks.entries()) {
  const client = new MsEdgeTTS()
  try {
    await client.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3)
    const { audioStream } = chunk.ssml === undefined
      ? await client.toStream(chunk.text, chunk.prosody)
      : await client.rawToStream(doc(chunk.ssml))
    const parts = []
    for await (const p of audioStream) parts.push(Buffer.from(p))
    console.log('  chunk ' + i + ' ok ' + Buffer.concat(parts).length + ' | ' + (chunk.ssml === undefined ? chunk.text : chunk.ssml).slice(0, 70))
  } catch (e) {
    console.log('  chunk ' + i + ' FAIL ' + String(e).slice(0, 90))
  }
  await client.close()
  await new Promise((r) => setTimeout(r, 400))
}
