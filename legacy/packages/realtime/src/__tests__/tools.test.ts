import { test } from "node:test";
import assert from "node:assert/strict";
import { toRealtimeTools } from "../tools.ts";

test("anthropic tool definitions convert to the realtime wire shape", () => {
  // The two formats differ only in where the schema lives. Converting keeps
  // @jarvis/tools as the single definition site instead of a second list that
  // silently drifts.
  const [t] = toRealtimeTools([
    { name: "cursor_position", description: "exact pointer location", input_schema: { type: "object", properties: {} } },
  ]);
  assert.equal(t?.type, "function");
  assert.equal(t?.name, "cursor_position");
  assert.deepEqual(t?.parameters, { type: "object", properties: {} });
});

test("every tool keeps its description, which is how the model picks", () => {
  const out = toRealtimeTools([
    { name: "a", description: "does A", input_schema: { type: "object" } },
    { name: "b", description: "does B", input_schema: { type: "object" } },
  ]);
  assert.deepEqual(out.map((t) => t.description), ["does A", "does B"]);
});

test("an empty tool list stays empty rather than becoming undefined", () => {
  assert.deepEqual(toRealtimeTools([]), []);
});
