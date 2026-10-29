/** Session-scoped names and delivery policies for guest voiceprints. */
import type { GuestMode } from './scheduler.ts'

export type SpeakerPolicy = GuestMode | 'default'

export interface SpeakerControl {
  speaker?: unknown
  policy?: unknown
  name?: unknown
}

export const MAX_SPEAKER_NAME = 24

function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.trim()
  if (!name || name.length > MAX_SPEAKER_NAME) return null
  if (name === '我' || name === '*') return null
  if (/[\[\]\r\n]/.test(name)) return null
  return name
}

function cleanPolicy(value: unknown): SpeakerPolicy | undefined {
  return value === 'queue' || value === 'steer' || value === 'ignore' || value === 'default'
    ? value
    : undefined
}

/**
 * The host keeps canonical voiceprint labels such as 客人1. The model may
 * rename them for the conversation (for example 老婆) and can then address
 * the same person by either the canonical label or the new name.
 */
export class SpeakerPolicyStore {
  private readonly policies = new Map<string, Map<string, GuestMode>>()
  private readonly names = new Map<string, Map<string, string>>()
  private readonly aliases = new Map<string, Map<string, string>>()

  /** Apply a model-issued rename and/or policy. Returns whether anything changed. */
  apply(sessionId: string, control: SpeakerControl): boolean {
    const speaker = typeof control.speaker === 'string' ? control.speaker.trim() : ''
    if (!speaker || speaker === '我') return false
    const policy = cleanPolicy(control.policy)
    const name = cleanName(control.name)
    if (policy === undefined && name === null) return false
    if (speaker === '*' && name !== null) return false

    const canonical = speaker === '*' ? '*' : this.resolve(sessionId, speaker)
    if (canonical === '我') return false

    if (name !== null) {
      let byCanonical = this.names.get(sessionId)
      if (!byCanonical) {
        byCanonical = new Map()
        this.names.set(sessionId, byCanonical)
      }
      let byName = this.aliases.get(sessionId)
      if (!byName) {
        byName = new Map()
        this.aliases.set(sessionId, byName)
      }
      byCanonical.set(canonical, name)
      byName.set(name, canonical)
    }

    if (policy === 'default') {
      if (canonical === '*') {
        this.policies.delete(sessionId)
      } else {
        const byCanonical = this.policies.get(sessionId)
        byCanonical?.delete(canonical)
        if (byCanonical && byCanonical.size === 0) this.policies.delete(sessionId)
      }
    } else if (policy !== undefined) {
      let byCanonical = this.policies.get(sessionId)
      if (!byCanonical) {
        byCanonical = new Map()
        this.policies.set(sessionId, byCanonical)
      }
      byCanonical.set(canonical, policy)
    }
    return true
  }

  /** Resolve a display name back to the host's canonical label. */
  resolve(sessionId: string, label: string): string {
    const trimmed = label.trim()
    return this.aliases.get(sessionId)?.get(trimmed) ?? trimmed
  }

  /** Human/model-facing name for a canonical voiceprint label. */
  display(sessionId: string, label: string): string {
    const canonical = this.resolve(sessionId, label)
    return this.names.get(sessionId)?.get(canonical) ?? canonical
  }

  /** Effective guest policy for a label, falling back to the browser setting. */
  effective(sessionId: string, label: string, fallback: GuestMode): GuestMode {
    const canonical = this.resolve(sessionId, label)
    const byCanonical = this.policies.get(sessionId)
    if (byCanonical) {
      if (canonical && byCanonical.has(canonical)) return byCanonical.get(canonical)!
      if (byCanonical.has('*')) return byCanonical.get('*')!
    }
    return fallback
  }

  /** Whether this session has any model-issued name or policy. */
  hasCustomization(sessionId: string): boolean {
    return (this.policies.get(sessionId)?.size ?? 0) > 0 || (this.names.get(sessionId)?.size ?? 0) > 0
  }

  /** Drop everything for one conversation (used when a session is disposed). */
  clear(sessionId: string): void {
    this.policies.delete(sessionId)
    this.names.delete(sessionId)
    this.aliases.delete(sessionId)
  }
}
