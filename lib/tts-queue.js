import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
const MP3_MAGIC = 255;
const RETRY_BASE_MS = 1e3;
const RETRY_MAX_MS = 3e4;
const MAX_RETRIES = 5;
class TtsQueue {
  tts = new MsEdgeTTS();
  queues = /* @__PURE__ */ new Map();
  listeners = /* @__PURE__ */ new Set();
  voice;
  prosody;
  ready = null;
  constructor(options = {}) {
    this.voice = options.voice ?? "zh-CN-XiaoxiaoNeural";
    this.prosody = options.prosody;
  }
  /** Switch the Edge voice and drop the old handshake; queued text uses the new voice. */
  async setVoice(voice) {
    const next = voice.trim();
    if (!next || next === this.voice) return;
    this.voice = next;
    this.ready = null;
    const previous = this.tts;
    this.tts = new MsEdgeTTS();
    try {
      await previous.close();
    } catch {
    }
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
  subscribe(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  /** Enqueue one sentence for a session; starts the pump if idle. */
  enqueue(sessionId, text) {
    let q = this.queues.get(sessionId);
    if (!q) {
      q = { pending: [], busy: false, seq: 0, epoch: 0, failures: 0, retry: null };
      this.queues.set(sessionId, q);
    }
    q.pending.push({ text, epoch: q.epoch });
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
      for (const item of q.pending) this.emitFailure(sessionId, q, item.text, "TTS unavailable");
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
        try {
          const { audioStream } = await this.tts.toStream(item.text);
          const chunks = [];
          for await (const chunk of audioStream) {
            chunks.push(chunk);
          }
          const buf = Buffer.concat(chunks);
          if (buf.length === 0 || buf[0] !== MP3_MAGIC) continue;
          if (item.epoch !== q.epoch) continue;
          const frame = {
            sessionId,
            seq: q.seq++,
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
          console.warn(`[dsh-voice-dialog] synthesis failed: ${message}`);
          if (item.epoch === q.epoch) this.emitFailure(sessionId, q, item.text, message);
        }
      }
    } catch (e) {
      console.warn(`[dsh-voice-dialog] TTS unavailable: ${String(e)}`);
      this.scheduleRetry(sessionId, q);
    } finally {
      q.busy = false;
    }
  }
  emitFailure(sessionId, q, text, error) {
    this.emit({ sessionId, seq: q.seq++, text, audio: "", error });
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
  TtsQueue
};
