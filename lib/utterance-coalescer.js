const UTTERANCE_COALESCE_WINDOW_MS = 1500;
const keyOf = (lane, canonical) => lane + ":" + canonical;
function createUtteranceCoalescer(options) {
  const windowMs = Math.max(0, Math.floor(options.windowMs ?? UTTERANCE_COALESCE_WINDOW_MS));
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = options.clearTimer ?? ((timer2) => clearTimeout(timer2));
  const lastTextByKey = /* @__PURE__ */ new Map();
  const dedupeChainByKey = /* @__PURE__ */ new Map();
  let pending = null;
  let timer;
  const cancelTimer = () => {
    if (timer === void 0) return;
    clearTimer(timer);
    timer = void 0;
  };
  const buildBatch = (current) => {
    const key = keyOf(current.lane, current.canonical);
    const entries = current.entries.slice();
    const previousWork = dedupeChainByKey.get(key) ?? Promise.resolve();
    const text = previousWork.then(async () => {
      let previous = lastTextByKey.get(key) ?? "";
      let combined = "";
      for (const entry of entries) {
        let next = "";
        try {
          const value = await entry.text;
          if (typeof value === "string") next = value;
        } catch {
          continue;
        }
        const fresh = options.dedupeTranscript(previous, next);
        previous = next;
        if (fresh) combined += fresh;
      }
      lastTextByKey.set(key, previous);
      return combined;
    });
    dedupeChainByKey.set(key, text.then(() => void 0, () => void 0));
    return {
      lane: current.lane,
      canonical: current.canonical,
      text,
      entries
    };
  };
  const flush = () => {
    if (!pending) return;
    const current = pending;
    pending = null;
    cancelTimer();
    options.submit(buildBatch(current));
  };
  const schedule = () => {
    if (!pending) return;
    cancelTimer();
    const elapsed = Math.max(0, now() - pending.lastAt);
    const delayMs = Math.max(0, windowMs - elapsed);
    timer = setTimer(() => {
      timer = void 0;
      flush();
    }, delayMs);
  };
  return {
    append(entry) {
      const at = entry.at ?? now();
      if (pending) {
        const gapMs = Math.max(0, at - pending.lastAt);
        const keyChanged = pending.lane !== entry.lane || pending.canonical !== entry.canonical;
        if (keyChanged || gapMs > windowMs) flush();
      }
      if (!pending) {
        pending = { lane: entry.lane, canonical: entry.canonical, firstAt: at, lastAt: at, entries: [] };
      }
      pending.entries.push(entry);
      pending.lastAt = Math.max(pending.lastAt, at);
      schedule();
    },
    flushAll: flush,
    dispose() {
      pending = null;
      cancelTimer();
    }
  };
}
export {
  UTTERANCE_COALESCE_WINDOW_MS,
  createUtteranceCoalescer
};
