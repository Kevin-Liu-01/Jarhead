#!/usr/bin/env bash
# One Jarhead per state dir (App/SingleInstance.swift): the decision table, the claim's flock on a
# temp state dir (a SIGKILLed holder never blocks a launch, no child inherits the claim), the reads
# checking nothing in with LaunchServices, and `ensureOne` end to end in child processes (claim free:
# proceed; claim held: one log line, the hand-off posted and heard, exit 0).
#   Scripts/single-instance-check.sh                # run the checks (a second or two)
#   Scripts/single-instance-check.sh --build-only
# Compiles App/SingleInstance.swift + Scripts/SingleInstanceCheckMain.swift into its own output
# directory, and only when a source is newer than the binary. No NSApplication, no window, no Dock
# tile, nothing of Jarhead's launched; the temp state dir is removed. Exit 1 on a FAIL.
set -euo pipefail
cd "$(dirname "$0")/.."
BUILD=".build/single-instance-check"
BIN="$BUILD/single-instance-check"
mkdir -p "$BUILD"
SOURCES=(Sources/Jarhead/App/SingleInstance.swift Scripts/SingleInstanceCheckMain.swift)
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

# The probes and harnesses never pass for a second Jarhead: every one that starts AppKit sets an
# activation policy (.prohibited, or .accessory where it must take events) as the very next
# statement, every probe bundle is LSUIElement under its own id and name, and no script opens a
# bundle named Jarhead.app with `open -n`. (Read from the sources: nothing here is run.)
echo "== probes"
fail=0
for f in Scripts/*Main.swift Sources/Jarhead/UI/Orb/OrbPreviewApp.swift; do
  grep -q "NSApplication.shared" "$f" || continue
  line=$(grep -n "NSApplication.shared" "$f" | head -n1 | cut -d: -f1)
  next=$(awk -v l="$line" 'NR > l && $0 !~ /^[[:space:]]*(\/\/.*)?$/ { print; exit }' "$f")
  if [[ "$next" =~ setActivationPolicy\(\.(prohibited|accessory)\) ]]; then
    echo "check: ok $f sets .${BASH_REMATCH[1]} right after NSApplication.shared"
  else
    echo "check: FAIL $f: the statement after NSApplication.shared is not setActivationPolicy(.prohibited) or (.accessory)"
    fail=1
  fi
done
for p in Scripts/*-Info.plist; do
  id=$(plutil -extract CFBundleIdentifier raw -o - "$p" 2>/dev/null || echo none)
  name=$(plutil -extract CFBundleName raw -o - "$p" 2>/dev/null || echo none)
  ui=$(plutil -extract LSUIElement raw -o - "$p" 2>/dev/null || echo missing)
  if [[ "$ui" == "true" && "$id" != "com.kevinliu.jarhead" && "$name" != "Jarhead" ]]; then
    echo "check: ok $p is LSUIElement as $id ($name)"
  else
    echo "check: FAIL $p: LSUIElement $ui, id $id, name $name (a probe bundle must be LSUIElement and never Jarhead)"
    fail=1
  fi
done
for s in Scripts/*.sh; do
  [[ "$s" == "Scripts/$(basename "$0")" ]] && continue
  grep -qE '^[^#]*open -n' "$s" || continue
  if grep -qE '^[^#]*APP=.*Jarhead\.app' "$s"; then
    echo "check: FAIL $s opens a bundle named Jarhead.app with open -n"
    fail=1
  else
    echo "check: ok $s: open -n starts its own probe bundle, never Jarhead.app"
  fi
done

"$BIN" || fail=1
exit "$fail"
