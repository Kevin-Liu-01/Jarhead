#!/usr/bin/env bash
# Contract probe: decodes captured daemon frames with the app's Codable mirrors
# (Model/Protocol.swift) exactly as Daemon/EngineClient.swift would, and checks the
# worker / sleep additions decode both ways — old daemon, new app; new daemon, this app.
#   Scripts/protocol-probe.sh                       # both fixtures
#   Scripts/protocol-probe.sh path/to/capture.json  # your own capture(s)
#   Scripts/protocol-probe.sh --build-only
# A capture is a JSON array of daemon → app frames (`hello`, `snapshot`, `ledger.rows`),
# the payloads as wire.ts DaemonMessage spells them. fixtures/snapshot-f6c3b40.json is
# hand-assembled in the f6c3b40 daemon's shape (no workers anywhere); fixtures/
# snapshot-workers.json has workers in three snapshots — one with a status and a lane
# this app does not know, to prove the .working / .background defaults — and a ledger
# with worker rows and a `sleep` row. Prints one block per fixture; exit 1 on a break.
# Compiles Protocol.swift + Scripts/ProtocolProbeMain.swift into its own output
# directory (never the shared .build products), and only when a source is newer than the
# binary, so a bench or a CI loop does not pay swiftc (~25 s) every run. Foundation only,
# no window, no TCC, no daemon, no Live session.
set -euo pipefail
cd "$(dirname "$0")/.."
BUILD=".build/protocol-probe"
BIN="$BUILD/protocol-probe"
mkdir -p "$BUILD"
needs_build=0
if [[ ! -x "$BIN" ]]; then
  needs_build=1
else
  for f in Sources/Jarhead/Model/Protocol.swift Scripts/ProtocolProbeMain.swift; do
    if [[ "$f" -nt "$BIN" ]]; then needs_build=1; fi
  done
fi
if [[ $needs_build == 1 ]]; then
  echo "building $BIN" >&2
  swiftc -O -swift-version 5 -parse-as-library -target arm64-apple-macosx14.0 \
    -o "$BIN" \
    Sources/Jarhead/Model/Protocol.swift Scripts/ProtocolProbeMain.swift 1>&2
fi
if [[ "${1:-}" == "--build-only" ]]; then
  echo "built $BIN" >&2
  exit 0
fi
if [[ $# -eq 0 ]]; then
  exec "$BIN" Scripts/fixtures/snapshot-f6c3b40.json Scripts/fixtures/snapshot-workers.json Scripts/fixtures/snapshot-threads.json
fi
exec "$BIN" "$@"
