import { parseQueueControl } from "./queue-control.js";
class SpeechScheduler {
  constructor(options) {
    this.options = options;
  }
  entries = [];
  nextSeq = 0;
  active = 0;
  closed = false;
  draining = false;
  lastGuestLabel = "";
  controlChain = Promise.resolve();
  /** Start tracking one utterance whose text will arrive asynchronously. */
  enqueue(lane, label, work) {
    if (this.closed) return;
    if (lane === "guest" && label) this.lastGuestLabel = label;
    const entry = {
      seq: this.nextSeq++,
      lane,
      label,
      ready: false,
      text: null,
      dropped: false
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
  async pump() {
    while (this.entries.length > 0) {
      const entry = this.entries[0];
      if (!entry.ready) return;
      this.entries.shift();
      if (entry.dropped || !entry.text) {
        this.emit();
        continue;
      }
      let mode;
      if (entry.lane === "owner") {
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
