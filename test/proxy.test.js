const { describe, it, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ofb-proxy-test-"));
process.env.OPENCODE_BRIDGE_STATE_DIR = tmpDir;
delete process.env.UPSTREAM_PROXY_URL;

const proxy = require("../proxy");
const panel = require("../panel");
const srv = require("../server");

function request(port, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: urlPath,
        method,
        headers: {
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, raw: data }));
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function emptyStateDir() {
  // Describes run in order and each one's `after` cleans up, so this recreates
  // the directory instead of assuming an earlier suite left it in place.
  fs.mkdirSync(tmpDir, { recursive: true });
  for (const f of fs.readdirSync(tmpDir)) fs.rmSync(path.join(tmpDir, f), { force: true });
}

describe("egress proxy", () => {
  beforeEach(() => {
    emptyStateDir();
    proxy.__reload();
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("accepts http and https proxies with optional percent-encoded credentials", () => {
    assert.deepEqual(proxy.parseProxyUrl("http://127.0.0.1:8080"), { ok: true, url: "http://127.0.0.1:8080" });
    assert.deepEqual(proxy.parseProxyUrl(" https://proxy.example.com:3128 "), {
      ok: true,
      url: "https://proxy.example.com:3128",
    });
    // Credentials keep their encoding: Bun decodes them for Proxy-Authorization.
    assert.equal(proxy.parseProxyUrl("http://us%40er:p%3Ass@host:8080").url, "http://us%40er:p%3Ass@host:8080");
    assert.equal(proxy.parseProxyUrl("http://user@host:8080").url, "http://user@host:8080");
    // Empty means direct egress, which is how the panel clears the setting.
    assert.deepEqual(proxy.parseProxyUrl("   "), { ok: true, url: "" });
  });

  it("refuses SOCKS and malformed URLs with a reason instead of failing inside a request", () => {
    const socks = proxy.parseProxyUrl("socks5://127.0.0.1:1080");
    assert.equal(socks.ok, false);
    assert.match(socks.error, /SOCKS5/);

    for (const bad of ["not a url", "http://", "http://host:8080/some/path", "ftp://host:21"]) {
      const parsed = proxy.parseProxyUrl(bad);
      assert.equal(parsed.ok, false, `${bad} must be refused`);
      assert.ok(parsed.error);
    }
  });

  it("persists the proxy to disk with owner-only permissions and never echoes credentials", () => {
    const saved = proxy.setProxyUrl("http://user:secret@10.0.0.5:8080");
    assert.equal(saved.ok, true);
    assert.equal(saved.mode, "proxy");
    assert.equal(saved.proxy, "10.0.0.5:8080");
    assert.equal(saved.hasCredentials, true);
    assert.equal(JSON.stringify(saved).includes("secret"), false, "describe() must not leak the password");

    const file = proxy.configFile();
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).url, "http://user:secret@10.0.0.5:8080");

    // A fresh process reads the same file.
    proxy.__reload();
    assert.equal(proxy.getProxyUrl(), "http://user:secret@10.0.0.5:8080");
    assert.equal(proxy.describe().source, "file");
  });

  it("clearing the URL returns to direct egress and removes the file", () => {
    proxy.setProxyUrl("http://127.0.0.1:8080");
    const cleared = proxy.setProxyUrl("");
    assert.equal(cleared.ok, true);
    assert.equal(cleared.mode, "direct");
    assert.equal(proxy.getProxyUrl(), "");
    assert.equal(fs.existsSync(proxy.configFile()), false);
  });

  it("ignores a corrupt config file instead of refusing to boot", () => {
    fs.writeFileSync(proxy.configFile(), "{not json", "utf8");
    proxy.__reload();
    assert.equal(proxy.getProxyUrl(), "");
    assert.match(proxy.describe().error, /proxy\.json/);
  });

  it("lets UPSTREAM_PROXY_URL win and refuses runtime edits while it is set", () => {
    process.env.UPSTREAM_PROXY_URL = "http://env-proxy:9000";
    proxy.__reload();
    try {
      assert.equal(proxy.getProxyUrl(), "http://env-proxy:9000");
      assert.equal(proxy.describe().locked, true);
      const attempt = proxy.setProxyUrl("http://other:1");
      assert.equal(attempt.ok, false);
      assert.match(attempt.error, /UPSTREAM_PROXY_URL/);
      assert.equal(proxy.getProxyUrl(), "http://env-proxy:9000");
    } finally {
      delete process.env.UPSTREAM_PROXY_URL;
      proxy.__reload();
    }
  });

  it("injects proxy: into every fetch init, and only when one is configured", () => {
    assert.deepEqual(proxy.withProxy({ headers: { a: "b" } }), { headers: { a: "b" } });

    proxy.setProxyUrl("http://127.0.0.1:8080");
    assert.equal(proxy.withProxy({ signal: "s" }).proxy, "http://127.0.0.1:8080");
    // A caller that pins its own proxy keeps it.
    assert.equal(proxy.withProxy({ proxy: "http://pinned:1" }).proxy, "http://pinned:1");

    let seen = null;
    const original = global.fetch;
    global.fetch = async (url, init) => {
      seen = { url, init };
      return { ok: true, json: async () => ({}) };
    };
    try {
      proxy.netFetch("https://example.com/x", { method: "GET" });
    } finally {
      global.fetch = original;
    }
    assert.equal(seen.init.proxy, "http://127.0.0.1:8080");
    assert.equal(seen.init.method, "GET");
  });

  // `testProxy` refuses to run on Node because Node's fetch silently ignores
  // the `proxy` init option: the probe would report "ok" while the request went
  // out directly. That refusal is the correct behaviour, so the live-probe
  // assertions only apply where the option is actually honoured.
  const PROBE_RUNTIME = typeof Bun !== "undefined";

  it("refuses to probe on a runtime whose fetch ignores the proxy option", async () => {
    if (PROBE_RUNTIME) return;
    const verdict = await proxy.testProxy("http://127.0.0.1:8080");
    assert.equal(verdict.ok, false);
    assert.match(verdict.error, /Bun/);
  });

  it("reports a proxy that cannot reach upstream, and the exit IP when it can", async () => {
    if (!PROBE_RUNTIME) return;
    const original = global.fetch;
    try {
      global.fetch = async (url, init) => {
        if (String(url).includes("cdn-cgi/trace")) return { ok: true, text: async () => "ip=203.0.113.9\nloc=SG\n" };
        assert.equal(init.proxy, "http://127.0.0.1:8080");
        return { ok: true, status: 200 };
      };
      const ok = await proxy.testProxy("http://127.0.0.1:8080");
      assert.equal(ok.ok, true);
      assert.equal(ok.apiStatus, 200);
      assert.equal(ok.exitIp, "203.0.113.9");

      global.fetch = async (url) => {
        if (String(url).includes("cdn-cgi/trace")) throw new Error("tunnel refused");
        return { ok: false, status: 403 };
      };
      const refused = await proxy.testProxy("http://127.0.0.1:8080");
      assert.equal(refused.ok, false);
      assert.equal(refused.apiStatus, 403);
      assert.match(refused.error, /403/);
    } finally {
      global.fetch = original;
    }
  });
});

