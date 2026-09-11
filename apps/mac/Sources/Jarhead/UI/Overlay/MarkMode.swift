import AppKit

/// One stroke of Kevin's: ⌥⇧C (or the orb menu) makes every overlay window
/// interactive — crosshair, a faint accent wash and frame, a hint pill on the display
/// under the cursor — and the first mouse-down starts a stroke drawn live in the mark
/// tone on every display it crosses. Mouse-up ends it: the padded bounds and the
/// stroke (≤ 200 points) go to the engine as `mark.add`, the stroke stays on screen
/// 8 s, and the windows are click-through again. Escape, a click that did not move,
/// or 20 s of nothing cancels.
///
/// Focus: the overlay is a non-activating panel, so the window under the cursor takes
/// key status — for the one Escape, heard by a local monitor — without activating
/// Jarhead: nothing else of ours (the Console) comes forward over what Kevin is
/// circling, and the app he was in stays frontmost. Only when the window server
/// refuses key to an inactive process do we activate, and then only if no Console
/// window is up to be dragged along; a global monitor hears Escape in the remaining
/// case (it cannot swallow it, so the frontmost app sees that one Escape too).
@MainActor
final class MarkModeController {
    static let timeoutSeconds: TimeInterval = 20
    static let echoSeconds: TimeInterval = 8
    static let maxPoints = 200
    static let padding: CGFloat = 8
    /// A stroke whose bounds are smaller than this in both directions is a click, not a mark.
    static let minTravel: CGFloat = 6

    private weak var manager: OverlayManager?
    private let windows: [OverlayWindow]
    private var origin: OverlayWindow?
    /// The stroke so far, global CG points.
    private var points: [CGPoint] = []
    private var keyMonitor: Any?
    private var globalKeyMonitor: Any?
    private var timeout: Timer?
    private var poll: Timer?
    private var previousApp: NSRunningApplication?
    private var cursorPushed = false
    private(set) var active = false
    /// How it ended, for the preview harness and logs.
    private(set) var outcome: String?
    /// How key status was obtained, for the preview harness and logs.
    private(set) var focus = "none"

    init(manager: OverlayManager, windows: [OverlayWindow]) {
        self.manager = manager
        self.windows = windows
    }

    func begin() {
        guard !active else { return }
        active = true
        let me = ProcessInfo.processInfo.processIdentifier
        if let front = NSWorkspace.shared.frontmostApplication, front.processIdentifier != me { previousApp = front }

        for w in windows {
            w.markEvents = { [weak self] event, window in self?.handle(event, in: window) }
            w.interactive = true
            w.model.liveStroke = []
            w.model.markMode = true
            w.orderFrontRegardless()
        }
        NSCursor.crosshair.push()
        cursorPushed = true

        takeKey()
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, self.active else { return event }
            if event.keyCode == 53 { // Escape
                self.cancel(reason: "escape")
                return nil
            }
            return event
        }
        // When the overlay could not take key, Escape lands in the frontmost app; hear
        // it anyway. Needs the Accessibility grant the hands already have; harmless
        // without it.
        globalKeyMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard event.keyCode == 53 else { return }
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.cancel(reason: "escape") } }
        }

        updateHint()
        poll = Timer.scheduledTimer(withTimeInterval: 1 / 30, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
        timeout = Timer.scheduledTimer(withTimeInterval: Self.timeoutSeconds, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.cancel(reason: "timeout") }
        }
    }

    /// Key for the one Escape, on the window under the cursor. Mouse events do not
    /// need this — an interactive window gets them regardless — only the key does.
    private func takeKey() {
        guard let target = windowUnderCursor() ?? windows.first else { return }
        target.makeKey()
        if target.isKeyWindow { focus = "key (non-activating)"; return }
        // The window server would not hand key to a panel of a process a real click
        // has not touched. Activating would bring our main window — the Console — over
        // the app Kevin is circling, so only do it when nothing of ours is showing.
        let consoleUp = NSApp.windows.contains { $0.isVisible && $0.canBecomeMain && !($0 is OverlayWindow) }
        guard !NSApp.isActive, !consoleUp else { focus = consoleUp ? "global monitor (Console up)" : "global monitor"; return }
        NSApp.activate()
        if !NSApp.isActive { NSApp.activate(ignoringOtherApps: true) }
        target.makeKey()
        focus = target.isKeyWindow ? "key (activated)" : "global monitor (activation refused)"
    }

    /// Stop without sending anything.
    func cancel(reason: String) {
        guard active else { return }
        end(outcome: "cancelled (\(reason))")
    }

    // MARK: - Events

    private func handle(_ event: NSEvent, in w: OverlayWindow) {
        guard active else { return }
        let local = w.local(windowPoint: event.locationInWindow)
        let global = w.global(local)
        switch event.type {
        case .leftMouseDown:
            origin = w
            points = [global]
            // Every display gets the stroke: AppKit keeps delivering the drag to the
            // window it started in, so a loop that crosses the seam onto the other
            // display would otherwise vanish there until mouse-up.
            for win in windows { win.model.liveStroke = [win.local(global)] }
            if !w.isKeyWindow { w.makeKey() }
        case .leftMouseDragged:
            guard let origin, origin === w else { return }
            points.append(global)
            for win in windows { win.model.liveStroke.append(win.local(global)) }
        case .leftMouseUp:
            guard let origin, origin === w else { return }
            points.append(global)
            finish()
        default:
            break
        }
    }

    private func finish() {
        let box = OverlayGeometry.bounds(points)
        guard points.count >= 2, max(box.width, box.height) >= Self.minTravel else {
            end(outcome: "cancelled (click without movement)")
            return
        }
        let stroke = points
        end(outcome: "marked \(Int(box.width.rounded()))×\(Int(box.height.rounded())) with \(stroke.count) points")
        manager?.commitMark(points: stroke)
    }

    private func end(outcome: String) {
        guard active else { return }
        active = false
        self.outcome = outcome
        timeout?.invalidate(); timeout = nil
        poll?.invalidate(); poll = nil
        if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
        keyMonitor = nil
        if let globalKeyMonitor { NSEvent.removeMonitor(globalKeyMonitor) }
        globalKeyMonitor = nil
        if cursorPushed { NSCursor.pop(); cursorPushed = false }
        for w in windows {
            w.markEvents = nil
            let wasKey = w.isKeyWindow
            w.interactive = false
            w.model.markHint = false
            w.model.markMode = false
            w.model.liveStroke = []
            // Drop key status the way the orb does: re-order with canBecomeKey now false.
            if wasKey { w.orderOut(nil) }
            w.orderFrontRegardless()
        }
        // Hand focus back to whoever had it, if taking key had to activate us.
        if NSApp.isActive, let prev = previousApp, !prev.isTerminated {
            prev.activate(from: .current, options: [])
        }
        previousApp = nil
        origin = nil
        manager?.markModeDidEnd(self)
    }

    // MARK: - Cursor + hint

    private func tick() {
        guard active else { return }
        // The cursor rect on the overlay does this on mouse moves; this covers the
        // moment mark mode begins and any app that fights for the cursor meanwhile.
        if NSCursor.current !== NSCursor.crosshair { NSCursor.crosshair.set() }
        updateHint()
    }

    /// The hint pill lives on the display under the cursor (or the stroke's display while drawing).
    private func updateHint() {
        let target = origin ?? windowUnderCursor() ?? windows.first
        for w in windows {
            let on = w === target
            if w.model.markHint != on { w.model.markHint = on }
        }
    }

    private func windowUnderCursor() -> OverlayWindow? {
        let m = NSEvent.mouseLocation
        let mainMaxY = NSScreen.screens.first?.frame.maxY ?? 0
        let cg = CGPoint(x: m.x, y: mainMaxY - m.y)
        return windows.first { $0.cgFrame.contains(cg) }
    }
}
