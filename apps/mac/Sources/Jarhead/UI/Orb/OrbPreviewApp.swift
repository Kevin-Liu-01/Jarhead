#if JARHEAD_ORB_PREVIEW
import AppKit
import Combine
import QuartzCore

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
//                          and the blob must go home, not adopt the hover spot
//   ORB_HIDE_AT / ORB_SHOW_AT=s   hide() / show() the orb at those times, printing the flight phase and
//                          where the body is (hide mid-flight: it must reappear on its perch, flight over)
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
//                          1.2 s into each phase, rest when it settles, expanded with ORB_EXPAND,
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
//                          ORB_SHOT_DIR, screenshots fly-outbound (in flight, trail behind),
//                          fly-hover (parked by the target) and fly-home (drifting back),
//                          framed to take in the perch, the target and the ghosts; prints
//                          the flight phase, speed and ghost count as it goes, each take-off's
//                          landing spot, and after each command the hover left / whether it is
//                          waiting for Kevin's own throw to land (ORB_FLING just before it)
//   ORB_FLY_HOME=1         send orb.home ORB_FLY_HOME_AT s after the last orb.fly (default 1.0)
//   ORB_REDUCE_MOTION=1    pretend the system's reduce-motion is on (no trail, softer cues)

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

    var shotDir: String?
    var shotPrefix = "preview-blob-"
    var shotPress = 0.3
    var squishShots = 0
    var lastShotAt = 0.0
    var phaseShotTaken = false
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

    func applicationDidFinishLaunching(_ notification: Notification) {
        let env = ProcessInfo.processInfo.environment
        let x = Double(env["ORB_X"] ?? "") ?? 200
        let y = Double(env["ORB_Y"] ?? "") ?? 200
        let perPhase = Double(env["ORB_PHASE_SECONDS"] ?? "") ?? 2.5
        if let list = env["ORB_PHASES"] {
            let parsed = list.split(separator: ",").compactMap { Phase(rawValue: String($0).trimmingCharacters(in: .whitespaces)) }
            if !parsed.isEmpty { phases = parsed }
        }
        shotDir = env["ORB_SHOT_DIR"]
        shotPrefix = env["ORB_SHOT_PREFIX"] ?? "preview-blob-"
        shotPress = Double(env["ORB_SHOT_PRESS"] ?? "") ?? 0.3
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
        }
        state.openConsoleHandler = { print("openConsole()") }
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
        overlay = OverlayManager(state: state)
        overlay.start()
        orb.show()
        if env["ORB_HIDE"] == "1" { orb.hide(); overlay.stop() }
        print("orb visible:", orb.isVisible, "at CG", x, y, "backdrop:", backdrop?.frame ?? .zero)
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
                self.state.levels = levels
            }
        })

        // Watch the body: log its travels, and take the squish / phase / rest shots.
        timers.append(Timer.scheduledTimer(withTimeInterval: 1 / 60, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.watch() }
        })

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
                print("expanded (flight was \(self.lastFlightPhase); goes home on collapse: \(self.orb.previewHomeAfterCollapse))")
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
        if let spec = env["ORB_FLY"] {
            flyTargets = spec.split(separator: ";").compactMap { pair -> CGPoint? in
                let p = pair.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
                return p.count == 2 ? CGPoint(x: p[0], y: p[1]) : nil
            }
            let at = Double(env["ORB_FLY_AT"] ?? "") ?? 1.2
            let every = Double(env["ORB_FLY_EVERY"] ?? "") ?? 2.0
            let dwell = Double(env["ORB_FLY_DWELL"] ?? "") ?? 2000
            if shotDir != nil { flyShotsOwed = ["outbound", "hovering", "homing"] }
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
                    self.state.overlayCommands.send(.orbFly(x: target.x, y: target.y, dwellMs: dwell, reason: "preview \(i + 1)"))
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
        DispatchQueue.main.asyncAfter(deadline: .now() + exitAfter) {
            print("preview: exiting")
            NSApp.terminate(nil)
        }
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
        if phase != lastFlightPhase {
            print(stamp, String(format: "flight: %@ -> %@ at CG %.0f,%.0f speed %.0f ghosts %d", lastFlightPhase, phase, frame.midX, frame.midY,
                         orb.previewBodySpeed, orb.previewGhostFrames.count))
            fflush(stdout)
            lastFlightPhase = phase
            flightPhaseSince = now
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
            print(stamp, String(format: "settled: CG %.0f,%.0f (%@)", frame.minX, frame.minY, phase))
            fflush(stdout)
        }
        wasMoving = moving

        guard let dir = shotDir else { return }
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
        } else if !moving, !phaseShotTaken, Date().timeIntervalSince(phaseStart) > 1.2 {
            phaseShotTaken = true
            shoot("\(dir)/\(shotPrefix)phase-\(state.snapshot.phase.rawValue).png", note: state.snapshot.phase.rawValue)
        }
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
            name = "outbound"
            if let target { include(target) }
            for g in ghosts { include(cg(g)) }
        case "hovering":
            guard since > 0.45 else { return false }
            name = "hover"
            if let target { include(target) }
        case "homing":
            guard since > 0.3, speed > 150 || since > 0.8 else { return false }
            name = "home"
            for g in ghosts { include(cg(g)) }
            if let perch = orb.previewPerchCG {
                let s = OrbPanelController.collapsedSize
                include(CGRect(x: perch.x - s.width / 2, y: perch.y - s.height / 2, width: s.width, height: s.height))
            }
        default:
            return false
        }
        flyShotsOwed.remove(phase)
        lastShotAt = now
        shoot("\(dir)/\(shotPrefix)fly-\(name).png", note: String(format: "%@, speed %.0f, %d ghosts", phase, speed, ghosts.count), extra: extra)
        return true
    }

    /// Freeze everything, capture the panel plus a margin of desktop, let go.
    /// `screencapture -R` needs the Screen Recording grant for whatever launched the
    /// harness; without it (ORB_SHOT_INPROCESS=1, or when screencapture fails) the
    /// shot is drawn by this process instead — the backdrop colour, then the panel's
    /// own layer tree — which shows the orb exactly and nothing of the desktop.
    /// `extra` (CG) widens the region to take in more than the panel.
    private func shoot(_ path: String, note: String, extra: CGRect? = nil) {
        orb.previewFreeze(true)
        defer { orb.previewFreeze(false) }
        var f = orb.previewFrameCG.insetBy(dx: -48, dy: -48)
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
        if ProcessInfo.processInfo.environment["ORB_SHOT_INPROCESS"] != "1" {
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
        // Flight targets (rings) and the wake, under the blob, as on screen.
        let acting = OrbPalette.acting
        for t in flyTargets {
            let c = CGPoint(x: t.x - f.minX, y: (mainMaxY - t.y) - regionAK.minY)
            cg.setStrokeColor(acting.cgColor(alpha: 0.9))
            cg.setLineWidth(2)
            cg.strokeEllipse(in: CGRect(x: c.x - 10, y: c.y - 10, width: 20, height: 20))
            cg.setFillColor(acting.cgColor(alpha: 0.9))
            cg.fillEllipse(in: CGRect(x: c.x - 2, y: c.y - 2, width: 4, height: 4))
        }
        orb.previewRenderTrail(in: cg, offset: regionAK.origin)
        let pf = orb.previewPanelFrame
        cg.saveGState()
        cg.translateBy(x: pf.minX - regionAK.minX, y: pf.minY - regionAK.minY)
        orb.previewRender(in: cg)
        cg.restoreGState()
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
