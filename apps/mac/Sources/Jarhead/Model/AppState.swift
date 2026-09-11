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
