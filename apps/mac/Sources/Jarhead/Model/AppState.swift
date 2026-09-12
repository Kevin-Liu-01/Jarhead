import Foundation
import Combine

/// The one observable the UI reads. The daemon client writes it; nothing in
/// `UI/` talks to a socket. Everything is main-actor so SwiftUI can observe it.
@MainActor
public final class AppState: ObservableObject {
    @Published public var snapshot: Snapshot = .empty
    @Published public var levels: AudioLevels = .silent
    @Published public var connected: Bool = false
    @Published public var daemonDetail: String = "starting"
    @Published public var toasts: [Toast] = []
    /// Set by the client; `~/.jarhead` by default. Screenshot paths are relative to it.
    @Published public var stateDir: URL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".jarhead")

    /// Overlay commands arrive here in global points; each overlay window filters to its own display.
    public let overlayCommands = PassthroughSubject<OverlayCommand, Never>()
    /// Strokes being drawn right now (by the blob, or by Kevin in mark mode): the same
    /// id is re-sent with a longer `points` as the line grows; `done` seals it and the
    /// overlay keeps it for `ttlMs`. Global points, y down. Orb → overlay, in-process.
    public let liveStrokes = PassthroughSubject<LiveStroke, Never>()

    // MARK: wake word gate (owned by the app; the UI only reads and asks)

    /// What the local wake word gate is doing right now.
    @Published public var wakeGate: WakeGateState = .off(reason: "starting")
    /// The last few words the on-device recogniser heard while listening, for the
    /// "does it hear me?" calibration view. Empty when not listening.
    @Published public var wakeHeard: String = ""
    /// A passphrase is enrolled (hashed on disk); the UI shows Set/Change/Clear accordingly.
    @Published public var wakePassphraseSet: Bool = false
    /// Installed by the gate. UI code only ever calls these.
    public var wakeActions = WakeActions()

    // MARK: - Permissions

    /// Every permission as this app last read it (PermissionsCenter, the process TCC keys
    /// the grants on), in contract order; `PermissionsKit.placeholders` until the first
    /// read. The same list travels to the daemon (`permissions {all}`) and comes back in
    /// `snapshot.permissions.all` for the surfaces that only read snapshots.
    @Published public var permissionList: [PermissionInfo] = []
    /// The "Ask for everything" sweep while it runs, and its summary for a while after; nil otherwise.
    @Published public var permissionSweep: PermissionSweepProgress?
    /// Installed by the app (PermissionsCenter). UI code only ever calls the funcs below.
    public var permissionActions = PermissionActions()
    /// Opens Setup on the Permissions step. Installed by the app.
    public var openPermissionsSetupHandler: () -> Void = {}

    /// The sweep: required kinds first, one prompt at a time, then the System Settings walk.
    public func requestAll() { permissionActions.requestAll() }
    /// One kind: its prompt, or its pane when only System Settings grants it (or it was denied).
    public func request(_ kind: PermissionKind) { permissionActions.request(kind) }
    public func openPermissionSettings(_ kind: PermissionKind) { permissionActions.openSettings(kind) }
    /// Re-read every kind now (read-only, never prompts).
    public func refreshPermissions() { permissionActions.refresh() }
    /// The settings walk's Next: the following pane.
    public func permissionSweepNext() { permissionActions.sweepNext() }
    public func permissionSweepCancel() { permissionActions.sweepCancel() }
    public func openPermissionsSetup() { openPermissionsSetupHandler() }

    public var permissionsMissingRequired: [PermissionInfo] { permissionList.filter { $0.required && $0.grant != .granted } }
    public var permissionsGrantedCount: Int { permissionList.filter { $0.grant == .granted }.count }

    // MARK: conversations and marks

    /// Conversations the Console has opened (`agent.open`), keyed by agent id; the
    /// daemon client replaces or appends as `agent.transcript` events arrive.
    @Published public var transcripts: [String: AgentTranscript] = [:]
    /// Mark mode (Kevin circles something on screen). Installed by the app.
    public var beginMarkModeHandler: () -> Void = {}
    public func beginMarkMode() { beginMarkModeHandler() }

    /// Called by the daemon client for every `agent.transcript` event.
    ///
    /// `append` upserts by id: the engine re-sends a message when it changes (a tool
    /// call gains its output and status, an assistant turn gains a later block).
    /// `replace` is either the newest page (first open) or an older page from
    /// `agent.history`, recognised by ending before what we already have — that one
    /// is prepended, and `complete` comes from the page (the last page reaches the
    /// first message and says so).
    public func applyTranscript(_ t: AgentTranscript, mode: String) {
        if mode == "append", var existing = transcripts[t.agentId] {
            var index: [String: Int] = [:]
            for (i, m) in existing.messages.enumerated() { index[m.id] = i }
            for m in t.messages {
                if let i = index[m.id] {
                    existing.messages[i] = m
                } else {
                    index[m.id] = existing.messages.count
                    existing.messages.append(m)
                }
            }
            existing.total = max(existing.total, t.total)
            existing.live = t.live
            transcripts[t.agentId] = existing
            return
        }
        if let existing = transcripts[t.agentId], !existing.messages.isEmpty, let firstKnown = existing.messages.first,
           let last = t.messages.last, last.id != firstKnown.id, last.at <= firstKnown.at {
            // An older page: prepend what we did not have, keep the rest.
            var merged = t
            let known = Set(t.messages.map(\.id))
            merged.messages.append(contentsOf: existing.messages.filter { !known.contains($0.id) })
            merged.live = existing.live
            merged.total = max(existing.total, t.total)
            transcripts[t.agentId] = merged
            return
        }
        transcripts[t.agentId] = t
    }

    /// Installed by the daemon client. UI code only ever calls `send`.
    public var sendHandler: (EngineCommand) -> Void = { _ in }
    public var ledgerDaysHandler: () async -> [String] = { [] }
    public var ledgerReadHandler: (String) async -> [LedgerRow] = { _ in [] }
    /// Console → app window management (open console, quit) also goes through here.
    public var openConsoleHandler: () -> Void = {}
    /// Opens the first-run / setup window (UI/Onboarding). Installed by the app.
    public var openOnboardingHandler: () -> Void = {}

    public init() {}

    public func send(_ command: EngineCommand) { sendHandler(command) }
    public func ledgerDays() async -> [String] { await ledgerDaysHandler() }
    public func ledgerRows(day: String) async -> [LedgerRow] { await ledgerReadHandler(day) }
    public func openConsole() { openConsoleHandler() }
    public func openOnboarding() { openOnboardingHandler() }

    public func toast(_ text: String, tone: Toast.Tone = .info) {
        let t = Toast(id: UUID(), text: text, tone: tone)
        toasts.append(t)
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            self?.toasts.removeAll { $0.id == t.id }
        }
    }

    public func screenshotURL(_ relativePath: String) -> URL { stateDir.appendingPathComponent(relativePath) }

    // MARK: - Jarhead sessions

    /// Jarhead's own Live sessions as the ledger recorded them (`ledger.sessions`),
    /// newest first — the Console's "Jarhead" section. Refreshed when the Console
    /// opens, when the snapshot's session id changes and when the phase settles to
    /// asleep or paused; never on every snapshot.
    @Published public var jarheadSessions: [JarheadSessionSummary] = []
    /// Installed by the daemon client (`installJarheadSessions`). UI code only ever calls the two funcs below.
    public var jarheadSessionsHandler: () async -> [JarheadSessionSummary] = { [] }
    public var jarheadSessionRowsHandler: (String) async -> [LedgerRow] = { _ in [] }
    private var jarheadSessionsWatch: AnyCancellable?
    private var jarheadSessionsRefreshing = false
    private var jarheadSessionsAgain = false

    /// One session's rows, its `session.started` row through its `session.closed` row.
    public func jarheadSessionRows(_ id: String) async -> [LedgerRow] { await jarheadSessionRowsHandler(id) }

    /// Re-reads the list. Overlapping calls fold into one more read after the one in
    /// flight, so a row that landed mid-read is never missed. `delayMs` lets the
    /// ledger row behind a change land first: the engine appends the row, then sends
    /// the snapshot that announces it.
    public func refreshJarheadSessions(delayMs: UInt64 = 0) {
        Task { @MainActor [weak self] in
            if delayMs > 0 { try? await Task.sleep(nanoseconds: delayMs * 1_000_000) }
            guard let self else { return }
            if self.jarheadSessionsRefreshing {
                self.jarheadSessionsAgain = true
                return
            }
            self.jarheadSessionsRefreshing = true
            repeat {
                self.jarheadSessionsAgain = false
                let list = await self.jarheadSessionsHandler()
                if list != self.jarheadSessions { self.jarheadSessions = list }
            } while self.jarheadSessionsAgain
            self.jarheadSessionsRefreshing = false
        }
    }

    /// When the list is re-read after a transport change, in ms after the snapshot that
    /// announced it. A stop or a pause writes its own row first, then the snapshot
    /// (phase asleep / paused, no session) — the first read catches that row. The
    /// session's `session.closed` row lands only when the server answers the close
    /// (~650 ms on this Mac) or the engine forces it at its 1 s deadline
    /// (Engine.CLOSE_DEADLINE_MS), and the snapshot that follows changes neither the
    /// phase nor the session id, so nothing else would trigger a read: the second one
    /// is timed past the deadline with room for a busy event loop.
    public static let jarheadSessionsRefreshDelaysMs: [UInt64] = [400, 1800]

    /// The daemon client's two requests, and the watch that refreshes the list when
    /// the snapshot's session id changes or the phase becomes asleep / paused.
    public func installJarheadSessions(list: @escaping () async -> [JarheadSessionSummary], rows: @escaping (String) async -> [LedgerRow]) {
        jarheadSessionsHandler = list
        jarheadSessionRowsHandler = rows
        // The sink's payload is the new snapshot; `self.snapshot` is still the old one
        // in here (`@Published` fires in willSet), so both sides are kept locally.
        var lastSessionId = snapshot.session?.id
        var lastPhase = snapshot.phase
        jarheadSessionsWatch = $snapshot
            .sink { [weak self] (snap: Snapshot) in
                let sessionChanged = snap.session?.id != lastSessionId
                let settled = snap.phase != lastPhase && (snap.phase == .asleep || snap.phase == .paused)
                lastSessionId = snap.session?.id
                lastPhase = snap.phase
                guard sessionChanged || settled else { return }
                MainActor.assumeIsolated {
                    for delay in AppState.jarheadSessionsRefreshDelaysMs { self?.refreshJarheadSessions(delayMs: delay) }
                }
            }
    }

    // Convenience views over the snapshot.
    public var phase: Phase { snapshot.phase }
    public var lastKevin: TranscriptItem? { snapshot.transcript.last { $0.speaker == .kevin } }
    public var lastJarhead: TranscriptItem? { snapshot.transcript.last { $0.speaker == .jarhead } }
    public var activeDelegation: Delegation? { snapshot.delegations.last { $0.status == .running || $0.status == .awaitingConfirmation } }
    public var isAwake: Bool { snapshot.phase != .asleep && snapshot.phase != .error }
}

/// The wake word gate's state machine, as the UI sees it.
public enum WakeGateState: Equatable {
    /// Not listening, and why ("awake", "disabled", "Speech Recognition not granted", …).
    case off(reason: String)
    case listening
    /// The wake word was just heard; the prompt is playing.
    case heard
    /// Waiting for Touch ID / the passphrase. `method` is what the prompt asked for.
    case authenticating(method: String)
    /// Authenticated; the wake command is on its way to the engine.
    case granted
    case denied(reason: String)
    case lockedOut(until: Date)

    public var isListening: Bool { if case .listening = self { return true } else { return false } }
    public var isAuthenticating: Bool { if case .authenticating = self { return true } else { return false } }
}

/// What the UI can ask the gate to do. Filled in by the gate at launch.
public struct WakeActions {
    /// Enrol (or replace) the passphrase. Returns false when it is too short.
    public var setPassphrase: (String) -> Bool = { _ in false }
    public var clearPassphrase: () -> Void = {}
    /// A typed passphrase: answers a pending prompt, or wakes directly when asleep.
    public var submitPassphrase: (String) -> Void = { _ in }
    public var cancelAuth: () -> Void = {}
    public init() {}
}

// MARK: - Permissions (types)

/// What the UI can ask of the permissions centre. Filled in by the app at launch; a
/// preview harness fills them with printers.
public struct PermissionActions {
    public var requestAll: () -> Void = {}
    public var request: (PermissionKind) -> Void = { _ in }
    public var openSettings: (PermissionKind) -> Void = { _ in }
    public var refresh: () -> Void = {}
    public var sweepNext: () -> Void = {}
    public var sweepCancel: () -> Void = {}
    public init() {}
}

/// The sweep as the views show it: "4 of 16 · asking for Contacts…", then the System
/// Settings walk one pane at a time, then the summary.
public struct PermissionSweepProgress: Equatable {
    public enum Stage: Equatable {
        /// Prompts, one at a time.
        case asking
        /// A prompt whose API returns at once while the system shows its dialog (Screen
        /// Recording, Accessibility, Input Monitoring) was fired: waiting for the grant to
        /// land — from the dialog's own Open System Settings, or from the pane; Next skips.
        case waiting
        /// Only settings-only kinds (and denied prompt kinds) remain: a pane is open, Next moves on.
        case settings
        /// Finished; `summary` says how it went.
        case done
    }
    public var stage: Stage
    /// How many kinds the sweep walks (all sixteen).
    public var total: Int
    /// 1-based position of the kind being asked, in sweep order.
    public var index: Int
    public var current: PermissionKind?
    /// The one line a surface shows.
    public var line: String
    /// The settings walk's queue, the open step's kinds first.
    public var remaining: [PermissionKind]
    /// The kinds the open step covers: one for a prompt wait, several when they share a
    /// pane (the three folders under Files and Folders); the step moves on when all are granted.
    public var group: [PermissionKind]
    public var summary: String?
    /// JARHEAD_PERMISSIONS_DRY_RUN=1: nothing was asked, only logged.
    public var dryRun: Bool
    public init(stage: Stage, total: Int, index: Int, current: PermissionKind?, line: String, remaining: [PermissionKind] = [], group: [PermissionKind] = [], summary: String? = nil, dryRun: Bool = false) {
        self.stage = stage; self.total = total; self.index = index; self.current = current; self.line = line
        self.remaining = remaining; self.group = group; self.summary = summary; self.dryRun = dryRun
    }
    public var running: Bool { stage != .done }
}

/// A stroke in progress on the click-through layer.
public struct LiveStroke: Equatable {
    public var id: String
    public var points: [Point2]
    public var tone: OverlayTone
    public var label: String?
    public var done: Bool
    public var ttlMs: Double
    public init(id: String, points: [Point2], tone: OverlayTone, label: String? = nil, done: Bool = false, ttlMs: Double = 6000) {
        self.id = id; self.points = points; self.tone = tone; self.label = label; self.done = done; self.ttlMs = ttlMs
    }
}

public struct Toast: Identifiable, Equatable {
    public enum Tone: String { case info, warn, error }
    public var id: UUID
    public var text: String
    public var tone: Tone
}

// MARK: - Transport

/// What a press of the Go/Pause button does in a phase (`AppState.transportPress(for:)`).
public enum TransportPress: Equatable {
    /// `.go`: wake (asleep, error) or resume with the paused context (paused).
    case go
    /// `.pause`: close the session — the meter stops — and keep the conversation (in session).
    case pause
    /// `.stop`: still dialling; a press while connecting is "never mind".
    case stop
}

/// The transport: one Go/Pause button and one Stop, the same everywhere — the capsule's
/// action row and right-click menu, the notch island, the Console composer (⌘P / ⌘.), the
/// status and Dock menus, the hotkeys (⌥⇧Space, its alias ⌥⇧P, ⌥⎋) and the `jarhead://`
/// URLs. Every site calls these and nothing else, so no two sites can disagree about what
/// a press means. Pause and Stop both *close* the Live session, so the meter stops the
/// moment they land; the difference is what is kept: a pause holds the conversation
/// (`snapshot.pause`) and Go resumes it in a new session carrying that context, a stop
/// drops it and sleeps. The phase is read from the snapshot at call time — never from
/// inside a Combine sink, where the property still holds the previous value.
extension AppState {
    /// The in-process "Stop was pressed" signal, posted by `transportStop()` and observed
    /// by the orb (OrbPanelController.stopPressedNotification spells the same name; Model/
    /// compiles without UI/Orb). The blob cancels its flight or trace and shivers on it,
    /// before the engine's snapshot arrives.
    public nonisolated static let stopPressedNotification = Notification.Name("jarhead.stopPressed")

    /// Phases with a Live session open and the meter running. Go/Pause shows Pause here;
    /// Mute is enabled only here. Paused is deliberately not one: the session is closed.
    public nonisolated static let inSessionPhases: Set<Phase> = [.listening, .speaking, .thinking, .acting, .muted]

    /// The one decision table behind every Go/Pause button. Pure, so the Console composer
    /// (which has a phase, not the state) reads it and dispatches through its own actions.
    public nonisolated static func transportPress(for phase: Phase) -> TransportPress {
        if inSessionPhases.contains(phase) { return .pause }
        if phase == .connecting { return .stop }
        return .go
    }

    /// The Go/Pause button's face for a phase — the solid symbol and the tooltip words —
    /// so every site draws the same thing: `play.fill` while asleep, in error or paused
    /// (Go), `pause.fill` in session (Pause), `ellipsis` while connecting (a press stops).
    /// Sites append their own key: "(⌘P)" in the Console, "(⌥⇧Space)" elsewhere.
    public nonisolated static func transportLabel(for phase: Phase) -> (symbol: String, help: String) {
        switch transportPress(for: phase) {
        case .go: return phase == .paused ? ("play.fill", "Go — resume with the context") : ("play.fill", "Go")
        case .pause: return ("pause.fill", "Pause — the meter stops, the conversation is kept")
        case .stop: return ("ellipsis", "Connecting — press to stop")
        }
    }

    /// Go is the one filled accent button, and only while asleep or in error (where Go
    /// retries). Paused wears a ghost Go: the conversation is kept and the button is the
    /// way back, but nothing is running and nothing is billed.
    public nonisolated static func transportFilled(for phase: Phase) -> Bool { phase == .asleep || phase == .error }

    /// The microphone and speaker run while a session is open or being opened. Paused is
    /// off: the session is closed, the mic dot goes out, the wake gate has the microphone.
    public nonisolated static func voiceAudioRuns(in phase: Phase) -> Bool {
        phase != .asleep && phase != .error && phase != .paused
    }

    /// `transportLabel(for:)` at the current phase.
    public var transportLabel: (symbol: String, help: String) { AppState.transportLabel(for: snapshot.phase) }
    /// `transportFilled(for:)` at the current phase.
    public var transportFilled: Bool { AppState.transportFilled(for: snapshot.phase) }
    /// A Live session is open right now (the meter is running).
    public var inSession: Bool { AppState.inSessionPhases.contains(snapshot.phase) }

    /// Go / Pause, the button. In session → `.pause`; connecting → Stop; asleep, paused or
    /// error → `.go` (wake, or resume with the paused context).
    public func transportToggle() {
        switch AppState.transportPress(for: snapshot.phase) {
        case .go: send(.go)
        case .pause: send(.pause)
        case .stop: transportStop()
        }
    }

    /// Go alone (`jarhead://go`, the wake gate's resume): wake or resume; nothing while a
    /// session is open or dialling.
    public func transportGo() {
        if AppState.transportPress(for: snapshot.phase) == .go { send(.go) }
    }

    /// Pause alone (`jarhead://pause`): only with a session open.
    public func transportPause() {
        if AppState.transportPress(for: snapshot.phase) == .pause { send(.pause) }
    }

    /// Stop everything, in every phase — the button is never disabled. The command (the
    /// AppDelegate's send handler flushes the speaker locally before it leaves, so speech
    /// dies at the press, not at the round trip), then the feedback nothing waits on: the
    /// stop-pressed notification (the blob), the overlay's clear (the shapes come down) and
    /// one "Stopped" toast (the Console's pill and the orb's). A site adds only its own
    /// local red flash of the button; the toast and the clear are done here, once.
    public func transportStop() {
        send(.stop)
        NotificationCenter.default.post(name: AppState.stopPressedNotification, object: nil)
        overlayCommands.send(.clear)
        toast("Stopped")
    }
}

/// The meter's words, once, for every surface (the capsule header, the Console's Now
/// panel, the notch): billed time at the Live list price, and the paused line.
public enum TransportFormat {
    /// Billed seconds → "2.3 min" (always one decimal: the meter is read at a glance and compared).
    public static func minutes(_ seconds: Double) -> String {
        String(format: "%.1f min", max(0, seconds.isFinite ? seconds : 0) / 60)
    }

    /// Billed seconds → "$0.12" (LivePrice, per second).
    public static func dollars(_ seconds: Double) -> String {
        String(format: "$%.2f", LivePrice.dollars(seconds: max(0, seconds.isFinite ? seconds : 0)))
    }

    /// Billed seconds → "2.3 min · $0.12".
    public static func billed(_ seconds: Double) -> String { minutes(seconds) + " · " + dollars(seconds) }

    /// Today's total → "today 12.3 min · $0.62"; nil when nothing was billed today (hidden).
    public static func today(_ usage: UsageToday?) -> String? {
        guard let usage, usage.seconds > 0 else { return nil }
        return "today " + billed(usage.seconds)
    }

    /// A pause decays to sleep at `sleepsAt` (wall-clock ms): "sleeps in 4 min", "sleeps in 40 s", "sleeping…".
    public static func sleepsIn(_ sleepsAt: Double, now: Date) -> String {
        let s = (sleepsAt - now.timeIntervalSince1970 * 1000) / 1000
        guard s.isFinite, s > 0 else { return "sleeping…" }
        if s >= 60 { return "sleeps in \(Int((s / 60).rounded(.up))) min" }
        return "sleeps in \(Int(s.rounded(.up))) s"
    }

    /// The paused line, everywhere it is shown: the meter stopped, the conversation
    /// kept, the decay to sleep counting down (tick it with a TimelineView).
    public static func pausedLine(_ pause: PauseInfo, now: Date) -> String {
        "Paused · meter stopped · resumes with context · " + sleepsIn(pause.sleepsAt, now: now)
    }
}
