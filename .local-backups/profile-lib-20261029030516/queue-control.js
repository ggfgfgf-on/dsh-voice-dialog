const SPEAKER_PREFIX = /^\s*(?:\[声纹：[^\]]*\]\s*)+/u;
function stripVoicePrefix(text) {
  return text.replace(SPEAKER_PREFIX, "").trim();
}
function cleanTarget(raw) {
  const target = raw.replace(/^[\s，,。.!！？?、]+/u, "").replace(/[。！？!?，,、\s]+$/u, "").trim();
  if (target === "\u4E00\u4E0B" || target === "\u5427" || target === "\u554A") return "";
  if (target === "\u6240\u6709" || target === "\u6240\u6709\u4EBA" || target === "\u5168\u90E8" || target === "\u5168\u90E8\u4EBA" || target === "\u5927\u5BB6" || target === "\u90FD") return "*";
  return target;
}
function parseQueueControl(raw) {
  const text = stripVoicePrefix(raw);
  if (!text || text.length > 60) return null;
  const restore = text.match(/^(?:请)?(?:恢复|别忽略|不要忽略|继续听|让他说|让她说)\s*(.*)$/u);
  if (restore) {
    return { action: "speaker", target: cleanTarget(restore[1] ?? "") || "*", policy: "queue" };
  }
  const interrupt = text.match(
    /^(?:请)?(?:打断|插话|停一下|先停|别说了|闭嘴|安静|停下|停)(?:一下|吧|啊)?[，,。.!！\s]*(.*)$/u
  );
  if (interrupt) return { action: "interrupt", rest: (interrupt[1] ?? "").trim() };
  if (/^(?:先)?(?:别|不要|不用)(?:打断|插话|停|说)/u.test(text)) return null;
  const ignore = text.match(/^(?:请)?(?:忽略|别理|不要理|别管|不要管)\s*(.*)$/u);
  if (ignore) return { action: "speaker", target: cleanTarget(ignore[1] ?? ""), policy: "ignore" };
  return null;
}
export {
  parseQueueControl,
  stripVoicePrefix
};
