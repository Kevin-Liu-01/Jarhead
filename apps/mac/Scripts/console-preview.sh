#!/usr/bin/env bash
# Throwaway preview of the Console window with fake data.
#   Scripts/console-preview.sh [scenario] [out.png]
# scenario: live | confirm | empty | settings | wake-locked | ledger | light |
#           conversation | conversation-codex | jarhead | jarhead-log | paused | switch |
#           cleanup | cleanup-select | cleanup-rename | cleanup-undo | cleanup-undo-toast | cleanup-log |
#           search | search-hit | problems | cleared | workers (default live)
#   `workers` is the split: three hands under one running delegation (Snapshot.workers) — the
#   Now tab's Workers section (status glyph, name, Stop, elapsed · lane, the last line), the
#   delegation card's chips and the [Name] tag on a worker's steps; `ledger` and `jarhead-log`
#   carry the `worker` rows (the stream: a hand's first "working" and its end; the log: every row)
#   and the `sleep` row ("asleep · idle", "asleep · said “…”"). Its default actions print the
#   `check:` pins into .build/console-preview/run.log and Spotify's Stop as `send: worker.stop`.
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
BUILD=".build/console-preview"
mkdir -p "$BUILD"
# PREVIEW_SKIP_BUILD=1 reuses the last binary (a run of several scenarios compiles once).
if [[ "${PREVIEW_SKIP_BUILD:-}" != "1" || ! -x "$BUILD/console-preview" ]]; then
  swiftc -O -swift-version 5 -parse-as-library -target arm64-apple-macosx14.0 \
    -o "$BUILD/console-preview" \
    Sources/Jarhead/Model/*.swift Sources/Jarhead/UI/*.swift Sources/Jarhead/UI/Console/*.swift Scripts/ConsolePreviewMain.swift
fi
export PREVIEW_SCENARIO="$SCENARIO"
export PREVIEW_STATE_DIR="${PREVIEW_STATE_DIR:-$(cd Scripts/mock && pwd)}"
export PREVIEW_SHOT_PNG="${PREVIEW_SHOT_PNG:-preview-orb-expanded.png}"
# Where a `shot:<name>` action writes: next to out.png (Resources when there is none).
export PREVIEW_OUT_DIR="${PREVIEW_OUT_DIR:-$(cd "$(dirname "${OUT:-Resources/x.png}")" && pwd)}"
if [[ -n "${PREVIEW_APPEARANCE:-}" ]]; then export PREVIEW_APPEARANCE; fi
if [[ -n "${PREVIEW_ACTION:-}" ]]; then export PREVIEW_ACTION; fi
if [[ "$SCENARIO" == "switch" ]]; then PREVIEW_SETTLE="${PREVIEW_SETTLE:-5.2}"; fi
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
