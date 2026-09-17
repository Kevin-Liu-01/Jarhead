import SwiftUI
import AppKit

// The Console's button (moved here from ConsoleTheme.swift in design13; same call sites). Five
// kinds, one rule: a ghost or spent button is a tile (`ConsoleFill.rest(on:)`) with a hairline;
// the primary is the accent, danger the red, plain nothing but its glyph — chrome inside another
// box, whose box is its solid. Hover adds `hover`, a press adds `active`; the words and glyph
// never move. Disabled: a ghost keeps its tile (the line drops to `hairRow`, the label to .45);
// a primary or danger dims whole. `spent` is a control whose deed is done — Stop while nothing
// runs — grey on its tile, fg3 words, still enabled (a Stop must land), never red.
// The pure helpers are `static` on the style so `check-kit` (one module with the harness) pins them.

struct ConsoleButtonStyle: ButtonStyle {
    enum Kind: Equatable { case ghost, plain, primary, danger, spent }
    var kind: Kind = .ghost
    var iconOnly = false
    var height: CGFloat = 28
    var small = false

    func makeBody(configuration: Configuration) -> some View {
        ConsoleButtonBody(kind: kind, iconOnly: iconOnly, height: height, small: small, configuration: configuration)
    }

    // MARK: the rule, pure

    /// The tile: `lift` / `liftRaised` for a ghost or spent button, the accent or the red (at .8
    /// while pressed) for a filled one, nothing for plain chrome.
    static func fill(kind: Kind, surface: ConsoleFill.Surface, hovering: Bool, pressed: Bool) -> Color {
        switch kind {
        case .ghost, .spent: return ConsoleFill.rest(on: surface)
        case .plain: return .clear
        // The token itself at rest (a wrapped `.opacity(1)` is a different Color to SwiftUI), .8 while pressed.
        case .primary: return pressed ? ConsoleTheme.accent.opacity(0.8) : ConsoleTheme.accent
        case .danger: return pressed ? ConsoleTheme.error.opacity(0.8) : ConsoleTheme.error
        }
    }

    /// The state layer over the tile: `active` while pressed, `hover` under the pointer, on the
    /// unfilled kinds only — a filled button says its press with its own opacity.
    static func wash(kind: Kind, hovering: Bool, pressed: Bool) -> Color {
        switch kind {
        case .ghost, .spent, .plain: return pressed ? ConsoleTheme.active : (hovering ? ConsoleTheme.hover : .clear)
        case .primary, .danger: return .clear
        }
    }

    /// The hairline: `hair` on a live ghost, `hairRow` once spent or disabled, none on the rest.
    static func border(kind: Kind, enabled: Bool) -> Color {
        switch kind {
        case .ghost: return ConsoleFill.line(spent: false, enabled: enabled)
        case .spent: return ConsoleFill.line(spent: true, enabled: enabled)
        case .plain, .primary, .danger: return .clear
        }
    }

    /// The words and glyph: fg2 at rest lifting to fg; fg3 on a spent button, lit or not.
    static func foreground(kind: Kind, lit: Bool) -> Color {
        switch kind {
        case .ghost, .plain: return lit ? ConsoleTheme.fg : ConsoleTheme.fg2
        case .spent: return ConsoleTheme.fg3
        case .primary, .danger: return ConsoleTheme.onAccent
        }
    }

    /// Whether a disabled button dims whole (a filled one) or keeps its tile and dims the label alone.
    static func dims(kind: Kind) -> Bool {
        switch kind {
        case .primary, .danger: return true
        case .ghost, .plain, .spent: return false
        }
    }
}

/// The live body: hover in state, the press from the configuration, the surface and enablement
/// from the environment — handed to `ConsoleButtonFace`, which draws from those values alone.
private struct ConsoleButtonBody: View {
    let kind: ConsoleButtonStyle.Kind
    let iconOnly: Bool
    let height: CGFloat
    let small: Bool
    let configuration: ButtonStyle.Configuration

    @Environment(\.isEnabled) private var enabled
    @Environment(\.consoleSurface) private var surface
    @State private var hovering = false

    var body: some View {
        ConsoleButtonFace(kind: kind, iconOnly: iconOnly, height: height, small: small, surface: surface,
                          enabled: enabled, hovering: hovering, pressed: configuration.isPressed) { configuration.label }
            .onHover { hovering = $0 }
            // The hover and the press are felt at once; a kind that flips (Stop turning red or going
            // spent, Send filling with text, Go becoming a ghost) crossfades its fill.
            .animation(ConsoleMotion.hover, value: hovering)
            .animation(ConsoleMotion.hover, value: configuration.isPressed)
            .animation(Motion.snappy, value: kind)
            .animation(Motion.fade, value: enabled)
    }
}

/// The face, from values alone: the same view under a live button and under the harness's
/// `buttons` sheet, where every state is forced so the kinds × states can be shot side by side.
struct ConsoleButtonFace<Label: View>: View {
    let kind: ConsoleButtonStyle.Kind
    var iconOnly = false
    var height: CGFloat = 28
    var small = false
    var surface: ConsoleFill.Surface = .ground
    var enabled = true
    var hovering = false
    var pressed = false
    @ViewBuilder let label: () -> Label

    private var lit: Bool { enabled && (hovering || pressed) }
    private var dims: Bool { ConsoleButtonStyle.dims(kind: kind) }

    var body: some View {
        label()
            .font(ConsoleTheme.sans(small ? 11 : 12, .medium))
            .foregroundStyle(ConsoleButtonStyle.foreground(kind: kind, lit: lit))
            // A ghost keeps its tile when disabled; only its words go quiet.
            .opacity(enabled || dims ? 1 : 0.45)
            .padding(.horizontal, iconOnly ? 0 : (small ? 8 : 10))
            .frame(width: iconOnly ? height : nil, height: height)
            .background(ConsoleButtonTile(kind: kind, surface: surface, hovering: lit && hovering, pressed: lit && pressed))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(ConsoleButtonStyle.border(kind: kind, enabled: enabled), lineWidth: 1))
            .contentShape(Rectangle())
            .opacity(enabled || !dims ? 1 : 0.45)
    }
}

/// The two layers under the label: the tile, then the state wash.
struct ConsoleButtonTile: View {
    let kind: ConsoleButtonStyle.Kind
    let surface: ConsoleFill.Surface
    let hovering: Bool
    let pressed: Bool

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 6).fill(ConsoleButtonStyle.fill(kind: kind, surface: surface, hovering: hovering, pressed: pressed))
            RoundedRectangle(cornerRadius: 6).fill(ConsoleButtonStyle.wash(kind: kind, hovering: hovering, pressed: pressed))
        }
    }
}
