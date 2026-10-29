/** In-stream voice directives: the model decides what is spoken and how. */

export type VoiceCommand =
  | { action: 'say'; text: string }
  | { action: 'volume'; level?: number; delta?: number }
  | { action: 'rate'; rate?: number; delta?: number }
  | { action: 'repeat' }
  | { action: 'stop' }
  | { action: 'hold' }
  | { action: 'resume' }
  | { action: 'skip'; count: number }

const OPEN = /\[\[\s*voice\s*[:：]/i

/** Parse one marker body. Unknown/incomplete directives are ignored. */
export function parseVoiceCommand(raw: string): VoiceCommand | null {
  const text = raw.trim()
  if (text.length === 0) return null
  const lower = text.toLowerCase()
  if (lower === 'repeat' || lower === 'stop') return { action: lower }
  // The model holds the floor while the owner is still talking, then resumes.
  if (lower === 'hold' || lower === 'wait' || lower === 'pause' || lower === 'quiet') {
    return { action: 'hold' }
  }
  if (lower === 'resume' || lower === 'continue' || lower === 'go') return { action: 'resume' }
  const skip = /^skip\b([\s\S]*)$/i.exec(text)
  if (skip) {
    const raw = skip[1].trim().replace(/^[=:]\s*/, '')
    if (raw.length === 0) return { action: 'skip', count: 1 }
    const value = Number(raw)
    if (!Number.isFinite(value)) return { action: 'skip', count: 1 }
    return { action: 'skip', count: Math.max(1, Math.min(20, Math.floor(value))) }
  }
  const volume = /^volume\b([\s\S]*)$/i.exec(text)
  if (volume) {
    const argument = volume[1].trim().replace(/^[=:]\s*/, '')
    if (argument.toLowerCase() === 'up') return { action: 'volume', delta: 0.15 }
    if (argument.toLowerCase() === 'down') return { action: 'volume', delta: -0.15 }
    const value = Number(argument)
    if (!Number.isFinite(value)) return null
    const clamped = Math.max(-1, Math.min(1, value))
    if (argument.startsWith('+') || value < 0) return { action: 'volume', delta: clamped }
    return { action: 'volume', level: clamped }
  }
  const rate = /^rate\b([\s\S]*)$/i.exec(text)
  if (rate) {
    const argument = rate[1].trim().replace(/^[=:]\s*/, '').replace(/%$/, '')
    const word = argument.toLowerCase()
    if (word === 'up' || word === 'fast') return { action: 'rate', delta: 10 }
    if (word === 'down' || word === 'slow') return { action: 'rate', delta: -10 }
    const value = Number(argument)
    if (!Number.isFinite(value)) return null
    const clamped = Math.max(-50, Math.min(50, value))
    if (argument.startsWith('+') || value < 0) return { action: 'rate', delta: clamped }
    return { action: 'rate', rate: clamped }
  }
  return { action: 'say', text }
}

/** Incremental parser tolerant of markers split across reasoning deltas. */
export class VoiceProtocol {
  private buffer = ''

  feed(text: string): VoiceCommand[] {
    this.buffer += text
    const commands: VoiceCommand[] = []
    for (;;) {
      const match = OPEN.exec(this.buffer)
      if (match === null) {
        // Keep only a possible prefix of the opening token.
        this.buffer = this.buffer.slice(-16)
        break
      }
      const start = match.index
      const bodyStart = start + match[0].length
      const end = this.buffer.indexOf(']]', bodyStart)
      if (end < 0) {
        this.buffer = this.buffer.slice(start)
        break
      }
      const raw = this.buffer.slice(bodyStart, end)
      this.buffer = this.buffer.slice(end + 2)
      const command = parseVoiceCommand(raw)
      if (command !== null) commands.push(command)
    }
    return commands
  }

  flush(): void {
    this.buffer = ''
  }
}
