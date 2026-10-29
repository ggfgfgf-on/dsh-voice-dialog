import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { request as httpsRequest } from "node:https";
import { pipeline } from "node:stream/promises";
import * as httpsProxyAgent from "https-proxy-agent";
import { decideSpeakerGate, selectSpeechWindows } from "./separation-gate.js";
import { decideSpeaker, OWNER_PLAUSIBLE_FLOOR } from "./speaker-policy.js";
const require2 = createRequire(import.meta.url);
const MODEL_FILE = "3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx";
const MODEL_URLS = [
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/" + MODEL_FILE,
  "https://huggingface.co/csukuangfj/speaker-embedding-models/resolve/main/" + MODEL_FILE
];
const SAMPLE_RATE = 16e3;
const MIN_ENROLL_SAMPLES = SAMPLE_RATE;
const MIN_IDENTIFY_SAMPLES = Math.floor(SAMPLE_RATE * 0.35);
const MIN_PAIR_SAMPLES = Math.floor(SAMPLE_RATE * 0.5);
const DEFAULT_THRESHOLD = 0.5;
const CLUSTER_THRESHOLD = 0.55;
const MAX_CLUSTERS = 4;
const OWNER_ADAPT_WEIGHT = 0.1;
const OWNER_SOFT_ADAPT_WEIGHT = 0.03;
const OWNER_GUEST_MARGIN = 0.12;
const OWNER_PRIORITY_FLOOR = 0.5;
const OWNER_STRONG_MARGIN = 0.15;
const OWNER_STRONG_EXTRA = OWNER_STRONG_MARGIN - OWNER_GUEST_MARGIN;
const OWNER_MARGIN_MIN = 0.04;
const OWNER_MARGIN_MAX = 0.3;
const MAX_SESSION_LABELS = 128;
const NAMED_THRESHOLD_FLOOR = 0.55;
const MAX_NAMED_SPEAKERS = 12;
const MAX_SPEAKER_NAME = 12;
function normalize(vector) {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) sum += vector[i] * vector[i];
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm) || norm <= 1e-12) throw new Error("\u58F0\u7EB9\u7279\u5F81\u4E3A\u7A7A\uFF0C\u8BF7\u91CD\u65B0\u5F55\u97F3");
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = vector[i] / norm;
  return out;
}
function clampMargin(value) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return OWNER_GUEST_MARGIN;
  return Math.min(OWNER_MARGIN_MAX, Math.max(OWNER_MARGIN_MIN, Math.round(number * 100) / 100));
}
const DECISION_LOG = join(tmpdir(), "dsh-voice-voiceprint.jsonl");
const DECISION_LOG_LIMIT = 8 * 1024 * 1024;
function noteDecision(entry) {
  try {
    try {
      if (statSync(DECISION_LOG).size > DECISION_LOG_LIMIT) return;
    } catch {
    }
    appendFileSync(DECISION_LOG, JSON.stringify(entry) + "\n", "utf8");
  } catch {
  }
}
function cosineSimilarity(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}
function decodeWavBase64(base64) {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("\u58F0\u7EB9\u97F3\u9891\u683C\u5F0F\u4E0D\u662F WAV");
  }
  let offset = 12;
  let format;
  let data;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = Math.min(bytes.length, start + size);
    if (id === "fmt " && size >= 16) {
      format = {
        channels: bytes.readUInt16LE(start + 2),
        sampleRate: bytes.readUInt32LE(start + 4),
        bits: bytes.readUInt16LE(start + 14)
      };
    }
    if (id === "data") data = bytes.subarray(start, end);
    offset = start + size + size % 2;
  }
  if (!format || !data) throw new Error("\u58F0\u7EB9\u97F3\u9891\u7F3A\u5C11 fmt/data \u5757");
  if (format.channels !== 1 || format.sampleRate !== SAMPLE_RATE || format.bits !== 16) {
    throw new Error("\u58F0\u7EB9\u97F3\u9891\u5FC5\u987B\u662F 16 kHz \u5355\u58F0\u9053 16 \u4F4D");
  }
  const samples = new Float32Array(Math.floor(data.length / 2));
  for (let i = 0; i < samples.length; i++) samples[i] = data.readInt16LE(i * 2) / 32768;
  return samples;
}
function cleanSpeakerName(value) {
  if (typeof value !== "string") throw new Error("\u58F0\u7EB9\u540D\u5B57\u5FC5\u987B\u662F\u6587\u5B57");
  const name = value.trim();
  if (!name) throw new Error("\u8BF7\u7ED9\u8FD9\u4E2A\u58F0\u7EB9\u8D77\u4E2A\u540D\u5B57");
  if ([...name].length > MAX_SPEAKER_NAME) throw new Error("\u58F0\u7EB9\u540D\u5B57\u6700\u591A " + MAX_SPEAKER_NAME + " \u4E2A\u5B57");
  if (name === "\u6211" || name === "*") throw new Error("\u8FD9\u4E2A\u540D\u5B57\u4E0D\u80FD\u7528\u4F5C\u5176\u4ED6\u4EBA\u7684\u58F0\u7EB9");
  if (/[\[\]\r\n:：]/u.test(name)) throw new Error("\u58F0\u7EB9\u540D\u5B57\u4E0D\u80FD\u5305\u542B\u62EC\u53F7\u3001\u5192\u53F7\u6216\u6362\u884C");
  if (/^(?:客人|说话人)\d+$/u.test(name)) throw new Error("\u8FD9\u4E2A\u540D\u5B57\u5BB9\u6613\u548C\u4E34\u65F6\u58F0\u7EB9\u7F16\u53F7\u6DF7\u6DC6");
  return name;
}
function proxyUrl() {
  const raw = process.env.DSH_VOICE_MODEL_PROXY ?? process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
  if (!raw || !/^https?:\/\//i.test(raw.trim())) return void 0;
  return raw.trim();
}
function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) {
      reject(new Error("\u58F0\u7EB9\u6A21\u578B\u4E0B\u8F7D\u91CD\u5B9A\u5411\u8FC7\u591A"));
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
        reject(new Error("\u4E0B\u8F7D\u58F0\u7EB9\u6A21\u578B\u5931\u8D25\uFF08HTTP " + status + "\uFF09"));
        return;
      }
      const out = createWriteStream(dest);
      pipeline(res, out).then(() => resolve(), reject);
    });
    req.on("error", reject);
    req.setTimeout(18e4, () => {
      req.destroy(new Error("\u58F0\u7EB9\u6A21\u578B\u4E0B\u8F7D\u8D85\u65F6"));
    });
  });
}
class VoiceprintService {
  dataDir;
  modelPath;
  extractor;
  extractorError;
  owner;
  ownerUpdates = 0;
  speakersCache;
  clusters = /* @__PURE__ */ new Map();
  lastSpeakerLabels = /* @__PURE__ */ new Map();
  chain = Promise.resolve();
  injectedExtractor;
  /** Scores behind the most recent decision, logged by identify(). */
  lastDecision;
  constructor(options = {}) {
    this.dataDir = options.dataDir ?? join(homedir(), ".dsh", "voice-dialog");
    this.modelPath = options.modelPath ?? process.env.DSH_VOICE_MODEL ?? join(this.dataDir, "models", MODEL_FILE);
    this.injectedExtractor = options.extractor;
  }
  get storePath() {
    return join(this.dataDir, "voiceprint.json");
  }
  readStore() {
    try {
      const raw = JSON.parse(readFileSync(this.storePath, "utf8"));
      return raw && typeof raw === "object" ? raw : {};
    } catch {
      return {};
    }
  }
  writeStore(store) {
    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(this.storePath, JSON.stringify(store), "utf8");
    this.speakersCache = void 0;
  }
  /** Named guests are persisted; embeddings never leave this machine. */
  loadSpeakers() {
    if (this.speakersCache) return this.speakersCache;
    const raw = this.readStore();
    const list = Array.isArray(raw.speakers) ? raw.speakers : [];
    this.speakersCache = list.filter((item) => Boolean(
      item && typeof item.id === "string" && item.id && typeof item.name === "string" && item.name.trim() && Array.isArray(item.embedding) && item.embedding.length >= 64 && typeof item.updatedAt === "string"
    ));
    return this.speakersCache;
  }
  speakerProfiles() {
    return this.loadSpeakers().map((item) => ({ id: item.id, name: item.name, updatedAt: item.updatedAt }));
  }
  bestNamed(speakers, embedding) {
    let best;
    let bestSimilarity = -1;
    for (const speaker of speakers) {
      const vector = Float32Array.from(speaker.embedding);
      if (vector.length !== embedding.length) continue;
      const similarity = cosineSimilarity(embedding, vector);
      if (similarity > bestSimilarity) {
        best = speaker;
        bestSimilarity = similarity;
      }
    }
    return { speaker: best, similarity: bestSimilarity };
  }
  status() {
    let addonAvailable = false;
    try {
      require2.resolve("sherpa-onnx-node");
      addonAvailable = true;
    } catch {
    }
    let modelBytes = 0;
    try {
      modelBytes = statSync(this.modelPath).size;
    } catch {
    }
    let enrolled = false;
    try {
      enrolled = this.ownerEmbedding() !== null;
    } catch {
    }
    const speakers = this.speakerProfiles();
    const ready = this.injectedExtractor !== void 0 || addonAvailable && modelBytes > 1e6;
    return {
      addonAvailable,
      modelPresent: modelBytes > 1e6,
      enrolled,
      ready,
      modelPath: this.modelPath,
      modelBytes,
      speakers,
      speakerCount: speakers.length,
      ...this.extractor?.dim ? { embeddingDim: this.extractor.dim } : {},
      ...addonAvailable ? {} : { error: "\u7F3A\u5C11\u672C\u5730\u58F0\u7EB9\u7EC4\u4EF6 sherpa-onnx-node" }
    };
  }
  loadSherpa() {
    try {
      return require2("sherpa-onnx-node");
    } catch (error) {
      throw new Error("\u65E0\u6CD5\u52A0\u8F7D\u672C\u5730\u58F0\u7EB9\u7EC4\u4EF6\uFF1A" + (error instanceof Error ? error.message : String(error)));
    }
  }
  ensureExtractor() {
    if (this.injectedExtractor) return this.injectedExtractor;
    if (this.extractor) return this.extractor;
    if (this.extractorError) throw new Error(this.extractorError);
    if (!existsSync(this.modelPath) || statSync(this.modelPath).size < 1e6) {
      throw new Error("\u58F0\u7EB9\u6A21\u578B\u672A\u5B89\u88C5\uFF0C\u8BF7\u5728\u8BBE\u7F6E\u9875\u4E0B\u8F7D");
    }
    try {
      const sherpa = this.loadSherpa();
      this.extractor = new sherpa.SpeakerEmbeddingExtractor({
        model: this.modelPath,
        numThreads: 1,
        debug: false
      });
      return this.extractor;
    } catch (error) {
      this.extractorError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }
  /** Load the native model before the first utterance, without blocking startup. */
  warm() {
    if (this.status().ready) this.ensureExtractor();
  }
  /**
   * Conservative single-vs-overlap probe for the separation fast path.
   *
   * It only compares two chunks from the same utterance; it never updates the
   * owner template or creates guest clusters. A caller must treat anything
   * other than `singleSpeaker === true` as "run separation".
   */
  async overlap(samples) {
    const selection = selectSpeechWindows(samples);
    const windows = selection.windows.map((window) => ({
      startMs: Math.round(window.startSample * 1e3 / SAMPLE_RATE),
      endMs: Math.round(window.endSample * 1e3 / SAMPLE_RATE)
    }));
    if (!this.status().ready) {
      return {
        ready: false,
        windows,
        activeMs: Math.round(selection.activeSamples * 1e3 / SAMPLE_RATE),
        suspected: true,
        singleSpeaker: false,
        confident: false,
        reason: "voiceprint-not-ready",
        threshold: 0.62
      };
    }
    if (selection.windows.length < 2) {
      return {
        ready: true,
        windows,
        activeMs: Math.round(selection.activeSamples * 1e3 / SAMPLE_RATE),
        suspected: true,
        singleSpeaker: false,
        confident: false,
        reason: "insufficient-audio",
        threshold: 0.62
      };
    }
    const embeddings = [];
    for (const window of selection.windows) embeddings.push(await this.compute(window.samples));
    const selfSimilarities = [cosineSimilarity(embeddings[0], embeddings[1])];
    const owner = this.ownerEmbedding();
    const ownerSimilarity = owner === null ? void 0 : (cosineSimilarity(embeddings[0], owner) + cosineSimilarity(embeddings[1], owner)) / 2;
    const decision = decideSpeakerGate({ selfSimilarities, ...ownerSimilarity === void 0 ? {} : { ownerSimilarity } });
    return {
      ready: true,
      windows,
      activeMs: Math.round(selection.activeSamples * 1e3 / SAMPLE_RATE),
      ...decision
    };
  }
  async prepare() {
    if (existsSync(this.modelPath) && statSync(this.modelPath).size > 1e6) return this.status();
    mkdirSync(dirname(this.modelPath), { recursive: true });
    let lastError;
    for (const url of MODEL_URLS) {
      const part = this.modelPath + ".part";
      try {
        await download(url, part);
        if (statSync(part).size < 1e6) throw new Error("\u4E0B\u8F7D\u7684\u58F0\u7EB9\u6A21\u578B\u4E0D\u5B8C\u6574");
        renameSync(part, this.modelPath);
        this.extractorError = void 0;
        return this.status();
      } catch (error) {
        lastError = error;
        try {
          unlinkSync(part);
        } catch {
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
  ownerEmbedding() {
    if (this.owner !== void 0) return this.owner;
    try {
      const raw = this.readStore();
      if (!Array.isArray(raw.embedding) || raw.embedding.length < 64) {
        this.owner = null;
        this.ownerUpdates = 0;
        return null;
      }
      this.ownerUpdates = typeof raw.updates === "number" && Number.isInteger(raw.updates) && raw.updates >= 0 ? raw.updates : 0;
      this.owner = normalize(Float32Array.from(raw.embedding));
      return this.owner;
    } catch {
      this.owner = null;
      this.ownerUpdates = 0;
      return null;
    }
  }
  saveOwner() {
    const owner = this.owner;
    if (!owner) return;
    try {
      const stored = this.readStore();
      stored.embedding = Array.from(owner);
      stored.updates = this.ownerUpdates;
      stored.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      this.writeStore(stored);
    } catch {
    }
  }
  /** Update the normalized owner template with a deliberately small EWMA step. */
  adaptOwner(embedding, weight) {
    const owner = this.ownerEmbedding();
    if (!owner || owner.length !== embedding.length) return;
    const merged = new Float32Array(owner.length);
    for (let i = 0; i < owner.length; i++) {
      merged[i] = owner[i] * (1 - weight) + embedding[i] * weight;
    }
    this.owner = normalize(merged);
    this.ownerUpdates += 1;
    this.saveOwner();
  }
  bestGuest(sessionId, embedding, exclude) {
    let best;
    let bestSimilarity = -1;
    for (const cluster of this.clusters.get(sessionId) ?? []) {
      if (exclude.has(cluster.label)) continue;
      const similarity = cosineSimilarity(embedding, cluster.centroid);
      if (similarity > bestSimilarity) {
        best = cluster;
        bestSimilarity = similarity;
      }
    }
    return { cluster: best, similarity: bestSimilarity };
  }
  sessionClusters(sessionId) {
    let list = this.clusters.get(sessionId);
    if (!list) {
      list = [];
      this.clusters.set(sessionId, list);
      if (this.clusters.size > 64) {
        const oldest = this.clusters.keys().next().value;
        if (oldest !== void 0) this.clusters.delete(oldest);
      }
    }
    return list;
  }
  rememberLabel(sessionId, label) {
    this.lastSpeakerLabels.delete(sessionId);
    this.lastSpeakerLabels.set(sessionId, label);
    if (this.lastSpeakerLabels.size > MAX_SESSION_LABELS) {
      const oldest = this.lastSpeakerLabels.keys().next().value;
      if (oldest !== void 0) this.lastSpeakerLabels.delete(oldest);
    }
  }
  compute(samples) {
    const run = this.chain.then(() => {
      const extractor = this.ensureExtractor();
      const stream = extractor.createStream();
      stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
      return normalize(extractor.compute(stream));
    });
    this.chain = run.then(() => void 0, () => void 0);
    return run;
  }
  /**
   * Cosine similarity between two clips. A "separation" that only splits one
   * voice into two complementary halves embeds both halves to the same
   * speaker, so this rejects it instead of transcribing the same words twice.
   */
  async pairSimilarity(first, second) {
    if (first.length < MIN_PAIR_SAMPLES || second.length < MIN_PAIR_SAMPLES) return 0;
    const a = await this.compute(first);
    const b = await this.compute(second);
    return cosineSimilarity(a, b);
  }
  async enroll(samples) {
    if (samples.length < MIN_ENROLL_SAMPLES) throw new Error("\u5F55\u97F3\u592A\u77ED\uFF0C\u8BF7\u8BF4\u6EE1\u4E24\u79D2\u518D\u8BD5");
    const embedding = await this.compute(samples);
    const stored = this.readStore();
    stored.embedding = Array.from(embedding);
    stored.updates = 0;
    stored.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    this.writeStore(stored);
    this.owner = embedding;
    this.ownerUpdates = 0;
    this.clusters.clear();
    this.lastSpeakerLabels.clear();
    return { dim: embedding.length };
  }
  /** Enroll one named guest. The owner template and other guests are preserved. */
  async enrollSpeaker(samples, name) {
    if (samples.length < MIN_ENROLL_SAMPLES) throw new Error("\u5F55\u97F3\u592A\u77ED\uFF0C\u8BF7\u8BF4\u6EE1\u4E24\u79D2\u518D\u8BD5");
    const clean = cleanSpeakerName(name);
    const speakers = this.loadSpeakers();
    if (speakers.length >= MAX_NAMED_SPEAKERS) throw new Error("\u6700\u591A\u53EA\u80FD\u5F55\u5165 " + MAX_NAMED_SPEAKERS + " \u4E2A\u5176\u4ED6\u4EBA\u7684\u58F0\u7EB9");
    if (speakers.some((item) => item.name.toLocaleLowerCase() === clean.toLocaleLowerCase())) {
      throw new Error("\u8FD9\u4E2A\u58F0\u7EB9\u540D\u5B57\u5DF2\u7ECF\u5B58\u5728");
    }
    const embedding = await this.compute(samples);
    const stored = this.readStore();
    const list = this.loadSpeakers().slice();
    const id = randomUUID();
    list.push({ id, name: clean, embedding: Array.from(embedding), updatedAt: (/* @__PURE__ */ new Date()).toISOString() });
    stored.speakers = list;
    this.writeStore(stored);
    return { id, name: clean, dim: embedding.length };
  }
  renameSpeaker(id, name) {
    const clean = cleanSpeakerName(name);
    if (!id) throw new Error("\u7F3A\u5C11\u58F0\u7EB9\u7F16\u53F7");
    const speakers = this.loadSpeakers();
    if (!speakers.some((item) => item.id === id)) throw new Error("\u627E\u4E0D\u5230\u8FD9\u4E2A\u58F0\u7EB9");
    if (speakers.some((item) => item.id !== id && item.name.toLocaleLowerCase() === clean.toLocaleLowerCase())) {
      throw new Error("\u8FD9\u4E2A\u58F0\u7EB9\u540D\u5B57\u5DF2\u7ECF\u5B58\u5728");
    }
    const stored = this.readStore();
    const updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    stored.speakers = speakers.map((item) => item.id === id ? { ...item, name: clean, updatedAt } : item);
    this.writeStore(stored);
    return { id, name: clean, updatedAt };
  }
  removeSpeaker(id) {
    if (!id) throw new Error("\u7F3A\u5C11\u58F0\u7EB9\u7F16\u53F7");
    const speakers = this.loadSpeakers();
    if (!speakers.some((item) => item.id === id)) throw new Error("\u627E\u4E0D\u5230\u8FD9\u4E2A\u58F0\u7EB9");
    const stored = this.readStore();
    stored.speakers = speakers.filter((item) => item.id !== id);
    this.writeStore(stored);
  }
  forget() {
    this.owner = null;
    this.ownerUpdates = 0;
    this.clusters.clear();
    this.lastSpeakerLabels.clear();
    const stored = this.readStore();
    delete stored.embedding;
    delete stored.updates;
    stored.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    if (stored.speakers && stored.speakers.length > 0) this.writeStore(stored);
    else {
      try {
        unlinkSync(this.storePath);
      } catch {
      }
    }
  }
  /** Public entry: decide who spoke, then log what the decision was based on. */
  async identify(samples, options = {}) {
    this.lastDecision = void 0;
    const identity = await this.identifyDecision(samples, options);
    noteDecision({
      at: (/* @__PURE__ */ new Date()).toISOString(),
      sessionId: (options.sessionId ?? "").trim() || "default",
      samples: samples.length,
      label: identity.label,
      owner: identity.owner,
      similarity: Number(identity.similarity.toFixed(4)),
      ...this.lastDecision
    });
    return identity;
  }
  async identifyDecision(samples, options = {}) {
    if (samples.length < MIN_IDENTIFY_SAMPLES) throw new Error("\u8FD9\u6BB5\u8BDD\u592A\u77ED\uFF0C\u65E0\u6CD5\u5224\u65AD\u58F0\u7EB9");
    const embedding = await this.compute(samples);
    const owner = this.ownerEmbedding();
    const threshold = Math.min(0.85, Math.max(0.3, options.threshold ?? DEFAULT_THRESHOLD));
    const sessionId = (options.sessionId ?? "").trim() || "default";
    if (owner === null) {
      const namedSpeakers2 = this.loadSpeakers();
      const named2 = this.bestNamed(namedSpeakers2, embedding);
      const namedThreshold2 = Math.max(NAMED_THRESHOLD_FLOOR, threshold);
      const decision2 = decideSpeaker({
        ownerEnrolled: false,
        ownerSimilarity: 0,
        threshold,
        namedSimilarity: named2.speaker === void 0 ? void 0 : named2.similarity,
        namedThreshold: namedThreshold2,
        marginToOwner: 0
      });
      this.lastDecision = {
        decision: decision2 === "named" ? "named" : "owner",
        ownerSimilarity: 0,
        threshold,
        marginToOwner: 0,
        namedName: named2.speaker?.name,
        namedSimilarity: named2.speaker === void 0 ? void 0 : named2.similarity,
        seeded: false,
        degraded: true
      };
      if (decision2 === "named" && named2.speaker) {
        this.rememberLabel(sessionId, named2.speaker.name);
        return { enrolled: false, owner: false, label: named2.speaker.name, similarity: named2.similarity };
      }
      this.rememberLabel(sessionId, "\u6211");
      return { enrolled: false, owner: true, label: "\u6211", similarity: 0 };
    }
    const exclude = new Set((options.excludeLabels ?? []).filter((label2) => typeof label2 === "string"));
    const guest = this.bestGuest(sessionId, embedding, exclude);
    const namedSpeakers = this.loadSpeakers();
    const named = this.bestNamed(namedSpeakers, embedding);
    const namedThreshold = Math.max(NAMED_THRESHOLD_FLOOR, threshold);
    const ownerSimilarity = owner === null ? 0 : cosineSimilarity(embedding, owner);
    const marginToOwner = clampMargin(options.margin) + (ownerSimilarity >= OWNER_PRIORITY_FLOOR ? OWNER_STRONG_EXTRA : 0);
    const decision = decideSpeaker({
      ownerEnrolled: owner !== null,
      ownerSimilarity,
      threshold,
      namedSimilarity: named.speaker === void 0 ? void 0 : named.similarity,
      namedThreshold,
      marginToOwner,
      ownerFloor: OWNER_PLAUSIBLE_FLOOR
    });
    this.lastDecision = {
      decision,
      ownerSimilarity,
      threshold,
      marginToOwner,
      namedName: named.speaker?.name,
      namedSimilarity: named.speaker === void 0 ? void 0 : named.similarity,
      clusterLabel: guest.cluster?.label,
      clusterSimilarity: guest.similarity
    };
    if (decision === "owner") {
      if (options.adapt !== false) {
        this.adaptOwner(embedding, ownerSimilarity >= threshold ? OWNER_ADAPT_WEIGHT : OWNER_SOFT_ADAPT_WEIGHT);
      }
      this.rememberLabel(sessionId, "\u6211");
      return { enrolled: true, owner: true, label: "\u6211", similarity: ownerSimilarity };
    }
    if (decision === "named" && named.speaker) {
      this.rememberLabel(sessionId, named.speaker.name);
      return { enrolled: true, owner: false, label: named.speaker.name, similarity: named.similarity };
    }
    const hasEnrollment = owner !== null || namedSpeakers.length > 0;
    const list = this.sessionClusters(sessionId);
    if (guest.cluster && guest.similarity >= CLUSTER_THRESHOLD) {
      const best = guest.cluster;
      const count = best.count + 1;
      const merged = new Float32Array(embedding.length);
      for (let i = 0; i < embedding.length; i++) {
        merged[i] = (best.centroid[i] * best.count + embedding[i]) / count;
      }
      best.centroid = normalize(merged);
      best.count = count;
      this.rememberLabel(sessionId, best.label);
      return { enrolled: hasEnrollment, owner: false, label: best.label, similarity: guest.similarity };
    }
    const prefix = owner ? "\u5BA2\u4EBA" : "\u8BF4\u8BDD\u4EBA";
    if (list.length < MAX_CLUSTERS) {
      const label2 = prefix + (list.length + 1);
      list.push({ label: label2, centroid: embedding, count: 1 });
      this.rememberLabel(sessionId, label2);
      return { enrolled: hasEnrollment, owner: false, label: label2, similarity: Math.max(0, guest.similarity) };
    }
    const label = owner ? "\u5176\u4ED6\u5BA2\u4EBA" : "\u5176\u4ED6\u8BF4\u8BDD\u4EBA";
    this.rememberLabel(sessionId, label);
    return { enrolled: hasEnrollment, owner: false, label, similarity: guest.similarity };
  }
}
export {
  MODEL_FILE,
  VoiceprintService,
  clampMargin,
  cosineSimilarity,
  decodeWavBase64
};
