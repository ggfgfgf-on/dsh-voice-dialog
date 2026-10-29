function orderOf(frame) {
  const epoch = typeof frame.epoch === "number" ? frame.epoch : NaN;
  const seq = typeof frame.seq === "number" ? frame.seq : NaN;
  if (!Number.isFinite(epoch) || epoch < 0) return null;
  if (!Number.isFinite(seq) || seq < 0) return null;
  return { epoch: Math.trunc(epoch), seq: Math.trunc(seq) };
}
class FrameWindow {
  high = null;
  current() {
    return this.high === null ? null : { ...this.high };
  }
  /** Classify without mutating; call accept() for an accepted frame. */
  classify(order) {
    if (order === null) return "accept";
    const high = this.high;
    if (high === null) return "accept";
    if (order.epoch < high.epoch) return "stale-epoch";
    if (order.epoch > high.epoch) return "accept";
    if (order.seq < high.seq) return "stale-seq";
    if (order.seq === high.seq) return "duplicate";
    return "accept";
  }
  /** Remember an accepted frame; a lower key can never move the watermark back. */
  accept(order) {
    if (order === null) return;
    const high = this.high;
    if (high === null) {
      this.high = { ...order };
      return;
    }
    if (order.epoch > high.epoch) {
      this.high = { ...order };
      return;
    }
    if (order.epoch === high.epoch && order.seq > high.seq) this.high = { ...order };
  }
  /** Only a different session clears the watermark; stop/cut must not. */
  reset() {
    this.high = null;
  }
}
function shouldPlayFrame(state) {
  return playBlockReason(state) === void 0;
}
function playBlockReason(state) {
  if (state.muted) return "muted";
  if (!state.autoRead) return "autoread-off";
  if (state.frameOwner !== void 0 && state.frameOwner !== state.clientId) return "not-owner";
  const elected = state.frameOwner !== void 0 && state.frameOwner === state.clientId;
  if (!state.active && !elected) return "inactive";
  if (state.tabSession !== void 0 && state.frameSession !== state.tabSession) {
    return "other-session:" + state.tabSession + "!=" + state.frameSession;
  }
  return void 0;
}
export {
  FrameWindow,
  orderOf,
  playBlockReason,
  shouldPlayFrame
};
