import { test } from "node:test";
import assert from "node:assert/strict";
import {
  beatsFromNarration,
  planFromToolCalls,
  runChoreography,
  visualCue,
  type Beat,
  type Command,
  type Cue,
  type ModelBlock,
} from "../choreograph.ts";

const arrow = (label: string): Command => ({ kind: "point", x: 10, y: 20, label });
const cue = (mention: string, command: Command): Cue => ({ mention, command });

test("the annotation lands on the sentence that mentions it", () => {
  const beats = beatsFromNarration(
    "Look at the top right of the window. Click the export button. It saves a PNG.",
    [cue("the export button", arrow("export button"))],
  );
  assert.equal(beats.length, 3);
  assert.equal(beats[0]?.show, undefined);
  assert.equal(beats[1]?.show?.length, 1);
  assert.equal(beats[2]?.show, undefined);
  assert.match(beats[1]?.say ?? "", /export button/);
});

test("content words match when the narration rephrases the label", () => {
  const beats = beatsFromNarration(
    "This app has two panes. Now press the button that says Export.",
    [cue("export button", arrow("Export"))],
  );
  assert.equal(beats[0]?.show, undefined);
  assert.equal(beats[1]?.show?.length, 1);
});

test("a cue nothing mentions leads on the first beat rather than trailing", () => {
  const beats = beatsFromNarration("Here is the window. This part matters most.", [
    cue("completely unrelated words", arrow("mystery")),
  ]);
  assert.equal(beats[0]?.show?.length, 1);
  assert.equal(beats[1]?.show, undefined);
});

test("cues with no narration become one silent show-only beat", () => {
  const beats = beatsFromNarration("", [cue("a", arrow("a")), cue("b", arrow("b"))]);
  assert.equal(beats.length, 1);
  assert.equal(beats[0]?.say, undefined);
  assert.equal(beats[0]?.show?.length, 2);
});

test("no narration and no cues is no choreography", () => {
  assert.deepEqual(beatsFromNarration("", []), []);
});

test("visualCue parses visual calls and rejects everything else", () => {
  assert.equal(visualCue("point_at", { x: 1, y: -2, label: "a" })?.command.kind, "point");
  assert.equal(visualCue("show_path", { fromX: 0, fromY: 0, toX: 5, toY: 5 })?.command.kind, "path");
  assert.equal(visualCue("clear_annotations", {})?.command.kind, "clear");
  assert.equal(visualCue("point_at", { x: "ten", y: 2 }), undefined, "malformed input");
  assert.equal(visualCue("draw", { shape: "sparkle", x: 1, y: 2 }), undefined, "unknown shape");
  assert.equal(visualCue("look_at_screen", { question: "?" }), undefined, "not a visual");
  assert.equal(visualCue("click_at", { x: 1, y: 2 }), undefined, "an action, not an annotation");
});

test("planFromToolCalls syncs each narration with its own visuals", () => {
  const blocks: readonly ModelBlock[] = [
    { type: "text", text: "The server list runs down the left. The compass icon is Explore." },
    { type: "tool_use", name: "point_at", input: { x: 40, y: 300, label: "the compass icon" } },
    { type: "tool_use", name: "look_at_screen", input: { question: "ignored" } },
    { type: "text", text: "Up here is the channel header." },
    { type: "tool_use", name: "highlight_region", input: { x: 0, y: 0, w: 800, h: 60, label: "channel header" } },
  ];
  const beats = planFromToolCalls(blocks);
  assert.equal(beats.length, 3);
  assert.equal(beats[0]?.show, undefined);
  assert.equal(beats[1]?.show?.[0]?.kind, "point", "arrow rides the compass sentence");
  assert.equal(beats[2]?.show?.[0]?.kind, "highlight", "highlight rides the second group's sentence");
});

test("a malformed visual call is dropped from the plan, not fatal to it", () => {
  const beats = planFromToolCalls([
    { type: "text", text: "One sentence." },
    { type: "tool_use", name: "point_at", input: { x: "NaN?", y: 2, label: "broken" } },
  ]);
  assert.equal(beats.length, 1);
  assert.equal(beats[0]?.show, undefined);
});

test("the visual fires at the start of its beat and speech never overlaps", async () => {
  const events: string[] = [];
  const beats: readonly Beat[] = [
    { say: "First sentence.", show: [arrow("a")], waitMs: undefined },
    { say: "Second sentence.", show: [{ kind: "clear" }], waitMs: undefined },
  ];
  const result = await runChoreography(beats, {
    speak: async (text) => {
      events.push(`speak-start:${text}`);
      // A real speaker resolves asynchronously; the delay is what would let a
      // buggy scheduler start the next beat early.
      await new Promise((r) => setImmediate(r));
      events.push(`speak-end:${text}`);
    },
    show: (commands) => {
      events.push(`show:${commands.map((c) => c.kind).join("+")}`);
    },
    clear: () => {
      events.push("clear");
    },
  });
  assert.deepEqual(events, [
    "show:point",
    "speak-start:First sentence.",
    "speak-end:First sentence.",
    "show:clear",
    "speak-start:Second sentence.",
    "speak-end:Second sentence.",
    "clear",
  ]);
  assert.equal(result.completed, true);
  assert.equal(result.beatsRun, 2);
});

test("waitMs uses the injected wait, so tests never sleep for real", async () => {
  const waits: number[] = [];
  await runChoreography([{ say: undefined, show: undefined, waitMs: 250 }], {
    speak: async () => undefined,
    show: () => undefined,
    clear: () => undefined,
    wait: async (ms) => {
      waits.push(ms);
    },
  });
  assert.deepEqual(waits, [250]);
});

test("abort stops between beats and still clears the screen", async () => {
  const events: string[] = [];
  const controller = new AbortController();
  const beats: readonly Beat[] = [
    { say: "One.", show: undefined, waitMs: undefined },
    { say: "Two.", show: undefined, waitMs: undefined },
    { say: "Three.", show: undefined, waitMs: undefined },
  ];
  const result = await runChoreography(beats, {
    speak: async (text) => {
      events.push(text);
      // Kevin interrupts during the first sentence.
      if (text === "One.") controller.abort();
    },
    show: () => undefined,
    clear: () => {
      events.push("clear");
    },
    signal: controller.signal,
  });
  assert.deepEqual(events, ["One.", "clear"]);
  assert.equal(result.completed, false);
  assert.equal(result.beatsRun, 1);
});

test("a show that rejects cannot take the narration down with it", async () => {
  const spoken: string[] = [];
  await runChoreography([{ say: "Still talking.", show: [arrow("a")], waitMs: undefined }], {
    speak: async (text) => {
      spoken.push(text);
    },
    show: () => Promise.reject(new Error("overlay socket refused")),
    clear: () => undefined,
  });
  assert.deepEqual(spoken, ["Still talking."]);
});
