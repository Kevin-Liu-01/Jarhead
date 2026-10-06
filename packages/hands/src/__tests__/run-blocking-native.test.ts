import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The helper's serial worker awaits ScreenCaptureKit through runBlocking (native/Protocol.swift).
 * A capture whose callback never comes (replayd dropped the connection under it: a second capturing
 * helper from the same executable path while the screen is locked, or replayd restarting) must answer
 * `capture_failed` within the bound, under the client's 6 s timeout, and leave the worker free for the
 * next op. A -3801 with Screen Recording granted (what the survivor of that loop gets) is tried once
 * more and then fails `capture_failed`, never "not granted"; without the grant it reaches
 * mapCaptureError as -3801. The harness in native/harness/run-blocking compiles Protocol.swift with
 * its own main and runs it headless: nothing is captured.
 */

const native = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "native");
const swiftc = process.platform === "darwin" && spawnSync("swiftc", ["--version"], { encoding: "utf8" }).status === 0;

test("runBlocking: a body that never answers fails capture_failed within the bound and the next op runs; a -3801 with the grant is tried once more and never reads as not granted", { skip: swiftc ? false : "needs swiftc (macOS)", timeout: 240_000 }, () => {
  const out = mkdtempSync(join(tmpdir(), "run-blocking-"));
  const r = spawnSync("sh", [join(native, "harness", "run-blocking", "check.sh"), out], { encoding: "utf8", timeout: 230_000 });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /^run-blocking: \d+ passed, 0 failed$/m);
  for (const name of [
    "a body that answers returns its value",
    "a body that never answers fails capture_failed (got capture_failed)",
    "a capture that never answered is not tried again (1 tries)",
    "the next op after a lost callback runs",
    "a -3801 with the grant is tried once more and its capture returned (2 tries)",
    "a -3801 twice with the grant fails capture_failed after two tries (got capture_failed, 2 tries)",
    "its message names -3801 and does not say not granted",
    "a -3801 without the grant is not retried and reaches mapCaptureError as -3801",
    "another ScreenCaptureKit error is not retried",
  ]) {
    assert.ok(r.stdout.split("\n").includes(`ok - ${name}`), `harness case: ${name}\n${r.stdout}`);
  }
});
