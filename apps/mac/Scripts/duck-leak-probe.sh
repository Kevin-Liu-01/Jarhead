#!/usr/bin/env bash
# Other apps' level under the voice-processing unit, as a figure (design12 § Verification V2;
# LAST and droppable). Writes a 20 s 1 kHz −20 dBFS WAV, plays it with `afplay`, taps afplay's
# output with a Core Audio process tap (macOS 14.2; skipped with a line below it) and brings
# Jarhead's graph up 5→15 s in each mode — aec-default (today), aec-min-advanced (design12's
# constant), aec-min-plain, recording — printing ΔdB per mode. Expected: a step for aec-default,
# a smaller one for min (its size is the figure the plan is judged by; the smaller of advanced /
# plain becomes the constant), 0 dB for recording. No step in any mode ⇒ `tap is pre-duck`.
#
#   Scripts/duck-leak-probe.sh                        # prints what it would do and exits 0 — it PLAYS SOUND
#   AUDIO_PROBE_PLAY=1 Scripts/duck-leak-probe.sh     # all four modes, ≈ 20 s each
#   AUDIO_PROBE_PLAY=1 DUCK_LEAK_MODES=aec-default,recording Scripts/duck-leak-probe.sh
#   Scripts/duck-leak-probe.sh --build-only
#
# A bare tool: the process tap asks the launching terminal for the system-audio-recording grant,
# the graph borrows its microphone grant. Nothing connects to the daemon; nothing opens a session;
# nothing is paid. Do not run while Jarhead.app is awake.
set -euo pipefail
cd "$(dirname "$0")/.."
BUILD=".build/duck-leak-probe"
BIN="$BUILD/duck-leak-probe"
mkdir -p "$BUILD"
needs_build=0
if [[ ! -x "$BIN" ]]; then
  needs_build=1
else
  for f in Sources/Jarhead/Audio/*.swift Sources/JarheadObjC/ObjCTry.m Sources/JarheadObjC/include/* Scripts/DuckLeakProbeMain.swift; do
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
    Sources/Jarhead/Audio/*.swift Scripts/DuckLeakProbeMain.swift "$BUILD/ObjCTry.o" 1>&2
fi
if [[ "${1:-}" == "--build-only" ]]; then
  echo "built $BIN" >&2
  exit 0
fi
exec "$BIN" "$@"
