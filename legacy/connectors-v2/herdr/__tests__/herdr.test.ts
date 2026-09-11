import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentInfo } from "@jarhead/protocol";
import { runHerdr } from "../cli.ts";
import type { HerdrExec, HerdrExecResult } from "../cli.ts";
import { HerdrConnector, mapHerdrStatus, mergeAgentsAndPanes, paneToAgentInfo, parseHerdrAgentId } from "../connector.ts";
import type { HerdrPane } from "../connector.ts";
import { HerdrSocket, HerdrSocketError } from "../socket.ts";

// ------------------------------------------------------------------ fixtures ---
// Shapes copied from a herdr 0.7.4 headless session (`--session jarhead-test`).

const PANE_SHELL: HerdrPane = {
  agent_status: "unknown",
  cwd: "/Users/kevinliu/jarvis",
  foreground_cwd: "/Users/kevinliu/jarvis",
  pane_id: "w1:p1",
  tab_id: "w1:t1",
  terminal_id: "term_65b267925cb231",
  workspace_id: "w1",
};

const AGENT_CAT: HerdrPane = {
  agent_status: "working",
  cwd: "/Users/kevinliu/jarvis",
  foreground_cwd: "/Users/kevinliu/jarvis",
  name: "jarhead-cat",
  pane_id: "w1:p2",
  tab_id: "w1:t1",
  terminal_id: "term_65b267d9376842",
  workspace_id: "w1",
};

// `pane list` entries never carry the agent's name; only `agent list` does.
const { name: _agentName, ...PANE_CAT } = AGENT_CAT;

const OFFLINE_REFUSED = { code: 1, stderr: 'Error: Os { code: 61, kind: ConnectionRefused, message: "Connection refused" }\n' };
const OFFLINE_NO_SOCKET = { code: 1, stderr: 'Error: Os { code: 2, kind: NotFound, message: "No such file or directory" }\n' };

const envelope = (result: unknown): Partial<HerdrExecResult> => ({ code: 0, stdout: `${JSON.stringify({ id: "cli:test", result })}\n` });
const apiError = (code: string, message: string): Partial<HerdrExecResult> => ({
  code: 1,
  stdout: `${JSON.stringify({ id: "cli:test", error: { code, message } })}\n`,
});
const readResult = (paneId: string, source: string, text: string): Partial<HerdrExecResult> =>
  envelope({ type: "pane_read", read: { format: "text", pane_id: paneId, revision: 0, source, tab_id: "w1:t1", text, truncated: false, workspace_id: "w1" } });

type Script = (args: readonly string[]) => Partial<HerdrExecResult> | undefined;

function fakeExec(script: Script): { exec: HerdrExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: HerdrExec = async (_bin, args) => {
    calls.push([...args]);
    const r = script(args) ?? { code: 1, stderr: `fake herdr: no script for ${args.join(" ")}` };
    return {
      // `null` is a real value here (killed / failed to spawn), so no `??`.
      code: r.code === undefined ? 0 : r.code,
      signal: r.signal ?? null,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      ...(r.spawnError ? { spawnError: r.spawnError } : {}),
    };
  };
  return { exec, calls };
}

const startsWith = (args: readonly string[], ...prefix: string[]): boolean => prefix.every((p, i) => args[i] === p);

function connector(script: Script, extra: ConstructorParameters<typeof HerdrConnector>[0] = {}) {
  const fake = fakeExec(script);
  const c = new HerdrConnector({ bin: "/fake/herdr", exec: fake.exec, now: () => 1_000, sleep: async () => {}, ...extra });
  return { c, calls: fake.calls };
}

// -------------------------------------------------------------------- mapping ---

test("herdr: status mapping passes herdr's enum through and defaults to unknown", () => {
  for (const s of ["idle", "working", "blocked", "done", "unknown"] as const) assert.equal(mapHerdrStatus(s), s);
  assert.equal(mapHerdrStatus("offline"), "unknown");
  assert.equal(mapHerdrStatus(null), "unknown");
  assert.equal(mapHerdrStatus(undefined), "unknown");
});

test("herdr: agent id parsing keeps the colon inside herdr pane ids", () => {
  assert.equal(parseHerdrAgentId("herdr:w1:p2"), "w1:p2");
  assert.equal(parseHerdrAgentId("herdr:"), undefined);
  assert.equal(parseHerdrAgentId("t3:abc"), undefined);
  assert.equal(parseHerdrAgentId("w1:p2"), undefined);
});

test("herdr: pane → AgentInfo naming and details", () => {
  const shell = paneToAgentInfo(PANE_SHELL, 5, "pane");
  assert.deepEqual(shell, {
    id: "herdr:w1:p1",
    kind: "herdr",
    name: "jarvis",
    status: "unknown",
    detail: "no agent detected",
    cwd: "/Users/kevinliu/jarvis",
    updatedAt: 5,
  });
  const named = paneToAgentInfo(AGENT_CAT, 5, "agent");
  assert.equal(named.name, "jarhead-cat");
  assert.equal(named.status, "working");

  const detected = paneToAgentInfo({ ...PANE_SHELL, agent: "claude", agent_status: "blocked", state_labels: { blocked: "Needs approval" } }, 5, "pane");
  assert.equal(detected.name, "claude · jarvis");
  assert.equal(detected.status, "blocked");
  assert.equal(detected.detail, "Needs approval");

  const labelled = paneToAgentInfo({ ...PANE_SHELL, label: "probe-label" }, 5, "pane");
  assert.equal(labelled.name, "probe-label");
});

test("herdr: list merging prefers agent entries and adds agentless panes", () => {
  const infos = mergeAgentsAndPanes([AGENT_CAT], [PANE_SHELL, PANE_CAT], 7);
  assert.deepEqual(
    infos.map((i) => [i.id, i.name, i.status, i.detail]),
    [
      ["herdr:w1:p1", "jarvis", "unknown", "no agent detected"],
      ["herdr:w1:p2", "jarhead-cat", "working", undefined],
    ],
  );
});

// ------------------------------------------------------------------------ cli ---

test("herdr cli: parses envelopes, api errors and offline stderr", async () => {
  const { exec } = fakeExec((args) => {
    if (startsWith(args, "--session", "s1", "agent", "list")) return envelope({ type: "agent_list", agents: [] });
    if (startsWith(args, "agent", "get")) return apiError("agent_not_found", "agent target x not found");
    if (startsWith(args, "api", "snapshot")) return OFFLINE_REFUSED;
    if (startsWith(args, "pane", "list")) return OFFLINE_NO_SOCKET;
    if (startsWith(args, "pane", "read")) return { code: 0, stdout: "plain text\n" };
    return undefined;
  });
  const ok = await runHerdr(["agent", "list"], { exec, bin: "/fake", session: "s1" });
  assert.deepEqual(ok.result, { type: "agent_list", agents: [] });
  assert.equal(ok.error, undefined);

  const err = await runHerdr(["agent", "get", "x"], { exec, bin: "/fake" });
  assert.deepEqual(err.error, { code: "agent_not_found", message: "agent target x not found" });
  assert.equal(err.offline, undefined);

  const refused = await runHerdr(["api", "snapshot"], { exec, bin: "/fake", socketPath: "/tmp/h.sock" });
  assert.equal(refused.offline?.reason, "not-running");
  assert.match(refused.offline?.message ?? "", /not running.*\/tmp\/h\.sock/);

  const missing = await runHerdr(["pane", "list"], { exec, bin: "/fake" });
  assert.equal(missing.offline?.reason, "no-socket");

  const raw = await runHerdr(["pane", "read", "w1:p1"], { exec, bin: "/fake" });
  assert.equal(raw.json, undefined);
  assert.equal(raw.stdout, "plain text\n");
});

test("herdr cli: missing binary and SIGKILL timeout are offline results", async () => {
  const enoent = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }) as NodeJS.ErrnoException;
  const { exec } = fakeExec((args) => (args[0] === "api" ? { code: null, spawnError: enoent } : { code: null, signal: "SIGKILL" }));
  const missing = await runHerdr(["api", "snapshot"], { exec, bin: "/nope/herdr" });
  assert.equal(missing.offline?.reason, "no-binary");
  assert.match(missing.offline?.message ?? "", /\/nope\/herdr/);
  const hung = await runHerdr(["agent", "list"], { exec, bin: "/nope/herdr", timeoutMs: 50 });
  assert.equal(hung.offline?.reason, "timeout");
});

// ------------------------------------------------------------------ connector ---

test("herdr connector: offline health and empty list, never a throw", async () => {
  const { c } = connector(() => OFFLINE_REFUSED, { session: "jarhead-test" });
  const health = await c.health();
  assert.equal(health.ok, false);
  assert.equal(health.kind, "herdr");
  assert.match(health.detail, /not running/);
  assert.match(health.detail, /sessions\/jarhead-test\/herdr\.sock/);
  assert.deepEqual(await c.list(), []);
  const sent = await c.send("herdr:w1:p1", "hi");
  assert.equal(sent.accepted, false);
  assert.equal(await c.read("herdr:w1:p1"), "");
});

test("herdr connector: health summarises the snapshot", async () => {
  const { c, calls } = connector((args) =>
    startsWith(args, "api", "snapshot")
      ? envelope({ type: "session_snapshot", snapshot: { version: "0.7.4", protocol: 16, panes: [PANE_SHELL, PANE_CAT], agents: [AGENT_CAT], workspaces: [], tabs: [], layouts: [] } })
      : undefined,
  );
  assert.deepEqual(await c.health(), { kind: "herdr", ok: true, detail: "herdr 0.7.4: 1 agents, 2 panes" });
  assert.deepEqual(calls, [["api", "snapshot"]]);
});

test("herdr connector: list merges agent list with pane list", async () => {
  const { c, calls } = connector((args) => {
    if (startsWith(args, "--session", "jarhead-test", "agent", "list")) return envelope({ type: "agent_list", agents: [AGENT_CAT] });
    if (startsWith(args, "--session", "jarhead-test", "pane", "list")) return envelope({ type: "pane_list", panes: [PANE_SHELL, PANE_CAT] });
    return undefined;
  }, { session: "jarhead-test" });
  const infos = await c.list();
  assert.deepEqual(infos.map((i) => i.id), ["herdr:w1:p1", "herdr:w1:p2"]);
  assert.equal(infos[0]?.detail, "no agent detected");
  assert.equal(infos[1]?.name, "jarhead-cat");
  assert.equal(calls.length, 2);
});

test("herdr connector: send uses `pane run` so the text is submitted with Enter", async () => {
  const { c, calls } = connector((args) => (startsWith(args, "--session", "s", "pane", "run") ? { code: 0 } : undefined), { session: "s" });
  const result = await c.send("herdr:w1:p2", "fix the failing test");
  assert.equal(result.accepted, true);
  assert.deepEqual(calls, [["--session", "s", "pane", "run", "w1:p2", "fix the failing test"]]);
  await assert.rejects(() => c.send("t3:abc", "x"), TypeError);
});

test("herdr connector: send reports herdr's error without throwing", async () => {
  const { c } = connector(() => apiError("pane_not_found", "pane w9:p9 not found"));
  assert.deepEqual(await c.send("herdr:w9:p9", "x"), { accepted: false, detail: "herdr: pane_not_found: pane w9:p9 not found" });
});

test("herdr connector: read asks agent read for recent-unwrapped text and tails it", async () => {
  const { c, calls } = connector((args) => (startsWith(args, "agent", "read") ? readResult("w1:p2", "recent_unwrapped", "a\nb\nc\nd\n") : undefined));
  assert.equal(await c.read("herdr:w1:p2", { lines: 2 }), "c\nd");
  assert.deepEqual(calls, [["agent", "read", "w1:p2", "--source", "recent-unwrapped", "--lines", "2", "--format", "text"]]);
});

test("herdr connector: read retries with the visible screen when recent output is empty", async () => {
  const { c, calls } = connector((args) => {
    if (!startsWith(args, "agent", "read")) return undefined;
    return args.includes("visible") ? readResult("w1:p2", "visible", "prompt> done\n") : readResult("w1:p2", "recent_unwrapped", "");
  });
  assert.equal(await c.read("herdr:w1:p2"), "prompt> done");
  assert.deepEqual(calls.map((a) => a[4]), ["recent-unwrapped", "visible"]);
});

test("herdr connector: read falls back to raw `pane read` when agent read is refused", async () => {
  const { c, calls } = connector((args) => {
    if (startsWith(args, "agent", "read")) return apiError("agent_not_found", "agent target w1:p1 not found");
    if (startsWith(args, "pane", "read")) return { code: 0, stdout: "line1\nline2\n" };
    return undefined;
  });
  assert.equal(await c.read("herdr:w1:p1", { lines: 10 }), "line1\nline2");
  assert.deepEqual(calls[1], ["pane", "read", "w1:p1", "--source", "recent-unwrapped", "--lines", "10", "--format", "text"]);
});

test("herdr connector: waitSettled polls agent get until idle/blocked/done", async () => {
  const statuses = ["working", "working", "idle"];
  const sleeps: number[] = [];
  let t = 0;
  const { c, calls } = connector(
    (args) => (startsWith(args, "agent", "get") ? envelope({ type: "agent_info", agent: { ...AGENT_CAT, agent_status: statuses.shift() ?? "idle" } }) : undefined),
    {
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
      pollMs: 250,
    },
  );
  const info = await c.waitSettled("herdr:w1:p2", 10_000);
  assert.equal(info.status, "idle");
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [250, 250]);
});

test("herdr connector: waitSettled gives up at the deadline and reports the last status", async () => {
  let t = 0;
  const { c } = connector(
    (args) => (startsWith(args, "agent", "get") ? envelope({ type: "agent_info", agent: { ...AGENT_CAT, agent_status: "working" } }) : undefined),
    { now: () => t, sleep: async (ms) => void (t += ms), pollMs: 1_000 },
  );
  const info = await c.waitSettled("herdr:w1:p2", 2_500);
  assert.equal(info.status, "working");
  assert.ok(t >= 2_500);
});

test("herdr connector: interrupt sends Esc to agents and Ctrl+C to shells", async () => {
  const { c, calls } = connector((args) => {
    if (startsWith(args, "agent", "get", "w1:p2")) return envelope({ type: "agent_info", agent: AGENT_CAT });
    if (startsWith(args, "agent", "get", "w1:p1")) return apiError("agent_not_found", "agent target w1:p1 not found");
    if (startsWith(args, "pane", "get", "w1:p1")) return envelope({ type: "pane_info", pane: PANE_SHELL });
    if (startsWith(args, "pane", "send-keys")) return { code: 0 };
    return undefined;
  });
  await c.interrupt("herdr:w1:p2");
  await c.interrupt("herdr:w1:p1");
  const keys = calls.filter((a) => a[1] === "send-keys");
  assert.deepEqual(keys, [
    ["pane", "send-keys", "w1:p2", "escape"],
    ["pane", "send-keys", "w1:p1", "ctrl+c"],
  ]);
});

test("herdr connector: start builds `agent start <name> --cwd -- <argv>` and sends the prompt once idle", async () => {
  const started: HerdrPane = { ...AGENT_CAT, name: "fixer", pane_id: "w1:p3", agent_status: "unknown" };
  const { c, calls } = connector((args) => {
    if (startsWith(args, "agent", "start")) return envelope({ type: "agent_started", agent: started, argv: ["claude"] });
    if (startsWith(args, "agent", "get", "w1:p3")) return envelope({ type: "agent_info", agent: { ...started, agent: "claude", agent_status: "idle" } });
    if (startsWith(args, "pane", "run")) return { code: 0 };
    return undefined;
  });
  const info = await c.start({ name: "fixer", cwd: "/Users/kevinliu/jarvis", kind: "claude", prompt: "run the tests" });
  assert.equal(info.id, "herdr:w1:p3");
  assert.equal(info.name, "fixer");
  assert.equal(info.detail, "prompt sent");
  assert.deepEqual(calls[0], ["agent", "start", "fixer", "--cwd", "/Users/kevinliu/jarvis", "--no-focus", "--", "claude"]);
  assert.deepEqual(calls.at(-1), ["pane", "run", "w1:p3", "run the tests"]);
});

test("herdr connector: start while offline returns an offline AgentInfo", async () => {
  const { c } = connector(() => OFFLINE_NO_SOCKET);
  const info = await c.start({ kind: "codex --model gpt-5", name: "cx" });
  assert.equal(info.status, "offline");
  assert.equal(info.id, "herdr:cx");
});

// --------------------------------------------------------------------- socket ---

interface FakeHerdr {
  readonly path: string;
  readonly requests: { method: string; params: Record<string, unknown> }[];
  readonly streams: Socket[];
  push(event: unknown): void;
  close(): Promise<void>;
}

/** One request per connection, like the real server; `events.subscribe` stays open. */
function fakeHerdr(
  respond: (req: { id: string; method: string; params: Record<string, unknown> }) => unknown | undefined,
): Promise<FakeHerdr> {
  const dir = mkdtempSync(join(tmpdir(), "jh-herdr-"));
  const path = join(dir, "h.sock");
  const requests: FakeHerdr["requests"] = [];
  const streams: Socket[] = [];
  const server: Server = createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      buf = "";
      let req: { id: string; method: string; params: Record<string, unknown> };
      try {
        req = JSON.parse(line) as typeof req;
      } catch {
        socket.end(`${JSON.stringify({ id: "", error: { code: "invalid_request", message: "bad json" } })}\n`);
        return;
      }
      requests.push({ method: req.method, params: req.params });
      if (req.method === "events.subscribe") {
        streams.push(socket);
        socket.write(`${JSON.stringify({ id: req.id, result: { type: "subscription_started" } })}\n`);
        return;
      }
      const body = respond(req);
      if (body === undefined) return; // hang, for timeout tests
      socket.end(`${JSON.stringify({ id: req.id, ...(body as object) })}\n`);
    });
    socket.on("error", () => {});
  });
  return new Promise((resolve) => {
    server.listen(path, () =>
      resolve({
        path,
        requests,
        streams,
        push: (event) => {
          for (const s of streams) if (!s.destroyed) s.write(`${JSON.stringify(event)}\n`);
        },
        close: () =>
          new Promise<void>((done) => {
            for (const s of streams) s.destroy();
            server.close(() => {
              rmSync(dir, { recursive: true, force: true });
              done();
            });
          }),
      }),
    );
  });
}

async function waitFor(cond: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("herdr socket: request/response framing, errors and timeouts", async () => {
  const server = await fakeHerdr((req) => {
    if (req.method === "ping") return { result: { type: "pong", version: "0.7.4", protocol: 16 } };
    if (req.method === "agent.get") return { error: { code: "agent_not_found", message: `agent target ${String(req.params["target"])} not found` } };
    return undefined;
  });
  try {
    const sock = new HerdrSocket({ socketPath: server.path, requestTimeoutMs: 200 });
    const pong = await sock.request("ping");
    assert.equal(pong.ok, true);
    assert.deepEqual(pong.ok && pong.result, { type: "pong", version: "0.7.4", protocol: 16 });

    const missing = await sock.request("agent.get", { target: "nope" });
    assert.equal(missing.ok, false);
    assert.equal(!missing.ok && missing.error.code, "agent_not_found");

    await assert.rejects(
      () => sock.request("pane.list"),
      (err: unknown) => err instanceof HerdrSocketError && err.reason === "timeout",
    );
    assert.deepEqual(server.requests.map((r) => r.method), ["ping", "agent.get", "pane.list"]);
  } finally {
    await server.close();
  }
});

test("herdr socket: a missing socket is an offline error", async () => {
  const sock = new HerdrSocket({ socketPath: join(tmpdir(), "jh-definitely-missing.sock"), requestTimeoutMs: 200 });
  await assert.rejects(
    () => sock.request("ping"),
    (err: unknown) => err instanceof HerdrSocketError && err.reason === "offline",
  );
});

test("herdr socket: subscribe streams events until closed", async () => {
  const server = await fakeHerdr(() => undefined);
  try {
    const sock = new HerdrSocket({ socketPath: server.path, requestTimeoutMs: 500 });
    const events: string[] = [];
    const sub = await sock.subscribe([{ type: "pane.created" }, { type: "pane.agent_status_changed", pane_id: "w1:p1" }], (e) => events.push(e.event));
    assert.deepEqual(server.requests[0]?.params, {
      subscriptions: [{ type: "pane.created" }, { type: "pane.agent_status_changed", pane_id: "w1:p1" }],
    });
    server.push({ event: "pane_created", data: { type: "pane_created", pane: PANE_SHELL } });
    server.push({ event: "pane.agent_status_changed", data: { agent: "claude", agent_status: "working", pane_id: "w1:p1", workspace_id: "w1" } });
    await waitFor(() => events.length === 2);
    assert.deepEqual(events, ["pane_created", "pane.agent_status_changed"]);
    sub.close();
    await sub.closed;
  } finally {
    await server.close();
  }
});

test("herdr connector: subscribe seeds from the snapshot, translates events, and resubscribes for new panes", async () => {
  const server = await fakeHerdr((req) =>
    req.method === "session.snapshot"
      ? { result: { type: "session_snapshot", snapshot: { version: "0.7.4", protocol: 16, panes: [PANE_SHELL], agents: [], workspaces: [], tabs: [], layouts: [] } } }
      : undefined,
  );
  const c = new HerdrConnector({ bin: "/fake/herdr", socketPath: server.path, now: () => 42, reconnect: { minMs: 10, maxMs: 20 } });
  const seen: AgentInfo[] = [];
  const unsubscribe = c.subscribe((a) => seen.push(a));
  try {
    await waitFor(() => server.streams.length === 1);
    const first = server.requests.find((r) => r.method === "events.subscribe");
    assert.deepEqual(first?.params["subscriptions"], [
      { type: "pane.created" },
      { type: "pane.updated" },
      { type: "pane.closed" },
      { type: "pane.exited" },
      { type: "pane.agent_detected" },
      { type: "pane.agent_status_changed", pane_id: "w1:p1" },
    ]);

    server.push({ event: "pane_agent_detected", data: { agent: "claude", pane_id: "w1:p1", type: "pane_agent_detected", workspace_id: "w1" } });
    server.push({ event: "pane.agent_status_changed", data: { agent: "claude", agent_status: "working", pane_id: "w1:p1", workspace_id: "w1" } });
    await waitFor(() => seen.length === 2);
    assert.equal(seen[0]?.name, "claude · jarvis");
    assert.equal(seen[0]?.status, "unknown");
    assert.deepEqual(seen[1], { id: "herdr:w1:p1", kind: "herdr", name: "claude · jarvis", status: "working", detail: "claude", cwd: "/Users/kevinliu/jarvis", updatedAt: 42 });

    // A new pane needs its own status subscription: expect a second stream that names it.
    const created: HerdrPane = { ...PANE_SHELL, pane_id: "w1:p3", cwd: "/tmp/other", foreground_cwd: "/tmp/other" };
    server.push({ event: "pane_created", data: { type: "pane_created", pane: created } });
    await waitFor(() => seen.length === 3);
    assert.equal(seen[2]?.id, "herdr:w1:p3");
    assert.equal(seen[2]?.name, "other");
    await waitFor(() => server.requests.filter((r) => r.method === "events.subscribe").length === 2);
    const second = server.requests.filter((r) => r.method === "events.subscribe")[1];
    const specs = second?.params["subscriptions"] as { type: string; pane_id?: string }[];
    assert.deepEqual(
      specs.filter((s) => s.type === "pane.agent_status_changed").map((s) => s.pane_id),
      ["w1:p1", "w1:p3"],
    );

    server.push({ event: "pane_closed", data: { pane_id: "w1:p1", type: "pane_closed", workspace_id: "w1" } });
    await waitFor(() => seen.length === 4);
    assert.equal(seen[3]?.status, "offline");
    assert.equal(seen[3]?.name, "claude · jarvis");
    assert.equal(seen[3]?.detail, "pane closed");
  } finally {
    unsubscribe();
    await server.close();
  }
});

test("herdr connector: subscribe keeps retrying quietly while herdr is down and stops on unsubscribe", async () => {
  const c = new HerdrConnector({ bin: "/fake/herdr", socketPath: join(tmpdir(), "jh-no-herdr.sock"), reconnect: { minMs: 5, maxMs: 10 } });
  const seen: AgentInfo[] = [];
  const unsubscribe = c.subscribe((a) => seen.push(a));
  await new Promise((r) => setTimeout(r, 60));
  unsubscribe();
  assert.deepEqual(seen, []);
});
