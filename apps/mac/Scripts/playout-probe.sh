#!/usr/bin/env bash
# The speaker's playout cushion and the queue it runs on, without the app, a device or a sound
# (voice PLAN W1.1, W1.2). Every engine runs in manual rendering mode and its output is only
# inspected: nothing is played, recorded or opened. No TCC, no window, no session.
#   Scripts/playout-probe.sh                   offline: arrival traces × {today, cushion, reprime}, then the gates
#   Scripts/playout-probe.sh --stall           real time: the play queue beside the real AudioStateReader (150 s)
#   Scripts/playout-probe.sh --stall --legacy  …plus a rig with the HAL reads back on the play queue
#   PLAYOUT_PROBE_SECONDS=60 · PLAYOUT_PROBE_STALL_S=150 · PLAYOUT_PROBE_DEBUG=1 (every hole, against the last cut)
#   Scripts/playout-probe.sh --build-only
# Compiles Audio/*.swift + Scripts/PlayoutProbeMain.swift + the ObjC shim into its own output
# directory, and only when a source is newer than the binary. Exit 0 when every gate holds.
set -euo pipefail
cd "$(dirname "$0")/.."
BUILD=".build/playout-probe"
BIN="$BUILD/playout-probe"
mkdir -p "$BUILD"
needs_build=0
if [[ ! -x "$BIN" ]]; then
  needs_build=1
else
  for f in Sources/Jarhead/Audio/*.swift Sources/JarheadObjC/ObjCTry.m Sources/JarheadObjC/include/* Scripts/PlayoutProbeMain.swift; do
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
    Sources/Jarhead/Audio/*.swift Scripts/PlayoutProbeMain.swift "$BUILD/ObjCTry.o" 1>&2
fi
if [[ "${1:-}" == "--build-only" ]]; then
  echo "built $BIN" >&2
  exit 0
fi
exec "$BIN" "$@"
