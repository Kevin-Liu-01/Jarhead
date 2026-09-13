#!/usr/bin/env bash
# Build and run the Orb/Overlay preview harness without the rest of the app.
# Compiles Model + UI/Orb + UI/Overlay with -D JARHEAD_ORB_PREVIEW (which enables
# UI/Orb/OrbPreviewApp.swift's @main) into $OUT and runs it.
#
#   Scripts/orb-preview.sh                 # cycle all phases at 200,200 for 30 s
#   ORB_EXPAND=1 ORB_OVERLAY=1 Scripts/orb-preview.sh
#   ORB_PHASES=listening,speaking ORB_PHASE_SECONDS=4 Scripts/orb-preview.sh
#   ORB_FLING=-2400,900 ORB_SHOT_DIR=Resources Scripts/orb-preview.sh   # throw it at the edges, screenshot the squish
#   ORB_EXPAND=1 ORB_SHOT_DIR=Resources ORB_EXIT_AFTER=4 Scripts/orb-preview.sh   # Resources/preview-blob-expanded.png (no phase shots on this run)
#   ORB_PHASES=listening,thinking,acting ORB_PHASE_SECONDS=2.5 ORB_SHOT_DIR=Resources ORB_EXIT_AFTER=9 Scripts/orb-preview.sh   # the halo at five levels → preview-blob-phase-{listening,thinking,acting}.png
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
#   ORB_NOTCH=1 ORB_NOTCH_NO_POINTER=1 ORB_DRAG_OUT_AT=1.5 ORB_DRAG="644,529->864,60@600" ORB_DRAG_AT=4.0 ORB_FLY_AT=99 ORB_EXIT_AFTER=6.5 Scripts/orb-preview.sh
#                                                                                                     # drop into the dock: the face pulled out of the notch, then dragged back into its column — prints
#                                                                                                     # `send: {"type":"sleep","cause":"dock"}` (never a stop) and tucks in. Points assume the 1728×1117 built-in display.
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
#   The fleet (BlobFleet: one satellite blob per live spawned thread, max 3). ORB_FLEET fakes snapshot.threads at
#   ORB_FLEET_AT (default 1.2 s; 1.6 in notch mode): "Name:lane:status[@x,y][:app]" per thread, ";" between —
#   "working" is acting; @x,y is the record's acting point (Thread.at), :app its app (Thread.app, parked by
#   that app's front window; none under ORB_NO_WINDOWS). Every satellite prints its landing and face; the
#   `fleet check:` line asserts pairwise centres ≥ 92 pt and each ≤ 3 body radii from its target.
#   ORB_X=200 ORB_Y=620 ORB_PHASES=thinking ORB_PHASE_SECONDS=60 ORB_NO_WINDOWS=1 ORB_BACKDROP=full ORB_SHOT_DIR=Resources ORB_SHOT_INPROCESS=1 \
#     ORB_FLEET="Slack:screen:working@1000,300;Spotify:background:working:Spotify;Mail:screen:working@1300,700" ORB_FLEET_FLY="Slack@1000,300;Mail@1300,700@2.4" ORB_EXIT_AFTER=8 Scripts/orb-preview.sh
#                                                                                                     # fleet-three: two satellites beside their targets (tagged orb.fly {thread}), one at a rank slot beside the
#                                                                                                     # main blob (no window named Spotify) → preview-blob-fleet-three.png; faces `o o` / `> >`
#   … ORB_FLEET_STATUS="Mail=waiting-screen@3;Spotify=done@4;Slack=failed@5" ORB_EXIT_AFTER=8 …    # the faces by status: Mail `- -` (waiting on the screen), Spotify `^ ^` 1.2 s then the fade (panel out by
#                                                                                                     # 5.5 s), Slack `x x` 1.6 s with the pill "Slack failed" → fleet-waiting / fleet-done / fleet-failed.png;
#                                                                                                     # prints satellites 3→2→1→0 and the panel pool (3 panels, no allocation after the first spawn)
#   … ORB_FLEET_FLY="Slack@1000,300;Mail@1000,300@1.64" ORB_FLEET_SHOT=avoid …                      # fleet-avoid: two flies to ONE point 40 ms apart land on two sides of it (≥ 92 pt apart); the second's
#                                                                                                     # landing line names the side it fell to ("up-left occupied → up")
#   … ORB_REDUCE_MOTION=1 ORB_FLEET_SHOT=reduce …                                                    # fleet-reduce: satellites appear and move as fades (no "flies" lines, body speed 0), faces still blink
#   ORB_NOTCH=1 ORB_NOTCH_NO_POINTER=1 ORB_NO_WINDOWS=1 ORB_BACKDROP=full ORB_SHOT_DIR=Resources ORB_FLEET="…three…" ORB_EXIT_AFTER=10 Scripts/orb-preview.sh
#                                                                                                     # fleet-notch-peek (three 5 pt squares right of "Working · 0:12"), fleet-notch-island (third row
#                                                                                                     # "Slack · working · 0:03 | Spotify · working · 0:03 | Mail · working · 0:03"), fleet-notch-strip
#                                                                                                     # (the main blob out at its fly; counter + dots on the strip); the dots → 0 after a done + 1.2 s
#   ORB_NOTCH=1 ORB_NOTCH_NO_POINTER=1 ORB_NO_WINDOWS=1 ORB_FLY_AT=99 ORB_FLEET="Slack:screen:working@1000,300" ORB_FLEET_DRAG="Slack->dock@3" ORB_EXIT_AFTER=6 Scripts/orb-preview.sh
#                                                                                                     # fleet-drag-stop: the satellite dragged into NotchGeometry.catchZoneCG → exactly one
#                                                                                                     # `send: {"type":"thread.stop",…}`, never a sleep, never set-settings (the `fleet sends:` line at exit
#                                                                                                     # counts them); it shivers and fades → preview-blob-fleet-drag-stop.png. "Mail->600,600@3" parks it there.
#   … ORB_FLEET_CLICK="Spotify@2.5" …                                                                 # a posted click on the satellite → openThread(t_spotify) + openConsole(); prints its menu items
#   … ORB_FLEET_BUDGET_LOG=1 ORB_FLEET_FLY="Slack@1000,300;Mail@1300,700;Slack@600,700@4;Mail@1000,300@6" ORB_EXIT_AFTER=12 …
#                                                                                                     # fleet-budget: per-second mean / p95 fleet-frame ms and the rung (0 on this Mac with three bodies moving)
#   … ORB_FLEET_BUDGET_LOG=1 ORB_FLEET_BUDGET_FORCE_MS=9 ORB_FLEET_BUDGET_FOR=4 ORB_EXIT_AFTER=12 …   # the ladder: a synthetic 9 ms per frame steps 0→1→2→3 (→4) a window apart, recovers to 0 within 2 s of the load ending
#   … ORB_FLEET_BUDGET_FORCE_MS=9 ORB_FLEET_BUDGET_FOR=7 ORB_FLEET_LATE="7.5:Notes:screen:working" ORB_FLEET_STATUS="Spotify=done@8;Mail=done@8.3" ORB_EXIT_AFTER=12.5 …
#                                                                                                     # rung 4 (held load): the third satellite stays, the late fourth is a dot only ("is a dot only"), and it
#                                                                                                     # gets a satellite only once fewer than two remain (after the second done leaves)
#   … ORB_FLEET_STATUS="Spotify=done@3" ORB_FLEET_LATE="3.2:Notes:screen:working" ORB_EXIT_AFTER=7 …  # the pool: a fourth live thread while a finished one's panel still fades is a dot only (+0.3 s), then
#                                                                                                     # takes that panel (+1.5 s); `made` stays 3 — no fourth SatellitePanel is ever allocated
#   … ORB_FLEET="Slack:screen:working" ORB_FLEET_FLY="Ghost@900,500@2;Notes@1200,600@2.4" ORB_FLEET_LATE="3:Notes:screen:working" ORB_EXIT_AFTER=6 …
#                                                                                                     # pendingFlies: a tagged fly for a thread that never appears is dropped after 2 s (`fleet pending:` 1 → 0);
#                                                                                                     # one whose record arrives inside 2 s is taken at the spawn ("takes the fly kept for it", then its flight)
#   … ORB_FLEET="Slack:screen:working" ORB_FLEET_TRACE="Slack@900,400;1100,400;1100,520;900,520@closed@2" ORB_EXIT_AFTER=6 …
#                                                                                                     # a tagged orb.trace: the satellite flies beside the first point, exactly one untagged `.stroke` with the
#                                                                                                     # closing point (5 for a closed 4-point rect), the main blob unmoved
#   … ORB_FLEET="Slack:screen:working@1000,300" ORB_FLEET_HOVER="Slack@3" ORB_EXIT_AFTER=6 …        # the name tag: the pointer enters the cell → OrbPill 'Slack' (fleet-hover.png), still up 0.6 s after it
#                                                                                                     # leaves, gone 1.5 s after (tagShow 1.2 s); the cell has one tracking area
#   … ORB_STOP_AT=3 … / … ORB_SLEEP_AT=4 …                                                            # every satellite shivers and is gone within 300 ms (the `fleet: retired N` line, then the counts)
#   ORB_NOTCH=1 ORB_NOTCH_NO_POINTER=1 ORB_NOTCH_WORKING=1 ORB_NOTCH_PHASE=acting ORB_FLY_AT=99 ORB_NOTCH_STRIP_PROBE=2.5 ORB_EXIT_AFTER=3 Scripts/orb-preview.sh
#                                                                                                     # the working strip without threads: the hairline and the counter both at work·(1−park) — 0.50 at
#                                                                                                     # park ½ and at work ½, measured off an offscreen render (the pre-fleet alpha; the transitions only)
#   ORB_SELFTEST=1 Scripts/orb-preview.sh                                                             # the pure checks (FleetBudget ladder on a synthetic clock, landing(for:avoiding:)); exit 0 / 1
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
