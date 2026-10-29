const SPEAKER_SYSTEM_PROMPT = [
  '\u4F60\u628A\u52A9\u624B\u5199\u597D\u7684\u56DE\u7B54"\u8BF4\u51FA\u6765"\u3002\u4F60\u4E0D\u662F\u6539\u6807\u70B9,\u662F\u91CD\u65B0\u8BB2\u4E00\u904D\u3002',
  "\u89C4\u5219:",
  "1 \u53EA\u8F93\u51FA\u8981\u8BF4\u7684\u8BDD,\u4E00\u884C\u4E00\u53E5\u3002\u4E0D\u8981\u6807\u9898\u3001\u5217\u8868\u3001\u7F16\u53F7\u3001\u62EC\u53F7\u3001\u5F15\u53F7\u3002",
  "2 \u5148\u8BF4\u7ED3\u8BBA,\u518D\u8BF4\u7406\u7531\u3002\u4E00\u53E5\u4E00\u4E2A\u610F\u601D,\u53E3\u8BED,\u77ED\u53E5\u3002",
  '3 \u5DF2\u7ECF\u5FF5\u8FC7\u7684\u5185\u5BB9\u548C\u5F00\u5934\u4E0D\u8981\u91CD\u590D;\u4E0D\u8981\u5BD2\u6684,\u4E0D\u8981"\u597D\u7684""\u90A3\u4E48"\u3002',
  "4 \u6570\u5B57\u548C\u4E13\u6709\u540D\u8BCD\u7167\u8BF4,\u4E0D\u5FF5\u7B26\u53F7\u3001\u4EE3\u7801\u3001\u8DEF\u5F84\u3002",
  "5 \u4E09\u5230\u4E94\u884C,\u603B\u5171\u4E0D\u8D85\u8FC7\u4E00\u767E\u4E8C\u5341\u5B57\u3002\u4FE1\u606F\u4E0D\u591F\u5C31\u5C11\u8BF4,\u4E0D\u8BB8\u7F16\u3002"
].join("\n");
const SPEAKER_MAX_TOKENS = 320;
function buildSpeakerPrompt(text, heard, question) {
  const body = text.trim().slice(0, 900);
  const already = heard.map((line) => line.trim()).filter((line) => line.length > 0).slice(-4).join(" / ");
  const rows = [
    question ? "\u5BF9\u65B9\u521A\u8BF4\u7684: " + question.trim().slice(0, 120) : "",
    already ? "\u5DF2\u7ECF\u8BF4\u8FC7\u7684: " + already : "",
    "\u8981\u8BB2\u7684\u5185\u5BB9:",
    body
  ].filter(Boolean);
  return rows.join("\n");
}
const LINE_PREFIX = /^\s*(?:[-*#>]+|\d+[.、)]|[（(]\d+[)）])\s*/u;
const SYMBOL_ONLY = /^[\s\p{P}\p{S}]+$/u;
function parseSpeakerLines(raw) {
  if (typeof raw !== "string" || raw.length === 0) return [];
  const lines = [];
  for (const source of raw.split(/\r?\n/u)) {
    const trimmed = source.trim();
    if (/^#{1,6}\s/u.test(trimmed)) continue;
    const line = trimmed.replace(LINE_PREFIX, "").replace(/\*\*/gu, "").trim();
    if (line.length === 0 || SYMBOL_ONLY.test(line)) continue;
    if (/^[#\-*]{2,}/u.test(line)) continue;
    if (/[\\/]/.test(line) && /[A-Za-z]/.test(line)) continue;
    if (/\.(?:ts|tsx|js|jsx|mjs|json|md|py|go|rs|css|html|ya?ml)\b/iu.test(line)) continue;
    if (/[A-Za-z]{6,}/u.test(line) && /[_/\\.]/.test(line)) continue;
    lines.push(line);
    if (lines.length >= 6) break;
  }
  return lines;
}
export {
  SPEAKER_MAX_TOKENS,
  SPEAKER_SYSTEM_PROMPT,
  buildSpeakerPrompt,
  parseSpeakerLines
};
