import SwiftUI

// Left rail: sessions grouped by the tool that owns them (Claude Code, Codex,
// Cursor…). A group is a 24pt head (the tool's mark, its name, a count) and 44pt
// rows: the mark on the icon column, the name with its status ringed in the
// brand colour, and one mono meta line — project · messages · age. Groups are
// separated by a gap, never a rule; a down connector keeps a head of its own so
// its reason shows. Clicking a row steps into that conversation in the stream;
// the selected row carries the accent bar.

private let railInset: CGFloat = 12
private let iconGap: CGFloat = 8
/// Where text starts: the inset, the 20pt icon column and its gap.
private let textInset: CGFloat = railInset + 20 + iconGap

struct AgentsRail: View, Equatable {
    let agents: [AgentInfo]
    let connectors: [ConnectorHealth]

    @EnvironmentObject private var session: ConsoleSession
    @Environment(\.consoleActions) private var actions
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var refreshSpin = 0.0

    static func == (a: AgentsRail, b: AgentsRail) -> Bool { a.agents == b.agents && a.connectors == b.connectors }

    private struct Group: Identifiable {
        let tool: AgentTool
        let agents: [AgentInfo]
        var id: String { tool.rawValue }
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

    /// Connectors that are down: a head with the reason, whatever sessions exist.
    private var down: [ConnectorHealth] {
        ConsoleTheme.kindOrder.compactMap { kind in connectors.first { $0.kind == kind && !$0.ok } }
            + connectors.filter { !$0.ok && !ConsoleTheme.kindOrder.contains($0.kind) }
    }

    var body: some View {
        VStack(spacing: 0) {
            // The head owns its bottom rule; it meets the right rail's tab row at the same height.
            ConsoleSectionHead("Agents", count: agents.isEmpty ? nil : agents.count) {
                Button {
                    actions.send(.agentRefresh)
                    if !reduceMotion { withAnimation(ConsoleTheme.motion) { refreshSpin += 360 } }
                } label: {
                    Image(systemName: "arrow.clockwise").font(.system(size: 12, weight: .semibold))
                        .rotationEffect(.degrees(refreshSpin))
                }
                .buttonStyle(ConsoleButtonStyle(kind: .plain, iconOnly: true, height: 24))
                .help("Refresh")
                .accessibilityLabel("Refresh agents")
            }
            .padding(.trailing, -4)
            .frame(height: 40)
            ConsoleHairline()

            ScrollView(.vertical) {
                // Relative times refresh on a slow cadence without rebuilding rows elsewhere.
                TimelineView(.periodic(from: .now, by: 15)) { ctx in
                    let now = ctx.date.timeIntervalSince1970 * 1000
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if agents.isEmpty {
                            ConsoleEmpty("No sessions on this Mac right now.")
                        }
                        ForEach(Array(groups.enumerated()), id: \.element.id) { index, group in
                            groupView(group, now: now)
                                .padding(.top, index > 0 ? 12 : 0)
                        }
                        ForEach(Array(down.enumerated()), id: \.element.kind) { index, connector in
                            downView(connector)
                                .padding(.top, index > 0 || !groups.isEmpty ? 12 : 0)
                        }
                    }
                    .padding(.top, 8).padding(.bottom, 24)
                }
                .thinScrollers()
            }
        }
    }

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
                    withAnimation(reduceMotion ? nil : ConsoleTheme.fast) {
                        session.openAgentId = open ? nil : agent.id
                    }
                }
                .background(open ? ConsoleTheme.active : Color.clear)
                .overlay(alignment: .leading) {
                    if open { Rectangle().fill(ConsoleTheme.accent).frame(width: 2).padding(.vertical, 4) }
                }
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

struct AgentRowView: View {
    let agent: AgentInfo
    let now: Double
    let open: Bool
    let toggle: () -> Void

    @State private var hovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

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
                }
            }
            .padding(EdgeInsets(top: 4, leading: railInset, bottom: 6, trailing: railInset))
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .background(!open && hovering ? ConsoleTheme.hover : Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(reduceMotion ? nil : ConsoleTheme.fast, value: hovering)
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
