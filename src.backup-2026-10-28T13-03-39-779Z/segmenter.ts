/** Adapted from haoku123/dsh-voice (MIT). See NOTICE. */
/**
 * Sentence segmenter for TTS: accumulate raw text deltas, emit complete
 * sentences on Chinese/English/Japanese terminal punctuation.
 */

export interface SegmenterOptions {
  /** Max buffered chars before a forced flush (safety valve for markdown walls). */
  maxSentenceChars?: number
  /** Emit the first comma clause after this many visible chars, before the full stop. */
  firstClauseChars?: number
}

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

export class SentenceSegmenter {
  private buffer = ''
  private readonly maxChars: number
  private readonly firstClauseChars: number
  private emitted = false
  /** Removes markdown constructs that span deltas (fences, inline code). */
  private readonly markdown = new MarkdownStreamFilter()

  constructor(options: SegmenterOptions = {}) {
    this.maxChars = options.maxSentenceChars ?? 200
    this.firstClauseChars = Math.max(0, options.firstClauseChars ?? 0)
  }

  /** Feed a raw delta; returns the complete sentences it completes. */
  feed(chunk: string): string[] {
    const cleaned = plainText(this.markdown.push(chunk))
    if (!cleaned) return []
    this.buffer += cleaned
    const { sentences, tail } = splitSentences(this.buffer)
    this.buffer = tail
    const out: string[] = []
    for (const s of sentences) {
      const t = stripVoiceDirectives(s).trim()
      if (t && !SKIP_PREFIX.test(t)) out.push(t)
    }
    if (out.length > 0) this.emitted = true
    // Long first sentence: start TTS at a natural comma instead of waiting
    // for the final full stop. Only the first clause is split this way.
    if (!this.emitted && this.firstClauseChars > 0) {
      const clause = this.takeFirstClause()
      if (clause) {
        out.push(clause)
        this.emitted = true
      }
    }
    // Safety valve: a wall of text without punctuation.
    if (this.buffer.length > this.maxChars) {
      const cut = this.buffer.search(/[，,、\s]/)
      const idx = cut > 0 ? cut : Math.floor(this.maxChars / 2)
      const head = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx)
      if (head) {
        out.push(head)
        this.emitted = true
      }
    }
    return out
  }

  private takeFirstClause(): string {
    const re = /[,，、]/g
    let match: RegExpExecArray | null
    while ((match = re.exec(this.buffer)) !== null) {
      const end = match.index + 1
      const head = this.buffer.slice(0, end).trim()
      if (head.replace(/\s/g, '').length < this.firstClauseChars) continue
      this.buffer = this.buffer.slice(end)
      return head
    }
    return ''
  }

  /** Flush the remaining buffer (end of stream). */
  flush(): string[] {
    // The markdown filter may still hold a partial line start ("``"), which
    // only turns out not to be a fence once the stream ends.
    const rest = plainText(this.markdown.flush())
    if (rest) this.buffer += rest
    const t = stripVoiceDirectives(this.buffer).trim()
    this.buffer = ''
    if (t && !SKIP_PREFIX.test(t)) return [t]
    return []
  }
}
