/**
 * W3-4 (carried from W2-9): the path gate and the secret-store tables follow the state dir, as the redactor does.
 * With JARHEAD_STATE_DIR set (the test preload sets one; a second daemon may too), the state dir's env file and the wake
 * gate's passphrase are secrets, its ledger and settings.json ask, its trash is move-only and the rest of it is
 * Jarhead's own place to write. Before, only ~/.jarhead was any of that: `read_file <state dir>/env` ran.
 * With the state dir at ~/.jarhead (production) every verdict and every reason is what it was.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyAction, classifyPath, secretPathReason, shellCwdReason, type PathAccess } from "../policy.ts";

const HOME = "/Users/tester";
const REPO = "/Users/tester/jarvis";

/** Run `fn` with JARHEAD_STATE_DIR set to `dir` (or unset), restoring the preload's value after. */
function withStateDir<T>(dir: string | undefined, fn: () => T): T {
  const saved = process.env["JARHEAD_STATE_DIR"];
  if (dir === undefined) delete process.env["JARHEAD_STATE_DIR"];
  else process.env["JARHEAD_STATE_DIR"] = dir;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env["JARHEAD_STATE_DIR"];
    else process.env["JARHEAD_STATE_DIR"] = saved;
  }
}

const path = (p: string, access: PathAccess, home = HOME) => classifyPath({ path: p, access, home, repoRoot: REPO });
const sh = (text: string, home = HOME) => classifyAction({ kind: "run_shell", text, home, cwd: home, repoRoot: REPO });

test("state dir (audit repro): with JARHEAD_STATE_DIR set, its env file and the passphrase are refused to the file tools and the shell", () => {
  const state = mkdtempSync(join(tmpdir(), "jh-w34-state-"));
  withStateDir(state, () => {
    for (const file of ["env", "env.local", "ENV", "wake-auth.json"]) {
      const d = path(join(state, file), "read");
      assert.equal(d.verdict, "refuse", `read ${file}: ${d.reason}`);
      assert.match(d.reason, /holds secrets; Jarhead never reads or writes it/);
      assert.equal(path(join(state, file), "write").verdict, "refuse", `write ${file}`);
    }
    assert.equal(path(join(state, "env"), "read").reason, `${state}/env holds secrets; Jarhead never reads or writes it, and Kevin handles it`);
    // macOS's other spelling of a temp dir, and a link whose real path lands on the env file.
    if (state.startsWith("/var/")) assert.equal(path(`/private${state}/env`, "read").verdict, "refuse");
    assert.equal(classifyPath({ path: "/tmp/innocent", realPath: join(state, "env"), access: "read", home: HOME }).verdict, "refuse");
    assert.equal(secretPathReason(`cat ${state}/env`), `${state}/env`);
    for (const command of [`cat ${state}/env`, `cat "${state}/wake-auth.json"`, `grep KEY ${state}/env`, `cp ${state}/env /tmp/x`]) {
      const d = sh(command);
      assert.equal(d.verdict, "refuse", `${command}: ${d.verdict} ${d.reason}`);
    }
    // Sweeping the folder reaches env without naming it; looking at its names does not.
    for (const command of [`tar czf /tmp/s.tgz ${state}`, `grep -r KEY ${state}`, `cat ${state}/*`, `cat ${state}/e?v`]) {
      const d = sh(command);
      assert.equal(d.verdict, "refuse", `${command}: ${d.verdict} ${d.reason}`);
    }
    assert.equal(sh(`ls ${state}`).verdict, "run");
    assert.equal(sh(`cat ${state}/settings.json`).verdict, "run", "the settings are not a secret");
  });
});

test("state dir: the ledger asks, settings.json asks, the trash is move-only, and the rest is Jarhead's to write", () => {
  const state = mkdtempSync(join(tmpdir(), "jh-w34-state-"));
  // A home that is not the temp dir's parent, so /tmp alone would not make these writes run.
  withStateDir(state, () => {
    assert.equal(path(join(state, "notes.md"), "write").verdict, "run");
    assert.match(path(join(state, "ledger", "2026-10-05.ndjson"), "write").reason, /the ledger is append-only/);
    assert.equal(path(join(state, "ledger", "2026-10-05.ndjson"), "write").verdict, "confirm");
    assert.equal(path(join(state, "settings.json"), "write").verdict, "confirm");
    assert.match(path(join(state, "settings.json"), "write").reason, /settings\.json carries the wake gate/);
    for (const access of ["write", "delete"] as const) assert.equal(path(join(state, "Trash", "2026-10-01"), access).verdict, "refuse", access);
    assert.equal(path(join(state, "settings.json"), "read").verdict, "run");
  });
  // ~ in the variable is the home it is judged against, as the redactor reads it.
  withStateDir("~/state-elsewhere", () => {
    assert.equal(path(`${HOME}/state-elsewhere/env`, "read").verdict, "refuse");
    assert.equal(path(`~/state-elsewhere/wake-auth.json`, "read").verdict, "refuse");
    assert.equal(sh("cat ~/state-elsewhere/env").verdict, "refuse");
    assert.equal(sh("tar czf /tmp/s.tgz ~/state-elsewhere").verdict, "refuse");
    assert.equal(path(`${HOME}/state-elsewhere/notes.md`, "write").verdict, "run");
    // ~/.jarhead stays protected: the real install's secrets do not move because a test daemon's state did.
    assert.equal(path(`${HOME}/.jarhead/env`, "read").verdict, "refuse");
    assert.equal(path(`${HOME}/.jarhead/ledger/x.ndjson`, "write").verdict, "confirm");
  });
  // A caller that knows its state dir says so.
  withStateDir(undefined, () => {
    const d = classifyPath({ path: join(state, "env"), access: "read", home: HOME, stateDir: state });
    assert.equal(d.verdict, "refuse");
  });
});

test("state dir at ~/.jarhead (production): every verdict and reason is what it was, and a folder that is not the state dir is no secret", () => {
  const other = mkdtempSync(join(tmpdir(), "jh-w34-other-"));
  withStateDir(undefined, () => {
    assert.deepEqual(path(`${HOME}/.jarhead/env`, "read"), { verdict: "refuse", reason: "~/.jarhead/env holds secrets; Jarhead never reads or writes it, and Kevin handles it" });
    assert.deepEqual(path(`${HOME}/.jarhead/wake-auth.json`, "read"), { verdict: "refuse", reason: "the wake gate's passphrase file holds secrets; Jarhead never reads or writes it, and Kevin handles it" });
    assert.deepEqual(path(`${HOME}/.jarhead/notes.md`, "write"), { verdict: "run", reason: `writing ${HOME}/.jarhead/notes.md is inside Jarhead's own places or a folder Kevin named` });
    assert.deepEqual(path(`${HOME}/.jarhead/ledger/2026-10-05.ndjson`, "write"), { verdict: "confirm", reason: "the ledger is append-only; writing there needs a yes" });
    assert.equal(path(`${HOME}/.jarhead/trash/x`, "write").verdict, "refuse");
    assert.equal(sh("tar czf /tmp/j.tgz ~/.jarhead").verdict, "refuse");
    assert.equal(secretPathReason(`${other}/env`), undefined, "an env file in a folder that is not the state dir is not this table's");
    assert.equal(path(join(other, "env"), "read").verdict, "run");
    assert.equal(sh(`cat ${other}/env`).verdict, "run");
  });
});

/**
 * W3-4 review fix: the shell's trash and config rules named only `.jarhead`. With the state dir elsewhere, `rm -rf
 * <state>/trash` ran (in /tmp) or asked (under the home), so a yes could delete the trash; `>` over its ledger or
 * settings.json ran; and `rm -rf <state>/ledger` in /tmp ran as housekeeping. Each verdict is now ~/.jarhead's.
 */
test("state dir, the shell: its trash is move-only, `>` over its ledger or settings.json asks, and nothing in it is housekeeping, as at ~/.jarhead", () => {
  const verdicts = (d: string): string[] =>
    [
      `rm -rf ${d}/trash`,
      `rm ${d}/trash/2026-10-01/x`,
      `mv ${d}/trash/x /tmp/`,
      `echo x > ${d}/trash/x`,
      `cp /tmp/a ${d}/trash/`,
      `rm -rf ${d}/{ledger,trash}`,
      `echo x > ${d}/ledger/2026-10-05.ndjson`,
      `echo x > ${d}/settings.json`,
      `rm -rf ${d}/ledger`,
      `ls ${d}/trash`,
      `cat ${d}/trash/manifest.jsonl`,
      `echo x >> ${d}/ledger/2026-10-05.ndjson`,
      `echo hi > ${d}/notes.md`,
    ].map((c) => sh(c).verdict);
  const atJarhead = withStateDir(undefined, () => verdicts("~/.jarhead"));
  assert.deepEqual(atJarhead, ["refuse", "refuse", "refuse", "refuse", "refuse", "refuse", "confirm", "confirm", "confirm", "run", "run", "run", "run"]);
  const state = mkdtempSync(join(tmpdir(), "jh-w34-state-"));
  withStateDir(state, () => {
    assert.deepEqual(verdicts(state), atJarhead, `state dir ${state}`);
    if (state.startsWith("/var/")) assert.deepEqual(verdicts(`/private${state}`), atJarhead, "macOS's other spelling");
    assert.match(sh(`rm -rf ${state}/trash`).reason, /the trash \(~\/\.jarhead\/trash\) is move-only/);
    assert.equal(sh(`rm -rf ${state}/trash`, HOME).verdict, "refuse");
    // A temp file beside the state dir is still housekeeping, and the self-edit worktrees inside it are still scratch.
    assert.equal(sh(`rm -rf ${tmpdir()}/jh-w34-other-scratch`).verdict, "run");
    assert.equal(classifyAction({ kind: "run_shell", text: `rm -rf ${state}/worktrees/w1`, home: HOME, cwd: HOME, repoRoot: REPO, scratchRoots: [join(state, "worktrees", "w1")] }).verdict, "confirm", "as at ~/.jarhead: the worktree folder itself is not inside its own root");
    assert.equal(classifyAction({ kind: "run_shell", text: `rm -rf ${state}/worktrees/w1/build`, home: HOME, cwd: HOME, repoRoot: REPO, scratchRoots: [join(state, "worktrees", "w1")] }).verdict, "run");
    // Commands run from inside it reach env by its bare name, as from ~/.jarhead.
    assert.match(shellCwdReason(state, HOME) ?? "", /reach its secrets by their bare names/);
    assert.equal(shellCwdReason(join(state, "worktrees"), HOME), undefined);
  });
  withStateDir("~/state-elsewhere", () => assert.deepEqual(verdicts("~/state-elsewhere"), atJarhead, "a state dir under the home, spelled with ~"));
});

/**
 * W3-4 review fix: classifyPath trusted any JARHEAD_STATE_DIR as a place to write without asking. Set to /, the home,
 * a folder above it or ~/Documents, it opened what holds Kevin's files. Now the state dir (and any writable root a
 * caller passes, the runner's state dir among them) is trusted only when it is a folder of Jarhead's own.
 */
test("state dir set to /, ~, /Users or ~/Documents: no write outside Jarhead's places runs; its trash, ledger and settings keep their rules", () => {
  const write = (p: string, extra: { writableRoots?: string[] } = {}) => classifyPath({ path: p, access: "write", home: HOME, repoRoot: REPO, ...extra }).verdict;
  for (const dir of ["/", "~", "/Users", HOME, "~/Documents", "~/documents", "/Applications", "/Library", REPO, "/Users/tester/.."]) {
    withStateDir(dir, () => {
      for (const p of ["/Applications/x", `${HOME}/Documents/a.txt`, `${HOME}/notes.txt`, `${REPO}/x.ts`]) assert.equal(write(p), "confirm", `state dir ${dir}: write ${p}`);
      assert.equal(write("/tmp/x"), "run", `state dir ${dir}: /tmp stays Jarhead's`);
      assert.equal(write(`${HOME}/.jarhead/notes.md`), "run", `state dir ${dir}: ~/.jarhead stays Jarhead's`);
    });
  }
  withStateDir("~", () => {
    assert.equal(path(`${HOME}/trash/2026-10-01`, "write").verdict, "refuse", "its trash is still move-only");
    assert.equal(path(`${HOME}/ledger/x.ndjson`, "write").verdict, "confirm");
    assert.equal(path(`${HOME}/settings.json`, "write").verdict, "confirm");
    assert.equal(path(`${HOME}/env`, "read").verdict, "refuse", "and its env file is still a secret");
  });
  // A dedicated folder anywhere sensible is Jarhead's.
  for (const dir of ["~/jh-state", "/Users/tester/Library/Application Support/Jarhead2", "/opt/jarhead-state"]) {
    withStateDir(dir, () => assert.equal(write(`${dir.replace(/^~/, HOME)}/notes.md`), "run", dir));
  }
  // The same rule for the roots a caller passes (the runner passes its own state dir and the self-edit worktrees).
  withStateDir(undefined, () => {
    for (const root of ["/", HOME, "/Users", `${HOME}/Documents`, REPO, "/System", "/usr"]) assert.equal(write(`${HOME}/Documents/a.txt`, { writableRoots: [root] }), "confirm", `writable root ${root}`);
    const worktree = join(mkdtempSync(join(tmpdir(), "jh-w34-wt-")), "worktrees", "w1");
    assert.equal(write(join(worktree, "src", "a.ts"), { writableRoots: [worktree] }), "run", "a self-edit worktree");
    assert.equal(write(`${HOME}/jh-state/a.txt`, { writableRoots: [`${HOME}/jh-state`] }), "run");
  });
});
