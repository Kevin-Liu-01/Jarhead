import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JarvisConfig } from "@jarvis/core";
import { registryPathFor, type RegistrationEntry } from "@jarvis/automations";
import {
  AlreadyRunningError,
  Daemon,
  acquirePidfile,
  pidAlive,
  pidfilePathFor,
  releasePidfile,
  type DaemonStatus,
} from "../daemon.ts";
import { ipcRequest } from "../ipc.ts";
import type { RunRecord } from "../runner.ts";

const state = (): string => mkdtempSync(join(tmpdir(), "jarvisd-test-"));

function configFor(stateDir: string): JarvisConfig {
  return {
    anthropicApiKey: undefined,
    elevenLabsApiKey: undefined,
    elevenLabsVoiceId: undefined,
    elevenLabsModelId: "eleven_flash_v2_5",
    deepgramApiKey: undefined,
    kevinWikiRoot: stateDir,
    stateDir,
    socketPath: join(stateDir, "d.sock"),
    logLevel: "info",
  };
}

function seedRegistry(dir: string, entries: RegistrationEntry[]): void {
  mkdirSync(join(dir, "automations"), { recursive: true });
  writeFileSync(
    registryPathFor(dir),
    JSON.stringify({
      schemaVersion: "1",
      generatedAt: new Date(0).toISOString(),
      digest: "0".repeat(64),
      entries,
    }),
  );
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""]);
  await once(child, "exit");
  return child.pid!;
}

test("pidAlive: this process is alive, an exited child is not", async () => {
  assert.ok(pidAlive(process.pid));
  assert.ok(!pidAlive(await deadPid()));
});

test("acquirePidfile refuses while the recorded process is alive", () => {
  const dir = state();
  acquirePidfile(dir, process.pid);
  assert.throws(() => acquirePidfile(dir, 99999), AlreadyRunningError);
  assert.equal(readFileSync(pidfilePathFor(dir), "utf8").trim(), String(process.pid));
});

test("a stale pidfile is cleaned up and replaced, not fatal", async () => {
  const dir = state();
  writeFileSync(pidfilePathFor(dir), `${await deadPid()}\n`);
  acquirePidfile(dir, process.pid);
  assert.equal(readFileSync(pidfilePathFor(dir), "utf8").trim(), String(process.pid));
});

test("releasePidfile only removes its own pidfile", () => {
  const dir = state();
  acquirePidfile(dir, process.pid);
  releasePidfile(dir, 99999);
  assert.ok(existsSync(pidfilePathFor(dir)), "someone else's release must not drop our lock");
  releasePidfile(dir, process.pid);
  assert.ok(!existsSync(pidfilePathFor(dir)));
});

test("daemon end to end over the socket: tick, status, runs, stop", async () => {
  const dir = state();
  const config = configFor(dir);
  seedRegistry(dir, [
    {
      registrationId: "reg-hn",
      slug: "whats-on-hackernews",
      workflowId: "research.refresh",
      profile: "jarvis-voice",
      schedule: "daily",
      timezone: "UTC",
      enabled: true,
      quietDelivery: false,
      jitterSeconds: 0,
      input: { intent: "what's on hackernews" },
    },
  ]);

  let now = new Date("2026-08-11T12:00:00.000Z").getTime();
  let prefetches = 0;

  const daemon = new Daemon({
    config,
    execute: async (intent) => `answer to ${intent}`,
    clock: () => now,
    // A day between timer ticks: this test drives every tick explicitly.
    tickMs: 24 * 60 * 60 * 1000,
    prefetch: async () => {
      prefetches += 1;
    },
    log: () => undefined,
  });

  try {
    await daemon.start();
    assert.equal(prefetches, 1, "the startup tick warms the cache");
    assert.equal(readFileSync(pidfilePathFor(dir), "utf8").trim(), String(process.pid));

    const status = await ipcRequest(config.socketPath, { cmd: "status" });
    assert.ok(status.ok);
    const payload = status.result as DaemonStatus;
    assert.equal(payload.pid, process.pid);
    assert.equal(payload.registrations, 1);
    assert.equal(payload.ticks, 1);

    const sameBucket = await ipcRequest(config.socketPath, { cmd: "tick" });
    assert.ok(sameBucket.ok);
    assert.deepEqual(sameBucket.result, [], "the startup tick already spent today's bucket");

    now += 24 * 60 * 60 * 1000;
    const nextDay = await ipcRequest(config.socketPath, { cmd: "tick" });
    assert.ok(nextDay.ok);
    const runs = nextDay.result as RunRecord[];
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.status, "completed");

    const recent = await ipcRequest(config.socketPath, { cmd: "runs", limit: 1 });
    assert.ok(recent.ok);
    assert.equal((recent.result as RunRecord[]).length, 1);

    const stop = await ipcRequest(config.socketPath, { cmd: "stop" });
    assert.ok(stop.ok);
  } finally {
    // Idempotent; also covers the failure paths above.
    await daemon.stop("test cleanup");
  }

  assert.ok(!existsSync(pidfilePathFor(dir)), "stop releases the pidfile");
  assert.ok(!existsSync(config.socketPath), "stop removes the socket");
});

test("a second daemon on the same state dir refuses to start", async () => {
  const dir = state();
  const config = configFor(dir);

  const daemon = new Daemon({
    config,
    execute: async () => "unused",
    tickMs: 24 * 60 * 60 * 1000,
    prefetch: async () => undefined,
    log: () => undefined,
  });

  try {
    await daemon.start();
    // Same process, so acquirePidfile is exercised directly with a foreign pid.
    assert.throws(() => acquirePidfile(dir, 99999), AlreadyRunningError);
  } finally {
    await daemon.stop("test cleanup");
  }
});
