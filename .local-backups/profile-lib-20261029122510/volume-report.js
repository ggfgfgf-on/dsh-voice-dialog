function createVolumeReporter(options) {
  const batchMs = options.batchMs ?? 300;
  const maxBuffered = options.maxBuffered ?? 240;
  const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
  let buffer = [];
  let timer;
  let dropped = 0;
  const flush = () => {
    if (timer !== void 0) {
      const handle = timer;
      timer = void 0;
      clearTimer(handle);
    }
    if (buffer.length === 0) return;
    const samples = buffer;
    buffer = [];
    try {
      options.post({ samples });
    } catch {
    }
  };
  const report = (sample) => {
    if (buffer.length >= maxBuffered) {
      buffer.shift();
      dropped += 1;
    }
    buffer.push(sample);
    if (timer === void 0) timer = setTimer(flush, batchMs);
  };
  return { report, flush, pending: () => buffer.length, dropped: () => dropped };
}
export {
  createVolumeReporter
};
