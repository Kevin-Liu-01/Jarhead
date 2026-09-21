import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentInfo } from "@jarhead/protocol";
import { AgentRegistry } from "../../registry.ts";
import { cliCandidates, cliVersion, clearCliCache, findCli, notFoundText, parseVersion, readCodexAuth } from "../codex-bin.ts";
import { SessionsConnector, normalizeSessionTool, type SessionsConnectorOptions } from "../connector.ts";
import { classifyCommand, type AgentProcess } from "../processes.ts";
import { speakable } from "../runners/codex.ts";

/** A shared CI runner is slower and noisier than a Mac on a desk: its wall-clock ceilings are three times ours. The [measure] lines carry the real numbers either way. */
const RUNNER_SLACK = process.env["GITHUB_ACTIONS"] ? 3 : 1;

// ------------------------------------------------------------------ fixtures ---
// The Codex driver, exercised end to end against a fake `codex` (fixtures/fake-codex.mjs)
// that speaks the `codex exec --json` event shapes recorded from codex-cli 0.153.4 on
// Kevin's machine (fixtures/codex-exec-events.jsonl, fixtures/codex-exec-reconnect-events.jsonl),
// answers `--version` and `queue` the way the real one does (exit 0 whenever the rollout
// exists, daemon or not), and appends to the rollout like the real one. Discovery is pinned
// to the temp home, so the real ChatGPT.app copy is never touched.

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const C1 = "01a0aaaa-0000-7000-8000-000000000001";
const C2 = "01a0bbbb-0000-7000-8000-000000000002"; // archived
const SUB = "01a0cccc-0000-7000-8000-000000000003"; // sub-agent of C1
const AUTO = "01a0dddd-0000-7000-8000-000000000004"; // an automation run
const NEW_ID = "01a0ffff-0000-7000-8000-00000000c0de";
const T = (iso: string): number => Date.parse(iso);
const NOW = T("2026-09-02T12:00:00.000Z");

interface Home {
  readonly home: string;
  readonly codexRoot: string;
  readonly c1Path: string;
  /** A real folder standing in for the fixture thread's cwd. */
  readonly cwd: string;
  readonly fake: string;
  readonly log: string;
  logged(): { pid: number; args: string[]; cwd: string; codexHome: string | null; hasOpenAIKey: boolean }[];
  signIn(how?: "chatgpt" | "api-key"): void;
  lock(id: string): void;
  cleanup(): void;
}

function makeHome(): Home {
  const home = mkdtempSync(join(tmpdir(), "jarhead-codex-"));
  const codexRoot = join(home, ".codex");
  cpSync(join(FIXTURES, "codex"), codexRoot, { recursive: true });
  mkdirSync(join(home, ".claude", "projects"), { recursive: true });
  const c1Path = join(codexRoot, "sessions", "2026", "09", "01", `rollout-2026-09-01T09-00-00-${C1}.jsonl`);
  const cwd = join(home, "demo-site");
  mkdirSync(cwd);
  writeFileSync(c1Path, readFileSync(c1Path, "utf8").replaceAll("/Users/kevinliu/demo-site", cwd));
  for (const [p, when] of [
    [c1Path, "2026-09-01T09:05:00.000Z"],
    [join(codexRoot, "archived_sessions", `rollout-2026-08-30T12-00-00-${C2}.jsonl`), "2026-08-30T12:01:00.000Z"],
  ] as const) utimesSync(p, new Date(T(when)), new Date(T(when)));
  // The fake is a shell wrapper around this node, so it is spawnable with an empty PATH.
  const bin = join(home, "fake-bin");
  mkdirSync(bin);
  const fake = join(bin, "codex");
  writeFileSync(fake, `#!/bin/sh\nexec "${process.execPath}" "${join(FIXTURES, "fake-codex.mjs")}" "$@"\n`);
  chmodSync(fake, 0o755);
  const log = join(home, "codex-calls.jsonl");
  return {
    home,
    codexRoot,
    c1Path,
    cwd,
    fake,
    log,
    logged: () => (existsSync(log) ? (readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) as { pid: number; args: string[]; cwd: string; codexHome: string | null; hasOpenAIKey: boolean }[]) : []),
    signIn: (how = "chatgpt") =>
      writeFileSync(
        join(codexRoot, "auth.json"),
        how === "chatgpt"
          ? JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { id_token: "id.x", access_token: "at.x", refresh_token: "rt.x", account_id: "acct" }, last_refresh: "2026-09-10T00:00:00Z" })
          : JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-file", tokens: null }),
      ),
    lock: (id) => {
      mkdirSync(join(codexRoot, "thread-writer-locks"), { recursive: true });
      writeFileSync(join(codexRoot, "thread-writer-locks", `${id}.lock`), "");
    },
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

/** Discovery pinned to the temp home plus the fake as JARHEAD_CODEX_BIN; knobs go in env. */
function connector(h: Home, over: { procs?: AgentProcess[]; env?: Record<string, string>; opts?: Partial<SessionsConnectorOptions>; codexBin?: string | null } = {}): SessionsConnector {
  const emptyBin = join(h.home, "empty-bin");
  mkdirSync(emptyBin, { recursive: true });
  return new SessionsConnector({
    home: h.home,
    now: () => NOW, // the fixtures are dated 2026-09-01; the real clock left the 14-day window on 2026-09-15
    processes: async () => over.procs ?? [],
    processCacheMs: 0,
    pollMs: 30,
    settlePollMs: 10,
    settleQuietMs: 40,
    applicationsDir: join(h.home, "Applications"),
    cliSystemDirs: [],
    ...(over.codexBin === null ? {} : { codexBin: over.codexBin ?? h.fake }),
    env: { PATH: emptyBin, HOME: h.home, FAKE_CODEX_LOG: h.log, ...over.env },
    ...over.opts,
  });
}

const desktop = (held: string[]): AgentProcess => ({
  pid: 4083,
  ppid: 686,
  startedAt: T("2026-08-31T00:00:00.000Z"),
  tool: "codex",
  command: "/Applications/ChatGPT.app/Contents/Resources/codex -c features.code_mode_host=true app-server --analytics-default-enabled",
  cwd: "/",
  interactive: false,
  sessionId: undefined,
  heldSessionIds: held,
});

async function until(check: () => boolean, ms = 3_000, what = "condition"): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const ID1 = `sessions:codex:${C1}`;

// ---------------------------------------------------------------- discovery ---

test("findCli: JARHEAD_CODEX_BIN, then PATH, then ChatGPT.app, Codex.app, ~/.codex/bin, nvm, ~/.bun/bin, ~/.local/bin", async () => {
  const home = mkdtempSync(join(tmpdir(), "jarhead-findcli-"));
  try {
    const apps = join(home, "Applications");
    const pathDir = join(home, "on-path");
    const install = (path: string): string => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "#!/bin/sh\necho codex-cli 9.9.9\n");
      chmodSync(path, 0o755);
      return path;
    };
    const opts = { env: { PATH: `${pathDir}:${join(home, "also-on-path")}` }, home, applicationsDir: apps, systemDirs: [] };
    assert.equal(await findCli("codex", opts), undefined);
    assert.equal(await notFoundText("codex", opts), "codex not found: looked in JARHEAD_CODEX_BIN (unset), PATH, ChatGPT.app, Codex.app, ~/.codex/bin, ~/.bun/bin, ~/.local/bin");

    const local = install(join(home, ".local", "bin", "codex"));
    assert.deepEqual(await findCli("codex", opts), { tool: "codex", path: local, origin: "~/.local/bin" });
    const bun = install(join(home, ".bun", "bin", "codex"));
    assert.equal((await findCli("codex", opts))?.path, bun);
    mkdirSync(join(home, ".nvm", "versions", "node", "v22.1.0", "bin"), { recursive: true });
    const nvm = install(join(home, ".nvm", "versions", "node", "v24.13.0", "bin", "codex"));
    assert.deepEqual(await findCli("codex", opts), { tool: "codex", path: nvm, origin: "nvm" }, "the newest node's bin, before ~/.bun/bin");
    const codexBin = install(join(home, ".codex", "bin", "codex"));
    assert.equal((await findCli("codex", opts))?.path, codexBin);
    const codexApp = install(join(apps, "Codex.app", "Contents", "Resources", "codex"));
    assert.deepEqual(await findCli("codex", opts), { tool: "codex", path: codexApp, origin: "Codex.app" });
    const chatgpt = install(join(apps, "ChatGPT.app", "Contents", "Resources", "codex"));
    assert.deepEqual(await findCli("codex", opts), { tool: "codex", path: chatgpt, origin: "ChatGPT.app" }, "the copy Codex Desktop ships beats a stand-alone Codex.app");
    const onPath = install(join(pathDir, "codex"));
    assert.deepEqual(await findCli("codex", opts), { tool: "codex", path: onPath, origin: "PATH" });
    const override = install(join(home, "somewhere", "codex"));
    const withOverride = { ...opts, env: { ...opts.env, JARHEAD_CODEX_BIN: override } };
    assert.deepEqual(await findCli("codex", withOverride), { tool: "codex", path: override, origin: "JARHEAD_CODEX_BIN" });
    assert.match(await notFoundText("codex", withOverride), /^codex not found: looked in JARHEAD_CODEX_BIN, PATH, /, "a set override is named without '(unset)'");
    const tilde = { ...opts, env: { ...opts.env, JARHEAD_CODEX_BIN: "~/somewhere/codex" } };
    assert.equal((await findCli("codex", tilde))?.path, override, "~ in the override is the home");
    const notExec = join(home, "plain", "codex");
    mkdirSync(dirname(notExec));
    writeFileSync(notExec, "not executable");
    assert.equal((await findCli("codex", { ...opts, env: { PATH: join(home, "plain") } }))?.origin, "ChatGPT.app", "a non-executable file on PATH does not count");

    const claudeOpts = { env: { PATH: pathDir }, home, applicationsDir: apps, systemDirs: [] };
    assert.equal(await notFoundText("claude", claudeOpts), "claude not found: looked in JARHEAD_CLAUDE_BIN (unset), PATH, ~/.local/bin, ~/.claude/local, nvm, ~/.bun/bin", "the nvm dirs made above are searched for every tool");
    const claude = install(join(home, ".local", "bin", "claude"));
    assert.deepEqual(await findCli("claude", claudeOpts), { tool: "claude", path: claude, origin: "~/.local/bin" });
    const cands = await cliCandidates("cursor-agent", { env: { PATH: pathDir }, home, applicationsDir: apps });
    assert.deepEqual(cands.map((c) => c.origin), ["PATH", "~/.local/bin", "nvm", "nvm", "~/.bun/bin", "homebrew", "/usr/local/bin"], "the default system dirs, one entry per path (both nvm versions made above)");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("cliVersion: parsed, capped at the timeout, cached per path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarhead-version-"));
  try {
    assert.equal(parseVersion("codex-cli 0.153.4\n"), "0.153.4");
    assert.equal(parseVersion("2.1.263 (Claude Code)"), "2.1.263");
    assert.equal(parseVersion("1.2.3-beta.4"), "1.2.3-beta.4");
    assert.equal(parseVersion("no version here"), undefined);
    const calls: string[] = [];
    const exec = async (file: string, args: readonly string[], timeoutMs: number): Promise<string> => {
      calls.push(`${file} ${args.join(" ")} ${timeoutMs}`);
      if (file.endsWith("hangs")) return new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 20));
      return "codex-cli 0.153.4";
    };
    clearCliCache();
    assert.equal(await cliVersion(join(dir, "codex"), { exec }), "0.153.4");
    assert.equal(await cliVersion(join(dir, "codex"), { exec }), "0.153.4");
    assert.deepEqual(calls, [`${join(dir, "codex")} --version 3000`], "second call served from the cache");
    assert.equal(await cliVersion(join(dir, "hangs"), { exec, timeoutMs: 10 }), undefined, "a hang is no version, not an error");
    clearCliCache();
    // The real thing, through the fake: an actual child with the default 3 s cap.
    const fake = join(dir, "fake-codex");
    writeFileSync(fake, `#!/bin/sh\nexec "${process.execPath}" "${join(FIXTURES, "fake-codex.mjs")}" "$@"\n`);
    chmodSync(fake, 0o755);
    assert.equal(await cliVersion(fake), "0.153.4");
    clearCliCache();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readCodexAuth: tokens, api key in the file, api key in the environment, and the exact reason when neither", async () => {
  const h = makeHome();
  try {
    assert.deepEqual(await readCodexAuth(h.codexRoot, {}), { signedIn: false, how: undefined, reason: "not signed in (~/.codex/auth.json missing)" });
    assert.deepEqual(await readCodexAuth(h.codexRoot, { OPENAI_API_KEY: "sk-env" }), { signedIn: true, how: "env-key", reason: undefined }, "an environment key signs in even without the file");
    h.signIn("chatgpt");
    assert.deepEqual(await readCodexAuth(h.codexRoot, { OPENAI_API_KEY: "sk-env" }), { signedIn: true, how: "chatgpt", reason: undefined }, "the ChatGPT login is what Codex will use");
    h.signIn("api-key");
    assert.deepEqual(await readCodexAuth(h.codexRoot, {}), { signedIn: true, how: "api-key", reason: undefined });
    writeFileSync(join(h.codexRoot, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "" } }));
    assert.deepEqual(await readCodexAuth(h.codexRoot, {}), { signedIn: false, how: undefined, reason: "not signed in (no tokens in ~/.codex/auth.json)" });
    writeFileSync(join(h.codexRoot, "auth.json"), "{ not json");
    assert.deepEqual(await readCodexAuth(h.codexRoot, {}), { signedIn: false, how: undefined, reason: "not signed in (~/.codex/auth.json is not valid JSON)" });
  } finally {
    h.cleanup();
  }
});

test("speakable: fenced code, inline code, emphasis, headings, links and bullets read out loud", () => {
  assert.equal(speakable("Done: **all green**."), "Done: all green.");
  assert.equal(speakable("## Summary\n\n- Fixed the *login* redirect\n- Ran `pnpm test`\n\n```sh\npnpm test\n```\nSee [the PR](https://example.com/pr/1)."), "Summary\nFixed the login redirect\nRan pnpm test\n(code)\nSee the PR.");
  assert.equal(speakable("a_b_c stays, and 2 * 3 stays"), "a_b_c stays, and 2 * 3 stays");
  assert.equal(normalizeSessionTool("Claude Code"), "claude");
  assert.equal(normalizeSessionTool("codex"), "codex");
  assert.equal(normalizeSessionTool("gemini"), undefined);
});

// ------------------------------------------------------------------- health ---

test("health(): the Codex line tells the truth — version and origin, login, desktop app, thread count; and the exact reason otherwise", async () => {
  const h = makeHome();
  // The thread count is what the 14-day window (DEFAULT_MAX_AGE_DAYS) holds at `now`: the fixtures are dated
  // 2026-09-01 (C1) and 2026-08-30 (the archived C2), so this test's clock is pinned three days after them —
  // on Date.now the archived one fell out of the window on 2026-09-13 and the line read "1 thread".
  const clock = { opts: { now: () => T("2026-09-04T12:00:00.000Z") } };
  try {
    const notSignedIn = connector(h, { procs: [], ...clock });
    const a = await notSignedIn.health();
    assert.equal(a.ok, true, "the session store is listable");
    assert.equal(a.detail.split(" | ")[0], "Codex 0.153.4 (JARHEAD_CODEX_BIN) · not signed in (~/.codex/auth.json missing) · desktop app not running · 2 threads");

    h.signIn();
    const signedIn = connector(h, { procs: [desktop([C1])], ...clock });
    const b = await signedIn.health();
    assert.equal(b.detail.split(" | ")[0], "Codex 0.153.4 (JARHEAD_CODEX_BIN) · signed in · desktop app running · 2 threads");
    assert.equal(b.detail.split(" | ")[1], "claude not found: looked in JARHEAD_CLAUDE_BIN (unset), PATH, ~/.local/bin, ~/.claude/local, ~/.bun/bin · 0 sessions", "an empty ~/.claude/projects is a store with nothing in it");

    h.signIn("api-key");
    assert.match((await connector(h, clock).health()).detail, /^Codex 0\.153\.4 \(JARHEAD_CODEX_BIN\) · signed in \(API key\) · desktop app not running · 2 threads/);
    rmSync(join(h.codexRoot, "auth.json"));
    assert.match((await connector(h, { env: { OPENAI_API_KEY: "sk-env" }, ...clock }).health()).detail, /^Codex 0\.153\.4 \(JARHEAD_CODEX_BIN\) · signed in \(OPENAI_API_KEY from the environment\) · /, "Jarhead's own key would be what Codex uses; say so");

    const missing = connector(h, { codexBin: null, ...clock });
    const c = await missing.health();
    assert.equal(c.detail.split(" | ")[0], "codex not found: looked in JARHEAD_CODEX_BIN (unset), PATH, ChatGPT.app, Codex.app, ~/.codex/bin, ~/.bun/bin, ~/.local/bin · desktop app not running · 2 threads");

    // No stores at all, but a signed-in Codex: still ok, because threads can be started.
    const bare = mkdtempSync(join(tmpdir(), "jarhead-bare-"));
    try {
      mkdirSync(join(bare, ".codex"));
      writeFileSync(join(bare, ".codex", "auth.json"), JSON.stringify({ tokens: { access_token: "x" } }));
      const startable = new SessionsConnector({ home: bare, processes: async () => [], codexBin: h.fake, env: { PATH: join(bare, "nope"), HOME: bare }, applicationsDir: join(bare, "Applications"), cliSystemDirs: [] });
      const d = await startable.health();
      assert.equal(d.ok, true);
      assert.match(d.detail, /^no Claude Code or Codex session store under .* \| Codex 0\.153\.4 \(JARHEAD_CODEX_BIN\) · signed in · desktop app not running · no threads yet \| claude not found/);
      assert.deepEqual(await startable.list(), []);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  } finally {
    h.cleanup();
  }
});

// -------------------------------------------------------------------- send() ---

test("send(): refuses with the reason when codex is missing or not signed in; archived threads stay archived", async () => {
  const h = makeHome();
  try {
    const missing = connector(h, { codexBin: null });
    const a = await missing.send(ID1, "hi");
    assert.equal(a.accepted, false);
    assert.equal(a.detail, "codex not found: looked in JARHEAD_CODEX_BIN (unset), PATH, ChatGPT.app, Codex.app, ~/.codex/bin, ~/.bun/bin, ~/.local/bin");

    const noLogin = connector(h);
    const b = await noLogin.send(ID1, "hi");
    assert.deepEqual(b, { accepted: false, detail: "Codex is not signed in (~/.codex/auth.json missing)" });

    h.signIn();
    const c = connector(h);
    const archived = await c.send(`sessions:codex:${C2}`, "hi");
    assert.deepEqual(archived, { accepted: false, detail: "that Codex thread is archived; unarchive it in Codex first" });
    assert.deepEqual(h.logged(), [], "nothing was spawned for any of these");
  } finally {
    h.cleanup();
  }
});

test("send(): nobody owns the thread → `codex exec resume` in the thread's cwd; status, reply, read(), a second turn, closeAll()", async () => {
  const h = makeHome();
  try {
    h.signIn();
    const c = connector(h, { env: { OPENAI_API_KEY: "sk-jarhead-voice", FAKE_CODEX_DELAY_MS: "150", FAKE_CODEX_REPLY: "Switched **{prompt}** to DM Sans.\n\n```css\nfont-family: 'DM Sans';\n```" } });
    const seen: AgentInfo[] = [];
    const stop = c.subscribe((a) => seen.push(a));
    const listed = (await c.list()).find((a) => a.id === ID1);
    assert.equal(listed?.status, "ended", "before: a finished thread, no process on it");

    const sent = await c.send(ID1, "the hero");
    assert.deepEqual(sent, { accepted: true, detail: "resumed headlessly", mode: "resume" });
    const working = (await c.list()).find((a) => a.id === ID1);
    assert.equal(working?.status, "working");
    assert.equal(working?.detail, "codex · 3 msgs · demo-site · resumed: thinking");
    assert.match(await c.read(ID1), /\nSwitched the hero heading to DM Sans and rebuilt\.$/, "while working, the thread's last answer stands");

    const settled = await c.waitSettled(ID1, 3_000);
    assert.equal(settled.status, "idle");
    assert.equal(settled.detail, "codex · 3 msgs · demo-site · resumed by Jarhead");
    assert.match(await c.read(ID1), /\nSwitched the hero to DM Sans\.\n\(code\)$/, "the reply, made speakable");

    const calls = h.logged();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.args, ["exec", "resume", "--json", "--skip-git-repo-check", "-c", 'sandbox_mode="workspace-write"', "--", C1, "the hero"], "resume has no -C/-s: cwd on the spawn, sandbox through config, positionals after --");
    assert.equal(calls[0]?.cwd, realpathSync(h.cwd), "spawned in the thread's own folder");
    assert.equal(calls[0]?.codexHome, h.codexRoot, "a non-default root reaches the child as CODEX_HOME");
    assert.equal(calls[0]?.hasOpenAIKey, false, "Jarhead's voice key is kept away from a ChatGPT-signed-in Codex");

    // The fake appended the turn to the rollout, as the real one does: the store sees it too.
    const fresh = await c.codex.find(C1);
    assert.equal(fresh?.messageCount, 5);
    assert.match(fresh?.lastAssistantText ?? "", /^Switched \*\*the hero\*\* to DM Sans/);

    const again = await c.send(ID1, "and the footer");
    assert.deepEqual(again, { accepted: true, detail: "sent to the resumed session", mode: "resume" });
    assert.equal((await c.waitSettled(ID1, 3_000)).status, "idle");
    assert.equal(h.logged().length, 2, "each turn is its own codex exec");
    assert.equal(h.logged()[1]?.args[8], "and the footer");
    assert.match(await c.read(ID1), /Switched and the footer to DM Sans/);
    assert.ok(seen.some((a) => a.id === ID1 && a.status === "working"), "status changes reach subscribers");
    assert.ok(seen.some((a) => a.id === ID1 && a.status === "idle"));
    stop();
    await c.closeAll();
    const closed = (await c.list()).find((a) => a.id === ID1);
    assert.ok(closed && closed.status !== "idle" && closed.status !== "working", `closed: the file is the only signal again (${closed?.status})`);
    assert.equal(closed?.detail, "codex · 7 msgs · demo-site");
    assert.equal(closed?.status, "ended", "our child exited: nobody owns the thread now, and a send() would resume it again");
  } finally {
    h.cleanup();
  }
});

test("send(): the thread is open in Codex Desktop → `codex queue` into it, never a resume, in no folder; a failed queue is refused with stderr", async () => {
  const h = makeHome();
  try {
    h.signIn();
    const c = connector(h, { procs: [desktop([C1])] });
    assert.equal((await c.list()).find((a) => a.id === ID1)?.status, "idle", "the app-server holds its rollout");
    const queued = await c.send(ID1, "also the footer");
    assert.deepEqual(queued, { accepted: true, detail: "queued into the open Codex thread; Codex will run it there", mode: "queue" });
    assert.deepEqual(h.logged().map((x) => x.args), [["queue", "--thread", C1, "--message", "also the footer"]]);
    assert.equal(h.logged()[0]?.cwd, realpathSync(process.cwd()), "queue talks to the thread store, not to the thread's folder: spawned wherever we are");
    assert.equal((await c.list()).find((a) => a.id === ID1)?.status, "idle", "nothing of ours is running");

    // The thread's folder is gone: an open thread still takes a message (a resume could not have run there).
    rmSync(h.cwd, { recursive: true, force: true });
    assert.deepEqual(await c.send(ID1, "and the footer"), { accepted: true, detail: "queued into the open Codex thread; Codex will run it there", mode: "queue" });
    assert.equal(h.logged().length, 2);

    // The rollout itself is gone while the listing still has the thread: the CLI's refusal is the answer.
    rmSync(h.c1Path);
    const refused = await c.send(ID1, "hi");
    assert.equal(refused.accepted, false);
    assert.match(refused.detail ?? "", /^that thread is open in Codex and queueing into it failed: Error: failed to queue session message: .*no rollout found for thread id 01a0aaaa/);
    assert.ok(h.logged().every((x) => x.args[0] === "queue"), "an open thread is never resumed under the owner's feet");
  } finally {
    h.cleanup();
  }
});

test("send(): a writer lock nobody holds is a leftover → resumed, no queue; degraded detection → refused, nothing spawned", async () => {
  const h = makeHome();
  try {
    h.signIn();
    h.lock(C1);
    // `codex queue` exits 0 with or without a daemon (checked against 0.153.4), so it could not
    // tell a live lock from a stale one; the process snapshot did, and the CLI takes stale locks itself.
    const stale = connector(h);
    assert.deepEqual(await stale.send(ID1, "hi"), { accepted: true, detail: "resumed headlessly", mode: "resume" });
    assert.equal((await stale.waitSettled(ID1, 3_000)).status, "idle");
    assert.deepEqual(h.logged().map((x) => x.args[0]), ["exec"], "straight to the resume: a queue here would file a message nobody drains");
    await stale.closeAll();
    rmSync(h.log);

    // ps/lsof down: nobody can say whether the thread is open. A queue would look delivered either way; refuse, as for Claude Code.
    const degraded = new SessionsConnector({
      home: h.home,
      now: () => NOW, // the fixtures are dated 2026-09-01; the real clock left the 14-day window on 2026-09-15
      processCacheMs: 0,
      codexBin: h.fake,
      applicationsDir: join(h.home, "Applications"),
      cliSystemDirs: [],
      env: { PATH: join(h.home, "empty-bin"), HOME: h.home, FAKE_CODEX_LOG: h.log },
      exec: async (file) => {
        // A codex process is on the box, so lsof is needed to say what it holds — and lsof is down.
        if (file === "ps") return "  PID  PPID                  STARTED COMMAND\n 4083   686 Tue Sep  8 09:33:04 2026 /Applications/ChatGPT.app/Contents/Resources/codex app-server\n";
        throw new Error("lsof: timed out");
      },
    });
    assert.deepEqual(await degraded.send(ID1, "hi"), { accepted: false, detail: "cannot tell whether that thread is open in Codex (lsof failed: lsof: timed out); not resuming it" });
    assert.deepEqual(h.logged(), [], "neither an exec nor a queue on a guess");
  } finally {
    h.cleanup();
  }
});

test("send(): sub-agent and automation rollouts are refused by id with nothing spawned — the listing hides them, and send() does not reach past it", async () => {
  const h = makeHome();
  try {
    h.signIn();
    const c = connector(h);
    const ids = (await c.list()).map((a) => a.id);
    assert.ok(!ids.includes(`sessions:codex:${SUB}`) && !ids.includes(`sessions:codex:${AUTO}`), "neither is listed");
    assert.deepEqual(await c.send(`sessions:codex:${SUB}`, "hi from review"), { accepted: false, detail: `that rollout is a Codex sub-agent run of thread ${C1.slice(0, 8)}; continue its parent thread instead` });
    assert.deepEqual(await c.send(`sessions:codex:${AUTO}`, "hi"), { accepted: false, detail: "that rollout is a Codex automation run, not a thread to continue" });
    assert.deepEqual(h.logged(), [], "nothing was spawned");
  } finally {
    h.cleanup();
  }
});

test("send(): between turns, ownership is asked again — Kevin opening the thread in Codex turns the next send into a queue", async () => {
  const h = makeHome();
  try {
    h.signIn();
    let procs: AgentProcess[] = [];
    const c = connector(h, { opts: { processes: async () => procs } });
    assert.deepEqual(await c.send(ID1, "one"), { accepted: true, detail: "resumed headlessly", mode: "resume" });
    assert.equal((await c.waitSettled(ID1, 3_000)).status, "idle");
    procs = [desktop([C1])];
    assert.deepEqual(await c.send(ID1, "two"), { accepted: true, detail: "queued into the open Codex thread; Codex will run it there", mode: "queue" });
    assert.deepEqual(h.logged().map((x) => x.args[0]), ["exec", "queue"]);
    await c.closeAll();
  } finally {
    h.cleanup();
  }
});

test("send(): our own `codex exec resume` child is not mistaken for another owner, even from a stale ps; a turn sent while one runs waits behind it", async () => {
  const h = makeHome();
  try {
    h.signIn();
    let procs: AgentProcess[] = [];
    const c = connector(h, { env: { FAKE_CODEX_DELAY_MS: "300" }, opts: { processes: async () => procs } });
    assert.deepEqual(await c.send(ID1, "one"), { accepted: true, detail: "resumed headlessly", mode: "resume" });
    await until(() => h.logged().length === 1, 3_000, "the child to start");
    // What ps shows for the child we just spawned — the runner's own argv, which names the thread after `--`.
    const pid = h.logged()[0]?.pid ?? 0;
    assert.ok(pid > 0, "the fake child is running");
    const command = `${h.fake} ${h.logged()[0]!.args.join(" ")}`;
    const classified = classifyCommand(command);
    assert.deepEqual(classified, { tool: "codex", interactive: false, sessionId: C1 }, "our own resume argv is read like a human's `codex resume <id>`");
    procs = [{ pid, ppid: process.pid, startedAt: Date.now(), tool: "codex", command, cwd: h.cwd, interactive: classified!.interactive, sessionId: classified!.sessionId, heldSessionIds: [] }];
    assert.deepEqual(await c.send(ID1, "two"), { accepted: true, detail: "sent to the resumed session", mode: "resume" }, "a turn during our own turn queues behind it");
    await until(() => h.logged().length === 2, 3_000, "the second exec");
    assert.equal((await c.waitSettled(ID1, 3_000)).status, "idle");
    // The child is gone but a snapshot taken seconds ago would still list it: still ours, still a resume.
    assert.deepEqual(await c.send(ID1, "three"), { accepted: true, detail: "sent to the resumed session", mode: "resume" });
    assert.equal((await c.waitSettled(ID1, 3_000)).status, "idle");
    assert.deepEqual(h.logged().map((x) => x.args[0]), ["exec", "exec", "exec"], "no queue: the only 'owner' was us");
    await c.closeAll();
  } finally {
    h.cleanup();
  }
});

// ------------------------------------------------------------------- start() ---

test("start(): a new Codex thread in a folder is listed from the first second, then from its rollout; the registry route the brain uses", async () => {
  const h = makeHome();
  try {
    h.signIn();
    const cwd = join(h.home, "fresh-project");
    mkdirSync(cwd);
    const c = connector(h, { env: { FAKE_CODEX_THREAD_ID: NEW_ID, FAKE_CODEX_DELAY_MS: "150" } });
    const registry = new AgentRegistry([c], 0);
    const info = await registry.start("sessions", { tool: "codex", cwd, prompt: "make the hero blue" });
    assert.equal(info.id, `sessions:codex:${NEW_ID}`);
    assert.equal(info.kind, "sessions");
    assert.equal(info.name, "make the hero blue", "named by its prompt until Codex names it");
    assert.equal(info.cwd, cwd);
    assert.equal(info.status, "working");
    assert.equal(info.detail, "codex · 1 msg · fresh-project · resumed: thinking");
    assert.deepEqual(h.logged()[0]?.args, ["exec", "--json", "--skip-git-repo-check", "-C", cwd, "-s", "workspace-write", "--", "make the hero blue"], "a new thread: exec takes -C and -s, no --ephemeral so it persists");
    assert.equal(h.logged()[0]?.cwd, realpathSync(cwd));
    assert.ok((await c.list()).some((a) => a.id === info.id), "listed before its rollout exists");

    const settled = await registry.waitSettled(info.id, 3_000);
    assert.equal(settled?.status, "idle");
    assert.match(await registry.read(info.id), /\nDone: make the hero blue$/);
    const fromDisk = (await c.list()).find((a) => a.id === info.id);
    assert.equal(fromDisk?.name, "make the hero blue", "now from the rollout the fake wrote");
    assert.equal(fromDisk?.detail, "codex · 2 msgs · fresh-project · resumed by Jarhead");
    assert.equal((await c.codex.find(NEW_ID))?.cwd, realpathSync(cwd));

    await assert.rejects(c.start({ tool: "gemini", cwd, prompt: "x" }), /sessions can start "codex" or "claude" threads, not "gemini"/);
    await assert.rejects(c.start({ tool: "codex", cwd: join(h.home, "missing"), prompt: "x" }), /no longer exists/);
    await assert.rejects(c.start({ tool: "codex", cwd, prompt: "   " }), /needs a prompt/);
    await c.closeAll();

    const noLogin = connector(h, { env: { CODEX_HOME_UNUSED: "1" }, codexBin: null });
    await assert.rejects(noLogin.start({ tool: "codex", cwd, prompt: "x" }), /^Error: codex not found: looked in /);
  } finally {
    h.cleanup();
  }
});

test("start(): the recorded `codex exec --json` events (0.153.4) drive a run to its reply", async () => {
  const h = makeHome();
  try {
    h.signIn();
    const c = connector(h, { env: { FAKE_CODEX_MODE: "recorded", FAKE_CODEX_EVENTS: join(FIXTURES, "codex-exec-events.jsonl") } });
    const errors: string[] = [];
    const info = await c.start({ kind: "codex", cwd: h.cwd, prompt: "Reply with exactly: ok" });
    assert.equal(info.id, "sessions:codex:01a08dd4-c433-7873-8a9b-a9baa2752846", "the thread id from thread.started");
    const settled = await c.waitSettled(info.id, 3_000);
    assert.equal(settled.status, "idle", "item.completed error (skills budget) is informational; turn.completed ends the turn");
    assert.match(await c.read(info.id), /\nok$/);
    assert.deepEqual(errors, []);
    await c.closeAll();
  } finally {
    h.cleanup();
  }
});

// ------------------------------------------------------------ cancel & errors ---

test("interrupt(): SIGINT ends the turn; a child that ignores it is SIGKILLed after the grace; the wall-clock budget does the same", async () => {
  const h = makeHome();
  try {
    h.signIn();
    const c = connector(h, { env: { FAKE_CODEX_MODE: "hang" }, opts: { codexKillGraceMs: 150 } });
    assert.deepEqual(await c.send(ID1, "run forever"), { accepted: true, detail: "resumed headlessly", mode: "resume" });
    await until(() => h.logged().length === 1, 3_000, "the spawn");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await c.list()).find((a) => a.id === ID1)?.status, "working");
    const t0 = Date.now();
    await c.interrupt(ID1);
    const after = (await c.list()).find((a) => a.id === ID1);
    assert.equal(after?.status, "idle");
    assert.equal(after?.detail, "codex · 3 msgs · demo-site · resumed: interrupted");
    assert.ok(Date.now() - t0 < 1_000 * RUNNER_SLACK, `SIGINT was enough: under ${1_000 * RUNNER_SLACK} ms (${Date.now() - t0} ms)`);
    await c.closeAll();

    const stubborn = connector(h, { env: { FAKE_CODEX_MODE: "hang", FAKE_CODEX_IGNORE_SIGINT: "1" }, opts: { codexKillGraceMs: 100 } });
    await stubborn.send(ID1, "run forever");
    await until(() => h.logged().length === 2, 3_000, "the second spawn");
    await new Promise((r) => setTimeout(r, 100));
    const t1 = Date.now();
    await stubborn.interrupt(ID1);
    assert.equal((await stubborn.list()).find((a) => a.id === ID1)?.status, "idle");
    assert.ok(Date.now() - t1 >= 90 && Date.now() - t1 < 1_500 * RUNNER_SLACK, `SIGKILL after the grace, under ${1_500 * RUNNER_SLACK} ms (${Date.now() - t1} ms)`);
    await stubborn.closeAll();

    const budget = connector(h, { env: { FAKE_CODEX_MODE: "hang" }, opts: { codexTurnBudgetMs: 200, codexKillGraceMs: 100 } });
    await budget.send(ID1, "run forever");
    const settled = await budget.waitSettled(ID1, 3_000);
    assert.equal(settled.status, "idle");
    assert.equal(settled.detail, "codex · 3 msgs · demo-site · resumed: timed out after 200 ms");
    await budget.closeAll();
  } finally {
    h.cleanup();
  }
});

test("errors: top-level `error` events are notices — the status stays working with the retry as detail; turn.completed after them ends the turn idle, turn.failed after them is the failure", async () => {
  const h = makeHome();
  try {
    h.signIn();
    const recorded = join(FIXTURES, "codex-exec-reconnect-events.jsonl");
    const reconnect = readFileSync(recorded, "utf8").split("\n").filter(Boolean);
    const success = readFileSync(join(FIXTURES, "codex-exec-events.jsonl"), "utf8").split("\n").filter(Boolean);
    // The recorded retries (thread.started, turn.started, the skills note, Reconnecting 2/5…5/5), then the
    // recorded successful turn's reply and turn.completed: a transport blip the turn survived.
    const composed = join(h.home, "reconnect-then-ok.jsonl");
    writeFileSync(composed, `${[...reconnect.slice(0, 7), ...success.slice(3)].join("\n")}\n`);
    const c = connector(h, { env: { FAKE_CODEX_MODE: "recorded", FAKE_CODEX_EVENTS: composed, FAKE_CODEX_PAUSE_AFTER: "7", FAKE_CODEX_DELAY_MS: "400" } });
    const seen: string[] = [];
    const stop = c.subscribe((a) => {
      if (a.id === ID1) seen.push(`${a.status}: ${a.detail}`);
    });
    assert.deepEqual(await c.send(ID1, "hi"), { accepted: true, detail: "resumed headlessly", mode: "resume" });
    // 8 s: under full-suite load the 400 ms fake delay plus the 50 ms coalescer can slip past 3 s.
    await until(() => seen.includes("working: codex · 3 msgs · demo-site · resumed: reconnecting 5/5"), 8_000, "the retry to show as detail");
    const settled = await c.waitSettled(ID1, 3_000);
    assert.equal(settled.status, "idle");
    assert.equal(settled.detail, "codex · 3 msgs · demo-site · resumed by Jarhead");
    assert.match(await c.read(ID1), /\nok$/, "the reply after the blip");
    assert.ok(!seen.some((s) => s.startsWith("unknown")), `never unknown along the way: ${seen.join(" | ")}`);
    stop();
    await c.closeAll();

    // The stream exactly as recorded: retries, the bare message, turn.failed, exit 1.
    const failed = connector(h, { env: { FAKE_CODEX_MODE: "recorded", FAKE_CODEX_EVENTS: recorded } });
    await failed.send(ID1, "hi");
    const f = await failed.waitSettled(ID1, 3_000);
    assert.equal(f.status, "unknown");
    assert.match(f.detail ?? "", /^codex · 3 msgs · demo-site · resumed: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header/, "turn.failed's message, not a retry notice");
    await failed.closeAll();
  } finally {
    h.cleanup();
  }
});

test("errors: turn.failed and a crash without turn.completed leave status unknown with the reason; stderr's stdin notice is not the reason", async () => {
  const h = makeHome();
  try {
    h.signIn();
    const failed = connector(h, { env: { FAKE_CODEX_MODE: "fail" } });
    await failed.send(ID1, "hi");
    const f = await failed.waitSettled(ID1, 3_000);
    assert.equal(f.status, "unknown");
    assert.equal(f.detail, "codex · 3 msgs · demo-site · resumed: model says no");
    assert.match(await failed.read(ID1), /\nSwitched the hero heading to DM Sans and rebuilt\.$/, "no reply this turn: the file's last answer stands");
    await failed.closeAll();

    const crashed = connector(h, { env: { FAKE_CODEX_MODE: "crash" } });
    await crashed.send(ID1, "hi");
    const k = await crashed.waitSettled(ID1, 3_000);
    assert.equal(k.status, "unknown");
    assert.equal(k.detail, "codex · 3 msgs · demo-site · resumed: Error: stream disconnected before completion");
    // A run in "unknown" is not offline: the next send tries again rather than giving up on the thread.
    const retry = connector(h, {});
    assert.deepEqual(await retry.send(ID1, "again"), { accepted: true, detail: "resumed headlessly", mode: "resume" });
    assert.equal((await retry.waitSettled(ID1, 3_000)).status, "idle");
    await crashed.closeAll();
    await retry.closeAll();
  } finally {
    h.cleanup();
  }
});
