const CONCLUSION = /结论|总之|所以|核心(是|就)|一句话|总结|答案(是|就)/;
const BACKGROUND = /背景|铺垫|来龙去脉|先说说|顺便说|前情|历史原因/;
const CONCLUSION_FIRST = /先(说|讲|给)?结论|结论先|直接(说|讲|给)?结论|先说答案|先说重点|先讲结果/;
const DROP_BACKGROUND = /别(讲|说|提)?背景|不要背景|背景(跳过|略过|不用|别讲)|不用(讲)?铺垫|省略背景|略过铺垫/;
function normalize(text) {
  return String(text ?? "").replace(/\s+/gu, " ").trim();
}
function conclusionIndices(lines) {
  const found = [];
  lines.forEach((line, index) => {
    if (CONCLUSION.test(normalize(line))) found.push(index);
  });
  return found;
}
function planOutputOrder(lines, utterance) {
  const total = lines.length;
  const unchanged = {
    order: lines.map((_, index) => index),
    dropped: [],
    reason: "unchanged"
  };
  if (total < 2) return unchanged;
  const said = normalize(utterance);
  const wantsConclusionFirst = CONCLUSION_FIRST.test(said);
  const wantsNoBackground = DROP_BACKGROUND.test(said);
  if (!wantsConclusionFirst && !wantsNoBackground) return unchanged;
  const conclusions = conclusionIndices(lines);
  const dropped = [];
  if (wantsNoBackground) {
    const maxDrops = Math.max(0, Math.min(total - 2, Math.floor(total * 0.6)));
    for (let index = 1; index < total && dropped.length < maxDrops; index += 1) {
      if (conclusions.includes(index)) continue;
      if (BACKGROUND.test(normalize(lines[index] ?? ""))) dropped.push(index);
    }
  }
  const order = [];
  const push = (index) => {
    if (index < 0 || index >= total) return;
    if (dropped.includes(index) || order.includes(index)) return;
    order.push(index);
  };
  if (wantsConclusionFirst) for (const index of conclusions) push(index);
  for (let index = 0; index < total; index += 1) push(index);
  const changed = order.some((value, index) => value !== index) || dropped.length > 0;
  return changed ? { order, dropped, reason: "rule" } : unchanged;
}
function planChunkOutputOrder(chunks, utterance) {
  const total = chunks.length;
  const unchanged = {
    order: chunks.map((_, index) => index),
    dropped: [],
    reason: "unchanged"
  };
  if (total < 2) return unchanged;
  const said = normalize(utterance);
  const wantsConclusionFirst = CONCLUSION_FIRST.test(said);
  const wantsNoBackground = DROP_BACKGROUND.test(said);
  if (!wantsConclusionFirst && !wantsNoBackground) return unchanged;
  const texts = chunks.map((chunk) => normalize(typeof chunk === "string" ? chunk : chunk.text));
  const groups = /* @__PURE__ */ new Map();
  const groupOrder = [];
  chunks.forEach((chunk, index) => {
    const sentenceId = typeof chunk === "string" ? void 0 : chunk.sentenceId;
    const key = sentenceId === void 0 ? "#" + index : "s" + sentenceId;
    let group = groups.get(key);
    if (!group) {
      group = { key, indices: [], conclusion: false, background: false, hasFirst: false };
      groups.set(key, group);
      groupOrder.push(key);
    }
    group.indices.push(index);
    group.conclusion ||= CONCLUSION.test(texts[index] ?? "");
    group.background ||= BACKGROUND.test(texts[index] ?? "");
    group.hasFirst ||= index === 0;
  });
  const dropCandidates = wantsNoBackground ? groupOrder.map((key) => groups.get(key)).filter((group) => group.background && !group.conclusion) : [];
  const maxDrops = Math.max(0, Math.min(total - 2, Math.floor(total * 0.6)));
  const dropped = [];
  for (const group of dropCandidates) {
    if (group.hasFirst) continue;
    if (dropped.length + group.indices.length > maxDrops) continue;
    for (const index of group.indices) if (!dropped.includes(index)) dropped.push(index);
  }
  const conclusionGroups = groupOrder.filter((key) => groups.get(key).conclusion);
  const orderedGroups = wantsConclusionFirst ? [...conclusionGroups, ...groupOrder.filter((key) => !conclusionGroups.includes(key))] : groupOrder;
  const order = [];
  for (const key of orderedGroups) {
    for (const index of groups.get(key).indices.slice().sort((a, b) => a - b)) {
      if (!dropped.includes(index) && !order.includes(index)) order.push(index);
    }
  }
  const changed = order.some((value, index) => value !== index) || dropped.length > 0;
  return changed ? { order, dropped: dropped.sort((a, b) => a - b), reason: "rule" } : unchanged;
}
function sanitizeArrangement(lineCount, order = [], dropped = []) {
  const total = Math.max(0, Math.floor(lineCount));
  const valid = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value < total;
  const dropSet = /* @__PURE__ */ new Set();
  for (const value of dropped) if (valid(value)) dropSet.add(Math.trunc(value));
  if (total > 0 && dropSet.size >= total) dropSet.delete(Math.max(...dropSet));
  const result = [];
  for (const value of order) {
    if (!valid(value)) continue;
    const index = Math.trunc(value);
    if (dropSet.has(index) || result.includes(index)) continue;
    result.push(index);
  }
  for (let index = 0; index < total; index += 1) {
    if (dropSet.has(index) || result.includes(index)) continue;
    result.push(index);
  }
  return { order: result, dropped: [...dropSet].sort((a, b) => a - b), reason: "sanitized" };
}
function arrangementChanged(plan) {
  if (plan.dropped.length > 0) return true;
  return plan.order.some((value, index) => value !== index);
}
const ARRANGE_MAX_DROP_RATIO = 0.6;
export {
  ARRANGE_MAX_DROP_RATIO,
  arrangementChanged,
  planChunkOutputOrder,
  planOutputOrder,
  sanitizeArrangement
};
