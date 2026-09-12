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
//            bottom edge — plus a one-pixel glow along the lip that breathes.
//   peeking  awake: a 26 pt island hanging under the notch, the face centred, widening
//            by up to 30 pt and pulsing with the audio while listening or speaking,
//            the phase colour as a hairline along its bottom edge, never a wash.
//            The island body carries the app icon's dithered orb gradient (NotchInk.swift
//            over UI/Dither.swift), pooling out of the pure-black notch — unmistakably
//            the orb's colour even in this strip, the eyes on their ground under-copy.
//   island   hover (or the capsule toggle): ~360×92, sprung open (`Motion.island`) —
//            the face left; then the transport as a 22 pt circle (a hairline ring in the
//            phase colour, a solid play / pause / ellipsis), the phase word right after
//            it and the last transcript line under the word; Stop and Mute as square
//            hairline boxes at the right (Mute dimmed and dead outside a session). The
//            content fades in and rises a few points with a ≤ 40 ms stagger as the island
//            opens and fades on close (none of the rise or stagger under Reduce Motion);
//            it contracts 600 ms after the pointer leaves. A global mouse-moved monitor
//            (no Accessibility grant needed) sees the pointer approach while the island
//            is small. Its top corners are generously rounded where it hangs from the
//            bar, with concave fillets into the notch's column (NotchInk.shape).
//   working  a delegation runs (`workingSince`, set by the controller from the snapshot's
//            running delegation): "Working · 0:12" in mono digits — right of the face in
//            the peek (the island widens by the counter's width and the face slides left
//            by half of it, so the pair stays centred), right of the phase word on the
//            open island, and, while the blob is out at its target (not parked), alone
//            on a quiet black strip of peek height under the notch. Fades in and out over
//            `Motion.base`; gone the moment the delegation is done or cancelled.
//
// Geometry comes from NSScreen (`auxiliaryTopLeftArea` / `auxiliaryTopRightArea`:
// the notch is the gap between them; on Kevin's 14" it is x 771…956, 185×32 pt, under
// a 33 pt menu bar) on whichever display has one — the built-in, main or not — and is
// recomputed on every screen change. With no notch on any display (the lid closed) the
// dock reports no geometry and the controller falls back to free mode.
//
// Every duration, curve and spring here is `Motion`'s (UI/Motion.swift).

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
    /// its widest and tallest. Recomputed with the geometry.
    var panelFrame: NSRect {
        let width = max(notch.width + 2 * Self.wing, Self.islandWidth + 2 * 20)
        let x = notch.midX - width / 2
        let y = menuBarBottom - Self.drop
        return NSRect(x: x, y: y, width: width, height: screen.maxY - y)
    }

    static let wing: CGFloat = 40
    /// Room under the menu bar: the island (92) plus the gate pill beneath it.
    static let drop: CGFloat = 44 + 92
    static let islandWidth: CGFloat = 360
    static let islandHeight: CGFloat = 92
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
}

// MARK: - Dock

/// What the notch shows and does. Owned by `OrbPanelController`; the controller sets
/// `parked` (the blob is in the notch: draw the face and step the sim here) and reads
/// `dockPointCG` / `dropPointCG` for the flights in and out.
@MainActor
final class NotchDock {
    enum Mode: String { case tucked, peek, island }

    let panel: NotchPanel
    let view: NotchView
    private(set) var geometry: NotchGeometry
    private var monitors: [Any] = []
    private var contractTimer: Task<Void, Never>?
    private var hovered = false
    /// The island held open by the capsule toggle (a hotkey, a click), not the pointer.
    private var pinned = false
    /// The pointer is on or about the island (its approach zone, or the open island
    /// with its slop): the one time the panel should take the mouse.
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
    var parked = false {
        didSet {
            guard parked != oldValue else { return }
            view.parked = parked
            if !parked { hovered = false; pinned = false }
            view.setMode(mode, animated: true)
            view.wake()
            refreshMouseAcceptance()
        }
    }

    /// The panel takes the mouse only where there is something to take it: parked, with
    /// the pointer near the island (or the island held open by the toggle), or while a
    /// drag out of the notch is running through it. Everywhere else — the clear
    /// 400×169 pt over the menu bar and the desktop — it ignores mouse events outright
    /// (`ignoresMouseEvents`), rather than trusting the window server's alpha
    /// pass-through for a layer-backed clear panel. The global mouse-moved monitor sees
    /// the pointer approach while the panel is ignoring events and turns them back on
    /// before a click can land. Never changed mid-drag: the drag's events are owed to
    /// the view that took the mouse-down.
    private func refreshMouseAcceptance() {
        let accept = view.isDragging || (parked && (pointerNear || pinned))
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

    init(sim: BlobSim, geometry: NotchGeometry) {
        self.geometry = geometry
        // The gradient's blue-noise tile, on the render queue before the first island asks.
        NotchInk.prewarm()
        let frame = geometry.panelFrame
        panel = NotchPanel(contentRect: frame, styleMask: [.nonactivatingPanel, .borderless, .fullSizeContentView], backing: .buffered, defer: false)
        view = NotchView(frame: NSRect(origin: .zero, size: frame.size), sim: sim)
        view.autoresizingMask = [.width, .height]
        panel.contentView = view
        view.geometry = geometry
        view.onPress = { [weak self] which in
            switch which {
            case .pause: self?.togglePause()
            case .stop: self?.stop()
            case .mute: self?.toggleMute()
            case .face: self?.toggleIsland()
            }
        }
        view.onDragOut = { [weak self] p in self?.dragOut(p) }
        view.onDragMoved = { [weak self] p in self?.dragMoved(p) }
        view.onDragEnded = { [weak self] in self?.dragEnded() }
        view.onHover = { [weak self] over in self?.pointer(over: over) }
        view.setMode(.tucked, animated: false)
    }

    deinit {
        for m in monitors { NSEvent.removeMonitor(m) }
        contractTimer?.cancel()
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

    var mode: Mode {
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

    /// The gate's pill (question, verdict, countdown) under the notch while asleep.
    func setGatePill(_ pill: OrbPill?) {
        view.gatePill = pill
        view.wake()
    }

    /// The capsule toggle in notch mode: the island opens and stays until toggled again
    /// or the pointer leaves it.
    func toggleIsland() {
        pinned.toggle()
        if pinned { contractTimer?.cancel(); contractTimer = nil }
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
    /// Either way the panel takes the mouse only while the pointer is about the island.
    private func pointer(at p: NSPoint) {
        #if JARHEAD_ORB_PREVIEW
        // The harness's shots are scripted (`previewHover`); Kevin's own pointer, which
        // may well be sitting under the notch, must not open the island in them.
        if Self.previewIgnoresPointer { return }
        #endif
        guard parked else { pointerNear = false; refreshMouseAcceptance(); return }
        let island = view.islandScreenRect(in: panel)
        // Approach: within 8 pt of the small island, or in the menu bar over the notch.
        let approach = island.insetBy(dx: -8, dy: -8).union(NSRect(x: geometry.notch.minX, y: geometry.menuBarBottom, width: geometry.notch.width, height: geometry.notch.height + 1))
        let withSlop = island.insetBy(dx: -14, dy: -14).contains(p)
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
    /// ORB_NOTCH_HOVER / ORB_NOTCH_PRESSED = pause|stop|mute: draw that island button as
    /// hovered / pressed in the harness's shots (the hover lift, the accent press fill).
    nonisolated(unsafe) static var previewHoveredButton = ProcessInfo.processInfo.environment["ORB_NOTCH_HOVER"]
    nonisolated(unsafe) static var previewPressedButton = ProcessInfo.processInfo.environment["ORB_NOTCH_PRESSED"]
    /// ORB_NOTCH_WORKING=1: the working state ("Working · 0:12") follows the phase in the harness.
    nonisolated(unsafe) static var previewWorkingFollowsPhase = ProcessInfo.processInfo.environment["ORB_NOTCH_WORKING"] == "1"
    /// Pretend the pointer approached (or left) the island.
    func previewHover(_ over: Bool) { pointer(over: over) }
    var previewMode: String { mode.rawValue }
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
/// itself, which nothing lives behind — takes it (`NotchView.hitTest`).
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

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

// MARK: - View

/// Paints the notch's ink, the island and the face, and runs the notch's own display
/// link: while the blob is parked here the orb panel is hidden and its link paused, so
/// this one steps the shared `BlobSim` (at the sim's own cadence) and animates the
/// island's spring. Flipped: y down, like the field.
@MainActor
final class NotchView: NSView, NSViewToolTipOwner, NotchInkObserver {
    /// The island's controls. `.pause` is the transport — the circle: Go while asleep,
    /// in error or paused, Pause in a session, a stop while connecting (the dock's
    /// `togglePause` → `AppState.transportToggle` decides).
    enum Press { case pause, stop, mute, face }

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

    /// The working state: the running delegation's start, seconds since 1970 (the
    /// snapshot's `timings.delegatedAt / 1000`), or nil. Flipping it starts the
    /// counter's fade (`workLevel`) and, with the blob out, grows or shrinks the strip.
    var workingSince: Double? {
        didSet {
            let was = oldValue != nil, now = workingSince != nil
            if was != now {
                workingChangedAt = window == nil ? -1 : CACurrentMediaTime()
                setMode(mode, animated: true)
            } else if workingSince != oldValue {
                needsDisplay = true
            }
        }
    }
    /// When `workingSince` last flipped between nil and a value (< 0: never / snapped).
    private var workingChangedAt = -1.0
    /// The phase, for the harness's working knob (`NotchDock.phaseChanged`).
    var currentPhase: Phase { sim.phase }

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

    /// The island's symbols, tinted once per (name, size, tint): three a frame while the
    /// island is open would otherwise be three fresh images a frame.
    private static var symbolCache: [String: NSImage] = [:]

    /// A solid SF Symbol at `pointSize` (semibold) in `tint` (white at some alpha), cached.
    private static func symbol(_ name: String, pointSize: CGFloat, tint: NSColor) -> NSImage? {
        let key = "\(name)|\(pointSize)|\(tint.alphaComponent)"
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

    /// The island's fonts and attribute sets, made once and kept for the life of the
    /// process: no font lookups per frame, and a font this view holds cannot be torn
    /// down under the typesetter — the 22:39 report of 2026-09-11 had CoreText's
    /// shaping thread in `TFont::~TFont` while the main thread was applying a font to
    /// these words. Colours as before, to the value: the words must not change.
    private static let phaseFont = NSFont.systemFont(ofSize: 12, weight: .medium)
    private static let lineFont = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
    private static let pillFont = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular)
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
    /// "Working · 0:12": mono digits (the meter's font), the 0.72 step, an ink shadow under it.
    private static let workAttrs: [NSAttributedString.Key: Any] = [.font: pillFont, .foregroundColor: NSColor(white: 1, alpha: 0.72)]
    private static let workShadow: [NSAttributedString.Key: Any] = [.font: pillFont, .foregroundColor: NSColor(white: 0, alpha: 0.55)]
    /// The counter's widest plausible text, measured once: the peek widens by this plus
    /// padding while working, so the island never re-lays itself as the digits roll.
    private static let workTextWidth: CGFloat = textWidth("Working · 00:00" as NSString, workAttrs)
    /// What the peek island grows by while working (the counter, a gap from the face, padding).
    private static var peekExtraWidth: CGFloat { workTextWidth > 0 ? workTextWidth + 18 : 0 }

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
        // The island's fonts exist from here on, long before the first island opens.
        _ = Self.phaseAttrs; _ = Self.lineAttrs; _ = Self.lineAttrsEmpty; _ = Self.pillAttrs; _ = Self.workAttrs; _ = Self.workTextWidth
    }

    required init?(coder: NSCoder) { fatalError("NotchView is code-only") }

    /// A gradient image landed (rendered in the background): draw it.
    func notchInkRendered() { wake() }

    override var isFlipped: Bool { true }

    /// Awake: the phase is not asleep (the gate faces belong to the tucked lip).
    var awake: Bool { sim.phase != .asleep }

    /// Mute has something to mute only with a session open (`AppState.inSessionPhases`).
    private var muteEnabled: Bool { AppState.inSessionPhases.contains(sim.phase) }

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

    /// Set the island's size for a mode, sprung (or snapped when not animated). With
    /// the blob out (not parked) the island shrinks away to nothing: it left. The
    /// content's fade clock starts here.
    func setMode(_ m: NotchDock.Mode, animated: Bool) {
        mode = m
        let n = geometry?.notch.width ?? 185
        if !parked {
            // The blob is out. Working, the notch keeps a quiet strip of peek height with
            // the counter alone on it (the face is on the body at its target); otherwise
            // the island shrinks away to nothing: it left.
            let strip = workingSince != nil
            widthSpring.target = strip ? n + Self.peekExtraWidth : n
            heightSpring.target = strip ? NotchGeometry.peekHeight : 0
            openSpring.target = 0
        } else {
            switch m {
            case .tucked:
                widthSpring.target = n
                heightSpring.target = NotchGeometry.lipHeight
                openSpring.target = 0
            case .peek:
                widthSpring.target = n
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
        }
        if !animated {
            widthSpring.snap(); heightSpring.snap(); openSpring.snap()
        }
        if m != .island { hoveredButton = nil }
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
    /// stagger, a press glow.
    private func isAnimating(_ now: Double) -> Bool {
        if !springsSettled { return true }
        let base = seconds(Motion.base)
        if parkedChangedAt >= 0, now - parkedChangedAt < base { return true }
        if contentShown, contentOpenedAt >= 0, now - contentOpenedAt < base + 3 * Motion.stagger { return true }
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

    @objc private func onFrame(_ link: CADisplayLink) {
        let now = CACurrentMediaTime()
        if lastTick == 0 { lastTick = now; lastRender = 0 }
        let dt = min(0.1, now - lastTick)
        lastTick = now
        // Peeking, the island breathes with the sound: up to 30 pt wider on the eased
        // level (the spring smooths it into a pulse; `draw` brightens the hairline with
        // it). Not under reduce motion, where the island holds its size.
        if parked, mode == .peek, let n = geometry?.notch.width {
            // Working, the peek also carries the counter right of the face: room for it, eased in.
            widthSpring.target = Double(n) + (sim.reducedMotion ? 0 : 30 * finite01(sim.islandLevel)) + Double(Self.peekExtraWidth * workLevel(now))
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
        // Working counts as busy (the counter rolls once a second, at the idle rate).
        let busy = animating || (parked && !sim.isStatic) || (parked && sim.rawLevelsActive) || workingSince != nil
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

    /// The island content's element `i` (0 the transport, 1 the phase word, 2 the last
    /// line, 3 the buttons): its alpha and rise (pt, + is down) this frame — appearing
    /// over `Motion.base` on `Motion.easeOut`, from 6 pt below, `Motion.stagger` after
    /// the one before (a plain fade, together, under Reduce Motion); leaving over
    /// `Motion.quick` on `Motion.easeIn`, drifting 4 pt up into the bar. Nil: not drawn.
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

    // MARK: drawing

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
    private func faceLayout(island: NSRect, open: CGFloat, lipFace: Bool, shift: CGFloat = 0) -> FaceLayout {
        let size = (lipFace ? BlobSim.eyeSizePt * 0.85 : BlobSim.eyeSizePt) * Double(1 + 0.45 * open)
        let gap = CGFloat(size) * 0.95
        let x = island.minX + (island.width / 2) * (1 - open) + (14 + gap + 10) * open + (shift.isFinite ? shift : 0) * (1 - open)
        let y = island.minY + island.height / 2 + (lipFace ? -1 : 0)
        return FaceLayout(centre: CGPoint(x: x, y: y), size: size, gap: gap)
    }

    /// The open island's content, laid out in `island` (the open rect): the transport
    /// circle after the face, the phase word right after it with the last line under
    /// the word, Stop and Mute at the right.
    private struct ContentLayout {
        let transport: NSRect
        let word: NSRect
        let line: NSRect
        let stop: NSRect
        let mute: NSRect
        /// Every rect a number: the only layout that reaches a draw.
        var isFinite: Bool { transport.isFiniteRect && word.isFiniteRect && line.isFiniteRect && stop.isFiniteRect && mute.isFiniteRect }
    }

    private func contentLayout(in island: NSRect) -> ContentLayout {
        let face = faceLayout(island: island, open: 1, lipFace: false)
        let d = Self.transportDiameter
        let transport = NSRect(x: face.right + 6, y: island.minY + 25, width: d, height: d)
        let w: CGFloat = 26, h: CGFloat = 24, gap: CGFloat = 6
        let by = island.midY - h / 2
        let mute = NSRect(x: island.maxX - 14 - w, y: by, width: w, height: h)
        let stop = NSRect(x: mute.minX - gap - w, y: by, width: w, height: h)
        let textLeft = transport.maxX + 8
        let width = max(20, stop.minX - 12 - textLeft)
        let word = NSRect(x: textLeft, y: island.minY + 27, width: width, height: 18)
        let line = NSRect(x: textLeft, y: island.minY + 49, width: width, height: 16)
        return ContentLayout(transport: transport, word: word, line: line, stop: stop, mute: mute)
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let cg = NSGraphicsContext.current?.cgContext, geometry != nil else { return }
        let now = CACurrentMediaTime()
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
        let park = finite01(parkLevel(now))
        let work = finite01(workLevel(now))
        // The blob is out at its target and a delegation runs: the counter alone on the
        // strip (no face — that is on the body), fading with the park level's inverse.
        if work > 0.005, park < 0.995, island.isFiniteRect, island.height >= 1 {
            drawWorkingStrip(cg, shape: shape, island: island, color: sim.displayColor, alpha: work * (1 - park))
        }
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
        // Island: the face at the left, larger. It slides with the spring; its ground
        // under-copy (`drawEye`) keeps it readable over the gradient's light end.
        let face = sim.face
        let lipFace = mode == .tucked && open < 0.5
        // Working in the peek: the face gives half the counter's width to keep the pair centred.
        let peekShift: CGFloat = lipFace ? 0 : -(Self.peekExtraWidth / 2) * work
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
        // a one-pixel glow that breathes along the lip (tucked). Peeking, the hairline
        // pulses with the sound as the island widens with it (`onFrame`).
        let hairAlpha: Double
        if lipFace {
            hairAlpha = 0.18 + 0.22 * (sim.reducedMotion ? 0.5 : breath)
        } else if mode == .peek, open < 0.5 {
            hairAlpha = 0.55 + 0.4 * (sim.reducedMotion ? 0.5 : finite01(sim.islandLevel))
        } else {
            hairAlpha = 0.9
        }
        let inset = max(shape.bottomRadius, 2)
        cg.setStrokeColor(color.cgColor(alpha: finite01(hairAlpha)))
        cg.setLineWidth(1)
        cg.move(to: CGPoint(x: island.minX + inset, y: island.maxY - 0.5))
        cg.addLine(to: CGPoint(x: island.maxX - inset, y: island.maxY - 0.5))
        cg.strokePath()

        // Working, peeking: "Working · 0:12" right of the face, fading as the island opens
        // (on the open island it sits after the phase word instead).
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
                Self.drawText(text, in: rect.offsetBy(dx: 0, dy: 1), Self.workShadow)
                Self.drawText(text, in: rect, Self.workAttrs)
                cg.restoreGState()
                NSGraphicsContext.restoreGraphicsState()
            }
        }

        // The island's transport, words and buttons: laid out in the open island's rect,
        // revealed by the ink as it opens, each fading in and rising on its own beat.
        if contentAppearance(0, now: now) != nil || contentAppearance(3, now: now) != nil {
            let layout = contentLayout(in: islandOpenRect)
            if layout.isFinite {
                drawIslandContent(cg, layout: layout, color: color, park: park, now: now)
            } else {
                BadNumber.noteOnce("NotchView content layout", "word \(layout.word) transport \(layout.transport)")
            }
        }
        cg.restoreGState()
        cg.restoreGState()

        // The gate's pill under the island while it asks (the lock), or says no.
        if let pill = gatePill, !awake {
            drawGatePill(cg, pill, below: island)
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

    /// The accent, for a press.
    private static let accent = NSColor(srgbRed: 0x5b / 255, green: 0x82 / 255, blue: 0xff / 255, alpha: 1)

    /// The transport circle, the phase word and the last line, then Stop and Mute — each
    /// at its own fade and rise (`contentAppearance`), all under the park level.
    ///
    /// Alpha is one product per element — park × appearance × (a third for a dead Mute)
    /// — set on the context for the fills, strokes and words and passed as `fraction:`
    /// to the symbol draws: `NSImage.draw(…fraction:)` replaces the context's alpha
    /// rather than multiplying it (as does a nested `setAlpha`), which is how the glyphs
    /// once popped in at full white while everything around them faded.
    private func drawIslandContent(_ cg: CGContext, layout l: ContentLayout, color: RGB, park: CGFloat, now: Double) {
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

        // 1, 2: the words — a one-pixel ink shadow under each, then the white, so they
        // read where the gradient runs light. Fonts and attributes are the view's
        // statics; every draw goes through `drawText` (finite rect, exception guard).
        if let a = contentAppearance(1, now: now) {
            cg.saveGState()
            cg.setAlpha(finite01(park * a.alpha))
            let word = OrbStyle.label(sim.phase) as NSString
            let rect = l.word.offsetBy(dx: 0, dy: a.dy)
            Self.drawText(word, in: rect.offsetBy(dx: 0, dy: 1), Self.phaseShadow)
            Self.drawText(word, in: rect, Self.phaseAttrs)
            // Working: "Working · 0:12" right after the phase word, mono digits, one step dimmer.
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
                    Self.drawText(text, in: box.offsetBy(dx: 0, dy: 1), Self.workShadow)
                    Self.drawText(text, in: box, Self.workAttrs)
                    cg.restoreGState()
                }
            }
            cg.restoreGState()
        }
        if let a = contentAppearance(2, now: now) {
            cg.saveGState()
            cg.setAlpha(finite01(park * a.alpha))
            let line = lastLine
            let text = (line.isEmpty ? "—" : line) as NSString
            let rect = l.line.offsetBy(dx: 0, dy: a.dy)
            Self.drawText(text, in: rect.offsetBy(dx: 0, dy: 1), Self.lineShadow)
            Self.drawText(text, in: rect, line.isEmpty ? Self.lineAttrsEmpty : Self.lineAttrs)
            cg.restoreGState()
        }

        // 3: Stop and Mute — 26×24 boxes, a translucent ink fill under a hairline so they
        // sit on the gradient, a solid symbol each; hover one alpha step; the pressed one
        // filled with the accent, letting go over `Motion.base`. Mute dims to a third
        // and takes nothing outside a session: there is no microphone to mute.
        if let a = contentAppearance(3, now: now) {
            for (which, rect0) in [(Press.stop, l.stop), (.mute, l.mute)] {
                let rect = rect0.offsetBy(dx: 0, dy: a.dy)
                let enabled = which != .mute || muteEnabled
                let alpha = finite01(park * a.alpha * (enabled ? 1 : 0.35))
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
                let name: String
                switch which {
                case .stop: name = "stop.fill"
                case .mute: name = sim.phase == .muted ? "mic.slash.fill" : "mic.fill"
                case .pause, .face: name = ""
                }
                if let img = Self.symbol(name, pointSize: 11, tint: down || hot ? white : white.withAlphaComponent(0.78)) {
                    let s = img.size
                    img.draw(in: NSRect(x: rect.midX - s.width / 2, y: rect.midY - s.height / 2, width: s.width, height: s.height),
                             from: .zero, operation: .sourceOver, fraction: alpha, respectFlipped: true, hints: nil)
                }
                cg.restoreGState()
            }
        }
        NSGraphicsContext.restoreGraphicsState()
    }

    /// The working strip: the blob is out at its target, a delegation runs. The ink is
    /// already down (the notch grown to peek height); this adds the phase colour as the
    /// hairline along the bottom edge and "Working · 0:12" centred — nothing else, so
    /// the notch reads as busy without competing with the body on the screen.
    private func drawWorkingStrip(_ cg: CGContext, shape: NotchInk.Shape, island: NSRect, color: RGB, alpha: CGFloat) {
        let a = finite01(alpha)
        guard a > 0.005 else { return }
        cg.saveGState()
        cg.addPath(shape.path)
        cg.clip()
        cg.setAlpha(a)
        let inset = max(shape.bottomRadius, 2)
        cg.setStrokeColor(color.cgColor(alpha: 0.9))
        cg.setLineWidth(1)
        cg.move(to: CGPoint(x: island.minX + inset, y: island.maxY - 0.5))
        cg.addLine(to: CGPoint(x: island.maxX - inset, y: island.maxY - 0.5))
        cg.strokePath()
        let text = workingText()
        let w = Self.textWidth(text, Self.workAttrs)
        if w > 0, island.height >= 14 {
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(cgContext: cg, flipped: true)
            cg.setShouldSmoothFonts(false)
            cg.setAllowsFontSubpixelPositioning(true)
            cg.setShouldSubpixelPositionFonts(true)
            let rect = NSRect(x: island.midX - w / 2 - 1, y: island.midY - 8, width: min(w + 2, max(0, island.width - 12)), height: 16)
            if rect.width > 24 {
                Self.drawText(text, in: rect.offsetBy(dx: 0, dy: 1), Self.workShadow)
                Self.drawText(text, in: rect, Self.workAttrs)
            }
            NSGraphicsContext.restoreGraphicsState()
        }
        cg.restoreGState()
    }

    /// The last transcript line, set by the controller (mono, one line).
    var lastLine = "" { didSet { if lastLine != oldValue { needsDisplay = true } } }

    /// The buttons' help text (a tooltip when the pointer rests on one; the whole view
    /// is one tooltip rect, the string chosen by the point): the transport's word for
    /// the phase (`AppState.transportPress`), Stop, Mute / Unmute.
    func helpText(for which: Press) -> String {
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
        }
    }

    /// `NSViewToolTipOwner`'s requirement is not main-actor in the SDK; AppKit asks on
    /// the main thread, so the isolation is assumed rather than inherited (an error in
    /// the Swift 6 language mode otherwise).
    nonisolated func view(_ view: NSView, stringForToolTip tag: NSView.ToolTipTag, point: NSPoint, userData data: UnsafeMutableRawPointer?) -> String {
        MainActor.assumeIsolated {
            guard let b = button(at: point) else { return "" }
            return helpText(for: b)
        }
    }

    private func installToolTip() {
        removeAllToolTips()
        addToolTip(bounds, owner: self, userData: nil)
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        installToolTip()
    }

    /// The island's live controls and where they are (the open island's layout): the
    /// transport circle, Stop, and Mute only while it can mute. Hit-testing, hover,
    /// tooltips and presses all read this one list.
    private func buttonRects(in island: NSRect) -> [(Press, NSRect)] {
        let l = contentLayout(in: island)
        var out: [(Press, NSRect)] = [(.pause, l.transport), (.stop, l.stop)]
        if muteEnabled { out.append((.mute, l.mute)) }
        return out
    }

    /// The gate's pill: ground, hairline, a solid symbol or a tone dot, the words.
    private func drawGatePill(_ cg: CGContext, _ pill: OrbPill, below island: NSRect) {
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: cg, flipped: true)
        var text = pill.text
        if let until = pill.until {
            let left = until.timeIntervalSinceNow
            text += " · \(left.isFinite ? max(1, Int(min(left, 1e6).rounded())) : 1) s"
        }
        let attrs = Self.pillAttrs
        let tw = Self.textWidth(text as NSString, attrs)
        let iconW: CGFloat = pill.icon != nil ? 15 : (pill.tone != .info ? 10 : 0)
        let w = tw + iconW + 16, h: CGFloat = 20
        let rect = NSRect(x: island.midX - w / 2, y: island.maxY + 6, width: w, height: h)
        guard rect.isFiniteRect else { BadNumber.noteOnce("NotchView gate pill", "\(rect)"); NSGraphicsContext.restoreGraphicsState(); return }
        let box = NSBezierPath(roundedRect: rect, xRadius: 6, yRadius: 6)
        NSColor(srgbRed: 0x10 / 255, green: 0x10 / 255, blue: 0x10 / 255, alpha: 0.94).setFill(); box.fill()
        NSColor(white: 1, alpha: 0.22).setStroke(); box.lineWidth = 1; box.stroke()
        var x = rect.minX + 8
        if let icon = pill.icon, let img = NSImage(systemSymbolName: icon, accessibilityDescription: nil)?.withSymbolConfiguration(.init(pointSize: 10, weight: .semibold)) {
            let tint: NSColor
            switch pill.tone {
            case .info: tint = NSColor(white: 1, alpha: 0.72)
            case .warn: tint = NSColor(srgbRed: 0x8a / 255, green: 0x8f / 255, blue: 0x98 / 255, alpha: 1)
            case .error: tint = NSColor(srgbRed: 0xff / 255, green: 0x5d / 255, blue: 0x6c / 255, alpha: 1)
            }
            let t = img.tinted(tint)
            t.draw(in: NSRect(x: x, y: rect.midY - t.size.height / 2, width: t.size.width, height: t.size.height), from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
            x += 15
        } else if pill.tone != .info {
            let c = pill.tone == .error ? OrbPalette.error : OrbPalette.speaking
            NSColor(srgbRed: c.r, green: c.g, blue: c.b, alpha: 1).setFill()
            NSBezierPath(ovalIn: NSRect(x: x, y: rect.midY - 2.5, width: 5, height: 5)).fill()
            x += 10
        }
        Self.drawText(text as NSString, at: NSPoint(x: x, y: rect.minY + 3), attrs)
        NSGraphicsContext.restoreGraphicsState()
    }

    // MARK: mouse

    /// A drag out of the notch is running through this view (its mouse-down, its events).
    var isDragging: Bool { dragging }

    /// Only the ink takes the mouse: the island (and the notch's column, where nothing
    /// else lives). Everything else in the panel is clear and falls through.
    override func hitTest(_ point: NSPoint) -> NSView? {
        guard parked else { return nil }
        let p = convert(point, from: superview)
        return islandRect.insetBy(dx: -2, dy: -2).contains(p) || notchRect.contains(p) ? self : nil
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    /// The control under `p`, once the island is (nearly) open. The circle gets a
    /// point more slop than the boxes: it is the one most reached for.
    private func button(at p: NSPoint) -> Press? {
        guard mode == .island, openSpring.value > 0.8 else { return nil }
        return buttonRects(in: islandOpenRect).first { which, rect in
            let slop: CGFloat = which == .pause ? 3 : 2
            return rect.insetBy(dx: -slop, dy: -slop).contains(p)
        }?.0
    }

    override func mouseMoved(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        let b = button(at: p)
        if b != hoveredButton { hoveredButton = b; needsDisplay = true }
        onHover?(islandRect.contains(p))
    }

    override func mouseExited(with event: NSEvent) {
        if hoveredButton != nil { hoveredButton = nil; needsDisplay = true }
    }

    override func mouseDown(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        downPoint = p
        dragging = false
        if let b = button(at: p) { pressing = b; needsDisplay = true }
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
            flashPress = b
            flashAt = CACurrentMediaTime()
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
}

extension NotchView.Press {
    /// The harness's names for the island's buttons (ORB_NOTCH_HOVER / ORB_NOTCH_PRESSED).
    init?(previewName: String) {
        switch previewName.lowercased() {
        case "pause", "go", "transport": self = .pause
        case "stop": self = .stop
        case "mute": self = .mute
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
