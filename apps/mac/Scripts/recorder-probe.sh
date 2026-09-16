#!/usr/bin/env bash
# Recorders and self-echo (design12 § Verification V3): two processes on one microphone.
# A plain recorder (this binary as `--recorder`, what QuickTime is) reads the default input for
# 30 s while `afplay` speaks a clip (5→25 s) and Jarhead's graph comes up (10→20 s) in
# RECORDER_PROBE_MODE; at 12 s the clip's first 5 s go through the graph's own player so the
# echo guard holds as it would for Jarhead's voice. Prints the recorder's level with and
# without the graph (`check: recorder level unchanged within 1 dB (recording)`), and the
# guard's coupling · residual · tail leak (`check: tailLeakDbfs ≤ −50 (recording)`); merges the
# figures into ~/.jarhead/audio-probe.json under the mode (the doctor's `leak` row).
#
#   Scripts/recorder-probe.sh                        # prints what it would do and exits 0 — it PLAYS SOUND
#   AUDIO_PROBE_PLAY=1 Scripts/recorder-probe.sh     # the run (≈ 27 s), mode recording
#   AUDIO_PROBE_PLAY=1 RECORDER_PROBE_MODE=aec Scripts/recorder-probe.sh   # the 751100 question: a second client beside the unit
#   RECORDER_PROBE_FILE=/tmp/clip.aiff …             # your own speech clip (default: `say -o` of a paragraph)
#   Scripts/recorder-probe.sh --build-only · --json
#
# A bare tool: both processes borrow the launching terminal's microphone grant (the terminal
# prompts when it is undecided). Nothing connects to the daemon; nothing opens a session; nothing
# is paid. Do not run while Jarhead.app is awake (two clients would fight over the unit).
set -euo pipefail
cd "$(dirname "$0")/.."
BUILD=".build/recorder-probe"
BIN="$BUILD/recorder-probe"
mkdir -p "$BUILD"
needs_build=0
if [[ ! -x "$BIN" ]]; then
  needs_build=1
else
  for f in Sources/Jarhead/Audio/*.swift Sources/JarheadObjC/ObjCTry.m Sources/JarheadObjC/include/* Scripts/RecorderProbeMain.swift; do
    if [[ "$f" -nt "$BIN" ]]; then needs_build=1; fi
  done
fi
if [[ $needs_build == 1 ]]; then
  echo "building $BIN" >&2
  clang -c -fobjc-arc -target arm64-apple-macosx14.0 -I Sources/JarheadObjC/include \
    -o "$BUILD/ObjCTry.o" Sources/JarheadObjC/ObjCTry.m 1>&2
  swiftc -O -swift-version 5 -parse-as-library -target arm64-apple-macosx14.0 \
    -I Sources/JarheadObjC/include \
    -o "$BIN" \
    Sources/Jarhead/Audio/*.swift Scripts/RecorderProbeMain.swift "$BUILD/ObjCTry.o" 1>&2
fi
if [[ "${1:-}" == "--build-only" ]]; then
  echo "built $BIN" >&2
  exit 0
fi
exec "$BIN" "$@"
