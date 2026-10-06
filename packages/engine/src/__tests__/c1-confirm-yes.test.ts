import { test } from "node:test";
import assert from "node:assert/strict";
import { settle } from "./world.ts";
import { liveOf, rig } from "./live-rig.ts";

/**
 * C1 (2026-10-06, Kevin approved): the voice's orders agree with the room-talk gate on a confirmation's yes. The gate
 * (voice-attention.ts, main 98c7cfe) refuses an unnamed yes to a waiting confirmation once the exchange has ended:
 * Jarhead's answer window never covers one, so it needs the name, or Allow / Deny in the island or the Console. The
 * voice still passes the yes on; the refusal comes back to it, and the engine has it say one cue. The orders used to
 * say only that answers to its question are for it, so the voice took that yes as given. This is the review's ADV-4
 * replay (room-talk-gate-review.test.ts) with the orders the engine opened the session with read beside it.
 */

test("C1: an unnamed yes 10 s after a send's question is refused with one cue, and the orders the session opened with say so: past the exchange a confirmation's answer needs the name or Allow / Deny, and a refused unnamed yes is asked once more", async () => {
  const r = await rig(10);
  const { w } = r;
  try {
    const T = 30_000;
    w.engine.confirmations.ask("send the message to ben", "messages", { text: "hi" });
    await r.run({ voiced: [[T + 1948, T + 2648]], at: [
      { t: T + 100, run: () => void liveOf(w).appendInstructions(null, `Say this to Kevin now, in these words: "Send it to Ben?" Then wait.`) },
      { t: T + 1686, run: () => r.output(" send it to ben?", T + 1600, T + 2400) },
      { t: T + 13_400, run: () => r.input(" yes.", T + 12_100, T + 12_400) },
      { t: T + 13_500, run: () => r.delegation("item_yes", T + 13_400) },
    ] }, T + 16_000);
    await settle(50);
    // The gate's half, as main has it.
    assert.equal(w.brain.tasks.length, 0, "the unnamed yes reached the brain");
    assert.ok(w.engine.confirmations.pending, "the confirmation is still waiting");
    const cues = r.sock().events().filter((e) => e.type === "session.instructions.append" && /say jarhead with the yes/.test(e.content ?? ""));
    assert.equal(cues.length, 1, "one cue: the voice asks once more");
    // The voice's half: the orders the session started with (its `session.start`, as sent to the server) say the same.
    const start = r.sock().sent.map((s) => JSON.parse(s.line) as { type: string; session?: { instructions?: string } }).find((e) => e.type === "session.start");
    const orders = start?.session?.instructions ?? "";
    const attention = orders.slice(orders.indexOf("# Attention"), orders.indexOf("# Backchannel policy"));
    assert.match(attention, /except answers to your question; typed lines always are\./, "a plain question's answer window stays");
    assert.match(attention, /After the exchange, a confirmation's answer needs your name, or Kevin's Allow or Deny on screen\./);
    assert.match(attention, /If the backend refuses an unnamed yes, ask once more, briefly, instead of assuming\./);
  } finally {
    await w.engine.stop();
  }
});
