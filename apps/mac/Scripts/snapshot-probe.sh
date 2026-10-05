#!/usr/bin/env bash
# The app's receive path under big snapshots (voice PLAN W2.2): the real Daemon/EngineClient.swift,
# Daemon/Wire.swift and Model/*.swift against a fake daemon on a scratch socket in the probe's own
# process. Speaker frames, flushes and 283 KB snapshots: the order holds, a speaker frame never waits
# for a snapshot's decode, paced frames stay on time. No window, no TCC, no sound, no real daemon.
#   Scripts/snapshot-probe.sh                         # the gates (order, behind, paced, decoded)
#   SNAPSHOT_PROBE_SECONDS=60 Scripts/snapshot-probe.sh
#   SNAPSHOT_PROBE_CLIENT=path/EngineClient.swift SNAPSHOT_PROBE_NO_GATES=1 Scripts/snapshot-probe.sh
#                                                     # the same probe over another EngineClient (figures only)
#   Scripts/snapshot-probe.sh --build-only
# Compiles into its own output directory, and only when a source is newer than the binary.
set -euo pipefail
cd "$(dirname "$0")/.."
CLIENT="${SNAPSHOT_PROBE_CLIENT:-Sources/Jarhead/Daemon/EngineClient.swift}"
TAG="$(printf '%s' "$CLIENT" | shasum | cut -c1-8)"
BUILD=".build/snapshot-probe"
BIN="$BUILD/snapshot-probe-$TAG"
mkdir -p "$BUILD"
SOURCES=(Sources/Jarhead/Model/*.swift Sources/Jarhead/Daemon/Wire.swift "$CLIENT" Scripts/SnapshotProbeMain.swift)
needs_build=0
if [[ ! -x "$BIN" ]]; then
  needs_build=1
else
  for f in "${SOURCES[@]}"; do
    if [[ "$f" -nt "$BIN" ]]; then needs_build=1; fi
  done
fi
if [[ $needs_build == 1 ]]; then
  echo "building $BIN" >&2
  swiftc -O -swift-version 5 -parse-as-library -target arm64-apple-macosx14.0 \
    -o "$BIN" "${SOURCES[@]}" 1>&2
fi
if [[ "${1:-}" == "--build-only" ]]; then
  echo "built $BIN" >&2
  exit 0
fi
exec "$BIN" "${1:-Scripts/fixtures/snapshot-threads.json}"
