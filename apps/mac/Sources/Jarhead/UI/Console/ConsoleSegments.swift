import SwiftUI
import AppKit

// The Console's segmented control — one struct, three sizes (`.rail` 28 · `.row` 26 · `.toggle`
// 22), `fixedSize` a parameter, not a copy. On = inverted (fg fill, ground letters); hover
// `hover`; focused = the accent ring around the box; ← → pick the neighbour, Space the next.
// `ConsoleToggle` is two cells of it that read `On | Off` — a word, not a blue switch, the same
// in an inactive window. `ConsoleStepper` is one box: − · value + unit · +.

enum ConsoleSegmentWords {
    static let on = "On"
    static let off = "Off"
    static let minus = "minus"
    static let plus = "plus"
    static let decrease = "Less"
    static let increase = "More"
}

/// One option of a segmented control: the active one filled with the text colour and lettered
/// in the ground, the rest plain with a hover. The filled thumb is one view on the control's
/// matched geometry id, so it glides between options (Motion.snappy).
struct ConsoleSegmentOption: View {
    let title: String
    let on: Bool
    /// The control's namespace: the filled thumb glides between its options.
    let thumb: Namespace.ID
    var height: CGFloat = 28
    var font: Font = ConsoleTheme.sans(12, .medium)
    /// Sized to the title (pad 10) instead of sharing the width.
    var fixed = false
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(font)
                .foregroundStyle(on ? ConsoleTheme.ground : (hovering ? ConsoleTheme.fg : ConsoleTheme.fg2))
                .lineLimit(1)
                .padding(.horizontal, fixed ? 10 : 0)
                .frame(maxWidth: fixed ? nil : .infinity)
                .frame(height: height)
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

/// A segmented control over any few values (Settings › Accent, the Memory rail's
/// Live | Forgotten | Archived, the wizard's Accent and Auth): one hairline box, dividers
/// between options, the thumb gliding to the pick. Two to four options; more is a `ConsoleMenuField`.
struct ConsoleSegments<Value: Hashable>: View {
    enum Size { case rail, row, toggle }

    let value: Value
    let options: [Value]
    let title: (Value) -> String
    let pick: (Value) -> Void
    var accessibilityLabel: String? = nil
    var size: Size = .rail
    var fixedSize = false
    /// `focus:<id>` from the harness lands here.
    var id: String? = nil
    /// A fixed width per cell (the toggle's 30).
    var cellWidth: CGFloat? = nil

    @Namespace private var thumb
    @FocusState private var focused: Bool

    static func height(_ size: Size) -> CGFloat {
        switch size {
        case .rail: return 28
        case .row: return 26
        case .toggle: return 22
        }
    }

    private var height: CGFloat { Self.height(size) }
    private var font: Font { size == .toggle ? ConsoleTheme.sans(11, .medium) : ConsoleTheme.sans(12, .medium) }

    var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(options.enumerated()), id: \.element) { index, option in
                if index > 0 { Rectangle().fill(ConsoleTheme.hair).frame(width: 1) }
                ConsoleSegmentOption(title: title(option), on: option == value, thumb: thumb, height: height, font: font, fixed: fixedSize) {
                    withAnimation(Motion.snappy) { pick(option) }
                }
                .frame(width: cellWidth)
            }
        }
        .frame(height: height)
        .fixedSize(horizontal: fixedSize || cellWidth != nil, vertical: false)
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(focused ? ConsoleTheme.accent : ConsoleTheme.hair, lineWidth: 1))
        .focusable()
        .focused($focused)
        .focusEffectDisabled()
        .modifier(ConsoleSegmentKeys(step: step, escape: { focused = false }))
        .animation(Motion.snappy, value: value)
        .animation(Motion.snappy, value: focused)
        .onReceive(NotificationCenter.default.publisher(for: ConsoleSession.previewNotification)) { note in
            if let id, note.userInfo?[ConsolePreviewKey.focus] as? String == id { focused = true }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilityLabel ?? title(value))
    }

    /// ← → pick the neighbour (clamped); Space the next, wrapping — on two cells, a flip.
    private func step(_ delta: Int, wrap: Bool) {
        guard let at = options.firstIndex(of: value), !options.isEmpty else { return }
        let next = wrap ? (at + delta + options.count) % options.count : min(max(at + delta, 0), options.count - 1)
        guard next != at else { return }
        withAnimation(Motion.snappy) { pick(options[next]) }
    }
}

struct ConsoleSegmentKeys: ViewModifier {
    let step: (Int, Bool) -> Void
    let escape: () -> Void

    func body(content: Content) -> some View {
        content
            .onKeyPress(.leftArrow) { step(-1, false); return .handled }
            .onKeyPress(.rightArrow) { step(1, false); return .handled }
            .onKeyPress(.space) { step(1, true); return .handled }
            .onKeyPress(.escape) { escape(); return .handled }
    }
}

/// `On | Off`: two cells of `ConsoleSegments`, 60 × 22, the current cell inverted, a hint beside it
/// that says the consequence (`wakes on launch`), never the label. Reads the same when the window
/// is inactive; the accent appears only as the focus ring.
struct ConsoleToggle: View {
    let on: Bool
    var words = (ConsoleSegmentWords.on, ConsoleSegmentWords.off)
    /// ≤ 4 words, sans 11 titanium.
    var hint: String? = nil
    var id: String? = nil
    var accessibilityLabel: String? = nil
    let flip: (Bool) -> Void

    /// Pure, for `check-kit`.
    static func word(_ on: Bool) -> String { on ? ConsoleSegmentWords.on : ConsoleSegmentWords.off }

    var body: some View {
        HStack(spacing: 10) {
            ConsoleSegments(value: on, options: [true, false], title: { $0 ? words.0 : words.1 }, pick: flip,
                            accessibilityLabel: accessibilityLabel, size: .toggle, id: id, cellWidth: 30)
                .accessibilityValue(Self.word(on))
                .accessibilityAddTraits(.isToggle)
            if let hint {
                Text(hint).font(ConsoleTheme.sans(11)).foregroundStyle(ConsoleTheme.titanium).lineLimit(1)
            }
        }
        .frame(height: 26)
    }
}

/// 122 × 26: [− 24][value mono 12 fg + unit mono 11 titanium, centred][+ 24] with hair dividers.
/// ↑↓ step, ⌥ steps ×10, digits edit in place, Return commits, Esc reverts; focused = accent ring.
struct ConsoleStepper: View {
    let value: Int
    let unit: String
    var range: ClosedRange<Int> = 1...240
    var step = 1
    var id: String? = nil
    var accessibilityLabel: String? = nil
    let set: (Int) -> Void

    @State private var draft = ""
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 0) {
            ConsoleStepperCell(symbol: ConsoleSegmentWords.minus, label: ConsoleSegmentWords.decrease, enabled: value > range.lowerBound) { nudge(-1) }
            Rectangle().fill(ConsoleTheme.hair).frame(width: 1)
            ConsoleStepperValue(draft: $draft, unit: unit, focused: $focused, commit: commit, revert: revert, move: moved)
            Rectangle().fill(ConsoleTheme.hair).frame(width: 1)
            ConsoleStepperCell(symbol: ConsoleSegmentWords.plus, label: ConsoleSegmentWords.increase, enabled: value < range.upperBound) { nudge(1) }
        }
        .frame(width: 122, height: 26)
        .background(RoundedRectangle(cornerRadius: 6).fill(ConsoleTheme.ground))
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(focused ? ConsoleTheme.accent : ConsoleTheme.hair, lineWidth: 1))
        .animation(Motion.snappy, value: focused)
        .onAppear { draft = String(value) }
        .onChange(of: value) { if !focused { draft = String(value) } }
        .onReceive(NotificationCenter.default.publisher(for: ConsoleSession.previewNotification)) { note in
            if let id, note.userInfo?[ConsolePreviewKey.focus] as? String == id { focused = true }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilityLabel ?? unit)
        .accessibilityValue("\(value) \(unit)")
    }

    private func nudge(_ direction: Int) {
        let by = NSEvent.modifierFlags.contains(.option) ? step * 10 : step
        let next = min(max(value + direction * by, range.lowerBound), range.upperBound)
        if next != value { set(next) }
        draft = String(next)
    }

    private func moved(_ direction: MoveCommandDirection) {
        if direction == .up { nudge(1) } else if direction == .down { nudge(-1) }
    }

    private func commit() {
        if let typed = Int(draft.trimmingCharacters(in: .whitespaces)) {
            let next = min(max(typed, range.lowerBound), range.upperBound)
            if next != value { set(next) }
            draft = String(next)
        } else {
            draft = String(value)
        }
        focused = false
    }

    private func revert() {
        draft = String(value)
        focused = false
    }
}

/// − or + : 24 wide, hover `hover`, pressed `active`, 0.45 at the range's end.
struct ConsoleStepperCell: View {
    let symbol: String
    let label: String
    let enabled: Bool
    let tap: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: tap) {
            Image(systemName: symbol).font(.system(size: 10, weight: .semibold)).foregroundStyle(ConsoleTheme.fg2)
                .frame(width: 24, height: 26)
                .background(hovering ? ConsoleTheme.hover : .clear)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.45)
        .onHover { hovering = $0 }
        .animation(ConsoleMotion.hover, value: hovering)
        .accessibilityLabel(label)
    }
}

/// The value is a field: mono 12 fg digits, the unit mono 11 titanium after them.
struct ConsoleStepperValue: View {
    @Binding var draft: String
    let unit: String
    var focused: FocusState<Bool>.Binding
    let commit: () -> Void
    let revert: () -> Void
    let move: (MoveCommandDirection) -> Void

    var body: some View {
        HStack(spacing: 4) {
            TextField("", text: $draft)
                .textFieldStyle(.plain)
                .font(ConsoleTheme.mono(12)).monospacedDigit()
                .foregroundStyle(ConsoleTheme.fg)
                .tint(ConsoleTheme.accent)
                .multilineTextAlignment(.trailing)
                .frame(width: 30)
                .focused(focused)
                .onSubmit(commit)
                .onExitCommand(perform: revert)
                .onMoveCommand(perform: move)
            Text(unit).font(ConsoleTheme.mono(11)).foregroundStyle(ConsoleTheme.titanium).lineLimit(1)
        }
        .frame(maxWidth: .infinity)
        .frame(height: 26)
        .contentShape(Rectangle())
        .onTapGesture { focused.wrappedValue = true }
    }
}
