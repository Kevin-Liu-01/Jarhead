#!/usr/bin/env bash
# The global hotkeys type nothing (APP-12, decision D3): for every combo App/Hotkeys.swift
# registers, UCKeyTranslate says what the US layout types; a combo must type no character
# unless HotkeyCheckMain.swift's `typesAllowed` records it (only ⌥⇧Space, an open question).
# Then the off switch (`defaults write com.kevinliu.jarhead hotkeys.off -bool YES`), read
# through the argument domain so no plist is written: only ⌥⎋ Stop still registers.
#   Scripts/hotkey-check.sh                # run the checks (a second)
#   Scripts/hotkey-check.sh --build-only
# Compiles App/Hotkeys.swift + Scripts/HotkeyCheckMain.swift into its own output directory,
# and only when a source is newer than the binary. Registers nothing (a registered combo is
# taken from every other app), posts no event, opens no window. Exit 1 on a FAIL.
set -euo pipefail
cd "$(dirname "$0")/.."
BUILD=".build/hotkey-check"
BIN="$BUILD/hotkey-check"
mkdir -p "$BUILD"
SOURCES=(Sources/Jarhead/App/Hotkeys.swift Scripts/HotkeyCheckMain.swift)
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
"$BIN"
"$BIN" -hotkeys.off YES
