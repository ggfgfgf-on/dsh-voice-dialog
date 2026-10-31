
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts'
import { writeFileSync } from 'node:fs'
import { normalizeVoiceUnits, expressionSsmlChunks } from '../lib/expression.js'
const VOICE = 'zh-CN-XiaoxiaoNeural'
const BASE = { rate: 0, pitch: 0, volume: 0 }
const doc = (inner) => '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN"><voice name="' + VOICE + '">' + inner + '</voice></speak>'
const text = '我真的不知道你在说什么'
const unit = normalizeVoiceUnits([{ say: text, granularity: 'fine', curve: { pitch: [0, 4, 8, 12, 8, 4, 0, -4, -8, -4, 0] } }])[0]
const chunks = expressionSsmlChunks(unit, BASE)
console.log('chunks=' + chunks.length)
const client = new MsEdgeTTS()
await client.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3)
const parts = []
for (const chunk of chunks) {
  const { audioStream } = await client.rawToStream(doc(chunk.ssml))
  for await (const p of audioStream) parts.push(Buffer.from(p))
  await new Promise((r) => setTimeout(r, 300))
}
const one = await client.toStream(text, { rate: 'default', pitch: 'default', volume: 'default' })
const single = []
for await (const p of one.audioStream) single.push(Buffer.from(p))
await client.close()
writeFileSync('D:/DSHwork/voice-samples/curve-chunked.mp3', Buffer.concat(parts))
writeFileSync('D:/DSHwork/voice-samples/curve-single.mp3', Buffer.concat(single))
console.log('chunkedBytes=' + Buffer.concat(parts).length + ' singleBytes=' + Buffer.concat(single).length)
