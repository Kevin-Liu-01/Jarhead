#!/usr/bin/env bash
# The app's half of W3-3, headless (Scripts/W33CheckMain.swift says what each part checks): version skew raises
# app.version and refuses Go until it clears (APP-3), the Ledger tab gets every day's totals (LM-6), the Console's
# search reads on page by page (search older), the composer keeps a line that has not landed (V6), and a day's rows
# say which decisions a move carried. The real Daemon/EngineClient.swift, Daemon/Wire.swift, Model, UI and UI/Console
# sources against a fake daemon on a scratch socket in the check's own process: no window, no TCC, no sound, no
# real daemon, nothing under ~/.jarhead.
#   Scripts/w3-3-check.sh                    # fixtures/snapshot-threads.json; the undecodable snapshot lacks `threads`
#   DROP_KEY=permissions Scripts/w3-3-check.sh
#   Scripts/w3-3-check.sh --build-only
# Compiles into its own output directory, and only when a source is newer than the binary.
set -euo pipefail
cd "$(dirname "$0")/.."
BUILD=".build/w3-3-check"
BIN="$BUILD/w3-3-check"
mkdir -p "$BUILD"
SOURCES=(Sources/Jarhead/Model/*.swift Sources/Jarhead/UI/*.swift Sources/Jarhead/UI/Console/*.swift
  Sources/Jarhead/Daemon/Wire.swift Sources/Jarhead/Daemon/EngineClient.swift Scripts/W33CheckMain.swift)
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
