#!/usr/bin/env bash
# "Ask for everything" ends (APP-7): the real Permissions/PermissionsSweep.swift with the
# centre's Mac side scripted (PermissionsIO) and a short watch. A step that waits on Kevin
# parks when Setup closes, or at the watch span, instead of polling for ever; Next, Cancel and
# coming back to Jarhead still move it on. See Scripts/SweepCheckMain.swift for the list.
#   Scripts/sweep-check.sh                # run the checks (a few seconds)
#   Scripts/sweep-check.sh --build-only
# Compiles Model + Permissions + UI (Setup's window controller, which closes but is never
# shown) + Scripts/SweepCheckMain.swift into its own output directory
# (never the shared .build products), and only when a source is newer than the binary.
# Nothing is asked: no TCC prompt, no helper, no System Settings, no Finder, no UserDefaults
# write, no window. One `check:` line per check; exit 1 on a FAIL.
set -euo pipefail
cd "$(dirname "$0")/.."
BUILD=".build/sweep-check"
BIN="$BUILD/sweep-check"
mkdir -p "$BUILD"
SOURCES=(Sources/Jarhead/Model/*.swift Sources/Jarhead/Permissions/*.swift Sources/Jarhead/UI/*.swift
  Sources/Jarhead/UI/Console/*.swift Sources/Jarhead/UI/Onboarding/*.swift Scripts/SweepCheckMain.swift)
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
  swiftc -Onone -swift-version 5 -parse-as-library -target arm64-apple-macosx14.0 \
    -o "$BIN" "${SOURCES[@]}" 1>&2
fi
if [[ "${1:-}" == "--build-only" ]]; then
  echo "built $BIN" >&2
  exit 0
fi
TMP="${TMPDIR:-/tmp}"
HOME_DIR="$(mktemp -d "${TMP%/}/sweep-check.XXXXXX")"
trap 'rm -rf "$HOME_DIR"' EXIT
env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY -u JARHEAD_BRAIN_API_KEY -u JARHEAD_SOCKET -u JARHEAD_PERMISSIONS_DRY_RUN \
  HOME="$HOME_DIR" JARHEAD_STATE_DIR="$HOME_DIR/state" JARHEAD_NO_AUDIO=1 JARHEAD_AUTO_WAKE=0 \
  "$BIN" "$@"
