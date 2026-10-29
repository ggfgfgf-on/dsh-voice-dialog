/** Shared window geometry and source alignment for MossFormer2 separation. */

export const SEPARATION_SAMPLE_RATE = 16_000
export const SEPARATION_WINDOW = SEPARATION_SAMPLE_RATE * 4
export const SEPARATION_HOP = SEPARATION_SAMPLE_RATE * 3.5
export const SEPARATION_FADE = SEPARATION_SAMPLE_RATE * 0.5

export function zeroMeanCorrelation(a: Float32Array, b: Float32Array, offset = 0): number {
  const length = Math.min(a.length, b.length - offset)
  if (length < 32) return 0
  let meanA = 0
  let meanB = 0
  for (let i = 0; i < length; i++) { meanA += a[i]; meanB += b[offset + i] }
  meanA /= length
  meanB /= length
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < length; i++) {
    const x = a[i] - meanA
    const y = b[offset + i] - meanB
    dot += x * y
    normA += x * x
    normB += y * y
  }
  const denominator = Math.sqrt(normA * normB)
  return denominator > 1e-9 ? dot / denominator : 0
}

/** The model's output order is arbitrary per window; use the overlap to keep it stable. */
export function shouldSwap(
  previousA: Float32Array,
  previousB: Float32Array,
  currentA: Float32Array,
  currentB: Float32Array,
  overlap: number,
): boolean {
  const length = Math.min(overlap, SEPARATION_FADE * 2)
  if (length < 32) return false
  const previousOffset = SEPARATION_WINDOW - length
  const same = zeroMeanCorrelation(previousA.subarray(previousOffset), currentA, 0)
    + zeroMeanCorrelation(previousB.subarray(previousOffset), currentB, 0)
  const swapped = zeroMeanCorrelation(previousA.subarray(previousOffset), currentB, 0)
    + zeroMeanCorrelation(previousB.subarray(previousOffset), currentA, 0)
  return swapped > same + 0.02
}
