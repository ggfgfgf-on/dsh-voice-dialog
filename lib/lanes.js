function orderPlan(items) {
  return items.map((item, index) => ({ item, index })).sort((left, right) => {
    const a = typeof left.item.priority === "number" ? left.item.priority : 0;
    const b = typeof right.item.priority === "number" ? right.item.priority : 0;
    return a === b ? left.index - right.index : a - b;
  }).map((entry) => entry.item);
}
function createLanes(handlers) {
  const timers = /* @__PURE__ */ new Set();
  const delayed = /* @__PURE__ */ new Map();
  const pendingItems = /* @__PURE__ */ new Map();
  const setTimer = handlers.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = handlers.clearTimer ?? ((timer) => clearTimeout(timer));
  const speakItem = (item) => {
    const text = typeof item.text === "string" ? item.text.trim() : "";
    if (text.length > 0) {
      handlers.speak(text);
      return;
    }
    handlers.startFast?.();
  };
  const forget = (seq) => {
    delayed.delete(seq);
    pendingItems.delete(seq);
  };
  const supersede = (seq) => {
    let withdrawn = 0;
    const timer = delayed.get(seq);
    if (timer !== void 0) {
      clearTimer(timer);
      timers.delete(timer);
      delayed.delete(seq);
      withdrawn += 1;
    }
    const item = pendingItems.get(seq);
    if (item) {
      pendingItems.delete(seq);
      try {
        handlers.retract?.(item);
      } catch {
      }
      withdrawn += 1;
    }
    return withdrawn;
  };
  return {
    execute(items) {
      const result = { executed: 0, ignored: 0, held: 0, acked: 0 };
      for (const item of orderPlan(items)) {
        if (!item || typeof item !== "object") continue;
        if (typeof item.supersedes === "number") supersede(item.supersedes);
        if (item.kind === "ignore") {
          result.ignored += 1;
          continue;
        }
        if (item.kind === "hold") {
          result.held += 1;
          if (typeof item.seq === "number") pendingItems.set(item.seq, item);
          handlers.hold?.(item);
          continue;
        }
        if (item.kind === "ack") {
          const delay = typeof item.delayMs === "number" && Number.isFinite(item.delayMs) ? Math.max(0, Math.round(item.delayMs)) : 0;
          const run = () => {
            speakItem(item);
          };
          if (delay === 0) run();
          else {
            const seq = typeof item.seq === "number" ? item.seq : void 0;
            const timer = setTimer(() => {
              timers.delete(timer);
              if (seq !== void 0) delayed.delete(seq);
              run();
            }, delay);
            timers.add(timer);
            if (seq !== void 0) delayed.set(seq, timer);
          }
          result.acked += 1;
          result.executed += 1;
          continue;
        }
        if (item.lane === "fast") speakItem(item);
        else {
          if (typeof item.seq === "number") pendingItems.set(item.seq, item);
          handlers.enqueue(item);
        }
        result.executed += 1;
      }
      return result;
    },
    supersede,
    dispose() {
      for (const timer of timers) clearTimer(timer);
      timers.clear();
      delayed.clear();
      pendingItems.clear();
    },
    pending() {
      return timers.size + pendingItems.size;
    }
  };
}
export {
  createLanes,
  orderPlan
};
