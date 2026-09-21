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
JARHEAD_REPO=$PWD/.. .build/debug/Jarhead
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
| `JARHEAD_AUTO_WAKE=0` | the daemon does not open a voice session on start; it never auto-wakes while the wake gate is on, so this matters only with the gate off — set it for every headless test launch |
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

Hotkeys (Carbon, no Accessibility grant needed). Go / Pause and Stop are one
transport (`AppState.transportToggle` / `transportStop`, Model/AppState.swift's
Transport region) shared by the capsule, the notch island, the Console composer,
the status and Dock menus, the hotkeys and the `jarhead://` URLs; pause and stop
both close the Live session so the meter stops, a pause keeps the conversation and
Go resumes it with that context.

| | |
|---|---|
| `⌥⇧J` | open the Console |
| `⌥⇧M` | mute / unmute |
| `⌥⎋` | stop — interrupt everything, close the session (the meter stops), sleep |
| `⌥⇧Space` | go / pause — go wakes, or resumes a pause with its context; pause closes the session (the meter stops) and keeps the conversation |
| `⌥⇧C` | circle something on screen for Jarhead |
| `⌥⇧Return` | type to Jarhead: the notch island pins open and its Say field takes key (`OrbPanelController.sayLine`); away from the notch, the Console's composer |

In the Console: `⌘P` go / pause, `⌘.` stop. URLs: `jarhead://go`, `jarhead://pause`,
`jarhead://stop` — the three transport verbs — plus `jarhead://orb` (summon the blob) and
`jarhead://setup` (open Setup); any other path opens the Console. While paused the mic is off
and the wake gate listens: the word resumes without Touch ID or the passphrase — the
pause was authenticated when its session opened and decays to asleep on its own.

## Package

```sh
pnpm build:mac          # builds, signs, installs /Applications/Jarhead.app IN PLACE; build/Jarhead.app is a symlink to it
pnpm jarhead dock       # one Jarhead: the Dock tiles and LaunchServices records, read-only (--fix repairs)
open -a Jarhead
```

There is exactly one launchable Jarhead on the Mac — `/Applications/Jarhead.app`
— so the Dock, LaunchServices' recents and TCC never see two identities. The
preview harnesses (`Scripts/*-preview.sh`) run as accessory processes and never
appear in the Dock.

`scripts/build-mac.ts` rebuilds `jarhead-hands` whenever `packages/hands/native`
is newer than `build/jarhead-hands` (the bundle freezes a copy), builds the icon if
missing, runs `swift build -c release`, assembles the bundle in `build/stage/`,
writes `Contents/Resources/jarhead.json` (`{repo, node, tsx, daemon}`) so the bundle
knows where this checkout is, signs the helper and then the app, and verifies the
stage with `codesign --verify --strict`.

**The install is in place.** The Dock's pinned tile stores a bookmark keyed on the
bundle directory's inode, so the installer never replaces the directory. The step
refuses a target that is a symlink, a regular file or another user's directory
(`planInstall`); on a first install it copies the stage whole (`cp -R`); otherwise it
runs `/usr/bin/rsync -rlptD -c --delay-updates --delete-after --itemize-changes
build/stage/Jarhead.app/ /Applications/Jarhead.app/` — each changed file is renamed
over the old name, so the running app keeps the inodes it has mapped; never `-a`,
never `-E` (openrsync's xattr emulation writes `._*` AppleDouble entries into the
bundle), never `--inplace`. Then it verifies the INSTALLED copy, not the stage:
`codesign --verify --strict --deep`, the designated requirement must carry
`identifier "com.kevinliu.jarhead"` (what TCC keys the grants on), a sha256 walk
proves the installed tree is exactly the signed stage, and the directory inode must
be the one from before. A failure keeps the stage (the order and every fail path are
`performInstall` in `@jarhead/install`, pinned by a scripted test).

**The rollback is git.** The install keeps no copy of the previous bundle by default:
`git checkout <previous> && pnpm build:mac` rebuilds and reinstalls it, in place, inode
kept. `JARHEAD_INSTALL_SNAPSHOT=1 pnpm build:mac` opts into a snapshot: before the
rsync the installed bundle is archived as `Jarhead.app.zip` under gitignored
`build/previous/` (`ditto -c -k` — an archive, never a directory: LaunchServices
registers any directory holding an `Info.plist` as a bundle, a second Jarhead) and the
build prints the rollback line, `ditto -x -k <the zip> /tmp/jarhead-rollback && rsync
-rlptD -c --delete-after /tmp/jarhead-rollback/Jarhead.app/ /Applications/Jarhead.app/`.

Then the one-Jarhead pass:
`lsregister -f` on the installed bundle, stale Jarhead records (a Trash copy, a
worktree's probe bundle, an old stage path — never a symlink that resolves to the
installed bundle) unregistered from the LaunchServices database — no file, the Trash
included, is touched — and a READ-ONLY line about the Dock. lsregister waits on lsd:
the Bundle dump is 2 s idle and over a minute under heavy load, so each call gets
120 s, and a build dumps the table once (the `-u` exit codes are the report). The Dock itself is rewritten only by
`pnpm jarhead dock --fix` or `JARHEAD_INSTALL_HYGIENE=fix` (`defaults export`, drop
Jarhead's recent tiles, keep one pin stripped to the keys the Dock rebuilds its
bookmark from, `defaults import` behind a `mod-count` race check, `killall Dock` only
when something was written); `JARHEAD_INSTALL_HYGIENE=0` skips the pass. `pnpm run
doctor` shows `install`, `launch services` and `dock` rows, all read-only. The
library is `@jarhead/install` (`packages/install/`), pure functions with
one injectable `exec`, tested without a Dock.

Signing picks, in order: `JARHEAD_SIGN_IDENTITY` (use `-` to force ad-hoc), the
first `Apple Development` identity, the first `Developer ID Application`, then
**any** valid code-signing identity in the keychain — a self-signed "Code Signing"
certificate made with Keychain Access → Certificate Assistant is enough, because
what TCC needs is a designated requirement that stays the same across builds. Only
Apple-issued identities get `--timestamp`. `pnpm run doctor` shows which identity
the built bundle carries and warns when it is ad-hoc.

The engine runs from the checkout through tsx, so changing Jarhead's behaviour is
editing this checkout (or pulling it); changes under `apps/mac` or
`packages/hands/native` need a repackage. This app is the only face.

## Setup (`Sources/Jarhead/UI/Onboarding`)

Shown once, when the first snapshot from the daemon says `settings.onboarded` is
false, and on demand from the status-bar menu *Set Up…* (`AppState.openOnboarding`).
Steps: **welcome** (daemon connected?), **voice** (`OPENAI_API_KEY` →
`config.set-secrets`; the engine writes `~/.jarhead/env`, restarts the brain and
probes; the result is `snapshot.setup.openaiKey`), **brain** (kind, model, base URL
for `openai-compatible`; `ANTHROPIC_API_KEY` / `JARHEAD_BRAIN_API_KEY` →
`config.set-secrets`, then `config.probe` → `snapshot.setup.brain` /
`brainDetail`), **permissions** (all sixteen kinds, "Ask for everything", per-row Request / Open Settings),
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

**Every permission, read live, asked for in one sweep, shown everywhere.** Kevin:
"give it all permissions and make it ask for all permissions". Nothing can grant a TCC
permission programmatically — no API, `tccutil` only resets, MDM is not an option — so
the app does the most that exists: it reads all sixteen kinds of the contract
(`PermissionKind`: microphone, speech recognition, screen recording, accessibility,
input monitoring, automation, full disk access, notifications, camera, contacts,
calendars, reminders, local network, and the Desktop / Documents / Downloads folders)
without ever prompting, asks for every one that has a prompt in order and one dialog at
a time, and for the rest deep-links to the exact System Settings pane and watches for
the change. `Sources/Jarhead/Permissions/`: `Permissions.swift` (PermissionsKit — the
metadata: label, why, required, ask; the read-only readers; the panes),
`PermissionsRequests.swift` (one awaited request per kind), `PermissionsSweep.swift`
(PermissionsCenter — the list, the poll, the sweep, the dry run, the reporting). The
readers: AVCaptureDevice / SFSpeechRecognizer / CNContactStore / EKEventStore
authorization statuses; screen recording, accessibility, input monitoring and full disk
access through the fresh `jarhead-hands --permissions` process — the four it prints —
(fallbacks in this process: `CGPreflightScreenCaptureAccess`, `AXIsProcessTrusted`,
`IOHIDCheckAccess(listenEvent)`, which alone still tells "not asked" from "denied", and
opening `~/Library/Application Support/com.apple.TCC/TCC.db`, EPERM = denied); Automation
through `AEDeterminePermissionToAutomateTarget(askUserIfNeeded: false)` per target (System
Events, Finder, Safari, Chrome, Terminal, Mail, Messages, Notes, Calendar, Reminders,
Music, plus a curated set of other browsers, terminals and editors while they run — never
whatever else happens to be scriptable, since every target is one consent dialog in the
sweep; granted when every running target is granted, denied when any is, unknown
otherwise, the detail naming them); notifications through `UNUserNotificationCenter`
(bundle only); local network and the
three folders report unknown until the sweep has asked, because their first real touch
*is* the prompt (afterwards a short `NWBrowser` / `opendir` reads the answer). Required:
microphone, speech recognition, screen recording, accessibility, input monitoring,
automation, full disk access; the rest are capabilities.

**The sweep** ("Ask for everything" — the Setup Permissions step's head button (a ghost:
the footer's Continue is the step's one filled button), the Console's Permissions
section, the status menu's "Ask for everything…", and the engine command
`request-permission {which: "all"}`, which the AppDelegate answers in-process like every
kind but accessibility and screen recording): required kinds first, then the rest;
granted ones skipped; each prompt awaited before the next ("6 of 16 · asking for
Automation…" as a live line); Automation one running target at a time (System Events may
be launched, it is invisible; nothing else is ever launched for it). Screen Recording,
Accessibility and Input Monitoring are the exception that cannot be awaited: their
prompt APIs (`CGRequestScreenCaptureAccess`, `AXIsProcessTrustedWithOptions(prompt)`,
`IOHIDRequestAccess`) return at once while tccd shows the dialog, and the dialog's answer
is nothing the app can read but the grant itself — so the sweep fires the prompt (it
creates the System Settings row and shows the dialog once, with its own Open System
Settings button) and then *waits* (stage `waiting`: "3 of 16 · Screen Recording · allow
it, or switch Jarhead on in …" with Open Settings / Next / Cancel) for the grant to land,
for Next (skip) or for Cancel — never the next dialog on top of this one; a kind whose
dialog was already shown on an earlier ask (an "asked" mark per kind in UserDefaults)
gets its pane opened right away as well. When only settings-only kinds and denied prompt
kinds remain, a walk through the panes one at a time with Next (`Privacy_AllFiles`,
`Privacy_Camera`, `Privacy_Automation`, …; Notifications is its own pane, not under
Privacy), kinds that share a pane in one step (the three folders under Files and
Folders), Full Disk Access also revealing `/Applications/Jarhead.app` in Finder so it
can be dragged in; a poll every 1.5 s (for 90 s, and for as long as a step waits) and
on activation catches the switch and moves the step on when all its kinds are granted;
at the end a summary ("14 of 16 granted · Full Disk Access needs System Settings"). A
read that began before a prompt's answer landed cannot undo it: the list merges per kind
by `checkedAt`. `JARHEAD_PERMISSIONS_DRY_RUN=1` logs every ask, every wait and every pane
instead of doing it; `JARHEAD_PERMISSIONS_DRY_RUN_DENY=screenRecording,filesDesktop,…`
(dry run only) reports those kinds as denied so the wait and the grouped-pane steps show
on a Mac that has granted them. Reporting: after every read that changed anything the
app sends `permission {which,state,detail}` per changed kind and `permissions {all}` with
the whole list (`EngineClient.sendPermission` / `sendPermissions`), so
`snapshot.permissions.all` carries it to the Console rail (required rows + an "n of 16
granted" disclosure), `jarhead status` and the doctor; `AppState`'s permissions region
holds the published list and the sweep progress for the Setup step and the status menu
("Permissions: n missing" opens Setup on that step). `Scripts/permissions-probe.sh`
prints the readers' answers for the shell's own process and a dry-run sweep — never a
prompt. Preview: `Scripts/onboarding-preview.sh permissions`
(`PREVIEW_SWEEP=asking|waiting|settings|folders|done`; `all` also shoots the step at
620x1500, every row in one picture — the README's copy is `docs/media/onboarding-permissions.png`).

The launch path asks for the microphone (`refreshMicrophoneGrant`) once the first snapshot
says Setup has run (`settings.onboarded`), re-checks it on every activation, and answers the
Console's microphone "Request" in-process; the speech prompt follows it once for the wake
word. On a fresh Mac (`onboarded` false) launch and activation only *read* the two grants —
no system dialog lands before Setup's own window — Setup › Permissions asks for them in
order (a grant the sweep makes is adopted at once, so the Wake step can listen), and the
`onboarded` flip at Setup › Done runs the launch ask as usual.

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

`entitlements.plist` carries `device.audio-input`, `device.camera`,
`automation.apple-events`, `personal-information.addressbook` and
`personal-information.calendars` (EventKit: Reminders ride on it; the hardened runtime
has no reminders key). Screen recording, accessibility, input monitoring, speech, full
disk access, notifications, local network and the folders are TCC-only and need no
entitlement. `Info.plist` carries a usage string for every prompt the app fires
(microphone, speech, Apple events, camera, contacts, calendars and reminders — the
FullAccess keys — local network with `NSBonjourServices`, the three folders, network
and removable volumes). No hardened-runtime exceptions: spawning node and the
helper is unaffected by the hardened runtime, which governs only what loads into the
app's own process; the helper is signed without entitlements and still reads
accessibility and screen recording, which are TCC checks on the responsible process.

## Stepping into sessions, circling the screen, watching it fly

- **Sessions** in the Console's left rail carry the mark and colour of the agent
  that owns them (Claude Code, Codex, Cursor, Gemini…). Click one to step into
  the conversation: every turn, tool call and fold of reasoning, growing live
  while the agent works (the engine tails the session file), with a composer
  that talks to that agent and Allow / Deny for a resumed session's questions.
- **⌥⇧C** (or the menu-bar *Circle Something…*) enters mark mode: the overlay
  takes one stroke, Kevin circles anything, the engine screenshots that region
  and hands it to the brain with the next task; Live is told he circled
  something. Escape cancels; the mode times out after 20 s.
- **Flight and drawing.** When the brain acts, the blob flies to the target,
  hovers while the hands work, and drifts home; the overlay pulses clicks,
  traces drags and frames regions being read. Brains have `show_circle`,
  `show_arrow`, `show_rect`, `show_text`, `show_stroke` and `show_clear` to
  teach on the click-through layer; shapes fade after a few seconds.
- **The dock is a control surface** (`UI/Orb/NotchPanel.swift`: the 420×184 island in
  four bands — anchor, display, control row, foot —
  one `DockContent` value in, action closures out; `OrbPanelController` builds the
  content from the snapshot and the thread store). Press `◎` on the island: the dock
  folds to the peek (`NotchDock.foldForMark`, before the overlay takes the mouse), the
  peek reads `◎ Circle something · Esc`, Kevin draws, the overlay sends `mark.add`, and
  the engine's `orb.trace` echo has the blob outline the circle — then, because the trace
  was started from the dock, **the blob comes home** to the notch instead of loitering by
  the line (`homeAfterTrace`), and a pinned island is pinned again once it is parked.
  `▭` sends `mark.window` (the front window whole; with Jarhead's own window frontmost, a
  toast and nothing sent). The display shows pending marks as 84×60 films — a dithered
  skeleton while the crop is on its way, half alpha once used — with a `×` (`mark.remove
  {id}`), Clear (`mark.clear`) and Ask in the control row's strip; Ask sends "What did I
  circle?" (or "What's in this window?"), or circles first when nothing is pending. Each
  live thread is a tile with its own Stop (`thread.stop`; a chip line at three or more),
  and the asking one's question is the hero with Allow / Deny under it (`thread.answer`;
  Return never answers). `⌥⇧Return` gives the Say box key (`say-text`; asleep, the
  engine's `typedWakes` rule decides). Sleep sends `sleep {cause:"dock"}`. The peek
  carries at most four glance chips — question, marks, problem, meter — and the pill slot
  under the island ranks gate > toast > mark-landed; a problem is the foot row with its
  remedy while the island is open, never a pill. Nothing on the dock but Go (and a typed
  line under `typedWakes`) opens a paid session.

The contract for all of it is in `docs/REDESIGN.md` §9.

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
2. On success it sends `go` and the Live session opens. The gate guards the
   hands-free path only: a deliberate Orb tap, the hotkey, the menu-bar item or
   `pnpm jarhead cmd go` open the session directly. Three wrong answers lock the
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

Every JSON message, both directions (`DaemonMessage` / `ClientMessage` in `wire.ts`):

Daemon → app:

- `hello {version,pid,stateDir}` — first, then the first `snapshot`.
- `snapshot {snapshot}` — the whole `Snapshot` (settings, permissions `{all}`, typed
  `problems`, `threads`, agents, marks…); coalesced to ≤ 30/s before it reaches `AppState`.
- `levels {levels}`, `toast {text,tone}`, `overlay {command}`.
- `audio {control:"flush"}` — sent whenever the engine emits `speaker-flush` (Stop, a
  spoken "stop"/"cancel" that cancels a delegation, sleep); the app drops its queued
  speaker audio.
- `pong {id,at}` — the answer to a `ping`; two missed pongs and the app respawns the daemon.
- `ear.hints {strings}` — words the on-device ear should be biased toward now: visible
  control titles, the front app and window, agent names.
- `ledger.rows {id,rows,truncated?}` — the rows of a day, a session or a chain;
  `ledger.days {id,days}`; `ledger.sessions {id,sessions}` (Jarhead's own, newest first);
  `ledger.hits {id,hits}` — full-text hits for the Console's search box.
- `memory.items {id,items}` — `MemoryItem`s for `memory.list` / `memory.search`, never a vector.
- `agent.transcript {transcript,mode}` — a page of an agent's conversation, to the
  clients viewing that agent; `mode` is `replace`, `append` or `prepend`.
- `thread.event {event}` — one change on one thread (a `ThreadEvent`), broadcast so the
  orb's satellites and the Threads rail follow without a snapshot;
  `thread.transcript {transcript,mode}` — a page of a thread's conversation, to the
  clients that opened it.
- `tool.result {id,result}` — the answer to a `tool.run`, to the client that asked.
- `automation.event {event}` — one change on one automation row (an `AutomationEvent`:
  `set · fired · state · missed · tick`), broadcast like `thread.event` and coalesced 50 ms per
  id; `fired` carries the presses the island and the banner offer (Snooze · Done · Open).
- `local.say {text?,sound?,automationId}` — an earcon (`Pop · Glass · Ping · Hero`) and/or a
  FIXED line for the app's `LocalSpeaker` — the wake gate's own instance, so the wake listener
  never hears the line as the word. Never model text, except a redacted `wake-brain` answer ≤ 160
  chars. The daemon has no speaker.
- `notify {id,title,body?,presses,automationId}` — a banner for `UNUserNotificationCenter`
  under the `jarhead.automation` category; the app posts it silently (the earcon already rang —
  two sounds is a bug) and degrades silently without the grant (the `automation.notifications`
  problem says so once).
- `bye` — the daemon has read the app's `bye`; the app closes the socket only after this.
- `error {message}`.

App → daemon:

- `hello {pid,version?,audio?}` — first; `audio:true` subscribes to speaker frames,
  `pid` excludes the app's windows from screenshots.
- `command {command}` — an `EngineCommand` (`go`, `pause`, `resume`, `stop`, `interrupt`,
  `sleep`, `set-settings`, `thread.*`, `agent.*`, `mark.*`…). `set-settings` patches follow
  `SettingsPatch` in `packages/protocol`: `null` clears an optional field, so "system
  default microphone" is `{ micDeviceId: null }`. The mark group: `mark.add {rect, path?}`
  (the overlay's stroke), `mark.remove {id}` (the `×` on one thumbnail — an unknown or
  malformed id changes nothing), `mark.window` (the front window whole as a mark, `source`
  "window", works asleep; no front window → a warn toast), `mark.clear`. A `ScreenMark` on
  the snapshot carries `source?: "circle" | "window"` (absent = a stroke).
- `mic-level {level}`.
- `permission {which,state,detail?}` — one kind as the app read it; `permissions {all}` —
  every `PermissionInfo` after a read that changed something.
- `ear {text,isFinal,segment,at}` — the on-device ear's partial or final transcript while
  awake; the engine's reflex layer acts on the unambiguous ones.
- `ping {id}`.
- `system.signal {signal,at}` — a signal the app observes on Kevin's behalf and forwards as
  data, never a command: `app.launch` / `app.quit {app,bundleId?}` (`NSWorkspace`), `mac.wake`,
  `mac.sleep`, `screen.unlock`, `screen.lock`, `display.connected`, `display.disconnected`,
  `clock.changed`. The daemon has no `NSWorkspace`; the automations table fires its watchers on
  these and treats `mac.sleep` / `mac.wake` / `clock.changed` as evidence for a resync (a tick gap
  over 5 s says the same on its own).
- `ledger.read {id,date}`, `ledger.days {id}`, `ledger.sessions {id}`,
  `ledger.session {id,sessionId}`, `ledger.chain {id,rootId}` (a whole conversation,
  oldest first; answered with `ledger.rows` + `truncated`), `ledger.search {id,query,limit?}`.
- `memory.list {id,state?,limit?}`, `memory.search {id,query,limit?}`.
- `tool.run {id,name,input,thread?}` — run one of Jarhead's tools through the engine's
  `ToolRunner` (policy, ledger, screenshot archive, confirmation handshake included); the
  MCP bridge uses it to give Codex the same tools the in-process brains have. `thread` is
  the `t_…` id the bridge was started with as `JARHEAD_THREAD`: the daemon routes the call
  to that thread's lane runner and refuses an id it does not know; absent, the main brain's.
- `bye` — a clean quit is on its way; stdin closing without a recent `bye` means the app
  crashed and the daemon lingers for the relaunch.

Requests carrying an `id` resolve through it with a 5 s timeout.

The local brain adds no message types: `setup.local` (a `LocalServerStatus` — the
server found, its tool-capable models with fit and capabilities, the engine's pick),
`setup.dataPaths` (the four "where words go" rows) and `remedy.copy` on a problem
(a shell command Kevin runs himself; the app offers Copy, never runs it) are new
fields on the snapshot, mirrored in `Protocol.swift`. Picking the local brain is the
same `set-settings` patch as every other kind: `{ brain: "local", brainModel: "" }`
means the best fit on this Mac.

The automations add the four frames above and nothing else on the wire: the rows themselves
ride the snapshot (`automations`, `ringing`, `nextFire`; `settings.automations`), the presses
are ordinary `EngineCommand`s (`automation.set {automation, by?}` — the Console sends no `by` and is
stamped `console`, the CLI sends `"cli"`; `automation.snooze {id,minutes}`, `automation.done {id}`,
`automation.run`, `automation.trash` / `automation.restore` — never a deletion), and
`Model/Protocol.swift` mirrors every type as small structs of optionals.

### The notification category

`UNNotificationCategory("jarhead.automation")` is registered at launch with the actions
`Snooze 10` (no foreground) · `Done` · `Open` (only when a press carries a target).
`AppDelegate` is the `UNUserNotificationCenterDelegate`: `didReceive` runs the same closures as
the island's presses (`automation.snooze { minutes: settings.snoozeMinutes }` / `automation.done`
/ open the Console), `willPresent` returns `[.banner]` with no sound. Title = the row's name,
body = its line; a `wake-brain` answer's body is its redacted one line. `interruptionLevel` is
`.active`: the time-sensitive entitlement is not in `entitlements.plist` (the doctor's
`time-sensitive` row says so), so an alarm banner honours Focus like any banner — the island and
the chime still fire. Bundle-only (`runsAsBundle`); the harness scripts skip it.

## Audio

`AVAudioEngine` with **voice processing enabled on the input node** before start,
so the system echo canceller removes Jarhead's own voice from the mic (the model is
full duplex and would otherwise hear itself). The graph walks a ladder
(`VoiceProcessingPolicy.attempts`): with echo cancellation, voice processing with
automatic / input-rate / hardware output wiring, then the plain graph guarded (the ranked
mic pinned, then the system default) — because VoiceIO refuses to initialise (-10875) with
some devices unless mixer → output runs at the input rate; with Recording on, the plain rungs
only: ranked/hardware › ranked/automatic › default/hardware. The plain path's device set
(`StartAttempt.pinDevice`) is skipped when the ranked mic already is the system default —
on a Mac whose default input ≠ default output it knocks the shared I/O unit's output out
(-10875) — and otherwise is a rung that can fail. The rung that came up
is remembered (`winningRung`) so a device change does not re-walk the refused rungs. The
tap receives 2–9 channels on mic arrays; the loudest channel is picked and downmixed
to mono, then converted to 24 kHz Int16 in 100 ms chunks, RMS reported at ≤ 10 Hz.
Speaker frames are converted to Float32 and scheduled on an `AVAudioPlayerNode`;
`flush` stops the player and drops the backlog. Audio runs only while a session is
open and the mic is granted.

**What the unit is told, and when it goes (design12).** The moment voice processing is
switched on — inside the same `objcTry`, while the engine is stopped — `VoiceProcessingKnobs`
sets the ducking of other apps to `.min` and *advanced* (only while a voice is present), AGC
on and bypass off, and reads them back in both spellings (the AVFAudio properties and the raw
AU property 2108) into the status line. The unit is released (`setVoiceProcessingEnabled(false)`)
at every stop and teardown, so nothing ducks or holds a headset microphone after Jarhead sleeps.
`Settings › Audio › Recording` (`settings.audio.recording`, `setPolicy`) picks the plain graph
instead: the ranked microphone, no unit, and the **software echo guard** (`EchoGuard` over the
pure `EchoGuardModel`) zero-filling the wire while Jarhead is audible plus a tail sized for the
output's latency. What the graph is actually doing is read back as an `AudioStateReadback`
(`onAudioState`: the knobs, the rung, `hears`/`speaks` with their nominal rates — the
hands-free tell on a headset — the guard's counters, who else runs input on the mic) and
forwarded to the daemon as the `audio-state` frame for `pnpm jarhead status` and `doctor`.
The wake listener (`Wake/WakeWordListener.swift`) points its own input unit at the ranked
microphone, so a headset is not held while Jarhead merely waits for his name. Read
`docs/AUDIO.md` for the behaviour table and the AirPods case.

**Reading it back without the app.** `Scripts/duck-probe.sh` opens with the V4 pure sections
(the guard's machine, the ladder, the constants — no TCC). `Scripts/audio-probe.sh` builds the
graph as the app would in `AUDIO_PROBE_MODE=aec|recording|asleep|private` inside its own
`AudioProbe.app` (its TCC identity; `AUDIO_PROBE_DIRECT=1` borrows the terminal's grant) and
prints `check:` lines and `checks: N ok, M FAIL`, writing `~/.jarhead/audio-probe.json`;
`--test` is what `pnpm jarhead doctor --test-audio` runs and plays a chime only with
`AUDIO_PROBE_PLAY=1`. `Scripts/recorder-probe.sh` (a recorder beside the graph, the guard's
tail leak) and `Scripts/duck-leak-probe.sh` (other apps' level under the unit, through a
macOS 14.2 process tap) play sound and need the same variable. On this Mac (2026-09-16):
`CADefaultDeviceAggregate-<pid>-n` is AVAudioEngine's own default-device aggregate, alive
with the engine object; the unit's is `VPAUAggregateAudioDevice-0x…`, gone at stop.

**Nothing on the audio path may abort the process.** AVFoundation reports graph
mistakes as Objective-C exceptions, which Swift cannot catch: `installTap` with a
format the node no longer has ("Failed to create tap due to format mismatch"), a
connection at a rate the hardware no longer runs, a player started on an engine that
just stopped itself. Uncaught, one takes the app down — five of the eight crashes of
2026-09-11 were the wake listener's tap, each a moment after the input device changed
(the format it had read was stale until the engine was reset). Two rules follow:

- Taps are installed with `format: nil` (the node's own output format at that moment,
  so nothing can mismatch) and the callback converts from `buffer.format`, rebuilding
  its `AVAudioConverter` when that changes — never from a format read before start.
- Every AVFoundation call that can raise (`installTap`, `connect`, `prepare`/`start`,
  `setVoiceProcessingEnabled`, `reset`, `removeTap`, the player's `play`/`stop`/
  `scheduleBuffer`) runs inside `objcTry` (`Audio/ObjCTry.swift`), a Swift wrapper over
  the `JarheadObjC` target's `JHTry` (`@try/@catch`, `Sources/JarheadObjC`). A raise
  comes out as `ObjCException` (name, reason, top of the ObjC stack) and is logged and
  retried like any other failed start.

A start that fails — outright or by a caught raise — is retried on the ladder
0.5, 1, 2, 5, 10, 30 s (`AudioBackoff`) for as long as audio is wanted; the first two
retries are quiet, from the third on the line carries the "audio failed" prefix that
becomes a toast, so a headset switch does not flash an error. The wake listener runs
the same quick ladder for four attempts and then reports `startFailed`, at which point
`WakeGate` takes over with its own 2 → 30 s backoff (it stops the listener while it
waits, so the two loops never race). On `AVAudioEngineConfigurationChange` both engines
stop, `reset()`, re-query the input format and log `before → after` (NSLog, prefixes
`Audio:` / `WakeListener:`; the tap's first buffer logs its real format once per start),
then rebuild after a short settle. Every level that leaves the audio code — the mic RMS
on the wire, the ear's RMS and noise floor, the per-channel energies — goes through
`clampLevel`: finite and 0…1, an empty buffer is 0, never 0/0.

`Scripts/objc-try-probe.sh` proves the shim without the app or a TCC prompt: a
mixer → output connection at 0 Hz and a channel-mismatched `scheduleBuffer` raise and
are caught; when the running process already holds the microphone grant it also
installs a tap on the *input* node with a format the device does not run and prints
the caught "Failed to create tap due to format mismatch" (the exact raise that crashed
the app — on a player node AVFoundation applies the format instead), shows the same
tap with `format: nil` not raising, then starts the voice `AudioEngine`, simulates a
configuration change and shows the formats before → after and the restart.
`Scripts/ear-probe.sh` compiles the shim in.

Device changes restart the graph, and a persistent failure is surfaced as a
toast rather than a silent "listening". `Settings.micDeviceId` (a Core Audio device
UID or numeric AudioDeviceID) is honoured only on the no-echo-cancellation path:
the voice-processing unit drives input and output from one device property, so with
echo cancellation on, the mic follows the **system default input** (pick it in
System Settings › Sound). Unknown ids fall back to the system default.

## Layout

```
Sources/Jarhead/App          main, AppDelegate, CrashGuard, StatusItem, Hotkeys, Menus
Sources/Jarhead/Daemon       RepoLocator, DaemonProcess, Wire, EngineClient
Sources/Jarhead/Audio        AudioEngine, VoiceProcessingPolicy + VoiceProcessingKnobs (the graph's wiring ladder and the unit's properties), PrivateRoute (Jarhead's own aggregate device), EchoGuard + EchoGuardModel (the software echo guard on the plain graph), AudioStateReadback (the HAL as it is now), ObjCTry (the Swift face of JHTry)
Sources/Jarhead/Ear          EarListener, SegmentedRecognizer, EarGrammar, EarThrottle, ReflexEar — the on-device ear behind the reflexes
Sources/Jarhead/Wake         WakeGate, WakeWordListener, LocalAuth, LocalSpeaker
Sources/Jarhead/Permissions  Permissions (PermissionsKit: the readers and panes), PermissionsRequests (one awaited prompt per kind), PermissionsSweep (PermissionsCenter: the list, the sweep, the dry run)
Sources/Jarhead/System       Notifications (the banner for a fired automation), SignalObserver (app launch/quit, sleep/wake, lock, displays, clock jumps → `system.signal` frames)
Sources/Jarhead/Model        Protocol.swift, AppState.swift (the contract; do not edit casually); ThreadStore (a thread's transcript pages), Remedy (a problem's remedy as a command), ProblemGlyphs, ComposerWords (the words the composer, the Say box and the thumbs share)
Sources/Jarhead/UI           Dither, Motion, HelpCopy (every surface's tips, described once), Thumbnails (screenshots decoded off the main thread); Orb (BlobField, BlobPhysics, BlobFleet + SatelliteBlob — one blob per thread, BlobTrail, FleetBudget, NotchPanel, NotchInk, OrbTrace, OrbPanelController, OrbExpandedView, OrbPreviewApp), Overlay (OverlayManager, OverlayAnnotations, MarkMode, OverlayPreviewDemo), Console, Onboarding
Sources/JarheadObjC          JHTry: the @try/@catch shim AVFoundation calls run inside
Resources                    Info.plist, entitlements.plist, preview-icon-sizes.png (the icon contact strip; the harnesses' other preview-*.png are gitignored)
Scripts                      orb-preview.sh (`--notch-checks`: every rule of the island as `check:` lines), console-preview.sh (scenarios incl. `threads`, `jarhead`, `jarhead-log`, `paused`), onboarding-preview.sh, protocol-probe.sh (the Swift mirror against fixtures/snapshot-threads.json), permissions-probe.sh (read-only readers + dry-run sweep), appstate-bench.sh, orb-home-probe.sh, ear-probe.sh, objc-try-probe.sh, audio-probe.sh, duck-probe.sh, duck-leak-probe.sh, recorder-probe.sh; *PreviewMain.swift / *ProbeMain.swift / AppStateBenchMain.swift; fixtures/ holds the probe fixture (snapshot-threads.json), the Console preview's ledger days (ledger-days.json) and the one fake screenshot the previews resolve
```

`Scripts/appstate-bench.sh` runs the model's acceptance checks (apps/mac has no XCTest
target): `AppStateBench` and `OnboardingBench`, behind `#if DEBUG`, drive `AppState` over
fixed snapshots and fail on a wrong derived value, so a Protocol.swift change is proven
there before it reaches the app.
