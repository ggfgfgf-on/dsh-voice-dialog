/**
 * Output arrangement (慢判层的本职): decide what the assistant says first, what
 * it skips, and never invent new content. The model may propose a plan; these
 * pure rules are the deterministic fallback and the validator, so a bad model
 * answer can never drop a sentence that was not explicitly background.
 */

export interface Arrangement {
  /** Sentence indices in speaking order (every non-dropped index exactly once). */
  order: number[]
  /** Sentence indices to skip; always a subset of the input. */
  dropped: number[]
  reason: string
}

const CONCLUSION = /结论|总之|所以|核心(是|就)|一句话|总结|答案(是|就)/
const BACKGROUND = /背景|铺垫|来龙去脉|先说说|顺便说|前情|历史原因/
const CONCLUSION_FIRST = /先(说|讲|给)?结论|结论先|直接(说|讲|给)?结论|先说答案|先说重点|先讲结果/
const DROP_BACKGROUND = /别(讲|说|提)?背景|不要背景|背景(跳过|略过|不用|别讲)|不用(讲)?铺垫|省略背景|略过铺垫/

function normalize(text: string): string {
  return String(text ?? '').replace(/\s+/gu, ' ').trim()
}

/** True when any line looks like the conclusion/answer sentence. */
function conclusionIndices(lines: readonly string[]): number[] {
  const found: number[] = []
  lines.forEach((line, index) => { if (CONCLUSION.test(normalize(line))) found.push(index) })
  return found
}

/**
 * Deterministic arrangement for one new user line. Only reorders and drops
 * background sentences that the user asked to skip; every other sentence is
 * kept exactly once.
 */
export function planOutputOrder(lines: readonly string[], utterance: string): Arrangement {
  const total = lines.length
  const unchanged: Arrangement = {
    order: lines.map((_, index) => index),
    dropped: [],
    reason: 'unchanged',
  }
  if (total < 2) return unchanged
  const said = normalize(utterance)
  const wantsConclusionFirst = CONCLUSION_FIRST.test(said)
  const wantsNoBackground = DROP_BACKGROUND.test(said)
  if (!wantsConclusionFirst && !wantsNoBackground) return unchanged

  const conclusions = conclusionIndices(lines)
  const dropped: number[] = []
  if (wantsNoBackground) {
    const maxDrops = Math.max(0, Math.min(total - 2, Math.floor(total * 0.6)))
    for (let index = 1; index < total && dropped.length < maxDrops; index += 1) {
      // applyReorganization never drops index 0 (it may be playing already).
      if (conclusions.includes(index)) continue
      if (BACKGROUND.test(normalize(lines[index] ?? ''))) dropped.push(index)
    }
  }
  const order: number[] = []
  const push = (index: number): void => {
    if (index < 0 || index >= total) return
    if (dropped.includes(index) || order.includes(index)) return
    order.push(index)
  }
  if (wantsConclusionFirst) for (const index of conclusions) push(index)
  for (let index = 0; index < total; index += 1) push(index)
  const changed = order.some((value, index) => value !== index) || dropped.length > 0
  return changed ? { order, dropped, reason: 'rule' } : unchanged
}

/**
 * Validate a proposed arrangement against the sentences actually shown to the
 * model: out-of-range or duplicated indices are dropped, every index that was
 * not dropped reappears exactly once, and no new content can be introduced
 * because only indices survive.
 */
export function sanitizeArrangement(
  lineCount: number,
  order: readonly unknown[] = [],
  dropped: readonly unknown[] = [],
): Arrangement {
  const total = Math.max(0, Math.floor(lineCount))
  const valid = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < total
  const dropSet = new Set<number>()
  for (const value of dropped) if (valid(value)) dropSet.add(Math.trunc(value))
  if (total > 0 && dropSet.size >= total) dropSet.delete(Math.max(...dropSet))
  const result: number[] = []
  for (const value of order) {
    if (!valid(value)) continue
    const index = Math.trunc(value)
    if (dropSet.has(index) || result.includes(index)) continue
    result.push(index)
  }
  for (let index = 0; index < total; index += 1) {
    if (dropSet.has(index) || result.includes(index)) continue
    result.push(index)
  }
  return { order: result, dropped: [...dropSet].sort((a, b) => a - b), reason: 'sanitized' }
}

/** True when the arrangement changes what the listener hears. */
export function arrangementChanged(plan: Arrangement): boolean {
  if (plan.dropped.length > 0) return true
  return plan.order.some((value, index) => value !== index)
}

export const ARRANGE_MAX_DROP_RATIO = 0.6
