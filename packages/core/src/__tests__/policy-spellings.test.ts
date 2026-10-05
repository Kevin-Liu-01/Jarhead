import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyAction, classifyAppleScript, classifyPath, shellSteals, type Verdict } from "../policy.ts";
import { secretsPresent, writeEnvSecrets } from "../env.ts";

/**
 * W1-6 (launch triage): the never list and the secret stores hold under every spelling.
 * The rails audit (scratchpad/launch/rails) found the gate keyed on one spelling of each
 * thing it guards: `newfs_apfs` is macOS's mkfs, APFS folds case so `~/.AWS` IS `~/.aws`,
 * the shell joins `.s'sh'` back into `.ssh`, a recursive grep reads every `.env` under a
 * folder, an interpreter prints the whole environment, and a Return in Messages sends.
 * Every row here was a miss at HEAD 6b3f35f. Pure: no file of the real home is read.
 */

const HOME = "/Users/tester";
const sh = (text: string, extra: { cwd?: string; app?: string } = {}) => classifyAction({ kind: "run_shell", text, home: HOME, cwd: extra.cwd ?? HOME, repoRoot: "/Users/tester/jarvis", ...(extra.app ? { app: extra.app } : {}) });

function table(rows: ReadonlyArray<readonly [string, Verdict, string?]>, extra: { cwd?: string } = {}): void {
  const wrong = rows.map(([cmd, want, note]) => ({ cmd, want, note, got: sh(cmd, extra) })).filter((r) => r.got.verdict !== r.want);
  assert.deepEqual(wrong.map((r) => `${r.want} ≠ ${r.got.verdict}: ${r.cmd}${r.note ? ` (${r.note})` : ""} — ${r.got.reason}`), []);
}

// ------------------------------------------------------------- RAIL-5 the never list ---

test("RAIL-5 never list: macOS's own spellings of format, erase, raw writes, power, rm of / or ~, and other apps' TCC resets are refused", () => {
  table([
    ["newfs_apfs /dev/disk4", "refuse", "macOS's mkfs"],
    ["/sbin/newfs_hfs -v X /dev/disk4s2", "refuse"],
    ["diskutil apfs eraseVolume disk3s5", "refuse"],
    ["diskutil APFS eraseVolume disk3s5", "refuse"],
    ["diskutil ap deleteContainer disk3", "refuse"],
    ["diskutil cs delete 1234-ABCD", "refuse"],
    ["diskutil appleRAID delete 1234-ABCD", "refuse"],
    ["asr restore --source /tmp/x.dmg --target /Volumes/X --erase", "refuse"],
    ["sudo asr restore -s a.dmg -t /Volumes/X --erase --noprompt", "refuse"],
    ['dd if=/tmp/x of="/dev/disk4"', "refuse"],
    ["dd if=/tmp/x of='/dev/rdisk4' bs=1m", "refuse"],
    ["cat /tmp/img > /dev/disk4", "refuse"],
    ["pv /tmp/img >/dev/rdisk4", "refuse"],
    ["dd if=/tmp/img 2>/dev/disk4", "refuse", "a stderr redirect writes the disk too"],
    ["cat /tmp/img | sudo tee /dev/rdisk4 >/dev/null", "refuse"],
    ["/sbin/shutdown -h now", "refuse"],
    ["sudo /sbin/reboot", "refuse"],
    ["\\shutdown -h now", "refuse"],
    ["'shutdown' -h now", "refuse"],
    ['"/sbin/halt"', "refuse"],
    ["SHUTDOWN -h now", "refuse", "APFS folds the command's name too"],
    ["rm -rf /*", "refuse"],
    ["rm -rf ~/*", "refuse"],
    ["rm -rf $HOME/*", "refuse"],
    ['rm -rf "$HOME"/*', "refuse"],
    ["rm -rf /Users/tester/*", "refuse"],
    ["rm --recursive --force /", "refuse"],
    ["rm --recursive --force ~", "refuse"],
    ["rm -r -f -- ~/", "refuse"],
    ["rm -rf build ~", "refuse", "the home folder as the second argument"],
    ["cd ~ && rm -rf *", "refuse"],
    ["cd / && rm -rf *", "refuse"],
    ["cd && rm -rf ./*", "refuse", "a bare cd goes home"],
    ["find ~ -delete", "refuse"],
    ["find / -delete", "refuse"],
    ["find $HOME -type f -delete", "refuse"],
    ["find ~ -exec rm -rf {} +", "refuse"],
    ["tccutil reset All # jarhead", "refuse", "a comment is not the bundle id"],
    ["tccutil reset ScreenCapture com.apple.Terminal  # fixing jarhead", "refuse"],
    ["tccutil reset All jarhead", "refuse"],
  ]);
  // The working directory is the home: a glob there is the home.
  assert.equal(sh("rm -rf *", { cwd: HOME }).verdict, "refuse");
  assert.equal(sh("rm -rf *", { cwd: "/" }).verdict, "refuse");
});

test("RAIL-5 never list: the controls stay where they were (a targeted delete asks, a mention is not a command)", () => {
  table([
    ["find ~ -name '*.log' -delete", "confirm", "a named delete asks; it is not the whole home"],
    ["rm -rf build", "confirm"],
    ["cd ~/proj && rm -rf *", "confirm"],
    ["dd if=/dev/zero of=/tmp/x bs=1m count=1", "run"],
    ["diskutil list", "run"],
    ["diskutil apfs list", "run"],
    ["asr imagescan --source /tmp/x.dmg", "run"],
    ["git commit -m 'shutdown: drain the queue first'", "run", "the word in a message is not the command"],
    ["cat ~/notes/reboot.md", "run"],
    ["tccutil reset Accessibility com.kevinliu.jarhead", "confirm", "Jarhead's own grant still asks"],
    ["tccutil reset All com.kevinliu.jarhead.ear-probe", "confirm"],
  ]);
  assert.equal(sh("rm -rf *", { cwd: `${HOME}/proj` }).verdict, "confirm");
});

// ------------------------------------------------------------- RAIL-3 the secret stores ---

test("RAIL-3 secret stores: case, quote splices, backslashes, braces, ANSI-C quotes, globs and variables inside a hidden name are refused", () => {
  table([
    ["cat ~/.SSH/id_ed25519", "refuse"],
    ["cat ~/.s'sh'/id_ed25519", "refuse"],
    ['cat ~/.s""sh/id_ed25519', "refuse"],
    ["cat ~/.s\\sh/id_ed25519", "refuse"],
    ["cat ~/.$'\\x73'sh/id_ed25519", "refuse"],
    ["cat ~/.{ssh,x}/id_ed25519", "refuse"],
    ["cat ~/.{x,SSH}/id_ed25519", "refuse"],
    ["cat ~/.Jarhead/ENV", "refuse"],
    ["cat ~/.jarhead/e'n'v", "refuse"],
    ["cat ~/.jarhead/WAKE-AUTH.json", "refuse"],
    ["cat ~/.AWS/credentials", "refuse"],
    ["cat ~/.a'w's/credentials", "refuse"],
    ["cat ~/.Codex/auth.json", "refuse"],
    ["cat ~/.claude/.Credentials.json", "refuse"],
    ["cat ~/LIBRARY/Keychains/login.keychain-db", "refuse"],
    ["cp ~/Library/Application\\ Support/Google/Chrome/Default/COOKIES /tmp/c", "refuse"],
    ["zip -r /tmp/c.zip ~/.CODEX", "refuse"],
    ["tar czf /tmp/x.tgz ~/.Jarhead", "refuse"],
    ["cat proj/.ENV", "refuse"],
    ["cat proj/.env*", "refuse", "a glob after the name"],
    ["cat proj/.e?v", "refuse"],
    ["cat proj/.[e]nv.local", "refuse"],
    ['cat ~/.s"$X"h/id_ed25519', "refuse", "a hidden name built from quotes and a variable"],
    ["cat proj/.env.$STAGE", "refuse"],
  ]);
  // The controls: ordinary dotfiles, examples and envrc stay readable.
  table([
    ["cat ~/.zshrc", "run"],
    ["ls ~/.config", "run"],
    ["cat proj/.env.example", "run"],
    ["cat proj/.envrc", "run"],
    ["cat ~/.gitconfig", "run"],
    ["echo $HOME/.local/bin", "run"],
    ["ls proj/.github", "run"],
  ]);
});

test("RAIL-3 secret stores: the path gate folds case (APFS) for every store", () => {
  for (const p of ["~/.SSH/id_ed25519", "~/.Ssh/id_ed25519", "~/.Jarhead/env", "~/.jarhead/ENV", "~/.AWS/credentials", "~/.Codex/auth.json", "~/.claude/.Credentials.json", "~/Library/KEYCHAINS/login.keychain-db", "~/.jarhead/wake-auth.JSON", "~/project/.ENV", "~/.GNUPG/x"]) {
    const d = classifyPath({ path: p, access: "read", home: HOME });
    assert.equal(d.verdict, "refuse", `${p} → ${d.verdict} (${d.reason})`);
  }
  assert.equal(classifyPath({ path: "~/.zshrc", access: "read", home: HOME }).verdict, "run");
  assert.equal(classifyPath({ path: "~/project/.env.example", access: "read", home: HOME }).verdict, "run");
  // AppleScript reads the same table.
  assert.equal(classifyAppleScript({ script: 'do shell script "cat ~/.SSH/id_ed25519"', home: HOME }).verdict, "refuse");
  assert.equal(classifyAppleScript({ script: 'read POSIX file "/Users/tester/.AWS/credentials"', home: HOME }).verdict, "refuse");
});

test("RAIL-3 recursive readers: a folder sweep that can reach a .env is refused unless .env* is excluded", () => {
  table([
    ["grep -r PASSWORD ~/code", "refuse"],
    ["grep -rn token .", "refuse"],
    ["grep -n -r token src", "refuse", "the recursive flag need not come first"],
    ["grep --recursive x src", "refuse"],
    ["grep -r --exclude='*.log' PASSWORD ~/code", "refuse", "an exclude that leaves .env in"],
    ["rg -uu DATABASE_URL ~/code", "refuse"],
    ["rg --hidden x .", "refuse"],
    ["rg -. x", "refuse"],
    ["ag --hidden x", "refuse"],
    ["ag -u x", "refuse"],
    ["ack x", "refuse", "ack reads dotfiles"],
    ["find ~/code -type f -exec cat {} +", "refuse"],
    ["find . -exec grep -l x {} \\;", "refuse"],
    ["grep -n -r password ~", "refuse", "the home sweep reads every flag, not only the first"],
  ]);
  table([
    ["grep -r --exclude='.env*' PASSWORD ~/code", "run"],
    ["grep -rn --include='*.ts' token src", "run"],
    ["rg DATABASE_URL ~/code", "run", "rg skips hidden files by default"],
    ["rg -uu -g '!.env*' DATABASE_URL ~/code", "run"],
    ["rg --hidden -g '*.ts' x", "run"],
    ["grep -n token file.txt", "run"],
    ["find . -name '*.ts' -exec grep -l x {} +", "run"],
    ["find ~/code -type f ! -name '.env*' -exec cat {} +", "run"],
  ]);
  const why = sh("grep -r PASSWORD ~/code").reason;
  assert.match(why, /\.env/, why);
  assert.match(why, /--exclude='\.env\*'/, "the reason says how to run it");
});

// ------------------------------------------------------------- RAIL-11 environment dumps ---

test("RAIL-11 environment dumps through an interpreter confirm; a named, non-secret variable runs", () => {
  table([
    ["node -p process.env", "confirm"],
    ["node -e 'console.log(JSON.stringify(process.env))'", "confirm"],
    ["python3 -c 'import os; print(dict(os.environ))'", "confirm"],
    ["python3 -c 'from os import environ; print(environ)'", "confirm"],
    ["perl -e 'print %ENV'", "confirm"],
    ["perl -e 'print $ENV{$_} for keys %ENV'", "confirm"],
    ["ruby -e 'p ENV.to_h'", "confirm"],
    ["php -r 'print_r(getenv());'", "confirm"],
    ["node -e 'console.log(process.env[k])'", "confirm", "a computed name can be any key"],
  ]);
  table([
    ["node -p process.env.PATH", "run"],
    ["python3 -c 'import os; print(os.environ[\"HOME\"])'", "run"],
    ["python3 -c 'import os; print(os.getenv(\"PATH\"))'", "run"],
    ["perl -e 'print $ENV{PATH}'", "run"],
    ["ruby -e 'p ENV[\"HOME\"]'", "run"],
    ["node -e 'console.log(1 + 1)'", "run"],
  ]);
});

// ------------------------------------------------------------- RAIL-1 keyboard sends ---

const CHAT = ["Messages", "Slack", "Discord", "WhatsApp", "Telegram", "Signal", "Microsoft Teams"];
const CHAT_SEND = ["Return", "return", "Enter", "KP_Enter", "cmd+Return", "ctrl+Return", "command+enter", "super+Return"];
const CHAT_NOT_SEND = ["shift+Return", "opt+Return", "alt+Return", "option+Return", "shift+Enter", "cmd+a", "Tab", "Escape", "cmd+d", "cmd+shift+d"];
const MAIL = ["Mail", "Microsoft Outlook", "Airmail", "Spark"];
const MAIL_SEND = ["cmd+Return", "command+enter", "super+Return", "cmd+shift+d", "cmd+D"];
const MAIL_NOT_SEND = ["Return", "Enter", "shift+Return", "cmd+d", "Tab", "cmd+shift+Return"];

test("RAIL-1 keyboard sends: Return in a chat app, cmd+Return or cmd+shift+D in a mail app, asks every time with no grant; a new line does not", () => {
  const wrong: string[] = [];
  const expect = (app: string, kind: string, text: string, want: Verdict, note = ""): void => {
    const d = classifyAction({ kind, app, text, target: "Message #general" });
    if (d.verdict !== want || (want === "confirm" && (d.grant !== undefined || !/sends the message/.test(d.reason)))) wrong.push(`${app} ${kind} ${JSON.stringify(text)} → ${d.verdict}${d.grant ? ` grant=${d.grant}` : ""} (${d.reason})${note ? `; ${note}` : ""}`);
  };
  for (const app of CHAT) {
    for (const key of CHAT_SEND) {
      expect(app, "key", key, "confirm");
      expect(app, "hold_key", key, "confirm");
    }
    for (const key of CHAT_NOT_SEND) expect(app, "key", key, "run", "not a send");
    for (const text of ["Running late, there at 8\n", "line one\r", "a\nb"]) expect(app, "type", text, "confirm", "a typed newline is a Return");
    expect(app, "type", "Running late, there at 8", "run");
    if (classifyAction({ kind: "key", app, text: "Return", confirmed: true }).verdict !== "run") wrong.push(`${app} Return after a yes`);
  }
  for (const app of MAIL) {
    for (const key of MAIL_SEND) {
      expect(app, "key", key, "confirm");
      expect(app, "hold_key", key, "confirm");
    }
    for (const key of MAIL_NOT_SEND) expect(app, "key", key, "run", "a new line or a field change in a mail composer");
    expect(app, "type", "Hi Ben,\n\nRunning late.\n", "run", "a mail body has paragraphs");
  }
  for (const app of ["TextEdit", "Notes", "Terminal", "Xcode", "Google Chrome"]) {
    for (const key of [...CHAT_SEND, ...MAIL_SEND]) expect(app, "key", key, "run", "not a mail or chat app");
    expect(app, "type", "line\n", "run");
  }
  // A money or password app: Return submits the form.
  const venmo = classifyAction({ kind: "key", app: "Venmo", text: "Return" });
  if (venmo.verdict !== "confirm" || !/submits what was typed/.test(venmo.reason)) wrong.push(`Venmo Return → ${venmo.verdict} (${venmo.reason})`);
  assert.deepEqual(wrong, []);
});

test("RAIL-1 keyboard sends: the page decides in a browser (chat and mail hosts, a site's message pages), a search field is not a compose field, and the presence gate holds the send", () => {
  const key = (url: string, text = "Return") => classifyAction({ kind: "key", app: "Google Chrome", text, url });
  for (const url of ["https://app.slack.com/client/T0123/C0456", "https://discord.com/channels/1/2", "https://web.whatsapp.com/", "https://www.messenger.com/t/1", "https://x.com/messages/1-2", "https://www.linkedin.com/messaging/thread/1/"]) {
    assert.equal(key(url).verdict, "confirm", url);
    assert.equal(classifyAction({ kind: "type", app: "Google Chrome", text: "hi\n", url }).verdict, "confirm", url);
    assert.equal(classifyAction({ kind: "browser_type", app: "Google Chrome", text: "hi\n", url }).verdict, "confirm", url);
  }
  for (const url of ["https://mail.google.com/mail/u/0/#inbox", "https://outlook.office.com/mail/"]) {
    assert.equal(key(url, "cmd+Return").verdict, "confirm", url);
    assert.equal(key(url).verdict, "run", `${url}: Return in a mail body is a new line`);
  }
  for (const url of ["https://example.com/", "https://x.com/home", "https://github.com/a/b/issues"]) assert.equal(key(url).verdict, "run", url);
  // The search box of a chat app is where Return searches.
  assert.equal(classifyAction({ kind: "key", app: "Slack", text: "Return", target: "Search" }).verdict, "run");
  assert.equal(classifyAction({ kind: "key", app: "Messages", text: "Return", target: "AXSearchField" }).verdict, "run");
  assert.equal(classifyAction({ kind: "key", app: "Slack", text: "Return", target: "Message #search-team" }).verdict, "confirm", "a channel named search is still a compose field");
  // Away from the Mac, the send is held, not asked.
  const away = classifyAction({ kind: "key", app: "Messages", text: "Return", presence: { recent: true, unlocked: false, frontmost: true } });
  assert.equal(away.verdict, "confirm");
  assert.equal(away.hold, true);
  // A password field stays refused, whatever the key.
  assert.equal(classifyAction({ kind: "key", app: "1Password", text: "Return", secureField: true }).verdict, "refuse");
});

// ------------------------------------------------------------- RAIL-8 keystrokes by shell ---

test("RAIL-8 keystrokes by shell: an inner shell's open or osascript fronts an app, and osascript keystrokes are judged against the app in front", () => {
  const ks = `tell application "System Events" to keystroke "hunter2"`;
  assert.equal(shellSteals(`bash -c "osascript -e '${ks}'"`), true);
  assert.equal(shellSteals("bash -c 'open -a Slack'"), true);
  assert.equal(shellSteals("sh -c 'cd /tmp && open -a Slack'"), true);
  assert.equal(shellSteals("eval 'osascript -e \"beep\"'"), true);
  assert.equal(shellSteals("bash -c 'open -g ~/x.pdf'"), false);
  assert.equal(shellSteals("echo 'open -a Slack'"), false, "a quoted separator is still an argument");
  assert.equal(shellSteals("bash -c 'pnpm test'"), false);
  // The front app reaches the AppleScript gate through the shell.
  const viaTool = classifyAppleScript({ script: ks, home: HOME, app: "1Password" }).verdict;
  assert.equal(viaTool, "confirm");
  assert.equal(sh(`osascript -e '${ks}'`, { app: "1Password" }).verdict, viaTool);
  assert.equal(sh(`bash -c "osascript -e '${ks}'"`, { app: "1Password" }).verdict, viaTool);
  // A Return by AppleScript into a messaging app in front is a send.
  assert.equal(classifyAppleScript({ script: 'tell application "System Events" to keystroke return', home: HOME, app: "Messages" }).verdict, "confirm");
  assert.equal(classifyAppleScript({ script: 'tell application "System Events" to key code 36', home: HOME, app: "Slack" }).verdict, "confirm");
  assert.equal(sh(`osascript -e 'tell application "System Events" to keystroke return'`, { app: "Messages" }).verdict, "confirm");
  assert.equal(classifyAppleScript({ script: 'tell application "System Events" to keystroke return', home: HOME, app: "TextEdit" }).verdict, "run");
  assert.equal(classifyAppleScript({ script: 'tell application "System Events" to keystroke return using {shift down}', home: HOME, app: "Messages" }).verdict, "run", "shift+Return is a new line");
  assert.equal(classifyAppleScript({ script: 'tell application "System Events" to keystroke return', home: HOME, app: "Mail" }).verdict, "run", "Return in a mail body is a new line");
  assert.equal(classifyAppleScript({ script: 'tell application "System Events" to keystroke "d" using {command down, shift down}', home: HOME, app: "Mail" }).verdict, "confirm", "Mail's Send");
  assert.equal(classifyAppleScript({ script: 'tell application "Messages" to activate\ntell application "System Events" to keystroke return', home: HOME }).verdict, "confirm", "the app the script names");
});

// ------------------------------------------------------------- INS-4 an exported key ---

test("INS-4: an `export KEY=value` line in ~/.jarhead/env is read as KEY (never as a variable named 'export KEY'), and a write replaces it in place", () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-envx-"));
  const saved = { state: process.env["JARHEAD_STATE_DIR"], key: process.env["OPENAI_API_KEY"] };
  try {
    writeFileSync(join(dir, "env"), "# mine\nexport OPENAI_API_KEY=sk-test-fake-export-0123456789abcdef\nexport FOO_SETTING=1\n", { mode: 0o600 });
    delete process.env["OPENAI_API_KEY"];
    process.env["JARHEAD_STATE_DIR"] = dir;
    assert.equal(secretsPresent().openai, true, "the key the user wrote is seen");
    assert.equal(process.env["OPENAI_API_KEY"], "sk-test-fake-export-0123456789abcdef");
    assert.deepEqual(Object.keys(process.env).filter((k) => /\s/.test(k)), [], "no variable with a space in its name rides into a child");
    writeEnvSecrets({ OPENAI_API_KEY: "sk-test-fake-rotated-0123456789abcdef" });
    assert.equal(readFileSync(join(dir, "env"), "utf8"), "# mine\nOPENAI_API_KEY=sk-test-fake-rotated-0123456789abcdef\nexport FOO_SETTING=1\n", "the exported line is replaced, not duplicated");
  } finally {
    if (saved.state === undefined) delete process.env["JARHEAD_STATE_DIR"];
    else process.env["JARHEAD_STATE_DIR"] = saved.state;
    if (saved.key === undefined) delete process.env["OPENAI_API_KEY"];
    else process.env["OPENAI_API_KEY"] = saved.key;
    rmSync(dir, { recursive: true, force: true });
  }
});
