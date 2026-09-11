import SwiftUI

// Left rail: agents grouped by connector. A group is a 24pt head (the
// connector's solid icon, tinted red when it is down, the name, a count) and
// 44pt rows (status glyph, name, relative time, one detail line). Groups are
// separated by a gap, never a rule; the selected row carries the accent bar
// and its composer.

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
        let kind: AgentKind
        let connector: ConnectorHealth?
        let agents: [AgentInfo]
        var id: String { kind.rawValue }
    }

    private var groups: [Group] {
        var seen = Set<AgentKind>()
        var out: [Group] = []
        let kinds = ConsoleTheme.kindOrder + agents.map(\.kind).filter { !ConsoleTheme.kindOrder.contains($0) }
        for kind in kinds where !seen.contains(kind) {
            seen.insert(kind)
            let connector = connectors.first { $0.kind == kind }
            let list = agents.filter { $0.kind == kind }.sorted { $0.updatedAt > $1.updatedAt }
            // A healthy connector with nothing under it is a head with no rows: skip it.
            // A down connector keeps its head so its detail line ("Not running") shows.
            if list.isEmpty && (connector?.ok ?? true) { continue }
            out.append(Group(kind: kind, connector: connector, agents: list))
        }
        return out
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
                    }
                    .padding(.top, 8).padding(.bottom, 24)
                }
                .thinScrollers()
            }
        }
    }

    private func groupView(_ group: Group, now: Double) -> some View {
        let ok = group.connector?.ok ?? true
        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: iconGap) {
                ConsoleIcon(name: ConsoleTheme.kindSymbol(group.kind), tint: ok ? ConsoleTheme.titanium : ConsoleTheme.error)
                Text(ConsoleTheme.kindTitle(group.kind))
                    .font(ConsoleTheme.sans(12, .medium)).foregroundStyle(ConsoleTheme.titanium)
                    .lineLimit(1)
                Spacer(minLength: 4)
                if !group.agents.isEmpty {
                    Text("\(group.agents.count)").font(ConsoleTheme.mono(11)).monospacedDigit().foregroundStyle(ConsoleTheme.titanium)
                }
            }
            .padding(.horizontal, railInset)
            .frame(height: 24)
            .help(group.connector?.detail ?? ConsoleTheme.kindTitle(group.kind))
            .accessibilityLabel("\(ConsoleTheme.kindTitle(group.kind))\(ok ? "" : ", down")")

            if let connector = group.connector, !ok {
                Text(connector.detail)
                    .font(ConsoleTheme.sans(11)).foregroundStyle(ConsoleTheme.fg3)
                    .lineLimit(1).truncationMode(.tail)
                    .padding(.leading, textInset).padding(.trailing, railInset).padding(.bottom, 4)
                    .help(connector.detail)
            }

            ForEach(group.agents) { agent in
                let open = session.openAgentId == agent.id
                VStack(spacing: 0) {
                    AgentRowView(agent: agent, now: now, open: open) {
                        withAnimation(reduceMotion ? nil : ConsoleTheme.fast) {
                            session.openAgentId = open ? nil : agent.id
                        }
                    }
                    if open { AgentComposer(agent: agent) }
                }
                .background(open ? ConsoleTheme.active : Color.clear)
                .overlay(alignment: .leading) {
                    if open { Rectangle().fill(ConsoleTheme.accent).frame(width: 2).padding(.vertical, 4) }
                }
            }
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

    private var detailLine: String? {
        if let d = agent.detail, !d.isEmpty { return d }
        let p = ConsoleFormat.truncPath(agent.cwd, max: 36)
        return p.isEmpty ? nil : p
    }

    private var tooltip: String {
        [agent.detail, agent.cwd].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "\n")
    }

    var body: some View {
        Button(action: toggle) {
            HStack(alignment: .top, spacing: iconGap) {
                ConsoleStatusGlyph(status: agent.status)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(agent.name)
                            .font(ConsoleTheme.sans(13, open ? .medium : .regular)).foregroundStyle(ConsoleTheme.fg)
                            .lineLimit(1).truncationMode(.tail)
                        Spacer(minLength: 4)
                        Text(ConsoleFormat.relative(agent.updatedAt, now: now))
                            .font(ConsoleTheme.mono(11)).monospacedDigit().foregroundStyle(ConsoleTheme.titanium)
                            .help(ConsoleFormat.fullDate(agent.updatedAt))
                    }
                    .frame(height: 20)
                    if let line = detailLine {
                        Text(line)
                            .font(agent.detail == nil ? ConsoleTheme.mono(11) : ConsoleTheme.sans(11))
                            .foregroundStyle(ConsoleTheme.fg3)
                            .lineLimit(1).truncationMode(.tail)
                    }
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
        .accessibilityLabel("\(agent.name), \(agent.status.rawValue)")
        .accessibilityAddTraits(open ? .isSelected : [])
    }
}

/// Continue an agent's session with a message. Return sends.
struct AgentComposer: View {
    let agent: AgentInfo
    @Environment(\.consoleActions) private var actions
    @EnvironmentObject private var session: ConsoleSession
    @State private var text = ""
    @FocusState private var focused: Bool

    private var hasText: Bool { !text.trimmingCharacters(in: .whitespaces).isEmpty }

    var body: some View {
        HStack(spacing: 6) {
            TextField("Message \(agent.name)…", text: $text)
                .consoleField(height: 28, focused: focused)
                .focused($focused)
                .onSubmit(submit)
                .onExitCommand { session.openAgentId = nil }
            Button(action: submit) {
                Image(systemName: "arrow.up").font(.system(size: 12, weight: .semibold))
            }
            .buttonStyle(ConsoleButtonStyle(kind: hasText ? .primary : .ghost, iconOnly: true, height: 28))
            .disabled(!hasText)
            .help("Send (Return)")
            .accessibilityLabel("Send")
        }
        .padding(EdgeInsets(top: 0, leading: textInset, bottom: 8, trailing: railInset))
        .onAppear { focused = true }
    }

    private func submit() {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        actions.send(.agentSend(agentId: agent.id, text: t))
        text = ""
    }
}
