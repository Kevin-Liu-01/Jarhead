import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentInfo } from "@jarhead/protocol";
import { AsyncQueue } from "../../claude-code/queue.ts";
import type { PermissionDecision, SdkLike, SdkMessage, SdkUserMessage } from "../../claude-code/session.ts";
import { SessionsConnector, type SessionsConnectorOptions } from "../connector.ts";
import type { AgentProcess } from "../processes.ts";

/**
 * The send gate: `AgentInfo.send` says whether a line can go into a session now and how,
 * typed from the evidence `statusFor` and the runners' `canContinue` already read — the
 * Console's composer used to guess from cue words in `detail` ("read-only", "archived",
 * "not signed in"). And `SendResult.mode` names how an accepted line travelled (queue /
 * resume / answer) so the toast can say "Sent to Codex · queued" without parsing anything.
 * Fixtures are the anonymised shapes sessions.test.ts and codex.test.ts use; the Codex CLI
 * is the fake wrapper, so nothing here touches the real ~/.codex or spawns a real agent.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const S1 = "11111111-1111-4111-8111-111111111111";
const C1 = "01a0aaaa-0000-7000-8000-000000000001";
const C2 = "01a0bbbb-0000-7000-8000-000000000002"; // archived
const T = (iso: string): number => Date.parse(iso);
const NOW = T("2026-09-02T12:00:00.000Z");

interface Home {
  readonly home: string;
  readonly codexRoot: string;
  readonly fake: string;
  readonly s1: string;
  readonly c1: string;
  /** The folders the fixtures' sessions point at, made real under the temp home. */
  readonly cwd: { readonly claude: string; readonly codex: string };
  signIn(): void;
  cleanup(): void;
}

function makeHome(): Home {
  const home = mkdtempSync(join(tmpdir(), "jarhead-send-"));
  const claudeRoot = join(home, ".claude", "projects");
  const codexRoot = join(home, ".codex");
  cpSync(join(FIXTURES, "claude"), claudeRoot, { recursive: true });
  cpSync(join(FIXTURES, "codex"), codexRoot, { recursive: true });
  cpSync(join(FIXTURES, "claude-sessions"), join(home, ".claude", "sessions"), { recursive: true });
  const s1 = join(claudeRoot, "-Users-kevinliu-demo-app", `${S1}.jsonl`);
  const c1 = join(codexRoot, "sessions", "2026", "09", "01", `rollout-2026-09-01T09-00-00-${C1}.jsonl`);
  const cwd = { claude: join(home, "demo-app"), codex: join(home, "demo-site") };
  mkdirSync(cwd.claude);
  mkdirSync(cwd.codex);
  writeFileSync(s1, readFileSync(s1, "utf8").replaceAll("/Users/kevinliu/demo-app", cwd.claude));
  writeFileSync(c1, readFileSync(c1, "utf8").replaceAll("/Users/kevinliu/demo-site", cwd.codex));
  const touch = (path: string, whenMs: number): void => utimesSync(path, new Date(whenMs), new Date(whenMs));
  touch(s1, T("2026-09-01T10:01:00.000Z"));
  touch(c1, T("2026-09-01T09:05:00.000Z"));
  touch(join(codexRoot, "archived_sessions", `rollout-2026-08-30T12-00-00-${C2}.jsonl`), T("2026-08-30T12:01:00.000Z"));
  // The fake Codex CLI: a shell wrapper around this node, spawnable with an empty PATH.
  const bin = join(home, "fake-bin");
  mkdirSync(bin);
  const fake = join(bin, "codex");
  writeFileSync(fake, `#!/bin/sh\nexec "${process.execPath}" "${join(FIXTURES, "fake-codex.mjs")}" "$@"\n`);
  chmodSync(fake, 0o755);
  return {
    home,
    codexRoot,
    fake,
    s1,
    c1,
    cwd,
    signIn: () => writeFileSync(join(codexRoot, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { id_token: "id.x", access_token: "at.x", refresh_token: "rt.x", account_id: "acct" }, last_refresh: "2026-09-10T00:00:00Z" })),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

/** Discovery pinned to the temp home: an empty PATH and Applications folder, the fake as JARHEAD_CODEX_BIN. */
function connector(h: Home, over: { procs?: AgentProcess[]; sdk?: SdkLike; exec?: SessionsConnectorOptions["exec"]; codex?: boolean } = {}): SessionsConnector {
  const emptyBin = join(h.home, "empty-bin");
  mkdirSync(emptyBin, { recursive: true });
  return new SessionsConnector({
    home: h.home,
    now: () => NOW,
    ...(over.exec ? { exec: over.exec } : { processes: async () => over.procs ?? [] }),
    ...(over.sdk ? { sdk: over.sdk } : {}),
    processCacheMs: 0,
    pollMs: 30,
    settlePollMs: 10,
    settleQuietMs: 40,
    applicationsDir: join(h.home, "Applications"),
    cliSystemDirs: [],
    ...(over.codex === false ? {} : { codexBin: h.fake }),
    env: { PATH: emptyBin, HOME: h.home },
  });
}

const proc = (over: Partial<AgentProcess>): AgentProcess => ({ pid: 100, ppid: 1, startedAt: T("2026-09-01T09:00:00.000Z"), tool: "claude", command: "claude", cwd: "/Users/kevinliu/demo-app", interactive: true, sessionId: undefined, heldSessionIds: [], ...over });

/** Codex Desktop's app-server: cwd `/`, holding the rollouts it has open. */
const desktop = (held: string[]): AgentProcess => ({ pid: 4083, ppid: 686, startedAt: T("2026-08-31T00:00:00.000Z"), tool: "codex", command: "/Applications/ChatGPT.app/Contents/Resources/codex app-server", cwd: "/", interactive: false, sessionId: undefined, heldSessionIds: held });

type FakeSdk = SdkLike & { asked: number; decisions: PermissionDecision[] };

/** A scripted Claude: answers every turn; with `ask`, first requests permission for that tool through options.canUseTool. */
function fakeSdk(answer: string, ask?: { tool: string; input: Record<string, unknown> }): FakeSdk {
  const holder = { asked: 0, decisions: [] as PermissionDecision[] };
  return Object.assign(holder, {
    query({ prompt, options }: { prompt: AsyncIterable<SdkUserMessage>; options?: Record<string, unknown> }) {
      const out = new AsyncQueue<SdkMessage>();
      out.push({ type: "system", subtype: "init", session_id: String(options?.["resume"] ?? "new"), model: "claude-fable-5-1" });
      (async () => {
        for await (const _m of prompt) {
          await new Promise((r) => setTimeout(r, 10));
          let text = answer;
          if (ask) {
            const canUseTool = options?.["canUseTool"] as (t: string, i: Record<string, unknown>) => Promise<PermissionDecision>;
            holder.asked += 1;
            const d = await canUseTool(ask.tool, ask.input);
            holder.decisions.push(d);
            if (d.behavior === "deny") text = `refused: ${d.message}`;
          }
          out.push({ type: "assistant", parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text }] } });
          out.push({ type: "result", subtype: "success", is_error: false, result: text, total_cost_usd: 0.001 });
        }
        out.close();
      })();
      return Object.assign(out, { interrupt: async () => undefined });
    },
  }) as FakeSdk;
}

const gate = async (c: SessionsConnector, id: string): Promise<AgentInfo["send"]> => (await c.list()).find((a) => a.id === id)?.send;
const CODEX = `sessions:codex:${C1}`;
const CLAUDE = `sessions:claude:${S1}`;

test("send gate: a Codex thread open in Codex Desktop takes a queue; nobody holding it takes a resume; the send's mode says which", async () => {
  const h = makeHome();
  try {
    h.signIn();
    const open = connector(h, { procs: [desktop([C1])] });
    assert.deepEqual(await gate(open, CODEX), { ok: true, mode: "queue" });
    const queued = await open.send(CODEX, "also the footer");
    assert.equal(queued.accepted, true);
    assert.equal(queued.mode, "queue");
    assert.match(queued.detail ?? "", /queued into the open Codex thread/);

    const free = connector(h);
    assert.deepEqual(await gate(free, CODEX), { ok: true, mode: "resume" });
    const resumed = await free.send(CODEX, "hi");
    assert.deepEqual(resumed, { accepted: true, detail: "resumed headlessly", mode: "resume" });
    // While our own driver has it, the gate says so before the next listing's process snapshot could.
    assert.deepEqual(await gate(free, CODEX), { ok: true, mode: "resume" });
    await free.waitSettled(CODEX, 3_000);
    await free.closeAll();
  } finally {
    h.cleanup();
  }
});

test("send gate: refusals are typed with a short reason — archived, not signed in, Codex not installed, folder gone, degraded detection", async () => {
  const h = makeHome();
  try {
    // No auth.json: Codex cannot run anything, whoever holds the thread.
    const unsigned = connector(h);
    assert.deepEqual(await gate(unsigned, CODEX), { ok: false, reason: "Codex not signed in" });
    assert.deepEqual(await gate(connector(h, { procs: [desktop([C1])] }), CODEX), { ok: false, reason: "Codex not signed in" }, "a queue needs a CLI too");
    const refused = await unsigned.send(CODEX, "hi");
    assert.equal(refused.accepted, false);
    assert.equal(refused.mode, undefined, "a refusal has no mode");

    // No Codex on the machine at all.
    assert.deepEqual(await gate(connector(h, { codex: false }), CODEX), { ok: false, reason: "Codex not installed" });

    h.signIn();
    // Archived in Codex: the rail shows it done; nothing goes in.
    assert.deepEqual(await gate(connector(h), `sessions:codex:${C2}`), { ok: false, reason: "archived in Codex" });

    // The thread's folder is gone: a resume has nowhere to run.
    rmSync(h.cwd.codex, { recursive: true, force: true });
    assert.deepEqual(await gate(connector(h), CODEX), { ok: false, reason: "folder is gone" });
    mkdirSync(h.cwd.codex);

    // ps failed: nobody can say who owns anything, so nothing is resumed on a guess.
    const degraded = connector(h, { exec: async (file) => { throw new Error(`${file}: timed out`); } });
    assert.deepEqual(await gate(degraded, CODEX), { ok: false, reason: "cannot tell who owns it" });
    assert.deepEqual(await gate(degraded, CLAUDE), { ok: false, reason: "cannot tell who owns it" });
    assert.equal((await degraded.send(CODEX, "hi")).accepted, false);
  } finally {
    h.cleanup();
  }
});

test("send gate: a Claude Code session open in a terminal or Claude Desktop refuses (no queue there); a free one resumes; a yes to a resumed one asking Kevin is an answer", async () => {
  const h = makeHome();
  try {
    const before = T("2026-09-01T09:00:00.000Z"); // before the session's last write: owns the file by cwd
    const terminal = connector(h, { procs: [proc({ cwd: h.cwd.claude, interactive: true, startedAt: before })] });
    assert.deepEqual(await gate(terminal, CLAUDE), { ok: false, reason: "open in a terminal" });
    const busy = await terminal.send(CLAUDE, "also fix logout");
    assert.equal(busy.accepted, false);
    assert.match(busy.detail ?? "", /open in a terminal/);

    // pid 4242 is registered to S1 in ~/.claude/sessions/4242.json (Claude Desktop, not a terminal).
    const registered = connector(h, { procs: [proc({ pid: 4242, cwd: h.cwd.claude, interactive: false, startedAt: before })] });
    assert.deepEqual(await gate(registered, CLAUDE), { ok: false, reason: "open in Claude Desktop" });

    const sdk = fakeSdk("Cleaned.", { tool: "Bash", input: { command: "rm -rf build" } });
    const free = connector(h, { sdk });
    assert.deepEqual(await gate(free, CLAUDE), { ok: true, mode: "resume" });
    const sent = await free.send(CLAUDE, "clean the build");
    assert.deepEqual(sent, { accepted: true, detail: "resumed headlessly", mode: "resume" });
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && free.pendingPermission(CLAUDE) === undefined) await new Promise((r) => setTimeout(r, 10));
    assert.equal(free.pendingPermission(CLAUDE)?.toolName, "Bash");
    assert.deepEqual(await gate(free, CLAUDE), { ok: true, mode: "resume" }, "a question is open: the gate stays open (the composer's Allow/Deny reads pendingPermission); the SEND's mode says 'answer'");
    assert.deepEqual(await free.send(CLAUDE, "yes"), { accepted: true, detail: "allowed Bash", mode: "answer" });
    assert.equal((await free.waitSettled(CLAUDE, 3_000)).status, "idle");
    assert.deepEqual(sdk.decisions, [{ behavior: "allow" }]);
    assert.deepEqual(await gate(free, CLAUDE), { ok: true, mode: "resume" }, "answered: the next line is a turn on the resumed session");
    const next = await free.send(CLAUDE, "and lint");
    assert.deepEqual(next, { accepted: true, detail: "sent to the resumed session", mode: "resume" });
    await free.waitSettled(CLAUDE, 3_000);
    await free.closeAll();
  } finally {
    h.cleanup();
  }
});

test("send gate: computed for every listed agent, synchronously from the listing's own snapshot (no spawn, no extra await)", async () => {
  const h = makeHome();
  try {
    h.signIn();
    const c = connector(h, { procs: [desktop([C1])] });
    const list = await c.list();
    assert.ok(list.length >= 3);
    for (const a of list) assert.ok(a.send && typeof a.send.ok === "boolean", `${a.id} carries a gate`);
    const byId = new Map(list.map((a) => [a.id, a.send]));
    assert.deepEqual(byId.get(CODEX), { ok: true, mode: "queue" });
    assert.deepEqual(byId.get(`sessions:codex:${C2}`), { ok: false, reason: "archived in Codex" });
    assert.deepEqual(byId.get(CLAUDE), { ok: true, mode: "resume" });
  } finally {
    h.cleanup();
  }
});
