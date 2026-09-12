#!/usr/bin/env bash
# Run the on-device ear on the built-in microphone for a few seconds, without the app
# or the daemon, and print every partial with timestamps.
#   Scripts/ear-probe.sh                              # 10 s on the default mic
#   EAR_PROBE_SECONDS=15 Scripts/ear-probe.sh
#   EAR_PROBE_SAY="scroll down" Scripts/ear-probe.sh  # `say` it through the speakers 2 s in
#                                                     # (a muted Mac reaches no microphone: expect no partials then)
#   say -o /tmp/scroll.aiff "scroll down" && EAR_PROBE_FILE=/tmp/scroll.aiff EAR_PROBE_PHRASE="scroll down" Scripts/ear-probe.sh
#                                                     # mute-independent: feed the file into the ear exactly as the tap
#                                                     # would (100 ms buffers every 100 ms) and print end-to-end numbers
#   EAR_PROBE_PHASE=paused Scripts/ear-probe.sh       # the ear must stay off while paused / muted
#   EAR_PROBE_REFLEXES=0 Scripts/ear-probe.sh         # … and with settings.reflexes off
#   EAR_PROBE_NO_PROMPT=1 Scripts/ear-probe.sh        # never ask TCC (headless runs): an undecided Speech grant
#                                                     # leaves the ear off, an undecided mic grant leaves the audio
#                                                     # engine off (starting it would block on a hidden prompt);
#                                                     # the gating still prints, and EAR_PROBE_FILE needs no mic
# Compiles Model + Audio + Wake/WakeWordListener (the shared recogniser segments and
# the grant reader) + Ear + Scripts/EarProbeMain.swift into its own output directory
# (never the shared .build products). -D DEBUG so the ear's latency line prints.
#
# TCC: Speech Recognition aborts a process whose Info.plist has no
# NSSpeechRecognitionUsageDescription — and for a bare tool that plist is the
# *responsible process's* (Terminal, the IDE), which has none. So the binary is
# wrapped in a minimal EarProbe.app (Scripts/ear-probe-Info.plist) and launched as
# its own responsible process through `open`, where it prompts once, by name, for
# Speech Recognition and the microphone. Output goes to $BUILD/run.log and is tailed
# here. EAR_PROBE_DIRECT=1 runs the binary inline instead (only useful where the
# terminal itself carries the usage strings).
set -euo pipefail
cd "$(dirname "$0")/.."
BUILD=".build/ear-probe"
APP="$BUILD/EarProbe.app"
mkdir -p "$APP/Contents/MacOS"
# The ObjC exception shim (Sources/JarheadObjC): Audio/ObjCTry.swift imports it as the
# module `JarheadObjC` through include/module.modulemap, so -I that directory is enough
# for swiftc; the .m is compiled by clang and linked in.
clang -c -fobjc-arc -target arm64-apple-macosx14.0 -I Sources/JarheadObjC/include \
  -o "$BUILD/ObjCTry.o" Sources/JarheadObjC/ObjCTry.m
swiftc -O -swift-version 5 -parse-as-library -D DEBUG -target arm64-apple-macosx14.0 \
  -I Sources/JarheadObjC/include \
  -o "$APP/Contents/MacOS/ear-probe" \
  Sources/Jarhead/Model/*.swift Sources/Jarhead/Audio/*.swift \
  Sources/Jarhead/Wake/WakeWordListener.swift Sources/Jarhead/Ear/*.swift \
  Scripts/EarProbeMain.swift "$BUILD/ObjCTry.o"
cp Scripts/ear-probe-Info.plist "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"
# Ad-hoc signed: TCC keys its grants to this build's cdhash, so Speech Recognition and the
# microphone are asked again after every rebuild (a real signing identity would fix that).
codesign --force --sign - --identifier com.kevinliu.jarhead.ear-probe "$APP"
# LaunchServices caches bundle facts; without this a rebuilt app can fail to `open` with
# "the application cannot be opened because its executable is missing".
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP"
echo "built $APP"
if [[ "${1:-}" == "--build-only" ]]; then exit 0; fi

if [[ "${EAR_PROBE_DIRECT:-}" == "1" ]]; then
  exec "$APP/Contents/MacOS/ear-probe"
fi

LOG="$BUILD/run.log"
: > "$LOG"
# `open` hands the app to launchd, so it is its own responsible process for TCC. The
# environment knobs travel through --env; stdout/stderr land in the log.
ARGS=()
for v in EAR_PROBE_SECONDS EAR_PROBE_SAY EAR_PROBE_FILE EAR_PROBE_PHRASE EAR_PROBE_PHASE EAR_PROBE_REFLEXES EAR_PROBE_NO_PROMPT JARHEAD_EAR_LOG; do
  if [[ -n "${!v:-}" ]]; then ARGS+=(--env "$v=${!v}"); fi
done
open -n -W --stdout "$LOG" --stderr "$LOG" ${ARGS[@]+"${ARGS[@]}"} "$APP" || true
cat "$LOG"
