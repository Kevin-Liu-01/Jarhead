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
// - The desktop is fenced: osascript, open, say, afplay, shortcuts, automator and screencapture never
//   run. A stub of each name comes first on PATH (so a shell line or a bare spawn finds it), and an
//   absolute /usr/bin or /usr/sbin path to one, spawned or inside a shell string, is pointed at the
//   stub. The stub prints why on stderr and exits 1, as a script would that the Mac refused. Without
//   this, a test that sends `tell application "Spotify" to play` through the real runner plays music,
//   and one that sends keystrokes types them into whatever app is in front. osascript's stub answers
//   the one script with no effect at all, a lone `return` of a string literal or of whole numbers
//   added and taken away (`return 2 + 2` prints 4), so the runner's plumbing stays testable; it refuses anything else.
//
// JARHEAD_TEST_NET_LOG=<file> appends one line per off-Mac attempt: pid, verdict, method and URL.
// Never a header or a body.
//
// The brain runner's SecretRedactor reads the state dir's env file (<JARHEAD_STATE_DIR>/env), so a
// test never reads ~/.jarhead (W2-9).
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
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

// ---- the desktop -------------------------------------------------------------------------------

const FENCED = ["osascript", "open", "say", "afplay", "shortcuts", "automator", "screencapture"];
const fence = fs.mkdtempSync(join(tmpdir(), "jh-test-fence-"));
const REFUSED = (name) => `${name}: refused (the test preload fences the desktop)`;
/** osascript's stub: the script from -e lines or stdin; a lone `return` of a literal is printed, anything else refused. */
const OSASCRIPT = `#!${process.execPath}
const argv = process.argv.slice(2);
const lines = [];
for (let i = 0; i < argv.length; i++) if (argv[i] === "-e") lines.push(argv[++i] ?? "");
const script = (lines.length ? lines.join("\\n") : require("node:fs").readFileSync(0, "utf8")).trim();
const m = /^return\\s+(?:"([^"\\\\]*)"|([0-9]+(?:\\s*[-+]\\s*[0-9]+)*))$/.exec(script);
if (!m) { process.stderr.write(${JSON.stringify(REFUSED("osascript"))} + "\\n"); process.exit(1); }
process.stdout.write((m[1] ?? String(m[2].split(/\\s*([-+])\\s*/).reduce((acc, tok, i, a) => (i % 2 ? acc : i === 0 ? Number(tok) : a[i - 1] === "+" ? acc + Number(tok) : acc - Number(tok)), 0))) + "\\n");
`;
for (const name of FENCED) {
  const stub = join(fence, name);
  fs.writeFileSync(stub, name === "osascript" ? OSASCRIPT : `#!/bin/sh\necho "${REFUSED(name)}" >&2\nexit 1\n`);
  fs.chmodSync(stub, 0o755);
}
process.env["PATH"] = `${fence}:${process.env["PATH"] ?? ""}`;
const ABSOLUTE = new RegExp(`(?<![\\w/.-])/usr/s?bin/(${FENCED.join("|")})(?![\\w.-])`, "g");
/** The program itself: a fenced binary under /usr/bin or /usr/sbin is its stub. A bare name is found on PATH. */
const program = (file) => {
  const m = typeof file === "string" ? /^\/usr\/s?bin\/([\w.-]+)$/.exec(file) : null;
  return m && FENCED.includes(m[1]) ? join(fence, m[1]) : file;
};
/** A shell line: every absolute path to a fenced binary is its stub (a bare name finds the stub on PATH). */
const line = (command) => (typeof command === "string" ? command.replace(ABSOLUTE, (_, name) => join(fence, name)) : command);
const SHELLS = /(^|\/)(sh|bash|zsh|dash)$/;
/**
 * A caller's own env keeps the fence on its PATH ahead of the system's folders, so a bare name finds
 * the stub before /usr/bin, while a test's own stub folder put in front of them still wins.
 */
const SYSTEM_DIR = /^\/(usr|bin|sbin|opt|System|Library)(\/|$)/;
const fencedPath = (path) => {
  const dirs = (path ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(":");
  if (dirs.includes(fence)) return dirs.join(":");
  const at = dirs.findIndex((d) => SYSTEM_DIR.test(d));
  dirs.splice(at < 0 ? 0 : at, 0, fence);
  return dirs.join(":");
};
const fenceEnv = (options) => {
  if (options === null || typeof options !== "object" || !options.env) return options;
  const path = fencedPath(options.env.PATH);
  return path === options.env.PATH ? options : { ...options, env: { ...options.env, PATH: path } };
};
// spawn, spawnSync, execFile, execFileSync: (file, args?, options?, callback?)
const fileCall = (file, rest) => {
  const hasArgs = Array.isArray(rest[0]);
  const args = hasArgs ? rest[0] : undefined;
  const i = hasArgs ? 1 : 0;
  const options = rest[i] !== null && typeof rest[i] === "object" ? fenceEnv(rest[i]) : rest[i];
  // Through a shell (`shell: true`) the file and its args are one line; a shell spawned by name
  // (`sh -c '…'`, zsh -lc, as run_shell does) takes its line as an arg.
  const shell = (options !== null && typeof options === "object" && options.shell) || SHELLS.test(String(file));
  const out = [shell ? line(program(file)) : program(file)];
  if (hasArgs) out.push(shell ? args.map(line) : args);
  if (i < rest.length) out.push(options, ...rest.slice(i + 1));
  return out;
};
// exec, execSync: (command, options?, callback?), always through a shell
const lineCall = (command, rest) => {
  const options = rest[0] !== null && typeof rest[0] === "object" ? fenceEnv(rest[0]) : rest[0];
  return [line(command), ...(rest.length ? [options, ...rest.slice(1)] : [])];
};
const fenceFn = (fn, call) => {
  const real = childProcess[fn];
  const fenced = function fenced(first, ...rest) {
    return real.apply(childProcess, call(first, rest));
  };
  // promisify(execFile) and promisify(exec) resolve { stdout, stderr } through Node's own hook: keep it, fenced too.
  const custom = real[promisify.custom];
  if (custom) fenced[promisify.custom] = (first, ...rest) => custom.apply(childProcess, call(first, rest));
  childProcess[fn] = fenced;
};
for (const fn of ["spawn", "spawnSync", "execFile", "execFileSync"]) fenceFn(fn, fileCall);
for (const fn of ["exec", "execSync"]) fenceFn(fn, lineCall);
syncBuiltinESMExports();

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
