#!/usr/bin/env bash
# Throwaway preview of the Console window with fake data.
#   Scripts/console-preview.sh [scenario] [out.png]
# scenario: live | confirm | empty | settings | wake-locked | ledger | light |
#           conversation | conversation-codex | jarhead | jarhead-log | paused | switch |
#           cleanup | cleanup-select | cleanup-rename | cleanup-undo | cleanup-undo-toast | cleanup-log |
#           search | search-hit | problems | cleared | loading | wipe | timing |
#           memory | durability | threads | thread-pane | thread-answer | thread-history | typed-row | agent-pending |
#           local | local-empty |
#           menu-voice | menu-voice-filter | menu-model | menu-backend | menu-escape | menu-outside |
#           menu-click-through | tip-click | cold-click |
#           tip-thread | tip-key | tip-warm | tip-thumb | toggle | settings-index | permissions-groups |
#           problems-groups | ledger-months | memory-chips | list-keys | list-verbs | agents-groups |
#           rail | rail-expanded | rail-asleep | rail-agents | rail-search | rail-keys | rail-midnight |
#           automations | automations-ring | settings-automations |
#           settings-audio | toggle-recording | resumed (default live)
#   The stream ids (design13, Builder A): `resumed` is a paused → resumed conversation as the engine holds it — the
#   held session's seven rows before the live session's five — with `check-stream@0.3,republish@0.6,append@0.9,
#   check-stream@1.2`: `check-stream` prints `check:` lines (entry ids unique · caret on the newest utterance · the
#   AX row texts in order == the snapshot's texts · after `append`, one more row and the appended line last) and
#   ends `check: all ok (stream)`; `republish` is the audio-state path (the same snapshot published again).
#   The audio pass (design12, Builder C): `settings-audio` is Settings › Audio with the engine's read-back from the fixture
#   `aec-airpods` (Hears `Kevin's AirPods Pro · 24 kHz · echo cancelled`, Speaks `16 kHz · narrowed`, the `echoFollows`
#   sentence, Recording Off); `toggle-recording` focuses the Recording toggle, snaps, presses Space (`send:` must carry
#   {"audio":{"recording":true}} and nothing else), lands the `recording-macbook` read-back (`echo guarded`, `Shared with
#   QuickTime Player.`), snaps the folded head with `[recording]` and ends open with the On hint. Both run `check-kit` (the
#   Audio head both spellings, the toggle-hint join with `shares the mic`, the 112 pt and 182 pt measures, the words).
#   The left rail (design10): `rail` is the threads fixture with the Trash and one hidden agent — Now bright with
#   its dot, `Threads 3 · 1 asks`, the pinned over conversation on a grey orb at 0.72, Today open (bright, `×1`),
#   `› Yesterday n … min`, `› Older 3 … since <day>`, Archived `2 · 15 min`, Claude Code open with `[asks]`,
#   `● working` ×2, `kevin-wiki idle · 31m` at 28 and `› Ended 1 … 7m`, Codex folded to `ended · 40m`, Cursor to
#   `1 idle`, Amp open. `rail-expanded` opens Yesterday (two grey rows, `—` last at 0.48) and Older (its sticky
#   day heads) and pins yesterday's card (`ran · started`; `probe-floats:` names `rail.chain.<id>`). `rail-asleep`
#   is the same asleep (PREVIEW_PHASE=asleep: the Now orb grey, today's rows bright, the header's mark blue).
#   `rail-agents` (asleep) opens Claude Code's `Ended` (the ring on it), the dead Codex group (three over rows,
#   no sub-head) and Hidden (Unhide at full on a 0.48 row), the rail scrolled to the agents. `rail-search` is
#   `codex`: `Hits n` · `Agents n` (a Titles head and an orphan day head appear only when a title matches
#   without hits / a hit's session is off the rail — not in this fixture), every result at 1.0 with its tint,
#   the hidden agent the query names among them with its Unhide (`rail-probe:` lists the walk). `rail-keys`
#   rings the pinned row, ↓↓↓ onto Yesterday's head, → opens it
#   (`rail-probe:` before and after: two more ids). `rail-midnight` is reserved (PREVIEW_NOW is not built).
#   Every one runs `check-kit@0.3` (the ladder's pins in checkKitLeftRail) and ends `check: all ok (kit)`.
#   The component kit (design9): `menu-voice` / `menu-voice-filter` / `menu-model` / `menu-backend` are the
#   rebuilt dropdowns open on the ConsoleFloatLayer (the popup under its field, groups, the badge column,
#   the filter strip, the foot; keys through the responder chain: `keyDown:m+a`, `keyDown:down+return`),
#   `menu-escape` / `menu-outside` the layer's contract, `toggle` the Wake word `On | Off` flipped by Space.
#   run.log ends with the `probe-floats:` rects and `check: all ok (kit)` (placement, the menu model, the
#   sites' words, tips, badges, copy). The Settings-tab fields answer their ids: `settings.voice`,
#   `settings.mic`, `settings.backend`, `settings.model` (LocalModelMenu; `menu-model` ends
#   `check-floats:settings.model`, so a popup that never reached the layer fails the run), `settings.effort`,
#   `settings.wakeWord`, `settings.check`. `settings-index` is Settings as seven folded heads carrying their
#   summary (Memory opened by id); `permissions-groups` the Now rail's Permissions areas Senses / Hands / Files
#   (rows 40 with the why on line 2); `problems-groups` the Problems kinds Grants / Engine (Engine folded);
#   `ledger-months` the Ledger's forty days by month, two August days and Sep 10 read, then ↓ ⏎ over the list;
#   `memory-chips` the memory rail's kind chips (`chip:fact`) and a row's card; `list-keys` the left rail's
#   search with ↑↓ ⏎ over the hits; `agents-groups` the agents per tool with Codex folded (`1 asks`).
#   `list-verbs` rings yesterday's conversation row and presses ⌘↓: its verbs float under the row
#   (`check-floats:rail.chain.<id>.verbs`). The tips: `tip-thread` pins the thread card beside the right rail's
#   Slack row (the same ConsoleTipCard.thread the stream's chip and the left rail draw), `tip-key` gives the
#   Brain section's Check focus and presses `?` (the pinned bubble and the one key ring), `tip-warm` runs the
#   real 350 ms delay (hover Go, leave, hover Mute within 400 ms → at once; run.log's `tip:` trail and
#   `check: … (tips)`), `tip-thumb` opens Slack's pane and pins the header thumb's preview; `menu-escape` /
#   `menu-outside` drive the layer's closing contract on the Voice popup (Esc; a click at (300,300)) and end
#   `check: … (floats)`. Every one runs `check-kit@0.3` and ends `check: all ok (kit)`.
#   The automations pass (design11, Builder D): `automations` is the Now rail with the mockup's six rows —
#   Clock 4 (the alarm, the pasta timer ticking, call mum snoozed, the standup routine) · Watchers 2
#   (Downloads → Papers, build red paused) · the Trash fold open with one row · the honest line — under the
#   ring row `07:10 · Wake up, Kevin [Snooze] [Done]`, with the Downloads → Papers card pinned over the
#   stream (`check-floats:now.automation.auto_papers`). `automations-ring` is the same ring row on the Ledger
#   tab (it sits under the tabs on every tab) with its card pinned, then `ringing:off` / `ringing:<id>`
#   (run.log's `probe-ring:` lines say nil, then the id). `settings-automations` is Settings › Automations
#   (`automationsFold`): the On|Off switch, the eight chips (the run tier outlined), quiet hours 23:00 → 07:00,
#   Snooze 10 min, Brain minutes 5 /day, Recipes 3 with vpn-up wearing `asks` (the `recipesAsks:<names>` key) and
#   the Trash fold open on old-sync with Restore (a recipe is never deleted), Open at login. The harness keys:
#   `ringing:<id|off>`, `recipesAsks:<a,b>`, `automationsFold`, `probe-ring`.
#   check-kit pins the four badge words, AutomationWords, the summary, ConsoleFormat.clock / countdown, a row's
#   line per kind, the card's spoken form, the ring split, the recipe meta, and the Add… form: the phrase rides as
#   `whenPhrase` (core's parseWhen is the one grammar; the form parses nothing), the cost line and the recipe line
#   verbatim from core's policy (the two-press shows them before the yes), the trashed recipe row (check-automations).
#   The Local brain pass: `local` is Settings › Brain with Backend → Local model and Ollama 0.34.0 up
#   with six models — the Model row a menu whose collapsed title says `best fit · qwen3.5:27b`, no
#   Server row (the server was found, nothing is pinned), no Key row, the Status line `Local · …`,
#   and the new `Leaves the Mac` section (voice cloud · brain mac · memory mac · web cloud);
#   `local-empty` is the Now tab with the server up but nothing on it that can call tools: the amber
#   `brain.local` row with its Retry and Copy (`ollama pull qwen3.5:27b` — never run here) and the
#   Ready row's detail naming the fallback `openai-responses`. Both print the pass's `check:` pins
#   (check-local) into .build/console-preview/run.log: Model row is a menu, Server row hidden, no Key
#   row, Ready detail is the id, the Problems row has Copy, four data-path rows.
#   The Threads pass: `threads` is Jarhead's threads (Snapshot.threads → AppState.threads) — the main
#   thread idle, Spotify acting (background), Slack waiting on Kevin (screen) with its question, Notes
#   done and lingering — the left rail's Threads section (waiting-kevin → busy → idle main → finished;
#   glyph · name · status word; `00:12 · screen · 7 steps`), the right rail's Threads section (Stop per
#   live row), the parent card's thread chips; its default actions print the pass's `check:` pins
#   (check-threads) into .build/console-preview/run.log and end Spotify by an `ended` event at 1.6 s.
#   `thread-pane` steps into Slack's pane (its brief as the card's request, its own steps and screenshot,
#   the confirm step with Allow / Deny, the question strip over the composer, Stop hot, "‹ Now");
#   `thread-answer` then Allows the way the strip does: run.log's `send:` line must be
#   {"type":"thread.answer","threadId":"t_sl4ck00","yes":true} — never say-text, never stop.
#   `typed-row` is a line Kevin typed (TranscriptItem.source "typed"): keyboard.fill on its row;
#   PREVIEW_PHASE=asleep shows the composer's "Type to Jarhead… (asleep: press Go)". `agent-pending`
#   sends a line into the blocked Claude session at 0.5 s (the pending echo at 0.6 opacity under
#   clock.fill, snapped to -mid.png at 1.0 s) and lands the real turn at 1.6 s (the echo is gone;
#   `probe-pending` lines say pending 0→1→0). PREVIEW_SETTLE=2.4 for these.
#   `memory` is the durable memory of Kevin: the Settings tab scrolled to its Memory section — the
#   Remember toggle, Matching, the counts ("7 live", "1 forgotten · 1 archived", "1 waiting"), "learned 12m ago"
#   beside Learn now, the budget hint,
#   and the rail under them (search, Live | Forgotten | Archived, the rows with Edit / Forget / Restore
#   behind ⋯ and the context menu, the Forget hint — never a deletion verb). Its default actions print
#   the pass's `check:` lines (check-durability) into .build/console-preview/run.log, then drive the
#   rail's verbs through its own rows (Forget m_dark, Edit m_kev, Forgotten's Restore m_light, back to
#   Live): run.log must carry `send: memory.forget` / `memory.edit` (no kind) / `memory.restore` and a
#   `memory-rail:` line per verb saying the row left at once. PREVIEW_SETTLE=3 for it.
#   `durability` (was `threads` before the Threads pass took the name) is long-horizon durability: the
#   ended Codex thread stepped into — no live dot (isLive is derived from status + connection, never the
#   stale tail flag), its last tool call `interrupted` (settled grey, no pulse), a 1 200-message
#   transcript the model trims to 400 — then a daemon reconnect at 1.0 s, the window hidden at 1.4 s and
#   shown at 1.8 s: run.log must carry agent.open, agent.close, agent.open naming ONE viewer; then "Load
#   earlier" (60 rows, mode prepend) at 2.4 s between two `geometry` lines: the bottom stays pinned
#   (distance 0) and `shown 400→460`. PREVIEW_SETTLE=3.4 for it. PREVIEW_CONNECTED=0 on `live` is the
#   caret gate's control (the streaming caret must not blink while disconnected).
#   `loading` is the dither pass's loading states: a ledger day picked and its read pinned in
#   flight, a search pinned in flight — the stream's "Reading…" (16×2 glyphs), the rail's
#   "Reading" row and the Jarhead section's "Searching…" (8×1); its default action prints the
#   `check:` pins for the dither arithmetic (Bayer ranks, wipe tiles, glyph lines, bar cells).
#   `wipe` is the dither curtain: the Jarhead chain stepped into at 1.2 s and snapped mid-wipe
#   (<dir>/preview-console-wipe-mid.png: the arriving pane emerging through the crosshatch
#   from a sheet of ground-coloured cells, the leaving pane gone under it), Now shown again at
#   4.2 s and snapped mid-wipe-back, then `probe` (the state under the curtain must have
#   survived). The mid pictures are pinned to the wipe itself (`snap-wipe:` arms
#   Motion.wipeMidHook; the curtain reports its first frame at 0.4 of the ranks and the window's
#   own pixels are snapped, in-process, 0.05 s later) with the wipe stretched to 2 s for this
#   scenario (PREVIEW_WIPE_SECONDS, nil in the app): a `shot:` goes through screencapture and
#   lands 0.1–0.3 s late. PREVIEW_SETTLE=8 for it (the actions run to 6.6 s plus the launch's offset).
#   `timing` is the pane switch at REAL speed, traced from the run loop: eight switches (the Jarhead
#   chain in and out, the blocked Claude session in and out, the rail's tab to Settings and back, a
#   ledger day in and out), each between `trace:<label>` and `trace-stop`; run.log carries a
#   `frame: t=… cost=…` line per main-thread turn of 4 ms or more around the switch (stamped "+ms"
#   from it; any turn over 50 ms wherever it lands) and a `timing: <label> …` summary per switch:
#   the switch turn (the frame the switch is made in), the wipe's frames and their longest, then
#   everything after (count, longest, over 50 ms, the busy sum). The budget: no wipe frame over
#   50 ms. PREVIEW_NO_LEVELS=1 is its control (the meters still). PREVIEW_SETTLE=12 for it.
#   PREVIEW_SLOW_THUMBS=1 holds every screenshot thumbnail for a minute before it decodes, so
#   the dithered skeletons are what a shot shows (`conversation` → preview-console-skeleton.png).
#   PREVIEW_ACTION=probe-ground@1.5 prints the distinct colours of three blocks of the window's
#   ground (top-left: ink only; bottom-right: the whisper; bottom-middle: the raised step).
#   `ledger` and `jarhead-log` carry the `sleep` row ("asleep · idle", "asleep · said “…”"); the
#   `threads` scenario's default actions print the sleep-word `check:` pins (check-sleep) too.
#   The cleanup scenarios: `cleanup` is the rail with a pinned chain above the days, "Archived (2)"
#   folded, "Trash (2)" open with Restore on each row and the folder on its head, and the Agents
#   section's "Hidden (1)" open; `cleanup-select` adds two ⌘-picked chains and the strip under the
#   head; `cleanup-rename` the inline title field; `cleanup-undo` a chain just moved to the Trash
#   and the toast "Moved to Trash · Undo"; `search` the head as the search box with hits grouped
#   by conversation; `search-hit` searches "codex did while" and opens its one hit the way the row
#   would (the conversation scrolled to the row, lit; run.log's `probe:` line says what landed);
#   `cleanup-undo-toast` presses the toast's Undo then ⌘Z then ⇧⌘Z (run.log: ⌘Z must find nothing);
#   `problems` the Now tab's typed problems with a remedy each; `cleared` the Now stream cleared
#   ("Cleared · Undo").
#   `settings` is asleep with the wake gate listening (Settings tab); `wake-locked`
#   the same tab with the gate locked out and no passphrase set.
#   `jarhead` steps into a past Jarhead conversation (the paused → resumed chain,
#   read-only, Conversation view); `jarhead-log` shows the same one as its ledger log;
#   `paused` is the live session paused (the rail's Now row: "paused · meter stopped").
#   `conversation` steps into the blocked Claude Code session (its transcript, a
#   permission question with Allow / Deny, circled regions in Now); `conversation-codex`
#   steps into the finished Codex thread.
#   `switch` is the motion pass: it steps into the Jarhead chain, shoots the crossfade
#   halfway (<dir of out.png>/preview-console-switch-mid.png), comes back to Now, appends
#   two lines and prints the stream's scroll geometry before and after (distance must
#   stay 0: the bottom is pinned, rows fade in on their own ink); out.png is the settled
#   second moment. PREVIEW_SETTLE defaults to 5.2 s for it.
#   `light` is the live scenario in the aqua appearance; PREVIEW_APPEARANCE=light|dark
#   pins the appearance for any scenario (default dark, so shots are deterministic).
#   PREVIEW_BRAIN=<BrainKind raw> swaps the brain; PREVIEW_GATE=off|awake overrides
#   the wake gate (switch off / resting because the engine is awake); PREVIEW_ACTION
#   scripts clicks and feed changes, each with an optional `@seconds` — see ConsolePreviewMain.
#   PREVIEW_REDUCE_MOTION=1 pins Motion.reduced on (plain fades, halved durations, no
#   rise/slide), so the Reduce Motion path can be shot without touching the Mac's setting.
# Compiles Model + Permissions (the kinds' words) + UI + UI/Console + Scripts/ConsolePreviewMain.swift into its own
# output directory (never the shared .build products), shows the window,
# screenshots it (if out.png given) and exits; without out.png it stays open.
# Shots taken while the Mac is locked (loginwindow frontmost) render the window
# inactive: grey traffic lights, switches in the inactive grey even when on.
set -euo pipefail
cd "$(dirname "$0")/.."
SCENARIO="${1:-live}"
OUT="${2:-}"
case "$SCENARIO" in
  live|confirm|empty|settings|wake-locked|ledger|light|conversation|conversation-codex|jarhead|jarhead-log|paused|switch|cleanup|cleanup-select|cleanup-rename|cleanup-undo|cleanup-undo-toast|cleanup-log|search|search-hit|problems|cleared|loading|wipe|timing|memory|durability|threads|thread-pane|thread-answer|thread-history|typed-row|agent-pending|local|local-empty) ;;
  # The component kit's scenarios (design9): the dropdowns, the tips, the toggle, the folds, the lists.
  menu-voice|menu-voice-filter|menu-model|menu-backend|menu-escape|menu-outside|tip-thread|tip-key|tip-warm|tip-thumb|toggle|settings-index|permissions-groups|problems-groups|ledger-months|memory-chips|list-keys|list-verbs|agents-groups) ;;
  # The left rail (design10).
  rail|rail-expanded|rail-asleep|rail-agents|rail-search|rail-keys|rail-midnight) ;;
  # Automations (design11): the Now section with the ring row, the ring on the Ledger tab, Settings › Automations.
  automations|automations-ring|settings-automations) ;;
  # The audio pass (design12): Settings › Audio's route rows and the Recording toggle.
  settings-audio|toggle-recording) ;;
  # The stream ids (design13, Builder A): the resumed conversation's rows, checked before and after a republish and an append.
  resumed) ;;
  # The click path (design13, Builder B): one click acts while a menu or a tip is open, or the window is cold.
  menu-click-through|tip-click|cold-click) ;;
  *) echo "unknown scenario: $SCENARIO (see the list at the top of $0)" >&2; exit 2 ;;
esac
BUILD=".build/console-preview"
mkdir -p "$BUILD"
# PREVIEW_SKIP_BUILD=1 reuses the last binary (a run of several scenarios compiles once).
if [[ "${PREVIEW_SKIP_BUILD:-}" != "1" || ! -x "$BUILD/console-preview" ]]; then
  swiftc -O -swift-version 5 -parse-as-library -target arm64-apple-macosx14.0 \
    -o "$BUILD/console-preview" \
    Sources/Jarhead/Model/*.swift Sources/Jarhead/Permissions/*.swift Sources/Jarhead/UI/*.swift Sources/Jarhead/UI/Console/*.swift Scripts/ConsolePreviewMain.swift
fi
export PREVIEW_SCENARIO="$SCENARIO"
export PREVIEW_STATE_DIR="${PREVIEW_STATE_DIR:-$(cd Scripts/fixtures && pwd)}"
export PREVIEW_SHOT_PNG="${PREVIEW_SHOT_PNG:-preview-orb-expanded.png}"
# Where a `shot:<name>` action writes: next to out.png (Resources when there is none).
export PREVIEW_OUT_DIR="${PREVIEW_OUT_DIR:-$(cd "$(dirname "${OUT:-Resources/x.png}")" && pwd)}"
if [[ -n "${PREVIEW_APPEARANCE:-}" ]]; then export PREVIEW_APPEARANCE; fi
if [[ -n "${PREVIEW_ACTION:-}" ]]; then export PREVIEW_ACTION; fi
if [[ "$SCENARIO" == "switch" ]]; then PREVIEW_SETTLE="${PREVIEW_SETTLE:-5.2}"; fi
if [[ "$SCENARIO" == "wipe" ]]; then PREVIEW_SETTLE="${PREVIEW_SETTLE:-8}"; export PREVIEW_WIPE_SECONDS="${PREVIEW_WIPE_SECONDS:-2}"; fi
if [[ "$SCENARIO" == "timing" ]]; then PREVIEW_SETTLE="${PREVIEW_SETTLE:-12}"; fi
if [[ "$SCENARIO" == "durability" ]]; then PREVIEW_SETTLE="${PREVIEW_SETTLE:-3.4}"; fi
# The Settings-tab kit scenarios open on the Settings tab like `settings` does (the harness selects it);
# `menu-model` is shot tall so the Model popup's eight rows and its foot are whole (the 760 window scrolls them).
case "$SCENARIO" in menu-voice|menu-voice-filter|menu-backend|menu-escape|menu-outside|tip-key|toggle|settings-index|settings-audio|toggle-recording) export PREVIEW_WINDOW_SIZE="${PREVIEW_WINDOW_SIZE:-1180x760}";; esac
# The audio scenarios: the read-back lands at 0.5 s; `toggle-recording` runs its keys, the second read-back and the folds to 3.2 s
# (the closed snap at 3.0 s, once the fold's animation has landed).
if [[ "$SCENARIO" == "settings-audio" ]]; then PREVIEW_SETTLE="${PREVIEW_SETTLE:-1.6}"; fi
if [[ "$SCENARIO" == "toggle-recording" ]]; then PREVIEW_SETTLE="${PREVIEW_SETTLE:-3.8}"; fi
# `resumed` runs its checks to 1.2 s (the second check-stream after the append).
if [[ "$SCENARIO" == "resumed" ]]; then PREVIEW_SETTLE="${PREVIEW_SETTLE:-1.8}"; fi
if [[ "$SCENARIO" == "menu-model" ]]; then export PREVIEW_WINDOW_SIZE="${PREVIEW_WINDOW_SIZE:-1180x1040}"; fi
# The click path (design13): `menu-click-through` is the `local` fixture tall like `menu-model` (Voice and Model both on
# screen) and drives three clicks to 4.15 s; `tip-click` and `cold-click` run their one click and the press check by 2 s.
case "$SCENARIO" in menu-click-through) export PREVIEW_WINDOW_SIZE="${PREVIEW_WINDOW_SIZE:-1180x1040}"; PREVIEW_SETTLE="${PREVIEW_SETTLE:-4.5}";; esac
case "$SCENARIO" in tip-click|cold-click) export PREVIEW_WINDOW_SIZE="${PREVIEW_WINDOW_SIZE:-1180x760}"; PREVIEW_SETTLE="${PREVIEW_SETTLE:-2.4}";; esac
# The dropdown scenarios drive keys to ~2.6 s (a filter typed, ↓ Return, the probes) before the shot.
case "$SCENARIO" in menu-voice|menu-voice-filter|menu-model|menu-backend|menu-escape|menu-outside|toggle) PREVIEW_SETTLE="${PREVIEW_SETTLE:-3}";; esac
# The right rail's scenarios (Builder D): `ledger-months` picks two August days and Sep 10, then ↓ ⏎ on the list
# (to 2.4 s); the Permissions areas and Problems kinds open their folds by id (to 0.8 s).
if [[ "$SCENARIO" == "ledger-months" ]]; then PREVIEW_SETTLE="${PREVIEW_SETTLE:-3}"; fi
case "$SCENARIO" in permissions-groups|problems-groups|settings-index) PREVIEW_SETTLE="${PREVIEW_SETTLE:-1.8}";; esac
# The Threads pass's scenarios run their actions to 1.8 s (an `ended` event, an Allow, a landed turn).
case "$SCENARIO" in threads|thread-pane|thread-answer|typed-row|agent-pending|tip-thumb) PREVIEW_SETTLE="${PREVIEW_SETTLE:-2.4}";; esac
# The pane header keeps its buttons and figures before the thumb (ViewThatFits): a wider window holds the thumb the preview hangs from.
if [[ "$SCENARIO" == "tip-thumb" ]]; then export PREVIEW_WINDOW_SIZE="${PREVIEW_WINDOW_SIZE:-1400x760}"; fi
# `thread-history` (the paged main pane: scroll up, Load earlier, the page lands, geometry after) runs to 2.3 s.
# Its run.log: `send: {"type":"thread.history",…,"before":2}`, `action: thread-history main … orphans 4→0 … complete false→true`,
# and two `geometry` lines whose `distance` agree (the row Kevin was reading stayed put while the page grew above it).
if [[ "$SCENARIO" == "thread-history" ]]; then PREVIEW_SETTLE="${PREVIEW_SETTLE:-2.9}"; fi
# The left rail's scenarios: a tall window so the rail is whole; `rail-asleep` and `rail-agents` with nothing live;
# the staged ones run their folds, tips and keys to 1.3–2.0 s before the shot.
case "$SCENARIO" in rail|rail-expanded|rail-asleep|rail-agents|rail-search|rail-keys|rail-midnight) export PREVIEW_WINDOW_SIZE="${PREVIEW_WINDOW_SIZE:-1180x1040}";; esac
case "$SCENARIO" in rail-asleep|rail-agents) PREVIEW_PHASE="${PREVIEW_PHASE:-asleep}";; esac
case "$SCENARIO" in rail-expanded|rail-search) PREVIEW_SETTLE="${PREVIEW_SETTLE:-2.2}";; esac
case "$SCENARIO" in rail-agents) PREVIEW_SETTLE="${PREVIEW_SETTLE:-2}";; esac
case "$SCENARIO" in rail-keys) PREVIEW_SETTLE="${PREVIEW_SETTLE:-2.6}";; esac
if [[ -n "${PREVIEW_PHASE:-}" ]]; then export PREVIEW_PHASE; fi
# The Memory section sits under Session: a taller window shows it whole once the rail scrolls to it;
# its default actions run to 2.3 s (the verbs), so the shot waits for them.
if [[ "$SCENARIO" == "memory" ]]; then export PREVIEW_WINDOW_SIZE="${PREVIEW_WINDOW_SIZE:-1180x1040}"; PREVIEW_SETTLE="${PREVIEW_SETTLE:-3}"; fi
# The kit's memory rail (the chips, a row's card) sits in the same tall window; `list-keys` runs its keys to 2.4 s.
if [[ "$SCENARIO" == "memory-chips" ]]; then export PREVIEW_WINDOW_SIZE="${PREVIEW_WINDOW_SIZE:-1180x1040}"; PREVIEW_SETTLE="${PREVIEW_SETTLE:-2.4}"; fi
if [[ "$SCENARIO" == "list-keys" ]]; then PREVIEW_SETTLE="${PREVIEW_SETTLE:-3}"; fi
if [[ "$SCENARIO" == "list-verbs" ]]; then PREVIEW_SETTLE="${PREVIEW_SETTLE:-2.4}"; fi
# Automations: the Now rail with six rows and the Trash fold is tall; the card and the probes run to 1.5 s.
# Settings › Automations sits under Session and holds the recipes: the tall window, scrolled to it.
case "$SCENARIO" in automations|automations-ring) export PREVIEW_WINDOW_SIZE="${PREVIEW_WINDOW_SIZE:-1180x1040}"; PREVIEW_SETTLE="${PREVIEW_SETTLE:-2.4}";; esac
if [[ "$SCENARIO" == "settings-automations" ]]; then export PREVIEW_WINDOW_SIZE="${PREVIEW_WINDOW_SIZE:-1180x1040}"; PREVIEW_SETTLE="${PREVIEW_SETTLE:-2}"; fi
# The Brain section and "Leaves the Mac" under it on the Settings tab; the Problems section under
# Permissions on the Now tab: a taller window shows them whole.
case "$SCENARIO" in local|local-empty) export PREVIEW_WINDOW_SIZE="${PREVIEW_WINDOW_SIZE:-1180x1040}";; esac
if [[ -n "${PREVIEW_CONNECTED:-}" ]]; then export PREVIEW_CONNECTED; fi
if [[ -n "${PREVIEW_WIPE_SECONDS:-}" ]]; then export PREVIEW_WIPE_SECONDS; fi
if [[ -n "${PREVIEW_SLOW_THUMBS:-}" ]]; then export PREVIEW_SLOW_THUMBS; fi
if [[ -n "${PREVIEW_REDUCE_MOTION:-}" ]]; then export PREVIEW_REDUCE_MOTION; fi
if [[ -z "$OUT" ]]; then
  exec "$BUILD/console-preview"
fi
"$BUILD/console-preview" > "$BUILD/run.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do
  if grep -q WINDOW_NUMBER "$BUILD/run.log" 2>/dev/null; then break; fi
  sleep 0.2
done
WIN=$(grep WINDOW_NUMBER "$BUILD/run.log" | head -1 | cut -d= -f2)
sleep "${PREVIEW_SETTLE:-2}"
screencapture -x -o -l "$WIN" "$OUT"
echo "wrote $OUT (window $WIN)"
