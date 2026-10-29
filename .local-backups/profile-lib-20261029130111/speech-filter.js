function shouldSpeak(options, enabled) {
  return enabled && options.sessionId !== void 0 && options.purpose === void 0;
}
function isSpeakableChunk(chunk) {
  return chunk.type === "text-delta" && typeof chunk.text === "string" && chunk.text.length > 0;
}
export {
  isSpeakableChunk,
  shouldSpeak
};
