import AppKit
import SwiftUI

/// Owns the Console window. Created once by AppDelegate; `show()` builds the
/// window lazily, `close()` hides it (the window and its view tree survive so
/// reopening is instant and scroll/tab state is kept).
@MainActor
public final class ConsoleWindowController: NSObject, NSWindowDelegate {
    public let state: AppState
    private let session = ConsoleSession()
    private var window: ConsoleWindow?

    public init(state: AppState) {
        self.state = state
        super.init()
    }

    public func show() {
        let window = self.window ?? makeWindow()
        self.window = window
        if !window.isVisible { window.center() }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    public func close() {
        window?.orderOut(nil)
    }

    public var isVisible: Bool { window?.isVisible ?? false }

    /// Window number for scripted screenshots (`screencapture -l`). nil until shown.
    var windowNumber: Int? { window.map(\.windowNumber) }

    /// Preview/test hooks (module-internal): drive the UI without a mouse.
    func selectTab(_ tab: ConsoleSession.Tab) { session.select(tab) }
    func pickLedgerDay(_ day: String) {
        session.select(.ledger)
        Task { await session.loadDays(from: state); await session.pick(day: day, from: state) }
    }
    func openAgent(_ id: String?) { session.openAgentId = id }
    /// Back to Now (no conversation, no ledger day), for the preview harness's scripted actions.
    func showNow() { session.showNow() }
    /// The conversation on screen, for the preview harness's scripted actions.
    var openAgentIdForPreview: String? { session.openAgentId }
    /// The Jarhead conversation on screen, for the preview harness's scripted actions.
    var openJarheadIdForPreview: String? { session.openJarheadSessionId }

    // MARK: - window

    private func makeWindow() -> ConsoleWindow {
        let window = ConsoleWindow(
            contentRect: NSRect(origin: .zero, size: ConsoleLayout.defaultSize),
            styleMask: [.titled, .closable, .resizable, .miniaturizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.title = "Jarhead"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = true
        // No forced appearance: the tokens are dynamic, so the window follows the system.
        window.backgroundColor = ConsoleTheme.groundNS
        // The columns' exact sum (ConsoleLayout), so no rail is ever clipped.
        let minSize = NSSize(width: ConsoleLayout.minWidth, height: ConsoleLayout.minHeight)
        window.minSize = minSize
        window.isReleasedWhenClosed = false
        window.tabbingMode = .disallowed
        window.setFrameAutosaveName("JarheadConsole")
        // A frame saved by an older build with a smaller minimum must not come back narrow.
        if window.frame.width < minSize.width || window.frame.height < minSize.height {
            var frame = window.frame
            frame.size.width = max(frame.width, minSize.width)
            frame.size.height = max(frame.height, minSize.height)
            window.setFrame(frame, display: false)
        }
        window.delegate = self
        window.commandHandler = { [weak self] command in self?.handle(command) ?? false }

        let session = self.session
        let actions = ConsoleActions(
            send: { [state] command in state.send(command) },
            stop: { [weak self] in _ = self?.handle(.stop) },
            screenshotURL: { [state] path in state.screenshotURL(path) },
            loadLedgerDays: { [state] in Task { await session.loadDays(from: state) } },
            pickLedgerDay: { [state] day in Task { await session.pick(day: day, from: state) } },
            openOnboarding: { [state] in state.openOnboarding() },
            setWakePassphrase: { [state] phrase in state.wakeActions.setPassphrase(phrase) },
            clearWakePassphrase: { [state] in state.wakeActions.clearPassphrase() },
            beginMarkMode: { [state] in state.beginMarkMode() },
            reveal: { url in NSWorkspace.shared.activateFileViewerSelecting([url]) })

        // The composer's Go/Pause: the one transport (AppState's Transport region).
        let transport = ConsoleTransport(toggle: { [state] in state.transportToggle() })

        let root = ConsoleRootView()
            .environmentObject(state)
            .environmentObject(session)
            .environment(\.consoleActions, actions)
            .environment(\.consoleTransport, transport)
        let hosting = NSHostingView(rootView: root)
        hosting.autoresizingMask = [.width, .height]
        // The window's minimum is `minSize` above (the columns' sum); the hosting view must not
        // also derive one. With the default options AppKit asks it for its min / intrinsic / max
        // size whenever its constraints are re-validated — a full SwiftUI layout pass of every
        // rail and row, 20–50 ms on a live Console, several times over a pane switch (traced:
        // `NSHostingView.minSize → ViewGraph.sizeThatFits` under `invalidateSizeConstraintsIfNecessary`).
        hosting.sizingOptions = []
        window.contentView = hosting
        return window
    }

    private func handle(_ command: ConsoleKeyCommand) -> Bool {
        switch command {
        case .close:
            close()
            return true
        case .stop:
            // Every Stop in the Console lands here (the composer's button, ⌘.), in every
            // phase: the transport's stop — the command, the in-process stop-pressed
            // notification the orb reacts to, the overlay's clear and the one "Stopped"
            // toast (AppState.transportStop) — plus the composer's Stop flashing red for
            // the press, which is the Console's own.
            state.transportStop()
            session.stopFlash += 1
            return true
        case .focusComposer:
            session.composerFocusRequest += 1
            return true
        case .transportToggle:
            // ⌘P, in every phase: go when asleep or paused, pause in session, stop while
            // connecting. The engine answers with the phase.
            state.transportToggle()
            return true
        }
    }

    // MARK: - NSWindowDelegate

    public func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false
    }
}

/// Handles ⌘W / ⌘. / ⌘K / ⌘P itself so the Console works whatever the main menu holds.
/// (⌥⇧Space and ⌥⇧P, the global Go/Pause hotkeys, are Carbon's and never reach the window.)
final class ConsoleWindow: NSWindow {
    var commandHandler: ((ConsoleKeyCommand) -> Bool)?

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if flags == .command, let chars = event.charactersIgnoringModifiers {
            switch chars {
            case "w": if commandHandler?(.close) == true { return true }
            case ".": if commandHandler?(.stop) == true { return true }
            case "k": if commandHandler?(.focusComposer) == true { return true }
            case "p": if commandHandler?(.transportToggle) == true { return true }
            default: break
            }
        }
        return super.performKeyEquivalent(with: event)
    }
}
