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
/// extends it). Then it stays where it worked (`stayHere`): it settles there, sticks
/// if it is touching an edge, and that spot is saved as `orbPosition` exactly as a
/// drop would be — debounced, once, when settled — so a relaunch finds it there and
/// it never drifts back to some earlier spot. The perch is different: it is where
/// Kevin last put it by hand (a drop, a fling, a summon; remembered for the session),
/// and `orb.home` means "go back there". A user drag mid-flight wins: the flight is
/// cancelled and where he lets go is the new perch. A fly that arrives while Kevin's
/// own throw is still gliding waits for it to land. In flight it wears the acting
/// colour, shimmers faster and trails a dotted wake of itself (`BlobTrail`).
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
/// Notch mode (`Settings.orbHome == "notch"`, the default on a Mac whose main display
/// has a notch) makes the notch home: the blob lives and sleeps in it (`NotchDock`,
/// see NotchPanel.swift — the same `BlobSim`, so the face and colour are continuous),
/// drops out of it for a fly, a trace or a summon (a hop down with a squish, from
/// under the ink), does the work, and flies back up and tucks in when it is done —
/// "stay where you worked" is the free-mode rule. Dragging it out of the notch makes
/// it free for the rest of the session; the pill offers the way back. Without a notch
/// (an external display as main, the lid closed) notch mode falls back to free mode
/// and comes back when the notch returns.
///
/// Pause (`.pause` / `.resume`, from the capsule, the notch island, the menu, ⌥⇧P)
/// keeps the session open but silent; the blob dims to titanium with a `u u` face and
/// a slow breath, and the pill says so.
///
/// Stop is felt at once. Every Stop pressed in the app — the capsule, the menu
/// (`stopPressed`), the Console's button and ⌘. — posts `stopPressedNotification`
/// in-process, ahead of the engine, and the blob answers it (`reactToStop`): any
/// flight or trace is cancelled, it shivers with wide eyes that settle back to its
/// normal face, and it stays where it is (free) or returns to the notch; the pill
/// says "Stopped". None of that waits on the engine, and nothing is latched: the
/// capsule's Stop is hot only while the snapshot holds a running delegation.
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

    // Flights (orb.fly / orb.home / orb.trace).
    /// Where an `orb.fly` is: on the way out, parked beside the target, on the way
    /// back — or, for an `orb.trace`, drawing (`tracing`: parked with the pen on the
    /// line, led along it).
    private enum Flight: Equatable { case none, outbound, hovering, homing, tracing }
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
    /// A flight ended and the body is settling where it worked (`stayHere`: a stuck
    /// dome sagging in): the settle saves the spot but leaves the perch alone.
    private var settlingAfterWork = false

    // Home: free, or the notch.
    /// The notch dock, built the first time notch mode comes on; nil until then.
    private var notch: NotchDock?
    /// Notch mode is on: the setting says notch, the main display has one, and Kevin
    /// has not dragged the blob out this session.
    private var notchMode = false
    /// The blob is parked in the notch: the orb panel is hidden and the notch shows the face.
    private var tucked = false
    /// Kevin dragged the blob out of the notch: free for the rest of the session.
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
    /// A summon in notch mode: once it lands and has sat a moment, it flies back up.
    private var returnAfterSummon = false
    /// When the blob last dropped out of the notch (CACurrentMediaTime): the hop down
    /// shows for `dropWindup` before a flight's spring takes over.
    private var droppedAt = -100.0
    static let dropWindup = 0.26
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
            togglePause: { [weak self] in self?.togglePause() },
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
        traceHold?.cancel()
        homePillTimer?.cancel()
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
        panel.orderFrontRegardless()
        blobView.poke()
    }

    public func hide() {
        collapse()
        pendingFly = nil
        pendingTrace = nil
        if flight != .none {
            // Cut the flight short and put the body back home now, so it reappears
            // where Kevin expects it: a goal spring left armed would fly on after
            // show() and settle somewhere as if it had worked there.
            cancelFlight()
            if notchMode { tuckIn(instant: true) } else if let perch { placeBody(centerCG: perch) }
        }
        notch?.hide()
        blobView.paused = true
        statusModel.shown = false
        panel.orderOut(nil)
    }

    /// The capsule — or, parked in the notch, the notch's island.
    public func toggleExpanded() {
        if tucked { notch?.toggleIsland(); return }
        if expanded { collapse() } else { expand() }
    }

    /// Fling the blob to the cursor (landing slightly above it) with a bounce. Kevin
    /// calling it over ends any flight: where it lands is the new perch — in free
    /// mode; in notch mode it drops out of the notch, sits by the cursor a moment,
    /// and flies back up.
    public func summon() {
        // A capsule opened mid-flight starts the drift home as it folds; Kevin's call cuts that short too.
        if expanded { collapse() }
        cancelFlight()
        // Kevin's call takes over a body still settling where it worked: where it lands is his.
        settlingAfterWork = false
        pendingFly = nil
        pendingTrace = nil
        if !positioned { placeInitially() }
        if tucked { dropOut() }
        returnAfterSummon = notchMode
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

    public var isVisible: Bool { panel.isVisible || (tucked && (notch?.isVisible ?? false)) }

    // MARK: - State binding

    private func bind() {
        state.$snapshot
            .map(\.phase)
            .removeDuplicates()
            .sink { [weak self] phase in
                guard let self else { return }
                // Falling asleep ends whatever it was doing on screen: a Stop, a sleep.
                if phase == .asleep, self.sim.phase != .asleep, self.flight != .none { self.reactToStop() }
                self.sim.setPhase(phase)
                self.notch?.phaseChanged()
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
        // be decided — whatever `orbHome` says, even nothing (an older daemon), which
        // the sink above would not see as a change from the empty snapshot's nil.
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
        // The notch island's one line: the last thing said.
        state.$snapshot
            .map { (s: Snapshot) -> String in s.transcript.last?.text ?? "" }
            .removeDuplicates()
            .sink { [weak self] line in self?.notch?.view.lastLine = line }
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
        // else the latest toast, else "Paused · still connected" while paused. The gate
        // outranks toasts because its lockout toast and countdown arrive together and
        // the countdown is the one worth the space. A toast that repeats the showing
        // one's words (the app's "Stopped", then the engine's "stopped" a moment later)
        // does not flip the pill.
        Publishers.CombineLatest4(
            state.$snapshot.map(\.problems.first).removeDuplicates(),
            gatePill.removeDuplicates(),
            homePill.removeDuplicates(),
            state.$toasts.map(\.last).removeDuplicates { a, b in
                a?.tone == b?.tone && a?.text.lowercased() == b?.text.lowercased()
            })
            .combineLatest(state.$snapshot.map(\.phase).removeDuplicates())
            .map { top, phase -> OrbPill? in
                let (problem, gate, home, toast) = top
                if let p = problem { return OrbPill(text: p, tone: .error) }
                if let g = gate { return g }
                if let h = home { return h }
                if let t = toast { return OrbPill(text: t.text, tone: t.tone) }
                if phase == .paused { return OrbPill(text: "Paused · still connected", tone: .info, icon: "pause.fill") }
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
                guard let self, !self.userMoved, !self.expanded, !self.body.isActive, self.flight == .none, !self.tucked else { return }
                self.apply(savedPosition: pos)
            }
            .store(in: &cancellables)

        // Flights and traces. The overlay layer draws the shapes; the blob answers
        // these — and `clear`, which takes a line it is drawing down with the shapes.
        // `clear` is the brain's ordinary show_clear as much as a Stop's, so it is not
        // a Stop here: the Stop comes on `stopPressedNotification` below.
        state.overlayCommands
            .receive(on: DispatchQueue.main)
            .sink { [weak self] cmd in
                guard let self else { return }
                switch cmd {
                case .orbFly(let x, let y, let dwellMs, let reason):
                    self.fly(to: CGPoint(x: x, y: y), dwellMs: dwellMs, reason: reason)
                case .orbTrace(let points, let closed, let label, let ttlMs, let tone, let reason):
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
        panel.orderFrontRegardless()
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
    /// a notch on the main display, and ends for the session when Kevin drags the blob
    /// out. Coming on, it sends an idle blob up into the notch (at once when nothing is
    /// showing yet); going off, a tucked blob drops out to float under where the notch
    /// was, and where it lands is the perch — and a blob still on its way up to the
    /// notch turns round and drifts back to the perch instead, so the spot under the
    /// notch is never settled on and saved as Kevin's. Until the daemon's first
    /// snapshot has arrived the setting is unknown (the empty snapshot would read as
    /// "notch", and `connected` comes before the snapshot), so the blob starts free and
    /// flies up on the first snapshot that says notch — never dropping a free user's
    /// blob under the notch and saving that as his spot.
    private func updateHomeMode(animated: Bool) {
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
            dock.view.lastLine = state.snapshot.transcript.last?.text ?? ""
            if flight == .none, !body.dragging, !expanded {
                if animated, positioned, panel.isVisible { driftHome() } else { tuckIn(instant: true) }
            }
        } else {
            returnAfterSummon = false
            if tucked {
                dropOut()
            } else if flight == .homing {
                // On its way up to the notch: the notch is not home any more. Back to
                // the perch (home now) — its settle there is the perch again, not the dock.
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
        return dock
    }

    /// Where home is: the notch's dock in notch mode, else the perch — the spot Kevin last put it by hand.
    private var homePoint: CGPoint? { notchMode ? notch?.dockPointCG : perch }

    /// Out of the notch: the body appears under the ink, its top hidden by the menu
    /// bar, and hops down with a squish (a flight's spring or Kevin's hand takes it
    /// from there). `toward` puts it under a hand instead of under the notch.
    private func dropOut(toward hand: CGPoint? = nil) {
        guard tucked, let notch else { return }
        tucked = false
        notch.parked = false
        placeBody(centerCG: hand ?? notch.dropPointCG)
        blobView.paused = false
        panel.alphaValue = 1
        panel.orderFrontRegardless()
        droppedAt = CACurrentMediaTime()
        sim.splat(reducedMotion ? 0.2 : 0.5)
        sim.nudge(1.0)
        if hand == nil { body.fling(CGVector(dx: 0, dy: reducedMotion ? 120 : 320)) }
        scanObstacles(force: true)
        blobView.poke()
        #if JARHEAD_ORB_PREVIEW
        print(String(format: "notch: drop out at CG %.0f,%.0f%@", body.center.x, body.center.y, hand == nil ? "" : " (into the hand)"))
        fflush(stdout)
        #endif
    }

    /// Up into the notch: the flight is over, the notch shows the face, and the orb
    /// panel slides up under the ink as it fades (140 ms) and is hidden.
    private func tuckIn(instant: Bool) {
        guard let notch, !tucked else { return }
        endFlight(clearTrail: false)
        returnAfterSummon = false
        settlingAfterWork = false
        tucked = true
        body.teleport(to: notch.dockPointCG)
        notch.show()
        notch.parked = true
        #if JARHEAD_ORB_PREVIEW
        print("notch: tuck in\(instant ? " (instant)" : "")")
        fflush(stdout)
        #endif
        if instant || reducedMotion {
            panel.orderOut(nil)
            panel.alphaValue = 1
            blobView.paused = true
            return
        }
        let up = NSRect(origin: NSPoint(x: panel.frame.minX, y: panel.frame.minY + 26), size: panel.frame.size)
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.14
            ctx.timingFunction = CAMediaTimingFunction(name: .easeIn)
            panel.animator().alphaValue = 0
            panel.animator().setFrame(up, display: true)
        }, completionHandler: { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.tucked else { return }
                self.panel.orderOut(nil)
                self.panel.alphaValue = 1
                self.blobView.paused = true
            }
        })
    }

    /// Kevin pulled the face out of the notch: the blob drops into his hand and is free
    /// for the rest of the session; the pill offers the way back. The notch panel is
    /// not hidden yet: it took the mouse-down, and the rest of the drag comes through
    /// it (`NotchView.mouseDragged` → `pointerDragged`), so it stays ordered in — clear,
    /// its island shrunk away — until the hand lets go (`hideNotchAfterDrag`).
    private func dragOutOfNotch(at p: CGPoint) {
        guard tucked else { return }
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

    /// The pill's one click: notch mode again, the blob flies back up.
    private func returnToNotch() {
        homePillTimer?.cancel(); homePillTimer = nil
        homePill.send(nil)
        freeForSession = false
        updateHomeMode(animated: true)
    }

    private func togglePause() {
        state.send(state.phase == .paused ? .resume : .pause)
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
            // Home again: up into the notch in notch mode; on the perch Kevin chose in
            // free mode (`orb.home`, a Stop on the way) — and the saved spot is that again.
            endFlight(clearTrail: false)
            if notchMode { tuckIn(instant: false) } else { persistPosition(asPerch: true) }
        case .hovering, .tracing:
            break
        case .none:
            if settlingAfterWork {
                // The dome a finished flight sagged into: where it worked is saved, the perch is not moved.
                settlingAfterWork = false
                persistPosition(asPerch: false)
            } else if notchMode, returnAfterSummon {
                // A summon in notch mode: sit by the cursor a moment, then back up.
                returnAfterSummon = false
                flight = .hovering
                flightTarget = body.center
                hoverUntil = CACurrentMediaTime() + 2.5
                scheduleHoverEnd()
                return
            } else {
                persistPosition(asPerch: true)
            }
            // Kevin's throw has landed and is the perch; now the fly (or trace) that waited for it.
            if let p = pendingFly {
                pendingFly = nil
                if CACurrentMediaTime() < p.expires { fly(to: p.target, dwellMs: p.dwellMs, reason: p.reason) }
            } else if let p = pendingTrace {
                pendingTrace = nil
                if CACurrentMediaTime() < p.expires, case .orbTrace(let points, let closed, let label, let ttlMs, let tone, let reason) = p.cmd {
                    trace(points: points.map { CGPoint(x: $0.x, y: $0.y) }, closed: closed, label: label, ttlMs: ttlMs, tone: tone, reason: reason)
                }
            }
        }
    }

    /// Save where the body rests as `orbPosition`, so a relaunch puts it back there. A
    /// spot Kevin chose (a drop, a fling, a summon, a rescue) is also the perch — where
    /// `orb.home` returns to; a spot a flight ended on (`stayHere`) is saved but leaves
    /// the perch alone. The spot is taken now: a flight that leaves within the debounce
    /// (one that was waiting for this very landing) must not stop the save, nor be saved
    /// itself. Never while tucked: in notch mode the notch is home, and the saved spot
    /// is where the blob last floated free.
    private func persistPosition(asPerch: Bool = true) {
        guard !expanded, flight == .none, !tucked else { return }
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
        // A plain fly overtakes a trace: the half-drawn line comes down, the pen morphs back.
        if trace != nil { cancelTrace() }
        pendingTrace = nil
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
        panel.orderFrontRegardless()
        if body.isActive, !dropping { takeOff() } else { scheduleTakeoff(after: dropping ? Self.dropWindup : nil) }
        blobView.poke()
    }

    /// The wind-up before the launch; out of the notch, long enough for the hop down to show.
    private func scheduleTakeoff(after: Double? = nil) {
        takeoff?.cancel()
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.takeOff() }
        }
        takeoff = work
        DispatchQueue.main.asyncAfter(deadline: .now() + (after ?? (sim.reducedMotion ? 0 : Self.windup)), execute: work)
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
    /// clear, the capsule closing on a parked flight. In free mode the blob stays where
    /// it worked (`stayHere`); in notch mode the notch is home and it flies back up.
    private func workDone() {
        if notchMode { driftHome() } else { stayHere() }
    }

    /// Stay where you worked: the flight ends here. The body parks — still, and stuck
    /// to any edge its surface is touching (it sags into the dome over the next few
    /// frames) — and the spot is saved as a drop would be, once it is settled. The
    /// perch (where `orb.home` goes) is not moved: that stays the spot Kevin last
    /// chose by hand.
    private func stayHere() {
        hoverTimer?.cancel(); hoverTimer = nil
        takeoff?.cancel(); takeoff = nil
        if body.hasGoal || body.guided || body.isActive { body.teleport(to: body.center) }
        endFlight(clearTrail: true)
        body.park()
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

    /// Back home: at once on `orb.home`. Home is the perch — where Kevin last put it by
    /// hand — in free mode, the notch in notch mode. A trace under way is cancelled —
    /// its half-drawn line comes down. Never over Kevin's hand: not while he drags, and
    /// not while his throw still glides (its landing is his perch and must be saved as
    /// such). Outside a flight only an idle body off its home drifts back.
    private func flyHome() {
        pendingTrace = nil
        guard !body.dragging else { return }
        if trace != nil { cancelTrace() }
        if flight == .none {
            guard !body.isActive, let home = homePoint, hypot(body.center.x - home.x, body.center.y - home.y) > 2 else { return }
        }
        driftHome()
    }

    /// Start the way home from wherever the body is — the tail of a flight, or of one
    /// the capsule interrupted. A gentle spring, no splat: the blob drifting home
    /// behind the work, not racing. In notch mode home is the dock under the notch,
    /// and the settle there tucks it in.
    private func driftHome() {
        hoverTimer?.cancel(); hoverTimer = nil
        takeoff?.cancel(); takeoff = nil
        settlingAfterWork = false
        guard let home = homePoint else { endFlight(clearTrail: false); return }
        if tucked { return }
        flight = .homing
        sim.flight = true
        sim.flightMoving = true
        blobView.paused = false
        panel.orderFrontRegardless()
        body.drift(to: home)
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
    /// it emerges smeared the hop into a doubled body. Never under reduce motion.
    /// Always in the flight colour: the first ghost drops while the field is still
    /// easing from the phase colour, and a purple ghost behind a green blob reads as
    /// two creatures.
    private func dropGhostIfDue() {
        guard flight != .none, flight != .tracing, takeoff == nil, !sim.reducedMotion, body.speed > 240 else { return }
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
        let shown = panel.isVisible || tucked
        if !shown || sim.reducedMotion {
            // The line, whole; the blob flies to it if it is on screen.
            state.liveStrokes.send(path.stroke(upTo: pts.count - 1, pen: nil, done: true, ttlMs: path.ttlMs))
            if shown { fly(to: pts[0], dwellMs: 1500, reason: reason) }
            return
        }
        if expanded { collapse() }
        if !positioned { placeInitially() }
        if tucked { dropOut() }
        let now = CACurrentMediaTime()
        let dropping = now - droppedAt < Self.dropWindup + 0.05
        if flight == .none, body.isActive, !dropping {
            pendingTrace = (.orbTrace(points: pts.map { Point2(x: $0.x, y: $0.y) }, closed: false, label: label, ttlMs: ttlMs, tone: tone, reason: reason), now + 3.0)
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
        panel.orderFrontRegardless()
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

    /// Stop, from the capsule or the menu: the command, and the in-process signals
    /// nothing waits on — `stopPressedNotification` (which brings `reactToStop` here),
    /// the overlay's `clear` (the shapes come down) and the "Stopped" toast that is
    /// the pill under the blob and the Console's. The capsule's Stop flashes red for the press.
    private func stopPressed() {
        capsuleModel.stopFlash += 1
        state.send(.stop)
        NotificationCenter.default.post(name: Self.stopPressedNotification, object: nil)
        state.overlayCommands.send(.clear)
        state.toast("Stopped")
    }

    /// The blob's own answer to a Stop, at once: whatever it was doing on screen ends
    /// — the flight or trace is cancelled, its wake and half-drawn line with it — it
    /// shivers with wide eyes that settle back to its normal face, and stays where it
    /// is (free mode) or flies back up into the notch. Nothing about a Stop is latched
    /// here: the next fly, wake or pause lands as if the Stop never happened.
    private func reactToStop() {
        pendingFly = nil
        pendingTrace = nil
        pendingPoke?.cancel(); pendingPoke = nil
        let wasOut = flight != .none
        cancelFlight()
        blobView.paused = false
        sim.nudge(1.6)
        sim.poke()
        if wasOut, !expanded { workDone() }
        blobView.poke()
        notch?.view.wake()
    }

    // MARK: - Physics loop

    /// One display frame while the body moves. Returns true while it still does.
    private func physicsTick(_ dt: Double) -> Bool {
        guard !expanded, !frozen, !tucked, body.isActive || body.dragging else { return false }
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
            // Opened beside the work mid-flight: the work is over — it stays there (free
            // mode: saved, but not Kevin's perch) or returns to the notch.
            homeAfterCollapse = false
            workDone()
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
            // Kevin's hand ends a flight or a trace (and one the capsule had parked,
            // which the collapse just sent home); where he lets go is the new perch —
            // also when he grabs a body still sagging in where it worked, whose settle
            // would otherwise have left the perch alone. A fly or trace that was
            // waiting for his throw to land is dropped: he has taken over.
            cancelFlight()
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
            hideNotchIfOwed()
            blobView.poke()
            return
        }
        guard time - downTime < 0.6 else { return }
        // A click is play, not a command: it pokes the blob and opens nothing. The
        // capsule is a double-click (or the right-click menu); an open capsule folds
        // on a single click. The poke waits one double-click interval so the first
        // half of a double-click does not send the blob skittering away.
        if expanded {
            collapse()
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
        // hover spot home when it landed; a shiver is enough.
        guard flight == .none else { blobView.poke(); return }
        // A poke is Kevin's hand: where the hop lands is his spot, perch and all.
        settlingAfterWork = false
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
        let paused = state.phase == .paused
        let pause = menuTarget.item(paused ? "Resume" : "Pause", symbol: paused ? "play.fill" : "pause.fill") { [weak self] in self?.togglePause() }
        pause.keyEquivalent = "p"
        pause.keyEquivalentModifierMask = [.option, .shift]
        menu.addItem(pause)
        // Never disabled: a Stop must land in every phase.
        menu.addItem(menuTarget.item("Stop", symbol: "stop.fill") { [weak self] in self?.stopPressed() })
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
    /// Draw the notch panel's content into a context whose origin is the notch panel's bottom-left (AppKit).
    public func previewRenderNotch(in ctx: CGContext) { notch?.previewRender(in: ctx) }
    /// Drag the face out of the notch into the hand at `p` (CG), as the notch view would report it.
    public func previewDragOutOfNotch(at p: CGPoint) { dragOutOfNotch(at: p) }
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
        for r in 0..<BlobSim.rows {
            var line = ""
            for c in 0..<BlobSim.cols {
                let v = Int(sim.cells[r * BlobSim.cols + c])
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
