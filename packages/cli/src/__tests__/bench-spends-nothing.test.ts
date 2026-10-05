import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Brain, ToolRunner } from "@jarhead/brain";

/**
 * W2-7, "the bench spends nothing" (RF-10, PERF-4, RX-28). `pnpm jarhead bench` and `bench --brain`
 * read the real config and built their Engine over the user's OpenAI key and the real memory
 * service, so the bench's own phrases were embedded on that key (7 requests a run), the voice probe
 * checked it, and the permission read started the real helper even with in-process hands. Here the
 * user's Mac is planted in the suite's temp state dir: a canary key in its env file, where Setup
 * writes it, and a canary helper at JARHEAD_HANDS_BIN. Every request that would leave the Mac and
 * every process a bench starts is recorded; the processes that would touch the Mac are refused
 * before they run.
 */

const CANARY_KEY = "sk-canary-w2-7";
const stateDir = process.env["JARHEAD_STATE_DIR"];
assert.ok(stateDir, "the test preload points JARHEAD_STATE_DIR at a temp dir");
writeFileSync(join(stateDir, "env"), `OPENAI_API_KEY=${CANARY_KEY}\nANTHROPIC_API_KEY=sk-ant-canary-w2-7\n`, { mode: 0o600 });
const helperDir = mkdtempSync(join(tmpdir(), "jh-w2-7-helper-"));
const helperBin = join(helperDir, "jarhead-hands");
writeFileSync(helperBin, "#!/bin/sh\nexit 3\n");
chmodSync(helperBin, 0o755);
process.env["JARHEAD_HANDS_BIN"] = helperBin;

/** What would touch the Mac: the helper, the Dock and the running apps, a window or a sound, a Swift build, a brain CLI. */
const TOUCHES_THE_MAC = /^(jarhead-hands|defaults|lsappinfo|lsregister|osascript|open|killall|screencapture|swift|swiftc|xcrun|codex|claude|say|afplay|caffeinate)$/;
const started: { fn: string; file: string; args: string; refused: boolean }[] = [];

/** A child that never ran: it fails on the next tick, the way a missing binary does (to whoever listens; the record is the test's evidence). */
function refusedChild(err: Error, emit: boolean): EventEmitter {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: null, pid: undefined, kill: () => false });
  if (emit) setImmediate(() => child.listenerCount("error") > 0 && child.emit("error", err));
  return child;
}

const cp = createRequire(import.meta.url)("node:child_process") as Record<string, (...a: unknown[]) => unknown>;
for (const fn of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]) {
  const real = cp[fn];
  if (!real) continue;
  cp[fn] = function recorded(this: unknown, ...a: unknown[]): unknown {
    const file = String(a[0]);
    const args = Array.isArray(a[1]) ? a[1].map(String).join(" ") : "";
    const refused = TOUCHES_THE_MAC.test(basename(file.split(" ")[0] ?? file)) || file.startsWith(helperDir) || /duck-probe/.test(args);
    started.push({ fn, file, args, refused });
    if (!refused) return real.apply(this, a);
    const err = Object.assign(new Error(`refused by the test: ${file}`), { code: "ENOENT" });
    if (fn === "spawnSync") return { pid: 0, status: 127, signal: null, stdout: "", stderr: err.message, output: [null, "", err.message], error: err };
    if (fn === "execFileSync" || fn === "execSync") throw err;
    const cb = a.find((x): x is (e: Error, out: string, errOut: string) => void => typeof x === "function");
    if (cb) setImmediate(() => cb(err, "", ""));
    return refusedChild(err, !cb);
  };
}
syncBuiltinESMExports();

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i;
const offMac: string[] = [];
const keyed: string[] = [];
const inner = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const auth = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("authorization") ?? "";
  const what = `${(init?.method ?? "GET").toUpperCase()} ${url.host}${url.pathname}`;
  if (auth.includes(CANARY_KEY)) keyed.push(what);
  if (!LOOPBACK.test(url.hostname)) offMac.push(what);
  return inner(input, init);
}) as typeof fetch;

// The engine reads the Dock 20 s after it starts, past the end of a one-run bench; here at once, so a bench that reads it is seen.
const { Engine } = await import("@jarhead/engine");
Object.defineProperty(Engine, "DOCK_AUDIT_DELAY_MS", { value: 0 });
const { bench } = await import("../bench.ts");
const { runBrainBench } = await import("../bench-brain.ts");

/** What one bench run did: requests carrying the canary key, requests off the Mac, and processes refused for touching it. */
function since(mark: { keyed: number; offMac: number; started: number }): { requestsWithTheKey: string[]; requestsOffTheMac: string[]; processesThatTouchTheMac: string[] } {
  const touched = started.slice(mark.started).filter((s) => s.refused).map((s) => `${s.fn} ${basename(s.file)} ${s.args}`.trim());
  return { requestsWithTheKey: [...new Set(keyed.slice(mark.keyed))], requestsOffTheMac: [...new Set(offMac.slice(mark.offMac))], processesThatTouchTheMac: [...new Set(touched)] };
}
const mark = (): { keyed: number; offMac: number; started: number } => ({ keyed: keyed.length, offMac: offMac.length, started: started.length });
const NOTHING = { requestsWithTheKey: [], requestsOffTheMac: [], processesThatTouchTheMac: [] };

test("W2-7 (RF-10, PERF-4): bench --fake-hands --no-duck with a key and a helper on this Mac: no request leaves it, the key rides nothing, the helper and the Dock are never touched", async () => {
  const before = mark();
  // `pnpm jarhead bench --fake-hands --no-duck`.
  const r = await bench({ runs: 1, codex: false, fakeHands: true, json: true, duck: false, print: () => undefined });
  assert.ok(r.rows.some((row) => row.metric === "ear: final → dispatch"), "the bench ran its rows");
  // One report, so a regression shows every way out at once: no embeddings, no model list, no voice key
  // probe; no helper start (its --permissions probe included), no defaults export, no duck probe build.
  assert.deepEqual(since(before), NOTHING);
});

test("W2-7 (RX-28): bench --brain with a stand-in brain, a key and a helper on this Mac: no request leaves it, the key rides nothing, the helper and the Dock are never touched", async () => {
  // A good model on "click the search bar and type hello": look, click by name, type. Codex's own turns
  // cost the ChatGPT plan by design; everything around them is what this pins.
  const standIn = (runner: ToolRunner): Brain => ({
    kind: "bench-stand-in",
    start: async () => ({ ready: true, detail: "stand-in brain" }),
    handle: async (task, sink) => {
      runner.attach(sink, task);
      try {
        await runner.run("frontmost_app", {});
        await runner.run("click_element", { name: "search bar" });
        await runner.run("type", { text: "hello" });
        return { status: "done", summary: "typed hello into the search field." };
      } finally {
        runner.attach(undefined);
      }
    },
    cancel: async () => undefined,
    stop: async () => undefined,
  });
  const before = mark();
  const report = await runBrainBench({ runs: 1, json: true, only: ["scroll-down", "click-search-type"], brain: standIn, warmWaitMs: 0, delegationTimeoutMs: 15_000, print: () => undefined });
  assert.ok(report.records.some((r) => r.phase === "brain-path" && r.status === "done"), "the brain path ran");
  assert.equal(report.meta["costs"], "nothing (stand-in brain)");
  // The same ways out as above: memory's embeddings and model list, the voice key probe, the helper's
  // --permissions, the Dock's defaults export.
  assert.deepEqual(since(before), NOTHING);
});
