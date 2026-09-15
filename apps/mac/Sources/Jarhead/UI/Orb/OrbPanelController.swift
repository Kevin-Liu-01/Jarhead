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
/// The blob is a fluid body (`BlobBody`): dragging it pulls it along on an
/// under-damped spring, so it lags the hand and the field stretches it into a
/// teardrop toward the grab (`BlobSim.setMotion`); letting go keeps the momentum
/// and it jiggles. It bounces off the work-area edges and other windows, squishing
/// on impact — or sticks, when it arrives slowly or is pushed in by hand: it spreads
/// on the edge, sags into a dome, smears when dragged along it, and clings on a neck
/// when pulled away until the patch snaps free. The panel window follows the body
/// every display frame, so the blob really travels across the screen.
///
/// It also flies to the work. An `orb.fly` on `state.overlayCommands` sends it from
/// wherever it is to a point on the screen (parking up-left of it, never on it): a
/// short wind-up (it turns the acting colour and tenses), then the flight spring —
/// one overshoot, one squish, a ripple on arrival — and it hovers beside the work for
/// the command's dwell (counted from being parked; a repeat fly to the same spot only
/// extends it). Then it stays where it worked (`stayHere`) — in both homes (the one
/// exception: a mark's own echo started from the dock brings it back to the notch): it settles
/// there, sticks if it is touching an edge, and that spot is saved as `orbPosition`
/// exactly as a drop would be — debounced, once, when settled — so a relaunch finds it
/// there and it never drifts back to some earlier spot. The perch is different: it is
/// where Kevin last put it by hand (a drop, a fling, a summon; remembered for the
/// session), and the explicit `orb.home` — only ever sent on purpose — means "go back
/// there". A user drag mid-flight wins: the flight is cancelled and where he lets go
/// is the new perch. A fly that arrives while Kevin's own throw is still gliding waits
/// for it to land. In flight it wears the acting colour, shimmers faster and trails a
/// dotted wake of itself (`BlobTrail`). Targets are global points on any display: a
/// flight crosses the seam between two touching displays in one line, and hops
/// (`BlobBody.hop`) only where a straight line would leave every screen.
///
/// And it draws by hand. An `orb.trace` sends it to a stroke's first point the same
/// way, but on the wing it morphs into a pen — the cursor form (`BlobSim.cursor`): a
/// compact teardrop whose point leads, held at an angle so the body rides beside the
/// line (on the outside of a loop, `TracePath.hand`), eyes narrowed along the travel,
/// the colour of the line — and, parked with its point on the first point, drags the
/// line along the stroke at about 700 pt/s (eased in and out, slower round the
/// corners), publishing the line so far on `state.liveStrokes` — at each vertex, and
/// otherwise at most 30 times a second, which is as often as the overlay paints —
/// so the overlay draws it growing from under the tip (`Trace`). At the end the
/// stroke is sealed (`done`), the pen holds 300 ms, morphs back and stays by its
/// line. A new trace, `orb.home`, Kevin's hand, the capsule opening, a Stop, the
/// phase falling asleep all cancel it — the half-drawn line is taken down. The
/// overlay's `clear` (the brain's show_clear, a Stop) takes a line being drawn down
/// too, but quietly: the pen morphs back with none of the Stop's body language, and
/// a plain fly is left alone. Under reduce motion the line appears whole and the
/// blob only flies to it.
///
/// Notch mode (`Settings.orbHome == "notch"`, the default on a Mac with a notch) makes
/// the notch home: the blob sleeps in it (`NotchDock`, see NotchPanel.swift — the same
/// `BlobSim`, so the face and colour are continuous), drops out of it for a fly, a
/// trace or a summon (it appears small and clear just under the ink, grows in and hops
/// down softly as the notch face fades out — `dropOut`), does the work, and stays where
/// it worked — the same rule as free mode. The dock is for waking up and going to
/// sleep, nothing else: the blob returns to it only on the awake↔asleep transitions
/// (`fellAsleep`, `wokeUp`): phase → asleep (a Stop, a sleep, the idle timer; `error`
/// counts as asleep — no session, the meter stopped) sends it home once the Stop's
/// shiver has passed, and asleep → awake (the wake word, a Go after a failed session)
/// sends home a blob that was left out, so it is the notch that peeks awake. The way in
/// is approach + slip: an ease-out to a staging point just under the dock (critically
/// damped, capped under the startle speed — the sleepy face survives it), then the
/// slip (`beginTuckSlip`): the body rises the last stretch under the ink, shrinking
/// and fading, while the notch face comes up in its place — one continuous hand-off,
/// nothing pops, and Kevin's hand or a fly can take it back mid-way. Every duration
/// and curve is `Motion`'s. Dragging it out of the notch makes it free for the rest of the
/// session — the pill offers the explicit way back — and that freedom ends at the next
/// sleep: going to sleep always tucks it in, and the way home re-reads the mode wherever
/// it is tried (`goHomeForTransition`), so a tuck that was put off (the capsule open, a
/// drag, a summon) is not lost. Pause is not sleep: nothing moves. The notch is
/// wherever the display with the notch is (`NotchGeometry.current`), main or not, and
/// the dock and drop points follow it; without one (the lid closed) notch mode falls
/// back to free mode and comes back when the notch returns.
///
/// The transport is Go / Pause / Stop, AppState's (`transportToggle`, `transportStop`,
/// the same for every site): Pause closes the session — the meter stops — and the blob
/// dims to titanium with a `u u` face and a slow breath, and the pill says so; Go wakes
/// it or resumes it with the paused context.
///
/// Stop is felt at once. Every Stop pressed in the app — the capsule, the menu
/// (`stopPressed`), the Console's button and ⌘. — posts `stopPressedNotification`
/// in-process, ahead of the engine, and the blob answers it (`reactToStop`): any
/// flight or trace is cancelled, it shivers with wide eyes that settle back to its
/// normal face, and it stays where it is; the pill says "Stopped". Tucked, it only
/// shivers in the notch. The engine's phase → asleep, a moment later, is what tucks it
/// in. None of that waits on the engine, and nothing is latched: the capsule's Stop is
/// hot only while the snapshot holds a running delegation.
@MainActor
public final class OrbPanelController {
    public let state: AppState

    static let collapsedSize = BlobMetrics.panelSize
    /// 452×240 held the capsule with 10 pt outside it, 4 to the blob and 12 above and below.
    /// Its dithered shadow (`DitheredShadow`: spread 12, 6 pt low) needs 18 pt under the
    /// capsule and 12 beside it, so the panel is 8 wider and 12 taller; the capsule keeps its
    /// size and its 4 pt to the blob and sits 18 pt from the outer edge, the top and the bottom.
    static let expandedSize = NSSize(width: 460, height: 252)

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

    // Flights (orb.fly / orb.home / orb.trace).
    /// Where an `orb.fly` is: on the way out, parked beside the target, on the way
    /// back — or, for an `orb.trace`, drawing (`tracing`: parked with the pen on the
    /// line, led along it).
    private enum Flight: Equatable { case none, outbound, hovering, homing, tracing }
    private var flight = Flight.none
    /// The CG centre Kevin last put the blob at by hand (a drop, a fling, a summon, a
    /// poke's hop; the initial placement): where the explicit `orb.home` returns to in
    /// free mode. A spot a flight ended on is saved as `orbPosition` but never moves this.
    private var perch: CGPoint?
    private var flightTarget: CGPoint?
    private var flightDwell = 2.0
    /// CACurrentMediaTime deadline for the hover; each new orb.fly, the arrival and the park push it out.
    private var hoverUntil = 0.0
    private var hoverTimer: Task<Void, Never>?
    /// The launch, a wind-up after the command so the blob visibly tenses and turns colour first.
    private var takeoff: DispatchWorkItem?
    /// The crouch (`BlobSim.anticipate`) `Motion.anticipation` before the launch.
    private var anticipation: DispatchWorkItem?
    static let windup = Motion.quick
    /// An `orb.fly` that arrived while Kevin's own motion (a drop, a fling, a summon, a
    /// poke) was still gliding: it fires once that has landed and become the perch.
    private struct PendingFly { var target: CGPoint; var dwellMs: Double?; var reason: String?; var expires: Double }
    private var pendingFly: PendingFly?
    /// The capsule opened mid-flight: the flight is parked, and closing the capsule
    /// leaves the blob where it is as a worked spot (`stayHere`: saved, not the perch)
    /// instead of treating the capsule's spot as one Kevin chose.
    private var stayAfterCollapse = false
    private let trail: BlobTrail
    /// A flight ended and the body is settling where it worked (`stayHere`: a stuck
    /// dome sagging in): the settle saves the spot as `orbPosition` but leaves the
    /// perch alone. Kevin's hand (a drag, a summon, a poke) clears it: his landing is his.
    private var settlingAfterWork = false

    // Home: free, or the notch.
    /// The notch dock, built the first time notch mode comes on; nil until then.
    private var notch: NotchDock?
    /// The dock's content — everything the island shows that is not the face or the
    /// fleet's dots — built whole from the snapshot, the thread store, the mark state
    /// and the gate (`buildDockContent`); kept for a dock built later.
    private var dockContent = DockContent.empty
    /// Decoded thumbnails by mark id (`Thumbnails.shared`, at `thumbMaxPixel`), dropped with their marks.
    private var markThumbs: [String: CGImage] = [:]
    /// The thumbnail decode's longer side: the film is 84×60 pt drawn aspect-filled at 2×
    /// (168×120 px), so a wide crop must still bring 120 px of height — 2 × 84 × 16:9 =
    /// 216 keeps a 16:9 crop at 216×121 and a 16:10 one at 216×135, never upscaled into the film.
    static let thumbMaxPixel = 216
    private var markThumbsRequested: Set<String> = []
    /// A thumbnail landed: the content is rebuilt.
    private let thumbsChanged = CurrentValueSubject<Int, Never>(0)
    /// The dock's Ask with nothing circled: circle first, and the question follows the mark
    /// (same socket, in order — the engine registers the mark before any await).
    private var askAfterMark = false
    /// A mark's own trace launched from the dock brings the blob home instead of staying
    /// by the line (`MarkHomeRule`: `trace` arms it, `cancelFlight` and another job's fly
    /// interrupt it, `workDone` settles it); every other trace stays.
    private var markHome = MarkHomeRule()
    /// The pending marks last seen, for the tucked "◎ N circled · Go to ask" pill.
    private var pendingMarksSeen = 0
    /// Notch mode is on: the setting says notch, a display has one, and Kevin has not
    /// dragged the blob out since it last went to sleep.
    private var notchMode = false
    /// The blob is parked in the notch: the orb panel is hidden and the notch shows the face.
    private var tucked = false
    /// Kevin dragged the blob out of the notch: free until it next goes to sleep (the
    /// pill's "back to the notch" ends it sooner, by hand).
    private var freeForSession = false
    /// The notch panel is owed a hide once the drag that pulled the blob out lets go:
    /// it stays ordered in (clear, the island shrunk away) while the drag runs, so
    /// AppKit keeps delivering the drag's events to the view that took the mouse-down.
    private var hideNotchAfterDrag = false
    /// A real snapshot has arrived from the daemon. Until then the settings are the
    /// empty snapshot's (`orbHome` nil reads as "notch"), so the home is not decided —
    /// `connected` flips before the first snapshot, and deciding on it flew a free
    /// user's blob to the notch on every connect and saved that spot as his.
    private var snapshotArrived = false
    /// The sleep transition's way home, a beat after the phase fell asleep so the Stop's
    /// shiver shows first (`fellAsleep` → `tuckInForSleep`). A drag or a wake cancels it.
    private var sleepTuck: DispatchWorkItem?
    static let sleepTuckDelay = 0.55
    /// When the blob last dropped out of the notch (CACurrentMediaTime): the hop down
    /// shows for `dropWindup` before a flight's spring takes over.
    private var droppedAt = -100.0
    /// The hop out of the notch (`Motion.dropOut`) and a hair: a flight launched from
    /// the notch takes off as the drop finishes growing in.
    static var dropWindup: Double { Motion.seconds(Motion.dropOut) + 0.03 }

    // The slip: the last stretch into the notch and the first out of it.
    /// The way in ends, and the way out begins, with the body scaling and fading under
    /// the ink while the notch face takes over (`tuckIn` → `beginTuckSlip`, `dropOut`):
    /// one continuous hand-off, stepped every display frame from `physicsTick`. The
    /// approach settles at `tuckStaging` pt under the dock; the slip then rises the
    /// body over `Motion.tuckSlip` until its top is `tuckUnderInk` under the menu
    /// bar's bottom edge, scaling about that top (position and scale ease-in-out,
    /// alpha ease-in), hands the notch the face at `tuckHandoff` of the way
    /// (`NotchDock.parked`, and the sim's clock with it — `BlobFieldView.stepsSim`)
    /// and ends tucked. The drop is the reverse over `Motion.dropOut`, ease-out: the
    /// body appears at `dropStartScale` and clear just under the ink, grows down out
    /// of it and hops `dropHop` pt — unless a hand or a spring already owns its position.
    private struct Slip {
        enum Kind { case tuck, drop }
        var kind: Kind
        var duration: Double
        var elapsed = 0.0
        var from: CGPoint
        var to: CGPoint
        /// The slip places the body (a plain tuck or drop); false when the drag physics
        /// or a goal spring has it (a drag out into the hand, a summon, a launched fly).
        var drivesPosition: Bool
        /// The body scales as it fades (off under Reduce Motion: a plain fade).
        var scales = true
        /// The notch has been given the face (tuck only).
        var handedOff = false
        var progress: Double { min(1, elapsed / duration) }
    }
    private var slip: Slip?
    static let tuckStaging: CGFloat = 16
    /// How far under the menu bar's bottom edge the body's top ends the slip.
    static let tuckUnderInk: CGFloat = 30
    static let tuckHandoff = 0.6
    static let tuckEndScale = 0.55
    static let dropStartScale = 0.6
    static let dropHop: CGFloat = 28
    /// The container layer's scale as drawn (1 at rest), for the preview harness.
    private var presentationScale = 1.0
    /// The pill's way back to the notch after a drag out ("free — …"); above toasts.
    private let homePill = CurrentValueSubject<OrbPill?, Never>(nil)
    private var homePillTimer: Task<Void, Never>?

    // Traces (orb.trace).
    /// The stroke being drawn: the flight out carries it (`trace` set, `flight`
    /// outbound), `startTracing` begins the line once parked, `advanceTrace` leads the
    /// pen along it every physics tick.
    private var trace: TracePath?
    /// An `orb.trace` that arrived while Kevin's own motion was still gliding (see `PendingFly`).
    private var pendingTrace: (cmd: OverlayCommand, expires: Double)?
    /// The 300 ms the pen holds on the finished line before it morphs back and goes home.
    private var traceHold: DispatchWorkItem?
    /// Cruise, pt/s. Eased in and out over `traceEase` pt; corners slow the pen.
    nonisolated static let traceSpeed = 700.0
    nonisolated static let traceEase = 110.0
    static let traceHoldSeconds = 0.3
    /// The stroke's life on the overlay after it is sealed, when the command names none.
    static let traceDefaultTTL = 6000.0
    /// The line so far goes out at most this often (the overlay paints at 30 Hz; a
    /// publish every physics tick — 120 on a ProMotion panel — repainted the whole
    /// display's canvas four times per painted frame and cost the trace twice a
    /// flight's CPU), and only once the pen has moved `tracePublishMinMove`; a new
    /// vertex, the seal and a cancel always go out at once.
    /// A hair under a 30th: four ticks of a 120 Hz link (or two of a 60 Hz one) then
    /// make the interval instead of missing it by a fraction and waiting for a fifth.
    static let tracePublishInterval = 0.031
    static let tracePublishMinMove = 2.0
    private var lastTracePublishAt = 0.0
    private var lastTracePublishSegment = -1
    private var lastTracePublishPen = CGPoint.zero

    /// Posted by every Stop pressed in the app — here (`stopPressed`), the Console's
    /// button and ⌘. (`ConsoleWindowController.handle(.stop)`) — the moment it is
    /// pressed, so the blob reacts without waiting on the engine. In-process only. The
    /// Console names it by its string (its preview compiles without UI/Orb); the
    /// status item and the ⌥⎋ hotkey should post it too.
    public nonisolated static let stopPressedNotification = Notification.Name("jarhead.stopPressed")

    /// The main thread's id on the wire (`MAIN_THREAD_ID`): a fly tagged with it is this blob's, like an untagged one.
    nonisolated static let mainThreadId = "main"

    private var sim: BlobSim { blobView.sim }

    // MARK: - The fleet (satellites)

    /// The satellite fleet (`BlobFleet`), when the app has one: its bodies are obstacles
    /// to this one, and it re-orders its panels under this one whenever this panel comes
    /// forward (`bringPanelForward`). Weak: the fleet holds the controller.
    public weak var fleet: BlobFleet?

    /// Order the orb panel front — and the satellites right under it, so the main blob
    /// always paints over its fleet: every site that used to call `orderFrontRegardless`.
    private func bringPanelForward() {
        panel.orderFrontRegardless()
        fleet?.mainCameForward()
    }

    /// The body's centre and collision radius (CG), for the fleet's landing chooser and
    /// its rank slots; the rect the satellites treat as occupied.
    public var mainBodyCenterCG: CGPoint { body.center }
    public var mainBodyRadius: CGFloat { body.radius }
    public var mainBodyRect: CGRect { CGRect(x: body.center.x - body.radius, y: body.center.y - body.radius, width: 2 * body.radius, height: 2 * body.radius) }
    /// The main body is on the move (a flight, a throw, Kevin's hand): the fleet watches for its settle.
    public var mainBodyMoving: Bool { body.isActive || body.dragging }
    /// The orb panel's window number and whether it is showing: satellites order themselves just under it.
    public var orbWindowNumber: Int { panel.windowNumber }
    public var orbPanelVisible: Bool { panel.isVisible }
    public var isTucked: Bool { tucked }
    /// The notch's geometry when the dock exists, else the display's notch if any: the catch zone's basis.
    var notchGeometryCurrent: NotchGeometry? { notch?.geometry ?? NotchGeometry.current() }
    /// The screen the orb is on (the panel's, or the notch's while tucked): the fleet's display link is made from it.
    public var orbScreen: NSScreen? { panel.isVisible ? panel.screen : (notch?.panel.screen ?? panel.screen) }
    /// Where a satellite with nowhere to be anchors its rank slot: the main body when it
    /// is out (the slots arc above it), the row under the notch while tucked (the slots
    /// arc below it, clear of the island), else the perch. Nil before placement.
    public var fleetAnchorCG: (point: CGPoint, radius: CGFloat, below: Bool)? {
        if panel.isVisible, !tucked { return (body.center, body.radius, false) }
        if tucked, let n = notch { return (CGPoint(x: n.dockPointCG.x, y: n.dockPointCG.y + 70), body.radius, true) }
        if let p = perch { return (p, body.radius, false) }
        return nil
    }
    /// The live spawned threads' dots for the notch (`BlobFleet.threadDots`), kept for a dock built later.
    func setThreadDots(_ dots: [ThreadDot]) {
        threadDots = dots
        notch?.setThreads(dots)
    }
    private var threadDots: [ThreadDot] = []

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

        // The capsule's Go/Pause is the transport's (`transportToggle`).
        capsuleHost.rootView = OrbCapsuleView(model: capsuleModel, actions: OrbCapsuleActions(
            transportToggle: { [weak self] in self?.state.transportToggle() },
            toggleMute: { [weak self] in self?.toggleMute() },
            stop: { [weak self] in self?.stopPressed() },
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
        // Sticky borders: the patch letting go, and a landing hard enough to splat.
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
        // The listening eyes follow the hand when it is near.
        sim.pointer = { [weak self] in
            guard let self else { return nil }
            let m = CGSpace.point(fromAppKit: NSEvent.mouseLocation)
            return CGVector(dx: m.x - self.body.center.x, dy: m.y - self.body.center.y)
        }

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
        anticipation?.cancel()
        traceHold?.cancel()
        homePillTimer?.cancel()
        sleepTuck?.cancel()
        collapseWork?.cancel()
    }

    // MARK: - Public API (fixed signature)

    public func show() {
        if !positioned { placeInitially() }
        // Home first: in notch mode the blob starts tucked, and the panel stays hidden.
        updateHomeMode(animated: false)
        statusModel.shown = true
        if tucked {
            notch?.show()
            return
        }
        blobView.paused = false
        bringPanelForward()
        blobView.poke()
    }

    public func hide() {
        collapse()
        pendingFly = nil
        pendingTrace = nil
        sleepTuck?.cancel(); sleepTuck = nil
        // A slip has no time left to finish: into the notch it is tucked now, out of it
        // the body is whole where it is.
        if let s = slip {
            if s.kind == .tuck { finishTuckSlip() } else { endDropSlip(settle: false) }
        }
        if flight != .none {
            // Cut the flight short and stop the body where it is, so it reappears
            // there: a goal spring left armed would fly on after show() and settle
            // somewhere else as if it had worked there. Where it stopped is saved as
            // a worked spot (the perch is Kevin's).
            cancelFlight()
            settlingAfterWork = false
            persistPosition(asPerch: false)
        }
        notch?.hide()
        blobView.paused = true
        statusModel.shown = false
        panel.orderOut(nil)
    }

    /// The capsule — or, parked in the notch, the notch's island. Half-way into the
    /// notch it is still the capsule: the slip is cancelled (`expand` →
    /// `cancelTuckSlip`) and the body comes back whole at the staging point with the
    /// capsule on it — the same as a double-click on the slipping body, so the hotkey,
    /// the menu and the click agree. Only a body actually in the notch opens the island.
    public func toggleExpanded() {
        if tucked { notch?.toggleIsland(); return }
        if expanded { collapse(animated: true) } else { expand() }
    }

    /// Fling the blob to the cursor (landing slightly above it) with a bounce. Kevin
    /// calling it over ends any flight: where it lands is the new perch. In notch mode
    /// it drops out of the notch first and stays by the cursor like anywhere else — the
    /// next sleep or wake takes it back up. The cursor may be on any display.
    public func summon() {
        // A capsule opened mid-flight parks the flight; Kevin's call takes over from there.
        if expanded { collapse() }
        cancelFlight()
        sleepTuck?.cancel(); sleepTuck = nil
        // Kevin's call takes over a body still settling where it worked: where it lands is his.
        settlingAfterWork = false
        pendingFly = nil
        pendingTrace = nil
        if !positioned { placeInitially() }
        // Half-way into the notch, Kevin's call takes it back: whole again where it was.
        cancelTuckSlip()
        if tucked { dropOut() }
        let mouse = CGSpace.point(fromAppKit: NSEvent.mouseLocation)
        let goal = CGPoint(x: mouse.x, y: mouse.y - 40)
        blobView.paused = false
        bringPanelForward()
        statusModel.shown = true
        userMoved = true
        body.summon(to: goal)
        sim.nudge(1.5)
        scanObstacles(force: true)
        blobView.poke()
    }

    public var isVisible: Bool { panel.isVisible || (tucked && (notch?.isVisible ?? false)) }

    // MARK: - State binding

    private func bind() {
        state.$snapshot
            .map(\.phase)
            .removeDuplicates()
            .sink { [weak self] phase in
                guard let self else { return }
                // The awake↔asleep transitions are the only ones that move the blob
                // (`fellAsleep`, `wokeUp`). Asleep and error are the dormant side (no
                // session either way: a failed wake, a session that died); paused is not
                // — it holds the conversation, and nothing moves in or out of it.
                let was = self.sim.phase
                self.sim.setPhase(phase)
                self.notch?.phaseChanged()
                let dormant = Self.dormantPhases
                if dormant.contains(phase), !dormant.contains(was) {
                    self.fellAsleep()
                } else if dormant.contains(was), !dormant.contains(phase), phase != .paused {
                    self.wokeUp()
                }
                self.blobView.poke()
            }
            .store(in: &cancellables)

        // Home: free or the notch, from the setting (and the display). The payload is
        // the new value while the snapshot is still the old one in here, so the mode
        // is read on the next turn of the main queue.
        state.$snapshot
            .map(\.settings.orbHome)
            .removeDuplicates()
            .sink { [weak self] _ in
                DispatchQueue.main.async { MainActor.assumeIsolated { self?.updateHomeMode(animated: true) } }
            }
            .store(in: &cancellables)
        // The first real snapshot: the settings are the daemon's now, and the home can
        // be decided — even when `orbHome` says what the empty snapshot already carried,
        // which the sink above would not see as a change.
        // `connected` is not that moment: it flips before the first snapshot arrives.
        state.$snapshot
            .filter { $0 != .empty }
            .first()
            .sink { [weak self] _ in
                guard let self else { return }
                self.snapshotArrived = true
                DispatchQueue.main.async { MainActor.assumeIsolated { self.updateHomeMode(animated: true) } }
            }
            .store(in: &cancellables)
        // The dock's content: built whole from the snapshot, the thread store, the mark
        // state, the gate and the decoded thumbnails; set only when it differs.
        // The automations (design11): the ring, the next fire and the rows, as AppState holds them from the
        // snapshot and the `automation.event` deltas — payloads, never re-read from `state` in here.
        let automations = Publishers.CombineLatest3(state.$ringing.removeDuplicates(), state.$nextFire.removeDuplicates(), state.$automations.removeDuplicates())
        Publishers.CombineLatest4(state.$snapshot, state.$threads, state.$marking.eraseToAnyPublisher().removeDuplicates(), state.$wakeGate.removeDuplicates())
            .combineLatest(thumbsChanged, automations)
            .map { [weak self] top, _, auto -> (DockContent, [ScreenMark]) in
                guard let self else { return (.empty, []) }
                return (self.buildDockContent(snapshot: top.0, threads: top.1, marking: top.2, gate: top.3, ringing: auto.0, nextFire: auto.1, automations: auto.2), top.0.marks)
            }
            .removeDuplicates { $0.0 == $1.0 }
            .sink { [weak self] content, marks in self?.dockContentChanged(content, marks: marks) }
            .store(in: &cancellables)
        // Mark mode: the island folds before the overlay takes the mouse, and unfolds
        // when the stroke is done or cancelled. An Ask that was waiting for a mark that
        // never came is forgotten.
        state.$marking.eraseToAnyPublisher()
            .removeDuplicates()
            .sink { [weak self] marking in
                guard let self else { return }
                if marking {
                    self.notch?.foldForMark()
                } else {
                    self.notch?.markEnded()
                    self.askAfterMark = false
                }
            }
            .store(in: &cancellables)
        // The mark is registered (`mark.add` sent): the Ask that asked for it sends its
        // question now, in order on the same socket.
        state.markCommitted
            .sink { [weak self] in
                guard let self, self.askAfterMark else { return }
                self.askAfterMark = false
                self.state.send(.sayText(ComposerWords.askAboutMarks(window: false)))
            }
            .store(in: &cancellables)
        // Toasts on the notch: the latest, 1.5 s, while the blob is parked there.
        state.$toasts
            .map(\.last)
            .removeDuplicates { $0?.id == $1?.id }
            .compactMap { $0 }
            .sink { [weak self] t in
                guard let self, self.tucked else { return }
                let tone: PillTone
                switch t.tone {
                case .info: tone = .info
                case .warn: tone = .warn
                case .error: tone = .error
                }
                self.notch?.showPill(t.text, symbol: nil, tone: tone, seconds: 1.5)
            }
            .store(in: &cancellables)
        // The island's working state: "Working · 0:12" while a delegation runs, counted from its start.
        state.$snapshot
            .map { (s: Snapshot) -> Double? in s.delegations.last { $0.status == .running }.map { $0.timings.delegatedAt / 1000 } }
            .removeDuplicates()
            .sink { [weak self] since in self?.notch?.setWorking(since: since) }
            .store(in: &cancellables)
        gatePill
            .sink { [weak self] pill in self?.notch?.setGatePill(pill) }
            .store(in: &cancellables)

        state.$levels
            .sink { [weak self] levels in
                guard let self else { return }
                self.sim.setLevels(levels)
                if levels.input > 0.02 || levels.output > 0.02 {
                    self.blobView.poke()
                    if self.tucked { self.notch?.view.wake() }
                }
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

        // The pill: the first problem, else the gate, else the way back to the notch,
        // else the latest toast, else "Paused · meter stopped" while paused. The gate
        // outranks toasts because its lockout toast and countdown arrive together and
        // the countdown is the one worth the space. A toast that repeats the showing
        // one's words (the app's "Stopped", then the engine's "stopped" a moment later)
        // does not flip the pill.
        Publishers.CombineLatest4(
            state.$snapshot.map { $0.problems.first?.text }.removeDuplicates(),
            gatePill.removeDuplicates(),
            homePill.removeDuplicates(),
            state.$toasts.map(\.last).removeDuplicates { a, b in
                a?.tone == b?.tone && a?.text.lowercased() == b?.text.lowercased()
            })
            .combineLatest(state.$snapshot.map(\.phase).removeDuplicates(), state.$ringing.removeDuplicates())
            .map { [weak self] top, phase, ring -> OrbPill? in
                let (problem, gate, home, toast) = top
                // A ring first (design11: ring > problem > gate > home > toast): its line, Snooze as the pill's one press.
                if let r = ring { return OrbPill(text: r.line, tone: .info, icon: "bell.fill", action: { [weak self] in self?.snoozeRing(r) }, actionTitle: "Snooze") }
                if let p = problem { return OrbPill(text: p, tone: .error) }
                if let g = gate { return g }
                if let h = home { return h }
                if let t = toast { return OrbPill(text: t.text, tone: t.tone) }
                if phase == .paused { return OrbPill(text: "Paused · meter stopped", tone: .info, icon: "pause.fill") }
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
                guard let self, !self.userMoved, !self.expanded, !self.body.isActive, self.flight == .none, !self.tucked, self.slip == nil else { return }
                self.apply(savedPosition: pos)
            }
            .store(in: &cancellables)

        // Flights and traces. The overlay layer draws the shapes; the blob answers
        // these — and `clear`, which takes a line it is drawing down with the shapes.
        // `clear` is the brain's ordinary show_clear as much as a Stop's, so it is not
        // a Stop here: the Stop comes on `stopPressedNotification` below. A fly or
        // trace tagged with a spawned thread's id is that thread's satellite's
        // (`BlobFleet.route`); untagged — or tagged "main" — it is this blob's.
        state.overlayCommands
            .receive(on: DispatchQueue.main)
            .sink { [weak self] cmd in
                guard let self else { return }
                switch cmd {
                case .orbFly(let x, let y, let dwellMs, let reason, let thread) where thread == nil || thread == Self.mainThreadId:
                    self.fly(to: CGPoint(x: x, y: y), dwellMs: dwellMs, reason: reason)
                case .orbTrace(let points, let closed, let label, let ttlMs, let tone, let reason, let thread) where thread == nil || thread == Self.mainThreadId:
                    self.trace(points: points.map { CGPoint(x: $0.x, y: $0.y) }, closed: closed, label: label, ttlMs: ttlMs, tone: tone, reason: reason)
                case .orbHome:
                    self.flyHome()
                case .clear:
                    self.drawingsCleared()
                default:
                    break
                }
            }
            .store(in: &cancellables)

        let nc = NotificationCenter.default
        // A Stop pressed anywhere in the app, the moment it is pressed.
        observers.append(nc.addObserver(forName: Self.stopPressedNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.reactToStop() }
        })
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
        notch?.view.wake()
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
        bringPanelForward()
    }

    /// A display came or went, or moved. A resting body is not stepped, so it would
    /// otherwise stay parked on a display that no longer exists, out of reach until
    /// the next summon; pull it onto the nearest work area now. The panel is re-placed
    /// from the body either way, because the AppKit origin shifts when the primary
    /// display's frame does even though the CG position has not.
    private func screensDidChange() {
        // The notch may have come or gone (or moved with its display).
        updateHomeMode(animated: true)
        if tucked { return }
        // Half-way into a notch that may have moved: whole again where it was; the next
        // transition finds the way home afresh.
        cancelTuckSlip()
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

    // MARK: - Home (free / notch)

    /// Free or notch. Notch mode needs the setting (`orbHome`, "notch" unless set) and
    /// a notch on some display (`NotchGeometry.current`, main or not), and is off while
    /// Kevin has the blob dragged out (`freeForSession`, until the next sleep). Coming
    /// on — the setting, the pill's way back, the notch's display returning, a sleep or
    /// wake ending the drag-out (`quiet`: the transitions' drift, in the phase's own
    /// face and colour, no wake of ghosts) — it sends an idle blob up into the notch
    /// (at once when nothing is showing yet); going off,
    /// a tucked blob drops out to float under where the notch was, and where it lands
    /// is the perch — and a blob still on its way up to the notch turns round and
    /// drifts back to the perch instead, so the spot under the notch is never settled
    /// on and saved as Kevin's. Until the daemon's first
    /// snapshot has arrived the setting is unknown (the empty snapshot would read as
    /// "notch", and `connected` comes before the snapshot), so the blob starts free and
    /// flies up on the first snapshot that says notch — never dropping a free user's
    /// blob under the notch and saving that as his spot.
    private func updateHomeMode(animated: Bool, quiet: Bool = false) {
        let geometry = NotchGeometry.current()
        let known = snapshotArrived
        let wants = known && state.snapshot.settings.livesInNotch && !freeForSession && geometry != nil
        if let geometry { notch?.apply(geometry: geometry) }
        guard wants != notchMode else { return }
        notchMode = wants
        if wants, let geometry {
            let dock = notch ?? makeDock(geometry)
            notch = dock
            hideNotchAfterDrag = false
            dock.setGatePill(gatePill.value)
            dock.setContent(dockContent)
            if flight == .none, !body.dragging, !expanded, slip == nil {
                // A transition's way home, or a blob already dormant (the pill pressed
                // on a sleeping blob): the way up is the quiet one.
                if animated, positioned, panel.isVisible { driftHome(quiet: quiet || isDormant) } else { tuckIn(instant: true) }
            }
        } else {
            sleepTuck?.cancel(); sleepTuck = nil
            if tucked {
                dropOut()
            } else if flight == .homing || slip?.kind == .tuck {
                // On its way up to the notch — or half slipped into it: the notch is
                // not home any more. Whole again, and back to the perch (home now) — its
                // settle there is the perch again, not the dock.
                cancelTuckSlip()
                cancelFlight()
                if perch != nil { driftHome() }
            }
            hideNotchAfterDrag = false
            notch?.hide()
        }
        #if JARHEAD_ORB_PREVIEW
        print(String(format: "home: %@%@ (notch %@)", notchMode ? "notch" : "free", freeForSession ? " (dragged out)" : "", geometry == nil ? "none" : "present"))
        fflush(stdout)
        #endif
    }

    private func makeDock(_ geometry: NotchGeometry) -> NotchDock {
        let dock = NotchDock(sim: sim, geometry: geometry)
        dock.togglePause = { [weak self] in self?.togglePause() }
        dock.stop = { [weak self] in self?.stopPressed() }
        dock.toggleMute = { [weak self] in self?.toggleMute() }
        dock.dragOut = { [weak self] p in self?.dragOutOfNotch(at: p) }
        dock.dragMoved = { [weak self] p in self?.pointerDragged(to: p) }
        dock.dragEnded = { [weak self] in self?.pointerUp(clickCount: 1, time: ProcessInfo.processInfo.systemUptime) }
        // The island's boxes. Circle sends nothing itself (`mark.add` is the overlay's);
        // a thread's Stop is one `thread.stop`, never the transport's; Sleep is the
        // drop's sleep with its cause; nothing here opens a paid session but Go and a
        // typed line under `typedWakes`.
        dock.circle = { [weak self] in self?.circleFromDock() }
        dock.window = { [weak self] in self?.windowFromDock() }
        dock.ask = { [weak self] in self?.askFromDock() }
        dock.clear = { [weak self] in self?.clearFromDock() }
        dock.allow = { [weak self] id in self?.state.threadAnswer(id, yes: true) }
        dock.deny = { [weak self] id in self?.state.threadAnswer(id, yes: false) }
        dock.forgetMark = { [weak self] id in self?.state.markRemove(id) }
        dock.openMark = { [weak self] _ in self?.state.openConsole() }
        dock.openThread = { [weak self] id in self?.state.openThread(id) }
        dock.stopThread = { [weak self] id in self?.state.threadStop(id) }
        dock.console = { [weak self] in self?.state.openConsole() }
        dock.sleep = { [weak self] in self?.state.send(.sleepCause("dock")) }
        dock.remedy = { [weak self] row in self?.remedyFromDock(row) }
        dock.say = { [weak self] text in self?.state.send(.sayText(text)) }
        // The ring's presses (design11): Snooze · Done go to the row; the head and Open go to the Console — never a session.
        dock.snooze = { [weak self] id, minutes in self?.state.send(.automationSnooze(id: id, minutes: minutes)) }
        dock.done = { [weak self] id in self?.state.send(.automationDone(id: id)) }
        dock.ringOpen = { [weak self] _, _ in self?.state.openConsole() }
        dock.setThreads(threadDots)
        dock.setContent(dockContent)
        return dock
    }

    // MARK: - The dock's boxes

    /// The ◎ box: the island folds out of the way first, then the overlay takes the stroke.
    private func circleFromDock() {
        notch?.foldForMark()
        state.beginMarkMode()
    }

    /// The ▭ box: the front window as a mark. With Jarhead itself frontmost (the Console
    /// clicked) there is no window of Kevin's to capture: a toast, nothing sent.
    private func windowFromDock() {
        if NSApp.isActive {
            notch?.showPill("Bring a window forward first", symbol: "macwindow", tone: .warn, seconds: 1.5)
        } else {
            state.markWindow()
        }
    }

    /// The ? box: with a mark pending, the one question about it (a window's asks about
    /// the window); with nothing circled, circle first and the question follows the mark.
    private func askFromDock() {
        if dockContent.pendingMarks > 0 {
            let newestPendingIsWindow = dockContent.marks.last(where: { !$0.consumed })?.isWindow ?? false
            state.send(.sayText(ComposerWords.askAboutMarks(window: newestPendingIsWindow)))
        } else {
            askAfterMark = true
            notch?.foldForMark()
            state.beginMarkMode()
        }
    }

    /// The ⌫ box: every mark leaves (the PNGs stay the day's shots); the pill says how many.
    private func clearFromDock() {
        let n = dockContent.marks.count
        state.send(.markClear)
        notch?.showPill("Cleared · \(n)", symbol: "eraser.fill", tone: .info, seconds: 1.5)
    }

    /// The foot's remedy box: the remedy's command when the engine gave one this app can
    /// send, its place when it named one (`jarhead://setup` in-process), else
    /// `problem.retry` for the kind — the Console's dispatch.
    private func remedyFromDock(_ row: DockContent.ProblemRow) {
        if let json = row.remedyJSON, let data = json.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let cmd = EngineCommand(remedyJSON: obj) {
            state.send(cmd)
        } else if let target = row.openTarget, !target.isEmpty {
            if target.lowercased().hasPrefix("jarhead://setup") {
                state.openOnboarding()
            } else if let url = URL(string: target) {
                NSWorkspace.shared.open(url)
            }
        } else {
            state.send(.problemRetry(kind: row.kind))
        }
    }

    /// ⌥⇧Return: type to Jarhead — the notch's field while the blob is parked there, else
    /// the Console's composer.
    public func sayLine() {
        if tucked, let notch { notch.focusField() } else { state.openConsole() }
    }

    // MARK: - The dock's content

    /// One `DockContent` from the snapshot, the thread store (rail order: the asking
    /// thread first), the mark state and the gate. Spawned threads only: main's turn is
    /// the transport's; main's awaiting-confirmation delegation counts as "Jarhead asks".
    private func buildDockContent(snapshot s: Snapshot, threads store: [String: WorkThread], marking: Bool, gate: WakeGateState,
                                  ringing: RingLine? = nil, nextFire: NextFire? = nil, automations: [Automation] = []) -> DockContent {
        let now = Date()
        let awake = s.phase != .asleep
        let inSession = AppState.inSessionPhases.contains(s.phase)
        let marks: [DockContent.Mark] = s.marks.map { m in
            DockContent.Mark(id: m.id, size: CGSize(width: m.rect.w, height: m.rect.h), at: Date(timeIntervalSince1970: m.at / 1000),
                             consumed: m.consumed, isWindow: m.isWindow, caption: ComposerWords.markCaption(m, now: now),
                             hasPixels: m.screenshotPath != nil, thumbnail: markThumbs[m.id])
        }
        let live = AppState.railOrder(Array(store.values)).filter { $0.status.isLive && $0.id != Self.mainThreadId }
        var rows: [DockContent.ThreadRow] = []
        var question: DockContent.Question?
        for t in live {
            let asking = t.status == .waitingKevin
            rows.append(DockContent.ThreadRow(id: t.id, name: t.name, word: t.status.orbWord, since: Date(timeIntervalSince1970: t.startedAt / 1000),
                                              tone: OrbPalette.color(for: t.status.satellitePhase), canStop: t.canStop && !asking, asks: t.question))
            if question == nil, asking, let q = t.question, !q.isEmpty {
                question = DockContent.Question(threadId: t.id, name: t.name, text: q)
            }
        }
        if question == nil, let d = s.delegations.last(where: { $0.status == .awaitingConfirmation }) {
            question = DockContent.Question(threadId: Self.mainThreadId, name: "Jarhead", text: d.request)
        }
        var problem: DockContent.ProblemRow?
        if let p = s.problems.first {
            var json: String?
            if let cmd = p.remedy?.command, let data = try? JSONEncoder().encode(cmd) { json = String(data: data, encoding: .utf8) }
            problem = DockContent.ProblemRow(kind: p.kind, symbol: ProblemGlyphs.symbol(for: p.kind), warn: ProblemGlyphs.isWarning(p.kind), text: p.text,
                                             remedyLabel: p.remedy?.label, remedyJSON: json, openTarget: p.remedy?.open, more: max(0, s.problems.count - 1))
        }
        var meter = DockContent.Meter(inSession: inSession, paused: !inSession && s.pause != nil, elapsed: nil, billedSeconds: nil,
                                      todaySeconds: s.usageToday?.seconds, sleepsIn: nil)
        if let session = s.session {
            meter.elapsed = max(0, now.timeIntervalSince1970 - session.startedAt / 1000)
            meter.billedSeconds = session.usageSeconds
        }
        if let pause = s.pause, !inSession {
            meter.billedSeconds = pause.usageSeconds
            meter.sleepsIn = max(0, (pause.sleepsAt - now.timeIntervalSince1970 * 1000) / 1000)
        }
        let ws = s.settings.wake
        let gateLabel = awake ? nil : OrbStyle.gateLabel(gate, phrases: ws.phrases, auth: ws.auth, now: now, paused: s.phase == .paused)
        let rings = Self.ringRows(ringing: ringing, nextFire: nextFire, automations: automations, snoozeMinutes: s.settings.automationSettings.snoozeMinutes)
        return DockContent(awake: awake, inSession: inSession, typedWakes: s.settings.typedWakes,
                           request: s.delegations.last { $0.status == .running }?.request,
                           lastLine: s.transcript.last?.text, gateLabel: gateLabel,
                           marks: marks, question: question, threads: rows, problem: problem, meter: meter,
                           marking: marking, screenRecordingGranted: s.permissions.grant(.screenRecording) != .denied,
                           ring: rings.ring, next: rings.next, timer: rings.timer)
    }

    /// The ring (the newest `fired` row with a line), the foot's next fire and the soonest running timer, in the
    /// dock's words: the kind's label, the head's source line, the chip's figure, the Snooze box's minutes (the
    /// ring's own snooze press, else Settings — timers five).
    static func ringRows(ringing: RingLine?, nextFire: NextFire?, automations: [Automation], snoozeMinutes: Int) -> (ring: DockContent.RingRow?, next: DockContent.NextRow?, timer: DockContent.TimerRow?) {
        var ring: DockContent.RingRow?
        if let r = ringing {
            let row = automations.first { $0.id == r.id }
            let kind = AutomationKindWord(rawValue: r.kind) ?? row?.kind ?? .alarm
            let presses = r.presses.map { DockContent.RingPress(kind: $0.kind, minutes: $0.minutes, target: $0.target) }
            let snooze = presses.first { $0.kind == "snooze" }?.minutes ?? (kind == .timer ? 5 : snoozeMinutes)
            let head = RingWords.head(kindLabel: kind.label, whenKind: row?.when.kind, phrase: row?.when.phrase, eventKind: row?.when.on?.kind)
            ring = DockContent.RingRow(id: r.id, kind: kind.rawValue, kindLabel: kind.label, name: r.name, line: r.line, calm: r.calm, head: head,
                                       chip: RingWords.chip(line: r.line, name: r.name), lateMs: r.lateMs, presses: presses, more: max(0, r.more), snoozeMinutes: snooze)
        }
        var next: DockContent.NextRow?
        if let n = nextFire, n.at.isFinite {
            let kind = AutomationKindWord(rawValue: n.kind) ?? .alarm
            let at = Date(timeIntervalSince1970: n.at / 1000)
            next = DockContent.NextRow(kindLabel: kind.label, clock: RingWords.clock(at), name: n.name, until: kind == .timer ? at : nil)
        }
        let soonest = automations.filter { $0.kind == .timer && $0.state == "armed" && ($0.nextAt?.isFinite ?? false) }.min { ($0.nextAt ?? 0) < ($1.nextAt ?? 0) }
        let timer = soonest.map { DockContent.TimerRow(id: $0.id, name: $0.name, until: Date(timeIntervalSince1970: ($0.nextAt ?? 0) / 1000)) }
        return (ring, next, timer)
    }

    /// The capsule pill's Snooze (free mode): the ring's own snooze press, else Settings' minutes (timers five).
    private func snoozeRing(_ r: RingLine) {
        let settings = state.snapshot.settings.automationSettings.snoozeMinutes
        let minutes = r.presses.first { $0.kind == "snooze" }?.minutes ?? (r.kind == "timer" ? 5 : settings)
        state.send(.automationSnooze(id: r.id, minutes: minutes))
    }

    /// New content: the dock takes it; a mark that landed while tucked gets its six
    /// seconds of "◎ N circled · Go to ask"; crops on their way are asked for.
    private func dockContentChanged(_ c: DockContent, marks: [ScreenMark]) {
        if c.pendingMarks > pendingMarksSeen, tucked, !c.awake {
            notch?.showPill("◎ \(c.pendingMarks) circled · Go to ask", symbol: nil, tone: .mark, seconds: 6)
        }
        pendingMarksSeen = c.pendingMarks
        dockContent = c
        notch?.setContent(c)
        // The snapshot itself (not `state.snapshot`: `@Published` publishes before the property is set).
        requestThumbnails(for: marks)
    }

    /// Decode each mark's crop once its path appears, off the main thread, sized for the
    /// aspect-filled 84×60 film at 2× (the minis downsample from the same decode); drop
    /// what the snapshot no longer lists.
    private func requestThumbnails(for marks: [ScreenMark]) {
        let ids = Set(marks.map(\.id))
        markThumbs = markThumbs.filter { ids.contains($0.key) }
        markThumbsRequested = markThumbsRequested.filter { ids.contains($0) }
        for m in marks where !markThumbsRequested.contains(m.id) {
            guard let path = m.screenshotPath, !path.isEmpty else { continue }
            markThumbsRequested.insert(m.id)
            let id = m.id
            Thumbnails.shared.thumbnail(for: state.screenshotURL(path), maxPixel: Self.thumbMaxPixel) { [weak self] img in
                guard let self, let img, self.markThumbsRequested.contains(id) else { return }
                self.markThumbs[id] = img
                self.thumbsChanged.send(self.thumbsChanged.value + 1)
            }
        }
    }

    /// Where home is: the notch's dock in notch mode, else the perch — the spot Kevin last put it by hand.
    private var homePoint: CGPoint? { notchMode ? notch?.dockPointCG : perch }

    /// Out of the notch: the body appears just under the ink at `dropStartScale` and
    /// clear, grows in and fades in over `Motion.dropOut` (ease-out) while it hops
    /// `dropHop` pt down, softly — no fling, no splat — as the notch face fades out
    /// (`NotchDock.parked`). A flight's spring or Kevin's hand takes it from there:
    /// `toward` puts it under a hand instead of under the notch, and into the hand it
    /// follows the pointer from the first frame (the drag physics own its position;
    /// only the scale and alpha grow in). Under Reduce Motion: a plain fade, half as
    /// long, no hop.
    private func dropOut(toward hand: CGPoint? = nil) {
        guard tucked, let notch else { return }
        tucked = false
        notch.parked = false
        let start = hand ?? notch.dropPointCG
        placeBody(centerCG: start)
        blobView.stepsSim = true
        blobView.paused = false
        let reduced = reducedMotion
        // Clear and small before the panel is ordered in, never after: the tuck left it
        // whole and opaque, and a window ordered in ahead of its alpha could composite
        // one frame of a full body under the notch before the grow-in began.
        setPresentation(scale: reduced ? 1 : Self.dropStartScale, alpha: 0, aboutTop: true)
        bringPanelForward()
        droppedAt = CACurrentMediaTime()
        slip = Slip(kind: .drop, duration: Motion.seconds(Motion.dropOut), from: start,
                    to: CGPoint(x: start.x, y: start.y + Self.dropHop), drivesPosition: hand == nil && !reduced, scales: !reduced)
        sim.nudge(reduced ? 0.3 : 0.8)
        scanObstacles(force: true)
        blobView.poke()
        #if JARHEAD_ORB_PREVIEW
        print(String(format: "notch: drop out at CG %.0f,%.0f%@", body.center.x, body.center.y, hand == nil ? "" : " (into the hand)"))
        timelineStart = CACurrentMediaTime()
        timelinePeak = 0
        timeline("drop begins")
        fflush(stdout)
        #endif
    }

    /// Up into the notch. Instant (the first show, a mode flip with nothing on screen,
    /// Reduce Motion): the notch shows the face and the orb panel is hidden. Otherwise
    /// the slip (`beginTuckSlip`): the body rises the last stretch under the ink,
    /// shrinking and fading, and the notch face comes up in its place.
    private func tuckIn(instant: Bool) {
        guard let notch, !tucked else { return }
        if !instant, !reducedMotion, positioned, panel.isVisible {
            beginTuckSlip()
            return
        }
        endDropSlip()
        endFlight(clearTrail: false)
        sleepTuck?.cancel(); sleepTuck = nil
        settlingAfterWork = false
        tucked = true
        body.teleport(to: notch.dockPointCG)
        notch.show()
        notch.parked = true
        #if JARHEAD_ORB_PREVIEW
        print("notch: tuck in (instant)")
        fflush(stdout)
        #endif
        panel.orderOut(nil)
        setPresentation(scale: 1, alpha: 1)
        blobView.paused = true
        blobView.stepsSim = true
    }

    /// Kevin pulled the face out of the notch: the blob drops into his hand and is free
    /// until it next goes to sleep; the pill offers the way back sooner. The notch panel
    /// is not hidden yet: it took the mouse-down, and the rest of the drag comes through
    /// it (`NotchView.mouseDragged` → `pointerDragged`), so it stays ordered in — clear,
    /// its island shrunk away — until the hand lets go (`hideNotchAfterDrag`).
    private func dragOutOfNotch(at p: CGPoint) {
        // The face grabbed while the body was still slipping in behind it: it is in.
        if slip?.kind == .tuck { finishTuckSlip() }
        guard tucked else { return }
        sleepTuck?.cancel(); sleepTuck = nil
        freeForSession = true
        dropOut(toward: CGPoint(x: p.x, y: p.y + 30))
        notchMode = false
        hideNotchAfterDrag = true
        userMoved = true
        downPoint = p
        dragMoved = true
        body.beginDrag(pointer: p)
        scanObstacles(force: true)
        homePillTimer?.cancel()
        homePill.send(OrbPill(text: "free — back to the notch from Settings › Home", tone: .info, icon: "arrow.up.to.line",
                              action: { [weak self] in self?.returnToNotch() }))
        homePillTimer = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 8_000_000_000)
            guard !Task.isCancelled else { return }
            self?.homePill.send(nil)
        }
        blobView.poke()
    }

    /// The drag out of the notch has let go (`pointerUp`, or the body saw the button
    /// up in `physicsTick`): the notch panel, kept ordered in for the drag's events, goes now.
    private func hideNotchIfOwed() {
        guard hideNotchAfterDrag else { return }
        hideNotchAfterDrag = false
        notch?.hide()
    }

    /// Where a dropped blob counts as "into the dock" (CG, y down): `NotchGeometry.catchZoneCG`
    /// — the same zone a satellite's drop is judged by. Nil on a display without a notch.
    private func dockCatchZoneCG() -> CGRect? {
        guard let g = notch?.geometry ?? NotchGeometry.current() else { return nil }
        return NotchGeometry.catchZoneCG(g)
    }

    /// Kevin dropped the blob into the notch dock: that is putting it to sleep. Awake,
    /// the session closes (the meter stops) and the sleep transition tucks it in; asleep
    /// already, it just goes home. A drag-out that had ended notch mode is undone: the
    /// dock is home again.
    private func dropIntoDock() {
        homePillTimer?.cancel(); homePillTimer = nil
        homePill.send(nil)
        freeForSession = false
        if !notchMode { updateHomeMode(animated: true) }
        if !isDormant {
            state.send(.sleepCause("dock"))
        } else if !tucked {
            goHomeForTransition()
        }
        blobView.poke()
    }

    /// The pill's one click: notch mode again, the blob flies back up.
    private func returnToNotch() {
        homePillTimer?.cancel(); homePillTimer = nil
        homePill.send(nil)
        freeForSession = false
        updateHomeMode(animated: true)
    }

    // MARK: - The slip (into and out of the notch)

    /// The approach has settled at the staging point: the last stretch into the notch.
    /// Over `Motion.tuckSlip` the body rises until its top is `tuckUnderInk` under the
    /// bar, shrinking about that top — position and scale ease-in-out (1 →
    /// `tuckEndScale`), alpha ease-in (1 → 0), no wake behind it — so what shows below
    /// the bar squeezes up under the ink, and at `tuckHandoff` of the way the notch is given the face
    /// (`NotchDock.parked`; the sim's clock goes with it and the field only fades its
    /// last frame from there), so the face coming up in the notch overlaps the body
    /// vanishing under the ink: one hand-off, nothing pops. Interruptible: a drag, a
    /// summon, a fly, a trace, the capsule opening and the mode flipping off cancel it
    /// (`cancelTuckSlip`: whole again at the staging point, or the flight proceeds from
    /// there); a phase change lets it finish, because in notch mode every transition
    /// leads to the notch and the new face shows through it; a Stop shivers it and lets
    /// it finish (`reactToStop`); a hide finishes it at once. Returns false when it cannot
    /// begin — no dock, already tucked, a slip under way — so a caller with a flight to
    /// close (`workDone`) can end it here instead.
    @discardableResult
    private func beginTuckSlip() -> Bool {
        guard let notch, !tucked, slip == nil else { return false }
        endFlight(clearTrail: false)
        sleepTuck?.cancel(); sleepTuck = nil
        settlingAfterWork = false
        let from = body.center
        let dock = notch.dockPointCG
        // The body's top edge ends `tuckUnderInk` under the menu bar's bottom, scaled
        // about that top: it squeezes up under the ink, what shows below the bar
        // shrinking as it goes, and the last of it fades.
        let topEnd = (notchBarBottomCG ?? (dock.y - body.radius * 0.9 - 2)) - Self.tuckUnderInk
        let to = CGPoint(x: dock.x, y: topEnd + body.radius)
        body.place(at: from)
        sim.setContacts([])
        sim.setMotion(lag: .zero, grab: nil, velocity: .zero, dragging: false)
        syncPanelToBody()
        notch.show()
        slip = Slip(kind: .tuck, duration: Motion.seconds(Motion.tuckSlip), from: from, to: to, drivesPosition: true)
        blobView.paused = false
        blobView.poke()
        #if JARHEAD_ORB_PREVIEW
        print(String(format: "notch: slip begins at CG %.0f,%.0f -> %.0f,%.0f over %.0f ms", from.x, from.y, to.x, to.y, Motion.seconds(Motion.tuckSlip) * 1000))
        timeline("slip begins")
        fflush(stdout)
        #endif
        return true
    }

    /// One display frame of a slip (from `physicsTick`). Returns true while one runs.
    private func stepSlip(_ dt: Double) -> Bool {
        guard var s = slip else { return false }
        s.elapsed += dt
        let u = s.progress
        switch s.kind {
        case .tuck:
            let k = Motion.easeInOutCurve.value(at: u)
            let scale = 1 + (Self.tuckEndScale - 1) * k
            let alpha = 1 - Motion.easeInCurve.value(at: u)
            if s.drivesPosition {
                body.place(at: CGPoint(x: s.from.x + (s.to.x - s.from.x) * k, y: s.from.y + (s.to.y - s.from.y) * k))
                syncPanelToBody()
            }
            setPresentation(scale: scale, alpha: alpha, aboutTop: true)
            if !s.handedOff, u >= Self.tuckHandoff {
                s.handedOff = true
                slip = s
                blobView.stepsSim = false
                notch?.parked = true
                #if JARHEAD_ORB_PREVIEW
                timeline("handoff (notch face up)")
                #endif
            }
            slip = s
            #if JARHEAD_ORB_PREVIEW
            timeline("slip")
            #endif
            if u >= 1 { finishTuckSlip() }
        case .drop:
            let k = Motion.easeOutCurve.value(at: u)
            let scale = s.scales ? Self.dropStartScale + (1 - Self.dropStartScale) * k : 1
            if s.drivesPosition, !body.isActive, !body.dragging {
                body.place(at: CGPoint(x: s.from.x + (s.to.x - s.from.x) * k, y: s.from.y + (s.to.y - s.from.y) * k))
                syncPanelToBody()
            }
            setPresentation(scale: scale, alpha: k, aboutTop: true)
            slip = s
            #if JARHEAD_ORB_PREVIEW
            timeline("drop")
            #endif
            if u >= 1 { endDropSlip() }
        }
        return slip != nil
    }

    /// The slip is over (or must be, at once: a hide, the face grabbed in the notch):
    /// tucked — the notch has the face, the orb panel is hidden and whole again for the
    /// next drop, the field's link paused. The panel goes out *before* its alpha and
    /// scale are restored: the two are separate window-server calls, and the other way
    /// round the last slip frame (a 0.55 body under the bar) could composite opaque for
    /// a moment — a pop right where the hand-off must be seamless.
    private func finishTuckSlip() {
        guard let s = slip, s.kind == .tuck else { return }
        slip = nil
        guard let notch else { setPresentation(scale: 1, alpha: 1); blobView.stepsSim = true; return }
        tucked = true
        body.teleport(to: notch.dockPointCG)
        if !s.handedOff { notch.parked = true }
        panel.orderOut(nil)
        setPresentation(scale: 1, alpha: 1)
        blobView.paused = true
        blobView.stepsSim = true
        #if JARHEAD_ORB_PREVIEW
        print("notch: tuck in (slip done)")
        timeline("tucked")
        fflush(stdout)
        #endif
    }

    /// Kevin's hand, a summon, a fly, a trace, the capsule, the mode flipping off, the
    /// displays changing: the body comes back whole at the staging point — where it
    /// was when the slip began, in clear air — and whoever cancelled takes it from there.
    /// Moved first, made whole second: the frame and the alpha reach the window server
    /// separately, and a body made opaque before it is moved back could composite once
    /// as a small solid body up under the bar.
    private func cancelTuckSlip() {
        guard let s = slip, s.kind == .tuck else { return }
        slip = nil
        blobView.stepsSim = true
        if s.handedOff { notch?.parked = false }
        body.teleport(to: s.from)
        sim.setContacts(body.contacts())
        syncPanelToBody()
        setPresentation(scale: 1, alpha: 1)
        blobView.paused = false
        blobView.poke()
        #if JARHEAD_ORB_PREVIEW
        print(String(format: "notch: slip cancelled at %.0f%%, body whole at CG %.0f,%.0f", s.progress * 100, s.from.x, s.from.y))
        fflush(stdout)
        #endif
    }

    /// The drop has grown in (or must end now): whole. If nothing has the body — the
    /// mode flipped off, nothing else followed — a soft last drop lets the physics
    /// settle it onto the work area, and where it rests is the perch (`settle`; off
    /// when the caller is about to take the body itself: a hide, the capsule opening).
    private func endDropSlip(settle: Bool = true) {
        guard let s = slip, s.kind == .drop else { return }
        slip = nil
        setPresentation(scale: 1, alpha: 1)
        if settle, s.drivesPosition, flight == .none, !body.isActive, !body.dragging, !expanded, takeoff == nil {
            body.fling(CGVector(dx: 0, dy: 120))
            blobView.poke()
        }
        #if JARHEAD_ORB_PREVIEW
        timeline("drop done")
        #endif
    }

    /// How the orb is drawn this frame: the window's alpha, and the blob cell scaled
    /// through the container layer's `sublayerTransform` (which AppKit leaves alone,
    /// unlike a layer-backed view's own geometry) — about the body's top (`aboutTop`:
    /// the slip, so the body squeezes up under the ink and grows back down out of it)
    /// or its centre. Scale 1 is the identity.
    private func setPresentation(scale: Double, alpha: Double, aboutTop: Bool = false) {
        panel.alphaValue = min(1, max(0, alpha))
        presentationScale = scale
        guard let layer = container.layer else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if abs(scale - 1) < 0.0005 {
            layer.sublayerTransform = CATransform3DIdentity
        } else {
            // The transform applies about the layer's anchor: translate so the chosen
            // point stays put whatever the anchor is. The container is y-up: the body's
            // top is a radius above the cell's centre.
            let a = layer.anchorPoint, b = layer.bounds
            let ax = a.x * b.width, ay = a.y * b.height
            let cx = blobCell.frame.midX
            let cy = blobCell.frame.midY + (aboutTop ? body.radius : 0)
            var t = CATransform3DMakeTranslation((1 - scale) * (cx - ax), (1 - scale) * (cy - ay), 0)
            t = CATransform3DScale(t, scale, scale, 1)
            layer.sublayerTransform = t
        }
        CATransaction.commit()
    }

    /// The menu bar's bottom edge on the notch's display, CG (y down): the ink's lower
    /// edge, where the slip takes the body. Nil without a notch.
    private var notchBarBottomCG: CGFloat? {
        guard let g = NotchGeometry.current() else { return nil }
        return CGSpace.mainMaxY - g.menuBarBottom
    }

    #if JARHEAD_ORB_PREVIEW
    /// ORB_TIMELINE=1: one line per display frame through the approach to the notch,
    /// the slip and the drop — time since the approach (or drop) began, the body's
    /// centre and speed, the drawn scale and alpha, the face — so the deceleration and
    /// the slip are provable from the log.
    public var previewTimeline = false
    var timelineStart = -1.0
    var timelinePeak = 0.0
    private func timeline(_ stage: String) {
        guard previewTimeline else { return }
        let now = CACurrentMediaTime()
        if timelineStart < 0 { timelineStart = now }
        let speed = body.speed
        timelinePeak = max(timelinePeak, speed)
        let c = body.center
        let name = stage.padding(toLength: 26, withPad: " ", startingAt: 0)
        print(String(format: "timeline %@ t %.3f centre %.1f,%.1f speed %.0f scale %.2f alpha %.2f face [%@]%@", name, now - timelineStart,
                     c.x, c.y, speed, presentationScale, panel.alphaValue, previewFace,
                     slip.map { String(format: " %@ %.0f%%", $0.kind == .tuck ? "slip" : "drop", $0.progress * 100) } ?? ""))
    }
    #endif

    // MARK: - The awake↔asleep transitions (the only way back to the dock)

    /// The dormant side of the transitions: no session, the meter stopped. `error` is
    /// where a failed wake or a dead session leaves the engine (the transport shows Go
    /// there too), so it counts as asleep for the way home — a blob left out when a
    /// session failed to open comes back up on the next Go, and a session dying mid-job
    /// puts it to bed. Paused is not dormant: it holds the conversation.
    static let dormantPhases: Set<Phase> = [.asleep, .error]
    private var isDormant: Bool { Self.dormantPhases.contains(sim.phase) }

    /// Phase → asleep or error (a Stop, a sleep, the idle timer, a session that failed).
    /// Whatever it was doing on screen ends with the Stop's body language — unless it is
    /// already drifting home, which is where a sleep leads anyway — and, in notch mode,
    /// it drifts up into the notch once the shiver has passed (`tuckInForSleep`). Kevin's
    /// drag-out freedom ends here: going to sleep always tucks it in; the pill's way back
    /// comes down. Notch mode itself comes back on where the way home is next tried
    /// (`goHomeForTransition`), so a tuck put off by the capsule, a drag or a summon
    /// still finds the mode right.
    private func fellAsleep() {
        if flight != .none, flight != .homing { reactToStop() }
        pendingFly = nil
        pendingTrace = nil
        if freeForSession {
            freeForSession = false
            homePillTimer?.cancel(); homePillTimer = nil
            homePill.send(nil)
        }
        scheduleSleepTuck()
    }

    /// Phase asleep → awake (connecting, listening). In notch mode a blob left out — on
    /// a worked spot, by a summon while asleep, by a drag that cut the way home short —
    /// drifts back up and tucks in, so it is the notch that peeks awake. One Kevin
    /// dragged out stays his (`freeForSession`); free mode never moves.
    private func wokeUp() {
        sleepTuck?.cancel(); sleepTuck = nil
        goHomeForTransition()
    }

    private func scheduleSleepTuck() {
        sleepTuck?.cancel()
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.tuckInForSleep() }
        }
        sleepTuck = work
        DispatchQueue.main.asyncAfter(deadline: .now() + (reducedMotion ? 0.1 : Self.sleepTuckDelay), execute: work)
    }

    /// The beat after falling asleep: still dormant, not in Kevin's hand, the capsule
    /// closed — the way up. A capsule open at this moment sends it home when it closes
    /// instead (`collapse`); a drag or a summon that cancelled this beat leaves the way
    /// home to the next wake.
    private func tuckInForSleep() {
        sleepTuck = nil
        guard isDormant, !body.dragging, !expanded else { return }
        goHomeForTransition()
    }

    /// The transitions' way home: in notch mode an idle blob out of the notch drifts up
    /// and tucks in (`driftHome` → the settle → `tuckIn`). Not over Kevin's hand, not
    /// through a flight already under way (a fly that arrived with the wake goes on; a
    /// drift already homing arrives), never in free mode.
    ///
    /// The mode is re-read first, here and not only in the sleep beat: `fellAsleep` ended
    /// the drag-out freedom, and whichever of the tries actually runs — the beat after
    /// sleeping, a wake, the capsule closing on a dormant blob — must see notch mode back
    /// on, or a blob whose tuck was put off (the capsule open, a drag, a summon, a hide)
    /// would stay "free" with no pill and miss the wake return until the next sleep.
    /// Coming on, `updateHomeMode` itself starts the quiet drift, and the guard below
    /// sees it homing.
    private func goHomeForTransition() {
        updateHomeMode(animated: true, quiet: true)
        // A slip already under way is the way home: the new phase shows through the
        // notch face as it comes up; nothing is restarted.
        guard notchMode, !tucked, slip == nil, flight == .none, !body.dragging, !expanded else { return }
        settlingAfterWork = false
        driftHome(quiet: true)
    }

    // MARK: - Transport (Go / Pause / Stop)

    // The one transport, as the capsule, the notch island and the menu press it: Go
    // (wake when asleep, resume when paused), Pause (the session closes — the meter
    // stops), Stop. The decisions are AppState's (`transportToggle`, `transportStop`,
    // `transportLabel`), the same for every site in the app; nothing is decided here.

    /// The capsule's and the island's Go/Pause.
    private func togglePause() { state.transportToggle() }

    /// The Go/Pause menu item's one word for the phase (`AppState.transportPress`).
    /// While connecting a press would be a Stop, and the menu has its own Stop item
    /// right under, so the item reads "Connecting" and is disabled (`showMenu`) rather
    /// than showing Stop twice.
    private var transportMenuTitle: String {
        switch AppState.transportPress(for: state.phase) {
        case .go: return "Go"
        case .pause: return "Pause"
        case .stop: return "Connecting"
        }
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
        sim.setMotion(lag: .zero, grab: nil, velocity: .zero, dragging: false)
        sim.leanX = body.leanX
        sim.leanY = body.leanY
        syncPanelToBody()
        switch flight {
        case .outbound:
            if trace != nil {
                // Parked with the pen's point on the first point: draw.
                startTracing()
                return
            }
            // Parked beside the target. The dwell is time spent parked here — it
            // counts from now, not from the arrival splat, so the landing wobble
            // never eats it. Nothing is persisted.
            flight = .hovering
            sim.flightMoving = false
            hoverUntil = max(hoverUntil, CACurrentMediaTime() + flightDwell)
            scheduleHoverEnd()
        case .homing:
            // Home again: up into the notch in notch mode (a sleep, a wake, the explicit
            // `orb.home`); on the perch Kevin chose in free mode (`orb.home` only) — and
            // the saved spot is that again.
            endFlight(clearTrail: false)
            if notchMode { tuckIn(instant: false) } else { persistPosition(asPerch: true) }
        case .hovering, .tracing:
            break
        case .none:
            if settlingAfterWork {
                // The dome a finished flight sagged into: where it worked is saved, the perch is not moved.
                settlingAfterWork = false
                persistPosition(asPerch: false)
            } else {
                persistPosition(asPerch: true)
            }
            // Kevin's throw has landed and is the perch; now the fly (or trace) that waited for it.
            if let p = pendingFly {
                pendingFly = nil
                if CACurrentMediaTime() < p.expires { fly(to: p.target, dwellMs: p.dwellMs, reason: p.reason) }
            } else if let p = pendingTrace {
                pendingTrace = nil
                if CACurrentMediaTime() < p.expires, case .orbTrace(let points, let closed, let label, let ttlMs, let tone, let reason, _) = p.cmd {
                    trace(points: points.map { CGPoint(x: $0.x, y: $0.y) }, closed: closed, label: label, ttlMs: ttlMs, tone: tone, reason: reason)
                }
            }
        }
    }

    /// Save where the body rests as `orbPosition`, so a relaunch puts it back there. A
    /// spot Kevin chose (a drop, a fling, a summon, a rescue) is also the perch — where
    /// the explicit `orb.home` returns to in free mode; a spot a flight ended on
    /// (`stayHere`), a hide, a capsule closing save the spot but leave the perch alone.
    /// The spot is taken now: a flight that leaves within the debounce (one that was
    /// waiting for this very landing) must not stop the save, nor be saved itself. Never
    /// while tucked: in notch mode the notch is home, and the saved spot is where the
    /// blob last sat out of it — where a relaunch without a notch (the lid closed) puts it.
    private func persistPosition(asPerch: Bool = true) {
        guard !expanded, flight == .none, !tucked, slip == nil else { return }
        if asPerch { perch = body.center }
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
        guard !body.dragging, panel.isVisible || tucked else { return }
        if expanded { collapse() }
        if !positioned { placeInitially() }
        // Another job's fly ends a mark echo's way home — the line it overtakes, or the
        // hover it retargets under Reduce Motion — so its own hover ends where it worked.
        pinAcrossTrace(markHome.flyBegins(reason: reason))
        // A plain fly overtakes a trace: the half-drawn line comes down, the pen morphs back.
        if trace != nil { cancelTrace() }
        pendingTrace = nil
        // Half-way into the notch: whole again where it was, and the flight proceeds from there.
        cancelTuckSlip()
        if tucked { dropOut() }
        let now = CACurrentMediaTime()
        let dwell = max(0.2, (dwellMs ?? 2000) / 1000)
        // Just out of the notch, the body is hopping down: not Kevin's throw, no waiting.
        let dropping = now - droppedAt < Self.dropWindup + 0.05
        if flight == .none, body.isActive, !dropping {
            pendingFly = PendingFly(target: target, dwellMs: dwellMs, reason: reason, expires: now + dwell + 1.0)
            return
        }
        pendingFly = nil
        if perch == nil, !notchMode { perch = body.center }
        settlingAfterWork = false
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
        bringPanelForward()
        if body.isActive, !dropping { takeOff() } else { scheduleTakeoff(after: dropping ? Self.dropWindup : nil) }
        blobView.poke()
    }

    /// The wind-up before the launch; out of the notch, long enough for the hop down to
    /// show. The last `Motion.anticipation` of it is the crouch (`BlobSim.anticipate`):
    /// a squash toward the target, released by the launch. None under Reduce Motion.
    private func scheduleTakeoff(after: Double? = nil) {
        takeoff?.cancel()
        anticipation?.cancel(); anticipation = nil
        let delay = after ?? (sim.reducedMotion ? 0 : Self.windup)
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.takeOff() }
        }
        takeoff = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
        if !sim.reducedMotion, delay >= Motion.anticipation {
            let crouch = DispatchWorkItem { [weak self] in
                MainActor.assumeIsolated {
                    guard let self, self.flight == .outbound, let target = self.flightTarget else { return }
                    self.anticipation = nil
                    self.sim.anticipate(toward: CGVector(dx: target.x - self.body.center.x, dy: target.y - self.body.center.y))
                    self.blobView.poke()
                }
            }
            anticipation = crouch
            DispatchQueue.main.asyncAfter(deadline: .now() + delay - Motion.anticipation, execute: crouch)
        }
    }

    /// Launch (or retarget) the body toward the spot beside the target. Across
    /// displays the body hops first and picks the spot from where it lands.
    private func takeOff() {
        takeoff = nil
        anticipation?.cancel(); anticipation = nil
        guard flight == .outbound, !body.dragging, let target = flightTarget else { return }
        // Launched out of the notch while the drop was still hopping: the spring owns
        // the position from here; the drop's growing-in finishes on its own.
        slip?.drivesPosition = false
        sim.flightMoving = true
        #if JARHEAD_ORB_PREVIEW
        let from = body.center
        #endif
        let spot: CGPoint
        if let trace {
            // A trace lands with the pen's point on the first point, not beside it:
            // the body parks a tip's length behind it, back along the way it came,
            // and the pen forms on the wing pointing the way it flies.
            var dir = CGVector(dx: trace.points[0].x - body.center.x, dy: trace.points[0].y - body.center.y)
            let len = hypot(dir.dx, dir.dy)
            dir = len > 1 ? CGVector(dx: dir.dx / len, dy: dir.dy / len) : trace.direction(at: 0)
            sim.cursor = dir
            let tip = sim.cursorTipTarget(direction: dir, squash: sim.flightSquash)
            spot = CGPoint(x: trace.points[0].x - tip.dx, y: trace.points[0].y - tip.dy)
            body.fly(to: spot, spring: .flight)
        } else {
            spot = body.flyBeside(target, spring: .flight)
        }
        #if JARHEAD_ORB_PREVIEW
        print(String(format: "takeoff: from CG %.0f,%.0f (after any hop %.0f,%.0f) -> landing CG %.0f,%.0f %@ %.0f,%.0f",
                     from.x, from.y, body.center.x, body.center.y, spot.x, spot.y, trace == nil ? "beside" : "pen on", target.x, target.y))
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
                if remaining <= 0 { self.workDone(); return }
                try? await Task.sleep(nanoseconds: UInt64(max(0.01, remaining) * 1_000_000_000))
            }
        }
    }

    /// The work is over — the hover ran out, the line is sealed, a Stop, the brain's
    /// clear, the capsule closing on a parked flight. The blob stays where it worked
    /// (`stayHere`), in free mode and in notch mode alike: the dock is for waking up
    /// and going to sleep (`fellAsleep`, `wokeUp`), not for the end of every job.
    private func workDone() {
        // A mark's own echo goes home; when the slip cannot run (already tucked or
        // slipping, no dock) the flight still ends here, never half torn down.
        if markHome.workDone(notchMode: notchMode) == .tuck, beginTuckSlip() { return }
        stayHere()
    }

    /// The dock does with the pin it folded for a mark what the blob-home rule's
    /// transition said (`MarkHomeRule.Pin`).
    private func pinAcrossTrace(_ pin: MarkHomeRule.Pin) {
        switch pin {
        case .keep: notch?.keepPinAcrossTrace()
        case .drop: notch?.dropPinAcrossTrace()
        case .leave: break
        }
    }

    /// Stay where you worked: the flight ends here. The body parks — still, and stuck
    /// to any edge its surface is touching (it sags into the dome over the next few
    /// frames) — and the spot is saved as a drop would be, once it is settled. The
    /// perch (where `orb.home` goes in free mode) is not moved: that stays the spot
    /// Kevin last chose by hand. A fly or trace that arrives while the dome still
    /// sags waits for the settle (`pendingFly` / `pendingTrace`, via `bodyDidSettle`).
    private func stayHere() {
        hoverTimer?.cancel(); hoverTimer = nil
        takeoff?.cancel(); takeoff = nil
        anticipation?.cancel(); anticipation = nil
        if body.hasGoal || body.guided || body.isActive { body.teleport(to: body.center) }
        endFlight(clearTrail: true)
        body.park()
        // A soft settle: a small sigh through the body as the flight colour fades to the phase's.
        sim.settleHere()
        sim.setContacts(body.contacts())
        sim.leanX = body.leanX
        sim.leanY = body.leanY
        syncPanelToBody()
        if body.isActive {
            settlingAfterWork = true
        } else {
            persistPosition(asPerch: false)
        }
        blobView.poke()
        #if JARHEAD_ORB_PREVIEW
        print(String(format: "stay: parked at CG %.0f,%.0f stuck %d (perch %@)", body.center.x, body.center.y, body.stuckCount,
                     perch.map { "\(Int($0.x)),\(Int($0.y))" } ?? "nil"))
        fflush(stdout)
        #endif
    }

    /// Back home: at once on the explicit `orb.home` — the one command that is sent on
    /// purpose (nothing in the engine emits it on its own). Home is the perch — where
    /// Kevin last put it by hand — in free mode, the notch in notch mode. A trace under
    /// way is cancelled — its half-drawn line comes down. Never over Kevin's hand: not
    /// while he drags, and not while his throw still glides (its landing is his perch
    /// and must be saved as such). Outside a flight only an idle body off its home drifts back.
    private func flyHome() {
        pendingTrace = nil
        guard !body.dragging else { return }
        // Already slipping into the notch: that is home.
        if slip?.kind == .tuck { return }
        // Home at once is where a mark echo was heading anyway: its rule is over, and the
        // pin folded for the mark comes back with the blob at the tuck as it would have.
        markHome.homeBound()
        if trace != nil { cancelTrace() }
        if flight == .none {
            guard !body.isActive, let home = homePoint, hypot(body.center.x - home.x, body.center.y - home.y) > 2 else { return }
        }
        driftHome()
    }

    /// Start the way home from wherever the body is — the explicit `orb.home`, the
    /// sleep and wake transitions, notch mode coming on. A gentle spring, no splat: the
    /// blob drifting home, not racing. In notch mode the way home is approach + slip:
    /// the approach (`GoalSpring.tuck`, `Motion.approach`) is an ease-out to a staging
    /// point `tuckStaging` pt under the dock — on whichever display has the notch; from
    /// another display the body hops first (`BlobBody.hop`) unless the seam is crossable
    /// — decelerating to rest in clear air, critically damped (no swing back, no splat)
    /// and capped under the speed at which the face startles into `O O`, so the sleepy
    /// `- -` survives the whole way to bed; the settle there begins the slip
    /// (`bodyDidSettle` → `tuckIn` → `beginTuckSlip`), which carries the body the last
    /// stretch under the ink. `quiet` is the transitions' drift: in the phase's own
    /// colour and face (a sleepy `- -` on its way to bed, not the acting green of a
    /// job) and with no wake of ghosts behind it; `orb.home` and the mode flip keep
    /// the flight's look.
    private func driftHome(quiet: Bool = false) {
        hoverTimer?.cancel(); hoverTimer = nil
        takeoff?.cancel(); takeoff = nil
        anticipation?.cancel(); anticipation = nil
        sleepTuck?.cancel(); sleepTuck = nil
        settlingAfterWork = false
        guard let home = homePoint else { endFlight(clearTrail: false); return }
        if tucked || slip?.kind == .tuck { return }
        flight = .homing
        sim.flight = !quiet
        sim.flightMoving = !quiet
        blobView.paused = false
        bringPanelForward()
        if notchMode {
            body.drift(to: CGPoint(x: home.x, y: home.y + Self.tuckStaging), spring: .tuck)
            #if JARHEAD_ORB_PREVIEW
            timelineStart = CACurrentMediaTime()
            timelinePeak = 0
            timeline("approach begins")
            #endif
        } else {
            body.drift(to: home, spring: .drift)
        }
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
        sim.traceColor = nil
        sim.cursor = nil
        if clearTrail { trail.clear() }
        blobView.poke()
    }

    /// Cut a flight short. Nothing of it outlives this: the launch is called off, a
    /// trace comes down, and the body is stopped where it is (a goal spring left armed
    /// would fly on and settle — and a settle outside a flight is persisted as the
    /// perch; a led body would keep the link running).
    private func cancelFlight() {
        takeoff?.cancel(); takeoff = nil
        // Whatever cut the flight short — Kevin's hand, the capsule, a hide, a display
        // going away — ends a mark echo's way home with it: the blob stays out where he
        // left it, so the dock forgets the pin it folded for the mark rather than popping
        // the island open pinned at the next tuck with nobody near. (A Stop disarmed the
        // rule already, pin kept: its sleep tucks the blob.)
        pinAcrossTrace(markHome.interrupted())
        // Taken before the trace comes down: a drawing pen leaves `flight` at none,
        // and the teardown (the wake, the target, the hover) is owed all the same.
        let wasFlying = flight != .none
        if trace != nil { cancelTrace() }
        guard wasFlying else { return }
        if body.hasGoal || body.guided { body.teleport(to: body.center) }
        endFlight(clearTrail: true)
    }

    /// One dotted ghost of the blob where it is now, every `BlobTrail.spacing` while a
    /// flight is actually moving — not while it draws: the line is that wake, and not
    /// during the wind-up before the launch (`takeoff` pending): out of the notch the
    /// body is hopping down then, fast enough to count, and a ghost stamped on it where
    /// it emerges smeared the hop into a doubled body. Never under reduce motion, and
    /// never on the transitions' quiet drift home (`sim.flight` off: no flight look, no
    /// wake). Always in the flight colour: the first ghost drops while the field is
    /// still easing from the phase colour, and a purple ghost behind a green blob reads
    /// as two creatures.
    private func dropGhostIfDue() {
        guard flight != .none, flight != .tracing, sim.flight, takeoff == nil, !sim.reducedMotion, body.speed > 240 else { return }
        let now = CACurrentMediaTime()
        guard now - trail.lastDropAt >= BlobTrail.spacing else { return }
        guard let image = BlobGhostImage.render(cells: sim.cells, ramp: sim.ramp, color: sim.traceColor ?? OrbPalette.acting,
                                                size: Self.collapsedSize, scale: panel.backingScaleFactor) else { return }
        trail.drop(image: image, frame: panel.frame, below: panel, at: now)
    }

    // MARK: - Traces (orb.trace)

    /// Draw a stroke by hand: fly to its first point as the pen, then lead the pen
    /// along it. Refused while Kevin is dragging; an open capsule folds first; with
    /// the orb hidden, or under reduce motion, the line appears whole (one sealed
    /// publish) and the blob only flies to it (or not at all). While Kevin's own throw
    /// still glides the trace waits for it to land, as a fly does. A trace already
    /// under way comes down first.
    private func trace(points raw: [CGPoint], closed: Bool, label: String?, ttlMs: Double?, tone: OverlayTone, reason: String?) {
        var pts: [CGPoint] = []
        pts.reserveCapacity(raw.count + 1)
        for p in raw where pts.last.map({ hypot($0.x - p.x, $0.y - p.y) > 0.5 }) ?? true { pts.append(p) }
        if closed, let first = pts.first, let last = pts.last, hypot(first.x - last.x, first.y - last.y) > 0.5 { pts.append(first) }
        guard pts.count >= 2 else { return }
        let path = TracePath(id: "trace-" + UUID().uuidString, points: pts, tone: tone, label: label, ttlMs: ttlMs ?? Self.traceDefaultTTL, reason: reason)

        guard !body.dragging else { return }
        if trace != nil { cancelTrace() }
        pendingTrace = nil
        // A mark's own echo (reason "mark") started from the dock: the blob outlines it
        // (or, under Reduce Motion, only flies to it) and comes back to the notch instead
        // of loitering by the line; Kevin's pin, if the island had one, comes back with
        // it. Every other trace stays where it worked.
        pinAcrossTrace(markHome.traceBegins(tucked: tucked, reason: reason))
        let shown = panel.isVisible || tucked
        if !shown || sim.reducedMotion {
            // The line, whole; the blob flies to it if it is on screen.
            state.liveStrokes.send(path.stroke(upTo: pts.count - 1, pen: nil, done: true, ttlMs: path.ttlMs))
            if shown { fly(to: pts[0], dwellMs: 1500, reason: reason) }
            return
        }
        if expanded { collapse() }
        if !positioned { placeInitially() }
        cancelTuckSlip()
        if tucked { dropOut() }
        let now = CACurrentMediaTime()
        let dropping = now - droppedAt < Self.dropWindup + 0.05
        if flight == .none, body.isActive, !dropping {
            pendingTrace = (.orbTrace(points: pts.map { Point2(x: $0.x, y: $0.y) }, closed: false, label: label, ttlMs: ttlMs, tone: tone, reason: reason, thread: nil), now + 3.0)
            return
        }
        pendingFly = nil
        if perch == nil, !notchMode { perch = body.center }
        settlingAfterWork = false
        hoverTimer?.cancel(); hoverTimer = nil
        hoverUntil = 0
        trace = path
        flightTarget = pts[0]
        flight = .outbound
        sim.flight = true
        sim.traceColor = OrbPalette.tone(tone)
        // Which side of the line the body rides: the outside of the stroke's turn.
        sim.cursorHand = path.hand
        blobView.paused = false
        bringPanelForward()
        if body.isActive, !dropping { takeOff() } else { scheduleTakeoff(after: dropping ? Self.dropWindup : nil) }
        blobView.poke()
    }

    /// Parked with the pen on the first point: the line begins. From here the physics
    /// tick leads the body (`advanceTrace`).
    private func startTracing() {
        guard var path = trace else { return }
        flight = .tracing
        sim.flightMoving = true
        sim.cursor = path.direction(at: 0)
        path.s = 0
        path.startedAt = CACurrentMediaTime()
        trace = path
        let pen = path.points[0]
        body.lead(to: CGPoint(x: pen.x - sim.cursorTip.dx, y: pen.y - sim.cursorTip.dy), velocity: .zero)
        state.liveStrokes.send(path.stroke(upTo: 0, pen: pen, done: false, ttlMs: path.ttlMs))
        lastTracePublishAt = path.startedAt
        lastTracePublishSegment = 0
        lastTracePublishPen = pen
        blobView.poke()
    }

    /// One physics tick of drawing: the pen moves `speed × dt` along the stroke, the
    /// body is placed so its point sits on the pen (the tip the field last laid out,
    /// so a turn swings the body round the pen) every tick, and the line so far is
    /// published when it has grown by a vertex, when it is whole, and otherwise at
    /// most every `tracePublishInterval` once the pen has moved `tracePublishMinMove`.
    private func advanceTrace(_ dt: Double) {
        guard var path = trace, flight == .tracing, path.s < path.length else { return }
        path.s = min(path.length, path.s + path.speed(at: path.s) * dt)
        let (pen, dir, segment) = path.sample(at: path.s)
        sim.cursor = dir
        let tip = sim.cursorTip
        let centre = CGPoint(x: pen.x - tip.dx, y: pen.y - tip.dy)
        let v = dt > 0 ? CGVector(dx: (centre.x - body.center.x) / dt, dy: (centre.y - body.center.y) / dt) : .zero
        body.lead(to: centre, velocity: v)
        let finished = path.s >= path.length
        let now = CACurrentMediaTime()
        let moved = hypot(pen.x - lastTracePublishPen.x, pen.y - lastTracePublishPen.y)
        if finished || segment != lastTracePublishSegment
            || (now - lastTracePublishAt >= Self.tracePublishInterval && moved > Self.tracePublishMinMove) {
            state.liveStrokes.send(path.stroke(upTo: finished ? path.points.count - 1 : segment, pen: finished ? nil : pen, done: finished, ttlMs: path.ttlMs))
            lastTracePublishAt = now
            lastTracePublishSegment = segment
            lastTracePublishPen = pen
        }
        trace = path
        if finished { finishTrace() }
    }

    /// The line is sealed. The pen holds on it a beat, then morphs back and stays by
    /// its line (free mode) or flies back up into the notch.
    private func finishTrace() {
        traceHold?.cancel()
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.flight == .tracing else { return }
                self.traceHold = nil
                self.trace = nil
                self.sim.cursor = nil
                self.sim.traceColor = nil
                self.workDone()
            }
        }
        traceHold = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.traceHoldSeconds, execute: work)
    }

    /// Take a trace down: the half-drawn line is removed from the overlay, the pen
    /// morphs back. A trace still on its way out leaves the flight running (the caller
    /// decides where it goes); one that was drawing is stopped where it is.
    private func cancelTrace() {
        traceHold?.cancel(); traceHold = nil
        guard let path = trace else { return }
        trace = nil
        state.liveStrokes.send(LiveStroke(id: path.id, points: [], tone: path.tone, label: nil, done: true, ttlMs: 0))
        sim.cursor = nil
        sim.traceColor = nil
        if flight == .tracing {
            body.teleport(to: body.center)
            flight = .none
            sim.flight = false
            sim.flightMoving = false
        }
        blobView.poke()
    }

    /// The overlay's `clear`: the brain's show_clear ("remove every shape you drew"),
    /// or a Stop taking the shapes down. A line being drawn goes with them, quietly —
    /// the pen morphs back and stays (or returns to the notch) — and a trace still
    /// waiting for Kevin's throw to land is dropped. Nothing else changes: a plain fly
    /// is not the brain's drawing, and the Stop's body language belongs to the Stop
    /// (`reactToStop`).
    private func drawingsCleared() {
        pendingTrace = nil
        guard trace != nil else { return }
        // Out to the first point, or drawing: either way the body is out on the
        // trace's account. (A trace pending behind a plain fly is not; it is dropped above.)
        let onTheTrace = flight == .outbound || flight == .tracing
        cancelTrace()
        if onTheTrace, !expanded { workDone() }
    }

    // MARK: - Stop

    /// Stop, from the capsule or the menu: `AppState.transportStop` — the command, and
    /// the in-process signals nothing waits on: `stopPressedNotification` (which brings
    /// `reactToStop` here), the overlay's `clear` (the shapes come down) and the one
    /// "Stopped" toast that is the pill under the blob and the Console's. This site adds
    /// only the capsule's red flash for the press.
    private func stopPressed() {
        capsuleModel.stopFlash += 1
        state.transportStop()
    }

    /// The blob's own answer to a Stop, at once: whatever it was doing on screen ends
    /// — the flight or trace is cancelled, its wake and half-drawn line with it — it
    /// shivers with wide eyes that settle back to its normal face, and stays where it
    /// is. Tucked, it only shivers in the notch: nothing pops it out. Already drifting
    /// up to the notch it shivers and keeps going: the notch is where a Stop leads. The
    /// tuck itself is the phase's (`fellAsleep`), a moment behind. Nothing about a Stop
    /// is latched here: the next fly, wake or pause lands as if the Stop never happened.
    private func reactToStop() {
        pendingFly = nil
        pendingTrace = nil
        // A mark echo's way home is over, and the Stop's sleep tucks the blob: the pin
        // folded for the mark comes back with it there, as it would have.
        markHome.homeBound()
        pendingPoke?.cancel(); pendingPoke = nil
        if !tucked { blobView.paused = false }
        sim.nudge(1.6)
        sim.poke()
        if (flight == .homing || slip?.kind == .tuck), notchMode {
            blobView.poke()
            notch?.view.wake()
            return
        }
        let wasOut = flight != .none
        cancelFlight()
        if wasOut, !expanded { workDone() }
        blobView.poke()
        notch?.view.wake()
    }

    // MARK: - Physics loop

    /// One display frame while the body moves (or slips). Returns true while it still does.
    private func physicsTick(_ dt: Double) -> Bool {
        guard !frozen else { return slip != nil }
        let slipping = stepSlip(dt)
        guard !expanded, !tucked, body.isActive || body.dragging else { return slipping }
        if flight == .tracing { advanceTrace(dt) }
        let contacts = body.step(dt)
        // The drag out of the notch may end here rather than in `pointerUp`: the body
        // sees the button up on its own (`BlobBody.step`) when the mouse-up never
        // reaches the notch view.
        if hideNotchAfterDrag, !body.dragging { hideNotchIfOwed() }
        sim.setContacts(contacts)
        sim.setMotion(lag: body.lag, grab: body.grab, velocity: body.velocity, dragging: body.dragging)
        // The acting eyes track the work on a flight; otherwise the direction of
        // motion. Drawing, the pen's own look (along the line) rules.
        if flight != .none, flight != .tracing, let target = flightTarget {
            sim.attention = CGVector(dx: target.x - body.center.x, dy: target.y - body.center.y)
        } else {
            sim.attention = nil
        }
        sim.leanX = body.leanX
        sim.leanY = body.leanY
        syncPanelToBody()
        // Nothing to bounce off while led along a line.
        if body.isActive || body.dragging, flight != .tracing { scanObstacles(force: false) }
        if body.isActive { dropGhostIfDue() }
        #if JARHEAD_ORB_PREVIEW
        if flight == .homing, notchMode { timeline("approach") }
        #endif
        return body.isActive || body.dragging || slip != nil
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

    /// The windows found, the harness's slabs, and the satellites' bodies (a satellite
    /// Kevin drags the main blob into is something to squish against).
    private func applyObstacles(_ found: [Obstacle]) {
        body.obstacles = found + extraObstacles + (fleet?.obstacles(excluding: nil) ?? [])
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
        // A collapse still fading out is finished first, so a quick re-open opens.
        if collapseWork != nil { finishCollapse() }
        guard !expanded else { return }
        // Half-way into the notch: whole again where it was, and the capsule opens there.
        cancelTuckSlip()
        endDropSlip(settle: false)
        expanded = true
        // Whatever it was doing, it holds still while the capsule is open. A flight is
        // parked, not forgotten: Kevin double-clicking the blob beside the work to ask
        // about it must not make that spot his perch — the capsule closing leaves the
        // blob there as a worked spot (`stayHere`).
        let wasFlying = flight != .none
        cancelFlight()
        pendingFly = nil
        stayAfterCollapse = wasFlying
        body.teleport(to: body.center)
        sim.setContacts(body.contacts())
        syncPanelToBody()

        let f = panel.frame
        // The capsule grows on the display the blob is on — any of them — and is
        // clamped to that display's work area, never the main display's.
        let centre = NSPoint(x: f.midX, y: f.midY)
        let screen = NSScreen.screens.first { NSMouseInRect(centre, $0.frame, false) } ?? panel.screen ?? NSScreen.main
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
        // The capsule pops open from the blob's side (`OrbCapsuleView`: the frame on
        // `Motion.bouncy`, the rows staggering in) the moment `shown` flips; the host
        // itself is simply there.
        capsuleModel.blobOnRight = characterOnRight
        capsuleHost.alphaValue = 1
        capsuleHost.isHidden = false
        capsuleModel.shown = true
        // No makeKey(): the capsule's buttons work on a non-key panel, and the
        // frontmost app keeps Kevin's keystrokes. Only a click into the passphrase
        // field changes that (OrbPanel.sendEvent), and only until it lets go.
        installDismissMonitors()
        blobView.poke()
    }

    /// A collapse whose content is still fading out (`collapse(animated:)`); the frame shrinks when it fires.
    private var collapseWork: DispatchWorkItem?

    /// Fold the capsule. Animated — a toggle, a click outside, a click on the blob —
    /// the content fades and draws in toward the blob first (`OrbCapsuleView` on
    /// `shown`, `Motion.quick`), then the frame shrinks; nothing else changes until
    /// then, so the blob holds still under the fade. Not animated — a summon, a fly, a
    /// drag, a hide, the displays changing: the body is about to be taken — at once.
    private func collapse(animated: Bool = false) {
        guard expanded else { return }
        if animated, !reducedMotion, collapseWork == nil {
            capsuleModel.shown = false
            // A second click outside must not fold the fold.
            removeDismissMonitors()
            releaseKey()
            let work = DispatchWorkItem { [weak self] in
                MainActor.assumeIsolated { self?.finishCollapse() }
            }
            collapseWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + Motion.seconds(Motion.quick) + 0.02, execute: work)
            return
        }
        finishCollapse()
    }

    private func finishCollapse() {
        collapseWork?.cancel(); collapseWork = nil
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
        if stayAfterCollapse {
            // Opened beside the work mid-flight: the work is over — it stays there,
            // saved as a worked spot, never Kevin's perch.
            stayAfterCollapse = false
            stayHere()
        } else {
            // The capsule never moved the blob: the spot is saved again, the perch is
            // left where Kevin's hand put it.
            persistPosition(asPerch: false)
        }
        // Closed on a dormant blob left out (a Stop pressed in the capsule itself; a
        // session that failed while it was open): the sleep tuck it kept waiting.
        if isDormant { goHomeForTransition() }
    }

    private func layout(expanded: Bool, blobY: CGFloat) {
        let c = Self.collapsedSize
        if expanded {
            let e = Self.expandedSize
            let blobX = characterOnRight ? e.width - c.width : 0
            blobCell.frame = NSRect(x: blobX, y: blobY, width: c.width, height: c.height)
            let capW = e.width - c.width - 22
            let capX = characterOnRight ? 18 : c.width + 4
            capsuleHost.frame = NSRect(x: capX, y: 18, width: capW, height: e.height - 36)
        } else {
            blobCell.frame = NSRect(origin: .zero, size: c)
        }
    }

    /// Reduce Motion, from the one place the app reads it (`Motion.reduced`, which the
    /// preview harness can pin).
    private var reducedMotion: Bool { Motion.reduced }

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
                if let self, event.window !== self.panel { self.collapse(animated: true) }
            }
            return event
        }) { dismissMonitors.append(m) }
        if let m = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown], handler: { [weak self] _ in
            MainActor.assumeIsolated { self?.collapse(animated: true) }
        }) { dismissMonitors.append(m) }
    }

    private func removeDismissMonitors() {
        for m in dismissMonitors { NSEvent.removeMonitor(m) }
        dismissMonitors.removeAll()
    }

    // MARK: - Mouse

    /// Mouse-down on the blob starts tracking: release without moving is a tap
    /// (toggle the capsule); move past the slop and it is a drag that drives the body.
    /// Clicks on the capsule itself fall through to its buttons. The three handlers
    /// read the real mouse and hand its CG position to `pointerDown` / `pointerDragged`
    /// / `pointerUp`, the one path a drag takes (the preview harness drives the same
    /// path with a synthetic hand).
    private func mouseDown(_ event: NSEvent) -> Bool {
        let inContainer = container.convert(event.locationInWindow, from: nil)
        guard blobCell.frame.contains(inContainer) else { return false }
        pointerDown(at: CGSpace.point(fromAppKit: NSEvent.mouseLocation), time: event.timestamp)
        return true
    }

    private func mouseDragged(_ event: NSEvent) {
        pointerDragged(to: CGSpace.point(fromAppKit: NSEvent.mouseLocation))
    }

    private func mouseUp(_ event: NSEvent) {
        pointerUp(clickCount: event.clickCount, time: event.timestamp)
    }

    private func pointerDown(at p: CGPoint, time: TimeInterval) {
        downPoint = p
        downTime = time
        dragMoved = false
    }

    private func pointerDragged(to p: CGPoint) {
        guard let down = downPoint else { return }
        if !dragMoved {
            guard hypot(p.x - down.x, p.y - down.y) >= 4 else { return }
            dragMoved = true
            if expanded { collapse() }
            // Kevin's hand ends a flight or a trace (and one the capsule had parked),
            // the way up to the notch at a sleep or a wake included; where he lets go
            // is the new perch — also when he grabs a body still sagging in where it
            // worked, whose settle would otherwise have left the perch alone. A fly or
            // trace that was waiting for his throw to land is dropped: he has taken over.
            cancelTuckSlip()
            cancelFlight()
            sleepTuck?.cancel(); sleepTuck = nil
            settlingAfterWork = false
            pendingFly = nil
            pendingTrace = nil
            userMoved = true
            body.beginDrag(pointer: down)
            scanObstacles(force: true)
            blobView.poke()
        }
        body.moveDrag(pointer: p)
    }

    private func pointerUp(clickCount: Int, time: TimeInterval) {
        defer { downPoint = nil }
        if dragMoved {
            body.endDrag()
            let intoDock = dockCatchZoneCG()?.contains(body.center) ?? false
            hideNotchIfOwed()
            if intoDock { dropIntoDock() } else { blobView.poke() }
            return
        }
        guard time - downTime < 0.6 else { return }
        // A click is play, not a command: it pokes the blob and opens nothing. The
        // capsule is a double-click (or the right-click menu); an open capsule folds
        // on a single click. The poke waits one double-click interval so the first
        // half of a double-click does not send the blob skittering away.
        if expanded {
            collapse(animated: true)
        } else if clickCount >= 2 {
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

    /// The blob reacts to a tap: wide eyes and a blink, a shiver and a small hop that
    /// lands where it was (a stuck blob hops along its wall and stays stuck).
    private func pokeBlob() {
        pendingPoke = nil
        guard !expanded else { return }
        blobView.paused = false
        sim.nudge(1.4)
        sim.poke()
        // Mid-flight a hop would strand it (the goal goes with the fling) or make its
        // hover spot home when it landed; a shiver is enough. Slipping into the notch,
        // the same: it is on its way in.
        guard flight == .none, slip?.kind != .tuck else { blobView.poke(); return }
        // A poke is Kevin's hand: where the hop lands is his spot, perch and all.
        settlingAfterWork = false
        let dx = Double.random(in: -90 ... 90)
        let dy = Double.random(in: -140 ... -60)
        body.fling(CGVector(dx: dx, dy: dy))
        blobView.poke()
    }

    /// Built fresh on every right-click; each item carries its own action and dies
    /// with the menu. Solid symbols, one word each. The transport is Go/Pause and
    /// Stop — Sleep is no longer an item of its own: Stop closes the session.
    private func showMenu(for event: NSEvent) {
        let menu = NSMenu()
        menu.autoenablesItems = false
        let awake = state.isAwake
        let muted = state.phase == .muted
        let go = menuTarget.item(transportMenuTitle, symbol: state.transportLabel.symbol) { [weak self] in self?.state.transportToggle() }
        // Connecting: the press would be a Stop, and Stop is the item below — one Stop.
        if AppState.transportPress(for: state.phase) == .stop {
            go.isEnabled = false
        } else {
            go.toolTip = state.transportLabel.help
            go.keyEquivalent = "p"
            go.keyEquivalentModifierMask = [.option, .shift]
        }
        menu.addItem(go)
        // The wake word gate, while asleep: what it is doing (the status menu's row).
        if !awake {
            let ws = state.snapshot.settings.wake
            let gate = menuTarget.item(OrbStyle.gateLabel(state.wakeGate, phrases: ws.phrases, auth: ws.auth), symbol: OrbStyle.gateSymbol(state.wakeGate)) {}
            gate.isEnabled = false
            menu.addItem(gate)
        }
        menu.addItem(menuTarget.item(muted ? "Unmute" : "Mute", symbol: muted ? "mic.slash.fill" : "mic.fill") { [weak self] in
            self?.toggleMute()
        })
        // Never disabled: a Stop must land in every phase.
        menu.addItem(menuTarget.item("Stop", symbol: "stop.fill") { [weak self] in self?.stopPressed() })
        menu.addItem(.separator())
        menu.addItem(menuTarget.item("Console", symbol: "rectangle.3.group.fill") { [weak self] in self?.state.openConsole() })
        menu.addItem(.separator())
        menu.addItem(menuTarget.item("Quit", symbol: "power") { NSApp.terminate(nil) })
        NSMenu.popUpContextMenu(menu, with: event, for: container)
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

    /// The window goes where the body is, menu bar included. AppKit's default keeps
    /// every window's frame below the menu bar of its screen, which pinned the panel
    /// 27 pt under the notch dock while the body sat in it: the blob drew below the
    /// bar instead of emerging from under the ink, at every drop-out and every tuck.
    /// The body's own physics keep it on the work areas (`BlobBody.walls`,
    /// `keepOnSomeScreen`); the panel needs no second keeper.
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }

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

/// Hosts the status pill over the blob; never takes the mouse — except for the pill's
/// one-click action (the way back to the notch), and only on the pill's own band at
/// the foot of the cell, so the blob above it still takes the tap and the drag.
final class OrbPillHostingView: NSHostingView<OrbPillView> {
    override func hitTest(_ point: NSPoint) -> NSView? {
        guard rootView.status.pill?.action != nil else { return nil }
        let local = convert(point, from: superview)
        guard local.y <= 30 else { return nil }
        return super.hitTest(point)
    }
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
    /// "none" / "outbound" / "hovering" / "homing" / "tracing".
    public var previewFlightPhase: String { String(describing: flight) }
    public var previewBodySpeed: Double { body.speed }
    /// The CG centre the blob will drift back to.
    public var previewPerchCG: CGPoint? { perch }
    /// Seconds of hover left before it heads home (0 outside a flight).
    public var previewHoverRemaining: Double { flight == .none ? 0 : max(0, hoverUntil - CACurrentMediaTime()) }
    /// An orb.fly is waiting for Kevin's own motion to land.
    public var previewHasPendingFly: Bool { pendingFly != nil }
    /// The capsule interrupted a flight; closing it leaves the blob where it is (a worked spot).
    public var previewStayAfterCollapse: Bool { stayAfterCollapse }
    /// The sleep tuck is scheduled (phase fell asleep, the way up not started yet).
    public var previewSleepTuckPending: Bool { sleepTuck != nil }
    /// Kevin dragged the blob out of the notch and it has not slept since.
    public var previewFreeForSession: Bool { freeForSession }
    /// The pill's words right now (nil without a pill).
    public var previewPillText: String? { statusModel.pill?.text }
    /// A trace is carried or drawn right now.
    public var previewIsTracing: Bool { trace != nil }
    /// The pen's arc length so far and the stroke's length (0, 0 without a trace).
    public var previewTraceProgress: (s: Double, length: Double) { trace.map { ($0.s, $0.length) } ?? (0, 0) }
    /// Where the pen is on the stroke (CG), while drawing.
    public var previewPenCG: CGPoint? { trace.flatMap { flight == .tracing ? $0.sample(at: $0.s).0 : nil } }
    /// Where the field last laid the pen's point (CG): the body's centre plus the tip.
    public var previewTipCG: CGPoint { CGPoint(x: body.center.x + sim.cursorTip.dx, y: body.center.y + sim.cursorTip.dy) }
    /// How far into the cursor form the field is (0…1).
    public var previewCursorK: Double { sim.previewCursorK }
    /// The stroke's bounds (CG), for framing a shot; nil without a trace.
    public var previewTraceBounds: CGRect? {
        guard let t = trace, let first = t.points.first else { return nil }
        var r = CGRect(origin: first, size: .zero)
        for p in t.points { r = r.union(CGRect(origin: p, size: .zero)) }
        return r
    }
    /// The capsule's / menu's Stop, as pressed.
    public func previewStop() { stopPressed() }
    /// The capsule's / menu's Pause, as pressed.
    public func previewTogglePause() { togglePause() }
    /// "free" / "notch", and whether the blob is parked in the notch right now.
    public var previewHomeMode: String { notchMode ? "notch" : "free" }
    public var previewIsTucked: Bool { tucked }
    /// The notch's mode ("tucked" / "peek" / "island"), or "" without a dock.
    public var previewNotchMode: String { notch?.previewMode ?? "" }
    /// Pretend the pointer approached (or left) the notch island.
    public func previewNotchHover(_ over: Bool) { notch?.previewHover(over) }
    /// The notch panel's frame and its island (CG), for framing shots; nil without a dock.
    public var previewNotchPanelCG: CGRect? { notch?.previewPanelCG }
    public var previewNotchIslandCG: CGRect? { notch.map { $0.previewIslandCG } }
    /// Where the blob parks under the notch (CG).
    public var previewNotchDockCG: CGPoint? { notch?.dockPointCG }
    /// The notch island's springs and its raw rect (view coordinates), for the harness's
    /// ORB_LEVELS readout; "" / nil without a dock.
    public var previewNotchSprings: String { notch?.previewSprings ?? "" }
    public var previewNotchIslandRaw: NSRect? { notch?.previewIslandRaw }
    /// The thread dots the notch view holds right now ("" without a dock).
    public var previewNotchThreadDots: String { notch?.view.previewThreadDots ?? "" }
    /// The working strip's measured alphas at forced levels (`NotchView.previewStripProbe`); nil without a dock.
    public var previewNotchStripProbe: String? { notch?.view.previewStripProbe() }
    // The dock's surface (NotchPanel's preview accessors, forwarded; "" / [] / false without a dock).
    public var previewNotchLayout: String { notch?.view.previewLayoutReadout ?? "" }
    public var previewNotchHitList: [(name: String, rect: NSRect)] { notch?.view.previewHitList ?? [] }
    public var previewNotchChips: [String] { notch?.view.previewChips ?? [] }
    public var previewNotchChipsExtraWidth: CGFloat { notch?.view.previewChipsExtraWidth ?? 0 }
    public var previewNotchPeekWidthTarget: CGFloat { notch?.view.previewPeekWidthTarget ?? 0 }
    public var previewNotchPillText: String { notch?.view.previewPillText ?? "" }
    public var previewNotchPillKind: String { notch?.view.previewPillKind ?? "" }
    public var previewNotchLipChip: String { notch?.view.previewLipChip ?? "" }
    public var previewNotchLipGlow: String { notch?.view.previewLipGlow ?? "" }
    public var previewNotchLineText: String { notch?.view.previewLineText ?? "" }
    public var previewNotchFootText: String { notch?.view.previewFootText ?? "" }
    public var previewNotchFootDim: Bool { notch?.view.previewFootDim ?? false }
    public func previewNotchBoxDim(_ name: String) -> CGFloat { notch?.view.previewBoxDim(name) ?? 0 }
    public var previewNotchThumbs: [String] { notch?.view.previewThumbs ?? [] }
    public var previewNotchThreadChips: [String] { notch?.view.previewThreadChips ?? [] }
    public var previewNotchCanvasKind: String { notch?.view.previewCanvasKind ?? "" }
    public var previewNotchHeroLines: [String] { notch?.view.previewHeroLines ?? [] }
    public var previewNotchMeterFill: CGFloat { notch?.view.previewMeterFill ?? 0 }
    public var previewNotchTraceLevel: CGFloat { notch?.view.previewTraceLevel ?? 0 }
    public var previewNotchFootProblem: Bool { notch?.view.previewFootProblem ?? false }
    public var previewNotchFieldPlaceholder: String { notch?.view.previewFieldPlaceholder ?? "" }
    public var previewNotchFieldPlaceholderWidth: CGFloat { notch?.view.previewFieldPlaceholderWidth ?? 0 }
    public func previewNotchTooltipAt(_ p: NSPoint) -> String { notch?.view.previewTooltip(atIsland: p) ?? "" }
    public func previewNotchButtonAt(_ p: NSPoint) -> String { notch?.view.previewButton(atIsland: p) ?? "" }
    public var previewNotchHeadCaption: String { notch?.view.previewHeadCaption ?? "" }
    public var previewNotchProblemRow: String { notch?.view.previewProblemRow ?? "" }
    public var previewNotchThumbPixels: [String] { notch?.view.previewThumbPixels ?? [] }
    /// The animated hero swaps so far (`NotchView.previewHeroSwaps`): what left, what arrived, when.
    public var previewNotchHeroSwaps: [(from: String, to: String, at: Double)] { NotchView.previewHeroSwaps }
    public func previewNotchSetKind(_ name: String?) { notch?.view.previewSetKind(name) }
    public var previewNotchPinned: Bool { notch?.previewPinned ?? false }
    public var previewNotchAnchorWord: String { notch?.view.previewAnchorWord ?? "" }
    public var previewNotchRingMinisShown: Bool { notch?.view.previewRingMinisShown ?? false }
    public var previewNotchMiddleDead: Bool { notch?.view.previewMiddleDead ?? false }
    public var previewNotchPinAfterMark: Bool { notch?.previewPinAfterMark ?? false }
    public var previewNotchMarking: Bool { notch?.previewMarking ?? false }
    public var previewNotchIgnoresMouse: Bool { notch?.previewIgnoresMouse ?? true }
    /// Press an island control by name (`NotchView.Press(previewName:)`); false when it is not live.
    @discardableResult public func previewNotchPress(_ name: String) -> Bool { notch?.previewPress(name) ?? false }
    public func previewNotchHoverControl(_ name: String?) { notch?.view.previewSetHovered(name) }
    public func previewNotchTooltip(_ name: String) -> String { notch?.view.previewTooltip(name) ?? "" }
    public var previewNotchFieldFocused: Bool { notch?.view.previewFieldFocused ?? false }
    public var previewNotchFieldText: String {
        get { notch?.view.previewFieldText ?? "" }
        set { notch?.view.previewFieldText = newValue }
    }
    public func previewNotchFieldReturn() { notch?.view.previewFieldReturn() }
    public func previewNotchFieldEscape() { notch?.view.previewFieldEscape() }
    public var previewNotchCanBecomeKey: Bool { notch?.panel.canBecomeKey ?? false }
    public var previewNotchIsKey: Bool { notch?.panel.isKeyWindow ?? false }
    public func previewNotchKeyEquivalentSwallowed(_ event: NSEvent) -> Bool { notch?.panel.performKeyEquivalent(with: event) ?? false }
    public var previewNotchAccessibilityCounts: (buttons: Int, children: Int, hitRects: Int) {
        guard let v = notch?.view else { return (0, 0, 0) }
        return (v.previewAccessibilityButtonCount, v.previewAccessibilityChildCount, v.previewHitRectCount)
    }
    public func previewNotchContentAppearance(_ i: Int) -> (alpha: CGFloat, dy: CGFloat)? { notch?.view.previewContentAppearance(i) }
    public var previewNotchContentClock: String { notch?.view.previewContentClock ?? "" }
    public var previewNotchPulse: CGFloat { notch?.view.previewPulse ?? 0 }
    public var previewNotchStretchedFrames: Int { NotchView.previewStretchedFrames }
    public var previewNotchStretchedRestingFrames: Int { NotchView.previewStretchedRestingFrames }
    public var previewNotchDrawReadout: String { NotchView.previewDrawReadout }
    public var previewNotchInkBytes: Int { NotchInk.Cache.shared.renderedBytes }
    public var previewNotchInkCapacityBytes: Int { NotchInk.Cache.shared.capacityBytes }
    public func previewNotchInkHas(width: CGFloat, height: CGFloat) -> Bool {
        guard let g = notch?.geometry else { return false }
        let scale = notch?.panel.screen?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2
        return NotchInk.Cache.shared.has(size: CGSize(width: width, height: height), notchWidth: g.notch.width, scale: scale)
    }
    /// Whether a size is one the dock prewarmed and the cache pins (evicted last).
    public func previewNotchInkPinned(width: CGFloat, height: CGFloat) -> Bool {
        guard let g = notch?.geometry else { return false }
        let scale = notch?.panel.screen?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2
        return NotchInk.Cache.shared.isPinned(size: CGSize(width: width, height: height), notchWidth: g.notch.width, scale: scale)
    }
    /// The controller's dock state: the content it built, the Ask waiting for a mark, the blob-home rule armed.
    var previewDockContent: DockContent { dockContent }
    public var previewAskAfterMark: Bool { askAfterMark }
    public var previewHomeAfterTrace: Bool { markHome.armed }
    /// The sim's levels — raw as sent, eased, and the island level — for the same readout.
    public var previewSimLevels: String {
        let l = sim.previewLevels
        return String(format: "raw %.3f/%.3f eased %.3f/%.3f island %.3f", l.rawInput, l.rawOutput, l.input, l.output, sim.islandLevel)
    }
    /// The slip under way: "tuck" (into the notch) / "drop" (out of it) / "" (none), and how far along (0…1).
    public var previewSlipKind: String { slip.map { $0.kind == .tuck ? "tuck" : "drop" } ?? "" }
    public var previewSlipProgress: Double { slip?.progress ?? 0 }
    /// How the orb is drawn this frame: the blob cell's scale and the window's alpha.
    public var previewScale: Double { presentationScale }
    public var previewAlpha: Double { panel.alphaValue }
    /// The fastest the body went since the approach (or drop) began, pt/s (ORB_TIMELINE).
    public var previewTimelinePeakSpeed: Double { timelinePeak }
    /// Draw the notch panel's content into a context whose origin is the notch panel's bottom-left (AppKit).
    public func previewRenderNotch(in ctx: CGContext) { notch?.previewRender(in: ctx) }
    /// Drag the face out of the notch into the hand at `p` (CG), as the notch view would report it.
    public func previewDragOutOfNotch(at p: CGPoint) { dragOutOfNotch(at: p) }
    /// The trail's ghosts currently showing (AppKit frames), for framing a screenshot.
    public var previewGhostFrames: [NSRect] { trail.visibleFrames }
    /// Draw the showing ghosts into a context whose origin is `offset` (AppKit screen space).
    public func previewRenderTrail(in ctx: CGContext, offset: NSPoint) { trail.render(in: ctx, offset: offset) }
    /// Pin Reduce Motion for the sim and for every `Motion` token (the controller's
    /// tuck, drop, capsule and the trail read `Motion.reduced`).
    public func previewSetReducedMotion(_ on: Bool) {
        sim.reducedMotion = on
        Motion.reducedOverride = on
    }

    /// Draw the panel's content — its layer tree, what is on screen — into a context
    /// whose origin is the panel's bottom-left (AppKit, y up). For the harness's own
    /// screenshots when the window server will not give this process an image.
    public func previewRender(in ctx: CGContext) {
        panel.displayIfNeeded()
        CATransaction.flush()
        // The window's alpha is not part of the layer tree: composite through it, as
        // the window server does, so a mid-slip shot shows the fade.
        let alpha = panel.alphaValue
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
        settlingAfterWork = false
        body.fling(CGVector(dx: vx, dy: vy))
        scanObstacles(force: true)
        blobView.poke()
    }

    /// The body's CG centre.
    public var previewCenterCG: CGPoint { body.center }
    /// The drag's lag (grab target − centre, pt) and the eased elongation the field draws (0…0.75).
    public var previewLag: CGVector { body.lag }
    public var previewStretch: Double { sim.previewStretch }
    /// The wobble: the slosh's displacement (rows) and the ellipse mode (× radius).
    public var previewWobble: (slosh: Double, mode2: Double) { sim.previewWobble }
    /// Sticky borders: glued to a surface, and how far the patch has been pulled (0…1).
    public var previewIsStuck: Bool { body.isStuck }
    /// How many surfaces hold it: a corner is two.
    public var previewStuckCount: Int { body.stuckCount }
    public var previewNeck: Double { body.neck }
    public var previewIsDragging: Bool { body.dragging }
    /// The eyes this frame: "col,row 'glyph' open look x,y" each.
    public var previewEyes: String {
        sim.eyes.map { String(format: "%.1f,%.1f '%@' open %.2f look %.2f,%.2f", $0.col, $0.row, String($0.glyph), $0.open, $0.lookX, $0.lookY) }.joined(separator: " | ")
    }
    /// The face as the sim shows it (`BlobSim.face`), placed or not: "left right".
    public var previewFace: String { "\(sim.face.left) \(sim.face.right)" }
    /// Why the last eye fit failed, in numbers (BlobSim.eyeFitNote).
    public var previewEyeFitNote: String { sim.eyeFitNote }
    /// The field's body cells this frame as glyphs (one line per row, '·' for empty),
    /// for seeing why a fit failed.
    public var previewCellsArt: String {
        let glyphs = sim.ramp.glyphs
        var rows: [String] = []
        for r in 0..<sim.grid.rows {
            var line = ""
            for c in 0..<sim.grid.cols {
                let v = Int(sim.cells[r * sim.grid.cols + c])
                line.append(v == 0 ? "·" : glyphs[min(glyphs.count - 1, v)])
            }
            rows.append(String(format: "%2d %@", r, line))
        }
        return rows.joined(separator: "\n")
    }

    /// The unit direction and distance from the body's centre to the nearest work-area
    /// wall of its display, for a throw that is meant to stick.
    public var previewNearestWall: (dx: Double, dy: Double, distance: Double)? {
        guard let s = ScreenArea.all().first(where: { $0.frame.contains(body.center) }) ?? ScreenArea.all().first else { return nil }
        let w = s.work, c = body.center
        let options: [(Double, Double, Double)] = [(-1, 0, Double(c.x - w.minX)), (1, 0, Double(w.maxX - c.x)), (0, -1, Double(c.y - w.minY)), (0, 1, Double(w.maxY - c.y))]
        guard let best = options.min(by: { $0.2 < $1.2 }) else { return nil }
        return (best.0, best.1, best.2)
    }

    /// A synthetic drag through the panel's own mouse path: the hand comes down at `from`
    /// (CG), sweeps to `to` over `ms` with an ease-in-out (it accelerates, then stops —
    /// the mid-sweep is the fastest, where the teardrop is longest), and lets go. No
    /// button is really held, so the body is told not to end the drag on that account.
    /// `progress` is called every step with 0…1; `done` after the release.
    public func previewDrag(from: CGPoint, to: CGPoint, ms: Double, progress: ((Double) -> Void)? = nil, done: (() -> Void)? = nil) {
        blobView.paused = false
        body.syntheticDrag = true
        pointerDown(at: from, time: ProcessInfo.processInfo.systemUptime)
        let start = CACurrentMediaTime()
        let duration = max(0.05, ms / 1000)
        Timer.scheduledTimer(withTimeInterval: 1.0 / 120, repeats: true) { [weak self] timer in
            MainActor.assumeIsolated {
                guard let self else { timer.invalidate(); return }
                let u = min(1, (CACurrentMediaTime() - start) / duration)
                let s = u * u * (3 - 2 * u)
                let p = CGPoint(x: from.x + (to.x - from.x) * s, y: from.y + (to.y - from.y) * s)
                self.pointerDragged(to: p)
                progress?(u)
                if u >= 1 {
                    timer.invalidate()
                    self.pointerUp(clickCount: 1, time: ProcessInfo.processInfo.systemUptime)
                    self.body.syntheticDrag = false
                    done?()
                }
            }
        }
    }

    /// Pin the phase and gate the field shows, for the expression strip (bypasses AppState).
    public func previewSetExpression(phase: Phase, gate: WakeGateState?) {
        sim.setPhase(phase)
        if let gate { sim.setGate(BlobGate(gate)) }
        blobView.poke()
    }
    public func previewPoke() { sim.poke(); blobView.poke() }
    /// Step the field's clock by `seconds` without waiting (settles the eases for a shot).
    public func previewAdvanceField(_ seconds: Double) {
        var left = seconds
        while left > 0 { sim.step(min(left, 1.0 / 24)); left -= 1.0 / 24 }
        blobView.renderNow()
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

/// The blob-home rule of a mark's own echo, as the one small state machine the
/// controller drives. The trace the engine sends after a mark commits (reason "mark")
/// while the blob is tucked brings the blob back to the notch — with the island's pin,
/// if it had one — instead of leaving it by the line; every other trace and every fly
/// ends where it worked (`stayHere`). The rule belongs to that one trace: whatever
/// ends its work early with the blob staying out — Kevin's hand (a drag, a summon, the
/// capsule), the orb hiding, a display going away (`cancelFlight`), another job's fly
/// overtaking the line or retargeting the Reduce Motion hover (`fly(to:)`), a second
/// trace taking the line down (`trace`) — interrupts it, so a later unrelated job ends
/// where it worked and the dock forgets the pin it folded for the mark rather than
/// popping the island open pinned at the next sleep tuck with nobody near. A route home
/// by other means — the explicit `orb.home`, a Stop (whose sleep tucks the blob) — only
/// disarms it: the blob is coming home anyway, and the pin comes back with it at the
/// tuck as it would have. Every transition answers with what the dock does with that
/// pin (`Pin`); `OrbPanelController` holds one and relays the answer
/// (`pinAcrossTrace`). Foundation-only, so `Scripts/orb-home-probe.sh` pins every
/// transition without a window.
struct MarkHomeRule: Equatable {
    /// What the dock does with the pin it folded for the mark.
    enum Pin: Equatable {
        /// Keep it across the blob's absence; it comes back with the blob (`keepPinAcrossTrace`).
        case keep
        /// Forget it: the blob stays out (`dropPinAcrossTrace`).
        case drop
        /// Nothing changes for the pin.
        case leave
    }
    /// Where the work's end leaves the body.
    enum End: Equatable { case tuck, stay }

    /// The mark echo's way home is owed.
    private(set) var armed = false

    /// A trace begins (`trace(points:…)`). Armed when it is a mark's echo from the dock
    /// (`.keep`). One that is not, arriving while an echo was still owed its way home,
    /// ends that rule with the blob out by its new line (`.drop`).
    mutating func traceBegins(tucked: Bool, reason: String?) -> Pin {
        let owed = armed
        armed = tucked && reason == "mark"
        if armed { return .keep }
        return owed ? .drop : .leave
    }

    /// A fly lands on the controller (`fly(to:)`). One for another job (any reason but
    /// "mark") ends the rule as an interruption would; the mark echo's own Reduce
    /// Motion flight (reason "mark", from `trace`) leaves it armed.
    mutating func flyBegins(reason: String?) -> Pin {
        if reason == "mark" { return .leave }
        return interrupted()
    }

    /// The flight or trace is cut short with the blob staying out (`cancelFlight`): the
    /// rule ends and the dock forgets the pin — once, by the interruption (`.drop` only
    /// while a rule was owed).
    mutating func interrupted() -> Pin {
        defer { armed = false }
        return armed ? .drop : .leave
    }

    /// The blob is on its way home by another route — the explicit `orb.home`
    /// (`flyHome`), a Stop whose sleep tucks it (`reactToStop`): the rule is over and the
    /// pin's own rule applies at the tuck, so nothing is dropped.
    mutating func homeBound() {
        armed = false
    }

    /// The work is over (`workDone`): the mark echo's own end in notch mode tucks; every
    /// other end, and one with the notch not home any more, stays. Consumes the rule.
    mutating func workDone(notchMode: Bool) -> End {
        defer { armed = false }
        return armed && notchMode ? .tuck : .stay
    }
}
