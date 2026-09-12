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

    var isLedgerMode: Bool { ledgerDay != nil }
    /// The centre shows the live stream: nothing stepped into, no ledger day.
    var showsNow: Bool { openAgentId == nil && openJarheadSessionId == nil && !isLedgerMode }

    /// Posted (userInfo `sessionId`, optional `view` = "log") to step the Console into the
    /// Jarhead conversation holding that session — the preview harness and any surface
    /// that opens the Console on a conversation use it; the root view listens.
    static let openJarheadSessionNotification = Notification.Name("jarhead.console.openJarheadSession")

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
        jarheadEntries = []
        jarheadLog = []
        jarheadLoading = false
    }

    /// Steps into a past Jarhead conversation: the chain's sessions' rows, oldest
    /// first, concatenated — a resume continues the paused one, so the chain reads as
    /// one conversation. The view mode (Conversation | Log) is kept between chains.
    func openJarhead(_ chain: JarheadChain, from state: AppState) async {
        openJarheadSessionId = chain.id
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

    func contains(_ sessionId: String) -> Bool { sessions.contains { $0.id == sessionId } }

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
