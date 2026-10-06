#!/usr/bin/env bash
# The palette under test, headless and silent: the real Audio/Earcons.swift (the names, the one gate,
# the dedupe, the priorities, the alarm's ramp, the drain wait, the wire hold), App/EarconCues.swift
# (which phase edges and problems sound) and LocalSpeaker's echo rule, with a recorder standing in for
# the player; then every sound the app can ask for is opened and decoded from Resources/Sounds (and,
# with --bundle, from a built app's Contents/Resources/Sounds) — read, never played.
#   Scripts/earcon-check.sh
#   Scripts/earcon-check.sh --bundle build/stage/Jarhead.app   # after JARHEAD_BUILD_ONLY=1 pnpm build:mac (relative to where it is run)
#   Scripts/earcon-check.sh --build-only
# Compiles Model + Audio + App/EarconCues.swift + Wake/LocalSpeaker.swift + the ObjC shim +
# Scripts/EarconCheckMain.swift into its own output directory (never the shared .build products), and
# only when a source is newer than the binary. No sound (the AUDIO_PROBE_PLAY rule: nothing an agent
# runs makes one), no microphone, no window, no daemon. One `check:` line per check; exit 1 on a FAIL.
set -euo pipefail
ORIG="$PWD"
cd "$(dirname "$0")/.."
# A relative --bundle is the caller's, not apps/mac's.
ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --bundle)
      p="${2:?--bundle needs a path}"
      [[ "$p" = /* ]] || p="$ORIG/$p"
      ARGS+=(--bundle "$p")
      shift 2
      ;;
    *)
      ARGS+=("$1")
      shift
      ;;
  esac
done
BUILD=".build/earcon-check"
BIN="$BUILD/earcon-check"
mkdir -p "$BUILD"
SOURCES=(Sources/Jarhead/Model/*.swift Sources/Jarhead/Audio/*.swift Sources/Jarhead/App/EarconCues.swift
  Sources/Jarhead/Wake/LocalSpeaker.swift Scripts/EarconCheckMain.swift)
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
if [[ "${ARGS[0]:-}" == "--build-only" ]]; then
  echo "built $BIN" >&2
  exit 0
fi
exec "$BIN" --sounds Resources/Sounds ${ARGS[@]+"${ARGS[@]}"}
