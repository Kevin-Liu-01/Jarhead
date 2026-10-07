import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "@jarhead/engine";
import { ROOM_COMMANDS, ROOM_TALK } from "../live-check.mts";
import { allPass, assertions, dryRun } from "./live-check-w2-8-dry.ts";

/**
 * W2-8: the spoken live checks, run dry. "Spoken" is typed text turned into PCM and fed as mic
 * frames: live, by gpt-4o-mini-tts; here, a marked tone the scripted server reads back. Never the
 * microphone, never played. These wait out the engine's own clocks (the 2.5 s output gate, a
 * shortened idle limit), so they take a few seconds each.
 */

test("LC-6 spoken-stop: the story sounds, the gate is set at the stop fragment, nothing reaches the sink inside it, and the story does not come back after it", async () => {
  const r = await dryRun("LC-6");
  allPass(r);
  assert.equal(r.speech.length, 6, "three stories, three stops");
  assert.ok(r.sink.some((f) => f.audible) && r.sink.some((f) => !f.audible), "the sink records sound and silence apart");
  for (const trial of [1, 2, 3]) {
    assert.ok(Number(r.metrics[`trial${trial}.storyAudibleBeforeStopMs`]) > 0, `trial ${trial}: the story was sounding`);
    assert.ok(Number(r.metrics[`trial${trial}.afterGateWatchMs`]) >= 500, `trial ${trial}: the harness watched after the gate lapsed`);
  }
  assert.equal(assertions(r, /after the gate lapses, at most an acknowledgement/).pass, true);
});

test("LC-7 room-talk, the stand-in as GPT-Live-1 measured (it answers the room and delegates its commands): nothing reaches the speaker, the brain or the hands; no goodnight sleep; the clause, then sleep at the idle limit after the exchange", async () => {
  const r = await dryRun("LC-7");
  allPass(r);
  // The gate was exercised: the stand-in answered the room and delegated a command (Live's own judgment, soft and
  // failing), and the engine refused every such delegation before the brain and kept every answer off the speaker.
  assert.deepEqual(r.standIn, { answersRoom: "reply-and-delegate" });
  assert.ok(String(r.metrics["roomReplyOnTheWire"]).length > 0, "the stand-in answered the room on the wire");
  const delegated = r.metrics["liveDelegatedRoom"] as string[];
  assert.ok(delegated.length > 0, "the stand-in delegated room talk");
  assert.equal(assertions(r, /^Live said nothing to the room/).pass, false);
  assert.equal(assertions(r, /^Live raised no delegation for room talk/).pass, false);
  assert.equal(assertions(r, /^no room talk reached the brain$/).pass, true);
  assert.equal(assertions(r, /^Live's room delegations were refused before the brain/).pass, true);
  // A refusal the session's end settled (raised inside the 1.2 s wait for a late name before the idle sleep, 16 of 566
  // dry runs on bc937ae) has no voice to close out: its finished row comes after the sleep row, written at the detach.
  const closeOut = r.metrics["refusedCloseOut"] as { id: string; closedBy: string | null }[];
  const letGo = r.ledger.findIndex((row) => row.type === "sleep" || row.type === "pause" || row.type === "stop");
  const createdFor = new Map(r.ledger.flatMap((row) => (row.type === "delegation.created" ? [[row.delegation.liveId, row.delegation.id] as const] : [])));
  const finishedAt = (liveId: string): number => r.ledger.findIndex((row) => row.type === "delegation.finished" && row.delegationId === createdFor.get(liveId));
  const voiced = closeOut.filter((c) => letGo < 0 || finishedAt(c.id) < letGo);
  assert.ok(closeOut.length === delegated.length && voiced.every((c) => c.closedBy === "session.thinking.append"), `each refusal made while the session was open closed with a silent thinking append: ${JSON.stringify(closeOut)}`);
  const firstRoom = r.marks.find((m) => m.name === "room");
  assert.equal(firstRoom?.data?.["line"], ROOM_TALK[0], "the room opens with a command");
  assert.ok(r.wire.outText.some((d) => d.t < (firstRoom?.t ?? 0)), "the opening exchange was answered before the room");
  assert.ok((firstRoom?.t ?? 0) - Number(r.metrics["lastAddressedBeforeRoomT"]) > Engine.EXCHANGE_WINDOW_MS, "the room starts once the exchange window has shut");
  const sleep = r.ledger.filter((row) => row.type === "sleep");
  assert.deepEqual(sleep.map((row) => (row.type === "sleep" ? row.cause : "")), ["idle"]);
  assert.ok(r.speech.some((s) => /goodnight/i.test(s.text)), "the room said goodnight");
  const lines = r.metrics["roomLines"] as { line: string; command: boolean; outsideWindow: boolean; heard?: boolean; asleep: boolean }[];
  const judged = lines.filter((l) => l.command && l.outsideWindow && !l.asleep && l.heard === true);
  assert.ok(judged.length >= 1, `a command was heard outside the exchange window: ${JSON.stringify(lines)}`);
  assert.ok(lines.some((l) => l.command && !l.outsideWindow && !l.asleep) || judged.length >= 2, "two commands are judged dry, unless a slow run let the clause reach one");
  assert.ok(judged.every((l) => ROOM_COMMANDS.has(l.line)));
  console.log(`[measure] LC-7 dry: ${judged.length} command line(s) judged outside the window: ${judged.map((l) => l.line).join(" | ")}`);
});

test("LC-10 speech-end: five spoken questions, speech end before each delegation, the gap recorded", async () => {
  const r = await dryRun("LC-10");
  allPass(r);
  assert.equal((r.metrics["speechEndToDelegationMs"] as number[]).length, 5);
});
