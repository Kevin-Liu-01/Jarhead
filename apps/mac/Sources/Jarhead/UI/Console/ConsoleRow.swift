import SwiftUI

// The Console's list row and what every dense list shares: `ConsoleRow` (28 one line · 40 with a
// meta line · +16 per extra title line · 44 on the agents rail), `ConsoleGroupHead` (22, sticky),
// `ConsoleRowOverflow` (the ⋯ drawn at rest — nothing is revealed under the pointer),
// `ConsoleFocusRing` (the keyboard's one ring), `ConsoleListKeys` + `ConsoleListFocus` (↑↓ ⏎ → ←
// Esc and type-ahead over a list's ids) and `ConsoleListModel` (pure: heights, stepping,
// type-ahead, the memory kinds, the ledger's months — pinned by `check-kit`). A row's verbs are
// one `[ConsoleVerb]` rendered to the context menu, to the ⋯ and to the ⌘↓ float
// (`ConsoleVerbFloat`), so right-click, ⋯ and ⌘↓ always agree. A row's card is A's `ConsoleTipCard`,
// drawn beside the row through `consoleHelp(id:card:edge:)` when the row has an id.
// Canon: tokens only, the accent as the 2 pt selection bar and the focus ring alone, radius 6,
// no shadow; the meter's dither is the one shade the kit carries.

enum ConsoleRowWords {
    /// The ⋯'s name (a glyph, so the tip may say it).
    static let more = "More"
    /// The card's last line before its keycap.
    static let opensPane = "Opens its pane"
    static let returnKey = "⏎"
    /// `2 of 7` in a filter field's trailing slot.
    static func count(shown: Int, of total: Int) -> String { "\(shown) of \(total)" }
    /// The ⌘↓ float's id after the row's; a child verb's title under its parent (`Kind › fact`).
    static let verbsSuffix = ".verbs"
    static let childJoin = " › "
    static let childIdJoin = "/"
    /// The ⌘↓ float's width (the popup's floor).
    static let verbsWidth: CGFloat = 220
    static let verbsListMax: CGFloat = 400
}

// MARK: - Verbs

/// One verb a row offers, rendered to `.contextMenu` and to the ⋯ from the same array (and to the
/// ⌘↓ float when it lands). `children` makes a submenu (Memory › Kind); `checked` marks the current pick.
struct ConsoleVerb: Identifiable {
    var id: String
    var title: String
    var destructive = false
    var disabled = false
    var checked = false
    /// A divider above this verb.
    var separatorBefore = false
    var children: [ConsoleVerb] = []
    var run: () -> Void = {}
}

/// The menu content for a verb array — inside `.contextMenu { }` or a `Menu { }`.
struct ConsoleVerbMenu: View {
    let verbs: [ConsoleVerb]

    var body: some View {
        ForEach(verbs) { verb in
            if verb.separatorBefore { Divider() }
            if verb.children.isEmpty {
                Button(role: verb.destructive ? .destructive : nil, action: verb.run) {
                    if verb.checked { Label(verb.title, systemImage: "checkmark") } else { Text(verb.title) }
                }
                .disabled(verb.disabled)
            } else {
                Menu(verb.title) { ConsoleVerbMenu(verbs: verb.children) }
            }
        }
    }
}

/// The ⌘↓ float: the row's verbs as `ConsoleMenuRow`s in a `.menu` float under the row — the same
/// array the ⋯ and the context menu render, so right-click, ⋯ and ⌘↓ always agree. ↑↓ ⏎ Esc are
/// the popup's (`ConsoleMenuKeys`); a child verb lists as `Kind › fact`, the checked one wearing the bar.
struct ConsoleVerbFloat: ViewModifier {
    let id: String
    let verbs: [ConsoleVerb]
    let open: Bool
    let close: () -> Void

    func body(content: Content) -> some View {
        // Published from a background the row's size, so the float's anchor is the row and its
        // frame tracking never fights the card's (publishers append, so both floats reach the layer).
        content.background {
            Color.clear.consoleFloat(id + ConsoleRowWords.verbsSuffix, kind: .menu, on: open && !verbs.isEmpty, dismiss: close) {
                ConsoleMenuPopup(spec: ConsoleVerbFloatModel.spec(id: id, verbs: verbs, close: close))
            }
        }
    }
}

/// The verbs as a dropdown's spec (pure but for the closures; `flat` is pinned by check-kit).
enum ConsoleVerbFloatModel {
    /// Children under their parent's title, separators dropped: `Edit · Kind › pref · … · Forget`.
    static func flat(_ verbs: [ConsoleVerb]) -> [ConsoleVerb] {
        verbs.flatMap { verb -> [ConsoleVerb] in
            if verb.children.isEmpty { return [verb] }
            return verb.children.map { child in
                var c = child
                c.id = verb.id + ConsoleRowWords.childIdJoin + child.id
                c.title = verb.title + ConsoleRowWords.childJoin + child.title
                return c
            }
        }
    }

    static func spec(id: String, verbs: [ConsoleVerb], close: @escaping () -> Void) -> ConsoleMenuSpec<String> {
        let rows = flat(verbs)
        let byId = Dictionary(rows.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        return ConsoleMenuSpec(id: id + ConsoleRowWords.verbsSuffix, label: ConsoleRowWords.more, current: rows.first { $0.checked }?.id ?? "",
                               options: rows.map(\.id), title: { byId[$0]?.title ?? $0 }, mono: false,
                               badge: nil, badgeColumn: nil, size: nil, detail: nil, meta: nil, metaMono: false,
                               group: nil, groupCount: nil, groupCaption: nil, dim: nil, disabled: { byId[$0]?.disabled ?? false }, loaded: nil, foot: nil,
                               filter: false, filterNoun: "", width: ConsoleRowWords.verbsWidth, listMax: ConsoleRowWords.verbsListMax,
                               pick: { close(); byId[$0]?.run() }, close: close)
    }
}

// MARK: - The row

/// What sits on the icon column: a solid symbol in a tint, or a view of the row's own (a brand mark).
enum ConsoleRowIcon {
    case glyph(String, tint: Color)
    case view(AnyView)

    static func symbol(_ name: String, tint: Color = ConsoleTheme.titanium) -> ConsoleRowIcon { .glyph(name, tint: tint) }
}

/// A small ghost verb before the trailing slot (Restore, Request, Open).
struct ConsoleRowVerb {
    let title: String
    var help: String? = nil
    let run: () -> Void
}

struct ConsoleRow: View {
    enum Trailing {
        case none
        /// The ⋯ at rest; the same verbs feed the context menu.
        case ellipsis([ConsoleVerb])
        case chevron
        case verb(String, () -> Void)
        case glyph(String, Color)
    }

    let title: String
    var lines = 1
    var icon: ConsoleRowIcon? = nil
    var badge: ConsoleBadge.Word? = nil
    var badgeWidth: CGFloat? = nil
    var value: String? = nil
    var meta: String? = nil
    /// 0…1 → the 24 × 6 dithered meter at the meta line's right.
    var meter: Double? = nil
    var trailing: Trailing = .none
    var verb: ConsoleRowVerb? = nil
    var rail: ConsoleListModel.Rail = .right
    /// The title in mono (an id, a path).
    var mono = false
    var selected = false
    /// Drawn by the list for its focused row (keyboard only), never on a click.
    var focused = false
    var open = false
    var sitsBack = false
    var disabled = false
    /// The row's stable id on the float layer: its card's anchor (`memory.<id>`) and its ⌘↓ float's.
    var id: String? = nil
    /// The tier-2 card beside the row (edge .trailing; a right-rail row's lands over the stream).
    var card: ConsoleTipCard? = nil
    /// The list's one glide id for the selection bar.
    var selection: Namespace.ID? = nil
    var accessibilityHint: String? = nil
    var onHover: (Bool) -> Void = { _ in }
    /// The ⌘↓ float is open on this row (the list's `ConsoleListFocus.verbsOpen`); `closeVerbs` lets it go.
    var verbsOpen = false
    var closeVerbs: () -> Void = {}
    let primary: () -> Void

    @State private var hovering = false

    private var verbs: [ConsoleVerb] {
        if case .ellipsis(let verbs) = trailing { return verbs }
        return []
    }

    /// The 20 pt zone the ⋯ or the verb overlay takes; the ghost verb's width beside it (`Resume` needs 58.7 pt).
    static let overflowWidth: CGFloat = 20
    static let verbWidth: CGFloat = 60

    var minHeight: CGFloat { ConsoleListModel.height(lines: lines, meta: meta != nil || meter != nil, rail: rail) }

    var body: some View {
        Button(action: primary) {
            ConsoleRowLabel(row: self)
                .padding(.horizontal, 12)
                .frame(maxWidth: .infinity, minHeight: minHeight, alignment: .leading)
                .background { ConsoleRowGround(selected: selected, hovering: hovering && !disabled, selection: selection) }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(title)
        .accessibilityValue([value, badge.map(ConsoleBadge.text)].compactMap { $0 }.joined(separator: " "))
        .accessibilityHint(accessibilityHint ?? card?.spoken ?? "")
        .accessibilityAddTraits(selected ? .isSelected : [])
        .overlay(alignment: .topTrailing) { ConsoleRowControls(row: self).padding(.top, 4).padding(.trailing, 12) }
        .modifier(ConsoleFocusRing(on: focused))
        .opacity(disabled ? 0.45 : (sitsBack ? 0.62 : 1))
        .contextMenu { if case .ellipsis(let verbs) = trailing { ConsoleVerbMenu(verbs: verbs) } }
        .onHover { hovering = $0; onHover($0) }
        .animation(ConsoleMotion.hover, value: hovering)
        .animation(Motion.snappy, value: selected)
        .modifier(ConsoleRowCardTip(id: id, card: card))
        .modifier(ConsoleVerbFloat(id: id ?? title, verbs: verbs, open: verbsOpen, close: closeVerbs))
    }
}

/// The row's card beside it (tier 2) when it has one; a row without an id anchors on its spoken form.
struct ConsoleRowCardTip: ViewModifier {
    let id: String?
    let card: ConsoleTipCard?

    @ViewBuilder func body(content: Content) -> some View {
        if let card { content.consoleHelp(id: id ?? ConsoleTip.id(for: card.spoken), card: card, edge: .trailing) } else { content }
    }
}

/// The row's ink: icon column, title (+ badge … value, and the inline chevron or glyph), the meta
/// line with the meter. Room is left under the overlay's controls so nothing is displaced.
struct ConsoleRowLabel: View {
    let row: ConsoleRow

    private var titleFont: Font {
        let size: CGFloat = row.rail == .agents ? 13 : 12
        return row.mono ? ConsoleTheme.mono(size, row.open ? .medium : .regular) : ConsoleTheme.sans(size, row.open ? .medium : .regular)
    }

    private var reserved: CGFloat {
        var w: CGFloat = 0
        if row.verb != nil { w += ConsoleRow.verbWidth + 6 }
        switch row.trailing {
        case .ellipsis, .verb: w += ConsoleRow.overflowWidth
        default: break
        }
        return w
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            if let icon = row.icon { ConsoleRowIconView(icon: icon) }
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .top, spacing: 6) {
                    Text(row.title.isEmpty ? "—" : row.title)
                        .font(titleFont).foregroundStyle(ConsoleTheme.fg).lineSpacing(2)
                        .lineLimit(row.lines).truncationMode(.tail)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(minHeight: 20)
                    if let badge = row.badge { ConsoleBadge(word: badge, width: row.badgeWidth).frame(height: 20) }
                    // The stack's 6 pt gaps read as 3 on the Spacer's two sides: `call mum [snoozed] 15:10 [Skip]` fits at 296.
                    Spacer(minLength: 4).padding(.horizontal, -3)
                    if let value = row.value {
                        Text(value).font(ConsoleTheme.mono(11)).monospacedDigit().foregroundStyle(ConsoleTheme.titanium).lineLimit(1).frame(height: 20)
                    }
                    ConsoleRowInlineTrailing(trailing: row.trailing)
                    if reserved > 0 { Color.clear.frame(width: reserved, height: 20) }
                }
                if row.meta != nil || row.meter != nil { ConsoleRowMetaLine(meta: row.meta, meter: row.meter) }
            }
        }
        .padding(.vertical, 4)
    }
}

/// The chevron or the status glyph, drawn in the label (not controls, so not in the overlay).
struct ConsoleRowInlineTrailing: View {
    let trailing: ConsoleRow.Trailing

    var body: some View {
        switch trailing {
        case .chevron:
            Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold)).foregroundStyle(ConsoleTheme.fg3).frame(width: 12, height: 20)
        case .glyph(let name, let tint):
            ConsoleIcon(name: name, tint: tint, size: 11)
        default:
            EmptyView()
        }
    }
}

/// `seen 5× · 12h` in mono fg3, the meter at the right.
struct ConsoleRowMetaLine: View {
    let meta: String?
    let meter: Double?

    var body: some View {
        HStack(alignment: .center, spacing: 6) {
            if let meta {
                Text(meta).font(ConsoleTheme.mono(11)).monospacedDigit().foregroundStyle(ConsoleTheme.fg3)
                    .lineLimit(1).truncationMode(.tail)
                    .contentTransition(ConsoleMotion.numeric)
            }
            Spacer(minLength: 4)
            if let meter {
                DitheredBar(fraction: meter, fill: ConsoleTheme.fg2, track: ConsoleTheme.active)
                    .frame(width: 24, height: DitheredBar.height)
                    .accessibilityLabel(String(format: "%.1f", meter))
            }
        }
        .frame(height: 14)
    }
}

struct ConsoleRowIconView: View {
    let icon: ConsoleRowIcon

    var body: some View {
        switch icon {
        case .glyph(let name, let tint): ConsoleIcon(name: name, tint: tint)
        case .view(let view): view.frame(width: 20, height: 20)
        }
    }
}

/// The controls above the row's button: the ghost verb, then the ⋯ or the trailing verb.
struct ConsoleRowControls: View {
    let row: ConsoleRow

    var body: some View {
        HStack(spacing: 6) {
            if let verb = row.verb {
                Button(verb.title, action: verb.run)
                    .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 20, small: true))
                    .frame(width: ConsoleRow.verbWidth)
                    .consoleHelp(verb.help ?? verb.title)
            }
            switch row.trailing {
            case .ellipsis(let verbs): ConsoleRowOverflow(verbs: verbs)
            case .verb(let title, let run):
                Button(title, action: run).buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 20, small: true))
            default: EmptyView()
            }
        }
        .frame(height: 20)
    }
}

/// The selected row's ground and 2 pt bar (gliding on the list's one id), or the hover.
struct ConsoleRowGround: View {
    let selected: Bool
    let hovering: Bool
    let selection: Namespace.ID?

    var body: some View {
        if selected {
            ZStack(alignment: .leading) {
                Rectangle().fill(ConsoleTheme.active)
                Rectangle().fill(ConsoleTheme.accent).frame(width: 2).padding(.vertical, 4)
            }
            .modifier(ConsoleRowGlide(selection: selection))
        } else if hovering {
            Rectangle().fill(ConsoleTheme.hover)
        }
    }
}

struct ConsoleRowGlide: ViewModifier {
    let selection: Namespace.ID?

    @ViewBuilder func body(content: Content) -> some View {
        if let selection { content.matchedGeometryEffect(id: "console-row-selection", in: selection) } else { content }
    }
}

// MARK: - Group head · overflow · focus ring

/// 22 tall, sticky under `LazyVStack(pinnedViews: [.sectionHeaders])`: a `hairRow` above, the
/// title sans 11 medium titanium, a count, a figure or one badge at the right. Paints `ground`
/// behind itself so the rows it pins over never show through. `folded` non-nil makes it a fold.
struct ConsoleGroupHead: View {
    let title: String
    var count: String? = nil
    var figure: String? = nil
    var badge: ConsoleBadge.Word? = nil
    var folded: Bool? = nil
    var toggle: () -> Void = {}

    var body: some View {
        VStack(spacing: 0) {
            ConsoleHairline(weight: .row)
            if folded != nil {
                Button(action: toggle) { line.contentShape(Rectangle()) }.buttonStyle(.plain)
            } else {
                line
            }
        }
        .background(ConsoleTheme.ground)
        .accessibilityElement(children: .combine)
        .accessibilityLabel([title, count].compactMap { $0 }.joined(separator: ", "))
    }

    private var line: some View {
        HStack(spacing: 6) {
            if let folded {
                Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold)).foregroundStyle(ConsoleTheme.fg3)
                    .rotationEffect(.degrees(folded ? 0 : 90))
                    .frame(width: 12, height: 12)
                    .animation(Motion.snappy, value: folded)
            }
            Text(title).font(ConsoleTheme.sans(11, .medium)).foregroundStyle(ConsoleTheme.titanium).lineLimit(1)
            if let count { Text(count).font(ConsoleTheme.mono(11)).monospacedDigit().foregroundStyle(ConsoleTheme.titanium).contentTransition(ConsoleMotion.numeric) }
            Spacer(minLength: 4)
            if let figure { Text(figure).font(ConsoleTheme.mono(11)).monospacedDigit().foregroundStyle(ConsoleTheme.titanium).lineLimit(1) }
            if let badge { ConsoleBadge(word: badge) }
        }
        .padding(.horizontal, 12)
        .frame(height: 22)
    }
}

/// The ⋯ drawn at rest at fg3, lit to fg2 under the pointer; opens the row's verbs as the
/// system menu (the platform idiom for verbs). Replaces the rails' hover-only `RowOverflow`s.
struct ConsoleRowOverflow: View {
    let verbs: [ConsoleVerb]

    @State private var hovering = false

    var body: some View {
        Menu { ConsoleVerbMenu(verbs: verbs) } label: {
            Image(systemName: "ellipsis").font(.system(size: 13, weight: .medium))
                .foregroundStyle(hovering ? ConsoleTheme.fg2 : ConsoleTheme.fg3)
                .frame(width: ConsoleRow.overflowWidth, height: 20)
                .background(RoundedRectangle(cornerRadius: 6).fill(hovering ? ConsoleTheme.hover : .clear))
                .contentShape(Rectangle())
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .onHover { hovering = $0 }
        .animation(ConsoleMotion.hover, value: hovering)
        .consoleHelp(ConsoleRowWords.more)
        .accessibilityLabel(ConsoleRowWords.more)
    }
}

/// The keyboard's ring: accent 1 pt, inset 2, radius 6 — drawn by a list for its focused row.
struct ConsoleFocusRing: ViewModifier {
    let on: Bool

    func body(content: Content) -> some View {
        content.overlay {
            if on { RoundedRectangle(cornerRadius: 6).stroke(ConsoleTheme.accent, lineWidth: 1).padding(2) }
        }
    }
}

// MARK: - List keys

/// One list's keyboard focus: the focused id, whether the keyboard put it there (the ring shows
/// only then), the type-ahead buffer. Rows read `ringOn(id)`; the filter field and the container
/// both step it, so one highlight has two sources.
@MainActor
final class ConsoleListFocus: ObservableObject {
    @Published var id: String?
    /// True while a key moved the focus; a click clears it, so the ring is the keyboard's alone.
    @Published var keyboard = false
    /// Bumped to hand the container keyboard focus (a row was clicked, the first arrow key).
    @Published private(set) var claims = 0
    /// The row whose verbs are open as the ⌘↓ float; nil at rest.
    @Published var verbsOpen: String?
    private var buffer = ""
    private var typedAt: Double = 0

    /// Letters within this long of each other extend the type-ahead prefix.
    static let typeAheadWindow: Double = 1.0
    /// The harness's ear: every move, printed as `list-focus:` lines. nil in the app.
    @MainActor static var report: ((String) -> Void)?

    func ringOn(_ rowId: String) -> Bool { keyboard && id == rowId }

    func set(_ next: String?, keyboard: Bool, why: String) {
        id = next
        self.keyboard = keyboard
        Self.report?("focus → \(next ?? "nil") (\(why))")
    }

    /// The pointer over a row re-syncs the highlight while the keyboard owns it.
    func hovered(_ rowId: String) {
        if keyboard, id != rowId { id = rowId }
    }

    func claim() { claims += 1 }

    /// ⌘↓ on the focused row: its verbs float; the float closing hands the keys back to the list.
    func openVerbs(_ rowId: String) {
        verbsOpen = rowId
        Self.report?("verbs → \(rowId)")
    }

    func closeVerbs() {
        guard verbsOpen != nil else { return }
        verbsOpen = nil
        claim()
    }

    /// The buffer after `ch`, restarted when the last letter is older than the window.
    func typed(_ ch: Character, now: Double) -> String {
        if now - typedAt > Self.typeAheadWindow { buffer = "" }
        buffer.append(ch)
        typedAt = now
        return buffer
    }
}

/// On a list container: `.focusable()` (its own ring off), ↑↓ move the focus over `ids` (folded
/// groups already left out), ⌥↑↓ / Home / End jump, Return runs the row's primary, → / ← open
/// and fold a head, ⌘↓ opens the focused row's verbs as a float, letters type ahead on titles when
/// no filter owns them, Esc clears the filter (else drops focus), Space does nothing — never a yes.
struct ConsoleListKeys: ViewModifier {
    @ObservedObject var focus: ConsoleListFocus
    let ids: [String]
    var heads: Set<String> = []
    var title: (String) -> String = { $0 }
    var typeAhead = true
    let primary: (String) -> Void
    var fold: (String, Bool) -> Void = { _, _ in }
    var escape: () -> Void = {}

    @FocusState private var focused: Bool

    func body(content: Content) -> some View {
        content
            .focusable()
            .focusEffectDisabled()
            .focused($focused)
            .onKeyPress(phases: .down) { press in handle(press) }
            .onChange(of: focus.claims) { focused = true }
            .onReceive(NotificationCenter.default.publisher(for: ConsoleSession.previewNotification), perform: highlight)
    }

    /// `highlight:<id>` (the harness): the ring lands on that row and the list takes the keys.
    private func highlight(_ note: Notification) {
        guard let id = note.userInfo?[ConsolePreviewKey.highlight] as? String, ids.contains(id) else { return }
        focus.set(id, keyboard: true, why: "highlight")
        focused = true
    }

    private func handle(_ press: KeyPress) -> KeyPress.Result {
        let key = ConsoleListModel.key(press.key, characters: press.characters)
        let command = ConsoleListModel.command(key, option: press.modifiers.contains(.option), command: press.modifiers.contains(.command), typeAhead: typeAhead)
        switch command {
        case .ignore: return .ignored
        case .swallow: break
        case .step(let delta): move(to: ConsoleListModel.step(focus.id, by: delta, in: ids), why: delta > 0 ? "down" : "up")
        case .jump(let toEnd): move(to: toEnd ? ids.last : ids.first, why: toEnd ? "end" : "home")
        case .primary: if let id = focus.id { primary(id) }
        case .fold(let open): if let id = focus.id, heads.contains(id) { fold(id, open) }
        case .verbs: if let id = focus.id { focus.openVerbs(id) }
        case .escape: escape()
        case .type(let ch):
            let prefix = focus.typed(ch, now: ConsoleFormat.nowMs / 1000)
            move(to: ConsoleListModel.typeAhead(ids, title: title, prefix: prefix, after: focus.id), why: "type '\(prefix)'")
        }
        return .handled
    }

    private func move(to id: String?, why: String) {
        guard let id else { return }
        focus.set(id, keyboard: true, why: why)
    }
}

extension View {
    func consoleListKeys(_ keys: ConsoleListKeys) -> some View { modifier(keys) }
}

// MARK: - The pure model (check-kit)

enum ConsoleListModel {
    /// Which rail's rhythm: the right rail's 28 / 40, the agents rail's 44.
    enum Rail { case right, agents }

    /// 28 one line · 40 with a meta line · +16 per extra title line; the agents rail 44 (+16 per extra line).
    static func height(lines: Int, meta: Bool, rail: Rail = .right) -> CGFloat {
        let extra = CGFloat(max(0, lines - 1)) * 16
        switch rail {
        case .right: return (meta ? 40 : 28) + extra
        case .agents: return 44 + extra
        }
    }

    /// Clamped, no wrap; nothing focused → the first (down) or the last (up).
    static func step<ID: Equatable>(_ current: ID?, by delta: Int, in ids: [ID]) -> ID? {
        guard !ids.isEmpty else { return nil }
        guard let current, let i = ids.firstIndex(of: current) else { return delta >= 0 ? ids.first : ids.last }
        return ids[min(max(i + delta, 0), ids.count - 1)]
    }

    /// The first title with `prefix` after `after`, then from the top (a wrap); nil when none.
    static func typeAhead<ID: Equatable>(_ ids: [ID], title: (ID) -> String, prefix: String, after: ID?) -> ID? {
        let p = prefix.lowercased()
        guard !p.isEmpty, !ids.isEmpty else { return nil }
        let start = after.flatMap { ids.firstIndex(of: $0) }.map { $0 + 1 } ?? 0
        let order = Array(ids[min(start, ids.count)...]) + Array(ids[..<min(start, ids.count)])
        return order.first { title($0).lowercased().hasPrefix(p) }
    }

    /// `22` at rest, `2 of 22` while typing — the dropdown's spelling (`ConsoleMenuModel`), one rule for both lists.
    static func countWord(shown: Int, of total: Int, typing: Bool) -> String {
        ConsoleMenuModel.countWord(shown: shown, of: total, typing: typing)
    }

    // MARK: memory kinds

    struct KindCount: Equatable {
        let kind: MemoryKind
        let count: Int
    }

    /// The kinds the rows carry with their counts, in first-seen order; a kind with no row is absent.
    static func memoryKinds(_ items: [MemoryItem]) -> [KindCount] {
        var order: [MemoryKind] = []
        var counts: [MemoryKind: Int] = [:]
        for item in items {
            if counts[item.kind] == nil { order.append(item.kind) }
            counts[item.kind, default: 0] += 1
        }
        return order.map { KindCount(kind: $0, count: counts[$0] ?? 0) }
    }

    // MARK: ledger months

    struct Month: Identifiable, Equatable {
        /// `2026-09`
        let id: String
        /// `September` · `December 2025` (the year only when it is not this one).
        let title: String
        /// The month's days in the list's order (newest first).
        let days: [String]
    }

    private static let monthName: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "MMMM"
        return f
    }()

    /// `yyyy-MM-dd` days (newest first) folded into months in first-seen order.
    static func ledgerMonths(_ days: [String], now: Date = Date()) -> [Month] {
        let thisYear = Calendar.current.component(.year, from: now)
        var order: [String] = []
        var map: [String: [String]] = [:]
        for day in days {
            let key = String(day.prefix(7))
            if map[key] == nil { order.append(key) }
            map[key, default: []].append(day)
        }
        return order.map { key in
            let parts = key.split(separator: "-").compactMap { Int($0) }
            var title = key
            if parts.count == 2, let date = Calendar.current.date(from: DateComponents(year: parts[0], month: parts[1], day: 1)) {
                title = monthName.string(from: date) + (parts[0] == thisYear ? "" : " \(parts[0])")
            }
            return Month(id: key, title: title, days: map[key] ?? [])
        }
    }

    // MARK: keys

    enum Key: Equatable { case up, down, left, right, home, end, `return`, escape, space, char(Character), other }

    enum Command: Equatable {
        case ignore, swallow
        case step(Int)
        case jump(toEnd: Bool)
        case primary
        case fold(open: Bool)
        /// ⌘↓: the focused row's verbs as a float.
        case verbs
        case escape
        case type(Character)
    }

    /// SwiftUI's key → the list's; letters only when no modifier reshapes them.
    static func key(_ k: KeyEquivalent, characters: String) -> Key {
        switch k {
        case .upArrow: return .up
        case .downArrow: return .down
        case .leftArrow: return .left
        case .rightArrow: return .right
        case .home: return .home
        case .end: return .end
        case .return: return .return
        case .escape: return .escape
        case .space: return .space
        default:
            if characters.count == 1, let ch = characters.first, ch.isLetter || ch.isNumber { return .char(ch) }
            return .other
        }
    }

    /// The list's answer to a key: ⌘↓ opens the row's verbs, every other ⌘ is the window's; ⌥↑↓ jump; Space never says yes.
    static func command(_ key: Key, option: Bool, command: Bool, typeAhead: Bool) -> Command {
        if command { return key == .down ? .verbs : .ignore }
        switch key {
        case .up: return option ? .jump(toEnd: false) : .step(-1)
        case .down: return option ? .jump(toEnd: true) : .step(1)
        case .home: return .jump(toEnd: false)
        case .end: return .jump(toEnd: true)
        case .return: return .primary
        case .right: return .fold(open: true)
        case .left: return .fold(open: false)
        case .escape: return .escape
        case .space: return .swallow
        case .char(let ch): return typeAhead ? .type(ch) : .ignore
        case .other: return .ignore
        }
    }
}
