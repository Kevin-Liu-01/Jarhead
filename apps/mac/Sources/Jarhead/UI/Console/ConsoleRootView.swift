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
    /// Jarhead's own conversations: the ledger's sessions folded into resume chains, with
    /// Kevin's latest cleanup clicks overlaid until the ledger confirms them.
    /// Folded once per list, not per body — this body runs on every 20 Hz level tick.
    @State private var chains: [JarheadChain] = []

    /// Now is ThreadPane("main") — the main conversation over its own seq-paged stream — rather
    /// than the StreamPane over the snapshot's cards. False this pass (`Engine.SNAPSHOT_FULL_NOW`
    /// is true and the snapshot still carries the cards); the flip is the integrator's one-line
    /// follow-up. While false, main has no row of its own in the sidebar's Threads section (the
    /// Now row IS the main conversation) and ⌘⇧] / ⌘⇧[ walk the spawned threads only; the right
    /// rail still lists main (its status, and Stop for its turn) and that row opens its pane.
    nonisolated static let nowIsThreadPane = false

    /// The ids ⌘⇧] / ⌘⇧[ walk and the sidebar lists, from the rail's order: without main while Now is the stream.
    nonisolated static func walkOrder(_ ids: [String]) -> [String] {
        nowIsThreadPane ? ids : ids.filter { $0 != "main" }
    }


    /// The centre pane, type-erased on purpose: the five-way choice below sat inside `body`'s
    /// one expression and the compiler on a slower toolchain (CI's runner) gave up type-checking
    /// it ("unable to type-check this expression in reasonable time"). An `AnyView` boundary here
    /// keeps `body`'s inference small; the panes themselves are unchanged and still `.equatable()`.
    private func centrePane(openAgent: AgentInfo?, openChain: JarheadChain?, openThread: WorkThread?, snap: Snapshot, threads: [WorkThread]) -> AnyView {
        AnyView(Group {
            if let agent = openAgent {
                // Only that agent's transcript reaches the pane; its id is the pane's
                // identity, so switching sessions closes one tail and opens the next —
                // and gives the new pane its own viewer token (ConversationPane.viewer).
                // `loaded` is what "Load earlier" brought back: the feed's ceiling grows by it.
                ConversationPane(agent: agent, transcript: state.transcripts[agent.id], connected: state.connected,
                                 loaded: state.prependedCount[agent.id] ?? 0)
                    .equatable()
                    .id(agent.id)
                    .transition(.identity)
            } else if let chain = openChain {
                // A past Jarhead conversation, read-only, from the ledger.
                JarheadConversationPane(chain: chain, entries: session.jarheadEntries, log: session.jarheadLog,
                                        loading: session.jarheadLoading, view: session.jarheadView,
                                        scrollTarget: session.jarheadScrollTarget)
                    .equatable()
                    .id(chain.id)
                    .transition(.identity)
            } else if let thread = openThread {
                // One thread's conversation over its own stream (`thread.open` as this pane's
                // viewer): its id is the pane's identity, so switching threads closes one stream
                // and opens the next. "main" is Now seen as a thread — the same feed the Now
                // stream will be once the snapshot stops carrying the cards (SNAPSHOT_FULL_NOW).
                ThreadPane(thread: thread, store: state.threadStores[thread.id], phase: snap.phase,
                           connected: state.connected, typedWakes: snap.settings.typedWakes ?? false)
                    .equatable()
                    .id(thread.id)
                    .transition(.identity)
            } else if ConsoleRootView.nowIsThreadPane, session.ledgerDay == nil, let main = state.threads["main"] {
                // Now as the main thread's own pane (the flip; see `nowIsThreadPane`). A ledger
                // day underneath, or a daemon without threads, still draws the StreamPane below.
                ThreadPane(thread: main, store: state.threadStores["main"], phase: snap.phase,
                           connected: state.connected, typedWakes: snap.settings.typedWakes ?? false)
                    .equatable()
                    .id("now:main")
                    .transition(.identity)
            } else {
                StreamPane(transcript: snap.transcript, delegations: snap.delegations, phase: snap.phase,
                           hasSession: snap.session != nil, ledgerDay: session.ledgerDay,
                           ledgerEntries: session.ledgerEntries, ledgerLoading: session.ledgerLoading,
                           clearedAt: state.nowClearedAt, workers: snap.allWorkers, connected: state.connected,
                           threads: threads.filter { $0.id != "main" }, typedWakes: snap.settings.typedWakes ?? false)
                    .equatable()
                    .transition(.identity)
            }

        })
    }

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
        // The thread stepped into (AppState.threads: from events and the snapshot, finished ones
        // kept five minutes and never pruned while open — `heldThreadIds`). Gone from a store the
        // daemon feeds: the pane closes, back to Now.
        let threads = state.orderedThreads
        // The sidebar's rows: main only once Now is its pane (else the Now row above is main).
        let railIds = Set(ConsoleRootView.walkOrder(threads.map(\.id)))
        let railThreads = threads.filter { railIds.contains($0.id) }
        let openThread = session.openThreadId.flatMap { state.threads[$0] }
        let threadGone = session.openThreadId != nil && openThread == nil && state.threadsKnown
        // Which pane holds the centre; a change happens behind the curtain (Motion.curtain): the
        // arriving pane renders plainly and a sheet of ground-coloured Bayer cells over it goes rank
        // by rank, so stepping into a conversation or back to Now never cuts and never masks.
        let paneKey = openAgent.map { "agent:\($0.id)" } ?? openChain.map { "jarhead:\($0.id)" } ?? openThread.map { "thread:\($0.id)" } ?? "now"
        VStack(spacing: 0) {
            ConsoleHeader(phase: snap.phase, connected: state.connected, daemonDetail: state.daemonDetail)
                .equatable()
            HStack(spacing: 0) {
                AgentsRail(agents: snap.agents, connectors: snap.connectors, jarhead: past, now: JarheadNowInfo(snapshot: snap),
                           hiddenAgents: state.hiddenAgentIds(in: snap), trash: snap.trash,
                           threads: railThreads, threadsKnown: state.threadsKnown)
                    .equatable()
                    .frame(width: ConsoleLayout.agentsRailWidth)
                ConsoleHairline(vertical: true, thickness: ConsoleHairline.sidebarEdge)
                // A ZStack: the pane and, over it, the curtain. The panes swap at once
                // (`.identity`: the leaving one is gone the frame the arriving one lands, both
                // under the curtain at progress 0), and the curtain — a clear placeholder keyed
                // to the pane — is re-inserted by the key change, arriving as a full sheet of
                // ground-coloured cells that goes rank by rank (Motion.curtain). Nothing is
                // masked: a mask on a pane of text cost 0.3–0.5 s a frame (AGENTS.md).
                ZStack {
                    centrePane(openAgent: openAgent, openChain: openChain, openThread: openThread, snap: snap, threads: threads)
                    Color.clear
                        .allowsHitTesting(false)
                        .id(paneKey)
                        .transition(Motion.curtain(ConsoleTheme.ground))
                }
                .frame(minWidth: ConsoleLayout.streamMinWidth, maxWidth: .infinity)
                .clipped()
                // The pane change's transaction is the wipe's own animation (Motion.wipeAnimation):
                // the curtain's transition carries the same, so the two agree to the frame.
                .animation(Motion.wipeAnimation, value: paneKey)
                ConsoleHairline(vertical: true, thickness: ConsoleHairline.sidebarEdge)
                RightRail(snapshot: snap, ledgerDays: session.ledgerDays, ledgerDay: session.ledgerDay,
                          ledgerLoading: session.ledgerLoading, ledgerStats: session.ledgerStats, tab: session.tab,
                          wake: WakeGateInputs(gate: state.wakeGate, heard: state.wakeHeard, passphraseSet: state.wakePassphraseSet),
                          threads: state.threadsKnown ? threads : nil)
                    .equatable()
                    .frame(width: ConsoleLayout.rightRailWidth)
            }
        }
        // The Jarhead-section actions need AppState, which leaf views never see:
        // they are filled in here and handed down with the controller's others.
        .environment(\.consoleActions, jarheadActions)
        // The Memory rail's reads (`memory.list` / `memory.search`), through AppState's handlers.
        .environment(\.consoleMemory, memoryActions)
        // The quiet dithered field (ConsoleGround): the regions draw no grounds of their own.
        .background(ConsoleGround().ignoresSafeArea())
        .overlay(alignment: .top) {
            // Centred under the header rule, over the stream; never over a rail's controls.
            // The cleanup's toast ("Moved to Trash · Undo") sits under the engine's toasts.
            VStack(alignment: .trailing, spacing: 6) {
                ToastStack(toasts: state.toasts)
                if let toast = state.cleanupToast {
                    CleanupToastView(toast: toast, undo: { state.undoCleanup(id: toast.id) }, dismiss: { state.dismissCleanupToast() })
                        .transition(ConsoleMotion.arriveLeave)
                }
            }
            .fixedSize()
            .animation(Motion.gentle, value: state.cleanupToast?.id)
            .padding(.top, 53)
        }
        // ⌘F while the Console is key: the rail's search (the window handles ⌘W ⌘. ⌘K ⌘P itself).
        .background {
            Button("") { withAnimation(Motion.gentle) { session.openSearch() } }
                .keyboardShortcut("f", modifiers: .command)
                .opacity(0).frame(width: 0, height: 0)
                .accessibilityHidden(true)
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
        // The open thread left the store (a daemon that forgot it): back to Now.
        .onChange(of: threadGone) {
            if threadGone { session.openThreadId = nil }
        }
        // The thread on screen is held (never pruned under Kevin) and newest in the LRU; the
        // conversations no pane shows go past the newest eight (AppState.evictThreadStores).
        .onChange(of: session.openThreadId, initial: true) { _, id in
            state.heldThreadIds = Set([id].compactMap { $0 })
            if let id { state.noteThreadStoreUsed(id) }
            state.evictThreadStores(keep: state.heldThreadIds)
        }
        // The same for the agents' conversations: bounded per agent at 400 already, now bounded across them.
        .onChange(of: session.openAgentId) { _, id in
            if let id { state.noteTranscriptOpened(id) }
            state.evictTranscripts(keep: Set([id].compactMap { $0 }))
        }
        // The Jarhead list: when the Console opens (the view tree survives a close, so
        // the window coming back to key is the reopen), and — from AppState's own watch —
        // when the session id changes or the phase settles to asleep / paused.
        .onAppear {
            state.refreshJarheadSessions()
            // Edit › Undo / ⌘Z for the cleanup actions, on whichever window is key at the click.
            state.cleanupUndoManager = { NSApp.keyWindow?.undoManager }
        }
        .onChange(of: state.jarheadSessions, initial: true) {
            state.pruneChainOverrides(against: state.jarheadSessions)
            rebuildChains()
        }
        .onChange(of: state.chainOverrides) { rebuildChains() }
        .onChange(of: snap.hiddenAgents) { state.pruneHiddenAgentOverrides(snap) }
        // A new session (a new conversation, a resume) is a fresh Now: nothing is cleared in it.
        .onChange(of: liveId) { if state.nowClearedAt != nil { state.nowClearedAt = nil } }
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
        .onReceive(NotificationCenter.default.publisher(for: ConsoleSession.previewNotification)) { note in
            preview(note.userInfo ?? [:])
        }
        // The same sum the window's minSize uses, so the columns always fit.
        .frame(minWidth: ConsoleLayout.minWidth, minHeight: ConsoleLayout.minHeight)
    }

    /// The ledger's list folded into chains, Kevin's pending clicks laid over them.
    private func rebuildChains() {
        let overrides = state.chainOverrides
        chains = JarheadChain.build(state.jarheadSessions).map { chain in
            overrides[chain.id].map { chain.overlaid($0) } ?? chain
        }
    }

    /// The Memory rail's way to the store: AppState's handlers (EngineClient.memoryList /
    /// memorySearch behind them, installed by the app), read at call time so a handler the
    /// app installs after the window exists is still found. `installed` is AppState's own flag,
    /// so a build that never wired them blames the app, not the daemon.
    private var memoryActions: ConsoleMemoryActions {
        let state = self.state
        return ConsoleMemoryActions(list: { st, limit in await state.memoryList(state: st, limit: limit) },
                                    search: { query, limit in await state.memorySearch(query, limit: limit) },
                                    installed: state.memoryInstalled)
    }

    private var jarheadActions: ConsoleActions {
        var a = actions
        let session = self.session, state = self.state
        a.openJarheadConversation = { chain in Task { @MainActor in await session.openJarhead(chain, from: state) } }
        a.showNow = { session.showNow() }
        a.cleanup = { action in
            // A row being renamed that is then trashed or archived: the field goes with it.
            if session.renamingChainId != nil, action.chainAfter[session.renamingChainId!] != nil { session.renamingChainId = nil }
            state.performCleanup(action)
        }
        a.undoCleanup = { state.undoCleanup() }
        a.search = { query in session.search(query, from: state) }
        a.openJarheadHit = { [self] hit in
            // A hit in the live (or paused) conversation is Now — never a frozen read of the
            // ledger's copy, which the full chain list would otherwise find first.
            let liveId = state.snapshot.session?.id ?? state.snapshot.pause?.sessionId
            if hit.sessionId == liveId {
                withAnimation(Motion.snappy) { session.showNow() }
                return
            }
            if let chain = chains.first(where: { $0.id == hit.chainId || $0.contains(hit.sessionId) }) {
                if let liveId, chain.contains(liveId) {
                    withAnimation(Motion.snappy) { session.showNow() }
                    return
                }
                // openJarhead sets the open id itself (and animates the rail's glide): setting it
                // here first made it think the conversation was already on screen and skip the read.
                Task { @MainActor in await session.openJarhead(chain, from: state, scrollTo: hit.at) }
            } else {
                state.toast("That conversation is not on the rail", tone: .info)
            }
        }
        // The engine's "Open Setup" remedy names `jarhead://setup`: the wizard, in-process; the URL
        // never leaves the app (handed to the system it would come back as a plain Console show).
        let open = a.open
        a.open = { target in
            if target.lowercased().hasPrefix("jarhead://setup") { state.openOnboarding(); return }
            open(target)
        }
        return a
    }

    /// The preview harness drives the cleanup state through `ConsoleSession.previewNotification`.
    private func preview(_ info: [AnyHashable: Any]) {
        if let q = info["search"] as? String {
            withAnimation(Motion.gentle) { session.openSearch() }
            session.search(q, from: state)
        }
        if let on = info["trashOpen"] as? Bool { withAnimation(Motion.snappy) { session.trashOpen = on } }
        if let on = info["archivedOpen"] as? Bool { withAnimation(Motion.snappy) { session.archivedOpen = on } }
        if let on = info["hiddenOpen"] as? Bool { withAnimation(Motion.snappy) { session.hiddenAgentsOpen = on } }
        if let ids = info["select"] as? [String] { withAnimation(Motion.gentle) { session.selectedChainIds = Set(ids) } }
        if let id = info["rename"] as? String { withAnimation(Motion.snappy) { session.renamingChainId = id } }
        if let id = info["trash"] as? String, let chain = chains.first(where: { $0.id == id }) { state.performCleanup(.trash([chain])) }
        if info["clearNow"] as? Bool == true { state.performCleanup(.clearNow(at: ConsoleFormat.nowMs)) }
        // The `loading` scenario: every read left in flight, so the loading states are on screen.
        if info["pinLoading"] as? Bool == true { session.pinLoadingForPreview() }
        // The durability scenario: a daemon reconnect (the open pane must re-send its agent.open,
        // as the same viewer), and the window hidden / shown (the tail closes and reopens).
        if info["reconnect"] as? Bool == true { session.reconnectCount += 1 }
        if let visible = info["windowVisible"] as? Bool { session.windowVisible = visible }
        // The thread scenarios: open a thread's pane the way a rail row would; answer its question
        // the way the pane's Allow / Deny do (`thread.answer`, never say-text or stop); step with
        // ⌘⇧] / ⌘⇧[ the way the window does.
        if let id = info["threadOpen"] as? String { withAnimation(Motion.wipeAnimation) { session.openThread(id) } }
        if let spec = info["threadAnswer"] as? [String: Any], let id = spec["threadId"] as? String, let yes = spec["yes"] as? Bool {
            state.threadAnswer(id, yes: yes)
        }
        if let delta = info["threadStep"] as? Int { withAnimation(Motion.wipeAnimation) { session.stepThread(by: delta, order: ConsoleRootView.walkOrder(state.orderedThreads.map(\.id))) } }
        // A search hit, the way SearchHitRow opens one: the first of the current hits, or one named outright.
        if info["hitFirst"] as? Bool == true {
            if let hit = session.searchHits?.first { jarheadActions.openJarheadHit(hit) } else { print("probe: hit-first → no hits yet") }
        }
        if let spec = info["hit"] as? [String: Any], let sessionId = spec["sessionId"] as? String, let at = spec["at"] as? Double {
            jarheadActions.openJarheadHit(LedgerHit(sessionId: sessionId, at: at, type: "heard", text: ""))
        }
        // What the open conversation holds right now (run.log), so a landed hit is checked, not reasoned.
        if info["probe"] as? Bool == true {
            var first = ""
            if let entry = session.jarheadEntries.first, case .utterance(let t) = entry { first = t.text }
            let target = session.jarheadScrollTarget
            let landed = target.flatMap { JarheadConversationPane.scrollTo(at: $0, in: session.jarheadEntries) }
            print("probe: open=\(session.openJarheadSessionId ?? "nil") loaded=\(session.loadedChainId ?? "nil") entries=\(session.jarheadEntries.count) log=\(session.jarheadLog.count)"
                  + " loading=\(session.jarheadLoading) scrollTarget=\(target.map { String(format: "%.0f", $0) } ?? "nil") scrollToId=\(landed ?? "nil") first='\(first)'")
        }
    }
}

/// The cleanup's toast: the action's solid symbol, its line, Undo while it can be undone, ×.
/// The same chrome as the engine's toasts (ToastStack); arrives bouncy, leaves easing in
/// (ConsoleMotion.arriveLeave), and lets go on its own after AppState.cleanupToastSeconds.
struct CleanupToastView: View {
    let toast: CleanupToast
    let undo: () -> Void
    let dismiss: () -> Void

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            ConsoleIcon(name: toast.symbol)
            Text(toast.text)
                .font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            // The buttons keep their width; a long line wraps before "Undo" would clip.
            if toast.canUndo {
                Button("Undo", action: undo)
                    .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 22, small: true))
                    .fixedSize()
                    .layoutPriority(1)
                    .help("Undo (⌘Z)")
            }
            Button(action: dismiss) {
                Image(systemName: "xmark").font(.system(size: 10, weight: .semibold))
            }
            .buttonStyle(ConsoleButtonStyle(kind: .plain, iconOnly: true, height: 22))
            .fixedSize()
            .layoutPriority(1)
            .help("Dismiss")
            .accessibilityLabel("Dismiss")
        }
        .padding(EdgeInsets(top: 5, leading: 8, bottom: 5, trailing: 6))
        .frame(maxWidth: 420, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 6).fill(ConsoleTheme.raised))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(ConsoleTheme.hair, lineWidth: 1))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(toast.text + (toast.canUndo ? ". Undo" : ""))
    }
}

/// 44pt: the mark and the wordmark, a phase dot with one word, and the connection dot.
/// The word and the dot crossfade as the phase turns.
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
                HStack(spacing: 6) {
                    // The dithered orb as the brand mark, beside the wordmark.
                    JarheadMark(size: 14)
                    Text("Jarhead").font(ConsoleTheme.sans(13, .medium)).foregroundStyle(ConsoleTheme.fg)
                }
                .accessibilityElement(children: .combine)
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
