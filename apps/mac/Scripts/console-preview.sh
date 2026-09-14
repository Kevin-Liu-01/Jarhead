#!/usr/bin/env bash
# Throwaway preview of the Console window with fake data.
#   Scripts/console-preview.sh [scenario] [out.png]
# scenario: live | confirm | empty | settings | wake-locked | ledger | light |
#           conversation | conversation-codex | jarhead | jarhead-log | paused | switch |
#           cleanup | cleanup-select | cleanup-rename | cleanup-undo | cleanup-undo-toast | cleanup-log |
#           search | search-hit | problems | cleared | loading | wipe | timing |
#           memory | durability | threads | thread-pane | thread-answer | thread-history | typed-row | agent-pending (default live)
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
# Compiles Model + UI/Console + Scripts/ConsolePreviewMain.swift into its own
# output directory (never the shared .build products), shows the window,
# screenshots it (if out.png given) and exits; without out.png it stays open.
# Shots taken while the Mac is locked (loginwindow frontmost) render the window
# inactive: grey traffic lights, switches in the inactive grey even when on.
set -euo pipefail
cd "$(dirname "$0")/.."
SCENARIO="${1:-live}"
OUT="${2:-}"
case "$SCENARIO" in
  live|confirm|empty|settings|wake-locked|ledger|light|conversation|conversation-codex|jarhead|jarhead-log|paused|switch|cleanup|cleanup-select|cleanup-rename|cleanup-undo|cleanup-undo-toast|cleanup-log|search|search-hit|problems|cleared|loading|wipe|timing|memory|durability|threads|thread-pane|thread-answer|thread-history|typed-row|agent-pending) ;;
  *) echo "unknown scenario: $SCENARIO (see the list at the top of $0)" >&2; exit 2 ;;
esac
BUILD=".build/console-preview"
mkdir -p "$BUILD"
# PREVIEW_SKIP_BUILD=1 reuses the last binary (a run of several scenarios compiles once).
if [[ "${PREVIEW_SKIP_BUILD:-}" != "1" || ! -x "$BUILD/console-preview" ]]; then
  swiftc -O -swift-version 5 -parse-as-library -target arm64-apple-macosx14.0 \
    -o "$BUILD/console-preview" \
    Sources/Jarhead/Model/*.swift Sources/Jarhead/UI/*.swift Sources/Jarhead/UI/Console/*.swift Scripts/ConsolePreviewMain.swift
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
# The Threads pass's scenarios run their actions to 1.8 s (an `ended` event, an Allow, a landed turn).
case "$SCENARIO" in threads|thread-pane|thread-answer|typed-row|agent-pending) PREVIEW_SETTLE="${PREVIEW_SETTLE:-2.4}";; esac
# `thread-history` (the paged main pane: scroll up, Load earlier, the page lands, geometry after) runs to 2.3 s.
# Its run.log: `send: {"type":"thread.history",…,"before":2}`, `action: thread-history main … orphans 4→0 … complete false→true`,
# and two `geometry` lines whose `distance` agree (the row Kevin was reading stayed put while the page grew above it).
if [[ "$SCENARIO" == "thread-history" ]]; then PREVIEW_SETTLE="${PREVIEW_SETTLE:-2.9}"; fi
if [[ -n "${PREVIEW_PHASE:-}" ]]; then export PREVIEW_PHASE; fi
# The Memory section sits under Session: a taller window shows it whole once the rail scrolls to it;
# its default actions run to 2.3 s (the verbs), so the shot waits for them.
if [[ "$SCENARIO" == "memory" ]]; then export PREVIEW_WINDOW_SIZE="${PREVIEW_WINDOW_SIZE:-1180x1040}"; PREVIEW_SETTLE="${PREVIEW_SETTLE:-3}"; fi
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
