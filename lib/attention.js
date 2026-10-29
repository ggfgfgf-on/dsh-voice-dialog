// src/attention.ts
var ATTENTION_SYSTEM_PROMPT = [
  "\u4F60\u5148\u901A\u8BFB\u6574\u6BB5\u56DE\u590D,\u5224\u65AD\u54EA\u4E9B\u5185\u5BB9\u503C\u5F97\u5360\u7528\u5BF9\u65B9\u7684\u6CE8\u610F\u529B;\u4F60\u81EA\u5DF1\u4E0D\u8BF4\u8BDD\u3002",
  "\u9010\u5757\u6253\u4E00\u4E2A\u5206\u6570:",
  "3 \u5FC5\u987B\u8BF4\u2014\u2014\u76F4\u63A5\u56DE\u7B54\u3001\u7ED3\u8BBA\u3001\u6570\u5B57\u3001\u65F6\u95F4\u70B9\u3001\u5BF9\u65B9\u8981\u505A\u7684\u52A8\u4F5C\u3002",
  "2 \u6491\u4E00\u53E5\u2014\u2014\u7406\u7531\u3001\u6761\u4EF6\u3001\u5F71\u54CD\u3002",
  "1 \u53EF\u7701\u2014\u2014\u91CD\u590D\u3001\u94FA\u9648\u3001\u80FD\u6982\u62EC\u7684\u8FC7\u7A0B\u3002",
  '0 \u4E0D\u8BF4\u2014\u2014\u5BD2\u6684\u3001"\u597D\u7684""\u6211\u770B\u770B"\u3001\u5DE5\u5177\u540D\u3001\u6587\u4EF6\u8DEF\u5F84\u3001\u4EE3\u7801\u3001\u8FC7\u7A0B\u53D9\u8FF0\u3002',
  "\u5BF9\u65B9\u521A\u95EE\u7684\u90A3\u5757\u4E00\u5F8B 3;\u5DF2\u7ECF\u5FF5\u8FC7\u7684\u4E00\u5F8B 0\u3002",
  '\u8F93\u51FA\u6BCF\u5757\u4E00\u884C:"\u5E8F\u53F7|\u5206\u6570|\u89D2\u8272|\u4E0D\u8D85\u8FC7\u5341\u56DB\u5B57\u8981\u70B9"\u3002\u89D2\u8272\u4ECE \u7ED3\u8BBA/\u56DE\u7B54/\u7406\u7531/\u6761\u4EF6/\u8FC7\u7A0B/\u5BA2\u5957 \u91CC\u6311\u3002',
  "\u4E0D\u8981\u89E3\u91CA,\u4E0D\u8981\u603B\u7ED3,\u4E0D\u8981\u8F93\u51FA\u522B\u7684\u884C\u3002"
].join("\n");
var ATTENTION_MAX_TOKENS = 300;
var ATTENTION_BLOCK_CHARS = 110;
var ATTENTION_MAX_BLOCKS = 14;
var ATTENTION_INPUT_CHARS = 2600;
var ATTENTION_MIN_SPEAK_SCORE = 2;
var ATTENTION_BODY_CHARS = 700;
var ATTENTION_SUMMARY_CHARS = 600;
var SPEECH_LINE_BUDGET_MAX = 6;
var SENTENCE_END = /(?<=[。！？!?；;\n])/u;
function chop(text) {
  const out = [];
  let rest = text.trim();
  while (rest.length > ATTENTION_BLOCK_CHARS) {
    const window = rest.slice(0, ATTENTION_BLOCK_CHARS);
    const at = Math.max(
      window.lastIndexOf("\uFF0C"),
      window.lastIndexOf(","),
      window.lastIndexOf("\u3001"),
      window.lastIndexOf("\uFF1A")
    );
    const cut = at >= 40 ? at + 1 : ATTENTION_BLOCK_CHARS;
    const head = rest.slice(0, cut).trim();
    if (head) out.push(head);
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}
function splitAttentionBlocks(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  const pieces = text.replace(/\r/gu, "").split(SENTENCE_END).map((piece) => piece.trim()).filter((piece) => piece.length > 0);
  const blocks = [];
  let chars = 0;
  for (const piece of pieces) {
    for (const chunk of chop(piece)) {
      const previous = blocks[blocks.length - 1];
      if (previous !== void 0 && chunk.length <= 4) {
        blocks[blocks.length - 1] = previous + chunk;
        continue;
      }
      if (blocks.length >= ATTENTION_MAX_BLOCKS) return blocks;
      if (chars + chunk.length > ATTENTION_INPUT_CHARS && blocks.length > 0) return blocks;
      blocks.push(chunk);
      chars += chunk.length;
    }
  }
  return blocks;
}
function buildAttentionPrompt(blocks, heard, question) {
  const already = heard.map((line) => line.trim()).filter((line) => line.length > 0).slice(-4).join(" / ");
  const rows = [
    question ? "\u5BF9\u65B9\u521A\u8BF4\u7684: " + question.trim().slice(0, 120) : "",
    already ? "\u5DF2\u7ECF\u5FF5\u8FC7\u7684: " + already : "",
    "\u5757:"
  ].filter(Boolean);
  blocks.forEach((block, index) => rows.push(index + "| " + block));
  return rows.join("\n");
}
function parseAttentionMap(raw, blockCount) {
  if (typeof raw !== "string" || raw.length === 0 || blockCount <= 0) return void 0;
  const seen = /* @__PURE__ */ new Map();
  for (const source of raw.split(/\r?\n/u)) {
    const line = source.trim().replace(/^[-*•·\s]+/u, "");
    if (line.length === 0) continue;
    const parts = line.split(/[|｜]/u).map((part) => part.trim());
    if (parts.length < 2) continue;
    const index = Number.parseInt(parts[0], 10);
    const digit = (parts[1].match(/\d/u) ?? [""])[0];
    const score = Number.parseInt(digit, 10);
    if (!Number.isInteger(index) || index < 0 || index >= blockCount) continue;
    if (!Number.isInteger(score) || score < 0 || score > 3) continue;
    if (seen.has(index)) continue;
    const role = (parts[2] ?? "").replace(/[^\u4e00-\u9fa5A-Za-z]/gu, "").slice(0, 6);
    const gist = (parts[3] ?? "").replace(/[|｜]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 20);
    seen.set(index, { index, score, role, gist });
  }
  if (seen.size === 0) return void 0;
  const blocks = [];
  for (let index = 0; index < blockCount; index += 1) {
    blocks.push(seen.get(index) ?? { index, score: 2, role: "", gist: "" });
  }
  const kept = blocks.filter((block) => block.score >= ATTENTION_MIN_SPEAK_SCORE);
  if (kept.length === 0) return void 0;
  const highest = kept.reduce((max, block) => Math.max(max, block.score), 0);
  const order = kept[0].score < highest ? kept.slice().sort((a, b) => b.score - a.score || a.index - b.index).map((block) => block.index) : kept.map((block) => block.index);
  const highs = kept.filter((block) => block.score === 3).length;
  const budget = Math.min(SPEECH_LINE_BUDGET_MAX, Math.max(1, 2 + highs));
  return { blocks, order, budget };
}
function attentionForSpeech(map, blocks) {
  const kept = [];
  for (const index of map.order) {
    const block = map.blocks[index];
    const text = blocks[index];
    if (!block || !text || block.score < ATTENTION_MIN_SPEAK_SCORE) continue;
    kept.push({ block, text: text.trim() });
  }
  if (kept.length === 0) return void 0;
  const summary = kept.map((item, position) => {
    const gist = item.block.gist || item.text.slice(0, 20);
    const role = item.block.role ? "|" + item.block.role : "";
    return position + 1 + ". [" + item.block.score + role + "] " + gist;
  }).join("\n").slice(0, ATTENTION_SUMMARY_CHARS);
  const body = [];
  let chars = 0;
  for (const item of kept) {
    if (chars + item.text.length > ATTENTION_BODY_CHARS) break;
    body.push(item.text);
    chars += item.text.length;
  }
  return { summary, body: body.join("\n"), budget: map.budget };
}
export {
  ATTENTION_BLOCK_CHARS,
  ATTENTION_BODY_CHARS,
  ATTENTION_INPUT_CHARS,
  ATTENTION_MAX_BLOCKS,
  ATTENTION_MAX_TOKENS,
  ATTENTION_MIN_SPEAK_SCORE,
  ATTENTION_SUMMARY_CHARS,
  ATTENTION_SYSTEM_PROMPT,
  SPEECH_LINE_BUDGET_MAX,
  attentionForSpeech,
  buildAttentionPrompt,
  parseAttentionMap,
  splitAttentionBlocks
};
