import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildArgs,
  commandToArgv,
  normalizeRef,
  parseBatchEnvelope,
  parseSingleEnvelope,
  parseSnapshotData,
  toBatchString,
} from "../agentBrowser.ts";

test("refs are accepted with or without the @ prefix", () => {
  assert.equal(normalizeRef("e3"), "@e3");
  assert.equal(normalizeRef("@e3"), "@e3");
});

test("commands map onto the observed CLI verbs", () => {
  assert.deepEqual(commandToArgv({ kind: "open", url: "https://example.com" }), ["open", "https://example.com"]);
  assert.deepEqual(commandToArgv({ kind: "click", ref: "e2" }), ["click", "@e2"]);
  assert.deepEqual(commandToArgv({ kind: "type", ref: "@e3", text: "hi" }), ["type", "@e3", "hi"]);
  assert.deepEqual(commandToArgv({ kind: "fill", ref: "e3", text: "hi" }), ["fill", "@e3", "hi"]);
  assert.deepEqual(commandToArgv({ kind: "press", key: "Enter" }), ["press", "Enter"]);
  assert.deepEqual(commandToArgv({ kind: "wait", ms: 1500 }), ["wait", "1500"]);
  assert.deepEqual(commandToArgv({ kind: "scroll", direction: "down", px: 500 }), ["scroll", "down", "500"]);
  assert.deepEqual(commandToArgv({ kind: "scroll", direction: "up" }), ["scroll", "up"]);
  assert.deepEqual(commandToArgv({ kind: "snapshot" }), ["snapshot", "-i"]);
});

test("batch strings quote multi-word values for the shell-words parser", () => {
  assert.equal(toBatchString(["type", "@e1", "hello world"]), 'type @e1 "hello world"');
  assert.equal(toBatchString(["click", "@e1"]), "click @e1");
});

test("batch strings escape embedded quotes and backslashes", () => {
  assert.equal(toBatchString(["type", "@e1", 'say "hi"']), 'type @e1 "say \\"hi\\""');
  assert.equal(toBatchString(["type", "@e1", "a\\b"]), 'type @e1 "a\\\\b"');
  assert.equal(toBatchString(["type", "@e1", ""]), 'type @e1 ""');
});

test("global flags precede the subcommand, as in every help example", () => {
  assert.deepEqual(buildArgs("jarvis", ["open", "https://example.com"]), [
    "--session",
    "jarvis",
    "--json",
    "open",
    "https://example.com",
  ]);
});

// The fixtures below are actual agent-browser 0.32.3 output captured on this
// machine (lifecycle fields trimmed); if an upgrade changes the envelope,
// these are the tests that should break.

test("a successful single envelope yields its data", () => {
  const stdout = '{"success":true,"data":{"title":"Example","url":"https://example.com/"},"error":null}';
  const parsed = parseSingleEnvelope(stdout);
  assert.ok(parsed.ok);
  assert.equal(parsed.data["title"], "Example");
});

test("a failed single envelope yields the CLI's error message", () => {
  const parsed = parseSingleEnvelope('{"success":false,"data":null,"error":"Unknown ref: e99"}');
  if (parsed.ok) assert.fail("expected a failure envelope");
  assert.equal(parsed.error, "Unknown ref: e99");
});

test("non-JSON output becomes a bounded error, never a raw dump", () => {
  const parsed = parseSingleEnvelope(`Chrome crashed\n${"x".repeat(5000)}`);
  if (parsed.ok) assert.fail("expected a failure envelope");
  assert.ok(parsed.error.length < 300, String(parsed.error.length));
});

test("snapshot data parses refs in page order with @ prefixes", () => {
  const data = {
    origin: "https://example.com/form",
    refs: {
      e10: { name: "Submit", role: "button" },
      e1: { name: "Hi", role: "heading" },
      e2: { name: "name", role: "textbox" },
    },
    snapshot: '- heading "Hi" [level=1, ref=e1]',
  };
  const snap = parseSnapshotData(data);
  assert.equal(snap.url, "https://example.com/form");
  assert.deepEqual(
    snap.refs.map((r) => r.ref),
    ["@e1", "@e2", "@e10"],
  );
  assert.deepEqual(snap.refs[0], { ref: "@e1", role: "heading", name: "Hi" });
  assert.match(snap.tree, /ref=e1/);
});

test("batch output is an array of per-step results, not the single envelope", () => {
  const stdout =
    '[{"command":["click","@e3"],"error":null,"result":{"clicked":"@e3"},"success":true},' +
    '{"command":["type","@e3","hello"],"error":null,"result":{"typed":"hello"},"success":true},' +
    '{"command":["click","@e99"],"error":"Unknown ref: e99","result":null,"success":false}]';
  const parsed = parseBatchEnvelope(stdout);
  assert.ok(parsed.ok);
  assert.equal(parsed.steps.length, 3);
  assert.deepEqual(parsed.steps[0], { command: "click @e3", ok: true, error: undefined });
  assert.deepEqual(parsed.steps[2], { command: "click @e99", ok: false, error: "Unknown ref: e99" });
});

test("a batch that dies before running surfaces the single-envelope error", () => {
  const parsed = parseBatchEnvelope('{"success":false,"data":null,"error":"No browser session"}');
  if (parsed.ok) assert.fail("expected a failure envelope");
  assert.equal(parsed.error, "No browser session");
});
