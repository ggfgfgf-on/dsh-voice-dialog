/** Owner voice commands that operate on the pending queue, not on the model. */

export type QueueControl =
  | { action: 'interrupt'; rest: string }
  | { action: 'speaker'; target: string; policy: 'ignore' | 'queue' | 'steer' }

const SPEAKER_PREFIX = /^\s*(?:\[声纹：[^\]]*\]\s*)+/u

/** Remove one or more [声纹：...] prefixes added before transcription. */
export function stripVoicePrefix(text: string): string {
  return text.replace(SPEAKER_PREFIX, '').trim()
}

function cleanTarget(raw: string): string {
  const target = raw
    .replace(/^[\s，,。.!！？?、]+/u, '')
    .replace(/[。！？!?，,、\s]+$/u, '')
    .trim()
  if (target === '一下' || target === '吧' || target === '啊') return ''
  if (target === '所有' || target === '所有人' || target === '全部' || target === '全部人' || target === '大家' || target === '都') return '*'
  return target
}

/**
 * Parse an explicit queue command. Only short, leading commands qualify, so a
 * normal sentence that merely contains "打断" is not hijacked.
 */
export function parseQueueControl(raw: string): QueueControl | null {
  const text = stripVoicePrefix(raw)
  if (!text || text.length > 60) return null

  // Restore first: "别忽略" starts with "别" but means the opposite of ignore.
  const restore = text.match(/^(?:请)?(?:恢复|别忽略|不要忽略|继续听|让他说|让她说)\s*(.*)$/u)
  if (restore) {
    return { action: 'speaker', target: cleanTarget(restore[1] ?? '') || '*', policy: 'queue' }
  }

  const interrupt = text.match(
    /^(?:请)?(?:打断|插话|停一下|先停|别说了|闭嘴|安静|停下|停)(?:一下|吧|啊)?[，,。.!！\s]*(.*)$/u,
  )
  if (interrupt) return { action: 'interrupt', rest: (interrupt[1] ?? '').trim() }

  // "不要打断" and "别停" are requests to keep going, not commands.
  if (/^(?:先)?(?:别|不要|不用)(?:打断|插话|停|说)/u.test(text)) return null

  const ignore = text.match(/^(?:请)?(?:忽略|别理|不要理|别管|不要管)\s*(.*)$/u)
  if (ignore) return { action: 'speaker', target: cleanTarget(ignore[1] ?? ''), policy: 'ignore' }

  return null
}
