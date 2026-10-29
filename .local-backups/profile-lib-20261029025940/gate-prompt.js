const GATE_PROMPT_LIMIT = 400;
const GATE_MAX_TOKENS = 24;
const GATE_TIMEOUT_MS = 400;
const GATE_TEXT_CHARS = 80;
const GATE_SYSTEM_PROMPT = '\u4F60\u662F\u8BED\u97F3\u63D2\u8BDD\u5FEB\u5224\u5668\u3002\u53EA\u8F93\u51FA\u4E00\u884CJSON\uFF1A{"action":"interrupt|queue|ignore|drop","priority":0-100,"reason":"\u22648\u5B57"}\u3002\u6B63\u5728\u6717\u8BFB\u4E14\u65B0\u8BDD\u660E\u786E\u8981\u6C42\u505C\u4E0B\u3001\u6362\u8BDD\u9898\u3001\u66F4\u6025\uFF0C\u624D interrupt\uFF1B\u566A\u58F0\uFF08\u5355\u5B57\u3001\u55EF\u554A\u3001The\u3001Yeah\u3001\u65E0\u610F\u4E49\u788E\u7247\uFF09\u7528 ignore\uFF1B\u5176\u4F59 queue\u3002\u4E0D\u89E3\u91CA\u3001\u4E0D\u6362\u884C\u3001\u4E0D\u8F93\u51FA\u5176\u4ED6\u5B57\u6BB5\u3002';
function clip(text, limit) {
  const flat = String(text ?? "").replace(/\s+/gu, " ").trim();
  return flat.length > limit ? flat.slice(0, limit) : flat;
}
function buildGatePrompt(input) {
  return [
    "\u6717\u8BFB\u4E2D\uFF1A" + (input.playing ? "\u662F" : "\u5426"),
    "\u6392\u961F\uFF1A" + Math.max(0, Math.round(input.queued)),
    "\u65B0\u8BDD\uFF1A" + clip(input.text, GATE_TEXT_CHARS)
  ].join("\n");
}
function gatePromptChars(input) {
  return GATE_SYSTEM_PROMPT.length + buildGatePrompt(input).length;
}
export {
  GATE_MAX_TOKENS,
  GATE_PROMPT_LIMIT,
  GATE_SYSTEM_PROMPT,
  GATE_TEXT_CHARS,
  GATE_TIMEOUT_MS,
  buildGatePrompt,
  gatePromptChars
};
