# Jarhead.app (native macOS)

The Swift face of Jarhead: Dock + menu-bar app, the Orb, the Console, the
click-through annotation layer, and the audio devices. Everything else (the voice
session, the brain, the hands, the agents) is the TypeScript engine, which runs as a
child process, `jarheadd`, and talks to the app over a unix socket.

```
Jarhead.app ──spawns──► node tsx packages/daemon/src/main.ts --socket ~/.jarhead/jarhead.sock
     │                          │
     └──── unix socket ─────────┘   JSON control + PCM16 audio frames
```

## Run in development

```sh
cd apps/mac
swift build
JARHEAD_REPO=/Users/kevinliu/jarvis .build/debug/Jarhead
```

`JARHEAD_REPO` is optional when the binary lives under `apps/mac/.build`: the app
walks up from its executable until it finds the `package.json` named `jarhead`.
When it is set it wins over the bundle's baked-in manifest for the repo, the tsx
entry and the daemon entry alike ("run that checkout"). Node is found via
`JARHEAD_NODE`, then the manifest's node, then the newest `~/.nvm/versions/node/*`,
then `which node` in a login shell, then Homebrew.

Useful environment:

| var | effect |
|---|---|
| `JARHEAD_AUTO_WAKE=0` | the daemon does not open a voice session on start (set this for every test launch) |
| `JARHEAD_SOCKET=/path.sock` | use a private socket instead of `~/.jarhead/jarhead.sock` |
| `JARHEAD_STATE_DIR` | state dir (`~/.jarhead` by default); `daemon.log` and `ledger/` live here |
| `JARHEAD_REPO`, `JARHEAD_NODE` | override repo root / node binary |
| `JARHEAD_HANDS_BIN` | override the hands helper (the bundle sets it to its own copy) |
| `JARHEAD_NO_AUDIO=1` | never request the microphone or start audio (headless test launches) |

If a daemon already answers on the socket (for example `pnpm jarheadd` from a
terminal), the app **attaches** to it instead of spawning; if that daemon goes away,
the app starts its own. The app's own daemon is restarted with backoff (1 s → 30 s)
when it exits unexpectedly. Its stdout/stderr go to `~/.jarhead/daemon.log`
(rotated at 5 MB). The status-bar tooltip and the Console show the daemon state
(`running pid N`, `restarting in 4 s: exit 1`, …).

Hotkeys (Carbon, no Accessibility grant needed): ⌥⇧J console, ⌥⇧M mute,
⌥⎋ stop, ⌥⇧Space wake/sleep.

## Package

```sh
pnpm build:mac          # → build/Jarhead.app
cp -R build/Jarhead.app /Applications/
open -a Jarhead
```

`scripts/build-mac.ts` rebuilds `jarhead-hands` whenever `packages/hands/native`
is newer than `build/jarhead-hands` (the bundle freezes a copy), builds the icon if
missing, runs `swift build -c release`, assembles the bundle, writes
`Contents/Resources/jarhead.json` (`{repo, node, tsx, daemon}`) so the bundle knows
where this checkout is, signs the helper and then the app, and verifies with
`codesign --verify --strict`.

Signing picks, in order: `JARHEAD_SIGN_IDENTITY` (use `-` to force ad-hoc), the
first `Apple Development` identity, the first `Developer ID Application`, then
**any** valid code-signing identity in the keychain — a self-signed "Code Signing"
certificate made with Keychain Access → Certificate Assistant is enough, because
what TCC needs is a designated requirement that stays the same across builds. Only
Apple-issued identities get `--timestamp`. `pnpm run doctor` shows which identity
the built bundle carries and warns when it is ad-hoc.

The engine runs from the checkout through tsx, so changing Jarhead's behaviour is
editing this checkout (or, once v2 is committed, pulling it); changes under
`apps/mac` or `packages/hands/native` need a repackage. This app is the only face:
the Electron shell it replaced was retired on 2026-09-10 to
`legacy/shell-electron-v2` and is not built.

## Setup (`Sources/Jarhead/UI/Onboarding`)

Shown once, when the first snapshot from the daemon says `settings.onboarded` is
false, and on demand from the status-bar menu *Set Up…* (`AppState.openOnboarding`).
Steps: **welcome** (daemon connected?), **voice** (`OPENAI_API_KEY` →
`config.set-secrets`; the engine writes `~/.jarhead/env`, restarts the brain and
probes; the result is `snapshot.setup.openaiKey`), **brain** (kind, model, base URL
for `openai-compatible`; `ANTHROPIC_API_KEY` / `JARHEAD_BRAIN_API_KEY` →
`config.set-secrets`, then `config.probe` → `snapshot.setup.brain` /
`brainDetail`), **permissions** (PermissionsKit status + Settings deep links),
**wake** (phrases, authentication, passphrase), **agents** (the sessions found),
**done** (`set-settings {onboarded: true}`). Secrets go to `~/.jarhead/env` (mode
0600) on the daemon side; the snapshot only ever carries presence
(`SetupStatus.secrets`) and probe results. Preview with fake data:
`Scripts/onboarding-preview.sh [step] [out.png]` (`PREVIEW_SCENARIO=ready|fresh|broken`).

## TCC identities (why the bundle exists)

macOS keys privacy grants (microphone, screen recording, accessibility) to the
**responsible process** and its code signature.

- **Dev binary** (`.build/debug/Jarhead`): the responsible process is whatever
  launched it, usually Terminal. The mic prompt names Terminal; screen recording
  and accessibility for the hands helper resolve to Terminal's grants too. Fine for
  development, confusing for daily use.
- **Bundle** (`/Applications/Jarhead.app`, id `com.kevinliu.jarhead`): the app is
  the responsible process. It spawns node, which spawns `jarhead-hands`
  (`Contents/MacOS/jarhead-hands`, passed as `JARHEAD_HANDS_BIN`), and both inherit
  the app's identity, so one set of grants covers everything. Signing with a stable
  identity keeps those grants across rebuilds; an ad-hoc signature changes every
  build and TCC forgets.

The app itself requests only the microphone and reports it to the daemon; it
re-checks the grant every time it becomes active, so enabling the mic in System
Settings takes effect without a relaunch, and the Console's microphone "Request"
is handled in-process (TCC prompt when undetermined, the Privacy › Microphone pane
when denied). Screen recording and accessibility are probed by the hands helper (the
engine reports them in the snapshot); the Console's buttons deep-link to the right
Settings pane via `x-apple.systempreferences:com.apple.preference.security?Privacy_*`.

**Grants change while the app runs, and no relaunch is needed.** A running process
may keep the TCC answer it got at launch (Screen Recording notoriously does), so
the engine asks a *fresh* helper process — `jarhead-hands --permissions` — on a
timer (every 3 s while something is missing, 1.5 s for 90 s after a Request, 30 s
otherwise) and, the moment a grant appears, restarts the resident helper so its
capture and accessibility connections are made with the new rights, clears the
problem line and toasts. The Setup window and the Console read the same fresh
answers (`PermissionsKit` runs the bundled helper in the background while anyone
is looking). One trap remains: a row in System Settings that an *earlier build*
created is bound to that build's code hash. After re-signing (ad-hoc → a real
identity) the row still shows "Jarhead" switched on but no longer applies; remove
it with the − button, press Request (which creates a row for the current
signature), and switch the new row on.

`entitlements.plist` carries only `device.audio-input` and `automation.apple-events`.
No hardened-runtime exceptions: spawning node and the helper is unaffected by the
hardened runtime, which governs only what loads into the app's own process.

## Wake word (`Sources/Jarhead/Wake`)

While the engine is asleep nothing is billed and nothing leaves the Mac: the app
listens with **on-device** `SFSpeechRecognizer` (`requiresOnDeviceRecognition`,
rolled to a fresh request every 50 s, the wake phrases passed as
`contextualStrings` so recognition is biased toward them) and watches the running
transcript for any of `settings.wake.phrases` on word boundaries. When it hears one:

1. earcon, then it authenticates according to `settings.wake.auth`:
   `touch-id` — the system sheet (Touch ID, Apple Watch, or the Mac password);
   `passphrase` — a phrase Kevin says or types; `either` — both at once, first
   one wins; `none` — no check (doctor warns). With nothing to check against the
   gate stays shut and says so.
2. On success it sends `wake` and the Live session opens. The gate guards the
   hands-free path only: a deliberate Orb tap, the hotkey, the menu-bar item or
   `pnpm jarhead cmd wake` open the session directly. Three wrong answers lock the
   gate for a minute. No answer for 15 s → "Never mind."
3. Once the engine is awake the voice `AudioEngine` owns the microphone and the
   listener stops; when the session ends (sleep, idle) the gate listens again.

The prompts ("Password?", "No.", "Locked for a minute.") come from
`AVSpeechSynthesizer`, and the gate ignores transcripts while it is speaking so it
never hears itself. The passphrase is stored as PBKDF2-HMAC-SHA256 (200 000
rounds, random salt) in `~/.jarhead/wake-auth.json` (mode 0600); speech and typed
input are normalised (lowercase, letters and digits, single spaces) before hashing,
so punctuation and case never matter. `AppState.wakeGate` / `wakeHeard` /
`wakeActions` are what the UI reads and calls; the status-bar menu shows the gate
state while asleep. The daemon does not auto-wake while the gate is enabled
(`packages/daemon/src/main.ts`), so `JARHEAD_AUTO_WAKE=0` is only needed when the
gate is off. Speech Recognition is a third TCC prompt
(`NSSpeechRecognitionUsageDescription`), asked once right after the microphone.

## Wire protocol (mirror of `packages/daemon/src/wire.ts`)

Binary frames over the unix socket:

```
[type u8][length u32 big-endian][payload]
type 1  JSON control (UTF-8)
type 2  microphone PCM16 mono 24 kHz, app → daemon (100 ms = 4800 bytes)
type 3  speaker PCM16 mono 24 kHz, daemon → app
max frame 16 MiB
```

Daemon → app JSON: `hello {version,pid,stateDir}`, `snapshot {snapshot}`,
`levels {levels}`, `toast {text,tone}`, `overlay {command}`, `audio {control:"flush"}`
(sent whenever the engine emits `speaker-flush`: Stop, a spoken "stop"/"cancel"
that cancels a delegation, or sleep — the app drops its queued speaker audio),
`ledger.rows {id,rows}`, `ledger.days {id,days}`, `error {message}`.

`set-settings` patches follow `SettingsPatch` in `packages/protocol`: `null` clears
an optional field, so "system default microphone" is `{ micDeviceId: null }`.

App → daemon JSON: `hello {pid,version,audio:true}` (first; `audio:true` subscribes
to speaker frames, `pid` excludes the app's windows from screenshots),
`command {command:<EngineCommand>}`, `mic-level {level}`,
`permission {which:"microphone",state}`, `ledger.read {id,date}`, `ledger.days {id}`.

Snapshots are coalesced to ≤ 30/s before they reach `AppState`. Ledger requests
resolve through ids with a 5 s timeout.

## Audio

`AVAudioEngine` with **voice processing enabled on the input node** before start,
so the system echo canceller removes Jarhead's own voice from the mic (the model is
full duplex and would otherwise hear itself). The graph is tried in four
configurations (voice processing with automatic / input-rate / hardware output
wiring, then without voice processing) because VoiceIO refuses to initialise
(-10875) with some devices unless mixer → output runs at the input rate. The tap
receives 2–9 channels on mic arrays; the loudest channel is picked and downmixed
to mono, then converted to 24 kHz Int16 in 100 ms chunks, RMS reported at ≤ 10 Hz.
Speaker frames are converted to Float32 and scheduled on an `AVAudioPlayerNode`;
`flush` stops the player and drops the backlog. Audio runs only while a session is
open and the mic is granted.

A start that fails outright is retried with backoff (2 s → 30 s) for as long as
audio is wanted, device changes restart the graph, and a failure is surfaced as a
toast rather than a silent "listening". `Settings.micDeviceId` (a Core Audio device
UID or numeric AudioDeviceID) is honoured only on the no-echo-cancellation path:
the voice-processing unit drives input and output from one device property, so with
echo cancellation on, the mic follows the **system default input** (pick it in
System Settings › Sound). Unknown ids fall back to the system default.

## Layout

```
Sources/Jarhead/App          main, AppDelegate, StatusItem, Hotkeys, Menus
Sources/Jarhead/Daemon       RepoLocator, DaemonProcess, Wire, EngineClient
Sources/Jarhead/Audio        AudioEngine
Sources/Jarhead/Wake         WakeGate, WakeWordListener, LocalAuth, LocalSpeaker
Sources/Jarhead/Permissions  PermissionsKit
Sources/Jarhead/Model        Protocol.swift, AppState.swift (the contract; do not edit casually)
Sources/Jarhead/UI           Orb, Overlay, Console, Onboarding
Resources                    Info.plist, entitlements.plist, preview-*.png (harness screenshots)
Scripts                      orb-preview.sh, console-preview.sh, onboarding-preview.sh, *PreviewMain.swift (+ mock/ fixtures the previews resolve)
```
