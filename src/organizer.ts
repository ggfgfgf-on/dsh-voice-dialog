/** Parallel, model-driven delivery organizer. Pure: no DOM and no fetch here. */

export type OrganizerAction = 'interrupt' | 'queue' | 'ignore'
export type OrganizerLane = 'owner' | 'guest'

export interface OrganizerRequest {
  sessionId: string
  /** Visible transcript, without the speaker prefix. */
  text: string
  lane: OrganizerLane
  /** True while an assistant reply is still being spoken or queued. */
  playing: boolean
  /** Utterances already waiting in the speech scheduler. */
  queued: number
}

export interface OrganizerPlan {
  /** Monotonic version of this organizer instance. */
  version: number
  action: OrganizerAction
  reason: string
}

export interface ParsedOrganizer {
  action: OrganizerAction
  reason: string
}

export type OrganizerPlanner = (request: OrganizerRequest, signal: AbortSignal) => Promise<unknown>

export interface SpeechOrganizerOptions {
  /** Hard deadline for one decision. */
  timeoutMs?: number
}

/** Accept only the three documented actions. */
export function normalizeOrganizerAction(value: unknown): OrganizerAction | null {
  if (typeof value !== 'string') return null
  const action = value.trim().toLowerCase()
  return action === 'interrupt' || action === 'queue' || action === 'ignore' ? action : null
}

/**
 * Tolerate fenced JSON and a short prose preamble. The host asks for JSON, but
 * a model that ignores that instruction must still yield a safe queue default.
 */
export function parseOrganizerResponse(raw: string): ParsedOrganizer | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const text = raw.replace(/```(?:json)?/giu, '').trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as { action?: unknown; reason?: unknown }
    const action = normalizeOrganizerAction(value.action)
    if (!action) return null
    return { action, reason: typeof value.reason === 'string' ? value.reason.slice(0, 80) : '' }
  } catch {
    return null
  }
}

/** A parsed object may come from fetch.json() without another JSON round trip. */
function parsePlannerValue(value: unknown): ParsedOrganizer | null {
  if (typeof value === 'string') return parseOrganizerResponse(value)
  if (!value || typeof value !== 'object') return null
  const record = value as { action?: unknown; reason?: unknown }
  const action = normalizeOrganizerAction(record.action)
  if (!action) return null
  return { action, reason: typeof record.reason === 'string' ? record.reason.slice(0, 80) : '' }
}

/**
 * One organizer per microphone session. Every call bumps the version and
 * aborts the previous model request; a slow old answer can never cut a newer
 * reply. Timeouts and malformed output fall back to the safe "queue" action.
 */
export class SpeechOrganizer {
  private version = 0
  private controller: AbortController | null = null
  private latest: OrganizerPlan | null = null
  private readonly timeoutMs: number

  constructor(private readonly planner: OrganizerPlanner, options: SpeechOrganizerOptions = {}) {
    this.timeoutMs = Math.max(1, Math.round(options.timeoutMs ?? 1200))
  }

  async plan(request: OrganizerRequest): Promise<OrganizerPlan | null> {
    const version = ++this.version
    this.controller?.abort()
    const controller = new AbortController()
    this.controller = controller
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.timeoutMs)

    try {
      const raw = await this.planner(request, controller.signal)
      // A newer utterance started while this request was in flight.
      if (version !== this.version) return null
      if (timedOut) return this.fallback(version, 'timeout')
      const parsed = parsePlannerValue(raw)
      if (!parsed) return this.fallback(version, 'invalid')
      const plan: OrganizerPlan = { version, action: parsed.action, reason: parsed.reason }
      this.latest = plan
      return plan
    } catch {
      if (version !== this.version) return null
      return this.fallback(version, timedOut ? 'timeout' : 'error')
    } finally {
      clearTimeout(timer)
      if (this.controller === controller) this.controller = null
    }
  }

  /** The only legal gate for applying or cutting: this plan is still newest. */
  isCurrent(plan: OrganizerPlan | null | undefined): boolean {
    return plan !== null && plan !== undefined && plan.version === this.version
  }

  /** An explicit "打断" command wins over any organizer request in flight. */
  cancel(): void {
    this.version += 1
    this.controller?.abort()
    this.controller = null
    this.latest = null
  }

  last(): OrganizerPlan | null {
    return this.latest
  }

  private fallback(version: number, reason: string): OrganizerPlan {
    const plan: OrganizerPlan = { version, action: 'queue', reason }
    this.latest = plan
    return plan
  }
}
