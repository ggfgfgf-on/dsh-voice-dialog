import assert from 'node:assert/strict'
import test from 'node:test'
import { SentenceSegmenter, segmentSpeechBlocks, splitSentences } from '../lib/segmenter.js'
import { withSpeechPause } from '../lib/tts-queue.js'

const hanCount = (text) => Array.from(text).filter((ch) => /[\u3400-\u9fff]/u.test(ch)).length

test('splits a long sentence into clause blocks and keeps terminal punctuation', () => {
  const text = '这是一个没有逗号的特别长的句子用来验证长度阈值会把它切成多个小块并且句号保留。'
  const blocks = segmentSpeechBlocks(text)
  assert.ok(blocks.length >= 2, 'long sentence must become multiple blocks')
  assert.equal(blocks.map((block) => block.text).join(''), text)
  assert.deepEqual(blocks.map((block) => block.sentenceId), blocks.map(() => 0))
  assert.deepEqual(blocks.map((block) => block.chunkIndex), blocks.map((_, index) => index))
  assert.ok(blocks.at(-1).text.endsWith('。'), 'sentence-final punctuation survives')
  assert.ok(blocks.slice(0, -1).every((block) => !/[。！？!?…]$/u.test(block.text)))
})

test('streams the first clause before the sentence ends', () => {
  const segmenter = new SentenceSegmenter()
  const first = segmenter.feedBlocks('这是一个比较长的问题，')
  assert.equal(first.length, 1, 'a complete clause must be emitted before flush')
  assert.ok(first[0].text.endsWith('，'))
  const tail = segmenter.feedBlocks('我们分几步说。')
  assert.equal(tail.map((block) => block.text).join(''), '我们分几步说。')
  assert.deepEqual(segmenter.flushBlocks(), [])
  assert.deepEqual(
    [...first.map((block) => block.text), ...tail.map((block) => block.text)],
    ['这是一个比较长的问题，', '我们分几步说。'],
  )
})

test('commas inside numbers and English tokens never cut a block', () => {
  const numeric = segmentSpeechBlocks('价格是1,024元而且速度很快，后面的细节稍后再说。')
  assert.equal(numeric.length, 2)
  assert.ok(numeric[0].text.includes('1,024'))
  assert.ok(numeric[0].text.endsWith('，'))

  const english = segmentSpeechBlocks('模型叫GPT,4版本并且支持中文，我们先看这个。')
  assert.equal(english.length, 2)
  assert.ok(english[0].text.includes('GPT,4'))
  assert.ok(english[0].text.endsWith('，'))

  const spaced = segmentSpeechBlocks('价格是1, 024元而且速度很快，后面的细节稍后再说。')
  assert.equal(spaced.length, 2)
  assert.ok(spaced[0].text.includes('1, 024'))
  assert.ok(spaced[0].text.endsWith('，'))
})

test('120-Han reply: old sentence count vs new block count', (t) => {
  const reply = '这次改动的目标是把整句朗读拆成更小的块，让组织层真正有重排空间。'
    + '先在句子内部按逗号和长度阈值切分，再把每个块送进原来的队列，最后由编排器决定顺序和丢弃。'
    + '最后还要跑构建和全部测试，确认数字和英文不会被逗号切坏，并且同一句里的块保持顺序，保证首次出声不等待整句。'
  assert.equal(hanCount(reply), 120)
  const old = splitSentences(reply)
  const oldCount = old.sentences.length + (old.tail.trim() ? 1 : 0)
  const blocks = segmentSpeechBlocks(reply)
  assert.equal(oldCount, 3)
  assert.ok(blocks.length >= oldCount * 2, 'blocks should be materially finer than sentences')
  assert.equal(blocks.map((block) => block.text).join(''), reply)
  assert.ok(blocks.every((block) => {
    const size = hanCount(block.text)
    return size >= 6 && size <= 14
  }), 'each block should target 6-14 Han characters')
  assert.ok(blocks[0].text.length < old.sentences[0].length, 'first block arrives before the old first sentence')
  t.diagnostic('old=' + oldCount + ' blocks, new=' + blocks.length + ' blocks')
})

test('adds a short pause only when a block lacks punctuation', () => {
  assert.equal(withSpeechPause('被长度切开的块'), '被长度切开的块，')
  assert.equal(withSpeechPause('逗号结尾，'), '逗号结尾，')
  assert.equal(withSpeechPause('句号结尾。'), '句号结尾。')
})
