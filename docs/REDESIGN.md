# Jarhead v2 — redesign from first principles

Written 2026-09-10, the day GPT-Live-1 landed in the API, and extended by dated
sections since; every decision in the tree has its paragraph here.

## 1. The premise

Jarhead is a voice that uses the computer. One full-duplex model owns the
conversation and delegates; a brain Kevin already has a login for owns what happens,
through one tool table and one policy; a Swift helper is the hands on the real Mac;
an append-only ledger is the record of what was done. Every plane is measured, not
asserted, and each section below carries the day it was decided.

## 2. What changed in the world

**GPT-Live-1** (`wss://api.openai.com/v1/live/sessions`) is a full-duplex
front-end voice model that is designed to *delegate* reasoning and actions to a
backend. Verified on 2026-09-10 against this key:

| observation | measured |
|---|---|
| `session.start` → `session.started` | ~1.5 s cold, 0.26 s warm |
| user transcript deltas while Kevin is still talking | ~1 s behind the audio |
| `session.delegation.created` after "look at my screen and tell me what app is open" | 1.1 s after the last word |
| the model said "on it." on its own, then spoke the appended commentary verbatim-ish | 2.3 s after the append |
| output audio | continuous 24 kHz PCM, silence included (full duplex) |
| price | $0.05 / min, billed per second |

Client delegation is the whole architecture: Live owns the conversation, we own
*what happens*. Three append channels come back: `session.thinking.append`
(silent progress), `session.commentary.append` (say this), and
`session.instructions.append` (steer). Each capped at 500 tokens.

The **Claude Agent SDK** runs Claude Code headless with in-process MCP tools,
streaming input, and a permission callback, and Kevin's Claude Code login is what
authenticates it — no API key needed. Current Claude models point at pixel
coordinates off a screenshot well enough that Jarhead's own computer family (§10)
is all the Claude brains get: every brain drives the same 67 tools, and no vendor's
own computer-use toolset is mounted beside them.

## 3. The shape of v2

```
                 ┌──────────── Jarhead.app (Swift, apps/mac) ─────────────┐
  mic ──AEC──►   │ AVAudioEngine (24 kHz PCM in/out), Orb, Console, Overlay │
  speaker ◄──    │ wake word, TCC prompts; spawns and attaches to jarheadd  │
                 └──────────────────────────┬───────────────────────────────┘
                                            │ unix socket: JSON · mic PCM · speaker PCM
                 ┌──────────── jarheadd (node, packages/daemon) ────────────┐
                 │ Engine: Live session ─ Brain ─ Hands ─ Agents ─ Policy ─ Ledger │
                 └───────┬───────────────┬──────────────────────┬─────────────────┘
                         │ wss           │ brain: auto → codex · claude-code · anthropic-api · openai-compatible · openai-responses; local (explicit)
                    GPT-Live-1        (Codex CLI / Agent SDK / HTTP APIs, all over ToolRunner)   │ ~/.claude · ~/.codex · ps → agent sessions on this Mac
```

**Plane 1 — the voice (GPT-Live-1).** Always on while awake. Instructions hold
persona, backchannel/interruption policy, and the delegation policy. Everything
Kevin hears in under a second comes from here. Nothing in this plane waits on a
tool.

**Plane 2 — the brain.** One `Brain` interface (`start / handle / cancel /
stop`), chosen in Setup or the Console and swappable mid-run, with a backend per
`BrainKind`: `codex` (the Codex CLI with Kevin's ChatGPT login, Jarhead's tools
over MCP), `claude-code` (the Agent SDK with his Claude login; inherits his skills
and CLAUDE.md), `anthropic-api` (the Messages API with `ANTHROPIC_API_KEY`, the
67 tools as plain tool definitions), `openai-compatible` (Chat Completions at
`Settings.brainBaseUrl` / `JARHEAD_BRAIN_BASE_URL` with `JARHEAD_BRAIN_API_KEY`:
OpenAI, OpenRouter, vLLM, a hosted server…), `openai-responses` (Live's own
Responses delegation, same tools as function tools) and `local` (a model on this
Mac: Ollama's native `/api/chat`, LM Studio or llama.cpp over Chat Completions, at
a root the engine discovers on 127.0.0.1:11434 / :1234 / :8080 or `brainBaseUrl`
pins; explicit only). `auto`, the default, walks the cloud kinds in
`AUTO_BRAIN_ORDER` and takes the first that is configured *and* starts — never
`local`, because a server left running is not a choice Kevin made; the winner is
`snapshot.setup.brainResolved`. What is skipped quietly,
what earns a `problem()` line and which explicit kinds fall back to Responses is
§6c's rule. Each `session.delegation.created` becomes one
turn for whichever brain runs: the transcript window since the last delegation,
the current screen context, and the running task ledger. Every backend drives
the same 67 tools through `ToolRunner` — the hands (below), the agent
connectors, web search, shell — and streams progress back as `thinking.append`
and results as `commentary.append`.

**Plane 3 — the hands (native).** A Swift helper (`jarhead-hands`) speaks
newline-JSON over stdin/stdout and stays resident: ScreenCaptureKit
screenshots, CGEvent mouse/keyboard, CGWindowList, NSWorkspace, AX text. Sub-
10 ms per action instead of 100–400 ms of `osascript` startup, and negative
coordinates (Kevin's display sits above the primary) are just numbers. The TS
side implements the 17-member computer family (screenshot, mouse, keyboard,
scroll, zoom…) on top of it, with screenshot scaling and coordinate un-scaling in
one place.

**Plane 4 — the agents.** Connectors with one interface (`list / status / send /
read / events`). `sessions` discovers every agent session on this Mac — Claude
Code (`~/.claude/projects`), Codex (`~/.codex/sessions`), other agent CLIs found
on disk or in the process list — and `claude-code` continues a Claude Code
session headlessly through the Agent SDK. Nothing is tied to one product:
`AgentKind` is `"claude-code" | "sessions"`, and the Swift mirror decodes any
unknown kind as `sessions`. "Ask the reviewer agent to check the PR" is a brain
tool call, not a special case.

**The surface.** Dock + menu-bar app. A draggable **Orb** that is the presence:
listening / speaking / thinking / acting states, audio meter, tap to talk,
right-click menu. A **Console** window: live transcript, delegation timeline with
screenshots and every action taken, connected agents with status, settings
(voice, mic, brain kind / model / server URL, keys, permissions, wake word). A
click-through **annotation layer** that
shows where the hands are about to click and draws arrows when Kevin asks
"where is…".

## 4. Hard rules

1. **The voice plane never awaits a tool.** Only the brain does. Progress goes
   through `thinking.append`, never through blocking the socket.
2. **Irreversible actions are confirmed by voice.** Sending, paying, deleting,
   posting, submitting, and anything in a credential field: the brain describes
   what it is about to do via `commentary.append` and ends the delegation. Kevin
   saying "go ahead" is the next delegation; the pending action is then
   executed. Everything else (clicks, typing into a non-secret field,
   scrolling, opening apps, reading) runs without asking. The default is
   permissive on purpose: Jarhead is *meant* to use the computer.
3. **Append-only ledger.** Every delegation, tool call, screenshot path, and
   spoken sentence is appended to `~/.jarhead/ledger/<date>.jsonl`. The Console
   is a view over it; nothing is shown that is not recorded.
4. **Latency is measured, not asserted.** Every delegation records
   `heard → delegated → first thinking → first commentary → spoken`.
5. **Fail loud, not silent.** A dead mic, an expired session, a hung helper,
   an invalid key each has a visible state in the Orb and a line in the Console.
6. **Secrets flow one way.** The app may hand a key to the engine
   (`config.set-secrets`, limited to `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` /
   `JARHEAD_BRAIN_API_KEY`); the engine writes it to `~/.jarhead/env` (mode
   0600), reloads, restarts the brain and probes. Nothing ever comes back:
   snapshots carry presence (`setup.secrets`) and probe results, never values,
   and the app stores nothing.

## 5. Latency budget (what Kevin experiences)

| moment | source | target |
|---|---|---|
| Kevin stops talking → Jarhead starts replying (no action) | Live | < 700 ms |
| Kevin stops talking → "on it" | Live | < 1.2 s |
| delegation → first `thinking.append` (screenshot taken) | hands | < 400 ms |
| delegation → first `commentary.append` for a one-screenshot question | brain | < 4 s |
| single click/type action after a decision | hands | < 30 ms |
| barge-in: Kevin talks over it → audio stops | app | < 150 ms |

## 5b. Measured on 2026-09-10 (this Mac, `pnpm jarhead probe`)

| moment | measured |
|---|---|
| `session.start` → `session.started` | 533 ms warm, ~1.5 s cold |
| "hey jarhead" → Jarhead says "hey." | ~1.0 s after the words end |
| end of question → `session.delegation.created` | ~1.1 s |
| delegation → backend's first tool call (`frontmost_app`, native helper) | 1.31 s (the tool itself: 18–19 ms) |
| delegation → spoken result appended | 2.39 s |
| full-display screenshot through the Swift helper | 48–75 ms warm, ~145 ms cold |
| Claude Code brain auth probe when auth is broken | 30 s, then remembered for 30 min so the next launch falls back instantly |
| native app: launch → daemon spawned → client connected | ~1.5 s |
| native app: speech played through the speakers → transcript in the Console | ~2 s, with system echo cancellation active |

The OpenAI Responses backend (gpt-5.6-terra, effort low) carried these runs because
Claude Code could not authenticate on this machine that day; see the doctor output.

## 6. Cost control

A Live session bills every second it is open — muted or not. Jarhead sleeps
after 10 minutes without an addressed turn (configurable): the session closes,
the Orb dims, the mic stays local-only. Go / Pause / Stop are one transport
(§13; AppState's `// MARK: - Transport` region: `transportToggle()`,
`transportStop()`, `transportLabel`): Pause and Stop both close the session so
the meter stops the moment they land; a pause holds the conversation
(`snapshot.pause`) and decays to asleep at `pause.sleepsAt`; Go — or the wake
word — resumes it in a new session that carries the transcript as continuity.
Waking is ~1.5 s to `session.started`. Muting (`session.input_audio.mute`) is
instant but keeps the meter running; it is for Kevin's side of the room, not
for cost. The meter (`snapshot.usageToday` at $0.05 a minute) shows in the
capsule, the Console's right rail and the Jarhead section of the rail.

## 6b. The native shell (added 2026-09-10, same day)

Kevin: "make this a native app". The face is **Jarhead.app, a Swift macOS app**
at `apps/mac`, and the engine runs as a daemon (`jarheadd`, `packages/daemon`).

```
Jarhead.app (Swift/AppKit/SwiftUI)         jarheadd (node, spawned by the app)
  Orb: NSPanel, the ASCII blob       ◄──►    Engine over a unix socket:
  Console: SwiftUI window                    [type u8][len u32][payload] frames
  Overlay: click-through per screen          1=JSON control · 2=mic PCM · 3=speaker PCM
  Audio: AVAudioEngine + voice processing    Live · brain · hands · agents · ledger
  Permissions: mic / screen / AX prompts     jarhead-hands runs under the app's TCC identity
```

Why native: one stable TCC identity for microphone, screen recording, and
accessibility; a non-activating NSPanel that is draggable and interactive without
stealing focus; system echo cancellation (`setVoiceProcessingEnabled`) that makes
full duplex work next to speakers; a Dock icon and menu bar item that behave like
a Mac app. Why the engine stays in TypeScript: the Agent SDK, the Live client, and
the connectors are TS, and the daemon boundary is a five-byte frame header.

**The orb is a blob with a body.** Kevin: "there was a cute amorphous blob that
behaved like a liquid/fluid and u could swing it around and hit the edges of the
screen and so on and u could watch it react. it would also change color". The
blob (`apps/mac/.../UI/Orb`) is a silhouette of wandering harmonics with per-phase
personality and glyph ramps, spring-damped squish contacts and a shiver on phase
change — drawn as CoreGraphics glyphs on an NSView, one colour per phase with
eased blends — over a fluid body with momentum. Dragging pulls the blob on a short spring; letting go keeps
its velocity; it bounces off the work-area edges of its display and off other
windows' rectangles (CGWindowListCopyWindowInfo), each impact feeding a squish
contact. The panel window follows the body every display frame and the display
link stops when nothing moves. `summon()` flings it to the cursor. A single
click is play — the blob shivers and hops, nothing opens; the capsule is a
double-click or the right-click menu, and the panel never activates the app, so
the Console and Setup stay wherever they were.

**The chrome follows Kevin's Prototemplate canon** (`~/repos/Prototemplate`,
https://prototemplate.vercel.app): ink `#070707` / raised `#101010` / titanium
`#8a8f98` / paper `#fff`, white or ink text at 1.0 / 0.72 / 0.48, one accent
(`#2f5ce0`, dark lift `#5b82ff`) for the single primary action and selection,
1px hairlines drawn exactly once at three weights (structural 0.22, row 0.10,
frame 0.55 in dark), a single 6pt radius, SF Pro + SF Mono, and **solid SF
Symbols** on a fixed 20pt column instead of words wherever a word would be
redundant. Phase colours survive only as dots, icon tints and the blob itself.

**Wake word, local and gated.** Kevin: "a good wake word that doesn't use the
api that successfully runs on my voice, asks for a password or some form of
authentication, then is active". Asleep means the app — not the engine — holds
the microphone and runs Apple's on-device recogniser (`apps/mac/.../Wake`), biased
toward the wake phrases; no bytes leave the Mac and nothing is billed. Hearing
"jarhead" starts authentication: Touch ID / Apple Watch / Mac password via
LocalAuthentication, or a spoken/typed passphrase kept as a PBKDF2 hash in
`~/.jarhead/wake-auth.json`, whichever the settings ask for (default: either).
Only success sends `go` from the listener (a deliberate Orb tap, the hotkey, the
menu-bar item and `jarhead cmd go` stay direct); three failures lock the
gate for a minute; the daemon no longer auto-wakes while the gate is on. Speaker verification (voice biometrics)
was deliberately not attempted — macOS has no public API for it and a home-made
voiceprint would be a false sense of security — so "runs on my voice" is met by
on-device recognition tuned with the phrases and a live "what I heard" readout for
calibration, and the security comes from the authentication step.

**Audio and permissions, as shipped.** Echo cancellation follows the system
default microphone (the VoiceIO unit has one device property for both
directions); a failed audio start retries with backoff and surfaces a toast; the
app re-checks the microphone grant on every activation; Stop, a spoken
"stop"/"cancel" and sleep emit `speaker-flush`, which the daemon forwards as the
`audio/flush` control so queued speech is dropped instantly. The bundle is signed
with any valid identity so TCC grants survive rebuilds; ad-hoc is the fallback
and `pnpm run doctor` says so.

**Setup (onboarding), added 2026-09-10.** Kevin: "it just links to anything and
everything and should be able to use any kind of brain that you can configure. so
have onboarding basically". The first launch (`settings.onboarded` false in the
first snapshot) and the menu-bar item *Set Up…* open a wizard
(`apps/mac/.../UI/Onboarding`): welcome (is the daemon up), voice
(`OPENAI_API_KEY` → `config.set-secrets`; the engine probes and the result is
`snapshot.setup.openaiKey`), brain (kind, model, base URL; `ANTHROPIC_API_KEY` /
`JARHEAD_BRAIN_API_KEY` the same way, then `config.probe` →
`setup.brain` / `brainDetail`), permissions (PermissionsKit deep links), wake word
(phrases, authentication, passphrase), agents (the sessions found), done
(`set-settings {onboarded: true}`). Secrets travel one way — hard rule 6.

## 6c. Brains (added 2026-09-10)

Kevin: "why isnt it connecting to our codex? i have one locally. be vendor
agnostic, dont just enforce claude code". The brain is a setting, not a vendor.
`Settings.brain` is one of seven `BrainKind`s; every one drives the same 67 tools
through `ToolRunner`, so policy, ledger, screenshots and the confirmation
handshake are identical whichever model is thinking.

| kind | what runs | needs |
|---|---|---|
| `codex` | a resident `codex app-server` thread (one warm process, `codex exec` only as the fallback) from the CLI bundled in ChatGPT.app (Codex Desktop) or on PATH, with Jarhead's tools mounted as the `jarhead` MCP server (`packages/brain/src/mcp-bridge.ts`) | Codex signed in — the ChatGPT login in `~/.codex/auth.json`; no key |
| `claude-code` | headless Claude Code through the Agent SDK, tools as an in-process MCP server | the `claude` login (or a valid `ANTHROPIC_API_KEY`) |
| `anthropic-api` | the Messages API tool loop | `ANTHROPIC_API_KEY` |
| `openai-compatible` | Chat Completions with function tools at `brainBaseUrl` (OpenAI, OpenRouter, vLLM, a hosted server…) | the URL and a model; `JARHEAD_BRAIN_API_KEY` where the server wants one |
| `openai-responses` | the Live session's own Responses delegation (gpt-5.6-terra) | only `OPENAI_API_KEY`, which the voice already has |
| `local` | Ollama's native /api/chat, LM Studio / llama.cpp over Chat Completions, at a discovered or pinned root | a running server and a pulled model with tools; explicit only |
| `auto` (default) | the first of the above that is configured *and* starts, in `AUTO_BRAIN_ORDER`: codex → claude-code → anthropic-api → openai-compatible → openai-responses. `local` is never picked by `auto`. | — |

`auto`'s rule: a backend that is not configured (no binary or login, no key, no
URL) is skipped with a log line; one that is configured but cannot start gets a
`problem()` line in the Console, because that is something Kevin can fix. The
winner is `snapshot.setup.brainResolved`; `pnpm jarhead doctor` shows it (from
the running daemon when there is one, otherwise what this Mac would resolve to).
An explicit `codex` that cannot start walks on down the same order; the other
explicit kinds fall back to `openai-responses` — for `local` loudly: the problem
row says the brain's work goes to OpenAI and memory stays local, the Ready row
shows the resolved kind, and a 60 s heal timer restarts the local brain the moment
its server answers again. `brainModel` empty means the backend's own default
everywhere (for Codex: the `model` in `~/.codex/config.toml`); under `local` it
means the best fit on this Mac, reported as `setup.local.picked` and never written
into `settings.json` by the engine — only Kevin's click in the Model menu pins an id.

**How Codex acts.** The resident `codex app-server` thread (§11 "Warm Codex", §15) is
the path: one `thread/start` per brain start with the standing orders as developer
instructions, then one `turn/start` per delegation carrying the task and the eyes'
shot as `localImage`, `turn/interrupt` on stop, a fresh thread only when the context
fills. `codex exec` is the fallback — a task that arrives before the app-server is up,
an app-server that cannot start or dies, or `transport: "exec"` asked for — and runs
one process per delegation: the standing orders and the task on stdin, JSONL events
on stdout, `--ephemeral` so nothing lands in Kevin's Codex history. Both run in
Codex's read-only sandbox from Jarhead's private `CODEX_HOME` (§15; exec adds
`--ignore-user-config`): Kevin's own config.toml enables Codex's computer-use,
browser and REPL servers, which would let it act on the Mac around Jarhead's
policy. The only way it can act is the `jarhead` MCP server, whose every
`tools/call` is a `tool.run` message over the daemon socket
(`packages/daemon/src/wire.ts`) into `engine.runner` — the same ToolRunner as the
in-process brains. Screenshots come back as MCP image content; `needs_confirmation`
comes back as text and the standing orders tell Codex to report the question and
stop. Approval policy is `never`, so the server is declared with
`default_tools_approval_mode="approve"` — without it every MCP call is refused ("MCP
tool call requires approval, but approval policy is never", learned the hard way).
Event mapping on exec: `mcp_tool_call` → a thinking line (the runner records the
step itself), `agent_message` → notes (the one before the first tool call is relayed
as a thinking line as well, so the voice has something to say during Codex's
start-up), the last one the spoken summary, `turn.completed` → done, `turn.failed` /
`error` → failed; stop is SIGINT, then SIGKILL after 3 s; budgets are 40 tool calls
and 5 minutes like the API brains. The bridge is pointed at the daemon socket only
when the daemon there is this very process (its `hello` carries its pid); otherwise
— `jarhead live` / `probe` hosting an engine while Jarhead.app's daemon holds the
default path, or `jarheadd --socket X` — the brain serves its own
`<stateDir>/codex-tools.sock` with the same `DaemonServer`, so steps, screenshots
and a pending confirmation never land in another process's runner. Jarhead's
secrets (`SECRET_KEYS`: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`JARHEAD_BRAIN_API_KEY`) are stripped from Codex's environment; the ChatGPT
login under `CODEX_HOME` is all it gets. The bridge also works standalone —
`JARHEAD_SOCKET=~/.jarhead/jarhead.sock node node_modules/tsx/dist/cli.mjs
packages/brain/src/mcp-bridge.ts` — so any MCP client can borrow Jarhead's hands
while the daemon runs.

Measured 2026-09-10 on the fallback, tiny `codex exec` runs: a turn with two tool
calls took ~17 s end to end with the CLI's default model at effort low (85k input
tokens); a bare "reply ok" turn with `-m gpt-6-astra`, effort low and no MCP server
took 6.5 s (thread.started 1.3 s, turn.started 2.4 s, the skills-budget `error`
item 3.5 s, the answer 5.8 s; 20.9k input tokens). Codex discovered Kevin's skills
(`~/.codex/skills` → the wiki runtime, plus the bundled plugins'; the budget error
named 443 dropped) on every run — the knob that removes the catalog
(`skills.include_instructions=false`) and the private home that hides the rest are
§15. The bridge starts in ~300 ms and a tool round-trip over the socket is about a
millisecond. Net on exec: Codex's first speakable line reaches the voice ~6 s after
the delegation, against §5's 4 s target and the Responses path's 2.4 s (§5b); on the
resident thread the first visible action is 4.4 s median (§15, docs/LATENCY.md).
`auto` prefers Codex because that is the contract's order and Kevin's login, not a
latency call.

## 7. Package map

```
packages/protocol   the contract: snapshot, events, commands, ledger rows, settings (Swift mirror: apps/mac/…/Model/Protocol.swift)
packages/live       GPT-Live-1 client: session, typed events, transcript, appends, the language section
packages/hands      the toolset over the helper: the computer family (17), HandsPool (focus + background), FocusLease, ConfirmationState, SplitHands
packages/hands/native  jarhead-hands: 29 ops, newline JSON, ScreenCaptureKit + CGEvent + AX + compiled Apple events; built by scripts/build-hands.ts
packages/agents     connectors: sessions (Claude Code / Codex / other CLIs on disk or running), claude-code (Agent SDK; continues a session)
packages/brain      Delegator + ToolRunner + one Brain per BrainKind (§3, Plane 2), the tool table, reflexes, self-edit, the MCP bridge for Codex
packages/memory     @jarhead/memory: the append-only store of one-sentence items about Kevin, extraction, embeddings, recall (§19)
packages/core       config, env, ledger, trash, policy (run / confirm / refuse), latency marks
packages/engine     the Engine: sessions, the transport, threads (table, scheduler, brain pool), sleep, problems, permissions, snapshots
packages/daemon     jarheadd: the Engine served over a unix socket (binary frames)
packages/cli        `jarhead`: doctor, status, live (headless), probe, say, agents, hands, ledger, memory, bench, reflex-miss, dock, cmd <go|pause|resume|stop|interrupt|sleep|mute|unmute|agent.refresh|thread.*>; the in-place installer (`@jarhead/cli/install`)
apps/mac            Jarhead.app (Swift): blob, notch, overlay, Console, Setup, audio, wake gate, ear, permissions, crash guard, daemon client, packaging
```

## 8. Decisions taken without asking (and why)

- **Audio in the app, not ffmpeg.** System echo cancellation and noise
  suppression (`AVAudioEngine` voice processing in Jarhead.app) are what make
  full duplex work in a room with speakers, and the app is the one process TCC
  keys the microphone grant on. The headless CLI keeps ffmpeg/ffplay for terminals.
- **Claude Code as the default brain** — superseded 2026-09-10 by `auto`
  (`codex → claude-code → anthropic-api → openai-compatible → openai-responses`,
  the contract's `AUTO_BRAIN_ORDER`): the brain is a setting, not a vendor. The
  original reasons still hold for Claude Code's place in that order — it needs
  no key (Kevin's login), it inherits his skills and CLAUDE.md, and it is itself
  one of "Kevin's agents" — and the `ANTHROPIC_API_KEY` in his shell was
  rejected by the API on 2026-09-10, which is why `anthropic-api` sits behind it.
- **Never read another app's token store.** A connector that needs a login pairs
  the way a phone would (a device-pairing flow the product offers) or is not
  written; the `sessions` connector reads session files and the process list,
  never credentials.

## 9. Sessions you can step into, a screen you can circle, a blob that flies (planned 2026-09-10, built the same night)

Kevin: "for sessions use the agent icons and color for what they are. and be able
to hop in the actual conversations and see everything and talk with it like it's
the actual agent app in like codex or claude code. but then also be able to circle
stuff on my screen for jarhead, and jarhead should also be able to fly around,
select stuff, show the actions that run in the background with jarhead actually
flying around, it can teach you by creating shapes and showing stuff."

### The vision

Three loops share one surface — Kevin's screen — and one presence, the blob.

1. **Sessions are first-class conversations.** The agents rail shows each session
   with the mark and colour of the agent that owns it (Codex, Claude Code,
   Cursor, Gemini…). Clicking one *steps into it*: the full conversation renders
   in the stream — every user turn, assistant reply, tool call with its input and
   output, reasoning folded away — and keeps growing live while the agent works,
   because the engine tails the session file. The composer at the bottom talks
   to *that* agent; a resumed Claude Code session's permission questions appear
   as yes/no right there. It should feel like sitting in Codex Desktop or Claude
   Code, not like reading a log.
2. **Kevin can point.** ⌥⇧C (or the orb menu) enters mark mode: the overlay
   stops being click-through for one stroke, Kevin circles anything, the stroke
   is echoed back on the layer, and the engine screenshots the circled region.
   The mark is *context*: Live hears that Kevin circled something, the next
   delegation carries the image and the region, and every brain (Codex as a
   `localImage` on the turn, Claude via image blocks, Anthropic API,
   OpenAI-compatible, Responses) sees it. "What is this?" while circling a dialog just works.
3. **Jarhead shows its work.** When a brain acts, the blob flies to where the
   action lands, hovers while the hands click, type or scroll, and the overlay
   pulses the click, traces the drag, and frames the region being read. When a
   brain explains, it can *draw*: circles, arrows, rectangles, freehand strokes
   and short labels on the click-through layer, fading after a few seconds — so
   "the button is here, then drag this there" is a shape on the screen, not a
   sentence. The blob's flight is the same fluid body: a spring flight, an
   impact squish on landing, and it stays where it worked when it is done (2026-09-11:
   in both homes — the notch dock is only for the awake↔asleep transitions; the explicit
   `orb.home` is the one way back mid-session).

### Architecture

```
Console ── agent.open ──► Engine ── registry.transcript/watch ──► sessions connector
   ▲  agent.transcript (replace/append)                       (Claude JSONL, Codex rollouts,
   │                                                            fs.watch tail while open)
   └── composer ── agent.send ──► runners (Codex exec/queue, Claude SDK resume)

Overlay ── mark mode stroke ── mark.add {rect,path} ──► Engine ── hands.zoom(rect) → shots/
                                                            │      pending ScreenMark, Live note
                                                            └──► Delegator → BrainTask.attachments → every brain

ToolRunner (click/type/scroll/drag/zoom) ──► overlay events: orb.fly → click-pulse / path / rect
Brain tools show_circle / show_arrow / show_rect / show_text / show_stroke / show_clear ──► overlay shapes
Orb ◄── overlay commands (orb.fly / orb.home) ── spring flight, hover, drift home
```

### Contract (packages/protocol — the truth; Model/Protocol.swift mirrors it)

- `AgentInfo.tool: AgentTool` ("claude" | "codex" | "cursor" | "gemini" | "opencode" | "amp" | "droid" | "hermes" | "pi" | "other") and `messageCount`.
- `AgentMessage {id, role: user|assistant|tool|system, text, at, tool?: {name,input?,output?,status}, thinking?}`;
  `AgentTranscript {agentId, messages, total, complete, live, cursor?: {startOffset, endOffset}}`.
  `AgentStatus` = idle | working | blocked | done | **ended** | unknown | offline and `AgentInfo.hint` (§17
  "Status words" has the words); a tool call's `status` gains `interrupted` (no result when its session ended).
- Commands `agent.open {agentId, viewer?}` / `agent.close {agentId, viewer?}` (a pane token, so an open is
  idempotent per pane and the daemon drops a dead client's viewers) / `agent.history {before}`; event
  `agent.transcript {transcript, mode: replace|append|prepend}` (prepend = an older page, inserted before
  what the client holds; the daemon forwards it as a JSON message of the same name).
- `ScreenMark {id, rect, path?, at, screenshotPath?, consumed}` in `Snapshot.marks`; commands `mark.add {rect, path?}` / `mark.clear`.
- Overlay: `circle` / `arrow` / `rect` / `text` / `stroke` (with `tone: accent|ok|warn|mark`, `ttlMs`), `orb.fly {x,y,dwellMs?,reason?}`, `orb.home`.
- Brain: `BrainTask.attachments?: [{path, mediaType, note}]`; tools `show_circle`, `show_arrow`, `show_rect`, `show_text`, `show_stroke`, `show_clear`.
- App: hotkey ⌥⇧C → `AppState.beginMarkMode()` → `OverlayManager.beginMarkMode()`; `AppState.transcripts[agentId]` fed by the daemon client.

### Brand marks

No vendor logos ship in the bundle. Each tool gets a drawn glyph and its colour:
Claude Code — a four-armed asterisk in Anthropic terracotta `#d97757`; Codex — a
`>_` prompt in paper on ink (OpenAI's mono); Cursor — a pointer arrow in paper;
Gemini — a four-point sparkle in `#4796e3`; OpenCode — a bracket pair in `#6ee7a0`;
Amp — a bolt in `#ffb454`; Droid / Hermes / Pi — a monogram in titanium. The glyph
is the row's icon; the colour is the status dot's ring and the conversation header.

### Built since (2026-09-11 evening)

- **The Console has two sections.** "Jarhead" first: its own conversations — a Now
  row (the live or paused session: elapsed · billed, "paused · meter stopped",
  "asleep"), then past conversations newest first under day heads, a resume chain
  (`session.started.resumedFrom`) folded into one row ("resumed ×n"). A past
  conversation opens read-only with a Conversation | Log toggle; the Log is every
  ledger row of the chain, including `pause` / `resume` / `stop`. Then "Agents",
  as before. The ledger answers `ledger.sessions` / `ledger.session` over the wire
  (`Ledger.sessions()` / `readSession()`, memoised by file signature).
- **The notch island is one ink shape** — the notch's column through the menu bar,
  concave fillets flaring onto the island's top edge, convex 18 pt top corners,
  12 pt bottom corners — carrying the app icon's dithered orb gradient pooling out
  of the black notch (`UI/Orb/NotchInk.swift` over `UI/Dither.swift`). Open, the
  420×184 island is four bands — anchor, display, control row, foot — never stacked
  rows. Go at the anchor's foot is the transport: a 22 pt ring in the phase colour,
  play while asleep or paused, pause while awake, ellipsis while connecting; Stop
  and Mute sit beside it.
- **Every shaded surface is dithered.** One renderer, `UI/Dither.swift`
  (`Dither.gradientImage` / `coverageImage`, `Dither.Cache`, `Dither.Tiles`;
  `DitheredGradient`, `DitherWipe`, `DitherCurtain` (the pane switch: ground-coloured tiles over a plainly rendered pane, never a mask), `DitheredBar`, `DitherGlyphs`, `DitheredShadow`),
  the classic 8×8 Bayer matrix in 2 pt cells on grounds, heroes, skeletons and
  wipes, 1.5 pt on bars, the island and the halo; five bands on colour, four on the
  Console ground (`groundStops`, the accent as a whisper in the lower-right corner).
  The Console and Onboarding grounds, the onboarding heroes, the Jarhead mark, the
  meters, the thumbnail skeletons, the capsule's floor and every loading state are
  this material; view switches dissolve through it (`Motion.wipe`); the thinking
  indicator steps its ranks as ASCII at 8 fps. The icon and the README banner share
  the palette, the matrix and the orb through `scripts/dither.ts` (`pnpm build:media`),
  and both wear the blob's `^ ^` (`FACE`, `faceMask`; §20): flat paper chevrons boxed
  one cell deep in flat ink, one cell pattern from 64 to 1024, hand bitmaps at 32 and
  16. The 14 pt `JarheadMark` in the Console and the notch island carry the orb
  faceless — below the Dock's 32 px class a face reads as a status, not a creature
  (the rule sits in `Dither.swift`'s header). Flat fills stay flat.
- **The blob stays where it worked** in both homes; the notch dock is only for the
  awake↔asleep transitions. Into the notch it goes by approach + slip: a
  critically damped approach (`Motion.approach`) to a staging point 16 pt under
  the dock, then over `Motion.tuckSlip` the body rises under the ink shrinking to
  0.55 and fading while the notch face comes up at 60 % — one hand-off, nothing
  pops; out of the notch is the reverse (`Motion.dropOut`). Flights crouch before
  they leave (`Motion.anticipation`) and settle on `Motion.body`; expressions
  change through a blink (`Motion.blink`); the phase colour crossfades.
- **One motion vocabulary**, `UI/Motion.swift`: durations, curves (as
  CAMediaTimingFunctions and as numbers for display-link code), SwiftUI springs,
  `appear` / `swap` transitions, `reduced`. The Console's panes crossfade, the
  rail selection and segmented thumbs glide, new stream rows fade and rise on
  their own opacity only (the feed's height never animates, so the sticky scroll
  holds), toasts and pills arrive bouncy and leave easing in, onboarding steps
  slide by direction, overlay shapes draw on and fade out.
- **Harness knobs** (headers of `Scripts/*-preview.sh`, `UI/Orb/OrbPreviewApp.swift`,
  `Scripts/ConsolePreviewMain.swift`): `ORB_TIMELINE`, `ORB_FACE_LOG`,
  `ORB_SLEEP_AT` / `ORB_WAKE_AT` / `ORB_SLEEP_PHASE` / `ORB_DRAG_OUT_AT`,
  `ORB_NOTCH_HOVER` / `ORB_NOTCH_PRESSED` / `ORB_NOTCH_SHOT_TAG` /
  `ORB_NOTCH_OPENING_SHOTS` / `ORB_NOTCH_NO_POINTER`, `ORB_REDUCE_MOTION`;
  console scenarios `jarhead`, `jarhead-log`, `paused`, `switch` and the
  `PREVIEW_ACTION` grammar; onboarding `PREVIEW_GO` / `PREVIEW_SHOT_AT` /
  `PREVIEW_REDUCE_MOTION`.

### Built since (2026-09-12)

- **Dropping the blob into the notch dock puts Jarhead to sleep.** A drag that ends
  over the notch's column (48 pt either side, 70 pt under the menu bar) closes the
  session (the meter stops) and the sleep transition tucks it in; asleep already, it
  just goes home; a drag-out that had made it free is undone (`dropIntoDock` in
  OrbPanelController). Kevin's words: "if i drag jarhead to my dock im putting him
  to sleep".
- **Conversation cleanup** (§17): Trash / Archive / Rename / Pin per conversation
  with undo, Clear Now with undo, hide an agent, a retention sweep that moves whole
  days by rename, a search box over the live ledger, typed problems with one-tap
  remedies in the rail.

## 10. Anything and everything, gated by policy; and a Jarhead that rewrites itself (2026-09-10)

Kevin: "make jarhead be able to do anything and everything even rewriting its own
code. but make its system prompt super strong and robust too".

### The capability model

The brain's tool table (`packages/brain/src/tools.ts`, one table for every
`BrainKind`) now covers the whole Mac, and what used to be "not a tool" is
"a tool with a gate". Sixty-seven tools in nine families: the computer family
(17), desktop (8), browser (6), agents (5), threads (4: `thread_start`,
`thread_wait`, `thread_read`, `thread_stop`), misc (`run_shell`, `speak_progress`,
`remember`, `recall`), **system** (11: `read_file`, `write_file`, `edit_file`,
`list_dir`, `search_files`, `web_fetch`, `web_search`, `applescript`, `open_url`,
`clipboard_read`, `clipboard_write`), **self** (`self_edit`, `self_check`,
`self_review`, `self_apply`, `self_discard`, `self_status`) and the drawing
shapes (6). Every one runs through `ToolRunner`, in-process or over the daemon
socket (Codex), so the ledger, the screenshot archive and the confirmation
handshake are the same for every model.

The gate is `packages/core/src/policy.ts`, one pure module with four classifiers
and one vocabulary — `run`, `confirm`, `refuse` — each verdict carrying a reason
a model can read aloud:

| classifier | run | confirm (the handshake) | refuse (the never list) |
|---|---|---|---|
| `classifyAction` (hands, `run_shell`) | clicks, typing, opening apps; any shell command not listed to the right — a plain `curl` GET, `ls ~/.jarhead`, `find ~ -name '*.pdf'`, `git status` in the checkout | irreversible-looking controls (Send, Pay, Delete…); hands-off apps; `rm`/`unlink`/`mv`-to-temp/`> file` outside temp and Jarhead's scratch — behind any wrapper (`command`, `exec`, `nohup`, `env`, `time`, `sudo`, `then`), inside `bash -c '…'`/`eval`, in `find -exec`/`xargs`, or in a `python -c`/`node -e` script; `git push` / `--force` / `reset --hard` / `clean -f`, `rsync --delete`, `sudo`, `kill`/`pkill`/`killall` of processes Jarhead did not start, `chmod -R`, pipe-to-shell installs, publishing and deploying, `defaults write`, `launchctl`, writes into `/System` `/Library` `/usr` `/etc`, into `~/Library/LaunchAgents` or an rc file, dropping databases, cloud/container deletes; **egress** — a network client (`curl`, `wget`, `ssh`, `nc`, `http`) carrying `@file`, `< file`, `$(…)`, a request body or the previous pipe's output, or a one-liner script that reaches the network; **environment dumps** (`env`, `printenv`, `export -p`, `set`, `ps -E`); an archive or recursive copy of `~` or `~/Library`; any write into the running checkout (`sed -i`, `>`, `cp`/`mv` into it, `git commit/merge/…`, `pnpm add`, `codex exec -s workspace-write`, `claude --dangerously-skip-permissions`) by path or by cwd; mail | `mkfs`, `diskutil erase*`, `dd of=/dev/…`, shutdown/reboot/halt, `security dump/export/delete-keychain/find-*-password`, `tccutil reset` for other apps, `crontab -r`, fork bombs, `rm -rf /` or `~`, `csrutil`/`nvram`/`spctl --master-disable`; any command that names a secret store in any spelling (`~`, `$HOME`, `/Users/x`, `/./`, `//`), reads a secret-named variable (`$X_TOKEN`, `${#OPENAI_API_KEY}`, `os.environ[…]`, `process.env.…`), or reaches a store without naming it — a wildcard inside `~/.jarhead`/`~/.codex`/`~/.claude` or over `~/.*`, a `cd`/`-C` into one of those, anything but `ls`/`du`/`stat`-class commands naming one of those folders, a recursive `grep`/`rg`/`find -exec cat` over `~`; a working directory inside a store or one of those folders |
| `classifyPath` (file tools) | reading anything else; writing under `/tmp`, `~/.jarhead`, the state dir, a self-edit worktree, or a folder Kevin named *in his own words* | writing elsewhere; overwriting a file the brain has not read this task; any deletion; the ledger (append-only) and `settings.json` (the wake gate lives there); anything under the running checkout (`REPO_ROOT`), `~/Library/LaunchAgents`, login items or an rc file — named or not | the secret stores under either spelling of the path (the lexical one and the `realpath` the runner passes, so a symlink under `/tmp` into `~/.ssh` is `~/.ssh`): `~/.jarhead/env`, `wake-auth.json`, `~/.ssh`, `~/.aws`, `~/.gnupg`, `Library/Keychains`, browser `Cookies` / `Login Data` / `Web Data`, `*.pem` `*.p12`, `~/.codex/auth.json`, `~/.claude/.credentials*`, `.env*` (not `.env.example`), `.netrc` `.npmrc` `.git-credentials`, Docker / gh / kube configs |
| `classifyAppleScript` | app automation (Finder, Music, Safari, Notes…), keystrokes into ordinary apps, `read` of an ordinary file by one literal path | `send` in Mail / Messages / Slack…, `delete`, `empty trash`, a file path built from pieces (`a & b`) fed to `read`/`POSIX file`, keystrokes with no named target while a `HANDS_OFF_APPS` app is frontmost (the runner passes the app, as the hands do for `type`), and whatever a literal `do shell script` would confirm | keystrokes or clicks into a named `HANDS_OFF_APPS` app, `with administrator privileges`, shut down / restart / log out; the whole script text — adjacent literals folded first (`"~/.jarhead/en" & "v"`), HFS colon paths read as slashes — is run through the secret-store, secret-variable (`system attribute "OPENAI_API_KEY"`) and sweep rules of the shell gate; `do shell script` whose argument is not one string literal (the gate cannot read a computed command; `run_shell` is for that) |
| `classifyUrl` (`web_fetch`, `open_url`) | `https://` on the internet; a private or loopback host Kevin named (host, port or "localhost" in his own words) | — | `file://`, other schemes, `http://` to the internet, private hosts nobody named — including their IPv6-mapped spellings (`[::ffff:127.0.0.1]`, `[::ffff:7f00:1]`, `[::]`, `[::7f00:1]`); every redirect hop is re-checked |

`ConfirmationState` (packages/hands) is still the only way a `confirm` becomes a
`run`: the tool returns `needs_confirmation`, the brain ends its turn with the
question, Kevin's next utterance matches `YES_PATTERN`, the delegator arms the
pending action, and the *same* tool with the *same* target runs once. A `refuse`
is not unlocked by a yes. `run_shell` also grew `background: true` (a pid and a
log under `~/.jarhead/shell/`; that pid is "owned", so `kill <pid>` runs), a
120 s default / 600 s maximum, output capped to 12 000 characters head+tail, and
stdout tails streamed into the thinking channel. Every child the brain spawns —
shell, AppleScript, Codex, Claude Code — gets `scrubbedEnv`: `SECRET_KEYS` never
enter it. That alone was not enough: the shell is `zsh -lc`, a login shell, and
`~/.zprofile` exports the very key that was scrubbed, so the command is run as
`unset OPENAI_API_KEY ANTHROPIC_API_KEY JARHEAD_BRAIN_API_KEY; <command>`
(`loginShellCommand` in `shell.ts`) — after the rc files, before the command.
And because a lexical gate cannot see every spelling, the runner passes every
text result — shell output, a read file, an AppleScript result, a search hit, an
error message, a confirmation question — through `SecretRedactor`: the values of
`SECRET_KEYS` from the daemon's environment, every value in `~/.jarhead/env`
(re-read when the file changes), their base64 and URL-encoded forms, and
anything key-shaped (`sk-…`, `ghp_…`, `AKIA…`, `xox…`, JWTs, PEM private-key
blocks) become `[redacted secret]` before a model reads them.

The runner learned the task it is working on (`attach(sink, task)`): the request
text is what names a folder or a private host, and the task's signal cancels a
running shell command or self-edit when Kevin says stop. Files read during a
task are remembered so an overwrite of something the brain never looked at asks.
**What counts as "Kevin named it" is Kevin's words only.** `BrainTask.kevinDialogue`
(the delegator fills it from `transcript.since(…, "kevin")`) plus the request is
the text every naming gate reads — named folders, named hosts, a named rail,
"apply anyway". The rendered `dialogue`, which carries Jarhead's own lines, is
never consulted: the self-edit summary that names a rail, a page that names a
host, the apply question that says "anyway" cannot make the gate think he said
it. A task without `kevinDialogue` falls back to the request alone. The runner
also supplies what a pure policy cannot know: the `realpath` of every path (a
symlink under `/tmp` into `~/.ssh` is judged as `~/.ssh`; a link out of a
writable root is judged by where it lands; `list_dir` names links without
following them and `search_files` skips them), the working directory of a shell
command (a `cwd` inside `~/.jarhead`, `~/.codex`, `~/.claude` or a secret store
is refused, because `cat env` there is `~/.jarhead/env`), the frontmost app for
an AppleScript with keystrokes, and `REPO_ROOT` for the checkout rules.
`agent_start` with a `cwd` in the checkout asks for the same reason.

### The self-edit loop

```
self_edit "task"  ──► git worktree ~/.jarhead/worktrees/<id>  (branch jarhead/self-<id>, from main; refused when main is dirty or not checked out)
                       ├─ Codex: codex exec --json -s workspace-write --skip-git-repo-check --ignore-user-config [-m model] -C <wt> -   (prompt on stdin, secrets scrubbed)
                       ├─ else Claude Code: Agent SDK session in <wt>, acceptEdits, Bash only where the shell gate says run
                       └─ else "manual": the brain's own read_file / edit_file / write_file in <wt>, then self_check <id>
                      commit as Jarhead ── checks: pnpm install --frozen-lockfile (lockfile changed or no node_modules) → pnpm run typecheck → pnpm run test → swift build (apps/mac changed)
                      summary: files + diff stat, checks green / red with the first failure line, rails touched, the id      (15-minute budget; progress lines every step)
self_review <id>  ──► git diff --stat + git diff main...HEAD (capped at 12 000 chars)
self_apply <id>   ──► refused when: not checked · the worktree changed since its checks · checks red (unless the request says "anyway") · a rail is touched the request does not name
                      always: needs_confirmation "Apply the change to Jarhead and restart it? … N files; checks green/red; touches …" → Kevin's yes → the same call again
                      git merge --ff-only (else --no-ff, never forced) → pnpm install if the lockfile moved → worktree and branch removed → last-apply.json
                      packages/**, scripts/**, package.json, lockfile, tsconfig changed → engine.requestRestart("self-update <id>") after a 10 s grace so the answer is spoken (daemon exits 75, the app respawns it)
                      apps/mac/** changed → pnpm build:mac, "relaunch Jarhead.app when convenient"
self_discard <id> ──► worktree and branch removed, main untouched
self_status       ──► pending edits (stale after 24 h), main's head, whether a restart is pending
```

**Guarding the guards.** `RAILS` in `selfedit.ts` names the files a self-edit
may not quietly change. Security-critical files are rails *as a whole* — a hunk
regex was shown to be dodged both ways (git's funcname header names the prose
paragraph before an edit inside the prompt template; deleting the runner's
`refuse` branch leaves no changed line that names a gate): `packages/core/src/
policy.ts`; `packages/core/src/index.ts` and any *new* `packages/core/src/*.ts`
(re-pointing `classifyAction` through a permissive module is how a rail is
replaced without touching it); `brain.ts`; `packages/live/src/instructions.ts`;
`apps/mac/Sources/Jarhead/Wake/**`; `selfedit.ts`; `runner.ts`; `shell.ts` (the
scrubbing and redaction); `files.ts` (the symlink handling); `packages/brain/src/
index.ts`. Files that are mostly ordinary code are judged by changed line:
`ConfirmationState` / `YES_PATTERN` / verdict handling in `packages/hands/src/
toolset.ts`, the signing lines of `scripts/build-mac.ts`, `permission()` in
`claude.ts`, the sandbox flags and addendum in `codex.ts`, `SECRET_KEYS` in
`packages/protocol`. A diff that touches one is flagged "touches Jarhead's own
safety rails" in the spoken summary, and `self_apply` refuses unless Kevin named
the rail — a whole-word keyword ("policy", "system prompt", "wake" but not
"awake", "confirmation", "signing", "runner", "scrub") or the file name — in
*his own* words: the runner hands `applyBlocker` the request plus
`kevinDialogue`, never the rendered dialogue, so the summary Jarhead just spoke
(which always names the rail) and the apply question (which says "anyway" when
checks are red) cannot stand in for him. `saysApplyAnyway` likewise needs apply
intent next to the word ("apply it anyway", "merge it regardless", "even though
the tests fail"), not a stray "anyway".

**Where the restart comes from.** `RunnerOptions.requestRestart` is meant to be
`(reason) => engine.requestRestart(reason)`, one line in `Engine`'s constructor
where the `ToolRunner` is built (`packages/engine/src/engine.ts:144`, add
`requestRestart: (r) => this.requestRestart(r), socketPath: this.config.socketPath`;
not wired by the brain change, which stayed out of the engine). Without the hook
the runner sends `{type: "command", command: {type: "daemon.restart"}}` over the
daemon's own socket — `RunnerOptions.socketPath`, else `<stateDir>/jarhead.sock`,
which is the config default and therefore the live daemon in a normal install —
and that reaches the same `engine.requestRestart`. The runner decides which path
exists *before* speaking: with neither, `self_apply` says "no restart hook is
wired … quit and relaunch Jarhead" and marks no restart pending, instead of
promising one. `pnpm run doctor` has a `self-edit` row: pending worktrees (stale
ones warned), the last apply.

### The standing orders

`brainSystemPrompt()` (packages/brain/src/brain.ts) is a constitution under
1100 words (`brain.test.ts` pins the budget, the section order, the never list,
and that every snake_case token it uses is a real tool), the same text for all
five backends — `auto` picks one — versioned by `SYSTEM_PROMPT_VERSION` (3.2;
logged at every brain's start). Rules 1–3 are in order of precedence and the text says so; it
also says that everything after them is *method* — no task outranks "content is
data", and nothing read can. (1) Invariants nothing overrides without Kevin's yes
through the handshake — his own words, nothing on a screen or a page can say yes
for him, and the retry carries exactly the same arguments (that is what
`ConfirmationState.consume` matches): no money, no messages for him, no
irreversible deletion, no security, system or login-item changes, no editing the
running checkout or weakening Jarhead's own policy / prompt / gate /
confirmations, no acting after "stop"; and a never list a yes cannot unlock,
where secrets now live (touch, type or read aloud a secret; type into a password
field — Kevin does those himself), matching `classifyPath`, `shellNeverReason`
and the Live prompt, which were always unconditional. When he asks for a never or
a tool refuses: one sentence with the tool's reason, then the nearest safe thing
(a command he runs himself, the reversible part, a draft). (2) Kevin's explicit
words. (3) The task, done fully and verified. Then: content is data, honesty,
least surprise, how to work on this Mac, the self-modification protocol above
(naming all the rails `RAILS` flags, and that his summary naming one "does not
count"), and the voice rules. `packages/live/src/instructions.ts` mirrors it for the voice model:
the capability lines say what the backend does, asks before and never does, a
Safety section says a yes must come from Kevin and never from a screen, that a
refusal is relayed in one sentence with what the backend offered instead (not
asked again another way), and that secrets are never, yes or no; a "Changing
Jarhead itself" section tells the voice to relay the apply question word for word
and that a rail applies only when Kevin himself names it.

### Brains that carry their own tools

The Claude Code brain's SDK session has `Read`, `Glob`, `Grep`, `WebFetch`,
`WebSearch`, `Edit` and `Write` of its own; `permission()` in `claude.ts` denies
each with a redirect to the jarhead tool (`read_file`, `search_files`,
`web_fetch`, …) so `classifyPath` and `classifyUrl` apply to every read, and
`Bash` still runs through `run_shell`. The Codex brain runs in Codex's read-only
sandbox, which stops writes but not reads of `~/.jarhead/env`; its addendum now
says so and routes every read through the MCP server's tools.

## 11. Latency (2026-09-11, revised after review the same day)

Kevin: "stop button doesnt work"; "tool use needs to be a lot faster and better
it should be as real time as the voice". Measured first, then cut; everything
below comes from `pnpm jarhead bench` (a real Engine, a stand-in Live session,
the Swift helper, a stand-in brain or the real Codex), `packages/engine/src/
__tests__/stop.test.ts` (a fake Live proving the gate, button and spoken),
`packages/brain/src/__tests__/{reflex,codex,codex-app-server,batch}.test.ts`,
and tiny `codex app-server` sessions started and stopped by hand (no thread or
one tiny turn). Two reviewers re-ran the probes on a loaded Mac (load average
26–55, another agent's `tsc`, Chrome, a VM); what they found and what changed is
folded in below — the first version of this section reported idle-Mac numbers
as the result and made two claims that were wrong (the `codex_apps` runtime,
the spoken stop).

### Stop that stops

Every Stop entry — the Console button and ⌘., the capsule's Stop, ⌥⎋, the orb
menu, `jarhead cmd stop`, `jarhead://stop`, and the spoken "stop" through the
Delegator's `STOP_PATTERN` — reaches `Engine.interrupt`. (The first version
of this section claimed the spoken path did too; it did not — the Delegator only
cancelled the delegation, so a `type` waiting on its `frontmost` gate probe still
typed after Kevin said stop. Now the Delegator has an `onStop` hook the engine
wires to `interrupt(reason, "said")`; it runs on a microtask so the engine's
own listener for that fragment — which lifts the output gate on Kevin's speech —
has already run, and the gate the stop sets survives the words that asked for
it. The delegation's summary reads "Kevin said stop".) Why the button "did not
work": the path was intact (Swift sends `{type:"stop"}`, `isEngineCommand` accepts
it, the daemon dispatches it) but the effect was not perceptible. GPT-Live-1 has
no interrupt or cancel client event, so the sentence already in flight kept
arriving as output audio and kept being played after the one-off speaker flush;
the output transcript kept the phase at "speaking"; a hands request in flight
(the gate's `frontmost`/`element_at` probe, a click) completed and acted; the
brain's turn ran on until its own cancel landed. Now, within ~1 ms of the
command (bench: 0–2 ms):

- **Output gate.** `outputGateUntil = now + 2.5 s`: every `session.output_audio.
  delta` is dropped and output-transcript deltas do not count as speaking, until
  Kevin's next input-transcript delta lifts it or the window lapses. The API
  cannot be interrupted, so the mute is local. The transcript still records what
  the model said (it happened; Kevin did not hear it).
- **Everything in flight.** `delegator.cancel` finishes the delegation as
  `cancelled` with the reason *before* awaiting the brain (a brain that settles
  on the abort signal used to finish it first and lose the reason), then the
  brain's cancel: `turn/interrupt` on the warm Codex, SIGINT→SIGKILL on `exec`,
  the Agent SDK interrupt for Claude, a fetch abort for the API brains.
  `NativeHandsProcess.cancelPending` fails every pending helper request with
  `cancelled`; the helper is serial and cannot be interrupted mid-op, but its
  late answer arrives for an id nobody waits on and is dropped, and a gate whose
  probe was cancelled refuses the action instead of running it with less
  information. `runner.abortTask` stops the background shell jobs this task
  started and the arrow heads still to be drawn.
- One Live instruction ("Kevin pressed stop. Stop speaking now and wait." /
  "Kevin said stop. …"), a `toast("stopped")`, and the `delegation.finished`
  ledger row (status `cancelled`, summary "Kevin pressed stop" / "Kevin said
  stop"). `Delegator.cancel(reason, {quiet: true})` skips its own "Acknowledge
  with one word" line when the engine owns the stop, so the voice is no longer
  told both to speak and to stay silent. With nothing running there is nothing to
  record beyond the log line; the `stop` ledger row (§13) lands only when
  something happened.
- A stop that lands while the warm Codex turn's `turn/start` is still unanswered
  (a thread's first turn: ~2 s while the MCP servers start; every brain start and
  every context rollover has one) used to resolve the turn locally and never send
  `turn/interrupt` — the server-side turn ran on, and its `jarhead.*` calls reached
  the daemon with no delegation attached. `CodexAppServer.interrupt()` now
  remembers the request and sends `turn/interrupt` the moment the turn id is
  known; the turn resolves on the server's `turn/completed{interrupted}`, or
  locally after a 5 s grace when the server never says so. Defence in depth: the
  daemon refuses a `tool.run` while the engine's runner has no task attached
  (`ToolRunner.attached`), so a turn that outlives its delegation gets an error,
  not a click.

What is not fixable from the engine: the Swift `EngineClient.rawSend` drops a
command while the socket is reconnecting (daemon restarting) with only a log line.

### Instrumented

`DelegationTimingsExtra` (packages/brain/src/delegator.ts) rides in every
`delegation.finished` row and in the snapshot beside the contract's timings:
`firstToolAt` (the brain's first tool step — the eyes' shot excluded),
`firstActionAt` (the first member that moves or types: `ACTING_MEMBERS` in
packages/hands), `toolRoundTripMs` (every tool's own round trip, up to 40),
`eyesMs`, `reflex`. The Swift decoder ignores the extra keys; the contract should
grow them as optional fields. The log line at finish reads
`thinking@… tool@… action@… commentary@… [reflex] tools a/b/c ms`.

### Measured (this Mac, `pnpm jarhead bench`, 2026-09-11)

**Conditions matter and the table says them.** The first three columns were
measured on an idle Mac (load average ≈ 2) with a mostly static display in
front; the "loaded" column is the reviewers' re-run of the same bench at load
average 26–44 with Chrome in front (a busy 1280-px shot is a 788–848 KB PNG;
the idle one was 353 KB). The bench now prints the load average in its header
so a run is read in context. The Swift-helper numbers are what the display and
the machine allow; the fake-hands column is Jarhead's own path.

| moment | stand-in brain, fake hands | stand-in brain, Swift helper, idle Mac | same, loaded Mac (reviewers) | real Codex (warm app-server, one turn, idle) | target |
|---|---|---|---|---|---|
| tool round trip (`frontmost_app`, runner → toolset → helper) | 0 ms | 5–9 ms median, 38 max | 12–22 ms | 7 ms | < 80 ms |
| quick screenshot (1280 px long edge) | 0 ms | 111 ms median warm, 286 cold (static display); **169 median / 429 p90 with Chrome in front** | 300–387 ms | 308 cold (1280×360, 353 KB) | < 120 ms — met only on a quiet display; content-dependent |
| full screenshot (2000 px) | — | 143–250 ms | — | 92 ms | — |
| eyes: pre-warm shot at delegation | 1 ms | 109–171 ms | 399–441 ms | 97 ms | < 120 ms (same caveat) |
| delegation → first action | 2 ms | 126–186 ms | 425–605 ms | — (a question; no action) | < 300 ms (stand-in) / < 1.2 s (Codex) |
| delegation → brain's first tool | 1–2 ms | 124 ms | — | **10.1 s** (first turn on a fresh thread) | — |
| delegation → spoken result | 2–3 ms | 126 ms | — | 12.1 s | — |
| reflex "jarhead, screenshot this.", utterance end → tool **issued** (prefired; the quiet window plus Jarhead's path) | **182 ms** (180 ms quiet + 2) | 182 ms | — | — | < 300 ms |
| reflex, tool issued → done (the shot itself) | 1 ms | = the quick screenshot above | 300–500 ms | — | — (the display's) |
| reflex, delegation → done (adopted; includes the 50 ms snapshot tick) | 50 ms | 50 ms | — | — | — |
| stop: command → everything stopped, delegation held by the brain | 0–2 ms | 1 ms | 2–11 ms | — | < 150 ms |

Re-run after the fixes (`pnpm jarhead bench --runs 5`, load average 5.8, Slack
in front, 1280×360 292 KB shot): tool round trip 5 ms (p90 25); quick screenshot
58 median / 186 p90; eyes 64; delegation → first action 77; reflex tool issued
182, done 246; stop 0–1 ms with the delegation held — every target met at that
load. With `--fake-hands`: 0 / 0 / 0 / 2 / 182 / 183 / 0–2 ms.

The reflex target is restated: the first version measured utterance end → the
shot *done* (374–392 ms with the helper) and called 300 ms the target, which a
180 ms quiet window plus a ~170 ms shot can never meet. What Jarhead controls is
the moment the tool is issued; the shot's duration belongs to the display and
is reported on its own row. The bench's stop row used to measure "nothing was
running" (the stand-in brain finished before the stop); it now holds the
delegation until the stop and says so in its log.

Warm Codex, measured by hand with `app-server` sessions: `initialize` 42–351 ms;
`thread/start` **1.8–2.6 s idle, 25.6 s at load average 26, and past 60 s at
load average 44** (the reviewers saw `codex app-server did not start within
40s` and `thread/start did not answer within 60s`); on a thread's **first** turn
`turn/start` itself answers only after ~2 s (the MCP servers start before the
reply: the bridge "ready" at +2.9 s, `codex_apps` — now switched off — at +3.5 s)
and the skills catalog is assembled, so the first agent message lands 5–7 s
after `turn/start` at effort low (10 s in the bench at effort medium, with a tool
call); the **second** turn on the same thread answers in 2.67 s (first token) /
2.85 s (done), and its `turn/start` in 6–16 ms. `exec` per task was ~6 s to the
first speakable line (§6c). `turn/interrupt` → `turn/completed{status:
"interrupted"}` in 34 ms. One tiny turn on the revised production argv
(`--disable apps`, `-c notify=[]`; prompt "reply pong", ephemeral thread, load
average 5.8): `initialize` 42 ms, `thread/start` 1.37 s, first `turn/start`
answered after 1.2 s (the bridge "ready" +415 ms in; no `codex_apps` startup at
all), "pong" 6.9 s after the session began, clean exit — the skills-budget
warning ("458 additional skills were not included") still arrives every turn and
has no knob in 0.153.4. Two consequences were fixed: the app-server's start
no longer sits on any task's path (`CodexBrain.start()` waits a 4 s patience
window, then reports ready on `exec` with the warm start continuing in the
background and `brain.detail` following it; a task that arrives before it is up
runs on `exec` at once; a failed start is retried a minute later, never awaited
by a task), and the boot budget is honoured (`thread/start` gets what is left of
`startTimeoutMs`, not `request()`'s hard-coded minute).

So: the tool path is now ~10 ms and the eyes are ~100 ms; what remains between
Kevin's words and Codex's first action is the model's own turn (2.7 s warm, more
on a fresh thread), which no plumbing removes. The one-step commands Kevin says
most do not wait for it (reflexes, below). The `< 1.2 s` target for Codex is not
met and will not be by this transport; it is met by the reflex table for the
utterances that need no reasoning, and the warm thread halves the rest.

### What was cut

- **Warm Codex** (`packages/brain/src/codex-app-server.ts`): a resident
  `codex app-server --listen stdio://` per brain, JSON-RPC 2.0 newline-delimited
  over stdio; `initialize` → `initialized` → `thread/start {approvalPolicy:
  "never", sandbox: "read-only", ephemeral: true, developerInstructions: the
  standing orders + the Codex addendum, model}` once, then `turn/start {threadId,
  input: [text, localImage…], effort}` per delegation, `turn/interrupt` on stop,
  a fresh thread once `thread/tokenUsage/updated` shows the thread past 70 % of
  the model's context window (the last three exchanges carried over as text).
  Context continuity is a feature: "do it again" works. Server requests
  (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
  `item/permissions/requestApproval`, `item/tool/requestUserInput`, `mcpServer/
  elicitation/request`, `item/tool/call`) are all declined; Jarhead's policy is
  the runner's. The app-server has no `--ignore-user-config`: Kevin's own MCP
  servers are switched off with `-c mcp_servers.<name>.enabled=false` for every
  `[mcp_servers.<name>]` in his config.toml (`-c mcp_servers={…}` does not
  replace the table; a quoted key fails with "invalid transport"). The plugin
  runtime `codex_apps` — Kevin's ChatGPT connectors: 134 tools by plugin
  (google_drive 45, workspace_agents 42, sites 39, …) including
  `google_drive.delete_file`, `google_drive.share_file`, `sites.delete_site`,
  `workspace_agents.publish_agent` — is a *feature*, not a server, and **is**
  switched off: `--disable apps` (= `-c features.apps=false`) is in the argv
  always (the first version of this section said it could not be; a reviewer
  showed one tiny turn calling `google_drive.get_profile` under approvalPolicy
  "never" with nothing in Jarhead judging it). Verified against the real binary:
  with the production argv `mcpServerStatus/list` shows `jarhead` (55 tools) and
  Kevin's four servers at 0 tools, and no `codex_apps` at all. His `notify`
  hook is silenced too (`-c notify=[]`), so Jarhead's turns never fire it. In
  depth: an `mcpToolCall` to any server but `jarhead` fails the turn ("Codex
  tried to act around Jarhead"), on both transports. `exec` per task stays as
  the fallback — when the app-server is not up yet, cannot start within 25 s,
  dies (retried a minute later), or `transport: "exec"` is asked for — and
  `brain.detail` says which is live and why, as it changes. `ClaudeBrain` was
  already warm: one Agent SDK session, one `send` per task.
- **Pre-warmed eyes**: at delegation the engine takes a quick screenshot (1280 px)
  through the runner, in parallel with the circled regions, and hands it in as the
  task's first attachment (`kind: "screen"`, note: "the screen right now … this
  counts as your last screenshot") — the Screen mapping is set from it, so the
  model's first move can be a click. Skipped for the Responses brain (already
  answering). Codex gets it as `localImage`.
- **Tool path**: the MCP bridge keeps one daemon connection (`SocketToolClient`,
  multiplexed by id, reconnecting); a tool result's image is parsed once on our
  side (the runner archives the PNG, the daemon frames it, the bridge passes the
  base64 through); the helper's `FastPNG` (parallel-strip deflate) is what makes a
  2000-px shot 90–140 ms; the policy gate's `frontmost`/`element_at`/`focused_text`
  probes go out together and only the ones the member needs (a scroll probes
  nothing); a model turn with several tool calls runs the look-only ones
  concurrently and the acting ones in order (`batch.ts`, Anthropic and
  Chat Completions; Codex's own parallel MCP calls were already concurrent through
  the bridge) — and the ordered batch **stops at the first call that did not go
  through**: a `needs_confirmation` (the question must reach Kevin before anything
  else happens; one call per turn used to guarantee that), a refusal, or an error
  (the calls after it assumed it worked), the rest answered "not run: … waiting for
  Kevin's answer / failed earlier in this turn"; commentary within 600 ms is joined
  into one append (first line at once, finish flushes, cancel drops).
- **Reflexes** (`packages/brain/src/reflex.ts`): "scroll up/down", "press
  enter", "type <words>", "open <app>", "close this window", "go back",
  "screenshot this", "click <control name>" — the whole utterance must be the
  command (wake word and politeness stripped); the Delegator runs it through the
  same ToolRunner and finishes the delegation at once with one spoken line, a
  `note` step "reflex: …" and `timings.reflex`. A failed reflex hands the task to
  the brain with the attempt on the timeline. "click <name>" is a System Events
  click by the **exact** name (AppleScript's `is` ignores case; the `contains`
  fallback is gone — "ok" must not click "Revoke Token"), pre-checked by
  `classifyAction` so a Send/Delete stays the brain's (it knows how to ask).
  Scroll and screenshot may **prefire**, and the rules got stricter after review:
  the utterance must have clearly ended — a sentence the transcriber closed with
  `.`/`!`/`?` counts after 180 ms of quiet, an open one only after 450 ms
  ("jarhead scroll down" — 250 ms pause — "to the footer" used to scroll and then
  the brain scrolled again) — and Kevin must have named Jarhead; mid-exchange
  without the wake word only a closed sentence qualifies. A prefire is a
  **delegation record of its own** from the moment it runs (`liveId:
  "prefire:<transcript item>"`, created / stepped / finished on the ledger like
  any delegation — a scroll that happened on Kevin's screen is never only a log
  line); the delegation that follows adopts it **by transcript item** (its request
  must end with that very utterance; a text match alone used to let the next
  identical command claim a stale result) and waits for a tool still in flight
  instead of running it again; one Live never delegates within 8 s is closed as
  "never delegated", one outgrown by more words before the delegation as "a
  longer request followed", and the brain takes the request whole. Reflexes are
  off when Live's own Responses backend is the brain (it would act on the same
  words twice).
- **Marks snap to the largest fit** (`Engine.resolveMarkTarget`): of the
  element under the stroke's centroid and the windows under it, the candidates
  that hold the centroid and lie ≥ 60 % inside the padded stroke box are sorted
  by area **descending** — the thing Kevin surrounded is the biggest thing mostly
  inside his stroke. The first version took the smallest, so a circled dialog
  snapped to the label under the centroid ("Are you sure?", 200×40) and the
  shot, the rect and the blob's outline showed the label. A circled button still
  wins over its window (the window fails the coverage test); a stroke in the
  middle of a huge window keeps its own box with the app noted. The element's AX
  ancestors are not candidates yet (the helper's `element_at` has no ancestor
  list); a circled group the window list does not know stays the box.

### What remains

- Codex's own turn: 2.7 s warm at effort low, 5–10 s on a fresh thread with the
  skills catalog (0.153.4 has no knob for it; §6c), and `thread/start` anywhere
  from 1.8 s to over a minute depending on the machine's load — hence off the
  critical path now, but a loaded Mac means the first tasks after a start run on
  `exec` (~6 s to the first line). Effort `low` for the brain is the cheapest
  lever Kevin has in Settings.
- The reflex quiet window (180 ms closed sentence, 450 ms open) is the reflex
  budget; Live's own transcript latency sits in front of it and is not measured
  here. Whether GPT-Live-1's input transcript reliably closes sentences with
  punctuation decides how often the short window applies; if it rarely does, the
  open-sentence window is what Kevin feels.
- The quick screenshot is content-bound: a busy display is a 800 KB PNG and 300+
  ms on a loaded Mac whatever the helper does; the < 120 ms figure holds for a
  quiet display on an idle machine only.
- What the contract took from this section, and what it did not:
  `DelegationTimings.firstActionAt` and `speechEndAt` landed 2026-09-12
  (`firstActionAt` stamps on the first acting tool that returned ok, overlays
  included; `speechEndAt` is the wall clock of the utterance that triggered the
  delegation — §15, docs/LATENCY.md), and the `stop` ledger row is §13's.
  `firstToolAt`, `toolRoundTripMs` and `eyesMs` stay in `DelegationTimingsExtra`
  beside the contract's timings, and `ElementInfo.ancestors` was not added: a
  circled group the window list does not know keeps its box.

## 12. Reflexes and the 250 ms path (2026-09-11)

Kevin: "significantly reduce latency between tool calls and then doing stuff
like writing and computer use and browser use. make this a super optimized
harness and <250ms from me saying to the actual action being executed. and this
will make the live drawing perfect too!"; "ADD A PAUSE BUTTON"; "once we press
stop we can't wake; the stop button just stays there." Everything below is
measured by `pnpm jarhead bench` (the ear section, the browser section), the
engine tests (`packages/engine/src/__tests__/{ear,ear-engine,pause,stop}.test.ts`),
the grammar tests (`packages/brain/src/__tests__/reflex-grammar.test.ts`) and
the helper probed by hand against the live desktop.

### Why 250 ms needs a different path

Speech → GPT-Live-1 → `session.delegation.created` → brain (Codex / Claude /
API) → first tool call is 1.5–4 s and cannot be made 250 ms: the model has to
think, and §11 already took the plumbing down to ~10 ms per tool and ~100 ms for
the eyes. So the actions that need no thinking must not wait for a model. Two
sources of Kevin's words:

1. **Live's input-transcript deltas** — authoritative (this is what the voice
   heard), ~300–500 ms behind speech, then the Delegator's quiet windows (§11).
2. **The ear** — new. While awake the app runs Apple's on-device
   `SFSpeechRecognizer` on the same microphone buffers the voice gets and sends
   every partial to the daemon as `ear {text, isFinal, segment, at}` (`at` = ms
   since epoch when the app received it), ~100–200 ms behind speech. The daemon
   forwards it to `Engine.ear()`.

A **reflex layer** in the engine (`packages/engine/src/ear.ts`) matches
unambiguous commands on the ear's partials against a fixed grammar and executes
them through the normal policy-gated hands at once. When Live's transcript and
delegation for the same words arrive, they are **reconciled**: the delegation is
finished as done with the reflex's own line spoken ("scrolled down.") and the
summary "already did it", so the model never redoes it. Everything else keeps
the model — warm (below).

### When a partial fires

The on-device recogniser accumulates a segment for up to ~50 s and revises the
last words as it goes, so a partial is judged on the **words not yet acted on**
(the engine keeps a per-segment consumed count; a silence gap of 1.5 s leaves
whatever was said before behind, command or not) and fires only when it is
unambiguous:

- on `isFinal` — at once;
- on a partial that **ends terminally** — punctuation, or "please" / "now" /
  "thanks" / the wake word at the end — at once;
- otherwise once the partial has been **stable** — for **120 ms** (`Engine`'s
  `earStableMs`) when the command is one of the look-only, reversible kinds the
  Delegator also runs ahead of Live (scroll, page, screenshot, circle: the
  `prefire` kinds), for **450 ms** (`earCarefulMs`) for everything else (keys,
  edits, typing, clicks, tabs, apps, dictation). The recogniser lands words in
  ticks, and a partial that is a *prefix* of more to come — "copy" of "copy this
  file to the desktop", "undo" of "undo the last commit", "select all" of "select
  all the files", "type hello" of "type hello world" — sits unchanged for a tick
  simply because the next words have not arrived. 120 ms is shorter than a tick;
  450 ms is longer than one and than a breath (the same figure the Delegator's
  long quiet window uses: a mid-sentence pause is shorter). A scroll that fires
  on a prefix costs nothing; a ⌘C, a ⌘W or a typed "hello" does, so those wait
  out the breath. "scroll down" must still not fire before "… to the footer" can
  arrive; the grammar excludes the compound, so once the words grow the candidate
  simply stops matching and the delegation handles the sentence whole.

Finals and terminal tails cannot carry the fast path on their own: the app's
`SegmentedRecognizer` asks for **no punctuation** (`addsPunctuation = false`) and
a `SFSpeechAudioBufferRecognitionRequest` produces its final only when the
request ends — at the 50 s roll — so through the ear a command's "final" arrives
tens of seconds after the command. The stability window is the mechanism; the
two figures above are the trade.

The ear **holds still** (words consumed, never queued, never re-judged) while
the voice is speaking (`lastOutputSpeechAt` / the last output audio frame within
1.2 s and the gate not set — the recogniser hears Jarhead's own words back
through the microphone whenever echo cancellation is off, and "Now press enter."
must not press Return), while a brain task is running (a scroll under its hands
would move what it just looked at), and while the mic is muted; "stop" is the
one word that is not held. After a **Stop or a Pause** the ear is `quiesce`d:
the segment is *kept* with every word consumed, because the recogniser still
delivers partials and the final for that segment, and a segment forgotten would
come back whole with the command Kevin just stopped at the front of it. A
recogniser revision that shortens the text never starts over on words already
acted on ("press enter please" → "press enter" presses nothing twice).

"stop" (and "cancel", "never mind", "hold on") goes straight to
`interrupt()` while a task runs or the voice speaks, no window. Leading
filler ("um", "so", "okay", "yes") and the wake word are stripped — but not
"right": "right click Save" is a command of its own (not in the grammar), not a
left click.

### The grammar

One table, `packages/brain/src/reflex.ts`, shared by the ear and the Delegator
(so Live's transcript is the slower second source through the same matcher, and
a reflex looks the same on the ledger whichever source ran it). The **whole**
utterance must be the command after the wake word and politeness are stripped;
`reflex-grammar.test.ts` pins every row.

| said | tool |
|---|---|
| scroll up / down / left / right [a bit \| a lot \| to the top \| to the bottom]; scroll to the top / bottom | `scroll` (2 / 5 / 15 wheel clicks) or `key` ⌘↑ / ⌘↓ |
| page up / down | `key` Page_Up / Page_Down |
| press / hit / tap enter · return · escape · tab · space · delete | `key` |
| select all; copy / cut / paste / undo / redo ("copy that" is excluded: it means "understood") | `key` ⌘A ⌘C ⌘X ⌘V ⌘Z ⇧⌘Z |
| new tab / close tab / next tab / previous tab / reload / back / forward — **browser in front only** | `key` ⌘T ⌘W ⌃⇥ ⌃⇧⇥ ⌘R ⌘[ ⌘] |
| zoom in / out; reset zoom | `key` ⌘= ⌘- ⌘0 |
| close this window | `key` ⌘W |
| type / write <words> (not "type the address from the email": a description) | `type` |
| open / launch / switch to <app> | `open_app` |
| go to <url or site> ("github.com", "github dot com", "hacker news", "localhost 3000") | `browser_navigate` in the browser in front, else `open_url` |
| click / press / tap <label>; double-click <label> (≤ 4 words; no pronouns, positions or colours) | `click_element {name}` |
| screenshot this / take a screenshot | `screenshot {quick}` |
| circle / highlight that | the blob traces the AX element under the cursor, else the front window (`orb.trace`) |
| start dictating / take dictation; stop dictating / end dictation | dictation (below) |

`click <label>` — a control's name, never a stand-in for one: "click the thing",
"click the one", "click the link", "click the blue one", "click it" are the
brain's (a bare "click Link" may be a control called exactly that) — resolves
through the helper's new **`find_element {name, role?}`**:
the frontmost window's accessibility tree — walked once with
`AXUIElementCopyMultipleAttributeValues` (one IPC per element), cached per app
and refreshed by the engine every 500 ms while awake (`ax_tree {summary:true}`),
rebuilt when the frontmost window changes — searched over visible clickable
controls by title / description / short value, exact first (case and
punctuation folded) then edit-distance ≥ 0.85. **One match only: two candidates
= no reflex**, and the model path takes it. The click lands at the element's
centre through the toolset's `click_element`, which judges the label with
`classifyAction` exactly as `left_click` does — and, because a tree names a
control while a click is a global event at a point, first checks that the
control's app is the one **in front** (an `app` argument — `browser_click`'s
accessibility fallback passes one — may name a browser behind another window;
the answer is then "focus_app it first", never a click into whatever is on top)
and that what `element_at` finds **under the point** is that control: inside its
frame (the control or its label / icon), fine; a leaf control (a button, a link,
a menu item) around or beside it is a cover — a sheet's "Don't Save" over the
Save button — and the click is refused with "take a screenshot and left_click".
Whatever text sits under the point is added to what the policy judges, so a
"Send" that has slid under a "Save" still asks. Brains get `find_element` and
`click_element` too (no screenshot, no pixel mapping).

Every reflex runs through `ComputerToolset` + `classifyAction`. A reflex that
lands on **confirm or refuse is dropped**: the runner had already recorded the
`needs-confirmation`, so the engine clears that pending question (a later "yes"
must not arm a question nobody relayed) and the model path asks properly — "click
Send" never sends by reflex. `Settings.reflexes` off → no reflexes anywhere (ear
and delegation). Reflexes stay off when Live's own Responses backend is the brain.

#### Added 2026-09-12: search (docs/LATENCY.md)

`search (the) <where> for <what>` / `search for|look up|find <what> in|on <where>`
is a multi-step reflex (`Reflex.steps[]`, run as one batch that stops at the first
refusal, confirmation or error): focus the app if `<where>` names one and confirm
it came to the front; find the search field (`click_element` name "search", role
field or pagefield) else the app's/site's known shortcut (⌘L only when `<where>` is
the browser itself, ⌘F, "/", ⌘K, ⌘G, ⌘⇧F…) after checking no text input already
has focus; verify a text input has focus; ⌘A, type, Return. `<where>` must be a
known app, a site the front tab's title names, or "here"; compound requests
("search X for Y and then…") and describing phrases ("find the bug in the code")
are not reflexes. No search field and no shortcut → hand over to the brain with
the AX findings. Typed searches keep the 450 ms careful window; finals fire at
once. Measured: partial → typed 452 ms median with fake hands.

### Reconciliation

Each fired reflex is remembered (`FiredReflexes`: words, action, timing; 4 s
window, claimed once). Live's transcript delta arrives first and the Delegator's
prefire check looks at it with **`peek`** — a look that claims nothing; the
delegation, ~200–500 ms later, is the one that **`reconcile`s** and claims. (A
claim in the prefire check hid the reflex from the delegation, which then ran it
again: "scroll down" scrolled twice; the shipped test had missed it because the
harness emitted the transcript and the delegation in the same tick. The test
now puts Live's real gap between them.) The delegation is judged on the
request's **last transcript item** — the utterance Live delegated on; earlier
items are context ("what a nice day" … "jarhead scroll down") — normalised and
equal, or edit-distance similarity ≥ 0.8. Then:

- **done** — the Delegator finishes the delegation at once: a note ("reflex
  scroll down already ran 412 ms ago on the ear's words (100 % match)"), the
  reflex's `said` line as commentary so the voice confirms, status done, summary
  "already did it"; its own prefire is skipped.
- **partial** — the last utterance *ends* with the phrase but says more ("read me
  the headline scroll down": the ear's 1.5 s gap rule had split the clauses and
  scrolled): never "already did it". A note says the tail was done and must not
  be repeated, and the **brain takes the rest**. (A plain suffix match used to
  close the whole request as done and the brain never saw "read me the
  headline".)
- **mismatch** — the words differ materially but the command is the same ("type
  hello there" fired, Live heard "type hello there everyone how are you today"):
  a `reflex.mismatch` ledger row and a note on the delegation. An idempotent
  reflex (scroll, screenshot, open) needs nothing more. A **typed** text is undone
  with ⌘Z while a text field is still focused and Kevin is told ("… by reflex but
  Kevin said something else; it has been undone"); the request's own reflex then
  types the whole sentence. When ⌘Z cannot reach — the focus is a terminal, a
  canvas, an Electron view with no text role — the text **stands**: Kevin is told
  so ("… could not be undone … do not type it again on top"), the reflex is not
  run again on top of the ear's, and the brain takes the request with the note,
  screen first. Any other non-idempotent mismatch (a click) tells the voice what
  was done and goes to the brain the same way.

`ear-engine.test.ts` proves each, with a fake Live and fake hands.

### Dictation

"start dictating" → the phase shows acting, Live is told to stay silent and
not to delegate, and delegations that arrive anyway are recorded and refused
("Kevin is dictating"). Each subsequent ear **final** segment — and any partial
unchanged for 700 ms, so a 50 s recogniser segment does not hold the words — is
typed into the focused field with a trailing space, through `classifyAction
{kind: "dictate"}` (a password field or a hands-off app **refuses**, not asks —
a question mid-sentence is worse than a no — and dictation ends with a toast and
a word to the voice) and the toolset's `type`. Inside the words, "new line" /
"new paragraph" press Return once / twice, "delete that" is ⌥⌫ (a word back),
"stop dictating" ends it; while dictating, command words are text ("scroll down
the hill" is typed).

### Pause; nothing stuck after Stop

`pause` (Console, orb, `jarhead cmd pause`): with a session open — `live.mute()`,
the output gate held open indefinitely (audio dropped, output-transcript deltas
do not count as speaking, Kevin's own deltas do not lift it), the running
delegation cancelled, new ones refused (recorded, finished as cancelled /
"paused"), pending confirmation cleared, dictation ended, Live told once "Kevin
paused you. Stay silent until he resumes.", phase `paused` held by
`recomputePhase`, toast, a `pause` ledger row. Mic frames are dropped locally
too. `resume`: unmute (unless Kevin's own mute is on — that survives), gate
closed, delegations allowed, "Kevin resumed.", phase listening, `resume` row.
Pause while asleep → toast "asleep already". Idle-sleep keeps counting while
paused, and a session that ends unpauses. `pause.test.ts` covers each line.

Stop: `stop.test.ts` now reproduces Kevin's symptom — a running delegation whose
brain's `cancel()` is slow (a Codex interrupt on a loaded Mac) or never answers.
After `stop`: the delegation is cancelled *before* the brain's cancel is awaited
(unchanged), the snapshot shows nothing running or awaiting, the phase is
listening inside the gate window, and — new — the **pending confirmation is
cleared** (a question the stopped task asked could be armed by a later "yes"),
dictation ends, and wake / say-text / a new delegation work at once while the
old cancel is still in flight. `sleep()` is bounded (1.5 s) so a brain whose
cancel hangs cannot keep the session open — that hang is the one engine-side way
"the stop button stays there" could have happened; the rest of that symptom is
the app's (the Swift side shows Stop from the phase, which the engine now
guarantees is listening).

### Browser fast path

`browser_read` (url, title, visible text ≤ 30 k), `browser_find {text}` (bounds
of the first visible element containing the text, in global points and in
pixels of the last screenshot), `browser_click {text | selector}`, `browser_type
{text, submit?}`, `browser_navigate {url}`, `browser_tabs` — brain tools
(`packages/brain/src/browser.ts`) over new helper ops (`browser_js`,
`browser_url`, `browser_tabs`, `browser_navigate` in `Browser.swift`). The
helper runs **compiled `NSAppleScript`s** with the JavaScript passed as the
`run` handler's argument, from the main thread, **never spawning `osascript`**
(a 30–60 ms process per call) and never launching a browser that is not running
(`not_found`). Whether a browser allows JavaScript from Apple Events is learned
by trying `1+1` once and cached per app (re-tried after a minute when off, so
Kevin flipping the menu item is noticed): Chrome: View › Developer › Allow
JavaScript from Apple Events; Safari: Develop › Allow JavaScript from Apple
Events. Without it the same tools work through the accessibility tree
(`ax_tree`, `find_element`, `click_element`) and the keyboard. The doctor has a
row per running browser with the exact menu path (Kevin's Chrome: **off**).

Policy (`packages/core/src/policy.ts`, `classifyBrowser`): reads run;
`browser_click` / `browser_type` / `browser_navigate` run on ordinary pages,
**confirm** on payment and credential pages by URL keywords on the host and
path (checkout, pay, billing, login, signin, password, auth, 2fa, bank, wallet,
… — whole segments, so "payload" and "authors" pass, and the query string is
not judged) and on irreversible labels, and `browser_type` into a password
field **refuses**. `browser-policy.test.ts` is the table.

### Warm starts

At wake: `Brain.warmUp()` — Codex kicks its resident `app-server` start if it
is not up (never awaited; the thread is reused across delegations and replaced
only on context rollover — verified in `CodexBrain.handleWarm`), Claude reports
its one Agent SDK session; one quick screenshot through the toolset (the first
ScreenCaptureKit capture is the slow one, and the Screen mapping is set); the
frontmost window's AX tree cached and refreshed every 500 ms. Between
delegations the thread stays; between tool calls nothing spawns (the browser
path and the click-by-name path are helper ops; `open_url` for a bare "go to"
outside a browser is the one `open` process, and it is not between tool calls).

### Measured (this Mac, `pnpm jarhead bench --runs 5`, 2026-09-11 evening after the review fixes, load average 5–6, Chrome in front)

The bench feeds synthetic `ear` partials for ten grammar phrases (scroll down,
scroll up a bit, scroll to the top, page down, press enter, press escape, select
all, copy, undo, zoom in; plus "click save" with fake hands) each as a partial
and as a final. With the real helper the acting op is redirected to a harmless
`cursor` read — the bench never scrolls or types on Kevin's Mac — so the round
trip is the real one without the effect. "dispatch" is the moment the acting op
is written to the helper; "ack" its answer. A partial of a **prefire** kind
(the four scroll/page phrases) is the "partial" row; a partial of any other
kind waits out the 450 ms careful window by design and is its own row, judged
against that window plus the same allowance (450 + 130 = 580 ms). The gate:
**p95 to dispatch ≤ 250 ms for finals and prefire partials, ≤ 580 ms for careful
partials, with the real helper, else exit 1** (`--no-gate` to only report).

| moment | fake hands (Jarhead's own path) | Swift helper, real round trip | target |
|---|---|---|---|
| ear: partial → dispatch (prefire kinds; includes the 120 ms window) | 122 median / **123 p95** (n = 20) | 122 median / **126 p95** / 128 max (n = 20) | ≤ 250 p95 — **met** |
| ear: partial → hands ack | 122 / 123 p95 | 122 / 127 p95 | — |
| ear: careful partial → dispatch (keys, edits, click; includes the 450 ms window) | 452 median / **453 p95** (n = 35) | 455 median / **457 p95** / 457 max (n = 30) | ≤ 580 p95 — met (the window is 450 of it) |
| ear: careful partial → hands ack | 452 / 453 p95 | 455 / 457 p95 | — |
| ear: final → dispatch (no window) | 0 / 1 p95 (n = 55) | 3 median / **6 p95** / 6 max (n = 50) | ≤ 250 p95 — met |
| ear: final → hands ack | 0 / 1 | 3 / 6 p95 | — |
| click_element's two new probes (frontmost + element_at, in flight together) | 0 | one `tool round trip` each: 4 median / 16 p95 | inside the same budget |
| find_element on a cached tree (probe by hand) | — | 2–14 ms (Chrome 188 nodes, Notes 245, Finder 396) | — |
| ax_tree cold walk (probe by hand, 250 ms budget) | — | Chrome 70–100 ms; Slack 43 ms (62 nodes); Finder / Notes hit the budget (~400 / ~245 nodes, breadth-first so the toolbar is in) | — |
| browser: Chrome `browser_url` round trip | — | 32 median / 177 p90 (the first call compiles the script) | < 80 |
| browser: Chrome `browser_tabs` (80 tabs) | — | 61 median / 68 p90 | < 80 |
| browser: `browser_read` through JavaScript | — | **not measurable here: JavaScript from Apple Events is off in Kevin's Chrome** (the doctor says so with the menu path); the `1+1` probe itself is 5 ms once compiled | < 80 |
| tool round trip / quick screenshot / eyes / delegation → first action / stop (§11 rows, re-run) | 0 / 0 / 0 / 2 / 0 | 7 / 60 / 66 / 85 / 0–1 | met |

So the promise "< 250 ms from me saying to the action" is met **from the app
receiving the partial** for the reversible kinds: 3–6 ms on a final, ~125 ms on
a scroll/page partial (the stability window is the budget). A key, an edit, a
typed text or a click through the ear takes ~455 ms from the partial: the 450 ms
careful window that keeps "copy" from firing inside "copy this file to the
desktop" — a trade made after review, and still 3–8× ahead of the model path. What
sits in front of both is the recogniser's own latency (~100–200 ms behind speech,
the app's to measure with the real ear) and the click's own cost in the target app.

### What still needs the model

Anything that is not a whole, unambiguous command in the table: compounds
("scroll down to the footer and click save"), descriptions ("type the address
from the email"), pronouns and positions ("click it", "the third row"), a label
two controls carry, a control not in the accessibility tree (Electron apps
expose it unevenly; a truncated walk of a huge page), anything the policy wants
a yes for (Send, Pay, Delete, a payment page), questions, and everything about
what is on the screen. Those keep the warm brain (§11: Codex ~2.7 s warm, more on
a fresh thread) — and the bench's `delegation → first action` row is where the
rest of the latency lives.

What the contract took from this section: the `pause` and `resume` rows (§13).
The reflex itself is recorded on its delegation (`timings.reflex`, the `note`
step "reflex: …" and the `reflex.mismatch` row), dictation shows as the `acting`
phase, and the source that ran a reflex (ear or Live) is the note's — no
`Snapshot.dictating` flag and no `Delegation.reflexSource` field were added.

## 13. The transport: Go, Pause, Stop (2026-09-11)

Kevin: "also even though i pressed stop im still getting billed and time is
still going up. and consolidate pause and go and stop and make this system much
more resilient and better." The fact under it: GPT-Live-1 bills **$0.05 / min,
per second, for every second a session is open** (§2; `session.usage.updated`
carries the seconds). Until today `pause` muted the session and kept it open —
billed — and the Stop button ran the interrupt, which cancelled the task and
left the session open and listening, so the meter kept going. Both now close the
session. Everything below is `packages/engine/src/engine.ts`, proved by
`packages/engine/src/__tests__/{transport,pause,stop}.test.ts` and
`packages/live/src/__tests__/session.test.ts`.

### The state machine

One transport, four states, no session in any state but two:

| state | session | how you get there |
|---|---|---|
| `asleep` | none | start; `stop`; `sleep` (idle, a pause that decayed, a brain swap); a session the server ended without a reason to reconnect |
| `connecting` | opening | `go` from asleep; a resume from paused; a reconnect after `expired` / `connection_lost` |
| `awake` | open | `session.started` |
| `paused` | **none** — closed | `pause` from awake |

`Engine.transportState` says which. The verbs (`EngineCommand`):

- **`go`** — asleep → wake (opens the paid session); paused → resume; awake or
  connecting → nothing (a debug line, no toast). The one button.
- **`pause`** — only with a session open: everything a stop cuts, then the session
  is *closed* and the conversation held (below). Asleep: "asleep already";
  connecting: "still connecting"; paused: "paused already".
- **`stop`** — the transport's stop (the Stop button, ⌥⎋, `jarhead cmd stop`):
  cut everything, close the session, asleep. From paused: the pause is let go.
  From asleep: background jobs are still stopped; "nothing running" only when
  nothing at all happened.
- **`interrupt`** (`how: said | pressed`) — cut the work and the speech, stay
  awake and listening. A spoken "stop" / "cancel" / "never mind" is this, through
  the ear's and the Delegator's `onStop`.
- **`resume`** — go-if-paused (otherwise a word: "not paused" / "asleep — press
  Go"); **`sleep {cause?, phrase?}`** — a graceful close to asleep, from paused
  too, with its cause on the `sleep` row (§18).

`recomputePhase` decides `paused` first, before "no session → asleep" (it was the
other way round, so a pause with no session would have read asleep); while a
resume is connecting the phase is `connecting`.

### Pause holds the conversation, not the session

`pause()`: cancel like a stop — `hands.cancelPending`, `runner.abortTask("pause")`,
the delegation cancelled quietly (finished as "paused", the brain's own cancel
capped at 1.5 s and never awaited before anything perceptible), the pending
confirmation cleared, dictation ended, the ear quiesced, the speaker flushed —
then `wantAwake = false`, `pauseInfo = {at, sessionId, usageSeconds, sleepsAt}`,
a typed `pause` ledger row, the session **detached at once** (`this.live =
undefined`, the Delegator disposed, its delegations moved to the kept list: the
very next snapshot has no `session` and `Snapshot.pause` instead), then closed
with the deadline (below). Toast "paused · meter stopped".

What stays warm: the brain (never stopped — its resident thread is the expensive
part), the transcript (in memory), the marks, the hands. While paused: `feedMic`
drops PCM (except during a resume's handshake, when the opening session queues it
until `session.started` exactly as a wake does, so Kevin's first word after Go is
not clipped), `ear()` is ignored, reflexes are off, `levels()` reports 0, a
delegation cannot arrive (there is no session). Typing in the Console resumes
first and then delivers the text to the new session. `sleepsAt = at + max(1 min,
idleSleepMinutes)`: a pause nobody resumes decays to `sleep()` in `tick()` — toast
"paused too long · asleep", the pause cleared, a plain wake afterwards.

### Resume is a new session that remembers

`resume()` (or `go` while paused) opens a **new** session through the
same `connect()` as a wake. `sessionConfig(continuity)` is still the one place the
config is built; the resume passes a `# Continuity` section appended after
`buildLiveInstructions({alwaysOn: true})`:

```
# Continuity
Kevin paused you N minutes ago and just resumed. This is the same conversation. What was said before the pause, most recent last:
Kevin: …
Jarhead: …
Last task: "<request>" — <status>: <summary>
Carry on as before; do not recap unless he asks.
```

The lines are the last 12 final utterances of both speakers, at most ~1200
characters (the most recent line always makes it); "Last task" only when the last
delegation had a summary. The `session.started` row carries `resumedFrom`; a
`resume` row `{sessionId, resumedFrom, pausedMs}` follows; `pauseInfo` is cleared
once the session has started — so for the whole handshake the transport still
reads `paused` with `connecting` set, and every rule that would close "a session
while paused" (the watchdog, the decay) excludes `connecting`; the phase is
`connecting` meanwhile, then `listening`, or `muted` when Kevin's
own mute is on (it survives a pause: the new session starts muted). A resume whose
start fails keeps the pause (Go retries with the continuity) and reports the
problem; the decay clock still runs.

**One transcript per session.** Session-timeline milliseconds restart with every
session, and the Delegator's first request window is `transcript.since(0)` — over
a transcript shared across sessions, a resumed session's first delegation carried
*every earlier utterance* as its request ("jarhead send the email jarhead scroll
down"): the reflex did not match and the brain could have redone the old task. The
engine now gives each session its own `Transcript`; earlier sessions' utterances
move to `heldTranscript` at detach (settled first, so the last words before a
pause are on the ledger as `heard` / `said`), and the snapshot and the continuity
read `[...held, ...current]`. Delegations are kept the same way
(`lastDelegations`), so a pause and a resume never empty the Console.

### Stop is synchronous and closes the session

`pressStop()`: `wantAwake = false`; cut everything (as above, minus the "Stop
speaking now and wait" instruction — the session is closing); the pause cleared;
a `stop` ledger row `{how: "pressed", cancelled?}` (only when something happened:
a session, a pause, a connect, a running delegation or a background job); the
session detached and closed with the deadline; `setPhase("asleep")` — all before
the first `await`. The session's own `session.closed` row lands when the close is
answered (or the deadline terminates it). Then the brain's cancel is awaited,
capped. During a connect the stop does not touch the opening socket: `connect()`
checks `wantAwake` again right after `session.started` and, finding it false,
records the started row, closes the session at once and stays asleep, with no
"could not start" problem (a start rejected by a stop is logged, not reported). A
Go pressed during that same handshake re-arms it (`wantAwake` back to true, phase
`connecting`, as `wake()` always did): the session that then starts is kept.

`interrupt()` cuts the work and the speech (`gateSpeech()` + `cutWork()`, §20) and
writes a `stop` row with its `how`. Only a session that has *started* is spoken to: during a connect
the interrupt still cuts background jobs, but writes no `stop` row (the session has
no id yet) and queues no instruction (it would land as the new session's first
words after `session.started`). "Said" (spoken, through the ear or Live's transcript) means Kevin
wants Jarhead to shut up and wait, listening; "pressed" through the `stop`
command means the transport is down. The `interrupt` command's `how` defaults to
`pressed`; the ear's and the Delegator's calls pass `said`.

### Deadlines: close, then terminate

`LiveSession.close()` sends `session.close` and waits for the server's
`session.closed` (it finalizes usage); its own fallback (`CLOSE_FALLBACK_MS`,
**1500 ms**, was 3000) closes the socket if no answer comes. New:
`LiveSession.terminate()` — an immediate `ws.close()`, state `closed`, and
`closed("client_closed", usageSeconds)` emitted **exactly once** (the socket's own
`onclose` and a late `session.closed` frame are swallowed; a terminate while
connecting rejects `start()`). The engine's `closeWithDeadline(live)` calls
`close()` and, if the session has not reported closed within **1000 ms**
(`Engine.CLOSE_DEADLINE_MS`; `EngineOptions.closeDeadlineMs` for tests),
`terminate()`s it. Every path that ends a session — pause, stop, sleep, a stop
during connect, the watchdog — goes through it; the timers are cleared at
shutdown. When the server does answer `session.closed`, the client closes its
socket too: the fallback only acts while the state is not `closed`, so a graceful
close the server answered would otherwise leave the socket open for good (a fake
socket showed it; the real server presumably closes its end as well).

### Race guards

`wire(live)` closes over the session it wired and every handler first asks
`this.live === live`: audio, transcript deltas, delegations, usage and errors from
a session that was paused, stopped or replaced do nothing. The `closed` handler is
the exception: it always folds the final usage into today's base and appends the
`session.closed` row (for a session that reached `session.started`; a socket that
never did has no row), then returns unless the session is still current. A
current session whose socket closed *before* `session.started` (refused, network
down) is detached and left to `connect()`'s catch, which reports the failed start
once and reads `error`; it never reconnects — the 500 ms retry would loop against
the same wall (three attempts in 1.3 s on a fake socket), and Go tries again. A
current session that the server ended reconnects only for `expired` /
`connection_lost` and only if `wantAwake && !paused`, re-checked when the 500 ms
timer fires (a stop in the meantime wins).

### The watchdog

`tick()` enforces the invariants once a second, each incident logged once:

1. `!wantAwake && !paused && !connecting && live` for more than 2 s → the session
   outlived a stop: `terminate()` and asleep.
2. `paused && !connecting && live` → a session open while paused: close (with the
   deadline) and detach. `!connecting` matters: a resume sets `this.live` to the
   opening session while `pauseInfo` is still held (it is cleared at
   `session.started`), and a real handshake spans the 1 s tick often — without it
   the watchdog closed every such resume ("live session closed before it started",
   the pause kept, typed words dropped).
3. no session, not connecting, not paused, phase not asleep / error → asleep.

A normal connect never trips it — a wake's or a resume's: every rule that names a
session excludes `connecting`, which is set for the whole handshake, and a wake
keeps `wantAwake` true. `connect()` itself cannot wedge `connecting`: `wire()` runs
inside its try (a brain that is mid-swap used to throw "brain not started" before
the try, leaving `connecting` true for good), and a brain restart in flight is
awaited before the session is built.

### The meter: `Snapshot.usageToday`

At construction the engine sums today's ledger (`session.closed` rows'
`usageSeconds`, `session.started` rows as the count). `usageToday = {seconds: base
+ the open session's seconds, sessions}`. When a session is detached, what it has
billed so far is folded into the base at once (the meter never dips while the
close is in flight); when its `closed` event brings the final figure, only the
difference is added — a `WeakMap<LiveSession, folded>` counts every second once,
however many times a session reports. The base is re-read when the local day
changes; a session open across midnight counts as one of the new day's sessions,
with its cumulative seconds shown against the new day (the ledger's closed row
lands in the new day's file with the same figure, so a reload agrees).
`Snapshot.pause.usageSeconds` is what the paused session had billed.

### What the tests pin (node:test, `world.ts`)

`world()` now hands the engine one `FakeLive` per session (`w.lives`, `w.live` is
the first; `terminate()`, a once-only `closed`, `hangOnClose` for a server that
never answers, `reportUsage`, `serverClosed`). `transport.test.ts`: pause closes
the session (state `closed`, no `session` in the snapshot, phase `paused`, the
typed `pause` row, `PauseInfo` with `sleepsAt`, mic dropped, brain still ready);
resume opens a second `FakeLive` whose `config.instructions` carry the last heard
line under `# Continuity`, `resumedFrom` on the started row, a `resume` row; stop
is asleep synchronously with `stop` then `session.closed` rows and no reconnect,
from paused and from asleep; stop during connecting closes right after
`session.started` without a problem line; a late `closed` from the old session
records its row and its usage delta and leaves the new session alone; the deadline
terminates a hanging close (stop and pause); the watchdog's three cases; a pause
decays at `sleepsAt`; `usageToday` across close / pause / resume / stop, a day
rollover, and a second engine over the same ledger; `go` in every state;
`interrupt` and the ear's spoken stop keep the session; say-text while paused
resumes first; a resume's handshake survives ticks (and the decay clock), queues
the mic and ends awake without a problem line — over `FakeLive` and over a real
`LiveSession` on a fake socket; stop-then-go within one handshake keeps the
session; interrupt during a connect writes no row and queues nothing; a socket
refused before `session.started` fails once with no reconnect and Go retries; a
wake during `restartBrain` waits for the brain. `stop.test.ts` is the interrupt (gate, cancel, hands, one
instruction, session kept) and the stop aftermath (asleep at once, a new session
on wake while the brain's slow cancel is still settling, `sleep()` closes before
awaiting the cancel). `session.test.ts`: `terminate()` once-only semantics, the
1500 ms fallback under mock timers, a server that answers in time (and the socket
closed from this side once it has).

## 14. Permissions: ask for everything (2026-09-11)

Kevin: "find a way to give it al persmissions and make it ask for allpermisions."
The fact under it: **macOS TCC cannot be granted programmatically.** There is no
API that flips a grant; `tccutil` only resets; a configuration profile can
pre-approve a few services (Accessibility, Full Disk Access, Automation…) but
only under MDM, which this Mac is not. What an app *can* do is ask — once per
kind, through the kind's own request API, which shows the system dialog — and,
for the kinds that have no dialog, deep-link to the exact System Settings pane,
reveal the bundle in Finder for dragging in, and watch for the change. "Give it
all permissions" is therefore a **sweep**: every kind with a prompt, in order,
one dialog at a time (two at once and the second is dismissed with the first),
then the Settings-only ones, then a re-read. Every grant keys on the app bundle
`/Applications/Jarhead.app` (signed with a self-signed Code Signing identity from
the keychain; an ad-hoc signature is cdhash-bound and resets the grants on every
build — §6b, AGENTS.md). The daemon (`node`/`tsx`) and `jarhead-hands` are its
children, so their prompts and their grants are the app's. Two more facts that
bit once each: the bundle carries the hardened runtime, so a protected resource
also needs its entitlement (`apps/mac/Resources/entitlements.plist`), and every
prompt needs its usage string in `Info.plist` — a missing usage string does not
show a dialog, it kills the app on first access.

### The sixteen

`packages/protocol/src/index.ts` — `PERMISSION_KINDS`, `PermissionInfo {kind,
grant, ask, required, label, why, detail?, checkedAt?}`, `Permissions.all`, the
`request-permission {which: kind | "all"}` command; the Swift mirror is
`Model/Protocol.swift`. `ask` says how a kind is obtained: `prompt` (an API shows
the dialog once), `settings` (System Settings only), `perApp` (Automation: one
dialog per target app, when that app is running and first scripted).

| kind | ask | required | read by |
|---|---|---|---|
| microphone, speechRecognition | prompt | yes | app |
| screenRecording, accessibility | prompt | yes | **helper** (fresh process) |
| inputMonitoring | prompt (`IOHIDRequestAccess`, from the app) | yes | **helper** (`IOHIDCheckAccess`) |
| fullDiskAccess | settings | yes | **helper** (read probe) |
| automation | perApp | yes | app |
| notifications, camera, contacts, calendars, reminders, localNetwork | prompt | no | app |
| filesDesktop, filesDocuments, filesDownloads | prompt | no | app |

`required` is one set in three places — the app's `PermissionsKit.meta`, the
engine's `PERMISSION_CATALOGUE`, README's table — the seven above, so Setup's
`missingRequired` and `jarhead status` name the same kinds before and after the
app's first list; `permissions.test.ts` pins the engine's seven (the app's mirror
test is P1's).

### Who reads what, and why the split

TCC answers are **per process**, and a resident process keeps the answer it got
at launch (Screen Recording notoriously; Accessibility too): the only reliable
read after Kevin flips a switch is a *fresh* process. The app is resident, so
the four kinds a helper process can read for itself come from `jarhead-hands
--permissions` (`packages/hands/native/main.swift` `permissionsJSON()`): AX
(`AXIsProcessTrusted`), SR (`CGPreflightScreenCaptureAccess`), Input Monitoring
(`IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) == granted`) and Full Disk
Access — which has no API and no prompt, so the probe opens something only FDA
unlocks (the user `TCC.db`, `~/Library/Safari`) and reads errno: EPERM is "not
granted", success is "granted", nothing is read and no dialog or Settings row
results. None of the four reads prompts. The helper's `permissions` op with
`prompt: true` asks for **one** dialog per call — `which: "accessibility" |
"screenRecording"`; omitted or `"all"` means the first of the two still missing,
never both, because two dialogs at once and the second is dismissed with the
first. Input Monitoring's prompt has to come from the app's own process (the
grant is for the app's global key monitors,
`NSEvent.addGlobalMonitorForEvents(.keyDown)` in mark mode, which silently
receive nothing without it), and FDA has none.

The other twelve are readable only from the app's process (AVCaptureDevice,
SFSpeechRecognizer, CNContactStore, EKEventStore, UNUserNotificationCenter, the
folder prompts fire on first access…), so the app reads them and sends
`{type:"permission", which, state, detail?}` for one and `{type:"permissions",
all: PermissionInfo[]}` for the list (`packages/daemon/src/wire.ts`;
`server.ts` routes them to `engine.setPermission` / `setPermissions`).

### Engine (`packages/engine/src/engine.ts`, the permissions region)

- `pollPermissions` runs from `tick()` (`permissionPollInterval`): a fresh helper
  process every 1.5 s for 90 s after a prompt or an app report that disagrees
  with the engine's own read (Kevin is in a dialog or System Settings); every
  3 s while a kind *with a prompt* — AX, SR, Input Monitoring — is missing or
  unread; every 30 s otherwise, **Full Disk Access alone missing included**: it
  has no prompt, is dragged in by hand, and the app's watch of that pane reports
  the change (which reads fresh at the next tick) — Kevin's likely steady state
  must not cost a process every 3 s for the daemon's life. `applyHelperRead`
  folds a read — the resident helper's greeting at start, or the poll — into the
  state: the rows of `permissions.all` for the four kinds (an
  app row keeps its label / why / ask / required and moves only `grant` and
  `checkedAt`; without an app list the four rows *are* the list, from
  `PERMISSION_CATALOGUE`), the problem lines, the toasts, and `helperGrants` —
  what the engine has read for itself. An Accessibility or Screen Recording
  grant that appears restarts the resident helper (its connections were made
  without the right); FDA and Input Monitoring do not (they are the daemon's
  reads and the app's monitors, not the helper's).
- **The engine's fresh read wins for its four kinds**, in `setPermissions(all)`
  and `setPermission(which, …)` alike (`applyAppWord`): a row keeps the grant
  the engine read itself, and an app word that disagrees only makes the next
  tick read fresh — the app's 1.5 s watch usually sees a grant it just asked for
  a beat before our poll, and that fresh read is what clears the problem line
  and restarts the helper. (The first cut let the singular `permission` message
  overwrite the engine's grant; the poll then found nothing changed, so the
  problem never cleared and the helper kept running without the right. And a
  stale app word — a resident process's old answer — could toast "revoked" or
  restart the helper for nothing.) Without a read of its own (the helper not
  built, or not greeted yet) the engine takes the app's word through the same
  transition logic, so the problem and the restart follow it. The list is the
  app's rows in the app's order with the app's labels, one row per kind (a
  repeated kind keeps its first place and takes the last row); a helper kind the
  app left out keeps the engine's row, so the list never loses a grant it has.
  The microphone follows the app's list through `setMicrophonePermission`
  (problem when denied, cleared when granted). `setPermission` adds the
  catalogue row for a kind not listed yet, so `jarhead status` sees a single
  report before the app's first full list. Junk rows (no known kind) are dropped.
- `PERMISSION_PROBLEMS` covers the four the engine can see: the two that
  existed plus "Input Monitoring not granted: …" and "Full Disk Access not
  granted: files under Desktop/Documents/Downloads/Mail/Safari will fail with
  EPERM until Jarhead.app is added in System Settings › Privacy & Security ›
  Full Disk Access", each with the "if System Settings already shows Jarhead
  on, that row is from an earlier build" hint (an ad-hoc build's row shows on
  and does nothing — remove it and ask again). A problem is raised when the
  grant is missing and cleared when it appears; a revocation toasts a warning,
  a grant that appears toasts what works now; a first read toasts nothing.
- `request-permission` is a **prompt queue**, one dialog at a time:
  `"accessibility"` or `"screenRecording"` prompts that one kind through the
  helper (`permissions {prompt: true, which}`); `"all"` queues Accessibility,
  then Screen Recording, and the next dialog is shown only once the one on
  screen is granted — the fresh read sees it — or after `PROMPT_WAIT_MS` (30 s:
  a denied or dismissed dialog leaves nothing to read). Kinds already granted
  are skipped, a new request replaces the queue, each prompt opens the 1.5 s
  poll window for 90 s. Every other kind returns at once — the app intercepts
  the command and shows that prompt itself (the sweep is the app's, and it asks
  AX and SR from its own process; the engine's queue serves a row's Request on
  either, which the app forwards, and a caller without the app).
  `JARHEAD_PERMISSIONS_DRY_RUN=1` logs the queue and asks nothing.
- Snapshot: `Permissions` is the row list, `permissions.all` — present once
  anything is known, possibly partial (the four, until the app reports);
  `grantOf(permissions, kind)` reads one row's grant, `unknown` when no row.

Proved by `packages/engine/src/__tests__/permissions.test.ts` (a fake helper
answers `hello` and the fresh read through `EngineOptions.probePermissions`; no
dialog is ever shown) and the daemon round-trips in
`packages/daemon/src/__tests__/daemon.test.ts`.

### The EPERM line (`packages/brain/src/files.ts`, `shell.ts`)

Without a grant, TCC answers a read or write with `EPERM` ("Operation not
permitted") and nothing else — no dialog for FDA, a raw errno for the model.
`files.ts` maps an EPERM on a guarded path — `~/Desktop`, `~/Documents`,
`~/Downloads` (their own prompt), `~/Library/…`, `~/.Trash` (Full Disk Access) —
to one line: `macOS blocked this: Jarhead lacks <Full Disk Access | access to
the Desktop folder>. Setup › Permissions › Ask for everything`. `readWindow`,
`writeText`, `editText`, `listTree` (a blocked root is the whole result; a
blocked subfolder is its `[unreadable: …]` line) and `searchFiles` (a blocked
root says so instead of "no hits") use it; `describeShellResult` appends it
when stderr carries "Operation not permitted" about a guarded path. The path is
the one the stderr line names (`ls: ~/Desktop: Operation not permitted`, `zsh:
operation not permitted: ~/Library/Mail`); a named path TCC does not guard
(`chflags` on `/System`) is no permission problem whatever else the command
mentions, and the command is read only when no line names a path (`kill: …
operation not permitted`), skipping a redirect's target (`> ~/Desktop/log.txt`
is where the output went, not what was blocked). A bare `Desktop`/`Library`
token is relative to the home folder, the shell's default cwd. With output on
stdout the line reads **`macOS blocked part of this: …`** — `find` or `ls -R`
over the home folder without FDA prints its hits and a warning per skipped
folder, and the hits stand — and `macOS blocked this` only when nothing came
back. An EPERM elsewhere and every EACCES stay what they were, and no policy
decision moves: policy ran before the read. The `read_file` and `run_shell`
descriptions tell the model which is which: "blocked this" is a missing
permission, not a bug — say it to Kevin and stop; "blocked part of this" — use
the output, add the line. Proved by `packages/brain/src/__tests__/
macos-block.test.ts` on synthesized errors and stderr (no guarded path is
touched: a folder prompt could fire).

### CLI and doctor

`pnpm jarhead status` prints `permissions  12/16 granted · missing: Full Disk
Access (System Settings), Contacts (prompt)` from `snapshot.permissions.all`
(`--permissions` for a row each; a partial list says how many the app still has
to read). `pnpm run doctor` shows the four the helper can read — marked as *this
terminal's* grants, since TCC keys them on whoever launched the helper — says the
rest is read by Jarhead.app (Setup shows it), and, when a daemon answers, prints
the app's list under a `permissions` group with the required-and-missing kinds
as the next step.

### One bundle on disk: the install is in place (2026-09-12)

Kevin: "figure out the multi app situation. there should only be one jarhead."
The Dock's pinned tile is a bookmark (the `book` blob) keyed on the bundle
**directory's inode**, and every grant above keys on the same bundle, so an
install has to keep the path, the identity and the directory itself: `pnpm
build:mac` updates the bundle in place and never replaces it. Step 5 of
`scripts/build-mac.ts` (the three signing lines are untouched):

1. `planInstall(probeTarget("/Applications/Jarhead.app"))` refuses a symlink (rsync
   follows a destination link and writes into its target), a regular file, another
   uid's directory (never `sudo` from a script), or no write bit — before anything
   is written; the signed stage stays in `build/stage/` for inspection.
2. First install (nothing there): `cp -R` of the stage. Otherwise `/usr/bin/rsync
   -rlptD -c --delay-updates --delete-after --itemize-changes build/stage/Jarhead.app/
   /Applications/Jarhead.app/`. With `JARHEAD_INSTALL_SNAPSHOT=1` the installed
   bundle is first archived under gitignored `build/previous/` as `Jarhead.app.zip`
   (`ditto -c -k`; an archive, never a directory — see "Learned since" below); by
   default no snapshot is taken. `-rlptD` is `-a` without owner/group; `-c` compares
   by checksum (two files of equal size in the same second were skipped by the quick
   check once); `--delay-updates` renames every changed file in one burst after the
   transfer; `--delete-after` drops what the stage no longer has. Never `-E`:
   openrsync's xattr emulation writes `._*` AppleDouble entries into the bundle
   (the signature is embedded, not in xattrs; a copy without them verifies strict);
   never `--inplace`: it would write into the running app's mapped, signed Mach-O.
   Each changed file is a new inode renamed over the old name, so pid N keeps what
   it has mapped and the directory inode never changes.
3. The **installed** copy is verified, not the stage: `codesign --verify --strict
   --deep --verbose=1` (the helper is nested code; `--strict` refuses sideband a bad
   copy could add), `codesign -d -r-` must contain `identifier
   "com.kevinliu.jarhead"` (the designated requirement TCC keys the grants on), a
   sha256 walk proves the installed tree is exactly the signed stage (rsync's exit
   code on a permission error is not trusted), and the directory inode after equals
   the one before. Any failure keeps the stage and exits 1; when a snapshot was
   taken the rollback line is printed — `ditto -x -k <the zip> /tmp/jarhead-rollback
   && rsync -rlptD -c --delete-after /tmp/jarhead-rollback/Jarhead.app/
   /Applications/Jarhead.app/` — and otherwise the rollback is `git checkout
   <previous> && pnpm build:mac`, in place, inode kept. `build/Jarhead.app` stays a
   symlink to the installed bundle.
4. One Jarhead: `lsregister -f /Applications/Jarhead.app`, then the Bundle table
   (`lsregister -dump Bundle`: ~2 s on an idle Mac, 66–85 s at load average 300
   because every lsregister call waits on lsd; the pass allows each call 120 s —
   a 20 s cap once made this half silently do nothing during a slow self-edit
   build; the full `-dump` is minutes) is read and every stale Jarhead record —
   Jarhead's id at any other path (paths compared resolved, so a record at the
   `build/Jarhead.app` symlink is the installed bundle, never stale), a
   `com.kevinliu.jarhead.*` probe bundle under a self-edit worktree or the Trash or
   gone, any other bundle **named** Jarhead.app under those roots (`open -a
   Jarhead` resolves by name, so a stray copy with another id would still launch)
   — is `lsregister -u`'d: the database only, no file and
   nothing in the Trash is touched. A build dumps the table once and reports from
   the `-u` exit codes; only `dock --fix` dumps again to prove the records went. A
   dump that fails or times out carries its reason (`spawnSync … ETIMEDOUT`) into
   the `one jarhead` line and the doctor row. Then a READ-ONLY line about the Dock.
5. The Dock is rewritten only when Kevin asks: `pnpm jarhead dock --fix` or
   `JARHEAD_INSTALL_HYGIENE=fix`. `defaults export com.apple.dock -` (through
   cfprefsd; the plist file itself is what cfprefsd overwrites) → drop every Jarhead
   tile from `recent-apps`, keep the FIRST pin in `persistent-apps` where it is and
   drop later ones, and when anything changed or the pin's URL is not
   `file:///Applications/Jarhead.app/`, strip that pin's `tile-data` to exactly
   `bundle-identifier`, `file-data`, `file-label`, `file-type` (the Dock rebuilds
   `book` and the mod dates) → re-export and compare `mod-count` (the Dock rewrites
   its domain on its own events; three rounds, then "kept changing") → `defaults
   import com.apple.dock -` → `killall Dock` only when something was written. No pin
   → report only; pinning is Kevin's. `JARHEAD_INSTALL_HYGIENE=0` skips the pass.

The library is `@jarhead/cli/install` (`packages/cli/src/install/`: an XML-plist
reader/writer that keeps `<data>` and 14-digit integers verbatim and re-serializes
Apple's export byte for byte, the Dock audit, the lsregister parser and stale rule,
the install plan/argv/parity, `performInstall` — steps 1–3 above as one function over
injectable exec/fs seams, so a scripted run pins the order and every fail path — and
`runHygiene` with one injectable `exec`); every test runs in CI without a Dock, and
the openrsync behaviour (inode kept, rename in, `-c`, no temp files, an opted-in
snapshot into a missing `build/previous/`) is proved between two temp trees on macOS. `pnpm run doctor`
gains read-only rows `install`, `launch services`, `dock`; `pnpm jarhead dock` prints
the same audit; `pnpm build:mac` prints an `install` line (`kept (inode …) · 4 files
replaced …`) and a `one jarhead` line. The hunk touches the "app signing" rail by
regex (it says `codesign`); the signing lines themselves are byte-identical.

### Learned since (2026-09-12, later): CI, the snapshot, the self-healing Dock

Three things the first cut got wrong, in the order they showed up.

**The runner's openrsync speaks differently.** `install-bundle.test.ts`'s live
openrsync case passed here and failed on GitHub's macos-15 runner: the parsed
deletion list there was `['Contents/Resources/stale.txt', 'Contents/Resources',
'Contents/Resources/stale.txt', 'Contents/Resources']` against an expected
`['Contents/Resources/stale.txt']`. That build itemizes the emptied directory
without a trailing slash (this Mac's says `Contents/Resources/`) and prints every
deletion twice, one line per `--delete-after` pass. `parseItemized` no longer
depends on either: every list holds each path once, slashes trimmed, and directories
stay in `deleted`; the tests assert the SET — stale.txt went, nothing outside its
subtree did — and `installLine` counts unique entries. The rule that came out:
assert what a system tool's output *means*, never its exact shape across macOS builds.

**A directory snapshot is a second Jarhead.** LaunchServices registers any `*.app`
directory it meets as a bundle with that bundle's id, so a full copy of the installed
app anywhere under `build/` shows up in `lsregister -dump` beside `/Applications`
however often a build unregisters it. The rollback snapshot is therefore an archive —
`Jarhead.app.zip` under `build/previous/`, and `snapshotNameOk` refuses a `previous`
that does not end in `.zip` before anything is written — and it is taken only when
`JARHEAD_INSTALL_SNAPSHOT=1` asks for it: by default the install keeps no copy, the
rollback is git, and a stale record for Jarhead's id at any path but /Applications is
unregistered by the same build's one-Jarhead pass.

**A Dock that fixes itself, on Kevin's press.** The install keeps the inode, but a
Dock that had already grown the second tile keeps it until something removes it.
`ProblemKind` gained **`dock`** (`packages/protocol`; the Swift mirror keeps
`Problem.kind` a String, so a kind this app does not know still decodes and the
Console shows the default glyph). Twenty seconds after `start()` the engine reads the
Dock — `readDock`, one `defaults export com.apple.dock -`, ~100 ms, never lsregister
(lsd can hold a call for two minutes) — and a pin with a recent Jarhead tile beside it,
or two pins, is the row **"Two Jarhead tiles in the Dock"** (the count past two) with
**Fix the Dock** as its remedy, `problem.retry {kind:"dock"}`. That press runs
`repairDock` — the Dock half of `pnpm jarhead dock --fix`, factored out of
`runHygiene` so both paths are one code: re-export and compare `mod-count`, `defaults
import`, `killall Dock` only when something was written — then a re-read clears the
row (or keeps it with the reason, `— defaults import failed (1)`), a toast says what
was done, and `tick()` reads once more ten seconds later (`DOCK_RECHECK_MS`) in case
the relaunched Dock rewrote its domain with the tile back. Two things the review
caught: an import whose `killall Dock` failed is *not* a fix — cfprefsd holds the clean
document while the Dock process still draws both tiles and will write its copy back
on its next event, so the re-read is not the truth. That case keeps the row as
"Two Jarhead tiles in the Dock — Dock not restarted", toasts a warn ("Dock written,
not restarted — press Fix the Dock again"), arms no recheck, keeps the row through a
clean audit (`dockRestartOwed`), and the next press runs only `restartDock` — the
`killall Dock` factored out of `repairDock` so both are one code. And a press whose
read fails toasts "Could not read the Dock: …" instead of silently doing nothing.
Every Dock shell-out is capped at `Engine.DOCK_EXEC_TIMEOUT_MS` (3 s; forwarded as
`DockOnlyOptions.timeoutMs`) because they are spawnSync on the daemon's event loop —
a hung cfprefsd could otherwise hold a voice session for defaultExec's 20 s; the CLI
passes no cap and its argv trace is unchanged. The startup read never
restarts the Dock; a recent tile with no pin is one tile and no row (nothing the fix
could do — pinning stays Kevin's); nothing here touches a file. Seams:
`EngineOptions.exec` and `dockAuditDelayMs`; `world.ts` exports `noShell` (answers
127) and every `new Engine` in a test passes it, so no test reads the real Dock.
Proved by `packages/engine/src/__tests__/dock.test.ts` over Kevin's sanitized Dock
export (the delayed read-only audit; a clean and an unreadable Dock; the retry's
exact argv and stdin; the row back at the recheck; a failed import; a failed
`killall` and the owed restart; a failed read on a press; the 3 s cap on every call)
and `install-hygiene.test.ts` (`readDock` / `repairDock` / `restartDock` alone, no
lsregister, `timeoutMs` forwarded only when given). `pnpm
jarhead status` prints each problem with its kind and remedy label. The Swift side:
`Protocol.swift` compiles through `protocol-probe.sh`, and a capture carrying a `dock`
problem and an unknown kind decodes.

## 15. Latency: the warm thread and the clean Codex home (2026-09-12)

Kevin: "simple commands like 'search the wiki for design' produce a visible
action within two to five seconds after I finish speaking", and later "tool
uses should literally be sub 2 second". This section is builder I1's part of
the answer: what the resident Codex thread cost, why, and what changed in
`packages/brain/src/{codex-app-server,codex-config,codex}.ts`. Everything
measured below was measured on this Mac on 2026-09-11/12 with the analysts'
ledger pulls (39 delegations, then 51), `codex debug prompt-input` (renders the
model-visible developer blocks with no model call), and a harness that drives
the worktree's real `CodexAppServer` + `prepareCodexHome` against a fake tool
socket (canned `frontmost_app`; nothing touches the Mac) — one small turn per
data point, on Kevin's ChatGPT plan, n=1 unless said otherwise.

### The baseline to beat (four analysts, real ledger + controlled runs)

From delegation: first model thought **5.7 s** median; first model tool
**11.3 s** median (p90 13.0); first visible action **12.5 s** median (p90 17.5,
p95 19.8), zero delegations with an action inside 5 s; verified completion
**22.1 s** median (p90 40.7); the spoken reply 0.7 s after done. Live
acknowledges 0.2 s after delegation; speech end → delegation 0.4–1.6 s (n=4).
Tool round trips 55 ms median (p95 211); app-server delegations spend 0.4–2.2 %
of their wall time inside tools. Every model generation costs 3.4–4.1 s median
(p90 5.9); a warm no-tool turn 1.8–3.1 s to first token, a cold one 4.3 s;
effort low/medium/high made no difference on trivial turns. The multipliers
that were Jarhead's to remove: a rollover bug that discarded the thread after
most delegations; a prompt that carried Kevin's whole Codex-app preset; a
narration generation before the first tool (4 of 10 controlled runs, +1.9–4.7
s); and a fresh thread's first turn paying the MCP bridge start and the cold
prompt.

### The rollover bug

`thread/tokenUsage/updated` carries two breakdowns: `total`, the thread's
**cumulative bill** (every request's input and output added up: 19.4k → 38.8k
→ 58.2k over three trivial turns), and `last`, the **last model request** —
the context as it stands (23–33k in the same three turns). `needsFreshThread()`
judged `total` against the 258 400 window at 0.7, so a delegation with a few
tool calls (each a model request) pushed `total` past 181k and the thread, its
prompt cache and its MCP bridge were thrown away: 6 rollovers in 18 warm
delegations, 11 in the daemon.log, each costing the next task +1.3–5.7 s to its
first tool (bridge restart 0.3–0.4 s, `userMessage` 1.25 s vs 0.65 s warm, the
cache). The log line said "context rolled over … (? tokens used)".

Now `TokenUsage.contextTokens` is `last.totalTokens` (else `last.inputTokens`)
and `needsFreshThread()` judges that; usage notifications for another thread
are ignored. The log reads `context 181k/258k (0.70) → fresh thread 01a0935d
(after the turn that filled it, thread/start 940 ms)`. Proved in
`codex-app-server.test.ts` with the analysts' sequence (bill 19.4k/38.8k/58.2k,
context 23.1k/26.4k/33.0k: one thread; then context 181k: one rollover) and in
`codex.test.ts` (three turns whose bill grows 25k each of a 100k window keep
the thread and carry no history text).

### Hiding the rollover that must happen

When a turn fills the context, the replacement `thread/start` goes out with
that turn's `turn/completed`, in the background — not at the next task. The
brain awaits `settleThread()` before building a turn's input: it waits for a
replacement still starting, interrupts a primer still running, and rolls over
now if the context is full and nothing is on it. The `rollover` event sets
`carryHistory`, so the next turn carries the last exchanges as text and a
"yes" still knows what it confirms (`codex.test.ts`: the task rides `thread_2`
with `Earlier in this session:` in its input; `codex-app-server.test.ts`: a turn
arriving mid-`thread/start` waits for it rather than running on the full
thread; `backgroundRollover: false` keeps the old at-the-next-turn behaviour).

**Priming.** A thread's first turn pays the MCP servers' start (the bridge
0.3–0.4 s; `turn/start` answers only after ~1–2 s) and the cold prompt. Every
fresh thread — at brain start and after a rollover — now gets one tiny
background turn (`PRIMER_TEXT`: "Reply with the single word ok. Do not call any
tools."). A task that lands mid-primer interrupts it (`turn/interrupt`, ~35 ms)
and goes out on the same thread. Measured with the harness (private home,
Jarhead's base prompt, "What app is in front right now?", fake tools): first
tool **3.24 s** and done in **5.9 s** on a primed thread vs **5.19 s / 8.7 s**
on an unprimed one (n=1 each; the primer itself took 4.1 s off the task's
path); the primed turn's request was 10 624 of 10 845 tokens cached. It costs
one small model request per thread start (rare now: once per daemon start, once
per ~180k of context). `JARHEAD_CODEX_PRIME=0` switches it off. Proved in both
test files: primer first, a task after it not interrupted, a task during it
interrupting it, `primerStats` counting.

**Wake and sleep.** daemon.log's seven "warm app-server up after …" lines each
follow a "daemon: listening" line: they are seven **daemon starts** ("stdin
closed, shutting down" when the app quits; one SIGTERM), not wakes. Between
them one thread served every wake — "brain warm at wake: yes (warm app-server,
thread 01a0928f reused across tasks)" eleven times for one thread — and the
engine's `sleep()` never touches the brain (`engine.stop()` does, at process
end). Nothing to change in the brain: the thread already survives sleep/wake
within the daemon's life. What ends it is the daemon dying with the app; the
daemon outliving the app (apps/mac, `packages/daemon`) is the remaining lever.

### The clean home

Every fresh thread inherited Kevin's `~/.codex`: the skills catalog (`~8.4k`
tokens: 260 of 718 skills listed, a budget warning per turn), his global
`AGENTS.md` (`~0.7k` tokens: a "Start" list pointing at
`~/Documents/GitHub/kevin-wiki`, which no longer exists → 13 bootstrap calls, 6
no-such-file reads, `npm run status` 2.1 s; 22.5 s of the 40.8 s wiki-search
delegation), the plugin marketplaces, the `notify` hook, multi-agent role text
(`~0.7k`).

`prepareCodexHome()` (codex-config.ts) builds and refreshes
`<stateDir>/codex-home` at every brain start and both entry points run with
`CODEX_HOME` there: `auth.json` a **symlink** to `~/.codex/auth.json` (one login,
shared; a refresh writes through — Codex writes auth.json in place, truncate and
write, so the link survives; should a future Codex rename a temp file over it,
the next start moves the regular file aside as `auth.json.stray-<ts>` and
re-links with a warning, never deleting the newer tokens); a `config.toml`
Jarhead **writes** with only `model`, `model_reasoning_effort`, `service_tier`
copied from Kevin's top-level lines (no plugins, marketplaces, notify, MCP
servers); no `AGENTS.md`; an empty `skills/`. Falls back to `~/.codex` when
there is no `auth.json` to link, or when `CODEX_HOME` already is the private
home (linking auth.json onto itself would eat the login), with the reason
logged; the app-server argv then still disables Kevin's `[mcp_servers.*]` as
before. `codexEnv` still scrubs `SECRET_KEYS`; nothing under `~/.jarhead/env` is
referenced. Kevin's `config.toml` gave Jarhead nothing but the model line: the
computer-use, browser and REPL servers and 13 plugins were the reason it had to
be neutralised, and `--disable apps` stays for the connector runtime.

Skills are the one thing a private home does not remove: Codex discovers
`~/.agents/skills` through `$HOME` and writes its bundled `.system` skills into
the home. `skills.agents`, `skills.config` per directory, `features.skills`,
`skip_host_skill_discovery` and `--disable multi_agent` did nothing (analyst,
confirmed); **`skills.include_instructions=false`** removes the whole
`<skills_instructions>` block. `codexPromptTrimArgs()` rides both argvs (exec's
`--ignore-user-config` skips the config.toml, so `-c` is the only place):
`skills.include_instructions=false`, `include_permissions_instructions=false`
(shell escalation text, declined anyway), `include_collaboration_mode_instructions
=false`, `features.plugins=false` (the `<recommended_plugins>` list).
`codex debug prompt-input`, chars of developer text: Kevin's home **39 221**
(`skills_instructions` 32 080, `multi_agent_role` 2 429, `recommended_plugins`
4 441); private home 32 394; private home + trims **2 700** — the
`<multi_agent_role>` and `<multi_agent_mode>` blocks, which follow the model's
`multi_agent_version` and no flag removes. Kept on purpose:
`<environment_context>` (~850 chars: cwd, sandbox, date, timezone).

**Measured on the model** (harness, cold thread, "say ok", `last.inputTokens`):
Kevin's home, Codex's base prompt **22 335** (the analysts' 21 589 plus I2's
longer addendum); private home + trims, Codex's base **14 647**; private home +
trims, Jarhead's base **10 747** — a 52 % smaller cold request.

### Codex's preamble habit: Jarhead's base prompt

`codex debug models` shows gpt-6-astra's base prompt (21 261 chars, ~5.6k
tokens): "If the user's request requires calling tools, start with a message in
the `commentary` channel" — the narration generation the analysts measured —
plus patches, PR descriptions, plans, skills and plugins. Code mode's calling
convention (`tools.mcp__jarhead__<name>` through `exec`) comes from the `exec`
tool's own description, not from that text, so `thread/start.baseInstructions`
now carries `codexBaseInstructions()` (codex.ts): the brain of a voice
assistant, the first output for a tool-shaped request is the tool call, a
message only as the final answer or the confirmation question, no coding task.
Harness, "What app is in front right now?" on a cold private-home thread:
Jarhead's base — `frontmost_app` called at 5.19 s with **no message before
it**, final answer "Finder is in front, showing the Desktop." at 8.27 s, request
10 819 tokens; Codex's base — the same call at 5.95 s, also without a preamble
in this one sample, 14 732 tokens. So `baseInstructions` does not break tool
calling and saves 3.9k tokens per request; whether it removes the 4-in-10
narration cannot be claimed from n=1 — I2's addendum countermand stays in
place, and `JARHEAD_CODEX_BASE=codex` restores Codex's own for an A/B.

### Knobs, all opt-in, all in codex.ts

- `JARHEAD_CODEX_SIMPLE_EFFORT=low`: `isSimpleRequest()` — a few words,
  starting with an imperative verb, no question, or a confirmation answer —
  runs at that effort, everything else at the brain's, set on **every** turn
  because Codex keeps a turn's effort for the following turns; logged per turn
  (`effort low (simple: "open Safari")`). Off unless set; I4's `bench
  --effort` measures it. (The analysts saw no effort difference on trivial
  turns, so the expectation is small.)
- `JARHEAD_CODEX_SERVICE_TIER=priority`: `-c service_tier`. The catalog says
  the model's default tier is `priority` ("Fast: 2x speed, increased usage")
  while Kevin's config pins `default`; one A/B ("say ok", cold): priority
  **5.87 s**, default **4.02 s** to first token — no gain at n=1, left off.
- `JARHEAD_CODEX_PRIME=0`: no primer turns. `JARHEAD_CODEX_BASE=codex`: Codex's
  base prompt.

### Not changed, with numbers

The MCP bridge is still `node + tsx`: the bridge answers `initialize` at
299–308 ms warm (641 ms on a cold disk cache) under tsx and at 297–308 ms under
Node 24's native `--experimental-transform-types` — the cost is loading the MCP
SDK, zod and `@jarhead/*`, not the loader, and a prebuilt entry would need a
build step the repo forbids. With the rollover fix and the primer the cost is
rare and off the task's path.

### What remains

The model: 3.4–4.1 s per generation, and a tool-shaped request still needs one
generation before its first call (3.2 s primed, 5.2 s cold, in the harness). A
first turn on any thread still starts the MCP servers (hidden by the primer).
The 711-token multi-agent block. The daemon dying with the app. And the prompt
cache turned out to be keyed on the prefix across threads and processes (a
fresh thread's first request showed 10 624 of 10 845 tokens cached when an
earlier thread had the same developer instructions), so keeping the developer
instructions byte-identical between threads is worth more than any per-thread
warmth: a per-turn effort or tier is fine, a per-turn change to the standing
orders is not.

## 16. Crashes: taps, NaN, and coming back (2026-09-12)

Kevin, 2026-09-11, after an evening on the new build: "it crashes a lot … make it
work a lot better". Eight crash reports under `~/Library/Logs/DiagnosticReports`
(`Jarhead-2026-09-11-*.ips`), all `EXC_CRASH (SIGABRT)`, all `abort()` after an
uncaught NSException — an ObjC exception, which Swift cannot catch, which ends the
process. Two signatures; one consequence; one thing nobody had seen.

### The two signatures

**Tap format mismatch — 5 of 8** (15:46:39, 20:45:31, 22:48:43, 22:50:32,
23:05:58). `WakeWordListener.startLocked` → `-[AVAudioNode installTapOnBus:
bufferSize:format:block:]` → `AVAudioEngineImpl::InstallTapOnNode` raises "Failed
to create tap due to format mismatch". Every one right after the input device
changed: `AVAudioEngineConfigurationChange` → `restartAfterConfigurationChange` →
`stopLocked` → 0.4 s → `startLocked`. The code checked `sampleRate` and
`channelCount` and passed `input.outputFormat(forBus: 0)` as the tap's format —
but after a configuration change that format is stale until the engine is reset
and prepared, so it disagrees with the node's real output and AVFoundation throws.
The unified log at 15:46:35 showed the format: 1 ch, 48 000 Hz, Float32.
`AudioEngine.startGraph` (the voice mic) and the ear install taps the same way.

**NaN into CoreText — 3 of 8** (22:39:05, 22:58:21, 22:58:34, all after the notch
island shipped at 21:47). `NotchView.drawIslandContent` → `NSString.draw(in:
withAttributes:)` → CoreText `TAttributes::ApplyFont` → `-[NSDictionary
initWithObjects:forKeys:count:]` "attempt to insert nil object", on the main
thread during a layer display. The three attribute dictionaries hold non-optional
fonts and colours; the nil is CoreText failing to build a font for a non-finite
geometry. The island's rect comes from two springs, and in peek mode
`widthSpring.target = notchWidth + 30 * sim.islandLevel` — the audio level. An
RMS over an empty buffer (a device switch mid-frame) is 0/0 = NaN; a NaN level
makes a NaN spring, a NaN rect, a NaN font. The same device change explains why
the two kinds cluster in the same minutes.

### The fixes (builders A and B, in their own files)

- **A — every AVFoundation raise is caught.** A one-function Objective-C target
  (`apps/mac/Sources/JarheadObjC`, `JHTry(block, &error)`) wraps a block in
  `@try/@catch` and returns the NSException as an NSError; `ObjCTry.swift` gives
  Swift `try objcTry { … }`. `installTap`, `engine.reset()`, `engine.prepare()`
  and the format reads in the wake listener, the voice engine and the ear go
  through it, the tap asks for `format: nil` (the node's own), the engine is
  reset and prepared before the format is read again, and a raise becomes a
  logged retry instead of a dead process.
- **B — levels are untrusted numbers.** `finite01` clamps every level at the
  source (`BlobSim.setLevels`, the meters), `isFinitePoint / isFiniteVector /
  isFiniteRect` guard the blob physics and the island's geometry, and
  `BadNumber.noteOnce` logs a non-finite value once per site so the origin is
  named the next time instead of the font.

### What a crash used to cost, and the net under it now (builder C)

Each app crash closed the daemon's stdin; `process.stdin.on("end")` shut the
daemon down (`jarheadd: stdin closed, shutting down`), the resident Codex thread
and its warmed cache died with it, and the app — with no crash handler — did not
come back. Fourteen daemon respawns in the hour Kevin was using it, and the
"latency" of §15 paid again after every one.

**CrashGuard** (`apps/mac/Sources/Jarhead/App/CrashGuard.swift`, installed in
`AppDelegate.init`, before anything else can crash):

- `NSSetUncaughtExceptionHandler` plus `sigaction` for SIGABRT, SIGSEGV, SIGBUS,
  SIGILL, SIGFPE and SIGTRAP (SA_SIGINFO, an alternate stack for the main
  thread) write `~/.jarhead/crashes/<local time>.txt`: kind and reason (the
  exception's name and reason, or the signal and fault address), version and
  commit (`.git/HEAD` of the running tree), uptime, the phase, the daemon's pid,
  the relaunch decision, the last 40 lines of the app's own ring (`appLog` /
  `CrashGuard.remember`: launch, phase changes, connect/disconnect, audio
  status, wake gate, mic grant, voice audio start/stop, every `[app]` line of
  daemon.log), then the backtrace — `exception.callStackSymbols` for an
  exception, `backtrace(3)` + `backtrace_symbols_fd(3)` for a signal.
- The signal path is async-signal-safe by construction: everything it touches —
  the directory fd, every label, the phase and signal names, the ring, the
  frame array, the relaunch argv/envp, the spawn attributes, a scratch buffer —
  is allocated at install; the handler loads pointers, formats integers by hand
  and calls `write`, `openat`, `backtrace_symbols_fd`, `sigaction`, `raise` and
  `posix_spawn`. No String, Array, closure or class is created there. A crash
  handler that crashes is worse than none.
- Then it chains: a previous signal handler is called; otherwise SIG_DFL is
  restored and the signal re-raised, so the process dies the normal way and the
  system's `.ips` (with `lastExceptionBacktrace`) is still written. The
  uncaught-exception handler chains to AppKit's, whose abort reaches the signal
  handler again and appends one line (`then: signal SIGABRT (6) — the runtime's
  abort after the exception above`). Should AppKit swallow the exception and
  keep running (it can, inside its event loop), a 1.5 s follow-up notes
  `survived:` in the report and re-arms the guard.
- **Coming back.** The handler `posix_spawn`s `/bin/sh` in its own session
  (`POSIX_SPAWN_SETSID | CLOEXEC_DEFAULT`, stdio on /dev/null, signal mask and
  dispositions reset — main.swift ignores SIGTERM/SIGINT), which waits for our
  pid to be gone (up to 60 s: the crash reporter holds an aborting process for
  seconds), bails if it is not, and otherwise `open -a Jarhead.app` (or exec's
  the dev binary). The crash files are the counter: three relaunches in ten
  minutes, then `relaunch: no — 4 crashes in 10 minutes; staying down until
  Kevin opens Jarhead himself`. `JARHEAD_NO_RELAUNCH=1` turns it off.
- **Telling Kevin.** On the next launch a report younger than ten minutes
  becomes `AppState.lastCrash` (`CrashNotice`): one 28pt line under the Console
  rail's tabs on every tab — warning glyph, "Crashed 2 min ago · <reason>",
  *Details* (reveals the file), × — and one row in the status/Dock menu; both
  gone on dismiss. The same line goes into daemon.log through the `[app]` path
  (`DaemonProcess.noteCrash`), next to the engine's lines. Never a modal.

**The daemon survives the app** (`packages/daemon`): `Lifeline` in `server.ts`,
wired in `main.ts`.

- A clean quit says so first. `DaemonProcess.stop` sends `{type:"bye"}` on a
  fresh connection and waits for the daemon's `bye` **ack** before closing;
  then it closes stdin as before. The ack is not decoration: the daemon answers
  a fresh connection with its hello and a snapshot that runs to tens of
  kilobytes (64 agent sessions on this Mac), a client that closes before that
  write drains fails it with EPIPE, Node destroys the socket, and a bye still
  unread in the receive buffer is lost with it — measured against a real daemon,
  twice (a write-then-close bye landed in 1 of 3 tries; with the ack, 3 of 3,
  and the whole quit takes 0.9 s instead of the 3 s SIGTERM fallback).
- Stdin EOF within 10 s of a bye: `stdin closed, shutting down`, as before.
  EOF without one: `app went away without a bye; lingering 90 s for a relaunch`
  — the socket, the brain and the hands stay; the relaunched app attaches
  (`attached to a running daemon`) and finds the thread warm. A client joining
  cancels the timer; the last client leaving an orphaned daemon starts a fresh
  one (so `pnpm jarhead status` mid-linger extends it by one window, no more);
  nobody back at the deadline → `nobody came back in 90 s, shutting down`. A bye
  to an orphaned daemon — the relaunched app quitting — is the quit itself: its
  stdin cannot close a second time. A daemon on a terminal (`pnpm jarheadd`)
  hears byes and ignores them. `JARHEAD_LINGER_MS` shortens the window for tests.
- An orphaned daemon's stdout/stderr are dead pipes: `process.stdout.on("error")`
  swallows the EPIPE that would otherwise kill it, and from the EOF on it appends
  its lines to `daemon.log` itself (per line, `appendFileSync`). For that to
  interleave with the app's writes, `DaemonLog` now opens the file `O_APPEND` —
  a handle writing at a remembered offset would have overwritten the daemon's
  lines.
- A lingering daemon never blocks a fresh one: the relaunched app finds the
  socket answering and attaches; a daemon whose socket file went stale is
  unlinked by the newcomer's `listen()` and exits at its own deadline with no
  clients.
- Tests (`daemon.test.ts`): bye-then-EOF shuts down at once; EOF-without-bye
  lingers and exits; a client attaching adopts the daemon and its bye is the
  quit; a stale bye does not count; a client attached at the deadline means
  staying up; the ack goes to the client that said bye and nobody else.

**Memory watch** (`engine.ts`): `node-2026-09-11-151650.ips` is a node process
that died of a V8 heap OOM (`node::OOMErrorHandler`), path masked — the daemon
or a test harness, unknown. `tick()` now logs `process.memoryUsage()` every five
minutes at info (`memory: rss 452 MB · heap 163 / 279 MB · external 40 MB ·
arrayBuffers 36 MB` at start, on this Mac) and, past 1.5 GB of heap, a warning
naming what the engine holds: transcript items and held items, delegations kept
and live, marks and captures in flight, open conversations, problems, close
timers. Screenshots are files under `shots/`, not buffers. No heap flags: a watch,
so the next OOM is read against a trend.

### Measured

- Dev binary, `JARHEAD_CRASH_TEST=signal`: exit 139, report written (SIGSEGV,
  fault address 0x10, 8 ring lines, 13 frames), one relaunched instance ~1 s
  after the death, the system `.ips` written 55 s later. `=exception`: exit 134,
  report with `then: signal SIGABRT (6)`, one relaunch, `.ips` with
  `lastExceptionBacktrace`. Four crashes in a row: `1 of 3`, `2 of 3`, `3 of 3`,
  then `relaunch: no — 4 crashes in 10 minutes` and no new process. The
  relaunched run's ring carries `the previous run crashed` — the notice path.
- `jarheadd` under a fake app that drops its pipes without a bye
  (`JARHEAD_LINGER_MS=8000`): `the app's pipes are gone; appending to daemon.log
  directly` → `lingering 8 s` → `pnpm jarhead status` answers (phase, brain,
  hands, 64 agents) → `a client attached; staying up` → `the last client left an
  orphaned daemon; lingering 8 s` → `nobody came back in 8 s, shutting down`,
  socket file gone. With a bye: exit 0 in 60 ms.
- Dev app + scratch daemon, SIGTERM (⌘Q's path): `client said bye` → `[app] bye
  acknowledged by the daemon (clean quit)` → `stdin closed, shutting down` →
  `[app] daemon exited (0)`; the app is gone in 0.9 s.

### Rules that came out of this

- AVFoundation throws ObjC exceptions Swift cannot catch — every `installTap`,
  `connect`, `reset`, `prepare` and format read goes through `JHTry`.
- Levels are untrusted numbers — clamp at the source, and treat every number on
  the render path (levels, springs, eased progress, alphas, rects, font sizes,
  `fraction:`) as untrusted.
- A crash handler is async-signal-safe or it is a second crash: allocate at
  install, format by hand, chain to the previous handler.
- A protocol "fire and forget" over a unix socket is not: a peer that closes
  while the server is still writing to it loses its own unread bytes. Ack, then close.
- The daemon's stdout is the app's pipe; when the app dies, so does the log
  unless the daemon re-homes it. `DaemonLog` is `O_APPEND` for that reason.

### Problems, typed (builder K3, 2026-09-12)

Kevin's ledger had 53 `problem` rows on the 10th and 25 on the 11th, and the top
eight classes were all things with one obvious fix that the row did not offer:
Accessibility / Full Disk Access / Screen Recording not granted (28 / 19 / 4),
the Claude Code brain not answering its probe (14), GPT-Live-1's
`response_input_buffer_full` (10), `context_injection_incomplete` (8), a Live
session that closed before it started (4), the hands helper stopped (6). The
dictation tools are ahead of Jarhead on exactly this — named failure states with a
one-tap remedy — so the engine now types every problem it raises.

`Engine.problem(text)` still exists (the daemon's "command failed", a settings
write; kind `other`); every other site calls **`problemOf(kind, text, remedy?)`**.
**`Snapshot.problems`** is the typed list (`Engine.typedProblems()`; the order and
the eight-line cap stay): each row's `kind`, its `text`, its `remedy` and `since`
(first seen, wall clock). Deduped by kind +
text: a line raised again while present keeps its place and its `since`; a fixed
problem clears itself at the site that knows (a grant appears, the helper greets,
the key answers, the voice reconnects). One `problem` ledger row per first sighting;
the elapsed-seconds refreshes below write none. The map:

| kind | raised by | remedy |
|---|---|---|
| `permission.accessibility` / `.screenRecording` | the helper's fresh read finds the grant missing | **Request** → `request-permission <kind>` (the helper prompts) |
| `permission.fullDiskAccess` | same | **Open pane** → `request-permission fullDiskAccess` (the app opens the pane) |
| `permission.microphone` | the app's read | **Open pane** → `request-permission microphone` |
| `permission.other` | Input Monitoring | **Request** (the app prompts) |
| `brain.unavailable` / `brain.probe` | a configured backend that would not start; the fallback swap; a key warning | **Retry** → `config.probe` |
| `voice.limit` | a Live error `classifyLiveError` calls `limit` (a rate limit, the 128-item / 32 768-token input history — caps that pass) | **Retry in 30 s**; the row clears itself after 30 s (`VOICE_LIMIT_CLEAR_MS`) |
| `voice.connection` | `expired` / `connection_lost` while reconnecting — the text counts "reconnecting for N s" from `tick()` until the session is back, and the counting row ends the moment the reconnect's own start fails (`endVoiceReconnect`), so the failed start's line stands — and a failed start whose message is a socket's | **Retry** → `go` |
| `voice.key` | no `OPENAI_API_KEY`; the key rejected; the model not listed for it; an exhausted quota (`insufficient_quota`, "check your plan and billing" — billing, not a limit: waiting fixes nothing, so it never auto-clears) | **Open Setup** → `jarhead://setup` |
| `hands.helper` | not built, failed, exited | **Restart helper** → `problem.retry hands.helper` (a fresh helper process; its greeting clears the row) |
| `disk.low` | the preflight below | **Reveal shots** → opens `<stateDir>/shots` |
| `dock` | the engine's read-only Dock audit (`readDock`, one `defaults export`, 20 s after start and after each fix): a pin with a recent Jarhead tile beside it, or two pins — "Two Jarhead tiles in the Dock" (§14, Learned since) | **Fix the Dock** → `problem.retry dock` (`repairDock`: import behind the mod-count check, `killall Dock`; a re-read clears the row) |
| `crash` | a report under `<stateDir>/crashes` younger than ten minutes (`reason:` line; one that says `survived:` is a note, not a crash) | **Details** → opens the file |
| `daemon` | the **app**, not the engine: no daemon answering for 3 s | **Restart daemon** → `daemon.restart`, routed to `DaemonProcess` while nothing is connected |

`classifyLiveError` (packages/live/src/session.ts) reads a Live error's
`code: message` or a start failure into `limit` / `connection` / `key` / `other`;
`context_injection_incomplete` — an append racing a close — is still not a problem.

**`problem.retry {kind}`** (`Engine.retryProblem`) re-runs that kind's check and lets
the row clear when it passes: the two helper kinds prompt again; the app-owned
permission kinds make the engine read fresh and closely for 90 s (the app's own
prompt or pane is the remedy button's other half); the brain kinds clear their rows,
`restartBrain`, `probeSetup`; `voice.connection` reconnects only when Jarhead should
be awake (`wantAwake`, no session, not paused) and otherwise just clears;
`voice.key` probes the key; `hands.helper` restarts the helper and re-greets;
`disk.low` measures again; `daemon`, `crash` and `other` are dismissed. The doctor
prints the running engine's typed problems as a `problems` group with the remedy in
"next steps" (`voice.key`, `daemon` and a denied microphone grade `fail`, the rest
`warn`), and grades a socket file nobody answers on.

**Disk preflight.** `checkDisk()` — `fs.statfsSync` on the state dir, `bavail ×
bsize` — runs at start, before every session opens (`connect`) and before **every**
mark capture (statfs is microseconds; a disk that fills mid-session is caught at the
next shot, not the next connect); under **500 MB** (`DISK_LOW_BYTES`) it raises `disk.low` with the
figure (one row per kind, refreshed in place), skips the capture (the mark still
counts; the brain gets the region without the pixels, as with no eyes), and logs a
warning once; `tick()` measures again every 60 s while low and clears the row when
space returns. The session itself still opens: a full disk is a reason to stop
saving screenshots, not a reason to stop listening. The runner's own archive
(`packages/brain/src/runner.ts`, a rail) still writes; making it read the same
verdict is a one-line hook a rail edit has to carry — noted, not done here.

### Liveness (builder K3, 2026-09-12)

A daemon that exits is caught by `DaemonProcess` (respawn with backoff, `Lifeline`
for the app's side); a daemon that is alive on the socket and not answering — a
wedged event loop — was invisible: the app's client sat connected, commands queued,
and Kevin saw a blob that did nothing. Now:

- **Ping / pong on the wire.** `EngineClient` sends `{type:"ping", id}` every **2 s**
  while connected; `DaemonServer` answers `{type:"pong", id, at}` in `onFrame`,
  synchronously, with no engine work on the path (a late pong is the finding). Two
  pings unanswered — **4 s** of silence — and the client logs `daemon unresponsive:
  no pong for 4 s`, drops the connection (the reconnect loop takes over) and posts
  `EngineClient.daemonUnresponsiveNotification`; `DaemonProcess.kick` SIGKILLs the
  daemon it owns — its exit runs `handleExit` → `scheduleRestart` with the usual
  backoff, so a daemon that wedges on every start is not respawned hot — or, for a
  daemon it only attached to, kills the pid the hello gave and takes over on the
  next probe. One kick per 5 s. Both objects are the app's, so no AppDelegate wiring:
  a notification carries it. **The pid is never stale**: `EngineClient.daemonPid`
  lives exactly as long as the connection that hello'd it (cleared in
  `dropAndReconnect`), only the ping path — a live connection — names one, the
  "Restart daemon" remedy carries none, and `kick` asks `proc_pidpath` before
  signalling: a pid that is no longer a `node` (gone, or the number reused by one of
  Kevin's own processes) is logged and left alone.
- **The `daemon` row.** Disconnected for more than 3 s (a normal respawn is back in
  1–3 s and must not flash it), the client republishes the last snapshot with one
  typed problem on top — kind `daemon`, "Restart daemon" as its remedy
  (`daemon.restart`, which `EngineClient.send` hands to `DaemonProcess` while
  nothing is connected instead of queueing it for the daemon that has just come
  back). The daemon's next snapshot replaces the whole thing, row included.
- **Auto-resume after a respawn.** At a drop the client remembers whether the last
  snapshot had a session open (or opening) and whether this app sent `stop` or
  `pause` since it; on the reconnect it arms a 10 s window, and if the daemon's
  first snapshot inside it says asleep — no session, no pause — it sends **`go`
  once**. The engine side (`Engine.restoreFromLedger` at `start()`,
  `resumeFromLedger` in `connect`): the most recent session in the ledger, by its
  rows. A pressed `stop` inside it — Kevin ended it, nothing to pick up. A `pause`
  row — Kevin paused it: the new process **holds the pause again** (`pauseInfo`
  from the row, phase `paused`, the meter still stopped, the decay clock as it would
  have run; a pause past its decay is asleep), and his Go resumes with the
  continuity. No closed row (or one the engine would have reconnected from) and a
  last row inside 30 min — the process died mid-conversation: the first Go within
  **30 s** of `start()` opens the new session with a `# Continuity` section whose
  lines are the last ~12 `heard` / `said` rows **of that session from the ledger**
  (`recallFromLedger`; the new process never heard them), the last finished task's
  summary, and one instruction: say exactly one word, "back", then wait. The started
  row says `resumedFrom`, a `resume` row follows with the downtime as `pausedMs`, so
  the Console shows one conversation. Once per process; never after Kevin pressed
  Stop in the new one (`pressStop` disarms it); a Go outside the window is a plain
  wake. A paused conversation is deliberately **not** auto-resumed into an open
  session: Kevin paused to stop the meter, and a respawn is no reason to start it.
- **Once means once across respawns too.** Each respawn is a new engine process with
  no memory of the last resume, so "once per process" alone would let a daemon that
  dies soon after every resume run a loop of paid sessions each saying "back", at the
  backoff's cadence. Two guards. The app does not arm a `go` when it sent a resume
  `go` inside the last 5 min (`resumeCooldown`) or when this is the second drop
  inside 2 min (`dropLoopWindow`) — both logged as a loop. The engine
  (`restoreFromLedger`) declines when the latest session's started row says
  `resumedFrom` and its rows span less than 60 s (`RESUME_LOOP_SPAN_MS`): a resume
  that died young is a loop, not a conversation; a pause's resume (the parent has a
  `pause` row) is Kevin's own chain and exempt. After a declined resume the next Go
  is a plain wake.
- **Stop inside the reconnect window.** After `connection_lost` the session is
  detached and nothing is connecting for 500 ms; a Stop there used to write no row,
  and the next process saw a lost session. Now `pressStop` counts a pending reconnect
  as something that happened (the `stop` row is written, the counting row leaves),
  and because that row lands after the session's `closed` row — outside its span in
  `readSession` — `restoreFromLedger` asks the day's own rows (`stoppedAfter`) for a
  pressed stop at or after the close.
- Tests: `daemon.test.ts` (a pong per ping, same id, the daemon's clock, to the
  asking client only, no engine command), `problems.test.ts` (every kind and remedy
  above, the dedupe and the cap, the 30 s limit clear, the reconnect row's count and
  clear, a fake statvfs through a skipped capture and the 60 s re-check, the crash
  file, `retryProblem` per kind, the snapshot's typed `problems` and the
  `problem.retry` arm, a reconnect whose start fails, an exhausted quota as
  `voice.key`, a disk that fills mid-session), `transport.test.ts` (a second engine
  over the first one's state dir: the ledger continuity with "back", `resumedFrom`,
  once only; Kevin's Stop before the cut and in the new process; the window; the held
  pause and its decay; the loop guard over five engines — a resume that lived is
  resumed again, one that died young is not, a pause's resume is exempt; Stop inside
  the reconnect window). The Swift side compiles; the kill-and-respawn, the stale-pid
  guard and the app-side loop guards were reasoned from `DaemonProcess`'s existing
  exit path and `EngineClient`'s reconnect loop, not run against a wedged daemon.

## 17. What the field does, and what we took (2026-09-12)

Kevin, 2026-09-11: "it crashes a lot, be able to clean up conversations, make it
work a lot better … keep in mind that ours is better faster works like an actual
human would on your screen". Five research reports on 2026-09-12 read the field
for that sentence — the dictation tools (Wispr Flow, Superwhisper, Aqua Voice),
Grok's voice and Grok Bot, Hermes Agent and OpenClaw, Operator / ChatGPT agent /
Atlas, Anthropic's computer use and Claude in Chrome, Gemini Live, Apple's Siri AI
and Voice Control, Perplexity's Computer, Raycast, and the conversation-history
UX of nine products — and one synthesis ranked what to adopt, what to skip and what
never to lose. The latency numbers side by side are LATENCY.md §7. This section is
the ledger of the pass built on that reading: by item, what each product does that
Jarhead took, and what it deliberately did not.

### What the field is ahead on, and where it landed here

The dictation tools are ahead only on the boring parts, and the boring parts are
what crashes feel like. The agent products are behind on everything Kevin named as
ours — they pay 2–5 s per action on a cloud VM at about 50 % reliability — but two
of them have a policy UI worth reading. The contract for the whole pass is
`packages/protocol/src/index.ts` (mirrored in `Model/Protocol.swift`, the frames in
`packages/daemon/src/wire.ts`); each builder's own section says what landed behind
it. The rows marked *per the contract* (K1–K5) are written from that contract as
applied and checked against the worktree's named symbols on 2026-09-12 (`ping` /
`pong` in `server.ts`, the tombstone rows and `rename(2)` moves in `ledger.ts`,
`ear.hints` in `engine.ts`, `MicRanking` in `AudioEngine.swift`, the grants in
`policy.ts`, `evictShots` in `runner.ts`), not from those builders' final code —
the integrator corrects them from their notes. The K6 rows are the build record.

| product | what it does | what Jarhead took (item) |
|---|---|---|
| Hermes Agent `sessions archive / pin / rename / prune`, ChatGPT and Claude "Archive" | conversations are hidden, never destroyed; retention is a setting on *ended* sessions; pinned exempt | conversation.trashed / restored / archived / renamed / pinned as **tombstone rows** in today's ledger file; `ConversationState = active \| archived \| trashed`; `Settings.ledgerRetentionDays` (default 0 = never) and `shotsRetentionDays` (14); whole day files **move** by `rename(2)` into `<stateDir>/trash` and back (`ledger.trash-day` / `restore-day` / `sweep`, `Snapshot.trash {path, days, bytes}`); "Move to Trash", "Archive", "Restore" — never "Delete" (K1–K2, per the contract) |
| Claude Code `/clear` (saves the old conversation), ChatGPT "New chat" | a clear that keeps the record | `now.clear` / `now.restore` filter the Now view at snapshot output only; `conversation.new` is a close with a reason and a wake without continuity; the Live context and every naming gate untouched (K1, per the contract) |
| Hermes FTS5 `session_search` (~20 ms, no model call) | search the bodies, not only the titles | `ledger.search {id, query, limit}` → `ledger.hits`: a bounded, case-insensitive linear scan over the live day files (the walk's parsed cache, so a quiet day costs the stats; the trash is never read; 50 hits by default, 200 at most) (K2, per the contract) |
| Wispr Flow's error-message guide, Superwhisper's troubleshooting, Hermes' degraded-state issue #89737 | **named failure states with a one-tap remedy**; permissions re-checked on foreground; a "reset" button | `Snapshot.problems: Problem[] {kind, text, remedy?: {label, command?, open?}, since}` and `problem.retry {kind}` — the top eight problem classes from Kevin's own ledger (Accessibility 28, Full Disk Access 19, a brain that did not answer 14, Live's 128-item buffer 10, `context_injection_incomplete` 8 …) each with its remedy, shown in the Console (K3, per the contract) |
| Hermes gateway wedged-not-dead (#12438); Grok Bot's Recover / Update / Reset | a liveness signal, and recovery that keeps durable state | client `ping {id}` / server `pong {id, at}` on the wire, so a daemon that is alive but wedged is seen, not assumed (K3, per the contract) — on top of §16's crash guard and the daemon that lingers 90 s |
| Wispr / Superwhisper mic ranking with fallback, OpenClaw's "uses the system default while the chosen mic is away and retains the selection" | the microphone is a ranked list, not a pointer | mic ranking and a route-change observer in the app's audio layer (`MicRanking.rank`, `AVAudioEngineConfigurationChange`) (K4, per the contract) |
| Grok's `keyterms` / `language_hint`, Apple's `contextualStrings` | bias the recogniser toward what is on the screen | `ear.hints {strings}` from the engine to the app's on-device ear: app names, window titles, AX labels, agent names (K4, per the contract) |
| Grok Bot's approval card (Allow once / Always allow / Deny, Require-Approval beats Always-Allow), Claude in Chrome's per-site "Always allow" and its bugs (#74715: it did not stick), Operator's confirmations (−90 % nuisance errors, 92 % recall) | a remembered yes, scoped, with a hard list it can never cover | `grant {chainId, app, actionClass, until}`: a yes remembered **for this conversation, this app, this action class, until**; **never for a destructive verb** (send, pay, delete, post, purchase — those stay spoken-yes-once, `ConfirmationState`); the never-list unchanged (K5, per the contract) |
| Hermes' three-most-recent screenshots, Claude in Chrome's `read_page` refs, OpenClaw's `frameId` / `executionId` | do not keep every pixel; act on the frame you saw | the screenshot archive is capped and the oldest shots **move** into `<stateDir>/trash/shots` by rename, never unlinked (`runner.ts` `evictShots`; `Settings.shotsRetentionDays`, 14). A frame id or stale-frame guard was **not** built in this pass: the hands act through AX with the screenshot as the fallback and the verification, and nothing on the Codex thread references a frame (K5, per the contract; the eviction checked in the worktree) |
| Cowork's "Working on your computer · 0:42", Claude's red border, Perplexity's step list, Grok Bot's status line | a working state you can see, with elapsed time | **"Working · 0:12"** — a mono elapsed counter next to the phase word on the notch island (peek and open), alone on a black strip of the notch while the blob is out at its target, and under the phase word on the capsule; `Motion.base` in and out; gone at done or cancelled (K6, `NotchPanel.swift`, `OrbExpandedView.swift`) |
| Hermes' "emoji-mapped tool usage" praised, its per-click narration complained about; GPT-Live-1's over-eager backchannels (eesel 2026-09-11) | narrate the intent, not the keystrokes | the voice's `# Narration` rule — one short clause per state change ("found the invoice", "typing the amount"), never per click, never a tool's name, silence while a single step runs — and the same gate in the Delegator's relay (`Delegator.narrationVerdict`: per-click lines and lines naming a tool stay on the Console's timeline; the first action is voiced as it lands without the tool's name; the summary and a reflex's landing are never gated), plus one clause before idle sleep (`Delegator.announceSleep`: once per idle stretch, true when it spoke; the engine's tick arms one sleep deadline off that return and must not re-read its idle clock, since the clause is Jarhead's own speech and moves `lastAddressedAt` — that hook in `engine.ts` is the integrator's) (K6, `instructions.ts`, `delegator.ts`) |
| Hermes' context compression (Phase 1: tool results > 200 chars → placeholders, no model call; protected head and tail), OpenClaw's soft-trim (keep first/last 1 500 chars), Claude Code's compaction that "stops with a thrashing error instead of looping" | compress what a fresh context is told, and never thrash | the carried block after a Codex rollover is compacted (`renderCarry`): Kevin's words verbatim, every tool result over 200 chars or bytes (images included) one line naming its size ("[tool result, 3.1 KB]"), the block capped near 2 KB with the oldest exchanges dropped first; and one turn's measure rolls the thread over once (`TokenUsage.turnId`, `rolloverDue()`) so an oversized tool output cannot open a third thread (K6, `codex.ts`, `codex-app-server.ts`) |
| Wispr publishes a p99; nobody publishes a per-action clock | the headline is the tail, not the median | LATENCY.md §7: the field side by side with p95 as the headline column and "measured or claimed" on every row (K6) |

### What Jarhead deliberately skipped, and why

- **Turns that end on a key.** Every dictation tool ends the turn on key release
  or an explicit stop and none runs a semantic end-of-turn detector. Jarhead's
  turn is GPT-Live-1's: full duplex, interruptible, no key. The ear's grammar has
  its own windows (120 / 450 ms, REDESIGN §12); a key would make them slower.
- **The clipboard as transport.** Wispr, Superwhisper and Aqua paste; every one
  of them has a paste-failure article and a "Paste" fallback button, and Codex
  issue #11103 shows the clipboard racing other writers. Jarhead's hands type
  into the focused element through AX and CGEvent and read the field back; the
  clipboard stays Kevin's.
- **A cloud VM or a remote desktop.** Operator, ChatGPT agent, Mariner, Grok Bot
  and Perplexity's heavy tasks run elsewhere and pay 2–5 s per action for it.
  Jarhead's tools answer in 55 ms median on the real screen (LATENCY §3c).
- **Background driving through private SPIs.** Hermes' cua-driver injects
  pid-scoped events so "your cursor doesn't move"; Apple can change those SPIs
  and did change `CGDisplayCreateImage`. Kevin's cursor is the cursor; the blob
  flies to where it works so he sees it.
- **Personalities and companions.** Grok retired its companions in 2026-07 and
  reviewers called the thirteen personalities spectacle; this is a work tool with
  one voice.
- **A permission stack.** OpenClaw needs five layers to agree and then asks per
  action never; Claude in Chrome has modes, site rules, protected actions and a
  hard-ban list, and users file "Always allow does not stick". One table decides
  run / confirm / refuse (`policy.ts`); a grant is one scoped row on top of it and
  never reaches a destructive verb.
- **An independent reviewer model on every action.** Grok Bot's Auto Review and
  Claude in Chrome's classifier cost a model generation each; a generation is
  3.4 s here (LATENCY §3c). The policy is a table and answers in microseconds.
- **Confirm sheets and "Delete forever".** ChatGPT and Claude purge within 30
  days; Grok deletes at once with no window; Cowork lost weeks of history
  overnight (#45076). Jarhead never unlinks Kevin's data: rows are tombstoned,
  days move to the Trash by rename and come back, and "Empty Trash" does not
  exist in the app ("Reveal in Finder" does).
- **A 30-day safety copy.** There is nothing to copy when nothing is deleted.
- **An always-on ungated microphone.** Apple's Voice Control listens all the
  time with no gate; Wispr has no wake word by design. Jarhead's wake word is
  on-device and behind Touch ID or the passphrase before a paid session opens.
- **Pixels-only grounding.** Perplexity's browser control and Operator read
  screenshots; Siri AI reads "exactly what's in the pixels" unless an app
  annotates its views. Jarhead is AX-first (`click_element`, `find_element`,
  `read_focused_text`) with the screenshot as the fallback and the verification.
- **A chained STT → LLM → TTS voice.** Hermes' CLI waits 3.0 s of silence and
  then 1–2 s of TTS; OpenClaw's Talk mode 700 ms plus the model. GPT-Live-1 is
  one model that listens while it speaks.
- **Streaming raw words into the field.** Aqua Realtime and Superwhisper stream
  unpolished words and skip the cleanup. A reflex types verified text once, and
  a `type` whose words differ from what Kevin said is undone (REDESIGN §12).
- **Cloud-synced history.** ChatGPT's history survives a reinstall because it is
  server-side; Kevin's is `~/.jarhead/ledger/*.jsonl`, his, append-only, greppable.
- **A hidden-window "background mode".** Claude Code hides other apps while it
  works and ChatGPT's Computer Use runs scoped tasks behind you; both are
  documented as slower than a direct integration and neither says how it avoids
  the wrong window. The blob at the cursor is the guard against the wrong window.

### The edge, kept

Full duplex by construction; the 250 ms reflex path as a second source, not a
faster model; AX-first native hands on the real screen with verification; the
wake word behind Touch ID; one policy table with a spoken yes once for the
destructive verbs; the Console that steps into every coding-agent session. Every
item above was built under those, and none of them moved.

### Status words (added by the durability pass, 2026-09-12)

The rows above that speak of a "working state you can see" and of sessions being
*ended* rather than deleted now have one vocabulary behind them. An agent session
is `working` only under a lease — a live owner process, a turn-bearing write within
30 s, no closing marker — `idle` when the process lives and the lease lapsed,
`blocked` on an open permission question, `done` when archived or when a run
finished and closed, **`ended`** when no process owns it (however old: a session
with no process is over, not "unknown for six hours"), `unknown` only when the
process evidence itself was missing (a degraded `ps` / `lsof`), `offline` when a
run handle closed. `AgentInfo.hint` (archived · blocked · running · quiet · ended ·
unseen · resumed) says why; `detail` carries no relative time any more, so nothing
churns a snapshot a second. A tool call left without a result when its session
ended reads `interrupted` — the titanium word, no pulse. The same seven words are
on `jarhead status`, in the brain's `agents_list` / `agent_wait` text, in
`waitSettled` (ended settles) and in the Sessions rail's grouping.

## 18. Threads and Sleep (2026-09-12)

Kevin, verbatim: "also support capabilities to do multiple things at the same
time, be able to spin up subagents or however you can figure out how to support
this: to not only use slack and send slack messages but also click through
spotify at the same time for example." And: "also if you tell it to go to sleep or
shut off or things like that those are all cues to return to dock and go to
sleep" — "dock" being the notch home the blob tucks into. The standard both were
built to: better, faster, and like an actual human at the screen. One short spoken
line when work splits, one when a thread finishes; spawned threads never narrate;
reflexes stay under 2 s and the brain's first action near 4 s.

### Threads, not agents

*Agents* (`agents_*`, the Sessions rail; their statuses are `AgentStatus` — idle ·
working · blocked · done · ended · unknown · offline, §17 "Status words") are
Kevin's coding sessions. A **thread** is the brain's second pair of hands: a line of
work with its own brain, conversation, lane, budget and blob. Its shape, statuses,
caps and the engine's table are §20; this section is the lanes, the lease and the
desk it runs under. The tools, appended after `AGENT_SPECS` (`ALL_TOOL_SPECS.length`
67): `thread_start {name, task, lane? (default background), budget?: {steps 1..40,
seconds 10..300}}`, `thread_wait {name | "all", timeout? 1..240 (120)}`,
`thread_read {name}`, `thread_stop {name}`. Budgets default 25 steps / 180 s,
capped at 40 / 300 (the delegation's wall clock); a hung thread is cut at its cap.
`thread_*` and `self_*` are denied to spawned threads (depth 1).

A spawned thread's brain is a second `CodexBrain` over its lane runner
(`ThreadBrainSpec { runner, threadId, secondsCap }` in
`packages/engine/src/threads/scheduler.ts`: `new CodexBrain({ ...mainOpts, runner,
thread: id, primeThreads: false, maxWallMs: secondsCap })`), its MCP bridge started
with `JARHEAD_THREAD=<t_…>` so every `tool.run` frame carries `thread` and the
daemon routes it to `engine.runnerFor(threadId)` — a malformed or unknown id is
refused, never handed to main's runner, which holds the pointer. The `BrainPool`
(§20) keeps warm spare `codex app-server` processes (thread/start only, no primer,
no model request) so a split does not pay the 3.4 s boot. Other brain kinds run a
second instance over the lane runner; `openai-responses` cannot (no thread of its
own) and `thread_start` says so. The thread's `BrainTask.request` and
`kevinDialogue` are the PARENT's — Kevin's words — and the brief rides in the
dialogue, so `runner.ts`'s `namedPaths` / `classifyUrl` reads see what Kevin said,
not a paraphrase. Its steps land on its own `Delegation` (`Delegation.threadId`); a
step it ran on its parent's timeline carries `step.thread = name`; `thread.started`
/ `thread.status` / `thread.ended` rows record each change.

**The background lane never touches the pointer.** `FOCUS_TOOLS` = the acting
members ∪ {open_url, browser_click, browser_type, clipboard_read, clipboard_write}
∪ applescript matching `keystroke | key code | click | set value | perform action |
activate | open location | reopen | set frontmost` ∪ `run_shell` whose head is
`open` (without -g/-j) or `osascript`. A background thread calling one gets
"refused: this hand runs in the background lane — the pointer and keyboard are not
its; use applescript (Apple events), browser_*, files, shell or web, or report that
the screen is needed" — from the runner, so `policy.ts` is untouched. Spotify plays
by Apple event without the pointer moving; Slack, which needs typing, is the main
brain's or a screen thread's.

**Two helper processes, one binary.** `HandsPool { focus, background }`
(`packages/hands/src/pool.ts`), same daemon parent so the same TCC identity, both
spawned with `SECRET_KEYS` stripped. Screen-lane actors (main brain, dictation,
screen threads) use `focus`; background threads and the engine's own reads (the AX
warm tick, ear hints, `circleUnderCursor`, the wake shot) use `background`, so a
background hand's screenshot never queues behind a `type`. `cancelAll` cancels
both (SIGURG only to the child with a pending type); grant restarts restart both.

**The lease.** `FocusLease` (`packages/hands/src/lease.ts`) is the one holder of
pointer, keyboard and frontmost. Hand-over only at the holder's turn end, a confirm
question, or `LEASE_IDLE_MS` 3000 without an acting call; a priority taker (main
brain, dictation) waits `MIN_HOLD_MS` 1500 and never cuts mid-op, then `SETTLE_MS`
300 to re-front its remembered app (`focus_app` + a `frontmost` poll); among
threads the lease's `rank` orders takers (Kevin's hands > main > threads by age,
§20). A thread's tool waits at most `WAIT_MAX_MS` 8000 and returns "waiting for the
screen: <reason>" (status waiting-screen); three consecutive waits fail the thread.
STALE_FOCUS: a front app no lane activated that differs from the thread's
remembered app means Kevin switched — the thread is never refocused behind him.
Jarhead's own hands acquire with priority and never wait on a thread's idle or on
Kevin's typing beyond the helper's own busy retry.

**Kevin's hands win, in the helper, atomically.** Both checks live in `Input.swift`
before the first `CGEvent.post`: `busy` — the helper tracks `lastOwnPostAt` for
every event it posts and reads `CGEventSource.secondsSinceLastEventType` for
keyDown / mouseDown / rightMouseDown / scrollWheel (not mouseMoved); a most-recent
event that is not its own and within 1500 ms → `{ok:false, error:{code:"busy",
message:"Kevin used the keyboard/mouse <n> ms ago; nothing was posted"}}`
(dictation passes `ownDriver:true`); `expectFront {pid}` on click / mouse_down /
mouse_up / drag / scroll / type / key / hold_key — the frontmost pid read
immediately before the first post and every ~50 ms inside the type loop; a
mismatch → `focus_moved` with nothing posted, or for type `{cancelled:true,
reason:"focus_moved", characters:N}`. The toolset passes `expectFront` from the
gate's own `frontmost` probe in the dispatch cases only. New op `user_idle {}` →
`{keyMs, clickMs, scrollMs, moveMs, foreignMs}`. Kevin clicking Mail during a
screen thread's Slack step lands nothing in Mail — the thread waits and reports.

**The desk.** The engine's root `ConfirmationState` stays; every toolset — the main
lane too — gets `desk.lane(id, name)`, a `LaneConfirmationState` whose `ask` posts
to the root when the floor is free or queues (`{id:"queued_<n>"}`, "Queued behind
<Floor>'s question: … Kevin will be asked after that one; stop and wait
(thread_wait), do not retry"); `consume` is true only for the floor's lane, then
`desk.promote()` re-asks the next queued question on the root and it is SPOKEN with
its thread's name ("Spotify asks: …"); grants, arm, clear, dropQuestion and the
conversation bounds forward to the root; `dropQuestion()` / `clear()` drop floor
and queue. Destructive verbs ask every time in every lane; grants stay per
conversation. `toolset.ts`'s `ConfirmationState` / `YES_PATTERN` hunk is not edited.

**The Delegator gets a `draining` slot.** A delegation whose brain finished with
live threads becomes `draining`; `active = running ?? draining`. A new request while
the main brain runs cancels only that turn and parks the parent as draining
("Kevin asked something else; the threads carry on"); only the cut verbs stop
spawned threads, whose per-turn AbortControllers belong to the scheduler. Order in
`onDelegation`: (a) the sleep cue → `onSleep(phrase)`, finish done, return; (b) a
yes for a thread (`YES_PATTERN` on the last utterance and `threads.floorThread()`
names a spawned thread → `arm(record)`, `threads.resume(threadId)`, finish done
"relayed the yes to <Name>"; the running main turn is NOT superseded); (c) today's
refuse / supersede / reflex path. Live stays open while a thread runs; the
idle-sleep guard is `!delegator.active` and no live spawned thread
(`table.liveCount()`); `earHeld` holds while the main brain's turn runs or the lease
is held — not while only background threads drain.

**Speech.** Spawned threads never narrate; their thinking and commentary are steps
on their own conversation, and one budgeted `speak_progress` each. Jarhead says the
split line ONCE per delegation at the first `thread_start` — "<Name> alongside."
(`ThreadVoice.splitLine`; `say(text, false)`, marks voicedTool) — then per thread
"<Name>: <summary ≤80>", "<Name> failed: <reason ≤80>" or "<Name> stopped.", and a
promoted question as "<Name> asks: <question>", all through the parent's
`queueCommentary` (600 ms coalescer: two threads finishing together are one
sentence) via `ThreadVoice.threadSay`, which bypasses `say`'s running-id guard for a
running OR draining parent. The Codex addendum carries one cheat-sheet line for the
four tools (a named rail); the voice's `DEFAULT_CAPABILITIES` carries one line saying
the backend can split independent work across threads and how each lane behaves.

**Console.** The Threads section (§20) lists each live spawned thread under its
parent's card with a 22 pt ghost Stop per row → `thread.stop {threadId}`, never the
transport's Stop; an hourglass for waiting-screen, a hand for waiting-kevin; one
chip per spawned thread under the timeline, a `[Name]` mono chip on a step from
`step.thread`, `person.2.fill` system lines for thread rows. `pnpm jarhead status`
prints `threads N (M live)` with a row each; `pnpm jarhead cmd thread.stop
<id|name>` stops one.

### Sleep: one grammar, three entries, one closer

`SleepCause = said | idle | pause-decayed | brain-changed | dock | command | stop |
shutdown`; `EngineCommand { type: "sleep", cause?, phrase? }` (the app's
`dropIntoDock` sends `cause: "dock"`; `pnpm jarhead cmd sleep [cause]`);
`LedgerRow { type: "sleep", cause, phrase?, sessionId?, farewell? }` written before
the close; the Console's tombstone reads "asleep · <cause words>" with the phrase,
`closeReason` knows `sleep:<cause>`.

**The grammar** is `SLEEP` in `reflex.ts` as `ReflexKind "sleep"`, checked right
after the dictation rows and BEFORE `OPEN` (today "go to sleep" became `open_app
Sleep` and "go to bed" `open_app Bed`), anchored `^…$` over `normalizeUtterance`
output (a leading or trailing "jarhead" / "hey jarhead" / "please" / "thanks" is
stripped there): `go (back) to sleep|bed`, `back to sleep`, `sleep now`, `shut
off`, `shut yourself off|down`, `turn yourself off`, `power down|off`, `good
night`, `night night`, `that's|that is|that will be|that'll be all (for
now|today|tonight)`, `that's it for now|today|tonight`, `(you're) dismissed`, `you
can|may rest (now)`, `stand down`, `go dormant`. Bare "shut down", "sleep",
"night" and "stop" are NOT cues; "turn off the lights", "shut down my Mac", "put
the display to sleep" and "sleep timer for spotify" are tasks; "don't go to sleep"
and "is that all" are negations the anchoring excludes. `parseReflex` yields `{
kind:"sleep", tool:"sleep", input:{phrase}, said:"night.", label:"go to sleep",
prefire:false, idempotent:true }` and `ReflexRunner.match` returns undefined for
it — it never runs as a tool. `reflex-grammar.test.ts` pins the positive and
negative tables.

**Three entries.** The ear (`engine/ear.ts`) checks it after STOP_WORDS and before
the hold, fires at once on a final/terminal utterance and otherwise after the
450 ms careful window, and ONLY when `addressesJarhead(candidate)` or the engine is
in an exchange (`lastAddressedAt` within 8 s) — a "goodnight" to someone in the
room never sleeps it, and Jarhead's own "going to sleep" idle clause never fires
it. The Delegator's `onSleep` covers Live's delegation path (the voice's attention
gate is the addressing test there), checked before supersede / refuse / reflex, so
the cue works with reflexes off. The command `sleep {cause}` is the third.

**One closer.** `Engine.fallAsleep(cause, {phrase?, farewell?})` is idempotent and
the ONLY way the engine goes to sleep: `sleep` row (before detach) →
`cutEverything` (both helpers, the lease, every thread with its brain's `cancel()`
once, the confirmations) → if `farewell` and the session is started, not gated,
and the voice has not said "night" within 2 s: `appendInstructions(null,
FAREWELL_LINE)` — `'Kevin dismissed you. Say exactly one word — "night." — and
nothing else.'` — and wait for the first output delta + 300 ms quiet, cap 1800 ms
→ `detachLive` + `closeWithDeadline(live, "sleep:<cause>")` → phase asleep → toast
→ `threads.stopAll()`. For non-farewell causes the phase flips synchronously before
the first await (pressStop needs that). Rewired callers: `sleep()` →
`fallAsleep("command")`; the idle tick → `idle`; pause decay → `pause-decayed`; a
brain swap → `brain-changed`; `Engine.stop()` → `shutdown`; `pressStop` keeps its
bookkeeping and `stop` row then `fallAsleep("stop")` with no farewell; the app's
`dropIntoDock` sends `.sleepCause("dock")`. The orb needs nothing else: asleep
already converges on `goHomeForTransition()` — the blob tucks into the notch on the
last syllable of "night."

**The voice rail** (`packages/live/src/instructions.ts`, a named rail edited on
Kevin's request): a `# Sleep` section — on a dismissal addressed to you (go to
sleep, shut off, goodnight, that's all, power down, dismissed) say exactly "night."
and nothing else, then delegate his words unchanged; never for "stop" / "cancel"
(the interrupt); never for "turn off the lights" / "shut down my Mac" (tasks) — and
the one capability line above. `instructions.test.ts` pins the section, the cues,
the exclusions, the section order and the ≤ 1100-word budget (1085 with the
always-on gate).

**What Kevin hears.** "tell Ben on Slack I'm late and play Focus on Spotify" → one
split line within ~4 s, Spotify plays by Apple event with the pointer still, Slack
typed only with Slack in front, one spoken Send question, "yes" sends once, the
summary does not repeat Spotify. "stop" mid-split ends everything within a frame
with the meter still running. "goodnight" → "night." → the meter stops within 2 s
→ the blob tucks. "Jarhead" wakes it as before.

**Rails touched, by name:** the voice instructions (`instructions.ts`), the Codex
addendum (`codexAddendum` in `codex.ts`, one cheat-sheet line), app signing
(`scripts/build-mac.ts`, the install hunk matches the rail's regex; the signing
lines are byte-identical). Not touched: `policy.ts`, `core/index.ts`, `brain.ts`,
`brain/index.ts`, `runner.ts` (subclassed only), the `ConfirmationState` /
`YES_PATTERN` / gate hunk of `toolset.ts`, `Wake/**`, `shell.ts`, `files.ts`,
`SECRET_KEYS`, NotchPanel's working string.

## 19. Memory: a durable, editable, budgeted record of Kevin; and English by default (2026-09-12)

Kevin, verbatim: "also make sure long horizon durability is a lot better, make sure
each thing is open and conversation threads dont break after a whiel … also build
up a durable memory of the user using all the best most modern memory procedures
and embedding methods to save on tokens and so on ad create a whole dedicated
module for this so jarhead preferences save across sessions. also be able to have
an english voice and use that on default". Three requests; this section is the
memory one and the English one. Durability's status words are §17 above; its file
and app work is in the agents package and the Console (`liveness.ts`, `readBackward`,
per-viewer opens, the 400-message front-trim, the derived `isLive`).

### What existed, and why a module

Nothing about Kevin survived a daemon. `remember` / `recall` wrote to an in-process
array no prompt ever read; each brain kept three request/answer pairs of text and
emptied them at every `stop()`; Continuity carried twelve lines of the *same*
conversation across a pause. Everything he ever said was on disk, append-only, in
the ledger — unread. A memory in `packages/core` would have made every core file a
rail (`selfedit.ts` CORE_ORDINARY), so it is its own package, **`@jarhead/memory`**
(`packages/memory`, deps core + protocol, no new npm dependency), and its
vocabulary is the protocol's: `MemoryKind` (preference · fact · episode · procedure
· contact · place), `MemoryState` (live · forgotten · merged · archived — *nothing
is ever deleted*), `MemoryOrigin` (extracted · kevin · tool), `MemoryItem`,
`MemorySummary`, `BRAIN_MEMORY_TOKENS` 250, `VOICE_MEMORY_TOKENS` 120,
`Snapshot.memory`, `Settings.memory` (default on), the `memory.*` commands and the
id-only `memory.*` ledger rows.

### The store

`<stateDir>/memory/memory.jsonl` — one row per event (add · update with `prev.text`
· touch · forget · restore · merge · archive · watermark · consolidated), never
rewritten, never truncated; `embeddings.jsonl`, a cache keyed by `sha256(text)`
(vectors never ride the wire); `index.json`, a rebuildable cache — rows first, then
the index, so a crash between the two is fixed by replay and a corrupt index is
never an error. Forget is a tombstone plus a ten-minute exclusion window so the
next run cannot re-learn it; Restore flips it back; `LIVE_CAP` 2000 archives the
lowest-scored episodes, still listed and restorable.

### When it learns (never on the voice loop, never while a session is open)

Extraction runs from the engine's quiet tick only when `!live && !connecting &&
!pauseInfo`, only for a CLOSED conversation with ≥ `MIN_NEW_KEVIN_LINES` 4 new
Kevin lines past its watermark, once per conversation — a second run over the same
rows is all NOOP; on a 28-close day like 09-11 that is ≤ 5 runs, not 28. The
extractor is one Responses call on Kevin's OpenAI key (strict `json_schema`,
`store:false`, `max_output_tokens` 900, 20 s, one retry) — dollars, never the
ChatGPT plan, never Codex (each Codex turn costs the plan and would pollute the
resident thread's carry). Its model is `JARHEAD_MEMORY_MODEL`, else the module's
`DEFAULT_MEMORY_MODEL` (a mini-class id); the doctor's free `GET /v1/models` checks
that id against the key and names the key's best `*-mini` to pin — nothing records a
pick on its own (pinning is `JARHEAD_MEMORY_MODEL` in `~/.jarhead/env`, Kevin's);
no key or a non-JSON reply → one warning and the `RulesExtractor` (regexes over
Kevin's lines: "call me Kev" → fact, "from now on …" → procedure, "speak in
English" → preference). An embedding failure DEFERS the run (≤ 3 tries) rather than
mixing vector spaces; with no key the `KeywordEmbedder` is text-based at query
time and items without a vector are scored by keyword similarity only. With
`Settings.brain === "local"` memory follows the setting, not the running brain:
the extractor and decider are `ChatExtractor` — the brain model over Chat
Completions JSON mode at the local server — and matching is `LocalEmbedder` over
the first of `EMBED_PREFERENCE` (embeddinggemma → nomic-embed-text →
mxbai-embed-large → qwen3-embedding → all-minilm) the server lists as `embedding`
(`POST /api/embed` on Ollama, `/v1/embeddings` on LM Studio and llama.cpp), else
`KeywordEmbedder`; the OpenAI branch is skipped even with a key, so item text and
closed conversations never leave for memory. A brain change `relink()`s the
service and a `reembed()` sweep at quiet ticks moves the store into the new vector
space in minutes; `MemorySummary.embeddings` reads `local`, `embeddingModel` and
`embeddingDims` say which, and the `memory.run` row's `extractor` reads `local`.

Merge: candidates → embed (one call per run) → the three nearest live items. With
per-embedder thresholds `{update, band, dup}` — openai 0.90 / 0.75 / 0.93, keyword
0.60 / 0.40 / 0.70 — at or above `update`: equal normalised texts → touch (seen
count, last seen, confidence up); different texts → the decider (a reversal,
"prefers light mode" over "prefers dark mode", is never a silent touch; in rules
mode newest wins and `prev.text` is kept); in the band → the decider (ADD · UPDATE
· NOOP, a contradiction makes the newer supersede and marks the older `merged`
with `mergedInto`); below → ADD. Consolidation on a quiet tick: near-duplicates
merge, low-importance once-seen episodes older than 90 d archive.

### What it says, and where (two injection points, both outside the standing orders)

`score = cosine × recency × importance × confidence × seen`, recency a half-life
per kind (episode 30 d, fact 180 d, contact / place 365 d, preference / procedure
none), a pinned lane (high-importance preferences and procedures, ≤ 40 % of the
budget), then MMR λ 0.7 until the budget is spent; `estimateTokens = ceil(chars /
3.2)`, the appender's convention.

- **The brain**, per delegation: `BrainTask.memory?: string` — the ONE optional
  field this pass added to the rail `brain.ts` (Kevin named the module; no prompt
  text, no `SYSTEM_PROMPT_VERSION` bump) — rendered by `promptParts` in
  `anthropic.ts`, the one render site every brain kind's user turn goes through
  (Anthropic, Claude Code, Codex exec and warm turns, openai-compatible), as its
  own part after `Recent conversation` and before the reflex notes: `What you know
  about Kevin (durable memory; use it, do not repeat it back, do not say you
  remembered):` then the items, ≤ 250 tokens as the renderer cut them. It is never
  in `kevinDialogue`: the gates that ask "did Kevin name it?" must not read a
  remembered line as his words today. The delegator asks
  `DelegatorOptions.memory(query, signal)` with the request plus Kevin's recent
  lines, inside the same `Promise.all` as the marks and the eyes' shot, cut at
  `MEMORY_RECALL_MS` 250 with the signal aborted (a cold lookup is dropped, the
  task carries no block); Kevin's final heard lines are embedded as they land, so
  the query is a cache hit and the cut almost never engages — `jarhead bench` must
  hold delegation → first action within ±50 ms. **Blind spot:** with the
  `openai-responses` brain Live runs the backend itself, so this part never
  reaches it; only the voice block does.
- **The voice**, per session start: `# Kevin, in brief` … `Use this quietly; never
  announce that you remember it.` (≤ 120 tokens, no `*`, no backtick), assembled
  in the engine's `sessionConfig` between `# Language` and `# Continuity` — never
  inside `buildLiveInstructions` (a rail with 25 words of headroom). An engine
  test pins the order: `# Personality` in the base < `# Language` < `# Kevin, in
  brief` < `# Continuity`.

**Honest cost.** The budgets CAP what memory costs a prompt: ≤ 250 tokens per
delegation on the brain (≈ 20k tokens a day at 81 delegations — the Codex plan's
quota, or ≈ $0.06 on the Anthropic API), ≤ 120 per session start on the voice
($0: Live bills per second; ~1 % of context). Nothing existing shrinks. The saving
is Kevin never re-explaining a preference aloud (twenty seconds of Live ≈ $0.017
plus the Codex turn it triggers) and never having a transcript dumped into a
prompt. The extractor is ≤ 5 runs × (≤ 8k in + 0.9k out) a day on a mini-class
model — cents; embeddings ≈ 10k tokens a day, fractions of a cent. If Kevin ever
wants net-zero, the trims are Continuity 1200 → 800 chars and the dialogue window
120 → 90 s; not taken in this pass.

### Privacy

Redact-then-drop: every candidate line passes the runner's public `redactor`
(known secret values and every key shape) and a line that changed is DROPPED, not
masked; then memory's own shapes — a Luhn-valid card, an SSN, "my password is …",
a secret path or env name the policy knows — refuse the line or the candidate.
Evidence must cite a Kevin line (Jarhead's guesses never become facts about him).
Never a source: `grant` rows, `delegation.step` payloads, the confirmation
question and its short answer, rows before a `now.cleared` (unless restored),
trashed chains, rows inside a forget window. Ledger audit rows carry IDS ONLY —
`memory.added {id, kind, origin}`, `memory.updated {id}`, `memory.forgotten {id,
by}`, `memory.restored {id}`, `memory.run {…counts, ms}` — so a forgotten item's
words live in one place, the store; no vector ever appears in a snapshot or a
`memory.items` answer. Item text goes to OpenAI for embedding when a key is present
(the vendor that already hears the whole conversation); with no key nothing leaves
the Mac. `Settings.memory` off = no extraction, no injection, no embedding calls,
no ledger rows; the store stays as it is.

### Surfaces

Spoken: "remember that I prefer dark mode" → one preference, origin `kevin`,
toast *remembered*; "forget that" → every item sourced in the last ten minutes
tombstoned, the exclusion written, toast *forgot 2 memories* — both in the
engine's heard hook, no brain, no tool (`remember` / `recall` stay per-session
notes and their description says so). Console: Settings › Memory (Remember
toggle, matching mode, counts, *Learn now*, the hint "Forget hides it from
Jarhead; Jarhead's own record keeps it (nothing is deleted)"), a `MemoryRailView`
(search, Live | Forgotten | Archived, Edit / Forget / Restore — never "Delete"),
and the Now rail's "Memory · used this turn" from `lastUsedIds` — the one lever
against a misheard "fact" steering the voice. CLI: `jarhead memory [list]
[--state …] [--limit N]` · `search "…"` · `forget <id>` · `restore <id>` · `add
"…" [--kind k]` · `run`, over the daemon (`memory.list` / `memory.search` frames
answered by `memory.items`; the verbs are EngineCommands whose toasts say what
happened); a bad id (`m_…`) or an unknown state/kind is refused before a socket
is opened. Doctor: a `memory` group — counts and the last learn from the running
daemon (the store's row count without one), the matching mode, and the `extractor`
row — the id the engine WILL run (`JARHEAD_MEMORY_MODEL`, else the module's default)
checked against the keys row's one free `GET /v1/models` (not listed → a warning:
every run falls to rules), the key's best `*-mini` named only as the thing to pin;
rules without a key; no extractor row when memory is off; never a session, never
the extractor.
`jarhead status` prints a `memory` line (counts, last learn, tokens the last
prompts spent against the caps) and the agents by status.

### English by default (the Language section)

`cedar` is a timbre, not a language; nothing in `SessionConfig` or the orders said
English, and with the always-on gate a non-English utterance in the room could flip
the reply. The fix is engine-assembled, not a rail: `packages/live/src/language.ts`
exports `languageName(tag?)` and `languageSection(user, language?, accent?)` =
`# Language` / `Speak English, American accent, whatever language you hear; if
Kevin speaks another language, answer in English unless he asks you to switch.`
("British accent" for british; the accent words drop for none), and
`sessionConfig.instructions = [base, languageSection, memoryVoiceBlock,
continuity].filter(Boolean).join("\n\n")`. `Settings.language` "en" and
`Settings.accent` "american" default through the `DEFAULT_SETTINGS` spread (an old
settings.json needs no migration); `VOICES` (22, `as const`, type-equal to
`BuiltInVoice`) and `ACCENTS` live in protocol; `SessionInfo.voice` / `accent`
reach the Console and `jarhead status`. A pick while awake toasts "heard at the
next wake" (`session.update` cannot change a voice); `voice.reopen` — Kevin's press
only — is `pause()` then `resume()` with the "reconnected" Continuity, refused
while a delegation or a thread runs, while paused, asleep or connecting. The wake
recognizer's locale (`Wake/**`) is a rail Kevin has not named and is untouched. If
he later says "voice instructions", the section moves inside `buildLiveInstructions`
at position 2 and Narration loses eight words.

**Rails touched, by name:** `brain.ts` — `BrainTask.memory?: string`, one optional
field, one doc line. Not touched: `instructions.ts` (Language is engine-assembled),
`policy.ts`, `core/index.ts` (`ledger.ts` and `env.ts` are CORE_ORDINARY),
`runner.ts`, `shell.ts`, the handshake hunk of `toolset.ts`, `brain/index.ts`,
`Wake/**`, `SECRET_KEYS`, `build-mac.ts`, `selfedit.ts`, `Engine.stop()`.

**Not built, on purpose:** an on-disk session index (warm scans are 2–52 ms), a
twelve-hour "held conversation" (an open question for Kevin; the ten-minute pause
decay stands), mid-conversation extraction (the spoken reflex covers the
immediate case), memory tools for the brain (the engine hook does it without a
rail), health facts (the prompt excludes them; an opt-in kind later).

## 20. Threads, satellites, messages — and the face (2026-09-13)

Kevin asked to see his independent threads and their conversations, and, verbatim:
"there can be multiple blobs donig their own work. doing multiple things at once should be
proper. same with messages working actually properly. and these multiple threads should be
fast and just as feature rich as if it were the main thread, we want jarhead to be able to
do a bunch of things at once easily and know when and be able to keep track of those using
extremely performant data structure representations of tasks and paradigms and full
context and make it faster and tool use and responses so much faster. and make the logo a
jarhead like face you know so its more thematic."

### Threads

A **Thread** is a line of work with its own brain, conversation, lane, budget and blob.
`main` is the voice's own thread (`MAIN_THREAD_ID`); spawned threads are `t_…`, on a
`screen` or `background` lane. One status vocabulary everywhere: `idle · queued · starting ·
thinking · acting · waiting-screen · waiting-kevin · paused · done · failed · stopped`
(`THREAD_STATUSES`; the Swift mirror is `WorkThread` / `ThreadStatus`, unknown → thinking).
`THREAD_MAX_LIVE` 4 (main + 3), depth 1, names ≤ 16, budgets 25 steps / 180 s (caps 40 / 300)
per turn, `THREAD_LINGER_MS` 30 s in the snapshot, `THREADS_MAX` 16 summaries.
`Settings.threads` is the on/off flag. Day files from before 2026-09-13 hold `worker` rows and steps keyed `worker`;
every reader falls through on a type or key it does not know and never checks `row.type`
exhaustively, so those rows are skipped, not decoded.

The engine keeps ONE table (`packages/engine/src/threads/table.ts`): Maps by id, live name
and app, a live set in age order, a status count vector, an event ring of 512 with a
monotonic `seq`, `tick()` flipping acting→thinking after 4 s without a step, and
`statusLine(name?)` — deterministic English the voice speaks with zero generations ("Spotify:
on step 4 — applescript play, 9 seconds in."). Every read is O(1); the whole table is
≈ 100 KB. It rebuilds from the ledger's `thread.*` rows at daemon start; a thread still live
in a rebuilt table gets one `thread.ended {failed, "the daemon restarted"}` row and nothing
acts. The scheduler (`threads/scheduler.ts`) owns spawned threads' turns: their own
`Delegation` records (`Delegation.threadId`), a per-turn `AbortController`, admission,
lanes + the FocusLease with `rank` (Kevin's hands > main > threads by age), pause / resume /
stop / drain, and the brain pool (`threads/brain-pool.ts`: `Settings.warmThreads` spare
`codex app-server` processes, default 2, retry after 60 s). A spawned thread is as rich as
main: the full base prompt, the memory block, marks, the eyes' shot plus the composite look,
its own screenshots, confirmations spoken with its name, follow-ups by name ("spotify, skip
this song"), one budgeted `speak_progress`. It never spawns and never runs `self_*`.

Spawned threads never schedule a snapshot: one `thread.event` (≤ 200 B, coalesced 50 ms per
thread) per change, broadcast; the conversation travels as a seq-paged `thread.transcript`
(`ThreadEntry` utterance | delegation | step | status | system) to VIEWERS only, opened with
`thread.open {threadId, viewer}` and paged with `thread.history {before: seq}` — the
agents' viewer-token shape, so the daemon routes both kinds to the clients that opened them
and the CLI's join/leave clients receive none. The snapshot itself stays whole — the
transcript, the delegations with their steps (`Delegation.stepCount` is what a thread page
shows before its steps are paged in): spawned threads' conversations are the one thing
that travels outside it.

**Voice verbs cost nothing.** "what is spotify doing", "what are you doing", "stop the
slack one", "pause spotify" are judged at BOTH sources (the Delegator's fragment path and
the ear) before the supersede block and answered from the table — the running turn is never
ended by a question. The stop rule: a bare stop word cuts everything, byte-identical to
today with ≤ 1 live thread; `stop <live name>` stops that thread; with ≥ 2 spawned threads
live the SPEECH gate fires at once and the WORK cut waits `STOP_NAME_WAIT_MS` 350 ms for a
name (`interrupt()` is `gateSpeech()` + `cutWork()`). Overflow (a new request naming an
unclaimed app while main has acted) defaults to `supersede` — today's behaviour;
`Settings.threadOverflow: "spawn"` is one setting away.

### Satellites

`BlobFleet` (`UI/Orb/BlobFleet.swift`): one satellite per live spawned thread (max 3), keyed
by thread id, driven by `AppState.threads` from `thread.event` + `snapshot.threads` — never
whole-snapshot reconciliation. A satellite is the orb panel's recipe minus key, `.floating`,
below the main orb, its own `BlobSim` on a 19 × 11 grid (main stays 27 × 15), ONE fleet
`CADisplayLink` (60 while moving, 10–24 idle, paused when still) under a `FleetBudget` ladder
(mean ≤ 6 ms over 30 frames, `ORB_FLEET_BUDGET_LOG=1`). Faces by status: thinking `o o`,
acting `> >`, waiting-screen `- -`, waiting-kevin `O O` with a pill "asks: …", done `^ ^` for
1.2 s then fade, failed `x x` 1.6 s, stopped `- -`. A mono name tag on hover; landings that
avoid the main blob and each other (pairwise ≥ 92 pt); a flight to `Thread.at` (a tagged
`orb.fly {thread}` from the thread's own pointer tools) or to `Thread.app`'s window centre;
click → the thread's pane; a drag into the notch's catch zone → `thread.stop` for that
thread — never sleep, never an `orbPosition` write. The notch peek shows one 5 pt square per
live spawned thread and the island a third line ("Slack · working · 0:03 | Spotify ·
working · 0:03"). Reduce Motion → fades. The main blob's untagged path is unchanged.

### The dock as a control surface

The dock — Kevin's word for the notch home: the blob tucked in the MacBook notch and the
island that drops out of it, never the macOS Dock — is a control surface. The island is
420×184 (`NotchGeometry.islandWidth / islandHeight`; `drop` 228, the panel 460×261), four
bands — anchor, display, control row, foot — never stacked rows; the display is composed
per kind (`canvasKind`: question > marks > plain) and nothing else reflows as chips come
and go; AppKit and CoreGraphics only; one ink shape, its cache capped at 32 MB by bytes,
prewarmed for the open and peek sizes and those keys pinned (evicted last). One value in
(`DockContent`: awake, in session, typedWakes, the request, the last line, the gate's words,
marks, the question, the thread rows, the problem, the meter, marking, screen recording),
action closures out (`NotchDock.circle / window / ask / clear / allow / deny / forgetMark /
openMark / openThread / stopThread / console / sleep / remedy / say`).

| Band | Zone (x, y, w, h) | Content |
|---|---|---|
| anchor x 14–100 | face centre (57, 40) · word (14, 60, 86, 16) | the face, the phase word; fixed in every kind |
| | go (14, 123, 22, 22) · stop (42, 122, 26, 24) · mute (74, 122, 26, 24) | Go is the transport ring in the phase colour; Mute in a session's phases only |
| display x 114–406 | head (114, 12, 292, 18) | mono 11: the level trace · `Working · m:ss` · `✋ <name> asks` (→ the thread); right end: the film caption (marks kind, ≤ 180 pt, trailing ` · ` parts dropped to fit) or `◎ N` (plain kind with marks → Console) |
| | hero (114, 30, 292, 66) | the one 18 pt line, up to three on a 22 pt pitch: the question · the running request · the last line · asleep, the gate's words; 3 lines plain, 2 with tiles or a question, 1 with films |
| | middle by kind | plain: tiles (114/266, 80, 140, 32) for 1–2 threads or the chip line (114, 86, 292, 20) for 3+ · question: Allow (114, 82, 84, 28) · Deny (206, 82, 84, 28) and minis at x 340/376 · marks: three 84×60 films at x 114/206/298, y 56 (the newest first, `+n` → Console) |
| control row y 122–146 | field (114, 122, 176, 24) | the Say box; ⌥⇧Return takes key |
| | clear \| circle \| window \| ask (302 / 328 / 354 / 380, 122, 26, 24) | one strip, cells share seams (no hit slop across a seam); Clear while marks exist; Clear and Ask absent in the question kind |
| foot y 154–184 | footLeft (14, 160, 40, 16) · bar (60, 165, 88, 6) · footRight (156, 160, 186, 16) | the meter: `m:ss` · the dithered bar · `2.3 min · $0.12 · today 12.3 min` (paused dimmed with `sleeps in N min`; asleep `today 12.3 min · $0.62` or `No session. Nothing billed.`) |
| | problem row in the meter's place | glyph · noun · clause (only with ≥ 60 pt of room, else omitted) · the remedy box right-aligned to 342 |
| | console \| sleep (354 / 380, 156, 26, 24) | one pair, one seam; Sleep awake only |

Text ends at 406 in the display and at 342 in the foot; the hairline sits at y 183.5.
The peek carries glance chips right of the dots — question `✋ <name> asks`, marks `◎N`,
the problem's glyph, the meter `2.3 min` — at most four, in that order, and never past 360 pt
(the meter drops first, then the problem). Marking replaces them with `◎ Circle something ·
Esc`. Tucked, the only chip is the marks chip, the lip glows the mark tone while marks wait,
and a mark that lands puts `◎ 1 circled · Go to ask` in the pill slot for six seconds. The slot
ranks gate > toast > mark-landed > problem, and the problem pill shows only under the open
island with its remedy as an inset box.

Two engine commands are the dock's own: `mark.remove {id}` (the `×` on a thumbnail; an
unknown or malformed id changes nothing) and `mark.window` (the front window whole as a mark,
`ScreenMark.source` "window", its rect the window's frame, `element` `{role: "window", title,
app}`; works asleep; no front window → a warn toast). Everything else rides commands the
Console already sends: `say-text` from Ask and the Say field, `thread.answer` from Allow /
Deny, `thread.stop` from a chip's Stop, `sleep {cause: "dock"}` from Sleep, the problem's
remedy through `EngineCommand(remedyJSON:)`, `mark.clear` from Clear; `mark.add` stays the
overlay's. Pressing Circle folds the island before the overlay takes the mouse
(`NotchDock.foldForMark`), and a mark trace started from the dock brings the blob home
(`OrbPanelController.homeAfterTrace`) with Kevin's pin restored once it is parked. Nothing on
the dock but Go (and a typed line under `typedWakes`) opens a paid session; the Say field's
placeholder says which. The harness pins every rule (`Scripts/orb-preview.sh --notch-checks`:
`check:` lines and the `notch sends:` count by kind; `Scripts/protocol-probe.sh`: the two
commands' JSON, the three fixture marks, the remedy decode).

### Messages

Typed lines land on the record FIRST: `Transcript.pushTyped(text, nowMs)` closes any open
utterance (emitted `final`, as `push` does), then adds one item `{source: "typed", final:
true, startMs = endMs = nowMs}` and emits it once as `final` — so the `heard` row is
written, the request window and `isYes` read typed words as speech, and a typed "open
safari" runs the reflex within 300 ms. Typed while ASLEEP is REFUSED with the toast "asleep
— press Go" and the text kept (`Settings.typedWakes`, default false: a stray Return must
never open a paid session). Typed while paused resumes (as before). `agent.send` echoes one
`pending: true` row before the await and toasts "Sent to <name> · queued | resumed" or "Not
sent · <reason>"; `AgentInfo.send {ok, reason?, mode?}` is TYPED from the same evidence
`statusFor` reads (archived in Codex · open in a terminal · open in Claude Desktop · cannot
tell who owns it · Codex not signed in · Codex not installed · folder is gone · queue ·
resume), so the composer never parses cue words again; `SendResult.mode` is `queue | resume
| answer`. `agent.transcript` and `thread.transcript` reach only viewers. One `log.info`
with ms per say-text / agent.open / agent.history / agent.send / thread.open / thread.history.
The Console gains a Threads section (waiting-kevin → busy → idle main → finished), a
`ThreadPane` per thread as rich as Now (cards, steps, screenshots, Allow / Deny →
`thread.answer` with NO default Return action, a composer → `thread.say`, Stop / Pause per
thread), ⌘0 Now, ⌘⇧] / ⌘⇧[ next / previous thread, ⌥⌘. stop this thread, ⌘. stop
everything. `thread.answer yes` arms only when the desk's floor is that thread's, else it is
refused "another question is on the floor: <Name>'s"; `no` forgets that lane's question;
`thread.stop main` parks the main turn and never interrupts everything.

### Speed (docs/LATENCY.md §10 has the levers and the commands that measure them)

The floor is one model generation (3.8 s median in the harness, 4.4–5 s in production);
effort and tier were measured as dead knobs. So the levers cut generations: (a) OBSERVATION
— every acting tool's result carries a ≤ 240-char `now:` line (front app, focused element,
what is under the pointer) read 150 ms after it landed (400 ms after `browser_click` /
`browser_navigate`), through an `ActionObserver` hooked in the runner subclass, never in
`runner.ts`; `Settings.observe` (default true) is the A/B. (b) COMPOSITE LOOK — the eyes'
shot at delegation time also carries frontmost, windows and a shallow AX tree (a
`ScreenStateCache` keyed by display config + front pid, ≤ 300 ms, ≤ 3 probes in parallel)
into `BrainTask.notes[0]`. (c) SPLIT HANDS — `SplitHands` routes read-only ops to the
background helper so a read never queues behind a `type` or an `open_app` on the acting
one. (d) ACTING SERIALIZER — concurrent `tool.run` frames are legal: reads run together,
acts run in order under the lease and HALT after a needs-confirmation. (e) REFLEXES —
filler strip + TAIL matching, media, window and time rows (Apple events only when policy
says run), thread verbs; `pnpm jarhead reflex-miss --days N` mines the misses from Kevin's
own words. (f) VOICE — status / stop / pause from the table. Not built: in-process
concurrent Codex turns (the app-server rejects a second turn — the BrainPool is the shape)
and confirmation replay (rail-adjacent; not designed).

### The face

The Dock tile wears Kevin's `^ ^` — the blob's own pleased face, named his in
`BlobField.swift` — on the dithered round orb: a 5 × 4-cell chevron pair with a 1-cell INK
box at the blob's proportions (eye row 0.30 R above the centre, the pair ≈ 30 % of the
orb's width), ONE cell pattern from 64 to 1024 because cell = size / 64 keeps the orb at
32.5 cells, hand bitmaps at 32 (a 3 × 2 chevron with an 8-neighbour ring, eyes at ±3.5 px)
and 16 (a dot pair with its shadow), the gleam moved above the eyes to the upper-left rim
so the near-white ink and the paper lift never merge. One bug went with it: the orb's
centre sat half a pixel up-left of the squircle's (`(size − 1) / 2` vs `x + 0.5 − size / 2`
— no face can mirror across that). `build-mac.ts` rebuilds the icns whenever
`scripts/{make-icon,icon-render,dither}.ts` is newer than it. The renderer is pure
(`scripts/icon-render.ts`, `renderIcon` + `checkIcon`), the face lives with the material
(`scripts/dither.ts` `FACE` / `faceMask`), the banner wears the same face on its 8 px cells,
and `scripts/__tests__/icon.test.ts` pins the 64-cell pattern exactly, ×2 … ×16
replication, the two bitmaps, flat fills, 0 asymmetric pixels at all seven sizes, every face
pixel within 0.82 R, ≤ 64 colours inside the orb and byte determinism. The pure-refactor
commit is byte-identical (`pnpm build:icon && git status --porcelain docs/media
apps/mac/Resources` empty); the face commit changes every size.

**Rails touched, by name (only on Kevin's word):** `packages/live/src/instructions.ts` (four
lines: threads as a capability, delegate on thread questions, "<Name>: …" narration once,
a question beginning with a thread's name is that thread's); `codexAddendum` in `codex.ts`
(the Threads line, the observation sentence, the batching rule); `packages/brain/src/brain.ts`
(one optional field `BrainTask.thread?: { id; name; lane }`, no prompt text, no version bump).
Not touched: `policy.ts`, `core/index.ts`, `runner.ts` (subclassed), the `toolset.ts`
handshake hunk, `Wake/**`, `selfedit.ts`, `shell.ts`, `files.ts`, `mcp-bridge.ts`,
`codex-config.ts`, the signing lines of `build-mac.ts`, `SECRET_KEYS`, `Engine.stop()`.

## 21. Automations: on system, with the agent asleep (2026-09-14)

Kevin, verbatim: "add a bunnch of cool features that jarhead can set up and spin up like alarms,
automatioons and more that dont requite the agent to be fully awake but can just be on system
basically." The design is `docs/AUTOMATIONS.md` for the reader and this section for the record;
three candidates were drawn and judged (watchers-and-rules as the spine, clockwork's engineering
grafted in whole, system-native's small pieces — `mac.sleep`/`clock.changed` signals, `Run now`
as the missed problem's remedy, one self-snooze, `pmset` printed by `doctor` only).

### The object

One protocol type, `Automation`: `when <trigger> then <actions>` with clauses, an `echo` line
(the one sentence Jarhead read back), a state machine (`armed · snoozed · firing · fired ·
deferred · paused · done · failed · trashed`; `trashed` is a state, never a deletion), and
`confirmed { at, heard }` for the three kinds that asked once. `automationKind` is derived, never
stored: alarm · timer · reminder · routine · watcher. Triggers: `at`, `in`, `every`
(a normalised `Recurrence`: weekly, interval; monthly and monthday typed now and refused with
"not yet — say the date" so the wire does not change later), `on` a `SystemEvent`
(`folder.file`, `download.done`, `app.launch/quit`, `mac.wake`, `screen.unlock`, `display.*`,
`recipe.red`, `agent.status`; `clipboard.match`, `network.changed` and `automation.fired` are
reserved words, refused by name). Actions: `chime · say · notify · open · file · run-recipe ·
press · wake-brain`, 1–3 per row, at most one acting kind. Settings gain one block
(`automations` in `SETTINGS_KEYS`); the snapshot gains `automations`, `ringing`, `nextFire`; the
engine gains three events (`automation.event`, `local.say`, `notify`), twelve commands (never a
deletion) and six ledger rows in `META_TYPES`; the app→daemon wire gains `system.signal`.

### The two moments

Everything hinges on judging at **set-up**, once, awake, and never at fire. `classifyAutomation`
sits in `policy.ts` beside the four classifiers: the master switch, the action count and the one
acting kind, the trigger (reserved kinds, secret or guarded folders, the folder cap, the poll
floor, a recipe the shell gate would question, `file` without a folder trigger, a brain-waking
watcher without a ten-minute cooldown), then per action its `unattended` chip and its own reason.
Free kinds arm silently; `run-recipe`, `press` and `wake-brain` are `confirm` — the ordinary
`ToolRunner.ask` handshake, once, the identical re-call consumed — and for `wake-brain` the
question IS the cost line, said word for word by the voice and recorded as `confirmed.heard`.
Anything the shell gate would rate `confirm` when it runs is **refused now**: nobody is there
then. At fire the executor re-judges lexically (`classifyUrl`, `classifyPath`, the shell gate
on the saved text, the front app for a press) and any `needs-confirmation` or hold is a `failed`
row with its reason. `engine.wake()`, `connect()` and `kevinSpoke()` are never called from the
automations code; the wake-word gate and `JARHEAD_AUTO_WAKE` are not read; the meter stays at
zero. The acceptance greps pin each of these at zero over `packages/engine/src/automations`.

### The clock, honestly

One line in `Engine.tick()`; no long `setTimeout`. A tick gap over 5 s means the Mac slept and
`resync` decides each due row by kind: one-shots fire within their grace (alarm 15 min, timer 10,
reminder 60) with `· 12 min late` in the head, later ones are `missed` with the `automation.missed`
problem and **Run now**; routines never fire late (a 01:00 backup at 09:14 is a surprise);
watchers re-baseline and do not replay. The daemon is the app's child and dies ~90 s after the
app quits, so the standing line is **Nothing fires while Jarhead is quit.** The one mitigation is
`Open at login` — the app registering itself with `SMAppService` on Kevin's press, a different
actor from the brain's hands (which policy treats as confirm for a login item). No launchd
mirror, no cold path, no `pmset` from the daemon: the doctor prints the `pmset` line as text.

### The surfaces built in this pass (F)

`pnpm jarhead automations [list|add|snooze|done|skip|pause|resume|rename|run|trash|restore]` and
`pnpm jarhead recipes [list|add|trash]` over the twelve commands; a pure `automations-cli.ts`
(the listing, `parseClockAutomation` through core's `parseWhen` for the free kinds only,
`resolveAutomation` by id-or-name, the shell gate's word for a recipe) pinned by
`automations-cli.test.ts` without a daemon; the `automations` line of `jarhead status`; the
`doctor` group `automations` (eleven advisory rows over one input; `pmset -g sched` read, the
wake line printed to copy); `docs/AUTOMATIONS.md`; this section; the README's `### Automations`,
the Safety-rails bullet **Unattended means the run tier**, the `⌥⇧S` hotkey row and the Knobs
row; the app README's wire section (`local.say`, `notify`, `automation.event`, `system.signal`,
the notification category). Where the design's prose and the contract on disk differed, the
contract won: the Swift mirror keeps `Settings.automations` and `Snapshot.automations` optional
with non-optional views, and `AutomationContext` carries `localBrain` and `request` so the cost
line says warm-up for a local brain and `file`/`open` see Kevin's words.

**Rails touched, by name:** the trash rule's words (Move to Trash · Restore; `trash` and
`restore` are the CLI's verbs, never delete) and the policy rail's `pmset` line — printed by the
doctor, never run. Not touched: `policy.ts`, `core/index.ts`, `runner.ts`, `instructions.ts`,
`brain.ts`, `Wake/**`, `selfedit.ts`, `shell.ts`, `files.ts`, the `toolset.ts` handshake hunk,
the signing lines of `build-mac.ts`, `SECRET_KEYS`.

