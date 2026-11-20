#!/usr/bin/env bun
/**
 * warp.js: Cloudflare WARP egress for the bridge, adapted from the module
 * opencode-hop v2.3.3 embeds (reverse analysis in /root/linuxdir/REVERSE_ANALYSIS.md).
 *
 * Responsibilities:
 *   - keep one registered WARP device (warp-device.json, mode 0600)
 *   - keep the wireproxy helper installed (downloaded once, sha256-checked)
 *   - run the tunnel as a child process on a loopback HTTP port
 *   - expose `egressUrl()` for fetch({ proxy }) and `rotate()` for 429 paths
 *
 * Not handled here: process lifecycle (server.js drives it), the panel
 * (server.js owns the admin route), the egress pool (proxy.js is unrelated).
 */

const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const REGISTER_URL = "https://api.cloudflareclient.com/v0a2158/reg";
const CLIENT_VERSION = "a-6.11-2223";
const HELPER_RELEASE_URL =
  "https://github.com/pufferffish/wireproxy/releases/download/v1.1.3";
const CHECKSUM_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const REGISTER_TIMEOUT_MS = 20_000;
const EXIT_IP_TIMEOUT_MS = 8_000;
const ROTATION_PROBE_TIMEOUT_MS = 6_000;
const ROTATION_PROBE_RETRY_MS = 1_500;
const WARP_ATTEMPTS = 4;
const KEY_ROTATE_ATTEMPT = 3;
const PROBE_MAX_ATTEMPTS = 40;
const PROBE_RETRY_MS = 250;
const METRICS_HANDSHAKE_TIMEOUT_MS = 5_000;
const METRICS_HANDSHAKE_RETRIES = 10;
const METRICS_HANDSHAKE_RETRY_MS = 500;
const HANDSHAKE_MIN_TIME = 0;
const RATE_LIMIT_COOLDOWN_MS = 60_000;
const BURNED_TTL_MS = 86_400_000;
const BURNED_MAX_ENTRIES = 500;
const ROTATE_SUCCESS_DELAY_MS = 1_000;
const ROTATE_FAILURE_DELAY_MS = 5_000;
const EXIT_IP_URLS = [
  "https://icanhazip.com",
  "https://api.ipify.org",
  "https://checkip.amazonaws.com",
];
const HEALTH_PROBE_TIMEOUT_MS = 20_000;
const TUNNEL_HOST_ALLOWLIST = new Set(["opencode.ai", "models.opencode.ai", "cdn.opencode.ai"]);
const TUNNEL_DOMAIN_SUFFIXES = [".opencode.ai"];
// A tunnel destination not in the allowlist is answered directly (no WARP),
// so an unknown host never breaks a caller that should not be tunneled.
const BURNED_WRITE_DEBOUNCE_MS = 1_000;
const MAX_LOG_BYTES = 1 * 1024 * 1024;
const DEFAULT_IDLE_KILL_MS = 30_000;

function warpHome() {
  const raw = process.env.OPENCODE_WARP_HOME;
  if (raw !== undefined && String(raw).trim()) return path.resolve(String(raw).trim());
  return path.join(stateDir(), "warp");
}

function stateDir() {
  const raw = process.env.OPENCODE_BRIDGE_STATE_DIR;
  if (raw !== undefined && String(raw).trim()) return path.resolve(String(raw).trim());
  return path.join(os.homedir(), ".opencode-free-bridge");
}

function deviceFile() {
  return path.join(warpHome(), "warp-device.json");
}

function burnedFile() {
  return path.join(warpHome(), "warp-burned.json");
}

function logFile() {
  return path.join(warpHome(), "warp.log");
}

function helperPath() {
  const raw = process.env.OPENCODE_WARP_PROXY;
  if (raw !== undefined && String(raw).trim()) return path.resolve(String(raw).trim());
  return path.join(warpHome(), helperBinaryName());
}

const HELPER_ARCHIVES = {
  linux: { x64: "wireproxy_linux_amd64.tar.gz", arm64: "wireproxy_linux_arm64.tar.gz" },
  darwin: { x64: "wireproxy_darwin_amd64.tar.gz", arm64: "wireproxy_darwin_arm64.tar.gz" },
  win32: { x64: "wireproxy_windows_amd64.tar.gz" },
};

/** Archive for this platform, or null when wireproxy has no build for it. */
function helperArchiveName(platform = process.platform, arch = process.arch) {
  return (HELPER_ARCHIVES[platform] ?? {})[arch] ?? null;
}

/** Extracted helper name: `wireproxy` everywhere, `.exe` on Windows. */
function helperBinaryName(platform = process.platform) {
  return platform === "win32" ? "wireproxy.exe" : "wireproxy";
}

// ------------------------------------------------------------ device state ---

function readDevice() {
  try {
    const raw = fs.readFileSync(deviceFile(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.privateKey && parsed.peerPublicKey) return parsed;
  } catch {}
  return null;
}

function writeDevice(device) {
  fs.mkdirSync(warpHome(), { recursive: true });
  fs.writeFileSync(deviceFile(), JSON.stringify(device, null, 2) + "\n", { mode: 0o600 });
}

function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  // Raw 32-byte keys: the 12/16-byte DER headers are not part of the value
  // Cloudflare's API or WireGuard expects.
  const publicB64 = Buffer.from(publicKey.export({ type: "spki", format: "der" }).subarray(12)).toString("base64");
  const privateB64 = Buffer.from(privateKey.export({ type: "pkcs8", format: "der" }).subarray(16)).toString("base64");
  return { publicKey: publicB64, privateKey: privateB64 };
}

function describeConfig(apiBody, keyPair, previousDevice = null) {
  const peers = (apiBody.config ?? {}).peers ?? [];
  const peer = peers[0] ?? {};
  const addresses = ((apiBody.config ?? {}).interface ?? {}).addresses ?? {};
  const endpointHost = String(peer.endpoint?.host ?? "engage.cloudflareclient.com:2408").split(":")[0];
  return {
    id: apiBody.id ?? previousDevice?.id ?? null,
    token: apiBody.token ?? previousDevice?.token ?? null,
    publicKey: keyPair.publicKey,
    privateKey: keyPair.privateKey,
    peerPublicKey: peer.public_key,
    endpointHost,
    endpointIps: [],
    endpointPorts: peer.endpoint?.ports ?? [2408],
    address4: addresses.v4,
    address6: addresses.v6,
  };
}

/** Register a brand-new device, or throw with a rate-limit cooldown attached. */
async function registerDevice() {
  const keyPair = generateKeyPair();
  const res = await fetch(REGISTER_URL, {
    method: "POST",
    headers: {
      "CF-Client-Version": CLIENT_VERSION,
      "User-Agent": "okhttp/3.12.1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      key: keyPair.publicKey,
      install_id: "",
      fcm_token: "",
      tos: new Date().toISOString(),
      model: "PC",
      serial_number: "",
      locale: "en_US",
    }),
    signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 429) {
    rateLimitUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
    throw new Error("registration is rate limited; the saved device is kept");
  }
  const peer = ((body.config ?? {}).peers ?? [])[0] ?? {};
  if (!res.ok || !peer.public_key || !((body.config ?? {}).interface ?? {}).addresses?.v4) {
    throw new Error(`registration failed: HTTP ${res.status} ${JSON.stringify(body).slice(0, 160)}`);
  }
  const device = describeConfig(body, keyPair);
  device.endpointIps = await resolveEndpointIps(body, device.endpointHost);
  writeDevice(device);
  emitProgress(`registered with Cloudflare: ${device.id} -> ${device.address6 ?? device.address4}`);
  return device;
}

/** Generate a fresh keypair and re-key the existing device (same id + token). */
async function rotateDeviceKeys(device) {
  if (!device?.id || !device?.token) return null;
  const keyPair = generateKeyPair();
  try {
    const res = await fetch(`${REGISTER_URL}/${device.id}`, {
      method: "PATCH",
      headers: {
        "CF-Client-Version": CLIENT_VERSION,
        "User-Agent": "okhttp/3.12.1",
        "Content-Type": "application/json",
        Authorization: `Bearer ${device.token}`,
      },
      body: JSON.stringify({ key: keyPair.publicKey }),
      signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS),
    });
    if (!res.ok) {
      appendLog(`key rotation refused: HTTP ${res.status}`);
      return null;
    }
    const body = await res.json().catch(() => ({}));
    const next = describeConfig(body, keyPair, device);
    next.endpointIps = await resolveEndpointIps(body, next.endpointHost);
    if (!next.peerPublicKey || !next.address4) return null;
    writeDevice(next);
    appendLog(`rotated the device keys -> ${next.address6 ?? next.address4}`);
    return next;
  } catch (err) {
    appendLog(`key rotation failed: ${err.message}`);
    return null;
  }
}

async function resolveEndpointIps(apiBody, endpointHost) {
  // The registration response can carry a literal IPv4 for the peer endpoint;
  // DNS may also answer, so both are kept as candidate endpoints.
  const ips = new Set();
  try {
    const answers = await new Promise((resolve, reject) => {
      const req = require("dns").promises.resolve4;
      req(endpointHost).then(resolve, reject);
    });
    for (const ip of answers.slice(0, 8)) ips.add(ip);
  } catch {}
  const literal = ((apiBody.config ?? {}).peers ?? [])[0]?.endpoint?.v4;
  const literalIp = typeof literal === "string" ? literal.split(":")[0] : null;
  if (literalIp && /^\d+\.\d+\.\d+\.\d+$/.test(literalIp)) ips.add(literalIp);
  return [...ips];
}

// ----------------------------------------------------------------- helper ---

function helperChecksumUrl() {
  return `${HELPER_RELEASE_URL}/checksums.txt`;
}

/** True when the helper binary exists and runs. Cached after the first check. */
async function ensureHelper({ now = Date.now } = {}) {
  if (helperVerified && Date.now() - helperVerifiedAt < 60_000) return true;
  if (fs.existsSync(helperPath())) {
    helperVerified = true;
    helperVerifiedAt = now();
    return true;
  }
  helperVerified = false;
  return await downloadHelper();
}

async function downloadHelper() {
  const archiveName = helperArchiveName();
  if (!archiveName) {
    emitProgress(`helper not available: wireproxy has no build for ${process.platform}/${process.arch}`);
    return false;
  }
  try {
    fs.mkdirSync(warpHome(), { recursive: true });
    const checksumText = await fetch(helperChecksumUrl(), {
      signal: AbortSignal.timeout(CHECKSUM_TIMEOUT_MS),
    }).then((res) => res.text());
    const expected = checksumText
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.endsWith(archiveName))
      ?.split(/\s+/)[0];
    const res = await fetch(`${HELPER_RELEASE_URL}/${archiveName}`, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const sizeHead = res.headers.get("content-length");
    const archiveLength = sizeHead ? Number(sizeHead) : null;
    emitProgress(`fetching ${archiveName}${archiveLength ? ` (${(archiveLength / 1024 / 1024).toFixed(1)} MB)` : ""}`);
    const archive = Buffer.from(await res.arrayBuffer());
    if (expected) {
      const actual = crypto.createHash("sha256").update(archive).digest("hex");
      if (actual !== expected) throw new Error("checksum mismatch");
    }
    // GNU tar parses `C:\...` as `host:path` (remote host `C`), which is how
    // Windows downloads fail with "Cannot connect to C: resolve failed". Pipe
    // the archive through stdin instead, so tar never sees a drive letter.
    const extraction = spawnSync("tar", ["-xzf", "-", "-C", warpHome()], {
      encoding: "buffer",
      input: archive,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (extraction.status !== 0) {
      const stderr = extraction.stderr ? Buffer.from(extraction.stderr).toString("utf8") : "";
      throw new Error(`tar: ${stderr.trim().split("\n")[0] || `exit ${extraction.status}`}`);
    }
    if (!fs.existsSync(helperPath())) throw new Error("unpacked but missing");
    // chmod is a no-op on Windows filesystems that ignore the POSIX bits.
    try { fs.chmodSync(helperPath(), 0o755); } catch {}
    emitProgress(`extracted ${helperBinaryName()}`);
    helperVerified = true;
    helperVerifiedAt = Date.now();
    emitProgress(`helper ready (${helperBinaryName()})`);
    return true;
  } catch (err) {
    emitProgress(`helper not available: ${err.message}`);
    return false;
  }
}

// ------------------------------------------------------------------ tunnel ---

async function findFreePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", () => resolve(0));
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

function portReachable(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const done = (ok) => {
      try { socket.destroy(); } catch {}
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    setTimeout(() => done(false), 1_000).unref();
  });
}

function metricsHandshakeOk(port) {
  return new Promise(async (resolve) => {
    for (let attempt = 0; attempt < METRICS_HANDSHAKE_RETRIES; attempt += 1) {
      try {
        const text = await fetch(`http://127.0.0.1:${port}/metrics`, {
          signal: AbortSignal.timeout(700),
        }).then((r) => r.text());
        const match = /^last_handshake_time_sec=(\d+)/m.exec(text);
        if (match && Number(match[1]) > HANDSHAKE_MIN_TIME) return resolve(true);
        return resolve(false);
      } catch {}
      await new Promise((r) => setTimeout(r, METRICS_HANDSHAKE_RETRY_MS));
    }
    resolve(false);
  });
}

function pickEndpoint(device) {
  // A previously working endpoint is reused ~80% of the time: reconnecting to
  // the same endpoint is what keeps a tunnel cheap, and a random retry would
  // only shuffle latency.
  if (lastWorkingEndpoint && Math.random() < 0.8) return lastWorkingEndpoint;
  const ports = device.endpointPorts?.length ? device.endpointPorts : [2408];
  const ips = device.endpointIps?.length ? device.endpointIps : [device.endpointHost];
  const ip = ips[Math.floor(Math.random() * ips.length)];
  const port = ports[Math.floor(Math.random() * ports.length)];
  return `${ip}:${port}`;
}

/** Generate the wireproxy config text for one device + one local bind port. */
function buildHelperConfig(device, bindPort, endpoint) {
  const lines = [
    "[Interface]",
    `PrivateKey = ${device.privateKey}`,
    `Address = ${device.address4}/32${device.address6 ? `, ${device.address6}/128` : ""}`,
    "DNS = 1.1.1.1",
    "",
    "[Peer]",
    `PublicKey = ${device.peerPublicKey}`,
    "AllowedIPs = 0.0.0.0/0, ::/0",
    `Endpoint = ${endpoint}`,
    "PersistentKeepalive = 25",
    "",
    "[http]",
    `BindAddress = 127.0.0.1:${bindPort}`,
    "",
  ];
  return lines.join("\n");
}

async function stopTunnel() {
  if (tunnelProc) {
    const proc = tunnelProc;
    tunnelProc = null;
    tunnelPort = 0;
    tunnelEndpoint = null;
    lastWorkingEndpoint = null;
    try { proc.removeAllListeners("exit"); } catch {}
    try { proc.kill("SIGTERM"); } catch {}
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
}

async function startTunnel(device) {
  await stopTunnel();
  if (!(await ensureHelper())) return false;
  const bindPort = await findFreePort();
  if (!bindPort) {
    emitProgress("no free local port");
    return false;
  }
  const endpoint = pickEndpoint(device);
  const configPath = path.join(warpHome(), `warp-proxy-${bindPort}.conf`);
  fs.mkdirSync(warpHome(), { recursive: true });
  fs.writeFileSync(configPath, buildHelperConfig(device, bindPort, endpoint));
  emitProgress(`generated config for ${device.id} (tunnel bind 127.0.0.1:${bindPort})`);

  const logFd = fs.openSync(logFile(), "a");
  const child = spawn(helperPath(), [
    "-c", configPath,
    "-s", ...(metricsPort ? ["-i", `127.0.0.1:${metricsPort}`] : []),
  ], { stdio: ["ignore", logFd, logFd], detached: false });
  fs.closeSync(logFd);

  tunnelProc = child;
  tunnelPort = bindPort;
  tunnelEndpoint = endpoint;
  emitProgress(`connecting to ${endpoint}`);

  child.on("error", (err) => emitProgress(`tunnel would not start: ${err.message}`));
  child.once("exit", (code, signal) => {
    if (tunnelProc !== child) return;
    emitProgress(`tunnel exited on its own (${signal ?? code})`);
    tunnelProc = null;
    tunnelPort = 0;
    tunnelEndpoint = null;
    lastWorkingEndpoint = null;
  });

  for (let attempt = 0; attempt < PROBE_MAX_ATTEMPTS; attempt += 1) {
    if (child.exitCode !== null) break;
    if (await portReachable(bindPort)) {
      lastWorkingEndpoint = endpoint;
      emitProgress("tunnel up");
      return true;
    }
    await new Promise((r) => setTimeout(r, PROBE_RETRY_MS));
  }
  await stopTunnel();
  emitProgress(`tunnel did not come up on ${endpoint}`);
  return false;
}

async function currentExitIp(proxyUrl, deadline) {
  for (const url of EXIT_IP_URLS) {
    try {
      const text = await fetch(url, {
        proxy: proxyUrl,
        signal: AbortSignal.timeout(Math.min(Math.max(1_000, deadline - Date.now()), EXIT_IP_TIMEOUT_MS)),
      }).then((r) => r.text());
      const ip = String(text).trim();
      if (ip && /^[\d.a-fA-F:]+$/.test(ip)) return ip;
    } catch {}
    if (Date.now() >= deadline) return null;
  }
  return null;
}

async function tunnelExitIp(proxyUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ip = await currentExitIp(proxyUrl, deadline);
    if (ip || Date.now() >= deadline) return ip;
    await new Promise((r) => setTimeout(r, ROTATION_PROBE_RETRY_MS));
  }
}

// ------------------------------------------------------------- burned nets ---

let burnedCache = null;

function loadBurned() {
  if (burnedCache) return burnedCache;
  const now = Date.now();
  const map = new Map();
  try {
    const parsed = JSON.parse(fs.readFileSync(burnedFile(), "utf8"));
    if (Array.isArray(parsed)) {
      for (const entry of parsed) if (typeof entry === "string") map.set(entry, now);
    } else if (parsed?.keys && !Array.isArray(parsed.keys)) {
      for (const [key, value] of Object.entries(parsed.keys)) map.set(key, Number(value) || now);
    } else if (Array.isArray(parsed?.keys)) {
      const at = Number(parsed.at) || now;
      for (const key of parsed.keys) if (typeof key === "string") map.set(key, at);
    }
  } catch {}
  for (const [key, at] of map) if (!(now - at < BURNED_TTL_MS)) map.delete(key);
  burnedCache = map;
  return map;
}

let burnedWriteTimer = null;
function persistBurned() {
  if (burnedWriteTimer) return;
  burnedWriteTimer = setTimeout(() => {
    burnedWriteTimer = null;
    try {
      fs.mkdirSync(warpHome(), { recursive: true });
      fs.writeFileSync(
        burnedFile(),
        JSON.stringify({ version: 2, keys: Object.fromEntries(burnedCache ?? new Map()) }) + "\n",
        { mode: 0o600 },
      );
    } catch {}
  }, BURNED_WRITE_DEBOUNCE_MS);
}

function markBurned(networkId) {
  if (!networkId) return;
  const map = loadBurned();
  if (map.has(networkId)) return;
  map.set(networkId, Date.now());
  if (map.size > BURNED_MAX_ENTRIES) {
    const excess = [...map.entries()].sort((a, b) => a[1] - b[1]).slice(0, map.size - BURNED_MAX_ENTRIES);
    for (const [key] of excess) map.delete(key);
  }
  persistBurned();
}

/**
 * Collapse an IPv6 address to the /64 network id the rotation loop burns.
 * `2001:db8:1:2::3` and `2001:db8:1:2::f` are the same WARP network, so a
 * rotation that only moves inside one /64 would loop forever without this.
 */
function networkIdOf(ip) {
  if (!ip) return null;
  if (!ip.includes(":")) return ip;
  const [head, tail = null] = ip.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail === null ? [] : tail.split(":");
  const middle = tail === null
    ? []
    : [...Array(Math.max(0, 8 - headParts.length - tailParts.length)).fill("0"), ...tailParts];
  const groups = [...headParts, ...middle];
  return groups
    .slice(0, 4)
    .map((g) => g.toLowerCase().replace(/^0+(?=.)/, ""))
    .join(":");
}

// ---------------------------------------------------------------- rotation ---

async function ensureDevice() {
  if (deviceCache) return deviceCache;
  const saved = readDevice();
  if (saved) {
    deviceCache = saved;
    return saved;
  }
  try {
    deviceCache = await registerDevice();
    return deviceCache;
  } catch (err) {
    emitProgress(`could not register: ${err.message}`);
    deviceCache = null;
    return null;
  }
}

async function probeCurrentAddress() {
  const proxyUrl = currentProxyUrl();
  const deadline = Date.now() + ROTATION_PROBE_TIMEOUT_MS;
  return proxyUrl ? tunnelExitIp(proxyUrl, ROTATION_PROBE_TIMEOUT_MS) : directExitIp(deadline);
}

/**
 * Ask the live gateway whether this exit IP still has free-tier allowance.
 * The probe uses the inference endpoint, so a 429 is the authoritative "this
 * IP is spent" answer; any other status or a network error is not an IP
 * verdict and reads as unknown (the gate can refuse shapes, not just IPs).
 */
async function probeIpHealth(proxyUrl) {
  const init = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "big-pickle",
      max_tokens: 1,
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    }),
    signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
  };
  try {
    const res = await fetch("https://opencode.ai/inference/v1/chat/completions", {
      ...init,
      proxy: proxyUrl,
    });
    if (res.status === 429) return { state: "dirty", status: 429 };
    if (res.ok) return { state: "clean", status: res.status };
    return { state: "unknown", status: res.status };
  } catch (err) {
    return { state: "unknown", status: null, error: err.message };
  }
}

async function directExitIp(deadline) {
  for (const url of EXIT_IP_URLS) {
    try {
      const text = await fetch(url, {
        signal: AbortSignal.timeout(Math.min(Math.max(1_000, deadline - Date.now()), EXIT_IP_TIMEOUT_MS)),
      }).then((r) => r.text());
      const ip = String(text).trim();
      if (ip && /^[\d.a-fA-F:]+$/.test(ip)) return ip;
    } catch {}
    if (Date.now() >= deadline) return null;
  }
  return null;
}

async function rotate() {
  if (!enabled) return null;
  if (!rotationInFlight) {
    rotationInFlight = rotateNow();
    rotationInFlight.finally(() => { rotationInFlight = null; });
  }
  return rotationInFlight;
}

async function rotateNow() {
  const before = await probeCurrentAddress();
  if (before && tunnelProxyUrl === null) markBurned(networkIdOf(before));
  const beforeNetworkId = networkIdOf(before);
  if (beforeNetworkId) markBurned(beforeNetworkId);

  let device = await ensureDevice();
  if (!device) return null;

  let success = false;
  for (let attempt = 1; attempt <= WARP_ATTEMPTS; attempt += 1) {
    if (attempt === KEY_ROTATE_ATTEMPT) {
      const rotated = await rotateDeviceKeys(device);
      if (rotated) device = rotated;
    }
    if (attempt === WARP_ATTEMPTS && !success && Date.now() >= rateLimitUntil) {
      try {
        const replacement = await registerDevice();
        deviceCache = replacement;
        device = replacement;
      } catch (err) {
        emitProgress(`could not replace the device: ${err.message}`);
      }
    }
    if (!(await startTunnel(device))) {
      emitProgress(`tunnel would not start (attempt ${attempt}/${WARP_ATTEMPTS})`);
      continue;
    }
    const after = await tunnelExitIp(currentProxyUrl(), ROTATION_PROBE_TIMEOUT_MS);
    if (!after) {
      emitProgress(`no address through the tunnel (attempt ${attempt}/${WARP_ATTEMPTS})`);
      continue;
    }
    const afterNetworkId = networkIdOf(after);
    if (after === before || (afterNetworkId && afterNetworkId === beforeNetworkId) || loadBurned().has(afterNetworkId)) {
      emitProgress(`the tunnel came up on an already used network (${after})`);
      continue;
    }
    markBurned(afterNetworkId);
    success = true;
    emitProgress(`rotated: ${before ?? "unknown"} -> ${after}${afterNetworkId && afterNetworkId !== after ? ` [${afterNetworkId}]` : ""}`);
    break;
  }

  if (!success) {
    emitProgress("no fresh network is available");
    return null;
  }
  return currentProxyUrl();
}

// ----------------------------------------------------------------- runtime ---

let enabled = false;
let deviceCache = null;
let rateLimitUntil = 0;
let tunnelProc = null;
let tunnelPort = 0;
let tunnelEndpoint = null;
let lastWorkingEndpoint = null;
let metricsPort = 0;
let helperVerified = false;
let helperVerifiedAt = 0;
let rotationInFlight = null;
let idleKillTimer = null;
let currentProxyUrlValue = null;
let tunnelProxyUrl = null;

function currentProxyUrl() {
  return currentProxyUrlValue;
}

function tunnelProxyUrlCurrent() {
  return tunnelProxyUrl;
}

/**
 * `enabled` answers the toggle; `egressUrl()` answers only the wire: a tunnel
 * that never started must not be handed to fetch({ proxy }).
 */
function egressUrl() {
  if (!enabled) return null;
  if (!tunnelProc || !tunnelPort) return null;
  return `http://127.0.0.1:${tunnelPort}`;
}

function isEnabled() {
  return enabled;
}

async function setEnabled(next) {
  const want = Boolean(next);
  if (want === enabled) return { ok: true, enabled, reason: "no-op" };
  if (want && process.env.UPSTREAM_PROXY_URL) {
    return { ok: false, enabled, error: "UPSTREAM_PROXY_URL is set; the operator lock wins" };
  }
  if (!want) {
    enabled = false;
    await stopTunnel();
    persistRuntime();
    emitProgress("warp disabled");
    return { ok: true, enabled: false };
  }
  const device = await ensureDevice();
  if (!device) return { ok: false, enabled: false, error: "no WARP device could be registered" };
  emitProgress(`device ${device.id} ready (${device.address6 ?? device.address4})`);
  if (!(await ensureHelper())) return { ok: false, enabled: false, error: "wireproxy helper unavailable" };
  if (!(await startTunnel(device))) return { ok: false, enabled: false, error: "tunnel did not start" };
  // Sample the exit IP once so /health and the panel can show it instead of
  // null until the first rotation; a failed probe stays null on purpose.
  const initialExitIp = await tunnelExitIp(egressUrl(), ROTATION_PROBE_TIMEOUT_MS);
  if (initialExitIp) {
    lastExitIp = initialExitIp;
    emitProgress(`connected. exit ip: ${initialExitIp}`);
    const health = await probeIpHealth(egressUrl());
    lastExitHealth = health.state;
    lastExitHealthStatus = health.status;
    emitProgress(
      health.state === "clean"
        ? "ip health: clean"
        : health.state === "dirty"
          ? "ip health: dirty (quota already spent on this IP; rotate or wait for reset)"
          : `ip health: unknown (HTTP ${health.status ?? "network error"})`
    );
  }
  enabled = true;
  persistRuntime();
  emitProgress("warp enabled");
  return { ok: true, enabled: true };
}

function describe() {
  const burned = loadBurned();
  return {
    enabled,
    device: deviceCache
      ? { id: deviceCache.id, address: deviceCache.address6 ?? deviceCache.address4 }
      : readDevice()?.id
        ? { id: readDevice().id, address: readDevice().address6 ?? readDevice().address4 }
        : null,
    tunnel: tunnelProc
      ? {
          port: tunnelPort,
          endpoint: tunnelEndpoint,
          exitIp: lastExitIp,
          ipHealth: lastExitHealth,
          ipHealthStatus: lastExitHealthStatus,
        }
      : null,
    egressUrl: egressUrl(),
    burned: burned.size,
    rateLimitedUntil: rateLimitUntil > Date.now() ? rateLimitUntil : null,
    home: warpHome(),
  };
}

// ---------------------------------------------------------- process hooks ---

function armIdleKill() {
  clearTimeout(idleKillTimer);
  idleKillTimer = setTimeout(() => {
    idleKillTimer = null;
    if (!enabled) return;
    if (tunnelProc && Date.now() - lastTunnelUse > DEFAULT_IDLE_KILL_MS) {
      appendLog("idle tunnel reaped");
      stopTunnel();
    }
    armIdleKill();
  }, DEFAULT_IDLE_KILL_MS);
}

let lastTunnelUse = 0;

function noteTunnelUse() {
  lastTunnelUse = Date.now();
}

function persistRuntime() {
  try {
    fs.mkdirSync(warpHome(), { recursive: true });
    fs.writeFileSync(
      path.join(warpHome(), "warp-state.json"),
      JSON.stringify({ enabled }) + "\n",
      { mode: 0o600 },
    );
  } catch {}
}

/**
 * Boot path: the toggle never auto-activates. Clear both the in-memory flag
 * and the persisted file, so a restart is a fresh off, not a resume of the
 * last session's on.
 */
function resetRuntime() {
  enabled = false;
  try { fs.rmSync(path.join(warpHome(), "warp-state.json"), { force: true }); } catch {}
  persistRuntime();
}

function appendLog(line) {
  try {
    fs.mkdirSync(warpHome(), { recursive: true });
    const stamp = new Date().toISOString();
    fs.appendFileSync(logFile(), `${stamp} ${line}\n`);
    try {
      const size = fs.statSync(logFile()).size;
      if (size > MAX_LOG_BYTES) rotateLog();
    } catch {}
  } catch {}
}

// ------------------------------------------------------------ progress feed ---

// Toggle-on is a multi-second sequence (device, helper download, config,
// tunnel, probe). Callers subscribe before setEnabled and receive the same
// lines the log gets, so a UI can show each step as it happens.
const progressSubscribers = new Set();

function emitProgress(line) {
  appendLog(line);
  for (const subscriber of progressSubscribers) {
    try { subscriber({ at: Date.now(), message: line }); } catch {}
  }
}

function onProgress(callback) {
  progressSubscribers.add(callback);
  return () => progressSubscribers.delete(callback);
}

function rotateLog() {
  try {
    fs.copyFileSync(logFile(), logFile() + ".1");
    fs.truncateSync(logFile(), 0);
  } catch {}
}

function shutdown() {
  clearTimeout(idleKillTimer);
  clearTimeout(burnedWriteTimer);
  if (tunnelProc) {
    try { tunnelProc.removeAllListeners("exit"); } catch {}
    try { tunnelProc.kill("SIGTERM"); } catch {}
    tunnelProc = null;
  }
}

function metricsPortForTest(port) {
  metricsPort = port;
}

let lastExitIp = null;
let lastExitHealth = null;
let lastExitHealthStatus = null;

function setLastExitIpForTest(ip) {
  lastExitIp = ip;
}

function setExitHealthForTest(state) {
  lastExitHealth = state;
}

async function noteExitIp(ip) {
  if (!ip) return;
  lastExitIp = ip;
  markBurned(networkIdOf(ip));
}

module.exports = {
  // constants exposed for tests and /health
  ROTATE_SUCCESS_DELAY_MS,
  ROTATE_FAILURE_DELAY_MS,
  WARP_ATTEMPTS,
  KEY_ROTATE_ATTEMPT,
  REGISTER_URL,
  CLIENT_VERSION,
  isEnabled,
  setEnabled,
  onProgress,
  egressUrl,
  rotate,
  describe,
  shutdown,
  noteExitIp,
  noteTunnelUse,
  ensureHelper,
  helperArchiveName,
  helperBinaryName,
  buildHelperConfig,
  networkIdOf,
  markBurned,
  loadBurned,
  registerDevice,
  rotateDeviceKeys,
  ensureDevice,
  startTunnel,
  stopTunnel,
  tunnelExitIp,
  directExitIp,
  probeCurrentAddress,
  probeIpHealth,
  armIdleKill,
  resetRuntime,
  persistRuntime,
  appendLog,
  metricsPortForTest,
  setLastExitIpForTest,
  setExitHealthForTest,
  helperPath,
  warpHome,
  deviceFile,
  burnedFile,
  logFile,
  stateDir,
  __setDeviceForTest(device) {
    deviceCache = device;
  },
  __setEnabledForTest(v) {
    enabled = Boolean(v);
  },
  __getTunnelPort: () => tunnelPort,
  __getRotationInFlight: () => rotationInFlight,
  __getRateLimitUntil: () => rateLimitUntil,
};
