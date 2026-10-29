
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts'
import { normalizeVoiceUnits, expressionProsody, expressionSsmlChunks, applyExpression } from '../lib/expression.js'
const VOICE = 'zh-CN-XiaoxiaoNeural'
const BASE = { rate: 0, pitch: 0, volume: 0 }
const doc = (inner) => '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" '
  + 'xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="zh-CN"><voice name="' + VOICE + '">' + inner + '</voice></speak>'
const SENTENCE = '那我先走了，回头见。'
const cases = {
  plain: { say: SENTENCE, style: 'tender' },
  tail22: { say: SENTENCE, style: 'tender', mark: [{ at: 5, to: 8, rate: -22 }] },
  tail32: { say: SENTENCE, style: 'tender', mark: [{ at: 5, to: 8, rate: -32 }] },
  tail45: { say: SENTENCE, style: 'tender', mark: [{ at: 5, to: 8, rate: -45 }] },
}
async function bytesOf(unit) {
  const c = new MsEdgeTTS()
  try {
    await c.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3)
    const prosody = expressionProsody(unit, BASE)
    const chunks = expressionSsmlChunks(unit, BASE)
    let total = 0
    if (chunks === undefined) {
      const { audioStream } = await c.toStream(applyExpression(unit), prosody)
      for await (const p of audioStream) total += p.length
    } else {
      for (const chunk of chunks) {
        const { audioStream } = await c.rawToStream(doc(chunk.ssml))
        for await (const p of audioStream) total += p.length
      }
    }
    return { total, chunks: chunks === undefined ? 1 : chunks.length }
  } finally { await c.close() }
}
for (const [name, row] of Object.entries(cases)) {
  const unit = normalizeVoiceUnits([row])[0]
  try {
    const r = await bytesOf(unit)
    console.log(name + ' bytes=' + r.total + ' chunks=' + r.chunks + ' approx=' + Math.round(r.total / 12000 * 1000) + 'ms')
  } catch (e) { console.log(name + ' FAIL ' + String(e).slice(0, 60)) }
  await new Promise((r) => setTimeout(r, 400))
}
