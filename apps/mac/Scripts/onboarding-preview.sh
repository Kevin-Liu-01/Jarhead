#!/usr/bin/env bash
# Throwaway preview of the onboarding window with fake data.
#   Scripts/onboarding-preview.sh                 # every step → Resources/preview-onboarding-<step>.png (+ -light.png, -welcome-light.png)
#   Scripts/onboarding-preview.sh brain           # one step, stays open (no screenshot)
#   Scripts/onboarding-preview.sh brain out.png   # one step, screenshot, exit
# step: welcome | voice | brain | permissions | wake | agents | done | all (default all)
#   PREVIEW_SCENARIO=ready|fresh|broken|auto pins the fake state (default ready);
#   PREVIEW_APPEARANCE=light|dark pins the appearance (default dark, so shots are deterministic);
#   PREVIEW_SIZE=WxH sets the content size (default 620x520; 560x480 is the window minimum).
#   PREVIEW_GO=<step>@<seconds> steps to another step at that moment (inside withAnimation:
#   the slide runs, the rail's highlight glides); PREVIEW_SHOT_AT=<seconds>:<out.png> takes a
#   window-only shot at that moment (a frame mid-transition; the harness log stamps the real
#   time the capture ran); PREVIEW_REDUCE_MOTION=1 pins Motion.reduced on (plain fades, halved
#   durations, no slide); PREVIEW_SWEEP=asking|waiting|settings|folders|done pins an "Ask for
#   everything" sweep on the Permissions step (waiting: a dialog that returned at once; folders:
#   three kinds sharing one pane). Permissions are canned per scenario (all sixteen kinds, mixed
#   statuses) and every ask prints — nothing here touches TCC. See OnboardingPreviewMain.swift.
#   PREVIEW_TIP=<id> pins a trigger's tip on the Setup root's float layer at 0.6 s (tipOpen:<id>).
#   PREVIEW_OPEN=<field> (voice | accent | brain | model | auth …) opens that step's menu field on the
#   Setup window's float layer at 0.6 s (`menuOpen:setup.<field>` — the field answers once it is on
#   the layer; until then the log says it was asked).
#   `all` also shoots the Permissions step at 620x1500 (preview-onboarding-permissions-all.png)
#   so every one of the sixteen rows is in a committed picture.
# Compiles Model + Permissions + UI/Console (for ConsoleTheme) + UI/Motion + UI/Dither + UI/HelpCopy + UI/Onboarding +
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
  Sources/Jarhead/Model/*.swift Sources/Jarhead/Permissions/*.swift Sources/Jarhead/UI/Motion.swift Sources/Jarhead/UI/Dither.swift Sources/Jarhead/UI/Thumbnails.swift Sources/Jarhead/UI/HelpCopy.swift \
  Sources/Jarhead/UI/Console/*.swift Sources/Jarhead/UI/Onboarding/*.swift \
  Scripts/OnboardingPreviewMain.swift
export PREVIEW_SCENARIO="${PREVIEW_SCENARIO:-ready}"
if [[ -n "${PREVIEW_APPEARANCE:-}" ]]; then export PREVIEW_APPEARANCE; fi
if [[ -n "${PREVIEW_SIZE:-}" ]]; then export PREVIEW_SIZE; fi
if [[ -n "${PREVIEW_OPEN:-}" ]]; then export PREVIEW_OPEN; fi
if [[ -n "${PREVIEW_TIP:-}" ]]; then export PREVIEW_TIP; fi

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
  # The Permissions step mid-sweep, waiting on a dialog, in the System Settings walk, and tall enough for all sixteen rows.
  PREVIEW_SWEEP=asking shoot permissions "Resources/preview-onboarding-permissions-asking.png"
  PREVIEW_SWEEP=waiting shoot permissions "Resources/preview-onboarding-permissions-waiting.png"
  PREVIEW_SWEEP=settings shoot permissions "Resources/preview-onboarding-permissions-settings.png"
  PREVIEW_SIZE=620x1500 shoot permissions "Resources/preview-onboarding-permissions-all.png"
  # The Brain step again in the aqua appearance: the light palette's one check; the Welcome step
  # too, for the paper ground and the hero over it.
  PREVIEW_APPEARANCE=light shoot brain "Resources/preview-onboarding-light.png"
  PREVIEW_APPEARANCE=light shoot welcome "Resources/preview-onboarding-welcome-light.png"
  exit 0
fi
if [[ -z "$OUT" ]]; then
  PREVIEW_STEP="$STEP" exec "$BUILD/onboarding-preview"
fi
shoot "$STEP" "$OUT"
