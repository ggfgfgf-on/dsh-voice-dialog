class SpeechScheduler {
  constructor(options) {
    this.options = options;
    this.batchMs = Math.max(0, options.batchMs ?? 900);
  }
  ownerChain = Promise.resolve();
  guestChain = Promise.resolve();
  pending = [];
  timer;
  active = 0;
  closed = false;
  batchMs;
  /** Start tracking one utterance whose text will arrive asynchronously. */
  enqueue(lane, label, work) {
    if (this.closed) return;
    this.active += 1;
    this.emit();
    const resolve = async () => {
      try {
        const text = await work;
        return typeof text === "string" && text.trim() ? text.trim() : null;
      } catch (error) {
        this.options.onError?.(error);
        return null;
      }
    };
    if (lane === "owner") {
      this.ownerChain = this.ownerChain.then(async () => {
        try {
          const text = await resolve();
          if (text) await this.options.deliver(text, "steer");
        } catch (error) {
          this.options.onError?.(error);
        } finally {
          this.active = Math.max(0, this.active - 1);
          this.emit();
        }
      });
      return;
    }
    const mode = this.options.guestMode();
    if (mode === "ignore") {
      void work.catch((error) => {
        this.options.onError?.(error);
      });
      this.active = Math.max(0, this.active - 1);
      this.emit();
      return;
    }
    if (mode === "steer") {
      this.guestChain = this.guestChain.then(async () => {
        try {
          const text = await resolve();
          if (text) await this.options.deliver(text, "steer");
        } catch (error) {
          this.options.onError?.(error);
        } finally {
          this.active = Math.max(0, this.active - 1);
          this.emit();
        }
      });
      return;
    }
    this.guestChain = this.guestChain.then(async () => {
      try {
        const text = await resolve();
        if (text) {
          this.pending.push({ label, text });
          this.schedule();
        }
      } catch (error) {
        this.options.onError?.(error);
      } finally {
        this.active = Math.max(0, this.active - 1);
        this.emit();
      }
    });
  }
  /** Send every waiting guest line immediately as one queued prompt. */
  flushGuests() {
    if (this.timer !== void 0) {
      clearTimeout(this.timer);
      this.timer = void 0;
    }
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    this.emit();
    const text = batch.map((item) => item.text).join("\n");
    this.guestChain = this.guestChain.then(async () => {
      try {
        if (this.options.guestMode() === "ignore") return;
        await this.options.deliver(text, "queue");
      } catch (error) {
        this.options.onError?.(error);
      }
    });
  }
  /** Stop accepting work, but keep already captured guest lines. */
  dispose() {
    if (this.closed) return;
    this.flushGuests();
    this.closed = true;
    if (this.timer !== void 0) {
      clearTimeout(this.timer);
      this.timer = void 0;
    }
  }
  status() {
    return { active: this.active, queued: this.pending.length };
  }
  schedule() {
    if (this.timer !== void 0 || this.pending.length === 0) return;
    if (this.batchMs === 0) {
      this.flushGuests();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = void 0;
      this.flushGuests();
    }, this.batchMs);
  }
  emit() {
    try {
      this.options.onStatus?.({ active: this.active, queued: this.pending.length });
    } catch {
    }
  }
}
export {
  SpeechScheduler
};
