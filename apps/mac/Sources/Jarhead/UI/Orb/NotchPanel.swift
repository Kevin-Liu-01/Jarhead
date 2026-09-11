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
//   island   hover (or the capsule toggle): ~360×92, sprung open over ~180 ms — the
//            face left, the phase word and the last transcript line centre, and the
//            Pause / Stop / Mute micro-buttons right; contracts 600 ms after the
//            pointer leaves. A global mouse-moved monitor (no Accessibility grant
//            needed) sees the pointer approach while the island is small.
//
// Geometry comes from NSScreen (`auxiliaryTopLeftArea` / `auxiliaryTopRightArea`:
// the notch is the gap between them; on Kevin's 14" it is x 771…956, 185×32 pt, under
// a 33 pt menu bar) and is recomputed on every screen change. Without a notch on the
// main display the dock reports no geometry and the controller falls back to free mode.

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

    /// The main display's notch, or nil when it has none (an external display as main,
    /// the lid closed). "Main" is the display with the menu bar: `NSScreen.screens.first`.
    @MainActor
    static func current() -> NotchGeometry? {
        guard let screen = NSScreen.screens.first else { return nil }
        let frame = screen.frame
        if let left = screen.auxiliaryTopLeftArea, let right = screen.auxiliaryTopRightArea {
            let notch = NSRect(x: left.maxX, y: left.minY, width: right.minX - left.maxX, height: frame.maxY - left.minY)
            guard notch.width > 20, notch.height > 8 else { return simulated(on: screen) }
            return NotchGeometry(notch: notch, menuBarBottom: menuBarBottom(of: screen, notchHeight: notch.height), screen: frame)
        }
        return simulated(on: screen)
    }

    private static func simulated(on screen: NSScreen) -> NotchGeometry? {
        guard simulate else { return nil }
        let frame = screen.frame
        let notch = NSRect(x: frame.midX - 92.5, y: frame.maxY - 32, width: 185, height: 32)
        return NotchGeometry(notch: notch, menuBarBottom: menuBarBottom(of: screen, notchHeight: 32), screen: frame)
    }

    /// The menu bar's bottom: `visibleFrame.maxY` while a menu bar is showing; with the
    /// menu bar hidden the island hangs straight from the notch.
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
    var togglePause: () -> Void = {}
    var stop: () -> Void = {}
    var toggleMute: () -> Void = {}
    /// The pointer grabbed the face and pulled: (CG point) — the controller takes over the drag.
    var dragOut: (CGPoint) -> Void = { _ in }
    var dragMoved: (CGPoint) -> Void = { _ in }
    var dragEnded: () -> Void = {}

    init(sim: BlobSim, geometry: NotchGeometry) {
        self.geometry = geometry
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
        view.setMode(mode, animated: true)
        view.wake()
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
    /// Pretend the pointer approached (or left) the island.
    func previewHover(_ over: Bool) { pointer(over: over) }
    var previewMode: String { mode.rawValue }
    /// The island's rect (CG), for framing a shot.
    var previewIslandCG: CGRect { CGSpace.rect(fromAppKit: view.islandScreenRect(in: panel)) }
    var previewPanelCG: CGRect { CGSpace.rect(fromAppKit: panel.frame) }
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
final class NotchView: NSView {
    enum Press { case pause, stop, mute, face }

    private let sim: BlobSim
    var geometry: NotchGeometry? { didSet { needsDisplay = true } }
    var parked = false { didSet { needsDisplay = true } }
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

    /// A critically-ish damped spring: ~180 ms to settle with a hint of overshoot.
    private struct Spring {
        var value: Double
        var target: Double
        var velocity = 0.0
        init(value: Double) { self.value = value; target = value }
        static let stiffness = 520.0
        static let damping = 2 * (520.0).squareRoot() * 0.78
        mutating func step(_ dt: Double) {
            let a = Self.stiffness * (target - value) - Self.damping * velocity
            velocity += a * dt
            value += velocity * dt
        }
        var settled: Bool { abs(target - value) < 0.15 && abs(velocity) < 2 }
        mutating func snap() { value = target; velocity = 0 }
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
    }

    required init?(coder: NSCoder) { fatalError("NotchView is code-only") }

    override var isFlipped: Bool { true }

    /// Awake: the phase is not asleep (the gate faces belong to the tucked lip).
    var awake: Bool { sim.phase != .asleep }

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

    /// The island in screen coordinates (AppKit), for the pointer.
    func islandScreenRect(in panel: NSWindow) -> NSRect {
        let r = islandRect
        let f = panel.frame
        return NSRect(x: f.minX + r.minX, y: f.maxY - r.maxY, width: r.width, height: r.height)
    }

    /// Set the island's size for a mode, sprung (or snapped under reduce motion). With
    /// the blob out (not parked) the island shrinks away to nothing: it left.
    func setMode(_ m: NotchDock.Mode, animated: Bool) {
        mode = m
        let n = geometry?.notch.width ?? 185
        if !parked {
            widthSpring.target = n
            heightSpring.target = 0
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
        if !animated || sim.reducedMotion {
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

    private var animating: Bool { !(widthSpring.settled && heightSpring.settled && openSpring.settled) }

    @objc private func onFrame(_ link: CADisplayLink) {
        let now = CACurrentMediaTime()
        if lastTick == 0 { lastTick = now; lastRender = 0 }
        let dt = min(0.1, now - lastTick)
        lastTick = now
        // Peeking, the island breathes with the sound: up to 30 pt wider on the eased
        // level (the spring smooths it into a pulse; `draw` brightens the hairline with
        // it). Not under reduce motion, where the island holds its size.
        if parked, mode == .peek, let n = geometry?.notch.width {
            widthSpring.target = Double(n) + (sim.reducedMotion ? 0 : 30 * sim.islandLevel)
        }
        if animating {
            let step = min(dt, 1.0 / 30)
            widthSpring.step(step); heightSpring.step(step); openSpring.step(step)
            if !animating { widthSpring.snap(); heightSpring.snap(); openSpring.snap() }
        }
        // The shared sim is stepped here only while the blob is parked (the field's
        // own link is paused then); at the sim's cadence, so a parked blob costs what
        // a resting blob costs.
        let wantRate = animating ? 60.0 : (parked ? max(10, sim.desiredFPS) : 10)
        var rendered = false
        if now - lastRender >= 1 / wantRate - 0.002 {
            if parked { sim.step(now - max(lastRender, now - 0.1)) }
            lastRender = now
            needsDisplay = true
            rendered = true
        }
        _ = rendered
        let busy = animating || (parked && !sim.isStatic) || (parked && sim.rawLevelsActive)
        if busy {
            idleSince = -1
        } else if idleSince < 0 {
            idleSince = now
        } else if now - idleSince > 0.6 {
            link.isPaused = true
            lastTick = 0
        }
    }

    // MARK: drawing

    override func draw(_ dirtyRect: NSRect) {
        guard let cg = NSGraphicsContext.current?.cgContext, geometry != nil else { return }
        let n = notchRect
        let island = islandRect
        let open = CGFloat(min(1, max(0, openSpring.value)))

        // The ink, one shape from the bezel down: the hardware notch, pure black
        // (nothing lives behind it), its column through the menu bar band, and the
        // island hanging from the bar's bottom edge. The island's bottom corners are
        // the notch's radius. Where the island is wider than the notch the join is a
        // concave fillet either side — the ink curving inward from the notch's side out
        // onto the island's top, the way the Dynamic Island grows out of the bezel — so
        // the island reads as the notch grown, not a pill hung under the bar with
        // shoulders and the bar showing above them. An island the notch's width joins
        // square, and its outer top corners are square too: they meet the bar's edge.
        cg.setFillColor(CGColor(gray: 0, alpha: 1))
        if island.height < 1 {
            cg.fill(n)
        } else {
            let r = min(NotchGeometry.radius, island.height / 2)
            let topR = min(NotchGeometry.radius, max(0, (island.width - n.width) / 2), max(0, island.minY))
            let x0 = island.minX, x1 = island.maxX, y0 = island.minY, y1 = island.maxY
            let path = CGMutablePath()
            path.move(to: CGPoint(x: n.minX, y: 0))
            if topR > 0.5 {
                path.addLine(to: CGPoint(x: n.minX, y: y0 - topR))
                path.addArc(tangent1End: CGPoint(x: n.minX, y: y0), tangent2End: CGPoint(x: n.minX - topR, y: y0), radius: topR)
            } else {
                path.addLine(to: CGPoint(x: n.minX, y: y0))
            }
            path.addLine(to: CGPoint(x: x0, y: y0))
            path.addLine(to: CGPoint(x: x0, y: y1 - r))
            path.addArc(tangent1End: CGPoint(x: x0, y: y1), tangent2End: CGPoint(x: x0 + r, y: y1), radius: r)
            path.addLine(to: CGPoint(x: x1 - r, y: y1))
            path.addArc(tangent1End: CGPoint(x: x1, y: y1), tangent2End: CGPoint(x: x1, y: y1 - r), radius: r)
            path.addLine(to: CGPoint(x: x1, y: y0))
            if topR > 0.5 {
                path.addLine(to: CGPoint(x: n.maxX + topR, y: y0))
                path.addArc(tangent1End: CGPoint(x: n.maxX, y: y0), tangent2End: CGPoint(x: n.maxX, y: y0 - topR), radius: topR)
            } else {
                path.addLine(to: CGPoint(x: n.maxX, y: y0))
            }
            path.addLine(to: CGPoint(x: n.maxX, y: 0))
            path.closeSubpath()
            cg.addPath(path)
            cg.fillPath()
        }
        guard parked, island.height >= 1 else { return }

        let color = sim.displayColor
        let glyphs = BlobGlyphs.shared
        cg.saveGState()
        cg.setAllowsAntialiasing(true)
        cg.setShouldAntialias(true)
        cg.setShouldSmoothFonts(false)
        cg.setAllowsFontSubpixelPositioning(true)
        cg.setShouldSubpixelPositionFonts(true)

        // The face. Tucked: dark grey dashes at the lip, the sim's face (the gate's
        // while it listens or asks). Peeking: the phase colour a step up, centred.
        // Island: the face at the left, larger.
        let face = sim.face
        let lipFace = mode == .tucked && open < 0.5
        let size = (lipFace ? BlobSim.eyeSizePt * 0.85 : BlobSim.eyeSizePt) * Double(1 + 0.45 * open)
        let gap = CGFloat(size) * 0.95
        let faceCentreX: CGFloat = island.minX + (island.width / 2) * (1 - open) + (14 + gap + 10) * open
        let faceCentreY: CGFloat = island.minY + island.height / 2 + (lipFace ? -1 : 0)
        // Cell shift: the look moves the pair by up to a glyph's third.
        let shiftX = CGFloat(sim.faceLookX) * CGFloat(size) * 0.3
        let shiftY = CGFloat(sim.faceLookY) * CGFloat(size) * 0.18
        let ink: RGB
        if lipFace, sim.gate == .off || sim.gate == .lockedOut {
            ink = RGB(hex: 0x4a4d55)
        } else if lipFace {
            ink = color.mixed(with: RGB(1, 1, 1), 0.35)
        } else {
            ink = color.mixed(with: RGB(1, 1, 1), sim.eyeLift)
        }
        let left = CGPoint(x: faceCentreX - gap / 2 + shiftX, y: faceCentreY + shiftY)
        let right = CGPoint(x: faceCentreX + gap / 2 + shiftX, y: faceCentreY + shiftY)
        cg.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
        BlobFieldView.drawEye(cg, glyph: face.left, size: size, at: left, ink: ink, glyphs: glyphs)
        BlobFieldView.drawEye(cg, glyph: face.right, size: size, at: right, ink: ink, glyphs: glyphs)

        // The phase colour: a hairline along the island's bottom edge (peeking, island),
        // a one-pixel glow that breathes along the lip (tucked). Peeking, the hairline
        // pulses with the sound as the island widens with it (`onFrame`).
        let breath = 0.5 + 0.5 * sin(2 * .pi * sim.time / BlobSim.breathPeriod)
        let hairAlpha: Double
        if lipFace {
            hairAlpha = 0.18 + 0.22 * (sim.reducedMotion ? 0.5 : breath)
        } else if mode == .peek, open < 0.5 {
            hairAlpha = 0.55 + 0.4 * (sim.reducedMotion ? 0.5 : sim.islandLevel)
        } else {
            hairAlpha = 0.9
        }
        let inset = NotchGeometry.radius
        cg.setStrokeColor(color.cgColor(alpha: hairAlpha))
        cg.setLineWidth(1)
        cg.move(to: CGPoint(x: island.minX + inset, y: island.maxY - 0.5))
        cg.addLine(to: CGPoint(x: island.maxX - inset, y: island.maxY - 0.5))
        cg.strokePath()

        // The island's words and buttons, fading in with the spring.
        if open > 0.05 {
            cg.saveGState()
            cg.setAlpha(open)
            drawIslandContent(cg, island: island, faceRight: faceCentreX + gap / 2 + CGFloat(size) * 0.6, color: color)
            cg.restoreGState()
        }
        cg.restoreGState()

        // The gate's pill under the island while it asks (the lock), or says no.
        if let pill = gatePill, !awake {
            drawGatePill(cg, pill, below: island)
        }
    }

    /// Phase word and the last transcript line centre, Pause / Stop / Mute right.
    private func drawIslandContent(_ cg: CGContext, island: NSRect, faceRight: CGFloat, color: RGB) {
        NSGraphicsContext.saveGraphicsState()
        let ctx = NSGraphicsContext(cgContext: cg, flipped: true)
        NSGraphicsContext.current = ctx
        let buttons = buttonRects(in: island)
        let textLeft = faceRight + 6
        let textRight = (buttons.first?.1.minX ?? island.maxX - 12) - 12
        let width = max(20, textRight - textLeft)
        let white = NSColor.white
        let phaseAttrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 12, weight: .medium), .foregroundColor: white]
        let phaseWord = OrbStyle.label(sim.phase)
        let style = NSMutableParagraphStyle()
        style.lineBreakMode = .byTruncatingTail
        var lineAttrs: [NSAttributedString.Key: Any] = [.font: NSFont.monospacedSystemFont(ofSize: 11, weight: .regular), .foregroundColor: white.withAlphaComponent(0.72), .paragraphStyle: style]
        let line = lastLine
        if line.isEmpty { lineAttrs[.foregroundColor] = white.withAlphaComponent(0.42) }
        let dot = NSBezierPath(ovalIn: NSRect(x: textLeft, y: island.minY + 30, width: 6, height: 6))
        NSColor(srgbRed: color.r, green: color.g, blue: color.b, alpha: 1).setFill()
        dot.fill()
        (phaseWord as NSString).draw(in: NSRect(x: textLeft + 12, y: island.minY + 24, width: width - 12, height: 18), withAttributes: phaseAttrs)
        ((line.isEmpty ? "—" : line) as NSString).draw(in: NSRect(x: textLeft, y: island.minY + 48, width: width, height: 16), withAttributes: lineAttrs)

        // Buttons: 26×24 hairline boxes, a solid symbol each; hover one alpha step;
        // the pressed one filled with the accent.
        for (which, rect) in buttons {
            let box = NSBezierPath(roundedRect: rect, xRadius: 6, yRadius: 6)
            let hot = hoveredButton == which
            let down = pressing == which
            if down {
                NSColor(srgbRed: 0x5b / 255, green: 0x82 / 255, blue: 0xff / 255, alpha: 1).setFill(); box.fill()
            } else if hot {
                NSColor(white: 1, alpha: 0.10).setFill(); box.fill()
            }
            NSColor(white: 1, alpha: 0.22).setStroke()
            box.lineWidth = 1
            box.stroke()
            let name: String
            switch which {
            case .pause: name = sim.phase == .paused ? "play.fill" : "pause.fill"
            case .stop: name = "stop.fill"
            case .mute: name = sim.phase == .muted ? "mic.slash.fill" : "mic.fill"
            case .face: name = ""
            }
            if let img = NSImage(systemSymbolName: name, accessibilityDescription: nil)?
                .withSymbolConfiguration(.init(pointSize: 11, weight: .semibold)) {
                let tinted = img.tinted(down || hot ? .white : NSColor(white: 1, alpha: 0.78))
                let s = tinted.size
                tinted.draw(in: NSRect(x: rect.midX - s.width / 2, y: rect.midY - s.height / 2, width: s.width, height: s.height),
                            from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
            }
        }
        NSGraphicsContext.restoreGraphicsState()
    }

    /// The last transcript line, set by the controller (mono, one line).
    var lastLine = "" { didSet { if lastLine != oldValue { needsDisplay = true } } }

    /// The three micro-buttons, right-aligned in the island: Pause, Stop, Mute.
    private func buttonRects(in island: NSRect) -> [(Press, NSRect)] {
        let w: CGFloat = 26, h: CGFloat = 24, gap: CGFloat = 6
        let y = island.midY - h / 2
        var x = island.maxX - 14 - w
        var out: [(Press, NSRect)] = []
        for which in [Press.mute, .stop, .pause] {
            out.append((which, NSRect(x: x, y: y, width: w, height: h)))
            x -= w + gap
        }
        return out.reversed()
    }

    /// The gate's pill: ground, hairline, a solid symbol or a tone dot, the words.
    private func drawGatePill(_ cg: CGContext, _ pill: OrbPill, below island: NSRect) {
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: cg, flipped: true)
        var text = pill.text
        if let until = pill.until { text += " · \(max(1, Int(until.timeIntervalSinceNow.rounded()))) s" }
        let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular), .foregroundColor: NSColor(white: 1, alpha: 0.72)]
        let tw = (text as NSString).size(withAttributes: attrs).width
        let iconW: CGFloat = pill.icon != nil ? 15 : (pill.tone != .info ? 10 : 0)
        let w = tw + iconW + 16, h: CGFloat = 20
        let rect = NSRect(x: island.midX - w / 2, y: island.maxY + 6, width: w, height: h)
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
        (text as NSString).draw(at: NSPoint(x: x, y: rect.minY + 3), withAttributes: attrs)
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

    private func button(at p: NSPoint) -> Press? {
        guard mode == .island, openSpring.value > 0.8 else { return nil }
        return buttonRects(in: islandRect).first { $0.1.insetBy(dx: -2, dy: -2).contains(p) }?.0
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
            onPress?(b)
        } else if islandRect.contains(p) || notchRect.contains(p) {
            onPress?(.face)
        }
    }
}

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
