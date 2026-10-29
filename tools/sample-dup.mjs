import { SentenceSegmenter } from '../lib/segmenter.js'
import { StagedRewriter, newLineText } from '../lib/rewriter.js'

const text = '现在的形式是这样。你说话先过判断层，规则先判，拿不准才问模型。回答边生成边切块，第一块立刻念，后面的进改写层。'
const seg = new SentenceSegmenter({ firstClauseChars: 8 })
const enqueued = [], published = []
let staged
const speak = (block) => {
  const clean = block.text
  if (!clean) return
  if (!staged) {
    published.push(clean)
    enqueued.push(clean)
    staged = new StagedRewriter({ onPublish: (r) => { for (const line of r.lines) {
      const full = line.trim(); if (!full) continue
      const delta = newLineText(published, full)
      published.push(full)
      if (delta) enqueued.push(delta)
    } } })
    staged.markSpoken(clean)
    staged.push({ text: clean, sentenceId: block.sentenceId, chunkIndex: block.chunkIndex })
    return
  }
  staged.push({ text: clean, sentenceId: block.sentenceId, chunkIndex: block.chunkIndex })
}
for (const ch of text) { for (const b of seg.feedBlocks(ch)) speak(b) }
for (const b of seg.flushBlocks()) speak(b)
console.log('ENQUEUED ' + enqueued.length)
enqueued.forEach((t, i) => console.log(i + ': ' + t))
const joined = enqueued.join('')
console.log('REPEATS ' + (enqueued.length - new Set(enqueued).size))
console.log('JOINED ' + joined)