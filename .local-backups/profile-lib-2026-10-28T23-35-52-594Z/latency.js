const LATENCY_STAGES = [
  "utterance_end",
  "separation_done",
  "asr_start",
  "asr_done",
  "organize_start",
  "organize_done",
  "enqueue",
  "first_token",
  "play_start"
];
function sanitizeLatencyRecord(value) {
  if (!value || typeof value !== "object") return null;
  const record = value;
  const kind = typeof record.kind === "string" ? record.kind.slice(0, 24) : "";
  if (!kind) return null;
  const sessionId = typeof record.sessionId === "string" ? record.sessionId.slice(0, 80) : "";
  const at = typeof record.at === "string" ? record.at.slice(0, 32) : (/* @__PURE__ */ new Date()).toISOString();
  const out = { kind, sessionId, at };
  for (const key of ["id", "lane", "preview", "organizerAction", "prewarm", "replyId", "phase", "reason"]) {
    const field = record[key];
    if (typeof field === "string") out[key] = field.slice(0, key === "preview" ? 20 : 64);
  }
  for (const key of [
    "textLength",
    "totalMs",
    "fastPath",
    "retracted",
    "clamped",
    "sinceEnqueueMs",
    "epoch",
    "seq",
    "endpointWaitMs",
    "separationWaitMs",
    "asrQueueMs",
    "asrWallMs",
    "asrTransportMs",
    "asrInferMs",
    "decomposedMs",
    "residualMs"
  ]) {
    const field = record[key];
    if (typeof field === "number" && Number.isFinite(field)) out[key] = field;
    else if (typeof field === "boolean") out[key] = field;
  }
  const stages = record.stagesMs;
  if (stages && typeof stages === "object") {
    const clean = {};
    for (const stage of LATENCY_STAGES) {
      const field = stages[stage];
      clean[stage] = typeof field === "number" && Number.isFinite(field) ? field : null;
    }
    out.stagesMs = clean;
  }
  return out;
}
let traceCounter = 0;
function latencyPreview(text) {
  const flat = String(text ?? "").replace(/\s+/gu, " ").trim();
  return flat.slice(0, 20);
}
function createUtteranceTrace(input, clock = Date.now) {
  traceCounter += 1;
  const startedAt = typeof input.startedAt === "number" && Number.isFinite(input.startedAt) ? input.startedAt : clock();
  return {
    id: input.id ?? input.sessionId + ":" + startedAt + ":" + traceCounter,
    sessionId: input.sessionId,
    lane: input.lane,
    startedAt,
    marks: {},
    textLength: 0,
    preview: ""
  };
}
function markUtteranceStage(trace, stage, clock = Date.now) {
  if (!trace) return;
  if (!LATENCY_STAGES.includes(stage)) return;
  if (trace.marks[stage] !== void 0) return;
  trace.marks[stage] = clock();
}
function noteUtteranceText(trace, text) {
  if (!trace) return;
  const flat = String(text ?? "").replace(/\s+/gu, " ").trim();
  trace.textLength = flat.length;
  trace.preview = latencyPreview(flat);
}
function buildUtteranceRecord(trace, options = {}, clock = Date.now) {
  const timing = options.timing ?? {};
  const base = timing.speechEndAt ?? trace.marks.utterance_end ?? trace.startedAt;
  const marks = { ...trace.marks };
  if (timing.separationDoneAt !== void 0) marks.separation_done = timing.separationDoneAt;
  if (timing.asrStartAt !== void 0) marks.asr_start = timing.asrStartAt;
  if (timing.asrDoneAt !== void 0) marks.asr_done = timing.asrDoneAt;
  const stagesMs = {};
  let maximum = 0;
  let clamped = false;
  for (const stage of LATENCY_STAGES) {
    const mark = marks[stage];
    if (mark === void 0) {
      stagesMs[stage] = null;
      continue;
    }
    let delta = mark - base;
    if (delta < 0) {
      delta = 0;
      clamped = true;
    }
    stagesMs[stage] = delta;
    if (delta > maximum) maximum = delta;
  }
  const utteranceEnd = stagesMs.utterance_end;
  const asrStart = stagesMs.asr_start;
  const asrDone = stagesMs.asr_done;
  const separation = stagesMs.separation_done;
  const derived = {};
  if (utteranceEnd !== null) {
    derived.endpointWaitMs = utteranceEnd;
    if (separation !== null && separation >= utteranceEnd) derived.separationWaitMs = separation - utteranceEnd;
    if (asrStart !== null) {
      const anchor = separation !== null ? separation : utteranceEnd;
      if (asrStart >= anchor) derived.asrQueueMs = asrStart - anchor;
    }
    if (asrStart !== null && asrDone !== null && asrDone >= asrStart) {
      derived.asrWallMs = asrDone - asrStart;
      if (options.timing?.asrInferMs !== void 0) {
        const infer = Math.max(0, Math.round(options.timing.asrInferMs));
        derived.asrInferMs = infer;
        derived.asrTransportMs = Math.max(0, derived.asrWallMs - infer);
      }
    }
    const parts = [
      derived.endpointWaitMs,
      derived.separationWaitMs,
      derived.asrQueueMs,
      derived.asrTransportMs,
      derived.asrInferMs
    ];
    if (parts.every((value) => value !== void 0)) {
      derived.decomposedMs = parts.reduce((sum, value) => sum + value, 0);
      const ready = stagesMs.enqueue ?? asrDone;
      if (ready !== null) derived.residualMs = Math.round(ready - derived.decomposedMs);
    }
  }
  return {
    kind: "utterance",
    id: trace.id,
    sessionId: trace.sessionId,
    lane: trace.lane,
    at: new Date(clock()).toISOString(),
    textLength: trace.textLength,
    preview: trace.preview,
    stagesMs,
    totalMs: maximum,
    ...options.organizerAction === void 0 ? {} : { organizerAction: options.organizerAction },
    ...options.fastPath === void 0 ? {} : { fastPath: options.fastPath },
    ...options.retracted === void 0 ? {} : { retracted: options.retracted },
    ...options.prewarm === void 0 ? {} : { prewarm: options.prewarm },
    ...clamped ? { clamped: true } : {},
    ...Object.fromEntries(Object.entries(derived).filter(([, value]) => value !== void 0))
  };
}
export {
  LATENCY_STAGES,
  buildUtteranceRecord,
  createUtteranceTrace,
  latencyPreview,
  markUtteranceStage,
  noteUtteranceText,
  sanitizeLatencyRecord
};
