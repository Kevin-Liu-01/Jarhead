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
private let turnMaxWidth: CGFloat = 640

struct ConversationPane: View, Equatable {
    let agent: AgentInfo
    let transcript: AgentTranscript?

    @EnvironmentObject private var session: ConsoleSession
    @Environment(\.consoleActions) private var actions

    static func == (a: ConversationPane, b: ConversationPane) -> Bool {
        a.agent == b.agent && a.transcript == b.transcript
    }

    var body: some View {
        VStack(spacing: 0) {
            ConversationHeader(agent: agent, transcript: transcript, close: close)
            ConversationFeed(agent: agent, transcript: transcript)
            ConversationComposer(agent: agent, close: close)
        }
        // Follow the session while it is on screen; stop the tail when it is not.
        // The root gives the pane the agent's id as identity, so switching
        // sessions closes one and opens the next.
        .onAppear { actions.send(.agentOpen(agentId: agent.id)) }
        .onDisappear { actions.send(.agentClose(agentId: agent.id)) }
    }

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
    /// says it cannot take input. nil when sending is fine.
    static func cannotSendReason(_ agent: AgentInfo) -> String? {
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
    let close: () -> Void

    @Environment(\.consoleActions) private var actions

    private var tool: AgentTool { agent.resolvedTool }
    private var live: Bool { transcript?.live ?? false }
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
                if let project = ConsoleFormat.projectName(agent.cwd) {
                    // Whole or not at all: the project is in the tooltip anyway, and a lone "…" is noise.
                    ViewThatFits(in: .horizontal) {
                        Text(project)
                            .font(ConsoleTheme.mono(11)).foregroundStyle(ConsoleTheme.titanium)
                            .lineLimit(1)
                            .help(agent.cwd ?? project)
                        Color.clear.frame(width: 0, height: 0)
                    }
                }
                BrandStatusGlyph(status: agent.status, tool: tool)
                    .help(agent.detail.map { "\(agent.status.rawValue) · \($0)" } ?? agent.status.rawValue)
                Spacer(minLength: 8)
                HStack(spacing: 6) {
                    // The live dot fades in when the tail starts; the count rolls its digits.
                    if live {
                        ConsoleDot(color: brandColor(tool), live: true, size: 6)
                            .help("Live — following the session as it grows")
                            .accessibilityLabel("Live")
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
                        Button { actions.reveal(url) } label: { Label("Reveal", systemImage: "folder.fill") }
                            .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 24, small: true))
                            .help(hint)
                        Button { actions.reveal(url) } label: {
                            Image(systemName: "folder.fill").font(.system(size: 11, weight: .medium))
                        }
                        .buttonStyle(ConsoleButtonStyle(kind: .ghost, iconOnly: true, height: 24, small: true))
                        .help(hint)
                        .accessibilityLabel("Reveal")
                    }
                    .layoutPriority(1)
                }
                // Navigation, named for where it goes — not "Live", which next to the
                // live dot would read as a state chip.
                Button(action: close) { Label("Stream", systemImage: "chevron.left") }
                    .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 24, small: true))
                    .layoutPriority(1)
                    .help("Back to the live stream (Esc in the composer)")
                    .accessibilityLabel("Back to the live stream")
            }
            .padding(.horizontal, 12)
            .frame(height: 40)
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

    private var messages: [AgentMessage] { transcript?.messages ?? [] }
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
                            // Not lazy, like the stream: a stable document is what sticky scrolling needs.
                            VStack(alignment: .leading, spacing: 0) {
                                if let t = transcript, !t.complete, let first = t.messages.first {
                                    loadEarlier(before: first, remaining: max(0, t.total - t.messages.count))
                                }
                                ForEach(messages) { message in
                                    ConversationRow(message: message, tool: tool)
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
                            Image(systemName: "arrow.down").font(.system(size: 10, weight: .semibold))
                            Text("Latest")
                        }
                    }
                    .buttonStyle(JumpPillStyle())
                    .padding(.bottom, 12)
                    .transition(ConsoleMotion.arriveLeave)
                    .help("Jump to the latest")
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
                // Rows arrived *above* the one Kevin was reading (an older page, asked for
                // or not): hold his place. The tracker still has the height from before
                // this update; the document grows once it lays out, so shift on the next turn.
                guard !tracker.stuck, let oldId,
                      let index = messages.firstIndex(where: { $0.id == oldId }), index > 0,
                      let before = tracker.lastGeometry?.content else { return }
                DispatchQueue.main.async { tracker.probe?.keepOffset(previousContent: before) }
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
                        ProgressView().controlSize(.small)
                        Text("Loading…").font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg3)
                    }
                    .frame(height: 24)
                    .transition(.opacity)
                } else {
                    Button {
                        loadingEarlier = true
                        actions.send(.agentHistory(agentId: agent.id, before: first.id))
                    } label: {
                        Label("Load earlier", systemImage: "arrow.up")
                    }
                    .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 24, small: true))
                    .help(remaining > 0 ? "\(remaining) earlier message\(remaining == 1 ? "" : "s")" : "Earlier messages")
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

    /// Ask for the tail again. The pane already holds one `agent.open` (onAppear)
    /// and gives back exactly one `agent.close` (onDisappear); the engine counts
    /// viewers per open, so a bare re-open would leave the tail running after
    /// Kevin leaves. Close first — a no-op when nothing is open — then open.
    private func reopen() {
        actions.send(.agentClose(agentId: agent.id))
        actions.send(.agentOpen(agentId: agent.id))
    }

    private var emptyView: some View {
        Group {
            if let t = transcript {
                // A page with nothing on it while the file has messages: ask for the tail again.
                ConsoleEmpty(t.total == 0 ? "Nothing said yet." : "Nothing loaded yet.") {
                    if t.total > 0 {
                        Button(action: reopen) { Label("Reload", systemImage: "arrow.clockwise") }
                            .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 24, small: true))
                    }
                }
            } else if stale {
                ConsoleEmpty("Nothing from the engine yet.") {
                    Button {
                        retries += 1
                        reopen()
                    } label: { Label("Try again", systemImage: "arrow.clockwise") }
                    .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 24, small: true))
                }
            } else {
                ConsoleEmpty("Opening…") { ProgressView().controlSize(.small) }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Rows

struct ConversationRow: View, Equatable {
    let message: AgentMessage
    let tool: AgentTool

    var body: some View {
        if message.thinking == true {
            ThinkingRow(message: message)
        } else {
            switch message.role {
            case .user:
                UserTurn(message: message)
            case .assistant:
                AssistantTurn(message: message, tool: tool)
            case .tool:
                if let call = message.tool {
                    ToolCallCard(message: message, call: call)
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
            .help(ConsoleFormat.fullDate(at))
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

/// Kevin's turn: the text on a raised surface, set against the right edge.
private struct UserTurn: View {
    let message: AgentMessage

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            Spacer(minLength: 20 + iconGap)
            Text(message.text.isEmpty ? "…" : message.text)
                .font(ConsoleTheme.sans(13))
                .lineSpacing(3)
                .foregroundStyle(ConsoleTheme.fg)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .padding(EdgeInsets(top: 6, leading: 10, bottom: 6, trailing: 10))
                .background(RoundedRectangle(cornerRadius: 6).fill(ConsoleTheme.raised))
                .frame(maxWidth: turnMaxWidth, alignment: .trailing)
            ConsoleIcon(name: "person.fill", tint: ConsoleTheme.titanium)
                .padding(.leading, iconGap)
                .padding(.top, 4)
                .accessibilityLabel("Kevin")
            RightStamp(at: message.at).padding(.top, 7)
        }
        .padding(.vertical, 5)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Kevin: \(message.text)")
    }
}

/// A tool call: one hairline box on the content column — the name in mono, a
/// status dot, the input on one line — that unfolds into the input and output.
private struct ToolCallCard: View {
    let message: AgentMessage
    let call: AgentToolCall

    @State private var expanded = false

    private var dotColor: Color {
        switch call.status {
        case .running: return ConsoleTheme.thinking
        case .done: return ConsoleTheme.acting
        case .error: return ConsoleTheme.error
        }
    }

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
                        Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold)).foregroundStyle(ConsoleTheme.fg3)
                            .rotationEffect(.degrees(expanded ? 90 : 0))
                        Text(call.name).font(ConsoleTheme.mono(12)).foregroundStyle(ConsoleTheme.fg)
                            .lineLimit(1).truncationMode(.tail).layoutPriority(1)
                        // Running → done / error: the dot's colour crossfades (ConsoleDot).
                        ConsoleDot(color: dotColor, live: call.status == .running, size: 5)
                            .help(call.status.rawValue)
                            .accessibilityLabel(call.status.rawValue)
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
                        } else if call.status == .running {
                            Text("running…").font(ConsoleTheme.sans(11)).italic().foregroundStyle(ConsoleTheme.fg3)
                        }
                    }
                    .padding(EdgeInsets(top: 0, leading: 10, bottom: 8, trailing: 10))
                    .transition(Motion.appear)
                }
            }
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

/// Reasoning, folded under one titanium word; the thought unfolds in italics.
private struct ThinkingRow: View {
    let message: AgentMessage

    @State private var expanded = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            ConsoleIcon(name: "ellipsis", tint: ConsoleTheme.titanium)
            VStack(alignment: .leading, spacing: 4) {
                Button {
                    withAnimation(Motion.gentle) { expanded.toggle() }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold)).foregroundStyle(ConsoleTheme.fg3)
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
                        .help(agent.detail ?? question)
                        .contentTransition(.opacity)
                    Spacer(minLength: 8)
                    Button("Allow") { answer("yes") }
                        .buttonStyle(ConsoleButtonStyle(kind: .primary, height: 26, small: true))
                        .layoutPriority(1)
                        .help("Send “yes”")
                    Button("Deny") { answer("no") }
                        .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 26, small: true))
                        .layoutPriority(1)
                        .help("Send “no”")
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
                            .help(off)
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
                            Image(systemName: "arrow.up").font(.system(size: 13, weight: .semibold))
                        }
                        .buttonStyle(ConsoleButtonStyle(kind: hasText && question == nil ? .primary : .ghost, iconOnly: true, height: 32))
                        .disabled(!hasText)
                        .help("Send (Return)")
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
