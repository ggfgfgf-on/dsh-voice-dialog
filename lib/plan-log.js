import { appendFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const PLAN_LOG_PATH = join(tmpdir(), "dsh-voice-plan.jsonl");
const MAX_BYTES = 512 * 1024;
const MAX_ITEMS = 40;
const PLAN_TEXT_LIMIT = 40;
const KINDS = ["reply", "ack", "hold", "ignore", "custom"];
const LANES = ["fast", "slow", "owner", "guest"];
const shortString = (value, limit) => typeof value === "string" ? value.trim().slice(0, limit) : "";
const finiteInt = (value, fallback = 0) => typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
function sanitizePlanItem(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw;
  const kind = typeof record.kind === "string" && KINDS.includes(record.kind) ? record.kind : "";
  const lane = typeof record.lane === "string" && LANES.includes(record.lane) ? record.lane : "";
  if (!kind || !lane) return null;
  const at = finiteInt(record.at, Date.now());
  return {
    sessionId: shortString(record.sessionId, 64),
    replyId: shortString(record.replyId, 64),
    seq: Math.max(0, finiteInt(record.seq)),
    at,
    kind,
    lane,
    priority: finiteInt(record.priority),
    delayMs: Math.max(0, finiteInt(record.delayMs)),
    text: shortString(record.text, PLAN_TEXT_LIMIT),
    reason: shortString(record.reason, 40),
    source: shortString(record.source, 24)
  };
}
function appendPlanLog(item) {
  try {
    let size = 0;
    try {
      size = statSync(PLAN_LOG_PATH).size;
    } catch {
      size = 0;
    }
    if (size > MAX_BYTES) writeFileSync(PLAN_LOG_PATH, "");
    appendFileSync(PLAN_LOG_PATH, JSON.stringify(item) + "\n");
  } catch {
  }
}
async function readBody(req, limit) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(JSON.parse(text || "{}"));
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}
const planLogHandler = async (req, res) => {
  try {
    const body = await readBody(req, 64 * 1024);
    const rows = Array.isArray(body?.items) ? body.items : [body];
    for (const row of rows.slice(0, MAX_ITEMS)) {
      const item = sanitizePlanItem(row);
      if (item) appendPlanLog(item);
    }
  } catch {
  }
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end('{"ok":true}');
};
const PLAN_LOG_ROUTES = [
  ["/plan-log", planLogHandler]
];
export {
  PLAN_LOG_PATH,
  PLAN_LOG_ROUTES,
  PLAN_TEXT_LIMIT,
  appendPlanLog,
  sanitizePlanItem
};
