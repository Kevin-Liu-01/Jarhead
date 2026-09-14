import SwiftUI
import AppKit

// The Memory rail: what Jarhead durably knows about Kevin, as rows he can read, correct and
// hide. Under Settings › Memory: a search field, the segments Live | Forgotten | Archived,
// at most thirty rows (kind glyph · the sentence · `seen 4× · 3d`), and each row's verbs —
// Edit (inline; Return commits), Forget (a live row), Restore (a forgotten or archived one).
// Never a deletion verb: Forget and Archive are states in Jarhead's own append-only record;
// Restore undoes them; the store only grows. In the Now rail, "Memory · used this turn" lists what
// the last delegation was given (MemorySummary.lastUsedIds) — the one lever against a
// misheard "fact" steering the voice. Rows come from the daemon (`memory.list` /
// `memory.search`) through AppState's handlers; the root installs them here so the leaf
// views stay plain values and never observe AppState.

private let iconGap: CGFloat = 8

/// How the rail reaches the store: `memory.list(state, limit)` and `memory.search(query, limit)`
/// as AppState's handlers answer them (EngineClient behind them; nil when the daemon does not
/// answer). Filled in by the root view; the default answers nothing and says the build is not wired.
struct ConsoleMemoryActions {
    var list: (String, Int) async -> [MemoryItem]? = { _, _ in nil }
    var search: (String, Int) async -> [MemoryItem]? = { _, _ in nil }
    /// False until the root installs the handlers, so the rail blames the app, not the daemon.
    var installed = false
}

private struct ConsoleMemoryKey: EnvironmentKey {
    static let defaultValue = ConsoleMemoryActions()
}

extension EnvironmentValues {
    var consoleMemory: ConsoleMemoryActions {
        get { self[ConsoleMemoryKey.self] }
        set { self[ConsoleMemoryKey.self] = newValue }
    }
}

// MARK: - Formatting (pure)

enum MemoryFormat {
    /// `seen 4× · 3d` — how often the item was met and how long since; `· by Kevin` when he
    /// asked for it outright (origin kevin), `· tool` when a tool wrote it.
    static func meta(_ item: MemoryItem, now: Double) -> String {
        var parts = ["seen \(max(1, item.seenCount))×", ConsoleFormat.relative(item.lastSeenAt, now: now)]
        switch item.origin {
        case "kevin": parts.append("by Kevin")
        case "tool": parts.append("tool")
        default: break
        }
        return parts.joined(separator: " · ")
    }

    /// The tooltip: the kind with its scores, then every source as `Sep 11, 2026 at 2:02 PM · heard`.
    static func tooltip(_ item: MemoryItem) -> String {
        var lines = ["\(item.kind.rawValue) · importance \(score(item.importance)) · confidence \(score(item.confidence))"]
        if !item.subjects.isEmpty { lines.append(item.subjects.joined(separator: ", ")) }
        for s in item.sources.suffix(4) { lines.append("\(ConsoleFormat.fullDate(s.at)) · \(s.type)") }
        if let into = item.mergedInto { lines.append("merged into \(ConsoleFormat.shortId(into))") }
        return lines.joined(separator: "\n")
    }

    /// 0.8 → "0.8"; the scores are shown to one decimal.
    static func score(_ v: Double) -> String { String(format: "%.1f", max(0, min(1, v))) }

    /// The segment's empty line, or the query's.
    static func emptyLine(state: MemoryState, query: String) -> String {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if !q.isEmpty { return "No memory matches “\(q)”." }
        switch state {
        case .live: return "Nothing remembered yet."
        case .forgotten: return "Nothing forgotten."
        case .archived: return "Nothing archived."
        case .merged: return "Nothing merged."
        }
    }

    /// The rows the Now rail shows for `lastUsedIds`: the live items those ids name, in the
    /// order the brain was given them; an id the list no longer holds is skipped.
    static func used(_ ids: [String], in items: [MemoryItem]) -> [MemoryItem] {
        var byId: [String: MemoryItem] = [:]
        for item in items where byId[item.id] == nil { byId[item.id] = item }
        return ids.compactMap { byId[$0] }
    }

    /// What one segment lists from a `memory.list` answer: only that state, the rows whose text
    /// or subjects carry the query (a local, case-insensitive substring match — the list branch:
    /// Forgotten and Archived, or a query too short for the daemon), newest `lastSeenAt` first, capped.
    static func rows(_ answer: [MemoryItem], state: MemoryState, query: String, cap: Int) -> [MemoryItem] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return answer
            .filter { $0.state == state && (q.isEmpty || $0.text.lowercased().contains(q) || $0.subjects.contains { $0.lowercased().contains(q) }) }
            .sorted { $0.lastSeenAt > $1.lastSeenAt }
            .prefix(cap)
            .map { $0 }
    }

    /// What a `memory.search` answer lists: the daemon scored it (cosine over embeddings plus
    /// substring, best first), so a hit need not carry the query's words — "theme" finds
    /// "prefers dark mode" — and its order is the ranking. Kept as it comes: only the state
    /// filter and the cap apply here; a substring re-filter or a re-sort by recency would throw
    /// the semantic hits away and turn the search back into a grep.
    static func hits(_ answer: [MemoryItem], state: MemoryState, cap: Int) -> [MemoryItem] {
        Array(answer.filter { $0.state == state }.prefix(cap))
    }
}

// MARK: - The list under Settings › Memory

struct MemoryRailList: View {
    /// The snapshot's summary (Snapshot.memory): a change — a run, a Forget, a Restore — re-reads the list.
    let summary: MemorySummary?
    /// Settings.memory: off, the rows still show (the store stays) but the head says nothing is learned or used.
    let enabled: Bool

    @Environment(\.consoleActions) private var actions
    @Environment(\.consoleMemory) private var memory

    /// Live | Forgotten | Archived (merged items sit under the item they were folded into).
    @State private var segment: MemoryState = .live
    @State private var query = ""
    /// nil until the first answer; then what the segment lists.
    @State private var items: [MemoryItem]?
    @State private var loading = false
    /// Why the rows are missing (the app's wiring, or the daemon), when they are.
    @State private var gap: Gap?
    @State private var editingId: String?
    @State private var task: Task<Void, Never>?
    @FocusState private var searchFocused: Bool

    /// At most this many rows; the search narrows what does not fit.
    static let maxRows = 30
    /// The shortest query that goes to the daemon (a shorter one filters the listed rows locally).
    static let searchMinLength = 2
    /// Typing settles for this long before the daemon is asked.
    static let searchDebounceMs: UInt64 = 250
    /// The preview harness's way to a row's verbs (the package has no test target): a
    /// `ConsoleSession.previewNotification` with `memoryVerb` forget | restore | edit (+ `memoryId`,
    /// `memoryText`) or `memorySegment` runs the same closures a click would, and what the list
    /// holds after is handed to this hook so run.log can say the row left at once. nil in the app.
    nonisolated(unsafe) static var previewReport: ((String) -> Void)?

    enum Gap: Equatable {
        case app, daemon
        var line: String {
            switch self {
            case .app: return "Memory is not wired in this build."
            case .daemon: return "The daemon did not answer; it may predate memory."
            }
        }
    }

    private var segments: [MemoryState] { [.live, .forgotten, .archived] }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            searchField
            ConsoleSegments(value: segment, options: segments, title: ConsoleTheme.memoryStateLabel,
                            pick: { segment = $0 }, accessibilityLabel: "Memory state: \(ConsoleTheme.memoryStateLabel(segment))")
            // The rows and the lines that stand in for them crossfade; a row leaving (a Forget) drops away.
            ZStack(alignment: .topLeading) {
                if let items, !items.isEmpty {
                    // Relative times tick slowly; nothing else here needs the clock.
                    TimelineView(.periodic(from: .now, by: 30)) { ctx in
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(items) { item in
                                MemoryRow(item: item, now: ctx.date.timeIntervalSince1970 * 1000, editing: editingId == item.id, verbs: verbs(item))
                                    .transition(Motion.appear)
                            }
                        }
                    }
                    .transition(.opacity)
                } else if loading && items == nil {
                    HStack(spacing: 8) {
                        ConsoleGlyphs(cols: 8, rows: 1)
                        Text("Reading…").font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg3)
                    }
                    .frame(height: 24)
                    .transition(.opacity)
                } else if let gap {
                    Text(gap.line).font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg3)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(minHeight: 22, alignment: .leading)
                        .transition(.opacity)
                } else {
                    Text(MemoryFormat.emptyLine(state: segment, query: query)).font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg3)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(minHeight: 22, alignment: .leading)
                        .transition(.opacity)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .animation(Motion.gentle, value: items?.map(\.id) ?? [])
            .animation(Motion.fade, value: loading && items == nil)
            Text(ConsoleTheme.memoryForgetHint).font(ConsoleTheme.sans(11)).lineSpacing(1).foregroundStyle(ConsoleTheme.titanium)
                .fixedSize(horizontal: false, vertical: true)
        }
        .onAppear(perform: reload)
        .onChange(of: segment) { editingId = nil; reload() }
        .onChange(of: query) { reload() }
        // A run landed or a verb went through: the counts moved, so the rows may have.
        .onChange(of: summary) { reload() }
        .onReceive(NotificationCenter.default.publisher(for: ConsoleSession.previewNotification)) { note in
            preview(note.userInfo ?? [:])
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Memory, \(ConsoleTheme.memoryStateLabel(segment))")
    }

    /// The harness's verbs, through the row's own closures (`verbs`), so the trace proves the rail's
    /// path — the optimistic removal and the one command — not a re-statement of it.
    private func preview(_ info: [AnyHashable: Any]) {
        if let raw = info["memorySegment"] as? String, let wanted = MemoryState(rawValue: raw) {
            segment = wanted
            Self.previewReport?("segment \(raw)")
        }
        guard let verb = info["memoryVerb"] as? String, let id = info["memoryId"] as? String else { return }
        guard let item = items?.first(where: { $0.id == id }) else {
            Self.previewReport?("\(verb) \(id) → not listed under \(segment.rawValue) (rows \(items?.count ?? -1))")
            return
        }
        let before = items?.count ?? 0
        let row = verbs(item)
        switch verb {
        case "forget": row.forget()
        case "restore": row.restore()
        case "edit": row.commitEdit(info["memoryText"] as? String ?? item.text)
        default: return
        }
        let after = items?.count ?? -1
        let text = verb == "edit" ? " text '\(items?.first { $0.id == id }?.text ?? "")'" : ""
        Self.previewReport?("\(verb) \(id) → rows \(after) (was \(before))\(text)")
    }

    /// The magnifier, the field, × while there is text — the rail head's search, at row height.
    private var searchField: some View {
        HStack(spacing: iconGap) {
            ConsoleIcon(name: "magnifyingglass", size: 12)
            TextField("Search memory", text: $query)
                .consoleField(height: 24, focused: searchFocused)
                .focused($searchFocused)
                .onExitCommand { query = ""; searchFocused = false }
                .accessibilityLabel("Search memory")
            if !query.isEmpty {
                Button { query = "" } label: {
                    Image(systemName: "xmark").font(.system(size: 10, weight: .semibold))
                }
                .buttonStyle(ConsoleButtonStyle(kind: .plain, iconOnly: true, height: 24))
                .help("Clear the search")
                .accessibilityLabel("Clear the search")
                .transition(.opacity)
            }
        }
        .animation(Motion.fade, value: query.isEmpty)
    }

    /// The verbs behind a row's menu and its ⋯, one place so every site agrees. Forget and
    /// Restore are engine commands (states in the store); Edit commits through `memory.edit`.
    private func verbs(_ item: MemoryItem) -> MemoryVerbs {
        MemoryVerbs(
            edit: { withAnimation(Motion.snappy) { editingId = item.id } },
            commitEdit: { text in
                editingId = nil
                let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !t.isEmpty, t != item.text else { return }
                actions.send(.memoryEdit(id: item.id, text: t, kind: nil))
                // Shown at once; the snapshot's next summary confirms it with a re-read.
                if let i = items?.firstIndex(where: { $0.id == item.id }) { items?[i].text = t }
            },
            cancelEdit: { withAnimation(Motion.snappy) { editingId = nil } },
            setKind: { kind in
                guard kind != item.kind else { return }
                actions.send(.memoryEdit(id: item.id, text: item.text, kind: kind.rawValue))
                if let i = items?.firstIndex(where: { $0.id == item.id }) { items?[i].kind = kind }
            },
            forget: {
                actions.send(.memoryForget(id: item.id))
                // A forgotten row leaves the Live list at once; Forgotten will list it on its next read.
                withAnimation(Motion.gentle) { items?.removeAll { $0.id == item.id } }
            },
            restore: {
                actions.send(.memoryRestore(id: item.id))
                withAnimation(Motion.gentle) { items?.removeAll { $0.id == item.id } }
            })
    }

    /// Reads the segment after the typing settles: the daemon's search for a live query (its
    /// ranking kept — `MemoryFormat.hits`), its list otherwise (filtered and sorted here —
    /// `MemoryFormat.rows`), capped either way. A read that lands for an older query or segment
    /// is dropped.
    private func reload() {
        task?.cancel()
        guard memory.installed else {
            items = []
            gap = .app
            loading = false
            return
        }
        loading = true
        let wanted = segment, q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let memory = self.memory
        task = Task { @MainActor in
            if !q.isEmpty {
                try? await Task.sleep(nanoseconds: Self.searchDebounceMs * 1_000_000)
                guard !Task.isCancelled else { return }
            }
            let answer: [MemoryItem]?
            // The daemon searches live items (scored: a hit need not carry the words); the
            // answer is kept in its order. Forgotten and archived rows are few: list them and
            // filter here, so a search reaches them too without a second wire message.
            let searched = wanted == .live && q.count >= Self.searchMinLength
            if searched {
                answer = await memory.search(q, 60)
            } else {
                answer = await memory.list(wanted.rawValue, q.isEmpty ? Self.maxRows : 200)
            }
            guard !Task.isCancelled, wanted == segment, q == query.trimmingCharacters(in: .whitespacesAndNewlines) else { return }
            if let answer {
                items = searched ? MemoryFormat.hits(answer, state: wanted, cap: Self.maxRows)
                                 : MemoryFormat.rows(answer, state: wanted, query: q, cap: Self.maxRows)
                gap = nil
            } else {
                items = []
                gap = .daemon
            }
            loading = false
        }
    }
}

/// The verbs a memory row offers (MemoryRailList.verbs builds them once per row).
struct MemoryVerbs {
    var edit: () -> Void = {}
    var commitEdit: (String) -> Void = { _ in }
    var cancelEdit: () -> Void = {}
    var setKind: (MemoryKind) -> Void = { _ in }
    var forget: () -> Void = {}
    var restore: () -> Void = {}
}

/// One remembered sentence: the kind's solid symbol on the icon column, the text (two lines;
/// the tooltip has it whole with its scores and sources), `seen 4× · 3d` under it in mono. A
/// forgotten or archived row sits back (dimmed) and carries Restore; every row has a context
/// menu and a hover ⋯ with Edit, the kind, and Forget or Restore.
struct MemoryRow: View {
    let item: MemoryItem
    let now: Double
    var editing = false
    var verbs = MemoryVerbs()

    @State private var hovering = false

    private var live: Bool { item.state == .live }

    var body: some View {
        HStack(alignment: .top, spacing: iconGap) {
            ConsoleIcon(name: ConsoleTheme.memorySymbol(item.kind), tint: live ? ConsoleTheme.titanium : ConsoleTheme.fg3)
                .padding(.top, 1)
                .help(item.kind.rawValue)
                .accessibilityLabel(item.kind.rawValue)
            VStack(alignment: .leading, spacing: 3) {
                if editing {
                    MemoryEditField(initial: item.text, commit: verbs.commitEdit, cancel: verbs.cancelEdit)
                        .transition(.opacity)
                } else {
                    HStack(alignment: .top, spacing: 6) {
                        Text(item.text.isEmpty ? "—" : item.text)
                            .font(ConsoleTheme.sans(12)).lineSpacing(2).foregroundStyle(ConsoleTheme.fg)
                            .lineLimit(2).truncationMode(.tail)
                            .fixedSize(horizontal: false, vertical: true)
                            .contentTransition(.opacity)
                            .animation(Motion.fade, value: item.text)
                        Spacer(minLength: 0)
                        // The trailing zone: Restore on a hidden row, and the ⋯ while hovering.
                        HStack(spacing: 4) {
                            if !live {
                                Button("Restore", action: verbs.restore)
                                    .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 20, small: true))
                                    .help(item.state == .archived ? "Back from Archived; Jarhead uses it again" : "Back from Forgotten; Jarhead uses it again")
                            }
                            ZStack(alignment: .trailing) {
                                if hovering {
                                    MemoryRowOverflow { menuItems }
                                        .transition(.opacity)
                                }
                            }
                            .frame(width: 20, height: 20, alignment: .trailing)
                        }
                        .layoutPriority(1)
                    }
                    .transition(.opacity)
                }
                Text(MemoryFormat.meta(item, now: now))
                    .font(ConsoleTheme.mono(11)).monospacedDigit().foregroundStyle(ConsoleTheme.fg3)
                    .lineLimit(1).truncationMode(.tail)
                    .contentTransition(ConsoleMotion.numeric)
                    .animation(Motion.snappy, value: item.seenCount)
            }
        }
        .padding(.vertical, 5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(!editing && hovering ? ConsoleTheme.hover : Color.clear)
        .contentShape(Rectangle())
        .opacity(live ? 1 : 0.62)
        .contextMenu { menuItems }
        .onHover { hovering = $0 }
        .animation(ConsoleMotion.hover, value: hovering)
        .animation(Motion.snappy, value: editing)
        .help(MemoryFormat.tooltip(item))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(item.kind.rawValue): \(item.text). \(MemoryFormat.meta(item, now: now))" + (live ? "" : ", \(ConsoleTheme.memoryStateLabel(item.state).lowercased())"))
    }

    @ViewBuilder
    private var menuItems: some View {
        Button("Edit", action: verbs.edit)
        Menu("Kind") {
            ForEach(MemoryKind.allCases, id: \.self) { kind in
                Button {
                    verbs.setKind(kind)
                } label: {
                    if kind == item.kind { Label(kind.rawValue, systemImage: "checkmark") } else { Text(kind.rawValue) }
                }
            }
        }
        Divider()
        if live {
            Button("Forget", action: verbs.forget)
        } else {
            Button("Restore", action: verbs.restore)
        }
    }
}

/// The hover overflow: a ⋯ that opens the row's verbs (the agents rail's idiom).
private struct MemoryRowOverflow<Items: View>: View {
    let items: Items

    init(@ViewBuilder items: () -> Items) {
        self.items = items()
    }

    var body: some View {
        Menu { items } label: {
            Image(systemName: "ellipsis").font(.system(size: 13, weight: .medium))
                .foregroundStyle(ConsoleTheme.fg2)
                .frame(width: 20, height: 20)
                .background(RoundedRectangle(cornerRadius: 6).fill(ConsoleTheme.hover))
                .contentShape(Rectangle())
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .help("More")
        .accessibilityLabel("More")
    }
}

/// The inline edit: the sentence as a field (wrapping to three lines), focused as it appears.
/// Return commits, Esc cancels, the focus leaving commits too — once.
private struct MemoryEditField: View {
    let initial: String
    let commit: (String) -> Void
    let cancel: () -> Void

    @State private var text = ""
    @State private var done = false
    @FocusState private var focused: Bool

    var body: some View {
        TextField("One sentence about Kevin", text: $text, axis: .vertical)
            .lineLimit(1...3)
            .consoleField(height: 22, focused: focused, grows: true)
            .focused($focused)
            .onSubmit { finish { commit(text) } }
            .onExitCommand { finish(cancel) }
            .onChange(of: focused) { _, on in
                if !on { finish { commit(text) } }
            }
            .onAppear {
                text = initial
                DispatchQueue.main.async { focused = true }
            }
            .help("Return keeps the change; Esc cancels")
            .accessibilityLabel("Memory text")
    }

    private func finish(_ body: () -> Void) {
        guard !done else { return }
        done = true
        body()
    }
}

// MARK: - Now › Memory · used this turn

/// What the last delegation was given (MemorySummary.lastUsedIds), resolved against the live
/// list: at most eight rows of glyph and sentence, so a misheard "fact" steering the voice is
/// seen the turn it happens. Re-read when the ids change; "—" while nothing has been used.
struct MemoryUsedList: View {
    let ids: [String]

    @Environment(\.consoleMemory) private var memory
    @State private var items: [MemoryItem] = []
    @State private var loading = false

    /// The rail shows this many at most; the brain's block is capped at about that many lines anyway.
    static let maxRows = 8

    var body: some View {
        ZStack(alignment: .topLeading) {
            if !items.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(items.prefix(Self.maxRows)) { item in
                        HStack(alignment: .top, spacing: iconGap) {
                            ConsoleIcon(name: ConsoleTheme.memorySymbol(item.kind))
                                .help(item.kind.rawValue)
                                .accessibilityLabel(item.kind.rawValue)
                            Text(item.text)
                                .font(ConsoleTheme.sans(12)).lineSpacing(2).foregroundStyle(ConsoleTheme.fg2)
                                .lineLimit(2).truncationMode(.tail)
                                .fixedSize(horizontal: false, vertical: true)
                            Spacer(minLength: 0)
                        }
                        .padding(.vertical, 3)
                        .help(MemoryFormat.tooltip(item))
                        .transition(Motion.appear)
                    }
                }
                .transition(.opacity)
            } else if loading {
                HStack(spacing: 8) {
                    ConsoleGlyphs(cols: 8, rows: 1)
                    Text("Reading…").font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg3)
                }
                .frame(height: 22)
                .transition(.opacity)
            } else {
                Text(ids.isEmpty ? "Nothing used yet." : "Used \(ids.count); the rows are not on the daemon's list.")
                    .font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg3)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(minHeight: 22, alignment: .leading)
                    .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(Motion.gentle, value: items.map(\.id))
        .task(id: ids) {
            guard !ids.isEmpty, memory.installed else { items = []; loading = false; return }
            loading = true
            // The live list is small (≤ 200 here); the ids pick from it in the brain's order.
            let answer = await memory.list("live", 200)
            guard !Task.isCancelled else { return }
            items = MemoryFormat.used(ids, in: answer ?? [])
            loading = false
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Memory used this turn: \(items.count)")
    }
}
