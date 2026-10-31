/**
 * L2 切块层：在原始语料上切块。
 *
 * The input is the raw transcript stream (L1), never an assistant reply. A
 * chunk is the unit L3 reasons about: consecutive segments from the same
 * speaker inside the pause window become one chunk, and anything longer is a
 * new one.
 *
 * The defaults are deliberately conservative: with no options a single
 * utterance stays a single chunk, so wiring this in cannot change what the
 * listener hears. Splitting inside a chunk is opt-in.
 */

export type ChunkLane = 'owner' | 'guest'

export interface RawSegment {
  text: string
  /** Arrival time in milliseconds; gaps decide the boundaries. */
  at: number
  lane: ChunkLane
  /** Canonical voiceprint label, e.g. 我 / 客人1. */
  canonical: string
}

export interface RawChunk {
  lane: ChunkLane
  canonical: string
  /** Segments joined in arrival order. */
  text: string
  /** First and last arrival time of the segments in this chunk. */
  from: number
  to: number
  /** How many raw segments were merged into this chunk. */
  segments: number
}

export interface ChunkOptions {
  /** A gap longer than this starts a new chunk. Default 1500 ms. */
  pauseMs?: number
  /** Hard cap for one chunk; 0 or absent means no cap. */
  maxChars?: number
  /** Also split at sentence-final punctuation once the cap is reached. */
  splitOnPunctuation?: boolean
}

export const CHUNK_PAUSE_MS = 1500

const SENTENCE_END = /[。！？!?；;…]/u

export function chunkRawSegments(
  segments: readonly RawSegment[],
  options: ChunkOptions = {},
): RawChunk[] {
  const pauseMs = Math.max(0, Math.floor(options.pauseMs ?? CHUNK_PAUSE_MS))
  const maxChars = Math.max(0, Math.floor(options.maxChars ?? 0))
  const chunks: RawChunk[] = []
  let current: RawChunk | undefined

  const close = (): void => {
    if (!current) return
    current.text = current.text.trim()
    if (current.text.length > 0) chunks.push(current)
    current = undefined
  }

  const append = (segment: RawSegment, text: string): void => {
    if (!current) {
      current = { lane: segment.lane, canonical: segment.canonical, text, from: segment.at, to: segment.at, segments: 1 }
      return
    }
    current.text += text
    current.to = Math.max(current.to, segment.at)
    current.segments += 1
  }

  for (const segment of segments) {
    const text = typeof segment.text === 'string' ? segment.text : ''
    if (text.trim().length === 0) continue
    const startsNew = !current
      || current.lane !== segment.lane
      || current.canonical !== segment.canonical
      || segment.at - current.to > pauseMs
    if (startsNew) close()
    append(segment, text)

    if (maxChars > 0 && current && current.text.length > maxChars) {
      const full = current.text
      const cut = options.splitOnPunctuation ? full.search(SENTENCE_END) : -1
      if (cut > 0) {
        const head = full.slice(0, cut + 1).trim()
        const tail = full.slice(cut + 1).trim()
        const kept: RawChunk = current
        kept.text = head
        chunks.push(kept)
        current = undefined
        if (tail.length > 0) {
          current = {
            lane: kept.lane, canonical: kept.canonical, text: tail,
            from: segment.at, to: segment.at, segments: 1,
          }
        }
      }
    }
  }
  close()
  return chunks
}
