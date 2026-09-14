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
    /// daemon client replaces, appends or prepends as `agent.transcript` events arrive.
    @Published public var transcripts: [String: AgentTranscript] = [:]
    /// Message id → its absolute position in that agent's feed, so an append upserts in
    /// O(1) however long a conversation runs (it used to rebuild the whole map per delta).
    /// The array index is `position - transcriptBase[agentId]`: a front-trim moves the
    /// base and forgets the trimmed ids instead of renumbering everything kept.
    public private(set) var transcriptIndex: [String: [String: Int]] = [:]
    private var transcriptBase: [String: Int] = [:]
    /// The ids a front-trim dropped, per agent (the newest 8 192 — the connector's `offsetOf`
    /// bound). The engine re-sends a message when it changes — a call gaining its output, or
    /// `settle` marking every still-running call `interrupted` when the agent ends — and one
    /// older than the held rows has no index entry: without this it landed as the newest row,
    /// out of order. It belongs above the fold; a later prepend brings it back as it is now.
    private var trimmedIds: [String: TrimmedIds] = [:]
    /// How many rows `prepend` has added since the last whole page, per agent (unset when
    /// none). Kevin asked for those, so the cap grows by as many: the model holds at most
    /// `maxTranscriptMessages + prependedCount[agentId]` rows, an upsert of the newest tool call
    /// no longer throws his page away, and as the conversation grows the window slides from the
    /// front one row per new row (the feed stays contiguous — a trim anywhere else would leave
    /// an invisible gap). A view that keeps its own ceiling must show at least that many rows,
    /// or the loaded page sits above the fold and the next "Load earlier" re-sends the same
    /// `before` id (a no-op). Not `@Published`: it only ever changes with `transcripts`, which is.
    public private(set) var prependedCount: [String: Int] = [:]
    /// The newest messages a pane keeps. A Console left open on a live session for hours
    /// used to grow without bound and lay out every row on every delta (40–95 % CPU on the
    /// main thread); past the cap the oldest go, `complete` turns false, and "Load earlier"
    /// brings them back on request (`prepend` is Kevin asking, so it is never trimmed and
    /// raises the cap by what it added — see `prependedCount`).
    public nonisolated static let maxTranscriptMessages = 400
    /// The agents whose conversations were opened, oldest first; `evictTranscripts` keeps the
    /// newest `threadStoreLRU` of them and whatever a pane still shows.
    var transcriptRecency: [String] = []
    /// Mark mode (Kevin circles something on screen). Installed by the app.
    public var beginMarkModeHandler: () -> Void = {}
    public func beginMarkMode() { beginMarkModeHandler() }
    /// Mark mode is on: every overlay window takes the stroke. Set by OverlayManager.beginMarkMode
    /// (true, before ctl.begin()) and MarkModeController.end (false). Read by the dock to fold and
    /// to read "Circle something · Esc".
    @Published public var marking: Bool = false
    /// Fired by OverlayManager.commitMark right after send(.markAdd). The dock's Ask uses it to send
    /// the question after the mark (same socket, in order: the engine registers the mark before
    /// any await).
    public let markCommitted = PassthroughSubject<Void, Never>()
    /// The × on one circled thumbnail; the engine ignores an id it does not hold.
    public func markRemove(_ id: String) { send(.markRemove(id: id)) }
    /// The notch's Window box: the front window as a mark, whole. Works asleep.
    public func markWindow() { send(.markWindow) }

    // MARK: threads

    /// Every thread the engine has told us about — live, and finished within
    /// `threadLingerMs` — by id, O(1) (`thread.event` deltas patch one; `snapshot.threads`
    /// replaces what it lists). `threadOrder` is the ids as they arrived, so a row keeps its
    /// place while its status turns; `AppState.railOrder` is the rail's own sort.
    @Published public var threads: [String: WorkThread] = [:]
    @Published public var threadOrder: [String] = []
    /// The conversations the Console has opened (`thread.open`), keyed by thread id
    /// (Model/ThreadStore.swift: the seq-indexed pages, steps patched into their cards).
    @Published public var threadStores: [String: ThreadStore] = [:]
    /// The newest event seq applied per thread (a replay is dropped). On the main actor.
    var threadLastSeq: [String: Int] = [:]
    /// Ids a snapshot has listed at least once: only these can be "gone" from a later one (a
    /// thread known from its `started` event alone may simply postdate the snapshot in hand).
    var threadsSeenInSnapshot: Set<String> = []
    /// Ids we settled `failed · gone from the engine` ourselves: the next snapshot that lists one wins outright.
    var threadsGone: Set<String> = []
    var threadPruneTask: Task<Void, Never>?
    /// The threads whose conversation was opened, oldest first (the LRU for `evictThreadStores`).
    var threadStoreRecency: [String] = []
    /// Ids the Console is looking at right now: a finished thread on screen is never pruned under Kevin.
    public var heldThreadIds: Set<String> = []
    /// Opens a thread's Console pane (a satellite blob's click). Installed by the app (AppDelegate:
    /// `state.openThreadHandler = { id in console.openThread(id) }`, beside `openConsoleHandler`).
    public var openThreadHandler: (String) -> Void = { _ in }

    /// Called by the daemon client for every `agent.transcript` event.
    ///
    /// `replace` is a whole page (the first open, a re-open after the file was replaced).
    /// `append` upserts by id: the engine re-sends a message when it changes (a tool call
    /// gains its output and status, an assistant turn gains a later block); `live` is the
    /// engine's word on whether it still follows the file. `prepend` is an older page from
    /// `agent.history`: inserted in front of what is held, deduplicated by id (a message we
    /// already hold keeps our copy — the older page's parser may have seen it torn), and
    /// `complete` comes from the page (the last page reaches the first message and says
    /// so). The old "an older page is a replace whose last message is older than our first"
    /// guess is gone: `at` is not monotonic in these files, and a wrong guess replaced the
    /// newest 60 with the oldest 60.
    public func applyTranscript(_ t: AgentTranscript, mode: String) {
        let agentId = t.agentId
        switch mode {
        case "append":
            // Taken out of the dictionary while it is edited so the messages array stays
            // uniquely referenced: an edit through a copy would duplicate 400 rows per delta.
            guard var existing = transcripts.removeValue(forKey: agentId) else {
                replaceTranscript(t)
                return
            }
            // The side tables too: read out of the dictionary, an edit would clone the 400-entry
            // index and the 8 192-id trimmed set on every delta (that alone was ~1 s per 20 000).
            var index = transcriptIndex.removeValue(forKey: agentId) ?? [:]
            var base = transcriptBase[agentId] ?? 0
            var trimmed = trimmedIds.removeValue(forKey: agentId) ?? TrimmedIds()
            for m in t.messages {
                if let position = index[m.id], position - base >= 0, position - base < existing.messages.count {
                    existing.messages[position - base] = m
                } else if trimmed.contains(m.id) {
                    // Above the fold (trimmed earlier): not the newest row, whatever changed in it.
                    continue
                } else {
                    // A pending echo (ours or the engine's) with the words of one already pending is
                    // the same send twice; the real user turn that lands drops the echo it confirms.
                    let words = m.text.trimmingCharacters(in: .whitespacesAndNewlines)
                    if m.pending == true {
                        if AppState.hasPendingEcho(existing.messages, words: words) { continue }
                    } else if m.role == .user {
                        AppState.dropPendingEcho(&existing.messages, index: &index, base: base, words: words)
                    }
                    index[m.id] = base + existing.messages.count
                    existing.messages.append(m)
                }
            }
            existing.total = max(existing.total, t.total)
            existing.live = t.live
            existing.cursor = AppState.mergedCursor(existing.cursor, t.cursor)
            base = AppState.trimFront(&existing, index: &index, trimmed: &trimmed,
                                      cap: AppState.maxTranscriptMessages + (prependedCount[agentId] ?? 0), base: base)
            transcriptIndex[agentId] = index
            transcriptBase[agentId] = base
            trimmedIds[agentId] = trimmed
            transcripts[agentId] = existing
        case "prepend":
            guard var existing = transcripts.removeValue(forKey: agentId), !existing.messages.isEmpty else {
                replaceTranscript(t)
                return
            }
            var index = transcriptIndex.removeValue(forKey: agentId) ?? [:]
            var base = transcriptBase[agentId] ?? 0
            // Only what we do not hold, in the page's own order (oldest first), once each.
            var fresh: [AgentMessage] = []
            fresh.reserveCapacity(t.messages.count)
            var seen = Set<String>()
            for m in t.messages where index[m.id] == nil && !seen.contains(m.id) {
                seen.insert(m.id)
                fresh.append(m)
            }
            base -= fresh.count
            for (i, m) in fresh.enumerated() { index[m.id] = base + i }
            existing.messages.insert(contentsOf: fresh, at: 0)
            existing.complete = t.complete
            existing.total = max(existing.total, t.total)
            existing.cursor = AppState.mergedCursor(existing.cursor, t.cursor)
            // Kevin asked for the page: it is held whole, and the cap grows by it.
            prependedCount[agentId] = (prependedCount[agentId] ?? 0) + fresh.count
            transcriptIndex[agentId] = index
            transcriptBase[agentId] = base
            transcripts[agentId] = existing
        default:
            replaceTranscript(t)
        }
    }

    /// A pending echo with these words sits among the newest rows.
    static func hasPendingEcho(_ messages: [AgentMessage], words: String) -> Bool {
        messages.suffix(pendingEchoWindow).contains { $0.pending == true && $0.text.trimmingCharacters(in: .whitespacesAndNewlines) == words }
    }

    /// Drops the pending echoes with these words from the newest rows. Removing from the middle
    /// shifts what follows, so the index is renumbered from the first drop — a short tail: an
    /// echo is never older than the few rows since Kevin pressed Send.
    static func dropPendingEcho(_ messages: inout [AgentMessage], index: inout [String: Int], base: Int, words: String) {
        let from = max(0, messages.count - pendingEchoWindow)
        var first: Int?
        var i = from
        while i < messages.count {
            let m = messages[i]
            if m.pending == true, m.text.trimmingCharacters(in: .whitespacesAndNewlines) == words {
                index[m.id] = nil
                messages.remove(at: i)
                if first == nil { first = i }
            } else {
                i += 1
            }
        }
        guard let first else { return }
        for j in first..<messages.count { index[messages[j].id] = base + j }
    }

    /// A message Kevin just sent into an agent's conversation, shown at once as a pending row
    /// (0.6 opacity, `clock.fill`) before the tool's own file confirms it (EngineClient.send
    /// calls this for every `agent.send`). Dropped when the real user turn with the same words
    /// lands; a second echo with the same words while one is pending is skipped. Nothing here
    /// sends — the command goes its own way. No conversation held (the pane is not open): nothing to show.
    public func echoPendingSend(agentId: String, text: String, at: Double) {
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !words.isEmpty, var existing = transcripts.removeValue(forKey: agentId) else { return }
        defer { transcripts[agentId] = existing }
        if AppState.hasPendingEcho(existing.messages, words: words) { return }
        var index = transcriptIndex.removeValue(forKey: agentId) ?? [:]
        let base = transcriptBase[agentId] ?? 0
        let m = AgentMessage(id: "pending:\(UUID().uuidString)", role: .user, text: text, at: at, tool: nil, thinking: nil, pending: true)
        index[m.id] = base + existing.messages.count
        existing.messages.append(m)
        transcriptIndex[agentId] = index
    }

    /// How many of the newest rows a pending echo is looked for in (≤ 4 pending per agent, all recent).
    public static let pendingEchoWindow = 8
    /// After this long a queued echo reads "not picked up yet" (the pane's timer; nothing here).
    public static let pendingEchoStaleMs: Double = 20_000

    /// A pane opened this agent's conversation: newest in the LRU.
    public func noteTranscriptOpened(_ agentId: String) {
        transcriptRecency.removeAll { $0 == agentId }
        transcriptRecency.append(agentId)
    }

    /// Drops the conversations no pane shows, past the newest `threadStoreLRU` opened. Entries
    /// used to stay for every agent ever visited (bounded per agent at 400, unbounded across them).
    public func evictTranscripts(keep: Set<String>) {
        let recent = Set(transcriptRecency.suffix(AppState.threadStoreLRU))
        for id in transcripts.keys where !keep.contains(id) && !recent.contains(id) {
            transcripts[id] = nil
            transcriptIndex[id] = nil
            transcriptBase[id] = nil
            trimmedIds[id] = nil
            prependedCount[id] = nil
        }
    }

    /// The array index of a message in `transcripts[agentId].messages`, or nil.
    public func messageIndex(agentId: String, id: String) -> Int? {
        guard let position = transcriptIndex[agentId]?[id] else { return nil }
        let i = position - (transcriptBase[agentId] ?? 0)
        guard i >= 0, i < (transcripts[agentId]?.messages.count ?? 0) else { return nil }
        return i
    }

    /// A whole page: the map is rebuilt once, the base returns to 0, the cap applies, and
    /// what was trimmed or loaded before is forgotten with the rows it described.
    private func replaceTranscript(_ t: AgentTranscript) {
        var next = t
        var index: [String: Int] = [:]
        index.reserveCapacity(min(next.messages.count, AppState.maxTranscriptMessages))
        for (i, m) in next.messages.enumerated() { index[m.id] = i }
        var trimmed = TrimmedIds()
        let base = AppState.trimFront(&next, index: &index, trimmed: &trimmed, cap: AppState.maxTranscriptMessages, base: 0)
        transcriptIndex[t.agentId] = index
        transcriptBase[t.agentId] = base
        trimmedIds[t.agentId] = trimmed
        prependedCount[t.agentId] = nil
        transcripts[t.agentId] = next
    }

    /// Drops the oldest past `cap` (`maxTranscriptMessages`, plus what Kevin loaded); the base
    /// moves by as many, their ids leave the map and enter `trimmed`, and `complete` turns
    /// false (there is more before what is held). Always the front: the held rows stay one
    /// contiguous span of the file.
    private static func trimFront(_ t: inout AgentTranscript, index: inout [String: Int], trimmed: inout TrimmedIds, cap: Int, base: Int) -> Int {
        let excess = t.messages.count - cap
        guard excess > 0 else { return base }
        for m in t.messages.prefix(excess) {
            index[m.id] = nil
            trimmed.insert(m.id)
        }
        t.messages.removeFirst(excess)
        t.complete = false
        return base + excess
    }

    /// A bounded set of message ids with first-in-first-out eviction: the ring names the
    /// order, the set answers `contains` in O(1). An id already held is not re-entered, so
    /// the ring holds `capacity` distinct ids and the set never loses one still in a slot.
    struct TrimmedIds {
        static let capacity = 8_192
        private var ring: [String] = []
        private var next = 0
        private var held = Set<String>()

        init() {}
        var count: Int { held.count }
        func contains(_ id: String) -> Bool { held.contains(id) }
        mutating func insert(_ id: String) {
            guard !held.contains(id) else { return }
            if ring.count < TrimmedIds.capacity {
                ring.append(id)
            } else {
                held.remove(ring[next])
                ring[next] = id
            }
            next = (next + 1) % TrimmedIds.capacity
            held.insert(id)
        }
    }

    /// The byte span the held messages came from: a prepend widens the start, an append the end.
    private static func mergedCursor(_ a: AgentTranscript.TranscriptCursor?, _ b: AgentTranscript.TranscriptCursor?) -> AgentTranscript.TranscriptCursor? {
        guard let a else { return b }
        guard let b else { return a }
        return AgentTranscript.TranscriptCursor(startOffset: min(a.startOffset, b.startOffset), endOffset: max(a.endOffset, b.endOffset))
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

    /// A whole chain's rows in one request (`ledger.chain`; the daemon's Ledger.readChain
    /// keeps the newest CHAIN_ROWS_MAX). nil is no answer — a daemon from before the message
    /// — and the Console falls back to one `jarheadSessionRows` per member. Installed by the app.
    public var jarheadChainRowsHandler: (String) async -> JarheadChainRows? = { _ in nil }

    /// One session's rows, its `session.started` row through its `session.closed` row.
    public func jarheadSessionRows(_ id: String) async -> [LedgerRow] { await jarheadSessionRowsHandler(id) }
    /// Every row of the chain rooted at `rootId`, oldest first; nil when nothing answered.
    public func jarheadChainRows(_ rootId: String) async -> JarheadChainRows? { await jarheadChainRowsHandler(rootId) }

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

    /// The daemon client's requests (the list, one session's rows, and — when the client has
    /// it — a whole chain in one read), and the watch that refreshes the list when the
    /// snapshot's session id changes or the phase becomes asleep / paused.
    public func installJarheadSessions(list: @escaping () async -> [JarheadSessionSummary], rows: @escaping (String) async -> [LedgerRow],
                                       chain: ((String) async -> JarheadChainRows?)? = nil) {
        jarheadSessionsHandler = list
        jarheadSessionRowsHandler = rows
        if let chain { jarheadChainRowsHandler = chain }
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

    // MARK: - Memory

    // What Jarhead remembers about Kevin across sessions (@jarhead/memory). The snapshot
    // carries only counts (`snapshot.memory`); the items' text is read on request through the
    // daemon (`memory.list` / `memory.search`) and never a vector. Forget and Restore are
    // states the engine keeps — nothing here deletes anything.

    /// The Memory rail's rows as last listed or searched; [] until the first read.
    @Published public var memoryItems: [MemoryItem] = []
    /// Installed by the app (AppDelegate). `state` is live | forgotten | merged | archived | all.
    /// nil is no answer (a daemon from before memory, or a disconnect); [] is an empty store.
    public var memoryListHandler: (String, Int) async -> [MemoryItem]? = { _, _ in nil } {
        didSet { memoryInstalled = true }
    }
    public var memorySearchHandler: (String, Int) async -> [MemoryItem]? = { _, _ in nil } {
        didSet { memoryInstalled = true }
    }
    /// Whether anything installed the handlers: false is this build's gap, not the daemon's.
    public private(set) var memoryInstalled = false

    public func memoryList(state: String = "live", limit: Int = 50) async -> [MemoryItem]? { await memoryListHandler(state, limit) }
    public func memorySearch(_ query: String, limit: Int = 30) async -> [MemoryItem]? { await memorySearchHandler(query, limit) }

    // The verbs, as commands: the engine changes the state and the next snapshot's counts say so.
    public func memoryForget(_ id: String) { send(.memoryForget(id: id)) }
    public func memoryRestore(_ id: String) { send(.memoryRestore(id: id)) }
    public func memoryEdit(_ id: String, text: String, kind: String? = nil) { send(.memoryEdit(id: id, text: text, kind: kind)) }
    public func memoryAdd(_ text: String, kind: String? = nil) { send(.memoryAdd(text: text, kind: kind)) }
    /// "Learn now": one extraction run over what closed since the last one (never a Codex turn).
    public func memoryRun() { send(.memoryRun) }

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
    /// An override the ledger never confirmed (the row never came back over the socket) is dropped after this.
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

extension ThreadStatus {
    /// The status as Kevin reads it, everywhere a thread is drawn: the rail row, the pane's
    /// header, the card's chip, the ledger's line. One vocabulary for every surface (the notch
    /// and the satellite blobs read the same words); the two waits say what is being waited for.
    public var words: String {
        switch self {
        case .idle: return "idle"
        case .queued: return "queued"
        case .starting: return "starting"
        case .thinking: return "thinking"
        case .acting: return "acting"
        case .waitingScreen: return "waiting for the screen"
        case .waitingKevin: return "waiting for Kevin"
        case .paused: return "paused"
        case .done: return "done"
        case .failed: return "failed"
        case .stopped: return "stopped"
        }
    }
}

// MARK: - Sleep

/// The sleep row's words, once, for every surface: the stream's tombstone, the log line, a
/// session's close reason. The engine records a `SleepCause` ("dock", "pause-decayed"); Kevin
/// reads why it slept.
public enum SleepCauseFormat {
    /// "said" → "said", "dock" → "dropped in the dock", "shutdown" → "quit"; a cause this
    /// build does not know is kept as recorded rather than guessed at.
    public static func words(_ cause: String) -> String {
        switch cause {
        case "said": return "said"
        case "idle": return "idle"
        case "dock": return "dropped in the dock"
        case "pause-decayed": return "pause decayed"
        case "brain-changed": return "brain changed"
        case "command": return "sleep command"
        case "stop": return "stopped"
        case "shutdown": return "quit"
        default: return cause
        }
    }

    /// "asleep · dropped in the dock"
    public static func line(_ cause: String) -> String { "asleep · " + words(cause) }

    /// The engine's close label for a sleep, "sleep:<cause>" (Engine.fallAsleep → closeWithDeadline),
    /// → its cause; a bare "sleep" is the command; nil for any other reason.
    public static func cause(fromCloseReason reason: String) -> String? {
        if reason == "sleep" { return "command" }
        guard reason.hasPrefix("sleep:") else { return nil }
        let cause = String(reason.dropFirst("sleep:".count))
        return cause.isEmpty ? "command" : cause
    }
}

extension LedgerRow {
    /// A `sleep` row's cause; nil for any other row. A row whose cause is absent or empty is the command.
    public var sleepCause: String? {
        guard type == "sleep" else { return nil }
        guard let cause, !cause.isEmpty else { return "command" }
        return cause
    }
    /// A `sleep` row's spoken cue in quotes — “go to sleep” — when there was one.
    public var quotedPhrase: String? {
        guard let phrase = phrase?.trimmingCharacters(in: .whitespacesAndNewlines), !phrase.isEmpty else { return nil }
        return "“\(phrase)”"
    }
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
/// status and Dock menus, the hotkeys (⌥⇧Space, ⌥⎋) and the `jarhead://`
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

// MARK: - Jarhead chains (one read)

/// A whole chain's ledger rows (`ledger.chain` → `ledger.rows`), oldest first. `truncated`
/// says the daemon kept only the newest CHAIN_ROWS_MAX rows.
public struct JarheadChainRows {
    public var rows: [LedgerRow]
    public var truncated: Bool
    public init(rows: [LedgerRow], truncated: Bool) {
        self.rows = rows; self.truncated = truncated
    }

    /// An answer worth showing for a chain with `sessionCount` members. A daemon whose ledger
    /// has no `readChain` — or one whose 60-day walk missed the root — answers `{rows: [],
    /// truncated: false}`: non-nil, so a nil check alone would show an empty conversation.
    /// Empty rows for a chain that has sessions are not an answer; the Console reads them one
    /// session at a time instead. A chain with no members has nothing to read either way.
    public func covers(sessionCount: Int) -> Bool { !rows.isEmpty || sessionCount == 0 }
}

// MARK: - Liveness, derived

extension AgentTranscript {
    /// Following, and something can still arrive: the engine tails the file (`live`), the
    /// daemon is connected, and a process still owns the session. Derived at every read —
    /// never a latch — so a daemon restart, a dropped socket or an `ended` status turns the
    /// header dot off by itself. `live` alone used to be that latch: set on every append and
    /// cleared only by an engine event that a restarted daemon never sent, so the dot pulsed
    /// for hours over a conversation nothing was writing to.
    public func isLive(agent: AgentInfo, connected: Bool) -> Bool {
        guard live, connected else { return false }
        switch agent.status {
        case .working, .idle, .blocked: return true
        case .done, .ended, .unknown, .offline: return false
        }
    }

    /// The typing face (the pulsing dot, the last row's indicator): only while the
    /// lease-bounded status says working, so it cannot outlive 30 s of silence
    /// (packages/agents liveness.ts) or a daemon that is gone.
    public func typing(agent: AgentInfo, connected: Bool) -> Bool {
        isLive(agent: agent, connected: connected) && agent.status == .working
    }
}

extension Snapshot {
    /// Every utterance sealed. For the moment the daemon is gone (EngineClient republishes
    /// the last snapshot with the `daemon` row): nothing is being typed by an engine that is
    /// not there, so no caret may blink through the outage.
    public func finalisingTranscript() -> Snapshot {
        var s = self
        for i in s.transcript.indices where !s.transcript[i].final { s.transcript[i].final = true }
        return s
    }
}

#if DEBUG
// MARK: - Bench (debug builds; no XCTest target in apps/mac)

/// The AppState acceptance numbers, runnable from any harness compiled with `-D DEBUG`
/// (the console preview may call it; a scratch main with Model/*.swift is enough):
/// 20 000 append deltas keep 400 messages in under 200 ms; prepend deduplicates and keeps
/// order; `isLive` is false when disconnected or the agent ended; a daemon drop seals every
/// utterance; SettingsPatch carries language / accent / memory. One line per check, "ok" or
/// "FAIL" first; the timing line carries the measured milliseconds.
@MainActor
public enum AppStateBench {
    public static func run() -> [String] {
        var out: [String] = []
        func check(_ ok: Bool, _ what: String) { out.append((ok ? "ok   " : "FAIL ") + what) }

        // 1. 20 000 append deltas of one message each.
        let state = AppState()
        let agentId = "sessions:codex:bench"
        let deltas = 20_000
        func message(_ i: Int) -> AgentMessage {
            AgentMessage(id: "m\(i)", role: i % 3 == 0 ? .assistant : .tool, text: "line \(i) of a long conversation", at: 1_700_000_000_000 + Double(i) * 1_000,
                         tool: i % 3 == 0 ? nil : AgentToolCall(name: "Bash", input: "echo \(i)", output: "\(i)", status: .done), thinking: nil)
        }
        let page = AgentTranscript(agentId: agentId, messages: (0..<60).map(message), total: 60, complete: true, live: true,
                                   cursor: .init(startOffset: 0, endOffset: 60_000))
        let start = DispatchTime.now()
        state.applyTranscript(page, mode: "replace")
        for i in 60..<(60 + deltas) {
            let delta = AgentTranscript(agentId: agentId, messages: [message(i)], total: i + 1, complete: false, live: true,
                                        cursor: .init(startOffset: 0, endOffset: (i + 1) * 1_000))
            state.applyTranscript(delta, mode: "append")
        }
        let ms = Double(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1_000_000
        let held = state.transcripts[agentId]
        check(held?.messages.count == AppState.maxTranscriptMessages, "20 000 appends → \(held?.messages.count ?? -1) kept (cap \(AppState.maxTranscriptMessages))")
        check(ms < 200, String(format: "total apply %.1f ms (< 200)", ms))
        check(held?.messages.last?.id == "m\(60 + deltas - 1)", "newest message kept last")
        check(held?.complete == false, "complete is false after a trim")
        check(state.messageIndex(agentId: agentId, id: "m\(60 + deltas - 1)") == AppState.maxTranscriptMessages - 1, "index of the newest is the last slot")
        check(state.messageIndex(agentId: agentId, id: "m0") == nil, "a trimmed id is not in the index")
        check(state.transcriptIndex[agentId]?.count == AppState.maxTranscriptMessages, "index holds exactly the kept ids")
        check(held?.cursor?.endOffset == (60 + deltas) * 1_000, "cursor end widened by the appends")

        // 2. An append that re-sends a held message upserts in place.
        var changed = message(60 + deltas - 1)
        changed.text = "edited"
        state.applyTranscript(AgentTranscript(agentId: agentId, messages: [changed], total: 0, complete: false, live: true), mode: "append")
        check(state.transcripts[agentId]?.messages.count == AppState.maxTranscriptMessages && state.transcripts[agentId]?.messages.last?.text == "edited", "an upsert edits in place")

        // 2b. An append that re-sends a TRIMMED message (the agent ended: `settle` flips its
        // still-running call to interrupted, live:false) is skipped — not appended as the newest
        // row. The id must sit inside the trimmed set's bound (the newest 8 192 trimmed): the
        // last one trimmed does; m1 left the set long ago and would land as a new row by design.
        let lastTrimmed = 60 + deltas - AppState.maxTranscriptMessages - 1
        var settled = message(lastTrimmed)
        settled.tool = AgentToolCall(name: "Bash", input: "echo \(lastTrimmed)", output: nil, status: .interrupted)
        let newestBefore = state.transcripts[agentId]!.messages.last!.id
        state.applyTranscript(AgentTranscript(agentId: agentId, messages: [settled], total: 0, complete: false, live: false), mode: "append")
        check(state.transcripts[agentId]?.messages.count == AppState.maxTranscriptMessages, "a re-sent trimmed message is not appended (count \(state.transcripts[agentId]?.messages.count ?? -1))")
        check(state.transcripts[agentId]?.messages.last?.id == newestBefore, "…and the newest row is still the newest")
        check(state.messageIndex(agentId: agentId, id: "m\(lastTrimmed)") == nil, "…and it has no index entry")
        check(state.transcripts[agentId]?.live == false, "…while live follows the delta (the agent ended)")
        check(state.prependedCount[agentId] == nil, "nothing loaded yet: prependedCount is unset")

        // 3. Prepend: an older page, deduplicated, in order, complete from the page. Its rows
        // were trimmed in step 1: the page brings them back, and they count as loaded.
        let firstHeld = state.transcripts[agentId]!.messages.first!.id
        let older = (0..<5).map(message) + [state.transcripts[agentId]!.messages.first!] + [message(2)]
        state.applyTranscript(AgentTranscript(agentId: agentId, messages: older, total: 0, complete: true, live: true,
                                              cursor: .init(startOffset: 0, endOffset: 5_000)), mode: "prepend")
        let after = state.transcripts[agentId]!
        check(after.messages.prefix(5).map(\.id) == ["m0", "m1", "m2", "m3", "m4"], "prepend keeps the page's order")
        check(after.messages.count == AppState.maxTranscriptMessages + 5, "prepend adds only what was not held (dedupe: \(after.messages.count))")
        check(after.messages[5].id == firstHeld, "the held rows follow the prepended ones")
        check(after.complete == true, "complete comes from the page")
        check(after.live == false, "live is kept across a prepend (the page's live:true is not taken)")
        check(state.messageIndex(agentId: agentId, id: "m0") == 0 && state.messageIndex(agentId: agentId, id: firstHeld) == 5, "index follows the moved base")
        check(after.cursor?.startOffset == 0 && after.cursor?.endOffset == (60 + deltas) * 1_000, "cursor spans both pages")
        check(state.prependedCount[agentId] == 5, "prependedCount is the page's fresh rows (\(state.prependedCount[agentId] ?? -1))")
        check(after.messages.count <= AppState.maxTranscriptMessages + (state.prependedCount[agentId] ?? 0), "held ≤ cap + prependedCount: what a view ceiling must show")
        check(after.messages.first?.id == "m0", "the loaded page's first id is the held first id (the next Load-earlier's `before`)")

        // 3b. A brought-back row is a held row again: an append re-sending it upserts in place,
        // and an upsert (the newest tool call gaining output, say) does not trim the loaded page.
        var back = message(2)
        back.text = "brought back, then edited"
        state.applyTranscript(AgentTranscript(agentId: agentId, messages: [back], total: 0, complete: false, live: true), mode: "append")
        check(state.transcripts[agentId]?.messages[2].text == "brought back, then edited" && state.transcripts[agentId]?.messages.count == AppState.maxTranscriptMessages + 5,
              "a prepended row re-sent by an append upserts in place; the loaded page survives an upsert")

        // 3c. The window slides: a new row past the raised cap trims ONE from the front (m0),
        // the loaded count stands (the cap stays raised), the feed stays contiguous.
        state.applyTranscript(AgentTranscript(agentId: agentId, messages: [message(60 + deltas)], total: 0, complete: false, live: true), mode: "append")
        let slid = state.transcripts[agentId]!
        check(slid.messages.count == AppState.maxTranscriptMessages + 5, "a new row past the raised cap keeps cap + loaded rows (\(slid.messages.count))")
        check(slid.messages.first?.id == "m1" && state.messageIndex(agentId: agentId, id: "m0") == nil, "…the oldest loaded row went, the rest of the page stays (first \(slid.messages.first?.id ?? "-"))")
        check(slid.messages.last?.id == "m\(60 + deltas)", "…the new row is last")
        check(state.prependedCount[agentId] == 5 && slid.complete == false, "…prependedCount stands at 5, complete false (there is more before m1)")
        // A burst of ten: ten from the front — the loaded rows, then the tail's oldest — never a gap.
        state.applyTranscript(AgentTranscript(agentId: agentId, messages: (1...10).map { message(60 + deltas + $0) }, total: 0, complete: false, live: true), mode: "append")
        let burst = state.transcripts[agentId]!
        check(burst.messages.count == AppState.maxTranscriptMessages + 5 && burst.messages.first?.id == "m\(60 + deltas - AppState.maxTranscriptMessages + 6)",
              "a burst of 10 slides the window by 10 (first \(burst.messages.first?.id ?? "-"))")
        check(zip(burst.messages, burst.messages.dropFirst()).allSatisfy { Int($0.id.dropFirst())! + 1 == Int($1.id.dropFirst())! }, "…the held rows are one contiguous span")
        check(burst.messages.count <= AppState.maxTranscriptMessages + (state.prependedCount[agentId] ?? 0), "…held ≤ cap + prependedCount still")

        // 3d. A replace forgets what was trimmed and loaded: an id trimmed before the replace
        // (m5, below) is a new row again when the fresh page did not carry it.
        let fresh = AppState()
        fresh.applyTranscript(page, mode: "replace")
        fresh.applyTranscript(AgentTranscript(agentId: agentId, messages: (60..<(60 + AppState.maxTranscriptMessages)).map(message), total: 0, complete: false, live: true), mode: "append")
        check(fresh.messageIndex(agentId: agentId, id: "m5") == nil, "…m5 trimmed by the 400 appends")
        fresh.applyTranscript(AgentTranscript(agentId: agentId, messages: (100..<160).map(message), total: 160, complete: false, live: true), mode: "replace")
        fresh.applyTranscript(AgentTranscript(agentId: agentId, messages: [message(5)], total: 0, complete: false, live: true), mode: "append")
        check(fresh.transcripts[agentId]?.messages.count == 61 && fresh.transcripts[agentId]?.messages.last?.id == "m5" && fresh.prependedCount[agentId] == nil,
              "a replace resets the trimmed set and the loaded count")

        // 3e. The trimmed set is bounded: 20 000 trims hold the newest 8 192 ids.
        var ring = AppState.TrimmedIds()
        for i in 0..<20_000 { ring.insert("t\(i)") }
        ring.insert("t19999")
        check(ring.count == AppState.TrimmedIds.capacity && ring.contains("t19999") && ring.contains("t\(20_000 - AppState.TrimmedIds.capacity)") && !ring.contains("t\(20_000 - AppState.TrimmedIds.capacity - 1)"),
              "trimmed ids: the newest \(AppState.TrimmedIds.capacity) of 20 000, once each")

        // 3f. A chain answer with no rows for a chain that has members is not an answer.
        check(!JarheadChainRows(rows: [], truncated: false).covers(sessionCount: 2), "empty chain rows for 2 sessions → fall back to per-session reads")
        check(JarheadChainRows(rows: [], truncated: false).covers(sessionCount: 0), "empty chain rows for 0 sessions → nothing to read")
        check(JarheadChainRows(rows: [LedgerRow(at: 0, type: "session.started")], truncated: true).covers(sessionCount: 2), "rows → shown (truncated kept)")

        // 4. isLive / typing derive from connection and status (on a copy the engine follows).
        var alive = after
        alive.live = true
        var agent = AgentInfo(id: agentId, kind: .sessions, tool: .codex, name: "bench", status: .working, detail: nil, cwd: nil, updatedAt: 0, messageCount: nil, hint: nil)
        check(alive.isLive(agent: agent, connected: true) && alive.typing(agent: agent, connected: true), "working + connected + live → isLive and typing")
        check(!alive.isLive(agent: agent, connected: false), "isLive false when disconnected")
        agent.status = .ended
        check(!alive.isLive(agent: agent, connected: true), "isLive false when the agent ended")
        agent.status = .idle
        check(alive.isLive(agent: agent, connected: true) && !alive.typing(agent: agent, connected: true), "idle → live, not typing")
        agent.status = .working
        check(!after.isLive(agent: agent, connected: true), "isLive false when the engine stopped following (live:false)")

        // 5. A daemon drop seals every utterance.
        var snap = Snapshot.empty
        snap.transcript = [
            TranscriptItem(id: "u1", speaker: .kevin, text: "hey", startMs: 0, endMs: 900, at: 0, final: true),
            TranscriptItem(id: "u2", speaker: .jarhead, text: "still typ", startMs: 1_000, endMs: 1_800, at: 0, final: false),
        ]
        let sealed = snap.finalisingTranscript()
        check(!sealed.transcript.contains { !$0.final } && sealed.transcript.count == 2, "no final == false item survives the daemon-problem republish")

        // 6. SettingsPatch json carries the new keys (and omits them when unset).
        let patch = SettingsPatch(language: "en", accent: "british", memory: false).json
        check(patch["language"] as? String == "en" && patch["accent"] as? String == "british" && patch["memory"] as? Bool == false, "SettingsPatch json carries language / accent / memory")
        check(SettingsPatch(voice: "marin").json["language"] == nil, "an unset field is omitted from the patch")

        out.append(String(format: "timing: %d append deltas in %.1f ms → %d kept", deltas, ms, held?.messages.count ?? -1))
        return out
    }
}
#endif
