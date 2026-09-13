import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "@jarhead/protocol";
import { readConfig } from "@jarhead/core";
import { Engine } from "../engine.ts";
import { FakeMemoryService } from "./world.ts";

/** A bare engine over a temp state dir; the memory module is a fake so nothing loads by name or touches a store. */
const bare = (stateDir: string): Engine => new Engine({ config: { ...readConfig(), stateDir, socketPath: join(stateDir, "j.sock") }, connectors: [], memory: { service: new FakeMemoryService() } });

test("settings patches: null clears optional fields, required fields keep their value", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "jh-settings-"));
  const engine = bare(stateDir);
  engine.updateSettings({ micDeviceId: "AppleUSBAudioEngine:123", voice: "marin" });
  assert.equal(engine.snapshot().settings.micDeviceId, "AppleUSBAudioEngine:123");
  assert.equal(engine.snapshot().settings.voice, "marin");

  // The native settings UI sends `null` for "system default".
  engine.updateSettings({ micDeviceId: null, voice: null });
  assert.equal(engine.snapshot().settings.micDeviceId, undefined);
  assert.equal(engine.snapshot().settings.voice, "marin");

  const saved = JSON.parse(readFileSync(join(stateDir, "settings.json"), "utf8")) as Record<string, unknown>;
  assert.equal("micDeviceId" in saved, false);
  assert.equal(saved["idleSleepMinutes"], DEFAULT_SETTINGS.idleSleepMinutes);

  // The wake word block merges field-wise, so a partial patch keeps the other defaults.
  engine.updateSettings({ wake: { enabled: true, phrases: ["computer"], auth: "touch-id" } });
  assert.deepEqual(engine.snapshot().settings.wake, { enabled: true, phrases: ["computer"], auth: "touch-id" });
  engine.updateSettings({ wake: { auth: "none" } as never });
  assert.deepEqual(engine.snapshot().settings.wake, { ...DEFAULT_SETTINGS.wake, auth: "none" });
});

test("settings from an older settings.json still carry the wake defaults", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "jh-settings-old-"));
  writeFileSync(join(stateDir, "settings.json"), JSON.stringify({ voice: "marin", wake: { enabled: false } }));
  const engine = bare(stateDir);
  assert.equal(engine.snapshot().settings.voice, "marin");
  assert.deepEqual(engine.snapshot().settings.wake, { ...DEFAULT_SETTINGS.wake, enabled: false });
});

test("English by default: DEFAULT_SETTINGS says ballad / en / british / memory on; an old settings.json without the keys yields those defaults with no file rewrite; null keeps them; a real pick persists", () => {
  assert.equal(DEFAULT_SETTINGS.voice, "ballad");
  assert.equal(DEFAULT_SETTINGS.language, "en");
  assert.equal(DEFAULT_SETTINGS.accent, "british");
  assert.equal(DEFAULT_SETTINGS.memory, true);
  const stateDir = mkdtempSync(join(tmpdir(), "jh-settings-lang-"));
  const before = JSON.stringify({ voice: "marin", wake: { enabled: false } });
  writeFileSync(join(stateDir, "settings.json"), before);
  const engine = bare(stateDir);
  const s = engine.snapshot().settings;
  assert.equal(s.language, "en");
  assert.equal(s.accent, "british");
  assert.equal(s.memory, true);
  assert.equal(readFileSync(join(stateDir, "settings.json"), "utf8"), before, "reading defaults writes nothing");
  // null on a required field keeps its value (the native UI's "clear").
  engine.updateSettings({ language: null, accent: null, memory: null });
  assert.equal(engine.snapshot().settings.language, "en");
  assert.equal(engine.snapshot().settings.accent, "british");
  assert.equal(engine.snapshot().settings.memory, true);
  engine.updateSettings({ accent: "british", memory: false });
  const saved = JSON.parse(readFileSync(join(stateDir, "settings.json"), "utf8")) as Record<string, unknown>;
  assert.equal(saved["accent"], "british");
  assert.equal(saved["language"], "en");
  assert.equal(saved["memory"], false);
  assert.equal(engine.snapshot().memory?.enabled, false);
});
