import SwiftUI
import AppKit

// One thread's conversation in the centre column — as rich as Now, because it IS the same
// feed: a 40pt header (the status glyph, the name, its status word, `00:12 · screen · 7 steps`
// in mono, a live dot while it is busy, the acting-point thumbnail, Pause / Resume and Stop for
// this thread only, and "‹ Now"), then StreamFeed over the thread's own entries (its delegation
// cards with their steps, tool cards and screenshots; the lines it spoke; the system rows for
// its start and end), with "Load earlier" at the top while more remains, then a composer that
// talks to that thread (`thread.say`). A question the thread is waiting on sits above the
// field with Allow / Deny (`thread.answer`) — clicks only; a bare Return is never a yes.
// The pane opens its stream as one viewer (`thread.open {viewer}`) while the window shows it,
// re-opens on a daemon reconnect, and closes it when it leaves — the ConversationPane idiom.

private let iconGap: CGFloat = 8

struct ThreadPane: View, Equatable {
    let thread: WorkThread
    /// What the engine has sent for this thread (AppState.threadStores); nil until the first page.
    let store: ThreadStore?
    /// The engine's phase, for the main thread's composer (asleep: typing does not wake by default).
    var phase: Phase = .asleep
    /// The daemon client is connected: nothing can arrive while it is not.
    var connected = true
    /// Settings.typedWakes: a typed line while asleep opens a paid session (Kevin's word; default off).
    var typedWakes = false

    @EnvironmentObject private var session: ConsoleSession
    @Environment(\.consoleActions) private var actions
    /// This pane's name on the wire (`thread.open {viewer}`): one per pane instance (the root keys
    /// the pane to the thread's id), stable across the app's reconnects. Never per send.
    @State private var viewer = UUID().uuidString

    static func == (a: ThreadPane, b: ThreadPane) -> Bool {
        a.thread == b.thread && a.store == b.store && a.phase == b.phase && a.connected == b.connected && a.typedWakes == b.typedWakes
    }

    private var isMain: Bool { thread.id == "main" }

    /// The streaming caret may show: the thread is live, the daemon connected, and — for main —
    /// a session is open (its fragments arrive on this stream while Kevin speaks).
    private var caretsOn: Bool {
        guard connected, thread.status.isLive else { return false }
        return isMain ? ConsoleTheme.sessionPhases.contains(phase) : true
    }

    var body: some View {
        VStack(spacing: 0) {
            ThreadHeader(thread: thread, connected: connected, close: close)
            ThreadFeed(thread: thread, store: store, caretsOn: caretsOn, viewer: viewer)
            ThreadComposer(thread: thread, phase: phase, typedWakes: typedWakes, close: close)
        }
        // Allow / Deny on this feed's confirm rows answer THIS thread's question (StepRow).
        .environment(\.consoleConfirm, ConsoleConfirm(threadId: thread.id))
        .onAppear { if session.windowVisible { open() } }
        .onDisappear(perform: closeTail)
        .onChange(of: session.reconnectCount) {
            if session.windowVisible { open() }
        }
        .onChange(of: session.windowVisible) { _, visible in
            if visible { open() } else { closeTail() }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Thread \(thread.name), \(thread.status.words)")
    }

    private func open() { actions.send(.threadOpen(threadId: thread.id, viewer: viewer)) }
    private func closeTail() { actions.send(.threadClose(threadId: thread.id, viewer: viewer)) }

    /// Back to Now — the live stream, whatever ledger day was open underneath.
    private func close() {
        withAnimation(Motion.snappy) { session.showNow() }
    }

    /// The thread pane's empty line: opening, stale, or a thread that has said nothing yet.
    static func emptyText(store: ThreadStore?, stale: Bool) -> String {
        if let store { return store.total == 0 ? "Nothing yet." : "Nothing loaded yet." }
        return stale ? "Nothing from the engine yet." : "Opening…"
    }
}

// MARK: - Header

/// 40pt, owns its bottom rule so it meets the two rail heads on one seam.
private struct ThreadHeader: View {
    let thread: WorkThread
    let connected: Bool
    let close: () -> Void

    @Environment(\.consoleActions) private var actions
    @EnvironmentObject private var session: ConsoleSession

    private var meta: ConsoleTheme.ThreadMeta { ConsoleTheme.thread(thread.status) }
    private var isMain: Bool { thread.id == "main" }
    private var live: Bool { connected && thread.status.isBusy }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: iconGap) {
                ConsoleThreadGlyph(status: thread.status)
                Text(thread.name)
                    .font(ConsoleTheme.sans(13, .medium)).foregroundStyle(ConsoleTheme.fg)
                    .lineLimit(1).truncationMode(.tail)
                    .layoutPriority(2)
                    .consoleHelp(thread.task.isEmpty ? thread.name : thread.task)
                // The status word turns as the thread works, waits and finishes: a crossfade.
                Text(meta.label)
                    .font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg2)
                    .lineLimit(1).truncationMode(.tail)
                    .contentTransition(.opacity)
                    .animation(Motion.fade, value: meta.label)
                    .layoutPriority(1)
                // (The question itself is the composer's strip, not a header word: here it truncated to a letter.)
                Spacer(minLength: 8)
                // The figures stay whole (`fixedSize`): a narrow pane cuts the status word, never "screen…".
                HStack(spacing: 6) {
                    if live {
                        ConsoleDot(color: meta.color, live: true, size: 6)
                            .consoleHelp("Live — the thread is working")
                            .accessibilityLabel("Live")
                            .transition(.opacity)
                    }
                    elapsed
                }
                .fixedSize()
                .animation(Motion.fade, value: live)
                .layoutPriority(1)
                if let path = thread.lastScreenshotPath, !path.isEmpty {
                    // Where its hands last were: the thumbnail opens the shot. Whole or not at all — at
                    // the pane's minimum the buttons and the figures come first (the shot is on the card too).
                    let url = actions.screenshotURL(path)
                    ViewThatFits(in: .horizontal) {
                        ScreenshotThumb(url: url, onTap: { session.lightbox = ConsoleLightboxItem(url: url, caption: "\(thread.name) · last screenshot") }, width: 64)
                            .frame(height: 30)
                            .consoleHelp("The last screenshot this thread took")
                        Color.clear.frame(width: 0, height: 0)
                    }
                    .transition(.opacity)
                }
                // Pause / Resume and Stop act on THIS thread; the transport's Pause and Stop stay
                // in the Now composer. Main has no Pause of its own (the transport's is the session's).
                if !isMain, thread.status.isLive, thread.status != .idle {
                    if thread.status == .paused {
                        Button { actions.send(.threadResume(threadId: thread.id)) } label: { Label("Resume", systemImage: "play.fill") }
                            .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 24, small: true))
                            .layoutPriority(1)
                            .consoleHelp("Resume \(thread.name) — one continuation turn")
                            .transition(.opacity)
                    } else {
                        Button { actions.send(.threadPause(threadId: thread.id)) } label: { Label("Pause", systemImage: "pause.fill") }
                            .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 24, small: true))
                            .layoutPriority(1)
                            .consoleHelp("Pause \(thread.name) — its turn stops, its brain and place are kept")
                            .transition(.opacity)
                    }
                }
                if thread.canStop, thread.status.isLive {
                    Button { actions.send(.threadStop(threadId: thread.id)) } label: { Label("Stop", systemImage: "stop.fill") }
                        .buttonStyle(ConsoleButtonStyle(kind: thread.status.isBusy ? .danger : .ghost, height: 24, small: true))
                        .layoutPriority(1)
                        .consoleHelp(isMain ? "Stop this turn — the threads carry on, the session stays open (⌥⌘.)"
                              : "Stop \(thread.name) — the others and the session carry on (⌥⌘.)")
                        .accessibilityLabel("Stop \(thread.name)")
                        .transition(.opacity)
                }
                Button(action: close) { Label("Now", systemImage: "chevron.left") }
                    .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 24, small: true))
                    .layoutPriority(1)
                    .consoleHelp("Back to Now (⌘0; Esc in the composer)")
                    .accessibilityLabel("Back to Now")
            }
            .padding(.horizontal, 12)
            .frame(height: 40)
            .animation(Motion.gentle, value: thread.status)
            ConsoleHairline()
        }
        .accessibilityElement(children: .contain)
    }

    /// "00:12 · screen · 7 steps", the seconds rolling while the thread is live; frozen once it settles.
    @ViewBuilder private var elapsed: some View {
        if thread.status.isLive {
            TimelineView(.periodic(from: .now, by: 1)) { ctx in
                metaLine(now: ctx.date.timeIntervalSince1970 * 1000)
            }
        } else {
            metaLine(now: thread.doneAt ?? thread.updatedAt)
        }
    }

    private func metaLine(now: Double) -> some View {
        let text = ConsoleFormat.threadMeta(thread, now: now)
        return Text(text).font(ConsoleTheme.mono(11)).monospacedDigit().foregroundStyle(ConsoleTheme.titanium)
            .lineLimit(1)
            .contentTransition(ConsoleMotion.numeric)
            .animation(Motion.snappy, value: text)
            .consoleHelp("started \(ConsoleFormat.time(thread.startedAt)) · \(thread.turns) turn\(thread.turns == 1 ? "" : "s") · budget \(thread.budget.steps) steps / \(thread.budget.seconds) s")
    }
}

// MARK: - Feed

/// The stream's feed over the thread's entries, with "Load earlier" while more remains and the
/// same empty states a conversation has (Opening… → Nothing from the engine yet → Try again).
private struct ThreadFeed: View {
    let thread: WorkThread
    let store: ThreadStore?
    let caretsOn: Bool
    let viewer: String

    @Environment(\.consoleActions) private var actions
    /// `thread.open` went out a while ago and nothing came back.
    @State private var stale = false
    @State private var retries = 0

    private var entries: [StreamEntry] { ThreadEntries.build(store) }

    var body: some View {
        let empty = StreamEmptyState(text: ThreadPane.emptyText(store: store, stale: stale), loading: store == nil && !stale)
        StreamFeed(entries: entries, modeKey: "thread:\(thread.id)", emptyState: empty, caretsOn: caretsOn,
                   earlier: earlier, retry: store == nil && stale ? reopen : nil)
            .task(id: "\(store == nil)-\(retries)") {
                stale = false
                guard store == nil else { return }
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                guard !Task.isCancelled else { return }
                stale = true
            }
    }

    /// "Load earlier" while the first entry of the thread is not held: the page before `startSeq`.
    /// `remaining` is the record's entries not on screen (the steps folded into held cards are).
    private var earlier: StreamEarlier? {
        guard let store, !store.complete, let start = store.startSeq else { return nil }
        return StreamEarlier(key: start, remaining: store.remaining) {
            actions.send(.threadHistory(threadId: thread.id, before: start))
        }
    }

    /// Ask for the page again as this pane's viewer: close first so the engine re-pages.
    private func reopen() {
        retries += 1
        actions.send(.threadClose(threadId: thread.id, viewer: viewer))
        actions.send(.threadOpen(threadId: thread.id, viewer: viewer))
    }
}

// MARK: - Composer

/// 48pt, owns its top rule: the field addressed to the thread ("Say something to Slack…"; for
/// main "Type to Jarhead…", and while asleep "Type to Jarhead… (asleep: press Go)" — the engine
/// refuses a typed line while asleep unless Settings.typedWakes, and the words stay in the
/// field), Send while there is text. A question the thread waits on sits above the field with
/// Allow / Deny (`thread.answer`): clicks only, never Return. A finished thread's field gives way
/// to one line.
private struct ThreadComposer: View {
    let thread: WorkThread
    let phase: Phase
    let typedWakes: Bool
    let close: () -> Void

    @Environment(\.consoleActions) private var actions
    @EnvironmentObject private var session: ConsoleSession
    @State private var text = ""
    @FocusState private var focused: Bool

    private var isMain: Bool { thread.id == "main" }
    private var hasText: Bool { !text.trimmingCharacters(in: .whitespaces).isEmpty }
    private var asleep: Bool { phase == .asleep || phase == .error }

    /// One line for a composer that is off: the thread is over, or the engine said it takes none.
    private var off: String? {
        if !thread.status.isLive { return "\(thread.name) is \(thread.status.words) — nothing more to say to it." }
        if !thread.canSay && !isMain { return "\(thread.name) is not taking messages right now." }
        return nil
    }

    private var placeholder: String {
        if isMain {
            if phase == .paused { return "Paused — press Go or type to resume" }
            if asleep { return typedWakes ? "Type to wake Jarhead…" : "Type to Jarhead… (asleep: press Go)" }
            return ConsoleTheme.sessionPhases.contains(phase) ? "Say something…" : "Type to Jarhead…"
        }
        return "Say something to \(thread.name)…"
    }

    var body: some View {
        let question = thread.status == .waitingKevin ? thread.question : nil
        VStack(spacing: 0) {
            ConsoleHairline()
            if let question, !question.isEmpty {
                ThreadQuestionStrip(threadId: thread.id, name: thread.name, question: question)
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
                        TextField(placeholder, text: $text)
                            .consoleField(height: 32, focused: focused)
                            .focused($focused)
                            .onSubmit(submit)
                            .onExitCommand(perform: close)
                            .accessibilityLabel("Message \(thread.name)")
                        // One filled accent per strip: while a question is up, Allow has it.
                        Button(action: submit) {
                            Image(systemName: "arrow.up").font(.system(size: 13, weight: .semibold))
                        }
                        .buttonStyle(ConsoleButtonStyle(kind: hasText && question == nil ? .primary : .ghost, iconOnly: true, height: 32))
                        .disabled(!hasText)
                        .consoleHelp(isMain && asleep && !typedWakes ? "Send (Return) — asleep: the engine refuses and keeps the words; press Go" : "Send (Return)")
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
        actions.send(.threadSay(threadId: thread.id, text: t))
        // Asleep, the engine refuses by default (no paid session on a stray Return) and toasts
        // "asleep — press Go": the words stay where Kevin typed them. Everywhere else they went.
        if !(isMain && asleep && !typedWakes) { text = "" }
    }
}

/// The question a thread is waiting on, with Allow / Deny that send `thread.answer` for THAT
/// thread — the engine arms only when the question is on the floor for it, else refuses with a
/// toast. Clicks only: `ConsoleConfirm.returnIsAYes` is false and no shortcut is ever attached,
/// so a bare Return in the field below can never be a yes.
struct ThreadQuestionStrip: View {
    let threadId: String
    let name: String
    let question: String

    @Environment(\.consoleActions) private var actions

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: iconGap) {
            ConsoleIcon(name: "hand.raised.fill", tint: ConsoleTheme.speaking)
            Text(question)
                .font(ConsoleTheme.sans(12, .medium)).lineSpacing(2).foregroundStyle(ConsoleTheme.fg)
                .lineLimit(3).truncationMode(.tail)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .consoleHelp("\(name) asks: \(question)")
                .contentTransition(.opacity)
            Spacer(minLength: 8)
            Button("Allow") { actions.send(.threadAnswer(threadId: threadId, yes: true)) }
                .buttonStyle(ConsoleButtonStyle(kind: .primary, height: 26, small: true))
                .layoutPriority(1)
                .consoleHelp("Yes to \(name)'s question — a click, never Return")
            Button("Deny") { actions.send(.threadAnswer(threadId: threadId, yes: false)) }
                .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 26, small: true))
                .layoutPriority(1)
                .consoleHelp("No — \(name) drops the question")
        }
        .padding(EdgeInsets(top: 8, leading: 12, bottom: 0, trailing: 12))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(name) asks: \(question)")
    }
}
