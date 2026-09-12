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

    // MARK: - Crashes

    /// The previous run's crash, while its report is fresh (App/CrashGuard: < 10 min old).
    /// One dismissable line in the Console's rail and one row in the status menu; never a
    /// modal. Nil once dismissed, or when the last run ended cleanly.
    @Published public var lastCrash: CrashNotice?
    /// Installed by the app: reveals the report file (Finder).
    public var revealCrashHandler: (URL) -> Void = { _ in }

    public func noteCrash(_ notice: CrashNotice) { lastCrash = notice }
    public func dismissCrash() { lastCrash = nil }
    public func revealCrash() {
        if let c = lastCrash { revealCrashHandler(c.fileURL) }
    }

    // MARK: - Cleanup

    // Conversation cleanup, the Console's. Nothing here deletes anything: every action is
    // an EngineCommand whose inverse is another one (trash ↔ restore, pin ↔ unpin, clear ↔
    // restore), the ledger's tombstone rows are the truth and the Console re-reads them.
    // What lives here is only what the UI needs between the click and the re-read: the
    // last 20 actions for Undo, the one toast with Undo, an optimistic overlay so a row
    // moves the moment Kevin acts, the agents he just hid, and when he cleared Now.

    /// The last 20 actions, newest last; `undoCleanup()` pops.
    @Published public var cleanupUndoStack: [CleanupAction] = []
    /// Undone actions, for Edit › Redo; a new action clears it.
    @Published public var cleanupRedoStack: [CleanupAction] = []
    /// "Moved to Trash · Undo" for 8 s; nil when none.
    @Published public var cleanupToast: CleanupToast?
    /// What the rail shows before the ledger's re-read confirms it: chain id → its state /
    /// name / pinned after the click. Pruned when the list agrees, or after 15 s.
    @Published public var chainOverrides: [String: ChainOverride] = [:]
    /// Agents Kevin hid or unhid before the snapshot agrees: agent id → hidden.
    @Published public var hiddenAgentOverrides: [String: Bool] = [:]
    /// Wall-clock ms when Kevin cleared the Now stream (`now.clear`); nil when not cleared.
    /// The engine hides the items at its end too; this hides them at once and keeps the
    /// feed's "Cleared · Undo" state until new items arrive or the session changes.
    @Published public var nowClearedAt: Double?
    /// Full-text search over the ledger (`ledger.search`). Installed by the app (AppDelegate,
    /// next to the Jarhead-sessions handlers); nil is no answer (a daemon from before the
    /// message), [] is no hits.
    public var ledgerSearchHandler: (String, Int) async -> [LedgerHit]? = { _, _ in nil } {
        didSet { ledgerSearchInstalled = true }
    }
    /// Whether anything installed the handler. False is the app's gap, not the daemon's: the
    /// rail says so instead of blaming a daemon it never asked.
    public private(set) var ledgerSearchInstalled = false
    /// The window's undo manager (Edit › Undo, ⌘Z), read at call time; installed by the Console.
    public var cleanupUndoManager: () -> UndoManager? = { nil }
    /// One target per action for the undo manager (it holds targets weakly), kept while its
    /// registration stands: undoing an action outside the manager drops exactly its own entry.
    private var cleanupUndoTokens: [UUID: CleanupUndoToken] = [:]
    private var cleanupToastTask: Task<Void, Never>?

    public static let cleanupUndoDepth = 20
    public static let cleanupToastSeconds: Double = 8
    /// An override the ledger never confirmed (an older daemon) is dropped after this.
    public static let chainOverrideTTL: TimeInterval = 15

    public func ledgerSearch(_ query: String, limit: Int = 50) async -> [LedgerHit]? { await ledgerSearchHandler(query, limit) }

    /// Runs one cleanup action: its commands go out, the overlay shows the result at once,
    /// the inverse is remembered (the stack and the window's undo manager) and the toast
    /// offers Undo. The Jarhead list is re-read after the engine has appended its row.
    public func performCleanup(_ action: CleanupAction, toast: Bool = true) {
        for cmd in action.commands { send(cmd) }
        applyCleanup(action, forward: true)
        cleanupUndoStack.append(action)
        if cleanupUndoStack.count > AppState.cleanupUndoDepth {
            let dropped = cleanupUndoStack.prefix(cleanupUndoStack.count - AppState.cleanupUndoDepth)
            cleanupUndoStack.removeFirst(dropped.count)
            // Past the depth: gone from Edit › Undo too (the manager's own stack has no cap).
            for old in dropped { dropCleanupUndo(old.id) }
        }
        cleanupRedoStack.removeAll()
        if !action.inverse.isEmpty, let um = cleanupUndoManager() {
            registerCleanupUndo(action, on: um, redo: false)
        }
        if toast { showCleanupToast(action) } else if cleanupToast != nil { cleanupToast = nil }
        if action.refreshesJarhead { refreshJarheadAfterCleanup() }
    }

    /// Undo the newest action (Edit › Undo, ⌘Z).
    public func undoCleanup() {
        if let last = cleanupUndoStack.last { undoCleanup(id: last.id) }
    }

    /// Undo one action wherever it sits in the stack (the toast's Undo may come after a
    /// later action; the actions are independent, so out of order is fine).
    ///
    /// When the window's undo manager is not the one calling (the toast's Undo) and its top
    /// entry is this very action, the manager is asked to undo instead, so its stacks stay
    /// true: ⌘Z next undoes the action before this one, ⇧⌘Z redoes this one. Registering a
    /// redo closure from outside `um.undo()` would land it on the UNDO stack on top of the
    /// still-registered original — Edit › Undo would then re-perform the action.
    public func undoCleanup(id: UUID) {
        guard let index = cleanupUndoStack.firstIndex(where: { $0.id == id }) else { return }
        let um = cleanupUndoManager()
        if let um, !um.isUndoing, !um.isRedoing, cleanupUndoStack.last?.id == id, cleanupUndoTokens[id] != nil,
           um.canUndo, um.undoActionName == cleanupUndoStack[index].label {
            um.undo()
            return
        }
        let action = cleanupUndoStack.remove(at: index)
        guard !action.inverse.isEmpty else { return }
        for cmd in action.inverse { send(cmd) }
        applyCleanup(action, forward: false)
        cleanupRedoStack.append(action)
        if cleanupRedoStack.count > AppState.cleanupUndoDepth { cleanupRedoStack.removeFirst(cleanupRedoStack.count - AppState.cleanupUndoDepth) }
        if let um {
            if um.isUndoing {
                // The manager is driving: its redo is this action again.
                registerCleanupUndo(action, on: um, redo: true)
            } else {
                // Undone outside the manager (the toast, out of order): its entry there is stale.
                dropCleanupUndo(action.id, on: um)
            }
        }
        if cleanupToast?.id == action.id { cleanupToast = nil }
        if action.refreshesJarhead { refreshJarheadAfterCleanup() }
    }

    public func redoCleanup() {
        if let last = cleanupRedoStack.last { redoCleanup(id: last.id) }
    }

    public func redoCleanup(id: UUID) {
        guard let index = cleanupRedoStack.firstIndex(where: { $0.id == id }) else { return }
        let action = cleanupRedoStack.remove(at: index)
        for cmd in action.commands { send(cmd) }
        applyCleanup(action, forward: true)
        cleanupUndoStack.append(action)
        if let um = cleanupUndoManager() {
            // Redone by the manager (⇧⌘Z): its undo goes back on. Redone from elsewhere: whatever
            // the manager still held for it is stale first, then it is a fresh do.
            if !um.isRedoing { dropCleanupUndo(action.id, on: um) }
            registerCleanupUndo(action, on: um, redo: false)
        }
        if action.refreshesJarhead { refreshJarheadAfterCleanup() }
    }

    /// One registration on the window's undo manager, with the action's own token as the
    /// target (`CleanupUndoToken`), so `dropCleanupUndo` can remove exactly this action's entries.
    private func registerCleanupUndo(_ action: CleanupAction, on um: UndoManager, redo: Bool) {
        let token = cleanupUndoTokens[action.id] ?? CleanupUndoToken(actionId: action.id, state: self)
        cleanupUndoTokens[action.id] = token
        if redo {
            um.registerUndo(withTarget: token) { t in MainActor.assumeIsolated { t.state?.redoCleanup(id: t.actionId) } }
        } else {
            um.registerUndo(withTarget: token) { t in MainActor.assumeIsolated { t.state?.undoCleanup(id: t.actionId) } }
        }
        um.setActionName(action.label)
    }

    /// Forgets the action on the manager (both of its stacks) and lets its token go.
    private func dropCleanupUndo(_ id: UUID, on um: UndoManager? = nil) {
        guard let token = cleanupUndoTokens.removeValue(forKey: id) else { return }
        (um ?? cleanupUndoManager())?.removeAllActions(withTarget: token)
    }

    /// The overlay after (or before) an action: chain rows, hidden agents, the cleared Now.
    private func applyCleanup(_ action: CleanupAction, forward: Bool) {
        let now = Date()
        for (id, o) in (forward ? action.chainAfter : action.chainBefore) {
            var next = chainOverrides[id]?.merged(o) ?? o
            next.at = now
            chainOverrides[id] = next
        }
        for (id, hidden) in (forward ? action.agentsAfter : action.agentsBefore) { hiddenAgentOverrides[id] = hidden }
        if let mark = forward ? action.nowAfter : action.nowBefore {
            switch mark {
            case .cleared(let at): nowClearedAt = at
            case .restored: nowClearedAt = nil
            }
        }
    }

    private func showCleanupToast(_ action: CleanupAction) {
        let toast = CleanupToast(id: action.id, text: action.toast, symbol: action.symbol, canUndo: !action.inverse.isEmpty)
        cleanupToast = toast
        cleanupToastTask?.cancel()
        cleanupToastTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(AppState.cleanupToastSeconds * 1_000_000_000))
            guard !Task.isCancelled, let self, self.cleanupToast?.id == toast.id else { return }
            self.cleanupToast = nil
        }
    }

    public func dismissCleanupToast() {
        cleanupToastTask?.cancel()
        cleanupToast = nil
    }

    /// Two reads: one after the engine's row has landed, one for a slow event loop
    /// (the same reasoning as `jarheadSessionsRefreshDelaysMs`, shorter — no server round trip).
    private func refreshJarheadAfterCleanup() {
        refreshJarheadSessions(delayMs: 120)
        refreshJarheadSessions(delayMs: 900)
    }

    /// Drops every override the ledger's list now agrees with, and any older than the TTL.
    public func pruneChainOverrides(against list: [JarheadSessionSummary]) {
        guard !chainOverrides.isEmpty else { return }
        let now = Date()
        var byId: [String: JarheadSessionSummary] = [:]
        for s in list where byId[s.id] == nil { byId[s.id] = s }
        for (id, o) in chainOverrides {
            if now.timeIntervalSince(o.at) > AppState.chainOverrideTTL { chainOverrides[id] = nil; continue }
            if let s = byId[id], o.agrees(with: s) { chainOverrides[id] = nil }
        }
    }

    /// Hidden agents as the rail shows them: the snapshot's list with Kevin's latest clicks on top.
    public func hiddenAgentIds(in snap: Snapshot) -> Set<String> {
        var out = Set(snap.hiddenAgents ?? [])
        for (id, hidden) in hiddenAgentOverrides {
            if hidden { out.insert(id) } else { out.remove(id) }
        }
        return out
    }

    /// Drops the overrides the snapshot now agrees with.
    public func pruneHiddenAgentOverrides(_ snap: Snapshot) {
        guard !hiddenAgentOverrides.isEmpty else { return }
        let hidden = Set(snap.hiddenAgents ?? [])
        for (id, on) in hiddenAgentOverrides where hidden.contains(id) == on { hiddenAgentOverrides[id] = nil }
    }

    // Convenience views over the snapshot.
    public var phase: Phase { snapshot.phase }
    public var lastKevin: TranscriptItem? { snapshot.transcript.last { $0.speaker == .kevin } }
    public var lastJarhead: TranscriptItem? { snapshot.transcript.last { $0.speaker == .jarhead } }
    public var activeDelegation: Delegation? { snapshot.delegations.last { $0.status == .running || $0.status == .awaitingConfirmation } }
    public var isAwake: Bool { snapshot.phase != .asleep && snapshot.phase != .error }
}

// MARK: - Cleanup (types)

/// One undoable cleanup action: the commands that do it, the commands that undo it, and
/// what the rail shows meanwhile. The UI builds these (`CleanupAction.trash(_:)` …); the
/// state only runs and remembers them.
public struct CleanupAction: Identifiable, Equatable {
    public var id = UUID()
    /// Edit › Undo's word: "Move to Trash", "Archive", "Restore", "Rename", "Pin", "Clear", "Hide".
    public var label: String
    /// The toast's line: "Moved to Trash", "Moved 3 to Trash", "Cleared".
    public var toast: String
    /// The toast's solid symbol.
    public var symbol: String
    public var commands: [EngineCommand]
    /// Empty when the action cannot be undone (a sweep, a new conversation): no Undo is offered.
    public var inverse: [EngineCommand]
    /// The rail's overlay after the action (chain id → state / name / pinned) and after its undo.
    public var chainAfter: [String: ChainOverride] = [:]
    public var chainBefore: [String: ChainOverride] = [:]
    /// Hidden agents after the action and after its undo (agent id → hidden).
    public var agentsAfter: [String: Bool] = [:]
    public var agentsBefore: [String: Bool] = [:]
    /// The Now stream's cleared mark after the action and after its undo.
    public var nowAfter: NowMark?
    public var nowBefore: NowMark?
    /// Re-read the Jarhead list after the engine appended its row (every conversation action).
    public var refreshesJarhead = true
    public var at = Date()

    public init(label: String, toast: String, symbol: String, commands: [EngineCommand], inverse: [EngineCommand]) {
        self.label = label; self.toast = toast; self.symbol = symbol; self.commands = commands; self.inverse = inverse
    }
}

public enum NowMark: Equatable {
    case cleared(Double)
    case restored
}

/// The toast under the header: one line, Undo while the action can be undone, ×.
public struct CleanupToast: Identifiable, Equatable {
    public var id: UUID
    public var text: String
    public var symbol: String
    public var canUndo: Bool
    public init(id: UUID, text: String, symbol: String, canUndo: Bool) {
        self.id = id; self.text = text; self.symbol = symbol; self.canUndo = canUndo
    }
}

/// The undo manager's target for one cleanup action. The manager holds targets weakly and
/// forgets by target (`removeAllActions(withTarget:)`), so a token per action lets an action
/// undone outside the manager (the toast's Undo) drop its own entry and no other's.
final class CleanupUndoToken: NSObject {
    let actionId: UUID
    weak var state: AppState?
    init(actionId: UUID, state: AppState) {
        self.actionId = actionId
        self.state = state
    }
}

/// What a chain looks like before the ledger confirms it: a field left nil is unchanged.
public struct ChainOverride: Equatable {
    /// "active" | "archived" | "trashed".
    public var state: String?
    /// Kevin's name; "" is back to the auto title.
    public var name: String?
    public var pinned: Bool?
    public var at = Date()

    public init(state: String? = nil, name: String? = nil, pinned: Bool? = nil) {
        self.state = state; self.name = name; self.pinned = pinned
    }

    public func merged(_ other: ChainOverride) -> ChainOverride {
        var o = self
        if let s = other.state { o.state = s }
        if let n = other.name { o.name = n }
        if let p = other.pinned { o.pinned = p }
        o.at = other.at
        return o
    }

    /// The ledger's summary says what this override says.
    public func agrees(with s: JarheadSessionSummary) -> Bool {
        if let state, (s.state ?? "active") != state { return false }
        if let name, (s.name ?? "") != name { return false }
        if let pinned, (s.pinned ?? false) != pinned { return false }
        return true
    }
}

/// One full-text hit from `ledger.search` (`ledger.hits`), decoded loosely: a row's
/// session, when, what kind of row, who spoke, and the snippet.
public struct LedgerHit: Identifiable, Equatable {
    public var sessionId: String
    /// The chain the daemon resolved it to, when it did.
    public var chainId: String?
    public var at: Double
    /// heard | said | request | summary (the ledger's `SearchHitKind`), or whatever else a daemon sends.
    public var type: String
    /// kevin | jarhead, for heard / said rows.
    public var speaker: String?
    public var text: String
    public var day: String?
    public var id: String { "\(sessionId):\(type):\(at)" }

    public init(sessionId: String, chainId: String? = nil, at: Double, type: String, speaker: String? = nil, text: String, day: String? = nil) {
        self.sessionId = sessionId; self.chainId = chainId; self.at = at; self.type = type; self.speaker = speaker; self.text = text; self.day = day
    }

    /// The wire's hit (`LedgerSearchHit`: sessionId, chainId, at, kind, text), read loosely so a
    /// spelling that drifts (`type` for `kind`, `snippet` for `text`, `session`) still lands.
    public init?(json o: [String: Any]) {
        guard let sessionId = (o["sessionId"] as? String) ?? (o["session"] as? String), !sessionId.isEmpty else { return nil }
        guard let at = (o["at"] as? NSNumber)?.doubleValue, at.isFinite else { return nil }
        let text = (o["text"] as? String) ?? (o["snippet"] as? String) ?? (o["request"] as? String) ?? ""
        let kind = (o["kind"] as? String) ?? (o["type"] as? String) ?? "row"
        let speaker = (o["speaker"] as? String) ?? (kind == "heard" ? "kevin" : (kind == "said" ? "jarhead" : nil))
        self.init(sessionId: sessionId, chainId: o["chainId"] as? String, at: at, type: kind, speaker: speaker, text: text, day: o["day"] as? String)
    }
}

/// What the last crash report says, for the rail and the menu (AppState.lastCrash).
public struct CrashNotice: Equatable {
    /// When the report was written.
    public var at: Date
    /// The report's `reason:` line: the exception name and reason, or the signal.
    public var reason: String
    public var fileURL: URL
    /// The guard relaunched the app after it (false past the three-in-ten-minutes cap).
    public var relaunched: Bool

    public init(at: Date, reason: String, fileURL: URL, relaunched: Bool) {
        self.at = at; self.reason = reason; self.fileURL = fileURL; self.relaunched = relaunched
    }

    /// "just now", "40 s ago", "2 min ago", "3 h ago".
    public static func ago(_ at: Date, now: Date = Date()) -> String {
        let s = Int(max(0, now.timeIntervalSince(at)))
        if s < 5 { return "just now" }
        if s < 60 { return "\(s) s ago" }
        if s < 3600 { return "\(s / 60) min ago" }
        return "\(s / 3600) h ago"
    }

    /// The one line: "Crashed 2 min ago · Failed to create tap due to format mismatch".
    public func line(now: Date = Date()) -> String {
        "Crashed \(CrashNotice.ago(at, now: now)) · \(reason)"
    }
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
