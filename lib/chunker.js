const CHUNK_PAUSE_MS = 1500;
const SENTENCE_END = /[。！？!?；;…]/u;
function chunkRawSegments(segments, options = {}) {
  const pauseMs = Math.max(0, Math.floor(options.pauseMs ?? CHUNK_PAUSE_MS));
  const maxChars = Math.max(0, Math.floor(options.maxChars ?? 0));
  const chunks = [];
  let current;
  const close = () => {
    if (!current) return;
    current.text = current.text.trim();
    if (current.text.length > 0) chunks.push(current);
    current = void 0;
  };
  const append = (segment, text) => {
    if (!current) {
      current = { lane: segment.lane, canonical: segment.canonical, text, from: segment.at, to: segment.at, segments: 1 };
      return;
    }
    current.text += text;
    current.to = Math.max(current.to, segment.at);
    current.segments += 1;
  };
  for (const segment of segments) {
    const text = typeof segment.text === "string" ? segment.text : "";
    if (text.trim().length === 0) continue;
    const startsNew = !current || current.lane !== segment.lane || current.canonical !== segment.canonical || segment.at - current.to > pauseMs;
    if (startsNew) close();
    append(segment, text);
    if (maxChars > 0 && current && current.text.length > maxChars) {
      const full = current.text;
      const cut = options.splitOnPunctuation ? full.search(SENTENCE_END) : -1;
      if (cut > 0) {
        const head = full.slice(0, cut + 1).trim();
        const tail = full.slice(cut + 1).trim();
        const kept = current;
        kept.text = head;
        chunks.push(kept);
        current = void 0;
        if (tail.length > 0) {
          current = {
            lane: kept.lane,
            canonical: kept.canonical,
            text: tail,
            from: segment.at,
            to: segment.at,
            segments: 1
          };
        }
      }
    }
  }
  close();
  return chunks;
}
export {
  CHUNK_PAUSE_MS,
  chunkRawSegments
};
