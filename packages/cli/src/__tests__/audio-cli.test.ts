import { test } from "node:test";
import assert from "node:assert/strict";
import type { AudioState } from "@jarhead/protocol";
import { LEAK_FAIL_DBFS, NARROWED_BELOW_HZ, audioChecks, audioStatusLines, audioTestCheck, leakCheck, parseAudioProbe, parseAudioProfiler, render, transportWord, type AudioProfilerRead } from "../doctor.ts";

/**
 * design12 · V5 (CLI): the `audio` block of `jarhead status` and the doctor's `audio` group from a
 * fixture snapshot, text compared, no daemon. Three states — Kevin's Mac today (echo cancellation
 * following the AirPods mic, the headset narrowed), Recording on (the plain graph, the guard
 * holding, QuickTime beside it) and the fallback rung — plus no app connected, the profiler's
 * shape, the probe file's three spellings and the `--test-audio` row's answers.
 */

/** `o` without `keys` — exactOptionalPropertyTypes refuses an explicit undefined in a spread. */
function omit<T extends object, K extends keyof T>(o: T, ...keys: K[]): Omit<T, K> {
  const out = { ...o } as Record<string, unknown>;
  for (const k of keys) delete out[k as string];
  return out as Omit<T, K>;
}

const SINCE = Date.UTC(2026, 8, 16, 11, 58, 2);
const clock = (ms: number): string => new Date(ms).toTimeString().slice(0, 8);

/** Kevin's Mac today: awake, the unit following the system default (the AirPods mic), the headset on hands-free. */
const AEC_ON_AIRPODS: AudioState = {
  running: true,
  voiceProcessing: true,
  duckLevel: 10,
  advancedDucking: true,
  agc: true,
  bypassed: false,
  rung: 2,
  wiring: "input-rate",
  hears: { name: "Kevin's AirPods Pro", uid: "AP-in", rate: 24000, channels: 1, transport: "blue" },
  speaks: { name: "Kevin's AirPods Pro", uid: "AP-out", rate: 16000, channels: 2, transport: "bluetooth" },
  tapFormat: "24000 Hz ×9 Float32",
  recording: false,
  fallback: false,
  guardOn: false,
  guardTailMs: 0,
  gated: 0,
  chunks: 340,
  breakthroughs: 0,
  sharedWith: [],
  inputMuted: false,
  aggregatePresent: true,
  since: SINCE,
};

/** Recording on: the plain graph on the ranked built-in mic, the guard holding, QuickTime sharing the mic. */
const RECORDING: AudioState = {
  running: true,
  voiceProcessing: false,
  rung: 1,
  wiring: "hardware",
  hears: { name: "MacBook Pro Microphone", uid: "BuiltInMicrophoneDevice", rate: 48000, channels: 1, transport: "bltn" },
  speaks: { name: "Kevin's AirPods Pro", uid: "AP-out", rate: 48000, channels: 2, transport: "bluetooth" },
  tapFormat: "48000 Hz ×1 Float32",
  recording: true,
  fallback: false,
  guardOn: true,
  guardTailMs: 420,
  guardHeldMs: 3200,
  gated: 12,
  chunks: 340,
  breakthroughs: 1,
  sharedWith: ["QuickTime Player"],
  inputMuted: false,
  aggregatePresent: false,
  since: Date.UTC(2026, 8, 16, 12, 4, 31),
};

/** The unit refused (−10875): rung 4 won, the plain graph runs guarded with Recording off. */
const FALLBACK: AudioState = { ...omit(RECORDING, "sharedWith", "guardHeldMs"), rung: 4, recording: false, fallback: true };

const PROFILER_JSON = JSON.stringify({
  SPAudioDataType: [
    {
      _items: [
        { _name: "Odyssey G95NC", coreaudio_device_output: 2, coreaudio_device_srate: 48000, coreaudio_device_transport: "coreaudio_device_type_hdmi" },
        { _name: "Kevin's AirPods Pro", coreaudio_default_audio_input_device: "spaudio_yes", coreaudio_device_input: 1, coreaudio_device_srate: 24000, coreaudio_device_transport: "coreaudio_device_type_bluetooth" },
        { _name: "Kevin's AirPods Pro", coreaudio_default_audio_output_device: "spaudio_yes", coreaudio_device_output: 2, coreaudio_device_srate: 48000, coreaudio_device_transport: "coreaudio_device_type_bluetooth" },
        { _name: "MacBook Pro Microphone", coreaudio_device_input: 1, coreaudio_device_srate: 48000, coreaudio_device_transport: "coreaudio_device_type_builtin" },
        { _name: "MacBook Pro Speakers", coreaudio_default_audio_system_device: "spaudio_yes", coreaudio_device_output: 2, coreaudio_device_srate: 48000, coreaudio_device_transport: "coreaudio_device_type_builtin" },
      ],
      _name: "coreaudio_device",
    },
  ],
});
const PROFILER = parseAudioProfiler(PROFILER_JSON) as AudioProfilerRead;

const NOW = Date.UTC(2026, 8, 16, 13, 0, 0);
const row = (checks: readonly { name: string; status: string; detail: string; fix?: string | undefined }[], name: string) => {
  const c = checks.find((x) => x.name === name);
  assert.ok(c, `a ${name} row`);
  return c;
};

test("transportWord reads the app's word, its four-char code and system_profiler's type", () => {
  assert.equal(transportWord("blue"), "bluetooth");
  assert.equal(transportWord("bluetooth"), "bluetooth");
  assert.equal(transportWord("bltn"), "built-in");
  assert.equal(transportWord("coreaudio_device_type_builtin"), "built-in");
  assert.equal(transportWord("cont"), "continuity");
  assert.equal(transportWord("grup"), "aggregate");
  assert.equal(transportWord("hdmi"), "hdmi");
  assert.equal(transportWord(undefined), "unknown");
  assert.equal(NARROWED_BELOW_HZ, 44_100);
  assert.equal(LEAK_FAIL_DBFS, -50);
});

test("status · Kevin's Mac today: the knobs line with the rung and since, hears following the system default, speaks narrowed at 16 kHz, the resting line", () => {
  assert.deepEqual(audioStatusLines(AEC_ON_AIRPODS, { recording: false }), [
    `  audio      voice processing on · duck min advanced · agc on · bypass off · rung 2 input-rate · since ${clock(SINCE)}`,
    "             hears   Kevin's AirPods Pro        24000 Hz ×1   bluetooth   follows the system default",
    "             speaks  Kevin's AirPods Pro        16000 Hz ×2   bluetooth   narrowed while the headset mic is held",
    "             recording off · guard off · released at sleep",
  ]);
});

test("status · Recording on: voice processing off · recording · guard on, hears shared with QuickTime, speaks full quality, the guard's counters", () => {
  assert.deepEqual(audioStatusLines(RECORDING, { recording: true }), [
    `  audio      voice processing off · recording · guard on · rung 1 hardware · since ${clock(RECORDING.since as number)}`,
    "             hears   MacBook Pro Microphone     48000 Hz ×1   built-in    shared with QuickTime Player",
    "             speaks  Kevin's AirPods Pro        48000 Hz ×2   bluetooth   full quality",
    "             guard tail 420 ms · held 3.2 s · gated 12 of 340 · 1 break",
  ]);
  const muted = audioStatusLines({ ...RECORDING, inputMuted: true }, { recording: true });
  assert.ok(muted[3]?.endsWith(" · input muted"), "mute is said on the counters line");
});

test("status · the fallback rung says so; a stopped graph says the graph is down and whether the unit was released; no app: one line, with the profiler's defaults when read and never without --no-levels' consent", () => {
  assert.equal(audioStatusLines(FALLBACK, { recording: false })[0], `  audio      voice processing off · fallback (echo cancellation refused) · guard on · rung 4 hardware · since ${clock(FALLBACK.since as number)}`);
  const down = audioStatusLines({ ...omit(AEC_ON_AIRPODS, "hears", "speaks", "since"), running: false, voiceProcessing: false, aggregatePresent: false }, { recording: false });
  assert.deepEqual(down, ["  audio      voice processing off · the graph is down", "             recording off · guard off · released"]);
  const lingering = audioStatusLines({ ...omit(AEC_ON_AIRPODS, "hears", "speaks", "since"), running: false }, { recording: false });
  assert.equal(lingering[0], "  audio      voice processing off · the graph is down · voice processing still on");
  assert.equal(lingering[1], "             recording off · guard off · voice processing still on after stop");
  assert.deepEqual(audioStatusLines(undefined, { recording: false }), ["  audio      no app connected"]);
  assert.deepEqual(audioStatusLines(undefined, { recording: true }), ["  audio      no app connected · recording on"]);
  assert.deepEqual(audioStatusLines(undefined, undefined, PROFILER), ["  audio      no app connected — defaults: in Kevin's AirPods Pro 24000 Hz · out Kevin's AirPods Pro 48000 Hz"]);
});

test("profiler: names, rates, transports, the default pair and the built-in input; garbage is undefined", () => {
  assert.equal(PROFILER.devices.length, 5);
  assert.equal(PROFILER.defaultInput?.name, "Kevin's AirPods Pro");
  assert.equal(PROFILER.defaultInput?.rate, 24000);
  assert.equal(PROFILER.defaultOutput?.rate, 48000);
  assert.equal(PROFILER.builtInInput?.name, "MacBook Pro Microphone");
  assert.equal(PROFILER.aggregatePresent, false);
  assert.equal(parseAudioProfiler("not json"), undefined);
  assert.equal(parseAudioProfiler("{}"), undefined);
  const withAggregate = parseAudioProfiler(JSON.stringify({ SPAudioDataType: [{ _items: [{ _name: "VPAUAggregateAudioDevice-0x1f2e3d4c", coreaudio_device_input: 1, coreaudio_device_srate: 48000 }] }] }));
  assert.equal(withAggregate?.aggregatePresent, true);
  // AVAudioEngine's own default-device aggregate is present whenever the app merely runs (default in ≠ out): never the unit's.
  const engineOnly = parseAudioProfiler(JSON.stringify({ SPAudioDataType: [{ _items: [{ _name: "CADefaultDeviceAggregate-4242-1", coreaudio_device_input: 1, coreaudio_device_srate: 48000 }] }] }));
  assert.equal(engineOnly?.aggregatePresent, false);
});

test("doctor · Kevin's Mac today: voice processing ok, hears and speaks warn (a Bluetooth mic held; the headset narrowed), the default input held by the unit, no other clients, recording off, released judged after the next sleep, leak not measured — and the next steps name the fixes", () => {
  const checks = audioChecks({ state: AEC_ON_AIRPODS, settings: { recording: false }, phase: "listening", profiler: PROFILER, probe: undefined, appBuiltAt: undefined, now: NOW });
  assert.deepEqual(
    checks.map((c) => [c.name, c.status]),
    [["voice processing", "ok"], ["hears", "warn"], ["speaks", "warn"], ["default input", "ok"], ["other mic clients", "ok"], ["recording", "ok"], ["released at sleep", "ok"], ["leak", "warn"]],
  );
  assert.ok(checks.every((c) => c.group === "audio" && !c.required), "advisory throughout");
  assert.equal(row(checks, "voice processing").detail, "on · duck min advanced · agc on · bypass off · rung 2 input-rate");
  assert.equal(row(checks, "hears").detail, "Kevin's AirPods Pro · 24000 Hz ×1 · bluetooth · follows the system default");
  assert.equal(row(checks, "hears").fix, "a headset mic drops every app's sound to hands-free while held — make MacBook Pro Microphone the default in System Settings › Sound, or turn Recording on");
  assert.equal(row(checks, "speaks").detail, "Kevin's AirPods Pro · 16000 Hz ×2 · bluetooth · narrowed while the headset mic is held");
  assert.equal(row(checks, "default input").detail, "Kevin's AirPods Pro · held by Jarhead (the unit follows it)");
  assert.equal(row(checks, "other mic clients").detail, "none");
  assert.equal(row(checks, "recording").detail, "off · Settings › Audio, ⌥⇧R");
  assert.equal(row(checks, "leak").detail, "not measured — apps/mac/Scripts/audio-probe.sh (no session; needs the mic grant)");
  const { text } = render(checks);
  assert.ok(text.includes("  audio\n    ✔ voice processing             on · duck min advanced"), text);
  assert.ok(text.includes("    ! hears                        Kevin's AirPods Pro · 24000 Hz ×1 · bluetooth · follows the system default"), text);
  assert.ok(text.includes("  next steps\n    · hears: a headset mic drops every app's sound"), text);
  assert.ok(text.includes("· leak: run the probe once per device pair; the doctor reads ~/.jarhead/audio-probe.json"), text);
});

test("doctor · Recording on: voice processing ok (off, recording), hears fine on the built-in mic, speaks warns on Bluetooth (a longer tail), other clients ok while sharing a plain mic, recording warns while on", () => {
  const checks = audioChecks({ state: RECORDING, settings: { recording: true }, phase: "listening", profiler: undefined, probe: undefined, appBuiltAt: undefined, now: NOW });
  assert.equal(row(checks, "voice processing").status, "ok");
  assert.equal(row(checks, "voice processing").detail, "off · recording · guard on · rung 1 hardware");
  assert.equal(row(checks, "hears").status, "ok");
  assert.equal(row(checks, "hears").detail, "MacBook Pro Microphone · 48000 Hz ×1 · built-in · shared with QuickTime Player");
  assert.equal(row(checks, "speaks").status, "warn");
  assert.match(row(checks, "speaks").fix ?? "", /Bluetooth output buffers lengthen the guard tail/);
  assert.equal(row(checks, "default input").detail, "unknown (no system_profiler read) · not held — the plain graph uses MacBook Pro Microphone");
  assert.equal(row(checks, "other mic clients").status, "ok");
  assert.equal(row(checks, "other mic clients").detail, "QuickTime Player · sharing the plain mic");
  assert.equal(row(checks, "recording").status, "warn");
  assert.equal(row(checks, "recording").fix, "turn it off after the demo");
});

test("doctor · the fallback rung FAILS voice processing; a recorder beside the unit warns with the Recording fix; the HAL without process objects is said, not warned", () => {
  const fallback = audioChecks({ state: FALLBACK, settings: { recording: false }, phase: "listening", profiler: undefined, probe: undefined, appBuiltAt: undefined, now: NOW });
  assert.equal(row(fallback, "voice processing").status, "fail");
  assert.equal(row(fallback, "voice processing").detail, "off · fallback (echo cancellation refused) · guard on · rung 4 hardware");
  assert.equal(row(fallback, "voice processing").fix, "echo cancellation failed to start on this device pair; Jarhead runs guarded");
  assert.equal(row(fallback, "other mic clients").detail, "unknown (the HAL has no process objects)");
  assert.equal(row(fallback, "other mic clients").status, "ok");
  const fallbackShared = audioChecks({ state: { ...FALLBACK, sharedWith: ["QuickTime Player"] }, settings: { recording: false }, phase: "listening", profiler: undefined, probe: undefined, appBuiltAt: undefined, now: NOW });
  assert.equal(row(fallbackShared, "other mic clients").status, "ok", "the fallback rung runs the plain graph: a recorder beside it shares an ordinary mic");
  assert.equal(row(fallbackShared, "other mic clients").detail, "QuickTime Player · sharing the plain mic");
  const shared = audioChecks({ state: { ...AEC_ON_AIRPODS, sharedWith: ["QuickTime Player", "OBS", "Screen Studio"] }, settings: { recording: false }, phase: "listening", profiler: undefined, probe: undefined, appBuiltAt: undefined, now: NOW });
  assert.equal(row(shared, "other mic clients").status, "warn");
  assert.equal(row(shared, "other mic clients").detail, "QuickTime Player, OBS + 1 · beside a voice-processing unit");
  assert.equal(row(shared, "other mic clients").fix, "turn Recording on so the recorder shares a plain microphone");
});

test("doctor · released at sleep is judged asleep: the graph down with the unit off and no aggregate is ok; the unit still on, an aggregate in the list (the app's or the profiler's), or the graph still up warn", () => {
  const stopped: AudioState = { ...omit(AEC_ON_AIRPODS, "hears", "speaks", "since"), running: false, voiceProcessing: false, aggregatePresent: false };
  const ok = audioChecks({ state: stopped, settings: { recording: false }, phase: "asleep", profiler: PROFILER, probe: undefined, appBuiltAt: undefined, now: NOW });
  assert.equal(row(ok, "released at sleep").status, "ok");
  assert.equal(row(ok, "released at sleep").detail, "voice processing off after the last stop · no unit aggregate present");
  const unitOn = audioChecks({ state: { ...stopped, voiceProcessing: true }, settings: { recording: false }, phase: "asleep", profiler: PROFILER, probe: undefined, appBuiltAt: undefined, now: NOW });
  assert.equal(row(unitOn, "released at sleep").status, "warn");
  assert.equal(row(unitOn, "released at sleep").detail, "voice processing still on after the last stop · no unit aggregate present");
  const aggregate = audioChecks({ state: { ...stopped, aggregatePresent: true }, settings: { recording: false }, phase: "paused", profiler: undefined, probe: undefined, appBuiltAt: undefined, now: NOW });
  assert.equal(row(aggregate, "released at sleep").status, "warn");
  assert.match(row(aggregate, "released at sleep").detail, /the unit's aggregate \(VPAUAggregateAudioDevice\) is still present/);
  const up = audioChecks({ state: AEC_ON_AIRPODS, settings: { recording: false }, phase: "asleep", profiler: undefined, probe: undefined, appBuiltAt: undefined, now: NOW });
  assert.equal(row(up, "released at sleep").status, "warn");
  assert.equal(row(up, "released at sleep").detail, "the graph is still up while asleep");
  assert.equal(row(ok, "hears").detail, "nothing — the graph is down");
});

test("doctor · no app connected: one warning row, then recording from settings.json and the leak row from the file — never a device row", () => {
  const checks = audioChecks({ state: undefined, settings: { recording: true }, phase: undefined, profiler: PROFILER, probe: undefined, appBuiltAt: undefined, now: NOW });
  assert.deepEqual(checks.map((c) => [c.name, c.status]), [["audio state", "warn"], ["recording", "warn"], ["leak", "warn"]]);
  assert.equal(row(checks, "audio state").detail, "app not running — the graph's read-back needs Jarhead.app connected");
  assert.equal(row(checks, "recording").detail, "on · Settings › Audio, ⌥⇧R");
  const bare = audioChecks({ state: undefined, settings: undefined, phase: undefined, profiler: undefined, probe: undefined, appBuiltAt: undefined, now: NOW });
  assert.equal(row(bare, "recording").detail, "off · Settings › Audio, ⌥⇧R", "no settings.json: the default");
});

test("probe file: one run, { runs }, or a record keyed by mode; the leak row prefers the recording run, fails above −50 dBFS, warns when older than the app build, ok otherwise", () => {
  const at = NOW - 3_600_000;
  const one = parseAudioProbe(JSON.stringify({ at, mode: "recording", rung: 1, residualDbfs: -62, tailMs: 420 }), "/x/audio-probe.json");
  assert.equal(one?.runs.length, 1);
  assert.equal(one?.runs[0]?.mode, "recording");
  const list = parseAudioProbe(JSON.stringify({ runs: [{ at, mode: "aec", vpAfterStop: false }, { at: at + 1, mode: "recording", residualDbfs: -55 }] }), "/x");
  assert.deepEqual(list?.runs.map((r) => r.mode), ["aec", "recording"]);
  const keyed = parseAudioProbe(JSON.stringify({ aec: { at, vpAfterStop: false, aggregateAfterStop: false }, recording: { at, residualDbfs: -40, tailMs: 300 }, asleep: { at } }), "/x");
  assert.deepEqual(keyed?.runs.map((r) => r.mode), ["aec", "recording", "asleep"]);
  assert.equal(parseAudioProbe("nope", "/x"), undefined);
  assert.equal(parseAudioProbe(JSON.stringify({ at: "soon" }), "/x")?.runs.length, 0, "a run needs a numeric at and a mode");

  assert.equal(leakCheck(undefined, undefined, NOW).status, "warn");
  const ok = leakCheck(one, undefined, NOW);
  assert.equal(ok.status, "ok");
  assert.equal(ok.detail, "residual -62 dBFS · tail 420 ms · recording · 1 h ago");
  const fail = leakCheck(keyed, undefined, NOW);
  assert.equal(fail.status, "fail");
  assert.equal(fail.detail, "residual -40 dBFS · tail 300 ms · recording · 1 h ago — above -50 dBFS");
  assert.equal(fail.fix, "the guard is not holding on this hardware — use headphones for Recording, or leave it off");
  const stale = leakCheck(one, at + 1, NOW);
  assert.equal(stale.status, "warn");
  assert.match(stale.detail, /measured before this app build/);
  const noFigure = leakCheck(parseAudioProbe(JSON.stringify({ at, mode: "aec" }), "/x"), undefined, NOW);
  assert.equal(noFigure.status, "warn");
  assert.equal(noFigure.detail, "1 run (aec) — none measured the guard's residual");
});

test("--test-audio: the script missing, Jarhead awake, nothing printed, a refusal, a dry run, a leak figure under and over the line", () => {
  const asleep = { scriptExists: true, phase: "asleep" as const };
  let ran = 0;
  const spawn = (): string => {
    ran++;
    return "";
  };
  const missing = audioTestCheck({ scriptExists: false, phase: "asleep", run: spawn });
  assert.equal(missing.status, "warn");
  assert.equal(missing.detail, "apps/mac/Scripts/audio-probe.sh missing — nothing played");
  const awake = audioTestCheck({ scriptExists: true, phase: "listening", run: spawn });
  assert.equal(awake.status, "warn");
  assert.equal(awake.detail, "Jarhead is awake; sleep it first (two voice-processing clients cut each other)");
  assert.equal(ran, 0, "neither spawned the probe");
  assert.equal(audioTestCheck({ ...asleep, run: () => undefined }).status, "warn");
  assert.equal(audioTestCheck({ ...asleep, run: () => 'probe: building\n{"refused":"Jarhead.app holds the graph"}\n' }).detail, "Jarhead.app holds the graph");
  const dry = audioTestCheck({ ...asleep, run: () => '{"dryRun":true,"note":"would play a 1 s -12 dBFS 1 kHz chime through the player node"}' });
  assert.equal(dry.status, "ok");
  assert.equal(dry.detail, "dry run — would play a 1 s -12 dBFS 1 kHz chime through the player node");
  const good = audioTestCheck({ ...asleep, run: () => '{"leakDb":-58.2,"gated":9,"chunks":30,"rung":1,"mode":"recording"}' });
  assert.equal(good.status, "ok");
  assert.equal(good.detail, "leak -58.2 dB · guard would gate 9 of 30 · rung 1 · recording");
  const bad = audioTestCheck({ ...asleep, run: () => '{"leakDb":-31}' });
  assert.equal(bad.status, "fail");
  assert.equal(bad.detail, "leak -31 dB — above -50 dB");
  assert.equal(audioTestCheck({ ...asleep, run: () => "garbage\n" }).detail, "unreadable: garbage");
});
