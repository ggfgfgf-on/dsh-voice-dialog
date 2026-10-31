/**
 * L4 快慢层：执行计划项，不做内容决策。
 *
 * A lane receives plan items and does exactly what they say: the fast lane
 * puts a short line out now (an acknowledgement the model wrote, or the servo
 * that keeps the wire fed), the slow lane hands the item to the reply queue.
 * Whether to speak at all, which lane, and when are already decided in plan.ts.
 *
 * A provisional item (planned from speech the listener has not finished) may be
 * withdrawn before it starts: supersede() clears a delayed fast line and hands a
 * queued item back through retract(). It never touches a line that has already
 * been spoken — the semantics are "withdraw what has not been said yet", never
 * "take back a sound".
 */

import type { PlanItem } from './plan.js'

export interface LaneHandlers {
  /** Boundary to L5: hand text to the speaking layer. */
  speak: (text: string) => void
  /** Slow lane: the full answer goes through the normal queue. */
  enqueue(item: PlanItem): void
  /** Park an item without speaking; omitted means the item is just counted. */
  hold?(item: PlanItem): void
  /** Fast lane without text: start the servo that generates short lines. */
  startFast?(): void
  /** Take back an item that has not started speaking (a superseded provisional). */
  retract?(item: PlanItem): void
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

export interface LaneResult {
  executed: number
  ignored: number
  held: number
  acked: number
}

export interface Lanes {
  /** Run every item in plan order. Never throws. */
  execute(items: readonly PlanItem[]): LaneResult
  /** Withdraw the item with this plan-stream seq; returns how many were withdrawn. */
  supersede(seq: number): number
  /** Cancel pending fast timers (barge-in, new reply, silence). */
  dispose(): void
  pending(): number
}

/**
 * Lower priority runs first; an item without a priority keeps arrival order.
 * Array.prototype.sort is stable, so equal priorities stay in plan order.
 */
export function orderPlan(items: readonly PlanItem[]): PlanItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const a = typeof left.item.priority === 'number' ? left.item.priority : 0
      const b = typeof right.item.priority === 'number' ? right.item.priority : 0
      return a === b ? left.index - right.index : a - b
    })
    .map((entry) => entry.item)
}

export function createLanes(handlers: LaneHandlers): Lanes {
  const timers = new Set<ReturnType<typeof setTimeout>>()
  /** Delayed fast lines, by plan-stream seq, so they can still be withdrawn. */
  const delayed = new Map<number, ReturnType<typeof setTimeout>>()
  /** Items already handed to the queue or parked, by seq: not yet audible. */
  const pendingItems = new Map<number, PlanItem>()
  const setTimer = handlers.setTimer
    ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs))
  const clearTimer = handlers.clearTimer
    ?? ((timer: ReturnType<typeof setTimeout>) => clearTimeout(timer))

  const speakItem = (item: PlanItem): void => {
    const text = typeof item.text === 'string' ? item.text.trim() : ''
    if (text.length > 0) {
      handlers.speak(text)
      return
    }
    handlers.startFast?.()
  }

  const forget = (seq: number): void => {
    delayed.delete(seq)
    pendingItems.delete(seq)
  }

  /**
   * Withdraw everything that has not been spoken yet. A line the fast lane has
   * already emitted is not in these maps, so it can never be pulled back.
   */
  const supersede = (seq: number): number => {
    let withdrawn = 0
    const timer = delayed.get(seq)
    if (timer !== undefined) {
      clearTimer(timer)
      timers.delete(timer)
      delayed.delete(seq)
      withdrawn += 1
    }
    const item = pendingItems.get(seq)
    if (item) {
      pendingItems.delete(seq)
      try { handlers.retract?.(item) } catch { /* a retract failure must not break the lane */ }
      withdrawn += 1
    }
    return withdrawn
  }

  return {
    execute(items) {
      const result: LaneResult = { executed: 0, ignored: 0, held: 0, acked: 0 }
      for (const item of orderPlan(items)) {
        if (!item || typeof item !== 'object') continue
        // A replacement carries the seq it replaces: withdraw that one first.
        if (typeof item.supersedes === 'number') supersede(item.supersedes)
        if (item.kind === 'ignore') {
          result.ignored += 1
          continue
        }
        if (item.kind === 'hold') {
          result.held += 1
          if (typeof item.seq === 'number') pendingItems.set(item.seq, item)
          handlers.hold?.(item)
          continue
        }
        if (item.kind === 'ack') {
          const delay = typeof item.delayMs === 'number' && Number.isFinite(item.delayMs)
            ? Math.max(0, Math.round(item.delayMs))
            : 0
          const run = (): void => { speakItem(item) }
          if (delay === 0) run()
          else {
            const seq = typeof item.seq === 'number' ? item.seq : undefined
            const timer = setTimer(() => {
              timers.delete(timer)
              if (seq !== undefined) delayed.delete(seq)
              run()
            }, delay)
            timers.add(timer)
            if (seq !== undefined) delayed.set(seq, timer)
          }
          result.acked += 1
          result.executed += 1
          continue
        }
        // kind === 'reply'
        if (item.lane === 'fast') speakItem(item)
        else {
          if (typeof item.seq === 'number') pendingItems.set(item.seq, item)
          handlers.enqueue(item)
        }
        result.executed += 1
      }
      return result
    },
    supersede,
    dispose() {
      for (const timer of timers) clearTimer(timer)
      timers.clear()
      delayed.clear()
      pendingItems.clear()
    },
    pending() {
      return timers.size + pendingItems.size
    },
  }
}
