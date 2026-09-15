import SwiftUI
import AppKit

// Left rail, two sections. **Jarhead** first — its own conversations: a "Now" row
// (the live or paused session: elapsed · billed, or "paused · meter stopped";
// "asleep" when there is none), then past conversations newest first under day
// heads, one 44pt row per conversation — the Jarhead mark, the first thing Kevin
// said (or the name he gave it) with the started clock as its right-hand stamp, and
// one mono meta line: duration · billed · messages. A resume chain (`resumedFrom`
// links) folds into one row with a "resumed ×n" badge beside the stamp. Pinned
// conversations float above the days under a "Pinned" head with a solid pin glyph;
// archived and trashed ones leave the days for two folded groups at the bottom,
// "Archived (n)" and "Trash (n)", each row with Restore — never a Delete or an Empty:
// the Trash head's folder reveals it in Finder, and emptying it is Kevin's, there.
// Every row has a context menu and a ⋯ drawn at rest (the same `[ConsoleVerb]`): Rename (inline;
// Return commits, Esc cancels, "" is back to the auto title), Pin, Archive, Move to Trash;
// ⌘-click and ⇧-click select several and a strip under the head offers Archive ·
// Move to Trash · Restore for all of them. The Now row's menu has New conversation
// and Clear. Every action is undoable (the toast under the header, Edit › Undo).
// The head holds the search (⌘F): hits from the ledger grouped by conversation (`k of n` in the
// field, a type badge on every hit), each opening it scrolled to the row; ↑↓ walk the hits and
// Return opens the focused one; an empty box is the rail again. Day heads are sticky
// `ConsoleGroupHead`s; Archived, Trash and Hidden are `ConsoleDisclosure`s whose folded head says
// what is inside; every list row takes `ConsoleListKeys` (↑↓ ⏎ → ← Esc, the keyboard's one ring).
// Then **Agents**: sessions grouped by the tool that owns them (Claude Code, Codex,
// Cursor…). A group is a `ConsoleDisclosure` (24pt head: the tool's name, a count, and while
// folded the one exceptional word — the `[1 asks]` badge — with the resting count) and 44pt rows: the
// mark on the icon column, the name with its status as a word in the trailing zone (a badge
// only when it asks), and one mono meta line — project · messages · age. Hide takes a row
// out of its group into a folded "Hidden (n)" at the end (never a file operation —
// those tools own their stores). Groups are separated by a gap, never a rule; the
// two sections by one rule and a head. A down connector keeps a head of its own so
// its reason shows. Clicking a row steps into that conversation in the stream; the
// selected row carries the accent bar. Now is the selection when nothing is stepped into.

private let railInset: CGFloat = 12
private let iconGap: CGFloat = 8
/// Where text starts: the inset, the 20pt icon column and its gap.
private let textInset: CGFloat = railInset + 20 + iconGap
/// The Restore / Unhide button on an archived, trashed or hidden row, left of that zone.
private let restoreWidth: CGFloat = 58
/// How many hits a conversation shows under search before "+n more".
private let hitsPerChain = 4

/// The rail's words (pinned by check-kit where the mocks show them).
enum AgentsRailWords {
    static let now = "Now"
    static let liveConversation = "The live conversation"
    static let searchPlaceholder = "Search conversations"
    static let closeSearch = "Close the search"
    static let titles = "Titles"
    static let more = "+%d more"
    static let restore = "Restore"
    static let unhide = "Unhide"
    static let hide = "Hide"
    static let revealTrash = "Reveal the trash in Finder"
    static let revealHelp = "Reveal in Finder"
    /// The row ids `ConsoleListKeys` walks and the disclosures' fold ids.
    static let nowId = "now"
    static let archivedId = "rail.archived"
    static let trashId = "rail.trash"
    static let hiddenId = "rail.hidden"
    static func threadId(_ id: String) -> String { "thread:\(id)" }
    static func chainId(_ id: String) -> String { "chain:\(id)" }
    static func agentId(_ id: String) -> String { "agent:\(id)" }
    static func hitId(_ id: String) -> String { "hit:\(id)" }
    static func groupId(_ tool: AgentTool) -> String { "agents.\(tool.rawValue)" }
    /// The rows' cards on the float layer (`tipOpen:` / `hover:` reach them by these).
    static func threadTip(_ id: String) -> String { "rail.thread.\(id)" }
    static func chainTip(_ id: String) -> String { "rail.chain.\(id)" }
    static func agentTip(_ id: String) -> String { "rail.agent.\(id)" }
    static func hitTip(_ id: String) -> String { "rail.hit.\(id)" }
    /// `resumed ×1` — the chain row's badge.
    static func resumed(_ n: Int) -> String { "resumed ×\(n)" }
    /// A search hit's type as the badge word (the glyph's legend).
    static func hitType(_ type: String) -> String {
        switch type {
        case "request", "delegation", "delegation.created": return "asked"
        case "delegation.finished": return "summary"
        default: return type
        }
    }
    /// An agent's status as the trailing word (blocked is the `asks` badge instead).
    static func status(_ s: AgentStatus) -> String { s.rawValue }
    // The cards' keys (the thread card's are ConsoleTipWords', the card being A's).
    static let started = "started"
    static let sessions = "sessions"
    static let inTrash = "In the Trash"
    static let archivedWord = "Archived"
    static let cwd = "cwd"
    static let nothingHeard = "Nothing heard"
    /// The Threads head's tip and the rename field's — ≤ 60 characters, no "you", no "Kevin".
    static let threadsHelp = "Threads asking first, then busy, then finished (5 min kept)"
    static let renameHelp = "Return keeps the name; Esc cancels; empty is the auto title"
}

/// What a rail row wears: bright (it can still change), quiet (over — 0.72, the text ladder's fg2),
/// back (empty, archived, trashed, hidden, an agent whose process is gone — 0.48, fg3). Placement
/// (Pinned, a day, Older, Archived, Trash, Ended, Hidden) is where a row sits; the tone is its own.
/// The open (stepped-into) row and a search result lift their alpha to 1.0 and keep the tone's mark.
enum RailTone: Equatable {
    case bright, quiet, back

    /// The row's alpha: the text ladder's own figures (fg · fg2 · fg3), never a new colour.
    var alpha: CGFloat {
        switch self {
        case .bright: return 1
        case .quiet: return 0.72
        case .back: return 0.48
        }
    }

    /// The mark in titanium's ramp (`Dither.markQuietStops`) for every tone but bright.
    var quietMark: Bool { self != .bright }

    /// A past conversation: archived / trashed → back; the crash litter → back; ended today or never
    /// closed → bright; ended before today → quiet. Judged by the END day (the start day groups it).
    static func conversation(_ chain: JarheadChain, now: Double) -> RailTone {
        if !chain.isActive || chain.isEmptyConversation { return .back }
        if chain.isOpen { return .bright }
        if let ended = chain.endedAt, ConsoleFormat.dayString(ended) == ConsoleFormat.dayString(now) { return .bright }
        return .quiet
    }

    /// An agent: hidden → back; asks / working → bright; idle (a process, quiet) → quiet; over → back.
    static func agent(status: AgentStatus, hidden: Bool) -> RailTone {
        if hidden { return .back }
        switch status {
        case .blocked, .working: return .bright
        case .idle: return .quiet
        case .done, .ended, .unknown, .offline: return .back
        }
    }

    /// A thread: live → bright; finished (≤ 5 min on the rail) → quiet. Never back: it is recent by construction.
    static func thread(_ status: ThreadStatus) -> RailTone { status.isLive ? .bright : .quiet }
}

/// Where a day's head sits: Today (open), Yesterday (closed), or inside the one closed `Older` head.
enum RailDayPlace: Equatable {
    case today, yesterday, older

    static func of(day: String, now: Date) -> RailDayPlace {
        let ago = ConsoleFormat.daysAgo(day, now: now)
        if ago <= 0 { return .today }
        return ago == 1 ? .yesterday : .older
    }
}

/// The rail's fold ids, figures and tips (pinned by check-kit).
enum RailWords {
    static let olderId = "rail.older"
    /// The card's key for what the row lost: `ran  34:00 · 7.5 min · 10 msgs`.
    static let ran = "ran"
    static let hits = "Hits"
    static let agents = "Agents"
    /// The card's status while the conversation is pinned (the row carries no pin glyph).
    static let pinnedStatus = "Pinned"
    static let dayPrefix = "rail.day."
    static let endedSuffix = ".ended"
    static let olderTipLead = "Every day before yesterday"
    static func dayId(_ day: String) -> String { dayPrefix + day }
    static func endedId(_ tool: AgentTool) -> String { AgentsRailWords.groupId(tool) + endedSuffix }
    /// `rail.day.2026-09-13` → `2026-09-13`; nil for any other id.
    static func day(ofId id: String) -> String? { id.hasPrefix(dayPrefix) ? String(id.dropFirst(dayPrefix.count)) : nil }
    /// The folds the rail draws as group heads (the disclosures listen for their own ids).
    static func ownsFold(_ id: String) -> Bool { id.hasPrefix(dayPrefix) || id == olderId || id.hasSuffix(endedSuffix) }
    /// `×1` — the chain row's mono figure badge.
    static func resumedFigure(_ n: Int) -> String { "×\(n)" }
    /// `resumed once` · `resumed 3×` — the badge's tip.
    static func resumedTip(_ n: Int) -> String { n == 1 ? "resumed once" : "resumed \(n)×" }
    /// A folded day's tip: `Yesterday · 5 · 26 min · newest "Hello"`; a day inside Older leads with its full date.
    static func dayTip(title: String, count: Int, billed: Double, newest: String?) -> String {
        var parts = [title, "\(count)", ConsoleFormat.billedShort(billed)]
        if let newest, !newest.isEmpty { parts.append("newest “\(ConversationFormat.oneLine(newest, max: 24))”") }
        return parts.joined(separator: ConsoleDisclosureWords.joiner)
    }
    /// `Every day before yesterday · 31 · since Aug 2`
    static func olderTip(count: Int, since: String) -> String {
        [olderTipLead, "\(count)", ConsoleDisclosureWords.since(since)].joined(separator: ConsoleDisclosureWords.joiner)
    }
    /// `7 conversations · 2 archived · 2 in the Trash`
    static func jarheadTip(active: Int, archived: Int, trashed: Int) -> String {
        var parts = [active == 1 ? "1 conversation" : "\(active) conversations"]
        if archived > 0 { parts.append("\(archived) archived") }
        if trashed > 0 { parts.append("\(trashed) in the Trash") }
        return parts.joined(separator: ConsoleDisclosureWords.joiner)
    }
    /// `7 alive · 6 over`
    static func agentsTip(alive: Int, over: Int) -> String { "\(alive) alive · \(over) over" }
    /// The newest conversation's title in a day (the list is newest first), skipping the crash litter.
    static func newestTitle(_ chains: [JarheadChain]) -> String? { chains.first { !$0.isEmptyConversation }?.displayTitle }
}

/// The folds' defaults, pure: Today and every day inside Older open, Yesterday closed, Older closed,
/// a tool open iff a process of its asks or works, its Ended sub-head closed. Read only when the
/// store holds nothing for the id (`ConsoleFoldStore.isOpen(_:default:)`).
enum RailFolds {
    static func defaultOpen(_ id: String, now: Date, hotTools: Set<String>) -> Bool {
        if let day = RailWords.day(ofId: id) { return RailDayPlace.of(day: day, now: now) != .yesterday }
        if id == RailWords.olderId || id.hasSuffix(RailWords.endedSuffix) { return false }
        if id.hasPrefix("agents.") { return hotTools.contains(String(id.dropFirst("agents.".count))) }
        return true
    }
}

/// What the Now row says, sliced from the snapshot by the root so the rail stays a plain value.
struct JarheadNowInfo: Equatable {
    var phase: Phase = .asleep
    /// The live session, or the one a pause closed and holds.
    var sessionId: String? = nil
    var startedAt: Double? = nil
    var usageSeconds: Double = 0
    var paused = false

    init() {}

    init(snapshot s: Snapshot) {
        phase = s.phase
        paused = s.phase == .paused || s.pause != nil
        sessionId = s.session?.id ?? s.pause?.sessionId
        startedAt = s.session?.startedAt
        usageSeconds = s.session?.usageSeconds ?? s.pause?.usageSeconds ?? 0
    }

    /// The row's meta line: `12:34 · 2.3 min` while live (the meter's own spelling, one
    /// decimal, so it reads with the right rail's figure), `paused · meter stopped`, `asleep`.
    func meta(now: Double) -> String {
        if paused { return "paused · meter stopped" }
        if let startedAt {
            return "\(ConsoleFormat.duration(max(0, now - startedAt) / 1000)) · \(TransportFormat.minutes(usageSeconds))"
        }
        return phase == .connecting ? "connecting" : "asleep"
    }

    /// The elapsed time ticks only while a session is running.
    var ticks: Bool { startedAt != nil && !paused }
}

struct AgentsRail: View, Equatable {
    let agents: [AgentInfo]
    let connectors: [ConnectorHealth]
    /// Jarhead's past conversations, newest first, every state — the live chain is the Now row, not one of these.
    let jarhead: [JarheadChain]
    let now: JarheadNowInfo
    /// Agents Kevin hid (Snapshot.hiddenAgents with his latest clicks on top).
    var hiddenAgents: Set<String> = []
    /// What the trash holds, for the Trash head's Reveal (Snapshot.trash).
    var trash: TrashInfo? = nil
    /// Jarhead's threads in the rail's order (AppState.orderedThreads: waiting on Kevin → busy →
    /// the idle main → finished within the linger); [] draws no section.
    var threads: [WorkThread] = []

    @EnvironmentObject private var session: ConsoleSession
    @Environment(\.consoleActions) private var actions
    @State private var refreshSpin = 0.0
    /// The one selection highlight, shared by every row so it glides between them.
    @Namespace private var selection
    /// The keyboard's one highlight over every row and head (`ConsoleListKeys`).
    @StateObject private var focus = ConsoleListFocus()
    /// Bumped when a tool group folds, so the walk order leaves its rows out.
    @State private var foldTick = 0

    static func == (a: AgentsRail, b: AgentsRail) -> Bool {
        a.agents == b.agents && a.connectors == b.connectors && a.jarhead == b.jarhead && a.now == b.now
            && a.hiddenAgents == b.hiddenAgents && a.trash == b.trash && a.threads == b.threads
    }

    /// What is selected, for the glide when the selection moves without a click (a
    /// conversation closing, a rail that came back without the open row).
    private var selectionKey: String {
        session.openAgentId.map { "agent:\($0)" } ?? session.openJarheadSessionId.map { "jarhead:\($0)" }
            ?? session.openThreadId.map { "thread:\($0)" } ?? "now"
    }

    /// The Threads section is drawn: the engine lists at least one spawned thread.
    private var showsThreads: Bool { !threads.isEmpty }
    /// The rows' order and status, so a status turning reflows the section under Motion.gentle.
    private var threadsKey: [String] { threads.map { "\($0.id)|\($0.status.rawValue)" } }

    private struct Group: Identifiable {
        let tool: AgentTool
        let agents: [AgentInfo]
        var id: String { tool.rawValue }
    }

    private struct DayGroup: Identifiable {
        let day: String
        let chains: [JarheadChain]
        var id: String { day }
    }

    // MARK: slices

    private var visibleAgents: [AgentInfo] { agents.filter { !hiddenAgents.contains($0.id) } }
    private var hiddenRows: [AgentInfo] { agents.filter { hiddenAgents.contains($0.id) }.sorted { $0.updatedAt > $1.updatedAt } }

    private var groups: [Group] {
        var seen = Set<AgentTool>()
        var out: [Group] = []
        let shown = visibleAgents
        let tools = ConsoleBrand.order + shown.map(\.resolvedTool).filter { !ConsoleBrand.order.contains($0) }
        for tool in tools where !seen.contains(tool) {
            seen.insert(tool)
            let list = AgentsRail.ordered(shown.filter { $0.resolvedTool == tool })
            if list.isEmpty { continue }
            out.append(Group(tool: tool, agents: list))
        }
        return out
    }

    /// A tool group's order: the sessions a process still owns (working, blocked, idle) above
    /// the ones that are over (done, ended, unknown, offline), each by when they last wrote.
    /// `ended` is most rows most of the time — a session with no process is over however old —
    /// so the live ones stay at the top where the eye lands, and an ended row never sits
    /// between two live ones because it wrote a minute later.
    static func ordered(_ agents: [AgentInfo]) -> [AgentInfo] {
        agents.sorted { a, b in
            let ra = rank(a.status), rb = rank(b.status)
            return ra != rb ? ra < rb : a.updatedAt > b.updatedAt
        }
    }

    /// The ladder's order inside a group: asks (0) → working (1) → idle (2) → over (3).
    static func rank(_ s: AgentStatus) -> Int {
        switch s {
        case .blocked: return 0
        case .working: return 1
        case .idle: return 2
        case .done, .ended, .unknown, .offline: return 3
        }
    }

    /// A row a process owns and that can still change: it asks or works. A tool group opens by default for one.
    static func hot(_ agent: AgentInfo) -> Bool { agent.status == .blocked || agent.status == .working }
    /// A row a process still owns (asks · working · idle).
    static func live(_ agent: AgentInfo) -> Bool { rank(agent.status) < 3 }

    private var pinnedChains: [JarheadChain] { jarhead.filter { $0.isActive && $0.pinned } }
    private var archived: [JarheadChain] { jarhead.filter(\.isArchived) }
    private var trashed: [JarheadChain] { jarhead.filter(\.isTrashed) }

    /// Past conversations under the day they began, newest day first (the list already is);
    /// the pinned ones sit above under their own head, the archived and trashed below.
    private var days: [DayGroup] {
        var order: [String] = []
        var map: [String: [JarheadChain]] = [:]
        for chain in jarhead where chain.isActive && !chain.pinned {
            if map[chain.day] == nil { order.append(chain.day) }
            map[chain.day, default: []].append(chain)
        }
        return order.map { DayGroup(day: $0, chains: map[$0] ?? []) }
    }

    /// A day placed on the rail: Today · Yesterday, or one of the days inside Older.
    private struct PlacedDay: Identifiable {
        let group: DayGroup
        let place: RailDayPlace
        var id: String { group.day }
    }

    /// The rail's clock for the day places and the fold defaults; the drawn rows take the TimelineView's `now`.
    private var railNow: Date { Date(timeIntervalSince1970: ConsoleFormat.nowMs / 1000) }

    /// The days placed, newest first; inside a day the crash litter (`isEmptyConversation`) sorts last.
    private func placedDays(now: Date) -> [PlacedDay] {
        days.map { group in
            let chains = group.chains.filter { !$0.isEmptyConversation } + group.chains.filter(\.isEmptyConversation)
            return PlacedDay(group: DayGroup(day: group.day, chains: chains), place: RailDayPlace.of(day: group.day, now: now))
        }
    }

    /// The tools with a row that asks or works: their groups open by default.
    private var hotTools: Set<String> { Set(groups.filter { $0.agents.contains(where: AgentsRail.hot) }.map { $0.tool.rawValue }) }

    /// Every chain row on screen, top to bottom — what a ⇧-click ranges over; folded days leave theirs out.
    private var visibleOrder: [String] {
        var out = pinnedChains.map(\.id)
        let placed = placedDays(now: railNow)
        for day in placed where day.place != .older { out += dayRows(day).map(\.id) }
        if isFoldOpen(RailWords.olderId) { for day in placed where day.place == .older { out += dayRows(day).map(\.id) } }
        if session.archivedOpen { out += archived.map(\.id) }
        if session.trashOpen { out += trashed.map(\.id) }
        return out
    }

    /// A day's rows while its head is open, none while it is folded.
    private func dayRows(_ day: PlacedDay) -> [JarheadChain] { isFoldOpen(RailWords.dayId(day.group.day)) ? day.group.chains : [] }

    private var selectedChains: [JarheadChain] { jarhead.filter { session.selectedChainIds.contains($0.id) } }

    /// Connectors that are down: a head with the reason, whatever sessions exist.
    private var down: [ConnectorHealth] {
        ConsoleTheme.kindOrder.compactMap { kind in connectors.first { $0.kind == kind && !$0.ok } }
            + connectors.filter { !$0.ok && !ConsoleTheme.kindOrder.contains($0.kind) }
    }

    /// The rows reflow when a chain changes place — a pin, an archive, a trash, a restore, a rename — or a fold turns.
    private var layoutKey: [String] {
        jarhead.map { "\($0.id)|\($0.state)|\($0.pinned)|\($0.displayTitle)" } + ["fold:\(foldTick)"]
    }

    var body: some View {
        VStack(spacing: 0) {
            // The head owns its bottom rule; it meets the right rail's tab row at the same height.
            JarheadRailHead(count: jarhead.isEmpty ? nil : jarhead.filter(\.isActive).count, hitCount: hitCount, move: { step($0) }, openFocused: openFocusedHit,
                            tip: RailWords.jarheadTip(active: jarhead.filter(\.isActive).count, archived: archived.count, trashed: trashed.count))
                .frame(height: 40)
            ConsoleHairline()
            if selectedChains.count > 1 {
                SelectionStrip(chains: selectedChains)
                    .transition(Motion.appear)
            }

            ScrollView(.vertical) {
                // Relative times refresh on a slow cadence without rebuilding rows elsewhere. The reader
                // sits inside the scroll view: around it, it froze the LazyVStack's updates (the kit's
                // first shots), so the keyboard's scroll-into-view comes from within.
                TimelineView(.periodic(from: .now, by: 15)) { ctx in
                    ScrollViewReader { proxy in
                        LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                            railContent(now: ctx.date.timeIntervalSince1970 * 1000)
                        }
                        .padding(.top, 8).padding(.bottom, 24)
                        .consoleListKeys(ConsoleListKeys(focus: focus, ids: walkIds, heads: headIds, title: rowTitle, typeAhead: !session.searchOpen,
                                                         primary: primary, fold: fold, escape: escape, parentHead: parentHead))
                        .modifier(railAnimations)
                        .onChange(of: focus.id) { _, id in
                            if let id, focus.keyboard { withAnimation(Motion.snappy) { proxy.scrollTo(id, anchor: nil) } }
                        }
                    }
                }
                .thinScrollers()
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: ConsoleFoldStore.changed)) { _ in withAnimation(Motion.snappy) { foldTick += 1 } }
        .onReceive(NotificationCenter.default.publisher(for: ConsoleSession.previewNotification), perform: preview)
        .onChange(of: session.openJarheadSessionId) { _, id in if let id { reveal(AgentsRailWords.chainId(id)) } }
        .onChange(of: session.openAgentId) { _, id in if let id { reveal(AgentsRailWords.agentId(id)) } }
        .modifier(railHousekeeping)
    }

    /// The harness's `fold:<id>:<open|closed>` for the folds the rail draws as group heads (the day heads,
    /// Older, a tool's Ended), and `probe-rail`: the focus and the walk, one line into run.log.
    private func preview(_ note: Notification) {
        guard let info = note.userInfo else { return }
        if let id = info[ConsolePreviewKey.fold] as? String, let open = info[ConsolePreviewKey.foldOpen] as? Bool, RailWords.ownsFold(id) {
            fold(id, open)
        }
        if info["probeRail"] as? Bool == true {
            let ids = walkIds
            print("rail-probe: focus=\(focus.id ?? "nil") walk=\(ids.count) \(ids.joined(separator: " "))")
        }
    }

    /// A row stepped into from outside the rail (a card link, the harness) never hides inside a fold:
    /// its head opens first — and Older's, when the head is a day inside it.
    private func reveal(_ id: String) {
        guard let head = parentHead(id) else { return }
        if let day = RailWords.day(ofId: head), RailDayPlace.of(day: day, now: railNow) == .older, !isFoldOpen(RailWords.olderId) { fold(RailWords.olderId, true) }
        if !isFoldOpen(head) { fold(head, true) }
    }

    /// The rail's rows: the search's hits, or the Jarhead section and the Agents section.
    @ViewBuilder
    private func railContent(now nowMs: Double) -> some View {
        if session.isSearching {
            searchResults(now: nowMs)
                .transition(Motion.swap)
        } else {
            jarheadSection(now: nowMs)
            ConsoleHairline().padding(.top, 12)
            agentsHead.padding(.trailing, -4).padding(.top, 4)
            if visibleAgents.isEmpty {
                ConsoleEmpty(agents.isEmpty ? "No sessions on this Mac right now." : "Every session is hidden.")
                    .transition(Motion.appear)
            }
            ForEach(Array(groups.enumerated()), id: \.element.id) { index, group in
                groupView(group, now: nowMs)
                    .padding(.top, index > 0 ? 8 : 0)
                    .transition(Motion.appear)
            }
            ForEach(Array(down.enumerated()), id: \.element.kind) { index, connector in
                downView(connector)
                    .padding(.top, index > 0 || !groups.isEmpty ? 12 : 0)
                    .transition(Motion.appear)
            }
            if !hiddenRows.isEmpty {
                hiddenGroup(now: nowMs)
                    .padding(.top, 8)
                    .transition(Motion.appear)
            }
        }
    }

    /// `Agents 7` — the rows a process owns (asks · working · idle); the tip says how many are over.
    private var agentsHead: some View {
        let alive = visibleAgents.filter(AgentsRail.live).count
        return ConsoleSectionHead("Agents", count: visibleAgents.isEmpty ? nil : alive) {
            Button {
                actions.send(.agentRefresh)
                if !Motion.reduced { withAnimation(Motion.gentle) { refreshSpin += 360 } }
            } label: {
                Image(systemName: "arrow.clockwise").font(.system(size: 12, weight: .semibold))
                    .rotationEffect(.degrees(refreshSpin))
            }
            .buttonStyle(ConsoleButtonStyle(kind: .plain, iconOnly: true, height: 24))
            .consoleHelp("Refresh")
            .accessibilityLabel("Refresh agents")
        }
        .modifier(ConsoleOptionalTip(tip: visibleAgents.isEmpty ? nil : RailWords.agentsTip(alive: alive, over: visibleAgents.count - alive)))
    }

    /// Rows arriving and leaving (a new session, a conversation closing, one moved to the Trash)
    /// fade and rise or drop with Motion.appear while the rest reflow; the selection glides to
    /// wherever it moved, click or not.
    private var railAnimations: RailAnimations {
        RailAnimations(agents: agents.map(\.id), layout: layoutKey, threads: threadsKey, down: down.map(\.kind), hidden: hiddenAgents,
                       folds: [session.archivedOpen, session.trashOpen, session.hiddenAgentsOpen, session.isSearching], foldTick: foldTick, selection: selectionKey)
    }

    private var railHousekeeping: RailHousekeeping {
        RailHousekeeping(selecting: selectedChains.count > 1, ids: jarhead.map(\.id))
    }

    // MARK: - keys (ConsoleListKeys)

    /// Every row and head on screen, top to bottom — what ↑↓ walk; folded heads leave their rows out.
    private var walkIds: [String] {
        _ = foldTick
        if session.isSearching { return searchWalk }
        var out = [AgentsRailWords.nowId] + threads.map { AgentsRailWords.threadId($0.id) }
        out += pinnedChains.map { AgentsRailWords.chainId($0.id) }
        let placed = placedDays(now: railNow)
        for day in placed where day.place != .older { out += dayWalk(day) }
        let older = placed.filter { $0.place == .older }
        if !older.isEmpty {
            out.append(RailWords.olderId)
            if isFoldOpen(RailWords.olderId) { for day in older { out += dayWalk(day) } }
        }
        if !archived.isEmpty { out.append(AgentsRailWords.archivedId); if session.archivedOpen { out += archived.map { AgentsRailWords.chainId($0.id) } } }
        if !trashed.isEmpty { out.append(AgentsRailWords.trashId); if session.trashOpen { out += trashed.map { AgentsRailWords.chainId($0.id) } } }
        for group in groups {
            out.append(AgentsRailWords.groupId(group.tool))
            if isFoldOpen(AgentsRailWords.groupId(group.tool)) { out += groupWalk(group) }
        }
        if !hiddenRows.isEmpty { out.append(AgentsRailWords.hiddenId); if session.hiddenAgentsOpen { out += hiddenRows.map { AgentsRailWords.agentId($0.id) } } }
        return out
    }

    /// A day's head, then its rows while it is open.
    private func dayWalk(_ day: PlacedDay) -> [String] {
        [RailWords.dayId(day.group.day)] + dayRows(day).map { AgentsRailWords.chainId($0.id) }
    }

    /// An open tool group's walk: the live rows, then the Ended head (and its rows while open) — or the
    /// over rows directly when nothing is alive (a fold never holds only a fold).
    private func groupWalk(_ group: Group) -> [String] {
        let live = group.agents.filter(AgentsRail.live), over = group.agents.filter { !AgentsRail.live($0) }
        var out = live.map { AgentsRailWords.agentId($0.id) }
        if !live.isEmpty, !over.isEmpty {
            let id = RailWords.endedId(group.tool)
            out.append(id)
            if isFoldOpen(id) { out += over.map { AgentsRailWords.agentId($0.id) } }
        } else {
            out += over.map { AgentsRailWords.agentId($0.id) }
        }
        return out
    }

    /// The head a row inside a fold sits under (← rings it; stepping into the row opens it).
    private func parentHead(_ id: String) -> String? {
        if let chain = jarhead.first(where: { AgentsRailWords.chainId($0.id) == id }) {
            if chain.isArchived { return AgentsRailWords.archivedId }
            if chain.isTrashed { return AgentsRailWords.trashId }
            return chain.pinned ? nil : RailWords.dayId(chain.day)
        }
        if let agent = agents.first(where: { AgentsRailWords.agentId($0.id) == id }) {
            if hiddenAgents.contains(agent.id) { return AgentsRailWords.hiddenId }
            guard let group = groups.first(where: { $0.tool == agent.resolvedTool }) else { return nil }
            if !AgentsRail.live(agent), group.agents.contains(where: AgentsRail.live) { return RailWords.endedId(group.tool) }
            return AgentsRailWords.groupId(group.tool)
        }
        return nil
    }

    /// The search's rows: the title matches, then each group's row and its hits, then the agents that match.
    private var searchWalk: [String] {
        let q = ConsoleSession.searchKey(session.searchQuery)
        let groups = SearchGroups.build(hits: session.searchHits ?? [], chains: jarhead, liveSessionId: self.now.sessionId)
        let hitChains = Set(groups.compactMap { $0.chain?.id })
        var out = jarhead.filter { !$0.isTrashed && !hitChains.contains($0.id) && $0.displayTitle.lowercased().contains(q) }.map { AgentsRailWords.chainId($0.id) }
        for group in groups {
            if let chain = group.chain { out.append(AgentsRailWords.chainId(chain.id)) } else if group.isNow { out.append(AgentsRailWords.nowId) }
            out += group.hits.prefix(hitsPerChain).map { AgentsRailWords.hitId($0.id) }
        }
        out += agentMatches(q).map { AgentsRailWords.agentId($0.id) }
        return out
    }

    /// Agents the search matches by name, project, the connector's detail or the tool's label — in the rail's order.
    private func agentMatches(_ q: String) -> [AgentInfo] {
        guard !q.isEmpty else { return [] }
        return groups.flatMap(\.agents).filter { agent in
            [agent.name, ConsoleFormat.projectName(agent.cwd) ?? "", agent.detail ?? "", agent.resolvedTool.label].contains { $0.lowercased().contains(q) }
        }
    }

    private var headIds: Set<String> {
        var out = Set([AgentsRailWords.archivedId, AgentsRailWords.trashId, AgentsRailWords.hiddenId, RailWords.olderId])
        out.formUnion(days.map { RailWords.dayId($0.day) })
        for group in groups {
            out.insert(AgentsRailWords.groupId(group.tool))
            if group.agents.contains(where: AgentsRail.live), group.agents.contains(where: { !AgentsRail.live($0) }) { out.insert(RailWords.endedId(group.tool)) }
        }
        return out
    }

    /// `k of n`: conversations the search matched, of every conversation on the rail (Now and the active and archived chains).
    private var hitCount: String? {
        guard session.isSearching, session.searchHits != nil else { return nil }
        let matched = Set(searchWalk.filter { !$0.hasPrefix("hit:") && !$0.hasPrefix("agent:") })
        return ConsoleRowWords.count(shown: matched.count, of: jarhead.filter { !$0.isTrashed }.count + 1)
    }

    /// A row's title for type-ahead.
    private func rowTitle(_ id: String) -> String {
        if id == AgentsRailWords.nowId { return AgentsRailWords.now }
        if let chain = jarhead.first(where: { AgentsRailWords.chainId($0.id) == id }) { return chain.displayTitle }
        if let agent = agents.first(where: { AgentsRailWords.agentId($0.id) == id }) { return agent.name }
        if let thread = threads.first(where: { AgentsRailWords.threadId($0.id) == id }) { return thread.name }
        return ""
    }

    /// Return on the focused row: what its click does.
    private func primary(_ id: String) {
        if id == AgentsRailWords.nowId { withAnimation(Motion.snappy) { actions.showNow() }; return }
        if headIds.contains(id) { fold(id, !isFoldOpen(id)); return }
        if let chain = jarhead.first(where: { AgentsRailWords.chainId($0.id) == id }) {
            reveal(id)
            withAnimation(Motion.snappy) { if session.openJarheadSessionId == chain.id { actions.showNow() } else { actions.openJarheadConversation(chain) } }
        } else if let agent = agents.first(where: { AgentsRailWords.agentId($0.id) == id }) {
            withAnimation(Motion.wipeAnimation) { if session.openAgentId == agent.id { actions.showNow() } else { session.openAgent(agent.id) } }
        } else if let thread = threads.first(where: { AgentsRailWords.threadId($0.id) == id }) {
            withAnimation(Motion.wipeAnimation) { if session.openThreadId == thread.id { actions.showNow() } else { session.openThread(thread.id) } }
        } else if let hit = (session.searchHits ?? []).first(where: { AgentsRailWords.hitId($0.id) == id }) {
            actions.openJarheadHit(hit)
        }
    }

    /// A fold's state: the three bound ones from the window; every other id from the store, its default
    /// the ladder's (`RailFolds`: Today and the days inside Older open, Yesterday, Older and Ended closed,
    /// a tool open iff a row of its asks or works).
    private func isFoldOpen(_ id: String) -> Bool {
        switch id {
        case AgentsRailWords.archivedId: return session.archivedOpen
        case AgentsRailWords.trashId: return session.trashOpen
        case AgentsRailWords.hiddenId: return session.hiddenAgentsOpen
        default: return ConsoleFoldStore.isOpen(id, default: RailFolds.defaultOpen(id, now: railNow, hotTools: hotTools))
        }
    }

    /// → / ← on a head: the store posts, the disclosure (bound or remembered) or the group head follows.
    private func fold(_ id: String, _ open: Bool) { ConsoleFoldStore.set(id, open) }

    /// ⌥-click on a day head: it opens and the other day heads (and Older, unless the day sits inside it) fold.
    private func foldOtherDays(keeping id: String) {
        let placed = placedDays(now: railNow)
        var siblings = placed.map { RailWords.dayId($0.group.day) }
        let inside = RailWords.day(ofId: id).map { RailDayPlace.of(day: $0, now: railNow) == .older } ?? false
        if !inside { siblings.append(RailWords.olderId) }
        ConsoleFoldStore.set(id, true)
        ConsoleFoldStore.foldSiblings(siblings, keeping: id)
    }

    /// Esc: the search closes if it is open; else the highlight lets go.
    private func escape() {
        if session.searchOpen { withAnimation(Motion.gentle) { session.closeSearch() } } else { focus.set(nil, keyboard: false, why: "escape") }
    }

    /// ↑↓ from the search field: the highlight walks the hits (the caret stays in the field); the
    /// first ↓ lands on the first hit, not the conversation row above it.
    private func step(_ delta: Int) {
        let ids = walkIds
        var next = ConsoleListModel.step(focus.id, by: delta, in: ids)
        if focus.id == nil, delta > 0, session.isSearching, let hit = ids.first(where: { $0.hasPrefix("hit:") }) { next = hit }
        guard let next else { return }
        focus.set(next, keyboard: true, why: delta > 0 ? "down" : "up")
    }

    /// Return in the search box: the focused row, else the first hit or the first title match.
    private func openFocusedHit() {
        if let id = focus.id, walkIds.contains(id) { primary(id); return }
        if let hit = session.searchHits?.first { actions.openJarheadHit(hit); return }
        let q = ConsoleSession.searchKey(session.searchQuery)
        if let chain = jarhead.first(where: { !$0.isTrashed && $0.displayTitle.lowercased().contains(q) }) {
            withAnimation(Motion.snappy) { actions.openJarheadConversation(chain) }
        }
    }

    /// The pointer over a row re-syncs the keyboard's highlight (one highlight, two sources).
    private func hover(_ id: String) -> (Bool) -> Void { { if $0 { focus.hovered(id) } } }

    /// The selected row's ground: `RailSelection` on the one matched geometry id.
    @ViewBuilder
    private func selected(_ on: Bool) -> some View {
        if on { RailSelection(namespace: selection) }
    }

    // MARK: - Jarhead

    @ViewBuilder
    private func jarheadSection(now: Double) -> some View {
        let nowOn = session.showsNow
        // The elapsed time ticks by the second while a session runs; otherwise the row is still.
        TimelineView(.periodic(from: .now, by: self.now.ticks ? 1 : 3600)) { tick in
            JarheadNowRow(info: self.now, now: tick.date.timeIntervalSince1970 * 1000, on: nowOn,
                          focused: focus.ringOn(AgentsRailWords.nowId), hovered: hover(AgentsRailWords.nowId),
                          verbsOpen: focus.verbsOpen == AgentsRailWords.nowId, closeVerbs: focus.closeVerbs,
                          select: { withAnimation(Motion.snappy) { actions.showNow() } },
                          newConversation: { actions.cleanup(.newConversation) },
                          clear: { actions.cleanup(.clearNow(at: ConsoleFormat.nowMs)) })
        }
        .background { selected(nowOn) }

        // Threads: Jarhead's lines of work right now — the ones waiting on Kevin first, then
        // the busy ones, the idle main, the finished within the linger. A row opens the
        // thread's pane (its own cards, steps, screenshots, Allow / Deny, composer); the main
        // thread's row is the same conversation as Now seen as a thread. Stop per row.
        if showsThreads {
            threadsHead(total: threads.count, busy: threads.filter { $0.status.isBusy }.count, asks: threads.filter { $0.status == .waitingKevin }.count).padding(.top, 8)
                .transition(Motion.appear)
            ForEach(threads) { thread in threadRow(thread, now: now) }
        }

        if !pinnedChains.isEmpty {
            Section {
                ForEach(pinnedChains) { chain in chainRow(chain, now: now) }
            } header: {
                ConsoleGroupHead(title: ConsoleDisclosureWords.pinned, count: "\(pinnedChains.count)").padding(.top, 8)
            }
            .transition(Motion.appear)
        }

        // Today (open) and Yesterday (closed) under sticky folding heads; every older day inside one closed
        // `Older` head, its days top-level Sections after it so each still pins while it scrolls.
        let placed = placedDays(now: Date(timeIntervalSince1970: now / 1000))
        ForEach(placed.filter { $0.place != .older }) { day in daySection(day, now: now) }
        let older = placed.filter { $0.place == .older }
        if !older.isEmpty {
            Section { EmptyView() } header: { olderHead(older).padding(.top, 8) }
                .transition(Motion.appear)
            if isFoldOpen(RailWords.olderId) {
                ForEach(older) { day in daySection(day, now: now) }
            }
        }

        if !archived.isEmpty {
            ConsoleDisclosure(id: AgentsRailWords.archivedId, title: ConsoleDisclosureWords.archived, count: "\(archived.count)",
                              summary: ConsoleDisclosureSummary.chains(count: archived.count, billedSeconds: archived.reduce(0) { $0 + $1.usageSeconds }),
                              open: $session.archivedOpen, focused: focus.ringOn(AgentsRailWords.archivedId)) {
                ForEach(archived) { chain in chainRow(chain, now: now) }
            }
            .padding(.top, 8)
            .transition(Motion.appear)
        }

        if !trashed.isEmpty {
            // The trash folder in Finder: what is in it is Kevin's to empty, there — never here.
            ConsoleDisclosure(id: AgentsRailWords.trashId, title: ConsoleDisclosureWords.trash, count: "\(trashed.count)",
                              summary: ConsoleDisclosureSummary.fold(inside: trash.map(ConsoleFormat.trashLine)),
                              open: $session.trashOpen, trailing: trash.map { AnyView(trashFolder($0)) }, focused: focus.ringOn(AgentsRailWords.trashId)) {
                ForEach(trashed) { chain in chainRow(chain, now: now) }
            }
            .padding(.top, 8)
            .transition(Motion.appear)
        }
    }

    /// A day's rows under its sticky head while the head is open; the head alone while it is folded.
    private func daySection(_ day: PlacedDay, now: Double) -> some View {
        let id = RailWords.dayId(day.group.day)
        let open = isFoldOpen(id)
        return Section {
            if open { ForEach(day.group.chains) { chain in chainRow(chain, now: now) } }
        } header: {
            dayHead(day, id: id, open: open, now: now).padding(.top, 8)
        }
        .transition(Motion.appear)
    }

    /// `⌄ Today 2` · `› Yesterday 5 … 26 min`: the word, the count, the billed figure while closed; the tip
    /// carries the full date (inside Older) and the newest title.
    private func dayHead(_ day: PlacedDay, id: String, open: Bool, now: Double) -> some View {
        let chains = day.group.chains
        let billed = chains.reduce(0) { $0 + $1.usageSeconds }
        let title = ConsoleFormat.day(day.group.day, now: Date(timeIntervalSince1970: now / 1000))
        let tipTitle = day.place == .older ? ConsoleFormat.fullDay(day.group.day) : title
        return ConsoleGroupHead(title: title, count: "\(chains.count)",
                                figure: open ? nil : ConsoleDisclosureSummary.text(ConsoleDisclosureSummary.day(billedSeconds: billed)),
                                folded: !open, toggle: { fold(id, !open) }, altToggle: { foldOtherDays(keeping: id) }, focused: focus.ringOn(id),
                                tip: RailWords.dayTip(title: tipTitle, count: chains.count, billed: billed, newest: RailWords.newestTitle(chains)))
            .id(id)
    }

    /// `› Older 31 … since Aug 2`: every day before yesterday behind one head; the figure is the oldest day inside.
    private func olderHead(_ older: [PlacedDay]) -> some View {
        let id = RailWords.olderId
        let open = isFoldOpen(id)
        let count = older.reduce(0) { $0 + $1.group.chains.count }
        let oldest = older.last?.group.day ?? ""
        return ConsoleGroupHead(title: ConsoleDisclosureWords.older, count: "\(count)",
                                figure: open ? nil : ConsoleDisclosureSummary.text(ConsoleDisclosureSummary.older(since: oldest)),
                                folded: !open, toggle: { fold(id, !open) }, altToggle: { foldOtherDays(keeping: id) }, focused: focus.ringOn(id),
                                tip: RailWords.olderTip(count: count, since: ConsoleFormat.shortDay(oldest)))
            .id(id)
    }

    private func trashFolder(_ trash: TrashInfo) -> some View {
        Button { actions.open(trash.path) } label: {
            Image(systemName: "folder.fill").font(.system(size: 11, weight: .medium))
        }
        .buttonStyle(ConsoleButtonStyle(kind: .plain, iconOnly: true, height: 20))
        .consoleHelp(AgentsRailWords.revealHelp)
        .accessibilityLabel(AgentsRailWords.revealTrash)
    }

    /// One thread's row, wired: a click opens its pane (or, open already, goes back to Now); the
    /// menu's Stop / Pause / Resume act on that thread alone. No ⌘-click selection: nothing to trash.
    private func threadRow(_ thread: WorkThread, now: Double) -> some View {
        let open = session.openThreadId == thread.id
        let id = AgentsRailWords.threadId(thread.id)
        return ThreadRow(thread: thread, now: now, open: open, focused: focus.ringOn(id), hovered: hover(id), verbsOpen: focus.verbsOpen == id, closeVerbs: focus.closeVerbs,
                         toggle: {
                             withAnimation(Motion.wipeAnimation) {
                                 if open { actions.showNow() } else { session.openThread(thread.id) }
                             }
                         },
                         stop: { actions.send(.threadStop(threadId: thread.id)) },
                         pause: { actions.send(.threadPause(threadId: thread.id)) },
                         resume: { actions.send(.threadResume(threadId: thread.id)) })
            .background { selected(open) }
            .id(AgentsRailWords.threadId(thread.id))
            .transition(Motion.appear)
    }

    /// 24pt: the section's symbol, "Threads", and "3 · 1 asks" (else "3 · 2 running", else "3") in mono.
    private func threadsHead(total: Int, busy: Int, asks: Int) -> some View {
        let count = ConsoleFormat.threadsCount(total: total, busy: busy, asks: asks)
        return HStack(spacing: iconGap) {
            ConsoleIcon(name: ConsoleTheme.threadsSymbol)
            Text("Threads").font(ConsoleTheme.sans(12, .medium)).foregroundStyle(ConsoleTheme.titanium).lineLimit(1)
            Spacer(minLength: 4)
            Text(count).font(ConsoleTheme.mono(11)).monospacedDigit().foregroundStyle(ConsoleTheme.titanium)
                .contentTransition(ConsoleMotion.numeric)
                .lineLimit(1)
        }
        .padding(.horizontal, railInset)
        .frame(height: 24)
        .animation(Motion.snappy, value: count)
        .consoleHelp(AgentsRailWords.threadsHelp)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Threads, \(count)")
    }

    /// One past conversation's row, wired: open on a plain click, select on ⌘ / ⇧, the menus' verbs, the inline rename.
    /// `lifted` (a search result) brings a quiet or back row to full alpha; the open row lifts on its own.
    private func chainRow(_ chain: JarheadChain, now: Double, lifted: Bool = false) -> some View {
        let open = session.openJarheadSessionId == chain.id
        let picked = session.selectedChainIds.contains(chain.id)
        // One of several picked: its menu acts on the whole selection (Finder's rule).
        let multi = picked && selectedChains.count > 1 ? selectionVerbs(selectedChains) : (ChainVerbs(), SelectionMenu())
        let id = AgentsRailWords.chainId(chain.id)
        return JarheadChainRow(chain: chain, now: now, open: open, tone: RailTone.conversation(chain, now: now), lifted: lifted || open,
                               picked: picked, renaming: session.renamingChainId == chain.id,
                               focused: focus.ringOn(id), verbs: verbs(chain), selection: multi.1, selectionVerbs: multi.0,
                               hovered: hover(id), verbsOpen: focus.verbsOpen == id, closeVerbs: focus.closeVerbs,
                               pick: { flags in
                                   if session.pickChain(chain.id, modifiers: flags, visible: visibleOrder) { return }
                                   withAnimation(Motion.snappy) {
                                       if open { actions.showNow() } else { actions.openJarheadConversation(chain) }
                                   }
                               })
            .background { selected(open && !picked) }
            .id(AgentsRailWords.chainId(chain.id))
            .transition(Motion.appear)
    }

    /// The verbs behind a chain row's menu, the ⋯ and the strip — one place, so every site agrees.
    private func verbs(_ chain: JarheadChain) -> ChainVerbs {
        ChainVerbs(
            rename: { withAnimation(Motion.snappy) { session.renamingChainId = chain.id } },
            commitRename: { name in
                session.renamingChainId = nil
                if name.trimmingCharacters(in: .whitespacesAndNewlines) != (chain.name ?? "") { actions.cleanup(.rename(chain, to: name)) }
            },
            cancelRename: { withAnimation(Motion.snappy) { session.renamingChainId = nil } },
            pin: { actions.cleanup(.pin(chain, !chain.pinned)) },
            archive: { actions.cleanup(.archive([chain])) },
            trash: { actions.cleanup(.trash([chain])) },
            restore: { actions.cleanup(.restore([chain])) })
    }

    /// The verbs behind a picked row's menu while several are picked — the strip's rules:
    /// Archive the active ones, Move to Trash whatever is not there yet, Restore the archived
    /// and trashed; each lets the selection go. Rename and Pin are one row's and stay out.
    private func selectionVerbs(_ chains: [JarheadChain]) -> (ChainVerbs, SelectionMenu) {
        let active = chains.filter(\.isActive)
        let trashable = chains.filter { !$0.isTrashed }
        let inactive = chains.filter { !$0.isActive }
        var v = ChainVerbs()
        v.archive = { withAnimation(Motion.gentle) { session.clearSelection() }; actions.cleanup(.archive(active)) }
        v.trash = { withAnimation(Motion.gentle) { session.clearSelection() }; actions.cleanup(.trash(trashable)) }
        v.restore = { withAnimation(Motion.gentle) { session.clearSelection() }; actions.cleanup(.restore(inactive)) }
        return (v, SelectionMenu(count: chains.count, canArchive: !active.isEmpty, canTrash: !trashable.isEmpty, canRestore: !inactive.isEmpty))
    }

    // MARK: - Search

    /// The ledger's hits grouped by conversation — the chain's row, then up to four hits
    /// under it, each opening the conversation on that row — after the conversations whose
    /// title matches on its own. Hits in the live session open Now; hits nobody on the rail
    /// owns are listed by day. The trash is left to the daemon (it searches the live ledger).
    @ViewBuilder
    private func searchResults(now: Double) -> some View {
        let q = ConsoleSession.searchKey(session.searchQuery)
        let hits = session.searchHits ?? []
        let groups = SearchGroups.build(hits: hits, chains: jarhead, liveSessionId: self.now.sessionId)
        let hitChains = Set(groups.compactMap { $0.chain?.id })
        let titleOnly = jarhead.filter { !$0.isTrashed && !hitChains.contains($0.id) && $0.displayTitle.lowercased().contains(q) }

        if session.searching && hits.isEmpty && titleOnly.isEmpty {
            HStack(spacing: 8) {
                ConsoleGlyphs(cols: 8, rows: 1)
                Text("Searching…").font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg3)
            }
            .padding(.horizontal, railInset).frame(height: 28)
            .transition(.opacity)
        } else if let gap = session.searchGap, titleOnly.isEmpty {
            ConsoleEmpty(gap.line)
                .transition(.opacity)
        } else if hits.isEmpty && titleOnly.isEmpty && session.searchHits != nil {
            ConsoleEmpty("No hits for “\(session.searchQuery.trimmingCharacters(in: .whitespaces))”.")
                .transition(.opacity)
        }

        // Folds are suspended, not changed: every result is flat, lifted to 1.0, and keeps its orb's tint.
        if !titleOnly.isEmpty {
            ConsoleGroupHead(title: AgentsRailWords.titles, count: "\(titleOnly.count)")
                .transition(Motion.appear)
            ForEach(titleOnly) { chain in chainRow(chain, now: now, lifted: true) }
        }

        let owned = groups.filter { $0.chain != nil || $0.isNow }.count
        if owned > 0 {
            ConsoleGroupHead(title: RailWords.hits, count: "\(owned)")
                .padding(.top, titleOnly.isEmpty ? 0 : 8)
                .transition(Motion.appear)
        }
        ForEach(groups) { group in
            VStack(alignment: .leading, spacing: 0) {
                if let chain = group.chain {
                    chainRow(chain, now: now, lifted: true)
                } else if group.isNow {
                    JarheadNowRow(info: self.now, now: now, on: session.showsNow,
                                  focused: focus.ringOn(AgentsRailWords.nowId), hovered: hover(AgentsRailWords.nowId),
                                  verbsOpen: focus.verbsOpen == AgentsRailWords.nowId, closeVerbs: focus.closeVerbs,
                                  select: { withAnimation(Motion.snappy) { actions.showNow() } },
                                  newConversation: { actions.cleanup(.newConversation) },
                                  clear: { actions.cleanup(.clearNow(at: ConsoleFormat.nowMs)) })
                } else {
                    ConsoleGroupHead(title: ConsoleFormat.day(group.day))
                }
                ForEach(group.hits.prefix(hitsPerChain)) { hit in
                    SearchHitRow(hit: hit, focused: focus.ringOn(AgentsRailWords.hitId(hit.id)), hovered: hover(AgentsRailWords.hitId(hit.id))) { actions.openJarheadHit(hit) }
                        .id(AgentsRailWords.hitId(hit.id))
                }
                if group.hits.count > hitsPerChain {
                    Button {
                        if let chain = group.chain { withAnimation(Motion.snappy) { actions.openJarheadConversation(chain) } }
                    } label: {
                        Text(String(format: AgentsRailWords.more, group.hits.count - hitsPerChain))
                            .font(ConsoleTheme.mono(11)).monospacedDigit().foregroundStyle(ConsoleTheme.titanium)
                            .padding(.leading, textInset).frame(height: 20)
                    }
                    .buttonStyle(.plain)
                    .consoleHelp("Open the conversation")
                }
            }
            .padding(.top, 8)
            .transition(Motion.appear)
        }

        // The agents the query names (name · project · detail · tool), as 28 rows in their tone, lifted.
        let matched = agentMatches(q)
        if !matched.isEmpty {
            ConsoleHairline().padding(.top, 12)
            ConsoleSectionHead(RailWords.agents, count: matched.count).padding(.top, 4)
                .transition(Motion.appear)
            ForEach(matched) { agent in agentRow(agent, now: now, hidden: hiddenAgents.contains(agent.id), lifted: true) }
        }
    }

    // MARK: - Agents

    /// A tool's sessions under a fold whose closed head carries the count and the one exceptional
    /// word — the `[1 asks]` badge — then the resting item (`2 working` · `3 idle` · `ended · 40m`); open by
    /// default iff a row of its asks or works, remembered per tool. Inside: the live rows, then the over
    /// rows folded under `Ended n` — or listed directly when nothing is alive (a fold never holds only a fold).
    private func groupView(_ group: Group, now: Double) -> some View {
        let id = AgentsRailWords.groupId(group.tool)
        let live = group.agents.filter(AgentsRail.live), over = group.agents.filter { !AgentsRail.live($0) }
        let endedId = RailWords.endedId(group.tool)
        return ConsoleDisclosure(id: id, title: group.tool.label, count: "\(group.agents.count)", summary: Self.groupSummary(group.agents, now: now),
                                 defaultOpen: group.agents.contains(where: AgentsRail.hot), siblings: groups.map { AgentsRailWords.groupId($0.tool) }, focused: focus.ringOn(id)) {
            ForEach(live) { agent in agentRow(agent, now: now, hidden: false) }
            if !live.isEmpty, !over.isEmpty {
                EndedFold(id: endedId, count: over.count, newestAge: over.first.map { ConsoleFormat.relative($0.updatedAt, now: now) },
                          open: isFoldOpen(endedId), focused: focus.ringOn(endedId), toggle: { fold(endedId, !isFoldOpen(endedId)) }) {
                    ForEach(over) { agent in agentRow(agent, now: now, hidden: false) }
                }
            } else {
                ForEach(over) { agent in agentRow(agent, now: now, hidden: false) }
            }
        }
    }

    /// The folded head's words: how many ask, then how many work (else idle); nothing alive → `ended` and the newest over row's age.
    static func groupSummary(_ agents: [AgentInfo], now: Double) -> [ConsoleDisclosureSummaryItem] {
        let over = agents.filter { rank($0.status) == 3 }
        return ConsoleDisclosureSummary.agents(asks: agents.filter { $0.status == .blocked }.count, working: agents.filter { $0.status == .working }.count,
                                               idle: agents.filter { $0.status == .idle }.count, ended: over.count,
                                               newestEndedAge: over.first.map { ConsoleFormat.relative($0.updatedAt, now: now) })
    }

    /// "Hidden (n)", folded: the rows Kevin took off the rail, each with Unhide.
    private func hiddenGroup(now: Double) -> some View {
        ConsoleDisclosure(id: AgentsRailWords.hiddenId, title: ConsoleDisclosureWords.hidden, count: "\(hiddenRows.count)",
                          open: $session.hiddenAgentsOpen, focused: focus.ringOn(AgentsRailWords.hiddenId)) {
            ForEach(hiddenRows) { agent in agentRow(agent, now: now, hidden: true) }
        }
    }

    private func agentRow(_ agent: AgentInfo, now: Double, hidden: Bool, lifted: Bool = false) -> some View {
        let open = session.openAgentId == agent.id
        let id = AgentsRailWords.agentId(agent.id)
        return AgentRowView(agent: agent, now: now, open: open, tone: RailTone.agent(status: agent.status, hidden: hidden), lifted: lifted || open,
                            hidden: hidden, focused: focus.ringOn(id),
                            hovered: hover(id), verbsOpen: focus.verbsOpen == id, closeVerbs: focus.closeVerbs,
                            toggle: {
                                // The pane switch in the wipe's own animation (Motion.wipeAnimation): the
                                // curtain over the arriving pane runs exactly that long.
                                withAnimation(Motion.wipeAnimation) {
                                    if open { actions.showNow() } else { session.openAgent(agent.id) }
                                }
                            },
                            hide: { actions.cleanup(.hide(agent, !hidden)) })
            .background { selected(open) }
            .id(AgentsRailWords.agentId(agent.id))
            .transition(Motion.appear)
    }

    /// A connector that is not running: its icon in red and its reason, no rows.
    private func downView(_ connector: ConnectorHealth) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: iconGap) {
                ConsoleIcon(name: ConsoleTheme.kindSymbol(connector.kind), tint: ConsoleTheme.error)
                Text(ConsoleTheme.kindTitle(connector.kind))
                    .font(ConsoleTheme.sans(12, .medium)).foregroundStyle(ConsoleTheme.titanium)
                    .lineLimit(1)
                Spacer(minLength: 4)
            }
            .padding(.horizontal, railInset)
            .frame(height: 24)
            .accessibilityLabel("\(ConsoleTheme.kindTitle(connector.kind)), down")
            Text(connector.detail)
                .font(ConsoleTheme.sans(11)).foregroundStyle(ConsoleTheme.fg3)
                .lineLimit(2).truncationMode(.tail)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.leading, textInset).padding(.trailing, railInset).padding(.bottom, 4)
                .consoleHelp(connector.detail)
        }
    }
}

/// `› Ended 1 … 7m` inside an open tool group: the over rows behind one closed sub-head (22, a
/// `ConsoleGroupHead`), the newest row's age as its figure while closed; drawn only under live rows.
private struct EndedFold<Content: View>: View {
    let id: String
    let count: Int
    let newestAge: String?
    let open: Bool
    var focused = false
    let toggle: () -> Void
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ConsoleGroupHead(title: ConsoleDisclosureWords.ended, count: "\(count)", figure: open ? nil : newestAge, folded: !open, toggle: toggle,
                             focused: focused, tip: ConsoleDisclosureWords.ended(count))
                .padding(.top, 4)
            if open {
                content()
                    .transition(Motion.appear)
            }
        }
        .animation(Motion.snappy, value: open)
        .id(id)
    }
}

// MARK: - The head: the title, or the search box

/// 40pt. At rest the section head — "Jarhead", the count, a magnifier; while searching the
/// `ConsoleFilterField` (the magnifier inside, `k of n`, × while text) with the closing × in the
/// same row. The two crossfade (Motion.swap); ⌘F (the root's key equivalent) and the magnifier
/// open it and put the caret in the field, Esc closes it, ↑↓ walk the hits and Return opens the
/// focused one.
private struct JarheadRailHead: View {
    let count: Int?
    /// `k of n` while the search has answered.
    var hitCount: String? = nil
    /// ↑↓ from the field: the hits' highlight moves.
    var move: (Int) -> Void = { _ in }
    let openFocused: () -> Void
    /// `7 conversations · 2 archived · 2 in the Trash` — what the count leaves out.
    var tip: String? = nil

    @EnvironmentObject private var session: ConsoleSession
    @Environment(\.consoleActions) private var actions
    @FocusState private var focused: Bool

    var body: some View {
        ZStack {
            if session.searchOpen {
                HStack(spacing: iconGap) {
                    ConsoleFilterField(text: Binding(get: { session.searchQuery }, set: { actions.search($0) }), placeholder: AgentsRailWords.searchPlaceholder,
                                       count: hitCount, focus: $focused, accessibilityLabel: AgentsRailWords.searchPlaceholder,
                                       onMove: { if $0 == .down { move(1) } else if $0 == .up { move(-1) } }, onSubmit: openFocused,
                                       onExit: { withAnimation(Motion.gentle) { session.closeSearch() } })
                        .animation(Motion.snappy, value: hitCount)
                    Button { withAnimation(Motion.gentle) { session.closeSearch() } } label: {
                        Image(systemName: "xmark").font(.system(size: 10, weight: .semibold))
                    }
                    .buttonStyle(ConsoleButtonStyle(kind: .plain, iconOnly: true, height: 24))
                    .consoleHelp(AgentsRailWords.closeSearch, key: "Esc")
                    .accessibilityLabel(AgentsRailWords.closeSearch)
                }
                .padding(.leading, railInset).padding(.trailing, 8)
                .transition(Motion.swap)
                .onAppear { DispatchQueue.main.async { focused = true } }
            } else {
                ConsoleSectionHead("Jarhead", count: count) {
                    Button { withAnimation(Motion.gentle) { session.openSearch() } } label: {
                        Image(systemName: "magnifyingglass").font(.system(size: 12, weight: .semibold))
                    }
                    .buttonStyle(ConsoleButtonStyle(kind: .plain, iconOnly: true, height: 24))
                    .consoleHelp(HelpCopy.search.hint, key: HelpCopy.search.key)
                    .accessibilityLabel(HelpCopy.search.name)
                }
                .modifier(ConsoleOptionalTip(tip: tip))
                .padding(.trailing, -4)
                .transition(Motion.swap)
            }
        }
        .frame(height: 40)
        .animation(Motion.gentle, value: session.searchOpen)
        .onChange(of: session.searchFocusRequest) { DispatchQueue.main.async { focused = true } }
    }
}

// MARK: - The selection strip

/// 28pt under the head while more than one chain is picked: the count and the verbs that
/// apply to all of them — Archive and Move to Trash while any is active, Restore while any
/// is archived or trashed — and ×. Words when they fit, the solid symbols when they do not.
private struct SelectionStrip: View {
    let chains: [JarheadChain]

    @EnvironmentObject private var session: ConsoleSession
    @Environment(\.consoleActions) private var actions

    private var active: [JarheadChain] { chains.filter(\.isActive) }
    private var inactive: [JarheadChain] { chains.filter { !$0.isActive } }
    /// Trashing an archived conversation is allowed; trashing a trashed one is nothing.
    private var trashable: [JarheadChain] { chains.filter { !$0.isTrashed } }

    var body: some View {
        VStack(spacing: 0) {
            // Three fits, widest first: the count in words with the verbs in words; the count
            // as a figure with the verbs in words; the figure with the verbs as symbols.
            ViewThatFits(in: .horizontal) {
                strip(count: "\(chains.count) selected", words: true)
                strip(count: "\(chains.count)", words: true)
                strip(count: "\(chains.count)", words: false)
            }
            .padding(.horizontal, railInset)
            .frame(height: 28)
            .animation(Motion.snappy, value: chains.count)
            ConsoleHairline()
        }
        .background(ConsoleTheme.raised)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(chains.count) conversations selected")
    }

    private func strip(count: String, words: Bool) -> some View {
        HStack(spacing: 6) {
            ConsoleIcon(name: "checkmark.circle.fill", tint: ConsoleTheme.accent, size: 11)
            Text(count)
                .font(ConsoleTheme.sans(12, .medium)).monospacedDigit().foregroundStyle(ConsoleTheme.fg)
                .contentTransition(ConsoleMotion.numeric)
                .lineLimit(1)
                .fixedSize()
            Spacer(minLength: 4)
            HStack(spacing: 6) { verbs(words: words) }
                .fixedSize()
            Button { withAnimation(Motion.gentle) { session.clearSelection() } } label: {
                Image(systemName: "xmark").font(.system(size: 10, weight: .semibold))
            }
            .buttonStyle(ConsoleButtonStyle(kind: .plain, iconOnly: true, height: 22))
            .consoleHelp("Clear the selection")
            .accessibilityLabel("Clear the selection")
        }
    }

    @ViewBuilder
    private func verbs(words: Bool) -> some View {
        if !active.isEmpty {
            verb("Archive", "archivebox.fill", words: words, help: "Archive the selected conversations") {
                let picked = active
                withAnimation(Motion.gentle) { session.clearSelection() }
                actions.cleanup(.archive(picked))
            }
        }
        if !trashable.isEmpty {
            verb("Move to Trash", "trash.fill", words: words, help: "Move the selected conversations to the Trash") {
                let picked = trashable
                withAnimation(Motion.gentle) { session.clearSelection() }
                actions.cleanup(.trash(picked))
            }
        }
        if !inactive.isEmpty {
            verb("Restore", "arrow.uturn.backward", words: words, help: "Bring the selected conversations back") {
                let picked = inactive
                withAnimation(Motion.gentle) { session.clearSelection() }
                actions.cleanup(.restore(picked))
            }
        }
    }

    private func verb(_ title: String, _ symbol: String, words: Bool, help: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            if words { Text(title) } else { Image(systemName: symbol).font(.system(size: 11, weight: .medium)) }
        }
        .buttonStyle(ConsoleButtonStyle(kind: .ghost, iconOnly: !words, height: 22, small: true))
        .consoleHelp(help)
        .accessibilityLabel(title)
    }
}

// MARK: - Jarhead rows

/// The selected row's ground and its 2pt accent bar. One view for the whole rail: every
/// row that is selected hosts it under the same matched geometry id, so when the
/// selection moves the highlight glides from the old row to the new one (Motion.snappy
/// from the click) instead of blinking off here and on there.
private struct RailSelection: View {
    let namespace: Namespace.ID

    var body: some View {
        ZStack(alignment: .leading) {
            Rectangle().fill(ConsoleTheme.active)
            Rectangle().fill(ConsoleTheme.accent).frame(width: 2).padding(.vertical, 4)
        }
        .matchedGeometryEffect(id: "rail-selection", in: namespace)
    }
}

/// A row's trailing status: the word sans 11 fg3 — with the glyph table's working dot (cyan, pulsing)
/// before it, or an age in mono after it (`idle · 31m`) — or the `asks` badge while it waits on Kevin;
/// the two crossfade. Room for the ⋯ at rest follows it.
private struct RailStatusZone: View {
    let asks: Bool
    let word: String
    let key: String
    /// The working dot before the word.
    var dot = false
    /// `31m` after the word, mono titanium.
    var age: String? = nil

    var body: some View {
        ZStack {
            if asks {
                ConsoleBadge(word: .asks).transition(.opacity)
            } else {
                HStack(spacing: 6) {
                    if dot { ConsoleDot(color: ConsoleTheme.status(.working).color, live: true, size: 6).transition(.opacity) }
                    wordText
                }
                .transition(.opacity)
            }
        }
        .layoutPriority(1)
        .animation(Motion.fade, value: key)
        Color.clear.frame(width: ConsoleRow.overflowWidth, height: 20)
    }

    /// `idle` · `idle · 31m`: the word sans fg3, the dot and the age in mono titanium.
    private var wordText: some View {
        var text = Text(word).font(ConsoleTheme.sans(11)).foregroundStyle(ConsoleTheme.fg3)
        if let age {
            text = text + Text(ConsoleDisclosureWords.joiner).font(ConsoleTheme.sans(11)).foregroundStyle(ConsoleTheme.fg3)
                + Text(age).font(ConsoleTheme.mono(11)).foregroundStyle(ConsoleTheme.titanium)
        }
        return text.lineLimit(1).contentTransition(.opacity)
    }
}

/// The rail's reflow animations, one modifier so the body stays short.
private struct RailAnimations: ViewModifier {
    let agents: [String]
    let layout: [String]
    let threads: [String]
    let down: [AgentKind]
    let hidden: Set<String>
    let folds: [Bool]
    let foldTick: Int
    let selection: String

    func body(content: Content) -> some View {
        content
            .animation(Motion.gentle, value: agents)
            .animation(Motion.gentle, value: layout)
            .animation(Motion.gentle, value: threads)
            .animation(Motion.gentle, value: down)
            .animation(Motion.gentle, value: hidden)
            .animation(Motion.gentle, value: folds)
            .animation(Motion.snappy, value: foldTick)
            .animation(Motion.snappy, value: selection)
    }
}

/// The strip's arrival, and a chain that left the list (a day file moved) letting go of its selection or rename.
private struct RailHousekeeping: ViewModifier {
    let selecting: Bool
    let ids: [String]

    @EnvironmentObject private var session: ConsoleSession

    func body(content: Content) -> some View {
        content
            .animation(Motion.gentle, value: selecting)
            .onChange(of: ids) { _, ids in
                let known = Set(ids)
                let stale = session.selectedChainIds.filter { !known.contains($0) }
                if !stale.isEmpty { session.selectedChainIds.subtract(stale) }
                if let renaming = session.renamingChainId, !known.contains(renaming) { session.renamingChainId = nil }
            }
    }
}

/// The live conversation: "Now", the phase dot, and elapsed · billed (or why not). The
/// meter's digits roll as the seconds pass; the dot and the pause glyph crossfade; the session's
/// short id is the row's mono stamp. Its menu (right-click, or the ⋯ at rest): New conversation
/// (the open session closes like a stop; the next Go starts a fresh chain) and Clear (the
/// stream's items hide; the ledger keeps them; Undo brings them back).
struct JarheadNowRow: View {
    let info: JarheadNowInfo
    let now: Double
    let on: Bool
    var focused = false
    var hovered: (Bool) -> Void = { _ in }
    var verbsOpen = false
    var closeVerbs: () -> Void = {}
    let select: () -> Void
    var newConversation: () -> Void = {}
    var clear: () -> Void = {}

    @State private var hovering = false

    var body: some View {
        Button(action: select) {
            label
                .padding(EdgeInsets(top: 4, leading: railInset, bottom: 6, trailing: railInset))
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .background(!on && hovering ? ConsoleTheme.hover : Color.clear)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay(alignment: .topTrailing) {
            ConsoleRowOverflow(verbs: verbs).padding(.top, 4).padding(.trailing, railInset)
        }
        .modifier(ConsoleFocusRing(on: focused))
        .contextMenu { ConsoleVerbMenu(verbs: verbs) }
        .onHover { hovering = $0; hovered($0) }
        .animation(ConsoleMotion.hover, value: hovering)
        .consoleHelp(AgentsRailWords.liveConversation)
        .modifier(ConsoleVerbFloat(id: AgentsRailWords.nowId, verbs: verbs, open: verbsOpen, close: closeVerbs))
        .accessibilityLabel("Now, \(info.meta(now: now))")
        .accessibilityHint(on ? "On screen" : "Shows the live stream")
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    /// The mark, "Now", the id stamp, the phase dot (or the pause glyph), the meta line.
    private var label: some View {
        let meta = info.meta(now: now)
        let quiet = info.sessionId == nil
        return HStack(alignment: .top, spacing: iconGap) {
            // Blue while a session runs or a pause holds one; titanium's grey while nothing is live.
            ZStack { JarheadMark(quiet: quiet).id(quiet).transition(.opacity) }
                .frame(width: 20, height: 20)
                .animation(Motion.fade, value: quiet)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 8) {
                    Text(AgentsRailWords.now)
                        .font(ConsoleTheme.sans(13, on ? .medium : .regular)).foregroundStyle(ConsoleTheme.fg)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    if let id = info.sessionId {
                        Text(ConsoleFormat.shortId(id)).font(ConsoleTheme.mono(11)).foregroundStyle(ConsoleTheme.titanium).lineLimit(1)
                            .layoutPriority(1)
                    }
                    phaseGlyph
                    Color.clear.frame(width: ConsoleRow.overflowWidth, height: 20)
                }
                .frame(height: 20)
                Text(meta)
                    .font(ConsoleTheme.mono(11)).monospacedDigit()
                    .foregroundStyle(ConsoleTheme.fg3)
                    .lineLimit(1).truncationMode(.tail)
                    .contentTransition(ConsoleMotion.numeric)
                    .animation(Motion.snappy, value: meta)
            }
        }
    }

    /// The phase dot while a session runs, the pause glyph while paused; they crossfade.
    private var phaseGlyph: some View {
        let phaseMeta = ConsoleTheme.phase(info.phase)
        return ZStack {
            if info.paused {
                ConsoleIcon(name: "pause.fill", tint: ConsoleTheme.titanium)
                    .consoleHelp(phaseMeta.hint)
                    .accessibilityLabel("Paused")
                    .transition(.opacity)
            } else if info.sessionId != nil {
                ConsoleDot(color: phaseMeta.color, live: ConsoleTheme.livePhases.contains(info.phase), size: 6)
                    .frame(width: 20, height: 20)
                    .consoleHelp(phaseMeta.hint)
                    .accessibilityLabel(phaseMeta.label)
                    .transition(.opacity)
            }
        }
        .animation(Motion.fade, value: info.paused)
        .animation(Motion.fade, value: info.sessionId)
    }

    /// New conversation · Clear (nothing to clear without a session: the engine appends no row
    /// then, and the feed's "Asleep. Press Go." must stay in front of any cleared state).
    private var verbs: [ConsoleVerb] {
        [ConsoleVerb(id: "new", title: "New conversation", run: newConversation),
         ConsoleVerb(id: "clear", title: "Clear", disabled: info.sessionId == nil, run: clear)]
    }
}

/// One thread: the status glyph on the icon column, the name (medium while its pane is open),
/// the status word at the right — the `asks` badge while it waits on Kevin — the ⋯ at rest, and
/// one mono meta line, `00:12 · screen · 7 steps`, the seconds rolling while it is live. The
/// thread's card is `ConsoleTipCard.thread` — the one the stream's chip and the right rail show.
/// The menu (right-click, or the ⋯): Open, Stop (`thread.stop`, this thread only; main parks its
/// turn), and for a spawned thread Pause / Resume. Never a Delete: a finished thread ages off the
/// rail and lives in the ledger.
struct ThreadRow: View {
    let thread: WorkThread
    let now: Double
    let open: Bool
    var focused = false
    var hovered: (Bool) -> Void = { _ in }
    var verbsOpen = false
    var closeVerbs: () -> Void = {}
    let toggle: () -> Void
    var stop: () -> Void = {}
    var pause: () -> Void = {}
    var resume: () -> Void = {}

    @State private var hovering = false

    private var meta: ConsoleTheme.ThreadMeta { ConsoleTheme.thread(thread.status) }
    private var isMain: Bool { thread.id == "main" }
    private var asks: Bool { thread.status == .waitingKevin }

    var body: some View {
        Button(action: toggle) {
            HStack(alignment: .top, spacing: iconGap) {
                ConsoleThreadGlyph(status: thread.status)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 8) {
                        Text(thread.name)
                            .font(ConsoleTheme.sans(13, open ? .medium : .regular)).foregroundStyle(ConsoleTheme.fg)
                            .lineLimit(1).truncationMode(.tail)
                        Spacer(minLength: 4)
                        // The word turns as the thread works, waits and finishes; a badge while it asks.
                        RailStatusZone(asks: asks, word: meta.label, key: meta.label)
                    }
                    .frame(height: 20)
                    metaLine
                }
            }
            .padding(EdgeInsets(top: 4, leading: railInset, bottom: 6, trailing: railInset))
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // A finished thread sits back (the ladder's quiet step); the words stay legible, the hover ground stays at full.
        .opacity(RailTone.thread(thread.status).alpha)
        .background(!open && hovering ? ConsoleTheme.hover : Color.clear)
        .overlay(alignment: .topTrailing) {
            ConsoleRowOverflow(verbs: verbs).padding(.top, 4).padding(.trailing, railInset)
        }
        .modifier(ConsoleFocusRing(on: focused))
        .contextMenu { ConsoleVerbMenu(verbs: verbs) }
        .onHover { hovering = $0; hovered($0) }
        .animation(ConsoleMotion.hover, value: hovering)
        .animation(Motion.fade, value: thread.status.isLive)
        // The one thread card (ConsoleTipCard.thread): the stream's chip and the right rail draw the same.
        .consoleHelp(id: AgentsRailWords.threadTip(thread.id), card: .thread(thread), edge: .trailing)
        .modifier(ConsoleVerbFloat(id: AgentsRailWords.threadTip(thread.id), verbs: verbs, open: verbsOpen, close: closeVerbs))
        .accessibilityLabel("Thread \(thread.name), \(meta.label)")
        .accessibilityHint(open ? "Open in the centre" : "Opens the thread")
        .accessibilityAddTraits(open ? .isSelected : [])
    }

    /// `00:12 · screen · 7 steps`, rolling while the thread is live; frozen at its end after.
    @ViewBuilder private var metaLine: some View {
        if thread.status.isLive {
            TimelineView(.periodic(from: .now, by: 1)) { ctx in
                metaText(now: ctx.date.timeIntervalSince1970 * 1000)
            }
        } else {
            metaText(now: thread.doneAt ?? thread.updatedAt)
        }
    }

    private func metaText(now: Double) -> some View {
        let text = ConsoleFormat.threadMeta(thread, now: now)
        return Text(text)
            .font(ConsoleTheme.mono(11)).monospacedDigit()
            .foregroundStyle(ConsoleTheme.fg3)
            .lineLimit(1).truncationMode(.tail)
            .contentTransition(ConsoleMotion.numeric)
            .animation(Motion.snappy, value: text)
    }

    /// Open · Pause / Resume (a spawned, busy thread) · Stop — one array for the ⋯ and the context menu.
    private var verbs: [ConsoleVerb] {
        var out = [ConsoleVerb(id: "open", title: open ? "Back to Now" : "Open", run: toggle)]
        guard thread.status.isLive else { return out }
        if !isMain, thread.status != .idle {
            out.append(thread.status == .paused ? ConsoleVerb(id: "resume", title: "Resume", run: resume) : ConsoleVerb(id: "pause", title: "Pause", run: pause))
        }
        if thread.canStop { out.append(ConsoleVerb(id: "stop", title: isMain ? "Stop this turn" : "Stop \(thread.name)", separatorBefore: true, run: stop)) }
        return out
    }
}

/// The verbs a chain row offers (AgentsRail.verbs builds them once per chain).
struct ChainVerbs {
    var rename: () -> Void = {}
    var commitRename: (String) -> Void = { _ in }
    var cancelRename: () -> Void = {}
    var pin: () -> Void = {}
    var archive: () -> Void = {}
    var trash: () -> Void = {}
    var restore: () -> Void = {}
}

/// A picked row's menu while several are picked: how many, and which of the three
/// selection verbs apply to at least one of them (AgentsRail.selectionVerbs).
struct SelectionMenu: Equatable {
    var count = 0
    var canArchive = false
    var canTrash = false
    var canRestore = false
    /// The menu acts on the selection, not the row.
    var active: Bool { count > 1 }
}

/// One past conversation at 28 — a session, or a resume chain folded into it: the mark (blue
/// while it can still change, titanium's grey once it is over), the title, a `×n` figure when it
/// was resumed, the started clock, the ⋯. The tone (`RailTone`) sets the mark and the row's alpha;
/// `lifted` (stepped into, or a search result) brings the alpha to 1.0 and keeps the mark. `picked`
/// is the multi-selection (the mark becomes a check on the active ground); `renaming` swaps the
/// title for a field. An archived or trashed row carries Restore. The meta (`ran · billed · msgs`)
/// is the card's now.
struct JarheadChainRow: View {
    let chain: JarheadChain
    let now: Double
    let open: Bool
    var tone: RailTone = .bright
    var lifted = false
    var picked = false
    var renaming = false
    var focused = false
    var verbs = ChainVerbs()
    /// While this row is one of several picked: the menu's verbs act on all of them.
    var selection = SelectionMenu()
    var selectionVerbs = ChainVerbs()
    var hovered: (Bool) -> Void = { _ in }
    var verbsOpen = false
    var closeVerbs: () -> Void = {}
    /// The click, with the modifier flags held (⌘ / ⇧ select; a plain click opens).
    var pick: (NSEvent.ModifierFlags) -> Void = { _ in }

    @State private var hovering = false

    private var title: String { chain.displayTitle.isEmpty ? "—" : chain.displayTitle }

    /// `12:34 · 2.3 min · 8 msgs` — duration, billed, heard + said: spoken (AX) and on the card, not drawn.
    private var metaLine: String {
        ConsoleFormat.jarheadMeta(chain)
    }

    /// The row's alpha: the tone's, lifted to 1.0 while Kevin reads it or found it.
    private var alpha: CGFloat { lifted ? 1 : tone.alpha }

    /// The story of a chain in one card: the name, the first line heard, `ran · billed · msgs`,
    /// `date · reason`, the sessions a → b → c, and where it sits (Pinned, the Trash since …, Archived).
    static func card(_ chain: JarheadChain) -> ConsoleTipCard {
        var card = ConsoleTipCard(title: chain.name ?? (chain.title.isEmpty ? AgentsRailWords.nothingHeard : chain.title))
        if chain.name != nil { card.lines.append(chain.title.isEmpty ? AgentsRailWords.nothingHeard : chain.title) }
        if chain.resumes > 0 { card.badge = .word(AgentsRailWords.resumed(chain.resumes)) }
        if chain.pinned && chain.isActive { card.status = RailWords.pinnedStatus }
        card.foot.append(ConsoleTipCard.Row(key: RailWords.ran, value: ConsoleFormat.jarheadMeta(chain)))
        card.foot.append(ConsoleTipCard.Row(key: AgentsRailWords.started, value: ConsoleFormat.fullDate(chain.startedAt) + " · " + (chain.isOpen ? "open" : ConsoleFormat.closeReason(chain.reason))))
        if chain.resumes > 0 {
            card.foot.append(ConsoleTipCard.Row(key: AgentsRailWords.sessions, value: "\(chain.sessions.count): " + chain.sessions.map { ConsoleFormat.shortId($0.id) }.joined(separator: " → ")))
        }
        if chain.isTrashed { card.status = AgentsRailWords.inTrash + (chain.trashedAt.map { " since \(ConsoleFormat.fullDate($0))" } ?? "") }
        if chain.isArchived { card.status = AgentsRailWords.archivedWord }
        return card
    }

    var body: some View {
        Group {
            if renaming {
                renameRow
            } else {
                row
            }
        }
        .contextMenu { ConsoleVerbMenu(verbs: menuVerbs) }
        .animation(Motion.snappy, value: renaming)
    }

    private var row: some View {
        Button(action: { pick(NSApp.currentEvent?.modifierFlags.intersection(.deviceIndependentFlagsMask) ?? []) }) {
            HStack(alignment: .top, spacing: iconGap) {
                mark
                titleRow
            }
            .padding(EdgeInsets(top: 4, leading: railInset, bottom: 4, trailing: railInset))
            .frame(maxWidth: .infinity, minHeight: 28, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // The tone's alpha (over 0.72 · back 0.48), lifted while read; the grounds, the verbs and the ring stay at full.
        .opacity(alpha)
        .animation(Motion.fade, value: alpha)
        .background(picked ? ConsoleTheme.active : (!open && hovering ? ConsoleTheme.hover : Color.clear))
        .overlay(alignment: .topTrailing) {
            // The same columns as the label's title row: Restore where the label left room, the
            // stamp (the label's own), then the ⋯ at rest.
            HStack(spacing: 8) {
                if !chain.isActive {
                    Button(AgentsRailWords.restore, action: verbs.restore)
                        .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 20, small: true))
                        .frame(width: restoreWidth)
                        .consoleHelp(chain.isTrashed ? "Back from the Trash" : "Back from Archived")
                        // Past the stamp (≈ 34) and the two gaps, so it lands where the label left room.
                        .padding(.trailing, 38)
                }
                ConsoleRowOverflow(verbs: menuVerbs)
            }
            .padding(.top, 4).padding(.trailing, railInset)
        }
        .modifier(ConsoleFocusRing(on: focused))
        .onHover { hovering = $0; hovered($0) }
        .animation(ConsoleMotion.hover, value: hovering)
        .animation(Motion.fade, value: picked)
        .consoleHelp(id: AgentsRailWords.chainTip(chain.id), card: Self.card(chain), edge: .trailing)
        .modifier(ConsoleVerbFloat(id: AgentsRailWords.chainTip(chain.id), verbs: menuVerbs, open: verbsOpen, close: closeVerbs))
        .accessibilityLabel("Jarhead conversation, \(title), \(metaLine)" + (chain.isTrashed ? ", in the Trash" : chain.isArchived ? ", archived" : "") + (picked ? ", selected" : ""))
        .accessibilityHint(open ? "Open in the stream" : "Opens the conversation; ⌘-click selects")
        .accessibilityAddTraits(open || picked ? .isSelected : [])
    }

    /// The mark in the tone's ramp, or a check while the row is one of several picked; each swap crossfades.
    private var mark: some View {
        ZStack {
            if picked {
                ConsoleIcon(name: "checkmark.circle.fill", tint: ConsoleTheme.accent).transition(.opacity)
            } else {
                JarheadMark(quiet: tone.quietMark).id(tone.quietMark).transition(.opacity)
            }
        }
        .frame(width: 20, height: 20)
        .animation(Motion.fade, value: picked)
        .animation(Motion.fade, value: tone.quietMark)
    }

    /// The title, the `×n` figure, room for Restore, the started clock, room for the ⋯ — 20 tall.
    private var titleRow: some View {
        HStack(spacing: 8) {
            Text(title)
                .font(ConsoleTheme.sans(13, open ? .medium : .regular)).foregroundStyle(ConsoleTheme.fg)
                .lineLimit(1).truncationMode(.tail)
                .contentTransition(.opacity)
                .animation(Motion.fade, value: title)
            Spacer(minLength: 4)
            if chain.resumes > 0 {
                ConsoleBadge(word: .figure(RailWords.resumedFigure(chain.resumes)))
                    .consoleHelp(RailWords.resumedTip(chain.resumes))
                    .accessibilityLabel(RailWords.resumedTip(chain.resumes))
                    .layoutPriority(1)
            }
            if !chain.isActive {
                // Room for the Restore in the overlay (its width, left of the trailing zone).
                Color.clear.frame(width: restoreWidth, height: 20)
            }
            // When it began, right-aligned as a stamp; the day head says which day.
            // The ⋯ sits after it at rest (the overlay, above the button).
            Text(ConsoleFormat.clock(chain.startedAt))
                .font(ConsoleTheme.mono(11)).monospacedDigit().foregroundStyle(ConsoleTheme.titanium)
                .lineLimit(1)
                .layoutPriority(1)
            Color.clear.frame(width: ConsoleRow.overflowWidth, height: 20)
        }
        .frame(height: 20)
    }

    /// The title as a field in the 28 row. Return commits, Esc cancels, an empty field is back
    /// to the auto title; the focus leaving commits too.
    private var renameRow: some View {
        HStack(alignment: .top, spacing: iconGap) {
            JarheadMark(quiet: tone.quietMark)
            RenameField(initial: chain.name ?? "", placeholder: chain.title.isEmpty ? "Name" : chain.title,
                        commit: verbs.commitRename, cancel: verbs.cancelRename)
                .frame(height: 20)
        }
        .padding(EdgeInsets(top: 4, leading: railInset, bottom: 4, trailing: railInset))
        .frame(maxWidth: .infinity, minHeight: 28, alignment: .leading)
        .background(ConsoleTheme.active)
        .transition(.opacity)
        .accessibilityLabel("Renaming \(title)")
    }

    /// The verbs for the ⋯ and the context menu. Finder's rule: a menu on one of several picked
    /// rows acts on the whole selection, the words carrying the count the way the toast will.
    private var menuVerbs: [ConsoleVerb] {
        if selection.active {
            var out: [ConsoleVerb] = []
            if selection.canArchive { out.append(ConsoleVerb(id: "archive", title: "Archive \(selection.count)", run: selectionVerbs.archive)) }
            if selection.canTrash { out.append(ConsoleVerb(id: "trash", title: "Move \(selection.count) to Trash", run: selectionVerbs.trash)) }
            if selection.canRestore { out.append(ConsoleVerb(id: "restore", title: "Restore \(selection.count)", run: selectionVerbs.restore)) }
            return out
        }
        if chain.isActive {
            return [ConsoleVerb(id: "rename", title: "Rename", run: verbs.rename),
                    ConsoleVerb(id: "pin", title: chain.pinned ? "Unpin" : "Pin", run: verbs.pin),
                    ConsoleVerb(id: "archive", title: "Archive", separatorBefore: true, run: verbs.archive),
                    ConsoleVerb(id: "trash", title: "Move to Trash", run: verbs.trash)]
        }
        var out = [ConsoleVerb(id: "restore", title: AgentsRailWords.restore, run: verbs.restore), ConsoleVerb(id: "rename", title: "Rename", run: verbs.rename)]
        if chain.isArchived { out.append(ConsoleVerb(id: "trash", title: "Move to Trash", separatorBefore: true, run: verbs.trash)) }
        return out
    }
}

/// The inline rename: a 20pt field in the title's place, focused as it appears. The
/// field editor's own Undo (⌘Z while typing) is the text's; the rename itself is undone
/// from the toast or Edit › Undo once committed.
private struct RenameField: View {
    let initial: String
    let placeholder: String
    let commit: (String) -> Void
    let cancel: () -> Void

    @State private var text = ""
    @State private var done = false
    @FocusState private var focused: Bool

    var body: some View {
        TextField(placeholder, text: $text)
            .consoleField(height: 20, focused: focused)
            .focused($focused)
            .onSubmit { finish { commit(text) } }
            .onExitCommand { finish(cancel) }
            .onChange(of: focused) { _, on in
                // The focus leaving (a click elsewhere) commits, once.
                if !on { finish { commit(text) } }
            }
            .onAppear {
                text = initial
                DispatchQueue.main.async { focused = true }
            }
            .consoleHelp(AgentsRailWords.renameHelp)
            .accessibilityLabel("Conversation name")
    }

    private func finish(_ body: () -> Void) {
        guard !done else { return }
        done = true
        body()
    }
}

/// One search hit under its conversation: the clock, who (or what), the snippet. Opens the
/// conversation scrolled to the row.
private struct SearchHitRow: View {
    let hit: LedgerHit
    var focused = false
    var hovered: (Bool) -> Void = { _ in }
    let open: () -> Void

    @State private var hovering = false

    /// The hit whole: `date · day` and the text.
    static func card(_ hit: LedgerHit) -> ConsoleTipCard {
        ConsoleTipCard(title: ConsoleFormat.fullDate(hit.at) + (hit.day.map { " · \($0)" } ?? ""), badge: .word(AgentsRailWords.hitType(hit.type)), lines: [hit.text])
    }

    /// Kevin's line, Jarhead's, a delegation's request, its summary (the ledger's four hit kinds).
    private var symbol: String {
        switch hit.type {
        case "heard": return "person.fill"
        case "said": return "waveform"
        case "request", "delegation", "delegation.created": return "bolt.fill"
        case "summary", "delegation.finished": return "checkmark.circle.fill"
        case "problem": return "exclamationmark.triangle.fill"
        default: return hit.speaker == "kevin" ? "person.fill" : (hit.speaker == "jarhead" ? "waveform" : "text.alignleft")
        }
    }

    private var tint: Color {
        switch hit.type {
        case "said": return ConsoleTheme.speaking
        case "summary", "delegation.finished": return ConsoleTheme.acting
        case "problem": return ConsoleTheme.error
        default: return ConsoleTheme.titanium
        }
    }

    var body: some View {
        Button(action: open) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(ConsoleFormat.clock(hit.at))
                    .font(ConsoleTheme.mono(11)).monospacedDigit().foregroundStyle(ConsoleTheme.fg3)
                    .frame(width: 34, alignment: .trailing)
                Image(systemName: symbol).font(.system(size: 9, weight: .medium)).foregroundStyle(tint)
                    .frame(width: 12)
                Text(hit.text.isEmpty ? "…" : ConversationFormat.oneLine(hit.text, max: 160))
                    .font(ConsoleTheme.sans(11)).lineSpacing(1).foregroundStyle(ConsoleTheme.fg2)
                    .lineLimit(2).truncationMode(.tail)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                // The type as a word: the glyph tint's legend.
                ConsoleBadge(word: .word(AgentsRailWords.hitType(hit.type)), width: 58)
            }
            .padding(EdgeInsets(top: 3, leading: textInset - 6, bottom: 3, trailing: railInset))
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(hovering ? ConsoleTheme.hover : Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .modifier(ConsoleFocusRing(on: focused))
        .onHover { hovering = $0; hovered($0) }
        .animation(ConsoleMotion.hover, value: hovering)
        .consoleHelp(id: AgentsRailWords.hitTip(hit.id), card: Self.card(hit), edge: .trailing)
        .accessibilityLabel("Hit at \(ConsoleFormat.time(hit.at)): \(hit.text)")
        .accessibilityHint("Opens the conversation at this row")
    }
}

/// Hits grouped by the conversation that holds them: the chain on the rail, the live
/// session (Now), or — for a session the rail does not list — its day.
struct SearchGroups: Identifiable {
    let chain: JarheadChain?
    let isNow: Bool
    let day: String
    var hits: [LedgerHit]
    var id: String { chain?.id ?? (isNow ? "now" : "day:\(day)") }

    static func build(hits: [LedgerHit], chains: [JarheadChain], liveSessionId: String?) -> [SearchGroups] {
        var order: [String] = []
        var map: [String: SearchGroups] = [:]
        for hit in hits {
            // The live session is Now first, whatever chain list a caller hands over.
            let isNow = hit.sessionId == liveSessionId
            let chain = isNow ? nil : chains.first { $0.id == hit.chainId || $0.contains(hit.sessionId) }
            let day = hit.day ?? ConsoleFormat.dayString(hit.at)
            let group = SearchGroups(chain: chain, isNow: isNow, day: day, hits: [])
            if map[group.id] == nil { order.append(group.id); map[group.id] = group }
            map[group.id]?.hits.append(hit)
        }
        // Newest conversation first, like the rail; hits inside in ledger order.
        return order.compactMap { map[$0] }
            .map { g in var g = g; g.hits.sort { $0.at < $1.at }; return g }
            .sorted { ($0.hits.last?.at ?? 0) > ($1.hits.last?.at ?? 0) }
    }
}

// MARK: - Agent rows

/// One agent session: 44 while it asks or works (the brand mark, the name, `[asks]` or the working
/// dot + word, the ⋯, one mono meta line `project · age`), 28 otherwise (the mark — titanium once the
/// process is gone — the name, `idle · 31m` or the one word, the ⋯). The tone (`RailTone`) sets the
/// mark and the row's alpha; `lifted` (its pane open, or a search result) brings the alpha to 1.0.
/// The connector's detail, the message count, the hint and the working directory are the row's card.
struct AgentRowView: View {
    let agent: AgentInfo
    let now: Double
    let open: Bool
    var tone: RailTone = .bright
    var lifted = false
    /// In the folded "Hidden" group: with Unhide.
    var hidden = false
    var focused = false
    var hovered: (Bool) -> Void = { _ in }
    var verbsOpen = false
    var closeVerbs: () -> Void = {}
    let toggle: () -> Void
    /// Hide (or, in the Hidden group, unhide) this row. Never touches the tool's files.
    var hide: () -> Void = {}

    @State private var hovering = false

    private var tool: AgentTool { agent.resolvedTool }

    /// The row is 44 with a meta line while a figure on it ticks (it asks or works); 28 otherwise.
    private var tall: Bool { AgentsRail.hot(agent) }

    /// `project · 2m` — the 44 row's meta line.
    private var metaLine: String {
        ConsoleFormat.agentMetaShort(agent, now: now)
    }

    /// The row's alpha: the tone's, lifted to 1.0 while its pane is open or the search found it.
    private var alpha: CGFloat { lifted ? 1 : tone.alpha }

    /// `name [asks] · detail · 42 msgs · 31m · quiet · cwd`.
    static func card(_ agent: AgentInfo, now: Double) -> ConsoleTipCard {
        var card = ConsoleTipCard(title: agent.name)
        if agent.status == .blocked { card.badge = .asks } else { card.status = AgentsRailWords.status(agent.status) }
        if let d = agent.detail, !d.isEmpty { card.lines.append(d) }
        card.lines.append(ConsoleFormat.agentCardLine(agent, now: now))
        if let cwd = agent.cwd, !cwd.isEmpty { card.foot.append(ConsoleTipCard.Row(key: AgentsRailWords.cwd, value: ConsoleFormat.truncPath(cwd, max: 48))) }
        card.last = ConsoleTipCard.Row(key: ConsoleRowWords.opensPane, value: ConsoleRowWords.returnKey)
        return card
    }

    var body: some View {
        Button(action: toggle) {
            label
                .padding(EdgeInsets(top: 4, leading: railInset, bottom: tall ? 6 : 4, trailing: railInset))
                .frame(maxWidth: .infinity, minHeight: tall ? 44 : 28, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // The tone's alpha (idle 0.72 · over 0.48), lifted while read; the hover ground, the verbs and the ring stay at full.
        .opacity(alpha)
        .animation(Motion.fade, value: alpha)
        .background(!open && hovering ? ConsoleTheme.hover : Color.clear)
        .overlay(alignment: .topTrailing) { controls.padding(.top, 4).padding(.trailing, railInset) }
        .modifier(ConsoleFocusRing(on: focused))
        .contextMenu { ConsoleVerbMenu(verbs: verbs) }
        .onHover { hovering = $0; hovered($0) }
        .animation(ConsoleMotion.hover, value: hovering)
        .animation(Motion.snappy, value: tall)
        .consoleHelp(id: AgentsRailWords.agentTip(agent.id), card: Self.card(agent, now: now), edge: .trailing)
        .modifier(ConsoleVerbFloat(id: AgentsRailWords.agentTip(agent.id), verbs: verbs, open: verbsOpen, close: closeVerbs))
        .accessibilityLabel("\(agent.name), \(tool.label), \(agent.status.rawValue)" + (hidden ? ", hidden" : ""))
        .accessibilityHint(open ? "Open in the stream" : "Opens the conversation")
        .accessibilityAddTraits(open ? .isSelected : [])
    }

    /// The mark (titanium while the tone is back), the name, the status zone, and on a tall row the meta line.
    private var label: some View {
        HStack(alignment: .top, spacing: iconGap) {
            BrandMark(tool: tool, quiet: tone == .back)
            VStack(alignment: .leading, spacing: 2) {
                titleRow
                if tall {
                    Text(metaLine)
                        .font(ConsoleTheme.mono(11)).monospacedDigit()
                        .foregroundStyle(ConsoleTheme.fg3)
                        .lineLimit(1).truncationMode(.tail)
                        .contentTransition(ConsoleMotion.numeric)
                        .animation(Motion.snappy, value: metaLine)
                        .transition(.opacity)
                }
            }
        }
    }

    /// The name, room for Unhide, then the status zone: `[asks]` · `● working` · `idle · 31m` · the word alone.
    private var titleRow: some View {
        HStack(spacing: 8) {
            Text(agent.name)
                .font(ConsoleTheme.sans(13, open ? .medium : .regular)).foregroundStyle(ConsoleTheme.fg)
                .lineLimit(1).truncationMode(.tail)
            Spacer(minLength: 4)
            // Room for the Unhide in the overlay.
            if hidden { Color.clear.frame(width: restoreWidth, height: 20) }
            RailStatusZone(asks: agent.status == .blocked, word: AgentsRailWords.status(agent.status), key: agent.status.rawValue,
                           dot: agent.status == .working, age: agent.status == .idle ? ConsoleFormat.relative(agent.updatedAt, now: now) : nil)
        }
        .frame(height: 20)
    }

    /// Above the button: Unhide where the label left room, then the ⋯ at rest.
    private var controls: some View {
        HStack(spacing: 8) {
            if hidden {
                Button(AgentsRailWords.unhide, action: hide)
                    .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 20, small: true))
                    .frame(width: restoreWidth)
                    .consoleHelp("Back on the rail")
                    .padding(.trailing, statusWidth)
            }
            ConsoleRowOverflow(verbs: verbs)
        }
    }

    /// Roughly what the status word takes, so a hidden row's Unhide sits left of it.
    private var statusWidth: CGFloat {
        if agent.status == .blocked { return 44 }
        let word = AgentsRailWords.status(agent.status).count + (agent.status == .idle ? 6 : 0)
        return CGFloat(word) * 6 + 8
    }

    private var verbs: [ConsoleVerb] {
        [ConsoleVerb(id: "hide", title: hidden ? AgentsRailWords.unhide : AgentsRailWords.hide, run: hide)]
    }
}

extension ConsoleFormat {
    /// The rail's meta line: `project · 42 msgs · 2m · quiet`. The project is the working
    /// directory's last component; a count of one reads "1 msg"; the age is computed here from
    /// `updatedAt` inside the rail's 15 s TimelineView (the connector's `detail` carries no
    /// relative time any more — it churned a snapshot a second); the hint is the connector's one
    /// word on why the status is what it is, skipped when it only repeats the status glyph.
    static func agentMeta(_ agent: AgentInfo, now: Double) -> String {
        var parts: [String] = []
        if let project = projectName(agent.cwd) { parts.append(project) }
        if let n = agent.messageCount { parts.append(messageCount(n)) }
        parts.append(relative(agent.updatedAt, now: now))
        if let hint = hintWord(agent) { parts.append(hint) }
        return parts.joined(separator: " · ")
    }

    /// The hint when it adds to the glyph: "resumed" on a run, "archived" on a done one, "unseen"
    /// when the process evidence was degraded; nil when it is the glyph's own word — ended on
    /// ended, blocked on blocked, running on working, quiet on idle (the plain dot already says
    /// so, and a fourth part pushes the age off the rail).
    static func hintWord(_ agent: AgentInfo) -> String? {
        guard let hint = agent.hint?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), !hint.isEmpty else { return nil }
        if hint == agent.status.rawValue { return nil }
        if hint == "running", agent.status == .working { return nil }
        if hint == "quiet", agent.status == .idle { return nil }
        return hint
    }

    /// The 28 row's meta: `project · age` — the count and the hint moved to the card.
    static func agentMetaShort(_ agent: AgentInfo, now: Double) -> String {
        var parts: [String] = []
        if let project = projectName(agent.cwd) { parts.append(project) }
        parts.append(relative(agent.updatedAt, now: now))
        return parts.joined(separator: " · ")
    }

    /// What the row lost, as one card line: `42 msgs · 31m · quiet` (the hint whole, even when it repeats the word).
    static func agentCardLine(_ agent: AgentInfo, now: Double) -> String {
        var parts: [String] = []
        if let n = agent.messageCount { parts.append(messageCount(n)) }
        parts.append(relative(agent.updatedAt, now: now))
        if let hint = agent.hint?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), !hint.isEmpty { parts.append(hint) }
        return parts.joined(separator: " · ")
    }

    /// A folded head's billed figure: `7.5 min` under ten, `26 min` under an hour, `1.4 h` past it.
    static func billedShort(_ seconds: Double) -> String {
        let m = max(0, seconds.isFinite ? seconds : 0) / 60
        if m < 10 { return String(format: "%.1f min", m) }
        if m < 60 { return "\(Int(m.rounded())) min" }
        return String(format: "%.1f h", m / 60)
    }

    /// A Jarhead conversation's meta line: `12:34 · 2.3 min · 8 msgs` — how long it ran
    /// ("—" while never closed), what it billed (the meter's spelling, one decimal),
    /// heard + said. The started clock is the title row's stamp.
    static func jarheadMeta(_ chain: JarheadChain) -> String {
        let ran = chain.endedAt.map { duration(max(0, $0 - chain.startedAt) / 1000) } ?? "—"
        return [ran, TransportFormat.minutes(chain.usageSeconds), messageCount(chain.messages)].joined(separator: " · ")
    }

    /// "42 msgs" / "1 msg" — the one spelling, in the rail and the conversation header.
    static func messageCount(_ n: Int) -> String { n == 1 ? "1 msg" : "\(n) msgs" }

    /// "/Users/kevinliu/gt/apps/api" → "api"; "~" for the home folder; nil when unset.
    static func projectName(_ cwd: String?) -> String? {
        guard let cwd, !cwd.isEmpty else { return nil }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        if cwd == home || cwd == home + "/" { return "~" }
        let last = cwd.split(separator: "/", omittingEmptySubsequences: true).last.map(String.init)
        return (last?.isEmpty ?? true) ? nil : last
    }

    private static let dayStringFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    /// Wall clock ms → "2026-09-10", the ledger's day (local).
    static func dayString(_ ms: Double) -> String {
        dayStringFormatter.string(from: Date(timeIntervalSince1970: ms / 1000))
    }
}
