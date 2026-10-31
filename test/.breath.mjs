
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts'
import { writeFileSync } from 'node:fs'
import { normalizeVoiceUnits, expressionProsody, expressionSsmlChunks, applyExpression } from '../lib/expression.js'
const VOICE = 'zh-CN-XiaoxiaoNeural'
const BASE = { rate: 0, pitch: 0, volume: 0 }
const doc = (inner) => '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN"><voice name="' + VOICE + '">' + inner + '</voice></speak>'
const OUT = 'D:/DSHwork/voice-samples'
const lines = ['嘘', '别出声', '轻一点', '慢些走', '我们过去', '安静']
let i = 0
for (const line of lines) {
  const unit = normalizeVoiceUnits([{ say: line, style: 'whisper', volume: -30, rate: -28 }])[0]
  const prosody = expressionProsody(unit, BASE)
  const client = new MsEdgeTTS()
  try {
    await client.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3)
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
    writeFileSync(OUT + '/breath' + i + '.mp3', Buffer.concat(parts))
    console.log('breath' + i + ' ' + line + ' bytes=' + Buffer.concat(parts).length)
  } finally { await client.close() }
  i += 1
  await new Promise((r) => setTimeout(r, 400))
}
