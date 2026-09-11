#!/usr/bin/env bash
# Build and run the Orb/Overlay preview harness without the rest of the app.
# Compiles Model + UI/Orb + UI/Overlay with -D JARHEAD_ORB_PREVIEW (which enables
# UI/Orb/OrbPreviewApp.swift's @main) into $OUT and runs it.
#
#   Scripts/orb-preview.sh                 # cycle all phases at 200,200 for 30 s
#   ORB_EXPAND=1 ORB_OVERLAY=1 Scripts/orb-preview.sh
#   ORB_PHASES=listening,speaking ORB_PHASE_SECONDS=4 Scripts/orb-preview.sh
#   ORB_FLING=-2400,900 ORB_SHOT_DIR=Resources Scripts/orb-preview.sh   # throw it at the edges, screenshot the squish
#   ORB_EXPAND=1 ORB_SHOT_DIR=Resources ORB_EXIT_AFTER=4 Scripts/orb-preview.sh   # Resources/preview-blob-expanded.png
#   ORB_GATE=authenticating,locked ORB_SHOT_DIR=Resources ORB_EXIT_AFTER=6 Scripts/orb-preview.sh   # the wake gate on the blob + pill
#   ORB_GATE=authenticating ORB_EXPAND=1 ORB_KEY_TEST=1 ORB_NO_DISMISS=1 ORB_EXIT_AFTER=5 Scripts/orb-preview.sh   # capsule gate row, Cancel, field, key handshake
#
# Screenshots land as <ORB_SHOT_DIR>/preview-blob-<what>.png, via screencapture when the
# launching app has the Screen Recording grant, else drawn in-process from the panel's
# layers (ORB_SHOT_INPROCESS=1 forces that). The harness never talks to the daemon or
# OpenAI: AppState is fed a fake snapshot and commands are printed.
# See OrbPreviewApp.swift for every environment knob. Pass --build-only to skip running.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${ORB_PREVIEW_OUT:-${TMPDIR:-/tmp}/jarhead-orb-preview}"
mkdir -p "$OUT"
BIN="$OUT/orb-preview"

swiftc -parse-as-library -O -D JARHEAD_ORB_PREVIEW \
  -target arm64-apple-macosx14.0 \
  -framework AppKit -framework SwiftUI -framework Combine \
  Sources/Jarhead/Model/*.swift \
  Sources/Jarhead/UI/Orb/*.swift \
  Sources/Jarhead/UI/Overlay/*.swift \
  -o "$BIN"

echo "built $BIN"
if [[ "${1:-}" == "--build-only" ]]; then exit 0; fi
exec "$BIN"
