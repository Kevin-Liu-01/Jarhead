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
    /// Kevin cleared Now then (AppState.nowClearedAt): older items hide, the feed says "Cleared · Undo".
    var clearedAt: Double? = nil
    /// The delegations' workers (Snapshot.workers): each card shows its own as chips under the timeline.
    var workers: [Worker] = []

    @EnvironmentObject private var session: ConsoleSession
    @Environment(\.consoleActions) private var actions

    static func == (a: StreamPane, b: StreamPane) -> Bool {
        a.transcript == b.transcript && a.delegations == b.delegations && a.phase == b.phase && a.hasSession == b.hasSession
            && a.ledgerDay == b.ledgerDay && a.ledgerEntries == b.ledgerEntries && a.ledgerLoading == b.ledgerLoading
            && a.clearedAt == b.clearedAt && a.workers == b.workers
    }

    private var entries: [StreamEntry] {
        ledgerDay == nil ? StreamBuilder.fromSnapshot(transcript: transcript, delegations: delegations, clearedAt: clearedAt) : ledgerEntries
    }

    /// Stop is hot only while the snapshot holds a running or waiting delegation — and
    /// the session is up: a delegation left "running" by a snapshot that says asleep
    /// cannot be running, and must not keep the button red. Nothing local latches it.
    private var delegationRunning: Bool {
        phase != .asleep && delegations.contains { $0.status == .running || $0.status == .awaitingConfirmation }
    }

    var body: some View {
        // The feed's identity is the day on screen: a ledger day arriving or the way back
        // to live switches one feed for the next behind the curtain (Motion.curtain) under
        // the banner, which itself fades and rises in; the composer stays put with whatever
        // was typed. (A masked wipe of the feed cost the main thread 0.6 s a switch — measured.)
        let feedKey = ledgerDay ?? "live"
        VStack(spacing: 0) {
            if let day = ledgerDay {
                LedgerBanner(day: day) { withAnimation(Motion.gentle) { session.showLive() } }
                    .transition(Motion.appear)
            }
            ZStack {
                // A past day's workers are its `worker` rows (system lines); only the live feed has the list.
                StreamFeed(entries: entries, modeKey: feedKey, emptyState: emptyState, undo: undoClear, workers: ledgerDay == nil ? workers : [])
                    .id(feedKey)
                    .transition(.identity)
                Color.clear
                    .allowsHitTesting(false)
                    .id(feedKey)
                    .transition(Motion.curtain(ConsoleTheme.ground))
            }
            .clipped()
            .animation(Motion.wipeAnimation, value: feedKey)
            ComposerBar(phase: phase, stopHot: delegationRunning)
        }
        .animation(Motion.gentle, value: ledgerDay == nil)
    }

    private var emptyState: StreamEmptyState {
        if ledgerDay != nil {
            if ledgerLoading { return StreamEmptyState(text: "Reading…", loading: true) }
            return StreamEmptyState(text: "Nothing recorded.")
        }
        // The way back to a session comes first: a cleared feed must never hide Go.
        if phase == .paused { return StreamEmptyState(text: "Paused. Press Go or type to resume.", go: true) }
        if !hasSession { return StreamEmptyState(text: "Asleep. Press Go.", go: true) }
        // Cleared: the items are hidden, not gone — the ledger has them, Undo brings them back.
        if clearedAt != nil { return StreamEmptyState(text: "Cleared. Jarhead still remembers; the ledger has it.", undo: true) }
        return StreamEmptyState(text: "Nothing heard yet.")
    }

    /// The empty state's Undo: the cleared items come back (now.restore), itself undoable.
    private func undoClear() {
        guard let at = clearedAt else { return }
        actions.cleanup(.restoreNow(clearedAt: at))
    }
}

struct StreamEmptyState: Equatable {
    let text: String
    /// Offer the transport's Go (wake, or resume with the context).
    var go = false
    var loading = false
    /// Offer Undo (the cleared Now).
    var undo = false
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
    /// The probe just found (or re-found) its scroll view; its first report follows.
    var onHook: (() -> Void)?
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
        onHook?()
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
            // The jump to the latest: a view moving on its own, Motion.base, arriving soft.
            Motion.animate(Motion.base, curve: Motion.easeOut) {
                clip.animator().setBoundsOrigin(origin)
            }
        } else {
            clip.scroll(to: origin)
        }
        scroll.reflectScrolledClipView(clip)
        return true
    }

    /// After rows were added *above* the viewport (an older page loaded), shifts
    /// the clip down by the growth so the row Kevin was reading stays put.
    /// `previousContent` is the document height before the change.
    func keepOffset(previousContent: CGFloat) {
        guard let scroll = enclosingScrollView, let doc = scroll.documentView else { return }
        let clip = scroll.contentView
        let delta = doc.frame.height - previousContent
        guard delta > 0.5, doc.isFlipped else { return }
        clip.scroll(to: NSPoint(x: clip.bounds.origin.x, y: clip.bounds.origin.y + delta))
        scroll.reflectScrolledClipView(clip)
    }
}

struct ConsoleScrollProbe: NSViewRepresentable {
    let tracker: ConsoleFeedTracker

    func makeNSView(context: Context) -> ConsoleScrollProbeView {
        let view = ConsoleScrollProbeView()
        view.onChange = { [tracker] in tracker.track($0) }
        view.onHook = { [tracker] in tracker.probeHooked() }
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
    /// The last geometry the probe reported — during a SwiftUI update this is
    /// still the document *before* the change, which a prepend needs.
    private(set) var lastGeometry: ConsoleScrollGeometry?
    private var lastMinY: CGFloat = 0
    /// The probe (re)attached and has not reported since: its first report is a fresh
    /// baseline, not a scroll (see `track`).
    private var rehooked = false
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
        defer { lastMinY = geo.minY; lastGeometry = geo }
        let distance = geo.distanceFromBottom
        if rehooked {
            // The probe's first report after attaching (a pane arriving under a wipe attaches
            // its AppKit views a turn after `onAppear`, so the jump there took SwiftUI's own
            // scrollTo, which lands the content's bottom padding short of the end). Not a
            // scroll by anyone: a stuck feed is pinned exactly, an unstuck one left alone.
            rehooked = false
            if stuck, distance > 0.5 { jump(animated: false) }
            return
        }
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

    /// The probe found its scroll view: the next report is a baseline (`track`).
    func probeHooked() { rehooked = true }

    /// Back to live, or a new day: follow the end again.
    func reset() {
        stuck = true
        if showJump { showJump = false }
        jump(animated: false)
    }

    /// The feed is about to scroll to a row (a search hit): stop following the end, offer the way back.
    func unstick() {
        stuck = false
        if !showJump { showJump = true }
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
    /// The row to open on (a search hit's entry id): the feed scrolls there, unsticks from
    /// the end, and the row's ground lights for a moment. nil follows the end as always.
    var scrollToId: String? = nil
    /// The empty state's Undo (the cleared Now).
    var undo: () -> Void = {}
    /// The live delegations' workers; each card is handed its own (StreamEntry.workers(from:))
    /// and every other row none, so a worker's tick leaves those rows equal. [] for a past day.
    var workers: [Worker] = []

    @Environment(\.consoleActions) private var actions
    @Environment(\.consoleTransport) private var transport
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @StateObject private var tracker = ConsoleFeedTracker()
    /// True one turn after the feed has its first content: rows there from the start
    /// show at once (the pane they are in is arriving on its own), and so do the rows a
    /// read the feed opened waiting on (a Jarhead conversation, a ledger day: they open
    /// with `emptyState.loading` and land whole a moment later — a past conversation is
    /// not "new"); rows appended after that fade in and rise (`rowAppear`, on the row's
    /// ink only — the document's height never animates).
    @State private var settled = false
    /// The row a scroll target lit; fades after a moment.
    @State private var highlightId: String?

    private static let bottomId = "stream-bottom"

    var body: some View {
        ScrollViewReader { proxy in
            ZStack(alignment: .bottom) {
                GeometryReader { outer in
                    ScrollView(.vertical) {
                        if entries.isEmpty {
                            emptyView.frame(minHeight: outer.size.height)
                                .transition(.opacity)
                        } else {
                            // Not lazy on purpose: a lazy stack re-estimates the height of rows it
                            // has dropped, so the content height jitters by tens of points after
                            // every append and the viewport slides under the reader. Two hundred
                            // materialised rows are cheap; a stable document is not optional.
                            VStack(alignment: .leading, spacing: 0) {
                                ForEach(entries) { entry in
                                    StreamRow(entry: entry, workers: entry.workers(from: workers))
                                        .rowAppear(animated: settled)
                                        // The found row's ground, on its own opacity: the layout never moves.
                                        .background(RoundedRectangle(cornerRadius: 6).fill(ConsoleTheme.active).opacity(highlightId == entry.id ? 1 : 0))
                                        .id(entry.id)
                                }
                                Color.clear.frame(height: 1).id(Self.bottomId)
                            }
                            .padding(EdgeInsets(top: 8, leading: 12, bottom: 12, trailing: 16))
                            .thinScrollers()
                            // In the background so it is always materialised with the stack.
                            .background(alignment: .topLeading) {
                                ConsoleScrollProbe(tracker: tracker).frame(width: 0, height: 0)
                            }
                            .transition(.opacity)
                        }
                    }
                    // The empty line and the first rows crossfade; nothing else on the
                    // document is ever animated from here (see ConsoleRowAppear).
                    .animation(Motion.fade, value: entries.isEmpty)
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
                // A feed still reading settles when the read lands (below), so the rows it
                // was waiting on show at once like rows there from the start.
                if !emptyState.loading { settle() }
            }
            .onChange(of: emptyState.loading) { _, loading in
                if !loading { settle() }
            }
            .onChange(of: reduceMotion) { tracker.reduceMotion = reduceMotion }
            .onChange(of: entries) {
                if let target = scrollToId, entries.contains(where: { $0.id == target }) {
                    // The rows a hit was waiting on landed: open on the row, not the end.
                    scroll(to: target, proxy: proxy)
                } else if tracker.stuck {
                    tracker.jump(animated: false)
                }
            }
            .onChange(of: scrollToId) { _, target in
                if let target, entries.contains(where: { $0.id == target }) { scroll(to: target, proxy: proxy) }
            }
            .onChange(of: modeKey) { tracker.reset() }
        }
    }

    /// Rows from the next turn on are "new": the ones in this frame show at once.
    private func settle() {
        guard !settled else { return }
        DispatchQueue.main.async { settled = true }
    }

    /// To the row and light it: the scroll is a view moving on its own (Motion.gentle),
    /// the ground fades over Motion.fade and lets go after a moment. The tracker unsticks
    /// first, so the layout pass that follows does not pin the bottom back.
    private func scroll(to id: String, proxy: ScrollViewProxy) {
        tracker.unstick()
        DispatchQueue.main.async {
            if Motion.reduced {
                proxy.scrollTo(id, anchor: .center)
            } else {
                withAnimation(Motion.gentle) { proxy.scrollTo(id, anchor: .center) }
            }
            withAnimation(Motion.fade) { highlightId = id }
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 1_800_000_000)
                guard highlightId == id else { return }
                withAnimation(Motion.fade) { highlightId = nil }
            }
        }
    }

    private var emptyView: some View {
        ConsoleEmpty(emptyState.text) {
            if emptyState.loading {
                ConsoleGlyphs(cols: 16, rows: 2)
            } else if emptyState.go {
                Button(action: transport.toggle) { Label("Go", systemImage: "play.fill") }
                    .buttonStyle(ConsoleButtonStyle(kind: .primary, height: 28))
                    .help("Go (⌘P)")
            } else if emptyState.undo {
                Button(action: undo) { Label("Undo", systemImage: "arrow.uturn.backward") }
                    .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 28))
                    .help("Bring the cleared items back")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

}

/// The "Latest" pill the stream and a conversation share.
struct JumpPillStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(ConsoleTheme.sans(12, .medium))
            .foregroundStyle(ConsoleTheme.fg)
            .padding(.leading, 10).padding(.trailing, 12)
            .frame(height: 26)
            .background(RoundedRectangle(cornerRadius: 6).fill(ConsoleTheme.raised))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(ConsoleTheme.hair, lineWidth: 1))
            .opacity(configuration.isPressed ? 0.8 : 1)
            .animation(ConsoleMotion.hover, value: configuration.isPressed)
    }
}

// MARK: - Rows

struct StreamRow: View, Equatable {
    let entry: StreamEntry
    /// This row's workers — a delegation card's own (StreamEntry.workers(from:)); [] for the
    /// rest, so a hand's status turning re-evaluates its card and nothing else in the feed.
    var workers: [Worker] = []

    var body: some View {
        switch entry {
        case .utterance(let t): UtteranceRow(item: t)
        case .delegation(let d): DelegationCard(delegation: d, workers: workers)
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
                withAnimation(.easeInOut(duration: Motion.caret).repeatForever()) { on = false }
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

/// The status glyph and the timeline's last mark crossfade as the delegation settles;
/// steps, the workers' chips and the summary arriving after the card fade in and rise on
/// their own ink (`rowAppear`), so the card — and the document under it — takes its new
/// height at once and the feed's pinned bottom never chases an animated layout.
struct DelegationCard: View {
    let delegation: Delegation
    /// This delegation's workers (its second pair of hands), as chips under the timeline.
    var workers: [Worker] = []

    /// One turn after the card appeared; what was there from the start shows at once.
    @State private var settled = false

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

            if !workers.isEmpty {
                WorkerStrip(workers: workers, animated: settled)
                    .padding(EdgeInsets(top: 2, leading: 10, bottom: 4, trailing: 10))
            }

            if !d.steps.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(d.steps.enumerated()), id: \.element.id) { index, step in
                        StepRow(step: step, delegatedAt: d.timings.delegatedAt,
                                waiting: d.status == .awaitingConfirmation && index == d.steps.count - 1,
                                live: d.status == .running && index == d.steps.count - 1)
                            .rowAppear(animated: settled)
                    }
                }
                .padding(EdgeInsets(top: 2, leading: 10, bottom: 6, trailing: 10))
            } else {
                Spacer().frame(height: 6)
            }

            if let summary = d.summary, !summary.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    ConsoleHairline(weight: .row)
                    HStack(alignment: .firstTextBaseline, spacing: iconGap) {
                        ConsoleIcon(name: meta.symbol, tint: meta.color)
                        Text(summary).font(ConsoleTheme.sans(12)).lineSpacing(2).foregroundStyle(ConsoleTheme.fg2)
                            .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                    }
                    .padding(EdgeInsets(top: 7, leading: 10, bottom: 8, trailing: 10))
                }
                .rowAppear(animated: settled)
            }
        }
        .overlay(Rectangle().stroke(ConsoleTheme.hair, lineWidth: 1))
        .padding(.leading, stampWidth + stampGap)
        .padding(.vertical, 8)
        .onAppear { DispatchQueue.main.async { settled = true } }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Delegation, \(meta.label)")
    }
}

/// The delegation's workers as chips in one wrapping row: `● Spotify · working`. A chip
/// arriving fades in and rises on its own ink (`rowAppear`); its glyph and word crossfade as
/// the hand finishes. Flat: a hairline box on the ground, no fill. Nothing here animates
/// layout — a chip takes its width on the frame it changes, so the feed's pinned bottom holds.
struct WorkerStrip: View {
    let workers: [Worker]
    /// False while the card is arriving: chips there from the start show at once.
    var animated = true

    var body: some View {
        ConsoleFlow(hSpacing: 6, vSpacing: 6) {
            ForEach(workers) { w in
                WorkerChip(worker: w).rowAppear(animated: animated)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Workers: " + workers.map { "\($0.name) \($0.status.words)" }.joined(separator: ", "))
    }
}

private struct WorkerChip: View {
    let worker: Worker

    var body: some View {
        let meta = ConsoleTheme.worker(worker.status)
        HStack(spacing: 4) {
            ConsoleWorkerGlyph(status: worker.status)
            Text(worker.name).font(ConsoleTheme.sans(11, .medium)).foregroundStyle(ConsoleTheme.fg).lineLimit(1)
            Text("· \(meta.label)").font(ConsoleTheme.sans(11)).foregroundStyle(ConsoleTheme.fg3).lineLimit(1)
                .contentTransition(.opacity)
                .animation(Motion.fade, value: meta.label)
        }
        .padding(.trailing, 8)
        .frame(height: 22)
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(ConsoleTheme.hair, lineWidth: 1))
        .fixedSize()
        .help([worker.name, ConsoleTheme.lane(worker.lane), worker.task, worker.detail].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(worker.name), \(meta.label), \(ConsoleTheme.lane(worker.lane)) lane")
    }
}

/// `[Spotify]` on a step a worker ran (`DelegationStep.worker`): the hand's name in mono
/// on the step's line, so the parent's own steps and its workers' read apart at a glance.
private struct WorkerTag: View {
    let name: String
    var body: some View {
        Text("[\(name)]").font(ConsoleTheme.mono(11)).foregroundStyle(ConsoleTheme.titanium)
            .lineLimit(1).fixedSize()
            .help("\(name)'s step")
            .accessibilityLabel("by \(name)")
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
                    // The last mark turns from "running" to how it ended: the dot's colour
                    // and the word crossfade; the figure keeps its digits rolling.
                    Circle().fill(mark.color).frame(width: 5, height: 5)
                        .animation(Motion.fade, value: mark.color)
                    Text(mark.label).foregroundStyle(ConsoleTheme.fg2)
                        .contentTransition(.opacity)
                        .animation(Motion.fade, value: mark.label)
                    Text(mark.delta).foregroundStyle(ConsoleTheme.titanium)
                        .contentTransition(ConsoleMotion.numeric)
                        .animation(Motion.snappy, value: mark.delta)
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
    /// The delegation is running and this is its last step: a thinking step is being thought
    /// right now, so its icon column shows the ASCII indicator instead of the ellipsis.
    var live = false

    @Environment(\.consoleActions) private var actions
    @EnvironmentObject private var session: ConsoleSession

    var body: some View {
        switch step.kind {
        case .thinking:
            row("ellipsis", ConsoleTheme.titanium, live: live) {
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

    private func row<C: View>(_ symbol: String, _ tint: Color, top: Bool = false, live: Bool = false, @ViewBuilder content: () -> C) -> some View {
        HStack(alignment: top ? .top : .firstTextBaseline, spacing: iconGap) {
            // A ZStack, so the indicator and the symbol crossfade when the thought settles.
            ZStack {
                if live {
                    ConsoleGlyphs(cols: 3, rows: 1, color: tint).frame(width: 20, height: 20).transition(.opacity)
                } else {
                    ConsoleIcon(name: symbol, tint: tint).transition(.opacity)
                }
            }
            .animation(Motion.fade, value: live)
            if let name = step.worker, name != "Jarhead" { WorkerTag(name: name) }
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

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: iconGap) {
                ConsoleIcon(name: "terminal.fill")
                if let name = step.worker, name != "Jarhead" { WorkerTag(name: name) }
                Button {
                    // Unfolds on its own once pressed: Motion.gentle, the chevron turning with it.
                    withAnimation(Motion.gentle) { expanded.toggle() }
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
                .transition(Motion.appear)
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

    /// Set only by the preview harness (PREVIEW_SLOW_THUMBS=1): every thumbnail waits a minute
    /// before decoding, so the dithered skeletons stay on screen to shoot.
    nonisolated(unsafe) static var holdForPreview = false

    private var cache: [String: ConsoleBitmap] = [:]
    private var inflight: [String: Task<ConsoleBitmap?, Never>] = [:]

    func thumbnail(for url: URL, maxPixel: Int) async -> CGImage? {
        if Self.holdForPreview { try? await Task.sleep(nanoseconds: 60_000_000_000) }
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
    /// 200pt in the stream; the Now panel's mark thumbnails are smaller.
    var width: CGFloat = 200

    /// 2x of the frame.
    private var maxPixel: Int { Int(width * 2) }

    @State private var image: CGImage?
    @State private var failed = false
    @State private var hovering = false
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        // The skeleton (a dithered ground → raised ramp under the photo glyph) and the decoded
        // image are siblings in one ZStack, so the picture wipes in over the crosshatch.
        ZStack {
            if let image = image {
                Image(image, scale: 2, label: Text("Screenshot")).resizable().aspectRatio(contentMode: .fit)
                    .transition(Motion.wipe)
            } else {
                ZStack {
                    DitheredGradient(stops: scheme == .dark ? Dither.skeletonStopsDark : Dither.skeletonStopsLight,
                                     direction: .horizontal, bands: 2, cellPoints: 2)
                    Image(systemName: failed ? "photo.badge.exclamationmark.fill" : "photo.fill")
                        .font(.system(size: 14, weight: .medium)).foregroundStyle(ConsoleTheme.fg3)
                }
                .aspectRatio(16 / 10, contentMode: .fit)
                .transition(Motion.wipe)
            }
        }
        .animation(Motion.animation(Motion.easeOut, Motion.base), value: image == nil)
        .frame(width: width)
        .overlay(Rectangle().stroke(hovering && image != nil ? ConsoleTheme.fg : ConsoleTheme.hairFrame, lineWidth: 1))
        .animation(ConsoleMotion.hover, value: hovering)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .onTapGesture { if image != nil { onTap() } }
        .task(id: url) {
            let decoded = await ConsoleThumbnails.shared.thumbnail(for: url, maxPixel: maxPixel)
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
                    ConsoleGlyphs(cols: 16, rows: 2)
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

/// 48pt, owns its top rule: Go/Pause (the transport's one button — `play.fill` as the
/// filled accent while asleep, a ghost while paused, `pause.fill` in session, a quiet
/// "…" while connecting where a press stops; ⌘P here, ⌥⇧Space anywhere), Mute (enabled
/// only in session), the field, Send (filled accent only while there is text), Stop
/// (filled red while the snapshot holds a running delegation and for Motion.slow
/// (400 ms) after a press — the flash is the only local state, and it lets go on its
/// own). Go/Pause,
/// Send and Stop are enabled in every phase: a Stop must land whatever is happening,
/// and a Go after a Stop must not find the button gone. Pause and Stop both close the
/// session (the meter stops); a pause keeps the conversation, and typing while paused
/// just sends — the engine resumes first.
struct ComposerBar: View {
    let phase: Phase
    let stopHot: Bool

    @Environment(\.consoleActions) private var actions
    @Environment(\.consoleTransport) private var transport
    @EnvironmentObject private var session: ConsoleSession
    @State private var text = ""
    @State private var stopFlashing = false
    @FocusState private var focused: Bool

    /// How long Stop stays red for a press: a larger change of state, Motion.slow.
    static let stopFlashSeconds = Motion.slow

    private var inSession: Bool { ConsoleTheme.sessionPhases.contains(phase) }
    private var muted: Bool { phase == .muted }
    private var paused: Bool { phase == .paused }
    private var connecting: Bool { phase == .connecting }
    private var hasText: Bool { !text.trimmingCharacters(in: .whitespaces).isEmpty }

    private var placeholder: String {
        if paused { return "Paused — press Go or type to resume" }
        return inSession ? "Say something…" : "Type to Jarhead…"
    }

    /// The Go/Pause button's spoken name, for accessibility.
    private var transportWord: String {
        switch AppState.transportPress(for: phase) {
        case .go: return "Go"
        case .pause: return "Pause"
        case .stop: return "Connecting — press to stop"
        }
    }

    var body: some View {
        let look = AppState.transportLabel(for: phase)
        VStack(spacing: 0) {
            ConsoleHairline()
            HStack(spacing: 8) {
                Button(action: transport.toggle) {
                    // Go ↔ Pause ↔ "…": the glyph swaps with the symbol replace effect while the
                    // button style crossfades its fill (ConsoleButtonBody animates `kind`).
                    Image(systemName: look.symbol).font(.system(size: 13, weight: .medium))
                        .contentTransition(ConsoleMotion.symbol)
                        // Connecting: the "…" sits back; the press is a stop.
                        .opacity(connecting ? 0.55 : 1)
                        .animation(Motion.fade, value: look.symbol)
                        .animation(Motion.fade, value: connecting)
                }
                .buttonStyle(ConsoleButtonStyle(kind: AppState.transportFilled(for: phase) ? .primary : .ghost, iconOnly: true, height: 32))
                .help(look.help + " (⌘P)")
                .accessibilityLabel(transportWord)

                Button { actions.send(muted ? .unmute : .mute) } label: {
                    Image(systemName: muted ? "mic.slash.fill" : "mic.fill").font(.system(size: 13, weight: .medium))
                        .contentTransition(ConsoleMotion.symbol)
                        .animation(Motion.fade, value: muted)
                }
                .buttonStyle(ConsoleButtonStyle(kind: .ghost, iconOnly: true, height: 32))
                .disabled(!inSession)
                .help(muted ? "Unmute" : "Mute")
                .accessibilityLabel(muted ? "Unmute" : "Mute")

                TextField(placeholder, text: $text)
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

                Button(action: actions.stop) {
                    HStack(spacing: 6) {
                        Image(systemName: "stop.fill").font(.system(size: 10))
                        Text("Stop")
                    }
                }
                .buttonStyle(ConsoleButtonStyle(kind: stopHot || stopFlashing ? .danger : .ghost, height: 32))
                .help("Stop everything — close the session, sleep (⌘.)")
                .accessibilityLabel("Stop")
            }
            .padding(EdgeInsets(top: 8, leading: 12, bottom: 8, trailing: 12))
        }
        .onChange(of: session.composerFocusRequest) { focused = true }
        .onChange(of: session.stopFlash) {
            // The press is felt at once, whatever the engine does with it.
            stopFlashing = true
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: UInt64(Self.stopFlashSeconds * 1_000_000_000))
                stopFlashing = false
            }
        }
    }

    private func submit() {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        actions.send(.sayText(t))
        text = ""
    }
}
