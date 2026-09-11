#!/usr/bin/env bash
# Throwaway preview of the onboarding window with fake data.
#   Scripts/onboarding-preview.sh                 # every step → Resources/preview-onboarding-<step>.png (+ -light.png)
#   Scripts/onboarding-preview.sh brain           # one step, stays open (no screenshot)
#   Scripts/onboarding-preview.sh brain out.png   # one step, screenshot, exit
# step: welcome | voice | brain | permissions | wake | agents | done | all (default all)
#   PREVIEW_SCENARIO=ready|fresh|broken|auto pins the fake state (default ready);
#   PREVIEW_APPEARANCE=light|dark pins the appearance (default dark, so shots are deterministic);
#   PREVIEW_SIZE=WxH sets the content size (default 620x520; 560x480 is the window minimum).
# Compiles Model + Permissions + UI/Console (for ConsoleTheme) + UI/Onboarding +
# Scripts/OnboardingPreviewMain.swift into its own output directory (never the
# shared .build products), shows the window, screenshots it and exits.
set -euo pipefail
cd "$(dirname "$0")/.."
STEP="${1:-all}"
OUT="${2:-}"
BUILD=".build/onboarding-preview"
mkdir -p "$BUILD"
swiftc -O -swift-version 5 -parse-as-library -target arm64-apple-macosx14.0 \
  -o "$BUILD/onboarding-preview" \
  Sources/Jarhead/Model/*.swift Sources/Jarhead/Permissions/*.swift \
  Sources/Jarhead/UI/Console/*.swift Sources/Jarhead/UI/Onboarding/*.swift \
  Scripts/OnboardingPreviewMain.swift
export PREVIEW_SCENARIO="${PREVIEW_SCENARIO:-ready}"
if [[ -n "${PREVIEW_APPEARANCE:-}" ]]; then export PREVIEW_APPEARANCE; fi
if [[ -n "${PREVIEW_SIZE:-}" ]]; then export PREVIEW_SIZE; fi

# shoot <step> <out.png>: run the harness on one step, screenshot its window, kill it.
shoot() {
  local step="$1" out="$2" log="$BUILD/run-$1.log" pid win
  PREVIEW_STEP="$step" "$BUILD/onboarding-preview" > "$log" 2>&1 &
  pid=$!
  trap 'kill $pid 2>/dev/null || true' EXIT
  for _ in $(seq 1 60); do
    if grep -q WINDOW_NUMBER "$log" 2>/dev/null; then break; fi
    sleep 0.2
  done
  win=$(grep WINDOW_NUMBER "$log" | head -1 | cut -d= -f2)
  sleep "${PREVIEW_SETTLE:-1.5}"
  screencapture -x -o -l "$win" "$out"
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  trap - EXIT
  echo "wrote $out (window $win)"
}

if [[ "$STEP" == "all" ]]; then
  for s in welcome voice brain permissions wake agents done; do
    shoot "$s" "Resources/preview-onboarding-$s.png"
  done
  # The Brain step again in the aqua appearance: the light palette's one check.
  PREVIEW_APPEARANCE=light shoot brain "Resources/preview-onboarding-light.png"
  exit 0
fi
if [[ -z "$OUT" ]]; then
  PREVIEW_STEP="$STEP" exec "$BUILD/onboarding-preview"
fi
shoot "$STEP" "$OUT"
