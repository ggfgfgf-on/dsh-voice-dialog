import { appendFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const RECORD_LOG_PATH = join(tmpdir(), "dsh-voice-record.jsonl");
const MAX_BYTES = 512 * 1024;
const MAX_ITEMS = 64;
const RECORD_TEXT_LIMIT = 40;
const RECORD_LABEL_LIMIT = 24;
const KINDS = [
  "transcript",
  "voiceprint",
  "barge-in",
  "playback",
  "reply",
  "plan",
  "custom"
];
const LANES = ["owner", "guest", "fast", "slow", ""];
const shortString = (value, limit) => typeof value === "string" ? value.replace(/\s+/gu, " ").trim().slice(0, limit) : "";
const finiteInt = (value, fallback = 0) => typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
function sanitizeRecordEvent(raw, sessionId = "") {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw;
  const kind = typeof record.kind === "string" && KINDS.includes(record.kind) ? record.kind : "";
  if (!kind) return null;
  const lane = typeof record.lane === "string" && LANES.includes(record.lane) ? record.lane : "";
  return {
    sessionId: shortString(record.sessionId, 64) || shortString(sessionId, 64),
    seq: Math.max(0, finiteInt(record.seq)),
    at: finiteInt(record.at, Date.now()),
    kind,
    lane,
    canonical: shortString(record.canonical, RECORD_LABEL_LIMIT),
    text: shortString(record.text, RECORD_TEXT_LIMIT),
    reason: shortString(record.reason, 40)
  };
}
function appendRecordLog(item) {
  try {
    let size = 0;
    try {
      size = statSync(RECORD_LOG_PATH).size;
    } catch {
      size = 0;
    }
    if (size > MAX_BYTES) writeFileSync(RECORD_LOG_PATH, "");
    appendFileSync(RECORD_LOG_PATH, JSON.stringify(item) + "\n");
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
const recordLogHandler = async (req, res) => {
  try {
    const body = await readBody(req, 64 * 1024);
    const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
    const rows = Array.isArray(body?.items) ? body.items : [body];
    for (const row of rows.slice(0, MAX_ITEMS)) {
      const item = sanitizeRecordEvent(row, sessionId);
      if (item) appendRecordLog(item);
    }
  } catch {
  }
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end('{"ok":true}');
};
const RECORD_LOG_ROUTES = [
  ["/record-log", recordLogHandler]
];
export {
  RECORD_LABEL_LIMIT,
  RECORD_LOG_PATH,
  RECORD_LOG_ROUTES,
  RECORD_TEXT_LIMIT,
  appendRecordLog,
  sanitizeRecordEvent
};
