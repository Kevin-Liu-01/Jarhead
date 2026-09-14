#!/usr/bin/env bash
# The blob-home rule of a mark's own echo (`MarkHomeRule`, UI/Orb/OrbPanelController.swift),
# pinned transition by transition without a window:
#   Scripts/orb-home-probe.sh                # run the checks (builds when a source is newer)
#   Scripts/orb-home-probe.sh --build-only
# The scenario the review raised — the outline cut short by a summon, a drag, the capsule or a
# hide, then an unrelated job's fly minutes later — must end where it worked, and the
# pin the dock folded for the mark must be dropped once, by the interruption; see
# Scripts/OrbHomeProbeMain.swift for the list. Compiles the Model, UI, UI/Orb and UI/Overlay
# sources (the rule lives beside the controller; UI/Orb/OrbPreviewApp.swift and
# UI/Overlay/OverlayPreviewDemo.swift are behind JARHEAD_ORB_PREVIEW and compile to nothing here)
# + Scripts/OrbHomeProbeMain.swift into its own output directory (never the shared .build
# products), and only when a source is newer than the binary. No window, no TCC, no daemon,
# no Live session. One `check:` line per check, "ok" or "FAIL" first; exit 1 on a FAIL.
set -euo pipefail
cd "$(dirname "$0")/.."
BUILD=".build/orb-home-probe"
BIN="$BUILD/orb-home-probe"
mkdir -p "$BUILD"
SOURCES=(Sources/Jarhead/Model/*.swift Sources/Jarhead/UI/*.swift Sources/Jarhead/UI/Orb/*.swift Sources/Jarhead/UI/Overlay/*.swift Scripts/OrbHomeProbeMain.swift)
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
    -framework AppKit -framework SwiftUI -framework Combine \
    -o "$BIN" "${SOURCES[@]}" 1>&2
fi
if [[ "${1:-}" == "--build-only" ]]; then
  echo "built $BIN" >&2
  exit 0
fi
exec "$BIN"
