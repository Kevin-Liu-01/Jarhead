import SwiftUI

/// The Console's root. This is the only view (besides the audio meters) that
/// observes `AppState`; it slices the snapshot — and the wake gate's three
/// published values, the one open conversation, and Jarhead's own sessions from
/// the ledger — into plain values for the three regions, each of which is
/// `Equatable` so a 20 Hz level tick re-evaluates nothing below this body.
///
/// Lines: the header owns its bottom rule; the two vertical rules between the
/// columns are drawn here, once each; the rails draw no edge of their own.
struct ConsoleRootView: View {
    @EnvironmentObject private var state: AppState
    @EnvironmentObject private var session: ConsoleSession
    @Environment(\.consoleActions) private var actions
    @Environment(\.controlActiveState) private var controlActiveState
    /// Jarhead's own conversations: the ledger's sessions folded into resume chains.
    /// Folded once per list, not per body — this body runs on every 20 Hz level tick.
    @State private var chains: [JarheadChain] = []

    var body: some View {
        let snap = state.snapshot
        // The session Kevin stepped into, while it is still on the rail.
        let openAgent = session.openAgentId.flatMap { id in snap.agents.first { $0.id == id } }
        // Gone from a rail that still lists sessions: the conversation is over, and
        // must not pop back over the stream if the id shows up again. An empty rail
        // is the registry still listing (the daemon just started), so the id survives
        // that and the tail resumes with the rail.
        let orphaned = session.openAgentId != nil && openAgent == nil && !snap.agents.isEmpty
        // The live (or paused) chain is the rail's Now row, not a past conversation.
        let liveId = snap.session?.id ?? snap.pause?.sessionId
        let past = chains.filter { chain in liveId.map { !chain.contains($0) } ?? true }
        let openChain = session.openJarheadSessionId.flatMap { id in chains.first { $0.id == id } }
        let chainGone = session.openJarheadSessionId != nil && openChain == nil && !state.jarheadSessions.isEmpty
        // Which pane holds the centre; a change is a crossfade (Motion.swap) between the
        // two, so stepping into a conversation or back to Now never cuts.
        let paneKey = openAgent.map { "agent:\($0.id)" } ?? openChain.map { "jarhead:\($0.id)" } ?? "now"
        VStack(spacing: 0) {
            ConsoleHeader(phase: snap.phase, connected: state.connected, daemonDetail: state.daemonDetail)
                .equatable()
            HStack(spacing: 0) {
                AgentsRail(agents: snap.agents, connectors: snap.connectors, jarhead: past, now: JarheadNowInfo(snapshot: snap))
                    .equatable()
                    .frame(width: ConsoleLayout.agentsRailWidth)
                ConsoleHairline(vertical: true, thickness: ConsoleHairline.sidebarEdge)
                // A ZStack, so the pane leaving and the pane arriving overlap for the
                // crossfade instead of standing side by side in the HStack.
                ZStack {
                    if let agent = openAgent {
                        // Only that agent's transcript reaches the pane; its id is the pane's
                        // identity, so switching sessions closes one tail and opens the next.
                        ConversationPane(agent: agent, transcript: state.transcripts[agent.id])
                            .equatable()
                            .id(agent.id)
                            .transition(Motion.swap)
                    } else if let chain = openChain {
                        // A past Jarhead conversation, read-only, from the ledger.
                        JarheadConversationPane(chain: chain, entries: session.jarheadEntries, log: session.jarheadLog,
                                                loading: session.jarheadLoading, view: session.jarheadView)
                            .equatable()
                            .id(chain.id)
                            .transition(Motion.swap)
                    } else {
                        StreamPane(transcript: snap.transcript, delegations: snap.delegations, phase: snap.phase,
                                   hasSession: snap.session != nil, ledgerDay: session.ledgerDay,
                                   ledgerEntries: session.ledgerEntries, ledgerLoading: session.ledgerLoading)
                            .equatable()
                            .transition(Motion.swap)
                    }
                }
                .frame(minWidth: ConsoleLayout.streamMinWidth, maxWidth: .infinity)
                .clipped()
                .animation(Motion.gentle, value: paneKey)
                ConsoleHairline(vertical: true, thickness: ConsoleHairline.sidebarEdge)
                RightRail(snapshot: snap, ledgerDays: session.ledgerDays, ledgerDay: session.ledgerDay,
                          ledgerLoading: session.ledgerLoading, ledgerStats: session.ledgerStats, tab: session.tab,
                          wake: WakeGateInputs(gate: state.wakeGate, heard: state.wakeHeard, passphraseSet: state.wakePassphraseSet))
                    .equatable()
                    .frame(width: ConsoleLayout.rightRailWidth)
            }
        }
        // The two Jarhead-section actions need AppState, which leaf views never see:
        // they are filled in here and handed down with the controller's others.
        .environment(\.consoleActions, jarheadActions)
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
        // The list came back without the open chain (an id the ledger no longer knows): back to Now.
        .onChange(of: chainGone) {
            if chainGone { session.closeJarhead() }
        }
        // The Jarhead list: when the Console opens (the view tree survives a close, so
        // the window coming back to key is the reopen), and — from AppState's own watch —
        // when the session id changes or the phase settles to asleep / paused.
        .onAppear { state.refreshJarheadSessions() }
        .onChange(of: state.jarheadSessions, initial: true) { chains = JarheadChain.build(state.jarheadSessions) }
        .onChange(of: controlActiveState) {
            if controlActiveState == .key { state.refreshJarheadSessions() }
        }
        .onReceive(NotificationCenter.default.publisher(for: ConsoleSession.openJarheadSessionNotification)) { note in
            guard let id = note.userInfo?["sessionId"] as? String,
                  let chain = chains.first(where: { $0.contains(id) }) else { return }
            if let raw = note.userInfo?["view"] as? String,
               let view = ConsoleSession.JarheadView.allCases.first(where: { $0.rawValue.lowercased() == raw.lowercased() }) {
                session.jarheadView = view
            }
            let session = self.session, state = self.state
            Task { @MainActor in await session.openJarhead(chain, from: state) }
        }
        // The same sum the window's minSize uses, so the columns always fit.
        .frame(minWidth: ConsoleLayout.minWidth, minHeight: ConsoleLayout.minHeight)
    }

    private var jarheadActions: ConsoleActions {
        var a = actions
        let session = self.session, state = self.state
        a.openJarheadConversation = { chain in Task { @MainActor in await session.openJarhead(chain, from: state) } }
        a.showNow = { session.showNow() }
        return a
    }
}

/// 44pt: the wordmark, a phase dot with one word, and the connection dot. The word and
/// the dot crossfade as the phase turns.
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
                        .contentTransition(.opacity)
                        .animation(Motion.fade, value: phase)
                }
                .help(meta.hint)
                .accessibilityElement(children: .combine)
                Spacer()
                Circle()
                    .fill(connected ? ConsoleTheme.acting : ConsoleTheme.muted)
                    .frame(width: 6, height: 6)
                    .animation(Motion.fade, value: connected)
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

/// Toasts arrive with a fade and a rise (a little life), leave with a fade and a drop
/// gaining speed; the ones left behind reflow under `Motion.gentle`.
struct ToastStack: View {
    let toasts: [Toast]

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
                .transition(ConsoleMotion.arriveLeave)
            }
        }
        .fixedSize()
        .animation(Motion.gentle, value: toasts)
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
