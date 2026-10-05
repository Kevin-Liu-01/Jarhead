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
import { classifyAction, classifyPath, secretPathReason, type PathAccess } from "../policy.ts";

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
