#!/usr/bin/env bash
# The barge-in duck and the microphone ranking, without the app or the daemon: feeds
# synthetic 100 ms tap buffers into Audio/AudioEngine.swift's `BargeInDuck` and prints
# speech onset → −20 dB per onset, the restore timings, and this Mac's input devices in
# `MicRanking` order (read-only; nothing is played, recorded or changed). design12 (V4): it
# opens with the pure sections — `EchoGuardModel` (hold on the first slice after output,
# release at audibleUntil + tail, no break-through in the first 2 s, +12 dB for 120 ms breaks
# through, a loud slice never teaches the floor, flush shortens the window, NaN is silence,
# the counters), `EchoGuard` (detached / attached / frozen) and `VoiceProcessingPolicy` (the
# ladder per policy, the constants, `firstRung`, the running line, the state words) — one
# `check: <section> · <name> ok` line each, then `check: pure sections N ok, 0 FAIL`.
#   Scripts/duck-probe.sh                 # V4 sections, then 3 runs × 5 scenarios, a line per event
#   DUCK_PROBE_RUNS=5 DUCK_PROBE_LIVE_MS=1200 Scripts/duck-probe.sh
#   Scripts/duck-probe.sh --json          # the report as one JSON line (what `pnpm jarhead bench` reads)
#   Scripts/duck-probe.sh --build-only
# Compiles Audio/*.swift + Scripts/DuckProbeMain.swift + the ObjC shim into its own output
# directory (never the shared .build products), and only when a source is newer than the
# binary, so the bench does not pay swiftc every run. No TCC: no microphone, no speech.
set -euo pipefail
cd "$(dirname "$0")/.."
BUILD=".build/duck-probe"
BIN="$BUILD/duck-probe"
mkdir -p "$BUILD"
needs_build=0
if [[ ! -x "$BIN" ]]; then
  needs_build=1
else
  for f in Sources/Jarhead/Audio/*.swift Sources/JarheadObjC/ObjCTry.m Sources/JarheadObjC/include/* Scripts/DuckProbeMain.swift; do
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
    Sources/Jarhead/Audio/*.swift Scripts/DuckProbeMain.swift "$BUILD/ObjCTry.o" 1>&2
fi
if [[ "${1:-}" == "--build-only" ]]; then
  echo "built $BIN" >&2
  exit 0
fi
exec "$BIN" "$@"
