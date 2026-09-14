import SwiftUI

// The Console's segmented control, moved verbatim from ConsoleTheme.swift (kit step 0).
// Builder B adds `size:` and `ConsoleToggle` / `ConsoleStepper` beside it.

/// One option of a segmented control: the active one filled with the text colour and lettered
/// in the ground, the rest plain with a hover. The filled thumb is one view on the control's
/// matched geometry id, so it glides between options (Motion.snappy). The rail's tabs, the
/// Home row and `ConsoleSegments` all draw their options with this.
struct ConsoleSegmentOption: View {
    let title: String
    let on: Bool
    /// The control's namespace: the filled thumb glides between its options.
    let thumb: Namespace.ID
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(ConsoleTheme.sans(12, .medium))
                .foregroundStyle(on ? ConsoleTheme.ground : ConsoleTheme.fg2)
                .lineLimit(1)
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

/// A segmented control over any few values (Settings › Accent, the Memory rail's
/// Live | Forgotten | Archived): one hairline box, dividers between options, the thumb gliding
/// to the pick. Two or three options; more belongs in a `ConsoleMenuField`.
struct ConsoleSegments<Value: Hashable>: View {
    let value: Value
    let options: [Value]
    let title: (Value) -> String
    let pick: (Value) -> Void
    var accessibilityLabel: String? = nil

    @Namespace private var thumb

    var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(options.enumerated()), id: \.element) { index, option in
                if index > 0 { Rectangle().fill(ConsoleTheme.hair).frame(width: 1) }
                ConsoleSegmentOption(title: title(option), on: option == value, thumb: thumb) {
                    withAnimation(Motion.snappy) { pick(option) }
                }
            }
        }
        .frame(height: 28)
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(ConsoleTheme.hair, lineWidth: 1))
        .animation(Motion.snappy, value: value)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilityLabel ?? title(value))
    }
}
