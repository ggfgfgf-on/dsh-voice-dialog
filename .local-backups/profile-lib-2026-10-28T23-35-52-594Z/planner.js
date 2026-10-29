import {
  normalizeQueuePlan,
  normalizeSentenceIndices,
  parseOrganizerResponse
} from "./organizer.js";
function readQueuePlan(value) {
  if (!value || typeof value !== "object") return [];
  const record = value;
  return normalizeQueuePlan(record.queuePlan ?? record.queue_plan);
}
function readIndices(value) {
  if (!value || typeof value !== "object") return [];
  const record = value;
  return normalizeSentenceIndices(record.dropSentences ?? record.reorder);
}
class SpeechPlanner {
  constructor(planner, options = {}) {
    this.planner = planner;
    this.timeoutMs = Math.max(1, Math.round(options.timeoutMs ?? 900));
  }
  version = 0;
  controller = null;
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
      const deadline = new Promise((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error("planner-aborted")), { once: true });
      });
      const raw = await Promise.race([
        this.planner(request, controller.signal).catch(() => null),
        deadline
      ]).catch(() => null);
      if (version !== this.version) return null;
      if (timedOut) return null;
      const value = typeof raw === "string" ? parseOrganizerResponse(raw) : raw;
      if (!value || typeof value !== "object") return null;
      const record = value;
      const queuePlan = readQueuePlan(record);
      const drops = readIndices({ dropSentences: record.dropSentences });
      const reorder = readIndices({ reorder: record.reorder });
      const action = typeof record.action === "string" ? record.action : "";
      const interrupt = action === "interrupt";
      if (!interrupt && queuePlan.length === 0 && drops.length === 0 && reorder.length === 0) return null;
      return {
        version,
        turnId: request.turnId,
        reason: typeof record.reason === "string" ? record.reason.slice(0, 80) : "",
        interrupt,
        ...queuePlan.length === 0 ? {} : { queuePlan },
        ...drops.length === 0 ? {} : { dropSentences: drops },
        ...reorder.length === 0 ? {} : { reorder }
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      if (this.controller === controller) this.controller = null;
    }
  }
  isCurrent(plan) {
    return plan !== null && plan !== void 0 && plan.version === this.version;
  }
  cancel() {
    this.version += 1;
    this.controller?.abort();
    this.controller = null;
  }
}
class PlanLedger {
  claimed = /* @__PURE__ */ new Set();
  tryClaim(plan) {
    const key = plan.turnId + "#" + plan.version;
    if (this.claimed.has(key)) return false;
    this.claimed.add(key);
    if (this.claimed.size > 200) {
      const oldest = this.claimed.values().next().value;
      if (oldest !== void 0) this.claimed.delete(oldest);
    }
    return true;
  }
  clear() {
    this.claimed.clear();
  }
}
function shouldApplyPlan(plan, state) {
  if (!plan) return false;
  if (state.queued === 0 && !state.playing) return false;
  const addresses = [
    ...(plan.queuePlan ?? []).map((item) => item.id)
  ];
  if (addresses.length === 0) return true;
  const alive = new Set(state.ids);
  return addresses.some((id) => alive.has(id));
}
const PLANNER_PROMPT_LIMIT = 1600;
const PLANNER_MAX_TOKENS = 200;
const PLANNER_TIMEOUT_MS = 900;
const PLANNER_QUEUE_LIMIT = 8;
const PLANNER_PENDING_LIMIT = 8;
const PLANNER_HISTORY_PER_ROLE = 3;
const PLANNER_ITEM_CHARS = 80;
const PLANNER_SYSTEM_PROMPT = '\u4F60\u662F\u8BED\u97F3\u8F93\u51FA\u7F16\u6392\u5668\uFF08\u6162\u5224\u5C42\uFF09\u3002\u4F60\u7684\u672C\u804C\u662F\u7EC4\u7EC7"\u6211\u8FD8\u6CA1\u8BF4\u51FA\u53E3\u7684\u8BDD"\uFF0C\u4E0D\u662F\u62E6\u7528\u6237\u8F93\u5165\u3002\u8F93\u5165\uFF1A\u5F85\u8BF4\u53E5\u5B50\uFF08\u5E26\u7F16\u53F7\uFF09\u3001\u5DF2\u6392\u961F\u6761\u76EE\u3001\u7528\u6237\u65B0\u8BDD\u3002\u4F60\u53EF\u4EE5\uFF1Areorder \u8C03\u6574\u5F85\u8BF4\u987A\u5E8F\uFF08\u7ED3\u8BBA/\u7B54\u6848\u63D0\u524D\uFF09\u3001dropSentences \u5220\u9664\u6574\u53E5\uFF08\u4EC5\u9650\u91CD\u590D\u3001\u80CC\u666F\u94FA\u57AB\u3001\u4E0E\u6700\u65B0\u8BDD\u51B2\u7A81\uFF09\u3001queuePlan \u88C1\u51B3\u5DF2\u6392\u961F\u6761\u76EE\uFF08keep/drop/raise+priority\uFF09\u3002\u7981\u6B62\uFF1A\u65B0\u589E\u5185\u5BB9\u3001\u6539\u5199\u6587\u5B57\u3001\u7F16\u9020\u6570\u5B57\u3001\u52A8\u6B63\u5728\u64AD\u6216\u5DF2\u64AD\u7684\u53E5\u5B50\u3002\u7528\u6237\u8BF4"\u5148\u8BF4\u7ED3\u8BBA/\u522B\u8BB2\u80CC\u666F"\u65F6\uFF1A\u7ED3\u8BBA\u53E5\u6392\u6700\u524D\uFF0C\u80CC\u666F\u53E5\u8FDB dropSentences\uFF0C\u672A\u70B9\u540D\u7684\u53E5\u5B50\u4E00\u53E5\u4E0D\u5220\u3002\u8F93\u51FA\u4E00\u884CJSON\uFF1A{"reorder":[1,0],"dropSentences":[2],"queuePlan":[],"interrupt":false,"reason":"\u226410\u5B57"}\uFF1B\u6CA1\u6709\u66F4\u5408\u9002\u7684\u987A\u5E8F\u5C31\u8F93\u51FA {"reason":"\u4E0D\u53D8"}\u3002';
function clipItem(text, limit = PLANNER_ITEM_CHARS) {
  const flat = String(text ?? "").replace(/\s+/gu, " ").trim();
  return flat.length > limit ? flat.slice(0, limit) : flat;
}
function historyLines(history) {
  const kept = [];
  let users = 0;
  let assistants = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index];
    if (!item) continue;
    const role = item.role === "assistant" ? "assistant" : "user";
    if (role === "assistant" ? assistants >= PLANNER_HISTORY_PER_ROLE : users >= PLANNER_HISTORY_PER_ROLE) continue;
    const text = clipItem(item.text);
    if (!text) continue;
    kept.push((role === "assistant" ? "\u52A9\u624B\uFF1A" : "\u6211\uFF1A") + text);
    if (role === "assistant") assistants += 1;
    else users += 1;
  }
  return kept.reverse();
}
function buildPlannerPrompt(input) {
  const head = [
    "\u6717\u8BFB\u4E2D\uFF1A" + (input.playing ? "\u662F" : "\u5426"),
    "\u6392\u961F\u6761\u6570\uFF1A" + Math.max(0, Math.round(input.queued)),
    "\u8BF4\u8BDD\u4EBA\uFF1A" + (input.lane === "owner" ? "\u6211" : "\u5176\u4ED6\u4EBA")
  ];
  const queue = input.queue.slice(0, PLANNER_QUEUE_LIMIT).map((item) => "\u961F\u5217 " + item.id + "|" + (item.lane === "guest" ? "\u5176\u4ED6\u4EBA" : "\u6211") + "\uFF1A" + clipItem(item.text));
  const pending = input.assistantPending.slice(0, PLANNER_PENDING_LIMIT).map((text2, index) => "\u5F85\u8BF4 " + index + "|" + clipItem(text2));
  const history = historyLines(input.history);
  const tail = ["\u65B0\u8BDD\uFF1A" + clipItem(input.text)];
  const dropOrder = ["history", "queue", "pending"];
  const sections = {
    history,
    queue,
    pending,
    tail
  };
  const render = () => [head, history, queue, pending, tail].flat().join("\n");
  for (const key of dropOrder) {
    while (PLANNER_SYSTEM_PROMPT.length + render().length > PLANNER_PROMPT_LIMIT && sections[key].length > 0) {
      sections[key].shift();
    }
    if (PLANNER_SYSTEM_PROMPT.length + render().length <= PLANNER_PROMPT_LIMIT) break;
  }
  const text = [head, sections.history, sections.queue, sections.pending, sections.tail].flat().join("\n");
  return text.length > PLANNER_PROMPT_LIMIT - PLANNER_SYSTEM_PROMPT.length ? text.slice(0, Math.max(0, PLANNER_PROMPT_LIMIT - PLANNER_SYSTEM_PROMPT.length)) : text;
}
function plannerPromptChars(input) {
  return PLANNER_SYSTEM_PROMPT.length + buildPlannerPrompt(input).length;
}
export {
  PLANNER_HISTORY_PER_ROLE,
  PLANNER_ITEM_CHARS,
  PLANNER_MAX_TOKENS,
  PLANNER_PENDING_LIMIT,
  PLANNER_PROMPT_LIMIT,
  PLANNER_QUEUE_LIMIT,
  PLANNER_SYSTEM_PROMPT,
  PLANNER_TIMEOUT_MS,
  PlanLedger,
  SpeechPlanner,
  buildPlannerPrompt,
  plannerPromptChars,
  shouldApplyPlan
};
