/**
 * Gate prompt. The gate is a judgment about meaning, not a lookup of words, so
 * the request carries what the listener is hearing right now: the sentence being
 * read, what the assistant still owes, whose line is already waiting, and the
 * owner's previous line. A line without context can only be classified; a line
 * with context can be understood.
 */

/** Hard bound for system + user prompt, asserted by tests. */
export const GATE_PROMPT_LIMIT = 1000
/** One JSON line plus a short reason; still far below a chat answer. */
export const GATE_MAX_TOKENS = 80
/**
 * The gate no longer blocks delivery: the line is already in the FIFO, so a
 * slow verdict corrects the plan instead of stalling the answer.
 */
export const GATE_TIMEOUT_MS = 1200
export const GATE_TEXT_CHARS = 100
export const GATE_CONTEXT_CHARS = 90
export const GATE_QUEUE_LIMIT = 4
export const GATE_PENDING_LIMIT = 3

export const GATE_SYSTEM_PROMPT =
  '你是主人的语音意图判官。看这句新话和现在的上下文，判断它此刻的意思：接话回答、纠正、补充、催促、换话题、要求停下，还是自言自语或无意义噪声；再判断现在说话更好，还是等当前这句读完。'
  + '只有新话确实要对正在说的内容作出反应时才 interrupt：纠正、明确要求停下或换话题、更急的事。'
  + '补充、追问细节、接着讲同一件事，用 queue。'
  + '重复对方刚说过的话、单字、拟声、无意义碎片，用 ignore。'
  + '按意思判断，不要套关键词。只输出一行JSON：{"action":"interrupt|queue|ignore","priority":0-100,"reason":"≤12字"}。'

export interface GatePromptInput {
  text: string
  playing: boolean
  queued: number
  /** Text of the sentence being read out right now. */
  playingText?: string
  /** The assistant's unread blocks; index 0 is the one playing. */
  pending?: readonly string[]
  /** Utterances already waiting, in arrival order. */
  queue?: readonly string[]
  /** The owner's previous accepted line, for continuity. */
  previousText?: string
}

function clip(text: unknown, limit: number): string {
  const flat = String(text ?? '').replace(/\s+/gu, ' ').trim()
  return flat.length > limit ? flat.slice(0, limit) : flat
}

/** Everything the listener can hear right now, in one small message. */
export function buildGatePrompt(input: GatePromptInput): string {
  const pending = (input.pending ?? []).map((line) => clip(line, GATE_CONTEXT_CHARS)).filter(Boolean)
  const playingText = clip(input.playingText ?? '', GATE_CONTEXT_CHARS) || pending[0] || ''
  const rest = playingText && pending[0] === playingText ? pending.slice(1) : pending
  const waiting = (input.queue ?? []).map((line) => clip(line, GATE_CONTEXT_CHARS)).filter(Boolean)
  const lines = [
    '新话：' + clip(input.text, GATE_TEXT_CHARS),
    '正在读：' + (input.playing ? (playingText || '（助手刚刚开口）') : '无，助手空闲'),
  ]
  const owed = rest.slice(0, GATE_PENDING_LIMIT).join(' / ')
  if (owed) lines.push('还没读：' + clip(owed, GATE_CONTEXT_CHARS * 2))
  const queueText = waiting.slice(0, GATE_QUEUE_LIMIT).join(' / ')
  lines.push('排队：' + Math.max(0, Math.round(input.queued)) + ' 条'
    + (queueText ? '，依次是 ' + clip(queueText, GATE_CONTEXT_CHARS * 2) : ''))
  if (input.previousText) lines.push('上一句：' + clip(input.previousText, GATE_CONTEXT_CHARS))
  return lines.join('\n')
}

/** Total characters of the request the model actually sees. */
export function gatePromptChars(input: GatePromptInput): number {
  return GATE_SYSTEM_PROMPT.length + buildGatePrompt(input).length
}
