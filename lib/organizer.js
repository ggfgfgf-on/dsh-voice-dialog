function normalizeOrganizerAction(value) {
  if (typeof value !== "string") return null;
  const action = value.trim().toLowerCase();
  return action === "interrupt" || action === "queue" || action === "ignore" ? action : null;
}
function parseOrganizerResponse(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const text = raw.replace(/```(?:json)?/giu, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1));
    const action = normalizeOrganizerAction(value.action);
    if (!action) return null;
    return { action, reason: typeof value.reason === "string" ? value.reason.slice(0, 80) : "" };
  } catch {
    return null;
  }
}
function parsePlannerValue(value) {
  if (typeof value === "string") return parseOrganizerResponse(value);
  if (!value || typeof value !== "object") return null;
  const record = value;
  const action = normalizeOrganizerAction(record.action);
  if (!action) return null;
  return { action, reason: typeof record.reason === "string" ? record.reason.slice(0, 80) : "" };
}
class SpeechOrganizer {
  constructor(planner, options = {}) {
    this.planner = planner;
    this.timeoutMs = Math.max(1, Math.round(options.timeoutMs ?? 1200));
  }
  version = 0;
  controller = null;
  latest = null;
  timeoutMs;
  async plan(request) {
    const version = ++this.version;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    try {
      const raw = await this.planner(request, controller.signal);
      if (version !== this.version) return null;
      if (timedOut) return this.fallback(version, "timeout");
      const parsed = parsePlannerValue(raw);
      if (!parsed) return this.fallback(version, "invalid");
      const plan = { version, action: parsed.action, reason: parsed.reason };
      this.latest = plan;
      return plan;
    } catch {
      if (version !== this.version) return null;
      return this.fallback(version, timedOut ? "timeout" : "error");
    } finally {
      clearTimeout(timer);
      if (this.controller === controller) this.controller = null;
    }
  }
  /** The only legal gate for applying or cutting: this plan is still newest. */
  isCurrent(plan) {
    return plan !== null && plan !== void 0 && plan.version === this.version;
  }
  /** An explicit "打断" command wins over any organizer request in flight. */
  cancel() {
    this.version += 1;
    this.controller?.abort();
    this.controller = null;
    this.latest = null;
  }
  last() {
    return this.latest;
  }
  fallback(version, reason) {
    const plan = { version, action: "queue", reason };
    this.latest = plan;
    return plan;
  }
}
export {
  SpeechOrganizer,
  normalizeOrganizerAction,
  parseOrganizerResponse
};
