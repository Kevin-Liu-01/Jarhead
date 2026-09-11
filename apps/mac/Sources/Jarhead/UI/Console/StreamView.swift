import SwiftUI
import AppKit
import ImageIO

// The centre column: ledger banner, the feed with sticky auto-scroll and a
// jump pill, and the composer. Every row shares one grid: a 56pt right-aligned
// mono timestamp, a 20pt solid-icon column, then content. Rows draw no rules
// (spacing parses the list); a delegation is one square hairline box aligned
// to the icon column, with row-weight rules inside it.

private let stampWidth: CGFloat = 56
private let stampGap: CGFloat = 10
private let iconGap: CGFloat = 8
private let deltaWidth: CGFloat = 60

struct StreamPane: View, Equatable {
    let transcript: [TranscriptItem]
    let delegations: [Delegation]
    let phase: Phase
    let hasSession: Bool
    let ledgerDay: String?
    let ledgerEntries: [StreamEntry]
    let ledgerLoading: Bool

    @EnvironmentObject private var session: ConsoleSession

    static func == (a: StreamPane, b: StreamPane) -> Bool {
        a.transcript == b.transcript && a.delegations == b.delegations && a.phase == b.phase && a.hasSession == b.hasSession
            && a.ledgerDay == b.ledgerDay && a.ledgerEntries == b.ledgerEntries && a.ledgerLoading == b.ledgerLoading
    }

    private var entries: [StreamEntry] {
        ledgerDay == nil ? StreamBuilder.fromSnapshot(transcript: transcript, delegations: delegations) : ledgerEntries
    }

    private var delegationRunning: Bool {
        delegations.contains { $0.status == .running || $0.status == .awaitingConfirmation }
    }

    var body: some View {
        VStack(spacing: 0) {
            if let day = ledgerDay {
                LedgerBanner(day: day) { session.showLive() }
            }
            StreamFeed(entries: entries, modeKey: ledgerDay ?? "live", emptyState: emptyState)
            ComposerBar(phase: phase, stopHot: delegationRunning)
        }
    }

    private var emptyState: StreamEmptyState {
        if ledgerDay != nil {
            if ledgerLoading { return StreamEmptyState(text: "Reading…", loading: true) }
            return StreamEmptyState(text: "Nothing recorded.")
        }
        if !hasSession { return StreamEmptyState(text: "Asleep. Wake me.", wake: true) }
        return StreamEmptyState(text: "Nothing heard yet.")
    }
}

struct StreamEmptyState: Equatable {
    let text: String
    var wake = false
    var loading = false
}

/// 40pt, so its rule meets the two rail heads' rules on one seam: which day is
/// on screen, and the way back to live. Owns its bottom rule.
private struct LedgerBanner: View {
    let day: String
    let back: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: iconGap) {
                ConsoleIcon(name: "calendar")
                Text(ConsoleFormat.day(day)).font(ConsoleTheme.sans(12, .medium)).foregroundStyle(ConsoleTheme.fg)
                Text(day).font(ConsoleTheme.mono(11)).monospacedDigit().foregroundStyle(ConsoleTheme.titanium)
                Spacer()
                Button(action: back) { Label("Live", systemImage: "bolt.fill") }
                    .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 24, small: true))
                    .help("Back to the live stream")
            }
            .padding(.horizontal, 12)
            .frame(height: 40)
            ConsoleHairline()
        }
    }
}

// MARK: - Feed with sticky auto-scroll

/// Where the feed's scroll view is: the clip's top (y down; the document is
/// flipped), the viewport height and the document height.
struct ConsoleScrollGeometry: Equatable {
    var minY: CGFloat = 0
    var viewport: CGFloat = 0
    var content: CGFloat = 0
    var distanceFromBottom: CGFloat { content - (minY + viewport) }
}

/// SwiftUI's ScrollView on macOS is an NSScrollView that scrolls its document
/// natively, so a GeometryReader preference inside the content never updates
/// (verified on macOS 14: it fires once with the defaults). A zero-height
/// AppKit view placed in the content finds that scroll view, reports every
/// clip-bounds and document-frame change, and scrolls to the exact bottom —
/// which a LazyVStack's `scrollTo` cannot promise while rows are unmaterialised.
final class ConsoleScrollProbeView: NSView {
    var onChange: ((ConsoleScrollGeometry) -> Void)?
    private var tokens: [NSObjectProtocol] = []
    private weak var hooked: NSScrollView?

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        // A probe whose feed was torn down (the list emptied) must fall silent, or
        // it and its successor both report. The hierarchy is complete one turn later.
        guard window != nil else { unhook(); hooked = nil; return }
        DispatchQueue.main.async { [weak self] in self?.hook() }
    }

    override var intrinsicContentSize: NSSize { NSSize(width: 0, height: 0) }
    /// Never in the way of a click.
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    private func hook() {
        guard let scroll = enclosingScrollView, scroll !== hooked else { return }
        unhook()
        hooked = scroll
        let clip = scroll.contentView
        clip.postsBoundsChangedNotifications = true
        clip.postsFrameChangedNotifications = true
        let center = NotificationCenter.default
        tokens.append(center.addObserver(forName: NSView.boundsDidChangeNotification, object: clip, queue: .main) { [weak self] _ in self?.report() })
        tokens.append(center.addObserver(forName: NSView.frameDidChangeNotification, object: clip, queue: .main) { [weak self] _ in self?.report() })
        if let doc = scroll.documentView {
            doc.postsFrameChangedNotifications = true
            tokens.append(center.addObserver(forName: NSView.frameDidChangeNotification, object: doc, queue: .main) { [weak self] _ in self?.report() })
        }
        report()
    }

    private func unhook() {
        tokens.forEach(NotificationCenter.default.removeObserver)
        tokens.removeAll()
    }

    deinit { unhook() }

    var geometry: ConsoleScrollGeometry? {
        guard let scroll = enclosingScrollView, let doc = scroll.documentView else { return nil }
        let clip = scroll.contentView
        return ConsoleScrollGeometry(minY: clip.bounds.minY, viewport: clip.bounds.height, content: doc.frame.height)
    }

    private func report() {
        guard window != nil, let geometry = geometry else { return }
        if ConsoleScrollProbeView.debug, let scroll = enclosingScrollView, let doc = scroll.documentView {
            FileHandle.standardError.write(Data("[scroll] minY=\(Int(geometry.minY)) viewport=\(Int(geometry.viewport)) content=\(Int(geometry.content)) distance=\(Int(geometry.distanceFromBottom)) docFlipped=\(doc.isFlipped) clipFlipped=\(scroll.contentView.isFlipped)\n".utf8))
        }
        onChange?(geometry)
    }

    static let debug = ProcessInfo.processInfo.environment["CONSOLE_SCROLL_DEBUG"] == "1"

    /// Scrolls so the document's last point is at the viewport's bottom. False
    /// when there is no scroll view yet (the caller falls back to SwiftUI).
    @discardableResult
    func scrollToBottom(animated: Bool) -> Bool {
        guard let scroll = enclosingScrollView, let doc = scroll.documentView else { return false }
        let clip = scroll.contentView
        let y = doc.isFlipped ? max(0, doc.frame.height - clip.bounds.height) : 0
        let origin = NSPoint(x: clip.bounds.origin.x, y: y)
        if animated {
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.2
                ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
                clip.animator().setBoundsOrigin(origin)
            }
        } else {
            clip.scroll(to: origin)
        }
        scroll.reflectScrolledClipView(clip)
        return true
    }
}

struct ConsoleScrollProbe: NSViewRepresentable {
    let tracker: ConsoleFeedTracker

    func makeNSView(context: Context) -> ConsoleScrollProbeView {
        let view = ConsoleScrollProbeView()
        view.onChange = { [tracker] in tracker.track($0) }
        tracker.probe = view
        return view
    }

    func updateNSView(_ view: ConsoleScrollProbeView, context: Context) {
        tracker.probe = view
    }
}

/// The feed's sticky-scroll bookkeeping. It lives in a reference type because
/// the probe reports from AppKit notifications, outside SwiftUI's update: a
/// `@State` read there returns the value the last body saw, so two reports in
/// one turn would both compare against a stale `lastMinY`. Only the pill's
/// visibility is published.
@MainActor
final class ConsoleFeedTracker: ObservableObject {
    /// Shows the "Latest" pill: the user has scrolled up from the end.
    @Published private(set) var showJump = false
    /// Follows the end: new rows and growth re-pin the bottom.
    private(set) var stuck = true
    private var lastMinY: CGFloat = 0
    weak var probe: ConsoleScrollProbeView?
    /// SwiftUI's own scroll-to-bottom, for the moment before the probe is hooked.
    var fallback: (Bool) -> Void = { _ in }
    var reduceMotion = false

    /// Within this many points of the end counts as "at the bottom".
    static let stickZone: CGFloat = 32

    /// Three causes, told apart by how the clip's top moved. Up (the user, toward
    /// older rows) unsticks at once — unless the view is still exactly at the
    /// end, which is a clamp after content shrank. Down into the stick zone (the
    /// user coming back, or our own jump landing) sticks. No move at all with a
    /// stuck feed short of the end (a row appended, a thumbnail decoding, a lazy
    /// row materialising, a taller window) re-pins it exactly — a zone-wide
    /// tolerance here would leave a new row a line below the fold.
    func track(_ geo: ConsoleScrollGeometry) {
        defer { lastMinY = geo.minY }
        let distance = geo.distanceFromBottom
        if geo.minY < lastMinY - 0.5 {
            guard distance > 0.5 else { return }
            stuck = false
            if !showJump { showJump = true }
        } else if geo.minY > lastMinY + 0.5 {
            guard distance <= Self.stickZone else { return }
            stuck = true
            if showJump { showJump = false }
        } else if stuck, distance > 0.5 {
            jump(animated: false)
        }
    }

    /// Back to live, or a new day: follow the end again.
    func reset() {
        stuck = true
        if showJump { showJump = false }
        jump(animated: false)
    }

    func jump(animated: Bool) {
        stuck = true
        if showJump { showJump = false }
        // Let the new rows lay out before asking for the bottom.
        DispatchQueue.main.async { [self] in
            let animate = animated && !reduceMotion
            if probe?.scrollToBottom(animated: animate) == true { return }
            fallback(animate)
        }
    }
}

struct StreamFeed: View {
    let entries: [StreamEntry]
    let modeKey: String
    let emptyState: StreamEmptyState

    @Environment(\.consoleActions) private var actions
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @StateObject private var tracker = ConsoleFeedTracker()

    private static let bottomId = "stream-bottom"

    var body: some View {
        ScrollViewReader { proxy in
            ZStack(alignment: .bottom) {
                GeometryReader { outer in
                    ScrollView(.vertical) {
                        if entries.isEmpty {
                            emptyView.frame(minHeight: outer.size.height)
                        } else {
                            // Not lazy on purpose: a lazy stack re-estimates the height of rows it
                            // has dropped, so the content height jitters by tens of points after
                            // every append and the viewport slides under the reader. Two hundred
                            // materialised rows are cheap; a stable document is not optional.
                            VStack(alignment: .leading, spacing: 0) {
                                ForEach(entries) { entry in
                                    StreamRow(entry: entry)
                                }
                                Color.clear.frame(height: 1).id(Self.bottomId)
                            }
                            .padding(EdgeInsets(top: 8, leading: 12, bottom: 12, trailing: 16))
                            .thinScrollers()
                            // In the background so it is always materialised with the stack.
                            .background(alignment: .topLeading) {
                                ConsoleScrollProbe(tracker: tracker).frame(width: 0, height: 0)
                            }
                        }
                    }
                }
                if tracker.showJump && !entries.isEmpty {
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
                    .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
                    .help("Jump to the latest")
                }
            }
            .animation(reduceMotion ? nil : ConsoleTheme.motion, value: tracker.showJump)
            .onAppear {
                tracker.reduceMotion = reduceMotion
                tracker.fallback = { animate in
                    if animate {
                        withAnimation(ConsoleTheme.motion) { proxy.scrollTo(Self.bottomId, anchor: .bottom) }
                    } else {
                        proxy.scrollTo(Self.bottomId, anchor: .bottom)
                    }
                }
                tracker.jump(animated: false)
            }
            .onChange(of: reduceMotion) { tracker.reduceMotion = reduceMotion }
            .onChange(of: entries) {
                if tracker.stuck { tracker.jump(animated: false) }
            }
            .onChange(of: modeKey) { tracker.reset() }
        }
    }

    private var emptyView: some View {
        ConsoleEmpty(emptyState.text) {
            if emptyState.loading {
                ProgressView().controlSize(.small)
            } else if emptyState.wake {
                Button { actions.send(.wake) } label: { Label("Wake", systemImage: "bolt.fill") }
                    .buttonStyle(ConsoleButtonStyle(kind: .primary, height: 28))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

}

private struct JumpPillStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(ConsoleTheme.sans(12, .medium))
            .foregroundStyle(ConsoleTheme.fg)
            .padding(.leading, 10).padding(.trailing, 12)
            .frame(height: 26)
            .background(RoundedRectangle(cornerRadius: 6).fill(ConsoleTheme.raised))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(ConsoleTheme.hair, lineWidth: 1))
            .opacity(configuration.isPressed ? 0.8 : 1)
    }
}

// MARK: - Rows

struct StreamRow: View, Equatable {
    let entry: StreamEntry

    var body: some View {
        switch entry {
        case .utterance(let t): UtteranceRow(item: t)
        case .delegation(let d): DelegationCard(delegation: d)
        case .system(let s): SystemRow(entry: s)
        }
    }
}

/// The right-aligned mono timestamp every row starts with.
private struct Stamp: View {
    let at: Double
    var body: some View {
        Text(ConsoleFormat.time(at))
            .font(ConsoleTheme.mono(11)).monospacedDigit().foregroundStyle(ConsoleTheme.fg3)
            .frame(width: stampWidth, alignment: .trailing)
            .help(ConsoleFormat.fullDate(at))
    }
}

struct UtteranceRow: View {
    let item: TranscriptItem

    var body: some View {
        let kevin = item.speaker == .kevin
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            Stamp(at: item.at)
            ConsoleIcon(name: kevin ? "person.fill" : "waveform", tint: kevin ? ConsoleTheme.titanium : ConsoleTheme.speaking)
                .padding(.leading, stampGap)
                .accessibilityLabel(kevin ? "Kevin" : "Jarhead")
            HStack(alignment: .lastTextBaseline, spacing: 3) {
                Text(item.text.isEmpty ? "…" : item.text)
                    .font(ConsoleTheme.sans(13))
                    .lineSpacing(3)
                    .foregroundStyle(ConsoleTheme.fg)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                if !item.final { StreamingCaret(color: ConsoleTheme.fg) }
            }
            .padding(.leading, iconGap)
            .frame(maxWidth: 640, alignment: .leading)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 5)
    }
}

private struct StreamingCaret: View {
    let color: Color
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var on = true
    var body: some View {
        Rectangle().fill(color).frame(width: 2, height: 12)
            .opacity(on ? 1 : 0.15)
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.easeInOut(duration: 0.5).repeatForever()) { on = false }
            }
    }
}

struct SystemRow: View {
    let entry: SystemEntry
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            Stamp(at: entry.at)
            ConsoleIcon(name: entry.symbol, tint: entry.tone == .problem ? ConsoleTheme.error : ConsoleTheme.titanium)
                .padding(.leading, stampGap)
            HStack(spacing: 8) {
                Text(entry.text).font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg2)
                if let mono = entry.mono {
                    Text(mono).font(ConsoleTheme.mono(11)).foregroundStyle(ConsoleTheme.titanium)
                }
                if let status = entry.agentStatus {
                    ConsoleStatusGlyph(status: status)
                }
                if let trailing = entry.trailing, !trailing.isEmpty {
                    Text(trailing).font(ConsoleTheme.sans(11)).foregroundStyle(ConsoleTheme.fg3).lineLimit(1).truncationMode(.tail)
                }
            }
            .padding(.leading, iconGap)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Delegation card

struct DelegationCard: View {
    let delegation: Delegation

    var body: some View {
        let d = delegation
        let meta = ConsoleTheme.delegation(d.status)
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center, spacing: iconGap) {
                ConsoleDelegationGlyph(status: d.status)
                Text(d.request)
                    .font(ConsoleTheme.sans(12, .medium)).foregroundStyle(ConsoleTheme.fg)
                    .lineLimit(1).truncationMode(.tail)
                    .help(d.request)
                Spacer(minLength: 8)
                Text(ConsoleFormat.shortId(d.id)).font(ConsoleTheme.mono(11)).foregroundStyle(ConsoleTheme.titanium).help(d.liveId)
                Text(ConsoleFormat.time(d.createdAt)).font(ConsoleTheme.mono(11)).monospacedDigit().foregroundStyle(ConsoleTheme.titanium)
                    .help(ConsoleFormat.fullDate(d.createdAt))
            }
            .padding(.horizontal, 10)
            .frame(height: 30)
            ConsoleHairline(weight: .row)

            DelegationTimeline(timings: d.timings, status: d.status, tone: meta.color)
                .padding(EdgeInsets(top: 7, leading: 10, bottom: 4, trailing: 10))

            if !d.steps.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(d.steps.enumerated()), id: \.element.id) { index, step in
                        StepRow(step: step, delegatedAt: d.timings.delegatedAt,
                                waiting: d.status == .awaitingConfirmation && index == d.steps.count - 1)
                    }
                }
                .padding(EdgeInsets(top: 2, leading: 10, bottom: 6, trailing: 10))
            } else {
                Spacer().frame(height: 6)
            }

            if let summary = d.summary, !summary.isEmpty {
                ConsoleHairline(weight: .row)
                HStack(alignment: .firstTextBaseline, spacing: iconGap) {
                    ConsoleIcon(name: meta.symbol, tint: meta.color)
                    Text(summary).font(ConsoleTheme.sans(12)).lineSpacing(2).foregroundStyle(ConsoleTheme.fg2)
                        .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
                .padding(EdgeInsets(top: 7, leading: 10, bottom: 8, trailing: 10))
            }
        }
        .overlay(Rectangle().stroke(ConsoleTheme.hair, lineWidth: 1))
        .padding(.leading, stampWidth + stampGap)
        .padding(.vertical, 8)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Delegation, \(meta.label)")
    }
}

private struct TimelineMark: Identifiable {
    let id: String
    let label: String
    let delta: String
    let color: Color
}

/// One mono line: delegated 0 · thinking +350 ms · spoke +1.1 s · done +3.1 s.
struct DelegationTimeline: View {
    let timings: DelegationTimings
    let status: DelegationStatus
    let tone: Color

    var body: some View {
        if timings.doneAt == nil {
            TimelineView(.periodic(from: .now, by: 1)) { ctx in
                line(now: ctx.date.timeIntervalSince1970 * 1000)
            }
        } else {
            line(now: timings.doneAt!)
        }
    }

    private func marks(now: Double) -> [TimelineMark] {
        let t0 = timings.delegatedAt
        var m: [TimelineMark] = [TimelineMark(id: "delegated", label: "delegated", delta: "0", color: ConsoleTheme.fg3)]
        if let t = timings.firstThinkingAt {
            m.append(TimelineMark(id: "thinking", label: "thinking", delta: ConsoleFormat.delta(t - t0), color: ConsoleTheme.thinking))
        }
        if let t = timings.firstCommentaryAt {
            m.append(TimelineMark(id: "spoke", label: "spoke", delta: ConsoleFormat.delta(t - t0), color: ConsoleTheme.speaking))
        }
        if let done = timings.doneAt {
            m.append(TimelineMark(id: "end", label: status == .awaitingConfirmation ? "waiting" : status.rawValue,
                                  delta: ConsoleFormat.delta(done - t0), color: tone))
        } else {
            m.append(TimelineMark(id: "end", label: status == .awaitingConfirmation ? "waiting" : "running",
                                  delta: ConsoleFormat.ms(now - t0), color: tone))
        }
        return m
    }

    /// Marks stay whole: when the card is narrow the line wraps a mark to the
    /// next row instead of truncating each label to a letter.
    private func line(now: Double) -> some View {
        let marks = marks(now: now)
        return ConsoleFlow(hSpacing: 12, vSpacing: 3) {
            ForEach(marks) { mark in
                HStack(spacing: 5) {
                    Circle().fill(mark.color).frame(width: 5, height: 5)
                    Text(mark.label).foregroundStyle(ConsoleTheme.fg2)
                    Text(mark.delta).foregroundStyle(ConsoleTheme.titanium)
                }
                .lineLimit(1)
                .fixedSize()
            }
        }
        .font(ConsoleTheme.mono(11))
        .monospacedDigit()
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Timeline: " + marks.map { "\($0.label) \($0.delta)" }.joined(separator: ", "))
    }
}

// MARK: - Steps

/// The right-aligned "+1.2 s" every step ends with.
private struct StepDelta: View {
    let ms: Double
    let at: Double
    var body: some View {
        Text(ConsoleFormat.delta(ms))
            .font(ConsoleTheme.mono(11)).monospacedDigit().foregroundStyle(ConsoleTheme.titanium)
            .frame(width: deltaWidth, alignment: .trailing)
            .help(ConsoleFormat.time(at))
    }
}

struct StepRow: View {
    let step: DelegationStep
    let delegatedAt: Double
    let waiting: Bool

    @Environment(\.consoleActions) private var actions
    @EnvironmentObject private var session: ConsoleSession

    var body: some View {
        switch step.kind {
        case .thinking:
            row("ellipsis", ConsoleTheme.titanium) {
                Text(step.text ?? "").font(ConsoleTheme.sans(12)).italic().foregroundStyle(ConsoleTheme.fg3)
            }
        case .commentary:
            row("speaker.wave.2.fill", ConsoleTheme.speaking) {
                Text(step.text ?? "").font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg)
            }
        case .tool:
            if let tool = step.tool {
                ToolStepRow(step: step, tool: tool, delegatedAt: delegatedAt)
            } else {
                row("terminal.fill", ConsoleTheme.titanium) {
                    Text(step.text ?? "tool").font(ConsoleTheme.mono(12)).foregroundStyle(ConsoleTheme.fg)
                }
            }
        case .screenshot:
            row("photo.fill", ConsoleTheme.titanium, top: true) {
                VStack(alignment: .leading, spacing: 4) {
                    if let path = step.screenshotPath {
                        let url = actions.screenshotURL(path)
                        ScreenshotThumb(url: url) {
                            session.lightbox = ConsoleLightboxItem(url: url, caption: step.text ?? path)
                        }
                    }
                    Text(step.text ?? step.screenshotPath ?? "").font(ConsoleTheme.sans(11)).foregroundStyle(ConsoleTheme.fg3)
                        .lineLimit(1).truncationMode(.middle)
                }
            }
        case .confirm:
            row("hand.raised.fill", waiting ? ConsoleTheme.speaking : ConsoleTheme.titanium) {
                Text(step.text ?? "").font(ConsoleTheme.sans(12, waiting ? .medium : .regular))
                    .foregroundStyle(waiting ? ConsoleTheme.fg : ConsoleTheme.fg2)
            }
            .accessibilityHint(waiting ? "Waiting for Kevin" : "")
        case .error:
            row("exclamationmark.triangle.fill", ConsoleTheme.error) {
                Text(step.text ?? "").font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg)
            }
        case .note:
            row("text.alignleft", ConsoleTheme.titanium) {
                Text(step.text ?? "").font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg2)
            }
        }
    }

    private func row<C: View>(_ symbol: String, _ tint: Color, top: Bool = false, @ViewBuilder content: () -> C) -> some View {
        HStack(alignment: top ? .top : .firstTextBaseline, spacing: iconGap) {
            ConsoleIcon(name: symbol, tint: tint)
            content()
                .lineSpacing(2)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            StepDelta(ms: step.at - delegatedAt, at: step.at)
        }
        .padding(.vertical, 3)
    }
}

struct ToolStepRow: View {
    let step: DelegationStep
    let tool: ToolStep
    let delegatedAt: Double
    @State private var expanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: iconGap) {
                ConsoleIcon(name: "terminal.fill")
                Button {
                    withAnimation(reduceMotion ? nil : ConsoleTheme.fast) { expanded.toggle() }
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold)).foregroundStyle(ConsoleTheme.fg3)
                            .rotationEffect(.degrees(expanded ? 90 : 0))
                        // The name and timing keep their width; the input preview absorbs the squeeze.
                        Text(tool.name).font(ConsoleTheme.mono(12)).foregroundStyle(ConsoleTheme.fg)
                            .lineLimit(1).truncationMode(.tail).layoutPriority(1)
                        Circle().fill(tool.ok ? ConsoleTheme.acting : ConsoleTheme.error).frame(width: 5, height: 5)
                            .help(tool.ok ? "ok" : "failed")
                            .accessibilityLabel(tool.ok ? "ok" : "failed")
                        Text(ConsoleFormat.ms(tool.ms)).font(ConsoleTheme.mono(11)).monospacedDigit().foregroundStyle(ConsoleTheme.titanium)
                            .lineLimit(1).layoutPriority(1)
                        if let input = tool.input, !expanded {
                            Text(input.compact).font(ConsoleTheme.mono(11)).foregroundStyle(ConsoleTheme.titanium).lineLimit(1).truncationMode(.tail)
                        }
                        if let text = step.text, !text.isEmpty {
                            Text(text).font(ConsoleTheme.mono(11)).foregroundStyle(ConsoleTheme.titanium).lineLimit(1).truncationMode(.tail)
                        }
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(tool.name), \(tool.ok ? "ok" : "failed"), \(ConsoleFormat.ms(tool.ms))")
                .accessibilityAddTraits(expanded ? .isSelected : [])
                StepDelta(ms: step.at - delegatedAt, at: step.at)
            }
            .padding(.vertical, 3)

            if expanded {
                VStack(alignment: .leading, spacing: 6) {
                    ioBlock("input", ConsoleFormat.pretty(tool.input).isEmpty ? "—" : ConsoleFormat.pretty(tool.input))
                    if let output = tool.output { ioBlock("output", ConsoleFormat.pretty(output)) }
                }
                .padding(EdgeInsets(top: 2, leading: 20 + iconGap, bottom: 6, trailing: deltaWidth + iconGap))
                .transition(.opacity)
            }
        }
    }

    /// The one artifact surface: raised ink, no border.
    private func ioBlock(_ key: String, _ text: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(key).font(ConsoleTheme.sans(11, .medium)).foregroundStyle(ConsoleTheme.titanium)
            ScrollView(.vertical) {
                Text(text).font(ConsoleTheme.mono(11)).lineSpacing(2).foregroundStyle(ConsoleTheme.fg2)
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

// MARK: - Screenshots

/// A decoded bitmap boxed so it can cross task boundaries.
struct ConsoleBitmap: @unchecked Sendable {
    let cg: CGImage
}

/// Decodes and downsamples screenshots off the main thread with ImageIO, once
/// per path, and hands the UI a small CGImage. The full-resolution read is
/// only for the lightbox.
actor ConsoleThumbnails {
    static let shared = ConsoleThumbnails()

    private var cache: [String: ConsoleBitmap] = [:]
    private var inflight: [String: Task<ConsoleBitmap?, Never>] = [:]

    func thumbnail(for url: URL, maxPixel: Int) async -> CGImage? {
        let key = "\(maxPixel)|\(url.path)"
        if let hit = cache[key] { return hit.cg }
        let task: Task<ConsoleBitmap?, Never>
        if let running = inflight[key] {
            task = running
        } else {
            task = Task.detached(priority: .utility) { ConsoleThumbnails.decodeThumbnail(url, maxPixel: maxPixel) }
            inflight[key] = task
        }
        let result = await task.value
        inflight[key] = nil
        if let result = result {
            if cache.count >= 256 { cache.removeAll(keepingCapacity: true) }
            cache[key] = result
        }
        return result?.cg
    }

    nonisolated static func decodeThumbnail(_ url: URL, maxPixel: Int) -> ConsoleBitmap? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return ConsoleBitmap(cg: image)
    }

    /// Full resolution, decoded immediately so the first draw does no work on the main thread.
    nonisolated static func decodeFull(_ url: URL) -> ConsoleBitmap? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        let options: [CFString: Any] = [kCGImageSourceShouldCacheImmediately: true]
        guard let image = CGImageSourceCreateImageAtIndex(source, 0, options as CFDictionary) else { return nil }
        return ConsoleBitmap(cg: image)
    }
}

struct ScreenshotThumb: View {
    let url: URL
    let onTap: () -> Void

    /// 2x of the 200pt frame.
    private static let maxPixel = 400

    @State private var image: CGImage?
    @State private var failed = false
    @State private var hovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if let image = image {
                Image(image, scale: 2, label: Text("Screenshot")).resizable().aspectRatio(contentMode: .fit)
            } else {
                ZStack {
                    Rectangle().fill(ConsoleTheme.raised)
                    Image(systemName: failed ? "photo.badge.exclamationmark.fill" : "photo.fill")
                        .font(.system(size: 14, weight: .medium)).foregroundStyle(ConsoleTheme.fg3)
                }
                .aspectRatio(16 / 10, contentMode: .fit)
            }
        }
        .frame(width: 200)
        .overlay(Rectangle().stroke(hovering && image != nil ? ConsoleTheme.fg : ConsoleTheme.hairFrame, lineWidth: 1))
        .animation(reduceMotion ? nil : ConsoleTheme.fast, value: hovering)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .onTapGesture { if image != nil { onTap() } }
        .task(id: url) {
            let decoded = await ConsoleThumbnails.shared.thumbnail(for: url, maxPixel: Self.maxPixel)
            guard !Task.isCancelled else { return }
            image = decoded
            failed = decoded == nil
        }
        .accessibilityLabel("Screenshot")
        .accessibilityAddTraits(.isButton)
    }
}

// MARK: - Lightbox

struct LightboxView: View {
    let item: ConsoleLightboxItem
    let dismiss: () -> Void
    @State private var image: CGImage?
    @State private var failed = false

    var body: some View {
        VStack(spacing: 10) {
            Group {
                if let image = image {
                    Image(image, scale: 1, label: Text(item.caption)).resizable().aspectRatio(contentMode: .fit)
                        .overlay(Rectangle().stroke(ConsoleTheme.hairFrame, lineWidth: 1))
                } else if failed {
                    ConsoleEmpty("Screenshot not found.")
                } else {
                    ProgressView().controlSize(.small)
                }
            }
            .frame(maxWidth: 1400, maxHeight: 820)
            HStack(spacing: 10) {
                Text(item.caption).font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg2).lineLimit(2)
                Text(item.url.lastPathComponent).font(ConsoleTheme.mono(11)).foregroundStyle(ConsoleTheme.titanium).lineLimit(1).truncationMode(.middle)
                Spacer()
                Button("Close", action: dismiss)
                    .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 24, small: true))
                    .keyboardShortcut(.cancelAction)
            }
        }
        .padding(16)
        .frame(minWidth: 640, minHeight: 420)
        .background(ConsoleTheme.ground)
        .contentShape(Rectangle())
        .onTapGesture(perform: dismiss)
        .task {
            let url = item.url
            let decoded = await Task.detached(priority: .userInitiated) { ConsoleThumbnails.decodeFull(url) }.value
            guard !Task.isCancelled else { return }
            image = decoded?.cg
            failed = decoded == nil
        }
    }
}

// MARK: - Composer

/// 48pt, owns its top rule: wake/sleep, mute, the field, Send (the one filled
/// accent, only while there is text), Stop (filled red only while a delegation runs).
struct ComposerBar: View {
    let phase: Phase
    let stopHot: Bool

    @Environment(\.consoleActions) private var actions
    @EnvironmentObject private var session: ConsoleSession
    @State private var text = ""
    @FocusState private var focused: Bool

    private var inSession: Bool { ConsoleTheme.sessionPhases.contains(phase) }
    private var muted: Bool { phase == .muted }
    private var hasText: Bool { !text.trimmingCharacters(in: .whitespaces).isEmpty }

    var body: some View {
        VStack(spacing: 0) {
            ConsoleHairline()
            HStack(spacing: 8) {
                Button { actions.send(inSession ? .sleep : .wake) } label: {
                    Image(systemName: inSession ? "moon.fill" : "bolt.fill").font(.system(size: 13, weight: .medium))
                }
                .buttonStyle(ConsoleButtonStyle(kind: .ghost, iconOnly: true, height: 32))
                .help(inSession ? "Sleep" : "Wake")
                .accessibilityLabel(inSession ? "Sleep" : "Wake")

                Button { actions.send(muted ? .unmute : .mute) } label: {
                    Image(systemName: muted ? "mic.slash.fill" : "mic.fill").font(.system(size: 13, weight: .medium))
                }
                .buttonStyle(ConsoleButtonStyle(kind: .ghost, iconOnly: true, height: 32))
                .disabled(!inSession)
                .help(muted ? "Unmute" : "Mute")
                .accessibilityLabel(muted ? "Unmute" : "Mute")

                TextField(inSession ? "Say something…" : "Type to Jarhead…", text: $text)
                    .consoleField(height: 32, focused: focused)
                    .focused($focused)
                    .onSubmit(submit)
                    .onExitCommand { focused = false }

                Button(action: submit) {
                    Image(systemName: "arrow.up").font(.system(size: 13, weight: .semibold))
                }
                .buttonStyle(ConsoleButtonStyle(kind: hasText ? .primary : .ghost, iconOnly: true, height: 32))
                .disabled(!hasText)
                .help("Send (Return)")
                .accessibilityLabel("Send")

                Button { actions.send(.stop) } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "stop.fill").font(.system(size: 10))
                        Text("Stop")
                    }
                }
                .buttonStyle(ConsoleButtonStyle(kind: stopHot ? .danger : .ghost, height: 32))
                .help("Stop everything (⌘.)")
            }
            .padding(EdgeInsets(top: 8, leading: 12, bottom: 8, trailing: 12))
        }
        .onChange(of: session.composerFocusRequest) { focused = true }
    }

    private func submit() {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        actions.send(.sayText(t))
        text = ""
    }
}
