import AppKit
import Combine
import QuartzCore
import SwiftUI

/// The floating presence: a frameless, non-activating panel that hosts the ASCII
/// blob, grows into a capsule on click, and remembers where Kevin put it. It never
/// takes keyboard focus from whatever he was typing in — with one exception: a click
/// into the capsule's passphrase field makes the panel key for exactly as long as the
/// field holds focus (see `OrbPanel` and `releaseKey`).
///
/// The blob is a fluid body (`BlobBody`): dragging it pulls it along on a short
/// spring, letting go keeps the momentum, and it bounces off the work-area edges and
/// other windows, squishing on impact. The panel window follows the body every
/// display frame, so the blob really travels across the screen.
///
/// It also flies to the work. An `orb.fly` on `state.overlayCommands` sends it from
/// its perch to a point on the screen (parking up-left of it, never on it): a short
/// wind-up (it turns the acting colour and tenses), then the flight spring — one
/// overshoot, one squish, a ripple on arrival — and it hovers beside the work for the
/// command's dwell (counted from being parked; a repeat fly to the same spot only
/// extends it) before drifting home on a gentler spring; `orb.home` brings it back at
/// once. The perch is the last spot Kevin put it (the persisted `orbPosition`); a
/// flight never persists where it landed, opening the capsule mid-flight parks it
/// until the capsule closes (then it goes home), and only a drag makes a new spot
/// home. A fly that arrives while Kevin's own throw is still gliding waits for it to
/// land. In flight it wears the acting colour, shimmers faster and trails a dotted
/// wake of itself (`BlobTrail`).
@MainActor
public final class OrbPanelController {
    public let state: AppState

    static let collapsedSize = BlobMetrics.panelSize
    static let expandedSize = NSSize(width: 452, height: 240)

    private let panel: OrbPanel
    private let container = NSView()
    /// The collapsed-size cell: the blob field with the status pill over its foot.
    private let blobCell = NSView()
    private let blobView: BlobFieldView
    private let pillHost: OrbPillHostingView
    private let capsuleHost: OrbCapsuleHostingView
    private let body: BlobBody
    private let statusModel = OrbStatusModel()
    private let capsuleModel = OrbCapsuleModel()
    private let menuTarget = OrbMenuTarget()
    /// The wake gate's pill (question, verdict, countdown); ranks under a problem, over a toast.
    private let gatePill = CurrentValueSubject<OrbPill?, Never>(nil)
    /// Takes the "Not this time" pill down after 1.5 s; the gate itself stays denied for its cooldown.
    private var deniedPillTimer: Task<Void, Never>?
    /// The passphrase field's frame in the capsule's SwiftUI space (y down from the
    /// host's top-left, `OrbCapsuleView.space`); nil when not showing.
    private var fieldFrame: CGRect?

    private var expanded = false
    private var characterOnRight = false
    private var cancellables = Set<AnyCancellable>()
    private var persistDebounce: Task<Void, Never>?
    private var observers: [NSObjectProtocol] = []
    /// Live only while the capsule is open: any click outside the panel collapses it.
    private var dismissMonitors: [Any] = []
    private var positioned = false
    private var userMoved = false

    // Pointer tracking for the drag / tap distinction.
    private var downPoint: CGPoint?
    private var downTime: TimeInterval = 0
    private var dragMoved = false
    private var lastScan = 0.0
    private var scanning = false
    private var frozen = false

    // Flights (orb.fly / orb.home).
    /// Where an `orb.fly` is: on the way out, parked beside the target, on the way back.
    private enum Flight: Equatable { case none, outbound, hovering, homing }
    private var flight = Flight.none
    /// The CG centre the blob calls home: the last user-placed (persisted) position.
    private var perch: CGPoint?
    private var flightTarget: CGPoint?
    private var flightDwell = 2.0
    /// CACurrentMediaTime deadline for the hover; each new orb.fly, the arrival and the park push it out.
    private var hoverUntil = 0.0
    private var hoverTimer: Task<Void, Never>?
    /// The launch, a wind-up after the command so the blob visibly tenses and turns colour first.
    private var takeoff: DispatchWorkItem?
    static let windup = 0.14
    /// An `orb.fly` that arrived while Kevin's own motion (a drop, a fling, a summon, a
    /// poke) was still gliding: it fires once that has landed and become the perch.
    private struct PendingFly { var target: CGPoint; var dwellMs: Double?; var reason: String?; var expires: Double }
    private var pendingFly: PendingFly?
    /// The capsule opened mid-flight: the flight is parked, and closing the capsule
    /// sends the blob home instead of making the capsule's spot the perch.
    private var homeAfterCollapse = false
    private let trail: BlobTrail

    private var sim: BlobSim { blobView.sim }

    public init(state: AppState) {
        self.state = state

        let c = Self.collapsedSize
        panel = OrbPanel(
            contentRect: NSRect(origin: .zero, size: c),
            styleMask: [.nonactivatingPanel, .borderless, .fullSizeContentView],
            backing: .buffered, defer: false)
        // Floating: over every app (and full-screen spaces, via the collection
        // behaviour) but under system alerts, the TCC prompts and our own menus.
        // .screenSaver would paint over all of those.
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        // Dragging is ours: the body follows the pointer through physics, not the window server.
        panel.isMovableByWindowBackground = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.isReleasedWhenClosed = false
        panel.animationBehavior = .none
        panel.title = "Jarhead"

        container.wantsLayer = true
        container.layer?.backgroundColor = .clear
        panel.contentView = container

        blobCell.frame = NSRect(origin: .zero, size: c)
        // The glow layer under the glyphs, then the glyphs, then the pill.
        let haloView = BlobHaloView(frame: blobCell.bounds)
        haloView.autoresizingMask = [.width, .height]
        blobCell.addSubview(haloView)
        blobView = BlobFieldView(frame: blobCell.bounds)
        blobView.autoresizingMask = [.width, .height]
        blobView.halo = haloView
        blobCell.addSubview(blobView)
        pillHost = OrbPillHostingView(rootView: OrbPillView(status: statusModel))
        pillHost.frame = blobCell.bounds
        pillHost.autoresizingMask = [.width, .height]
        blobCell.addSubview(pillHost)
        container.addSubview(blobCell)

        // Actions are wired after `self` exists (see below).
        capsuleHost = OrbCapsuleHostingView(rootView: OrbCapsuleView(model: capsuleModel, actions: OrbCapsuleActions()))
        capsuleHost.isHidden = true
        container.addSubview(capsuleHost)

        body = BlobBody(size: c, center: CGSpace.point(fromAppKit: NSPoint(x: panel.frame.midX, y: panel.frame.midY)))
        trail = BlobTrail(size: c)
        sim.reducedMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion

        capsuleHost.rootView = OrbCapsuleView(model: capsuleModel, actions: OrbCapsuleActions(
            toggleAwake: { [weak self] in self?.toggleAwake() },
            toggleMute: { [weak self] in self?.toggleMute() },
            stop: { [weak self] in self?.state.send(.stop) },
            openConsole: { [weak self] in self?.state.openConsole() },
            collapse: { [weak self] in self?.collapse() },
            submitPassphrase: { [weak self] phrase in self?.state.wakeActions.submitPassphrase(phrase) },
            cancelAuth: { [weak self] in self?.state.wakeActions.cancelAuth() },
            fieldFocus: { [weak self] focused in if !focused { self?.releaseKey() } },
            fieldFrame: { [weak self] frame in self?.fieldFrame = frame }))

        panel.onMouseDown = { [weak self] event in self?.mouseDown(event) ?? false }
        panel.keyRequired = { [weak self] point in self?.clickNeedsKey(windowPoint: point) ?? false }
        panel.onMouseDragged = { [weak self] event in self?.mouseDragged(event) }
        panel.onMouseUp = { [weak self] event in self?.mouseUp(event) }
        panel.onRightClick = { [weak self] event in self?.showMenu(for: event) }

        blobView.tick = { [weak self] dt in self?.physicsTick(dt) ?? false }
        body.onSettle = { [weak self] in self?.bodyDidSettle() }
        body.onImpact = { [weak self] speed in
            guard let self else { return }
            self.sim.nudge(min(2.0, 0.4 + speed / 900))
            self.blobView.poke()
        }
        body.onArrive = { [weak self] in self?.bodyDidArrive() }

        bind()
    }

    deinit {
        // Block-based NotificationCenter observers and NSEvent monitors are not removed
        // for us (only selector-based observers are, since 10.11). Moot while the app
        // delegate owns the one controller for the process lifetime, but the pattern
        // gets copied.
        for o in observers { NotificationCenter.default.removeObserver(o) }
        for m in dismissMonitors { NSEvent.removeMonitor(m) }
        persistDebounce?.cancel()
        deniedPillTimer?.cancel()
        hoverTimer?.cancel()
        takeoff?.cancel()
    }

    // MARK: - Public API (fixed signature)

    public func show() {
        if !positioned { placeInitially() }
        blobView.paused = false
        panel.orderFrontRegardless()
        statusModel.shown = true
        blobView.poke()
    }

    public func hide() {
        collapse()
        pendingFly = nil
        if flight != .none {
            // Cut the flight short and put the body back on its perch now, so it
            // reappears where Kevin left it: a goal spring left armed would fly on
            // after show() and persist its landing spot as the perch.
            cancelFlight()
            if let perch { placeBody(centerCG: perch) }
        }
        blobView.paused = true
        statusModel.shown = false
        panel.orderOut(nil)
    }

    public func toggleExpanded() {
        if expanded { collapse() } else { expand() }
    }

    /// Fling the blob to the cursor (landing slightly above it) with a bounce. Kevin
    /// calling it over ends any flight: where it lands is the new perch.
    public func summon() {
        // A capsule opened mid-flight starts the drift home as it folds; Kevin's call cuts that short too.
        if expanded { collapse() }
        cancelFlight()
        pendingFly = nil
        if !positioned { placeInitially() }
        let mouse = CGSpace.point(fromAppKit: NSEvent.mouseLocation)
        let goal = CGPoint(x: mouse.x, y: mouse.y - 40)
        blobView.paused = false
        panel.orderFrontRegardless()
        statusModel.shown = true
        userMoved = true
        body.summon(to: goal)
        sim.nudge(1.5)
        scanObstacles(force: true)
        blobView.poke()
    }

    public var isVisible: Bool { panel.isVisible }

    // MARK: - State binding

    private func bind() {
        state.$snapshot
            .map(\.phase)
            .removeDuplicates()
            .sink { [weak self] phase in
                guard let self else { return }
                self.sim.setPhase(phase)
                self.blobView.poke()
            }
            .store(in: &cancellables)

        state.$levels
            .sink { [weak self] levels in
                guard let self else { return }
                self.sim.setLevels(levels)
                if levels.input > 0.02 || levels.output > 0.02 { self.blobView.poke() }
            }
            .store(in: &cancellables)

        // Derived models: only distinct changes reach SwiftUI (levels never do).
        state.$snapshot.removeDuplicates()
            .sink { [weak self] snap in self?.capsuleModel.snapshot = snap }
            .store(in: &cancellables)
        state.$connected.removeDuplicates()
            .sink { [weak self] v in self?.capsuleModel.connected = v }
            .store(in: &cancellables)
        state.$daemonDetail.removeDuplicates()
            .sink { [weak self] v in self?.capsuleModel.daemonDetail = v }
            .store(in: &cancellables)
        // The wake word gate: colours and cues on the blob, the row in the capsule,
        // the question / verdict / countdown in the pill.
        state.$wakeGate
            .removeDuplicates()
            .sink { [weak self] gate in self?.gateChanged(gate) }
            .store(in: &cancellables)
        state.$wakeHeard
            .removeDuplicates()
            .sink { [weak self] heard in
                guard let self else { return }
                // The calibration cue: something new was heard. One cell, at most.
                if !heard.isEmpty { self.sim.rippleHeard(); self.blobView.poke() }
                // The capsule's ear only while it is open, so a hidden capsule never lays out for a transcript.
                if self.expanded { self.capsuleModel.wakeHeard = heard }
            }
            .store(in: &cancellables)
        state.$wakePassphraseSet.removeDuplicates()
            .sink { [weak self] v in self?.capsuleModel.wakePassphraseSet = v }
            .store(in: &cancellables)

        // The pill: the first problem, else the gate, else the latest toast. The gate
        // outranks toasts because its lockout toast and countdown arrive together and
        // the countdown is the one worth the space.
        Publishers.CombineLatest3(
            state.$snapshot.map(\.problems.first).removeDuplicates(),
            gatePill.removeDuplicates(),
            state.$toasts.map(\.last).removeDuplicates())
            .map { problem, gate, toast -> OrbPill? in
                if let p = problem { return OrbPill(text: p, tone: .error) }
                if let g = gate { return g }
                if let t = toast { return OrbPill(text: t.text, tone: t.tone) }
                return nil
            }
            .removeDuplicates()
            .sink { [weak self] pill in
                guard let self else { return }
                self.statusModel.pill = pill
                // The blob lifts a little off its foot so the pill has room.
                self.sim.lift = pill == nil ? 0 : 1.2
                self.blobView.poke()
            }
            .store(in: &cancellables)

        // A saved position that arrives after show() (first snapshot) still wins,
        // as long as Kevin has not moved the orb himself in the meantime.
        state.$snapshot
            .map(\.settings.orbPosition)
            .removeDuplicates()
            .compactMap { $0 }
            .sink { [weak self] pos in
                guard let self, !self.userMoved, !self.expanded, !self.body.isActive, self.flight == .none else { return }
                self.apply(savedPosition: pos)
            }
            .store(in: &cancellables)

        // Flights. The overlay layer draws the shapes; the blob answers only these two.
        state.overlayCommands
            .receive(on: DispatchQueue.main)
            .sink { [weak self] cmd in
                guard let self else { return }
                switch cmd {
                case .orbFly(let x, let y, let dwellMs, let reason):
                    self.fly(to: CGPoint(x: x, y: y), dwellMs: dwellMs, reason: reason)
                case .orbHome:
                    self.flyHome()
                default:
                    break
                }
            }
            .store(in: &cancellables)

        let nc = NotificationCenter.default
        observers.append(nc.addObserver(forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.sim.reducedMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }
        })
        observers.append(nc.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.screensDidChange() }
        })
        // Key status left by any other route (a click in another app): the field's
        // focus ring must not outlive it, and the panel may not take key again on its own.
        observers.append(nc.addObserver(forName: NSWindow.didResignKeyNotification, object: panel, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.panel.keyAllowed = false
                self.capsuleModel.keyLost += 1
            }
        })
    }

    // MARK: - Wake gate

    /// One gate change → the blob (a `BlobGate`), the capsule row, and the pill.
    private func gateChanged(_ gate: WakeGateState) {
        sim.setGate(BlobGate(gate))
        blobView.poke()
        capsuleModel.wakeGate = gate
        deniedPillTimer?.cancel(); deniedPillTimer = nil
        switch gate {
        case .authenticating(let method):
            gatePill.send(OrbPill(text: OrbStyle.gatePrompt(method: method), tone: .info, icon: "lock.fill"))
        case .denied:
            gatePill.send(OrbPill(text: "Not this time", tone: .error, icon: "xmark.circle.fill"))
            deniedPillTimer = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                guard !Task.isCancelled else { return }
                self?.gatePill.send(nil)
            }
        case .lockedOut(let until):
            gatePill.send(OrbPill(text: "Locked", tone: .warn, icon: "lock.slash.fill", until: until))
        case .off, .listening, .heard, .granted:
            gatePill.send(nil)
        }
    }

    // MARK: - Key status (the passphrase field)

    /// True for a click that lands in the passphrase field: the one click that may make
    /// the panel key. Buttons and the blob never do. SwiftUI's field is not an NSView
    /// (the hosting view answers every hit test, and says it needs key), so the field
    /// reports its own frame and the click is tested against that.
    private func clickNeedsKey(windowPoint: NSPoint) -> Bool {
        guard let frame = fieldFrameInWindow, !capsuleHost.isHidden else { return false }
        return frame.insetBy(dx: -2, dy: -2).contains(windowPoint)
    }

    /// The field's frame in window coordinates (AppKit, y up), from what SwiftUI
    /// reported in the capsule's own y-down space.
    private var fieldFrameInWindow: NSRect? {
        guard expanded, let f = fieldFrame else { return nil }
        let h = capsuleHost.bounds.height
        let local = capsuleHost.isFlipped ? f : NSRect(x: f.minX, y: h - f.maxY, width: f.width, height: f.height)
        return capsuleHost.convert(local, to: nil)
    }

    /// Give key status back the moment the field lets go of it, so the next keystroke
    /// lands in whatever Kevin was working in. A non-activating panel has no window of
    /// its own to pass key to: ordering it out returns key to the active app's window,
    /// and ordering it straight back in (regardless, not key) leaves it where it was.
    private func releaseKey() {
        panel.keyAllowed = false
        guard panel.isKeyWindow else { return }
        panel.orderOut(nil)
        panel.orderFrontRegardless()
    }

    /// A display came or went, or moved. A resting body is not stepped, so it would
    /// otherwise stay parked on a display that no longer exists, out of reach until
    /// the next summon; pull it onto the nearest work area now. The panel is re-placed
    /// from the body either way, because the AppKit origin shifts when the primary
    /// display's frame does even though the CG position has not.
    private func screensDidChange() {
        let onScreen = ScreenArea.all().contains { $0.frame.contains(body.center) }
        if !onScreen, expanded { collapse() }
        let moved = body.rescueOntoScreens()
        // A flight to a display that just went away has nowhere to go; the rescue spot is home.
        if moved { cancelFlight() }
        if !expanded {
            sim.setContacts(body.contacts())
            sim.leanX = body.leanX
            sim.leanY = body.leanY
            syncPanelToBody()
            if moved { persistPosition() }
        }
        blobView.poke()
    }

    // MARK: - Position

    private func placeInitially() {
        positioned = true
        if let saved = state.snapshot.settings.orbPosition, apply(savedPosition: saved) { return }
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main ?? NSScreen.screens.first
        let visible = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let size = Self.collapsedSize
        let origin = NSPoint(x: visible.maxX - 24 - size.width, y: visible.minY + 96)
        place(topLeftCG: CGSpace.topLeft(ofAppKitFrame: NSRect(origin: origin, size: size)))
    }

    /// Returns false when the saved point is not on any connected screen.
    @discardableResult
    private func apply(savedPosition pos: OrbPosition) -> Bool {
        let size = Self.collapsedSize
        let topLeft = CGPoint(x: pos.x, y: pos.y)
        let center = CGPoint(x: topLeft.x + size.width / 2, y: topLeft.y + size.height / 2)
        guard ScreenArea.all().contains(where: { $0.frame.contains(center) }) else { return false }
        positioned = true
        place(topLeftCG: topLeft)
        return true
    }

    /// Put the body (and the panel) at a CG top-left, motionless. A placement is a
    /// perch: it is either the saved position or the default spot.
    private func place(topLeftCG p: CGPoint) {
        let size = Self.collapsedSize
        placeBody(centerCG: CGPoint(x: p.x + size.width / 2, y: p.y + size.height / 2))
        perch = body.center
    }

    /// Put the body (and the panel) at a CG centre, motionless, without touching the perch.
    private func placeBody(centerCG c: CGPoint) {
        let size = Self.collapsedSize
        body.teleport(to: c)
        sim.setContacts(body.contacts())
        sim.leanX = body.leanX
        sim.leanY = body.leanY
        panel.setFrame(NSRect(origin: CGSpace.appKitOrigin(topLeft: body.topLeft, size: size), size: size), display: true)
    }

    /// Move the panel to wherever the body is now.
    private func syncPanelToBody() {
        let origin = CGSpace.appKitOrigin(topLeft: body.topLeft, size: Self.collapsedSize)
        let cur = panel.frame.origin
        if abs(origin.x - cur.x) > 0.05 || abs(origin.y - cur.y) > 0.05 {
            panel.setFrameOrigin(origin)
        }
    }

    private func bodyDidSettle() {
        sim.setContacts(body.contacts())
        sim.leanX = body.leanX
        sim.leanY = body.leanY
        syncPanelToBody()
        switch flight {
        case .outbound:
            // Parked beside the target. The dwell is time spent parked here — it
            // counts from now, not from the arrival splat, so the landing wobble
            // never eats it. Nothing is persisted.
            flight = .hovering
            sim.flightMoving = false
            hoverUntil = max(hoverUntil, CACurrentMediaTime() + flightDwell)
            scheduleHoverEnd()
        case .homing:
            // Home again, on the perch it left: nothing changed, nothing to save.
            endFlight(clearTrail: false)
        case .hovering:
            break
        case .none:
            persistPosition()
            // Kevin's throw has landed and is the perch; now the fly that waited for it.
            if let p = pendingFly {
                pendingFly = nil
                if CACurrentMediaTime() < p.expires { fly(to: p.target, dwellMs: p.dwellMs, reason: p.reason) }
            }
        }
    }

    /// Save where the body rests. Only ever a spot Kevin chose (a drop, a fling, a
    /// summon, a rescue) — flights do not come through here — so it is also the perch.
    /// The spot is taken now: a flight that leaves within the debounce (one that was
    /// waiting for this very landing) must not stop the perch being saved, nor be
    /// saved itself.
    private func persistPosition() {
        guard !expanded, flight == .none else { return }
        perch = body.center
        let tl = body.topLeft
        persistDebounce?.cancel()
        persistDebounce = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard let self, !Task.isCancelled else { return }
            self.state.send(.setSettings(SettingsPatch(orbPosition: OrbPosition(x: tl.x, y: tl.y))))
        }
    }

    // MARK: - Flights (orb.fly / orb.home)

    /// Leave the perch for a point on the screen. Refused while Kevin is dragging
    /// (his hand wins) and while the orb is hidden; an open capsule folds first. While
    /// Kevin's own throw is still gliding the fly waits for it to land (that landing
    /// is his perch, and must be saved as such before anything flies). A fly during a
    /// flight retargets it in the air and extends the hover — unless it is the same
    /// work again (the target within a body's radius of the last, or the blob already
    /// parked beside it), when it only extends the hover: relaunching would swing the
    /// blob round the target for nothing.
    private func fly(to target: CGPoint, dwellMs: Double?, reason: String?) {
        guard !body.dragging, panel.isVisible else { return }
        if expanded { collapse() }
        if !positioned { placeInitially() }
        let now = CACurrentMediaTime()
        let dwell = max(0.2, (dwellMs ?? 2000) / 1000)
        if flight == .none, body.isActive {
            pendingFly = PendingFly(target: target, dwellMs: dwellMs, reason: reason, expires: now + dwell + 1.0)
            return
        }
        pendingFly = nil
        if perch == nil { perch = body.center }
        flightDwell = dwell
        hoverUntil = max(hoverUntil, now + dwell)
        if flight == .outbound || flight == .hovering {
            let sameWork = flightTarget.map { hypot(target.x - $0.x, target.y - $0.y) <= body.radius } ?? false
            if sameWork || (flight == .hovering && body.isBeside(target)) {
                flightTarget = target
                blobView.poke()
                return
            }
        }
        flightTarget = target
        hoverTimer?.cancel(); hoverTimer = nil
        flight = .outbound
        // The wind-up: colour, eyes and a tense shiver first (`BlobSim.flight`), the
        // launch a beat later — so it visibly gathers itself and is already green when
        // the wake starts. Already in the air, it just retargets.
        sim.flight = true
        blobView.paused = false
        panel.orderFrontRegardless()
        if body.isActive { takeOff() } else { scheduleTakeoff() }
        blobView.poke()
    }

    private func scheduleTakeoff() {
        takeoff?.cancel()
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.takeOff() }
        }
        takeoff = work
        DispatchQueue.main.asyncAfter(deadline: .now() + (sim.reducedMotion ? 0 : Self.windup), execute: work)
    }

    /// Launch (or retarget) the body toward the spot beside the target. Across
    /// displays the body hops first and picks the spot from where it lands.
    private func takeOff() {
        takeoff = nil
        guard flight == .outbound, !body.dragging, let target = flightTarget else { return }
        sim.flightMoving = true
        #if JARHEAD_ORB_PREVIEW
        let from = body.center
        #endif
        let spot = body.flyBeside(target, spring: .flight)
        #if JARHEAD_ORB_PREVIEW
        print(String(format: "takeoff: from CG %.0f,%.0f (after any hop %.0f,%.0f) -> landing CG %.0f,%.0f beside %.0f,%.0f",
                     from.x, from.y, body.center.x, body.center.y, spot.x, spot.y, target.x, target.y))
        fflush(stdout)
        #endif
        scanObstacles(force: true)
        blobView.poke()
    }

    /// The visible arrival (the turn back toward the landing spot): a ripple runs out
    /// through the surface. The dwell is guaranteed from here as a floor; it really
    /// counts from being parked (`bodyDidSettle`).
    private func bodyDidArrive() {
        guard flight == .outbound else { return }
        sim.rippleLanding()
        hoverUntil = max(hoverUntil, CACurrentMediaTime() + flightDwell)
        blobView.poke()
    }

    private func scheduleHoverEnd() {
        hoverTimer?.cancel()
        hoverTimer = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                guard let self, self.flight == .hovering else { return }
                let remaining = self.hoverUntil - CACurrentMediaTime()
                if remaining <= 0 { self.flyHome(); return }
                try? await Task.sleep(nanoseconds: UInt64(max(0.01, remaining) * 1_000_000_000))
            }
        }
    }

    /// Back to the perch: at once on `orb.home`, or when the hover runs out.
    private func flyHome() {
        guard flight != .none else { return }
        driftHome()
    }

    /// Start the way home from wherever the body is — the tail of a flight, or of one
    /// the capsule interrupted. A gentle spring, no splat: the blob drifting home
    /// behind the work, not racing.
    private func driftHome() {
        hoverTimer?.cancel(); hoverTimer = nil
        takeoff?.cancel(); takeoff = nil
        guard let perch else { endFlight(clearTrail: false); return }
        flight = .homing
        sim.flight = true
        sim.flightMoving = true
        blobView.paused = false
        body.drift(to: perch)
        scanObstacles(force: true)
        blobView.poke()
    }

    /// The flight is over: home, or overtaken by Kevin's hand (a drag, a summon, the
    /// capsule opening, the orb hiding). Cancelled flights take their wake down with them.
    private func endFlight(clearTrail: Bool) {
        hoverTimer?.cancel(); hoverTimer = nil
        takeoff?.cancel(); takeoff = nil
        flight = .none
        flightTarget = nil
        hoverUntil = 0
        sim.flight = false
        sim.flightMoving = false
        if clearTrail { trail.clear() }
        blobView.poke()
    }

    /// Cut a flight short. Nothing of it outlives this: the launch is called off and
    /// the body is stopped where it is (a goal spring left armed would fly on and
    /// settle — and a settle outside a flight is persisted as the perch).
    private func cancelFlight() {
        takeoff?.cancel(); takeoff = nil
        guard flight != .none else { return }
        if body.hasGoal { body.teleport(to: body.center) }
        endFlight(clearTrail: true)
    }

    /// One dotted ghost of the blob where it is now, every `BlobTrail.spacing` while a
    /// flight is actually moving. Never under reduce motion. Always in the flight
    /// colour: the first ghost drops while the field is still easing from the phase
    /// colour, and a purple ghost behind a green blob reads as two creatures.
    private func dropGhostIfDue() {
        guard flight != .none, !sim.reducedMotion, body.speed > 240 else { return }
        let now = CACurrentMediaTime()
        guard now - trail.lastDropAt >= BlobTrail.spacing else { return }
        guard let image = BlobGhostImage.render(cells: sim.cells, ramp: sim.ramp, color: OrbPalette.acting,
                                                size: Self.collapsedSize, scale: panel.backingScaleFactor) else { return }
        trail.drop(image: image, frame: panel.frame, below: panel, at: now)
    }

    // MARK: - Physics loop

    /// One display frame while the body moves. Returns true while it still does.
    private func physicsTick(_ dt: Double) -> Bool {
        guard !expanded, !frozen, body.isActive || body.dragging else { return false }
        let contacts = body.step(dt)
        sim.setContacts(contacts)
        sim.leanX = body.leanX
        sim.leanY = body.leanY
        syncPanelToBody()
        if body.isActive || body.dragging { scanObstacles(force: false) }
        if body.isActive { dropGhostIfDue() }
        return body.isActive || body.dragging
    }

    /// Other windows to squish against and bounce off: refreshed when a drag starts
    /// and every ~500 ms while moving, off the main thread.
    private func scanObstacles(force: Bool) {
        let now = CACurrentMediaTime()
        guard !scanning, force || now - lastScan > 0.5 else { return }
        lastScan = now
        #if JARHEAD_ORB_PREVIEW
        // Deterministic previews: only the harness's injected obstacles count.
        if ProcessInfo.processInfo.environment["ORB_NO_WINDOWS"] == "1" { applyObstacles([]); return }
        #endif
        scanning = true
        let pid = ProcessInfo.processInfo.processIdentifier
        Task.detached(priority: .userInitiated) { [weak self] in
            let found = ObstacleScanner.scan(excludingPID: pid)
            guard let self else { return }
            await self.applyObstacles(found)
        }
    }

    private func applyObstacles(_ found: [Obstacle]) {
        body.obstacles = found + extraObstacles
        scanning = false
    }

    /// Injected by the preview harness (its own windows are excluded from the scan).
    private var extraObstacles: [Obstacle] {
        get { _extraObstacles }
        set { _extraObstacles = newValue; body.obstacles = body.obstacles.filter { $0.id < 0xffff_0000 } + newValue }
    }
    private var _extraObstacles: [Obstacle] = []

    // MARK: - Expanded / collapsed

    private func expand() {
        guard !expanded else { return }
        expanded = true
        // Whatever it was doing, it holds still while the capsule is open. A flight is
        // parked, not forgotten: Kevin double-clicking the blob beside the work to ask
        // about it must not make that spot his perch — the capsule closing sends it home.
        let wasFlying = flight != .none
        cancelFlight()
        pendingFly = nil
        homeAfterCollapse = wasFlying
        body.teleport(to: body.center)
        sim.setContacts(body.contacts())
        syncPanelToBody()

        let f = panel.frame
        let screen = panel.screen ?? NSScreen.main
        let visible = screen?.visibleFrame ?? f.insetBy(dx: -1000, dy: -1000)
        let size = Self.expandedSize
        let c = Self.collapsedSize

        // Grow away from the nearest screen edge so the blob stays exactly where it is.
        characterOnRight = f.maxX + (size.width - c.width) > visible.maxX
        let x = characterOnRight ? f.maxX - size.width : f.minX
        var y = f.midY - size.height / 2
        y = min(max(y, visible.minY), visible.maxY - size.height)
        // Where the blob must sit inside the new frame to keep its screen position.
        let blobY = f.minY - y

        layout(expanded: true, blobY: blobY)
        panel.setFrame(NSRect(x: x, y: y, width: size.width, height: size.height), display: true)
        capsuleModel.wakeHeard = state.wakeHeard
        capsuleModel.shown = true
        capsuleHost.alphaValue = 0
        capsuleHost.isHidden = false
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = reducedMotion ? 0.05 : 0.18
            ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
            capsuleHost.animator().alphaValue = 1
        }
        // No makeKey(): the capsule's buttons work on a non-key panel, and the
        // frontmost app keeps Kevin's keystrokes. Only a click into the passphrase
        // field changes that (OrbPanel.sendEvent), and only until it lets go.
        installDismissMonitors()
        blobView.poke()
    }

    private func collapse() {
        guard expanded else { return }
        expanded = false
        removeDismissMonitors()
        releaseKey()
        capsuleModel.wakeHeard = ""
        // The blob's current screen rect becomes the collapsed frame.
        let cellScreen = panel.convertToScreen(blobCell.convert(blobCell.bounds, to: nil))
        capsuleHost.isHidden = true
        capsuleModel.shown = false
        layout(expanded: false, blobY: 0)
        panel.setFrame(NSRect(origin: cellScreen.origin, size: Self.collapsedSize), display: true)
        let center = CGSpace.point(fromAppKit: NSPoint(x: cellScreen.midX, y: cellScreen.midY))
        body.teleport(to: center)
        sim.setContacts(body.contacts())
        sim.leanX = body.leanX
        sim.leanY = body.leanY
        blobView.poke()
        if homeAfterCollapse {
            // Opened beside the work mid-flight: not a spot Kevin chose. Home it goes.
            homeAfterCollapse = false
            driftHome()
        } else {
            persistPosition()
        }
    }

    private func layout(expanded: Bool, blobY: CGFloat) {
        let c = Self.collapsedSize
        if expanded {
            let e = Self.expandedSize
            let blobX = characterOnRight ? e.width - c.width : 0
            blobCell.frame = NSRect(x: blobX, y: blobY, width: c.width, height: c.height)
            let capW = e.width - c.width - 14
            let capX = characterOnRight ? 10 : c.width + 4
            capsuleHost.frame = NSRect(x: capX, y: 12, width: capW, height: e.height - 24)
        } else {
            blobCell.frame = NSRect(origin: .zero, size: c)
        }
    }

    private var reducedMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

    /// While the capsule is open it collapses on any click outside the panel, in our
    /// app or any other. Mouse monitors need no Accessibility grant. There is no
    /// Escape: the panel is never key, so no key event is ever addressed to it, and
    /// a global key monitor would need an Input Monitoring grant for one shortcut.
    private func installDismissMonitors() {
        removeDismissMonitors()
        #if JARHEAD_ORB_PREVIEW
        // A deterministic capsule for the harness's click tests: Kevin using the Mac
        // during a run would otherwise collapse it mid-test through the global monitor.
        if ProcessInfo.processInfo.environment["ORB_NO_DISMISS"] == "1" { return }
        #endif
        if let m = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown], handler: { [weak self] event in
            MainActor.assumeIsolated {
                if let self, event.window !== self.panel { self.collapse() }
            }
            return event
        }) { dismissMonitors.append(m) }
        if let m = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown], handler: { [weak self] _ in
            MainActor.assumeIsolated { self?.collapse() }
        }) { dismissMonitors.append(m) }
    }

    private func removeDismissMonitors() {
        for m in dismissMonitors { NSEvent.removeMonitor(m) }
        dismissMonitors.removeAll()
    }

    // MARK: - Mouse

    /// Mouse-down on the blob starts tracking: release without moving is a tap
    /// (toggle the capsule); move past the slop and it is a drag that drives the body.
    /// Clicks on the capsule itself fall through to its buttons.
    private func mouseDown(_ event: NSEvent) -> Bool {
        let inContainer = container.convert(event.locationInWindow, from: nil)
        guard blobCell.frame.contains(inContainer) else { return false }
        downPoint = CGSpace.point(fromAppKit: NSEvent.mouseLocation)
        downTime = event.timestamp
        dragMoved = false
        return true
    }

    private func mouseDragged(_ event: NSEvent) {
        guard let down = downPoint else { return }
        let p = CGSpace.point(fromAppKit: NSEvent.mouseLocation)
        if !dragMoved {
            guard hypot(p.x - down.x, p.y - down.y) >= 4 else { return }
            dragMoved = true
            if expanded { collapse() }
            // Kevin's hand ends a flight (and one the capsule had parked, which the
            // collapse just sent home); where he lets go is the new perch. A fly that
            // was waiting for his throw to land is dropped: he has taken over.
            cancelFlight()
            pendingFly = nil
            userMoved = true
            body.beginDrag(pointer: down)
            scanObstacles(force: true)
            blobView.poke()
        }
        body.moveDrag(pointer: p)
    }

    private func mouseUp(_ event: NSEvent) {
        defer { downPoint = nil }
        if dragMoved {
            body.endDrag()
            blobView.poke()
            return
        }
        guard event.timestamp - downTime < 0.6 else { return }
        // A click is play, not a command: it pokes the blob and opens nothing. The
        // capsule is a double-click (or the right-click menu); an open capsule folds
        // on a single click. The poke waits one double-click interval so the first
        // half of a double-click does not send the blob skittering away.
        if expanded {
            collapse()
        } else if event.clickCount >= 2 {
            pendingPoke?.cancel()
            pendingPoke = nil
            expand()
        } else {
            pendingPoke?.cancel()
            let poke = DispatchWorkItem { [weak self] in self?.pokeBlob() }
            pendingPoke = poke
            DispatchQueue.main.asyncAfter(deadline: .now() + NSEvent.doubleClickInterval, execute: poke)
        }
    }

    private var pendingPoke: DispatchWorkItem?

    /// The blob reacts to a tap: a shiver and a small hop that lands where it was.
    private func pokeBlob() {
        pendingPoke = nil
        guard !expanded else { return }
        blobView.paused = false
        sim.nudge(1.4)
        // Mid-flight a hop would strand it (the goal goes with the fling) or make its
        // hover spot home when it landed; a shiver is enough.
        guard flight == .none else { blobView.poke(); return }
        let dx = Double.random(in: -90 ... 90)
        let dy = Double.random(in: -140 ... -60)
        body.fling(CGVector(dx: dx, dy: dy))
        blobView.poke()
    }

    /// Built fresh on every right-click; each item carries its own action and dies
    /// with the menu. Solid symbols, one word each.
    private func showMenu(for event: NSEvent) {
        let menu = NSMenu()
        menu.autoenablesItems = false
        let awake = state.isAwake
        let muted = state.phase == .muted
        menu.addItem(menuTarget.item(awake ? "Sleep" : "Wake", symbol: awake ? "moon.fill" : "bolt.fill") { [weak self] in
            self?.toggleAwake()
        })
        // The wake word gate, while asleep: what it is doing (the status menu's row).
        if !awake {
            let ws = state.snapshot.settings.wakeSettings
            let gate = menuTarget.item(OrbStyle.gateLabel(state.wakeGate, phrases: ws.phrases, auth: ws.auth), symbol: OrbStyle.gateSymbol(state.wakeGate)) {}
            gate.isEnabled = false
            menu.addItem(gate)
        }
        menu.addItem(menuTarget.item(muted ? "Unmute" : "Mute", symbol: muted ? "mic.slash.fill" : "mic.fill") { [weak self] in
            self?.toggleMute()
        })
        let stop = menuTarget.item("Stop", symbol: "stop.fill") { [weak self] in self?.state.send(.stop) }
        stop.isEnabled = awake
        menu.addItem(stop)
        menu.addItem(.separator())
        menu.addItem(menuTarget.item("Console", symbol: "rectangle.3.group.fill") { [weak self] in self?.state.openConsole() })
        menu.addItem(.separator())
        menu.addItem(menuTarget.item("Quit", symbol: "power") { NSApp.terminate(nil) })
        NSMenu.popUpContextMenu(menu, with: event, for: container)
    }

    private func toggleAwake() {
        state.send(state.isAwake ? .sleep : .wake)
    }

    private func toggleMute() {
        state.send(state.phase == .muted ? .unmute : .mute)
    }
}

// MARK: - Panel

/// Frameless non-activating panel that becomes key only for the passphrase field.
/// Left-button events on the blob are handed to the controller (which decides tap vs.
/// drag); right-clicks are reported; everything else behaves natively so the capsule's
/// buttons work.
final class OrbPanel: NSPanel {
    var onMouseDown: ((NSEvent) -> Bool)?
    var onMouseDragged: ((NSEvent) -> Void)?
    var onMouseUp: ((NSEvent) -> Void)?
    var onRightClick: ((NSEvent) -> Void)?
    /// Does a click at this window point need the panel to be key (the passphrase field)? Set by the controller.
    var keyRequired: ((NSPoint) -> Bool)?

    private var tracking = false

    /// Never key on its own: the blob and the capsule's buttons work without it, and
    /// taking key status would redirect the keystrokes of whatever Kevin was typing in.
    /// The capsule's passphrase field is the one exception: a click that lands in it
    /// opens this for the duration of `makeKey()` (`sendEvent`), and the controller
    /// hands key status back when the field lets go (`releaseKey`).
    var keyAllowed = false
    override var canBecomeKey: Bool { keyAllowed }
    override var canBecomeMain: Bool { false }

    /// While key — only ever with the passphrase field focused — the panel would also
    /// answer ⌘-shortcuts, and our main menu would take ⌘Q for a quit Kevin did not
    /// mean. Editing shortcuts pass; every other ⌘ combination is swallowed.
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if event.modifierFlags.contains(.command) {
            let key = event.charactersIgnoringModifiers?.lowercased() ?? ""
            if !["a", "c", "v", "x", "z"].contains(key) { return true }
        }
        return super.performKeyEquivalent(with: event)
    }

    override func sendEvent(_ event: NSEvent) {
        switch event.type {
        case .leftMouseDown:
            if onMouseDown?(event) == true { tracking = true; return }
            // A click into a text input: become key (without activating the app — this is
            // a non-activating panel) so the field can take the keystrokes; a click
            // anywhere else leaves key status where it is.
            if !isKeyWindow, keyRequired?(event.locationInWindow) == true {
                keyAllowed = true
                makeKey()
                keyAllowed = false
                #if JARHEAD_ORB_PREVIEW
                print("OrbPanel: click in the field at \(event.locationInWindow) -> makeKey, isKeyWindow: \(isKeyWindow), canBecomeKey now: \(canBecomeKey), app active: \(NSApp.isActive)")
                #endif
            }
        case .leftMouseDragged:
            if tracking { onMouseDragged?(event); return }
        case .leftMouseUp:
            if tracking { tracking = false; onMouseUp?(event); return }
        case .rightMouseDown:
            onRightClick?(event)
            return
        default:
            break
        }
        super.sendEvent(event)
    }
}

/// Hosts the status pill over the blob; never takes the mouse.
final class OrbPillHostingView: NSHostingView<OrbPillView> {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

/// Hosts the capsule; takes the first click even though the panel is never key, so
/// a button press is a press and not a focus change.
final class OrbCapsuleHostingView: NSHostingView<OrbCapsuleView> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// A menu item's action, held by the item's `representedObject` and released with it.
final class OrbMenuAction: NSObject {
    let run: () -> Void
    init(_ run: @escaping () -> Void) { self.run = run }
}

/// NSMenu target/action without making the controller an NSObject. Holds nothing
/// itself: every closure lives on its item, so right-clicks never accumulate state.
final class OrbMenuTarget: NSObject {
    func item(_ title: String, symbol: String, _ handler: @escaping () -> Void) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: #selector(fire(_:)), keyEquivalent: "")
        item.target = self
        item.representedObject = OrbMenuAction(handler)
        if let image = NSImage(systemSymbolName: symbol, accessibilityDescription: title) {
            item.image = image.withSymbolConfiguration(.init(pointSize: 13, weight: .medium))
        }
        return item
    }

    @objc private func fire(_ sender: NSMenuItem) {
        (sender.representedObject as? OrbMenuAction)?.run()
    }
}

#if JARHEAD_ORB_PREVIEW
/// Hooks for Scripts/orb-preview.sh only; never compiled into the app.
extension OrbPanelController {
    public var previewFrameCG: CGRect { CGSpace.rect(fromAppKit: panel.frame) }
    public var previewMaxPress: Double { body.maxPress }
    public var previewIsMoving: Bool { body.isActive }
    public var previewIsExpanded: Bool { expanded }
    /// Where the capsule and the blob cell sit in the panel (AppKit window coordinates), for aiming clicks.
    public var previewCapsuleFrame: NSRect { capsuleHost.frame }
    public var previewBlobCellFrame: NSRect { blobCell.frame }
    public var previewIsKey: Bool { panel.isKeyWindow }
    public var previewPanelFrame: NSRect { panel.frame }
    /// "none" / "outbound" / "hovering" / "homing".
    public var previewFlightPhase: String { String(describing: flight) }
    public var previewBodySpeed: Double { body.speed }
    /// The CG centre the blob will drift back to.
    public var previewPerchCG: CGPoint? { perch }
    /// Seconds of hover left before it heads home (0 outside a flight).
    public var previewHoverRemaining: Double { flight == .none ? 0 : max(0, hoverUntil - CACurrentMediaTime()) }
    /// An orb.fly is waiting for Kevin's own motion to land.
    public var previewHasPendingFly: Bool { pendingFly != nil }
    /// The capsule interrupted a flight; closing it sends the blob home.
    public var previewHomeAfterCollapse: Bool { homeAfterCollapse }
    /// The trail's ghosts currently showing (AppKit frames), for framing a screenshot.
    public var previewGhostFrames: [NSRect] { trail.visibleFrames }
    /// Draw the showing ghosts into a context whose origin is `offset` (AppKit screen space).
    public func previewRenderTrail(in ctx: CGContext, offset: NSPoint) { trail.render(in: ctx, offset: offset) }
    public func previewSetReducedMotion(_ on: Bool) { sim.reducedMotion = on }

    /// Draw the panel's content — its layer tree, what is on screen — into a context
    /// whose origin is the panel's bottom-left (AppKit, y up). For the harness's own
    /// screenshots when the window server will not give this process an image.
    public func previewRender(in ctx: CGContext) {
        panel.displayIfNeeded()
        CATransaction.flush()
        container.layer?.render(in: ctx)
    }

    /// Can the panel become key at all from this process? Tries it as an inactive
    /// process (the window server refuses key focus to a process a real click has not
    /// touched — the harness's synthetic clicks carry no such token), then once more
    /// after activating the harness, and checks that `releaseKey` hands it back.
    public func previewProbeKey() {
        panel.keyAllowed = true
        panel.makeKey()
        print("probe: makeKey (inactive) -> isKeyWindow \(panel.isKeyWindow), NSApp.keyWindow: \(NSApp.keyWindow.map { String(describing: type(of: $0)) } ?? "nil"), active: \(NSApp.isActive)")
        NSApp.activate()
        panel.makeKey()
        print("probe: makeKey (after activate) -> isKeyWindow \(panel.isKeyWindow), active: \(NSApp.isActive)")
        panel.keyAllowed = false
        releaseKey()
        print("probe: released -> isKeyWindow \(panel.isKeyWindow), visible: \(panel.isVisible), canBecomeKey: \(panel.canBecomeKey)")
        NSApp.deactivate()
        fflush(stdout)
    }
    public var previewFirstResponder: String { panel.firstResponder.map { String(describing: type(of: $0)) } ?? "nil" }
    /// The passphrase field's frame in window coordinates (nil when the row is not showing).
    public var previewPassphraseFieldFrame: NSRect? { fieldFrameInWindow }

    /// The capsule host's AppKit subtree: class, frame, whether a click there asks for key.
    public func previewDumpCapsuleViews() {
        func dump(_ v: NSView, _ depth: Int) {
            print(String(repeating: "  ", count: depth), String(describing: type(of: v)), v.frame, "needsKey:", v.needsPanelToBecomeKey, "flipped:", v.isFlipped)
            for s in v.subviews { dump(s, depth + 1) }
        }
        dump(capsuleHost, 0)
        fflush(stdout)
    }

    /// A synthetic key press, posted like a real one. NSApplication routes a posted key
    /// event to the window it names, key or not, so this proves the field editor takes
    /// text and Return submits — not that the panel is key.
    public func previewKey(_ characters: String, keyCode: UInt16 = 0) {
        let n = panel.windowNumber
        let t = ProcessInfo.processInfo.systemUptime
        guard let down = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: t, windowNumber: n, context: nil, characters: characters, charactersIgnoringModifiers: characters, isARepeat: false, keyCode: keyCode),
              let up = NSEvent.keyEvent(with: .keyUp, location: .zero, modifierFlags: [], timestamp: t + 0.03, windowNumber: n, context: nil, characters: characters, charactersIgnoringModifiers: characters, isARepeat: false, keyCode: keyCode) else { return }
        NSApp.postEvent(down, atStart: false)
        NSApp.postEvent(up, atStart: false)
    }

    /// A synthetic click into the panel at window coordinates (y up), posted to the
    /// event queue so it takes the same path a real one does (NSApplication.sendEvent →
    /// the panel's sendEvent): proves the blob toggles, the capsule's buttons fire on a
    /// panel that is not key, and only the passphrase field makes it key. Posted, not
    /// sent, because a text field's mouseDown runs a tracking loop until the mouse-up
    /// arrives from the queue. The result is visible on the next turn of the run loop.
    public func previewClick(windowPoint p: NSPoint) {
        let n = panel.windowNumber
        let t = ProcessInfo.processInfo.systemUptime
        guard let down = NSEvent.mouseEvent(with: .leftMouseDown, location: p, modifierFlags: [], timestamp: t, windowNumber: n, context: nil, eventNumber: 9001, clickCount: 1, pressure: 1),
              let up = NSEvent.mouseEvent(with: .leftMouseUp, location: p, modifierFlags: [], timestamp: t + 0.06, windowNumber: n, context: nil, eventNumber: 9002, clickCount: 1, pressure: 0) else { return }
        NSApp.postEvent(down, atStart: false)
        NSApp.postEvent(up, atStart: false)
    }

    public func previewFling(vx: Double, vy: Double) {
        blobView.paused = false
        body.fling(CGVector(dx: vx, dy: vy))
        scanObstacles(force: true)
        blobView.poke()
    }

    /// Solid rects to collide with, on top of whatever the window scan finds.
    public func previewSetObstacles(_ rects: [CGRect]) {
        extraObstacles = rects.enumerated().map { Obstacle(id: 0xffff_0000 + UInt32($0.offset), rect: $0.element) }
    }

    /// Hold everything still (for an exact screenshot), then let it go.
    public func previewFreeze(_ on: Bool) {
        frozen = on
        blobView.paused = on
        if !on { blobView.poke() }
    }
}
#endif
