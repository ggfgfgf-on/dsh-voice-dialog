/**
 * Early start: planning from speech the listener has not finished yet.
 *
 * This module is the seam between the layers, not a new decision maker. It
 * records the unfinished corpus (L1), asks plan.ts for a provisional plan (L3)
 * and lets the fast lane run only the part that can still be withdrawn (L4).
 * When the corpus closes, confirmPlan says whether the provisional plan holds:
 *
 *   confirmed -> keep it, nothing is repeated
 *   rejected / topic-shift / shape-changed -> supersede every provisional item
 *   that has not started speaking, and let the caller run the replacement
 *
 * Nothing here can pull back a sound that has already been played: the lanes
 * withdraw delayed or queued items only. Off unless the profile declares
 * earlyStart: 'partial', so a declaration-free run never enters this path.
 */

import { confirmPlan, decidePartial, type PlanItem, type PlanState } from './plan.js'
import { createLanes, type Lanes } from './lanes.js'
import type { SpeechProfile } from './speech-profile.js'

/** True only when the model declared the partial path. */
export function earlyStartEnabled(profile?: Partial<SpeechProfile> | null): boolean {
  return !!profile && profile.earlyStart === 'partial'
}

export interface EarlyStartHandlers {
  /** L5 boundary: say a short line now. */
  speak: (text: string) => void
  enqueue?: (item: PlanItem) => void
  retract?: (item: PlanItem) => void
  hold?: (item: PlanItem) => void
  startFast?: () => void
  /** L1: record the unfinished corpus as a partial event. */
  record?: (text: string, meta: { lane: string; canonical?: string }) => void
  /** L1: record a provisional plan item; returns the plan-stream seq. */
  recordPlan?: (item: PlanItem) => number
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

export interface EarlySettleResult {
  confirmed: boolean
  reason: string
  /** The plan to run for the finished utterance. */
  items: PlanItem[]
  /** What had been planned from the unfinished corpus. */
  provisional: PlanItem[]
  /** Not-yet-spoken provisional items the lanes withdrew. */
  withdrawn: number
}

export interface EarlyStart {
  /** Feed unfinished speech; returns the provisional items it planned. */
  partial(chunks: readonly string[], state: PlanState): PlanItem[]
  /** The corpus closed: keep the plan or withdraw it. */
  settle(finalText: string, state: PlanState): EarlySettleResult
  /** The provisional plan currently on the table. */
  provisional(): readonly PlanItem[]
  dispose(): void
}

export function createEarlyStart(handlers: EarlyStartHandlers): EarlyStart {
  const lanes: Lanes = createLanes({
    speak: handlers.speak,
    enqueue: handlers.enqueue ?? ((): void => {}),
    ...(handlers.hold ? { hold: handlers.hold } : {}),
    ...(handlers.startFast ? { startFast: handlers.startFast } : {}),
    ...(handlers.retract ? { retract: handlers.retract } : {}),
    ...(handlers.setTimer ? { setTimer: handlers.setTimer } : {}),
    ...(handlers.clearTimer ? { clearTimer: handlers.clearTimer } : {}),
  })
  let current: PlanItem[] = []
  let corpus = ''

  return {
    partial(chunks, state) {
      const spoken = chunks.map((chunk) => chunk.trim()).filter((chunk) => chunk.length > 0)
      if (spoken.length === 0) return current
      corpus = spoken.join('，')
      handlers.record?.(corpus, {
        lane: state.lane,
        ...(state.canonical ? { canonical: state.canonical } : {}),
      })
      current = decidePartial(spoken, state).map((item) => {
        const seq = handlers.recordPlan?.(item)
        return typeof seq === 'number' ? { ...item, seq } : item
      })
      // Only the withdrawable part runs early: the fast lane, never the slow
      // answer queue (the finished utterance produces that exactly once).
      lanes.execute(current.filter((item) => item.lane === 'fast' || item.kind === 'ack'))
      return current
    },
    settle(finalText, state) {
      const result = confirmPlan(current, finalText, state, corpus)
      let withdrawn = 0
      if (!result.confirmed) {
        for (const item of current) {
          if (typeof item.seq === 'number') withdrawn += lanes.supersede(item.seq)
        }
      }
      const provisional = current
      current = []
      corpus = ''
      return {
        confirmed: result.confirmed, reason: result.reason,
        items: result.items, provisional, withdrawn,
      }
    },
    provisional() {
      return current
    },
    dispose() {
      lanes.dispose()
    },
  }
}
