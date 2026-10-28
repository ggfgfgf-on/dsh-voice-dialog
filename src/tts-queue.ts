/** Adapted from haoku123/dsh-voice (MIT). See NOTICE. */
/**
 * Per-session TTS queue: serial synthesis (msedge-tts) + SSE broadcast.
 *
 * The llm/stream tap is lossless and synchronous-fast: it only segments
 * deltas and enqueues sentences. Synthesis runs on a background pump so the
 * model stream is never blocked by network/audio work.
 *
 * The dialog policy does not call `cancel()` on interruption: playback is
 * ducked and the transcript is steered into the model, so a reply can finish
 * naturally. `cancel()` remains for an explicit stop.
 */

import httpsProxyAgent from 'https-proxy-agent'
import { MsEdgeTTS, OUTPUT_FORMAT, type ProsodyOptions } from 'msedge-tts'

export interface VoiceFrame {
  sessionId: string
  seq: number
  /** Groups the sentences of one assistant reply for repeat playback. */
  replyId?: string
  /** Markdown-stripped sentence text (shown as live caption). */
  text: string
  /** Base64 MP3 bytes (24kHz mono); empty when `error` is set. */
  audio: string
  /** Edge TTS failed; the client may fall back to the system voice. */
  error?: string
}

export type FrameListener = (frame: VoiceFrame) => void

const MP3_MAGIC = 0xff
/** First retry delay after a failed TTS handshake; doubles every attempt. */
const RETRY_BASE_MS = 1000
/** Cap for the exponential backoff. */
const RETRY_MAX_MS = 30_000
/** Give up (and drop the pending sentences) after this many consecutive fails. */
const MAX_RETRIES = 5
/** Per-sentence WebSocket attempts; a fresh socket is opened between attempts. */
const SYNTH_ATTEMPTS = 3
/** Short pause before re-dialing Edge TTS after a reset. */
const SYNTH_RETRY_DELAY_MS = 250
/** The WebSocket host whose traffic should follow the configured proxy. */
const EDGE_TTS_HOST = 'speech.platform.bing.com'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

let proxyNoticePrinted = false

/** Only HTTP(S) CONNECT proxies are supported by https-proxy-agent. */
export function resolveProxyUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.DSH_VOICE_TTS_PROXY
    ?? env.HTTPS_PROXY ?? env.https_proxy
    ?? env.HTTP_PROXY ?? env.http_proxy
    ?? env.ALL_PROXY ?? env.all_proxy
  if (!raw) return undefined
  const value = raw.trim()
  if (!/^https?:\/\//i.test(value)) return undefined
  try {
    const parsed = new URL(value)
    return parsed.hostname ? value : undefined
  } catch {
    return undefined
  }
}

/** Minimal NO_PROXY matcher for host names (the Edge endpoint has no CIDR needs). */
export function bypassProxy(host: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.NO_PROXY ?? env.no_proxy
  if (!raw) return false
  const target = host.toLowerCase()
  for (const entry of raw.split(',')) {
    let rule = entry.trim().toLowerCase()
    if (!rule) continue
    if (rule === '*') return true
    rule = rule.replace(/^\*\./, '').replace(/^\./, '')
    rule = rule.replace(/:\d+$/, '')
    if (target === rule || target.endsWith('.' + rule)) return true
  }
  return false
}

function redactProxy(value: string): string {
  return value.replace(/\/\/[^/@]+@/, '//***@')
}

/**
 * Create an Edge TTS client that follows the host's HTTPS proxy.
 *
 * ws (used by msedge-tts) does not honor HTTP(S)_PROXY itself. On networks
 * where direct egress to speech.platform.bing.com is reset but the system
 * proxy works, the WebSocket handshake fails with ECONNRESET unless an agent
 * is supplied explicitly.
 */
export function createEdgeTts(): MsEdgeTTS {
  const proxy = resolveProxyUrl()
  const useProxy = proxy !== undefined && !bypassProxy(EDGE_TTS_HOST)
  const agent = useProxy
    ? new (httpsProxyAgent as unknown as { HttpsProxyAgent: new (url: string) => object }).HttpsProxyAgent(proxy)
    : undefined
  if (agent && !proxyNoticePrinted) {
    proxyNoticePrinted = true
    // eslint-disable-next-line no-console
    console.log('[dsh-voice-dialog] Edge TTS via proxy ' + redactProxy(proxy as string))
  }
  return new MsEdgeTTS({
    agent,
    connectionTimeoutMs: 15_000,
    synthesisTimeoutMs: 30_000,
  })
}

interface QueuedSentence {
  text: string
  epoch: number
  replyId?: string
}

interface SessionQueue {
  pending: QueuedSentence[]
  busy: boolean
  seq: number
  /** Bumped by cancel(); sentences carrying a stale epoch are dropped. */
  epoch: number
  /** Consecutive `ensureReady` failures; drives the backoff. */
  failures: number
  /** Pending retry timer, if the pump is waiting out a backoff. */
  retry: ReturnType<typeof setTimeout> | null
}

export class TtsQueue {
  private tts = createEdgeTts()
  private readonly queues = new Map<string, SessionQueue>()
  private readonly listeners = new Set<FrameListener>()
  private voice: string
  private readonly prosody?: ProsodyOptions
  private readonly synthAttempts: number
  private readonly retryDelayMs: number
  private ready: Promise<void> | null = null

  constructor(options: {
    voice?: string
    prosody?: ProsodyOptions
    /** Per-sentence attempts; exposed for deterministic tests. */
    synthAttempts?: number
    retryDelayMs?: number
  } = {}) {
    this.voice = options.voice ?? 'zh-CN-XiaoxiaoNeural'
    this.prosody = options.prosody
    this.synthAttempts = Number.isFinite(options.synthAttempts)
      ? Math.max(1, Math.floor(options.synthAttempts as number))
      : SYNTH_ATTEMPTS
    this.retryDelayMs = Number.isFinite(options.retryDelayMs)
      ? Math.max(0, Math.floor(options.retryDelayMs as number))
      : SYNTH_RETRY_DELAY_MS
  }

  /** Switch the Edge voice and drop the old handshake; queued text uses the new voice. */
  async setVoice(voice: string): Promise<void> {
    const next = voice.trim()
    if (!next || next === this.voice) return
    this.voice = next
    this.ready = null
    const previous = this.tts
    this.tts = createEdgeTts()
    try { await previous.close() } catch { /* already closed */ }
  }

  /** Initialize the Edge TTS WebSocket once (lazy, re-runnable after close). */
  private async ensureReady(): Promise<void> {
    if (this.ready) return this.ready
    this.ready = this.tts
      .setMetadata(this.voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, {
        wordBoundaryEnabled: false,
        sentenceBoundaryEnabled: false,
      })
      .catch((e) => {
        this.ready = null
        throw e
      })
    return this.ready
  }

  /** Drop a possibly dead socket; the next stream opens a fresh connection. */
  private resetConnection(): void {
    this.ready = null
    const previous = this.tts
    this.tts = createEdgeTts()
    try { previous.close() } catch { /* already closed */ }
  }

  subscribe(listener: FrameListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Enqueue one sentence for a session; starts the pump if idle. */
  enqueue(sessionId: string, text: string, replyId?: string): void {
    let q = this.queues.get(sessionId)
    if (!q) {
      q = { pending: [], busy: false, seq: 0, epoch: 0, failures: 0, retry: null }
      this.queues.set(sessionId, q)
    }
    q.pending.push({ text, epoch: q.epoch, replyId })
    void this.pump(sessionId, q)
  }

  /**
   * Drop all pending sentences and invalidate the in-flight synthesis for
   * one session (barge-in). Sentences enqueued after this call get the new
   * epoch and play normally.
   */
  cancel(sessionId: string): void {
    const q = this.queues.get(sessionId)
    if (q) {
      q.epoch++
      q.pending.length = 0
      this.clearRetry(q)
    }
  }

  /** Stop the backoff timer (if any) and let a fresh enqueue pump at once. */
  private clearRetry(q: SessionQueue): void {
    if (q.retry !== null) {
      clearTimeout(q.retry)
      q.retry = null
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
  private scheduleRetry(sessionId: string, q: SessionQueue): void {
    if (q.pending.length === 0) return
    q.failures++
    if (q.failures > MAX_RETRIES) {
      // eslint-disable-next-line no-console
      console.warn(
        `[dsh-voice-dialog] TTS still unavailable, dropping ${q.pending.length} pending sentence(s)`,
      )
      for (const item of q.pending) this.emitFailure(sessionId, q, item.text, item.replyId, 'TTS unavailable')
      q.pending.length = 0
      // A later sentence gets a fresh retry budget instead of being dropped
      // on its first failure because the counter was never reset.
      q.failures = 0
      return
    }
    const delay = Math.min(RETRY_BASE_MS * 2 ** (q.failures - 1), RETRY_MAX_MS)
    this.clearRetry(q)
    q.retry = setTimeout(() => {
      q.retry = null
      void this.pump(sessionId, q)
    }, delay)
    // Do not keep the host process alive just for a retry (the client build
    // types the handle as a number, hence the cast).
    ;(q.retry as unknown as { unref?: () => void }).unref?.()
  }

  private async pump(sessionId: string, q: SessionQueue): Promise<void> {
    // A queued retry owns the next attempt: enqueues arriving during the
    // backoff must not bypass it.
    if (q.busy || q.retry !== null) return
    q.busy = true
    try {
      await this.ensureReady()
      q.failures = 0
      while (q.pending.length > 0) {
        const item = q.pending.shift()!
        let buf: Buffer | undefined
        let lastError: unknown
        for (let attempt = 1; attempt <= this.synthAttempts; attempt++) {
          try {
            // A reset cleared the handshake, so later attempts dial again.
            if (attempt > 1) await this.ensureReady()
            const { audioStream } = await this.tts.toStream(item.text)
            const chunks: Buffer[] = []
            for await (const chunk of audioStream) {
              chunks.push(chunk as Buffer)
            }
            buf = Buffer.concat(chunks)
            break
          } catch (e) {
            lastError = e
            const message = e instanceof Error ? e.message : String(e)
            if (attempt === this.synthAttempts) break
            // The socket may still look open after a reset. Re-dial instead of
            // sending every remaining sentence through a dead connection.
            // eslint-disable-next-line no-console
            console.warn('[dsh-voice-dialog] synthesis attempt ' + attempt + ' failed (' + message + '), retrying on a fresh socket')
            this.resetConnection()
            await sleep(this.retryDelayMs)
          }
        }
        try {
          if (!buf) throw lastError instanceof Error ? lastError : new Error(String(lastError))
          // A valid MP3 frame starts with a sync word; drop metadata garbage.
          if (buf.length === 0 || buf[0] !== MP3_MAGIC) continue
          // Barge-in happened while this sentence was synthesizing: drop it.
          if (item.epoch !== q.epoch) continue
          const frame: VoiceFrame = {
            sessionId,
            seq: q.seq++,
            replyId: item.replyId,
            text: item.text,
            audio: buf.toString('base64'),
          }
          for (const fn of this.listeners) {
            try {
              fn(frame)
            } catch {
              // listener errors must not kill the pump
            }
          }
        } catch (e) {
          // One failed sentence must not stop the queue; report it and let the
          // browser read that sentence with the system voice instead.
          const message = e instanceof Error ? e.message : String(e)
          // eslint-disable-next-line no-console
          console.warn('[dsh-voice-dialog] synthesis failed: ' + message)
          if (item.epoch === q.epoch) this.emitFailure(sessionId, q, item.text, item.replyId, message)
        }
      }
    } catch (e) {
      // ensureReady failure: the pending sentences stay queued and the retry
      // is scheduled with backoff instead of re-entering the pump at once.
      // eslint-disable-next-line no-console
      console.warn(`[dsh-voice-dialog] TTS unavailable: ${String(e)}`)
      this.scheduleRetry(sessionId, q)
    } finally {
      q.busy = false
    }
  }

  private emitFailure(sessionId: string, q: SessionQueue, text: string, replyId: string | undefined, error: string): void {
    this.emit({ sessionId, seq: q.seq++, replyId, text, audio: '', error })
  }

  private emit(frame: VoiceFrame): void {
    for (const fn of this.listeners) {
      try {
        fn(frame)
      } catch {
        // listener errors must not kill the pump
      }
    }
  }

  async close(): Promise<void> {
    for (const q of this.queues.values()) this.clearRetry(q)
    await this.tts.close()
    this.ready = null
  }
}