import SwiftUI

// A past Jarhead conversation in the centre column, read-only — no composer: it is
// the ledger's record, not a session to talk to. A header shaped like an agent
// conversation's so the two read as siblings: a 40pt row with the Jarhead mark, the
// title (the first thing Kevin said), a Conversation | Log toggle and "‹ Stream",
// the way back to Now — its rule on the rails' seam — then a 28pt mono strip on the
// raised ground with every figure whole: started · ran · billed · how it closed, and
// "resumed ×n from …" when the chain was paused and resumed. (One row cannot hold
// the figures at the pane's default width; a strip keeps them off the tooltip.)
// Below it either the stream's own rows rebuilt from the chain's ledger rows
// (StreamFeed, the sticky bottom and jump pill included) or every row as a terse
// mono log: time · type · text.

private let iconGap: CGFloat = 8
private let stampWidth: CGFloat = 56
private let stampGap: CGFloat = 10
private let kindWidth: CGFloat = 68
private let metaStripHeight: CGFloat = 28

struct JarheadConversationPane: View, Equatable {
    let chain: JarheadChain
    let entries: [StreamEntry]
    let log: [JarheadLogLine]
    let loading: Bool
    let view: ConsoleSession.JarheadView
    /// A row's wall-clock ms to open on (a search hit; ConsoleSession.jarheadScrollTarget); nil follows the end.
    var scrollTarget: Double? = nil

    @EnvironmentObject private var session: ConsoleSession
    @Environment(\.consoleActions) private var actions

    static func == (a: JarheadConversationPane, b: JarheadConversationPane) -> Bool {
        a.chain == b.chain && a.entries == b.entries && a.log == b.log && a.loading == b.loading && a.view == b.view
            && a.scrollTarget == b.scrollTarget
    }

    var body: some View {
        VStack(spacing: 0) {
            JarheadConversationHeader(chain: chain, view: view, select: select, close: close, restore: restore)
            // Conversation ↔ Log: the two crossfade in place (Motion.swap) as the thumb glides.
            ZStack {
                switch view {
                case .conversation:
                    StreamFeed(entries: entries, modeKey: "jarhead:\(chain.id)",
                               emptyState: StreamEmptyState(text: loading ? "Reading…" : "Nothing recorded.", loading: loading),
                               scrollToId: scrollTarget.flatMap { JarheadConversationPane.scrollTo(at: $0, in: entries) })
                        .transition(Motion.swap)
                case .log:
                    JarheadLogView(lines: log, loading: loading, scrollToId: scrollTarget.flatMap { JarheadConversationPane.scrollTo(at: $0, in: log) })
                        .transition(Motion.swap)
                }
            }
            .clipped()
            .animation(Motion.gentle, value: view)
        }
        .accessibilityElement(children: .contain)
    }

    /// The entry to open on for a row at `at`: the one written that millisecond, else the
    /// nearest within two seconds (a delegation's card sits at its created row; a hit inside
    /// it lands on the card). nil when nothing is near.
    static func scrollTo(at: Double, in entries: [StreamEntry]) -> String? {
        nearest(at: at, among: entries.map { ($0.id, $0.at) })
    }

    /// The log line to open on, the same way.
    static func scrollTo(at: Double, in lines: [JarheadLogLine]) -> String? {
        nearest(at: at, among: lines.map { ($0.id, $0.at) })
    }

    private static func nearest(at: Double, among rows: [(id: String, at: Double)]) -> String? {
        guard at.isFinite, !rows.isEmpty else { return nil }
        if let exact = rows.first(where: { $0.at == at }) { return exact.id }
        let best = rows.min { abs($0.at - at) < abs($1.at - at) }
        guard let best, abs(best.at - at) <= 2000 else { return nil }
        return best.id
    }

    /// The header's Restore: back from Archived or the Trash, undoable like every cleanup.
    private func restore() {
        actions.cleanup(.restore([chain]))
    }

    private func select(_ view: ConsoleSession.JarheadView) {
        withAnimation(Motion.snappy) { session.jarheadView = view }
    }

    /// Back to Now — the live stream, whatever ledger day was open underneath. The pane
    /// crossfades under the root's Motion.gentle; the rail's highlight glides with this.
    private func close() {
        withAnimation(Motion.snappy) { session.showNow() }
    }
}

// MARK: - Header

/// The 40pt row owns its bottom rule so it meets the two rail heads on one seam; the
/// meta strip under it owns its own.
private struct JarheadConversationHeader: View {
    let chain: JarheadChain
    let view: ConsoleSession.JarheadView
    let select: (ConsoleSession.JarheadView) -> Void
    let close: () -> Void
    let restore: () -> Void

    private var title: String { chain.displayTitle.isEmpty ? "—" : chain.displayTitle }

    /// "in the Trash" / "archived" — where the conversation sits, with the way back beside it.
    private var placed: (symbol: String, word: String)? {
        if chain.isTrashed { return ("trash.fill", "in the Trash") }
        if chain.isArchived { return ("archivebox.fill", "archived") }
        return nil
    }

    /// How the chain ended: "paused", "stopped", "idle", "connection_lost", "closed"; "open" while it never did.
    private var ended: String { chain.isOpen ? "open" : ConsoleFormat.closeReason(chain.reason) }

    /// `started 14:03:22 · ran 12:34 · 2.3 min billed · paused` — every figure, whole.
    private var meta: String {
        let ran = chain.endedAt.map { ConsoleFormat.duration(max(0, $0 - chain.startedAt) / 1000) } ?? "—"
        return ["started \(ConsoleFormat.time(chain.startedAt))", "ran \(ran)", "\(TransportFormat.minutes(chain.usageSeconds)) billed", ended]
            .joined(separator: " · ")
    }

    private var metaHelp: String {
        var lines = ["Started \(ConsoleFormat.fullDate(chain.startedAt))"]
        if let end = chain.endedAt { lines.append("Closed \(ConsoleFormat.fullDate(end)) · \(ended)") } else { lines.append("Never closed") }
        lines.append("\(TransportFormat.minutes(chain.usageSeconds)) billed · \(ConsoleFormat.messageCount(chain.messages)) · \(chain.delegations) delegation\(chain.delegations == 1 ? "" : "s")")
        return lines.joined(separator: "\n")
    }

    private var resumed: String? {
        guard chain.resumes > 0, let root = chain.root else { return nil }
        return "resumed ×\(chain.resumes) from \(ConsoleFormat.shortId(root.id))"
    }

    private var chainHelp: String { chain.sessions.map { ConsoleFormat.shortId($0.id) }.joined(separator: " → ") }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: iconGap) {
                JarheadMark()
                // The title identifies the conversation: sized before the controls, so a
                // narrow pane cuts it last. It crossfades if the chain it names changes under it.
                Text(title)
                    .font(ConsoleTheme.sans(13, .medium)).foregroundStyle(ConsoleTheme.fg)
                    .lineLimit(1).truncationMode(.tail)
                    .layoutPriority(2)
                    .help(chain.name.map { "\($0)\n\(chain.title.isEmpty ? "Nothing heard" : chain.title)" } ?? (chain.title.isEmpty ? "Nothing heard in this conversation" : chain.title))
                    .contentTransition(.opacity)
                    .animation(Motion.fade, value: title)
                if chain.pinned {
                    ConsoleIcon(name: "pin.fill", size: 11)
                        .help("Pinned")
                        .accessibilityLabel("Pinned")
                        .transition(.opacity)
                }
                Spacer(minLength: 8)
                JarheadSegmented(selected: view, select: select)
                    .layoutPriority(1)
                // Navigation, named for where it goes — the live stream.
                Button(action: close) { Label("Stream", systemImage: "chevron.left") }
                    .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 24, small: true))
                    .layoutPriority(1)
                    .help("Back to the live stream")
                    .accessibilityLabel("Back to the live stream")
            }
            .padding(.horizontal, 12)
            .frame(height: 40)
            ConsoleHairline()

            HStack(spacing: 12) {
                // The strip's figures roll when the chain they describe grows (a resume landing).
                Text(meta)
                    .font(ConsoleTheme.mono(11)).monospacedDigit().foregroundStyle(ConsoleTheme.titanium)
                    .lineLimit(1).truncationMode(.tail)
                    .layoutPriority(1)
                    .help(metaHelp)
                    .contentTransition(ConsoleMotion.numeric)
                    .animation(Motion.snappy, value: meta)
                Spacer(minLength: 0)
                if let resumed {
                    // The whole line, or the count alone at the pane's minimum — never "resumed ×1 fr…".
                    ViewThatFits(in: .horizontal) {
                        Text(resumed)
                            .font(ConsoleTheme.mono(11)).monospacedDigit().foregroundStyle(ConsoleTheme.titanium)
                            .lineLimit(1)
                        Text("resumed ×\(chain.resumes)")
                            .font(ConsoleTheme.mono(11)).monospacedDigit().foregroundStyle(ConsoleTheme.titanium)
                            .lineLimit(1)
                    }
                    .help(chainHelp)
                }
                // Where it sits, and the way back: never a Delete here or anywhere.
                if let placed {
                    HStack(spacing: 6) {
                        ConsoleIcon(name: placed.symbol, size: 11)
                        Text(placed.word).font(ConsoleTheme.mono(11)).foregroundStyle(ConsoleTheme.titanium).lineLimit(1)
                        Button("Restore", action: restore)
                            .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 20, small: true))
                            .help(chain.isTrashed ? "Back from the Trash" : "Back from Archived")
                    }
                    .layoutPriority(1)
                    .transition(Motion.appear)
                }
            }
            .padding(.horizontal, 12)
            .frame(height: metaStripHeight)
            .background(ConsoleTheme.raised)
            .animation(Motion.gentle, value: chain.state)
            ConsoleHairline()
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Jarhead conversation, \(title), \(meta)" + (resumed.map { ", \($0)" } ?? "") + (placed.map { ", \($0.word)" } ?? ""))
    }
}

/// Conversation | Log: one hairline box, a divider between the options, the active
/// option filled with the text colour and lettered in the ground — the right rail's
/// segmented control at the header's 24pt. The filled thumb is one view on a matched
/// geometry id, so it glides from the old option to the new one (Motion.snappy).
struct JarheadSegmented: View {
    let selected: ConsoleSession.JarheadView
    let select: (ConsoleSession.JarheadView) -> Void

    @Namespace private var thumb

    var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(ConsoleSession.JarheadView.allCases.enumerated()), id: \.element.id) { index, option in
                if index > 0 { Rectangle().fill(ConsoleTheme.hair).frame(width: 1) }
                JarheadSegOption(title: option.rawValue, on: option == selected, thumb: thumb) { select(option) }
            }
        }
        .frame(height: 24)
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(ConsoleTheme.hair, lineWidth: 1))
        .animation(Motion.snappy, value: selected)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("View")
    }
}

private struct JarheadSegOption: View {
    let title: String
    let on: Bool
    let thumb: Namespace.ID
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(ConsoleTheme.sans(12, .medium))
                .foregroundStyle(on ? ConsoleTheme.ground : ConsoleTheme.fg2)
                .padding(.horizontal, 10)
                .frame(height: 24)
                .background {
                    if on {
                        Rectangle().fill(ConsoleTheme.fg).matchedGeometryEffect(id: "thumb", in: thumb)
                    } else if hovering {
                        Rectangle().fill(ConsoleTheme.hover)
                    }
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(ConsoleMotion.hover, value: hovering)
        .animation(Motion.snappy, value: on)
        .help(title == "Log" ? "Every ledger row of this conversation" : "The conversation as the stream showed it")
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

// MARK: - Log

/// One line of the log: `time · type · text`, toned by who or what it was.
struct JarheadLogLine: Identifiable, Equatable {
    enum Tone: Equatable {
        case normal, kevin, jarhead, problem
        /// Session, pause, resume, stop — the transport's own rows.
        case meter
    }
    let id: String
    let at: Double
    let kind: String
    let text: String
    var tone: Tone = .normal
}

enum JarheadLog {
    /// Every row, in ledger order, as one terse line each. Delegation steps say what
    /// ran with the input compacted onto the line; the transport rows say what the
    /// meter did. Billed figures use the meter's spelling (one decimal).
    static func lines(_ rows: [LedgerRow]) -> [JarheadLogLine] {
        var out: [JarheadLogLine] = []
        out.reserveCapacity(rows.count)
        // The last transport row: what a close the engine asked for meant (ConsoleFormat.closeReason).
        var transport: String?
        for (index, row) in rows.enumerated() {
            let id = "\(row.type):\(row.at):\(index)"
            func add(_ kind: String, _ text: String, _ tone: JarheadLogLine.Tone = .normal) {
                out.append(JarheadLogLine(id: id, at: row.at, kind: kind, text: text, tone: tone))
            }
            switch row.type {
            case "session.started":
                transport = nil
                var text = "started · \(ConsoleFormat.shortId(row.sessionId))"
                if let from = row.resumedFrom { text += " · resumed from \(ConsoleFormat.shortId(from))" }
                add("session", text, .meter)
            case "session.closed":
                let reason = ConsoleFormat.closeReason(row.reason, after: transport)
                let why = reason == "closed" ? "closed" : "closed · \(reason)"
                add("session", "\(why) · \(TransportFormat.minutes(row.usageSeconds ?? 0)) billed", .meter)
            case "pause":
                transport = "pause"
                var text = "paused · meter stopped"
                if let usage = row.usageSeconds { text += " · \(TransportFormat.minutes(usage)) billed" }
                add("pause", text, .meter)
            case "resume":
                var text = ConsoleFormat.resumedAfter(row.pausedMs)
                if let from = row.resumedFrom { text += " · from \(ConsoleFormat.shortId(from))" }
                add("resume", text, .meter)
            case "stop":
                if row.how == "pressed" { transport = "stop" }
                var text = ConsoleFormat.stopped(row.how)
                if let cancelled = row.cancelled { text += " · cancelled \(ConsoleFormat.shortId(cancelled))" }
                add("stop", text, .meter)
            case "heard":
                add("kevin", row.item?.text ?? "", .kevin)
            case "said":
                add("jarhead", row.item?.text ?? "", .jarhead)
            case "delegation.created":
                if let d = row.delegation {
                    add("delegate", "\(ConsoleFormat.shortId(d.id)) · \(ConversationFormat.oneLine(d.request))")
                }
            case "delegation.step":
                guard let step = row.step else { break }
                switch step.kind {
                case .tool:
                    if let tool = step.tool {
                        var parts = [tool.name]
                        if let input = tool.input {
                            let compact = ConversationFormat.oneLine(input.compact, max: 140)
                            if !compact.isEmpty, compact != "{}", compact != "null" { parts.append(compact) }
                        }
                        parts.append(tool.ok ? "ok" : "failed")
                        parts.append(ConsoleFormat.ms(tool.ms))
                        add("tool", parts.joined(separator: " · "), tool.ok ? .normal : .problem)
                    } else {
                        add("tool", step.text ?? "tool")
                    }
                case .thinking:
                    add("thinking", ConversationFormat.oneLine(step.text ?? "", max: 200))
                case .commentary:
                    add("spoke", step.text ?? "", .jarhead)
                case .screenshot:
                    add("shot", step.text ?? step.screenshotPath ?? "")
                case .confirm:
                    add("confirm", step.text ?? "")
                case .error:
                    add("error", step.text ?? "", .problem)
                case .note:
                    add("note", step.text ?? "")
                }
            case "delegation.finished":
                var parts = [ConsoleFormat.shortId(row.delegationId), row.status?.rawValue ?? "done"]
                if let summary = row.summary, !summary.isEmpty { parts.append(ConversationFormat.oneLine(summary, max: 200)) }
                add("delegate", parts.joined(separator: " · "), row.status == .failed ? .problem : .normal)
            case "problem":
                add("problem", row.text ?? "problem", .problem)
            case "agent":
                if let a = row.agent {
                    var text = "\(a.name) · \(a.status.rawValue)"
                    if let detail = a.detail, !detail.isEmpty { text += " · \(detail)" }
                    add("agent", text)
                }
            case "sleep":
                // Why it slept, before the close it explains: the `session.closed` line after this reads
                // "closed · asleep · said" instead of the meter alone. A pressed Stop's sleep row keeps "stop".
                transport = row.cause == "stop" ? "stop" : "sleep:\(row.cause ?? "command")"
                if let t = ConsoleFormat.tombstone(row) {
                    add(t.kind, [t.text, t.mono, t.trailing].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "), .meter)
                }
            default:
                // The cleanup's tombstone rows: "moved to Trash", "restored", "renamed to …", "pinned" — the meter's tone, they are the record's own moves.
                if let t = ConsoleFormat.tombstone(row) {
                    add(t.kind, [t.text, t.mono, t.trailing].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "), .meter)
                } else {
                    add(row.type, "")
                }
            }
        }
        return out
    }
}

private struct JarheadLogView: View {
    let lines: [JarheadLogLine]
    let loading: Bool
    /// The line to open on (a search hit); nil starts at the top.
    var scrollToId: String? = nil

    @State private var highlightId: String?

    var body: some View {
        ZStack {
            if lines.isEmpty {
                ConsoleEmpty(loading ? "Reading…" : "Nothing recorded.") {
                    if loading { ProgressView().controlSize(.small) }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .transition(.opacity)
            } else {
                ScrollViewReader { proxy in
                    ScrollView(.vertical) {
                        // Lazy is fine here: nothing sticks to the bottom of a finished log.
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(lines) { line in
                                JarheadLogRow(line: line)
                                    .background(RoundedRectangle(cornerRadius: 6).fill(ConsoleTheme.active).opacity(highlightId == line.id ? 1 : 0))
                                    .id(line.id)
                            }
                        }
                        .padding(EdgeInsets(top: 8, leading: 12, bottom: 12, trailing: 16))
                        .thinScrollers()
                    }
                    .onAppear { if let id = scrollToId { scroll(to: id, proxy: proxy) } }
                    .onChange(of: scrollToId) { _, id in if let id { scroll(to: id, proxy: proxy) } }
                }
                .accessibilityLabel("Log, \(lines.count) rows")
                .transition(.opacity)
            }
        }
        // "Reading…" and the rows that answer it crossfade.
        .animation(Motion.fade, value: lines.isEmpty)
    }

    private func scroll(to id: String, proxy: ScrollViewProxy) {
        guard lines.contains(where: { $0.id == id }) else { return }
        DispatchQueue.main.async {
            if Motion.reduced { proxy.scrollTo(id, anchor: .center) } else { withAnimation(Motion.gentle) { proxy.scrollTo(id, anchor: .center) } }
            withAnimation(Motion.fade) { highlightId = id }
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 1_800_000_000)
                guard highlightId == id else { return }
                withAnimation(Motion.fade) { highlightId = nil }
            }
        }
    }
}

/// `14:03:22  kevin     what is the auth session doing` — three mono columns.
private struct JarheadLogRow: View {
    let line: JarheadLogLine

    private var textColor: Color {
        switch line.tone {
        case .kevin: return ConsoleTheme.fg
        case .jarhead: return ConsoleTheme.fg2
        case .problem: return ConsoleTheme.error
        case .meter: return ConsoleTheme.titanium
        case .normal: return ConsoleTheme.fg2
        }
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            Text(ConsoleFormat.time(line.at))
                .font(ConsoleTheme.mono(11)).monospacedDigit().foregroundStyle(ConsoleTheme.fg3)
                .frame(width: stampWidth, alignment: .trailing)
                .help(ConsoleFormat.fullDate(line.at))
            Text(line.kind)
                .font(ConsoleTheme.mono(11)).foregroundStyle(line.tone == .problem ? ConsoleTheme.error : ConsoleTheme.titanium)
                .lineLimit(1)
                .frame(width: kindWidth, alignment: .leading)
                .padding(.leading, stampGap)
            Text(line.text.isEmpty ? "—" : line.text)
                .font(ConsoleTheme.mono(11)).lineSpacing(2).foregroundStyle(textColor)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.leading, iconGap)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(line.kind): \(line.text)")
    }
}
