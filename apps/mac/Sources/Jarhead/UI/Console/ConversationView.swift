import SwiftUI
import AppKit

// A session's conversation in the centre column, in place of the live stream —
// the way the ledger takes it over for a day. A 40pt header (the tool's mark,
// the name, its project and status, the message count, a live dot while the
// engine tails the file; Reveal, and "‹ Stream", the way back to the live stream
// — always the live one, even when a ledger day was open underneath), the feed —
// user turns right-aligned under person.fill, assistant turns under the mark,
// tool calls as compact cards, reasoning folded — with the stream's sticky
// bottom and jump pill, and a composer that talks to that agent. The 20pt icon
// column stays on the left as everywhere else; timestamps sit in a mono column
// on the right so both sides of the exchange read against the same edge.

private let stampWidth: CGFloat = 56
private let stampGap: CGFloat = 10
private let iconGap: CGFloat = 8

enum ConversationWords {
    static let askTip = "agent.ask."
    static let cwdTip = "agent.cwd."
    /// The header's second line (the cwd and the status detail) under the 40 pt name line.
    static let metaHeight: CGFloat = 20
}

/// The header's second line: the session's cwd whole in mono (head-truncating, its card the
/// path entire) and the status detail in words — what two tooltips carried.
private struct ConversationHeaderMeta: View {
    let agent: AgentInfo

    var body: some View {
        if agent.cwd != nil || agent.detail != nil {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                if let cwd = agent.cwd {
                    Text(cwd)
                        .font(ConsoleTheme.mono(11)).foregroundStyle(ConsoleTheme.titanium)
                        .lineLimit(1).truncationMode(.head)
                        .consoleHelp(id: ConversationWords.cwdTip + agent.id, card: .path(title: ConsoleFormat.projectName(cwd) ?? agent.name, path: cwd), edge: .below)
                }
                if let detail = agent.detail {
                    Text(detail).font(ConsoleTheme.sans(11)).foregroundStyle(ConsoleTheme.fg3).lineLimit(1).truncationMode(.tail)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 8)
            .frame(height: ConversationWords.metaHeight)
        }
    }
}
private let turnMaxWidth: CGFloat = 640

struct ConversationPane: View, Equatable {
    let agent: AgentInfo
    let transcript: AgentTranscript?
    /// The daemon client is connected (AppState.connected): nothing can arrive while it is not,
    /// so no indicator may claim it will.
    var connected = true
    /// Rows Kevin brought back with "Load earlier" (AppState.prependedCount): the feed's ceiling
    /// grows by as many. Held to a flat 400 the page he asked for would sit above the fold,
    /// unseen, and the next press would re-send the same `before` id — a no-op.
    var loaded = 0

    @EnvironmentObject private var session: ConsoleSession
    @Environment(\.consoleActions) private var actions
    /// This pane's name on the wire (`agent.open {viewer}`): one per pane instance — the root
    /// keys the pane to the agent's id, so a new session is a new token — and stable across the
    /// app's reconnects, so a re-open after a daemon restart never counts twice and the tail ends
    /// when this pane's one `agent.close` lands. Never per send.
    @State private var viewer = UUID().uuidString

    static func == (a: ConversationPane, b: ConversationPane) -> Bool {
        a.agent == b.agent && a.transcript == b.transcript && a.connected == b.connected && a.loaded == b.loaded
    }

    /// Something can still arrive: derived every body from the engine's tail flag, the
    /// connection and the agent's lease-bounded status — never a latch the app must remember
    /// to clear (the old `live` flag stayed true across 48 daemon restarts in two days).
    private var isLive: Bool { ConversationPane.isLive(transcript: transcript, agent: agent, connected: connected) }
    /// The "typing" face: the working lease, so it cannot outlive 30 s of silence.
    private var typing: Bool { ConversationPane.typing(transcript: transcript, agent: agent, connected: connected) }

    var body: some View {
        VStack(spacing: 0) {
            ConversationHeader(agent: agent, transcript: transcript, live: isLive, typing: typing, close: close)
            ConversationFeed(agent: agent, transcript: transcript, typing: typing, viewer: viewer, loaded: loaded)
            ConversationComposer(agent: agent, close: close)
        }
        // Follow the session while it is on screen; stop the tail when it is not. The root
        // gives the pane the agent's id as identity, so switching sessions closes one and
        // opens the next. A daemon restart forgets every open (the new engine has none): the
        // pane re-sends its open on each reconnect — only while the window is visible. A
        // hidden Console closes its tail and reopens it when shown, so an hour hidden costs
        // no tailing and no thousands of rows to lay out when the window comes back.
        .onAppear { if session.windowVisible { open() } }
        .onDisappear(perform: closeTail)
        .onChange(of: session.reconnectCount) {
            if session.windowVisible { open() }
        }
        .onChange(of: session.windowVisible) { _, visible in
            if visible { open() } else { closeTail() }
        }
    }

    private func open() { actions.send(.agentOpenAs(agentId: agent.id, viewer: viewer)) }
    private func closeTail() { actions.send(.agentCloseAs(agentId: agent.id, viewer: viewer)) }

    /// Back to the stream — the live one: a ledger day left open behind the
    /// conversation would otherwise take its place, two clicks from live.
    private func close() {
        // The pane crossfades under the root's Motion.gentle; the rail's highlight glides
        // back to Now with Motion.snappy from this transaction.
        withAnimation(Motion.snappy) {
            session.openAgentId = nil
            if session.isLedgerMode { session.showLive() }
        }
    }
}

// MARK: - What the agent's detail says (pure)

extension ConversationPane {
    /// Following, and something can still arrive: the engine tails the file (`transcript.live`),
    /// the daemon is connected, and a process still owns the session — working, idle or blocked
    /// (AgentTranscript.isLive, the model's one derivation). An ended, done, unknown or offline
    /// session is over whatever the tail flag says, so a stale `live: true` from before a
    /// restart never lights the dot; no transcript yet is not live either.
    static func isLive(transcript: AgentTranscript?, agent: AgentInfo, connected: Bool) -> Bool {
        transcript?.isLive(agent: agent, connected: connected) ?? false
    }

    /// The agent is writing right now: live, and its status is the lease-bounded `working`
    /// (a turn-bearing write within 30 s). Idle and blocked are live but not typing.
    static func typing(transcript: AgentTranscript?, agent: AgentInfo, connected: Bool) -> Bool {
        transcript?.typing(agent: agent, connected: connected) ?? false
    }

    /// The most rows the feed lays out: the newest 400 (AppState.maxTranscriptMessages trims the
    /// held transcript to the same; this is the view's own ceiling, so a transcript from an
    /// older model never lays out thousands) plus what Kevin loaded (`loaded`).
    static let maxRows = AppState.maxTranscriptMessages

    /// The newest `maxRows + loaded` of a transcript; the rest stay behind "Load earlier". The
    /// model's cap moves the same way (AppState.prependedCount), so what it holds is what shows.
    static func shown(_ all: [AgentMessage], loaded: Int = 0) -> [AgentMessage] {
        let cap = maxRows + max(0, loaded)
        return all.count > cap ? Array(all.suffix(cap)) : all
    }

    /// The question a blocked session is waiting on, from its detail — the sessions
    /// connector writes "… · needs Kevin's yes or no: Bash — pnpm test" — or nil
    /// when the detail does not read like a permission question.
    static func permissionQuestion(_ agent: AgentInfo) -> String? {
        guard agent.status == .blocked, let detail = agent.detail?.trimmingCharacters(in: .whitespacesAndNewlines), !detail.isEmpty else { return nil }
        let lower = detail.lowercased()
        let cues = ["yes or no", "yes/no", "y/n", "permission", "allow", "approve", "confirm"]
        guard cues.contains(where: { lower.contains($0) }) else { return nil }
        if let colon = detail.range(of: "yes or no:") {
            let q = detail[colon.upperBound...].trimmingCharacters(in: .whitespaces)
            if !q.isEmpty { return String(q) }
        }
        // The connector prefixes "tool · msgs · dir"; the question is the last part.
        let last = detail.components(separatedBy: " · ").last?.trimmingCharacters(in: .whitespaces) ?? ""
        return last.isEmpty ? detail : last
    }

    /// One line for a composer that is off: the session is gone, or its connector
    /// says it cannot take input. nil when sending is fine. The typed gate (`AgentInfo.send`,
    /// computed by the connector from the same evidence as the status) is read first and its
    /// reason shown verbatim — "Open in a terminal", "Archived in Codex", "Not signed in"; the cue
    /// parsing below stays for a daemon from before the gate.
    static func cannotSendReason(_ agent: AgentInfo) -> String? {
        if let gate = agent.send {
            if gate.ok { return nil }
            let reason = gate.reason?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return reason.isEmpty ? "This session can't take messages." : ConsoleFormat.sentence(reason)
        }
        let detail = agent.detail?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let hint = detail.components(separatedBy: " · ").last?.trimmingCharacters(in: .whitespaces) ?? ""
        if agent.status == .offline {
            return hint.isEmpty ? "Offline — this session can't take messages." : "Offline — \(hint)"
        }
        let lower = detail.lowercased()
        for cue in ["read-only", "cannot send", "can't send", "archived", "has ended", "not signed in"] where lower.contains(cue) {
            return hint.isEmpty ? detail : hint
        }
        return nil
    }

    /// What Send will do, from the typed gate: "queued in Codex" while a live owner drains it,
    /// "resumes the session" when nobody does; nil without a gate.
    static func sendModeWords(_ agent: AgentInfo) -> String? {
        guard let gate = agent.send, gate.ok else { return nil }
        switch gate.mode {
        case "queue": return "queued in \(agent.resolvedTool.label)"
        case "resume": return "resumes the session"
        default: return nil
        }
    }

    /// Where Reveal goes: a file or folder the detail names, else the working
    /// directory — only when it exists on this Mac; nil hides the button.
    static func revealURL(_ agent: AgentInfo) -> URL? {
        let fm = FileManager.default
        let home = fm.homeDirectoryForCurrentUser.path
        if let detail = agent.detail {
            for token in detail.split(whereSeparator: { $0.isWhitespace }) {
                var path = String(token).trimmingCharacters(in: CharacterSet(charactersIn: "()[]\"'`,;"))
                guard path.hasPrefix("/") || path.hasPrefix("~/") else { continue }
                if path.hasPrefix("~/") { path = home + path.dropFirst(1) }
                if fm.fileExists(atPath: path) { return URL(fileURLWithPath: path) }
            }
        }
        if let cwd = agent.cwd, !cwd.isEmpty, fm.fileExists(atPath: cwd) { return URL(fileURLWithPath: cwd) }
        return nil
    }
}

// MARK: - Header

/// 40pt, owns its bottom rule so it meets the two rail heads on one seam.
private struct ConversationHeader: View {
    let agent: AgentInfo
    let transcript: AgentTranscript?
    /// Derived by the pane (ConversationPane.isLive / typing): shown while following, pulsing only while writing.
    let live: Bool
    let typing: Bool
    let close: () -> Void

    @Environment(\.consoleActions) private var actions

    private var tool: AgentTool { agent.resolvedTool }
    private var count: Int { transcript?.total ?? agent.messageCount ?? 0 }

    var body: some View {
        let reveal = ConversationPane.revealURL(agent)
        VStack(spacing: 0) {
            HStack(spacing: iconGap) {
                BrandMark(tool: tool)
                // The name is the one thing that identifies the session: it is sized
                // before the count and the buttons, so a narrow pane cuts those first.
                Text(agent.name)
                    .font(ConsoleTheme.sans(13, .medium)).foregroundStyle(ConsoleTheme.fg)
                    .lineLimit(1).truncationMode(.tail)
                    .layoutPriority(2)
                // The status as a word in a box (`asks` amber for blocked); its detail is the second line.
                if let word = ConsoleBadge.agent(agent.status) { ConsoleBadge(word: word) }
                BrandStatusGlyph(status: agent.status, tool: tool)
                Spacer(minLength: 8)
                HStack(spacing: 6) {
                    // The live dot fades in while the tail can still bring something and pulses
                    // only while the agent is writing (the 30 s lease); the count rolls its digits.
                    if live {
                        ConsoleDot(color: brandColor(tool), live: typing, size: 6)
                            .consoleHelp(typing ? HelpCopy.liveWriting : HelpCopy.liveQuiet)
                            .accessibilityLabel(typing ? "Live, writing" : "Live")
                            .transition(.opacity)
                    }
                    Text(ConsoleFormat.messageCount(count))
                        .font(ConsoleTheme.mono(11)).monospacedDigit().foregroundStyle(ConsoleTheme.titanium)
                        .lineLimit(1)
                        .contentTransition(ConsoleMotion.numeric)
                }
                .animation(Motion.fade, value: live)
                .animation(Motion.snappy, value: count)
                .layoutPriority(1)
                if let url = reveal {
                    // The word while there is room; the folder alone at the pane's minimum,
                    // rather than "Rev…".
                    let hint = "Show \(ConsoleFormat.truncPath(url.path, max: 48)) in Finder"
                    ViewThatFits(in: .horizontal) {
                        Button { actions.reveal(url) } label: { Label("Reveal", systemImage: ConsoleGlyph.folder) }
                            .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 24, small: true))
                            .consoleHelp(hint)
                        Button { actions.reveal(url) } label: {
                            Image(systemName: ConsoleGlyph.folder).font(.system(size: 11, weight: .medium))
                        }
                        .buttonStyle(ConsoleButtonStyle(kind: .ghost, iconOnly: true, height: 24, small: true))
                        .consoleHelp(hint)
                        .accessibilityLabel("Reveal")
                    }
                    .layoutPriority(1)
                }
                // Navigation, named for where it goes — not "Live", which next to the
                // live dot would read as a state chip.
                Button(action: close) { Label("Stream", systemImage: ConsoleGlyph.chevronLeft) }
                    .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 24, small: true))
                    .layoutPriority(1)
                    .consoleHelp(HelpCopy.backStreamEsc)
                    .accessibilityLabel("Back to the live stream")
            }
            .padding(.horizontal, 12)
            .frame(height: 40)
            ConversationHeaderMeta(agent: agent)
            ConsoleHairline()
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(tool.label) conversation, \(agent.name)")
    }
}

// MARK: - Feed

private struct ConversationFeed: View {
    let agent: AgentInfo
    let transcript: AgentTranscript?
    /// The agent is writing (ConversationPane.typing): the last row's indicator and a running call's pulse.
    var typing = false
    /// The pane's viewer token, for the Reload / Try again re-open.
    var viewer = ""
    /// Rows Kevin loaded (ConversationPane.loaded): the ceiling grows by as many.
    var loaded = 0

    @Environment(\.consoleActions) private var actions
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @StateObject private var tracker = ConsoleFeedTracker()
    /// `agent.history` is out; cleared when the first message changes, or after a while.
    @State private var loadingEarlier = false
    /// `agent.open` went out a while ago and nothing came back.
    @State private var stale = false
    @State private var retries = 0
    /// One turn after the feed has its transcript: rows arriving after that fade in and
    /// rise on their own ink (`rowAppear`); the ones there from the start show at once —
    /// and so does the tail `agent.open` brings back, which lands whole a moment after the
    /// pane opened on nothing (a conversation being stepped into is not "new"). An older
    /// page prepended above is "there from the start" for its rows too — they land above
    /// the fold while the feed holds its place, so nothing on screen should stir.
    @State private var settled = false

    private static let bottomId = "conversation-bottom"
    /// What stands above the first row at the top of the feed: the stack's top padding (8), the
    /// "Load earlier" row (24) and its bottom padding (8). A viewport top inside it is "at the top".
    private static let loadEarlierStrip: CGFloat = 40
    /// A one-line row, for the anchor's unit point (SwiftUI aligns a fraction of the row with the
    /// same fraction of the viewport; the row's own height is not known here — ±2 pt on a two-line row).
    private static let rowEstimate: CGFloat = 34

    private var messages: [AgentMessage] { ConversationPane.shown(transcript?.messages ?? [], loaded: loaded) }
    private var tool: AgentTool { agent.resolvedTool }

    var body: some View {
        ScrollViewReader { proxy in
            ZStack(alignment: .bottom) {
                GeometryReader { outer in
                    ScrollView(.vertical) {
                        if messages.isEmpty {
                            emptyView.frame(minHeight: outer.size.height)
                                .transition(.opacity)
                        } else {
                            // Lazy, unlike the stream: a conversation can hold hundreds of selectable
                            // rows (the cap is 400) and a busy Codex thread appends for hours, so only the
                            // rows on screen are materialised; the AppKit probe re-pins the bottom on every
                            // document change, which is what a lazy stack's re-estimated heights need.
                            LazyVStack(alignment: .leading, spacing: 0) {
                                if let t = transcript, !t.complete, let first = messages.first {
                                    loadEarlier(before: first, remaining: max(0, t.total - messages.count))
                                }
                                ForEach(messages) { message in
                                    // The last message of a transcript whose agent is writing is the one
                                    // being written: a thinking row there shows the ASCII indicator.
                                    // `typing` is the lease-bounded status, never the tail flag alone.
                                    ConversationRow(message: message, tool: tool,
                                                    live: typing && message.id == messages.last?.id, typing: typing)
                                        .rowAppear(animated: settled && !loadingEarlier)
                                }
                                Color.clear.frame(height: 1).id(Self.bottomId)
                            }
                            .padding(EdgeInsets(top: 8, leading: 12, bottom: 12, trailing: 16))
                            .thinScrollers()
                            .background(alignment: .topLeading) {
                                ConsoleScrollProbe(tracker: tracker).frame(width: 0, height: 0)
                            }
                            .transition(.opacity)
                        }
                    }
                    .animation(Motion.fade, value: messages.isEmpty)
                }
                if tracker.showJump && !messages.isEmpty {
                    Button {
                        tracker.jump(animated: true)
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: ConsoleGlyph.newestLine).font(.system(size: 10, weight: .semibold))
                            Text("Latest")
                        }
                    }
                    .buttonStyle(JumpPillStyle())
                    .padding(.bottom, 12)
                    .transition(ConsoleMotion.arriveLeave)
                    .consoleHelp(HelpCopy.latest)
                }
            }
            .animation(Motion.gentle, value: tracker.showJump)
            .onAppear {
                tracker.reduceMotion = reduceMotion
                tracker.fallback = { animate in
                    if animate {
                        withAnimation(Motion.gentle) { proxy.scrollTo(Self.bottomId, anchor: .bottom) }
                    } else {
                        proxy.scrollTo(Self.bottomId, anchor: .bottom)
                    }
                }
                tracker.jump(animated: false)
                // Opened on nothing (agent.open is out): settle when the tail lands (below).
                if transcript != nil { settle() }
            }
            .onChange(of: transcript == nil) { _, isNil in
                if !isNil { settle() }
            }
            .onChange(of: reduceMotion) { tracker.reduceMotion = reduceMotion }
            .onChange(of: messages) {
                if tracker.stuck { tracker.jump(animated: false) }
            }
            .onChange(of: messages.first?.id) { oldId, _ in
                loadingEarlier = false
                // Rows arrived *above* the one Kevin was reading (an older page): hold his place.
                // The tracker still has the geometry from before this update; the document grows
                // once it lays out, so act on the next turn. At the top — where "Load earlier" is
                // pressed — anchor by the ROW: SwiftUI puts the row he was reading back under the
                // strip that stood above it. Not by the document's height: a lazy stack re-estimates
                // rows below the viewport too (under the meters' 20 Hz churn that put the row four
                // rows off). Mid-feed, where the strip is not the reference, the probe's hold on the
                // document's growth is what there is.
                guard !tracker.stuck, let oldId,
                      let index = messages.firstIndex(where: { $0.id == oldId }), index > 0,
                      let geo = tracker.lastGeometry else { return }
                DispatchQueue.main.async {
                    if geo.minY <= Self.loadEarlierStrip {
                        let rowTop = Self.loadEarlierStrip - geo.minY
                        proxy.scrollTo(oldId, anchor: UnitPoint(x: 0, y: rowTop / max(1, geo.viewport - Self.rowEstimate)))
                    } else {
                        tracker.probe?.keepOffset(previousContent: geo.content)
                    }
                }
            }
            .task(id: loadingEarlier) {
                guard loadingEarlier else { return }
                try? await Task.sleep(nanoseconds: 8_000_000_000)
                guard !Task.isCancelled else { return }
                loadingEarlier = false
            }
            .task(id: "\(transcript == nil)-\(retries)") {
                stale = false
                guard transcript == nil else { return }
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                guard !Task.isCancelled else { return }
                stale = true
            }
        }
    }

    private func loadEarlier(before first: AgentMessage, remaining: Int) -> some View {
        HStack {
            Spacer(minLength: 0)
            // The button and "Loading…" are both 24pt, so the swap is a crossfade with
            // no layout under it.
            ZStack {
                if loadingEarlier {
                    HStack(spacing: 8) {
                        ConsoleGlyphs(cols: 8, rows: 1)
                        Text("Loading…").font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg3)
                    }
                    .frame(height: 24)
                    .transition(.opacity)
                } else {
                    Button {
                        loadingEarlier = true
                        actions.send(.agentHistory(agentId: agent.id, before: first.id))
                    } label: {
                        Label("Load earlier", systemImage: ConsoleGlyph.earlierLine)
                    }
                    .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 24, small: true))
                    .consoleHelp(remaining > 0 ? "\(remaining) earlier message\(remaining == 1 ? "" : "s")" : "Earlier messages")
                    .transition(.opacity)
                }
            }
            .animation(Motion.fade, value: loadingEarlier)
            Spacer(minLength: 0)
        }
        .padding(.bottom, 8)
    }

    /// Rows from the next turn on are "new": the ones in this frame show at once.
    private func settle() {
        guard !settled else { return }
        DispatchQueue.main.async { settled = true }
    }

    /// Ask for the tail again, as this pane's viewer: opens are idempotent per viewer, so a
    /// re-open never double-counts, and the pane's one `agent.close` (onDisappear) still ends
    /// the tail. Close first so the engine re-pages from the file rather than answering from
    /// what it already follows.
    private func reopen() {
        actions.send(.agentCloseAs(agentId: agent.id, viewer: viewer))
        actions.send(.agentOpenAs(agentId: agent.id, viewer: viewer))
    }

    private var emptyView: some View {
        Group {
            if let t = transcript {
                // A page with nothing on it while the file has messages: ask for the tail again.
                ConsoleEmpty(t.total == 0 ? "Nothing said yet." : "Nothing loaded yet.") {
                    if t.total > 0 {
                        Button(action: reopen) { Label("Reload", systemImage: ConsoleGlyph.reloadLine) }
                            .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 24, small: true))
                    }
                }
            } else if stale {
                ConsoleEmpty("Nothing from the engine yet.") {
                    Button {
                        retries += 1
                        reopen()
                    } label: { Label("Try again", systemImage: ConsoleGlyph.reloadLine) }
                    .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 24, small: true))
                }
            } else {
                ConsoleEmpty("Opening…") { ConsoleGlyphs(cols: 16, rows: 2) }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Rows

struct ConversationRow: View, Equatable {
    let message: AgentMessage
    let tool: AgentTool
    /// The agent is writing and this is its last message (still being thought or written).
    var live = false
    /// The agent is writing (ConversationPane.typing): a running call's dot pulses only then.
    var typing = false

    var body: some View {
        if message.thinking == true {
            ThinkingRow(message: message, live: live)
        } else {
            switch message.role {
            case .user:
                UserTurn(message: message)
            case .assistant:
                AssistantTurn(message: message, tool: tool)
            case .tool:
                if let call = message.tool {
                    ToolCallCard(message: message, call: call, typing: typing)
                } else {
                    NoteRow(message: message, symbol: "terminal.fill")
                }
            case .system:
                NoteRow(message: message, symbol: "info.circle.fill")
            }
        }
    }
}

/// The right-aligned mono timestamp every row ends with.
private struct RightStamp: View {
    let at: Double
    var body: some View {
        Text(ConsoleFormat.time(at))
            .font(ConsoleTheme.mono(11)).monospacedDigit().foregroundStyle(ConsoleTheme.fg3)
            .frame(width: stampWidth, alignment: .trailing)
            .padding(.leading, stampGap)
            .consoleHelp(ConsoleFormat.fullDate(at))
    }
}

private struct AssistantTurn: View {
    let message: AgentMessage
    let tool: AgentTool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            BrandMark(tool: tool)
            Text(message.text.isEmpty ? "…" : message.text)
                .font(ConsoleTheme.sans(13))
                .lineSpacing(3)
                .foregroundStyle(ConsoleTheme.fg)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.leading, iconGap)
                .frame(maxWidth: turnMaxWidth, alignment: .leading)
            Spacer(minLength: 0)
            RightStamp(at: message.at)
        }
        .padding(.vertical, 5)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(tool.label): \(message.text)")
    }
}

/// Kevin's turn: the text on a raised surface, set against the right edge. A pending echo (a
/// line just sent, before the tool's file confirms it) sits at 0.6 opacity under `clock.fill`;
/// past `AppState.pendingEchoStaleMs` it says so — "Queued · not picked up yet" — since a
/// `codex queue` that exited 0 says nothing about anyone draining it.
private struct UserTurn: View {
    let message: AgentMessage

    private var pending: Bool { message.pending == true }

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            Spacer(minLength: 20 + iconGap)
            VStack(alignment: .trailing, spacing: 3) {
                Text(message.text.isEmpty ? "…" : message.text)
                    .font(ConsoleTheme.sans(13))
                    .lineSpacing(3)
                    .foregroundStyle(ConsoleTheme.fg)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(EdgeInsets(top: 6, leading: 10, bottom: 6, trailing: 10))
                    .background(RoundedRectangle(cornerRadius: 6).fill(ConsoleTheme.raised))
                if pending {
                    TimelineView(.periodic(from: .now, by: 5)) { ctx in
                        let stale = ctx.date.timeIntervalSince1970 * 1000 - message.at >= AppState.pendingEchoStaleMs
                        Text(stale ? "Queued · not picked up yet" : "Sending…")
                            .font(ConsoleTheme.mono(11)).foregroundStyle(ConsoleTheme.titanium)
                            .contentTransition(.opacity)
                            .animation(Motion.fade, value: stale)
                    }
                    .transition(.opacity)
                }
            }
            .frame(maxWidth: turnMaxWidth, alignment: .trailing)
            ConsoleIcon(name: pending ? "clock.fill" : "person.fill", tint: ConsoleTheme.titanium)
                .padding(.leading, iconGap)
                .padding(.top, 4)
                .consoleHelp(pending ? "Sent; waiting for the session to take it" : "Kevin")
                .accessibilityLabel(pending ? "Kevin, sending" : "Kevin")
            RightStamp(at: message.at).padding(.top, 7)
        }
        .padding(.vertical, 5)
        .opacity(pending ? 0.6 : 1)
        .animation(Motion.fade, value: pending)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Kevin\(pending ? ", pending" : ""): \(message.text)")
    }
}

/// A tool call: one hairline box on the content column — the name in mono, a
/// status dot, the input on one line — that unfolds into the input and output.
private struct ToolCallCard: View {
    let message: AgentMessage
    let call: AgentToolCall
    /// The agent is writing: only then does a running call's dot pulse. A call left `running`
    /// by a session that stopped writing sits still until its result — or `interrupted` — lands.
    var typing = false

    @State private var expanded = false

    private var dotColor: Color {
        switch call.status {
        case .running: return ConsoleTheme.thinking
        case .done: return ConsoleTheme.acting
        case .error: return ConsoleTheme.error
        // The session ended with this call still open: settled, grey, never a pulse.
        case .interrupted: return ConsoleTheme.titanium
        }
    }

    /// The word beside the dot when the status needs one: "interrupted" (settled grey, no
    /// output will come); the other states speak through the dot and the output.
    private var statusWord: String? { call.status == .interrupted ? "interrupted" : nil }

    /// What the folded line shows after the name: the input, else the message's own text.
    private var preview: String {
        let input = call.input?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let text = input.isEmpty ? message.text : input
        return ConversationFormat.oneLine(text)
    }

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            ConsoleIcon(name: "terminal.fill").padding(.top, 4)
            VStack(alignment: .leading, spacing: 0) {
                Button {
                    // Unfolds on its own once pressed: Motion.gentle, the chevron turning with it.
                    withAnimation(Motion.gentle) { expanded.toggle() }
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: ConsoleGlyph.chevron).font(.system(size: 9, weight: .semibold)).foregroundStyle(ConsoleTheme.fg3)
                            .rotationEffect(.degrees(expanded ? 90 : 0))
                        Text(call.name).font(ConsoleTheme.mono(12)).foregroundStyle(ConsoleTheme.fg)
                            .lineLimit(1).truncationMode(.tail).layoutPriority(1)
                        // Running → done / error / interrupted: the dot's colour crossfades (ConsoleDot);
                        // it pulses only while the agent is actually writing.
                        ConsoleDot(color: dotColor, live: call.status == .running && typing, size: 5)
                            .consoleHelp(call.status.rawValue)
                            .accessibilityLabel(call.status.rawValue)
                        if let word = statusWord {
                            Text(word).font(ConsoleTheme.mono(11)).foregroundStyle(ConsoleTheme.titanium)
                                .lineLimit(1).layoutPriority(1)
                                .transition(.opacity)
                        }
                        if !expanded, !preview.isEmpty {
                            Text(preview).font(ConsoleTheme.mono(11)).foregroundStyle(ConsoleTheme.titanium)
                                .lineLimit(1).truncationMode(.tail)
                                .transition(.opacity)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 10)
                    .frame(height: 28)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(call.name), \(call.status.rawValue)")
                .accessibilityAddTraits(expanded ? .isSelected : [])

                if expanded {
                    VStack(alignment: .leading, spacing: 6) {
                        if !message.text.isEmpty, message.text != call.input {
                            Text(message.text).font(ConsoleTheme.sans(12)).lineSpacing(2).foregroundStyle(ConsoleTheme.fg2)
                                .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                        }
                        ioBlock("input", call.input)
                        if let output = call.output {
                            ioBlock("output", output)
                        } else if call.status == .interrupted {
                            // No result ever came: the session's process ended (or its file went)
                            // with this call open. Said plainly, in the settled grey.
                            Text("interrupted — the session ended before this call answered")
                                .font(ConsoleTheme.sans(11)).foregroundStyle(ConsoleTheme.titanium)
                        } else if call.status == .running {
                            Text(typing ? "running…" : "running — no result yet").font(ConsoleTheme.sans(11)).italic().foregroundStyle(ConsoleTheme.fg3)
                        }
                    }
                    .padding(EdgeInsets(top: 0, leading: 10, bottom: 8, trailing: 10))
                    .transition(Motion.appear)
                }
            }
            .animation(Motion.fade, value: call.status)
            .overlay(Rectangle().stroke(ConsoleTheme.hair, lineWidth: 1))
            .padding(.leading, iconGap)
            // The same measure as the turns around it, so a wide window keeps one right edge.
            .frame(maxWidth: turnMaxWidth, alignment: .leading)
            Spacer(minLength: 0)
            RightStamp(at: message.at).padding(.top, 7)
        }
        .padding(.vertical, 4)
    }

    /// The one artifact surface: raised ink, no border.
    private func ioBlock(_ key: String, _ text: String?) -> some View {
        let body = ConversationFormat.block(text)
        return VStack(alignment: .leading, spacing: 3) {
            Text(key).font(ConsoleTheme.sans(11, .medium)).foregroundStyle(ConsoleTheme.titanium)
            ScrollView(.vertical) {
                Text(body).font(ConsoleTheme.mono(11)).lineSpacing(2).foregroundStyle(ConsoleTheme.fg2)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
            }
            .frame(maxHeight: 180)
            .fixedSize(horizontal: false, vertical: true)
            .background(ConsoleTheme.raised)
        }
    }
}

/// Reasoning, folded under one titanium word; the thought unfolds in italics. While it is
/// being thought (`live`) the icon column shows the ASCII indicator — three glyphs stepping
/// the Bayer ranks — instead of the ellipsis; the two crossfade when it settles.
private struct ThinkingRow: View {
    let message: AgentMessage
    var live = false

    @State private var expanded = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            ZStack {
                if live {
                    ConsoleGlyphs(cols: 3, rows: 1, color: ConsoleTheme.titanium).frame(width: 20, height: 20).transition(.opacity)
                } else {
                    ConsoleIcon(name: "ellipsis", tint: ConsoleTheme.titanium).transition(.opacity)
                }
            }
            .animation(Motion.fade, value: live)
            VStack(alignment: .leading, spacing: 4) {
                Button {
                    withAnimation(Motion.gentle) { expanded.toggle() }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: ConsoleGlyph.chevron).font(.system(size: 9, weight: .semibold)).foregroundStyle(ConsoleTheme.fg3)
                            .rotationEffect(.degrees(expanded ? 90 : 0))
                        Text("thinking").font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.titanium)
                    }
                    .frame(height: 20)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("thinking")
                .accessibilityAddTraits(expanded ? .isSelected : [])
                if expanded {
                    Text(message.text.isEmpty ? "…" : message.text)
                        .font(ConsoleTheme.sans(12)).italic().lineSpacing(2).foregroundStyle(ConsoleTheme.fg3)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.bottom, 4)
                        .transition(Motion.appear)
                }
            }
            .padding(.leading, iconGap)
            .frame(maxWidth: turnMaxWidth, alignment: .leading)
            Spacer(minLength: 0)
            RightStamp(at: message.at)
        }
        .padding(.vertical, 2)
    }
}

/// A system line, or a tool message without a call: one quiet sentence.
private struct NoteRow: View {
    let message: AgentMessage
    let symbol: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            ConsoleIcon(name: symbol, tint: ConsoleTheme.titanium)
            Text(message.text.isEmpty ? "…" : message.text)
                .font(ConsoleTheme.sans(12)).lineSpacing(2).foregroundStyle(ConsoleTheme.fg2)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.leading, iconGap)
                .frame(maxWidth: turnMaxWidth, alignment: .leading)
            Spacer(minLength: 0)
            RightStamp(at: message.at)
        }
        .padding(.vertical, 4)
    }
}

enum ConversationFormat {
    /// The first line, single-spaced, for a folded preview.
    static func oneLine(_ text: String, max: Int = 160) -> String {
        let flat = text.split(whereSeparator: { $0.isNewline }).first.map(String.init) ?? ""
        let squeezed = flat.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        return squeezed.count > max ? String(squeezed.prefix(max)) + "…" : squeezed
    }

    /// A tool's input or output as a block: raw text, capped.
    static func block(_ text: String?, max: Int = 1200) -> String {
        let t = text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if t.isEmpty { return "—" }
        return t.count > max ? String(t.prefix(max)) + "\n…" : t
    }
}

// MARK: - Composer

/// 48pt, owns its top rule: the field addressed to the tool ("Message Codex…"),
/// Send while there is text. A blocked session's permission question sits above
/// the field with Allow / Deny (they send "yes" / "no"; the connector interprets
/// them). When the connector cannot take input the field gives way to one line
/// saying why.
private struct ConversationComposer: View {
    let agent: AgentInfo
    let close: () -> Void

    @Environment(\.consoleActions) private var actions
    @EnvironmentObject private var session: ConsoleSession
    @State private var text = ""
    @FocusState private var focused: Bool

    private var tool: AgentTool { agent.resolvedTool }
    private var hasText: Bool { !text.trimmingCharacters(in: .whitespaces).isEmpty }

    var body: some View {
        let question = ConversationPane.permissionQuestion(agent)
        let off = ConversationPane.cannotSendReason(agent)
        VStack(spacing: 0) {
            ConsoleHairline()
            // A question arriving rises in over the field and drops away once answered;
            // the field giving way to "why not" crossfades.
            if let question {
                HStack(alignment: .firstTextBaseline, spacing: iconGap) {
                    ConsoleIcon(name: "hand.raised.fill", tint: ConsoleTheme.speaking)
                    Text(question)
                        .font(ConsoleTheme.sans(12, .medium)).lineSpacing(2).foregroundStyle(ConsoleTheme.fg)
                        .lineLimit(3).truncationMode(.tail)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .consoleHelp(id: ConversationWords.askTip + agent.id, card: .question(name: tool.label, question: question, detail: agent.detail), edge: .below)
                        .contentTransition(.opacity)
                    Spacer(minLength: 8)
                    Button("Allow") { answer("yes") }
                        .buttonStyle(ConsoleButtonStyle(kind: .primary, height: 26, small: true))
                        .layoutPriority(1)
                        .consoleHelp(HelpCopy.sendYes)
                    Button("Deny") { answer("no") }
                        .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 26, small: true))
                        .layoutPriority(1)
                        .consoleHelp(HelpCopy.sendNo)
                }
                .padding(EdgeInsets(top: 8, leading: 12, bottom: 0, trailing: 12))
                .accessibilityElement(children: .contain)
                .accessibilityLabel("Permission: \(question)")
                .transition(Motion.appear)
            }
            HStack(spacing: 8) {
                if let off {
                    Group {
                        ConsoleIcon(name: "circle.slash.fill", tint: ConsoleTheme.fg3)
                        Text(off).font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg3)
                            .lineLimit(1).truncationMode(.tail)
                            .consoleHelp(off)
                        Spacer(minLength: 0)
                    }
                    .transition(.opacity)
                } else {
                    Group {
                        TextField("Message \(tool.label)…", text: $text)
                            .consoleField(height: 32, focused: focused)
                            .focused($focused)
                            .onSubmit(submit)
                            .onExitCommand(perform: close)
                            .accessibilityLabel("Message \(tool.label)")
                        // One filled accent per strip: while a permission question is up,
                        // Allow has it and a typed answer is the secondary path.
                        Button(action: submit) {
                            Image(systemName: ConsoleGlyph.send).font(.system(size: 13, weight: .semibold))
                        }
                        .buttonStyle(ConsoleButtonStyle(kind: hasText && question == nil ? .primary : .ghost, iconOnly: true, height: 32))
                        .disabled(!hasText)
                        .consoleHelp(HelpCopy.sendMode(ConversationPane.sendModeWords(agent)))
                        .accessibilityLabel("Send")
                    }
                    .transition(.opacity)
                }
            }
            .padding(EdgeInsets(top: 8, leading: 12, bottom: 8, trailing: 12))
            .frame(minHeight: 48)
        }
        .animation(Motion.gentle, value: question)
        .animation(Motion.fade, value: off)
        .onChange(of: session.composerFocusRequest) { focused = true }
    }

    private func submit() {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        actions.send(.agentSend(agentId: agent.id, text: t))
        text = ""
    }

    private func answer(_ word: String) {
        actions.send(.agentSend(agentId: agent.id, text: word))
    }
}
