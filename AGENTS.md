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
- **Gated by policy, not by absence.** The brain can read, write, run, fetch and
  script anything on this Mac; `packages/core/src/policy.ts` decides per call
  (`classifyAction` / `classifyPath` / `classifyAppleScript` / `classifyUrl`):
  run, confirm (the `ConfirmationState` handshake), or refuse (the never list
  and the secret stores — `~/.jarhead/env`, `~/.ssh`, keychains, cookies,
  `.env*`). Add a gate there with a table-driven case in `policy.test.ts`; never
  special-case a tool in the runner. The shell gate is lexical and fails closed:
  strip wrappers (`command`, `exec`, `env`, `sudo`, `then`), read inner shells
  (`bash -c`, `eval`) and one-liner scripts, normalise paths (`~`, `$HOME`,
  `/Users/x`, `/./`, `//`, and `/private/var` ≡ `/var`), and refuse anything
  that *sweeps* a folder holding a secret (a glob in it, a `cd` into it, a
  recursive reader or archiver naming it) whether or not the secret's name
  appears. Egress (a network client carrying a file, `$(…)`, a body or a pipe)
  and environment dumps (`env`, `set`, `ps -E`) confirm.
- **"Kevin named it" means Kevin's words.** Every gate that asks whether he
  named a folder, a host, a rail or said "apply anyway" reads
  `BrainTask.request` + `BrainTask.kevinDialogue` (his utterances, filled by the
  `Delegator` from `transcript.since(…, "kevin")`), never `dialogue`, which
  carries Jarhead's own lines. Do not pass the rendered dialogue to a gate.
- **Judge the real path.** `classifyPath` takes `realPath` (the runner computes
  it with `realPathOf`, parent-resolved for files that do not exist yet) and
  checks both spellings; `listTree` / `walkSearch` use `lstat` and never follow
  links; `run_shell` refuses a `cwd` inside a secret store or one of the folders
  that hold one. The running checkout (`REPO_ROOT`) is not a scratch folder:
  writes into it by file tool, shell or `agent_start` confirm with "self_edit is
  the way".
- **Jarhead edits itself only through the self-edit loop** (`packages/brain/src/
  selfedit.ts`, docs/REDESIGN.md §10): a worktree under `~/.jarhead/worktrees`,
  a coding agent, `pnpm run typecheck && pnpm test`, a spoken summary, Kevin's
  yes to "apply the change to Jarhead and restart it?", fast-forward into main,
  `engine.requestRestart`. The rails are files as a whole (policy.ts, core's
  index.ts and any new core module, brain.ts, instructions.ts,
  `apps/mac/.../Wake`, selfedit.ts, runner.ts, shell.ts, files.ts, brain's
  index.ts) or, for mostly-ordinary files, changed lines (the handshake in
  toolset.ts, build-mac signing, `permission()` in claude.ts, the Codex sandbox
  flags, `SECRET_KEYS`); a touched rail applies only when Kevin's own words name
  it by whole word or file name. Do not add a hunk-narrowed rail for a
  security-critical file: hunk regexes are dodged by editing the lines around
  them. Bump `SYSTEM_PROMPT_VERSION` when the standing orders change;
  `brain.test.ts` pins the prompt's order, budget (900 words) and tool names.
- **Secrets never enter a child, and never leave a result.** `scrubbedEnv` /
  `codexEnv` strip `SECRET_KEYS` from every process the brain spawns (shell,
  AppleScript, Codex, Claude Code); `loginShellCommand` unsets them again inside
  `zsh -lc`, because `~/.zprofile` re-exports them; the policy refuses commands
  that name the secret stores or a secret-named variable; and `SecretRedactor`
  (`shell.ts`) strikes every known secret value (env keys, everything in
  `~/.jarhead/env`, their base64) and every key-shaped string from every text
  result before a model reads it. A brain's own built-in tools bypass none of
  this: the Claude Code brain denies `Read`/`Glob`/`Grep`/`WebFetch`/`WebSearch`
  with a redirect to the jarhead tools.

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
- `@Published` sinks fire in `willSet`: inside a Combine sink, reading the
  property you subscribed to still returns the *old* value. Keep the payload
  the sink delivers (WakeGate, AppDelegate audio activity, checkFirstRun all
  bit on this).
- A `LazyVStack` chat feed re-estimates the height of rows it has dropped, so
  the content height jitters by tens of points after every append and the
  viewport slides. Two hundred materialised rows in a plain `VStack` are
  cheap and stable; the sticky-scroll probe pins the bottom exactly.
- SwiftUI's macOS ScrollView honours the system "Show scroll bars: Always"
  with a 15pt legacy gutter; force `.overlay` scrollers through the enclosing
  NSScrollView (ConsoleThinScrollers) for the thin auto-hiding kind.
- Hardened-runtime exceptions (`disable-library-validation`,
  `allow-dyld-environment-variables`) do nothing for *child* processes; they
  only weaken the app itself. The bundle carries neither.
- In the desktop-app harness a session resume kills background subagents and
  workflows mid-flight; their transcripts survive under
  `~/.claude/projects/<slug>/<session>/subagents/`, and a workflow's
  `journal.jsonl` keeps every finished agent's return value.
- Killing a `zsh -lc` child on a timeout leaves its `sleep`/server orphaned and
  holding the stdout pipe, so Node's `close` never fires: spawn with
  `detached: true` and signal the process group (`process.kill(-pid)`), and
  settle on `exit` with a short grace (`packages/brain/src/shell.ts`).
- `git add -A -- . ':!node_modules'` errors when node_modules is gitignored
  ("paths are ignored by one of your .gitignore files"); `git add -A` followed
  by `git rm -r --cached --ignore-unmatch -- node_modules '*/node_modules'`
  does not. `pnpm run` in a lockfile-less folder drops `node_modules/.package-map.json`
  and a `pnpm-lock.yaml`, so a self-edit's commit step must exclude them itself.
- A fresh git worktree has no `node_modules`; the self-edit checks run
  `pnpm install --frozen-lockfile --prefer-offline` there first (only when the
  lockfile exists), and resolve `pnpm` next to `process.execPath` because the
  daemon's launchd PATH has no nvm.
- `timeout(1)` does not exist on macOS; `perl -e 'alarm N; exec @ARGV' cmd…`
  is the portable stand-in for a bounded one-off run.
- `zsh -lc` is a *login* shell: it sources `~/.zprofile`, which on this Mac
  exports `OPENAI_API_KEY`, so a child spawned with a scrubbed environment gets
  the key back before the command runs. Scrubbing the parent's env is not
  enough; unset the keys inside the shell after the rc files (`loginShellCommand`).
- `realpathSync` turns `/var/…` and `/tmp/…` into `/private/var/…` and
  `/private/tmp/…`; a real path is never lexically "under" a root given in the
  short spelling. Compare through one canonical spelling (`canon` in policy.ts)
  or every temp-dir test passes for the wrong reason.
- A rail judged by changed lines is dodged two ways: git's `@@` funcname header
  is the nearest column-0 line starting with a letter (inside a template literal
  that is the previous prose paragraph, not the function), and deleting a line
  leaves no `+` line to match. Flag the file, not the hunk.
- The runner's `request` used to be `request + dialogue`; `transcript.render`
  emits `Jarhead:` lines too, so the self-edit summary (which names the rail)
  satisfied the rail guard on the next turn's bare "yes". Gates read Kevin's
  lines only (`kevinDialogue`).
