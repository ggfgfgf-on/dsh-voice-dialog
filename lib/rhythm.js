const RHYTHM_DEFAULTS = {
  sentenceMs: 220,
  clauseMs: 90,
  jitter: 0.35,
  maxMs: 600,
  innerMs: 0
};
const RHYTHM_LIMITS = {
  sentenceMs: { min: 0, max: 800, meaning: "Silence after a sentence that ends a thought. 180-280 sounds like a person." },
  clauseMs: { min: 0, max: 400, meaning: "Silence after a comma or \u987F\u53F7 cut. 60-120 keeps a list moving; 0 flattens it." },
  jitter: { min: 0, max: 0.8, meaning: "How much each gap varies around the nominal value. 0.3-0.4 avoids a metronome." },
  maxMs: { min: 50, max: 1500, meaning: "Ceiling for any one gap, so a long pause never appears mid-answer." },
  innerMs: { min: 0, max: 400, meaning: "Opt in: silence inside one long line. Costs one extra synthesis request, so 0 by default." }
};
const SENTENCE_END = /[。！？!?…]$/u;
const CLAUSE_END = /[，,、；;：:]$/u;
const TRAIL = /[\s"'”’）)】》〉\]］\}]+$/u;
function trimSpoken(text) {
  return String(text ?? "").replace(TRAIL, "").trim();
}
function unitHash(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash / 4294967295;
}
function variationOf(text, seed = 0, jitter = RHYTHM_DEFAULTS.jitter) {
  const amount = Math.max(0, Math.min(0.8, jitter));
  if (amount === 0) return 0;
  return (unitHash(String(seed) + "\0" + text) * 2 - 1) * amount;
}
function resolveOptions(options) {
  const merged = { ...RHYTHM_DEFAULTS };
  if (!options) return merged;
  for (const key of Object.keys(RHYTHM_DEFAULTS)) {
    const value = options[key];
    if (typeof value === "number" && Number.isFinite(value)) merged[key] = value;
  }
  return merged;
}
function baseGapMs(text, options) {
  const spoken = trimSpoken(text);
  if (!spoken) return 0;
  const resolved = resolveOptions(options);
  if (SENTENCE_END.test(spoken)) return Math.max(0, resolved.sentenceMs);
  if (CLAUSE_END.test(spoken)) return Math.max(0, resolved.clauseMs);
  return Math.max(0, Math.round(resolved.clauseMs * 0.55));
}
function rhythmGapMs(text, options, seed = 0) {
  const spoken = trimSpoken(text);
  if (!spoken) return 0;
  const resolved = resolveOptions(options);
  const base = baseGapMs(spoken, resolved);
  if (base <= 0) return 0;
  const varied = base * (1 + variationOf(spoken, seed, resolved.jitter));
  return Math.max(0, Math.min(Math.max(50, resolved.maxMs), Math.round(varied)));
}
const INNER_MARKS = /* @__PURE__ */ new Set(["\uFF0C", ",", "\u3001", "\uFF1B", ";", "\uFF1A", ":"]);
function splitInnerPause(text, options, seed = 0) {
  const resolved = resolveOptions(options);
  if (!(resolved.innerMs > 0)) return void 0;
  const spoken = String(text ?? "").trim();
  if (spoken.length < 12) return void 0;
  const mid = spoken.length / 2;
  let cut = -1;
  let distance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < spoken.length; index += 1) {
    if (!INNER_MARKS.has(spoken[index])) continue;
    const head2 = spoken.slice(0, index).replace(/\s/gu, "");
    const tail2 = spoken.slice(index + 1).replace(/\s/gu, "");
    if (head2.length < 4 || tail2.length < 4) continue;
    const here = Math.abs(index - mid);
    if (here < distance) {
      distance = here;
      cut = index;
    }
  }
  if (cut < 0) return void 0;
  const head = spoken.slice(0, cut + 1).trim();
  const tail = spoken.slice(cut + 1).trim();
  if (!head || !tail) return void 0;
  const varied = resolved.innerMs * (1 + variationOf(spoken, seed, resolved.jitter));
  return { head, tail, gapMs: Math.max(0, Math.min(resolved.maxMs, Math.round(varied))) };
}
export {
  RHYTHM_DEFAULTS,
  RHYTHM_LIMITS,
  baseGapMs,
  rhythmGapMs,
  splitInnerPause,
  trimSpoken,
  variationOf
};
