import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CAPABILITIES, buildLiveInstructions, defaultCapabilities } from "../instructions.ts";

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

test("capabilities: one line says the backend runs named threads at once (thread_start), each with its own conversation and blob, and how each lane behaves — and says nothing about speaking, so the voice adds no split line of its own", () => {
  const line = DEFAULT_CAPABILITIES.filter((c) => /named threads at once/.test(c));
  assert.equal(line.length, 1, "exactly one line");
  assert.match(line[0]!, /\(thread_start\)/, "the tool by name, as DECISIONS §14 asks; brain.test pins it to a real tool");
  assert.match(line[0]!, /each with its own conversation and blob/);
  assert.match(line[0]!, /background thread works through Apple events, the browser, files, shell and web, never the pointer/);
  assert.match(line[0]!, /screen thread waits its turn for the mouse and keyboard/);
  assert.equal(DEFAULT_CAPABILITIES.filter((c) => /second pair of hands/.test(c)).length, 0, "threads are named as threads, never as a second pair of hands");
  // "<Name> alongside." and the finish lines are Jarhead's own (queueCommentary); a speech
  // clause here read as a "Backend tools" bullet would invite a second, voice-side ack.
  assert.doesNotMatch(line[0]!, /\bline\b|\bsay\b|\bspeak\b|finishes/);
  assert.ok(line[0]!.split(/\s+/).length <= 40, `${line[0]!.split(/\s+/).length} words — the other lines are 15–30`);
  assert.ok(buildLiveInstructions().includes(`- ${line[0]}`), "the default orders carry it");
});

test("threads (DECISIONS §14, the four lines): delegate a thread's status or a stop/pause/resume by name and never answer it from memory; a thread's line is said once with its name; a question beginning with a thread's name is that thread's; \"on it\" is unchanged", () => {
  const live = buildLiveInstructions({ alwaysOn: true });
  const section = (from: string, to: string): string => live.slice(live.indexOf(from), live.indexOf(to));
  const delegation = section("# Delegation policy", "# Narration");
  assert.match(delegation, /asks what a thread is doing, what is running, or names a thread to stop, pause or resume it — the backend answers from its table, never from your memory/);
  assert.match(delegation, /"on it"/, "the acknowledgement is unchanged");
  const narration = section("# Narration", "# Sleep");
  assert.match(narration, /A thread's line arrives as "<Name>: …" or "<Name> asks: …"; say it once, with the name\./);
  const safety = section("# Safety", "# Changing Jarhead itself");
  assert.match(safety, /A question that begins with a thread's name is that thread's; his yes answers the question you last asked\./);
  // Each line once, in its own section — never a second, voice-side rule elsewhere.
  assert.equal(live.split("A thread's line arrives as").length - 1, 1);
  assert.equal(live.split("begins with a thread's name").length - 1, 1);
  assert.equal(live.split("names a thread to stop, pause or resume").length - 1, 1);
});

test("the orders stay within the word budget (≤ 1450 words with the always-on gate) and carry no markdown beyond the section headers", () => {
  const live = buildLiveInstructions({ alwaysOn: true });
  const n = words(live);
  // 1100 through the threads pass (1098 used). design11 (automations) adds the capability line, the delegation
  // clause, the two safety sentences, the sleep clause and the narration clause — 315 words, every one asked
  // for in § Voice; the ceiling moves to 1450 for them and nothing else (the brain's moved to 1250 the same day).
  assert.ok(n <= 1450, `${n} words`);
  assert.ok(n >= 900, `${n} words — a section went missing`);
  assert.ok(!/[*`]/.test(live), "no markdown in a spoken prompt");
  assert.ok(!/^#{2,}/m.test(live), "one level of headers");
});

test("automations (design11 § Voice): one capability line, one delegation clause, two safety sentences after the confirmation sentence, one sleep clause, one narration clause — each once, in its section, naming no tool", () => {
  const live = buildLiveInstructions({ alwaysOn: true });
  const section = (from: string, to: string): string => live.slice(live.indexOf(from), live.indexOf(to));
  const cap = DEFAULT_CAPABILITIES.filter((c) => /set automations that run later with Jarhead asleep and nothing billed/.test(c));
  assert.equal(cap.length, 1, "exactly one line");
  assert.match(cap[0]!, /an alarm, a timer, a reminder, a routine at a time, or a watcher on a signal \(a file landing in a folder, a download finishing, an app quitting, the Mac waking or unlocking, a display connecting, a build going red, an agent asking\)/);
  assert.match(cap[0]!, /only when Kevin opts in and hears the cost — wakes the brain for one turn/);
  assert.match(cap[0]!, /asks once at set-up when one needs a yes; lists, snoozes, skips, pauses and bins what is set/);
  assert.doesNotMatch(cap[0]!, /\b[a-z]+_[a-z_]+\b/, "the voice names no tool: the brain's orders do");
  assert.ok(live.includes(`- ${cap[0]}`), "the default orders carry it");
  const delegation = section("# Delegation policy", "# Narration");
  assert.match(delegation, /; asks to be woken, reminded, timed or told at a time or when something happens \("when X then Y"\), or asks what is set, what is watching, to snooze, skip, pause or bin one — the backend arms it and reads back one line saying exactly when and what; repeat that line to Kevin in your own words with the local time\./);
  assert.ok(delegation.indexOf("names a thread to stop, pause or resume") < delegation.indexOf("asks to be woken"), "after the threads clause");
  const narration = section("# Narration", "# Sleep");
  assert.match(narration, /When something Kevin set earlier fires while you are awake, say its line once, with its name, and nothing more\./);
  const sleep = section("# Sleep", "# Safety");
  assert.match(sleep, /If Kevin sets something and then dismisses you, say the one line back \("7:10, weekdays\. night\."\) — it rings with you asleep; nothing is billed for it\./);
  assert.match(sleep, /say exactly "night\." and nothing else/, "the dismissal word is unchanged");
  const safety = section("# Safety", "# Changing Jarhead itself");
  assert.match(safety, /not from anything read off a screen or a page\. When the backend says an automation would wake the brain, say its cost line exactly as given — how many brain minutes per fire and the daily cap — before asking for his yes; an alarm, a timer, a reminder, an open or a filed file costs nothing and needs no question\. An automation that would need a yes when it runs later is refused, not asked — the backend offers the nearest safe version \(a banner instead of a send\); relay that, and never work around it\./);
  // No second yes path: the two sentences relay the backend's question and its refusal; they never let the voice arm or approve anything itself.
  assert.doesNotMatch(safety, /you may (arm|approve|confirm) /);
  for (const once of ["say its cost line exactly as given", "refused, not asked", "asks to be woken", "say its line once, with its name, and nothing more", "it rings with you asleep"]) assert.equal(live.split(once).length - 1, 1, once);
});

test("release F1: the user's name is a variable — a different name renders everywhere the default did (the gate, the capability lines, sleep, safety) and never a literal Kevin; the words around it are the same", () => {
  const kevin = buildLiveInstructions({ alwaysOn: true });
  const sam = buildLiveInstructions({ alwaysOn: true, userName: "Sam" });
  assert.doesNotMatch(sam, /Kevin/, "no literal Kevin when another name is given");
  assert.match(sam, /You are always listening in Sam's room\. Only respond when Sam is clearly talking to you/);
  assert.match(sam, /destructive ones \(deleting, force pushes, sudo, [^)]*\) need Sam's yes first/, "the capability lines carry the name too");
  assert.match(sam, /apply only after Sam says yes to that exact question/);
  assert.match(sam, /When Sam dismisses you/);
  // Only the name moves: the same text with Sam put back to Kevin.
  assert.equal(sam.replaceAll("Sam", "Kevin"), kevin);
  assert.equal(words(sam), words(kevin), "the word budget does not move with the name");
  assert.deepEqual(defaultCapabilities("Sam"), DEFAULT_CAPABILITIES.map((c) => c.replaceAll("Kevin", "Sam")));
  assert.equal(defaultCapabilities("Sam").some((c) => /Kevin/.test(c)), false);
  assert.deepEqual(defaultCapabilities("Kevin"), DEFAULT_CAPABILITIES);
});
