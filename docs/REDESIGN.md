# Jarhead v2 — redesign from first principles

Written 2026-09-10, the day GPT-Live-1 landed in the API. This replaces the v1
architecture in `legacy/DECISION.md` / `legacy/DECISION-AMENDMENTS.md` (kept for history).

## 1. What v1 got wrong, and why a rewrite

v1 was a *voice assistant that could also use the computer*. Its shape came from
the constraint it was built under: a half-duplex speech pipeline (STT → text
model → TTS, later `gpt-realtime-2.1`) with a wake-phrase gate, and a text-model
"act loop" bolted on the side. Measured consequences:

- Every action turn paid the wake gate, then a transcript round-trip, then a
  tool loop with AppleScript subprocesses (System Events walks at 4–6 s on
  Chromium apps), then a coordinate guessed as a *fraction of a window* by a
  vision model that was never trained for pointing. p50 to first real answer
  was 1.3 s; a two-lookup action was "literal minutes" (v1's own log).
- Barge-in needed an echo-rejection heuristic because the mic heard the
  speaker. Speech and action lived in different processes glued by sockets, so
  the Dock app shelled out to a CLI *per turn*.
- The surface was an ASCII blob. There was no place to see what it heard, what
  it was doing, which agents it was driving, or to stop it.

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

**Claude computer use** is now a native toolset (`computer_toolset_20260801` on
Claude Opus 5 / Sonnet 5 / Fable 5) trained for pixel-coordinate pointing off a
screenshot, and the **Claude Agent SDK** runs Claude Code headless with
in-process MCP tools, streaming input, and a permission callback. Kevin's Claude
Code login is what authenticates it — no API key needed.

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
                         │ wss           │ brain: auto → codex · claude-code · anthropic-api · openai-compatible · openai-responses
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
and CLAUDE.md), `anthropic-api` (the Messages API with `ANTHROPIC_API_KEY` and
the native computer toolset), `openai-compatible` (Chat Completions at
`Settings.brainBaseUrl` / `JARHEAD_BRAIN_BASE_URL` with `JARHEAD_BRAIN_API_KEY`:
OpenAI, OpenRouter, Ollama, LM Studio, vLLM…) and `openai-responses` (Live's own
Responses delegation, same tools as function tools). `auto`, the default, walks
that order (`AUTO_BRAIN_ORDER`) and takes the first that is configured *and*
starts; the winner is `snapshot.setup.brainResolved`. What is skipped quietly,
what earns a `problem()` line and which explicit kinds fall back to Responses is
§6c's rule. Each `session.delegation.created` becomes one
turn for whichever brain runs: the transcript window since the last delegation,
the current screen context, and the running task ledger. Every backend drives
the same 32 tools through `ToolRunner` — the hands (below), the agent
connectors, web search, shell — and streams progress back as `thinking.append`
and results as `commentary.append`.

**Plane 3 — the hands (native).** A Swift helper (`jarhead-hands`) speaks
newline-JSON over stdin/stdout and stays resident: ScreenCaptureKit
screenshots, CGEvent mouse/keyboard, CGWindowList, NSWorkspace, AX text. Sub-
10 ms per action instead of 100–400 ms of `osascript` startup, and negative
coordinates (Kevin's display sits above the primary) are just numbers. The TS
side implements the 17 members of Claude's computer toolset on top of it, with
screenshot scaling and coordinate un-scaling in one place.

**Plane 4 — the agents.** Connectors with one interface (`list / status / send /
read / events`). `sessions` discovers every agent session on this Mac — Claude
Code (`~/.claude/projects`), Codex (`~/.codex/sessions`), other agent CLIs found
on disk or in the process list — and `claude-code` continues a Claude Code
session headlessly through the Agent SDK. Nothing is tied to one product. "Ask
the reviewer agent to check the PR" is a brain tool call, not a special case.

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
   scrolling, opening apps, reading) runs without asking. This is the opposite
   default from v1, on purpose: Jarhead is *meant* to use the computer.
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

A Live session bills every second it is open. Jarhead sleeps after 10 minutes
without an addressed turn (configurable): the session closes, the Orb dims, the
mic stays local-only. Waking is a tap on the Orb, the hotkey, or the wake
gesture in the Console — ~1.5 s to `session.started`, with an earcon so the gap
is felt as intentional. Muting (`session.input_audio.mute`) is instant and does
not close the session.

## 6b. The native shell (added 2026-09-10, same day)

Kevin: "make this a native app". The face is **Jarhead.app, a Swift macOS app**
at `apps/mac`, and the engine runs as a daemon (`jarheadd`, `packages/daemon`).
The Electron shell that v2 started with was retired the same day (§7).

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

**The orb is the v1 blob again.** Kevin: "there was a cute amorphous blob that
behaved like a liquid/fluid and u could swing it around and hit the edges of the
screen and so on and u could watch it react. it would also change color". The
port (`apps/mac/.../UI/Orb`) is v1's `overlay.js` silhouette — a sum of wandering
harmonics with per-phase personality and glyph ramps, spring-damped squish
contacts, a shiver on phase change — drawn as CoreGraphics glyphs on an NSView,
one colour per phase with eased blends, plus what Electron never had: a fluid
body with momentum. Dragging pulls the blob on a short spring; letting go keeps
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
Only success sends `wake` from the listener (a deliberate Orb tap, the hotkey,
the menu-bar item and `jarhead cmd wake` stay direct); three failures lock the
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

**Agents = sessions.** Kevin clarified that herdr and T3 Code were inspiration:
the point is to *see his existing agent sessions* — Claude Code (`~/.claude/projects`),
Codex (`~/.codex/sessions`), and whatever else is on disk or running — with
project, request, last reply, and live/idle status, and to continue Claude Code
sessions headlessly. That is the `sessions` connector. Later the same day Kevin
was blunter — "its not supposed to link to t3, it just links to anything and
everything" — so on 2026-09-10 the herdr and T3 Code connectors were retired to
`legacy/connectors-v2/` (their vendor notes to `legacy/vendor-docs/`), together
with the `t3.pair` command, the `jarhead t3 pair` CLI, the doctor rows, the
`t3BaseUrl` / `herdrBin` fields of `JarheadConfig` and the Console's pair field.
`AgentKind` is now `"claude-code" | "sessions"`; the Swift mirror decodes any
unknown kind as `sessions`.

## 6c. Brains (added 2026-09-10)

Kevin: "why isnt it connecting to our codex? i have one locally. be vendor
agnostic, dont just enforce claude code". The brain is a setting, not a vendor.
`Settings.brain` is one of six `BrainKind`s; every one drives the same 32 tools
through `ToolRunner`, so policy, ledger, screenshots and the confirmation
handshake are identical whichever model is thinking.

| kind | what runs | needs |
|---|---|---|
| `codex` | `codex exec --json --ephemeral` from the CLI bundled in ChatGPT.app (Codex Desktop) or on PATH, with Jarhead's tools mounted as the `jarhead` MCP server (`packages/brain/src/mcp-bridge.ts`) | Codex signed in — the ChatGPT login in `~/.codex/auth.json`; no key |
| `claude-code` | headless Claude Code through the Agent SDK, tools as an in-process MCP server | the `claude` login (or a valid `ANTHROPIC_API_KEY`) |
| `anthropic-api` | the Messages API tool loop | `ANTHROPIC_API_KEY` |
| `openai-compatible` | Chat Completions with function tools at `brainBaseUrl` (OpenAI, OpenRouter, Ollama, LM Studio, vLLM…) | the URL and a model; `JARHEAD_BRAIN_API_KEY` where the server wants one |
| `openai-responses` | the Live session's own Responses delegation (gpt-5.6-terra) | only `OPENAI_API_KEY`, which the voice already has |
| `auto` (default) | the first of the above that is configured *and* starts, in `AUTO_BRAIN_ORDER`: codex → claude-code → anthropic-api → openai-compatible → openai-responses | — |

`auto`'s rule: a backend that is not configured (no binary or login, no key, no
URL) is skipped with a log line; one that is configured but cannot start gets a
`problem()` line in the Console, because that is something Kevin can fix. The
winner is `snapshot.setup.brainResolved`; `pnpm jarhead doctor` shows it (from
the running daemon when there is one, otherwise what this Mac would resolve to).
An explicit `codex` that cannot start walks on down the same order; the other
explicit kinds fall back to `openai-responses`. `brainModel` empty means the
backend's own default everywhere (for Codex: the `model` in `~/.codex/config.toml`).

**How Codex acts.** Each delegation is one `codex exec` run: the standing orders
and the task on stdin, JSONL events on stdout, `--ephemeral` so nothing lands in
Kevin's Codex history. It runs in Codex's read-only sandbox with
`--ignore-user-config` (auth still comes from `CODEX_HOME`): Kevin's config.toml
enables Codex's own computer-use, browser and REPL servers, which would let it
act on the Mac around Jarhead's policy. The only way it can act is the `jarhead`
MCP server, whose every `tools/call` is a `tool.run` message over the daemon
socket (`packages/daemon/src/wire.ts`) into `engine.runner` — the same
ToolRunner as the in-process brains. Screenshots come back as MCP image
content; `needs_confirmation` comes back as text and the standing orders tell
Codex to report the question and stop. `exec` runs with approval policy `never`,
so the server is declared with `default_tools_approval_mode="approve"` — without
it every MCP call is refused ("MCP tool call requires approval, but approval
policy is never", learned the hard way). Event mapping: `mcp_tool_call` → a
thinking line (the runner records the step itself), `agent_message` → notes
(the one before the first tool call is relayed as a thinking line as well, so the
voice has something to say during Codex's start-up), the last one the spoken
summary, `turn.completed` → done, `turn.failed` / `error` → failed; stop is
SIGINT, then SIGKILL after 3 s; budgets are 40 tool calls and 5 minutes like the
API brains. The bridge is pointed at the daemon socket only when the daemon
there is this very process (its `hello` carries its pid); otherwise — `jarhead
live` / `probe` hosting an engine while Jarhead.app's daemon holds the default
path, or `jarheadd --socket X` — the brain serves its own
`<stateDir>/codex-tools.sock` with the same `DaemonServer`, so steps, screenshots
and a pending confirmation never land in another process's runner. Jarhead's
secrets (`SECRET_KEYS`: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`JARHEAD_BRAIN_API_KEY`) are stripped from Codex's environment; the ChatGPT
login under `CODEX_HOME` is all it gets. The bridge also works standalone —
`JARHEAD_SOCKET=~/.jarhead/jarhead.sock node node_modules/tsx/dist/cli.mjs
packages/brain/src/mcp-bridge.ts` — so any MCP client can borrow Jarhead's hands
while the daemon runs.

Measured 2026-09-10, tiny `codex exec` runs: a turn with two tool calls took
~17 s end to end with the CLI's default model at effort low (85k input tokens);
a bare "reply ok" turn with `-m gpt-6-astra`, effort low and no MCP server took
6.5 s (thread.started 1.3 s, turn.started 2.4 s, the skills-budget `error` item
3.5 s, the answer 5.8 s; 20.9k input tokens). Codex discovers Kevin's skills
(`~/.codex/skills` → the wiki runtime, plus the bundled plugins'; the budget
error names 443 dropped) on every run; 0.153.4 has no CLI knob for that —
`--disable skills` is "Unknown feature flag", and `features.skip_host_skill_discovery`
or `skills.config` path selectors on the roots left `codex debug prompt-input`'s
`<skills_instructions>` block byte-identical — so the catalog rides along. The
bridge starts in ~300 ms and a tool round-trip over the socket is about a
millisecond. Net: Codex's first speakable line reaches the voice ~6 s after the
delegation, against §5's 4 s target and the Responses path's 2.4 s (§5b);
`auto` still prefers it because that is the contract's order and Kevin's login,
not a latency call.

## 7. Package map

```
packages/protocol   shared types: state snapshot, events, commands, ledger rows
packages/live       GPT-Live-1 client: session, typed events, transcript ledger, appends
packages/hands      computer toolset (17 members) over the native helper; screenshot scaling
packages/hands/native  Swift helper source; built by scripts/build-hands.ts
packages/agents     connectors: sessions (Claude Code / Codex / other CLIs on disk or running), claude-code (Agent SDK; continues a session)
packages/brain      delegation orchestrator + ToolRunner + one Brain per BrainKind (§3, Plane 2)
packages/core       config, env, ledger, policy (confirmation classes), latency marks
packages/engine     the Engine: session lifecycle, brain selection, snapshots, ledger, idle sleep
packages/daemon     jarheadd: the Engine served over a unix socket (binary frames)
packages/cli        `jarhead` CLI: doctor, live (headless), probe, status, say, agents, hands, ledger, cmd <wake|sleep|mute|unmute|stop|agent.refresh>
apps/mac            Jarhead.app (Swift): orb, console, overlay, audio, wake word, daemon client, packaging
legacy/             retired code, kept for reference; not built, typechecked or tested (see below)
```

**Retired on 2026-09-10.** Two things were moved out of the live tree the day
they were superseded, so the launch tree holds only what runs:

- `legacy/shell-electron-v2/` — the Electron shell (`packages/shell`: main
  process, HTML Orb/Console/Overlay, audio worklets, IPC) and its packager
  (`scripts/build-app.ts`, which produced `build/JarheadElectron.app`). Replaced
  by `apps/mac` (§6b): the native app owns the TCC identity, the audio graph and
  the windows, and the Electron dependency was ~300 MB of `node_modules`. The
  `pnpm app` / `build:app` scripts and the doctor's `electron` row went with it;
  the Console preview harness (`apps/mac/Scripts/console-preview.sh`) keeps its
  screenshot fixtures in `apps/mac/Scripts/mock/`.
- `legacy/connectors-v2/` — the `herdr` (CLI + socket) and `t3` (paired HTTP)
  connectors, with their vendor notes in `legacy/vendor-docs/`. Kevin: "its not
  supposed to link to t3, it just links to anything and everything". The agents
  feature is the generic `sessions` connector plus `claude-code` to continue a
  session; product-specific connectors are not coming back.

## 8. Decisions taken without asking (and why)

- **Electron over Swift for the shell** — reversed the same day (§6b; the
  Electron shell is in `legacy/shell-electron-v2`). What survived: the Orb is a
  small always-interactive window and the annotation layer a separate fully
  click-through window, so the per-region click-through problem from v1 never
  comes back; screen/input stay in the Swift `jarhead-hands` helper.
- **Audio in the app, not ffmpeg.** System echo cancellation and noise
  suppression (`AVAudioEngine` voice processing in Jarhead.app; the retired
  Electron shell used `getUserMedia`) are what make full duplex work in a room
  with speakers. The headless CLI keeps ffmpeg/ffplay for terminals.
- **Claude Code as the default brain** — superseded 2026-09-10 by `auto`
  (`codex → claude-code → anthropic-api → openai-compatible → openai-responses`,
  the contract's `AUTO_BRAIN_ORDER`): the brain is a setting, not a vendor. The
  original reasons still hold for Claude Code's place in that order — it needs
  no key (Kevin's login), it inherits his skills and CLAUDE.md, and it is itself
  one of "Kevin's agents" — and the `ANTHROPIC_API_KEY` in his shell was
  rejected by the API on 2026-09-10, which is why `anthropic-api` sits behind it.
- **T3 Code integration via pairing, not by reading its token store** — retired
  2026-09-10 with the connector (`legacy/connectors-v2/t3`). T3 had a
  first-class device-pairing flow (`/api/auth/pairing-token` → `/oauth/token`
  exchange) and Jarhead paired like a phone would; the principle — never read
  another app's token store — stands for any future connector.

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
   delegation carries the image and the region, and every brain (Codex via
   `-i`, Claude via image blocks, Anthropic API, OpenAI-compatible, Responses)
   sees it. "What is this?" while circling a dialog just works.
3. **Jarhead shows its work.** When a brain acts, the blob flies to where the
   action lands, hovers while the hands click, type or scroll, and the overlay
   pulses the click, traces the drag, and frames the region being read. When a
   brain explains, it can *draw*: circles, arrows, rectangles, freehand strokes
   and short labels on the click-through layer, fading after a few seconds — so
   "the button is here, then drag this there" is a shape on the screen, not a
   sentence. The blob's flight is the same fluid body: a spring flight, an
   impact squish on landing, a drift home when it is done.

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
  `AgentTranscript {agentId, messages, total, complete, live}`.
- Commands `agent.open` / `agent.close` / `agent.history {before}`; event `agent.transcript {transcript, mode: replace|append}`
  (the daemon forwards it as a JSON message of the same name).
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

## 10. Anything and everything, gated by policy; and a Jarhead that rewrites itself (2026-09-10)

Kevin: "make jarhead be able to do anything and everything even rewriting its own
code. but make its system prompt super strong and robust too".

### The capability model

The brain's tool table (`packages/brain/src/tools.ts`, one table for every
`BrainKind`) now covers the whole Mac, and what used to be "not a tool" is
"a tool with a gate". Fifty-five tools in seven families: the computer toolset
(17), desktop (6), agents (5), misc (`run_shell`, `speak_progress`, `remember`,
`recall`), **system** (`read_file`, `write_file`, `edit_file`, `list_dir`,
`search_files`, `web_fetch`, `web_search`, `applescript`, `open_url`,
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

`brainSystemPrompt()` (packages/brain/src/brain.ts) is now a constitution, 900
words exactly (`brain.test.ts` pins the budget, the section order, the never
list, and that every snake_case token it uses is a real tool), the same text for
all five brains, versioned by `SYSTEM_PROMPT_VERSION` (3.1; logged at every
brain's start). Rules 1–3 are in order of precedence and the text says so; it
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
