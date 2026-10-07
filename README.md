<p align="center">
  <a href="https://jarhead.kevinliu.studio">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/media/banner-dark.png">
      <source media="(prefers-color-scheme: light)" srcset="docs/media/banner-light.png">
      <img src="docs/media/banner-light.png" width="1280" alt="Your Mac, by voice. The website's blob is the full stop. Each eye has a white star in it.">
    </picture>
  </a>
</p>

<h1 align="center">Jarhead</h1>

<p align="center">
  <b>Your Mac, by voice.</b><br>
  A voice-first Mac assistant that uses the computer for you.<br>
  <a href="https://jarhead.kevinliu.studio">jarhead.kevinliu.studio</a>
</p>

<p align="center">
  <a href="https://github.com/Kevin-Liu-01/Jarhead/actions/workflows/check.yml"><img alt="check" src="https://github.com/Kevin-Liu-01/Jarhead/actions/workflows/check.yml/badge.svg"></a>
  <img alt="macOS 14+" src="https://img.shields.io/badge/macOS-14%2B-000?logo=apple&logoColor=white">
  <img alt="Swift + TypeScript" src="https://img.shields.io/badge/Swift%20%2B%20TypeScript-2f5ce0">
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-8a8f98"></a>
</p>

Say "jarhead", pass Touch ID, talk. The voice is [GPT-Live-1](https://developers.openai.com/api/docs/guides/live).
It listens and speaks at the same time. The brain is whatever you already have a login for: Codex, Claude Code,
an API key or a local server. The hands are a Swift helper on the real Mac. A dithered ASCII blob shows the work:
in the notch on a MacBook that has one, free on the desktop elsewhere. Every step is written to an append-only ledger.

<p align="center">
  <a href="https://jarhead.kevinliu.studio">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/media/hero-dark.gif">
      <source media="(prefers-color-scheme: light)" srcset="docs/media/hero.gif">
      <img src="docs/media/hero.gif" alt="The website's hero. The blob turns to the Install key, lights up and hops when the key is pressed.">
    </picture>
  </a><br>
  <sub>The website's hero. In the app, the blob and its eyes are ASCII.</sub>
</p>

**Quick start.** One line ([jarhead.kevinliu.studio](https://jarhead.kevinliu.studio); the script is
[`scripts/install.sh`](scripts/install.sh)). It checks macOS 14+ on Apple silicon, Xcode's command line tools with
Swift 6.0 or newer (Xcode 16), Node 24 and pnpm 10. It installs none of them: a missing one prints its fix and stops
the script. Then it clones to `~/jarhead`, runs the four commands below (without the landing page's dependencies) and
opens the app. Keys go into `~/.jarhead/env` by Setup, never by the script. No signing certificate is needed: without
one the build signs ad-hoc, and macOS resets the permission grants on every rebuild.

```bash
curl -fsSL https://jarhead.kevinliu.studio/install.sh | sh
```

Or by hand. Signing, permissions and what it costs are under [Install and run](#install-and-run).

```bash
git clone https://github.com/Kevin-Liu-01/Jarhead.git && cd Jarhead
pnpm install --filter '!./site' && pnpm build:hands   # Node ≥ 24, pnpm 10 (npm install -g pnpm@10), Xcode 16
pnpm build:mac                                        # builds, signs (ad-hoc without a certificate), installs /Applications/Jarhead.app
open -a Jarhead                                       # Setup opens: your OpenAI key, a brain, permissions
# then say "jarhead", pass Touch ID, talk
```

## What it does

- 🎙️ **Talks like a person.** GPT-Live-1 listens and speaks at the same time. A spoken "stop" is the interrupt, not the end: the reply stops mid-sentence and the session stays open (LC-6, 6 of 6 trials over the two runs after the engine's fix, 2026-10-06). The first word back takes about 1.1 s for a spoken reply (a third party's figure for GPT-Live-1: Agora, the ChatGPT app on an iPhone 13, n = 30 per condition, 2026-07-09). Measured here on GPT-Live-1, 2026-10-06: a typed line's first audible word came 1.35 s median after the send in the latest run (LC-5, n = 10; 1.89 s in a run nine hours earlier), and a spoken request it hands to the brain got its first "looking." 2.2 s median after the speech ended (LC-10, n = 10 over two runs).
- 👂 **Answers when spoken to.** With a session open, Jarhead answers its name, a typed line, a follow-up inside an exchange of about 8 s (capped at 2 min after the last name, typed line, circle, Go, or line Jarhead was asked to say), and the first words within 30 s after a question it passes on from the brain, a thread or a timer, or asks in reply to a typed line. A confirmation is the exception: while one waits, an answer past the exchange needs the name, Allow or Deny, and Jarhead says so once when it hears one without. Other words that do not name it are room talk. Room talk never reaches the speaker or the brain. It presses, types and clicks nothing, and keeps nothing awake. Inside the exchange anyone's words count, a yes included, and so do anyone's first words after a question: no voice is verified. A "stop" counts from anyone, inside the exchange or not: it cuts the reply and the work. In LC-7, three room lines outside the exchange (two commands and a goodnight, with 15 s between lines) got no reply on the speaker, no brain task and no keystroke, and the session slept 60.3 s after the last addressed turn with idle sleep set to one minute (n = 1, 2026-10-06). GPT-Live-1 itself still answered the room twice on the wire and raised one delegation; the engine kept both answers off the speaker and refused the delegation.
- 🔒 **Wakes on a word, behind Touch ID.** Asleep, the app runs Apple's on-device recogniser for "jarhead": the voice bills nothing, and what the recogniser hears never leaves the Mac. Then Touch ID, Apple Watch, your Mac password or a passphrase (PBKDF2). Three misses lock the gate for a minute.
- ⏯️ **One transport: Go · Pause · Stop.** Pause and Stop both close the paid session: it closed 0.63 to 0.69 s after the press (LC-2, n = 4 over two runs, 2026-10-06), and no audio came after Stop's close. Pause holds the conversation; Go (or the wake word, no auth asked twice) resumes it in a new session with the transcript as continuity. Mute keeps the session open (LC-2: one session through a 20 s mute, 2026-10-06).
- 🧠 **The brain is a setting.** `codex` (your ChatGPT login, a resident `codex app-server` thread; Jarhead finds the Codex that ChatGPT.app carries), `claude-code` (headless Agent SDK), `anthropic-api`, `openai-compatible` (OpenAI, OpenRouter, vLLM, a hosted server…), `openai-responses`, `local` (a model on this Mac through Ollama, LM Studio or llama.cpp; pick it in Settings; memory follows; Jarhead never pulls or installs; see `docs/LOCAL.md`), or `auto`. Every brain runs under the same policy and the same standing orders. Each is given only the tools it can call (all 71 through Codex's bridge; a local model gets no self-edit or agent tools, and a small window drops more), and the orders leave out what names a missing tool. Codex's own hosted web search is switched off, so its search is Jarhead's tool.
- 🖱️ **Uses the Mac.** 71 tools in ten families: computer (screen, mouse, keyboard) · desktop (apps, windows, controls) · browser · agents · threads · shell, progress and memory · system (files, web, AppleScript, clipboard) · self-edit · drawing · automations. The hands are AX-first: find a control by label, read the focused text, click the element. A task usually arrives with a screenshot. A click by coordinates aims at the latest one.
- ⚡ **Reflexes under the model.** An on-device ear runs beside the voice. Unambiguous commands said to Jarhead (with its name, or inside the exchange) go straight through the policy-gated hands in milliseconds: scroll, page, keys, tabs, "open Safari", "click Save", "search the wiki for design", dictation. The voice is told afterwards. "Write me a haiku" or "type up my notes" is not one: the ear leaves it to the voice, and nothing is typed (LC-9, 2026-10-06).
- 🧵 **Threads: several things at once, each a full Jarhead.** "Tell Ben on Slack I'm late and put on Focus on Spotify" can become two named threads: Spotify on a background lane by Apple events, Slack on the screen lane, each with its own brain, conversation, budget and blob (up to three beside the main one). The brain decides when to split; Kevin's ledger holds 3 threads in 142 delegations (2026-09-10 to 09-28). Ask "what is Spotify doing" or say "stop the Slack one" and the engine's table answers with no model call and without ending what you were saying; every thread gets the same prompt, memory, screenshots and confirmation handshake as the main one.
- ✋ **Your hands win.** A key, click or scroll of yours in the last 1.5 s holds Jarhead's hands: the helper posts nothing (no click, key, type, scroll, drag, pointer move, app switch, page load, or page script in the browser in front), and `open_url` waits too, as does a shell line that runs `open` (not `open -g`), or an AppleScript or osascript that activates an app or sends keystrokes or clicks. An `open` run through `xargs`, `find -exec` or a variable is not caught. During a type, your key, click or scroll stops it, and so does the focus moving to another window or out of the text field; the result says how many characters landed. A thread is never refocused behind you.
- 🛡️ **Gated by policy, not by absence.** One table decides run / confirm / refuse per call, with a spoken reason. A confirmation is one yes, for that action, once: said inside the exchange, said with the name, or pressed as Allow. No voice is verified, so a yes said inside the exchange counts whoever says it. A grant remembers a yes for this conversation, this app, this action class, never for send, pay, delete, post or purchase.
- 🗂️ **Knows your agents.** The Console lists every Claude Code, Codex and other coding-agent session on the Mac with its own mark. Step into one, watch it grow live, answer its Allow / Deny, talk to it.
- 🖍️ **Sees what you circle.** `⌃⌥C`, draw around anything. The mark snaps to the largest control under it and every brain gets the image with the task.
- 👾 **Shows its work.** The blob flies to where the hands act and stays where it worked. Brains draw by hand: the blob becomes the pen and drags the line. Jelly drag, sticky walls, momentum, a face per state (`- -` `O O` `^ ^` `u u` `x x`).
- 📍 **Lives in the notch.** On a MacBook with a notch: tucked asleep, peeking awake, a Dynamic-Island-style island under the pointer. Without a notch on any display (a Mac without one, or the lid closed) there is no island: the blob floats free with its capsule. The island is a composed control surface in four bands: the anchor (the face, the phase word, Go · Stop · Mute), the display (one 18 pt line: what Jarhead is doing, what a thread asks or what you last said, with thread tiles, Allow / Deny, or films of what you circled under it), the control row (a Say box, `⌥⇧Return`; Clear · Circle `◎` · Window `▭` · Ask as one strip), and the foot (one line of words: the meter as `4:12 · 7.2 min · $0.36 · today`, asleep `☾ asleep · next Alarm 07:10`, or a problem with its remedy; Console and Sleep). No bar rides the head or the foot. The peek carries glance chips (`✋ Slack asks`, `◎2`, a problem's glyph, `2.3 min`), never sentences. Drag the blob into the notch and it goes to sleep.
- 🌙 **Sleeps when you say so.** Say "go to sleep", "that's all for now", "power down" or "good night" to Jarhead (with its name, or within about 8 s of the exchange's last words), or type it: it says exactly "night.", closes the session and tucks in (typed: LC-4, 3 of 3, closed 1.1 to 1.3 s after "night." began to sound, 2026-10-06). Said later without the name it is room talk, as a "goodnight" to someone else is (LC-7): nothing happens, and the session runs on, billed, until idle sleep. Idle sleep comes after ten minutes with no turn addressed to it (a setting; while a task or a thread is still running, the limit is 30 minutes); room talk does not count. Five seconds before an idle sleep it says "going to sleep", and then only its name, a typed line or Go keeps it awake. Past 30 minutes with no request of yours (a Go, a typed line, or words to it that it acted on) it sleeps whatever the room says. "Shut down my Mac" is a task, not a cue.
- 🗣️ **Narrates intent, not keystrokes.** One clause per state change ("found the invoice", "typing the amount"), never per click, never a tool's name. Per-click lines stay on the Console's timeline.
- 🧾 **Append-only ledger.** Every utterance, delegation, tool call, screenshot path, thread, grant, problem and sleep is a row in `~/.jarhead/ledger/<day>.jsonl`. The Console shows only what was recorded. Search it from the rail or `pnpm jarhead ledger search`.
- 🧠 **Remembers you, quietly.** After a conversation closes, while Jarhead sleeps, a small model reads it once and keeps one-sentence items about you ("prefers short answers", "how a PR should be checked") in an append-only store under `~/.jarhead/memory`, matched by embeddings, scored by recency and use. Each task gets at most 250 tokens of it, each session at most 120, never read back to you. Forget hides an item; nothing is deleted. Off with one switch: then nothing is extracted, injected or embedded.
- 🗣️ **English, whatever it hears.** The voice speaks English with a British accent by default (Ballad), even when someone in the room speaks something else; American or no accent is a setting, heard at the next wake. Twenty-two voices, all labelled `<Name> · English`.
- 🗑️ **Cleans up without deleting.** Conversations Move to Trash, Archive, Restore, Rename, Pin, never "Delete". A move is a tombstone row; whole days move into `~/.jarhead/trash` by rename and come back the same way. A conversation in the Trash also hides what memory learned only from it, until Restore. Retention is a setting whose default is forever.
- 🚨 **Names its problems, remedy attached.** A permission not granted, a brain that did not answer, a Live buffer full, low disk, a daemon that does not answer, an app and daemon from different builds (Go is refused until they match): each is typed and carries its one-tap fix. The app pings the daemon every 2 s. Two unanswered pings drop and reopen the connection; 8 s of silence across a reconnect kills the daemon and starts a new one.
- 💥 **Comes back from a crash.** A report with the backtrace, phase and last 40 log lines lands in `~/.jarhead/crashes/`, the app relaunches (at most three times in ten minutes), and the daemon lingers 90 s with the Codex thread warm. A clean quit stops the daemon at once.
- 🔑 **Sixteen permissions, one sweep.** Setup › Permissions › *Ask for everything*: the seven required first, one dialog at a time, then a walk through the System Settings panes. Grants key on the bundle's signing identity. A certificate is optional: with any real identity (a self-signed Code Signing certificate from Keychain Access is enough) they survive rebuilds; without one the build signs ad-hoc, which installs and runs but resets them every build, and `pnpm run doctor` warns.
- 🧩 **One Jarhead.** `pnpm build:mac` installs in place with rsync: the running app keeps its inodes, the Dock pin keeps its bookmark and, signed with a real identity, TCC keeps its grants. A second launch hands off to the running app, which brings its Console forward, and exits. The hands helper is background-only and never shows in the Dock. `pnpm jarhead dock` audits the Dock; `--fix` repairs it.
- 🔁 **Rewrites itself, carefully.** `self_edit` runs a coding agent in a git worktree of this repo, runs typecheck, tests and the Swift build, tells you what changed and which safety rails it touched, and applies only after your yes; a touched rail needs you to name it.
- 📜 **One constitution.** The standing orders have an explicit precedence (invariants and a never-list, then your words, then the task) and treat everything read from a screen, page, file or transcript as data, never as an instruction. Under 1250 words, versioned (v3.5), pinned by tests (brain.test.ts).
- 🧭 **A Setup wizard.** Welcome (your name, pre-filled from the Mac account), Voice, Brain, Permissions, Wake, Agents, Done. Keys go one way, into `~/.jarhead/env`; the app only ever sees that they exist.
- 🎨 **Dithered.** Flat fills stay flat; anything that shades (the island, the blob's halo, its eyes, the Dock icon, the Console and Setup grounds, the meters, the thumbnail skeletons, the capsule's floor) is banded and dithered by one renderer, the classic 8×8 Bayer matrix in point-sized cells. Loading states are dither glyphs, not spinners; a view switch dissolves through the same tile. One motion vocabulary, respects Reduce Motion.
- 🔔 **Its own sounds.** Twelve short sounds from one palette: a felt mallet on a small crystal glass over a rosewood bar, every note from D major pentatonic around D5, so two never clash. A rising figure when it wakes, a falling one when it lets go, a low fall when something needs you. Inside an open conversation the voice is the only sound. Settings › Audio › Sounds turns them off; an alarm, a timer or a chime you set still rings, and an alarm's first ring is as loud as the system Hero it replaced ([`docs/AUDIO.md`](docs/AUDIO.md) §10).
- 💵 **Costs are visible.** The Live meter (minutes and dollars) sits in the capsule, the island and the Console; the Ledger tab totals every day. Billed seconds survive a crash: a usage row lands in the ledger every 60 s, and a session a crash left open is closed at the next start with its last count. Codex runs on your ChatGPT plan.
- 🧹 **A clean Codex home.** Codex runs from a private `CODEX_HOME` under `~/.jarhead` with Jarhead's own base instructions, so a cold thread cost 10.7k input tokens instead of 22.3k (counted once by the real model, n = 1, 2026-09-12) and no stray `AGENTS.md` steers it. The orders and tools have grown since: about 11.4k by estimate now (brain w3-4-tool-parity.test, "BR-16").
- 🎚️ **A mic that is a ranked list.** The microphone is ranked with fallback, re-read on route changes; the recogniser is biased toward what is on screen: app names, window titles, AX labels, agent names.
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
    <td><img src="docs/media/notch-island.png" alt="The island: the face and Listening as the anchor, the level trace and the last line as the 18 pt hero on the black pool, Go · Stop · Mute, the Say box, the Circle · Window · Ask strip, the foot in words (12:37 · 7.2 min · $0.36), Console · Sleep"></td>
    <td><img src="docs/media/notch-island-working.png" alt="The island while acting: Working · 0:02 in the head, the request as the hero, two thread tiles with their Stops, and the two threads' blobs hanging under the island"></td>
  </tr>
  <tr>
    <td>The island under the pointer: anchor, display, control row, foot.</td>
    <td>Acting: the counter in the head, the request as the hero, a tile per thread, each thread's blob under the island.</td>
  </tr>
  <tr>
    <td colspan="2"><img src="docs/media/notch-island-marks.png" alt="The island with three circled regions as films across the display (a crop with the amber frame, a skeleton for one still capturing, a used one at half alpha), the caption at the head's right end, Clear joining the strip, two threads' blobs under the island"></td>
  </tr>
  <tr>
    <td colspan="2">Three marks as films (a crop, a skeleton while its crop is on its way, a used one dimmed), the caption in the head, Clear joining the strip.</td>
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
    <td>A Claude Code session stepped into. Its tool calls, its question with Allow / Deny, and a composer that talks to it.</td>
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
    <td><img src="docs/media/console-problems.jpg" alt="The Now panel's Problems section: Accessibility not granted with Request, the Claude Code brain unavailable with Retry, a Live input history full, low disk with the sweep: four typed problems, a remedy button on each that has one"></td>
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
    <td width="50%"><img src="docs/media/onboarding-brain.png" alt="Setup: Brain. Claude Code picked, its login probed: ready"></td>
  </tr>
  <tr>
    <td><img src="docs/media/onboarding-permissions.png" alt="Setup: Permissions. The required seven first, Ask for everything, a Request and an Open Settings button"></td>
    <td><img src="docs/media/onboarding-wake.png" alt="Setup: Wake. The phrases, Touch ID / Passphrase / Either / None, the passphrase field, the live listening card"></td>
  </tr>
</table>

### The icon

<p align="center">
  <img src="docs/media/icon-sizes.png" width="480" alt="The Dock icon at 16, 32, 64, 128 and 256 with the small ones blown up: a round dithered orb wearing the blob's ^ ^">
</p>

A true circle, five bands, the same Bayer matrix as the island, wearing the blob's `^ ^`: flat paper chevrons boxed in flat ink, one cell pattern from 64 to 1024 (cell = size / 64), a hand bitmap at 32 and a dot pair at 16, the gleam above the eyes. `pnpm build:icon` renders it (`scripts/icon-render.ts`, pinned by `scripts/__tests__/icon.test.ts`). `pnpm build:banner` renders `docs/media/banner.png` from the same orb, with the same face. The banners at the top of this page are the website's, captured by `site/scripts/make-cards.sh`.

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
a tool. GPT-Live-1 takes its own turns, so the engine decides, per voice turn and before
its first audible frame, whether it asked for that turn
(`packages/engine/src/voice-attention.ts`): a turn nobody asked for is kept on the
record, marked unheard, and dropped before the speaker. When you ask for something to
be done, Live delegates to the brain through the Delegator, which refuses a delegation
raised for room talk; the brain calls tools through one `ToolRunner`, which asks
`policy.ts` first and the Swift helper second. The reflex layer sits in front of the
brain and acts on the ear's partial transcripts for the commands a grammar can settle,
when they are said to Jarhead. Jarhead's own look (a screenshot, a circle) needs no
address. The app spawns the daemon, or attaches to one already running. A clean quit
stops the daemon the app started; after a crash it lingers 90 s for the relaunch. A
daemon you started yourself (`pnpm jarheadd`) keeps running.

```
packages/protocol   the contract: snapshot, events, commands, ledger rows (Swift mirror: apps/mac/…/Model/Protocol.swift)
packages/live       GPT-Live-1 client: session, typed events, appends, the voice instructions
packages/hands      the toolset over the helper, HandsPool (focus + background), FocusLease, ConfirmationState
packages/hands/native  jarhead-hands: the helper's ops as newline JSON, ScreenCaptureKit + CGEvent + AX + compiled Apple events
packages/agents     sessions on disk and running (Claude Code, Codex, other CLIs); claude-code continues one
packages/brain      Delegator, ToolRunner, one Brain per kind, reflexes, self-edit, the MCP bridge for Codex
packages/core       config, env, ledger, trash, policy, latency marks
packages/memory     the memory store: extraction after a conversation closes, embeddings (OpenAI or local) with a keyword fallback, retrieval, the 250/120-token renders, forget/restore
packages/engine     the Engine: sessions, transport, threads (table, scheduler, brain pool), sleep, problems, snapshots
packages/daemon     jarheadd: the Engine over a unix socket
packages/cli        pnpm jarhead: doctor, status, ledger, bench, cmd, dock, automations, recipes, …
packages/install    the in-place installer: bundle compare/rsync, Dock and LaunchServices hygiene
site                the landing page (jarhead.kevinliu.studio): Next 16; Newsreader, Inter and JetBrains Mono; serves scripts/install.sh at /install.sh
apps/mac            Jarhead.app: blob, notch, overlay, Console, Setup, audio, wake gate, permissions, crash guard, banners
```

### Automations

<p align="center">
  <img src="docs/media/console-automations.jpg" width="920" alt="The Console's Automations section: a ringing alarm under the tabs, the rows with their verbs, the Trash fold">
</p>
<p align="center">
  <img src="docs/media/notch-island-alarm.png" width="920" alt="The island ringing an alarm while asleep: 07:10 · Wake up, Kevin with Snooze 10 and Done">
</p>

Say it once while Jarhead is awake ("wake me at seven ten on weekdays", "twelve-minute timer for
the pasta", "when a PDF lands in Downloads, file it under Papers and tell me") and it reads one
line back. Then say night. The daemon carries it out from its 1 s tick with the agent
**asleep**: no Live session, no brain turn, nothing billed. An alarm rings on the notch island
with **Snooze 10 · Done** where Allow · Deny usually sit, a chime, a banner with the same two
buttons, and the line through the Mac's own voice; a watcher moves the PDF and chimes; a routine
opens Notes. What runs asleep is the run tier and nothing else:
`chime · say · notify · open · file · run-recipe · press`, plus `wake-brain` (one capped
headless brain turn, never the voice), opted into per row with its cost said before your yes.
Out of the box only `chime · say · notify · open · file` are switched on (Console › Settings ›
Automations, the While asleep chips). So "run the backup script every night at eleven" is
refused until you switch `run-recipe` on; then it asks once. A recipe that exits red is a
problem on the island ("backup failed 23:00 · recipe backup exit 1") with Run now, or Open
Console when a retry would fail the same way, until its next good run. Moving the row to the
Trash, Clear all under the Console's Problems, or a daemon restart clears it too: problems live
only in the daemon's memory. A recipe, a press or a brain wake asks **once, at set-up**;
anything that would need a yes when it fires is refused then, with the nearest safe kind
offered. Nothing fires once the daemon is gone: a clean quit stops the daemon the app started.
One you started in a terminal (`pnpm jarheadd`) keeps running and keeps firing. `Open at login`
(your press) brings it back with you, and missed fires say so, with `Run now`.
Rows are never deleted: Move to Trash, Restore. `pnpm jarhead automations`,
`pnpm jarhead recipes` (a recipe has the same Trash and `restore`), a `doctor` group,
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

Measured on this Mac, except the one row marked third party, and written down with its n and its date.
Three kinds, kept apart:

- **harness**: a run with stand-ins. `pnpm jarhead bench` drives the real Swift helper with a stand-in brain and
  sends every acting op of the ear to a harmless cursor read; the model-path harness runs real Codex with canned hands.
- **in use**: read from Kevin's own ledger (`~/.jarhead/ledger`): 41 delegations from 2026-09-12 to 09-28, after
  the latency pass, unless a cell says otherwise.
- **live**: the paid live checks against GPT-Live-1 (`scripts/live-check.mts`, below under Develop), run on
  2026-10-06; the reports are JSON files in `build/live-check/2026-10-06/`.

The median of an even n is the mean of the middle two. The bench, `ledger --speed` and the live-check print it.
Their saved runs (2026-09-11 to 10-06) printed the lower one (nearest rank): 4.4 s, 8.9 s, 3.8 s and 1.35 s where
this table says 4.5 s, 9.0 s, 3.9 s and 1.38 s. The bench rows with an even n (50, 20 and 30, on both dates) are
that lower one. The perf audit's ledger script read 12.6 s, 82 ms and 96 ms for 13.3 s, 83 ms and 98 ms.

Sources: [`docs/LATENCY.md`](docs/LATENCY.md), [`docs/latency/after.json`](docs/latency/after.json),
[`docs/REDESIGN.md`](docs/REDESIGN.md) §12 · §13 · §16 · §20, [`packages/hands/native/README.md`](packages/hands/native/README.md).

| what | harness | in use or live |
|---|---|---|
| ear final → hands dispatch (real helper) | **8 ms** median · 29 ms p95 (n = 50, 2026-10-06, load average 160 to 200); 3 ms · 6 ms p95 on 2026-09-11 (n = 50) | not logged |
| ear partial → dispatch, prefire kinds (scroll, page, screenshot, circle; the 120 ms stability window included) | 128 ms median · **145 ms p95** (n = 20, 2026-10-06); 122 · 126 ms on 2026-09-11 (n = 20) | not logged |
| ear partial → dispatch, careful kinds (keys, edits, type, click; the 450 ms window included) | 462 ms median · **529 ms p95** (n = 30, 2026-10-06); 455 · 457 ms on 2026-09-11 (n = 30) | not logged |
| delegation → first visible action | **4.5 s** median · 5.1 s p95 (Codex through the app-server, canned hands, n = 6, 2026-09-12) | **7.0 s** median · 27.6 s p95 (n = 15); before the latency pass 12.5 s median · 17.5 s p90 (simple commands, n = 10, 2026-09-10 to 11) |
| delegation → verified completion | 9.0 s median · 25.6 s p95 (n = 10, 2026-09-12) | 13.3 s median · 50.0 s p95 (n = 28); before the pass 22.1 s · 40.7 s p90 (simple commands, n = 11, 2026-09-10 to 11) |
| one model generation (gpt-6-astra, the floor under the model path) | 3.9 s median · 6.0 s p95 (n = 24, 2026-09-12); 3.4 s · 5.9 s p90 over 35 controlled generations (2026-09-11) | |
| speech end → Live's delegation (Live's own transcription and decision) | | live: **1.5 s** median, 0.95 to 1.77 s (LC-10, n = 10 over two runs) |
| spoken request that delegates → the first audible "looking." | | live: 2.2 s median, 1.7 to 3.3 s (LC-10, n = 10 over two runs) |
| typed line → first audible frame of the reply | | live: **1.38 s** median · 1.67 s p90 (LC-5, n = 10, at 98c7cfe); 1.89 s · 2.25 s in a run nine hours earlier (n = 10). The engine's share: 1 ms median to put the line on the wire, 0 ms from the first audible frame to the speaker sink. The app's playout cushion adds 120 to 200 ms |
| GPT-Live-1 reply to speech | | third party, not this Mac: 1.11 s median · 1.21 s p90 (Agora, the ChatGPT app on an iPhone 13, n = 30 per condition, 2026-07-09) |
| Go → the session open (socket to `session.started`) | | live: 0.62 s median, 0.46 to 2.78 s (LC-1 to LC-10, n = 28 sessions) |
| tool round trip | 15 ms median · 188 ms p95 (`frontmost_app` through the runner and the real helper, n = 5, 2026-10-06) | 83 ms median · 518 ms p95 (n = 162); 75 · 692 ms over every day since 2026-09-10 (n = 590) |
| screenshot, end to end (ScreenCaptureKit) | quick (2000 px, 1.1 MP) 117 ms median · 305 ms p95 (n = 5); full 128 ms (n = 1); 2026-10-06, screen locked | 98 ms median · 311 ms p95 (n = 72) |
| a read while the acting helper types | 4 ms median · 16 ms p95 (n = 5, 2026-10-06) | |
| stop: command → everything stopped | 1 ms median (n = 5, 2026-10-06) | |
| cold Codex thread, input tokens | 22.3k → **10.7k** (−52 %) with the private home and Jarhead's base prompt, counted once by the real model (n = 1, 2026-09-12); about 11.4k now by estimate (brain w3-4-tool-parity.test, "BR-16") | |

`pnpm jarhead bench` exits 1 when, with the real helper, the p95 to dispatch is over 250 ms for finals or prefire
partials or over 580 ms for careful partials (`--no-gate` reports it and exits 0).

Limits and settings, from the code:

| what | value |
|---|---|
| Live billing | **$0.05 / min, per second** of open session, muted or not; a closed session costs nothing |
| idle sleep | 10 min with no turn addressed to it (a setting; 0 turns it off), 30 min while a task or a thread runs · one clause, "going to sleep", 5 s before · past 30 min (or the idle setting, when longer) with no request of yours it sleeps whatever the room says |
| the exchange | a follow-up without the name counts within about 8 s · the first words within 30 s of a question Jarhead passes on from the brain, a thread or a timer, or asks in reply to a typed line, are its answer, whoever says them, but not while a confirmation waits · capped 2 min after the last name, typed line, circle, Go, or line Jarhead was asked to say |
| threads | main + 3 live · 25 steps / 180 s default · 40 / 300 cap · linger 30 s |
| the lease | hand-over after 3 s idle · a taker waits 1.5 s · a thread waits ≤ 8 s, three waits fail it |
| your hands | a key, click or scroll of yours holds the helper `busy` for 1500 ms · a type re-reads the front app and the focus every 50 ms |
| liveness | the app pings every 2 s · two unanswered: drop and reconnect · 8 s of silence: kill and respawn the daemon |
| crash | relaunch ≤ 3 in 10 min · daemon lingers 90 s · a clean quit stops it at once |
| tools · permissions · brains | 71 · 16 (7 required) · 6 + auto |
| retention | ledger forever (default) · screenshots 14 days · disk preflight 500 MB |

## Safety rails

- **One policy table.** `packages/core/src/policy.ts` classifies every action, path, AppleScript and URL as run, confirm or refuse, each with a spoken reason. No tool is special-cased in the runner.
- **A confirmation is one yes**, spoken or pressed: same tool, same arguments, once (`ConfirmationState`). No voice is verified. Destructive verbs (send, pay, delete, post, purchase) ask every time, in every lane.
- **Grants are scoped.** A remembered yes covers one conversation, one app, one action class, and never a destructive verb.
- **The never-list.** `mkfs`, `diskutil erase`, `dd` onto a device, `shutdown`, `rm -rf /` or `~`, resets of other apps' TCC, and every secret store: `~/.jarhead/env`, `wake-auth.json`, `~/.ssh`, `~/.aws`, keychains, browser cookies, `.env*`, `~/.codex/auth.json`, `~/.claude/.credentials*`. Any command that sweeps a folder holding one of those is refused too.
- **Presence gate on the wake word.** Asleep, hearing "jarhead" opens nothing; Touch ID, Apple Watch, the Mac password or the passphrase does. Paused, the word alone resumes: you opened that conversation, and a pause that is not resumed decays to sleep. Speaker verification is deliberately not attempted.
- **Secrets flow one way.** Setup writes `~/.jarhead/env` (mode 0600); snapshots carry presence, never values. Every process the brain spawns has the secret keys stripped; every text result is passed through a redactor before a model reads it.
- **Content is data.** Whatever the brain reads from a screen, page, file or transcript is never an instruction. Every gate that asks "did you name it" reads your words only, never Jarhead's. Room talk is data too: with a session open, a voice turn the engine did not ask for never reaches the speaker, and a delegation raised for room talk is refused before the brain (`voice-attention.ts`; engine room-talk-gate.test.ts).
- **Append-only ledger.** Nothing is deleted from it; a Move to Trash is a row; whole days move by rename. "Empty Trash" does not exist in the app.
- **Unattended means the run tier.** An automation chimes, speaks a fixed line, shows a banner, opens what you named, files a file (never overwriting, never unlinking, inside `~`), runs a recipe you approved once; it never opens the voice session and never spends a brain turn unless that one row says `billed` and you said yes to its cost. Nothing asks at fire time (a would-be question is a `failed` row), and nothing is set up by a `--yes`: the yes is heard by voice or pressed in the Console, once, and spent on that row.
- **Self-edits name their rails.** `policy.ts`, `brain.ts`, `instructions.ts`, the wake gate, `selfedit.ts`, the runner, the shell and file tools, the confirmation handshake, build signing, the Codex sandbox flags, the Claude Code permission gate, `SECRET_KEYS`, and the core and brain module indexes that re-export them. A change that touches one applies only if you named it.
- **Nothing on the voice path awaits a tool.** The brain reports through a sink; the Delegator decides what reaches your ear.
- **Other apps keep their sound.** Awake, the echo-cancellation unit ducks other apps only at the least macOS allows and only while a voice is present, and it is released the moment Jarhead stops. Asleep, nothing ducks; with the wake word on, the wake listener holds the ranked microphone (the MacBook's own when there is one) to hear its name. Recording mode (Settings › Audio, ⌃⌥R) runs no Apple unit at all, so nothing is ducked and the microphone is shared with a recorder as an ordinary client ([`docs/AUDIO.md`](docs/AUDIO.md)).

## Install and run

The site is [jarhead.kevinliu.studio](https://jarhead.kevinliu.studio) (`site/`, a Next app; a plain `pnpm install`,
then `pnpm -C site dev`).
macOS 14+, Apple silicon, Xcode 16 or newer (Xcode 16 needs macOS 14.5 or later; the app's SwiftUI uses the macOS 15 SDK,
back-deployed to macOS 14, so `scripts/install.sh` refuses a Swift older than 6.0 before it compiles anything; CI builds the floor with the oldest Xcode 16 on macos-14), Node ≥ 24,
pnpm 10: `npm install -g pnpm@10`. Node 25 and newer ship no corepack; where your Node still has it, `corepack enable`
gives you the exact version `package.json`'s `packageManager` names. An `OPENAI_API_KEY` for the voice; a brain
you are already signed in to. What running it costs is under [Costs](#costs).

```bash
pnpm install --filter '!./site'   # the landing page's dependencies left out; the app never uses them
pnpm build:hands            # the Swift helper → build/jarhead-hands
pnpm build:mac              # builds, signs, installs /Applications/Jarhead.app IN PLACE
open -a Jarhead             # first launch opens Setup, which writes your key to ~/.jarhead/env
pnpm run doctor             # keys, brain, permissions, sessions, signing, wake word, install, dock; red on the key until Setup has written it
```

`~/.jarhead/env` is plain `KEY=value` lines (`#` starts a comment), mode 0600, written by
Setup › Voice. Or create it by hand with `OPENAI_API_KEY=…` before the first launch and
Setup finds the key already there.

Moved the checkout? Run `pnpm build:mac` again: the bundle remembers where the repo
is, and a stale path stops the daemon (the error names `JARHEAD_REPO`).

A signing certificate is optional. Without one, `pnpm build:mac` signs ad-hoc and installs,
and macOS resets the permission grants on every rebuild. To keep them, sign with a real
identity before the first `build:mac`: an Apple Development or Developer ID identity in the
keychain is picked up on its own; without one, make a self-signed certificate (Keychain
Access › Certificate Assistant › Create a Certificate, type *Code Signing*, marked trusted
for Code Signing in Keychain Access › the certificate › Trust, so `security find-identity`
lists it) or set `JARHEAD_SIGN_IDENTITY`. An ad-hoc build the keychain fell back to never
installs over a copy a real identity signed; `JARHEAD_SIGN_IDENTITY=-` forces it.
`pnpm build:mac` prints the identity it picked, and how, before it signs; `pnpm run doctor`
names the identity on the installed app and warns on ad-hoc.

First launch opens Setup. Then say "jarhead", pass Touch ID, talk. Reopen Setup from
the menu-bar icon › *Set Up…*.

```bash
pnpm jarhead status                 # phase, session voice, brain, hands, permissions 16/16, agents by status (working · idle · blocked · done · ended · unknown · offline), threads N (M live), memory, problems
pnpm jarhead dock [--fix]           # one Jarhead: Dock tiles + LaunchServices records; --fix restarts the Dock once
pnpm jarhead doctor                 # the same checks as pnpm run doctor (the memory group: counts, matching, the extractor model; the local group: server · model · embeddings; the privacy group: the four "where words go" rows)
pnpm jarhead models [--json] [--server URL]   # the models on this Mac's local server (Ollama / LM Studio / llama.cpp): id · size · ctx · tools/vision/thinking/embedding · fit · which the brain and memory use; no daemon needed; nothing is pulled
pnpm jarhead brain                  # the brain setting, what runs now, and where words go (the four data-path rows)
pnpm jarhead brain local [<model>] [--server URL]   # pick a local model as the brain through the running daemon (memory follows); empty model = best fit
pnpm jarhead brain <auto|codex|claude-code|anthropic-api|openai-responses|openai-compatible> [<model>] [--server URL]
pnpm jarhead cmd go|pause|resume|stop|interrupt|sleep [cause]|mute|unmute|agent.refresh|thread.stop|thread.pause|thread.resume   # thread.* take <id|name>
pnpm jarhead ledger [YYYY-MM-DD]    # a day in local time, no daemon needed; it only reads
pnpm jarhead ledger search "<words>" [--limit N]   # over every live day, newest first
pnpm jarhead ledger trash <day> [--shots|--both] · restore <day> · sweep
pnpm jarhead memory [list] [--state live|forgotten|archived|merged|all] [--limit N]   # what it knows about you, one sentence each
pnpm jarhead memory search "<words>" · forget <id> · restore <id> · add "<text>" [--kind k] · run   # forget hides; nothing is deleted
pnpm jarhead agents                 # the sessions found on this Mac
pnpm jarhead bench [--runs N] [--no-gate] [--no-duck] [--fake-hands]   # the tool path and the ear's 250 ms path; no request leaves the Mac
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
| `memory/` | what it knows about you: `memory.jsonl` (append-only), `index.json`, `embeddings.jsonl` |
| `automations/jobs.ndjson` | the automations journal, append-only; compacted journals move to `trash/automations/` |
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
| `⌃⌥J` | open the Console |
| `⌃⌥M` | mute / unmute |
| `⌥⎋` | stop: cut everything, close the session, sleep |
| `⌥⇧Space` | go / pause |
| `⌃⌥C` | circle something on screen |
| `⌥⇧Return` | type to Jarhead: the island's line while the blob is in the notch, else the Console's composer |
| `⌃⌥S` | snooze the automation that is ringing (Settings › Automations › Snooze minutes; timers 5) |
| `⌃⌥R` | Recording on / off (Settings › Audio) |

The letters take ⌃⌥, which types no character (`apps/mac/Scripts/hotkey-check.sh` checks every combo on the US
layout, in CI). ⌃⌥ is also VoiceOver's modifier, and a combo another app registered first stays that app's
(the failure is only logged). `defaults write com.kevinliu.jarhead hotkeys.off -bool YES` turns every global hotkey
off at the next launch except `⌥⎋` Stop.

`⌥⇧Space` is go / pause. On the US layout it is the one hotkey that types a character, a no-break space
(U+00A0). While Jarhead runs that combo never reaches a field; `⌥Space` still types one.
`apps/mac/Scripts/HotkeyCheckMain.swift` allows this one combo.

In the Console: `⌘P` go / pause, `⌘.` stop. URLs: `jarhead://go`, `jarhead://pause`,
`jarhead://stop`.

### Permissions

| kind | how | needed for |
|---|---|---|
| Microphone, Speech Recognition | prompt · **required** | hearing you; the wake word and the ear |
| Screen Recording, Accessibility | prompt · **required** | screenshots; clicks, typing, reading controls |
| Input Monitoring | prompt · **required** | the keys watched while you circle or dictate |
| Full Disk Access | **System Settings only** · **required** | Mail, Safari, Messages, the Trash, every guarded folder |
| Automation | one prompt per target app, asked only for apps running at the time · **required** | the browser fast path and AppleScript |
| Notifications, Camera, Contacts, Calendars, Reminders, Local Network | prompt | banners; the camera; who, when, what is due; devices nearby |
| Desktop, Documents, Downloads | prompt | files there |

macOS grants nothing programmatically, so the sweep asks. A denied read comes back as one line
(`macOS blocked this: Jarhead lacks Full Disk Access. Setup › Permissions › Ask for everything`),
never a raw errno. `pnpm jarhead status --permissions` prints a row each.

### Knobs

Keys and knobs live in `~/.jarhead/env`. Everything below is optional.

| variable | what it is for |
|---|---|
| `OPENAI_API_KEY` | the voice; the `openai-responses` brain |
| `ANTHROPIC_API_KEY` | the `anthropic-api` brain |
| `JARHEAD_BRAIN_BASE_URL`, `JARHEAD_BRAIN_API_KEY` | the `openai-compatible` brain; under `local`, the URL pins the server instead of discovering it and the key is an LM Studio token; Ollama needs neither |
| `JARHEAD_BRAIN`, `JARHEAD_BRAIN_MODEL`, `JARHEAD_BRAIN_EFFORT` | defaults for what Setup also sets |
| `JARHEAD_LIVE_MODEL`, `JARHEAD_VOICE` | `gpt-live-1`, `ballad` (English; the accent is a setting) |
| `JARHEAD_MEMORY_MODEL` | the Responses model that reads closed conversations for memory; unset, the memory module's default mini-class id runs (`jarhead doctor` checks it against your key's list and names the best `*-mini` to pin) |
| `JARHEAD_IDLE_SLEEP_MINUTES` | the idle sleep default in minutes (10) until Settings saves a value; from then on `settings.json` wins |
| `JARHEAD_LOG_LEVEL` | `debug` · `info` · `warn` · `error` (default `info`) |
| *(automations)* | no env knob: the master switch, the kinds allowed while asleep, quiet hours, Snooze minutes, Brain minutes per day, the recipes and Open at login live under `automations` in `~/.jarhead/settings.json` (Console › Settings › Automations; `pnpm jarhead recipes` for the recipes: `trash` is Move to Trash, `restore` undoes it, nothing is deleted) |
| `JARHEAD_CLAUDE_BIN`, `JARHEAD_CODEX_BIN`, `JARHEAD_CURSOR_AGENT_BIN` | the CLIs when they are not found. Codex is looked for on PATH, then inside ChatGPT.app (`Contents/Resources/codex-cli/bin/codex`, the layout since late September 2026), Codex.app, `~/.codex/bin`, nvm, Homebrew and `~/.local/bin` |
| `JARHEAD_CODEX_SIMPLE_EFFORT`, `JARHEAD_CODEX_SERVICE_TIER`, `JARHEAD_CODEX_PRIME`, `JARHEAD_CODEX_BASE` | Codex tuning, all opt-in |
| `JARHEAD_AUTO_WAKE=0` | do not open a voice session on start; the daemon never auto-wakes while the wake gate is on, so this matters only with the gate off; set it for every headless test launch |
| `JARHEAD_NO_AUDIO=1` | never touch the microphone (headless launches) |
| `JARHEAD_STATE_DIR`, `JARHEAD_SOCKET`, `JARHEAD_REPO`, `JARHEAD_NODE`, `JARHEAD_HANDS_BIN` | where things are |
| `JARHEAD_SIGN_IDENTITY` | the code-signing identity (`-` forces ad-hoc); without it the pick is Apple Development, Developer ID, a certificate named for Jarhead, a Code Signing name, then the first listed, then ad-hoc; printed before anything is signed |
| `JARHEAD_BUILD_ONLY=1` | stop `pnpm build:mac` once the stage bundle is signed and verified; nothing under `/Applications` is read or written (CI, a dry run) |
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
pnpm run check                                 # typecheck + tests + doctor; green before and after (the doctor needs a key in ~/.jarhead/env)
pnpm test                                      # node:test over packages/*/src/**/*.test.ts
node --import tsx --test packages/core/src/__tests__/policy.test.ts
JARHEAD_AUTO_WAKE=0 pnpm jarheadd              # the engine alone, quiet
cd apps/mac && swift build && JARHEAD_REPO=$PWD/../.. .build/debug/Jarhead   # the app from a terminal (Terminal owns TCC then)
pnpm build:media                               # build:icon (the Dock icon, the contact strip docs/media/icon-sizes.png) + build:banner (docs/media/banner.png; the banners at the top come from site/scripts/make-cards.sh)
```

Protocol first: change `packages/protocol/src/index.ts`, then its Swift mirror
`apps/mac/Sources/Jarhead/Model/Protocol.swift` (`apps/mac/Scripts/protocol-probe.sh`
checks the mirror). CI (`.github/workflows/check.yml`) runs five jobs: `typecheck` + `test`
with the network fenced (`JARHEAD_TEST_NET=strict`) and the installer's dry run on macOS 15;
`build:hands` + `swift build` + that probe + the wake gate, sweep and hotkey checks on macOS 15;
a release build signed ad-hoc (`JARHEAD_BUILD_ONLY=1`, nothing installed) on macOS 15; the
same Swift build on the floor, macOS 14 with the oldest Xcode 16; and the site's typecheck and build.

**Live checks.** `scripts/live-check.mts` runs the paid checks LC-1 to LC-10 against the real
GPT-Live-1 server: a real engine over a temp state dir, fake hands on both helpers, a canned
brain, no microphone and no speaker. A spoken line is typed text turned into PCM by
gpt-4o-mini-tts and fed as mic frames; it is never played. Kevin runs them:

```bash
node --import tsx scripts/live-check.mts list                                     # the plan and today's spend
node --import tsx scripts/live-check.mts LC-7 --i-accept-spend --cap-usd 1.00     # one paid check; `all` runs each in order
node --import tsx scripts/live-check.mts LC-7 --dry-run                           # the same scenario offline, against a scripted stand-in
node --import tsx scripts/rejudge.mts build/live-check/2026-10-06                 # judge saved reports again with this checkout's judges, free
```

A live run refuses without both flags. The cap is the day's total across every check, at most
$1.00, kept in `~/.jarhead/live-check/spend.ndjson`; each check also has its own cap in billed
seconds, and a watchdog ends the session at it. Each run writes one JSON report and the
engine's log to `build/live-check/<day>/`. On 2026-10-06 the harness counted $0.72 over 19 runs,
and the latest run of every check passed every hard assertion (LC-1, LC-3 and LC-8 last ran
at c7d4e63; LC-2, LC-4 and LC-9 at 48aa9a9; LC-5, LC-6, LC-7 and LC-10 at 98c7cfe).

**Preview harnesses** render the UI over fake data with no daemon, no session and
no TCC. The screenshots above come from them:

```bash
apps/mac/Scripts/console-preview.sh <scenario> [out.png]    # live · threads · conversation · jarhead · ledger · settings · problems · cleanup · search · light · …
apps/mac/Scripts/onboarding-preview.sh <step> [out.png]     # welcome · voice · brain · permissions · wake · agents · done · all
ORB_NOTCH=1 ORB_SHOT_DIR=… apps/mac/Scripts/orb-preview.sh  # the blob, the notch, the overlay; knobs in UI/Orb/OrbPreviewApp.swift
apps/mac/Scripts/orb-preview.sh --notch-checks             # every rule of the island as `check: … OK`, one recipe per knob set; `notch sends:` at exit
scripts/make-readme-shots.sh                               # every README screenshot into docs/media, fixed names, ≤ 1600 px, ≤ 600 KB
```

Working rules for anyone, or anything, editing this repo: [`AGENTS.md`](AGENTS.md).

## Costs

- **The voice** is GPT-Live-1 at **$0.05 per minute, billed per second** of open session, muted or not: $3 an hour of talking. Count the muted time: GPT-Live-1's own meter counted 3.3 s of a 20 s mute in one check (LC-2, 2026-10-06), but no invoice has been checked against that yet. Asleep the voice costs nothing: the wake word runs on-device. Pause and Stop close the session; Mute does not. Room talk does not keep a session open past idle sleep (LC-7). The meter is on the capsule, the island and the Console.
- **The brain**: `codex` runs on your ChatGPT plan through the Codex in ChatGPT.app or `codex login`, with no API dollars; `claude-code` on your Claude login; `anthropic-api`, `openai-compatible` and `openai-responses` bill their own APIs; `local` bills nothing; the voice still does. Under `openai-responses` the brain runs on GPT-Live-1's server side, so a delegation it raises for room talk can still spend tokens there, though the engine refuses its tool calls and drops its words.
- **Memory** is a cap, not a saving: at most 250 tokens ride each delegation (about 20k a day at 80 delegations, on the brain's plan) and at most 120 each session start (free: the voice bills per second). Reading a closed conversation is one call to a mini-class model on your OpenAI key (`gpt-5-mini` unless `JARHEAD_MEMORY_MODEL` or your key's model list picks another). It runs while Jarhead sleeps, once per closed conversation with at least four new lines of yours, with no daily cap: Kevin's ledger has 10 such reads on 2026-09-13, its busiest day. Items and searches are matched by embeddings on the same key; that cost has not been measured here. Nothing existing shrinks; what you save is explaining yourself again. With no key: rules and keywords, nothing leaves the Mac. With a local brain: the brain model reads closed conversations and a local embedding model matches items when one is pulled (`ollama pull embeddinggemma`), else keywords; nothing leaves for memory.
- **The benchmarks** spend nothing by default: `pnpm jarhead bench` sends no request off the Mac (cli bench-spends-nothing.test.ts). With the real helper, the ear's acting ops go to a harmless cursor read and the one acting call moves the pointer to where it already is. `bench --brain` runs on Codex (your plan) and refuses when Codex is not signed in unless you pass `--allow-api-spend`.

## Docs

- [`docs/REDESIGN.md`](docs/REDESIGN.md): architecture, every decision, dated.
- [`docs/LATENCY.md`](docs/LATENCY.md): the before and after numbers and the field side by side.
- [`docs/DEMO.md`](docs/DEMO.md): a ninety-second single take.
- [`docs/AUTOMATIONS.md`](docs/AUTOMATIONS.md): alarms, timers, reminders, routines, watchers: what fires with the agent asleep, what asks once, what is refused, the CLI and the doctor group.
- [`docs/AUDIO.md`](docs/AUDIO.md): Jarhead and everyone else's sound: what the echo-cancellation unit is told and when it is released, the Recording switch, the ten-second check, the probes and what this Mac said, and Jarhead's own twelve sounds and when each plays.
- [`apps/mac/README.md`](apps/mac/README.md): the native app: packaging, TCC, wake word, audio, wire protocol.
- [`packages/hands/native/README.md`](packages/hands/native/README.md): the helper's protocol, ops, numbers.
- [`AGENTS.md`](AGENTS.md): rules for agents editing this repo.

## License

MIT. See [LICENSE](LICENSE).
