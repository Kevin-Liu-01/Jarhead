import AppKit
import Combine

/// What the menus can do. The AppDelegate fills these in; the status item, the Dock
/// menu and the main menu all share them.
struct AppActions {
    /// Go / Pause — the transport's one button (AppState.transportToggle).
    var transportToggle: () -> Void = {}
    var toggleMute: () -> Void = {}
    /// Stop — close the session, sleep (AppState.transportStop). Never disabled.
    var stop: () -> Void = {}
    var openConsole: () -> Void = {}
    var summonOrb: () -> Void = {}
    var openLedgerFolder: () -> Void = {}
    var quit: () -> Void = {}
    /// The automations (design11): the ring's two presses — `automation.snooze` (id, minutes) / `automation.done`
    /// (id) — and the Console opened on its Automations section. Never a session, never a brain turn.
    var snoozeRing: (String, Int) -> Void = { _, _ in }
    var doneRing: (String) -> Void = { _ in }
    var openAutomations: () -> Void = {}
    /// design12: Recording on / off — the whole audio block through `set-settings`, never another command.
    var toggleRecording: () -> Void = {}
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
        item.button?.image = StatusItem.glyph(for: .asleep)
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
        // The permissions row counts what is missing; a grant landing rebuilds the menu.
        state.$permissionList
            .map { (list: [PermissionInfo]) -> [Grant] in list.map(\.grant) }
            .removeDuplicates()
            .sink { [weak self] _ in MainActor.assumeIsolated { self?.scheduleRefresh() } }
            .store(in: &cancellables)
        state.$permissionSweep
            .map { (p: PermissionSweepProgress?) -> Bool in p?.running ?? false }
            .removeDuplicates()
            .sink { [weak self] _ in MainActor.assumeIsolated { self?.scheduleRefresh() } }
            .store(in: &cancellables)
        // The last crash's row comes and goes with the notice (CrashGuard → AppState.lastCrash).
        state.$lastCrash
            .removeDuplicates()
            .sink { [weak self] _ in MainActor.assumeIsolated { self?.scheduleRefresh() } }
            .store(in: &cancellables)
        // The Recording row's checkmark follows the setting; its tooltip names who shares the mic (design12).
        state.$snapshot
            .map { (s: Snapshot) -> Bool in s.settings.audioSettings.recording }
            .removeDuplicates()
            .sink { [weak self] _ in MainActor.assumeIsolated { self?.scheduleRefresh() } }
            .store(in: &cancellables)
        state.$audioState
            .map { (a: AudioStateInfo?) -> [String] in a?.sharedWith ?? [] }
            .removeDuplicates()
            .sink { [weak self] _ in MainActor.assumeIsolated { self?.scheduleRefresh() } }
            .store(in: &cancellables)
        // The ring rows and the Next row follow the automations (design11).
        state.$ringing
            .removeDuplicates()
            .sink { [weak self] _ in MainActor.assumeIsolated { self?.scheduleRefresh() } }
            .store(in: &cancellables)
        state.$nextFire
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
        item.button?.image = StatusItem.glyph(for: phase)
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
        case .paused: return "paused · meter stopped"
        }
    }

    // MARK: - menu

    /// Also used for the Dock menu, so it is a fresh menu each time.
    /// Solid SF Symbol for a menu row, sized to the menu's text.
    private static func symbol(_ name: String) -> NSImage? {
        let cfg = NSImage.SymbolConfiguration(pointSize: 13, weight: .medium)
        return NSImage(systemSymbolName: name, accessibilityDescription: nil)?.withSymbolConfiguration(cfg)
    }

    /// The Go/Pause row's title: the transport's word for the phase.
    static func transportTitle(for phase: Phase) -> String {
        switch AppState.transportPress(for: phase) {
        case .go: return "Go"
        case .pause: return "Pause"
        case .stop: return "Cancel connecting"
        }
    }

    func buildMenu() -> NSMenu {
        let menu = NSMenu()
        let phase = state.phase
        let inSession = AppState.inSessionPhases.contains(phase)
        let paused = phase == .paused
        let connected = state.connected

        let title = NSMenuItem(title: connected ? "Jarhead — \(StatusItem.label(for: phase))" : "Jarhead — \(state.daemonDetail)", action: nil, keyEquivalent: "")
        title.isEnabled = false
        menu.addItem(title)

        // The previous run's crash, while its report is fresh (AppState.lastCrash): one row;
        // a click shows the report in Finder. The Console's rail has the dismiss.
        if let crash = state.lastCrash {
            let row = NSMenuItem(title: StatusItem.crashLabel(crash), action: #selector(doRevealCrash), keyEquivalent: "")
            row.target = self
            row.image = StatusItem.symbol("exclamationmark.triangle.fill")
            row.toolTip = "\(crash.reason)\n\(crash.fileURL.path)\nShow the report in Finder"
            menu.addItem(row)
        }

        // Go / Pause: the transport's one button (⌥⇧Space).
        let look = AppState.transportLabel(for: phase)
        let transport = NSMenuItem(title: StatusItem.transportTitle(for: phase), action: #selector(doTransportToggle), keyEquivalent: " ")
        transport.keyEquivalentModifierMask = [.option, .shift]
        transport.target = self
        transport.isEnabled = connected
        transport.image = StatusItem.symbol(look.symbol)
        transport.toolTip = look.help + " (⌥⇧Space)"
        menu.addItem(transport)

        // The wake word gate, while the engine is dormant or paused: what it is doing and, if off, why.
        if WakeGate.listens(in: phase) {
            let wake = state.snapshot.settings.wake
            let gate = NSMenuItem(title: StatusItem.gateLabel(state.wakeGate, phrases: wake.phrases, auth: wake.auth, paused: paused), action: nil, keyEquivalent: "")
            gate.isEnabled = false
            gate.image = StatusItem.symbol(StatusItem.gateSymbol(state.wakeGate))
            menu.addItem(gate)
        }

        // The automations (design11): while one rings, the crash-row pattern — two hot rows, Snooze N (⌥⇧S) and Done;
        // otherwise the next fire as one informational row. Both read AppState, which the daemon feeds.
        if let ring = state.ringing {
            let minutes = StatusItem.snoozeMinutes(for: ring, settings: state.snapshot.settings.automationSettings)
            let snooze = NSMenuItem(title: "\(ring.line) · Snooze \(minutes)", action: #selector(doSnoozeRing), keyEquivalent: "s")
            snooze.keyEquivalentModifierMask = [.option, .shift]
            snooze.target = self
            snooze.image = StatusItem.symbol("bell.fill")
            snooze.toolTip = "Snooze — rings again in \(minutes) min (⌥⇧S)"
            menu.addItem(snooze)
            let done = NSMenuItem(title: "Done", action: #selector(doDoneRing), keyEquivalent: "")
            done.target = self
            done.image = StatusItem.symbol("checkmark.circle.fill")
            done.toolTip = "Done — stops the \(ring.kind)"
            menu.addItem(done)
        } else if let next = state.nextFire {
            let row = NSMenuItem(title: StatusItem.nextLabel(next), action: nil, keyEquivalent: "")
            row.isEnabled = false
            row.image = StatusItem.symbol("alarm.fill")
            menu.addItem(row)
        }

        let mute = NSMenuItem(title: phase == .muted ? "Unmute" : "Mute", action: #selector(doToggleMute), keyEquivalent: "m")
        mute.keyEquivalentModifierMask = [.option, .shift]
        mute.target = self
        mute.isEnabled = connected && inSession
        mute.image = StatusItem.symbol(phase == .muted ? "mic.fill" : "mic.slash.fill")
        menu.addItem(mute)

        // Recording (design12): the checkmark is the state, the title never flips; enabled whenever the daemon is there
        // (the point is to set it before the demo), never gated on a session. While another process reads the mic the
        // tooltip says who.
        let recording = NSMenuItem(title: RecordingWords.menuRow, action: #selector(doToggleRecording), keyEquivalent: Hotkeys.Action.toggleRecording.keyEquivalent.0)
        recording.keyEquivalentModifierMask = Hotkeys.Action.toggleRecording.keyEquivalent.1
        recording.target = self
        recording.isEnabled = connected
        recording.state = state.snapshot.settings.audioSettings.recording ? .on : .off
        recording.image = StatusItem.symbol(RecordingWords.chipGlyph)
        recording.toolTip = RecordingWords.menuTip(sharedWith: RecordingWords.firstShared(state.audioState?.sharedWith))
        menu.addItem(recording)

        // Stop is never disabled: it must land in every phase, connected or not (the
        // local speaker flush still happens).
        let stop = NSMenuItem(title: "Stop", action: #selector(doStop), keyEquivalent: "\u{1b}")
        stop.keyEquivalentModifierMask = [.option]
        stop.target = self
        stop.isEnabled = true
        stop.image = StatusItem.symbol("stop.fill")
        stop.toolTip = "Stop everything — close the session, sleep (⌥⎋)"
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

        let automations = NSMenuItem(title: "Automations…", action: #selector(doOpenAutomations), keyEquivalent: "")
        automations.target = self
        automations.image = StatusItem.symbol("alarm.fill")
        automations.toolTip = "What is set to fire while Jarhead sleeps — the Console's Automations section"
        menu.addItem(automations)

        menu.addItem(.separator())

        let quit = NSMenuItem(title: "Quit Jarhead", action: #selector(doQuit), keyEquivalent: "q")
        quit.target = self
        let circle = NSMenuItem(title: "Circle Something…", action: #selector(doMark), keyEquivalent: "c")
        circle.keyEquivalentModifierMask = [.option, .shift]
        circle.target = self
        circle.image = StatusItem.symbol("pencil.and.outline")
        circle.toolTip = "Draw around anything on screen and Jarhead sees it (⌥⇧C)"
        menu.addItem(circle)

        let setup = NSMenuItem(title: "Set Up…", action: #selector(doSetup), keyEquivalent: "")
        setup.target = self
        setup.image = StatusItem.symbol("gearshape.fill")
        menu.addItem(setup)

        // Permissions: how many are missing (required ones named first), opening Setup on
        // that step; and the sweep itself. While the sweep runs the row says so.
        let perms = NSMenuItem(title: StatusItem.permissionsLabel(state.permissionList, sweep: state.permissionSweep), action: #selector(doPermissions), keyEquivalent: "")
        perms.target = self
        perms.image = StatusItem.symbol(StatusItem.permissionsSymbol(state.permissionList))
        perms.toolTip = "Open Setup on the Permissions step"
        menu.addItem(perms)

        let askAll = NSMenuItem(title: "Ask for everything…", action: #selector(doAskAll), keyEquivalent: "")
        askAll.target = self
        askAll.isEnabled = !(state.permissionSweep?.running ?? false)
        askAll.image = StatusItem.symbol(ConsoleGlyph.ask)
        askAll.toolTip = "Ask for every permission Jarhead can use, one dialog at a time, then the System Settings panes"
        menu.addItem(askAll)

        quit.image = StatusItem.symbol(ConsoleGlyph.quit)
        menu.addItem(quit)

        menu.autoenablesItems = false
        return menu
    }

    @objc private func doTransportToggle() { actions.transportToggle() }
    @objc private func doToggleMute() { actions.toggleMute() }
    @objc private func doToggleRecording() { actions.toggleRecording() }
    @objc private func doStop() { actions.stop() }
    @objc private func doOpenConsole() { actions.openConsole() }
    @objc private func doSummon() { actions.summonOrb() }
    @objc private func doOpenLedger() { actions.openLedgerFolder() }
    @objc private func doQuit() { actions.quit() }
    @objc private func doSetup() { state.openOnboarding() }
    @objc private func doMark() { state.beginMarkMode() }
    @objc private func doPermissions() { state.openPermissionsSetup() }
    @objc private func doAskAll() { state.requestAll() }
    @objc private func doRevealCrash() { state.revealCrash() }
    @objc private func doSnoozeRing() {
        guard let ring = state.ringing else { return }
        actions.snoozeRing(ring.id, StatusItem.snoozeMinutes(for: ring, settings: state.snapshot.settings.automationSettings))
    }
    @objc private func doDoneRing() {
        guard let ring = state.ringing else { return }
        actions.doneRing(ring.id)
    }
    @objc private func doOpenAutomations() { actions.openAutomations() }

    // MARK: - automations rows

    /// The ring's own snooze press, else Settings' minutes (timers five) — the island's rule.
    static func snoozeMinutes(for ring: RingLine, settings: AutomationSettings) -> Int {
        ring.presses.first { $0.kind == "snooze" }?.minutes ?? (ring.kind == "timer" ? 5 : settings.snoozeMinutes)
    }

    /// "Next · 07:10 Wake up, Kevin".
    static func nextLabel(_ next: NextFire) -> String {
        guard next.at.isFinite else { return "Next · \(next.name)" }
        return "Next · \(RingWords.clock(Date(timeIntervalSince1970: next.at / 1000))) \(next.name)"
    }

    // MARK: - crash row

    /// "Crashed 2 min ago — Failed to create tap due to format mismatch", the reason cut to a menu's width.
    static func crashLabel(_ crash: CrashNotice, now: Date = Date()) -> String {
        let reason = crash.reason.count > 64 ? String(crash.reason.prefix(63)) + "…" : crash.reason
        return "Crashed \(CrashNotice.ago(crash.at, now: now)) — \(reason)"
    }

    // MARK: - permissions row

    /// "Permissions: 3 missing (2 required)", "Permissions: all 16 granted", "Permissions: asking…".
    static func permissionsLabel(_ list: [PermissionInfo], sweep: PermissionSweepProgress?) -> String {
        if let sweep, sweep.running { return "Permissions: asking…" }
        guard list.contains(where: { $0.checkedAt != nil }) else { return "Permissions: not read yet" }
        let missing = list.filter { $0.grant != .granted }
        if missing.isEmpty { return "Permissions: all \(list.count) granted" }
        let required = missing.filter(\.required).count
        return "Permissions: \(missing.count) missing" + (required > 0 ? " (\(required) required)" : "")
    }

    static func permissionsSymbol(_ list: [PermissionInfo]) -> String {
        if !list.contains(where: { $0.checkedAt != nil }) { return "lock.shield.fill" }
        if list.contains(where: { $0.required && $0.grant != .granted }) { return "exclamationmark.shield.fill" }
        return list.allSatisfy { $0.grant == .granted } ? "checkmark.shield.fill" : "lock.shield.fill"
    }

    // MARK: - wake gate

    /// `auth` is named when it is `.none`, so a gate that opens the session on the word
    /// alone never looks like one that authenticates. While `paused` the gate listens for
    /// the word to *resume* — no authentication, the pause was authenticated minutes ago
    /// (WakeGate.heard) — so the row says so, and names the other way back.
    static func gateLabel(_ g: WakeGateState, phrases: [String], auth: WakeAuth = .either, paused: Bool = false) -> String {
        switch g {
        case .off(let reason): return "Wake word off — \(reason)"
        case .listening:
            let phrase = phrases.first { !$0.trimmingCharacters(in: .whitespaces).isEmpty } ?? "the wake word"
            if paused { return "paused · say “\(phrase)” or press Go" }
            return "Listening for “\(phrase)”" + (auth == .none ? " — no authentication" : "")
        case .heard: return "Heard you"
        case .authenticating(let method): return "Waiting for \(method)"
        case .granted: return paused ? "Resuming…" : "Waking…"
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

    /// A monochrome orb: a ring, plus a filled core while a session is open or opening,
    /// a dim ember while asleep, and two bars while paused (the session is closed, the
    /// conversation kept). Template, so the system tints it for light/dark menu bars and
    /// Retina scaling is free.
    static func glyph(for phase: Phase) -> NSImage {
        let size = NSSize(width: 18, height: 18)
        let paused = phase == .paused
        let awake = AppState.voiceAudioRuns(in: phase)
        let image = NSImage(size: size, flipped: false) { rect in
            let c = NSPoint(x: rect.midX, y: rect.midY)
            NSColor.black.setStroke()
            NSColor.black.setFill()
            let ring = NSBezierPath(ovalIn: NSRect(x: c.x - 6.25, y: c.y - 6.25, width: 12.5, height: 12.5))
            ring.lineWidth = 1.5
            ring.stroke()
            if paused {
                // Paused: two bars at the centre, the transport's own mark.
                NSBezierPath(rect: NSRect(x: c.x - 2.75, y: c.y - 3, width: 1.75, height: 6)).fill()
                NSBezierPath(rect: NSRect(x: c.x + 1, y: c.y - 3, width: 1.75, height: 6)).fill()
            } else if awake {
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
