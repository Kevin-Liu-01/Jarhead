#!/usr/bin/env bash
# Contract probe: decodes captured daemon frames with the app's Codable mirrors
# (Model/Protocol.swift) exactly as Daemon/EngineClient.swift would, and checks the
# mirror against packages/protocol's shapes field for field.
#   Scripts/protocol-probe.sh                       # fixtures/snapshot-threads.json
#   Scripts/protocol-probe.sh path/to/capture.json  # your own capture(s)
#   Scripts/protocol-probe.sh --build-only
# A capture is a JSON array of daemon → app frames (`hello`, `snapshot`, `thread.event`,
# `thread.transcript`, `overlay`, `ledger.rows`), the payloads as wire.ts DaemonMessage
# spells them. fixtures/snapshot-threads.json is the contract's sample: two snapshots with
# threads, typed problems and the permission rows; every thread.event kind; a transcript
# page; tagged overlay commands; and a ledger.rows frame whose last three rows are what day
# files written before 2026-09-13 hold (a `worker` row, a step keyed `worker`, a
# session.started without language) — decoded and skipped, never a crash. Prints one block
# per fixture; exit 1 on a break.
# Compiles the Model, UI and UI/Console sources + Scripts/ProtocolProbeMain.swift (the
# Console sources for ConsoleFormat.tombstone and StreamBuilder, which the old-rows check
# drives) into its own output directory (never the shared .build products), and only when a
# source is newer than the binary, so a bench or a CI loop does not pay swiftc every run.
# No window, no TCC, no daemon, no Live session.
set -euo pipefail
cd "$(dirname "$0")/.."
BUILD=".build/protocol-probe"
BIN="$BUILD/protocol-probe"
mkdir -p "$BUILD"
SOURCES=(Sources/Jarhead/Model/*.swift Sources/Jarhead/UI/*.swift Sources/Jarhead/UI/Console/*.swift Scripts/ProtocolProbeMain.swift)
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
if [[ $# -eq 0 ]]; then
  exec "$BIN" Scripts/fixtures/snapshot-threads.json
fi
exec "$BIN" "$@"
