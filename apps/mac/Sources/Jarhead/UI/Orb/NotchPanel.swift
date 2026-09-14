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
//   island   hover (or the capsule toggle, ⌥⇧Return): 420×184, sprung open
//            (`Motion.island`), a composed control surface of four bands that never
//            reflow — an ANCHOR column at the left (the face at (57, 40), the phase word
//            under it, Go · Stop · Mute at its foot), a DISPLAY on the black pool under
//            the notch (a mono head line — the level trace, `Working · m:ss`, `✋ Slack
//            asks`, `◎ 2` or a film's caption at the right end — then the hero: one
//            18 pt line to three, the thread's question, the running delegation's
//            request, the last thing said or the gate's words asleep; under it, by kind:
//            tiles for live threads or a chip line at 3+, Allow · Deny with the
//            thumbnails as minis while a question waits, or 84×60 films of what was
//            circled), a CONTROL ROW (the Say box in the middle, the circling keys —
//            Clear · Circle · Window · Ask — as one strip at the right) and a FOOT (the
//            meter as `4:12` · a dithered bar · figures, or the problem row with its
//            remedy; Console · Sleep as a pair in the corner; the phase hairline). The
//            content fades in and rises a few points in six beats (≤ 150 ms stagger) as
//            the island opens and fades on close (none of the rise or stagger under
//            Reduce Motion); a kind change swaps the display while the anchor and the
//            foot hold still; it contracts 600 ms after the pointer leaves. A global
//            mouse-moved monitor (no Accessibility grant needed) sees the pointer
//            approach while the island is small.
//   pill     a 20 pt slot 6 pt under the island (or the lip): the wake gate's
//            question / verdict / countdown asleep, else a toast for 1.5 s, else
//            `◎ 1 circled · Go to ask` for 6 s after a mark lands while tucked. A
//            problem is never a pill: open, it is the foot row; folded, the peek chip.
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
    /// Room under the menu bar: the island (184) plus the 44 pt pill slot beneath it.
    static let drop: CGFloat = 44 + 184
    static let islandWidth: CGFloat = 420
    static let islandHeight: CGFloat = 184
    /// The peek never grows past this (the old island's width): the chips drop from the
    /// right first (`NotchView.relayoutChips`), and no new resting sizes need prewarming.
    static let peekWidthCap: CGFloat = 360
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
    /// The running delegation's request (the hero while working).
    var request: String?
    /// The last transcript line (the hero otherwise).
    var lastLine: String?
    /// The wake gate's words (the hero asleep).
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
    /// the overlay owns the stroke then. Everywhere else — the clear 460×261 pt over the
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
    /// The problem row's remedy box (the foot, with the island open).
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
        view.focusField(placeholder: view.fieldPlaceholder())
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
    /// are thumbnail slots (films or minis), newest first; `.thread(id)` / `.threadStop(id)`
    /// a thread's tile (or chip) and its Stop, or the head's source row while it asks;
    /// `.field` the Say box; `.remedy` the foot's remedy box.
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
    /// The transport circle's diameter (Go, the one circle).
    static let transportDiameter: CGFloat = 22
    /// A hairline box, and one cell of a strip.
    static let boxSize = NSSize(width: 26, height: 24)
    /// A thumbnail as a mini (the question kind, right of Allow · Deny).
    static let miniSize = NSSize(width: 30, height: 22)
    /// A thumbnail as a film (the marks kind: three across the display).
    static let filmSize = NSSize(width: 84, height: 60)
    /// A thread's tile (the plain kind, one or two threads).
    static let tileSize = NSSize(width: 140, height: 32)
    /// The meter's bar in the foot and the level trace in the head: 6 pt = four rows of 1.5 pt dither cells.
    static let barSize = NSSize(width: 88, height: 6)
    static let traceSize = NSSize(width: 96, height: 6)
    /// The hero's line pitch (18 pt SF Pro).
    static let heroPitch: CGFloat = 22
    /// The island's content elements, for the stagger: the anchor deck, the word + head, the hero, the middle, the control row, the foot.
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
                // The request is the hero only while working: the flip is a hero change,
                // compared now (it arrives by its own sink, after the content).
                noteCanvasChanges()
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
            noteCanvasChanges()
            rebuildAccessibility()
            wake()
        }
    }
    /// When `content` last changed (CACurrentMediaTime): the meter's elapsed keeps counting from it.
    private var contentAt = 0.0

    /// The display's kind last frame, and when it changed with the island open: beats 1–4
    /// leave over `Motion.quick` and re-enter with their stagger (the anchor and the foot hold).
    private var lastKind = CanvasKind.plain
    private var canvasChangedAt = -1.0
    /// The hero's identity — `hash(kind, text)` — and when it changed: the old line leaves
    /// over `quick`, the new arrives over `base`; a counter tick never re-animates it.
    private var heroKey = 0
    private var heroChangedAt = -1.0
    private var heroPrevious: (lines: [NSString], attrs: [NSAttributedString.Key: Any])?
    /// The meter bar's fill easing from → to over `Motion.base` from `at` (< 0: snapped).
    private var meterFillFrom: CGFloat = 0
    private var meterFillTo: CGFloat = 0
    private var meterFillAt = -1.0

    /// A kind or hero change's whole window: the leave over `quick`, the arrival over
    /// `base`, the last display beat's stagger. `isAnimating` keeps the link alive for
    /// it; a hero change inside a kind swap's window rides the swap (no second motion).
    private var swapWindow: Double { seconds(Motion.quick) + seconds(Motion.base) + Double(Self.contentElements) * Motion.stagger }

    /// After any change to what the display shows — `content`, the last line, the working
    /// state (each has its own setter; the hero reads all three): the kind, the hero and
    /// the meter's target are compared with the last frame's, and each that moved starts
    /// its own window. Only with the island's content shown (a change while folded snaps:
    /// the content arrives whole with the open).
    private func noteCanvasChanges() {
        let now = CACurrentMediaTime()
        let live = contentShown && window != nil
        let kind = currentKind
        if kind != lastKind {
            lastKind = kind
            canvasChangedAt = live ? now : -1
            heroLinesCache = nil
        }
        let choice = heroChoice()
        var hasher = Hasher()
        hasher.combine(kind.rawValue); hasher.combine(choice.text)
        let key = hasher.finalize()
        if key != heroKey {
            // The window, not the sign: `canvasChangedAt` is never reset, so `< 0` would
            // latch the hero to a snap after the first kind change on an open island.
            let kindSwapping = canvasChangedAt >= 0 && now - canvasChangedAt < swapWindow
            if live, let cached = heroLinesCache, !cached.lines.isEmpty, !kindSwapping {
                heroPrevious = (cached.lines, cached.attrs)
                heroChangedAt = now
                #if JARHEAD_ORB_PREVIEW
                Self.previewHeroSwaps.append((cached.lines.map { $0 as String }.joined(separator: " "), choice.text, now))
                #endif
            } else {
                heroPrevious = nil
                heroChangedAt = -1
            }
            heroKey = key
            heroLinesCache = nil
        }
        let target = meterFillTarget()
        if abs(target - meterFillTo) > 0.0005 {
            meterFillFrom = live ? meterFill(now) : target
            meterFillTo = target
            meterFillAt = live && !reduced ? now : -1
        }
    }

    /// The bar's fill: billed ÷ max(today, billed) in session or paused; 0 asleep (a track only).
    private func meterFillTarget() -> CGFloat {
        let m = content.meter
        guard m.inSession || m.paused, let b = m.billedSeconds, b.isFinite, b >= 0 else { return 0 }
        let today = m.todaySeconds ?? 0
        let denominator = max(today.isFinite ? today : 0, b)
        guard denominator > 0 else { return 0 }
        return finite01(CGFloat(b / denominator))
    }

    /// The fill this frame, eased over `Motion.base` on `Motion.easeOut` (snapped under Reduce Motion).
    private func meterFill(_ now: Double) -> CGFloat {
        guard meterFillAt >= 0 else { return meterFillTo }
        let t = finite01((now - meterFillAt) / seconds(Motion.base))
        let e = CGFloat(Motion.easeOutCurve.value(at: t))
        return finite01(meterFillFrom + (meterFillTo - meterFillFrom) * e)
    }

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
    /// The hero: the one big line, 18 pt SF Pro regular on a 22 pt pitch.
    private static let heroFont = NSFont.systemFont(ofSize: 18, weight: .regular)
    /// Allow · Deny and the remedy's label: 12 medium.
    private static let actionFont = NSFont.systemFont(ofSize: 12, weight: .medium)
    /// The Say box's placeholder at rest: the field's own 12 pt SF Pro.
    private static let fieldFont = NSFont.systemFont(ofSize: 12)
    private static let overflowLargeFont = NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .regular)
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
    /// The tiles' meta, the chip line and the foot's figures: the counter's mono at the same step, truncating at the end.
    private static let threadAttrs: [NSAttributedString.Key: Any] = [.font: pillFont, .foregroundColor: NSColor(white: 1, alpha: 0.72), .paragraphStyle: truncating]
    private static let threadShadow: [NSAttributedString.Key: Any] = [.font: pillFont, .foregroundColor: NSColor(white: 0, alpha: 0.55), .paragraphStyle: truncating]
    /// The paused foot, a step dimmer.
    private static let footPausedAttrs: [NSAttributedString.Key: Any] = [.font: pillFont, .foregroundColor: NSColor(white: 1, alpha: 0.48), .paragraphStyle: truncating]
    /// Mono words at the empty step (the hint face; "Circle something · ⌥⇧C" now lives in Circle's tooltip).
    private static let hintAttrs: [NSAttributedString.Key: Any] = [.font: lineFont, .foregroundColor: NSColor(white: 1, alpha: 0.46), .paragraphStyle: truncating]
    /// The mono "+3" in a thumbnail slot.
    private static let overflowAttrs: [NSAttributedString.Key: Any] = [.font: pillFont, .foregroundColor: NSColor(white: 1, alpha: 0.72)]
    /// Allow / Deny and the remedy box: 11 medium.
    private static let wordAttrs: [NSAttributedString.Key: Any] = [.font: wordFont, .foregroundColor: NSColor(white: 1, alpha: 0.92)]
    /// The hero at its three steps — 0.92 (the request, the last line), 1.0 (a question), 0.72 (the gate's words) — each tail-truncating, with an ink shadow.
    private static let heroAttrs: [NSAttributedString.Key: Any] = [.font: heroFont, .foregroundColor: NSColor(white: 1, alpha: 0.92), .paragraphStyle: truncating]
    private static let heroBrightAttrs: [NSAttributedString.Key: Any] = [.font: heroFont, .foregroundColor: NSColor.white, .paragraphStyle: truncating]
    private static let heroCalmAttrs: [NSAttributedString.Key: Any] = [.font: heroFont, .foregroundColor: NSColor(white: 1, alpha: 0.72), .paragraphStyle: truncating]
    private static let heroShadow: [NSAttributedString.Key: Any] = [.font: heroFont, .foregroundColor: NSColor(white: 0, alpha: 0.6), .paragraphStyle: truncating]
    /// Allow · Deny, the remedy's label: 12 medium at 0.92.
    private static let actionAttrs: [NSAttributedString.Key: Any] = [.font: actionFont, .foregroundColor: NSColor(white: 1, alpha: 0.92)]
    /// The "+3" on a film: 13 mono digits.
    private static let overflowLargeAttrs: [NSAttributedString.Key: Any] = [.font: overflowLargeFont, .foregroundColor: NSColor(white: 1, alpha: 0.72)]
    /// The problem row: the noun bright, the clause a step dimmer, both mono.
    private static let problemNounAttrs: [NSAttributedString.Key: Any] = [.font: lineFont, .foregroundColor: NSColor(white: 1, alpha: 0.92), .paragraphStyle: truncating]
    private static let problemClauseAttrs: [NSAttributedString.Key: Any] = [.font: lineFont, .foregroundColor: NSColor(white: 1, alpha: 0.62), .paragraphStyle: truncating]
    /// The Say box's placeholder at rest, the field's own face at the empty step.
    private static let placeholderAttrs: [NSAttributedString.Key: Any] = [.font: fieldFont, .foregroundColor: NSColor(white: 1, alpha: 0.46), .paragraphStyle: truncating]
    /// The head's dim figures: `◎ 2` once every mark is used, a film's caption.
    private static let headDimAttrs: [NSAttributedString.Key: Any] = [.font: pillFont, .foregroundColor: NSColor(white: 1, alpha: 0.46), .paragraphStyle: truncating]
    /// The mark-landed pill's words, the meter's mono in the mark tone.
    private static let markPillAttrs: [NSAttributedString.Key: Any] = [.font: pillFont, .foregroundColor: markTone]
    /// The `◎ N` in the head while marks are pending, the mark tone.
    private static let headMarkAttrs: [NSAttributedString.Key: Any] = [.font: pillFont, .foregroundColor: markTone]

    /// The island's own short placeholders, for when `ComposerWords.placeholder` does not
    /// fit the Say box (`fieldPlaceholder`): one per state, never over four words.
    private static func shortPlaceholder(phase: Phase, paused: Bool, typedWakes: Bool) -> String {
        if paused { return "Type to resume" }
        if phase == .asleep { return typedWakes ? "Type to wake…" : "Asleep · press Go" }
        return "Say something…"
    }
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
        let z = zones(in: islandOpenRect)
        guard z.isFinite else { return }
        field.frame = z.field.insetBy(dx: 6, dy: 2)
    }

    /// The Say box's placeholder: the shared `ComposerWords.placeholder` when it fits the
    /// box (its width less 16 of padding), else the island's own short string for the
    /// state. The same words draw in the box at rest and seed the field when it takes key.
    func fieldPlaceholder() -> String {
        let phase = sim.phase
        let paused = phase == .paused
        let shared = ComposerWords.placeholder(phase: phase, paused: paused, typedWakes: content.typedWakes)
        let room = zones(in: islandOpenRect).field.width - 16
        if Self.textWidth(shared as NSString, Self.placeholderAttrs) <= room { return shared }
        return Self.shortPlaceholder(phase: phase, paused: paused, typedWakes: content.typedWakes)
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
        _ = Self.heroAttrs; _ = Self.heroBrightAttrs; _ = Self.heroCalmAttrs; _ = Self.heroShadow; _ = Self.actionAttrs
        _ = Self.overflowLargeAttrs; _ = Self.problemNounAttrs; _ = Self.problemClauseAttrs; _ = Self.placeholderAttrs
        _ = Self.headDimAttrs; _ = Self.headMarkAttrs; _ = Self.threadAttrs; _ = Self.overflowAttrs
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
                // Never past the peek's cap: the chips drop from the right first (`relayoutChips`), and what still does not fit is not drawn.
                widthSpring.target = min(NotchGeometry.peekWidthCap, n + (workingSince != nil ? Self.workExtraWidth : 0) + peekDotsExtraWidth + chipsExtraWidth)
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
        // A kind or hero change mid-open, the meter's fill on its way.
        let swap = swapWindow
        if canvasChangedAt >= 0, now - canvasChangedAt < swap { return true }
        if heroChangedAt >= 0, now - heroChangedAt < swap { return true }
        if meterFillAt >= 0, now - meterFillAt < base { return true }
        return false
    }

    /// The level trace is live: the island open, in a session, listening or speaking.
    private var traceLive: Bool {
        contentShown && parked && muteEnabled && (sim.phase == .listening || sim.phase == .speaking)
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
        if traceLive { return true }
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
            widthSpring.target = min(Double(NotchGeometry.peekWidthCap), Double(n) + (sim.reducedMotion ? 0 : 30 * finite01(sim.islandLevel)) + Double(Self.workExtraWidth * workLevel(now) + peekDotsExtraWidth + chipsExtraWidth))
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

    /// The island content's beat `i` (0 the anchor deck, 1 the word and the head, 2 the
    /// hero, 3 the middle, 4 the control row, 5 the foot): its alpha and rise (pt, + is
    /// down) this frame — appearing over `Motion.base` on `Motion.easeOut`, from 6 pt
    /// below, `Motion.stagger` after the one before (a plain fade, together, under Reduce
    /// Motion); leaving over `Motion.quick` on `Motion.easeIn`, drifting 4 pt up into the
    /// bar. A kind change while open: beats 1–4 leave over `quick` and re-enter with the
    /// stagger (a crossfade under Reduce Motion); 0 and 5 hold. Nil: not drawn.
    private func contentAppearance(_ i: Int, now: Double) -> (alpha: CGFloat, dy: CGFloat)? {
        if contentShown {
            var alpha: CGFloat = 1, dy: CGFloat = 0
            if contentOpenedAt >= 0 {
                let delay = reduced ? 0 : Double(i) * Motion.stagger
                let t = finite01((now - contentOpenedAt - delay) / seconds(Motion.base))
                let e = Motion.easeOutCurve.value(at: t)
                alpha = CGFloat(e); dy = reduced ? 0 : CGFloat(6 * (1 - e))
            }
            if canvasChangedAt >= 0, i >= 1, i <= 4 {
                let swap = kindSwapAppearance(i, now: now)
                alpha = min(alpha, swap.alpha)
                dy += swap.dy
            }
            return (finite01(alpha), dy.isFinite ? dy : 0)
        }
        guard contentClosedAt >= 0 else { return nil }
        let t = finite01((now - contentClosedAt) / seconds(Motion.quick))
        if t >= 1 { return nil }
        let e = Motion.easeInCurve.value(at: t)
        return (CGFloat(1 - e), reduced ? 0 : CGFloat(-4 * e))
    }

    /// A display beat's dip and return across a kind change: out over `Motion.quick`
    /// (`easeIn`, −4 pt), then in over `Motion.base` (`easeOut`, from +6) `stagger` × (i − 1)
    /// after the first display beat. Reduce Motion: a crossfade, no rise, no stagger.
    private func kindSwapAppearance(_ i: Int, now: Double) -> (alpha: CGFloat, dy: CGFloat) {
        let quick = seconds(Motion.quick)
        let t = now - canvasChangedAt
        if t < quick {
            let e = Motion.easeInCurve.value(at: finite01(t / quick))
            return (CGFloat(1 - e), reduced ? 0 : CGFloat(-4 * e))
        }
        let delay = reduced ? 0 : Double(i - 1) * Motion.stagger
        let u = finite01((t - quick - delay) / seconds(Motion.base))
        let e = Motion.easeOutCurve.value(at: u)
        return (CGFloat(e), reduced ? 0 : CGFloat(6 * (1 - e)))
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
    /// the anchor's head (island) with `open`, growing on the way (17 → 27.2 pt).
    private struct FaceLayout {
        let centre: CGPoint
        let size: Double
        let gap: CGFloat
        /// Where the face ends, for what follows it on the peek.
        var right: CGFloat { centre.x + gap / 2 + CGFloat(size) * 0.6 }
    }

    /// `shift` moves the small island's face (peek, tucked) sideways — while working the
    /// face gives half the counter's width so face + counter stay centred under the notch.
    /// Open, the face is the anchor's head at (57, 40), level with the hero's first line.
    private func faceLayout(island: NSRect, open: CGFloat, lipFace: Bool, shift: CGFloat = 0) -> FaceLayout {
        let size = (lipFace ? BlobSim.eyeSizePt * 0.85 : BlobSim.eyeSizePt) * Double(1 + 0.6 * open)
        let gap = CGFloat(size) * 0.95
        let x = island.minX + (island.width / 2) * (1 - open) + 57 * open + (shift.isFinite ? shift : 0) * (1 - open)
        let y = island.minY + (island.height / 2) * (1 - open) + 40 * open + (lipFace ? -1 : 0)
        return FaceLayout(centre: CGPoint(x: x, y: y), size: size, gap: gap)
    }

    /// What the display shows under the hero: tiles (or the chip line) for live threads,
    /// Allow · Deny with the minis while a question waits, films while circles are pending.
    enum CanvasKind: String { case plain, question, marks }

    /// The kind is a pure function of the content (the harness reads it): the question is
    /// the hero and Allow · Deny the only big actions; pending circles take the middle;
    /// otherwise the hero with the threads' tiles. Consumed-only marks do not switch it —
    /// they are a dim `◎ N` in the head.
    static func canvasKind(_ c: DockContent) -> CanvasKind {
        if c.question != nil { return .question }
        if c.pendingMarks > 0 { return .marks }
        return .plain
    }

    /// The kind this frame: the content's, or the one the harness forces (ORB_NOTCH_KIND).
    private var currentKind: CanvasKind {
        #if JARHEAD_ORB_PREVIEW
        if let k = Self.previewForcedKind { return k }
        #endif
        return Self.canvasKind(content)
    }

    /// The open island's zones, laid out in `island` (the open rect): x from the island's
    /// left edge, y from its top, fixed for the life of a kind — nothing reflows as
    /// content comes and goes. The budget (points):
    ///
    ///   anchor   face centre (57, 40) · word (14, 60, 86, 16) · go (14, 123, 22, 22) · stop (42, 122, 26, 24) · mute (74, 122, 26, 24)
    ///   head     (114, 12, 292, 18): the left span — trace (114, 18, 96, 6) · counter · `✋ Name asks`; the right span ends at 406 — `◎ N` · the film caption
    ///   hero     (114, 30, 292, 66): lines at y 30 / 52 / 74, pitch 22 — 3 plain without tiles, 2 with tiles or a question, 1 with films
    ///   middle   tiles (114, 80, 140, 32) / (266, 80, 140, 32) · chips (114, 86, 292, 20) · allow (114, 82, 84, 28) / deny (206, 82, 84, 28)
    ///            minis (340, 85, 30, 22) / (376, 85, 30, 22) · films (114 / 206 / 298, 56, 84, 60)
    ///   control  field (114, 122, 176, 24) · clear (302) | circle (328) | window (354) | ask (380), 26×24 at y 122, one strip
    ///   foot     seam y 153.5 · footLeft (14, 160, 40, 16) · bar (60, 165, 88, 6) · footRight (156, 160, 186, 16) · console (354, 156) | sleep (380, 156)
    ///            the problem row in the meter's place: remedy right-aligned to 342, 18 tall at y 159 · the phase hairline at y 183.5
    private struct Zones {
        let face: CGPoint
        let word: NSRect
        let go: NSRect
        let stop: NSRect
        let mute: NSRect
        let head: NSRect
        let headLeft: NSRect
        let headRight: NSRect
        let trace: NSRect
        let hero: NSRect
        let heroLines: Int
        let tile0: NSRect
        let tile1: NSRect
        let chips: NSRect
        let allow: NSRect
        let deny: NSRect
        let mini: [NSRect]
        let film: [NSRect]
        let field: NSRect
        let clear: NSRect
        let circle: NSRect
        let window: NSRect
        let ask: NSRect
        let footSeamY: CGFloat
        let footLeft: NSRect
        let bar: NSRect
        let footRight: NSRect
        let foot: NSRect
        let remedy: NSRect?
        let console: NSRect
        let sleep: NSRect
        let kind: CanvasKind
        /// Every rect a number: the only layout that reaches a draw.
        var isFinite: Bool {
            let rects = [word, go, stop, mute, head, headLeft, headRight, trace, hero, tile0, tile1, chips, allow, deny,
                         field, clear, circle, window, ask, footLeft, bar, footRight, foot, console, sleep] + mini + film
            guard rects.allSatisfy({ $0.isFiniteRect }), face.isFinitePoint, footSeamY.isFinite else { return false }
            if let r = remedy, !r.isFiniteRect { return false }
            return true
        }
    }

    private func zones(in island: NSRect) -> Zones {
        let x0 = island.minX, y0 = island.minY
        let box = Self.boxSize
        let kind = currentKind
        func at(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) -> NSRect { NSRect(x: x0 + x, y: y0 + y, width: w, height: h) }
        let face = CGPoint(x: x0 + 57, y: y0 + 40)
        let word = at(14, 60, 86, 16)
        let go = at(14, 123, Self.transportDiameter, Self.transportDiameter)
        let stop = at(42, 122, box.width, box.height)
        let mute = at(74, 122, box.width, box.height)
        let head = at(114, 12, 292, 18)
        let rightW = headRightWidth(kind: kind)
        let headRight = at(406 - rightW, 12, rightW, 18)
        let headLeft = at(114, 12, 292 - rightW - (rightW > 0 ? 8 : 0), 18)
        let trace = at(114, 18, Self.traceSize.width, Self.traceSize.height)
        let hero = at(114, 30, 292, 3 * Self.heroPitch)
        let heroLines = Self.heroLines(kind: kind, threads: content.threads.count)
        let tile0 = at(114, 80, Self.tileSize.width, Self.tileSize.height)
        let tile1 = at(266, 80, Self.tileSize.width, Self.tileSize.height)
        let chips = at(114, 86, 292, 20)
        let allow = at(114, 82, 84, 28)
        let deny = at(206, 82, 84, 28)
        let mini = [340, 376].map { at(CGFloat($0), 85, Self.miniSize.width, Self.miniSize.height) }
        let film = [114, 206, 298].map { at(CGFloat($0), 56, Self.filmSize.width, Self.filmSize.height) }
        let field = at(114, 122, 176, 24)
        let clear = at(302, 122, box.width, box.height)
        let circle = at(328, 122, box.width, box.height)
        let window = at(354, 122, box.width, box.height)
        let ask = at(380, 122, box.width, box.height)
        let footSeamY = y0 + 153.5
        let footLeft = at(14, 160, 40, 16)
        let bar = at(60, 165, Self.barSize.width, Self.barSize.height)
        let footRight = at(156, 160, 186, 16)
        let foot = at(14, 154, 392, 30)
        let remedy = remedyBox(at: at(0, 159, 0, 18), rightEdge: x0 + 342)
        let console = at(354, 156, box.width, box.height)
        let sleep = at(380, 156, box.width, box.height)
        return Zones(face: face, word: word, go: go, stop: stop, mute: mute, head: head, headLeft: headLeft, headRight: headRight, trace: trace,
                     hero: hero, heroLines: heroLines, tile0: tile0, tile1: tile1, chips: chips, allow: allow, deny: deny, mini: mini, film: film,
                     field: field, clear: clear, circle: circle, window: window, ask: ask, footSeamY: footSeamY, footLeft: footLeft, bar: bar,
                     footRight: footRight, foot: foot, remedy: remedy, console: console, sleep: sleep, kind: kind)
    }

    /// The head's right span: the film caption while films show (≤ 180), else `◎ N` while
    /// any mark exists in the plain kind (≥ 30, the glyph and the figure), else nothing.
    /// The question kind has no `◎ N`: the minis and the `+n` slot carry the count, and
    /// the question is the one dominant element.
    private func headRightWidth(kind: CanvasKind) -> CGFloat {
        if kind == .marks {
            guard let caption = headCaption() else { return 0 }
            return min(Self.headCaptionMaxWidth, Self.textWidth(caption as NSString, Self.headDimAttrs) + 4)
        }
        guard kind == .plain, !content.marks.isEmpty else { return 0 }
        return max(30, 10 + 4 + Self.textWidth("\(content.marks.count)" as NSString, Self.workAttrs) + 2)
    }

    /// The head caption's span, the figures and their 4 pt of air.
    static let headCaptionMaxWidth: CGFloat = 180

    /// The caption in the head while films show: the hovered film's, else the newest's —
    /// its figures (`640×400 · 14:03 · pending`) without the leading kind word, which the
    /// film itself says, fitted to the span by dropping trailing ` · ` parts (the element
    /// phrase first, then the age) — never cut mid-word; the full caption is the tooltip.
    private func headCaption() -> String? {
        guard let caption = headCaptionFull() else { return nil }
        var figures = caption
        if let r = caption.range(of: " · "), caption[..<r.lowerBound].allSatisfy({ $0.isLetter }) { figures = String(caption[r.upperBound...]) }
        return Self.fitCaption(figures, width: Self.headCaptionMaxWidth - 4, attrs: Self.headDimAttrs)
    }

    /// `parts` joined by ` · `, the trailing parts dropped one by one until the text is
    /// no wider than `width`; the first part stays whatever its width.
    static func fitCaption(_ caption: String, width: CGFloat, attrs: [NSAttributedString.Key: Any]) -> String {
        var parts = caption.components(separatedBy: " · ")
        while parts.count > 1, textWidth(parts.joined(separator: " · ") as NSString, attrs) > width { parts.removeLast() }
        return parts.joined(separator: " · ")
    }

    /// The same film's whole caption — the head caption's tooltip.
    private func headCaptionFull() -> String? {
        let shown = Array(content.marks.reversed())
        guard !shown.isEmpty else { return nil }
        var i = 0
        if let h = hoveredNow {
            switch h {
            case .mark(let j), .markForget(let j): i = j
            default: break
            }
        }
        return i >= 0 && i < shown.count ? shown[i].caption : shown[0].caption
    }

    /// The remedy's box for the foot's problem row: the label (≤ 60 pt wide, else `Fix`)
    /// plus 16, 18 tall, right-aligned to the meter's end. Nil without a remedy.
    private func remedyBox(at slot: NSRect, rightEdge: CGFloat) -> NSRect? {
        guard let p = content.problem, let label = p.remedyLabel, !label.isEmpty else { return nil }
        let w = Self.textWidth(remedyWord(label) as NSString, Self.actionAttrs) + 16
        return NSRect(x: rightEdge - w, y: slot.minY, width: w, height: slot.height)
    }

    /// A remedy label wider than 60 pt is `Fix`.
    private func remedyWord(_ label: String) -> String {
        Self.textWidth(label as NSString, Self.actionAttrs) <= 60 ? label : "Fix"
    }

    /// The hovered control this frame: the pointer's, or the harness's (ORB_NOTCH_HOVER).
    private var hoveredNow: Press? {
        if let h = hoveredButton { return h }
        #if JARHEAD_ORB_PREVIEW
        if let name = NotchDock.previewHoveredButton { return Press(previewName: name) }
        #endif
        return nil
    }

    // MARK: the hero

    /// Which text is the one big line, in priority: a thread's question, the running
    /// delegation's request, the last thing said, the gate's words asleep, nothing.
    enum Hero { case question, request, lastLine, gate, none }

    /// The hero's text and face this frame (`previewLineText` mirrors it).
    private func heroChoice() -> (hero: Hero, text: String, attrs: [NSAttributedString.Key: Any]) {
        if let q = content.question { return (.question, q.text, Self.heroBrightAttrs) }
        if workingSince != nil, let r = content.request, !r.isEmpty { return (.request, r, Self.heroAttrs) }
        if !lastLine.isEmpty { return (.lastLine, lastLine, Self.heroAttrs) }
        if !awake, let g = content.gateLabel, !g.isEmpty { return (.gate, g, Self.heroCalmAttrs) }
        return (.none, "", Self.heroAttrs)
    }

    /// Lines the hero may take: one over the films, two over Allow · Deny or the tiles, else three.
    private static func heroLines(kind: CanvasKind, threads: Int) -> Int {
        switch kind {
        case .marks: return 1
        case .question: return 2
        case .plain: return threads > 0 ? 2 : 3
        }
    }

    /// The hero's lines, measured once per (key, lines, width): `wrapLines` is a dozen
    /// `textWidth` calls, not for every frame.
    private var heroLinesCache: (key: Int, lines: [NSString], attrs: [NSAttributedString.Key: Any])?

    private func heroLinesNow(_ z: Zones) -> (lines: [NSString], attrs: [NSAttributedString.Key: Any]) {
        let choice = heroChoice()
        var hasher = Hasher()
        hasher.combine(z.kind.rawValue); hasher.combine(choice.text); hasher.combine(z.heroLines); hasher.combine(Int(z.hero.width))
        let key = hasher.finalize()
        if let c = heroLinesCache, c.key == key { return (c.lines, c.attrs) }
        let lines = choice.text.isEmpty ? [] : Self.wrapLines(choice.text as NSString, width: z.hero.width, attrs: choice.attrs, max: z.heroLines)
        heroLinesCache = (key, lines, choice.attrs)
        return (lines, choice.attrs)
    }

    /// Greedy wrapping on spaces with the existing `textWidth`: a word wider than the line
    /// breaks by character; at most `max` lines (≤ 30), the last carrying the rest (it is
    /// drawn through `drawText(in:)`, which tail-truncates). No CTFramesetter; the same
    /// finite guards and the `textDrawFailed` kill-switch (a width of 0 wraps nothing).
    static func wrapLines(_ s: NSString, width: CGFloat, attrs: [NSAttributedString.Key: Any], max maxLines: Int) -> [NSString] {
        let limit = Swift.max(1, Swift.min(30, maxLines))
        guard width.isFinite, width > 0, s.length > 0, !textDrawFailed else { return [s] }
        let words = (s as String).split(separator: " ", omittingEmptySubsequences: false).map(String.init)
        var lines: [String] = []
        var line = ""
        func fits(_ t: String) -> Bool { textWidth(t as NSString, attrs) <= width }
        func push(_ t: String) { lines.append(t) }
        for word in words {
            if lines.count == limit - 1 { line = line.isEmpty ? word : line + " " + word; continue }
            let candidate = line.isEmpty ? word : line + " " + word
            if fits(candidate) { line = candidate; continue }
            if !line.isEmpty { push(line); line = "" }
            if fits(word) { line = word; continue }
            // A word wider than the line: by character.
            var piece = ""
            for ch in word {
                if lines.count == limit - 1 { piece.append(ch); continue }
                let next = piece + String(ch)
                if fits(next) { piece = next } else { if !piece.isEmpty { push(piece) }; piece = String(ch) }
            }
            line = piece
        }
        if !line.isEmpty || lines.isEmpty { push(line) }
        return lines.map { $0 as NSString }
    }

    // MARK: slots

    /// A thumbnail slot this frame: the mark, its rect, its index (newest first).
    private struct ThumbSlot {
        let index: Int
        let rect: NSRect
        let mark: DockContent.Mark
    }

    /// Marks newest first into `rects`; past the room the newest fill all but the last slot and the last reads "+n".
    private static func fillSlots(_ shown: [DockContent.Mark], into rects: [NSRect]) -> (slots: [ThumbSlot], overflow: (rect: NSRect, count: Int)?) {
        let room = rects.count
        guard !shown.isEmpty, room > 0 else { return ([], nil) }
        if shown.count <= room {
            return (shown.enumerated().map { ThumbSlot(index: $0.offset, rect: rects[$0.offset], mark: $0.element) }, nil)
        }
        let keep = room - 1
        let slots = shown.prefix(keep).enumerated().map { ThumbSlot(index: $0.offset, rect: rects[$0.offset], mark: $0.element) }
        return (slots, (rects[keep], shown.count - keep))
    }

    /// The films (marks kind): three 84×60 slots, the fourth mark on a "+n" film.
    private func filmSlots(_ z: Zones) -> (slots: [ThumbSlot], overflow: (rect: NSRect, count: Int)?) {
        guard z.kind == .marks else { return ([], nil) }
        return Self.fillSlots(Array(content.marks.reversed()), into: z.film)
    }

    /// The minis (question kind): two 30×22 slots right of Allow · Deny, "+n" past two.
    private func miniSlots(_ z: Zones) -> (slots: [ThumbSlot], overflow: (rect: NSRect, count: Int)?) {
        guard z.kind == .question else { return ([], nil) }
        return Self.fillSlots(Array(content.marks.reversed()), into: z.mini)
    }

    /// Whichever the kind shows — films or minis (the plain kind shows neither).
    private func thumbSlots(_ z: Zones) -> (slots: [ThumbSlot], overflow: (rect: NSRect, count: Int)?) {
        z.kind == .marks ? filmSlots(z) : miniSlots(z)
    }

    /// The mark shown in thumbnail slot `i` (newest first), for the dock's press routing.
    func markId(atSlot i: Int) -> String? {
        let shown = Array(content.marks.reversed())
        return i >= 0 && i < shown.count ? shown[i].id : nil
    }

    /// The × on a thumbnail, on its top-right corner: 14×14 on a film, 12×12 on a mini.
    private static func forgetRect(_ thumb: NSRect) -> NSRect {
        if thumb.width >= 60 { return NSRect(x: thumb.maxX - 10, y: thumb.minY - 4, width: 14, height: 14) }
        return NSRect(x: thumb.maxX - 9, y: thumb.minY - 3, width: 12, height: 12)
    }

    /// A thread's tile (plain kind, one or two threads): its rect and, when it can be stopped, its Stop's hit rect (22×20).
    private struct TileSlot {
        let row: DockContent.ThreadRow
        let rect: NSRect
        let stop: NSRect?
    }

    private func tileSlots(_ z: Zones) -> [TileSlot] {
        guard z.kind == .plain, content.threads.count >= 1, content.threads.count <= 2 else { return [] }
        let rects = [z.tile0, z.tile1]
        return content.threads.enumerated().map { i, row in
            let rect = rects[i]
            let stop = row.canStop ? NSRect(x: rect.maxX - 24, y: rect.minY + 2, width: 22, height: 20) : nil
            return TileSlot(row: row, rect: rect, stop: stop)
        }
    }

    /// "Name · word · m:ss" for a tile's label and a chip's text.
    private static func threadText(_ row: DockContent.ThreadRow, now: Date) -> String {
        var text = row.name + " · " + row.word
        if let since = row.since {
            let elapsed = now.timeIntervalSince(since)
            text += " · " + OrbStyle.mmss(elapsed.isFinite ? max(0, elapsed) : 0)
        }
        return text
    }

    /// One thread chip on the chip line (plain kind, three or more threads): its text rect
    /// and, when it can be stopped, its Stop glyph's hit rect (16×14).
    private struct ThreadChip {
        let row: DockContent.ThreadRow
        let text: NSString
        let rect: NSRect
        let stop: NSRect?
    }

    private func threadChips(_ z: Zones, now: Date) -> [ThreadChip] {
        guard z.kind == .plain, content.threads.count >= 3 else { return [] }
        var out: [ThreadChip] = []
        var x = z.chips.minX
        let end = z.chips.maxX
        let sepWidth = Self.textWidth(" | " as NSString, Self.threadAttrs)
        for (i, row) in content.threads.enumerated() {
            if i > 0 { x += sepWidth }
            // The Stop's 20 pt are reserved before the words truncate; a chip that cannot
            // get 30 pt of words is not started (the line ends at 406).
            let stopRoom: CGFloat = row.canStop ? 20 : 0
            guard end - x - stopRoom >= 30 else { break }
            let ns = Self.threadText(row, now: now) as NSString
            let w = min(Self.textWidth(ns, Self.threadAttrs) + 1, end - x - stopRoom)
            let rect = NSRect(x: x, y: z.chips.minY, width: w, height: z.chips.height)
            x += w
            var stop: NSRect?
            if row.canStop {
                stop = NSRect(x: x + 4, y: z.chips.minY + 3, width: 16, height: 14)
                x += 20
            }
            out.append(ThreadChip(row: row, text: ns, rect: rect, stop: stop))
            if x >= end { break }
        }
        return out
    }

    /// The pill slot as drawn this frame (view coordinates); nil without a pill.
    private(set) var pillRect: NSRect?

    /// The island's live controls and where they are (the open island's zones):
    /// hit-testing, hover, tooltips, presses and the accessibility children all read
    /// this one list. First match wins, so a corner comes before its thumb and a Stop
    /// before its tile; the Say box is last. `.console` may appear three times (the
    /// `+n` film, `◎ N`, the box) — legal under first-match, the tooltip differing.
    private func buttonRects(in island: NSRect) -> [(Press, NSRect)] {
        let z = zones(in: island)
        let question = content.question != nil
        var out: [(Press, NSRect)] = [(.pause, z.go), (.stop, z.stop)]
        if muteEnabled { out.append((.mute, z.mute)) }
        if !content.marks.isEmpty, !question, z.kind != .question { out.append((.clear, z.clear)) }
        out.append((.circle, z.circle))
        out.append((.window, z.window))
        if askEnabled, !question, z.kind != .question { out.append((.ask, z.ask)) }
        if z.kind == .question {
            out.append((.allow, z.allow))
            out.append((.deny, z.deny))
        }
        let thumbs = thumbSlots(z)
        for s in thumbs.slots {
            out.append((.markForget(s.index), Self.forgetRect(s.rect)))
            out.append((.mark(s.index), s.rect))
        }
        if z.kind == .marks, let over = thumbs.overflow { out.append((.console, over.rect)) }
        for t in tileSlots(z) {
            if let stop = t.stop { out.append((.threadStop(t.row.id), stop)) }
            out.append((.thread(t.row.id), t.rect))
        }
        for chip in threadChips(z, now: Date()) {
            if let stop = chip.stop { out.append((.threadStop(chip.row.id), stop)) }
            out.append((.thread(chip.row.id), chip.rect))
        }
        // The head row and the remedy draw 18 tall; their hit rects take a point more each way, so every press is ≥ 20 pt.
        if z.kind == .question, let q = content.question { out.append((.thread(q.threadId), z.headLeft.insetBy(dx: 0, dy: -1))) }
        // `◎ N` is the plain kind's: the question kind counts its marks in the minis and the `+n` slot.
        if z.kind == .plain, !content.marks.isEmpty, z.headRight.width > 0 { out.append((.console, z.headRight.insetBy(dx: 0, dy: -1))) }
        out.append((.console, z.console))
        if awake { out.append((.sleep, z.sleep)) }
        if let r = z.remedy { out.append((.remedy, r.insetBy(dx: 0, dy: -1))) }
        out.append((.field, z.field))
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
            list.append(Chip(kind: .marking, glyph: "pencil.and.outline", tint: Self.markTone, figure: figure, tooltip: "Circling — draw around something, Esc to cancel", alpha: 0.72, width: measure("scope", figure)))
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
        // The clamp: notch + breath + counter + dots + chips ≤ the peek's cap.
        let n = geometry?.notch.width ?? 185
        let fixed = n + (reduced ? 0 : 30) + (workingSince != nil ? Self.workExtraWidth : 0) + peekDotsExtraWidth
        func extra(_ l: [Chip]) -> CGFloat {
            guard !l.isEmpty else { return 0 }
            return l.reduce(0) { $0 + $1.width } + CGFloat(l.count - 1) * 8 + 8
        }
        while list.count > 1, fixed + extra(list) > NotchGeometry.peekWidthCap, let i = list.lastIndex(where: { $0.kind == .meter || $0.kind == .problem }) {
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

    /// What the slot shows this frame: gate > toast > mark-landed (tucked only). A problem
    /// is never a pill: with the island open it is the foot row, folded the peek chip.
    private enum Slot {
        case gate(OrbPill)
        case pill(SlotPill)
    }

    private func slot(now: Double, open: CGFloat) -> Slot? {
        if !awake, let g = gatePill { return .gate(g) }
        if let t = toastPill, now < t.until { return .pill(t) }
        if let m = markLandedPill, now < m.until, mode == .tucked, open < 0.5 { return .pill(m) }
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
            // A resting size the dock prewarmed (pinned) drawn stretched is the cache having lost it — never by design.
            if !gradient.exact, springsSettled {
                Self.previewStretchedFrames += 1
                if NotchInk.Cache.shared.isPinned(size: island.size, notchWidth: g.notch.width, scale: scale) { Self.previewStretchedRestingFrames += 1 }
            }
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
        // Island: the face as the anchor's head at (57, 40). It slides with the spring; its
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

        // The island's bands: laid out in the open island's rect, revealed by the ink as
        // it opens, each fading in and rising on its own beat.
        if contentAppearance(0, now: now) != nil || contentAppearance(Self.contentElements - 1, now: now) != nil {
            let z = zones(in: islandOpenRect)
            if z.isFinite {
                drawIslandContent(cg, zones: z, color: color, park: park, now: now)
            } else {
                BadNumber.noteOnce("NotchView island zones", "head \(z.head) hero \(z.hero) field \(z.field)")
            }
        }
        cg.restoreGState()
        cg.restoreGState()

        // The slot under the island: the gate's pill asleep, else a toast, else the
        // mark-landed line (tucked). Never a problem: that is the foot row.
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
        case nil:
            break
        }
    }

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
            // Allow · Deny, the remedy: 12 medium, centred in the box.
            let ns = word as NSString
            let w = Self.textWidth(ns, Self.actionAttrs)
            Self.drawText(ns, at: NSPoint(x: rect.midX - w / 2, y: rect.midY - 7.5), Self.actionAttrs)
        }
        cg.restoreGState()
    }

    /// What every band draw reads: the hovered and pressed controls, the park level, the
    /// clock and the phase colour — one value, so the six functions share a signature.
    private struct DrawState {
        let hovered: Press?
        let pressed: Press?
        let park: CGFloat
        let now: Double
        let color: RGB
    }
    private typealias Beat = (alpha: CGFloat, dy: CGFloat)

    /// The island's bands — each beat at its own fade and rise (`contentAppearance`),
    /// all under the park level: the anchor deck (0), the word and the head (1), the
    /// hero (2), the middle by kind (3), the control row (4), the foot (5).
    ///
    /// Alpha is one product per element — park × appearance × (a third for a dead box)
    /// — set on the context for the fills, strokes and words and passed as `fraction:`
    /// to the symbol draws: `NSImage.draw(…fraction:)` replaces the context's alpha
    /// rather than multiplying it (as does a nested `setAlpha`), which is how the glyphs
    /// once popped in at full white while everything around them faded.
    private func drawIslandContent(_ cg: CGContext, zones z: Zones, color: RGB, park: CGFloat, now: Double) {
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: cg, flipped: true)
        var pressed = pressing
        #if JARHEAD_ORB_PREVIEW
        if pressed == nil, let name = NotchDock.previewPressedButton { pressed = Press(previewName: name) }
        #endif
        let s = DrawState(hovered: hoveredNow, pressed: pressed, park: park, now: now, color: color)
        if let a = contentAppearance(0, now: now) { drawAnchorDeck(cg, z, a, s) }
        if let a = contentAppearance(1, now: now) { drawAnchorWordAndHead(cg, z, a, s) }
        if let a = contentAppearance(2, now: now) { drawHero(cg, z, a, s) }
        if let a = contentAppearance(3, now: now) { drawMiddle(cg, z, a, s) }
        if let a = contentAppearance(4, now: now) { drawControlRow(cg, z, a, s) }
        if let a = contentAppearance(5, now: now) { drawFoot(cg, z, a, s) }
        NSGraphicsContext.restoreGraphicsState()
    }

    // MARK: 0 · the anchor deck

    /// Go (the one circle, ringed in the phase colour), Stop and Mute — fixed in every kind.
    private func drawAnchorDeck(_ cg: CGContext, _ z: Zones, _ a: Beat, _ s: DrawState) {
        let base = finite01(s.park * a.alpha)
        drawRing(cg, rect: z.go.offsetBy(dx: 0, dy: a.dy), color: s.color, symbol: AppState.transportLabel(for: sim.phase).symbol,
                 hot: s.hovered == .pause, down: s.pressed == .pause, flash: flashLevel(.pause, now: s.now), alpha: base)
        drawBox(cg, which: .stop, rect: z.stop.offsetBy(dx: 0, dy: a.dy), symbol: "stop.fill", enabled: true, hovered: s.hovered, pressed: s.pressed, base: base, now: s.now)
        drawBox(cg, which: .mute, rect: z.mute.offsetBy(dx: 0, dy: a.dy), symbol: sim.phase == .muted ? "mic.slash.fill" : "mic.fill", enabled: muteEnabled,
                hovered: s.hovered, pressed: s.pressed, base: base, now: s.now)
    }

    /// The transport as a ring: translucent ink under a hairline ring in the phase colour,
    /// a solid play / pause / ellipsis centred; hover lifts it, a press fills it accent and
    /// the fill lets go over `Motion.base`.
    private func drawRing(_ cg: CGContext, rect: NSRect, color: RGB, symbol: String, hot: Bool, down: Bool, flash: CGFloat, alpha: CGFloat) {
        guard rect.isFiniteRect else { return }
        cg.saveGState()
        cg.setAlpha(alpha)
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
        let white = NSColor.white
        if let img = Self.symbol(symbol, pointSize: 10, tint: down || hot ? white : white.withAlphaComponent(0.92)) {
            let sz = img.size
            // A play glyph sits a hair right of its box's centre to look centred.
            let nudge: CGFloat = symbol == "play.fill" ? 0.5 : 0
            img.draw(in: NSRect(x: rect.midX - sz.width / 2 + nudge, y: rect.midY - sz.height / 2, width: sz.width, height: sz.height),
                     from: .zero, operation: .sourceOver, fraction: alpha, respectFlipped: true, hints: nil)
        }
        cg.restoreGState()
    }

    // MARK: 1 · the anchor's word and the head

    /// The phase word centred under the face; the head's left span (the level trace,
    /// `Working · m:ss`, or `✋ Name asks` while a question waits) and its right span
    /// (`◎ N` with any marks, the film's caption while films show).
    private func drawAnchorWordAndHead(_ cg: CGContext, _ z: Zones, _ a: Beat, _ s: DrawState) {
        let base = finite01(s.park * a.alpha)
        cg.saveGState()
        cg.setAlpha(base)
        let word = OrbStyle.label(sim.phase) as NSString
        let ww = Self.textWidth(word, Self.phaseAttrs)
        let wr = NSRect(x: z.word.midX - min(ww, z.word.width) / 2, y: z.word.minY + a.dy, width: min(ww + 2, z.word.width), height: z.word.height)
        Self.drawShadowed(word, in: wr, Self.phaseAttrs, shadow: Self.phaseShadow)
        let left = z.headLeft.offsetBy(dx: 0, dy: a.dy)
        if z.kind == .question, let q = content.question {
            drawSource(cg, q, in: left, hot: s.hovered == .thread(q.threadId), base: base, now: s.now)
        } else {
            let work = workLevel(s.now)
            if work > 0.005 {
                let text = workingText()
                let w = min(Self.textWidth(text, Self.workAttrs) + 2, left.width)
                cg.saveGState()
                cg.setAlpha(finite01(base * work))
                Self.drawShadowed(text, in: NSRect(x: left.minX, y: left.minY + 1, width: w, height: left.height), Self.workAttrs, shadow: Self.workShadow)
                cg.restoreGState()
            } else if traceLive {
                drawBar(cg, rect: z.trace.offsetBy(dx: 0, dy: a.dy), fraction: finite01(sim.islandLevel), alpha: 1)
            }
        }
        drawHeadRight(cg, z, a, base, hot: s.hovered == .console)
        cg.restoreGState()
    }

    /// `✋ Name asks` — the hand 10 pt amber pulsing on `Motion.pulse`, the name mono 0.72 (a step up under the pointer).
    private func drawSource(_ cg: CGContext, _ q: DockContent.Question, in rect: NSRect, hot: Bool, base: CGFloat, now: Double) {
        var x = rect.minX
        if let img = Self.symbol("hand.raised.fill", pointSize: 10, tint: Self.markTone) {
            img.draw(in: NSRect(x: x, y: rect.midY - img.size.height / 2, width: img.size.width, height: img.size.height),
                     from: .zero, operation: .sourceOver, fraction: finite01(base * (0.55 + 0.45 * pulse(now))), respectFlipped: true, hints: nil)
            x += img.size.width + 5
        }
        let text = "\(q.name) asks" as NSString
        cg.saveGState()
        if hot { cg.setAlpha(finite01(base * 0.92 / 0.72)) }
        Self.drawShadowed(text, in: NSRect(x: x, y: rect.minY + 1, width: max(0, rect.maxX - x), height: rect.height), Self.threadAttrs, shadow: Self.threadShadow)
        cg.restoreGState()
    }

    /// The head's right end: the hovered (else newest) film's caption at 0.46 while films
    /// show; otherwise `◎ N` — amber while any is pending, 0.46 once all are used.
    private func drawHeadRight(_ cg: CGContext, _ z: Zones, _ a: Beat, _ base: CGFloat, hot: Bool) {
        let rect = z.headRight.offsetBy(dx: 0, dy: a.dy)
        guard rect.width > 0 else { return }
        if z.kind == .marks {
            guard let caption = headCaption() else { return }
            let ns = caption as NSString
            let w = min(Self.textWidth(ns, Self.headDimAttrs) + 2, rect.width)
            Self.drawShadowed(ns, in: NSRect(x: rect.maxX - w, y: rect.minY + 1, width: w, height: rect.height), Self.headDimAttrs, shadow: Self.threadShadow)
            return
        }
        guard !content.marks.isEmpty else { return }
        let pending = content.pendingMarks > 0
        let figure = "\(content.marks.count)" as NSString
        let attrs = pending ? Self.headMarkAttrs : (hot ? Self.workAttrs : Self.headDimAttrs)
        let fw = Self.textWidth(figure, attrs)
        let tint = pending ? Self.markTone : NSColor(white: 1, alpha: hot ? 0.72 : 0.46)
        if let img = Self.symbol("scope", pointSize: 10, tint: tint) {
            img.draw(in: NSRect(x: rect.maxX - fw - 4 - img.size.width, y: rect.midY - img.size.height / 2, width: img.size.width, height: img.size.height),
                     from: .zero, operation: .sourceOver, fraction: base, respectFlipped: true, hints: nil)
        }
        Self.drawShadowed(figure, in: NSRect(x: rect.maxX - fw - 1, y: rect.minY + 1, width: fw + 2, height: rect.height), attrs, shadow: Self.threadShadow)
    }

    // MARK: 2 · the hero

    /// The one big line — one to three of them, 18 pt on a 22 pt pitch, top-aligned so
    /// line 1 never moves. On a hero change the old lines leave over `Motion.quick`
    /// (−4 pt) while the new arrive over `Motion.base` (from +6); a counter tick never
    /// re-animates it (`heroKey`). Nothing when there is nothing to say.
    private func drawHero(_ cg: CGContext, _ z: Zones, _ a: Beat, _ s: DrawState) {
        let base = finite01(s.park * a.alpha)
        let hero = heroLinesNow(z)
        var arrive: Beat = (1, 0)
        if heroChangedAt >= 0, s.now - heroChangedAt < seconds(Motion.quick) + seconds(Motion.base) {
            let t = finite01((s.now - heroChangedAt) / seconds(Motion.base))
            let e = Motion.easeOutCurve.value(at: t)
            arrive = (CGFloat(e), reduced ? 0 : CGFloat(6 * (1 - e)))
            if let prev = heroPrevious, s.now - heroChangedAt < seconds(Motion.quick) {
                let u = finite01((s.now - heroChangedAt) / seconds(Motion.quick))
                let f = Motion.easeInCurve.value(at: u)
                drawHeroLines(cg, prev.lines, prev.attrs, in: z.hero, beat: (CGFloat(1 - f), a.dy + (reduced ? 0 : CGFloat(-4 * f))), base: base)
            }
        } else if heroPrevious != nil {
            heroPrevious = nil
        }
        guard !hero.lines.isEmpty else { return }
        drawHeroLines(cg, hero.lines, hero.attrs, in: z.hero, beat: (arrive.alpha, a.dy + arrive.dy), base: base)
    }

    private func drawHeroLines(_ cg: CGContext, _ lines: [NSString], _ attrs: [NSAttributedString.Key: Any], in slot: NSRect, beat: Beat, base: CGFloat) {
        let alpha = finite01(base * beat.alpha)
        guard alpha > 0.005 else { return }
        cg.saveGState()
        cg.setAlpha(alpha)
        for (i, line) in lines.enumerated() {
            let rect = NSRect(x: slot.minX, y: slot.minY + CGFloat(i) * Self.heroPitch + beat.dy, width: slot.width, height: Self.heroPitch)
            Self.drawShadowed(line, in: rect, attrs, shadow: Self.heroShadow)
        }
        cg.restoreGState()
    }

    // MARK: 3 · the middle, by kind

    private func drawMiddle(_ cg: CGContext, _ z: Zones, _ a: Beat, _ s: DrawState) {
        switch z.kind {
        case .plain:
            if content.threads.count >= 3 { drawChipLine(cg, z, a, s) } else { drawTiles(cg, z, a, s) }
        case .question:
            drawActions(cg, z, a, s)
            drawMinis(cg, z, a, s)
        case .marks:
            drawFilms(cg, z, a, s)
        }
    }

    /// One or two thread tiles: dot · name / word · m:ss / a Stop each.
    private func drawTiles(_ cg: CGContext, _ z: Zones, _ a: Beat, _ s: DrawState) {
        let base = finite01(s.park * a.alpha)
        let date = Date()
        for t in tileSlots(z) {
            let hot = s.hovered == .thread(t.row.id) || s.hovered == .threadStop(t.row.id)
            drawTile(cg, row: t.row, rect: t.rect.offsetBy(dx: 0, dy: a.dy), stop: t.stop?.offsetBy(dx: 0, dy: a.dy), hot: hot,
                     stopHot: s.hovered == .threadStop(t.row.id), pressed: s.pressed, base: base, now: s.now, date: date)
        }
    }

    /// A 140×32 tile: the box grammar, a 5 pt dot in the thread's tone, the name 11 medium,
    /// `word · m:ss` mono 0.72 under it, the Stop glyph 9 pt at the right when it can stop.
    private func drawTile(_ cg: CGContext, row: DockContent.ThreadRow, rect: NSRect, stop: NSRect?, hot: Bool, stopHot: Bool,
                          pressed: Press?, base: CGFloat, now: Double, date: Date) {
        guard rect.isFiniteRect else { return }
        drawBox(cg, which: .thread(row.id), rect: rect, symbol: nil, enabled: true, hovered: hot ? .thread(row.id) : nil, pressed: pressed, base: base, now: now)
        cg.saveGState()
        cg.setAlpha(base)
        cg.setFillColor(row.tone.cgColor)
        cg.fill(CGRect(x: rect.minX + 8, y: rect.minY + 8.5, width: Self.dotSide, height: Self.dotSide))
        let textEnd = (stop?.minX ?? rect.maxX) - 4
        Self.drawShadowed(row.name as NSString, in: NSRect(x: rect.minX + 18, y: rect.minY + 3, width: max(0, textEnd - rect.minX - 18), height: 14), Self.wordAttrs, shadow: Self.workShadow)
        var meta = row.word
        if let since = row.since {
            let elapsed = date.timeIntervalSince(since)
            meta += " · " + OrbStyle.mmss(elapsed.isFinite ? max(0, elapsed) : 0)
        }
        Self.drawShadowed(meta as NSString, in: NSRect(x: rect.minX + 8, y: rect.minY + 16, width: max(0, textEnd - rect.minX - 8), height: 14), Self.threadAttrs, shadow: Self.threadShadow)
        // The Stop glyph, 9 pt, centred at (maxX − 13, minY + 12) — its hit rect is `stop` (22×20).
        if stop != nil, let img = Self.symbol("stop.fill", pointSize: 9, tint: stopHot ? .white : NSColor(white: 1, alpha: 0.72)) {
            let c = CGPoint(x: rect.maxX - 13, y: rect.minY + 12)
            img.draw(in: NSRect(x: c.x - img.size.width / 2, y: c.y - img.size.height / 2, width: img.size.width, height: img.size.height),
                     from: .zero, operation: .sourceOver, fraction: base, respectFlipped: true, hints: nil)
        }
        cg.restoreGState()
    }

    /// Three or more threads: one 20-tall line of chips — "Name · word · m:ss", its own
    /// small Stop after it when it can be stopped, " | " between; the asking one leads.
    private func drawChipLine(_ cg: CGContext, _ z: Zones, _ a: Beat, _ s: DrawState) {
        let base = finite01(s.park * a.alpha)
        cg.saveGState()
        cg.setAlpha(base)
        var prevEnd: CGFloat?
        for chip in threadChips(z, now: Date()) {
            let rect = chip.rect.offsetBy(dx: 0, dy: a.dy)
            let textRect = NSRect(x: rect.minX, y: rect.minY + 2, width: rect.width, height: 16)
            if let e = prevEnd {
                Self.drawShadowed(" | ", in: NSRect(x: e, y: textRect.minY, width: rect.minX - e + 1, height: textRect.height), Self.threadAttrs, shadow: Self.threadShadow)
            }
            Self.drawShadowed(chip.text, in: textRect, Self.threadAttrs, shadow: Self.threadShadow)
            prevEnd = rect.maxX
            if let stop = chip.stop {
                let hot = s.hovered == .threadStop(chip.row.id)
                if let img = Self.symbol("stop.fill", pointSize: 9, tint: hot ? .white : NSColor(white: 1, alpha: 0.72)) {
                    let sr = stop.offsetBy(dx: 0, dy: a.dy)
                    img.draw(in: NSRect(x: sr.midX - img.size.width / 2, y: sr.midY - img.size.height / 2, width: img.size.width, height: img.size.height),
                             from: .zero, operation: .sourceOver, fraction: base, respectFlipped: true, hints: nil)
                }
                prevEnd = stop.maxX
            }
        }
        cg.restoreGState()
    }

    /// Allow · Deny under the question's first word: ghost word boxes, 12 medium.
    private func drawActions(_ cg: CGContext, _ z: Zones, _ a: Beat, _ s: DrawState) {
        let base = finite01(s.park * a.alpha)
        drawBox(cg, which: .allow, rect: z.allow.offsetBy(dx: 0, dy: a.dy), symbol: nil, word: "Allow", enabled: true, hovered: s.hovered, pressed: s.pressed, base: base, now: s.now)
        drawBox(cg, which: .deny, rect: z.deny.offsetBy(dx: 0, dy: a.dy), symbol: nil, word: "Deny", enabled: true, hovered: s.hovered, pressed: s.pressed, base: base, now: s.now)
    }

    /// The minis at the right while a question waits: ≤ 2 thumbnails, "+n" past that.
    private func drawMinis(_ cg: CGContext, _ z: Zones, _ a: Beat, _ s: DrawState) {
        let base = finite01(s.park * a.alpha)
        let slots = miniSlots(z)
        for m in slots.slots {
            let hot = s.hovered == .mark(m.index) || s.hovered == .markForget(m.index)
            drawThumb(cg, m.mark, in: m.rect.offsetBy(dx: 0, dy: a.dy), hot: hot, base: base)
        }
        if let over = slots.overflow { drawOverflowThumb(cg, in: over.rect.offsetBy(dx: 0, dy: a.dy), count: over.count, hot: false, base: base) }
    }

    /// The films: three 84×60 across the display, newest first, staggered 30 ms left to
    /// right inside the beat; the fourth mark on a "+n" film (→ Console).
    private func drawFilms(_ cg: CGContext, _ z: Zones, _ a: Beat, _ s: DrawState) {
        let slots = filmSlots(z)
        func beat(_ i: Int) -> Beat {
            guard contentOpenedAt >= 0, contentShown, !reduced else { return a }
            let delay = Double(3) * Motion.stagger + Double(i) * 0.03
            let t = finite01((s.now - contentOpenedAt - delay) / seconds(Motion.base))
            let e = Motion.easeOutCurve.value(at: t)
            return (min(a.alpha, CGFloat(e)), max(a.dy, CGFloat(6 * (1 - e))))
        }
        for m in slots.slots {
            let b = beat(m.index)
            let hot = s.hovered == .mark(m.index) || s.hovered == .markForget(m.index)
            drawThumb(cg, m.mark, in: m.rect.offsetBy(dx: 0, dy: b.dy), hot: hot, base: finite01(s.park * b.alpha))
        }
        if let over = slots.overflow {
            let b = beat(slots.slots.count)
            drawOverflowThumb(cg, in: over.rect.offsetBy(dx: 0, dy: b.dy), count: over.count, hot: s.hovered == .console, base: finite01(s.park * b.alpha))
        }
    }

    // MARK: 4 · the control row

    /// The Say box in the middle and the circling keys as one strip at the right:
    /// [Clear |] Circle | Window [| Ask] — Clear while marks exist, Ask outside the
    /// question kind (dead at 0.35 unless a line can be sent).
    private func drawControlRow(_ cg: CGContext, _ z: Zones, _ a: Beat, _ s: DrawState) {
        let base = finite01(s.park * a.alpha)
        drawFieldBox(cg, rect: z.field.offsetBy(dx: 0, dy: a.dy), hot: s.hovered == .field, base: base)
        let granted = content.screenRecordingGranted
        var cells: [StripCell] = []
        if !content.marks.isEmpty, z.kind != .question { cells.append(StripCell(press: .clear, rect: z.clear, symbol: "eraser.fill", enabled: true, dim: 1)) }
        cells.append(StripCell(press: .circle, rect: z.circle, symbol: "pencil.and.outline", enabled: true, dim: granted ? 1 : 0.45))
        cells.append(StripCell(press: .window, rect: z.window, symbol: "macwindow", enabled: true, dim: granted ? 1 : 0.45))
        if z.kind != .question { cells.append(StripCell(press: .ask, rect: z.ask, symbol: "questionmark.bubble.fill", enabled: askEnabled, dim: 1)) }
        drawStrip(cg, cells: cells.map { $0.offset(dy: a.dy) }, hovered: s.hovered, pressed: s.pressed, base: base, now: s.now)
    }

    /// The Say box: the box grammar with the placeholder at 0.46 at rest; with key the
    /// hairline is the 1 pt accent ring and the NSTextField draws its own words.
    private func drawFieldBox(_ cg: CGContext, rect: NSRect, hot: Bool, base: CGFloat) {
        guard rect.isFiniteRect else { return }
        cg.saveGState()
        cg.setAlpha(base)
        let box = NSBezierPath(roundedRect: rect.insetBy(dx: 0.5, dy: 0.5), xRadius: 6, yRadius: 6)
        NSColor(white: 0, alpha: 0.42).setFill(); box.fill()
        if hot, !fieldFocused { NSColor(white: 1, alpha: 0.10).setFill(); box.fill() }
        if fieldFocused { Self.accent.setStroke() } else { NSColor(white: 1, alpha: 0.26).setStroke() }
        box.lineWidth = 1
        box.stroke()
        if !fieldFocused {
            let words = fieldPlaceholder() as NSString
            Self.drawText(words, in: NSRect(x: rect.minX + 8, y: rect.minY + 4, width: rect.width - 16, height: 16), Self.placeholderAttrs)
        }
        cg.restoreGState()
    }

    /// One cell of a strip: its control, rect, glyph, whether it takes presses, and its dim (0.45 for Circle/Window without Screen Recording).
    private struct StripCell {
        let press: Press
        let rect: NSRect
        let symbol: String
        let enabled: Bool
        let dim: CGFloat
        func offset(dy: CGFloat) -> StripCell { StripCell(press: press, rect: rect.offsetBy(dx: 0, dy: dy), symbol: symbol, enabled: enabled, dim: dim) }
    }

    /// Boxes that touch share one seam: one rounded rect (black 0.42, hairline 0.26, r 6)
    /// over the cells, 1 pt seams at the boundaries, each cell's hover / press / flash / dim
    /// through the box's own state maths.
    private func drawStrip(_ cg: CGContext, cells: [StripCell], hovered: Press?, pressed: Press?, base: CGFloat, now: Double) {
        guard let first = cells.first, let last = cells.last else { return }
        let union = first.rect.union(last.rect)
        guard union.isFiniteRect else { return }
        cg.saveGState()
        cg.setAlpha(base)
        let path = NSBezierPath(roundedRect: union, xRadius: 6, yRadius: 6)
        NSColor(white: 0, alpha: 0.42).setFill(); path.fill()
        for (i, cell) in cells.enumerated() {
            let hot = cell.enabled && hovered == cell.press
            let down = cell.enabled && pressed == cell.press
            let flash = cell.enabled ? flashLevel(cell.press, now: now) : 0
            if hot || down || flash > 0 {
                cg.saveGState()
                path.addClip()
                if down { Self.accent.setFill() } else { NSColor(white: 1, alpha: hot ? 0.10 : 0).setFill() }
                cell.rect.fill()
                if flash > 0, !down { Self.accent.withAlphaComponent(flash).setFill(); cell.rect.fill() }
                cg.restoreGState()
            }
            if i > 0 {
                NSColor(white: 1, alpha: 0.26).setStroke()
                let seam = NSBezierPath()
                seam.move(to: NSPoint(x: cell.rect.minX + 0.5, y: cell.rect.minY + 1))
                seam.line(to: NSPoint(x: cell.rect.minX + 0.5, y: cell.rect.maxY - 1))
                seam.lineWidth = 1
                seam.stroke()
            }
            let glyphAlpha = finite01(base * (cell.enabled ? cell.dim : 0.35))
            if let img = Self.symbol(cell.symbol, pointSize: 11, tint: down || hot ? .white : NSColor(white: 1, alpha: 0.78)) {
                let sz = img.size
                img.draw(in: NSRect(x: cell.rect.midX - sz.width / 2, y: cell.rect.midY - sz.height / 2, width: sz.width, height: sz.height),
                         from: .zero, operation: .sourceOver, fraction: glyphAlpha, respectFlipped: true, hints: nil)
            }
        }
        NSColor(white: 1, alpha: 0.26).setStroke()
        path.lineWidth = 1
        path.stroke()
        cg.restoreGState()
    }

    // MARK: 5 · the foot

    /// The foot seam, then the meter — `4:12` · the bar · `2.3 min · $0.12 · today 12.3 min`
    /// — or the problem row in its place, and Console | Sleep as one pair in the corner.
    private func drawFoot(_ cg: CGContext, _ z: Zones, _ a: Beat, _ s: DrawState) {
        let base = finite01(s.park * a.alpha)
        cg.saveGState()
        cg.setAlpha(base)
        NSColor(white: 1, alpha: 0.10).setStroke()
        let seam = NSBezierPath()
        seam.move(to: NSPoint(x: z.foot.minX, y: z.footSeamY + a.dy))
        seam.line(to: NSPoint(x: z.foot.maxX, y: z.footSeamY + a.dy))
        seam.lineWidth = 1
        seam.stroke()
        cg.restoreGState()
        if let p = content.problem {
            drawProblemRow(cg, p, z, a, s, base: base)
        } else {
            drawMeter(cg, z, a, base: base, now: s.now)
        }
        let cells = [StripCell(press: .console, rect: z.console, symbol: "rectangle.3.group.fill", enabled: true, dim: 1),
                     StripCell(press: .sleep, rect: z.sleep, symbol: "moon.fill", enabled: awake, dim: 1)]
        drawStrip(cg, cells: cells.map { $0.offset(dy: a.dy) }, hovered: s.hovered, pressed: s.pressed, base: base, now: s.now)
    }

    /// The meter as an instrument: the elapsed at the left, the bar (fill = billed ÷ the
    /// day's, a track only asleep, frozen and dim paused), the figures at the right.
    private func drawMeter(_ cg: CGContext, _ z: Zones, _ a: Beat, base: CGFloat, now: Double) {
        let f = meterFigures(now: now)
        let attrs = f.dim ? Self.footPausedAttrs : Self.threadAttrs
        cg.saveGState()
        cg.setAlpha(base)
        if let left = f.left {
            Self.drawShadowed(left as NSString, in: z.footLeft.offsetBy(dx: 0, dy: a.dy), attrs, shadow: Self.threadShadow)
        }
        if !f.right.isEmpty {
            Self.drawShadowed(f.right as NSString, in: z.footRight.offsetBy(dx: 0, dy: a.dy), attrs, shadow: Self.threadShadow)
        }
        cg.restoreGState()
        drawBar(cg, rect: z.bar.offsetBy(dx: 0, dy: a.dy), fraction: meterFill(now), alpha: finite01(base * (f.dim ? 0.48 / 0.72 : 1)))
    }

    /// The problem row in the meter's place: the kind's glyph (amber for a missing grant,
    /// red else), the noun at 0.92 and the clause at 0.62 (split at the first `: `), `· +n`
    /// when more wait, the remedy's label as a box right-aligned to the meter's end.
    private func drawProblemRow(_ cg: CGContext, _ p: DockContent.ProblemRow, _ z: Zones, _ a: Beat, _ s: DrawState, base: CGFloat) {
        cg.saveGState()
        cg.setAlpha(base)
        let glyphCentre = CGPoint(x: z.foot.minX + 7, y: z.foot.minY + 14 + a.dy)
        if let img = Self.symbol(p.symbol, pointSize: 10, tint: p.warn ? Self.markTone : Self.errorTone) {
            img.draw(in: NSRect(x: glyphCentre.x - img.size.width / 2, y: glyphCentre.y - img.size.height / 2, width: img.size.width, height: img.size.height),
                     from: .zero, operation: .sourceOver, fraction: base, respectFlipped: true, hints: nil)
        }
        let row = problemRowText(p, z)
        let y = z.foot.minY + 6 + a.dy
        Self.drawShadowed(row.noun as NSString, in: NSRect(x: row.nounX, y: y, width: row.nounWidth, height: 16), Self.problemNounAttrs, shadow: Self.lineShadow)
        if !row.clause.isEmpty {
            Self.drawShadowed(row.clause as NSString, in: NSRect(x: row.clauseX, y: y, width: row.room, height: 16), Self.problemClauseAttrs, shadow: Self.lineShadow)
        }
        cg.restoreGState()
        if let r = z.remedy, let label = p.remedyLabel {
            drawBox(cg, which: .remedy, rect: r.offsetBy(dx: 0, dy: a.dy), symbol: nil, word: remedyWord(label), enabled: true, hovered: s.hovered, pressed: s.pressed, base: base, now: s.now)
        }
    }

    /// The problem row's words and where they go: the noun from x 18, the clause (`· …`,
    /// then ` · +n` when more wait) 6 pt after it — drawn only when 60 pt or more of the
    /// room before the remedy is left for it, so a three-letter fragment (`· cir…`) never
    /// stands beside the remedy; with less room only `+n` shows, and the foot tooltip
    /// carries the whole text. `previewProblemRow` reads the same numbers.
    private func problemRowText(_ p: DockContent.ProblemRow, _ z: Zones) -> (noun: String, nounX: CGFloat, nounWidth: CGFloat, clause: String, clauseX: CGFloat, room: CGFloat) {
        let end = (z.remedy?.minX ?? z.footRight.maxX) - 8
        let parts = Self.problemParts(p.text)
        let nounX = z.foot.minX + 18
        let nounWidth = min(Self.textWidth(parts.noun as NSString, Self.problemNounAttrs) + 1, max(0, end - nounX))
        let clauseX = nounX + nounWidth + 6
        let room = max(0, end - clauseX)
        let more = p.more > 0 ? "+\(p.more)" : ""
        var clause = ""
        if !parts.clause.isEmpty, room >= Self.problemClauseMinRoom {
            clause = "· " + parts.clause + (more.isEmpty ? "" : " · " + more)
        } else if !more.isEmpty, room > 20 {
            clause = more
        }
        return (parts.noun, nounX, nounWidth, clause, clauseX, room)
    }

    /// The least room the problem row's clause takes (points); under it the clause is omitted.
    static let problemClauseMinRoom: CGFloat = 60

    /// "Screen Recording not granted: circles arrive without pixels" → the noun and the clause.
    static func problemParts(_ text: String) -> (noun: String, clause: String) {
        guard let r = text.range(of: ": ") else { return (text, "") }
        return (String(text[..<r.lowerBound]), String(text[r.upperBound...]))
    }

    /// A 6 pt bar: a flat track at white 0.10, a flat fill at 0.72, the fill's leading
    /// 12 pt dithered through one Bayer period (8 cells of 1.5 pt) so the edge reads as
    /// the icon's dither, not a hard stop. Nothing shades that is not dithered.
    private func drawBar(_ cg: CGContext, rect: NSRect, fraction: CGFloat, alpha: CGFloat) {
        guard rect.isFiniteRect, rect.width > 0 else { return }
        let f = finite01(fraction)
        cg.saveGState()
        cg.setAlpha(finite01(alpha))
        cg.setFillColor(CGColor(gray: 1, alpha: 0.10))
        cg.fill(rect)
        let fillW = (rect.width * f).rounded()
        if fillW > 0.5 {
            let edge: CGFloat = min(12, fillW)
            let solid = NSRect(x: rect.minX, y: rect.minY, width: fillW - edge, height: rect.height)
            cg.setFillColor(CGColor(gray: 1, alpha: 0.72))
            if solid.width > 0 { cg.fill(solid) }
            let scale = window?.backingScaleFactor ?? 2
            if let img = Self.barEdge(scale: scale) {
                cg.saveGState()
                cg.interpolationQuality = .none
                let dst = NSRect(x: rect.minX + fillW - edge, y: rect.minY, width: edge, height: rect.height)
                cg.clip(to: dst)
                cg.translateBy(x: 0, y: dst.midY)
                cg.scaleBy(x: 1, y: -1)
                cg.translateBy(x: 0, y: -dst.midY)
                cg.draw(img, in: NSRect(x: rect.minX + fillW - 12, y: rect.minY, width: 12, height: rect.height))
                cg.restoreGState()
            }
        }
        cg.restoreGState()
    }

    /// The bar's leading edge: a 12×6 pt white coverage ramp (1 → 0 left to right) through
    /// the shared Bayer tile in 1.5 pt cells, at 0.72 — one image per scale.
    private static var barEdgeCache: [Int: CGImage] = [:]
    private static func barEdge(scale: CGFloat) -> CGImage? {
        let key = Int((scale * 100).rounded())
        if let hit = barEdgeCache[key] { return hit }
        let s = max(1, scale)
        let W = Int((12 * s).rounded()), H = Int((6 * s).rounded())
        let cell = max(1, Dither.cellPixels(scale: s)), n = Dither.tileSize, tile = Dither.tile
        var px = [UInt8](repeating: 0, count: W * H * 4)
        for y in 0..<H {
            let noiseRow = ((y / cell) % n) * n
            for x in 0..<W {
                let t = tile[noiseRow + (x / cell) % n]
                let ramp = 1 - (Float(x / cell) + 0.5) / Float(max(1, W / cell))
                let on = ramp > t
                let i = (y * W + x) * 4
                px[i] = on ? 255 : 0; px[i + 1] = on ? 255 : 0; px[i + 2] = on ? 255 : 0; px[i + 3] = on ? 184 : 0
            }
        }
        guard let provider = CGDataProvider(data: Data(px) as CFData), let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        let img = CGImage(width: W, height: H, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: W * 4, space: space,
                          bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue), provider: provider, decode: nil,
                          shouldInterpolate: false, intent: .defaultIntent)
        if let img { barEdgeCache[key] = img }
        return img
    }

    /// The foot's words: in session "4:12 · 2.3 min · $0.12 · today 12.3 min"; paused
    /// "2.3 min · sleeps in 4 min" a step dimmer; asleep "today 12.3 min · $0.62" or
    /// "No session. Nothing billed." The whole line is the foot's tooltip and the
    /// harness's `previewFootText`; `meterFigures` splits it for the instrument.
    private func footText(now: Double) -> (text: String, dim: Bool) {
        let f = meterFigures(now: now)
        var parts: [String] = []
        if let l = f.left { parts.append(l) }
        if !f.right.isEmpty { parts.append(f.right) }
        return (parts.joined(separator: " · "), f.dim)
    }

    /// The meter's figures: the elapsed at the left (in session only), the words at the
    /// right, and whether the row is the dimmed paused one.
    private func meterFigures(now: Double) -> (left: String?, right: String, dim: Bool) {
        let m = content.meter
        if m.inSession {
            var left: String?
            if let e = m.elapsed {
                let live = e + max(0, now - contentAt)
                left = OrbStyle.mmss(live.isFinite ? live : 0)
            }
            var parts: [String] = []
            if let b = m.billedSeconds { parts.append(TransportFormat.billed(b)) }
            if let t = m.todaySeconds, t > 0 { parts.append("today " + TransportFormat.minutes(t)) }
            return (left, parts.joined(separator: " · "), false)
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
            return (nil, parts.joined(separator: " · "), true)
        }
        if let t = m.todaySeconds, t > 0 { return (nil, "today " + TransportFormat.billed(t), false) }
        return (nil, "No session. Nothing billed.", false)
    }

    // MARK: thumbnails

    /// The skeleton under a crop still on its way: the ink ramp dithered at 1.5 pt cells, once per (size, scale).
    private static var skeletonCache: [String: CGImage] = [:]
    private static func skeleton(size: NSSize, scale: CGFloat) -> CGImage? {
        let key = "\(Int(size.width))x\(Int(size.height))@\(Int((scale * 100).rounded()))"
        if let hit = skeletonCache[key] { return hit }
        let img = Dither.gradientImage(size: size, scale: scale, stops: Dither.skeletonStopsDark, direction: .diagonal, cell: Dither.cellPixels(scale: scale))
        if let img { skeletonCache[key] = img }
        return img
    }

    /// The skeleton ground into `rect` (flipped), or plain ink when the image is not there.
    private func drawSkeleton(_ cg: CGContext, in rect: NSRect) {
        let scale = window?.backingScaleFactor ?? 2
        if let sk = Self.skeleton(size: rect.size, scale: scale) {
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
    }

    /// One thumbnail — a film or a mini: the crop aspect-filled (interpolated — it is a
    /// photograph) or the skeleton with a `scope` (11 pt on a film, 7 on a mini); a white
    /// 0.55 hairline frame, the mark tone at 0.9 while pending; a used mark at half alpha
    /// and no amber. Hovered: a lift and the ×.
    private func drawThumb(_ cg: CGContext, _ m: DockContent.Mark, in rect: NSRect, hot: Bool, base: CGFloat) {
        guard rect.isFiniteRect else { return }
        let alpha = finite01(base * (m.consumed ? 0.5 : 1))
        let film = rect.width >= 60
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
            drawSkeleton(cg, in: rect)
            if let img = Self.symbol("scope", pointSize: film ? 11 : 7, tint: NSColor(white: 1, alpha: 0.72)) {
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
        if hot { drawForgetCross(cg, on: rect, base: base) }
    }

    /// The ×: ink 0.94 under a small xmark at white 0.9, on the thumbnail's top-right corner (14×14 on a film, 12×12 on a mini).
    private func drawForgetCross(_ cg: CGContext, on rect: NSRect, base: CGFloat) {
        let fr = Self.forgetRect(rect)
        cg.saveGState()
        cg.setAlpha(base)
        cg.setFillColor(CGColor(gray: 0.06, alpha: 0.94))
        cg.fillEllipse(in: fr)
        if let img = Self.symbol("xmark", pointSize: fr.width >= 14 ? 8 : 7, tint: NSColor(white: 1, alpha: 0.9)) {
            drawImage(cg, img, in: NSRect(x: fr.midX - img.size.width / 2, y: fr.midY - img.size.height / 2, width: img.size.width, height: img.size.height), alpha: base)
        }
        cg.restoreGState()
    }

    /// The "+n" slot: the skeleton ground under the figure (13 mono on a film, 11 on a mini), a hairline frame; hover lifts it.
    private func drawOverflowThumb(_ cg: CGContext, in rect: NSRect, count: Int, hot: Bool, base: CGFloat) {
        guard rect.isFiniteRect else { return }
        let film = rect.width >= 60
        cg.saveGState()
        cg.setAlpha(base)
        cg.saveGState()
        cg.clip(to: rect)
        drawSkeleton(cg, in: rect)
        if hot { cg.setFillColor(CGColor(gray: 1, alpha: 0.10)); cg.fill(rect) }
        cg.restoreGState()
        cg.setStrokeColor(CGColor(gray: 1, alpha: 0.55))
        cg.setLineWidth(1)
        cg.stroke(rect.insetBy(dx: 0.5, dy: 0.5))
        let text = "+\(count)" as NSString
        let attrs = film ? Self.overflowLargeAttrs : Self.overflowAttrs
        let w = Self.textWidth(text, attrs)
        Self.drawText(text, at: NSPoint(x: rect.midX - w / 2, y: rect.midY - (film ? 8 : 7)), attrs)
        cg.restoreGState()
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

    /// The last transcript line, set by the dock from the content (mono, one line). It is
    /// a hero input, so the hero's key is compared here — after `content` has landed
    /// (`NotchDock.setContent` sets the content first): compared in `content.didSet`
    /// alone the key would still see the old line, and the swap would fire late, on the
    /// next counter tick, with the new text leaving under itself.
    var lastLine = "" {
        didSet {
            guard lastLine != oldValue else { return }
            noteCanvasChanges()
            needsDisplay = true
        }
    }

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
            return n > 0 ? "Circle something — \(n) waiting · ⌥⇧C" : "Circle something · ⌥⇧C"
        case .window:
            return c.screenRecordingGranted ? "Capture the front window for Jarhead" : "Capture the front window for Jarhead — needs Screen Recording"
        case .ask:
            if !awake { return c.typedWakes ? "What's this? — wakes · billed" : "What's this? — press Go first" }
            return c.pendingMarks > 0 ? "What's this? — ask about what you circled" : "What's this? — circle first, then ask"
        case .clear:
            let used = c.marks.filter(\.consumed).count
            return "Clear · \(c.marks.count) circled" + (used > 0 ? " · \(used) already used" : "")
        case .allow, .deny:
            return c.question?.text ?? ""
        case .mark(let i):
            let shown = Array(c.marks.reversed())
            return i >= 0 && i < shown.count ? shown[i].caption : ""
        case .markForget(let i):
            let shown = Array(c.marks.reversed())
            return i >= 0 && i < shown.count && shown[i].isWindow ? "Forget this capture" : "Forget this circle"
        case .thread(let id):
            // The source row while its thread asks: the whole question (≤ 40 + …, as the peek chip).
            if let q = c.question, q.threadId == id {
                let short = q.text.count > 40 ? String(q.text.prefix(40)) + "…" : q.text
                return "\(q.name) asks: \(short)"
            }
            guard let row = c.threads.first(where: { $0.id == id }) else { return "" }
            var text = Self.threadText(row, now: Date())
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
            return fieldPlaceholder()
        }
    }

    /// `.console` appears up to three times in one hit list; the tooltip tells them apart by the rect.
    private func consoleHelp(rect: NSRect, zones z: Zones) -> String {
        let c = content
        if z.kind == .plain, rect == z.headRight.insetBy(dx: 0, dy: -1) { return "\(c.marks.count) circled · \(c.pendingMarks) pending — Console" }
        if z.kind == .marks, let over = filmSlots(z).overflow, rect == over.rect { return "\(over.count) more circled — Console" }
        return helpText(for: .console)
    }

    /// The tooltip for a point: a control's, a chip's, the hero's while a question shows
    /// (the whole question), the head caption's (the film's full caption), or the foot's
    /// (the meter's line and the day's billing — also while the problem row shows).
    private func tooltip(at p: NSPoint) -> String {
        guard mode == .island, parked else {
            for (rect, text) in chipRects where rect.insetBy(dx: -2, dy: -2).contains(p) { return text }
            return ""
        }
        let z = zones(in: islandOpenRect)
        // The rect under the pointer, not the first of its name: `.console` has three.
        if let (which, rect) = buttonHit(at: p) {
            return which == .console ? consoleHelp(rect: rect, zones: z) : helpText(for: which)
        }
        for (rect, text) in chipRects where rect.insetBy(dx: -2, dy: -2).contains(p) { return text }
        if let q = content.question, z.hero.contains(p) { return q.text }
        if z.kind == .marks, z.headRight.width > 0, z.headRight.insetBy(dx: -2, dy: -2).contains(p), let caption = headCaptionFull() { return caption }
        if z.foot.contains(p) {
            let m = content.meter
            var parts: [String] = []
            if let b = m.billedSeconds { parts.append("Billed " + TransportFormat.billed(b)) }
            if let t = m.todaySeconds, t > 0 { parts.append("today " + TransportFormat.billed(t)) }
            let foot = footText(now: CACurrentMediaTime()).text
            return parts.isEmpty ? foot : foot + " — " + parts.joined(separator: " · ")
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
    /// reached for; the Say box and a chip on the chip line take none (they touch their
    /// neighbours); a tile and the source row take the boxes' 2. A strip cell (Clear ·
    /// Circle · Window · Ask, Console · Sleep) shares a seam with its neighbour, so it
    /// takes slop only above and below: the drawn seam is the hit seam, and the first
    /// point of the right-hand cell is never the left-hand control's.
    private func button(at p: NSPoint) -> Press? { buttonHit(at: p)?.0 }

    /// The control under `p` and the rect that caught it — `.console` appears up to
    /// three times in one list, and the tooltip needs the one under the pointer.
    private func buttonHit(at p: NSPoint) -> (Press, NSRect)? {
        guard mode == .island, parked else { return nil }
        let chipLine = content.threads.count >= 3 && currentKind == .plain
        return buttonRects(in: islandOpenRect).first { which, rect in
            let slop: (dx: CGFloat, dy: CGFloat)
            switch which {
            case .pause: slop = (3, 3)
            case .field: slop = (0, 0)
            case .thread: slop = chipLine ? (0, 0) : (2, 2)
            case .clear, .circle, .window, .ask, .console, .sleep: slop = (0, 2)
            default: slop = (2, 2)
            }
            return rect.insetBy(dx: -slop.dx, dy: -slop.dy).contains(p)
        }
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
    /// Of those, the frames at a prewarmed (pinned) resting size — the island, the lip, the peek and its breath buckets.
    nonisolated(unsafe) static var previewStretchedRestingFrames = 0
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

    /// ORB_NOTCH_KIND=plain|question|marks: the display's kind forced, for shots and checks
    /// (`previewSetKind` changes it mid-run, for the kind-change beats).
    nonisolated(unsafe) static var previewForcedKind: CanvasKind? = ProcessInfo.processInfo.environment["ORB_NOTCH_KIND"].flatMap { CanvasKind(rawValue: $0) }
    func previewSetKind(_ name: String?) {
        Self.previewForcedKind = name.flatMap { CanvasKind(rawValue: $0) }
        noteCanvasChanges()
        rebuildAccessibility()
        needsDisplay = true
        wake()
    }

    /// The zones of the open island, x/y from the island's top-left: "island 420×184 | face x57–57 y40–40 | word … | kind:plain".
    /// The face prints its centre; `remedy` prints x0–0 y0–0 without a problem; the last token is the kind.
    var previewLayoutReadout: String {
        let island = islandOpenRect
        let z = zones(in: island)
        func r(_ name: String, _ rect: NSRect) -> String {
            String(format: "%@ x%.0f–%.0f y%.0f–%.0f", name, rect.minX - island.minX, rect.maxX - island.minX, rect.minY - island.minY, rect.maxY - island.minY)
        }
        let face = String(format: "face x%.0f–%.0f y%.0f–%.0f", z.face.x - island.minX, z.face.x - island.minX, z.face.y - island.minY, z.face.y - island.minY)
        let heroUsed = NSRect(x: z.hero.minX, y: z.hero.minY, width: z.hero.width, height: CGFloat(z.heroLines) * Self.heroPitch)
        var parts = [face, r("word", z.word), r("go", z.go), r("stop", z.stop), r("mute", z.mute), r("head", z.head), r("headRight", z.headRight), r("trace", z.trace), r("hero", z.hero),
                     r("heroUsed", heroUsed), r("tile0", z.tile0), r("tile1", z.tile1), r("chips", z.chips), r("allow", z.allow), r("deny", z.deny)]
        for (i, m) in z.mini.enumerated() { parts.append(r("mini\(i)", m)) }
        for (i, f) in z.film.enumerated() { parts.append(r("film\(i)", f)) }
        parts += [r("field", z.field), r("clear", z.clear), r("circle", z.circle), r("window", z.window), r("ask", z.ask), r("foot", z.foot),
                  r("footLeft", z.footLeft), r("bar", z.bar), r("footRight", z.footRight),
                  z.remedy.map { r("remedy", $0) } ?? "remedy x0–0 y0–0", r("console", z.console), r("sleep", z.sleep), "kind:\(z.kind.rawValue)"]
        return String(format: "island %.0f×%.0f | ", island.width, island.height) + parts.joined(separator: " | ")
    }
    /// The display's kind this frame.
    var previewCanvasKind: String { currentKind.rawValue }
    /// The hero's lines as wrapped this frame (the last one before its tail ellipsis).
    var previewHeroLines: [String] { heroLinesNow(zones(in: islandOpenRect)).lines.map { $0 as String } }
    /// The meter bar's target fill (billed ÷ the day's; 0 asleep) and the trace's level.
    var previewMeterFill: CGFloat { meterFillTarget() }
    var previewTraceLevel: CGFloat { traceLive ? finite01(sim.islandLevel) : 0 }
    /// The foot is the problem row right now (island open, a problem set).
    var previewFootProblem: Bool { mode == .island && parked && content.problem != nil }
    /// The Say box's placeholder as chosen, and its measured width.
    var previewFieldPlaceholder: String { fieldPlaceholder() }
    var previewFieldPlaceholderWidth: CGFloat { Self.textWidth(fieldPlaceholder() as NSString, Self.placeholderAttrs) }

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
        case nil: return ""
        }
    }
    var previewPillKind: String {
        switch slot(now: CACurrentMediaTime(), open: finite01(CGFloat(openSpring.value))) {
        case .gate: return "gate"
        case .pill(let p): return p.tone == .mark ? "mark-landed" : "toast"
        case nil: return ""
        }
    }
    /// The lip's marks chip ("◎2"), or "" — tucked with pending marks.
    var previewLipChip: String { mode == .tucked && content.pendingMarks > 0 ? "◎\(content.pendingMarks)" : "" }
    /// The lip glow's colour name this frame: "mark" while marks wait, else "phase".
    var previewLipGlow: String { mode == .tucked && content.pendingMarks > 0 ? "mark" : "phase" }
    /// The hero's words (the field's own text while it has key; "" when nothing is said).
    var previewLineText: String {
        if fieldFocused { return field.stringValue }
        return heroChoice().text
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
    /// The thumbnail slots this frame — films (marks kind) or minis (question kind): "slot:id:pending|used:crop|skeleton" and the overflow count.
    var previewThumbs: [String] {
        let z = zones(in: islandOpenRect)
        let t = thumbSlots(z)
        var out = t.slots.map { "\($0.index):\($0.mark.id):\($0.mark.consumed ? "used" : "pending"):\($0.mark.thumbnail == nil ? "skeleton" : "crop")" }
        if let o = t.overflow { out.append("+\(o.count)") }
        return out
    }
    /// The threads as drawn — tiles (≤ 2) or the chip line (3+), plain kind only: "id:text:stop|nostop".
    var previewThreadChips: [String] {
        let z = zones(in: islandOpenRect)
        let now = Date()
        let tiles = tileSlots(z).map { "\($0.row.id):\(Self.threadText($0.row, now: now)):\($0.stop == nil ? "nostop" : "stop")" }
        if !tiles.isEmpty { return tiles }
        return threadChips(z, now: now).map { "\($0.row.id):\($0.text):\($0.stop == nil ? "nostop" : "stop")" }
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
    /// The control a press at a point (x/y from the island's top-left) would reach, by name; "" for none.
    func previewButton(atIsland p: NSPoint) -> String {
        let island = islandOpenRect
        return button(at: NSPoint(x: island.minX + p.x, y: island.minY + p.y)).map { Self.previewName(of: $0) } ?? ""
    }
    /// The head caption as drawn this frame (fitted to its span), "" outside the marks kind.
    var previewHeadCaption: String { currentKind == .marks ? (headCaption() ?? "") : "" }
    /// The problem row as drawn: the noun, the clause (or "" when omitted) and the room left for it before the remedy.
    var previewProblemRow: String {
        guard let p = content.problem else { return "" }
        let row = problemRowText(p, zones(in: islandOpenRect))
        return String(format: "noun '%@' clause '%@' room %.0f", row.noun, row.clause, row.room)
    }
    /// Each mark's decoded thumbnail in pixels, newest first: "index:WxH" ("index:none" for a skeleton).
    var previewThumbPixels: [String] {
        Array(content.marks.reversed()).enumerated().map { i, m in
            m.thumbnail.map { "\(i):\($0.width)x\($0.height)" } ?? "\(i):none"
        }
    }
    /// Every animated hero swap so far: the lines that left, the text that arrived, when (CACurrentMediaTime).
    nonisolated(unsafe) static var previewHeroSwaps: [(from: String, to: String, at: Double)] = []
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
