#!/usr/bin/env bash
# Throwaway preview of the Console window with fake data.
#   Scripts/console-preview.sh [scenario] [out.png]
# scenario: live | confirm | empty | settings | wake-locked | ledger | light (default live)
#   `settings` is asleep with the wake gate listening (Settings tab); `wake-locked`
#   the same tab with the gate locked out and no passphrase set.
#   `light` is the live scenario in the aqua appearance; PREVIEW_APPEARANCE=light|dark
#   pins the appearance for any scenario (default dark, so shots are deterministic).
#   PREVIEW_BRAIN=<BrainKind raw> swaps the brain; PREVIEW_GATE=off|awake overrides
#   the wake gate (switch off / resting because the engine is awake) — see ConsolePreviewMain.
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
swiftc -O -swift-version 5 -parse-as-library -target arm64-apple-macosx14.0 \
  -o "$BUILD/console-preview" \
  Sources/Jarhead/Model/*.swift Sources/Jarhead/UI/Console/*.swift Scripts/ConsolePreviewMain.swift
export PREVIEW_SCENARIO="$SCENARIO"
export PREVIEW_STATE_DIR="${PREVIEW_STATE_DIR:-$(cd Scripts/mock && pwd)}"
export PREVIEW_SHOT_PNG="${PREVIEW_SHOT_PNG:-preview-orb-expanded.png}"
if [[ -n "${PREVIEW_APPEARANCE:-}" ]]; then export PREVIEW_APPEARANCE; fi
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
