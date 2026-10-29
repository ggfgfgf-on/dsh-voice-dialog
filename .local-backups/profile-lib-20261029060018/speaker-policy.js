const MAX_SPEAKER_NAME = 24;
function cleanName(value) {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (!name || name.length > MAX_SPEAKER_NAME) return null;
  if (name === "\u6211" || name === "*") return null;
  if (/[\[\]\r\n]/.test(name)) return null;
  return name;
}
function cleanPolicy(value) {
  return value === "queue" || value === "steer" || value === "ignore" || value === "default" ? value : void 0;
}
class SpeakerPolicyStore {
  policies = /* @__PURE__ */ new Map();
  names = /* @__PURE__ */ new Map();
  aliases = /* @__PURE__ */ new Map();
  /** Apply a model-issued rename and/or policy. Returns whether anything changed. */
  apply(sessionId, control) {
    const speaker = typeof control.speaker === "string" ? control.speaker.trim() : "";
    if (!speaker || speaker === "\u6211") return false;
    const policy = cleanPolicy(control.policy);
    const name = cleanName(control.name);
    if (policy === void 0 && name === null) return false;
    if (speaker === "*" && name !== null) return false;
    const canonical = speaker === "*" ? "*" : this.resolve(sessionId, speaker);
    if (canonical === "\u6211") return false;
    if (name !== null) {
      let byCanonical = this.names.get(sessionId);
      if (!byCanonical) {
        byCanonical = /* @__PURE__ */ new Map();
        this.names.set(sessionId, byCanonical);
      }
      let byName = this.aliases.get(sessionId);
      if (!byName) {
        byName = /* @__PURE__ */ new Map();
        this.aliases.set(sessionId, byName);
      }
      byCanonical.set(canonical, name);
      byName.set(name, canonical);
    }
    if (policy === "default") {
      if (canonical === "*") {
        this.policies.delete(sessionId);
      } else {
        const byCanonical = this.policies.get(sessionId);
        byCanonical?.delete(canonical);
        if (byCanonical && byCanonical.size === 0) this.policies.delete(sessionId);
      }
    } else if (policy !== void 0) {
      let byCanonical = this.policies.get(sessionId);
      if (!byCanonical) {
        byCanonical = /* @__PURE__ */ new Map();
        this.policies.set(sessionId, byCanonical);
      }
      byCanonical.set(canonical, policy);
    }
    return true;
  }
  /** Resolve a display name back to the host's canonical label. */
  resolve(sessionId, label) {
    const trimmed = label.trim();
    return this.aliases.get(sessionId)?.get(trimmed) ?? trimmed;
  }
  /** Human/model-facing name for a canonical voiceprint label. */
  display(sessionId, label) {
    const canonical = this.resolve(sessionId, label);
    return this.names.get(sessionId)?.get(canonical) ?? canonical;
  }
  /** Effective guest policy for a label, falling back to the browser setting. */
  effective(sessionId, label, fallback) {
    const canonical = this.resolve(sessionId, label);
    const byCanonical = this.policies.get(sessionId);
    if (byCanonical) {
      if (canonical && byCanonical.has(canonical)) return byCanonical.get(canonical);
      if (byCanonical.has("*")) return byCanonical.get("*");
    }
    return fallback;
  }
  /** Whether this session has any model-issued name or policy. */
  hasCustomization(sessionId) {
    return (this.policies.get(sessionId)?.size ?? 0) > 0 || (this.names.get(sessionId)?.size ?? 0) > 0;
  }
  /** Drop everything for one conversation (used when a session is disposed). */
  clear(sessionId) {
    this.policies.delete(sessionId);
    this.names.delete(sessionId);
    this.aliases.delete(sessionId);
  }
}
export {
  MAX_SPEAKER_NAME,
  SpeakerPolicyStore
};
