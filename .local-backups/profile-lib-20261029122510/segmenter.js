const TERMINAL = /[。！？!?；;…\n]/;
const SKIP_PREFIX = /^[\s.,，、:：;；!?！？)\]）"'”’〉》】]+$/;
const VOICE_DIRECTIVE = /\[\[\s*voice\s*[:：][\s\S]*?\]\]/gi;
function stripVoiceDirectives(text) {
  return text.replace(VOICE_DIRECTIVE, " ");
}
function plainText(text) {
  return stripVoiceDirectives(String(text)).replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ").replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/^#{1,6}\s+/gm, "").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1").replace(/^[-*+]\s+/gm, "").replace(/^\d+\.\s+/gm, "").replace(/<\/?[a-zA-Z][^>]*>/g, " ").replace(/https?:\/\/[^\s]+/g, " ").replace(/\b[A-Za-z]:\\[^\s，。！？；：、）】》]+/g, " ").replace(/(?:^|[\s(（])\/[A-Za-z0-9_.\-/]{2,}/g, " ").replace(/\b[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|json|md|py|sh|ps1|yml|yaml|toml|log)\b/gi, " ");
}
const CJK = /[\u3400-\u9fff]/;
function hasSpeechContent(text) {
  return CJK.test(text);
}
const HEAD_FILLERS = [
  "\u8BA9\u6211\u60F3\u60F3",
  "\u8BA9\u6211\u770B\u770B",
  "\u6211\u6765\u770B\u4E00\u4E0B",
  "\u6211\u6765\u770B\u770B",
  "\u6211\u5148\u770B\u4E00\u4E0B",
  "\u6211\u5148\u770B\u770B",
  "\u6211\u5148\u786E\u8BA4\u4E00\u4E0B",
  "\u6211\u5148\u786E\u8BA4",
  "\u7A0D\u7B49\u6211\u770B\u4E00\u4E0B",
  "\u7A0D\u7B49\u4E00\u4E0B",
  "\u7A0D\u7B49",
  "\u603B\u7684\u6765\u8BF4",
  "\u7B80\u5355\u6765\u8BF4",
  "\u9700\u8981\u6CE8\u610F\u7684\u662F",
  "\u90A3\u4E48",
  "\u73B0\u5728",
  "\u5176\u5B9E",
  "\u5C31\u662F\u8BF4",
  "\u8FD9\u4E2A",
  "\u597D",
  "\u5BF9",
  "\u55EF",
  "\u5443"
];
const FILLER_HEAD = new RegExp("^(?:" + HEAD_FILLERS.join("|") + ")[\uFF0C,\u3002.\u3001\uFF1B;\uFF1A:\\s]*", "u");
function stripFillerHead(text) {
  let out = text.trim();
  for (let round = 0; round < 4; round += 1) {
    const match = FILLER_HEAD.exec(out);
    if (!match) break;
    const rest = out.slice(match[0].length).trim();
    if (visibleChars(rest) < 6) break;
    out = rest;
  }
  return out;
}
function sanitizeForSpeech(text) {
  return plainText(String(text)).replace(/\s+/g, " ").trim();
}
function classifyFenceLine(line) {
  if (line.includes("\n")) return "text";
  let spaces = 0;
  while (spaces < line.length && line[spaces] === " ") spaces++;
  if (spaces > 3) return "text";
  const rest = line.slice(spaces);
  if (rest.length === 0) return "pending";
  const marker = rest[0];
  if (marker !== "`" && marker !== "~") return "text";
  let run = 0;
  while (run < rest.length && rest[run] === marker) run++;
  if (run >= 3) return "fence";
  return run < rest.length ? "text" : "pending";
}
class MarkdownStreamFilter {
  inFence = false;
  /** At a line start: the next characters decide whether a fence opens. */
  atLineStart = true;
  /** Leading spaces + marker run buffered until the line is decided. */
  lookahead = "";
  inlineCode = false;
  // Closing-fence detection for the current line inside a fence.
  fenceLineClosed = false;
  fenceRun = 0;
  fenceChar = "";
  fenceIndent = 0;
  push(chunk) {
    let out = "";
    for (const ch of chunk) {
      out += this.inFence ? this.pushFenced(ch) : this.pushNormal(ch);
    }
    return out;
  }
  /**
   * End of stream: a fence that never closed means the model cut off mid-code,
   * so its remaining content is dropped rather than spoken.
   */
  flush() {
    if (this.inFence) {
      this.reset();
      return "";
    }
    const pending = this.lookahead;
    this.lookahead = "";
    this.atLineStart = false;
    let out = "";
    for (const ch of pending) out += this.normalChar(ch);
    return out;
  }
  reset() {
    this.inFence = false;
    this.atLineStart = true;
    this.lookahead = "";
    this.inlineCode = false;
    this.resetFenceLine();
  }
  resetFenceLine() {
    this.fenceLineClosed = false;
    this.fenceRun = 0;
    this.fenceChar = "";
    this.fenceIndent = 0;
  }
  /** Inside a fence: drop everything until a closing fence line. */
  pushFenced(ch) {
    if (ch === "\n") {
      this.resetFenceLine();
      this.atLineStart = true;
      return "";
    }
    this.atLineStart = false;
    if (this.fenceLineClosed) return "";
    if (this.fenceRun === 0 && this.fenceIndent < 4 && ch === " ") {
      this.fenceIndent++;
      return "";
    }
    if (ch === "`" || ch === "~") {
      if (this.fenceRun === 0) this.fenceChar = ch;
      if (ch === this.fenceChar) {
        this.fenceRun++;
        if (this.fenceRun >= 3) {
          this.inFence = false;
          this.fenceLineClosed = true;
        }
        return "";
      }
    }
    this.fenceLineClosed = true;
    return "";
  }
  /** Outside a fence: detect fence openers, strip inline backticks. */
  pushNormal(ch) {
    if (this.atLineStart && !this.inlineCode) {
      const next = this.lookahead + ch;
      const verdict = classifyFenceLine(next);
      if (verdict === "fence") {
        this.inFence = true;
        this.lookahead = "";
        this.atLineStart = false;
        this.resetFenceLine();
        return "";
      }
      if (verdict === "text") {
        this.lookahead = "";
        this.atLineStart = false;
        let out = "";
        for (const c of next) out += this.normalChar(c);
        return out;
      }
      this.lookahead = next;
      return "";
    }
    return this.normalChar(ch);
  }
  normalChar(ch) {
    if (ch === "\n") {
      this.atLineStart = true;
      return ch;
    }
    this.atLineStart = false;
    if (ch === "`") {
      this.inlineCode = !this.inlineCode;
      return "";
    }
    return ch;
  }
}
function splitSentences(chunk) {
  const sentences = [];
  let start = 0;
  const re = /[。！？!?；;…\n]+|\.(?=\s|$)/g;
  let m;
  let lastEnd = 0;
  while ((m = re.exec(chunk)) !== null) {
    const end = m.index + m[0].length;
    sentences.push(chunk.slice(start, end));
    start = end;
    lastEnd = end;
  }
  return { sentences, tail: chunk.slice(lastEnd) };
}
const CJK_ONE = /[\u3400-\u9fff]/u;
const ASCII_TOKEN = /[A-Za-z0-9]/;
const CLOSER = /[”’"'」』）)\]】》]/;
const OPEN_VOICE = "[[voice:";
function visibleChars(text) {
  return Array.from(text.replace(/\s+/gu, "")).length;
}
function clauseSize(text) {
  let han = 0;
  let visible = 0;
  for (const ch of text) {
    if (/\s/u.test(ch)) continue;
    visible += 1;
    if (CJK_ONE.test(ch)) han += 1;
  }
  return han > 0 ? han : visible;
}
function boundaryEnd(text, at) {
  let end = at + 1;
  while (end < text.length && /[，、；：,;:。！？!?…]/u.test(text[end])) end += 1;
  while (end < text.length && CLOSER.test(text[end])) end += 1;
  return end;
}
function findHardBoundary(text, before = text.length) {
  for (let index = 0; index < before; index += 1) {
    const ch = text[index];
    const terminal = ch === "\n" || "\u3002\uFF01\uFF1F!?\u2026".includes(ch) || ch === "." && (index + 1 >= text.length || /\s/u.test(text[index + 1]));
    if (terminal) return boundaryEnd(text, index);
  }
  return null;
}
function isSoftBoundary(text, index) {
  if (!/[，、；：,;:]/u.test(text[index])) return false;
  const previous = text.slice(0, index).replace(/\s+$/u, "").at(-1) ?? "";
  const next = text.slice(index + 1).replace(/^\s+/u, "")[0] ?? "";
  if (ASCII_TOKEN.test(previous) && ASCII_TOKEN.test(next)) return false;
  return true;
}
function findSoftBoundary(text, before, minChars) {
  for (let index = 0; index < before; index += 1) {
    if (!isSoftBoundary(text, index)) continue;
    const end = boundaryEnd(text, index);
    if (visibleChars(text.slice(0, end)) >= minChars) return end;
  }
  return null;
}
function speechCutIndex(text, target) {
  const hasHan = CJK_ONE.test(text);
  let count = 0;
  let cut = 0;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (/\s/u.test(ch)) continue;
    if (hasHan ? CJK_ONE.test(ch) : true) count += 1;
    if (count >= target) {
      cut = index + 1;
      break;
    }
  }
  if (cut === 0) return text.length;
  while (cut < text.length && /[，、；：,;:]/u.test(text[cut])) cut += 1;
  while (cut > 0 && cut < text.length && ASCII_TOKEN.test(text[cut - 1]) && ASCII_TOKEN.test(text[cut])) {
    cut -= 1;
  }
  if (cut === 0) {
    let index = 0;
    while (index < text.length && ASCII_TOKEN.test(text[index])) index += 1;
    cut = index;
  }
  return cut;
}
function wordBoundaryCutIndex(text, target, min, max) {
  const Segmenter = Intl.Segmenter;
  if (!Segmenter) return -1;
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestSize = 0;
  for (const part of new Segmenter("zh", { granularity: "word" }).segment(text)) {
    const end = part.index + part.segment.length;
    if (end >= text.length) continue;
    const size = clauseSize(text.slice(0, end));
    if (size < min || size > max) continue;
    const distance = Math.abs(size - target);
    if (distance < bestDistance || distance === bestDistance && size > bestSize) {
      best = end;
      bestDistance = distance;
      bestSize = size;
    }
  }
  return best;
}
function forcedCutIndex(text, options) {
  const size = clauseSize(text);
  if (size <= options.max) return text.length;
  let target = options.target;
  if (size > target && size - target < options.min) target = Math.max(options.min, Math.floor(size / 2));
  const wordCut = wordBoundaryCutIndex(text, target, options.min, options.max);
  return wordCut > 0 ? wordCut : speechCutIndex(text, target);
}
function partialVoiceDirectiveAt(text) {
  const start = text.lastIndexOf("[[");
  if (start < 0) return -1;
  const tail = text.slice(start).replace(/\uFF1A/g, ":").replace(/\s+/gu, "").toLowerCase();
  if (!OPEN_VOICE.startsWith(tail) && !tail.startsWith(OPEN_VOICE)) return -1;
  if (tail.startsWith(OPEN_VOICE) && text.slice(start).includes("]]")) return -1;
  return start;
}
class SentenceSegmenter {
  buffer = "";
  minChars;
  targetChars;
  maxChars;
  sentenceId = 0;
  chunkIndex = 0;
  /** A voice directive may be split across deltas; hold it until complete. */
  directiveCarry = "";
  /** Removes markdown constructs that span deltas (fences, inline code). */
  markdown = new MarkdownStreamFilter();
  constructor(options = {}) {
    this.minChars = Math.max(1, Math.trunc(options.minClauseChars ?? options.firstClauseChars ?? 6));
    const target = Math.max(this.minChars, Math.trunc(options.targetClauseChars ?? 12));
    this.targetChars = target;
    this.maxChars = Math.max(target, Math.trunc(options.maxClauseChars ?? 14));
  }
  /** Feed a raw delta; returns the complete blocks it completes. */
  feedBlocks(chunk) {
    const cleaned = this.cleanIncoming(chunk);
    if (!cleaned) return [];
    this.buffer += cleaned;
    return this.drain(false);
  }
  /** Legacy text-only API used by callers that only need captions/strings. */
  feed(chunk) {
    return this.feedBlocks(chunk).map((block) => block.text);
  }
  /** Flush at end of stream, keeping complete terminal punctuation. */
  flushBlocks() {
    const rest = plainText(this.markdown.flush());
    if (rest) this.buffer += rest;
    this.directiveCarry = "";
    const out = this.drain(true);
    while (this.buffer.trim()) {
      if (clauseSize(this.buffer) > this.maxChars) {
        const cut = forcedCutIndex(this.buffer, {
          target: this.targetChars,
          max: this.maxChars,
          min: this.minChars
        });
        if (cut > 0) {
          this.take(out, cut, false);
          continue;
        }
      }
      this.take(out, this.buffer.length, true);
      break;
    }
    return out;
  }
  flush() {
    return this.flushBlocks().map((block) => block.text);
  }
  cleanIncoming(chunk) {
    let raw = this.directiveCarry + chunk;
    this.directiveCarry = "";
    raw = raw.replace(VOICE_DIRECTIVE, " ");
    const partial = partialVoiceDirectiveAt(raw);
    if (partial >= 0) {
      this.directiveCarry = raw.slice(partial);
      raw = raw.slice(0, partial);
    }
    return raw ? plainText(this.markdown.push(raw)) : "";
  }
  drain(flush) {
    const out = [];
    for (; ; ) {
      if (!this.buffer) break;
      const hard = findHardBoundary(this.buffer);
      if (hard !== null) {
        const prefix = this.buffer.slice(0, hard);
        const size = clauseSize(prefix);
        const soft2 = findSoftBoundary(this.buffer, hard, this.minChars);
        if (soft2 !== null && soft2 < hard) {
          const firstClause = this.buffer.slice(0, soft2);
          const firstSize = clauseSize(firstClause);
          if (firstSize > this.maxChars) {
            const cut = forcedCutIndex(firstClause, {
              target: Math.min(this.targetChars, Math.max(this.minChars, Math.ceil(firstSize / 2))),
              max: this.maxChars,
              min: this.minChars
            });
            if (cut > 0 && cut < firstClause.length) {
              this.take(out, cut, false);
              continue;
            }
          }
          if (firstSize <= this.maxChars && visibleChars(this.buffer.slice(soft2, hard)) >= this.minChars) {
            this.take(out, soft2, false);
            continue;
          }
        }
        if (size > this.maxChars + this.minChars) {
          const cut = forcedCutIndex(prefix, {
            target: this.targetChars,
            max: this.maxChars,
            min: this.minChars
          });
          if (cut > 0 && cut < hard) {
            this.take(out, cut, false);
            continue;
          }
        }
        this.take(out, hard, true);
        continue;
      }
      const soft = findSoftBoundary(this.buffer, this.buffer.length, this.minChars);
      if (soft !== null) {
        const firstClause = this.buffer.slice(0, soft);
        const firstSize = clauseSize(firstClause);
        if (firstSize > this.maxChars) {
          const cut = forcedCutIndex(firstClause, {
            target: Math.min(this.targetChars, Math.max(this.minChars, Math.ceil(firstSize / 2))),
            max: this.maxChars,
            min: this.minChars
          });
          if (cut > 0 && cut < firstClause.length) {
            this.take(out, cut, false);
            continue;
          }
        }
        this.take(out, soft, false);
        continue;
      }
      if (clauseSize(this.buffer) > this.maxChars) {
        const cut = forcedCutIndex(this.buffer, {
          target: this.targetChars,
          max: this.maxChars,
          min: this.minChars
        });
        if (cut > 0 && cut < this.buffer.length) {
          this.take(out, cut, false);
          continue;
        }
      }
      break;
    }
    if (flush && this.buffer.trim()) {
      const hard = findHardBoundary(this.buffer);
      if (hard === null) {
      }
    }
    return out;
  }
  /** Consume a prefix, emit it if it contains speech, and advance sentence ids. */
  take(out, end, final) {
    const raw = this.buffer.slice(0, end);
    this.buffer = this.buffer.slice(end);
    const text = stripVoiceDirectives(raw).trim();
    if (text && !SKIP_PREFIX.test(text)) {
      out.push({ text, sentenceId: this.sentenceId, chunkIndex: this.chunkIndex });
      this.chunkIndex += 1;
    }
    if (final) {
      this.sentenceId += 1;
      this.chunkIndex = 0;
    }
  }
}
function segmentSpeechBlocks(text, options = {}) {
  const segmenter = new SentenceSegmenter(options);
  return [...segmenter.feedBlocks(text), ...segmenter.flushBlocks()];
}
export {
  SentenceSegmenter,
  hasSpeechContent,
  plainText,
  sanitizeForSpeech,
  segmentSpeechBlocks,
  splitSentences,
  stripFillerHead
};
