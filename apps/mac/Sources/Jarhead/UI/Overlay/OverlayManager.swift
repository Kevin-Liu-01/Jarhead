import AppKit
import Combine
import SwiftUI

/// The annotation layer: one click-through window per screen, driven by
/// `state.overlayCommands` (the shapes) and `state.liveStrokes` (lines still being
/// drawn — Kevin's in mark mode, the blob's on a trace — updated in place as they
/// grow, kept their ttl once sealed). Nothing here ever intercepts a click — except
/// for the one stroke of mark mode (`beginMarkMode`, see MarkMode.swift), after which
/// every window is click-through again.
@MainActor
public final class OverlayManager {
    public let state: AppState

    private(set) var windows: [OverlayWindow] = []
    private var subscription: AnyCancellable?
    private var strokeSubscription: AnyCancellable?
    /// Live while Kevin is circling something; nil otherwise.
    private(set) var markMode: MarkModeController?

    public init(state: AppState) { self.state = state }

    public func start() {
        rebuildWindows()
        subscription = state.overlayCommands
            .receive(on: DispatchQueue.main)
            .sink { [weak self] cmd in self?.handle(cmd) }
        strokeSubscription = state.liveStrokes
            .receive(on: DispatchQueue.main)
            .sink { [weak self] stroke in self?.handle(stroke: stroke) }
        #if JARHEAD_ORB_PREVIEW
        OverlayPreviewDemo.install(on: self)
        #endif
    }

    /// Mark mode: the overlay becomes interactive for one stroke — Kevin circles a
    /// region — then sends `mark.add` and returns to click-through. Pressing the
    /// hotkey again while it is on cancels it.
    public func beginMarkMode() {
        if let markMode {
            markMode.cancel(reason: "toggled")
            return
        }
        if windows.isEmpty { rebuildWindows() }
        guard !windows.isEmpty else { return }
        let ctl = MarkModeController(manager: self, windows: windows)
        markMode = ctl
        // The dock folds before the overlay takes the mouse; the controller's end — a stroke,
        // Escape, a click that did not move, the timeout — is the one place it unfolds.
        ctl.onEnd = { [weak self] in self?.state.marking = false }
        state.marking = true
        ctl.begin()
    }

    /// Whether the overlay is currently interactive (mark mode).
    public var isMarking: Bool { markMode != nil }

    public func stop() {
        markMode?.cancel(reason: "stopped")
        subscription?.cancel()
        subscription = nil
        strokeSubscription?.cancel()
        strokeSubscription = nil
        for w in windows { w.orderOut(nil); w.close() }
        windows.removeAll()
    }

    /// Called on NSApplication.didChangeScreenParametersNotification.
    public func screensChanged() {
        guard subscription != nil else { return }
        markMode?.cancel(reason: "screens changed")
        rebuildWindows()
    }

    // MARK: - Windows

    private func rebuildWindows() {
        for w in windows { w.orderOut(nil); w.close() }
        windows = NSScreen.screens.map { screen in
            let w = OverlayWindow(screen: screen)
            w.orderFrontRegardless()
            return w
        }
    }

    // MARK: - Dispatch

    /// Every cue goes through `spread`: it lands on each display its (padded) bounds
    /// touch, in that window's local coordinates, so a shape that spans two displays
    /// is drawn on both — and its label on exactly one of them.
    private func handle(_ cmd: OverlayCommand) {
        switch cmd {
        case .clear:
            // Shapes and lines alike: the brain's show_clear, and what a Stop sends
            // in-process. (The orb only takes a line it is drawing down on this; its
            // Stop reaction rides the in-process Stop notification instead.)
            windows.forEach { $0.model.clear() }
        case .point(let x, let y, let label, let ttlMs):
            let p = CGPoint(x: x, y: y)
            // The arrow comes in from the upper-left (≤ 60pt away) with its pill above.
            spread(CGRect(origin: p, size: .zero).insetBy(dx: -100, dy: -100), ttl: seconds(ttlMs, default: 4)) { w in .point(w.local(p), label: label) }
        case .clickPulse(let x, let y):
            let p = CGPoint(x: x, y: y)
            spread(CGRect(origin: p, size: .zero).insetBy(dx: -40, dy: -40), ttl: 0.65) { w in .clickPulse(w.local(p)) }
        case .highlight(let rect, let label, let ttlMs):
            let r = CGRect(x: rect.x, y: rect.y, width: rect.w, height: rect.h).standardized
            spread(r.insetBy(dx: -8, dy: -8), ttl: seconds(ttlMs, default: 4)) { w in .highlight(w.local(r), label: label) }
        case .path(let from, let to, let ttlMs):
            let a = CGPoint(x: from.x, y: from.y), b = CGPoint(x: to.x, y: to.y)
            spread(OverlayGeometry.bounds([a, b]).insetBy(dx: -12, dy: -12), ttl: seconds(ttlMs, default: 4)) { w in .path(from: w.local(a), to: w.local(b)) }

        // Teaching shapes.
        case .circle(let x, let y, let radius, let label, let ttlMs, let tone):
            let c = CGPoint(x: x, y: y)
            let r = CGFloat(max(4, radius))
            let bbox = CGRect(x: c.x - r, y: c.y - r, width: r * 2, height: r * 2).insetBy(dx: -shapePad, dy: -shapePad)
            spread(bbox, ttl: seconds(ttlMs, default: shapeTTL)) { w in .circle(center: w.local(c), radius: r, label: label, tone: tone) }
        case .arrow(let from, let to, let label, let ttlMs, let tone):
            let a = CGPoint(x: from.x, y: from.y), b = CGPoint(x: to.x, y: to.y)
            let bbox = OverlayGeometry.bounds([a, b]).insetBy(dx: -shapePad, dy: -shapePad)
            spread(bbox, ttl: seconds(ttlMs, default: shapeTTL)) { w in .arrow(from: w.local(a), to: w.local(b), label: label, tone: tone) }
        case .rect(let rect, let label, let ttlMs, let tone):
            let r = CGRect(x: rect.x, y: rect.y, width: rect.w, height: rect.h).standardized
            spread(r.insetBy(dx: -shapePad, dy: -shapePad), ttl: seconds(ttlMs, default: shapeTTL)) { w in .rect(w.local(r), label: label, tone: tone) }
        case .text(let x, let y, let text, let ttlMs, let tone):
            guard !text.isEmpty else { return }
            let p = CGPoint(x: x, y: y)
            // The pill's size is only known at draw time; this covers the widest one.
            let bbox = CGRect(x: p.x - 8, y: p.y - 8, width: 400, height: 48)
            spread(bbox, ttl: seconds(ttlMs, default: shapeTTL)) { w in .text(w.local(p), text, tone: tone) }
        case .stroke(let points, let label, let ttlMs, let tone):
            let pts = points.map { CGPoint(x: $0.x, y: $0.y) }
            guard !pts.isEmpty else { return }
            let bbox = OverlayGeometry.bounds(pts).insetBy(dx: -shapePad, dy: -shapePad)
            spread(bbox, ttl: seconds(ttlMs, default: shapeTTL)) { w in .stroke(pts.map { w.local($0) }, label: label, tone: tone) }

        case .orbFly, .orbHome, .orbTrace:
            // The orb answers these itself (UI/Orb subscribes to the same commands).
            break
        }
    }

    /// Teaching shapes live 6 s unless told otherwise.
    private let shapeTTL: TimeInterval = 6
    /// Room for the glow and a label around a shape when deciding which displays it touches.
    private let shapePad: CGFloat = 56

    private func seconds(_ ms: Double?, default d: Double) -> TimeInterval {
        guard let ms, ms > 0 else { return d }
        return ms / 1000
    }

    /// Add one annotation to every window whose display the bounds (global CG points)
    /// touch. Its label is drawn by exactly one of them: the display that holds the
    /// label's anchor, else the one under the shape's centre, else the first — never
    /// clamped into view on a display the shape is not on (the seam between Kevin's
    /// two displays used to grow phantom pills). Bounds that touch no display draw
    /// nothing: a label with no shape under it would only mislead.
    private func spread(_ bbox: CGRect, ttl: TimeInterval, drawOn: Bool = true, _ make: (OverlayWindow) -> AnnotationKind) {
        let placed = windows.filter { $0.cgFrame.intersects(bbox) }.map { ($0, make($0)) }
        guard !placed.isEmpty else { return }
        let owner = placed.first { w, kind in
            guard let label = OverlayPainter.label(for: kind) else { return false }
            return w.cgFrame.contains(w.global(label.point))
        }?.0 ?? placed.first { $0.0.cgFrame.contains(CGPoint(x: bbox.midX, y: bbox.midY)) }?.0 ?? placed[0].0
        for (w, kind) in placed {
            w.model.add(kind, ttl: ttl, drawOn: drawOn, showsLabel: w === owner)
        }
    }

    // MARK: - Live strokes

    /// One update of a line being drawn (global CG points): every display its padded
    /// bounds touch — and every display that already holds it, since a line only
    /// grows — gets the whole line in its own coordinates, updated in place by id.
    /// Its label is drawn by the display holding the label's anchor (the pen while
    /// drawing, the box's top-left when done), else the one under the line's centre.
    /// A sealed stroke with no life left (`done`, ttl ≤ 0), or an empty one, is
    /// removed: that is how a cancelled trace or mark comes down.
    private func handle(stroke s: LiveStroke) {
        let pts = s.points.map { CGPoint(x: $0.x, y: $0.y) }
        if pts.isEmpty || (s.done && s.ttlMs <= 0) {
            windows.forEach { $0.model.removeStroke(id: s.id) }
            return
        }
        let box = OverlayGeometry.bounds(pts).insetBy(dx: -shapePad, dy: -shapePad)
        let ttl: TimeInterval = s.done ? max(0.2, s.ttlMs / 1000) : 0
        let label = (s.label?.isEmpty == false) ? s.label : nil
        let touching = windows.filter { $0.cgFrame.intersects(box) || $0.model.hasStroke(s.id) }
        guard !touching.isEmpty else { return }
        let anchor = label.map { OverlayPainter.liveStrokeLabel(points: pts, done: s.done, text: $0).point }
        let owner = anchor.flatMap { a in touching.first { $0.cgFrame.contains(a) } }
            ?? touching.first { $0.cgFrame.contains(CGPoint(x: box.midX, y: box.midY)) } ?? touching[0]
        for w in touching {
            w.model.upsertStroke(id: s.id, points: pts.map { w.local($0) }, tone: s.tone, label: label, done: s.done, ttl: ttl, showsLabel: w === owner)
        }
    }

    // MARK: - Mark mode → engine

    /// Kevin finished a stroke (global CG points): tell the engine the padded bounds
    /// and the stroke (≤ 200 points). The stroke itself stays on screen through the
    /// live-stroke channel (mark mode seals it with `echoSeconds` of life).
    func commitMark(points: [CGPoint]) {
        guard !points.isEmpty else { return }
        let box = OverlayGeometry.bounds(points).insetBy(dx: -MarkModeController.padding, dy: -MarkModeController.padding)
        let path = OverlayGeometry.simplify(points, maxPoints: MarkModeController.maxPoints)
        func r(_ v: CGFloat) -> Double { (v * 2).rounded() / 2 }
        state.send(.markAdd(rect: Rect(x: r(box.minX), y: r(box.minY), w: r(box.width), h: r(box.height)),
                            path: path.map { Point2(x: r($0.x), y: r($0.y)) }))
        // The mark is on the socket: an Ask that waited for it sends its question now, in order.
        state.markCommitted.send(())
    }

    func markModeDidEnd(_ ctl: MarkModeController) {
        if markMode === ctl { markMode = nil }
    }
}

/// A borderless panel covering one screen: fully click-through, except while mark
/// mode has made it `interactive` for one stroke. Non-activating, like the orb's
/// panel: it can take key status (for mark mode's Escape) and clicks without
/// activating Jarhead, so the Console never comes forward over what Kevin is
/// circling and the frontmost app stays frontmost.
final class OverlayWindow: NSPanel {
    let model = OverlayModel()

    /// This screen's frame in global CoreGraphics coordinates (origin top-left of the
    /// main display, y down).
    let cgFrame: CGRect
    /// The menu bar's height on this display (0 where there is none), for the hint pill.
    let topInset: CGFloat

    private let host: OverlayHostingView

    /// Mark mode: accept mouse events, show the crosshair, and be allowed key status
    /// (for the one Escape).
    var interactive = false {
        didSet {
            ignoresMouseEvents = !interactive
            host.crosshair = interactive
        }
    }
    /// Mouse events while interactive go here instead of the view tree.
    var markEvents: ((NSEvent, OverlayWindow) -> Void)?

    init(screen: NSScreen) {
        let f = screen.frame
        let mainMaxY = NSScreen.screens.first?.frame.maxY ?? f.maxY
        cgFrame = CGRect(x: f.minX, y: mainMaxY - f.maxY, width: f.width, height: f.height)
        topInset = max(0, f.maxY - screen.visibleFrame.maxY)
        host = OverlayHostingView(rootView: OverlayCanvasView(model: model, topInset: topInset))

        super.init(contentRect: f, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        ignoresMouseEvents = true
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        isReleasedWhenClosed = false
        hidesOnDeactivate = false
        isFloatingPanel = false
        becomesKeyOnlyIfNeeded = false
        animationBehavior = .none
        isExcludedFromWindowsMenu = true
        title = "Jarhead Overlay"
        // Last: NSPanel's `isFloatingPanel` setter rewrites the level (false → normal),
        // and a layer at the normal level sits behind whatever app is frontmost — the
        // lines and shapes were being drawn under Kevin's windows.
        level = .screenSaver

        host.frame = NSRect(origin: .zero, size: f.size)
        host.autoresizingMask = [.width, .height]
        contentView = host
        setFrame(f, display: false)
    }

    override var canBecomeKey: Bool { interactive }
    override var canBecomeMain: Bool { false }

    override func sendEvent(_ event: NSEvent) {
        guard interactive else { return super.sendEvent(event) }
        switch event.type {
        case .leftMouseDown, .leftMouseDragged, .leftMouseUp:
            markEvents?(event, self)
        case .keyDown, .keyUp:
            // Escape is taken by mark mode's local monitor before this; nothing else
            // means anything here, and letting it through would only beep.
            break
        default:
            super.sendEvent(event)
        }
    }

    /// Global CG point → local content coordinates (origin top-left, y down).
    func local(_ p: CGPoint) -> CGPoint {
        CGPoint(x: p.x - cgFrame.minX, y: p.y - cgFrame.minY)
    }

    func local(_ r: CGRect) -> CGRect {
        CGRect(origin: local(r.origin), size: r.size)
    }

    /// Local content point → global CG point.
    func global(_ p: CGPoint) -> CGPoint {
        CGPoint(x: p.x + cgFrame.minX, y: p.y + cgFrame.minY)
    }

    /// An event's `locationInWindow` (AppKit, y up from the window's bottom) → local content point.
    func local(windowPoint p: NSPoint) -> CGPoint {
        CGPoint(x: p.x, y: frame.height - p.y)
    }

    /// Local content point → `locationInWindow` for a synthesised event.
    func windowPoint(_ local: CGPoint) -> NSPoint {
        NSPoint(x: local.x, y: frame.height - local.y)
    }
}

/// The canvas host, with a cursor rect for mark mode: the window server shows the
/// cursor of the window under the mouse whether or not its app is active, so this is
/// what makes the crosshair reliable while Jarhead stays in the background.
final class OverlayHostingView: NSHostingView<OverlayCanvasView> {
    var crosshair = false {
        didSet {
            guard crosshair != oldValue else { return }
            window?.invalidateCursorRects(for: self)
        }
    }

    required init(rootView: OverlayCanvasView) {
        super.init(rootView: rootView)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("OverlayHostingView is not archived") }

    override func resetCursorRects() {
        super.resetCursorRects()
        if crosshair { addCursorRect(bounds, cursor: .crosshair) }
    }
}
