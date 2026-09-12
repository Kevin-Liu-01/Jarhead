import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CAPABILITIES, buildLiveInstructions } from "../instructions.ts";

/**
 * The voice's standing orders: the sleep cue ("night." and the words handed to the
 * backend unchanged; never for the interrupt words, never for a task that merely
 * sounds like sleep), the second-hands capability line, the section order, and the
 * word budget — the Live prompting guide wants handoff rules, not procedures, so the
 * orders stay under the same 1100-word ceiling as the brain's.
 */

const words = (s: string): number => s.split(/\s+/).filter(Boolean).length;

test("the sections come in a fixed order and Sleep sits between Narration and Safety", () => {
  const live = buildLiveInstructions({ alwaysOn: true });
  const order = ["# Personality and tone", "# Attention", "# Backchannel policy", "# Interruption policy", "# Delegation policy", "# Narration", "# Sleep", "# Safety", "# Changing Jarhead itself", "# Names and numbers"];
  const at = order.map((h) => live.indexOf(h));
  assert.ok(at.every((i) => i >= 0), `every section present: ${JSON.stringify(order.filter((_h, i) => at[i]! < 0))}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at, "in order");
});

test("sleep: a dismissal addressed to Jarhead is exactly \"night.\" plus a delegate of the words unchanged; stop/cancel and look-alike tasks never sleep it", () => {
  const live = buildLiveInstructions();
  const sleep = live.slice(live.indexOf("# Sleep"), live.indexOf("# Safety"));
  assert.match(sleep, /say exactly "night\." and nothing else/);
  assert.match(sleep, /delegate his words unchanged/);
  for (const cue of ['"go to sleep"', '"shut off"', '"goodnight"', '"that\'s all"', '"power down"', '"dismissed"']) assert.ok(sleep.includes(cue), cue);
  assert.match(sleep, /Never for "stop" or "cancel": those are the interrupt/);
  assert.match(sleep, /Never for "turn off the lights" or "shut down my Mac": those are tasks/);
  assert.doesNotMatch(sleep, /goodnight back|good night to you/i, "never a goodnight back — one word");
  // The interrupt rule still stands where it was: "stop" means stopped, not asleep.
  assert.match(live, /When Kevin says "stop", "cancel" or "never mind", say "stopped"/);
  // The idle clause is untouched: the engine's own announcement before an idle sleep.
  assert.match(live, /When you are told you are about to sleep, say so in one clause \("going to sleep"\)/);
});

test("capabilities: one line says the backend can split independent work across a second pair of hands (worker_start / worker_wait) and how each lane behaves — and says nothing about speaking, so the voice adds no split line of its own", () => {
  const line = DEFAULT_CAPABILITIES.filter((c) => /second pair of hands/.test(c));
  assert.equal(line.length, 1, "exactly one line");
  assert.match(line[0]!, /\(worker_start \/ worker_wait\)/, "the tools by name, as DECISIONS §3.10 asks; brain.test pins them to real tools");
  assert.match(line[0]!, /background hand works through Apple events, the browser, files, shell and web, never the pointer/);
  assert.match(line[0]!, /screen hand waits its turn for the mouse and keyboard/);
  // "<Name> alongside." and the finish lines are Jarhead's own (queueCommentary); a speech
  // clause here read as a "Backend tools" bullet would invite a second, voice-side ack.
  assert.doesNotMatch(line[0]!, /\bline\b|\bsay\b|\bspeak\b|finishes/);
  assert.ok(line[0]!.split(/\s+/).length <= 40, `${line[0]!.split(/\s+/).length} words — the other lines are 15–30`);
  assert.ok(buildLiveInstructions().includes(`- ${line[0]}`), "the default orders carry it");
});

test("the orders stay within the word budget (≤ 1100 words with the always-on gate) and carry no markdown beyond the section headers", () => {
  const live = buildLiveInstructions({ alwaysOn: true });
  const n = words(live);
  assert.ok(n <= 1100, `${n} words`);
  assert.ok(n >= 900, `${n} words — a section went missing`);
  assert.ok(!/[*`]/.test(live), "no markdown in a spoken prompt");
  assert.ok(!/^#{2,}/m.test(live), "one level of headers");
});
