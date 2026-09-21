import { test } from "node:test";
import assert from "node:assert/strict";
import type { Brain, CodexProbe, ToolRunner } from "@jarhead/brain";
import { BLOCKED_TOOLS, BRAIN_BENCH_COMMANDS, ROLLOVER_LOG_RE, WikiHands, analyzeRun, benchScreenPng, compareReports, parseWireLine, percentile, pngSize, renderReport, runBrainBench, stat, summarize, syntheticScreenPng, type AnalyzeInput, type RunnerCall, type WireRow } from "../bench-brain.ts";

/**
 * The brain bench without Codex: the canned screen is a real PNG, the canned
 * hands answer what the tools ask, the wire parser and the per-run analysis
 * find the moments the report is built from, and a whole run with a stand-in
 * brain produces a report with the reflex path and the brain path filled in —
 * nothing here spends a Codex turn or touches the Mac.
 */

/** A shared CI runner is slower and noisier than a Mac on a desk: its wall-clock ceilings are three times ours. The [measure] lines carry the real numbers either way. */
const RUNNER_SLACK = process.env["GITHUB_ACTIONS"] ? 3 : 1;

test("bench --brain: the canned screen is a real 1280×800 PNG (fixture, and the drawn stand-in)", () => {
  const drawn = syntheticScreenPng();
  assert.deepEqual([...drawn.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.deepEqual(pngSize(drawn), { width: 1280, height: 800 });
  assert.equal(drawn.subarray(12, 16).toString("latin1"), "IHDR");
  assert.equal(drawn.subarray(drawn.length - 8, drawn.length - 4).toString("latin1"), "IEND");
  const shipped = benchScreenPng();
  assert.match(shipped.source, /bench-screen-wiki-1280x800\.png$/, "the fixture ships with the CLI");
  assert.deepEqual(pngSize(shipped.png), { width: 1280, height: 800 });
});

test("bench --brain: the canned hands show Safari on the wiki, find the search field for anything search-shaped, and a typed text shows up in the focused field", async () => {
  const hands = new WikiHands(syntheticScreenPng());
  const front = await hands.request<{ app: string; window: { title: string } }>("frontmost");
  assert.equal(front.app, "Safari");
  assert.match(front.window.title, /Kevin Wiki/);
  const search = await hands.request<{ found: boolean; unique: boolean; element?: { role: string; center: { x: number; y: number }; label: string } }>("find_element", { name: "search bar" });
  assert.equal(search.found, true);
  assert.equal(search.unique, true);
  assert.equal(search.element?.role, "AXTextField");
  const p = search.element!.center;
  const under = await hands.request<{ role: string; frame: { x: number; y: number; w: number; h: number } }>("element_at", p);
  assert.equal(under.role, "AXTextField", "what is under the search field's centre is the search field (click_element's cover check passes)");
  const link = await hands.request<{ found: boolean; element?: { role: string; title: string } }>("find_element", { name: "Design" });
  assert.equal(link.element?.role, "AXLink");
  const none = await hands.request<{ found: boolean }>("find_element", { name: "Buy now" });
  assert.equal(none.found, false);
  await hands.request("type", { text: "hello" });
  const focused = await hands.request<{ value: string; secure: boolean }>("focused_text");
  assert.equal(focused.value, "hello");
  assert.equal(focused.secure, false);
  const shot = await hands.request<{ width: number; height: number; pngBase64: string }>("screenshot", { maxLongEdge: 1280 });
  assert.deepEqual([shot.width, shot.height], [1280, 800]);
  assert.ok(shot.pngBase64.length > 1000);
});

test("bench --brain: wire lines become rows (turn/start prompt size and images, items, token usage, turn status)", () => {
  const start = parseWireLine("out", JSON.stringify({ id: 7, method: "turn/start", params: { threadId: "t", input: [{ type: "text", text: "hello world" }, { type: "localImage", path: "/x.png" }] } }), 1000);
  assert.deepEqual([start?.method, start?.id, start?.inputChars, start?.images, start?.threadId], ["turn/start", 7, 11, 1, "t"]);
  const msg = parseWireLine("in", JSON.stringify({ method: "item/completed", params: { item: { type: "agentMessage", text: "Safari is in front." } } }), 1001);
  assert.deepEqual([msg?.itemType, msg?.text], ["agentMessage", "Safari is in front."]);
  const mcp = parseWireLine("in", JSON.stringify({ method: "item/started", params: { item: { type: "mcpToolCall", tool: "search_files", server: "jarhead", status: "inProgress" } } }), 1002);
  assert.deepEqual([mcp?.itemType, mcp?.tool, mcp?.server], ["mcpToolCall", "search_files", "jarhead"]);
  const usage = parseWireLine("in", JSON.stringify({ method: "thread/tokenUsage/updated", params: { tokenUsage: { total: { totalTokens: 38800 }, last: { totalTokens: 19400 }, modelContextWindow: 258400 } } }), 1003);
  assert.deepEqual(usage?.tokenUsage, { total: 38800, last: 19400, window: 258400 });
  const done = parseWireLine("in", JSON.stringify({ method: "turn/completed", params: { turn: { id: "x", status: "completed" } } }), 1004);
  assert.equal(done?.turnStatus, "completed");
  const ack = parseWireLine("in", JSON.stringify({ id: 3, result: { thread: { id: "abc" }, model: "gpt-6-astra", reasoningEffort: "medium" } }), 1005);
  assert.equal(ack?.text, "thread abc model=gpt-6-astra effort=medium");
  assert.equal(ack?.threadId, "abc", "a thread/start ack carries the thread it opened");
  assert.equal(parseWireLine("in", "not json"), undefined);
});

test("bench --brain: a run's record — the eyes' shot is not the first model tool, the first action is the first acting tool that returned ok (not a confirmation question), bootstrap and no-such-file are counted narrowly, rollovers come off the wire's thread id (the log line only without one), model steps and think gaps are derived", () => {
  const base = 100_000;
  const wire: WireRow[] = [
    { at: base + 3, dir: "out", id: 1, method: "turn/start", inputChars: 400, images: 1 },
    { at: base + 9, dir: "in", id: 1 },
    { at: base + 700, dir: "in", method: "item/started", itemType: "userMessage" },
    { at: base + 4000, dir: "in", method: "item/completed", itemType: "reasoning", text: "" },
    { at: base + 4100, dir: "in", method: "item/started", itemType: "mcpToolCall", tool: "read_file", server: "jarhead" },
    { at: base + 4200, dir: "in", method: "item/completed", itemType: "mcpToolCall", tool: "read_file", server: "jarhead", status: "failed" },
    { at: base + 7500, dir: "in", method: "item/completed", itemType: "reasoning", text: "" },
    { at: base + 7600, dir: "in", method: "item/completed", itemType: "mcpToolCall", tool: "left_click", server: "jarhead", status: "completed" },
    { at: base + 11000, dir: "in", method: "item/agentMessage/delta" },
    { at: base + 11500, dir: "in", method: "item/completed", itemType: "agentMessage", text: "Clicked the search bar." },
    { at: base + 11600, dir: "in", method: "turn/completed", turnStatus: "completed" },
    { at: base + 11600, dir: "in", method: "thread/tokenUsage/updated", tokenUsage: { total: 60000, last: 25000, window: 258400 } },
  ];
  const runnerCalls: RunnerCall[] = [
    { at: base + 1, ms: 2, name: "screenshot", input: '{"quick":true}', kind: "image", ok: true, blocked: false, output: "1280x800 image" }, // the eyes, before the turn went out
    { at: base + 4150, ms: 1, name: "read_file", input: '{"path":"~/Documents/GitHub/kevin-wiki/AGENTS.md"}', kind: "error", ok: false, blocked: false, output: "no such file: ~/Documents/GitHub/kevin-wiki/AGENTS.md" },
    { at: base + 4160, ms: 1, name: "read_file", input: '{"path":"/Users/kevinliu/jarvis/AGENTS.md"}', kind: "text", ok: true, blocked: false, output: "# AGENTS.md — repo rules" }, // this repo's AGENTS.md: a task target, not the wiki bootstrap
    { at: base + 4170, ms: 2, name: "read_focused_text", input: "{}", kind: "error", ok: false, blocked: false, output: "not_found: no focused UI element" }, // a real failure, not a missing file
    { at: base + 7550, ms: 0, name: "run_shell", input: '{"command":"npm run status"}', kind: "error", ok: false, blocked: true, output: "run_shell is unavailable" },
    { at: base + 7560, ms: 1, name: "left_click", input: '{"coordinate":[1200,760]}', kind: "question", ok: false, blocked: false, output: "About to click Send — say yes to go ahead" }, // the handshake asked; nothing happened yet
    { at: base + 7580, ms: 3, name: "left_click", input: '{"coordinate":[980,148]}', kind: "text", ok: true, blocked: false, output: "ok" },
  ];
  const delegation = {
    id: "dlg_1",
    liveId: "brain-path_click-search-type_1",
    createdAt: base,
    offsetMs: 5000,
    request: "jarhead click the search bar and type hello",
    status: "done" as const,
    summary: "Clicked the search bar.",
    steps: [
      { id: "s1", at: base + 4000, kind: "thinking" as const, text: "Reading the wiki index." },
      { id: "s2", at: base + 7580, kind: "tool" as const, tool: { name: "left_click", input: {}, ok: true, ms: 3 } },
      { id: "s3", at: base + 11500, kind: "commentary" as const, text: "Clicked the search bar." },
    ],
    timings: { delegatedAt: base, firstThinkingAt: base + 4000, firstCommentaryAt: base + 11500, doneAt: base + 11600, firstToolAt: base + 7580, firstActionAt: base + 7580, eyesMs: 2 },
  };
  const input: AnalyzeInput = {
    phase: "brain-path",
    cmd: BRAIN_BENCH_COMMANDS[3]!,
    run: 1,
    liveId: delegation.liveId,
    delegation,
    timedOut: false,
    t0: base,
    t1: base + 11650,
    wire,
    runnerCalls,
    logLines: [{ at: base + 50, level: "info", scope: "brain.codex", message: "context rolled over to a fresh thread 01a0 (? tokens used)" }],
    commentary: ["Clicked the search bar."],
  };
  const rec = analyzeRun(input);
  assert.equal(rec.t.firstThinking, 4000);
  assert.equal(rec.t.firstModelTool, 4150, "the first runner call after turn/start — the eyes' shot at +1 ms is not it");
  assert.equal(rec.t.firstAction, 7580, "the first acting tool that returned ok (the blocked run_shell at +7550 and the confirmation question at +7560 are not it)");
  assert.equal(rec.t.done, 11600);
  assert.equal(rec.t.eyesMs, 2);
  assert.equal(rec.toolCount, 6);
  assert.deepEqual(rec.toolNames, ["read_file(err)", "read_file", "read_focused_text(err)", "run_shell(blocked)", "left_click(asked)", "left_click"]);
  assert.equal(rec.rollovers, 1, "no thread id on this wire and no previous thread: the log's fresh-thread line counts");
  assert.equal(rec.threadId, undefined);
  assert.equal(rec.bootstrap.calls.length, 2, "the kevin-wiki read and npm run status — this repo's AGENTS.md is not bootstrap");
  assert.equal(rec.bootstrap.npmRunStatus, true);
  assert.equal(rec.bootstrap.noSuchFile.length, 1, "the missing wiki file — read_focused_text's not_found is not a missing file");
  assert.equal(rec.generations, 3, "two MCP calls and a final message");
  assert.equal(rec.wire.reasoningItems, 2);
  assert.deepEqual([rec.wire.turnStartAck, rec.wire.userMessage, rec.wire.firstAgentMessageDelta, rec.wire.firstMcpTool, rec.wire.turnStatus], [9, 700, 11000, "read_file", "completed"]);
  assert.deepEqual(rec.wire.tokenUsage, { total: 60000, last: 25000, window: 258400 });
  assert.deepEqual(rec.generationGapsMs, [3450, 3380, 3920], "userMessage → read_file, → run_shell, → final message (the reads 10 ms apart and the click 30 ms after the blocked call are inside the gaps)");
  assert.equal(rec.firstWords.firstAgentMessage, "Clicked the search bar.");
  assert.equal(rec.firstWords.firstThinkingStep, "Reading the wiki index.");
  assert.equal(rec.runnerCalls[0]?.preBrain, true);

  // Rollovers off the wire: this turn's thread against the previous turn's, whatever the log says.
  const currentLine = "context 181k/258k (0.70) → fresh thread 01a09378 (at the next turn, thread/start 3439 ms)"; // codex-app-server.ts rollOver()
  const onThread = (id: string, prev: string | undefined, log: readonly string[] = []) =>
    analyzeRun({ ...input, wire: wire.map((r) => (r.dir === "out" && r.method === "turn/start" ? { ...r, threadId: id } : r)), logLines: log.map((message) => ({ at: base + 50, level: "info", scope: "brain.codex", message })), prevThreadId: prev });
  assert.equal(onThread("bbb", "aaa").rollovers, 1, "a different thread than the previous turn's: a rollover happened between the two, wherever its thread/start landed");
  assert.equal(onThread("bbb", "aaa").threadId, "bbb");
  assert.equal(onThread("bbb", "bbb").rollovers, 0, "the same thread: no rollover, even with nothing in the log");
  assert.equal(onThread("bbb", "bbb", [currentLine]).rollovers, 0, "with a wire the thread id decides, not the log");
  assert.equal(onThread("bbb", undefined, [currentLine]).rollovers, 1, "no previous thread known: the app-server's own fresh-thread line counts");
  assert.ok(ROLLOVER_LOG_RE.test(currentLine), "the pattern matches the line codex-app-server.ts logs today");

  const s = summarize([rec]);
  assert.equal(s.brainPath.overall.n, 1);
  assert.equal(s.brainPath.overall.metrics.firstAction.median, 7580);
  assert.equal(s.rollovers, 1);
  assert.equal(s.noSuchFile, 1);
  assert.equal(s.narrationFirst, 0, "the first words streamed after the first tool");
  assert.equal(s.generationGapMs.n, 3);
  assert.ok(renderReport({ meta: { effort: "medium" }, records: [rec], summary: s }).some((l) => /click-search-type/.test(l)));
});

test("bench --brain: percentiles and the blocked set", () => {
  assert.equal(percentile([5, 1, 3], 50), 3);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  assert.ok(Number.isNaN(percentile([], 50)));
  const s = stat([4, 2, Number.NaN, 8]);
  assert.deepEqual([s.n, s.median, s.min, s.max], [3, 4, 2, 8]);
  for (const t of ["run_shell", "applescript", "write_file", "edit_file", "open_url", "agent_start", "self_apply"]) assert.ok(BLOCKED_TOOLS.has(t));
});

test("bench --brain: a whole run with a stand-in brain — the reflex path catches scroll down, the brain path records first tool / first action / done, blocked tools are refused, the report renders", async () => {
  // What a good model does on "click the search bar and type hello": look, click by name, type, verify.
  const standIn = (runner: ToolRunner): Brain => ({
    kind: "bench-stand-in",
    start: async () => ({ ready: true, detail: "stand-in brain for the bench test" }),
    handle: async (task, sink) => {
      runner.attach(sink, task);
      try {
        await runner.run("frontmost_app", {});
        const shell = await runner.run("run_shell", { command: "npm run status" });
        assert.equal(shell.result.kind, "error", "acting outside the canned hands is refused at the runner");
        await runner.run("click_element", { name: "search bar" });
        await runner.run("type", { text: "hello" });
        const focused = await runner.run("read_focused_text", {});
        const value = focused.result.kind === "text" ? (JSON.parse(focused.result.text) as { value?: string }).value : undefined;
        return { status: "done", summary: `typed "${value ?? ""}" into the search field.` };
      } finally {
        runner.attach(undefined);
      }
    },
    cancel: async () => undefined,
    stop: async () => undefined,
  });
  const lines: string[] = [];
  const report = await runBrainBench({ runs: 1, json: true, only: ["scroll-down", "click-search-type"], brain: standIn, warmWaitMs: 0, delegationTimeoutMs: 15_000, print: (l) => lines.push(l) });
  const reflex = report.records.find((r) => r.phase === "reflex-path" && r.cmd === "scroll-down");
  assert.ok(reflex, "scroll down ran on the reflex path");
  assert.equal(reflex.status, "done");
  assert.equal(reflex.summary, "scrolled down.");
  assert.ok(reflex.t.done < 2000 * RUNNER_SLACK, `the reflex row finished under ${2000 * RUNNER_SLACK} ms (${reflex.t.done} ms)`);
  assert.equal(reflex.toolNames[0], "scroll");
  assert.ok(!report.records.some((r) => r.phase === "reflex-path" && r.cmd === "click-search-type"), "a compound command is not a reflex");
  const brain = report.records.filter((r) => r.phase === "brain-path");
  assert.equal(brain.length, 2, "both commands once on the brain path");
  for (const r of [reflex, ...brain]) assert.equal(r.delegationRequest, r.request, `${r.liveId}: consecutive utterances must not merge into one request`);
  for (const r of brain) {
    assert.equal(r.status, "done", `${r.liveId}: ${r.summary ?? ""}`);
    assert.equal(r.summary, 'typed "hello" into the search field.', "the typed text is what the focused field then reads");
    assert.equal(r.t.firstModelTool !== undefined && r.t.firstModelTool >= 0, true);
    assert.ok(r.t.firstAction !== undefined, "the click by name is the first action");
    assert.deepEqual(r.toolNames, ["frontmost_app", "run_shell(blocked)", "click_element", "type", "read_focused_text"]);
    assert.ok(r.runnerCalls[0]?.preBrain, "the eyes' quick shot is marked as the engine's");
    assert.ok(r.t.firstThinking === undefined || r.t.firstThinking >= 0);
    assert.equal(r.bootstrap.npmRunStatus, true, "the refused npm run status is still counted as a bootstrap attempt");
  }
  assert.equal(report.summary.brainPath.overall.n, 2);
  assert.ok(Number.isFinite(report.summary.brainPath.overall.metrics.firstAction.median));
  assert.equal(report.summary.reflexPath.length, 1);
  assert.equal(report.meta["costs"], "nothing (stand-in brain)");
  assert.deepEqual(report.meta["commands"], ["click-search-type", "scroll-down"], "--only keeps the canonical order");
  assert.ok(lines.some((l) => /nothing on this Mac is touched/.test(l)), "the header says nothing is touched");
  // The stand-in Live's clock is the wall clock: after the reflex row finished in milliseconds the bench WAITED for the
  // merge gap instead of skewing session time, so speech end → delegation stays a real, near-zero number on every row.
  for (const r of report.records) {
    assert.ok(typeof r.t.speechToDelegation === "number", `${r.liveId}: speechEndAt is stamped`);
    assert.ok(r.t.speechToDelegation > -50 && r.t.speechToDelegation < 500 * RUNNER_SLACK, `${r.liveId}: speech end → delegation ≈ 0, not a clock skew (got ${r.t.speechToDelegation} ms, under ${500 * RUNNER_SLACK})`);
  }
  assert.equal(report.meta["contextRollovers"], 0, "no wire and no fresh-thread line: 0 rollovers");
  assert.equal(report.summary.rollovers, 0);
  const rendered = renderReport(report);
  assert.ok(rendered.some((l) => /scroll-down\s+done/.test(l)));
  assert.ok(rendered.some((l) => /^\s+all\s+2/.test(l)));
  assert.ok(rendered.some((l) => /speech end → delegation: median -?\d+ ms/.test(l)));
});

test("bench --brain: without Codex the bench refuses before an engine or a brain starts — the auto brain would cost API dollars — unless --allow-api-spend", async () => {
  const probe: CodexProbe = { bin: undefined, version: undefined, signedIn: false, authMode: undefined, desktopRunning: false, configModel: undefined, detail: "codex binary not found (test)" };
  await assert.rejects(runBrainBench({ runs: 1, json: true, probe, print: () => undefined }), /Codex is not available \(codex binary not found \(test\)\).*--allow-api-spend/);
});

test("bench --brain: verificationShots and observedResults per run and in the summary; --compare prints deltas against a baseline", () => {
  const base = 200_000;
  const calls = (rows: Array<[number, string, string, string?]>): RunnerCall[] => rows.map(([rel, name, kind, output]) => ({ at: base + rel, ms: 2, name, input: "{}", kind, ok: kind === "text" || kind === "image", blocked: false, ...(output !== undefined ? { output } : {}) }));
  const delegation = { id: "dlg_v", liveId: "brain-path_click-search-type_1", createdAt: base, offsetMs: 0, request: "jarhead click the search bar and type hello", status: "done" as const, steps: [], timings: { delegatedAt: base, doneAt: base + 9000 } };
  const input = (runnerCalls: RunnerCall[]): AnalyzeInput => ({ phase: "brain-path", cmd: BRAIN_BENCH_COMMANDS[3]!, run: 1, liveId: delegation.liveId, delegation, timedOut: false, t0: base, t1: base + 9100, wire: [], runnerCalls, logLines: [], commentary: [] });
  // Before the observation lever: click → screenshot → type → screenshot (two verifying shots, no now: line).
  const before = analyzeRun(input(calls([[3000, "left_click", "text", "OK"], [3100, "screenshot", "image"], [6000, "browser_type", "text", "typed hello"], [6100, "screenshot", "image"]])));
  assert.deepEqual([before.actingCalls, before.verificationShots, before.observedResults], [2, 2, 0]);
  // After: both results carry the line; one shot remains (the model still looked once); a refused click counts as neither.
  const after = analyzeRun(input(calls([[3000, "left_click", "text", "OK\nnow: Safari — \"Kevin Wiki\"; focused: AXTextField \"Search the wiki\"; 150 ms after the click"], [6000, "browser_type", "text", "typed hello\nnow: Safari — \"Kevin Wiki\"; focused: AXTextField \"Search the wiki\" = \"hello\"; 150 ms after the type"], [6100, "screenshot", "image"], [8000, "left_click", "question", "About to click Send — say yes"]])));
  assert.deepEqual([after.actingCalls, after.verificationShots, after.observedResults], [2, 1, 2]);
  const sBefore = summarize([before]);
  const sAfter = summarize([after]);
  assert.deepEqual(sBefore.verificationShots, { acting: 2, shots: 2, share: 1 });
  assert.deepEqual(sAfter.verificationShots, { acting: 2, shots: 1, share: 0.5 });
  assert.deepEqual(sAfter.observedResults, { acting: 2, withLine: 2, share: 1 });
  assert.equal(sAfter.generationsPerCommand.median, after.generations, "the same number as brainPath.overall.generations under the speed pass's name");
  const baseline = { meta: { startedAt: "2026-09-12T02:35:00.000Z" }, records: [before], summary: sBefore };
  const current = { meta: {}, records: [after], summary: sAfter };
  const cmp = compareReports(current, baseline, "docs/latency/after.json");
  assert.equal(cmp.baseline, "docs/latency/after.json");
  assert.equal(cmp.baselineStartedAt, "2026-09-12T02:35:00.000Z");
  assert.deepEqual(cmp.verificationShare, { before: 1, after: 0.5 });
  const row = cmp.rows.find((r) => r.cmd === "click-search-type");
  assert.ok(row);
  assert.equal(row.generations, after.generations - before.generations);
  assert.equal(row.doneMs, 0, "the same done time in both fixtures");
  assert.ok(cmp.rows.some((r) => r.cmd === "all"), "the overall row is compared too");
  const lines = renderReport({ ...current, compare: cmp });
  assert.ok(lines.some((l) => /acting calls followed by a verifying shot 1\/2 \(50 %, target ≤ 15 %\); acting results carrying a now: line 2\/2 \(100 %/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /against docs\/latency\/after\.json \(2026-09-12T02:35:00\.000Z\)/.test(l)));
  assert.ok(lines.some((l) => /verifying-shot share 100 % → 50 %/.test(l)));
  // An old baseline without the new summary fields still compares (its shares read as unknown).
  const old = compareReports(current, { meta: {}, records: [], summary: { ...sBefore, verificationShots: undefined, generationsPerCommand: undefined } as unknown as typeof sBefore }, "old.json");
  assert.equal(old.verificationShare.before, undefined);
  assert.equal(old.generationsP95.before, sBefore.brainPath.overall.generations.p95);
});
