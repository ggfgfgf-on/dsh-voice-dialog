function firstBlockShape(read) {
  const profile = read();
  return {
    chars: typeof profile.firstBlockChars === "number" ? profile.firstBlockChars : 8,
    deadlineMs: profile.firstBlockDeadlineMs ?? 0
  };
}
function innerPauseFor(read) {
  return read().innerPauseMs ?? 0;
}
function declaredAck(read) {
  const profile = read();
  return {
    text: String(profile.backchannel ?? ""),
    afterMs: typeof profile.backchannelAfterMs === "number" ? profile.backchannelAfterMs : 0
  };
}
function warmOpenDeclared(read) {
  return read().warmOpen === true;
}
export {
  declaredAck,
  firstBlockShape,
  innerPauseFor,
  warmOpenDeclared
};
