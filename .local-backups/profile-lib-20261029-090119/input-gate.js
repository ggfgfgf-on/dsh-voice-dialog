import { stripVoicePrefix } from "./queue-control.js";
const INPUT_GATE_TIMEOUT_MS = 220;
const INPUT_GATE_MAX_MS = 250;
const PUNCTUATION = /[\s\u3000-\u303F\uFF00-\uFF0F\uFF1A-\uFF20\u200B-\u200D.,!?;:'"()\[\]{}\-—…、。，！？；：""''（）【】《》]/gu;
const PUNCT_ONLY = /^[\s\p{P}\p{S}]+$/u;
const SINGLE_CHAR = /^[\p{L}\p{N}]$/u;
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
  "\u54CE\u54CE",
  "the",
  "yeah",
  "ok",
  "okay",
  "hmm",
  "uh",
  "um"
]);
const QUESTION = /[?？]|(?:什么|为什么|怎么|怎样|如何|哪个|哪里|哪儿|谁|多少|几点|几号|是否|是不是|能不能|可不可以|会不会|有没有|要不要|好不好|行不行)/u;
const IMPERATIVE = /^(?:请|麻烦|帮我|给我|替我|把|将|打开|关闭|关掉|开启|停止|停|开始|继续|查|搜|找|看|读|念|说|讲|写|做|来|去|调|设置|修改|改|换|切|放|播|暂停|重试|重复|退|取消|确认|发|删除|加|减|放大|缩小|音量|语速|静音|大声|小声|快一点|慢一点)/u;
const INTERRUPT = /(?:打断|停下|停一下|先停|别说了|别说|闭嘴|安静|打住|换话题|换个话题)/u;
const CONTINUATION = /^(?:另外|还有|以及|补充|顺便|对了|然后|接着|就是|其实|不过|而且|同时|再补充|刚想到)/u;
function cleanGateText(raw) {
  return stripVoicePrefix(String(raw ?? ""));
}
function squash(raw) {
  return cleanGateText(raw).replace(PUNCTUATION, "").toLowerCase();
}
function similarity(left, right) {
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return 0;
  const grams = (value) => {
    const out = /* @__PURE__ */ new Map();
    for (let index = 0; index + 1 < value.length; index += 1) {
      const gram = value.slice(index, index + 2);
      out.set(gram, (out.get(gram) ?? 0) + 1);
    }
    return out;
  };
  const a = grams(left);
  const b = grams(right);
  let overlap = 0;
  for (const [gram, count] of a) overlap += Math.min(count, b.get(gram) ?? 0);
  return 2 * overlap / (left.length - 1 + right.length - 1);
}
function rule(verdict, reason, now, startedAt) {
  return { verdict, source: "rule", verdictMs: Math.max(0, Math.round(now() - startedAt)), reason };
}
function ruleInputDecision(input, now = Date.now) {
  const startedAt = now();
  const raw = cleanGateText(input.text);
  const text = raw.replace(/\s+/gu, " ").trim();
  if (input.lane !== "owner") {
    return {
      verdict: "queue",
      source: "rule",
      verdictMs: 0,
      reason: "guest-bypass",
      bypassed: true
    };
  }
  if (!text || PUNCT_ONLY.test(text)) return rule("drop", "empty-or-punctuation", now, startedAt);
  const plain = text.replace(PUNCTUATION, "").toLowerCase();
  if (!plain) return rule("drop", "empty-or-punctuation", now, startedAt);
  if (SINGLE_CHAR.test(plain) || FILLERS.has(plain)) return rule("drop", "noise-fragment", now, startedAt);
  const previous = squash(input.previousText ?? "");
  if (previous && (plain === previous || plain.length >= 4 && similarity(plain, previous) >= 0.86)) {
    return rule("drop", "duplicate-previous", now, startedAt);
  }
  if (INTERRUPT.test(plain)) return rule("steer", "explicit-interrupt", now, startedAt);
  if (QUESTION.test(text) || QUESTION.test(plain)) return rule("steer", "question", now, startedAt);
  if (IMPERATIVE.test(text) || IMPERATIVE.test(plain)) return rule("steer", "imperative", now, startedAt);
  if (CONTINUATION.test(text) || CONTINUATION.test(plain)) return rule("queue", "supplement", now, startedAt);
  return null;
}
function normalizeModelVerdict(value) {
  if (!value || typeof value !== "object") return null;
  const record = value;
  if (typeof record.reason === "string" && /timeout|no-model-target|bad-input|invalid-model-output|empty-model-output/i.test(record.reason)) return null;
  const candidate = typeof record.verdict === "string" ? record.verdict : typeof record.action === "string" ? record.action : "";
  const token = candidate.trim().toLowerCase();
  if (token === "steer" || token === "direct" || token === "interrupt") return "steer";
  if (token === "queue" || token === "hold") return "queue";
  if (token === "drop" || token === "ignore") return "drop";
  return null;
}
function fallbackSteer(now, startedAt, reason) {
  return {
    verdict: "steer",
    source: "rule",
    verdictMs: Math.min(INPUT_GATE_MAX_MS, Math.max(0, Math.round(now() - startedAt))),
    reason
  };
}
async function decideInput(input, options = {}) {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const ruled = ruleInputDecision(input, now);
  if (ruled) return ruled;
  const timeoutMs = Math.max(1, Math.min(INPUT_GATE_MAX_MS, Math.round(options.timeoutMs ?? INPUT_GATE_TIMEOUT_MS)));
  const model = options.model;
  if (!model) return fallbackSteer(now, startedAt, "no-model-default-steer");
  const controller = new AbortController();
  let timer;
  const timedOut = Symbol("timeout");
  try {
    const winner = await Promise.race([
      model(cleanGateText(input.text), controller.signal).catch(() => null),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(timedOut), timeoutMs);
      })
    ]);
    if (winner === timedOut) {
      controller.abort();
      return fallbackSteer(now, startedAt, "timeout-default-steer");
    }
    const verdict = normalizeModelVerdict(winner);
    const verdictMs = Math.min(INPUT_GATE_MAX_MS, Math.max(0, Math.round(now() - startedAt)));
    if (!verdict) return { verdict: "steer", source: "rule", verdictMs, reason: "invalid-model-default-steer" };
    return { verdict, source: "model", verdictMs, reason: "model" };
  } catch {
    controller.abort();
    return fallbackSteer(now, startedAt, "model-error-default-steer");
  } finally {
    if (timer !== void 0) clearTimeout(timer);
  }
}
function inputGateTraceFields(decision) {
  return {
    verdict: decision.verdict,
    verdictSource: decision.source,
    verdictMs: Math.min(INPUT_GATE_MAX_MS, Math.max(0, Math.round(decision.verdictMs)))
  };
}
export {
  INPUT_GATE_MAX_MS,
  INPUT_GATE_TIMEOUT_MS,
  cleanGateText,
  decideInput,
  inputGateTraceFields,
  normalizeModelVerdict,
  ruleInputDecision
};
