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
  buildFastLanePrompt,
  fastLaneDelay,
  parseFastLaneAnswer,
  shouldRunFastLane
};
