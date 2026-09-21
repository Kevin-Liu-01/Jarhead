import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { noLiveModelLine } from "@jarhead/core";
import { Engine } from "../engine.ts";
import { until, world } from "./world.ts";

/**
 * The user's name is a setting (release F1): unset, the engine falls back to the account's
 * name (the seam pins it here); set, the next wake's instructions carry it everywhere the
 * default did, and null unsets it. The Live model probe (release F4): a 404 is `noLiveModel`,
 * its own word, with the voice.key line the Setup pane and the doctor show — never "ok".
 */

test("F1: settings.userName absent → the fallback name is the voice's user in the standing orders and the language section; set → the next wake reads it (the file keeps it); null → unset again", async () => {
  const w = world({ fallbackUserName: "Ada Lovelace" });
  const { engine, lives } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    assert.equal(engine.snapshot().settings.userName, "", "unset by default");
    assert.equal(engine.userName, "Ada Lovelace", "the account's name stands in");
    await engine.wake("test");
    const text = lives[0]!.config?.instructions ?? "";
    assert.match(text, /You are always listening in Ada Lovelace's room\. Only respond when Ada Lovelace is clearly talking to you/);
    assert.match(text, /# Language\nSpeak English, British accent[^\n]* if Ada Lovelace speaks another language, answer in English/);
    assert.match(text, /need Ada Lovelace's yes first/, "the capability lines too");
    assert.doesNotMatch(text, /Kevin/, "no literal Kevin anywhere in the session's instructions");
    await engine.stop();

    engine.updateSettings({ userName: "  Sam " });
    assert.equal(engine.userName, "Sam", "trimmed");
    const saved = JSON.parse(readFileSync(join(w.dir, "state", "settings.json"), "utf8")) as Record<string, unknown>;
    assert.equal(saved["userName"], "  Sam ", "the file keeps the setting as given");
    await engine.wake("test");
    const again = lives[1]!.config?.instructions ?? "";
    assert.match(again, /You are always listening in Sam's room/);
    assert.match(again, /if Sam speaks another language/);
    assert.doesNotMatch(again, /Kevin|Ada/);
    assert.equal(Engine.farewellLine("Sam"), 'Sam dismissed you. Say exactly one word — "night." — and nothing else.');
    assert.equal(Engine.FAREWELL_LINE, Engine.farewellLine("Kevin"), "the default the sleep tests pin");

    engine.updateSettings({ userName: null });
    assert.equal(engine.snapshot().settings.userName, "", "null unsets: back to the account's name");
    assert.equal(engine.userName, "Ada Lovelace");
    engine.updateSettings({ userName: 42 as unknown as string });
    assert.equal(engine.snapshot().settings.userName, "", "a non-string is dropped");
  } finally {
    await engine.stop();
  }
});

test("F4: the Live model probe — 404 is noLiveModel with the voice.key line and Open Setup, never ok; 200 is ok and clears it; 401 is invalid", async () => {
  const w = world();
  const { engine } = w;
  const realFetch = globalThis.fetch;
  let status = 404;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("api.openai.com/v1/models/")) return new Response(status === 200 ? "{}" : '{"error":{"message":"no"}}', { status });
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    await engine.start();
    await engine.ready();
    const first = await engine.probeSetup();
    assert.equal(first.openaiKey, "noLiveModel");
    const key = engine.typedProblems().filter((p) => p.kind === "voice.key");
    assert.equal(key.length, 1);
    assert.equal(key[0]!.text, noLiveModelLine(engine.config.liveModel));
    assert.match(key[0]!.text, /^OpenAI key works, but gpt-live-1 is not on it — enable gpt-live-1 on the OpenAI project/);
    assert.deepEqual(key[0]!.remedy, { label: "Open Setup", open: "jarhead://setup" });
    status = 200;
    assert.equal((await engine.probeSetup()).openaiKey, "ok");
    assert.equal(engine.typedProblems().filter((p) => p.kind === "voice.key").length, 0, "the key answering with the model clears it");
    status = 401;
    assert.equal((await engine.probeSetup()).openaiKey, "invalid");
  } finally {
    globalThis.fetch = realFetch;
    await engine.stop();
  }
});

test("F1: a rename while the brain runs restarts it — the standing orders, Codex's base and developer instructions and the memory extractor are built with the name — and a patch that leaves the name alone does not", async () => {
  const w = world({ fallbackUserName: "Ada Lovelace" });
  const { engine } = w;
  const restarts: string[] = [];
  const orig = engine.restartBrain.bind(engine);
  engine.restartBrain = (reason: string) => {
    restarts.push(reason);
    return orig(reason);
  };
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    assert.deepEqual(restarts, [], "a patch without the name restarts nothing");
    engine.updateSettings({ userName: "Sam" });
    assert.deepEqual(restarts, ["the user's name changed"]);
    assert.equal(engine.userName, "Sam");
    engine.updateSettings({ userName: " Sam " });
    assert.deepEqual(restarts, ["the user's name changed"], "the same name with spaces around it is not a rename");
    engine.updateSettings({ userName: null });
    assert.deepEqual(restarts, ["the user's name changed", "the user's name changed"], "unsetting is a rename back to the account's name");
    assert.equal(engine.userName, "Ada Lovelace");
  } finally {
    await engine.stop();
  }
});

test("F1: another name flows into the threads and the automations — thread_start's refusal, a thread's brief and its stop, and a fired automation's nudge to the voice say Sam, with no literal Kevin", async () => {
  const w = world({ fallbackUserName: "Sam", automations: { exec: { run: async () => ({ code: 0 }), hold: () => ({ kill: () => undefined }) } } });
  const { engine, live, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    const said: string[] = [];
    // Threads: the scheduler's refusal, the brief its brain reads, the detail a stop leaves on the record.
    const parent = { id: "dlg_test", liveId: "item_1", request: "play focus on spotify", offsetMs: 0 };
    const refused = engine.threads.start(parent, { name: "", task: "play Focus", lane: "background" });
    assert.equal(refused.kind, "error");
    said.push((refused as { message: string }).message);
    assert.equal(said[0], "thread_start needs a name Sam will hear (one word, usually the app)");
    const started = engine.threads.start(parent, { name: "Spotify", task: "play Focus", lane: "background" });
    assert.equal(started.kind, "text", JSON.stringify(started));
    await until(() => w.threads.byName("Spotify")?.tasks.length === 1);
    said.push(w.threads.byName("Spotify")!.tasks[0]!.dialogue);
    assert.match(said[1]!, /Sam's own words, for names and gates: "play focus on spotify"/);
    const id = engine.threads.threads().find((t) => t.name === "Spotify")!.id;
    assert.equal(await engine.threads.stop(id), true);
    await until(() => engine.threads.threads().find((t) => t.id === id)?.status === "stopped");
    said.push(engine.threads.threads().find((t) => t.id === id)!.detail ?? "");
    assert.equal(said[2], "Sam stopped it");
    // Automations: a fire while the session is open is one instruction to the voice, with the name in front.
    live.instructions.length = 0;
    const armed = engine.automations.arm({ name: "call mum", when: { kind: "at", at: clock.t + 60_000 }, then: [{ kind: "say", line: "call mum" }], clauses: { quiet: "override" }, echo: "In a minute, say call mum." }, "brain");
    assert.equal(armed.kind, "armed", JSON.stringify(armed));
    clock.t += 60_000;
    (engine as unknown as { tick(): void }).tick();
    await until(() => live.instructions.length > 0, 1500);
    said.push(live.instructions[0]!);
    assert.equal(said[3], "Sam's call mum fired: say 'call mum' once, with its name, and nothing more.");
    for (const line of said) assert.doesNotMatch(line, /Kevin/, line);
  } finally {
    await engine.stop();
  }
});
