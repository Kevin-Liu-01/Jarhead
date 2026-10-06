import { test } from "node:test";
import assert from "node:assert/strict";
import { settle } from "./world.ts";
import { liveOf, rig, type Rig } from "./live-rig.ts";

/**
 * C1 (2026-10-06, Kevin approved): the voice's orders agree with the room-talk gate on a confirmation's yes. The gate
 * (voice-attention.ts, main 98c7cfe) refuses an unnamed yes to a waiting confirmation once the exchange has ended:
 * Jarhead's answer window never covers one, so it needs the name, or Allow / Deny in the island or the Console. The
 * refusal happens in the Delegator, and its onNotAddressed is the engine's only way to the one cue. So the orders tell
 * the voice to delegate that yes anyway, and on a refusal to say only the line the engine gives: the cue's own words,
 * never an ask of the voice's own beside it. This is the review's ADV-4 replay (room-talk-gate-review.test.ts) with
 * the orders the engine opened the session with read beside it, and the same yes kept back by the voice for contrast.
 */

const T = 30_000;

/** "Send it to Ben?" waits; Kevin's unnamed "yes" lands 10 s after it, past the exchange. `delegates`: the voice passes it on. */
async function lateYes(r: Rig, delegates: boolean): Promise<void> {
  const { w } = r;
  w.engine.confirmations.ask("send the message to ben", "messages", { text: "hi" });
  await r.run({ voiced: [[T + 1948, T + 2648]], at: [
    { t: T + 100, run: () => void liveOf(w).appendInstructions(null, `Say this to Kevin now, in these words: "Send it to Ben?" Then wait.`) },
    { t: T + 1686, run: () => r.output(" send it to ben?", T + 1600, T + 2400) },
    { t: T + 13_400, run: () => r.input(" yes.", T + 12_100, T + 12_400) },
    ...(delegates ? [{ t: T + 13_500, run: () => r.delegation("item_yes", T + 13_400) }] : []),
  ] }, T + 16_000);
  await settle(50);
}

const cuesOf = (r: Rig) => r.sock().events().filter((e) => e.type === "session.instructions.append" && /say jarhead with the yes/.test(e.content ?? ""));

test("C1: an unnamed yes 10 s after a send's question, delegated as the orders say, is refused with one cue that is the only line the voice is given; the orders the session opened with say to delegate it and to say only that line", async () => {
  const r = await rig(10);
  const { w } = r;
  try {
    await lateYes(r, true);
    // The gate's half, as main has it.
    assert.equal(w.brain.tasks.length, 0, "the unnamed yes reached the brain");
    assert.ok(w.engine.confirmations.pending, "the confirmation is still waiting");
    const refused = r.sock().events().filter((e) => e.type === "session.thinking.append" && e.delegationId === "item_yes");
    assert.equal(refused.length, 1, "the refusal closes the delegation for the voice");
    assert.match(refused[0]!.content ?? "", /Say nothing about them\./);
    const cues = cuesOf(r);
    assert.equal(cues.length, 1, "one cue");
    assert.match(cues[0]!.content ?? "", /^Say exactly this to Kevin and nothing else: "say jarhead with the yes, or answer in the console\." Then wait\.$/, "the cue is the whole line: the voice adds no ask of its own");
    // The voice's half: the orders the session started with (its `session.start`, as sent to the server) say the same.
    const start = r.sock().sent.map((s) => JSON.parse(s.line) as { type: string; session?: { instructions?: string } }).find((e) => e.type === "session.start");
    const orders = start?.session?.instructions ?? "";
    const attention = orders.slice(orders.indexOf("# Attention"), orders.indexOf("# Backchannel policy"));
    assert.match(attention, /except answers to your question; typed lines always are\./, "a plain question's answer window stays");
    assert.match(attention, /After the exchange, still delegate a confirmation's unnamed yes: the backend needs your name or Kevin's Allow or Deny on screen\./);
    assert.match(attention, /If it refuses, say only the line it gives\./);
    assert.doesNotMatch(orders, /ask once more|instead of assuming/, "no ask of the voice's own beside the cue");
  } finally {
    await w.engine.stop();
  }
});

test("C1: the same unnamed yes kept back by the voice gets no cue and no refusal: the cue comes only through a delegation, so the orders must say to delegate it", async () => {
  const r = await rig(10);
  const { w } = r;
  try {
    await lateYes(r, false);
    assert.equal(w.brain.tasks.length, 0);
    assert.ok(w.engine.confirmations.pending, "the confirmation is still waiting, with nothing said to Kevin");
    assert.equal(cuesOf(r).length, 0, "no delegation, no cue");
    assert.equal(r.sock().events().filter((e) => e.type === "session.thinking.append").length, 0, "no delegation, no refusal");
  } finally {
    await w.engine.stop();
  }
});
