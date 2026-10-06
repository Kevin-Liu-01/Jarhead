// APP-3 on the daemon's side (the W3-3 review). An app whose hello (`audio: true`) names another PROTOCOL_VERSION, or
// none, was built from another checkout. The app judges the skew from the daemon's hello, but an app from before that
// check judges nothing, so the daemon does too: while such an app is attached every snapshot carries the `app.version`
// row (the app's own words, Restart daemon, `pnpm build:mac` to copy), and that app's commands that would open a paid
// session are refused with a toast and never reach the engine. A CLI client (`audio: false`) is never judged, and an
// app of this build is not either. The row goes when the last such app leaves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION, type Problem } from "@jarhead/protocol";
import { APP_VERSION_NOT_SENT_TEXT, APP_VERSION_REFUSED_TEXT, APP_VERSION_TEXT, DaemonServer, opensSession, type EngineLike } from "../server.ts";
import { DaemonClient } from "../client.ts";
import type { DaemonMessage } from "../wire.ts";

/** An engine that keeps every command it is handed and has one problem of its own. */
function engine(commands: string[]): EngineLike {
  const none = (): unknown[] => [];
  const own: Problem = { kind: "brain.local", text: "Nothing on Ollama can call tools.", since: 1 };
  return {
    on: () => undefined,
    snapshot: () => ({ phase: "asleep", problems: [own] }),
    command: async (cmd) => void commands.push(String((cmd as { type?: unknown }).type)),
    feedMic: () => undefined,
    reportInputLevel: () => undefined,
    setPermission: () => undefined,
    setPermissions: () => undefined,
    registerOwnPid: () => undefined,
    ear: () => undefined,
    problem: () => undefined,
    ledger: { read: none, days: () => [], sessions: none, readSession: none, search: none, readChain: () => ({ rows: [], truncated: false }) },
    memory: { list: none, search: async () => [] },
    dropViewers: () => undefined,
    config: { stateDir: "" },
    runner: { run: async () => ({ result: { kind: "text", text: "" } }) },
    runnerFor: () => undefined,
  };
}

async function until(check: () => boolean, what: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A client that keeps what the daemon sent it. */
async function attach(path: string, hello: Parameters<DaemonClient["connect"]>[0]): Promise<{ client: DaemonClient; got: DaemonMessage[] }> {
  const client = new DaemonClient(path);
  const got: DaemonMessage[] = [];
  client.on("message", (m) => got.push(m));
  await client.connect(hello);
  return { client, got };
}

const lastSnapshot = (got: readonly DaemonMessage[]): { problems?: Problem[] } | undefined =>
  (got.filter((m) => m.type === "snapshot").at(-1) as { snapshot?: { problems?: Problem[] } } | undefined)?.snapshot;
const skewRow = (got: readonly DaemonMessage[]): Problem | undefined => lastSnapshot(got)?.problems?.find((p) => p.kind === "app.version");
const toasts = (got: readonly DaemonMessage[]): string[] => got.flatMap((m) => (m.type === "toast" ? [m.text] : []));

const OPENING = [
  { type: "go" },
  { type: "resume" },
  { type: "voice.reopen" },
  { type: "say-text", text: "hello" },
  { type: "thread.say", threadId: "main", text: "hello" },
] as const;

test("APP-3, the daemon's half: an app with no protocol in its hello raises app.version on every client's snapshot; its Go, resume, Switch now and typed lines are refused with a toast; Stop, Pause and a line to another thread go; a CLI client is never judged", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "jh-w33-skew-")), "d.sock");
  const commands: string[] = [];
  const server = new DaemonServer(engine(commands), path);
  await server.listen();
  const cli = await attach(path, { pid: 2, audio: false, protocol: null });
  const old = await attach(path, { pid: 1, audio: true, protocol: null });
  try {
    await until(() => skewRow(old.got) !== undefined && skewRow(cli.got) !== undefined, "the app.version row on both clients' snapshots");
    const row = skewRow(old.got);
    assert.equal(row?.text, APP_VERSION_TEXT);
    assert.equal(APP_VERSION_TEXT, "The app and the daemon are from different builds. Restart the daemon. If this stays, run pnpm build:mac.", "the app's own words (EngineClient.skewProblemText)");
    assert.deepEqual(row?.remedy, { label: "Restart daemon", command: { type: "daemon.restart" }, copy: "pnpm build:mac" });
    assert.ok(lastSnapshot(old.got)?.problems?.some((p) => p.kind === "brain.local"), "the engine's own problems stay under it");

    for (const command of OPENING) old.client.sendJson({ type: "command", command });
    old.client.sendJson({ type: "command", command: { type: "thread.say", threadId: "t_1", text: "and then" } });
    old.client.sendJson({ type: "command", command: { type: "pause" } });
    old.client.sendJson({ type: "command", command: { type: "stop" } });
    await until(() => commands.includes("stop"), "Stop to reach the engine");
    assert.deepEqual(commands, ["thread.say", "pause", "stop"], "nothing that opens a session reached the engine; a spawned thread's follow-up, Pause and Stop did");
    await until(() => toasts(old.got).length >= 5, "a toast per refusal");
    assert.deepEqual(toasts(old.got).sort(), [APP_VERSION_REFUSED_TEXT, APP_VERSION_REFUSED_TEXT, APP_VERSION_REFUSED_TEXT, APP_VERSION_NOT_SENT_TEXT, APP_VERSION_NOT_SENT_TEXT].sort());
    assert.doesNotMatch([APP_VERSION_TEXT, APP_VERSION_REFUSED_TEXT, APP_VERSION_NOT_SENT_TEXT].join(" "), /—/, "no em dash");

    // The CLI runs from the daemon's own checkout: its Go is Kevin's and goes.
    cli.client.sendJson({ type: "command", command: { type: "go" } });
    await until(() => commands.includes("go"), "the CLI's Go to reach the engine");
    assert.equal(toasts(cli.got).length, 0, "the CLI was refused nothing");

    // The app of another build leaves: the snapshots lose the row.
    old.client.close();
    await until(() => lastSnapshot(cli.got) !== undefined && skewRow(cli.got) === undefined, "a snapshot without the row");
  } finally {
    old.client.close();
    cli.client.close();
    await server.close();
  }
});

test("APP-3, the daemon's half: an app whose hello names this build's protocol is not judged; one that names another number is", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "jh-w33-skew2-")), "d.sock");
  const commands: string[] = [];
  const server = new DaemonServer(engine(commands), path);
  await server.listen();
  const current = await attach(path, { pid: 1, audio: true });
  try {
    await until(() => current.got.some((m) => m.type === "snapshot"), "the accept-time snapshot");
    current.client.sendJson({ type: "command", command: { type: "go" } });
    await until(() => commands.includes("go"), "Go from an app of this build");
    assert.equal(skewRow(current.got), undefined, "no row for an app of this build (DaemonClient sends PROTOCOL_VERSION)");

    const newer = await attach(path, { pid: 3, audio: true, protocol: PROTOCOL_VERSION + 1 });
    try {
      await until(() => skewRow(current.got) !== undefined, "the row once an app of another number attached");
      newer.client.sendJson({ type: "command", command: { type: "go" } });
      await until(() => toasts(newer.got).includes(APP_VERSION_REFUSED_TEXT), "the newer app's Go refused");
      assert.deepEqual(commands, ["go"], "only the current app's Go reached the engine");
    } finally {
      newer.client.close();
    }
    await until(() => skewRow(current.got) === undefined, "the row gone with it");
  } finally {
    current.client.close();
    await server.close();
  }
});

test("APP-3: opensSession is EngineClient.opensSession's list, and the daemon's words are the app's, word for word", () => {
  for (const command of OPENING) assert.equal(opensSession(command), true, command.type);
  for (const command of [{ type: "stop" }, { type: "pause" }, { type: "daemon.restart" }, { type: "thread.say", threadId: "t_9", text: "x" }, { type: "sleep" }] as const) {
    assert.equal(opensSession(command as never), false, command.type);
  }
  const swift = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../../apps/mac/Sources/Jarhead/Daemon/EngineClient.swift"), "utf8");
  const words = (name: string): string | undefined => new RegExp(`static let ${name} = "([^"]*)"`).exec(swift)?.[1];
  assert.equal(words("skewProblemText"), APP_VERSION_TEXT);
  assert.equal(words("skewRefusedText"), APP_VERSION_REFUSED_TEXT);
  assert.equal(words("skewNotSentText"), APP_VERSION_NOT_SENT_TEXT);
  const cases = /static func opensSession\(_ command: EngineCommand\) -> Bool \{[\s\S]*?case (\.go[^:]*):/.exec(swift)?.[1];
  assert.equal(cases, ".go, .resume, .voiceReopen", "the app refuses the same three, and a typed line (isTypedLine: say-text, thread.say to main)");
});
