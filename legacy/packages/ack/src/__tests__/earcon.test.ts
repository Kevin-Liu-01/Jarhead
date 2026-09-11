import { test } from "node:test";
import assert from "node:assert/strict";
import { sep } from "node:path";
import { earconPath } from "../earcon.ts";

// Generation itself spawns ffmpeg, which tests do not do; the path contract
// is what the rest of the system depends on.

test("earcon variants cache to distinct files under <stateDir>/ack", () => {
  const listening = earconPath("/tmp/state", "listening");
  const done = earconPath("/tmp/state", "done");
  assert.notEqual(listening, done);
  assert.ok(listening.startsWith(`/tmp/state${sep}ack${sep}`));
  assert.ok(done.startsWith(`/tmp/state${sep}ack${sep}`));
});

test("earcon path is deterministic so a cached tone is found again", () => {
  assert.equal(earconPath("/tmp/state", "listening"), earconPath("/tmp/state", "listening"));
});
