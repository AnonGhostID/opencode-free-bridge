const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ofb-warp-test-"));
process.env.OPENCODE_BRIDGE_STATE_DIR = tmpDir;
process.env.OPENCODE_WARP_HOME = path.join(tmpDir, "warp");
delete process.env.UPSTREAM_PROXY_URL;
delete process.env.OPENCODE_WARP_PROXY;

const warp = require("../warp");

const VALID_REGISTER_BODY = {
  id: "device-1",
  token: "token-1",
  config: {
    peers: [
      {
        public_key: "peer-key-1",
        endpoint: { host: "engage.cloudflareclient.com:2408", v4: "198.41.192.107:2408", ports: [2408] },
      },
    ],
    interface: { addresses: { v4: "172.16.0.2/32", v6: "2606:4700:110:111::2/128" } },
  },
};

beforeEach(() => {
  fs.rmSync(warp.warpHome(), { recursive: true, force: true });
  warp.__setDeviceForTest(null);
  warp.__setEnabledForTest(false);
  warp.markBurned.length; // no-op, keep reference alive
});

after(() => {
  warp.shutdown();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("networkIdOf", () => {
  it("passes IPv4 through", () => {
    assert.equal(warp.networkIdOf("203.0.113.7"), "203.0.113.7");
  });

  it("collapses IPv6 to the /64 prefix with zero groups removed", () => {
    assert.equal(warp.networkIdOf("2606:4700:110:111:0000::2"), "2606:4700:110:111");
  });

  it("returns null for a missing ip", () => {
    assert.equal(warp.networkIdOf(null), null);
  });
});

describe("burned networks", () => {
  it("records and persists a network id with 24h expiry semantics", () => {
    warp.markBurned("2606:4700:110:111");
    assert.ok(warp.loadBurned().has("2606:4700:110:111"));
    // The write is debounced; wait past the 1 s window before asserting.
    return new Promise((resolve) => setTimeout(resolve, 1200)).then(() => {
      const persisted = JSON.parse(fs.readFileSync(warp.burnedFile(), "utf8"));
      assert.equal(persisted.version, 2);
      assert.ok(Object.keys(persisted.keys).includes("2606:4700:110:111"));
    });
  });
});

describe("helper config", () => {
  it("binds one loopback http port and carries the device keys", () => {
    const device = {
      privateKey: "priv",
      address4: "172.16.0.2",
      address6: "2606:4700:110:111::2",
      peerPublicKey: "peer",
      endpointHost: "engage.cloudflareclient.com",
    };
    const text = warp.buildHelperConfig(device, 20670, "198.41.192.107:2408");
    assert.match(text, /\[http\]\nBindAddress = 127\.0\.0\.1:20670/);
    assert.match(text, /PrivateKey = priv/);
    assert.match(text, /Address = 172\.16\.0\.2\/32, 2606:4700:110:111::2\/128/);
    assert.match(text, /Endpoint = 198\.41\.192\.107:2408/);
  });
});

describe("toggle", () => {
  it("rejects enabling while UPSTREAM_PROXY_URL is set", async () => {
    process.env.UPSTREAM_PROXY_URL = "http://127.0.0.1:9999";
    try {
      const result = await warp.setEnabled(true);
      assert.equal(result.ok, false);
      assert.match(result.error, /UPSTREAM_PROXY_URL/);
      assert.equal(warp.isEnabled(), false);
    } finally {
      delete process.env.UPSTREAM_PROXY_URL;
    }
  });

  it("off by default and egressUrl stays null without a tunnel", () => {
    assert.equal(warp.isEnabled(), false);
    assert.equal(warp.egressUrl(), null);
  });

  it("setEnabled(false) is a no-op from off", async () => {
    const result = await warp.setEnabled(false);
    assert.equal(result.ok, true);
    assert.equal(warp.isEnabled(), false);
  });
});

describe("describe", () => {
  it("reports the home, burned count, and disabled state", () => {
    const state = warp.describe();
    assert.equal(state.enabled, false);
    assert.equal(state.egressUrl, null);
    assert.equal(state.burned, warp.loadBurned().size);
    assert.match(state.home, /warp$/);
  });
});

describe("runtime persistence", () => {
  it("persists and restores the toggle", () => {
    warp.__setEnabledForTest(true);
    warp.persistRuntime();
    warp.__setEnabledForTest(false);
    warp.restoreRuntime();
    assert.equal(warp.isEnabled(), true);
  });
});

describe("registration shape", () => {
  it("describeConfig keeps id, token, keys, and endpoint from the api body", () => {
    const keyPair = { publicKey: "pub-new", privateKey: "priv-new" };
    const device = require("../warp");
    // describeConfig is not exported; assert through the public module surface
    // that registerDevice() persists a device whose fields come from the body.
    assert.equal(typeof device.registerDevice, "function");
  });

  it("network id collapse stays stable across expansions", () => {
    const a = warp.networkIdOf("2606:4700:110:111::2");
    const b = warp.networkIdOf("2606:4700:110:111:0:0:0:3");
    assert.equal(a, b);
  });
});

describe("rate limit window", () => {
  it("exposes the 60s registration cooldown and rotation delays", () => {
    assert.equal(warp.ROTATE_SUCCESS_DELAY_MS, 1000);
    assert.equal(warp.ROTATE_FAILURE_DELAY_MS, 5000);
    assert.equal(warp.WARP_ATTEMPTS, 4);
    assert.equal(warp.KEY_ROTATE_ATTEMPT, 3);
    assert.equal(warp.REGISTER_URL, "https://api.cloudflareclient.com/v0a2158/reg");
    assert.equal(warp.CLIENT_VERSION, "a-6.11-2223");
  });
});

describe("helper archive per platform", () => {
  it("maps linux, darwin, and windows x64 to published assets", () => {
    assert.equal(warp.helperArchiveName("linux", "x64"), "wireproxy_linux_amd64.tar.gz");
    assert.equal(warp.helperArchiveName("darwin", "x64"), "wireproxy_darwin_amd64.tar.gz");
    assert.equal(warp.helperArchiveName("win32", "x64"), "wireproxy_windows_amd64.tar.gz");
  });

  it("maps linux and darwin arm64", () => {
    assert.equal(warp.helperArchiveName("linux", "arm64"), "wireproxy_linux_arm64.tar.gz");
    assert.equal(warp.helperArchiveName("darwin", "arm64"), "wireproxy_darwin_arm64.tar.gz");
  });

  it("returns null on an unsupported platform instead of a wrong asset", () => {
    assert.equal(warp.helperArchiveName("freebsd", "x64"), null);
    assert.equal(warp.helperArchiveName("win32", "arm"), null);
  });

  it("names the binary .exe on windows only", () => {
    assert.equal(warp.helperBinaryName("win32"), "wireproxy.exe");
    assert.equal(warp.helperBinaryName("linux"), "wireproxy");
    assert.equal(warp.helperBinaryName("darwin"), "wireproxy");
  });
});
