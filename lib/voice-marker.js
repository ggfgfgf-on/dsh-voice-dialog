const DIRECTIVE_HEAD = "[[voice:";
const COMPLETE_DIRECTIVE = /\[\[\s*voice\s*[:：][\s\S]*?\]\]/giu;
function partialMarkerAt(buffer) {
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] !== "[") continue;
    const tail = buffer.slice(i).toLowerCase().replace(/\uFF1A/g, ":").replace(/\s+/g, "");
    if (DIRECTIVE_HEAD.startsWith(tail) || tail.startsWith(DIRECTIVE_HEAD)) return i;
  }
  return -1;
}
class VisibleVoiceFilter {
  carry = "";
  push(text) {
    let buffer = this.carry + (typeof text === "string" ? text : "");
    this.carry = "";
    buffer = buffer.replace(COMPLETE_DIRECTIVE, "");
    const cut = partialMarkerAt(buffer);
    if (cut >= 0) {
      this.carry = buffer.slice(cut);
      buffer = buffer.slice(0, cut);
    }
    return buffer;
  }
  /** Drop a trailing incomplete directive when the stream ends. */
  finish() {
    this.carry = "";
    return "";
  }
}
export {
  VisibleVoiceFilter
};
