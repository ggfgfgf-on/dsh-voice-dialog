import httpsProxyAgent from "https-proxy-agent";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
const MP3_MAGIC = 255;
const RETRY_BASE_MS = 1e3;
const RETRY_MAX_MS = 3e4;
const MAX_RETRIES = 5;
const SYNTH_ATTEMPTS = 3;
const SYNTH_RETRY_DELAY_MS = 250;
const EDGE_TTS_HOST = "speech.platform.bing.com";
const MERGE_ITEM_MAX_CHARS = 40;
const MERGE_RUN_MAX_CHARS = 160;
const MERGE_RUN_MAX_ITEMS = 6;
const MERGE_JOINER = "\uFF0C";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function rateToProsody(rate) {
  const value = Math.max(-50, Math.min(50, Math.round(rate)));
  return value === 0 ? "default" : (value > 0 ? "+" : "") + value + "%";
}
let proxyNoticePrinted = false;
function resolveProxyUrl(env = process.env) {
  const raw = env.DSH_VOICE_TTS_PROXY ?? env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy ?? env.ALL_PROXY ?? env.all_proxy;
  if (!raw) return void 0;
  const value = raw.trim();
  if (!/^https?:\/\//i.test(value)) return void 0;
  try {
    const parsed = new URL(value);
    return parsed.hostname ? value : void 0;
  } catch {
    return void 0;
  }
}
function bypassProxy(host, env = process.env) {
  const raw = env.NO_PROXY ?? env.no_proxy;
  if (!raw) return false;
  const target = host.toLowerCase();
  for (const entry of raw.split(",")) {
    let rule = entry.trim().toLowerCase();
    if (!rule) continue;
    if (rule === "*") return true;
    rule = rule.replace(/^\*\./, "").replace(/^\./, "");
    rule = rule.replace(/:\d+$/, "");
    if (target === rule || target.endsWith("." + rule)) return true;
  }
  return false;
}
function redactProxy(value) {
  return value.replace(/\/\/[^/@]+@/, "//***@");
}
function createEdgeTts() {
  const proxy = resolveProxyUrl();
  const useProxy = proxy !== void 0 && !bypassProxy(EDGE_TTS_HOST);
  const agent = useProxy ? new httpsProxyAgent.HttpsProxyAgent(proxy) : void 0;
  if (agent && !proxyNoticePrinted) {
    proxyNoticePrinted = true;
    console.log("[dsh-voice-dialog] Edge TTS via proxy " + redactProxy(proxy));
  }
  return new MsEdgeTTS({
    agent,
    connectionTimeoutMs: 8e3,
    synthesisTimeoutMs: 2e4
  });
}
function withSpeechPause(text) {
  const clean = text.trim();
  if (!clean) return clean;
  if (/[，、；：,;:。！？!?…\s]$/u.test(clean)) return clean;
  return clean + "\uFF0C";
}
const DEFAULT_SYNTHESIS_LIMITS = {
  mergeMaxChars: MERGE_ITEM_MAX_CHARS,
  mergeRunMaxChars: MERGE_RUN_MAX_CHARS,
  mergeRunMaxItems: MERGE_RUN_MAX_ITEMS
};
function normalizeSynthesisLimits(input, base = DEFAULT_SYNTHESIS_LIMITS) {
  if (!input || typeof input !== "object") return { ...base };
  const pick = (value, low, high, fallback) => {
    const number = typeof value === "number" ? value : Number.NaN;
    if (!Number.isFinite(number)) return fallback;
    return Math.min(high, Math.max(low, Math.round(number)));
  };
  return {
    mergeMaxChars: pick(input.mergeMaxChars, 8, 400, base.mergeMaxChars),
    mergeRunMaxChars: pick(input.mergeRunMaxChars, 8, 1200, base.mergeRunMaxChars),
    mergeRunMaxItems: pick(input.mergeRunMaxItems, 1, 32, base.mergeRunMaxItems)
  };
}
const BOUNDARY_PUNCTUATION = /[\p{P}\p{S}]/u;
const JOIN_SEPARATOR = /[，,、；;：:。.!！?？…]/u;
const TERMINAL_PUNCTUATION = /[。.!！?？…]/u;
const CLAUSE_SEPARATOR = /[；;：:]/u;
function characterCount(text) {
  return Array.from(text).length;
}
function punctuationRank(char) {
  if (TERMINAL_PUNCTUATION.test(char)) return 3;
  if (CLAUSE_SEPARATOR.test(char)) return 2;
  if (JOIN_SEPARATOR.test(char)) return 1;
  return 0;
}
function dropLastCharacter(text) {
  const chars = Array.from(text);
  chars.pop();
  return chars.join("");
}
function joinSynthesisText(left, right) {
  const before = left.trimEnd();
  const after = right.trimStart();
  if (!before) return after;
  if (!after) return before;
  const leftMark = before.at(-1) ?? "";
  const rightChars = Array.from(after);
  const rightMark = rightChars[0] ?? "";
  const leftPunctuated = BOUNDARY_PUNCTUATION.test(leftMark);
  const rightPunctuated = rightMark !== "" && BOUNDARY_PUNCTUATION.test(rightMark);
  if (!leftPunctuated && !rightPunctuated) return before + MERGE_JOINER + after;
  if (!leftPunctuated || !rightPunctuated) return before + after;
  if (JOIN_SEPARATOR.test(rightMark)) {
    if (JOIN_SEPARATOR.test(leftMark) && punctuationRank(rightMark) > punctuationRank(leftMark)) {
      return dropLastCharacter(before) + after;
    }
    return before + rightChars.slice(1).join("");
  }
  return before + after;
}
function mergeSynthesisRun(items, limits = DEFAULT_SYNTHESIS_LIMITS) {
  const first = items[0];
  if (!first) return { text: "", count: 0 };
  let text = first.text;
  let count = 1;
  if (characterCount(first.text.trim()) > limits.mergeMaxChars) {
    return { text, count };
  }
  while (count < limits.mergeRunMaxItems && count < items.length) {
    const next = items[count];
    if (!next || next.replyId !== first.replyId) break;
    if (characterCount(next.text.trim()) > limits.mergeMaxChars) break;
    const joined = joinSynthesisText(text, next.text);
    if (characterCount(joined) > limits.mergeRunMaxChars) break;
    text = joined;
    count += 1;
  }
  return { text, count };
}
class TtsQueue {
  tts = createEdgeTts();
  queues = /* @__PURE__ */ new Map();
  listeners = /* @__PURE__ */ new Set();
  voice;
  prosody;
  synthAttempts;
  retryDelayMs;
  ready = null;
  /** Model-declared merge limits; the defaults are today's behaviour. */
  limits = DEFAULT_SYNTHESIS_LIMITS;
  constructor(options = {}) {
    this.voice = options.voice ?? "zh-CN-XiaoxiaoNeural";
    this.prosody = options.prosody;
    this.synthAttempts = Number.isFinite(options.synthAttempts) ? Math.max(1, Math.floor(options.synthAttempts)) : SYNTH_ATTEMPTS;
    this.retryDelayMs = Number.isFinite(options.retryDelayMs) ? Math.max(0, Math.floor(options.retryDelayMs)) : SYNTH_RETRY_DELAY_MS;
  }
  /** Apply a model-declared merge limit set; returns the effective limits. */
  setLimits(next) {
    this.limits = normalizeSynthesisLimits(next, this.limits);
    return this.limits;
  }
  limitsView() {
    return { ...this.limits };
  }
  /** Switch the Edge voice and drop the old handshake; queued text uses the new voice. */
  async setVoice(voice) {
    const next = voice.trim();
    if (!next || next === this.voice) return;
    this.voice = next;
    this.ready = null;
    const previous = this.tts;
    this.tts = createEdgeTts();
    try {
      await previous.close();
    } catch {
    }
  }
  /** Change the speaking rate for subsequent sentences; the open handshake is reused. */
  setRate(rate) {
    this.prosody = { ...this.prosody ?? {}, rate: rateToProsody(rate) };
  }
  /** Initialize the Edge TTS WebSocket once (lazy, re-runnable after close). */
  async ensureReady() {
    if (this.ready) return this.ready;
    this.ready = this.tts.setMetadata(this.voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, {
      wordBoundaryEnabled: false,
      sentenceBoundaryEnabled: false
    }).catch((e) => {
      this.ready = null;
      throw e;
    });
    return this.ready;
  }
  /** Drop a possibly dead socket; the next stream opens a fresh connection. */
  resetConnection() {
    this.ready = null;
    const previous = this.tts;
    this.tts = createEdgeTts();
    try {
      previous.close();
    } catch {
    }
  }
  /**
   * Establish the Edge handshake ahead of the first sentence. The proxy
   * occasionally resets a fresh TLS connection; retry a few times so the
   * first reply does not have to wait for that recovery.
   */
  async warm(attempts = 3) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await this.ensureReady();
        return;
      } catch (error) {
        lastError = error;
        this.resetConnection();
        if (attempt < attempts) await sleep(300);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  /** Enqueue one read-aloud block; starts the pump if idle. */
  enqueue(sessionId, text, replyId, round = 0, block = {}) {
    let q = this.queues.get(sessionId);
    if (!q) {
      q = {
        pending: [],
        current: null,
        busy: false,
        seq: 0,
        epoch: 0,
        cancelledReplies: /* @__PURE__ */ new Set(),
        failures: 0,
        retry: null
      };
      this.queues.set(sessionId, q);
    }
    const sentenceId = typeof block.sentenceId === "number" && Number.isFinite(block.sentenceId) ? Math.max(0, Math.trunc(block.sentenceId)) : void 0;
    const chunkIndex = typeof block.chunkIndex === "number" && Number.isFinite(block.chunkIndex) ? Math.max(0, Math.trunc(block.chunkIndex)) : void 0;
    q.pending.push({
      text,
      epoch: q.epoch,
      round: Math.max(0, Math.trunc(round)),
      replyId,
      ...sentenceId === void 0 ? {} : { sentenceId },
      ...chunkIndex === void 0 ? {} : { chunkIndex }
    });
    void this.pump(sessionId, q);
  }
  /**
   * Drop all pending sentences and invalidate the in-flight synthesis for
   * one session (barge-in). Sentences enqueued after this call get the new
   * epoch and play normally.
   */
  cancel(sessionId) {
    const q = this.queues.get(sessionId);
    if (!q) return { pending: 0, active: false };
    const active = q.current !== null && q.current.epoch === q.epoch;
    const pending = q.pending.length + (active ? 1 : 0);
    q.epoch++;
    q.pending.length = 0;
    q.cancelledReplies.clear();
    this.clearRetry(q);
    return { pending, active };
  }
  /**
   * Cancel only one assistant reply. Pending sentences are removed immediately;
   * a sentence already inside the synthesizer is invalidated so its frame is
   * dropped as soon as the audio stream yields again.
   */
  cancelReply(sessionId, replyId) {
    if (!replyId) return this.cancel(sessionId);
    const q = this.queues.get(sessionId);
    if (!q) return { pending: 0, active: false };
    const before = q.pending.length;
    for (let index = q.pending.length - 1; index >= 0; index -= 1) {
      if (q.pending[index]?.replyId === replyId) q.pending.splice(index, 1);
    }
    const active = q.current?.replyId === replyId;
    if (active) {
      q.cancelledReplies.add(replyId);
      while (q.cancelledReplies.size > 16) {
        const oldest = q.cancelledReplies.values().next().value;
        if (oldest === void 0) break;
        q.cancelledReplies.delete(oldest);
      }
    }
    return { pending: before - q.pending.length + (active ? 1 : 0), active };
  }
  /** Read-only snapshot used by the page's live status line. */
  snapshot(sessionId) {
    const q = this.queues.get(sessionId);
    if (!q) return { busy: false, active: false, pending: 0, items: [] };
    const current = q.current;
    return {
      busy: q.busy,
      active: current !== null,
      pending: q.pending.length,
      items: q.pending.map((item) => ({
        text: item.text,
        round: item.round,
        ...item.replyId === void 0 ? {} : { replyId: item.replyId },
        ...item.sentenceId === void 0 ? {} : { sentenceId: item.sentenceId },
        ...item.chunkIndex === void 0 ? {} : { chunkIndex: item.chunkIndex }
      })),
      ...current === null ? {} : {
        text: current.text.slice(0, 120),
        ...current.replyId === void 0 ? {} : { replyId: current.replyId }
      }
    };
  }
  /** True when a pending/current sentence was invalidated by a cancel call. */
  isCancelled(q, item) {
    return item.epoch !== q.epoch || item.replyId !== void 0 && q.cancelledReplies.has(item.replyId);
  }
  /** Stop the backoff timer (if any) and let a fresh enqueue pump at once. */
  clearRetry(q) {
    if (q.retry !== null) {
      clearTimeout(q.retry);
      q.retry = null;
    }
  }
  /**
   * Remove the exact queue-item objects consumed by a merged synthesis run.
   * Matching by identity keeps items appended during the await (or re-enqueued
   * after a cancel) intact.
   */
  dropPendingItems(q, items) {
    if (items.length === 0) return;
    const consumed = new Set(items);
    if (q.pending.some((item) => consumed.has(item))) {
      q.pending = q.pending.filter((item) => !consumed.has(item));
    }
  }
  /**
   * Re-run the pump after an exponential backoff.
   *
   * `ensureReady()` rejects whenever the Edge TTS handshake fails (offline,
   * blocked network, 403 after an upstream change). Retrying immediately —
   * which a `finally`-based re-pump would do — turns that into a hot loop of
   * WebSocket attempts. Back off instead, and drop the batch after a few
   * failures so a dead service cannot pin the queue forever.
   */
  scheduleRetry(sessionId, q) {
    if (q.pending.length === 0) return;
    q.failures++;
    if (q.failures > MAX_RETRIES) {
      console.warn(
        `[dsh-voice-dialog] TTS still unavailable, dropping ${q.pending.length} pending sentence(s)`
      );
      for (const item of q.pending) {
        this.emitFailure(sessionId, q, item.text, item.replyId, "TTS unavailable", item.round, item);
      }
      q.pending.length = 0;
      q.failures = 0;
      return;
    }
    const delay = Math.min(RETRY_BASE_MS * 2 ** (q.failures - 1), RETRY_MAX_MS);
    this.clearRetry(q);
    q.retry = setTimeout(() => {
      q.retry = null;
      void this.pump(sessionId, q);
    }, delay);
    q.retry.unref?.();
  }
  async pump(sessionId, q) {
    if (q.busy || q.retry !== null) return;
    q.busy = true;
    try {
      await this.ensureReady();
      q.failures = 0;
      while (q.pending.length > 0) {
        const run = mergeSynthesisRun(q.pending, this.limits);
        const item = q.pending.shift();
        const mergedTail = run.count > 1 ? q.pending.slice(0, run.count - 1) : [];
        q.current = item;
        let buf;
        let lastError;
        try {
          if (this.isCancelled(q, item)) continue;
          for (let attempt = 1; attempt <= this.synthAttempts; attempt++) {
            try {
              if (attempt > 1) await this.ensureReady();
              const { audioStream } = await this.tts.toStream(withSpeechPause(run.text), this.prosody);
              const chunks = [];
              for await (const chunk of audioStream) {
                if (this.isCancelled(q, item)) break;
                chunks.push(chunk);
              }
              buf = Buffer.concat(chunks);
              break;
            } catch (e) {
              lastError = e;
              const message = e instanceof Error ? e.message : String(e);
              if (attempt === this.synthAttempts) break;
              console.warn("[dsh-voice-dialog] synthesis attempt " + attempt + " failed (" + message + "), retrying on a fresh socket");
              this.resetConnection();
              await sleep(this.retryDelayMs);
            }
          }
          try {
            if (this.isCancelled(q, item)) continue;
            if (!buf) throw lastError instanceof Error ? lastError : new Error(String(lastError));
            if (buf.length === 0 || buf[0] !== MP3_MAGIC) continue;
            if (item.epoch !== q.epoch) continue;
            const frame = {
              sessionId,
              seq: q.seq++,
              epoch: item.round,
              replyId: item.replyId,
              ...item.sentenceId === void 0 ? {} : { sentenceId: item.sentenceId },
              ...item.chunkIndex === void 0 ? {} : { chunkIndex: item.chunkIndex },
              text: run.text,
              audio: buf.toString("base64")
            };
            for (const fn of this.listeners) {
              try {
                fn(frame);
              } catch {
              }
            }
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            console.warn("[dsh-voice-dialog] synthesis failed: " + message);
            if (!this.isCancelled(q, item)) {
              this.emitFailure(sessionId, q, run.text, item.replyId, message, item.round, item);
            }
          }
        } finally {
          this.dropPendingItems(q, mergedTail);
          if (q.current === item) q.current = null;
        }
      }
    } catch (e) {
      console.warn(`[dsh-voice-dialog] TTS unavailable: ${String(e)}`);
      this.resetConnection();
      this.scheduleRetry(sessionId, q);
    } finally {
      q.busy = false;
    }
  }
  emitFailure(sessionId, q, text, replyId, error, round = 0, block = {}) {
    this.emit({
      sessionId,
      seq: q.seq++,
      epoch: Math.max(0, Math.trunc(round)),
      replyId,
      ...block.sentenceId === void 0 ? {} : { sentenceId: block.sentenceId },
      ...block.chunkIndex === void 0 ? {} : { chunkIndex: block.chunkIndex },
      text,
      audio: "",
      error
    });
  }
  emit(frame) {
    for (const fn of this.listeners) {
      try {
        fn(frame);
      } catch {
      }
    }
  }
  async close() {
    for (const q of this.queues.values()) this.clearRetry(q);
    await this.tts.close();
    this.ready = null;
  }
}
export {
  DEFAULT_SYNTHESIS_LIMITS,
  TtsQueue,
  bypassProxy,
  createEdgeTts,
  mergeSynthesisRun,
  normalizeSynthesisLimits,
  rateToProsody,
  resolveProxyUrl,
  withSpeechPause
};
