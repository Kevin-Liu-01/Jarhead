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
        }
        state.openConsoleHandler = { print("openConsole()") }
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
            if shotDir != nil { notchShotsOwed = ["tucked", "peek", "island", "drop", "tuck-staging", "tuck-slip-mid", "tuck-slip-late", "drop-early"] }
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
                print(self.stamp, self.orb.previewNotchStripProbe ?? "notch strip probe: no dock (set ORB_NOTCH=1)")
                fflush(stdout)
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
            fleetThreads.append(WorkThread(id: id, name: name, lane: lane, status: status, parentId: "main", parentDelegationId: "d1", liveId: "live_1",
                                           task: "preview: \(name)", detail: nil, apps: app.map { [$0] } ?? [], app: app, at: at,
                                           startedAt: nowMs - 3000, updatedAt: nowMs, doneAt: nil, turns: 1, steps: 3, waits: 0,
                                           budget: WorkThread.Budget(steps: 25, seconds: 180), question: nil, currentDelegationId: "d_\(name.lowercased())",
                                           lastScreenshotPath: nil, canSay: true, canStop: true))
        }
        guard !fleetThreads.isEmpty else { print("ORB_FLEET: nothing parsed from \(spec); want Name:lane:status[@x,y][:app]; …"); return }
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
                    var threads = self.state.snapshot.threads ?? []
                    threads.append(record)
                    self.fleetThreads.append(record)
                    print(self.stamp, "fleet: late thread \(name) (\(status.rawValue)) joins; \(self.fleetCounts)")
                    fflush(stdout)
                    self.state.snapshot.threads = threads
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
                    guard let self, var threads = self.state.snapshot.threads, let i = threads.firstIndex(where: { $0.id == id }) else { return }
                    threads[i].status = status
                    threads[i].updatedAt = Date().timeIntervalSince1970 * 1000
                    if !status.isLive { threads[i].doneAt = threads[i].updatedAt }
                    if status == .waitingKevin { threads[i].question = "send it to Ben with the Q3 numbers attached?" }
                    print(self.stamp, "fleet: \(name) status -> \(status.rawValue)")
                    fflush(stdout)
                    self.state.snapshot.threads = threads
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
        shoot("\(dir)/\(shotPrefix)notch-\(name)\(notchShotTag).png", note: note + ", island \(orb.previewNotchIslandCG.map { "\(Int($0.width))×\(Int($0.height))" } ?? "nil"), face [\(orb.previewFace)]", region: region, inProcess: true)
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
