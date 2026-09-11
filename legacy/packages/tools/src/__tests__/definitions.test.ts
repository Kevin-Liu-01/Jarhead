import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOL_DEFINITIONS, TOOL_NAMES, type ToolDefinition } from "../definitions.ts";
import { executeTool, EXECUTABLE_TOOL_NAMES } from "../executor.ts";
import { fakeDeps } from "./fakes.ts";

test("every declared tool name has exactly one definition", () => {
  const names = TOOL_DEFINITIONS.map((d) => d.name);
  assert.deepEqual([...names].sort(), [...TOOL_NAMES].sort());
  assert.equal(new Set(names).size, names.length, "duplicate tool definitions");
});

test("definitions and executor dispatch can never drift apart", () => {
  assert.deepEqual([...TOOL_NAMES].sort(), [...EXECUTABLE_TOOL_NAMES].sort());
});

test("every schema is a valid Anthropic input_schema", () => {
  for (const def of TOOL_DEFINITIONS) {
    assert.equal(def.input_schema.type, "object", def.name);
    for (const required of def.input_schema.required) {
      assert.ok(
        def.input_schema.properties[required] !== undefined,
        `${def.name}: required "${required}" is not in properties`,
      );
    }
    for (const [key, prop] of Object.entries(def.input_schema.properties)) {
      assert.ok(prop.type === "string" || prop.type === "number", `${def.name}.${key}: bad type`);
      assert.ok(prop.description.length > 0, `${def.name}.${key}: property needs a description`);
      if (prop.enum !== undefined) {
        assert.ok(prop.enum.length > 0, `${def.name}.${key}: empty enum`);
        assert.equal(prop.type, "string", `${def.name}.${key}: enum only makes sense on strings`);
      }
    }
  }
});

test("slow tools admit their latency, so the model can budget for it", () => {
  // The model chooses badly when a tool's description omits its cost — this
  // pins the numbers into the prompt, not just into comments.
  for (const name of ["look_at_screen", "find_on_screen", "list_windows"]) {
    const def = TOOL_DEFINITIONS.find((d) => d.name === name);
    assert.ok(def, name);
    assert.match(def.description, /~?\d+(\.\d+)?(-\d+(\.\d+)?)?s/, `${name} must state its latency`);
  }
});

test("find_on_screen warns about Chromium's empty accessibility tree", () => {
  const def = TOOL_DEFINITIONS.find((d) => d.name === "find_on_screen");
  assert.ok(def);
  assert.match(def.description, /Chromium/);
  assert.match(def.description, /vision/i);
});

test("click_at tells the model refusals need Kevin, not a retry", () => {
  const def = TOOL_DEFINITIONS.find((d) => d.name === "click_at");
  assert.ok(def);
  assert.match(def.description, /confirm/i);
  assert.match(def.description, /do not retry/i);
});

// A definition the executor cannot actually run is a prompt-time lie; prove
// each one round-trips with an input built purely from its own schema.
function sampleInput(def: ToolDefinition): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const key of def.input_schema.required) {
    const prop = def.input_schema.properties[key];
    assert.ok(prop, `${def.name}: ${key}`);
    input[key] = prop.type === "number" ? 10 : prop.enum !== undefined ? prop.enum[0] : "the export button";
  }
  return input;
}

test("every definition executes against its own schema's sample input", async () => {
  for (const def of TOOL_DEFINITIONS) {
    const { deps } = fakeDeps();
    const outcome = await executeTool(def.name, sampleInput(def), deps);
    assert.equal(outcome.ok, true, `${def.name}: ${outcome.ok ? "" : outcome.error}`);
  }
});
