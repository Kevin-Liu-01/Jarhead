import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { T3Client } from "../client.ts";
import { T3Connector, liveThreads, t3ThreadStatus, threadToAgentInfo, parseT3AgentId } from "../connector.ts";
import type { OrchestrationProject, OrchestrationReadModel, OrchestrationThread } from "../model.ts";
import { parsePairingInput } from "../pairing.ts";
import { FileT3TokenStore, MemoryT3TokenStore } from "../store.ts";
import type { T3Token } from "../store.ts";

// ------------------------------------------------------------------ fixtures ---

const NOW = Date.parse("2026-09-10T20:00:00.000Z");
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

const TOKEN: T3Token = { accessToken: "tok-123", tokenType: "Bearer", scope: "orchestration:read orchestration:operate", baseUrl: "http://127.0.0.1:3773", label: "Jarhead" };

const PROJECT: OrchestrationProject = {
  id: "proj-1",
  title: "jarvis",
  workspaceRoot: "/Users/kevinliu/jarvis",
  defaultModelSelection: { instanceId: "claudeAgent", model: "claude-fable-5", options: { effort: "high" } },
  deletedAt: null,
};

function thread(overrides: Partial<OrchestrationThread> & { id: string }): OrchestrationThread {
  return {
    projectId: "proj-1",
    title: `Thread ${overrides.id}`,
    modelSelection: { instanceId: "claudeAgent", model: "claude-fable-5" },
    runtimeMode: "auto-accept-edits",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: iso(-3_600_000),
    updatedAt: iso(-60_000),
    archivedAt: null,
    deletedAt: null,
    messages: [],
    activities: [],
    session: null,
    ...overrides,
  };
}

const T_RUNNING = thread({
  id: "t-running",
  latestTurn: { turnId: "turn-1", state: "running", startedAt: iso(-5_000), completedAt: null },
  session: { threadId: "t-running", status: "running", activeTurnId: "turn-1", lastError: null },
});
const T_BLOCKED = thread({
  id: "t-blocked",
  latestTurn: { turnId: "turn-2", state: "running", completedAt: null },
  session: { threadId: "t-blocked", status: "running", activeTurnId: "turn-2", lastError: null },
  activities: [
    { id: "a1", kind: "tool-call", summary: "ran tests", turnId: "turn-2" },
    { id: "a2", kind: "approval-request", summary: "Allow `rm -rf build`?", turnId: "turn-2" },
  ],
});
const T_DONE = thread({
  id: "t-done",
  latestTurn: { turnId: "turn-3", state: "completed", completedAt: iso(-120_000) },
  session: { threadId: "t-done", status: "ready", activeTurnId: null, lastError: null },
  messages: [
    { id: "m1", role: "user", text: "fix it", streaming: false },
    { id: "m2", role: "assistant", text: "Fixed the flaky test.\n", streaming: false },
  ],
});
const T_IDLE = thread({
  id: "t-idle",
  latestTurn: { turnId: "turn-4", state: "completed", completedAt: iso(-3_600_000) },
  session: { threadId: "t-idle", status: "idle", activeTurnId: null, lastError: null },
  worktreePath: "/Users/kevinliu/jarvis/.worktrees/idle",
});
const T_ERROR = thread({
  id: "t-error",
  latestTurn: { turnId: "turn-5", state: "error", completedAt: iso(-10_000) },
  session: { threadId: "t-error", status: "error", activeTurnId: null, lastError: "provider exploded" },
});
const T_ARCHIVED = thread({ id: "t-archived", archivedAt: iso(-1) });
const T_DELETED = thread({ id: "t-deleted", deletedAt: iso(-1) });

const SNAPSHOT: OrchestrationReadModel = {
  snapshotSequence: 10,
  projects: [PROJECT],
  threads: [T_RUNNING, T_BLOCKED, T_DONE, T_IDLE, T_ERROR, T_ARCHIVED, T_DELETED],
  updatedAt: iso(0),
};

const ENVIRONMENT = { environmentId: "9071c03b", label: "Kevin’s GT Pro", platform: { os: "darwin", arch: "arm64" }, serverVersion: "0.0.33", capabilities: {} };

// ---------------------------------------------------------------- fake fetch ---

interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

function fakeFetch(route: (req: Recorded) => Response | undefined): { fetch: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const req: Recorded = { url, method: init?.method ?? "GET", headers, body: typeof init?.body === "string" ? init.body : undefined };
    calls.push(req);
    const res = route(req);
    if (!res) throw new TypeError(`fetch failed: no route for ${req.method} ${url}`);
    return res;
  };
  return { fetch: impl as typeof fetch, calls };
}

const path = (url: string): string => new URL(url).pathname;

/** Routes that behave like a paired T3 server holding SNAPSHOT. */
function pairedRoutes(overrides: (req: Recorded) => Response | undefined = () => undefined) {
  return (req: Recorded): Response | undefined => {
    const custom = overrides(req);
    if (custom) return custom;
    const p = path(req.url);
    if (p === "/.well-known/t3/environment") return json(ENVIRONMENT);
    const auth = req.headers["authorization"];
    if (p === "/api/auth/session") return auth === "Bearer tok-123" ? json({ authenticated: true, scopes: ["orchestration:read"] }) : json({ authenticated: false });
    if (auth !== "Bearer tok-123") return json({ error: "unauthorized" }, 401);
    if (p === "/api/orchestration/snapshot") return json(SNAPSHOT);
    if (p === "/api/orchestration/shell") return json({ ...SNAPSHOT, threads: SNAPSHOT.threads.map(({ messages: _m, activities: _a, ...rest }) => rest) });
    if (p.startsWith("/api/orchestration/threads/")) {
      const id = decodeURIComponent(p.slice("/api/orchestration/threads/".length));
      const found = SNAPSHOT.threads.find((t) => t.id === id);
      return found ? json(found) : json({ error: "not found" }, 404);
    }
    if (p === "/api/orchestration/dispatch" && req.method === "POST") return json({ sequence: 11 });
    return undefined;
  };
}

let uuidCounter = 0;
const uuid = (): string => `uuid-${++uuidCounter}`;

function paired(overrides?: (req: Recorded) => Response | undefined) {
  const fake = fakeFetch(pairedRoutes(overrides));
  const client = new T3Client({ baseUrl: "http://127.0.0.1:3773", fetch: fake.fetch, tokenStore: new MemoryT3TokenStore(TOKEN), now: () => NOW, uuid });
  const connector = new T3Connector({ client, now: () => NOW, sleep: async () => {} });
  return { ...fake, client, connector };
}

// -------------------------------------------------------------------- pairing ---

test("t3 pairing: accepts pairing URLs (hash or query) and bare credentials", () => {
  assert.deepEqual(parsePairingInput("http://127.0.0.1:3773/pair#token=abc123"), { credential: "abc123", baseUrl: "http://127.0.0.1:3773" });
  assert.deepEqual(parsePairingInput("  http://localhost:3773/pair?token=q-1  "), { credential: "q-1", baseUrl: "http://localhost:3773" });
  assert.deepEqual(parsePairingInput("http://127.0.0.1:3773/pair#raw-fragment"), { credential: "raw-fragment", baseUrl: "http://127.0.0.1:3773" });
  assert.deepEqual(parsePairingInput("t3pair_abc.def"), { credential: "t3pair_abc.def" });
  assert.equal(parsePairingInput(""), undefined);
  assert.equal(parsePairingInput("   "), undefined);
  assert.equal(parsePairingInput("two words"), undefined);
  assert.equal(parsePairingInput("http://127.0.0.1:3773/pair"), undefined);
});

test("t3 client: pair posts the documented token-exchange form and stores the token", async () => {
  const store = new MemoryT3TokenStore();
  const fake = fakeFetch((req) =>
    path(req.url) === "/oauth/token" && req.method === "POST"
      ? json({ access_token: "at-1", issued_token_type: "urn:ietf:params:oauth:token-type:access_token", token_type: "Bearer", expires_in: 2_592_000, scope: "orchestration:read orchestration:operate" })
      : undefined,
  );
  const client = new T3Client({ baseUrl: "http://localhost:9999", fetch: fake.fetch, tokenStore: store, now: () => NOW });
  const result = await client.pair("http://127.0.0.1:3773/pair#token=cred-xyz");
  assert.equal(result.ok, true);

  const req = fake.calls[0];
  assert.ok(req);
  assert.equal(req.url, "http://127.0.0.1:3773/oauth/token");
  assert.equal(req.headers["content-type"], "application/x-www-form-urlencoded");
  const form = new URLSearchParams(req.body ?? "");
  assert.deepEqual(Object.fromEntries(form.entries()), {
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: "cred-xyz",
    subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    scope: "orchestration:read orchestration:operate",
    client_label: "Jarhead",
    client_os: "macOS",
  });
  assert.equal(form.has("client_device_type"), false);

  const stored = await store.load();
  assert.deepEqual(stored, {
    accessToken: "at-1",
    tokenType: "Bearer",
    scope: "orchestration:read orchestration:operate",
    expiresAt: NOW + 2_592_000 * 1000,
    baseUrl: "http://127.0.0.1:3773",
    label: "Jarhead",
  });
  assert.equal(client.baseUrl, "http://127.0.0.1:3773");
});

test("t3 client: a rejected pairing credential is a result, not a throw", async () => {
  const fake = fakeFetch(() => json({ error: "invalid_grant" }, 400));
  const client = new T3Client({ baseUrl: "http://127.0.0.1:3773", fetch: fake.fetch, tokenStore: new MemoryT3TokenStore() });
  const result = await client.pair("bad-cred");
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error.kind, "http");
  assert.equal(await client.tokenStore.load(), undefined);
  const nothing = await client.pair("");
  assert.equal(!nothing.ok && nothing.error.kind, "bad-input");
});

// --------------------------------------------------------------------- status ---

test("t3 status: session/turn/activity → AgentStatus", () => {
  assert.deepEqual(t3ThreadStatus(T_RUNNING, NOW), { status: "working" });
  assert.deepEqual(t3ThreadStatus(T_BLOCKED, NOW), { status: "blocked", detail: "Allow `rm -rf build`?" });
  assert.deepEqual(t3ThreadStatus(T_DONE, NOW), { status: "done" });
  assert.deepEqual(t3ThreadStatus(T_IDLE, NOW), { status: "idle" });
  assert.deepEqual(t3ThreadStatus(T_ERROR, NOW), { status: "unknown", detail: "provider exploded" });
  assert.deepEqual(t3ThreadStatus(thread({ id: "x", session: { threadId: "x", status: "starting" } }), NOW), { status: "working", detail: "starting" });
  assert.deepEqual(
    t3ThreadStatus(thread({ id: "y", latestTurn: { turnId: "t", state: "interrupted", completedAt: iso(-1_000) } }), NOW),
    { status: "idle", detail: "interrupted" },
  );
  // A resolved approval no longer blocks.
  const resolved = thread({
    ...T_BLOCKED,
    id: "z",
    activities: [...(T_BLOCKED.activities ?? []), { id: "a3", kind: "approval-response", turnId: "turn-2" }],
  });
  assert.equal(t3ThreadStatus(resolved, NOW).status, "working");
});

test("t3 mapping: threads → AgentInfo with project-qualified names and cwd", () => {
  const info = threadToAgentInfo(T_IDLE, PROJECT, NOW);
  assert.deepEqual(info, {
    id: "t3:t-idle",
    kind: "t3",
    name: "jarvis / Thread t-idle",
    status: "idle",
    cwd: "/Users/kevinliu/jarvis/.worktrees/idle",
    updatedAt: NOW - 60_000,
  });
  assert.equal(threadToAgentInfo(T_DONE, PROJECT, NOW).cwd, "/Users/kevinliu/jarvis");
  assert.equal(threadToAgentInfo(T_DONE, undefined, NOW).name, "Thread t-done");
  assert.deepEqual(liveThreads(SNAPSHOT).map((t) => t.id), ["t-running", "t-blocked", "t-done", "t-idle", "t-error"]);
  assert.equal(parseT3AgentId("t3:abc-123"), "abc-123");
  assert.equal(parseT3AgentId("herdr:w1:p1"), undefined);
  assert.equal(parseT3AgentId("t3:"), undefined);
});

// ------------------------------------------------------------------ connector ---

test("t3 connector: list maps the snapshot and skips archived/deleted threads", async () => {
  const { connector, calls } = paired();
  const infos = await connector.list();
  assert.deepEqual(
    infos.map((i) => [i.id, i.status]).sort(),
    [
      ["t3:t-blocked", "blocked"],
      ["t3:t-done", "done"],
      ["t3:t-error", "unknown"],
      ["t3:t-idle", "idle"],
      ["t3:t-running", "working"],
    ],
  );
  assert.equal(infos.find((i) => i.id === "t3:t-error")?.detail, "provider exploded");
  assert.equal(calls[0]?.headers["authorization"], "Bearer tok-123");
  assert.equal(path(calls[0]?.url ?? ""), "/api/orchestration/snapshot");
});

test("t3 connector: send starts a turn with the thread's own mode and model", async () => {
  const { connector, calls } = paired();
  const result = await connector.send("t3:t-done", "now add a regression test");
  assert.deepEqual(result, { accepted: true, detail: "turn started (sequence 11)" });

  assert.equal(path(calls[0]?.url ?? ""), "/api/orchestration/threads/t-done");
  assert.equal(new URL(calls[0]?.url ?? "").searchParams.get("turnLimit"), "1");
  const dispatch = calls[1];
  assert.ok(dispatch);
  assert.equal(path(dispatch.url), "/api/orchestration/dispatch");
  assert.equal(dispatch.headers["authorization"], "Bearer tok-123");
  assert.equal(dispatch.headers["content-type"], "application/json");
  const body = JSON.parse(dispatch.body ?? "{}") as Record<string, unknown>;
  assert.deepEqual(body, {
    type: "thread.turn.start",
    commandId: body["commandId"],
    threadId: "t-done",
    message: { messageId: body["message"] && (body["message"] as { messageId: string }).messageId, role: "user", text: "now add a regression test", attachments: [] },
    modelSelection: { instanceId: "claudeAgent", model: "claude-fable-5" },
    runtimeMode: "auto-accept-edits",
    interactionMode: "default",
    createdAt: "2026-09-10T20:00:00.000Z",
  });
  assert.match(String(body["commandId"]), /^uuid-\d+$/);
  assert.notEqual(body["commandId"], (body["message"] as { messageId: string }).messageId);
  await assert.rejects(() => connector.send("herdr:w1:p1", "x"), TypeError);
});

test("t3 connector: read returns the last assistant message", async () => {
  const { connector } = paired();
  assert.equal(await connector.read("t3:t-done"), "Fixed the flaky test.");
  assert.equal(await connector.read("t3:t-running"), "");
  await assert.rejects(() => connector.read("t3:missing"), /not found/);
});

test("t3 connector: start creates a thread in the project and sends the prompt", async () => {
  uuidCounter = 100;
  const { connector, calls } = paired();
  const info = await connector.start({ prompt: "Refactor the ledger\nand keep tests green", cwd: "/ignored" });
  const dispatches = calls.filter((c) => path(c.url) === "/api/orchestration/dispatch").map((c) => JSON.parse(c.body ?? "{}") as Record<string, unknown>);
  assert.equal(dispatches.length, 2);
  assert.deepEqual(dispatches[0], {
    type: "thread.create",
    commandId: "uuid-102",
    threadId: "uuid-101",
    projectId: "proj-1",
    title: "Refactor the ledger",
    modelSelection: { instanceId: "claudeAgent", model: "claude-fable-5", options: { effort: "high" } },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: "2026-09-10T20:00:00.000Z",
  });
  assert.equal(dispatches[1]?.["type"], "thread.turn.start");
  assert.equal(dispatches[1]?.["threadId"], "uuid-101");
  assert.deepEqual(info, {
    id: "t3:uuid-101",
    kind: "t3",
    name: "jarvis / Refactor the ledger",
    status: "working",
    cwd: "/Users/kevinliu/jarvis",
    updatedAt: NOW,
  });
  await assert.rejects(() => connector.start({ projectId: "nope" }), /project not found/);
});

test("t3 connector: interrupt targets the running turn", async () => {
  const { connector, calls } = paired();
  await connector.interrupt("t3:t-running");
  const body = JSON.parse(calls.at(-1)?.body ?? "{}") as Record<string, unknown>;
  assert.equal(body["type"], "thread.turn.interrupt");
  assert.equal(body["threadId"], "t-running");
  assert.equal(body["turnId"], "turn-1");
  await connector.interrupt("t3:t-done");
  const idle = JSON.parse(calls.at(-1)?.body ?? "{}") as Record<string, unknown>;
  assert.equal("turnId" in idle, false);
});

test("t3 connector: waitSettled polls until the turn stops running", async () => {
  let polls = 0;
  const sleeps: number[] = [];
  const fake = fakeFetch((req) => {
    if (path(req.url).startsWith("/api/orchestration/threads/")) {
      polls += 1;
      return json(polls < 3 ? T_RUNNING : { ...T_RUNNING, latestTurn: { turnId: "turn-1", state: "completed", completedAt: iso(0) }, session: { threadId: "t-running", status: "ready" } });
    }
    return undefined;
  });
  const client = new T3Client({ baseUrl: "http://127.0.0.1:3773", fetch: fake.fetch, tokenStore: new MemoryT3TokenStore(TOKEN), now: () => NOW });
  let t = NOW;
  const connector = new T3Connector({
    client,
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    pollMs: 1_500,
  });
  const info = await connector.waitSettled("t3:t-running", 30_000);
  assert.equal(info.status, "done");
  assert.equal(polls, 3);
  assert.deepEqual(sleeps, [1_500, 1_500]);
});

test("t3 connector: health distinguishes unreachable, unpaired, rejected and paired", async () => {
  const down = new T3Connector({ baseUrl: "http://127.0.0.1:3773", fetch: fakeFetch(() => undefined).fetch, tokenStore: new MemoryT3TokenStore() });
  const h1 = await down.health();
  assert.equal(h1.ok, false);
  assert.match(h1.detail, /not reachable at 127\.0\.0\.1:3773/);

  const unpaired = new T3Connector({ baseUrl: "http://127.0.0.1:3773", fetch: fakeFetch(pairedRoutes()).fetch, tokenStore: new MemoryT3TokenStore() });
  const h2 = await unpaired.health();
  assert.equal(h2.ok, false);
  assert.equal(h2.detail, "running at 127.0.0.1:3773 but not paired — run `jarhead t3 pair <url>`");
  assert.deepEqual(await unpaired.list(), []);
  assert.equal((await unpaired.send("t3:t-done", "x")).accepted, false);

  const stale = new T3Connector({
    baseUrl: "http://127.0.0.1:3773",
    fetch: fakeFetch(pairedRoutes((req) => (path(req.url) === "/api/auth/session" ? json({ error: "expired" }, 401) : undefined))).fetch,
    tokenStore: new MemoryT3TokenStore({ ...TOKEN, accessToken: "old" }),
  });
  const h3 = await stale.health();
  assert.equal(h3.ok, false);
  assert.match(h3.detail, /not paired/);
  assert.equal((await stale.client.tokenStore.load())?.accessToken, "old", "a 401 must not wipe the stored token");

  const { connector } = paired();
  const h4 = await connector.health();
  assert.equal(h4.ok, true);
  assert.equal(h4.detail, "paired as Jarhead, 5 threads (Kevin’s GT Pro, v0.0.33)");
});

// ---------------------------------------------------------------------- store ---

test("t3 store: file store round-trips, tolerates corruption, clears", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-t3-"));
  try {
    const store = FileT3TokenStore.inStateDir(dir);
    assert.equal(store.path, join(dir, "t3.json"));
    assert.equal(await store.load(), undefined);
    await store.save(TOKEN);
    assert.deepEqual(await store.load(), TOKEN);
    writeFileSync(store.path, "{not json");
    assert.equal(await store.load(), undefined);
    await store.save(TOKEN);
    await store.clear();
    assert.equal(await store.load(), undefined);
    await store.clear();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
