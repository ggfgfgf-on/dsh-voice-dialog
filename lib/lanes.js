function orderPlan(items) {
  return items.map((item, index) => ({ item, index })).sort((left, right) => {
    const a = typeof left.item.priority === "number" ? left.item.priority : 0;
    const b = typeof right.item.priority === "number" ? right.item.priority : 0;
    return a === b ? left.index - right.index : a - b;
  }).map((entry) => entry.item);
}
function createLanes(handlers) {
  const timers = /* @__PURE__ */ new Set();
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
  return {
    execute(items) {
      const result = { executed: 0, ignored: 0, held: 0, acked: 0 };
      for (const item of orderPlan(items)) {
        if (!item || typeof item !== "object") continue;
        if (item.kind === "ignore") {
          result.ignored += 1;
          continue;
        }
        if (item.kind === "hold") {
          result.held += 1;
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
            const timer = setTimer(() => {
              timers.delete(timer);
              run();
            }, delay);
            timers.add(timer);
          }
          result.acked += 1;
          result.executed += 1;
          continue;
        }
        if (item.lane === "fast") speakItem(item);
        else handlers.enqueue(item);
        result.executed += 1;
      }
      return result;
    },
    dispose() {
      for (const timer of timers) clearTimer(timer);
      timers.clear();
    },
    pending() {
      return timers.size;
    }
  };
}
export {
  createLanes,
  orderPlan
};
