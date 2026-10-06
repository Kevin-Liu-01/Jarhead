// The test preload. `pnpm test`, and each package's own `test` script, imports it after tsx, into
// the runner and into every test file's process (node --test hands its execArgv to each child). It
// makes the suite hermetic on any Mac:
//
// - JARHEAD_STATE_DIR is a fresh temp dir, so the state dir (its env file, settings, ledger,
//   socket) is never ~/.jarhead. Every other JARHEAD_* variable is unset, all but the suite's own
//   JARHEAD_TEST_* knobs, and so is every secret key (SECRET_KEYS). A key or a setting exported by
//   the shell, or loaded from ~/.jarhead/env into the daemon that runs a self-edit's tests, never
//   reaches a test. JARHEAD_AUTO_WAKE=0 and JARHEAD_NO_AUDIO=1.
// - HOME is a fresh temp dir too, holding only a .gitconfig with a test identity (Jarhead Test,
//   test@jarhead.invalid), so a test that commits in a temp repo still can. CODEX_HOME and
//   CLAUDE_CONFIG_DIR are unset. No test reads the user's ~/.codex login, ~/.claude, dotfiles or
//   login-shell profile (F1).
// - fetch to anything but loopback never leaves the Mac. It answers a synthetic 401, as a server
//   would for a key it does not know. Under JARHEAD_TEST_NET=strict (CI) it throws instead, so a
//   test that reaches for the network fails by name.
// - A WebSocket to anything but loopback is refused.
// - Every temp dir a test makes under os.tmpdir() with mkdtemp is removed when its process exits.
// - The desktop is fenced: osascript, open, say, afplay, shortcuts, automator and screencapture never
//   run. A stub of each name comes first on PATH (so a shell line or a bare spawn finds it), and an
//   absolute /usr/bin or /usr/sbin path to one, spawned or inside a shell string, is pointed at the
//   stub. So is a bare name where a shell line starts a command, since a login shell's path_helper
//   puts /usr/bin ahead of the fence. The stub prints why on stderr and exits 1, as a script would
//   that the Mac refused. Without this, a test that sends `tell application "Spotify" to play`
//   through the real runner plays music, and one that sends keystrokes types them into whatever app
//   is in front. osascript's stub answers the one script with no effect at all, a lone `return` of a
//   string literal or of whole numbers added and taken away (`return 2 + 2` prints 4), so the
//   runner's plumbing stays testable; it refuses anything else.
// - The agent CLIs and the apps are fenced the same way (F1). A program named codex or claude
//   outside os.tmpdir(), or any program inside an app under /Applications or ~/Applications, runs a
//   refusing stub instead: spawned by path or by bare name (found on the PATH it is spawned with),
//   by an absolute path inside a shell line, or by a bare name where a shell line starts a command.
//   A test's own fake codex or claude lives in a mkdtemp dir and still runs; so does the node that
//   runs the suite. Without this, the `auto` walk finds Codex in ChatGPT.app, links the user's
//   ~/.codex/auth.json into a private CODEX_HOME and spends a model request on the thread's primer.
//
// JARHEAD_TEST_NET_LOG=<file> appends one line per off-Mac attempt: pid, verdict, method and URL.
// Never a header or a body.
//
// The brain runner's SecretRedactor reads the state dir's env file (<JARHEAD_STATE_DIR>/env), so a
// test never reads ~/.jarhead (W2-9).
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir, userInfo } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SECRET_KEYS } from "@jarhead/protocol";

// ---- temp dirs: every one a test makes is gone at exit -----------------------------------------

const realpathOr = (path) => {
  try {
    return fs.realpathSync(path);
  } catch {
    return path;
  }
};
/** os.tmpdir() as given and as the disk spells it (/var/folders/… is /private/var/folders/…). */
const TMP = [...new Set([resolve(tmpdir()), realpathOr(resolve(tmpdir()))])];
const underTmp = (path) => {
  const p = resolve(path);
  return TMP.some((t) => p.startsWith(t + sep));
};
const made = new Set();
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

// ---- HOME --------------------------------------------------------------------------------------

/** The account's own home, from the user database: HOME may already be a temp dir (the runner's preload set it). */
const ACCOUNT_HOME = (() => {
  try {
    return userInfo().homedir;
  } catch {
    return process.env["HOME"] ?? "";
  }
})();
const home = fs.mkdtempSync(join(tmpdir(), "jh-test-home-"));
fs.writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Jarhead Test\n\temail = test@jarhead.invalid\n");
process.env["HOME"] = home;
delete process.env["CODEX_HOME"];
delete process.env["CLAUDE_CONFIG_DIR"];

// ---- the desktop, the agent CLIs and the apps --------------------------------------------------

const FENCED = ["osascript", "open", "say", "afplay", "shortcuts", "automator", "screencapture"];
const fence = fs.mkdtempSync(join(tmpdir(), "jh-test-fence-"));
const REFUSED = (name, what = "the desktop") => `${name}: refused (the test preload fences ${what})`;
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

const AGENTS = ["codex", "claude"];
const APPS = ["/Applications", ...(ACCOUNT_HOME ? [join(ACCOUNT_HOME, "Applications")] : [])];
/** A path inside an app bundle under /Applications or the account's ~/Applications. */
const inApp = (path) => APPS.some((apps) => path.startsWith(apps + "/") && /\.app\//.test(path.slice(apps.length)));
/** The node that runs the suite is never fenced, wherever it lives: node --test spawns it for every test file. */
const NODE = new Set([process.execPath, realpathOr(process.execPath)]);
/** Why a program at this path must not run: Codex or Claude Code outside the temp dir, or anything inside an app. */
const why = (path) => {
  if (NODE.has(path)) return undefined;
  if (AGENTS.includes(basename(path).toLowerCase()) && !underTmp(path)) return "the agent CLIs";
  return inApp(path) ? "the desktop" : undefined;
};
/** The agents' and the apps' stubs live off PATH, made on first use, each named after its program. */
const stubs = fs.mkdtempSync(join(tmpdir(), "jh-test-agents-"));
const stubFor = (path, what) => {
  const name = (what === "the agent CLIs" ? basename(path).toLowerCase() : basename(path)).replace(/[^\w .+-]/g, "-") || "program";
  const stub = join(stubs, name.replace(/ /g, "-"));
  if (!fs.existsSync(stub)) {
    fs.writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' '${REFUSED(name, what)}' >&2\nexit 1\n`);
    fs.chmodSync(stub, 0o755);
  }
  return stub;
};
const executable = (path) => {
  try {
    const s = fs.statSync(path);
    return s.isFile() && (s.mode & 0o111) !== 0;
  } catch {
    return false;
  }
};
/** Where a bare name runs from: the first executable of that name on the PATH it is spawned with. */
const onPath = (name, path) => (path ?? "").split(":").filter(Boolean).map((dir) => resolve(dir, name)).find(executable);
const cwdOf = (options) => {
  const cwd = options !== null && typeof options === "object" ? options.cwd : undefined;
  return typeof cwd === "string" ? cwd : cwd instanceof URL ? fileURLToPath(cwd) : process.cwd();
};
const pathOf = (options) => (options !== null && typeof options === "object" && options.env ? options.env.PATH : process.env["PATH"]);

/**
 * The program itself: a fenced binary under /usr/bin or /usr/sbin is its stub (a bare one finds the
 * stub on PATH). Codex, Claude Code and an app's program are their stubs, by path (the file need not
 * exist) or by bare name, and so is a link that leads into an app.
 */
const program = (file, options) => {
  if (typeof file !== "string" || file === "") return file;
  const m = /^\/usr\/s?bin\/([\w.-]+)$/.exec(file);
  if (m && FENCED.includes(m[1])) return join(fence, m[1]);
  const at = file.includes("/") ? resolve(cwdOf(options), file) : onPath(file, pathOf(options));
  if (at === undefined) return file;
  const real = realpathOr(at);
  if (NODE.has(real)) return file;
  const what = why(at) ?? (inApp(real) ? "the desktop" : undefined);
  return what ? stubFor(at, what) : file;
};
const shellWord = (path) => (/^[\w/.+-]+$/.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`);
/** An absolute path in a shell line: quoted whole, or bare up to the next space or operator (a backslash keeps a space). */
const PATHS = /(["'])(\/[^"'\n]*)\1|(?<![\w/.~$-])\/(?:\\.|[^\s"'`;|&<>()$\\])+/g;
/** A path in a shell line is a program unless it is a folder or a file nobody can run (a missing one may be either). */
const mayRun = (path) => executable(path) || !fs.existsSync(path);
/** A shell line: every absolute path to a fenced program is its stub. */
const line = (command) =>
  typeof command !== "string"
    ? command
    : command.replace(ABSOLUTE, (_, name) => join(fence, name)).replace(PATHS, (whole, _quote, quoted) => {
        const path = quoted ?? whole.replace(/\\(.)/g, "$1");
        const what = why(path);
        return what && mayRun(path) ? shellWord(stubFor(path, what)) : whole;
      });
/** A command's name where a shell line starts one: first, or after ; & | ( { ` $( or a newline, past exec, command, env, nohup, time and NAME=value words. */
const COMMAND = /(^|[;&|({`\n])([ \t]*(?:(?:exec|command|env|nohup|time)[ \t]+|[A-Za-z_]\w*=[^\s;&|]*[ \t]+)*)([\w.-]+)(?=$|[\s;&|)}`])/g;
/**
 * What a fenced bare name in a command line runs, found on the PATH the shell is given and pinned
 * there, since a login shell's path_helper puts the system's folders first: a test's own fake in a
 * temp dir (the desktop's stubs are one), else the stub.
 */
const bare = (name, path) => {
  const desktop = FENCED.includes(name);
  if (!desktop && !AGENTS.includes(name.toLowerCase())) return undefined;
  const at = onPath(name, path);
  if (at === undefined) return undefined;
  if (underTmp(at)) return at;
  return desktop ? join(fence, name) : stubFor(at, "the agent CLIs");
};
/** A command line: absolute paths as in `line`, and every fenced bare name where a command starts. */
const commands = (command, path) =>
  typeof command !== "string"
    ? command
    : line(command).replace(COMMAND, (whole, start, words, name) => {
        const stub = bare(name, path);
        return stub ? start + words + shellWord(stub) : whole;
      });
const SHELLS = /(^|\/)(sh|bash|zsh|dash)$/;
/** The flag a shell takes its command line after: -c, -lc, -ec. */
const COMMAND_FLAG = /^-[a-zA-Z]*c[a-zA-Z]*$/;
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
  const path = pathOf(options);
  // Through a shell (`shell: true`) the file and its args are one line, the file first; a shell spawned
  // by name (`sh -c '…'`, zsh -lc, as run_shell does) takes its line as the arg after its -c.
  const shellOption = options !== null && typeof options === "object" && Boolean(options.shell);
  const byName = !shellOption && SHELLS.test(String(file));
  const out = [shellOption ? commands(file, path) : program(file, options)];
  if (hasArgs) out.push(shellOption || byName ? args.map((a, k) => (byName && k > 0 && COMMAND_FLAG.test(String(args[k - 1])) ? commands(a, path) : line(a))) : args);
  if (i < rest.length) out.push(options, ...rest.slice(i + 1));
  return out;
};
// exec, execSync: (command, options?, callback?), always through a shell
const lineCall = (command, rest) => {
  const options = rest[0] !== null && typeof rest[0] === "object" ? fenceEnv(rest[0]) : rest[0];
  return [commands(command, pathOf(options)), ...(rest.length ? [options, ...rest.slice(1)] : [])];
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
