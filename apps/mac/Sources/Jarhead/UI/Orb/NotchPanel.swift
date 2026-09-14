import AppKit
import QuartzCore

// Notch mode: the blob lives and sleeps in the MacBook's notch. This is the way the
// Dynamic-Island-style notch apps do it — a borderless, non-activating panel sitting
// over the hardware notch, above the menu bar, painted pure black where it overlaps
// the notch so it merges with the bezel, growing a small island under it and
// expanding on hover. The orb panel stays the flight body: `OrbPanelController`
// hands the blob between this panel (parked) and the orb panel (flying); both draw
// from the one `BlobSim`, so the face and the colour are continuous.
//
//   tucked   asleep: only the eyes — `- -` (the gate faces while the gate listens
//            or asks), dark grey on the notch's black, in a 12 pt lip at the notch's
//            bottom edge — plus a one-pixel glow along the lip that breathes. Marks
//            survive sleep: while any waits the glow takes the mark tone and a small
//            `◎2` chip sits right of the eyes.
//   peeking  awake: a 26 pt island hanging under the notch, the face centred, widening
//            by up to 30 pt and pulsing with the audio while listening or speaking,
//            the phase colour as a hairline along its bottom edge, never a wash.
//            The island body carries the app icon's dithered orb gradient (NotchInk.swift
//            over UI/Dither.swift), pooling out of the pure-black notch — unmistakably
//            the orb's colour even in this strip, the eyes on their ground under-copy.
//            Right of the face: the working counter, the thread dots, then glance
//            chips — a thread's question, the circled count, a problem's glyph, the
//            meter — never sentences, at most four, the strip widening by their width
//            and never past the island's. Marking replaces them with `◎ Circle
//            something · Esc`.
//   island   hover (or the capsule toggle, ⌥⇧Return): 360×132, sprung open
//            (`Motion.island`), fixed rows that never reflow — the face left on the
//            head row; then the transport as a 22 pt circle, the phase word and the
//            working counter (S1); one line under it — the Say field while it has key,
//            a thread's question, the running delegation's request, the last thing
//            said, the gate's words asleep (S2); Circle and Window boxes and the
//            circled strip's thumbnails (S3); one chip per live thread with its own
//            Stop (S4); the meter on the foot (S5); and a right column of 26×24
//            hairline boxes — Stop and Mute, Ask and Clear (Allow and Deny while a
//            question waits), Console and Sleep. The content fades in and rises a few
//            points with a ≤ 150 ms stagger as the island opens and fades on close
//            (none of the rise or stagger under Reduce Motion); it contracts 600 ms
//            after the pointer leaves. A global mouse-moved monitor (no Accessibility
//            grant needed) sees the pointer approach while the island is small.
//   pill     a 20 pt slot 6 pt under the island (or the lip): the wake gate's
//            question / verdict / countdown asleep, else a toast for 1.5 s, else
//            `◎ 1 circled · Go to ask` for 6 s after a mark lands while tucked, else —
//            with the island open — the newest problem with its remedy as a box.
//   working  a delegation runs (`workingSince`, set by the controller from the snapshot's
//            running delegation): "Working · 0:12" in mono digits — right of the face in
//            the peek (the island widens by the counter's width and the face slides left
//            by half of it, so the pair stays centred), right of the phase word on the
//            open island, and, while the blob is out at its target (not parked), alone
//            on a quiet black strip of peek height under the notch.
//   marking  Kevin is circling: the island folds to the peek (or the lip), the panel
//            lets the mouse through to the overlay, the peek reads the one hint. If the
//            island was pinned, the pin comes back with the blob after the mark.
//
// Geometry comes from NSScreen (`auxiliaryTopLeftArea` / `auxiliaryTopRightArea`:
// the notch is the gap between them; on Kevin's 14" it is x 771…956, 185×32 pt, under
// a 33 pt menu bar) on whichever display has one — the built-in, main or not — and is
// recomputed on every screen change. With no notch on any display (the lid closed) the
// dock reports no geometry and the controller falls back to free mode.
//
// Every duration, curve and spring here is `Motion`'s (UI/Motion.swift). Everything is
// AppKit and CoreGraphics: no SwiftUI body anywhere on the notch.

// MARK: - Geometry

struct NotchGeometry: Equatable {
    /// The hardware notch, AppKit screen coordinates (y up).
    let notch: NSRect
    /// The menu bar's bottom edge (AppKit y): the island hangs from here.
    let menuBarBottom: CGFloat
    /// The display's frame (AppKit).
    let screen: NSRect

    /// The panel's frame: the notch widened `NotchGeometry.wing` each side and extended
    /// `NotchGeometry.drop` below the menu bar's bottom edge — room for the island at
    /// its widest and tallest and the pill slot under it. Recomputed with the geometry.
    var panelFrame: NSRect {
        let width = max(notch.width + 2 * Self.wing, Self.islandWidth + 2 * 20)
        let x = notch.midX - width / 2
        let y = menuBarBottom - Self.drop
        return NSRect(x: x, y: y, width: width, height: screen.maxY - y)
    }

    static let wing: CGFloat = 40
    /// Room under the menu bar: the island (132) plus the 44 pt pill slot beneath it.
    static let drop: CGFloat = 44 + 132
    static let islandWidth: CGFloat = 360
    static let islandHeight: CGFloat = 132
    static let peekHeight: CGFloat = 26
    static let lipHeight: CGFloat = 12
    /// The notch's corner radius, matched on the island's bottom corners.
    static let radius: CGFloat = 12

    /// Set by the preview harness (ORB_NOTCH=1): report a notch at the measured size
    /// on the main display whether or not the hardware has one.
    nonisolated(unsafe) static var simulate = false

    /// The notch, on whichever connected display has one (`auxiliaryTopLeftArea` /
    /// `auxiliaryTopRightArea` are set only on such a screen) — the built-in display
    /// whether or not it is the main one, so the panel, the dock and the drop points sit
    /// on it even when an external display carries the menu bar. Nil when no display
    /// has a notch (the lid closed, a desktop Mac), or the simulated one on the main
    /// display for the harness.
    @MainActor
    static func current() -> NotchGeometry? {
        for screen in NSScreen.screens {
            guard let left = screen.auxiliaryTopLeftArea, let right = screen.auxiliaryTopRightArea else { continue }
            let frame = screen.frame
            let notch = NSRect(x: left.maxX, y: left.minY, width: right.minX - left.maxX, height: frame.maxY - left.minY)
            guard notch.width > 20, notch.height > 8 else { continue }
            return NotchGeometry(notch: notch, menuBarBottom: menuBarBottom(of: screen, notchHeight: notch.height), screen: frame)
        }
        guard let main = NSScreen.screens.first else { return nil }
        return simulated(on: main)
    }

    private static func simulated(on screen: NSScreen) -> NotchGeometry? {
        guard simulate else { return nil }
        let frame = screen.frame
        let notch = NSRect(x: frame.midX - 92.5, y: frame.maxY - 32, width: 185, height: 32)
        return NotchGeometry(notch: notch, menuBarBottom: menuBarBottom(of: screen, notchHeight: 32), screen: frame)
    }

    /// The menu bar's bottom on the notch's display: `visibleFrame.maxY` while a menu
    /// bar is showing there; with none (the menu bar hidden, or a secondary display
    /// without one — `visibleFrame.maxY == frame.maxY`) the island hangs straight from
    /// the notch, a notch's height under the top edge.
    private static func menuBarBottom(of screen: NSScreen, notchHeight: CGFloat) -> CGFloat {
        let frame = screen.frame
        let bar = frame.maxY - screen.visibleFrame.maxY
        return frame.maxY - max(bar, notchHeight + 1)
    }

    /// Where a dropped blob counts as "into the dock" (CG, y down): the notch's column
    /// widened by a hand's breadth and reaching 70 pt under the menu bar — the island's
    /// ground. What the drop means is the dropper's: the main blob's is a sleep
    /// (`OrbPanelController.dropIntoDock`), a satellite's is its thread's stop
    /// (`BlobFleet`) — never a sleep. Unchanged by the taller island: drops land on
    /// the notch's column, not the island.
    @MainActor
    static func catchZoneCG(_ g: NotchGeometry) -> CGRect {
        let n = g.notch
        let reach: CGFloat = 70, wing: CGFloat = 48
        let ak = NSRect(x: n.minX - wing, y: g.menuBarBottom - reach, width: n.width + 2 * wing, height: (n.maxY - g.menuBarBottom) + reach)
        return CGSpace.rect(fromAppKit: ak)
    }
}

// MARK: - Content

/// The dock's one input: everything the island, the peek and the lip show that is not
/// the sim's face or the fleet's dots. Built by `OrbPanelController` from the snapshot,
/// the thread store and the mark state; set whole (`NotchDock.setContent`), compared
/// whole. Free mode builds it too, for a later pass to feed the capsule.
struct DockContent: Equatable {
    struct Mark: Equatable {
        var id: String
        var size: CGSize
        var at: Date
        var consumed: Bool
        var isWindow: Bool
        /// "Circled · 640×400 · 14:03 · pending · button "Send" in Slack · 2m"
        var caption: String
        /// `screenshotPath != nil`
        var hasPixels: Bool
        /// Decoded off-main by the controller when the snapshot lands; nil → the skeleton.
        var thumbnail: CGImage?
        static func == (a: Mark, b: Mark) -> Bool {
            a.id == b.id && a.consumed == b.consumed && a.hasPixels == b.hasPixels && (a.thumbnail == nil) == (b.thumbnail == nil)
        }
    }

    struct ThreadRow: Equatable {
        var id: String
        var name: String
        var word: String
        var since: Date?
        var tone: RGB
        var canStop: Bool
        var asks: String?
    }

    struct Question: Equatable {
        var threadId: String
        var name: String
        var text: String
    }

    struct ProblemRow: Equatable {
        var kind: String
        var symbol: String
        var warn: Bool
        var text: String
        var remedyLabel: String?
        /// The remedy's command as JSON text ({type, …}), or nil.
        var remedyJSON: String?
        var openTarget: String?
        /// How many more problems wait behind this one.
        var more: Int
    }

    struct Meter: Equatable {
        var inSession: Bool
        var paused: Bool
        /// The open session's age when the content was built; the view keeps counting.
        var elapsed: TimeInterval?
        var billedSeconds: Double?
        var todaySeconds: Double?
        var sleepsIn: TimeInterval?
    }

    var awake: Bool
    var inSession: Bool
    var typedWakes: Bool
    /// The running delegation's request (S2 while working).
    var request: String?
    /// The last transcript line (S2 otherwise).
    var lastLine: String?
    /// The wake gate's words (S2 asleep).
    var gateLabel: String?
    /// Newest last, as the snapshot carries them.
    var marks: [Mark]
    var question: Question?
    /// Live threads in rail order (the asking one first).
    var threads: [ThreadRow]
    var problem: ProblemRow?
    var meter: Meter
    var marking: Bool
    var screenRecordingGranted: Bool
    var pendingMarks: Int { marks.filter { !$0.consumed }.count }

    static let empty = DockContent(awake: false, inSession: false, typedWakes: false, request: nil, lastLine: nil, gateLabel: nil,
                                   marks: [], question: nil, threads: [], problem: nil,
                                   meter: Meter(inSession: false, paused: false, elapsed: nil, billedSeconds: nil, todaySeconds: nil, sleepsIn: nil),
                                   marking: false, screenRecordingGranted: true)
}

/// The pill slot's tones: `info` a plain word, `warn` grey, `error` red, `mark` the
/// mark tone — and `mark` is the "◎ N circled · Go to ask" slot, which ranks under a toast.
enum PillTone { case info, warn, error, mark }

// MARK: - Dock

/// What the notch shows and does. Owned by `OrbPanelController`; the controller sets
/// `parked` (the blob is in the notch: draw the face and step the sim here), feeds
/// `setContent`, and reads `dockPointCG` / `dropPointCG` for the flights in and out.
@MainActor
final class NotchDock {
    enum Mode: String { case tucked, peek, island }

    let panel: NotchPanel
    let view: NotchView
    private(set) var geometry: NotchGeometry
    private var monitors: [Any] = []
    private var observers: [NSObjectProtocol] = []
    private var contractTimer: Task<Void, Never>?
    private var hovered = false
    /// The island held open by the capsule toggle (a hotkey, a click, the field), not the pointer.
    private var pinned = false
    /// Kevin's pin, folded away for a mark: restored when the mark is over and the blob is home.
    private var pinAfterMark = false
    /// Mark mode is on: the island is folded and the panel lets the mouse through to the overlay.
    private var marking = false
    /// The pointer is on or about the island (its approach zone, or the open island
    /// with its slop), or on the pill: the one time the panel should take the mouse.
    private var pointerNear = false

    /// The blob is in the notch: the face shows and the sim is stepped from here.
    ///
    /// The hand-off is a crossfade, not a pop: flipping this fades the notch's face,
    /// gradient, hairline and the island's content (glyphs included) in or out over
    /// `Motion.base` (the ink itself grows or shrinks on `Motion.island`). Contract with
    /// the blob's tuck (OrbPanelController,
    /// the body slipping up into the notch scaled and fading): the controller sets
    /// `parked = true` at about 60 % of that slip, so this fade-in overlaps the last
    /// 40 % of the vanishing body and there is always one face on screen; on the drop
    /// out it sets `parked = false` as the body appears under the ink, and the notch's
    /// face fades while the body's comes on. Nothing here waits for the other panel.
    /// A pin folded for a mark comes back here, with the blob.
    var parked = false {
        didSet {
            guard parked != oldValue else { return }
            view.parked = parked
            if !parked {
                hovered = false
                pinned = false
                releaseKey(keepText: true)
            } else if pinAfterMark, !marking {
                pinned = true
                pinAfterMark = false
            }
            view.setMode(mode, animated: true)
            view.wake()
            refreshMouseAcceptance()
        }
    }

    /// The panel takes the mouse only where there is something to take it: parked, with
    /// the pointer near the island (or the island held open by the toggle), or while a
    /// drag out of the notch is running through it — and never while Kevin is circling:
    /// the overlay owns the stroke then. Everywhere else — the clear 400×209 pt over the
    /// menu bar and the desktop — it ignores mouse events outright
    /// (`ignoresMouseEvents`), rather than trusting the window server's alpha
    /// pass-through for a layer-backed clear panel. The global mouse-moved monitor sees
    /// the pointer approach while the panel is ignoring events and turns them back on
    /// before a click can land. Never changed mid-drag: the drag's events are owed to
    /// the view that took the mouse-down.
    private func refreshMouseAcceptance() {
        let accept = view.isDragging || (parked && !marking && (pointerNear || pinned))
        if panel.ignoresMouseEvents == accept { panel.ignoresMouseEvents = !accept }
    }

    // Actions, wired by the controller.
    /// The transport (the circle): the controller routes it to `AppState.transportToggle`.
    var togglePause: () -> Void = {}
    var stop: () -> Void = {}
    var toggleMute: () -> Void = {}
    /// The pointer grabbed the face and pulled: (CG point) — the controller takes over the drag.
    var dragOut: (CGPoint) -> Void = { _ in }
    var dragMoved: (CGPoint) -> Void = { _ in }
    var dragEnded: () -> Void = {}
    /// The ◎ box: fold, then mark mode (sends nothing itself — `mark.add` is the overlay's).
    var circle: () -> Void = {}
    /// The ▭ box: the front window as a mark.
    var window: () -> Void = {}
    /// The ? box: ask about what was circled — or circle first.
    var ask: () -> Void = {}
    /// The ⌫ box: forget every mark.
    var clear: () -> Void = {}
    /// Allow / Deny the asking thread's question (its id).
    var allow: (String) -> Void = { _ in }
    var deny: (String) -> Void = { _ in }
    /// The × on one thumbnail (the mark's id); a click on a thumbnail (the Console's lightbox).
    var forgetMark: (String) -> Void = { _ in }
    var openMark: (String) -> Void = { _ in }
    /// A thread chip (its id) and its own small Stop.
    var openThread: (String) -> Void = { _ in }
    var stopThread: (String) -> Void = { _ in }
    var console: () -> Void = {}
    var sleep: () -> Void = {}
    /// The problem pill's remedy box.
    var remedy: (DockContent.ProblemRow) -> Void = { _ in }
    /// Return in the Say field.
    var say: (String) -> Void = { _ in }

    init(sim: BlobSim, geometry: NotchGeometry) {
        self.geometry = geometry
        // The island's first gradient, on the render queue before the first island asks.
        NotchInk.prewarm()
        let frame = geometry.panelFrame
        panel = NotchPanel(contentRect: frame, styleMask: [.nonactivatingPanel, .borderless, .fullSizeContentView], backing: .buffered, defer: false)
        view = NotchView(frame: NSRect(origin: .zero, size: frame.size), sim: sim)
        view.autoresizingMask = [.width, .height]
        panel.contentView = view
        view.geometry = geometry
        view.onPress = { [weak self] which in self?.pressed(which) }
        view.onSay = { [weak self] text in self?.say(text) }
        view.onFieldRelease = { [weak self] keepText in self?.releaseKey(keepText: keepText) }
        view.onDragOut = { [weak self] p in self?.dragOut(p) }
        view.onDragMoved = { [weak self] p in self?.dragMoved(p) }
        view.onDragEnded = { [weak self] in self?.dragEnded() }
        view.onHover = { [weak self] over in self?.pointer(over: over) }
        view.setMode(.tucked, animated: false)
        // Key status left by any other route (a click in another app): the field lets go with it.
        observers.append(NotificationCenter.default.addObserver(forName: NSWindow.didResignKeyNotification, object: panel, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.panel.keyAllowed = false
                self.view.releaseField(keepText: true)
            }
        })
        prewarmInk()
    }

    deinit {
        for m in monitors { NSEvent.removeMonitor(m) }
        for o in observers { NotificationCenter.default.removeObserver(o) }
        contractTimer?.cancel()
    }

    /// The sizes the ink will be asked for first, rendered in the background now: the
    /// open island, the tucked lip, the peek and its breath (2 pt buckets, +0…30) —
    /// so the first open draws exact, never a stretched neighbour.
    private func prewarmInk() {
        let n = geometry.notch.width
        let scale = panel.screen?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2
        var sizes: [CGSize] = [CGSize(width: NotchGeometry.islandWidth, height: NotchGeometry.islandHeight),
                               CGSize(width: n, height: NotchGeometry.lipHeight),
                               CGSize(width: n, height: NotchGeometry.peekHeight)]
        var extra: CGFloat = 2
        while extra <= 30 {
            sizes.append(CGSize(width: n + extra, height: NotchGeometry.peekHeight))
            extra += 2
        }
        NotchInk.Cache.shared.prewarm(sizes: sizes, notchWidth: n, scale: scale)
    }

    /// One press on the island, routed to the controller's closures. The slot indices
    /// the view reports for thumbnails are resolved to mark ids here.
    private func pressed(_ which: NotchView.Press) {
        switch which {
        case .pause: togglePause()
        case .stop: stop()
        case .mute: toggleMute()
        case .face: toggleIsland()
        case .circle: circle()
        case .window: window()
        case .ask: ask()
        case .clear: clear()
        case .allow: if let q = view.content.question { allow(q.threadId) }
        case .deny: if let q = view.content.question { deny(q.threadId) }
        case .mark(let i): if let id = view.markId(atSlot: i) { openMark(id) }
        case .markForget(let i): if let id = view.markId(atSlot: i) { forgetMark(id) }
        case .thread(let id): openThread(id)
        case .threadStop(let id): stopThread(id)
        case .console: console()
        case .sleep: if view.awake { sleep() }
        case .remedy: if let p = view.content.problem { remedy(p) }
        case .field: focusField()
        }
    }

    /// Where the blob parks (CG, y down) on its way in: centred under the notch, its
    /// top under the menu bar, so the fade into the ink reads as slipping up into it.
    var dockPointCG: CGPoint {
        let r = OrbPanelController.collapsedSize.height * 0.36
        return CGSpace.point(fromAppKit: NSPoint(x: geometry.notch.midX, y: geometry.menuBarBottom - r * 0.9 - 2))
    }

    /// Where the blob appears (CG) when it drops out: mostly under the ink and the menu
    /// bar, a hand's breadth higher than the dock, so the hop down is a hop.
    var dropPointCG: CGPoint {
        let r = OrbPanelController.collapsedSize.height * 0.36
        return CGSpace.point(fromAppKit: NSPoint(x: geometry.notch.midX, y: geometry.menuBarBottom - r * 0.35))
    }

    /// Marking folds the island: the peek awake, the lip asleep, whatever the pointer does.
    var mode: Mode {
        if marking { return view.awake ? .peek : .tucked }
        if hovered || pinned { return .island }
        return view.awake ? .peek : .tucked
    }

    func show() {
        panel.setFrame(geometry.panelFrame, display: false)
        pointerNear = false
        refreshMouseAcceptance()
        panel.orderFrontRegardless()
        installMonitors()
        view.wake()
        // Where the pointer already is counts: it may be sitting on the island.
        pointer(at: NSEvent.mouseLocation)
    }

    func hide() {
        removeMonitors()
        contractTimer?.cancel(); contractTimer = nil
        hovered = false
        pinned = false
        pointerNear = false
        releaseKey(keepText: true)
        refreshMouseAcceptance()
        panel.orderOut(nil)
        view.sleepLink()
    }

    var isVisible: Bool { panel.isVisible }

    /// The displays changed: a new geometry (the same notch, moved), or none.
    func apply(geometry g: NotchGeometry) {
        guard g != geometry else { return }
        geometry = g
        view.geometry = g
        panel.setFrame(g.panelFrame, display: true)
        view.setMode(mode, animated: false)
        prewarmInk()
    }

    /// The phase changed under the sim: tucked ↔ peeking.
    func phaseChanged() {
        #if JARHEAD_ORB_PREVIEW
        // ORB_NOTCH_WORKING=1: no daemon feeds a delegation here, so the working state
        // follows the phase — on at thinking / acting, off otherwise — for the shots.
        if Self.previewWorkingFollowsPhase {
            let working = view.currentPhase == .thinking || view.currentPhase == .acting
            view.workingSince = working ? (view.workingSince ?? Date().timeIntervalSince1970) : nil
        }
        #endif
        view.setMode(mode, animated: true)
        view.wake()
    }

    /// The running delegation's start (seconds since 1970), or nil when nothing runs:
    /// the controller sets it from every snapshot (`Snapshot.delegations`, the last
    /// one whose status is running). The island shows "Working · m:ss" while it is set.
    func setWorking(since: Double?) {
        view.workingSince = since
    }

    /// The live spawned threads (`BlobFleet.threadDots`): one 5 pt square each beside
    /// the counter in the peek and on the strip. The island's rows come from `DockContent.threads`.
    func setThreads(_ dots: [ThreadDot]) {
        view.threads = dots
    }

    /// The gate's pill (question, verdict, countdown) under the notch while asleep.
    func setGatePill(_ pill: OrbPill?) {
        view.gatePill = pill
        view.wake()
    }

    /// Everything else the dock shows, in one value.
    func setContent(_ c: DockContent) {
        view.content = c
        view.lastLine = c.lastLine ?? ""
    }

    /// A toast (1.5 s: "Stopped", "Cleared · 3", "Captured Safari · 1280×800"), or —
    /// tone `.mark` — "◎ 1 circled · Go to ask" for 6 s, shown only while tucked.
    func showPill(_ text: String, symbol: String?, tone: PillTone, seconds: Double) {
        view.showPill(text, symbol: symbol, tone: tone, seconds: seconds)
    }

    /// Mark mode begins: a pinned island remembers its pin, folds to the peek (or the
    /// lip), and the panel lets the mouse through to the overlay. The field lets go of key.
    func foldForMark() {
        if pinned { pinAfterMark = true }
        pinned = false
        hovered = false
        marking = true
        contractTimer?.cancel(); contractTimer = nil
        releaseKey(keepText: true)
        view.setMode(mode, animated: true)
        refreshMouseAcceptance()
    }

    /// The controller is about to drop the blob out for a mark's own trace: the pin
    /// folded for the mark (or still held) comes back with the blob, not before.
    func keepPinAcrossTrace() {
        if pinned || pinAfterMark { pinAfterMark = true }
    }

    /// The mark's own trace was cut short and the blob stays out (`MarkHomeRule`
    /// interrupted): the pin folded for the mark is forgotten, so the next `parked` —
    /// the sleep tuck, minutes later — does not pop the island open pinned on its own.
    func dropPinAcrossTrace() {
        pinAfterMark = false
    }

    /// Mark mode ended (a commit, a cancel): the mouse follows the pointer rule again,
    /// and Kevin's pin is restored now if the blob is home, else when it comes home.
    func markEnded() {
        marking = false
        if pinAfterMark, parked {
            pinned = true
            pinAfterMark = false
        }
        view.setMode(mode, animated: true)
        refreshMouseAcceptance()
    }

    /// ⌥⇧Return, or a click on the line: the island pins open and the Say field takes
    /// key — the capsule's discipline: the panel may become key only for the duration
    /// of this `makeKey()`, and gives key back the moment the field lets go (`releaseKey`).
    func focusField() {
        guard parked, !marking else { return }
        pinned = true
        contractTimer?.cancel(); contractTimer = nil
        view.setMode(mode, animated: true)
        refreshMouseAcceptance()
        panel.keyAllowed = true
        panel.makeKey()
        panel.keyAllowed = false
        let phase = view.currentPhase
        let placeholder = ComposerWords.placeholder(phase: phase, paused: phase == .paused, typedWakes: view.content.typedWakes)
        view.focusField(placeholder: placeholder)
    }

    /// Give key status back the moment the field lets go of it, so the next keystroke
    /// lands in whatever Kevin was working in. A non-activating panel has no window of
    /// its own to pass key to: ordering it out returns key to the active app's window,
    /// and ordering it straight back in (regardless, not key) leaves it where it was.
    private func releaseKey(keepText: Bool) {
        panel.keyAllowed = false
        view.releaseField(keepText: keepText)
        guard panel.isKeyWindow else { return }
        panel.orderOut(nil)
        if isVisibleWanted { panel.orderFrontRegardless() }
    }

    /// The panel is meant to be on screen (monitors installed by `show`, not removed by `hide`).
    private var isVisibleWanted: Bool { !monitors.isEmpty }

    /// The capsule toggle in notch mode: the island opens and stays until toggled again
    /// or the pointer leaves it.
    func toggleIsland() {
        guard !marking else { return }
        pinned.toggle()
        if pinned { contractTimer?.cancel(); contractTimer = nil } else { releaseKey(keepText: true) }
        view.setMode(mode, animated: true)
        refreshMouseAcceptance()
    }

    var islandOpen: Bool { mode == .island }

    // MARK: pointer

    /// A global monitor sees the pointer everywhere (mouse-moved needs no Accessibility
    /// grant); the local one covers our own windows. Both feed `pointer(at:)`.
    private func installMonitors() {
        removeMonitors()
        if let m = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged], handler: { [weak self] _ in
            MainActor.assumeIsolated { self?.pointer(at: NSEvent.mouseLocation) }
        }) { monitors.append(m) }
        if let m = NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved], handler: { [weak self] event in
            MainActor.assumeIsolated { self?.pointer(at: NSEvent.mouseLocation) }
            return event
        }) { monitors.append(m) }
    }

    private func removeMonitors() {
        for m in monitors { NSEvent.removeMonitor(m) }
        monitors.removeAll()
    }

    /// The pointer moved (AppKit screen point): entering the island's approach zone
    /// opens it; leaving the open island (with slop) starts the 600 ms contraction.
    /// Either way the panel takes the mouse only while the pointer is about the island
    /// (or on the pill under it). Marking: nothing — the overlay has the pointer.
    private func pointer(at p: NSPoint) {
        #if JARHEAD_ORB_PREVIEW
        // The harness's shots are scripted (`previewHover`); Kevin's own pointer, which
        // may well be sitting under the notch, must not open the island in them.
        if Self.previewIgnoresPointer { return }
        #endif
        guard parked, !marking else { pointerNear = false; refreshMouseAcceptance(); return }
        let island = view.islandScreenRect(in: panel)
        // Approach: within 8 pt of the small island, or in the menu bar over the notch.
        let approach = island.insetBy(dx: -8, dy: -8).union(NSRect(x: geometry.notch.minX, y: geometry.menuBarBottom, width: geometry.notch.width, height: geometry.notch.height + 1))
        let onPill = view.pillScreenRect(in: panel)?.insetBy(dx: -4, dy: -4).contains(p) ?? false
        let withSlop = island.insetBy(dx: -14, dy: -14).contains(p) || onPill
        pointerNear = approach.contains(p) || (hovered && withSlop)
        refreshMouseAcceptance()
        if hovered {
            if !withSlop { pointer(over: false) }
        } else if approach.contains(p) {
            pointer(over: true)
        }
    }

    private func pointer(over: Bool) {
        if over {
            contractTimer?.cancel(); contractTimer = nil
            guard !hovered else { return }
            hovered = true
            view.setMode(mode, animated: true)
        } else {
            guard hovered, contractTimer == nil else { return }
            contractTimer = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 600_000_000)
                guard let self, !Task.isCancelled else { return }
                self.contractTimer = nil
                self.hovered = false
                self.view.setMode(self.mode, animated: true)
                self.refreshMouseAcceptance()
            }
        }
    }

    #if JARHEAD_ORB_PREVIEW
    /// ORB_NOTCH_NO_POINTER=1: the real pointer never opens or closes the island.
    nonisolated(unsafe) static var previewIgnoresPointer = ProcessInfo.processInfo.environment["ORB_NOTCH_NO_POINTER"] == "1"
    /// ORB_NOTCH_HOVER / ORB_NOTCH_PRESSED = pause|stop|mute|circle|window|ask|clear|allow|deny|console|sleep|mark:N|forget:N|thread:ID|threadStop:ID:
    /// draw that island control as hovered / pressed in the harness's shots.
    nonisolated(unsafe) static var previewHoveredButton = ProcessInfo.processInfo.environment["ORB_NOTCH_HOVER"]
    nonisolated(unsafe) static var previewPressedButton = ProcessInfo.processInfo.environment["ORB_NOTCH_PRESSED"]
    /// ORB_NOTCH_WORKING=1: the working state ("Working · 0:12") follows the phase in the harness.
    nonisolated(unsafe) static var previewWorkingFollowsPhase = ProcessInfo.processInfo.environment["ORB_NOTCH_WORKING"] == "1"
    /// Pretend the pointer approached (or left) the island.
    func previewHover(_ over: Bool) { pointer(over: over) }
    var previewMode: String { mode.rawValue }
    var previewPinned: Bool { pinned }
    var previewPinAfterMark: Bool { pinAfterMark }
    var previewMarking: Bool { marking }
    var previewIgnoresMouse: Bool { panel.ignoresMouseEvents }
    /// Press a control by its harness name (`NotchView.Press(previewName:)`); false when no such control is live.
    @discardableResult
    func previewPress(_ name: String) -> Bool {
        guard let p = NotchView.Press(previewName: name) else { return false }
        if p != .face, p != .field, !view.previewIsHittable(p) { return false }
        pressed(p)
        return true
    }
    /// The island's rect (CG), for framing a shot.
    var previewIslandCG: CGRect { CGSpace.rect(fromAppKit: view.islandScreenRect(in: panel)) }
    var previewPanelCG: CGRect { CGSpace.rect(fromAppKit: panel.frame) }
    /// The island's springs (value → target, velocity) and its raw rect this frame, for
    /// the harness's ORB_LEVELS readout: a NaN shows up here as "nan".
    var previewSprings: String { view.previewSpringReadout }
    var previewIslandRaw: NSRect { view.previewIslandRectRaw }
    /// Draw the panel's content into a context whose origin is the panel's bottom-left (AppKit).
    func previewRender(in ctx: CGContext) {
        view.displayIfNeeded()
        CATransaction.flush()
        view.layer?.render(in: ctx)
    }
    #endif
}

// MARK: - Panel

/// Borderless, non-activating, above the menu bar. Clear except for what the view
/// paints; it ignores the mouse outright until the pointer is about the island
/// (`NotchDock.refreshMouseAcceptance`), and then only the island — and the notch
/// itself, which nothing lives behind — takes it (`NotchView.hitTest`). Never key on
/// its own: the Say field is the one exception, and only for the duration of
/// `NotchDock.focusField`'s `makeKey()` (`keyAllowed`).
final class NotchPanel: NSPanel {
    override init(contentRect: NSRect, styleMask style: NSWindow.StyleMask, backing backingStoreType: NSWindow.BackingStoreType, defer flag: Bool) {
        super.init(contentRect: contentRect, styleMask: style, backing: backingStoreType, defer: flag)
        level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.mainMenuWindow)) + 1)
        collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        hidesOnDeactivate = false
        isMovableByWindowBackground = false
        isReleasedWhenClosed = false
        animationBehavior = .none
        isExcludedFromWindowsMenu = true
        acceptsMouseMovedEvents = true
        title = "Jarhead notch"
    }

    /// Open only while `NotchDock.focusField` calls `makeKey()`; false at rest, so a
    /// click on the island never redirects Kevin's keystrokes.
    var keyAllowed = false
    override var canBecomeKey: Bool { keyAllowed }
    override var canBecomeMain: Bool { false }

    /// While key — only ever with the Say field focused — the panel would also answer
    /// ⌘-shortcuts, and our main menu would take ⌘Q for a quit Kevin did not mean.
    /// Editing shortcuts pass; every other ⌘ combination is swallowed.
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if event.modifierFlags.contains(.command) {
            let key = event.charactersIgnoringModifiers?.lowercased() ?? ""
            if !["a", "c", "v", "x", "z"].contains(key) { return true }
        }
        return super.performKeyEquivalent(with: event)
    }
}

/// One island control as an accessibility child: the tooltip is its label, a press is the press.
final class DockAccessibilityElement: NSAccessibilityElement {
    nonisolated(unsafe) var press: () -> Void = {}
    override func accessibilityPerformPress() -> Bool {
        MainActor.assumeIsolated { press() }
        return true
    }
}

// MARK: - View

/// Paints the notch's ink, the island and the face, and runs the notch's own display
/// link: while the blob is parked here the orb panel is hidden and its link paused, so
/// this one steps the shared `BlobSim` (at the sim's own cadence) and animates the
/// island's spring. Flipped: y down, like the field.
@MainActor
final class NotchView: NSView, NSViewToolTipOwner, NotchInkObserver, NSTextFieldDelegate {
    /// The island's controls. `.pause` is the transport — the circle: Go while asleep,
    /// in error or paused, Pause in a session, a stop while connecting (the dock's
    /// `togglePause` → `AppState.transportToggle` decides). `.mark(i)` / `.markForget(i)`
    /// are thumbnail slots, newest first; `.thread(id)` / `.threadStop(id)` a chip on the
    /// threads row and its Stop; `.field` the Say line; `.remedy` the problem pill's box.
    enum Press: Equatable {
        case pause, stop, mute, face, circle, window, ask, clear, allow, deny
        case mark(Int), markForget(Int), thread(String), threadStop(String)
        case console, sleep, remedy, field
    }

    private let sim: BlobSim
    var geometry: NotchGeometry? { didSet { needsDisplay = true } }
    /// See `NotchDock.parked`: the face crossfades over `Motion.base` on a flip.
    var parked = false {
        didSet {
            guard parked != oldValue else { return }
            parkedChangedAt = window == nil ? -1 : CACurrentMediaTime()
            needsDisplay = true
        }
    }
    var gatePill: OrbPill? { didSet { needsDisplay = true } }
    var onPress: ((Press) -> Void)?
    /// Return in the Say field, with its text.
    var onSay: ((String) -> Void)?
    /// The field let go of key (Return, Escape, a click elsewhere): the dock hands key back. `keepText`.
    var onFieldRelease: ((Bool) -> Void)?
    var onDragOut: ((CGPoint) -> Void)?
    var onDragMoved: ((CGPoint) -> Void)?
    var onDragEnded: (() -> Void)?
    var onHover: ((Bool) -> Void)?

    /// The island's target and eased size (pt) and its eased openness (0 small … 1 island).
    private var mode = NotchDock.Mode.tucked
    private var widthSpring = Spring(value: 185)
    private var heightSpring = Spring(value: NotchGeometry.lipHeight)
    private var openSpring = Spring(value: 0)
    private var link: CADisplayLink?
    private var lastTick = 0.0
    private var lastRender = 0.0
    private var idleSince = -1.0
    private var hoveredButton: Press?
    private var pressing: Press?
    private var downPoint: NSPoint?
    private var dragging = false
    private var tracking: NSTrackingArea?

    // The time-based fades (CACurrentMediaTime; < 0 = never / snapped).
    /// When `parked` last flipped: the face crossfades from here over `Motion.base`.
    private var parkedChangedAt = -1.0
    /// The island's content is wanted (parked and the mode is island).
    private var contentShown = false
    /// When the content began appearing / leaving.
    private var contentOpenedAt = -1.0
    private var contentClosedAt = -1.0
    /// The button whose press is still glowing accent, and when it was released.
    private var flashPress: Press?
    private var flashAt = -1.0
    /// The transport circle's diameter.
    static let transportDiameter: CGFloat = 22
    /// The right column's boxes.
    static let boxSize = NSSize(width: 26, height: 24)
    /// A thumbnail on the circled strip.
    static let thumbSize = NSSize(width: 30, height: 22)
    /// The island's content elements, for the stagger: transport, S1, S2, S3, S4, S5 + right column.
    private static let contentElements = 6

    /// The working state: the running delegation's start, seconds since 1970 (the
    /// snapshot's `timings.delegatedAt / 1000`), or nil. Flipping it starts the
    /// counter's fade (`workLevel`) and, with the blob out, grows or shrinks the strip.
    var workingSince: Double? {
        didSet {
            let was = oldValue != nil, now = workingSince != nil
            if was != now {
                workingChangedAt = window == nil ? -1 : CACurrentMediaTime()
                relayoutChips()
                setMode(mode, animated: true)
            } else if workingSince != oldValue {
                needsDisplay = true
            }
        }
    }
    /// When `workingSince` last flipped between nil and a value (< 0: never / snapped).
    private var workingChangedAt = -1.0
    /// The phase, for the harness's working knob (`NotchDock.phaseChanged`) and the field's words.
    var currentPhase: Phase { sim.phase }

    /// Everything the dock shows that is not the face or the fleet's dots (`NotchDock.setContent`).
    /// A change of chips re-lays the peek; anything else redraws. The hit list and the
    /// accessibility children follow.
    var content = DockContent.empty {
        didSet {
            guard content != oldValue else { return }
            contentAt = CACurrentMediaTime()
            let before = chips.map(\.figure)
            relayoutChips()
            if chips.map(\.figure) != before || content.marking != oldValue.marking {
                setMode(mode, animated: true)
            } else {
                needsDisplay = true
            }
            rebuildAccessibility()
            wake()
        }
    }
    /// When `content` last changed (CACurrentMediaTime): the meter's elapsed keeps counting from it.
    private var contentAt = 0.0

    #if JARHEAD_ORB_PREVIEW
    /// The harness's strip probe (`previewStripProbe`): park / work levels forced for
    /// one offscreen draw, and that draw stopping after the strip.
    var previewForcedLevels: (park: CGFloat, work: CGFloat)?
    var previewStripOnly = false
    #endif

    /// The live spawned threads, from the fleet: drawn as one flat 5 pt square each in
    /// the thread's phase colour (the island's language is squares and hairlines)
    /// right of the counter in the peek and on the out-strip. A square becomes the
    /// amber hand while that thread asks and a red × for the failed hold. A change of
    /// count re-lays the island (the peek widens by the dots); a change of status or
    /// clock only redraws. A sleeping Jarhead has no threads: nothing tucked.
    var threads: [ThreadDot] = [] {
        didSet {
            guard threads != oldValue else { return }
            if threads.count != oldValue.count { relayoutChips(); setMode(mode, animated: true) } else { needsDisplay = true }
            wake()
        }
    }
    static let dotSide: CGFloat = 5
    static let dotGap: CGFloat = 3
    /// The dots' run: n squares, n − 1 gaps.
    private var dotsWidth: CGFloat { threads.isEmpty ? 0 : CGFloat(threads.count) * Self.dotSide + CGFloat(threads.count - 1) * Self.dotGap }
    /// What the island grows by for the dots (the run and 8 of padding); 0 without threads.
    private var dotsExtraWidth: CGFloat { threads.isEmpty ? 0 : dotsWidth + 8 }
    /// The dots on the peek: hidden while marking (the hint has the strip).
    private var peekDotsExtraWidth: CGFloat { content.marking ? 0 : dotsExtraWidth }

    /// Reduce Motion, from the one flag the controller keeps in step with the system
    /// setting (`BlobSim.reducedMotion`; the harness's ORB_REDUCE_MOTION sets the same
    /// flag), so the fades, the stagger and the spring agree with the face's own
    /// stillness — never half from `Motion.reduced` and half from the sim.
    private var reduced: Bool { sim.reducedMotion }
    /// `Motion.seconds` on that flag: durations halve under Reduce Motion — and never
    /// reach 0, so no progress here is ever a division by zero.
    private func seconds(_ d: Double) -> Double { max(0.001, reduced ? d / 2 : d) }
    /// `Motion.island`; critically damped under Reduce Motion (its stiffness, no overshoot).
    private var islandSpring: Motion.SpringSpec { reduced ? .of(stiffness: Motion.island.stiffness, ratio: 1) : Motion.island }

    /// The island's symbols, tinted once per (name, size, tint): a dozen a frame while the
    /// island is open would otherwise be a dozen fresh images a frame.
    private static var symbolCache: [String: NSImage] = [:]

    /// A solid SF Symbol at `pointSize` (semibold) in `tint`, cached.
    private static func symbol(_ name: String, pointSize: CGFloat, tint: NSColor) -> NSImage? {
        let key = "\(name)|\(pointSize)|\(tint)"
        if let hit = symbolCache[key] { return hit }
        guard let img = NSImage(systemSymbolName: name, accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: pointSize, weight: .semibold)) else { return nil }
        let tinted = img.tinted(tint)
        symbolCache[key] = tinted
        return tinted
    }

    /// A display-link spring on `Motion.island` (critically damped under Reduce Motion:
    /// the island still grows and shrinks, without the overshoot).
    private struct Spring {
        var value: Double
        /// The target. One that is not a number is refused and the last good one kept.
        var target: Double {
            didSet {
                if target.isFinite { lastGood = target } else { BadNumber.noteOnce("notch spring target", "\(target)"); target = lastGood }
            }
        }
        var velocity = 0.0
        /// The last finite target: where a spring gone bad comes back to.
        private var lastGood: Double
        init(value: Double) { self.value = value; target = value; lastGood = value }
        mutating func step(_ dt: Double, _ spec: Motion.SpringSpec) {
            // A NaN anywhere in a spring is forever otherwise: the acceleration, the
            // velocity and the value all inherit it and `settled` never comes true
            // (`abs(nan) < 0.15` is false), so the island's rect is NaN for the rest of
            // the process. One bad number resets the spring to its target and the
            // island goes on; the display link never stalls on it.
            guard dt.isFinite, value.isFinite, velocity.isFinite else { recover(); return }
            let a = spec.stiffness * (target - value) - spec.damping * velocity
            velocity += a * dt
            value += velocity * dt
            if !value.isFinite || !velocity.isFinite { recover() }
        }
        var settled: Bool { abs(target - value) < 0.15 && abs(velocity) < 2 }
        mutating func snap() { value = target; velocity = 0 }
        /// Back at the (finite) target, still. Logged once.
        mutating func recover() {
            BadNumber.noteOnce("notch spring", "value \(value) velocity \(velocity) target \(target)")
            if !target.isFinite { target = lastGood }
            value = target
            velocity = 0
        }
    }

    // MARK: fonts and attributes

    /// The island's fonts and attribute sets, made once and kept for the life of the
    /// process: no font lookups per frame, and a font this view holds cannot be torn
    /// down under the typesetter — the 22:39 report of 2026-09-11 had CoreText's
    /// shaping thread in `TFont::~TFont` while the main thread was applying a font to
    /// these words. Colours to the value: the words must not change.
    private static let phaseFont = NSFont.systemFont(ofSize: 12, weight: .medium)
    private static let lineFont = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
    private static let pillFont = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular)
    private static let wordFont = NSFont.systemFont(ofSize: 11, weight: .medium)
    private static let lipFont = NSFont.monospacedDigitSystemFont(ofSize: 9, weight: .regular)
    private static let truncating: NSParagraphStyle = {
        let s = NSMutableParagraphStyle()
        s.lineBreakMode = .byTruncatingTail
        return s.copy() as! NSParagraphStyle
    }()
    private static let phaseAttrs: [NSAttributedString.Key: Any] = [.font: phaseFont, .foregroundColor: NSColor.white]
    private static let phaseShadow: [NSAttributedString.Key: Any] = [.font: phaseFont, .foregroundColor: NSColor(white: 0, alpha: 0.6)]
    private static let lineAttrs: [NSAttributedString.Key: Any] = [.font: lineFont, .foregroundColor: NSColor.white.withAlphaComponent(0.78), .paragraphStyle: truncating]
    private static let lineAttrsEmpty: [NSAttributedString.Key: Any] = [.font: lineFont, .foregroundColor: NSColor.white.withAlphaComponent(0.46), .paragraphStyle: truncating]
    private static let lineShadow: [NSAttributedString.Key: Any] = [.font: lineFont, .foregroundColor: NSColor(white: 0, alpha: 0.55), .paragraphStyle: truncating]
    private static let pillAttrs: [NSAttributedString.Key: Any] = [.font: pillFont, .foregroundColor: NSColor(white: 1, alpha: 0.72)]
    private static let pillAttrsTruncating: [NSAttributedString.Key: Any] = [.font: pillFont, .foregroundColor: NSColor(white: 1, alpha: 0.72), .paragraphStyle: truncating]
    /// "Working · 0:12": mono digits (the meter's font), the 0.72 step, an ink shadow under it.
    private static let workAttrs: [NSAttributedString.Key: Any] = [.font: pillFont, .foregroundColor: NSColor(white: 1, alpha: 0.72)]
    private static let workShadow: [NSAttributedString.Key: Any] = [.font: pillFont, .foregroundColor: NSColor(white: 0, alpha: 0.55)]
    /// The threads row and the foot: the counter's mono at the same step, truncating at the row's end.
    private static let threadAttrs: [NSAttributedString.Key: Any] = [.font: pillFont, .foregroundColor: NSColor(white: 1, alpha: 0.72), .paragraphStyle: truncating]
    private static let threadShadow: [NSAttributedString.Key: Any] = [.font: pillFont, .foregroundColor: NSColor(white: 0, alpha: 0.55), .paragraphStyle: truncating]
    /// The paused foot, a step dimmer.
    private static let footPausedAttrs: [NSAttributedString.Key: Any] = [.font: pillFont, .foregroundColor: NSColor(white: 1, alpha: 0.48), .paragraphStyle: truncating]
    /// The hints on the context row ("Circle something · ⌥⇧C"), at the empty step.
    private static let hintAttrs: [NSAttributedString.Key: Any] = [.font: lineFont, .foregroundColor: NSColor(white: 1, alpha: 0.46), .paragraphStyle: truncating]
    /// The mono "+3" in a thumbnail slot.
    private static let overflowAttrs: [NSAttributedString.Key: Any] = [.font: pillFont, .foregroundColor: NSColor(white: 1, alpha: 0.72)]
    /// Allow / Deny and the remedy box: 11 medium.
    private static let wordAttrs: [NSAttributedString.Key: Any] = [.font: wordFont, .foregroundColor: NSColor(white: 1, alpha: 0.92)]
    /// The mark-landed pill's words, the meter's mono in the mark tone.
    private static let markPillAttrs: [NSAttributedString.Key: Any] = [.font: pillFont, .foregroundColor: markTone]
    /// The lip's marks chip figure, 9 mono-digit in the mark tone.
    private static let lipChipAttrs: [NSAttributedString.Key: Any] = [.font: lipFont, .foregroundColor: markTone]
    /// The counter's widest plausible text, measured once: the peek widens by this plus
    /// padding while working, so the island never re-lays itself as the digits roll.
    private static let workTextWidth: CGFloat = textWidth("Working · 00:00" as NSString, workAttrs)
    /// What the peek island grows by while working (the counter, a gap from the face,
    /// padding); the thread dots add `dotsExtraWidth` on top, the chips `chipsExtraWidth`.
    private static var workExtraWidth: CGFloat { workTextWidth > 0 ? workTextWidth + 18 : 0 }

    /// The mark tone (`OverlayAnnotations` `mark`): the circled count, the amber hand, a
    /// pending thumbnail's frame, the lip's glow while marks wait.
    static let markTone = NSColor(srgbRed: 0xff / 255, green: 0xb4 / 255, blue: 0x54 / 255, alpha: 1)
    static let markToneRGB = RGB(hex: 0xffb454)
    /// The error red (`OrbPalette.error`), for a problem that is not a missing grant.
    private static let errorTone = NSColor(srgbRed: OrbPalette.error.r, green: OrbPalette.error.g, blue: OrbPalette.error.b, alpha: 1)
    /// The accent, for a press.
    private static let accent = NSColor(srgbRed: 0x5b / 255, green: 0x82 / 255, blue: 0xff / 255, alpha: 1)

    /// Three of the eight crashes of 2026-09-11 were `NSString.draw` on the island →
    /// CoreText `TAttributes::ApplyFont` → "attempt to insert nil object", on ordinary
    /// ASCII lines with finite geometry (an OS-side font-lifetime race, as far as the
    /// reports show). Once the typesetter has raised, the words stay off until relaunch:
    /// the island keeps its face, its ink and its buttons.
    private static var textDrawFailed = false

    /// Every text draw on the island goes through here and nowhere else: nothing goes
    /// to CoreText for a rect that is not finite and positive, and — in the app, where
    /// the `JarheadObjC` shim is built — an NSException out of the typesetter is caught
    /// and logged instead of aborting the process. The harness (raw swiftc, no shim)
    /// draws directly.
    private static func drawText(_ text: NSString, in rect: NSRect, _ attrs: [NSAttributedString.Key: Any]) {
        guard !textDrawFailed else { return }
        guard rect.isFiniteRect, rect.width > 0, rect.height > 0 else { BadNumber.noteOnce("notch text rect", "\(rect)"); return }
        typeset("draw(in:)") { text.draw(in: rect, withAttributes: attrs) }
    }

    private static func drawText(_ text: NSString, at point: NSPoint, _ attrs: [NSAttributedString.Key: Any]) {
        guard !textDrawFailed else { return }
        guard point.isFinitePoint else { BadNumber.noteOnce("notch text point", "\(point)"); return }
        typeset("draw(at:)") { text.draw(at: point, withAttributes: attrs) }
    }

    /// A measured width, 0 once the typesetter has raised.
    private static func textWidth(_ text: NSString, _ attrs: [NSAttributedString.Key: Any]) -> CGFloat {
        guard !textDrawFailed else { return 0 }
        var w: CGFloat = 0
        typeset("size(withAttributes:)") { w = text.size(withAttributes: attrs).width }
        return w.isFinite ? w : 0
    }

    private static func typeset(_ what: String, _ body: () -> Void) {
        #if canImport(JarheadObjC)
        do {
            try objcTry(body)
        } catch {
            textDrawFailed = true
            NSLog("Jarhead: the notch island's %@ raised %@ — the island's words are off until relaunch", what, "\(error)")
        }
        #else
        body()
        #endif
    }

    /// A word with its one-pixel ink shadow under it, so it reads where the gradient runs light.
    private static func drawShadowed(_ text: NSString, in rect: NSRect, _ attrs: [NSAttributedString.Key: Any], shadow: [NSAttributedString.Key: Any]) {
        drawText(text, in: rect.offsetBy(dx: 0, dy: 1), shadow)
        drawText(text, in: rect, attrs)
    }

    // MARK: the Say field

    /// One line, 12 pt SF Pro, no bezel: the view draws its hairline at rest and the
    /// accent ring while it has key; hidden unless focused. Return → `onSay`, the text
    /// clearing unless the engine will refuse it (`ComposerWords.keepsText`); Escape
    /// keeps the text. Return never answers a thread's question: Allow and Deny are clicks.
    private let field = NSTextField(frame: .zero)
    private(set) var fieldFocused = false

    private func makeField() {
        field.isBordered = false
        field.isBezeled = false
        field.drawsBackground = false
        field.focusRingType = .none
        field.font = NSFont.systemFont(ofSize: 12)
        field.textColor = .white
        field.lineBreakMode = .byTruncatingTail
        field.usesSingleLineMode = true
        field.cell?.isScrollable = true
        field.cell?.wraps = false
        field.delegate = self
        field.isHidden = true
        field.setAccessibilityLabel("Type to Jarhead")
        addSubview(field)
    }

    /// The field takes key (the panel is key already, `NotchDock.focusField`).
    func focusField(placeholder: String) {
        guard let w = window else { return }
        fieldFocused = true
        field.placeholderAttributedString = NSAttributedString(string: placeholder, attributes: [.font: NSFont.systemFont(ofSize: 12), .foregroundColor: NSColor(white: 1, alpha: 0.46)])
        layoutField()
        field.isHidden = false
        w.makeFirstResponder(field)
        rebuildAccessibility()
        needsDisplay = true
        wake()
    }

    /// The field lets go (Return, Escape, a click elsewhere, a fold, the blob leaving). Idempotent.
    func releaseField(keepText: Bool) {
        guard fieldFocused else { return }
        fieldFocused = false
        if !keepText { field.stringValue = "" }
        field.isHidden = true
        if window?.firstResponder === field.currentEditor() || window?.firstResponder === field { window?.makeFirstResponder(nil) }
        rebuildAccessibility()
        needsDisplay = true
        wake()
    }

    private func layoutField() {
        let l = islandLayout(in: islandOpenRect)
        guard l.isFinite else { return }
        field.frame = l.line.insetBy(dx: 4, dy: 1)
    }

    /// `NSTextFieldDelegate`'s requirement is not main-actor in the SDK; AppKit asks on
    /// the main thread, so the isolation is assumed rather than inherited.
    nonisolated func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        MainActor.assumeIsolated {
            if selector == #selector(NSResponder.insertNewline(_:)) {
                sayFromField()
                return true
            }
            if selector == #selector(NSResponder.cancelOperation(_:)) {
                releaseField(keepText: true)
                onFieldRelease?(true)
                return true
            }
            return false
        }
    }

    /// Return: the line goes to `say`; the text clears unless the engine will refuse it
    /// (asleep, typed wakes off — it stays for the next Go); key goes back either way.
    private func sayFromField() {
        let text = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let keeps = ComposerWords.keepsText(phase: sim.phase, typedWakes: content.typedWakes)
        if !text.isEmpty { onSay?(text) }
        releaseField(keepText: keeps)
        onFieldRelease?(keeps)
    }

    // MARK: init

    init(frame: NSRect, sim: BlobSim) {
        self.sim = sim
        super.init(frame: frame)
        wantsLayer = true
        layerContentsRedrawPolicy = .onSetNeedsDisplay
        layer?.backgroundColor = .clear
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("Jarhead, in the notch")
        NotchInk.Cache.shared.addObserver(self)
        makeField()
        // The island's fonts exist from here on, long before the first island opens.
        _ = Self.phaseAttrs; _ = Self.lineAttrs; _ = Self.lineAttrsEmpty; _ = Self.pillAttrs; _ = Self.workAttrs; _ = Self.workTextWidth
        _ = Self.wordAttrs; _ = Self.hintAttrs; _ = Self.lipChipAttrs; _ = Self.footPausedAttrs
    }

    required init?(coder: NSCoder) { fatalError("NotchView is code-only") }

    /// A gradient image landed (rendered in the background): draw it.
    func notchInkRendered() { wake() }

    override var isFlipped: Bool { true }

    /// Awake: the phase is not asleep (the gate faces belong to the tucked lip).
    var awake: Bool { sim.phase != .asleep }

    /// Mute has something to mute only with a session open (`AppState.inSessionPhases`).
    private var muteEnabled: Bool { AppState.inSessionPhases.contains(sim.phase) }

    /// Ask sends a line: asleep it is refused unless typed lines wake (and then it is billed).
    private var askEnabled: Bool { awake || content.typedWakes }

    // MARK: geometry

    /// The notch in view coordinates (flipped).
    private var notchRect: NSRect {
        guard let g = geometry, let w = window else { return .zero }
        let f = w.frame
        return NSRect(x: g.notch.minX - f.minX, y: 0, width: g.notch.width, height: g.notch.height)
    }

    /// The menu bar's bottom edge in view coordinates: the island's top.
    private var barBottom: CGFloat {
        guard let g = geometry, let w = window else { return 33 }
        return w.frame.maxY - g.menuBarBottom
    }

    /// The island as drawn this frame, view coordinates.
    private var islandRect: NSRect {
        let n = notchRect
        let w = CGFloat(widthSpring.value), h = CGFloat(heightSpring.value)
        return NSRect(x: n.midX - w / 2, y: barBottom, width: w, height: h)
    }

    /// The open island's rect (view coordinates): the content is laid out in it and
    /// revealed by the ink as the spring opens, so nothing re-truncates or slides.
    private var islandOpenRect: NSRect {
        let n = notchRect
        return NSRect(x: n.midX - NotchGeometry.islandWidth / 2, y: barBottom, width: NotchGeometry.islandWidth, height: NotchGeometry.islandHeight)
    }

    /// The island in screen coordinates (AppKit), for the pointer.
    func islandScreenRect(in panel: NSWindow) -> NSRect {
        let r = islandRect
        let f = panel.frame
        return NSRect(x: f.minX + r.minX, y: f.maxY - r.maxY, width: r.width, height: r.height)
    }

    /// The pill slot as drawn this frame, screen coordinates (AppKit); nil without a pill.
    func pillScreenRect(in panel: NSWindow) -> NSRect? {
        guard let r = pillRect else { return nil }
        let f = panel.frame
        return NSRect(x: f.minX + r.minX, y: f.maxY - r.maxY, width: r.width, height: r.height)
    }

    /// Set the island's size for a mode, sprung (or snapped when not animated). With
    /// the blob out (not parked) the island shrinks away to nothing: it left. The
    /// content's fade clock starts here.
    func setMode(_ m: NotchDock.Mode, animated: Bool) {
        mode = m
        let n = geometry?.notch.width ?? 185
        if !parked {
            // The blob is out. Working — or with threads live — the notch keeps a quiet
            // strip of peek height with the counter and the thread dots on it (the face
            // is on the body at its target); otherwise the island shrinks away to
            // nothing: it left.
            let strip = workingSince != nil || !threads.isEmpty
            widthSpring.target = strip ? n + (workingSince != nil ? Self.workExtraWidth : 0) + dotsExtraWidth : n
            heightSpring.target = strip ? NotchGeometry.peekHeight : 0
            openSpring.target = 0
        } else {
            switch m {
            case .tucked:
                widthSpring.target = n
                heightSpring.target = NotchGeometry.lipHeight
                openSpring.target = 0
            case .peek:
                // Never past the island's width: the chips drop from the right first (`relayoutChips`), and what still does not fit is not drawn.
                widthSpring.target = min(NotchGeometry.islandWidth, n + (workingSince != nil ? Self.workExtraWidth : 0) + peekDotsExtraWidth + chipsExtraWidth)
                heightSpring.target = NotchGeometry.peekHeight
                openSpring.target = 0
            case .island:
                widthSpring.target = NotchGeometry.islandWidth
                heightSpring.target = NotchGeometry.islandHeight
                openSpring.target = 1
            }
        }
        let wantsContent = parked && m == .island
        if wantsContent != contentShown {
            contentShown = wantsContent
            if animated, window != nil {
                if wantsContent { contentOpenedAt = CACurrentMediaTime() } else { contentClosedAt = CACurrentMediaTime() }
            } else {
                contentOpenedAt = -1; contentClosedAt = -1
            }
            rebuildAccessibility()
        }
        if !animated {
            widthSpring.snap(); heightSpring.snap(); openSpring.snap()
        }
        if m != .island {
            hoveredButton = nil
            if fieldFocused { releaseField(keepText: true); onFieldRelease?(true) }
        }
        layoutField()
        wake()
    }

    // MARK: display link

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if let tracking { removeTrackingArea(tracking) }
        let t = NSTrackingArea(rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self, userInfo: nil)
        addTrackingArea(t)
        tracking = t
        installToolTip()
        guard window != nil, link == nil else { return }
        let l = displayLink(target: self, selector: #selector(onFrame(_:)))
        l.add(to: .main, forMode: .common)
        link = l
        wake()
    }

    /// Something changed: make sure frames flow.
    func wake() {
        idleSince = -1
        guard let link, window != nil else { needsDisplay = true; return }
        if link.isPaused { lastTick = 0; link.isPaused = false }
        needsDisplay = true
    }

    /// The panel is ordered out: no frames at all.
    func sleepLink() {
        link?.isPaused = true
        lastTick = 0
    }

    private var springsSettled: Bool { widthSpring.settled && heightSpring.settled && openSpring.settled }

    /// Something time-based is mid-flight: the springs, a crossfade, the content's
    /// stagger, a press glow, a pill on its way out.
    private func isAnimating(_ now: Double) -> Bool {
        if !springsSettled { return true }
        let base = seconds(Motion.base)
        if parkedChangedAt >= 0, now - parkedChangedAt < base { return true }
        if contentShown, contentOpenedAt >= 0, now - contentOpenedAt < base + Double(Self.contentElements - 1) * Motion.stagger { return true }
        if !contentShown, contentClosedAt >= 0, now - contentClosedAt < seconds(Motion.quick) { return true }
        if flashPress != nil, now - flashAt < base { return true }
        if workingChangedAt >= 0, now - workingChangedAt < base { return true }
        return false
    }

    /// How present the working counter is: 1 working, 0 not, crossfading over
    /// `Motion.base` (`Motion.easeOut` in, `Motion.easeIn` out) from the last flip.
    private func workLevel(_ now: Double) -> CGFloat {
        let working = workingSince != nil
        if workingChangedAt < 0 { return working ? 1 : 0 }
        let t = finite01((now - workingChangedAt) / seconds(Motion.base))
        return CGFloat(working ? Motion.easeOutCurve.value(at: t) : 1 - Motion.easeInCurve.value(at: t))
    }

    /// "Working · 0:12" — the elapsed since the delegation began, mono digits.
    private func workingText() -> NSString {
        guard let since = workingSince else { return "" }
        let elapsed = Date().timeIntervalSince1970 - since
        return ("Working · " + OrbStyle.mmss(elapsed.isFinite ? max(0, elapsed) : 0)) as NSString
    }

    /// Something rolls or pulses on the island: the counters, the hand, a live pill's expiry.
    private var ticking: Bool {
        if workingSince != nil || !threads.isEmpty { return true }
        if parked, mode == .island, (content.meter.inSession || !content.threads.isEmpty) { return true }
        if parked, content.question != nil, !reduced { return true }
        if toastPill != nil || markLandedPill != nil { return true }
        if let until = gatePill?.until, until.timeIntervalSinceNow > 0 { return true }
        return false
    }

    @objc private func onFrame(_ link: CADisplayLink) {
        let now = CACurrentMediaTime()
        if lastTick == 0 { lastTick = now; lastRender = 0 }
        let dt = min(0.1, now - lastTick)
        lastTick = now
        // Peeking, the island breathes with the sound: up to 30 pt wider on the eased
        // level (the spring smooths it into a pulse; `draw` brightens the hairline with
        // it). Not under reduce motion, where the island holds its size.
        if parked, mode == .peek, let n = geometry?.notch.width {
            // Working, the peek also carries the counter right of the face: room for it,
            // eased in; then the thread dots, then the chips.
            widthSpring.target = min(Double(NotchGeometry.islandWidth), Double(n) + (sim.reducedMotion ? 0 : 30 * finite01(sim.islandLevel)) + Double(Self.workExtraWidth * workLevel(now) + peekDotsExtraWidth + chipsExtraWidth))
        }
        if !springsSettled {
            let step = min(dt, 1.0 / 30)
            let spec = islandSpring
            widthSpring.step(step, spec); heightSpring.step(step, spec); openSpring.step(step, spec)
            if springsSettled { widthSpring.snap(); heightSpring.snap(); openSpring.snap() }
        }
        let animating = isAnimating(now)
        // The shared sim is stepped here only while the blob is parked (the field's
        // own link is paused then); at the sim's cadence, so a parked blob costs what
        // a resting blob costs.
        let wantRate = animating ? 60.0 : (parked ? max(10, sim.desiredFPS) : 10)
        if now - lastRender >= 1 / wantRate - 0.002 {
            if parked { sim.step(now - max(lastRender, now - 0.1)) }
            lastRender = now
            needsDisplay = true
        }
        expirePills(now)
        // Working counts as busy (the counter rolls once a second, at the idle rate); so do live threads (their m:ss roll too).
        let busy = animating || (parked && !sim.isStatic) || (parked && sim.rawLevelsActive) || ticking
        if busy {
            idleSince = -1
        } else if idleSince < 0 {
            idleSince = now
        } else if now - idleSince > 0.6 {
            link.isPaused = true
            lastTick = 0
        }
    }

    // MARK: fades

    /// How present the notch's face is: 1 parked, 0 out, crossfading over `Motion.base`
    /// (`Motion.easeOut` in, `Motion.easeIn` out) from the last flip.
    private func parkLevel(_ now: Double) -> CGFloat {
        guard parkedChangedAt >= 0 else { return parked ? 1 : 0 }
        let t = finite01((now - parkedChangedAt) / seconds(Motion.base))
        return CGFloat(parked ? Motion.easeOutCurve.value(at: t) : 1 - Motion.easeInCurve.value(at: t))
    }

    /// The island content's element `i` (0 the transport, 1 the head row, 2 the line, 3
    /// the context row, 4 the threads row, 5 the foot and the right column): its alpha
    /// and rise (pt, + is down) this frame — appearing over `Motion.base` on
    /// `Motion.easeOut`, from 6 pt below, `Motion.stagger` after the one before (a plain
    /// fade, together, under Reduce Motion); leaving over `Motion.quick` on
    /// `Motion.easeIn`, drifting 4 pt up into the bar. Nil: not drawn.
    private func contentAppearance(_ i: Int, now: Double) -> (alpha: CGFloat, dy: CGFloat)? {
        if contentShown {
            guard contentOpenedAt >= 0 else { return (1, 0) }
            let delay = reduced ? 0 : Double(i) * Motion.stagger
            let t = finite01((now - contentOpenedAt - delay) / seconds(Motion.base))
            let e = Motion.easeOutCurve.value(at: t)
            return (CGFloat(e), reduced ? 0 : CGFloat(6 * (1 - e)))
        }
        guard contentClosedAt >= 0 else { return nil }
        let t = finite01((now - contentClosedAt) / seconds(Motion.quick))
        if t >= 1 { return nil }
        let e = Motion.easeInCurve.value(at: t)
        return (CGFloat(1 - e), reduced ? 0 : CGFloat(-4 * e))
    }

    /// The accent left on a button after its press: full at the release, gone
    /// `Motion.base` later on `Motion.easeIn` (held, then let go).
    private func flashLevel(_ which: Press, now: Double) -> CGFloat {
        guard flashPress == which, flashAt >= 0 else { return 0 }
        let t = finite01((now - flashAt) / seconds(Motion.base))
        return CGFloat(1 - Motion.easeInCurve.value(at: t))
    }

    /// The hand's pulse: 0…1 over `Motion.pulse`, held at 0.5 under Reduce Motion.
    private func pulse(_ now: Double) -> CGFloat {
        if reduced { return 0.5 }
        return CGFloat(finite01(0.5 + 0.5 * sin(2 * .pi * now / Motion.pulse)))
    }

    // MARK: layout

    /// The face's place this frame: sliding from the island's centre (tucked, peek) to
    /// its left end (island) with `open`, growing a little on the way.
    private struct FaceLayout {
        let centre: CGPoint
        let size: Double
        let gap: CGFloat
        /// Where the face ends, for what follows it.
        var right: CGFloat { centre.x + gap / 2 + CGFloat(size) * 0.6 }
    }

    /// `shift` moves the small island's face (peek, tucked) sideways — while working the
    /// face gives half the counter's width so face + counter stay centred under the notch.
    /// Open, the face sits on the head row (y 19), not the island's middle.
    private func faceLayout(island: NSRect, open: CGFloat, lipFace: Bool, shift: CGFloat = 0) -> FaceLayout {
        let size = (lipFace ? BlobSim.eyeSizePt * 0.85 : BlobSim.eyeSizePt) * Double(1 + 0.45 * open)
        let gap = CGFloat(size) * 0.95
        let x = island.minX + (island.width / 2) * (1 - open) + (14 + gap + 10) * open + (shift.isFinite ? shift : 0) * (1 - open)
        let y = island.minY + (island.height / 2) * (1 - open) + 19 * open + (lipFace ? -1 : 0)
        return FaceLayout(centre: CGPoint(x: x, y: y), size: size, gap: gap)
    }

    /// The open island's rows and boxes, laid out in `island` (the open rect): x from
    /// the island's left edge, y from its top, fixed — nothing reflows as content comes
    /// and goes. The pixel budget:
    ///
    ///   S1 head     y 8–30     the transport after the face, the phase word, the counter · text ends at 276
    ///   S2 line     y 34–54    x 110…346
    ///   S3 context  y 58–86    Circle 110–136, Window 140–166 (y 60–84); thumbs 30×22 at x 174/210/246 (y 61–83)
    ///   S4 threads  y 90–104   x 110…276
    ///   S5 foot     y 108–124  x 110…276
    ///   R1 / R2 / R3   26×24 boxes at x 288–314 and 320–346, y 7–31 / 60–84 / 102–126
    ///   Allow / Deny   44×24 ghost boxes at x 252–296 and 302–346, y 60–84 (in R2's place)
    private struct IslandLayout {
        let transport: NSRect
        let head: NSRect
        let line: NSRect
        let context: NSRect
        let circle: NSRect
        let window: NSRect
        /// Three thumbnail slots.
        let thumbs: [NSRect]
        let threads: NSRect
        let foot: NSRect
        let stop: NSRect
        let mute: NSRect
        let ask: NSRect
        let clear: NSRect
        let allow: NSRect
        let deny: NSRect
        let console: NSRect
        let sleep: NSRect
        /// Every rect a number: the only layout that reaches a draw.
        var isFinite: Bool {
            let rects = [transport, head, line, context, circle, window, threads, foot, stop, mute, ask, clear, allow, deny, console, sleep] + thumbs
            return rects.allSatisfy { $0.isFiniteRect }
        }
    }

    private func islandLayout(in island: NSRect) -> IslandLayout {
        let face = faceLayout(island: island, open: 1, lipFace: false)
        let d = Self.transportDiameter
        let x0 = island.minX, y0 = island.minY
        let box = Self.boxSize
        let transport = NSRect(x: face.right + 6, y: y0 + 8, width: d, height: d)
        let textEnd = x0 + 276
        let headLeft = transport.maxX + 8
        let head = NSRect(x: headLeft, y: y0 + 8, width: max(20, textEnd - headLeft), height: 22)
        let line = NSRect(x: x0 + 110, y: y0 + 34, width: 236, height: 20)
        let context = NSRect(x: x0 + 110, y: y0 + 58, width: 166, height: 28)
        let circle = NSRect(x: x0 + 110, y: y0 + 60, width: box.width, height: box.height)
        let window = NSRect(x: x0 + 140, y: y0 + 60, width: box.width, height: box.height)
        let thumbs = [174, 210, 246].map { NSRect(x: x0 + CGFloat($0), y: y0 + 61, width: Self.thumbSize.width, height: Self.thumbSize.height) }
        let threads = NSRect(x: x0 + 110, y: y0 + 90, width: 166, height: 14)
        let foot = NSRect(x: x0 + 110, y: y0 + 108, width: 166, height: 16)
        let col1 = x0 + 288, col2 = x0 + 320
        let stop = NSRect(x: col1, y: y0 + 7, width: box.width, height: box.height)
        let mute = NSRect(x: col2, y: y0 + 7, width: box.width, height: box.height)
        let ask = NSRect(x: col1, y: y0 + 60, width: box.width, height: box.height)
        let clear = NSRect(x: col2, y: y0 + 60, width: box.width, height: box.height)
        let allow = NSRect(x: x0 + 252, y: y0 + 60, width: 44, height: box.height)
        let deny = NSRect(x: x0 + 302, y: y0 + 60, width: 44, height: box.height)
        let console = NSRect(x: col1, y: y0 + 102, width: box.width, height: box.height)
        let sleep = NSRect(x: col2, y: y0 + 102, width: box.width, height: box.height)
        return IslandLayout(transport: transport, head: head, line: line, context: context, circle: circle, window: window, thumbs: thumbs,
                            threads: threads, foot: foot, stop: stop, mute: mute, ask: ask, clear: clear, allow: allow, deny: deny, console: console, sleep: sleep)
    }

    /// The circled strip's slots this frame: marks newest first, at most three (two
    /// while a question waits — Allow and Deny take the room); past that the newest
    /// fill all but the last slot and the last reads "+n".
    private struct ThumbSlot {
        let index: Int
        let rect: NSRect
        let mark: DockContent.Mark
    }

    private func thumbSlots(_ l: IslandLayout) -> (slots: [ThumbSlot], overflow: (rect: NSRect, count: Int)?) {
        let shown = Array(content.marks.reversed())
        let room = content.question == nil ? 3 : 2
        guard !shown.isEmpty else { return ([], nil) }
        if shown.count <= room {
            return (shown.enumerated().map { ThumbSlot(index: $0.offset, rect: l.thumbs[$0.offset], mark: $0.element) }, nil)
        }
        let keep = room - 1
        let slots = shown.prefix(keep).enumerated().map { ThumbSlot(index: $0.offset, rect: l.thumbs[$0.offset], mark: $0.element) }
        return (slots, (l.thumbs[keep], shown.count - keep))
    }

    /// The mark shown in thumbnail slot `i` (newest first), for the dock's press routing.
    func markId(atSlot i: Int) -> String? {
        let shown = Array(content.marks.reversed())
        return i >= 0 && i < shown.count ? shown[i].id : nil
    }

    /// The × on a thumbnail: 12×12 at its top-right corner.
    private static func forgetRect(_ thumb: NSRect) -> NSRect {
        NSRect(x: thumb.maxX - 9, y: thumb.minY - 3, width: 12, height: 12)
    }

    /// One thread chip on S4: its text rect and, when it can be stopped, its Stop glyph's hit rect (16×14).
    private struct ThreadChip {
        let row: DockContent.ThreadRow
        let text: NSString
        let rect: NSRect
        let stop: NSRect?
    }

    private func threadChips(_ l: IslandLayout, now: Date) -> [ThreadChip] {
        var out: [ThreadChip] = []
        var x = l.threads.minX
        let end = l.threads.maxX
        let sepWidth = Self.textWidth(" | " as NSString, Self.threadAttrs)
        for (i, row) in content.threads.enumerated() {
            if i > 0 { x += sepWidth }
            // The Stop's 20 pt are reserved before the words truncate; a chip that cannot
            // get 30 pt of words is not started (the row ends at 276).
            let stopRoom: CGFloat = row.canStop ? 20 : 0
            guard end - x - stopRoom >= 30 else { break }
            var text = row.name + " · " + row.word
            if let since = row.since {
                let elapsed = now.timeIntervalSince(since)
                text += " · " + OrbStyle.mmss(elapsed.isFinite ? max(0, elapsed) : 0)
            }
            let ns = text as NSString
            let w = min(Self.textWidth(ns, Self.threadAttrs) + 1, end - x - stopRoom)
            let rect = NSRect(x: x, y: l.threads.minY, width: w, height: l.threads.height)
            x += w
            var stop: NSRect?
            if row.canStop {
                stop = NSRect(x: x + 4, y: l.threads.minY, width: 16, height: 14)
                x += 20
            }
            out.append(ThreadChip(row: row, text: ns, rect: rect, stop: stop))
            if x >= end { break }
        }
        return out
    }

    /// The remedy box on the problem pill, as drawn this frame (view coordinates); nil without one.
    private var remedyRect: NSRect?
    /// The pill slot as drawn this frame (view coordinates); nil without a pill.
    private(set) var pillRect: NSRect?

    /// The island's live controls and where they are (the open island's layout):
    /// hit-testing, hover, tooltips, presses and the accessibility children all read
    /// this one list. The smallest targets come first so a corner wins over its thumb.
    private func buttonRects(in island: NSRect) -> [(Press, NSRect)] {
        let l = islandLayout(in: island)
        var out: [(Press, NSRect)] = [(.pause, l.transport), (.stop, l.stop)]
        if muteEnabled { out.append((.mute, l.mute)) }
        out.append((.circle, l.circle))
        out.append((.window, l.window))
        if content.question != nil {
            out.append((.allow, l.allow))
            out.append((.deny, l.deny))
        } else {
            if askEnabled { out.append((.ask, l.ask)) }
            if !content.marks.isEmpty { out.append((.clear, l.clear)) }
        }
        let thumbs = thumbSlots(l)
        for s in thumbs.slots {
            out.append((.markForget(s.index), Self.forgetRect(s.rect)))
            out.append((.mark(s.index), s.rect))
        }
        for chip in threadChips(l, now: Date()) {
            if let stop = chip.stop { out.append((.threadStop(chip.row.id), stop)) }
            out.append((.thread(chip.row.id), chip.rect))
        }
        out.append((.console, l.console))
        if awake { out.append((.sleep, l.sleep)) }
        if let r = remedyRect { out.append((.remedy, r)) }
        out.append((.field, l.line))
        return out
    }

    // MARK: chips (the peek)

    /// One glance chip on the peek: a glyph (tinted) and a figure, never a sentence.
    private struct Chip {
        enum Kind { case question, marks, problem, meter, marking }
        let kind: Kind
        let glyph: String?
        let tint: NSColor
        let figure: String
        let tooltip: String
        /// The figure's alpha step (the paused meter is a step dimmer).
        let alpha: CGFloat
        /// Measured: glyph 10 + 3 + figure (0 without a figure).
        let width: CGFloat
    }

    /// The chips this frame (at most four, in order: question, marks, problem, meter;
    /// marking replaces them all) and what the peek grows by for them.
    private var chips: [Chip] = []
    private var chipsExtraWidth: CGFloat = 0
    /// Where each chip was drawn this frame (view coordinates), for the tooltip.
    private var chipRects: [(NSRect, String)] = []

    /// Rebuild the chip list from the content and clamp the peek to the island's width:
    /// chips drop from the right — the meter, then the problem — until it fits. The
    /// question and the marks chips always fit.
    private func relayoutChips() {
        func measure(_ glyph: String?, _ figure: String) -> CGFloat {
            let g: CGFloat = glyph == nil ? 0 : 10
            let f = figure.isEmpty ? 0 : Self.textWidth(figure as NSString, Self.pillAttrs) + (glyph == nil ? 0 : 3)
            return g + f
        }
        var list: [Chip] = []
        let c = content
        if c.marking {
            let figure = "Circle something · Esc"
            list.append(Chip(kind: .marking, glyph: "scope", tint: Self.markTone, figure: figure, tooltip: "Circling — draw around something, Esc to cancel", alpha: 0.72, width: measure("scope", figure)))
        } else {
            if let q = c.question {
                let name = q.name.count > 10 ? String(q.name.prefix(10)) : q.name
                let figure = name + " asks"
                let short = q.text.count > 40 ? String(q.text.prefix(40)) + "…" : q.text
                list.append(Chip(kind: .question, glyph: "hand.raised.fill", tint: Self.markTone, figure: figure, tooltip: "\(q.name) asks: \(short)", alpha: 0.72, width: measure("hand.raised.fill", figure)))
            }
            let pending = c.pendingMarks
            if pending > 0 {
                let figure = "\(pending)"
                list.append(Chip(kind: .marks, glyph: "scope", tint: Self.markTone, figure: figure, tooltip: "\(pending) circled — waiting for the next task", alpha: 0.72, width: measure("scope", figure)))
            }
            if let p = c.problem {
                list.append(Chip(kind: .problem, glyph: p.symbol, tint: p.warn ? Self.markTone : Self.errorTone, figure: "", tooltip: p.text, alpha: 0.72, width: measure(p.symbol, "")))
            }
            if c.meter.inSession || c.meter.paused, let billed = c.meter.billedSeconds {
                let figure = TransportFormat.minutes(billed)
                var tip = "Billed " + TransportFormat.billed(billed)
                if let today = c.meter.todaySeconds, today > 0 { tip += " · today " + TransportFormat.billed(today) }
                list.append(Chip(kind: .meter, glyph: nil, tint: .white, figure: figure, tooltip: tip, alpha: c.meter.paused ? 0.48 : 0.72, width: measure(nil, figure)))
            }
        }
        if list.count > 4 { list = Array(list.prefix(4)) }
        // The clamp: notch + breath + counter + dots + chips ≤ the island's width.
        let n = geometry?.notch.width ?? 185
        let fixed = n + (reduced ? 0 : 30) + (workingSince != nil ? Self.workExtraWidth : 0) + peekDotsExtraWidth
        func extra(_ l: [Chip]) -> CGFloat {
            guard !l.isEmpty else { return 0 }
            return l.reduce(0) { $0 + $1.width } + CGFloat(l.count - 1) * 8 + 8
        }
        while list.count > 1, fixed + extra(list) > NotchGeometry.islandWidth, let i = list.lastIndex(where: { $0.kind == .meter || $0.kind == .problem }) {
            list.remove(at: i)
        }
        chips = list
        chipsExtraWidth = extra(list)
    }

    // MARK: the pill slot

    /// A toast or the mark-landed line in the slot under the island, until `until` (CACurrentMediaTime).
    private struct SlotPill {
        let text: String
        let symbol: String?
        let tone: PillTone
        let until: Double
    }
    private var toastPill: SlotPill?
    private var markLandedPill: SlotPill?

    /// Tone `.mark` is the "◎ N circled · Go to ask" slot (shown only tucked, under a
    /// toast); every other tone is a toast. The newest of each replaces the last.
    func showPill(_ text: String, symbol: String?, tone: PillTone, seconds: Double) {
        let s = seconds.isFinite ? max(0.1, seconds) : 1.5
        let pill = SlotPill(text: text, symbol: symbol, tone: tone, until: CACurrentMediaTime() + s)
        if tone == .mark { markLandedPill = pill } else { toastPill = pill }
        needsDisplay = true
        wake()
    }

    private func expirePills(_ now: Double) {
        if let t = toastPill, now >= t.until { toastPill = nil; needsDisplay = true }
        if let m = markLandedPill, now >= m.until { markLandedPill = nil; needsDisplay = true }
    }

    /// What the slot shows this frame: gate > toast > mark-landed (tucked only) > problem (island open only).
    private enum Slot {
        case gate(OrbPill)
        case pill(SlotPill)
        case problem(DockContent.ProblemRow)
    }

    private func slot(now: Double, open: CGFloat) -> Slot? {
        if !awake, let g = gatePill { return .gate(g) }
        if let t = toastPill, now < t.until { return .pill(t) }
        if let m = markLandedPill, now < m.until, mode == .tucked, open < 0.5 { return .pill(m) }
        if mode == .island, open > 0.5, parked, let p = content.problem { return .problem(p) }
        return nil
    }

    // MARK: drawing

    /// The thread dots: one flat `dotSide` square per live spawned thread in its phase
    /// colour, `dotGap` apart, the run starting at `x`, centred on `midY`. No gradient,
    /// no circle: the island's language is squares and hairlines. A thread that asks is
    /// the amber hand in its square's place; one that failed the red ×.
    private func drawThreadDots(_ cg: CGContext, x: CGFloat, midY: CGFloat, alpha: CGFloat) {
        let a = finite01(alpha)
        guard a > 0.005, !threads.isEmpty, x.isFinite, midY.isFinite else { return }
        cg.saveGState()
        cg.setAlpha(a)
        var dx = x
        for d in threads {
            switch d.status {
            case .waitingKevin:
                if let img = Self.symbol("hand.raised.fill", pointSize: 7, tint: Self.markTone) {
                    drawImage(cg, img, in: NSRect(x: dx + Self.dotSide / 2 - img.size.width / 2, y: midY - img.size.height / 2, width: img.size.width, height: img.size.height), alpha: a)
                }
            case .failed:
                if let img = Self.symbol("xmark", pointSize: 7, tint: Self.errorTone) {
                    drawImage(cg, img, in: NSRect(x: dx + Self.dotSide / 2 - img.size.width / 2, y: midY - img.size.height / 2, width: img.size.width, height: img.size.height), alpha: a)
                }
            default:
                cg.setFillColor(d.tone.cgColor)
                cg.fill(CGRect(x: dx, y: midY - Self.dotSide / 2, width: Self.dotSide, height: Self.dotSide))
            }
            dx += Self.dotSide + Self.dotGap
        }
        cg.restoreGState()
    }

    /// An NSImage into the flipped CG context at `alpha` — `draw(…fraction:)` REPLACES the
    /// context's alpha rather than multiplying it, so the product is passed in.
    private func drawImage(_ cg: CGContext, _ img: NSImage, in rect: NSRect, alpha: CGFloat) {
        guard rect.isFiniteRect else { return }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: cg, flipped: true)
        img.draw(in: rect, from: .zero, operation: .sourceOver, fraction: finite01(alpha), respectFlipped: true, hints: nil)
        NSGraphicsContext.restoreGraphicsState()
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let cg = NSGraphicsContext.current?.cgContext, geometry != nil else { return }
        let now = CACurrentMediaTime()
        #if JARHEAD_ORB_PREVIEW
        defer { Self.previewNoteDraw(CACurrentMediaTime() - now) }
        #endif
        let n = notchRect
        // Every number that reaches the ink, the clip, CoreGraphics or CoreText from
        // here on is finite: the island's rect is the springs' (a bad one is reset here
        // and the frame goes on), and a rect that is still not a rect — the geometry
        // itself — draws nothing this frame. Logged once either way.
        guard n.isFiniteRect, n.width >= 0 else { BadNumber.noteOnce("NotchView notch rect", "\(n)"); return }
        var islandRaw = islandRect
        if !islandRaw.isFiniteRect {
            BadNumber.noteOnce("NotchView island rect", "\(islandRaw)")
            widthSpring.recover(); heightSpring.recover(); openSpring.recover()
            islandRaw = islandRect
            guard islandRaw.isFiniteRect else { return }
        }
        let open = finite01(CGFloat(openSpring.value))
        let scale = window?.backingScaleFactor ?? 2
        chipRects.removeAll(keepingCapacity: true)
        remedyRect = nil
        pillRect = nil

        // The ink, one shape from the bezel down (`NotchInk.shape`): the hardware notch,
        // pure black (nothing lives behind it), its column through the menu bar band,
        // concave fillets curving out of the column onto the island's top edge, the
        // island's convex rounded top corners where it hangs from the bar, and the
        // notch's radius on its bottom corners — the notch grown into an island, not a
        // rectangle hung under the bar. Radii follow the island's size each frame, so
        // the spring never kinks; at the notch's width it is the column with rounded
        // bottom corners. Snapped to device pixels: no seam against the real notch.
        let shape = NotchInk.shape(column: n.minX...n.maxX, island: islandRaw, scale: scale)
        let island = shape.island
        cg.setFillColor(CGColor(gray: 0, alpha: 1))
        cg.addPath(shape.path)
        cg.fillPath()
        #if JARHEAD_ORB_PREVIEW
        let park = previewForcedLevels.map { finite01($0.park) } ?? finite01(parkLevel(now))
        let work = previewForcedLevels.map { finite01($0.work) } ?? finite01(workLevel(now))
        #else
        let park = finite01(parkLevel(now))
        let work = finite01(workLevel(now))
        #endif
        // The blob is out at its target and a delegation runs (or threads are live): the
        // counter and the thread dots alone on the strip (no face — that is on the body),
        // fading with the park level's inverse; the counter with the work level too.
        if work > 0.005 || !threads.isEmpty, park < 0.995, island.isFiniteRect, island.height >= 1 {
            drawWorkingStrip(cg, shape: shape, island: island, color: sim.displayColor, alpha: 1 - park, work: work)
        }
        #if JARHEAD_ORB_PREVIEW
        if previewStripOnly { return }
        #endif
        guard park > 0.005, island.isFiniteRect, island.height >= 1 else { return }

        // Everything on the island is clipped to the ink and fades with the park level:
        // the hand-off with the body is a crossfade, and a shrinking island never shows
        // a face outside its ink.
        cg.saveGState()
        cg.addPath(shape.path)
        cg.clip()

        // The orb's gradient pooling out of the notch, clipped to the island (the column
        // and the band through the menu bar stay black), drawn at the mode's intensity:
        // a breath of it along the tucked lip, unmistakably in the peek, fully on the
        // island. The image is the island's size rounded up to 2 pt, centred on it, its
        // top at the island's, the excess clipped: the dither stays 1:1. Until this size
        // has rendered (in the background) the nearest rendered one is stretched over it,
        // and `notchInkRendered` redraws when the exact one lands.
        let breath = finite01(0.5 + 0.5 * sin(2 * .pi * sim.time / BlobSim.breathPeriod))
        let level = finite01(gradientLevel(height: island.height, open: open, breath: sim.reducedMotion ? 0.5 : breath))
        if level > 0.005, let g = geometry,
           let gradient = NotchInk.gradient(size: island.size, notchWidth: g.notch.width, scale: scale) {
            #if JARHEAD_ORB_PREVIEW
            // Only a resting island counts: the spring's way through the sizes stretches the nearest neighbour by design.
            if !gradient.exact, springsSettled { Self.previewStretchedFrames += 1 }
            #endif
            cg.saveGState()
            cg.clip(to: island)
            cg.setAlpha(level * park)
            cg.interpolationQuality = gradient.exact ? .none : .low
            let size = gradient.size
            let x = ((island.midX - size.width / 2) * scale).rounded() / scale
            // The view is flipped; the image's first row is the island's top.
            cg.translateBy(x: 0, y: island.minY + size.height)
            cg.scaleBy(x: 1, y: -1)
            cg.draw(gradient.image, in: CGRect(x: x, y: 0, width: size.width, height: size.height))
            cg.restoreGState()
        }

        let color = sim.displayColor
        let glyphs = BlobGlyphs.shared
        cg.saveGState()
        cg.setAllowsAntialiasing(true)
        cg.setShouldAntialias(true)
        cg.setShouldSmoothFonts(false)
        cg.setAllowsFontSubpixelPositioning(true)
        cg.setShouldSubpixelPositionFonts(true)
        cg.setAlpha(park)

        // The face. Tucked: dark grey dashes at the lip, the sim's face (the gate's
        // while it listens or asks). Peeking: the phase colour a step up, centred.
        // Island: the face at the left, on the head row. It slides with the spring; its
        // ground under-copy (`drawEye`) keeps it readable over the gradient's light end.
        let face = sim.face
        let lipFace = mode == .tucked && open < 0.5
        // Working in the peek: the face gives half the counter's width (and the dots', and the chips') to keep the pair centred.
        let peekShift: CGFloat = lipFace ? 0 : -(Self.workExtraWidth * work + peekDotsExtraWidth + chipsExtraWidth) / 2
        let fl = faceLayout(island: island, open: open, lipFace: lipFace, shift: peekShift)
        // Cell shift: the look moves the pair by up to a glyph's third.
        let shiftX = CGFloat(sim.faceLookX) * CGFloat(fl.size) * 0.3
        let shiftY = CGFloat(sim.faceLookY) * CGFloat(fl.size) * 0.18
        let ink: RGB
        if lipFace, sim.gate == .off || sim.gate == .lockedOut {
            ink = RGB(hex: 0x4a4d55)
        } else if lipFace {
            ink = color.mixed(with: RGB(1, 1, 1), 0.35)
        } else {
            ink = color.mixed(with: RGB(1, 1, 1), sim.eyeLift)
        }
        let left = CGPoint(x: fl.centre.x - fl.gap / 2 + shiftX, y: fl.centre.y + shiftY)
        let right = CGPoint(x: fl.centre.x + fl.gap / 2 + shiftX, y: fl.centre.y + shiftY)
        cg.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
        BlobFieldView.drawEye(cg, glyph: face.left, size: fl.size, at: left, ink: ink, glyphs: glyphs)
        BlobFieldView.drawEye(cg, glyph: face.right, size: fl.size, at: right, ink: ink, glyphs: glyphs)

        // The phase colour: a hairline along the island's bottom edge (peeking, island),
        // a one-pixel glow that breathes along the lip (tucked) — in the mark tone while
        // marks wait. Peeking, the hairline pulses with the sound as the island widens with it (`onFrame`).
        let hairAlpha: Double
        var hairColor = color
        if lipFace {
            hairAlpha = 0.18 + 0.22 * (sim.reducedMotion ? 0.5 : breath)
            if content.pendingMarks > 0 { hairColor = Self.markToneRGB }
        } else if mode == .peek, open < 0.5 {
            hairAlpha = 0.55 + 0.4 * (sim.reducedMotion ? 0.5 : finite01(sim.islandLevel))
        } else {
            hairAlpha = 0.9
        }
        let inset = max(shape.bottomRadius, 2)
        cg.setStrokeColor(hairColor.cgColor(alpha: finite01(hairAlpha)))
        cg.setLineWidth(1)
        cg.move(to: CGPoint(x: island.minX + inset, y: island.maxY - 0.5))
        cg.addLine(to: CGPoint(x: island.maxX - inset, y: island.maxY - 0.5))
        cg.strokePath()

        // Tucked with marks waiting: the small `◎2` right of the eyes, in the mark tone.
        if lipFace, content.pendingMarks > 0, island.height >= 10 {
            drawLipChip(cg, afterFace: fl.right + 6, midY: island.midY, alpha: park)
        }

        // Working, peeking: "Working · 0:12" right of the face, fading as the island opens
        // (on the open island it sits after the phase word instead). The thread dots
        // follow the counter — or the face, once the counter has faded — and the chips the dots.
        var afterCounter = fl.right + 8
        if work > 0.005, !lipFace, open < 0.995 {
            let alpha = finite01(work * (1 - open))
            let text = workingText()
            let w = Self.textWidth(text, Self.workAttrs)
            let x = fl.right + 8
            let rect = NSRect(x: x, y: island.midY - 8, width: min(w + 2, max(0, island.maxX - 10 - x)), height: 16)
            if rect.width > 24 {
                NSGraphicsContext.saveGraphicsState()
                NSGraphicsContext.current = NSGraphicsContext(cgContext: cg, flipped: true)
                cg.saveGState()
                cg.setAlpha(alpha)
                Self.drawShadowed(text, in: rect, Self.workAttrs, shadow: Self.workShadow)
                cg.restoreGState()
                NSGraphicsContext.restoreGraphicsState()
            }
            afterCounter = x + (rect.width + 8) * work
        }
        if !threads.isEmpty, !lipFace, !content.marking, open < 0.995 {
            drawThreadDots(cg, x: afterCounter, midY: island.midY, alpha: 1 - open)
            afterCounter += dotsWidth + 8
        }
        if !chips.isEmpty, !lipFace, open < 0.995, island.height >= 14 {
            drawChips(cg, x: afterCounter, midY: island.midY, maxX: island.maxX - 8, alpha: park * (1 - open), now: now)
        }

        // The island's rows and boxes: laid out in the open island's rect, revealed by
        // the ink as it opens, each fading in and rising on its own beat.
        if contentAppearance(0, now: now) != nil || contentAppearance(Self.contentElements - 1, now: now) != nil {
            let layout = islandLayout(in: islandOpenRect)
            if layout.isFinite {
                drawIslandContent(cg, layout: layout, color: color, park: park, now: now)
            } else {
                BadNumber.noteOnce("NotchView island layout", "head \(layout.head) transport \(layout.transport)")
            }
        }
        cg.restoreGState()
        cg.restoreGState()

        // The slot under the island: the gate's pill asleep, else a toast, else the
        // mark-landed line (tucked), else — island open — the newest problem and its remedy.
        switch slot(now: now, open: open) {
        case .gate(let pill):
            var text = pill.text
            if let until = pill.until {
                let left = until.timeIntervalSinceNow
                text += " · \(left.isFinite ? max(1, Int(min(left, 1e6).rounded())) : 1) s"
            }
            let tone: PillTone
            switch pill.tone {
            case .info: tone = .info
            case .warn: tone = .warn
            case .error: tone = .error
            }
            pillRect = drawSlotPill(cg, text: text, symbol: pill.icon, tone: tone, below: island, alpha: 1)
        case .pill(let p):
            // The last 0.24 s fade out.
            let left = p.until - now
            let fade = finite01(left / seconds(Motion.base))
            pillRect = drawSlotPill(cg, text: p.text, symbol: p.symbol, tone: p.tone, below: island, alpha: fade)
        case .problem(let p):
            pillRect = drawProblemPill(cg, p, below: island, alpha: park, now: now)
        case nil:
            break
        }
        // The remedy box is a hit rect only while the problem pill shows: the children follow it.
        let hasRemedy = remedyRect != nil
        if hasRemedy != hadRemedy {
            hadRemedy = hasRemedy
            rebuildAccessibility()
        }
    }

    /// Whether the last frame drew the remedy box (`rebuildAccessibility` on a change).
    private var hadRemedy = false

    /// How much of the gradient shows: a breath along the tucked lip (≤ 12%), all but
    /// fully in the peek (pulsing with the sound — it must be unmistakable in a 26 pt
    /// strip), fully on the open island; eased with the island's height and the
    /// spring's openness so a transition fades, never steps.
    private func gradientLevel(height: CGFloat, open: CGFloat, breath: Double) -> CGFloat {
        let tucked = 0.08 + 0.04 * breath
        let peek = 0.92 + 0.08 * (sim.reducedMotion ? 0.5 : finite01(sim.islandLevel))
        let lip = NotchGeometry.lipHeight, peekH = NotchGeometry.peekHeight
        let t = peekH > lip ? min(1, max(0, (height - lip) / (peekH - lip))) : 1
        let eased = t * t * (3 - 2 * t)
        var level = tucked + (peek - tucked) * eased
        level += (1 - level) * open
        return CGFloat(min(1, max(0, level)))
    }

    /// The lip's marks chip: a 9 pt `scope` and the pending count in 9 mono-digit, the mark tone.
    private func drawLipChip(_ cg: CGContext, afterFace x: CGFloat, midY: CGFloat, alpha: CGFloat) {
        guard x.isFinite, midY.isFinite else { return }
        let figure = "\(content.pendingMarks)" as NSString
        var dx = x
        if let img = Self.symbol("scope", pointSize: 9, tint: Self.markTone) {
            drawImage(cg, img, in: NSRect(x: dx, y: midY - img.size.height / 2, width: img.size.width, height: img.size.height), alpha: alpha)
            dx += img.size.width + 2
        }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: cg, flipped: true)
        Self.drawText(figure, at: NSPoint(x: dx, y: midY - 6), Self.lipChipAttrs)
        NSGraphicsContext.restoreGraphicsState()
        chipRects.append((NSRect(x: x, y: midY - 6, width: dx - x + 12, height: 12), "\(content.pendingMarks) circled — waiting for the next task"))
    }

    /// The glance chips on the peek, right of the dots: glyph 10 pt semibold (tinted) +
    /// 3 pt + figure 11 mono-digit at white 0.72, 8 pt apart. The hand pulses on
    /// `Motion.pulse` (held under Reduce Motion). Nothing past `maxX`.
    private func drawChips(_ cg: CGContext, x: CGFloat, midY: CGFloat, maxX: CGFloat, alpha: CGFloat, now: Double) {
        let a = finite01(alpha)
        guard a > 0.005, x.isFinite, midY.isFinite else { return }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: cg, flipped: true)
        var dx = x
        for chip in chips {
            guard dx + chip.width <= maxX + 0.5 else { break }
            let start = dx
            var glyphAlpha = a
            if chip.kind == .question { glyphAlpha = a * (0.55 + 0.45 * pulse(now)) }
            if let glyph = chip.glyph, let img = Self.symbol(glyph, pointSize: 10, tint: chip.tint) {
                drawImage(cg, img, in: NSRect(x: dx + 5 - img.size.width / 2, y: midY - img.size.height / 2, width: img.size.width, height: img.size.height), alpha: glyphAlpha)
                dx += 10 + (chip.figure.isEmpty ? 0 : 3)
            }
            if !chip.figure.isEmpty {
                cg.saveGState()
                cg.setAlpha(a * chip.alpha / 0.72)
                let rect = NSRect(x: dx, y: midY - 8, width: chip.width - (dx - start) + 2, height: 16)
                Self.drawShadowed(chip.figure as NSString, in: rect, Self.workAttrs, shadow: Self.workShadow)
                cg.restoreGState()
            }
            chipRects.append((NSRect(x: start - 2, y: midY - 9, width: chip.width + 4, height: 18), chip.tooltip))
            dx = start + chip.width + 8
        }
        NSGraphicsContext.restoreGraphicsState()
    }

    /// One 26×24 hairline box: translucent ink under a white 0.26 hairline, a solid symbol
    /// (or a word); hover one alpha step; the pressed one filled with the accent, letting
    /// go over `Motion.base`. `enabled` false dims it to 0.35 and it takes nothing.
    private func drawBox(_ cg: CGContext, which: Press, rect: NSRect, symbol: String?, word: String? = nil, enabled: Bool, dim: CGFloat = 1,
                         hovered: Press?, pressed: Press?, base: CGFloat, now: Double) {
        let alpha = finite01(base * (enabled ? dim : 0.35))
        let box = NSBezierPath(roundedRect: rect, xRadius: 6, yRadius: 6)
        let hot = enabled && hovered == which
        let down = enabled && pressed == which
        let flash = enabled ? flashLevel(which, now: now) : 0
        cg.saveGState()
        cg.setAlpha(alpha)
        if down {
            Self.accent.setFill(); box.fill()
        } else {
            NSColor(white: 0, alpha: 0.42).setFill(); box.fill()
            if hot { NSColor(white: 1, alpha: 0.10).setFill(); box.fill() }
            if flash > 0 { Self.accent.withAlphaComponent(flash).setFill(); box.fill() }
        }
        NSColor(white: 1, alpha: 0.26).setStroke()
        box.lineWidth = 1
        box.stroke()
        let white = NSColor.white
        if let symbol, let img = Self.symbol(symbol, pointSize: 11, tint: down || hot ? white : white.withAlphaComponent(0.78)) {
            let s = img.size
            img.draw(in: NSRect(x: rect.midX - s.width / 2, y: rect.midY - s.height / 2, width: s.width, height: s.height),
                     from: .zero, operation: .sourceOver, fraction: alpha, respectFlipped: true, hints: nil)
        }
        if let word {
            let ns = word as NSString
            let w = Self.textWidth(ns, Self.wordAttrs)
            Self.drawText(ns, at: NSPoint(x: rect.midX - w / 2, y: rect.minY + 4), Self.wordAttrs)
        }
        cg.restoreGState()
    }

    /// The island's rows and boxes — each at its own fade and rise (`contentAppearance`),
    /// all under the park level.
    ///
    /// Alpha is one product per element — park × appearance × (a third for a dead box)
    /// — set on the context for the fills, strokes and words and passed as `fraction:`
    /// to the symbol draws: `NSImage.draw(…fraction:)` replaces the context's alpha
    /// rather than multiplying it (as does a nested `setAlpha`), which is how the glyphs
    /// once popped in at full white while everything around them faded.
    private func drawIslandContent(_ cg: CGContext, layout l: IslandLayout, color: RGB, park: CGFloat, now: Double) {
        NSGraphicsContext.saveGraphicsState()
        let ctx = NSGraphicsContext(cgContext: cg, flipped: true)
        NSGraphicsContext.current = ctx
        var hovered = hoveredButton
        var pressed = pressing
        #if JARHEAD_ORB_PREVIEW
        if hovered == nil, let name = NotchDock.previewHoveredButton { hovered = Press(previewName: name) }
        if pressed == nil, let name = NotchDock.previewPressedButton { pressed = Press(previewName: name) }
        #endif
        let white = NSColor.white
        let date = Date()

        // 0: the transport — a 22 pt circle: translucent ink under a hairline ring in the
        // phase colour, a solid play (Go: asleep, error, paused) / pause (in a session) /
        // ellipsis (connecting) centred; hover lifts it, a press fills it accent and the
        // fill lets go over `Motion.base`.
        if let a = contentAppearance(0, now: now) {
            let alpha = finite01(park * a.alpha)
            cg.saveGState()
            cg.setAlpha(alpha)
            let rect = l.transport.offsetBy(dx: 0, dy: a.dy)
            let hot = hovered == .pause
            let down = pressed == .pause
            let flash = flashLevel(.pause, now: now)
            let circle = NSBezierPath(ovalIn: rect)
            if down {
                Self.accent.setFill(); circle.fill()
            } else {
                NSColor(white: 0, alpha: 0.40).setFill(); circle.fill()
                if hot { NSColor(white: 1, alpha: 0.12).setFill(); circle.fill() }
                if flash > 0 { Self.accent.withAlphaComponent(flash).setFill(); circle.fill() }
            }
            let ring = NSBezierPath(ovalIn: rect.insetBy(dx: 0.5, dy: 0.5))
            ring.lineWidth = 1
            let ringTone = hot || down ? color.mixed(with: RGB(1, 1, 1), 0.35) : color
            NSColor(srgbRed: ringTone.r, green: ringTone.g, blue: ringTone.b, alpha: hot || down ? 1 : 0.9).setStroke()
            ring.stroke()
            let symbol = AppState.transportLabel(for: sim.phase).symbol
            if let img = Self.symbol(symbol, pointSize: 10, tint: down || hot ? white : white.withAlphaComponent(0.92)) {
                let s = img.size
                // A play glyph sits a hair right of its box's centre to look centred.
                let nudge: CGFloat = symbol == "play.fill" ? 0.5 : 0
                img.draw(in: NSRect(x: rect.midX - s.width / 2 + nudge, y: rect.midY - s.height / 2, width: s.width, height: s.height),
                         from: .zero, operation: .sourceOver, fraction: alpha, respectFlipped: true, hints: nil)
            }
            cg.restoreGState()
        }

        // 1: S1, the head row — the phase word, then "Working · 0:12" one step dimmer.
        // Words carry a one-pixel ink shadow so they read where the gradient runs light.
        if let a = contentAppearance(1, now: now) {
            cg.saveGState()
            cg.setAlpha(finite01(park * a.alpha))
            let word = OrbStyle.label(sim.phase) as NSString
            let rect = NSRect(x: l.head.minX, y: l.head.minY + 2 + a.dy, width: l.head.width, height: 18)
            Self.drawShadowed(word, in: rect, Self.phaseAttrs, shadow: Self.phaseShadow)
            let work = workLevel(now)
            if work > 0.005 {
                let text = workingText()
                let x = rect.minX + Self.textWidth(word, Self.phaseAttrs) + 8
                let room = rect.maxX - x
                let w = Self.textWidth(text, Self.workAttrs)
                if room > 24, w > 0 {
                    cg.saveGState()
                    cg.setAlpha(finite01(park * a.alpha * work))
                    let box = NSRect(x: x, y: rect.minY + 1, width: min(w + 2, room), height: rect.height)
                    Self.drawShadowed(text, in: box, Self.workAttrs, shadow: Self.workShadow)
                    cg.restoreGState()
                }
            }
            cg.restoreGState()
        }

        // 2: S2, the line — the field while it has key (the accent ring; the field draws
        // its own words), else a thread's question with the amber hand, the running
        // delegation's request, the last thing said, the gate's words asleep, or "—".
        if let a = contentAppearance(2, now: now) {
            cg.saveGState()
            cg.setAlpha(finite01(park * a.alpha))
            let rect = l.line.offsetBy(dx: 0, dy: a.dy)
            if fieldFocused {
                let ring = NSBezierPath(roundedRect: rect.insetBy(dx: 0.5, dy: 0.5), xRadius: 4, yRadius: 4)
                ring.lineWidth = 1
                Self.accent.setStroke()
                ring.stroke()
            } else {
                // The field's hairline at rest: a seam under the line, a step up under the pointer.
                NSColor(white: 1, alpha: hovered == .field ? 0.26 : 0.10).setStroke()
                let seam = NSBezierPath()
                seam.move(to: NSPoint(x: rect.minX, y: rect.maxY - 0.5))
                seam.line(to: NSPoint(x: rect.maxX, y: rect.maxY - 0.5))
                seam.lineWidth = 1
                seam.stroke()
                var textRect = NSRect(x: rect.minX, y: rect.minY + 2, width: rect.width, height: 16)
                if let q = content.question {
                    if let img = Self.symbol("hand.raised.fill", pointSize: 10, tint: Self.markTone) {
                        img.draw(in: NSRect(x: textRect.minX, y: rect.midY - img.size.height / 2, width: img.size.width, height: img.size.height),
                                 from: .zero, operation: .sourceOver, fraction: finite01(park * a.alpha), respectFlipped: true, hints: nil)
                        textRect.origin.x += img.size.width + 4
                        textRect.size.width -= img.size.width + 4
                    }
                    Self.drawShadowed("\(q.name) asks · \(q.text)" as NSString, in: textRect, Self.lineAttrs, shadow: Self.lineShadow)
                } else if workingSince != nil, let r = content.request, !r.isEmpty {
                    Self.drawShadowed(r as NSString, in: textRect, Self.lineAttrs, shadow: Self.lineShadow)
                } else if !lastLine.isEmpty {
                    Self.drawShadowed(lastLine as NSString, in: textRect, Self.lineAttrs, shadow: Self.lineShadow)
                } else if !awake, let g = content.gateLabel, !g.isEmpty {
                    Self.drawShadowed(g as NSString, in: textRect, Self.lineAttrs, shadow: Self.lineShadow)
                } else {
                    Self.drawShadowed("—", in: textRect, Self.lineAttrsEmpty, shadow: Self.lineShadow)
                }
            }
            cg.restoreGState()
        }

        // 3: S3, the context row — Circle and Window, then the circled strip (thumbnails,
        // a skeleton while the crop is on its way, dimmed once used) or a hint.
        if let a = contentAppearance(3, now: now) {
            let base = finite01(park * a.alpha)
            let granted = content.screenRecordingGranted
            drawBox(cg, which: .circle, rect: l.circle.offsetBy(dx: 0, dy: a.dy), symbol: "scope", enabled: true, dim: granted ? 1 : 0.45, hovered: hovered, pressed: pressed, base: base, now: now)
            drawBox(cg, which: .window, rect: l.window.offsetBy(dx: 0, dy: a.dy), symbol: "macwindow", enabled: true, dim: granted ? 1 : 0.45, hovered: hovered, pressed: pressed, base: base, now: now)
            let thumbs = thumbSlots(l)
            if thumbs.slots.isEmpty {
                cg.saveGState()
                cg.setAlpha(base)
                let hint = (granted ? "Circle something · ⌥⇧C" : "Captures need Screen Recording") as NSString
                let rect = NSRect(x: l.thumbs[0].minX, y: l.context.minY + 6 + a.dy, width: l.context.maxX - l.thumbs[0].minX, height: 16)
                Self.drawShadowed(hint, in: rect, Self.hintAttrs, shadow: Self.lineShadow)
                cg.restoreGState()
            } else {
                for s in thumbs.slots {
                    let hot = hovered == .mark(s.index) || hovered == .markForget(s.index)
                    drawThumb(cg, s.mark, in: s.rect.offsetBy(dx: 0, dy: a.dy), hot: hot, base: base)
                }
                if let over = thumbs.overflow {
                    cg.saveGState()
                    cg.setAlpha(base)
                    let text = "+\(over.count)" as NSString
                    let w = Self.textWidth(text, Self.overflowAttrs)
                    let r = over.rect.offsetBy(dx: 0, dy: a.dy)
                    Self.drawText(text, at: NSPoint(x: r.midX - w / 2, y: r.midY - 7), Self.overflowAttrs)
                    cg.restoreGState()
                }
            }
        }

        // 4: S4, the threads row — one chip per live thread, "Name · word · m:ss", its own
        // small Stop after it when it can be stopped, " | " between; the asking one leads.
        if let a = contentAppearance(4, now: now), !content.threads.isEmpty {
            cg.saveGState()
            cg.setAlpha(finite01(park * a.alpha))
            let chipsNow = threadChips(l, now: date)
            var prevEnd: CGFloat?
            for chip in chipsNow {
                let rect = chip.rect.offsetBy(dx: 0, dy: a.dy)
                if let e = prevEnd {
                    Self.drawShadowed(" | ", in: NSRect(x: e, y: rect.minY, width: rect.minX - e + 1, height: rect.height), Self.threadAttrs, shadow: Self.threadShadow)
                }
                Self.drawShadowed(chip.text, in: rect, Self.threadAttrs, shadow: Self.threadShadow)
                prevEnd = rect.maxX
                if let stop = chip.stop {
                    let hot = hovered == .threadStop(chip.row.id)
                    if let img = Self.symbol("stop.fill", pointSize: 9, tint: hot ? white : white.withAlphaComponent(0.72)) {
                        let sr = stop.offsetBy(dx: 0, dy: a.dy)
                        img.draw(in: NSRect(x: sr.midX - img.size.width / 2, y: sr.midY - img.size.height / 2, width: img.size.width, height: img.size.height),
                                 from: .zero, operation: .sourceOver, fraction: finite01(park * a.alpha), respectFlipped: true, hints: nil)
                    }
                    prevEnd = stop.maxX
                }
            }
            cg.restoreGState()
        }

        // 5: S5, the foot — the meter — and the right column: Stop and Mute (R1), Ask and
        // Clear or Allow and Deny (R2), Console and Sleep (R3).
        if let a = contentAppearance(5, now: now) {
            let base = finite01(park * a.alpha)
            cg.saveGState()
            cg.setAlpha(base)
            let foot = footText(now: now)
            let rect = NSRect(x: l.foot.minX, y: l.foot.minY + 1 + a.dy, width: l.foot.width, height: 15)
            Self.drawShadowed(foot.text as NSString, in: rect, foot.dim ? Self.footPausedAttrs : Self.threadAttrs, shadow: Self.threadShadow)
            cg.restoreGState()

            drawBox(cg, which: .stop, rect: l.stop.offsetBy(dx: 0, dy: a.dy), symbol: "stop.fill", enabled: true, hovered: hovered, pressed: pressed, base: base, now: now)
            drawBox(cg, which: .mute, rect: l.mute.offsetBy(dx: 0, dy: a.dy), symbol: sim.phase == .muted ? "mic.slash.fill" : "mic.fill", enabled: muteEnabled, hovered: hovered, pressed: pressed, base: base, now: now)
            if content.question != nil {
                drawBox(cg, which: .allow, rect: l.allow.offsetBy(dx: 0, dy: a.dy), symbol: nil, word: "Allow", enabled: true, hovered: hovered, pressed: pressed, base: base, now: now)
                drawBox(cg, which: .deny, rect: l.deny.offsetBy(dx: 0, dy: a.dy), symbol: nil, word: "Deny", enabled: true, hovered: hovered, pressed: pressed, base: base, now: now)
            } else {
                drawBox(cg, which: .ask, rect: l.ask.offsetBy(dx: 0, dy: a.dy), symbol: "questionmark.bubble.fill", enabled: askEnabled, hovered: hovered, pressed: pressed, base: base, now: now)
                if !content.marks.isEmpty {
                    drawBox(cg, which: .clear, rect: l.clear.offsetBy(dx: 0, dy: a.dy), symbol: "eraser.fill", enabled: true, hovered: hovered, pressed: pressed, base: base, now: now)
                }
            }
            drawBox(cg, which: .console, rect: l.console.offsetBy(dx: 0, dy: a.dy), symbol: "rectangle.3.group.fill", enabled: true, hovered: hovered, pressed: pressed, base: base, now: now)
            drawBox(cg, which: .sleep, rect: l.sleep.offsetBy(dx: 0, dy: a.dy), symbol: "moon.fill", enabled: awake, hovered: hovered, pressed: pressed, base: base, now: now)
        }
        NSGraphicsContext.restoreGraphicsState()
    }

    /// The foot's words: in session "4:12 · 2.3 min · $0.12 · today 12.3 min"; paused
    /// "2.3 min · $0.12 · sleeps in 4 min" a step dimmer; asleep "today 12.3 min · $0.62"
    /// or "No session. Nothing billed."
    private func footText(now: Double) -> (text: String, dim: Bool) {
        let m = content.meter
        if m.inSession {
            var parts: [String] = []
            if let e = m.elapsed {
                let live = e + max(0, now - contentAt)
                parts.append(OrbStyle.mmss(live.isFinite ? live : 0))
            }
            if let b = m.billedSeconds { parts.append(TransportFormat.billed(b)) }
            if let t = m.todaySeconds, t > 0 { parts.append("today " + TransportFormat.billed(t)) }
            return (parts.joined(separator: " · "), false)
        }
        if m.paused {
            var parts: [String] = []
            if let b = m.billedSeconds { parts.append(TransportFormat.billed(b)) }
            if let s = m.sleepsIn {
                let left = s - max(0, now - contentAt)
                if left.isFinite, left > 0 {
                    parts.append(left >= 60 ? "sleeps in \(Int((left / 60).rounded(.up))) min" : "sleeps in \(Int(left.rounded(.up))) s")
                } else {
                    parts.append("sleeping…")
                }
            }
            return (parts.joined(separator: " · "), true)
        }
        if let t = m.todaySeconds, t > 0 { return ("today " + TransportFormat.billed(t), false) }
        return ("No session. Nothing billed.", false)
    }

    /// The skeleton under a crop still on its way: the ink ramp dithered at 1.5 pt cells, once per scale.
    private static var skeletonCache: [Int: CGImage] = [:]
    private static func skeleton(scale: CGFloat) -> CGImage? {
        let key = Int((scale * 100).rounded())
        if let hit = skeletonCache[key] { return hit }
        let img = Dither.gradientImage(size: thumbSize, scale: scale, stops: Dither.skeletonStopsDark, direction: .diagonal, cell: Dither.cellPixels(scale: scale))
        if let img { skeletonCache[key] = img }
        return img
    }

    /// One thumbnail: the crop aspect-filled (interpolated — it is a photograph) or the
    /// skeleton with a 7 pt `scope`; a white 0.55 hairline frame, the mark tone at 0.9
    /// while pending; a used mark at half alpha and no amber. Hovered: a lift and the ×.
    private func drawThumb(_ cg: CGContext, _ m: DockContent.Mark, in rect: NSRect, hot: Bool, base: CGFloat) {
        guard rect.isFiniteRect else { return }
        let alpha = finite01(base * (m.consumed ? 0.5 : 1))
        let scale = window?.backingScaleFactor ?? 2
        cg.saveGState()
        cg.setAlpha(alpha)
        cg.saveGState()
        cg.clip(to: rect)
        if let img = m.thumbnail {
            let iw = CGFloat(img.width), ih = CGFloat(img.height)
            if iw > 0, ih > 0 {
                let k = max(rect.width / iw, rect.height / ih)
                let dst = NSRect(x: rect.midX - iw * k / 2, y: rect.midY - ih * k / 2, width: iw * k, height: ih * k)
                cg.interpolationQuality = .medium
                cg.translateBy(x: 0, y: dst.midY)
                cg.scaleBy(x: 1, y: -1)
                cg.translateBy(x: 0, y: -dst.midY)
                cg.draw(img, in: dst)
            }
        } else {
            if let sk = Self.skeleton(scale: scale) {
                cg.saveGState()
                cg.interpolationQuality = .none
                cg.translateBy(x: 0, y: rect.midY)
                cg.scaleBy(x: 1, y: -1)
                cg.translateBy(x: 0, y: -rect.midY)
                cg.draw(sk, in: rect)
                cg.restoreGState()
            } else {
                cg.setFillColor(CGColor(gray: 0.06, alpha: 1))
                cg.fill(rect)
            }
            if let img = Self.symbol("scope", pointSize: 7, tint: NSColor(white: 1, alpha: 0.72)) {
                drawImage(cg, img, in: NSRect(x: rect.midX - img.size.width / 2, y: rect.midY - img.size.height / 2, width: img.size.width, height: img.size.height), alpha: alpha)
            }
        }
        if hot {
            cg.setFillColor(CGColor(gray: 1, alpha: 0.10))
            cg.fill(rect)
        }
        cg.restoreGState()
        // The frame: the mark tone while pending, the hairline otherwise (a used mark keeps only the hairline).
        let frame = rect.insetBy(dx: 0.5, dy: 0.5)
        if !m.consumed {
            cg.setStrokeColor(Self.markToneRGB.cgColor(alpha: 0.9))
        } else {
            cg.setStrokeColor(CGColor(gray: 1, alpha: 0.55))
        }
        cg.setLineWidth(1)
        cg.stroke(frame)
        cg.restoreGState()
        if hot {
            // The ×: 12×12, ink 0.94 under an 8 pt xmark at white 0.9, on the top-right corner.
            let fr = Self.forgetRect(rect)
            cg.saveGState()
            cg.setAlpha(base)
            cg.setFillColor(CGColor(gray: 0.06, alpha: 0.94))
            cg.fillEllipse(in: fr)
            if let img = Self.symbol("xmark", pointSize: 7, tint: NSColor(white: 1, alpha: 0.9)) {
                drawImage(cg, img, in: NSRect(x: fr.midX - img.size.width / 2, y: fr.midY - img.size.height / 2, width: img.size.width, height: img.size.height), alpha: base)
            }
            cg.restoreGState()
        }
    }

    /// The working strip: the blob is out at its target, a delegation runs (or threads
    /// are live). The ink is already down (the notch grown to peek height); this adds
    /// the phase colour as the hairline along the bottom edge and "Working · 0:12"
    /// centred with the thread dots right of it — nothing else, so the notch reads as
    /// busy without competing with the body on the screen.
    ///
    /// Alphas: `alpha` is the park level's inverse. The counter is drawn at
    /// `alpha · work` — `CGContext.setAlpha` REPLACES the state's alpha, it does not
    /// multiply, so the product is computed here — and so is the hairline while no
    /// thread is live: the strip is then exactly what it was before the fleet
    /// (`work · (1 − park)` on both). With threads the strip is theirs: the hairline
    /// and the dots hold at `alpha` while the counter comes and goes with `work`.
    private func drawWorkingStrip(_ cg: CGContext, shape: NotchInk.Shape, island: NSRect, color: RGB, alpha: CGFloat, work: CGFloat) {
        let a = finite01(alpha)
        let counter = finite01(a * finite01(work))
        guard a > 0.005, counter > 0.005 || !threads.isEmpty else { return }
        cg.saveGState()
        cg.addPath(shape.path)
        cg.clip()
        cg.setAlpha(threads.isEmpty ? counter : a)
        let inset = max(shape.bottomRadius, 2)
        cg.setStrokeColor(color.cgColor(alpha: 0.9))
        cg.setLineWidth(1)
        cg.move(to: CGPoint(x: island.minX + inset, y: island.maxY - 0.5))
        cg.addLine(to: CGPoint(x: island.maxX - inset, y: island.maxY - 0.5))
        cg.strokePath()
        let text = workingText()
        let w = counter > 0.005 ? Self.textWidth(text, Self.workAttrs) : 0
        // The counter and the dots as one centred run: the counter, 8 of air, the dots.
        let dots = dotsWidth
        let run = w + (w > 0 && dots > 0 ? 8 : 0) + dots
        var x = island.midX - run / 2
        if w > 0, island.height >= 14 {
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(cgContext: cg, flipped: true)
            cg.setShouldSmoothFonts(false)
            cg.setAllowsFontSubpixelPositioning(true)
            cg.setShouldSubpixelPositionFonts(true)
            let rect = NSRect(x: x - 1, y: island.midY - 8, width: min(w + 2, max(0, island.width - 12)), height: 16)
            if rect.width > 24 {
                cg.saveGState()
                cg.setAlpha(counter)
                Self.drawShadowed(text, in: rect, Self.workAttrs, shadow: Self.workShadow)
                cg.restoreGState()
            }
            NSGraphicsContext.restoreGraphicsState()
            x += w + 8
        }
        if dots > 0, island.height >= 12 {
            drawThreadDots(cg, x: x, midY: island.midY, alpha: a)
        }
        cg.restoreGState()
    }

    /// The last transcript line, set by the dock from the content (mono, one line).
    var lastLine = "" { didSet { if lastLine != oldValue { needsDisplay = true } } }

    // MARK: the pill slot's drawing

    private static func pillTint(_ tone: PillTone) -> NSColor {
        switch tone {
        case .info: return NSColor(white: 1, alpha: 0.72)
        case .warn: return NSColor(srgbRed: 0x8a / 255, green: 0x8f / 255, blue: 0x98 / 255, alpha: 1)
        case .error: return errorTone
        case .mark: return markTone
        }
    }

    /// The pill's ground and hairline, 20 tall, 6 pt under the island's bottom edge, centred on it.
    private func pillGround(_ cg: CGContext, width w: CGFloat, below island: NSRect) -> NSRect? {
        let rect = NSRect(x: island.midX - w / 2, y: island.maxY + 6, width: w, height: 20)
        guard rect.isFiniteRect else { BadNumber.noteOnce("NotchView pill", "\(rect)"); return nil }
        let box = NSBezierPath(roundedRect: rect, xRadius: 6, yRadius: 6)
        NSColor(srgbRed: 0x10 / 255, green: 0x10 / 255, blue: 0x10 / 255, alpha: 0.94).setFill(); box.fill()
        NSColor(white: 1, alpha: 0.22).setStroke(); box.lineWidth = 1; box.stroke()
        return rect
    }

    /// A pill with a solid symbol (or a tone dot) and its words: the gate's, a toast's,
    /// the mark-landed line. Returns the rect it covered.
    private func drawSlotPill(_ cg: CGContext, text: String, symbol: String?, tone: PillTone, below island: NSRect, alpha: CGFloat) -> NSRect? {
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: cg, flipped: true)
        defer { NSGraphicsContext.restoreGraphicsState() }
        cg.saveGState()
        cg.setAlpha(finite01(alpha))
        defer { cg.restoreGState() }
        let attrs = tone == .mark ? Self.markPillAttrs : Self.pillAttrs
        let tw = Self.textWidth(text as NSString, attrs)
        // The mark-landed line carries its glyph in the words ("◎ 1 circled · Go to ask"): no dot before it.
        let dot = symbol == nil && tone != .info && tone != .mark
        let iconW: CGFloat = symbol != nil ? 15 : (dot ? 10 : 0)
        guard let rect = pillGround(cg, width: tw + iconW + 16, below: island) else { return nil }
        var x = rect.minX + 8
        if let symbol, let img = Self.symbol(symbol, pointSize: 10, tint: Self.pillTint(tone)) {
            img.draw(in: NSRect(x: x, y: rect.midY - img.size.height / 2, width: img.size.width, height: img.size.height), from: .zero, operation: .sourceOver, fraction: finite01(alpha), respectFlipped: true, hints: nil)
            x += 15
        } else if dot {
            let c: RGB = tone == .error ? OrbPalette.error : OrbPalette.speaking
            NSColor(srgbRed: c.r, green: c.g, blue: c.b, alpha: 1).setFill()
            NSBezierPath(ovalIn: NSRect(x: x, y: rect.midY - 2.5, width: 5, height: 5)).fill()
            x += 10
        }
        Self.drawText(text as NSString, at: NSPoint(x: x, y: rect.minY + 3), attrs)
        return rect
    }

    /// The newest problem under the open island: the kind's glyph (amber for a missing
    /// grant or the Dock, red else), the text tail-truncated, the remedy's label as an
    /// inset 18 pt box (`Press.remedy`), "· +2" when more wait. Never wider than the panel.
    private func drawProblemPill(_ cg: CGContext, _ p: DockContent.ProblemRow, below island: NSRect, alpha: CGFloat, now: Double) -> NSRect? {
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: cg, flipped: true)
        defer { NSGraphicsContext.restoreGraphicsState() }
        cg.saveGState()
        cg.setAlpha(finite01(alpha))
        defer { cg.restoreGState() }
        let label = p.remedyLabel ?? "Retry"
        let labelW = Self.textWidth(label as NSString, Self.wordAttrs) + 12
        let more = p.more > 0 ? " · +\(p.more)" : ""
        let moreW = more.isEmpty ? 0 : Self.textWidth(more as NSString, Self.pillAttrs)
        let maxW = max(120, bounds.width - 8)
        let textW = min(Self.textWidth(p.text as NSString, Self.pillAttrs), maxW - 15 - 16 - labelW - 6 - moreW - 6)
        guard textW > 20 else { return nil }
        let w = 8 + 15 + textW + 6 + moreW + 6 + labelW + 8
        guard let rect = pillGround(cg, width: w, below: island) else { return nil }
        var x = rect.minX + 8
        if let img = Self.symbol(p.symbol, pointSize: 10, tint: p.warn ? Self.markTone : Self.errorTone) {
            img.draw(in: NSRect(x: x, y: rect.midY - img.size.height / 2, width: img.size.width, height: img.size.height), from: .zero, operation: .sourceOver, fraction: finite01(alpha), respectFlipped: true, hints: nil)
        }
        x += 15
        Self.drawText(p.text as NSString, in: NSRect(x: x, y: rect.minY + 3, width: textW, height: 15), Self.pillAttrsTruncating)
        x += textW + 6
        if !more.isEmpty {
            Self.drawText(more as NSString, at: NSPoint(x: x, y: rect.minY + 3), Self.pillAttrs)
            x += moreW + 6
        }
        // The remedy box: inset 18 pt, a ghost like Allow / Deny.
        let box = NSRect(x: x, y: rect.minY + 1, width: labelW, height: 18)
        let hot = hoveredButton == .remedy
        let down = pressing == .remedy
        let path = NSBezierPath(roundedRect: box, xRadius: 5, yRadius: 5)
        if down { Self.accent.setFill() } else { NSColor(white: 1, alpha: hot ? 0.16 : 0.08).setFill() }
        path.fill()
        let flash = flashLevel(.remedy, now: now)
        if flash > 0, !down { Self.accent.withAlphaComponent(flash).setFill(); path.fill() }
        NSColor(white: 1, alpha: 0.26).setStroke(); path.lineWidth = 1; path.stroke()
        Self.drawText(label as NSString, at: NSPoint(x: box.minX + 6, y: box.minY + 2), Self.wordAttrs)
        remedyRect = box
        return rect
    }

    // MARK: tooltips

    /// The controls' help text (a tooltip when the pointer rests on one; the whole view
    /// is one tooltip rect, the string chosen by the point).
    func helpText(for which: Press) -> String {
        let c = content
        switch which {
        case .pause:
            switch AppState.transportPress(for: sim.phase) {
            case .go: return "Go"
            case .pause: return "Pause"
            case .stop: return "Connecting"
            }
        case .stop: return "Stop"
        case .mute: return sim.phase == .muted ? "Unmute" : "Mute"
        case .face: return ""
        case .circle:
            if c.marking { return "Cancel circling (Esc)" }
            if !c.screenRecordingGranted { return "Circle something — needs Screen Recording (Request below)" }
            let n = c.pendingMarks
            return n > 0 ? "Circle something — \(n) waiting (⌥⇧C)" : "Circle something (⌥⇧C)"
        case .window:
            return c.screenRecordingGranted ? "Capture the front window for Jarhead" : "Capture the front window for Jarhead — needs Screen Recording"
        case .ask:
            if !awake { return c.typedWakes ? "What's this? — wakes · billed" : "What's this? — press Go first" }
            return c.pendingMarks > 0 ? "What's this? — ask about what you circled" : "What's this? — circle first, then ask"
        case .clear:
            let used = c.marks.filter(\.consumed).count
            return "Forget \(c.marks.count) circled" + (used > 0 ? " · \(used) already used" : "")
        case .allow, .deny:
            return c.question?.text ?? ""
        case .mark(let i):
            let shown = Array(c.marks.reversed())
            return i >= 0 && i < shown.count ? shown[i].caption : ""
        case .markForget(let i):
            let shown = Array(c.marks.reversed())
            return i >= 0 && i < shown.count && shown[i].isWindow ? "Forget this capture" : "Forget this circle"
        case .thread(let id):
            guard let row = c.threads.first(where: { $0.id == id }) else { return "" }
            var text = "\(row.name) · \(row.word)"
            if let q = row.asks, !q.isEmpty { text += " · " + q }
            return text
        case .threadStop(let id):
            let name = c.threads.first(where: { $0.id == id })?.name ?? "thread"
            return "Stop \(name)"
        case .console: return "Console (⌥⇧J)"
        case .sleep: return awake ? "Sleep — back to the notch" : "Asleep"
        case .remedy:
            guard let p = c.problem else { return "" }
            return p.text + (p.remedyLabel.map { " — " + $0 } ?? "")
        case .field:
            return ComposerWords.placeholder(phase: sim.phase, paused: sim.phase == .paused, typedWakes: c.typedWakes)
        }
    }

    /// The tooltip for a point: a control's, a chip's, or the meter's.
    private func tooltip(at p: NSPoint) -> String {
        if let b = button(at: p) { return helpText(for: b) }
        for (rect, text) in chipRects where rect.insetBy(dx: -2, dy: -2).contains(p) { return text }
        if mode == .island, parked {
            let l = islandLayout(in: islandOpenRect)
            if l.foot.contains(p) {
                let m = content.meter
                var parts: [String] = []
                if let b = m.billedSeconds { parts.append("Billed " + TransportFormat.billed(b)) }
                if let t = m.todaySeconds, t > 0 { parts.append("today " + TransportFormat.billed(t)) }
                return parts.joined(separator: " · ")
            }
        }
        return ""
    }

    /// `NSViewToolTipOwner`'s requirement is not main-actor in the SDK; AppKit asks on
    /// the main thread, so the isolation is assumed rather than inherited (an error in
    /// the Swift 6 language mode otherwise).
    nonisolated func view(_ view: NSView, stringForToolTip tag: NSView.ToolTipTag, point: NSPoint, userData data: UnsafeMutableRawPointer?) -> String {
        MainActor.assumeIsolated { tooltip(at: point) }
    }

    private func installToolTip() {
        removeAllToolTips()
        addToolTip(bounds, owner: self, userData: nil)
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        installToolTip()
        layoutField()
    }

    // MARK: accessibility

    /// Every live control is a child with its tooltip as label and a press as its
    /// action; the field is its own element (an NSTextField already is). Rebuilt when
    /// the hit list can have changed: content, mode, the field's focus.
    private var accessibilityButtons: [DockAccessibilityElement] = []

    private func rebuildAccessibility() {
        guard contentShown, parked else {
            if !accessibilityButtons.isEmpty || !(accessibilityChildren()?.isEmpty ?? true) {
                accessibilityButtons = []
                setAccessibilityChildren(fieldFocused ? [field] : [])
            }
            return
        }
        let rects = buttonRects(in: islandOpenRect)
        var elements: [DockAccessibilityElement] = []
        elements.reserveCapacity(rects.count)
        for (which, rect) in rects {
            let e = DockAccessibilityElement()
            e.setAccessibilityRole(.button)
            e.setAccessibilityLabel(helpText(for: which))
            e.setAccessibilityParent(self)
            e.setAccessibilityFrame(screenRect(rect))
            e.setAccessibilityEnabled(true)
            e.press = { [weak self] in self?.onPress?(which) }
            elements.append(e)
        }
        accessibilityButtons = elements
        var children: [Any] = elements
        children.append(field)
        setAccessibilityChildren(children)
    }

    /// A view rect (flipped) in screen coordinates (AppKit, y up).
    private func screenRect(_ r: NSRect) -> NSRect {
        guard let w = window else { return .zero }
        let f = w.frame
        return NSRect(x: f.minX + r.minX, y: f.maxY - r.maxY, width: r.width, height: r.height)
    }

    // MARK: mouse

    /// A drag out of the notch is running through this view (its mouse-down, its events).
    var isDragging: Bool { dragging }

    /// Only the ink takes the mouse: the island (and the notch's column, where nothing
    /// else lives), and the pill under it while it shows. A focused field takes its own
    /// clicks. Everything else in the panel is clear and falls through.
    override func hitTest(_ point: NSPoint) -> NSView? {
        guard parked else { return nil }
        let p = convert(point, from: superview)
        if fieldFocused, !field.isHidden, field.frame.contains(p) { return field }
        if islandRect.insetBy(dx: -2, dy: -2).contains(p) || notchRect.contains(p) { return self }
        if let pill = pillRect, pill.insetBy(dx: -2, dy: -2).contains(p) { return self }
        return nil
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    /// The control under `p` while the island is open — from the first frame of the
    /// open (the layout is fixed; the ink reveals it, and `hitTest` keeps clicks to the
    /// ink). The circle gets a point more slop than the boxes: it is the one most
    /// reached for; the row rects (a thread chip, the field) take none.
    private func button(at p: NSPoint) -> Press? {
        guard mode == .island, parked else { return nil }
        return buttonRects(in: islandOpenRect).first { which, rect in
            let slop: CGFloat
            switch which {
            case .pause: slop = 3
            case .thread, .field: slop = 0
            default: slop = 2
            }
            return rect.insetBy(dx: -slop, dy: -slop).contains(p)
        }?.0
    }

    override func mouseMoved(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        let b = button(at: p)
        if b != hoveredButton { hoveredButton = b; needsDisplay = true }
        let onPill = pillRect?.contains(p) ?? false
        onHover?(islandRect.contains(p) || onPill)
    }

    override func mouseExited(with event: NSEvent) {
        if hoveredButton != nil { hoveredButton = nil; needsDisplay = true }
    }

    override func mouseDown(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        downPoint = p
        dragging = false
        let b = button(at: p)
        // A click anywhere but the line while the field has key: the field lets go, text kept.
        if fieldFocused, b != .field {
            releaseField(keepText: true)
            onFieldRelease?(true)
        }
        if let b { pressing = b; needsDisplay = true }
    }

    override func mouseDragged(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        if dragging {
            onDragMoved?(CGSpace.point(fromAppKit: NSEvent.mouseLocation))
            return
        }
        guard let down = downPoint, pressing == nil, hypot(p.x - down.x, p.y - down.y) >= 6 else { return }
        // Pulled: the blob comes out of the notch into the hand.
        dragging = true
        onDragOut?(CGSpace.point(fromAppKit: NSEvent.mouseLocation))
    }

    override func mouseUp(with event: NSEvent) {
        defer { downPoint = nil; pressing = nil; needsDisplay = true }
        if dragging {
            dragging = false
            onDragEnded?()
            return
        }
        let p = convert(event.locationInWindow, from: nil)
        if let b = pressing, button(at: p) == b {
            // The press is felt: the accent stays on the button and lets go over `Motion.base`.
            if b != .field {
                flashPress = b
                flashAt = CACurrentMediaTime()
            }
            wake()
            onPress?(b)
        } else if islandRect.contains(p) || notchRect.contains(p) {
            onPress?(.face)
        }
    }
}

#if JARHEAD_ORB_PREVIEW
extension NotchView {
    /// The island's springs this frame — value → target, velocity — for the harness.
    var previewSpringReadout: String {
        String(format: "width %.2f→%.2f v %.2f | height %.2f→%.2f | open %.3f→%.0f",
               widthSpring.value, widthSpring.target, widthSpring.velocity, heightSpring.value, heightSpring.target, openSpring.value, openSpring.target)
    }
    /// The island rect as the springs give it (view coordinates), before any guard.
    var previewIslandRectRaw: NSRect { islandRect }
    /// The thread dots this view holds ("Slack:working Spotify:working"), for the harness.
    var previewThreadDots: String { threads.map { "\($0.name):\($0.status.rawValue)" }.joined(separator: " ") }

    /// Frames the gradient was drawn stretched (a size not yet rendered), since launch.
    nonisolated(unsafe) static var previewStretchedFrames = 0
    /// Draw timing since launch: frames, total and worst seconds (the harness's frame budget check).
    nonisolated(unsafe) static var previewDrawFrames = 0
    nonisolated(unsafe) static var previewDrawTotal = 0.0
    nonisolated(unsafe) static var previewDrawWorst = 0.0
    static func previewNoteDraw(_ seconds: Double) {
        previewDrawFrames += 1
        previewDrawTotal += seconds
        if seconds > previewDrawWorst { previewDrawWorst = seconds }
    }
    static var previewDrawReadout: String {
        String(format: "frames %ld avg %.2f ms worst %.2f ms", previewDrawFrames, previewDrawFrames > 0 ? previewDrawTotal / Double(previewDrawFrames) * 1000 : 0, previewDrawWorst * 1000)
    }

    /// The rows and boxes of the open island, x/y from the island's top-left: "S1 x…x y…y | …".
    var previewLayoutReadout: String {
        let island = islandOpenRect
        let l = islandLayout(in: island)
        func r(_ name: String, _ rect: NSRect) -> String {
            String(format: "%@ x%.0f–%.0f y%.0f–%.0f", name, rect.minX - island.minX, rect.maxX - island.minX, rect.minY - island.minY, rect.maxY - island.minY)
        }
        var parts = [r("transport", l.transport), r("S1", l.head), r("S2", l.line), r("S3", l.context), r("circle", l.circle), r("window", l.window)]
        for (i, t) in l.thumbs.enumerated() { parts.append(r("thumb\(i)", t)) }
        parts += [r("S4", l.threads), r("S5", l.foot), r("stop", l.stop), r("mute", l.mute), r("ask", l.ask), r("clear", l.clear),
                  r("allow", l.allow), r("deny", l.deny), r("console", l.console), r("sleep", l.sleep)]
        return String(format: "island %.0f×%.0f | ", island.width, island.height) + parts.joined(separator: " | ")
    }

    /// The live hit list — name and rect (x/y from the island's top-left) — as `buttonRects` gives it.
    var previewHitList: [(name: String, rect: NSRect)] {
        let island = islandOpenRect
        return buttonRects(in: island).map { (Self.previewName(of: $0.0), $0.1.offsetBy(dx: -island.minX, dy: -island.minY)) }
    }
    /// Whether a control is in the hit list right now (an island must be open for any to be).
    func previewIsHittable(_ p: Press) -> Bool { buttonRects(in: islandOpenRect).contains { $0.0 == p } }
    /// The chips on the peek, in order, as "kind:figure".
    var previewChips: [String] { chips.map { "\(Self.previewName(of: $0.kind)):\($0.figure)" } }
    /// What the peek grows by for the chips (pt) and the width the peek is springing to.
    var previewChipsExtraWidth: CGFloat { chipsExtraWidth }
    var previewPeekWidthTarget: CGFloat { CGFloat(widthSpring.target) }
    /// The pill slot's words right now ("" without one) and which slot it is.
    var previewPillText: String {
        switch slot(now: CACurrentMediaTime(), open: finite01(CGFloat(openSpring.value))) {
        case .gate(let g): return g.text
        case .pill(let p): return p.text
        case .problem(let p): return p.text
        case nil: return ""
        }
    }
    var previewPillKind: String {
        switch slot(now: CACurrentMediaTime(), open: finite01(CGFloat(openSpring.value))) {
        case .gate: return "gate"
        case .pill(let p): return p.tone == .mark ? "mark-landed" : "toast"
        case .problem: return "problem"
        case nil: return ""
        }
    }
    /// The lip's marks chip ("◎2"), or "" — tucked with pending marks.
    var previewLipChip: String { mode == .tucked && content.pendingMarks > 0 ? "◎\(content.pendingMarks)" : "" }
    /// The lip glow's colour name this frame: "mark" while marks wait, else "phase".
    var previewLipGlow: String { mode == .tucked && content.pendingMarks > 0 ? "mark" : "phase" }
    /// The S2 line's words as drawn (the field's own text while it has key).
    var previewLineText: String {
        if fieldFocused { return field.stringValue }
        if let q = content.question { return "✋ \(q.name) asks · \(q.text)" }
        if workingSince != nil, let r = content.request, !r.isEmpty { return r }
        if !lastLine.isEmpty { return lastLine }
        if !awake, let g = content.gateLabel, !g.isEmpty { return g }
        return "—"
    }
    /// The foot's words as drawn, and whether it is the dimmed paused line.
    var previewFootText: String { footText(now: CACurrentMediaTime()).text }
    var previewFootDim: Bool { footText(now: CACurrentMediaTime()).dim }
    /// The alpha a box is drawn at relative to the row (1, 0.45 dimmed Circle/Window, 0.35 dead).
    func previewBoxDim(_ name: String) -> CGFloat {
        guard let p = Press(previewName: name) else { return 0 }
        switch p {
        case .mute: return muteEnabled ? 1 : 0.35
        case .ask: return askEnabled ? 1 : 0.35
        case .sleep: return awake ? 1 : 0.35
        case .circle, .window: return content.screenRecordingGranted ? 1 : 0.45
        default: return 1
        }
    }
    /// The thumbnail slots this frame: "slot:id:pending|used:crop|skeleton" and the overflow count.
    var previewThumbs: [String] {
        let l = islandLayout(in: islandOpenRect)
        let t = thumbSlots(l)
        var out = t.slots.map { "\($0.index):\($0.mark.id):\($0.mark.consumed ? "used" : "pending"):\($0.mark.thumbnail == nil ? "skeleton" : "crop")" }
        if let o = t.overflow { out.append("+\(o.count)") }
        return out
    }
    /// The thread chips on S4 as drawn: "id:text:stop|nostop".
    var previewThreadChips: [String] {
        threadChips(islandLayout(in: islandOpenRect), now: Date()).map { "\($0.row.id):\($0.text):\($0.stop == nil ? "nostop" : "stop")" }
    }
    /// The field: focused, its text, and whether the panel may become key right now.
    var previewFieldFocused: Bool { fieldFocused }
    var previewFieldText: String {
        get { field.stringValue }
        set { field.stringValue = newValue }
    }
    /// Return / Escape in the field, as the delegate would see them.
    func previewFieldReturn() { sayFromField() }
    func previewFieldEscape() { releaseField(keepText: true); onFieldRelease?(true) }
    /// Hover a control by name (nil clears).
    func previewSetHovered(_ name: String?) { hoveredButton = name.flatMap { Press(previewName: $0) }; needsDisplay = true }
    /// The accessibility children (buttons + the field) and the hit rects, for the "children == hit rects" check.
    var previewAccessibilityButtonCount: Int { accessibilityButtons.count }
    var previewAccessibilityChildCount: Int { accessibilityChildren()?.count ?? 0 }
    var previewHitRectCount: Int { buttonRects(in: islandOpenRect).count }
    /// The content's alpha and rise for element `i` this frame (nil: not drawn).
    func previewContentAppearance(_ i: Int) -> (alpha: CGFloat, dy: CGFloat)? { contentAppearance(i, now: CACurrentMediaTime()) }
    /// The content fade's clock: shown, seconds since it began appearing / leaving (−1 = snapped).
    var previewContentClock: String {
        let now = CACurrentMediaTime()
        let opened = contentOpenedAt < 0 ? -1 : now - contentOpenedAt
        let closed = contentClosedAt < 0 ? -1 : now - contentClosedAt
        return "shown \(contentShown ? 1 : 0) opened \(String(format: "%.3f", opened)) closed \(String(format: "%.3f", closed)) reduced \(reduced ? 1 : 0)"
    }
    /// The pulse value this frame (0.5 held under Reduce Motion).
    var previewPulse: CGFloat { pulse(CACurrentMediaTime()) }
    /// The tooltip at a point (x/y from the island's top-left).
    func previewTooltip(atIsland p: NSPoint) -> String {
        let island = islandOpenRect
        return tooltip(at: NSPoint(x: island.minX + p.x, y: island.minY + p.y))
    }
    func previewTooltip(_ name: String) -> String { Press(previewName: name).map { helpText(for: $0) } ?? "" }

    static func previewName(of p: Press) -> String {
        switch p {
        case .pause: return "pause"
        case .stop: return "stop"
        case .mute: return "mute"
        case .face: return "face"
        case .circle: return "circle"
        case .window: return "window"
        case .ask: return "ask"
        case .clear: return "clear"
        case .allow: return "allow"
        case .deny: return "deny"
        case .mark(let i): return "mark:\(i)"
        case .markForget(let i): return "forget:\(i)"
        case .thread(let id): return "thread:\(id)"
        case .threadStop(let id): return "threadStop:\(id)"
        case .console: return "console"
        case .sleep: return "sleep"
        case .remedy: return "remedy"
        case .field: return "field"
        }
    }

    private static func previewName(of k: Chip.Kind) -> String {
        switch k {
        case .question: return "question"
        case .marks: return "marks"
        case .problem: return "problem"
        case .meter: return "meter"
        case .marking: return "marking"
        }
    }

    /// The working strip's alphas, measured rather than read off the code: the strip
    /// alone is rendered into a bitmap at forced park / work levels, and the hairline
    /// (the chromatic pixels — the phase colour) and the counter (the achromatic ones —
    /// white text) are summed as brightness over black, each as a fraction of the full
    /// strip's (park 0, work 1). Both must follow work · (1 − park): 0.5 at park ½ and
    /// 0.5 at work ½ — the formula the strip had before the fleet, which the settled
    /// shots and the printed mode lines cannot see (only the 0.24 s transitions differ).
    /// Needs the counter ("Working · m:ss": ORB_NOTCH_WORKING=1 in an acting phase) and
    /// no live threads (the dots are chromatic too, and hold at 1 − park by design).
    func previewStripProbe() -> String {
        func render(park: CGFloat, work: CGFloat) -> (hair: Double, text: Double)? {
            previewForcedLevels = (park, work)
            previewStripOnly = true
            defer { previewForcedLevels = nil; previewStripOnly = false }
            guard let rep = bitmapImageRepForCachingDisplay(in: bounds) else { return nil }
            cacheDisplay(in: bounds, to: rep)
            guard let data = rep.bitmapData else { return nil }
            let w = rep.pixelsWide, h = rep.pixelsHigh, bpr = rep.bytesPerRow, spp = rep.samplesPerPixel
            var hair = 0.0, text = 0.0
            for y in 0..<h {
                let row = data + y * bpr
                for x in 0..<w {
                    let p = row + x * spp
                    let r = Double(p[0]), g = Double(p[1]), b = Double(p[2])
                    let hi = max(r, g, b), lo = min(r, g, b)
                    guard hi > 8 else { continue }
                    if hi - lo > 24 { hair += hi } else { text += hi }
                }
            }
            return (hair, text)
        }
        guard threads.isEmpty else { return "notch strip probe: skipped — threads live (the dots would count as hairline)" }
        guard let full = render(park: 0, work: 1) else { return "notch strip probe: nothing rendered" }
        guard full.hair > 0, full.text > 0 else {
            return String(format: "notch strip probe: full strip hairline %.0f text %.0f — no counter? (ORB_NOTCH_WORKING=1 ORB_NOTCH_PHASE=acting)", full.hair, full.text)
        }
        guard let halfPark = render(park: 0.5, work: 1), let halfWork = render(park: 0, work: 0.5) else { return "notch strip probe: nothing rendered" }
        let hp = halfPark.hair / full.hair, tp = halfPark.text / full.text
        let hw = halfWork.hair / full.hair, tw = halfWork.text / full.text
        let ok = [hp, tp, hw, tw].allSatisfy { abs($0 - 0.5) <= 0.08 }
        return String(format: "notch strip probe: hairline %.2f @park½ %.2f @work½ | counter %.2f @park½ %.2f @work½ (want 0.50 each = work·(1−park); full hairline %.0f counter %.0f) %@",
                      hp, hw, tp, tw, full.hair, full.text, ok ? "OK" : "FAIL")
    }
}

extension NotchView.Press {
    /// The harness's names for the island's controls (ORB_NOTCH_HOVER / ORB_NOTCH_PRESSED,
    /// `NotchDock.previewPress`): pause|go|transport, stop, mute, circle, window, ask,
    /// clear, allow, deny, console, sleep, remedy, field, mark:N, forget:N, thread:ID, threadStop:ID.
    init?(previewName: String) {
        let name = previewName.trimmingCharacters(in: .whitespaces)
        if let rest = name.split(separator: ":", maxSplits: 1).dropFirst().first {
            let head = name.prefix { $0 != ":" }.lowercased()
            let tail = String(rest)
            switch head {
            case "mark": guard let i = Int(tail) else { return nil }; self = .mark(i)
            case "forget": guard let i = Int(tail) else { return nil }; self = .markForget(i)
            case "thread": self = .thread(tail)
            case "threadstop": self = .threadStop(tail)
            default: return nil
            }
            return
        }
        switch name.lowercased() {
        case "pause", "go", "transport": self = .pause
        case "stop": self = .stop
        case "mute": self = .mute
        case "face": self = .face
        case "circle": self = .circle
        case "window": self = .window
        case "ask": self = .ask
        case "clear": self = .clear
        case "allow": self = .allow
        case "deny": self = .deny
        case "console": self = .console
        case "sleep": self = .sleep
        case "remedy": self = .remedy
        case "field": self = .field
        default: return nil
        }
    }
}
#endif

private extension NSImage {
    /// A template symbol in one colour.
    func tinted(_ color: NSColor) -> NSImage {
        let img = NSImage(size: size, flipped: false) { rect in
            self.draw(in: rect)
            color.set()
            rect.fill(using: .sourceAtop)
            return true
        }
        img.isTemplate = false
        return img
    }
}
