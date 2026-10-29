/**
 * Batched, best-effort upload of gain samples to the host. Samples carry
 * numbers and enum names only, never transcript text or audio.
 */

export interface VolumeReportOptions {
  post(payload: unknown): void
  batchMs?: number
  maxBuffered?: number
  setTimer?(run: () => void, ms: number): unknown
  clearTimer?(handle: unknown): void
}

export interface VolumeReporter {
  report(sample: unknown): void
  flush(): void
  pending(): number
  dropped(): number
}

export function createVolumeReporter(options: VolumeReportOptions): VolumeReporter {
  const batchMs = options.batchMs ?? 300
  const maxBuffered = options.maxBuffered ?? 240
  const setTimer = options.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms))
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  let buffer: unknown[] = []
  let timer: unknown
  let dropped = 0

  const flush = (): void => {
    if (timer !== undefined) {
      const handle = timer
      timer = undefined
      clearTimer(handle)
    }
    if (buffer.length === 0) return
    const samples = buffer
    buffer = []
    try { options.post({ samples }) } catch { /* a lost sample is fine */ }
  }

  const report = (sample: unknown): void => {
    if (buffer.length >= maxBuffered) {
      // Keep the newest: the state after a burst is the interesting one.
      buffer.shift()
      dropped += 1
    }
    buffer.push(sample)
    if (timer === undefined) timer = setTimer(flush, batchMs)
  }

  return { report, flush, pending: () => buffer.length, dropped: () => dropped }
}
