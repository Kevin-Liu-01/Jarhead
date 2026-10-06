#!/bin/sh
# The run-blocking harness: the helper's own Protocol.swift compiled with this directory's main.swift,
# then run. Headless: nothing is captured, posted or read; no window opens.
# usage: check.sh [build dir]   (default: a fresh temp dir)
# packages/hands/src/__tests__/run-blocking-native.test.ts runs it under `pnpm test`.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
native=$(cd "$here/../.." && pwd)
out=${1:-$(mktemp -d "${TMPDIR:-/tmp}/run-blocking.XXXXXX")}
# The shipped helper's deployment target (scripts/build-hands.ts), so an API newer than it fails here too.
swiftc -swift-version 5 -target "$(uname -m)-apple-macos14.0" -module-name RunBlockingCheck -o "$out/run-blocking-check" "$native/Protocol.swift" "$here/main.swift"
"$out/run-blocking-check"
