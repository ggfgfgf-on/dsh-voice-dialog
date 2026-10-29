/**
 * Strip model control markers from the visible assistant stream.
 *
 * The host tap sees text in arbitrary chunks, so a directive can be split
 * across chunks. The filter keeps only a suffix that could still grow into the
 * directive head; it never holds arbitrary prose.
 */
const DIRECTIVE_HEAD = '[[voice:'
const COMPLETE_DIRECTIVE = /\[\[\s*voice\s*[:：][\s\S]*?\]\]/giu

function partialMarkerAt(buffer: string): number {
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] !== '[') continue
    const tail = buffer.slice(i).toLowerCase().replace(/\uFF1A/g, ':').replace(/\s+/g, '')
    // Either the text can still grow into "[[voice:", or it already is a
    // directive head whose closing "]]" has not arrived yet.
    if (DIRECTIVE_HEAD.startsWith(tail) || tail.startsWith(DIRECTIVE_HEAD)) return i
  }
  return -1
}

export class VisibleVoiceFilter {
  private carry = ''

  push(text: string): string {
    let buffer = this.carry + (typeof text === 'string' ? text : '')
    this.carry = ''
    buffer = buffer.replace(COMPLETE_DIRECTIVE, '')
    const cut = partialMarkerAt(buffer)
    if (cut >= 0) {
      this.carry = buffer.slice(cut)
      buffer = buffer.slice(0, cut)
    }
    return buffer
  }

  /** Drop a trailing incomplete directive when the stream ends. */
  finish(): string {
    this.carry = ''
    return ''
  }
}
