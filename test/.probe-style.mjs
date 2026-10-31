
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts'
const VOICE = 'zh-CN-XiaoxiaoNeural'
const TEXT = '别出声，我们悄悄过去。'
const doc = (inner) => '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" '
  + 'xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="zh-CN"><voice name="' + VOICE + '">' + inner + '</voice></speak>'
const cases = {
  plain: TEXT,
  whisper: '<mstts:express-as style="whispering">' + TEXT + '</mstts:express-as>',
  gentle: '<mstts:express-as style="gentle">' + TEXT + '</mstts:express-as>',
  calm: '<mstts:express-as style="calm" styledegree="1.5">' + TEXT + '</mstts:express-as>',
}
const which = String(process.argv[2] || 'whisper')
const client = new MsEdgeTTS()
try {
  await client.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3)
  const { audioStream } = await client.rawToStream(doc(cases[which]))
  const parts = []
  for await (const p of audioStream) parts.push(Buffer.from(p))
  console.log(which + ' OK ' + Buffer.concat(parts).length)
} catch (e) { console.log(which + ' ERROR ' + String(e).slice(0, 110)) }
await client.close()
