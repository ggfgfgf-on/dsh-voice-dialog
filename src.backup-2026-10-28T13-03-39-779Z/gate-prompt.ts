/**
 * Fast gate prompt. This layer answers exactly one question: does the new line
 * have to interrupt the answer being read out? Nothing else is sent, so the
 * request stays small and the answer stays one line of JSON.
 */

/** Hard bound for system + user prompt, asserted by tests. */
export const GATE_PROMPT_LIMIT = 400
/** One line of JSON needs far fewer tokens than a chat answer. */
export const GATE_MAX_TOKENS = 24
/** The gate must never block the reply path for long. */
export const GATE_TIMEOUT_MS = 400
export const GATE_TEXT_CHARS = 80

export const GATE_SYSTEM_PROMPT =
  '你是语音插话快判器。只输出一行JSON：'
  + '{"action":"interrupt|queue|ignore|drop","priority":0-100,"reason":"≤8字"}。'
  + '正在朗读且新话明确要求停下、换话题、更急，才 interrupt；'
  + '噪声（单字、嗯啊、The、Yeah、无意义碎片）用 ignore；'
  + '其余 queue。不解释、不换行、不输出其他字段。'

export interface GatePromptInput {
  text: string
  playing: boolean
  queued: number
}

function clip(text: string, limit: number): string {
  const flat = String(text ?? '').replace(/\s+/gu, ' ').trim()
  return flat.length > limit ? flat.slice(0, limit) : flat
}

/** Minimal user message: the line, whether playback is running, queue depth. */
export function buildGatePrompt(input: GatePromptInput): string {
  return [
    '朗读中：' + (input.playing ? '是' : '否'),
    '排队：' + Math.max(0, Math.round(input.queued)),
    '新话：' + clip(input.text, GATE_TEXT_CHARS),
  ].join('\n')
}

/** Total characters of the request the model actually sees. */
export function gatePromptChars(input: GatePromptInput): number {
  return GATE_SYSTEM_PROMPT.length + buildGatePrompt(input).length
}
