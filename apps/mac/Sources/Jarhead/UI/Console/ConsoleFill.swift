import SwiftUI
import AppKit

// The fill rule (design13, § Buttons and icons): a control is a tile one step off the surface it
// sits on plus a 1 pt hairline; every state is a change of those two layers. `lift` is the step
// on `ground` (the window); `liftRaised` the step on `raised` (a popup foot, a card, a hovered or
// selected row), so a button there never equals the row highlight (`lift`) beside it. The tokens
// in `ConsoleTheme.swift` are frozen — the one new tone lives here, and every control asks this
// file which fill and which line it wears rather than naming a token itself.

enum ConsoleFill {
    /// What a control sits on. Read from `\.consoleSurface` (`.ground` by default; popups, cards,
    /// tips and a hovered/selected `ConsoleRow` set `.raised` for their controls).
    enum Surface: Equatable { case ground, raised }

    /// The rest fill on `raised`: white .16 in dark, ink .12 in light — one step above `lift`.
    static let liftRaised = ConsoleTheme.dynamic(light: ConsoleTheme.nsColor(0x070707, 0.12), dark: NSColor(white: 1, alpha: 0.16))

    /// The rest fill for the surface: `lift` on ground, `liftRaised` on raised. Pinned by `check-kit`.
    static func rest(on surface: Surface) -> Color {
        surface == .ground ? ConsoleTheme.lift : liftRaised
    }

    /// The line of a control: `hair` while live, `hairRow` once spent or disabled. Pinned by `check-kit`.
    static func line(spent: Bool, enabled: Bool) -> Color {
        spent || !enabled ? ConsoleTheme.hairRow : ConsoleTheme.hair
    }

    /// The token's name for a fill `rest(on:)` picks — what the harness prints.
    static func restName(on surface: Surface) -> String {
        surface == .ground ? ConsoleFillWords.lift : ConsoleFillWords.liftRaised
    }

    /// The token's name for a line `line(spent:enabled:)` picks — what the harness prints.
    static func lineName(spent: Bool, enabled: Bool) -> String {
        spent || !enabled ? ConsoleFillWords.hairRow : ConsoleFillWords.hair
    }
}

/// The token names, for the harness's `check:` lines.
enum ConsoleFillWords {
    static let lift = "lift"
    static let liftRaised = "liftRaised"
    static let hair = "hair"
    static let hairRow = "hairRow"
}

struct ConsoleSurfaceKey: EnvironmentKey {
    static let defaultValue = ConsoleFill.Surface.ground
}

extension EnvironmentValues {
    /// The surface a control sits on; a raised container sets `.raised` for everything inside it.
    var consoleSurface: ConsoleFill.Surface {
        get { self[ConsoleSurfaceKey.self] }
        set { self[ConsoleSurfaceKey.self] = newValue }
    }
}
