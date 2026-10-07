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
//   test@jarhead.invalid), so a test that commits in a temp repo still can. CODEX_HOME,
//   CLAUDE_CONFIG_DIR, ZDOTDIR, the XDG folders and GIT_CONFIG_GLOBAL are unset, so none of them
//   steers a read back to the user's home. No test reads the user's ~/.codex login, ~/.claude,
//   dotfiles, git config or login-shell profile (F1). Claude Code keeps its macOS login in the
//   Keychain, outside HOME. Only the agent fence below keeps a test off that login.
// - fetch to anything but loopback never leaves the Mac. It answers a synthetic 401, as a server
//   would for a key it does not know. Under JARHEAD_TEST_NET=strict (CI) it throws instead, so a
//   test that reaches for the network fails by name.
// - A WebSocket to anything but loopback is refused.
// - Every temp dir a test makes under os.tmpdir() with mkdtemp is removed when its process exits.
// - The desktop is fenced: osascript, open, say, afplay, shortcuts, automator and screencapture never
//   run. A stub of each name comes first on PATH (so a shell line or a bare spawn finds it), and an
//   absolute /usr/bin or /usr/sbin path to one, spawned or inside a shell string, is pointed at the
//   stub. A login shell's path_helper puts /usr/bin and the folders in /etc/paths.d ahead of the
//   fence. So a shell spawned with -l or --login (zsh -lc, as run_shell runs every line) starts its
//   line by putting the PATH it was spawned with back in front. As a second layer, a bare name where
//   a shell line starts a command (see below) is pinned to its stub. The stub prints why on stderr
//   and exits 1, as a script would that the Mac refused. Without this, a test that sends
//   `tell application "Spotify" to play` through the real runner plays music, and one that sends
//   keystrokes types them into whatever app is in front. osascript's stub answers the one script
//   with no effect at all, a lone `return` of a string literal or of whole numbers added and taken
//   away (`return 2 + 2` prints 4), so the runner's plumbing stays testable; it refuses anything else.
// - A test that reaches the desktop fails. Each stub writes what it refused into the fence, and when
//   the process exits the preload names every call on stderr and exits 1, so the file fails whatever
//   its asserts said, as an off-Mac fetch fails under JARHEAD_TEST_NET=strict. Without this, the test
//   passes on a refusal it never meant to meet, after a spawn a loaded Mac can make slower than the
//   test's wait. A test that runs the applescript tool through a real ToolRunner hands it a fake
//   (RunnerOptions.runAppleScript); a lone `return` the osascript stub answers fails nothing.
// - The agent CLIs and the apps are fenced the same way (F1). A program named codex or claude
//   (claude.js and the like too) outside os.tmpdir(), a file inside an agent CLI's own npm package
//   outside it (@anthropic-ai/claude-code, @openai/codex, or any package whose bin is codex or
//   claude), or any program inside an app under /Applications or ~/Applications, runs a refusing stub
//   instead, a link to one too: spawned by path or by bare name (found on the PATH it is spawned
//   with), or by an absolute path inside a shell line. In a shell line, a bare codex or claude where
//   a command starts is the stub too, unless the PATH the shell is given finds a copy under
//   os.tmpdir(). A command starts first, after ; & | ( { ` or a newline, and after if, then, else,
//   elif, do, while, until, ! or {. It starts past NAME=value words and redirections, and its name
//   may be quoted. Each command in a shell line is read word by word, as a spawn of those words is
//   read: a path there is a program, and a wrapper or node there is read as below. The same holds
//   inside the line of a shell the line starts (sh -c '…'). A test's own fake codex or claude lives
//   in a mkdtemp dir and still runs; so does the node that runs the suite. Without this, the `auto`
//   walk finds Codex in ChatGPT.app, links the user's ~/.codex/auth.json into a private CODEX_HOME
//   and spends a model request on the thread's primer.
// - What a wrapper runs is fenced as if it were spawned itself (C5). A wrapper is env, xargs,
//   timeout (gtimeout), nohup, caffeinate, nice, time, arch or command, by any path or bare name. In
//   a shell line exec, noglob and nocorrect are wrappers too. Its command is the first word past its
//   flags and their values (and past env's NAME=value words and timeout's duration). One reader
//   (`wrapped`) knows which of each wrapper's flags take a value, spawned or in a shell line, so
//   caffeinate -u is not read as env -u. A bare desktop or agent name there is pinned to what it
//   runs, since env -i, env PATH=…, env -u PATH and env -P change where it is found. A shell, node or
//   another wrapper there is read the same way. env -S's string is read as more of env's own args.
//   With `shell: true`, Node joins the file and its args into one line; the fence reads that line
//   whole.
// - node, by any path or bare name, runs the stub when its script, or a module it loads with
//   --import, --require or --loader, is under /Applications or ~/Applications, or is an agent CLI's
//   own (as above, a link followed), or a bare module name of one of those packages. Its script is a
//   path from the folder it runs in, as node reads it. A --flag not in NODE_VALUES may take the next
//   word, so that word is read as a script too and the reading goes on: the fence fails closed on a
//   flag Node adds later. A module NODE_OPTIONS loads counts too, in a spawn's env or inherited: a
//   spawn under it runs the stub, whatever its program. fork, a Worker given a file and
//   process.execve are read the same way. Every stub runs under sh and under node alike, so
//   `node <stub>` refuses too.
//
// What the fences miss:
// - An agent name a shell line reaches another way still runs: through a variable ($cmd, "$(which
//   claude)"), eval, find -exec, a case arm, a script file, or a wrapper not named above (sudo,
//   script, sandbox-exec). No agent stub stands on PATH, since the tests that look for Codex on PATH
//   would find it. The desktop names have stubs on PATH, so those forms reach a desktop stub, but not
//   in a login shell that runs a script file or that a line starts itself: path_helper puts /usr/bin
//   first there.
// - In a shell line, a bare name that starts a command is looked up only when it is codex, claude or
//   a desktop name: an app's program found on PATH runs there (a spawn's, or a wrapper's, is looked
//   up). A relative path there is read from the folder the shell starts in, so a line that cds first
//   may run another file.
// - What node runs inline (-e, -p, a Worker's eval) or reads from stdin is never read: `xargs node`
//   fed an agent CLI's script runs it.
// - A node child a test starts as `node --import tsx …` does not load this preload. Jarhead's own
//   entry points run that way: the daemon's main in single-instance.test.ts, and the CLI's main in
//   v2-status, w2-1-ledger-cli, memory-cli and w3-3-ledger-search-cli. These children inherit the
//   temp HOME and the unset keys, but run outside the agent, app and fetch fences. None of them
//   reaches a brain walk today. To fence one, spawn process.execPath with ...process.execArgv, which
//   carry tsx and this preload.
// - A child that loads this preload has a fence of its own: a desktop call it makes fails the child
//   at exit, not the test, unless the test reads the child's exit code.
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
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import workerThreads from "node:worker_threads";
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
/** What steers a read back out of HOME: the agents' own homes, zsh's dotfile folder, the XDG folders, git's global config. */
const AWAY_FROM_HOME = ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "ZDOTDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "GIT_CONFIG_GLOBAL"];
for (const key of AWAY_FROM_HOME) delete process.env[key];

// ---- the desktop, the agent CLIs and the apps --------------------------------------------------

const FENCED = ["osascript", "open", "say", "afplay", "shortcuts", "automator", "screencapture"];
const fence = fs.mkdtempSync(join(tmpdir(), "jh-test-fence-"));
const REFUSED = (name, what = "the desktop") => `${name}: refused (the test preload fences ${what})`;
/** Where the desktop's stubs write what they refused, a line each: the fence is this process's own, so the lines are its calls. */
const REFUSALS = join(fence, "refused");
/** osascript's stub: the script from -e lines or stdin; a lone `return` of a literal is printed, anything else refused and written down. */
const OSASCRIPT = `#!${process.execPath}
const argv = process.argv.slice(2);
const lines = [];
for (let i = 0; i < argv.length; i++) if (argv[i] === "-e") lines.push(argv[++i] ?? "");
const script = (lines.length ? lines.join("\\n") : require("node:fs").readFileSync(0, "utf8")).trim();
const m = /^return\\s+(?:"([^"\\\\]*)"|([0-9]+(?:\\s*[-+]\\s*[0-9]+)*))$/.exec(script);
if (!m) {
  try { require("node:fs").appendFileSync(${JSON.stringify(REFUSALS)}, "osascript " + JSON.stringify(script) + "\\n"); } catch {}
  process.stderr.write(${JSON.stringify(REFUSED("osascript"))} + "\\n");
  process.exit(1);
}
process.stdout.write((m[1] ?? String(m[2].split(/\\s*([-+])\\s*/).reduce((acc, tok, i, a) => (i % 2 ? acc : i === 0 ? Number(tok) : a[i - 1] === "+" ? acc + Number(tok) : acc - Number(tok)), 0))) + "\\n");
`;
for (const name of FENCED) {
  const stub = join(fence, name);
  fs.writeFileSync(stub, name === "osascript" ? OSASCRIPT : `#!/bin/sh\nprintf '%s\\n' "${name} $*" 2>/dev/null >> "$(dirname "$0")/refused"\necho "${REFUSED(name)}" >&2\nexit 1\n`);
  fs.chmodSync(stub, 0o755);
}
process.env["PATH"] = `${fence}:${process.env["PATH"] ?? ""}`;
// Ahead of the temp-dir sweep, which takes the fence with it.
process.prependListener("exit", () => {
  let calls;
  try {
    calls = fs.readFileSync(REFUSALS, "utf8").trim().split("\n");
  } catch {
    return;
  }
  process.stderr.write(
    "the test preload: a test here reached the desktop, so this file fails. Hand the runner a fake (RunnerOptions.runAppleScript), " +
      `or send a lone \`return\` the osascript stub answers. Refused:\n${calls.map((c) => `  ${c}\n`).join("")}`,
  );
  process.exitCode = 1;
});
const ABSOLUTE = new RegExp(`(?<![\\w/.-])/usr/s?bin/(${FENCED.join("|")})(?![\\w.-])`, "g");

const AGENTS = ["codex", "claude"];
/** The agent CLIs' own npm packages. A package whose bin is codex or claude counts too. */
const AGENT_PACKAGES = ["@anthropic-ai/claude-code", "@openai/codex"];
const APPS = ["/Applications", ...(ACCOUNT_HOME ? [join(ACCOUNT_HOME, "Applications")] : [])];
/** A path inside an app bundle under /Applications or the account's ~/Applications. */
const inApp = (path) => APPS.some((apps) => path.startsWith(apps + "/") && /\.app\//.test(path.slice(apps.length)));
/** A path anywhere under /Applications or ~/Applications: node runs a script from there, in an app or not. */
const underApps = (path) => APPS.some((apps) => path.startsWith(apps + "/"));
/** The node that runs the suite is never fenced, wherever it lives: node --test spawns it for every test file. */
const NODE = new Set([process.execPath, realpathOr(process.execPath)]);
/** A program's name as an agent's: claude.js, claude.mjs and Claude are claude. */
const stem = (path) => basename(path).replace(/\.[cm]?js$/i, "").toLowerCase();
/** A file inside an agent CLI's own package: the nearest package.json above it is one of AGENT_PACKAGES, or its bin is codex or claude. */
const inAgentPackage = (path) => {
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    const file = join(dir, "package.json");
    if (fs.existsSync(file)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
        const bins = typeof pkg.bin === "string" ? [String(pkg.name ?? "").split("/").pop()] : pkg.bin && typeof pkg.bin === "object" ? Object.keys(pkg.bin) : [];
        return AGENT_PACKAGES.includes(pkg.name) || bins.some((b) => AGENTS.includes(String(b).toLowerCase()));
      } catch {
        return false;
      }
    }
    if (dirname(dir) === dir) return false;
  }
};
/** Codex or Claude Code outside the temp dir: by its name, or by the package it ships in. */
const agentAt = (path) => !underTmp(path) && (AGENTS.includes(stem(path)) || inAgentPackage(path));
/** Why a program at this path must not run: Codex or Claude Code outside the temp dir, or anything inside an app; a link is followed. */
const why = (path) => {
  const real = realpathOr(path);
  if (NODE.has(path) || NODE.has(real)) return undefined;
  if (agentAt(path) || (real !== path && agentAt(real))) return "the agent CLIs";
  return inApp(path) || inApp(real) ? "the desktop" : undefined;
};
/**
 * The agents' and the apps' stubs live off PATH, made on first use, each named after its program. A
 * stub runs under sh and under node alike (sh reads `":"` as a no-op, node as a string and the rest
 * of the line as a comment), so a script path pointed at one is refused by the node that runs it.
 */
const stubs = fs.mkdtempSync(join(tmpdir(), "jh-test-agents-"));
const stubFor = (path, what) => {
  const name = (what === "the agent CLIs" ? basename(path).toLowerCase() : basename(path)).replace(/[^\w .+-]/g, "-") || "program";
  const dir = join(stubs, what === "the agent CLIs" ? "agents" : "desktop");
  const stub = join(dir, name.replace(/ /g, "-"));
  if (!fs.existsSync(stub)) {
    fs.mkdirSync(dir, { recursive: true });
    const said = JSON.stringify(REFUSED(name, what) + "\n");
    fs.writeFileSync(
      stub,
      `#!/bin/sh\n":" //; printf '%s\\n' '${REFUSED(name, what)}' >&2; exit 1\n` +
        `if (typeof require === "function") require("node:fs").writeSync(2, ${said}); else process.stderr.write(${said});\nprocess.exit(1);\n`,
    );
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
 * exist) or by bare name found on `path`, and so is a link that leads to one.
 */
const program = (file, cwd, path) => {
  if (typeof file !== "string" || file === "") return file;
  const m = /^\/usr\/s?bin\/([\w.-]+)$/.exec(file);
  if (m && FENCED.includes(m[1])) return join(fence, m[1]);
  const at = file.includes("/") ? resolve(cwd, file) : onPath(file, path);
  if (at === undefined) return file;
  const what = why(at);
  return what ? stubFor(at, what) : file;
};

// ---- wrappers and node: what a program runs from its own args ----------------------------------

/** Where execvp looks when PATH is unset (env -i, env -u PATH). */
const DEFAULT_PATH = "/usr/bin:/bin";
/**
 * Programs that run a command named in their own args, and how each reads them: `flags` are its
 * one-letter options that take a value (the rest of the word, or the next word), `long` its --options
 * that take the next word, `skip` the words between its options and the command (timeout's
 * duration), `words` its whole-word options that take the next word (arch's), `looks` the flags
 * that make it only look the command up (command -v). Each stops reading options at `--` or at the
 * first word that is not one. env also reads NAME=value words.
 */
const TIMEOUT = { flags: "ks", long: ["--kill-after", "--signal"], skip: 1 };
const WRAPPERS = new Map([
  ["env", { flags: "CLPSUau", long: ["--unset", "--chdir", "--split-string", "--argv0"], env: true }],
  ["xargs", { flags: "EIJLPRSadns" }],
  ["timeout", TIMEOUT],
  ["gtimeout", TIMEOUT],
  ["nohup", { flags: "" }],
  ["caffeinate", { flags: "tw" }],
  ["nice", { flags: "n", long: ["--adjustment"] }],
  ["time", { flags: "fo" }],
  ["arch", { words: ["-arch", "-d", "-e"] }],
  ["command", { flags: "", looks: "vV" }],
]);
/** A shell's own words that run the next one, read like the wrappers in a shell line: exec (its -a takes a name), zsh's noglob and nocorrect. */
const BUILTINS = new Map([
  ["exec", { flags: "a" }],
  ["noglob", { flags: "" }],
  ["nocorrect", { flags: "" }],
]);
/**
 * Where a wrapper's command sits in its args (`at`, -1 for none), with the folder and the PATH it
 * runs under and the PATH it is found on: env may change all three (-C, -i, -u PATH, PATH=…, -P).
 * env -S ends the reading at its string (`split`: the words it spans, the flags joined before it,
 * its value), since env reads that string as more of its own args.
 */
const wrapped = (spec, args, cwd, path) => {
  const out = { at: -1, cwd, path, find: undefined, split: undefined };
  /** The value of the option at word i: joined (`-n1`, `--signal=KILL`) or the next word. Returns the word index it ends on. */
  const take = (flag, i, joined, before = "") => {
    const end = joined === undefined ? i + 1 : i;
    const value = joined ?? (end < args.length ? String(args[end]) : undefined);
    if (!spec.env || value === undefined) return end;
    if (flag === "-S" || flag === "--split-string") out.split = { from: i, to: end, before, value };
    else if (flag === "-C" || flag === "--chdir") out.cwd = resolve(out.cwd, value);
    else if (flag === "-P") out.find = value;
    else if ((flag === "-u" || flag === "--unset") && value === "PATH") out.path = DEFAULT_PATH;
    return end;
  };
  let options = true;
  let skip = spec.skip ?? 0;
  for (let i = 0; i < args.length && !out.split; i++) {
    const a = String(args[i]);
    if (options && a === "--") {
      options = false;
      continue;
    }
    if (options && spec.env && a === "-") {
      out.path = DEFAULT_PATH; // env's old spelling of -i
      continue;
    }
    if (options && a.startsWith("-") && a.length > 1) {
      if (spec.words) {
        if (spec.words.includes(a)) i++;
      } else if (a.startsWith("--")) {
        const eq = a.indexOf("=");
        const flag = eq < 0 ? a : a.slice(0, eq);
        if (eq >= 0) take(flag, i, a.slice(eq + 1));
        else if (spec.long?.includes(flag)) i = take(flag, i);
      } else {
        for (let j = 1; j < a.length; j++) {
          if (spec.looks?.includes(a[j])) return { ...out, find: out.path };
          if (spec.env && a[j] === "i") out.path = DEFAULT_PATH;
          if (!spec.flags.includes(a[j])) continue;
          i = take("-" + a[j], i, j + 1 < a.length ? a.slice(j + 1) : undefined, j > 1 ? a.slice(0, j) : "");
          break;
        }
      }
      continue;
    }
    if (spec.env && /^[A-Za-z_]\w*=/.test(a)) {
      if (a.startsWith("PATH=")) out.path = a.slice(5);
      options = false;
      continue;
    }
    if (skip > 0) {
      skip--;
      options = false;
      continue;
    }
    out.at = i;
    break;
  }
  out.find ??= out.path;
  return out;
};

/** node's flags whose word is a module it loads and runs. */
const NODE_LOADS = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader"]);
/** The flags after which node runs code given inline (or a package script), never a script file. */
const NODE_INLINE = new Set(["-e", "--eval", "-p", "--print", "--run"]);
/** node's flags that take the next word unless joined with `=`. */
const NODE_VALUES = new Set([
  ...NODE_LOADS,
  ...NODE_INLINE,
  "-C",
  "--conditions",
  "--input-type",
  "--env-file",
  "--env-file-if-exists",
  "--experimental-config-file",
  "--title",
  "--inspect-port",
  "--debug-port",
  "--disable-warning",
  "--redirect-warnings",
  "--report-dir",
  "--report-directory",
  "--report-filename",
  "--report-signal",
  "--heapsnapshot-signal",
  "--diagnostic-dir",
  "--cpu-prof-dir",
  "--cpu-prof-name",
  "--heap-prof-dir",
  "--heap-prof-name",
  "--icu-data-dir",
  "--openssl-config",
  "--tls-cipher-list",
  "--secure-heap",
  "--secure-heap-min",
  "--localstorage-file",
  "--unhandled-rejections",
  "--dns-result-order",
  "--watch-path",
  "--test-concurrency",
  "--test-name-pattern",
  "--test-skip-pattern",
  "--test-reporter",
  "--test-reporter-destination",
  "--test-shard",
  "--test-timeout",
]);
/** A module node is given: a file URL or a path becomes a path; a bare name stays as it is. */
const moduleOf = (spec, cwd) => {
  if (spec.startsWith("file:")) {
    try {
      return fileURLToPath(spec);
    } catch {
      return spec;
    }
  }
  return spec.startsWith("/") || spec.startsWith(".") ? resolve(cwd, spec) : spec;
};
/** node's script: a path from its folder, as node reads it (a bare name too), or a file URL. */
const scriptOf = (spec, cwd) => (spec.startsWith("file:") ? moduleOf(spec, cwd) : resolve(cwd, spec));
/**
 * What a node command line loads and runs: its script (none after -e or -p), and every --import,
 * --require or --loader module. It fails closed: a --flag not named above may take the next word,
 * so that word is read as a script too and the reading goes on. Only a word `known` passes is
 * read (a shell line's $HOME is not known here).
 */
const nodeLoads = (args, cwd, known = () => true) => {
  const out = [];
  let inline = false;
  let unknown = false;
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (a === "--" || !a.startsWith("-") || a === "-") {
      const script = a === "--" ? args[i + 1] : a;
      if (!inline && script !== undefined && script !== "-" && known(String(script))) out.push(scriptOf(String(script), cwd));
      if (!unknown || a === "--") break;
      unknown = false;
      continue;
    }
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const flag = eq < 0 ? a : a.slice(0, eq);
    unknown = a.startsWith("--") && eq < 0 && !NODE_VALUES.has(flag);
    if (NODE_INLINE.has(flag)) inline = true;
    const value = eq >= 0 ? a.slice(eq + 1) : NODE_VALUES.has(flag) ? String(args[++i] ?? "") : undefined;
    if (value !== undefined && NODE_LOADS.has(flag) && known(value)) out.push(moduleOf(value, cwd));
  }
  return out;
};
/** Why node must not run this module: anything under /Applications or ~/Applications, or an agent CLI's own (a bare name of its package, too). */
const whyNode = (module) => {
  if (!module.startsWith("/")) return AGENT_PACKAGES.some((p) => module === p || module.startsWith(p + "/")) ? "the agent CLIs" : undefined;
  if (underApps(module) || underApps(realpathOr(module))) return "the desktop";
  return why(module);
};
const isNode = (file) => /^node(js)?$/.test(basename(file)) || NODE.has(file);
/** The stub for the first module node must not load, or undefined. */
const refusedModule = (modules) => {
  for (const module of modules) {
    const what = whyNode(module);
    if (what) return stubFor(module, what);
  }
  return undefined;
};

// ---- shell words: a shell line read word by word -----------------------------------------------

/** What ends a simple command in a shell line, unquoted. */
const OPERATORS = new Set([";", "&", "|", "(", ")", "`", "\n"]);
/** A redirection's operator where a word starts: 2>, >>, >&, &>, <, <<< and the like. */
const REDIRECT = /\d*(?:<<<|<<-|<<|<>|<&|>&|>>|>\||<|>)|&>>?/y;
/**
 * The words of a shell line from `at` to the end of its simple command (an unquoted operator, a
 * newline or a comment): each word's text with its quotes and backslashes taken out, where it sits in
 * the line, and whether it leaves a quote open. A redirection and its target are one word, marked.
 * With `shell` false (env -S's string, NODE_OPTIONS) only the end of the text ends it.
 */
const words = (text, at = 0, shell = true) => {
  const blank = (c) => c === " " || c === "\t" || (!shell && (c === "\n" || c === "\r"));
  const ends = (c) => blank(c) || (shell && (OPERATORS.has(c) || c === "<" || c === ">"));
  let i = at;
  /** One word from i: its text, and whether a quote is left open. */
  const read = () => {
    let value = "";
    let open = false;
    while (i < text.length && !ends(text[i])) {
      const c = text[i];
      if (c === "\\") {
        if (text[i + 1] !== "\n") value += text[i + 1] ?? "";
        i += 2;
      } else if (c === "'") {
        const end = text.indexOf("'", i + 1);
        open ||= end < 0;
        value += text.slice(i + 1, end < 0 ? text.length : end);
        i = end < 0 ? text.length : end + 1;
      } else if (c === '"') {
        let j = i + 1;
        for (; j < text.length && text[j] !== '"'; j++) {
          if (text[j] === "\\" && j + 1 < text.length && '"\\$`\n'.includes(text[j + 1])) {
            j++;
            if (text[j] !== "\n") value += text[j];
          } else value += text[j];
        }
        open ||= j >= text.length;
        i = Math.min(j + 1, text.length);
      } else {
        value += c;
        i++;
      }
    }
    return { value, open };
  };
  const out = [];
  for (;;) {
    while (i < text.length && (blank(text[i]) || (text[i] === "\\" && text[i + 1] === "\n"))) i += blank(text[i]) ? 1 : 2;
    if (i >= text.length || text[i] === "#") return out;
    const start = i;
    REDIRECT.lastIndex = i;
    const redirect = shell ? REDIRECT.exec(text) : null;
    if (redirect) {
      i += redirect[0].length;
      while (i < text.length && blank(text[i])) i++;
      read();
      out.push({ text: "", start, end: i, open: false, redirect: true });
      continue;
    }
    if (shell && OPERATORS.has(text[i])) return out;
    const { value, open } = read();
    out.push({ text: value, start, end: i, open });
  }
};
/** A word the shell expands when the line runs ($HOME, `…`, ~): what it names is not known here. */
const EXPANDS = /^~|[$`]/;

/**
 * A program and its args as they run under the fence:
 * - the program as `program` makes it;
 * - a shell's line (the word after its -c) as `commands` makes it; a login shell's line puts the PATH
 *   it was given first again;
 * - a wrapper's command (WRAPPERS) as a program of its own: a fenced bare name is pinned to what it
 *   runs, since the wrapper may change PATH, and a shell, node or another wrapper there is read the
 *   same way. env -S's string is read as more of env's args; where that fences anything, env gets
 *   the string's words as args of their own;
 * - node is the stub when it would run a module `whyNode` refuses.
 * `inLine` reads the words of a shell line (see `pins`): the shell's own BUILTINS count as wrappers,
 * a word the shell expands is left alone, and a nested shell's line is left to NESTED.
 */
const argv = (file, args, cwd, path, find = path, inLine = false) => {
  if (typeof file !== "string" || file === "" || (inLine && EXPANDS.test(file))) return [file, args];
  const spec = WRAPPERS.get(basename(file)) ?? (inLine ? BUILTINS.get(file) : undefined);
  if (spec) {
    const w = wrapped(spec, args, cwd, path);
    if (w.split) {
      const { from, to, before, value } = w.split;
      const split = [...args.slice(0, from), ...(before ? [before] : []), ...words(value, 0, false).map((x) => x.text), ...args.slice(to + 1)];
      const [runs, runArgs] = argv(file, split, cwd, path, find, inLine);
      return [runs, runArgs.length !== split.length || runArgs.some((a, k) => a !== split[k]) ? runArgs : args];
    }
    if (w.at < 0) return [program(file, cwd, find), args];
    const name = String(args[w.at]);
    const [inner, rest] = argv((!name.includes("/") && bare(name, w.find)) || name, args.slice(w.at + 1), w.cwd, w.path, w.find, inLine);
    return [program(file, cwd, find), [...args.slice(0, w.at), inner, ...rest]];
  }
  if (isNode(file)) {
    const stub = refusedModule(nodeLoads(args, cwd, inLine ? (word) => !EXPANDS.test(word) : undefined));
    return [stub ?? program(file, cwd, find), args];
  }
  const shell = SHELLS.exec(file)?.[2];
  if (!shell || inLine) return [program(file, cwd, find), args];
  const at = lineAt(args);
  const login = at > 0 && Boolean(path) && args.slice(0, at).some((a) => LOGIN_FLAG.test(String(a)));
  return [program(file, cwd, find), args.map((a, k) => (k !== at ? line(a) : typeof a === "string" && login ? pathFirst(shell, path) + commands(a, path, cwd) : commands(a, path, cwd)))];
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
/**
 * What a fenced bare name in a command line runs, pinned there, since a login shell's path_helper
 * puts the system's folders first and the line may change PATH itself. A test's own fake in a temp
 * dir, found on the PATH the shell is given (the desktop's stubs are one), runs; anything else is
 * the stub, a name the shell might find later included.
 */
const bare = (name, path) => {
  const desktop = FENCED.includes(name);
  if (!desktop && !AGENTS.includes(name.toLowerCase())) return undefined;
  const at = onPath(name, path);
  if (at !== undefined && underTmp(at)) return at;
  return desktop ? join(fence, name) : stubFor(name, "the agent CLIs");
};
/** Where a command may start in a shell line: first, and after ; & | ( { ` or a newline, inside quotes too, so $(…) and `…` count. */
const STARTS = /[;&|({`\n]/g;
/** The words a simple command may start with that the shell reads itself. */
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{"]);
/**
 * What fences a shell line, as edits ([start, end, text]): each simple command read as a spawn of its
 * words (`argv`), past keywords, NAME=value words and redirections. A fenced bare name that starts
 * it is pinned (`bare`); a path there, a wrapper's command and node's modules are read as a spawn
 * reads them. Each word that changes is written back where it stood.
 */
const pins = (text, path, cwd) => {
  const edits = [];
  for (const at of [0, ...Array.from(text.matchAll(STARTS), (m) => m.index + 1)]) {
    const ws = words(text, at).filter((w) => !w.redirect);
    let k = 0;
    while (k < ws.length && (KEYWORDS.has(text.slice(ws[k].start, ws[k].end)) || /^[A-Za-z_]\w*=/.test(text.slice(ws[k].start, ws[k].end)))) k++;
    const [first, ...rest] = ws.slice(k);
    if (first === undefined || first.open) continue;
    const file = (!first.text.includes("/") && bare(first.text, path)) || first.text;
    const [runs, args] = argv(file, rest.map((w) => w.text), cwd, path, "", true);
    if (runs !== first.text) edits.push([first.start, first.end, shellWord(runs)]);
    if (args.length === rest.length) {
      rest.forEach((w, j) => {
        if (args[j] !== w.text && !w.open) edits.push([w.start, w.end, shellWord(args[j])]);
      });
    } else if (!rest.some((w) => w.open)) {
      edits.push([rest[0].start, rest.at(-1).end, args.map(shellWord).join(" ")]);
    }
  }
  return edits;
};
/** The line with each edit made; one inside an earlier one is dropped, since the earlier one read its words already. */
const edited = (text, edits) => {
  let out = "";
  let at = 0;
  for (const [start, end, value] of edits.sort((a, b) => a[0] - b[0] || b[1] - a[1])) {
    if (start < at) continue;
    out += text.slice(at, start) + value;
    at = end;
  }
  return out + text.slice(at);
};
const SHELL_NAMES = ["sh", "bash", "zsh", "dash", "ksh", "mksh", "fish", "tcsh", "csh"];
const SHELLS = new RegExp(`(^|/)(${SHELL_NAMES.join("|")})$`);
/** A shell a line starts with a line of its own after its -c (or `-c --`), quoted or one bare word: `sh -c '…'`, `bash -lc "…"`. */
const NESTED = new RegExp(
  String.raw`(?<![\w./-])((?:/[\w.-]+)*/)?(${SHELL_NAMES.join("|")})((?:[ \t]+(?:-o[ \t]+\w+|[-+][\w-]+))*?[ \t]+-[a-zA-Z]*c[a-zA-Z]*(?:[ \t]+--)?[ \t]+)('[^']*'|"(?:\\[\s\S]|[^"\\])*"|[^\s'"\x60;&|<>()]+)`,
  "g",
);
const singleQuoted = (text) => `'${text.replace(/'/g, "'\\''")}'`;
/** A command line: absolute paths as in `line`, each simple command as `pins` reads it, and the same inside a nested shell's line. */
const commands = (command, path, cwd = process.cwd()) => {
  if (typeof command !== "string") return command;
  const text = line(command);
  return edited(text, pins(text, path, cwd)).replace(NESTED, (whole, dir, shell, flags, given) => {
    const quote = given[0] === "'" || given[0] === '"' ? given[0] : "";
    const inner = quote ? given.slice(1, -1) : given;
    const fenced = commands(inner, path, cwd);
    if (fenced === inner) return whole;
    return (dir ?? "") + shell + flags + (quote === "'" ? singleQuoted(fenced) : quote ? `"${fenced}"` : shellWord(fenced));
  });
};
/** The flag a shell takes its command line after: -c, -lc, -ec. */
const COMMAND_FLAG = /^-[a-zA-Z]*c[a-zA-Z]*$/;
/** A login shell's flag: -l, --login, or one that holds an l (-lc, -il). */
const LOGIN_FLAG = /^(?:-[a-zA-Z]*l[a-zA-Z]*|--login)$/;
/** Where a shell spawned by name takes its line: the arg after its -c, or after `-c --`. */
const lineAt = (args) => {
  const c = args.findIndex((a) => COMMAND_FLAG.test(String(a)));
  return c < 0 ? -1 : args[c + 1] === "--" ? c + 2 : c + 1;
};
/**
 * A login shell's path_helper (zsh's /etc/zprofile, sh's /etc/profile, fish's own) puts /usr/bin and
 * the folders in /etc/paths.d ahead of the fence. So its line starts by putting the PATH it was given
 * back in front: the fence ahead of the system's folders, a test's own fakes ahead of the fence. csh
 * and tcsh never take -l with a line.
 */
const pathFirst = (shell, path) =>
  shell === "fish"
    ? `set -gx PATH ${path.split(":").filter(Boolean).map(singleQuoted).join(" ")} $PATH; `
    : shell === "csh" || shell === "tcsh"
      ? ""
      : `PATH=${singleQuoted(path)}:"$PATH"; `;
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
/**
 * NODE_OPTIONS in a spawn's env (or the one it inherits) is read by every node under it: the stub
 * for the first module it loads that node must not, or undefined.
 */
const nodeOptionsStub = (options) => {
  const env = options !== null && typeof options === "object" && options.env ? options.env : process.env;
  const value = env["NODE_OPTIONS"];
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return refusedModule(nodeLoads(words(value, 0, false).map((w) => w.text), cwdOf(options)));
};
// spawn, spawnSync, execFile, execFileSync: (file, args?, options?, callback?)
const fileCall = (file, rest) => {
  const hasArgs = Array.isArray(rest[0]);
  const args = hasArgs ? rest[0] : [];
  const i = hasArgs ? 1 : 0;
  const options = rest[i] !== null && typeof rest[i] === "object" ? fenceEnv(rest[i]) : rest[i];
  const tail = i < rest.length ? [options, ...rest.slice(i + 1)] : [];
  const path = pathOf(options);
  const refused = nodeOptionsStub(options);
  if (refused) return [refused, ...(hasArgs ? [[]] : []), ...tail];
  // Through a shell (`shell: true`) Node joins the file and its args with spaces into one line: the
  // fence reads that line whole. Otherwise `argv` reads the program and its args.
  if (options !== null && typeof options === "object" && Boolean(options.shell)) {
    return [commands(args.length ? [file, ...args].join(" ") : file, path, cwdOf(options)), ...(hasArgs ? [[]] : []), ...tail];
  }
  const [runs, runArgs] = argv(file, args, cwdOf(options), path);
  return [runs, ...(hasArgs ? [runArgs] : []), ...tail];
};
// exec, execSync: (command, options?, callback?), always through a shell
const lineCall = (command, rest) => {
  const options = rest[0] !== null && typeof rest[0] === "object" ? fenceEnv(rest[0]) : rest[0];
  const refused = nodeOptionsStub(options);
  return [refused ? shellWord(refused) : commands(command, pathOf(options), cwdOf(options)), ...(rest.length ? [options, ...rest.slice(1)] : [])];
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
// fork is node <module>, but Node's own fork calls its own spawn, past the fenced one. A refused
// fork runs the stub under the suite's node with nothing preloaded, so no module loads first.
const realFork = childProcess.fork;
childProcess.fork = function fork(modulePath, ...rest) {
  const at = Array.isArray(rest[0]) ? 1 : 0;
  const options = rest[at] !== null && typeof rest[at] === "object" ? rest[at] : {};
  const cwd = cwdOf(options);
  const script = modulePath instanceof URL ? fileURLToPath(modulePath) : resolve(cwd, String(modulePath));
  const execPath = typeof options.execPath === "string" ? program(options.execPath, cwd, pathOf(options)) : options.execPath;
  const stub =
    (execPath !== options.execPath ? execPath : undefined) ??
    nodeOptionsStub(options) ??
    refusedModule([...nodeLoads(Array.isArray(options.execArgv) ? options.execArgv : process.execArgv, cwd), script]);
  if (stub === undefined) return realFork.call(childProcess, modulePath, ...rest);
  return realFork.call(childProcess, stub, [], { ...options, execPath: process.execPath, execArgv: [], env: { ...(options.env ?? process.env), NODE_OPTIONS: "" } });
};
// A Worker given a file runs it as node would; one given code (eval: true) is not read.
const RealWorker = workerThreads.Worker;
workerThreads.Worker = class Worker extends RealWorker {
  constructor(filename, options) {
    const code = options !== null && typeof options === "object" && Boolean(options.eval);
    const file = code ? undefined : filename instanceof URL ? (filename.protocol === "file:" ? fileURLToPath(filename) : undefined) : resolve(String(filename));
    const stub = refusedModule([...nodeLoads(Array.isArray(options?.execArgv) ? options.execArgv : [], process.cwd()), ...(file ? [file] : [])]);
    super(stub ?? filename, stub ? { ...options, eval: false, execArgv: [] } : options);
  }
};
// process.execve(file, args, env) runs file in this process's place; args[0] is its argv[0].
if (typeof process.execve === "function") {
  const realExecve = process.execve;
  process.execve = function execve(file, args = [], env = process.env) {
    const refused = nodeOptionsStub({ env });
    const [runs, runArgs] = refused ? [refused, []] : argv(file, args.slice(1), process.cwd(), env.PATH);
    return realExecve.call(process, runs, args.length ? [args[0], ...runArgs] : runArgs, fenceEnv({ env }).env);
  };
}
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
