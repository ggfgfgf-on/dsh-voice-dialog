import { createRequire } from "node:module";
import { fork } from "node:child_process";
import { createWriteStream, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { request as httpsRequest } from "node:https";
import { pipeline } from "node:stream/promises";
import * as httpsProxyAgent from "https-proxy-agent";
import {
  SEPARATION_FADE as FADE,
  SEPARATION_HOP as HOP,
  SEPARATION_WINDOW as WINDOW,
  shouldSwap
} from "./separation-align.js";
import { shouldSwap as shouldSwap2 } from "./separation-align.js";
const require2 = createRequire(import.meta.url);
const SEPARATION_MODEL_FILE = "mossformer2_ss_16k.onnx";
const SEPARATION_MODEL_BYTES = 245120037;
const MODEL_URL = "https://huggingface.co/mhavo/mossformer2-ss-16k-onnx/resolve/main/" + SEPARATION_MODEL_FILE;
const SAMPLE_RATE = 16e3;
const DEFAULT_EXECUTION_PROVIDERS = ["dml"];
const DEFAULT_DML_DEVICE_ID = 0;
const SOURCE_FLOOR = 0.1;
function normalizeExecutionProviders(values) {
  const source = values ?? process.env.DSH_SEPARATION_EXECUTION_PROVIDERS?.split(",");
  const unique = [...new Set(
    (source ?? DEFAULT_EXECUTION_PROVIDERS).map((value) => String(value).trim().toLowerCase()).filter(Boolean)
  )];
  return unique.length > 0 ? unique : [...DEFAULT_EXECUTION_PROVIDERS];
}
function normalizeDmlDeviceId(value) {
  const candidate = value ?? Number(process.env.DSH_SEPARATION_DML_DEVICE_ID ?? DEFAULT_DML_DEVICE_ID);
  return Number.isInteger(candidate) && candidate >= 0 ? candidate : DEFAULT_DML_DEVICE_ID;
}
function proxyUrl() {
  const raw = process.env.DSH_VOICE_MODEL_PROXY ?? process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
  if (!raw || !/^https?:\/\//i.test(raw.trim())) return void 0;
  return raw.trim();
}
function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) {
      reject(new Error("\u5206\u79BB\u6A21\u578B\u4E0B\u8F7D\u91CD\u5B9A\u5411\u8FC7\u591A"));
      return;
    }
    const proxy = proxyUrl();
    const Agent = httpsProxyAgent.HttpsProxyAgent;
    const agent = proxy ? new Agent(proxy) : void 0;
    const req = httpsRequest(url, { agent, headers: { "user-agent": "dsh-voice-dialog" } }, (res) => {
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location) {
        res.resume();
        download(new URL(location, url).toString(), dest, redirects + 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error("\u4E0B\u8F7D\u5206\u79BB\u6A21\u578B\u5931\u8D25\uFF08HTTP " + status + "\uFF09"));
        return;
      }
      const out = createWriteStream(dest);
      pipeline(res, out).then(() => resolve(), reject);
    });
    req.on("error", reject);
    req.setTimeout(3e5, () => {
      req.destroy(new Error("\u5206\u79BB\u6A21\u578B\u4E0B\u8F7D\u8D85\u65F6"));
    });
  });
}
function rms(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, samples.length));
}
function peak(samples) {
  let value = 0;
  for (let i = 0; i < samples.length; i++) value = Math.max(value, Math.abs(samples[i]));
  return value;
}
function tame(samples) {
  const high = peak(samples);
  if (!Number.isFinite(high) || high <= 0.98) return samples;
  const gain = 0.95 / high;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * gain;
  return out;
}
function onsetMs(samples) {
  const high = peak(samples);
  const floor = Math.max(0.01, high * 0.04);
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]) >= floor) return Math.round(i * 1e3 / SAMPLE_RATE);
  }
  return 0;
}
function planWindows(length) {
  if (length <= WINDOW) return [0];
  const starts = [0];
  for (; ; ) {
    const previous = starts[starts.length - 1];
    const next = previous + HOP;
    if (next + WINDOW >= length) {
      const last = Math.max(0, length - WINDOW);
      if (last > previous) starts.push(last);
      break;
    }
    starts.push(next);
  }
  return starts;
}
function edgeWeight(index, first, last) {
  let weight = 1;
  if (!first) weight = Math.min(weight, index / FADE);
  if (!last) weight = Math.min(weight, (WINDOW - 1 - index) / FADE);
  return Math.max(0, weight);
}
async function separateWithRunner(samples, run) {
  const started = Date.now();
  const starts = planWindows(samples.length);
  const outA = new Float32Array(samples.length);
  const outB = new Float32Array(samples.length);
  const weights = new Float32Array(samples.length);
  let previous;
  for (const start of starts) {
    const input = new Float32Array(WINDOW);
    input.set(samples.subarray(start, Math.min(samples.length, start + WINDOW)));
    const [rawA, rawB] = await run(input);
    if (rawA.length !== WINDOW || rawB.length !== WINDOW) throw new Error("\u5206\u79BB\u6A21\u578B\u8F93\u51FA\u957F\u5EA6\u4E0D\u6B63\u786E");
    const overlap = previous ? previous.start + WINDOW - start : 0;
    const swap = previous !== void 0 && overlap > 0 ? shouldSwap(previous.a, previous.b, rawA, rawB, overlap) : false;
    const a = swap ? rawB : rawA;
    const b = swap ? rawA : rawB;
    const first = start === 0;
    const last = start + WINDOW >= samples.length;
    for (let i = 0; i < WINDOW; i++) {
      const at = start + i;
      if (at >= samples.length) break;
      const weight = edgeWeight(i, first, last);
      if (weight === 0) continue;
      outA[at] += a[i] * weight;
      outB[at] += b[i] * weight;
      weights[at] += weight;
    }
    previous = { a, b, start };
  }
  for (let i = 0; i < samples.length; i++) {
    const weight = weights[i];
    if (weight > 1e-6) {
      outA[i] /= weight;
      outB[i] /= weight;
    }
  }
  const sources = [tame(outA), tame(outB)].map((track) => ({
    samples: track,
    rms: rms(track),
    onsetMs: onsetMs(track)
  }));
  const loud = Math.max(sources[0].rms, sources[1].rms);
  return {
    sources: sources.filter((source) => source.rms >= loud * SOURCE_FLOOR),
    elapsedMs: Date.now() - started
  };
}
class SeparationService {
  dataDir;
  modelPath;
  backend;
  worker;
  ready;
  chain = Promise.resolve();
  workerStderr = "";
  workerSeq = 0;
  pending = /* @__PURE__ */ new Map();
  injectedRun;
  executionProviders;
  dmlDeviceId;
  constructor(options = {}) {
    this.dataDir = options.dataDir ?? join(homedir(), ".dsh", "voice-dialog");
    this.modelPath = options.modelPath ?? process.env.DSH_SEPARATION_MODEL ?? join(this.dataDir, "models", SEPARATION_MODEL_FILE);
    this.injectedRun = options.run;
    this.executionProviders = normalizeExecutionProviders(options.executionProviders);
    this.dmlDeviceId = normalizeDmlDeviceId(options.dmlDeviceId);
  }
  /** Log both the selected provider and the provider chain requested by the user. */
  setBackend(value) {
    const backend = typeof value === "string" && value.length > 0 ? value : void 0;
    if (!backend || backend === this.backend) return;
    this.backend = backend;
    const fallback = backend === "cpu" && !this.executionProviders.includes("cpu");
    const line = "[dsh-voice-dialog] separation provider=" + backend + " requested=" + this.executionProviders.join(",") + (fallback ? " (CPU fallback)" : "");
    if (fallback) console.warn(line);
    else console.info(line);
  }
  status() {
    let addonAvailable = false;
    try {
      require2.resolve("onnxruntime-node");
      addonAvailable = true;
    } catch {
    }
    let modelBytes = 0;
    try {
      modelBytes = statSync(this.modelPath).size;
    } catch {
    }
    const modelPresent = modelBytes > 2e8;
    const ready = this.injectedRun !== void 0 || addonAvailable && modelPresent;
    return {
      addonAvailable,
      modelPresent,
      ready,
      modelPath: this.modelPath,
      modelBytes,
      executionProviders: this.executionProviders,
      ...this.backend ? { backend: this.backend } : {},
      ...ready ? {} : { error: addonAvailable ? "\u5206\u79BB\u6A21\u578B\u672A\u5B89\u88C5\uFF0C\u8BF7\u5728\u8BBE\u7F6E\u9875\u4E0B\u8F7D" : "\u7F3A\u5C11\u672C\u5730\u5206\u79BB\u7EC4\u4EF6 onnxruntime-node" }
    };
  }
  /** Load the model before the first overlapping utterance. */
  async warm() {
    if (this.injectedRun) return;
    await this.ensureWorker();
  }
  async prepare() {
    const current = statSync(this.modelPath, { throwIfNoEntry: false })?.size ?? 0;
    if (current > 2e8) return this.status();
    mkdirSync(dirname(this.modelPath), { recursive: true });
    const part = this.modelPath + ".part";
    try {
      await download(MODEL_URL, part);
      const size = statSync(part).size;
      if (size !== SEPARATION_MODEL_BYTES) throw new Error("\u5206\u79BB\u6A21\u578B\u5927\u5C0F\u4E0D\u6B63\u786E\uFF08" + size + " \u5B57\u8282\uFF09");
      renameSync(part, this.modelPath);
      return this.status();
    } catch (error) {
      try {
        unlinkSync(part);
      } catch {
      }
      throw error;
    }
  }
  failPending(error) {
    for (const item of this.pending.values()) item.reject(error);
    this.pending.clear();
  }
  lastWorkerError() {
    return this.workerStderr.trim().split(/\r?\n/).slice(-3).join(" ");
  }
  /** The host already has sherpa-onnx's onnxruntime.dll loaded; a child keeps DLLs apart. */
  ensureWorker() {
    if (this.ready) return this.ready;
    if (!statSync(this.modelPath, { throwIfNoEntry: false })?.size) {
      return Promise.reject(new Error("\u5206\u79BB\u6A21\u578B\u672A\u5B89\u88C5\uFF0C\u8BF7\u5728\u8BBE\u7F6E\u9875\u4E0B\u8F7D"));
    }
    const promise = new Promise((resolve, reject) => {
      const workerPath = fileURLToPath(new URL("./separation-worker.js", import.meta.url));
      let settled = false;
      let timer;
      const fail = (error) => {
        if (timer) clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(error);
        }
        this.failPending(error);
        this.worker = void 0;
      };
      let worker;
      try {
        worker = fork(workerPath, [], {
          serialization: "advanced",
          windowsHide: true,
          execArgv: [],
          stdio: ["ignore", "ignore", "pipe", "ipc"]
        });
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      this.worker = worker;
      this.workerStderr = "";
      worker.stderr?.on("data", (chunk) => {
        this.workerStderr = (this.workerStderr + chunk.toString()).slice(-4e3);
      });
      worker.on("message", (message) => {
        if (!message || typeof message !== "object") return;
        if (message.type === "ready") {
          this.setBackend(message.backend);
          if (timer) clearTimeout(timer);
          if (!settled) {
            settled = true;
            resolve();
          }
          return;
        }
        if (message.type === "backend") {
          this.setBackend(message.backend);
          return;
        }
        if (message.type === "result") {
          const item = this.pending.get(message.id);
          if (!item) return;
          this.pending.delete(message.id);
          item.resolve({
            sources: (message.sources ?? []).map((source) => ({
              samples: Float32Array.from(source.samples),
              rms: Number(source.rms) || 0,
              onsetMs: Number(source.onsetMs) || 0
            })),
            elapsedMs: Number(message.elapsedMs) || 0
          });
          return;
        }
        if (message.type === "error") {
          const item = this.pending.get(message.id);
          if (!item) return;
          this.pending.delete(message.id);
          item.reject(new Error(String(message.error ?? "\u5206\u79BB\u5931\u8D25")));
          return;
        }
        if (message.type === "fatal") {
          const detail = String(message.error ?? "\u5206\u79BB\u8FDB\u7A0B\u542F\u52A8\u5931\u8D25");
          fail(new Error(detail + (this.workerStderr ? "\uFF1A" + this.lastWorkerError() : "")));
        }
      });
      worker.on("error", (error) => {
        fail(error instanceof Error ? error : new Error(String(error)));
      });
      worker.on("exit", (code, signal) => {
        const detail = "\u5206\u79BB\u8FDB\u7A0B\u5DF2\u9000\u51FA\uFF08" + (signal ?? code ?? "unknown") + "\uFF09";
        if (!settled) fail(new Error(detail + (this.workerStderr ? "\uFF1A" + this.lastWorkerError() : "")));
        else {
          this.worker = void 0;
          this.ready = void 0;
          this.failPending(new Error(detail));
        }
      });
      timer = setTimeout(() => {
        fail(new Error("\u5206\u79BB\u8FDB\u7A0B\u542F\u52A8\u8D85\u65F6"));
      }, 3e4);
      try {
        worker.send({
          type: "init",
          modelPath: this.modelPath,
          executionProviders: this.executionProviders,
          dmlDeviceId: this.dmlDeviceId
        });
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    this.ready = promise;
    void promise.catch(() => {
      if (this.ready === promise) this.ready = void 0;
    });
    return promise;
  }
  request(samples) {
    return this.ensureWorker().then(() => new Promise((resolve, reject) => {
      const worker = this.worker;
      if (!worker || !worker.connected) {
        reject(new Error("\u5206\u79BB\u8FDB\u7A0B\u4E0D\u53EF\u7528"));
        return;
      }
      const id = ++this.workerSeq;
      this.pending.set(id, { resolve, reject });
      worker.send({ type: "separate", id, samples }, (error) => {
        if (!error) return;
        const item = this.pending.get(id);
        if (!item) return;
        this.pending.delete(id);
        item.reject(error);
      });
    }));
  }
  async separate(samples) {
    if (samples.length === 0) throw new Error("\u6CA1\u6709\u53EF\u5206\u79BB\u7684\u8BED\u97F3");
    if (this.injectedRun) return separateWithRunner(samples, this.injectedRun);
    const run = this.chain.then(() => this.request(samples));
    this.chain = run.then(() => void 0, () => void 0);
    return run;
  }
  async close() {
    const worker = this.worker;
    this.worker = void 0;
    this.ready = void 0;
    this.failPending(new Error("\u5206\u79BB\u670D\u52A1\u5DF2\u5173\u95ED"));
    if (!worker) return;
    try {
      worker.kill();
    } catch {
    }
  }
}
function encodeWavBase64(samples) {
  const bytes = Buffer.alloc(44 + samples.length * 2);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36 + samples.length * 2, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(SAMPLE_RATE, 24);
  bytes.writeUInt32LE(SAMPLE_RATE * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    bytes.writeInt16LE(Math.round(value * (value < 0 ? 32768 : 32767)), 44 + i * 2);
  }
  return bytes.toString("base64");
}
export {
  SEPARATION_MODEL_BYTES,
  SEPARATION_MODEL_FILE,
  SeparationService,
  encodeWavBase64,
  planWindows,
  separateWithRunner,
  shouldSwap2 as shouldSwap
};
