const SPEAKER_PREFIX = /^\s*\[声纹：[^\]]*\]\s*/u;
const PUNCTUATION = /[\s\u3000-\u303F\uFF00-\uFF0F\uFF1A-\uFF20\u200B-\u200D.,!?;:'"()\[\]{}\-—…、。，！？；：""''（）【】《》]/gu;
const HARD_COMMAND = /打断|别说了|别说|闭嘴|安静|停一下|先停|打住|再说一遍|重复一遍|重说|再说一次/u;
const FILLERS = /* @__PURE__ */ new Set([
  "\u55EF",
  "\u554A",
  "\u5443",
  "\u54E6",
  "\u5514",
  "\u54CE",
  "\u5509",
  "\u5594",
  "\u5662",
  "\u54BF",
  "\u55EF\u55EF",
  "\u554A\u554A",
  "\u5443\u5443",
  "\u54E6\u54E6",
  "\u55EF\u554A",
  "\u554A\u55EF",
  "\u5443\u554A",
  "\u54CE\u54CE"
]);
const SINGLE_LATIN = /^[a-z]{1,4}$/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
function normalizeForGate(raw) {
  return String(raw ?? "").replace(SPEAKER_PREFIX, "").replace(PUNCTUATION, "").toLowerCase();
}
function noiseGate(lane, raw) {
  const text = normalizeForGate(raw);
  if (!text) return { drop: false };
  if (HARD_COMMAND.test(text)) return { drop: false };
  if (lane === "owner") return { drop: false };
  if (/\p{N}/u.test(text)) return { drop: false };
  if (text.length <= 2) return { drop: true, reason: "noise-short" };
  if (FILLERS.has(text)) return { drop: true, reason: "noise-filler" };
  if (SINGLE_LATIN.test(text)) return { drop: true, reason: "noise-latin" };
  if (!LETTER_OR_DIGIT.test(text)) return { drop: true, reason: "noise-symbol" };
  return { drop: false };
}
const ECHO_WINDOW_MS = 8e3;
const ECHO_MIN_CHARS = 6;
const ECHO_OVERLAP = 0.85;
function units(text) {
  const out = [];
  const latin = text.match(/[a-z]{3,}/gu) ?? [];
  out.push(...latin);
  const cjk = text.replace(/[^\u3400-\u9fff]/gu, "");
  for (let i = 0; i + 1 < cjk.length; i++) out.push(cjk.slice(i, i + 2));
  return out;
}
function coverage(text, corpus) {
  const parts = units(text);
  if (parts.length === 0) return 0;
  let hits = 0;
  for (const part of parts) if (corpus.includes(part)) hits += 1;
  return hits / parts.length;
}
function echoGate(raw, spoken, now = Date.now(), windowMs = ECHO_WINDOW_MS) {
  const text = normalizeForGate(raw);
  if (text.length < ECHO_MIN_CHARS) return { drop: false };
  if (HARD_COMMAND.test(text)) return { drop: false };
  const recent = spoken.filter((sample) => now - sample.at <= windowMs).map((sample) => normalizeForGate(sample.text)).join("");
  if (!recent) return { drop: false };
  if (recent.includes(text)) return { drop: true, reason: "echo-contained" };
  return coverage(text, recent) >= ECHO_OVERLAP ? { drop: true, reason: "echo-overlap" } : { drop: false };
}
export {
  ECHO_WINDOW_MS,
  echoGate,
  noiseGate,
  normalizeForGate
};
