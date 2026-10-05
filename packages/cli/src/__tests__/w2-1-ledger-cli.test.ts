/**
 * W2-1, the ledger CLI (launch triage), adopted from the audit's reproductions:
 *
 * - LM-1: `jarhead ledger [day]`, `ledger --speed` and `reflex-miss` are reads. They open the day files and nothing
 *   else: no Engine, so a thread a running daemon owns is never ended `failed` by someone reading the ledger.
 * - LM-8: `jarhead ledger` prints times on this Mac's clock, as its day files are named, not UTC.
 *
 * Each run is the real CLI in a child process over a temp HOME and state dir, with no keys, no helper and no daemon.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Ledger } from "@jarhead/core";
import { MAIN_THREAD_ID, type Thread } from "@jarhead/protocol";

const REPO = resolve(import.meta.dirname, "../../../..");
const MAIN = join(REPO, "packages/cli/src/main.ts");

function liveThread(at: number): Thread {
  return { id: "t_live", name: "Spotify", lane: "background", status: "acting", parentId: MAIN_THREAD_ID, parentDelegationId: "dlg_p", liveId: "item_1", task: "play focus", apps: ["Spotify"], startedAt: at, updatedAt: at, turns: 1, steps: 1, waits: 0, budget: { steps: 25, seconds: 180 }, canSay: true, canStop: true };
}

/** The CLI over a state dir of its own: no key, no helper, no daemon socket, in time zone `tz`. */
function cli(home: string, args: readonly string[], tz?: string): { status: number | null; stdout: string; stderr: string } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/API_KEY$|^JARHEAD_/.test(k)) env[k] = v;
  Object.assign(env, { HOME: home, JARHEAD_STATE_DIR: join(home, ".jarhead"), JARHEAD_AUTO_WAKE: "0", JARHEAD_NO_AUDIO: "1", JARHEAD_HANDS_BIN: join(home, "no-hands"), JARHEAD_SOCKET: join(home, "nobody.sock"), ...(tz ? { TZ: tz } : {}) });
  const r = spawnSync(process.execPath, ["--import", "tsx", MAIN, ...args], { cwd: REPO, env, encoding: "utf8", timeout: 60_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

for (const args of [["ledger"], ["ledger", "--speed"], ["reflex-miss"]]) {
  test(`LM-1 (audit repro): jarhead ${args.join(" ")} is a read; a thread a running daemon owns stays running`, () => {
    const home = mkdtempSync(join(tmpdir(), "jh-w21-cli-"));
    const state = join(home, ".jarhead");
    const ledger = new Ledger(state);
    const now = Date.now();
    // What a running daemon has written: a thread that started 20 s ago and is still working.
    ledger.append({ at: now - 20_000, type: "thread.started", thread: liveThread(now - 20_000) });
    const file = join(ledger.dir, Ledger.fileNameFor(now - 20_000));
    const before = readFileSync(file, "utf8");
    const r = cli(home, args);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(file, "utf8"), before, "a read appended to the ledger");
    assert.deepEqual(readdirSync(state).sort(), ["ledger"], "a read made nothing else in the state dir");
  });
}

test("LM-8 (audit repro): jarhead ledger prints a row's time on this Mac's clock, not UTC", () => {
  const home = mkdtempSync(join(tmpdir(), "jh-w21-cli-tz-"));
  const zone = "America/Los_Angeles";
  // 03:15 UTC on 5 October 2026 is 20:15 on the 4th in Los Angeles: the day file the CLI reads is the local day's.
  const at = Date.UTC(2026, 9, 5, 3, 15, 0);
  const saved = process.env["TZ"];
  process.env["TZ"] = zone;
  try {
    new Ledger(join(home, ".jarhead")).append({ at, type: "heard", item: { id: "t_1", speaker: "kevin", text: "a line said at 20:15 local", at, startMs: 0, endMs: 900, final: true } });
  } finally {
    if (saved === undefined) delete process.env["TZ"];
    else process.env["TZ"] = saved;
  }
  const r = cli(home, ["ledger", "2026-10-04"], zone);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^20:15:00 you {4}: a line said at 20:15 local$/m, r.stdout);
});
