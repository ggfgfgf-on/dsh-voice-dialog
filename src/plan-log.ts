/**
 * Host sink for the L3 plan stream: one JSON line per plan item.
 *
 * The record stream (L1) already stores what was heard; this one stores what
 * was decided, so a delivery can be replayed instead of guessed at. Only the
 * fields a replay needs survive the whitelist, and the text is a摘要: 40
 * characters, never a whole paragraph.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { appendFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** `%TEMP%\\dsh-voice-plan.jsonl` on Windows. */
export const PLAN_LOG_PATH = join(tmpdir(), 'dsh-voice-plan.jsonl')
const MAX_BYTES = 512 * 1024
const MAX_ITEMS = 40
/** A replay needs the shape, not the paragraph. */
export const PLAN_TEXT_LIMIT = 40

export type PlanItemKind = 'reply' | 'ack' | 'hold' | 'ignore' | 'custom'
export type PlanItemLane = 'fast' | 'slow' | 'owner' | 'guest'

const KINDS: readonly string[] = ['reply', 'ack', 'hold', 'ignore', 'custom']
const LANES: readonly string[] = ['fast', 'slow', 'owner', 'guest']

export interface PlanLogItem {
  sessionId: string
  replyId: string
  seq: number
  at: number
  kind: PlanItemKind
  lane: PlanItemLane
  priority: number
  delayMs: number
  text: string
  reason: string
  source: string
}

const shortString = (value: unknown, limit: number): string =>
  typeof value === 'string' ? value.trim().slice(0, limit) : ''

const finiteInt = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback

/** Keep only the agreed fields; anything else is dropped unread. */
export function sanitizePlanItem(raw: unknown): PlanLogItem | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const kind = typeof record.kind === 'string' && KINDS.includes(record.kind) ? record.kind : ''
  const lane = typeof record.lane === 'string' && LANES.includes(record.lane) ? record.lane : ''
  if (!kind || !lane) return null
  const at = finiteInt(record.at, Date.now())
  return {
    sessionId: shortString(record.sessionId, 64),
    replyId: shortString(record.replyId, 64),
    seq: Math.max(0, finiteInt(record.seq)),
    at,
    kind: kind as PlanItemKind,
    lane: lane as PlanItemLane,
    priority: finiteInt(record.priority),
    delayMs: Math.max(0, finiteInt(record.delayMs)),
    text: shortString(record.text, PLAN_TEXT_LIMIT),
    reason: shortString(record.reason, 40),
    source: shortString(record.source, 24),
  }
}

/** Append one plan item. A lost line must never break a delivery. */
export function appendPlanLog(item: PlanLogItem): void {
  try {
    let size = 0
    try { size = statSync(PLAN_LOG_PATH).size } catch { size = 0 }
    // Bounded file: a long session must not fill the temp directory.
    if (size > MAX_BYTES) writeFileSync(PLAN_LOG_PATH, '')
    appendFileSync(PLAN_LOG_PATH, JSON.stringify(item) + '\n')
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

const planLogHandler = async (req: unknown, res: ServerResponse): Promise<void> => {
  try {
    const body = await readBody(req as IncomingMessage, 64 * 1024)
    const rows = Array.isArray((body as { items?: unknown })?.items)
      ? ((body as { items: unknown[] }).items)
      : [body]
    for (const row of rows.slice(0, MAX_ITEMS)) {
      const item = sanitizePlanItem(row)
      if (item) appendPlanLog(item)
    }
  } catch { /* a malformed batch is dropped, never surfaced */ }
  res.statusCode = 200
  res.setHeader('content-type', 'application/json')
  res.end('{"ok":true}')
}

export const PLAN_LOG_ROUTES: Array<[string, (req: unknown, res: ServerResponse) => void | Promise<void>]> = [
  ['/plan-log', planLogHandler],
]
