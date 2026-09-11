import SwiftUI

/// The Console's root. This is the only view (besides the audio meters) that
/// observes `AppState`; it slices the snapshot — and the wake gate's three
/// published values, and the one open conversation — into plain values for the
/// three regions, each of which is `Equatable` so a 20 Hz level tick
/// re-evaluates nothing below this body.
///
/// Lines: the header owns its bottom rule; the two vertical rules between the
/// columns are drawn here, once each; the rails draw no edge of their own.
struct ConsoleRootView: View {
    @EnvironmentObject private var state: AppState
    @EnvironmentObject private var session: ConsoleSession

    var body: some View {
        let snap = state.snapshot
        // The session Kevin stepped into, while it is still on the rail.
        let openAgent = session.openAgentId.flatMap { id in snap.agents.first { $0.id == id } }
        // Gone from a rail that still lists sessions: the conversation is over, and
        // must not pop back over the stream if the id shows up again. An empty rail
        // is the registry still listing (the daemon just started), so the id survives
        // that and the tail resumes with the rail.
        let orphaned = session.openAgentId != nil && openAgent == nil && !snap.agents.isEmpty
        VStack(spacing: 0) {
            ConsoleHeader(phase: snap.phase, connected: state.connected, daemonDetail: state.daemonDetail)
                .equatable()
            HStack(spacing: 0) {
                AgentsRail(agents: snap.agents, connectors: snap.connectors)
                    .equatable()
                    .frame(width: ConsoleLayout.agentsRailWidth)
                ConsoleHairline(vertical: true, thickness: ConsoleHairline.sidebarEdge)
                if let agent = openAgent {
                    // Only that agent's transcript reaches the pane; its id is the pane's
                    // identity, so switching sessions closes one tail and opens the next.
                    ConversationPane(agent: agent, transcript: state.transcripts[agent.id])
                        .equatable()
                        .id(agent.id)
                        .frame(minWidth: ConsoleLayout.streamMinWidth, maxWidth: .infinity)
                } else {
                    StreamPane(transcript: snap.transcript, delegations: snap.delegations, phase: snap.phase,
                               hasSession: snap.session != nil, ledgerDay: session.ledgerDay,
                               ledgerEntries: session.ledgerEntries, ledgerLoading: session.ledgerLoading)
                        .equatable()
                        .frame(minWidth: ConsoleLayout.streamMinWidth, maxWidth: .infinity)
                }
                ConsoleHairline(vertical: true, thickness: ConsoleHairline.sidebarEdge)
                RightRail(snapshot: snap, ledgerDays: session.ledgerDays, ledgerDay: session.ledgerDay,
                          ledgerLoading: session.ledgerLoading, ledgerStats: session.ledgerStats, tab: session.tab,
                          wake: WakeGateInputs(gate: state.wakeGate, heard: state.wakeHeard, passphraseSet: state.wakePassphraseSet))
                    .equatable()
                    .frame(width: ConsoleLayout.rightRailWidth)
            }
        }
        .background(ConsoleTheme.ground.ignoresSafeArea())
        .overlay(alignment: .top) {
            // Centred under the header rule, over the stream; never over a rail's controls.
            ToastStack(toasts: state.toasts).padding(.top, 53)
        }
        .sheet(item: $session.lightbox) { item in
            LightboxView(item: item) { session.lightbox = nil }
        }
        .ignoresSafeArea(.container, edges: .top)
        .onChange(of: orphaned) {
            if orphaned { session.openAgentId = nil }
        }
        // The same sum the window's minSize uses, so the columns always fit.
        .frame(minWidth: ConsoleLayout.minWidth, minHeight: ConsoleLayout.minHeight)
    }
}

/// 44pt: the wordmark, a phase dot with one word, and the connection dot.
struct ConsoleHeader: View, Equatable {
    let phase: Phase
    let connected: Bool
    let daemonDetail: String

    static func == (a: ConsoleHeader, b: ConsoleHeader) -> Bool {
        a.phase == b.phase && a.connected == b.connected && a.daemonDetail == b.daemonDetail
    }

    var body: some View {
        let meta = ConsoleTheme.phase(phase)
        VStack(spacing: 0) {
            HStack(spacing: 14) {
                Text("Jarhead").font(ConsoleTheme.sans(13, .medium)).foregroundStyle(ConsoleTheme.fg)
                HStack(spacing: 7) {
                    ConsoleDot(color: meta.color, live: ConsoleTheme.livePhases.contains(phase), size: 6)
                    Text(meta.label).font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg2)
                        .animation(nil, value: phase)
                }
                .help(meta.hint)
                .accessibilityElement(children: .combine)
                Spacer()
                Circle()
                    .fill(connected ? ConsoleTheme.acting : ConsoleTheme.muted)
                    .frame(width: 6, height: 6)
                    .help(connected ? "Connected" + (daemonDetail.isEmpty ? "" : " · \(daemonDetail)") : "Disconnected" + (daemonDetail.isEmpty ? "" : " · \(daemonDetail)"))
                    .accessibilityLabel(connected ? "Connected" : "Disconnected")
            }
            .padding(.leading, 84) // room for the traffic lights in the transparent titlebar
            .padding(.trailing, 16)
            .frame(height: 44)
            ConsoleHairline()
        }
    }
}

struct ToastStack: View {
    let toasts: [Toast]
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            ForEach(toasts) { toast in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    ConsoleIcon(name: symbol(toast.tone), tint: color(toast.tone))
                    Text(toast.text)
                        .font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg)
                        .lineLimit(3)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(EdgeInsets(top: 7, leading: 8, bottom: 7, trailing: 12))
                .frame(maxWidth: 420, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 6).fill(ConsoleTheme.raised))
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(ConsoleTheme.hair, lineWidth: 1))
                .transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
            }
        }
        .fixedSize()
        .animation(reduceMotion ? nil : ConsoleTheme.motion, value: toasts)
        .allowsHitTesting(false)
    }

    private func color(_ tone: Toast.Tone) -> Color {
        switch tone {
        case .info: return ConsoleTheme.titanium
        case .warn: return ConsoleTheme.speaking
        case .error: return ConsoleTheme.error
        }
    }

    private func symbol(_ tone: Toast.Tone) -> String {
        switch tone {
        case .info: return "info.circle.fill"
        case .warn: return "hand.raised.fill"
        case .error: return "exclamationmark.triangle.fill"
        }
    }
}
