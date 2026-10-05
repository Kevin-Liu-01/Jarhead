import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resultText } from "../runner.ts";
import { realPathOf, tccGrantFor } from "../files.ts";
import { redactSecrets } from "../shell.ts";
import { railsNamed, railsTouched } from "../selfedit.ts";
import { makeRunner, makeSink, makeTask } from "./fakes.ts";

/**
 * W1-6 (launch triage), the runner's half: the secret stores hold under every spelling
 * through the real tools (read_file, run_shell) over a fake home holding canary values,
 * the redactor strikes the shapes nobody told it about, a /private home is one home, and
 * a self-edit to where a yes is decided names a rail. Nothing of the real home is read.
 */

const scratch = mkdtempSync(join(tmpdir(), "jh-w16-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** A fake home with fake secret stores (canary values, never real ones). */
function fakeHome(): string {
  const home = mkdtempSync(join(scratch, "home-"));
  mkdirSync(join(home, ".aws"), { recursive: true });
  writeFileSync(join(home, ".aws", "credentials"), "[default]\naws_access_key_id = AKIAIOSFODNN7EXAMPLE\naws_secret_access_key = CANARYsecretAccessKey0000000000000000000a\n");
  mkdirSync(join(home, "proj"), { recursive: true });
  writeFileSync(join(home, "proj", ".env"), "DATABASE_URL=postgres://app:CANARY-db-password@db.internal/app\n");
  writeFileSync(join(home, "proj", "app.ts"), "export const port = 3000;\n");
  return home;
}

test("RAIL-3: read_file of ~/.AWS/credentials (APFS folds case) is refused like ~/.aws, and realPathOf answers the spelling on disk", async () => {
  const home = fakeHome();
  const { runner } = makeRunner({ home });
  runner.attach(makeSink().sink, makeTask("what region is my default profile in"));
  for (const path of ["~/.aws/credentials", "~/.AWS/credentials", "~/.Aws/Credentials", `${home}/proj/.ENV`]) {
    const text = resultText((await runner.run("read_file", { path })).result);
    assert.match(text, /^error: refused: /, `${path}: ${text}`);
    assert.ok(!text.includes("CANARY"), `${path} reached the model: ${text}`);
  }
  assert.equal(realPathOf(join(home, ".AWS", "Credentials")), realPathOf(join(home, ".aws", "credentials")), "the real path is the one on disk");
  assert.equal(realPathOf(join(home, ".AWS", "new.txt")), join(realPathOf(join(home, ".aws")), "new.txt"), "a file not there yet: its parent's real spelling");
});

test("RAIL-3: run_shell by a case, quote, brace or glob spelling, or a recursive grep over the folder, never hands a canary to the model", async () => {
  const home = fakeHome();
  const { runner } = makeRunner({ home });
  runner.attach(makeSink().sink, makeTask("check my aws profile"));
  const leaked: string[] = [];
  for (const command of [`cat ${home}/.AWS/credentials`, `cat ${home}/.a'w's/credentials`, `cat ${home}/.{aws,x}/credentials`, `cat ${home}/proj/.ENV`, `cat ${home}/proj/.e?v`, `grep -r CANARY ${home}/proj`, `cd ${home}/proj && grep -rn CANARY .`, `rg -uu CANARY ${home}/proj`]) {
    const text = resultText((await runner.run("run_shell", { command })).result);
    if (/CANARY/.test(text) || !/^error: refused: /.test(text)) leaked.push(`${command.replaceAll(home, "~")} → ${text.slice(0, 160)}`);
  }
  assert.deepEqual(leaked, []);
  // The sweep with .env excluded runs, and finds what is not secret.
  const ok = resultText((await runner.run("run_shell", { command: `grep -rn --exclude='.env*' port ${home}/proj` })).result);
  assert.match(ok, /app\.ts:1:export const port = 3000;/, ok);
});

test("the redactor strikes an AWS secret key line, a URL's password and a password=, secret: or token= value, and leaves code alone", () => {
  const r = (s: string): string => redactSecrets(s, []);
  assert.equal(r("aws_secret_access_key = CANARYsecretAccessKey0000000000000000000a"), "aws_secret_access_key = [redacted secret]");
  assert.equal(r("aws_secret_access_key=wJalrXUtnFEMIKMDENGbPxRfiCYEXAMPLEKEYabcd"), "aws_secret_access_key=[redacted secret]", "letters only: the line's name says what it is");
  assert.equal(r("DATABASE_URL=postgres://app:CANARY-db-password@db.internal/app"), "DATABASE_URL=postgres://app:[redacted secret]@db.internal/app");
  assert.equal(r("redis://:p4ssw0rd-x@cache:6379/0"), "redis://:[redacted secret]@cache:6379/0");
  assert.equal(r('password: "hunter22x"'), 'password: "[redacted secret]"');
  assert.equal(r("DB_PASSWORD=hunter2!x"), "DB_PASSWORD=[redacted secret]");
  assert.equal(r("client_secret=abc123def456"), "client_secret=[redacted secret]");
  assert.equal(r('{"access_token": "ya29.a0AfH6SMBx"}'), '{"access_token": "[redacted secret]"}');
  // Code, words and what is already struck stay as they were.
  for (const same of ["const token = getToken();", "const secret = process.env.SECRET;", "password: required", "token=null", "OPENAI_API_KEY=[redacted secret]", "secret: [redacted secret]", "https://github.com/Kevin-Liu-01/Jarhead", "git@github.com:org/repo.git", "http://localhost:3000/@scope/pkg", "the token budget is 4000 tokens"]) {
    assert.equal(r(same), same, same);
  }
});

test("BL-07..10: a home spelled under /private (a temp HOME on macOS) is the same home to the TCC folders, on both sides", () => {
  const home = "/private/tmp/jh-home.x";
  assert.equal(tccGrantFor("/private/tmp/jh-home.x/Desktop/a.txt", home), "access to the Desktop folder");
  assert.equal(tccGrantFor("/tmp/jh-home.x/Desktop/a.txt", home), "access to the Desktop folder");
  assert.equal(tccGrantFor("~/Documents/x", home), "access to the Documents folder");
  assert.equal(tccGrantFor("/tmp/jh-home.x/Library/Safari", home), "Full Disk Access");
  assert.equal(tccGrantFor("/private/tmp/jh-home.x/Library/Safari", "/tmp/jh-home.x"), "Full Disk Access");
  assert.equal(tccGrantFor("/private/tmp/jh-home.x/Desktopper/x", home), undefined);
  assert.equal(tccGrantFor("/tmp/other/Desktop/a.txt", home), undefined);
});

test("RAIL-12: a self-edit to where a yes is decided or a lane's yes is routed names a rail, and the typed yes in the engine is a hunk rail", () => {
  const diff = "@@ -1 +1 @@\n-const isYes = YES_PATTERN.test(x);\n+const isYes = /^(yes|yeah|ok|sure|no)/i.test(x);\n";
  for (const file of ["packages/brain/src/delegator.ts", "packages/hands/src/lanes.ts", "packages/brain/src/browser.ts", "packages/engine/src/threads/runner.ts", "packages/engine/src/threads/lines.ts", "packages/engine/src/engine.ts"]) {
    const rails = railsTouched([file], () => diff);
    assert.equal(rails.length, 1, `${file} names no rail`);
    assert.equal(railsNamed(rails, "apply it").ok, false, `${file}: a plain yes applies it`);
  }
  // The engine is ordinary code outside its yes: a hunk elsewhere names no rail.
  assert.deepEqual(railsTouched(["packages/engine/src/engine.ts"], () => "@@ -10 +10 @@\n-const IDLE = 10;\n+const IDLE = 30;\n"), []);
  // Naming the rail by its file or its words applies it.
  assert.equal(railsNamed(railsTouched(["packages/brain/src/delegator.ts"], () => diff), "apply the delegator change").ok, true);
  assert.equal(railsNamed(railsTouched(["packages/engine/src/engine.ts"], () => diff), "apply the typed yes change").ok, true);
});
