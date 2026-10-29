import httpsProxyAgent from "https-proxy-agent";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
const MP3_MAGIC = 255;
const RETRY_BASE_MS = 1e3;
const RETRY_MAX_MS = 3e4;
const MAX_RETRIES = 5;
const SYNTH_ATTEMPTS = 3;
const SYNTH_RETRY_DELAY_MS = 250;
const EDGE_TTS_HOST = "speech.platform.bing.com";
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
class TtsQueue {
  tts = createEdgeTts();
  queues = /* @__PURE__ */ new Map();
  listeners = /* @__PURE__ */ new Set();
  voice;
  prosody;
  synthAttempts;
  retryDelayMs;
  ready = null;
  constructor(options = {}) {
    this.voice = options.voice ?? "zh-CN-XiaoxiaoNeural";
    this.prosody = options.prosody;
    this.synthAttempts = Number.isFinite(options.synthAttempts) ? Math.max(1, Math.floor(options.synthAttempts)) : SYNTH_ATTEMPTS;
    this.retryDelayMs = Number.isFinite(options.retryDelayMs) ? Math.max(0, Math.floor(options.retryDelayMs)) : SYNTH_RETRY_DELAY_MS;
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
      q = { pending: [], busy: false, seq: 0, epoch: 0, failures: 0, retry: null };
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
    if (q) {
      q.epoch++;
      q.pending.length = 0;
      this.clearRetry(q);
    }
  }
  /** Stop the backoff timer (if any) and let a fresh enqueue pump at once. */
  clearRetry(q) {
    if (q.retry !== null) {
      clearTimeout(q.retry);
      q.retry = null;
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
        const item = q.pending.shift();
        let buf;
        let lastError;
        for (let attempt = 1; attempt <= this.synthAttempts; attempt++) {
          try {
            if (attempt > 1) await this.ensureReady();
            const { audioStream } = await this.tts.toStream(withSpeechPause(item.text), this.prosody);
            const chunks = [];
            for await (const chunk of audioStream) {
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
            text: item.text,
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
          if (item.epoch === q.epoch) this.emitFailure(sessionId, q, item.text, item.replyId, message, item.round, item);
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
  TtsQueue,
  bypassProxy,
  createEdgeTts,
  rateToProsody,
  resolveProxyUrl,
  withSpeechPause
};
