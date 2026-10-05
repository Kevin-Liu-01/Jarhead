#!/usr/bin/env bash
# The wake gate under test (WG-12): the real Wake/WakeGate.swift and the real passphrase half
# of Wake/LocalAuth.swift, with the gate's three seams scripted (the recogniser, the voice, the
# owner sheet), on a short clock. Passphrase, word boundaries, spoken and typed lockouts, the
# grant, one utterance one sheet (WG-6), paused resumes, unanswered prompts, the lock's end.
#   Scripts/wake-gate-check.sh                    # every scenario (about 40 s)
#   Scripts/wake-gate-check.sh owner-retrigger    # one or more by name
#   Scripts/wake-gate-check.sh --build-only
# Compiles Model + Audio + Ear + Wake (what the real listener and speaker need to type-check)
# + the ObjC shim + Scripts/WakeGateCheckMain.swift into its own output directory (never the
# shared .build products), and only when a source is newer than the binary. Runs with a fresh
# temp JARHEAD_STATE_DIR and HOME, the keys unset and JARHEAD_NO_AUDIO=1 (the check builds its
# gate with audio on; the listener it drives has no microphone). No mic, no sound, no sheet, no
# window, no daemon, no Live session. One `check:` line per check; exit 1 on a FAIL.
set -euo pipefail
cd "$(dirname "$0")/.."
BUILD=".build/wake-gate-check"
BIN="$BUILD/wake-gate-check"
mkdir -p "$BUILD"
SOURCES=(Sources/Jarhead/Model/*.swift Sources/Jarhead/Audio/*.swift Sources/Jarhead/Ear/*.swift
  Sources/Jarhead/Wake/*.swift Scripts/WakeGateCheckMain.swift)
needs_build=0
if [[ ! -x "$BIN" ]]; then
  needs_build=1
else
  for f in "${SOURCES[@]}" Sources/JarheadObjC/ObjCTry.m Sources/JarheadObjC/include/*.h; do
    if [[ "$f" -nt "$BIN" ]]; then needs_build=1; fi
  done
fi
if [[ $needs_build == 1 ]]; then
  echo "building $BIN" >&2
  clang -c -fobjc-arc -target arm64-apple-macosx14.0 -I Sources/JarheadObjC/include \
    -o "$BUILD/ObjCTry.o" Sources/JarheadObjC/ObjCTry.m 1>&2
  swiftc -Onone -swift-version 5 -parse-as-library -target arm64-apple-macosx14.0 \
    -I Sources/JarheadObjC/include \
    -o "$BIN" "${SOURCES[@]}" "$BUILD/ObjCTry.o" 1>&2
fi
if [[ "${1:-}" == "--build-only" ]]; then
  echo "built $BIN" >&2
  exit 0
fi
TMP="${TMPDIR:-/tmp}"
STATE="$(mktemp -d "${TMP%/}/wake-gate-check.XXXXXX")"
trap 'rm -rf "$STATE"' EXIT
mkdir -p "$STATE/home"
env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY -u JARHEAD_BRAIN_API_KEY -u JARHEAD_SOCKET \
  HOME="$STATE/home" JARHEAD_STATE_DIR="$STATE/state" JARHEAD_NO_AUDIO=1 JARHEAD_AUTO_WAKE=0 \
  "$BIN" "$@"
