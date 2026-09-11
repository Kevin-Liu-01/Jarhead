// Mock `window.jarhead` for previewing the renderer in a plain browser.
//
// Installed automatically by shared/bridge.js when the Electron preload has not
// provided a bridge. Everything here is scripted and fake; the shapes follow
// packages/protocol/src/index.ts exactly.
//
// URL knobs (all optional):
//   ?phase=speaking      pin the phase (no cycling)
//   ?scenario=empty      asleep, no session, nothing heard, no agents
//   ?scenario=quiet      listening, short transcript, no delegation
//   ?speed=2             run the script faster
//   ?expanded=1          (orb) start expanded
//   ?hold=1              (overlay) fire everything once and keep it on screen

const DEFAULT_SETTINGS = {
  voice: "cedar",
  brain: "claude-code",
  brainModel: "claude-opus-5",
  effort: "medium",
  idleSleepMinutes: 10,
  autoWake: true,
  wake: { enabled: true, phrases: ["jarhead", "jar head", "hey jarhead"], auth: "either" },
};

const PHASE_CYCLE = ["listening", "speaking", "thinking", "acting"];

let idCounter = 0;
const uid = (prefix) => `${prefix}_${(idCounter += 1).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function installMock(windowName) {
  const params = new URLSearchParams(location.search);
  const bridge = createMockBridge(windowName, params);
  window.jarhead = bridge;
  document.documentElement.classList.add("mock");
  console.info(`[jarhead mock] installed for "${windowName}"`, Object.fromEntries(params));
  return bridge;
}

export function createMockBridge(windowName, params = new URLSearchParams()) {
  const scenario = params.get("scenario") || "live";
  const pinnedPhase = params.get("phase");
  const speed = Math.max(0.1, Number(params.get("speed") || 1));
  const T0 = Date.now();

  const world = makeWorld(scenario, T0);
  if (pinnedPhase) world.phase = pinnedPhase;

  const listeners = new Set();
  const overlayListeners = new Set();
  let dirty = true;

  const emit = (event) => {
    for (const fn of listeners) fn(event);
  };
  const mark = () => {
    dirty = true;
  };
  const toast = (text, tone = "info") => emit({ type: "toast", text, tone });

  // snapshots ≤ 20 Hz
  setInterval(() => {
    if (!dirty) return;
    dirty = false;
    emit({ type: "snapshot", snapshot: snapshotOf(world) });
  }, 50);

  // usage ticks
  setInterval(() => {
    if (world.session && world.phase !== "asleep") {
      world.session = { ...world.session, usageSeconds: world.session.usageSeconds + 1 };
      mark();
    }
  }, 1000);

  // levels at 30 Hz
  const levelGen = makeLevelGen();
  setInterval(() => emit({ type: "levels", levels: levelGen(world.phase) }), 33);

  // phase cycle
  if (!pinnedPhase && scenario !== "empty") {
    let i = 0;
    setInterval(() => {
      if (world.userPhaseLock) return;
      i = (i + 1) % PHASE_CYCLE.length;
      world.phase = PHASE_CYCLE[i];
      mark();
    }, 4000 / speed);
  }

  if (scenario === "live" || scenario === "quiet") runScript(world, { mark, toast, speed, scenario });

  const bridge = {
    window: windowName,
    onEvent(fn) {
      listeners.add(fn);
      fn({ type: "snapshot", snapshot: snapshotOf(world) });
      return () => listeners.delete(fn);
    },
    send(command) {
      console.log("[jarhead.send]", command);
      applyCommand(world, command, { mark, toast, speed });
    },
    orbDrag(phase, screenX, screenY) {
      if (phase !== "move") console.log("[jarhead.orbDrag]", phase, screenX, screenY);
    },
    orbResize(width, height) {
      console.log("[jarhead.orbResize]", width, height);
    },
    onOverlay(fn) {
      overlayListeners.add(fn);
      return () => overlayListeners.delete(fn);
    },
    overlayBounds: async () => mockBounds(),
    openExternal(url) {
      console.log("[jarhead.openExternal]", url);
    },
    readLedger: async (date) => {
      await sleep(180);
      return ledgerFor(date, world);
    },
    ledgerDays: async () => {
      await sleep(120);
      return ledgerDays();
    },
    screenshotUrl: (path) => world.screens.get(path) ?? path,
  };

  if (windowName === "overlay") {
    startOverlayScript((cmd) => {
      for (const fn of overlayListeners) fn(cmd);
    }, params);
  }

  return bridge;
}

// ------------------------------------------------------------------ world ---

function makeWorld(scenario, T0) {
  const world = {
    phase: scenario === "empty" ? "asleep" : "listening",
    userPhaseLock: false,
    session:
      scenario === "empty"
        ? undefined
        : {
            id: "sess_7f3a9c2e41b0",
            startedAt: T0 - 14 * 60_000 - 22_000,
            expiresAt: T0 + 46 * 60_000,
            usageSeconds: 12 * 60 + 25,
            contextRatio: 0.31,
          },
    transcript: [],
    delegations: [],
    agents: scenario === "empty" ? [] : makeAgents(T0),
    connectors:
      scenario === "empty"
        ? [
            { kind: "claude-code", ok: true, detail: "No sessions found" },
            { kind: "herdr", ok: false, detail: "Not running" },
            { kind: "t3", ok: false, detail: "Not paired" },
          ]
        : [
            { kind: "claude-code", ok: true, detail: "3 sessions via ~/.claude" },
            { kind: "herdr", ok: true, detail: "ws://127.0.0.1:7421" },
            { kind: "t3", ok: false, detail: "Not paired — paste the code from T3 Code › Settings" },
          ],
    settings: { ...DEFAULT_SETTINGS },
    permissions:
      scenario === "empty"
        ? { microphone: "granted", screenRecording: "granted", accessibility: "granted" }
        : { microphone: "granted", screenRecording: "granted", accessibility: "denied" },
    problems: scenario === "empty" ? [] : ["Accessibility permission denied — hands can click but cannot read the UI tree."],
    brainReady: true,
    handsReady: scenario === "empty",
    screens: new Map(),
    T0,
  };
  return world;
}

function makeAgents(T0) {
  return [
    {
      id: "claude-code:s-9f3c1",
      kind: "claude-code",
      name: "jarvis · shell",
      status: "working",
      detail: "Editing renderer/console",
      cwd: "/Users/kevinliu/jarvis/packages/shell",
      updatedAt: T0 - 2 * 60_000,
    },
    {
      id: "claude-code:s-2ab77",
      kind: "claude-code",
      name: "kevin-wiki",
      status: "idle",
      detail: "Waiting for input",
      cwd: "/Users/kevinliu/Documents/GitHub/kevin-wiki",
      updatedAt: T0 - 31 * 60_000,
    },
    {
      id: "claude-code:s-11e0d",
      kind: "claude-code",
      name: "gt · api hotfix",
      status: "done",
      detail: "Opened PR #412",
      cwd: "/Users/kevinliu/gt/apps/api",
      updatedAt: T0 - 48 * 60_000,
    },
    {
      id: "herdr:w1:p1",
      kind: "herdr",
      name: "w1 · pane 1",
      status: "done",
      detail: "pnpm test — 84 passed",
      cwd: "/Users/kevinliu/gt/apps/api",
      updatedAt: T0 - 7 * 60_000,
    },
    {
      id: "herdr:w1:p2",
      kind: "herdr",
      name: "w1 · pane 2",
      status: "blocked",
      detail: "auth.spec.ts failing (expected 401, got 403)",
      cwd: "/Users/kevinliu/gt/apps/api",
      updatedAt: T0 - 6 * 60_000,
    },
    {
      id: "herdr:w2:p1",
      kind: "herdr",
      name: "w2 · pane 1",
      status: "unknown",
      detail: "No output for 40 min",
      cwd: "/Users/kevinliu/gt/packages/sdk",
      updatedAt: T0 - 40 * 60_000,
    },
    {
      id: "t3:thread-7d1e",
      kind: "t3",
      name: "Landing refresh",
      status: "offline",
      detail: "Connector not paired",
      cwd: "/Users/kevinliu/gt/apps/web",
      updatedAt: T0 - 2 * 3_600_000,
    },
  ];
}

function snapshotOf(world) {
  return {
    phase: world.phase,
    session: world.session ? { ...world.session } : undefined,
    transcript: world.transcript.slice(),
    delegations: world.delegations.slice(),
    agents: world.agents.slice(),
    connectors: world.connectors.slice(),
    settings: { ...world.settings },
    permissions: { ...world.permissions },
    problems: world.problems.slice(),
    brainReady: world.brainReady,
    handsReady: world.handsReady,
  };
}

// ----------------------------------------------------------------- levels ---

function makeLevelGen() {
  let input = 0.05;
  let output = 0;
  let t = 0;
  let burst = 0;
  return (phase) => {
    t += 1 / 30;
    // ambient mic noise, with speech bursts while listening
    if (phase === "listening") {
      if (burst <= 0 && Math.random() < 0.02) burst = 1 + Math.random() * 1.5;
      burst -= 1 / 30;
      const target = burst > 0 ? 0.35 + 0.35 * Math.abs(Math.sin(t * 9.3) * Math.sin(t * 2.1)) + Math.random() * 0.1 : 0.05 + Math.random() * 0.05;
      input += (target - input) * (target > input ? 0.55 : 0.18);
    } else if (phase === "asleep" || phase === "muted") {
      input += (0 - input) * 0.2;
    } else {
      input += (0.04 + Math.random() * 0.04 - input) * 0.2;
    }
    if (phase === "speaking") {
      const env = 0.45 + 0.4 * Math.abs(Math.sin(t * 6.7) * Math.sin(t * 1.3) + 0.3 * Math.sin(t * 17));
      const target = Math.random() < 0.08 ? 0.08 : Math.min(1, env + Math.random() * 0.12);
      output += (target - output) * (target > output ? 0.6 : 0.25);
    } else {
      output += (0 - output) * 0.25;
    }
    return { input: round3(input), output: round3(output) };
  };
}

const round3 = (v) => Math.round(Math.max(0, Math.min(1, v)) * 1000) / 1000;

// ----------------------------------------------------------------- script ---

function runScript(world, { mark, toast, speed, scenario }) {
  const sessionStart = world.session.startedAt;
  const offset = () => Date.now() - sessionStart;
  const timers = [];
  const at = (ms, fn) => timers.push(setTimeout(fn, ms / speed));

  const heard = (text, streamMs = 900) => streamUtterance(world, mark, "kevin", text, streamMs / speed, offset);
  const said = (text, streamMs = 1800) => streamUtterance(world, mark, "jarhead", text, streamMs / speed, offset);

  at(600, () => heard("Hey Jarhead, what's herdr doing on the auth branch?", 1300));
  at(1200, () => toast("Live session connected · cedar", "info"));
  at(2500, () =>
    said("Two panes are active. Pane two has been blocked for six minutes on a failing test in auth.spec.ts — want me to look?", 2600),
  );
  if (scenario === "quiet") return;

  at(5800, () => heard("Yeah, go ahead and fix it if it's obvious.", 1000));
  at(7200, () => said("On it.", 300));

  at(7600, () => {
    const d = createDelegation(world, mark, {
      request: "Kevin asked what herdr is doing on the auth branch and to fix pane two's failing test if it is obvious.",
      offsetMs: offset(),
    });
    // offsets below are relative to this callback (delegation creation), not script start
    const step = (ms, s) => at(ms, () => appendStep(world, mark, d.id, s));
    step(700, { kind: "thinking", text: "Checking which herdr panes are active and what pane two is stuck on…" });
    step(1400, {
      kind: "tool",
      tool: {
        name: "herdr.list",
        input: { workspace: "w1" },
        output: { panes: [{ id: "p1", status: "done" }, { id: "p2", status: "blocked", lastLine: "expected 401, received 403" }] },
        ok: true,
        ms: 212,
      },
    });
    step(2100, { kind: "commentary", text: "Pane two is blocked on a failing test. Let me look at the terminal." });
    step(2800, { kind: "screenshot", text: "Terminal — herdr w1 · pane 2", screenshotPath: screenshotPath(world, "herdr — w1 · pane 2", "#3a2b1e") });
    step(3500, { kind: "thinking", text: "The assertion expects 401 for a missing bearer token but the handler returns 403. One-line fix in auth.ts." });
    step(4200, {
      kind: "tool",
      tool: { name: "hands.click", input: { x: 1204, y: 388, label: "Run tests" }, output: { moved: true, clicked: true }, ok: true, ms: 640 },
    });
    step(4900, { kind: "confirm", text: "Change the missing-token status code in auth.ts from 403 to 401 and re-run the suite?" });
    at(4950, () => setDelegation(world, mark, d.id, { status: "awaiting-confirmation" }));
    at(5000, () => toast("Waiting for your confirmation", "warn"));
    at(7300, () => heard("Yes, do it.", 500));
    at(7900, () => {
      appendStep(world, mark, d.id, { kind: "note", text: "Kevin confirmed." });
      setDelegation(world, mark, d.id, { status: "running" });
    });
    step(8600, {
      kind: "tool",
      tool: {
        name: "agent.send",
        input: { agentId: "herdr:w1:p2", text: "In auth.ts, return 401 (not 403) when the bearer token is missing, then re-run auth.spec.ts." },
        output: { ok: true },
        ok: true,
        ms: 98,
      },
    });
    at(8650, () => setAgent(world, mark, "herdr:w1:p2", { status: "working", detail: "Applying fix from Jarhead" }));
    step(9300, { kind: "commentary", text: "Sent the fix to pane two. It's re-running the suite now." });
    at(10000, () =>
      setDelegation(world, mark, d.id, {
        status: "done",
        summary: "Diagnosed the blocked pane and dispatched a one-line fix to herdr w1 · pane 2.",
        timings: { doneAt: Date.now() },
      }),
    );
    at(10600, () => said("Done — pane two is green again. The handler now returns 401 for a missing bearer token.", 2400));
    at(11800, () => setAgent(world, mark, "herdr:w1:p2", { status: "done", detail: "auth.spec.ts — 12 passed" }));
  });

  at(24_500, () => heard("Nice. What's T3 up to?", 800));
  at(26_000, () => said("T3 Code isn't paired yet. Paste the pairing code from its settings into the console and I'll pick it up.", 2600));

  at(31_000, () => {
    const d = createDelegation(world, mark, {
      request: "Kevin asked what T3 Code is working on.",
      offsetMs: offset(),
    });
    at(700, () => appendStep(world, mark, d.id, { kind: "thinking", text: "Trying the T3 connector directly…" }));
    at(1400, () =>
      appendStep(world, mark, d.id, {
        kind: "tool",
        tool: { name: "t3.threads", input: {}, output: { error: "ECONNREFUSED 127.0.0.1:9330" }, ok: false, ms: 1204 },
      }),
    );
    at(2100, () => appendStep(world, mark, d.id, { kind: "error", text: "T3 Code connector is not paired; cannot list threads." }));
    at(2200, () => {
      setDelegation(world, mark, d.id, { status: "failed", summary: "T3 Code is not paired.", timings: { doneAt: Date.now() } });
      toast("Delegation failed: T3 Code not paired", "error");
    });
  });

  // keepalive so the feed never goes stale during a long preview
  at(60_000, () => {
    setInterval(() => {
      heard("Anything new?", 500);
      setTimeout(() => said("Still quiet. Pane two is green, nothing else moved.", 1800), 1400 / speed);
    }, 45_000 / speed);
  });
}

function streamUtterance(world, mark, speaker, text, durationMs, offset) {
  const id = uid("utt");
  const words = text.split(" ");
  const startMs = offset();
  const at = Date.now();
  let item = { id, speaker, text: "", startMs, endMs: startMs, at, final: false };
  world.transcript = [...world.transcript, item];
  mark();
  const perWord = Math.max(30, durationMs / Math.max(1, words.length));
  let i = 0;
  const tick = () => {
    i += 1;
    const done = i >= words.length;
    item = { ...item, text: words.slice(0, i).join(" "), endMs: offset(), final: done };
    world.transcript = world.transcript.map((t) => (t.id === id ? item : t));
    mark();
    if (!done) setTimeout(tick, perWord);
  };
  setTimeout(tick, perWord);
  return id;
}

function createDelegation(world, mark, { request, offsetMs }) {
  const now = Date.now();
  const d = {
    id: uid("dlg"),
    liveId: uid("live"),
    createdAt: now,
    offsetMs,
    request,
    status: "running",
    steps: [],
    timings: { delegatedAt: now },
  };
  world.delegations = [...world.delegations, d];
  mark();
  return d;
}

function appendStep(world, mark, delegationId, partial) {
  const now = Date.now();
  world.delegations = world.delegations.map((d) => {
    if (d.id !== delegationId) return d;
    const step = { id: uid("step"), at: now, ...partial };
    const timings = { ...d.timings };
    if (step.kind === "thinking" && !timings.firstThinkingAt) timings.firstThinkingAt = now;
    if (step.kind === "commentary" && !timings.firstCommentaryAt) timings.firstCommentaryAt = now;
    return { ...d, steps: [...d.steps, step], timings };
  });
  mark();
}

function setDelegation(world, mark, delegationId, patch) {
  world.delegations = world.delegations.map((d) =>
    d.id === delegationId ? { ...d, ...patch, timings: { ...d.timings, ...(patch.timings ?? {}) } } : d,
  );
  mark();
}

function setAgent(world, mark, agentId, patch) {
  world.agents = world.agents.map((a) => (a.id === agentId ? { ...a, ...patch, updatedAt: Date.now() } : a));
  mark();
}

// ------------------------------------------------------------- screenshot ---

function screenshotPath(world, title, tint) {
  const path = `screens/2026-09-10/${(143201 + world.screens.size).toString()}.png`;
  world.screens.set(path, fakeScreenshot(title, tint));
  return path;
}

function fakeScreenshot(title, tint = "#20263a") {
  const w = 640;
  const hgt = 400;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = hgt;
  const ctx = c.getContext("2d");
  const g = ctx.createLinearGradient(0, 0, w, hgt);
  g.addColorStop(0, "#151824");
  g.addColorStop(1, tint);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, hgt);
  // window chrome
  ctx.fillStyle = "rgba(255,255,255,0.05)";
  roundRect(ctx, 40, 36, w - 80, hgt - 72, 10);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.fillRect(40, 36, w - 80, 28);
  for (let i = 0; i < 3; i += 1) {
    ctx.fillStyle = ["#ff5f57", "#febc2e", "#28c840"][i];
    ctx.beginPath();
    ctx.arc(58 + i * 16, 50, 5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = "rgba(232,234,240,0.7)";
  ctx.font = "12px ui-monospace, Menlo, monospace";
  ctx.fillText(title, 120, 54);
  // fake terminal lines
  const lines = [
    ["$ pnpm test --filter api", 0.7],
    ["  ✓ auth.spec.ts › issues token (41 ms)", 0.55],
    ["  ✓ auth.spec.ts › rejects expired (12 ms)", 0.55],
    ["  ✕ auth.spec.ts › missing bearer → 401", 0.9],
    ["      expected 401, received 403", 0.9],
    ["", 0],
    ["Tests: 1 failed, 11 passed", 0.7],
  ];
  lines.forEach(([txt, a], i) => {
    ctx.fillStyle = i === 3 || i === 4 ? `rgba(255,93,108,${a})` : `rgba(232,234,240,${a})`;
    ctx.fillText(txt, 60, 96 + i * 20);
  });
  ctx.fillStyle = "rgba(90,215,255,0.9)";
  ctx.fillRect(60, 250, 8, 14);
  return c.toDataURL("image/png");
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// --------------------------------------------------------------- commands ---

function applyCommand(world, cmd, { mark, toast, speed }) {
  switch (cmd.type) {
    case "wake":
      if (!world.session) {
        world.session = { id: uid("sess"), startedAt: Date.now(), expiresAt: Date.now() + 3_600_000, usageSeconds: 0, contextRatio: 0 };
      }
      world.phase = "connecting";
      world.userPhaseLock = true;
      mark();
      setTimeout(() => {
        world.phase = "listening";
        world.userPhaseLock = false;
        mark();
        toast("Live session connected", "info");
      }, 1400 / speed);
      break;
    case "sleep":
      world.phase = "asleep";
      world.session = undefined;
      world.userPhaseLock = true;
      mark();
      break;
    case "mute":
      world.phase = "muted";
      world.userPhaseLock = true;
      mark();
      break;
    case "unmute":
      world.phase = "listening";
      world.userPhaseLock = false;
      mark();
      break;
    case "stop":
      world.delegations = world.delegations.map((d) =>
        d.status === "running" || d.status === "awaiting-confirmation"
          ? { ...d, status: "cancelled", timings: { ...d.timings, doneAt: Date.now() } }
          : d,
      );
      if (world.phase !== "asleep" && world.phase !== "muted") world.phase = "listening";
      mark();
      toast("Stopped", "warn");
      break;
    case "say-text": {
      const offset = () => Date.now() - (world.session?.startedAt ?? Date.now());
      streamUtterance(world, mark, "kevin", cmd.text, 200, offset);
      setTimeout(() => streamUtterance(world, mark, "jarhead", "Got it — give me a second to look at that.", 1400 / speed, offset), 900 / speed);
      break;
    }
    case "set-settings":
      world.settings = { ...world.settings, ...cmd.patch };
      mark();
      break;
    case "clear-problems":
      world.problems = [];
      mark();
      break;
    case "agent.send":
      world.agents = world.agents.map((a) => (a.id === cmd.agentId ? { ...a, status: "working", detail: `Prompt: ${cmd.text.slice(0, 40)}`, updatedAt: Date.now() } : a));
      mark();
      toast(`Sent to ${cmd.agentId}`, "info");
      break;
    case "agent.refresh":
      world.agents = world.agents.map((a) => ({ ...a, updatedAt: Date.now() }));
      mark();
      break;
    case "t3.pair":
      world.connectors = world.connectors.map((c) => (c.kind === "t3" ? { ...c, ok: true, detail: "Paired · 1 thread" } : c));
      world.agents = world.agents.map((a) => (a.kind === "t3" ? { ...a, status: "idle", detail: "Paired", updatedAt: Date.now() } : a));
      mark();
      toast("T3 Code paired", "info");
      break;
    case "request-permission":
      setTimeout(() => {
        world.permissions = { ...world.permissions, [cmd.which]: "granted" };
        if (cmd.which === "accessibility") world.handsReady = true;
        mark();
        toast(`${cmd.which} permission granted`, "info");
      }, 900 / speed);
      break;
    case "open-console":
    case "open-ledger":
      toast(`(mock) ${cmd.type}`, "info");
      break;
    default:
      break;
  }
}

// ----------------------------------------------------------------- ledger ---

function ledgerDays() {
  const days = [];
  const d = new Date();
  for (let i = 0; i < 4; i += 1) {
    const dt = new Date(d.getFullYear(), d.getMonth(), d.getDate() - i);
    days.push(`${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`);
  }
  return days;
}

function ledgerFor(dateString, world) {
  const [y, m, d] = dateString.split("-").map(Number);
  const base = new Date(y, m - 1, d, 9, 14, 3).getTime();
  const seed = (y * 31 + m * 7 + d) % 5;
  const sessionId = `sess_${dateString.replaceAll("-", "")}a`;
  const rows = [];
  let t = base;
  const push = (type, extra) => {
    rows.push({ at: t, type, ...extra });
  };
  const utter = (speaker, text, dur) => {
    const item = { id: uid("l"), speaker, text, startMs: t - base, endMs: t - base + dur, at: t, final: true };
    push(speaker === "kevin" ? "heard" : "said", { item });
    t += dur + 400;
  };

  push("session.started", { sessionId, voice: "cedar" });
  t += 2_000;
  utter("kevin", "Morning. What did the overnight build do?", 1800);
  utter("jarhead", "Main is green. The Electron packaging job passed for the first time since Tuesday.", 3200);
  t += 40_000;
  utter("kevin", "Pull up the herdr panes and tell me who's stuck.", 2100);
  t += 800;
  const delegation = {
    id: uid("dlg"),
    liveId: uid("live"),
    createdAt: t,
    offsetMs: t - base,
    request: "Kevin asked which herdr panes are stuck.",
    status: "running",
    steps: [],
    timings: { delegatedAt: t },
  };
  push("delegation.created", { delegation });
  const steps = [
    { kind: "thinking", text: "Listing panes across both workspaces…" },
    { kind: "tool", tool: { name: "herdr.list", input: { workspace: "*" }, output: { panes: 4, blocked: 1 }, ok: true, ms: 188 } },
    { kind: "commentary", text: "One pane is blocked: workspace two, pane one, waiting on a prompt." },
    { kind: "screenshot", text: "herdr — w2 · pane 1", screenshotPath: screenshotPath(world, "herdr — w2 · pane 1", "#1e2b3a") },
  ];
  const timings = { delegatedAt: t };
  steps.forEach((s, i) => {
    t += 640 + (i % 2) * 210;
    const step = { id: uid("step"), at: t, ...s };
    if (s.kind === "thinking" && !timings.firstThinkingAt) timings.firstThinkingAt = t;
    if (s.kind === "commentary" && !timings.firstCommentaryAt) timings.firstCommentaryAt = t;
    push("delegation.step", { delegationId: delegation.id, step });
  });
  t += 900;
  timings.doneAt = t;
  push("delegation.finished", { delegationId: delegation.id, status: "done", timings, summary: "Found one blocked pane (w2 · pane 1)." });
  t += 1_200;
  utter("jarhead", "Workspace two, pane one is waiting for you — it wants to know whether to delete the old migrations.", 3600);
  if (seed % 2 === 0) {
    t += 5_000;
    push("problem", { text: "Screen recording permission was revoked by the system." });
  }
  t += 3_000;
  push("agent", { agent: { id: "herdr:w2:p1", kind: "herdr", name: "w2 · pane 1", status: "blocked", detail: "Awaiting confirmation", cwd: "/Users/kevinliu/gt/packages/sdk", updatedAt: t } });
  t += 12 * 60_000;
  push("session.closed", { sessionId, reason: "idle", usageSeconds: 14 * 60 + 8 + seed * 37 });
  return rows;
}

// ---------------------------------------------------------------- overlay ---

function mockBounds() {
  // Pretend this window is a display sitting ABOVE the main one, so negative y
  // is in play and the global→local conversion is exercised.
  return { x: 0, y: -Math.round(innerHeight), w: innerWidth, h: innerHeight, scaleFactor: devicePixelRatio || 1 };
}

function startOverlayScript(emit, params) {
  const hold = params.get("hold") === "1";
  const ttl = (ms) => (hold ? 6_000_000 : ms);
  const run = () => {
    const b = mockBounds();
    const gx = (fx) => Math.round(b.x + b.w * fx);
    const gy = (fy) => Math.round(b.y + b.h * fy);
    const seq = [
      [0, { cmd: "clear" }],
      [300, { cmd: "point", x: gx(0.31), y: gy(0.42), label: "Run tests", ttlMs: ttl(5200) }],
      [1100, { cmd: "highlight", rect: { x: gx(0.5), y: gy(0.22), w: Math.round(b.w * 0.34), h: Math.round(b.h * 0.3) }, label: "auth.spec.ts · 1 failing", ttlMs: ttl(5000) }],
      [2000, { cmd: "path", from: { x: gx(0.31), y: gy(0.42) }, to: { x: gx(0.605), y: gy(0.66) }, ttlMs: ttl(4300) }],
      [2900, { cmd: "click-pulse", x: gx(0.605), y: gy(0.66) }],
      [3500, { cmd: "click-pulse", x: gx(0.605), y: gy(0.66) }],
    ];
    for (const [delay, cmd] of seq) setTimeout(() => emit(cmd), delay);
  };
  setTimeout(run, 200);
  if (!hold) setInterval(run, 7500);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
