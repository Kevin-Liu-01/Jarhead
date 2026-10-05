#!/usr/bin/env bash
# The barge-in duck and the microphone ranking, without the app or the daemon: feeds
# synthetic 100 ms tap buffers into Audio/BargeInDuck.swift and prints speech onset → duck
# (−6 dB) per onset, confirmation → −20 dB, the restore timings, and this Mac's input devices
# in `MicRanking` order (read-only; nothing is played, recorded or changed). It opens with the
# pure sections — `EchoGuardModel` (hold on the first slice after output, release at
# audibleUntil + tail, no break-through in the first 2 s, +12 dB for 120 ms breaks through, a
# loud slice never teaches the floor, flush shortens the window, NaN is silence, the counters),
# `EchoGuard` (detached / attached / frozen), `VoiceProcessingPolicy` (the ladder per policy,
# the constants, `firstRung`, the running line, the state words) and `PlayoutModel` (the
# pre-roll after a reset, contiguous chunks, an underrun and its fade-in, the 0.5 s dry reset,
# flush, a burst before the first render, the target's growth and cap, the shadow count, the
# fade ramp) — one `check: <section> · <name> ok` line each, then
# `check: pure sections N ok, 0 FAIL`. After the five scenarios (live, cough, ear, echo, phase)
# come the word rounds (stale, revise, late-live: words alone duck nothing), the echo-stale
# rounds (stale words inside a duck on residual echo leave it at −6 dB) and the residual round
# (60 s of bursty residual echo at −50 dBFS, Kevin silent: ≤ 1% of speech under −6 dB).
#   Scripts/duck-probe.sh                 # all of it, 3 runs × 5 scenarios, a line per event
#   DUCK_PROBE_RUNS=5 DUCK_PROBE_LIVE_MS=1200 Scripts/duck-probe.sh
#   DUCK_PROBE_RESIDUAL_S=0 Scripts/duck-probe.sh   # skip the residual round (60 s by default)
#   Scripts/duck-probe.sh --json          # the report as one JSON line (what `pnpm jarhead bench`
#                                         # reads); the residual round runs only when DUCK_PROBE_RESIDUAL_S is set
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
