const DEFAULT_CAPACITY = 512;
const DEFAULT_FLUSH_MS = 250;
const DEFAULT_BATCH_MAX = 64;
function asRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const copy = {};
  for (const [key, field] of Object.entries(value)) {
    if (key === "seq" || key === "at" || key === "kind") continue;
    copy[key] = field;
  }
  return copy;
}
function createRecordStream(options = {}) {
  const capacity = Math.max(1, Math.floor(options.capacity ?? DEFAULT_CAPACITY));
  const flushMs = Math.max(0, Math.floor(options.flushMs ?? DEFAULT_FLUSH_MS));
  const batchMax = Math.max(1, Math.floor(options.batchMax ?? DEFAULT_BATCH_MAX));
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = options.clearTimer ?? ((timer2) => clearTimeout(timer2));
  const ring = [];
  const listeners = /* @__PURE__ */ new Set();
  let buffered = [];
  let timer;
  let seq = 0;
  let disposed = false;
  const flush = () => {
    if (timer !== void 0) {
      clearTimer(timer);
      timer = void 0;
    }
    if (buffered.length === 0) return;
    const batch = buffered;
    buffered = [];
    try {
      options.sink?.(batch);
    } catch (error) {
      try {
        options.onError?.(error);
      } catch {
      }
    }
  };
  const schedule = () => {
    if (timer !== void 0 || !options.sink) return;
    timer = setTimer(() => {
      timer = void 0;
      flush();
    }, flushMs);
    const handle = timer;
    if (handle && typeof handle.unref === "function") handle.unref();
  };
  return {
    append(kind, fields) {
      seq += 1;
      const event = { seq, at: now(), kind, ...asRecord(fields) };
      ring.push(event);
      if (ring.length > capacity) ring.splice(0, ring.length - capacity);
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch {
        }
      }
      if (options.sink && !disposed) {
        try {
          buffered.push(JSON.stringify(event));
        } catch {
        }
        if (buffered.length >= batchMax) flush();
        else schedule();
      }
      return event;
    },
    subscribe(listener) {
      if (typeof listener !== "function") return () => void 0;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    tail(count) {
      const size = typeof count === "number" && Number.isFinite(count) ? Math.max(0, Math.floor(count)) : ring.length;
      return size === 0 ? [] : ring.slice(Math.max(0, ring.length - size));
    },
    replay(fromSeq) {
      const from = typeof fromSeq === "number" && Number.isFinite(fromSeq) ? fromSeq : 0;
      return ring.filter((event) => event.seq >= from);
    },
    size() {
      return ring.length;
    },
    lastSeq() {
      return seq;
    },
    flush,
    dispose() {
      disposed = true;
      flush();
      listeners.clear();
    }
  };
}
export {
  createRecordStream
};
