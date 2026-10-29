/** Host sink for playback-gain samples: one JSON line each, audio never stored. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { appendFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** `%TEMP%\\dsh-voice-volume.jsonl` on Windows. */
export const VOLUME_LOG_PATH = join(tmpdir(), 'dsh-voice-volume.jsonl')
const MAX_BYTES = 512 * 1024
const MAX_SAMPLES = 60
const EVENTS = new Set(['apply', 'duck', 'restore', 'cut', 'begin', 'override'])

export interface VolumeSample {
  at: number
  event: string
  ducked: boolean
  target: number
  actual: number
  volumeOverride: number | null
  prefsVolume: number
  duckLevel: number
  suppressed: boolean
}

const clamp01 = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null

/** Keep only the agreed numeric fields; anything else is dropped unread. */
export function sanitizeVolumeSample(raw: unknown): VolumeSample | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const target = clamp01(record.target)
  const actual = clamp01(record.actual)
  if (target === null || actual === null) return null
  const event = typeof record.event === 'string' && EVENTS.has(record.event) ? record.event : 'apply'
  const at = typeof record.at === 'number' && Number.isFinite(record.at) ? Math.round(record.at) : Date.now()
  const override = record.volumeOverride === null || record.volumeOverride === undefined
    ? null
    : (clamp01(record.volumeOverride) ?? null)
  return {
    at,
    event,
    ducked: record.ducked === true,
    target,
    actual,
    volumeOverride: override,
    prefsVolume: clamp01(record.prefsVolume) ?? 0,
    duckLevel: clamp01(record.duckLevel) ?? 0,
    suppressed: record.suppressed === true,
  }
}

/** Append one sample. A lost sample must never break playback. */
export function appendVolumeLog(sample: VolumeSample): void {
  try {
    let size = 0
    try { size = statSync(VOLUME_LOG_PATH).size } catch { size = 0 }
    // Bounded file: an hour of barge-in traffic is enough to diagnose with.
    if (size > MAX_BYTES) writeFileSync(VOLUME_LOG_PATH, '')
    appendFileSync(VOLUME_LOG_PATH, JSON.stringify(sample) + '\n')
  } catch { /* logging is best-effort */ }
}

async function readBody(req: IncomingMessage, limit: number): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      try { resolve(JSON.parse(text || '{}')) } catch { resolve({}) }
    })
    req.on('error', reject)
  })
}

const volumeLogHandler = async (req: unknown, res: ServerResponse): Promise<void> => {
  try {
    const body = await readBody(req as IncomingMessage, 64 * 1024)
    const rows = Array.isArray((body as { samples?: unknown })?.samples)
      ? ((body as { samples: unknown[] }).samples)
      : [body]
    for (const row of rows.slice(0, MAX_SAMPLES)) {
      const sample = sanitizeVolumeSample(row)
      if (sample) appendVolumeLog(sample)
    }
  } catch { /* a malformed batch is dropped, never surfaced */ }
  res.statusCode = 200
  res.setHeader('content-type', 'application/json')
  res.end('{"ok":true}')
}

export const VOLUME_LOG_ROUTES: Array<[string, (req: unknown, res: ServerResponse) => void | Promise<void>]> = [
  ['/volume-log', volumeLogHandler],
]
