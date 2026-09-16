#!/usr/bin/env bash
# The audio graph's state, read back on this Mac without the app, the daemon or a session
# (design12 § Verification V1). Builds Audio/*.swift + the wake listener + Scripts/AudioProbeMain.swift
# into its own AudioProbe.app (the ear-probe mould: its own TCC identity for the microphone),
# launches it through `open`, and prints its `check:` lines; the run's record lands in
# ~/.jarhead/audio-probe.json under its mode (what `pnpm jarhead doctor` reads for the `leak` row).
#
#   Scripts/audio-probe.sh                        # AUDIO_PROBE_MODE=aec: the unit on, knobs read back in both spellings, released at stop
#   AUDIO_PROBE_MODE=recording Scripts/audio-probe.sh   # no unit, the ranked mic, the guard on, no aggregate appears
#   AUDIO_PROBE_MODE=asleep Scripts/audio-probe.sh      # the wake listener hears through the ranked mic (`hears <name> (ranked)`)
#   AUDIO_PROBE_MODE=private Scripts/audio-probe.sh     # the private-aggregate spike — `spike:` lines, never counted
#   Scripts/audio-probe.sh --json                 # the last line is the run record
#   Scripts/audio-probe.sh --test [--json]        # `pnpm jarhead doctor --test-audio`: the graph as the current setting builds it,
#                                                 # then a 1 s −12 dBFS chime through the player node — ONLY with AUDIO_PROBE_PLAY=1;
#                                                 # without it the probe says what it would do ({"dryRun":true}) and exits 0.
#                                                 # Refuses while Jarhead.app holds a microphone (`warn: Jarhead is awake; sleep it first`).
#   Scripts/audio-probe.sh --build-only
#   AUDIO_PROBE_DIRECT=1 Scripts/audio-probe.sh   # run the binary inline (the terminal's own microphone grant; no .app, no prompt
#                                                 # where the terminal already holds it — what a headless run wants)
#   AUDIO_PROBE_SECONDS=3 · AUDIO_PROBE_NO_PROMPT=1 (an undecided grant is a refusal, not a prompt) · AUDIO_PROBE_STATE_DIR
#
# Rails: nothing here connects to the daemon or opens a session; nothing is paid; nothing plays
# without AUDIO_PROBE_PLAY=1. Compiles only when a source is newer than the binary, so the doctor
# does not pay swiftc every run. Exit: 0 every check ok · 1 a FAIL · 3 refused.
set -euo pipefail
cd "$(dirname "$0")/.."
BUILD=".build/audio-probe"
APP="$BUILD/AudioProbe.app"
BIN="$APP/Contents/MacOS/audio-probe"
mkdir -p "$APP/Contents/MacOS"

needs_build=0
if [[ ! -x "$BIN" ]]; then
  needs_build=1
else
  for f in Sources/Jarhead/Model/*.swift Sources/Jarhead/Audio/*.swift Sources/Jarhead/Wake/WakeWordListener.swift Sources/Jarhead/Ear/*.swift \
           Sources/JarheadObjC/ObjCTry.m Sources/JarheadObjC/include/* Scripts/AudioProbeMain.swift Scripts/audio-probe-Info.plist; do
    if [[ "$f" -nt "$BIN" ]]; then needs_build=1; fi
  done
fi
if [[ $needs_build == 1 ]]; then
  echo "building $APP" >&2
  # The ObjC exception shim (Sources/JarheadObjC): Audio/ObjCTry.swift imports it as the module
  # `JarheadObjC` through include/module.modulemap; the .m is compiled by clang and linked in.
  clang -c -fobjc-arc -target arm64-apple-macosx14.0 -I Sources/JarheadObjC/include \
    -o "$BUILD/ObjCTry.o" Sources/JarheadObjC/ObjCTry.m 1>&2
  swiftc -O -swift-version 5 -parse-as-library -target arm64-apple-macosx14.0 \
    -I Sources/JarheadObjC/include \
    -o "$BIN" \
    Sources/Jarhead/Model/*.swift Sources/Jarhead/Audio/*.swift \
    Sources/Jarhead/Wake/WakeWordListener.swift Sources/Jarhead/Ear/*.swift \
    Scripts/AudioProbeMain.swift "$BUILD/ObjCTry.o" 1>&2
  cp Scripts/audio-probe-Info.plist "$APP/Contents/Info.plist"
  printf 'APPL????' > "$APP/Contents/PkgInfo"
  # Sign like scripts/build-mac.ts: any real identity (Apple-issued or the local self-signed
  # one) gives the bundle a designated requirement that survives rebuilds, so TCC keeps the
  # microphone grant; ad-hoc (`-`) keys it to the code hash and asks again after every build.
  IDENTITY="${JARHEAD_SIGN_IDENTITY:-}"
  if [[ -z "$IDENTITY" ]]; then
    NAMES=$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(.*\)".*/\1/p')
    IDENTITY=$(printf '%s\n' "$NAMES" | grep -m1 '^Apple Development' || true)
    [[ -n "$IDENTITY" ]] || IDENTITY=$(printf '%s\n' "$NAMES" | grep -m1 '^Developer ID Application' || true)
    [[ -n "$IDENTITY" ]] || IDENTITY=$(printf '%s\n' "$NAMES" | head -n1)
  fi
  [[ -n "$IDENTITY" ]] || IDENTITY="-"
  codesign --force --sign "$IDENTITY" --identifier com.kevinliu.jarhead.audio-probe "$APP" 1>&2
  # LaunchServices caches bundle facts; without this a rebuilt app can fail to `open`.
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" 1>&2
  echo "built $APP (signed: $IDENTITY)" >&2
fi
if [[ "${1:-}" == "--build-only" ]]; then exit 0; fi

if [[ "${AUDIO_PROBE_DIRECT:-}" == "1" ]]; then
  exec "$BIN" "$@"
fi

LOG="$BUILD/run.log"
: > "$LOG"
# `open` hands the app to launchd, so it is its own responsible process for TCC. The environment
# knobs travel through --env, the flags through --args; stdout/stderr land in the log.
ARGS=()
for v in AUDIO_PROBE_MODE AUDIO_PROBE_PLAY AUDIO_PROBE_SECONDS AUDIO_PROBE_NO_PROMPT AUDIO_PROBE_STATE_DIR; do
  if [[ -n "${!v:-}" ]]; then ARGS+=(--env "$v=${!v}"); fi
done
open -n -W --stdout "$LOG" --stderr "$LOG" ${ARGS[@]+"${ARGS[@]}"} "$APP" --args "$@" || true
cat "$LOG"
# `open -W` exits 0 whatever the app did; the binary's last line carries its code.
CODE=$(sed -n 's/^probe exit \([0-9]*\)$/\1/p' "$LOG" | tail -n1)
exit "${CODE:-1}"
