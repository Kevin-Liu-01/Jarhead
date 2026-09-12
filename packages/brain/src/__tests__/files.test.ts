import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasUppercase, ripgrepModeArgs, searchFiles, searchMode, splitInlineFlags } from "../files.ts";

/**
 * search_files and letter case. A model that gets no parameter schema writes
 * `(?i)design` (2 of 2 wiki searches in the controlled runs) — JavaScript's
 * RegExp rejects the group and the model spent a generation retrying with
 * `[Dd]esign`. The inline flags are split off for both engines, and an
 * all-lowercase pattern is case-insensitive on its own (ripgrep's smart case).
 */

test("inline flag groups are split off the pattern; anything else stays and fails as an invalid pattern", () => {
  assert.deepEqual({ ...splitInlineFlags("(?i)design"), flags: [...splitInlineFlags("(?i)design").flags] }, { pattern: "design", flags: ["i"] });
  assert.deepEqual([...splitInlineFlags("(?im)^design").flags].sort(), ["i", "m"]);
  assert.equal(splitInlineFlags("(?im)^design").pattern, "^design");
  assert.deepEqual([...splitInlineFlags("(?i)(?s)a.b").flags].sort(), ["i", "s"]);
  assert.equal(splitInlineFlags("(?i)(?s)a.b").pattern, "a.b");
  // Mid-pattern groups and unknown letters are not ours to interpret.
  assert.equal(splitInlineFlags("a(?i)b").pattern, "a(?i)b");
  assert.equal(splitInlineFlags("(?x)design").pattern, "(?x)design");
  assert.equal(splitInlineFlags("plain").pattern, "plain");
});

test("smart case: no uppercase letter means case-insensitive; an escape like \\S is not an uppercase letter; explicit wins", () => {
  assert.equal(hasUppercase("design"), false);
  assert.equal(hasUppercase("Design"), true);
  assert.equal(hasUppercase("\\Sdesign\\W"), false);
  assert.equal(hasUppercase("[A-Z]"), true);
  assert.equal(searchMode("design").insensitive, true);
  assert.equal(searchMode("Design").insensitive, false);
  assert.equal(searchMode("(?i)Design").insensitive, true);
  assert.equal(searchMode("design", false).insensitive, false);
  assert.equal(searchMode("Design", true).insensitive, true);
  assert.deepEqual(searchMode("(?ms)a.b"), { pattern: "a.b", insensitive: true, multiline: true, dotAll: true });
  // ripgrep gets the same decision as the walk, spelled out (a --smart-case in a user config must not decide for us).
  assert.deepEqual(ripgrepModeArgs(searchMode("design")), ["-i"]);
  assert.deepEqual(ripgrepModeArgs(searchMode("Design")), ["-s"]);
  assert.deepEqual(ripgrepModeArgs(searchMode("(?m)^Design")), ["-s", "--multiline"]);
  assert.deepEqual(ripgrepModeArgs(searchMode("(?s)a.b")), ["-i", "--multiline", "--multiline-dotall"]);
});

function corpus(): string {
  const root = mkdtempSync(join(tmpdir(), "jh-files-"));
  mkdirSync(join(root, "wiki"), { recursive: true });
  writeFileSync(join(root, "wiki", "design.md"), "# Design System\nno design here\nDESIGN tokens\n");
  writeFileSync(join(root, "wiki", "other.md"), "nothing to see\n");
  writeFileSync(join(root, ".env"), "SECRET=design\n");
  return root;
}

function rgOnPath(): string | undefined {
  try {
    return execFileSync("which", ["rg"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || undefined;
  } catch {
    return undefined;
  }
}

test("the walk: (?i)design finds every case, an all-lowercase pattern too, an uppercase one only its own; secret stores stay skipped; a bad pattern is a clean error", async () => {
  const root = corpus();
  const lines = (hits: { line: number }[]): number[] => hits.map((h) => h.line).sort((a, b) => a - b);
  const ci = await searchFiles(root, "(?i)design", { rg: false });
  assert.equal(ci.via, "walk");
  assert.deepEqual(lines(ci.hits), [1, 2, 3]);
  assert.deepEqual(lines((await searchFiles(root, "design", { rg: false })).hits), [1, 2, 3], "all lowercase: smart case");
  assert.deepEqual(lines((await searchFiles(root, "Design", { rg: false })).hits), [1], "an uppercase letter asks for that case");
  assert.deepEqual(lines((await searchFiles(root, "(?im)^design", { rg: false })).hits), [3], "^ is a line start, i covers DESIGN; '# Design' does not start with it");
  assert.deepEqual(lines((await searchFiles(root, "Design", { rg: false, caseInsensitive: true })).hits), [1, 2, 3], "explicit true");
  assert.deepEqual(lines((await searchFiles(root, "design", { rg: false, caseInsensitive: false })).hits), [2], "explicit false");
  assert.ok(ci.hits.every((h) => !h.path.endsWith(".env")), "the secret store is not searched, whatever the flags");
  await assert.rejects(searchFiles(root, "(?i)(", { rg: false }), /pattern is not a valid regular expression/);
  await assert.rejects(searchFiles(root, "(?x)design", { rg: false }), /pattern is not a valid regular expression/);
});

test("ripgrep, when installed, answers exactly as the walk does for the same flags", async (t) => {
  const rg = rgOnPath();
  if (!rg) {
    t.diagnostic("no rg on PATH; parity not checked here");
    return;
  }
  const root = corpus();
  for (const pattern of ["(?i)design", "design", "Design", "(?im)^design"]) {
    const viaRg = await searchFiles(root, pattern, { rg });
    const viaWalk = await searchFiles(root, pattern, { rg: false });
    assert.equal(viaRg.via, "rg", `${pattern}: rg answered`);
    assert.deepEqual(
      viaRg.hits.map((h) => `${h.path}:${h.line}`).sort(),
      viaWalk.hits.map((h) => `${h.path}:${h.line}`).sort(),
      `${pattern}: rg and the walk agree`,
    );
    assert.ok(viaRg.hits.every((h) => !h.path.endsWith(".env")), `${pattern}: rg never reports the secret store`);
  }
});
