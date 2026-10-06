import { test } from "node:test";
import assert from "node:assert/strict";
import { appleScriptShellLines, shellFocus } from "@jarhead/core";
import { needsFocus } from "../threads/index.ts";

/**
 * W3-1 review: the lanes and the tool runner's hold for Kevin's hands read ONE judgment of a shell line (core's
 * `shellFocus`). Before, the runner judged with `shellSteals` alone, case by case, and missed what the lane caught:
 * a group, a substitution, a shell fed on stdin, a head in capitals (macOS runs `OPEN` as `open`). The main lane then
 * ran those under the lease without the hold. An AppleScript's `do shell script` line is screen work as run_shell's
 * is, so a background thread is refused it too. Pure functions; nothing runs.
 */

const FRONTING = ["(open -a Notes)", "{ open -a Notes; }", "echo $(open -a Notes)", "echo `open -a Notes`", "OPEN -a Notes", "Open -b com.apple.Notes", "BASH -c 'open -a Notes'", "/BIN/ZSH -lc 'open -a Notes'"];

test("W3-1: a group, a substitution, a capital head and an inner shell in capitals front an app, for the lane and the hold alike", () => {
  for (const command of FRONTING) {
    assert.equal(shellFocus(command), "fronts", command);
    assert.equal(needsFocus("run_shell", { command }), true, command);
  }
  assert.equal(shellFocus("echo 'open -a Notes' | sh"), "stdin", "what a shell on stdin runs is unread: screen work");
  assert.equal(shellFocus("echo 'open -a Notes' | SH"), "stdin");
  for (const command of ["open -g -a Notes", "echo 'open -a Notes'", "grep -i open notes.txt | wc -l", "ls ~/Documents", "echo $(date +%s)"]) {
    assert.equal(shellFocus(command), undefined, command);
    assert.equal(needsFocus("run_shell", { command }), false, command);
  }
});

test("W3-1: an AppleScript whose do shell script line fronts an app is screen work (a background thread is refused it); one that lists files is not", () => {
  assert.deepEqual(appleScriptShellLines('do shell script "open -a \\"Notes\\""'), ['open -a "Notes"'], "unescaped");
  assert.deepEqual(appleScriptShellLines('do shell script "open " & "-a Notes"'), ["open -a Notes"], "literals folded first");
  assert.equal(needsFocus("applescript", { script: 'do shell script "open -a Notes"' }), true);
  assert.equal(needsFocus("applescript", { script: 'do shell script "(open -b com.apple.Notes)"' }), true);
  assert.equal(needsFocus("applescript", { script: 'do shell script "open -a " & quoted form of "Notes"' }), true, "the literal head is judged");
  assert.equal(needsFocus("applescript", { script: 'do shell script "ls ~/Documents"' }), false);
  assert.equal(needsFocus("applescript", { script: 'do shell script "open -g -a Notes"' }), false, "a background open fronts nothing");
  assert.equal(needsFocus("applescript", { script: 'tell application "Music" to playpause' }), false);
});
