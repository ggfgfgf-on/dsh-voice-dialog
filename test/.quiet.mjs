
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts'
import { writeFileSync } from 'node:fs'
import { normalizeVoiceUnits, expressionProsody, expressionSsmlChunks, applyExpression } from '../lib/expression.js'
const VOICE = 'zh-CN-XiaoxiaoNeural'
const BASE = { rate: 0, pitch: 0, volume: 0 }
const doc = (inner) => '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" '
  + 'xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="zh-CN"><voice name="' + VOICE + '">' + inner + '</voice></speak>'
const OUT = 'D:/DSHwork/voice-samples'
const cases = [
  { file: '91-低语-更小声30', row: { say: '别出声，我们悄悄过去。', style: 'whisper', volume: -22 } },
  { file: '92-低语-更小声40', row: { say: '别出声，我们悄悄过去。', style: 'whisper', volume: -32 } },
]
async function synth(unit) {
  const client = new MsEdgeTTS()
  try {
    await client.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3)
    const prosody = expressionProsody(unit, BASE)
    const chunks = expressionSsmlChunks(unit, BASE)
    const parts = []
    if (chunks === undefined) {
      const { audioStream } = await client.toStream(applyExpression(unit), prosody)
      for await (const p of audioStream) parts.push(Buffer.from(p))
    } else {
      for (const chunk of chunks) {
        const { audioStream } = await client.rawToStream(doc(chunk.ssml))
        for await (const p of audioStream) parts.push(Buffer.from(p))
      }
    }
    return Buffer.concat(parts)
  } finally { await client.close() }
}
for (const item of cases) {
  const unit = normalizeVoiceUnits([item.row])[0]
  const prosody = expressionProsody(unit, BASE)
  const buf = await synth(unit)
  writeFileSync(OUT + '/' + item.file + '.mp3', buf)
  console.log(item.file + ' volume=' + prosody.volume + ' bytes=' + buf.length)
  await new Promise((r) => setTimeout(r, 400))
}
