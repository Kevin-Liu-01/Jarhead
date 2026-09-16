import SwiftUI

// design12 · Settings › Audio's `Hears` / `Speaks` value: what the graph is doing, as figures. Line 1
// the device's name (sans 12 fg); line 2 the rate as a figure (mono 11 titanium) ` · ` ONE state word
// (sans 11 fg3) — `echo cancelled` | `echo guarded` | `no echo cancellation` for Hears, `full quality` |
// `narrowed` for Speaks (the hands-free tell). Sentences ("follows the system default") live in the
// hover card and the `echoFollows` hint, never on line 2; check-kit measures the longest line 2 ≤ 182.
// 40 tall inside its `ConsoleFormRow(key, height: 40)`; hover a tier-2 `ConsoleTipCard`.

/// The pure half: the two lines, once, for the row and the harness.
struct ConsoleRouteLine: Equatable {
    var name: String
    var figures: String
    var state: String

    /// `48 kHz · echo cancelled` — the figure and the state word, ` · `-joined; the state alone when there is no figure.
    var line2: String { [figures, state].filter { !$0.isEmpty }.joined(separator: SettingsWords.routeJoiner) }

    /// The row from the notification's plain values (`MicRouteInfo`): a 0 Hz rate prints no figure.
    static func from(name: String, rate: Double, state: String) -> ConsoleRouteLine {
        ConsoleRouteLine(name: name, figures: rate > 0 ? SettingsWords.kHz(rate) : "", state: state)
    }
}

struct ConsoleRouteValue: View {
    let line: ConsoleRouteLine
    /// The row's id (`settings.hears` / `settings.speaks`) — the card hangs from it.
    let id: String
    var card: ConsoleTipCard? = nil

    var body: some View {
        let stack = VStack(alignment: .leading, spacing: 2) {
            Text(line.name).font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg).lineLimit(1)
            HStack(spacing: 4) {
                if !line.figures.isEmpty {
                    Text(line.figures).font(ConsoleTheme.mono(11)).monospacedDigit().foregroundStyle(ConsoleTheme.titanium).lineLimit(1)
                    Text(SettingsWords.routeDot).font(ConsoleTheme.sans(11)).foregroundStyle(ConsoleTheme.fg3)
                }
                Text(line.state).font(ConsoleTheme.sans(11)).foregroundStyle(ConsoleTheme.fg3).lineLimit(1)
            }
        }
        .frame(height: 40, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(line.name)
        .accessibilityValue(line.line2)
        if let card {
            stack.consoleHelp(id: id, card: card).accessibilityHint(card.spoken)
        } else {
            stack
        }
    }
}
