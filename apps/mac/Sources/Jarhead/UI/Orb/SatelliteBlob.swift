import AppKit
import QuartzCore
import SwiftUI

// A satellite: the smaller blob a spawned thread wears while it works. `BlobFleet`
// owns one per live thread (at most three), keyed by the thread's id. It is the orb
// panel's recipe minus the capsule and the key handling: a floating, non-activating
// panel the size of the small field (`BlobMetrics.satellitePanelSize`, 120 pt), the
// halo layer under the glyph view under the pill host, one `BlobBody` for the physics
// and one `BlobSim` on the 19×11 grid for the face — driven, so it owns no display
// link: the fleet's one link steps it (`frame(dt:now:)`). It flies beside the work the
// way the main blob does (`BlobBody.flyBeside`, landing where no other blob sits),
// wears its thread's status as a face (`ThreadStatus.satellitePhase`), shows its name
// on hover (the pill), and leaves with `^ ^` (done) or `x x` (failed) held a beat
// before it fades. It never speaks, never drops ghosts, never persists a position,
// never opens a capsule. A click opens its thread in the Console; a drag into the
// notch's catch zone stops that thread — one `thread.stop`, never a sleep, never a
// settings write. Under Reduce Motion it appears, moves and leaves as plain fades.

extension ThreadStatus {
    /// The `BlobSim` phase whose face and colour this status wears: thinking `o o`
    /// (connecting's glance, in its grey-blue), acting `o o` → `> >` toward the work
    /// (acting green), waiting on the screen `- -` (thinking's purple: someone else has
    /// it), waiting on Kevin `O O` (listening's blue), paused `u u`, done `^ ^`
    /// (speaking's amber), failed `x x` (error red), stopped `- -` (asleep's grey).
    var satellitePhase: Phase {
        switch self {
        case .idle, .queued, .starting, .thinking: return .connecting
        case .acting: return .acting
        case .waitingScreen: return .thinking
        case .waitingKevin: return .listening
        case .paused: return .paused
        case .done: return .speaking
        case .failed: return .error
        case .stopped: return .asleep
        }
    }

    /// The status word the notch line and the satellite's menu use ("Slack · working · 0:03").
    var orbWord: String {
        switch self {
        case .idle: return "idle"
        case .queued: return "queued"
        case .starting: return "starting"
        case .thinking: return "thinking"
        case .acting: return "working"
        case .waitingScreen: return "waiting"
        case .waitingKevin: return "asks"
        case .paused: return "paused"
        case .done: return "done"
        case .failed: return "failed"
        case .stopped: return "stopped"
        }
    }
}

// MARK: - Panel

/// The orb panel minus key handling: frameless, non-activating, floating (under alerts
/// and the TCC prompts like the orb; the overlay's `.screenSaver` would paint over them),
/// clear, no shadow. Left-button events go to the satellite (tap vs. drag), right-clicks
/// are reported; it can never become key. Reused from the fleet's pool.
final class SatellitePanel: NSPanel {
    var onMouseDown: ((NSEvent) -> Bool)?
    var onMouseDragged: ((NSEvent) -> Void)?
    var onMouseUp: ((NSEvent) -> Void)?
    var onRightClick: ((NSEvent) -> Void)?
    private var tracking = false

    init(size: NSSize) {
        super.init(contentRect: NSRect(origin: .zero, size: size), styleMask: [.nonactivatingPanel, .borderless, .fullSizeContentView], backing: .buffered, defer: false)
        level = .floating
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        hidesOnDeactivate = false
        isMovableByWindowBackground = false
        isReleasedWhenClosed = false
        animationBehavior = .none
        isExcludedFromWindowsMenu = true
        title = "Jarhead thread"
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
    /// The window goes where the body is, menu bar included (see `OrbPanel`).
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }

    override func sendEvent(_ event: NSEvent) {
        switch event.type {
        case .leftMouseDown:
            if onMouseDown?(event) == true { tracking = true; return }
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

/// The blob cell: the halo, the field and the pill, with a tracking area so the name
/// tag shows while the pointer is over the satellite.
@MainActor
final class SatelliteCellView: NSView {
    var onHover: ((Bool) -> Void)?
    private var tracking: NSTrackingArea?

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let t = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self, userInfo: nil)
        addTrackingArea(t)
        tracking = t
    }

    override func mouseEntered(with event: NSEvent) { onHover?(true) }
    override func mouseExited(with event: NSEvent) { onHover?(false) }
}

// MARK: - Where a satellite with nowhere to be goes

/// The rank slots beside the anchor (the main blob when it is out, the row under the
/// notch while tucked): up-left, up and up-right of it, 50° apart. At radius 59 + 43 +
/// 28 from the anchor's centre the neighbours sit ≈ 110 pt apart — past the 92 the
/// fleet keeps between bodies (43 + 43 + `BlobBody.avoidPad`) — and the 28 of air
/// keeps the two glyph fields, which reach past the collision radii, from touching.
enum SatelliteRank {
    static let gap: CGFloat = 28
    static let angles: [Double] = [-150, -100, -50]
    /// The same arc under the anchor (CG y grows downward): for the row under the notch,
    /// so no satellite parks over the island.
    static let anglesBelow: [Double] = [150, 100, 50]

    static func slot(_ i: Int, anchor: CGPoint, anchorRadius: CGFloat, satRadius: CGFloat, below: Bool = false) -> CGPoint {
        let arc = below ? anglesBelow : angles
        let a = arc[((i % arc.count) + arc.count) % arc.count] * .pi / 180
        let d = anchorRadius + satRadius + gap
        return CGPoint(x: anchor.x + CGFloat(cos(a)) * d, y: anchor.y + CGFloat(sin(a)) * d)
    }
}

/// The front window of the app a background thread works in, by owner name — the same
/// window list `ObstacleScanner` reads (owner names come back without Screen Recording
/// consent; window titles would need it). Case-insensitive, and "Chrome" finds
/// "Google Chrome". Nil when the app has no window on screen.
enum WindowLocator {
    nonisolated static func frontWindowRect(ownerName: String) -> CGRect? {
        let want = ownerName.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !want.isEmpty,
              let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
        for w in list {
            guard (w[kCGWindowLayer as String] as? Int) == 0 else { continue }
            guard let owner = (w[kCGWindowOwnerName as String] as? String)?.lowercased(), !owner.isEmpty,
                  owner == want || owner.contains(want) || want.contains(owner) else { continue }
            if let alpha = w[kCGWindowAlpha as String] as? Double, alpha < 0.05 { continue }
            guard let b = w[kCGWindowBounds as String] as? [String: CGFloat],
                  let x = b["X"], let y = b["Y"], let width = b["Width"], let height = b["Height"],
                  width >= 140, height >= 100 else { continue }
            return CGRect(x: x, y: y, width: width, height: height)
        }
        return nil
    }
}

// MARK: - Satellite

@MainActor
final class SatelliteBlob {
    let id: String
    private(set) var thread: WorkThread
    let panel: SatellitePanel
    /// The panel's content: the blob cell centred, the pill host across the whole width.
    private let container = NSView()
    private let cell: SatelliteCellView
    let blobView: BlobFieldView
    let haloView: BlobHaloView
    let pillHost: OrbPillHostingView
    let statusModel = OrbStatusModel()
    let body: BlobBody
    var sim: BlobSim { blobView.sim }
    private let menuTarget = OrbMenuTarget()

    /// The blob cell and the body (BlobMetrics.satellitePanelSize, 120 pt: radius 43).
    static let size = BlobMetrics.panelSize(.satellite)
    /// The panel: the cell plus `cellInset` of clear air each side for the pill ("Slack
    /// asks: send it to Ben…" needs more than the cell's 120 pt). The clear air takes no
    /// clicks (`mouseDown` wants the cell) and is not part of the body.
    static let cellInset: CGFloat = 40
    static let panelSize = NSSize(width: BlobMetrics.satellitePanelSize.width + 2 * cellInset, height: BlobMetrics.satellitePanelSize.height)
    /// How long the finish faces hold before the fade: done `^ ^`, failed `x x`, stopped `- -`.
    static let finishHold = 1.2
    static let failHold = 1.6
    static let stopHold = 0.5
    /// The name tag stays this long after the pointer leaves.
    static let tagShow = 1.2
    /// The appear / leave fade (`Motion.base`, halved under Reduce Motion by `Motion.seconds`).
    static var fadeSeconds: Double { Motion.seconds(Motion.base) }
    /// A question in the pill is cut here; the whole of it is the accessibility description.
    static let pillQuestionChars = 40

    enum Flight: Equatable { case none, outbound, hovering }
    private(set) var flight = Flight.none
    private(set) var flightTarget: CGPoint?
    /// Where its hands last acted (a tagged fly): the eyes look there while it works.
    private(set) var lastActingPoint: CGPoint?
    /// The spot the last flight was aimed at (the fleet counts it as occupied while the body is on its way).
    private(set) var landingSpot: CGPoint?
    /// Parked by its app's window (`WindowLocator`), until a fly says otherwise.
    private(set) var parkedForApp: String?
    private var hoverUntil = 0.0
    private var hoverTimer: Task<Void, Never>?

    // The panel's alpha: appear, leave, and the Reduce Motion hop (fade out, jump, fade in).
    private var alphaFrom = 0.0
    private var alphaTo = 1.0
    private var fadeStart = -1.0
    private var fadeLength = 0.24
    private var fadeThen: (() -> Void)?
    private(set) var retiring = false
    private var retired = false
    private var finishWork: DispatchWorkItem?

    // Pointer tracking for the drag / tap distinction (the main blob's path, minus the capsule and the poke).
    private var downPoint: CGPoint?
    private var downTime: TimeInterval = 0
    private var dragMoved = false
    /// The dock drop's stop has been sent: exactly one per satellite, whatever else
    /// happens. The menu's Stop is not latched here — the engine may refuse it (a thread
    /// it no longer has) and the item stays enabled while the record is live, so Kevin
    /// may press it again.
    private(set) var stopSent = false

    // The pill: the pinned one (asks / failed) over the hover tag.
    private var pinnedPill: OrbPill?
    private var hoverPill: OrbPill?
    private var tagTimer: DispatchWorkItem?

    // Wired by the fleet.
    var onClick: ((String) -> Void)?
    var onDropInDock: ((String) -> Void)?
    var onStop: ((String) -> Void)?
    /// Something wants frames: the fleet un-pauses its link.
    var onWake: (() -> Void)?
    /// The other blobs' body rects, for a landing that avoids them.
    var occupied: (() -> [CGRect])?
    /// The notch's catch zone (CG), when a display has a notch.
    var catchZone: (() -> CGRect?)?
    /// Status changes the fleet wants to hear about (the notch dots).
    var onStatusChanged: (() -> Void)?
    /// Print for the preview harness (nil in the app).
    var log: ((String) -> Void)?
    /// The moment it starts to leave (the fleet moves it out of its live table).
    var onLeaving: (() -> Void)?
    /// The moment it has left (the fleet returns the panel to the pool).
    var onRetired: (() -> Void)?

    init(thread: WorkThread, panel: SatellitePanel) {
        self.id = thread.id
        self.thread = thread
        self.panel = panel
        let s = Self.size
        container.frame = NSRect(origin: .zero, size: Self.panelSize)
        container.wantsLayer = true
        container.layer?.backgroundColor = .clear
        cell = SatelliteCellView(frame: NSRect(x: Self.cellInset, y: 0, width: s.width, height: s.height))
        cell.wantsLayer = true
        cell.layer?.backgroundColor = .clear
        haloView = BlobHaloView(frame: cell.bounds)
        haloView.grid = .satellite
        haloView.autoresizingMask = [.width, .height]
        cell.addSubview(haloView)
        blobView = BlobFieldView(frame: cell.bounds, grid: .satellite, driven: true)
        blobView.autoresizingMask = [.width, .height]
        blobView.halo = haloView
        cell.addSubview(blobView)
        container.addSubview(cell)
        // The pill spans the panel: centred under the blob, with room for a question.
        pillHost = OrbPillHostingView(rootView: OrbPillView(status: statusModel))
        pillHost.frame = container.bounds
        pillHost.autoresizingMask = [.width, .height]
        container.addSubview(pillHost)
        panel.contentView = container
        panel.setFrame(NSRect(origin: panel.frame.origin, size: Self.panelSize), display: false)
        body = BlobBody(size: s, center: CGSpace.point(fromAppKit: NSPoint(x: panel.frame.midX, y: panel.frame.midY)))

        blobView.onPoke = { [weak self] in self?.onWake?() }
        blobView.accessibilityNameOverride = { [weak self] in
            guard let self else { return "" }
            var text = "\(self.thread.name), \(self.thread.status.orbWord)"
            if let q = self.thread.question, !q.isEmpty { text += ": \(q)" }
            return text
        }
        cell.onHover = { [weak self] over in self?.hover(over) }
        panel.onMouseDown = { [weak self] event in self?.mouseDown(event) ?? false }
        panel.onMouseDragged = { [weak self] event in self?.pointerDragged(to: CGSpace.point(fromAppKit: NSEvent.mouseLocation)) }
        panel.onMouseUp = { [weak self] event in self?.pointerUp(clickCount: event.clickCount, time: event.timestamp) }
        panel.onRightClick = { [weak self] event in self?.showMenu(for: event) }

        body.onSettle = { [weak self] in self?.bodyDidSettle() }
        body.onImpact = { [weak self] speed in
            guard let self else { return }
            self.sim.nudge(min(2.0, 0.4 + speed / 900))
            self.blobView.poke()
        }
        body.onArrive = { [weak self] in
            guard let self, self.flight == .outbound else { return }
            self.sim.rippleLanding()
            self.blobView.poke()
        }
        body.onSnap = { [weak self] nx, ny in
            guard let self else { return }
            self.sim.snapFree(nx: nx, ny: ny)
            self.blobView.poke()
        }
        body.onSplat = { [weak self] speed in
            guard let self else { return }
            self.sim.splat(min(1, 0.5 + speed / 3000))
            self.blobView.poke()
        }
        statusModel.shown = true
    }

    // MARK: life

    /// Appear at `spot` (CG centre): the body placed, the face for the thread's status,
    /// the panel ordered in clear and faded up. The fleet orders it under the main orb next.
    func spawn(at spot: CGPoint, reducedMotion: Bool) {
        sim.reducedMotion = reducedMotion
        body.teleport(to: spot)
        sim.setContacts(body.contacts())
        sim.leanX = body.leanX
        sim.leanY = body.leanY
        placePanel()
        panel.alphaValue = 0
        applyFace(initial: true)
        blobView.paused = false
        panel.orderFrontRegardless()
        beginFade(to: 1)
        blobView.poke()
        log?("\(thread.name): appears at CG \(Int(spot.x)),\(Int(spot.y)) as \(thread.status.rawValue) face [\(sim.face.left) \(sim.face.right)]")
    }

    /// The thread's record changed: a new status is a new face (and, when it is over,
    /// the finish choreography); a new question refreshes the pill.
    func apply(thread t: WorkThread) {
        let was = thread
        thread = t
        if t.status != was.status {
            applyFace(initial: false)
            onStatusChanged?()
            log?("\(t.name): \(was.status.rawValue) -> \(t.status.rawValue) face [\(sim.face.left) \(sim.face.right)]\(pinnedPill.map { " pill '\($0.text)'" } ?? "")")
        } else if t.question != was.question || t.name != was.name {
            applyFace(initial: false)
        }
    }

    /// The face and the pill for the thread's status. A finished thread holds its last
    /// face (`^ ^` 1.2 s, `x x` 1.6 s, `- -` 0.5 s) and then leaves.
    private func applyFace(initial: Bool) {
        let status = thread.status
        sim.setPhase(status.satellitePhase)
        switch status {
        case .waitingKevin:
            let q = (thread.question ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let cut = q.count > Self.pillQuestionChars ? String(q.prefix(Self.pillQuestionChars - 1)) + "…" : q
            pinnedPill = OrbPill(text: q.isEmpty ? "\(thread.name) asks" : "\(thread.name) asks: \(cut)", tone: .warn, icon: "hand.raised.fill")
        case .failed:
            pinnedPill = OrbPill(text: "\(thread.name) failed", tone: .error)
            if !initial { sim.nudge(sim.reducedMotion ? 0.4 : 1.2) }
        default:
            pinnedPill = nil
            if status == .done, !initial { sim.nudge(0.5) }
        }
        // At work the eyes look where the hands last acted.
        if status == .acting, let p = lastActingPoint {
            sim.attention = CGVector(dx: p.x - body.center.x, dy: p.y - body.center.y)
        } else if flight == .none {
            sim.attention = nil
        }
        refreshPill()
        if !status.isLive { scheduleFinish(status) }
        blobView.poke()
    }

    private func scheduleFinish(_ status: ThreadStatus) {
        finishWork?.cancel()
        let hold: Double
        switch status {
        case .failed: hold = Self.failHold
        case .stopped: hold = Self.stopHold
        default: hold = Self.finishHold
        }
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.retire() }
        }
        finishWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + hold, execute: work)
    }

    /// Leave: the flight is over, the body stopped where it is, the panel faded out
    /// (`fadeSeconds`) and ordered out; then `onRetired`. A hand on it lets go first.
    func retire() {
        guard !retiring else { return }
        retiring = true
        onLeaving?()
        finishWork?.cancel(); finishWork = nil
        tagTimer?.cancel(); tagTimer = nil
        hoverTimer?.cancel(); hoverTimer = nil
        if body.dragging { body.endDrag() }
        body.teleport(to: body.center)
        flight = .none
        flightTarget = nil
        landingSpot = nil
        sim.flight = false
        sim.flightMoving = false
        placePanel()
        beginFade(to: 0) { [weak self] in
            guard let self else { return }
            self.retired = true
            self.panel.orderOut(nil)
            self.blobView.paused = true
            self.statusModel.shown = false
            self.onRetired?()
        }
        log?("\(thread.name): leaves (\(thread.status.rawValue))")
        onWake?()
    }

    // MARK: flights

    /// Fly beside `target` (CG): the acting point its hands are at. Refused while Kevin
    /// drags it (his hand wins; the fleet queues the fly) and once it is leaving. A fly
    /// to the same work again only extends the hover. Under Reduce Motion the body
    /// fades out, jumps to the landing and fades back in — no flight.
    @discardableResult
    func fly(to target: CGPoint, dwellMs: Double?, avoiding: [CGRect]) -> Bool {
        guard !body.dragging, !retiring else { return false }
        lastActingPoint = target
        parkedForApp = nil
        let now = CACurrentMediaTime()
        let dwell = max(0.2, (dwellMs ?? 2000) / 1000)
        hoverUntil = max(hoverUntil, now + dwell)
        if flight == .outbound || flight == .hovering {
            let sameWork = flightTarget.map { hypot(target.x - $0.x, target.y - $0.y) <= body.radius } ?? false
            if sameWork || (flight == .hovering && body.isBeside(target)) {
                flightTarget = target
                sim.attention = CGVector(dx: target.x - body.center.x, dy: target.y - body.center.y)
                blobView.poke()
                return true
            }
        }
        flightTarget = target
        hoverTimer?.cancel(); hoverTimer = nil
        if sim.reducedMotion {
            let spot = body.landing(for: target, avoiding: avoiding)
            landingSpot = spot
            log?("\(thread.name): fades to CG \(Int(spot.x)),\(Int(spot.y)) beside \(Int(target.x)),\(Int(target.y)) (\(body.lastLandingNote))")
            hop(to: spot)
            return true
        }
        flight = .outbound
        sim.flight = true
        sim.flightMoving = true
        blobView.paused = false
        let spot = body.flyBeside(target, spring: .flight, avoiding: avoiding)
        landingSpot = spot
        sim.attention = CGVector(dx: target.x - body.center.x, dy: target.y - body.center.y)
        log?("\(thread.name): flies from CG \(Int(body.center.x)),\(Int(body.center.y)) to landing \(Int(spot.x)),\(Int(spot.y)) beside \(Int(target.x)),\(Int(target.y)) (\(body.lastLandingNote))")
        onWake?()
        blobView.poke()
        return true
    }

    /// Park up-left of `rect` (its app's front window, CG): not an acting point, no
    /// hover — it sits there for the life of the thread unless a fly says otherwise.
    func park(beside rect: CGRect, app: String, avoiding: [CGRect]) {
        guard !body.dragging, !retiring else { return }
        parkedForApp = app
        let target = CGPoint(x: rect.midX, y: rect.midY)
        if sim.reducedMotion {
            let spot = body.landing(for: target, avoiding: avoiding)
            landingSpot = spot
            hop(to: spot)
            return
        }
        flight = .outbound
        hoverUntil = CACurrentMediaTime() + 0.2
        sim.flight = true
        sim.flightMoving = true
        blobView.paused = false
        landingSpot = body.flyBeside(target, spring: .flight, avoiding: avoiding)
        log?("\(thread.name): parks by \(app)'s window at landing \(Int(landingSpot!.x)),\(Int(landingSpot!.y)) (\(body.lastLandingNote))")
        onWake?()
        blobView.poke()
    }

    /// The main blob parked on top of it (its own path never yields): step aside to
    /// `spot` — beside its work again on a side the main leaves free, or its rank slot;
    /// the fleet chooses. A fade under Reduce Motion; refused in Kevin's hand or once leaving.
    func yield(to spot: CGPoint) {
        guard !body.dragging, !retiring, hypot(spot.x - body.center.x, spot.y - body.center.y) > 4 else { return }
        hoverTimer?.cancel(); hoverTimer = nil
        landingSpot = spot
        log?("\(thread.name): yields to the main blob -> CG \(Int(spot.x)),\(Int(spot.y))")
        if sim.reducedMotion { hop(to: spot); return }
        flight = .outbound
        sim.flight = true
        sim.flightMoving = true
        blobView.paused = false
        body.fly(to: spot, spring: .flight)
        onWake?()
        blobView.poke()
    }

    /// Reduce Motion's move: fade out, jump, fade in.
    private func hop(to spot: CGPoint) {
        beginFade(to: 0) { [weak self] in
            guard let self, !self.retiring else { return }
            self.body.teleport(to: spot)
            self.sim.setContacts(self.body.contacts())
            self.placePanel()
            self.beginFade(to: 1)
            if let t = self.lastActingPoint { self.sim.attention = CGVector(dx: t.x - spot.x, dy: t.y - spot.y) }
        }
    }

    private func bodyDidSettle() {
        sim.setContacts(body.contacts())
        sim.setMotion(lag: .zero, grab: nil, velocity: .zero, dragging: false)
        sim.leanX = body.leanX
        sim.leanY = body.leanY
        placePanel()
        switch flight {
        case .outbound:
            flight = .hovering
            sim.flightMoving = false
            landingSpot = nil
            hoverUntil = max(hoverUntil, CACurrentMediaTime() + 0.2)
            scheduleHoverEnd()
            log?("\(thread.name): parked at CG \(Int(body.center.x)),\(Int(body.center.y)) face [\(sim.face.left) \(sim.face.right)]")
        case .hovering, .none:
            break
        }
    }

    private func scheduleHoverEnd() {
        hoverTimer?.cancel()
        hoverTimer = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                guard let self, self.flight == .hovering else { return }
                let remaining = self.hoverUntil - CACurrentMediaTime()
                if remaining <= 0 { self.stayHere(); return }
                try? await Task.sleep(nanoseconds: UInt64(max(0.01, remaining) * 1_000_000_000))
            }
        }
    }

    /// The hover ran out: it stays where it worked (the main blob's rule). The flight
    /// look fades to the status's colour; the eyes keep the work in view while it acts.
    private func stayHere() {
        hoverTimer?.cancel(); hoverTimer = nil
        flight = .none
        flightTarget = nil
        landingSpot = nil
        sim.flight = false
        sim.flightMoving = false
        body.park()
        sim.settleHere()
        sim.setContacts(body.contacts())
        placePanel()
        if thread.status == .acting, let p = lastActingPoint {
            sim.attention = CGVector(dx: p.x - body.center.x, dy: p.y - body.center.y)
        } else {
            sim.attention = nil
        }
        blobView.poke()
    }

    private func cancelFlight() {
        hoverTimer?.cancel(); hoverTimer = nil
        guard flight != .none else { return }
        if body.hasGoal { body.teleport(to: body.center) }
        flight = .none
        flightTarget = nil
        landingSpot = nil
        sim.flight = false
        sim.flightMoving = false
        blobView.poke()
    }

    // MARK: frames

    /// One fleet frame: the physics while the body moves (the panel follows it), the
    /// fade, then the field on its own clock. Returns whether the body moved and whether
    /// anything still wants frames.
    func frame(dt: Double, now: Double) -> (moving: Bool, wants: Bool) {
        guard !retired else { return (false, false) }
        var moving = false
        if body.isActive || body.dragging {
            let contacts = body.step(dt)
            sim.setContacts(contacts)
            sim.setMotion(lag: body.lag, grab: body.grab, velocity: body.velocity, dragging: body.dragging)
            if flight != .none, let t = flightTarget {
                sim.attention = CGVector(dx: t.x - body.center.x, dy: t.y - body.center.y)
            }
            sim.leanX = body.leanX
            sim.leanY = body.leanY
            placePanel()
            moving = true
        }
        // A fade counts as motion: the leave runs at the link's full rate, so a Stop's
        // satellites are gone well inside 300 ms rather than stepping out at 24 fps.
        let fading = stepFade(now)
        let fieldWants = blobView.paused ? false : blobView.frame(now: now)
        return (moving || fading, moving || fading || fieldWants)
    }

    private func beginFade(to target: Double, then: (() -> Void)? = nil) {
        alphaFrom = Double(panel.alphaValue)
        alphaTo = target
        fadeStart = CACurrentMediaTime()
        fadeLength = Self.fadeSeconds
        fadeThen = then
        onWake?()
    }

    /// Returns true while a fade runs.
    private func stepFade(_ now: Double) -> Bool {
        guard fadeStart >= 0 else { return false }
        let u = min(1, max(0, (now - fadeStart) / max(0.001, fadeLength)))
        let k = alphaTo > alphaFrom ? Motion.easeOutCurve.value(at: u) : Motion.easeInCurve.value(at: u)
        panel.alphaValue = CGFloat(alphaFrom + (alphaTo - alphaFrom) * k)
        if u >= 1 {
            fadeStart = -1
            panel.alphaValue = CGFloat(alphaTo)
            let then = fadeThen
            fadeThen = nil
            then?()
            return false
        }
        return true
    }

    /// A display came or went: a resting body is not stepped, so pull it onto a work
    /// area now and re-place the panel (the AppKit origin shifts when the primary's frame does).
    func screensDidChange() {
        body.refreshScreens()
        if body.rescueOntoScreens() { cancelFlight() }
        sim.setContacts(body.contacts())
        placePanel()
        blobView.poke()
    }

    /// Move the panel to wherever the body is now (one window-server call per moving
    /// frame): the cell on the body, the pill's air either side of it.
    private func placePanel() {
        let topLeft = CGPoint(x: body.topLeft.x - Self.cellInset, y: body.topLeft.y)
        let origin = CGSpace.appKitOrigin(topLeft: topLeft, size: Self.panelSize)
        let cur = panel.frame.origin
        if abs(origin.x - cur.x) > 0.05 || abs(origin.y - cur.y) > 0.05 {
            panel.setFrameOrigin(origin)
        }
    }

    /// The body's rect (CG) where it is — or where it is going, while a flight is out,
    /// so a second fly to the same spot ranks this one's landing as taken.
    var occupiedRect: CGRect {
        let c = landingSpot ?? body.center
        return CGRect(x: c.x - body.radius, y: c.y - body.radius, width: 2 * body.radius, height: 2 * body.radius)
    }

    // MARK: the pill (the name tag)

    private func hover(_ over: Bool) {
        guard !retiring else { return }
        tagTimer?.cancel(); tagTimer = nil
        if over {
            hoverPill = OrbPill(text: thread.name, tone: .info)
            refreshPill()
        } else {
            let work = DispatchWorkItem { [weak self] in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.hoverPill = nil
                    self.refreshPill()
                }
            }
            tagTimer = work
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.tagShow, execute: work)
        }
    }

    /// The pinned pill (a question, a failure) outranks the hover tag; the blob lifts a little for either.
    private func refreshPill() {
        let pill = pinnedPill ?? hoverPill
        if statusModel.pill != pill {
            statusModel.pill = pill
            sim.lift = pill == nil ? 0 : 1.2
            blobView.poke()
        }
    }

    var pillText: String? { statusModel.pill?.text }

    // MARK: mouse

    private func mouseDown(_ event: NSEvent) -> Bool {
        guard !retiring else { return false }
        let p = cell.convert(event.locationInWindow, from: nil)
        guard cell.bounds.contains(p) else { return false }
        pointerDown(at: CGSpace.point(fromAppKit: NSEvent.mouseLocation), time: event.timestamp)
        return true
    }

    func pointerDown(at p: CGPoint, time: TimeInterval) {
        downPoint = p
        downTime = time
        dragMoved = false
    }

    func pointerDragged(to p: CGPoint) {
        guard let down = downPoint, !retiring else { return }
        if !dragMoved {
            guard hypot(p.x - down.x, p.y - down.y) >= 4 else { return }
            dragMoved = true
            // Kevin's hand ends a flight; where he lets go is where it sits.
            cancelFlight()
            body.beginDrag(pointer: down)
            onWake?()
            blobView.poke()
        }
        body.moveDrag(pointer: p)
    }

    /// Let go: into the notch's catch zone it is that thread's stop — one command, a
    /// shiver, the fade — anywhere else it stays where the hand left it. A click (no
    /// drag, under 0.6 s) opens the thread.
    func pointerUp(clickCount: Int, time: TimeInterval) {
        defer { downPoint = nil }
        if dragMoved {
            body.endDrag()
            let zone = catchZone?()
            let intoDock = zone?.contains(body.center) ?? false
            log?("\(thread.name): let go at CG \(Int(body.center.x)),\(Int(body.center.y))\(intoDock ? " — into the dock" : "")")
            if intoDock, !stopSent {
                stopSent = true
                sim.nudge(sim.reducedMotion ? 0.5 : 1.6)
                sim.poke()
                onDropInDock?(id)
            }
            onWake?()
            blobView.poke()
            return
        }
        guard time - downTime < 0.6 else { return }
        onClick?(id)
    }

    /// Stop <Name> (the thread's stop, as the Console's button), Console (the thread's pane), the lane and status word.
    private func showMenu(for event: NSEvent) {
        guard !retiring else { return }
        let menu = NSMenu()
        menu.autoenablesItems = false
        let stop = menuTarget.item("Stop \(thread.name)", symbol: "stop.fill") { [weak self] in
            guard let self else { return }
            self.onStop?(self.id)
        }
        stop.isEnabled = thread.canStop && thread.status.isLive
        menu.addItem(stop)
        menu.addItem(menuTarget.item("Console", symbol: "rectangle.3.group.fill") { [weak self] in
            guard let self else { return }
            self.onClick?(self.id)
        })
        menu.addItem(.separator())
        let word = menuTarget.item("\(thread.lane.rawValue) · \(thread.status.orbWord)", symbol: "circle.fill") {}
        word.isEnabled = false
        menu.addItem(word)
        NSMenu.popUpContextMenu(menu, with: event, for: cell)
    }

    #if JARHEAD_ORB_PREVIEW
    /// The items a right-click would show, for the harness: "Stop Spotify", "Console", "background · working".
    var previewMenuTitles: [String] { ["Stop \(thread.name)", "Console", "\(thread.lane.rawValue) · \(thread.status.orbWord)"] }
    /// Draw the panel's layer tree at the panel's alpha into `ctx`, whose origin is the panel's bottom-left (AppKit).
    func previewRender(in ctx: CGContext) {
        panel.displayIfNeeded()
        CATransaction.flush()
        let alpha = panel.alphaValue
        guard alpha > 0.005 else { return }
        if alpha < 0.999 {
            ctx.saveGState()
            ctx.setAlpha(alpha)
            ctx.beginTransparencyLayer(auxiliaryInfo: nil)
            container.layer?.render(in: ctx)
            ctx.endTransparencyLayer()
            ctx.restoreGState()
        } else {
            container.layer?.render(in: ctx)
        }
    }
    /// A synthetic click at the cell's centre through the panel's own event path (posted, like the main blob's `previewClick`).
    func previewClick() {
        let n = panel.windowNumber
        let p = NSPoint(x: cell.frame.midX, y: cell.frame.midY)
        let t = ProcessInfo.processInfo.systemUptime
        guard let down = NSEvent.mouseEvent(with: .leftMouseDown, location: p, modifierFlags: [], timestamp: t, windowNumber: n, context: nil, eventNumber: 9101, clickCount: 1, pressure: 1),
              let up = NSEvent.mouseEvent(with: .leftMouseUp, location: p, modifierFlags: [], timestamp: t + 0.06, windowNumber: n, context: nil, eventNumber: 9102, clickCount: 1, pressure: 0) else { return }
        NSApp.postEvent(down, atStart: false)
        NSApp.postEvent(up, atStart: false)
    }
    var previewFlightPhase: String { String(describing: flight) }
    /// The pointer entering / leaving the cell, as the tracking area would report it
    /// (the harness cannot move the real pointer); the tag's timing is the same path.
    func previewHover(_ over: Bool) { hover(over) }
    /// The cell's tracking areas — one, installed once the panel showed it.
    var previewTrackingAreaCount: Int { cell.trackingAreas.count }
    var previewHoverPillText: String? { hoverPill?.text }
    #endif
}
