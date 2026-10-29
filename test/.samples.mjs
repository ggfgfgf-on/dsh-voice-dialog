
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { normalizeVoiceUnits, expressionProsody, expressionSsmlChunks, applyExpression, pauseMsFor } from '../lib/expression.js'

const VOICE = 'zh-CN-XiaoxiaoNeural'
const BASE = { rate: 0, pitch: 0, volume: 0 }
const OUT = 'D:/DSHwork/voice-samples'
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const doc = (inner) => '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" '
  + 'xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="zh-CN"><voice name="' + VOICE + '">' + inner + '</voice></speak>'

const samples = [
  { name: '温柔', units: [{ say: '你慢慢来，我在这儿等你。', style: 'tender' }] },
  { name: '撒娇', units: [{ say: '你就答应我嘛，好不好呀。', style: 'coy' }] },
  { name: '开心', units: [{ say: '太好了，我就知道你能行！', style: 'happy' }] },
  { name: '惊讶', units: [{ say: '真的吗？你居然真的做到了。', style: 'surprised' }] },
  { name: '委屈', units: [{ say: '我明明已经尽力了嘛。', style: 'hurt' }] },
  { name: '害羞', units: [{ say: '那个，我其实有点喜欢你。', style: 'shy' }] },
  { name: '认真', units: [{ say: '这件事我来处理，你放心。', style: 'serious' }] },
  { name: '严肃', units: [{ say: '这个决定，你最好再想一遍。', style: 'stern' }] },
  { name: '急促', units: [{ say: '快点快点，真的来不及了！', style: 'hurried' }] },
  { name: '困倦', units: [{ say: '再让我睡五分钟。', style: 'sleepy' }] },
  { name: '俏皮', units: [{ say: '你猜猜看，我藏了什么好东西。', style: 'playful' }] },
  { name: '安慰', units: [{ say: '没事的，都会过去的。', style: 'comforting' }] },
  { name: '失望', units: [{ say: '算了，那下次再说吧。', style: 'disappointed' }] },
  { name: '低语', units: [{ say: '别出声，我们悄悄过去。', style: 'whisper' }] },
  { name: '犹豫', units: [
    { say: '我觉得……', style: 'hesitant' }, { pause: 'long' },
    { say: '大概……', style: 'hesitant' }, { pause: 'beat' },
    { say: '也许可以吧。', style: 'hesitant' },
  ] },
  { name: '笑意', units: [{ say: '你这也太逗了，我笑个不停。', style: 'amused' }] },
  { name: '逐字上扬', units: [{ say: '一二三四五六。', mark: [
    { at: 0, pitch: -14 }, { at: 1, pitch: -8 }, { at: 2, pitch: -3 },
    { at: 3, pitch: 4 }, { at: 4, pitch: 11 }, { at: 5, pitch: 18 }] }] },
  { name: '逐字下落', units: [{ say: '十、九、八、七。', mark: [
    { at: 0, pitch: 18 }, { at: 2, pitch: 9 }, { at: 4, pitch: 0 }, { at: 6, pitch: -12 }] }] },
  { name: '句内先快后慢', units: [{ say: '前面我走得很快，后面就慢下来了。', mark: [
    { at: 0, to: 8, rate: 22 }, { at: 8, to: 14, rate: -18 }] }] },
  { name: '句内先慢后快', units: [{ say: '前面我走得很慢，后面就快起来了。', mark: [
    { at: 0, to: 8, rate: -18 }, { at: 8, to: 14, rate: 22 }] }] },
  { name: '拖长句尾', units: [{ say: '那我先走了，回头见。', lengthen: true, style: 'tender' }] },
  { name: '同样句子加停顿', units: [{ say: '那我先走了，回头见。', style: 'tender' }, { pause: 'long' }] },
  { name: '重音', units: [{ say: '我说的是明天，不是今天。', stress: ['明天'] }] },
  { name: '换气', units: [{ say: '好，我准备好了。', breath: true, style: 'comforting' }] },
  { name: '学舌', units: [{ say: '真的真的真的，我没骗你。', pace: 'faster' }] },
  { name: '慢速样句', units: [{ say: '我们今天下午三点出发。', pace: 'slower' }] },
  { name: '快速样句', units: [{ say: '我们今天下午三点出发。', pace: 'faster' }] },
  { name: '中性样句', units: [{ say: '我们今天下午三点出发。' }] },
]

async function request(fn, attempt = 0) {
  const client = new MsEdgeTTS()
  try {
    await client.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3)
    const { audioStream } = await fn(client)
    const parts = []
    for await (const part of audioStream) parts.push(Buffer.from(part))
    const buf = Buffer.concat(parts)
    if (buf.length < 300) throw new Error('empty audio')
    return buf
  } catch (error) {
    if (attempt < 2) { await sleep(1500); return request(fn, attempt + 1) }
    throw error
  } finally { try { await client.close() } catch {} }
}

const manifest = []
for (const [index, sample] of samples.entries()) {
  const id = String(index + 1).padStart(2, '0') + '-' + sample.name
  const parts = []
  try {
    for (const unit of normalizeVoiceUnits(sample.units)) {
      if (unit.pause !== undefined) { parts.push({ kind: 'silence', ms: pauseMsFor(unit.pause) }); continue }
      const prosody = expressionProsody(unit, BASE)
      const chunks = expressionSsmlChunks(unit, BASE)
      if (chunks === undefined) {
        const text = applyExpression(unit)
        const file = id + '-p' + parts.length + '.mp3'
        writeFileSync(OUT + '/' + file, await request((c) => c.toStream(text, prosody)))
        parts.push({ kind: 'audio', file, text })
      } else {
        for (const chunk of chunks) {
          const file = id + '-p' + parts.length + '.mp3'
          writeFileSync(OUT + '/' + file, await request((c) => c.rawToStream(doc(chunk.ssml))))
          parts.push({ kind: 'audio', file, text: chunk.text })
        }
      }
      await sleep(300)
    }
    manifest.push({ id, name: sample.name, parts })
    console.log(id + ' parts=' + parts.length)
  } catch (error) { console.log(id + ' FAIL ' + String(error).slice(0, 70)) }
  await sleep(250)
}
writeFileSync(OUT + '/_manifest.json', JSON.stringify(manifest, null, 1))
console.log('samples ' + manifest.length + '/' + samples.length)
