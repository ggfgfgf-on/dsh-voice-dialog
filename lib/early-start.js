import { confirmPlan, decidePartial } from "./plan.js";
import { createLanes } from "./lanes.js";
function earlyStartEnabled(profile) {
  return !!profile && profile.earlyStart === "partial";
}
function createEarlyStart(handlers) {
  const lanes = createLanes({
    speak: handlers.speak,
    enqueue: handlers.enqueue ?? (() => {
    }),
    ...handlers.hold ? { hold: handlers.hold } : {},
    ...handlers.startFast ? { startFast: handlers.startFast } : {},
    ...handlers.retract ? { retract: handlers.retract } : {},
    ...handlers.setTimer ? { setTimer: handlers.setTimer } : {},
    ...handlers.clearTimer ? { clearTimer: handlers.clearTimer } : {}
  });
  let current = [];
  let corpus = "";
  return {
    partial(chunks, state) {
      const spoken = chunks.map((chunk) => chunk.trim()).filter((chunk) => chunk.length > 0);
      if (spoken.length === 0) return current;
      corpus = spoken.join("\uFF0C");
      handlers.record?.(corpus, {
        lane: state.lane,
        ...state.canonical ? { canonical: state.canonical } : {}
      });
      current = decidePartial(spoken, state).map((item) => {
        const seq = handlers.recordPlan?.(item);
        return typeof seq === "number" ? { ...item, seq } : item;
      });
      lanes.execute(current.filter((item) => item.lane === "fast" || item.kind === "ack"));
      return current;
    },
    settle(finalText, state) {
      const result = confirmPlan(current, finalText, state, corpus);
      let withdrawn = 0;
      if (!result.confirmed) {
        for (const item of current) {
          if (typeof item.seq === "number") withdrawn += lanes.supersede(item.seq);
        }
      }
      const provisional = current;
      current = [];
      corpus = "";
      return {
        confirmed: result.confirmed,
        reason: result.reason,
        items: result.items,
        provisional,
        withdrawn
      };
    },
    provisional() {
      return current;
    },
    dispose() {
      lanes.dispose();
    }
  };
}
export {
  createEarlyStart,
  earlyStartEnabled
};
