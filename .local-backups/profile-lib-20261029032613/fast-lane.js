const FAST_LANE_MIN_SILENT_MS = 2200;
const FAST_LANE_GAP_MS = 6500;
const FAST_LANE_MIN_CHARS = 120;
const FAST_LANE_MAX_LINES = 2;
const FAST_LANE_TIMEOUT_MS = 700;
const FAST_LANE_MAX_TOKENS = 60;
const FAST_LANE_PROMPT_LIMIT = 700;
const FAST_LANE_MAX_CHARS = 20;
const FAST_LANE_SYSTEM_PROMPT = '\u4F60\u662F\u8BED\u97F3\u5FEB\u5C42\uFF1A\u4E3B\u6A21\u578B\u8FD8\u5728\u957F\u65F6\u95F4\u601D\u8003\uFF0C\u7528\u6237\u90A3\u8FB9\u6CA1\u6709\u58F0\u97F3\u3002\u4F60\u7684\u552F\u4E00\u4EFB\u52A1\u662F\u4ECE\u601D\u8003\u7247\u6BB5\u91CC\u6311\u51FA\u5DF2\u7ECF\u7AD9\u5F97\u4F4F\u7684\u5185\u5BB9\uFF0C\u7528\u4E00\u53E5\u8BDD\u8BF4\u7ED9\u7528\u6237\u542C\uFF0C\u8BA9\u7B49\u5F85\u4E0D\u65AD\u7EBF\u3002\u53EA\u8F93\u51FA\u4E00\u884C JSON\uFF1A{"say":"\u2026\u2026"}\u3002\u89C4\u5219\uFF1A\u4E0D\u8D85\u8FC7\u4E8C\u5341\u4E2A\u5B57\uFF0C\u53E3\u8BED\uFF0C\u4E00\u53E5\u8BDD\u4E00\u4E2A\u610F\u601D\uFF1B\u53EA\u51C6\u8BF4\u7247\u6BB5\u91CC\u5DF2\u7ECF\u786E\u5B9A\u7684\u4E1C\u897F\uFF0C\u731C\u6D4B\u3001\u5F85\u9A8C\u8BC1\u3001\u8FD8\u8981\u518D\u67E5\u7684\u5185\u5BB9\u4E0D\u80FD\u8BF4\uFF1B\u4E0D\u8981\u5BD2\u6684\uFF0C\u4E0D\u8981\u8BF4\u201C\u7A0D\u7B49\u3001\u6211\u6765\u770B\u770B\u3001\u597D\u7684\u3001\u660E\u767D\u201D\u8FD9\u7C7B\u586B\u5145\uFF1B\u4E0D\u63D0\u5DE5\u5177\u540D\u3001\u6587\u4EF6\u8DEF\u5F84\u3001\u4EE3\u7801\u3001\u82F1\u6587\u6807\u8BC6\u7B26\uFF1B\u7247\u6BB5\u91CC\u6CA1\u6709\u503C\u5F97\u8BF4\u7684\u5185\u5BB9\uFF0C\u5C31\u8F93\u51FA {"say":""}\u3002';
function fastLaneDelay(spoken) {
  return spoken === 0 ? FAST_LANE_MIN_SILENT_MS : FAST_LANE_GAP_MS;
}
function shouldRunFastLane(state) {
  if (state.enabled === false || state.directed === true || state.inFlight) return false;
  if (state.spoken >= FAST_LANE_MAX_LINES) return false;
  if (state.reasoningChars < FAST_LANE_MIN_CHARS) return false;
  return state.silentMs >= fastLaneDelay(state.spoken);
}
function buildFastLanePrompt(reasoning) {
  const tail = reasoning.trim().slice(-FAST_LANE_PROMPT_LIMIT);
  return [
    "\u6A21\u578B\u5F53\u524D\u7684\u601D\u8003\u7247\u6BB5\uFF08\u5C3E\u90E8\uFF09\uFF1A",
    tail,
    "",
    '\u6309\u89C4\u5219\u53EA\u8F93\u51FA\u4E00\u884C JSON\uFF1A{"say":"\u4E00\u53E5\u8BDD"}\uFF0C\u6CA1\u6709\u503C\u5F97\u8BF4\u7684\u5C31\u8F93\u51FA {"say":""}\u3002'
  ].join("\n");
}
const FILLER_HEAD = /^(好|好的|好滴|嗯|呃|那么|稍等|稍候|等一[下会]|我看看|我来看看|让我看看|明白|收到|了解)/;
const ASCII_RUN = /[A-Za-z0-9_\-]{3,}/;
function parseFastLaneAnswer(raw) {
  if (typeof raw !== "string" || raw.trim().length === 0) return "";
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return "";
  let say;
  try {
    say = JSON.parse(raw.slice(start, end + 1)).say;
  } catch {
    return "";
  }
  if (typeof say !== "string") return "";
  let text = say.trim().replace(/^["'“”]|["'“”]$/g, "").replace(/^[，,、。．.；;：:\s]+/u, "").trim();
  if (text.length === 0) return "";
  if (FILLER_HEAD.test(text)) return "";
  if (text.includes("http") || text.includes("/") || text.includes("\\") || text.includes("```")) return "";
  if (ASCII_RUN.test(text)) return "";
  if (text.length > FAST_LANE_MAX_CHARS) {
    const cut = text.search(/[。！？!?；;]/u);
    text = (cut > 0 ? text.slice(0, cut + 1) : "").trim();
    if (text.length === 0 || text.length > FAST_LANE_MAX_CHARS) return "";
  }
  return text;
}
const SERVO_MIN_CHARS = 60;
const SERVO_TOP_UP_MS = 1400;
const SERVO_MAX_LINES = 8;
const SERVO_FIRST_DELAY_MS = 1500;
const SERVO_CHARS_PER_SEC = 4.2;
const SERVO_SYNTH_MS = 900;
const SERVO_RETRY_MS = 2e3;
const SERVO_PROMPT_LIMIT = 420;
function shouldServe(state) {
  if (state.spoken >= SERVO_MAX_LINES) return false;
  if (state.unseenChars < SERVO_MIN_CHARS) return false;
  return state.lineEndsIn <= SERVO_TOP_UP_MS;
}
function spokenMs(text) {
  return Math.round(text.trim().length / SERVO_CHARS_PER_SEC * 1e3) + SERVO_SYNTH_MS;
}
const SERVO_SYSTEM_PROMPT = '\u4F60\u662F\u8BED\u97F3\u4F3A\u670D\u5C42\uFF1A\u4E3B\u6A21\u578B\u8FD8\u5728\u957F\u65F6\u95F4\u601D\u8003\uFF0C\u7528\u6237\u6B63\u5728\u542C\u3002\u4F60\u628A\u601D\u8003\u91CC\u5DF2\u7ECF\u786E\u5B9A\u7684\u5185\u5BB9\u6309\u987A\u5E8F\u4E00\u6BB5\u6BB5\u8BF4\u51FA\u6765\uFF0C\u586B\u6EE1\u8FD9\u6BB5\u65F6\u95F4\uFF0C\u8BA9\u6574\u6BB5\u8BDD\u542C\u8D77\u6765\u662F\u8FDE\u7EED\u8BF4\u4E0B\u53BB\u7684\u3002\u53EA\u8F93\u51FA\u4E00\u884C JSON\uFF1A{"say":"\u2026\u2026"}\u3002\u89C4\u5219\uFF1A\u4E00\u53E5\u5230\u4E24\u53E5\uFF0C\u4E0D\u8D85\u8FC7\u4E09\u5341\u4E2A\u5B57\uFF1B\u5F00\u5934\u8981\u548C\u4E0A\u4E00\u53E5\u63A5\u5F97\u4E0A\uFF0C\u4E0D\u8981\u91CD\u65B0\u8D77\u5934\uFF1B\u53EA\u8BB2\u5DF2\u7ECF\u786E\u5B9A\u7684\u5185\u5BB9\uFF0C\u731C\u6D4B\u3001\u5F85\u9A8C\u8BC1\u3001\u8FD8\u8981\u53BB\u67E5\u7684\u4E1C\u897F\u4E0D\u80FD\u8BF4\uFF1B\u4E0D\u8981\u5BD2\u6684\u548C\u586B\u5145\uFF08\u597D\u7684\u3001\u7A0D\u7B49\u3001\u6211\u6765\u770B\u4E00\u4E0B\u3001\u90A3\u4E48\u3001\u5176\u5B9E\uFF09\uFF1B\u4E0D\u63D0\u5DE5\u5177\u540D\u3001\u6587\u4EF6\u8DEF\u5F84\u3001\u4EE3\u7801\u3001\u82F1\u6587\u6807\u8BC6\u7B26\uFF1B\u6CA1\u6709\u65B0\u5185\u5BB9\u53EF\u8BF4\u5C31\u8F93\u51FA {"say":""}\u3002';
function buildServoPrompt(unseen, lastLine) {
  return [
    lastLine ? "\u4E0A\u4E00\u53E5\u5DF2\u7ECF\u8BF4\uFF1A" + lastLine : "",
    "\u601D\u8003\u91CC\u8FD8\u6CA1\u8BB2\u8FC7\u7684\u90E8\u5206\uFF1A",
    unseen.trim().slice(-SERVO_PROMPT_LIMIT),
    "",
    '\u6309\u89C4\u5219\u53EA\u8F93\u51FA\u4E00\u884C JSON\uFF1A{"say":"\u4E00\u5230\u4E24\u53E5"}\uFF0C\u6CA1\u6709\u65B0\u5185\u5BB9\u5C31\u8F93\u51FA {"say":""}\u3002'
  ].filter(Boolean).join("\n");
}
class FastLaneServo {
  constructor(options) {
    this.options = options;
    const now = this.now();
    this.notBefore = (options.startAt ?? now) + SERVO_FIRST_DELAY_MS;
    this.lineEndsAt = this.notBefore;
  }
  unseen = "";
  lastLine = "";
  spoken = 0;
  inFlight = false;
  stopped = false;
  timer;
  lineEndsAt;
  /** The first line may not start before this instant, however early the top-up says. */
  notBefore;
  now() {
    return (this.options.now ?? Date.now)();
  }
  /** New reasoning text arrived. */
  push(delta) {
    if (this.stopped || delta.length === 0) return;
    this.unseen = (this.unseen + delta).slice(-2e3);
    this.schedule();
  }
  /** The answer took over, or the owner asked for silence. */
  stop(reason) {
    if (this.stopped) return;
    this.stopped = true;
    void reason;
    if (this.timer !== void 0) {
      clearTimeout(this.timer);
      this.timer = void 0;
    }
  }
  get isStopped() {
    return this.stopped;
  }
  get linesSpoken() {
    return this.spoken;
  }
  /** Milliseconds until the next possible line, or undefined when idle. */
  waitMs() {
    if (this.stopped || this.inFlight || !this.options.call) return void 0;
    const state = {
      unseenChars: this.unseen.trim().length,
      lineEndsIn: this.lineEndsAt - this.now(),
      spoken: this.spoken
    };
    if (this.spoken >= SERVO_MAX_LINES) return void 0;
    const floor = Math.max(this.notBefore - this.now(), 0);
    if (shouldServe(state) && floor === 0) return 0;
    return Math.max(Math.max(state.lineEndsIn - SERVO_TOP_UP_MS, 0), floor);
  }
  schedule() {
    const wait = this.waitMs();
    if (wait === void 0) return;
    if (this.timer !== void 0) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = void 0;
      this.fire();
    }, Math.max(wait, 0));
  }
  fire() {
    const call = this.options.call;
    if (!call || this.stopped || this.inFlight) return;
    const state = {
      unseenChars: this.unseen.trim().length,
      lineEndsIn: this.lineEndsAt - this.now(),
      spoken: this.spoken
    };
    if (!shouldServe(state) || this.notBefore > this.now()) {
      this.schedule();
      return;
    }
    this.inFlight = true;
    const unseen = this.unseen;
    const controller = new AbortController();
    const budget = setTimeout(() => controller.abort(), this.options.timeoutMs ?? FAST_LANE_TIMEOUT_MS);
    void call(buildServoPrompt(unseen, this.lastLine), controller.signal).then((raw) => {
      clearTimeout(budget);
      this.inFlight = false;
      if (this.stopped) return;
      const line = parseFastLaneAnswer(raw);
      if (!line) {
        this.lineEndsAt = this.now() + SERVO_RETRY_MS;
        this.schedule();
        return;
      }
      this.spoken += 1;
      this.lastLine = line;
      this.unseen = "";
      this.lineEndsAt = this.now() + spokenMs(line);
      this.options.say(line);
    }).catch(() => {
      clearTimeout(budget);
      this.inFlight = false;
      if (!this.stopped) this.schedule();
    });
  }
}
export {
  FAST_LANE_GAP_MS,
  FAST_LANE_MAX_CHARS,
  FAST_LANE_MAX_LINES,
  FAST_LANE_MAX_TOKENS,
  FAST_LANE_MIN_CHARS,
  FAST_LANE_MIN_SILENT_MS,
  FAST_LANE_PROMPT_LIMIT,
  FAST_LANE_SYSTEM_PROMPT,
  FAST_LANE_TIMEOUT_MS,
  FastLaneServo,
  SERVO_CHARS_PER_SEC,
  SERVO_FIRST_DELAY_MS,
  SERVO_MAX_LINES,
  SERVO_MIN_CHARS,
  SERVO_PROMPT_LIMIT,
  SERVO_RETRY_MS,
  SERVO_SYNTH_MS,
  SERVO_SYSTEM_PROMPT,
  SERVO_TOP_UP_MS,
  buildFastLanePrompt,
  buildServoPrompt,
  fastLaneDelay,
  parseFastLaneAnswer,
  shouldRunFastLane,
  shouldServe,
  spokenMs
};
