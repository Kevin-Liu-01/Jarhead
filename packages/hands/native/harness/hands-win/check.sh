#!/bin/sh
# The hands-win decision harness: the helper's own HandsWin.swift compiled with this directory's
# main.swift, then run. Headless: no CGEvent is posted, no AX is read, no window opens.
# usage: check.sh [build dir]   (default: a fresh temp dir)
# packages/hands/src/__tests__/hands-win-native.test.ts runs it under `pnpm test`.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
native=$(cd "$here/../.." && pwd)
out=${1:-$(mktemp -d "${TMPDIR:-/tmp}/hands-win.XXXXXX")}
swiftc -swift-version 5 -module-name HandsWinCheck -o "$out/hands-win-check" "$native/HandsWin.swift" "$here/main.swift"
"$out/hands-win-check"
