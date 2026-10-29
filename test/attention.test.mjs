import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ATTENTION_MAX_BLOCKS, attentionForSpeech, buildAttentionPrompt, parseAttentionMap, splitAttentionBlocks,
} from '../lib/attention.js'
import { buildSpeakerPrompt } from '../lib/speaker.js'

const REPLY = [
  '结论是先不用动它。',
  '现在的测速是两百毫秒,离阈值还有距离。',
  '我看了三个地方,分别是排队、合成分片和播放器。',
  '如果你后面要上多台机器,这块就得重写。',
  '好了。',
].join('')

test('a reply is cut into attention blocks', () => {
  const blocks = splitAttentionBlocks(REPLY)
  assert.ok(blocks.length >= 4 && blocks.length <= ATTENTION_MAX_BLOCKS)
  assert.equal(blocks[0], '结论是先不用动它。')
})

test('a one-word tail joins the block before it', () => {
  const blocks = splitAttentionBlocks('先说结论。好了。')
  assert.deepEqual(blocks, ['先说结论。好了。'])
})

test('a very long block is chopped, never dropped', () => {
  const long = '这件事的关键在于调度'.repeat(40)
  const blocks = splitAttentionBlocks(long)
  assert.ok(blocks.length > 1)
  const joined = blocks.join('')
  assert.ok(joined.length >= long.length - 8)
})

test('the attention prompt numbers every block and carries context', () => {
  const blocks = splitAttentionBlocks(REPLY)
  const prompt = buildAttentionPrompt(blocks, ['已经念过的一句。'], '现在怎么样')
  assert.ok(prompt.includes('对方刚说的: 现在怎么样'))
  assert.ok(prompt.includes('已经念过的: 已经念过的一句。'))
  for (let index = 0; index < blocks.length; index += 1) assert.ok(prompt.includes(index + '| ' + blocks[index]))
})

test('the map parses, remembers order and sets a line budget', () => {
  const raw = ['0|3|结论|先不用动它', '1|2|理由|测速还有距离', '2|1|过程|看了三个地方', '3|3|条件|上多台就得重写'].join('\n')
  const map = parseAttentionMap(raw, 4)
  assert.ok(map)
  assert.deepEqual(map.order, [0, 1, 3])
  assert.equal(map.budget, 4)
  const plan = attentionForSpeech(map, splitAttentionBlocks(REPLY).slice(0, 4))
  assert.ok(plan)
  assert.ok(plan.body.includes('先不用动它'))
  assert.ok(!plan.body.includes('看了三个地方'))
  assert.ok(plan.summary.includes('先不用动它'))
  assert.equal(plan.budget, 4)
})

test('a buried answer is spoken first', () => {
  const raw = ['0|2|过程|背景', '1|3|回答|这才是答案', '2|2|理由|其次'].join('\n')
  const map = parseAttentionMap(raw, 3)
  assert.ok(map)
  assert.deepEqual(map.order, [1, 0, 2])
})

test('junk, out-of-range indices and empty answers never break the layer', () => {
  assert.equal(parseAttentionMap('', 3), undefined)
  assert.equal(parseAttentionMap('我觉得挺好的', 3), undefined)
  assert.equal(parseAttentionMap('7|3|结论|越界', 3), undefined)
  assert.equal(parseAttentionMap('0|9|结论|分数越界', 3), undefined)
  const map = parseAttentionMap(['0|3|结论|只有这一块'].join('\n'), 3)
  assert.ok(map)
  assert.equal(map.blocks.length, 3)
  assert.equal(map.order[0], 0)
})

test('blocks the model never scored are kept, not silently dropped', () => {
  const map = parseAttentionMap('0|3|结论|答案', 3)
  assert.ok(map)
  assert.deepEqual(map.order.slice(1), [1, 2])
})

test('the composer follows the plan instead of the full text', () => {
  const map = parseAttentionMap(['0|3|结论|先不用动', '1|2|理由|两百毫秒'].join('\n'), 2)
  const plan = attentionForSpeech(map, ['结论是先不用动它。', '现在的测速是两百毫秒。'])
  assert.ok(plan)
  const prompt = buildSpeakerPrompt('整段正文'.repeat(50), ['已经念过'], '现在怎么样', plan)
  assert.ok(prompt.includes('注意力排序'))
  assert.ok(prompt.includes('行数上限: 3 行。'))
  assert.ok(prompt.includes('结论是先不用动它。'))
  assert.ok(prompt.includes('对方刚说的: 现在怎么样'))
})
