# jarhead — agent index

Voice-first computer-use assistant for Kevin's Mac. v2 (2026-09-10) rebuilt on
GPT-Live-1 delegation. v1 lives in git history (before `1ff11e2`) and is not built or tested.

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
- **Retire, do not delete.** Superseded code moves under git history (before `1ff11e2`)
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
  `brain.test.ts` pins the prompt's order, budget (1100 words, v3.2) and tool names.
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
pnpm jarhead status | say "…" | probe "…" | agents | cmd wake|sleep|mute|unmute|stop|pause|resume|agent.refresh
pnpm jarhead bench [--fake-hands] # the tool path and the ear's 250 ms path; exit 1 when p95 to dispatch > 250 ms with the real helper
pnpm jarhead bench --brain [--runs N] [--effort low] [--no-reflex] [--json --out F] # the five representative commands on the real brain (Codex: Kevin's ChatGPT plan, no dollars; canned hands, no real actions); refuses when Codex is not signed in unless --allow-api-spend
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
- **Stop is local.** GPT-Live-1 has no interrupt/cancel client event: after a
  stop the engine drops incoming output audio and ignores output-transcript
  deltas for the phase (`outputGateUntil`, 2.5 s or until Kevin's next input
  delta), flushes the speaker, fails the helper's pending request
  (`cancelPending` — a gate whose probe was cancelled refuses the action), stops
  this task's background jobs, and finishes the delegation *before* awaiting the
  brain's cancel (a brain that settles on the abort signal would otherwise finish
  it first and lose the reason).
- `codex app-server` (0.153.4) is JSON-RPC 2.0, newline-delimited, over stdio
  (`--listen stdio://`): `initialize` → `initialized` notification → `thread/start`
  → `turn/start {input:[{type:"text",text,text_elements:[]},{type:"localImage",path}]}`
  → notifications `item/started` / `item/completed` (v2 items are camelCase:
  `agentMessage`, `mcpToolCall`, `commandExecution`, `reasoning`), `item/agentMessage/
  delta`, `thread/tokenUsage/updated {total,last,modelContextWindow}`, `turn/completed
  {turn:{status: completed|interrupted|failed}}`; `turn/interrupt` lands in ~35 ms.
  Server requests carry an id and must be answered (approvals, `item/tool/
  requestUserInput`, `mcpServer/elicitation/request`). `initialize` ~50 ms,
  `thread/start` ~2 s, MCP servers start per thread on its first turn (~1.3 s).
  Discover the types with `codex app-server generate-ts --out DIR`.
- The app-server has **no `--ignore-user-config`**. `-c mcp_servers={…}` does not
  replace Kevin's table (his servers start alongside); `-c mcp_servers.<name>.
  enabled=false` per server does switch them off, with the name **unquoted**
  (`mcp_servers."x".enabled=false` fails with "invalid transport"). The built-in
  plugin runtime `codex_apps` (Kevin's ChatGPT connectors — Drive, Sites, agents;
  134 tools, deletes and shares among them) is not a server but a *feature*:
  `--disable apps` (= `-c features.apps=false`) switches it off, and Jarhead's
  argv always passes it (`codex features list` shows `apps stable true`). His
  `notify` hook loads too; `-c notify=[]` silences it. Verify with
  `mcpServerStatus/list` after `initialize` — no thread, no turn, no billing.
- A thread's **first** `turn/start` answers only after ~2 s (the MCP servers
  start before the reply); an interrupt that arrives before the turn id is known
  must be remembered and sent once it is, or the server-side turn runs on after
  the stop. `thread/start` is 1.8 s on an idle Mac and 25 s to over a minute at
  load average 26–44: never await the app-server's start inside a task, and give
  its requests the boot budget rather than a default timeout.
- The daemon refuses `tool.run` while the engine's `ToolRunner` has no task
  attached (`runner.attached === false`): an out-of-process brain acts only
  under a delegation.
- A spoken "stop" must run the engine's stop *after* the other listeners for that
  transcript fragment (a microtask): the engine lifts the output gate on any input
  delta, and the delta that said "stop" would lift the gate the stop just set.
- Live delivers input-transcript fragments in bursts; any fixed quiet window after
  a fragment is a mid-sentence pause sometimes. A reflex may run ahead of the
  delegation only when the transcriber closed the sentence (`.`/`!`/`?`, then
  180 ms) or the pause is long (450 ms), and only when Kevin named Jarhead (or,
  mid-exchange, the sentence is closed). A prefire is a delegation record of its
  own on the ledger and is adopted by transcript item, never by text alone.
- Mark snapping: pick the **largest** frame that holds the centroid and is mostly
  inside the stroke, not the smallest — `element_at` at a circled dialog's centroid
  is a label inside it, which always fits.
- An ordered tool batch (one call acts) stops at the first `needs_confirmation`,
  refusal or error; with `disable_parallel_tool_use: false` a model may send
  "click Send, then ⌘Q" in one turn and the question must reach Kevin first.
- In tests, two transcript fragments less than `GAP_MS` (1400 ms) apart in
  session time merge into one utterance, and a `FakeLive.nowMs` that never moves
  pins `lastDelegationEndMs`, so the next request repeats old words. Space
  utterances and advance `nowMs` per delegation.
- A test that asserts *before* it cancels its pending helper requests leaves
  their 8 s timers alive; node:test then reports the late timeouts as
  "asynchronous activity after the test ended" — the symptom of the early
  assertion failure, not a client bug.
- **The 250 ms path is a second source, not a faster model** (REDESIGN §12).
  Speech → Live → delegation → brain → first tool is 1.5–4 s and stays so; the
  app's on-device recogniser sends `ear` partials ~100–200 ms behind speech, the
  engine matches them against the fixed reflex grammar (`packages/brain/src/
  reflex.ts`, shared with the Delegator) and acts through the gated hands. A
  partial fires only when it is a final, ends terminally (punctuation, "please",
  "now"), or has been stable — 120 ms for the reversible `prefire` kinds (scroll,
  page, screenshot, circle), 450 ms for everything else: the recogniser lands
  words in ticks, so "copy" of "copy this file…" or "type hello" of "type hello
  world" sits unchanged for a tick, and only a scroll may fire on a prefix. Finals
  cannot carry the fast path: the app's recogniser adds no punctuation and finals
  come at the 50 s roll. Every fired reflex is remembered (`FiredReflexes`, 4 s)
  so Live's delegation for the same words is finished as "already did it"; a
  `type` whose words differ is undone with ⌘Z (and Kevin is told either way).
- The ear must **consume, never forget**: after Stop/Pause (`quiesce`), while the
  voice speaks, a task runs or the mic is muted, the segment is kept with its words
  consumed — the recogniser keeps sending partials and a final for the same
  segment, and a forgotten segment comes back whole with the stopped command at
  its front. A revision that shortens the text never resets the consumed count.
- Reconciliation has a **peek** and a **reconcile**: the Delegator's prefire
  check must only peek; a claim there hides the ear's reflex from the delegation,
  which then runs it again. Tests of that ordering need Live's real gap between
  the transcript delta and the delegation (`world.ts`'s `delegate()` emits both
  in one tick and hides the race). Judge on the request's last transcript item;
  a request that merely ends with the phrase is "partial", never "done".
- `click_element` names a control but clicks a point: check the app is frontmost
  and `element_at` under the point lies inside the found frame (a leaf control
  around it is a sheet's button over it) before the CGEvent goes out. A label
  comparison alone cannot tell "Don't Save" from "Save".
- A reflex the policy would ask about is **dropped**, never asked: the runner
  had already recorded a `needs-confirmation`, so the engine clears that pending
  question (`confirmations.clear()` when the id matches) — a later "yes" must not
  arm a question nobody relayed. The model path asks properly.
- `AXUIElementCopyMultipleAttributeValues` is the walk: one IPC per element for
  role/title/description/value/position/size/children instead of seven. Per-node
  cost is app-bound (Chrome ~0.4 ms, Notes ~2.5 ms, Finder's desktop ~4 ms), so
  a walk needs a **time budget**, not only a node cap — Finder's desktop ran 10 s
  to a 2500-node cap. Breadth-first means a cut still keeps the toolbar. Chromium
  exposes web content only after `AXManualAccessibility` is set on the app
  element (no resizing side effects, unlike `AXEnhancedUserInterface`), and the
  first walk right after is sparse: retry once after ~120 ms. Electron apps vary
  (Slack: 62 nodes).
- Computing display bounds per node (`activeDisplays()` calls
  `CGDisplayCopyDisplayMode`) turned a 2 ms `find_element` into 100–600 ms; take
  the bounds once per query.
- `NSAppleScript` beats `osascript` for browser scripting: compile once, pass the
  JavaScript as the `run` handler's argument through `executeAppleEvent` (a
  `kAEOpenApplication` event with a list direct object), 5 ms on repeat instead
  of a 30–60 ms process per call. Apple events must go from the main thread
  (`onMain`). Check `NSRunningApplication` first — an event to a non-running app
  launches it. Per-tab `repeat with t in tabs` is one event per property per tab
  (1.5 s for 80 tabs); `title of every tab of w` is one. Chrome's refusal reads
  "Executing JavaScript through AppleScript is turned off" — map it to
  `permission_denied` with the menu path, and remember it per app for a minute so
  Kevin flipping the item is noticed.
- A `FakeLive.nowMs` that never moves pins `lastDelegationEndMs` (again): the
  stop-aftermath test's second request carried the first utterance's words and
  looked like an engine bug. Use `delegate()` / `nextUtterance()` from
  `packages/engine/src/__tests__/world.ts`.
- `assert.deepEqual(x, [])` narrows `x` to `never[]` under `@types/node`'s
  assertion signature; `x.map(r => r.label)` afterwards fails to typecheck. Use
  `assert.equal(x.length, 0)`.
- A private field and a method cannot share a name in a class that implements an
  interface's optional method (`CodexBrain.warm` vs `Brain.warm`): the interface
  hook is `warmUp()`.
- **GPT-Live-1 bills per second of open session, muted or not**, so "pause" that
  mutes and "stop" that keeps listening both keep the meter running (Kevin saw the
  timer climb after pressing Stop). The transport (REDESIGN §13) therefore closes
  the session on pause (the conversation is held in the engine: transcript,
  marks, brain, hands; a resume opens a new session with a `# Continuity` section)
  and on stop (asleep synchronously); only a spoken "stop" — the `interrupt`
  command — keeps it. A graceful `close()` unanswered for 1 s is `terminate()`d,
  and `tick()`'s watchdog ends any session that outlived a stop — never one that
  is `connecting`: a resume's opening session is still "paused" until
  `session.started`, and a rule without that guard closed every resume whose
  handshake spanned the tick. Session-timeline ms restart with every session, so
  the engine keeps one `Transcript` per session — a Delegator's `since(0)` over a
  shared one would replay every earlier utterance as the resumed session's first
  request.
- The app runs the daemon from the working tree (`tsx packages/daemon/src/main.ts`)
  and ATTACHES to one already listening on `~/.jarhead/jarhead.sock` instead of
  spawning its own — and the daemon outlives the app. After editing `packages/`,
  a relaunch of Jarhead.app does not pick the change up; quit the app fully and
  make sure the old daemon is gone (`pgrep -fl daemon/src/main.ts`) before
  testing. A whole evening of "the fix does not work" was a 21:15 daemon still
  running the pre-review engine at 22:19.
- A SwiftUI view being removed keeps the `.transition` it had when it last
  rendered, so a direction-dependent slide (forward/back) must not put the
  direction in the removal half — `ConsoleMotion.slide` uses a plain fade for
  removal and only the insertion picks a side.
- Never animate a feed's layout under the sticky-scroll probe: a transition or
  `.animation(value:)` that grows the VStack moves the pinned bottom every frame.
  New rows animate only their own opacity/offset (`ConsoleRowAppear`) and the
  document takes its final height on the first frame; the console harness's
  `switch` scenario proves the distance stays 0.
- A window's alpha and its ordering are separate window-server calls: order a
  panel out before restoring its alpha/scale, and set a small transparent
  presentation before ordering it in — otherwise one composite can show the
  whole body for a frame (`finishTuckSlip` / `dropOut` in OrbPanelController).
- `NSImage.draw(in:from:operation:fraction:)` replaces the CGContext alpha set by
  `cg.setAlpha` instead of multiplying it; pass the product as `fraction:`.
- Preview harnesses compile a hand-picked file list (`Scripts/*-preview.sh`);
  a new shared file under `UI/` (Motion.swift, Dither.swift) must be added to
  every script's swiftc inputs or the harness fails with "cannot find X in scope".
- Full Disk Access has no API and no prompt: the only read is to open an FDA-only
  path (`~/Library/Application Support/com.apple.TCC/TCC.db`, `~/Library/Safari`)
  and look at errno; a denied open creates no System Settings row, so the pane
  must be deep-linked and the app revealed in Finder for dragging in.
- `UNUserNotificationCenter.current()` aborts a process that is not inside a
  `.app` bundle; guard on the bundle before touching it (harness binaries, the
  CLI). The Desktop/Documents/Downloads and Local Network readers must not touch
  their resource until the sweep asks: the first `opendir` / browse IS the prompt.
- Engine tests that follow a permission change should wait for
  `snapshot().permissions.all` to carry the row rather than a fixed settle(): the
  fresh-helper poll is on a timer.
- Codex app-server `thread/tokenUsage/updated`: `.total` is the thread's CUMULATIVE
  bill (it grows by the whole prompt every generation); `.last` is the current
  context. Judging a rollover on `.total` threw the warm thread away after most
  multi-tool delegations (measured 6 of 18) — always compare `.last` to the window.
- `codex debug prompt-input` renders the model-visible developer blocks with no
  model call; `codex debug models` carries the base instructions template. On
  0.154 only `skills.include_instructions=false` removes the skills catalog
  (~8.4k tokens); `project_doc_max_bytes=0`, `features.skills=false` and the
  `--disable multi_agent` family do nothing to the prompt. MCP tool schemas are
  NOT inlined (code-mode exec): the model sees names only, so the tool table it
  needs lives in the Codex addendum.
- Jarhead's Codex runs in a private `CODEX_HOME` (`~/.jarhead/codex-home`:
  auth.json symlinked to `~/.codex/auth.json`, a config.toml with only the model
  keys, no AGENTS.md, empty skills). Kevin's global `~/.codex/AGENTS.md` points at
  `~/Documents/GitHub/kevin-wiki`, which no longer exists (the wiki is
  `~/repos/Kevin-Wiki-v3`); inherited, it cost 22.5 s of a 40.8 s wiki search.
- GPT-Live-1 streams output audio continuously, silence included: `earHeld()`
  judged "the voice is speaking" on frame ARRIVAL and held the ear for the whole
  session (0 reflex fires in 39 production delegations). Judge speaking on the
  output transcript or on audible frames (`outputLevel ≥ 0.02`), never on arrival.
- Every model generation on gpt-6-astra costs ~3.4 s (p90 5.9) regardless of
  effort on non-reasoning turns; latency ≈ 0.7 s + generations × 3.4 s. Cut
  generations (act first, verify from results, no closing screenshot), not tool
  time (55 ms median).
- AVFoundation raises ObjC exceptions Swift cannot catch — `installTap` "Failed to
  create tap due to format mismatch" after an input-device change (the format read
  from the node is stale until the engine is reset and prepared) aborted the app 5×
  on 2026-09-11. Every installTap / connect / reset / prepare / format read goes
  through `objcTry` (the `JarheadObjC` target's `JHTry`); taps use `format: nil`
  and convert from `buffer.format` lazily. Crash reports: `~/Library/Logs/
  DiagnosticReports/Jarhead-*.ips` (JSON after line 1; `lastExceptionBacktrace`).
- Numbers from audio are untrusted: an RMS over an empty buffer is 0/0 = NaN, and
  Swift's `min`/`max` pass NaN straight through (`max(nan, 0)` is nan). Clamp with
  `isFinite` first (`clampLevel`), guard `dt`/spring inputs, and never `Int(x)` a
  daemon number without a finite check (`Int(nan)` traps). The orb harness knob
  `ORB_LEVELS=nan` reproduces the old trap in `BlobSim.fittedColumn`.
- The CoreText "nil object" abort in `NotchView.drawIslandContent` (3× on
  2026-09-11) was a font-lifetime race inside CoreText on macOS 26.4 beta, not a
  bad number; the island's text now draws inside `objcTry` and survives it.
- When the app crashes, `CrashGuard` writes `~/.jarhead/crashes/<time>.txt`
  (reason, backtrace, the last 40 app log lines) and relaunches at most 3× per 10
  min; the daemon lingers 90 s after an app that left without a `bye` frame so the
  relaunched app re-attaches to the warm Codex thread. Read the crash file first.
