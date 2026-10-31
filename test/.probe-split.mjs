
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts'
import { writeFileSync } from 'node:fs'
const VOICE = 'zh-CN-XiaoxiaoNeural'
const doc = (inner) => '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN"><voice name="' + VOICE + '">' + inner + '</voice></speak>'
const out = {}
const client = new MsEdgeTTS()
await client.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3)
const cases = {
  whole: '我真的不知道你在说什么',
  halfA: '我真的不知道',
  halfB: '你在说什么',
}
for (const [name, text] of Object.entries(cases)) {
  const { audioStream } = await client.toStream(text, { rate: 'default', pitch: 'default', volume: 'default' })
  const parts = []
  for await (const p of audioStream) parts.push(Buffer.from(p))
  out[name] = Buffer.concat(parts).length
  writeFileSync('D:/DSHwork/voice-samples/split-' + name + '.mp3', Buffer.concat(parts))
  await new Promise((r) => setTimeout(r, 300))
}
await client.close()
console.log(JSON.stringify(out))
