import AppKit

/// The signals the daemon cannot see on its own — it has no NSWorkspace — observed here on Kevin's behalf and
/// forwarded as `system.signal` frames (design11 § Contract `SystemSignal`): an app launched or quit, the Mac
/// slept or woke, the screen locked or unlocked, a display came or went, the clock jumped. Every one is
/// **data** for the daemon's watchers, never a command: nothing here wakes the engine, opens a session or
/// answers anything. No TCC prompt is behind any of these notifications.
@MainActor
final class SignalObserver {
    private let state: AppState
    private var observers: [NSObjectProtocol] = []
    private var distributed: [NSObjectProtocol] = []
    private var screens = NSScreen.screens.count
    /// The last lock / unlock forwarded and when: two sources report them (the workspace session and the
    /// screen's own distributed notices), and one flip is one signal.
    private var lastScreen: (kind: String, at: Date)?
    private var started = false

    init(state: AppState) {
        self.state = state
    }

    func start() {
        guard !started else { return }
        started = true
        let ws = NSWorkspace.shared.notificationCenter
        func on(_ name: Notification.Name, _ body: @escaping @MainActor (Notification) -> Void) {
            observers.append(ws.addObserver(forName: name, object: nil, queue: .main) { n in MainActor.assumeIsolated { body(n) } })
        }
        on(NSWorkspace.didLaunchApplicationNotification) { [weak self] n in self?.app("app.launch", n) }
        on(NSWorkspace.didTerminateApplicationNotification) { [weak self] n in self?.app("app.quit", n) }
        on(NSWorkspace.willSleepNotification) { [weak self] _ in self?.forward("mac.sleep") }
        on(NSWorkspace.didWakeNotification) { [weak self] _ in self?.forward("mac.wake") }
        on(NSWorkspace.sessionDidBecomeActiveNotification) { [weak self] _ in self?.screen("screen.unlock") }
        on(NSWorkspace.sessionDidResignActiveNotification) { [weak self] _ in self?.screen("screen.lock") }
        // The lock screen itself, on a single-user Mac, is announced on the distributed centre (no grant).
        let dc = DistributedNotificationCenter.default()
        distributed.append(dc.addObserver(forName: Notification.Name("com.apple.screenIsLocked"), object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.screen("screen.lock") }
        })
        distributed.append(dc.addObserver(forName: Notification.Name("com.apple.screenIsUnlocked"), object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.screen("screen.unlock") }
        })
        // Displays (the one observer the app already had for the overlay; a second reader of the same notice).
        observers.append(NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.displaysChanged() }
        })
        observers.append(NotificationCenter.default.addObserver(forName: .NSSystemClockDidChange, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.forward("clock.changed") }
        })
    }

    func stop() {
        for o in observers { NSWorkspace.shared.notificationCenter.removeObserver(o); NotificationCenter.default.removeObserver(o) }
        for o in distributed { DistributedNotificationCenter.default().removeObserver(o) }
        observers.removeAll()
        distributed.removeAll()
        started = false
    }

    // MARK: - the signals

    private func app(_ kind: String, _ n: Notification) {
        guard let running = n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
        // Our own comings and goings are nobody's watcher.
        if running.processIdentifier == ProcessInfo.processInfo.processIdentifier { return }
        let name = running.localizedName ?? running.bundleIdentifier ?? ""
        guard !name.isEmpty else { return }
        forward(kind, app: name, bundleId: running.bundleIdentifier)
    }

    /// One flip is one signal, whichever source announced it first.
    private func screen(_ kind: String) {
        let now = Date()
        if let last = lastScreen, last.kind == kind, now.timeIntervalSince(last.at) < 2 { return }
        lastScreen = (kind, now)
        forward(kind)
    }

    /// A display connected or disconnected: the count moved. A rearrangement (the same count) is no signal.
    private func displaysChanged() {
        let count = NSScreen.screens.count
        defer { screens = count }
        guard count != screens else { return }
        forward(count > screens ? "display.connected" : "display.disconnected")
    }

    private func forward(_ kind: String, app: String? = nil, bundleId: String? = nil) {
        var note = "signal → \(kind)"
        if let app { note += " \(app)" }
        CrashGuard.remember(note)
        state.systemSignal(SystemSignal(kind: kind, app: app, bundleId: bundleId))
    }
}
