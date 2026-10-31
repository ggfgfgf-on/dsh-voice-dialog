/**
 * Host sink for the L1 record stream: one JSON line per event the page records.
 *
 * The plan stream stores what was decided; this one stores what was heard, so
 * the two streams are symmetric and a session can be replayed from disk instead
 * of from a tab that is still open. Only the fields a replay needs survive the
 * whitelist, and the text is a摘要: 40 characters, never a whole paragraph.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { appendFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** `%TEMP%\\dsh-voice-record.jsonl` on Windows. */
export const RECORD_LOG_PATH = join(tmpdir(), 'dsh-voice-record.jsonl')
const MAX_BYTES = 512 * 1024
const MAX_ITEMS = 64
/** A replay needs the shape, not the paragraph. */
export const RECORD_TEXT_LIMIT = 40
/** How long a speaker label may be; beyond it the field is a transcript. */
export const RECORD_LABEL_LIMIT = 24

export type RecordLogKind =
  | 'transcript'
  | 'partial'
  | 'voiceprint'
  | 'barge-in'
  | 'playback'
  | 'reply'
  | 'plan'
  | 'custom'

const KINDS: readonly string[] = [
  'transcript', 'partial', 'voiceprint', 'barge-in', 'playback', 'reply', 'plan', 'custom',
]
const LANES: readonly string[] = ['owner', 'guest', 'fast', 'slow', '']

export interface RecordLogItem {
  sessionId: string
  seq: number
  at: number
  kind: RecordLogKind
  lane: string
  canonical: string
  text: string
  reason: string
}

const shortString = (value: unknown, limit: number): string =>
  typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, limit) : ''

const finiteInt = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback

/**
 * Keep only the agreed fields; anything else is dropped unread. Audio, raw
 * samples, model prompts and unfiltered transcript are never fields here.
 */
export function sanitizeRecordEvent(raw: unknown, sessionId = ''): RecordLogItem | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const kind = typeof record.kind === 'string' && KINDS.includes(record.kind) ? record.kind : ''
  if (!kind) return null
  const lane = typeof record.lane === 'string' && LANES.includes(record.lane) ? record.lane : ''
  return {
    sessionId: shortString(record.sessionId, 64) || shortString(sessionId, 64),
    seq: Math.max(0, finiteInt(record.seq)),
    at: finiteInt(record.at, Date.now()),
    kind: kind as RecordLogKind,
    lane,
    canonical: shortString(record.canonical, RECORD_LABEL_LIMIT),
    text: shortString(record.text, RECORD_TEXT_LIMIT),
    reason: shortString(record.reason, 40),
  }
}

/** Append one record event. A lost line must never break a delivery. */
export function appendRecordLog(item: RecordLogItem): void {
  try {
    let size = 0
    try { size = statSync(RECORD_LOG_PATH).size } catch { size = 0 }
    // Bounded file: a long session must not fill the temp directory.
    if (size > MAX_BYTES) writeFileSync(RECORD_LOG_PATH, '')
    appendFileSync(RECORD_LOG_PATH, JSON.stringify(item) + '\n')
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

const recordLogHandler = async (req: unknown, res: ServerResponse): Promise<void> => {
  try {
    const body = await readBody(req as IncomingMessage, 64 * 1024)
    const sessionId = typeof (body as { sessionId?: unknown })?.sessionId === 'string'
      ? ((body as { sessionId: string }).sessionId)
      : ''
    const rows = Array.isArray((body as { items?: unknown })?.items)
      ? ((body as { items: unknown[] }).items)
      : [body]
    for (const row of rows.slice(0, MAX_ITEMS)) {
      const item = sanitizeRecordEvent(row, sessionId)
      if (item) appendRecordLog(item)
    }
  } catch { /* a malformed batch is dropped, never surfaced */ }
  res.statusCode = 200
  res.setHeader('content-type', 'application/json')
  res.end('{"ok":true}')
}

export const RECORD_LOG_ROUTES: Array<[string, (req: unknown, res: ServerResponse) => void | Promise<void>]> = [
  ['/record-log', recordLogHandler],
]
