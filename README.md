<p align="center">
  <img src="docs/media/banner.png" width="1280" alt="Jarhead: the dithered orb over an ink field that pools toward the accent">
</p>

<h1 align="center">Jarhead</h1>

<p align="center">A voice-first Mac assistant that uses the computer for you.</p>

<p align="center">
  <a href="https://github.com/Kevin-Liu-01/Jarhead/actions/workflows/check.yml"><img alt="check" src="https://github.com/Kevin-Liu-01/Jarhead/actions/workflows/check.yml/badge.svg"></a>
  <img alt="macOS 14+" src="https://img.shields.io/badge/macOS-14%2B-000?logo=apple&logoColor=white">
  <img alt="Swift + TypeScript" src="https://img.shields.io/badge/Swift%20%2B%20TypeScript-2f5ce0">
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-8a8f98"></a>
</p>

Say "jarhead", pass Touch ID, talk. The voice is [GPT-Live-1](https://developers.openai.com/api/docs/guides/live),
full duplex. The brain is whatever you already have a login for — Codex, Claude Code,
an API key, a local server. The hands are a Swift helper on the real Mac. A dithered
ASCII blob in the notch shows the work, and every step lands in an append-only ledger.

## What it does

- 🎙️ **Talks like a person.** GPT-Live-1 listens and speaks at the same time; a spoken "stop" is the interrupt, not the end. About a second to the first word back, interruptible mid-sentence.
- 🔒 **Wakes on a word, behind Touch ID.** Asleep, the app runs Apple's on-device recogniser for "jarhead" — nothing billed, nothing leaves the Mac. Then Touch ID, Apple Watch, your Mac password or a passphrase (PBKDF2). Three misses lock the gate for a minute.
- ⏯️ **One transport: Go · Pause · Stop.** Pause and Stop both close the paid session, so the meter stops the moment you press. Pause holds the conversation; Go (or the wake word, no auth asked twice) resumes it in a new session with the transcript as continuity.
- 🧠 **The brain is a setting.** `codex` (your ChatGPT login, a resident `codex app-server` thread), `claude-code` (headless Agent SDK), `anthropic-api`, `openai-compatible` (OpenAI, OpenRouter, vLLM, a hosted server…), `openai-responses`, `local` (a model on this Mac through Ollama, LM Studio or llama.cpp — pick it in Settings; memory follows; Jarhead never pulls or installs; see `docs/LOCAL.md`), or `auto`. Same tools, same policy, same constitution.
- 🖱️ **Uses the Mac.** 71 tools in ten families — computer (screen, mouse, keyboard) · desktop (apps, windows, controls) · browser · agents · threads · shell, progress and memory · system (files, web, AppleScript, clipboard) · self-edit · drawing · automations. The hands are AX-first: find a control by label, read the focused text, click the element, screenshot only to verify.
- ⚡ **Reflexes under the model.** An on-device ear runs beside the voice; unambiguous commands (scroll, page, keys, tabs, "open Safari", "click Save", "search the wiki for design", dictation) go straight through the policy-gated hands in milliseconds. The model is told afterwards.
- 🧵 **Threads: several things at once, each a full Jarhead.** "Tell Ben on Slack I'm late and put on Focus on Spotify" splits into named threads — Spotify on a background lane by Apple events, Slack on the screen lane — each with its own brain, conversation, budget and blob (up to three beside the main one). Ask "what is Spotify doing" or say "stop the Slack one" and the engine's table answers with no model call and without ending what you were saying; every thread gets the same prompt, memory, screenshots and confirmation handshake as the main one.
- ✋ **Your hands win.** A key, click or scroll of yours holds Jarhead's hands for 1.5 s; a focus change mid-type cancels the type and says how many characters landed; a thread is never refocused behind you.
- 🛡️ **Gated by policy, not by absence.** One table decides run / confirm / refuse per call, with a spoken reason. A confirmation is your own spoken yes, for that action, once. A grant remembers a yes for this conversation, this app, this action class — never for send, pay, delete, post or purchase.
- 🗂️ **Knows your agents.** The Console lists every Claude Code, Codex and other coding-agent session on the Mac with its own mark. Step into one, watch it grow live, answer its Allow / Deny, talk to it.
- 🖍️ **Sees what you circle.** `⌥⇧C`, draw around anything. The mark snaps to the largest control under it and every brain gets the image with the task.
- 👾 **Shows its work.** The blob flies to where the hands act and stays where it worked. Brains draw by hand: the blob becomes the pen and drags the line. Jelly drag, sticky walls, momentum, a face per state (`- -` `O O` `^ ^` `u u` `x x`).
- 📍 **Lives in the notch.** Tucked asleep, peeking awake, a Dynamic-Island-style island under the pointer. The island is a composed control surface in four bands: the anchor (the face, the phase word, Go · Stop · Mute), the display (one 18 pt line — what Jarhead is doing, what a thread asks, what you last said — with thread tiles, Allow / Deny, or films of what you circled under it), the control row (a Say box, `⌥⇧Return`; Clear · Circle `◎` · Window `▭` · Ask as one strip), and the foot (the meter as a bar with mono figures, or a problem with its remedy; Console and Sleep). The peek carries glance chips (`✋ Slack asks`, `◎2`, a problem's glyph, `2.3 min`), never sentences. Drag the blob into the notch and it goes to sleep.
- 🌙 **Sleeps when you say so.** "Go to sleep", "that's all for now", "power down", "good night" — it says exactly "night.", closes the session, tucks in. Ten idle minutes do the same. "Shut down my Mac" is a task, not a cue.
- 🗣️ **Narrates intent, not keystrokes.** One clause per state change — "found the invoice", "typing the amount" — never per click, never a tool's name. Per-click lines stay on the Console's timeline.
- 🧾 **Append-only ledger.** Every utterance, delegation, tool call, screenshot path, thread, grant, problem and sleep is a row in `~/.jarhead/ledger/<day>.jsonl`. The Console shows only what was recorded. Search it from the rail or `pnpm jarhead ledger search`.
- 🧠 **Remembers you, quietly.** After a conversation closes, a small model reads it once and keeps one-sentence items about you — "Kevin prefers short answers", "how Kevin likes a PR checked" — in an append-only store under `~/.jarhead/memory`, matched by embeddings, scored by recency and use. Each task gets at most 250 tokens of it, each session at most 120, never read back to you. Forget hides an item; nothing is deleted. Off with one switch.
- 🗣️ **English, whatever it hears.** The voice speaks English with an American accent by default, even when someone in the room speaks something else; British or no accent is a setting, heard at the next wake. Twenty-two voices, all labelled `<Name> · English`.
- 🗑️ **Cleans up without deleting.** Conversations Move to Trash, Archive, Restore, Rename, Pin — never "Delete". A move is a tombstone row; whole days move into `~/.jarhead/trash` by rename and come back the same way. Retention is a setting whose default is forever.
- 🚨 **Names its problems, remedy attached.** A permission not granted, a brain that did not answer, a Live buffer full, low disk, a wedged daemon — each is typed and carries its one-tap fix. The daemon answers a ping every 2 s; wedged is not mistaken for fine.
- 💥 **Comes back from a crash.** A report with the backtrace, phase and last 40 log lines lands in `~/.jarhead/crashes/`, the app relaunches (at most three times in ten minutes), and the daemon lingers 90 s with the Codex thread warm.
- 🔑 **Sixteen permissions, one sweep.** Setup › Permissions › *Ask for everything*: the seven required first, one dialog at a time, then a walk through the System Settings panes. Grants key on the bundle's signing identity: with any real identity — a self-signed Code Signing certificate from Keychain Access is enough — they survive rebuilds; ad-hoc (the default when the keychain has none) resets them every build, and `pnpm run doctor` warns.
- 🧩 **One Jarhead.** `pnpm build:mac` installs in place with rsync — the running app keeps its inodes, the Dock pin keeps its bookmark and, signed with a real identity, TCC keeps its grants. `pnpm jarhead dock` audits the Dock; `--fix` repairs it.
- 🔁 **Rewrites itself, carefully.** `self_edit` runs a coding agent in a git worktree of this repo, runs typecheck, tests and the Swift build, tells you what changed and which safety rails it touched, and applies only after your yes — a touched rail needs you to name it.
- 📜 **One constitution.** The standing orders have an explicit precedence — invariants and a never-list, then your words, then the task — and treat everything read from a screen, page, file or transcript as data, never as an instruction. Under 1100 words, versioned, pinned by tests.
- 🧭 **A Setup wizard.** Welcome, Voice, Brain, Permissions, Wake, Agents, Done. Keys go one way, into `~/.jarhead/env`; the app only ever sees that they exist.
- 🎨 **Dithered.** Flat fills stay flat; anything that shades — the island, the blob's halo, the Dock icon, the Console and Setup grounds, the meters, the thumbnail skeletons, the capsule's floor — is banded and dithered by one renderer, the classic 8×8 Bayer matrix in point-sized cells. Loading states are dither glyphs, not spinners; a view switch dissolves through the same tile. One motion vocabulary, respects Reduce Motion.
- 💵 **Costs are visible.** The Live meter (minutes and dollars) sits in the capsule, the island and the Console; the Ledger tab totals each day. Codex runs on your ChatGPT plan.
- 🧹 **A clean Codex home.** Codex runs from a private `CODEX_HOME` under `~/.jarhead` with Jarhead's own base instructions, so a cold thread costs 10.7k input tokens instead of 22.3k and no stray `AGENTS.md` steers it.
- 🎚️ **A mic that is a ranked list.** The microphone is ranked with fallback, re-read on route changes; the recogniser is biased toward what is on screen — app names, window titles, AX labels, agent names.
- 📏 **Checks the disk first.** Under 500 MB free is a typed problem before a session opens or a mark is captured, with *Reveal shots* as the remedy.

## Screenshots

Every picture below is rendered by the app's own preview harnesses over fixed fake data
(`scripts/make-readme-shots.sh` regenerates them; nothing here is a photo of a desktop).
The Console shots are JPEGs: a dithered ground does not compress as PNG.

### The notch

<table>
  <tr>
    <td width="50%"><img src="docs/media/notch-tucked.png" alt="Tucked: asleep in the notch, eyes - -"></td>
    <td width="50%"><img src="docs/media/notch-peek.png" alt="Peeking: awake, eyes O O under the notch on the dithered gradient"></td>
  </tr>
  <tr>
    <td>Tucked, asleep. <code>- -</code></td>
    <td>Peeking, awake. <code>O O</code></td>
  </tr>
  <tr>
    <td><img src="docs/media/notch-island.png" alt="The island: the face and Listening as the anchor, the level trace and the last line as the 18 pt hero on the black pool, Go · Stop · Mute, the Say box, the Circle · Window · Ask strip, the meter as a bar with figures, Console · Sleep"></td>
    <td><img src="docs/media/notch-island-working.png" alt="The island while acting: Working · 0:02 in the head, the request as the hero, two thread tiles with their Stops"></td>
  </tr>
  <tr>
    <td>The island under the pointer: anchor, display, control row, foot.</td>
    <td>Acting: the counter in the head, the request as the hero, a tile per thread.</td>
  </tr>
  <tr>
    <td colspan="2"><img src="docs/media/notch-island-marks.png" alt="The island with three circled regions as films across the display — a crop with the amber frame, a skeleton for one still capturing, a used one at half alpha — the caption at the head's right end, Clear joining the strip"></td>
  </tr>
  <tr>
    <td colspan="2">Three marks as films — a crop, a skeleton while its crop is on its way, a used one dimmed — the caption in the head, Clear joining the strip.</td>
  </tr>
</table>

Press `◎` and the island folds out of the way while you draw; the peek reads
`◎ Circle something · Esc`. The blob outlines what you circled and comes back to the notch.
Asleep, a landed mark glows the lip amber and says `◎ 1 circled · Go to ask` for six seconds.
`▭` captures the front window whole, no drawing, awake or asleep. Two engine commands carry the
films: `mark.remove {id}` (the `×` on a film) and `mark.window` (the front window as a mark);
everything else rides the commands the Console already sends.

<p align="center">
  <img src="docs/media/notch-stay.png" width="920" alt="The blob out of the notch beside its target ring; the notch empty; its perch dashed">
</p>

The blob flew to its target and stays there. The perch is where it came from; the notch is empty until it sleeps.

### The Console

<p align="center">
  <img src="docs/media/console-threads.jpg" width="920" alt="The Console during a split: the Now stream with three thread_start calls and the split line; a chip per thread under the parent card; the Threads rail with Slack waiting for Kevin (its Stop), Spotify and Notes done">
</p>

Three threads at once: Notes and Spotify on the background lane finish on their own,
Slack on the screen lane stops to ask before it sends. The Threads rail lists each
thread under its parent with its question and a Stop per thread.

<table>
  <tr>
    <td width="50%"><img src="docs/media/console-conversation.jpg" alt="A Claude Code session stepped into: Read, Edit and Bash tool calls, folded thinking, a permission question with Allow and Deny"></td>
    <td width="50%"><img src="docs/media/console-jarhead.jpg" alt="A past Jarhead conversation: paused, session closed, resumed after 8 min, a delegation card, 'night.', asleep · said"></td>
  </tr>
  <tr>
    <td>A Claude Code session stepped into. Its tool calls, its question — Allow / Deny — and a composer that talks to it.</td>
    <td>A past Jarhead conversation: paused (meter stopped), resumed eight minutes later in a new session, then "night."</td>
  </tr>
  <tr>
    <td><img src="docs/media/console-ledger.jpg" alt="The Ledger tab: a day picked, its rows, the day's sessions, utterances, delegations and billing"></td>
    <td><img src="docs/media/console-settings.jpg" alt="The Settings tab: voice, mic ranking, brain, model, effort, idle sleep, notch home, retention with Sweep now and Reveal in Finder"></td>
  </tr>
  <tr>
    <td>The Ledger tab: a day's rows, sessions, delegations, what it billed.</td>
    <td>Settings: voice, mic, brain, idle sleep, the notch home, retention. The Trash has <em>Reveal in Finder</em>, not <em>Empty</em>.</td>
  </tr>
  <tr>
    <td><img src="docs/media/console-problems.jpg" alt="The Now panel's Problems section: Accessibility not granted with Request, the Claude Code brain unavailable with Retry, a Live input history full, low disk with the sweep — four typed problems, a remedy button on each that has one"></td>
    <td><img src="docs/media/console-cleanup.jpg" alt="The rail with Pinned above the days, Archived folded, Trash open with Restore on each row, and a Hidden agent with Unhide"></td>
  </tr>
  <tr>
    <td>Four typed problems; each that has a remedy carries its button.</td>
    <td>Pinned, Archived, Trash with Restore, a hidden agent with Unhide. Nothing is deleted.</td>
  </tr>
</table>

<p align="center">
  <img src="docs/media/console-light.jpg" width="920" alt="The Console in the light (aqua) appearance">
</p>

### The blob

<p align="center">
  <img src="docs/media/blob-eyes.jpg" width="920" alt="Every face: asleep - -, connecting o o, listening O O, speaking ^ ^, thinking, acting, muted _ _, error x x, paused u u, the wake gate's listening, heard, authenticating, granted, denied, locked out, and poked">
</p>

One face per state, shared by the blob and the notch. Expressions change through a 90 ms blink.

<table>
  <tr>
    <td width="33%"><img src="docs/media/blob-fly.png" alt="orb.fly: the blob parked beside its target ring, acting"></td>
    <td width="33%"><img src="docs/media/blob-gate.png" alt="The wake gate: the blob asleep with a 'Touch ID or passphrase' pill"></td>
    <td width="33%"><img src="docs/media/blob-drag.png" alt="A jelly drag: the body stretched toward the hand"></td>
  </tr>
  <tr>
    <td>Flown to where the hands act.</td>
    <td>Heard its name; asking you to prove it is you.</td>
    <td>Dragged. It lags, stretches and wobbles.</td>
  </tr>
</table>

<p align="center">
  <img src="docs/media/blob-trace.png" width="920" alt="orb.trace: the blob as a pen at the corner of the rectangle it drew, labelled Deploy button">
</p>

A brain said `show_rect` with a label. The blob became the pen and drew it.

<table>
  <tr>
    <td width="50%"><img src="docs/media/blob-capsule.png" alt="The capsule beside the blob: phase, meter, what you said, what it said, the running step, Go / Mute / Stop / Console"></td>
    <td width="50%"><img src="docs/media/overlay-shapes.png" alt="The overlay's teaching shapes: circle, arrow, rectangle, text, stroke, a hand-drawn mark, a region frame"></td>
  </tr>
  <tr>
    <td>The capsule: phase, meter, the exchange, the running step, Go · Mute · Stop · Console.</td>
    <td>The overlay: circle, arrow, rect, text, stroke and your own mark, on a click-through window per display.</td>
  </tr>
</table>

### Setup

<table>
  <tr>
    <td width="50%"><img src="docs/media/onboarding-welcome.png" alt="Setup: Welcome"></td>
    <td width="50%"><img src="docs/media/onboarding-brain.png" alt="Setup: Brain — Claude Code picked, its login probed: ready"></td>
  </tr>
  <tr>
    <td><img src="docs/media/onboarding-permissions.png" alt="Setup: Permissions — the required seven first, Ask for everything, a Request and an Open Settings button"></td>
    <td><img src="docs/media/onboarding-wake.png" alt="Setup: Wake — the phrases, Touch ID / Passphrase / Either / None, the passphrase field, the live listening card"></td>
  </tr>
</table>

### The icon

<p align="center">
  <img src="docs/media/icon-sizes.png" width="480" alt="The Dock icon at 16, 32, 64, 128 and 256 with the small ones blown up: a round dithered orb wearing the blob's ^ ^">
</p>

A true circle, five bands, the same Bayer matrix as the island — wearing the blob's `^ ^`: flat paper chevrons boxed in flat ink, one cell pattern from 64 to 1024 (cell = size / 64), a hand bitmap at 32 and a dot pair at 16, the gleam above the eyes. `pnpm build:icon` renders it (`scripts/icon-render.ts`, pinned by `scripts/__tests__/icon.test.ts`); `pnpm build:banner` renders the banner at the top of this page from the same orb, with the same face.

## How it works

```mermaid
flowchart LR
  K((you)) -- "mic PCM · wake word · circle" --> APP
  subgraph APP["Jarhead.app (Swift)"]
    direction TB
    ORB["blob · notch island · capsule"]
    CON["Console · Setup"]
    WAKE["wake gate + ear<br/>on-device recogniser"]
    OVL["overlay<br/>click-through, per display"]
  end
  APP <-- "unix socket<br/>[type u8][len u32] frames<br/>JSON · mic PCM · speaker PCM" --> D
  subgraph D["jarheadd (TypeScript, tsx)"]
    direction TB
    E["Engine"]
    L["Live client"]
    DEL["Delegator + Reflexes"]
    B["Brain<br/>codex · claude-code · anthropic-api<br/>openai-compatible · openai-responses · local"]
    TR["ToolRunner + policy"]
    W["Threads<br/>table · scheduler · brain pool"]
    LED["Ledger<br/>~/.jarhead/ledger"]
    AG["Agents<br/>sessions on disk and running"]
  end
  L <-- "wss · full duplex" --> OAI[("GPT-Live-1")]
  TR --> H
  subgraph H["jarhead-hands (Swift helper × 2)"]
    HF["focus"]
    HB["background"]
  end
  H --> MAC["the Mac<br/>ScreenCaptureKit · CGEvent · AX · Apple events"]
  CLI["pnpm jarhead<br/>status · cmd · ledger · bench · dock · automations"] --> D
```

Speech goes to GPT-Live-1 and comes back as speech; nothing on that path waits for
a tool. When you ask for something to be done, Live delegates to the brain through
the Delegator; the brain calls tools through one `ToolRunner`, which asks `policy.ts`
first and the Swift helper second. The reflex layer sits in front of the brain and
acts on the ear's partial transcripts for the commands a grammar can settle. The app
spawns the daemon, or attaches to one already running; the daemon outlives the app.

```
packages/protocol   the contract: snapshot, events, commands, ledger rows (Swift mirror: apps/mac/…/Model/Protocol.swift)
packages/live       GPT-Live-1 client: session, typed events, appends, the voice instructions
packages/hands      the toolset over the helper, HandsPool (focus + background), FocusLease, ConfirmationState
packages/hands/native  jarhead-hands: 29 ops, newline JSON, ScreenCaptureKit + CGEvent + AX + compiled Apple events
packages/agents     sessions on disk and running (Claude Code, Codex, other CLIs); claude-code continues one
packages/brain      Delegator, ToolRunner, one Brain per kind, reflexes, self-edit, the MCP bridge for Codex
packages/core       config, env, ledger, trash, policy, latency marks
packages/engine     the Engine: sessions, transport, threads (table, scheduler, brain pool), sleep, problems, snapshots
packages/daemon     jarheadd: the Engine over a unix socket
packages/cli        pnpm jarhead: doctor, status, ledger, bench, cmd, dock, automations, recipes, …; the in-place installer
apps/mac            Jarhead.app: blob, notch, overlay, Console, Setup, audio, wake gate, permissions, crash guard, banners
```

### Automations

Say it once while Jarhead is awake — "wake me at seven ten on weekdays", "twelve-minute timer
for the pasta", "when a PDF lands in Downloads, file it under Papers and tell me", "run the
backup script every night at eleven" — and it reads one line back. Then say night. The daemon
carries it out from its 1 s tick with the agent **asleep**: no Live session, no brain turn,
nothing billed. An alarm rings on the notch island with **Snooze 10 · Done** where Allow · Deny
usually sit, a chime, a banner with the same two buttons, the line through the Mac's own voice; a
watcher moves the PDF and chimes; a routine opens Notes; a recipe runs and a red exit shows up on
the island in the morning. What runs asleep is the run tier and nothing else: `chime · say ·
notify · open · file · run-recipe · press`, plus `wake-brain` — one capped headless brain turn,
never the voice — opted into per row with its cost said before your yes. A recipe, a press or a
brain wake asks **once, at set-up**; anything that would need a yes when it fires is refused
then, with the nearest safe kind offered. Nothing fires while Jarhead is quit; `Open at login`
(your press) brings it back with you, and missed fires say so honestly with `Run now`. Rows are
never deleted — Move to Trash, Restore. `pnpm jarhead automations`, `pnpm jarhead recipes`
(a recipe has the same Trash and `restore`), a `doctor` group,
[`docs/AUTOMATIONS.md`](docs/AUTOMATIONS.md).

<table>
  <tr>
    <td width="50%"><img src="docs/media/console-automations.jpg" alt="The Console's Automations section: the summary line and Add…, one row per alarm, timer, reminder, routine and watcher with its next fire and verb, a snoozed badge, a paused row with Resume, the Trash folded with Restore"></td>
    <td width="50%"><img src="docs/media/notch-island-alarm.png" alt="The island ringing: the alarm's line as the hero on the black pool, Snooze 10 · Done where Allow · Deny usually sit"></td>
  </tr>
  <tr>
    <td>Automations in the Console: one row each, the Trash folded with Restore. Nothing is deleted.</td>
    <td>An alarm on the island: the line as the hero, Snooze 10 · Done.</td>
  </tr>
</table>

## Numbers

Measured on this Mac and written down; the harnesses are in the repo. Sources:
[`docs/LATENCY.md`](docs/LATENCY.md), [`docs/REDESIGN.md`](docs/REDESIGN.md) §12 · §13 · §16 · §20,
[`docs/latency/after.json`](docs/latency/after.json), [`packages/hands/native/README.md`](packages/hands/native/README.md).

| what | number |
|---|---|
| ear final → hands dispatch (real helper, n = 50) | **3 ms** median · 6 ms p95 |
| ear partial → dispatch, prefire kinds (scroll, page, screenshot, circle; includes the 120 ms stability window) | 122 ms median · **126 ms p95** |
| ear partial → dispatch, careful kinds (keys, edits, type, click; includes the 450 ms window) | 455 ms median · **457 ms p95** |
| `pnpm jarhead bench` gate | p95 ≤ 250 ms for finals and prefire partials, ≤ 580 ms for careful partials, else exit 1 |
| delegation → first visible action, Codex through the app-server (canned hands, n = 6) | **4.4 s** median · 5.1 s p95 — was 12.5 s median / 17.5 s p90 in production |
| delegation → verified completion (n = 10) | 8.9 s median · 25.6 s p95 — was 22.1 s / 40.7 s p90 |
| one model generation (gpt-6-astra, the floor under the model path) | 3.8 s median · 6.0 s p95 in the same run (n = 24); 3.4 s median · 5.9 s p90 over 35 controlled generations before it |
| speech end → delegation (Live's own transcription and decision) | 0.4 – 1.6 s |
| GPT-Live-1 reply, third-party measurement | 1.11 s median · 1.21 s p90 |
| tool round trip, production ledger | 55 ms median · 211 ms p95 |
| screenshot, warm full display (ScreenCaptureKit) | 48 – 75 ms |
| cold Codex thread, input tokens | 22.3k → **10.7k** (−52 %) with the private home and Jarhead's base prompt |
| Live billing | **$0.05 / min, per second**, muted or not; a closed session costs nothing |
| idle sleep | 10 min without an addressed turn (setting) |
| threads | main + 3 live · 25 steps / 180 s default · 40 / 300 cap · linger 30 s |
| the lease | hand-over after 3 s idle · a taker waits 1.5 s · a thread waits ≤ 8 s, three waits fail it |
| your hands | a key, click or scroll of yours holds the helper `busy` for 1500 ms |
| liveness | ping every 2 s · two unanswered → drop, reconnect, kick |
| crash | relaunch ≤ 3 in 10 min · daemon lingers 90 s |
| tools · permissions · brains | 71 · 16 (7 required) · 5 + auto |
| retention | ledger forever (default) · screenshots 14 days · disk preflight 500 MB |

## Safety rails

- **One policy table.** `packages/core/src/policy.ts` classifies every action, path, AppleScript and URL as run, confirm or refuse, each with a spoken reason. No tool is special-cased in the runner.
- **A confirmation is your spoken yes** — same tool, same arguments, once (`ConfirmationState`). Destructive verbs (send, pay, delete, post, purchase) ask every time, in every lane.
- **Grants are scoped.** A remembered yes covers one conversation, one app, one action class, and never a destructive verb.
- **The never-list.** `mkfs`, `diskutil erase`, `dd` onto a device, `shutdown`, `rm -rf /` or `~`, resets of other apps' TCC, and every secret store — `~/.jarhead/env`, `wake-auth.json`, `~/.ssh`, `~/.aws`, keychains, browser cookies, `.env*`, `~/.codex/auth.json`, `~/.claude/.credentials*`. Any command that sweeps a folder holding one of those is refused too.
- **Presence gate on the wake word.** Hearing "jarhead" opens nothing; Touch ID, Apple Watch, the Mac password or the passphrase does. Speaker verification is deliberately not attempted.
- **Secrets flow one way.** Setup writes `~/.jarhead/env` (mode 0600); snapshots carry presence, never values. Every process the brain spawns has the secret keys stripped; every text result is passed through a redactor before a model reads it.
- **Content is data.** Whatever the brain reads from a screen, page, file or transcript is never an instruction. Every gate that asks "did Kevin name it" reads your words only, never Jarhead's.
- **Append-only ledger.** Nothing is deleted from it; a Move to Trash is a row; whole days move by rename. "Empty Trash" does not exist in the app.
- **Unattended means the run tier.** An automation chimes, speaks a fixed line, shows a banner, opens what you named, files a file (never overwriting, never unlinking, inside `~`), runs a recipe you approved once; it never opens the voice session and never spends a brain turn unless that one row says `billed` and you said yes to its cost. Nothing asks at fire time — a would-be question is a `failed` row — and nothing is set up by a `--yes`: the yes is heard by voice or pressed in the Console, once, and spent on that row.
- **Self-edits name their rails.** `policy.ts`, `brain.ts`, `instructions.ts`, the wake gate, `selfedit.ts`, the runner, the shell and file tools, the confirmation handshake, build signing, the Codex sandbox flags, `SECRET_KEYS`. A change that touches one applies only if you named it.
- **Nothing on the voice path awaits a tool.** The brain reports through a sink; the Delegator decides what reaches your ear.

## Install and run

macOS 14+, Apple silicon, Xcode's toolchain, Node ≥ 24, pnpm 10. An `OPENAI_API_KEY` for the voice; a brain you are already signed in to.

```bash
pnpm install
pnpm build:hands            # the Swift helper → build/jarhead-hands
pnpm run doctor             # keys, brain, permissions, sessions, signing, wake word, install, dock
pnpm build:mac              # builds, signs, installs /Applications/Jarhead.app IN PLACE
open -a Jarhead
```

Sign with a real identity before the first `build:mac`, or every rebuild resets the
permission grants: an Apple Development or Developer ID identity in the keychain is
picked up on its own; without one, make a self-signed certificate — Keychain Access ›
Certificate Assistant › Create a Certificate, type *Code Signing* — or set
`JARHEAD_SIGN_IDENTITY`. `pnpm run doctor` names the identity on the installed app and
warns on ad-hoc.

First launch opens Setup. Then say "jarhead", pass Touch ID, talk. Reopen Setup from
the menu-bar icon › *Set Up…*.

```bash
pnpm jarhead status                 # phase, session voice, brain, hands, permissions 16/16, agents by status (working · idle · blocked · done · ended · unknown), threads N (M live), memory, problems
pnpm jarhead dock [--fix]           # one Jarhead: Dock tiles + LaunchServices records; --fix restarts the Dock once
pnpm jarhead doctor                 # the same checks as pnpm run doctor (the memory group: counts, matching, the extractor model; the local group: server · model · embeddings; the privacy group: the four "where words go" rows)
pnpm jarhead models [--json] [--server URL]   # the models on this Mac's local server (Ollama / LM Studio / llama.cpp): id · size · ctx · tools/vision/thinking/embedding · fit · which the brain and memory use; no daemon needed; nothing is pulled
pnpm jarhead brain                  # the brain setting, what runs now, and where words go (the four data-path rows)
pnpm jarhead brain local [<model>] [--server URL]   # pick a local model as the brain through the running daemon (memory follows); empty model = best fit
pnpm jarhead brain <auto|codex|claude-code|anthropic-api|openai-responses|openai-compatible> [<model>] [--server URL]
pnpm jarhead cmd go|pause|resume|stop|interrupt|sleep [cause]|mute|unmute|agent.refresh|thread.stop|thread.pause|thread.resume   # thread.* take <id|name>
pnpm jarhead ledger [YYYY-MM-DD]    # a day, no daemon needed
pnpm jarhead ledger search "<words>" [--limit N]
pnpm jarhead ledger trash <day> [--shots|--both] · restore <day> · sweep
pnpm jarhead memory [list] [--state live|forgotten|archived|merged|all] [--limit N]   # what it knows about you, one sentence each
pnpm jarhead memory search "<words>" · forget <id> · restore <id> · add "<text>" [--kind k] · run   # forget hides; nothing is deleted
pnpm jarhead agents                 # the sessions found on this Mac
pnpm jarhead bench                  # the ear's 250 ms path; no API spend
pnpm jarhead bench --brain [--runs N] [--effort low|medium|high|xhigh|max] [--json --out F]   # Codex on your plan; refuses API spend without --allow-api-spend
pnpm jarhead probe "…" · say "…" · live · hands
```

The state directory is `~/.jarhead`:

| path | what |
|---|---|
| `env` | keys and knobs, mode 0600, written by Setup |
| `settings.json` | what Setup and the Console set |
| `ledger/<day>.jsonl` | everything that happened, append-only |
| `shots/` | what the brain saw, by day |
| `trash/`, `trash/shots/` | days and screenshots that were moved, by rename |
| `crashes/<time>.txt` | crash reports |
| `worktrees/` | self-edits in progress |
| `codex-home/` | the private `CODEX_HOME` |
| `shell/` | background `run_shell` logs |
| `wake-auth.json` | the passphrase hash |
| `daemon.log`, `jarhead.sock` | the daemon's log (rotated at 5 MB) and socket |

### Hotkeys

| | |
|---|---|
| `⌥⇧J` | open the Console |
| `⌥⇧M` | mute / unmute |
| `⌥⎋` | stop — cut everything, close the session, sleep |
| `⌥⇧Space` | go / pause |
| `⌥⇧C` | circle something on screen |
| `⌥⇧Return` | type to Jarhead — the island's line while the blob is in the notch, else the Console's composer |
| `⌥⇧S` | snooze the automation that is ringing (Settings › Automations › Snooze minutes; timers 5) |

In the Console: `⌘P` go / pause, `⌘.` stop. URLs: `jarhead://go`, `jarhead://pause`,
`jarhead://stop`.

### Permissions

| kind | how | needed for |
|---|---|---|
| Microphone, Speech Recognition | prompt · **required** | hearing you; the wake word and the ear |
| Screen Recording, Accessibility | prompt · **required** | screenshots; clicks, typing, reading controls |
| Input Monitoring | prompt · **required** | the keys watched while you circle or dictate |
| Full Disk Access | **System Settings only** · **required** | Mail, Safari, Messages, the Trash, every guarded folder |
| Automation | one prompt per target app · **required** | the browser fast path and AppleScript |
| Notifications, Camera, Contacts, Calendars, Reminders, Local Network | prompt | banners; the camera; who, when, what is due; devices nearby |
| Desktop, Documents, Downloads | prompt | files there |

macOS grants nothing programmatically, so the sweep asks. A denied read comes back as
one line — `macOS blocked this: Jarhead lacks Full Disk Access. Setup › Permissions ›
Ask for everything` — never a raw errno. `pnpm jarhead status --permissions` prints a
row each.

### Knobs

Keys and knobs live in `~/.jarhead/env`. Everything below is optional.

| variable | what it is for |
|---|---|
| `OPENAI_API_KEY` | the voice; the `openai-responses` brain |
| `ANTHROPIC_API_KEY` | the `anthropic-api` brain |
| `JARHEAD_BRAIN_BASE_URL`, `JARHEAD_BRAIN_API_KEY` | the `openai-compatible` brain; under `local`, the URL pins the server instead of discovering it and the key is an LM Studio token — Ollama needs neither |
| `JARHEAD_BRAIN`, `JARHEAD_BRAIN_MODEL`, `JARHEAD_BRAIN_EFFORT` | defaults for what Setup also sets |
| `JARHEAD_LIVE_MODEL`, `JARHEAD_VOICE` | `gpt-live-1`, `cedar` (English; the accent is a setting) |
| `JARHEAD_MEMORY_MODEL` | the Responses model that reads closed conversations for memory; unset, the memory module's default mini-class id runs (`jarhead doctor` checks it against your key's list and names the best `*-mini` to pin) |
| `JARHEAD_IDLE_SLEEP_MINUTES` | idle sleep (10) |
| *(automations)* | no env knob: the master switch, the kinds allowed while asleep, quiet hours, Snooze minutes, Brain minutes per day, the recipes and Open at login live under `automations` in `~/.jarhead/settings.json` (Console › Settings › Automations; `pnpm jarhead recipes` for the recipes — `trash` is Move to Trash, `restore` undoes it, nothing is deleted) |
| `JARHEAD_CLAUDE_BIN`, `JARHEAD_CODEX_BIN`, `JARHEAD_CURSOR_AGENT_BIN` | the CLIs when they are not on PATH |
| `JARHEAD_CODEX_SIMPLE_EFFORT`, `JARHEAD_CODEX_SERVICE_TIER`, `JARHEAD_CODEX_PRIME`, `JARHEAD_CODEX_BASE` | Codex tuning, all opt-in |
| `JARHEAD_AUTO_WAKE=0` | do not open a voice session on start — **every test launch** |
| `JARHEAD_NO_AUDIO=1` | never touch the microphone (headless launches) |
| `JARHEAD_STATE_DIR`, `JARHEAD_SOCKET`, `JARHEAD_REPO`, `JARHEAD_NODE`, `JARHEAD_HANDS_BIN` | where things are |
| `JARHEAD_SIGN_IDENTITY` | the code-signing identity (`-` forces ad-hoc) |
| `JARHEAD_INSTALL_HYGIENE=0\|fix` | skip the Dock / LaunchServices pass, or repair the Dock |
| `JARHEAD_INSTALL_SNAPSHOT=1` | take a rollback snapshot (a `Jarhead.app.zip` archive under `build/previous/`) before the in-place install; default off, git is the rollback |
| `JARHEAD_LINGER_MS` | how long the daemon waits for a relaunch (90 000) |
| `JARHEAD_PERMISSIONS_DRY_RUN=1` (`_DENY`) | log what would be asked, ask nothing |
| `JARHEAD_CRASH_TEST=exception\|signal`, `JARHEAD_NO_RELAUNCH=1` | crash a dev build on purpose; keep it down |
| `JARHEAD_HANDS_DEBUG`, `JARHEAD_EAR_LOG` | helper and ear tracing |

## Develop

**Let Jarhead do it.** "Jarhead, make your greeting one word shorter." `self_edit`
makes a worktree under `~/.jarhead/worktrees` on a branch off `main` (refused while
`main` is dirty), hands the task to Codex, Claude Code or the brain's own file tools,
commits as Jarhead, runs `pnpm install` when the lockfile moved, `typecheck`, `test`,
and `swift build` when `apps/mac` changed, and speaks a summary: files, diff stat,
checks, rails touched. `self_review` shows the diff; `self_apply` asks "Apply the
change to Jarhead and restart it?" and fast-forwards `main` only on your yes;
`self_discard` drops it. Fifteen minutes per edit.

**Or by hand.**

```bash
pnpm run check                                 # typecheck + tests + doctor; green before and after
pnpm test                                      # node:test over packages/*/src/**/*.test.ts
node --import tsx --test packages/core/src/__tests__/policy.test.ts
JARHEAD_AUTO_WAKE=0 pnpm jarheadd              # the engine alone, quiet
cd apps/mac && swift build && JARHEAD_REPO=$PWD/../.. .build/debug/Jarhead   # the app from a terminal (Terminal owns TCC then)
pnpm build:media                               # build:icon (the Dock icon, the contact strip docs/media/icon-sizes.png) + build:banner (docs/media/banner.png)
```

Protocol first: change `packages/protocol/src/index.ts`, then its Swift mirror
`apps/mac/Sources/Jarhead/Model/Protocol.swift` (`apps/mac/Scripts/protocol-probe.sh`
checks the mirror). CI runs `typecheck` + `test` and `build:hands` + `swift build` on
macOS 15 (`.github/workflows/check.yml`).

**Preview harnesses** render the UI over fake data with no daemon, no session and
no TCC — the screenshots above come from them:

```bash
apps/mac/Scripts/console-preview.sh <scenario> [out.png]    # live · threads · conversation · jarhead · ledger · settings · problems · cleanup · search · light · …
apps/mac/Scripts/onboarding-preview.sh <step> [out.png]     # welcome · voice · brain · permissions · wake · agents · done · all
ORB_NOTCH=1 ORB_SHOT_DIR=… apps/mac/Scripts/orb-preview.sh  # the blob, the notch, the overlay; knobs in UI/Orb/OrbPreviewApp.swift
apps/mac/Scripts/orb-preview.sh --notch-checks             # every rule of the island as `check: … OK`, one recipe per knob set; `notch sends:` at exit
scripts/make-readme-shots.sh                               # every README screenshot into docs/media, fixed names, ≤ 1600 px, ≤ 600 KB
```

Working rules for anyone — or anything — editing this repo: [`AGENTS.md`](AGENTS.md).

## Costs

- **The voice** is GPT-Live-1 at **$0.05 per minute, billed per second** of open session, muted or not — $3 an hour of talking. Asleep costs nothing: the wake word runs on-device. Pause and Stop close the session; Mute does not. The meter is on the capsule, the island and the Console.
- **The brain**: `codex` runs on your ChatGPT plan through Codex Desktop or `codex login` — no API dollars; `claude-code` on your Claude login; `anthropic-api`, `openai-compatible` and `openai-responses` bill their own APIs; `local` bills nothing; the voice still does.
- **Memory** is a cap, not a saving: at most 250 tokens ride each delegation (about 20k a day at 80 delegations, on the brain's plan) and at most 120 each session start (free — the voice bills per second). Reading a closed conversation costs a mini-class model call on your OpenAI key, at most a few times a day; embeddings are fractions of a cent. Nothing existing shrinks; what you save is explaining yourself again. With no key: rules and keywords, nothing leaves the Mac. With a local brain: the brain model reads closed conversations and a local embedding model matches items when one is pulled (`ollama pull embeddinggemma`), else keywords — nothing leaves for memory.
- **The benchmarks** spend nothing by default: `pnpm jarhead bench` redirects the acting op to a harmless read, and `bench --brain` runs on Codex (your plan) and refuses when Codex is not signed in unless you pass `--allow-api-spend`.

## Docs

- [`docs/REDESIGN.md`](docs/REDESIGN.md) — architecture, every decision, dated.
- [`docs/LATENCY.md`](docs/LATENCY.md) — the before and after numbers, the field side by side, the honest assessment.
- [`docs/DEMO.md`](docs/DEMO.md) — a ninety-second single take.
- [`docs/AUTOMATIONS.md`](docs/AUTOMATIONS.md) — alarms, timers, reminders, routines, watchers: what fires with the agent asleep, what asks once, what is refused, the CLI and the doctor group.
- [`apps/mac/README.md`](apps/mac/README.md) — the native app: packaging, TCC, wake word, audio, wire protocol.
- [`packages/hands/native/README.md`](packages/hands/native/README.md) — the helper's protocol, ops, numbers.
- [`AGENTS.md`](AGENTS.md) — rules for agents editing this repo.

## License

MIT — see [LICENSE](LICENSE).
