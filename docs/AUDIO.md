# Jarhead and everyone else's sound

Jarhead hears through Apple's voice-processing unit (echo cancellation) while a session is
open, so he can talk next to speakers without hearing himself. That unit has side effects on
every other app — it ducks their sound, and on a Bluetooth headset it holds the headset's
microphone, which drops the headset to the hands-free codec. This pass (design12) tells the
unit what to do, releases it the moment Jarhead stops, keeps the wake listener off your
headset while he sleeps, and adds one switch for the case the unit cannot serve: recording.
Nothing here opens, keeps or closes a session; nothing is paid.

## 1. What changed by default

| when | before | now |
|---|---|---|
| **asleep** (wake word on) | the listener opened the *system default* mic — your AirPods — so the headset ran hands-free all day | the listener's own input unit is pointed at the **ranked** mic (the MacBook's when it is there); the AirPods stay on full-quality AAC while Jarhead waits for his name. One property on the listener's engine; the gate is untouched |
| **awake** | the unit ran at Apple's defaults: other apps ducked at the default level for as long as the session was open, and the unit lingered after sleep | the moment echo cancellation is switched on the unit is told **duck other apps at the least macOS allows (`min`), and only while a voice is present (`advanced`)**; AGC on and bypass off are set explicitly and printed. The unit is **released at every stop** — nothing ducks or holds a microphone after he sleeps |
| **awake, refused unit** (−10875 on every rung) | the plain graph ran unguarded — a latent self-talk loop | the plain graph runs with the **software echo guard** armed (§2); the state says `fallback` and the doctor warns |
| **mute** | the graph stayed up, the orange dot too | plus this process's input is zeroed at the HAL (`setInputMuted`), so the dot is honest; the graph still stays up so unmute is instant |

The ducking level is a constant, not a knob: there is no "off" on macOS, and a knob whose effect
no one can hear is noise. Jarhead's own voice is never ducked (it plays through the same engine).

## 2. The Recording switch

Settings › Audio › **Recording**, the status menu row, or **⌥⇧R**. Default off; it survives a
relaunch and is said in four places while on (the Audio head's `[recording]` badge, a chip on the
tucked island, a dot on the mute box, the doctor's `!`).

| Recording | the graph | other apps | a recorder (QuickTime, OBS, Screen Studio's mic track) | echo |
|---|---|---|---|---|
| **off** (default) | the unit on, following the system default input | ducked at the OS floor while a voice is present — not zero | a second client beside a voice-processing unit; on AirPods, the hands-free mic | Apple's |
| **on** | no Apple unit anywhere; the plain graph on the ranked microphone | untouched | an ordinary client of the same microphone, full level | the **software echo guard**: Jarhead holds the wire (chunks zero-filled, cadence kept) while he is audible plus a tail (300–800 ms, longer on Bluetooth); a word said clearly over him (+12 dB for 120 ms, after two seconds of held speech) opens it |

What Recording costs, said plainly: the first ~120 ms of your word over Jarhead are lost, and
break-in by voice is off for the first two seconds of each hold while the guard learns the echo
floor. On speakers the echo is loud and +12 dB over it is a shout — Recording is a demo mode,
and the hint says so. A safety fuse: three consecutive turns in which everything Live heard was
Jarhead's own last sentence send `mute` and toast `heard himself · muted — Recording off?`.

## 3. Kevin's ten-second check

1. Play Music on the AirPods. **Asleep**, it must stay full quality (before this pass it was narrowed).
2. Say his name. It dips a little while he answers and comes back between sentences.
3. `pnpm jarhead status`: the `speaks` line shows `48000 Hz` when the headset is fine and `16000 Hz` when it is narrowed (the Hears hint says why: the unit follows the default input — make the MacBook mic the default in System Settings › Sound, or turn Recording on).
4. For a demo: Recording on (⌥⇧R), QuickTime › New Audio Recording, talk over him — QuickTime's meter must move as much as when he is quiet, and Music is untouched.

What cannot be verified without ears: whether `min` is loud *enough*, whether the guard's held
edge loses too much of your first word, and how the recording actually sounds. Everything else
is read back by the probes below.

## 4. What the surfaces say

Settings › Audio, after Mic: **Hears** (device · `48 kHz · echo cancelled` | `echo guarded` |
`no echo cancellation`), **Speaks** (device · `48 kHz · full quality` | `16 kHz · narrowed` — the
hands-free tell as a figure), **Recording** `[On | Off] shares the mic`, then the hints
(`No Apple unit. Jarhead holds the wire while he speaks; a word over him opens it.` while on;
`Shared with QuickTime Player.` when another process reads the mic). The island's mute box dims
to 0.48 while the guard holds; a 2 × 2 dot marks Recording; the tucked island shows a
`record.circle` chip. `pnpm jarhead status` prints the `audio` block (voice processing · knobs ·
rung · hears · speaks · guard counters); `pnpm jarhead doctor` has an `audio` group (`voice
processing`, `hears`, `speaks`, `default input`, `other mic clients`, `recording`, `released at
sleep`, `leak`) and `--test-audio` shells to the probe.

## 5. The probes and what they print

All under `apps/mac/Scripts/`. None calls `pnpm jarhead probe` or `bench`; none connects to the
daemon; none opens a session. Anything that plays sound needs `AUDIO_PROBE_PLAY=1` and otherwise
prints what it would do and exits 0.

| probe | TCC | what it does | what it prints |
|---|---|---|---|
| `duck-probe.sh` (V4) | none | the pure parts: `EchoGuardModel` (hold on the first slice after output, release at `audibleUntil + tail`, no break-through in the first 2 s, +12 dB × 120 ms breaks through, a loud slice never teaches the floor, flush shortens the window, NaN is silence, counters), `EchoGuard`, `VoiceProcessingPolicy` (the ladder per policy, the constants, `firstRung`, the running line, the state words), then the barge-in duck rounds | `check: guard · <name> ok` · `check: policy · <name> ok` · `check: pure sections N ok, 0 FAIL` |
| `audio-probe.sh` (V1) | its own `AudioProbe.app` (mic; signed with the local identity so the grant survives rebuilds), or `AUDIO_PROBE_DIRECT=1` to borrow the terminal's | `AUDIO_PROBE_MODE=aec` (default): the unit on, knobs read back in both spellings (Swift properties and raw AU property 2108), the rung, `hears` following the default, released at stop · `recording`: no unit, the ranked mic, the guard on, no `VPAUAggregateAudioDevice` appears · `asleep`: the listener's `hears <name> (ranked)` line · `private`: the aggregate spike, `spike:` lines only | `check: <mode>: … ok` · `checks: N ok, M FAIL` · the run record in `~/.jarhead/audio-probe.json` under the mode; `--json` prints it last |
| `audio-probe.sh --test` | as above | what `pnpm jarhead doctor --test-audio` runs: the graph as the *current* setting builds it, 1 s quiet, a 1 s −12 dBFS 1 kHz chime through the player node, 1 s more; refuses while Jarhead.app holds a microphone (`warn: Jarhead is awake; sleep it first`) | last line `{"leakDb":…, "gated":…, "chunks":…, "rung":…, "mode":…}`, or `{"dryRun":true,"note":…}` without `AUDIO_PROBE_PLAY=1`, or `{"refused":…}` |
| `recorder-probe.sh` (V3) | the terminal's mic grant | **plays sound.** A plain recorder (this binary as `--recorder`, what QuickTime is) on the default mic for 30 s; `afplay` speaks a clip 5→25 s; Jarhead's graph up 10→20 s; the clip through the graph's own player 12→17 s so the guard holds | `check: recorder level unchanged within 1 dB (recording)` · `check: tailLeakDbfs ≤ −50 (recording)` · coupling/residual/floor merged into `audio-probe.json` |
| `duck-leak-probe.sh` (V2) | the terminal's system-audio-recording grant (macOS 14.2 process tap) | **plays sound.** A 20 s 1 kHz −20 dBFS tone through `afplay`, tapped per process; the graph up 5→15 s in `aec-default`, `aec-min-advanced`, `aec-min-plain`, `recording` | `ΔdB` per mode; `constant: advanced|plain is the smaller step`; or `tap is pre-duck — measure at the device` |

Kevin's `AUDIO_PROBE_DIRECT=1 AUDIO_PROBE_MODE=recording apps/mac/Scripts/audio-probe.sh` is the
one-line check that Recording's graph comes up guarded on the ranked microphone.

## 6. The AirPods case

The voice-processing unit has **one** device property for input and output; pointed at an
input-only microphone it fails outright, so with echo cancellation on the graph follows the
**system default input**. When that is the AirPods, the headset's microphone is held while a
session is open and every app's sound narrows to 16 kHz — the `Speaks · 16 kHz · narrowed`
figure and the doctor's `hears` warning. Three ways out, in order of cost:

1. Make **MacBook Pro Microphone** the default input in System Settings › Sound (the AirPods stay the output; the unit follows the built-in mic; full quality everywhere).
2. Turn **Recording** on: no unit, the ranked (built-in) mic, the guard; the AirPods leave hands-free.
3. The private route (`PrivateRoute`, probe-only): Jarhead's own aggregate with the default output as the clock and the ranked mic beside it, offered to the unit. `AUDIO_PROBE_MODE=private apps/mac/Scripts/audio-probe.sh` prints whether the unit accepts it on this Mac; green there is what a one-line follow-up flips `PrivateRoute.enabled` on.

Asleep is fixed already: the listener no longer opens the headset mic.

## 7. What this Mac said on 2026-09-16 (built-in mic + speakers, no AirPods)

- `aec`: rung 1 (automatic wiring) refused −10875, rung 2 (input-rate) came up; `duck 10 advanced true, agc true, bypass false · raw 2108 duck 10 advanced true`; `isVoiceProcessingEnabled false` and the unit's `VPAUAggregateAudioDevice-0x…` gone 2 s after stop — `checks: 9 ok, 0 FAIL`.
- `CADefaultDeviceAggregate-<pid>-0` is **AVAudioEngine's own** default-device aggregate (default input ≠ default output), created at the first plain attempt with no unit anywhere and alive as long as the engine object is; the unit's aggregate is the `VPAUAggregateAudioDevice-0x…` one. Anything that keys "the unit is released" on the `CADefaultDeviceAggregate` prefix will read a false positive.
- `recording`: on this Mac the plain graph's `kAudioOutputUnitProperty_CurrentDevice` set on the input node's AU (the input-only built-in mic) knocks the output side out — `IsFormatSampleRateAndChannelCountValid(outputHWFormat)` false, −10875 on every wiring — so the Recording ladder never came up; with the set skipped when the ranked mic already is the default, it comes up on rung 1 (hardware) with `guard on, tail 301 ms`. The engine fix is one guard in `applyInputDevice`; the wake listener already skips the set in that case.
- The terminal Kevin's agents run in inherits a microphone grant from its responsible process, so `AUDIO_PROBE_DIRECT=1` runs every silent mode without a TCC prompt.

## 8. What the Console prints, and what to do

| line | do |
|---|---|
| `Speaks · 16 kHz · narrowed` | the headset mic is held (Jarhead's unit or another app): make the MacBook mic the default in Sound settings, or turn Recording on |
| `Using Kevin's AirPods Pro. Echo cancellation follows the system default; make MacBook Pro Microphone the default in Sound settings to use it.` | the one case the hint exists for — do that |
| `Shared with QuickTime Player.` | fine while Recording is on; under echo cancellation the recorder sits beside the unit — turn Recording on for the take |
| `Hears · no echo cancellation` | the unit refused every rung on this device pair; Jarhead runs guarded; the doctor's `voice processing` row fails and says which pair |
| `heard himself · muted — Recording off?` | the fuse fired: Live heard Jarhead's own sentence three turns running; unmute, and turn Recording off unless you are recording |
| the `[recording]` badge, the dot, the chip | a forgotten switch; ⌥⇧R turns it off — it is never cleared for you |
