const GATE_PROMPT_LIMIT = 1e3;
const GATE_MAX_TOKENS = 80;
const GATE_TIMEOUT_MS = 1200;
const GATE_TEXT_CHARS = 100;
const GATE_CONTEXT_CHARS = 90;
const GATE_QUEUE_LIMIT = 4;
const GATE_PENDING_LIMIT = 3;
const GATE_SYSTEM_PROMPT = '\u4F60\u662F\u4E3B\u4EBA\u7684\u8BED\u97F3\u610F\u56FE\u5224\u5B98\u3002\u770B\u8FD9\u53E5\u65B0\u8BDD\u548C\u73B0\u5728\u7684\u4E0A\u4E0B\u6587\uFF0C\u5224\u65AD\u5B83\u6B64\u523B\u7684\u610F\u601D\uFF1A\u63A5\u8BDD\u56DE\u7B54\u3001\u7EA0\u6B63\u3001\u8865\u5145\u3001\u50AC\u4FC3\u3001\u6362\u8BDD\u9898\u3001\u8981\u6C42\u505C\u4E0B\uFF0C\u8FD8\u662F\u81EA\u8A00\u81EA\u8BED\u6216\u65E0\u610F\u4E49\u566A\u58F0\uFF1B\u518D\u5224\u65AD\u73B0\u5728\u8BF4\u8BDD\u66F4\u597D\uFF0C\u8FD8\u662F\u7B49\u5F53\u524D\u8FD9\u53E5\u8BFB\u5B8C\u3002\u53EA\u6709\u65B0\u8BDD\u786E\u5B9E\u8981\u5BF9\u6B63\u5728\u8BF4\u7684\u5185\u5BB9\u4F5C\u51FA\u53CD\u5E94\u65F6\u624D interrupt\uFF1A\u7EA0\u6B63\u3001\u660E\u786E\u8981\u6C42\u505C\u4E0B\u6216\u6362\u8BDD\u9898\u3001\u66F4\u6025\u7684\u4E8B\u3002\u8865\u5145\u3001\u8FFD\u95EE\u7EC6\u8282\u3001\u63A5\u7740\u8BB2\u540C\u4E00\u4EF6\u4E8B\uFF0C\u7528 queue\u3002\u91CD\u590D\u5BF9\u65B9\u521A\u8BF4\u8FC7\u7684\u8BDD\u3001\u5355\u5B57\u3001\u62DF\u58F0\u3001\u65E0\u610F\u4E49\u788E\u7247\uFF0C\u7528 ignore\u3002\u6309\u610F\u601D\u5224\u65AD\uFF0C\u4E0D\u8981\u5957\u5173\u952E\u8BCD\u3002\u53EA\u8F93\u51FA\u4E00\u884CJSON\uFF1A{"action":"interrupt|queue|ignore","priority":0-100,"reason":"\u226412\u5B57"}\u3002';
function clip(text, limit) {
  const flat = String(text ?? "").replace(/\s+/gu, " ").trim();
  return flat.length > limit ? flat.slice(0, limit) : flat;
}
function buildGatePrompt(input) {
  const pending = (input.pending ?? []).map((line) => clip(line, GATE_CONTEXT_CHARS)).filter(Boolean);
  const playingText = clip(input.playingText ?? "", GATE_CONTEXT_CHARS) || pending[0] || "";
  const rest = playingText && pending[0] === playingText ? pending.slice(1) : pending;
  const waiting = (input.queue ?? []).map((line) => clip(line, GATE_CONTEXT_CHARS)).filter(Boolean);
  const lines = [
    "\u65B0\u8BDD\uFF1A" + clip(input.text, GATE_TEXT_CHARS),
    "\u6B63\u5728\u8BFB\uFF1A" + (input.playing ? playingText || "\uFF08\u52A9\u624B\u521A\u521A\u5F00\u53E3\uFF09" : "\u65E0\uFF0C\u52A9\u624B\u7A7A\u95F2")
  ];
  const owed = rest.slice(0, GATE_PENDING_LIMIT).join(" / ");
  if (owed) lines.push("\u8FD8\u6CA1\u8BFB\uFF1A" + clip(owed, GATE_CONTEXT_CHARS * 2));
  const queueText = waiting.slice(0, GATE_QUEUE_LIMIT).join(" / ");
  lines.push("\u6392\u961F\uFF1A" + Math.max(0, Math.round(input.queued)) + " \u6761" + (queueText ? "\uFF0C\u4F9D\u6B21\u662F " + clip(queueText, GATE_CONTEXT_CHARS * 2) : ""));
  if (input.previousText) lines.push("\u4E0A\u4E00\u53E5\uFF1A" + clip(input.previousText, GATE_CONTEXT_CHARS));
  return lines.join("\n");
}
function gatePromptChars(input) {
  return GATE_SYSTEM_PROMPT.length + buildGatePrompt(input).length;
}
export {
  GATE_CONTEXT_CHARS,
  GATE_MAX_TOKENS,
  GATE_PENDING_LIMIT,
  GATE_PROMPT_LIMIT,
  GATE_QUEUE_LIMIT,
  GATE_SYSTEM_PROMPT,
  GATE_TEXT_CHARS,
  GATE_TIMEOUT_MS,
  buildGatePrompt,
  gatePromptChars
};
