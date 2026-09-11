import AppKit
import Combine
import SwiftUI

/// The annotation layer: one click-through window per screen, driven by
/// `state.overlayCommands`. Nothing here ever intercepts a click.
@MainActor
public final class OverlayManager {
    public let state: AppState

    private var windows: [OverlayWindow] = []
    private var subscription: AnyCancellable?

    public init(state: AppState) { self.state = state }

    public func start() {
        rebuildWindows()
        subscription = state.overlayCommands
            .receive(on: DispatchQueue.main)
            .sink { [weak self] cmd in self?.handle(cmd) }
    }

    public func stop() {
        subscription?.cancel()
        subscription = nil
        for w in windows { w.orderOut(nil); w.close() }
        windows.removeAll()
    }

    /// Called on NSApplication.didChangeScreenParametersNotification.
    public func screensChanged() {
        guard subscription != nil else { return }
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

    private func handle(_ cmd: OverlayCommand) {
        switch cmd {
        case .clear:
            windows.forEach { $0.model.clear() }
        case .point(let x, let y, let label, let ttlMs):
            let p = CGPoint(x: x, y: y)
            for w in targets(containing: p) {
                w.model.add(.point(w.local(p), label: label), ttl: seconds(ttlMs, default: 4))
            }
        case .clickPulse(let x, let y):
            let p = CGPoint(x: x, y: y)
            for w in targets(containing: p) {
                w.model.add(.clickPulse(w.local(p)), ttl: 0.65)
            }
        case .highlight(let rect, let label, let ttlMs):
            let r = CGRect(x: rect.x, y: rect.y, width: rect.w, height: rect.h)
            for w in windows where w.cgFrame.intersects(r) {
                w.model.add(.highlight(w.local(r), label: label), ttl: seconds(ttlMs, default: 4))
            }
        case .path(let from, let to, let ttlMs):
            let a = CGPoint(x: from.x, y: from.y), b = CGPoint(x: to.x, y: to.y)
            let bbox = CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(b.x - a.x), height: abs(b.y - a.y)).insetBy(dx: -1, dy: -1)
            for w in windows where w.cgFrame.intersects(bbox) {
                w.model.add(.path(from: w.local(a), to: w.local(b)), ttl: seconds(ttlMs, default: 4))
            }
        }
    }

    private func seconds(_ ms: Double?, default d: Double) -> TimeInterval {
        guard let ms, ms > 0 else { return d }
        return ms / 1000
    }

    /// The window whose display contains the point; falls back to the main display so a
    /// slightly off-screen coordinate still shows *something* rather than nothing.
    private func targets(containing p: CGPoint) -> [OverlayWindow] {
        let hits = windows.filter { $0.cgFrame.contains(p) }
        if !hits.isEmpty { return hits }
        return windows.first.map { [$0] } ?? []
    }
}

/// A borderless, fully click-through window covering one screen.
final class OverlayWindow: NSWindow {
    let model = OverlayModel()

    /// This screen's frame in global CoreGraphics coordinates (origin top-left of the
    /// main display, y down).
    let cgFrame: CGRect

    init(screen: NSScreen) {
        let f = screen.frame
        let mainMaxY = NSScreen.screens.first?.frame.maxY ?? f.maxY
        cgFrame = CGRect(x: f.minX, y: mainMaxY - f.maxY, width: f.width, height: f.height)

        super.init(contentRect: f, styleMask: [.borderless], backing: .buffered, defer: false)
        level = .screenSaver
        ignoresMouseEvents = true
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        isReleasedWhenClosed = false
        hidesOnDeactivate = false
        animationBehavior = .none
        isExcludedFromWindowsMenu = true
        title = "Jarhead Overlay"

        let host = NSHostingView(rootView: OverlayCanvasView(model: model))
        host.frame = NSRect(origin: .zero, size: f.size)
        host.autoresizingMask = [.width, .height]
        contentView = host
        setFrame(f, display: false)
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    /// Global CG point → local content coordinates (origin top-left, y down).
    func local(_ p: CGPoint) -> CGPoint {
        CGPoint(x: p.x - cgFrame.minX, y: p.y - cgFrame.minY)
    }

    func local(_ r: CGRect) -> CGRect {
        CGRect(origin: local(r.origin), size: r.size)
    }
}
