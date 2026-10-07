# Jarhead and everyone else's sound

Jarhead hears through Apple's voice-processing unit (echo cancellation) while a session is
open, so he can talk next to speakers without hearing himself. That unit has side effects on
every other app: it ducks their sound, and on a Bluetooth headset it holds the headset's
microphone, which drops the headset to the hands-free codec. This pass (design12) tells the
unit what to do, releases it the moment Jarhead stops, keeps the wake listener off your
headset while he sleeps, and adds one switch for the case the unit cannot serve: recording.
Nothing here opens, keeps or closes a session; nothing is paid.

## 1. What changed by default

| when | before | now |
|---|---|---|
| **asleep** (wake word on) | the listener opened the *system default* mic (your AirPods), so the headset ran hands-free all day | the listener's own input unit is pointed at the **ranked** mic (the MacBook's when it is there); the AirPods stay on full-quality AAC while Jarhead waits for his name. One property on the listener's engine; the gate is untouched |
| **awake** | the unit ran at Apple's defaults: other apps ducked at the default level for as long as the session was open, and the unit lingered after sleep | the moment echo cancellation is switched on the unit is told **duck other apps at the least macOS allows (`min`), and only while a voice is present (`advanced`)**; AGC on and bypass off are set explicitly and printed. The unit is **released at every stop**: nothing ducks after he sleeps. With the wake word on, the one microphone held asleep is the wake listener's, on the ranked mic (the row above) |
| **awake, refused unit** (−10875 on every rung) | the plain graph ran unguarded: a latent self-talk loop | the plain graph runs with the **software echo guard** armed (§2); the state says `fallback` and the doctor warns |
| **mute** | the graph stayed up, the orange dot too | plus this process's input is zeroed at the HAL (`setInputMuted`), so the dot is honest; the graph still stays up so unmute is instant |

The ducking level is a constant, not a knob: there is no "off" on macOS, and a knob whose effect
no one can hear is noise. Jarhead's own voice is never ducked (it plays through the same engine).

## 2. The Recording switch

Settings › Audio › **Recording**, the status menu row, or **⌃⌥R**. Default off; it survives a
relaunch and is said in four places while on (the Audio head's `[recording]` badge, a `record.circle`
chip on the tucked island, a 2 × 2 dot on the mute box, the doctor's `!` on its `recording` row). The
status menu row is always titled `Recording`; the checkmark is the state. Its tooltip is
`HelpCopy.recordingRow`'s hint with the key last, in brackets: `(⌃⌥R)` (`HelpCopy.spoken`).

| Recording | the graph | other apps | a recorder (QuickTime, OBS, Screen Studio's mic track) | echo |
|---|---|---|---|---|
| **off** (default) | the unit on, following the system default input | ducked at the OS floor while a voice is present (not to zero) | a second client beside a voice-processing unit; on AirPods, the hands-free mic | Apple's |
| **on** | no Apple unit anywhere; the plain graph on the ranked microphone (pinned on rungs 1–2; rung 3 hears the system default when the pin is refused: `ranked mic refused; hearing the system default`) | untouched | an ordinary client of the same microphone, full level | the **software echo guard**: Jarhead holds the wire (chunks zero-filled, cadence kept) while he is audible plus a tail (300–800 ms, longer on Bluetooth); a word said clearly over him (+12 dB for 120 ms, after two seconds of held speech) opens it |

What Recording costs, said plainly: the first ~120 ms of your word over Jarhead are lost, and
break-in by voice is off for the first two seconds of each hold while the guard learns the echo
floor. On speakers the echo is loud and +12 dB over it is a shout. Recording is a demo mode,
and the hint says so. A safety fuse: three consecutive turns in which everything Live heard was
Jarhead's own last sentence send `mute` and toast `heard himself · muted. Recording off?`.

## 3. The ten-second check

1. Play Music on the AirPods. **Asleep**, it must stay full quality (before this pass it was narrowed).
2. Say his name. It dips a little while he answers and comes back between sentences.
3. `pnpm jarhead status`: the `speaks` line shows `48000 Hz` when the headset is fine and `16000 Hz` when it is narrowed (the Hears hint says why: the unit follows the default input; make the MacBook mic the default in System Settings › Sound, or turn Recording on).
4. For a demo: Recording on (⌃⌥R), QuickTime › New Audio Recording, talk over him. QuickTime's meter must move as much as when he is quiet, and Music is untouched.

What cannot be verified without ears: whether `min` is loud *enough*, whether the guard's held
edge loses too much of your first word, and how the recording actually sounds. Everything else
is read back by the probes below.

## 4. What the surfaces say

Settings › Audio, after Mic: **Hears** (device · `48 kHz · echo cancelled` | `echo guarded` |
`no echo cancellation`; on the plain path the device is the microphone the graph settled on, never
the engine's own aggregate), **Speaks** (device · `48 kHz · full quality` | `16 kHz · narrowed`, the
hands-free tell as a figure), **Recording** `[On | Off] shares the mic`, then the hints
(`No Apple unit. Jarhead holds the wire while he speaks; a word over him opens it.` while on;
`Shared with QuickTime Player.` (two names, then `+ n`) when another process reads the mic; while
echo cancellation follows a headset, `Using <headset>. Echo cancellation follows the system default;
make <ranked mic> the default in Sound settings to use it.`). The island's mute box dims to 0.48
while the guard holds; a 2 × 2 dot marks Recording; the tucked island shows a `record.circle` chip
whose tooltip reads `Recording: mic shared, echo guarded`; the mute box's own tooltip gains
` · recording` and ` · shared with <app>`. `pnpm jarhead status` prints the `audio` block (voice processing · knobs ·
rung · hears · speaks · guard counters); `pnpm jarhead doctor` has an `audio` group (`voice
processing`, `hears`, `speaks`, `default input`, `other mic clients`, `recording`, `released at
sleep`, `leak`) and `--test-audio` shells to the probe.

## 5. The probes and what they print

All under `apps/mac/Scripts/`. None calls `pnpm jarhead probe` or `bench`; none connects to the
daemon; none opens a session. Anything that plays sound needs `AUDIO_PROBE_PLAY=1` and otherwise
prints what it would do; `recorder-probe.sh` and `duck-leak-probe.sh` then exit 0, while
`audio-probe.sh --test` still runs the mode's V1 checks before its `{"dryRun":true}` line and its
exit carries them (0 every check ok · 1 a FAIL · 3 refused). The doctor reads the JSON either way.

| probe | TCC | what it does | what it prints |
|---|---|---|---|
| `duck-probe.sh` (V4) | none | the pure parts: `EchoGuardModel` (hold on the first slice after output, release at `audibleUntil + tail`, no break-through in the first 2 s, +12 dB × 120 ms breaks through, a loud slice never teaches the floor, flush shortens the window, NaN is silence, counters), `EchoGuard`, `VoiceProcessingPolicy` (the ladder per policy, the constants, `firstRung`, the running line, the state words), then the barge-in duck rounds | `check: guard · <name> ok` · `check: policy · <name> ok` · `check: pure sections N ok, 0 FAIL` |
| `audio-probe.sh` (V1) | its own `AudioProbe.app` (mic; signed with the local identity so the grant survives rebuilds), or `AUDIO_PROBE_DIRECT=1` to borrow the terminal's | `AUDIO_PROBE_MODE=aec` (default): the unit on, knobs read back in both spellings (Swift properties and raw AU property 2108), the rung, `hears` following the default, released at stop · `recording`: no unit, the ranked mic, the guard on, no `VPAUAggregateAudioDevice` appears · `asleep`: the listener's `hears <name> (ranked)` line · `private`: the aggregate spike, `spike:` lines only | `check: <mode>: … ok` · `checks: N ok, M FAIL` · the run record in `~/.jarhead/audio-probe.json` under the mode; `--json` prints it as the last JSON line (a `probe exit n` line follows; the doctor reads the last line that parses) |
| `audio-probe.sh --test` | as above | what `pnpm jarhead doctor --test-audio` runs: the graph as the *current* setting builds it, 1 s quiet, a 1 s −12 dBFS 1 kHz chime through the player node, 1 s more; refuses while Jarhead.app holds a microphone (`warn: Jarhead is awake; sleep it first`) | the last JSON line `{"leakDb":…, "gated":…, "chunks":…, "rung":…, "mode":…}`, or `{"dryRun":true,"note":…}` without `AUDIO_PROBE_PLAY=1`, or `{"refused":…}` |
| `recorder-probe.sh` (V3) | the terminal's mic grant | **plays sound.** A plain recorder (this binary as `--recorder`, what QuickTime is) on the default mic for 30 s; `afplay` speaks a clip 5→25 s; Jarhead's graph up 10→20 s; the clip through the graph's own player 12→17 s so the guard holds | `check: recorder level unchanged within 1 dB (recording)` · `check: tailLeakDbfs ≤ −50 (recording)` · coupling/residual/floor merged into `audio-probe.json` |
| `duck-leak-probe.sh` (V2) | the terminal's system-audio-recording grant (macOS 14.2 process tap) | **plays sound.** A 20 s 1 kHz −20 dBFS tone through `afplay`, tapped per process; the graph up 5→15 s in `aec-default`, `aec-min-advanced`, `aec-min-plain`, `recording` | `ΔdB` per mode; `constant: advanced|plain is the smaller step`; or `tap is pre-duck — measure at the device` |

`AUDIO_PROBE_DIRECT=1 AUDIO_PROBE_MODE=recording apps/mac/Scripts/audio-probe.sh` is the
one-line check that Recording's graph comes up guarded on the ranked microphone.

## 6. The AirPods case

The voice-processing unit has **one** device property for input and output; pointed at an
input-only microphone it fails outright, so with echo cancellation on the graph follows the
**system default input**. When that is the AirPods, the headset's microphone is held while a
session is open and every app's sound narrows to 16 kHz (the `Speaks · 16 kHz · narrowed`
figure and the doctor's `hears` warning). Three ways out, in order of cost:

1. Make **MacBook Pro Microphone** the default input in System Settings › Sound (the AirPods stay the output; the unit follows the built-in mic; full quality everywhere).
2. Turn **Recording** on: no unit, the ranked (built-in) mic, the guard; the AirPods leave hands-free.
3. The private route (`PrivateRoute`, probe-only): Jarhead's own aggregate with the default output as the clock and the ranked mic beside it, offered to the unit. `AUDIO_PROBE_MODE=private apps/mac/Scripts/audio-probe.sh` prints whether the unit accepts it on this Mac; green there is what a one-line follow-up flips `PrivateRoute.enabled` on.

Asleep is fixed already: the listener no longer opens the headset mic.

## 7. What this Mac said on 2026-09-16 (built-in mic + speakers, no AirPods)

- `aec`: rung 1 (automatic wiring) refused −10875, rung 2 (input-rate) came up; `duck 10 advanced true, agc true, bypass false · raw 2108 duck 10 advanced true`; `isVoiceProcessingEnabled false` and the unit's `VPAUAggregateAudioDevice-0x…` gone 2 s after stop: `checks: 9 ok, 0 FAIL`.
- `CADefaultDeviceAggregate-<pid>-0` is **AVAudioEngine's own** default-device aggregate (default input ≠ default output), created at the first plain attempt with no unit anywhere and alive as long as the engine object is; the unit's aggregate is the `VPAUAggregateAudioDevice-0x…` one. Anything that keys "the unit is released" on the `CADefaultDeviceAggregate` prefix will read a false positive.
- `recording`: on this Mac the plain graph's `kAudioOutputUnitProperty_CurrentDevice` set on the input node's AU (the input-only built-in mic) knocked the output side out (`IsFormatSampleRateAndChannelCountValid(outputHWFormat)` false, −10875 on every wiring), so the Recording ladder never came up (`checks: 2 ok, 1 FAIL`). Fixed in the integration pass: the set is skipped when the ranked mic already is the default, and otherwise it is a rung that can fail (`StartAttempt.pinDevice`; the ladder is ranked/hardware › ranked/automatic › default/hardware). Now rung 1 (hardware) comes up with `hears MacBook Pro Microphone 48000 Hz ×1 built-in · echo guarded`, `guard on, tail 301 ms`, no `VPAUAggregateAudioDevice` (`checks: 10 ok, 0 FAIL`); `aec` on the same run: rung 2, the unit's aggregate gone after stop (`checks: 10 ok, 0 FAIL`).
- A terminal that coding agents run in inherits a microphone grant from its responsible process, so `AUDIO_PROBE_DIRECT=1` runs every silent mode without a TCC prompt.

## 8. What the Console prints, and what to do

| line | do |
|---|---|
| `Speaks · 16 kHz · narrowed` | the headset mic is held (Jarhead's unit or another app): make the MacBook mic the default in Sound settings, or turn Recording on |
| `Using AirPods Pro. Echo cancellation follows the system default; make MacBook Pro Microphone the default in Sound settings to use it.` | the one case the hint exists for. Do that |
| `Shared with QuickTime Player.` | fine while Recording is on; under echo cancellation the recorder sits beside the unit; turn Recording on for the take |
| `Hears · no echo cancellation` | the unit refused every rung on this device pair; Jarhead runs guarded; the doctor's `voice processing` row fails and says which pair |
| `heard himself · muted. Recording off?` | the fuse fired: Live heard Jarhead's own sentence three turns running; unmute, and turn Recording off unless you are recording |
| the `[recording]` badge, the dot, the chip | a forgotten switch; ⌃⌥R turns it off. It is never cleared for you |

## 9. Playback: the cushion, the duck, the numbers

Jarhead's voice reaches the speaker through three pieces, and each one reports what it did.
Nothing here opens a session or plays a sound on its own.

**The cushion** (`PlayoutModel` in `Audio/Playout.swift`, played by `SpeakerScheduler`). Live
paces its audio at real time, so a chunk that arrives late leaves the player dry: a hole in a
word, with a click at each edge. After every reset (start, flush, a graph restart, the player
dry for 0.5 s or more) the next chunk is preceded by 120 ms of silence. A shorter dry spell
mid-reply is an underrun: it is counted, the chunk plays at once behind a 5 ms fade-in, and
the target for later resets grows to the longest gap plus 40 ms, at most 200 ms. Beside it
the model counts `wouldBeUnderruns`, what scheduling on arrival with no cushion would have
run dry on the same timeline, so one session gives the before and the after. A flush fades
the main mixer for 30 ms before it drops the backlog, so a barge-in does not click. The cost
is 120 ms (at most 200 ms) more between Live's audio and the speaker.

**The queue.** The HAL reads (devices, the default output, who else holds the mic) run on
their own `jarhead.audio.state` queue (`AudioStateReader`), never on the queue that schedules
the speaker. They run when a HAL listener marks them stale, or every 30 s; a change in the
mic's other clients is read at most once per 2 s. On the daemon side, past
`SNAPSHOT_BACKLOG_BYTES` (64 KB) of socket backlog the daemon keeps one pending snapshot per
client (the newest) and writes it on drain; speaker frames and every other frame keep their
order. In the app, `EngineClient` decodes snapshots on their own queue, one decode at a time
with the newest payload waiting, so a speaker frame never waits behind a snapshot.

**The duck** (`BargeInDuck`). Only the energy gate starts a duck: 60 ms of speech over the
room floor while Jarhead is audible. The ear's words and Live's transcript of Kevin confirm a
duck and never start one (`wordOnsetsSkipped` counts what words alone would have started).
An unconfirmed duck goes to −6 dB (`unconfirmedGain` 0.5); a confirmation takes it to −20 dB
(`duckGain` 0.1) in two 4 ms steps. An unconfirmed duck comes back at 700 ms once the mic is
quiet (a cough), or at most 1.5 s after it began while the mic stays hot; a confirmed one comes
back 250 ms after Kevin stops (4 s at most), over a 300 ms ramp.

**Where the numbers land.**

| where | what |
|---|---|
| the `audio-state` frame | `playout`, `duck` and `output`, optional objects beside the graph's state. `lateMaxMs` and `queuedMinMs` cover the window since the previous frame; `lateMaxGraphMs` covers the time since the graph started |
| `snapshot.liveAudio` | the daemon's figures while a session is open: Live's delta size, arrival p99 and max, how far Live ran ahead of real time, frames the output gate dropped, the event loop's longest delay (less the monitor's 10 ms resolution), the rate `session.started` echoed |
| `daemon.log` | one `audio:` line at most every 5 s while a session is open and the figures changed, and an `audio (session … closed):` summary at close. `late max` is the longest wait in any frame since the last line; `(N ms since start)` beside it is the figure since the graph started |
| the ledger | one `audio.playout` row at session close: the app's last frame (up to 5 s old, counters since the graph started) and Live's figures for that session. No row carries a word anyone said |
| `pnpm jarhead status` | four lines under the audio block: `playout`, `duck`, `output`, `live`. With no app connected and no session open, a `last session … (the ledger)` block from the newest `audio.playout` row of the last 7 days |
| `pnpm jarhead doctor` | five `audio` rows, none required (below) |

| doctor row | warns when | what the fix says |
|---|---|---|
| `playout` | more than one underrun per minute of audible speech, or one longer than 80 ms | the app's queue (`late max`) or Live's arrival (`arrival p99`), whichever is material (40 ms or more, or as long as the longest hole); with neither, "the cause is not known yet" |
| `duck` | more than one unconfirmed duck per minute of audible speech | lower the output volume |
| `residual echo` | the mic's p99 while Jarhead is audible and nothing is ducked is −44 dBFS or louder | lower the volume |
| `output level` | heard RMS under −30 dBFS or the volume under 30%; a peak at −1 dBFS or over | raise the volume, check the duck row, or the limiter squeezes the voice |
| `live arrival` | arrival p99 over 120 ms, the daemon's loop delay over 100 ms, or a rate other than 24 kHz | the network or the daemon; a wrong rate plays at the wrong speed |

Two probes check this part without a session, a device or a window:
`apps/mac/Scripts/playout-probe.sh` renders the shipped `PlayoutModel` and `SpeakerScheduler`
offline against arrival traces (`--stall` runs the play queue beside the real
`AudioStateReader` in real time; `--legacy` adds the old placement for contrast), and
`apps/mac/Scripts/snapshot-probe.sh` drives the real `EngineClient` against a fake daemon
with 283 KB snapshots, speaker frames and flushes.

What only a real session shows: whether the cushion leaves 0 underruns on a given Mac, how
often the duck fires unconfirmed, and the residual echo's p99. `status` and `doctor` print all
three after a session; the probes prove the code paths, not those figures.

## 10. The sounds

Every Jarhead sound is a soft felt mallet on a small crystal glass over a warm rosewood bar,
every note from D major pentatonic around D5 (D E F♯ A B), so two of them never clash. A rising
figure means he is with you, a falling one that he has let go, a low B-minor fall that something
needs you. Interface sounds sit at −30 to −24 LUFS; the rings that must cross a room at −20 to −16.
**Inside an open conversation his voice is the only sound.**

| sound | when | file | LUFS |
|---|---|---|---|
| `heard` | the wake word, before Touch ID or the passphrase (the gate's `Pop`) | a glass droplet on A6 | −28 |
| `awake` | granted, or any Go / resume from asleep or paused (the gate's `Glass`, the edge into `connecting`) | D5 rising to A5, 90 ms apart, rosewood under the first | −25 |
| `pause` | the phase lands on `paused` (the session closed) | A5 stepping down to E5, left hanging | −27 |
| `sleep` | a session (or connecting) goes to `asleep`: Stop, "goodnight", the dock, idle; with the tuck, 0.55 s after | A5, F♯5, D5 slowing, then a damped wooden tock | −27 |
| `chime` | an automation's chime (`local.say` `Glass`, and any unknown name) | one glass bell on A5 | −20 |
| `timer` | a timer is up (`Ping`, the engine's default for an `in` row) | two glass dings on A6 | −19 |
| `alarm` | an alarm, and every 30 s while it rings (`Hero`) | a marimba run up to a ringing D6 | −16 (first ring −19.5) |
| `snooze` | Snooze on a ring that sounded (the island, the banner, the menu, ⌃⌥S) | A5 settling onto D5, hushed | −26 |
| `opened` | an automation opened an app, a page or a file (`Pop`) | a glass tink on D6 | −28 |
| `mark` | a mark kept while asleep or paused | one soft rosewood tap | −30 |
| `cue` | before a spoken local line that has no sound of its own (a say-only automation, a wake-brain line) | a felt mallet on F♯ | −28 |
| `problem` | a wake that could not open (connecting → error), or a needs-Kevin problem outside a session | B4 falling to F♯4 on muted wood | −24 |

**Silent on purpose:** the session opening and reconnects, everything inside a session (task and
thread edges, confirmations, a mark while awake: the voice and the ink say them), Touch ID refused
or cancelled (the gate already says "No." or "Never mind."), mute and Recording toggles, Done on a
ring (the silence is the answer), an alarm nobody answered, pause decaying to sleep, notify-only
automations (Kevin chose a banner), missed or skipped automations and every `automation.*`
problem, a chime, a timer or a spoken line in quiet hours (an alarm rings through them unless its
row says `quiet: respect`), and quitting.

**The one gate** (`Earcons`, `Audio/Earcons.swift`). A sound plays only while the session's
microphone is off (`AppState.voiceAudioRuns` false: asleep, paused, error), because a sound played
beside the voice is not in the echo canceller's reference: the mic hears it at full level and
Live can take it for a turn. If the voice still has audible output queued (the farewell "night."),
the sound waits for it plus 150 ms and is dropped past 2 s. One at a time: alarm > timer > chime >
problem > awake · sleep · pause > snooze > heard > cue > opened > mark; a lower sound within 250 ms
after a higher one is dropped, a higher one within 250 ms after a lower one still sounding fades it
over 50 ms (the gate's `heard`, then `awake` at once when the wake asks for no authentication), and
the same sound twice within 1.5 s plays once. Snooze and Done fade a sounding ring over 120 ms.

**What makes a ring.** `local.say` carries `ring` (`alarm` · `timer` · `chime`), set by the engine
from the row's kind; its `sound` only picks the file. A ring sounds with Sounds off, plays at its
kind's priority, and Snooze and Done fade it, whichever file it names: a timer that names `Pop` is a
timer ring on the tink's file, an alarm that names `Glass` an alarm on the chime's. An open's `Pop`
carries no `ring`: it is the interface's tink. A daemon from before the field sends none, and the
name decides as it did (`Hero` an alarm, `Ping` a timer, `Pop` an open, anything else a chime).

**The alarm's level** ignores the Volume knob and Sounds: its first ring is level with the system
`Hero` it replaced (−19.5 LUFS against the file's −16.0, measured offline with ffmpeg's ebur128;
gain 0.67, the floor, applied after the ramp), and every repeat, 30 s apart, is 1 dB louder up to the
file's full −16. A repeat more than 45 s after the last starts the ramp over.

**The session's edge.** A `local.say` that lands while connecting is held, not sounded and not lost:
played if the phase then lands quiet (the handshake failed or was stopped), dropped if a session
opened. The engine does its part: a chime or a say that fires during the handshake goes to the
session as one instruction once it opens, as an awake fire does, and rings on the speaker only
when the handshake ends with no session; an alarm does not re-ring while a session opens.

**The one exception, `awake`.** It plays at the edge into `connecting`, before the graph starts.
`AudioEngine.handleMic` zero-fills the wire (cadence kept, the ear still hears the raw buffer, in
both aec and Recording) until the sound's end plus the output latency plus the echo guard's own
tail (0.30 s + latency, +0.20 s on Bluetooth, at most 0.80 s): about the first 0.75 s after the
grant on the built-in speakers. On every edge into a phase where the mic runs (`Earcons.enterVoice`,
before `updateAudioActivity()`), anything else still sounding fades out over 50 ms, nothing waiting
plays later, and the wire is held until the faded sound's end plus its latency and tail too (about
0.37 s): an alarm ringing when Kevin presses Go, a ring whose `local.say` overtook the connecting
snapshot, the problem sound under a Retry. Faded, it no longer outranks `awake`, which then plays.
Snooze and Done move only the ring's own window; they never shorten a hold. `pnpm jarhead status`
reads the hold back as `awake held 0.7 s` on the counters line. The wake listener ignores words
until 0.35 s after the last sound (`LocalSpeaker.isQuiet`), and a spoken line ("Touch ID?", an
automation's line after its cue) starts 50 ms before its sound ends, never under it.

**The player.** One `AVAudioPlayer` per sound, prepared at launch, on the system default output at
the system volume × Settings' volume (an alarm: its own level, above). Never the voice's engine,
its player node, the duck or the guard; never `NSSound`; never a second `AVAudioEngine`; it never
reads or sets the system volume.

**Settings › Audio.** `Sounds [On | Off] rings always sound` and `Volume` (0–100 %, default 70 %),
stored as `settings.audio.sounds` and `settings.audio.soundVolume`, written only by `set-settings`.
Off silences the interface sounds; the chime, the timer and the alarm still ring (Volume 0 silences
a chime and a timer, never an alarm). Until Kevin flips Sounds it follows macOS's "Play user
interface sound effects" (read, never written). Recording mode changes nothing here.

**The files** are `apps/mac/Resources/Sounds/<name>.caf` (mono, 48 kHz, 16-bit, 768 KB for all
twelve); `scripts/build-mac.ts` stages them into `Contents/Resources/Sounds` before signing, and a
`swift build` binary reads the checkout's. Eight are ElevenLabs takes (text-to-sound, prompt
influence 0.7) picked by spectrogram and measurement; `awake`, `pause`, `sleep` and `problem`
were built offline from two of those takes (the chime's A5 glass and one marimba note from the
alarm, varispeeded onto the palette's notes at its gaps), because no take produced the figures.
Each is trimmed to an onset within 5 ms, faded, normalised to its LUFS with a −3 dBTP ceiling
(−2 for the alarm) and converted with `afconvert -f caff -d LEI16@48000`. To swap one, drop a
mono 48 kHz CAF with the same name and set its length in `Earcon.seconds`.

`apps/mac/Scripts/earcon-check.sh` (in CI with the other headless checks) pins all of it with a
recorder in place of the player (the names and ring kinds, the gate, the dedupe, priorities and
fades, the alarm's level and ramp, the drain, the wire hold and the session's edge, the connecting
hold, the echo rule, which edges and problems sound), then opens and decodes every
file (`--bundle build/stage/Jarhead.app` checks a built bundle's copy). Nothing in it plays a sound.
