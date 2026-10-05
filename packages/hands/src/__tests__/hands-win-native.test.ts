import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * W2-4 (RF-9, RAIL-13, the helper's half). The helper's decisions on Kevin's behalf live in
 * packages/hands/native/HandsWin.swift as pure code over an injected event clock; the harness in
 * native/harness/hands-win compiles that file with its own main and drives it headless (no
 * CGEvent posted, no AX read, no window). The ops that call those decisions are pinned below by
 * their source: each one that posts or brings an app forward runs the guard before it acts.
 */

const native = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "native");
const swiftc = process.platform === "darwin" && spawnSync("swiftc", ["--version"], { encoding: "utf8" }).status === 0;

test("the hands-win decision harness passes: busy by count and by time, an own post never masks Kevin's, a type stops with the characters landed", { skip: swiftc ? false : "needs swiftc (macOS)", timeout: 240_000 }, () => {
  const out = mkdtempSync(join(tmpdir(), "hands-win-"));
  const r = spawnSync("sh", [join(native, "harness", "hands-win", "check.sh"), out], { encoding: "utf8", timeout: 230_000 });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /^hands-win: \d+ passed, 0 failed$/m);
  // The cases TRIAGE W2-4 names, by their words.
  for (const name of [
    "a foreign key 200 ms ago gives busy",
    "by count the foreign key still shows: busy",
    "1.05 s after the foreign key a guard is still held",
    "Kevin's key mid-type stops it as busy with 50 characters landed",
    "the focus moving to a sheet stops the type as focus_moved with 12 landed",
    "500 own posts counted late never stop the type",
    // The review's follow-ups: a skipped busy check still reads, the premise is logged, the focus is cheap to re-read.
    "the guard after a dictation is not held by Kevin's key from 10 s before",
    "a mouse up's read times Kevin's click at his click, not at our next post",
    "a count found behind our own post is told as such",
    "an unmoved focus is re-read with the element alone",
    "a focus that cannot be read twice running is not read again",
    "the front app check stays on after the misses",
    // The second review: a slow focus read, what a stop says landed, and a stop before anything went out.
    "a 40 ms focus read is re-armed from its end: about n*4/50 reads, not n",
    "a focus read slower than 50 ms is a miss: two, then the focus is not read again",
    "a long type into a slow app ends inside the client's timeout",
    "an AX-delivered first line, the Return, then busy: the first line plus one",
    "graphemes, not UTF-16 units: a whole walk counts the text's own length",
    "and that stop is the guard's refusal, with how long ago his key was",
  ]) {
    assert.ok(r.stdout.split("\n").includes(`ok - ${name}`), `harness case: ${name}\n${r.stdout}`);
  }
});

/** The body of `func <name>(` up to the next top-level `func` (or the end of the file). */
function body(source: string, name: string): string {
  const start = source.indexOf(`func ${name}(`);
  assert.ok(start >= 0, `${name} is in the source`);
  const next = source.indexOf("\nfunc ", start + 1);
  return source.slice(start, next < 0 ? undefined : next);
}

/** `first` appears in `text`, and before `then`. */
function before(text: string, first: string, then: string, what: string): void {
  const a = text.indexOf(first);
  const b = text.indexOf(then);
  assert.ok(a >= 0, `${what}: ${first} is there`);
  assert.ok(b >= 0, `${what}: ${then} is there`);
  assert.ok(a < b, `${what}: ${first} comes before ${then}`);
}

test("RAIL-13: move, focus_app and an activating open_app run the hands-win guard before they act", () => {
  const input = readFileSync(join(native, "Input.swift"), "utf8");
  const windows = readFileSync(join(native, "Windows.swift"), "utf8");
  before(body(input, "opMove"), "try guardActing(params)", "postMouseMove(", "opMove");
  before(body(windows, "opFocusApp"), "try guardActing(params)", ".activate(", "opFocusApp");
  before(body(windows, "opOpenApp"), "if activate { try guardActing(params) }", "launchApplication(", "opOpenApp");
  // The ops that already held stay held.
  for (const op of ["opClick", "opMouseDown", "opDrag", "opScroll", "opType", "opKey", "opHoldKey"]) {
    assert.match(body(input, op), /try guardActing\(params\)/, op);
  }
});

test("RF-9: the busy check reads the ledger (time and count), and every grapheme of a type asks the watch first", () => {
  const input = readFileSync(join(native, "Input.swift"), "utf8");
  assert.match(body(input, "kevinBusyMs"), /handsLedger\.busyMs\(sessionClock\)/);
  assert.match(body(input, "opUserIdle"), /handsLedger\.foreignMs\(sessionClock\)/);
  assert.match(body(input, "noteOwnPost"), /handsLedger\.noteOwnPost\(/);
  // The keystroke loop is the shared runGraphemes, and its cancel is the session's watch.
  const keystrokes = input.slice(input.indexOf("private func deliverKeystrokes("), input.indexOf("private func deliverPaste("));
  assert.match(keystrokes, /runGraphemes\(cell, cancel: \{ session\.cancelReason\(\) \}/);
  assert.match(input, /watch\.cancelReason\(stopped: typeCancelGeneration != generation, ledger: &handsLedger, clock: sessionClock\)/);
  // Dictation (ownDriver) types through Kevin's keys; everything else stops for them.
  assert.match(body(input, "opType"), /TypeWatch\(busyCheck: !ownDriver/);
  // A separator re-bases the focus it moved on purpose.
  assert.match(body(input, "opType"), /session\.watch\.front\.rebase\(\)/);
});

test("RF-9, second review: the focus re-read runs on the helper's clock, a stop counts what landed by the walk, and a stop before anything went out is the guard's refusal", () => {
  const input = readFileSync(join(native, "Input.swift"), "utf8");
  const type = body(input, "opType");
  // The watch is re-armed from the end of each re-read, on the same clock the ledger reads.
  assert.match(type, /FrontWatch\(pid: expectPid, focus: readFocus\(nil\), now: uptimeNow,/);
  // Cells and separators go through the shared walk, which counts every way a cell went in.
  assert.match(type, /let walk = try walkType\(text, separator: separator, cell: deliver\)/);
  assert.match(type, /"characters": walk\.landed, "total": total,/);
  // No deliverer keeps its own count, so none can forget one (the AX path did).
  assert.doesNotMatch(input, /session\.typed/);
  // Kevin's hands before anything went out: thrown as busy, which the runner retries silently.
  before(type, "if stopRefuses(why, landed: walk.landed, events: session.events) {", "throw HandsError.busy(", "opType");
});

test("a guard that skips the busy check still reads the ledger; the focus re-read is one AX call when nothing moved; count finds reach the debug log", () => {
  const input = readFileSync(join(native, "Input.swift"), "utf8");
  // Dictation (ownDriver) and mouse_up judge nothing, but their read attributes Kevin's events before their own posts.
  before(body(input, "guardActing"), "handsLedger.observe(sessionClock)", "try requireFront(params)", "guardActing");
  // The focused element is compared with the watched one before its window, role and subrole are read.
  before(body(input, "focusMark"), "if let base, base.element == AnyHashable(element) { return base }", "kAXWindowAttribute", "focusMark");
  assert.match(body(input, "opType"), /focusMark\(inApp: \$0, base: base\)/);
  // The premise check (K5's negative control): every event found by count goes to the helper's debug log.
  assert.match(input, /ledger\.onCountedForeign = \{[^}]*debugLog\(/);
});
