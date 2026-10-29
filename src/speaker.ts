/** Speaking layer: compose speech from meaning, not from written sentences. */

export const SPEAKER_SYSTEM_PROMPT = [
  '你把助手写好的回答"说出来"。你不是改标点,是重新讲一遍。',
  '规则:',
  '1 只输出要说的话,一行一句。不要标题、列表、编号、括号、引号。',
  '2 先说结论,再说理由。一句一个意思,口语,短句。',
  '3 已经念过的内容和开头不要重复;不要寒暄,不要"好的""那么"。',
  '4 数字和专有名词照说,不念符号、代码、路径。',
  '5 不超过注意力排序给的行数上限,总共不超过一百二十字。信息不够就少说,不许编。',
].join('\n')

/** Room for three to five spoken lines. */
export const SPEAKER_MAX_TOKENS = 320

/** The attended plan the composer follows: what to say, in what order, how many lines. */
export interface SpeakerAttentionInput {
  summary: string
  body: string
  budget: number
}

/** One compose request: the written reply, what was already heard, and the attention plan. */
export function buildSpeakerPrompt(
  text: string,
  heard: readonly string[],
  question?: string,
  attention?: SpeakerAttentionInput,
): string {
  const body = text.trim().slice(0, 900)
  const already = heard
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-4)
    .join(' / ')
  const rows = [
    question ? '对方刚说的: ' + question.trim().slice(0, 120) : '',
    already ? '已经说过的: ' + already : '',
  ].filter(Boolean)
  // With an attention plan the composer speaks from the attended text only:
  // lower-scored blocks are already gone, and the line budget is explicit.
  if (attention && attention.body.trim().length > 0) {
    rows.push('注意力排序(按这个顺序说,只说要紧的):', attention.summary.trim().slice(0, 600))
    rows.push('要说的内容:')
    rows.push(attention.body.trim().slice(0, 700))
    rows.push('行数上限: ' + Math.max(1, Math.min(6, Math.round(attention.budget))) + ' 行。')
  } else {
    rows.push('要讲的内容:')
    rows.push(body)
  }
  return rows.join('\n')
}

const LINE_PREFIX = /^\s*(?:[-*#>]+|\d+[.、)]|[（(]\d+[)）])\s*/u
const SYMBOL_ONLY = /^[\s\p{P}\p{S}]+$/u

/** Spoken lines from a composer answer; headings, bullets and noise are dropped. */
export function parseSpeakerLines(raw: string): string[] {
  if (typeof raw !== 'string' || raw.length === 0) return []
  const lines: string[] = []
  for (const source of raw.split(/\r?\n/u)) {
    const trimmed = source.trim()
    // A heading is a label for the page, not something to say.
    if (/^#{1,6}\s/u.test(trimmed)) continue
    const line = trimmed.replace(LINE_PREFIX, '').replace(/\*\*/gu, '').trim()
    if (line.length === 0 || SYMBOL_ONLY.test(line)) continue
    if (/^[#\-*]{2,}/u.test(line)) continue
    // Paths and file names never belong in a spoken line.
    if (/[\\/]/.test(line) && /[A-Za-z]/.test(line)) continue
    if (/\.(?:ts|tsx|js|jsx|mjs|json|md|py|go|rs|css|html|ya?ml)\b/iu.test(line)) continue
    if (/[A-Za-z]{6,}/u.test(line) && /[_/\\.]/.test(line)) continue
    lines.push(line)
    if (lines.length >= 6) break
  }
  return lines
}
