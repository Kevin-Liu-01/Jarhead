import AppKit
import SwiftUI

/// Owns the Console window. Created once by AppDelegate; `show()` builds the
/// window lazily, `close()` hides it (the window and its view tree survive so
/// reopening is instant and scroll/tab state is kept). Because the tree survives,
/// the session is told when the window is on screen (`windowVisible`): a hidden
/// Console must hold no agent tails, and only the panes can send the closes.
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
        setVisible(true)
    }

    public func close() {
        setVisible(false)
        window?.orderOut(nil)
    }

    public var isVisible: Bool { window?.isVisible ?? false }

    /// The daemon (re)connected (AppDelegate, on every hello): panes re-send their `agent.open`.
    func reconnected() { session.reconnected() }

    private func setVisible(_ on: Bool) {
        if session.windowVisible != on { session.windowVisible = on }
    }

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
    /// The thread on screen, for the preview harness's scripted actions.
    var openThreadIdForPreview: String? { session.openThreadId }

    /// Show the Console on a thread's pane — a satellite blob's click (AppDelegate installs
    /// `state.openThreadHandler = { [weak self] id in self?.console.openThread(id) }`), the CLI.
    public func openThread(_ id: String) {
        show()
        withAnimation(Motion.wipeAnimation) { session.openThread(id) }
    }

    /// ⌘⇧] / ⌘⇧[: the next / previous thread in the rail's order (AppState.railOrder, less main
    /// while Now is the stream — ConsoleRootView.walkOrder); Now at either end.
    func stepThread(by delta: Int) {
        withAnimation(Motion.wipeAnimation) { session.stepThread(by: delta, order: ConsoleRootView.walkOrder(state.orderedThreads.map(\.id))) }
    }

    /// ⌥⌘.: stop THIS thread — the open pane's, or "main" on Now (the engine parks the main
    /// turn; the spawned threads carry on; the session stays open). Never the transport's Stop;
    /// nothing while an agent or a past conversation holds the centre (no thread is "this" one).
    @discardableResult
    func stopOpenThread() -> Bool {
        guard let id = ConsoleWindowController.stopTarget(openThreadId: session.openThreadId, showsNow: session.showsNow) else { return false }
        state.threadStop(id)
        return true
    }

    /// Which thread ⌥⌘. stops, pure for the harness: the pane's; "main" on Now; nil elsewhere.
    static func stopTarget(openThreadId: String?, showsNow: Bool) -> String? {
        if let openThreadId { return openThreadId }
        return showsNow ? "main" : nil
    }

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
        // The autosaved frame can be under the minimum (a display change since it was saved): widen it, never clip a rail.
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
            send: { [state] command in ConsolePress.report?("press: \(ConsolePress.word(command))"); state.send(command) },
            stop: { [weak self] in ConsolePress.report?("press: stop"); _ = self?.handle(.stop) },
            screenshotURL: { [state] path in state.screenshotURL(path) },
            loadLedgerDays: { [state] in Task { await session.loadDays(from: state) } },
            pickLedgerDay: { [state] day in Task { await session.pick(day: day, from: state) } },
            openOnboarding: { [state] in state.openOnboarding() },
            setWakePassphrase: { [state] phrase in state.wakeActions.setPassphrase(phrase) },
            clearWakePassphrase: { [state] in state.wakeActions.clearPassphrase() },
            beginMarkMode: { [state] in state.beginMarkMode() },
            reveal: { url in NSWorkspace.shared.activateFileViewerSelecting([url]) })

        // The composer's Go/Pause: the one transport (AppState's Transport region).
        let transport = ConsoleTransport(toggle: { [state] in
            ConsolePress.report?("press: \(ConsolePress.word(AppState.transportPress(for: state.phase)))")
            state.transportToggle()
        })

        let root = ConsoleRootView()
            .environmentObject(state)
            .environmentObject(session)
            .environment(\.consoleActions, actions)
            .environment(\.consoleTransport, transport)
            // The title band the root is laid under: no float climbs into it (ConsoleFloatLayer, ConsoleMenuField.listMax).
            .environment(\.consoleTitleBand, Self.titleBand(of: window))
        let hosting = ConsoleHostingView(rootView: root)
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

    /// The title band of a `fullSizeContentView` window — the traffic lights' strip the root is laid under
    /// (≈ 28): the content rect less the content layout rect (which starts under the title bar).
    static func titleBand(of window: NSWindow) -> CGFloat {
        max(0, window.contentRect(forFrameRect: window.frame).height - window.contentLayoutRect.height)
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
        case .showNow:
            // ⌘0: whatever is open steps out; the live stream takes the centre.
            withAnimation(Motion.wipeAnimation) { session.showNow() }
            return true
        case .nextThread:
            stepThread(by: 1)
            return true
        case .prevThread:
            stepThread(by: -1)
            return true
        case .stopThread:
            return stopOpenThread()
        }
    }

    // MARK: - NSWindowDelegate

    /// The red button and ⌘W both hide (never close: the tree is kept) through `close()`,
    /// so the session hears it either way.
    public func windowShouldClose(_ sender: NSWindow) -> Bool {
        close()
        return false
    }

    /// Minimised is hidden too: a Console in the Dock for an afternoon should not keep
    /// every open conversation's tail running.
    public func windowDidMiniaturize(_ notification: Notification) { setVisible(false) }
    public func windowDidDeminiaturize(_ notification: Notification) { setVisible(true) }
}

/// Handles ⌘W / ⌘. / ⌘K / ⌘P / ⌘0, ⌘⇧] / ⌘⇧[ and ⌥⌘. itself so the Console works whatever the
/// main menu holds. (⌥⇧Space, the global Go/Pause hotkey, is Carbon's and never reaches
/// the window.) ⌘. is Stop everything; ⌥⌘. is Stop this thread — the same key with Option, so
/// the hand that knows one finds the other.
final class ConsoleWindow: NSWindow {
    var commandHandler: ((ConsoleKeyCommand) -> Bool)?

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if let command = ConsoleWindow.command(flags: flags, chars: event.charactersIgnoringModifiers) {
            if commandHandler?(command) == true { return true }
        }
        return super.performKeyEquivalent(with: event)
    }

    /// The key → command table, pure so the harness can pin it. `chars` is
    /// `charactersIgnoringModifiers`, which keeps Shift: ⌘⇧] arrives as "}" on a US keyboard
    /// and as "]" on one whose shifted bracket is elsewhere — both are the next thread.
    static func command(flags: NSEvent.ModifierFlags, chars: String?) -> ConsoleKeyCommand? {
        guard let chars else { return nil }
        if flags == .command {
            switch chars {
            case "w": return .close
            case ".": return .stop
            case "k": return .focusComposer
            case "p": return .transportToggle
            case "0": return .showNow
            default: return nil
            }
        }
        if flags == [.command, .shift] {
            switch chars {
            case "]", "}": return .nextThread
            case "[", "{": return .prevThread
            default: return nil
            }
        }
        if flags == [.command, .option], chars == "." { return .stopThread }
        return nil
    }
}

/// The Console's and Setup's root view. A click on an inactive window acts on the first click:
/// AppKit hands the mouse-down to the hit view only if it accepts first mouse, and a bare
/// `NSHostingView` leaves that to a default nothing pins — so it is said here, once.
final class ConsoleHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}
