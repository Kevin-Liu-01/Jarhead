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
// folded the one exceptional word — `1 [asks]` — with the resting count) and 44pt rows: the
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
/// The title row's right-hand zone: the clock stamp at rest, the ⋯ while hovering.
private let trailingZone: CGFloat = 40
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
    // The cards' keys.
    static let started = "started"
    static let lane = "lane"
    static let steps = "steps"
    static let budget = "budget"
    static let sessions = "sessions"
    static let inTrash = "In the Trash"
    static let archivedWord = "Archived"
    static let cwd = "cwd"
    static let nothingHeard = "Nothing heard"
    /// The Threads head's tip and the rename field's — ≤ 60 characters, no "you", no "Kevin".
    static let threadsHelp = "Threads asking first, then busy, then finished (5 min kept)"
    static let renameHelp = "Return keeps the name; Esc cancels; empty is the auto title"
    static let mainThread = "the main conversation, as a thread"
    static func turns(_ n: Int) -> String { n == 1 ? "1 turn" : "\(n) turns" }
    static func budgetLine(steps: Int, seconds: Int) -> String { "\(steps) steps / \(seconds) s" }
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

    private static func rank(_ s: AgentStatus) -> Int {
        switch s {
        case .working, .blocked, .idle: return 0
        case .done, .ended, .unknown, .offline: return 1
        }
    }

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

    /// Every chain row on screen, top to bottom — what a ⇧-click ranges over.
    private var visibleOrder: [String] {
        var out = pinnedChains.map(\.id)
        for group in days { out += group.chains.map(\.id) }
        if session.archivedOpen { out += archived.map(\.id) }
        if session.trashOpen { out += trashed.map(\.id) }
        return out
    }

    private var selectedChains: [JarheadChain] { jarhead.filter { session.selectedChainIds.contains($0.id) } }

    /// Connectors that are down: a head with the reason, whatever sessions exist.
    private var down: [ConnectorHealth] {
        ConsoleTheme.kindOrder.compactMap { kind in connectors.first { $0.kind == kind && !$0.ok } }
            + connectors.filter { !$0.ok && !ConsoleTheme.kindOrder.contains($0.kind) }
    }

    /// The rows reflow when a chain changes place — a pin, an archive, a trash, a restore, a rename.
    private var layoutKey: [String] {
        jarhead.map { "\($0.id)|\($0.state)|\($0.pinned)|\($0.displayTitle)" }
    }

    var body: some View {
        VStack(spacing: 0) {
            // The head owns its bottom rule; it meets the right rail's tab row at the same height.
            JarheadRailHead(count: jarhead.isEmpty ? nil : jarhead.count, hitCount: hitCount, move: { step($0) }, openFocused: openFocusedHit)
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
                                                         primary: primary, fold: fold, escape: escape))
                        .modifier(railAnimations)
                        .onChange(of: focus.id) { _, id in
                            if let id, focus.keyboard { withAnimation(Motion.snappy) { proxy.scrollTo(id, anchor: nil) } }
                        }
                    }
                }
                .thinScrollers()
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: ConsoleFoldStore.changed)) { _ in foldTick += 1 }
        .modifier(railHousekeeping)
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

    private var agentsHead: some View {
        ConsoleSectionHead("Agents", count: visibleAgents.isEmpty ? nil : visibleAgents.count) {
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
    }

    /// Rows arriving and leaving (a new session, a conversation closing, one moved to the Trash)
    /// fade and rise or drop with Motion.appear while the rest reflow; the selection glides to
    /// wherever it moved, click or not.
    private var railAnimations: RailAnimations {
        RailAnimations(agents: agents.map(\.id), layout: layoutKey, threads: threadsKey, down: down.map(\.kind), hidden: hiddenAgents,
                       folds: [session.archivedOpen, session.trashOpen, session.hiddenAgentsOpen, session.isSearching], selection: selectionKey)
    }

    private var railHousekeeping: RailHousekeeping {
        RailHousekeeping(selecting: selectedChains.count > 1, ids: jarhead.map(\.id))
    }

    // MARK: - keys (ConsoleListKeys)

    /// Every row and head on screen, top to bottom — what ↑↓ walk; folded groups leave their rows out.
    private var walkIds: [String] {
        _ = foldTick
        if session.isSearching { return searchWalk }
        var out = [AgentsRailWords.nowId] + threads.map { AgentsRailWords.threadId($0.id) }
        out += pinnedChains.map { AgentsRailWords.chainId($0.id) }
        for group in days { out += group.chains.map { AgentsRailWords.chainId($0.id) } }
        if !archived.isEmpty { out.append(AgentsRailWords.archivedId); if session.archivedOpen { out += archived.map { AgentsRailWords.chainId($0.id) } } }
        if !trashed.isEmpty { out.append(AgentsRailWords.trashId); if session.trashOpen { out += trashed.map { AgentsRailWords.chainId($0.id) } } }
        for group in groups {
            out.append(AgentsRailWords.groupId(group.tool))
            if ConsoleFoldStore.isOpen(AgentsRailWords.groupId(group.tool), default: true) { out += group.agents.map { AgentsRailWords.agentId($0.id) } }
        }
        if !hiddenRows.isEmpty { out.append(AgentsRailWords.hiddenId); if session.hiddenAgentsOpen { out += hiddenRows.map { AgentsRailWords.agentId($0.id) } } }
        return out
    }

    /// The search's rows: the title matches, then each group's row and its hits.
    private var searchWalk: [String] {
        let q = ConsoleSession.searchKey(session.searchQuery)
        let groups = SearchGroups.build(hits: session.searchHits ?? [], chains: jarhead, liveSessionId: self.now.sessionId)
        let hitChains = Set(groups.compactMap { $0.chain?.id })
        var out = jarhead.filter { !$0.isTrashed && !hitChains.contains($0.id) && $0.displayTitle.lowercased().contains(q) }.map { AgentsRailWords.chainId($0.id) }
        for group in groups {
            if let chain = group.chain { out.append(AgentsRailWords.chainId(chain.id)) } else if group.isNow { out.append(AgentsRailWords.nowId) }
            out += group.hits.prefix(hitsPerChain).map { AgentsRailWords.hitId($0.id) }
        }
        return out
    }

    private var headIds: Set<String> {
        Set([AgentsRailWords.archivedId, AgentsRailWords.trashId, AgentsRailWords.hiddenId] + groups.map { AgentsRailWords.groupId($0.tool) })
    }

    /// `k of n`: conversations the search matched, of every conversation on the rail.
    private var hitCount: String? {
        guard session.isSearching, session.searchHits != nil else { return nil }
        let matched = Set(searchWalk.filter { !$0.hasPrefix("hit:") })
        return ConsoleRowWords.count(shown: matched.count, of: jarhead.count + 1)
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
            withAnimation(Motion.snappy) { if session.openJarheadSessionId == chain.id { actions.showNow() } else { actions.openJarheadConversation(chain) } }
        } else if let agent = agents.first(where: { AgentsRailWords.agentId($0.id) == id }) {
            withAnimation(Motion.wipeAnimation) { if session.openAgentId == agent.id { actions.showNow() } else { session.openAgent(agent.id) } }
        } else if let thread = threads.first(where: { AgentsRailWords.threadId($0.id) == id }) {
            withAnimation(Motion.wipeAnimation) { if session.openThreadId == thread.id { actions.showNow() } else { session.openThread(thread.id) } }
        } else if let hit = (session.searchHits ?? []).first(where: { AgentsRailWords.hitId($0.id) == id }) {
            actions.openJarheadHit(hit)
        }
    }

    private func isFoldOpen(_ id: String) -> Bool {
        switch id {
        case AgentsRailWords.archivedId: return session.archivedOpen
        case AgentsRailWords.trashId: return session.trashOpen
        case AgentsRailWords.hiddenId: return session.hiddenAgentsOpen
        default: return ConsoleFoldStore.isOpen(id, default: true)
        }
    }

    /// → / ← on a head: the store posts, the disclosure (bound or remembered) follows.
    private func fold(_ id: String, _ open: Bool) { ConsoleFoldStore.set(id, open) }

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
            threadsHead(total: threads.count, busy: threads.filter { $0.status.isBusy }.count).padding(.top, 8)
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

        // A day's rows under a sticky head: the day in words, its count, the date in mono.
        ForEach(days) { group in
            Section {
                ForEach(group.chains) { chain in chainRow(chain, now: now) }
            } header: {
                ConsoleGroupHead(title: ConsoleFormat.day(group.day), count: "\(group.chains.count)", figure: group.day).padding(.top, 8)
            }
            .transition(Motion.appear)
        }

        if !archived.isEmpty {
            ConsoleDisclosure(id: AgentsRailWords.archivedId, title: ConsoleDisclosureWords.archived, count: "\(archived.count)",
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
        return ThreadRow(thread: thread, now: now, open: open, focused: focus.ringOn(AgentsRailWords.threadId(thread.id)), hovered: hover(AgentsRailWords.threadId(thread.id)),
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

    /// 24pt: the section's symbol, "Threads", and "3 · 2 running" in mono.
    private func threadsHead(total: Int, busy: Int) -> some View {
        let count = ConsoleFormat.threadsCount(total: total, busy: busy)
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
    private func chainRow(_ chain: JarheadChain, now: Double) -> some View {
        let open = session.openJarheadSessionId == chain.id
        let picked = session.selectedChainIds.contains(chain.id)
        // One of several picked: its menu acts on the whole selection (Finder's rule).
        let multi = picked && selectedChains.count > 1 ? selectionVerbs(selectedChains) : (ChainVerbs(), SelectionMenu())
        return JarheadChainRow(chain: chain, now: now, open: open, picked: picked, renaming: session.renamingChainId == chain.id,
                               focused: focus.ringOn(AgentsRailWords.chainId(chain.id)), verbs: verbs(chain), selection: multi.1, selectionVerbs: multi.0,
                               hovered: hover(AgentsRailWords.chainId(chain.id)),
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

        if !titleOnly.isEmpty {
            ConsoleGroupHead(title: AgentsRailWords.titles, count: "\(titleOnly.count)")
                .transition(Motion.appear)
            ForEach(titleOnly) { chain in chainRow(chain, now: now) }
        }

        ForEach(groups) { group in
            VStack(alignment: .leading, spacing: 0) {
                if let chain = group.chain {
                    chainRow(chain, now: now)
                } else if group.isNow {
                    JarheadNowRow(info: self.now, now: now, on: session.showsNow,
                                  select: { withAnimation(Motion.snappy) { actions.showNow() } },
                                  newConversation: { actions.cleanup(.newConversation) },
                                  clear: { actions.cleanup(.clearNow(at: ConsoleFormat.nowMs)) })
                } else {
                    ConsoleGroupHead(title: ConsoleFormat.day(group.day), figure: group.day)
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
    }

    // MARK: - Agents

    /// A tool's sessions under a fold whose closed head carries the count and the one exceptional
    /// word — `1 [asks]` — then the resting count (`2 working`); open by default, remembered per tool.
    private func groupView(_ group: Group, now: Double) -> some View {
        let id = AgentsRailWords.groupId(group.tool)
        return ConsoleDisclosure(id: id, title: group.tool.label, count: "\(group.agents.count)", summary: Self.groupSummary(group.agents),
                                 defaultOpen: true, siblings: groups.map { AgentsRailWords.groupId($0.tool) }, focused: focus.ringOn(id)) {
            ForEach(group.agents) { agent in agentRow(agent, now: now, hidden: false) }
        }
    }

    /// The folded head's words: how many ask, then how many work (else idle, else done).
    static func groupSummary(_ agents: [AgentInfo]) -> [ConsoleDisclosureSummaryItem] {
        ConsoleDisclosureSummary.agents(asks: agents.filter { $0.status == .blocked }.count, working: agents.filter { $0.status == .working }.count,
                                        idle: agents.filter { $0.status == .idle }.count, done: agents.filter { $0.status == .done }.count)
    }

    /// "Hidden (n)", folded: the rows Kevin took off the rail, each with Unhide.
    private func hiddenGroup(now: Double) -> some View {
        ConsoleDisclosure(id: AgentsRailWords.hiddenId, title: ConsoleDisclosureWords.hidden, count: "\(hiddenRows.count)",
                          open: $session.hiddenAgentsOpen, focused: focus.ringOn(AgentsRailWords.hiddenId)) {
            ForEach(hiddenRows) { agent in agentRow(agent, now: now, hidden: true) }
        }
    }

    private func agentRow(_ agent: AgentInfo, now: Double, hidden: Bool) -> some View {
        let open = session.openAgentId == agent.id
        return AgentRowView(agent: agent, now: now, open: open, hidden: hidden, focused: focus.ringOn(AgentsRailWords.agentId(agent.id)),
                            hovered: hover(AgentsRailWords.agentId(agent.id)),
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

// MARK: - The head: the title, or the search box

/// 40pt. At rest the section head — "Jarhead", the count, a magnifier; while searching the
/// field with its × in the same row. The two crossfade (Motion.swap); ⌘F (the root's key
/// equivalent) and the magnifier open it and put the caret in the field, Esc closes it, and
/// Return opens the first hit.
private struct JarheadRailHead: View {
    let count: Int?
    /// `k of n` while the search has answered.
    var hitCount: String? = nil
    /// ↑↓ from the field: the hits' highlight moves.
    var move: (Int) -> Void = { _ in }
    let openFocused: () -> Void

    @EnvironmentObject private var session: ConsoleSession
    @Environment(\.consoleActions) private var actions
    @FocusState private var focused: Bool

    var body: some View {
        ZStack {
            if session.searchOpen {
                HStack(spacing: iconGap) {
                    ConsoleIcon(name: "magnifyingglass")
                    field
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
                .padding(.trailing, -4)
                .transition(Motion.swap)
            }
        }
        .frame(height: 40)
        .animation(Motion.gentle, value: session.searchOpen)
        .onChange(of: session.searchFocusRequest) { DispatchQueue.main.async { focused = true } }
    }

    /// The box: the query, `k of n` at its end; ↑↓ walk the hits before the field editor sees them
    /// (a single-line field swallows moveDown:), Return opens the focused row, Esc closes.
    private var field: some View {
        HStack(spacing: 6) {
            TextField(AgentsRailWords.searchPlaceholder, text: Binding(get: { session.searchQuery }, set: { actions.search($0) }))
                .focused($focused)
                .onSubmit(openFocused)
                .onExitCommand { withAnimation(Motion.gentle) { session.closeSearch() } }
                .onKeyPress(.downArrow) { move(1); return .handled }
                .onKeyPress(.upArrow) { move(-1); return .handled }
                .accessibilityLabel(AgentsRailWords.searchPlaceholder)
            if let hitCount {
                Text(hitCount).font(ConsoleTheme.mono(11)).monospacedDigit().foregroundStyle(ConsoleTheme.titanium).lineLimit(1)
                    .contentTransition(ConsoleMotion.numeric)
                    .transition(.opacity)
            }
        }
        .consoleField(height: 24, focused: focused)
        .font(ConsoleTheme.sans(12))
        .animation(Motion.snappy, value: hitCount)
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

/// A row's trailing status: the word sans 11 fg3, or the `asks` badge while it waits on Kevin;
/// the two crossfade. Room for the ⋯ at rest follows it.
private struct RailStatusZone: View {
    let asks: Bool
    let word: String
    let key: String

    var body: some View {
        ZStack {
            if asks {
                ConsoleBadge(word: .asks).transition(.opacity)
            } else {
                Text(word).font(ConsoleTheme.sans(11)).foregroundStyle(ConsoleTheme.fg3).lineLimit(1)
                    .contentTransition(.opacity)
                    .transition(.opacity)
            }
        }
        .layoutPriority(1)
        .animation(Motion.fade, value: key)
        Color.clear.frame(width: ConsoleRow.overflowWidth, height: 20)
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
    let selection: String

    func body(content: Content) -> some View {
        content
            .animation(Motion.gentle, value: agents)
            .animation(Motion.gentle, value: layout)
            .animation(Motion.gentle, value: threads)
            .animation(Motion.gentle, value: down)
            .animation(Motion.gentle, value: hidden)
            .animation(Motion.gentle, value: folds)
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
        .accessibilityLabel("Now, \(info.meta(now: now))")
        .accessibilityHint(on ? "On screen" : "Shows the live stream")
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    /// The mark, "Now", the id stamp, the phase dot (or the pause glyph), the meta line.
    private var label: some View {
        let meta = info.meta(now: now)
        return HStack(alignment: .top, spacing: iconGap) {
            JarheadMark()
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
/// thread's card (the ask, started · lane · steps · budget) is the same one the right rail shows.
/// The menu (right-click, or the ⋯): Open, Stop (`thread.stop`, this thread only; main parks its
/// turn), and for a spawned thread Pause / Resume. Never a Delete: a finished thread ages off the
/// rail and lives in the ledger.
struct ThreadRow: View {
    let thread: WorkThread
    let now: Double
    let open: Bool
    var focused = false
    var hovered: (Bool) -> Void = { _ in }
    let toggle: () -> Void
    var stop: () -> Void = {}
    var pause: () -> Void = {}
    var resume: () -> Void = {}

    @State private var hovering = false

    private var meta: ConsoleTheme.ThreadMeta { ConsoleTheme.thread(thread.status) }
    private var isMain: Bool { thread.id == "main" }
    private var asks: Bool { thread.status == .waitingKevin }

    /// The tier-2 card: `Slack [asks] · the ask · started · lane · steps · budget · Opens its pane ⏎`.
    static func card(_ thread: WorkThread) -> ConsoleRowCard {
        let meta = ConsoleTheme.thread(thread.status)
        var card = ConsoleRowCard(title: thread.name + (thread.id == "main" ? " — \(AgentsRailWords.mainThread)" : ""))
        if thread.status == .waitingKevin { card.badge = .asks } else { card.status = meta.label }
        if let q = thread.question, !q.isEmpty { card.lines.append(q) } else if !thread.task.isEmpty { card.lines.append(thread.task) }
        if let d = thread.detail, !d.isEmpty, card.lines.first != d { card.lines.append(d) }
        card.lines = Array(card.lines.prefix(2))
        card.foot = [ConsoleRowCard.Foot(key: AgentsRailWords.started, value: ConsoleFormat.clock(thread.startedAt)),
                     ConsoleRowCard.Foot(key: AgentsRailWords.lane, value: ConsoleTheme.lane(thread.lane)),
                     ConsoleRowCard.Foot(key: AgentsRailWords.steps, value: "\(thread.steps) · \(AgentsRailWords.turns(thread.turns))"),
                     ConsoleRowCard.Foot(key: AgentsRailWords.budget, value: AgentsRailWords.budgetLine(steps: thread.budget.steps, seconds: thread.budget.seconds))]
        card.last = ConsoleRowCard.Foot(key: ConsoleRowWords.opensPane, value: ConsoleRowWords.returnKey)
        return card
    }

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
            .background(!open && hovering ? ConsoleTheme.hover : Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // A finished thread sits back; the words stay legible.
        .opacity(thread.status.isLive ? 1 : 0.62)
        .overlay(alignment: .topTrailing) {
            ConsoleRowOverflow(verbs: verbs).padding(.top, 4).padding(.trailing, railInset)
        }
        .modifier(ConsoleFocusRing(on: focused))
        .contextMenu { ConsoleVerbMenu(verbs: verbs) }
        .onHover { hovering = $0; hovered($0) }
        .animation(ConsoleMotion.hover, value: hovering)
        .animation(Motion.fade, value: thread.status.isLive)
        .consoleRowCard(Self.card(thread))
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

/// One past conversation — a session, or a resume chain folded into it. `picked` is the
/// multi-selection (the mark becomes a check on the active ground); `renaming` swaps the
/// title for a field. An archived or trashed row sits back (dimmed) and carries Restore.
struct JarheadChainRow: View {
    let chain: JarheadChain
    let now: Double
    let open: Bool
    var picked = false
    var renaming = false
    var focused = false
    var verbs = ChainVerbs()
    /// While this row is one of several picked: the menu's verbs act on all of them.
    var selection = SelectionMenu()
    var selectionVerbs = ChainVerbs()
    var hovered: (Bool) -> Void = { _ in }
    /// The click, with the modifier flags held (⌘ / ⇧ select; a plain click opens).
    var pick: (NSEvent.ModifierFlags) -> Void = { _ in }

    @State private var hovering = false

    private var title: String { chain.displayTitle.isEmpty ? "—" : chain.displayTitle }

    /// `12:34 · 2.3 min · 8 msgs` — duration, billed, heard + said. The started clock
    /// sits on the title row: four mono items and their dots do not fit the rail.
    private var metaLine: String {
        ConsoleFormat.jarheadMeta(chain)
    }

    /// The story of a chain in one card: the name, the first line heard, `date · reason`, the
    /// sessions a → b → c, and where it sits (the Trash since …, Archived).
    static func card(_ chain: JarheadChain) -> ConsoleRowCard {
        var card = ConsoleRowCard(title: chain.name ?? (chain.title.isEmpty ? AgentsRailWords.nothingHeard : chain.title))
        if chain.name != nil { card.lines.append(chain.title.isEmpty ? AgentsRailWords.nothingHeard : chain.title) }
        if chain.resumes > 0 { card.badge = .word(AgentsRailWords.resumed(chain.resumes)) }
        card.foot.append(ConsoleRowCard.Foot(key: AgentsRailWords.started, value: ConsoleFormat.fullDate(chain.startedAt) + " · " + (chain.isOpen ? "open" : ConsoleFormat.closeReason(chain.reason))))
        if chain.resumes > 0 {
            card.foot.append(ConsoleRowCard.Foot(key: AgentsRailWords.sessions, value: "\(chain.sessions.count): " + chain.sessions.map { ConsoleFormat.shortId($0.id) }.joined(separator: " → ")))
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
                // The mark, or a check while the row is one of several picked.
                ZStack {
                    if picked {
                        ConsoleIcon(name: "checkmark.circle.fill", tint: ConsoleTheme.accent).transition(.opacity)
                    } else {
                        JarheadMark().transition(.opacity)
                    }
                }
                .frame(width: 20, height: 20)
                .animation(Motion.fade, value: picked)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 8) {
                        Text(title)
                            .font(ConsoleTheme.sans(13, open ? .medium : .regular)).foregroundStyle(ConsoleTheme.fg)
                            .lineLimit(1).truncationMode(.tail)
                            .contentTransition(.opacity)
                            .animation(Motion.fade, value: title)
                        Spacer(minLength: 4)
                        if chain.pinned && chain.isActive {
                            ConsoleIcon(name: "pin.fill", size: 10)
                                .frame(width: 12, height: 20)
                                .consoleHelp("Pinned")
                                .accessibilityLabel("pinned")
                                .layoutPriority(1)
                                .transition(.opacity)
                        }
                        if chain.resumes > 0 {
                            ConsoleBadge(word: .word(AgentsRailWords.resumed(chain.resumes)))
                                .layoutPriority(1)
                        } else if chain.isOpen && chain.isActive {
                            ConsoleDot(color: ConsoleTheme.muted, live: false, size: 6)
                                .frame(width: 20, height: 20)
                                .consoleHelp("Never closed")
                                .accessibilityLabel("open")
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
                    Text(metaLine)
                        .font(ConsoleTheme.mono(11)).monospacedDigit()
                        .foregroundStyle(ConsoleTheme.fg3)
                        .lineLimit(1).truncationMode(.tail)
                        .contentTransition(ConsoleMotion.numeric)
                        .animation(Motion.snappy, value: metaLine)
                }
            }
            .padding(EdgeInsets(top: 4, leading: railInset, bottom: 6, trailing: railInset))
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .background(picked ? ConsoleTheme.active : (!open && hovering ? ConsoleTheme.hover : Color.clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // Archived and trashed rows sit back; the words stay legible.
        .opacity(chain.isActive ? 1 : 0.62)
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
        .consoleRowCard(Self.card(chain))
        .accessibilityLabel("Jarhead conversation, \(title), \(metaLine)" + (chain.isTrashed ? ", in the Trash" : chain.isArchived ? ", archived" : "") + (picked ? ", selected" : ""))
        .accessibilityHint(open ? "Open in the stream" : "Opens the conversation; ⌘-click selects")
        .accessibilityAddTraits(open || picked ? .isSelected : [])
    }

    /// The title as a field, the meta line under it as before. Return commits, Esc cancels,
    /// an empty field is back to the auto title; the focus leaving commits too.
    private var renameRow: some View {
        HStack(alignment: .top, spacing: iconGap) {
            JarheadMark()
            VStack(alignment: .leading, spacing: 2) {
                RenameField(initial: chain.name ?? "", placeholder: chain.title.isEmpty ? "Name" : chain.title,
                            commit: verbs.commitRename, cancel: verbs.cancelRename)
                    .frame(height: 20)
                Text(metaLine)
                    .font(ConsoleTheme.mono(11)).monospacedDigit()
                    .foregroundStyle(ConsoleTheme.fg3)
                    .lineLimit(1).truncationMode(.tail)
            }
        }
        .padding(EdgeInsets(top: 4, leading: railInset, bottom: 6, trailing: railInset))
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
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
    static func card(_ hit: LedgerHit) -> ConsoleRowCard {
        ConsoleRowCard(title: ConsoleFormat.fullDate(hit.at) + (hit.day.map { " · \($0)" } ?? ""), badge: .word(AgentsRailWords.hitType(hit.type)), lines: [hit.text])
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
        .consoleRowCard(Self.card(hit))
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

/// One agent session at 44: the tool's mark on the icon column, the name, the status as a word in
/// the trailing zone (the `asks` badge while blocked), the ⋯ at rest, one mono meta line. The
/// connector's detail and the working directory are the row's card.
struct AgentRowView: View {
    let agent: AgentInfo
    let now: Double
    let open: Bool
    /// In the folded "Hidden" group: dimmed, with Unhide.
    var hidden = false
    var focused = false
    var hovered: (Bool) -> Void = { _ in }
    let toggle: () -> Void
    /// Hide (or, in the Hidden group, unhide) this row. Never touches the tool's files.
    var hide: () -> Void = {}

    @State private var hovering = false

    private var tool: AgentTool { agent.resolvedTool }

    /// project · 42 msgs · 2m — whichever parts the connector gave.
    private var metaLine: String {
        ConsoleFormat.agentMeta(agent, now: now)
    }

    /// `name [asks] · detail · cwd`.
    static func card(_ agent: AgentInfo) -> ConsoleRowCard {
        var card = ConsoleRowCard(title: agent.name)
        if agent.status == .blocked { card.badge = .asks } else { card.status = AgentsRailWords.status(agent.status) }
        if let d = agent.detail, !d.isEmpty { card.lines.append(d) }
        if let cwd = agent.cwd, !cwd.isEmpty { card.foot.append(ConsoleRowCard.Foot(key: AgentsRailWords.cwd, value: ConsoleFormat.truncPath(cwd, max: 48))) }
        card.last = ConsoleRowCard.Foot(key: ConsoleRowWords.opensPane, value: ConsoleRowWords.returnKey)
        return card
    }

    var body: some View {
        Button(action: toggle) {
            label
                .padding(EdgeInsets(top: 4, leading: railInset, bottom: 6, trailing: railInset))
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .background(!open && hovering ? ConsoleTheme.hover : Color.clear)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .opacity(hidden ? 0.62 : 1)
        .overlay(alignment: .topTrailing) { controls.padding(.top, 4).padding(.trailing, railInset) }
        .modifier(ConsoleFocusRing(on: focused))
        .contextMenu { ConsoleVerbMenu(verbs: verbs) }
        .onHover { hovering = $0; hovered($0) }
        .animation(ConsoleMotion.hover, value: hovering)
        .consoleRowCard(Self.card(agent))
        .accessibilityLabel("\(agent.name), \(tool.label), \(agent.status.rawValue)" + (hidden ? ", hidden" : ""))
        .accessibilityHint(open ? "Open in the stream" : "Opens the conversation")
        .accessibilityAddTraits(open ? .isSelected : [])
    }

    /// The mark, the name, the status zone, the meta line.
    private var label: some View {
        HStack(alignment: .top, spacing: iconGap) {
            BrandMark(tool: tool)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 8) {
                    Text(agent.name)
                        .font(ConsoleTheme.sans(13, open ? .medium : .regular)).foregroundStyle(ConsoleTheme.fg)
                        .lineLimit(1).truncationMode(.tail)
                    Spacer(minLength: 4)
                    // Room for the Unhide in the overlay.
                    if hidden { Color.clear.frame(width: restoreWidth, height: 20) }
                    RailStatusZone(asks: agent.status == .blocked, word: AgentsRailWords.status(agent.status), key: agent.status.rawValue)
                }
                .frame(height: 20)
                Text(metaLine)
                    .font(ConsoleTheme.mono(11)).monospacedDigit()
                    .foregroundStyle(ConsoleTheme.fg3)
                    .lineLimit(1).truncationMode(.tail)
                    .contentTransition(ConsoleMotion.numeric)
                    .animation(Motion.snappy, value: metaLine)
            }
        }
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
    private var statusWidth: CGFloat { agent.status == .blocked ? 44 : CGFloat(AgentsRailWords.status(agent.status).count) * 6 + 8 }

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
