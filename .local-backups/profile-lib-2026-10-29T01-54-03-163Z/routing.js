function shouldUseOptimisticFastPath(state, enabled = true) {
  if (!enabled) return false;
  if (state.playing) return false;
  if (!Number.isFinite(state.queued) || state.queued > 0) return false;
  if (!Number.isFinite(state.active) || state.active > 0) return false;
  return true;
}
function shouldCallGate(state, _imperative) {
  return state.playing === true;
}
function resolveOptimisticVerdict(input) {
  const action = typeof input.action === "string" ? input.action.trim().toLowerCase() : "";
  if (action === "interrupt") return "steer";
  if (action === "drop" || action === "ignore") return input.started ? "keep" : "retract";
  return "keep";
}
function isSingleActiveSource(rmsValues, floor = 4e-3) {
  const values = rmsValues.map((value) => Number.isFinite(value) && value > 0 ? value : 0).filter((value) => value >= floor);
  if (values.length <= 1) return true;
  const loudest = Math.max(...values);
  const rest = values.filter((value) => value !== loudest);
  return rest.every((value) => value < loudest * 0.35);
}
function canReuseSpeculativeAsr(laneSamples, mixedSamples, toleranceSamples = 1600) {
  if (!Number.isFinite(laneSamples) || !Number.isFinite(mixedSamples)) return false;
  if (laneSamples <= 0 || mixedSamples <= 0) return false;
  return Math.abs(laneSamples - mixedSamples) <= Math.max(toleranceSamples, laneSamples * 0.1);
}
function firstDelivery(seen, id) {
  if (!id) return true;
  if (seen.has(id)) return false;
  seen.add(id);
  return true;
}
function routeNowPlanLater(hooks) {
  const entry = hooks.enqueue();
  void hooks.plan().then((plan) => {
    if (!plan) return;
    const verdict = resolveOptimisticVerdict({ action: plan.action, started: entry.started() });
    if (verdict === "retract") entry.drop();
    else if (verdict === "steer") {
      hooks.cut();
      entry.setMode("steer");
    }
  }).catch(() => void 0);
  return entry;
}
export {
  canReuseSpeculativeAsr,
  firstDelivery,
  isSingleActiveSource,
  resolveOptimisticVerdict,
  routeNowPlanLater,
  shouldCallGate,
  shouldUseOptimisticFastPath
};
