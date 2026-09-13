import SwiftUI
import Combine

/// Window-local UI state for the Console: which tab is open, which agent row or
/// past Jarhead conversation is stepped into, the ledger day being viewed, the
/// lightbox. Lives as long as the controller. Changes here are rare, so views may
/// observe the whole object.
@MainActor
final class ConsoleSession: ObservableObject {
    enum Tab: String, CaseIterable, Identifiable {
        case now = "Now", settings = "Settings", ledger = "Ledger"
        var id: String { rawValue }
    }

    /// How a past Jarhead conversation reads: the stream's rows, or every ledger row as one log.
    enum JarheadView: String, CaseIterable, Identifiable {
        case conversation = "Conversation", log = "Log"
        var id: String { rawValue }
    }

    @Published var tab: Tab = .now

    /// The agent session stepped into. Setting one of the two open ids clears the
    /// other: the centre shows one conversation, or Now.
    @Published var openAgentId: String? {
        didSet { if openAgentId != nil, openJarheadSessionId != nil { openJarheadSessionId = nil } }
    }
    /// The past Jarhead conversation stepped into — a chain's id (its first session's);
    /// nil is Now, the default.
    @Published var openJarheadSessionId: String? {
        didSet { if openJarheadSessionId != nil, openAgentId != nil { openAgentId = nil } }
    }
    /// The chain whose rows are on screen — set only once its read has landed, so an open
    /// id alone (set early for the rail's highlight) never passes for a loaded conversation.
    private(set) var loadedChainId: String?
    /// The open chain's rows, rebuilt into the stream's entries and the log's lines.
    @Published var jarheadEntries: [StreamEntry] = []
    @Published var jarheadLog: [JarheadLogLine] = []
    @Published var jarheadLoading = false
    @Published var jarheadView: JarheadView = .conversation

    /// nil until the first load; then newest first.
    @Published var ledgerDays: [String]?
    @Published var ledgerLoading = false
    @Published var ledgerError: String?
    @Published var ledgerDay: String?
    @Published var ledgerEntries: [StreamEntry] = []
    @Published var ledgerStats: LedgerStats?

    @Published var lightbox: ConsoleLightboxItem?

    /// Bumped by the window controller to focus the composer (⌘K).
    @Published var composerFocusRequest = 0
    /// Bumped on every Stop (the composer's button, ⌘.): the Stop button flashes red for the press.
    @Published var stopFlash = 0

    // MARK: cleanup (the rail's selection, the inline rename, the folded groups, the search)

    /// Chains picked with ⌘-click / ⇧-click; the action strip shows when more than one.
    @Published var selectedChainIds: Set<String> = []
    /// The last plain pick, where a ⇧-click range starts.
    var selectionAnchor: String?
    /// The chain whose title is being edited inline (Return commits, Esc cancels).
    @Published var renamingChainId: String?
    /// The folded groups at the bottom of the rail: Archived (n), Trash (n), Hidden (n).
    @Published var archivedOpen = false
    @Published var trashOpen = false
    @Published var hiddenAgentsOpen = false

    /// The search box in the rail's head: open, its text, and the hits for that text
    /// (nil: nothing searched yet, or too short). Results are cached per query while the box is open.
    @Published var searchOpen = false
    @Published var searchQuery = ""
    @Published var searchHits: [LedgerHit]?
    @Published var searching = false
    /// Why the ledger's hits are missing (titles still match locally); nil while they come.
    @Published var searchGap: SearchGap?
    var searchUnavailable: Bool { searchGap != nil }

    /// What stands between the box and the ledger's hits — named, so the line blames the right half.
    enum SearchGap: Equatable {
        /// The daemon did not answer `ledger.search` in time (it may predate the message).
        case daemon
        /// This build never installed `AppState.ledgerSearchHandler` (the app's wiring, not the daemon).
        case app

        var line: String {
            switch self {
            case .daemon: return "Titles only. The daemon did not answer the search; it may predate it."
            case .app: return "Titles only. Full search is not wired in this build."
            }
        }
    }
    /// Bumped to focus the field (⌘F, the head's button).
    @Published var searchFocusRequest = 0
    private var searchCache: [String: [LedgerHit]] = [:]
    private var searchTask: Task<Void, Never>?
    /// The preview harness's `loading` scenario pinned every read in flight: `search` and `pick`
    /// leave their loading state up instead of answering. Never set in the app.
    private var holdForPreview = false
    /// After a search hit opened a conversation: the row's wall-clock ms to scroll to.
    @Published var jarheadScrollTarget: Double?

    /// The shortest query that goes to the ledger.
    static let searchMinLength = 2
    /// Typing settles for this long before the ledger is asked.
    static let searchDebounceMs: UInt64 = 250

    var isLedgerMode: Bool { ledgerDay != nil }
    /// The centre shows the live stream: nothing stepped into, no ledger day.
    var showsNow: Bool { openAgentId == nil && openJarheadSessionId == nil && !isLedgerMode }

    /// Posted (userInfo `sessionId`, optional `view` = "log") to step the Console into the
    /// Jarhead conversation holding that session — the preview harness and any surface
    /// that opens the Console on a conversation use it; the root view listens.
    static let openJarheadSessionNotification = Notification.Name("jarhead.console.openJarheadSession")

    /// Posted by the preview harness to drive the rail's cleanup state without a mouse:
    /// userInfo `search` (a query), `trashOpen` / `archivedOpen` / `hiddenOpen` (Bool),
    /// `select` ([chain id]), `rename` (a chain id). The root view listens.
    static let previewNotification = Notification.Name("jarhead.console.preview")

    func select(_ tab: Tab) {
        self.tab = tab
        if tab != .ledger, isLedgerMode { showLive() }
    }

    func showLive() {
        ledgerDay = nil
        ledgerEntries = []
        ledgerStats = nil
        // An abandoned read must not leave the flag stuck for the next pick.
        ledgerLoading = false
        if tab == .ledger { tab = .now }
    }

    /// Back to Now: no conversation open, no ledger day.
    func showNow() {
        openAgentId = nil
        closeJarhead()
        if isLedgerMode { showLive() }
    }

    func openAgent(_ id: String) {
        openAgentId = id
    }

    func closeJarhead() {
        openJarheadSessionId = nil
        loadedChainId = nil
        jarheadScrollTarget = nil
        jarheadEntries = []
        jarheadLog = []
        jarheadLoading = false
    }

    /// Scroll the open conversation to the row at `at` (JarheadConversationPane.scrollTo).
    func scrollJarhead(to at: Double) { jarheadScrollTarget = at }

    // MARK: selection

    /// A click on a chain row. ⌘ toggles the row in the selection, ⇧ extends from the
    /// anchor over `visible` (the rail's order, top to bottom); either returns true and the
    /// row is not opened. A plain click clears the selection and returns false — the caller opens.
    @discardableResult
    func pickChain(_ id: String, modifiers: NSEvent.ModifierFlags, visible: [String]) -> Bool {
        if modifiers.contains(.command) {
            if selectedChainIds.contains(id) { selectedChainIds.remove(id) } else { selectedChainIds.insert(id) }
            selectionAnchor = id
            return true
        }
        if modifiers.contains(.shift), let anchor = selectionAnchor, let a = visible.firstIndex(of: anchor), let b = visible.firstIndex(of: id) {
            selectedChainIds.formUnion(visible[min(a, b)...max(a, b)])
            return true
        }
        if !selectedChainIds.isEmpty { selectedChainIds.removeAll() }
        selectionAnchor = id
        return false
    }

    func clearSelection() {
        selectedChainIds.removeAll()
    }

    // MARK: search

    func openSearch() {
        searchOpen = true
        searchFocusRequest += 1
    }

    /// Closes the box: the query, the hits and the cache go; the rail is itself again.
    func closeSearch() {
        searchTask?.cancel()
        searchTask = nil
        searchOpen = false
        searchQuery = ""
        searchHits = nil
        searching = false
        searchGap = nil
        searchCache.removeAll()
    }

    /// The box's text changed. Titles match locally at once (the rail does that from the
    /// query); the ledger is asked for body hits after the typing settles, once per query.
    func search(_ query: String, from state: AppState) {
        searchQuery = query
        searchTask?.cancel()
        if holdForPreview { searchHits = nil; searchGap = nil; searching = true; return }
        let q = ConsoleSession.searchKey(query)
        guard q.count >= ConsoleSession.searchMinLength else {
            searchHits = nil
            searching = false
            return
        }
        if let cached = searchCache[q] {
            searchHits = cached
            searching = false
            return
        }
        // No handler at all is the app's gap, not the daemon's: say so, and skip the wait.
        guard state.ledgerSearchInstalled else {
            searchHits = []
            searchGap = .app
            searching = false
            return
        }
        searching = true
        let owner = self
        searchTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: ConsoleSession.searchDebounceMs * 1_000_000)
            guard !Task.isCancelled else { return }
            let answer = await state.ledgerSearch(q, limit: 60)
            guard !Task.isCancelled, owner.searchOpen, ConsoleSession.searchKey(owner.searchQuery) == q else { return }
            if let hits = answer {
                owner.searchCache[q] = hits
                owner.searchHits = hits
                owner.searchGap = nil
            } else {
                owner.searchHits = []
                owner.searchGap = .daemon
            }
            owner.searching = false
        }
    }

    /// The preview harness's `loading` scenario: the picked day's read and a search left in
    /// flight for good, so the stream's "Reading…", the rail's "Reading" row and the Jarhead
    /// section's "Searching…" — the dither glyphs — are on screen to shoot. The query names
    /// nothing a fake title contains, or the title matches would stand in for the indicator.
    func pinLoadingForPreview() {
        holdForPreview = true
        ledgerEntries = []
        ledgerStats = nil
        ledgerLoading = true
        searchTask?.cancel()
        searchTask = nil
        searchOpen = true
        searchQuery = "vercel"
        searchHits = nil
        searchGap = nil
        searching = true
    }

    /// Trimmed and lower-cased: what the cache and the daemon see.
    static func searchKey(_ query: String) -> String {
        query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    /// The rail is showing search results, not the sections.
    var isSearching: Bool { searchOpen && ConsoleSession.searchKey(searchQuery).count >= ConsoleSession.searchMinLength }

    /// Steps into a past Jarhead conversation: the chain's sessions' rows, oldest
    /// first, concatenated — a resume continues the paused one, so the chain reads as
    /// one conversation. The view mode (Conversation | Log) is kept between chains.
    /// `scrollTo` is a row's wall-clock ms (a search hit): the feed opens on it.
    func openJarhead(_ chain: JarheadChain, from state: AppState, scrollTo at: Double? = nil) async {
        if openJarheadSessionId == chain.id, loadedChainId == chain.id || jarheadLoading {
            // Its rows are on screen, or their read is in flight: only the scroll target moves
            // (the read in flight lands and the pane opens on it). The open id alone is not
            // enough — the rail sets it early for the highlight — hence `loadedChainId`.
            jarheadScrollTarget = at
            return
        }
        // The rail's highlight glides to the row and the pane arrives behind the curtain — in the
        // wipe's own animation (Motion.wipeAnimation), the curtain's length to the frame.
        withAnimation(Motion.wipeAnimation) { openJarheadSessionId = chain.id }
        loadedChainId = nil
        jarheadScrollTarget = at
        jarheadEntries = []
        jarheadLog = []
        jarheadLoading = true
        var rows: [LedgerRow] = []
        for s in chain.sessions {
            rows += await state.jarheadSessionRows(s.id)
        }
        // Kevin may have moved on while we were reading.
        guard openJarheadSessionId == chain.id else { return }
        jarheadEntries = StreamBuilder.fromLedger(rows)
        jarheadLog = JarheadLog.lines(rows)
        jarheadLoading = false
        loadedChainId = chain.id
    }

    func loadDays(from state: AppState, force: Bool = false) async {
        if ledgerDays != nil && !force { return }
        ledgerLoading = true
        ledgerError = nil
        let days = await state.ledgerDays()
        ledgerDays = days
        ledgerLoading = false
    }

    func pick(day: String, from state: AppState) async {
        // The day takes the centre: whatever conversation was stepped into steps out.
        openAgentId = nil
        if openJarheadSessionId != nil { closeJarhead() }
        ledgerDay = day
        // Clear the previous day before the read so the feed shows its loading
        // state instead of the old rows under the new banner.
        ledgerEntries = []
        ledgerStats = nil
        ledgerLoading = true
        if holdForPreview { return }
        let rows = await state.ledgerRows(day: day)
        // The user may have moved on while we were reading: either showLive()
        // already reset the flag, or a newer pick owns it now.
        guard ledgerDay == day else { return }
        ledgerEntries = StreamBuilder.fromLedger(rows)
        ledgerStats = StreamBuilder.stats(rows)
        ledgerLoading = false
    }
}

// MARK: - Jarhead conversations (pure)

/// One of Jarhead's conversations as the rail shows it: a session, or a resume
/// chain (`resumedFrom` links) folded into one row. `sessions` oldest first; the
/// chain's id is its first session's, so a row keeps its identity across resumes.
struct JarheadChain: Identifiable, Equatable {
    let sessions: [JarheadSessionSummary]

    var id: String { sessions.first?.id ?? "" }
    var root: JarheadSessionSummary? { sessions.first }
    var last: JarheadSessionSummary? { sessions.last }
    var day: String { root?.day ?? "" }
    var startedAt: Double { root?.startedAt ?? 0 }
    /// nil while the last session is still open.
    var endedAt: Double? { last?.closedAt }
    var isOpen: Bool { last?.closedAt == nil }
    var reason: String? { last?.reason }
    var usageSeconds: Double { sessions.reduce(0) { $0 + $1.usageSeconds } }
    /// heard + said, the whole chain.
    var messages: Int { sessions.reduce(0) { $0 + $1.heard + $1.said } }
    var delegations: Int { sessions.reduce(0) { $0 + $1.delegations } }
    var resumes: Int { max(0, sessions.count - 1) }
    /// The first thing Kevin said anywhere in the chain; "" when nothing was heard.
    var title: String { sessions.first(where: { !$0.title.isEmpty })?.title ?? "" }

    // The chain's state from the ledger's tombstone rows. The engine stamps every session of
    // a chain with the same state, name and pin; the root's is read first, any other's next.

    /// "active" | "archived" | "trashed".
    var state: String { root?.state ?? sessions.compactMap(\.state).first ?? "active" }
    var isTrashed: Bool { state == "trashed" }
    var isArchived: Bool { state == "archived" }
    var isActive: Bool { !isTrashed && !isArchived }
    /// Kevin's own name for it; nil when he gave none (or cleared it).
    var name: String? {
        let n = root?.name ?? sessions.compactMap(\.name).first
        return (n?.isEmpty == false) ? n : nil
    }
    /// The rail's title: Kevin's name, else the first thing he said.
    var displayTitle: String { name ?? title }
    var pinned: Bool { root?.pinned ?? sessions.compactMap(\.pinned).first ?? false }
    var trashedAt: Double? { root?.trashedAt ?? sessions.compactMap(\.trashedAt).first }
    /// Nothing heard, said or delegated — the crash litter.
    var isEmptyConversation: Bool { messages == 0 && delegations == 0 }

    func contains(_ sessionId: String) -> Bool { sessions.contains { $0.id == sessionId } }

    /// The chain as the rail shows it before the ledger confirms Kevin's click (AppState.chainOverrides).
    func overlaid(_ o: ChainOverride) -> JarheadChain {
        JarheadChain(sessions: sessions.map { s in
            var s = s
            if let state = o.state { s.state = state == "active" ? nil : state }
            if let name = o.name { s.name = name }
            if let pinned = o.pinned { s.pinned = pinned }
            return s
        })
    }

    /// Folds the ledger's list into chains, newest first by when each began. A session
    /// whose `resumedFrom` is not in the list starts a chain of its own.
    static func build(_ list: [JarheadSessionSummary]) -> [JarheadChain] {
        var byId: [String: JarheadSessionSummary] = [:]
        for s in list where byId[s.id] == nil { byId[s.id] = s }
        func rootId(_ s: JarheadSessionSummary) -> String {
            var current = s
            var seen: Set<String> = [s.id]
            while let from = current.resumedFrom, let previous = byId[from], !seen.contains(previous.id) {
                seen.insert(previous.id)
                current = previous
            }
            return current.id
        }
        var groups: [String: [JarheadSessionSummary]] = [:]
        for s in list { groups[rootId(s), default: []].append(s) }
        return groups.values
            .map { JarheadChain(sessions: $0.sorted { $0.startedAt < $1.startedAt }) }
            .sorted { $0.startedAt > $1.startedAt }
    }
}

struct ConsoleLightboxItem: Identifiable, Equatable {
    let url: URL
    let caption: String
    var id: String { url.path }
}

/// Side-effect hooks handed down through the environment so leaf views stay
/// pure value types (and therefore cheap to diff) without observing AppState.
struct ConsoleActions {
    var send: (EngineCommand) -> Void = { _ in }
    /// Stop everything — the command plus the feedback that does not wait for the
    /// engine (ConsoleWindowController.handle(.stop)); the composer's button and ⌘. share it.
    var stop: () -> Void = {}
    var screenshotURL: (String) -> URL = { URL(fileURLWithPath: $0) }
    var loadLedgerDays: () -> Void = {}
    var pickLedgerDay: (String) -> Void = { _ in }
    /// Settings › "Set up again…": the first-run wizard.
    var openOnboarding: () -> Void = {}
    /// The wake gate's passphrase (AppState.wakeActions, read at call time so the
    /// gate may install them after the window exists). Set returns false when too short.
    var setWakePassphrase: (String) -> Bool = { _ in false }
    var clearWakePassphrase: () -> Void = {}
    /// Now › "Circle something…": mark mode on the overlay (AppState.beginMarkMode).
    var beginMarkMode: () -> Void = {}
    /// A conversation's Reveal: the session's folder or file in Finder.
    var reveal: (URL) -> Void = { _ in }
    /// The Jarhead section: step into a past conversation (the whole chain), or back to Now.
    /// The root view fills these in — they need AppState, which leaf views never see.
    var openJarheadConversation: (JarheadChain) -> Void = { _ in }
    var showNow: () -> Void = {}
    /// The cleanup verbs — Move to Trash, Archive, Restore, Rename, Pin, New conversation,
    /// Clear, Hide, the retention sweep — as one undoable action each (AppState.performCleanup:
    /// the commands, the overlay, the undo stack, the toast, the re-read). Filled in by the root.
    var cleanup: (CleanupAction) -> Void = { _ in }
    /// Edit › Undo for the newest cleanup action.
    var undoCleanup: () -> Void = {}
    /// The rail's search box: the query changed (ConsoleSession.search, debounced).
    var search: (String) -> Void = { _ in }
    /// A search hit: open the conversation holding that session, scrolled to the row.
    var openJarheadHit: (LedgerHit) -> Void = { _ in }
    /// A remedy's `open`, or the trash folder: a URL opens, a path is shown in Finder.
    var open: (String) -> Void = { target in
        if let url = URL(string: target), url.scheme != nil, !target.hasPrefix("/") {
            NSWorkspace.shared.open(url)
        } else {
            NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: (target as NSString).expandingTildeInPath)])
        }
    }
}

// MARK: - The cleanup actions (pure)

/// The verbs the rail and the panels offer, each built once here so every site sends the
/// same commands, shows the same overlay and reads the same word in Edit › Undo and the
/// toast. Nothing deletes: trash and archive are tombstone rows, restore is their inverse.
extension CleanupAction {
    private static func count(_ n: Int, _ one: String, _ many: String) -> String { n == 1 ? one : String(format: many, n) }

    static func trash(_ chains: [JarheadChain]) -> CleanupAction {
        var a = CleanupAction(label: "Move to Trash", toast: count(chains.count, "Moved to Trash", "Moved %d to Trash"), symbol: "trash.fill",
                              commands: chains.map { .conversationTrash(chainId: $0.id) },
                              inverse: chains.map { chain in chain.isArchived ? .conversationArchive(chainId: chain.id) : .conversationRestore(chainId: chain.id) })
        for c in chains {
            a.chainAfter[c.id] = ChainOverride(state: "trashed")
            a.chainBefore[c.id] = ChainOverride(state: c.state)
        }
        return a
    }

    static func archive(_ chains: [JarheadChain]) -> CleanupAction {
        var a = CleanupAction(label: "Archive", toast: count(chains.count, "Archived", "Archived %d"), symbol: "archivebox.fill",
                              commands: chains.map { .conversationArchive(chainId: $0.id) },
                              inverse: chains.map { chain in chain.isTrashed ? .conversationTrash(chainId: chain.id) : .conversationRestore(chainId: chain.id) })
        for c in chains {
            a.chainAfter[c.id] = ChainOverride(state: "archived")
            a.chainBefore[c.id] = ChainOverride(state: c.state)
        }
        return a
    }

    /// Back from Archived or Trash; the inverse puts each one back where it was.
    static func restore(_ chains: [JarheadChain]) -> CleanupAction {
        var a = CleanupAction(label: "Restore", toast: count(chains.count, "Restored", "Restored %d"), symbol: "arrow.uturn.backward",
                              commands: chains.map { .conversationRestore(chainId: $0.id) },
                              inverse: chains.map { chain in chain.isTrashed ? .conversationTrash(chainId: chain.id) : .conversationArchive(chainId: chain.id) })
        for c in chains {
            a.chainAfter[c.id] = ChainOverride(state: "active")
            a.chainBefore[c.id] = ChainOverride(state: c.state)
        }
        return a
    }

    /// "" is back to the auto title.
    static func rename(_ chain: JarheadChain, to name: String) -> CleanupAction {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        var a = CleanupAction(label: "Rename", toast: trimmed.isEmpty ? "Name cleared" : "Renamed", symbol: "pencil",
                              commands: [.conversationRename(chainId: chain.id, name: trimmed)],
                              inverse: [.conversationRename(chainId: chain.id, name: chain.name ?? "")])
        a.chainAfter[chain.id] = ChainOverride(name: trimmed)
        a.chainBefore[chain.id] = ChainOverride(name: chain.name ?? "")
        return a
    }

    static func pin(_ chain: JarheadChain, _ pinned: Bool) -> CleanupAction {
        var a = CleanupAction(label: pinned ? "Pin" : "Unpin", toast: pinned ? "Pinned" : "Unpinned", symbol: pinned ? "pin.fill" : "pin.slash.fill",
                              commands: [.conversationPin(chainId: chain.id, pinned: pinned)],
                              inverse: [.conversationPin(chainId: chain.id, pinned: !pinned)])
        a.chainAfter[chain.id] = ChainOverride(pinned: pinned)
        a.chainBefore[chain.id] = ChainOverride(pinned: !pinned)
        return a
    }

    /// Hide / unhide an agent's row. Never a file operation: Claude Code and Codex own their stores.
    static func hide(_ agent: AgentInfo, _ hidden: Bool) -> CleanupAction {
        var a = CleanupAction(label: hidden ? "Hide" : "Unhide", toast: hidden ? "Hidden" : "Shown again", symbol: hidden ? "eye.slash.fill" : "eye.fill",
                              commands: [.agentHide(agentId: agent.id, hidden: hidden)],
                              inverse: [.agentHide(agentId: agent.id, hidden: !hidden)])
        a.agentsAfter[agent.id] = hidden
        a.agentsBefore[agent.id] = !hidden
        a.refreshesJarhead = false
        return a
    }

    /// Clear the Now stream (the ledger keeps every row; the engine hides them from the live view).
    static func clearNow(at: Double) -> CleanupAction {
        var a = CleanupAction(label: "Clear", toast: "Cleared", symbol: "eraser.fill", commands: [.nowClear], inverse: [.nowRestore])
        a.nowAfter = .cleared(at)
        a.nowBefore = .restored
        a.refreshesJarhead = false
        return a
    }

    /// The feed's own "Cleared · Undo": the items come back.
    static func restoreNow(clearedAt: Double) -> CleanupAction {
        var a = CleanupAction(label: "Restore", toast: "Restored", symbol: "arrow.uturn.backward", commands: [.nowRestore], inverse: [.nowClear])
        a.nowAfter = .restored
        a.nowBefore = .cleared(clearedAt)
        a.refreshesJarhead = false
        return a
    }

    /// A fresh conversation: the open session closes like a stop, the next Go starts a new chain. Not undoable.
    static var newConversation: CleanupAction {
        var a = CleanupAction(label: "New Conversation", toast: "New conversation", symbol: "plus", commands: [.conversationNew], inverse: [])
        a.nowAfter = .restored
        return a
    }

    /// Run the retention sweep now (what it would move is logged first). Days come back one at a time with Restore.
    static var sweep: CleanupAction {
        var a = CleanupAction(label: "Sweep", toast: "Sweep running", symbol: "trash.fill", commands: [.ledgerSweep], inverse: [])
        a.refreshesJarhead = true
        return a
    }

    static func trashDay(_ day: String, what: String = "both") -> CleanupAction {
        CleanupAction(label: "Move Day to Trash", toast: "Moved \(day) to Trash", symbol: "trash.fill",
                      commands: [.ledgerTrashDay(day: day, what: what)], inverse: [.ledgerRestoreDay(day: day)])
    }

    static func restoreDay(_ day: String) -> CleanupAction {
        CleanupAction(label: "Restore Day", toast: "Restored \(day)", symbol: "arrow.uturn.backward",
                      commands: [.ledgerRestoreDay(day: day)], inverse: [.ledgerTrashDay(day: day, what: "both")])
    }
}

private struct ConsoleActionsKey: EnvironmentKey {
    static let defaultValue = ConsoleActions()
}

extension EnvironmentValues {
    var consoleActions: ConsoleActions {
        get { self[ConsoleActionsKey.self] }
        set { self[ConsoleActionsKey.self] = newValue }
    }
}
