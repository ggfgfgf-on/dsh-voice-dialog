const TONE_DELTAS = {
  neutral: {},
  warm: { pitch: 4, volume: 2 },
  soft: { pitch: -6, volume: -12 },
  firm: { rate: -4, volume: 10 },
  urgent: { rate: 12, pitch: 4 },
  bright: { pitch: 8, rate: 4 }
};
const PACE_DELTAS = {
  even: {},
  slower: { rate: -10 },
  faster: { rate: 10 }
};
const STEP_LIMITS = {
  rate: { min: -50, max: 50, meaning: "\u8FD9\u4E00\u6B65\u7684\u8BED\u901F\u8C03\u6574\uFF0C\u767E\u5206\u6BD4\uFF0C\u6B63\u6570\u66F4\u5FEB\u3002" },
  pitch: { min: -50, max: 50, meaning: "\u8FD9\u4E00\u6B65\u7684\u97F3\u9AD8\u8C03\u6574\uFF0C\u767E\u5206\u6BD4\uFF0C\u6B63\u6570\u66F4\u9AD8\u3002" },
  volume: { min: -100, max: 100, meaning: "\u8FD9\u4E00\u6B65\u7684\u54CD\u5EA6\u8C03\u6574\uFF0C\u767E\u5206\u6BD4\uFF0C\u6B63\u6570\u66F4\u54CD\u3002" }
};
const MARK_LIMITS = {
  max: 24,
  fields: ["at", "to", "tone", "pace", "rate", "pitch", "volume"],
  meaning: "\u4E00\u53E5\u8BDD\u91CC\u7684\u5C40\u90E8\u6807\u5B9A\uFF1Aat/to \u5708\u51FA\u4ECE\u7B2C\u51E0\u4E2A\u5B57\u5230\u7B2C\u51E0\u4E2A\u5B57\uFF08\u4ECE 0 \u6570\uFF0Cto \u4E0D\u542B\uFF09\uFF0C\u53EA\u6539\u90A3\u51E0\u4E2A\u5B57\u3002\u53EF\u4EE5\u7ED9 tone\u3001pace\u3001rate\u3001pitch\u3001volume\uFF0C\u90FD\u662F\u5728\u8FD9\u53E5\u5DF2\u6709\u8BED\u6C14\u4E4B\u4E0A\u518D\u53E0\u7684\u5C40\u90E8\u53D8\u5316\uFF0C\u91CD\u53E0\u4F1A\u76F8\u52A0\u3002\u7ED9\u4E86\u6807\u5B9A\u4E4B\u540E\u8FD9\u53E5\u7684\u6587\u5B57\u4E0D\u518D\u88AB\u81EA\u52A8\u6539\u5199\uFF0C\u4F4D\u7F6E\u624D\u5BF9\u5F97\u4E0A\u3002"
};
const ADJUSTMENTS = Object.keys(STEP_LIMITS).map((field) => ({
  field,
  min: STEP_LIMITS[field].min,
  max: STEP_LIMITS[field].max,
  meaning: STEP_LIMITS[field].meaning
}));
const CONSTRUCTS = [
  { value: "lengthen", meaning: "\u628A\u53E5\u5C3E\u62D6\u957F\u3001\u6536\u5F97\u8F6F\u4E00\u70B9\u3002" },
  { value: "breath", meaning: "\u52A0\u4E00\u4E2A\u6362\u6C14\u7684\u7F1D\u548C\u4E00\u53E5\u5C3E\u7684\u8F7B\u58F0\uFF0C\u542C\u8D77\u6765\u66F4\u8FD1\u3002" }
];
const PAUSE_MS = { beat: 280, short: 140, long: 600 };
const TONE_MEANINGS = {
  neutral: "\u65E5\u5E38\u9648\u8FF0\uFF0C\u4E0D\u52A0\u989D\u5916\u8272\u5F69\u3002",
  warm: "\u5E26\u4E00\u70B9\u6696\u610F\uFF0C\u97F3\u9AD8\u7565\u62AC\u3002",
  soft: "\u653E\u8F7B\u653E\u4F4E\uFF0C\u50CF\u5728\u8FD1\u5904\u5C0F\u58F0\u8BF4\u3002",
  firm: "\u7ED3\u5B9E\u6E05\u695A\uFF0C\u97F3\u91CF\u7565\u9AD8\u3001\u8BED\u901F\u7565\u6536\u3002",
  urgent: "\u50AC\u4FC3\u611F\uFF0C\u8BED\u901F\u660E\u663E\u52A0\u5FEB\u3002",
  bright: "\u660E\u4EAE\u4E0A\u626C\uFF0C\u9002\u5408\u597D\u6D88\u606F\u3002"
};
const PACE_MEANINGS = {
  even: "\u4FDD\u6301\u5F53\u524D\u8BED\u901F\u3002",
  slower: "\u8FD9\u4E00\u6B65\u7A0D\u6162\u4E00\u70B9\u3002",
  faster: "\u8FD9\u4E00\u6B65\u7A0D\u5FEB\u4E00\u70B9\u3002"
};
const PAUSE_MEANINGS = {
  beat: "\u4E00\u4E2A\u6C14\u53E3\uFF0C\u7EA6\u56DB\u5206\u4E4B\u4E00\u79D2\u3002",
  short: "\u5F88\u77ED\u7684\u505C\u987F\u3002",
  long: "\u660E\u663E\u7684\u505C\u987F\uFF0C\u50CF\u60F3\u4E86\u534A\u62CD\u3002"
};
const VOCABULARY = {
  tone: Object.keys(TONE_DELTAS).map((value) => ({ value, meaning: TONE_MEANINGS[value] })),
  pace: Object.keys(PACE_DELTAS).map((value) => ({ value, meaning: PACE_MEANINGS[value] })),
  pause: Object.keys(PAUSE_MS).map((value) => ({ value, meaning: PAUSE_MEANINGS[value] }))
};
const EXPRESS_TOKENS = {
  tone: Object.keys(TONE_DELTAS),
  pace: Object.keys(PACE_DELTAS),
  pause: Object.keys(PAUSE_MS)
};
const MAX_UNITS = 12;
const MAX_TEXT = 200;
const MAX_STRESS = 4;
const MAX_STRESS_CHARS = 24;
const RATE_LIMIT = 50;
const PITCH_LIMIT = 50;
const VOLUME_LIMIT = 100;
const ELISION = "\u2014\u2014";
const BREATH_TAIL = "\u2026\u2026";
const BREATH_RATE_DELTA = -8;
const BREATH_VOLUME_DELTA = -15;
const TONES = new Set(Object.keys(TONE_DELTAS));
const PACES = new Set(Object.keys(PACE_DELTAS));
const PAUSES = new Set(Object.keys(PAUSE_MS));
const clampNumber = (value, min, max) => Math.max(min, Math.min(max, value));
const toNumber = (value, min, max) => {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return void 0;
  return clampNumber(Math.round(number), min, max);
};
function normalizeMarks(input) {
  if (!Array.isArray(input)) return void 0;
  const marks = [];
  for (const entry of input) {
    if (marks.length >= MARK_LIMITS.max) break;
    if (entry === null || typeof entry !== "object") continue;
    const row = entry;
    const at = toNumber(row.at, 0, MAX_TEXT - 1);
    if (at === void 0) continue;
    const tone = row.tone === void 0 ? void 0 : typeof row.tone === "string" ? row.tone.trim() : "";
    if (tone !== void 0 && !TONES.has(tone)) continue;
    const pace = row.pace === void 0 ? void 0 : typeof row.pace === "string" ? row.pace.trim() : "";
    if (pace !== void 0 && !PACES.has(pace)) continue;
    const mark = { at };
    const to = toNumber(row.to, 0, MAX_TEXT);
    if (to !== void 0 && to > at) mark.to = to;
    const rate = toNumber(row.rate, STEP_LIMITS.rate.min, STEP_LIMITS.rate.max);
    if (rate !== void 0 && rate !== 0) mark.rate = rate;
    const pitch = toNumber(row.pitch, STEP_LIMITS.pitch.min, STEP_LIMITS.pitch.max);
    if (pitch !== void 0 && pitch !== 0) mark.pitch = pitch;
    const volume = toNumber(row.volume, STEP_LIMITS.volume.min, STEP_LIMITS.volume.max);
    if (volume !== void 0 && volume !== 0) mark.volume = volume;
    if (tone !== void 0) mark.tone = tone;
    if (pace !== void 0) mark.pace = pace;
    if (mark.tone === void 0 && mark.pace === void 0 && mark.rate === void 0 && mark.pitch === void 0 && mark.volume === void 0) continue;
    marks.push(mark);
  }
  return marks.length > 0 ? marks : void 0;
}
function normalizeVoiceUnits(input) {
  if (!Array.isArray(input)) return [];
  const units = [];
  for (const raw of input) {
    if (units.length >= MAX_UNITS) break;
    if (raw === null || typeof raw !== "object") continue;
    const row = raw;
    if (row.pause !== void 0) {
      const pause = typeof row.pause === "string" ? row.pause.trim() : "";
      if (!PAUSES.has(pause)) continue;
      units.push({ pause });
      continue;
    }
    const collapsed = typeof row.say === "string" ? row.say.replace(/\s+/gu, " ").trim() : typeof row.text === "string" ? row.text.replace(/\s+/gu, " ").trim() : "";
    if (collapsed === "") continue;
    const tone = row.tone === void 0 ? void 0 : typeof row.tone === "string" ? row.tone.trim() : "";
    if (tone !== void 0 && !TONES.has(tone)) continue;
    const pace = row.pace === void 0 ? void 0 : typeof row.pace === "string" ? row.pace.trim() : "";
    if (pace !== void 0 && !PACES.has(pace)) continue;
    const unit = { say: Array.from(collapsed).slice(0, MAX_TEXT).join("") };
    const stepRate = toNumber(row.rate, STEP_LIMITS.rate.min, STEP_LIMITS.rate.max);
    if (stepRate !== void 0) unit.rate = stepRate;
    const stepPitch = toNumber(row.pitch, STEP_LIMITS.pitch.min, STEP_LIMITS.pitch.max);
    if (stepPitch !== void 0) unit.pitch = stepPitch;
    const stepVolume = toNumber(row.volume, STEP_LIMITS.volume.min, STEP_LIMITS.volume.max);
    if (stepVolume !== void 0) unit.volume = stepVolume;
    if (tone !== void 0) unit.tone = tone;
    if (pace !== void 0) unit.pace = pace;
    if (Array.isArray(row.stress)) {
      const stress = [];
      for (const entry of row.stress) {
        if (stress.length >= MAX_STRESS) break;
        if (typeof entry !== "string") continue;
        const word = entry.trim();
        if (word === "" || Array.from(word).length > MAX_STRESS_CHARS) continue;
        stress.push(word);
      }
      if (stress.length > 0) unit.stress = stress;
    }
    if (row.breath === true) unit.breath = true;
    if (row.lengthen === true) unit.lengthen = true;
    if (row.mark !== void 0) {
      const mark = normalizeMarks(row.mark);
      if (mark !== void 0) unit.mark = mark;
    }
    units.push(unit);
  }
  return units;
}
const normalizeVoiceLines = normalizeVoiceUnits;
function parseProsodyPercent(value) {
  if (typeof value !== "string") return 0;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "default") return 0;
  const match = /^([+-]?\d+(?:\.\d+)?)%$/.exec(trimmed);
  if (!match) return 0;
  const number = Number(match[1]);
  return Number.isFinite(number) ? Math.round(number) : 0;
}
function effectiveProsody(unit, base) {
  const tone = unit.tone === void 0 ? TONE_DELTAS.neutral : TONE_DELTAS[unit.tone];
  const pace = unit.pace === void 0 ? PACE_DELTAS.even : PACE_DELTAS[unit.pace];
  const breath = unit.breath === true;
  const drate = (unit.rate ?? 0) + (tone.rate ?? 0) + (pace.rate ?? 0) + (breath ? BREATH_RATE_DELTA : 0);
  const dpitch = (unit.pitch ?? 0) + (tone.pitch ?? 0);
  const dvolume = (unit.volume ?? 0) + (tone.volume ?? 0) + (breath ? BREATH_VOLUME_DELTA : 0);
  return {
    rate: clampNumber(base.rate + drate, -RATE_LIMIT, RATE_LIMIT),
    pitch: clampNumber(base.pitch + dpitch, -PITCH_LIMIT, PITCH_LIMIT),
    volume: clampNumber(base.volume + dvolume, -VOLUME_LIMIT, VOLUME_LIMIT)
  };
}
function prosodyKey(resolved) {
  return resolved.rate + "|" + resolved.pitch + "|" + resolved.volume;
}
const signedPercent = (value) => value === 0 ? "default" : (value > 0 ? "+" : "") + value + "%";
function expressionProsody(unit, base) {
  const resolved = effectiveProsody(unit, base);
  return {
    rate: signedPercent(resolved.rate),
    pitch: signedPercent(resolved.pitch),
    volume: signedPercent(resolved.volume)
  };
}
function markDelta(mark) {
  const tone = mark.tone === void 0 ? TONE_DELTAS.neutral : TONE_DELTAS[mark.tone];
  const pace = mark.pace === void 0 ? PACE_DELTAS.even : PACE_DELTAS[mark.pace];
  return {
    rate: (mark.rate ?? 0) + (tone.rate ?? 0) + (pace.rate ?? 0),
    pitch: (mark.pitch ?? 0) + (tone.pitch ?? 0),
    volume: (mark.volume ?? 0) + (tone.volume ?? 0)
  };
}
function resolveMarks(unit) {
  const text = typeof unit.say === "string" ? unit.say : "";
  const marks = unit.mark;
  if (text === "" || marks === void 0 || marks.length === 0) return void 0;
  const chars = Array.from(text);
  const lanes = chars.map(() => ({ rate: 0, pitch: 0, volume: 0 }));
  let painted = false;
  for (const mark of marks) {
    if (mark.at < 0 || mark.at >= chars.length) continue;
    const to = Math.min(chars.length, Math.max(mark.at + 1, mark.to ?? mark.at + 1));
    const delta = markDelta(mark);
    if (delta.rate === 0 && delta.pitch === 0 && delta.volume === 0) continue;
    painted = true;
    for (let index = mark.at; index < to; index += 1) {
      const lane = lanes[index];
      lane.rate += delta.rate;
      lane.pitch += delta.pitch;
      lane.volume += delta.volume;
    }
  }
  if (!painted) return void 0;
  const spans = [];
  for (let index = 0; index < chars.length; index += 1) {
    const lane = lanes[index];
    const last = spans[spans.length - 1];
    if (last !== void 0 && last.rate === lane.rate && last.pitch === lane.pitch && last.volume === lane.volume) {
      last.text += chars[index];
      continue;
    }
    spans.push({ text: chars[index], rate: lane.rate, pitch: lane.pitch, volume: lane.volume });
  }
  return spans;
}
const escapeXml = (text) => text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&apos;");
const MAX_SPANS_PER_REQUEST = 2;
function expressionSsmlChunks(unit, base) {
  const spans = resolveMarks(unit);
  if (spans === void 0) return void 0;
  const step = effectiveProsody(unit, base);
  const solved = spans.map((span) => ({
    text: span.text,
    rate: clampNumber(step.rate + span.rate, -RATE_LIMIT, RATE_LIMIT),
    pitch: clampNumber(step.pitch + span.pitch, -PITCH_LIMIT, PITCH_LIMIT),
    volume: clampNumber(step.volume + span.volume, -VOLUME_LIMIT, VOLUME_LIMIT)
  }));
  const chunks = [];
  for (let index = 0; index < solved.length; index += MAX_SPANS_PER_REQUEST) {
    const group = solved.slice(index, index + MAX_SPANS_PER_REQUEST);
    chunks.push({
      text: group.map((span) => span.text).join(""),
      ssml: group.map((span) => '<prosody rate="' + signedPercent(span.rate) + '" pitch="' + signedPercent(span.pitch) + '" volume="' + signedPercent(span.volume) + '">' + escapeXml(span.text) + "</prosody>").join("")
    });
  }
  return chunks;
}
function pauseMsFor(pause) {
  return PAUSE_MS[pause] ?? 0;
}
function splitStress(unit) {
  const text = typeof unit.say === "string" ? unit.say : "";
  if (text === "" || unit.pause !== void 0 || (unit.mark?.length ?? 0) > 0) return [unit];
  const words = (unit.stress ?? []).filter((word2) => word2 !== "" && text.includes(word2));
  if (words.length === 0) return [unit];
  const word = words[0];
  const at = text.indexOf(word);
  const before = text.slice(0, at);
  const after = text.slice(at + word.length);
  const base = { ...unit };
  delete base.stress;
  delete base.breath;
  delete base.lengthen;
  const pieces = [];
  if (before.trim() !== "") pieces.push({ ...base, say: before });
  pieces.push({ ...base, say: word, tone: "firm" });
  if (after.trim() !== "") pieces.push({ ...base, say: after });
  const last = pieces[pieces.length - 1];
  if (last !== void 0) {
    if (unit.breath === true) last.breath = true;
    if (unit.lengthen === true) last.lengthen = true;
  }
  return pieces;
}
const endsSoft = (text) => /(?:—|…)$/u.test(text);
const lengthenTail = (text) => {
  if (endsSoft(text)) return text;
  return /[。！？!?]$/u.test(text) ? text.replace(/[。！？!?]$/u, ELISION) : text + BREATH_TAIL;
};
const breathe = (text) => {
  let next = text;
  if (!/[，,、]/u.test(next) && !endsSoft(next)) {
    const chars = Array.from(next.replace(/[。！？!?]$/u, ""));
    if (chars.length >= 4) {
      const cut = Math.floor(chars.length * 2 / 3);
      next = chars.slice(0, cut).join("") + "\uFF0C" + chars.slice(cut).join("");
    }
  }
  if (!/[。！？!?…—]$/u.test(next)) next += BREATH_TAIL;
  return next;
};
function applyExpression(unit) {
  let text = typeof unit.say === "string" ? unit.say : "";
  if (text === "") return "";
  if (unit.lengthen === true) text = lengthenTail(text);
  if (unit.breath === true) text = breathe(text);
  return text;
}
export {
  ADJUSTMENTS,
  CONSTRUCTS,
  EXPRESS_TOKENS,
  MARK_LIMITS,
  MAX_SPANS_PER_REQUEST,
  PACE_DELTAS,
  PAUSE_MS,
  STEP_LIMITS,
  TONE_DELTAS,
  VOCABULARY,
  applyExpression,
  effectiveProsody,
  expressionProsody,
  expressionSsmlChunks,
  normalizeVoiceLines,
  normalizeVoiceUnits,
  parseProsodyPercent,
  pauseMsFor,
  prosodyKey,
  resolveMarks,
  splitStress
};
