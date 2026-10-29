function normalizeOrganizerAction(value) {
  if (typeof value !== "string") return null;
  const action = value.trim().toLowerCase();
  return action === "interrupt" || action === "queue" || action === "ignore" || action === "drop" ? action : null;
}
function shouldDeliverOrganizerAction(action) {
  return action !== "ignore" && action !== "drop";
}
function normalizeOrganizerPriority(value) {
  const number = typeof value === "number" ? value : typeof value === "string" && /^\d+$/u.test(value.trim()) ? Number(value.trim()) : NaN;
  if (!Number.isFinite(number) || number < 0) return void 0;
  return Math.min(1e6, Math.trunc(number));
}
const ORGANIZER_PENDING_LIMIT = 12;
const ORGANIZER_PENDING_ITEM_CHARS = 120;
const ORGANIZER_PENDING_TOTAL_CHARS = 1200;
function normalizeSentenceIndices(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const number = typeof item === "number" ? item : typeof item === "string" && /^\d+$/u.test(item.trim()) ? Number(item.trim()) : NaN;
    if (!Number.isInteger(number) || number < 0) continue;
    if (number > 1e4) continue;
    if (out.includes(number)) continue;
    out.push(number);
  }
  return out.slice(0, ORGANIZER_PENDING_LIMIT * 4);
}
const QUEUE_PLAN_LIMIT = 8;
function normalizeQueuePlan(value) {
  const source = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray(value.items) ? value.items : [];
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const raw of source) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw;
    const id = typeof record.id === "number" ? record.id : typeof record.id === "string" && /^\d+$/u.test(record.id.trim()) ? Number(record.id.trim()) : NaN;
    if (!Number.isInteger(id) || id < 0 || id > 1e6) continue;
    if (seen.has(id)) continue;
    const action = typeof record.action === "string" ? record.action.trim().toLowerCase() : "";
    if (action !== "keep" && action !== "drop" && action !== "raise") continue;
    seen.add(id);
    const priority = action === "raise" ? normalizeOrganizerPriority(record.priority) : void 0;
    if (action === "raise" && priority === void 0) {
      out.push({ id, action: "keep" });
      continue;
    }
    out.push({ id, action, ...priority === void 0 ? {} : { priority } });
    if (out.length >= QUEUE_PLAN_LIMIT) break;
  }
  return out;
}
function readReorganizeFields(value) {
  if (!value || typeof value !== "object") return {};
  const record = value;
  const drops = normalizeSentenceIndices(record.dropSentences ?? record.drop_sentences);
  const order = normalizeSentenceIndices(record.reorder ?? record.order);
  const queuePlan = normalizeQueuePlan(record.queuePlan ?? record.queue_plan);
  return {
    ...drops.length === 0 ? {} : { dropSentences: drops },
    ...order.length === 0 ? {} : { reorder: order },
    ...queuePlan.length === 0 ? {} : { queuePlan }
  };
}
function applyReorganization(count, fields, options = {}) {
  const size = Math.max(0, Math.min(ORGANIZER_PENDING_LIMIT, Math.trunc(Number(count) || 0)));
  const keepFirst = options.keepFirst !== false;
  const all = Array.from({ length: size }, (_, index) => index);
  const dropped = normalizeSentenceIndices(fields.dropSentences).filter((index) => index < size && !(keepFirst && index === 0));
  const alive = all.filter((index) => !dropped.includes(index));
  const order = [];
  for (const index of normalizeSentenceIndices(fields.reorder)) {
    if (index >= size || dropped.includes(index) || order.includes(index)) continue;
    order.push(index);
  }
  for (const index of alive) if (!order.includes(index)) order.push(index);
  return { order, dropped };
}
function parseOrganizerResponse(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const text = raw.replace(/```(?:json)?/giu, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const value = JSON.parse(text.slice(start, end + 1));
      const action = normalizeOrganizerAction(value.action);
      if (action) {
        const priority = normalizeOrganizerPriority(value.priority);
        return {
          action,
          ...priority === void 0 ? {} : { priority },
          ...readReorganizeFields(value),
          reason: typeof value.reason === "string" ? value.reason.slice(0, 80) : ""
        };
      }
    } catch {
    }
  }
  const keyword = text.match(/"?action"?\s*[:：]\s*"?\s*(interrupt|queue|ignore|drop)/iu);
  if (keyword) return { action: keyword[1].toLowerCase(), reason: "keyword" };
  return null;
}
function parsePlannerValue(value) {
  if (typeof value === "string") return parseOrganizerResponse(value);
  if (!value || typeof value !== "object") return null;
  const record = value;
  const action = normalizeOrganizerAction(record.action);
  if (!action) return null;
  const priority = normalizeOrganizerPriority(record.priority);
  return {
    action,
    ...priority === void 0 ? {} : { priority },
    ...readReorganizeFields(record),
    reason: typeof record.reason === "string" ? record.reason.slice(0, 80) : ""
  };
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
      const plan = {
        version,
        action: parsed.action,
        ...parsed.priority === void 0 ? {} : { priority: parsed.priority },
        ...parsed.dropSentences === void 0 ? {} : { dropSentences: parsed.dropSentences },
        ...parsed.reorder === void 0 ? {} : { reorder: parsed.reorder },
        reason: parsed.reason
      };
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
  ORGANIZER_PENDING_ITEM_CHARS,
  ORGANIZER_PENDING_LIMIT,
  ORGANIZER_PENDING_TOTAL_CHARS,
  SpeechOrganizer,
  applyReorganization,
  normalizeOrganizerAction,
  normalizeOrganizerPriority,
  normalizeQueuePlan,
  normalizeSentenceIndices,
  parseOrganizerResponse,
  shouldDeliverOrganizerAction
};
