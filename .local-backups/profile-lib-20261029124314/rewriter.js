const REWRITE_SYSTEM_PROMPT = '\u4F60\u662F\u8BED\u97F3\u8F93\u51FA\u7684\u6539\u5199\u5668\u3002\u628A\u5F85\u5FF5\u7684\u788E\u7247\u5757\u6539\u5199\u6210\u4E00\u6BB5\u81EA\u7136\u53E3\u8BED\u7A3F\uFF1A\u5408\u5E76\u788E\u5757\u3001\u91CD\u8981\u7684\u63D0\u524D\u3001\u8865\u4E00\u53E5\u81EA\u7136\u7684\u8854\u63A5\u3001\u5220\u6389\u91CD\u590D\u548C\u8DD1\u9898\uFF0C\u4E0D\u8981\u65B0\u589E\u4E8B\u5B9E\u3002\u53EA\u8F93\u51FA\u4E00\u884C JSON\uFF1A{"lines":["\u7B2C\u4E00\u53E5","\u7B2C\u4E8C\u53E5"]}';
const REWRITE_TIMEOUT_MS = 450;
const REWRITE_MAX_TOKENS = 120;
const REWRITE_PROMPT_LIMIT = 900;
const OFF_TOPIC = /^(另外|顺便|对了|还有一点|顺带)/u;
const FILLER = /^(嗯|呃|那个|这个|就是说)[，,。.！!]?$/u;
function normalize(text) {
  return text.replace(/[\s，。、；：！？,.;:!?~～…—"'“”‘’()（）]/gu, "");
}
function dedupeBlocks(blocks) {
  const kept = [];
  const seen = [];
  for (const block of blocks) {
    const key = normalize(block.text);
    if (key.length === 0) continue;
    if (FILLER.test(block.text.trim())) continue;
    if (seen.some((other) => other === key || other.includes(key))) continue;
    seen.push(key);
    kept.push(block);
  }
  return kept;
}
function joinLine(left, right) {
  if (/[。！？!?；;]$/u.test(left)) return left + right;
  return left.replace(/[，,、]$/u, "") + "\uFF0C" + right;
}
function orderBlocks(blocks) {
  const merged = [];
  for (const block of blocks) {
    const text = block.text.trim();
    if (!text) continue;
    const last = merged[merged.length - 1];
    if (last && block.sentenceId !== void 0 && last.sentenceId === block.sentenceId) {
      last.text = joinLine(last.text, text);
      continue;
    }
    merged.push({ text, sentenceId: block.sentenceId, tangent: OFF_TOPIC.test(text) });
  }
  const main = merged.filter((line) => !line.tangent);
  const tangents = merged.filter((line) => line.tangent);
  return [...main, ...tangents].map((line) => line.text);
}
function rewriteByRules(input) {
  return { spoken: input.spoken, lines: orderBlocks(dedupeBlocks(input.pending)), mode: "rule" };
}
function newLineText(spoken, line) {
  const text = line.trim();
  if (!text) return "";
  for (const heard of spoken) {
    if (heard === text || heard.endsWith(text)) return "";
  }
  let longest = "";
  for (const heard of spoken) {
    if (heard.length > longest.length && text.length > heard.length && text.startsWith(heard)) {
      longest = heard;
    }
  }
  if (longest) return text.slice(longest.length).replace(/^[，,、。．.；;：:\s]+/u, "").trim();
  return text;
}
const REPEAT_MIN_CHARS = 6;
const REPEAT_CONTAINMENT = 0.85;
const REPEAT_LENGTH_RATIO = 0.7;
function isLikelyRepeat(spoken, line) {
  const strip = (value) => value.replace(/[\s，,、。．.！？!?；;：:…—\-]/gu, "");
  const clean = strip(line);
  if (clean.length < REPEAT_MIN_CHARS) return false;
  for (const heard of spoken) {
    const other = strip(heard);
    if (other.length < REPEAT_MIN_CHARS) continue;
    const [short, long] = clean.length <= other.length ? [clean, other] : [other, clean];
    if (short.length < long.length * REPEAT_LENGTH_RATIO) continue;
    const chars = new Set(short);
    let hit = 0;
    for (const ch of chars) if (long.includes(ch)) hit += 1;
    if (hit / chars.size >= REPEAT_CONTAINMENT) return true;
  }
  return false;
}
function buildRewritePrompt(input) {
  const pending = input.pending.map((block, index) => index + 1 + ". " + block.text).join("\n");
  return [
    input.spoken ? "\u4E0A\u4E00\u53E5\u5DF2\u7ECF\u5FF5\u8FC7\uFF1A" + input.spoken : "",
    "\u8FD8\u6CA1\u5FF5\u7684\u5757\uFF08\u6309\u5230\u8FBE\u987A\u5E8F\uFF09\uFF1A",
    pending,
    "\u628A\u5B83\u4EEC\u6539\u5199\u6210\u4E00\u6BB5\u8981\u5FF5\u51FA\u6765\u7684\u53E3\u8BED\u7A3F\uFF1A\u5408\u5E76\u788E\u5757\u3001\u628A\u91CD\u8981\u7684\u6392\u524D\u9762\u3001\u8865\u4E00\u53E5\u81EA\u7136\u7684\u8854\u63A5\u3001\u5220\u6389\u91CD\u590D\u548C\u8DD1\u9898\u7684\u5185\u5BB9\u3002",
    '\u4E0D\u8981\u65B0\u589E\u4E8B\u5B9E\uFF0C\u4E0D\u8981\u6539\u5199\u4E0A\u4E00\u53E5\u3002\u53EA\u8F93\u51FA\u4E00\u884C JSON\uFF1A{"lines":["\u7B2C\u4E00\u53E5","\u7B2C\u4E8C\u53E5"]}'
  ].filter(Boolean).join("\n").slice(0, REWRITE_PROMPT_LIMIT);
}
function parseRewriteAnswer(raw) {
  const text = raw.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  try {
    const value = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(value.lines)) return [];
    return value.lines.filter((line) => typeof line === "string").map((line) => line.trim()).filter((line) => line.length > 0).slice(0, 12);
  } catch {
    return [];
  }
}
async function rewriteBlocks(input, options = {}) {
  const fallback = rewriteByRules(input);
  if (!options.call) return fallback;
  const timeoutMs = options.timeoutMs ?? REWRITE_TIMEOUT_MS;
  const controller = new AbortController();
  let timer;
  try {
    const answer = await Promise.race([
      options.call(buildRewritePrompt(input), controller.signal),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(null);
        }, timeoutMs);
      })
    ]);
    if (answer === null) return fallback;
    const lines = parseRewriteAnswer(answer);
    if (lines.length === 0) return fallback;
    return { spoken: input.spoken, lines, mode: "model" };
  } catch {
    return fallback;
  } finally {
    if (timer !== void 0) clearTimeout(timer);
  }
}
class StagedRewriter {
  constructor(options = {}) {
    this.options = options;
  }
  blocks = [];
  spokenText = "";
  published = [];
  mode = "rule";
  inFlight = false;
  dirty = false;
  firstRequestAt;
  /** A block arrived. Returns the draft that is valid right now. */
  push(block) {
    this.blocks.push(block);
    const draft = rewriteByRules({ spoken: this.spokenText, pending: this.blocks });
    this.publish(draft);
    this.request();
    return draft;
  }
  /** Context for the next request: the line the listener just heard. */
  markSpoken(text) {
    this.spokenText = text;
  }
  /** Lines that are published but not spoken yet. */
  lines() {
    return [...this.published];
  }
  get currentMode() {
    return this.mode;
  }
  /** Milliseconds between the first block and the first request. */
  firstRequestDelay() {
    if (this.firstRequestAt === void 0) return void 0;
    return this.firstRequestAt - this.firstBlockAt;
  }
  firstBlockAt;
  publish(result) {
    this.published = result.lines;
    this.mode = result.mode;
    try {
      this.options.onPublish?.(result);
    } catch {
    }
  }
  request() {
    const call = this.options.call;
    if (!call) return;
    const now = this.options.now ?? Date.now;
    if (this.firstBlockAt === void 0) this.firstBlockAt = now();
    if (this.inFlight) {
      this.dirty = true;
      return;
    }
    this.inFlight = true;
    if (this.firstRequestAt === void 0) this.firstRequestAt = now();
    const input = { spoken: this.spokenText, pending: [...this.blocks] };
    void rewriteBlocks(input, { call, timeoutMs: this.options.timeoutMs }).then((result) => {
      this.inFlight = false;
      this.publish(result);
      if (this.dirty) {
        this.dirty = false;
        this.request();
      }
    }).catch(() => {
      this.inFlight = false;
    });
  }
}
function ruleOnly(input) {
  return rewriteByRules(input);
}
function speechKey(text) {
  return text.replace(/[\s，。！？、：；,.!?:;"'“”‘’…—\-]/gu, "");
}
export {
  REWRITE_MAX_TOKENS,
  REWRITE_PROMPT_LIMIT,
  REWRITE_SYSTEM_PROMPT,
  REWRITE_TIMEOUT_MS,
  StagedRewriter,
  buildRewritePrompt,
  dedupeBlocks,
  isLikelyRepeat,
  newLineText,
  orderBlocks,
  parseRewriteAnswer,
  rewriteBlocks,
  rewriteByRules,
  ruleOnly,
  speechKey
};
