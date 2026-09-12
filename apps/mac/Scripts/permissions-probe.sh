#!/usr/bin/env bash
# Read-only permissions probe: prints every permission as the readers see it and then
# a dry-run sweep (what "Ask for everything" would ask, in order, and which System
# Settings panes it would open). Nothing prompts, nothing opens.
#   Scripts/permissions-probe.sh              # readers + dry-run sweep
#   PROBE_SWEEP=0 Scripts/permissions-probe.sh   # readers only
#   JARHEAD_PERMISSIONS_DRY_RUN_DENY=screenRecording,accessibility,filesDesktop,filesDocuments \
#     Scripts/permissions-probe.sh            # pretend those are denied (dry run only), so the
#                                             # sweep's prompt-wait and grouped-pane steps show
# The statuses are THIS process's — TCC attributes a shell-launched binary to Terminal —
# so they say whether the readers work, not what Jarhead.app has been granted. Compiles
# Model + Permissions + Scripts/PermissionsProbeMain.swift into its own output directory.
set -euo pipefail
cd "$(dirname "$0")/.."
BUILD=".build/permissions-probe"
mkdir -p "$BUILD"
swiftc -O -swift-version 5 -parse-as-library -target arm64-apple-macosx14.0 \
  -o "$BUILD/permissions-probe" \
  Sources/Jarhead/Model/*.swift Sources/Jarhead/Permissions/*.swift \
  Scripts/PermissionsProbeMain.swift
JARHEAD_PERMISSIONS_DRY_RUN=1 exec "$BUILD/permissions-probe"
