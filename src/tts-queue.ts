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
  /** Host-elected playback client; absent when no client claimed the session. */
  owner?: string
  /** Monotonic within the session; never reused, never reordered. */
  seq: number
  /** Reply round, incremented once per assistant answer. */
  epoch: number
  /** Groups the sentences of one assistant reply for repeat playback. */
  replyId?: string
  /** Same-sentence read-aloud blocks share this id. */
  sentenceId?: number
  /** Zero-based position of this block inside its sentence. */
  chunkIndex?: number
  /** Markdown-stripped sentence text (shown as live caption). */
  text: string
  /** Base64 MP3 bytes (24kHz mono); empty when `error` is set. */
  audio: string
  /** Edge TTS failed; the client may fall back to the system voice. */
  error?: string
}

export type FrameListener = (frame: VoiceFrame) => void

/** Result of a host-side cancel, used by the client control route. */
export interface TtsCancelResult {
  /** Pending or in-flight sentences invalidated by this request. */
  pending: number
  /** Whether a sentence was synthesizing when the request arrived. */
  active: boolean
}

/** One sentence still waiting behind the synthesizer. */
export interface TtsQueueItem {
  text: string
  replyId?: string
  round: number
  sentenceId?: number
  chunkIndex?: number
}

/** Read-only view of the host-side synthesis queue for the page. */
export interface TtsQueueSnapshot {
  /** The synthesizer is working, opening, or waiting out a retry. */
  busy: boolean
  /** A sentence is currently being synthesized. */
  active: boolean
  /** Sentences waiting behind the current one. */
  pending: number
  /** The full waiting list, oldest first; the host is the only owner. */
  items: TtsQueueItem[]
  /** Current sentence text, bounded for display. */
  text?: string
  replyId?: string
}

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
/** Longest single sentence that may join an adjacent one in one TTS request. */
const MERGE_ITEM_MAX_CHARS = 40
/** Hard cap for one merged TTS request; longer runs start a new request. */
const MERGE_RUN_MAX_CHARS = 160
/** Hard cap on how many queue items may share one merged TTS request. */
const MERGE_RUN_MAX_ITEMS = 6
/** Comma inserted between short lines that have no punctuation at the seam. */
const MERGE_JOINER = '，'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Convert a signed percentage (-50..50) into the SSML relative rate. */
export function rateToProsody(rate: number): string {
  const value = Math.max(-50, Math.min(50, Math.round(rate)))
  return value === 0 ? 'default' : (value > 0 ? '+' : '') + value + '%'
}

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
    connectionTimeoutMs: 8_000,
    synthesisTimeoutMs: 20_000,
  })
}

interface QueuedSentence {
  text: string
  epoch: number
  /** Reply round; 0 when the caller does not track rounds. */
  round: number
  replyId?: string
  sentenceId?: number
  chunkIndex?: number
}

/**
 * A block cut at a length threshold may not end in punctuation. Give TTS a
 * tiny trailing pause so blocks that were reordered together do not run into
 * each other; terminal punctuation is never replaced or removed.
 */
export function withSpeechPause(text: string): string {
  const clean = text.trim()
  if (!clean) return clean
  if (/[，、；：,;:。！？!?…\s]$/u.test(clean)) return clean
  return clean + '，'
}

/** One Edge TTS request may represent several consecutive short queue items. */
export interface MergedSynthesisRun {
  /** Text to synthesize in one request. */
  text: string
  /** Number of leading queue items represented by `text` (always 1 or more). */
  count: number
}

const BOUNDARY_PUNCTUATION = /[\p{P}\p{S}]/u
const JOIN_SEPARATOR = /[，,、；;：:。.!！?？…]/u
const TERMINAL_PUNCTUATION = /[。.!！?？…]/u
const CLAUSE_SEPARATOR = /[；;：:]/u

/** Count user-visible characters, not UTF-16 code units. */
function characterCount(text: string): number {
  return Array.from(text).length
}

function punctuationRank(char: string): number {
  if (TERMINAL_PUNCTUATION.test(char)) return 3
  if (CLAUSE_SEPARATOR.test(char)) return 2
  if (JOIN_SEPARATOR.test(char)) return 1
  return 0
}

function dropLastCharacter(text: string): string {
  const chars = Array.from(text)
  chars.pop()
  return chars.join('')
}

/**
 * Join two short lines for a single TTS request. Add a Chinese comma only when
 * neither side already provides punctuation; when both sides have a joining
 * mark at the seam, keep one (the stronger one) instead of doubling it.
 */
function joinSynthesisText(left: string, right: string): string {
  const before = left.trimEnd()
  const after = right.trimStart()
  if (!before) return after
  if (!after) return before

  const leftMark = before.at(-1) ?? ''
  const rightChars = Array.from(after)
  const rightMark = rightChars[0] ?? ''
  const leftPunctuated = BOUNDARY_PUNCTUATION.test(leftMark)
  const rightPunctuated = rightMark !== '' && BOUNDARY_PUNCTUATION.test(rightMark)

  if (!leftPunctuated && !rightPunctuated) return before + MERGE_JOINER + after
  if (!leftPunctuated || !rightPunctuated) return before + after

  // Both sides already have punctuation. A leading separator on the right
  // would duplicate the seam when the left already ends a clause or sentence.
  if (JOIN_SEPARATOR.test(rightMark)) {
    if (JOIN_SEPARATOR.test(leftMark) && punctuationRank(rightMark) > punctuationRank(leftMark)) {
      return dropLastCharacter(before) + after
    }
    return before + rightChars.slice(1).join('')
  }
  return before + after
}

/**
 * Fold a run of consecutive short queue items from the head into one TTS
 * request. Stops at a different reply, a long item, 6 items, or 160 chars.
 * A non-mergeable head is still returned with count 1 so the pump can consume
 * it through the same path as a merged run.
 */
export function mergeSynthesisRun(items: readonly TtsQueueItem[]): MergedSynthesisRun {
  const first = items[0]
  if (!first) return { text: '', count: 0 }

  let text = first.text
  let count = 1
  if (characterCount(first.text.trim()) > MERGE_ITEM_MAX_CHARS) {
    return { text, count }
  }

  while (count < MERGE_RUN_MAX_ITEMS && count < items.length) {
    const next = items[count]
    if (!next || next.replyId !== first.replyId) break
    if (characterCount(next.text.trim()) > MERGE_ITEM_MAX_CHARS) break
    const joined = joinSynthesisText(text, next.text)
    if (characterCount(joined) > MERGE_RUN_MAX_CHARS) break
    text = joined
    count += 1
  }
  return { text, count }
}

interface SessionQueue {
  pending: QueuedSentence[]
  /** The sentence currently inside the synthesis pump. */
  current: QueuedSentence | null
  busy: boolean
  seq: number
  /** Bumped by cancel(); sentences carrying a stale epoch are dropped. */
  epoch: number
  /** Reply ids cancelled while their sentence was already synthesizing. */
  cancelledReplies: Set<string>
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
  private prosody?: ProsodyOptions
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

  /** Change the speaking rate for subsequent sentences; the open handshake is reused. */
  setRate(rate: number): void {
    this.prosody = { ...(this.prosody ?? {}), rate: rateToProsody(rate) }
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

  /**
   * Establish the Edge handshake ahead of the first sentence. The proxy
   * occasionally resets a fresh TLS connection; retry a few times so the
   * first reply does not have to wait for that recovery.
   */
  async warm(attempts = 3): Promise<void> {
    let lastError: unknown
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await this.ensureReady()
        return
      } catch (error) {
        lastError = error
        this.resetConnection()
        if (attempt < attempts) await sleep(300)
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  subscribe(listener: FrameListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Enqueue one read-aloud block; starts the pump if idle. */
  enqueue(
    sessionId: string,
    text: string,
    replyId?: string,
    round = 0,
    block: { sentenceId?: number; chunkIndex?: number } = {},
  ): void {
    let q = this.queues.get(sessionId)
    if (!q) {
      q = {
        pending: [], current: null, busy: false, seq: 0, epoch: 0,
        cancelledReplies: new Set(), failures: 0, retry: null,
      }
      this.queues.set(sessionId, q)
    }
    const sentenceId = typeof block.sentenceId === 'number' && Number.isFinite(block.sentenceId)
      ? Math.max(0, Math.trunc(block.sentenceId)) : undefined
    const chunkIndex = typeof block.chunkIndex === 'number' && Number.isFinite(block.chunkIndex)
      ? Math.max(0, Math.trunc(block.chunkIndex)) : undefined
    q.pending.push({
      text, epoch: q.epoch, round: Math.max(0, Math.trunc(round)), replyId,
      ...(sentenceId === undefined ? {} : { sentenceId }),
      ...(chunkIndex === undefined ? {} : { chunkIndex }),
    })
    void this.pump(sessionId, q)
  }

  /**
   * Drop all pending sentences and invalidate the in-flight synthesis for
   * one session (barge-in). Sentences enqueued after this call get the new
   * epoch and play normally.
   */
  cancel(sessionId: string): TtsCancelResult {
    const q = this.queues.get(sessionId)
    if (!q) return { pending: 0, active: false }
    const active = q.current !== null && q.current.epoch === q.epoch
    const pending = q.pending.length + (active ? 1 : 0)
    q.epoch++
    q.pending.length = 0
    q.cancelledReplies.clear()
    this.clearRetry(q)
    return { pending, active }
  }

  /**
   * Cancel only one assistant reply. Pending sentences are removed immediately;
   * a sentence already inside the synthesizer is invalidated so its frame is
   * dropped as soon as the audio stream yields again.
   */
  cancelReply(sessionId: string, replyId: string): TtsCancelResult {
    if (!replyId) return this.cancel(sessionId)
    const q = this.queues.get(sessionId)
    if (!q) return { pending: 0, active: false }
    const before = q.pending.length
    for (let index = q.pending.length - 1; index >= 0; index -= 1) {
      if (q.pending[index]?.replyId === replyId) q.pending.splice(index, 1)
    }
    const active = q.current?.replyId === replyId
    if (active) {
      q.cancelledReplies.add(replyId)
      while (q.cancelledReplies.size > 16) {
        const oldest = q.cancelledReplies.values().next().value
        if (oldest === undefined) break
        q.cancelledReplies.delete(oldest)
      }
    }
    return { pending: before - q.pending.length + (active ? 1 : 0), active }
  }

  /** Read-only snapshot used by the page's live status line. */
  snapshot(sessionId: string): TtsQueueSnapshot {
    const q = this.queues.get(sessionId)
    if (!q) return { busy: false, active: false, pending: 0, items: [] }
    const current = q.current
    return {
      busy: q.busy,
      active: current !== null,
      pending: q.pending.length,
      items: q.pending.map((item) => ({
        text: item.text,
        round: item.round,
        ...(item.replyId === undefined ? {} : { replyId: item.replyId }),
        ...(item.sentenceId === undefined ? {} : { sentenceId: item.sentenceId }),
        ...(item.chunkIndex === undefined ? {} : { chunkIndex: item.chunkIndex }),
      })),
      ...(current === null ? {} : {
        text: current.text.slice(0, 120),
        ...(current.replyId === undefined ? {} : { replyId: current.replyId }),
      }),
    }
  }

  /** True when a pending/current sentence was invalidated by a cancel call. */
  private isCancelled(q: SessionQueue, item: QueuedSentence): boolean {
    return item.epoch !== q.epoch
      || (item.replyId !== undefined && q.cancelledReplies.has(item.replyId))
  }

  /** Stop the backoff timer (if any) and let a fresh enqueue pump at once. */
  private clearRetry(q: SessionQueue): void {
    if (q.retry !== null) {
      clearTimeout(q.retry)
      q.retry = null
    }
  }

  /**
   * Remove the exact queue-item objects consumed by a merged synthesis run.
   * Matching by identity keeps items appended during the await (or re-enqueued
   * after a cancel) intact.
   */
  private dropPendingItems(q: SessionQueue, items: QueuedSentence[]): void {
    if (items.length === 0) return
    const consumed = new Set(items)
    if (q.pending.some((item) => consumed.has(item))) {
      q.pending = q.pending.filter((item) => !consumed.has(item))
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
      for (const item of q.pending) {
        this.emitFailure(sessionId, q, item.text, item.replyId, 'TTS unavailable', item.round, item)
      }
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
        const run = mergeSynthesisRun(q.pending)
        const item = q.pending.shift()!
        // The head becomes `current` as before. The rest of a merged run stays
        // in pending until its one request settles, so snapshot/cancel counts
        // keep their historical meaning while synthesis is in flight.
        const mergedTail = run.count > 1 ? q.pending.slice(0, run.count - 1) : []
        q.current = item
        let buf: Buffer | undefined
        let lastError: unknown
        try {
          if (this.isCancelled(q, item)) continue
          for (let attempt = 1; attempt <= this.synthAttempts; attempt++) {
            try {
              // A reset cleared the handshake, so later attempts dial again.
              if (attempt > 1) await this.ensureReady()
              const { audioStream } = await this.tts.toStream(withSpeechPause(run.text), this.prosody)
              const chunks: Buffer[] = []
              for await (const chunk of audioStream) {
                if (this.isCancelled(q, item)) break
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
            if (this.isCancelled(q, item)) continue
            if (!buf) throw lastError instanceof Error ? lastError : new Error(String(lastError))
            // A valid MP3 frame starts with a sync word; drop metadata garbage.
            if (buf.length === 0 || buf[0] !== MP3_MAGIC) continue
            // Barge-in happened while this sentence was synthesizing: drop it.
            if (item.epoch !== q.epoch) continue
            const frame: VoiceFrame = {
              sessionId,
              seq: q.seq++,
              epoch: item.round,
              replyId: item.replyId,
              ...(item.sentenceId === undefined ? {} : { sentenceId: item.sentenceId }),
              ...(item.chunkIndex === undefined ? {} : { chunkIndex: item.chunkIndex }),
              text: run.text,
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
            if (!this.isCancelled(q, item)) {
              this.emitFailure(sessionId, q, run.text, item.replyId, message, item.round, item)
            }
          }
        } finally {
          // enqueue() may have appended work while toStream was awaited. Remove
          // this run by identity, never by a stale prefix length.
          this.dropPendingItems(q, mergedTail)
          if (q.current === item) q.current = null
        }
      }
    } catch (e) {
      // ensureReady failure: the pending sentences stay queued and the retry
      // is scheduled with backoff instead of re-entering the pump at once.
      // eslint-disable-next-line no-console
      console.warn(`[dsh-voice-dialog] TTS unavailable: ${String(e)}`)
      // A failed handshake can leave msedge-tts in a bad state; retrying the
      // same instance tends to fail again. Re-dial before the backoff.
      this.resetConnection()
      this.scheduleRetry(sessionId, q)
    } finally {
      q.busy = false
    }
  }

  private emitFailure(
    sessionId: string, q: SessionQueue, text: string,
    replyId: string | undefined, error: string, round = 0,
    block: { sentenceId?: number; chunkIndex?: number } = {},
  ): void {
    this.emit({
      sessionId, seq: q.seq++, epoch: Math.max(0, Math.trunc(round)), replyId,
      ...(block.sentenceId === undefined ? {} : { sentenceId: block.sentenceId }),
      ...(block.chunkIndex === undefined ? {} : { chunkIndex: block.chunkIndex }),
      text, audio: '', error,
    })
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