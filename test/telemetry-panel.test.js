const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const telemetry = require("../telemetry");
const panel = require("../panel");
const bridge = require("../server");

function requestLocal(server, method, path, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        path,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      }
    );
    req.on("error", reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

describe("telemetry module", () => {
  beforeEach(() => {
    telemetry.resetStats();
    telemetry.clearLogs();
  });

  it("tracks totals, per-model breakdown, tokens, latency, and activity buckets", () => {
    telemetry.recordRequest({
      model: "mimo-v2.6-flash-free",
      status: 200,
      latencyMs: 120,
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      stream: true,
      egress: "warp",
    });
    telemetry.recordRequest({
      model: "mimo-v2.6-flash-free",
      status: 429,
      latencyMs: 40,
      egress: "warp",
      error: "FreeUsageLimitError",
    });
    telemetry.recordRequest({
      model: "big-pickle",
      status: 403,
      latencyMs: 80,
      egress: "direct",
      error: "FreeTierError",
      logId: "log-abc",
    });

    const stats = telemetry.getStats();
    assert.equal(stats.totals.requests, 3);
    assert.equal(stats.totals.ok, 1);
    assert.equal(stats.totals.errors, 2);
    assert.equal(stats.totals.rateLimited, 1);
    assert.equal(stats.totals.gateRejected, 1);
    assert.equal(stats.totals.promptTokens, 100);
    assert.equal(stats.totals.completionTokens, 50);
    assert.equal(stats.totals.totalTokens, 150);
    assert.equal(stats.totals.avgLatencyMs, 80);
    assert.equal(stats.byModel.length, 2);
    assert.equal(stats.byModel[0].model, "mimo-v2.6-flash-free");
    assert.equal(stats.byModel[0].requests, 2);
    assert.equal(stats.byModel[0].rateLimited, 1);
    assert.equal(stats.activity.length, 12);
    const lastBucket = stats.activity[stats.activity.length - 1];
    assert.equal(lastBucket.ok, 1);
    assert.equal(lastBucket.errors, 2);
  });

  it("filters logs by kind, level, model, and search query and notifies subscribers", () => {
    const received = [];
    const unsub = telemetry.subscribe((entry) => received.push(entry));
    telemetry.recordSystemLog("info", "[opencode-free-bridge] Boot complete");
    telemetry.recordRequest({
      model: "beam-free",
      status: 200,
      latencyMs: 210,
      egress: "direct",
    });
    telemetry.recordRequest({
      model: "big-pickle",
      status: 502,
      latencyMs: 50,
      error: "upstream stream failed",
    });
    unsub();

    assert.equal(received.length, 3);
    assert.equal(telemetry.getLogs({ kind: "system" }).entries.length, 1);
    assert.equal(telemetry.getLogs({ level: "error" }).entries.length, 1);
    assert.equal(telemetry.getLogs({ model: "beam" }).entries.length, 1);
    assert.equal(telemetry.getLogs({ q: "upstream stream" }).entries.length, 1);
  });
});

describe("panel & telemetry HTTP endpoints", () => {
  beforeEach(() => {
    telemetry.resetStats();
    telemetry.clearLogs();
  });

  it("renders panel HTML with Egress, Statistik, and Log tabs and escapes inputs", () => {
    const html = panel.renderPanel(
      { mode: "warp" },
      { version: '2.4.0<script>alert(1)</script>', port: "20129" }
    );
    assert.match(html, /id="panel-egress"/);
    assert.match(html, /id="panel-stats"/);
    assert.match(html, /id="panel-logs"/);
    assert.match(html, /\/api\/stats/);
    assert.match(html, /\/api\/logs\/stream/);
    assert.ok(!html.includes("<script>alert(1)</script>"));
  });

  it("serves /api/stats, /api/logs, reset/clear, and enforces admin CSRF/Host guards", async () => {
    const srv = http.createServer(bridge.handleRequest);
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    try {
      // Trigger a real 400 validation request to /v1/chat/completions to verify live capture
      const badReq = await requestLocal(srv, "POST", "/v1/chat/completions", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "", messages: [] }),
      });
      assert.equal(badReq.status, 400);

      // Stats endpoint returns recorded request
      const statsRes = await requestLocal(srv, "GET", "/api/stats");
      assert.equal(statsRes.status, 200);
      assert.equal(statsRes.json.totals.requests, 1);
      assert.equal(statsRes.json.totals.errors, 1);

      // Logs endpoint returns recorded request
      const logsRes = await requestLocal(srv, "GET", "/api/logs?kind=request");
      assert.equal(logsRes.status, 200);
      assert.equal(logsRes.json.entries.length, 1);
      assert.equal(logsRes.json.entries[0].status, 400);

      // Cross-site request must be rejected with 403
      const csrfRes = await requestLocal(srv, "GET", "/api/stats", {
        headers: { "Sec-Fetch-Site": "cross-site" },
      });
      assert.equal(csrfRes.status, 403);

      // Non-JSON POST to reset must be rejected with 415
      const badMime = await requestLocal(srv, "POST", "/api/stats/reset", {
        headers: { "Content-Type": "text/plain" },
        body: "{}",
      });
      assert.equal(badMime.status, 415);

      // Valid JSON POST resets stats and clears logs
      const resetRes = await requestLocal(srv, "POST", "/api/stats/reset", {
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      assert.equal(resetRes.status, 200);
      assert.equal(resetRes.json.totals.requests, 0);

      const clearRes = await requestLocal(srv, "POST", "/api/logs/clear", {
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      assert.equal(clearRes.status, 200);
      const afterClear = await requestLocal(srv, "GET", "/api/logs");
      assert.equal(afterClear.json.entries.length, 0);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

describe("telemetry disk persistence", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const warp = require("../warp");

  it("persists stats.json and logs.jsonl in <stateDir>/telemetry sibling to <stateDir>/warp", () => {
    const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), "ofb-state-"));
    const prevState = process.env.OPENCODE_BRIDGE_STATE_DIR;
    const prevTel = process.env.OPENCODE_TELEMETRY_DIR;
    const prevWarp = process.env.OPENCODE_WARP_HOME;
    try {
      process.env.OPENCODE_BRIDGE_STATE_DIR = tmpState;
      delete process.env.OPENCODE_TELEMETRY_DIR;
      delete process.env.OPENCODE_WARP_HOME;

      assert.equal(path.dirname(telemetry.telemetryDir()), path.dirname(warp.warpHome()));
      assert.equal(path.basename(warp.warpHome()), "warp");
      assert.equal(path.basename(telemetry.telemetryDir()), "telemetry");
      assert.notEqual(telemetry.telemetryDir(), warp.warpHome());

      telemetry.setPersistence(false);
      telemetry.resetStats();
      telemetry.clearLogs();
      telemetry.initPersistence({ enable: true });

      telemetry.recordRequest({
        model: "mimo-v2.6-flash-free",
        status: 200,
        latencyMs: 145,
        promptTokens: 200,
        completionTokens: 80,
        totalTokens: 280,
        egress: "warp",
      });
      telemetry.recordSystemLog("warn", "[opencode-free-bridge] test persistence log");
      telemetry.flushSync();

      assert.ok(fs.existsSync(telemetry.statsFile()));
      assert.ok(fs.existsSync(telemetry.logsFile()));

      // Simulate restart by clearing memory (with persistence off) then re-hydrating from disk
      telemetry.setPersistence(false);
      telemetry.resetStats();
      telemetry.clearLogs();
      assert.equal(telemetry.getStats().totals.requests, 0);
      assert.equal(telemetry.getLogs().entries.length, 0);

      const loaded = telemetry.initPersistence({ enable: true });
      assert.equal(loaded.loadedStats, true);
      assert.equal(loaded.loadedLogs, 2);
      assert.equal(telemetry.getStats().totals.requests, 1);
      assert.equal(telemetry.getStats().totals.totalTokens, 280);
      assert.equal(telemetry.getLogs().entries.length, 2);

      // Clear and reset also update disk
      telemetry.resetStats();
      telemetry.clearLogs();
      const afterClear = telemetry.initPersistence({ enable: true });
      assert.equal(afterClear.loadedLogs, 0);
      assert.equal(telemetry.getStats().totals.requests, 0);
    } finally {
      telemetry.setPersistence(false);
      if (prevState === undefined) delete process.env.OPENCODE_BRIDGE_STATE_DIR;
      else process.env.OPENCODE_BRIDGE_STATE_DIR = prevState;
      if (prevTel === undefined) delete process.env.OPENCODE_TELEMETRY_DIR;
      else process.env.OPENCODE_TELEMETRY_DIR = prevTel;
      if (prevWarp === undefined) delete process.env.OPENCODE_WARP_HOME;
      else process.env.OPENCODE_WARP_HOME = prevWarp;
      fs.rmSync(tmpState, { recursive: true, force: true });
    }
  });

  it("resets uptime on restart instead of rehydrating the previous start time", () => {
    const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), "ofb-uptime-"));
    const prevState = process.env.OPENCODE_BRIDGE_STATE_DIR;
    const prevTel = process.env.OPENCODE_TELEMETRY_DIR;
    try {
      process.env.OPENCODE_BRIDGE_STATE_DIR = tmpState;
      delete process.env.OPENCODE_TELEMETRY_DIR;

      telemetry.setPersistence(false);
      telemetry.resetStats();
      telemetry.initPersistence({ enable: true });

      // A previous run left stats behind, including a day-old start time.
      const oldStartedAt = Date.now() - 86_400_000;
      fs.mkdirSync(telemetry.telemetryDir(), { recursive: true });
      fs.writeFileSync(
        telemetry.statsFile(),
        JSON.stringify({
          version: 1,
          startedAt: oldStartedAt,
          totals: { requests: 7, ok: 7, totalTokens: 70 },
        })
      );

      const loaded = telemetry.initPersistence({ enable: true });
      assert.equal(loaded.loadedStats, true);
      const stats = telemetry.getStats();
      assert.equal(stats.totals.requests, 7, "persisted totals still load");
      assert.ok(
        stats.uptimeMs < 60_000,
        `uptime must restart at process start, got ${stats.uptimeMs} ms`
      );

      // Resetting stats is not a restart: uptime must not rewind.
      const beforeReset = telemetry.getStats().uptimeMs;
      telemetry.resetStats();
      assert.ok(
        telemetry.getStats().uptimeMs >= beforeReset,
        "resetStats must not rewind uptime"
      );
    } finally {
      telemetry.setPersistence(false);
      if (prevState === undefined) delete process.env.OPENCODE_BRIDGE_STATE_DIR;
      else process.env.OPENCODE_BRIDGE_STATE_DIR = prevState;
      if (prevTel === undefined) delete process.env.OPENCODE_TELEMETRY_DIR;
      else process.env.OPENCODE_TELEMETRY_DIR = prevTel;
      fs.rmSync(tmpState, { recursive: true, force: true });
    }
  });
});

describe("warp bugfixes", () => {
  const warp = require("../warp");

  it("probeIpHealth sends gate-safe headers, stream:true, read tool, and proxy option", async () => {
    const origFetch = global.fetch;
    let capturedUrl = null;
    let capturedOpts = null;
    global.fetch = async (url, opts) => {
      capturedUrl = url;
      capturedOpts = opts;
      return { status: 200, ok: true, body: { cancel: async () => {} } };
    };
    try {
      const res = await warp.probeIpHealth("http://127.0.0.1:41234");
      assert.equal(res.state, "clean");
      assert.equal(res.status, 200);
      assert.match(capturedUrl, /\/chat\/completions$/);
      assert.equal(capturedOpts.proxy, "http://127.0.0.1:41234");
      assert.equal(capturedOpts.headers.Authorization, "Bearer public");
      assert.match(capturedOpts.headers["User-Agent"], /^opencode\//i);
      assert.ok(capturedOpts.headers["x-opencode-session"]);
      const body = JSON.parse(capturedOpts.body);
      assert.equal(body.stream, true);
      assert.ok(body.tools.some((t) => t.function?.name === "read"));
    } finally {
      global.fetch = origFetch;
    }
  });

  it("/api/warp and /api/warp/progress return 403 JSON on cross-site requests instead of throwing", async () => {
    const srv = http.createServer(bridge.handleRequest);
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    try {
      const r1 = await requestLocal(srv, "GET", "/api/warp", {
        headers: { "Sec-Fetch-Site": "cross-site" },
      });
      assert.equal(r1.status, 403);
      assert.equal(typeof r1.json?.error, "string");

      const r2 = await requestLocal(srv, "GET", "/api/warp/progress", {
        headers: { "Sec-Fetch-Site": "cross-site" },
      });
      assert.equal(r2.status, 403);
      assert.equal(typeof r2.json?.error, "string");
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

describe("warp clean start / disable cleanup", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const warp = require("../warp");

  it("removes all WARP state/config/log files on disable while preserving wireproxy and wireproxy.exe", async () => {
    const tmpWarp = fs.mkdtempSync(path.join(os.tmpdir(), "ofb-warp-clean-"));
    const prevWarp = process.env.OPENCODE_WARP_HOME;
    try {
      process.env.OPENCODE_WARP_HOME = tmpWarp;
      // Seed files simulating an active WARP session
      fs.writeFileSync(path.join(tmpWarp, "wireproxy"), "elf-bin");
      fs.writeFileSync(path.join(tmpWarp, "wireproxy.exe"), "pe-bin");
      fs.writeFileSync(path.join(tmpWarp, "warp-device.json"), '{"id":"dev1"}');
      fs.writeFileSync(path.join(tmpWarp, "warp-burned.json"), '{"keys":{"1.2.3.4":1}}');
      fs.writeFileSync(path.join(tmpWarp, "warp-state.json"), '{"enabled":true}');
      fs.writeFileSync(path.join(tmpWarp, "warp-proxy-41234.conf"), "[Interface]\nPrivateKey=x\n");
      fs.writeFileSync(path.join(tmpWarp, "warp.log"), "line1\n");
      fs.writeFileSync(path.join(tmpWarp, "warp.log.1"), "old\n");

      warp.__setEnabledForTest(true);
      const res = await warp.setEnabled(false);
      assert.equal(res.ok, true);
      assert.equal(res.enabled, false);

      const remaining = fs.readdirSync(tmpWarp).sort();
      assert.deepEqual(remaining, ["wireproxy", "wireproxy.exe"]);
      assert.equal(warp.describe().device, null);
      assert.equal(warp.describe().burned, 0);
    } finally {
      warp.__setEnabledForTest(false);
      if (prevWarp === undefined) delete process.env.OPENCODE_WARP_HOME;
      else process.env.OPENCODE_WARP_HOME = prevWarp;
      fs.rmSync(tmpWarp, { recursive: true, force: true });
    }
  });
});
