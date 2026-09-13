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
- **Agent statuses are lease-bounded, and `ended` is a word.** `AgentStatus` =
  `working` (a live owner process, a turn-bearing write within 30 s, no closing
  marker) · `idle` (a live owner otherwise) · `blocked` (an open permission
  question) · `done` (archived, or a run that finished and closed) · `ended` (no
  live process, however old — a session with no process is over) · `unknown`
  (the process evidence itself was missing: a degraded `ps`/`lsof`; never "old")
  · `offline` (a run handle closed). `AgentInfo.hint` says why a row reads as it
  does; `detail` carries no relative time (clients format it from `updatedAt`, so
  nothing churns a snapshot a second). Everywhere six statuses are known, seven
  are: `waitSettled` (ended settles), the brain's `agents_list` / `agent_wait`
  text, `jarhead status` (`agents N (3 working · 8 ended)`, an
  `AGENT_STATUSES satisfies Record<AgentStatus, 0>` pin), the Sessions rail. A
  tool call with no result when its session ended reads `interrupted`, no pulse.
  `send()` to an `ended` Codex session still resumes it.
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
  The memory pass touched one rail by one optional field — `BrainTask.memory?:
  string` in `brain.ts`, no prompt text, no version bump — because Kevin asked for
  the memory module by name; `# Language` lives in the engine-assembled
  `packages/live/src/language.ts`, not in `instructions.ts`, so no other rail moved.
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
pnpm build:mac                # builds, signs, installs /Applications/Jarhead.app IN PLACE (rsync; the bundle directory and its inode never change); build/Jarhead.app is a symlink to it. JARHEAD_INSTALL_HYGIENE=0 skips the Dock/LaunchServices audit, =fix also repairs the Dock
pnpm jarhead dock [--fix]     # one Jarhead: Dock tiles + LaunchServices records for /Applications/Jarhead.app, read-only; --fix drops recent tiles, rebuilds the pin, unregisters stale bundle paths, restarts the Dock only on a change
pnpm jarheadd                 # engine daemon alone; JARHEAD_AUTO_WAKE=0 keeps it quiet
pnpm jarhead status | say "…" | probe "…" | agents | cmd wake|sleep [cause]|mute|unmute|stop|pause|resume|agent.refresh|thread.stop <id|name>|thread.pause <id|name>|thread.resume <id|name>|worker.stop <id>
pnpm jarhead ledger --speed [--days N] | reflex-miss [--days N]   # where the time went (acting→screenshot share, now: lines, round trips by class, generation gaps); the short commands the grammar missed
pnpm jarhead memory [list] [--state live|forgotten|archived|merged|all] | search "…" | forget <id> | restore <id> | add "…" [--kind k] | run   # over the daemon; forget is a state, nothing is deleted
pnpm jarhead bench [--fake-hands] # the tool path and the ear's 250 ms path (+ read during a type, acting call incl. observation, status reflex, targeted stop); exit 1 when p95 to dispatch > 250 ms with the real helper
pnpm jarhead bench --brain [--runs N] [--effort low] [--observe off] [--compare F] [--no-reflex] [--json --out F] # the five representative commands on the real brain (Codex: Kevin's ChatGPT plan, no dollars; canned hands, no real actions); refuses when Codex is not signed in unless --allow-api-spend
pnpm build:hands              # Swift helper → build/jarhead-hands
apps/mac/Scripts/console-preview.sh [scenario] [out.png]   # Console with fake data (fixtures in apps/mac/Scripts/mock)
apps/mac/Scripts/onboarding-preview.sh [step] [out.png]    # Setup window with fake data (welcome … done)
scripts/make-readme-shots.sh [--only console|orb|onboarding] [--skip-build] [--audit]   # every README screenshot into docs/media, then an audit of README.md's image links
pnpm build:banner · pnpm build:media   # docs/media/banner.png (the README hero, 2560×800 so one 8 px cell is 4 CSS px); media = icon + banner; both wear the blob's `^ ^` (scripts/dither.ts FACE)
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
- **Narration is gated in one place.** The voice's `# Narration` rule (one clause
  per state change, never per click, never a tool's name) is mirrored in the
  Delegator's relay — `Delegator.narrationVerdict` — so no brain has to be trusted
  with it: a brain line naming one of `ALL_TOOL_SPECS` or reading as one click
  ("Clicking Save.") after something was voiced stays on the Console's timeline
  and never reaches Live. Jarhead's own lines (`say`: the summary, a reflex's
  landing, a failure, the first-tool line) are never gated — they are the answer.
  `speak_progress` goes through the brain's channel and is gated like any line —
  except a line that asks Kevin something (a question, "say yes"), and every line
  once a `confirm` step is pending: the runner's question quotes the command
  (`run "python edit_file.py"`), so it names a tool, and Kevin has to hear it or
  the handshake sits pending until his next request drops it.
- **Jarhead's own speech counts as "addressed".** `live.on("outputTranscript")`
  moves `lastAddressedAt`, so a pre-sleep clause judged against the idle clock
  re-arms itself every idle period and the session never sleeps while it bills.
  `Delegator.announceSleep` speaks once per idle stretch (Kevin's next words or
  the next task start a new one) and returns whether it did; the engine arms one
  deadline off `true` and sleeps at it unless `sleepAnnounced` has cleared —
  never by re-reading `lastAddressedAt`.
- **Carried history is a budget, not a transcript.** After a Codex rollover the
  fresh thread hears `renderCarry`: Kevin's words verbatim (never cut, even over
  budget), the spoken answers, and each tool result as one line — verbatim under
  200 chars *and* 200 bytes, else `[tool result, 3.1 KB]`. Size is the whole MCP
  result as the model saw it (a 1×1 PNG "screenshot" is 280 bytes: images count),
  the text kept in memory is capped at 1 200 chars, the block at ~2 KB with the
  oldest exchanges dropped whole first, the newest answer cut last. When the
  newest exchange alone is over budget its results all become placeholders —
  each naming its true size (`carriedResultLine(r, true)`), never a size inflated
  to force the swap: what the model is told about a result must be true.
- **A rollover's measure belongs to a turn.** `thread/tokenUsage/updated` carries a
  `turnId`; the server sends one per model request and one can land after
  `turn/completed` — or after the fresh thread's start reset `usage`. Judging it
  again would open a third thread for one oversized tool output. `needsFreshThread()`
  stays the pure measure (the tests read it); `rolloverDue()` is the trigger and
  refuses the turn that already rolled the thread over (`rolledOverForTurn`).
- **The notch island draws its content only while `parked`.** Anything that must
  show while the blob is out at its target (the "Working · 0:12" strip) draws
  *before* the park guard in `draw` and fades with `1 − park`; `setMode` gives the
  unparked island peek height only while `workingSince` is set, else it shrinks to
  nothing as before. The counter's width is measured once for the widest text
  ("Working · 00:00") so the peek never re-lays itself as the digits roll; the
  face slides left by half of it to keep the pair centred under the notch.
- **The island's working state is fed, not derived.** `NotchDock.setWorking(since:)`
  takes the snapshot's running delegation (`timings.delegatedAt / 1000`, nil when
  none); the phase is not a proxy — `acting` is also dictation, and a summary being
  spoken is `speaking` while the task is already done. The harness has no snapshot
  feed, so `ORB_NOTCH_WORKING=1` makes the state follow the phase there only.
- **Six builders, one worktree, one `swift build`.** SwiftPM fails with "input file
  … was modified during the build" when another builder saves mid-compile, and
  their half-edited files fail to compile in yours. `Scripts/orb-preview.sh
  --build-only` compiles exactly Model + UI + UI/Orb + UI/Overlay and is the compile
  check for those files while the package build is red on someone else's.
- Rules that came out of this pass (the other builders' learnings are forwarded by
  the integrator): **levels are untrusted numbers** (clamp at the source, `isFinite`
  before `min`/`max`/`Int`); **AVFoundation throws ObjC exceptions** Swift cannot
  catch (`JHTry` around every tap, connect, reset, prepare, format read);
  **tombstones, not deletes** (a conversation's state is the last row for its
  chain in an append-only file; day files move by `rename(2)`, nothing is ever
  unlinked); **grants never for destructive verbs** (a remembered yes is scoped to
  a conversation, an app, an action class and a deadline, and send / pay / delete /
  post / purchase stay spoken-yes-once).
- Cleanup never deletes: conversations get tombstone rows (`conversation.*`) in
  TODAY's ledger file, the bytes stay where they were written, whole day files
  MOVE to `~/.jarhead/trash` by rename(2) (`ledger.moved`), and every Console
  verb is Move to Trash / Archive / Restore / Rename / Pin — never "Delete".
  The Trash is emptied by Kevin in Finder, nowhere else.
- Shots folders were named by the UTC day while ledger files are LOCAL days; both
  now use `Ledger.dayFor`, so retention and the pinned/open guards line up.
- Grants (a remembered yes) are issued only by a recorded yes (`arm(record)`),
  keyed on app + action class, 20-minute ceiling, suspended by a cut and woken by
  the same chain's resume; key presses are never grantable; System Settings /
  Keychain Access keep every yes per action; destructive verbs (send, pay, delete,
  post, purchase) ask every time. A presence hold ("Not now") registers no
  pending confirmation — a bare "yes" after it lands nothing.
- `presenceAt` must be stamped by KEVIN's input only (wake word, ear utterance,
  Live input transcript, typed line, dictation) — never by Jarhead's speech or
  the model's actions, or the brain satisfies its own presence gate.
- AVAudioEngine hands the barge-in gate 100 ms buffers however small a bufferSize
  is asked for; onset → −20 dB is 80–140 ms. Sub-100 ms needs an AVAudioSinkNode.
  On the echo-cancelled path the mic ranking cannot be honoured (VoiceIO follows
  the system default); the picker says so.
- A class field initializer runs before the constructor body: `private transcript
  = this.newTranscript()` saw `this.now` undefined, so the first transcript used
  Date.now while later ones used the injected clock — pass clocks lazily.
- The hands helper is serial, so a cancel line queues behind the op it means to
  stop; the out-of-band stop is a signal whose default action is ignore (SIGURG).
- **The Dock's pinned tile is a bookmark keyed on the bundle directory's inode.**
  `rm -rf /Applications/Jarhead.app && cp -R` gave the directory a new inode every
  build; the pin's `book` blob stopped resolving and the running app came back as a
  second, "recent" tile. `pnpm build:mac` now rsyncs INTO the existing directory
  (`-rlptD -c --delay-updates --delete-after --itemize-changes`, each changed file
  renamed in, so the running app keeps its mapped inodes), verifies the INSTALLED
  copy (`codesign --verify --strict --deep`, the designated requirement's
  `identifier "com.kevinliu.jarhead"`, a sha256 parity walk against the stage, the
  directory inode unchanged), snapshots the last good bundle to gitignored
  `build/previous/Jarhead.app.previous` (never a name ending in `.app` — see the
  learnings below), refreshes LaunchServices (`lsregister -f`) and unregisters stale
  Jarhead bundle paths (the database only — the Trash's contents are never touched),
  then only READS the Dock. The Dock repair (`defaults export` → drop Jarhead's
  recent tiles, keep one pin stripped to bundle-identifier / file-data / file-label /
  file-type → `defaults import` behind a `mod-count` race check → `killall Dock` only
  when something was written) is `pnpm jarhead dock --fix` or
  `JARHEAD_INSTALL_HYGIENE=fix`; `=0` skips the audit. `planInstall` refuses a
  symlink, a regular file or another uid at the target before anything is written.
  Library: `@jarhead/cli/install` (pure functions over parsed plists and lsregister
  dumps, one injectable `exec`; every test runs in CI without a Dock).
- **lsregister waits on lsd.** `lsregister -dump Bundle` is ~2 s on an idle Mac and
  66–85 s at load average 300 (a self-edit build under a running test suite); a
  20 s cap made the LaunchServices half of the one-Jarhead pass silently do nothing
  exactly when a build was slow, and the reason was dropped. Every lsregister call
  now gets 120 s (`LSREGISTER_TIMEOUT_MS`), a failed dump carries its stderr into
  the line, and a build dumps once — the `-u` exit codes are the report; only
  `dock --fix` re-dumps to prove the records went.
- **openrsync `-E` emits AppleDouble.** `/usr/bin/rsync` is openrsync (protocol 29,
  "2.6.9 compatible"); `-E` (xattrs) with `--delay-updates` writes `._*` entries and
  `.~tmp~` errors into the destination, and FinderInfo/ResourceFork sideband inside
  a bundle fails `--strict`. The signature is embedded (the Mach-O and
  `Contents/_CodeSignature/CodeResources`), the bundle has no xattr but
  `com.apple.provenance`, and a copy without xattrs verifies strict — so never `-E`,
  never `-a` (owner/group rewrite), never `--inplace` (writes into the running app's
  mapped, signed binary); `parseItemized` fails the build if a `._` entry appears.
  `-c` (checksum) because two files of equal size in the same second were skipped by
  the quick check once.
- **Threads are not agents.** Agents (`agents_*`, the Console's Sessions rail) are
  Kevin's coding sessions on this Mac. Threads (`thread_start` / `thread_wait` /
  `thread_read` / `thread_stop`; `worker_*` accepted one release as aliases;
  `Snapshot.threads`, `THREAD_MAX_LIVE` 4 = main + 3, depth 1, names ≤ 16, budgets 25
  steps / 180 s per turn, caps 40 / 300; `Settings.workers` is still the on/off flag)
  are independent lines of work, each with its own brain (a warm `codex app-server`
  process from the `BrainPool`, `Settings.warmThreads` 2), its own conversation
  (`Delegation.threadId`; steps NEVER on the parent), lane, budget and blob: a
  **background** lane (Apple events, `browser_*`, files, shell, web; the pointer and
  keyboard are refused in the lane runner, not in policy.ts) or a **screen** lane that
  waits for the pointer under the lease's `rank` (Kevin's hands > main > threads by
  age). One engine table (`packages/engine/src/threads/table.ts`, Maps + a status count
  vector + a 512-event ring, O(1) reads, ≈ 100 KB, rebuilt from `thread.*` ledger rows
  at daemon start) answers "what is Spotify doing" and "stop the Slack one" with zero
  generations, judged at both the Delegator and the ear BEFORE the supersede block;
  `statusLine(name?)` is deterministic English. A spawned thread's change is one
  `thread.event` (≤ 200 B, coalesced 50 ms), never a snapshot; its conversation is a
  seq-paged `thread.transcript` to viewers only. A bare "stop" cuts everything as before
  with ≤ 1 live thread; with ≥ 2 the speech gate fires at once and the work cut waits
  350 ms for a name. Overflow defaults to `supersede` (today); `Settings.threadOverflow:
  "spawn"` is opt-in. Live stays open while a thread runs; the idle guard is
  `table.liveCount() > 0`; sleep stops every thread and spare.
- **Memory is a module, and a cap, not a saving.** `@jarhead/memory`
  (`packages/memory`, its own package so no core file becomes a rail) keeps an
  append-only `<stateDir>/memory/memory.jsonl` of one-sentence items about Kevin
  ("Kevin prefers …", kinds preference · fact · episode · procedure · contact ·
  place), extracted from CLOSED conversations only — the quiet tick, `!live &&
  !connecting && !pauseInfo`, ≥ 4 new Kevin lines since the watermark, one run
  per closed conversation — by a mini-class Responses model on Kevin's OpenAI key
  (dollars, never the ChatGPT plan; never Codex), or by regex rules with no key.
  Items are matched by embedding (text-embedding-3-small, 512 dims, cached by
  sha) or keywords, ADD/UPDATE/NOOP with a contradiction superseding the older
  item, scored by recency half-life · importance · confidence · use, picked by
  MMR. Forget / Restore / Archive are STATES (Console verbs never say "Delete");
  `memory.*` ledger rows carry ids only; a line the redactor changed, a Luhn card,
  an SSN or "my password is …" never reaches the extractor or the store; grants,
  confirmation exchanges, `now.cleared` windows and trashed chains are never a
  source; no vector ever enters a snapshot. Two injection points, both outside
  the standing orders (which have 16 words of headroom): the brain gets
  `BrainTask.memory` — the ONE field this pass added to the rail `brain.ts`
  (Kevin asked for the memory module directly) — rendered by `promptParts`
  (`anthropic.ts`, the one render site every brain kind uses) as `What you know
  about Kevin (durable memory; use it, do not repeat it back, do not say you
  remembered):` after `Recent conversation`, ≤ `BRAIN_MEMORY_TOKENS` 250, never
  in `kevinDialogue` (the gates must not read a remembered line as his words
  today); the voice gets `# Kevin, in brief` (≤ `VOICE_MEMORY_TOKENS` 120) in the
  engine's `sessionConfig` between `# Language` and `# Continuity`. The
  delegator asks `DelegatorOptions.memory(query, signal)` with the request plus
  Kevin's recent lines, in the same `Promise.all` as the marks and the eyes, cut at
  `MEMORY_RECALL_MS` 250 (a cold lookup is aborted, the task carries no block; the
  query embedding is cached as Kevin's final lines land, so it is usually a hit).
  **Blind spot:** with the `openai-responses` brain Live runs the backend itself
  (`responses.ts`), so the per-delegation block never reaches it — only the voice
  block applies. **Honest cost:** the budgets CAP what memory costs — ≤ 250
  tokens per delegation on the brain (≈ 20k a day at 81 delegations, on the
  Codex plan), ≤ 120 per session start on the voice ($0: Live bills per second) —
  nothing existing shrinks; the saving is Kevin never re-explaining himself and
  never having a transcript dumped into a prompt. Surfaces: `Settings.memory`
  (default on), Console Settings › Memory and the Memory rail, the Now rail's
  "used this turn" (`lastUsedIds`), `jarhead memory list|search|forget|restore|
  add|run`, `jarhead doctor`'s `memory` group (counts from the daemon; the
  `extractor` row names the id the engine WILL run — `JARHEAD_MEMORY_MODEL`, else
  the module's `DEFAULT_MEMORY_MODEL` — checked against the keys row's one free
  `GET /v1/models`, the key's best `*-mini` named only as the thing to pin; nothing
  records a pick on its own; never a session), the spoken "remember that …" /
  "forget that" reflexes in the engine
  hook (no brain, no tool: `remember`/`recall` stay per-session notes).
- **The desk.** The engine's root `ConfirmationState` stays; every toolset — the
  main lane too — gets `desk.lane(id, name)`. A question posts to the root when the
  floor is free, otherwise it queues ("Queued behind <Floor>'s question … stop and
  wait (worker_wait), do not retry"); `consume` is true only for the floor's lane;
  `promote()` re-asks the next queued question on the root and SPEAKS it with its
  worker's name. Kevin's yes is one action on the floor, never a grant to the queue;
  `dropQuestion()` / `clear()` drop floor and queue together. A "yes" while a worker
  holds the floor is relayed to it in `onDelegation` before any supersede.
- **The lease.** `FocusLease` is the one holder of pointer, keyboard and frontmost.
  Hand-over only at the holder's turn end, a confirm question, or 3 s of no acting
  call; a priority taker (main brain, dictation) waits `MIN_HOLD_MS` 1500 and never
  cuts mid-op, then re-fronts its remembered app after 300 ms settle. A worker tool
  waits at most 8 s then returns "waiting for the screen: …" (status waiting-screen);
  three waits fail it. Kevin's hands win inside the helper, atomically before the
  first `CGEvent.post`: `busy` when his own key/click/scroll was within 1500 ms
  (`secondsSinceLastEventType`, own posts excluded), `focus_moved` when the
  frontmost pid is not the `expectFront` one. STALE_FOCUS: a front app no lane
  activated means Kevin switched — nothing is ever pulled back in front of him. Two
  helper processes (`HandsPool { focus, background }`, same TCC identity, both with
  `SECRET_KEYS` stripped): screen actors use `focus`, background workers and the
  engine's own reads use `background`.
- **`fallAsleep(cause)` is the only closer.** `sleep()` (cause command), the idle
  tick (idle), pause decay (pause-decayed), a brain swap (brain-changed), the blob
  dropped into the notch (dock), `Engine.stop()` (shutdown) and `pressStop` (its
  `stop` row, then cause stop) all end there, idempotently: typed `sleep` row →
  `cutEverything` (both helpers, lease, workers, confirmations) → for `farewell`
  only, `FAREWELL_LINE` appended when the voice has not just said "night." and a
  wait for the first output delta + 300 ms quiet, cap 1800 ms → `detachLive` +
  `closeWithDeadline(live, "sleep:<cause>")` → phase asleep → toast →
  `workers.stopAll()`. Non-farewell causes flip the phase synchronously before the
  first await (pressStop needs that). The orb needs nothing: asleep already
  converges on `goHomeForTransition()`.
- **The sleep grammar is one regex with three entries.** `SLEEP` in `reflex.ts`
  sits after the dictation rows and BEFORE `OPEN` (so "go to sleep" is no longer
  `open_app Sleep` and "go to bed" no longer `open_app Bed`), anchored `^…$` over
  `normalizeUtterance` output: "go (back) to sleep/bed", "sleep now", "shut off",
  "shut yourself off/down", "turn yourself off", "power down/off", "good night",
  "night night", "that's all (for now/today/tonight)", "that's it for now",
  "(you're) dismissed", "you can/may rest", "stand down", "go dormant". Bare "shut
  down", "sleep", "night" and "stop" are NOT cues; "turn off the lights" and "shut
  down my Mac" are tasks. The ear checks it after STOP_WORDS and before the hold,
  only when `addressesJarhead` or within the 8 s exchange window (a "goodnight" to
  someone in the room never sleeps it); the Delegator checks it before
  supersede/refuse; `ReflexRunner.match` never runs it as a tool. The voice says
  exactly "night." and delegates the words unchanged (`# Sleep` in
  `instructions.ts`).

## Learnings (2026-09-12, workers / sleep / dither pass)

- The helper's `busy` check lives in `packages/hands/native/Input.swift` because only the posting process knows the timestamp of every event it posted: own posts are subtracted per kind with 30 ms slack, `mouseMoved` is not counted, `ownDriver` (dictation) skips it, `mouse_up` skips busy but not `expectFront`. `user_idle.foreignMs` is therefore per helper process — the lease reads it from the acting helper.
- `type` with a pre-post `expectFront` mismatch is an error `focus_moved` like a click's; a mid-text switch is a cancelled result with reason `focus_moved` and the characters landed.
- In the lease nothing decided before an `await` stands after it (the worker gate and the re-front are helper round trips; the lease re-judges after each). In the desk a root question that vanished takes its queue with it — only `consume` and `drop(laneId)` promote.
- Dither is the classic 8×8 Bayer matrix in point-sized cells (`Dither.cellPoints` 1.5 pt on the island, the meters and the blob's halo, 2 pt in `DitheredGradient` and the Dock icon), five bands (four on the Console ground). Blue noise at one device pixel with seven bands read as a smooth gradient; the pattern has to be big enough to see. The icon samples geometry per pixel and the threshold per cell so the silhouette stays crisp. Regenerate with `pnpm build:media` (= `build:icon` + `build:banner`) after any change to `scripts/dither.ts`, `icon-render.ts`, `make-icon.ts` or `make-banner.ts` (docs/media/icon.png, docs/media/icon-sizes.png, docs/media/banner.png and apps/mac/Resources/preview-icon-sizes.png are tracked; the icon must stay byte-identical across a pure refactor — `git status --porcelain docs/media apps/mac/Resources` after `pnpm build:icon`). The face (`FACE` in dither.ts, Kevin's `^ ^`) is a cell mask: one pattern from 64 to 1024, hand bitmaps at 32 and 16, pinned exactly by `scripts/__tests__/icon.test.ts`; `pnpm build:mac` rebuilds the icns whenever those scripts are newer than build/Jarhead.icns (it used to build it only when missing — the Dock showed a stale tile for days).
- Dither everywhere (Kevin: "use the dither theme across ascii loading states, the app background and more"): `Dither.Cache` is budgeted by BYTES (48 MB, count 32 as a second cap) with a pending queue capped at 4, so a resize drag drops its stalest sizes instead of rendering every frame's. The Console ground renders at scale 1 and is magnified by nearest (the same pixels as a 2× render with 4 px cells, a quarter of the work), at sizes rounded up to 64 pt (`sizeStep`) and pinned bottom-trailing, so the key changes only across a 64 pt boundary and the whisper corner stays in the window's corner; the last image holds while the next renders. A wipe's two halves must share one curve (`Motion.wipe`: insertion and removal both `easeOut` over `base`, the removal on the inverted tiles) or the ground shows through between them. `Motion.wipe` reads `Dither.Tiles.shared.hasWipe` and falls back to a fade, so a harness must `Dither.prewarm(scale:)` first thing (ConsolePreviewMain, OnboardingPreviewMain, OrbPreviewApp do); the app must too, in `AppDelegate.applicationDidFinishLaunching` after `installDockIcon()` — `NotchInk.prewarm()` only runs when the notch dock is built, so on a Mac without a notch nothing else would. Failing both, the first wipe or meter that asks (`Tiles.ensure(scale:)`) starts the build for its scale and takes its fallback once. `Dither.Cache` records the key in flight, so many views asking for one key (every JarheadMark in the rail) render it once; `DitheredGradient` / `DitheredShadow` ignore a render landing for a key they no longer want (the queue pops newest first, so under a resize an older size can land last). `Dither.Tiles` is an ObservableObject — a static view that asked before the tiles landed (a meter) must observe it or it keeps the fallback. The onboarding harness compiles Console files, so `Scripts/onboarding-preview.sh` lists `UI/Dither.swift` beside `UI/Motion.swift`. Console harness: scenarios `loading` (the glyphs; `PREVIEW_SLOW_THUMBS=1` holds thumbnails so skeletons show) and `wipe` (mid-wipe pictures + `probe` under the mask); actions `check-dither` (the Bayer/tile/glyph/bar/rounding pins in run.log — the package has no test target), `probe-ground` (the ground's colours from the window's own pixels) `snap:<name>` (the window's own pixels written in-process at the scheduled instant — `shot:` spawns screencapture and lands 0.1–0.3 s late) and `snap-wipe:<name>` (arms `Motion.wipeMidHook`: a pane's arriving `DitherWipe` (`Motion.curtain`; a thumbnail's `Motion.wipe` never reports) fires it on its first frame at 0.4 of the ranks and the snap follows 0.25 s later, the screen lagging the evaluation by a frame or two — the only way to a reproducible mid-wipe frame, since the wipe's frames saturate the main thread and starve timers). The `wipe` scenario also stretches the wipe to 2 s (`PREVIEW_WIPE_SECONDS` → `Motion.wipeSecondsOverride`, nil in the app) so there are frames to catch. Measured (2026-09-12, -O harness, traced per frame): a pane's first masked frame costs the main thread 0.3–0.5 s (RenderBox rasterises the masked pane through CoreGraphics; the arriving Jarhead pane also lands its entries then; no such stall under Reduce Motion's fade), then frames come every 45–150 ms — longer than the real 0.24 s wipe, so at real speed a pane switch is a freeze and a cut more often than a wipe. The stream's LEAVING half never animates (its inverted `DitherWipe` is evaluated once, at identity, and the pane is dropped whole when the transaction ends; a conversation's leaving half animates and complements the arriving stream exactly, leave = 1 − arrive on every frame) — neither an explicit `.id` nor one `withAnimation` around the whole open changed that — so the conversation panes carry `.zIndex(1)`: stepping in wipes the conversation in over the stream, stepping out wipes it away over the stream arriving beneath, and both directions read. The switch itself is made in `Motion.wipeAnimation` (the root ZStack's `.animation(_, value: paneKey)` — which overrides the call site's transaction for the pane change — plus `ConsoleSession.openJarhead`, the rail's agent toggle and the harness's actions): the transaction's animation is what keeps a leaving pane alive when its own half does not animate, so a shorter spring (`Motion.gentle` / `Motion.snappy`) dropped the stream whole before the arriving cells had covered it and the ground showed through the gaps. Masking only the arriving pane halves the work but is the same z-order problem; dropping the mask once full re-creates the pane and doubles the stall. Orb harness: an `ORB_EXPAND` or `ORB_OVERLAY` run takes no `phase-*` shots (they would overwrite the collapsed blob's halo pictures with the capsule), so shoot `preview-blob-phase-*.png` with the phases command on its own. Alpha-only CGImages have no Swift initializer with the nil colour space they need, so coverage images (the shadow, the bar's edge) are premultiplied RGBA. Committed pictures: `preview-console-{live,light,empty,loading,loading-still,wipe,wipe-mid,wipe-back,skeleton,conversation,jarhead}.png`, `preview-onboarding-{welcome,done,welcome-light,brain,light}.png`, `preview-blob-{expanded,light-expanded,phase-listening,phase-thinking,phase-acting}.png`, `preview-overlay-shapes.png`. Pane, rail-tab and feed↔ledger switches are `Motion.curtain(color)`: the arriving pane renders plain (`.transition(.identity)`, no mask, no zIndex) and a `DitherCurtain` of ground-coloured inverted Bayer tiles sits over it and disappears rank by rank over `Motion.base` (7–11 ms a frame; the switch's own turn 11–68 ms where the mask cost 300–500 ms). `Motion.wipe` (the mask) stays for small things: thumbnails, marks, the ground image landing. `DitherCurtain` must not be `Animatable` (a first cut was double-interpolated); `Reveal` is the Animatable modifier the transition drives. Both hosting windows set `hosting.sizingOptions = []` (their `minSize` is set by hand; `NSHostingView.minSize` re-ran a full layout pass per switch). The `timing` console-preview scenario traces main-thread turns per switch; the residual 100–270 ms frame per switch is the arriving pane's own construction (SwiftUI layout/CoreText), not the transition — a layout pass for later.

## Learnings (2026-09-12, one-Jarhead fixes: CI, the snapshot, the self-healing Dock)

- **A snapshot named `.app` is a second Jarhead to LaunchServices.** The rollback copy `build/previous/Jarhead.app` was a full bundle with Jarhead's id, and `lsregister -dump` on Kevin's Mac listed it next to /Applications — LaunchServices registers any `*.app` directory it meets, whatever unregistered it a build earlier. The snapshot is now `build/previous/Jarhead.app.previous` (`snapshotNameOk` refuses a `previous` that ends in `.app` before anything is written), `performInstall` retires the old name (`InstallSpec.retire`, an `rmTree` of the build's own artifact — never the Trash, never /Applications) before the new snapshot, and the stale rule already treats Jarhead's id at any other path as stale, so the record for the gone directory is `-u`'d by step 6 of the same build. The rollback line reads `rsync -rlptD -c --delete-after build/previous/Jarhead.app.previous/ /Applications/Jarhead.app/`. Anything else under `build/` that must be a bundle-shaped tree should follow the same rule.
- **openrsync's `*deleting` lines differ by build.** This Mac's openrsync itemizes the emptied directory as `Contents/Resources/`; GitHub's macos-15 runner prints `Contents/Resources` and every deletion twice (one line per `--delete-after` pass), which failed `install-bundle.test.ts` in CI with `['…/stale.txt','Contents/Resources','…/stale.txt','Contents/Resources']`. `parseItemized` is version-agnostic now — each path once, trailing slash trimmed, files and directories both kept in `deleted` — and the tests assert the SET (stale.txt present, nothing outside its subtree), never the list; `installLine`'s counts are of unique entries. Rule: never assert the exact shape of a system tool's chatter across macOS versions; assert what it means.
- **The Dock heals itself, on Kevin's press.** `ProblemKind` gained `dock` (protocol + the Swift mirror, whose `Problem.kind` is a String so an unknown kind still decodes; the Console's `problemSymbol` falls back to the triangle). Twenty seconds after `start()` the engine READS the Dock — `readDock`: one `defaults export com.apple.dock -`, never lsregister — and a pin with a recent Jarhead tile next to it (or two pins) is "Two Jarhead tiles in the Dock" with **Fix the Dock** (`problem.retry {kind:"dock"}`). The retry runs `repairDock` — the Dock half of `pnpm jarhead dock --fix`: import behind the mod-count check, `killall Dock` only when written — then re-reads and clears the row; `tick()` reads once more 10 s later (`DOCK_RECHECK_MS`) in case the relaunched Dock grew the tile back. A recent tile with no pin is one tile and no row (the fix could do nothing; pinning is Kevin's). The startup read never restarts the Dock. An import whose `killall Dock` failed is NOT a fix: cfprefsd holds the clean document while the Dock process still draws both tiles (and writes its copy back on its next event), so the re-read is not the truth — the row stays as "… — Dock not restarted" with a warn toast, no recheck is armed, a clean audit meanwhile keeps the row (`dockRestartOwed`), and the next press runs only `restartDock` (`killall Dock`). A press whose read fails toasts "Could not read the Dock: …" and leaves the row. Every Dock shell-out carries `timeoutMs` = `Engine.DOCK_EXEC_TIMEOUT_MS` (3 s; `DockOnlyOptions.timeoutMs`, forwarded by `readDock` / `repairDock` / `restartDock`) because they are spawnSync on the daemon's event loop; the CLI passes none and keeps defaultExec's 20 s. Seams: `EngineOptions.exec` (scripted in tests; `world.ts` exports `noShell`, which every `new Engine` in a test passes, so no test reads the real Dock) and `dockAuditDelayMs`. The engine imports `@jarhead/cli/install` (`packages/cli/src/install/index.ts`): no module cycle — that entry never loads the CLI proper — but a package-level one, resolved through the hoisted root `node_modules` like brain→daemon already is; declare it in `packages/engine/package.json` (and update the lockfile) if that ever stops working.

## Learnings (2026-09-13, threads / satellites / speed / messages / face pass)

- **The icon's orb was half a pixel off the squircle.** The squircle measured `x − (size − 1) / 2` (a pixel's centre minus the canvas centre — right) while the orb measured `x + 0.5 − (size − 1) / 2`, half a pixel up-left; nothing symmetric can be drawn on a disc that does not mirror across the canvas centre. Fixed to `x + 0.5 − size / 2` in the face commit (bytes change at every size anyway); the pure-refactor commit before it is byte-identical by the `git status --porcelain` gate. `checkIcon` counts asymmetric face pixels (0 at all seven sizes) so it cannot regress silently.
- **A face on a cell grid is one pattern, not seven.** cell = size / 64 keeps the orb at 32.5 cells from 64 to 1024, so the mask is computed on 64 cells and every larger size is that mask in bigger cells (pinned: mask(N)[y][x] === mask(64)[⌊y·64/N⌋][⌊x·64/N⌋]). The Chebyshev dilation that makes the one-cell ink box also fills the chevron's cavity — a designer's hand-drawn pattern will omit those cells; pin what the algorithm renders and look at the strip. Two sizes need hand bitmaps: at 32 the design's ±4.5 px eyes put the ring at 0.87 R, outside the circle's 0.82 bound — ±3.5 px is both inside and the nearer rounding of the blob's spread.
- **Never `git stash` in a shared worktree.** Seven builders edit one checkout at once; a stash reverts EVERYONE's uncommitted work for the seconds it is out, and a pop refuses when anyone touched a stashed file meanwhile (it did: B6 edited ConsoleRootView.swift in that window; the file was restored from the stash and the newer hunk re-applied by hand). To check a test against the untouched tree, read `git show HEAD:<file>` into the scratchpad and run it there. And `patch` leaves `<file>.orig` beside a file it rewrote — in a shared checkout that is litter a `git add -A` would commit into someone else's directory; run it with `--no-backup-if-mismatch` or move the backup to the scratchpad at once.
- **A bench row that is a tally is not a latency.** `bench` files every sample with a `unit` (`ms`, or `count` for "brain generations spent"); a count row prints `(count, not ms)` in the table and `unit: "count"` in `--json`, so a `1` in the median column is never read as 1 ms. `bench.test.ts` runs the fake-hands bench once and asserts the row SET, because a row that silently skips (a regex that stopped matching the helper's answer) only shows as a missing line nobody reads.
- **A gate the composer can trust is computed from the listing's own snapshot, synchronously.** `AgentInfo.send` reads what `statusFor` and `canContinue` read (archived, live owners minus our own pids, degraded detection, the Codex CLI's `usable()` — taken WITH the process snapshot so a listing costs no extra await — and a cached `statSync` of the session's folder); the reason is a short phrase the composer shows verbatim ("open in a terminal", "Codex not signed in", "folder is gone"). `SendResult.mode` (`queue | resume | answer`) says how an accepted line travelled; the wire's `AgentInfo.send.mode` vocabulary is `queue | resume` only, so a pending permission shows as `resume` with `pendingPermission` carrying the question.
- **Typed lines are transcript items, emitted once.** `Transcript.pushTyped` closes any open utterance first (its `final` is what writes the `heard` row) and emits the typed item as a single `final` — an item born final never "starts", and a second emission would write the ledger row twice.
- **`codex.test.ts` has a fixture that ages out.** The archived thread C2 is dated 2026-08-30 and the connector there uses `Date.now` with the 14-day window: from 2026-09-13 on, the health line counts "1 thread" and the test fails on any tree. Not this pass's change; pin `now` or move the fixture date.
