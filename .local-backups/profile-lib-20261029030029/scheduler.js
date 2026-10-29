import { parseQueueControl } from "./queue-control.js";
const NOOP_ENTRY = {
  seq: -1,
  setMode: () => void 0,
  drop: () => void 0,
  started: () => true
};
class SpeechScheduler {
  constructor(options) {
    this.options = options;
  }
  entries = [];
  nextSeq = 0;
  nextOrder = 0;
  active = 0;
  closed = false;
  draining = false;
  lastGuestLabel = "";
  controlChain = Promise.resolve();
  /** Start tracking one utterance whose text will arrive asynchronously. */
  enqueue(lane, label, work, enqueueOptions = {}) {
    if (this.closed) return NOOP_ENTRY;
    if (lane === "guest" && label) this.lastGuestLabel = label;
    const fallbackOrder = this.nextOrder++;
    const priority = typeof enqueueOptions.priority === "number" && Number.isFinite(enqueueOptions.priority) ? Math.trunc(enqueueOptions.priority) : void 0;
    const entry = {
      seq: this.nextSeq++,
      lane,
      label,
      ready: false,
      text: null,
      dropped: false,
      delivered: false,
      priority,
      order: typeof enqueueOptions.order === "number" && Number.isFinite(enqueueOptions.order) ? enqueueOptions.order : fallbackOrder,
      hold: enqueueOptions.hold,
      holdSettled: enqueueOptions.hold === void 0
    };
    this.entries.push(entry);
    this.active += 1;
    this.emit();
    void work.then((value) => {
      this.active = Math.max(0, this.active - 1);
      if (!this.entries.includes(entry)) {
        this.emit();
        return;
      }
      entry.ready = true;
      entry.text = typeof value === "string" && value.trim() ? value.trim() : null;
      if (entry.lane === "owner" && entry.text) {
        const control = parseQueueControl(entry.text);
        if (control) {
          entry.dropped = true;
          this.remove(entry);
          this.applyControl(control, entry);
          this.emit();
          this.drain();
          return;
        }
      }
      this.emit();
      this.drain();
    }, (error) => {
      this.active = Math.max(0, this.active - 1);
      entry.ready = true;
      entry.text = null;
      this.options.onError?.(error);
      this.emit();
      this.drain();
    });
    return {
      seq: entry.seq,
      setMode: (mode) => {
        this.setMode(entry, mode);
      },
      drop: () => {
        this.drop(entry);
      },
      started: () => entry.delivered
    };
  }
  /** Send every ready utterance in order. Retained for compatibility. */
  flushGuests() {
    this.drain();
  }
  /** Stop accepting work, but keep already captured utterances. */
  dispose() {
    this.closed = true;
    this.drain();
  }
  status() {
    return { active: this.active, queued: this.entries.length };
  }
  /**
   * Read-only FIFO view for the organizer: what is waiting, in which lane, and
   * in whose words. Never mutates or wakes the pump.
   */
  snapshot() {
    return this.entries.map((entry) => ({
      seq: entry.seq,
      id: entry.order,
      lane: entry.lane,
      text: entry.text ?? "",
      ready: entry.ready
    }));
  }
  /**
   * Apply a planner's queue adjudication. Only entries still waiting are
   * addressable: a started utterance can no longer be dropped here, it can only
   * be faded out by an interrupt. Unknown/duplicate ids are ignored, never
   * guessed, so a stale plan can only ever be a no-op.
   */
  applyQueuePlan(plan) {
    const applied = [];
    const ignored = [];
    const seen = /* @__PURE__ */ new Set();
    for (const item of plan.slice(0, 16)) {
      const id = Math.trunc(Number(item.id));
      if (!Number.isInteger(id) || id < 0) {
        ignored.push({ id, reason: "invalid-id" });
        continue;
      }
      if (seen.has(id)) {
        ignored.push({ id, reason: "duplicate" });
        continue;
      }
      seen.add(id);
      const entry = this.entries.find((candidate) => candidate.order === id);
      if (!entry) {
        ignored.push({ id, reason: "unknown-id" });
        continue;
      }
      if (entry.delivered) {
        ignored.push({ id, reason: "started" });
        continue;
      }
      if (item.action === "keep") {
        applied.push({ id, action: "keep" });
        continue;
      }
      if (item.action === "drop") {
        this.drop(entry);
        applied.push({ id, action: "drop" });
        continue;
      }
      if (item.action === "raise") {
        const priority = Number(item.priority);
        if (!Number.isFinite(priority)) {
          ignored.push({ id, reason: "invalid-priority" });
          continue;
        }
        entry.priority = Math.max(-1, Math.min(1e6, Math.trunc(priority)));
        applied.push({ id, action: "raise", priority: entry.priority });
        continue;
      }
      ignored.push({ id, reason: "invalid-action" });
    }
    this.orderEntries();
    this.emit();
    this.drain();
    return { applied, ignored };
  }
  setMode(entry, mode) {
    if (this.closed || entry.dropped || entry.delivered) return;
    entry.modeOverride = mode;
    this.drain();
  }
  drop(entry) {
    if (entry.dropped || entry.delivered) return;
    entry.dropped = true;
    this.remove(entry);
    this.emit();
    this.drain();
  }
  remove(entry) {
    this.entries = this.entries.filter((item) => item !== entry);
  }
  applyControl(control, entry) {
    if (control.action === "interrupt") {
      const prefix = entry.text?.match(/^\s*\[声纹：[^\]]*\]\s*/u)?.[0] ?? "";
      this.dropAll();
      this.options.onControl?.({ action: "interrupt", rest: control.rest });
      if (control.rest) {
        const rest = prefix + control.rest;
        this.controlChain = this.controlChain.then(async () => {
          try {
            await this.options.deliver(rest, "steer");
          } catch (error) {
            this.options.onError?.(error);
          }
        });
      }
      return;
    }
    let target = control.target;
    if (!target || /^(?:他|她|它|这个|那个|这个人|那个人)$/u.test(target)) target = this.lastGuestLabel;
    if (!target) target = "*";
    const canonical = target === "*" ? "*" : this.options.resolveSpeaker?.(target) ?? target;
    if (canonical === "\u6211") return;
    this.entries = this.entries.filter((item) => {
      if (item.lane !== "guest") return true;
      return !(canonical === "*" || item.label === canonical);
    });
    this.options.onControl?.({ action: "speaker", target: canonical, policy: control.policy });
  }
  dropAll() {
    this.entries = [];
  }
  drain() {
    if (this.draining) return;
    this.draining = true;
    void this.pump().finally(() => {
      this.draining = false;
      if (this.entries[0]?.ready) this.drain();
    });
  }
  /** Stable priority order; equal priorities keep their arrival token. */
  orderEntries() {
    this.entries.sort((left, right) => {
      const leftPriority = left.priority ?? Number.MAX_SAFE_INTEGER;
      const rightPriority = right.priority ?? Number.MAX_SAFE_INTEGER;
      if (leftPriority !== rightPriority) return leftPriority - rightPriority;
      if (left.order !== right.order) return left.order - right.order;
      return left.seq - right.seq;
    });
  }
  async pump() {
    while (this.entries.length > 0) {
      this.orderEntries();
      const entry = this.entries[0];
      if (!entry.ready) return;
      if (entry.hold && !entry.holdSettled) {
        try {
          await entry.hold;
        } catch {
        }
        entry.holdSettled = true;
        if (!this.entries.includes(entry) || this.entries[0] !== entry) continue;
      }
      this.entries.shift();
      entry.delivered = true;
      this.emit();
      if (entry.dropped || !entry.text) {
        this.emit();
        continue;
      }
      let mode;
      if (entry.modeOverride !== void 0) {
        mode = entry.modeOverride;
      } else if (entry.lane === "owner") {
        mode = this.options.ownerMode?.() ?? "steer";
      } else {
        const guest = this.options.guestMode(entry.label);
        if (guest === "ignore") {
          this.emit();
          continue;
        }
        mode = guest === "steer" ? "steer" : "queue";
      }
      try {
        await this.options.deliver(entry.text, mode);
      } catch (error) {
        this.options.onError?.(error);
      }
      this.emit();
    }
  }
  emit() {
    try {
      this.options.onStatus?.({ active: this.active, queued: this.entries.length });
    } catch {
    }
  }
}
export {
  SpeechScheduler
};
