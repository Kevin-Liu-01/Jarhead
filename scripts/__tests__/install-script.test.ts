import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * W1-12: scripts/install.sh, run for real against fakes. node, pnpm, corepack, xcrun,
 * xcode-select, pgrep and open are shell stubs that log their calls; git is real, against a
 * local bare "origin" whose path names Kevin-Liu-01/Jarhead. Nothing reaches the network,
 * nothing builds, nothing opens: every run's PATH starts with the stubs, and every stub dir
 * has its own `open` and `pgrep`. Only a dry run clones (it prints the clone, never runs it).
 */

const SCRIPT = fileURLToPath(new URL("../install.sh", import.meta.url));
const skip = process.platform === "darwin" && process.arch === "arm64" ? false : "the installer runs on Apple silicon Macs only";

interface Stubs {
  /** `pnpm -v`; null: no pnpm on PATH. */
  readonly pnpm?: string | null;
  /** A corepack on PATH (Node 24 has one; Node 25 and newer do not). */
  readonly corepack?: boolean;
  /** `xcrun swift --version`'s version. */
  readonly swift?: string;
  /** pgrep's exit: 0 when Jarhead is running. */
  readonly pgrep?: number;
}

interface Run {
  readonly code: number;
  readonly out: string;
  /** Every stub call, one per line: `pnpm install --filter !./site`, `open -a Jarhead`, … */
  readonly calls: string[];
}

function sandbox(): { root: string; home: string; done: () => void } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jh-install-sh-")));
  const home = join(root, "home");
  mkdirSync(home);
  return { root, home, done: () => rmSync(root, { recursive: true, force: true }) };
}

function stubs(root: string, o: Stubs): { bin: string; log: string } {
  const bin = join(root, `bin-${Math.random().toString(36).slice(2)}`);
  const log = join(bin, "calls.log");
  mkdirSync(bin);
  writeFileSync(log, "");
  const put = (name: string, body: string): void => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  const record = `printf '%s\\n' "$(basename "$0") $*" >> '${log}'`;
  put("node", `case "$1" in -v) echo v24.13.0;; esac`);
  if (o.pnpm !== null) put("pnpm", `case "$1" in -v) echo ${o.pnpm ?? "10.30.0"};; *) ${record};; esac`);
  if (o.corepack) put("corepack", record);
  put("xcode-select", `case "$1" in -p) echo /Library/Developer/CommandLineTools;; *) exit 1;; esac`);
  put("xcrun", `case "$*" in "--find swift") echo /usr/bin/swift;; "swift --version") echo "Apple Swift version ${o.swift ?? "6.0.3"} (swiftlang-stub)";; *) exit 1;; esac`);
  put("pgrep", `${record}\nexit ${o.pgrep ?? 1}`);
  put("open", record);
  return { bin, log };
}

/** One run of the installer in front of `st`'s stubs (fresh ones from `Stubs`); `calls` holds this run's alone. */
function install(shell: string, home: string, dir: string, st: Stubs | { readonly bin: string; readonly log: string }, env: Record<string, string> = {}): Run {
  const { bin, log } = "bin" in st ? st : stubs(join(home, ".."), st);
  for (const name of ["open", "pgrep"]) assert.ok(existsSync(join(bin, name)), `the ${name} stub stands in front of /usr/bin/${name}`);
  const seen = readFileSync(log, "utf8").split("\n").filter(Boolean).length;
  // stderr joins stdout on one pipe, so `out` is in the order a terminal would show it.
  const r = spawnSync("/bin/sh", ["-c", 'exec "$0" "$1" 2>&1', shell, SCRIPT], { encoding: "utf8", env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, GIT_CONFIG_NOSYSTEM: "1", JARHEAD_DIR: dir, ...env } });
  return { code: r.status ?? -1, out: r.stdout, calls: readFileSync(log, "utf8").split("\n").filter(Boolean).slice(seen) };
}

const commands = (out: string): string[] => out.split("\n").flatMap((l) => (l.startsWith("jarhead: $ ") ? [l.slice("jarhead: $ ".length)] : []));

/** A local origin, the user's checkout of it, and a seed clone that plays upstream. */
function repos(root: string): { checkout: string; upstream: (file: string, text: string, msg: string) => void; git: (cwd: string, ...args: string[]) => string } {
  const env = { HOME: join(root, "home"), PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=main", ...args], { cwd, env, encoding: "utf8", stdio: "pipe" }).trim();
  const remote = join(root, "remote", "Kevin-Liu-01", "Jarhead.git");
  mkdirSync(remote, { recursive: true });
  git(remote, "init", "-q", "--bare");
  const seed = join(root, "seed");
  git(root, "clone", "-q", remote, seed);
  writeFileSync(join(seed, "README.md"), "v1\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "upstream v1");
  git(seed, "push", "-q", "origin", "main");
  const checkout = join(root, "jarhead");
  git(root, "clone", "-q", remote, checkout);
  const upstream = (file: string, text: string, msg: string): void => {
    writeFileSync(join(seed, file), text);
    git(seed, "add", "-A");
    git(seed, "commit", "-qm", msg);
    git(seed, "push", "-q", "origin", "main");
  };
  return { checkout, upstream, git };
}

/** What self_apply leaves behind: a self-edit commit fast-forwarded into the checkout's main. */
function selfEdit(git: (cwd: string, ...args: string[]) => string, checkout: string, file: string, text: string): void {
  writeFileSync(join(checkout, file), text);
  git(checkout, "add", "-A");
  git(checkout, "-c", "user.name=Jarhead", "-c", "user.email=jarhead@localhost", "commit", "-qm", "self-edit se_1");
}

test("a dry run is the same under dash and bash: a blob-less clone, pnpm install without the site, the build, the open", { skip }, () => {
  const s = sandbox();
  try {
    const dir = join(s.root, "fresh");
    const st = stubs(s.root, {});
    const dash = install("/bin/dash", s.home, dir, st, { JARHEAD_DRY_RUN: "1" });
    const bash = install("/bin/bash", s.home, dir, st, { JARHEAD_DRY_RUN: "1" });
    assert.equal(dash.code, 0, dash.out);
    assert.equal(dash.out, bash.out, "dash and bash print the same run");
    assert.deepEqual(commands(dash.out), [`git clone --quiet --filter=blob:none --branch main https://github.com/Kevin-Liu-01/Jarhead.git ${dir}`, "pnpm install --filter '!./site'", "pnpm build:hands", "pnpm build:mac", "open -a Jarhead"]);
    assert.deepEqual(dash.calls, [], "a dry run runs none of them");
    assert.ok(!existsSync(dir));
  } finally {
    s.done();
  }
});

test("pnpm older than 10 is refused before anything runs; the fix puts npm first and names corepack only where there is one", { skip }, () => {
  const s = sandbox();
  try {
    const dir = join(s.root, "fresh");
    const old = install("/bin/sh", s.home, dir, { pnpm: "8.15.0", corepack: true }, { JARHEAD_DRY_RUN: "1" });
    assert.equal(old.code, 1, old.out);
    assert.match(old.out, /^jarhead: pnpm 8\.15\.0 is too old\. Jarhead needs pnpm 10 or newer\. One of these, then run this again:\njarhead:   npm install -g pnpm@10\njarhead:   corepack enable\n$/m);
    assert.deepEqual(commands(old.out), []);

    const none = install("/bin/sh", s.home, dir, { pnpm: null, corepack: false }, { JARHEAD_DRY_RUN: "1" });
    assert.equal(none.code, 1, none.out);
    assert.match(none.out, /jarhead: pnpm 10 or newer is needed\. One of these, then run this again:\njarhead:   npm install -g pnpm@10\n$/);
    assert.doesNotMatch(none.out, /corepack|ships with Node/, "Node 25 and newer have no corepack");

    // Not a dry run: corepack is on PATH, and still nothing is enabled or installed.
    const withCorepack = install("/bin/sh", s.home, dir, { pnpm: null, corepack: true }, { JARHEAD_NO_OPEN: "1" });
    assert.equal(withCorepack.code, 1, withCorepack.out);
    assert.match(withCorepack.out, /jarhead:   npm install -g pnpm@10\njarhead:   corepack enable\n$/);
    assert.deepEqual(withCorepack.calls, [], "the installer runs no corepack and no pnpm");
    assert.ok(!existsSync(dir), "and clones nothing");
  } finally {
    s.done();
  }
});

test("Swift older than 5.10 is refused before pnpm install; Swift 5.10 passes", { skip }, () => {
  const s = sandbox();
  try {
    const dir = join(s.root, "fresh");
    const old = install("/bin/sh", s.home, dir, { swift: "5.9.2" }, { JARHEAD_DRY_RUN: "1" });
    assert.equal(old.code, 1, old.out);
    assert.match(old.out, /jarhead: Swift 5\.9 is too old\. Jarhead needs Swift 5\.10 or newer, which comes with Xcode 15\.3 or newer\./);
    assert.deepEqual(commands(old.out), []);
    const floor = install("/bin/sh", s.home, dir, { swift: "5.10" }, { JARHEAD_DRY_RUN: "1" });
    assert.equal(floor.code, 0, floor.out);
    assert.match(floor.out, /jarhead: Swift: Apple Swift version 5\.10 \(swiftlang-stub\)/);
  } finally {
    s.done();
  }
});

test("a rerun after a self-edit: the checkout's own commit is rebased onto the new upstream, then the build runs", { skip }, () => {
  const s = sandbox();
  try {
    const { checkout, upstream, git } = repos(s.root);
    selfEdit(git, checkout, "greeting.txt", "hello\n");
    upstream("README.md", "v2\n", "upstream v2");
    const r = install("/bin/sh", s.home, checkout, {}, { JARHEAD_NO_OPEN: "1" });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /jarhead: .*jarhead has 1 commit\(s\) of its own, a self-edit or yours\. They go on top of origin's main\./);
    assert.ok(commands(r.out).some((c) => /^git -c user\.name=Jarhead -c user\.email=jarhead@localhost -C .* rebase --quiet FETCH_HEAD$/.test(c)), "no git identity in this HOME: the rebase commits as Jarhead");
    assert.equal(readFileSync(join(checkout, "README.md"), "utf8"), "v2\n", "upstream's change is in");
    assert.equal(readFileSync(join(checkout, "greeting.txt"), "utf8"), "hello\n", "the self-edit is kept");
    assert.deepEqual(git(checkout, "log", "--format=%s").split("\n"), ["self-edit se_1", "upstream v2", "upstream v1"], "linear, the self-edit on top");
    assert.deepEqual(r.calls, ["pnpm install --filter !./site", "pnpm build:hands", "pnpm build:mac"]);
  } finally {
    s.done();
  }
});

test("a rerun with nothing of its own fast-forwards; a self-edit that conflicts is undone and the run stops on a jarhead: line, not a git fatal", { skip }, () => {
  const s = sandbox();
  try {
    const { checkout, upstream, git } = repos(s.root);
    upstream("README.md", "v2\n", "upstream v2");
    const ff = install("/bin/sh", s.home, checkout, {}, { JARHEAD_NO_OPEN: "1" });
    assert.equal(ff.code, 0, ff.out);
    assert.ok(commands(ff.out).some((c) => /^git -C .* merge --quiet --ff-only FETCH_HEAD$/.test(c)));
    assert.equal(readFileSync(join(checkout, "README.md"), "utf8"), "v2\n");

    selfEdit(git, checkout, "README.md", "mine\n");
    upstream("README.md", "v3\n", "upstream v3");
    const before = git(checkout, "rev-parse", "HEAD");
    const clash = install("/bin/sh", s.home, checkout, {}, { JARHEAD_NO_OPEN: "1" });
    assert.equal(clash.code, 1, clash.out);
    const lines = clash.out.trimEnd().split("\n");
    assert.match(lines.at(-1)!, /^jarhead:   curl -fsSL https:\/\/jarhead\.kevinliu\.studio\/install\.sh \| JARHEAD_DIR=.*jarhead-fresh sh$/);
    assert.match(clash.out, /jarhead: Those commits do not rebase cleanly onto origin's main\. The checkout is back as it was\. Finish by hand:\njarhead:   cd .*jarhead && git rebase origin\/main\n/);
    assert.equal(git(checkout, "rev-parse", "HEAD"), before, "HEAD is where it was");
    assert.equal(git(checkout, "status", "--porcelain"), "", "nothing half-applied");
    assert.ok(!existsSync(join(checkout, ".git", "rebase-merge")) && !existsSync(join(checkout, ".git", "rebase-apply")), "no rebase left in progress");
    assert.deepEqual(ff.calls, ["pnpm install --filter !./site", "pnpm build:hands", "pnpm build:mac"], "the fast-forward built");
    assert.deepEqual(clash.calls, [], "the stopped run built nothing");
  } finally {
    s.done();
  }
});

test("uncommitted changes stop the rerun before git changes anything", { skip }, () => {
  const s = sandbox();
  try {
    const { checkout, upstream, git } = repos(s.root);
    upstream("README.md", "v2\n", "upstream v2");
    writeFileSync(join(checkout, "README.md"), "half-done\n");
    const before = git(checkout, "rev-parse", "HEAD");
    const r = install("/bin/sh", s.home, checkout, {}, { JARHEAD_NO_OPEN: "1" });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /jarhead: .*jarhead has uncommitted changes\. Commit or stash them, then run this again:\njarhead:   git -C .*jarhead stash\n$/);
    assert.deepEqual(commands(r.out), [], "no fetch, no merge");
    assert.equal(git(checkout, "rev-parse", "HEAD"), before);
    assert.equal(readFileSync(join(checkout, "README.md"), "utf8"), "half-done\n");
    assert.deepEqual(r.calls, []);
  } finally {
    s.done();
  }
});

test("after the install, a running Jarhead gets a quit-and-reopen line instead of open; a quit one is opened", { skip }, () => {
  const s = sandbox();
  try {
    const { checkout, upstream } = repos(s.root);
    upstream("README.md", "v2\n", "upstream v2");
    const running = install("/bin/sh", s.home, checkout, { pgrep: 0 });
    assert.equal(running.code, 0, running.out);
    assert.match(running.out, /jarhead: Jarhead is running the build from before this install\. Quit Jarhead, then open it again:\njarhead:   open -a Jarhead\n$/);
    assert.ok(running.calls.includes("pgrep -x Jarhead"));
    assert.ok(!running.calls.some((c) => c.startsWith("open")), "the old process is never just brought forward");

    const quit = install("/bin/sh", s.home, checkout, { pgrep: 1 });
    assert.equal(quit.code, 0, quit.out);
    assert.deepEqual(quit.calls.filter((c) => c.startsWith("open")), ["open -a Jarhead"]);
  } finally {
    s.done();
  }
});
