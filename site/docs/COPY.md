# jarhead.kevinliu.studio · copy deck

The only source of strings for the page. Written 2026-09-25 to Kevin's brief: fewer words, only the
important ideas, no metaphors, no interrupted sentences. The register is mailroom.kevinliu.studio.
Every claim re-checked against main 98c7cfe on 2026-10-06 (the launch claim sweep, W4-2).

Rules every string below obeys: short declarative sentences, one idea each, concrete nouns and verbs.
No em dashes. No parentheses inside a sentence. No inserted clause or trailing afterthought. No
"not X but Y". No exclamation marks. No marketing words. Nothing from `facts-product.md` §5's list.

Sources: `README:NN` is `/Users/kevinliu/jarvis/README.md` line NN; `AUTOMATIONS:NN` and `LOCAL:NN`
are `docs/AUTOMATIONS.md` and `docs/LOCAL.md`; `facts:NN` is `facts-product.md` in this folder;
`ICONS:NN` is `ICONS.md` in this folder. Verbatim commands keep their own punctuation.

h2 shape: two lines. Where the second line is marked *grey* it is the `--jh-fg-3` continuation.

The `eyebrow` entries are the phase word and hint for a dot, a badge or a tooltip at most; SPACE.md forbids
eyebrow LINES above a heading, so never set them as a line. The `desk caption` may be dropped.

---

## Nav

- brand: `Jarhead` (README:11)
- links: `Story` → `#story` · `Numbers` → `#numbers` · `Rails` → `#rails` · `Costs` → `#costs` · `Install` → `#install` (design.md:60, anchors unchanged)
- button, text tile: `GitHub` → `https://github.com/Kevin-Liu-01/Jarhead` (README:20)
- button, solid: `Install` → `#install`
- skip link: `Skip to content` → `#main`
- theme toggle labels: `Switch to dark` · `Switch to light`

---

## Hero

- h1, line 1: `Your Mac,` (README:14)
- h1, line 2: `by voice.` (README:14)
- lead: `Say jarhead, pass Touch ID, talk. It uses the computer for you. The brain is whatever you already have a login for.` (README:26, README:15, README:27)
- button, solid: `Install` → `#install`
- button, text tile: `Read the source` → `https://github.com/Kevin-Liu-01/Jarhead` (README:20)
- note under the buttons: `Send, pay, delete, post and purchase ask every time.` (README:362)
- figures line: `source only · MIT · macOS 14+ · Apple silicon · $0.05 / min, per second · 71 tools · 6 brains + auto` (facts:40-41, README:23, README:377, README:349, README:356). `v2.0.0` takes the first slot once the tag exists (D7); until then the page claims no release.
- desk caption: `menu bar 33 · notch 185×32 · island 420×184 · drawn at 1:1 · the Console is the app's own harness render` (facts:109, README:90)
- InstallPlate eyebrow: `INSTALL · ONE LINE`
- InstallPlate code: `curl -fsSL https://jarhead.kevinliu.studio/install.sh | sh` (README:41)
- InstallPlate button: `Copy` → `Copied`
- InstallPlate note: `Clones to ~/jarhead and runs the four commands. Never writes your keys. Read it first at https://jarhead.kevinliu.studio/install.sh` (README:37-38)
- blob aria-label: `Jarhead's blob, {phase}`

### Phase words and hints

- `Asleep` · `No session. The voice bills nothing.` (README:551, AUTOMATIONS:6-7)
- `Listening` · `The mic is open. The meter runs.` (README:56, README:551)
- `Thinking` · `The brain has the task.` (README:269-270)
- `Acting` · `The hands are using the Mac.` (README:28, README:60)
- `Speaking` · `It is talking. Say stop to interrupt.` (README:56)
- `Alarm` · `Rings asleep. The voice bills nothing.` (README:304-307, engine.ts:3208)

Island strings per kind stay as design.md §4.4 lists them; they are the app's own rendered text.

---

## 01 · Wake  `id="story"`

- eyebrow: `Listening` · `The mic is open. The meter runs.` · `O O`
- h2, line 1: `Asleep, it wakes on a word.` (README:57; paused, the word alone resumes, README:58)
- h2, line 2: `Touch ID opens it.` (README:365)
- lead: `Asleep it listens on-device for one word. The voice bills nothing. Then Touch ID, Apple Watch, the Mac password or a passphrase.` (README:57). Memory reads a closed conversation on your key at the next quiet tick (engine.ts:3208, :6111), so the voice is the subject.
- line 1: `Three misses lock the gate for a minute.` (README:57)
- line 2: `Speaker verification is not attempted.` (README:365)
- line 3: `Say stop. It stops mid-sentence.` (README:56)
- faces strip labels: `gate · heard · granted · denied · locked` (README:178)

---

## 02 · Say  `id="say"`

- eyebrow: `Thinking` · `The brain has the task.` · `- -`
- h2, line 1: `Codex, Claude Code, a key,` (README:27-28, README:59)
- h2, line 2 *grey*: `or a model on this Mac.` (README:59, LOCAL:3-4)
- lead: `Unambiguous commands reach the hands in milliseconds. The voice hands tasks to the brain. You pick the brain in Settings.` (README:61, README:269-270, README:59)
- open, for Kevin before the redeploy: the brain card's badge. Say.tsx sets `NUMBERS.figures[3].value` (`4.5 s`) beside the lead's second sentence while Codex is picked, with no label. That figure is the canned-hands harness (docs/latency/after.json, n = 6, 2026-09-12). Real use is 7.0 s median, 27.6 s p95 (n = 15, 2026-09-12 to 09-28). No deck string fixes it, since figure 4 also drives the Numbers race. Drop the badge in Say.tsx, or label it from a deck string such as `canned hands`.
- line 1: `"Click Save" runs. The voice is told after.` (README:61)
- line 2: `Same policy for every brain. A local one gets fewer tools.` (README:59, LOCAL:78-79, brain local.ts LOCAL_TOOLS)
- line 3: `A local brain keeps memory on the Mac.` (LOCAL:4-5, LOCAL:62-64)

---

## 03 · Threads  `id="threads"`

- eyebrow: `Acting` · `The hands are using the Mac.` · `o o`
- h2, line 1: `Several things at once.` (README:62)
- h2, line 2 *grey*: `Each with its own brain.` (README:62)
- lead: `"Tell Ben on Slack I'm late and put on Focus on Spotify" can split into two threads. Each has its own brain, conversation, budget and blob. Up to three run beside the main one.` (README:62)
- line 1: `Slack asks before it sends.` (README:140-141)
- line 2: `Spotify runs in the background by Apple events.` (README:62)
- line 3: `"Stop the Slack one" needs no model call.` (README:62)

---

## 04 · Hands  `id="hands"`

- eyebrow: `Acting` · `The hands are using the Mac.` · `> >`
- h2, line 1: `Label first. Click second.` (README:60)
- h2, line 2 *grey*: `Screenshot last.` (README:60)
- lead: `The hands are a Swift helper. They find a control by label and click it. A screenshot checks the work.` (README:28, README:60). The 71 tools are the brain's; 31 of them reach the helper. Not "only verifies": each delegation starts with a screenshot for a brain that takes images (engine.ts lookAtScreen).
- line 1: `Circle anything with ⌃⌥C. Every brain is told where it is.` (README:66). A brain that takes images also gets the image; a text-only one gets the coordinates alone (brain compatible.ts userContent, local.ts acceptsImages).
- line 2: `The blob moves to where the hands act.` (README:67)
- line 3: `The Console lists every coding-agent session.` (README:65)

---

## 05 · Rails  `id="rails"`

- eyebrow: `Speaking` · `It is talking. Say stop to interrupt.` · `^ ^`
- h2, line 1: `One policy table.` (README:361)
- h2, line 2 *grey*: `Run, confirm or refuse.` (README:361)
- lead: `Every call is run, confirm or refuse. The reason is spoken. No tool is special-cased.` (README:361)
- line 1: `A spoken yes covers one action once.` (README:362)
- line 2: `Your key or click holds it 1.5 s.` (README:63, README:353; scroll is in Numbers figure 12)
- line 3: `On-screen text is never an instruction.` (README:367)

### The never-list

- label: `NEVER`
- item 1: `mkfs` (README:364)
- item 2: `diskutil erase` (README:364)
- item 3: `dd onto a device` (README:364)
- item 4: `shutdown` (README:364)
- item 5: `rm -rf / or ~` (README:364)
- item 6: `Other apps' TCC resets` (README:364)
- item 7: `Every secret store` (README:364)
- closing line: `Send, pay, delete, post and purchase ask every time. A remembered yes never covers them.` (README:362-363)

---

## 06 · Sleep  `id="sleep"`

- eyebrow: `Asleep` · `No session. The voice bills nothing.` · `- -`
- h2, line 1: `Say good night.` (README:69)
- h2, line 2 *grey*: `Alarms still ring.` (README:301-305)
- lead: `It says "night." and closes the session. Ten minutes without a word to it do the same. Alarms, timers, watchers and routines fire while it sleeps.` (README:69, README:301-304, AUTOMATIONS:3-4)
- line 1: `No session. The voice bills nothing.` (AUTOMATIONS:6-7). Memory reads a closed conversation at the next quiet tick, on your key (engine.ts:3208, :6111), and a wake-brain row bills one brain turn (AUTOMATIONS §5).
- line 2: `Set-up asks once. Fire time never asks.` (AUTOMATIONS:11-13, README:310-312)
- line 3: `Nothing fires while Jarhead is quit.` (AUTOMATIONS:116-117). A clean quit stops the daemon at once; only a crash leaves it 90 s for the relaunch.

---

## Numbers  `id="numbers"`

- label: `the ledger`
- h2, line 1: `Measured on one Mac.` (README:331)
- h2, line 2 *grey*: `Written down.` (README:331)
- lead: `Measured on the author's Mac and written down. The harnesses are in the repo. Every latency carries its n and date.` (README:331, facts:388)
- lead figure: `3 ms` · `ear final to hands dispatch, median` · tooltip `6 ms p95 · real helper · n = 50 · 2026-09-11 · rerun under load 2026-10-06: 8 ms median, 58 ms p95, n = 30` (README:337, facts:308)

Figures, value · label · tooltip:

1. `126 ms` · `prefire partials, p95` · `122 ms median · scroll, page, screenshot, circle · includes the 120 ms window · n = 20 · 2026-09-11` (README:338, facts:308)
2. `457 ms` · `careful partials, p95` · `455 ms median · keys, edits, type, click · includes the 450 ms window · n = 30 · 2026-09-11` (README:339, facts:308)
3. `1.11 s` · `GPT-Live-1 spoken reply, median` · `1.21 s p90 · Agora, third party · n = 30 per condition · 2026-07-09 · typed, on the wire: 1.38 s median, 1.67 s p90, n = 10, 2026-10-06 · an earlier run that day, at c7d4e63: 1.89 s median, 2.25 s p90, n = 10` (README:345, facts:311, live-check LC-5: lc-5-first-word-094046-879.json and -001836-863.json, firstAudioMs; the harness prints the lower of the middle two, 1.35 s)
4. `4.5 s` · `delegation to first visible action, median` · `5.1 s p95 · Codex through the app-server · canned hands · n = 6 · 2026-09-12 · in real use: 7.0 s median, 27.6 s p95, n = 15, 2026-09-12 to 09-28` (README:341, facts:309, the ledger). docs/latency/after.json's six first actions are 3041 to 5099 ms; the middle two average 4.50 s. Its summary prints the lower one, 4.4 s.
5. `9.0 s` · `delegation to verified completion, median` · `25.6 s p95 · canned hands · n = 10 · 2026-09-12 · in real use: 13.3 s median, 50.0 s p95, n = 28, 2026-09-12 to 09-28` (README:342, facts:309, the ledger). The middle two average 9.02 s (after.json) and 13.3 s (the ledger); the summaries printed the lower ones, 8.9 s and 12.6 s.
6. `83 ms` · `tool round trip, median` · `518 ms p95 · real use · n = 162 · 2026-09-12 to 09-28` (the ledger; the middle two average 82.5 ms, the script printed 82)
7. `98 ms` · `screenshot round trip, median` · `311 ms p95 · real use · n = 72 · 2026-09-12 to 09-28` (the ledger; the middle two average 97.5 ms, the script printed 96)
8. `10.7k` · `input tokens, cold Codex thread` · `from 22.3k · −52 % · a private CODEX_HOME · measured on a cold thread, n = 1, 2026-09-12 · about 11.4k now, an estimate, w3-4-tool-parity` (README:348, README:84, REDESIGN:2015-2018; the date is the one brain w3-4-tool-parity's BR-16 title gives)
9. `$0.05` · `per minute of open session` · `billed per second, muted or not · a closed session costs nothing` (README:349)
10. `71` · `tools in ten families` · `16 permissions, 7 required · 6 brains + auto` (README:356)
11. `3` · `live threads beside the main one` · `25 steps / 180 s default · 40 / 300 cap · linger 30 s` (README:351)
12. `1.5 s` · `your key, click or scroll holds the hands` · `busy for 1500 ms` (README:353)
13. `2 s` · `liveness ping` · `two unanswered: drop and reconnect · 8 s silent: the daemon is killed and started again` (README:354)
14. `90 s` · `daemon linger after a crash` · `a clean quit stops it at once · relaunch at most 3 in 10 min · the Codex thread stays warm` (README:355, README:76)
15. `10 min` · `idle sleep` · `no word to it for 10 min · a setting · 30 min at most by default, whatever the room says · live-check LC-7 at a 1 min setting: asleep 60.3 s after the last word to it, room talk going on, n = 1, 2026-10-06` (README:350)

- line 1: `Reflex rows ran on pnpm jarhead bench, 2026-09-11.` (facts:308)
- line 2: `Model rows ran real Codex, canned hands, 2026-09-12.` (facts:309)
- line 3: `The spoken reply is Agora's measurement, 2026-07-09.` (facts:311)

---

## Costs  `id="costs"`

- label: `what it bills`
- h2, line 1: `Five cents a minute.` (README:551)
- h2, line 2 *grey*: `The voice costs nothing asleep.` (README:551; memory reads closed conversations asleep, README:553)
- lead: `The voice bills $0.05 a minute. It counts per second. Pause and Stop close the session.` (README:551)
- figures, value · label · tooltip:
  - `$0.05` · `per minute of open session` · `billed per second, muted or not` (README:551)
  - `$3` · `an hour of talking` · `the meter is on the island and in the Console` (README:551)
  - `$0` · `the voice, asleep` · `the wake word runs on-device · memory reads closed conversations on your key` (README:551, README:553)
- line 1: `Codex runs on your ChatGPT plan.` (README:552)
- line 2: `A local brain bills nothing. The voice does.` (README:552, LOCAL:4)
- line 3: `The Ledger tab totals each day.` (README:83)

---

## Made  `id="made"`

- label: `how it is made`
- h2, line 1: `Swift in the app.` (README:239)
- h2, line 2 *grey*: `TypeScript in the daemon.` (README:247)
- lead: `Jarhead.app is Swift. The daemon jarheadd is TypeScript. Two Swift helpers act on the Mac.` (README:239, README:247, README:260-264)
- line 1: `One 8×8 Bayer renderer dithers everything that shades.` (README:82)
- line 2: `The ledger is append-only. Nothing is deleted.` (README:71, README:74, README:368)
- line 3: `Its self-edits apply only on your yes.` (README:79)

---

## Install  `id="install"`

- label: `source only` (facts:40-41)
- h2, line 1: `Four commands.` (README:36-38)
- h2, line 2 *grey*: `Then say jarhead.` (README:51)
- lead: `Source only. One line clones the repo and runs four commands. Setup opens on first launch and writes your key.` (facts:40-41, README:36-38, README:386)
- plate eyebrow: `INSTALL · ONE LINE`
- plate code: `curl -fsSL https://jarhead.kevinliu.studio/install.sh | sh` (README:41)
- plate button: `Copy` → `Copied`
- plate note: `It checks macOS 14+, Apple silicon, Xcode 16's tools, Node 24 and pnpm 10. It clones to ~/jarhead and runs the four commands without the site's packages. It opens the app. It never writes your keys. Read it first at https://jarhead.kevinliu.studio/install.sh` (README:37-38, scripts/install.sh)

The four commands from README:47-50, one row each with a Copy tile; the comment is the row's note. Node 25 and newer ship
no corepack, so the note names no way to get pnpm; the installer prints one when pnpm is missing:

```bash
git clone https://github.com/Kevin-Liu-01/Jarhead.git && cd Jarhead
pnpm install && pnpm build:hands      # Node ≥ 24, pnpm 10, Xcode 16
pnpm build:mac                        # builds, signs, installs /Applications/Jarhead.app
open -a Jarhead                       # Setup opens: your OpenAI key, a brain, permissions
```

- fifth row, no Copy: `Then say "jarhead", pass Touch ID, talk.` (README:51)

- line 1: `Keys go into ~/.jarhead/env at mode 0600.` (README:390)
- line 2: `Sixteen permissions in one sweep. Seven required.` (README:77)
- line 3: `pnpm run doctor checks keys, brain and permissions.` (README:387)

Requirements, head `Requirements · 6`:

1. `macOS 14.5 or newer on Apple silicon` (README:377, README:383). Xcode 16 needs macOS 14.5 (scripts/install.sh:152), so the source install does too. The app itself runs on macOS 14, the hero's `macOS 14+`.
2. `Xcode 16 or newer` (README:383)
3. `Node 24 or newer and pnpm 10` (README:378-379)
4. `An OpenAI API key for the voice` (README:379)
5. `A brain you are already signed in to` (README:379-380)
6. `A Code Signing certificate, optional` · note `Self-signed is enough. Without one the build signs ad-hoc. Every rebuild then resets the permission grants.` (README:77, README:397-401, scripts/install.sh)

- Setup line: `Setup has seven steps. Welcome, Voice, Brain, Permissions, Wake, Agents, Done.` (README:81)
- onboarding alts: `Setup, Welcome` · `Setup, Brain` · `Setup, Permissions` · `Setup, Wake` (README:217-222)

Never on this page: "download", ".dmg", "cask", "Delete", "Empty Trash", a release asset URL (facts:381, facts:390, facts:397).

---

## Footer

- brand: `Jarhead` (README:11)
- line: `A voice-first Mac assistant that uses the computer for you.` (README:15)
- line: `Built with Swift and TypeScript.` (README:22)
- mono line: `source only · MIT`, the hero figures line's first two parts as Footer.tsx sets them (facts:40-41, README:569); `v2.0.0` takes the first slot once the tag exists (D7)
- disclosure 1: `Every picture is rendered by the app's own preview harnesses over fixed fake data.` (README:90-91)
- disclosure 2: `None is a photo of a desktop.` (README:91)
- disclosure 3: `The alarm's "Wake up, Kevin" is the harness's fixed data.` (facts:392, README:298)
- disclosure 4: `The voice speaks English only.` (facts:382)
- disclosure 5: `Brand marks from thesvg.org.` (ICONS:27)
- credit: `Built by Kevin Liu.` (facts:15-16)
- licence: `MIT.` (README:569)

---

## Alt text

One line per render, for whichever the build keeps. Sources are the README's own alt lines.

- `og.png` · `Your Mac, by voice. Jarhead's blob is the full stop. Each eye has a white star in it. The Install key is under the line.` (the share card, `app/card`)
- `notch-tucked.png` · `Tucked in the notch, asleep.` (README:98)
- `notch-peek.png` · `Peeking under the notch, awake.` (README:99)
- `notch-island.png` · `The island open while listening.` (README:106)
- `notch-island-working.png` · `The island acting. Two thread tiles, each with a Stop.` (README:107)
- `notch-island-marks.png` · `Three circled regions on the island.` (README:114)
- `notch-island-alarm.png` · `The island ringing an alarm while asleep. Snooze 10 and Done.` (README:298)
- `notch-stay.png` · `The blob beside its target ring. The notch is empty.` (README:129)
- `console-threads.jpg` · `The Console during a split. Slack asks before it sends.` (README:137-142)
- `console-conversation.jpg` · `A Claude Code session in the Console. Allow and Deny.` (README:146)
- `console-jarhead.jpg` · `A past conversation. Paused, resumed, then night.` (README:147)
- `console-ledger.jpg` · `The Ledger tab. A day's rows and what it billed.` (README:154)
- `console-settings.jpg` · `Settings. Voice, mic, brain, idle sleep, retention.` (README:155)
- `console-problems.jpg` · `Four typed problems, a remedy button on each.` (README:162)
- `console-cleanup.jpg` · `Pinned, Archived, Trash with Restore.` (README:163)
- `console-light.jpg` · `The Console in the light appearance.` (README:172)
- `console-automations.jpg` · `Automations in the Console. One row each.` (README:295)
- `blob-eyes.jpg` · `One face per state.` (README:178)
- `blob-fly.png` · `The blob beside its target ring, acting.` (README:185)
- `blob-gate.png` · `The wake gate. Touch ID or passphrase.` (README:186)
- `blob-drag.png` · `The blob dragged.` (README:187)
- `blob-trace.png` · `The blob drew a rectangle around the Deploy button.` (README:197)
- `blob-capsule.png` · `The capsule. Phase, meter, the exchange, the running step.` (README:204)
- `overlay-shapes.png` · `The overlay's shapes. Circle, arrow, rectangle, text, stroke.` (README:205)
- `icon-sizes.png` · `The Dock icon at 16, 32, 64, 128 and 256.` (README:229)

---

## Removed

Every metaphor and interrupted sentence in design.md §2, with its replacement. `d:NNN` is a design.md
line. "Cut" means the fact no longer appears on the page under the three-line cap; its source is
named so a reviewer can put it back.

### Hero (d:97-102)

- d:97 h1 `Say jarhead. Pass Touch ID. Talk.` → h1 `Your Mac, / by voice.`; the words move to the lead's first sentence.
- d:98 lead `A voice-first Mac assistant that uses the computer for you. The voice is GPT-Live-1, full duplex. The brain is whatever you already have a login for. The hands are a Swift helper on the real Mac.` → `Say jarhead, pass Touch ID, talk. It uses the computer for you. The brain is whatever you already have a login for.` GPT-Live-1 moves to Numbers figure 3 and the Costs lead; the Swift helper moves to the Hands lead.
- d:101 `Mic is hot.` (idiom) → `The mic is open. The meter runs.`
- d:101 `The brain is working.` → `The brain has the task.`
- d:101 `Jarhead is using the computer.` → `The hands are using the Mac.`
- d:101 `Jarhead is talking.` → `It is talking. Say stop to interrupt.`
- d:102 plate note `Clones the repo and runs the four build commands. macOS 14+ · Apple silicon · Xcode 16+ · Node ≥ 24 · pnpm 10. Read it first: jarhead.kevinliu.studio/install.sh` → `Clones to ~/jarhead and runs the four commands. Never writes your keys. Read it first at …`; the requirement list lives in Install.

### Wake (d:121-129)

- d:122 lead `Asleep it listens on-device for free. Awake only after Touch ID. Hearing "jarhead" opens nothing; Touch ID, Apple Watch, the Mac password or a passphrase does.` ("for free"; a semicolon sentence) → `Asleep it listens on-device for one word. The voice bills nothing. Then Touch ID, Apple Watch, the Mac password or a passphrase.`
- d:124 `Speaker verification is deliberately not attempted; the gate is Touch ID, never your voice.` ("X, never Y") → `Speaker verification is not attempted.`
- d:126 `Talks like a person` (metaphor) → cut as a heading; its fact `A spoken "stop" interrupts mid-sentence; the session stays open.` → `Say stop. It stops mid-sentence.`; `About a second to the first word back` → Numbers figure 3 with n and date (facts:388 wants the n and date beside it).
- d:127 `Twenty-two voices · English, whatever it hears. British by default (Ballad); American or no accent is a setting, heard at the next wake.` → cut (README:73). Facts: 22 voices, English only, British by default, American or none as a setting.
- d:128 `Other apps keep their sound · Awake, ducking sits at the least macOS allows, only while a voice is present, released the moment Jarhead stops. The microphone is a ranked list with fallback, re-read on route changes.` → cut (README:372, README:85). Facts: ducking at the OS floor, released at stop; Recording mode ⌃⌥R; the ranked mic.
- d:129 `One transport · Go · Pause · Stop. Pause and Stop both close the paid session, so the meter stops the moment you press. Go, or the wake word, resumes with the transcript as continuity. Mute keeps the session open.` → Costs lead `Pause and Stop close the session.` and Costs figure 1 `billed per second, muted or not`. Cut: Go resumes in a new session with the transcript as continuity (README:58); the hotkeys ⌥⇧Space, ⌥⎋, ⌃⌥M (README:451-457).

### Say (d:144-157)

- d:145 h2 `Tell Ben on Slack I'm late and put on Focus on Spotify.` → the Threads lead's first sentence; the Say h2 is now the brain list `Codex, Claude Code, a key, / or a model on this Mac.`
- d:145 lead `Unambiguous commands go straight through the hands in milliseconds. Everything else goes to the brain, and the brain is whatever you already have a login for.` (a joined clause) → `Unambiguous commands reach the hands in milliseconds. The voice hands tasks to the brain. You pick the brain in Settings.`
- d:146 the seven-row brain ledger and its foot `Every brain drives the same 71 tools through one runner, so policy, ledger, screenshots and the confirmation handshake are identical whichever model is thinking.` → `Same policy for every brain. A local one gets fewer tools.` Cut: the seven kind names and their one-liners (README:59, facts:70-77); `auto` never picks `local` (LOCAL:48).
- d:147-155 the SayStrip's eight said/read-back pairs → cut. They are quotes (README:26, README:61, README:62, AUTOMATIONS:21-22, README:510, facts:429-441); two survive in the Threads lead and line 3.
- d:157 `Reflexes under the model` (metaphor) → `"Click Save" runs. The voice is told after.`
- d:157 `The brain is a setting` (metaphor) → `You pick the brain in Settings.`
- d:157 `A local brain · Ollama, LM Studio or llama.cpp found on this Mac. Jarhead never pulls, installs, starts or deletes a model. The brain and memory stay here; the voice stays cloud and still bills.` → `A local brain keeps memory on the Mac.` and Costs line 2 `A local brain bills nothing. The voice does.` Cut: the three servers and ports (LOCAL:3-4); never pulls, installs, starts or deletes (LOCAL:5); needs tools and a 16k+ window (LOCAL:20, LOCAL:77).
- d:157 `Remembers you, quietly · After a conversation closes, a small model reads it once and keeps one-sentence items about you in an append-only store. At most 250 tokens a task, 120 a session, never read back to you. Forget hides. Off with one switch.` → cut (README:72). Facts: one-sentence items, 250 and 120 token caps, Forget hides, one switch.
- d:157 `One constitution · The standing orders have an explicit precedence: invariants and a never-list, then your words, then the task. Whatever it reads from a screen, page, file or transcript is data. Under 1250 words, versioned, pinned by tests.` → Rails line 3 `On-screen text is never an instruction.` Cut: the precedence order and the 1250-word cap (README:80).
- d:157 `Narrates intent · One clause per state change: "found the invoice", "typing the amount". Per-click lines stay on the Console's timeline.` → cut (README:70).

### Threads (d:169-175)

- d:170 lead `Several things at once, each a full Jarhead. Spotify on a background lane by Apple events, Slack on the screen lane. Each thread has its own brain, conversation, budget and blob, up to three beside the main one.` ("each a full Jarhead"; a trailing "up to three") → the new lead; `up to three` is its own sentence.
- d:172 `A tile per thread with its own Stop. The satellites peek under the island while they work. Ask "what is Spotify doing" or say "stop the Slack one" and the engine's table answers with no model call, without ending what you were saying.` → `"Stop the Slack one" needs no model call.` Cut: a tile per thread with a Stop; satellites peek under the island (README:62, README:68).
- d:174 `Notes and Spotify on the background lane finish on their own. Slack on the screen lane stops to ask before it sends. Every thread gets the same prompt, memory, screenshots and confirmation handshake as the main one.` → `Slack asks before it sends.` and `Spotify runs in the background by Apple events.` Cut: same prompt, memory, screenshots and handshake per thread (README:62).
- d:175 figures → Numbers figure 11. The lease footnote and `Main + 3 is the cap on purpose.` → cut (README:352).

### Hands (d:191-200)

- d:192 lead `71 tools in ten families. The hands are AX-first: find a control by label, read the focused text, click the element, screenshot only to verify.` (a colon list) → the h2 `Label first. Click second. / Screenshot last.` and the new lead. Cut: "AX-first"; read the focused text (README:60).
- d:193 the ten family chips → cut (README:60). The count stays in the hero figures line and in Numbers figure 10.
- d:195 `The blob flies to where the hands act and stays where it worked. Brains draw by hand: the blob becomes the pen and drags the line. Jelly drag, sticky walls, momentum.` (the pen metaphor; "brains draw by hand") → `The blob moves to where the hands act.` Cut: brains can draw shapes on screen through the blob (README:67, README:200); the drag physics.
- d:196 `Press ⌃⌥C, draw around anything. The mark snaps to the largest control under it and every brain gets the image with the task. Films of what you circled sit on the island; a used one dims.` → `Circle anything with ⌃⌥C. Every brain is told where it is.` Cut: the snap to the largest control; films on the island (README:66, README:114-117).
- d:197 `Lives in the notch · Tucked asleep, peeking awake, an island under the pointer: 420 by 184 points in four bands. Anchor, display, control row, foot. The peek carries glance chips, never sentences. Drag the blob into the notch and it sleeps.` → cut as a card; the hero desk shows the island live and its caption keeps `island 420×184` (README:68).
- d:198 `Knows your agents · The Console lists every Claude Code, Codex and other coding-agent session on the Mac with its own mark. Step into one, watch it grow live, answer its Allow · Deny, talk to it. Every utterance, tool call and grant is a row in an append-only ledger; the Console shows only what was recorded.` → `The Console lists every coding-agent session.` and Made line 2. Cut: step into a session, answer its Allow / Deny, talk to it (README:65).
- d:199 `A face per state` → cut; the hero's phase buttons show the faces (README:181).
- d:200 `Names its problems, remedy attached · … each is typed and carries its one-tap fix. The daemon answers a ping every 2 s.` → cut as a card; the ping is Numbers figure 13. Cut: typed problems with a one-tap fix (README:75).

### Rails (d:214-221)

- d:215 lead `One policy table decides run, confirm or refuse per call, with a spoken reason. Send, pay, delete, post and purchase ask every time, in every lane. A confirmation is your own spoken yes, for that action, once.` (three trailing phrases) → lead `Every call is run, confirm or refuse. The reason is spoken. No tool is special-cased.`, the never-list's closing line, and line 1 `A spoken yes covers one action once.`
- d:215 precedence line → cut (README:80).
- d:216 NeverPanel label `NEVER · REFUSED OUTRIGHT, IN EVERY LANE` → `NEVER`; the list keeps README:364's seven items; the line keeps README:362-363.
- d:217 § 1 `Go · Pause · Stop` → Costs lead. § 2 → the lead. § 3 → the closing line. § 4 `Same tool, same arguments, once. Return is never a yes.` → line 1; "Return is never a yes" cut (its source is outside the allowed set). § 5 `Scoped grants` → the closing line's second sentence; cut: one conversation, one app, one action class (README:363). § 6 `Your hands win` (metaphor) → `Your key or click holds it 1.5 s.`; scroll stays in Numbers figure 12; cut: a focus change mid-type cancels the type and says how many characters landed (README:63). § 7 → the never-list. § 8 `Presence gate` → Wake h2 line 2. § 9 `Secrets flow one way · Keys go into a 0600 file. Spawned processes get none; every text result passes a redactor before a model reads it.` → Install line 1 keeps the 0600 file; cut: spawned processes get no keys, the redactor (README:366). § 10 `Content is data` (metaphor) → `On-screen text is never an instruction.` § 11 → Made line 2. § 12 `No Delete anywhere` → Made line 2. § 13 `Unattended is the run tier` → Sleep lines 1 and 2. § 14 `Self-edits name their rails` → cut; Made line 3 keeps "apply only on your yes" (README:370). § 15 `The voice path never waits · Speech goes out and comes back as speech, waiting on no tool.` → cut (README:371).
- d:219 `Rewrites itself, carefully · "Jarhead, make your greeting one word shorter." A coding agent runs in a git worktree of the repo, typecheck, tests and the Swift build run, it tells you what changed and which rails it touched, and it applies only after your yes.` → Made line 3 `Its self-edits apply only on your yes.` Cut: the worktree, the checks, the rails report, fifteen minutes per edit (README:79, README:510-517).
- d:220 `Cleans up without deleting · Conversations Move to Trash, Archive, Restore, Rename, Pin. A move is a tombstone row; whole days move by rename and come back the same way. Retention is a setting whose default is forever.` → Made line 2. Cut: Archive, Rename, Pin; retention default forever (README:74, README:357).
- d:221 the rails list → cut (README:370).

### Sleep (d:232-239)

- d:233 lead `"That's all. Goodnight." It says exactly "night.", closes the session, tucks in. Alarms, timers, watchers and routines fire while it sleeps. Nothing billed.` ("tucks in") → `It says "night." and closes the session. Ten minutes without a word to it do the same. Alarms, timers, watchers and routines fire while it sleeps.`
- d:235 `Say it once while awake: "wake me at seven ten on weekdays", "twelve-minute timer for the pasta", "when a PDF lands in Downloads, file it under Papers and tell me", "run the backup script every night at eleven". It reads one line back. Then say night. The daemon carries it out from its 1 s tick with the agent asleep: no Live session, no brain turn, nothing billed.` → line 1 `No session. The voice bills nothing.` Cut: the four spoken examples and "it reads one line back" (README:301-304, AUTOMATIONS:21-28); the kinds and the action vocabulary (AUTOMATIONS:38-52).
- d:236 `The policy judges a row once, awake. Anything that would have to ask at fire time is refused when you set it. A recipe, a press or a brain wake asks once, cost said first. Rows Move to Trash and Restore.` → line 2 `Set-up asks once. Fire time never asks.` Cut: the brain wake's cost is said before your yes (AUTOMATIONS:10-12); rows are never deleted (AUTOMATIONS:13).
- d:237 `"Go to sleep", "that's all for now", "power down", "good night". Ten idle minutes do the same. "Shut down my Mac" is a task, and it asks.` → the lead's second sentence. Cut: the cue list; "Shut down my Mac" is a task (README:69).
- d:238 `The ring · A chime, the island opens pinned with the line and Snooze 10 · Done where Allow · Deny usually sit, a banner with the same two buttons. It re-chimes every 30 s and rings through quiet hours.` → cut; the alarm render's alt keeps Snooze 10 and Done (README:305-306, AUTOMATIONS:40).
- d:239 `Asleep costs nothing · The wake word runs on-device. A closed session costs nothing. Nothing fires while Jarhead is quit; Open at login brings it back. Memory learns only after a conversation closes.` → line 3 `Nothing fires while Jarhead is quit.` and Costs figure 3. Cut: Open at login is the remedy (README:312-313, AUTOMATIONS:127-128); memory learns only after a conversation closes.

### Numbers (d:249-254)

- d:250 lead `Measured on the author's Mac and written down; the harnesses are in the repo. Every latency below carries its n and its date.` (a semicolon) → three sentences.
- d:252 tile `1225 · words in the standing orders` → cut (its source is outside the allowed set). The other fifteen tiles keep their figures; labels are shorter.
- d:253 the nine ledger rows → cut except where a figure carries them: the bench gate, the model generation floor, speech end to delegation, the two "before" rows, the lease, retention (README:340, README:343-344, README:341-342, README:352, README:357).
- d:254 footnote → the three provenance lines and the tooltips.

### Costs (d:264-268)

- d:265 lead `$0.05 a minute, billed per second, only while a session is open. The meter is on the capsule, the island and the Console.` (stacked qualifiers) → `The voice bills $0.05 a minute. It counts per second. Pause and Stop close the session.`; the meter's places move to figure 2's tooltip.
- d:267 the nine rows → three figures and three lines. Cut: `claude-code` on your Claude login; the three API brains bill their own keys; memory's ≈ 20k tokens a day; the benchmarks spend nothing (README:552-554).
- d:268 caption `… 17.0 min · $0.85 on the harness's fixed data.` → the alt `The Ledger tab. A day's rows and what it billed.`

### Made (d:276-283)

- d:277 lead `Three processes over a unix socket: Jarhead.app in Swift, jarheadd in TypeScript, jarhead-hands as two Swift helpers, focus and background. The app spawns the daemon or attaches to one already running; the daemon outlives the app.` (a colon list; a semicolon) → three sentences. Cut: the unix socket; focus and background lanes; the daemon outlives the app (README:246, README:260-264, README:272-273). That last one is false as worded: a clean quit stops the daemon at once.
- d:278 `Flat fills stay flat. Anything that shades, the island, the blob's halo, the Dock icon, the Console grounds, the meters, is banded and dithered by one renderer, the classic 8×8 Bayer matrix in point-sized cells. Loading states are dither glyphs. Respects Reduce Motion.` (an inserted list) → `One 8×8 Bayer renderer dithers everything that shades.` Cut: the list of surfaces, dither-glyph loading states, Reduce Motion (README:82).
- d:279 `One Jarhead · pnpm build:mac installs in place with rsync. The running app keeps its inodes, the Dock pin keeps its bookmark and, signed with a real identity, TCC keeps its grants.` → cut (README:78); the signing fact lives in Install requirement 6.
- d:280 `A clean Codex home` → Numbers figure 8.
- d:281 `Comes back from a crash` → Numbers figure 14.
- d:282 `The Console and its kit` → cut (its source is the release draft, outside the allowed set).
- d:283 `Two homes` → cut (README:204, README:155).

### Install (d:296-305)

- d:297 lead `Open source, MIT, four commands to build. One line clones the repo and runs them; Setup opens on first launch and writes your key.` (a semicolon) → `Source only. One line clones the repo and runs four commands. Setup opens on first launch and writes your key.`
- d:298 plate line `What it does, in order: checks …; clones …; runs …; opens the app. Run it again to pull and rebuild. Read it first: …` → four short sentences and the URL. Cut: a re-run pulls and rebuilds (design.md §6, not a README fact).
- d:299 rows → README:47-50 verbatim; the notes are the README's own comments.
- d:300 keys paragraph → Install lines 1 and 3 and requirement 6's note. Cut: the app only ever sees that a key exists (README:81); the doctor is red on the key until Setup writes it (README:387).
- d:301 hotkeys strip → cut (README:451-460).
- d:302 requirements → six short lines; `corepack enable` and `tool-capable model` cut from the lines (README:379, facts:321).
- d:303 Setup steps with their notes → the one Setup line. Cut: the per-step notes (README:81).
- d:305 permissions note → line 2 `Sixteen permissions in one sweep. Seven required.` Cut: the seven's names; macOS grants nothing programmatically (README:462-474).

### Footer (d:317)

- d:317 disclosure `Every picture on this page is rendered by the app's own preview harnesses over fixed fake data; none is a photo of a desktop. The alarm text says the author's name because the harness does. The voice speaks English only. Apple silicon, macOS 14 or newer.` (a semicolon; a "because" tail) → five one-sentence disclosures; `Apple silicon, macOS 14 or newer` is in the mono line.
