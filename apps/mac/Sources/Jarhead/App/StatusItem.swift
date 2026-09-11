import AppKit
import Combine

/// What the menus can do. The AppDelegate fills these in; the status item, the Dock
/// menu and the main menu all share them.
struct AppActions {
    var toggleWake: () -> Void = {}
    var toggleMute: () -> Void = {}
    var stop: () -> Void = {}
    var openConsole: () -> Void = {}
    var summonOrb: () -> Void = {}
    var openLedgerFolder: () -> Void = {}
    var quit: () -> Void = {}
}

/// The menu-bar item: a template orb glyph drawn in code, a tooltip with the phase,
/// and a menu rebuilt whenever the snapshot changes.
@MainActor
final class StatusItem: NSObject {
    private let state: AppState
    private let actions: AppActions
    private let item: NSStatusItem
    private var cancellables = Set<AnyCancellable>()
    private var refreshScheduled = false

    init(state: AppState, actions: AppActions) {
        self.state = state
        self.actions = actions
        self.item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        super.init()
        item.button?.image = StatusItem.glyph(awake: false)
        item.button?.imagePosition = .imageOnly
        item.menu = buildMenu()
        refresh()

        // @Published fires on the main thread, in willSet: inside these sinks the
        // property still holds the old value, so the refresh is deferred one turn of
        // the main queue (which also coalesces a burst of changes into one menu rebuild).
        let phases: AnyPublisher<Phase, Never> = state.$snapshot.map { (s: Snapshot) -> Phase in s.phase }.removeDuplicates().eraseToAnyPublisher()
        phases
            .sink { [weak self] (_: Phase) in MainActor.assumeIsolated { self?.scheduleRefresh() } }
            .store(in: &cancellables)
        state.$connected
            .removeDuplicates()
            .sink { [weak self] _ in MainActor.assumeIsolated { self?.scheduleRefresh() } }
            .store(in: &cancellables)
        state.$daemonDetail
            .removeDuplicates()
            .sink { [weak self] _ in MainActor.assumeIsolated { self?.scheduleRefresh() } }
            .store(in: &cancellables)
        state.$wakeGate
            .removeDuplicates()
            .sink { [weak self] _ in MainActor.assumeIsolated { self?.scheduleRefresh() } }
            .store(in: &cancellables)
    }

    private func scheduleRefresh() {
        guard !refreshScheduled else { return }
        refreshScheduled = true
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.refreshScheduled = false
                self.refresh()
            }
        }
    }

    func remove() {
        NSStatusBar.system.removeStatusItem(item)
    }

    // MARK: - state → appearance

    private func refresh() {
        let phase = state.phase
        let awake = phase != .asleep && phase != .error
        item.button?.image = StatusItem.glyph(awake: awake)
        item.button?.appearsDisabled = !state.connected
        item.button?.toolTip = state.connected ? "Jarhead — \(StatusItem.label(for: phase))" : "Jarhead — daemon \(state.daemonDetail)"
        item.menu = buildMenu()
    }

    static func label(for phase: Phase) -> String {
        switch phase {
        case .asleep: return "asleep"
        case .connecting: return "connecting…"
        case .listening: return "listening"
        case .speaking: return "speaking"
        case .thinking: return "thinking"
        case .acting: return "acting"
        case .muted: return "muted"
        case .error: return "error"
        case .paused: return "paused"
        }
    }

    // MARK: - menu

    /// Also used for the Dock menu, so it is a fresh menu each time.
    /// Solid SF Symbol for a menu row, sized to the menu's text.
    private static func symbol(_ name: String) -> NSImage? {
        let cfg = NSImage.SymbolConfiguration(pointSize: 13, weight: .medium)
        return NSImage(systemSymbolName: name, accessibilityDescription: nil)?.withSymbolConfiguration(cfg)
    }

    func buildMenu() -> NSMenu {
        let menu = NSMenu()
        let phase = state.phase
        let awake = phase != .asleep && phase != .error
        let connected = state.connected

        let title = NSMenuItem(title: connected ? "Jarhead — \(StatusItem.label(for: phase))" : "Jarhead — \(state.daemonDetail)", action: nil, keyEquivalent: "")
        title.isEnabled = false
        menu.addItem(title)

        let wake = NSMenuItem(title: awake ? "Sleep" : "Wake", action: #selector(doToggleWake), keyEquivalent: " ")
        wake.keyEquivalentModifierMask = [.option, .shift]
        wake.target = self
        wake.isEnabled = connected
        wake.image = StatusItem.symbol(awake ? "moon.fill" : "bolt.fill")
        menu.addItem(wake)

        // The wake word gate, while asleep: what it is doing and, if off, why.
        if !awake {
            let wakeSettings = state.snapshot.settings.wakeSettings
            let gate = NSMenuItem(title: StatusItem.gateLabel(state.wakeGate, phrases: wakeSettings.phrases, auth: wakeSettings.auth), action: nil, keyEquivalent: "")
            gate.isEnabled = false
            gate.image = StatusItem.symbol(StatusItem.gateSymbol(state.wakeGate))
            menu.addItem(gate)
        }

        let mute = NSMenuItem(title: phase == .muted ? "Unmute" : "Mute", action: #selector(doToggleMute), keyEquivalent: "m")
        mute.keyEquivalentModifierMask = [.option, .shift]
        mute.target = self
        mute.isEnabled = connected && awake
        mute.image = StatusItem.symbol(phase == .muted ? "mic.fill" : "mic.slash.fill")
        menu.addItem(mute)

        let stop = NSMenuItem(title: "Stop", action: #selector(doStop), keyEquivalent: "\u{1b}")
        stop.keyEquivalentModifierMask = [.option]
        stop.target = self
        stop.isEnabled = connected && awake
        stop.image = StatusItem.symbol("stop.fill")
        menu.addItem(stop)

        menu.addItem(.separator())

        let console = NSMenuItem(title: "Open Console", action: #selector(doOpenConsole), keyEquivalent: "j")
        console.keyEquivalentModifierMask = [.option, .shift]
        console.target = self
        console.image = StatusItem.symbol("rectangle.3.group.fill")
        menu.addItem(console)

        let summon = NSMenuItem(title: "Summon Orb to Cursor", action: #selector(doSummon), keyEquivalent: "")
        summon.target = self
        summon.image = StatusItem.symbol("cursorarrow.click.2")
        menu.addItem(summon)

        let ledger = NSMenuItem(title: "Open Ledger Folder", action: #selector(doOpenLedger), keyEquivalent: "")
        ledger.target = self
        ledger.image = StatusItem.symbol("list.bullet.rectangle.fill")
        menu.addItem(ledger)

        menu.addItem(.separator())

        let quit = NSMenuItem(title: "Quit Jarhead", action: #selector(doQuit), keyEquivalent: "q")
        quit.target = self
        let circle = NSMenuItem(title: "Circle Something…", action: #selector(doMark), keyEquivalent: "c")
        circle.keyEquivalentModifierMask = [.option, .shift]
        circle.target = self
        circle.image = StatusItem.symbol("scope")
        circle.toolTip = "Draw around anything on screen and Jarhead sees it (⌥⇧C)"
        menu.addItem(circle)

        let setup = NSMenuItem(title: "Set Up…", action: #selector(doSetup), keyEquivalent: "")
        setup.target = self
        setup.image = StatusItem.symbol("gearshape.fill")
        menu.addItem(setup)

        quit.image = StatusItem.symbol("power")
        menu.addItem(quit)

        menu.autoenablesItems = false
        return menu
    }

    @objc private func doToggleWake() { actions.toggleWake() }
    @objc private func doToggleMute() { actions.toggleMute() }
    @objc private func doStop() { actions.stop() }
    @objc private func doOpenConsole() { actions.openConsole() }
    @objc private func doSummon() { actions.summonOrb() }
    @objc private func doOpenLedger() { actions.openLedgerFolder() }
    @objc private func doQuit() { actions.quit() }
    @objc private func doSetup() { state.openOnboarding() }
    @objc private func doMark() { state.beginMarkMode() }

    // MARK: - wake gate

    /// `auth` is named when it is `.none`, so a gate that opens the session on the word
    /// alone never looks like one that authenticates.
    static func gateLabel(_ g: WakeGateState, phrases: [String], auth: WakeAuth = .either) -> String {
        switch g {
        case .off(let reason): return "Wake word off — \(reason)"
        case .listening:
            let phrase = phrases.first { !$0.trimmingCharacters(in: .whitespaces).isEmpty } ?? "the wake word"
            return "Listening for “\(phrase)”" + (auth == .none ? " — no authentication" : "")
        case .heard: return "Heard you"
        case .authenticating(let method): return "Waiting for \(method)"
        case .granted: return "Waking…"
        case .denied(let reason): return "Not this time — \(reason)"
        case .lockedOut(let until): return "Locked for \(max(1, Int(until.timeIntervalSinceNow.rounded()))) s"
        }
    }

    static func gateSymbol(_ g: WakeGateState) -> String {
        switch g {
        case .off: return "ear.trianglebadge.exclamationmark"
        case .listening: return "ear.fill"
        case .heard, .granted: return "waveform.circle.fill"
        case .authenticating: return "lock.fill"
        case .denied: return "xmark.circle.fill"
        case .lockedOut: return "lock.slash.fill"
        }
    }

    // MARK: - glyph

    /// A monochrome orb: a ring, plus a filled core when awake. Template, so the
    /// system tints it for light/dark menu bars and Retina scaling is free.
    static func glyph(awake: Bool) -> NSImage {
        let size = NSSize(width: 18, height: 18)
        let image = NSImage(size: size, flipped: false) { rect in
            let c = NSPoint(x: rect.midX, y: rect.midY)
            NSColor.black.setStroke()
            NSColor.black.setFill()
            let ring = NSBezierPath(ovalIn: NSRect(x: c.x - 6.25, y: c.y - 6.25, width: 12.5, height: 12.5))
            ring.lineWidth = 1.5
            ring.stroke()
            if awake {
                NSBezierPath(ovalIn: NSRect(x: c.x - 3, y: c.y - 3, width: 6, height: 6)).fill()
            } else {
                // Asleep: a dim ember at the centre.
                NSColor.black.withAlphaComponent(0.45).setFill()
                NSBezierPath(ovalIn: NSRect(x: c.x - 1.5, y: c.y - 1.5, width: 3, height: 3)).fill()
            }
            return true
        }
        image.isTemplate = true
        return image
    }
}
