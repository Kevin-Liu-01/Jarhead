// W3-5, PERF-12: the daemon's footprint from the agents package. The Agent SDK is loaded past tsx's transform (tsx
// rewrote its 1.5 MB entry with a source map: ~200 MB of RSS and ~380 ms of CPU on the event loop against ~120 ms for
// the file as it is, 2 s of blocked loop on a loaded Mac), and a cold scan of the session stores reads a few files at
// a time into buffers it reuses instead of a whole batch at once into buffers of their own (~190 MB at the peak over
// 150 Codex rollouts and 60 Claude sessions).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir, loadavg } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as codexStore from "../sessions/codex-store.ts";
import * as store from "../sessions/store.ts";

const run = promisify(execFile);

/** The read slots' counters, or a failed assertion naming what is missing (a store.ts from before W3-5 has none). */
function slots(): { allocated: number; reads: number; peak: number } {
  const reads = (store as Record<string, unknown>)["sliceReads"] as { stats: { allocated: number; reads: number; peak: number } } | undefined;
  assert.ok(reads, "store.ts shares one set of read slots and buffers across every store (sliceReads)");
  return { ...reads.stats };
}

const line = (f: number, k: number): string => JSON.stringify({ f, k, pad: "x".repeat(60 + ((f * 7 + k) % 40)) });

test("PERF-12: readHeadTail runs a few reads at a time, reuses their buffers, and every file gets exactly its own lines", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarhead-w35-slices-"));
  try {
    // Big files (sliced) and small ones (read whole) in turn, so a small file lands in a buffer a big one dirtied.
    const files = Array.from({ length: 24 }, (_, f) => {
      const lines = Array.from({ length: f % 2 === 0 ? 400 : 3 }, (_, k) => line(f, k));
      const path = join(dir, `f${f}.jsonl`);
      writeFileSync(path, `${lines.join("\n")}\n`);
      return { f, path, lines };
    });
    const before = slots();
    const read = await Promise.all(files.map((x) => store.readHeadTail(x.path, 4096, 4096)));
    const after = slots();
    const cap = (store as Record<string, unknown>)["SLICE_READS_AT_ONCE"] as number;
    console.log(`[measure] 24 reads: ${after.reads - before.reads} through the slots, ${after.allocated - before.allocated} buffers allocated, at most ${after.peak} in flight (cap ${cap})`);
    assert.equal(after.reads - before.reads, files.length);
    assert.ok(after.peak <= cap, `at most ${cap} reads in flight, saw ${after.peak}`);
    assert.ok(after.allocated - before.allocated <= cap, `buffers are reused: ${after.allocated - before.allocated} allocated for ${files.length} reads`);
    for (const [i, x] of files.entries()) {
      const r = read[i]!;
      if (x.lines.length === 3) {
        assert.equal(r.whole, true);
        assert.deepEqual(r.head, x.lines, `file ${x.f} read whole: its three lines and nothing a bigger file left in the buffer`);
        assert.deepEqual(r.tail, []);
        continue;
      }
      assert.equal(r.whole, false);
      assert.equal(r.head[0], x.lines[0], `file ${x.f}: the head starts at its first line`);
      assert.equal(r.tail.at(-1), x.lines.at(-1), `file ${x.f}: the tail ends at its last line`);
      for (const l of [...r.head, ...r.tail]) assert.equal((JSON.parse(l) as { f: number }).f, x.f, `file ${x.f} holds only its own lines`);
      assert.equal(r.bytesRead, 8192);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PERF-12: a Codex scan parses in rounds of SCAN_BATCH, so it stops less than a round past its cap", async () => {
  const root = mkdtempSync(join(tmpdir(), "jarhead-w35-codex-"));
  try {
    const day = join(root, "sessions", "2026", "10", "01");
    mkdirSync(day, { recursive: true });
    const now = Date.now();
    // Newest first: 19 threads Kevin typed into, one sub-agent run, then 40 more of his threads.
    for (let i = 0; i < 60; i++) {
      const id = `01a0${String(i).padStart(4, "0")}-0000-7000-8000-${String(i).padStart(12, "0")}`;
      const source = i === 19 ? "subagent" : "user";
      const meta = { id, cwd: `/Users/x/p${i}`, thread_source: source, ...(source === "subagent" ? { parent_thread_id: "01a00000-0000-7000-8000-000000000000" } : {}) };
      const path = join(day, `rollout-2026-10-01T09-00-00-${id}.jsonl`);
      writeFileSync(path, [JSON.stringify({ timestamp: new Date(now - 3600_000).toISOString(), type: "session_meta", payload: meta }), JSON.stringify({ timestamp: new Date(now - 3500_000).toISOString(), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `task ${i}` }] } })].join("\n") + "\n");
      utimesSync(path, new Date(now - i * 60_000), new Date(now - i * 60_000));
    }
    const limit = 20;
    const before = slots();
    const listed = await new codexStore.CodexStore({ root, limit }).scan();
    const after = slots();
    const batch = (codexStore as Record<string, unknown>)["SCAN_BATCH"] as number;
    const parsed = after.reads - before.reads;
    console.log(`[measure] codex scan, cap ${limit}: ${listed.length} listed, ${parsed} of 60 rollouts parsed, rounds of ${batch}`);
    assert.equal(listed.length, limit);
    assert.ok(!listed.some((s) => s.source === "subagent"), "sub-agent runs are still left out");
    assert.ok(typeof batch === "number" && batch < limit, `a round is smaller than the cap (SCAN_BATCH ${batch})`);
    assert.ok(parsed < limit + batch, `${parsed} rollouts parsed for a cap of ${limit}: less than one round past it (a cap-sized round parsed 40)`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PERF-12: loadSdk hands Node the SDK's entry as it is on disk, past tsx: no source map, one module, under 60 MB", async () => {
  const sessionTs = fileURLToPath(new URL("../claude-code/session.ts", import.meta.url));
  const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
  // A child under tsx, as the daemon runs; it loads the SDK once and reports what that cost.
  const code = `
    import { createRequire, findSourceMap } from "node:module";
    import { pathToFileURL } from "node:url";
    const sessionTs = ${JSON.stringify(sessionTs)};
    const { loadSdk } = await import(pathToFileURL(sessionTs).href);
    const entryPath = createRequire(sessionTs).resolve("@anthropic-ai/claude-agent-sdk");
    let last = performance.now(), blockMs = 0;
    const tick = setInterval(() => { const n = performance.now(); blockMs = Math.max(blockMs, n - last); last = n; }, 2);
    await new Promise((r) => setTimeout(r, 100));
    globalThis.gc(); blockMs = 0; last = performance.now();
    const r0 = process.memoryUsage().rss, c0 = process.cpuUsage();
    const p = loadSdk();
    const sdk = await p;
    const cpu = process.cpuUsage(c0);
    await new Promise((r) => setTimeout(r, 20));
    clearInterval(tick);
    globalThis.gc();
    const r1 = process.memoryUsage().rss;
    const mapped = (f) => findSourceMap(f) !== undefined || findSourceMap(pathToFileURL(f).href) !== undefined;
    console.log(JSON.stringify({
      deltaMB: Math.round((r1 - r0) / 1048576), cpuMs: Math.round((cpu.user + cpu.system) / 1000), blockMs: Math.round(blockMs),
      sourceMap: mapped(entryPath), control: mapped(sessionTs), query: typeof sdk.query,
      same: (await import(pathToFileURL(entryPath).href)) === sdk, memo: loadSdk() === p,
    }));
    process.exit(0);
  `;
  const { stdout } = await run(process.execPath, ["--expose-gc", "--import", import.meta.resolve("tsx"), "--input-type=module", "-e", code], { cwd: packageRoot, env: process.env, timeout: 120_000, maxBuffer: 1 << 20 });
  const r = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as { deltaMB: number; cpuMs: number; blockMs: number; sourceMap: boolean; control: boolean; query: string; same: boolean; memo: boolean };
  console.log(`[measure] loadSdk under tsx: +${r.deltaMB} MB RSS, ${r.cpuMs} ms CPU, longest event-loop block ${r.blockMs} ms (load ${loadavg()[0]!.toFixed(0)}); tsx's own copy was ~200 MB and ~380 ms CPU`);
  assert.equal(r.control, true, "tsx leaves a source map on what it transforms (session.ts has one), so the SDK's lack of one is evidence");
  assert.equal(r.sourceMap, false, "tsx never transformed the SDK's entry");
  assert.ok(r.deltaMB <= 60, `the SDK costs at most 60 MB of RSS, took ${r.deltaMB} MB`);
  assert.equal(r.query, "function");
  assert.equal(r.same, true, "a plain import afterwards gets the same module: one copy for the session and the MCP server");
  assert.equal(r.memo, true, "one load per process");
});
