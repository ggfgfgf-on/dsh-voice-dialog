const OPEN = "[[voice:";
function parseVoiceCommand(raw) {
  const text = raw.trim();
  if (text.length === 0) return null;
  const lower = text.toLowerCase();
  if (lower === "repeat" || lower === "stop") return { action: lower };
  const volume = /^volume\b([\s\S]*)$/i.exec(text);
  if (volume) {
    const argument = volume[1].trim().replace(/^[=:]\s*/, "");
    if (argument.toLowerCase() === "up") return { action: "volume", delta: 0.15 };
    if (argument.toLowerCase() === "down") return { action: "volume", delta: -0.15 };
    const value = Number(argument);
    if (!Number.isFinite(value)) return null;
    const clamped = Math.max(-1, Math.min(1, value));
    if (argument.startsWith("+") || value < 0) return { action: "volume", delta: clamped };
    return { action: "volume", level: clamped };
  }
  return { action: "say", text };
}
class VoiceProtocol {
  buffer = "";
  feed(text) {
    this.buffer += text;
    const commands = [];
    for (; ; ) {
      const start = this.buffer.indexOf(OPEN);
      if (start < 0) {
        this.buffer = this.buffer.slice(-(OPEN.length - 1));
        break;
      }
      const end = this.buffer.indexOf("]]", start + OPEN.length);
      if (end < 0) {
        this.buffer = this.buffer.slice(start);
        break;
      }
      const raw = this.buffer.slice(start + OPEN.length, end);
      this.buffer = this.buffer.slice(end + 2);
      const command = parseVoiceCommand(raw);
      if (command !== null) commands.push(command);
    }
    return commands;
  }
  flush() {
    this.buffer = "";
  }
}
export {
  VoiceProtocol,
  parseVoiceCommand
};
