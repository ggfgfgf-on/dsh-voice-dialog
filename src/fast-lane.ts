/**
 * Fast lane: the slow model can think for many seconds before the first visible
 * word, and that gap is silence on a voice call. A small, cheap model reads the
 * reasoning stream and says one short line of real content so the wait has a
 * floor. Everything it produces goes through the same dedupe and queue as the
 * answer, so a repeat is dropped rather than spoken.
 */

/** Silence that must pass before the first fast line. */
export const FAST_LANE_MIN_SILENT_MS = 2200
/** Silence that must pass before a second fast line. */
export const FAST_LANE_GAP_MS = 6500
/** Reasoning characters required before asking the fast model at all. */
export const FAST_LANE_MIN_CHARS = 120
/** Hard cap per reply: the fast lane is a floor, never a commentary track. */
export const FAST_LANE_MAX_LINES = 2
/** Budget for the fast model call; past it the silence stays. */
export const FAST_LANE_TIMEOUT_MS = 700
export const FAST_LANE_MAX_TOKENS = 60
/** How much reasoning tail the fast model gets to read. */
export const FAST_LANE_PROMPT_LIMIT = 700
/** Longest line the fast lane may speak. */
export const FAST_LANE_MAX_CHARS = 20

export const FAST_LANE_SYSTEM_PROMPT = '你是语音快层：主模型还在长时间思考，用户那边没有声音。'
  + '你的唯一任务是从思考片段里挑出已经站得住的内容，用一句话说给用户听，让等待不断线。'
  + '只输出一行 JSON：{"say":"……"}。'
  + '规则：不超过二十个字，口语，一句话一个意思；只准说片段里已经确定的东西，猜测、待验证、还要再查的内容不能说；'
  + '不要寒暄，不要说“稍等、我来看看、好的、明白”这类填充；不提工具名、文件路径、代码、英文标识符；'
  + '片段里没有值得说的内容，就输出 {"say":""}。'

export interface FastLaneState {
  /** Visible characters of reasoning seen so far. */
  reasoningChars: number
  /** Milliseconds since the last spoken line (or since the reply started). */
  silentMs: number
  /** Fast lines already spoken for this reply. */
  spoken: number
  /** A fast request is already running. */
  inFlight: boolean
  enabled?: boolean
  /** The owner asked for silence. */
  directed?: boolean
}

/** Silence the next fast line requires, given how many were spoken already. */
export function fastLaneDelay(spoken: number): number {
  return spoken === 0 ? FAST_LANE_MIN_SILENT_MS : FAST_LANE_GAP_MS
}

/** Whether the fast lane may speak right now. Pure, so it is testable. */
export function shouldRunFastLane(state: FastLaneState): boolean {
  if (state.enabled === false || state.directed === true || state.inFlight) return false
  if (state.spoken >= FAST_LANE_MAX_LINES) return false
  if (state.reasoningChars < FAST_LANE_MIN_CHARS) return false
  return state.silentMs >= fastLaneDelay(state.spoken)
}

export function buildFastLanePrompt(reasoning: string): string {
  const tail = reasoning.trim().slice(-FAST_LANE_PROMPT_LIMIT)
  return [
    '模型当前的思考片段（尾部）：',
    tail,
    '',
    '按规则只输出一行 JSON：{"say":"一句话"}，没有值得说的就输出 {"say":""}。',
  ].join('\n')
}

const FILLER_HEAD = /^(好|好的|好滴|嗯|呃|那么|稍等|稍候|等一[下会]|我看看|我来看看|让我看看|明白|收到|了解)/
const ASCII_RUN = /[A-Za-z0-9_\-]{3,}/

/**
 * Turn the fast model answer into something speakable, or '' for silence.
 * A filler opener, a path, an identifier or an over-long line all mean silence:
 * the fast lane exists to avoid dead air, not to add noise.
 */
export function parseFastLaneAnswer(raw: string): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) return ''
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return ''
  let say: unknown
  try {
    say = (JSON.parse(raw.slice(start, end + 1)) as { say?: unknown }).say
  } catch {
    return ''
  }
  if (typeof say !== 'string') return ''
  let text = say.trim().replace(/^["'“”]|["'“”]$/g, '').replace(/^[，,、。．.；;：:\s]+/u, '').trim()
  if (text.length === 0) return ''
  if (FILLER_HEAD.test(text)) return ''
  if (text.includes('http') || text.includes('/') || text.includes('\\') || text.includes('```')) return ''
  if (ASCII_RUN.test(text)) return ''
  if (text.length > FAST_LANE_MAX_CHARS) {
    const cut = text.search(/[。！？!?；;]/u)
    text = (cut > 0 ? text.slice(0, cut + 1) : '').trim()
    if (text.length === 0 || text.length > FAST_LANE_MAX_CHARS) return ''
  }
  return text
}

/**
 * Servo layer. The slow model can think for forty seconds before its first
 * visible word; a single opener is not enough, the wire has to stay fed for as
 * long as the thinking lasts. The servo reads the reasoning stream, keeps the
 * part it has not spoken yet, and tops the queue up shortly before the line
 * already playing runs out. Every line carries on from the previous one, so the
 * whole stretch sounds like one continuous answer instead of a beep.
 */
export const SERVO_MIN_CHARS = 60
/** Start refilling this long before the current line is estimated to end. */
export const SERVO_TOP_UP_MS = 1400
export const SERVO_MAX_LINES = 8
export const SERVO_FIRST_DELAY_MS = 1500
/** Speaking rate of the default voice, in Chinese characters per second. */
export const SERVO_CHARS_PER_SEC = 4.2
/** Fixed synthesis latency before a queued line is audible. */
export const SERVO_SYNTH_MS = 900
/** After a silence answer, wait this long before asking again. */
export const SERVO_RETRY_MS = 2000
export const SERVO_PROMPT_LIMIT = 420

export interface ServoState {
  /** Reasoning characters not spoken yet. */
  unseenChars: number
  /** Milliseconds until the last queued line is estimated to run out. */
  lineEndsIn: number
  /** Servo lines spoken for this reply. */
  spoken: number
}

/** Whether the servo may speak now. Pure, so the cadence is testable. */
export function shouldServe(state: ServoState): boolean {
  if (state.spoken >= SERVO_MAX_LINES) return false
  if (state.unseenChars < SERVO_MIN_CHARS) return false
  return state.lineEndsIn <= SERVO_TOP_UP_MS
}

/** Estimated milliseconds of audio for one line. */
export function spokenMs(text: string): number {
  return Math.round((text.trim().length / SERVO_CHARS_PER_SEC) * 1000) + SERVO_SYNTH_MS
}

export const SERVO_SYSTEM_PROMPT = '你是语音伺服层：主模型还在长时间思考，用户正在听。'
  + '你把思考里已经确定的内容按顺序一段段说出来，填满这段时间，让整段话听起来是连续说下去的。'
  + '只输出一行 JSON：{"say":"……"}。'
  + '规则：一句到两句，不超过三十个字；开头要和上一句接得上，不要重新起头；只讲已经确定的内容，'
  + '猜测、待验证、还要去查的东西不能说；不要寒暄和填充（好的、稍等、我来看一下、那么、其实）；'
  + '不提工具名、文件路径、代码、英文标识符；没有新内容可说就输出 {"say":""}。'

export function buildServoPrompt(unseen: string, lastLine: string): string {
  return [
    lastLine ? '上一句已经说：' + lastLine : '',
    '思考里还没讲过的部分：',
    unseen.trim().slice(-SERVO_PROMPT_LIMIT),
    '',
    '按规则只输出一行 JSON：{"say":"一到两句"}，没有新内容就输出 {"say":""}。',
  ].filter(Boolean).join('\n')
}

export interface ServoOptions {
  /** Model call; without it the servo never speaks. */
  call?: (prompt: string, signal: AbortSignal) => Promise<string>
  /** Hand a line to the queue (the answer's own speak path, so it is deduped). */
  say: (line: string) => void
  now?: () => number
  timeoutMs?: number
  /** Clock origin: when this reply started. */
  startAt?: number
}

/**
 * Keeps the queue fed while the model thinks. One request at a time, each one
 * only over the reasoning the listener has not heard, and it hands back to the
 * answer the moment the visible text starts speaking.
 */
export class FastLaneServo {
  private unseen = ''
  private lastLine = ''
  private spoken = 0
  private inFlight = false
  private stopped = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private lineEndsAt: number
  /** The first line may not start before this instant, however early the top-up says. */
  private readonly notBefore: number

  constructor(private readonly options: ServoOptions) {
    const now = this.now()
    this.notBefore = (options.startAt ?? now) + SERVO_FIRST_DELAY_MS
    this.lineEndsAt = this.notBefore
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  /** New reasoning text arrived. */
  push(delta: string): void {
    if (this.stopped || delta.length === 0) return
    this.unseen = (this.unseen + delta).slice(-2000)
    this.schedule()
  }

  /** The answer took over, or the owner asked for silence. */
  stop(reason: string): void {
    if (this.stopped) return
    this.stopped = true
    void reason
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  get isStopped(): boolean {
    return this.stopped
  }

  get linesSpoken(): number {
    return this.spoken
  }

  /** Milliseconds until the next possible line, or undefined when idle. */
  private waitMs(): number | undefined {
    if (this.stopped || this.inFlight || !this.options.call) return undefined
    const state: ServoState = {
      unseenChars: this.unseen.trim().length,
      lineEndsIn: this.lineEndsAt - this.now(),
      spoken: this.spoken,
    }
    if (this.spoken >= SERVO_MAX_LINES) return undefined
    const floor = Math.max(this.notBefore - this.now(), 0)
    if (shouldServe(state) && floor === 0) return 0
    return Math.max(Math.max(state.lineEndsIn - SERVO_TOP_UP_MS, 0), floor)
  }

  private schedule(): void {
    const wait = this.waitMs()
    if (wait === undefined) return
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.fire()
    }, Math.max(wait, 0))
  }

  private fire(): void {
    const call = this.options.call
    if (!call || this.stopped || this.inFlight) return
    const state: ServoState = {
      unseenChars: this.unseen.trim().length,
      lineEndsIn: this.lineEndsAt - this.now(),
      spoken: this.spoken,
    }
    if (!shouldServe(state) || this.notBefore > this.now()) {
      this.schedule()
      return
    }
    this.inFlight = true
    const unseen = this.unseen
    const controller = new AbortController()
    const budget = setTimeout(() => controller.abort(), this.options.timeoutMs ?? FAST_LANE_TIMEOUT_MS)
    void call(buildServoPrompt(unseen, this.lastLine), controller.signal)
      .then((raw) => {
        clearTimeout(budget)
        this.inFlight = false
        if (this.stopped) return
        const line = parseFastLaneAnswer(raw)
        if (!line) {
          // Nothing worth saying yet. Back off so an empty answer can never
          // turn into a request loop, then try again at the next top-up.
          this.lineEndsAt = this.now() + SERVO_RETRY_MS
          this.schedule()
          return
        }
        this.spoken += 1
        this.lastLine = line
        this.unseen = ''
        this.lineEndsAt = this.now() + spokenMs(line)
        this.options.say(line)
      })
      .catch(() => {
        clearTimeout(budget)
        this.inFlight = false
        if (!this.stopped) this.schedule()
      })
  }
}
