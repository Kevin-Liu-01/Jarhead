#!/usr/bin/env bash
# Build and run the Orb/Overlay preview harness without the rest of the app.
# Compiles Model + UI/Orb + UI/Overlay with -D JARHEAD_ORB_PREVIEW (which enables
# UI/Orb/OrbPreviewApp.swift's @main) into $OUT and runs it.
#
#   Scripts/orb-preview.sh                 # cycle all phases at 200,200 for 30 s
#   ORB_EXPAND=1 ORB_OVERLAY=1 Scripts/orb-preview.sh
#   ORB_PHASES=listening,speaking ORB_PHASE_SECONDS=4 Scripts/orb-preview.sh
#   ORB_FLING=-2400,900 ORB_SHOT_DIR=Resources Scripts/orb-preview.sh   # throw it at the edges, screenshot the squish
#   ORB_EXPAND=1 ORB_SHOT_DIR=Resources ORB_EXIT_AFTER=4 Scripts/orb-preview.sh   # Resources/preview-blob-expanded.png
#   ORB_GATE=authenticating,locked ORB_SHOT_DIR=Resources ORB_EXIT_AFTER=6 Scripts/orb-preview.sh   # the wake gate on the blob + pill
#   ORB_GATE=authenticating ORB_EXPAND=1 ORB_KEY_TEST=1 ORB_NO_DISMISS=1 ORB_EXIT_AFTER=5 Scripts/orb-preview.sh   # capsule gate row, Cancel, field, key handshake
#   ORB_X=200 ORB_Y=620 ORB_PHASES=speaking ORB_PHASE_SECONDS=60 ORB_NO_WINDOWS=1 ORB_BACKDROP=full ORB_FLY="1000,300" ORB_SHOT_DIR=Resources ORB_SHOT_INPROCESS=1 ORB_EXIT_AFTER=8 Scripts/orb-preview.sh
#                                                                                                     # orb.fly: wind-up, out, one squish, parked 2 s beside the ring, then it STAYS there (free mode: "stay where you
#                                                                                                     # worked" — the spot is persisted once, the perch is left alone) → preview-blob-fly-{outbound,hover}.png, preview-blob-stay.png
#   ORB_NOTCH=1 ORB_NOTCH_NO_POINTER=1 ORB_SHOT_DIR=Resources ORB_NO_WINDOWS=1 ORB_BACKDROP=full ORB_EXIT_AFTER=12 Scripts/orb-preview.sh   # notch mode with a simulated notch: tucked (asleep, `- -`), awake (peeking), the island under the
#                                                                                                     # pointer, then a fly: drop out, work, STAY where it worked, then sleep at ~8.6 s and tuck → preview-blob-notch-{tucked,peek,island,drop,stay,return}.png
#                                                                                                     # (+ fly-outbound/hover). In-process shots over a drawn menu bar and the notch's black.
#   ORB_PHASES=listening ORB_PHASE_SECONDS=60 ORB_NO_WINDOWS=1 ORB_PAUSE_AT=1.5 ORB_SHOT_DIR=Resources ORB_SHOT_INPROCESS=1 ORB_EXIT_AFTER=4 Scripts/orb-preview.sh
#                                                                                                     # press Pause (the capsule's): prints the command, the harness answers with the paused phase → preview-blob-paused.png
#                                                                                                     # (the `u u` face, titanium, the "Paused · meter stopped" pill; on its own — not over a fly, whose target ring would show)
#   ORB_FLY="1000,300;1300,700" ORB_FLY_EVERY=2 ORB_FLY_HOME=1 ORB_EXIT_AFTER=9 Scripts/orb-preview.sh   # two flies 2 s apart (retargets mid-hover), then orb.home; prints each flight phase change (stamped in seconds)
#   ORB_FLY="1000,300;1000,300" ORB_FLY_EVERY=2 ORB_EXIT_AFTER=8 Scripts/orb-preview.sh              # the same work twice: the second only extends the hover (no "hovering -> outbound")
#   ORB_FLING=600,-300 ORB_FLING_AT=1.0 ORB_FLY="1000,300" ORB_FLY_AT=1.3 ORB_EXIT_AFTER=9 Scripts/orb-preview.sh   # a fly during Kevin's throw waits for it to land, the rest is persisted (send: set-settings), then it flies and comes home to it
#   ORB_FLY="1000,300" ORB_FLY_AT=1 ORB_EXPAND=1 ORB_EXPAND_AT=3 ORB_TOGGLE_AT=4 ORB_NO_DISMISS=1 ORB_EXIT_AFTER=8 Scripts/orb-preview.sh   # capsule opened mid-hover, closed: it goes home, the hover spot is never persisted
#   ORB_FLY="1000,300" ORB_FLY_AT=1 ORB_HIDE_AT=1.5 ORB_SHOW_AT=2.5 ORB_EXIT_AFTER=6 Scripts/orb-preview.sh   # hidden mid-flight: reappears on its perch, flight over
#   ORB_FLY="800,-700" ORB_EXIT_AFTER=8 Scripts/orb-preview.sh                                        # a target on another display (CG space): hop first, then the landing is picked from where it lands
#   ORB_OVERLAY=1 ORB_BACKDROP=full ORB_SHOT_DIR=Resources ORB_EXIT_AFTER=5 Scripts/orb-preview.sh   # overlay: hands' cues + one of each teaching shape → preview-overlay-shapes.png; seam probe prints per-window item/label counts
#   ORB_MARK=1 ORB_BACKDROP=full ORB_SHOT_DIR=Resources ORB_EXIT_AFTER=4 Scripts/orb-preview.sh      # overlay: mark mode, a synthesised stroke → prints mark.add, preview-overlay-mark.png
#   ORB_MARK=seam ORB_EXIT_AFTER=4 Scripts/orb-preview.sh                                             # overlay: the stroke crosses the main display's top edge → live stroke on every window, mark.add with y < 0
#   ORB_MARK=click / ORB_MARK=cancel …                                                                # overlay: the cancel paths (no movement / Escape); see UI/Overlay/OverlayPreviewDemo.swift
#   ORB_PHASES=listening ORB_PHASE_SECONDS=60 ORB_NO_WINDOWS=1 ORB_DRAG="282,282->700,420@700" ORB_SHOT_DIR=Resources ORB_EXIT_AFTER=5 Scripts/orb-preview.sh
#                                                                                                     # jelly: a synthetic drag from the blob's centre; prints lag/stretch/wobble/eyes (and the jiggle for 1 s after release), → preview-blob-drag.png (the teardrop mid-sweep)
#   ORB_X=60 ORB_Y=300 ORB_PHASES=listening ORB_PHASE_SECONDS=60 ORB_NO_WINDOWS=1 ORB_DRAG="142,382->20,382@900" ORB_EXIT_AFTER=5 Scripts/orb-preview.sh
#                                                                                                     # sticky by hand: pushed into the left wall it sticks while held (stuck 1 before "released"), let go it sags into the dome (press 1.0 → 0.62 over ~1 s, no jump)
#   ORB_X=200 ORB_Y=300 ORB_PHASES=listening ORB_PHASE_SECONDS=60 ORB_NO_WINDOWS=1 ORB_STICK=1 ORB_SHOT_DIR=Resources ORB_EXIT_AFTER=7 Scripts/orb-preview.sh
#                                                                                                     # sticky: thrown at the nearest wall slow enough to stick, parks (→ preview-blob-stick.png), pulled off (→ preview-blob-peel.png: the neck), snaps
#   … ORB_STICK=1 ORB_STICK_PULL=30 …                                                                 # let go mid-cling (neck ≈ 0.4): prints the sag back onto the patch every 50 ms — the centre eases ~1 pt a step, never jumps
#   ORB_X=118 ORB_Y=798 ORB_PHASES=listening ORB_PHASE_SECONDS=60 ORB_NO_WINDOWS=1 ORB_FLING=-500,500 ORB_EXIT_AFTER=6 Scripts/orb-preview.sh   # a slow throw into the bottom-left corner: "settled … stuck 2" — one patch per wall
#   ORB_EYES=1 ORB_PHASES=listening ORB_PHASE_SECONDS=60 ORB_SHOT_DIR=Resources ORB_EXIT_AFTER=3 Scripts/orb-preview.sh   # every expression (the ASCII faces: `- -` `O O` `^ ^` `u u` `x x` …) in one labelled strip → preview-blob-eyes.png
#   ORB_X=200 ORB_Y=620 ORB_PHASES=acting ORB_PHASE_SECONDS=60 ORB_NO_WINDOWS=1 ORB_BACKDROP=full ORB_TRACE="700,300;1060,300;1060,460;700,460" ORB_TRACE_CLOSED=1 ORB_SHOT_DIR=Resources ORB_EXIT_AFTER=9 Scripts/orb-preview.sh
#                                                                                                     # orb.trace: flies to the first point as the pen (cursor form), drags the line along the points while the
#                                                                                                     # overlay draws it growing from under the tip, seals it, holds, stays by its line → preview-blob-trace-cursor.png
#                                                                                                     # (mid-line) and preview-blob-trace-done.png; prints progress, the pen/tip error and the eyes every 0.25 s.
#                                                                                                     # ORB_TRACE_LABEL, ORB_TRACE_TONE=accent|ok|warn|mark, ORB_TRACE_AT (default 1.2) tune it
#   ORB_MARK=1 ORB_TRACE="…" ORB_TRACE_AT=3 ORB_BACKDROP=full ORB_SHOT_DIR=Resources ORB_EXIT_AFTER=10 Scripts/orb-preview.sh   # Kevin's mark first (mark tone), then Jarhead's line: both on one layer → preview-overlay-trace.png
#   ORB_TRACE="…" ORB_STOP_AT=3.2 ORB_EXIT_AFTER=7 Scripts/orb-preview.sh                            # Stop mid-line: the capsule's Stop as pressed — prints the stop command, the clear, the "Stopped" pill;
#                                                                                                     # the line comes down, the pen morphs back with a shiver and stays put → preview-blob-stop.png
#   ORB_TRACE="…" ORB_CLEAR_AT=3.2 ORB_EXIT_AFTER=7 Scripts/orb-preview.sh                           # the brain's show_clear mid-line: the line comes down and the pen morphs back quietly — no Stop, no pill
#   ORB_FLY="700,300" ORB_CLEAR_AT=2.6 ORB_EXIT_AFTER=7 Scripts/orb-preview.sh                       # … and during a plain fly the hover is left alone (a clear is not a Stop)
#
# Screenshots land as <ORB_SHOT_DIR>/preview-blob-<what>.png, via screencapture when the
# launching app has the Screen Recording grant, else drawn in-process from the panel's
# layers (ORB_SHOT_INPROCESS=1 forces that). The harness never talks to the daemon or
# OpenAI: AppState is fed a fake snapshot and commands are printed.
# See OrbPreviewApp.swift for every environment knob. Pass --build-only to skip running.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${ORB_PREVIEW_OUT:-${TMPDIR:-/tmp}/jarhead-orb-preview}"
mkdir -p "$OUT"
BIN="$OUT/orb-preview"

swiftc -parse-as-library -O -D JARHEAD_ORB_PREVIEW \
  -target arm64-apple-macosx14.0 \
  -framework AppKit -framework SwiftUI -framework Combine \
  Sources/Jarhead/Model/*.swift \
  Sources/Jarhead/UI/*.swift \
  Sources/Jarhead/UI/Orb/*.swift \
  Sources/Jarhead/UI/Overlay/*.swift \
  -o "$BIN"

echo "built $BIN"
if [[ "${1:-}" == "--build-only" ]]; then exit 0; fi
exec "$BIN"
