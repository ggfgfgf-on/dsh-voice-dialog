/** Decide which LLM traffic may reach text-to-speech. */

export interface SpeakableRequest {
  readonly sessionId?: string
  readonly purpose?: 'compaction' | 'session-title'
}

export interface SpeakableChunk {
  readonly type: string
  readonly text?: unknown
}

/**
 * Auxiliary model calls (compaction and session titles) carry a purpose and
 * must never be spoken. Reasoning and tool-argument chunks are filtered by
 * {@link isSpeakableChunk}; only visible assistant text is read.
 */
export function shouldSpeak(options: SpeakableRequest, enabled: boolean): boolean {
  return enabled && options.sessionId !== undefined && options.purpose === undefined
}

/** True only for non-empty visible text deltas. */
export function isSpeakableChunk(chunk: SpeakableChunk): chunk is SpeakableChunk & { type: 'text-delta'; text: string } {
  return chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text.length > 0
}
