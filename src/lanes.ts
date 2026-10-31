/**
 * L4 快慢层：执行计划项，不做内容决策。
 *
 * A lane receives plan items and does exactly what they say: the fast lane
 * puts a short line out now (an acknowledgement the model wrote, or the servo
 * that keeps the wire fed), the slow lane hands the item to the reply queue.
 * Whether to speak at all, which lane, and when are already decided in plan.ts.
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

  return {
    execute(items) {
      const result: LaneResult = { executed: 0, ignored: 0, held: 0, acked: 0 }
      for (const item of orderPlan(items)) {
        if (!item || typeof item !== 'object') continue
        if (item.kind === 'ignore') {
          result.ignored += 1
          continue
        }
        if (item.kind === 'hold') {
          result.held += 1
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
            const timer = setTimer(() => {
              timers.delete(timer)
              run()
            }, delay)
            timers.add(timer)
          }
          result.acked += 1
          result.executed += 1
          continue
        }
        // kind === 'reply'
        if (item.lane === 'fast') speakItem(item)
        else handlers.enqueue(item)
        result.executed += 1
      }
      return result
    },
    dispose() {
      for (const timer of timers) clearTimer(timer)
      timers.clear()
    },
    pending() {
      return timers.size
    },
  }
}
