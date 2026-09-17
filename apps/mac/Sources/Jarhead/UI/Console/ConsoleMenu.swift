import SwiftUI
import AppKit

// The Console's dropdown, rebuilt on the float layer. `ConsoleMenuField` keeps its name and its
// first seven parameters (every call site compiles unchanged); everything new is optional and
// lights up per site. The field is a `ground` box with the value, one badge and a chevron; the
// popup is a `.menu` float at the root — filter past eight rows, groups, a badge column, the 2 pt
// bar on the pick, `lift` on the highlight, ↑↓ ⏎ Esc and type-ahead, and a foot that says the
// highlighted row's whole sentence. Nothing here opens a window. Every struct is small and every
// body short: the CI runner's older Swift gives up on large expressions.

/// A saved value outside `options` and where it came from: appended under `Saved, not listed`.
struct ConsoleMenuSaved<Value: Hashable> {
    let value: Value
    let provenance: String
}

/// The field's closures bundled, so the popup's signature stays one parameter.
struct ConsoleMenuSpec<Value: Hashable> {
    let id: String
    let label: String
    let current: Value
    let options: [Value]
    let title: (Value) -> String
    let mono: Bool
    let badge: ((Value) -> [ConsoleBadge.Word])?
    let badgeColumn: CGFloat?
    let size: ((Value) -> String)?
    let detail: ((Value) -> String)?
    let meta: ((Value) -> String)?
    let metaMono: Bool
    let group: ((Value) -> String)?
    let groupCount: ((String) -> String?)?
    let groupCaption: ((String) -> String?)?
    let dim: ((Value) -> Bool)?
    let disabled: ((Value) -> Bool)?
    let loaded: ((Value) -> Bool)?
    let foot: ((Value) -> String?)?
    let filter: Bool
    let filterNoun: String
    let width: CGFloat
    let listMax: CGFloat
    let pick: (Value) -> Void
    let close: () -> Void

    var twoLine: Bool { meta != nil }
    func isDisabled(_ v: Value) -> Bool { disabled?(v) ?? false }
    func isDim(_ v: Value) -> Bool { dim?(v) ?? false }
    func isLoaded(_ v: Value) -> Bool { loaded?(v) ?? false }
    func badges(_ v: Value) -> [ConsoleBadge.Word] { badge?(v) ?? [] }
    func sections(_ query: String) -> [ConsoleMenuModel.Section<Value>] {
        ConsoleMenuModel.sections(options, group: group, title: title, detail: detail, query: query)
    }
}

/// A picker drawn as a field: value, one badge, chevron, hairline box; the popup lists the options.
/// `fieldTitle` is the collapsed label when the full title is too long for the field; `dim` names
/// the options drawn quiet (a model that does not fit this Mac) — still pickable.
struct ConsoleMenuField<Value: Hashable>: View {
    let value: Value
    let options: [Value]
    let title: (Value) -> String
    let pick: (Value) -> Void
    var mono = false
    var fieldTitle: ((Value) -> String)? = nil
    var dim: ((Value) -> Bool)? = nil
    // new — every one optional
    /// Stable per site ("settings.voice", "setup.brain"): the harness opens it by this name.
    var id = "menu"
    /// The row key → accessibilityLabel.
    var label: String? = nil
    var fieldBadge: ((Value) -> ConsoleBadge.Word?)? = nil
    /// The field's value drawn fg3: a placeholder, a saved id the server no longer lists.
    var fieldQuiet: ((Value) -> Bool)? = nil
    var badge: ((Value) -> [ConsoleBadge.Word])? = nil
    /// Fixed width of the LAST badge so a column aligns (fit 62).
    var badgeColumn: CGFloat? = nil
    /// mono 11 titanium column.
    var size: ((Value) -> String)? = nil
    /// sans 11 fg3 column (words).
    var detail: ((Value) -> String)? = nil
    /// Line 2 → rows are 40.
    var meta: ((Value) -> String)? = nil
    var metaMono = true
    var group: ((Value) -> String)? = nil
    var groupCount: ((String) -> String?)? = nil
    var groupCaption: ((String) -> String?)? = nil
    /// Listed at 0.45 with a badge that says why; skipped by ↑↓; not pickable.
    var disabled: ((Value) -> Bool)? = nil
    var loaded: ((Value) -> Bool)? = nil
    /// The highlighted row's sentence, in the foot.
    var foot: ((Value) -> String?)? = nil
    var saved: ConsoleMenuSaved<Value>? = nil
    /// Default: options.count > 8.
    var filter: Bool? = nil
    var filterNoun = ConsoleMenuWords.optionsNoun
    /// Default max(field, 220).
    var width: CGFloat? = nil
    var height: CGFloat = 26

    @State private var open = false
    @State private var hovering = false
    @State private var frame: CGRect = .zero
    @FocusState private var focused: Bool
    @Environment(\.isEnabled) private var enabled

    var body: some View {
        Button(action: toggle) { ConsoleMenuFieldLabel(title: shownTitle, mono: mono, badge: fieldBadge?(value) ?? nil, quiet: fieldQuiet?(value) ?? false, open: open) }
            .buttonStyle(ConsoleMenuFieldStyle(height: height, ring: open || focused ? ConsoleTheme.accent : ConsoleTheme.hair, hovering: hovering, enabled: enabled))
            // `.activate`: Tab and the harness's `focus:` land here, a click never does — the ring is the keyboard's alone.
            .focusable(interactions: .activate)
            .focused($focused)
            .focusEffectDisabled()
            .modifier(ConsoleMenuFieldKeys(open: show))
            .onHover { hovering = $0 }
            .animation(ConsoleMotion.hover, value: hovering)
            .animation(Motion.snappy, value: open)
            .animation(Motion.snappy, value: shownTitle)
            .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .global) }) { frame = $0 }
            .consoleFloat(id, kind: .menu, on: open, dismiss: hide) { ConsoleMenuPopup(spec: spec) }
            .onReceive(NotificationCenter.default.publisher(for: ConsoleSession.previewNotification), perform: preview)
            .accessibilityLabel(label ?? ConsoleMenuWords.fallbackLabel)
            .accessibilityValue(title(value))
            .accessibilityHint(ConsoleMenuWords.opensList)
    }

    private var shownTitle: String { (fieldTitle ?? title)(value) }

    private var allOptions: [Value] {
        guard let saved, !options.contains(saved.value) else { return options }
        return options + [saved.value]
    }

    /// The keys (Space, Return, ↓) open; the click toggles — the layer lets the mouse-down on the
    /// field through, so the field alone closes its own menu, once.
    private func show() { guard enabled, !open else { return }; open = true; ConsolePress.report?("menu: opened \(id)") }
    private func toggle() { if open { hide() } else { show() } }

    /// The layer's dismiss and the popup's close: focus comes back to the field.
    private func hide() {
        guard open else { return }
        open = false
        focused = true
        ConsolePress.report?("menu: closed \(id)")
    }

    private func choose(_ v: Value) {
        hide()
        ConsolePress.report?("menu-pick: \(id) \(ConsolePress.word(v))")
        if v != value { pick(v) }
    }

    private func preview(_ note: Notification) {
        if note.userInfo?[ConsolePreviewKey.menuOpen] as? String == id { show() }
        if note.userInfo?[ConsolePreviewKey.focus] as? String == id { focused = true }
    }

    private var spec: ConsoleMenuSpec<Value> {
        ConsoleMenuSpec(id: id, label: label ?? ConsoleMenuWords.fallbackLabel, current: value, options: allOptions, title: title, mono: mono,
                        badge: savedBadge, badgeColumn: badgeColumn, size: size, detail: detail, meta: savedMeta, metaMono: metaMono,
                        group: savedGroup, groupCount: groupCount, groupCaption: groupCaption, dim: dim, disabled: disabled, loaded: loaded,
                        foot: foot, filter: ConsoleMenuModel.showsFilter(filter, count: allOptions.count), filterNoun: filterNoun,
                        width: ConsoleMenuModel.width(field: frame.width, minimum: width ?? 220, bounds: bounds, anchorMinX: frame.minX).w,
                        listMax: listMax, pick: choose, close: hide)
    }

    // The `saved` value's group, badge and provenance fold into the site's closures.
    private var savedGroup: ((Value) -> String)? {
        guard let saved else { return group }
        return { $0 == saved.value ? ConsoleMenuWords.savedHead : (group?($0) ?? ConsoleMenuWords.savedHead) }
    }
    private var savedBadge: ((Value) -> [ConsoleBadge.Word])? {
        guard let saved else { return badge }
        return { $0 == saved.value ? [.saved] : (badge?($0) ?? []) }
    }
    private var savedMeta: ((Value) -> String)? {
        guard let saved else { return meta }
        return { $0 == saved.value ? saved.provenance : (meta?($0) ?? "") }
    }

    /// The window's content rect, the space the root's float layer draws in.
    private var bounds: CGRect {
        let window = NSApp.keyWindow ?? NSApp.mainWindow ?? NSApp.windows.first { $0.isVisible && $0.contentView != nil }
        return CGRect(origin: .zero, size: window?.contentView?.bounds.size ?? CGSize(width: 1180, height: 760))
    }

    /// As many rows as fit between the field and the window's margin, then the list scrolls;
    /// when the room under the field is short and above is roomier the popup flips, so size for it.
    private var listMax: CGFloat {
        var room = ConsoleFloatPlacement.maxListHeight(anchor: frame, bounds: bounds, side: .below)
        if room < 200 { room = max(room, ConsoleFloatPlacement.maxListHeight(anchor: frame, bounds: bounds, side: .above)) }
        return max(78, room - ConsoleMenuPopupLayout.chrome(filter: ConsoleMenuModel.showsFilter(filter, count: allOptions.count), foot: foot != nil))
    }
}

/// The field's face: value · one badge · chevron. The box, the ring and the fills are the style's.
struct ConsoleMenuFieldLabel: View {
    let title: String
    let mono: Bool
    let badge: ConsoleBadge.Word?
    let quiet: Bool
    let open: Bool

    var body: some View {
        HStack(spacing: 6) {
            Text(title)
                .font(mono ? ConsoleTheme.mono(12) : ConsoleTheme.sans(12))
                .foregroundStyle(quiet ? ConsoleTheme.fg3 : ConsoleTheme.fg)
                .lineLimit(1).truncationMode(.tail)
                .contentTransition(.opacity)
            if let badge { ConsoleBadge(word: badge) }
            Spacer(minLength: 4)
            Image(systemName: "chevron.up.chevron.down")
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(open ? ConsoleTheme.fg : ConsoleTheme.fg3)
        }
    }
}

/// `ground` flat, hover `hover`, pressed `active`, one ring (hair → accent while open or focused), 0.45 disabled.
struct ConsoleMenuFieldStyle: ButtonStyle {
    let height: CGFloat
    let ring: Color
    let hovering: Bool
    let enabled: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .padding(.horizontal, 8)
            .frame(height: height)
            .frame(maxWidth: .infinity)
            .background(RoundedRectangle(cornerRadius: 6).fill(configuration.isPressed ? ConsoleTheme.active : (hovering ? ConsoleTheme.hover : .clear)))
            .background(RoundedRectangle(cornerRadius: 6).fill(ConsoleTheme.ground))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(ring, lineWidth: 1))
            .contentShape(Rectangle())
            .opacity(enabled ? 1 : 0.45)
            .animation(ConsoleMotion.hover, value: configuration.isPressed)
    }
}

/// Space, Return and ↓ open the field while it has keyboard focus.
struct ConsoleMenuFieldKeys: ViewModifier {
    let open: () -> Void

    func body(content: Content) -> some View {
        content
            .onKeyPress(.return) { open(); return .handled }
            .onKeyPress(.space) { open(); return .handled }
            .onKeyPress(.downArrow) { open(); return .handled }
    }
}

// MARK: - The popup

enum ConsoleMenuPopupLayout {
    /// What the popup spends outside its list: the filter strip (32) with its rule, the foot at its
    /// tallest (two lines) with its rule, the list's air and the seam.
    static func chrome(filter: Bool, foot: Bool) -> CGFloat {
        (filter ? 33 : 0) + (foot ? 41 : 0) + 8 + 2 * ConsoleTheme.seam
    }
    static let rowHeight: CGFloat = 26
    static let twoLineRowHeight: CGFloat = 40
    static let headHeight: CGFloat = 22
}

/// Filter · list · foot on a raised surface with one hairline, radius 6 and the 2 pt ground seam.
/// Focus lands in the filter (or on the list) one hop after it appears; the highlight starts on
/// the current pick; VoiceOver hears "Voice: 22 options".
struct ConsoleMenuPopup<Value: Hashable>: View {
    let spec: ConsoleMenuSpec<Value>

    @State private var query = ""
    @State private var highlight: Value?
    @State private var arrived = false
    @State private var settled = false
    @FocusState private var listFocused: Bool
    @FocusState private var filterFocused: Bool

    private var sections: [ConsoleMenuModel.Section<Value>] { spec.sections(query) }
    private var rows: [Value] { sections.flatMap(\.rows) }
    private var footText: String? { highlight.flatMap { spec.foot?($0) ?? nil } }

    var body: some View {
        VStack(spacing: 0) {
            if spec.filter { filterStrip; ConsoleHairline(weight: .row) }
            ConsoleMenuList(spec: spec, sections: sections, highlight: $highlight)
            if spec.foot != nil { ConsoleMenuFoot(text: footText) }
        }
        .frame(width: spec.width)
        .background(RoundedRectangle(cornerRadius: 6).fill(ConsoleTheme.raised))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(ConsoleTheme.hair, lineWidth: 1))
        .padding(ConsoleTheme.seam)
        .background(RoundedRectangle(cornerRadius: 6 + ConsoleTheme.seam).fill(ConsoleTheme.ground))
        .opacity(arrived ? 1 : 0)
        .offset(y: arrived || Motion.reduced ? 0 : -4)
        .focusable(!spec.filter)
        .focusEffectDisabled()
        .focused($listFocused)
        .modifier(ConsoleMenuKeys(rows: rows, spec: spec, highlight: $highlight, hasFilter: spec.filter))
        .onAppear(perform: appear)
        .onChange(of: query) { keepHighlight() }
        .onChange(of: filterFocused) { was, now in if spec.filter, settled, was, !now { leave() } }
        .onChange(of: listFocused) { was, now in if !spec.filter, settled, was, !now { leave() } }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(ConsoleMenuWords.optionsLabel(spec.label))
    }

    private var filterStrip: some View {
        ConsoleFilterField(text: $query, placeholder: ConsoleMenuModel.filterPlaceholder(count: spec.options.count, noun: spec.filterNoun),
                           count: ConsoleMenuModel.countWord(shown: rows.count, of: spec.options.count, typing: !query.isEmpty),
                           focus: $filterFocused, ring: false, accessibilityLabel: ConsoleMenuWords.optionsLabel(spec.label),
                           onMove: move, onSubmit: pickHighlight, onExit: escape)
            .padding(.horizontal, 4)
            .frame(height: 32)
    }

    private func appear() {
        highlight = spec.current
        withAnimation(.easeOut(duration: Motion.seconds(Motion.quick))) { arrived = true }
        DispatchQueue.main.async {
            if spec.filter { filterFocused = true } else { listFocused = true }
            DispatchQueue.main.async { settled = true }
        }
        ConsoleMenuAnnounce.post(ConsoleMenuWords.announcement(spec.label, spec.options.count))
    }

    /// Focus left (Tab, a click elsewhere): the popup closes unchanged.
    private func leave() { if !filterFocused, !listFocused { spec.close() } }

    /// An empty result keeps the current pick highlighted, so Return is safe.
    private func keepHighlight() {
        if let h = highlight, rows.contains(h) { return }
        highlight = rows.first { !spec.isDisabled($0) } ?? spec.current
    }

    private func move(_ direction: MoveCommandDirection) {
        switch direction {
        case .down: highlight = ConsoleMenuModel.step(highlight, by: 1, in: rows, disabled: spec.isDisabled)
        case .up: highlight = ConsoleMenuModel.step(highlight, by: -1, in: rows, disabled: spec.isDisabled)
        default: break
        }
    }

    private func pickHighlight() {
        guard let h = highlight, rows.contains(h), !spec.isDisabled(h) else { spec.close(); return }
        spec.pick(h)
    }

    /// Esc clears the filter text if any, else closes unchanged.
    private func escape() {
        if !query.isEmpty { query = "" } else { spec.close() }
    }
}

enum ConsoleMenuAnnounce {
    /// "Voice: 22 options" through VoiceOver on open.
    static func post(_ text: String) {
        NSAccessibility.post(element: NSApp as Any, notification: .announcementRequested,
                             userInfo: [.announcement: text, .priority: NSAccessibilityPriorityLevel.high.rawValue])
    }
}

/// The rows in a scroll that grows with them until the window's margin, then scrolls; the
/// highlighted row is kept in view (a jump, never a glide). Its own struct so the
/// ScrollViewReader block stays small for CI.
struct ConsoleMenuList<Value: Hashable>: View {
    let spec: ConsoleMenuSpec<Value>
    let sections: [ConsoleMenuModel.Section<Value>]
    @Binding var highlight: Value?

    private var natural: CGFloat { ConsoleMenuModel.listHeight(sections, twoLine: spec.twoLine) + 8 }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.vertical) {
                VStack(spacing: 0) {
                    ForEach(sections) { section in
                        if let title = section.title {
                            ConsoleMenuGroupHead(title: title, count: spec.groupCount?(title) ?? nil, caption: spec.groupCaption?(title) ?? nil)
                        }
                        ForEach(section.rows, id: \.self) { row in
                            ConsoleMenuRow(spec: spec, value: row, highlighted: row == highlight) { highlight = row }
                                .id(row)
                        }
                    }
                }
                .padding(.vertical, 4)
            }
            .thinScrollers()
            .frame(height: min(natural, spec.listMax))
            .onChange(of: highlight) { if let h = highlight { proxy.scrollTo(h, anchor: nil) } }
            .onAppear { if let h = highlight { proxy.scrollTo(h, anchor: nil) } }
        }
    }
}

/// 22: title sans 11 medium titanium · an optional count · optional column captions, right.
struct ConsoleMenuGroupHead: View {
    let title: String
    let count: String?
    let caption: String?

    var body: some View {
        HStack(spacing: 6) {
            Text(title).font(ConsoleTheme.sans(11, .medium)).foregroundStyle(ConsoleTheme.titanium).lineLimit(1)
            if let count {
                // A bare figure is mono; a phrase with a figure in it (`5 can call tools`) reads in sans.
                Text(count).font(count.allSatisfy(\.isNumber) ? ConsoleTheme.mono(11) : ConsoleTheme.sans(11)).foregroundStyle(ConsoleTheme.titanium).lineLimit(1)
            }
            Spacer(minLength: 6)
            if let caption { Text(caption).font(ConsoleTheme.mono(10)).foregroundStyle(ConsoleTheme.fg3).lineLimit(1) }
        }
        .padding(.horizontal, 12)
        .frame(height: ConsoleMenuPopupLayout.headHeight)
        .accessibilityAddTraits(.isHeader)
    }
}

/// 26 single / 40 two-line. Selected = the 2 pt accent bar + medium (never a checkmark). Dim rows
/// are fg3 and pickable; disabled rows draw at 0.45, keep their badge and take no click.
struct ConsoleMenuRow<Value: Hashable>: View {
    let spec: ConsoleMenuSpec<Value>
    let value: Value
    let highlighted: Bool
    let hover: () -> Void

    private var selected: Bool { value == spec.current }
    private var disabled: Bool { spec.isDisabled(value) }

    var body: some View {
        Button { spec.pick(value) } label: {
            HStack(spacing: 0) {
                Rectangle().fill(selected ? ConsoleTheme.accent : .clear).frame(width: 2).padding(.vertical, 4)
                VStack(alignment: .leading, spacing: 2) {
                    ConsoleMenuRowLine(spec: spec, value: value, selected: selected)
                    if let meta = spec.meta?(value), !meta.isEmpty {
                        Text(meta).font(spec.metaMono ? ConsoleTheme.mono(11) : ConsoleTheme.sans(11)).foregroundStyle(ConsoleTheme.fg3).lineLimit(1)
                    }
                }
                .padding(.leading, 6).padding(.trailing, 12)
            }
            .padding(.leading, 4)
            .frame(height: spec.twoLine ? ConsoleMenuPopupLayout.twoLineRowHeight : ConsoleMenuPopupLayout.rowHeight)
            .background(highlighted ? ConsoleTheme.lift : .clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.45 : 1)
        .onHover { if $0, !disabled { hover() } }
        .accessibilityValue(spec.badges(value).map(ConsoleBadge.text).joined(separator: " · "))
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// Line 1: [loaded dot] title · detail … size · badges (the last in a fixed column).
struct ConsoleMenuRowLine<Value: Hashable>: View {
    let spec: ConsoleMenuSpec<Value>
    let value: Value
    let selected: Bool

    private var titleColor: Color { spec.isDim(value) ? ConsoleTheme.fg3 : ConsoleTheme.fg }

    var body: some View {
        let badges = spec.badges(value)
        HStack(spacing: 6) {
            if spec.isLoaded(value) { Circle().fill(ConsoleTheme.acting).frame(width: 5, height: 5).accessibilityLabel(ConsoleBadgeWords.loaded) }
            Text(spec.title(value))
                .font(spec.mono ? ConsoleTheme.mono(12, selected ? .medium : .regular) : ConsoleTheme.sans(12, selected ? .medium : .regular))
                .foregroundStyle(titleColor).lineLimit(1)
            if let detail = spec.detail?(value), !detail.isEmpty {
                Text(detail).font(ConsoleTheme.sans(11)).foregroundStyle(ConsoleTheme.fg3).lineLimit(1)
            }
            Spacer(minLength: 8)
            if let size = spec.size?(value), !size.isEmpty {
                Text(size).font(ConsoleTheme.mono(11)).monospacedDigit().foregroundStyle(ConsoleTheme.titanium).lineLimit(1)
            }
            ForEach(Array(badges.enumerated()), id: \.offset) { index, word in
                ConsoleBadge(word: word, width: index == badges.count - 1 ? spec.badgeColumn : nil)
            }
        }
    }
}

/// The highlighted row's sentence whole: sans 11 fg2 over a row rule; 28 tall or as the text needs.
struct ConsoleMenuFoot: View {
    let text: String?

    var body: some View {
        VStack(spacing: 0) {
            ConsoleHairline(weight: .row)
            Text(text ?? " ")
                .font(ConsoleTheme.sans(11)).foregroundStyle(ConsoleTheme.fg2)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .frame(maxWidth: .infinity, minHeight: 28, alignment: .leading)
        }
    }
}

/// The popup's keys without a filter (the filter field forwards its own through `onMoveCommand`):
/// ↑↓ move (clamped, skipping disabled) · ⌥↑↓ Home End to the ends · Return picks · Space picks ·
/// Esc closes unchanged (with a filter the field's `onExitCommand` takes it: the text clears first) ·
/// Tab closes · letters type ahead on titles. The highlight never glides.
struct ConsoleMenuKeys<Value: Hashable>: ViewModifier {
    let rows: [Value]
    let spec: ConsoleMenuSpec<Value>
    @Binding var highlight: Value?
    let hasFilter: Bool

    func body(content: Content) -> some View {
        content
            .onKeyPress(keys: [.downArrow], phases: .down) { move(1, $0) }
            .onKeyPress(keys: [.upArrow], phases: .down) { move(-1, $0) }
            .onKeyPress(.home) { highlight = ConsoleMenuModel.step(nil, by: 1, in: rows, disabled: spec.isDisabled); return .handled }
            .onKeyPress(.end) { highlight = ConsoleMenuModel.step(nil, by: -1, in: rows, disabled: spec.isDisabled); return .handled }
            .onKeyPress(.return) { pick(); return .handled }
            .onKeyPress(.space) { if hasFilter { return .ignored }; pick(); return .handled }
            .onKeyPress(.escape) { if hasFilter { return .ignored }; spec.close(); return .handled }
            .onKeyPress(.tab) { spec.close(); return .handled }
            .onKeyPress(characters: .alphanumerics, phases: .down) { press in
                if hasFilter { return .ignored }
                if let next = ConsoleMenuModel.typeAhead(rows, title: spec.title, prefix: press.characters, after: highlight) { highlight = next }
                return .handled
            }
    }

    private func move(_ delta: Int, _ press: KeyPress) -> KeyPress.Result {
        let far = press.modifiers.contains(.option) ? delta * rows.count : delta
        highlight = ConsoleMenuModel.step(highlight, by: far, in: rows, disabled: spec.isDisabled)
        return .handled
    }

    private func pick() {
        guard let h = highlight, rows.contains(h), !spec.isDisabled(h) else { spec.close(); return }
        spec.pick(h)
    }
}
