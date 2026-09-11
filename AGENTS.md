# jarhead — agent index

Voice-first computer-use assistant for Kevin's Mac. v2 (2026-09-10) rebuilt on
GPT-Live-1 delegation. v1 lives in `legacy/` and is not built or tested.

## Boot

1. Read `docs/REDESIGN.md` — architecture, the four planes, hard rules.
2. `pnpm run doctor` and read what it says before touching anything live.
3. `pnpm run check` must be green before and after your change.

## Rules

- **Nothing on the voice path awaits a tool.** The brain reports through a
  `BrainSink`; the `Delegator` decides what reaches Live. Do not call
  `LiveSession.append*` from a tool.
- **Policy lives in one place:** `packages/core/src/policy.ts` decides
  run/confirm/refuse; the confirmation handshake is `ConfirmationState` in
  `packages/hands`. Every brain goes through `ToolRunner`; do not add a second
  path for "just this tool".
- **Coordinates are global points**, origin top-left of the main display, y
  down. Kevin's second display is *above* the main one: negative y is normal.
  Model coordinates are pixels of the last screenshot; `Screen` maps between.
- **Ledger is append-only.** The Console shows only what was recorded.
- **Protocol first.** App ↔ engine types are `packages/protocol`; the Swift
  mirror is `apps/mac/Sources/Jarhead/Model/Protocol.swift`; the socket frames are
  `packages/daemon/src/wire.ts`. Change the TS first, then the mirror.
- No new npm dependencies without a reason in the PR description. No build
  step for the engine: TypeScript runs through tsx; the app is `swift build`.
- Never commit keys. `~/.jarhead/env` and `.env.local` are the only homes. The
  app writes the former through `config.set-secrets` (Setup / Console) and only
  ever reads back presence and probe results (`snapshot.setup`), never a value.
- **Agents link to anything, not to one tool.** The `sessions` connector finds
  the agent sessions on this Mac (Claude Code, Codex, other CLIs on disk or
  running); `claude-code` continues one. Do not add a connector for a specific
  product; the herdr and T3 Code ones were retired for that reason.
- **Retire, do not delete.** Superseded code moves under `legacy/`
  (`shell-electron-v2`, `connectors-v2`, `vendor-docs`, v1 `packages/`); nothing
  there is built, typechecked or tested.

## Commands

```bash
pnpm run doctor · pnpm run typecheck · pnpm test · pnpm run check
pnpm build:mac                # native Jarhead.app → build/Jarhead.app (apps/mac, Swift)
pnpm jarheadd                 # engine daemon alone; JARHEAD_AUTO_WAKE=0 keeps it quiet
pnpm jarhead status | say "…" | probe "…" | agents | cmd wake|sleep|mute|unmute|stop|agent.refresh
pnpm build:hands              # Swift helper → build/jarhead-hands
apps/mac/Scripts/console-preview.sh [scenario] [out.png]   # Console with fake data (fixtures in apps/mac/Scripts/mock)
apps/mac/Scripts/onboarding-preview.sh [step] [out.png]    # Setup window with fake data (welcome … done)
```

Test launches of anything that opens a voice session must set
`JARHEAD_AUTO_WAKE=0` unless Kevin asked to talk to it: an open session listens
to his microphone and bills per second.

## Things that cost real time to learn

- `gpt-live-1` is **not** a Realtime model. `wss://api.openai.com/v1/realtime`
  rejects it; the endpoint is `wss://api.openai.com/v1/live/sessions` with a
  `session.start` event, and the REST `POST /v1/live/sessions` is WebRTC only.
- Live output audio is **continuous** (silence included). "Speaking" must be
  derived from `session.output_transcript.delta`, not from audio frames.
- Appends are capped at 500 tokens; `chunkForAppend` splits at sentences.
  Closing the session right after an append yields `context_injection_incomplete`.
- Transcript fragments carry their own leading spaces (" hey", ", jar",
  "head"); join by concatenation, never by inserting spaces.
- Claude Code headless uses `~/.claude/settings.json` → `env.ANTHROPIC_API_KEY`
  even when the shell variable is unset. A stale key there means every
  headless turn 401s after 11 retries (~3 minutes of silence). `claudeEnv()`
  and `settingSources: ["project","local"]` exist for this.
- `CGDisplayCreateImage` is gone on macOS 15+; screenshots are
  ScreenCaptureKit. SCK needs the Screen Recording grant of the *responsible
  app*; `screencapture` does not, hence the fallback.
- The Bash tool's working directory resets between calls in some harnesses;
  scripts that assume cwd end up writing into the wrong tree.
- AVAudioEngine voice processing (`setVoiceProcessingEnabled`) fails with
  `-10875` on the built-in mic + speakers when mainMixer→output is wired at the
  hardware output format or left automatic; wiring it at the *input* sample rate
  works. With voice processing on, the input node reports 2–9 channels; convert
  channel 0 to mono yourself — an AVAudioConverter from N channels to 1 without
  a channel map produces silence. `apps/mac/.../Audio/AudioEngine.swift` tries
  the wirings in order and logs "mic diag" every 5 s.
- Every test launch of Jarhead.app or `jarheadd` must carry `JARHEAD_AUTO_WAKE=0`
  unless a voice session is the point; `pnpm jarhead cmd wake|sleep` toggles it.
  With the wake word gate enabled (the default) the daemon never auto-wakes: the
  app sends `wake` only after Kevin says the word and authenticates.
- `SFSpeechRecognizer` on-device needs the English dictation model present
  (System Settings › Keyboard › Dictation); tasks end after ~1 min, so a
  continuous listener rolls requests every 50 s and treats each roll as a new
  transcript segment. `contextualStrings` is how you bias it toward "Jarhead".
- The voice-processing audio unit has **one** device property
  (`kAudioOutputUnitProperty_CurrentDevice`, global scope) for input *and*
  output. Setting it to a microphone also routes Jarhead's speech there, or
  fails for input-only devices and knocks the graph onto the no-AEC fallback.
  With echo cancellation on, the mic therefore follows the system default
  input; `Settings.micDeviceId` applies only when voice processing is off.
- TCC keys grants to the bundle's designated requirement. An ad-hoc signature
  is `cdhash`-based and changes every build, so grants reset; **any** valid
  code-signing identity (a self-signed one from Keychain Access is enough)
  keeps them. `scripts/build-mac.ts` picks Apple identities first, then any
  identity; `pnpm run doctor` warns on ad-hoc.
- `Partial<Settings>` cannot clear a field over JSON (undefined is dropped),
  so the wire type is `SettingsPatch` where `null` means "clear"; the engine
  normalises nulls, never stores them.
- TCC answers are per *process*: a fresh process is the only reliable way to
  read a grant the user just changed (`jarhead-hands --permissions`), and a
  resident helper must be restarted to *use* it. A System Settings row created
  by an ad-hoc build survives re-signing but is bound to the old cdhash — it
  shows "on" and does nothing; the user must remove it and re-request.
- Hardened-runtime exceptions (`disable-library-validation`,
  `allow-dyld-environment-variables`) do nothing for *child* processes; they
  only weaken the app itself. The bundle carries neither.
- In the desktop-app harness a session resume kills background subagents and
  workflows mid-flight; their transcripts survive under
  `~/.claude/projects/<slug>/<session>/subagents/`, and a workflow's
  `journal.jsonl` keeps every finished agent's return value.
