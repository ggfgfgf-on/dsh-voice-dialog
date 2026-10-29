/**
 * Read-aloud rewriting: turn the streamed fragment blocks into one spoken
 * script. The rules are the floor (always available, never slower than a
 * frame), the model call is an improvement with a hard 450 ms budget.
 */

export interface RewriteBlock {
  text: string
  /** Blocks from one sentence must keep their relative order. */
  sentenceId?: number
  chunkIndex?: number
}

export interface RewriteInput {
  /** The block that is already audible; its wording must not change. */
  spoken: string
  /** Blocks the listener has not heard yet, in arrival order. */
  pending: readonly RewriteBlock[]
}

export interface RewriteResult {
  /** Untouched opener (empty while nothing has been spoken). */
  spoken: string
  /** Read-aloud lines in speaking order. */
  lines: string[]
  mode: 'model' | 'rule'
}

export const REWRITE_SYSTEM_PROMPT = '你是语音输出的改写器。把待念的碎片块改写成一段自然口语稿：'
  + '合并碎块、重要的提前、补一句自然的衔接、删掉重复和跑题，不要新增事实。'
  + '只输出一行 JSON：{"lines":["第一句","第二句"]}'
export const REWRITE_TIMEOUT_MS = 450
export const REWRITE_MAX_TOKENS = 120
export const REWRITE_PROMPT_LIMIT = 900

const OFF_TOPIC = /^(另外|顺便|对了|还有一点|顺带)/u
const FILLER = /^(嗯|呃|那个|这个|就是说)[，,。.！!]?$/u

function normalize(text: string): string {
  return text.replace(/[\s，。、；：！？,.;:!?~～…—"'“”‘’()（）]/gu, '')
}

/** Drop exact repeats, blocks already covered by a kept neighbour, and filler. */
export function dedupeBlocks(blocks: readonly RewriteBlock[]): RewriteBlock[] {
  const kept: RewriteBlock[] = []
  const seen: string[] = []
  for (const block of blocks) {
    const key = normalize(block.text)
    if (key.length === 0) continue
    if (FILLER.test(block.text.trim())) continue
    if (seen.some((other) => other === key || other.includes(key))) continue
    seen.push(key)
    kept.push(block)
  }
  return kept
}

function joinLine(left: string, right: string): string {
  if (/[。！？!?；;]$/u.test(left)) return left + right
  return left.replace(/[，,、]$/u, '') + '，' + right
}

/** Merge fragments of one sentence, keep sentence order, move tangents last. */
export function orderBlocks(blocks: readonly RewriteBlock[]): string[] {
  const merged: Array<{ text: string; sentenceId?: number; tangent: boolean }> = []
  for (const block of blocks) {
    const text = block.text.trim()
    if (!text) continue
    const last = merged[merged.length - 1]
    if (last && block.sentenceId !== undefined && last.sentenceId === block.sentenceId) {
      last.text = joinLine(last.text, text)
      continue
    }
    merged.push({ text, sentenceId: block.sentenceId, tangent: OFF_TOPIC.test(text) })
  }
  const main = merged.filter((line) => !line.tangent)
  const tangents = merged.filter((line) => line.tangent)
  return [...main, ...tangents].map((line) => line.text)
}

export function rewriteByRules(input: RewriteInput): RewriteResult {
  return { spoken: input.spoken, lines: orderBlocks(dedupeBlocks(input.pending)), mode: 'rule' }
}
/**
 * Drafts are cumulative: every rule draft re-emits the blocks it already
 * published, and a sentence that gained a clause comes back as a longer line.
 * Given what the listener has already heard, return only the unheard tail.
 * A line already covered (equal to, or the ending of, a spoken line) yields an
 * empty string and must not be spoken again.
 */
export function newLineText(spoken: readonly string[], line: string): string {
  const text = line.trim()
  if (!text) return ''
  for (const heard of spoken) {
    if (heard === text || heard.endsWith(text)) return ''
  }
  let longest = ''
  for (const heard of spoken) {
    if (heard.length > longest.length && text.length > heard.length && text.startsWith(heard)) {
      longest = heard
    }
  }
  if (longest) return text.slice(longest.length).replace(/^[，,、。．.；;：:\s]+/u, '').trim()
  return text
}

const REPEAT_MIN_CHARS = 6
const REPEAT_CONTAINMENT = 0.85
const REPEAT_LENGTH_RATIO = 0.7

/**
 * A rewrite may phrase an already spoken line differently: the words change,
 * the sentence does not, and saying it again is what the listener complained
 * about. The test is deliberately conservative - nearly every character of
 * the shorter line must already be in the longer one, and the two must be
 * comparable in length. A negation or a new fact changes too many characters
 * to be mistaken for a repeat, and lines under six characters are left alone.
 */
export function isLikelyRepeat(spoken: readonly string[], line: string): boolean {
  const strip = (value: string): string => value.replace(/[\s，,、。．.！？!?；;：:…—\-]/gu, '')
  const clean = strip(line)
  if (clean.length < REPEAT_MIN_CHARS) return false
  for (const heard of spoken) {
    const other = strip(heard)
    if (other.length < REPEAT_MIN_CHARS) continue
    const [short, long] = clean.length <= other.length ? [clean, other] : [other, clean]
    if (short.length < long.length * REPEAT_LENGTH_RATIO) continue
    const chars = new Set(short)
    let hit = 0
    for (const ch of chars) if (long.includes(ch)) hit += 1
    if (hit / chars.size >= REPEAT_CONTAINMENT) return true
  }
  return false
}

export function buildRewritePrompt(input: RewriteInput): string {
  const pending = input.pending.map((block, index) => (index + 1) + '. ' + block.text).join('\n')
  return [
    input.spoken ? '上一句已经念过：' + input.spoken : '',
    '还没念的块（按到达顺序）：',
    pending,
    '把它们改写成一段要念出来的口语稿：合并碎块、把重要的排前面、补一句自然的衔接、删掉重复和跑题的内容。',
    '不要新增事实，不要改写上一句。只输出一行 JSON：{"lines":["第一句","第二句"]}',
  ].filter(Boolean).join('\n').slice(0, REWRITE_PROMPT_LIMIT)
}

export function parseRewriteAnswer(raw: string): string[] {
  const text = raw.trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as { lines?: unknown }
    if (!Array.isArray(value.lines)) return []
    return value.lines
      .filter((line): line is string => typeof line === 'string')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(0, 12)
  } catch {
    return []
  }
}

export interface RewriteCall {
  (prompt: string, signal: AbortSignal): Promise<string>
}

/**
 * Model rewrite inside the budget, rules otherwise. A timeout, a rejection or
 * junk output all end in the rule result, so playback is never held or lost.
 */
export async function rewriteBlocks(
  input: RewriteInput,
  options: { call?: RewriteCall; timeoutMs?: number } = {},
): Promise<RewriteResult> {
  const fallback = rewriteByRules(input)
  if (!options.call) return fallback
  const timeoutMs = options.timeoutMs ?? REWRITE_TIMEOUT_MS
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const answer = await Promise.race<string | null>([
      options.call(buildRewritePrompt(input), controller.signal),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => { controller.abort(); resolve(null) }, timeoutMs)
      }),
    ])
    if (answer === null) return fallback
    const lines = parseRewriteAnswer(answer)
    if (lines.length === 0) return fallback
    return { spoken: input.spoken, lines, mode: 'model' }
  } catch {
    return fallback
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export interface StagedOptions {
  /** Model call; without it the staged rewriter is rule-only. */
  call?: RewriteCall
  timeoutMs?: number
  /** Fires on every published draft, including the instant rule draft. */
  onPublish?: (result: RewriteResult) => void
  /** Injectable clock so a test can prove the first request is immediate. */
  now?: () => number
}

/**
 * Streaming rewriter. The first block publishes a rule draft and starts the
 * model request in the same tick, so the budget hides inside the opening
 * sentence; later blocks fold in incrementally and never restart the draft
 * the listener is already hearing.
 */
export class StagedRewriter {
  private readonly blocks: RewriteBlock[] = []
  private spokenText = ''
  private published: string[] = []
  private mode: 'model' | 'rule' = 'rule'
  private inFlight = false
  private dirty = false
  private firstRequestAt: number | undefined

  constructor(private readonly options: StagedOptions = {}) {}

  /** A block arrived. Returns the draft that is valid right now. */
  push(block: RewriteBlock): RewriteResult {
    this.blocks.push(block)
    const draft = rewriteByRules({ spoken: this.spokenText, pending: this.blocks })
    this.publish(draft)
    this.request()
    return draft
  }

  /** Context for the next request: the line the listener just heard. */
  markSpoken(text: string): void {
    this.spokenText = text
  }

  /** Lines that are published but not spoken yet. */
  lines(): string[] {
    return [...this.published]
  }

  get currentMode(): 'model' | 'rule' {
    return this.mode
  }

  /** Milliseconds between the first block and the first request. */
  firstRequestDelay(): number | undefined {
    if (this.firstRequestAt === undefined) return undefined
    return this.firstRequestAt - this.firstBlockAt!
  }

  private firstBlockAt: number | undefined

  private publish(result: RewriteResult): void {
    this.published = result.lines
    this.mode = result.mode
    try { this.options.onPublish?.(result) } catch { /* subscriber only */ }
  }

  private request(): void {
    const call = this.options.call
    if (!call) return
    const now = this.options.now ?? Date.now
    if (this.firstBlockAt === undefined) this.firstBlockAt = now()
    if (this.inFlight) { this.dirty = true; return }
    this.inFlight = true
    if (this.firstRequestAt === undefined) this.firstRequestAt = now()
    const input: RewriteInput = { spoken: this.spokenText, pending: [...this.blocks] }
    void rewriteBlocks(input, { call, timeoutMs: this.options.timeoutMs })
      .then((result) => {
        this.inFlight = false
        this.publish(result)
        if (this.dirty) { this.dirty = false; this.request() }
      })
      .catch(() => { this.inFlight = false })
  }
}

/** Rule-only rewrite used when the model never answers in time. */
export function ruleOnly(input: RewriteInput): RewriteResult {
  return rewriteByRules(input)
}

/**
 * Comparison key for one spoken line: spacing and punctuation drift do not
 * change it, so a draft that only re-punctuates the same sentence is caught.
 */
export function speechKey(text: string): string {
  return text.replace(/[\s，。！？、：；,.!?:;"'“”‘’…—\-]/gu, '')
}
