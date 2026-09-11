import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/** loadEnv is process-global, so precedence is checked in a child process. */
test("the state-dir env file beats a stale shell OPENAI_API_KEY, and the shell still wins for other vars", () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-env-"));
  writeFileSync(join(dir, "env"), "OPENAI_API_KEY=from-file\nOTHER_VAR=from-file\n");
  const script = `import { readConfig, keySource } from "@jarhead/core"; const c = readConfig(); console.log(JSON.stringify({ key: c.openaiApiKey, src: keySource("OPENAI_API_KEY"), other: process.env.OTHER_VAR }));`;
  const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, JARHEAD_STATE_DIR: dir, OPENAI_API_KEY: "stale-from-shell", OTHER_VAR: "from-shell" },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim()) as { key: string; src: string; other: string };
  assert.equal(out.key, "from-file");
  assert.equal(out.src, "state-dir");
  assert.equal(out.other, "from-shell");
});

test("writeEnvSecrets keeps other lines, removes on null, and sets mode 0600", async () => {
  const { mkdtempSync, readFileSync, statSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "jh-env-"));
  process.env["JARHEAD_STATE_DIR"] = dir;
  writeFileSync(join(dir, "env"), "# keys\nOPENAI_API_KEY=old\nJARHEAD_VOICE=marin\n");
  const { writeEnvSecrets, envFilePath, secretsPresent } = await import("../env.ts");
  writeEnvSecrets({ OPENAI_API_KEY: "sk-new", ANTHROPIC_API_KEY: "sk-ant" });
  const text = readFileSync(envFilePath(), "utf8");
  assert.match(text, /^# keys$/m);
  assert.match(text, /^OPENAI_API_KEY=sk-new$/m);
  assert.match(text, /^JARHEAD_VOICE=marin$/m);
  assert.match(text, /^ANTHROPIC_API_KEY=sk-ant$/m);
  assert.equal(statSync(envFilePath()).mode & 0o777, 0o600);
  assert.equal(process.env["OPENAI_API_KEY"], "sk-new");
  writeEnvSecrets({ ANTHROPIC_API_KEY: null });
  assert.doesNotMatch(readFileSync(envFilePath(), "utf8"), /ANTHROPIC/);
  assert.equal(secretsPresent().anthropic, false);
  assert.throws(() => writeEnvSecrets({ JARHEAD_BRAIN: "x" } as never), /not a secret/);
});
