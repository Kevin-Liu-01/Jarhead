#!/usr/bin/env bash
# Prove the ObjC exception shim (Sources/JarheadObjC + Audio/ObjCTry.swift) catches what
# AVFoundation raises — without the app, the daemon, a microphone or any TCC prompt.
#   Scripts/objc-try-probe.sh                 # build and run (a few seconds)
#   Scripts/objc-try-probe.sh --build-only
#   OBJC_TRY_PROBE_UNSAFE=1 Scripts/objc-try-probe.sh   # watch the same raise abort outside the shim
# What it checks is documented at the top of Scripts/ObjCTryProbeMain.swift. Always: a
# mixer → output connection at 0 Hz and a channel-mismatched scheduleBuffer both raise and
# are caught. Only when this process already holds the microphone grant (it never prompts):
# a tap on the INPUT node with a format it does not run raises "Failed to create tap due to
# format mismatch" (the raise behind 5 of the 8 crashes of 2026-09-11) and is caught; the
# same tap with format nil does not raise; the voice AudioEngine starts, a configuration
# change is simulated and the restart logs the formats before → after instead of aborting.
#
# Compiles Model + Audio + Wake/WakeWordListener + Ear (the same set as ear-probe.sh, so
# the wake listener's shim path is type-checked here too) + the .m shim + the probe main,
# into its own output directory (never the shared .build products). Exit 1 if a raise that
# should have been caught was not.
set -euo pipefail
cd "$(dirname "$0")/.."
BUILD=".build/objc-try-probe"
mkdir -p "$BUILD"
clang -c -fobjc-arc -target arm64-apple-macosx14.0 -I Sources/JarheadObjC/include \
  -o "$BUILD/ObjCTry.o" Sources/JarheadObjC/ObjCTry.m
swiftc -O -swift-version 5 -parse-as-library -target arm64-apple-macosx14.0 \
  -I Sources/JarheadObjC/include \
  -o "$BUILD/objc-try-probe" \
  Sources/Jarhead/Model/*.swift Sources/Jarhead/Audio/*.swift \
  Sources/Jarhead/Wake/WakeWordListener.swift Sources/Jarhead/Ear/*.swift \
  Scripts/ObjCTryProbeMain.swift "$BUILD/ObjCTry.o"
echo "built $BUILD/objc-try-probe"
if [[ "${1:-}" == "--build-only" ]]; then exit 0; fi
exec "$BUILD/objc-try-probe"
