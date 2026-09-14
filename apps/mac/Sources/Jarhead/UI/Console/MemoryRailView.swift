import SwiftUI
import AppKit

// The Memory rail: what Jarhead durably knows about Kevin, as rows he can read, correct and
// hide. Under Settings › Memory: a `ConsoleFilterField` with `k of n`, the segments Live | Forgotten |
// Archived, the kind chips with counts (`All 7 · fact 2 · pref 2 …`), at most thirty `ConsoleRow`s
// (kind glyph · the sentence on two lines · the kind badge · `seen 4× · 3d` · the importance
// meter · ⋯ at rest; the scores, subjects and sources as the row's card), ↑↓ ⏎ over the rows
// (`ConsoleListKeys`; Return edits), and each row's verbs — Edit (inline; Return commits),
// Forget (a live row), Restore (a forgotten or archived one).
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

// MARK: - Words (pinned by check-kit)

enum MemoryWords {
    /// The kind chip's word and the row's badge: one short word per kind.
    static func kindChip(_ kind: MemoryKind) -> String {
        switch kind {
        case .preference: return "pref"
        case .fact: return "fact"
        case .episode: return "when"
        case .procedure: return "how"
        case .contact: return "who"
        case .place: return "where"
        }
    }
    static let all = "All"
    static let searchPlaceholder = "Filter memory"
    static func filterPlaceholder(_ n: Int) -> String { n > 0 ? "Filter \(n) memories" : searchPlaceholder }
    static let clearSearch = "Clear the filter"
    static let reading = "Reading…"
    static let restore = "Restore"
    static let restoreArchivedHelp = "Back from Archived — Jarhead uses it again"
    static let restoreForgottenHelp = "Back from Forgotten — Jarhead uses it again"
    static let edit = "Edit"
    static let kind = "Kind"
    static let forget = "Forget"
    static let editPlaceholder = "One sentence about Kevin"
    static let editHelp = "Return keeps the change — Esc cancels"
    static let editLabel = "Memory text"
    static let nothingUsed = "Nothing used yet."
    static func usedNotListed(_ n: Int) -> String { "Used \(n); the rows are not on the daemon's list." }
    static let opensSettings = "Opens Settings › Memory"
    static let live = "live"
    static let importance = "importance"
    static let confidence = "confidence"
    static let subjects = "subjects"
    static let source = "source"
    static let origin = "origin"
    static let mergedInto = "merged into"
    /// A row's card on the float layer: `memory.<id>` under Settings, `memory.used.<id>` in the Now rail.
    static func cardId(_ id: String) -> String { "memory.\(id)" }
    static func usedCardId(_ id: String) -> String { "memory.used.\(id)" }
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

    /// The row's card (tier 2): the kind with its state as the badge, the sentence and its
    /// subjects, then the scores, how often it was met, every source and its origin as foot rows.
    static func card(_ item: MemoryItem, now: Double) -> ConsoleTipCard {
        var card = ConsoleTipCard(title: MemoryWords.kindChip(item.kind), badge: .word(item.state.rawValue), lines: [item.text])
        if !item.subjects.isEmpty { card.lines.append("\(MemoryWords.subjects): \(item.subjects.joined(separator: ", "))") }
        card.foot = [ConsoleTipCard.Row(key: MemoryWords.importance, value: "\(score(item.importance)) · \(MemoryWords.confidence) \(score(item.confidence))"),
                     ConsoleTipCard.Row(key: "seen", value: "\(max(1, item.seenCount))× · last \(ConsoleFormat.relative(item.lastSeenAt, now: now))")]
        for s in item.sources.suffix(4) { card.foot.append(ConsoleTipCard.Row(key: MemoryWords.source, value: "\(ConsoleFormat.fullDate(s.at)) · \(s.type)")) }
        card.foot.append(ConsoleTipCard.Row(key: MemoryWords.origin, value: "\(item.origin) · \(item.id)"))
        if let into = item.mergedInto { card.foot.append(ConsoleTipCard.Row(key: MemoryWords.mergedInto, value: ConsoleFormat.shortId(into))) }
        return card
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
    /// One kind, or every kind (the chips).
    @State private var kindFilter: MemoryKind?
    /// nil until the first answer; then what the segment lists (before the kind filter).
    @State private var items: [MemoryItem]?
    @State private var loading = false
    /// Why the rows are missing (the app's wiring, or the daemon), when they are.
    @State private var gap: Gap?
    @State private var editingId: String?
    @State private var task: Task<Void, Never>?
    @StateObject private var focus = ConsoleListFocus()
    @FocusState private var filterFocused: Bool

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
    /// The rows on screen: the segment's answer through the kind filter.
    private var shown: [MemoryItem] { (items ?? []).filter { kindFilter == nil || $0.kind == kindFilter } }
    private var total: Int { segment == .live ? (summary?.count ?? items?.count ?? 0) : (items?.count ?? 0) }
    private var filtering: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty || kindFilter != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ConsoleFilterField(text: $query, placeholder: MemoryWords.filterPlaceholder(total),
                               count: ConsoleListModel.countWord(shown: shown.count, of: total, typing: filtering),
                               focus: $filterFocused, accessibilityLabel: MemoryWords.searchPlaceholder,
                               onMove: move, onSubmit: { if let id = focus.id { edit(id) } }, onExit: clearFilter)
            ConsoleSegments(value: segment, options: segments, title: ConsoleTheme.memoryStateLabel,
                            pick: { segment = $0 }, accessibilityLabel: "Memory state: \(ConsoleTheme.memoryStateLabel(segment))")
            if let items, !items.isEmpty {
                MemoryKindChips(kinds: ConsoleListModel.memoryKinds(items), total: items.count, picked: kindFilter) { pick in
                    withAnimation(Motion.snappy) { kindFilter = pick }
                }
            }
            MemoryRailBody(shown: shown, items: items, loading: loading, gap: gap, emptyLine: MemoryFormat.emptyLine(state: segment, query: query),
                           editingId: editingId, focus: focus, verbs: verbs)
                .consoleListKeys(ConsoleListKeys(focus: focus, ids: shown.map(\.id), typeAhead: false, primary: { edit($0) }, escape: { query = ""; kindFilter = nil }))
            Text(ConsoleTheme.memoryForgetHint).font(ConsoleTheme.sans(11)).lineSpacing(1).foregroundStyle(ConsoleTheme.titanium)
                .fixedSize(horizontal: false, vertical: true)
        }
        .onAppear(perform: reload)
        .onChange(of: segment) { editingId = nil; kindFilter = nil; reload() }
        .onChange(of: query) { reload() }
        // A run landed or a verb went through: the counts moved, so the rows may have.
        .onChange(of: summary) { reload() }
        .onReceive(NotificationCenter.default.publisher(for: ConsoleSession.previewNotification)) { note in
            preview(note.userInfo ?? [:])
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Memory, \(ConsoleTheme.memoryStateLabel(segment))")
    }

    /// ↑↓ from the filter field: the highlight moves over the rows (the ring shows; the caret stays).
    private func move(_ direction: MoveCommandDirection) {
        let delta = direction == .down ? 1 : (direction == .up ? -1 : 0)
        guard delta != 0, let next = ConsoleListModel.step(focus.id, by: delta, in: shown.map(\.id)) else { return }
        focus.set(next, keyboard: true, why: delta > 0 ? "down" : "up")
    }

    /// Esc in the field: the words and the kind chip both let go; the caret leaves.
    private func clearFilter() {
        query = ""
        kindFilter = nil
        filterFocused = false
    }

    /// Return on a row: the inline edit.
    private func edit(_ id: String) {
        guard let item = shown.first(where: { $0.id == id }) else { return }
        verbs(item).edit()
    }

    /// The harness's verbs, through the row's own closures (`verbs`), so the trace proves the rail's
    /// path — the optimistic removal and the one command — not a re-statement of it; `chip:<kind>` picks a kind chip.
    private func preview(_ info: [AnyHashable: Any]) {
        if let raw = info["memorySegment"] as? String, let wanted = MemoryState(rawValue: raw) {
            segment = wanted
            Self.previewReport?("segment \(raw)")
        }
        if let word = info[ConsolePreviewKey.chip] as? String {
            let kind = MemoryKind.allCases.first { $0.rawValue == word || MemoryWords.kindChip($0) == word }
            withAnimation(Motion.snappy) { kindFilter = kind }
            Self.previewReport?("chip \(word) → \(kind.map(MemoryWords.kindChip) ?? "all") · rows \(shown.count) of \(items?.count ?? -1)")
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

/// The rows, or the line that stands in for them (Reading… · the gap · the empty line); they crossfade.
private struct MemoryRailBody: View {
    let shown: [MemoryItem]
    let items: [MemoryItem]?
    let loading: Bool
    let gap: MemoryRailList.Gap?
    let emptyLine: String
    let editingId: String?
    @ObservedObject var focus: ConsoleListFocus
    let verbs: (MemoryItem) -> MemoryVerbs

    var body: some View {
        ZStack(alignment: .topLeading) {
            if !shown.isEmpty {
                // Relative times tick slowly; nothing else here needs the clock.
                TimelineView(.periodic(from: .now, by: 30)) { ctx in
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(shown) { item in
                            MemoryRow(item: item, now: ctx.date.timeIntervalSince1970 * 1000, editing: editingId == item.id,
                                      focused: focus.ringOn(item.id), verbs: verbs(item), hovered: { if $0 { focus.hovered(item.id) } })
                                .transition(Motion.appear)
                        }
                    }
                }
                // The rows carry their own 12 pt inset and run to the rail's edge; the section's inset
                // around them comes off (gone once the section is a `ConsoleDisclosure` without one).
                .padding(.horizontal, -12)
                .transition(.opacity)
            } else if loading && items == nil {
                HStack(spacing: 8) {
                    ConsoleGlyphs(cols: 8, rows: 1)
                    Text(MemoryWords.reading).font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg3)
                }
                .frame(height: 24)
                .transition(.opacity)
            } else {
                Text(gap?.line ?? emptyLine).font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg3)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(minHeight: 22, alignment: .leading)
                    .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(Motion.gentle, value: shown.map(\.id))
        .animation(Motion.fade, value: loading && items == nil)
    }
}

/// `All 7 · fact 2 · pref 2 · how 1 …` — one chip per kind the rows carry, the picked one inverted.
private struct MemoryKindChips: View {
    let kinds: [ConsoleListModel.KindCount]
    let total: Int
    let picked: MemoryKind?
    let pick: (MemoryKind?) -> Void

    var body: some View {
        ConsoleFlow(hSpacing: 4, vSpacing: 4) {
            ConsoleChip(word: MemoryWords.all, count: "\(total)", on: picked == nil) { pick(nil) }
                .accessibilityLabel("\(MemoryWords.all) \(total)")
            ForEach(kinds, id: \.kind) { kc in
                ConsoleChip(word: MemoryWords.kindChip(kc.kind), count: "\(kc.count)", on: picked == kc.kind) { pick(picked == kc.kind ? nil : kc.kind) }
                    .accessibilityLabel("\(MemoryWords.kindChip(kc.kind)) \(kc.count)")
            }
        }
        .animation(Motion.snappy, value: kinds)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Kind")
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

/// One remembered sentence as a `ConsoleRow`: the kind's solid symbol on the icon column, the
/// text on two lines with the kind badge after it, `seen 4× · 3d` and the importance meter under
/// it, the ⋯ at rest with Edit · Kind ▸ · Forget / Restore; the scores, subjects and sources as
/// the row's card. A forgotten or archived row sits back and carries Restore; while editing the
/// sentence is a field.
struct MemoryRow: View {
    let item: MemoryItem
    let now: Double
    var editing = false
    var focused = false
    var verbs = MemoryVerbs()
    var hovered: (Bool) -> Void = { _ in }

    private var live: Bool { item.state == .live }

    /// The kind badge's column: one width so the words align down the rail.
    static let badgeWidth: CGFloat = 44

    var body: some View {
        if editing {
            editRow.transition(.opacity)
        } else {
            ConsoleRow(title: item.text, lines: 2, icon: .symbol(ConsoleTheme.memorySymbol(item.kind), tint: live ? ConsoleTheme.titanium : ConsoleTheme.fg3),
                       badge: .word(MemoryWords.kindChip(item.kind)), badgeWidth: Self.badgeWidth,
                       meta: MemoryFormat.meta(item, now: now), meter: item.importance,
                       trailing: .ellipsis(menuVerbs), verb: live ? nil : ConsoleRowVerb(title: MemoryWords.restore, help: restoreHelp, run: verbs.restore),
                       focused: focused, sitsBack: !live, id: MemoryWords.cardId(item.id), card: MemoryFormat.card(item, now: now),
                       accessibilityHint: "\(item.kind.rawValue), \(MemoryFormat.meta(item, now: now))" + (live ? "" : ", \(ConsoleTheme.memoryStateLabel(item.state).lowercased())"),
                       onHover: hovered, primary: verbs.edit)
                .transition(.opacity)
        }
    }

    private var restoreHelp: String { item.state == .archived ? MemoryWords.restoreArchivedHelp : MemoryWords.restoreForgottenHelp }

    private var editRow: some View {
        HStack(alignment: .top, spacing: iconGap) {
            ConsoleIcon(name: ConsoleTheme.memorySymbol(item.kind)).padding(.top, 1)
            VStack(alignment: .leading, spacing: 3) {
                MemoryEditField(initial: item.text, commit: verbs.commitEdit, cancel: verbs.cancelEdit)
                Text(MemoryFormat.meta(item, now: now))
                    .font(ConsoleTheme.mono(11)).monospacedDigit().foregroundStyle(ConsoleTheme.fg3)
                    .lineLimit(1).truncationMode(.tail)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(ConsoleTheme.active)
        .accessibilityLabel("Editing \(item.text)")
    }

    /// Edit · Kind ▸ (the current one checked) · Forget, or Restore — the same array for the ⋯ and the context menu.
    private var menuVerbs: [ConsoleVerb] {
        let kinds = MemoryKind.allCases.map { kind in
            ConsoleVerb(id: "kind.\(kind.rawValue)", title: kind.rawValue, checked: kind == item.kind) { verbs.setKind(kind) }
        }
        var out = [ConsoleVerb(id: "edit", title: MemoryWords.edit, run: verbs.edit),
                   ConsoleVerb(id: "kind", title: MemoryWords.kind, children: kinds)]
        if live {
            out.append(ConsoleVerb(id: "forget", title: MemoryWords.forget, separatorBefore: true, run: verbs.forget))
        } else {
            out.append(ConsoleVerb(id: "restore", title: MemoryWords.restore, separatorBefore: true, run: verbs.restore))
        }
        return out
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
        TextField(MemoryWords.editPlaceholder, text: $text, axis: .vertical)
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
            .consoleHelp(MemoryWords.editHelp)
            .accessibilityLabel(MemoryWords.editLabel)
    }

    private func finish(_ body: () -> Void) {
        guard !done else { return }
        done = true
        body()
    }
}

// MARK: - Now › Memory · used this turn

/// What the last delegation was given (MemorySummary.lastUsedIds), resolved against the live
/// list: at most eight `ConsoleRow`s (kind glyph · the sentence · the kind badge · `seen 4× · 3d`),
/// so a misheard "fact" steering the voice is seen the turn it happens; ↑↓ ⏎ (or a click) open
/// Settings › Memory. Re-read when the ids change; "—" while nothing has been used.
struct MemoryUsedList: View {
    let ids: [String]

    @Environment(\.consoleMemory) private var memory
    @EnvironmentObject private var session: ConsoleSession
    @State private var items: [MemoryItem] = []
    @State private var loading = false
    @StateObject private var focus = ConsoleListFocus()

    /// The rail shows this many at most; the brain's block is capped at about that many lines anyway.
    static let maxRows = 8

    private var shown: [MemoryItem] { Array(items.prefix(Self.maxRows)) }

    var body: some View {
        ZStack(alignment: .topLeading) {
            if !items.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(shown) { item in
                        MemoryUsedRow(item: item, focused: focus.ringOn(item.id), hovered: { if $0 { focus.hovered(item.id) } }) { open() }
                            .transition(Motion.appear)
                    }
                }
                .consoleListKeys(ConsoleListKeys(focus: focus, ids: shown.map(\.id), typeAhead: false, primary: { _ in open() }))
                .padding(.horizontal, -12)
                .transition(.opacity)
            } else if loading {
                HStack(spacing: 8) {
                    ConsoleGlyphs(cols: 8, rows: 1)
                    Text(MemoryWords.reading).font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg3)
                }
                .frame(height: 22)
                .transition(.opacity)
            } else {
                Text(ids.isEmpty ? MemoryWords.nothingUsed : MemoryWords.usedNotListed(ids.count))
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

    /// The row's primary: Settings › Memory (the link that did not exist).
    private func open() { withAnimation(Motion.snappy) { session.select(.settings) } }
}

/// One used sentence at 40: the kind glyph, the text on two lines, the kind badge, `seen 4× · 3d`.
private struct MemoryUsedRow: View {
    let item: MemoryItem
    var focused = false
    var hovered: (Bool) -> Void = { _ in }
    let open: () -> Void

    var body: some View {
        let now = ConsoleFormat.nowMs
        ConsoleRow(title: item.text, lines: 2, icon: .symbol(ConsoleTheme.memorySymbol(item.kind)),
                   badge: .word(MemoryWords.kindChip(item.kind)), badgeWidth: MemoryRow.badgeWidth,
                   meta: MemoryFormat.meta(item, now: now), focused: focused, id: MemoryWords.usedCardId(item.id), card: MemoryFormat.card(item, now: now),
                   accessibilityHint: MemoryWords.opensSettings, onHover: hovered, primary: open)
    }
}
