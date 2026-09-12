import SwiftUI
import AVFoundation

// Right rail: a segmented Now / Settings / Ledger control in a 40pt row that
// owns its bottom rule, then one scroll region. A section is a 28pt head, its
// rows (28pt, icon column left, status glyph right) and the section's own
// bottom rule; rows inside a section draw no rule.

private let railInset: CGFloat = 12
private let iconGap: CGFloat = 8
private let keyWidth: CGFloat = 80

/// The wake word gate as the rail sees it: AppState's three published gate values,
/// sliced by the root so the Settings tab stays a plain value and only a gate
/// change (not a level tick) reaches it.
struct WakeGateInputs: Equatable {
    let gate: WakeGateState
    let heard: String
    let passphraseSet: Bool
}

struct RightRail: View, Equatable {
    let snapshot: Snapshot
    let ledgerDays: [String]?
    let ledgerDay: String?
    let ledgerLoading: Bool
    let ledgerStats: LedgerStats?
    let tab: ConsoleSession.Tab
    let wake: WakeGateInputs

    @EnvironmentObject private var session: ConsoleSession

    static func == (a: RightRail, b: RightRail) -> Bool {
        a.snapshot == b.snapshot && a.ledgerDays == b.ledgerDays && a.ledgerDay == b.ledgerDay
            && a.ledgerLoading == b.ledgerLoading && a.ledgerStats == b.ledgerStats && a.tab == b.tab
            && a.wake == b.wake
    }

    var body: some View {
        VStack(spacing: 0) {
            RailTabs(selected: tab) { picked in withAnimation(Motion.snappy) { session.select(picked) } }
            ConsoleHairline()
            CrashNoticeRow()
            ScrollView(.vertical) {
                // The three panels crossfade in place (Motion.swap) as the tab's thumb glides.
                ZStack(alignment: .top) {
                    switch tab {
                    case .now:
                        NowPanel(phase: snapshot.phase, sessionInfo: snapshot.session, pause: snapshot.pause, usageToday: snapshot.usageToday,
                                 permissions: snapshot.permissions,
                                 problems: snapshot.problems, brainReady: snapshot.brainReady, handsReady: snapshot.handsReady,
                                 brain: snapshot.settings.brain, marks: snapshot.screenMarks, problemsTyped: snapshot.problemsTyped,
                                 workers: snapshot.allWorkers)
                            .transition(Motion.swap)
                    case .settings:
                        SettingsPanel(settings: snapshot.settings, setup: snapshot.setupStatus, phase: snapshot.phase, gate: wake, trash: snapshot.trash)
                            .transition(Motion.swap)
                    case .ledger:
                        LedgerPanel(days: ledgerDays, picked: ledgerDay, loading: ledgerLoading, stats: ledgerStats)
                            .transition(Motion.swap)
                    }
                }
                .frame(maxWidth: .infinity)
                .animation(Motion.gentle, value: tab)
                .thinScrollers()
            }
        }
    }
}

/// The previous run's crash (AppState.lastCrash, set from the crash guard's report at
/// launch): one 28pt line under the tabs, on every tab, until dismissed — when, why,
/// Details (the report in Finder), ×. Reads AppState itself, like AudioMeters, so the
/// rail's Equatable inputs stay as they are; the row owns its bottom rule.
private struct CrashNoticeRow: View {
    @EnvironmentObject private var state: AppState

    var body: some View {
        ZStack(alignment: .top) {
            if let crash = state.lastCrash {
                VStack(spacing: 0) {
                    HStack(spacing: iconGap) {
                        ConsoleIcon(name: "exclamationmark.triangle.fill", tint: ConsoleTheme.error)
                        // "2 min ago" ticks; the reason is one line, the tooltip has it whole.
                        TimelineView(.periodic(from: .now, by: 30)) { ctx in
                            Text(crash.line(now: ctx.date))
                                .font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg)
                                .lineLimit(1).truncationMode(.tail)
                        }
                        Spacer(minLength: 4)
                        Button("Details") { state.revealCrash() }
                            .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 22, small: true))
                            .help("Show the crash report in Finder")
                        Button { withAnimation(Motion.gentle) { state.dismissCrash() } } label: {
                            Image(systemName: "xmark").font(.system(size: 10, weight: .semibold))
                        }
                        .buttonStyle(ConsoleButtonStyle(kind: .plain, iconOnly: true, height: 22))
                        .help("Dismiss")
                        .accessibilityLabel("Dismiss the crash notice")
                    }
                    .padding(.horizontal, railInset)
                    .frame(height: 28)
                    .help("\(crash.reason)\n\(crash.fileURL.lastPathComponent)\(crash.relaunched ? "\nRelaunched by the crash guard." : "\nNot relaunched: three crashes in ten minutes.")")
                    ConsoleHairline()
                }
                .transition(Motion.appear)
            }
        }
        .frame(maxWidth: .infinity)
        .animation(Motion.gentle, value: state.lastCrash == nil)
    }
}

/// Segmented control: one hairline box, dividers between options, the active
/// option filled with the text colour and lettered in the ground. The filled thumb
/// is one view on a matched geometry id, so it glides between options (Motion.snappy).
private struct RailTabs: View {
    let selected: ConsoleSession.Tab
    let select: (ConsoleSession.Tab) -> Void

    @Namespace private var thumb

    var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(ConsoleSession.Tab.allCases.enumerated()), id: \.element.id) { index, tab in
                if index > 0 { Rectangle().fill(ConsoleTheme.hair).frame(width: 1) }
                SegOption(title: tab.rawValue, on: tab == selected, thumb: thumb) { select(tab) }
            }
        }
        .frame(height: 28)
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(ConsoleTheme.hair, lineWidth: 1))
        .padding(.horizontal, railInset)
        .frame(height: 40)
        .animation(Motion.snappy, value: selected)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Panel")
    }
}

private struct SegOption: View {
    let title: String
    let on: Bool
    /// The segmented control's namespace: the filled thumb glides between its options.
    let thumb: Namespace.ID
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(ConsoleTheme.sans(12, .medium))
                .foregroundStyle(on ? ConsoleTheme.ground : ConsoleTheme.fg2)
                .frame(maxWidth: .infinity)
                .frame(height: 28)
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
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

/// A section: head, content, and the section's own bottom rule.
private struct RailSection<Trailing: View, Content: View>: View {
    let title: String
    let count: Int?
    let inset: Bool
    let trailing: Trailing
    let content: Content

    init(_ title: String, count: Int? = nil, inset: Bool = true,
         @ViewBuilder trailing: () -> Trailing, @ViewBuilder content: () -> Content) {
        self.title = title
        self.count = count
        self.inset = inset
        self.trailing = trailing()
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ConsoleSectionHead(title, count: count) { trailing }
            content
                .padding(.horizontal, inset ? railInset : 0)
                .padding(.bottom, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
            ConsoleHairline()
        }
    }
}

extension RailSection where Trailing == EmptyView {
    init(_ title: String, count: Int? = nil, inset: Bool = true, @ViewBuilder content: () -> Content) {
        self.init(title, count: count, inset: inset, trailing: { EmptyView() }, content: content)
    }
}

/// A key on the left, a value on the right; 22pt.
private struct KV<V: View>: View {
    let key: String
    let value: V

    init(_ key: String, @ViewBuilder value: () -> V) {
        self.key = key
        self.value = value()
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(key).font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.titanium)
                .frame(width: keyWidth, alignment: .leading)
            value.frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(minHeight: 22)
    }
}

extension KV where V == MonoFigure {
    init(_ key: String, _ mono: String) {
        self.init(key) { MonoFigure(mono) }
    }
}

private func monoValue(_ s: String) -> Text {
    Text(s).font(ConsoleTheme.mono(12)).monospacedDigit().foregroundStyle(ConsoleTheme.fg2)
}

/// A mono figure whose digits roll as it changes (the meter, the counts): `monoValue`
/// with a numeric content transition under Motion.snappy.
private struct MonoFigure: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        monoValue(text)
            .contentTransition(ConsoleMotion.numeric)
            .animation(Motion.snappy, value: text)
    }
}

private struct Reading: View {
    let text: String
    var body: some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text(text).font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg3)
        }
        .frame(height: 24)
    }
}

// MARK: - Now

struct NowPanel: View {
    let phase: Phase
    let sessionInfo: SessionInfo?
    /// While paused: the session the pause closed and when it decays to sleep (Snapshot.pause).
    let pause: PauseInfo?
    /// Today's billed total, for the meter (Snapshot.usageToday); hidden when nothing was billed.
    let usageToday: UsageToday?
    let permissions: Permissions
    let problems: [String]
    let brainReady: Bool
    let handsReady: Bool
    let brain: BrainKind
    /// What Kevin circled (Snapshot.marks); context for the next delegation.
    let marks: [ScreenMark]
    /// The problems with their kind and remedy (Snapshot.problemsTyped); nil from a daemon that sends only the lines.
    var problemsTyped: [Problem]? = nil
    /// The delegation's workers (Snapshot.workers): running, and finished within the last half minute.
    var workers: [Worker] = []

    @Environment(\.consoleActions) private var actions

    /// The typed list when the daemon sends one, else nothing (the plain lines render).
    private var typed: [Problem]? {
        guard let list = problemsTyped, !list.isEmpty || problems.isEmpty else { return nil }
        return list
    }

    /// Which of the three meter blocks is up; a change crossfades them (Motion.swap).
    private var meterKey: String {
        if sessionInfo != nil { return "session" }
        if phase == .paused, pause != nil { return "paused" }
        return "asleep"
    }

    var body: some View {
        let meta = ConsoleTheme.phase(phase)
        VStack(spacing: 0) {
            // The phase block owns its bottom rule.
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: iconGap) {
                    ConsoleDot(color: meta.color, live: ConsoleTheme.livePhases.contains(phase), size: 8)
                        .frame(width: 20, height: 20)
                    Text(meta.label).font(ConsoleTheme.sans(15, .medium)).foregroundStyle(ConsoleTheme.fg)
                        .contentTransition(.opacity)
                        .animation(Motion.fade, value: phase)
                    Spacer(minLength: 8)
                    if let s = sessionInfo {
                        // mm:ss, the seconds rolling.
                        TimelineView(.periodic(from: .now, by: 1)) { ctx in
                            let elapsed = ConsoleFormat.duration((ctx.date.timeIntervalSince1970 * 1000 - s.startedAt) / 1000)
                            Text(elapsed)
                                .font(ConsoleTheme.mono(13)).monospacedDigit().foregroundStyle(ConsoleTheme.fg2)
                                .contentTransition(ConsoleMotion.numeric)
                                .animation(Motion.snappy, value: elapsed)
                        }
                        .help("Elapsed")
                        .accessibilityLabel("Elapsed")
                        .transition(.opacity)
                    }
                }
                .frame(height: 28)
                .help(meta.hint)
                .animation(Motion.fade, value: sessionInfo == nil)

                // The meter. A session open: what this one has billed, and today's total.
                // Paused: the session is closed (the meter stopped), the conversation is
                // kept, and the pause decays to sleep — the line ticks. Asleep: today's
                // total, when there is one. The three blocks crossfade; every figure rolls.
                ZStack(alignment: .topLeading) {
                    if let s = sessionInfo {
                        VStack(alignment: .leading, spacing: 0) {
                            KV("Session") { monoValue(ConsoleFormat.shortId(s.id, 12)).help(s.id) }
                            KV("Billed", ConsoleFormat.billed(s.usageSeconds))
                            if let today = usageToday, today.seconds > 0 {
                                KV("Today", ConsoleFormat.billed(today.seconds))
                            }
                            TimelineView(.periodic(from: .now, by: 1)) { ctx in
                                KV("Expires", "in " + ConsoleFormat.duration(max(0, (s.expiresAt - ctx.date.timeIntervalSince1970 * 1000) / 1000)))
                            }
                            if let ratio = s.contextRatio {
                                KV("Context") {
                                    HStack(spacing: 8) {
                                        ConsoleBar(fraction: ratio)
                                            .animation(Motion.gentle, value: ratio)
                                        Text("\(Int((ratio * 100).rounded()))%")
                                            .font(ConsoleTheme.mono(11)).monospacedDigit().foregroundStyle(ConsoleTheme.titanium)
                                            .contentTransition(ConsoleMotion.numeric)
                                            .animation(Motion.snappy, value: ratio)
                                    }
                                }
                            }
                        }
                        .padding(.leading, 20 + iconGap)
                        .transition(Motion.swap)
                    } else if phase == .paused, let p = pause {
                        VStack(alignment: .leading, spacing: 0) {
                            TimelineView(.periodic(from: .now, by: 1)) { ctx in
                                let line = ConsoleFormat.pausedLine(p, now: ctx.date)
                                Text(line)
                                    .font(ConsoleTheme.sans(12)).lineSpacing(2).foregroundStyle(ConsoleTheme.fg2)
                                    .lineLimit(3).truncationMode(.tail)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .frame(minHeight: 22, alignment: .leading)
                                    .padding(.bottom, 2)
                                    .contentTransition(ConsoleMotion.numeric)
                                    .animation(Motion.snappy, value: line)
                            }
                            KV("Session") { monoValue(ConsoleFormat.shortId(p.sessionId, 12)).help(p.sessionId) }
                            KV("Billed", ConsoleFormat.billed(p.usageSeconds))
                            if let today = usageToday, today.seconds > 0 {
                                KV("Today", ConsoleFormat.billed(today.seconds))
                            }
                        }
                        .padding(.leading, 20 + iconGap)
                        .transition(Motion.swap)
                    } else {
                        VStack(alignment: .leading, spacing: 0) {
                            Text("No session. Nothing billed.").font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg3)
                                .frame(height: 22)
                            if let today = usageToday, today.seconds > 0 {
                                KV("Today", ConsoleFormat.billed(today.seconds))
                            }
                        }
                        .padding(.leading, 20 + iconGap)
                        .transition(Motion.swap)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .animation(Motion.gentle, value: meterKey)
            }
            .padding(EdgeInsets(top: 6, leading: railInset, bottom: 10, trailing: railInset))
            .frame(maxWidth: .infinity, alignment: .leading)
            ConsoleHairline()

            RailSection("Audio") { AudioMeters() }

            // What Kevin circled on screen, newest last, and the way to circle more. A mark
            // arriving fades and rises in; the row reflows around it.
            RailSection("Circled", count: marks.isEmpty ? nil : marks.count, trailing: {
                if !marks.isEmpty {
                    Button("Clear") { actions.send(.markClear) }
                        .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 22, small: true))
                        .help("Forget the circled regions")
                        .transition(.opacity)
                }
            }) {
                VStack(alignment: .leading, spacing: 8) {
                    if !marks.isEmpty {
                        ConsoleFlow(hSpacing: 6, vSpacing: 6) {
                            ForEach(marks) { mark in
                                MarkThumb(mark: mark).transition(Motion.appear)
                            }
                        }
                        .padding(.top, 2)
                    }
                    Button { actions.beginMarkMode() } label: { Label("Circle something…", systemImage: "scope") }
                        .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 26, small: true))
                        .help("Circle a region of the screen for Jarhead (⌥⇧C)")
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .animation(Motion.gentle, value: marks.map(\.id))

            // The delegation's second pair of hands, one row each (the ProblemRow idiom): the
            // status glyph, the name and status word, elapsed · lane in mono, the last line,
            // and Stop while it runs. The section arrives with the first worker and leaves
            // half a minute after the last one finishes (the snapshot keeps them that long);
            // a row rises in and drops out on its own ink.
            if !workers.isEmpty {
                RailSection("Workers", count: workers.count) {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(workers) { w in
                            WorkerRow(worker: w) { actions.send(.workerStop(workerId: w.id)) }
                                .transition(Motion.appear)
                        }
                    }
                    .animation(Motion.gentle, value: workers.map(\.id))
                }
                .transition(Motion.appear)
            }

            RailSection("Ready") {
                VStack(spacing: 0) {
                    readyRow("brain.fill", "Brain", brainReady, brain.rawValue)
                    readyRow("hand.raised.fill", "Hands", handsReady, handsReady ? "see + click" : "needs permissions")
                }
            }

            // Every permission the app read (snapshot.permissions.all): the required rows,
            // then the rest folded behind an "n of 16 granted" row. The sweep runs in the
            // app (AppDelegate answers `request-permission all` itself); older daemons
            // without the list get the three rows the engine always tracked.
            RailSection("Permissions", trailing: {
                Button("Ask for everything") { actions.send(.requestPermission("all")) }
                    .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 22, small: true))
                    .help("Ask for every permission Jarhead can use, one dialog at a time, then the System Settings panes")
            }) {
                PermissionsRailList(permissions: permissions)
            }

            RailSection("Problems", count: problems.isEmpty ? nil : problems.count, trailing: {
                if !problems.isEmpty {
                    Button("Clear") { actions.send(.clearProblems) }
                        .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 22, small: true))
                        .help("Clear problems")
                        .transition(.opacity)
                }
            }) {
                // "None." and the list crossfade; a problem arriving rises in.
                ZStack(alignment: .topLeading) {
                    if problems.isEmpty && (typed?.isEmpty ?? true) {
                        Text("None.").font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg3).frame(height: 22)
                            .transition(.opacity)
                    } else if let typed {
                        // Typed: one solid symbol by kind, the line, and its one remedy as a small
                        // ghost button — the fix is a click, not a hunt. Newest first, like the lines.
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(typed.reversed()) { p in
                                ProblemRow(problem: p) { remedy(p) }
                                    .transition(Motion.appear)
                            }
                        }
                        .transition(.opacity)
                    } else {
                        VStack(alignment: .leading, spacing: 0) {
                            // Newest first; the id is the problem's place in the engine's append-only
                            // list, so a row keeps its identity (and its transition) as others arrive.
                            ForEach(Array(problems.enumerated().reversed()), id: \.offset) { _, p in
                                HStack(alignment: .firstTextBaseline, spacing: iconGap) {
                                    ConsoleIcon(name: "exclamationmark.triangle.fill", tint: ConsoleTheme.error)
                                    Text(p).font(ConsoleTheme.sans(12)).lineSpacing(2).foregroundStyle(ConsoleTheme.fg)
                                        .textSelection(.enabled)
                                        .fixedSize(horizontal: false, vertical: true)
                                    Spacer(minLength: 0)
                                }
                                .padding(.vertical, 4)
                                .transition(Motion.appear)
                            }
                        }
                        .transition(.opacity)
                    }
                }
            }
            .animation(Motion.gentle, value: problems)
            .animation(Motion.gentle, value: typed?.map(\.id) ?? [])
        }
        // The Workers section arriving or leaving reflows the panel under it.
        .animation(Motion.gentle, value: workers.isEmpty)
    }

    /// The remedy button: its command when the engine gave one the Console can send, its
    /// URL or path when it named a place, else `problem.retry` for the kind — the engine
    /// re-checks and clears the line when it is fixed.
    private func remedy(_ p: Problem) {
        if let json = p.remedy?.command, let cmd = EngineCommand(remedyJSON: json) {
            actions.send(cmd)
        } else if let target = p.remedy?.open, !target.isEmpty {
            actions.open(target)
        } else {
            actions.send(.problemRetry(kind: p.kind))
        }
    }

    /// The glyph swaps (ConsoleIcon) and the detail crossfades as a part comes ready.
    private func readyRow(_ symbol: String, _ name: String, _ ok: Bool, _ detail: String) -> some View {
        HStack(spacing: iconGap) {
            ConsoleIcon(name: symbol)
            Text(name).font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg)
            Text(detail).font(ConsoleTheme.mono(11)).foregroundStyle(ConsoleTheme.titanium).lineLimit(1).truncationMode(.tail)
                .contentTransition(.opacity)
                .animation(Motion.fade, value: detail)
            Spacer(minLength: 4)
            ConsoleIcon(name: ok ? "checkmark.circle.fill" : "exclamationmark.circle.fill", tint: ok ? ConsoleTheme.acting : ConsoleTheme.speaking)
                .help(ok ? "ready" : "not ready")
                .accessibilityLabel(ok ? "ready" : "not ready")
        }
        .frame(height: 28)
    }

}

/// One typed problem: the kind's solid symbol (a missing grant in the warning tint, the
/// rest in red), the line, and the remedy as a small ghost button under it — "Open pane",
/// "Request", "Retry", "Restart daemon" — or a plain "Retry" when the engine named none.
/// The tooltip says when it was first seen.
private struct ProblemRow: View {
    let problem: Problem
    let act: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: iconGap) {
            ConsoleIcon(name: ConsoleTheme.problemSymbol(problem.kind), tint: ConsoleTheme.problemTint(problem.kind))
            VStack(alignment: .leading, spacing: 4) {
                Text(problem.text).font(ConsoleTheme.sans(12)).lineSpacing(2).foregroundStyle(ConsoleTheme.fg)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                Button(problem.remedy?.label ?? "Retry", action: act)
                    .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 22, small: true))
                    .help(remedyHelp)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
        .help("\(problem.kind) · since \(ConsoleFormat.fullDate(problem.since))")
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Problem: \(problem.text). \(problem.remedy?.label ?? "Retry")")
    }

    private var remedyHelp: String {
        if let json = problem.remedy?.command, case .string(let type)? = json["type"] { return "Sends \(type)" }
        if let target = problem.remedy?.open, !target.isEmpty { return "Opens \(ConsoleFormat.truncPath(target, max: 48))" }
        return "Check this again"
    }
}

/// One worker (the ProblemRow idiom): the status glyph on the icon column; the name and its
/// status word, with a 22pt ghost Stop trailing while it runs; "00:03 · background" in mono
/// under them, the seconds rolling until it is done; its last line under that. Stop sends
/// `worker.stop` for this hand alone — never `transportStop`, which closes the paid session
/// and sleeps: the other worker, the main brain and the meter carry on. The tooltip has the brief.
private struct WorkerRow: View {
    let worker: Worker
    let stop: () -> Void

    var body: some View {
        let meta = ConsoleTheme.worker(worker.status)
        HStack(alignment: .top, spacing: iconGap) {
            ConsoleWorkerGlyph(status: worker.status)
                .padding(.top, 4)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(worker.name).font(ConsoleTheme.sans(12, .medium)).foregroundStyle(ConsoleTheme.fg)
                        .lineLimit(1).layoutPriority(1)
                    // The word turns as the hand works, waits and finishes; a crossfade, never a cut.
                    Text(meta.label).font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg2)
                        .lineLimit(1).truncationMode(.tail)
                        .contentTransition(.opacity)
                        .animation(Motion.fade, value: meta.label)
                    Spacer(minLength: 4)
                    if worker.status.isRunning {
                        Button("Stop", action: stop)
                            .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 22, small: true))
                            .layoutPriority(1)
                            .help("Stop \(worker.name) — the others and the session carry on")
                            .accessibilityLabel("Stop \(worker.name)")
                            .transition(.opacity)
                    }
                }
                .frame(minHeight: 22)
                elapsed
                if let detail = worker.detail?.trimmingCharacters(in: .whitespacesAndNewlines), !detail.isEmpty {
                    Text(detail).font(ConsoleTheme.sans(11)).lineSpacing(1).foregroundStyle(ConsoleTheme.fg3)
                        .lineLimit(2).truncationMode(.tail)
                        .fixedSize(horizontal: false, vertical: true)
                        .contentTransition(.opacity)
                        .animation(Motion.fade, value: detail)
                }
            }
        }
        .padding(.vertical, 4)
        .animation(Motion.gentle, value: worker.status.isRunning)
        .help("\(worker.name) · \(ConsoleTheme.lane(worker.lane)) lane · \(worker.task)\nstarted \(ConsoleFormat.time(worker.startedAt)) · \(worker.steps) steps")
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Worker \(worker.name), \(meta.label)" + (worker.detail.map { ". \($0)" } ?? ""))
    }

    /// "00:03 · background", the seconds rolling while the hand runs; frozen once it settles.
    @ViewBuilder private var elapsed: some View {
        if worker.status.isRunning {
            TimelineView(.periodic(from: .now, by: 1)) { ctx in
                metaLine(now: ctx.date.timeIntervalSince1970 * 1000)
            }
        } else {
            metaLine(now: worker.doneAt ?? worker.startedAt)
        }
    }

    private func metaLine(now: Double) -> some View {
        let text = ConsoleFormat.workerMeta(worker, now: now)
        return Text(text).font(ConsoleTheme.mono(11)).monospacedDigit().foregroundStyle(ConsoleTheme.titanium)
            .lineLimit(1)
            .contentTransition(ConsoleMotion.numeric)
            .animation(Motion.snappy, value: text)
    }
}

/// The Permissions section's rows. With the full list: the required kinds, then a
/// disclosure row "n of 16 granted" that unfolds the rest. A row that is not granted
/// carries Request (its prompt) or Open Settings (System Settings only, or denied);
/// both go through `request-permission <kind>`, which the app answers in-process.
private struct PermissionsRailList: View {
    let permissions: Permissions

    @Environment(\.consoleActions) private var actions
    @State private var expanded = false

    var body: some View {
        VStack(spacing: 0) {
            if let all = permissions.all, !all.isEmpty {
                ForEach(all.filter(\.required)) { info in row(info) }
                foldRow(all)
                if expanded {
                    ForEach(all.filter { !$0.required }) { info in
                        row(info).transition(Motion.appear)
                    }
                }
            } else {
                PermissionsRailList.legacyRow("microphone", "Microphone", permissions.microphone, "mic.fill", send: actions.send)
                PermissionsRailList.legacyRow("screenRecording", "Screen recording", permissions.screenRecording, "rectangle.inset.filled.badge.record", send: actions.send)
                PermissionsRailList.legacyRow("accessibility", "Accessibility", permissions.accessibility, "accessibility.fill", send: actions.send)
            }
        }
        .animation(Motion.gentle, value: expanded)
        .animation(Motion.gentle, value: permissions)
    }

    /// "12 of 16 granted · 2 missing", a chevron; click unfolds the optional rows.
    private func foldRow(_ all: [PermissionInfo]) -> some View {
        let granted = all.filter { $0.grant == .granted }.count
        let missing = all.count - granted
        return Button { withAnimation(Motion.snappy) { expanded.toggle() } } label: {
            HStack(spacing: iconGap) {
                ConsoleIcon(name: expanded ? "chevron.down" : "chevron.right", size: 11)
                Text("\(granted) of \(all.count) granted").font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg2)
                    .contentTransition(ConsoleMotion.numeric)
                Spacer(minLength: 4)
                if missing > 0 {
                    Text("\(missing) missing").font(ConsoleTheme.mono(11)).foregroundStyle(ConsoleTheme.titanium)
                        .contentTransition(ConsoleMotion.numeric)
                        .transition(.opacity)
                }
            }
            .frame(height: 28)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(expanded ? "Fold the optional permissions" : "Show every permission")
        .accessibilityLabel("\(granted) of \(all.count) permissions granted")
        .accessibilityAddTraits(.isButton)
        .animation(Motion.snappy, value: granted)
    }

    /// One kind: icon, label, Request / Open Settings while not granted, the status glyph.
    /// The tooltip carries the why line and the detail (Automation's targets, a folder).
    private func row(_ info: PermissionInfo) -> some View {
        let meta = ConsoleTheme.grant(info.grant)
        let opensSettings = info.ask == .settings || (info.grant == .denied && info.kind != .automation)
        let tip = [info.why, info.detail ?? ""].filter { !$0.isEmpty }.joined(separator: " · ")
        return HStack(spacing: iconGap) {
            ConsoleIcon(name: PermissionsRailList.symbol(info.kind))
            Text(info.label).font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg).lineLimit(1)
            Spacer(minLength: 4)
            if info.grant != .granted {
                Button { actions.send(.requestPermission(info.kind.rawValue)) } label: {
                    if opensSettings {
                        Label("Open Settings", systemImage: "gearshape.fill").lineLimit(1)
                    } else {
                        Text("Request")
                    }
                }
                .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 22, small: true))
                .layoutPriority(1)
                .help(opensSettings ? "Open the System Settings pane\(info.kind == .fullDiskAccess ? " and reveal Jarhead.app for dragging in" : "")" : "Ask for \(info.label.lowercased()) access")
                .transition(ConsoleMotion.arriveLeave)
            }
            ConsoleIcon(name: meta.symbol, tint: meta.color)
                .help(meta.label + (tip.isEmpty ? "" : " · " + tip))
                .accessibilityLabel(meta.label)
        }
        .frame(height: 28)
        .help(tip)
        .animation(Motion.gentle, value: info.grant)
    }

    /// The three rows the engine always tracked, for a daemon that sends no list.
    static func legacyRow(_ which: String, _ name: String, _ grant: Grant, _ symbol: String, send: @escaping (EngineCommand) -> Void) -> some View {
        let meta = ConsoleTheme.grant(grant)
        let opensSettings = which == "microphone" && grant == .denied
        return HStack(spacing: iconGap) {
            ConsoleIcon(name: symbol)
            Text(name).font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg).lineLimit(1)
            Spacer(minLength: 4)
            if grant != .granted {
                Button { send(.requestPermission(which)) } label: {
                    if opensSettings {
                        Label("Open Settings", systemImage: "gearshape.fill").lineLimit(1)
                    } else {
                        Text("Request")
                    }
                }
                .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 22, small: true))
                .layoutPriority(1)
                .help(opensSettings ? "Open System Settings › Privacy › Microphone" : "Ask for \(name.lowercased()) access. Already on in System Settings? That row belongs to an earlier build: remove Jarhead there, press this, and switch the new row on. Takes effect within seconds, no relaunch.")
                .transition(ConsoleMotion.arriveLeave)
            }
            ConsoleIcon(name: meta.symbol, tint: meta.color)
                .help(meta.label)
                .accessibilityLabel(meta.label)
        }
        .frame(height: 28)
        .animation(Motion.gentle, value: grant)
    }

    /// Solid SF Symbol per kind (the Setup step's table says the same; the Console preview
    /// compiles without the Permissions module, so the table lives here too).
    static func symbol(_ kind: PermissionKind) -> String {
        switch kind {
        case .microphone: return "mic.fill"
        case .speechRecognition: return "captions.bubble.fill"
        case .screenRecording: return "rectangle.inset.filled.badge.record"
        case .accessibility: return "hand.raised.fill"
        case .inputMonitoring: return "keyboard.fill"
        case .automation: return "applescript.fill"
        case .fullDiskAccess: return "internaldrive.fill"
        case .notifications: return "bell.fill"
        case .camera: return "camera.fill"
        case .contacts: return "person.crop.circle.fill"
        case .calendars: return "calendar"
        case .reminders: return "checklist"
        case .localNetwork: return "network"
        case .filesDesktop: return "desktopcomputer"
        case .filesDocuments: return "doc.fill"
        case .filesDownloads: return "arrow.down.circle.fill"
        }
    }
}

/// One circled region: the engine's crop of it, 80pt wide, in the frame weight;
/// a placeholder with the region's size while the crop is still on its way.
/// Dimmed once a delegation has used it. Click opens the full crop.
private struct MarkThumb: View {
    let mark: ScreenMark

    @Environment(\.consoleActions) private var actions
    @EnvironmentObject private var session: ConsoleSession

    /// Three across with 6pt gaps is 252pt: inside the section's 272 even while
    /// the panel's first layout still reserves a 15pt legacy scroller.
    private static let width: CGFloat = 80

    private var caption: String {
        let size = "\(Int(mark.rect.w.rounded()))×\(Int(mark.rect.h.rounded()))"
        return [size, ConsoleFormat.time(mark.at), mark.consumed ? "used" : nil].compactMap { $0 }.joined(separator: " · ")
    }

    var body: some View {
        Group {
            if let path = mark.screenshotPath, !path.isEmpty {
                let url = actions.screenshotURL(path)
                ScreenshotThumb(url: url, onTap: {
                    session.lightbox = ConsoleLightboxItem(url: url, caption: "Circled · \(caption)")
                }, width: Self.width)
            } else {
                ZStack {
                    Rectangle().fill(ConsoleTheme.raised)
                    VStack(spacing: 3) {
                        Image(systemName: "scope").font(.system(size: 12, weight: .medium)).foregroundStyle(ConsoleTheme.fg3)
                        Text("\(Int(mark.rect.w.rounded()))×\(Int(mark.rect.h.rounded()))")
                            .font(ConsoleTheme.mono(10)).monospacedDigit().foregroundStyle(ConsoleTheme.titanium)
                    }
                }
                .aspectRatio(max(0.6, min(2.2, mark.rect.h > 0 ? mark.rect.w / mark.rect.h : 1.6)), contentMode: .fit)
                .frame(width: Self.width)
                .overlay(Rectangle().stroke(ConsoleTheme.hairFrame, lineWidth: 1))
            }
        }
        .opacity(mark.consumed ? 0.5 : 1)
        .animation(Motion.fade, value: mark.consumed)
        .help(caption)
        .accessibilityLabel("Circled region, \(caption)")
    }
}

/// A 3pt meter: track one ground step, fill in the second text step.
struct ConsoleBar: View {
    let fraction: Double
    var body: some View {
        GeometryReader { g in
            ZStack(alignment: .leading) {
                Rectangle().fill(ConsoleTheme.active)
                Rectangle().fill(ConsoleTheme.fg2).frame(width: max(0, min(1, fraction)) * g.size.width)
            }
        }
        .frame(height: 3)
    }
}

/// The only view in the Console that observes the high-frequency `levels`.
struct AudioMeters: View {
    @EnvironmentObject private var state: AppState
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let l = state.levels
        VStack(spacing: 0) {
            meter("mic.fill", "Input", l.input, ConsoleTheme.listening)
            meter("speaker.wave.2.fill", "Output", l.output, ConsoleTheme.speaking)
        }
    }

    private func meter(_ symbol: String, _ label: String, _ value: Double, _ tint: Color) -> some View {
        HStack(spacing: iconGap) {
            ConsoleIcon(name: symbol, tint: tint).help(label).accessibilityLabel(label)
            // One 20 Hz tick to the next; still under reduce motion.
            ConsoleBar(fraction: value).animation(reduceMotion ? nil : .linear(duration: 0.06), value: value)
            Text(String(format: "%.2f", value)).font(ConsoleTheme.mono(11)).monospacedDigit().foregroundStyle(ConsoleTheme.titanium)
                .frame(width: 32, alignment: .trailing)
        }
        .frame(height: 24)
    }
}

// MARK: - Settings

struct MicDevice: Identifiable, Equatable {
    let id: String
    let name: String

    static func enumerate() -> [MicDevice] {
        let session = AVCaptureDevice.DiscoverySession(deviceTypes: [.microphone, .external], mediaType: .audio, position: .unspecified)
        return session.devices.map { MicDevice(id: $0.uniqueID, name: $0.localizedName) }
    }
}

/// What the voice engine says about the microphones (Audio/AudioEngine.swift `MicRoute`,
/// posted as `jarhead.micRoute`; asked for with `jarhead.micRoute.request` when the panel
/// appears): the ranked order, the active one, what the choice follows. Plain strings, so
/// this file still compiles in the Console harness, which carries no audio code.
struct MicRouteInfo: Equatable {
    static let notificationName = Notification.Name("jarhead.micRoute")
    static let requestName = Notification.Name("jarhead.micRoute.request")

    /// Device UIDs, best first: the pick, the built-in, the one used last, the default, the rest; virtual last.
    var ranked: [String] = []
    var names: [String: String] = [:]
    var virtual: Set<String> = []
    var active = ""
    var systemDefault = ""
    /// "explicit" | "ranked" | "system default (echo cancellation)" | "off".
    var follows = ""

    init() {}

    init?(_ userInfo: [AnyHashable: Any]?) {
        guard let info = userInfo, let ids = info["ids"] as? [String], let names = info["names"] as? [String] else { return nil }
        ranked = ids
        for (i, id) in ids.enumerated() where i < names.count { self.names[id] = names[i] }
        virtual = Set(info["virtual"] as? [String] ?? [])
        active = info["active"] as? String ?? ""
        systemDefault = info["default"] as? String ?? ""
        follows = info["follows"] as? String ?? ""
    }
}

struct SettingsPanel: View {
    let settings: Settings
    let setup: SetupStatus
    let phase: Phase
    let gate: WakeGateInputs
    /// What the trash holds (Snapshot.trash); nil from a daemon that has none.
    var trash: TrashInfo? = nil

    @Environment(\.consoleActions) private var actions
    @State private var mics: [MicDevice] = []
    /// The voice engine's ranking (empty until it has published once).
    @State private var route = MicRouteInfo()

    private enum Field: Hashable { case model, server, phrases }
    @FocusState private var focus: Field?

    // Brain: the three fields go out as one patch, so the drafts are kept together.
    private struct BrainDraft: Equatable {
        var kind: BrainKind
        var model: String
        var server: String
    }
    @State private var modelDraft = ""
    @State private var serverDraft = ""
    /// The last patch sent and not yet echoed by the daemon; Return commits and then
    /// drops focus, and the focus change must not send the same patch again.
    @State private var brainSent: BrainDraft?

    // Wake
    @State private var phrasesDraft = ""
    @State private var phrasesSent: [String]?
    /// "Sweep now" pressed once: the head asks before whole days move (they come back one at a
    /// time with Restore, but there is no Undo on the sweep itself). Lets go on its own.
    @State private var sweepArmed = false

    private func patch(_ p: SettingsPatch) { actions.send(.setSettings(p)) }

    private var brainSaved: BrainDraft {
        BrainDraft(kind: settings.brain, model: settings.brainModel, server: settings.brainBaseUrl ?? "")
    }

    /// The brain on screen: the pick just sent, until the daemon echoes it.
    private var kind: BrainKind { brainSent?.kind ?? settings.brain }

    private var wake: WakeSettings { settings.wakeSettings }

    private var voiceOptions: [String] {
        ConsoleTheme.voices + (ConsoleTheme.voices.contains(settings.voice) ? [] : [settings.voice])
    }

    private var effortOptions: [String] {
        ConsoleTheme.efforts + (ConsoleTheme.efforts.contains(settings.effort) ? [] : [settings.effort])
    }

    private var micSelection: String {
        guard let id = settings.micDeviceId, !id.isEmpty else { return "" }
        return id
    }

    /// "Auto (ranked)" first, then the microphones in the voice engine's ranked order (the
    /// enumeration order until it has published), then a saved pick that is not connected.
    private var micOptions: [String] {
        var ids = [""] + (route.ranked.isEmpty ? mics.map(\.id) : route.ranked)
        for m in mics where !ids.contains(m.id) { ids.append(m.id) }
        let current = micSelection
        if !current.isEmpty, !ids.contains(current) { ids.append(current) }
        return ids
    }

    private func micName(_ id: String) -> String? {
        route.names[id] ?? mics.first(where: { $0.id == id })?.name
    }

    private func micTitle(_ id: String) -> String {
        if id.isEmpty { return "Auto (ranked)" }
        guard let name = micName(id) else { return "Unavailable · \(ConsoleFormat.shortId(id, 10))" }
        var tags: [String] = []
        if id == route.active { tags.append("active") }
        if route.virtual.contains(id) { tags.append("virtual") }
        return tags.isEmpty ? name : "\(name) · \(tags.joined(separator: " · "))"
    }

    /// One line under the picker: the microphone in use, and why a pick is not (echo
    /// cancellation follows the system default; only Sound settings can move that).
    private var micHint: String {
        guard !route.active.isEmpty, let active = micName(route.active) else { return "" }
        if route.follows.hasPrefix("system default") {
            let pick = micSelection
            if !pick.isEmpty, pick != route.active, let wanted = micName(pick) {
                return "Using \(active). Echo cancellation follows the system default; make \(wanted) the default in Sound settings to use it."
            }
            return "Using \(active) · system default (echo cancellation)."
        }
        return "Using \(active) · \(route.follows)."
    }

    var body: some View {
        VStack(spacing: 0) {
            // Section heads name the group, not the first row, so no word appears twice.
            RailSection("Audio") {
                VStack(spacing: 2) {
                    formRow("Voice") {
                        ConsoleMenuField(value: settings.voice, options: voiceOptions, title: { $0 },
                                         pick: { patch(SettingsPatch(voice: $0)) })
                    }
                    formRow("Mic") {
                        ConsoleMenuField(value: micSelection, options: micOptions, title: micTitle,
                                         pick: { patch(SettingsPatch(micDeviceId: .some($0.isEmpty ? nil : $0))) })
                            .help("Auto ranks the connected microphones: your pick, the built-in, the one used last, the system default. Aggregate and virtual devices only when picked.")
                    }
                    if !micHint.isEmpty { hint(micHint) }
                }
            }
            RailSection("Brain") {
                VStack(spacing: 2) {
                    // The OpenAI key that runs the GPT-Live-1 voice; the dot is the last probe.
                    // The engine probes on its own after it saves a key, so Save sends one command.
                    formRow("Voice key") {
                        SecretField(placeholder: "sk-…", onFile: setup.secrets.openai, status: voiceKeyStatus,
                                    save: { key in actions.send(.setSecrets(["OPENAI_API_KEY": key])) })
                    }
                    .help("The OpenAI key for the voice (\(setup.liveModel))")
                    formRow("Backend") {
                        // The menu spells the long one out; the hint under the field already says "server".
                        ConsoleMenuField(value: kind, options: ConsoleTheme.brains, title: { $0.label },
                                         pick: { commitBrain(kind: $0) },
                                         fieldTitle: { $0 == .openaiCompatible ? "OpenAI-compatible" : $0.label })
                            .accessibilityLabel("Backend: \(kind.label)")
                    }
                    .help(kind.label)
                    hint(kind.needs)
                    formRow("Model") {
                        let fallback = ConsoleTheme.defaultBrainModel(kind)
                        TextField(fallback.isEmpty ? "backend default" : fallback, text: $modelDraft)
                            .consoleField(mono: true, height: 26, focused: focus == .model)
                            .focused($focus, equals: .model)
                            .onSubmit { commitBrain(); focus = nil }
                            .accessibilityLabel("Model id")
                    }
                    // The rows a backend wants arrive and leave with the pick (Motion.appear).
                    if kind == .openaiCompatible {
                        formRow("Server") {
                            TextField("http://localhost:11434/v1", text: $serverDraft)
                                .consoleField(mono: true, height: 26, focused: focus == .server)
                                .focused($focus, equals: .server)
                                .onSubmit { commitBrain(); focus = nil }
                                .accessibilityLabel("Server base URL")
                        }
                        .transition(Motion.appear)
                    }
                    // The OpenAI brain reuses the voice key above; logins need no key at all.
                    if let secret = kind.secretKey, kind != .openaiResponses {
                        formRow("Key") {
                            SecretField(placeholder: kind == .openaiCompatible ? "server key" : "sk-ant-…",
                                        onFile: kind == .anthropicApi ? setup.secrets.anthropic : setup.secrets.brainApiKey,
                                        status: nil,
                                        save: { key in actions.send(.setSecrets([secret: key])) })
                                // One row for two secrets: the identity keeps a key typed for one
                                // backend from being saved under the other's name after a switch.
                                .id(secret)
                        }
                        .help(secret)
                        .transition(Motion.appear)
                    }
                    formRow("Effort") {
                        ConsoleMenuField(value: settings.effort, options: effortOptions, title: { $0 },
                                         pick: { patch(SettingsPatch(effort: $0)) }, mono: true)
                    }
                    formRow("Status") { brainStatus }
                }
                .animation(Motion.gentle, value: kind)
            }
            RailSection("Session") {
                VStack(spacing: 2) {
                    formRow("Idle sleep") {
                        HStack(spacing: 6) {
                            Text("\(Int(settings.idleSleepMinutes.rounded())) min")
                                .font(ConsoleTheme.mono(12)).monospacedDigit().foregroundStyle(ConsoleTheme.fg)
                                .frame(width: 56, alignment: .leading)
                            Button { step(-1) } label: { Image(systemName: "minus").font(.system(size: 11, weight: .semibold)) }
                                .buttonStyle(ConsoleButtonStyle(kind: .ghost, iconOnly: true, height: 24))
                                .disabled(settings.idleSleepMinutes <= 1)
                                .accessibilityLabel("Less idle time")
                            Button { step(1) } label: { Image(systemName: "plus").font(.system(size: 11, weight: .semibold)) }
                                .buttonStyle(ConsoleButtonStyle(kind: .ghost, iconOnly: true, height: 24))
                                .disabled(settings.idleSleepMinutes >= 240)
                                .accessibilityLabel("More idle time")
                            Spacer(minLength: 0)
                        }
                    }
                    formRow("Auto-wake") {
                        Toggle("", isOn: Binding(get: { settings.autoWake }, set: { patch(SettingsPatch(autoWake: $0)) }))
                            .toggleStyle(.switch).controlSize(.small).labelsHidden()
                            .tint(ConsoleTheme.accent)
                            .help(wake.enabled ? "Wake on launch (the wake word gate owns waking while it is on)" : "Wake on launch")
                            .accessibilityLabel("Auto-wake on launch")
                    }
                    // Where the orb lives: floating free (it stays where it last worked), or in
                    // the MacBook notch (it drops out for the work and flies back up).
                    formRow("Home") {
                        HomeSegments(notch: settings.livesInNotch) { notch in patch(SettingsPatch(orbHome: notch ? "notch" : "free")) }
                            .help(settings.livesInNotch ? "The orb lives and sleeps in the notch" : "The orb floats free and stays where it last worked")
                    }
                    hint(settings.livesInNotch ? "Lives in the notch; floats free when the main display has none." : "Floats free; stays where it last worked.")
                }
            }
            // Retention is a mover, not a deleter: older days MOVE to the trash by the sweep
            // and come back with Restore; the trash is emptied in Finder, by Kevin, never here.
            RailSection("Retention", trailing: {
                // Two presses: the sweep moves whole day files and has no Undo of its own, so the
                // head asks first, in place — the word becomes the deed, and × is the way out.
                if sweepArmed {
                    HStack(spacing: 4) {
                        Button("Move older days to Trash") {
                            withAnimation(Motion.snappy) { sweepArmed = false }
                            actions.cleanup(.sweep)
                        }
                        .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 22, small: true))
                        .help("Days past retention move to the trash now; each comes back with Restore")
                        Button { withAnimation(Motion.snappy) { sweepArmed = false } } label: {
                            Image(systemName: "xmark").font(.system(size: 10, weight: .semibold))
                        }
                        .buttonStyle(ConsoleButtonStyle(kind: .plain, iconOnly: true, height: 22))
                        .help("Keep everything where it is")
                        .accessibilityLabel("Cancel the sweep")
                    }
                    .transition(.opacity)
                    .task {
                        // Left alone, the question goes away.
                        try? await Task.sleep(nanoseconds: 8_000_000_000)
                        withAnimation(Motion.snappy) { sweepArmed = false }
                    }
                } else {
                    Button("Sweep now") { withAnimation(Motion.snappy) { sweepArmed = true } }
                        .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 22, small: true))
                        .disabled((settings.ledgerRetentionDays ?? 0) == 0 && (settings.shotsRetentionDays ?? 14) == 0)
                        .help((settings.ledgerRetentionDays ?? 0) == 0 && (settings.shotsRetentionDays ?? 14) == 0
                              ? "Both keep forever; nothing would move"
                              : "Move the days past retention to the trash now (each comes back with Restore); asks first")
                        .transition(.opacity)
                }
            }) {
                VStack(spacing: 2) {
                    formRow("Ledger") {
                        ConsoleMenuField(value: settings.ledgerRetentionDays ?? 0, options: retentionOptions(ConsoleTheme.ledgerRetentionOptions, current: settings.ledgerRetentionDays ?? 0),
                                         title: { ConsoleTheme.retentionTitle($0, forever: "keep forever") },
                                         pick: { days in var p = SettingsPatch(); p.ledgerRetentionDays = days; patch(p) })
                            .accessibilityLabel("Ledger retention: \(ConsoleTheme.retentionTitle(settings.ledgerRetentionDays ?? 0, forever: "keep forever"))")
                    }
                    .help("Days a day's conversations stay on the rail before the sweep moves the day file to the trash")
                    formRow("Screenshots") {
                        ConsoleMenuField(value: settings.shotsRetentionDays ?? 14, options: retentionOptions(ConsoleTheme.shotsRetentionOptions, current: settings.shotsRetentionDays ?? 14),
                                         title: { ConsoleTheme.retentionTitle($0, forever: "forever") },
                                         pick: { days in var p = SettingsPatch(); p.shotsRetentionDays = days; patch(p) })
                            .accessibilityLabel("Screenshot retention: \(ConsoleTheme.retentionTitle(settings.shotsRetentionDays ?? 14, forever: "forever"))")
                    }
                    .help("Days a day's screenshots stay before the sweep moves the folder to the trash")
                    hint("Older days move to the trash, never out of it. Pinned conversations keep their days.")
                    formRow("Trash") {
                        // The figures whole on their own line; the way to Finder under them.
                        VStack(alignment: .leading, spacing: 4) {
                            Text(trash.map { ConsoleFormat.trashLine($0) } ?? "—")
                                .font(ConsoleTheme.mono(12)).monospacedDigit().foregroundStyle(ConsoleTheme.fg)
                                .lineLimit(1)
                                .frame(height: 26, alignment: .leading)
                                .contentTransition(ConsoleMotion.numeric)
                                .animation(Motion.snappy, value: trash)
                                .help(trash.map { ConsoleFormat.truncPath($0.path, max: 48) } ?? "No trash folder yet")
                            if let trash {
                                Button { actions.open(trash.path) } label: { Label("Reveal in Finder", systemImage: "folder.fill") }
                                    .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 22, small: true))
                                    .help("Show \(ConsoleFormat.truncPath(trash.path, max: 48)) in Finder — emptying it is yours, there")
                            }
                        }
                    }
                    hint("Nothing is deleted here; the trash is emptied in Finder.")
                }
            }
            RailSection("Wake") {
                VStack(spacing: 2) {
                    formRow("Wake word") {
                        Toggle("", isOn: Binding(get: { wake.enabled }, set: { on in var w = wake; w.enabled = on; patch(SettingsPatch(wake: w)) }))
                            .toggleStyle(.switch).controlSize(.small).labelsHidden()
                            .tint(ConsoleTheme.accent)
                            .help("Listen on-device for the wake word while asleep")
                            .accessibilityLabel("Wake word")
                    }
                    formRow("Phrases") {
                        // The stock list is wider than the field, so it wraps (up to three lines) rather than clipping mid-word.
                        TextField("jarhead, jar head", text: $phrasesDraft, axis: .vertical)
                            .lineLimit(1...3)
                            .consoleField(mono: true, height: 26, focused: focus == .phrases, grows: true)
                            .focused($focus, equals: .phrases)
                            .onSubmit { commitPhrases(); focus = nil }
                            .help("Any of these wakes it; comma-separated")
                            .accessibilityLabel("Wake phrases, comma separated")
                    }
                    formRow("Auth") {
                        // The menu spells every option out; the field is too narrow for "Touch ID or passphrase".
                        ConsoleMenuField(value: wake.auth, options: WakeAuth.allCases, title: { $0.label },
                                         pick: { auth in var w = wake; w.auth = auth; patch(SettingsPatch(wake: w)) },
                                         fieldTitle: { $0 == .either ? "Either" : $0.label })
                            .help(wake.auth.label)
                            .accessibilityLabel("Authentication: \(wake.auth.label)")
                    }
                    if wake.auth == .none { hint("Anyone who says the word wakes it.").transition(Motion.appear) }
                    formRow("Passphrase") { WakePassphraseRow(set: gate.passphraseSet) }
                    formRow("Status") { WakeGateReadout(phase: phase, wake: wake, gate: gate.gate, heard: gate.heard) }
                }
                .animation(Motion.gentle, value: wake.auth)
            }
            // The words do the work; the gear means System Settings elsewhere in this window.
            Button("Set up again…") { actions.openOnboarding() }
                .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 26, small: true))
                .help("Open the setup wizard")
                .padding(EdgeInsets(top: 12, leading: railInset, bottom: 20, trailing: railInset))
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .onAppear {
            mics = MicDevice.enumerate()
            // The voice engine answers with its ranked route (`jarhead.micRoute`).
            NotificationCenter.default.post(name: MicRouteInfo.requestName, object: nil)
            modelDraft = settings.brainModel
            serverDraft = settings.brainBaseUrl ?? ""
            phrasesDraft = wake.phrases.joined(separator: ", ")
        }
        .onChange(of: brainSaved) {
            brainSent = nil
            if focus != .model { modelDraft = settings.brainModel }
            if focus != .server { serverDraft = settings.brainBaseUrl ?? "" }
        }
        .onChange(of: wake.phrases) {
            phrasesSent = nil
            if focus != .phrases { phrasesDraft = wake.phrases.joined(separator: ", ") }
        }
        // Focus starts a new edit (a retry may resend); blur commits, once.
        .onChange(of: focus) { old, new in
            switch new {
            case .model, .server: brainSent = nil
            case .phrases: phrasesSent = nil
            case nil: break
            }
            switch old {
            case .model, .server: commitBrain()
            case .phrases: commitPhrases()
            case nil: break
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: Notification.Name("AVCaptureDeviceWasConnectedNotification"))) { _ in mics = MicDevice.enumerate() }
        .onReceive(NotificationCenter.default.publisher(for: Notification.Name("AVCaptureDeviceWasDisconnectedNotification"))) { _ in mics = MicDevice.enumerate() }
        .onReceive(NotificationCenter.default.publisher(for: MicRouteInfo.notificationName)) { note in
            if let r = MicRouteInfo(note.userInfo) { route = r }
        }
    }

    private func step(_ delta: Int) {
        let next = min(240, max(1, Int(settings.idleSleepMinutes.rounded()) + delta))
        patch(SettingsPatch(idleSleepMinutes: Double(next)))
    }

    /// The menu's options with the saved value added when it is not one of them (a hand-edited settings file).
    private func retentionOptions(_ options: [Int], current: Int) -> [Int] {
        options.contains(current) ? options : options + [current]
    }

    // MARK: brain

    /// Backend, model and server go out together, once per edit: the snapshot's
    /// value lags the daemon round trip, so the guard also remembers what was just
    /// sent. A newly picked backend takes its own default model unless the model
    /// on screen is one Kevin typed.
    private func commitBrain(kind picked: BrainKind? = nil) {
        let before = kind
        let next = picked ?? before
        var model = modelDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        if next != before, model.isEmpty || model == ConsoleTheme.defaultBrainModel(before) {
            model = ConsoleTheme.defaultBrainModel(next)
            modelDraft = model
        }
        let server = serverDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        let draft = BrainDraft(kind: next, model: model, server: server)
        guard draft != brainSaved, draft != brainSent else { return }
        brainSent = draft
        patch(SettingsPatch(brain: next, brainModel: model, brainBaseUrl: .some(server.isEmpty ? nil : server)))
    }

    /// The last probe of the voice key, as the dot beside the field.
    private var voiceKeyStatus: SecretField.Status {
        switch setup.openaiKey {
        case .ok: return SecretField.Status(color: ConsoleTheme.acting, text: "on file", help: "Key works with \(setup.liveModel)")
        case .invalid: return SecretField.Status(color: ConsoleTheme.error, text: "rejected", help: "OpenAI rejected the key — paste a fresh one")
        case .missing: return SecretField.Status(color: ConsoleTheme.speaking, text: "missing", help: "No OpenAI key")
        case .unchecked: return SecretField.Status(color: ConsoleTheme.titanium, text: "on file", help: "Not checked yet")
        }
    }

    /// Dot + one line from the last probe; Check runs it again. The Backend row
    /// already names the brain, so the line is the state — plus, for Automatic,
    /// the brain it resolved to.
    private var brainStatus: some View {
        let resolved: String? = kind == .auto ? setup.brainResolved.flatMap { $0 == .auto ? nil : $0.label } : nil
        let color: Color
        let live: Bool
        let text: String
        switch setup.brain {
        case .ok: color = ConsoleTheme.acting; live = false; text = resolved.map { "\($0) ready" } ?? "Ready"
        case .unavailable: color = ConsoleTheme.error; live = false; text = "Unavailable"
        case .unchecked: color = ConsoleTheme.thinking; live = true; text = "Checking…"
        }
        let detail = setup.brainDetail.trimmingCharacters(in: .whitespacesAndNewlines)
        let showDetail = !detail.isEmpty && detail != "ok"
        let name = ConsoleTheme.brainName(kind, resolved: setup.brainResolved)
        // A probe's answer fades in: the dot's colour, the word and the detail crossfade.
        return VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                HStack(spacing: iconGap) {
                    ConsoleDot(color: color, live: live).frame(width: 20, height: 20)
                    Text(text).font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg).lineLimit(1).truncationMode(.tail)
                        .contentTransition(.opacity)
                }
                .help(detail.isEmpty || detail == "ok" ? "\(name): \(text.lowercased())" : "\(name): \(detail)")
                .accessibilityLabel("\(name) \(text)")
                Spacer(minLength: 4)
                Button("Check") { actions.send(.probeSetup) }
                    .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 22, small: true))
                    .layoutPriority(1)
                    .help("Re-check the voice key and the brain")
            }
            .frame(height: 26)
            if showDetail {
                Text(detail).font(ConsoleTheme.mono(11)).lineSpacing(1).foregroundStyle(ConsoleTheme.titanium)
                    .lineLimit(2).truncationMode(.tail)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 20 + iconGap)
                    .padding(.bottom, 4)
                    .help(detail)
                    .contentTransition(.opacity)
                    .transition(Motion.appear)
            }
        }
        .animation(Motion.fade, value: text)
        .animation(Motion.gentle, value: detail)
    }

    // MARK: wake

    /// Comma-separated → lowercase, trimmed, single-spaced, no empties, no repeats.
    static func parsePhrases(_ text: String) -> [String] {
        var seen = Set<String>()
        return text.split(separator: ",").compactMap { part in
            let words = part.lowercased().split(whereSeparator: { $0.isWhitespace || $0.isNewline })
            let phrase = words.joined(separator: " ")
            guard !phrase.isEmpty, !seen.contains(phrase) else { return nil }
            seen.insert(phrase)
            return phrase
        }
    }

    /// Sends the whole wake block, once per edit. An empty list is a mistake, not a
    /// setting (the toggle is how it turns off): the draft goes back to what is saved.
    private func commitPhrases() {
        let phrases = SettingsPanel.parsePhrases(phrasesDraft)
        guard !phrases.isEmpty else { phrasesDraft = (phrasesSent ?? wake.phrases).joined(separator: ", "); return }
        guard phrases != wake.phrases, phrases != phrasesSent else { return }
        phrasesSent = phrases
        var w = wake
        w.phrases = phrases
        patch(SettingsPatch(wake: w))
    }

    // MARK: rows

    private func formRow<C: View>(_ label: String, @ViewBuilder control: () -> C) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text(label).font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.titanium)
                .frame(width: keyWidth, alignment: .leading)
                .frame(height: 28)
            control().frame(maxWidth: .infinity, alignment: .leading).frame(minHeight: 28)
        }
    }

    /// One titanium line under a control, aligned to the control column.
    private func hint(_ text: String) -> some View {
        Text(text).font(ConsoleTheme.sans(11)).lineSpacing(1).foregroundStyle(ConsoleTheme.titanium)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.leading, keyWidth + 10)
            .padding(.bottom, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Settings › Home: Free / Notch — the rail tabs' segmented control, two options; the
/// thumb glides between them.
private struct HomeSegments: View {
    let notch: Bool
    let pick: (Bool) -> Void

    @Namespace private var thumb

    var body: some View {
        HStack(spacing: 0) {
            SegOption(title: "Free", on: !notch, thumb: thumb) { withAnimation(Motion.snappy) { pick(false) } }
            Rectangle().fill(ConsoleTheme.hair).frame(width: 1)
            SegOption(title: "Notch", on: notch, thumb: thumb) { withAnimation(Motion.snappy) { pick(true) } }
        }
        .frame(height: 28)
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(ConsoleTheme.hair, lineWidth: 1))
        .animation(Motion.snappy, value: notch)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Orb home: \(notch ? "Notch" : "Free")")
    }
}

/// A secret that is written, never read back: a SecureField and Save until a key is
/// on file (the empty field is the "none" state; no dot beside it), then a dot and
/// "on file" with Change. The value is sent once and dropped.
private struct SecretField: View {
    struct Status {
        let color: Color
        let text: String
        let help: String
    }

    let placeholder: String
    let onFile: Bool
    /// The dot's meaning while on file; nil is plain presence.
    let status: Status?
    let save: (String) -> Void

    @State private var text = ""
    @State private var editing = false
    /// Sent, not yet reflected by the snapshot.
    @State private var pending = false
    @FocusState private var focused: Bool

    private var hasText: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var meta: Status { status ?? Status(color: ConsoleTheme.acting, text: "on file", help: "A key is on file") }

    /// Which of the three faces is up — saving, the field, on file — so they crossfade.
    private var face: Int { pending && !onFile ? 0 : (editing || !onFile ? 1 : 2) }

    var body: some View {
        HStack(spacing: 6) {
            if pending && !onFile {
                Group {
                    ConsoleDot(color: ConsoleTheme.thinking, live: true).frame(width: 20, height: 20)
                    Text("Saving…").font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg2)
                    Spacer(minLength: 0)
                }
                .transition(.opacity)
            } else if editing || !onFile {
                Group {
                    SecureField(placeholder, text: $text)
                        .consoleField(mono: true, height: 26, focused: focused)
                        .focused($focused)
                        .onSubmit(commit)
                        .onExitCommand(perform: cancel)
                        .onChange(of: focused) { if !focused, !hasText { cancel() } }
                        .help(editing ? "Paste the new key; Esc keeps the old one" : "Paste the key; it is written to ~/.jarhead/env and never shown again")
                    Button("Save", action: commit)
                        .buttonStyle(ConsoleButtonStyle(kind: hasText ? .primary : .ghost, height: 26, small: true))
                        .disabled(!hasText)
                }
                .transition(.opacity)
            } else {
                Group {
                    ConsoleDot(color: meta.color).frame(width: 20, height: 20)
                    Text(meta.text).font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg2)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .help(meta.help)
                        .accessibilityLabel(meta.help)
                        .contentTransition(.opacity)
                    Button("Change") { editing = true; focused = true }
                        .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 22, small: true))
                        .layoutPriority(1)
                        .help("Replace the key")
                }
                .transition(.opacity)
            }
        }
        .frame(height: 26)
        .animation(Motion.fade, value: face)
        .animation(Motion.fade, value: meta.text)
        .onChange(of: onFile) { pending = false }
    }

    private func commit() {
        let k = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !k.isEmpty else { return }
        save(k)
        text = ""
        editing = false
        focused = false
        pending = true
        // The snapshot normally flips `onFile` within a round trip; if it never does, fall back to the field.
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 8_000_000_000)
            pending = false
        }
    }

    private func cancel() {
        text = ""
        editing = false
        focused = false
    }
}

/// The wake passphrase: a SecureField and Set until one is enrolled, then a masked
/// mark with Change and Clear. Only the gate ever sees the text; a rejection (too
/// short) shakes the field and tints its ring red, keeping focus.
private struct WakePassphraseRow: View {
    /// A passphrase is enrolled (AppState.wakePassphraseSet, sliced by the root).
    let set: Bool

    @Environment(\.consoleActions) private var actions

    @State private var text = ""
    @State private var editing = false
    @State private var rejected = false
    @State private var shakes: CGFloat = 0
    @FocusState private var focused: Bool

    private var hasText: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        HStack(spacing: 6) {
            if editing || !set {
                Group {
                    SecureField("a phrase", text: $text)
                        .consoleField(mono: true, height: 26, focused: focused, error: rejected)
                        .modifier(ConsoleShake(shakes: shakes))
                        .focused($focused)
                        .onSubmit(submit)
                        .onExitCommand(perform: cancel)
                        .onChange(of: focused) { if !focused, !hasText, set { cancel() } }
                        .help("Two words or more; said or typed when asked" + (set ? ". Esc keeps the old one" : ""))
                        .accessibilityLabel("Wake passphrase")
                    Button("Set", action: submit)
                        .buttonStyle(ConsoleButtonStyle(kind: hasText ? .primary : .ghost, height: 26, small: true))
                        .disabled(!hasText)
                }
                .transition(.opacity)
            } else {
                Group {
                    // No Spacer: its 6pt of stack spacing is what pushes "Change" into "Chan…" in the rail.
                    Text("••••••").font(ConsoleTheme.mono(12)).foregroundStyle(ConsoleTheme.fg2)
                        .fixedSize()
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .help("A passphrase is set (kept as a hash; never shown)")
                        .accessibilityLabel("Passphrase set")
                    Button("Change") { editing = true; focused = true }
                        .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 22, small: true))
                        .layoutPriority(1)
                        .help("Replace the passphrase")
                    Button("Clear") { actions.clearWakePassphrase(); cancel() }
                        .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 22, small: true))
                        .layoutPriority(1)
                        .help("Forget the passphrase")
                }
                .transition(.opacity)
            }
        }
        .frame(height: 26)
        // The field and the masked mark crossfade as a passphrase is set or replaced.
        .animation(Motion.fade, value: editing || !set)
        .onChange(of: set) { if !set { editing = false } }
    }

    private func submit() {
        guard hasText else { return }
        if actions.setWakePassphrase(text) {
            text = ""
            editing = false
            rejected = false
            focused = false
        } else {
            // Too short: the gate has toasted why. Shake, tint, keep the words and the focus.
            // The shake is three cycles over Motion.slow; none under Reduce Motion (the ring still turns red).
            rejected = true
            focused = true
            if !Motion.reduced { withAnimation(.linear(duration: Motion.slow)) { shakes += 1 } }
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 700_000_000)
                rejected = false
            }
        }
    }

    private func cancel() {
        text = ""
        editing = false
        rejected = false
        focused = false
    }
}

/// The gate's state as a solid icon and the status menu's words, and — while it
/// listens — the last words the on-device recogniser heard, so Kevin can say the
/// word and watch it land. A plain value like everything else in the rail: the
/// root slices `gate` and `heard` out of AppState, so a partial transcript
/// re-evaluates the rail, not a level tick.
private struct WakeGateReadout: View {
    let phase: Phase
    let wake: WakeSettings
    let gate: WakeGateState
    let heard: String

    /// The gate's states as the readout tells them apart, so a change crossfades the
    /// line (the lockout's countdown ticks inside one state).
    private var stateKey: String {
        if ConsoleTheme.gateRests(phase) { return "rests" }
        switch gate {
        case .off: return "off"
        case .listening: return "listening"
        case .heard: return "heard"
        case .authenticating: return "authenticating"
        case .granted: return "granted"
        case .denied: return "denied"
        case .lockedOut: return "locked"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if ConsoleTheme.gateRests(phase) {
                // The status menu's "not listening" glyph, dimmed: the ear is off duty, not asleep.
                line(symbol: "ear.trianglebadge.exclamationmark", tint: ConsoleTheme.titanium, text: "Awake — the gate rests until the session ends", color: ConsoleTheme.titanium)
            } else {
                switch gate {
                case .lockedOut:
                    TimelineView(.periodic(from: .now, by: 1)) { ctx in
                        gateLine(now: ctx.date)
                    }
                default:
                    gateLine(now: Date())
                }
                if gate.isListening || gate.isAuthenticating {
                    heardLine.transition(Motion.appear)
                }
            }
        }
        .animation(Motion.gentle, value: stateKey)
    }

    private func gateLine(now: Date) -> some View {
        // Paused: the gate listens for the word to resume, unauthenticated (WakeGate.isPaused).
        let meta = ConsoleTheme.gate(gate, phrases: wake.phrases, auth: wake.auth, now: now, paused: phase == .paused)
        return line(symbol: meta.symbol, tint: meta.color, text: meta.label, color: ConsoleTheme.fg)
    }

    /// The glyph swaps (ConsoleIcon) and the words crossfade as the gate's state turns;
    /// a countdown's digits roll.
    private func line(symbol: String, tint: Color, text: String, color: Color) -> some View {
        HStack(alignment: .top, spacing: iconGap) {
            ConsoleIcon(name: symbol, tint: tint).frame(height: 26)
            Text(text).font(ConsoleTheme.sans(12)).lineSpacing(2).foregroundStyle(color)
                .lineLimit(3).truncationMode(.tail)
                .fixedSize(horizontal: false, vertical: true)
                .frame(minHeight: 26, alignment: .leading)
                .help(text)
                .contentTransition(ConsoleMotion.numeric)
                .animation(Motion.snappy, value: text)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    /// `heard  hey jarhead` — the newest words win, so it truncates from the left.
    private var heardLine: some View {
        HStack(spacing: 8) {
            Text("heard").font(ConsoleTheme.mono(11)).foregroundStyle(ConsoleTheme.fg3)
            Text(heard.isEmpty ? "…" : heard).font(ConsoleTheme.mono(11)).foregroundStyle(ConsoleTheme.titanium)
                .lineLimit(1).truncationMode(.head)
                .help(heard.isEmpty ? "Nothing heard yet" : heard)
        }
        .padding(.leading, 20 + iconGap)
        .padding(.bottom, 4)
        .accessibilityLabel(heard.isEmpty ? "Nothing heard yet" : "Heard: \(heard)")
    }
}

// MARK: - Ledger

struct LedgerPanel: View {
    let days: [String]?
    let picked: String?
    let loading: Bool
    let stats: LedgerStats?

    @Environment(\.consoleActions) private var actions
    /// The picked day's highlight, one view for the list so it glides between rows.
    @Namespace private var selection

    var body: some View {
        VStack(spacing: 0) {
            RailSection("Days", inset: false, trailing: {
                Button { actions.send(.openLedger) } label: {
                    Image(systemName: "folder.fill").font(.system(size: 12, weight: .medium))
                }
                .buttonStyle(ConsoleButtonStyle(kind: .plain, iconOnly: true, height: 24))
                .help("Open the ledger folder")
                .accessibilityLabel("Open ledger folder")
            }) {
                // "Loading…" and the days that answer it crossfade.
                ZStack(alignment: .topLeading) {
                    if let days = days {
                        if days.isEmpty {
                            Text("No ledger yet.").font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg3)
                                .padding(.horizontal, railInset).frame(height: 22)
                                .transition(.opacity)
                        } else {
                            VStack(spacing: 0) {
                                ForEach(days, id: \.self) { day in
                                    DayRow(day: day, on: day == picked, selection: selection) {
                                        withAnimation(Motion.snappy) { actions.pickLedgerDay(day) }
                                    }
                                }
                            }
                            .transition(.opacity)
                        }
                    } else {
                        Reading(text: "Loading…").padding(.horizontal, railInset)
                            .transition(.opacity)
                    }
                }
                .animation(Motion.fade, value: days == nil)
                .animation(Motion.snappy, value: picked)
            }
            // The day's figures arrive under their head once read; "Reading…" gives way to them.
            if let picked = picked {
                RailSection(ConsoleFormat.day(picked)) {
                    ZStack(alignment: .topLeading) {
                        if let stats = stats, !loading {
                            VStack(alignment: .leading, spacing: 0) {
                                KV("Sessions", "\(stats.sessions)")
                                KV("Utterances", "\(stats.utterances)")
                                KV("Delegations", "\(stats.delegations)")
                                KV("Billed", ConsoleFormat.billed(stats.billedSeconds))
                            }
                            .transition(Motion.appear)
                        } else {
                            Reading(text: "Reading…")
                                .transition(.opacity)
                        }
                    }
                    .animation(Motion.gentle, value: stats == nil || loading)
                }
                .transition(Motion.appear)
            }
        }
        .animation(Motion.gentle, value: picked)
        .onAppear { actions.loadLedgerDays() }
    }
}

/// 28pt: the day, its date, the accent bar while it is the one on screen. The
/// highlight is one view on a matched geometry id (LedgerPanel's), so it glides.
private struct DayRow: View {
    let day: String
    let on: Bool
    let selection: Namespace.ID
    let pick: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: pick) {
            HStack(spacing: iconGap) {
                ConsoleIcon(name: "calendar", tint: on ? ConsoleTheme.fg : ConsoleTheme.titanium)
                Text(ConsoleFormat.day(day))
                    .font(ConsoleTheme.sans(12, on ? .medium : .regular))
                    .foregroundStyle(on ? ConsoleTheme.fg : ConsoleTheme.fg2)
                Spacer(minLength: 4)
                Text(day).font(ConsoleTheme.mono(11)).monospacedDigit().foregroundStyle(ConsoleTheme.titanium)
            }
            .padding(.horizontal, railInset)
            .frame(height: 28)
            .frame(maxWidth: .infinity)
            .background {
                if on {
                    ZStack(alignment: .leading) {
                        Rectangle().fill(ConsoleTheme.active)
                        Rectangle().fill(ConsoleTheme.accent).frame(width: 2).padding(.vertical, 4)
                    }
                    .matchedGeometryEffect(id: "day-selection", in: selection)
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
        .accessibilityLabel(ConsoleFormat.day(day) + ", " + day)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}
