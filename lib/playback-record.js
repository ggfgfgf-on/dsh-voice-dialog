const PHASES = ["idle", "playing", "paused"];
function playbackTransition(previous, next) {
  if (typeof next !== "string" || !PHASES.includes(next)) return null;
  const phase = next;
  return { phase, changed: previous !== phase };
}
function createPlaybackRecorder(stream) {
  const last = /* @__PURE__ */ new Map();
  return {
    note(sessionId, phase, fields) {
      const key = typeof sessionId === "string" ? sessionId : "";
      const transition = playbackTransition(last.get(key), phase);
      if (!transition) return false;
      last.set(key, transition.phase);
      if (!transition.changed) return false;
      try {
        stream.append("playback", { sessionId: key, phase: transition.phase, ...fields ?? {} });
      } catch {
      }
      return true;
    },
    lastPhase(sessionId) {
      return last.get(typeof sessionId === "string" ? sessionId : "");
    },
    reset(sessionId) {
      if (sessionId === void 0) last.clear();
      else last.delete(sessionId);
    }
  };
}
export {
  createPlaybackRecorder,
  playbackTransition
};
