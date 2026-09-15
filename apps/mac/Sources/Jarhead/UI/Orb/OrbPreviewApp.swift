#if JARHEAD_ORB_PREVIEW
import AppKit
import Combine
import QuartzCore
import SwiftUI

// Throwaway preview harness: compiled only by Scripts/orb-preview.sh (which passes
// -D JARHEAD_ORB_PREVIEW). Cycles the phases with fake levels, fires overlay
// commands around the orb, can throw the blob at the screen edges, takes its own
// screenshots at the interesting moments, and exits on its own.
//
// Environment knobs:
//   ORB_X / ORB_Y          CG top-left position of the orb (default 200,200)
//   ORB_PHASE_SECONDS      seconds per phase (default 2.5)
//   ORB_PHASES             comma list to cycle (default all)
//   ORB_EXPAND=1           expand the capsule after ORB_EXPAND_AT s (default 1; screenshot 1.2 s later)
//   ORB_TOGGLE_AT=s        toggle the capsule again at that time (with ORB_EXPAND: collapse it), printing
//                          the flight phase and the perch — with ORB_FLY: expand mid-hover, collapse,
//                          and the blob must stay where it is (saved, not the perch), not go anywhere
//   ORB_HIDE_AT / ORB_SHOW_AT=s   hide() / show() the orb at those times, printing the flight phase and
//                          where the body is (hide mid-flight: it must reappear where it was, flight over)
//   ORB_CLICK_TEST=1       synthetic clicks at 1.5 s: the blob (expects expand), then the
//                          capsule's Stop and Console buttons (expects a stop command and
//                          openConsole()); prints each result
//   ORB_SUMMON=1           summon() after 1.5 s
//   ORB_OVERLAY=1          fire overlay commands near the orb
//   ORB_EXIT_AFTER         seconds until exit (default 30)
//   ORB_BACKDROP=WxH       near-black backdrop window of that size behind the orb
//   ORB_BACKDROP=full      … covering the whole work area of the main display
//   ORB_BACKDROP_LIGHT=1   … light grey instead, to check contrast
//   ORB_APPEARANCE=light|dark  force the app appearance (default: follow the system)
//   ORB_HIDE=1             hide the orb right away (CPU baseline of the harness itself)
//   ORB_FLING=vx,vy        throw the blob with that CG velocity (pt/s) at ORB_FLING_AT s (default 1.2)
//   ORB_OBSTACLE=x,y,w,h   a solid grey window at that CG rect, registered as an obstacle
//   ORB_SHOT_DIR=/dir      take screenshots there, named <ORB_SHOT_PREFIX, default
//                          preview-blob-><what>.png: squish-N whenever the blob is pressed
//                          (≥ ORB_SHOT_PRESS, default 0.3; up to 4, 0.5 s apart), phase-<name>
//                          1.2 s into each phase (the collapsed blob's halo — not taken on an
//                          ORB_EXPAND or ORB_OVERLAY run, which would overwrite them with the
//                          capsule), rest when it settles, expanded with ORB_EXPAND,
//                          gate-<name> with ORB_GATE
//   ORB_GATE=list          wake gate states to cycle while asleep (comma list of listening,
//                          heard, authenticating, granted, denied, locked; default: all of
//                          them), ORB_GATE_SECONDS each (default 2.5). Holds the phase asleep,
//                          turns the wake word on with a passphrase enrolled
//                          (ORB_PASSPHRASE_SET=0 for none), and while listening feeds fake
//                          heard words every 0.8 s so the calibration ripple shows.
//                          Screenshots gate-<name> 1.2 s in (heard: 0.15 s, while it flashes).
//   ORB_GATE_METHOD=text   the authenticating method (default "Touch ID or passphrase")
//   ORB_KEY_TEST=1         with ORB_EXPAND=1 and a gate: at 2.6 s dumps the capsule's AppKit
//                          subtree (Cancel's proxy view must be ~53 wide, not 18) and clicks the
//                          capsule's Cancel twice — its left third, then its centre (expects
//                          cancelAuth() twice, panel not key) — then the passphrase field
//                          (the panel asks to become key; the window server grants that
//                          only for a real click, so from the harness's posted click the
//                          field takes first responder but the panel stays non-key), types
//                          "open sesame", presses Return (expects submitPassphrase and the
//                          field to let go), and prints each result
//   ORB_NO_DISMISS=1       keep the capsule open through the run: skip the click-outside
//                          monitors, so a real click elsewhere on the Mac cannot collapse it
//                          mid-test (the app always installs them)
//   ORB_KEY_PROBE=1        with ORB_KEY_TEST: first tries makeKey directly, inactive and
//                          after activate(), and reports; a background process a real
//                          click has not touched gets neither
//   ORB_SHOT_INPROCESS=1   draw the screenshots in-process (the panel's layer tree over the
//                          backdrop colour) instead of screencapture, which needs the Screen
//                          Recording grant for whatever launched the harness. Automatic when
//                          screencapture fails.
//   ORB_FLY="x,y;x,y;…"    orb.fly commands (CG points) sent on state.overlayCommands, the
//                          first at ORB_FLY_AT s (default 1.2), then ORB_FLY_EVERY s apart
//                          (default 2), dwellMs ORB_FLY_DWELL (default 2000). Each target
//                          gets a small ring window so "beside the target" is visible. With
//                          ORB_SHOT_DIR, screenshots fly-outbound (in flight, trail behind), fly-hover
//                          (parked beside the target), and — free mode — stay 0.6 s after the hover
//                          ran out: the blob settled where it worked, the perch (a dashed ring, where
//                          it came from) left empty (notch mode: notch-stay, the empty notch in frame
//                          too). With ORB_FLY_HOME (free mode) fly-home: drifting back to the perch,
//                          framed to take in the perch and the ghosts; a sleep (ORB_SLEEP_AT, on by
//                          default in notch mode) shoots notch-return — the way back up, framed with the
//                          notch. Targets may be on any display (this Mac: the Samsung above the
//                          built-in is CG y < 0). Prints
//                          the flight phase, speed and ghost count as it goes, each take-off's
//                          landing spot, and after each command the hover left / whether it is
//                          waiting for Kevin's own throw to land (ORB_FLING just before it)
//   ORB_FLY_HOME=1         send orb.home ORB_FLY_HOME_AT s after the last orb.fly (default 1.0)
//   ORB_REDUCE_MOTION=1    pretend the system's reduce-motion is on, for the sim and for every Motion
//                          token (Motion.reducedOverride): no trail, softer cues, plain fades, halved
//                          durations, the instant tuck
//   ORB_DRAG="x0,y0->x1,y1@ms"  a synthetic drag through the panel's own mouse path: the hand
//                          comes down at CG x0,y0 (put it on the blob: its centre is ORB_X+82,
//                          ORB_Y+82), sweeps to x1,y1 over ms (default 700) with an ease-in-out,
//                          lets go. Starts at ORB_DRAG_AT s (default 1.0). Prints the lag, the
//                          field's stretch, the wobble (slosh rows / ellipse mode), the speed and
//                          the eyes every 0.1 s, and the wobble for a second after the release; with
//                          ORB_SHOT_DIR shoots drag.png once the stretch reaches
//                          ORB_DRAG_SHOT_STRETCH (default 0.3) or mid-sweep, the hand drawn as
//                          a small cross in the in-process shot, then rest.png when it settles
//   ORB_STICK=1            sticky borders: at ORB_STICK_AT s (default 1.0) throws the blob at the
//                          nearest work-area wall just fast enough to arrive under the stick
//                          speed (ORB_STICK_V=pt/s overrides), waits for it to park on the wall
//                          (shoots stick.png: the dome spread on the edge), then 0.8 s later a
//                          synthetic drag pulls it ORB_STICK_PULL pt (default 95) straight off
//                          over 1100 ms (shoots peel.png when the neck reaches ORB_STICK_NECK,
//                          default 0.5) and lets go. Prints the stick, the neck as it grows, the
//                          snap and where it comes to rest
//   ORB_EYES=1             the expression strip: at ORB_EYES_AT s (default 1.0) pins each phase,
//                          then each wake gate state while asleep, then a poke, settles the
//                          field for each and renders them side by side, labelled, to
//                          <ORB_SHOT_DIR>/<prefix>eyes.png (in-process; needs ORB_SHOT_DIR)
//   ORB_TRACE="x,y;x,y;…"  an orb.trace (CG points) on state.overlayCommands at ORB_TRACE_AT s
//                          (default 1.2); ORB_TRACE_CLOSED=1 closes the loop, ORB_TRACE_LABEL (default
//                          "Deploy button", "" for none) and ORB_TRACE_TONE=accent|ok|warn|mark
//                          (default accent) dress it. Prints the flight phases ("tracing" is the
//                          drawing), and every 0.25 s while drawing: the pen's progress, where the
//                          pen and the field's tip are and how far apart (the glue), the cursor
//                          form's depth and the eyes; then the seal, the hold and the way home —
//                          with how many of the drawing's frames (sampled 60×/s) had no eyes. With
//                          ORB_SHOT_DIR: trace-cursor (mid-line: the pen form and the growing line)
//                          and trace-done (the whole line, the pen still on it), framed to take in
//                          the stroke, the perch and the label pill. The stroke itself is the
//                          overlay's: in-process shots paint the overlay windows too
//   ORB_NOTCH=1            notch mode with a simulated notch (NotchGeometry.simulate: the measured
//                          185×32 at the top of the main display, under its menu bar). The blob
//                          starts tucked (asleep, `- -`); the script wakes it at 1.3 s (peeking),
//                          hovers the island 2.7–3.7 s, and with ORB_FLY (default "1000,420" at
//                          4.6 s) drops it out, flies, hovers, and STAYS where it worked; then the
//                          phase falls asleep (ORB_SLEEP_AT, default 2 s after the hover) and it
//                          drifts back up and tucks in — the dock is for sleeping and waking. With ORB_SHOT_DIR:
//                          notch-tucked (1.0 s), notch-peek (2.5 s), notch-island (3.4 s) and
//                          notch-drop (the hop out, just after the fly) — all in-process, over a
//                          drawn menu bar band and the hardware notch's black, so the island can be
//                          judged against the bezel. ORB_PHASE_SECONDS defaults to 60 here.
//                          Without ORB_NOTCH the harness pins orbHome to "free" (this Mac has a
//                          notch, and every other scenario is a free-mode scenario).
//   ORB_NOTCH_NO_POINTER=1 the real pointer never opens or closes the island (only the script's
//                          previewNotchHover does): for the shots when the mouse sits under the notch
//   ORB_FACE_LOG=1         print the face (`BlobSim.face`, the drawn glyph pair) every time it changes,
//                          stamped: an expression change must read as a ~90 ms `- -` blink between the
//                          old pair and the new (`O O` → `- -` → `u u` on a pause), except the reactions
//   ORB_TIMELINE=1         one line per display frame through the way into the notch and out of it
//                          ("timeline <stage> t centre speed scale alpha face"): the approach (an
//                          ease-out to a staging point 16 pt under the dock — the peak speed and the
//                          speed at the staging point are the proof of the deceleration), the slip (the
//                          body rising under the ink over Motion.tuckSlip, scale 1 → 0.55, alpha 1 → 0,
//                          the notch handed the face at 60%) and the drop (0.6 → 1, clear → solid, the
//                          hop). With ORB_SHOT_DIR the tuck is shot mid-slip too: notch-tuck-staging (the
//                          slip's first frame), notch-tuck-slip-mid (~35%), notch-tuck-slip-late (~75%,
//                          the notch face up under the vanishing body) and notch-drop-early (the drop
//                          ~20% grown in) — in-process, framed with the notch
//   ORB_NOTCH_PHASE=name   the awake phase the notch script wakes into at 1.3 s (default listening):
//                          the peek and island shots in that phase's colour
//   ORB_NOTCH_HOVER=name   notch mode: draw that island button hovered in the shots (pause|stop|mute;
//                          "pause" is the transport circle) — the hover lift, for judging it
//   ORB_NOTCH_PRESSED=name notch mode: draw that island button pressed (the accent fill)
//   ORB_NOTCH_SHOT_TAG=tag notch mode: the notch shots are named notch-<what>-<tag>.png, so a hover or
//                          pressed variant sits beside the plain one instead of replacing it. With
//                          ORB_REDUCE_MOTION=1 the notch's fades, stagger and spring follow the knob
//                          too (NotchView reads the sim's flag, not NSWorkspace): a true reduced pass
//   ORB_NOTCH_OPENING_SHOTS=1  notch mode, with ORB_SHOT_DIR: four more shots off the mode flips (from
//                          `watch()`, 60 Hz — the script's own clock drifts): notch-island-opening-1/-2
//                          (40–100 ms and 100–180 ms after the island opens: the ink and the content
//                          mid-way in, the transport ahead of the word ahead of the buttons) and
//                          notch-island-closing-1/-2 (the same windows into the contraction). The
//                          content's fade and rise caught in flight; the glyphs must sit at their
//                          boxes' alpha in every frame
//   ORB_NOTCH_PHASES=list  with ORB_NOTCH and ORB_SHOT_DIR: after the script's hover (from 4.4 s),
//                          re-open the island and hold it, then step through these phases
//                          (comma list; default every awake one) ORB_NOTCH_PHASE_SECONDS apart
//                          (default 1.1), shooting notch-island-<phase>.png 0.85 s into each — the
//                          eyes, the dot and the words in every phase colour over the gradient.
//                          Pass ORB_FLY_AT=99 so the default fly does not drop the blob out first
//   ORB_PAUSE_AT=s         press Pause at that time (the capsule's / menu's): prints the command; the
//                          harness flips the fake phase to paused 0.1 s later, and back on a second press
//   ORB_STOP_AT=s          press the capsule's Stop at that time (OrbPanelController.stopPressed):
//                          the fake sender prints the stop command, the overlay is cleared, the
//                          "Stopped" toast is the pill; prints what the flight was and what it is
//                          0.05 s later; with ORB_SHOT_DIR shoots stop.png 0.45 s after
//   ORB_CLEAR_AT=s         send the overlay's `clear` (the brain's show_clear) at that time: a line
//                          being drawn comes down and the pen goes home quietly — no Stop, no pill;
//                          a plain fly (ORB_FLY) is left alone. Prints the flight before and after
//   ORB_SLEEP_AT=s         flip the fake phase to asleep at that time (what the engine sends after a
//                          Stop, a sleep, the idle timer): the one transition that tucks the blob in.
//                          Prints the flight / tucked / home / body at the flip, 0.1 s and 1.2 s after.
//                          Notch mode schedules one by default 2 s after its fly's hover ends
//   ORB_WAKE_AT=s          flip the fake phase to listening at that time (the wake): a blob left out in
//                          notch mode drifts back up and tucks in first. Same prints
//   ORB_SLEEP_PHASE=name   the dormant phase ORB_SLEEP_AT flips to (default asleep; `error` is the other
//                          one — a failed session — and counts as asleep for the way home: asleep → error
//                          moves nothing, awake → error tucks, error → listening at ORB_WAKE_AT is a wake)
//   ORB_DRAG_OUT_AT=s      notch mode: pull the face out of the notch into the hand at CG
//                          ORB_DRAG_OUT_TO (default 700,400) over 600 ms and let go — free until the
//                          next sleep (ORB_SLEEP_AT then tucks it in); prints the home mode and the pill.
//                          The tuck put off, then found again (the mode must read notch at the wake):
//                            ORB_NOTCH=1 ORB_DRAG_OUT_AT=2 ORB_EXPAND=1 ORB_EXPAND_AT=3.5 ORB_NO_DISMISS=1 ORB_SLEEP_AT=4 ORB_TOGGLE_AT=5.5 ORB_WAKE_AT=7 ORB_FLY_AT=99 ORB_EXIT_AFTER=9
//                              (capsule open through the sleep beat: closing it at 5.5 s drifts it up asleep)
//                            ORB_NOTCH=1 ORB_DRAG_OUT_AT=2 ORB_SLEEP_AT=4 ORB_DRAG="644,529->900,650@600" ORB_DRAG_AT=4.2 ORB_WAKE_AT=7 ORB_FLY_AT=99 ORB_EXIT_AFTER=9
//                              (a drag cancels the sleep beat: the wake at 7 s drifts it up)
//                            ORB_NOTCH=1 ORB_NOTCH_PHASE=asleep ORB_FLY_AT=2 ORB_SLEEP_AT=5.5 ORB_SLEEP_PHASE=error ORB_WAKE_AT=7 ORB_EXIT_AFTER=9.5
//                              (a fly while asleep leaves it out; asleep → error moves nothing; error → listening is the wake: it drifts up)
//   ORB_LEVELS=list        bad numbers on the levels path: the fake 30 Hz levels are replaced by these
//                          values (comma list; Swift's Double parses nan, inf, -inf, -1, 2 …), cycling,
//                          on `state.levels` exactly where EngineClient publishes — from ORB_LEVELS_AT s
//                          (default 0) for ORB_LEVELS_FOR s (default: the rest of the run). Prints the
//                          sim's raw/eased levels, the notch island's springs and its raw rect every
//                          0.5 s (a NaN reads "nan"), and once when the override turns on and off:
//                            ORB_NOTCH=1 ORB_NOTCH_NO_POINTER=1 ORB_FLY_AT=99 ORB_LEVELS=nan ORB_LEVELS_AT=1.6 ORB_LEVELS_FOR=0.5 ORB_SHOT_DIR=… ORB_EXIT_AFTER=5
//                              (half a second of NaN levels while peeking, then normal levels; the island
//                              is hovered at 2.7 s and shot at 3.4 s — it must look like the plain notch run)
//   ORB_FLEET="Name:lane:status[@x,y][:app]; …"   the fleet (BlobFleet): fake spawned threads on snapshot.threads at
//                          ORB_FLEET_AT s (default 1.2; 1.6 in notch mode) — name (≤ 16), lane voice|screen|background,
//                          status ("working" = acting; else the wire word), an acting point @x,y (Thread.at) and an app
//                          (Thread.app: parked by its front window; no lookup under ORB_NO_WINDOWS). One satellite each,
//                          flown to its point, else at a rank slot beside the main blob. Every fleet line is stamped.
//                          Once every satellite is parked (≥ 0.8 s after the last fleet command) the `fleet check:` lines
//                          print each landing, the pairwise centre distances (≥ 92 pt) and the distance to its target
//                          (≤ 3 body radii), and with ORB_SHOT_DIR shoot fleet-<ORB_FLEET_SHOT>.png (default "three";
//                          "avoid" / "reduce" name the other scenarios' shots). The check shot is taken in the plain
//                          scenario or when ORB_FLEET_SHOT names it — never by a notch, status, drag, click, hover,
//                          trace, late-thread or budget run (each has its own shots), so none overwrites fleet-three.png
//   ORB_FLEET_FLY="Name@x,y[@t]; …"   a tagged orb.fly {thread} on state.overlayCommands at t s (default
//                          ORB_FLEET_AT + 0.4 + 0.4·i); a ring marks each target. The fleet routes it to that satellite;
//                          0.1 s and 2.3 s after each the `fleet pending:` line counts the flies kept for threads not yet
//                          seen (a name not in ORB_FLEET: 1 then 0 — dropped after 2 s; one whose ORB_FLEET_LATE record
//                          arrives inside 2 s is taken at the spawn: "takes the fly kept for it", then its flight)
//   ORB_FLEET_TRACE="Name@x,y;x,y;…[@closed][@t]"   a tagged orb.trace {thread} at t s (default ORB_FLEET_AT + 0.6):
//                          that satellite flies beside the first point; the shape is stamped on the overlay as ONE
//                          untagged `.stroke` (closed: the first point again at the end — n + 1 points); the main blob
//                          must not move (its flight phase and centre are printed before and 1 s after)
//   ORB_FLEET_HOVER="Name@t"   the pointer entering that satellite's cell at t s (through the tracking area's own
//                          handler — the harness cannot move the real pointer) and leaving 0.3 s later: prints the name
//                          tag (OrbPill) on entry, that it is still up 0.6 s after leaving and gone 1.5 s after (tagShow
//                          1.2 s), and the cell's tracking-area count; shoots fleet-hover.png with the tag up
//   ORB_FLEET_LATE="t:Name:lane:status; …"   a thread whose record arrives at t s: prints the counts 0.3 s and 1.5 s
//                          after (a fourth live thread with three satellites showing — or one whose panel is still
//                          fading under a finished thread — is a notch dot only until a panel is free; `made` stays 3)
//   ORB_FLEET_STATUS="Name=status@t; …"   flip that thread's status at t s (done / failed / stopped set doneAt;
//                          waiting-kevin sets a question): prints the face and pill 0.5 s in and the counts (satellites,
//                          leaving, panel pool) at 0.5 / 1.5 / 2.2 s; shoots fleet-waiting / fleet-done / fleet-failed.png
//   ORB_FLEET_DRAG="Name->dock@t" | "Name->x,y@t"   a synthetic drag of that satellite from its centre into the notch's
//                          catch zone (NotchGeometry.catchZoneCG; needs ORB_NOTCH=1) or to a point, over 600 ms, through
//                          its own pointer path; prints the release and the send counts; shoots fleet-drag-stop.png
//   ORB_FLEET_CLICK="Name@t"   a posted click on that satellite (SatellitePanel.sendEvent → openThread(id) + openConsole())
//                          after printing its right-click menu's items
//   ORB_FLEET_BUDGET_LOG=1   the fleet's per-second frame-cost mean / p95 / max and the rung
//   ORB_FLEET_BUDGET_FORCE_MS=9   add that many ms to every fleet frame's measured cost from ORB_FLEET_AT + 1 s for
//                          ORB_FLEET_BUDGET_FOR s (default 4): the ladder steps, then recovers when the load ends; the
//                          `+N s after the load` lines carry the rung, the mean and the fleet's counts (held ≥ 5 s the
//                          ladder reaches rung 4: the third satellite stays, a fourth live thread is a dot only, and one
//                          gets in only once fewer than two remain)
//   ORB_NOTCH_STRIP_PROBE=t   notch mode, with ORB_NOTCH_WORKING=1 ORB_NOTCH_PHASE=acting and no fleet: at t s render
//                          the working strip alone at forced park / work levels and print the hairline's and the
//                          counter's brightness at park ½ and at work ½ as fractions of the full strip's — both must
//                          read 0.50 (work · (1 − park), the strip's alpha before the fleet; only the 0.24 s transitions
//                          differ, which no settled shot can see)
//   ORB_SELFTEST=1         run the pure checks and exit (0 pass, 1 fail): FleetBudget on a synthetic 24 fps clock (a
//                          step exactly at the 30th heavy frame and once per window, a window straddling the load's end
//                          does not step, recovery to rung 0 between 1.5 and 2.0 s of the load ending, `note` true only
//                          on a change) and BlobBody.landing(for:avoiding:) (an empty list is the plain choice; the
//                          chosen spot occupied → the next side ≥ 92 pt away, "occupied →" in the note; every side
//                          taken → the plain choice again, "(every side taken)")
//   At exit with a fleet: `fleet sends:` counts every thread.stop / sleep / set-settings the run sent, and the counts.
//
//   The dock as a control surface (notch mode; the fake AppState prints every command as `send: {…}` and the
//   fake engine answers the ones the dock can see — a mark lands after mark.add with its crop a beat later and
//   the orb.trace echo (reason "mark"; ORB_NOTCH_TRACE_ECHO=0 keeps it), leaves on mark.remove / mark.clear, the
//   front window lands on mark.window with its toast, a scripted Sleep box press puts the phase to sleep). Every
//   rule prints as `check: <the design's line> OK|FAIL`; at exit `notch sends:` counts by kind.
//   ORB_NOTCH_MARKS="pending:640x400@-40@Slack;used:320x180@-130;capturing:200x120@-2;window:1280x800@-5@Safari"
//                          snapshot.marks (kind:WxH@-age s[@App]; ids mark_<kind>): `used` → consumed, `capturing` → no
//                          screenshotPath yet (the skeleton), `window` → source "window" with a window element; pixel marks
//                          get a dithered 2× PNG written under the shot dir (state.stateDir points there)
//   ORB_NOTCH_MARK_LANDS_AT=t   a pending circle lands at t (as after a ⌥⇧C stroke): the lip chip, glow and the
//                          "◎ 1 circled · Go to ask" pill are read 0.25 s and 6.4 s after
//   ORB_NOTCH_QUESTION="Slack:Send it to #general?"   with ORB_FLEET: that thread waits on Kevin with the question
//   ORB_NOTCH_PROBLEM=permission.screenRecording[:text]   one typed Problem with the engine's remedy for the kind
//   ORB_NOTCH_SCREEN_RECORDING=0   permissions.all's Screen Recording row denied
//   ORB_NOTCH_METER="252,138,738"   the open session's elapsed s, its usageSeconds, usageToday s
//   ORB_NOTCH_REQUEST="opening the PR in Cursor"   the running delegation's request
//   ORB_NOTCH_TYPED_WAKES=1   settings.typedWakes
//   ORB_NOTCH_PRESS="what@t;…"   a press on that island control at t (the pointer approaches first): circle, window,
//                          ask, clear, allow, deny, mark:0, forget:0, thread:Slack, threadStop:Slack, console, sleep,
//                          remedy, field, face (a thread's name or id); each press prints what it sent and earns its check
//   ORB_NOTCH_ACTIVE=t|1   NSApp.activate at t (1 = 3.0 s): the Window check's "app active" half
//   ORB_NOTCH_TYPE="text@t"   ⌥⇧Return at t (OrbPanelController.sayLine), the words, Return; then again with Escape
//   ORB_NOTCH_ESC_AT=t     Escape: the field lets go (text kept), or mark mode is cancelled (a posted key event)
//   ORB_NOTCH_RETURN_AT=t  a bare Return to the panel with a question waiting
//   ORB_NOTCH_CIRCLE_AT=t  the ◎ box at t, then Kevin's stroke through the overlay at t + 0.4 (ORB_NOTCH_STROKE_AT=t
//                          is the stroke alone — after an Ask with nothing circled)
//   ORB_NOTCH_HOTKEY_CIRCLE_AT=t   ⌥⇧C's dispatch (state.beginMarkMode) with the island open
//   ORB_NOTCH_TRACE_AT="t[:reason];…"   an orb.trace while tucked (reason mark by default; "reflex circle" for the other rule)
//   ORB_NOTCH_PIN_AT=t     a .face press (pins the island)
//   ORB_NOTCH_KIND=plain|question|marks   the display's kind forced (NotchPanel.swift reads it): the zones and the hit
//                          list of that kind whatever the content, for the tooltip lines and the shots
//   ORB_NOTCH_KIND_AT="kind@t"   the forced kind changes at t with the island open: beats 1–4 are sampled for 0.5 s and
//                          must dip within `Motion.quick` then rise while beats 0 and 5 hold (the kind-change line)
//   ORB_NOTCH_RING="07:10 · Wake up, Kevin"   the fake engine fires an alarm at ORB_NOTCH_RING_AT (default 1.5 s): snapshot.ringing
//                          with Snooze 10 · Done, its row in snapshot.automations (weekdays 07:10); ORB_NOTCH_RING_CALM the calm
//                          second line, ORB_NOTCH_RING_LATE=ms the head's `N min late`. Snooze / Done presses are answered like the
//                          daemon would (the ring ends 50 ms later). ORB_NOTCH_RING_FOLD_AT=t a .face press folds the ring's pinned
//                          island (the pill under the lip is read 0.2 s later → notch-island-alarm-folded.png); ORB_NOTCH_WAKE_AT=t
//                          the phase goes listening (the peek chips); ORB_NOTCH_RING_CLEAR_AT=t the engine ends the ring itself
//   ORB_NOTCH_NEXT="timer:pasta:720"   snapshot.nextFire (kind:name:seconds from 0.5 s) and an armed timer row: the asleep foot's
//                          `next Timer m:ss · pasta`, the awake chip, the lip pill
//   ORB_NOTCH_QUESTION_AT=ring-end|t   the fleet's question lands when the ring ends (or at t) instead of with the fleet: the kind flip
//                          the consent boxes' 500 ms dead-time guards (a deny inside it sends nothing)
//   ORB_NOTCH_LINE_AT="text@t"   a transcript line lands at t with the island open: 0.3 s later exactly one animated hero
//                          swap (old = the hero before, new = the line) must have started at the landing — the hero-swap
//                          line; after ORB_NOTCH_KIND_AT's window it proves the swap is not latched off by a kind change
//   ORB_NOTCH_PILL_TEST=1  asleep: gate + toast + a landed mark + a problem, the slot read as each expires, then the island opened
//   ORB_NOTCH_PHASE_SWEEP=t   every phase 0.2 s apart: Mute in the hit list in a session's phases only, Stop always
//   ORB_NOTCH_OPEN_TIMING=1   the open spring from the pointer's approach: 0.5 by 60 ms, 0.9 by 130 ms, hit rects at 0 ms
//   ORB_NOTCH_HOVER=…      also circle|window|ask|clear|allow|deny|mark:0|forget:0|thread:Slack|threadStop:Slack|console|
//                          sleep|remedy|meter (drawn hovered by NotchPanel; the tooltip is printed at 3.3 s)
//   Shots (ORB_SHOT_DIR): a run with one scenario knob names its frames notch-{tucked,peek,island}-<marks|question|
//   meter|screenrec|asleep>.png (a problem: notch-peek-problem / notch-island-problem — the foot row), plus notch-peek-marking
//   (after the ◎ press), notch-mark-return (the blob home after outlining its circle), notch-island-say (the field
//   with words). ORB_NOTCH_SHOT_TAG names them instead.

@main
struct OrbPreviewMain {
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let delegate = OrbPreviewDelegate()
        app.delegate = delegate
        app.run()
    }
}

@MainActor
final class OrbPreviewDelegate: NSObject, NSApplicationDelegate {
    let state = AppState()
    var orb: OrbPanelController!
    var overlay: OverlayManager!
    var timers: [Timer] = []
    var phaseIndex = 0
    var phases: [Phase] = Phase.allCases
    var phaseStart = Date()
    var backdrop: NSWindow?
    var obstacleWindow: NSWindow?

    // Flights: the targets' ring windows and which fly shots are still owed.
    var targetWindows: [NSWindow] = []
    var flyTargets: [CGPoint] = []
    var flyShotsOwed: Set<String> = []
    var lastFlightPhase = "none"
    var flightPhaseSince = 0.0
    // Traces: the stroke sent, its label, which trace shots are still owed, the last
    // progress line, and the eye count over the drawing's frames (60×/s).
    var tracePoints: [CGPoint] = []
    var traceLabel: String?
    var traceShotsOwed: Set<String> = []
    var lastTraceLog = 0.0
    var traceWasDone = false
    var traceFrames = 0
    var traceEyelessFrames = 0
    /// Every publish on state.liveStrokes (the blob's and mark mode's), for the trace's publish rate.
    var strokePublishes = 0
    var strokeSubscription: AnyCancellable?
    var overlaySubscription: AnyCancellable?

    // ORB_FACE_LOG: the drawn face, printed as it changes.
    var faceLog = false
    var lastFace = ""
    var lastFaceAt = 0.0

    // Notch mode: which notch shots are still owed, and when the blob last dropped out.
    var notchMode = false
    /// When the fake phase falls asleep (ORB_SLEEP_AT; notch mode's script sets one after its fly).
    var sleepAt: Double?
    /// The dormant phase it falls to (ORB_SLEEP_PHASE: asleep, or error).
    var sleepPhase = Phase.asleep
    var notchShotsOwed: Set<String> = []
    /// ORB_NOTCH_SHOT_TAG: "-<tag>" appended to every notch shot's name ("" without).
    var notchShotTag = ""
    var wasTucked = false
    var droppedOutAt = 0.0
    var lastNotchMode = ""
    /// When the notch's mode last became / stopped being "island" (ORB_NOTCH_OPENING_SHOTS).
    var notchIslandOpenedAt = -1.0
    var notchIslandClosedAt = -1.0

    // ORB_LEVELS: the fake levels replaced by these values (nan, inf, -1, 2 …), cycling,
    // from ORB_LEVELS_AT for ORB_LEVELS_FOR seconds; the readout every 0.5 s.
    var levelsOverride: [Double] = []
    var levelsOverrideAt = 0.0
    var levelsOverrideFor: Double?
    var levelsOverrideIndex = 0
    var levelsOverrideActive = false
    var lastLevelsLog = 0.0

    // The fleet (ORB_FLEET): the fake thread records, where each thread's hands act, the
    // owed shot, and every command the run sent, by kind.
    var fleet: BlobFleet!
    var fleetOn = false
    var fleetAt = 1.2
    var fleetThreads: [WorkThread] = []
    /// Thread id → the point its hands act at (a tagged fly, or the record's `at`).
    var fleetTargets: [String: CGPoint] = [:]
    var fleetRings: [CGPoint] = []
    var fleetShotName = "three"
    var fleetShotOwed = false
    var fleetLastCommandAt = 0.0
    /// The last fleet command the script has scheduled (s after launch): the check waits for it too.
    var fleetCommandsUntil = 0.0
    var fleetChecked = false
    var fleetSends = (stop: 0, sleep: 0, settings: 0, other: 0)

    // The dock as a control surface (ORB_NOTCH_*): the fake engine's marks, every send by kind, the scripted checks.
    var notchSends = NotchSends()
    var notchChecksFailed = 0
    var fakeMarks: [ScreenMark] = []
    var fakeMarkCount = 0
    var fakeMarkIds: Set<String> = []
    var markPNGDir: URL?
    var notchEchoTrace = true
    var notchEngineSleeps = false
    var beginMarkModeCalls = 0
    var foldAtBeginMark: (pinned: Bool, mode: String, ignoresMouse: Bool)?
    var openThreadCalls = 0
    var openConsoleCalls = 0
    var lastSayText = ""
    var lastMarkRemoveId = ""
    var lastThreadAnswerYes: Bool?
    var lastSleepCause = ""
    var lastRequestPermission = ""
    // The ring (design11): what the fake engine rang and when the kind last flipped because of it.
    var ringKindChangeAt = -1.0
    var lastSnooze: (id: String, minutes: Int)?
    var lastDone = ""
    var lastPressAt = -1.0
    var lastPressDead = false
    var ringEarly: (mode: String, pinned: Bool, tucked: Bool)?
    var ringPillFolded: (kind: String, text: String, mode: String)?
    var timerPillEarly: (kind: String, text: String)?
    var pendingQuestion: (id: String, text: String)?
    var pendingQuestionAtRingEnd = false
    /// ORB_NOTCH_QUESTION_AT: the first Allow / Deny press after the question landed is the dead-time's — checked whichever way it went.
    var deadTimePressWanted = false
    var windowInactiveResult: [String]?
    var windowActiveResult: (sent: [String], pill: String)?
    var allowResult: (sent: [String], yes: Bool?)?
    var denyResult: (sent: [String], yes: Bool?)?
    var sleepAwakeResult: [String]?
    var sleepAsleepResult: (sent: [String], dim: CGFloat)?
    var remedyResult: (sent: [String], which: String)?
    var screenRecordingSeen: (circleDim: Bool, windowDim: Bool, chipGlyph: Bool, pillRequest: Bool, circleDimValue: String, windowDimValue: String,
                              tooltip: String, chip: String, pill: String, pillKind: String, remedyLabel: String)?
    var screenRecordingChip: (ok: Bool, note: String)?
    var askWaitsForStroke: (beginMarkMode: Int, sent: Int, total: Int)?
    var askStrokeChecked = false
    var pinnedBeforeCircle: Bool?
    var lipAtLanding: (glow: String, chip: String, pill: String, kind: String) = ("", "", "", "")
    var peekChips: [String] = []
    /// The peek at 2.55 s: its width target, the chips' width, the dots' width (the counter is what remains).
    var peekBefore: (target: CGFloat, chips: CGFloat, dots: CGFloat) = (0, 0, 0)
    var meterPeekChip = ""
    var notchScenarioSuffix = ""
    var notchOpenTiming = false
    var notchOpenHoverAt = -1.0
    var notchOpenHalfAt = -1.0
    var notchOpenNineAt = -1.0
    var notchOpenHitAt0 = 0
    var notchMaxIslandHeight = 0.0
    var reduceSamples: [(alpha: [CGFloat], dy: [CGFloat])] = []
    /// ORB_NOTCH_KIND_AT: when the forced kind changed and the six beats' alphas sampled since (from `watch`).
    var kindSwapAt = -1.0
    var kindSwapSamples: [(t: Double, alpha: [CGFloat])] = []
    var kindSwapJudged = false
    /// The Say box's placeholder per phase from the sweep: the words and their width.
    var placeholderWidths: [(phase: String, words: String, width: CGFloat)] = []
    var traceProbe: TraceProbe?
    var traceMarkResult: (ok: Bool, note: String)?
    var traceOtherResult: (ok: Bool, note: String)?
    var markTraceSentAt = -1.0
    var markTraceTuckedBefore = false
    var markTraceOut = false
    var markTraceHomeSeen = false
    /// The session a scripted Pause closed, for the resume (ORB_PAUSE_AT plays the engine).
    var pausedSession: SessionInfo?
    /// The clock ORB_PAUSE_AT counts from (CACurrentMediaTime at its scheduling, late in launch): the meter's paused
    /// reading is anchored here, not to `launchedAt`, so however long launch took it lands 0.3 s after the phase does.
    var pauseScriptAt = -1.0
    /// Untagged `.stroke`s seen on state.overlayCommands (a tagged trace is re-stamped as exactly one), and the last one's point count.
    var strokesSeen = 0
    var lastStrokePoints = 0

    var shotDir: String?
    var shotPrefix = "preview-blob-"
    var shotPress = 0.3
    var squishShots = 0
    var lastShotAt = 0.0
    var phaseShotTaken = false
    /// Phase shots are for the collapsed blob's halo; a run that expands the capsule (ORB_EXPAND)
    /// or fires the overlay (ORB_OVERLAY) would overwrite them with the wrong picture, so it takes none.
    var phaseShots = true
    var restShotTaken = false
    var wasMoving = false
    var lastLog = 0.0
    /// Seconds since launch, prefixed to the flight log lines so hovers and settles can be timed.
    let launchedAt = CACurrentMediaTime()
    var stamp: String { String(format: "%6.2f s", CACurrentMediaTime() - launchedAt) }

    // The wake gate cycle.
    var gates: [String] = []
    var gateIndex = 0
    var gateStart = Date()
    var gateShotTaken = false
    var gateMethod = "Touch ID or passphrase"
    var heardIndex = 0
    static let heardWords = ["hey", "hey so", "so what", "what time", "time is it", "is it jarhead", "hmm", "okay"]

    // The synthetic hand (ORB_DRAG / ORB_STICK): where it is, for the in-process shots.
    var hand: CGPoint?
    var dragShotTaken = false
    /// ORB_STICK: "" → "flung" → "stuck" → "peeling" → "peeled".
    var stickPhase = ""
    var stickWall: (dx: Double, dy: Double, distance: Double)?
    var stickShotTaken = false
    var peelShotTaken = false
    var stickPull = 70.0
    var stickNeckShot = 0.5
    var lastStickLog = 0.0
    var peeledAt = 0.0

    func applicationDidFinishLaunching(_ notification: Notification) {
        let env = ProcessInfo.processInfo.environment
        if env["ORB_SELFTEST"] == "1" {
            let ok = Self.runSelfTest()
            print(ok ? "selftest: PASS" : "selftest: FAIL")
            fflush(stdout)
            exit(ok ? 0 : 1)
        }
        // The dither tiles first, so a shot a few seconds in never catches the fade fallback.
        Dither.prewarm(scale: NSScreen.main?.backingScaleFactor ?? 2)
        let x = Double(env["ORB_X"] ?? "") ?? 200
        let y = Double(env["ORB_Y"] ?? "") ?? 200
        notchMode = env["ORB_NOTCH"] == "1"
        notchShotTag = env["ORB_NOTCH_SHOT_TAG"].map { "-\($0)" } ?? ""
        if notchMode {
            NotchGeometry.simulate = true
            if env["ORB_PHASES"] == nil { phases = [.asleep] }
        }
        sleepAt = Double(env["ORB_SLEEP_AT"] ?? "")
        sleepPhase = Phase(rawValue: env["ORB_SLEEP_PHASE"] ?? "") ?? .asleep
        let perPhase = Double(env["ORB_PHASE_SECONDS"] ?? "") ?? (notchMode ? 60 : 2.5)
        if let list = env["ORB_PHASES"] {
            let parsed = list.split(separator: ",").compactMap { Phase(rawValue: String($0).trimmingCharacters(in: .whitespaces)) }
            if !parsed.isEmpty { phases = parsed }
        }
        shotDir = env["ORB_SHOT_DIR"]
        shotPrefix = env["ORB_SHOT_PREFIX"] ?? "preview-blob-"
        shotPress = Double(env["ORB_SHOT_PRESS"] ?? "") ?? 0.3
        phaseShots = env["ORB_EXPAND"] != "1" && env["ORB_OVERLAY"] != "1"
        if shotDir != nil, !phaseShots { print("phase shots off (ORB_EXPAND / ORB_OVERLAY run): run the phases command on its own for preview-blob-phase-*.png") }
        if let spec = env["ORB_LEVELS"] {
            levelsOverride = spec.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
            levelsOverrideAt = Double(env["ORB_LEVELS_AT"] ?? "") ?? 0
            levelsOverrideFor = Double(env["ORB_LEVELS_FOR"] ?? "")
            print("ORB_LEVELS:", levelsOverride.map { "\($0)" }.joined(separator: ","), "from \(levelsOverrideAt) s,", levelsOverrideFor.map { "for \($0) s" } ?? "for the run")
        }
        switch env["ORB_APPEARANCE"] {
        case "light": NSApp.appearance = NSAppearance(named: .aqua)
        case "dark": NSApp.appearance = NSAppearance(named: .darkAqua)
        default: break
        }

        for (i, s) in NSScreen.screens.enumerated() {
            print("screen \(i): frame \(s.frame) visible \(s.visibleFrame) scale \(s.backingScaleFactor)")
        }

        state.sendHandler = { cmd in
            if let data = try? JSONSerialization.data(withJSONObject: cmd.json), let s = String(data: data, encoding: .utf8) {
                print(self.stamp, "send:", s)
            }
            // The fleet's safety count: a satellite's drop is one thread.stop, never a sleep, never a settings write.
            switch cmd.json["type"] as? String {
            case "thread.stop": self.fleetSends.stop += 1
            case "sleep": self.fleetSends.sleep += 1
            case "set-settings": self.fleetSends.settings += 1
            default: self.fleetSends.other += 1
            }
            // The notch's count by kind, the last words of the commands its checks read, and the fake engine's reply.
            self.notchSends.note(cmd.json)
            switch cmd {
            case .sayText(let text): self.lastSayText = text
            case .markRemove(let id): self.lastMarkRemoveId = id
            case .threadAnswer(_, let yes): self.lastThreadAnswerYes = yes
            case .sleepCause(let cause): self.lastSleepCause = cause
            case .sleep: self.lastSleepCause = ""
            case .requestPermission(let which): self.lastRequestPermission = which
            case .automationSnooze(let id, let minutes):
                self.lastSnooze = (id, minutes)
                DispatchQueue.main.async { [weak self] in self?.engineEndsRing(id: id, state: "snoozed", why: "snooze \(minutes) min") }
            case .automationDone(let id):
                self.lastDone = id
                DispatchQueue.main.async { [weak self] in self?.engineEndsRing(id: id, state: "done", why: "done") }
            default: break
            }
            self.fakeEngine(cmd.json)
        }
        state.openConsoleHandler = { [weak self] in
            self?.openConsoleCalls += 1
            print("openConsole()")
        }
        // The fleet's trace proof: a tagged orb.trace becomes exactly one untagged `.stroke` here.
        overlaySubscription = state.overlayCommands
            .receive(on: DispatchQueue.main)
            .sink { [weak self] cmd in
                guard let self, case .stroke(let points, _, _, _) = cmd else { return }
                self.strokesSeen += 1
                self.lastStrokePoints = points.count
            }
        state.connected = true
        state.daemonDetail = "preview"
        // The gate's actions print instead of authenticating.
        var actions = WakeActions()
        actions.submitPassphrase = { phrase in print("submitPassphrase(\(phrase.count) chars)"); fflush(stdout) }
        actions.cancelAuth = { print("cancelAuth()"); fflush(stdout) }
        state.wakeActions = actions

        if let list = env["ORB_GATE"] {
            let all = ["listening", "heard", "authenticating", "granted", "denied", "locked"]
            let parsed = list.split(separator: ",").map { String($0).trimmingCharacters(in: .whitespaces) }.filter { all.contains($0) }
            gates = parsed.isEmpty ? all : parsed
            gateMethod = env["ORB_GATE_METHOD"] ?? gateMethod
            // The gate only shows on an asleep blob.
            if env["ORB_PHASES"] == nil { phases = [.asleep] }
            state.wakePassphraseSet = env["ORB_PASSPHRASE_SET"] != "0"
        }

        var snap = Snapshot.empty
        snap.phase = phases[0]
        snap.settings.orbPosition = OrbPosition(x: x, y: y)
        // This Mac has a notch: every scenario but ORB_NOTCH is a free-mode scenario.
        snap.settings.orbHome = notchMode ? "notch" : "free"
        let now = Date().timeIntervalSince1970 * 1000
        snap.session = SessionInfo(id: "sess_preview", startedAt: now - 754_000, expiresAt: now + 3_600_000, usageSeconds: 431, contextRatio: 0.2)
        snap.transcript = [
            TranscriptItem(id: "t1", speaker: .kevin, text: "hey jarhead, what app is open right now and where is the deploy button?", startMs: 0, endMs: 2400, at: now - 9000, final: true),
            TranscriptItem(id: "t2", speaker: .jarhead, text: "on it. Cursor is frontmost; the deploy button is top-right of the Vercel tab.", startMs: 2600, endMs: 5100, at: now - 6000, final: true),
        ]
        snap.delegations = [
            Delegation(id: "d1", liveId: "live_1", createdAt: now - 5000, offsetMs: 2600, request: "find the deploy button", status: .running,
                       steps: [DelegationStep(id: "s1", at: now - 4000, kind: .tool, text: nil,
                                              tool: ToolStep(name: "screenshot", input: .object(["display": .number(1)]), output: nil, ok: true, ms: 62), screenshotPath: nil),
                               DelegationStep(id: "s2", at: now - 2000, kind: .thinking, text: "Scanning the toolbar for a primary action…", tool: nil, screenshotPath: nil)],
                       summary: nil, timings: DelegationTimings(delegatedAt: now - 5000, firstThinkingAt: now - 4200, firstCommentaryAt: nil, doneAt: nil)),
        ]
        if !gates.isEmpty {
            // Asleep: the last exchange is still there, nothing is running or billed.
            snap.delegations = []
            snap.session = nil
        }
        if notchMode { applyNotchSnapshotKnobs(&snap, env: env) }
        state.snapshot = snap

        let mainMaxY = NSScreen.screens.first?.frame.maxY ?? 0
        let size = OrbPanelController.collapsedSize
        if let spec = env["ORB_BACKDROP"] {
            let rect: NSRect
            if spec == "full", let main = NSScreen.screens.first {
                rect = main.visibleFrame
            } else {
                let parts = spec.split(separator: "x").compactMap { Double($0) }
                let w = parts.first ?? 200, h = parts.count > 1 ? parts[1] : 200
                // Centre the backdrop on the orb.
                rect = NSRect(x: x + size.width / 2 - w / 2, y: mainMaxY - (y + size.height / 2) - h / 2, width: w, height: h)
            }
            // Same level as the orb, ordered before it, so it sits right underneath.
            let bd = NSWindow(contentRect: rect, styleMask: [.borderless], backing: .buffered, defer: false)
            bd.level = .floating
            bd.backgroundColor = env["ORB_BACKDROP_LIGHT"] == "1" ? NSColor(white: 0.93, alpha: 1) : NSColor(srgbRed: 0x0b / 255, green: 0x0c / 255, blue: 0x10 / 255, alpha: 1)
            bd.ignoresMouseEvents = true
            bd.hasShadow = false
            bd.isReleasedWhenClosed = false
            bd.orderFrontRegardless()
            backdrop = bd
        }

        var obstacleRect: CGRect?
        if let spec = env["ORB_OBSTACLE"] {
            let p = spec.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
            if p.count == 4 {
                let cg = CGRect(x: p[0], y: p[1], width: p[2], height: p[3])
                let ak = NSRect(x: cg.minX, y: mainMaxY - cg.maxY, width: cg.width, height: cg.height)
                let w = NSWindow(contentRect: ak, styleMask: [.borderless], backing: .buffered, defer: false)
                w.level = .floating
                w.backgroundColor = NSColor(white: 0.32, alpha: 1)
                w.ignoresMouseEvents = true
                w.hasShadow = false
                w.isReleasedWhenClosed = false
                w.orderFrontRegardless()
                obstacleWindow = w
                obstacleRect = cg
            }
        }

        orb = OrbPanelController(state: state)
        orb.previewTimeline = env["ORB_TIMELINE"] == "1"
        faceLog = env["ORB_FACE_LOG"] == "1"
        lastFaceAt = CACurrentMediaTime()
        // The fleet, as the app builds it: its lines are stamped and printed here; a
        // satellite's click prints what the app would do (open that thread in the Console).
        fleet = BlobFleet(state: state, orb: orb)
        fleet.log = { [weak self] line in
            guard let self else { return }
            print(self.stamp, line)
            fflush(stdout)
        }
        fleet.onOpenThread = { [weak self] id in
            print(self?.stamp ?? "", "openThread(\(id))")
            print("openConsole()")
            fflush(stdout)
        }
        if let spec = env["ORB_FLEET"] { setUpFleet(spec: spec, env: env) }
        overlay = OverlayManager(state: state)
        overlay.start()
        orb.show()
        if env["ORB_HIDE"] == "1" { orb.hide(); overlay.stop() }
        print("orb visible:", orb.isVisible, "at CG", x, y, "backdrop:", backdrop?.frame ?? .zero)
        if notchMode {
            print(String(format: "notch: home %@, tucked %d, mode %@, panel CG %@, island CG %@, dock CG %@", orb.previewHomeMode, orb.previewIsTucked ? 1 : 0,
                         orb.previewNotchMode, orb.previewNotchPanelCG.map { "\($0)" } ?? "nil", orb.previewNotchIslandCG.map { "\($0)" } ?? "nil",
                         orb.previewNotchDockCG.map { "\(Int($0.x)),\(Int($0.y))" } ?? "nil"))
            wasTucked = orb.previewIsTucked
            if shotDir != nil {
                notchShotsOwed = ["tucked", "peek", "island", "drop", "tuck-staging", "tuck-slip-mid", "tuck-slip-late", "drop-early"]
                // The control surface's own frames, taken by the scripts that earn them.
                notchShotsOwed.formUnion(["peek-marking", "mark-return", "island-say"])
                if env["ORB_NOTCH_TYPE"] != nil { notchShotsOwed.remove("island") }
            }
            setUpNotchSurface(env: env)
            // ORB_NOTCH_OPENING_SHOTS: the island mid-way through opening and closing, for
            // judging the content's fade and rise (the glyphs must fade with their boxes).
            // Shot from `watch()` off the mode flip itself (the script's clock drifts).
            if shotDir != nil, env["ORB_NOTCH_OPENING_SHOTS"] == "1" {
                notchShotsOwed.formUnion(["island-opening-1", "island-opening-2", "island-closing-1", "island-closing-2"])
            }
            // The script: tucked, then awake (peeking), then the island under the pointer, then a fly.
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
                guard let self else { return }
                self.notchShot("tucked", note: "asleep, tucked, mode \(self.orb.previewNotchMode)")
            }
            let awakePhase = Phase(rawValue: env["ORB_NOTCH_PHASE"] ?? "") ?? .listening
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.3) { [weak self] in
                guard let self else { return }
                self.state.snapshot.phase = awakePhase
                self.phaseStart = Date()
                print(self.stamp, "notch: phase -> \(awakePhase.rawValue) (mode \(self.orb.previewNotchMode))")
                fflush(stdout)
            }
            // ORB_NOTCH_PHASES: the island held open, one phase colour after another.
            if shotDir != nil, let spec = env["ORB_NOTCH_PHASES"] {
                let all: [Phase] = [.listening, .speaking, .thinking, .acting, .connecting, .muted, .error, .paused]
                let list = spec.isEmpty || spec == "1" ? all : spec.split(separator: ",").compactMap { Phase(rawValue: String($0).trimmingCharacters(in: .whitespaces)) }
                let per = Double(env["ORB_NOTCH_PHASE_SECONDS"] ?? "") ?? 1.1
                let start = 4.4
                DispatchQueue.main.asyncAfter(deadline: .now() + start) { [weak self] in
                    guard let self else { return }
                    self.orb.previewNotchHover(true)
                    print(self.stamp, "notch: phases — island held open, mode \(self.orb.previewNotchMode)")
                    fflush(stdout)
                }
                for (i, phase) in list.enumerated() {
                    let at = start + 0.1 + Double(i) * per
                    DispatchQueue.main.asyncAfter(deadline: .now() + at) { [weak self] in
                        guard let self else { return }
                        self.state.snapshot.phase = phase
                        self.phaseStart = Date()
                        self.notchShotsOwed.insert("island-\(phase.rawValue)")
                        print(self.stamp, "notch: phase -> \(phase.rawValue)")
                        fflush(stdout)
                    }
                    DispatchQueue.main.asyncAfter(deadline: .now() + at + per * 0.77) { [weak self] in
                        guard let self else { return }
                        self.notchShot("island-\(phase.rawValue)", note: "\(phase.rawValue), island held open, mode \(self.orb.previewNotchMode)")
                    }
                }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
                guard let self else { return }
                self.notchShot("peek", note: "listening, peeking, mode \(self.orb.previewNotchMode)")
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.7) { [weak self] in
                guard let self else { return }
                self.orb.previewNotchHover(true)
                print(self.stamp, "notch: pointer approaches -> mode \(self.orb.previewNotchMode)")
                fflush(stdout)
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 3.4) { [weak self] in
                guard let self else { return }
                self.notchShot("island", note: "hovered, island, mode \(self.orb.previewNotchMode)")
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 3.7) { [weak self] in
                guard let self else { return }
                self.orb.previewNotchHover(false)
                print(self.stamp, "notch: pointer leaves -> contracts after 600 ms")
                fflush(stdout)
            }
        }
        if let cg = obstacleRect {
            orb.previewSetObstacles([cg])
            print("obstacle at CG", cg)
        }
        fflush(stdout)

        // Gate cycling (fake AppState values; the real gate is not built into this harness).
        if !gates.isEmpty {
            let perGate = Double(env["ORB_GATE_SECONDS"] ?? "") ?? 2.5
            applyGate(gates[0])
            timers.append(Timer.scheduledTimer(withTimeInterval: perGate, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.gateIndex = (self.gateIndex + 1) % self.gates.count
                    self.applyGate(self.gates[self.gateIndex])
                }
            })
            // While listening the recogniser hears things: the calibration ripple.
            timers.append(Timer.scheduledTimer(withTimeInterval: 0.8, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self, self.state.wakeGate.isListening else { return }
                    self.heardIndex = (self.heardIndex + 1) % Self.heardWords.count
                    self.state.wakeHeard = Self.heardWords[self.heardIndex]
                }
            })
        }

        // Phase cycling.
        phaseStart = Date()
        timers.append(Timer.scheduledTimer(withTimeInterval: perPhase, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.phaseIndex = (self.phaseIndex + 1) % self.phases.count
                self.state.snapshot.phase = self.phases[self.phaseIndex]
                self.phaseStart = Date()
                self.phaseShotTaken = false
                print("phase:", self.state.snapshot.phase.rawValue)
                if self.phaseIndex == 2 { self.state.toast("preview toast", tone: .info) }
            }
        })

        // Fake levels at 30 Hz.
        timers.append(Timer.scheduledTimer(withTimeInterval: 1 / 30, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                let t = Date().timeIntervalSince(self.phaseStart)
                var levels = AudioLevels.silent
                switch self.state.snapshot.phase {
                case .listening:
                    levels.input = max(0, 0.5 + 0.5 * sin(t * 5.1) * sin(t * 1.7)) * (t.truncatingRemainder(dividingBy: 2) < 1.3 ? 1 : 0.1)
                case .speaking:
                    levels.output = max(0, 0.55 + 0.45 * sin(t * 9.3) * cos(t * 2.3))
                default:
                    break
                }
                // ORB_LEVELS: the bad numbers, on the same path the daemon's levels take.
                if !self.levelsOverride.isEmpty {
                    let since = CACurrentMediaTime() - self.launchedAt
                    let on = since >= self.levelsOverrideAt && (self.levelsOverrideFor.map { since < self.levelsOverrideAt + $0 } ?? true)
                    if on != self.levelsOverrideActive {
                        self.levelsOverrideActive = on
                        print(self.stamp, on ? "levels: override ON" : "levels: override OFF (fake levels resume)", "| sim", self.orb.previewSimLevels, "| springs", self.orb.previewNotchSprings)
                        fflush(stdout)
                    }
                    if on {
                        let v = self.levelsOverride[self.levelsOverrideIndex % self.levelsOverride.count]
                        self.levelsOverrideIndex += 1
                        levels = AudioLevels(input: v, output: v)
                    }
                }
                self.state.levels = levels
            }
        })

        // Watch the body: log its travels, and take the squish / phase / rest shots.
        timers.append(Timer.scheduledTimer(withTimeInterval: 1 / 60, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.watch() }
        })
        strokeSubscription = state.liveStrokes.sink { [weak self] _ in
            MainActor.assumeIsolated { self?.strokePublishes += 1 }
        }

        if let spec = env["ORB_FLING"] {
            let p = spec.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
            let at = Double(env["ORB_FLING_AT"] ?? "") ?? 1.2
            if p.count == 2 {
                DispatchQueue.main.asyncAfter(deadline: .now() + at) { [weak self] in
                    guard let self else { return }
                    self.orb.previewFling(vx: p[0], vy: p[1])
                    self.restShotTaken = false
                    print(self.stamp, "fling:", p[0], p[1], "from CG", self.orb.previewFrameCG.origin)
                    fflush(stdout)
                }
            }
        }
        if env["ORB_EXPAND"] == "1" {
            let expandAt = Double(env["ORB_EXPAND_AT"] ?? "") ?? 1
            DispatchQueue.main.asyncAfter(deadline: .now() + expandAt) { [weak self] in
                guard let self else { return }
                self.orb.toggleExpanded()
                print("expanded (flight was \(self.lastFlightPhase); stays where it is on collapse: \(self.orb.previewStayAfterCollapse))")
                fflush(stdout)
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + expandAt + 1.2) { [weak self] in
                // With a gate cycle the gate-<name>-expanded shot covers it.
                guard let self, let dir = self.shotDir, self.gates.isEmpty else { return }
                self.shoot("\(dir)/\(self.shotPrefix)expanded.png", note: "expanded")
            }
        }
        if let at = Double(env["ORB_TOGGLE_AT"] ?? "") {
            DispatchQueue.main.asyncAfter(deadline: .now() + at) { [weak self] in
                guard let self else { return }
                self.orb.toggleExpanded()
                print("toggled -> expanded: \(self.orb.previewIsExpanded), flight: \(self.orb.previewFlightPhase), perch: \(self.orb.previewPerchCG.map { "\(Int($0.x)),\(Int($0.y))" } ?? "nil")")
                fflush(stdout)
            }
        }
        if let at = Double(env["ORB_HIDE_AT"] ?? "") {
            DispatchQueue.main.asyncAfter(deadline: .now() + at) { [weak self] in
                guard let self else { return }
                let before = self.orb.previewFlightPhase
                self.orb.hide()
                let f = self.orb.previewFrameCG
                print(String(format: "hide (flight was %@) -> visible %d, flight %@, body CG %.0f,%.0f", before, self.orb.isVisible ? 1 : 0, self.orb.previewFlightPhase, f.midX, f.midY))
                fflush(stdout)
            }
        }
        if let at = Double(env["ORB_SHOW_AT"] ?? "") {
            DispatchQueue.main.asyncAfter(deadline: .now() + at) { [weak self] in
                guard let self else { return }
                self.orb.show()
                let f = self.orb.previewFrameCG
                print(String(format: "show -> visible %d, flight %@, moving %d, body CG %.0f,%.0f, perch %@", self.orb.isVisible ? 1 : 0, self.orb.previewFlightPhase,
                             self.orb.previewIsMoving ? 1 : 0, f.midX, f.midY, self.orb.previewPerchCG.map { "\(Int($0.x)),\(Int($0.y))" } ?? "nil"))
                fflush(stdout)
            }
        }
        if env["ORB_CLICK_TEST"] == "1" {
            // Kept inside one second: any real click elsewhere on the Mac collapses the
            // capsule through the click-outside monitor, which is correct but would
            // read as a failed test. Clicks are posted, so each step reports the one before.
            func clickBlob(_ label: String) {
                let cell = orb.previewBlobCellFrame
                print("\(label) (expanded before: \(orb.previewIsExpanded))")
                orb.previewClick(windowPoint: NSPoint(x: cell.midX, y: cell.midY))
                fflush(stdout)
            }
            // The action row: 30×28 buttons, 6 apart, 10 in from the capsule's edges and bottom.
            func clickButton(_ label: String, x: (NSRect) -> CGFloat) {
                guard orb.previewIsExpanded else { print("\(label): capsule not expanded, skipped"); return }
                let cap = orb.previewCapsuleFrame
                print("click \(label)")
                orb.previewClick(windowPoint: NSPoint(x: x(cap), y: cap.minY + 10 + 14))
                fflush(stdout)
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { clickBlob("click blob") }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.8) { clickButton("Console (right button)") { $0.maxX - 10 - 15 } }
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.1) { clickButton("Stop (3rd button)") { $0.minX + 10 + 72 + 15 } }
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.4) { clickBlob("click blob again") }
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.7) { [weak self] in
                guard let self else { return }
                print("click test done -> expanded:", self.orb.previewIsExpanded)
                fflush(stdout)
            }
        }
        if env["ORB_KEY_TEST"] == "1" {
            // The panel must stay non-key through a button click and become key only for
            // a click into the passphrase field; Return submits and hands key back. Clicks
            // and keys are posted, so each step reports the one before it.
            func report(_ label: String) {
                print("key test: \(label) -> key:", orb.previewIsKey, "firstResponder:", orb.previewFirstResponder)
                fflush(stdout)
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.6) { [weak self] in
                guard let self else { return }
                guard self.orb.previewIsExpanded else { print("key test: capsule not expanded (set ORB_EXPAND=1), skipped"); return }
                guard let field = self.orb.previewPassphraseFieldFrame else { print("key test: no passphrase field showing"); return }
                if env["ORB_KEY_PROBE"] == "1" { self.orb.previewProbeKey() }
                self.orb.previewDumpCapsuleViews()
                report("before")
                // Cancel sits at the right edge of the gate row, one row above the field:
                // 53 wide, 10 in from the capsule's edge. First its left third (dead when the
                // label starved it to 18pt), then its centre.
                let cap = self.orb.previewCapsuleFrame
                print("key test: click Cancel at right-44 (left third)")
                self.orb.previewClick(windowPoint: NSPoint(x: cap.maxX - 10 - 44, y: field.midY + OrbTheme.rowHeight))
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.75) { [weak self] in
                guard let self, let field = self.orb.previewPassphraseFieldFrame else { return }
                let cap = self.orb.previewCapsuleFrame
                print("key test: click Cancel at right-26 (centre)")
                self.orb.previewClick(windowPoint: NSPoint(x: cap.maxX - 10 - 26, y: field.midY + OrbTheme.rowHeight))
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.9) { [weak self] in
                guard let self else { return }
                report("after Cancel clicks")
                guard let field = self.orb.previewPassphraseFieldFrame else { return }
                print("key test: clicking field at", field)
                self.orb.previewClick(windowPoint: NSPoint(x: field.midX, y: field.midY))
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 3.2) { [weak self] in
                guard let self else { return }
                report("after field click")
                for ch in "open sesame" { self.orb.previewKey(String(ch)) }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 3.5) { [weak self] in
                guard let self else { return }
                report("after typing")
                if let dir = self.shotDir { self.shoot("\(dir)/\(self.shotPrefix)gate-typing.png", note: "field focused") }
                self.orb.previewKey("\r", keyCode: 36)
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 3.9) { [weak self] in
                guard let self else { return }
                report("after Return")
                print("key test: orb visible:", self.orb.isVisible, "expanded:", self.orb.previewIsExpanded)
                fflush(stdout)
            }
        }
        if env["ORB_SUMMON"] == "1" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                guard let self else { return }
                self.orb.summon()
                self.restShotTaken = false
                let m = NSEvent.mouseLocation
                print("summoned toward mouse CG:", Int(m.x), Int(mainMaxY - m.y))
                fflush(stdout)
            }
        }
        if env["ORB_REDUCE_MOTION"] == "1" { orb.previewSetReducedMotion(true) }
        if let spec = env["ORB_DRAG"] {
            let at = Double(env["ORB_DRAG_AT"] ?? "") ?? 1.0
            let shotStretch = Double(env["ORB_DRAG_SHOT_STRETCH"] ?? "") ?? 0.3
            var ms = 700.0
            var path = spec
            if let atSign = spec.lastIndex(of: "@") {
                ms = Double(spec[spec.index(after: atSign)...]) ?? ms
                path = String(spec[..<atSign])
            }
            let ends = path.components(separatedBy: "->").map { $0.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) } }
            if ends.count == 2, ends[0].count == 2, ends[1].count == 2 {
                let from = CGPoint(x: ends[0][0], y: ends[0][1]), to = CGPoint(x: ends[1][0], y: ends[1][1])
                DispatchQueue.main.asyncAfter(deadline: .now() + at) { [weak self] in
                    guard let self else { return }
                    self.runDrag(from: from, to: to, ms: ms, shotStretch: shotStretch, shotName: "drag", label: "drag")
                }
            } else {
                print("ORB_DRAG: could not parse \(spec); want x0,y0->x1,y1@ms")
            }
        }
        if env["ORB_STICK"] == "1" {
            let at = Double(env["ORB_STICK_AT"] ?? "") ?? 1.0
            stickPull = Double(env["ORB_STICK_PULL"] ?? "") ?? 95
            stickNeckShot = Double(env["ORB_STICK_NECK"] ?? "") ?? 0.5
            DispatchQueue.main.asyncAfter(deadline: .now() + at) { [weak self] in
                guard let self, let wall = self.orb.previewNearestWall else { print("stick: no wall found"); return }
                // The body stops 0.9 × radius short of the wall; launch so it arrives at
                // ~320 pt/s, under the stick speed, unless told the speed.
                let travel = max(10, wall.distance - 0.9 * 0.36 * Double(OrbPanelController.collapsedSize.width))
                let v0 = Double(env["ORB_STICK_V"] ?? "") ?? Self.launchSpeed(travel: travel, arrival: 320)
                self.stickWall = wall
                self.stickPhase = "flung"
                self.restShotTaken = true   // the stick shot replaces the rest shot
                print(self.stamp, String(format: "stick: fling %.0f pt/s toward the wall at (%.0f,%.0f), %.0f pt away (travel %.0f) from CG %.0f,%.0f",
                                         v0, wall.dx, wall.dy, wall.distance, travel, self.orb.previewCenterCG.x, self.orb.previewCenterCG.y))
                fflush(stdout)
                self.orb.previewFling(vx: wall.dx * v0, vy: wall.dy * v0)
            }
        }
        if env["ORB_EYES"] == "1" {
            let at = Double(env["ORB_EYES_AT"] ?? "") ?? 1.0
            DispatchQueue.main.asyncAfter(deadline: .now() + at) { [weak self] in self?.renderExpressionStrip() }
        }
        if let spec = env["ORB_FLY"] ?? (notchMode ? "1000,420" : nil) {
            flyTargets = spec.split(separator: ";").compactMap { pair -> CGPoint? in
                let p = pair.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
                return p.count == 2 ? CGPoint(x: p[0], y: p[1]) : nil
            }
            let at = Double(env["ORB_FLY_AT"] ?? "") ?? (notchMode ? 4.6 : 1.2)
            let every = Double(env["ORB_FLY_EVERY"] ?? "") ?? 2.0
            let dwell = Double(env["ORB_FLY_DWELL"] ?? "") ?? 2000
            // Both modes: the blob stays where it worked (stay / notch-stay). A way home is
            // shot only when one is scheduled: ORB_FLY_HOME's orb.home (fly-home, free mode)
            // or the sleep transition (notch-return: ORB_SLEEP_AT, on by default in notch mode).
            if shotDir != nil {
                flyShotsOwed = ["outbound", "hovering", "stay"]
                if env["ORB_FLY_HOME"] == "1" || env["ORB_SLEEP_AT"] != nil || notchMode { flyShotsOwed.insert("homing") }
            }
            // Notch mode's script: the fly, the hover, the stay — then sleep, and the way up.
            if notchMode, env["ORB_SLEEP_AT"] == nil, !flyTargets.isEmpty {
                sleepAt = at + every * Double(flyTargets.count - 1) + dwell / 1000 + 2.0
            }
            for (i, target) in flyTargets.enumerated() {
                // A ring where the target is, so the shots show the blob parked beside it and not on it.
                let ring = NSWindow(contentRect: NSRect(x: target.x - 14, y: mainMaxY - target.y - 14, width: 28, height: 28),
                                    styleMask: [.borderless], backing: .buffered, defer: false)
                ring.level = .floating
                ring.isOpaque = false
                ring.backgroundColor = .clear
                ring.ignoresMouseEvents = true
                ring.hasShadow = false
                ring.isReleasedWhenClosed = false
                ring.contentView = TargetRingView(frame: NSRect(x: 0, y: 0, width: 28, height: 28))
                ring.orderFrontRegardless()
                targetWindows.append(ring)
                DispatchQueue.main.asyncAfter(deadline: .now() + at + every * Double(i)) { [weak self] in
                    guard let self else { return }
                    print(self.stamp, String(format: "orb.fly -> CG %.0f,%.0f (dwell %.0f ms) from CG %.0f,%.0f", target.x, target.y, dwell,
                                 self.orb.previewFrameCG.midX, self.orb.previewFrameCG.midY))
                    fflush(stdout)
                    self.state.overlayCommands.send(.orbFly(x: target.x, y: target.y, dwellMs: dwell, reason: "preview \(i + 1)", thread: nil))
                    // The command is delivered on the next turn of the run loop; report what it did.
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
                        guard let self else { return }
                        print(String(format: "  -> flight %@, hover left %.2f s, waiting for Kevin's motion: %d", self.orb.previewFlightPhase,
                                     self.orb.previewHoverRemaining, self.orb.previewHasPendingFly ? 1 : 0))
                        fflush(stdout)
                    }
                }
            }
            if env["ORB_FLY_HOME"] == "1", !flyTargets.isEmpty {
                let homeAt = at + every * Double(flyTargets.count - 1) + (Double(env["ORB_FLY_HOME_AT"] ?? "") ?? 1.0)
                DispatchQueue.main.asyncAfter(deadline: .now() + homeAt) { [weak self] in
                    guard let self else { return }
                    print(self.stamp, "orb.home (phase was \(self.orb.previewFlightPhase))")
                    fflush(stdout)
                    self.state.overlayCommands.send(.orbHome)
                }
            }
        }
        if let spec = env["ORB_TRACE"] {
            tracePoints = spec.split(separator: ";").compactMap { pair -> CGPoint? in
                let p = pair.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
                return p.count == 2 ? CGPoint(x: p[0], y: p[1]) : nil
            }
            let at = Double(env["ORB_TRACE_AT"] ?? "") ?? 1.2
            let closed = env["ORB_TRACE_CLOSED"] == "1"
            let labelRaw = env["ORB_TRACE_LABEL"] ?? "Deploy button"
            let label: String? = labelRaw.isEmpty ? nil : labelRaw
            traceLabel = label
            let tone = OverlayTone(rawValue: env["ORB_TRACE_TONE"] ?? "accent") ?? .accent
            if shotDir != nil { traceShotsOwed = ["cursor", "done"] }
            if tracePoints.count >= 2 {
                DispatchQueue.main.asyncAfter(deadline: .now() + at) { [weak self] in
                    guard let self else { return }
                    let f = self.orb.previewFrameCG
                    print(self.stamp, String(format: "orb.trace -> %d points%@ from CG %.0f,%.0f (%@, tone %@, label %@)", self.tracePoints.count,
                                             closed ? " (closed)" : "", f.midX, f.midY, self.tracePoints.map { "\(Int($0.x)),\(Int($0.y))" }.joined(separator: " "),
                                             tone.rawValue, label ?? "none"))
                    fflush(stdout)
                    self.state.overlayCommands.send(.orbTrace(points: self.tracePoints.map { Point2(x: $0.x, y: $0.y) }, closed: closed, label: label,
                                                             ttlMs: nil, tone: tone, reason: "preview", thread: nil))
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
                        guard let self else { return }
                        print(String(format: "  -> flight %@, tracing %d, cursor %.2f", self.orb.previewFlightPhase, self.orb.previewIsTracing ? 1 : 0, self.orb.previewCursorK))
                        fflush(stdout)
                    }
                }
            } else {
                print("ORB_TRACE: could not parse \(spec); want x,y;x,y;…")
            }
        }
        if let at = Double(env["ORB_CLEAR_AT"] ?? "") {
            DispatchQueue.main.asyncAfter(deadline: .now() + at) { [weak self] in
                guard let self else { return }
                let before = self.orb.previewFlightPhase
                let progress = self.orb.previewTraceProgress
                print(self.stamp, String(format: "overlay clear (flight was %@, trace at %.0f/%.0f)", before, progress.s, progress.length))
                fflush(stdout)
                self.state.overlayCommands.send(.clear)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
                    guard let self else { return }
                    let layer = self.overlay.windows.map { "\($0.model.strokes.count)" }.joined(separator: ", ")
                    print(self.stamp, String(format: "  -> flight %@, tracing %d, cursor %.2f, pill %@, overlay strokes [%@]", self.orb.previewFlightPhase,
                                             self.orb.previewIsTracing ? 1 : 0, self.orb.previewCursorK, self.state.toasts.last?.text ?? "none", layer))
                    fflush(stdout)
                }
            }
        }
        if let at = Double(env["ORB_PAUSE_AT"] ?? "") {
            pauseScriptAt = CACurrentMediaTime()
            DispatchQueue.main.asyncAfter(deadline: .now() + at) { [weak self] in
                guard let self else { return }
                let was = self.state.snapshot.phase
                print(self.stamp, "pause pressed (phase \(was.rawValue))")
                fflush(stdout)
                self.orb.previewTogglePause()
                // The engine would answer with the phase; the harness plays the engine.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
                    guard let self else { return }
                    self.state.snapshot.phase = was == .paused ? .listening : .paused
                    self.phaseStart = Date()
                    // The meter as the engine leaves it: a pause closes the session and holds its seconds; a resume opens a new one.
                    let nowMs = Date().timeIntervalSince1970 * 1000
                    if was == .paused {
                        if let kept = self.pausedSession { self.state.snapshot.session = SessionInfo(id: kept.id + "_r", startedAt: nowMs, expiresAt: nowMs + 3_600_000, usageSeconds: 0, contextRatio: kept.contextRatio) }
                        self.state.snapshot.pause = nil
                    } else if let session = self.state.snapshot.session {
                        self.pausedSession = session
                        self.state.snapshot.pause = PauseInfo(at: nowMs, sessionId: session.id, usageSeconds: session.usageSeconds, sleepsAt: nowMs + 4 * 60_000)
                        self.state.snapshot.session = nil
                    }
                    // The pill is derived on the next turn of the run loop; read it then.
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
                        guard let self else { return }
                        print(self.stamp, "  -> phase \(self.state.snapshot.phase.rawValue), face [\(self.orb.previewFace)], pill \(self.orb.previewPillText ?? "none"), toast \(self.state.toasts.last?.text ?? "none")")
                        fflush(stdout)
                    }
                }
                if let dir = self.shotDir, was != .paused {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) { [weak self] in
                        guard let self else { return }
                        self.shoot("\(dir)/\(self.shotPrefix)paused.png", note: "paused: \(self.orb.previewFace), eyes [\(self.orb.previewEyes)]")
                    }
                }
            }
        }
        if let at = Double(env["ORB_STOP_AT"] ?? "") {
            DispatchQueue.main.asyncAfter(deadline: .now() + at) { [weak self] in
                guard let self else { return }
                let before = self.orb.previewFlightPhase
                let progress = self.orb.previewTraceProgress
                print(self.stamp, String(format: "stop pressed (flight was %@, trace at %.0f/%.0f)", before, progress.s, progress.length))
                fflush(stdout)
                self.orb.previewStop()
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
                    guard let self else { return }
                    print(self.stamp, String(format: "  -> flight %@, tracing %d, cursor %.2f, pill %@, eyes [%@]", self.orb.previewFlightPhase,
                                             self.orb.previewIsTracing ? 1 : 0, self.orb.previewCursorK, self.state.toasts.last?.text ?? "none", self.orb.previewEyes))
                    fflush(stdout)
                }
                if let dir = self.shotDir {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { [weak self] in
                        guard let self else { return }
                        self.shoot("\(dir)/\(self.shotPrefix)stop.png", note: "0.45 s after Stop, flight \(self.orb.previewFlightPhase)", extra: self.traceRegion)
                    }
                }
            }
        }
        // The awake↔asleep transitions, as the engine's phase would deliver them: the
        // only moves back to the dock. Prints the flight, whether it is tucked and where
        // the body is at the flip, 0.1 s after (the tuck scheduled, a Stop's shiver) and
        // 1.2 s after (the way up under way, or tucked in).
        // ORB_NOTCH_STRIP_PROBE=t: the working strip's alphas at forced levels, measured off a bitmap.
        if let at = Double(env["ORB_NOTCH_STRIP_PROBE"] ?? "") {
            DispatchQueue.main.asyncAfter(deadline: .now() + at) { [weak self] in
                guard let self else { return }
                let line = self.orb.previewNotchStripProbe ?? "notch strip probe: no dock (set ORB_NOTCH=1)"
                print(self.stamp, line)
                fflush(stdout)
                self.check(line.hasSuffix("OK"), "strip probe (ORB_NOTCH_STRIP_PROBE) still OK at 184", line)
            }
        }

        if let at = sleepAt {
            DispatchQueue.main.asyncAfter(deadline: .now() + at) { [weak self] in
                guard let self else { return }
                let c = self.orb.previewCenterCG
                print(self.stamp, String(format: "phase -> %@ (was %@; flight %@, tucked %d, home %@%@, body CG %.0f,%.0f)", self.sleepPhase.rawValue, self.state.snapshot.phase.rawValue,
                                         self.orb.previewFlightPhase, self.orb.previewIsTucked ? 1 : 0, self.orb.previewHomeMode,
                                         self.orb.previewFreeForSession ? " (dragged out)" : "", c.x, c.y))
                fflush(stdout)
                self.state.snapshot.phase = self.sleepPhase
                self.phaseStart = Date()
                if self.notchMode {
                    // The engine closes the session (and ends a pause) when it sleeps: the meter reads today's total.
                    self.state.snapshot.session = nil
                    self.state.snapshot.pause = nil
                }
                for delay in [0.1, 1.2] {
                    DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                        guard let self else { return }
                        let c = self.orb.previewCenterCG
                        print(self.stamp, String(format: "  -> %.1f s: flight %@, tuck pending %d, tucked %d, home %@, body CG %.0f,%.0f, face [%@]", delay,
                                                 self.orb.previewFlightPhase, self.orb.previewSleepTuckPending ? 1 : 0, self.orb.previewIsTucked ? 1 : 0,
                                                 self.orb.previewHomeMode, c.x, c.y, self.orb.previewFace))
                        fflush(stdout)
                    }
                }
            }
        }
        if let at = Double(env["ORB_WAKE_AT"] ?? "") {
            DispatchQueue.main.asyncAfter(deadline: .now() + at) { [weak self] in
                guard let self else { return }
                let c = self.orb.previewCenterCG
                print(self.stamp, String(format: "phase -> listening (was %@; flight %@, tucked %d, home %@%@, body CG %.0f,%.0f)", self.state.snapshot.phase.rawValue,
                                         self.orb.previewFlightPhase, self.orb.previewIsTucked ? 1 : 0, self.orb.previewHomeMode,
                                         self.orb.previewFreeForSession ? " (dragged out)" : "", c.x, c.y))
                fflush(stdout)
                self.state.snapshot.phase = .listening
                self.phaseStart = Date()
                for delay in [0.1, 1.2] {
                    DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                        guard let self else { return }
                        let c = self.orb.previewCenterCG
                        print(self.stamp, String(format: "  -> %.1f s: flight %@, tucked %d, home %@, body CG %.0f,%.0f", delay, self.orb.previewFlightPhase,
                                                 self.orb.previewIsTucked ? 1 : 0, self.orb.previewHomeMode, c.x, c.y))
                        fflush(stdout)
                    }
                }
            }
        }
        if let spec = env["ORB_DRAG_OUT_AT"], let at = Double(spec) {
            // Kevin pulls the face out of the notch into his hand (CG ORB_DRAG_OUT_TO, default
            // 700,400) and lets go: free until the next sleep; the pill offers the way back.
            let to = (env["ORB_DRAG_OUT_TO"] ?? "700,400").split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
            let hand = to.count == 2 ? CGPoint(x: to[0], y: to[1]) : CGPoint(x: 700, y: 400)
            DispatchQueue.main.asyncAfter(deadline: .now() + at) { [weak self] in
                guard let self, let dock = self.orb.previewNotchDockCG else { return }
                print(self.stamp, String(format: "drag out of the notch -> CG %.0f,%.0f (tucked %d)", hand.x, hand.y, self.orb.previewIsTucked ? 1 : 0))
                fflush(stdout)
                self.orb.previewDragOutOfNotch(at: CGPoint(x: dock.x, y: dock.y + 20))
                self.orb.previewDrag(from: CGPoint(x: dock.x, y: dock.y + 20), to: hand, ms: 600, done: { [weak self] in
                    guard let self else { return }
                    let c = self.orb.previewCenterCG
                    print(self.stamp, String(format: "  -> let go: home %@%@, tucked %d, body CG %.0f,%.0f, pill %@", self.orb.previewHomeMode,
                                             self.orb.previewFreeForSession ? " (dragged out)" : "", self.orb.previewIsTucked ? 1 : 0, c.x, c.y,
                                             self.orb.previewPillText ?? "none"))
                    fflush(stdout)
                })
            }
        }
        if env["ORB_OVERLAY"] == "1" {
            let base = CGPoint(x: x + 200, y: y + 40)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
                self?.state.overlayCommands.send(.point(x: base.x, y: base.y, label: "Deploy button", ttlMs: 6000))
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.3) { [weak self] in
                self?.state.overlayCommands.send(.highlight(rect: Rect(x: base.x + 60, y: base.y + 60, w: 220, h: 48), label: "Search field", ttlMs: 6000))
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.8) { [weak self] in
                self?.state.overlayCommands.send(.path(from: Point2(x: base.x - 40, y: base.y + 180), to: Point2(x: base.x + 260, y: base.y + 140), ttlMs: 6000))
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.3) { [weak self] in
                self?.state.overlayCommands.send(.clickPulse(x: base.x + 260, y: base.y + 140))
            }
        }

        let exitAfter = Double(env["ORB_EXIT_AFTER"] ?? "") ?? 30
        DispatchQueue.main.asyncAfter(deadline: .now() + exitAfter) { [weak self] in
            if let self, self.fleetOn {
                print(self.stamp, "fleet sends: thread.stop \(self.fleetSends.stop) sleep \(self.fleetSends.sleep) set-settings \(self.fleetSends.settings) other \(self.fleetSends.other);",
                      "satellites \(self.fleet.previewSatelliteCount) leaving \(self.fleet.previewLeavingCount) pool \(self.fleet.previewPanelPoolCount) made \(self.fleet.previewPanelsMade) rung \(self.fleet.previewRung) link paused \(self.fleet.previewLinkPaused ? 1 : 0)")
            }
            if let self, self.notchMode {
                self.inkAfterCloseCheck()
                // The dock's safety count: nothing but Go (and a typed line under typedWakes) may open a session.
                print(self.stamp, self.notchSends.line)
                print(self.stamp, "overlay sends: mark.add \(self.notchSends.markAdd); other: \(self.notchSends.otherTypes.isEmpty ? "none" : self.notchSends.otherTypes.joined(separator: " ")); checks failed \(self.notchChecksFailed)")
            }
            print("preview: exiting")
            fflush(stdout)
            NSApp.terminate(nil)
        }
    }

    // MARK: - ORB_SELFTEST: the pure checks

    /// FleetBudget on a synthetic 24 fps clock and BlobBody.landing(for:avoiding:) on
    /// this Mac's displays. No window, no link; prints one line per check.
    static func runSelfTest() -> Bool {
        var ok = true
        func check(_ pass: Bool, _ what: String) {
            print(pass ? "  ok  " : "  FAIL", what)
            if !pass { ok = false }
        }

        // FleetBudget: the idle link's 24 fps, dt = 1/24.
        var b = FleetBudget()
        var t = 0.0
        var changes = 0
        /// Feed `n` frames of `ms`; the frame numbers at which the rung changed.
        func feed(_ ms: Double, _ n: Int) -> [Int] {
            var at: [Int] = []
            for _ in 0..<n {
                t += 1.0 / 24
                let before = b.rung
                let changed = b.note(ms: ms, now: t)
                if changed { changes += 1; at.append(b.frames) }
                if changed != (b.rung != before) { at.append(-1) }   // `note` true exactly on a change
            }
            return at
        }
        let c1 = feed(9, 29)
        check(c1.isEmpty && b.rung == 0, "29 heavy frames (9 ms): rung 0 — the window has not filled")
        let c2 = feed(9, 1)
        check(c2 == [30] && b.rung == 1, "the 30th heavy frame: rung 1 (changed at frame \(c2))")
        let c3 = feed(9, 30)
        check(c3 == [60] && b.rung == 2, "one step per window: rung 2 at frame 60 (\(c3))")
        let c4 = feed(9, 20)
        let loadEnd = t
        let c5 = feed(0.5, 10)
        check(c4.isEmpty && c5.isEmpty && b.rung == 2, String(format: "a window straddling the load's end (20 × 9 + 10 × 0.5 = mean %.2f > 6) does not step: rung %d", (20 * 9 + 10 * 0.5) / 30, b.rung))
        let rungAt1s: Int = {
            while t - loadEnd < 1.0 { _ = feed(0.5, 1) }
            return b.rung
        }()
        check(rungAt1s == 2, "1.0 s after the load: still rung \(rungAt1s) (recoverAfter 1.5)")
        var recovery = -1.0
        while t - loadEnd < 5 {
            _ = feed(0.5, 1)
            if b.rung == 0 { recovery = t - loadEnd; break }
        }
        check(recovery >= 1.5 && recovery <= 2.0, String(format: "recovery to rung 0 %.3f s after the load ended (want 1.5 … 2.0: 10 frames at 24 fps + 1.5 s)", recovery))
        check(changes == 3, "`note` returned true \(changes) times = the three rung changes")
        // The line: the p95 and the max over the samples since the last line.
        var l = FleetBudget()
        for i in 1...20 { _ = l.note(ms: Double(i), now: Double(i) / 24) }
        let line = l.line()
        check(line.contains("mean 10.50 ms") && line.contains("p95 20.00 ms") && line.contains("max 20.00 ms") && line.contains("over 20 frames"), "line(): \(line)")

        // BlobBody.landing(for:avoiding:) — a satellite-sized body, the target mid-display.
        let body = BlobBody(size: BlobMetrics.satellitePanelSize, center: CGPoint(x: 400, y: 600))
        let work = ScreenArea.all().first?.work ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
        let target = CGPoint(x: work.midX, y: work.midY)
        let plain = body.landing(for: target)
        let plainNote = body.lastLandingNote
        let empty = body.landing(for: target, avoiding: [])
        check(plain == empty && !body.lastLandingNote.contains("occupied"), String(format: "an empty `avoiding` is the plain choice: CG %.0f,%.0f (%@)", plain.x, plain.y, plainNote))
        let r = body.radius
        let onSpot = CGRect(x: plain.x - r, y: plain.y - r, width: 2 * r, height: 2 * r)
        let dodged = body.landing(for: target, avoiding: [onSpot])
        let apart = hypot(dodged.x - plain.x, dodged.y - plain.y)
        check(dodged != plain && apart >= 92 && body.lastLandingNote.contains("occupied →"), String(format: "the chosen spot occupied → CG %.0f,%.0f, %.0f pt from it (≥ 92), note '%@'", dodged.x, dodged.y, apart, body.lastLandingNote))
        let d = 1 / 2.0.squareRoot()
        let reach = r + BlobBody.flyClearance
        let ring = [(-d, -d), (0, -1), (d, -d), (-1, 0), (1, 0), (-d, d), (0, 1), (d, d)].map { dir in
            CGRect(x: target.x + CGFloat(reach * dir.0) - r, y: target.y + CGFloat(reach * dir.1) - r, width: 2 * r, height: 2 * r)
        }
        let fallback = body.landing(for: target, avoiding: ring)
        check(fallback == plain && body.lastLandingNote.contains("every side taken"), String(format: "every side taken → the plain choice CG %.0f,%.0f, note '%@'", fallback.x, fallback.y, body.lastLandingNote))
        return ok
    }

    // MARK: - The fleet (ORB_FLEET)

    /// "working" is acting; anything else is the wire's word.
    static func fleetStatus(_ word: String) -> ThreadStatus {
        let w = word.lowercased()
        if w == "working" || w == "acting" { return .acting }
        return ThreadStatus(rawValue: w) ?? .acting
    }

    /// The fake records, the tagged flies, the status flips, the drag, the click, the budget load.
    private func setUpFleet(spec: String, env: [String: String]) {
        fleetOn = true
        fleetAt = Double(env["ORB_FLEET_AT"] ?? "") ?? (notchMode ? 1.6 : 1.2)
        fleetShotName = env["ORB_FLEET_SHOT"] ?? "three"
        let nowMs = Date().timeIntervalSince1970 * 1000
        for entry in spec.split(separator: ";") {
            let raw = entry.trimmingCharacters(in: .whitespaces)
            guard !raw.isEmpty else { continue }
            let atParts = raw.split(separator: "@", maxSplits: 1).map(String.init)
            let fields = atParts[0].split(separator: ":", omittingEmptySubsequences: false).map { String($0).trimmingCharacters(in: .whitespaces) }
            guard let name = fields.first, !name.isEmpty else { continue }
            let id = "t_" + name.lowercased()
            let lane = fields.count > 1 ? (ThreadLane(rawValue: fields[1]) ?? .screen) : .screen
            let status = fields.count > 2 ? Self.fleetStatus(fields[2]) : .acting
            let app = fields.count > 3 && !fields[3].isEmpty ? fields[3] : nil
            var at: Point2?
            if atParts.count > 1 {
                let p = atParts[1].split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
                if p.count == 2 {
                    at = Point2(x: p[0], y: p[1])
                    fleetTargets[id] = CGPoint(x: p[0], y: p[1])
                    addFleetRing(CGPoint(x: p[0], y: p[1]))
                }
            }
            // The first listed is the newest (10 ms apart): the rail's order — startedAt descending — is the list's order.
            fleetThreads.append(WorkThread(id: id, name: name, lane: lane, status: status, parentId: "main", parentDelegationId: "d1", liveId: "live_1",
                                           task: "preview: \(name)", detail: nil, apps: app.map { [$0] } ?? [], app: app, at: at,
                                           startedAt: nowMs - 3000 - Double(fleetThreads.count) * 10, updatedAt: nowMs, doneAt: nil, turns: 1, steps: 3, waits: 0,
                                           budget: WorkThread.Budget(steps: 25, seconds: 180), question: nil, currentDelegationId: "d_\(name.lowercased())",
                                           lastScreenshotPath: nil, canSay: true, canStop: true))
        }
        guard !fleetThreads.isEmpty else { print("ORB_FLEET: nothing parsed from \(spec); want Name:lane:status[@x,y][:app]; …"); return }
        // ORB_NOTCH_QUESTION="Slack:Send it to #general?": that thread waits on Kevin with the question.
        if let q = env["ORB_NOTCH_QUESTION"] {
            let parts = q.split(separator: ":", maxSplits: 1).map { String($0).trimmingCharacters(in: .whitespaces) }
            if parts.count == 2, let i = fleetThreads.firstIndex(where: { $0.name.lowercased() == parts[0].lowercased() }) {
                if let at = env["ORB_NOTCH_QUESTION_AT"] {
                    // Deferred: with the ring's end, or at t — the kind flip the dead-time guards.
                    pendingQuestion = (fleetThreads[i].id, parts[1])
                    deadTimePressWanted = true
                    if at == "ring-end" { pendingQuestionAtRingEnd = true } else if let t = Double(at) {
                        DispatchQueue.main.asyncAfter(deadline: .now() + t) { [weak self] in self?.applyPendingQuestion() }
                    }
                } else {
                    fleetThreads[i].status = .waitingKevin
                    fleetThreads[i].question = parts[1]
                }
            } else {
                print("ORB_NOTCH_QUESTION: could not parse \(q) or no fleet thread named \(parts.first ?? "?"); want Name:question")
            }
        }
        // The check shot: the plain scenario's (fleet-three.png), or one ORB_FLEET_SHOT
        // names. A status, drag, click, hover, trace, late-thread, budget or notch run
        // has its own shots and must never land its frame (the main blob tucked, a
        // satellite mid-fade, a tag up) in fleet-three.png.
        let ownScenario = notchMode || ["ORB_FLEET_STATUS", "ORB_FLEET_DRAG", "ORB_FLEET_CLICK", "ORB_FLEET_HOVER", "ORB_FLEET_TRACE", "ORB_FLEET_LATE", "ORB_FLEET_BUDGET_FORCE_MS"].contains { env[$0] != nil }
        fleetShotOwed = shotDir != nil && (env["ORB_FLEET_SHOT"] != nil || !ownScenario)
        fleetCommandsUntil = max(fleetCommandsUntil, fleetAt)
        DispatchQueue.main.asyncAfter(deadline: .now() + fleetAt) { [weak self] in
            guard let self else { return }
            print(self.stamp, "fleet: snapshot.threads <-", self.fleetThreads.map { "\($0.name):\($0.lane.rawValue):\($0.status.rawValue)\($0.at.map { "@\(Int($0.x)),\(Int($0.y))" } ?? "")\($0.app.map { ":\($0)" } ?? "")" }.joined(separator: " "))
            fflush(stdout)
            self.state.snapshot.threads = self.fleetThreads
            // As EngineClient does on a snapshot: the event-fed table the dock's rows read.
            self.state.applySnapshotThreads(self.fleetThreads)
            self.fleetLastCommandAt = CACurrentMediaTime()
        }

        // ORB_FLEET_LATE="t:Name:lane:status; …": a thread that starts later (proves the panel pool's reuse).
        if let late = env["ORB_FLEET_LATE"] {
            for entry in late.split(separator: ";") {
                let fields = entry.split(separator: ":").map { String($0).trimmingCharacters(in: .whitespaces) }
                guard fields.count >= 2, let t = Double(fields[0]) else { print("ORB_FLEET_LATE: could not parse \(entry); want t:Name:lane:status"); continue }
                let name = fields[1]
                let lane = fields.count > 2 ? (ThreadLane(rawValue: fields[2]) ?? .screen) : .screen
                let status = fields.count > 3 ? Self.fleetStatus(fields[3]) : .acting
                fleetCommandsUntil = max(fleetCommandsUntil, t)
                DispatchQueue.main.asyncAfter(deadline: .now() + t) { [weak self] in
                    guard let self else { return }
                    let ms = Date().timeIntervalSince1970 * 1000
                    let record = WorkThread(id: "t_" + name.lowercased(), name: name, lane: lane, status: status, parentId: "main", parentDelegationId: "d1", liveId: "live_1",
                                            task: "preview: \(name)", detail: nil, apps: [], app: nil, at: nil, startedAt: ms, updatedAt: ms, doneAt: nil, turns: 1, steps: 0, waits: 0,
                                            budget: WorkThread.Budget(steps: 25, seconds: 180), question: nil, currentDelegationId: nil, lastScreenshotPath: nil, canSay: true, canStop: true)
                    var threads = self.state.snapshot.threads
                    threads.append(record)
                    self.fleetThreads.append(record)
                    print(self.stamp, "fleet: late thread \(name) (\(status.rawValue)) joins; \(self.fleetCounts)")
                    fflush(stdout)
                    self.state.snapshot.threads = threads
                    self.state.applySnapshotThreads(threads)
                    self.fleetLastCommandAt = CACurrentMediaTime()
                    for delay in [0.3, 1.5] {
                        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                            guard let self else { return }
                            let s = self.fleet.previewSatellite(named: name)
                            print(self.stamp, "fleet: late +\(delay) s \(name) \(s == nil ? "is a dot only" : "has a satellite") \(self.fleetCounts)")
                            fflush(stdout)
                        }
                    }
                }
            }
        }

        if let flies = env["ORB_FLEET_FLY"] {
            for (i, entry) in flies.split(separator: ";").enumerated() {
                let parts = entry.split(separator: "@").map { String($0).trimmingCharacters(in: .whitespaces) }
                guard parts.count >= 2 else { print("ORB_FLEET_FLY: could not parse \(entry); want Name@x,y[@t]"); continue }
                let name = parts[0]
                let p = parts[1].split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
                guard p.count == 2 else { continue }
                let t = parts.count > 2 ? (Double(parts[2]) ?? fleetAt + 0.4 + 0.4 * Double(i)) : fleetAt + 0.4 + 0.4 * Double(i)
                let target = CGPoint(x: p[0], y: p[1])
                let id = "t_" + name.lowercased()
                fleetTargets[id] = target
                addFleetRing(target)
                fleetCommandsUntil = max(fleetCommandsUntil, t)
                DispatchQueue.main.asyncAfter(deadline: .now() + t) { [weak self] in
                    guard let self else { return }
                    print(self.stamp, String(format: "orb.fly {thread %@} -> CG %.0f,%.0f", id, target.x, target.y))
                    fflush(stdout)
                    self.state.overlayCommands.send(.orbFly(x: target.x, y: target.y, dwellMs: 2000, reason: "preview", thread: id))
                    self.fleetLastCommandAt = CACurrentMediaTime()
                    for delay in [0.1, 2.3] {
                        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                            guard let self else { return }
                            print(self.stamp, "fleet pending: \(self.fleet.previewPendingFlies) (+\(delay) s after the fly for \(name))")
                            fflush(stdout)
                        }
                    }
                }
            }
        }

        // ORB_FLEET_TRACE="Name@x,y;x,y;…[@closed][@t]": a tagged trace. The satellite flies
        // beside the first point; the shape is one untagged `.stroke`; the main blob stays.
        if let spec = env["ORB_FLEET_TRACE"] {
            let parts = spec.split(separator: "@").map { String($0).trimmingCharacters(in: .whitespaces) }
            let pts = parts.count > 1 ? parts[1].split(separator: ";").compactMap { pair -> CGPoint? in
                let xy = pair.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
                return xy.count == 2 ? CGPoint(x: xy[0], y: xy[1]) : nil
            } : []
            if parts.count >= 2, pts.count >= 2 {
                let name = parts[0]
                let id = "t_" + name.lowercased()
                var closed = false
                var t = fleetAt + 0.6
                for extra in parts.dropFirst(2) {
                    if extra.lowercased() == "closed" { closed = true } else if let v = Double(extra) { t = v }
                }
                fleetTargets[id] = pts[0]
                addFleetRing(pts[0])
                fleetCommandsUntil = max(fleetCommandsUntil, t)
                DispatchQueue.main.asyncAfter(deadline: .now() + t) { [weak self] in
                    guard let self else { return }
                    let mainBefore = self.orb.previewCenterCG
                    let strokesBefore = self.strokesSeen
                    print(self.stamp, String(format: "orb.trace {thread %@} -> %d points%@ from CG %.0f,%.0f; main blob %@ at CG %.0f,%.0f", id, pts.count, closed ? " (closed)" : "",
                                             pts[0].x, pts[0].y, self.orb.previewFlightPhase, mainBefore.x, mainBefore.y))
                    fflush(stdout)
                    self.state.overlayCommands.send(.orbTrace(points: pts.map { Point2(x: $0.x, y: $0.y) }, closed: closed, label: "Deploy", ttlMs: 4000, tone: .accent, reason: "preview", thread: id))
                    self.fleetLastCommandAt = CACurrentMediaTime()
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
                        guard let self else { return }
                        let want = closed ? pts.count + 1 : pts.count
                        let n = self.strokesSeen - strokesBefore
                        print(self.stamp, "fleet trace: strokes stamped \(n) (want 1: \(n == 1 ? "OK" : "FAIL")), last stroke \(self.lastStrokePoints) points (want \(want): \(self.lastStrokePoints == want ? "OK" : "FAIL"))")
                        fflush(stdout)
                    }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
                        guard let self else { return }
                        let c = self.orb.previewCenterCG
                        let still = hypot(c.x - mainBefore.x, c.y - mainBefore.y) < 1
                        print(self.stamp, String(format: "fleet trace: +1.0 s main blob %@ at CG %.0f,%.0f (unmoved: %@)", self.orb.previewFlightPhase, c.x, c.y, still ? "OK" : "FAIL"))
                        fflush(stdout)
                    }
                }
            } else {
                print("ORB_FLEET_TRACE: could not parse \(spec); want Name@x,y;x,y;…[@closed][@t]")
            }
        }

        // ORB_FLEET_HOVER="Name@t": the name tag on hover, through the cell's own handler.
        if let spec = env["ORB_FLEET_HOVER"] {
            let parts = spec.split(separator: "@").map { String($0).trimmingCharacters(in: .whitespaces) }
            let name = parts[0]
            let t = parts.count > 1 ? (Double(parts[1]) ?? 2.5) : 2.5
            DispatchQueue.main.asyncAfter(deadline: .now() + t) { [weak self] in
                guard let self else { return }
                guard let s = self.fleet.previewSatellite(named: name) else { print(self.stamp, "fleet hover: no satellite named \(name)"); fflush(stdout); return }
                s.previewHover(true)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
                    guard let self, let s = self.fleet.previewSatellite(named: name) else { return }
                    print(self.stamp, "fleet hover: \(name) entered; tag '\(s.previewHoverPillText ?? "none")' shown '\(s.pillText ?? "none")' tracking areas \(s.previewTrackingAreaCount) (want '\(name)', 1: \(s.pillText == name && s.previewTrackingAreaCount == 1 ? "OK" : "FAIL"))")
                    fflush(stdout)
                    if let dir = self.shotDir {
                        self.shoot("\(dir)/\(self.shotPrefix)fleet-hover.png", note: "\(name) hovered: tag '\(s.pillText ?? "none")'", extra: self.fleetRegion(focus: name))
                    }
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
                    guard let self, let s = self.fleet.previewSatellite(named: name) else { return }
                    s.previewHover(false)
                    print(self.stamp, "fleet hover: \(name) left")
                    fflush(stdout)
                    for (delay, wantUp) in [(0.6, true), (1.5, false)] {
                        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                            guard let self, let s = self.fleet.previewSatellite(named: name) else { return }
                            let up = s.pillText != nil
                            print(self.stamp, "fleet hover: +\(delay) s after leaving tag \(up ? "'\(s.pillText!)'" : "gone") (want \(wantUp ? "up" : "gone"): \(up == wantUp ? "OK" : "FAIL"))")
                            fflush(stdout)
                        }
                    }
                }
            }
        }

        if let flips = env["ORB_FLEET_STATUS"] {
            for entry in flips.split(separator: ";") {
                let parts = entry.split(separator: "@").map { String($0).trimmingCharacters(in: .whitespaces) }
                guard parts.count == 2, let t = Double(parts[1]) else { print("ORB_FLEET_STATUS: could not parse \(entry); want Name=status@t"); continue }
                let assign = parts[0].split(separator: "=").map { String($0).trimmingCharacters(in: .whitespaces) }
                guard assign.count == 2 else { continue }
                let name = assign[0], status = Self.fleetStatus(assign[1])
                let id = "t_" + name.lowercased()
                DispatchQueue.main.asyncAfter(deadline: .now() + t) { [weak self] in
                    guard let self else { return }
                    var threads = self.state.snapshot.threads
                    guard let i = threads.firstIndex(where: { $0.id == id }) else { return }
                    threads[i].status = status
                    threads[i].updatedAt = Date().timeIntervalSince1970 * 1000
                    if !status.isLive { threads[i].doneAt = threads[i].updatedAt }
                    if status == .waitingKevin { threads[i].question = "send it to Ben with the Q3 numbers attached?" }
                    print(self.stamp, "fleet: \(name) status -> \(status.rawValue)")
                    fflush(stdout)
                    self.state.snapshot.threads = threads
                    self.state.applySnapshotThreads(threads)
                    self.fleetLastCommandAt = CACurrentMediaTime()
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                        guard let self else { return }
                        let s = self.fleet.previewSatellite(named: name)
                        let face = s.map { "\($0.sim.face.left) \($0.sim.face.right)" } ?? "gone"
                        print(self.stamp, "fleet: \(name) +0.5 s face [\(face)] pill \(s?.pillText ?? "none") \(self.fleetCounts)")
                        fflush(stdout)
                        if let dir = self.shotDir {
                            let what: String
                            switch status {
                            case .waitingScreen: what = "waiting"
                            case .waitingKevin: what = "asks"
                            case .done: what = "done"
                            case .failed: what = "failed"
                            default: what = status.rawValue
                            }
                            self.shoot("\(dir)/\(self.shotPrefix)fleet-\(what).png", note: "\(name) \(status.rawValue) +0.5 s, face [\(face)], pill \(s?.pillText ?? "none")", extra: self.fleetRegion(focus: name))
                        }
                    }
                    for delay in [1.5, 2.2] {
                        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                            guard let self else { return }
                            let s = self.fleet.previewSatellite(named: name)
                            let where_ = s.map { "still here (face [\($0.sim.face.left) \($0.sim.face.right)], panel visible \($0.panel.isVisible ? 1 : 0), alpha \(String(format: "%.2f", $0.panel.alphaValue)))" } ?? "gone from the fleet"
                            print(self.stamp, "fleet: \(name) +\(delay) s \(where_) \(self.fleetCounts)")
                            fflush(stdout)
                        }
                    }
                }
            }
        }

        if let spec = env["ORB_FLEET_DRAG"] {
            let parts = spec.split(separator: "@").map { String($0).trimmingCharacters(in: .whitespaces) }
            let t = parts.count > 1 ? (Double(parts[1]) ?? 3) : 3
            let ends = parts[0].components(separatedBy: "->").map { $0.trimmingCharacters(in: .whitespaces) }
            if ends.count == 2 {
                let name = ends[0]
                DispatchQueue.main.asyncAfter(deadline: .now() + t) { [weak self] in
                    guard let self else { return }
                    var to: CGPoint?
                    if ends[1].lowercased() == "dock" {
                        if let g = NotchGeometry.current() {
                            let z = NotchGeometry.catchZoneCG(g)
                            to = CGPoint(x: z.midX, y: z.minY + z.height * 0.6)
                            print(self.stamp, String(format: "fleet drag: catch zone CG %.0f,%.0f %.0f×%.0f", z.minX, z.minY, z.width, z.height))
                        } else {
                            print(self.stamp, "fleet drag: no notch on any display (set ORB_NOTCH=1)")
                        }
                    } else {
                        let p = ends[1].split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
                        if p.count == 2 { to = CGPoint(x: p[0], y: p[1]) }
                    }
                    guard let to else { fflush(stdout); return }
                    let from = self.fleet.previewSatellite(named: name)?.body.center
                    print(self.stamp, String(format: "fleet drag: %@ from CG %@ -> %.0f,%.0f over 600 ms", name, from.map { "\(Int($0.x)),\(Int($0.y))" } ?? "?", to.x, to.y))
                    fflush(stdout)
                    let ok = self.fleet.previewDrag(name: name, to: to, ms: 600) { [weak self] in
                        guard let self else { return }
                        print(self.stamp, "fleet drag: released; sends so far thread.stop \(self.fleetSends.stop) sleep \(self.fleetSends.sleep) set-settings \(self.fleetSends.settings)")
                        fflush(stdout)
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
                            guard let self else { return }
                            let s = self.fleet.previewSatellite(named: name)
                            print(self.stamp, "fleet drag: +0.3 s \(name) \(s == nil ? "leaving / gone" : "here at CG \(Int(s!.body.center.x)),\(Int(s!.body.center.y))") \(self.fleetCounts)")
                            fflush(stdout)
                            if let dir = self.shotDir {
                                var region = self.fleetRegion(focus: nil) ?? self.orb.previewFrameCG
                                if let np = self.orb.previewNotchPanelCG { region = region.union(CGRect(x: np.minX - 40, y: 0, width: np.width + 80, height: np.maxY + 30)) }
                                self.shoot("\(dir)/\(self.shotPrefix)fleet-drag-stop.png", note: "\(name) dropped, +0.3 s, thread.stop sent \(self.fleetSends.stop)×", region: region, inProcess: true)
                            }
                        }
                    }
                    if !ok { print(self.stamp, "fleet drag: no satellite named \(name)"); fflush(stdout) }
                }
            } else {
                print("ORB_FLEET_DRAG: could not parse \(spec); want Name->dock@t or Name->x,y@t")
            }
        }

        if let spec = env["ORB_FLEET_CLICK"] {
            let parts = spec.split(separator: "@").map { String($0).trimmingCharacters(in: .whitespaces) }
            let name = parts[0]
            let t = parts.count > 1 ? (Double(parts[1]) ?? 2.5) : 2.5
            DispatchQueue.main.asyncAfter(deadline: .now() + t) { [weak self] in
                guard let self else { return }
                if let s = self.fleet.previewSatellite(named: name) {
                    print(self.stamp, "fleet click: \(name) menu items \(s.previewMenuTitles)")
                    _ = self.fleet.previewClick(name: name)
                } else {
                    print(self.stamp, "fleet click: no satellite named \(name)")
                }
                fflush(stdout)
            }
        }

        if let ms = Double(env["ORB_FLEET_BUDGET_FORCE_MS"] ?? "") {
            let forSeconds = Double(env["ORB_FLEET_BUDGET_FOR"] ?? "") ?? 4
            DispatchQueue.main.asyncAfter(deadline: .now() + fleetAt + 1.0) { [weak self] in
                guard let self else { return }
                self.fleet.forcedMs = ms
                print(self.stamp, String(format: "fleet budget: forcing +%.1f ms per frame for %.1f s (rung %d)", ms, forSeconds, self.fleet.previewRung))
                fflush(stdout)
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + fleetAt + 1.0 + forSeconds) { [weak self] in
                guard let self else { return }
                self.fleet.forcedMs = 0
                print(self.stamp, "fleet budget: load ends (rung \(self.fleet.previewRung))")
                fflush(stdout)
                for delay in [1.0, 2.0, 2.5, 3.0] {
                    DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                        guard let self else { return }
                        print(self.stamp, String(format: "fleet budget: +%.1f s after the load: rung %d mean %.2f ms; %@", delay, self.fleet.previewRung, self.fleet.previewBudgetMean, self.fleetCounts))
                        fflush(stdout)
                    }
                }
            }
        }

        // A Stop or a sleep with a fleet: the satellites must be gone within 300 ms.
        for (label, at) in [("stop", Double(env["ORB_STOP_AT"] ?? "")), ("sleep", sleepAt)] {
            guard let at else { continue }
            for delay in [0.3, 0.6] {
                DispatchQueue.main.asyncAfter(deadline: .now() + at + delay) { [weak self] in
                    guard let self else { return }
                    let visible = self.fleet.previewPanelFramesCG.count
                    print(self.stamp, String(format: "fleet after %@ +%.1f s: %@, panels showing %d", label, delay, self.fleetCounts, visible))
                    fflush(stdout)
                }
            }
        }

        // Notch mode: the peek with the dots, the island's third row, the strip with the main blob out.
        if notchMode, shotDir != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in self?.fleetNotchShot("peek") }
            DispatchQueue.main.asyncAfter(deadline: .now() + 3.4) { [weak self] in self?.fleetNotchShot("island") }
            let flyAt = Double(env["ORB_FLY_AT"] ?? "") ?? 4.6
            if flyAt < 50 {
                DispatchQueue.main.asyncAfter(deadline: .now() + flyAt + 1.4) { [weak self] in self?.fleetNotchShot("strip") }
            }
        }
    }

    private var fleetCounts: String {
        "satellites \(fleet.previewSatelliteCount) leaving \(fleet.previewLeavingCount) pool \(fleet.previewPanelPoolCount) made \(fleet.previewPanelsMade) dots \(fleet.threadDots.count)"
    }

    /// A ring where a satellite's target is, so the shots show it parked beside the point and not on it.
    private func addFleetRing(_ target: CGPoint) {
        guard !fleetRings.contains(target) else { return }
        fleetRings.append(target)
        let mainMaxY = NSScreen.screens.first?.frame.maxY ?? 0
        let ring = NSWindow(contentRect: NSRect(x: target.x - 14, y: mainMaxY - target.y - 14, width: 28, height: 28),
                            styleMask: [.borderless], backing: .buffered, defer: false)
        ring.level = .floating
        ring.isOpaque = false
        ring.backgroundColor = .clear
        ring.ignoresMouseEvents = true
        ring.hasShadow = false
        ring.isReleasedWhenClosed = false
        ring.contentView = TargetRingView(frame: NSRect(x: 0, y: 0, width: 28, height: 28))
        ring.orderFrontRegardless()
        targetWindows.append(ring)
    }

    /// The satellites' panels (or the named one's), the main panel and the targets, for framing a fleet shot.
    private func fleetRegion(focus name: String?) -> CGRect? {
        var r: CGRect?
        func include(_ x: CGRect) { r = r.map { $0.union(x) } ?? x }
        if let name, let s = fleet.previewSatellite(named: name) {
            include(CGSpace.rect(fromAppKit: s.panel.frame))
        } else {
            for f in fleet.previewPanelFramesCG { include(f) }
            for t in fleetRings { include(CGRect(x: t.x - 40, y: t.y - 40, width: 80, height: 80)) }
        }
        if !orb.previewIsTucked { include(orb.previewFrameCG) }
        return r
    }

    /// The notch shots with a fleet: the notch panel (the peek's dots, the island's line, the strip) and the satellites.
    private func fleetNotchShot(_ what: String) {
        guard let dir = shotDir, let panel = orb.previewNotchPanelCG else { return }
        var region = CGRect(x: panel.minX - 40, y: 0, width: panel.width + 80, height: panel.maxY + 30)
        if let fr = fleetRegion(focus: nil) { region = region.union(fr.insetBy(dx: -20, dy: -20)) }
        shoot("\(dir)/\(shotPrefix)fleet-notch-\(what).png",
              note: "notch \(orb.previewNotchMode), island \(orb.previewNotchIslandCG.map { "\(Int($0.width))×\(Int($0.height))" } ?? "nil"), fleet dots \(fleet.threadDots.count), notch view dots [\(orb.previewNotchThreadDots)], tucked \(orb.previewIsTucked ? 1 : 0), face [\(orb.previewFace)]",
              region: region, inProcess: true)
    }

    /// Once every satellite is parked (≥ 0.8 s after the last fleet command): each landing,
    /// the pairwise centre distances (≥ 92 pt), the distance to its target (≤ 3 body radii),
    /// the main blob's distance — and the owed shot.
    private func watchFleet(now: Double) {
        // Not before every scheduled fleet command has gone out (a trace's target is known
        // at setup; the check must not judge it before the trace is sent) and 0.8 s after the last.
        guard !fleetChecked, fleetLastCommandAt > 0, now - fleetLastCommandAt > 0.8, now - launchedAt > fleetCommandsUntil + 0.8 else { return }
        let wanted = min(BlobFleet.maxSatellites, fleetThreads.filter { $0.status.isLive }.count)
        guard fleet.previewSatelliteCount >= wanted, fleet.previewAllStill else { return }
        fleetChecked = true
        let sats = fleet.previewSatellites
        var lines: [String] = []
        var minPair = Double.infinity, maxTarget = 0.0, maxRadii = 0.0, minMain = Double.infinity
        let mainC = orb.previewCenterCG
        for (i, a) in sats.enumerated() {
            let c = a.body.center
            var line = String(format: "%@ at CG %.0f,%.0f face [%@ %@] %@", a.thread.name, c.x, c.y, String(a.sim.face.left), String(a.sim.face.right), a.previewFlightPhase)
            if let t = fleetTargets[a.id] {
                let d = hypot(c.x - t.x, c.y - t.y)
                maxTarget = max(maxTarget, d)
                maxRadii = max(maxRadii, d / a.body.radius)
                line += String(format: " target %.0f,%.0f dist %.0f (%.1f radii; %@)", t.x, t.y, d, d / a.body.radius, a.body.lastLandingNote)
            } else {
                line += " (rank slot)"
            }
            lines.append(line)
            for b in sats[(i + 1)...] { minPair = min(minPair, hypot(c.x - b.body.center.x, c.y - b.body.center.y)) }
            if !orb.previewIsTucked { minMain = min(minMain, hypot(c.x - mainC.x, c.y - mainC.y)) }
        }
        print(stamp, "fleet check:", lines.joined(separator: " | "))
        let pairOK = sats.count < 2 || minPair >= 92
        let targetOK = maxRadii <= 3
        print(stamp, String(format: "fleet check: pairwise min %@ pt (≥ 92: %@), target max %.0f pt = %.1f radii (≤ 3: %@), main-satellite min %@ pt, %@",
                            minPair.isFinite ? String(format: "%.0f", minPair) : "n/a", pairOK ? "OK" : "FAIL", maxTarget, maxRadii, targetOK ? "OK" : "FAIL",
                            minMain.isFinite ? String(format: "%.0f", minMain) : "n/a", fleetCounts))
        fflush(stdout)
        if fleetShotOwed, let dir = shotDir {
            fleetShotOwed = false
            shoot("\(dir)/\(shotPrefix)fleet-\(fleetShotName).png", note: "fleet \(fleetShotName): \(sats.map { "\($0.thread.name) [\($0.sim.face.left) \($0.sim.face.right)]" }.joined(separator: ", "))", extra: fleetRegion(focus: nil))
        }
    }

    /// The launch speed that arrives at the wall at `arrival` pt/s after `travel` pt
    /// under the body's own friction (exponential 1.4/s plus 90 pt/s² of decel), by
    /// bisection on a 60 Hz replay of that model.
    static func launchSpeed(travel: Double, arrival: Double) -> Double {
        func arrivalSpeed(_ v0: Double) -> Double {
            var v = v0, x = 0.0
            let dt = 1.0 / 60
            while x < travel, v > 0 {
                v *= exp(-BlobBody.friction * dt)
                v = max(0, v - BlobBody.decel * dt)
                x += v * dt
            }
            return x >= travel ? v : 0
        }
        var lo = 50.0, hi = 4000.0
        for _ in 0..<40 {
            let mid = (lo + hi) / 2
            if arrivalSpeed(mid) < arrival { lo = mid } else { hi = mid }
        }
        return (lo + hi) / 2
    }

    /// A synthetic drag through the panel's mouse path, logged every 0.1 s, with one
    /// shot named `shotName` once the stretch reaches `shotStretch` (or mid-sweep).
    private func runDrag(from: CGPoint, to: CGPoint, ms: Double, shotStretch: Double, shotName: String, label: String, done: (() -> Void)? = nil) {
        let c = orb.previewCenterCG
        print(stamp, String(format: "%@: hand down at CG %.0f,%.0f (body centre %.0f,%.0f), sweep to %.0f,%.0f over %.0f ms", label, from.x, from.y, c.x, c.y, to.x, to.y, ms))
        fflush(stdout)
        var lastLog = 0.0
        var shot = false
        hand = from
        orb.previewDrag(from: from, to: to, ms: ms, progress: { [weak self] u in
            guard let self else { return }
            let s = u * u * (3 - 2 * u)
            self.hand = CGPoint(x: from.x + (to.x - from.x) * s, y: from.y + (to.y - from.y) * s)
            let now = CACurrentMediaTime()
            let lag = self.orb.previewLag
            if now - lastLog > 0.1 {
                lastLog = now
                let c = self.orb.previewCenterCG
                let w = self.orb.previewWobble
                print(self.stamp, String(format: "%@ u %.2f CG %.0f,%.0f lag %.0f pt stretch %.2f wobble %.2f/%.2f speed %.0f stuck %d neck %.2f eyes [%@]", label, u, c.x, c.y,
                                         hypot(lag.dx, lag.dy), self.orb.previewStretch, w.slosh, w.mode2, self.orb.previewBodySpeed, self.orb.previewStuckCount,
                                         self.orb.previewNeck, self.orb.previewEyes))
                fflush(stdout)
            }
            if let dir = self.shotDir, !shot, self.orb.previewStretch >= shotStretch || u >= 0.55 {
                shot = true
                self.shoot("\(dir)/\(self.shotPrefix)\(shotName).png",
                           note: String(format: "%@, lag %.0f pt, stretch %.2f, speed %.0f", label, hypot(lag.dx, lag.dy), self.orb.previewStretch, self.orb.previewBodySpeed))
            }
        }, done: { [weak self] in
            guard let self else { return }
            self.hand = nil
            self.restShotTaken = false
            print(self.stamp, String(format: "%@ released: speed %.0f stretch %.2f stuck %d at CG %.0f,%.0f", label, self.orb.previewBodySpeed,
                                     self.orb.previewStretch, self.orb.previewIsStuck ? 1 : 0, self.orb.previewCenterCG.x, self.orb.previewCenterCG.y))
            fflush(stdout)
            // The jiggle after the release, every 0.1 s for a second.
            let releasedAt = CACurrentMediaTime()
            Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] timer in
                MainActor.assumeIsolated {
                    guard let self, CACurrentMediaTime() - releasedAt < 1.05 else { timer.invalidate(); return }
                    let w = self.orb.previewWobble
                    print(self.stamp, String(format: "%@ after %.1f s: wobble %.2f/%.2f stretch %.2f speed %.0f", label, CACurrentMediaTime() - releasedAt,
                                             w.slosh, w.mode2, self.orb.previewStretch, self.orb.previewBodySpeed))
                    fflush(stdout)
                }
            }
            done?()
        })
    }

    /// ORB_STICK, driven from `watch`: once the throw has parked on the wall, the stick
    /// shot; 0.8 s later the peel — a slow pull straight off the wall — with the peel
    /// shot as the neck passes `stickNeckShot`.
    private func watchStick(moving: Bool, now: Double) {
        guard let wall = stickWall else { return }
        switch stickPhase {
        case "flung":
            if moving, now - lastStickLog > 0.15 {
                lastStickLog = now
                print(stamp, String(format: "stick: speed %.0f stuck %d press %.2f", orb.previewBodySpeed, orb.previewIsStuck ? 1 : 0, orb.previewMaxPress))
                fflush(stdout)
            }
            guard !moving else { return }
            let c = orb.previewCenterCG
            print(stamp, String(format: "stick: parked at CG %.0f,%.0f stuck %d press %.2f eyes [%@]", c.x, c.y, orb.previewIsStuck ? 1 : 0, orb.previewMaxPress, orb.previewEyes))
            fflush(stdout)
            stickPhase = "stuck"
            if let dir = shotDir, !stickShotTaken {
                stickShotTaken = true
                shoot("\(dir)/\(shotPrefix)stick.png", note: String(format: "stuck to the wall, press %.2f", orb.previewMaxPress))
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
                guard let self else { return }
                let from = self.orb.previewCenterCG
                let to = CGPoint(x: from.x - wall.dx * self.stickPull, y: from.y - wall.dy * self.stickPull)
                self.stickPhase = "peeling"
                var wasStuck = true
                var lastNeckLog = 0.0
                self.hand = from
                self.orb.previewDrag(from: from, to: to, ms: 1100, progress: { [weak self] u in
                    guard let self else { return }
                    let s = u * u * (3 - 2 * u)
                    self.hand = CGPoint(x: from.x + (to.x - from.x) * s, y: from.y + (to.y - from.y) * s)
                    let now = CACurrentMediaTime()
                    let stuck = self.orb.previewIsStuck
                    if now - lastNeckLog > 0.1 || (wasStuck && !stuck) {
                        lastNeckLog = now
                        print(self.stamp, String(format: "peel: u %.2f neck %.2f stuck %d lag %.0f speed %.0f%@", u, self.orb.previewNeck, stuck ? 1 : 0,
                                                 hypot(self.orb.previewLag.dx, self.orb.previewLag.dy), self.orb.previewBodySpeed, wasStuck && !stuck ? "  <- SNAP" : ""))
                        fflush(stdout)
                    }
                    wasStuck = stuck
                    if let dir = self.shotDir, !self.peelShotTaken, self.orb.previewNeck >= self.stickNeckShot {
                        self.peelShotTaken = true
                        self.shoot("\(dir)/\(self.shotPrefix)peel.png", note: String(format: "peeling, neck %.2f", self.orb.previewNeck))
                    }
                }, done: { [weak self] in
                    guard let self else { return }
                    self.hand = nil
                    self.stickPhase = "peeled"
                    self.peeledAt = CACurrentMediaTime()
                    self.restShotTaken = false
                    print(self.stamp, String(format: "peel: released, stuck %d neck %.2f speed %.0f at CG %.0f,%.0f", self.orb.previewIsStuck ? 1 : 0,
                                             self.orb.previewNeck, self.orb.previewBodySpeed, self.orb.previewCenterCG.x, self.orb.previewCenterCG.y))
                    fflush(stdout)
                })
            }
        case "peeled":
            // The way back (or away) after the release, finely: a re-pinned stick sags
            // onto its dome over ~0.35 s, the neck shrinking with it — never a jump.
            if now - peeledAt < 1.0, now - lastStickLog > 0.05 {
                lastStickLog = now
                let c = orb.previewCenterCG
                print(stamp, String(format: "peel: after %.2f s CG %.1f,%.1f neck %.2f stuck %d speed %.0f", now - peeledAt, c.x, c.y, orb.previewNeck,
                                    orb.previewIsStuck ? 1 : 0, orb.previewBodySpeed))
                fflush(stdout)
            }
        default:
            break
        }
    }

    /// ORB_EYES: every expression side by side. Each cell pins the phase (and gate),
    /// steps the field until the eases have settled, and renders the panel's layers
    /// over the orb's own ground; labels underneath. Synchronous, so no timer can
    /// change the phase under it.
    private func renderExpressionStrip() {
        guard let dir = shotDir else { print("ORB_EYES needs ORB_SHOT_DIR"); return }
        struct Cell { let label: String; let phase: Phase; let gate: WakeGateState?; let settle: Double; let poke: Bool }
        var cellsToDraw: [Cell] = Phase.allCases.map { Cell(label: $0.rawValue, phase: $0, gate: nil, settle: 1.3, poke: false) }
        cellsToDraw += [
            Cell(label: "gate listening", phase: .asleep, gate: .listening, settle: 1.0, poke: false),
            Cell(label: "wake heard", phase: .asleep, gate: .heard, settle: 0.15, poke: false),
            Cell(label: "authenticating", phase: .asleep, gate: .authenticating(method: gateMethod), settle: 1.0, poke: false),
            Cell(label: "granted", phase: .asleep, gate: .granted, settle: 0.8, poke: false),
            Cell(label: "denied", phase: .asleep, gate: .denied(reason: "preview"), settle: 0.3, poke: false),
            Cell(label: "locked out", phase: .asleep, gate: .lockedOut(until: Date().addingTimeInterval(60)), settle: 1.0, poke: false),
            Cell(label: "poked", phase: .listening, gate: nil, settle: 0.1, poke: true),
        ]
        let size = OrbPanelController.collapsedSize
        let scale: CGFloat = 2
        let labelH: CGFloat = 22
        let perRow = 5
        let rows = (cellsToDraw.count + perRow - 1) / perRow
        let cellH = size.height + labelH
        let w = Int(size.width * CGFloat(perRow) * scale), h = Int(cellH * CGFloat(rows) * scale)
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h, bitsPerSample: 8, samplesPerPixel: 4,
                                         hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
              let gctx = NSGraphicsContext(bitmapImageRep: rep) else { print("eyes: no bitmap"); return }
        let cg = gctx.cgContext
        cg.scaleBy(x: scale, y: scale)
        cg.setFillColor(OrbPalette.ground.cgColor)
        cg.fill(CGRect(x: 0, y: 0, width: size.width * CGFloat(perRow), height: cellH * CGFloat(rows)))
        orb.previewFreeze(true)
        for (i, cell) in cellsToDraw.enumerated() {
            orb.previewSetExpression(phase: cell.phase, gate: cell.gate ?? .off(reason: "preview"))
            if cell.poke {
                orb.previewAdvanceField(1.0)
                orb.previewPoke()
            }
            orb.previewAdvanceField(cell.settle)
            // The bitmap is y-up: the first row of cells sits at the top.
            let x = CGFloat(i % perRow) * size.width
            let y = CGFloat(rows - 1 - i / perRow) * cellH
            cg.saveGState()
            cg.translateBy(x: x, y: y + labelH)
            orb.previewRender(in: cg)
            cg.restoreGState()
            // Hairlines between cells, and the label.
            cg.setFillColor(CGColor(gray: 1, alpha: 0.08))
            cg.fill(CGRect(x: x + size.width - 0.5, y: y, width: 0.5, height: cellH))
            cg.fill(CGRect(x: x, y: y + cellH - 0.5, width: size.width, height: 0.5))
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = gctx
            let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.monospacedSystemFont(ofSize: 9, weight: .medium), .foregroundColor: NSColor(white: 0.75, alpha: 1)]
            let s = cell.label as NSString
            let sw = s.size(withAttributes: attrs).width
            s.draw(at: NSPoint(x: x + (size.width - sw) / 2, y: y + 6), withAttributes: attrs)
            NSGraphicsContext.restoreGraphicsState()
            print(String(format: "eyes: %@ -> [%@]", cell.label, orb.previewEyes))
        }
        orb.previewFreeze(false)
        // Back to what the state says.
        orb.previewSetExpression(phase: state.snapshot.phase, gate: state.wakeGate)
        let path = "\(dir)/\(shotPrefix)eyes.png"
        guard let png = rep.representation(using: .png, properties: [:]) else { print("eyes: no PNG"); return }
        do {
            try png.write(to: URL(fileURLWithPath: path))
            print("shot:", path, "(expression strip, \(cellsToDraw.count) cells) rendered in-process \(w)×\(h)")
        } catch {
            print("eyes: write failed:", error)
        }
        fflush(stdout)
    }

    /// One fake gate state, as the real gate would publish it.
    private func applyGate(_ name: String) {
        gateStart = Date()
        gateShotTaken = false
        switch name {
        case "listening": state.wakeGate = .listening
        case "heard": state.wakeGate = .heard
        case "authenticating": state.wakeGate = .authenticating(method: gateMethod)
        case "granted": state.wakeGate = .granted
        case "denied": state.wakeGate = .denied(reason: "cancelled")
        case "locked": state.wakeGate = .lockedOut(until: Date().addingTimeInterval(59.6))
        default: state.wakeGate = .off(reason: "preview")
        }
        if !state.wakeGate.isListening { state.wakeHeard = "" }
        print("gate:", name)
        fflush(stdout)
    }

    private var currentGateName: String { gates.isEmpty ? "" : gates[gateIndex] }

    private func watch() {
        let now = CACurrentMediaTime()
        let moving = orb.previewIsMoving
        let frame = orb.previewFrameCG
        let phase = orb.previewFlightPhase
        // ORB_LEVELS: every number on the way from the levels to the island, twice a second.
        if !levelsOverride.isEmpty, now - lastLevelsLog >= 0.5 {
            lastLevelsLog = now
            let raw = orb.previewNotchIslandRaw.map { String(format: "%.1f,%.1f %.1f×%.1f", $0.minX, $0.minY, $0.width, $0.height) } ?? "nil"
            let c = orb.previewCenterCG
            print(stamp, "levels:", orb.previewSimLevels, "| springs", orb.previewNotchSprings.isEmpty ? "-" : orb.previewNotchSprings,
                  "| island raw", raw, "| mode", orb.previewNotchMode.isEmpty ? "-" : orb.previewNotchMode,
                  String(format: "| body CG %.1f,%.1f speed %.1f face [%@]", c.x, c.y, orb.previewBodySpeed, orb.previewFace))
            fflush(stdout)
        }
        if faceLog {
            let face = orb.previewFace
            if face != lastFace {
                print(stamp, String(format: "face: [%@] -> [%@] after %.0f ms", lastFace, face, (now - lastFaceAt) * 1000))
                fflush(stdout)
                lastFace = face
                lastFaceAt = now
            }
        }
        if phase != lastFlightPhase {
            print(stamp, String(format: "flight: %@ -> %@ at CG %.0f,%.0f speed %.0f ghosts %d", lastFlightPhase, phase, frame.midX, frame.midY,
                         orb.previewBodySpeed, orb.previewGhostFrames.count))
            fflush(stdout)
            // Stay: the hover ran out and the flight is over without a way home — where it is, is where it stays.
            if lastFlightPhase == "hovering", phase == "none", flyShotsOwed.contains("stay") {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
                    guard let self, self.flyShotsOwed.contains("stay"), let dir = self.shotDir else { return }
                    self.flyShotsOwed.remove("stay")
                    var extra: CGRect?
                    if let t = self.flyTargets.last { extra = CGRect(x: t.x - 40, y: t.y - 40, width: 80, height: 80) }
                    if let perch = self.orb.previewPerchCG {
                        let s = OrbPanelController.collapsedSize
                        let r = CGRect(x: perch.x - s.width / 2, y: perch.y - s.height / 2, width: s.width, height: s.height)
                        extra = extra.map { $0.union(r) } ?? r
                    }
                    let c = self.orb.previewCenterCG
                    self.perchMarker = self.orb.previewPerchCG
                    // Notch mode: the notch panel in frame too, empty — the blob stayed out.
                    if self.notchMode, let np = self.orb.previewNotchPanelCG { extra = extra.map { $0.union(np) } ?? np }
                    self.shoot("\(dir)/\(self.shotPrefix)\(self.notchMode ? "notch-stay" : "stay").png",
                               note: String(format: "stayed at CG %.0f,%.0f, moving %d, home %@, tucked %d, perch %@", c.x, c.y, self.orb.previewIsMoving ? 1 : 0,
                                            self.orb.previewHomeMode, self.orb.previewIsTucked ? 1 : 0,
                                            self.orb.previewPerchCG.map { "\(Int($0.x)),\(Int($0.y))" } ?? "nil"), extra: extra)
                    self.perchMarker = nil
                }
            }
            lastFlightPhase = phase
            flightPhaseSince = now
        }
        if notchMode {
            watchNotchSurface(now: now)
            let tucked = orb.previewIsTucked
            let mode = orb.previewNotchMode
            if tucked != wasTucked {
                print(stamp, String(format: "notch: %@ (flight %@, body CG %.0f,%.0f%@)", tucked ? "tucked in" : "dropped out", phase, orb.previewCenterCG.x, orb.previewCenterCG.y,
                                    tucked ? String(format: ", peak approach speed %.0f pt/s", orb.previewTimelinePeakSpeed) : ""))
                fflush(stdout)
                if !tucked { droppedOutAt = now }
                wasTucked = tucked
            }
            // The slip into the notch, mid-way: the body shrinking and fading under the ink
            // as the notch face comes up — framed with the notch. And the drop's first beat.
            let slipKind = orb.previewSlipKind, slipU = orb.previewSlipProgress
            if slipKind == "tuck" || slipKind == "drop" {
                var region = orb.previewFrameCG.insetBy(dx: -60, dy: -40)
                if let p = orb.previewNotchPanelCG { region = region.union(p) }
                let note = String(format: "%@ %.0f%%, body CG %.0f,%.0f, scale %.2f, alpha %.2f, notch mode %@, face [%@]", slipKind, slipU * 100,
                                  orb.previewCenterCG.x, orb.previewCenterCG.y, orb.previewScale, orb.previewAlpha, mode, orb.previewFace)
                var name: String?
                if slipKind == "tuck" {
                    if notchShotsOwed.contains("tuck-staging"), slipU < 0.12 { name = "tuck-staging" }
                    else if notchShotsOwed.contains("tuck-slip-mid"), slipU >= 0.3, slipU < 0.5 { name = "tuck-slip-mid" }
                    else if notchShotsOwed.contains("tuck-slip-late"), slipU >= 0.68, slipU < 0.9 { name = "tuck-slip-late" }
                } else if notchShotsOwed.contains("drop-early"), slipU >= 0.12, slipU < 0.4 {
                    name = "drop-early"
                }
                if let name, let dir = shotDir {
                    notchShotsOwed.remove(name)
                    shoot("\(dir)/\(shotPrefix)notch-\(name).png", note: note, region: region, inProcess: true)
                }
            }
            if mode != lastNotchMode {
                print(stamp, "notch: mode \(lastNotchMode.isEmpty ? "-" : lastNotchMode) -> \(mode), island CG \(orb.previewNotchIslandCG.map { "\(Int($0.width))×\(Int($0.height))" } ?? "nil")")
                fflush(stdout)
                if mode == "island" { notchIslandOpenedAt = now } else if lastNotchMode == "island" { notchIslandClosedAt = now }
                lastNotchMode = mode
            }
            // ORB_NOTCH_OPENING_SHOTS: the content caught mid-fade — two frames into the
            // open (the transport ahead of the word ahead of the buttons: the stagger) and
            // two into the close (everything leaving together on Motion.quick).
            for (kind, at) in [("opening", notchIslandOpenedAt), ("closing", notchIslandClosedAt)] where at > 0 {
                let dt = now - at
                let name = dt >= 0.04 && dt < 0.10 ? "island-\(kind)-1" : dt >= 0.10 && dt < 0.18 ? "island-\(kind)-2" : nil
                if let name, notchShotsOwed.contains(name) {
                    notchShot(name, note: String(format: "%.0f ms into the %@, mode %@", dt * 1000, kind, mode))
                }
            }
            // The hop out: the body under the notch, just after the drop, before the spring has it.
            if notchShotsOwed.contains("drop"), !tucked, phase == "outbound", now - droppedOutAt > 0.14, now - droppedOutAt < 0.6 {
                notchShotsOwed.remove("drop")
                var region = orb.previewFrameCG.insetBy(dx: -60, dy: -40)
                if let p = orb.previewNotchPanelCG { region = region.union(p) }
                shoot("\(dir(shotDir))/\(shotPrefix)notch-drop.png", note: String(format: "dropped out %.2f s ago, body CG %.0f,%.0f speed %.0f", now - droppedOutAt,
                                                                            orb.previewCenterCG.x, orb.previewCenterCG.y, orb.previewBodySpeed), region: region)
            }
        }
        if moving, now - lastLog > 0.25 {
            lastLog = now
            if phase == "none" {
                print(String(format: "body: CG %.0f,%.0f press %.2f", frame.minX, frame.minY, orb.previewMaxPress))
            } else {
                print(stamp, String(format: "body: CG %.0f,%.0f press %.2f %@ speed %.0f ghosts %d", frame.minX, frame.minY, orb.previewMaxPress,
                             phase, orb.previewBodySpeed, orb.previewGhostFrames.count))
            }
            fflush(stdout)
        }
        if wasMoving, !moving {
            print(stamp, String(format: "settled: CG %.0f,%.0f (%@) stuck %d press %.2f eyes [%@]", frame.minX, frame.minY, phase, orb.previewStuckCount, orb.previewMaxPress, orb.previewEyes))
            fflush(stdout)
        }
        wasMoving = moving
        if !stickPhase.isEmpty { watchStick(moving: moving || orb.previewIsDragging, now: now) }
        if !tracePoints.isEmpty { watchTrace(phase: phase, now: now) }
        if fleetOn { watchFleet(now: now) }

        guard let dir = shotDir else { return }
        if !traceShotsOwed.isEmpty, traceShot(phase: phase, now: now, dir: dir) { return }
        if !flyShotsOwed.isEmpty, flyShot(phase: phase, now: now, dir: dir) { return }
        if moving, squishShots < 4, orb.previewMaxPress >= shotPress, now - lastShotAt > 0.5 {
            squishShots += 1
            lastShotAt = now
            shoot("\(dir)/\(shotPrefix)squish-\(squishShots).png", note: String(format: "press %.2f", orb.previewMaxPress))
        } else if !moving, !restShotTaken, wasMoving == false, now - lastShotAt > 0.5, squishShots > 0 {
            restShotTaken = true
            shoot("\(dir)/\(shotPrefix)rest.png", note: "at rest")
        } else if !gates.isEmpty {
            // Gate shots replace the phase shots: the phase is pinned asleep.
            let delay = currentGateName == "heard" ? 0.15 : 1.2
            if !moving, !gateShotTaken, Date().timeIntervalSince(gateStart) > delay {
                gateShotTaken = true
                shoot("\(dir)/\(shotPrefix)gate-\(currentGateName)\(orb.previewIsExpanded ? "-expanded" : "").png", note: currentGateName)
            }
        } else if phaseShots, !moving, !phaseShotTaken, Date().timeIntervalSince(phaseStart) > 1.2 {
            phaseShotTaken = true
            shoot("\(dir)/\(shotPrefix)phase-\(state.snapshot.phase.rawValue).png", note: state.snapshot.phase.rawValue)
        }
    }

    /// ORB_TRACE: the drawing, every 0.25 s — the pen's progress along the stroke,
    /// where the pen and the field's tip are and how far apart they sit (the glue
    /// between the line and the blob's point), the cursor form's depth, the eyes —
    /// and the moment the line is whole.
    private func watchTrace(phase: String, now: Double) {
        guard phase == "tracing" else { return }
        let p = orb.previewTraceProgress
        let done = p.length > 0 && p.s >= p.length
        if done, !traceWasDone {
            traceWasDone = true
            let tip = orb.previewTipCG
            print(stamp, String(format: "trace: sealed %.0f pt, pen at the end, tip CG %.0f,%.0f, cursor %.2f — holding; eyes missing in %d of %d drawing frames; %d live-stroke publishes so far",
                                p.length, tip.x, tip.y, orb.previewCursorK, traceEyelessFrames, traceFrames, strokePublishes))
            fflush(stdout)
            return
        }
        if !done {
            // Every watch tick (60/s) while the line grows: the face must never blink out.
            traceFrames += 1
            if orb.previewEyes.isEmpty {
                traceEyelessFrames += 1
                if traceEyelessFrames == 1 {
                    print(stamp, String(format: "trace: no eyes this frame (%.0f%% along, speed %.0f); %@; the body:\n%@", p.length > 0 ? p.s / p.length * 100 : 0,
                                        orb.previewBodySpeed, orb.previewEyeFitNote, orb.previewCellsArt))
                    fflush(stdout)
                }
            }
        }
        guard !done, now - lastTraceLog > 0.25 else { return }
        lastTraceLog = now
        let tip = orb.previewTipCG
        let pen = orb.previewPenCG ?? tip
        // What the overlay holds of the line, per window: strokes (points of the live
        // one) — and how often its canvases painted and the line was published since
        // the last line (per second): with the layer's clock paused for a line being
        // drawn, the paints should track the publishes, not run ahead of them.
        let layer = overlay.windows.map { w in "\(w.model.strokes.count) (\(w.model.strokes.first(where: { !$0.done })?.points.count ?? 0) pts)" }.joined(separator: ", ")
        let paints = OverlayCanvasView.paintCount - lastPaintCount
        let publishes = strokePublishes - lastPublishCount
        lastPaintCount = OverlayCanvasView.paintCount
        lastPublishCount = strokePublishes
        print(stamp, String(format: "trace: %.0f/%.0f pt (%.0f%%) pen CG %.0f,%.0f tip CG %.0f,%.0f glue %.1f pt speed %.0f cursor %.2f stretch %.2f overlay [%@] paints %.0f/s publishes %.0f/s eyes [%@]",
                            p.s, p.length, p.length > 0 ? p.s / p.length * 100 : 0, pen.x, pen.y, tip.x, tip.y, hypot(pen.x - tip.x, pen.y - tip.y),
                            orb.previewBodySpeed, orb.previewCursorK, orb.previewStretch, layer, Double(paints) * 4, Double(publishes) * 4, orb.previewEyes))
        fflush(stdout)
    }
    private var lastPaintCount = 0
    private var lastPublishCount = 0

    /// The stroke's box plus the perch — and the label pill, which rides off the pen's
    /// upper right while the line grows (OverlayPainter.liveStrokeLabel) and sits above
    /// the box's top-left once sealed — for framing the trace shots.
    private var traceRegion: CGRect? {
        var r: CGRect? = nil
        func include(_ x: CGRect) { r = r.map { $0.union(x) } ?? x }
        var box: CGRect?
        if let b = orb.previewTraceBounds { box = b }
        else if let first = tracePoints.first {
            var b = CGRect(origin: first, size: .zero)
            for p in tracePoints { b = b.union(CGRect(origin: p, size: .zero)) }
            box = b
        }
        if let box { include(box.insetBy(dx: -30, dy: -30)) }
        if traceLabel != nil {
            // Wide enough for a 40-character label at 11 pt.
            let pillW: CGFloat = 320, pillH: CGFloat = 60
            if let pen = orb.previewPenCG {
                include(CGRect(x: pen.x + 18, y: pen.y - 14 - pillH, width: pillW, height: pillH + 14))
            } else if let box {
                include(CGRect(x: box.minX, y: box.minY - 10 - pillH, width: pillW, height: pillH + 10))
            }
        }
        if let perch = orb.previewPerchCG {
            let s = OrbPanelController.collapsedSize
            include(CGRect(x: perch.x - s.width / 2, y: perch.y - s.height / 2, width: s.width, height: s.height))
        }
        return r
    }

    /// The two trace shots, each once: cursor when the pen is 35–70 % along the line
    /// (the form is complete, the line half drawn), done once the line is whole and the
    /// pen still on it. Returns true when a shot was taken this tick.
    private func traceShot(phase: String, now: Double, dir: String) -> Bool {
        guard phase == "tracing" else { return false }
        let p = orb.previewTraceProgress
        guard p.length > 0 else { return false }
        let k = p.s / p.length
        let name: String
        if traceShotsOwed.contains("cursor"), k >= 0.35, k <= 0.7 {
            name = "cursor"
        } else if traceShotsOwed.contains("done"), p.s >= p.length {
            name = "done"
        } else {
            return false
        }
        traceShotsOwed.remove(name)
        lastShotAt = now
        let tip = orb.previewTipCG
        shoot("\(dir)/\(shotPrefix)trace-\(name).png",
              note: String(format: "trace %@, %.0f%% drawn, cursor %.2f, tip CG %.0f,%.0f", name, k * 100, orb.previewCursorK, tip.x, tip.y), extra: traceRegion)
        return true
    }

    /// The three fly shots, each once: outbound while it is really moving with a ghost
    /// or two behind it, hover once it has been parked 0.45 s, home 0.3 s into the
    /// drift. Framed to include the target (out, hover), the wake (out, home) and the
    /// perch (home). Returns true when a shot was taken this tick.
    private func flyShot(phase: String, now: Double, dir: String) -> Bool {
        guard flyShotsOwed.contains(phase) else { return false }
        let since = now - flightPhaseSince
        let speed = orb.previewBodySpeed
        let ghosts = orb.previewGhostFrames
        let mainMaxY = NSScreen.screens.first?.frame.maxY ?? 0
        func cg(_ r: NSRect) -> CGRect { CGRect(x: r.minX, y: mainMaxY - r.maxY, width: r.width, height: r.height) }
        var extra: CGRect?
        func include(_ r: CGRect) { extra = extra.map { $0.union(r) } ?? r }
        let target = flyTargets.last.map { CGRect(x: $0.x - 40, y: $0.y - 40, width: 80, height: 80) }
        let name: String
        switch phase {
        case "outbound":
            guard since > 0.12, speed > 500, ghosts.count >= 1 || since > 0.4 else { return false }
            name = "fly-outbound"
            if let target { include(target) }
            for g in ghosts { include(cg(g)) }
        case "hovering":
            guard since > 0.45 else { return false }
            name = "fly-hover"
            if let target { include(target) }
        case "homing":
            guard since > 0.3, speed > 150 || since > 0.8 else { return false }
            // Free mode: drifting back to the perch (fly-home, the perch in frame). Notch
            // mode: flying back up into the notch (notch-return), framed with the notch
            // panel so the way home — the menu bar band and the notch's black — shows.
            name = notchMode ? "notch-return" : "fly-home"
            for g in ghosts { include(cg(g)) }
            if notchMode, let np = orb.previewNotchPanelCG {
                include(np)
            } else if let perch = orb.previewPerchCG {
                let s = OrbPanelController.collapsedSize
                include(CGRect(x: perch.x - s.width / 2, y: perch.y - s.height / 2, width: s.width, height: s.height))
            }
        default:
            return false
        }
        flyShotsOwed.remove(phase)
        lastShotAt = now
        // The face at the shot instant, drawn glyphs and lids: a quiet drift to bed must read `- -`, not a startled `O O`.
        shoot("\(dir)/\(shotPrefix)\(name).png", note: String(format: "%@, speed %.0f, %d ghosts, face [%@], eyes [%@]", phase, speed, ghosts.count, orb.previewFace, orb.previewEyes), extra: extra)
        return true
    }

    private func dir(_ d: String?) -> String { d ?? "." }
    /// Drawn into the next in-process shot as a dashed ring ("perch"), then cleared.
    private var perchMarker: CGPoint?

    /// One of the notch shots (in-process: the hardware notch's black has no pixels to
    /// capture, and the shot is to be judged against a drawn bezel), framed on the
    /// notch panel with the island and the menu bar band.
    private func notchShot(_ name: String, note: String) {
        guard let dir = shotDir, notchShotsOwed.contains(name), let panel = orb.previewNotchPanelCG else { return }
        notchShotsOwed.remove(name)
        let region = CGRect(x: panel.minX - 40, y: 0, width: panel.width + 80, height: panel.maxY + 30)
        shoot("\(dir)/\(shotPrefix)notch-\(notchShotFileName(name))\(notchShotTag).png", note: note + ", island \(orb.previewNotchIslandCG.map { "\(Int($0.width))×\(Int($0.height))" } ?? "nil"), face [\(orb.previewFace)]", region: region, inProcess: true)
    }

    /// The scenario's own frame names: "island" → "island-marks" under ORB_NOTCH_MARKS, "island-problem-pill" and
    /// "peek-problem" under ORB_NOTCH_PROBLEM, "-question" / "-meter" / "-screenrec" / "-asleep" likewise — one
    /// scenario knob at a time, and only without ORB_NOTCH_SHOT_TAG, which names the frames itself.
    func notchShotFileName(_ base: String) -> String {
        guard !notchScenarioSuffix.isEmpty, ["tucked", "peek", "island"].contains(base) else { return base }
        if notchScenarioSuffix == "problem" { return base + "-problem" }
        return base + "-" + notchScenarioSuffix
    }

    /// Freeze everything, capture the panel plus a margin of desktop, let go.
    /// `screencapture -R` needs the Screen Recording grant for whatever launched the
    /// harness; without it (ORB_SHOT_INPROCESS=1, or when screencapture fails) the
    /// shot is drawn by this process instead — the backdrop colour, then the panel's
    /// own layer tree — which shows the orb exactly and nothing of the desktop.
    /// `extra` (CG) widens the region to take in more than the panel; `region` replaces
    /// the panel as the basis (the notch shots, where the panel is hidden).
    private func shoot(_ path: String, note: String, extra: CGRect? = nil, region: CGRect? = nil, inProcess: Bool = false) {
        orb.previewFreeze(true)
        defer { orb.previewFreeze(false) }
        var f = (region ?? orb.previewFrameCG).insetBy(dx: -48, dy: -48)
        if let extra { f = f.union(extra.insetBy(dx: -24, dy: -24)) }
        // Keep the region on the display the orb is on; a region that spills off it comes back at 1x.
        let mainMaxY = NSScreen.screens.first?.frame.maxY ?? 0
        let centre = CGPoint(x: f.midX, y: f.midY)
        if let screen = NSScreen.screens.first(where: { s in
            let cg = CGRect(x: s.frame.minX, y: mainMaxY - s.frame.maxY, width: s.frame.width, height: s.frame.height)
            return cg.contains(centre)
        }) {
            let cg = CGRect(x: screen.frame.minX, y: mainMaxY - screen.frame.maxY, width: screen.frame.width, height: screen.frame.height)
            f = f.intersection(cg)
        }
        let region = String(format: "%.0f,%.0f,%.0f,%.0f", f.minX, f.minY, f.width, f.height)
        if ProcessInfo.processInfo.environment["ORB_SHOT_INPROCESS"] != "1", !inProcess, !notchMode {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
            p.arguments = ["-x", "-R", region, path]
            do {
                try p.run()
                p.waitUntilExit()
                if p.terminationStatus == 0, FileManager.default.fileExists(atPath: path) {
                    print("shot:", path, "(\(note))", "region", region)
                    fflush(stdout)
                    return
                }
                print("screencapture failed (status \(p.terminationStatus)); capturing in-process")
            } catch {
                print("screencapture failed:", error, "; capturing in-process")
            }
        }
        renderInProcess(regionCG: f, path: path, note: note, region: region)
        fflush(stdout)
    }

    /// The region at 2×: the backdrop's colour (or the orb's dark ground), the obstacle
    /// slab if there is one, then the panel rendered from its layers.
    private func renderInProcess(regionCG f: CGRect, path: String, note: String, region: String) {
        let mainMaxY = NSScreen.screens.first?.frame.maxY ?? 0
        let regionAK = NSRect(x: f.minX, y: mainMaxY - f.maxY, width: f.width, height: f.height)
        let scale: CGFloat = 2
        let w = Int(f.width * scale), h = Int(f.height * scale)
        guard w > 0, h > 0,
              let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h, bitsPerSample: 8, samplesPerPixel: 4,
                                         hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
              let gctx = NSGraphicsContext(bitmapImageRep: rep) else { print("shot failed: no bitmap for", region); return }
        let cg = gctx.cgContext
        cg.scaleBy(x: scale, y: scale)
        let ground = backdrop?.backgroundColor ?? NSColor(srgbRed: 0x0b / 255, green: 0x0c / 255, blue: 0x10 / 255, alpha: 1)
        cg.setFillColor(ground.cgColor)
        cg.fill(CGRect(origin: .zero, size: f.size))
        if let ow = obstacleWindow {
            cg.setFillColor(ow.backgroundColor.cgColor)
            cg.fill(ow.frame.offsetBy(dx: -regionAK.minX, dy: -regionAK.minY))
        }
        // Notch mode: the menu bar band (a lighter grey, as over a dark desktop) and the
        // hardware notch's black at the top of the main display, where the region reaches them.
        if notchMode, let main = NSScreen.screens.first, let g = NotchGeometry.current() {
            let barTop = main.frame.maxY - regionAK.minY, barBottom = g.menuBarBottom - regionAK.minY
            if barTop > 0, barBottom < f.height {
                cg.setFillColor(CGColor(srgbRed: 0x2a / 255, green: 0x2b / 255, blue: 0x30 / 255, alpha: 1))
                cg.fill(CGRect(x: 0, y: barBottom, width: f.width, height: barTop - barBottom))
                cg.setFillColor(CGColor(gray: 0, alpha: 1))
                cg.fill(CGRect(x: g.notch.minX - regionAK.minX, y: g.notch.minY - regionAK.minY, width: g.notch.width, height: g.notch.height))
                // A menu bar's worth of text either side, so the island reads against something.
                NSGraphicsContext.saveGraphicsState()
                NSGraphicsContext.current = gctx
                let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 13, weight: .semibold), .foregroundColor: NSColor(white: 1, alpha: 0.9)]
                ("Finder   File   Edit   View   Go   Window   Help" as NSString).draw(at: NSPoint(x: 20 - regionAK.minX + main.frame.minX, y: barBottom + 9), withAttributes: attrs)
                NSGraphicsContext.restoreGraphicsState()
            }
        }
        // Flight targets (rings) and the wake, under the blob, as on screen.
        let acting = OrbPalette.acting
        for t in flyTargets + fleetRings {
            let c = CGPoint(x: t.x - f.minX, y: (mainMaxY - t.y) - regionAK.minY)
            cg.setStrokeColor(acting.cgColor(alpha: 0.9))
            cg.setLineWidth(2)
            cg.strokeEllipse(in: CGRect(x: c.x - 10, y: c.y - 10, width: 20, height: 20))
            cg.setFillColor(acting.cgColor(alpha: 0.9))
            cg.fillEllipse(in: CGRect(x: c.x - 2, y: c.y - 2, width: 4, height: 4))
        }
        orb.previewRenderTrail(in: cg, offset: regionAK.origin)
        // The satellites, under the main blob (their panels are ordered just below its).
        if fleetOn { fleet.previewRender(in: cg, offset: regionAK.origin) }
        if !orb.previewIsTucked || !notchMode {
            let pf = orb.previewPanelFrame
            cg.saveGState()
            cg.translateBy(x: pf.minX - regionAK.minX, y: pf.minY - regionAK.minY)
            orb.previewRender(in: cg)
            cg.restoreGState()
        }
        // The notch panel, above the menu bar, as on screen. Its view is flipped (y
        // down) and CALayer.render(in:) draws in the layer's own y-up space, so the
        // context is turned over at the panel's top edge first.
        if notchMode, let np = orb.previewNotchPanelCG {
            let npAK = NSRect(x: np.minX, y: mainMaxY - np.maxY, width: np.width, height: np.height)
            cg.saveGState()
            cg.translateBy(x: npAK.minX - regionAK.minX, y: npAK.maxY - regionAK.minY)
            cg.scaleBy(x: 1, y: -1)
            orb.previewRenderNotch(in: cg)
            cg.restoreGState()
        }
        // The perch, when the blob has left it (the stay shot): a dashed grey ring where it came from.
        if let marker = perchMarker {
            let c = CGPoint(x: marker.x - f.minX, y: (mainMaxY - marker.y) - regionAK.minY)
            cg.setStrokeColor(CGColor(gray: 0.55, alpha: 0.7))
            cg.setLineWidth(1.5)
            cg.setLineDash(phase: 0, lengths: [4, 4])
            cg.strokeEllipse(in: CGRect(x: c.x - 30, y: c.y - 30, width: 60, height: 60))
            cg.setLineDash(phase: 0, lengths: [])
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = gctx
            let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.monospacedSystemFont(ofSize: 10, weight: .medium), .foregroundColor: NSColor(white: 0.6, alpha: 1)]
            ("perch" as NSString).draw(at: NSPoint(x: c.x - 14, y: c.y - 46), withAttributes: attrs)
            NSGraphicsContext.restoreGraphicsState()
        }
        // The screen's edge, where the region reaches it: a grey hairline, so a blob
        // stuck to the border reads against something.
        if let screen = NSScreen.screens.first(where: { s in
            let cgs = CGRect(x: s.frame.minX, y: mainMaxY - s.frame.maxY, width: s.frame.width, height: s.frame.height)
            return cgs.contains(CGPoint(x: f.midX, y: f.midY))
        }) {
            let sf = screen.frame
            let vis = screen.visibleFrame
            cg.setStrokeColor(CGColor(gray: 0.55, alpha: 0.9))
            cg.setLineWidth(1)
            func line(_ a: CGPoint, _ b: CGPoint) { cg.move(to: a); cg.addLine(to: b); cg.strokePath() }
            // Work-area edges in AppKit space, relative to the region.
            if abs(vis.minX - regionAK.minX) < 1.5 || regionAK.minX <= sf.minX + 0.5 { line(CGPoint(x: 0.5, y: 0), CGPoint(x: 0.5, y: f.height)) }
            if abs(vis.maxX - regionAK.maxX) < 1.5 || regionAK.maxX >= sf.maxX - 0.5 { line(CGPoint(x: f.width - 0.5, y: 0), CGPoint(x: f.width - 0.5, y: f.height)) }
            // Not the top edge in notch mode: the drawn menu bar band is that edge, and a
            // hairline across the notch's ink would cut the island from the bezel — a seam
            // the hardware does not have.
            if !notchMode, regionAK.maxY >= vis.maxY - 0.5 { let y = vis.maxY - regionAK.minY; line(CGPoint(x: 0, y: y - 0.5), CGPoint(x: f.width, y: y - 0.5)) }
            if regionAK.minY <= vis.minY + 0.5 { let y = vis.minY - regionAK.minY; line(CGPoint(x: 0, y: y + 0.5), CGPoint(x: f.width, y: y + 0.5)) }
        }
        // The synthetic hand: a small cross where the pointer is.
        if let hand {
            let hx = hand.x - f.minX, hy = (mainMaxY - hand.y) - regionAK.minY
            cg.setStrokeColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 0.9))
            cg.setLineWidth(1.2)
            cg.move(to: CGPoint(x: hx - 6, y: hy)); cg.addLine(to: CGPoint(x: hx + 6, y: hy)); cg.strokePath()
            cg.move(to: CGPoint(x: hx, y: hy - 6)); cg.addLine(to: CGPoint(x: hx, y: hy + 6)); cg.strokePath()
            cg.strokeEllipse(in: CGRect(x: hx - 3.5, y: hy - 3.5, width: 7, height: 7))
        }
        // The overlay's layer — the line being drawn, the shapes — over everything,
        // as on screen (the overlay windows sit above the orb's panel), painted the
        // way the live windows paint it (see OverlayPreviewDemo.shoot).
        if let overlay {
            let now = Date()
            for win in overlay.windows where win.cgFrame.intersects(f) {
                let sub = f.intersection(win.cgFrame)
                guard sub.width >= 1, sub.height >= 1 else { continue }
                let origin = win.local(sub.origin)
                let canvas = Canvas(opaque: false, rendersAsynchronously: false) { ctx, _ in
                    ctx.translateBy(x: -origin.x, y: -origin.y)
                    OverlayCanvasView.paint(win.model, now: now, topInset: win.topInset, size: win.cgFrame.size, in: ctx)
                }
                .frame(width: sub.width, height: sub.height)
                let renderer = ImageRenderer(content: canvas)
                renderer.scale = scale
                renderer.isOpaque = false
                if let image = renderer.cgImage {
                    cg.draw(image, in: CGRect(x: sub.minX - f.minX, y: f.maxY - sub.maxY, width: sub.width, height: sub.height))
                }
            }
        }
        guard let png = rep.representation(using: .png, properties: [:]) else { print("shot failed: no PNG for", path); return }
        do {
            try png.write(to: URL(fileURLWithPath: path))
            print("shot:", path, "(\(note))", "region", region, "rendered in-process \(w)×\(h)")
        } catch {
            print("shot failed:", error)
        }
    }
}

// MARK: - The dock as a control surface (ORB_NOTCH_* knobs)

/// Every command the run sent, by the kinds the notch can send, and every type in the
/// order it went out (the Ask-then-stroke check reads `mark.add` before `say-text` here).
struct NotchSends {
    var sayText = 0, markRemove = 0, markWindow = 0, markClear = 0, threadStop = 0, threadAnswer = 0
    var go = 0, pause = 0, stop = 0, mute = 0, sleep = 0, requestPermission = 0, other = 0
    /// The ring's two presses (design11) — never a session, never a brain turn.
    var automationSnooze = 0, automationDone = 0
    /// The overlay's own command, counted apart: the notch never sends it.
    var markAdd = 0
    var setSettings = 0
    var all: [String] = []
    /// What `other` counted, by type.
    var otherTypes: [String] = []
    var total: Int { all.count }

    mutating func note(_ json: [String: Any]) {
        let type = json["type"] as? String ?? "?"
        all.append(type)
        switch type {
        case "say-text": sayText += 1
        case "mark.add": markAdd += 1
        case "mark.remove": markRemove += 1
        case "mark.window": markWindow += 1
        case "mark.clear": markClear += 1
        case "thread.stop": threadStop += 1
        case "thread.answer": threadAnswer += 1
        case "go": go += 1
        case "pause": pause += 1
        case "stop": stop += 1
        case "mute", "unmute": mute += 1
        case "sleep": sleep += 1
        case "request-permission": requestPermission += 1
        case "automation.snooze": automationSnooze += 1
        case "automation.done": automationDone += 1
        case "set-settings": setSettings += 1; other += 1; otherTypes.append(type)
        default: other += 1; otherTypes.append(type)
        }
    }

    var line: String {
        "notch sends: say-text \(sayText) mark.remove \(markRemove) mark.window \(markWindow) mark.clear \(markClear) thread.stop \(threadStop) thread.answer \(threadAnswer) go \(go) pause \(pause) stop \(stop) mute \(mute) sleep \(sleep) request-permission \(requestPermission) other \(other) automation.snooze \(automationSnooze) automation.done \(automationDone)"
    }
}

/// One fake mark from ORB_NOTCH_MARKS ("kind:WxH@-age[@App]").
struct FakeMarkSpec {
    let kind: String
    let size: CGSize
    let ageSeconds: Double
    let app: String?
}

extension OrbPreviewDelegate {
    /// `check: <the design's line> OK` — or `FAIL: <what was seen>`. The line's text is the
    /// design's, verbatim, so a grep for it finds the verdict.
    func check(_ ok: Bool, _ line: String, _ seen: String = "") {
        print(stamp, "check: \(line) \(ok ? "OK" : "FAIL")\(seen.isEmpty ? "" : (ok ? " (" : ": ") + seen + (ok ? ")" : ""))")
        fflush(stdout)
        if !ok { notchChecksFailed += 1 }
    }

    /// The notch view itself (for the tooltip at a point and the pixel probe): the controller's dock is private.
    var notchView: NotchView? { NSApp.windows.first { $0.title == "Jarhead notch" }?.contentView as? NotchView }
    var notchPanel: NSWindow? { NSApp.windows.first { $0.title == "Jarhead notch" } }

    /// The thread named `name` in the fake fleet, by id or name ("Slack" → "t_slack").
    func fleetThreadId(_ nameOrId: String) -> String {
        if fleetThreads.contains(where: { $0.id == nameOrId }) { return nameOrId }
        return fleetThreads.first { $0.name.lowercased() == nameOrId.lowercased() }?.id ?? nameOrId
    }

    /// The harness's press names with a thread name where the panel wants its id.
    func pressName(_ raw: String) -> String {
        let parts = raw.split(separator: ":", maxSplits: 1).map(String.init)
        guard parts.count == 2, ["thread", "threadstop"].contains(parts[0].lowercased()) else { return raw }
        return parts[0] + ":" + fleetThreadId(parts[1])
    }

    // MARK: knobs → the fake snapshot

    /// ORB_NOTCH_MARKS / QUESTION / PROBLEM / SCREEN_RECORDING / METER / REQUEST / TYPED_WAKES on the
    /// snapshot the harness feeds, before AppState sees it.
    func applyNotchSnapshotKnobs(_ snap: inout Snapshot, env: [String: String]) {
        if let spec = env["ORB_NOTCH_MARKS"] {
            fakeMarks = parseMarks(spec).map { makeFakeMark($0) }
            snap.marks = fakeMarks
        }
        if let spec = env["ORB_NOTCH_PROBLEM"] {
            let parts = spec.split(separator: ":", maxSplits: 1).map(String.init)
            snap.problems = [Self.fakeProblem(kind: parts[0], text: parts.count > 1 ? parts[1] : nil)]
        }
        if env["ORB_NOTCH_SCREEN_RECORDING"] == "0" {
            snap.permissions = Permissions(all: [PermissionInfo(kind: .screenRecording, grant: .denied, ask: .settings, required: true,
                                                                 label: "Screen Recording", why: "The hands see the screen.", checkedAt: Date().timeIntervalSince1970 * 1000)])
        }
        if let spec = env["ORB_NOTCH_METER"] {
            let v = spec.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
            if v.count == 3 {
                let nowMs = Date().timeIntervalSince1970 * 1000
                snap.session = SessionInfo(id: "sess_preview", startedAt: nowMs - v[0] * 1000, expiresAt: nowMs + 3_600_000, usageSeconds: v[1], contextRatio: 0.2)
                snap.usageToday = UsageToday(seconds: v[2], sessions: 3)
            } else {
                print("ORB_NOTCH_METER: could not parse \(spec); want elapsed,usage,today (seconds)")
            }
        }
        if let text = env["ORB_NOTCH_REQUEST"], !snap.delegations.isEmpty {
            // The delegation begins at 1.6 s, with the dock up and awake: a delegation already running when the
            // dock is built does not reach its working state (OrbPanelController's setWorking sink deduplicates).
            snap.delegations[0].request = text
            snap.delegations[0].status = .done
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { [weak self] in
                guard let self, !self.state.snapshot.delegations.isEmpty else { return }
                let nowMs = Date().timeIntervalSince1970 * 1000
                self.state.snapshot.delegations[0].status = .running
                self.state.snapshot.delegations[0].timings.delegatedAt = nowMs
                print(self.stamp, "engine: delegation running — \"\(text)\"")
                fflush(stdout)
            }
        }
        if env["ORB_NOTCH_TYPED_WAKES"] == "1" { snap.settings.typedWakes = true }
    }

    static func fakeProblem(kind: String, text: String?) -> Problem {
        let now = Date().timeIntervalSince1970 * 1000
        let words: String
        let remedy: ProblemRemedy
        if kind.hasPrefix("permission.") {
            let which = String(kind.dropFirst("permission.".count))
            words = text ?? (which == "screenRecording" ? "Screen Recording not granted: circles arrive without pixels" : "\(which) not granted")
            remedy = ProblemRemedy(label: "Request", command: ["type": .string("request-permission"), "which": .string(which)], open: nil)
        } else if kind == "dock" {
            words = text ?? "Jarhead is in the Dock twice"
            remedy = ProblemRemedy(label: "Fix the Dock", command: ["type": .string("problem.retry"), "kind": .string("dock")], open: nil)
        } else {
            words = text ?? "\(kind): something needs a look"
            remedy = ProblemRemedy(label: "Retry", command: ["type": .string("problem.retry"), "kind": .string(kind)], open: nil)
        }
        return Problem(kind: kind, text: words, remedy: remedy, since: now - 20_000)
    }

    func parseMarks(_ spec: String) -> [FakeMarkSpec] {
        spec.split(separator: ";").compactMap { entry -> FakeMarkSpec? in
            let raw = entry.trimmingCharacters(in: .whitespaces)
            guard !raw.isEmpty else { return nil }
            let at = raw.split(separator: "@", omittingEmptySubsequences: false).map(String.init)
            let head = at[0].split(separator: ":").map { String($0).trimmingCharacters(in: .whitespaces) }
            guard head.count == 2 else { print("ORB_NOTCH_MARKS: could not parse \(raw); want kind:WxH@-age[@App]"); return nil }
            let wh = head[1].lowercased().split(separator: "x").compactMap { Double($0) }
            guard wh.count == 2 else { print("ORB_NOTCH_MARKS: bad size in \(raw)"); return nil }
            let age = at.count > 1 ? abs(Double(at[1]) ?? 0) : 0
            let app = at.count > 2 && !at[2].isEmpty ? at[2] : nil
            return FakeMarkSpec(kind: head[0].lowercased(), size: CGSize(width: wh[0], height: wh[1]), ageSeconds: age, app: app)
        }
    }

    /// One `ScreenMark` as the engine would carry it: `used` is consumed, `capturing` has no crop
    /// yet, `window` is the front window whole (source "window", element role window); the crop is
    /// a dithered PNG written here, at 2×, so the thumbnail path decodes something real.
    func makeFakeMark(_ s: FakeMarkSpec) -> ScreenMark {
        fakeMarkCount += 1
        let n = fakeMarkCount
        let id = "mark_" + s.kind + (fakeMarkIds.contains("mark_" + s.kind) ? "\(n)" : "")
        fakeMarkIds.insert(id)
        let nowMs = Date().timeIntervalSince1970 * 1000
        let rect = Rect(x: 400 + Double(n) * 24, y: 260 + Double(n) * 18, w: s.size.width, h: s.size.height)
        let consumed = s.kind == "used"
        let capturing = s.kind == "capturing"
        let window = s.kind == "window"
        var element: ScreenMark.MarkElement?
        if window {
            element = ScreenMark.MarkElement(role: "window", title: "\(s.app ?? "Safari") — Jarhead", app: s.app ?? "Safari")
        } else if let app = s.app {
            element = ScreenMark.MarkElement(role: "button", title: "Send", app: app)
        }
        var mark = ScreenMark(id: id, rect: rect, path: nil, at: nowMs - s.ageSeconds * 1000, screenshotPath: nil, consumed: consumed, element: element, source: window ? "window" : nil)
        if !capturing { mark.screenshotPath = writeMarkPNG(id: id, size: s.size) }
        return mark
    }

    /// The crop on disk: a dithered ramp, the mark's aspect, a quarter of its points at 2×.
    func writeMarkPNG(id: String, size: CGSize) -> String? {
        let base = markPNGDir ?? {
            let dir = URL(fileURLWithPath: shotDir ?? (ProcessInfo.processInfo.environment["TMPDIR"] ?? "/tmp")).appendingPathComponent("jarhead-orb-preview-marks", isDirectory: true)
            try? FileManager.default.createDirectory(at: dir.appendingPathComponent("shots"), withIntermediateDirectories: true)
            markPNGDir = dir
            state.stateDir = dir
            return dir
        }()
        let pts = CGSize(width: max(24, size.width / 4), height: max(16, size.height / 4))
        guard let img = Dither.gradientImage(size: pts, scale: 2, stops: Dither.orbStops, direction: .diagonal) else { return nil }
        let rep = NSBitmapImageRep(cgImage: img)
        guard let png = rep.representation(using: .png, properties: [:]) else { return nil }
        let rel = "shots/\(id).png"
        do {
            try png.write(to: base.appendingPathComponent(rel))
        } catch {
            print("mark png: write failed:", error)
            return nil
        }
        return rel
    }

    /// The fake engine's marks list is the snapshot's: replace it and let AppState publish.
    func publishFakeMarks() {
        state.snapshot.marks = fakeMarks
    }

    /// A pending circle lands in the fake snapshot, as after a ⌥⇧C stroke (ORB_NOTCH_MARK_LANDS_AT and the `mark.add` reply).
    @discardableResult
    func landFakeMark(rect: Rect, source: String? = nil, element: ScreenMark.MarkElement? = nil, withCropAfter delay: Double?) -> String {
        fakeMarkCount += 1
        let id = "mark_new\(fakeMarkCount)"
        fakeMarkIds.insert(id)
        let nowMs = Date().timeIntervalSince1970 * 1000
        let mark = ScreenMark(id: id, rect: rect, path: nil, at: nowMs, screenshotPath: nil, consumed: false, element: element, source: source)
        fakeMarks.append(mark)
        if fakeMarks.count > 6 { fakeMarks.removeFirst(fakeMarks.count - 6) }
        publishFakeMarks()
        if let delay {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self, let i = self.fakeMarks.firstIndex(where: { $0.id == id }) else { return }
                self.fakeMarks[i].screenshotPath = self.writeMarkPNG(id: id, size: CGSize(width: rect.w, height: rect.h))
                self.publishFakeMarks()
                print(self.stamp, "engine: crop landed for \(id)")
                fflush(stdout)
            }
        }
        return id
    }

    /// What the engine does with a command, as far as the dock can see it: a mark lands
    /// after `mark.add` (its crop a beat later, and the `orb.trace` echo with reason "mark"),
    /// leaves on `mark.remove` / `mark.clear`, the front window lands on `mark.window` with
    /// its toast, a scripted Sleep box press puts the phase to sleep.
    func fakeEngine(_ json: [String: Any]) {
        guard notchMode else { return }
        switch json["type"] as? String {
        case "mark.add":
            guard let r = json["rect"] as? [String: Any], let x = r["x"] as? Double, let y = r["y"] as? Double, let w = r["w"] as? Double, let h = r["h"] as? Double else { return }
            let rect = Rect(x: x, y: y, w: w, h: h)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
                guard let self else { return }
                let id = self.landFakeMark(rect: rect, withCropAfter: 1.0)
                print(self.stamp, "engine: mark \(id) registered (\(Int(w))×\(Int(h))), crop on its way")
                fflush(stdout)
                guard self.notchEchoTrace else { return }
                // The engine's echo: the blob outlines what was circled (reason "mark").
                let pts = [Point2(x: x, y: y), Point2(x: x + w, y: y), Point2(x: x + w, y: y + h), Point2(x: x, y: y + h)]
                self.markTraceSentAt = CACurrentMediaTime()
                self.markTraceTuckedBefore = self.orb.previewIsTucked
                self.state.overlayCommands.send(.orbTrace(points: pts, closed: true, label: nil, ttlMs: 2500, tone: .mark, reason: "mark", thread: nil))
                print(self.stamp, "engine: orb.trace echo (reason mark) for \(id); tucked before \(self.orb.previewIsTucked ? 1 : 0), homeAfterTrace \(self.orb.previewHomeAfterTrace ? 1 : 0)")
                fflush(stdout)
            }
        case "mark.remove":
            let id = json["id"] as? String ?? ""
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
                guard let self else { return }
                self.fakeMarks.removeAll { $0.id == id }
                self.publishFakeMarks()
            }
        case "mark.clear":
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
                guard let self else { return }
                self.fakeMarks.removeAll()
                self.publishFakeMarks()
            }
        case "mark.window":
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
                guard let self else { return }
                let id = self.landFakeMark(rect: Rect(x: 120, y: 60, w: 1280, h: 800), source: "window",
                                           element: ScreenMark.MarkElement(role: "window", title: "Safari — Jarhead", app: "Safari"), withCropAfter: 0.4)
                self.state.toast("Captured Safari · 1280×800")
                print(self.stamp, "engine: window mark \(id) (Safari 1280×800), toast")
                fflush(stdout)
            }
        case "sleep":
            guard notchEngineSleeps else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
                guard let self else { return }
                self.state.snapshot.phase = .asleep
                self.phaseStart = Date()
                print(self.stamp, "engine: phase -> asleep (the Sleep box)")
                fflush(stdout)
            }
        default:
            break
        }
    }

    // MARK: the script

    /// The scenario knobs, scheduled: presses, the field, the stroke, the trace, the landing,
    /// the pill test, the phase sweep; the shot names the scenario earns.
    func setUpNotchSurface(env: [String: String]) {
        notchEchoTrace = env["ORB_NOTCH_TRACE_ECHO"] != "0"
        // The hotkey's dispatch, as AppDelegate wires it — recording the dock's state the moment mark mode is asked for.
        state.beginMarkModeHandler = { [weak self] in
            guard let self else { return }
            self.beginMarkModeCalls += 1
            self.foldAtBeginMark = (self.orb.previewNotchPinned, self.orb.previewNotchMode, self.orb.previewNotchIgnoresMouse)
            print(self.stamp, "beginMarkMode() #\(self.beginMarkModeCalls): dock pinned \(self.orb.previewNotchPinned ? 1 : 0) mode \(self.orb.previewNotchMode) ignoresMouse \(self.orb.previewNotchIgnoresMouse ? 1 : 0)")
            fflush(stdout)
            self.overlay.beginMarkMode()
        }
        state.openThreadHandler = { [weak self] id in
            guard let self else { return }
            self.openThreadCalls += 1
            print(self.stamp, "openThread(\(id))")
            fflush(stdout)
        }

        // Shots: the scenario names its own frames when no tag was given and one knob is on.
        let scenarioKnobs: [(String, String)] = [("ORB_NOTCH_MARKS", "marks"), ("ORB_NOTCH_MARK_LANDS_AT", "marks"), ("ORB_NOTCH_QUESTION", "question"),
                                                 ("ORB_NOTCH_PROBLEM", "problem"), ("ORB_NOTCH_METER", "meter"), ("ORB_NOTCH_SCREEN_RECORDING", "screenrec"),
                                                 ("ORB_NOTCH_TYPE", "say")]
        var suffixes = Set(scenarioKnobs.filter { env[$0.0] != nil }.map(\.1))
        if env["ORB_NOTCH_SCREEN_RECORDING"] != nil { suffixes.remove("problem") }
        if env["ORB_NOTCH_PHASE"] == "asleep" { suffixes = ["asleep"] }
        if notchShotTag.isEmpty, suffixes.count == 1, let s = suffixes.first { notchScenarioSuffix = s }

        let presses = (env["ORB_NOTCH_PRESS"] ?? "").split(separator: ";").compactMap { entry -> (String, Double)? in
            let parts = entry.split(separator: "@").map { String($0).trimmingCharacters(in: .whitespaces) }
            guard parts.count == 2, let t = Double(parts[1]), !parts[0].isEmpty else { if !entry.isEmpty { print("ORB_NOTCH_PRESS: could not parse \(entry); want what@t") }; return nil }
            return (parts[0], t)
        }
        notchEngineSleeps = presses.contains { $0.0.lowercased() == "sleep" }
        for (name, t) in presses {
            DispatchQueue.main.asyncAfter(deadline: .now() + t) { [weak self] in self?.notchPress(name) }
        }
        if let spec = env["ORB_NOTCH_ACTIVE"], let t = spec == "1" ? 3.0 : Double(spec) {
            DispatchQueue.main.asyncAfter(deadline: .now() + t) { [weak self] in
                guard let self else { return }
                NSApp.activate(ignoringOtherApps: true)
                // macOS 14+ may ignore the deprecated call while another app is frontmost: the running-application route once more.
                if !NSApp.isActive { NSRunningApplication.current.activate(options: [.activateIgnoringOtherApps]) }
                print(self.stamp, "app: activate -> isActive \(NSApp.isActive ? 1 : 0) (pretending Jarhead's own window is frontmost)")
                fflush(stdout)
            }
        }
        if let spec = env["ORB_NOTCH_TYPE"] {
            let parts = spec.split(separator: "@").map(String.init)
            if let t = Double(parts.last ?? "") {
                let text = parts.dropLast().joined(separator: "@")
                DispatchQueue.main.asyncAfter(deadline: .now() + t) { [weak self] in self?.notchFieldScript(text: text) }
            } else {
                print("ORB_NOTCH_TYPE: could not parse \(spec); want text@t")
            }
        }
        if let t = Double(env["ORB_NOTCH_ESC_AT"] ?? "") {
            DispatchQueue.main.asyncAfter(deadline: .now() + t) { [weak self] in self?.notchEscape() }
        }
        if let t = Double(env["ORB_NOTCH_RETURN_AT"] ?? "") {
            DispatchQueue.main.asyncAfter(deadline: .now() + t) { [weak self] in self?.notchBareReturn() }
        }
        if let t = Double(env["ORB_NOTCH_PIN_AT"] ?? "") {
            DispatchQueue.main.asyncAfter(deadline: .now() + t) { [weak self] in
                guard let self else { return }
                self.ensureIslandOpen()
                self.orb.previewNotchPress("face")
                self.pinnedBeforeCircle = self.orb.previewNotchPinned
                print(self.stamp, "notch: pin (a .face press) -> pinned \(self.orb.previewNotchPinned ? 1 : 0), mode \(self.orb.previewNotchMode)")
                fflush(stdout)
            }
        }
        // ORB_NOTCH_KIND_AT="question@3.6": the forced kind changes with the island open; `watch` samples the beats.
        if let spec = env["ORB_NOTCH_KIND_AT"] {
            let parts = spec.split(separator: "@").map { String($0).trimmingCharacters(in: .whitespaces) }
            if parts.count == 2, let t = Double(parts[1]) {
                DispatchQueue.main.asyncAfter(deadline: .now() + t) { [weak self] in
                    guard let self else { return }
                    // The pointer is back on the island (the script's leaves at ~3.9 s; this cancels the 600 ms contraction).
                    self.orb.previewNotchHover(true)
                    let before = self.orb.previewNotchCanvasKind
                    self.orb.previewNotchSetKind(parts[0])
                    self.kindSwapAt = CACurrentMediaTime()
                    self.kindSwapSamples = []
                    print(self.stamp, "notch: kind \(before) -> \(self.orb.previewNotchCanvasKind) with the island \(self.orb.previewNotchMode)")
                    fflush(stdout)
                }
            } else {
                print("ORB_NOTCH_KIND_AT: could not parse \(spec); want kind@t")
            }
        }
        // ORB_NOTCH_LINE_AT="text@t": a transcript line lands with the island open; 0.3 s later the hero must have swapped
        // once, animated (old ≠ new, the new the line) — after a kind change's window too, not only before the first.
        if let spec = env["ORB_NOTCH_LINE_AT"] {
            let parts = spec.split(separator: "@").map { String($0).trimmingCharacters(in: .whitespaces) }
            if parts.count == 2, let t = Double(parts[1]) {
                DispatchQueue.main.asyncAfter(deadline: .now() + t) { [weak self] in self?.heroLineLands(parts[0]) }
            } else {
                print("ORB_NOTCH_LINE_AT: could not parse \(spec); want text@t")
            }
        }
        if let t = Double(env["ORB_NOTCH_CIRCLE_AT"] ?? "") {
            DispatchQueue.main.asyncAfter(deadline: .now() + t) { [weak self] in self?.notchPress("circle") }
            DispatchQueue.main.asyncAfter(deadline: .now() + t + 0.4) { [weak self] in self?.notchStroke() }
        }
        if let t = Double(env["ORB_NOTCH_STROKE_AT"] ?? "") {
            DispatchQueue.main.asyncAfter(deadline: .now() + t) { [weak self] in self?.notchStroke() }
        }
        if let t = Double(env["ORB_NOTCH_HOTKEY_CIRCLE_AT"] ?? "") {
            DispatchQueue.main.asyncAfter(deadline: .now() + t) { [weak self] in
                guard let self else { return }
                self.ensureIslandOpen()
                let before = self.notchSends.total
                print(self.stamp, "hotkey ⌥⇧C (state.beginMarkMode) with the island \(self.orb.previewNotchMode)")
                self.state.beginMarkMode()
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
                    guard let self else { return }
                    let ok = self.orb.previewNotchMarking && !self.orb.previewNotchPinned && self.orb.previewNotchMode == "peek" && self.orb.previewNotchIgnoresMouse && self.notchSends.total == before
                    self.check(ok, "⌥⇧C while island open → same fold (marking sink), 0 notch sends",
                               "marking \(self.orb.previewNotchMarking ? 1 : 0) pinned \(self.orb.previewNotchPinned ? 1 : 0) mode \(self.orb.previewNotchMode) ignoresMouse \(self.orb.previewNotchIgnoresMouse ? 1 : 0) sends +\(self.notchSends.total - before)")
                }
            }
        }
        if let spec = env["ORB_NOTCH_TRACE_AT"] {
            for entry in spec.split(separator: ";") {
                let parts = entry.split(separator: ":", maxSplits: 1).map { String($0).trimmingCharacters(in: .whitespaces) }
                guard let t = Double(parts[0]) else { print("ORB_NOTCH_TRACE_AT: could not parse \(entry); want t[:reason]"); continue }
                let reason = parts.count > 1 ? parts[1] : "mark"
                DispatchQueue.main.asyncAfter(deadline: .now() + t) { [weak self] in self?.notchTrace(reason: reason) }
            }
        }
        if let t = Double(env["ORB_NOTCH_MARK_LANDS_AT"] ?? "") {
            DispatchQueue.main.asyncAfter(deadline: .now() + t) { [weak self] in
                guard let self else { return }
                let id = self.landFakeMark(rect: Rect(x: 500, y: 300, w: 320, h: 200), element: ScreenMark.MarkElement(role: "button", title: "Send", app: "Slack"), withCropAfter: 0.8)
                print(self.stamp, "engine: \(id) landed while tucked \(self.orb.previewIsTucked ? 1 : 0) (mode \(self.orb.previewNotchMode))")
                fflush(stdout)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
                    guard let self else { return }
                    let glow = self.orb.previewNotchLipGlow, chip = self.orb.previewNotchLipChip
                    let pill = self.orb.previewNotchPillText, kind = self.orb.previewNotchPillKind
                    self.lipAtLanding = (glow, chip, pill, kind)
                    print(self.stamp, "lip: glow \(glow) chip '\(chip)' pill '\(pill)' (\(kind))")
                    fflush(stdout)
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 6.4) { [weak self] in
                    guard let self else { return }
                    let after = self.orb.previewNotchPillText
                    let l = self.lipAtLanding
                    let n = self.orb.previewDockContent.pendingMarks
                    let ok = l.glow == "mark" && l.chip == "◎\(n)" && l.pill == "◎ \(n) circled · Go to ask" && l.kind == "mark-landed" && after.isEmpty
                    self.check(ok, "tucked + pending marks → lip glow mark tone, lip chip ◎N; pill \"◎ 1 circled · Go to ask\" 6 s after landing, gone after",
                               "glow \(l.glow) chip '\(l.chip)' pill '\(l.pill)' (\(l.kind)); +6.4 s pill '\(after)'")
                }
            }
        }
        if env["ORB_NOTCH_PILL_TEST"] == "1" { notchPillTest() }
        notchRingScript(env: env)
        if let t = Double(env["ORB_NOTCH_PHASE_SWEEP"] ?? "") {
            DispatchQueue.main.asyncAfter(deadline: .now() + t) { [weak self] in self?.notchPhaseSweep() }
        }
        notchOpenTiming = env["ORB_NOTCH_OPEN_TIMING"] == "1"
        if notchOpenTiming {
            // Scheduled after the script's own hover at the same deadline (FIFO): the clock starts as the pointer arrives.
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.7) { [weak self] in
                guard let self else { return }
                self.notchOpenHoverAt = CACurrentMediaTime()
                self.notchOpenHitAt0 = self.orb.previewNotchHitList.count
                let hover = self.notchOpenHoverAt
                // The spring steps once per display frame: the crossing is placed between the last frame
                // under the mark and the first at or over it (linear), not at the sampler's tick.
                var last = (t: 0.0, open: 0.0)
                let t = Timer.scheduledTimer(withTimeInterval: 0.001, repeats: true) { [weak self] timer in
                    MainActor.assumeIsolated {
                        guard let self else { timer.invalidate(); return }
                        let now = CACurrentMediaTime() - hover
                        let open = Self.openValue(self.orb.previewNotchSprings)
                        func crossing(_ mark: Double) -> Double {
                            guard open > last.open else { return now }
                            return last.t + (now - last.t) * (mark - last.open) / (open - last.open)
                        }
                        if self.notchOpenHalfAt < 0, open >= 0.5 { self.notchOpenHalfAt = crossing(0.5) }
                        if self.notchOpenNineAt < 0, open >= 0.9 { self.notchOpenNineAt = crossing(0.9) }
                        if open != last.open { last = (now, open) }
                        if now > 0.6 { timer.invalidate() }
                    }
                }
                self.timers.append(t)
            }
        }
        if let spec = env["ORB_NOTCH_HOVER"] {
            DispatchQueue.main.asyncAfter(deadline: .now() + 3.3) { [weak self] in
                guard let self else { return }
                let tip: String
                if spec == "meter", let v = self.notchView {
                    tip = v.previewTooltip(atIsland: NSPoint(x: 200, y: 168))
                } else {
                    tip = self.orb.previewNotchTooltip(self.pressName(spec))
                }
                print(self.stamp, "notch hover \(spec): tooltip \"\(tip)\"")
                fflush(stdout)
            }
        }

        // The island's fixed rules, read with it open at 3.4 s (the script's hover), and the scenario's own lines.
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.55) { [weak self] in self?.notchPeekChecks(env: env) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.45) { [weak self] in self?.notchIslandChecks(env: env) }
    }

    /// The pointer's approach, when the island is not open already (the harness never moves the real pointer).
    func ensureIslandOpen() {
        if orb.previewNotchMode != "island" { orb.previewNotchHover(true) }
    }

    /// One scripted press on the island, with what it sent and what it shows afterwards; the
    /// checks that hang off a press print 0.2 s later, once the fake engine has answered.
    func notchPress(_ raw: String) {
        let name = pressName(raw)
        ensureIslandOpen()
        let before = notchSends.total
        let beginBefore = beginMarkModeCalls
        let consoleBefore = openConsoleCalls
        let threadBefore = openThreadCalls
        let active = NSApp.isActive
        let awake = orb.previewDockContent.awake
        let content = orb.previewDockContent
        let hittable = orb.previewNotchHitList.contains { $0.name == name }
        let dim = orb.previewNotchBoxDim(name)
        let tooltip = orb.previewNotchTooltip(name)
        // Read at the press, carried to its check: a second press 200 ms later must not overwrite them.
        let pressAt = CACurrentMediaTime()
        let dead = orb.previewNotchMiddleDead
        let pressed = orb.previewNotchPress(name)
        print(stamp, "notch press \(raw)\(raw == name ? "" : " (\(name))"): hittable \(hittable ? 1 : 0) pressed \(pressed ? 1 : 0) dim \(String(format: "%.2f", dim)) awake \(awake ? 1 : 0) mode \(orb.previewNotchMode)")
        if !hittable { print(stamp, "  hit list: \(orb.previewNotchHitList.map(\.name)); thread chips \(orb.previewNotchThreadChips); store \(state.threads.count) rows \(content.threads.map(\.id))") }
        fflush(stdout)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
            guard let self else { return }
            let sent = Array(self.notchSends.all.dropFirst(before))
            let pill = self.orb.previewNotchPillText
            print(self.stamp, "  -> \(raw): sent \(sent.isEmpty ? "nothing" : sent.joined(separator: ", ")); pill '\(pill)' (\(self.orb.previewNotchPillKind)); beginMarkMode +\(self.beginMarkModeCalls - beginBefore) openConsole +\(self.openConsoleCalls - consoleBefore) openThread +\(self.openThreadCalls - threadBefore)")
            fflush(stdout)
            self.lastPressAt = pressAt
            self.lastPressDead = dead
            self.pressChecks(raw: raw, name: name, sent: sent, pill: pill, hittable: hittable, dim: dim, tooltip: tooltip, active: active, awake: awake, content: content,
                             beginMarkMode: self.beginMarkModeCalls - beginBefore, openConsole: self.openConsoleCalls - consoleBefore, openThread: self.openThreadCalls - threadBefore)
        }
    }

    /// The check lines a press earns, by what was pressed and the state it was pressed in.
    private func pressChecks(raw: String, name: String, sent: [String], pill: String, hittable: Bool, dim: CGFloat, tooltip: String, active: Bool, awake: Bool, content: DockContent,
                             beginMarkMode: Int, openConsole: Int, openThread: Int) {
        let head = name.split(separator: ":").first.map(String.init) ?? name
        let counted = notchSends
        // The consent boxes' dead-time: a press in the Allow / Deny rects inside 500 ms of a kind change lands nowhere.
        let firstAfterFlip = ["allow", "deny"].contains(head) && deadTimePressWanted && pendingQuestion == nil
        if ["allow", "deny", "done", "snooze"].contains(head), lastPressDead || firstAfterFlip {
            deadTimePressWanted = false
            let since = ringKindChangeAt >= 0 ? String(format: "%.0f ms", (lastPressAt - ringKindChangeAt) * 1000) : "?"
            check(lastPressDead && sent.isEmpty && hittable, "press \(head) within 500 ms of a kind change → 0 sends (the consent boxes' dead-time); thread.answer untouched",
                  "hittable \(hittable ? 1 : 0) dead \(lastPressDead ? 1 : 0); sent \(sent.isEmpty ? "nothing" : sent.joined(separator: ", ")); the kind changed \(since) before the press; thread.answer so far \(counted.threadAnswer)")
            return
        }
        switch head {
        case "snooze":
            let minutes = Int(name.split(separator: ":").last.map(String.init) ?? "") ?? -1
            let ok = sent == ["automation.snooze"] && lastSnooze?.id == Self.ringId && lastSnooze?.minutes == minutes && counted.go == 0 && counted.sayText == 0 && counted.threadAnswer == 0
            var snoozed = "none"
            if let s = lastSnooze { snoozed = "\(s.id) \(s.minutes) min" }
            check(ok, "press snooze:10 → automation.snooze 1 (the ringing row, 10 minutes); go 0, say-text 0, thread.answer 0",
                  "sent \(sent); snooze \(snoozed); run totals go \(counted.go) say-text \(counted.sayText) thread.answer \(counted.threadAnswer)")
        case "done":
            let ok = sent == ["automation.done"] && lastDone == Self.ringId && counted.go == 0 && counted.threadAnswer == 0
            check(ok, "press done → automation.done 1 (the ringing row); go 0, thread.answer 0",
                  "sent \(sent); done '\(lastDone)'; run totals go \(counted.go) thread.answer \(counted.threadAnswer)")
        case "circle":
            let f = foldAtBeginMark
            let ok = sent.isEmpty && f != nil && f?.pinned == false && f?.mode == "peek" && f?.ignoresMouse == true
            check(ok, "circle press sent 0 commands; fold before beginMarkMode (pinned 0, mode peek, ignoresMouse 1)",
                  "sent \(sent.count); at beginMarkMode: " + (f.map { "pinned \($0.pinned ? 1 : 0) mode \($0.mode) ignoresMouse \($0.ignoresMouse ? 1 : 0)" } ?? "never called"))
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
                guard let self else { return }
                self.notchShot("peek-marking", note: "marking: island folded, mode \(self.orb.previewNotchMode), chips \(self.orb.previewNotchChips)")
                let chips = self.orb.previewNotchChips
                let n = NotchGeometry.current()?.notch.width ?? 185
                let target = self.orb.previewNotchPeekWidthTarget
                let extra = self.orb.previewNotchChipsExtraWidth
                // The peek's width is notch + counter + dots + chips (no breath in an acting phase: the fake levels are
                // silent). Before marking (2.55 s) that gives the counter's width; marking must keep it and drop the dots.
                // The peek never grows past the island's width, so the expected target is that clamp of
                // notch + counter + the marking chip: with the counter on it reads 360 (322 without it), and
                // with the dots gone it reads 322 when no counter runs (343 with them).
                let before = self.peekBefore
                let counterBefore = max(0, before.target - n - before.dots - before.chips)
                let expected = min(NotchGeometry.peekWidthCap, n + counterBefore + extra)
                let ok = chips == ["marking:Circle something · Esc"] && self.orb.previewNotchMode == "peek" && self.orb.previewNotchMarking
                    && abs(target - expected) < 1.5
                self.check(ok, "marking → peek \"◎ Circle something · Esc\", dots and chips hidden, counter kept",
                           "chips \(chips) mode \(self.orb.previewNotchMode); peek target \(Int(target)) (expected min(360, notch \(Int(n)) + counter \(Int(counterBefore)) + chip \(Int(extra))) = \(Int(expected)); before marking the peek was \(Int(before.target)) with dots \(Int(before.dots)) for [\(self.orb.previewNotchThreadDots)])")
            }
        case "window":
            if active {
                windowActiveResult = (sent, pill)
            } else {
                windowInactiveResult = sent
            }
            if let ia = windowInactiveResult, let ac = windowActiveResult {
                let ok = ia == ["mark.window"] && ac.sent.isEmpty && ac.pill == "Bring a window forward first"
                check(ok, "window press, app inactive → mark.window 1; app active → 0 sends, pill \"Bring a window forward first\"",
                      "inactive sent \(ia); active sent \(ac.sent) pill '\(ac.pill)'")
            } else if active {
                print(stamp, "  (window pressed active only; the inactive half of its check needs a press before ORB_NOTCH_ACTIVE)")
            } else {
                print(stamp, "  (window pressed inactive only; the active half of its check needs ORB_NOTCH_ACTIVE=t and a later press)")
            }
        case "ask":
            if !awake {
                if content.typedWakes {
                    let ok = tooltip.contains("wakes · billed") && sent == ["say-text"]
                    check(ok, "ask, asleep, typedWakes 1 → tooltip contains \"wakes · billed\"; press → say-text 1", "tooltip '\(tooltip)' sent \(sent)")
                } else {
                    let ok = abs(dim - 0.35) < 0.01 && !hittable && sent.isEmpty
                    check(ok, "ask, asleep, typedWakes 0 → α 0.35, not in hit list, sends 0", "dim \(String(format: "%.2f", dim)) hittable \(hittable ? 1 : 0) sent \(sent)")
                }
            } else if content.pendingMarks > 0 {
                let newestWindow = content.marks.last(where: { !$0.consumed })?.isWindow ?? false
                let said = lastSayText
                if newestWindow {
                    let ok = sent == ["say-text"] && said == "What's in this window?"
                    check(ok, "ask, in session, newest pending is a window → say-text \"What's in this window?\" 1", "sent \(sent) text '\(said)'")
                } else {
                    let ok = sent == ["say-text"] && said == "What did I circle?" && beginMarkMode == 0
                    check(ok, "ask, in session, marks pending → say-text \"What did I circle?\" 1, beginMarkMode 0", "sent \(sent) text '\(said)' beginMarkMode \(beginMarkMode)")
                }
            } else {
                askWaitsForStroke = (beginMarkMode, sent.count, notchSends.total)
                if askStrokeChecked { return }
                print(stamp, "  ask with nothing circled: beginMarkMode \(beginMarkMode), sent \(sent.count) — the stroke (ORB_NOTCH_STROKE_AT) completes this check")
            }
        case "clear":
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
                guard let self else { return }
                let n = content.marks.count
                let absent = !self.orb.previewNotchHitList.contains { $0.name == "clear" }
                let ok = sent == ["mark.clear"] && pill == "Cleared · \(n)" && absent && self.orb.previewDockContent.marks.isEmpty
                self.check(ok, "clear → mark.clear 1, pill \"Cleared · 3\"; Clear box absent when marks empty",
                           "sent \(sent) pill '\(pill)' marks now \(self.orb.previewDockContent.marks.count) clear hittable \(absent ? 0 : 1)")
            }
        case "forget":
            let id = lastMarkRemoveId
            let ok = sent == ["mark.remove"] && id == "mark_pending" && counted.markClear == 0
            check(ok, "forget:0 → mark.remove {\"id\":\"mark_pending\"} 1, mark.clear 0", "sent \(sent) id '\(id)' mark.clear \(counted.markClear)")
        case "allow", "deny":
            if head == "allow" { allowResult = (sent, lastThreadAnswerYes) } else { denyResult = (sent, lastThreadAnswerYes) }
            if let a = allowResult, let d = denyResult {
                let ok = a.sent == ["thread.answer"] && a.yes == true && d.sent == ["thread.answer"] && d.yes == false
                check(ok, "allow → thread.answer yes 1; deny → thread.answer no 1; each exactly one send",
                      "allow sent \(a.sent) yes \(a.yes.map { "\($0)" } ?? "nil"); deny sent \(d.sent) yes \(d.yes.map { "\($0)" } ?? "nil")")
            }
        case "threadStop", "threadstop":
            let ok = sent == ["thread.stop"] && counted.stop == 0 && counted.sleep == 0 && counted.setSettings == 0
            check(ok, "threadStop:Slack → thread.stop 1, stop 0, sleep 0, set-settings 0", "sent \(sent); run totals stop \(counted.stop) sleep \(counted.sleep) set-settings \(counted.setSettings)")
        case "thread":
            let ok = openThread == 1 && sent.isEmpty
            check(ok, "thread chip click → openThread 1, sends 0", "openThread +\(openThread) sent \(sent)")
        case "sleep":
            if awake {
                sleepAwakeResult = sent
            } else {
                sleepAsleepResult = (sent, dim)
            }
            if let a = sleepAwakeResult, let z = sleepAsleepResult {
                let cause = lastSleepCause
                let ok = a == ["sleep"] && cause == "dock" && z.sent.isEmpty && abs(z.dim - 0.35) < 0.01
                check(ok, "sleep press awake → sleep {\"cause\":\"dock\"} 1; asleep → α 0.35, 0 sends", "awake sent \(a) cause '\(cause)'; asleep sent \(z.sent) dim \(String(format: "%.2f", z.dim))")
            }
        case "console":
            let ok = openConsole == 1 && sent.isEmpty
            check(ok, "console press → openConsole 1, 0 sends", "openConsole +\(openConsole) sent \(sent)")
        case "remedy":
            remedyResult = (sent, lastRequestPermission)
            screenRecordingCheck()
        default:
            break
        }
    }

    /// The Screen Recording line: read once the remedy was pressed (or at the island read, without the press).
    func screenRecordingCheck() {
        guard let sr = screenRecordingSeen else { return }
        let r = remedyResult
        let remedyOK = r.map { $0.sent == ["request-permission"] && $0.which == "screenRecording" } ?? false
        let tipOK = sr.tooltip.contains("needs Screen Recording")
        let ok = sr.circleDim && sr.windowDim && tipOK && sr.chipGlyph && sr.pillRequest && remedyOK
        check(ok, "screen recording denied → Circle/Window α 0.45, Circle tooltip contains \"needs Screen Recording\", peek chip glyph rectangle.inset.filled.badge.record amber, foot row with [Request]; remedy → request-permission screenRecording 1",
              "circle dim \(sr.circleDimValue) window dim \(sr.windowDimValue) tooltip '\(sr.tooltip)'; chip \(sr.chip); pill '\(sr.pill)' (\(sr.pillKind)), foot row remedy '\(sr.remedyLabel)'; remedy press " + (r.map { "sent \($0.sent) which '\($0.which)'" } ?? "not pressed (ORB_NOTCH_PRESS=remedy@t)"))
        screenRecordingSeen = nil
    }

    /// ⌥⇧Return, the words, Return; then ⌥⇧Return, words, Escape — the field's whole contract in one script.
    func notchFieldScript(text: String) {
        let before = notchSends.total
        var s1 = (pinned: false, focused: false, key: false, swallowed: false)
        var s2 = (key: false, text: "?", sent: 0)
        var s3 = (focused: true, text: "?", key: false)
        orb.sayLine()
        print(stamp, "⌥⇧Return (sayLine) -> pinned \(orb.previewNotchPinned ? 1 : 0) field focused \(orb.previewNotchFieldFocused ? 1 : 0) panel key \(orb.previewNotchIsKey ? 1 : 0) canBecomeKey \(orb.previewNotchCanBecomeKey ? 1 : 0) firstResponder \(notchPanel?.firstResponder.map { String(describing: type(of: $0)) } ?? "nil")")
        fflush(stdout)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
            guard let self else { return }
            let q = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [.command], timestamp: ProcessInfo.processInfo.systemUptime,
                                     windowNumber: self.notchPanel?.windowNumber ?? 0, context: nil, characters: "q", charactersIgnoringModifiers: "q", isARepeat: false, keyCode: 12)
            let swallowed = q.map { self.orb.previewNotchKeyEquivalentSwallowed($0) } ?? false
            s1 = (self.orb.previewNotchPinned, self.orb.previewNotchFieldFocused, self.orb.previewNotchIsKey, swallowed)
            self.orb.previewNotchFieldText = text
            print(self.stamp, "field: typed '\(text)'; ⌘q swallowed \(swallowed ? 1 : 0); line reads '\(self.orb.previewNotchLineText)'")
            fflush(stdout)
            self.notchShot("island-say", note: "the Say field has key: '\(text)'")
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            guard let self else { return }
            self.orb.previewNotchFieldReturn()
            // One frame later: key given back, the text gone.
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0 / 60) { [weak self] in
                guard let self else { return }
                s2 = (self.orb.previewNotchIsKey, self.orb.previewNotchFieldText, self.notchSends.total - before)
                print(self.stamp, "field: Return -> say-text +\(self.notchSends.sayText) key \(s2.key ? 1 : 0) text '\(s2.text)' focused \(self.orb.previewNotchFieldFocused ? 1 : 0)")
                fflush(stdout)
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) { [weak self] in
            guard let self else { return }
            self.orb.sayLine()
            self.orb.previewNotchFieldText = "kept words"
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
                guard let self else { return }
                self.orb.previewNotchFieldEscape()
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.0 / 60) { [weak self] in
                    guard let self else { return }
                    s3 = (self.orb.previewNotchFieldFocused, self.orb.previewNotchFieldText, self.orb.previewNotchIsKey)
                    let rest = self.orb.previewNotchCanBecomeKey
                    print(self.stamp, "field: Escape -> focused \(s3.focused ? 1 : 0) text '\(s3.text)' key \(s3.key ? 1 : 0); canBecomeKey at rest \(rest ? 1 : 0)")
                    fflush(stdout)
                    let said = self.lastSayText == text
                    let ok = s1.pinned && s1.focused && s1.swallowed && s2.sent == 1 && said && !s2.key && s2.text.isEmpty && !s3.focused && s3.text == "kept words" && !s3.key && !rest
                    let keyNote = s1.key ? "key taken" : "key not granted by the window server to a background harness (field is first responder)"
                    self.check(ok, "field: ⌥⇧Return → pinned 1, key taken; Return → say-text 1, key released ≤ 1 frame, text cleared; Escape → key released, text kept; canBecomeKey false at rest; ⌘q swallowed while key",
                               "pinned \(s1.pinned ? 1 : 0) focused \(s1.focused ? 1 : 0) \(keyNote) ⌘q swallowed \(s1.swallowed ? 1 : 0); Return say-text \(s2.sent) ('\(self.lastSayText)') key \(s2.key ? 1 : 0) text '\(s2.text)'; Escape focused \(s3.focused ? 1 : 0) text '\(s3.text)' key \(s3.key ? 1 : 0); canBecomeKey \(rest ? 1 : 0)")
                }
            }
        }
    }

    /// Escape: mark mode's monitor takes it (a posted key event); a focused field lets go, text kept.
    func notchEscape() {
        if orb.previewNotchFieldFocused {
            orb.previewNotchFieldEscape()
            print(stamp, "Escape -> field released, text '\(orb.previewNotchFieldText)'")
        } else {
            let esc = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                       windowNumber: 0, context: nil, characters: "\u{1b}", charactersIgnoringModifiers: "\u{1b}", isARepeat: false, keyCode: 53)
            if let esc { NSApp.postEvent(esc, atStart: false) }
            print(stamp, "Escape posted (marking \(state.marking ? 1 : 0))")
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
                guard let self else { return }
                print(self.stamp, "  -> marking \(self.state.marking ? 1 : 0), dock marking \(self.orb.previewNotchMarking ? 1 : 0), mode \(self.orb.previewNotchMode), pinned \(self.orb.previewNotchPinned ? 1 : 0)")
                fflush(stdout)
            }
        }
        fflush(stdout)
    }

    /// A bare Return to the panel — no field, a question waiting: nothing may answer it.
    func notchBareReturn() {
        ensureIslandOpen()
        let before = notchSends.total
        let hadText = orb.previewNotchFieldFocused && !orb.previewNotchFieldText.isEmpty
        if let panel = notchPanel, let ev = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                                              windowNumber: panel.windowNumber, context: nil, characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36) {
            panel.sendEvent(ev)
        }
        if orb.previewNotchFieldFocused { orb.previewNotchFieldReturn() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
            guard let self else { return }
            let sent = Array(self.notchSends.all.dropFirst(before))
            let answers = sent.filter { $0 == "thread.answer" }.count
            let says = sent.filter { $0 == "say-text" }.count
            let ok = self.orb.previewDockContent.question != nil && answers == 0 && says == (hadText ? 1 : 0)
            self.check(ok, "Return with a question waiting → thread.answer 0 (say-text 1 if the field had text, else 0)",
                       "question \(self.orb.previewDockContent.question?.name ?? "none") waiting; field had text \(hadText ? 1 : 0); sent \(sent)")
        }
    }

    /// Kevin's stroke through the overlay window, as OverlayPreviewDemo synthesises it (ORB_MARK): a
    /// wobbly loop 300 pt right of the notch, 90 pt under the menu bar.
    func notchStroke() {
        guard overlay.isMarking, let g = NotchGeometry.current() else {
            print(stamp, "notch stroke: not marking (\(overlay.isMarking ? 1 : 0)) — nothing drawn")
            fflush(stdout)
            return
        }
        let centre = CGPoint(x: g.notch.midX + 300, y: 200)
        guard let w = overlay.windows.first(where: { $0.cgFrame.contains(centre) }) ?? overlay.windows.first else { return }
        let pts: [CGPoint] = (0..<48).map { i in
            let t = Double(i) / 47
            let ang = -100.0 * .pi / 180 + t * (2 * .pi + 0.35)
            let wob = 1 + 0.05 * sin(ang * 3 + 3) + 0.03 * cos(ang * 5 - 3)
            let drift = CGFloat(t) * 6
            return CGPoint(x: centre.x + 120 * CGFloat(cos(ang) * wob) + drift, y: centre.y + 70 * CGFloat(sin(ang) * wob) - drift * 0.5)
        }
        func send(_ type: NSEvent.EventType, _ p: CGPoint) {
            guard let ev = NSEvent.mouseEvent(with: type, location: w.windowPoint(w.local(p)), modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                              windowNumber: w.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: type == .leftMouseUp ? 0 : 1) else { return }
            w.sendEvent(ev)
        }
        let step = 0.012
        let sendsBefore = notchSends.total
        let askArmed = orb.previewAskAfterMark
        print(stamp, String(format: "notch stroke: %d samples around CG %.0f,%.0f (askAfterMark %d)", pts.count, centre.x, centre.y, askArmed ? 1 : 0))
        fflush(stdout)
        send(.leftMouseDown, pts[0])
        for (i, p) in pts.enumerated().dropFirst() {
            DispatchQueue.main.asyncAfter(deadline: .now() + step * Double(i)) { send(.leftMouseDragged, p) }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + step * Double(pts.count) + 0.1) { [weak self] in
            send(.leftMouseUp, pts[pts.count - 1])
            guard let self else { return }
            print(self.stamp, "notch stroke: mouse-up; marking \(self.state.marking ? 1 : 0)")
            fflush(stdout)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
                guard let self else { return }
                let sent = Array(self.notchSends.all.dropFirst(sendsBefore))
                let pinned = self.orb.previewNotchPinned
                let ignores = self.orb.previewNotchIgnoresMouse
                // No real pointer near the island in the harness: the rule leaves the mouse ignored unless pinned.
                let ruleOK = ignores == !pinned
                let ok = sent.filter { $0 == "mark.add" }.count == 1 && !self.state.marking && !self.orb.previewNotchMarking && ruleOK
                self.check(ok, "after stroke: mark.add 1 (overlay), marking 0, mouse acceptance back to the pointerNear rule",
                           "sent \(sent) marking \(self.state.marking ? 1 : 0)/\(self.orb.previewNotchMarking ? 1 : 0) ignoresMouse \(ignores ? 1 : 0) pinned \(pinned ? 1 : 0) mode \(self.orb.previewNotchMode)")
                if let armed = self.askWaitsForStroke, !self.askStrokeChecked {
                    self.askStrokeChecked = true
                    let order = Array(self.notchSends.all.dropFirst(armed.total))
                    let ok = armed.beginMarkMode == 1 && armed.sent == 0 && order == ["mark.add", "say-text"] && self.lastSayText == "What did I circle?"
                    self.check(ok, "ask, in session, no marks → beginMarkMode 1, sends 0; after stroke → mark.add then say-text, in that order",
                               "at the press beginMarkMode \(armed.beginMarkMode) sent \(armed.sent); after the stroke \(order) text '\(self.lastSayText)'")
                }
            }
        }
    }

    /// An `orb.trace` while tucked: reason "mark" brings the blob home, anything else stays out (`watch` times it).
    func notchTrace(reason: String) {
        guard let g = NotchGeometry.current() else { return }
        let x0 = g.notch.midX - 60, y0: CGFloat = 150
        let pts = [Point2(x: x0, y: y0), Point2(x: x0 + 120, y: y0), Point2(x: x0 + 120, y: y0 + 60), Point2(x: x0, y: y0 + 60)]
        traceProbe = TraceProbe(reason: reason, sentAt: CACurrentMediaTime(), tuckedBefore: orb.previewIsTucked, doneAt: -1, parkedAt: -1, judged: false)
        print(stamp, "orb.trace reason=\(reason) while tucked \(orb.previewIsTucked ? 1 : 0), flight \(orb.previewFlightPhase)")
        fflush(stdout)
        state.overlayCommands.send(.orbTrace(points: pts, closed: true, label: nil, ttlMs: 2500, tone: reason == "mark" ? .mark : .accent, reason: reason, thread: nil))
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
            guard let self else { return }
            print(self.stamp, "  -> flight \(self.orb.previewFlightPhase), homeAfterTrace \(self.orb.previewHomeAfterTrace ? 1 : 0), tucked \(self.orb.previewIsTucked ? 1 : 0)")
            fflush(stdout)
        }
    }

    /// From `watch()`: the trace's work ends (the flight leaves tracing / hovering), then the blob parks or not, 1.5 s later.
    func watchTraceProbe(phase: String, tucked: Bool, now: Double) {
        guard var p = traceProbe, !p.judged else { return }
        if p.doneAt < 0, now - p.sentAt > 0.2, phase != "tracing", phase != "outbound", phase != "hovering", !(phase == "none" && tucked && now - p.sentAt < 0.6) {
            p.doneAt = now
            print(stamp, "trace probe (\(p.reason)): work done, flight \(phase), tucked \(tucked ? 1 : 0)")
            fflush(stdout)
        }
        if p.doneAt >= 0, p.parkedAt < 0, tucked, phase == "none" || phase == "homing" || phase == "slip" {
            if tucked { p.parkedAt = now }
        }
        if p.doneAt >= 0, now - p.doneAt >= 1.5 {
            p.judged = true
            let parked = tucked
            let within = p.parkedAt >= 0 && p.parkedAt - p.doneAt <= 1.5
            if p.reason == "mark" {
                traceMarkResult = (parked && within, String(format: "parked %d, %.2f s after the line (%.2f s after the trace)", parked ? 1 : 0, p.parkedAt < 0 ? -1 : p.parkedAt - p.doneAt, p.parkedAt < 0 ? -1 : p.parkedAt - p.sentAt))
            } else {
                traceOtherResult = (!parked, String(format: "reason=%@ parked %d, flight %@", p.reason, parked ? 1 : 0, phase))
            }
            if let m = traceMarkResult, let o = traceOtherResult {
                check(m.ok && o.ok, "trace reason=mark while tucked → parked 1 within trace + 1.5 s (blob home); reason=reflex circle → stays (parked 0)", "mark: \(m.note); \(o.note)")
            } else if traceMarkResult != nil || traceOtherResult != nil {
                print(stamp, "trace probe (\(p.reason)): \(traceMarkResult?.note ?? traceOtherResult?.note ?? "") — the other reason's trace completes the check")
                fflush(stdout)
            }
        }
        traceProbe = p
    }

    /// gate > toast > mark-landed; a problem is never a pill — it is the foot row once the island opens. Asleep, tucked.
    func notchPillTest() {
        // Before the script's hover at 2.7 s opens the island (where the problem becomes the foot row).
        let t0 = 0.5
        var kinds: [String] = []
        func at(_ dt: Double, _ body: @escaping (OrbPreviewDelegate) -> Void) {
            DispatchQueue.main.asyncAfter(deadline: .now() + t0 + dt) { [weak self] in
                guard let self else { return }
                body(self)
            }
        }
        at(0) { me in
            me.state.wakeGate = .authenticating(method: me.gateMethod)
            me.landFakeMark(rect: Rect(x: 500, y: 300, w: 320, h: 200), withCropAfter: nil)
            me.state.toast("Stopped")
            if me.state.snapshot.problems.isEmpty { me.state.snapshot.problems = [Self.fakeProblem(kind: "permission.screenRecording", text: nil)] }
            print(me.stamp, "pill test: gate authenticating + a mark landed + a toast + a problem, tucked \(me.orb.previewIsTucked ? 1 : 0) awake \(me.orb.previewDockContent.awake ? 1 : 0)")
        }
        at(0.25) { me in kinds.append(me.orb.previewNotchPillKind); print(me.stamp, "pill test: with the gate -> \(me.orb.previewNotchPillKind) '\(me.orb.previewNotchPillText)'") }
        at(0.4) { me in me.state.wakeGate = .off(reason: "preview") }
        at(0.55) { me in kinds.append(me.orb.previewNotchPillKind); print(me.stamp, "pill test: gate off -> \(me.orb.previewNotchPillKind) '\(me.orb.previewNotchPillText)'") }
        at(1.9) { me in kinds.append(me.orb.previewNotchPillKind); print(me.stamp, "pill test: toast gone -> \(me.orb.previewNotchPillKind) '\(me.orb.previewNotchPillText)'") }
        at(6.3) { me in kinds.append(me.orb.previewNotchPillKind); print(me.stamp, "pill test: mark pill gone, tucked -> '\(me.orb.previewNotchPillKind)' (the problem waits for the island's foot)"); me.orb.previewNotchHover(true) }
        at(6.9) { me in
            kinds.append(me.orb.previewNotchPillKind)
            let footProblem = me.orb.previewNotchFootProblem
            let remedyHit = me.orb.previewNotchHitList.contains { $0.name == "remedy" }
            print(me.stamp, "pill test: island open -> pill '\(me.orb.previewNotchPillKind)' foot problem \(footProblem ? 1 : 0) remedy hittable \(remedyHit ? 1 : 0)")
            let ok = kinds == ["gate", "toast", "mark-landed", "", ""] && footProblem && remedyHit
            me.check(ok, "pill priority gate > toast > mark-landed; a problem is the foot row while the island is open (remedy in the hit list), never a pill",
                     "kinds in order \(kinds); foot problem \(footProblem ? 1 : 0) remedy hittable \(remedyHit ? 1 : 0)")
            me.orb.previewNotchHover(false)
        }
    }

    // MARK: the ring (design11 § Island)

    static let ringId = "auto_alarm"
    static let timerId = "auto_timer"

    /// ORB_NOTCH_RING / ORB_NOTCH_NEXT / ORB_NOTCH_RING_FOLD_AT / ORB_NOTCH_WAKE_AT / ORB_NOTCH_RING_CLEAR_AT (the header).
    func notchRingScript(env: [String: String]) {
        guard notchMode else { return }
        if let spec = env["ORB_NOTCH_NEXT"] {
            let parts = spec.split(separator: ":").map(String.init)
            if parts.count == 3, let seconds = Double(parts[2]) {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                    guard let self else { return }
                    let nowMs = Date().timeIntervalSince1970 * 1000
                    var snap = self.state.snapshot
                    var rows = snap.automations ?? []
                    rows.removeAll { $0.id == Self.timerId }
                    rows.append(Self.fakeTimerRow(name: parts[1], firesAt: nowMs + seconds * 1000, nowMs: nowMs))
                    snap.automations = rows
                    snap.nextFire = NextFire(id: Self.timerId, kind: parts[0], name: parts[1], at: nowMs + seconds * 1000)
                    self.state.snapshot = snap
                    print(self.stamp, "engine: next fire \(parts[0]) \(parts[1]) in \(Int(seconds)) s; a timer row armed")
                    fflush(stdout)
                }
                if env["ORB_NOTCH_PHASE"] == "asleep" {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
                        guard let self else { return }
                        self.timerPillEarly = (self.orb.previewNotchPillKind, self.orb.previewNotchPillText)
                        print(self.stamp, "timer: tucked asleep -> pill '\(self.orb.previewNotchPillText)' (\(self.orb.previewNotchPillKind)) foot '\(self.orb.previewNotchFootText)'")
                        fflush(stdout)
                    }
                }
            } else {
                print("ORB_NOTCH_NEXT: could not parse \(spec); want kind:name:seconds")
            }
        }
        guard let line = env["ORB_NOTCH_RING"] else { return }
        let ringAt = Double(env["ORB_NOTCH_RING_AT"] ?? "") ?? 1.5
        let calm = env["ORB_NOTCH_RING_CALM"] ?? "Monday · standup notes at 9"
        let late = Double(env["ORB_NOTCH_RING_LATE"] ?? "")
        DispatchQueue.main.asyncAfter(deadline: .now() + ringAt) { [weak self] in
            guard let self else { return }
            let nowMs = Date().timeIntervalSince1970 * 1000
            var snap = self.state.snapshot
            var rows = snap.automations ?? []
            rows.removeAll { $0.id == Self.ringId }
            rows.insert(Self.fakeAlarmRow(line: line, nowMs: nowMs), at: 0)
            snap.automations = rows
            snap.ringing = RingLine(id: Self.ringId, kind: "alarm", name: "Wake up", line: line, calm: calm, at: nowMs, lateMs: late,
                                    presses: [AutomationPress(kind: "snooze", minutes: 10, target: nil), AutomationPress(kind: "done", minutes: nil, target: nil)], more: 0)
            self.state.snapshot = snap
            self.ringKindChangeAt = CACurrentMediaTime()
            print(self.stamp, "engine: automation fired — ring \"\(line)\" (mode \(self.orb.previewNotchMode), pinned \(self.orb.previewNotchPinned ? 1 : 0), tucked \(self.orb.previewIsTucked ? 1 : 0))")
            fflush(stdout)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + ringAt + 0.3) { [weak self] in
            guard let self else { return }
            self.ringEarly = (self.orb.previewNotchMode, self.orb.previewNotchPinned, self.orb.previewIsTucked)
            print(self.stamp, "ring: 0.3 s after — mode \(self.orb.previewNotchMode) pinned \(self.orb.previewNotchPinned ? 1 : 0) tucked \(self.orb.previewIsTucked ? 1 : 0) kind \(self.orb.previewNotchCanvasKind) word '\(self.orb.previewNotchAnchorWord)'")
            fflush(stdout)
        }
        if let t = Double(env["ORB_NOTCH_RING_FOLD_AT"] ?? "") {
            DispatchQueue.main.asyncAfter(deadline: .now() + t) { [weak self] in
                guard let self else { return }
                self.orb.previewNotchPress("face")
                print(self.stamp, "ring: folded (a .face press) -> mode \(self.orb.previewNotchMode) pinned \(self.orb.previewNotchPinned ? 1 : 0)")
                fflush(stdout)
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + t + 0.2) { [weak self] in
                guard let self else { return }
                self.ringPillFolded = (self.orb.previewNotchPillKind, self.orb.previewNotchPillText, self.orb.previewNotchMode)
                print(self.stamp, "ring: folded pill '\(self.orb.previewNotchPillText)' (\(self.orb.previewNotchPillKind)) mode \(self.orb.previewNotchMode) lip chip '\(self.orb.previewNotchLipChip)'")
                fflush(stdout)
                self.notchShotsOwed.insert("island-alarm-folded")
                self.notchShot("island-alarm-folded", note: "the ring folded: the pill under the lip, mode \(self.orb.previewNotchMode)")
            }
        }
        if let t = Double(env["ORB_NOTCH_WAKE_AT"] ?? "") {
            DispatchQueue.main.asyncAfter(deadline: .now() + t) { [weak self] in
                guard let self else { return }
                self.state.snapshot.phase = .listening
                self.phaseStart = Date()
                print(self.stamp, "notch: phase -> listening (ORB_NOTCH_WAKE_AT) mode \(self.orb.previewNotchMode)")
                fflush(stdout)
            }
        }
        if let t = Double(env["ORB_NOTCH_RING_CLEAR_AT"] ?? "") {
            DispatchQueue.main.asyncAfter(deadline: .now() + t) { [weak self] in self?.engineEndsRing(id: Self.ringId, state: "done", why: "the engine's linger") }
        }
        // The island shot at 3.4 s and the checks at 3.45 read Snooze hovered (the minis up); the pointer leaves at 3.5.
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.35) { [weak self] in self?.orb.previewNotchHoverControl("snooze:10") }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.5) { [weak self] in self?.orb.previewNotchHoverControl(nil) }
        // 1.6 s after the pointer left Snooze the minis have gone from the hit list (while the ring is still up).
        DispatchQueue.main.asyncAfter(deadline: .now() + 5.1) { [weak self] in
            guard let self, self.orb.previewNotchCanvasKind == "ring" else { return }
            let snoozes = self.orb.previewNotchHitList.filter { $0.name.hasPrefix("snooze:") }.map(\.name)
            self.check(!self.orb.previewNotchRingMinisShown && snoozes == ["snooze:10"], "minis leave 1.5 s after the pointer left Snooze (only snooze:10 in the hit list)",
                       "minis shown \(self.orb.previewNotchRingMinisShown ? 1 : 0); snooze presses \(snoozes)")
        }
    }

    /// The daemon's answer to a Snooze / Done (or its own linger): the ring ends, the row's state moves; with
    /// ORB_NOTCH_QUESTION_AT=ring-end the fleet's question lands in the same turn.
    func engineEndsRing(id: String, state newState: String, why: String) {
        var snap = state.snapshot
        if snap.ringing?.id == id { snap.ringing = nil }
        if var rows = snap.automations, let i = rows.firstIndex(where: { $0.id == id }) {
            rows[i].state = newState
            rows[i].updatedAt = Date().timeIntervalSince1970 * 1000
            snap.automations = rows
        }
        state.snapshot = snap
        ringKindChangeAt = CACurrentMediaTime()
        print(stamp, "engine: ring \(id) -> \(newState) (\(why)); mode \(orb.previewNotchMode) pinned \(orb.previewNotchPinned ? 1 : 0) kind \(orb.previewNotchCanvasKind)")
        fflush(stdout)
        if pendingQuestionAtRingEnd { pendingQuestionAtRingEnd = false; applyPendingQuestion() }
    }

    /// The deferred fleet question lands: that thread waits on Kevin (the kind flips to question).
    func applyPendingQuestion() {
        guard let p = pendingQuestion else { return }
        pendingQuestion = nil
        guard let i = state.snapshot.threads.firstIndex(where: { $0.id == p.id }) else { print(stamp, "ORB_NOTCH_QUESTION_AT: no thread \(p.id) in the snapshot yet"); return }
        state.snapshot.threads[i].status = .waitingKevin
        state.snapshot.threads[i].question = p.text
        state.applySnapshotThreads(state.snapshot.threads)
        ringKindChangeAt = CACurrentMediaTime()
        print(stamp, "engine: \(p.id) asks \"\(p.text)\" — kind \(orb.previewNotchCanvasKind) mode \(orb.previewNotchMode)")
        fflush(stdout)
    }

    static func fakeChime(_ line: String, sound: String) -> AutomationAction {
        AutomationAction(kind: "chime", line: line, sound: sound, title: nil, body: nil, open: nil, app: nil, url: nil, path: nil, into: nil, recipe: nil, key: nil, prompt: nil, budget: nil, speak: nil)
    }

    /// "Weekdays at 07:10, ring "Wake up, Kevin"." — fired now.
    static func fakeAlarmRow(line: String, nowMs: Double) -> Automation {
        let every = Recurrence(kind: "weekly", days: ["mon", "tue", "wed", "thu", "fri"], at: "07:10", everyMs: nil, anchorAt: nil, nth: nil, weekday: nil, day: nil)
        return Automation(id: ringId, name: "Wake up", when: AutomationWhen(kind: "every", at: nil, ms: nil, every: every, phrase: "weekdays 07:10", on: nil),
                          then: [fakeChime(RingWords.body(of: line), sound: "Hero")],
                          clauses: AutomationClauses(window: nil, days: nil, once: nil, cooldown: nil, until: nil, quiet: "override"),
                          echo: "Weekdays at 07:10, ring \"\(RingWords.body(of: line))\".", state: "fired", nextAt: nil, lastFiredAt: nowMs, lastDetail: nil, fires: 1, missed: 0,
                          snoozedUntil: nil, createdAt: nowMs - 86_400_000, updatedAt: nowMs,
                          createdBy: AutomationCreatedBy(by: "brain", chainId: nil, delegationId: nil, request: "wake me at seven ten on weekdays"), confirmed: nil)
    }

    /// "In 12:00, ring "pasta"." — armed, firing at `firesAt`.
    static func fakeTimerRow(name: String, firesAt: Double, nowMs: Double) -> Automation {
        Automation(id: timerId, name: name, when: AutomationWhen(kind: "in", at: nil, ms: firesAt - nowMs, every: nil, phrase: nil, on: nil),
                   then: [fakeChime("\(name) is up", sound: "Glass")],
                   clauses: AutomationClauses(window: nil, days: nil, once: nil, cooldown: nil, until: nil, quiet: "respect"),
                   echo: "In 12:00, ring \"\(name)\".", state: "armed", nextAt: firesAt, lastFiredAt: nil, lastDetail: nil, fires: 0, missed: 0,
                   snoozedUntil: nil, createdAt: nowMs, updatedAt: nowMs,
                   createdBy: AutomationCreatedBy(by: "brain", chainId: nil, delegationId: nil, request: "twelve-minute timer for the pasta"), confirmed: nil)
    }

    /// The ring's island at 3.45 s (Snooze hovered since 3.35): the kind, the anchor word, the hero, the boxes in the
    /// consent rects, the minis, the head, Ask dead asleep, the foot's notice; the early pinned open; the tooltips; and
    /// the folded readings when the run folded it (the pill under the lip, the timer's pill before the ring).
    func ringIslandChecks(env: [String: String]) {
        let content = orb.previewDockContent
        let ring = env["ORB_NOTCH_RING"] ?? ""
        let kind = orb.previewNotchCanvasKind
        let word = orb.previewNotchAnchorWord
        let line = orb.previewNotchLineText
        let hits = orb.previewNotchHitList
        func at(_ name: String, _ x0: CGFloat, _ x1: CGFloat, _ y0: CGFloat, _ y1: CGFloat) -> Bool {
            guard let r = hits.first(where: { $0.name == name })?.rect else { return false }
            return abs(r.minX - x0) < 0.5 && abs(r.maxX - x1) < 0.5 && abs(r.minY - y0) < 0.5 && abs(r.maxY - y1) < 0.5
        }
        if content.ring != nil {
            let minis = hits.filter { $0.name == "snooze:5" || $0.name == "snooze:30" }
            let minisOK = minis.count == 2 && at("snooze:5", 340, 370, 85, 107) && at("snooze:30", 376, 406, 85, 107)
            let ask = orb.previewNotchBoxDim("ask")
            let askWant: CGFloat = content.awake ? 1 : 0.35
            let foot = orb.previewNotchFootText
            // The notice row is the asleep foot's (a problem row still wins it); awake the meter stays.
            let footOK = content.awake || content.problem != nil || env["ORB_NOTCH_NEXT"] == nil || foot.range(of: "^asleep · next Timer \\d+:\\d\\d · pasta$", options: .regularExpression) != nil
            let ok = kind == "ring" && word == "Alarm" && line == ring && at("snooze:10", 114, 198, 82, 110) && at("done", 206, 290, 82, 110)
                && at("ringOpen", 114, 114 + 292, 11, 31) && minisOK && orb.previewNotchRingMinisShown && abs(ask - askWant) < 0.01 && footOK
                && !hits.contains { $0.name == "allow" || $0.name == "deny" }
            check(ok, "ring → kind ring; anchor word \"Alarm\"; hero \"07:10 · Wake up, Kevin\"; Snooze 114–198 / Done 206–290 y 82–110 (no Allow / Deny); minis snooze:5 / snooze:30 at x 340/376 while Snooze is hovered; head \"Alarm · weekdays\" hittable ringOpen; Ask 0.35 asleep; foot \"asleep · next Timer 12:00 · pasta\" asleep",
                  "kind \(kind) word '\(word)' hero '\(line)' awake \(content.awake ? 1 : 0) hits \(hits.map(\.name)) minis \(minis.map { "\($0.name)@\(Int($0.rect.minX))" }) ask \(String(format: "%.2f", ask)) foot '\(foot)'")
            let heroTip = orb.previewNotchTooltipAt(NSPoint(x: 200, y: 40))
            let snoozeTip = orb.previewNotchTooltip("snooze:10"), doneTip = orb.previewNotchTooltip("done"), headTip = orb.previewNotchTooltip("ringOpen")
            let tips = heroTip.hasPrefix(ring) && snoozeTip == "Snooze — rings again in 10 min" && doneTip == "Done — stops the alarm" && headTip == "Alarm · weekdays — Console"
            check(tips, "ring tooltips: hero = the whole line; Snooze — rings again in 10 min; Done — stops the alarm; head → Alarm · weekdays — Console",
                  "hero '\(heroTip)' snooze '\(snoozeTip)' done '\(doneTip)' head '\(headTip)'")
        }
        if let e = ringEarly {
            check(e.mode == "island" && e.pinned && e.tucked, "ring arrives asleep → the island opens pinned before any pointer; the blob stays tucked",
                  "mode \(e.mode) pinned \(e.pinned ? 1 : 0) tucked \(e.tucked ? 1 : 0)")
        }
        if let f = ringPillFolded {
            let want = RingWords.body(of: ring) + " · Snooze ⌥⇧S"
            check(f.kind == "ring" && f.text == want && f.mode == "tucked", "ring folded asleep → the pill under the lip 🔔 \"Wake up, Kevin · Snooze ⌥⇧S\" (kind ring), the blob tucked",
                  "pill '\(f.text)' (\(f.kind)) mode \(f.mode)")
        }
        if let t = timerPillEarly {
            let ok = t.kind == "timer" && t.text.range(of: "^pasta · \\d+:\\d\\d$", options: .regularExpression) != nil
            check(ok, "tucked asleep with a running timer → the pill \"pasta · m:ss\" under the lip (kind timer)", "pill '\(t.text)' (\(t.kind))")
        }
    }

    /// Every phase, 0.2 s apart: Mute is in the hit list only in a session's phases; Stop always.
    func notchPhaseSweep() {
        let phases = Phase.allCases
        let restore = state.snapshot.phase
        var muteWrong: [String] = [], stopMissing: [String] = []
        for (i, phase) in phases.enumerated() {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2 * Double(i)) { [weak self] in
                guard let self else { return }
                self.state.snapshot.phase = phase
                self.phaseStart = Date()
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { [weak self] in
                    guard let self else { return }
                    let names = self.orb.previewNotchHitList.map(\.name)
                    let mute = names.contains("mute"), stop = names.contains("stop")
                    let wantMute = AppState.inSessionPhases.contains(phase)
                    if mute != wantMute { muteWrong.append(phase.rawValue) }
                    if !stop { stopMissing.append(phase.rawValue) }
                    let words = self.orb.previewNotchFieldPlaceholder, width = self.orb.previewNotchFieldPlaceholderWidth
                    self.placeholderWidths.append((phase.rawValue, words, width))
                    print(self.stamp, "sweep \(phase.rawValue): mute \(mute ? 1 : 0) (want \(wantMute ? 1 : 0)) stop \(stop ? 1 : 0) mute dim \(String(format: "%.2f", self.orb.previewNotchBoxDim("mute"))) placeholder '\(words)' \(Int(width)) pt")
                    fflush(stdout)
                }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2 * Double(phases.count) + 0.1) { [weak self] in
            guard let self else { return }
            self.check(muteWrong.isEmpty && stopMissing.isEmpty, "mute in session only; stop hittable in every phase", "mute wrong in [\(muteWrong.joined(separator: ", "))], stop missing in [\(stopMissing.joined(separator: ", "))]")
            let wide = self.placeholderWidths.filter { $0.width > 160 || $0.words.isEmpty }
            self.check(wide.isEmpty && self.placeholderWidths.count == phases.count, "field placeholder fits: width(placeholder) ≤ 160 in every phase",
                       self.placeholderWidths.map { "\($0.phase) '\($0.words)' \(Int($0.width))" }.joined(separator: "; "))
            self.state.snapshot.phase = restore
            self.phaseStart = Date()
        }
    }

    // MARK: the readings

    /// The peek at 2.55 s: the chips and their order, the meter chip, the problem chip.
    func notchPeekChecks(env: [String: String]) {
        guard orb.previewNotchMode == "peek" else { return }
        let chips = orb.previewNotchChips
        let kinds = chips.map { String($0.split(separator: ":").first ?? "") }
        print(stamp, "peek: chips \(chips) extra \(Int(orb.previewNotchChipsExtraWidth)) target width \(Int(orb.previewNotchPeekWidthTarget)) dots [\(orb.previewNotchThreadDots)]")
        fflush(stdout)
        peekChips = chips
        let dotCount = orb.previewNotchThreadDots.split(separator: " ").count
        let dotsExtra: CGFloat = dotCount > 0 ? CGFloat(dotCount) * 5 + CGFloat(dotCount - 1) * 3 + 8 : 0
        peekBefore = (orb.previewNotchPeekWidthTarget, orb.previewNotchChipsExtraWidth, dotsExtra)
        let wants = ["ORB_NOTCH_QUESTION", "ORB_NOTCH_MARKS", "ORB_NOTCH_PROBLEM", "ORB_NOTCH_METER"].filter { env[$0] != nil }.count
        if env["ORB_NOTCH_RING"] != nil, orb.previewDockContent.ring != nil {
            let order = ["ring", "question", "marks", "timer", "problem", "meter"]
            let ranks = kinds.compactMap { order.firstIndex(of: $0) }
            let sorted = ranks == ranks.sorted() && ranks.count == kinds.count
            let timerOK = env["ORB_NOTCH_NEXT"] == nil || chips.contains { $0.range(of: "^timer:\\d+:\\d\\d$", options: .regularExpression) != nil }
            let ok = chips.first == "ring:07:10" && sorted && timerOK && chips.count <= 4 && orb.previewNotchPeekWidthTarget <= NotchGeometry.peekWidthCap + 0.5
            check(ok, "ring folded awake → peek chip bell 07:10 first; order ring > question > marks > timer > problem > meter; a running timer's chip m:ss after marks; chips ≤ 4; peek ≤ 360",
                  "chips \(chips) width target \(Int(orb.previewNotchPeekWidthTarget))")
        }
        if wants >= 3 || env["ORB_NOTCH_CHIPS_CHECK"] == "1" {
            let order = ["ring", "question", "marks", "timer", "problem", "meter"]
            let ranks = kinds.compactMap { order.firstIndex(of: $0) }
            let sorted = ranks == ranks.sorted() && ranks.count == kinds.count
            let ok = chips.count <= 4 && sorted && orb.previewNotchPeekWidthTarget <= NotchGeometry.peekWidthCap + 0.5
            check(ok, "chips ≤ 4; order question > marks > problem > meter; peek width ≤ 360", "chips \(chips) width target \(Int(orb.previewNotchPeekWidthTarget))")
        }
        if env["ORB_NOTCH_METER"] != nil {
            meterPeekChip = chips.first { $0.hasPrefix("meter:") }.map { String($0.dropFirst("meter:".count)) } ?? ""
        }
        if env["ORB_NOTCH_SCREEN_RECORDING"] == "0" {
            let p = orb.previewDockContent.problem
            let glyphOK = p?.symbol == "rectangle.inset.filled.badge.record" && p?.warn == true && kinds.contains("problem")
            screenRecordingChip = (glyphOK, "\(kinds.contains("problem") ? "problem chip" : "no problem chip") glyph \(p?.symbol ?? "none") warn \(p?.warn == true ? 1 : 0)")
        }
    }

    /// The island at 3.45 s (open since 2.7): the geometry, the text limits, the ink cache, the
    /// accessibility children — and the scenario's rows: marks, question, meter, request, screen recording.
    func notchIslandChecks(env: [String: String]) {
        guard orb.previewNotchMode == "island", orb.previewIsTucked else {
            print(stamp, "island checks skipped: mode \(orb.previewNotchMode), tucked \(orb.previewIsTucked ? 1 : 0)")
            fflush(stdout)
            return
        }
        let layout = orb.previewNotchLayout
        print(stamp, "layout:", layout)
        fflush(stdout)
        let rects = Self.parseLayout(layout)
        func r(_ n: String) -> NSRect? { rects[n] }
        func spans(_ n: String, _ x0: CGFloat, _ x1: CGFloat, _ y0: CGFloat, _ y1: CGFloat) -> Bool {
            guard let q = r(n) else { return false }
            return abs(q.minX - x0) < 0.5 && abs(q.maxX - x1) < 0.5 && abs(q.minY - y0) < 0.5 && abs(q.maxY - y1) < 0.5
        }
        func rows(_ n: String, _ y0: CGFloat, _ y1: CGFloat) -> Bool {
            guard let q = r(n) else { return false }
            return abs(q.minY - y0) < 0.5 && abs(q.maxY - y1) < 0.5
        }
        let island = layout.hasPrefix("island 420×184")
        let kind = orb.previewNotchCanvasKind
        let anchorOK = spans("face", 57, 57, 40, 40) && rows("word", 60, 76) && spans("go", 14, 36, 123, 145) && spans("stop", 42, 68, 122, 146) && spans("mute", 74, 100, 122, 146)
        let displayOK = rows("head", 12, 30) && rows("hero", 30, 96) && spans("field", 114, 290, 122, 146)
        let stripOK = spans("clear", 302, 328, 122, 146) && spans("circle", 328, 354, 122, 146) && spans("window", 354, 380, 122, 146) && spans("ask", 380, 406, 122, 146)
        let footOK = spans("console", 354, 380, 156, 180) && spans("sleep", 380, 406, 156, 180) && rows("foot", 154, 184)
        // No rect overlaps another within the kind: the anchor, the head, the hero's used lines (the 66 pt slot is fixed; the
        // text takes heroLines × 22), the middle of this kind, the control row, the foot's boxes — the meter's figures, or the
        // remedy in their place while the problem row shows.
        var names = ["word", "go", "stop", "mute", "head", "heroUsed", "field", "clear", "circle", "window", "ask", "console", "sleep"]
        switch kind {
        case "question": names += ["allow", "deny", "mini0", "mini1"]
        case "ring":
            names += ["allow", "deny"]
            if orb.previewNotchRingMinisShown { names += ["mini0", "mini1"] }
        case "marks": names += ["film0", "film1", "film2"]
        default:
            let threads = orb.previewDockContent.threads.count
            if threads >= 3 { names += ["chips"] } else if threads > 0 { names += ["tile0", "tile1"] }
        }
        if let rem = r("remedy"), rem.width > 0 { names += ["remedy"] } else { names += ["footLeft", "bar", "footRight"] }
        var overlaps: [String] = []
        for (i, a) in names.enumerated() { for b in names[(i + 1)...] { if let ra = r(a), let rb = r(b), ra.intersects(rb) { overlaps.append("\(a)/\(b)") } } }
        // Every hit rect ≥ 20 pt on both sides, but for the inherited mini × (12×12) and the chip-line Stop (16×14).
        let hits = orb.previewNotchHitList
        let content = orb.previewDockContent
        let small = hits.filter { $0.rect.width < 19.5 || $0.rect.height < 19.5 }.filter { !($0.name.hasPrefix("forget:") || $0.name.hasPrefix("threadStop:")) }
        check(island && anchorOK && displayOK && stripOK && footOK && overlaps.isEmpty && small.isEmpty,
              "island 420×184; anchor face 57,40 word y 60–76 go 14–36 y 123–145 stop 42–68 mute 74–100 y 122–146; head y 12–30 hero y 30–96 field x 114–290 y 122–146; strip clear 302–328 circle 328–354 window 354–380 ask 380–406 y 122–146; foot seam 153.5 console 354–380 sleep 380–406 y 156–180; hairline 183.5; no rect overlaps within a kind; every hit rect ≥ 20 pt (inherited mini × and chip Stop excepted)",
              "kind \(kind)" + (overlaps.isEmpty ? "" : "; overlaps \(overlaps)") + (small.isEmpty ? "" : "; small \(small.map { "\($0.name) \(Int($0.rect.width))×\(Int($0.rect.height))" })"))
        let filmsEnd = ["film0", "film1", "film2"].compactMap { r($0)?.maxX }.max() ?? 0
        let tilesEnd = ["tile0", "tile1"].compactMap { r($0)?.maxX }.max() ?? 0
        let minisEnd = ["mini0", "mini1"].compactMap { r($0)?.maxX }.max() ?? 0
        let remedyMin = r("remedy").map { $0.width > 0 ? $0.minX : 342 } ?? 342
        let limits = (r("head")?.maxX ?? 999) <= 406.5 && (r("hero")?.maxX ?? 999) <= 406.5 && (r("chips")?.maxX ?? 999) <= 406.5 && (r("field")?.maxX ?? 999) <= 290.5
            && (r("footRight")?.maxX ?? 999) <= 342.5 && remedyMin >= 100 && filmsEnd <= 382.5 && tilesEnd <= 406.5 && minisEnd <= 406.5
        check(limits, "text limits head/hero/chips ≤ 406, field ≤ 290, footRight ≤ 342 (problem text ≤ remedy.minX − 8), films ≤ 382, tiles ≤ 406, minis ≤ 406",
              String(format: "head %.0f hero %.0f chips %.0f field %.0f footRight %.0f remedy.minX %.0f films %.0f tiles %.0f minis %.0f", r("head")?.maxX ?? -1, r("hero")?.maxX ?? -1,
                     r("chips")?.maxX ?? -1, r("field")?.maxX ?? -1, r("footRight")?.maxX ?? -1, remedyMin, filmsEnd, tilesEnd, minisEnd))

        stripSeamCheck(hits: hits)
        consoleTooltipCheck(hits: hits)
        if content.problem != nil { problemRowCheck() }
        if content.marks.contains(where: { $0.hasPixels }) { thumbPixelsCheck() }

        let n = NotchGeometry.current()?.notch.width ?? 185
        let bytes = orb.previewNotchInkBytes, cap = orb.previewNotchInkCapacityBytes
        let hasOpen = orb.previewNotchInkHas(width: NotchGeometry.islandWidth, height: NotchGeometry.islandHeight)
        let hasPeek = orb.previewNotchInkHas(width: n, height: NotchGeometry.peekHeight) && orb.previewNotchInkHas(width: n + 30, height: NotchGeometry.peekHeight)
        let stretched = orb.previewNotchStretchedFrames
        check(bytes <= cap && cap == 32 << 20 && hasOpen && hasPeek && stretched == 0,
              "ink cache ≤ 32 MB; 420×184 and the peek sizes prewarmed in makeDock; first open rendered 0 stretched frames",
              "\(bytes / 1024) KB of \(cap >> 20) MB; 420×184 \(hasOpen ? "yes" : "NO") peek \(Int(n))×26 (+0…30) \(hasPeek ? "yes" : "NO"); stretched frames \(stretched); \(orb.previewNotchDrawReadout)")

        // The tooltips off the press rects: the foot (the meter's line), the hero while a question shows, the head caption while films show.
        let footTip = orb.previewNotchTooltipAt(NSPoint(x: 200, y: 168))
        let footText = orb.previewNotchFootText
        check(footTip.contains(footText) && !footText.isEmpty, "tooltip at (200,168) contains footText", "tooltip '\(footTip)' foot '\(footText)'")
        if let q = orb.previewDockContent.question, orb.previewDockContent.ring == nil {
            let heroTip = orb.previewNotchTooltipAt(NSPoint(x: 200, y: 40))
            check(heroTip == q.text, "tooltip at (200,40) == question (question set)", "tooltip '\(heroTip)' question '\(q.text)'")
        }
        if kind == "marks", let newest = orb.previewDockContent.marks.last {
            let capTip = orb.previewNotchTooltipAt(NSPoint(x: 300, y: 21))
            check(capTip == newest.caption, "tooltip at (300,21) == film caption (marks set)", "tooltip '\(capTip)' caption '\(newest.caption)'")
        }

        let a = orb.previewNotchAccessibilityCounts
        check(a.buttons == a.hitRects && a.children == a.hitRects + 1 && a.hitRects > 0, "accessibility children == hit rects; field is its own element",
              "buttons \(a.buttons) children \(a.children) hit rects \(a.hitRects)")

        if notchOpenTiming { openTimingCheck() }
        if env["ORB_REDUCE_MOTION"] == "1" { reduceMotionCheck() }

        if env["ORB_NOTCH_RING"] != nil { ringIslandChecks(env: env) }
        if env["ORB_NOTCH_MARKS"] != nil, content.marks.count >= 3, content.question == nil { marksRowCheck(layout: rects) }
        // With a ring up the question waits in its chip: its island line is read only once it is the kind again.
        if env["ORB_NOTCH_QUESTION"] != nil, env["ORB_NOTCH_RING"] == nil || kind == "question" {
            let line = orb.previewNotchLineText
            let heroLines = orb.previewNotchHeroLines
            let names = orb.previewNotchHitList
            let allow = names.first { $0.name == "allow" }?.rect, deny = names.first { $0.name == "deny" }?.rect
            let hidden = !names.contains { $0.name == "ask" || $0.name == "clear" }
            let thumbs = orb.previewNotchThumbs.filter { !$0.hasPrefix("+") }
            let minis = names.filter { $0.name.hasPrefix("mark:") }.map { $0.rect }
            let tiles = orb.previewNotchThreadChips
            let q = content.question
            let source = q.flatMap { qq in names.first { $0.name == "thread:\(qq.threadId)" } }?.rect
            // The head row draws at y 12–30; its hit rect takes a point more each way (≥ 20 pt).
            let sourceOK = source.map { abs($0.minY - 11) < 0.5 && abs($0.maxY - 31) < 0.5 && abs($0.minX - 114) < 0.5 } == true
            let heroOK = q != nil && line == q?.text && heroLines.count >= 1 && heroLines.count <= 2
            let minisOK = minis.count <= 2 && zip(minis, [340.0, 376.0]).allSatisfy { abs($0.minX - CGFloat($1)) < 0.5 && abs($0.width - 30) < 0.5 }
            let ok = kind == "question" && sourceOK && heroOK && allow.map { abs($0.minX - 114) < 0.5 && abs($0.maxX - 198) < 0.5 && abs($0.minY - 82) < 0.5 && abs($0.maxY - 110) < 0.5 } == true
                && deny.map { abs($0.minX - 206) < 0.5 && abs($0.maxX - 290) < 0.5 && abs($0.minY - 82) < 0.5 && abs($0.maxY - 110) < 0.5 } == true
                && thumbs.count <= 2 && minisOK && hidden && tiles.isEmpty
            check(ok, "question waiting → kind question; head \"✋ Slack asks\" hittable thread:ID; hero = the question ≤ 2 lines; Allow 114–198 / Deny 206–290 y 82–110; minis ≤ 2 at x 340/376; Ask/Clear absent; tiles absent (dots on the peek)",
                  "kind \(kind); source \(source.map { "x\(Int($0.minX))–\(Int($0.maxX)) y\(Int($0.minY))–\(Int($0.maxY))" } ?? "none"); hero '\(line)' lines \(heroLines.count); allow \(allow.map { "\(Int($0.minX))–\(Int($0.maxX))" } ?? "none") deny \(deny.map { "\(Int($0.minX))–\(Int($0.maxX))" } ?? "none"); minis \(minis.map { Int($0.minX) }); ask/clear hidden \(hidden ? 1 : 0); tiles \(tiles)")
            // The count is the minis' and the `+n` slot's: no `◎ N` at the head's right end, and only the foot's `.console`.
            let consoles = names.filter { $0.name == "console" }
            let headRightW = r("headRight")?.width ?? -1
            let headTip = orb.previewNotchTooltipAt(NSPoint(x: 396, y: 21))
            check(kind == "question" && consoles.count == 1 && abs(headRightW) < 0.5 && !headTip.contains("circled"),
                  "question kind → no `◎ N` in the head whatever the marks (headRight width 0, one .console rect: the foot box); the minis and `+n` carry the count",
                  "kind \(kind) marks \(content.marks.count); console rects \(consoles.count) at \(consoles.map { "y\(Int($0.rect.minY))" }); headRight width \(Int(headRightW)); tooltip at (396,21) '\(headTip)'")
        }
        if env["ORB_NOTCH_METER"] != nil { meterCheck(env: env) }
        if let request = env["ORB_NOTCH_REQUEST"] {
            let working = orb.previewNotchLineText
            let swapsBefore = orb.previewNotchHeroSwaps.count
            let endedAt = CACurrentMediaTime()
            state.snapshot.delegations[0].status = .done
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
                guard let self else { return }
                let after = self.orb.previewNotchLineText
                let last = self.state.snapshot.transcript.last?.text ?? ""
                self.check(working == request && after == last, "hero shows the delegation request while working, last line otherwise",
                           "working '\(working)'; after the delegation ended '\(after)' (last line '\(last)')")
                // The swap is compared once `workingSince` has landed (its own sink, after the content), so it fires at
                // the flip — old ≠ new — not on the next counter tick with the new text leaving under itself.
                let swaps = Array(self.orb.previewNotchHeroSwaps.dropFirst(swapsBefore))
                let swap = swaps.last
                let ok = swaps.count == 1 && swap.map { $0.from == request && $0.to == last && $0.from != $0.to && $0.at >= endedAt && $0.at - endedAt < 0.1 } == true
                self.check(ok, "hero request → last line: one animated swap at the flip (old = the request, new = the last line, within 100 ms), never late or against itself",
                           "swaps since the flip \(swaps.count): " + swaps.map { String(format: "'%@' → '%@' at +%.0f ms", $0.from, $0.to, ($0.at - endedAt) * 1000) }.joined(separator: "; "))
            }
        }
        if env["ORB_NOTCH_SCREEN_RECORDING"] == "0" {
            let c = orb.previewNotchBoxDim("circle"), w = orb.previewNotchBoxDim("window")
            let tip = orb.previewNotchTooltip("circle")
            let pill = orb.previewNotchPillText, pillKind = orb.previewNotchPillKind
            let remedy = content.problem?.remedyLabel ?? ""
            let footRow = orb.previewNotchFootProblem && orb.previewNotchHitList.contains { $0.name == "remedy" }
            screenRecordingSeen = (abs(c - 0.45) < 0.01, abs(w - 0.45) < 0.01, screenRecordingChip?.ok ?? false, footRow && pill.isEmpty && remedy == "Request",
                                   String(format: "%.2f", c), String(format: "%.2f", w), tip, screenRecordingChip?.note ?? "peek not read", pill, pillKind, remedy)
            if remedyResult != nil { screenRecordingCheck() }
            else if !(env["ORB_NOTCH_PRESS"] ?? "").contains("remedy") { screenRecordingCheck() }
        }
    }

    /// At exit — after the open and the close spring have each added their sizes: the cache still under its cap, the
    /// prewarmed resting sizes (the island, the lip, the peek and its breath buckets) still held (pinned, never the
    /// first evicted), and no settled frame drawn stretched since the run began.
    func inkAfterCloseCheck() {
        let n = NotchGeometry.current()?.notch.width ?? 185
        let bytes = orb.previewNotchInkBytes, cap = orb.previewNotchInkCapacityBytes
        let hasOpen = orb.previewNotchInkHas(width: NotchGeometry.islandWidth, height: NotchGeometry.islandHeight)
        let hasLip = orb.previewNotchInkHas(width: n, height: NotchGeometry.lipHeight)
        var breathMissing: [Int] = []
        var extra: CGFloat = 0
        while extra <= 30 {
            if !orb.previewNotchInkHas(width: n + extra, height: NotchGeometry.peekHeight) { breathMissing.append(Int(extra)) }
            extra += 2
        }
        let pinned = orb.previewNotchInkPinned(width: NotchGeometry.islandWidth, height: NotchGeometry.islandHeight) && orb.previewNotchInkPinned(width: n, height: NotchGeometry.peekHeight)
        // A size with chips or the counter is not prewarmed and may draw one stretched frame while its render lands (by
        // design); a prewarmed resting size may not — that is the cache having evicted it.
        let stretched = orb.previewNotchStretchedFrames, resting = orb.previewNotchStretchedRestingFrames
        check(bytes <= cap && hasOpen && hasLip && breathMissing.isEmpty && pinned && resting == 0,
              "ink after the close: ≤ 32 MB; 420×184, the lip and the peek's breath buckets (+0…30) still held (prewarmed keys pinned); 0 stretched frames at a resting size for the run",
              "\(bytes / 1024) KB of \(cap >> 20) MB; 420×184 \(hasOpen ? "yes" : "NO") lip \(hasLip ? "yes" : "NO") breath missing \(breathMissing) pinned \(pinned ? 1 : 0); stretched frames \(stretched) (at a resting size \(resting)); \(orb.previewNotchDrawReadout)")
    }

    /// The strip's seams (Clear|Circle|Window|Ask, Console|Sleep): the cells touch, so a point 1 pt right of a drawn
    /// seam is the right-hand cell's and 1 pt left the left-hand's — a strip cell takes no slop across a seam.
    /// Before, Clear's 2 pt slop reached into Circle: a click at x 329 cleared every mark.
    private func stripSeamCheck(hits: [(name: String, rect: NSRect)]) {
        var wrong: [String] = [], probed = 0
        for (left, right) in [("clear", "circle"), ("circle", "window"), ("window", "ask"), ("console", "sleep")] {
            guard let rr = hits.first(where: { $0.name == right })?.rect,
                  let l = hits.filter({ $0.name == left }).first(where: { abs($0.rect.maxX - rr.minX) < 0.5 && abs($0.rect.minY - rr.minY) < 0.5 })?.rect else { continue }
            probed += 1
            let y = rr.midY
            let hitRight = orb.previewNotchButtonAt(NSPoint(x: rr.minX + 1, y: y)), hitLeft = orb.previewNotchButtonAt(NSPoint(x: l.maxX - 1, y: y))
            if hitRight != right { wrong.append("(\(Int(rr.minX + 1)),\(Int(y))) → '\(hitRight)' want \(right)") }
            if hitLeft != left { wrong.append("(\(Int(l.maxX - 1)),\(Int(y))) → '\(hitLeft)' want \(left)") }
        }
        check(probed > 0 && wrong.isEmpty, "strip seams: 1 pt right of a shared seam hits the right-hand cell, 1 pt left the left-hand (no slop across a seam)",
              "\(probed) seams probed" + (wrong.isEmpty ? "" : "; wrong \(wrong)"))
    }

    /// `.console` may sit in the list three times (`+n` film, `◎ N`, the box): the tooltip is the rect under the pointer's,
    /// so the foot box says `Console (⌥⇧J)` however many others exist. Read whenever a duplicate is live.
    private func consoleTooltipCheck(hits: [(name: String, rect: NSRect)]) {
        let consoles = hits.filter { $0.name == "console" }
        // The foot box is appended after the film and the head rect: the last of its name.
        guard consoles.count > 1, let box = consoles.last?.rect else { return }
        let tip = orb.previewNotchTooltipAt(NSPoint(x: box.midX, y: box.midY))
        let want = orb.previewNotchTooltip("console")
        check(tip == want && !want.isEmpty, "Console box tooltip is the Console help while `+n` or `◎ N` also carry .console (the rect under the pointer, not the first of its name)",
              "\(consoles.count) console rects; box at (\(Int(box.midX)),\(Int(box.midY))) → '\(tip)' (want '\(want)')")
    }

    /// The problem row's clause draws only with ≥ 60 pt of room before the remedy; else it is omitted whole.
    private func problemRowCheck() {
        let row = orb.previewNotchProblemRow
        let clause = row.components(separatedBy: "clause '").last?.components(separatedBy: "' room").first ?? "?"
        let room = Double(row.components(separatedBy: " room ").last ?? "") ?? -1
        let ok = !row.isEmpty && room >= 0 && (clause.isEmpty || clause.hasPrefix("+") || room >= 60)
        check(ok, "problem row: the clause draws only with ≥ 60 pt of room before the remedy (else omitted with its · ; the foot tooltip keeps the whole text)", row)
    }

    /// Every decoded thumbnail fills the 84×60 film at 2× (168×120 px) without upscaling, unless its source is smaller
    /// — the decode's longer side is 216 (2 × 84 × 16:9), not 170, so a wide crop still brings 120 px of height.
    private func thumbPixelsCheck() {
        let shown = Array(orb.previewDockContent.marks.reversed())
        var wrong: [String] = [], decoded = 0
        for entry in orb.previewNotchThumbPixels {
            let parts = entry.split(separator: ":").map(String.init)
            guard parts.count == 2, let i = Int(parts[0]), i < shown.count, parts[1] != "none" else { continue }
            let wh = parts[1].split(separator: "x").compactMap { Double($0) }
            guard wh.count == 2 else { wrong.append(entry); continue }
            decoded += 1
            // The harness writes each crop at a quarter of its points, at 2× (`writeMarkPNG`): the source's pixels.
            let src = (w: max(24, shown[i].size.width / 4) * 2, h: max(16, shown[i].size.height / 4) * 2)
            if wh[0] + 0.5 < min(168, src.w) || wh[1] + 0.5 < min(120, src.h) { wrong.append("\(entry) (source \(Int(src.w))×\(Int(src.h)))") }
        }
        check(decoded > 0 && wrong.isEmpty, "thumbnails decode ≥ 168×120 px (the 84×60 film at 2×, aspect-filled) unless the source is smaller — maxPixel 216, no upscaling into the film",
              "decoded \(decoded) \(orb.previewNotchThumbPixels)" + (wrong.isEmpty ? "" : "; short \(wrong)"))
    }

    /// "island 420×184 | face x57–57 y40–40 | word x14–100 y60–76 | … | kind:plain" → rects keyed by name
    /// (the `island` head and the trailing `kind:` token are skipped: neither is three words).
    static func parseLayout(_ s: String) -> [String: NSRect] {
        var out: [String: NSRect] = [:]
        for part in s.split(separator: "|") {
            let words = part.trimmingCharacters(in: .whitespaces).split(separator: " ").map(String.init)
            guard words.count == 3, words[1].hasPrefix("x"), words[2].hasPrefix("y"), !words[0].hasPrefix("kind:") else { continue }
            let xs = words[1].dropFirst().split(separator: "–").compactMap { Double($0) }
            let ys = words[2].dropFirst().split(separator: "–").compactMap { Double($0) }
            guard xs.count == 2, ys.count == 2 else { continue }
            out[words[0]] = NSRect(x: xs[0], y: ys[0], width: xs[1] - xs[0], height: ys[1] - ys[0])
        }
        return out
    }

    /// The films: the slots, the overflow (five marks for a beat), the frames by their pixels, the hero's one line, the head caption, the window caption.
    private func marksRowCheck(layout: [String: NSRect]) {
        let thumbs = orb.previewNotchThumbs
        let slots = ["film0", "film1", "film2"].compactMap { layout[$0] }
        let wantX: [CGFloat] = [114, 206, 298]
        var slotsOK = slots.count == 3 && orb.previewNotchCanvasKind == "marks"
        for (slot, x) in zip(slots, wantX) {
            let dx = abs(slot.minX - x), dw = abs(slot.width - 84), dh = abs(slot.height - 60), dy = abs(slot.minY - 56)
            if dx >= 0.5 || dw >= 0.5 || dh >= 0.5 || dy >= 0.5 { slotsOK = false }
        }
        let heroLines = orb.previewNotchHeroLines
        let heroOK = heroLines.count <= 1
        let newestCaption = orb.previewDockContent.marks.last?.caption ?? ""
        let headTip = orb.previewNotchTooltipAt(NSPoint(x: 300, y: 21))
        let captionHeadOK = !newestCaption.isEmpty && headTip == newestCaption
        // The head caption fits its 180 pt span by dropping trailing ` · ` parts, never cut mid-word: what is drawn is
        // the full caption's figures (the kind word gone) cut at a ` · `, and the tooltip keeps the whole string.
        let drawn = orb.previewNotchHeadCaption
        let figures = newestCaption.components(separatedBy: " · ").dropFirst().joined(separator: " · ")
        let drawnParts = drawn.components(separatedBy: " · "), figureParts = figures.components(separatedBy: " · ")
        let prefixOK = !drawn.isEmpty && drawnParts.count <= figureParts.count && Array(figureParts.prefix(drawnParts.count)) == drawnParts
        let headRightW = layout["headRight"]?.width ?? -1
        let fitOK = prefixOK && headRightW > 0 && headRightW <= 180.5 && !drawn.contains("…") && drawnParts.count < figureParts.count
        check(fitOK, "head caption fits 180 pt by dropping trailing · parts (element phrase, then age), never cut mid-word; the tooltip keeps the full caption",
              "drawn '\(drawn)' (\(drawnParts.count) of \(figureParts.count) parts, headRight \(Int(headRightW)) pt); full '\(newestCaption)'")
        let content = orb.previewDockContent
        let shown = Array(content.marks.reversed())
        let capturing = shown.firstIndex { !$0.hasPixels }
        let used = shown.firstIndex { $0.consumed }
        let pending = shown.firstIndex { !$0.consumed && $0.hasPixels }
        let skeletonOK = capturing.map { i in thumbs.first { $0.hasPrefix("\(i):") }?.hasSuffix(":skeleton") ?? false } ?? false
        // The frames, by pixel: the pending one amber, the used one grey and dimmer.
        var frameNote = "frames not sampled"
        var framesOK = false
        // The frame's own colour is read against the ink 2 pt above it: for a white hairline the
        // per-channel coverage a = Δ / (1 − ink) is one number — 0.55 for a pending mark's frame,
        // 0.55 × 0.50 for a used one — while the amber frame lowers blue where the ink is bright.
        // Nine columns each along the frame's top edge (y + 0.5) and the crop row just under it (y + 1.5):
        // the dither's noise averages out, and the frame is what the first row adds over the second.
        func row(_ slot: NSRect, _ dy: CGFloat) -> (r: Double, g: Double, b: Double, a: Double)? {
            var sum = (r: 0.0, g: 0.0, b: 0.0, a: 0.0), n = 0.0
            for i in 0..<9 {
                let x = slot.minX + 3 + CGFloat(i) * 3
                guard let px = notchPixel(island: NSPoint(x: x, y: slot.minY + dy)) else { continue }
                sum.r += px.r; sum.g += px.g; sum.b += px.b; sum.a += px.a; n += 1
            }
            return n > 0 ? (sum.r / n, sum.g / n, sum.b / n, sum.a / n) : nil
        }
        if let u = used, let p = pending, u < slots.count, p < slots.count,
           let pu = row(slots[u], 0.5), let bu = row(slots[u], 2.5),
           let pp = row(slots[p], 0.5), let bp = row(slots[p], 2.5) {
            func coverage(_ px: Double, _ bg: Double) -> Double { bg >= 0.98 ? 0 : (px - bg) / (1 - bg) }
            let amber = (pp.r - bp.r) > 0.25 && (pp.r - bp.r) > (pp.b - bp.b) + 0.25
            let cov = [coverage(pu.r, bu.r), coverage(pu.g, bu.g), coverage(pu.b, bu.b)]
            let mean = cov.reduce(0, +) / 3
            let white = cov.allSatisfy { abs($0 - mean) < 0.12 }
            let half = mean > 0.15 && mean < 0.42   // 0.55 × 0.50 = 0.275; a full frame would read ≈ 0.55
            framesOK = amber && white && half
            frameNote = String(format: "pending frame Δrgb %+.2f/%+.2f/%+.2f (amber %d); used frame white coverage %.2f (want ≈ 0.55 × 0.50 = 0.28; neutral %d)", pp.r - bp.r, pp.g - bp.g, pp.b - bp.b, amber ? 1 : 0, mean, white ? 1 : 0)
        }
        // Five marks for a beat — a window (Safari, 1280×800) among them — two films and "+3" (→ Console); the window's caption read then.
        let keep = fakeMarks
        var five = fakeMarks
        if !five.contains(where: { $0.isWindow }) { five.append(makeFakeMark(FakeMarkSpec(kind: "window", size: CGSize(width: 1280, height: 800), ageSeconds: 5, app: "Safari"))) }
        while five.count < 5 { five.append(makeFakeMark(FakeMarkSpec(kind: "pending", size: CGSize(width: 200, height: 120), ageSeconds: 3, app: nil))) }
        fakeMarks = five
        publishFakeMarks()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
            guard let self else { return }
            let overflow = self.orb.previewNotchThumbs
            // The "+3" film is a `.console` press in the third slot.
            let plusRect = self.orb.previewNotchHitList.first { $0.name == "console" }?.rect
            let plusOK = plusRect.map { slots.count == 3 && abs($0.minX - slots[2].minX) < 0.5 && abs($0.minY - slots[2].minY) < 0.5 } ?? false
            let overflowOK = overflow.count == 3 && overflow.filter { !$0.hasPrefix("+") }.count == 2 && overflow.last == "+3" && plusOK
            let windowCaption = self.orb.previewDockContent.marks.first { $0.isWindow }?.caption ?? ""
            let captionOK = windowCaption.hasPrefix("Captured · Safari · 1280×800")
            // Two `.console` rects live: the "+3" film says "3 more circled — Console", the foot box the Console help.
            let plusTip = plusRect.map { self.orb.previewNotchTooltipAt(NSPoint(x: $0.midX, y: $0.midY)) } ?? ""
            let boxRect = self.orb.previewNotchHitList.filter { $0.name == "console" }.last?.rect
            let boxTip = boxRect.map { self.orb.previewNotchTooltipAt(NSPoint(x: $0.midX, y: $0.midY)) } ?? ""
            let consoleHelp = self.orb.previewNotchTooltip("console")
            self.check(plusTip == "3 more circled — Console" && boxTip == consoleHelp && boxRect.map { abs($0.minY - 156) < 0.5 } == true,
                       "+3 film tooltip \"3 more circled — Console\"; the foot's Console box keeps the Console help (tooltip by the rect under the pointer)",
                       "+3 → '\(plusTip)'; box at y\(boxRect.map { Int($0.minY) } ?? -1) → '\(boxTip)' (want '\(consoleHelp)')")
            self.fakeMarks = keep
            self.publishFakeMarks()
            let ok = slotsOK && overflowOK && framesOK && skeletonOK && heroOK && captionHeadOK && captionOK
            self.check(ok, "films: 3 × 84×60 at x 114/206/298 y 56–116; 5 marks → 2 films + \"+3\" (→ console); used α 0.50 plain frame; capturing = skeleton + amber frame; hero 1 line; head caption = the newest film's; window caption \"Captured · Safari · 1280×800\"",
                       "slots \(slots.map { "\(Int($0.minX))" }) thumbs \(thumbs); five → \(overflow) (+3 → console \(plusOK ? 1 : 0)); \(frameNote); hero lines \(heroLines.count); head caption '\(headTip)'; window caption '\(windowCaption)'")
        }
    }

    /// The meter: the peek chip (2.55 s), the foot now, paused after ORB_PAUSE_AT, asleep after ORB_SLEEP_AT.
    private func meterCheck(env: [String: String]) {
        let v = (env["ORB_NOTCH_METER"] ?? "").split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
        guard v.count == 3 else { return }
        let footNow = orb.previewNotchFootText
        let fillNow = orb.previewNotchMeterFill
        let wantFill = CGFloat(v[1] / max(v[2], v[1]))
        var asleepFill: CGFloat = -1
        let wantChip = TransportFormat.minutes(v[1])
        let wantFoot = "\(OrbStyle.mmss(v[0] + (CACurrentMediaTime() - launchedAt))) · \(TransportFormat.minutes(v[1])) · \(TransportFormat.dollars(v[1])) · today \(TransportFormat.minutes(v[2]))"
        let wantAsleep = "today \(TransportFormat.billed(v[2]))"
        let pauseAt = Double(env["ORB_PAUSE_AT"] ?? "") ?? -1
        let sleepAt = self.sleepAt ?? -1
        // The Pause press counts from `pauseScriptAt` and the fake engine answers with the phase 0.1 s later: the
        // paused reading is 0.4 s after the press on that clock (0.3 s into the paused content), never on `launchedAt`'s.
        let pauseIn = pauseAt + 0.4 - (CACurrentMediaTime() - (pauseScriptAt >= 0 ? pauseScriptAt : launchedAt))
        let judgeAt = max(3.5 - (CACurrentMediaTime() - launchedAt), pauseIn + 0.3, sleepAt + 1.2 - (CACurrentMediaTime() - launchedAt))
        var pausedNote = "paused: not exercised (ORB_PAUSE_AT)", pausedOK = pauseAt < 0
        var asleepNote = "asleep: not exercised (ORB_SLEEP_AT)", asleepOK = sleepAt < 0
        if pauseAt >= 0 {
            DispatchQueue.main.asyncAfter(deadline: .now() + max(0, pauseIn)) { [weak self] in
                guard let self else { return }
                let a = self.orb.previewNotchFootText
                let dim = self.orb.previewNotchFootDim
                let chip = self.orb.previewNotchChips.first { $0.hasPrefix("meter:") } ?? ""
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
                    guard let self else { return }
                    let b = self.orb.previewNotchFootText
                    pausedOK = dim && a.hasPrefix(TransportFormat.minutes(v[1])) && chip == "meter:\(wantChip)" && a.split(separator: "·").first == b.split(separator: "·").first
                    pausedNote = "paused foot '\(a)' dim \(dim ? 1 : 0) chip '\(chip)' frozen \(a.split(separator: "·").first == b.split(separator: "·").first ? 1 : 0)"
                }
            }
        }
        if sleepAt >= 0 {
            DispatchQueue.main.asyncAfter(deadline: .now() + max(0, sleepAt + 0.6 - (CACurrentMediaTime() - launchedAt))) { [weak self] in
                guard let self else { return }
                self.orb.previewNotchHover(true)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
                    guard let self else { return }
                    let f = self.orb.previewNotchFootText
                    asleepFill = self.orb.previewNotchMeterFill
                    asleepOK = f == wantAsleep
                    asleepNote = "asleep foot '\(f)' (want '\(wantAsleep)')"
                }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + max(0.2, judgeAt)) { [weak self] in
            guard let self else { return }
            let chipOK = self.meterPeekChip == wantChip
            let footOK = footNow == wantFoot
            let fillOK = abs(fillNow - wantFill) <= 0.01 && (sleepAt < 0 || abs(asleepFill) < 0.001)
            self.check(chipOK && footOK && pausedOK && asleepOK && fillOK, "meter: peek chip \"2.3 min\" in session; paused α 0.48 frozen; foot \"4:12 · 2.3 min · $0.12 · today 12.3 min\"; asleep foot \"today 12.3 min · $0.62\"; bar fill 138/738 = 0.19 ±0.01; asleep fill 0",
                       "peek chip '\(self.meterPeekChip)' (want '\(wantChip)'); foot '\(footNow)' (want '\(wantFoot)'); \(pausedNote); \(asleepNote); " + String(format: "fill %.3f (want %.3f) asleep fill %.3f", fillNow, wantFill, asleepFill))
        }
    }

    /// ORB_NOTCH_OPEN_TIMING: the open spring's value from the hover, sampled in `watch`.
    private func openTimingCheck() {
        let half = notchOpenHalfAt, nine = notchOpenNineAt
        let ok = half >= 0 && half <= 0.060 && nine >= 0 && nine <= 0.130 && notchOpenHitAt0 > 0
        check(ok, "open ≥ 0.5 by 60 ms, ≥ 0.9 by 130 ms; controls hit-testable at 0 ms",
              String(format: "0.5 at %.0f ms, 0.9 at %.0f ms (crossings interpolated between 60 Hz frames), %d hit rects at 0 ms", half * 1000, nine * 1000, notchOpenHitAt0))
    }

    /// ORB_REDUCE_MOTION: the content samples taken through the open, the pulse, the spring's overshoot.
    private func reduceMotionCheck() {
        let noRise = reduceSamples.allSatisfy { $0.dy.allSatisfy { abs($0) < 0.01 } }
        let noStagger = reduceSamples.allSatisfy { s in s.alpha.allSatisfy { abs($0 - s.alpha[0]) < 0.001 } }
        let pulse = orb.previewNotchPulse
        let noOvershoot = notchMaxIslandHeight <= NotchGeometry.islandHeight + 0.5
        check(noRise && noStagger && abs(pulse - 0.5) < 0.001 && noOvershoot && reduceSamples.count > 0, "reduce motion → no rise, no stagger, spring ratio 1.0, pulse held 0.5",
              String(format: "%d samples, rise %@, stagger %@, pulse %.2f, island height peak %.1f (no overshoot = ratio 1.0)", reduceSamples.count, noRise ? "none" : "seen", noStagger ? "none" : "seen", pulse, notchMaxIslandHeight))
    }

    /// From `watch()`: the open's timing, the island's peak height, the reduce-motion samples, the kind-change beats.
    func watchNotchSurface(now: Double) {
        if let raw = orb.previewNotchIslandRaw { notchMaxIslandHeight = max(notchMaxIslandHeight, raw.height) }
        if kindSwapAt >= 0, !kindSwapJudged {
            let dt = now - kindSwapAt
            var alphas: [CGFloat] = []
            for i in 0..<6 { alphas.append(orb.previewNotchContentAppearance(i)?.alpha ?? -1) }
            // A frame with the content not drawn at all (the island folded) is no sample.
            if alphas.count == 6, !alphas.contains(-1) { kindSwapSamples.append((dt, alphas)) }
            if dt > 0.55 { kindSwapJudged = true; kindSwapCheck() }
        }
        if orb.previewNotchMode == "island", reduceSamples.count < 40, orb.previewNotchContentClock.contains("reduced 1") {
            var alphas: [CGFloat] = [], dys: [CGFloat] = []
            for i in 0..<6 {
                guard let a = orb.previewNotchContentAppearance(i) else { break }
                alphas.append(a.alpha); dys.append(a.dy)
            }
            if alphas.count == 6, alphas[0] < 0.999 { reduceSamples.append((alphas, dys)) }
        }
        if traceProbe != nil { watchTraceProbe(phase: orb.previewFlightPhase, tucked: orb.previewIsTucked, now: now) }
        // The mark's own echo brought the blob home: the return shot, and the restored pin.
        if markTraceSentAt >= 0, !markTraceOut, !orb.previewIsTucked { markTraceOut = true }
        if markTraceSentAt >= 0, markTraceOut, orb.previewIsTucked, !markTraceHomeSeen {
            markTraceHomeSeen = true
            print(stamp, String(format: "mark echo: blob home %.2f s after the trace; pinned %d (before Circle %@)", now - markTraceSentAt, orb.previewNotchPinned ? 1 : 0, pinnedBeforeCircle.map { "\($0 ? 1 : 0)" } ?? "n/a"))
            fflush(stdout)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
                guard let self else { return }
                self.notchShot("mark-return", note: "home after outlining the circle; pinned \(self.orb.previewNotchPinned ? 1 : 0), mode \(self.orb.previewNotchMode)")
                if self.pinnedBeforeCircle == true {
                    self.check(self.orb.previewNotchPinned && self.orb.previewIsTucked, "pinned before Circle → pinned again after the mark (parked)",
                               "pinned \(self.orb.previewNotchPinned ? 1 : 0) tucked \(self.orb.previewIsTucked ? 1 : 0) mode \(self.orb.previewNotchMode)")
                }
            }
        }
    }

    /// ORB_NOTCH_LINE_AT: the line lands (the snapshot's transcript), and the hero's swap is read 0.3 s on: exactly one
    /// animated swap since, from the hero before to this line, at the landing — with the island open. Before, the key was
    /// compared in `content.didSet` with the old `lastLine`, so the swap fired on the next counter tick with old = new;
    /// and after any kind change on an open island (`canvasChangedAt` never reset) it never fired again.
    private func heroLineLands(_ text: String) {
        ensureIslandOpen()
        let before = orb.previewNotchLineText
        let swapsBefore = orb.previewNotchHeroSwaps.count
        let landedAt = CACurrentMediaTime()
        let nowMs = Date().timeIntervalSince1970 * 1000
        state.snapshot.transcript.append(TranscriptItem(id: "t_lands_\(Int(nowMs))", speaker: .jarhead, text: text, startMs: 0, endMs: 1000, at: nowMs, final: true))
        print(stamp, "notch: a line lands with the island \(orb.previewNotchMode): '\(text)' (hero was '\(before)')")
        fflush(stdout)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            guard let self else { return }
            let swaps = Array(self.orb.previewNotchHeroSwaps.dropFirst(swapsBefore))
            let swap = swaps.last
            // What left is the lines as wrapped (the last may end in …): the hero before, or its head.
            func left(_ from: String, is hero: String) -> Bool { from == hero || (from.hasSuffix("…") && hero.hasPrefix(String(from.dropLast()))) }
            let ok = swaps.count == 1 && swap.map { left($0.from, is: before) && $0.to == text && $0.from != $0.to && $0.at >= landedAt && $0.at - landedAt < 0.1 } == true
                && self.orb.previewNotchLineText == text
            self.check(ok, "a line lands on the open island → one animated hero swap at the landing (old = the hero before, new = the line), also after a kind change's window",
                       "hero now '\(self.orb.previewNotchLineText)'; swaps since \(swaps.count): " + swaps.map { String(format: "'%@' → '%@' at +%.0f ms", $0.from, $0.to, ($0.at - landedAt) * 1000) }.joined(separator: "; "))
        }
    }

    /// ORB_NOTCH_KIND_AT: beats 1–4 dip (a sample under 0.5 within `Motion.quick` + a frame) then are back at 1 by the
    /// end of the window; beats 0 and 5 never leave 1 ± 0.02. Then, with the new kind laid out, the Console box's
    /// tooltip when `◎ N` joined the hit list (marks kind → plain with marks).
    private func kindSwapCheck() {
        consoleTooltipCheck(hits: orb.previewNotchHitList)
        let quick = Motion.quick + 0.04
        let display = [1, 2, 3, 4], held = [0, 5]
        let dipped = display.allSatisfy { i in kindSwapSamples.contains { $0.t <= quick && $0.alpha[i] >= 0 && $0.alpha[i] < 0.5 } }
        let rose = display.allSatisfy { i in (kindSwapSamples.last?.alpha[i] ?? 0) > 0.98 }
        let holds = held.allSatisfy { i in kindSwapSamples.allSatisfy { abs($0.alpha[i] - 1) <= 0.02 } }
        let lows = display.map { i in kindSwapSamples.map { $0.alpha[i] }.min() ?? -1 }
        let heldRange = held.map { i in (kindSwapSamples.map { $0.alpha[i] }.min() ?? -1, kindSwapSamples.map { $0.alpha[i] }.max() ?? -1) }
        check(dipped && rose && holds && kindSwapSamples.count >= 6, "kind change while open → beats 1–4 alpha dip within quick then rise; beats 0 and 5 within ±0.02",
              String(format: "%d samples over %.2f s; display lows %@; anchor/foot ranges %@; end %@", kindSwapSamples.count, kindSwapSamples.last?.t ?? 0,
                     lows.map { String(format: "%.2f", $0) }.joined(separator: "/"), heldRange.map { String(format: "%.2f–%.2f", $0.0, $0.1) }.joined(separator: " "),
                     (kindSwapSamples.last?.alpha ?? []).map { String(format: "%.2f", $0) }.joined(separator: "/")))
    }

    /// "… | open 0.412→1" → 0.412.
    static func openValue(_ springs: String) -> Double {
        guard let range = springs.range(of: "open ") else { return 0 }
        let tail = springs[range.upperBound...]
        let value = tail.prefix { $0 != "→" }
        return Double(value.trimmingCharacters(in: .whitespaces)) ?? 0
    }

    /// One pixel of the notch panel as drawn (rgb 0…1, alpha), at a point in the open island's
    /// coordinates (x/y from its top-left): the panel's layer rendered at 2×, flipped as the view is.
    func notchPixel(island p: NSPoint) -> (r: Double, g: Double, b: Double, a: Double)? {
        guard let np = orb.previewNotchPanelCG, let ic = orb.previewNotchIslandCG else { return nil }
        let scale: CGFloat = 2
        let w = Int(np.width * scale), h = Int(np.height * scale)
        guard w > 0, h > 0, let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h, bitsPerSample: 8, samplesPerPixel: 4,
                                                       hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
              let gctx = NSGraphicsContext(bitmapImageRep: rep) else { return nil }
        let cg = gctx.cgContext
        cg.scaleBy(x: scale, y: scale)
        cg.translateBy(x: 0, y: np.height)
        cg.scaleBy(x: 1, y: -1)
        orb.previewFreeze(true)
        orb.previewRenderNotch(in: cg)
        orb.previewFreeze(false)
        let x = Int(((ic.minX - np.minX) + p.x) * scale), y = Int(((ic.minY - np.minY) + p.y) * scale)
        guard x >= 0, y >= 0, x < w, y < h, let c = rep.colorAt(x: x, y: y) else { return nil }
        return (Double(c.redComponent), Double(c.greenComponent), Double(c.blueComponent), Double(c.alphaComponent))
    }
}

/// An `orb.trace` under the harness's eye: when it went, when its work ended, when the blob parked.
struct TraceProbe {
    let reason: String
    let sentAt: Double
    let tuckedBefore: Bool
    var doneAt: Double
    var parkedAt: Double
    var judged: Bool
}

/// A flight target for the eye: a ring in the acting colour with a dot at the point.
final class TargetRingView: NSView {
    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
    }

    required init?(coder: NSCoder) { fatalError("TargetRingView is code-only") }

    override func draw(_ dirtyRect: NSRect) {
        guard let cg = NSGraphicsContext.current?.cgContext else { return }
        let c = CGPoint(x: bounds.midX, y: bounds.midY)
        let acting = OrbPalette.acting
        cg.setStrokeColor(acting.cgColor(alpha: 0.9))
        cg.setLineWidth(2)
        cg.strokeEllipse(in: CGRect(x: c.x - 10, y: c.y - 10, width: 20, height: 20))
        cg.setFillColor(acting.cgColor(alpha: 0.9))
        cg.fillEllipse(in: CGRect(x: c.x - 2, y: c.y - 2, width: 4, height: 4))
    }
}
#endif
