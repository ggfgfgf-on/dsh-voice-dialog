/** Adapted from haoku123/dsh-voice (MIT). See NOTICE. */
/**
 * Sentence segmenter for TTS: accumulate raw text deltas, emit complete
 * sentences on Chinese/English/Japanese terminal punctuation.
 */

export interface SegmenterOptions {
  /** Legacy safety valve; long clauses are now cut by the clause thresholds below. */
  maxSentenceChars?: number
  /** Legacy first-comma threshold; kept for callers and older tests. */
  firstClauseChars?: number
  /** Smallest speech-bearing clause to emit at a comma/colon/semicolon (default 6). */
  minClauseChars?: number
  /** Preferred size of a length-cut clause in Han characters (default 12). */
  targetClauseChars?: number
  /** A clause may reach this many Han characters before a length cut (default 14). */
  maxClauseChars?: number
}

/** One addressable read-aloud block. Chunks in one sentence share sentenceId. */
export interface SpeechBlock {
  text: string
  /** Stable within one reply; all chunks cut from the same sentence share it. */
  sentenceId: number
  /** Zero-based position inside the sentence. */
  chunkIndex: number
}

/** Alias used by callers that call the unit a chunk rather than a block. */
export type SpeechChunk = SpeechBlock

const TERMINAL = /[。！？!?；;…\n]/
const SKIP_PREFIX = /^[\s.,，、:：;；!?！？)\]）"'”’〉》】]+$/
/** A voice directive is control data, never speech; strip it if it leaks. */
const VOICE_DIRECTIVE = /\[\[\s*voice\s*[:：][\s\S]*?\]\]/gi

function stripVoiceDirectives(text: string): string {
  return text.replace(VOICE_DIRECTIVE, ' ')
}

/** Strip markdown noise before synthesis (mirrors the dsh-tts plainText filter). */
export function plainText(text: string): string {
  return stripVoiceDirectives(String(text))
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
    .replace(/https?:\/\/[^\s]+/g, ' ')
    .replace(/\b[A-Za-z]:\\[^\s，。！？；：、）】》]+/g, ' ')
    .replace(/(?:^|[\s(（])\/[A-Za-z0-9_.\-/]{2,}/g, ' ')
    .replace(/\b[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|json|md|py|sh|ps1|yml|yaml|toml|log)\b/gi, ' ')
}

const CJK = /[\u3400-\u9fff]/

/** True when a cleaned sentence has Chinese content worth speaking. */
export function hasSpeechContent(text: string): boolean {
  return CJK.test(text)
}

/** Longest first: a preamble must win over its own first word ("我来…"). */
const HEAD_FILLERS = [
  '让我想想', '让我看看', '我来看一下', '我来看看', '我先看一下', '我先看看', '我先确认一下', '我先确认',
  '稍等我看一下', '稍等一下', '稍等', '总的来说', '简单来说', '需要注意的是', '那么', '现在', '其实',
  '就是说', '这个', '好', '对', '嗯', '呃',
]
const FILLER_HEAD = new RegExp('^(?:' + HEAD_FILLERS.join('|') + ')[，,。.、；;：:\\s]*', 'u')

/**
 * Drop spoken filler, process preambles ("让我想想", "稍等") and filler leads
 * ("总的来说") at the very start of a block. Only the head moves, only while a
 * real sentence (6+ visible characters) survives, and a standalone
 * confirmation such as "对" stays: it is content, not filler.
 */
export function stripFillerHead(text: string): string {
  let out = text.trim()
  for (let round = 0; round < 4; round += 1) {
    const match = FILLER_HEAD.exec(out)
    if (!match) break
    const rest = out.slice(match[0].length).trim()
    if (visibleChars(rest) < 6) break
    out = rest
  }
  return out
}

/** Clean text for TTS: remove code, paths, URLs and markup; keep Chinese prose. */
export function sanitizeForSpeech(text: string): string {
  return plainText(String(text)).replace(/\s+/g, ' ').trim()
}

/**
 * How a buffered line start should be treated.
 *
 * - `fence`: enough marker characters seen to open a code fence
 * - `text`:  definitively not a fence, flush the lookahead as normal text
 * - `pending`: still too early to tell (e.g. the delta ended on "``")
 */
type LineStartVerdict = 'fence' | 'text' | 'pending'

/** Decide whether a line's leading characters start a ``` / ~~~ fence. */
function classifyFenceLine(line: string): LineStartVerdict {
  // A newline inside the lookahead means a blank/space-only line.
  if (line.includes('\n')) return 'text'
  let spaces = 0
  while (spaces < line.length && line[spaces] === ' ') spaces++
  // Four or more leading spaces is indented code, not a fence opener.
  if (spaces > 3) return 'text'
  const rest = line.slice(spaces)
  if (rest.length === 0) return 'pending'
  const marker = rest[0]
  if (marker !== '`' && marker !== '~') return 'text'
  let run = 0
  while (run < rest.length && rest[run] === marker) run++
  if (run >= 3) return 'fence'
  // A non-marker character before the third marker rules the fence out.
  return run < rest.length ? 'text' : 'pending'
}

/**
 * Streaming Markdown filter for constructs `plainText` cannot strip per delta.
 *
 * `plainText` receives one delta at a time, so a fenced code block that spans
 * several deltas never matches its own opening fence — the code would be read
 * aloud, with stray backticks. Fences can only open at the start of a line, so
 * this filter keeps two pieces of state across deltas:
 *
 * - fenced blocks: everything between ``` / ~~~ lines is dropped entirely;
 * - inline code: backticks are dropped, the content is kept (`npm install`
 *   is worth speaking, the backticks are not).
 */
class MarkdownStreamFilter {
  private inFence = false
  /** At a line start: the next characters decide whether a fence opens. */
  private atLineStart = true
  /** Leading spaces + marker run buffered until the line is decided. */
  private lookahead = ''
  private inlineCode = false
  // Closing-fence detection for the current line inside a fence.
  private fenceLineClosed = false
  private fenceRun = 0
  private fenceChar = ''
  private fenceIndent = 0

  push(chunk: string): string {
    let out = ''
    for (const ch of chunk) {
      out += this.inFence ? this.pushFenced(ch) : this.pushNormal(ch)
    }
    return out
  }

  /**
   * End of stream: a fence that never closed means the model cut off mid-code,
   * so its remaining content is dropped rather than spoken.
   */
  flush(): string {
    if (this.inFence) {
      this.reset()
      return ''
    }
    const pending = this.lookahead
    this.lookahead = ''
    this.atLineStart = false
    let out = ''
    for (const ch of pending) out += this.normalChar(ch)
    return out
  }

  private reset(): void {
    this.inFence = false
    this.atLineStart = true
    this.lookahead = ''
    this.inlineCode = false
    this.resetFenceLine()
  }

  private resetFenceLine(): void {
    this.fenceLineClosed = false
    this.fenceRun = 0
    this.fenceChar = ''
    this.fenceIndent = 0
  }

  /** Inside a fence: drop everything until a closing fence line. */
  private pushFenced(ch: string): string {
    if (ch === '\n') {
      this.resetFenceLine()
      this.atLineStart = true
      return ''
    }
    this.atLineStart = false
    if (this.fenceLineClosed) return ''
    if (this.fenceRun === 0 && this.fenceIndent < 4 && ch === ' ') {
      this.fenceIndent++
      return ''
    }
    if (ch === '`' || ch === '~') {
      if (this.fenceRun === 0) this.fenceChar = ch
      if (ch === this.fenceChar) {
        this.fenceRun++
        if (this.fenceRun >= 3) {
          // Closing fence: the rest of the line is an info string, dropped.
          this.inFence = false
          this.fenceLineClosed = true
        }
        return ''
      }
    }
    // Not a closing fence: ignore the rest of this line.
    this.fenceLineClosed = true
    return ''
  }

  /** Outside a fence: detect fence openers, strip inline backticks. */
  private pushNormal(ch: string): string {
    if (this.atLineStart && !this.inlineCode) {
      const next = this.lookahead + ch
      const verdict = classifyFenceLine(next)
      if (verdict === 'fence') {
        this.inFence = true
        this.lookahead = ''
        this.atLineStart = false
        this.resetFenceLine()
        return ''
      }
      if (verdict === 'text') {
        this.lookahead = ''
        this.atLineStart = false
        let out = ''
        for (const c of next) out += this.normalChar(c)
        return out
      }
      // Still ambiguous (leading spaces or an incomplete marker run).
      this.lookahead = next
      return ''
    }
    return this.normalChar(ch)
  }

  private normalChar(ch: string): string {
    if (ch === '\n') {
      this.atLineStart = true
      return ch
    }
    this.atLineStart = false
    if (ch === '`') {
      this.inlineCode = !this.inlineCode
      return ''
    }
    return ch
  }
}

/** Split one chunk of text at terminal punctuation, keeping the tail buffered. */
export function splitSentences(chunk: string): { sentences: string[]; tail: string } {
  const sentences: string[] = []
  let start = 0
  // CJK terminals + ASCII terminals; a lone period only terminates when
  // followed by whitespace or end-of-text (avoids splitting "3.14" / URLs).
  const re = /[。！？!?；;…\n]+|\.(?=\s|$)/g
  let m: RegExpExecArray | null
  let lastEnd = 0
  while ((m = re.exec(chunk)) !== null) {
    const end = m.index + m[0].length
    sentences.push(chunk.slice(start, end))
    start = end
    lastEnd = end
  }
  return { sentences, tail: chunk.slice(lastEnd) }
}

const CJK_ONE = /[\u3400-\u9fff]/u
const ASCII_TOKEN = /[A-Za-z0-9]/
const CLOSER = /[”’"'」』）)\]】》]/
const OPEN_VOICE = '[[voice:'

function visibleChars(text: string): number {
  return Array.from(text.replace(/\s+/gu, '')).length
}

/** Speech-bearing size: Han characters when present, otherwise visible chars. */
function clauseSize(text: string): number {
  let han = 0
  let visible = 0
  for (const ch of text) {
    if (/\s/u.test(ch)) continue
    visible += 1
    if (CJK_ONE.test(ch)) han += 1
  }
  return han > 0 ? han : visible
}

function boundaryEnd(text: string, at: number): number {
  let end = at + 1
  while (end < text.length && /[，、；：,;:。！？!?…]/u.test(text[end]!)) end += 1
  while (end < text.length && CLOSER.test(text[end]!)) end += 1
  return end
}

function findHardBoundary(text: string, before = text.length): number | null {
  for (let index = 0; index < before; index += 1) {
    const ch = text[index]!
    const terminal = ch === '\n' || '。！？!?…'.includes(ch)
      || (ch === '.' && (index + 1 >= text.length || /\s/u.test(text[index + 1]!)))
    if (terminal) return boundaryEnd(text, index)
  }
  return null
}

/**
 * A comma/colon/semicolon only cuts when it is a real prose boundary. In
 * particular "1,024" and "Windows, macOS" must stay whole.
 */
function isSoftBoundary(text: string, index: number): boolean {
  if (!/[，、；：,;:]/u.test(text[index]!)) return false
  // Look past spaces so "1, 024" and "GPT , 4" also stay one token.
  const previous = text.slice(0, index).replace(/\s+$/u, '').at(-1) ?? ''
  const next = text.slice(index + 1).replace(/^\s+/u, '')[0] ?? ''
  if (ASCII_TOKEN.test(previous) && ASCII_TOKEN.test(next)) return false
  return true
}

function findSoftBoundary(text: string, before: number, minChars: number): number | null {
  for (let index = 0; index < before; index += 1) {
    if (!isSoftBoundary(text, index)) continue
    const end = boundaryEnd(text, index)
    if (visibleChars(text.slice(0, end)) >= minChars) return end
  }
  return null
}

/** Cut after roughly N speech-bearing characters, never inside an ASCII token. */
function speechCutIndex(text: string, target: number): number {
  const hasHan = CJK_ONE.test(text)
  let count = 0
  let cut = 0
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index]!
    if (/\s/u.test(ch)) continue
    if (hasHan ? CJK_ONE.test(ch) : true) count += 1
    if (count >= target) {
      cut = index + 1
      break
    }
  }
  if (cut === 0) return text.length
  while (cut < text.length && /[，、；：,;:]/u.test(text[cut]!)) cut += 1
  while (cut > 0 && cut < text.length
    && ASCII_TOKEN.test(text[cut - 1]!) && ASCII_TOKEN.test(text[cut]!)) {
    cut -= 1
  }
  if (cut === 0) {
    let index = 0
    while (index < text.length && ASCII_TOKEN.test(text[index]!)) index += 1
    cut = index
  }
  return cut
}

/**
 * Prefer a real word boundary near the length target. This is the difference
 * between cutting "整句朗|读" and "整句朗读|拆": both are legal lengths, but
 * only the latter keeps a word whole.
 */
function wordBoundaryCutIndex(text: string, target: number, min: number, max: number): number {
  const Segmenter = (Intl as unknown as {
    Segmenter?: new (locale: string, options: { granularity: string }) => {
      segment(input: string): Iterable<{ index: number; segment: string }>
    }
  }).Segmenter
  if (!Segmenter) return -1
  let best = -1
  let bestDistance = Number.POSITIVE_INFINITY
  let bestSize = 0
  for (const part of new Segmenter('zh', { granularity: 'word' }).segment(text)) {
    const end = part.index + part.segment.length
    if (end >= text.length) continue
    const size = clauseSize(text.slice(0, end))
    if (size < min || size > max) continue
    const distance = Math.abs(size - target)
    if (distance < bestDistance || (distance === bestDistance && size > bestSize)) {
      best = end
      bestDistance = distance
      bestSize = size
    }
  }
  return best
}

function forcedCutIndex(text: string, options: { target: number; max: number; min: number }): number {
  const size = clauseSize(text)
  if (size <= options.max) return text.length
  let target = options.target
  // Do not leave a tiny tail behind: balance the final pair instead.
  if (size > target && size - target < options.min) target = Math.max(options.min, Math.floor(size / 2))
  const wordCut = wordBoundaryCutIndex(text, target, options.min, options.max)
  return wordCut > 0 ? wordCut : speechCutIndex(text, target)
}

/** Fuzzy check for a voice directive split across deltas; hold it, never read it. */
function partialVoiceDirectiveAt(text: string): number {
  const start = text.lastIndexOf('[[')
  if (start < 0) return -1
  const tail = text.slice(start).replace(/\uFF1A/g, ':').replace(/\s+/gu, '').toLowerCase()
  if (!OPEN_VOICE.startsWith(tail) && !tail.startsWith(OPEN_VOICE)) return -1
  if (tail.startsWith(OPEN_VOICE) && text.slice(start).includes(']]')) return -1
  return start
}

/**
 * Streaming sentence -> smaller read-aloud blocks. It emits at the earliest
 * complete comma clause once it has enough speech, and cuts unpunctuated runs
 * at the length threshold. Terminal punctuation is always kept in the block.
 */
export class SentenceSegmenter {
  private buffer = ''
  private readonly minChars: number
  private readonly targetChars: number
  private readonly maxChars: number
  private sentenceId = 0
  private chunkIndex = 0
  /** A voice directive may be split across deltas; hold it until complete. */
  private directiveCarry = ''
  /** Removes markdown constructs that span deltas (fences, inline code). */
  private readonly markdown = new MarkdownStreamFilter()

  constructor(options: SegmenterOptions = {}) {
    this.minChars = Math.max(1, Math.trunc(options.minClauseChars
      ?? options.firstClauseChars ?? 6))
    const target = Math.max(this.minChars, Math.trunc(options.targetClauseChars ?? 12))
    this.targetChars = target
    this.maxChars = Math.max(target, Math.trunc(options.maxClauseChars ?? 14))
  }

  /** Feed a raw delta; returns the complete blocks it completes. */
  feedBlocks(chunk: string): SpeechBlock[] {
    const cleaned = this.cleanIncoming(chunk)
    if (!cleaned) return []
    this.buffer += cleaned
    return this.drain(false)
  }

  /** Legacy text-only API used by callers that only need captions/strings. */
  feed(chunk: string): string[] {
    return this.feedBlocks(chunk).map((block) => block.text)
  }

  /** Flush at end of stream, keeping complete terminal punctuation. */
  flushBlocks(): SpeechBlock[] {
    const rest = plainText(this.markdown.flush())
    if (rest) this.buffer += rest
    // An unclosed voice directive is control data with no payload; discard it.
    this.directiveCarry = ''
    const out = this.drain(true)
    while (this.buffer.trim()) {
      if (clauseSize(this.buffer) > this.maxChars) {
        const cut = forcedCutIndex(this.buffer, {
          target: this.targetChars, max: this.maxChars, min: this.minChars,
        })
        if (cut > 0) {
          this.take(out, cut, false)
          continue
        }
      }
      this.take(out, this.buffer.length, true)
      break
    }
    return out
  }

  flush(): string[] {
    return this.flushBlocks().map((block) => block.text)
  }

  private cleanIncoming(chunk: string): string {
    let raw = this.directiveCarry + chunk
    this.directiveCarry = ''
    raw = raw.replace(VOICE_DIRECTIVE, ' ')
    const partial = partialVoiceDirectiveAt(raw)
    if (partial >= 0) {
      this.directiveCarry = raw.slice(partial)
      raw = raw.slice(0, partial)
    }
    return raw ? plainText(this.markdown.push(raw)) : ''
  }

  private drain(flush: boolean): SpeechBlock[] {
    const out: SpeechBlock[] = []
    for (;;) {
      if (!this.buffer) break
      const hard = findHardBoundary(this.buffer)
      if (hard !== null) {
        const prefix = this.buffer.slice(0, hard)
        const size = clauseSize(prefix)
        const soft = findSoftBoundary(this.buffer, hard, this.minChars)
        if (soft !== null && soft < hard) {
          const firstClause = this.buffer.slice(0, soft)
          const firstSize = clauseSize(firstClause)
          // The first comma clause is itself over-long: split it near its
          // middle instead of leaving a tiny "阈值切分，" tail behind.
          if (firstSize > this.maxChars) {
            const cut = forcedCutIndex(firstClause, {
              target: Math.min(this.targetChars, Math.max(this.minChars, Math.ceil(firstSize / 2))),
              max: this.maxChars,
              min: this.minChars,
            })
            if (cut > 0 && cut < firstClause.length) {
              this.take(out, cut, false)
              continue
            }
          }
          // Only split inside a sentence when both pieces are substantial. A
          // 13-char sentence at a late comma reads better whole than 11+2.
          if (firstSize <= this.maxChars
            && visibleChars(this.buffer.slice(soft, hard)) >= this.minChars) {
            this.take(out, soft, false)
            continue
          }
        }
        if (size > this.maxChars + this.minChars) {
          const cut = forcedCutIndex(prefix, {
            target: this.targetChars, max: this.maxChars, min: this.minChars,
          })
          if (cut > 0 && cut < hard) {
            this.take(out, cut, false)
            continue
          }
        }
        this.take(out, hard, true)
        continue
      }

      const soft = findSoftBoundary(this.buffer, this.buffer.length, this.minChars)
      if (soft !== null) {
        const firstClause = this.buffer.slice(0, soft)
        const firstSize = clauseSize(firstClause)
        if (firstSize > this.maxChars) {
          const cut = forcedCutIndex(firstClause, {
            target: Math.min(this.targetChars, Math.max(this.minChars, Math.ceil(firstSize / 2))),
            max: this.maxChars,
            min: this.minChars,
          })
          if (cut > 0 && cut < firstClause.length) {
            this.take(out, cut, false)
            continue
          }
        }
        this.take(out, soft, false)
        continue
      }
      if (clauseSize(this.buffer) > this.maxChars) {
        const cut = forcedCutIndex(this.buffer, {
          target: this.targetChars, max: this.maxChars, min: this.minChars,
        })
        if (cut > 0 && cut < this.buffer.length) {
          this.take(out, cut, false)
          continue
        }
      }
      break
    }
    if (flush && this.buffer.trim()) {
      const hard = findHardBoundary(this.buffer)
      if (hard === null) {
        // The outer flushBlocks loop drains long remainders after this call.
      }
    }
    return out
  }

  /** Consume a prefix, emit it if it contains speech, and advance sentence ids. */
  private take(out: SpeechBlock[], end: number, final: boolean): void {
    const raw = this.buffer.slice(0, end)
    this.buffer = this.buffer.slice(end)
    const text = stripVoiceDirectives(raw).trim()
    if (text && !SKIP_PREFIX.test(text)) {
      out.push({ text, sentenceId: this.sentenceId, chunkIndex: this.chunkIndex })
      this.chunkIndex += 1
    }
    if (final) {
      this.sentenceId += 1
      this.chunkIndex = 0
    }
  }
}

/** Segment a complete string; convenient for tests and offline comparisons. */
export function segmentSpeechBlocks(text: string, options: SegmenterOptions = {}): SpeechBlock[] {
  const segmenter = new SentenceSegmenter(options)
  return [...segmenter.feedBlocks(text), ...segmenter.flushBlocks()]
}
