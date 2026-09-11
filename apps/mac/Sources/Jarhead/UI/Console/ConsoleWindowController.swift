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
    /// The conversation on screen, for the preview harness's scripted actions.
    var openAgentIdForPreview: String? { session.openAgentId }

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

        let root = ConsoleRootView()
            .environmentObject(state)
            .environmentObject(session)
            .environment(\.consoleActions, actions)
        let hosting = NSHostingView(rootView: root)
        hosting.autoresizingMask = [.width, .height]
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
            // phase: the command, then the feedback nothing waits on — the in-process
            // Stop notification (the orb cancels its flight or trace and shivers; the
            // name is OrbPanelController.stopPressedNotification, spelled out because
            // the Console preview compiles without UI/Orb), the overlay's clear (the
            // shapes come down), a "Stopped" toast (the Console's pill, and the orb's),
            // and the composer's Stop flashing red for the press.
            state.send(.stop)
            NotificationCenter.default.post(name: Notification.Name("jarhead.stopPressed"), object: nil)
            state.overlayCommands.send(.clear)
            state.toast("Stopped")
            session.stopFlash += 1
            return true
        case .focusComposer:
            session.composerFocusRequest += 1
            return true
        case .togglePause:
            // ⌘P, in every phase: the engine answers with the phase (paused, or back).
            state.send(state.phase == .paused ? .resume : .pause)
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
/// (⌥⇧P, the global Pause hotkey, is Carbon's and never reaches the window.)
final class ConsoleWindow: NSWindow {
    var commandHandler: ((ConsoleKeyCommand) -> Bool)?

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if flags == .command, let chars = event.charactersIgnoringModifiers {
            switch chars {
            case "w": if commandHandler?(.close) == true { return true }
            case ".": if commandHandler?(.stop) == true { return true }
            case "k": if commandHandler?(.focusComposer) == true { return true }
            case "p": if commandHandler?(.togglePause) == true { return true }
            default: break
            }
        }
        return super.performKeyEquivalent(with: event)
    }
}
