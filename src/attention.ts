/**
 * Attention pass. A person who has just written a long answer does not read it
 * out sentence by sentence: they read the whole thing first, decide what the
 * listener actually needs right now, and only then start talking. This module
 * is that first read: it turns a reply into blocks and asks for a salience
 * score per block, so the speaking layer speaks from a global view of the
 * reply instead of a running window over the last few hundred characters.
 */

export const ATTENTION_SYSTEM_PROMPT = [
  '你先通读整段回复,判断哪些内容值得占用对方的注意力;你自己不说话。',
  '逐块打一个分数:',
  '3 必须说——直接回答、结论、数字、时间点、对方要做的动作。',
  '2 撑一句——理由、条件、影响。',
  '1 可省——重复、铺陈、能概括的过程。',
  '0 不说——寒暄、"好的""我看看"、工具名、文件路径、代码、过程叙述。',
  '对方刚问的那块一律 3;已经念过的一律 0。',
  '输出每块一行:"序号|分数|角色|不超过十四字要点"。角色从 结论/回答/理由/条件/过程/客套 里挑。',
  '不要解释,不要总结,不要输出别的行。',
].join('\n')

/** One short line per block; a long reply still fits. */
export const ATTENTION_MAX_TOKENS = 300
export const ATTENTION_BLOCK_CHARS = 110
export const ATTENTION_MAX_BLOCKS = 14
export const ATTENTION_INPUT_CHARS = 2600
/** Below this a block is not spoken at all. */
export const ATTENTION_MIN_SPEAK_SCORE = 2
export const ATTENTION_BODY_CHARS = 700
export const ATTENTION_SUMMARY_CHARS = 600
export const SPEECH_LINE_BUDGET_MAX = 6

export interface AttentionBlock {
  index: number
  score: number
  role: string
  gist: string
}

export interface AttentionMap {
  blocks: AttentionBlock[]
  /** Block indices in the order they should be spoken. */
  order: number[]
  /** How many spoken lines the composer may use. */
  budget: number
}

/** What the composer receives: the plan, the attended text, the line budget. */
export interface SpeakerAttention {
  summary: string
  body: string
  budget: number
}

const SENTENCE_END = /(?<=[。！？!?；;\n])/u

function chop(text: string): string[] {
  const out: string[] = []
  let rest = text.trim()
  while (rest.length > ATTENTION_BLOCK_CHARS) {
    const window = rest.slice(0, ATTENTION_BLOCK_CHARS)
    const at = Math.max(
      window.lastIndexOf('，'), window.lastIndexOf(','), window.lastIndexOf('、'), window.lastIndexOf('：'),
    )
    const cut = at >= 40 ? at + 1 : ATTENTION_BLOCK_CHARS
    const head = rest.slice(0, cut).trim()
    if (head) out.push(head)
    rest = rest.slice(cut).trim()
  }
  if (rest) out.push(rest)
  return out
}

/**
 * Split a reply into attention blocks. A very short fragment joins the block
 * before it (a person reads "对。" together with the sentence it answers), and
 * the whole list is bounded so the prompt stays cheap.
 */
export function splitAttentionBlocks(text: string): string[] {
  if (typeof text !== 'string' || text.length === 0) return []
  const pieces = text
    .replace(/\r/gu, '')
    .split(SENTENCE_END)
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0)
  const blocks: string[] = []
  let chars = 0
  for (const piece of pieces) {
    for (const chunk of chop(piece)) {
      // A fragment ("好了。""对。") belongs with the sentence it answers; a full
      // sentence stands on its own even when it is short.
      const previous = blocks[blocks.length - 1]
      if (previous !== undefined && chunk.length <= 4) {
        blocks[blocks.length - 1] = previous + chunk
        continue
      }
      if (blocks.length >= ATTENTION_MAX_BLOCKS) return blocks
      if (chars + chunk.length > ATTENTION_INPUT_CHARS && blocks.length > 0) return blocks
      blocks.push(chunk)
      chars += chunk.length
    }
  }
  return blocks
}

/** One numbered line per block; the model answers with the same numbers. */
export function buildAttentionPrompt(
  blocks: readonly string[],
  heard: readonly string[],
  question?: string,
): string {
  const already = heard
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-4)
    .join(' / ')
  const rows = [
    question ? '对方刚说的: ' + question.trim().slice(0, 120) : '',
    already ? '已经念过的: ' + already : '',
    '块:',
  ].filter(Boolean)
  blocks.forEach((block, index) => rows.push(index + '| ' + block))
  return rows.join('\n')
}

/**
 * Parse the attention answer. Missing blocks keep score 2 (no evidence to drop
 * them), junk lines are ignored, and an answer with no usable line returns
 * undefined so the composer runs exactly as it did before this layer existed.
 */
export function parseAttentionMap(raw: string, blockCount: number): AttentionMap | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || blockCount <= 0) return undefined
  const seen = new Map<number, AttentionBlock>()
  for (const source of raw.split(/\r?\n/u)) {
    const line = source.trim().replace(/^[-*•·\s]+/u, '')
    if (line.length === 0) continue
    const parts = line.split(/[|｜]/u).map((part) => part.trim())
    if (parts.length < 2) continue
    const index = Number.parseInt(parts[0], 10)
    const digit = (parts[1].match(/\d/u) ?? [''])[0]
    const score = Number.parseInt(digit, 10)
    if (!Number.isInteger(index) || index < 0 || index >= blockCount) continue
    if (!Number.isInteger(score) || score < 0 || score > 3) continue
    if (seen.has(index)) continue
    const role = (parts[2] ?? '').replace(/[^\u4e00-\u9fa5A-Za-z]/gu, '').slice(0, 6)
    const gist = (parts[3] ?? '').replace(/[|｜]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 20)
    seen.set(index, { index, score, role, gist })
  }
  if (seen.size === 0) return undefined
  const blocks: AttentionBlock[] = []
  for (let index = 0; index < blockCount; index += 1) {
    blocks.push(seen.get(index) ?? { index, score: 2, role: '', gist: '' })
  }
  const kept = blocks.filter((block) => block.score >= ATTENTION_MIN_SPEAK_SCORE)
  if (kept.length === 0) return undefined
  const highest = kept.reduce((max, block) => Math.max(max, block.score), 0)
  // A person leads with the point. Only reorder when the written reply started
  // with support and buried the answer further down.
  const order = kept[0].score < highest
    ? kept.slice().sort((a, b) => b.score - a.score || a.index - b.index).map((block) => block.index)
    : kept.map((block) => block.index)
  const highs = kept.filter((block) => block.score === 3).length
  const budget = Math.min(SPEECH_LINE_BUDGET_MAX, Math.max(1, 2 + highs))
  return { blocks, order, budget }
}

/** The composer's view: plan, attended text, budget. */
export function attentionForSpeech(
  map: AttentionMap,
  blocks: readonly string[],
): SpeakerAttention | undefined {
  const kept: { block: AttentionBlock; text: string }[] = []
  for (const index of map.order) {
    const block = map.blocks[index]
    const text = blocks[index]
    if (!block || !text || block.score < ATTENTION_MIN_SPEAK_SCORE) continue
    kept.push({ block, text: text.trim() })
  }
  if (kept.length === 0) return undefined
  const summary = kept
    .map((item, position) => {
      const gist = item.block.gist || item.text.slice(0, 20)
      const role = item.block.role ? '|' + item.block.role : ''
      return (position + 1) + '. [' + item.block.score + role + '] ' + gist
    })
    .join('\n')
    .slice(0, ATTENTION_SUMMARY_CHARS)
  const body: string[] = []
  let chars = 0
  for (const item of kept) {
    if (chars + item.text.length > ATTENTION_BODY_CHARS) break
    body.push(item.text)
    chars += item.text.length
  }
  return { summary, body: body.join('\n'), budget: map.budget }
}
