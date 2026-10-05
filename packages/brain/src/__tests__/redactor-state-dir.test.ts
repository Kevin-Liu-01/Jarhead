import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { envFilePath } from "@jarhead/core";
import { SecretRedactor, secretValues } from "../shell.ts";

/**
 * W2-9 (launch triage, the wave-1 hermetic leftovers): the redactor learns its values from the
 * state dir's env file, the one loadEnv reads. That is <JARHEAD_STATE_DIR>/env when the variable is
 * set and ~/.jarhead/env when it is not, exactly as readConfig() picks the state dir. It never reads
 * $HOME/.jarhead/env behind a state dir that lives somewhere else. On a Mac where the state dir is
 * ~/.jarhead nothing changes. Every value here is a canary in a temp dir, and every file is written
 * under this file's own scratch dir: a bare run with no preload (`node --import tsx --test <file>`,
 * as the README runs one file) never touches ~/.jarhead.
 */

const scratch = mkdtempSync(join(tmpdir(), "jh-w29-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const HOME_ONLY = "home-only-canary-w29-value";
const STATE_ONLY = "state-only-canary-w29-value";

/** A home whose ~/.jarhead/env names HOME_ONLY, and a state dir elsewhere whose env names STATE_ONLY. */
function layout(): { home: string; stateDir: string } {
  const root = mkdtempSync(join(scratch, "case-"));
  const home = join(root, "home");
  const stateDir = join(root, "state");
  mkdirSync(join(home, ".jarhead"), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(home, ".jarhead", "env"), `SERVICE_TOKEN=${HOME_ONLY}\n`, { mode: 0o600 });
  writeFileSync(join(stateDir, "env"), `JARHEAD_WAKE_PASSPHRASE=${STATE_ONLY}\nJARHEAD_BRAIN_MODEL=gpt-5.6-terra\n`, { mode: 0o600 });
  return { home, stateDir };
}

test("secretValues reads <JARHEAD_STATE_DIR>/env when the state dir is set, never $HOME/.jarhead/env", () => {
  const { home, stateDir } = layout();
  assert.deepEqual(secretValues({ JARHEAD_STATE_DIR: stateDir }, home), [STATE_ONLY], "the state dir's secret-named value only; the model setting is not a secret");
});

test("with JARHEAD_STATE_DIR unset or empty the state dir is ~/.jarhead, as readConfig() has it: what a Mac on the default sees is unchanged", () => {
  const { home } = layout();
  assert.deepEqual(secretValues({}, home), [HOME_ONLY]);
  assert.deepEqual(secretValues({ JARHEAD_STATE_DIR: "" }, home), [HOME_ONLY], "an empty value is the default, as `||` makes it in core");
  assert.deepEqual(secretValues({ JARHEAD_STATE_DIR: join(home, ".jarhead") }, home), [HOME_ONLY], "set to ~/.jarhead itself: the same file");
});

test("a ~ in JARHEAD_STATE_DIR is the redactor's home, as expandHome makes it", () => {
  const { home } = layout();
  mkdirSync(join(home, "alt-state"));
  writeFileSync(join(home, "alt-state", "env"), `OPENAI_API_KEY=${STATE_ONLY}\n`, { mode: 0o600 });
  assert.deepEqual(secretValues({ JARHEAD_STATE_DIR: "~/alt-state" }, home), [STATE_ONLY]);
});

test("SecretRedactor watches the state dir's env file: its value is struck, a value only $HOME/.jarhead/env names is left alone, and a key rotated into it is covered once the 5 s window passes", () => {
  const { home, stateDir } = layout();
  let t = 1_000_000;
  const redactor = new SecretRedactor({ JARHEAD_STATE_DIR: stateDir }, home, () => t);
  assert.equal(redactor.redact(`a ${STATE_ONLY} b`), "a [redacted secret] b");
  assert.equal(redactor.redact(`a ${HOME_ONLY} b`), `a ${HOME_ONLY} b`, "the home's env file is not the state dir's");
  assert.equal(redactor.count, 1);
  // Setup rotates a key: the state dir's file changes, the home's does not.
  const rotated = "rotated-canary-w29-value";
  writeFileSync(join(stateDir, "env"), `JARHEAD_WAKE_PASSPHRASE=${STATE_ONLY}\nOPENAI_API_KEY=${rotated}\n`, { mode: 0o600 });
  utimesSync(join(stateDir, "env"), new Date(), new Date(Date.now() + 10_000));
  t += 5_001;
  assert.equal(redactor.redact(rotated), "[redacted secret]", "the state dir's file is the one whose change is noticed");
  assert.equal(redactor.count, 2);
});

test("the redactor's file is core's envFilePath() for every form of JARHEAD_STATE_DIR: unset, empty, absolute, ~/x and ~", () => {
  const root = mkdtempSync(join(scratch, "forms-"));
  const home = join(root, "home");
  const abs = join(root, "abs-state");
  const forms: readonly { readonly name: string; readonly env: NodeJS.ProcessEnv; readonly file: string }[] = [
    { name: "unset", env: {}, file: join(home, ".jarhead", "env") },
    { name: "empty", env: { JARHEAD_STATE_DIR: "" }, file: join(home, ".jarhead", "env") },
    { name: "absolute", env: { JARHEAD_STATE_DIR: abs }, file: join(abs, "env") },
    { name: "~/x", env: { JARHEAD_STATE_DIR: "~/x" }, file: join(home, "x", "env") },
    { name: "~", env: { JARHEAD_STATE_DIR: "~" }, file: join(home, "env") },
  ];
  // Every candidate file names its own canary, so the value struck says which file was read.
  const files = [...new Set(forms.map((f) => f.file))];
  const canary = (file: string): string => `form-canary-w29-${files.indexOf(file)}`;
  for (const file of files) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `SERVICE_TOKEN=${canary(file)}\n`, { mode: 0o600 });
  }
  for (const f of forms) {
    assert.equal(envFilePath(f.env, home), f.file, `core's rule, ${f.name}`);
    assert.deepEqual(secretValues(f.env, home), [canary(f.file)], `the redactor reads core's file, ${f.name}`);
  }
});

test("the redactor the runner builds with the daemon's own env strikes what the configured state dir's env file holds", () => {
  // The case sets JARHEAD_STATE_DIR itself, so it holds with or without the preload, and writes only under its scratch dir.
  const saved = process.env["JARHEAD_STATE_DIR"];
  const stateDir = mkdtempSync(join(scratch, "state-"));
  process.env["JARHEAD_STATE_DIR"] = stateDir;
  try {
    const file = envFilePath();
    assert.equal(file, join(stateDir, "env"), "core's env file, the one loadEnv reads, is the configured state dir's");
    assert.ok(resolve(file).startsWith(resolve(scratch) + sep), `the case writes only under its scratch dir (${file})`);
    writeFileSync(file, `JARHEAD_BRAIN_API_KEY=${STATE_ONLY}\n`, { mode: 0o600 });
    assert.equal(new SecretRedactor().redact(STATE_ONLY), "[redacted secret]");
  } finally {
    if (saved === undefined) delete process.env["JARHEAD_STATE_DIR"];
    else process.env["JARHEAD_STATE_DIR"] = saved;
  }
});
