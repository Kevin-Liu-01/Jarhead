// The test preload. `pnpm test`, and each package's own `test` script, imports it after tsx, into
// the runner and into every test file's process (node --test hands its execArgv to each child). It
// makes the suite hermetic on any Mac:
//
// - JARHEAD_STATE_DIR is a fresh temp dir, so the state dir (its env file, settings, ledger,
//   socket) is never ~/.jarhead. Every other JARHEAD_* variable is unset, all but the suite's own
//   JARHEAD_TEST_* knobs, and so is every secret key (SECRET_KEYS). A key or a setting exported by
//   the shell, or loaded from ~/.jarhead/env into the daemon that runs a self-edit's tests, never
//   reaches a test. JARHEAD_AUTO_WAKE=0 and JARHEAD_NO_AUDIO=1.
// - fetch to anything but loopback never leaves the Mac. It answers a synthetic 401, as a server
//   would for a key it does not know. Under JARHEAD_TEST_NET=strict (CI) it throws instead, so a
//   test that reaches for the network fails by name.
// - A WebSocket to anything but loopback is refused.
// - Every temp dir a test makes under os.tmpdir() with mkdtemp is removed when its process exits.
//
// JARHEAD_TEST_NET_LOG=<file> appends one line per off-Mac attempt: pid, verdict, method and URL.
// Never a header or a body.
//
// One read of ~/.jarhead is left. The brain runner's SecretRedactor (packages/brain/src/shell.ts)
// reads $HOME/.jarhead/env to learn which values to strike from results. It only reads: what it
// holds is never sent and never in a config. It goes when the redactor reads the state dir's env
// file, the one loadEnv reads (handed to W1-6).
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { SECRET_KEYS } from "@jarhead/protocol";

// ---- temp dirs: every one a test makes is gone at exit -----------------------------------------

const made = new Set();
const underTmp = (path) => resolve(path).startsWith(resolve(tmpdir()) + sep);
const realMkdtempSync = fs.mkdtempSync;
const realMkdtemp = fs.promises.mkdtemp;
fs.mkdtempSync = function mkdtempSync(prefix, options) {
  const dir = realMkdtempSync.call(fs, prefix, options);
  if (typeof dir === "string" && underTmp(dir)) made.add(dir);
  return dir;
};
fs.promises.mkdtemp = async function mkdtemp(prefix, options) {
  const dir = await realMkdtemp.call(fs.promises, prefix, options);
  if (typeof dir === "string" && underTmp(dir)) made.add(dir);
  return dir;
};
syncBuiltinESMExports();
process.on("exit", () => {
  for (const dir of made) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // A dir still busy at exit stays; nothing else depends on it.
    }
  }
});

// ---- state and keys ----------------------------------------------------------------------------

for (const key of Object.keys(process.env)) {
  if (key.startsWith("JARHEAD_") && !key.startsWith("JARHEAD_TEST_")) delete process.env[key];
}
for (const key of SECRET_KEYS) delete process.env[key];
process.env["JARHEAD_STATE_DIR"] = fs.mkdtempSync(join(tmpdir(), "jh-test-state-"));
process.env["JARHEAD_AUTO_WAKE"] = "0";
process.env["JARHEAD_NO_AUDIO"] = "1";

// ---- the network -------------------------------------------------------------------------------

const strict = process.env["JARHEAD_TEST_NET"] === "strict";
const netLog = process.env["JARHEAD_TEST_NET_LOG"];
const LOOPBACK = /^(localhost|[\w.-]+\.localhost|127(\.\d{1,3}){3}|\[::1\])$/i;
const offMac = (url) => !LOOPBACK.test(url.hostname);
const note = (verdict, what) => {
  if (netLog) fs.appendFileSync(netLog, `${process.pid} ${verdict} ${what}\n`);
};

const realFetch = globalThis.fetch;
globalThis.fetch = async function fetch(input, init) {
  const request = input instanceof Request ? input : undefined;
  const url = new URL(request ? request.url : String(input));
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !offMac(url)) return realFetch(input, init);
  const what = `${(init?.method ?? request?.method ?? "GET").toUpperCase()} ${url.origin}${url.pathname}`;
  init?.signal?.throwIfAborted();
  if (strict) {
    note("refused", what);
    throw new TypeError(`fetch failed (JARHEAD_TEST_NET=strict: ${what} is off this Mac)`);
  }
  note("401", what);
  const body = { error: { message: `no network in tests: ${what}`, type: "invalid_request_error", code: "invalid_api_key" } };
  return new Response(JSON.stringify(body), { status: 401, headers: { "content-type": "application/json", "x-jarhead-test": "offline" } });
};

const RealWebSocket = globalThis.WebSocket;
if (RealWebSocket) {
  globalThis.WebSocket = class WebSocket extends RealWebSocket {
    constructor(address, protocols) {
      const url = new URL(String(address));
      if (offMac(url)) {
        note("refused", `WebSocket ${url.origin}${url.pathname}`);
        throw new Error(`WebSocket refused: ${url.origin}${url.pathname} is off this Mac (tests)`);
      }
      super(address, protocols);
    }
  };
}
