import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { PERMISSIONS_HINT, explainFsError, isMacOSBlock, macOSBlockedLine, tccGrantFor } from "../files.ts";
import { describeShellResult, macOSBlockInOutput, type ShellRunResult } from "../shell.ts";

/**
 * The "macOS blocked this" line: TCC answers a guarded read with EPERM and nothing
 * else, and these turn that errno into the one line the voice can say. Every case
 * here is a synthesized error or a synthesized stderr — no guarded path is touched
 * (a folder prompt could fire), and the home folder only names the paths.
 */

const HOME = homedir();
const eperm = (path: string): NodeJS.ErrnoException => Object.assign(new Error(`EPERM: operation not permitted, open '${path}'`), { code: "EPERM", errno: -1, syscall: "open", path });
const eacces = (path: string): NodeJS.ErrnoException => Object.assign(new Error(`EACCES: permission denied, open '${path}'`), { code: "EACCES", errno: -13, syscall: "open", path });
const enoent = (path: string): NodeJS.ErrnoException => Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: "ENOENT", errno: -2, syscall: "open", path });
const FDA = "Full Disk Access";
const DESKTOP = "access to the Desktop folder";
const line = (lacks: string): string => `macOS blocked this: Jarhead lacks ${lacks}. ${PERMISSIONS_HINT}`;
const partial = (lacks: string): string => `macOS blocked part of this: Jarhead lacks ${lacks}. ${PERMISSIONS_HINT}`;

test("tccGrantFor: the three folders and the Full Disk Access places, under every spelling; nothing else", () => {
  const cases: [string, string | undefined][] = [
    [join(HOME, "Desktop", "a.txt"), DESKTOP],
    [join(HOME, "Desktop"), DESKTOP],
    [join(HOME, "Desktop") + "/", DESKTOP],
    ["~/Desktop/a.txt", DESKTOP],
    ["$HOME/Documents/x", "access to the Documents folder"],
    ["~/Downloads", "access to the Downloads folder"],
    [join(HOME, "Library", "Mail", "V10"), FDA],
    ["~/Library/Safari/Bookmarks.plist", FDA],
    ["~/Library/Messages/chat.db", FDA],
    [join(HOME, ".Trash", "old.txt"), FDA],
    [`/private${join(HOME, "Library", "Safari")}`, FDA],
    [join(HOME, "Desktopper", "x"), undefined],
    [join(HOME, "Library.bak"), undefined],
    [join(HOME, "repos", "x"), undefined],
    ["/System/Library/x", undefined],
    ["/etc/hosts", undefined],
    ["Desktop/a.txt", undefined],
    ["~", undefined],
  ];
  for (const [path, want] of cases) assert.equal(tccGrantFor(path), want, path);
});

test("explainFsError: EPERM on a guarded path is the one line; EPERM elsewhere, EACCES and ENOENT stay what they were", () => {
  const desk = join(HOME, "Desktop", "a.txt");
  const mail = join(HOME, "Library", "Mail", "x");
  assert.equal(explainFsError(eperm(desk), desk), line(DESKTOP));
  assert.equal(explainFsError(eperm(mail), mail), line(FDA));
  assert.equal(explainFsError(eperm("/System/x"), "/System/x"), eperm("/System/x").message, "an EPERM macOS did not cause");
  assert.equal(explainFsError(eacces(desk), desk), eacces(desk).message, "a plain Unix denial is not a TCC block");
  assert.equal(explainFsError(enoent(desk), desk), enoent(desk).message);
  assert.equal(explainFsError("boom", desk), "boom");
  // The message form, for errors that lost their code on the way.
  assert.equal(explainFsError(new Error("EPERM: operation not permitted, scandir"), mail), line(FDA));
  assert.ok(isMacOSBlock(eperm(desk)));
  assert.ok(!isMacOSBlock(eacces(desk)));
  assert.equal(macOSBlockedLine("/System/x"), undefined);
});

test("macOSBlockInOutput: the path stderr names decides; the command is read only when stderr names none, and never a redirect's target", () => {
  const desk = join(HOME, "Desktop");
  const cases: { stderr: string; command?: string; want: string | undefined; note: string }[] = [
    { stderr: `ls: ${desk}: Operation not permitted`, want: line(DESKTOP), note: "ls on the Desktop" },
    { stderr: "zsh: operation not permitted: ~/Library/Mail", want: line(FDA), note: "zsh's own form, tilde" },
    { stderr: `find: ${join(HOME, "Library", "Safari")}: Operation not permitted`, want: line(FDA), note: "find's warning" },
    { stderr: "cat: Documents/notes.md: Operation not permitted", want: line("access to the Documents folder"), note: "a bare token is relative to the home folder" },
    { stderr: `cp: '${join(HOME, "Desktop", "my file.txt")}': Operation not permitted`, want: line(DESKTOP), note: "quoted path" },
    { stderr: "chflags: /System/x: Operation not permitted", command: `chflags nouchg /System/x > ~/Desktop/log.txt`, want: undefined, note: "stderr named a path TCC does not guard; the command is not consulted" },
    { stderr: "kill: kill 123 failed: operation not permitted", command: "kill 123 && echo done > ~/Desktop/done.txt", want: undefined, note: "no path in stderr; the Desktop is only a redirect target" },
    { stderr: "kill: kill 123 failed: operation not permitted", command: "kill 123 2>~/Desktop/err.txt >> ~/Documents/out.txt", want: undefined, note: "glued and doubled redirects" },
    { stderr: "zsh: operation not permitted", command: "ls ~/Library/Mail", want: line(FDA), note: "no path in stderr; the command's argument" },
    { stderr: "zsh: operation not permitted", command: "cat Downloads/x.pdf | head", want: line("access to the Downloads folder"), note: "a bare token in the command" },
    { stderr: "zsh: operation not permitted", command: "echo hi > ~/Desktop/x.txt", want: undefined, note: "only a redirect target in the command" },
    { stderr: "zsh: operation not permitted", want: undefined, note: "no path anywhere" },
    { stderr: `ls: ${desk}: No such file or directory`, want: undefined, note: "not an EPERM at all" },
    { stderr: `ls: ${desk}: Permission denied`, want: undefined, note: "EACCES stays what it is" },
    { stderr: "", command: "ls ~/Library", want: undefined, note: "nothing on stderr" },
  ];
  for (const c of cases) assert.equal(macOSBlockInOutput(c.stderr, c.command), c.want, c.note);
  assert.equal(macOSBlockInOutput(`ls: ${desk}: Operation not permitted`, undefined, true), partial(DESKTOP), "the partial wording");
});

test("describeShellResult: 'blocked this' when nothing came back, 'blocked part of this' when hits stand next to the warnings, nothing for a clean run", () => {
  const base: ShellRunResult = { stdout: "", stderr: "", code: 0, signal: null, timedOut: false, cancelled: false, ms: 10 };
  const safari = join(HOME, "Library", "Safari");
  // find over the home folder without FDA: hits on stdout, a warning per skipped folder, exit 1.
  const partialRun = describeShellResult({ ...base, stdout: "a\nb", stderr: `find: ${safari}: Operation not permitted`, code: 1 });
  assert.ok(partialRun.startsWith("[exit 1] a\nb"), partialRun);
  assert.ok(partialRun.endsWith(`\n${partial(FDA)}`), partialRun);
  // ls on the Desktop without the folder grant: nothing but the error.
  const blocked = describeShellResult({ ...base, stderr: `ls: ${join(HOME, "Desktop")}: Operation not permitted`, code: 1 });
  assert.ok(blocked.endsWith(`\n${line(DESKTOP)}`), blocked);
  // A command that succeeded says nothing about permissions.
  assert.equal(describeShellResult({ ...base, stdout: "ok" }), "ok");
  // A failure macOS did not cause keeps its stderr and gets no line.
  const other = describeShellResult({ ...base, stderr: "chflags: /System/x: Operation not permitted", code: 1 }, undefined, "chflags nouchg /System/x > ~/Desktop/log.txt");
  assert.equal(other, "[exit 1] [stderr] chflags: /System/x: Operation not permitted");
  // The command is what carries the path when the shell's message does not.
  const viaCommand = describeShellResult({ ...base, stderr: "zsh: operation not permitted", code: 1 }, undefined, "ls ~/Library/Mail");
  assert.ok(viaCommand.endsWith(`\n${line(FDA)}`), viaCommand);
});
