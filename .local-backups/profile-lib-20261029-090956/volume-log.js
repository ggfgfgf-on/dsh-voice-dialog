import { appendFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const VOLUME_LOG_PATH = join(tmpdir(), "dsh-voice-volume.jsonl");
const MAX_BYTES = 512 * 1024;
const MAX_SAMPLES = 60;
const EVENTS = /* @__PURE__ */ new Set(["apply", "duck", "restore", "cut", "begin", "override"]);
const clamp01 = (value) => typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;
function sanitizeVolumeSample(raw) {
  if (!raw || typeof raw !== "object") return null;
  const record = raw;
  const target = clamp01(record.target);
  const actual = clamp01(record.actual);
  if (target === null || actual === null) return null;
  const event = typeof record.event === "string" && EVENTS.has(record.event) ? record.event : "apply";
  const at = typeof record.at === "number" && Number.isFinite(record.at) ? Math.round(record.at) : Date.now();
  const override = record.volumeOverride === null || record.volumeOverride === void 0 ? null : clamp01(record.volumeOverride) ?? null;
  return {
    at,
    event,
    ducked: record.ducked === true,
    target,
    actual,
    volumeOverride: override,
    prefsVolume: clamp01(record.prefsVolume) ?? 0,
    duckLevel: clamp01(record.duckLevel) ?? 0,
    suppressed: record.suppressed === true
  };
}
function appendVolumeLog(sample) {
  try {
    let size = 0;
    try {
      size = statSync(VOLUME_LOG_PATH).size;
    } catch {
      size = 0;
    }
    if (size > MAX_BYTES) writeFileSync(VOLUME_LOG_PATH, "");
    appendFileSync(VOLUME_LOG_PATH, JSON.stringify(sample) + "\n");
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
const volumeLogHandler = async (req, res) => {
  try {
    const body = await readBody(req, 64 * 1024);
    const rows = Array.isArray(body?.samples) ? body.samples : [body];
    for (const row of rows.slice(0, MAX_SAMPLES)) {
      const sample = sanitizeVolumeSample(row);
      if (sample) appendVolumeLog(sample);
    }
  } catch {
  }
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end('{"ok":true}');
};
const VOLUME_LOG_ROUTES = [
  ["/volume-log", volumeLogHandler]
];
export {
  VOLUME_LOG_PATH,
  VOLUME_LOG_ROUTES,
  appendVolumeLog,
  sanitizeVolumeSample
};
