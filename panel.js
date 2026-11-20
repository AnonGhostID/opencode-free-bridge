#!/usr/bin/env bun
/**
 * panel.js: the browser panel served at `/`.
 *
 * One job: let the operator point the bridge's egress at an HTTP proxy and see
 * whether that proxy actually reaches upstream. Everything the panel draws comes
 * from `proxy.describe()` over JSON; no user-supplied value is interpolated into
 * this HTML, and the client sets every dynamic string with `textContent`.
 *
 * Design direction (my call, no DESIGN.md in this repo): an operations console for
 * a developer running a local bridge. Warm paper and ink, one clay accent reserved
 * for the commit action and the focus ring, system UI type for prose and monospace
 * only where characters are read one by one (a proxy URL). Dials: ENERGY 1,
 * RHYTHM 1, MOTION 1: this is a settings surface, not a landing page.
 */

const STYLE = `
:root {
  color-scheme: light dark;
  --paper: #f7f5f1;
  --surface: #ffffff;
  --ink: #1c1a16;
  --muted: #5c574e;
  --rule: #cfc9bf;
  --field: #8d857a;
  --accent: #9a3f10;
  --accent-ink: #ffffff;
  --ok: #2c6a33;
  --bad: #9b2118;
}
@media (prefers-color-scheme: dark) {
  :root {
    --paper: #131211;
    --surface: #1b1a18;
    --ink: #ece7de;
    --muted: #a49c92;
    --rule: #3a3631;
    --field: #7a746a;
    --accent: #e39a63;
    --accent-ink: #1a1208;
    --ok: #7bc48a;
    --bad: #f08c82;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 40px 20px 64px;
  background: var(--paper);
  color: var(--ink);
  font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
main { max-width: 620px; margin: 0 auto; }
header { border-bottom: 1px solid var(--rule); padding-bottom: 16px; margin-bottom: 28px; }
h1 { font-size: 1.25rem; line-height: 1.3; margin: 0 0 6px; letter-spacing: -0.01em; }
.sub { margin: 0; color: var(--muted); font-size: 0.9375rem; }
h2 { font-size: 0.8125rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); margin: 0 0 12px; }
section { margin-bottom: 32px; }
.status {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 12px;
  padding: 14px 16px; border: 1px solid var(--rule); border-radius: 3px; background: var(--surface);
}
.status .mode { font-weight: 600; }
.status .mode[data-mode="warp"] { color: var(--ok); }
.status .mode[data-warp="on"] { color: var(--ok); }
.status .host { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9375rem; }
.status .note { color: var(--muted); font-size: 0.875rem; width: 100%; }
.actions { display: flex; flex-wrap: wrap; gap: 10px; }
button {
  font: inherit; font-size: 0.9375rem; font-weight: 600;
  padding: 10px 18px; min-height: 44px;
  border: 1px solid var(--field); border-radius: 3px;
  background: var(--surface); color: var(--ink); cursor: pointer;
}
button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
button:disabled { opacity: 0.55; cursor: default; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.report { margin-top: 20px; font-size: 0.9375rem; }
.report[hidden] { display: none; }
.report .line { margin: 0 0 4px; }
.report .ok { color: var(--ok); font-weight: 600; }
.report .bad { color: var(--bad); font-weight: 600; }
.report .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
/* Terminal-style box for the WARP progress feed: dark surface, mono glyphs,
   one line per event, keeps history after connect. */
.warp-console {
  margin-top: 20px; padding: 12px 14px;
  background: #17150f; color: #e6dfc8;
  border: 1px solid var(--rule); border-radius: 3px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.875rem; line-height: 1.5;
  min-height: 9.5em; max-height: 16em; overflow-y: auto;
}
.warp-console .row { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.warp-console .t { color: #8f8871; margin-right: 8px; }
.warp-console .ok { color: #7bc48a; }
.warp-console .warn { color: #e39a63; }
.warp-console .bad { color: #f08c82; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 8px 20px; margin: 0; font-size: 0.9375rem; }
dt { color: var(--muted); }
dd { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
footer { border-top: 1px solid var(--rule); padding-top: 16px; color: var(--muted); font-size: 0.875rem; }
footer a { color: var(--ink); }
@media (max-width: 480px) {
  body { padding: 28px 16px 48px; }
  .actions button { width: 100%; }
  dl { grid-template-columns: 1fr; gap: 2px 0; }
  dd { margin-bottom: 8px; }
}
`;

const SCRIPT = `
const $ = (id) => document.getElementById(id);
const report = $("report");

function line(text, cls) {
  const p = document.createElement("p");
  p.className = "line" + (cls ? " " + cls : "");
  p.textContent = text;
  return p;
}

function showReport(nodes) {
  report.replaceChildren(...nodes);
  report.hidden = false;
}

function renderStatus(state) {
  $("mode").textContent =
    state.mode === "warp" ? "WARP (IP tersembunyi)" : "Langsung (IP asli)";
  $("mode").dataset.mode = state.mode === "warp" ? "warp" : "direct";
  $("host").textContent = state.mode === "warp" ? "tunnel WARP" : "IP mesin ini";
  const notes = [];
  if (state.error) notes.push(state.error);
  $("note").textContent = notes.join(" ");
  $("note").hidden = notes.length === 0;
}

async function readJson(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "HTTP " + res.status);
  return body;
}

async function load() {
  try {
    const health = await readJson(await fetch("/health"));
    renderStatus({ mode: health.egress.mode, error: health.status === "ok" ? null : "server tidak sehat" });
  } catch (err) {
    showReport([line("Gagal memuat status: " + err.message, "bad")]);
  }
}

async function send(path, payload) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return await readJson(res);
}

const warpOn = $("warp-on");
const warpOff = $("warp-off");
const warpMode = $("warp-mode");
const warpHost = $("warp-host");
const warpNote = $("warp-note");

function showWarpReport(nodes) {
  const box = $("warp-report");
  box.replaceChildren(...nodes);
  box.hidden = false;
}

function renderWarp(state) {
  const on = state.enabled;
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

const warpConsole = $("warp-console");
const MAX_CONSOLE_ROWS = 200;
let warpStream = null;

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

// Seed the box with the current state so it is never an empty box.
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
      if (/warp enabled|connected/.test(data.message)) {
        load();
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

load();
loadWarp();

// Auto-refresh: the status line and the WARP state must reflect the server
// without a manual reload, including after the SSE stream already closed.
setInterval(() => {
  load();
  loadWarp();
}, 3000);
`;

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

/**
 * Full panel document. `description` is `proxy.describe()`; only its scalar
 * fields are read, and they are escaped, so a value from the config file cannot
 * become markup.
 */
function renderPanel(description, { version = "", port = "" } = {}) {
  const state = description || {};
  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Proxy egress · opencode-free-bridge</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <header>
    <h1>Egress</h1>
    <p class="sub">Arahkan semua koneksi keluar bridge lewat tunnel WARP, supaya upstream tidak melihat IP mesin ini.</p>
  </header>

  <section aria-labelledby="status-title">
    <h2 id="status-title">Status sekarang</h2>
    <div class="status">
      <span class="mode" id="mode">${escapeHtml(state.mode === "warp" ? "WARP (IP tersembunyi)" : "Langsung (IP asli)")}</span>
      <span class="host" id="host">${escapeHtml(state.mode === "warp" ? "tunnel WARP" : "IP mesin ini")}</span>
      <span class="note" id="note" hidden></span>
    </div>
  </section>

  <section aria-labelledby="warp-title">
    <h2 id="warp-title">WARP egress</h2>
    <div class="status">
      <span class="mode" id="warp-mode" data-warp="off">WARP mati</span>
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
      <dt>Health</dt><dd><a href="/health">/health</a></dd>
    </dl>
  </section>

  <footer>
    Proxy berlaku untuk inference, discovery model, sinkronisasi identity, dan cek update. Perubahan langsung dipakai request berikutnya, tanpa restart.
  </footer>
</main>
<script>${SCRIPT}</script>
</body>
</html>`;
}

module.exports = { renderPanel };
