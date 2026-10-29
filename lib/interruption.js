const DEFAULT_INTERRUPTION_MODE = "sentence";
function decideSpeechOnsetYield(mode, state) {
  if (mode === "never") return "ignore";
  if (!state.active || state.muted || state.cutting) return "ignore";
  if (!state.playing) return "ignore";
  return mode === "immediate" ? "pause" : "atBoundary";
}
function decideBoundaryHold(pending, point) {
  return pending && point === "sentence" ? "hold" : "continue";
}
function isInterruptionMode(value) {
  return value === "sentence" || value === "immediate" || value === "never";
}
function decideInterruption(mode, state) {
  if (mode === "never") return "keep";
  if (!state.active || state.muted || state.cutting) return "keep";
  if (!state.playing) return "keep";
  return mode === "immediate" ? "cut" : "drain";
}
export {
  DEFAULT_INTERRUPTION_MODE,
  decideBoundaryHold,
  decideInterruption,
  decideSpeechOnsetYield,
  isInterruptionMode
};
