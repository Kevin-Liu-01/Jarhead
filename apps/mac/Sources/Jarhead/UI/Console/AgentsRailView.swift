import SwiftUI

// Left rail, two sections. **Jarhead** first — its own conversations: a "Now" row
// (the live or paused session: elapsed · billed, or "paused · meter stopped";
// "asleep" when there is none), then past conversations newest first under day
// heads, one 44pt row per conversation — the Jarhead mark, the first thing Kevin
// said with the started clock as its right-hand stamp, and one mono meta line:
// duration · billed · messages. A resume chain (`resumedFrom` links) folds into one
// row with a "resumed ×n" badge beside the stamp. Then
// **Agents**: sessions grouped by the tool that owns them (Claude Code, Codex,
// Cursor…). A group is a 24pt head (the tool's mark, its name, a count) and 44pt
// rows: the mark on the icon column, the name with its status ringed in the
// brand colour, and one mono meta line — project · messages · age. Groups are
// separated by a gap, never a rule; the two sections by one rule and a head. A
// down connector keeps a head of its own so its reason shows. Clicking a row
// steps into that conversation in the stream; the selected row carries the
// accent bar. Now is the selection when nothing is stepped into.

private let railInset: CGFloat = 12
private let iconGap: CGFloat = 8
/// Where text starts: the inset, the 20pt icon column and its gap.
private let textInset: CGFloat = railInset + 20 + iconGap

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
    /// Jarhead's past conversations, newest first — the live chain is the Now row, not one of these.
    let jarhead: [JarheadChain]
    let now: JarheadNowInfo

    @EnvironmentObject private var session: ConsoleSession
    @Environment(\.consoleActions) private var actions
    @State private var refreshSpin = 0.0
    /// The one selection highlight, shared by every row so it glides between them.
    @Namespace private var selection

    static func == (a: AgentsRail, b: AgentsRail) -> Bool {
        a.agents == b.agents && a.connectors == b.connectors && a.jarhead == b.jarhead && a.now == b.now
    }

    /// What is selected, for the glide when the selection moves without a click (a
    /// conversation closing, a rail that came back without the open row).
    private var selectionKey: String {
        session.openAgentId.map { "agent:\($0)" } ?? session.openJarheadSessionId.map { "jarhead:\($0)" } ?? "now"
    }

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

    private var groups: [Group] {
        var seen = Set<AgentTool>()
        var out: [Group] = []
        let tools = ConsoleBrand.order + agents.map(\.resolvedTool).filter { !ConsoleBrand.order.contains($0) }
        for tool in tools where !seen.contains(tool) {
            seen.insert(tool)
            let list = agents.filter { $0.resolvedTool == tool }.sorted { $0.updatedAt > $1.updatedAt }
            if list.isEmpty { continue }
            out.append(Group(tool: tool, agents: list))
        }
        return out
    }

    /// Past conversations under the day they began, newest day first (the list already is).
    private var days: [DayGroup] {
        var order: [String] = []
        var map: [String: [JarheadChain]] = [:]
        for chain in jarhead {
            if map[chain.day] == nil { order.append(chain.day) }
            map[chain.day, default: []].append(chain)
        }
        return order.map { DayGroup(day: $0, chains: map[$0] ?? []) }
    }

    /// Connectors that are down: a head with the reason, whatever sessions exist.
    private var down: [ConnectorHealth] {
        ConsoleTheme.kindOrder.compactMap { kind in connectors.first { $0.kind == kind && !$0.ok } }
            + connectors.filter { !$0.ok && !ConsoleTheme.kindOrder.contains($0.kind) }
    }

    var body: some View {
        VStack(spacing: 0) {
            // The head owns its bottom rule; it meets the right rail's tab row at the same height.
            ConsoleSectionHead("Jarhead", count: jarhead.isEmpty ? nil : jarhead.count)
                .frame(height: 40)
            ConsoleHairline()

            ScrollView(.vertical) {
                // Relative times refresh on a slow cadence without rebuilding rows elsewhere.
                TimelineView(.periodic(from: .now, by: 15)) { ctx in
                    let nowMs = ctx.date.timeIntervalSince1970 * 1000
                    LazyVStack(alignment: .leading, spacing: 0) {
                        jarheadSection(now: nowMs)

                        ConsoleHairline().padding(.top, 12)
                        ConsoleSectionHead("Agents", count: agents.isEmpty ? nil : agents.count) {
                            Button {
                                actions.send(.agentRefresh)
                                if !Motion.reduced { withAnimation(Motion.gentle) { refreshSpin += 360 } }
                            } label: {
                                Image(systemName: "arrow.clockwise").font(.system(size: 12, weight: .semibold))
                                    .rotationEffect(.degrees(refreshSpin))
                            }
                            .buttonStyle(ConsoleButtonStyle(kind: .plain, iconOnly: true, height: 24))
                            .help("Refresh")
                            .accessibilityLabel("Refresh agents")
                        }
                        .padding(.trailing, -4)
                        .padding(.top, 4)

                        if agents.isEmpty {
                            ConsoleEmpty("No sessions on this Mac right now.")
                                .transition(Motion.appear)
                        }
                        ForEach(Array(groups.enumerated()), id: \.element.id) { index, group in
                            groupView(group, now: nowMs)
                                .padding(.top, index > 0 ? 12 : 0)
                                .transition(Motion.appear)
                        }
                        ForEach(Array(down.enumerated()), id: \.element.kind) { index, connector in
                            downView(connector)
                                .padding(.top, index > 0 || !groups.isEmpty ? 12 : 0)
                                .transition(Motion.appear)
                        }
                    }
                    .padding(.top, 8).padding(.bottom, 24)
                    // Rows arriving and leaving (a new session, a conversation closing) fade
                    // and rise or drop with Motion.appear while the rest reflow; the selection
                    // glides to wherever it moved, click or not.
                    .animation(Motion.gentle, value: agents.map(\.id))
                    .animation(Motion.gentle, value: jarhead.map(\.id))
                    .animation(Motion.gentle, value: down.map(\.kind))
                    .animation(Motion.snappy, value: selectionKey)
                }
                .thinScrollers()
            }
        }
    }

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
            JarheadNowRow(info: self.now, now: tick.date.timeIntervalSince1970 * 1000, on: nowOn) {
                withAnimation(Motion.snappy) { actions.showNow() }
            }
        }
        .background { selected(nowOn) }

        ForEach(days) { group in
            dayHead(group.day).padding(.top, 8)
                .transition(Motion.appear)
            ForEach(group.chains) { chain in
                let open = session.openJarheadSessionId == chain.id
                JarheadChainRow(chain: chain, now: now, open: open) {
                    withAnimation(Motion.snappy) {
                        if open { actions.showNow() } else { actions.openJarheadConversation(chain) }
                    }
                }
                .background { selected(open) }
                .transition(Motion.appear)
            }
        }
    }

    /// 24pt: the day in words, its date in mono — the Ledger panel's spelling.
    private func dayHead(_ day: String) -> some View {
        HStack(spacing: iconGap) {
            ConsoleIcon(name: "calendar")
            Text(ConsoleFormat.day(day))
                .font(ConsoleTheme.sans(12, .medium)).foregroundStyle(ConsoleTheme.titanium)
                .lineLimit(1)
            Spacer(minLength: 4)
            Text(day).font(ConsoleTheme.mono(11)).monospacedDigit().foregroundStyle(ConsoleTheme.titanium)
        }
        .padding(.horizontal, railInset)
        .frame(height: 24)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(ConsoleFormat.day(day) + ", " + day)
    }

    // MARK: - Agents

    private func groupView(_ group: Group, now: Double) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: iconGap) {
                BrandMark(tool: group.tool)
                Text(group.tool.label)
                    .font(ConsoleTheme.sans(12, .medium)).foregroundStyle(ConsoleTheme.titanium)
                    .lineLimit(1)
                Spacer(minLength: 4)
                Text("\(group.agents.count)").font(ConsoleTheme.mono(11)).monospacedDigit().foregroundStyle(ConsoleTheme.titanium)
            }
            .padding(.horizontal, railInset)
            .frame(height: 24)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(group.tool.label), \(group.agents.count)")

            ForEach(group.agents) { agent in
                let open = session.openAgentId == agent.id
                AgentRowView(agent: agent, now: now, open: open) {
                    withAnimation(Motion.snappy) {
                        if open { actions.showNow() } else { session.openAgent(agent.id) }
                    }
                }
                .background { selected(open) }
                .transition(Motion.appear)
            }
        }
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
                .help(connector.detail)
        }
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

/// The live conversation: "Now", the phase dot, and elapsed · billed (or why not). The
/// meter's digits roll as the seconds pass; the dot and the pause glyph crossfade.
struct JarheadNowRow: View {
    let info: JarheadNowInfo
    let now: Double
    let on: Bool
    let select: () -> Void

    @State private var hovering = false

    var body: some View {
        let meta = info.meta(now: now)
        let phaseMeta = ConsoleTheme.phase(info.phase)
        Button(action: select) {
            HStack(alignment: .top, spacing: iconGap) {
                JarheadMark()
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 8) {
                        Text("Now")
                            .font(ConsoleTheme.sans(13, on ? .medium : .regular)).foregroundStyle(ConsoleTheme.fg)
                            .lineLimit(1)
                        Spacer(minLength: 4)
                        ZStack {
                            if info.paused {
                                ConsoleIcon(name: "pause.fill", tint: ConsoleTheme.titanium)
                                    .help(phaseMeta.hint)
                                    .accessibilityLabel("Paused")
                                    .transition(.opacity)
                            } else if info.sessionId != nil {
                                ConsoleDot(color: phaseMeta.color, live: ConsoleTheme.livePhases.contains(info.phase), size: 6)
                                    .frame(width: 20, height: 20)
                                    .help(phaseMeta.hint)
                                    .accessibilityLabel(phaseMeta.label)
                                    .transition(.opacity)
                            }
                        }
                        .animation(Motion.fade, value: info.paused)
                        .animation(Motion.fade, value: info.sessionId)
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
            .padding(EdgeInsets(top: 4, leading: railInset, bottom: 6, trailing: railInset))
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .background(!on && hovering ? ConsoleTheme.hover : Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(ConsoleMotion.hover, value: hovering)
        .help(info.sessionId.map { "The live conversation · \(ConsoleFormat.shortId($0))" } ?? "The live conversation")
        .accessibilityLabel("Now, \(meta)")
        .accessibilityHint(on ? "On screen" : "Shows the live stream")
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

/// One past conversation — a session, or a resume chain folded into it.
struct JarheadChainRow: View {
    let chain: JarheadChain
    let now: Double
    let open: Bool
    let toggle: () -> Void

    @State private var hovering = false

    private var title: String { chain.title.isEmpty ? "—" : chain.title }

    /// `12:34 · 2.3 min · 8 msgs` — duration, billed, heard + said. The started clock
    /// sits on the title row: four mono items and their dots do not fit the rail.
    private var metaLine: String {
        ConsoleFormat.jarheadMeta(chain)
    }

    private var tooltip: String {
        var lines = [chain.title.isEmpty ? "Nothing heard" : chain.title]
        lines.append(ConsoleFormat.fullDate(chain.startedAt) + " · " + (chain.isOpen ? "open" : ConsoleFormat.closeReason(chain.reason)))
        if chain.resumes > 0 { lines.append("\(chain.sessions.count) sessions: " + chain.sessions.map { ConsoleFormat.shortId($0.id) }.joined(separator: " → ")) }
        return lines.joined(separator: "\n")
    }

    var body: some View {
        Button(action: toggle) {
            HStack(alignment: .top, spacing: iconGap) {
                JarheadMark()
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 8) {
                        Text(title)
                            .font(ConsoleTheme.sans(13, open ? .medium : .regular)).foregroundStyle(ConsoleTheme.fg)
                            .lineLimit(1).truncationMode(.tail)
                        Spacer(minLength: 4)
                        if chain.resumes > 0 {
                            Text("resumed ×\(chain.resumes)")
                                .font(ConsoleTheme.mono(11)).monospacedDigit().foregroundStyle(ConsoleTheme.titanium)
                                .lineLimit(1)
                                .layoutPriority(1)
                        } else if chain.isOpen {
                            ConsoleDot(color: ConsoleTheme.muted, live: false, size: 6)
                                .frame(width: 20, height: 20)
                                .help("Never closed")
                                .accessibilityLabel("open")
                        }
                        // When it began, right-aligned as a stamp; the day head says which day.
                        Text(ConsoleFormat.clock(chain.startedAt))
                            .font(ConsoleTheme.mono(11)).monospacedDigit().foregroundStyle(ConsoleTheme.titanium)
                            .lineLimit(1)
                            .layoutPriority(1)
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
            .background(!open && hovering ? ConsoleTheme.hover : Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(ConsoleMotion.hover, value: hovering)
        .help(tooltip)
        .accessibilityLabel("Jarhead conversation, \(title), \(metaLine)")
        .accessibilityHint(open ? "Open in the stream" : "Opens the conversation")
        .accessibilityAddTraits(open ? .isSelected : [])
    }
}

// MARK: - Agent rows

struct AgentRowView: View {
    let agent: AgentInfo
    let now: Double
    let open: Bool
    let toggle: () -> Void

    @State private var hovering = false

    private var tool: AgentTool { agent.resolvedTool }

    /// project · 42 msgs · 2m — whichever parts the connector gave.
    private var metaLine: String {
        ConsoleFormat.agentMeta(agent, now: now)
    }

    private var tooltip: String {
        [agent.detail, agent.cwd].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "\n")
    }

    var body: some View {
        Button(action: toggle) {
            HStack(alignment: .top, spacing: iconGap) {
                BrandMark(tool: tool)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 8) {
                        Text(agent.name)
                            .font(ConsoleTheme.sans(13, open ? .medium : .regular)).foregroundStyle(ConsoleTheme.fg)
                            .lineLimit(1).truncationMode(.tail)
                        Spacer(minLength: 4)
                        BrandStatusGlyph(status: agent.status, tool: tool)
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
            .background(!open && hovering ? ConsoleTheme.hover : Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(ConsoleMotion.hover, value: hovering)
        .help(tooltip.isEmpty ? agent.name : tooltip)
        .accessibilityLabel("\(agent.name), \(tool.label), \(agent.status.rawValue)")
        .accessibilityHint(open ? "Open in the stream" : "Opens the conversation")
        .accessibilityAddTraits(open ? .isSelected : [])
    }
}

extension ConsoleFormat {
    /// The rail's meta line: `project · 42 msgs · 2m`. The project is the working
    /// directory's last component; a count of one reads "1 msg".
    static func agentMeta(_ agent: AgentInfo, now: Double) -> String {
        var parts: [String] = []
        if let project = projectName(agent.cwd) { parts.append(project) }
        if let n = agent.messageCount { parts.append(messageCount(n)) }
        parts.append(relative(agent.updatedAt, now: now))
        return parts.joined(separator: " · ")
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
}
