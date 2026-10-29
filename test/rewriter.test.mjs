import assert from 'node:assert/strict'
import test from 'node:test'
import {
  REWRITE_MAX_TOKENS, REWRITE_TIMEOUT_MS, StagedRewriter, buildRewritePrompt,
  newLineText, parseRewriteAnswer, rewriteBlocks, rewriteByRules,

  speechKey,
} from '../lib/rewriter.js'
import { isLikelyRepeat } from '../lib/rewriter.js'
import { SentenceSegmenter } from '../lib/segmenter.js'

const fragments = [
  { text: '先看日志', sentenceId: 1 },
  { text: '先看日志', sentenceId: 1 },
  { text: '另外顺便说一句天气不错', sentenceId: 2 },
  { text: '然后重跑测试', sentenceId: 3 },
]

test('the rules merge, dedupe and reorder the fragments without touching the opener', () => {
  const result = rewriteByRules({ spoken: '好，我检查一下构建。', pending: fragments })
  assert.equal(result.spoken, '好，我检查一下构建。')
  // Dedupe runs before merging, so the repeated fragment is spoken once.
  assert.deepEqual(result.lines, ['先看日志', '然后重跑测试', '另外顺便说一句天气不错'])
  assert.equal(result.mode, 'rule')
})

test('fragments of one sentence become one spoken line', () => {
  const result = rewriteByRules({
    spoken: '开头。',
    pending: [
      { text: '第一句的前半', sentenceId: 7 },
      { text: '后半', sentenceId: 7 },
      { text: '第二句。', sentenceId: 8 },
    ],
  })
  assert.deepEqual(result.lines, ['第一句的前半，后半', '第二句。'])
})

test('a model answer inside the budget replaces the rules', async () => {
  let seenPrompt = ''
  const result = await rewriteBlocks(
    { spoken: '开头一句。', pending: fragments },
    {
      call: async (prompt) => {
        seenPrompt = prompt
        return '{"lines":["先看日志，再看测试。","天气不重要，跳过。"]}'
      },
    },
  )
  assert.equal(result.mode, 'model')
  assert.equal(result.spoken, '开头一句。')
  assert.deepEqual(result.lines, ['先看日志，再看测试。', '天气不重要，跳过。'])
  assert.ok(seenPrompt.includes('先看日志'))
  assert.ok(seenPrompt.length <= 900)
})

test('a slow model falls back to the rules inside the budget', async () => {
  const startedAt = Date.now()
  const result = await rewriteBlocks(
    { spoken: '开头。', pending: fragments },
    { timeoutMs: 40, call: () => new Promise((resolve) => setTimeout(() => resolve('{"lines":["太晚了"]}'), 400)) },
  )
  const elapsed = Date.now() - startedAt
  assert.equal(result.mode, 'rule')
  assert.ok(elapsed < 300, 'the timeout freed the rewrite in ' + elapsed + ' ms')
  assert.deepEqual(result.lines, rewriteByRules({ spoken: '开头。', pending: fragments }).lines)
})

test('a broken model answer also falls back to the rules', async () => {
  const result = await rewriteBlocks(
    { spoken: '开头。', pending: fragments },
    { call: async () => 'not json at all' },
  )
  assert.equal(result.mode, 'rule')
  assert.equal(parseRewriteAnswer('not json at all').length, 0)
  assert.deepEqual(parseRewriteAnswer('{"lines":["a"," ","b"]}'), ['a', 'b'])
})

test('the prompt asks for a rewrite and stays inside its bounds', () => {
  const prompt = buildRewritePrompt({ spoken: '上一句。', pending: fragments })
  assert.ok(prompt.includes('改写'))
  assert.ok(prompt.includes('上一句。'))
  assert.ok(prompt.length <= 900)
  assert.equal(REWRITE_TIMEOUT_MS, 450)
  assert.equal(REWRITE_MAX_TOKENS, 120)
})

test('the first rewrite request fires the moment the first block arrives', async () => {
  const calls = []
  const published = []
  const rewriter = new StagedRewriter({
    now: () => 1000,
    onPublish: (result) => published.push(result),
    call: (prompt) => new Promise((resolve) => calls.push({ prompt, resolve })),
  })
  const draft = rewriter.push({ text: '第一块刚到达', sentenceId: 1 })
  // Synchronous: the draft is already playable and the request is in flight.
  assert.ok(draft.lines.length > 0, 'a rule draft exists before any await')
  assert.equal(calls.length, 1, 'the model request started with the first block')
  assert.equal(rewriter.firstRequestDelay(), 0)
  assert.equal(published.length, 1)
})

test('later blocks fold into the draft without restarting it', async () => {
  const calls = []
  const rewriter = new StagedRewriter({
    call: (prompt) => new Promise((resolve) => calls.push({ prompt, resolve })),
  })
  rewriter.push({ text: '结论在这里。', sentenceId: 1 })
  const draft2 = rewriter.push({ text: '补充一块。', sentenceId: 2 })
  // Still one request in flight: the second block only marks the draft dirty.
  assert.equal(calls.length, 1)
  assert.ok(draft2.lines.length >= 2, 'the rule draft already covers both blocks')
  calls[0].resolve('{"lines":["结论在这里。","补充一块，连贯地说。"]}')
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(rewriter.currentMode, 'model')
  assert.deepEqual(rewriter.lines(), ['结论在这里。', '补充一块，连贯地说。'])
  // The dirty flag fired one incremental request that already carries block 2.
  assert.equal(calls.length, 2)
  assert.ok(calls[1].prompt.includes('补充一块'))
  // A third block while that request is in flight does not stack another one.
  rewriter.push({ text: '再补一块。', sentenceId: 3 })
  assert.equal(calls.length, 2)
  calls[1].resolve('{"lines":["结论在这里。","补充一块，再补一块。"]}')
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(calls.length, 3)
  assert.ok(calls[2].prompt.includes('再补一块'))
})

test('a cumulative draft never repeats what was already spoken', () => {
  const spoken = ['现在的形式是这样。']
  assert.equal(newLineText(spoken, '现在的形式是这样。'), '')
  assert.equal(newLineText(spoken, '现在的形式是这样。你说话先过判断层，'), '你说话先过判断层，')
  spoken.push('现在的形式是这样。你说话先过判断层，')
  // The next draft extends the line again: only the new clause is spoken.
  assert.equal(newLineText(spoken, '现在的形式是这样。你说话先过判断层，规则先判。'), '规则先判。')
  // Text already heard as the tail of a longer line stays silent.
  assert.equal(newLineText(['你说话先过判断层，规则先判。'], '规则先判。'), '')
})

test('streamed clauses reach the queue once, in order, and join back to the source', () => {
  const source = '现在的形式是这样。你说话先过判断层，规则先判，拿不准才问模型。回答边生成边切块，第一块立刻念。'
  const segmenter = new SentenceSegmenter({ firstClauseChars: 8 })
  const spoken = []
  const enqueued = []
  let staged
  const speak = (block) => {
    if (!block.text) return
    if (staged === undefined) {
      spoken.push(block.text)
      enqueued.push(block.text)
      staged = new StagedRewriter({ onPublish: (result) => {
        for (const line of result.lines) {
          const full = line.trim()
          if (!full) continue
          const delta = newLineText(spoken, full)
          spoken.push(full)
          if (delta) enqueued.push(delta)
        }
      } })
      staged.markSpoken(block.text)
      staged.push({ text: block.text, sentenceId: block.sentenceId })
      return
    }
    staged.push({ text: block.text, sentenceId: block.sentenceId })
  }
  for (const char of source) for (const block of segmenter.feedBlocks(char)) speak(block)
  for (const block of segmenter.flushBlocks()) speak(block)
  assert.equal(enqueued[0], '现在的形式是这样。')
  assert.equal(new Set(enqueued).size, enqueued.length, 'no line is spoken twice')
  assert.equal(enqueued.join(''), source)
})

test('the same sentence with different words is recognized as a repeat', () => {
  assert.equal(isLikelyRepeat(['构建是通过了。'], '构建是通过了'), true)
  // A line that merely extends a spoken one is new content: the prefix and
  // tail logic handles those before this check ever runs.
  assert.equal(isLikelyRepeat(['构建是通过了。'], '构建是通过了，但启动慢。'), false)
  assert.equal(isLikelyRepeat(['启动还是很慢。'], '启动还是很慢'), true)
  // A negation and a new fact are new information, never a repeat.
  assert.equal(isLikelyRepeat(['构建是通过了。'], '构建是没通过。'), false)
  assert.equal(isLikelyRepeat(['构建是通过了。'], '启动还是慢。'), false)
  // Short lines are left alone: the check would misfire.
  assert.equal(isLikelyRepeat(['通过。'], '通过。'), false)
})

test('punctuation drift does not make a new line', () => {
  const key = (s) => speechKey(s)
  assert.equal(key('它只会排序。'), key('它只会排序'))
  assert.equal(key('它只会排序'), key('它 只 会 排 序！'))
  assert.notEqual(key('它只会排序'), key('它只会挑选'))
})
