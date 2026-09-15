#!/usr/bin/env bash
# Regenerate every README screenshot into docs/media/ with fixed names and sizes.
#
#   scripts/make-readme-shots.sh                 # everything (compiles the three harnesses first)
#   scripts/make-readme-shots.sh --skip-build    # reuse the harness binaries from the last run
#   scripts/make-readme-shots.sh --only console  # one group: console | onboarding | orb | icon
#   scripts/make-readme-shots.sh --icon          # also run `pnpm build:icon` (the .icns and the contact strip)
#   scripts/make-readme-shots.sh --audit         # no shots: only check README.md against docs/media
#
# Drives the preview harnesses in apps/mac/Scripts — nothing here starts the app, the
# daemon or a voice session, and nothing touches TCC. Each harness renders its own
# window over fake data: the Console and Setup shots are `screencapture -l <window>`
# of that window only (the launching process needs the Screen Recording grant; without
# it the PNG is the wallpaper), the blob / notch / overlay shots are drawn in-process
# (ORB_SHOT_INPROCESS=1 — no grant needed, nothing of the desktop is read).
# docs/media/banner.png (the README's hero) is NOT produced here: `pnpm build:banner`
# (scripts/make-banner.ts) renders it. apps/mac/Resources/preview-icon-sizes.png (the
# icon contact strip) comes from `pnpm build:icon` (scripts/make-icon.ts); this script
# only copies it to docs/media/icon-sizes.png.
#
# Formats and budgets. Every output is <= 1600 px wide and <= 600 KB (README_SHOTS_MAX_W,
# README_SHOTS_MAX_BYTES). `place <src> <name> [auto|png|jpg]` decides the file:
#   auto (default)  a PNG at <= 1600 px; when that is over budget the file becomes a JPEG
#                   instead (quality 85, then 75, then 1400 and 1200 px) and the run says so
#                   — a fallback changes the extension, so the README audit at the end
#                   reports the reference that no longer resolves.
#   jpg             always a JPEG. The Console: its ground is a dithered field, which no
#                   PNG brings under budget (925 KB at 2360 px, 823 KB at 1200 px; 429 KB
#                   as a 1600 px JPEG at 85). The eyes strip: 773 KB as a 1000 px PNG.
#   png             always a PNG (the icon strip: glyph edges stay crisp); steps 1600 →
#                   1400 → 1200 px and fails when 1200 is still over budget.
# A file that fits nowhere is removed from docs/media and the run exits 1, so a red run
# never leaves an over-budget file behind. The last step audits README.md: every
# docs/media/<file> it names must exist (banner.png only warns — `pnpm build:banner`
# makes it), and every file in docs/media should be named.
#
# Scenarios and the file each one becomes (all in docs/media/):
#
#   console (apps/mac/Scripts/console-preview.sh <scenario>; the window shot @2x, JPEG)
#     threads         console-threads.jpg       the split: Notes + Spotify on the background lane, Slack on the
#                                               screen lane; the Threads rail with Stop on the live ones, one chip
#                                               per spawned thread under its parent card, [Name] tags
#     conversation    console-conversation.jpg  a Claude Code session stepped into: tool calls, folded reasoning,
#                                               a permission question with Allow / Deny, circled regions
#                                               (the harness opens the pane once the app is active, so the
#                                               title bar is active in the shot without any re-keying)
#     jarhead         console-jarhead.jpg       a past Jarhead conversation (paused → resumed chain, "resumed ×1")
#     ledger          console-ledger.jpg        the Ledger tab: day picker, the day's rows, thread and sleep rows
#     settings        console-settings.jpg      asleep, Settings tab, the wake gate listening
#                                               (PREVIEW_WINDOW_SIZE=1180x900 so the retention block ends in frame)
#     problems        console-problems.jpg      the Now tab's typed problems, one remedy button each
#                                               (PREVIEW_WINDOW_SIZE=1180x1040 so all four problems are in frame)
#     cleanup         console-cleanup.jpg       Pinned above the days, Archived folded, Trash open with Restore
#     light           console-light.jpg         the live scenario in the aqua appearance
#     automations     console-automations.jpg   design11: the Automations rail — the ring line under the tabs, the six rows
#                                               with no resting badge, the Trash fold open
#
#   onboarding (apps/mac/Scripts/onboarding-preview.sh <step>; the 620x520 content + title bar, shot @2x → 1240x1104 px)
#     welcome         onboarding-welcome.png
#     brain           onboarding-brain.png      kind, model, base URL, key, probe
#     permissions     onboarding-permissions.png  the sixteen kinds, seven required, "Ask for everything"
#     wake            onboarding-wake.png       the wake word and how it authenticates you
#
#   orb (apps/mac/Scripts/orb-preview.sh; knobs in UI/Orb/OrbPreviewApp.swift; in-process shots)
#     notch run       notch-tucked.png · notch-peek.png · notch-island.png · notch-stay.png
#                     ORB_NOTCH=1: tucked asleep (`- -`), peeking awake, the island under the pointer,
#                     then a fly and the blob staying where it worked with the notch empty.
#                     The harness frames each notch shot as the panel plus 40 pt either side
#                     under the menu-bar band (1272x678 @2x) with the 420x184 island centred, 840 px
#                     wide, its bottom edge at 434 px and the pill slot under it to 486 px; the
#                     island frames are cut to a centred README_NOTCH_CROP (HxW, default 500x920 —
#                     the panel's 460 pt) from the top, the tucked and peek frames to
#                     README_NOTCH_CROP_SMALL (default 270x920), so a 2-up table shows the island,
#                     not the margin. notch-stay keeps its full frame. The island is four bands:
#                     the anchor (face, phase word, Go · Stop · Mute), the display (head, 18 pt hero,
#                     the middle by kind), the control row (Say box, the circling strip), the foot
#                     (meter or problem row, Console · Sleep).
#     notch marks     notch-island-marks.png    ORB_NOTCH_MARKS + ORB_FLEET: three 84x60 films across the display
#                                               (a crop with the amber frame, a skeleton for the one still
#                                               capturing, a used one at half alpha), the caption at the head's
#                                               right end, Clear joining the strip; the harness names the frame
#                                               notch-island-marks itself
#     notch working   notch-island-working.png  ORB_NOTCH_PHASE=acting ORB_NOTCH_WORKING=1 + ORB_NOTCH_REQUEST +
#                                               ORB_FLEET: "Working · 0:02" in the head, the request as the hero,
#                                               two thread tiles with their Stops. ORB_NOTCH_WORKING is
#                                               read by NotchPanel.swift (`previewWorkingFollowsPhase`), not by
#                                               OrbPreviewApp.swift — without it the counter is not drawn;
#                                               ORB_NOTCH_SHOT_TAG=working names the file
#     notch alarm     notch-island-alarm.png    design11: asleep, an alarm rings — ORB_NOTCH_PHASE=asleep ORB_NOTCH_RING +
#                                               ORB_NOTCH_NEXT, Snooze 10 · Done in the consent rects, the foot's next timer
#     eyes            blob-eyes.jpg             every ASCII face, labelled: phases, gate states, poke
#     trace           blob-trace.png            orb.trace: the blob as the pen, the line it drew, the label
#     fly             blob-fly.png              orb.fly: parked beside its target ring
#     gate            blob-gate.png             the wake gate authenticating (Touch ID or passphrase)
#     capsule         blob-capsule.png          the expanded capsule: phase, meter, Pause / Stop / Console
#     drag            blob-drag.png             the jelly drag mid-sweep
#     overlay         overlay-shapes.png        the teaching shapes: circle, arrow, rect, text, stroke
#
#   icon
#     icon-sizes.png  a copy of apps/mac/Resources/preview-icon-sizes.png, the icon contact strip
#                     (16…256 at 1:1, the 16 / 32 / 64 blown up 4x underneath)
#
# Points in the orb recipes assume the 1728x1117 built-in display (the harness header says so).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MAC="$ROOT/apps/mac"
OUT="$ROOT/docs/media"
TMP="${README_SHOTS_TMP:-$MAC/.build/readme-shots}"
MAX_W="${README_SHOTS_MAX_W:-1600}"
MAX_BYTES="${README_SHOTS_MAX_BYTES:-600000}"
NOTCH_CROP="${README_NOTCH_CROP:-500x920}"
NOTCH_CROP_SMALL="${README_NOTCH_CROP_SMALL:-270x920}"

ONLY=""
SKIP_BUILD=0
DO_ICON=0
AUDIT_ONLY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --only) ONLY="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --icon) DO_ICON=1; shift ;;
    --audit) AUDIT_ONLY=1; shift ;;
    -h|--help) sed -n '2,/^set -euo pipefail/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

want() { [[ "$AUDIT_ONLY" == "0" ]] && [[ -z "$ONLY" || "$ONLY" == "$1" ]]; }
mkdir -p "$OUT" "$TMP"
FELL_BACK=""

px_w() { sips -g pixelWidth "$1" | awk '/pixelWidth/ {print $2}'; }
px_h() { sips -g pixelHeight "$1" | awk '/pixelHeight/ {print $2}'; }
bytes() { stat -f %z "$1"; }
report() { printf '  %-30s %5d px wide  %4d KB%s\n' "$(basename "$1")" "$(px_w "$1")" "$(( $(bytes "$1") / 1024 ))" "${2:-}"; }

# shrink <img> <width>: resample in place when wider than that.
shrink() {
  local w; w=$(px_w "$1")
  if (( w > $2 )); then sips --resampleWidth "$2" "$1" >/dev/null; fi
}

# jpeg_at <src> <dst.jpg> <quality> <width>: resample the source (a lossless copy) to the
# width first, then encode once — never a JPEG of a JPEG.
jpeg_at() {
  local tmp="$TMP/.jpeg-src.png"
  cp "$1" "$tmp"; shrink "$tmp" "$4"
  sips -s format jpeg -s formatOptions "$3" "$tmp" --out "$2" >/dev/null
  rm -f "$tmp"
}

# jpeg_ladder <src> <dst.jpg>: quality 85 at MAX_W, then 75, then 1400 and 1200 px at 75.
jpeg_ladder() {
  local src="$1" dst="$2" spec
  for spec in "85 $MAX_W" "75 $MAX_W" "75 1400" "75 1200"; do
    jpeg_at "$src" "$dst" ${spec% *} ${spec#* }
    (( $(bytes "$dst") <= MAX_BYTES )) && return 0
  done
  return 0
}

# png_ladder <src> <dst.png>: a copy at <= MAX_W, then 1400 and 1200 px while over budget.
png_ladder() {
  local src="$1" dst="$2" step
  cp "$src" "$dst"; shrink "$dst" "$MAX_W"
  for step in 1400 1200; do
    (( $(bytes "$dst") <= MAX_BYTES )) && break
    sips --resampleWidth "$step" "$dst" >/dev/null
  done
}

# place <src.png> <name> [auto|png|jpg]: the docs/media file for one shot (see the header).
place() {
  local src="$1" name="$2" mode="${3:-auto}" dst note=""
  [[ -f "$src" ]] || { echo "missing shot: $src" >&2; exit 1; }
  case "$mode" in
    png)
      dst="$OUT/$name.png"; rm -f "$OUT/$name.jpg"
      png_ladder "$src" "$dst"
      ;;
    jpg)
      dst="$OUT/$name.jpg"; rm -f "$OUT/$name.png"
      jpeg_ladder "$src" "$dst"
      ;;
    auto)
      dst="$OUT/$name.png"; rm -f "$OUT/$name.jpg"
      cp "$src" "$dst"; shrink "$dst" "$MAX_W"
      if (( $(bytes "$dst") > MAX_BYTES )); then
        note=" (PNG $(( $(bytes "$dst") / 1024 )) KB, over budget → JPEG)"
        rm -f "$dst"; dst="$OUT/$name.jpg"
        jpeg_ladder "$src" "$dst"
        FELL_BACK="$FELL_BACK $name.jpg"
      fi
      ;;
    *) echo "place: mode must be auto | png | jpg, not '$mode'" >&2; exit 1 ;;
  esac
  if (( $(bytes "$dst") > MAX_BYTES )); then
    echo "  $(basename "$dst") is $(( $(bytes "$dst") / 1024 )) KB at $(px_w "$dst") px — over $((MAX_BYTES / 1000)) KB; removed" >&2
    rm -f "$dst"; exit 1
  fi
  report "$dst" "$note"
}

# crop_notch <img> [HxW]: cut a centred window (default NOTCH_CROP) from the top of a notch frame, in place.
crop_notch() {
  local img="$1" spec="${2:-$NOTCH_CROP}" w h ch cw ox
  w=$(px_w "$img"); h=$(px_h "$img")
  ch=${spec%x*}; cw=${spec#*x}
  (( cw > w )) && cw=$w
  (( ch > h )) && ch=$h
  ox=$(( (w - cw) / 2 ))
  sips -c "$ch" "$cw" --cropOffset 0 "$ox" "$img" >/dev/null
}

# shoot_window <out.png> <log> <settle-seconds> <cmd…>: run a harness binary that prints
# WINDOW_NUMBER=<n>, wait for it, settle, capture that window only, stop the binary.
shoot_window() {
  local out="$1" log="$2" settle="$3"; shift 3
  "$@" > "$log" 2>&1 &
  local pid=$! win
  for _ in $(seq 1 60); do
    grep -q WINDOW_NUMBER "$log" 2>/dev/null && break
    sleep 0.2
  done
  win=$(grep WINDOW_NUMBER "$log" | head -1 | cut -d= -f2)
  [[ -n "$win" ]] || { echo "no WINDOW_NUMBER in $log" >&2; kill "$pid" 2>/dev/null || true; exit 1; }
  sleep "$settle"
  screencapture -x -o -l "$win" "$out"
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

# ---------------------------------------------------------------- console
if want console; then
  echo "console"
  # console <scenario> <name> [WxH]: one Console scenario, the window at that frame size.
  console() {
    local scenario="$1" name="$2" size="${3:-1180x760}"
    PREVIEW_SKIP_BUILD="$SKIP_BUILD" PREVIEW_WINDOW_SIZE="$size" \
      "$MAC/Scripts/console-preview.sh" "$scenario" "$TMP/console-$scenario.png" >/dev/null
    SKIP_BUILD=1   # compiled once; every later scenario reuses the binary
    place "$TMP/console-$scenario.png" "$name" jpg
  }
  console threads       console-threads
  console conversation  console-conversation
  console jarhead       console-jarhead
  console ledger        console-ledger
  console settings      console-settings   1180x900
  console problems      console-problems   1180x1040
  console cleanup       console-cleanup
  console light         console-light
  console automations   console-automations
fi

# ------------------------------------------------------------- onboarding
if want onboarding; then
  echo "onboarding"
  ONB_BIN="$MAC/.build/onboarding-preview/onboarding-preview"
  if [[ "$SKIP_BUILD" != "1" || ! -x "$ONB_BIN" ]]; then
    # The harness script compiles and shoots in one go (it has no skip-build knob); the
    # first step goes through it, the rest drive the binary it built.
    "$MAC/Scripts/onboarding-preview.sh" welcome "$TMP/onboarding-welcome.png" >/dev/null
  else
    PREVIEW_STEP=welcome PREVIEW_SCENARIO=ready shoot_window "$TMP/onboarding-welcome.png" "$TMP/onboarding-welcome.log" 1.5 "$ONB_BIN"
  fi
  place "$TMP/onboarding-welcome.png" onboarding-welcome
  for step in brain permissions wake; do
    PREVIEW_STEP="$step" PREVIEW_SCENARIO=ready shoot_window "$TMP/onboarding-$step.png" "$TMP/onboarding-$step.log" 1.5 "$ONB_BIN"
    place "$TMP/onboarding-$step.png" "onboarding-$step"
  done
fi

# -------------------------------------------------------------------- orb
if want orb; then
  echo "orb"
  ORB_OUT="$MAC/.build/orb-preview"
  ORB_BIN="$ORB_OUT/orb-preview"
  if [[ "$SKIP_BUILD" != "1" || ! -x "$ORB_BIN" ]]; then
    ORB_PREVIEW_OUT="$ORB_OUT" "$MAC/Scripts/orb-preview.sh" --build-only >/dev/null
  fi
  # orb <run-name> <env…>: one harness run, shots in $TMP/orb-<run-name>/, in-process always.
  orb() {
    local run="$1"; shift
    local dir="$TMP/orb-$run"
    rm -rf "$dir"; mkdir -p "$dir"
    env "$@" ORB_SHOT_DIR="$dir" ORB_SHOT_INPROCESS=1 "$ORB_BIN" > "$dir/run.log" 2>&1 || {
      echo "orb run $run failed; see $dir/run.log" >&2; exit 1; }
  }
  # The notch home: tucked, peek, island, a fly, the blob staying where it worked.
  orb notch ORB_NOTCH=1 ORB_NOTCH_NO_POINTER=1 ORB_NO_WINDOWS=1 ORB_BACKDROP=full ORB_EXIT_AFTER=12
  for what in tucked peek; do crop_notch "$TMP/orb-notch/preview-blob-notch-$what.png" "$NOTCH_CROP_SMALL"; done
  crop_notch "$TMP/orb-notch/preview-blob-notch-island.png"
  place "$TMP/orb-notch/preview-blob-notch-tucked.png" notch-tucked
  place "$TMP/orb-notch/preview-blob-notch-peek.png"   notch-peek
  place "$TMP/orb-notch/preview-blob-notch-island.png" notch-island
  place "$TMP/orb-notch/preview-blob-notch-stay.png"   notch-stay
  # The island while a delegation runs: "Working · 0:02" in the head, the request as the hero, two thread tiles.
  orb notch-working ORB_NOTCH=1 ORB_NOTCH_NO_POINTER=1 ORB_NOTCH_PHASE=acting ORB_NOTCH_WORKING=1 \
    ORB_NOTCH_REQUEST="opening the PR in Cursor" ORB_FLEET="Slack:screen:working;Spotify:background:working" \
    ORB_NOTCH_SHOT_TAG=working ORB_FLY_AT=99 ORB_NO_WINDOWS=1 ORB_BACKDROP=full ORB_EXIT_AFTER=4.5
  crop_notch "$TMP/orb-notch-working/preview-blob-notch-island-working.png"
  place "$TMP/orb-notch-working/preview-blob-notch-island-working.png" notch-island-working
  # The ring while asleep (design11): the alarm fires at 1.5 s, the island opens pinned with Snooze 10 · Done, the foot's next timer.
  orb notch-alarm ORB_NOTCH=1 ORB_NOTCH_NO_POINTER=1 ORB_NOTCH_PHASE=asleep ORB_NOTCH_RING="07:10 · Wake up, Kevin" \
    ORB_NOTCH_NEXT="timer:pasta:720" ORB_NOTCH_SHOT_TAG=alarm ORB_FLY_AT=99 ORB_NO_WINDOWS=1 ORB_BACKDROP=full ORB_EXIT_AFTER=4.5
  crop_notch "$TMP/orb-notch-alarm/preview-blob-notch-island-alarm.png"
  place "$TMP/orb-notch-alarm/preview-blob-notch-island-alarm.png" notch-island-alarm
  # The films: three marks (oldest first: used, capturing, pending) as 84x60 films, the caption in the head, Clear in the strip.
  orb notch-marks ORB_NOTCH=1 ORB_NOTCH_NO_POINTER=1 ORB_FLY_AT=99 ORB_NO_WINDOWS=1 ORB_BACKDROP=full \
    ORB_FLEET="Slack:screen:working;Spotify:background:working" \
    ORB_NOTCH_MARKS="used:320x180@-130;capturing:200x120@-2;pending:640x400@-40@Slack" ORB_EXIT_AFTER=4.5
  crop_notch "$TMP/orb-notch-marks/preview-blob-notch-island-marks.png"
  place "$TMP/orb-notch-marks/preview-blob-notch-island-marks.png" notch-island-marks
  # Every face.
  orb eyes ORB_EYES=1 ORB_PHASES=listening ORB_PHASE_SECONDS=60 ORB_EXIT_AFTER=3
  place "$TMP/orb-eyes/preview-blob-eyes.png" blob-eyes jpg
  # orb.trace: the blob as the pen.
  orb trace ORB_X=200 ORB_Y=620 ORB_PHASES=acting ORB_PHASE_SECONDS=60 ORB_NO_WINDOWS=1 ORB_BACKDROP=full \
    ORB_TRACE="700,300;1060,300;1060,460;700,460" ORB_TRACE_CLOSED=1 ORB_EXIT_AFTER=9
  place "$TMP/orb-trace/preview-blob-trace-done.png" blob-trace
  # orb.fly: parked beside the target ring.
  orb fly ORB_X=200 ORB_Y=620 ORB_PHASES=speaking ORB_PHASE_SECONDS=60 ORB_NO_WINDOWS=1 ORB_BACKDROP=full \
    ORB_FLY="1000,300" ORB_EXIT_AFTER=8
  place "$TMP/orb-fly/preview-blob-fly-hover.png" blob-fly
  # The wake gate authenticating.
  orb gate ORB_GATE=authenticating ORB_EXIT_AFTER=4
  place "$TMP/orb-gate/preview-blob-gate-authenticating.png" blob-gate
  # The capsule.
  orb capsule ORB_EXPAND=1 ORB_EXIT_AFTER=4
  place "$TMP/orb-capsule/preview-blob-expanded.png" blob-capsule
  # Jelly drag.
  orb drag ORB_PHASES=listening ORB_PHASE_SECONDS=60 ORB_NO_WINDOWS=1 ORB_DRAG="282,282->700,420@700" ORB_EXIT_AFTER=5
  place "$TMP/orb-drag/preview-blob-drag.png" blob-drag
  # The overlay's teaching shapes.
  orb overlay ORB_OVERLAY=1 ORB_BACKDROP=full ORB_EXIT_AFTER=5
  place "$TMP/orb-overlay/preview-overlay-shapes.png" overlay-shapes
fi

# ------------------------------------------------------------------- icon
if want icon; then
  echo "icon"
  if [[ "$DO_ICON" == "1" ]]; then (cd "$ROOT" && pnpm -s build:icon >/dev/null); fi
  place "$MAC/Resources/preview-icon-sizes.png" icon-sizes png
fi

# ------------------------------------------------------------------ audit
# README.md against docs/media: a name the README uses must exist; a file here should be
# named. banner.png (`pnpm build:banner`) is not this script's to make, so its absence is
# a warning, not a failure.
echo "audit"
missing=0
for ref in $(grep -oE 'docs/media/[A-Za-z0-9._-]+' "$ROOT/README.md" | sort -u); do
  if [[ ! -f "$ROOT/$ref" ]]; then
    case "$(basename "$ref")" in
      banner.png) echo "  $ref is named by README.md and does not exist yet (another tool makes it)" ;;
      *) echo "  $ref is named by README.md and does not exist" >&2; missing=1 ;;
    esac
  fi
done
for f in "$OUT"/*; do
  [[ -f "$f" ]] || continue
  grep -q "docs/media/$(basename "$f")" "$ROOT/README.md" || echo "  docs/media/$(basename "$f") is not referenced by README.md"
done
if [[ -n "$FELL_BACK" ]]; then echo "  fell back to JPEG:$FELL_BACK — point README.md at the .jpg" >&2; fi
if [[ "$missing" == "1" ]]; then echo "README.md names files that are not in docs/media" >&2; exit 1; fi

echo "done → $OUT"
