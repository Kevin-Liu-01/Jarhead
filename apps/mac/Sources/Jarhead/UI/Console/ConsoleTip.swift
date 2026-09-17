import SwiftUI

// The Console's tooltip, drawn on the window's own float layer (`ConsoleFloatLayer`) — never a
// system tooltip window. Three tiers: a line (words + a keycap), a card (a row's whole story) and
// a preview (a thumb's picture). One rule of timing: the pointer rests 350 ms; within 400 ms of
// the last hide a tip shows at once and a warm re-anchor is a jump, not a re-appear. `?` on a
// focused control pins its tip. Every trigger keeps what `.help` gave VoiceOver: the spoken form
// goes on `.accessibilityHint`; the bubble itself is hidden and never hit-tested. No file in
// UI/Console or UI/Onboarding uses the system tooltip modifier.

enum ConsoleTipWords {
    static let opensPane = "Opens its pane"
    static let returnKey = "⏎"
    static let escKey = "Esc"
    static let question = "?"
    static let started = "started"
    static let lane = "lane"
    static let steps = "steps"
    static let budget = "budget"
    static let turns = "turns"
    static let turn = "turn"
    static let id = "id"
    static let live = "live"
    static let created = "created"
    static let daemon = "daemon"
    static let connected = "Connected"
    static let disconnected = "Disconnected"
    static let sessions = "sessions"
    static let session = "session"
    static let asks = "asks"
    static let closed = "closed"
    static let neverClosed = "never closed"
    static let billed = "billed"
    static let messages = "messages"
    static let delegations = "delegations"
    static let delegation = "delegation"
    static let crashed = "Crashed"
    static let report = "report"
    static let idPrefix = "tip."
    static let dot = " · "
    static let arrow = " → "
    static let stepsOver = " steps / "
    static let seconds = " s"
    static let spokenJoin = ", "
}

enum ConsoleTip {
    /// The pointer rests this long before a tip shows.
    static let delay: Double = 0.35
    /// A tip within this long of the last hide shows at once.
    static let warm: Double = 0.40
    /// A float arrives from the anchor's side by this much.
    static let rise: CGFloat = 4
    /// When the last tip hid (seconds on the same clock the trigger reads); −1 = never.
    @MainActor static var lastHiddenAt: Double = -1
    /// The harness pins the delay (0 in every shot but `tip-warm`); nil in the app.
    @MainActor static var delayOverride: Double?
    /// The harness's ear: `armed <id> <delay>` · `shown <id> after <ms> ms` · `hidden <id>` · `pinned <id>`.
    @MainActor static var report: ((String) -> Void)?

    /// Pure: warm → 0, else `delay`. `sinceLastHide` < 0 means no tip has hidden yet.
    static func delay(sinceLastHide: Double) -> Double {
        sinceLastHide >= 0 && sinceLastHide < warm ? 0 : delay
    }

    /// A stable id for a tier-1 tip without one: the words, hashed the same way every run.
    static func id(for text: String) -> String {
        var h: UInt32 = 5381
        for b in text.utf8 { h = (h &* 33) &+ UInt32(b) }
        return ConsoleTipWords.idPrefix + String(h, radix: 16)
    }

    static func now() -> Double { Date().timeIntervalSince1970 }

    /// Pin the tip with that id (a list that owns focus posts this on `?` for its focused row).
    @MainActor static func pin(_ id: String) {
        NotificationCenter.default.post(name: ConsoleSession.previewNotification, object: nil, userInfo: [ConsolePreviewKey.tipOpen: id])
    }
}

// MARK: - The card (tier 2), a value a row builds in a static func

struct ConsoleTipCard: Equatable {
    struct Row: Equatable {
        let key: String
        let value: String
    }

    var title: String
    var badge: ConsoleBadge.Word? = nil
    var status: String? = nil
    var lines: [String] = []
    var foot: [Row] = []
    /// The last line: words + a keycap (`Opens its pane ⏎`).
    var last: Row? = nil

    init(title: String, badge: ConsoleBadge.Word? = nil, status: String? = nil, lines: [String] = [],
         foot: [(String, String)] = [], last: (String, String)? = nil) {
        self.title = title
        self.badge = badge
        self.status = status
        self.lines = lines.filter { !$0.isEmpty }
        self.foot = foot.map { Row(key: $0.0, value: $0.1) }
        self.last = last.map { Row(key: $0.0, value: $0.1) }
    }

    /// What VoiceOver hears: every line, joined with ", ".
    var spoken: String {
        var parts = [title]
        if let badge { parts.append(ConsoleBadge.text(badge)) }
        if let status { parts.append(status) }
        parts.append(contentsOf: lines)
        parts.append(contentsOf: foot.map { "\($0.key) \($0.value)" })
        if let last { parts.append("\(last.key) \(last.value)") }
        return parts.joined(separator: ConsoleTipWords.spokenJoin)
    }
}

/// The card shapes the migration names, built once here so the same thread is one card
/// wherever it is hovered (the stream's chip, the right rail's row, the left rail's row).
extension ConsoleTipCard {
    /// `Slack [asks] · the ask · the task / started · lane · steps · budget / Opens its pane ⏎`.
    static func thread(_ t: WorkThread) -> ConsoleTipCard {
        let meta = ConsoleTheme.thread(t.status)
        let asks = t.status == .waitingKevin
        return ConsoleTipCard(title: t.name, badge: asks ? .asks : nil, status: asks ? nil : meta.label,
                              lines: [t.question ?? "", t.task, asks ? "" : (t.detail ?? "")],
                              foot: [(ConsoleTipWords.started, ConsoleFormat.time(t.startedAt)),
                                     (ConsoleTipWords.lane, ConsoleTheme.lane(t.lane)),
                                     (ConsoleTipWords.steps, "\(t.steps)" + ConsoleTipWords.dot + turns(t.turns)),
                                     (ConsoleTipWords.budget, "\(t.budget.steps)" + ConsoleTipWords.stepsOver + "\(t.budget.seconds)" + ConsoleTipWords.seconds)],
                              last: (ConsoleTipWords.opensPane, ConsoleTipWords.returnKey))
    }

    /// The thread's figures whole, for a header line: `started 14:37 · 1 turn · budget 25 steps / 180 s`.
    static func threadMetaLine(_ t: WorkThread) -> String {
        [ConsoleTipWords.started + " " + ConsoleFormat.time(t.startedAt), turns(t.turns),
         ConsoleTipWords.budget + " \(t.budget.steps)" + ConsoleTipWords.stepsOver + "\(t.budget.seconds)" + ConsoleTipWords.seconds]
            .joined(separator: ConsoleTipWords.dot)
    }

    static func turns(_ n: Int) -> String { "\(n) " + (n == 1 ? ConsoleTipWords.turn : ConsoleTipWords.turns) }

    /// The delegation card's head: the request whole, then `id · live · created`.
    static func delegation(_ d: Delegation) -> ConsoleTipCard {
        ConsoleTipCard(title: d.request, status: ConsoleTheme.delegation(d.status).label,
                       foot: [(ConsoleTipWords.id, d.id), (ConsoleTipWords.live, d.liveId),
                              (ConsoleTipWords.created, ConsoleFormat.fullDate(d.createdAt))])
    }

    /// The connection dot: `Connected` with the daemon's detail in mono.
    static func connection(connected: Bool, detail: String) -> ConsoleTipCard {
        ConsoleTipCard(title: connected ? ConsoleTipWords.connected : ConsoleTipWords.disconnected,
                       foot: detail.isEmpty ? [] : [(ConsoleTipWords.daemon, detail)])
    }

    /// A chain's sessions: `3 sessions / a → b → c`.
    static func chain(sessionIds: [String]) -> ConsoleTipCard {
        let n = sessionIds.count
        return ConsoleTipCard(title: "\(n) " + (n == 1 ? ConsoleTipWords.session : ConsoleTipWords.sessions),
                              lines: [sessionIds.map { ConsoleFormat.shortId($0) }.joined(separator: ConsoleTipWords.arrow)])
    }

    /// A question a thread or session is asking, whole, with its detail under it.
    static func question(name: String, question: String, detail: String? = nil) -> ConsoleTipCard {
        ConsoleTipCard(title: name + " " + ConsoleTipWords.asks, lines: [question, detail ?? ""])
    }

    /// A path on one line, whole (a session's cwd, a data path).
    static func path(title: String, path: String) -> ConsoleTipCard {
        ConsoleTipCard(title: title, lines: [path])
    }

    /// The previous run's crash (`AppState.lastCrash`): the reason whole, the report's path.
    static func crash(reason: String, at: String, report: String?) -> ConsoleTipCard {
        ConsoleTipCard(title: ConsoleTipWords.crashed, status: at, lines: [reason],
                       foot: report.map { [(ConsoleTipWords.report, ConsoleFormat.truncPath($0, max: 40))] } ?? [])
    }
}

// MARK: - The modifier: hover → arm → a .tip float; `?` pins; the spoken form for VoiceOver

struct ConsoleTipModifier<Card: View>: ViewModifier {
    let id: String
    let edge: ConsoleFloat.Edge
    let spoken: String
    /// `?` pins and `focus:<id>` lands here — only a trigger with an id of its own opts in.
    let keys: Bool
    let card: () -> Card

    @State private var shown = false
    @State private var pinned = false
    @State private var warm = false
    @State private var waiting: Task<Void, Never>?

    func body(content: Content) -> some View {
        keyed(content)
            .onHover(perform: hover)
            .consoleFloat(id, kind: .tip, edge: edge, on: shown || pinned, dismiss: hide) {
                ConsoleTipBubble(warm: warm, content: card)
            }
            .accessibilityHint(spoken)
            .onReceive(NotificationCenter.default.publisher(for: ConsoleSession.previewNotification), perform: receive)
            .onDisappear { cancel(); if shown || pinned { hide() } }
    }

    @ViewBuilder private func keyed(_ content: Content) -> some View {
        if keys { content.modifier(ConsoleTipKeys(id: id, pinned: $pinned)) } else { content }
    }

    private func hover(_ inside: Bool) {
        if inside { arm() } else { cancel(); if shown { hide() } }
    }

    /// The pointer rests: wait the delay, then show; no delay (warm, or the harness's 0) shows
    /// at once, on this very pass — never a run-loop hop later. Warm is read from the clock, not
    /// the override, so the harness's pinned 0 still tells a jump from an arrival.
    private func arm() {
        guard !shown, !pinned, waiting == nil else { return }
        let since = ConsoleTip.lastHiddenAt < 0 ? -1 : ConsoleTip.now() - ConsoleTip.lastHiddenAt
        let wait = ConsoleTip.delayOverride ?? ConsoleTip.delay(sinceLastHide: since)
        warm = ConsoleTip.delay(sinceLastHide: since) == 0
        ConsoleTip.report?("armed \(id) \(wait)")
        guard wait > 0 else { show(armedAt: ConsoleTip.now()); return }
        let armedAt = ConsoleTip.now()
        waiting = Task { @MainActor in
            try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
            guard !Task.isCancelled else { return }
            waiting = nil
            show(armedAt: armedAt)
        }
    }

    private func show(armedAt: Double) {
        shown = true
        ConsoleTip.report?(String(format: "shown %@ after %.0f ms", id, (ConsoleTip.now() - armedAt) * 1000))
    }

    private func cancel() {
        waiting?.cancel()
        waiting = nil
    }

    private func hide() {
        shown = false
        pinned = false
        ConsoleTip.lastHiddenAt = ConsoleTip.now()
        ConsoleTip.report?("hidden \(id)")
    }

    /// `tipOpen:<id>` pins; `hover:<id>` / `leave:<id>` move the pointer (the harness's hands).
    private func receive(_ note: Notification) {
        guard let info = note.userInfo else { return }
        if info[ConsolePreviewKey.tipOpen] as? String == id { warm = false; pinned = true; ConsoleTip.report?("pinned \(id)") }
        if info[ConsolePreviewKey.hover] as? String == id { hover(true) }
        if info[ConsolePreviewKey.leave] as? String == id { hover(false) }
    }
}

/// `?` on the focused trigger pins its tip; Esc, a focus move or any other key lets go. The
/// trigger becomes focusable with a keyboard-only accent ring (the one key ring on screen):
/// `.activate` interactions, so Tab and `focus:<id>` land here and a mouse click never does —
/// the click runs the control's action and lights no ring.
struct ConsoleTipKeys: ViewModifier {
    let id: String
    @Binding var pinned: Bool
    @FocusState private var focused: Bool

    func body(content: Content) -> some View {
        content
            .focusable(interactions: .activate)
            .focused($focused)
            .focusEffectDisabled()
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(ConsoleTheme.accent, lineWidth: 1).opacity(focused ? 1 : 0))
            .onKeyPress(phases: .down, action: key)
            .onChange(of: focused) { if !focused { pinned = false } }
            .onReceive(NotificationCenter.default.publisher(for: ConsoleSession.previewNotification)) { note in
                if note.userInfo?[ConsolePreviewKey.focus] as? String == id { focused = true }
            }
    }

    private func key(_ press: KeyPress) -> KeyPress.Result {
        if press.characters == ConsoleTipWords.question { pinned = true; ConsoleTip.report?("pinned \(id) by ?"); return .handled }
        guard pinned else { return .ignored }
        pinned = false
        return press.key == .escape ? .handled : .ignored
    }
}

// MARK: - The bubble: raised · hair · r 6 · a 2 pt seam · the arrow in the outline

struct ConsoleTipBubble<C: View>: View {
    /// A warm re-anchor is a position change, not a re-appear: no arrival at all.
    let warm: Bool
    @ViewBuilder let content: () -> C
    @Environment(\.consoleFloatGeometry) private var geometry
    @State private var arrived = false

    var body: some View {
        let outline = ConsoleTipOutline(side: geometry.side, arrow: geometry.arrowOffset)
        content()
            .padding(Self.arrowEdge(geometry.side), ConsoleFloatPlacement.arrowHeight)
            .background(outline.fill(ConsoleTheme.raised))
            .overlay(outline.stroke(ConsoleTheme.hair, lineWidth: 1))
            .background(outline.stroke(ConsoleTheme.ground, lineWidth: ConsoleTheme.seam * 2))
            .opacity(arrived ? 1 : 0)
            .offset(Self.riseOffset(geometry.side, arrived: arrived))
            .onAppear(perform: arrive)
    }

    private func arrive() {
        if warm { arrived = true; return }
        let fade = Animation.easeOut(duration: Motion.reduced ? Motion.instant : Motion.quick)
        withAnimation(fade) { arrived = true }
    }

    static func arrowEdge(_ side: ConsoleFloatPlacement.Side) -> Edge.Set {
        switch side {
        case .below: return .top
        case .above: return .bottom
        case .trailing: return .leading
        case .leading: return .trailing
        }
    }

    /// Arrives from the anchor's side by `rise`; a fade only under Reduce Motion.
    static func riseOffset(_ side: ConsoleFloatPlacement.Side, arrived: Bool) -> CGSize {
        guard !arrived, !Motion.reduced else { return .zero }
        switch side {
        case .below: return CGSize(width: 0, height: -ConsoleTip.rise)
        case .above: return CGSize(width: 0, height: ConsoleTip.rise)
        case .trailing: return CGSize(width: -ConsoleTip.rise, height: 0)
        case .leading: return CGSize(width: ConsoleTip.rise, height: 0)
        }
    }
}

/// One path: the rounded box and its arrow (8 × 4) on the edge that faces the anchor, its tip
/// at `arrow` along that edge. The arrow lives inside the frame's 4 pt strip on that side, so
/// the placement's gap is what shows between the tip and the anchor.
struct ConsoleTipOutline: Shape {
    let side: ConsoleFloatPlacement.Side
    let arrow: CGFloat

    func path(in rect: CGRect) -> Path {
        let w = ConsoleFloatPlacement.arrowWidth / 2, r = ConsoleFloatPlacement.radius
        let box = Self.box(rect, side: side)
        var p = Path()
        p.move(to: CGPoint(x: box.minX + r, y: box.minY))
        if side == .below { Self.tooth(&p, [CGPoint(x: rect.minX + arrow - w, y: box.minY), CGPoint(x: rect.minX + arrow, y: rect.minY), CGPoint(x: rect.minX + arrow + w, y: box.minY)]) }
        p.addArc(tangent1End: CGPoint(x: box.maxX, y: box.minY), tangent2End: CGPoint(x: box.maxX, y: box.minY + r), radius: r)
        if side == .leading { Self.tooth(&p, [CGPoint(x: box.maxX, y: rect.minY + arrow - w), CGPoint(x: rect.maxX, y: rect.minY + arrow), CGPoint(x: box.maxX, y: rect.minY + arrow + w)]) }
        p.addArc(tangent1End: CGPoint(x: box.maxX, y: box.maxY), tangent2End: CGPoint(x: box.maxX - r, y: box.maxY), radius: r)
        if side == .above { Self.tooth(&p, [CGPoint(x: rect.minX + arrow + w, y: box.maxY), CGPoint(x: rect.minX + arrow, y: rect.maxY), CGPoint(x: rect.minX + arrow - w, y: box.maxY)]) }
        p.addArc(tangent1End: CGPoint(x: box.minX, y: box.maxY), tangent2End: CGPoint(x: box.minX, y: box.maxY - r), radius: r)
        if side == .trailing { Self.tooth(&p, [CGPoint(x: box.minX, y: rect.minY + arrow + w), CGPoint(x: rect.minX, y: rect.minY + arrow), CGPoint(x: box.minX, y: rect.minY + arrow - w)]) }
        p.addArc(tangent1End: CGPoint(x: box.minX, y: box.minY), tangent2End: CGPoint(x: box.minX + r, y: box.minY), radius: r)
        p.closeSubpath()
        return p
    }

    /// The box the words sit in: the frame less the arrow's strip on the facing side.
    static func box(_ rect: CGRect, side: ConsoleFloatPlacement.Side) -> CGRect {
        let h = ConsoleFloatPlacement.arrowHeight
        switch side {
        case .below: return CGRect(x: rect.minX, y: rect.minY + h, width: rect.width, height: rect.height - h)
        case .above: return CGRect(x: rect.minX, y: rect.minY, width: rect.width, height: rect.height - h)
        case .trailing: return CGRect(x: rect.minX + h, y: rect.minY, width: rect.width - h, height: rect.height)
        case .leading: return CGRect(x: rect.minX, y: rect.minY, width: rect.width - h, height: rect.height)
        }
    }

    private static func tooth(_ p: inout Path, _ points: [CGPoint]) { points.forEach { p.addLine(to: $0) } }
}

// MARK: - The three faces

/// Tier 1: words sans 12 fg and the shortcut as a keycap, 28 tall, pad 6 / 8.
struct ConsoleTipLine: View {
    let text: String
    var key: String? = nil

    var body: some View {
        HStack(spacing: 6) {
            Text(text).font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg).lineLimit(1)
            if let key { ConsoleKeyCap(key: key) }
        }
        .padding(.horizontal, 8)
        .frame(height: 28)
    }
}

/// Tier 2: title + one badge or a status word · ≤ 2 lines · hairRow · foot rows · the last line.
struct ConsoleTipCardView: View {
    let card: ConsoleTipCard

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(card.title).font(ConsoleTheme.sans(12, .medium)).foregroundStyle(ConsoleTheme.fg).lineLimit(2)
                if let badge = card.badge { ConsoleBadge(word: badge) }
                if let status = card.status { Text(status).font(ConsoleTheme.sans(11)).foregroundStyle(ConsoleTheme.fg3).lineLimit(1) }
            }
            ForEach(Array(card.lines.enumerated()), id: \.offset) { _, line in
                Text(line).font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg2).lineLimit(2)
            }
            if !card.foot.isEmpty || card.last != nil { ConsoleTipCardFoot(card: card) }
        }
        .padding(EdgeInsets(top: 8, leading: 10, bottom: 8, trailing: 10))
        .frame(minWidth: 240, maxWidth: 320, alignment: .leading)
    }
}

struct ConsoleTipCardFoot: View {
    let card: ConsoleTipCard

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ConsoleHairline(weight: .row).padding(.vertical, 2)
            ForEach(Array(card.foot.enumerated()), id: \.offset) { _, row in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(row.key).font(ConsoleTheme.sans(11)).foregroundStyle(ConsoleTheme.titanium).frame(width: 64, alignment: .leading)
                    Text(row.value).font(ConsoleTheme.mono(11)).foregroundStyle(ConsoleTheme.fg2).lineLimit(1)
                }
            }
            if let last = card.last {
                HStack(spacing: 6) {
                    Text(last.key).font(ConsoleTheme.sans(11)).foregroundStyle(ConsoleTheme.fg3)
                    ConsoleKeyCap(key: last.value)
                }
                .padding(.top, 2)
            }
        }
    }
}

/// Tier 3: a title, a ≤ 160 × 100 picture in `hairFrame` (a skeleton until the crop) and a mono line.
struct ConsoleTipPreview: View {
    let title: String
    var subtitle: String? = nil
    let url: URL
    var meta: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(title).font(ConsoleTheme.sans(12, .medium)).foregroundStyle(ConsoleTheme.fg).lineLimit(1)
                if let subtitle { Text(subtitle).font(ConsoleTheme.mono(11)).foregroundStyle(ConsoleTheme.fg3).lineLimit(1) }
            }
            ScreenshotThumb(url: url, onTap: {}, width: 160)
            if let meta { Text(meta).font(ConsoleTheme.mono(11)).foregroundStyle(ConsoleTheme.titanium).lineLimit(1) }
        }
        .padding(EdgeInsets(top: 8, leading: 10, bottom: 8, trailing: 10))
    }

    /// `14:37 · 1.2 MB` for the file at `url` (its modification time and size); nil when unreadable.
    static func fileMeta(_ url: URL) -> String? {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path) else { return nil }
        var parts: [String] = []
        if let date = attrs[.modificationDate] as? Date { parts.append(ConsoleFormat.time(date.timeIntervalSince1970 * 1000)) }
        if let size = attrs[.size] as? NSNumber { parts.append(ByteCountFormatter.string(fromByteCount: size.int64Value, countStyle: .file)) }
        return parts.isEmpty ? nil : parts.joined(separator: ConsoleTipWords.dot)
    }
}

extension View {
    /// Tier 1: one line on a control, the shortcut last as a keycap. An `id` makes the control
    /// focusable so `?` can pin its tip (and the harness can `focus:` it).
    func consoleHelp(_ text: String, key: String? = nil, id: String? = nil) -> some View {
        modifier(ConsoleTipModifier(id: id ?? ConsoleTip.id(for: text), edge: .below, spoken: key.map { "\(text) (\($0))" } ?? text, keys: id != nil) {
            ConsoleTipLine(text: text, key: key)
        })
    }

    /// Tier 1 from the words table.
    func consoleHelp(_ entry: HelpCopy.Entry, id: String? = nil) -> some View {
        consoleHelp(entry.hint, key: entry.key, id: id)
    }

    /// Tier 2: a row's card, beside the row by default (a right-rail row's card lands over the stream).
    func consoleHelp(id: String, card: ConsoleTipCard, edge: ConsoleFloat.Edge = .trailing) -> some View {
        modifier(ConsoleTipModifier(id: id, edge: edge, spoken: card.spoken, keys: false) { ConsoleTipCardView(card: card) })
    }

    /// Tier 3: a thumb's preview; `spoken` is what VoiceOver hears in its place.
    func consoleHelp<C: View>(id: String, spoken: String, edge: ConsoleFloat.Edge = .below, @ViewBuilder preview: @escaping () -> C) -> some View {
        modifier(ConsoleTipModifier(id: id, edge: edge, spoken: spoken, keys: false, card: preview))
    }
}
