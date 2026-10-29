function decideBargeIn(input) {
  const playing = input.playing === true;
  if (input.lane === "guest") {
    if (input.guestMode === "ignore") {
      return {
        action: "none",
        finishSentence: false,
        keepRemainder: false,
        reason: "guest-ignore"
      };
    }
    if (input.guestMode === "steer" && playing) {
      return {
        action: "interrupt",
        finishSentence: true,
        keepRemainder: true,
        priority: -1,
        reason: "guest-steer-policy"
      };
    }
    return {
      action: playing ? "queue" : "none",
      finishSentence: false,
      keepRemainder: false,
      reason: "guest-default-queue"
    };
  }
  if (!playing) {
    return {
      action: "none",
      finishSentence: false,
      keepRemainder: false,
      reason: "owner-idle"
    };
  }
  return {
    action: "interrupt",
    finishSentence: true,
    keepRemainder: true,
    priority: -1,
    reason: "owner-during-playback"
  };
}
function isSameSentence(left, right) {
  return typeof left.sentenceId === "number" && Number.isFinite(left.sentenceId) && left.sentenceId === right.sentenceId;
}
function splitAtSentenceBoundary(current, queued) {
  if (!current) {
    return { finish: [], remainder: [...queued], stopAfterCurrent: false };
  }
  let boundary = 0;
  while (boundary < queued.length && isSameSentence(current, queued[boundary])) boundary += 1;
  return {
    finish: queued.slice(0, boundary),
    remainder: queued.slice(boundary),
    stopAfterCurrent: true
  };
}
function orderBargeInFrames(newReplyFrames, oldRemainder, keepRemainder = true) {
  return keepRemainder ? [...newReplyFrames, ...oldRemainder] : [...newReplyFrames];
}
export {
  decideBargeIn,
  isSameSentence,
  orderBargeInFrames,
  splitAtSentenceBoundary
};
