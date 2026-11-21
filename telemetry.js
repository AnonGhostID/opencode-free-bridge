#!/usr/bin/env bun
/**
 * telemetry.js: zero-dependency persistent request stats and structured log
 * buffer for the opencode-free-bridge panel.
 *
 * Storage layout (sibling to WARP's `<stateDir>/warp/`):
 *   <stateDir>/telemetry/stats.json  — debounced atomic snapshot of totals,
 *                                      per-model stats, latency window, and
 *                                      1-hour activity buckets.
 *   <stateDir>/telemetry/logs.jsonl  — append-only NDJSON log with 2 MB
 *                                      single-file rotation (`logs.jsonl.1`).
 *
 * `<stateDir>` defaults to `OPENCODE_BRIDGE_STATE_DIR` or
 * `~/.opencode-free-bridge`, matching `warp.js`. Override the telemetry folder
 * directly with `OPENCODE_TELEMETRY_DIR`.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const MAX_LOGS = Math.max(50, parseInt(process.env.BRIDGE_LOG_LIMIT || "500", 10) || 500);
const MAX_LATENCY_SAMPLES = 500;
const BUCKET_MS = 5 * 60 * 1000;
const BUCKET_COUNT = 12;
const MAX_LOG_BYTES = Math.max(
  64 * 1024,
  parseInt(process.env.BRIDGE_LOG_MAX_BYTES || String(2 * 1024 * 1024), 10) || 2 * 1024 * 1024
);
const STATS_FLUSH_DEBOUNCE_MS = 1000;

// Process uptime is deliberately process-local: a restart must restart it.
// Persistent totals live in stats.json, but this timestamp never round-trips.
const startedAt = Date.now();
let nextLogId = 1;
let persistEnabled = false;
let statsDirty = false;
let flushTimer = null;

const totals = {
  requests: 0,
  ok: 0,
  errors: 0,
  rateLimited: 0,
  gateRejected: 0,
  inFlight: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  lastRequestAt: null,
};

/** @type {Map<string, object>} */
const byModel = new Map();
/** @type {Map<string, number>} */
const byEndpoint = new Map();
/** @type {number[]} */
const latencySamples = [];
/** @type {Map<number, { ok: number, errors: number }>} */
const activityBuckets = new Map();
/** @type {object[]} */
const logBuffer = [];
let totalLogsSeen = 0;

/** @type {Set<(entry: object) => void>} */
const subscribers = new Set();

function stateDir() {
  const raw = process.env.OPENCODE_BRIDGE_STATE_DIR;
  if (raw !== undefined && String(raw).trim()) return path.resolve(String(raw).trim());
  return path.join(os.homedir(), ".opencode-free-bridge");
}

function telemetryDir() {
  const raw = process.env.OPENCODE_TELEMETRY_DIR;
  if (raw !== undefined && String(raw).trim()) return path.resolve(String(raw).trim());
  return path.join(stateDir(), "telemetry");
}

function statsFile() {
  return path.join(telemetryDir(), "stats.json");
}

function logsFile() {
  return path.join(telemetryDir(), "logs.jsonl");
}

function rotatedLogsFile() {
  return path.join(telemetryDir(), "logs.jsonl.1");
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function ensureDir() {
  fs.mkdirSync(telemetryDir(), { recursive: true });
}

function rotateLogFile() {
  try {
    const src = logsFile();
    const dst = rotatedLogsFile();
    if (fs.existsSync(src)) {
      fs.renameSync(src, dst);
    }
  } catch {}
}

function appendLogToDisk(entry) {
  if (!persistEnabled) return;
  try {
    ensureDir();
    const file = logsFile();
    fs.appendFileSync(file, JSON.stringify(entry) + "\n", { encoding: "utf8", mode: 0o600 });
    try {
      const size = fs.statSync(file).size;
      if (size > MAX_LOG_BYTES) rotateLogFile();
    } catch {}
  } catch {}
}

function writeStatsToDisk() {
  if (!persistEnabled) return;
  statsDirty = false;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  try {
    ensureDir();
    const snapshot = {
      version: 1,
      totals: {
        requests: totals.requests,
        ok: totals.ok,
        errors: totals.errors,
        rateLimited: totals.rateLimited,
        gateRejected: totals.gateRejected,
        promptTokens: totals.promptTokens,
        completionTokens: totals.completionTokens,
        totalTokens: totals.totalTokens,
        lastRequestAt: totals.lastRequestAt,
      },
      byModel: Array.from(byModel.values()),
      byEndpoint: Object.fromEntries(byEndpoint.entries()),
      latencySamples: latencySamples.slice(-MAX_LATENCY_SAMPLES),
      activityBuckets: Array.from(activityBuckets.entries()),
      totalLogsSeen,
      nextLogId,
    };
    const target = statsFile();
    const tmp = `${target}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, target);
  } catch {}
}

function scheduleStatsFlush() {
  if (!persistEnabled) return;
  statsDirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (statsDirty) writeStatsToDisk();
  }, STATS_FLUSH_DEBOUNCE_MS);
  if (typeof flushTimer.unref === "function") flushTimer.unref();
}

function flushSync() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (persistEnabled && statsDirty) {
    writeStatsToDisk();
  }
}

function parseLogLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const entries = [];
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (obj && typeof obj === "object" && obj.ts) entries.push(obj);
      } catch {}
    }
  } catch {}
  return entries;
}

/**
 * Enable disk persistence under `<stateDir>/telemetry/` and hydrate existing
 * stats and logs from disk if present. Safe to call at startup or in tests.
 */
function initPersistence({ enable = true } = {}) {
  persistEnabled = Boolean(enable);
  if (!persistEnabled) return { loadedStats: false, loadedLogs: 0, dir: telemetryDir() };

  let loadedStats = false;
  try {
    ensureDir();
  } catch {}

  // 1. Hydrate stats.json
  try {
    const file = statsFile();
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object") {
        const t = parsed.totals || {};
        totals.requests = Math.round(toNum(t.requests));
        totals.ok = Math.round(toNum(t.ok));
        totals.errors = Math.round(toNum(t.errors));
        totals.rateLimited = Math.round(toNum(t.rateLimited));
        totals.gateRejected = Math.round(toNum(t.gateRejected));
        totals.promptTokens = Math.round(toNum(t.promptTokens));
        totals.completionTokens = Math.round(toNum(t.completionTokens));
        totals.totalTokens = Math.round(toNum(t.totalTokens));
        totals.lastRequestAt = Number.isFinite(Number(t.lastRequestAt))
          ? Number(t.lastRequestAt)
          : null;

        byModel.clear();
        if (Array.isArray(parsed.byModel)) {
          for (const m of parsed.byModel) {
            if (!m || typeof m.model !== "string" || !m.model) continue;
            byModel.set(m.model, {
              model: m.model,
              requests: Math.round(toNum(m.requests)),
              ok: Math.round(toNum(m.ok)),
              errors: Math.round(toNum(m.errors)),
              rateLimited: Math.round(toNum(m.rateLimited)),
              promptTokens: Math.round(toNum(m.promptTokens)),
              completionTokens: Math.round(toNum(m.completionTokens)),
              totalTokens: Math.round(toNum(m.totalTokens)),
              latencySumMs: Math.round(toNum(m.latencySumMs)),
              lastUsedAt: Number.isFinite(Number(m.lastUsedAt)) ? Number(m.lastUsedAt) : null,
            });
          }
        }

        byEndpoint.clear();
        if (parsed.byEndpoint && typeof parsed.byEndpoint === "object") {
          for (const [k, v] of Object.entries(parsed.byEndpoint)) {
            byEndpoint.set(k, Math.round(toNum(v)));
          }
        }

        latencySamples.length = 0;
        if (Array.isArray(parsed.latencySamples)) {
          for (const v of parsed.latencySamples.slice(-MAX_LATENCY_SAMPLES)) {
            latencySamples.push(Math.round(toNum(v)));
          }
        }

        activityBuckets.clear();
        if (Array.isArray(parsed.activityBuckets)) {
          for (const pair of parsed.activityBuckets) {
            if (!Array.isArray(pair) || pair.length < 2) continue;
            const ts = Number(pair[0]);
            const b = pair[1];
            if (Number.isFinite(ts) && b && typeof b === "object") {
              activityBuckets.set(ts, {
                ok: Math.round(toNum(b.ok)),
                errors: Math.round(toNum(b.errors)),
              });
            }
          }
          pruneBuckets(Date.now());
        }

        if (Number.isFinite(Number(parsed.totalLogsSeen))) {
          totalLogsSeen = Math.max(totalLogsSeen, Math.round(toNum(parsed.totalLogsSeen)));
        }
        if (Number.isFinite(Number(parsed.nextLogId))) {
          nextLogId = Math.max(nextLogId, Math.round(toNum(parsed.nextLogId)));
        }
        loadedStats = true;
      }
    }
  } catch {}

  // 2. Hydrate logs.jsonl (plus logs.jsonl.1 if needed to fill up to MAX_LOGS)
  logBuffer.length = 0;
  const currentEntries = parseLogLines(logsFile());
  let combined = currentEntries;
  if (combined.length < MAX_LOGS && fs.existsSync(rotatedLogsFile())) {
    const older = parseLogLines(rotatedLogsFile());
    combined = older.concat(currentEntries);
  }
  const tail = combined.slice(-MAX_LOGS);
  for (const e of tail) {
    logBuffer.push(e);
    if (Number.isFinite(Number(e.id)) && Number(e.id) >= nextLogId) {
      nextLogId = Number(e.id) + 1;
    }
  }
  totalLogsSeen = Math.max(totalLogsSeen, combined.length);

  return { loadedStats, loadedLogs: logBuffer.length, dir: telemetryDir() };
}

function setPersistence(enable) {
  persistEnabled = Boolean(enable);
  if (!persistEnabled && flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

function emitLog(entry) {
  logBuffer.push(entry);
  totalLogsSeen += 1;
  while (logBuffer.length > MAX_LOGS) {
    logBuffer.shift();
  }
  appendLogToDisk(entry);
  for (const fn of subscribers) {
    try {
      fn(entry);
    } catch {}
  }
}

function beginRequest() {
  totals.inFlight += 1;
}

function endRequest() {
  if (totals.inFlight > 0) totals.inFlight -= 1;
}

function pruneBuckets(now) {
  const cutoff = Math.floor(now / BUCKET_MS) * BUCKET_MS - (BUCKET_COUNT - 1) * BUCKET_MS;
  for (const ts of activityBuckets.keys()) {
    if (ts < cutoff) activityBuckets.delete(ts);
  }
}

function recordEndpointHit(pathname) {
  const key = String(pathname || "/");
  byEndpoint.set(key, (byEndpoint.get(key) || 0) + 1);
  scheduleStatsFlush();
}

/**
 * Record a completed inference request in both stats and the log buffer.
 */
function recordRequest(info = {}) {
  const now = Date.now();
  const status = Number.isFinite(Number(info.status)) ? Number(info.status) : 0;
  const ok = status >= 200 && status < 300;
  const latencyMs = Math.max(0, Math.round(toNum(info.latencyMs)));
  const promptTokens = Math.round(toNum(info.promptTokens));
  const completionTokens = Math.round(toNum(info.completionTokens));
  const totalTokens = Math.round(
    toNum(info.totalTokens) || promptTokens + completionTokens
  );
  const model = String(info.model || "(unknown)");
  const reqPath = String(info.path || "/v1/chat/completions");
  const method = String(info.method || "POST");

  totals.requests += 1;
  if (ok) totals.ok += 1;
  else totals.errors += 1;
  if (status === 429) totals.rateLimited += 1;
  if (status === 403 || status === 426) totals.gateRejected += 1;
  totals.promptTokens += promptTokens;
  totals.completionTokens += completionTokens;
  totals.totalTokens += totalTokens;
  totals.lastRequestAt = now;

  byEndpoint.set(reqPath, (byEndpoint.get(reqPath) || 0) + 1);

  latencySamples.push(latencyMs);
  while (latencySamples.length > MAX_LATENCY_SAMPLES) {
    latencySamples.shift();
  }

  let m = byModel.get(model);
  if (!m) {
    m = {
      model,
      requests: 0,
      ok: 0,
      errors: 0,
      rateLimited: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      latencySumMs: 0,
      lastUsedAt: null,
    };
    byModel.set(model, m);
  }
  m.requests += 1;
  if (ok) m.ok += 1;
  else m.errors += 1;
  if (status === 429) m.rateLimited += 1;
  m.promptTokens += promptTokens;
  m.completionTokens += completionTokens;
  m.totalTokens += totalTokens;
  m.latencySumMs += latencyMs;
  m.lastUsedAt = now;

  const bucketTs = Math.floor(now / BUCKET_MS) * BUCKET_MS;
  let bucket = activityBuckets.get(bucketTs);
  if (!bucket) {
    bucket = { ok: 0, errors: 0 };
    activityBuckets.set(bucketTs, bucket);
  }
  if (ok) bucket.ok += 1;
  else bucket.errors += 1;
  pruneBuckets(now);

  scheduleStatsFlush();

  const level = ok ? "info" : status >= 500 || status === 0 ? "error" : "warn";
  const entry = {
    id: nextLogId++,
    ts: now,
    time: new Date(now).toISOString(),
    kind: "request",
    level,
    method,
    path: reqPath,
    model,
    stream: Boolean(info.stream),
    status,
    latencyMs,
    promptTokens,
    completionTokens,
    totalTokens,
    egress: String(info.egress || "direct"),
    protocol: String(info.protocol || "chat"),
    error: info.error ? String(info.error).slice(0, 300) : null,
    logId: info.logId ? String(info.logId) : null,
  };
  emitLog(entry);
  return entry;
}

/**
 * Record a system/bridge log line (e.g. startup, discovery, WARP, retries).
 */
function recordSystemLog(level, message) {
  const now = Date.now();
  const normalizedLevel =
    level === "error" || level === "warn" ? level : "info";
  const text = String(message || "").trim();
  if (!text) return null;
  const entry = {
    id: nextLogId++,
    ts: now,
    time: new Date(now).toISOString(),
    kind: "system",
    level: normalizedLevel,
    message: text.slice(0, 600),
  };
  emitLog(entry);
  return entry;
}

let consoleHookInstalled = false;

function formatArgs(args) {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return a.message || String(a);
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

/**
 * Mirror console output into the panel log buffer without altering
 * stdout/stderr behavior. Safe to call multiple times.
 */
function installConsoleHook() {
  if (consoleHookInstalled) return;
  consoleHookInstalled = true;
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);
  let inside = false;

  const wrap = (orig, level) => (...args) => {
    orig(...args);
    if (inside) return;
    inside = true;
    try {
      const msg = formatArgs(args);
      if (msg) recordSystemLog(level, msg);
    } catch {
      // Never break logging
    } finally {
      inside = false;
    }
  };

  console.log = wrap(origLog, "info");
  console.warn = wrap(origWarn, "warn");
  console.error = wrap(origError, "error");
}

function computeLatencyMetrics() {
  if (latencySamples.length === 0) {
    return { avgLatencyMs: 0, p95LatencyMs: 0 };
  }
  let sum = 0;
  for (const v of latencySamples) sum += v;
  const sorted = latencySamples.slice().sort((a, b) => a - b);
  const p95Idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return {
    avgLatencyMs: Math.round(sum / latencySamples.length),
    p95LatencyMs: sorted[p95Idx],
  };
}

function getActivitySeries(now = Date.now()) {
  pruneBuckets(now);
  const currentBucket = Math.floor(now / BUCKET_MS) * BUCKET_MS;
  const series = [];
  for (let i = BUCKET_COUNT - 1; i >= 0; i--) {
    const ts = currentBucket - i * BUCKET_MS;
    const b = activityBuckets.get(ts) || { ok: 0, errors: 0 };
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    series.push({
      ts,
      label: `${hh}:${mm}`,
      ok: b.ok,
      errors: b.errors,
    });
  }
  return series;
}

function getStats() {
  const now = Date.now();
  const { avgLatencyMs, p95LatencyMs } = computeLatencyMetrics();
  const successRate =
    totals.requests > 0
      ? Math.round((totals.ok / totals.requests) * 1000) / 10
      : 100;

  const models = Array.from(byModel.values())
    .map((m) => ({
      model: m.model,
      requests: m.requests,
      ok: m.ok,
      errors: m.errors,
      rateLimited: m.rateLimited,
      promptTokens: m.promptTokens,
      completionTokens: m.completionTokens,
      totalTokens: m.totalTokens,
      avgLatencyMs: m.requests > 0 ? Math.round(m.latencySumMs / m.requests) : 0,
      lastUsedAt: m.lastUsedAt,
    }))
    .sort((a, b) => b.requests - a.requests || a.model.localeCompare(b.model));

  const endpoints = {};
  for (const [k, v] of byEndpoint.entries()) endpoints[k] = v;

  return {
    startedAt: new Date(startedAt).toISOString(),
    uptimeMs: Math.max(0, now - startedAt),
    persisted: persistEnabled,
    storageDir: telemetryDir(),
    totals: {
      requests: totals.requests,
      ok: totals.ok,
      errors: totals.errors,
      rateLimited: totals.rateLimited,
      gateRejected: totals.gateRejected,
      inFlight: totals.inFlight,
      promptTokens: totals.promptTokens,
      completionTokens: totals.completionTokens,
      totalTokens: totals.totalTokens,
      avgLatencyMs,
      p95LatencyMs,
      successRate,
      lastRequestAt: totals.lastRequestAt,
    },
    byModel: models,
    byEndpoint: endpoints,
    activity: getActivitySeries(now),
  };
}

function getLogs({ limit = 200, level = "all", kind = "all", model = "", q = "" } = {}) {
  const max = Math.min(MAX_LOGS, Math.max(1, parseInt(limit, 10) || 200));
  const lvl = String(level || "all").toLowerCase();
  const knd = String(kind || "all").toLowerCase();
  const mdl = String(model || "").trim().toLowerCase();
  const query = String(q || "").trim().toLowerCase();

  const filtered = [];
  for (let i = logBuffer.length - 1; i >= 0 && filtered.length < max; i--) {
    const e = logBuffer[i];
    if (lvl !== "all" && e.level !== lvl) continue;
    if (knd !== "all" && e.kind !== knd) continue;
    if (mdl && (!e.model || !e.model.toLowerCase().includes(mdl))) continue;
    if (query) {
      const hay = [
        e.message || "",
        e.model || "",
        e.path || "",
        e.error || "",
        e.logId || "",
        String(e.status || ""),
        e.egress || "",
      ]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(query)) continue;
    }
    filtered.push(e);
  }

  return {
    entries: filtered,
    buffered: logBuffer.length,
    total: totalLogsSeen,
    limit: MAX_LOGS,
    persisted: persistEnabled,
    logFile: logsFile(),
  };
}

function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function resetStats() {
  totals.requests = 0;
  totals.ok = 0;
  totals.errors = 0;
  totals.rateLimited = 0;
  totals.gateRejected = 0;
  totals.promptTokens = 0;
  totals.completionTokens = 0;
  totals.totalTokens = 0;
  totals.lastRequestAt = null;
  byModel.clear();
  byEndpoint.clear();
  latencySamples.length = 0;
  activityBuckets.clear();
  if (persistEnabled) writeStatsToDisk();
}

function clearLogs() {
  logBuffer.length = 0;
  totalLogsSeen = 0;
  if (persistEnabled) {
    try {
      ensureDir();
      fs.writeFileSync(logsFile(), "", { encoding: "utf8", mode: 0o600 });
      if (fs.existsSync(rotatedLogsFile())) fs.unlinkSync(rotatedLogsFile());
    } catch {}
    writeStatsToDisk();
  }
}

module.exports = {
  MAX_LOGS,
  MAX_LOG_BYTES,
  stateDir,
  telemetryDir,
  statsFile,
  logsFile,
  rotatedLogsFile,
  initPersistence,
  setPersistence,
  flushSync,
  beginRequest,
  endRequest,
  recordEndpointHit,
  recordRequest,
  recordSystemLog,
  installConsoleHook,
  getStats,
  getLogs,
  subscribe,
  resetStats,
  clearLogs,
};
