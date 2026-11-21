#!/usr/bin/env bun
/**
 * panel.js: the browser operations panel served at `/`.
 *
 * Surfaces three tabs in one zero-dependency page:
 *   1. Egress: live egress mode, WARP toggle, live WARP console, client endpoint.
 *   2. Stats: request totals, success rate, token usage, latency (avg & p95),
 *      1-hour rolling activity chart, and per-model breakdown.
 *   3. Logs: real-time SSE + filterable ring buffer of inference requests and
 *      bridge system logs.
 *
 * Security invariant: no user-supplied or dynamic runtime value is interpolated
 * into raw HTML; the client populates every dynamic string with `textContent`.
 */

const STYLE = `
:root {
  color-scheme: light dark;
  --paper: #f7f5f1;
  --surface: #ffffff;
  --surface-alt: #f0ede7;
  --ink: #1c1a16;
  --muted: #5c574e;
  --rule: #cfc9bf;
  --field: #8d857a;
  --accent: #9a3f10;
  --accent-ink: #ffffff;
  --ok: #2c6a33;
  --warn: #a65d07;
  --bad: #9b2118;
}
@media (prefers-color-scheme: dark) {
  :root {
    --paper: #131211;
    --surface: #1b1a18;
    --surface-alt: #23211e;
    --ink: #ece7de;
    --muted: #a49c92;
    --rule: #3a3631;
    --field: #7a746a;
    --accent: #e39a63;
    --accent-ink: #1a1208;
    --ok: #7bc48a;
    --warn: #e5ad5b;
    --bad: #f08c82;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 32px 20px 64px;
  background: var(--paper);
  color: var(--ink);
  font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
main { max-width: 920px; margin: 0 auto; }
header {
  display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between;
  gap: 12px 20px;
  border-bottom: 1px solid var(--rule); padding-bottom: 16px; margin-bottom: 20px;
}
.brand h1 { font-size: 1.25rem; line-height: 1.3; margin: 0 0 4px; letter-spacing: -0.01em; }
.sub { margin: 0; color: var(--muted); font-size: 0.9rem; }
.header-meta {
  display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
  font-size: 0.8125rem; color: var(--muted);
}
.pill {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 10px; border: 1px solid var(--rule); border-radius: 999px;
  background: var(--surface); color: var(--ink);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.78rem;
}
.dot {
  width: 7px; height: 7px; border-radius: 50%; background: var(--muted);
  display: inline-block; flex-shrink: 0;
}
.dot.ok { background: var(--ok); }
.dot.warn { background: var(--warn); }
.dot.bad { background: var(--bad); }

/* Tabs */
.tabs {
  display: flex; gap: 6px; border-bottom: 1px solid var(--rule);
  margin-bottom: 24px; overflow-x: auto;
}
.tab-btn {
  font: inherit; font-size: 0.9rem; font-weight: 600;
  padding: 10px 16px; min-height: 42px;
  border: 1px solid transparent; border-bottom: 2px solid transparent;
  border-radius: 3px 3px 0 0;
  background: transparent; color: var(--muted); cursor: pointer;
  display: inline-flex; align-items: center; gap: 8px;
  margin-bottom: -1px; white-space: nowrap;
}
.tab-btn:hover { color: var(--ink); background: var(--surface-alt); }
.tab-btn[aria-selected="true"] {
  color: var(--ink);
  border-bottom-color: var(--accent);
  background: var(--surface);
  border-top-color: var(--rule);
  border-left-color: var(--rule);
  border-right-color: var(--rule);
}
.tab-badge {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.75rem; font-weight: 600;
  padding: 1px 6px; border-radius: 999px;
  background: var(--surface-alt); color: var(--muted);
}
.tab-btn[aria-selected="true"] .tab-badge {
  background: var(--accent); color: var(--accent-ink);
}
.tab-panel[hidden] { display: none; }

h2 {
  font-size: 0.8rem; font-weight: 600; letter-spacing: 0.04em;
  text-transform: uppercase; color: var(--muted); margin: 0 0 12px;
}
.section-head {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
  gap: 10px; margin-bottom: 12px;
}
.section-head h2 { margin: 0; }
section { margin-bottom: 28px; }
.hint { margin: 10px 0 14px; color: var(--muted); font-size: 0.9rem; }

.status {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 12px;
  padding: 14px 16px; border: 1px solid var(--rule); border-radius: 3px; background: var(--surface);
}
.status .mode { font-weight: 600; }
.status .mode[data-mode="warp"] { color: var(--ok); }
.status .mode[data-warp="on"] { color: var(--ok); }
.status .host { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9rem; }
.status .note { color: var(--muted); font-size: 0.85rem; width: 100%; }

.actions { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
button {
  font: inherit; font-size: 0.875rem; font-weight: 600;
  padding: 8px 14px; min-height: 38px;
  border: 1px solid var(--field); border-radius: 3px;
  background: var(--surface); color: var(--ink); cursor: pointer;
}
button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
button.small { padding: 5px 11px; min-height: 32px; font-size: 0.8125rem; }
button:disabled { opacity: 0.55; cursor: default; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.report { margin-top: 16px; font-size: 0.9rem; }
.report[hidden] { display: none; }
.report .line { margin: 0 0 4px; }
.report .ok { color: var(--ok); font-weight: 600; }
.report .bad { color: var(--bad); font-weight: 600; }
.report .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }

/* KPI cards */
.kpi-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(175px, 1fr));
  gap: 12px;
}
.kpi-card {
  padding: 14px 16px;
  border: 1px solid var(--rule); border-radius: 3px;
  background: var(--surface);
}
.kpi-label {
  font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.04em;
  color: var(--muted); margin: 0 0 6px;
}
.kpi-val {
  font-size: 1.45rem; font-weight: 700; line-height: 1.2; margin: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.kpi-val.ok { color: var(--ok); }
.kpi-val.warn { color: var(--warn); }
.kpi-val.bad { color: var(--bad); }
.kpi-sub {
  margin: 4px 0 0; font-size: 0.78rem; color: var(--muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

/* Activity bar strip */
.chart-card {
  padding: 16px; border: 1px solid var(--rule); border-radius: 3px;
  background: var(--surface);
}
.activity-bars {
  display: grid; grid-template-columns: repeat(12, 1fr);
  gap: 8px; align-items: end; height: 112px; padding-top: 8px;
}
.bar-col {
  display: flex; flex-direction: column; align-items: center; justify-content: flex-end;
  height: 100%; gap: 4px; min-width: 0;
}
.bar-stack {
  width: 100%; max-width: 32px; flex: 1;
  display: flex; flex-direction: column; justify-content: flex-end; gap: 1px;
  background: var(--surface-alt); border-radius: 2px; overflow: hidden;
}
.bar-seg-ok { background: var(--ok); width: 100%; transition: height 0.2s ease; }
.bar-seg-err { background: var(--bad); width: 100%; transition: height 0.2s ease; }
.bar-count {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.7rem; color: var(--muted); line-height: 1;
}
.bar-label {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.68rem; color: var(--muted); white-space: nowrap;
}
.chart-legend {
  display: flex; gap: 16px; margin-top: 10px; font-size: 0.8rem; color: var(--muted);
}
.legend-item { display: inline-flex; align-items: center; gap: 6px; }
.legend-swatch { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }

/* Tables */
.table-wrap {
  border: 1px solid var(--rule); border-radius: 3px;
  background: var(--surface); overflow-x: auto;
}
table {
  width: 100%; border-collapse: collapse; font-size: 0.875rem;
}
th, td {
  padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--rule);
  white-space: nowrap;
}
th {
  font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em;
  color: var(--muted); background: var(--surface-alt); font-weight: 600;
}
tr:last-child td { border-bottom: none; }
td.num, th.num {
  text-align: right;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
td.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.empty-row {
  text-align: center; color: var(--muted); padding: 20px 12px;
}

/* Consoles (WARP + Logs) */
.warp-console, .log-console {
  margin-top: 14px; padding: 12px 14px;
  background: #17150f; color: #e6dfc8;
  border: 1px solid var(--rule); border-radius: 3px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.8125rem; line-height: 1.55;
  overflow-y: auto;
}
.warp-console { min-height: 8.5em; max-height: 15em; }
.log-console { min-height: 20em; max-height: 36em; }
.warp-console .row, .log-console .row {
  margin: 0 0 3px; white-space: pre-wrap; overflow-wrap: anywhere;
}
.warp-console .t, .log-console .t { color: #8f8871; margin-right: 8px; }
.warp-console .ok, .log-console .ok { color: #7bc48a; }
.warp-console .warn, .log-console .warn { color: #e5ad5b; }
.warp-console .bad, .log-console .bad { color: #f08c82; }
.log-console .dim { color: #9c9480; }
.log-console .tag {
  display: inline-block; padding: 0 5px; margin-right: 6px;
  border-radius: 2px; font-size: 0.75rem; font-weight: 600;
  background: #2b2820; color: #d6ceb8;
}
.log-console .tag.ok { background: #1e3523; color: #7bc48a; }
.log-console .tag.warn { background: #3b2a14; color: #e5ad5b; }
.log-console .tag.bad { background: #3f1c1a; color: #f08c82; }

/* Log filters */
.filter-bar {
  display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
  padding: 12px; border: 1px solid var(--rule); border-radius: 3px;
  background: var(--surface);
}
.filter-bar select, .filter-bar input[type="search"] {
  font: inherit; font-size: 0.85rem;
  padding: 6px 10px; min-height: 34px;
  border: 1px solid var(--field); border-radius: 3px;
  background: var(--paper); color: var(--ink);
}
.filter-bar input[type="search"] { flex: 1 1 200px; min-width: 160px; }
.log-meta {
  display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center;
  gap: 8px; margin-top: 10px; font-size: 0.8rem; color: var(--muted);
}

dl { display: grid; grid-template-columns: max-content 1fr; gap: 8px 20px; margin: 0; font-size: 0.9rem; }
dt { color: var(--muted); }
dd { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
footer { border-top: 1px solid var(--rule); padding-top: 16px; color: var(--muted); font-size: 0.85rem; margin-top: 12px; }
footer a { color: var(--ink); }

@media (max-width: 600px) {
  body { padding: 20px 14px 48px; }
  .actions button { width: 100%; }
  dl { grid-template-columns: 1fr; gap: 2px 0; }
  dd { margin-bottom: 8px; }
  .activity-bars { gap: 4px; }
  .bar-label { font-size: 0.6rem; }
}
`;

const SCRIPT = `
const $ = (id) => document.getElementById(id);

function line(text, cls) {
  const p = document.createElement("p");
  p.className = "line" + (cls ? " " + cls : "");
  p.textContent = text;
  return p;
}

function fmtNum(n) {
  return Number(n || 0).toLocaleString("id-ID");
}

function fmtUptime(ms) {
  const sec = Math.floor(Math.max(0, ms || 0) / 1000);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (d > 0) return d + "h " + h + "j " + m + "m";
  if (h > 0) return h + "j " + m + "m";
  if (m > 0) return m + "m " + s + "d";
  return s + "d";
}

function fmtTime(ts) {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return "—";
  }
}

async function readJson(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "HTTP " + res.status);
  return body;
}

async function send(path, payload) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  return await readJson(res);
}

// --- Tabs ---
const tabButtons = Array.from(document.querySelectorAll(".tab-btn"));
const tabPanels = {
  egress: $("panel-egress"),
  stats: $("panel-stats"),
  logs: $("panel-logs"),
};
let activeTab = "egress";

function selectTab(name, updateHash) {
  if (!tabPanels[name]) name = "egress";
  activeTab = name;
  for (const btn of tabButtons) {
    const selected = btn.dataset.tab === name;
    btn.setAttribute("aria-selected", selected ? "true" : "false");
  }
  for (const [key, panelEl] of Object.entries(tabPanels)) {
    panelEl.hidden = key !== name;
  }
  if (updateHash) {
    try { history.replaceState(null, "", "#" + name); } catch {}
  }
  if (name === "stats") loadStats();
  if (name === "logs") {
    loadLogs();
    openLogStream();
  }
}

for (const btn of tabButtons) {
  btn.addEventListener("click", () => selectTab(btn.dataset.tab, true));
}

// --- Egress & Health ---
function renderStatus(state) {
  $("mode").textContent =
    state.mode === "warp" ? "WARP (IP tersembunyi)" : "Langsung (IP asli)";
  $("mode").dataset.mode = state.mode === "warp" ? "warp" : "direct";
  $("host").textContent = state.mode === "warp" ? "tunnel WARP" : "IP mesin ini";
  const notes = [];
  if (state.error) notes.push(state.error);
  $("note").textContent = notes.join(" ");
  $("note").hidden = notes.length === 0;

  $("hdr-egress").textContent = state.mode === "warp" ? "WARP" : "direct";
  $("hdr-egress-dot").className = "dot " + (state.mode === "warp" ? "ok" : "warn");
  if (typeof state.models === "number") {
    $("hdr-models").textContent = state.models + " model";
  }
}

async function loadHealth() {
  try {
    const health = await readJson(await fetch("/health"));
    renderStatus({
      mode: health.egress && health.egress.mode,
      models: health.discoveredModels,
      error: health.status === "ok" ? null : "server tidak sehat",
    });
  } catch (err) {
    showWarpReport([line("Gagal memuat status: " + err.message, "bad")]);
  }
}

// --- WARP controls ---
const warpOn = $("warp-on");
const warpOff = $("warp-off");
const warpMode = $("warp-mode");
const warpHost = $("warp-host");
const warpNote = $("warp-note");
const warpConsole = $("warp-console");
const MAX_CONSOLE_ROWS = 200;
let warpStream = null;

function showWarpReport(nodes) {
  const box = $("warp-report");
  box.replaceChildren(...nodes);
  box.hidden = false;
}

function renderWarp(state) {
  const on = Boolean(state.enabled);
  warpMode.textContent = on ? "WARP aktif" : "WARP mati";
  warpMode.dataset.warp = on ? "on" : "off";
  warpHost.textContent = state.tunnel
    ? "port " + state.tunnel.port + " via " + (state.tunnel.endpoint || "?")
    : on
      ? "tunnel tidak aktif"
      : "";
  const notes = [];
  if (state.device) notes.push("device " + state.device.id);
  if (state.burned) notes.push(state.burned + " jaringan dibuang");
  if (state.rateLimitedUntil) notes.push("rate limited sementara");
  if (state.error) notes.push(state.error);
  warpNote.textContent = notes.join(" · ");
  warpNote.hidden = notes.length === 0;
  warpOn.disabled = on;
  warpOff.disabled = !on;
}

function classForLine(text) {
  if (/connected|tunnel up|helper ready|clean|warp enabled/i.test(text)) return "ok";
  if (/dirty|cooldown|rate limited|already used|not available|would not start|did not come up|no address|no fresh/i.test(text)) return "bad";
  if (/fetching|connecting|generated|device/i.test(text)) return "warn";
  return "";
}

function pushWarpLine(text) {
  const at = new Date().toLocaleTimeString();
  const row = document.createElement("p");
  row.className = "row";
  const stamp = document.createElement("span");
  stamp.className = "t";
  stamp.textContent = "[" + at + "]";
  const body = document.createElement("span");
  const cls = classForLine(text);
  if (cls) body.className = cls;
  body.textContent = " " + text;
  row.append(stamp, body);
  warpConsole.append(row);
  while (warpConsole.childElementCount > MAX_CONSOLE_ROWS) warpConsole.firstElementChild.remove();
  warpConsole.scrollTop = warpConsole.scrollHeight;
}

function seedConsole(text) {
  if (warpConsole.childElementCount === 0) pushWarpLine(text);
}

function openWarpStream() {
  if (warpStream) return;
  warpStream = new EventSource("/api/warp/progress");
  warpStream.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      pushWarpLine(data.message);
      if (/^warp enabled$/i.test(data.message)) {
        loadHealth();
        loadWarp();
        closeWarpStream();
      }
    } catch {}
  };
  warpStream.onerror = () => closeWarpStream();
}

function closeWarpStream() {
  if (warpStream) warpStream.close();
  warpStream = null;
}

async function loadWarp() {
  try {
    const state = await readJson(await fetch("/api/warp"));
    renderWarp(state);
    seedConsole(
      state.enabled
        ? "warp aktif: " + (state.tunnel && state.tunnel.exitIp ? state.tunnel.exitIp : "mengambil exit ip…")
        : "warp mati. tekan Nyalakan WARP untuk memulai."
    );
  } catch (err) {
    showWarpReport([line("Gagal memuat status WARP: " + err.message, "bad")]);
  }
}

warpOn.addEventListener("click", async () => {
  warpOn.disabled = true;
  warpOff.disabled = true;
  openWarpStream();
  try {
    const state = await send("/api/warp", { enabled: true });
    renderWarp(state);
    showWarpReport([line(state.ok ? "WARP aktif. Request berikutnya keluar lewat tunnel." : "WARP gagal dinyalakan: " + (state.error || "?"), state.ok ? "ok" : "bad")]);
  } catch (err) {
    showWarpReport([line(err.message, "bad")]);
    warpOn.disabled = false;
    warpOff.disabled = false;
  }
});

warpOff.addEventListener("click", async () => {
  warpOn.disabled = true;
  warpOff.disabled = true;
  closeWarpStream();
  try {
    const state = await send("/api/warp", { enabled: false });
    renderWarp(state);
    showWarpReport([line("WARP mati. Egress kembali ke IP mesin ini.", "ok")]);
  } catch (err) {
    showWarpReport([line(err.message, "bad")]);
    warpOff.disabled = false;
    warpOn.disabled = false;
  }
});

// --- Stats ---
function renderStats(data) {
  const t = data.totals || {};
  $("badge-stats").textContent = fmtNum(t.requests || 0);
  $("hdr-uptime").textContent = "up " + fmtUptime(data.uptimeMs);

  $("stat-requests").textContent = fmtNum(t.requests);
  $("stat-requests-sub").textContent =
    fmtNum(t.ok) + " ok · " + fmtNum(t.errors) + " err · " + fmtNum(t.inFlight) + " aktif";

  const rateEl = $("stat-success");
  rateEl.textContent = (t.requests > 0 ? t.successRate : 100) + "%";
  rateEl.className = "kpi-val " + (t.requests === 0 || t.successRate >= 95 ? "ok" : t.successRate >= 80 ? "warn" : "bad");
  $("stat-success-sub").textContent =
    "429: " + fmtNum(t.rateLimited) + " · 403/gate: " + fmtNum(t.gateRejected);

  $("stat-tokens").textContent = fmtNum(t.totalTokens);
  $("stat-tokens-sub").textContent =
    "in " + fmtNum(t.promptTokens) + " · out " + fmtNum(t.completionTokens);

  $("stat-latency").textContent = fmtNum(t.avgLatencyMs) + " ms";
  $("stat-latency-sub").textContent = "p95: " + fmtNum(t.p95LatencyMs) + " ms";

  $("stat-uptime").textContent = fmtUptime(data.uptimeMs);
  $("stat-uptime-sub").textContent =
    (typeof data.discoveredModels === "number" ? data.discoveredModels + " model gratis" : "") +
    (t.lastRequestAt ? " · terakhir " + fmtTime(t.lastRequestAt) : "");

  // Activity bars
  const barsEl = $("activity-bars");
  const series = Array.isArray(data.activity) ? data.activity : [];
  let maxTotal = 1;
  for (const b of series) {
    const sum = (b.ok || 0) + (b.errors || 0);
    if (sum > maxTotal) maxTotal = sum;
  }
  const barNodes = [];
  for (const b of series) {
    const sum = (b.ok || 0) + (b.errors || 0);
    const col = document.createElement("div");
    col.className = "bar-col";
    col.title = b.label + " — " + (b.ok || 0) + " ok, " + (b.errors || 0) + " err";

    const cnt = document.createElement("span");
    cnt.className = "bar-count";
    cnt.textContent = sum > 0 ? String(sum) : "";

    const stack = document.createElement("div");
    stack.className = "bar-stack";

    if (b.errors > 0) {
      const segErr = document.createElement("div");
      segErr.className = "bar-seg-err";
      segErr.style.height = Math.max(4, Math.round((b.errors / maxTotal) * 100)) + "%";
      stack.append(segErr);
    }
    if (b.ok > 0) {
      const segOk = document.createElement("div");
      segOk.className = "bar-seg-ok";
      segOk.style.height = Math.max(4, Math.round((b.ok / maxTotal) * 100)) + "%";
      stack.append(segOk);
    }

    const lbl = document.createElement("span");
    lbl.className = "bar-label";
    lbl.textContent = b.label;

    col.append(cnt, stack, lbl);
    barNodes.push(col);
  }
  barsEl.replaceChildren(...barNodes);

  // Per-model table
  const tbody = $("model-tbody");
  const models = Array.isArray(data.byModel) ? data.byModel : [];
  if (models.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 6;
    td.className = "empty-row";
    td.textContent = "Belum ada request inference yang tercatat.";
    tr.append(td);
    tbody.replaceChildren(tr);
  } else {
    const rows = models.map((m) => {
      const tr = document.createElement("tr");
      const cells = [
        { text: m.model, cls: "mono" },
        { text: fmtNum(m.requests), cls: "num" },
        { text: fmtNum(m.ok), cls: "num" },
        { text: fmtNum(m.errors) + (m.rateLimited ? " (" + fmtNum(m.rateLimited) + "×429)" : ""), cls: "num" },
        { text: fmtNum(m.totalTokens) + " (" + fmtNum(m.promptTokens) + "/" + fmtNum(m.completionTokens) + ")", cls: "num" },
        { text: fmtNum(m.avgLatencyMs) + " ms", cls: "num" },
      ];
      for (const c of cells) {
        const td = document.createElement("td");
        if (c.cls) td.className = c.cls;
        td.textContent = c.text;
        tr.append(td);
      }
      return tr;
    });
    tbody.replaceChildren(...rows);
  }
}

async function loadStats() {
  try {
    const stats = await readJson(await fetch("/api/stats"));
    renderStats(stats);
  } catch {}
}

$("stats-refresh").addEventListener("click", () => loadStats());
$("stats-reset").addEventListener("click", async () => {
  $("stats-reset").disabled = true;
  try {
    const stats = await send("/api/stats/reset", {});
    renderStats(stats);
  } catch {} finally {
    $("stats-reset").disabled = false;
  }
});

// --- Logs ---
const logConsole = $("log-console");
const logKind = $("log-kind");
const logLevel = $("log-level");
const logSearch = $("log-search");
const logPause = $("log-pause");
const logClear = $("log-clear");
const logCount = $("log-count");
const logSseStatus = $("log-sse-status");
const logSseDot = $("log-sse-dot");

let logEntries = [];
let logStream = null;
let logPaused = false;
const MAX_UI_LOGS = 500;

function matchesFilter(e) {
  const k = logKind.value;
  if (k !== "all" && e.kind !== k) return false;
  const lvl = logLevel.value;
  if (lvl !== "all" && e.level !== lvl) return false;
  const q = logSearch.value.trim().toLowerCase();
  if (q) {
    const hay = [
      e.message || "",
      e.model || "",
      e.path || "",
      e.error || "",
      e.logId || "",
      String(e.status || ""),
      e.egress || "",
    ].join(" ").toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

function buildLogRow(e) {
  const row = document.createElement("p");
  row.className = "row";

  const stamp = document.createElement("span");
  stamp.className = "t";
  stamp.textContent = "[" + fmtTime(e.ts) + "]";
  row.append(stamp);

  const levelCls = e.level === "error" ? "bad" : e.level === "warn" ? "warn" : "ok";

  if (e.kind === "request") {
    const tag = document.createElement("span");
    tag.className = "tag " + levelCls;
    tag.textContent = String(e.status || "ERR");
    row.append(tag);

    const mainText = document.createElement("span");
    mainText.className = levelCls;
    mainText.textContent =
      (e.method || "POST") + " " + (e.path || "/v1/chat/completions") +
      " · " + (e.model || "?") +
      (e.stream ? " [sse]" : " [json]");
    row.append(mainText);

    const meta = document.createElement("span");
    meta.className = "dim";
    const parts = [
      (e.latencyMs || 0) + "ms",
      e.egress || "direct",
    ];
    if (e.totalTokens > 0) {
      parts.push(e.totalTokens + " tok (" + (e.promptTokens || 0) + "/" + (e.completionTokens || 0) + ")");
    }
    if (e.logId) parts.push("id:" + e.logId);
    meta.textContent = " — " + parts.join(" · ");
    row.append(meta);

    if (e.error) {
      const errSpan = document.createElement("span");
      errSpan.className = "bad";
      errSpan.textContent = " — " + e.error;
      row.append(errSpan);
    }
  } else {
    const tag = document.createElement("span");
    tag.className = "tag " + levelCls;
    tag.textContent = (e.level || "info").toUpperCase();
    row.append(tag);

    const msg = document.createElement("span");
    msg.className = e.level === "error" ? "bad" : e.level === "warn" ? "warn" : "";
    msg.textContent = e.message || "";
    row.append(msg);
  }

  return row;
}

function renderLogs() {
  const visible = [];
  for (let i = logEntries.length - 1; i >= 0; i--) {
    const e = logEntries[i];
    if (matchesFilter(e)) visible.push(e);
  }
  $("badge-logs").textContent = fmtNum(logEntries.length);
  logCount.textContent =
    "Menampilkan " + fmtNum(visible.length) + " dari " + fmtNum(logEntries.length) + " entri log";

  if (visible.length === 0) {
    const empty = document.createElement("p");
    empty.className = "row dim";
    empty.textContent = "Belum ada log yang cocok dengan filter.";
    logConsole.replaceChildren(empty);
    return;
  }
  const frag = document.createDocumentFragment();
  for (const e of visible) frag.append(buildLogRow(e));
  logConsole.replaceChildren(frag);
  if (!logPaused) {
    logConsole.scrollTop = logConsole.scrollHeight;
  }
}

async function loadLogs() {
  try {
    const res = await readJson(await fetch("/api/logs?limit=200"));
    // API returns newest-first; keep newest-first internally
    logEntries = Array.isArray(res.entries) ? res.entries : [];
    renderLogs();
  } catch {}
}

function openLogStream() {
  if (logStream) return;
  logStream = new EventSource("/api/logs/stream");
  logStream.onopen = () => {
    logSseStatus.textContent = logPaused ? "Dijeda" : "Live";
    logSseDot.className = "dot " + (logPaused ? "warn" : "ok");
  };
  logStream.onmessage = (event) => {
    try {
      const entry = JSON.parse(event.data);
      if (logEntries.some((x) => x.id === entry.id)) return;
      logEntries.unshift(entry);
      if (logEntries.length > MAX_UI_LOGS) logEntries.length = MAX_UI_LOGS;
      $("badge-logs").textContent = fmtNum(logEntries.length);
      if (!logPaused && activeTab === "logs") {
        renderLogs();
      }
      if (entry.kind === "request") {
        loadStats();
      }
    } catch {}
  };
  logStream.onerror = () => {
    logSseStatus.textContent = "Menghubungkan ulang…";
    logSseDot.className = "dot warn";
  };
}

logKind.addEventListener("change", renderLogs);
logLevel.addEventListener("change", renderLogs);
logSearch.addEventListener("input", renderLogs);

logPause.addEventListener("click", () => {
  logPaused = !logPaused;
  logPause.textContent = logPaused ? "Lanjutkan" : "Jeda";
  logSseStatus.textContent = logPaused ? "Dijeda" : "Live";
  logSseDot.className = "dot " + (logPaused ? "warn" : "ok");
  if (!logPaused) renderLogs();
});

logClear.addEventListener("click", async () => {
  logClear.disabled = true;
  try {
    await send("/api/logs/clear", {});
    logEntries = [];
    renderLogs();
  } catch {} finally {
    logClear.disabled = false;
  }
});

// --- Boot ---
const initialHash = String(window.location.hash || "").replace(/^#/, "");
if (tabPanels[initialHash]) selectTab(initialHash, false);

loadHealth();
loadWarp();
loadStats();
loadLogs();
openLogStream();

setInterval(() => {
  loadHealth();
  loadWarp();
  loadStats();
}, 3000);
`;

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

/**
 * Full panel document. `description` is the current egress state; only scalar
 * fields are read and escaped so no value can inject markup.
 */
function renderPanel(description, { version = "", port = "" } = {}) {
  const state = description || {};
  const isWarp = state.mode === "warp";
  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Panel · opencode-free-bridge</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <header>
    <div class="brand">
      <h1>opencode-free-bridge</h1>
      <p class="sub">Kontrol egress WARP, statistik pemakaian model, dan log request secara langsung.</p>
    </div>
    <div class="header-meta">
      <span class="pill"><span class="dot ${isWarp ? "ok" : "warn"}" id="hdr-egress-dot"></span><span id="hdr-egress">${isWarp ? "WARP" : "direct"}</span></span>
      <span class="pill" id="hdr-models">0 model</span>
      <span class="pill" id="hdr-uptime">up 0d</span>
    </div>
  </header>

  <nav class="tabs" role="tablist" aria-label="Navigasi panel">
    <button type="button" class="tab-btn" role="tab" id="tab-egress" data-tab="egress" aria-controls="panel-egress" aria-selected="true">Egress</button>
    <button type="button" class="tab-btn" role="tab" id="tab-stats" data-tab="stats" aria-controls="panel-stats" aria-selected="false">Statistik <span class="tab-badge" id="badge-stats">0</span></button>
    <button type="button" class="tab-btn" role="tab" id="tab-logs" data-tab="logs" aria-controls="panel-logs" aria-selected="false">Log <span class="tab-badge" id="badge-logs">0</span></button>
  </nav>

  <div class="tab-panel" id="panel-egress" role="tabpanel" aria-labelledby="tab-egress">
    <section aria-labelledby="status-title">
      <h2 id="status-title">Status sekarang</h2>
      <div class="status">
        <span class="mode" id="mode" data-mode="${isWarp ? "warp" : "direct"}">${escapeHtml(isWarp ? "WARP (IP tersembunyi)" : "Langsung (IP asli)")}</span>
        <span class="host" id="host">${escapeHtml(isWarp ? "tunnel WARP" : "IP mesin ini")}</span>
        <span class="note" id="note" hidden></span>
      </div>
    </section>

    <section aria-labelledby="warp-title">
      <h2 id="warp-title">WARP egress</h2>
      <div class="status">
        <span class="mode" id="warp-mode" data-warp="${isWarp ? "on" : "off"}">${isWarp ? "WARP aktif" : "WARP mati"}</span>
        <span class="host" id="warp-host"></span>
        <span class="note" id="warp-note" hidden></span>
      </div>
      <p class="hint">Saat aktif, semua request keluar menuju upstream lewat tunnel WARP; saat mati, egress kembali ke IP mesin ini.</p>
      <div class="actions">
        <button type="button" class="primary" id="warp-on">Nyalakan WARP</button>
        <button type="button" id="warp-off">Matikan WARP</button>
      </div>
      <div class="warp-console" id="warp-console" role="log" aria-live="polite"></div>
      <div class="report" id="warp-report" role="status" aria-live="polite" hidden></div>
    </section>

    <section aria-labelledby="endpoint-title">
      <h2 id="endpoint-title">Endpoint klien</h2>
      <dl>
        <dt>Base URL</dt><dd>http://127.0.0.1:${escapeHtml(port || "20129")}/v1</dd>
        <dt>API key</dt><dd>public</dd>
        <dt>Versi</dt><dd>${escapeHtml(version || "")}</dd>
        <dt>API Panel</dt><dd><a href="/health">/health</a> · <a href="/api/stats">/api/stats</a> · <a href="/api/logs">/api/logs</a></dd>
      </dl>
    </section>
  </div>

  <div class="tab-panel" id="panel-stats" role="tabpanel" aria-labelledby="tab-stats" hidden>
    <section aria-labelledby="kpi-title">
      <div class="section-head">
        <h2 id="kpi-title">Ringkasan trafik</h2>
        <div class="actions">
          <button type="button" class="small" id="stats-refresh">Muat ulang</button>
          <button type="button" class="small" id="stats-reset">Reset statistik</button>
        </div>
      </div>
      <div class="kpi-grid">
        <div class="kpi-card">
          <p class="kpi-label">Total request</p>
          <p class="kpi-val" id="stat-requests">0</p>
          <p class="kpi-sub" id="stat-requests-sub">0 ok · 0 err · 0 aktif</p>
        </div>
        <div class="kpi-card">
          <p class="kpi-label">Tingkat sukses</p>
          <p class="kpi-val ok" id="stat-success">100%</p>
          <p class="kpi-sub" id="stat-success-sub">429: 0 · 403/gate: 0</p>
        </div>
        <div class="kpi-card">
          <p class="kpi-label">Total token</p>
          <p class="kpi-val" id="stat-tokens">0</p>
          <p class="kpi-sub" id="stat-tokens-sub">in 0 · out 0</p>
        </div>
        <div class="kpi-card">
          <p class="kpi-label">Latensi rata-rata</p>
          <p class="kpi-val" id="stat-latency">0 ms</p>
          <p class="kpi-sub" id="stat-latency-sub">p95: 0 ms</p>
        </div>
        <div class="kpi-card">
          <p class="kpi-label">Uptime</p>
          <p class="kpi-val" id="stat-uptime">0d</p>
          <p class="kpi-sub" id="stat-uptime-sub">0 model gratis</p>
        </div>
      </div>
    </section>

    <section aria-labelledby="activity-title">
      <h2 id="activity-title">Aktivitas 1 jam terakhir (per 5 menit)</h2>
      <div class="chart-card">
        <div class="activity-bars" id="activity-bars"></div>
        <div class="chart-legend">
          <span class="legend-item"><span class="legend-swatch" style="background:var(--ok)"></span>Sukses (2xx)</span>
          <span class="legend-item"><span class="legend-swatch" style="background:var(--bad)"></span>Error / Limit</span>
        </div>
      </div>
    </section>

    <section aria-labelledby="models-title">
      <h2 id="models-title">Pemakaian per model</h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Model</th>
              <th class="num">Request</th>
              <th class="num">Sukses</th>
              <th class="num">Error</th>
              <th class="num">Token (In/Out)</th>
              <th class="num">Rata-rata</th>
            </tr>
          </thead>
          <tbody id="model-tbody">
            <tr><td colspan="6" class="empty-row">Belum ada request inference yang tercatat.</td></tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>

  <div class="tab-panel" id="panel-logs" role="tabpanel" aria-labelledby="tab-logs" hidden>
    <section aria-labelledby="logs-title">
      <div class="section-head">
        <h2 id="logs-title">Log langsung</h2>
        <div class="actions">
          <span class="pill"><span class="dot ok" id="log-sse-dot"></span><span id="log-sse-status">Live</span></span>
          <button type="button" class="small" id="log-pause">Jeda</button>
          <button type="button" class="small" id="log-clear">Bersihkan log</button>
        </div>
      </div>

      <div class="filter-bar">
        <select id="log-kind" aria-label="Filter tipe log">
          <option value="all">Semua tipe</option>
          <option value="request">Request</option>
          <option value="system">Sistem</option>
        </select>
        <select id="log-level" aria-label="Filter level log">
          <option value="all">Semua level</option>
          <option value="info">Info</option>
          <option value="warn">Warn</option>
          <option value="error">Error</option>
        </select>
        <input type="search" id="log-search" placeholder="Cari model, status (429/403), pesan error, log ID…" aria-label="Cari log">
      </div>

      <div class="log-meta">
        <span id="log-count">Menampilkan 0 dari 0 entri log</span>
        <span id="log-storage">Persisten di telemetry/logs.jsonl (maks 500 entri di panel)</span>
      </div>

      <div class="log-console" id="log-console" role="log" aria-live="polite"></div>
    </section>
  </div>

  <footer>
    Proxy berlaku untuk inference, discovery model, sinkronisasi identity, dan cek update. Statistik &amp; log disimpan permanen di folder telemetry/ (sejajar dengan folder warp/) tanpa dependensi eksternal.
  </footer>
</main>
<script>${SCRIPT}</script>
</body>
</html>`;
}

module.exports = { renderPanel };
