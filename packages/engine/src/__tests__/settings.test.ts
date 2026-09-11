import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "@jarhead/protocol";
import { readConfig } from "@jarhead/core";
import { Engine } from "../engine.ts";

test("settings patches: null clears optional fields, required fields keep their value", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "jh-settings-"));
  const engine = new Engine({ config: { ...readConfig(), stateDir, socketPath: join(stateDir, "j.sock") }, connectors: [] });
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
  const engine = new Engine({ config: { ...readConfig(), stateDir, socketPath: join(stateDir, "j.sock") }, connectors: [] });
  assert.equal(engine.snapshot().settings.voice, "marin");
  assert.deepEqual(engine.snapshot().settings.wake, { ...DEFAULT_SETTINGS.wake, enabled: false });
});
