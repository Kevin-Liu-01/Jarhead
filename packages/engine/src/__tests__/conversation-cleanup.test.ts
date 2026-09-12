import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger } from "@jarhead/core";
import { specByName } from "@jarhead/brain";
import type { LedgerRow } from "@jarhead/protocol";
import { delegate, frame, nextUtterance, rows, settle, world, type World } from "./world.ts";

/**
 * Conversation cleanup, the engine side (K1): the `conversation.*` commands append
 * tombstone rows (by kevin, against the chain root); `now.clear` hides the Now stream
 * at snapshot output only; `conversation.new` is a stop plus an empty Now, and the
 * next Go starts a chain of its own; `ledger.trash-day` / `restore-day` / `sweep` move
 * whole day files through the Trash; `agent.hide` is a row and a snapshot list. Every
 * one is a command — none is a brain tool — and the ledger keeps everything.
 */

const DAY_MS = 86_400_000;

type Started = Extract<LedgerRow, { type: "session.started" }>;

/** A closed session two days before the world's clock, written straight to the ledger (as an earlier daemon would have). */
function oldDay(w: World, id: string, daysAgo = 2): string {
  const at = w.clock.t - daysAgo * DAY_MS;
  w.engine.ledger.append({ at, type: "session.started", sessionId: id, voice: "cedar" });
  w.engine.ledger.append({ at: at + 1000, type: "heard", item: { id: `h_${id}`, speaker: "kevin", text: `words of ${id}`, startMs: 0, endMs: 900, at: at + 1000, final: true } });
  w.engine.ledger.append({ at: at + 5000, type: "session.closed", sessionId: id, reason: "idle", usageSeconds: 30 });
  return Ledger.dayFor(at);
}

function shotsFor(w: World, day: string): string {
  const dir = join(w.engine.config.stateDir, "shots", day);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "shot_a.png"), Buffer.alloc(512, 1));
  return dir;
}

const toasts = (w: World): string[] => w.events.filter((e) => e.type === "toast").map((e) => (e as { text: string }).text);

test("conversation.*: tombstone rows by kevin against the chain root, stamped on every session of the chain; an unknown id is a word, not a row", async () => {
  const w = world();
  const { engine, live, lives, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    // A chain: sess_1 paused, sess_2 resumed from it.
    await engine.wake("test");
    delegate(w, "jarhead read me the plan", "item_1");
    await settle();
    clock.t += 1000;
    await engine.command({ type: "pause" });
    clock.t += 1000;
    await engine.command({ type: "go" });
    assert.equal(lives.length, 2);
    assert.equal(live.currentState, "closed");
    const sessions = engine.ledger.sessions();
    assert.deepEqual(sessions.map((s) => [s.id, s.resumedFrom]), [
      ["sess_2", "sess_1"],
      ["sess_1", undefined],
    ]);

    // Trash through the RESUMED session's id: the row carries the root, both summaries say trashed.
    clock.t += 1000;
    await engine.command({ type: "conversation.trash", chainId: "sess_2" });
    const trashed = rows<Extract<LedgerRow, { type: "conversation.trashed" }>>(w, "conversation.trashed");
    assert.deepEqual(trashed, [{ at: clock.t, type: "conversation.trashed", chainId: "sess_1", by: "kevin" }]);
    assert.deepEqual(
      engine.ledger.sessions().map((s) => [s.id, s.state, s.trashedAt]),
      [
        ["sess_2", "trashed", clock.t],
        ["sess_1", "trashed", clock.t],
      ],
    );
    // Restore, archive, rename, pin — each one row, each undoable by its inverse.
    clock.t += 1000;
    await engine.command({ type: "conversation.restore", chainId: "sess_1" });
    assert.equal(engine.ledger.conversation("sess_2")?.state, "active");
    clock.t += 1000;
    await engine.command({ type: "conversation.archive", chainId: "sess_1" });
    assert.equal(engine.ledger.conversation("sess_2")?.state, "archived");
    clock.t += 1000;
    await engine.command({ type: "conversation.rename", chainId: "sess_2", name: "  The   plan  " });
    assert.equal(engine.ledger.conversation("sess_1")?.name, "The plan");
    clock.t += 1000;
    await engine.command({ type: "conversation.pin", chainId: "sess_1", pinned: true });
    const pinnedSummary = engine.ledger.sessions().find((s) => s.id === "sess_2")!;
    assert.equal(pinnedSummary.pinned, true);
    assert.equal(pinnedSummary.name, "The plan");
    assert.equal(pinnedSummary.state, "archived");
    // The Log of either session shows the moves.
    assert.deepEqual(engine.ledger.readSession("sess_1").filter((r) => r.type.startsWith("conversation.")).map((r) => r.type), ["conversation.trashed", "conversation.restored", "conversation.archived", "conversation.renamed", "conversation.pinned"]);

    // Unknown: a warn toast, no row.
    const before = engine.ledger.read(clock.t).length;
    w.events.length = 0;
    await engine.command({ type: "conversation.trash", chainId: "sess_999" });
    assert.equal(engine.ledger.read(clock.t).length, before);
    assert.deepEqual(toasts(w), ["no such conversation"]);
    // Nothing here is a brain tool: the tool table has no cleanup verb.
    for (const name of ["conversation.trash", "conversation_trash", "trash_conversation", "ledger_trash_day", "ledger_sweep", "now_clear", "agent_hide"]) assert.equal(specByName(name), undefined, name);
  } finally {
    await engine.stop();
  }
});

test("now.clear hides the Now stream at or before the mark in the snapshot only; the ledger keeps every row; now.restore brings it back", async () => {
  const w = world();
  const { engine, brain, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    delegate(w, "jarhead find the save button", "item_1");
    await settle();
    brain.resolve?.({ status: "done", summary: "found it" });
    await settle();
    assert.equal(engine.snapshot().transcript.length, 1);
    assert.equal(engine.snapshot().delegations.length, 1);
    const heardBefore = rows<LedgerRow>(w, "heard").length;

    clock.t += 500;
    await engine.command({ type: "now.clear" });
    const snap = engine.snapshot();
    assert.equal(snap.transcript.length, 0, "cleared: nothing at or before the mark");
    assert.equal(snap.delegations.length, 0);
    assert.deepEqual(rows<LedgerRow>(w, "now.cleared"), [{ at: clock.t, type: "now.cleared", sessionId: "sess_1" }]);
    assert.equal(engine.ledger.nowClearedAt("sess_1"), clock.t);
    assert.equal(rows<LedgerRow>(w, "heard").length, heardBefore, "the ledger lost nothing");
    // What comes after the mark shows.
    clock.t += 1000;
    nextUtterance(w);
    delegate(w, "jarhead now scroll down", "item_2");
    await settle();
    const after = engine.snapshot();
    assert.equal(after.transcript.length, 1);
    assert.ok(/scroll down/.test(after.transcript[0]!.text));
    assert.equal(after.delegations.length, 1);
    assert.equal(after.delegations[0]!.liveId, "item_2");
    // Restore: everything is back, and the row says so.
    clock.t += 1000;
    await engine.command({ type: "now.restore" });
    assert.equal(engine.snapshot().transcript.length, 2);
    assert.equal(engine.snapshot().delegations.length, 2);
    assert.deepEqual(rows<LedgerRow>(w, "now.restored"), [{ at: clock.t, type: "now.restored", sessionId: "sess_1" }]);
    assert.equal(engine.ledger.nowClearedAt("sess_1"), undefined);
    // A second restore with nothing cleared is a no-op: no row.
    await engine.command({ type: "now.restore" });
    assert.equal(rows<LedgerRow>(w, "now.restored").length, 1);
  } finally {
    await engine.stop();
  }
});

test("conversation.new: the transport's stop (session closed, meter stopped), an empty Now, and the next Go starts a chain of its own — from awake and from paused", async () => {
  const w = world();
  const { engine, live, lives, brain, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    delegate(w, "jarhead open Safari", "item_1");
    await settle();
    brain.resolve?.({ status: "done", summary: "opened" });
    await settle();
    live.reportUsage(30);
    assert.equal(engine.snapshot().transcript.length, 1);

    clock.t += 1000;
    await engine.command({ type: "conversation.new" });
    assert.equal(live.currentState, "closed", "the session is closed: the meter stops");
    assert.equal(engine.currentPhase, "asleep");
    assert.equal(engine.isPaused, false);
    const snap = engine.snapshot();
    assert.equal(snap.session, undefined);
    assert.equal(snap.transcript.length, 0, "Now is empty");
    assert.equal(snap.delegations.length, 0);
    assert.equal(rows<LedgerRow>(w, "stop").length, 1, "recorded as the transport's stop");
    assert.equal(rows<LedgerRow>(w, "heard").length, 1, "the ledger keeps what was said");

    // The next Go opens a fresh chain: no resumedFrom, no resume row.
    clock.t += 1000;
    await engine.command({ type: "go" });
    assert.equal(lives.length, 2);
    const started = rows<Started>(w, "session.started");
    assert.deepEqual(started.map((s) => [s.sessionId, s.resumedFrom]), [
      ["sess_1", undefined],
      ["sess_2", undefined],
    ]);
    assert.equal(rows<LedgerRow>(w, "resume").length, 0);
    assert.ok(!(lives[1]!.config?.instructions ?? "").includes("# Continuity"), "no continuity: a new conversation");
    assert.equal(engine.ledger.chainRootOf("sess_2"), "sess_2");

    // From paused: the pause is let go, and Go after it is a fresh chain too.
    delegate(w, "jarhead what time is it", "item_2");
    await settle();
    clock.t += 1000;
    await engine.command({ type: "pause" });
    assert.equal(engine.isPaused, true);
    clock.t += 1000;
    await engine.command({ type: "conversation.new" });
    assert.equal(engine.isPaused, false);
    assert.equal(engine.snapshot().pause, undefined);
    assert.equal(engine.snapshot().transcript.length, 0);
    clock.t += 1000;
    await engine.command({ type: "go" });
    assert.equal(lives.length, 3);
    const third = rows<Started>(w, "session.started").find((s) => s.sessionId === "sess_3")!;
    assert.equal(third.resumedFrom, undefined);
    assert.equal(rows<LedgerRow>(w, "resume").length, 0);
    // Asleep with nothing open: still fine, still empty, no stop row added.
    await engine.command({ type: "stop" });
    const stops = rows<LedgerRow>(w, "stop").length;
    await engine.command({ type: "conversation.new" });
    assert.equal(rows<LedgerRow>(w, "stop").length, stops);
  } finally {
    await engine.stop();
  }
});

test("ledger.trash-day / restore-day: whole day files move by rename, the snapshot's trash line follows, today is refused with a reason; agent.hide is a row and a list", async () => {
  const w = world();
  const { engine, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    const day = oldDay(w, "old_1");
    const shots = shotsFor(w, day);
    const liveFile = join(engine.ledger.dir, `${day}.jsonl`);
    assert.deepEqual(engine.snapshot().trash, { path: join(engine.config.stateDir, "trash"), days: 0, bytes: 0 });

    w.events.length = 0;
    await engine.command({ type: "ledger.trash-day", day, what: "both" });
    assert.ok(!existsSync(liveFile));
    assert.ok(!existsSync(shots));
    assert.ok(existsSync(join(engine.config.stateDir, "trash", "ledger", `${day}.jsonl`)));
    assert.ok(existsSync(join(engine.config.stateDir, "trash", "shots", day, "shot_a.png")));
    const moved = rows<Extract<LedgerRow, { type: "ledger.moved" }>>(w, "ledger.moved");
    assert.deepEqual(moved.map((m) => [m.day, m.what, m.to, m.by]), [
      [day, "ledger", "trash", "kevin"],
      [day, "shots", "trash", "kevin"],
    ]);
    assert.deepEqual(toasts(w), [`${day} ledger and shots moved to the Trash`]);
    const info = engine.snapshot().trash!;
    assert.equal(info.days, 1);
    assert.ok(info.bytes > 512);
    assert.ok(!engine.ledger.sessions().some((s) => s.id === "old_1"), "the rail no longer lists a day in the Trash");

    // Today never moves; the reason is the toast.
    w.events.length = 0;
    await engine.command({ type: "ledger.trash-day", day: Ledger.dayFor(clock.t), what: "ledger" });
    assert.deepEqual(toasts(w), ["ledger kept · today is live"]);
    // Neither does nonsense.
    w.events.length = 0;
    await engine.command({ type: "ledger.trash-day", day: "yesterday", what: "ledger" });
    assert.deepEqual(toasts(w), ["ledger kept · not a day (YYYY-MM-DD)"]);

    // Restore: both come back; the rail lists the day again.
    w.events.length = 0;
    await engine.command({ type: "ledger.restore-day", day });
    assert.ok(existsSync(liveFile));
    assert.ok(existsSync(join(shots, "shot_a.png")));
    assert.deepEqual(toasts(w), [`${day} ledger and shots restored`]);
    assert.equal(engine.snapshot().trash!.days, 0);
    assert.ok(engine.ledger.sessions().some((s) => s.id === "old_1"));
    assert.equal(rows<LedgerRow>(w, "ledger.moved").length, 4);

    // agent.hide: a row, and the snapshot's list; unhide removes it.
    await engine.command({ type: "agent.hide", agentId: "sessions:codex:abc", hidden: true });
    await engine.command({ type: "agent.hide", agentId: "sessions:claude:def", hidden: true });
    assert.deepEqual(engine.snapshot().hiddenAgents, ["sessions:claude:def", "sessions:codex:abc"]);
    await engine.command({ type: "agent.hide", agentId: "sessions:codex:abc", hidden: false });
    assert.deepEqual(engine.snapshot().hiddenAgents, ["sessions:claude:def"]);
    assert.equal(rows<LedgerRow>(w, "agent.hidden").length, 3);
    assert.deepEqual(engine.ledger.hiddenAgents(), ["sessions:claude:def"]);
  } finally {
    await engine.stop();
  }
});

test("ledger.sweep: retention off is a word; on, the command and the startup sweep move days past the window, pinned days stay, today stays; a second engine reads the hidden agents back", async () => {
  const w = world();
  const { engine, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    const gone = oldDay(w, "gone_1", 3);
    const kept = oldDay(w, "kept_1", 2);
    const pinnedDay = oldDay(w, "pinned_1", 4);
    engine.ledger.append({ at: clock.t, type: "conversation.pinned", chainId: "pinned_1", pinned: true });
    engine.ledger.append({ at: clock.t, type: "agent.hidden", agentId: "sessions:codex:zzz", hidden: true });

    // The defaults keep the ledger forever and shots 14 days: nothing here is that old, so the sweep has nothing to move.
    w.events.length = 0;
    await engine.command({ type: "ledger.sweep" });
    assert.deepEqual(toasts(w), ["nothing to move"]);
    // Both off: a word, no plan.
    engine.updateSettings({ ledgerRetentionDays: 0, shotsRetentionDays: 0 });
    w.events.length = 0;
    await engine.command({ type: "ledger.sweep" });
    assert.deepEqual(toasts(w), ["retention is off · nothing to sweep"]);
    assert.equal(rows<LedgerRow>(w, "ledger.moved").length, 0);

    // Keep 2 days of ledger: the day 3 days ago moves, the day 2 days ago stays, the pinned day 4 days ago stays and says why.
    engine.updateSettings({ ledgerRetentionDays: 2 });
    w.events.length = 0;
    await engine.command({ type: "ledger.sweep" });
    assert.deepEqual(toasts(w), ["1 day moved to the Trash"]);
    assert.ok(!existsSync(join(engine.ledger.dir, `${gone}.jsonl`)));
    assert.ok(existsSync(join(engine.ledger.dir, `${kept}.jsonl`)));
    assert.ok(existsSync(join(engine.ledger.dir, `${pinnedDay}.jsonl`)));
    assert.ok(existsSync(join(engine.ledger.dir, Ledger.fileNameFor(clock.t))));
    const moved = rows<Extract<LedgerRow, { type: "ledger.moved" }>>(w, "ledger.moved");
    assert.deepEqual(moved.map((m) => [m.day, m.by]), [[gone, "retention"]]);
    assert.equal(engine.snapshot().trash!.days, 1);
  } finally {
    await engine.stop();
  }

  // A second engine over the same state dir: the startup sweep runs with the saved setting, and the hidden agent is read back.
  const kept1 = Ledger.dayFor(w.clock.t - 2 * DAY_MS);
  w.clock.t += DAY_MS; // a day later: the kept day is now 3 days old and moves at start
  const again = world({}, { dir: w.dir });
  again.clock.t = w.clock.t;
  try {
    assert.deepEqual(again.engine.snapshot().hiddenAgents, ["sessions:codex:zzz"]);
    assert.equal(again.engine.snapshot().trash!.days, 1);
    await again.engine.start();
    await again.engine.ready();
    assert.ok(!existsSync(join(again.engine.ledger.dir, `${kept1}.jsonl`)), "the startup sweep moved the day that aged past the window");
    assert.equal(again.engine.snapshot().trash!.days, 2);
    const moved = again.engine.ledger.read(again.clock.t).filter((r) => r.type === "ledger.moved") as Extract<LedgerRow, { type: "ledger.moved" }>[];
    assert.deepEqual(moved.map((m) => [m.day, m.by]), [[kept1, "retention"]]);
  } finally {
    await again.engine.stop();
  }
});

// `frame` is imported for parity with the other engine tests; a mic frame while asleep is dropped and proves nothing here.
void frame;

const tick = (w: World): void => (w.engine as unknown as { tick(): void }).tick();

test("conversation.trash / archive on the conversation in progress ends it as conversation.new does — paused: the pause is let go; live: the session closes — and the next Go is a fresh chain; rename and pin leave it running", async () => {
  const w = world();
  const { engine, lives, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    // Paused: trashing the held conversation lets the pause go.
    await engine.wake("test");
    delegate(w, "jarhead read me the plan", "item_1");
    await settle();
    clock.t += 1000;
    await engine.command({ type: "pause" });
    assert.equal(engine.isPaused, true);
    clock.t += 1000;
    await engine.command({ type: "conversation.trash", chainId: "sess_1" });
    assert.equal(engine.isPaused, false);
    assert.equal(engine.snapshot().pause, undefined);
    assert.equal(engine.currentPhase, "asleep");
    assert.equal(engine.ledger.conversation("sess_1")?.state, "trashed");
    assert.equal(engine.snapshot().transcript.length, 0, "Now is empty");
    clock.t += 1000;
    await engine.command({ type: "go" });
    assert.equal(lives.length, 2);
    assert.deepEqual(rows<Started>(w, "session.started").map((s) => [s.sessionId, s.resumedFrom]), [
      ["sess_1", undefined],
      ["sess_2", undefined],
    ]);
    assert.equal(rows<LedgerRow>(w, "resume").length, 0);
    assert.equal(engine.ledger.sessions().find((s) => s.id === "sess_2")!.state ?? "active", "active", "a chain of its own, not the trashed one (no tombstone rows: the state is absent, which reads active)");
    assert.ok(!(lives[1]!.config?.instructions ?? "").includes("# Continuity"));

    // Live: archiving the open conversation closes the session (the meter stops); the next Go is fresh again.
    delegate(w, "jarhead what time is it", "item_2");
    await settle();
    clock.t += 1000;
    await engine.command({ type: "conversation.archive", chainId: "sess_2" });
    assert.equal(lives[1]!.currentState, "closed");
    assert.equal(engine.currentPhase, "asleep");
    assert.equal(engine.snapshot().session, undefined);
    assert.equal(engine.snapshot().transcript.length, 0);
    assert.equal(engine.ledger.conversation("sess_2")?.state, "archived");
    clock.t += 1000;
    await engine.command({ type: "go" });
    assert.equal(lives.length, 3);
    assert.equal(rows<Started>(w, "session.started").find((s) => s.sessionId === "sess_3")!.resumedFrom, undefined);
    assert.equal(rows<LedgerRow>(w, "resume").length, 0);

    // Rename and pin are about the record: the session stays up. So does trashing a conversation that is not in progress.
    await engine.command({ type: "conversation.rename", chainId: "sess_3", name: "now" });
    await engine.command({ type: "conversation.pin", chainId: "sess_3", pinned: true });
    await engine.command({ type: "conversation.trash", chainId: "sess_1" });
    assert.equal(lives[2]!.currentState, "started");
    assert.equal(engine.currentPhase, "listening");
    assert.equal(engine.ledger.conversation("sess_3")?.name, "now");
  } finally {
    await engine.stop();
  }
});

test("a crashed process's session: trashing it, or conversation.new, means the next Go is a fresh chain, not a resume; a tombstone that lands from elsewhere is honoured too", async () => {
  // a: a session with words, cut without a stop or a closed row (the process died).
  const a = world();
  let b: World | undefined;
  let c: World | undefined;
  let d: World | undefined;
  try {
    await a.engine.start();
    await a.engine.ready();
    a.engine.updateSettings({ idleSleepMinutes: 0 });
    await a.engine.wake("test");
    delegate(a, "jarhead open the budget", "item_1");
    await settle();
    a.live.nowMs += 5000;
    a.clock.t += 2000;
    tick(a);
    assert.ok(rows<LedgerRow>(a, "heard").length >= 1, "the words are on the ledger");
    a.clock.t += 8000;

    // b: over the same state dir, inside the auto-resume window. Trash the lost conversation, then Go.
    b = world({}, { dir: a.dir, firstSessionId: "sess_b" });
    b.clock.t = a.clock.t;
    await b.engine.start();
    await b.engine.ready();
    assert.equal(b.engine.transportState, "asleep");
    b.clock.t += 1000;
    await b.engine.command({ type: "conversation.trash", chainId: "sess_1" });
    assert.equal(b.engine.ledger.conversation("sess_1")?.state, "trashed");
    assert.equal(rows<LedgerRow>(b, "stop").length, 0, "nothing was up in this process: no stop row");
    b.clock.t += 1000;
    await b.engine.command({ type: "go" });
    assert.deepEqual(rows<Started>(b, "session.started").map((s) => [s.sessionId, s.resumedFrom]), [
      ["sess_1", undefined],
      ["sess_b", undefined],
    ]);
    assert.equal(rows<LedgerRow>(b, "resume").length, 0);
    assert.ok(!(b.live.config?.instructions ?? "").includes("# Continuity"));
    assert.equal(b.engine.ledger.sessions().find((s) => s.id === "sess_b")!.state ?? "active", "active");

    // c: conversation.new while asleep with the lost session pending — the next Go is fresh, and no stop row was added.
    c = world();
    const t0 = c.clock.t - 10_000;
    c.engine.ledger.append({ at: t0, type: "session.started", sessionId: "lost_1", voice: "cedar" });
    c.engine.ledger.append({ at: t0 + 1000, type: "heard", item: { id: "h_lost", speaker: "kevin", text: "jarhead the words before the crash", startMs: 0, endMs: 900, at: t0 + 1000, final: true } });
    await c.engine.start();
    await c.engine.ready();
    assert.equal(c.engine.transportState, "asleep");
    await c.engine.command({ type: "conversation.new" });
    assert.equal(rows<LedgerRow>(c, "stop").length, 0);
    c.clock.t += 1000;
    await c.engine.command({ type: "go" });
    assert.deepEqual(rows<Started>(c, "session.started").map((s) => [s.sessionId, s.resumedFrom]), [
      ["lost_1", undefined],
      ["sess_1", undefined],
    ]);
    assert.equal(rows<LedgerRow>(c, "resume").length, 0);
    assert.equal(c.engine.ledger.chainRootOf("sess_1"), "sess_1");

    // d: the tombstone lands from elsewhere (another process's row, not this engine's command) after start: not resumed either.
    d = world();
    const t1 = d.clock.t - 10_000;
    d.engine.ledger.append({ at: t1, type: "session.started", sessionId: "lost_2", voice: "cedar" });
    await d.engine.start();
    await d.engine.ready();
    d.engine.ledger.append({ at: d.clock.t, type: "conversation.archived", chainId: "lost_2" });
    d.clock.t += 1000;
    await d.engine.command({ type: "go" });
    assert.deepEqual(rows<Started>(d, "session.started").map((s) => [s.sessionId, s.resumedFrom]), [
      ["lost_2", undefined],
      ["sess_1", undefined],
    ]);
    assert.equal(rows<LedgerRow>(d, "resume").length, 0);
  } finally {
    await d?.engine.stop();
    await c?.engine.stop();
    await b?.engine.stop();
    await a.engine.stop();
  }
});

test("the rollover sweep waits for a quiet tick — not while a session is live, then once — and the Trash line is re-read after every sweep, so a Trash emptied in Finder reads 0", async () => {
  const w = world();
  const { engine, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0, ledgerRetentionDays: 2 });
    const gone = oldDay(w, "gone_1", 3); // past the window already; only a sweep moves it
    const goneFile = join(engine.ledger.dir, `${gone}.jsonl`);
    await engine.wake("test");
    // Midnight passes with the session up: the rollover is noticed, the sweep does not run on the voice loop.
    clock.t += DAY_MS;
    tick(w);
    assert.ok(existsSync(goneFile), "live session: the sweep waits");
    tick(w);
    assert.ok(existsSync(goneFile));
    // The session ends: the next tick sweeps, once.
    await engine.command({ type: "stop" });
    tick(w);
    assert.ok(!existsSync(goneFile), "quiet: the pending sweep ran");
    assert.equal(engine.snapshot().trash!.days, 1);
    const movedRows = engine.ledger.read(clock.t).filter((r): r is Extract<LedgerRow, { type: "ledger.moved" }> => r.type === "ledger.moved");
    assert.deepEqual(movedRows.map((m) => [m.day, m.by]), [[gone, "retention"]]);
    tick(w);
    assert.equal(engine.ledger.read(clock.t).filter((r) => r.type === "ledger.moved").length, 1, "once");
    // Finder empties the Trash: the line is not re-read per snapshot, but a sweep with nothing to move re-reads it.
    rmSync(join(engine.config.stateDir, "trash"), { recursive: true, force: true });
    assert.equal(engine.snapshot().trash!.days, 1);
    await engine.command({ type: "ledger.sweep" });
    assert.deepEqual(engine.snapshot().trash, { path: join(engine.config.stateDir, "trash"), days: 0, bytes: 0 });
  } finally {
    await engine.stop();
  }
});

test("a Now cleared before a restart stays cleared: the second engine reads the mark back with the pause it holds, so now.restore still lifts it", async () => {
  const a = world();
  let b: World | undefined;
  try {
    await a.engine.start();
    await a.engine.ready();
    a.engine.updateSettings({ idleSleepMinutes: 0 });
    await a.engine.wake("test");
    delegate(a, "jarhead read me the plan", "item_1");
    await settle();
    a.clock.t += 1000;
    await a.engine.command({ type: "now.clear" });
    a.clock.t += 1000;
    await a.engine.command({ type: "pause" });
    assert.equal(a.engine.ledger.nowClearedAt("sess_1"), a.clock.t - 1000);

    b = world({}, { dir: a.dir, firstSessionId: "sess_b" });
    b.clock.t = a.clock.t + 5000;
    await b.engine.start();
    await b.engine.ready();
    assert.equal(b.engine.transportState, "paused", "the pause is held again");
    await b.engine.command({ type: "now.restore" });
    assert.deepEqual(rows<LedgerRow>(b, "now.restored").map((r) => (r as { sessionId: string }).sessionId), ["sess_1"]);
    assert.equal(b.engine.ledger.nowClearedAt("sess_1"), undefined);
  } finally {
    await b?.engine.stop();
    await a.engine.stop();
  }
});
