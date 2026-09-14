import SwiftUI

// Badge · chip · keycap — small and frozen. A badge is a word in a box, not a chip: 16 tall,
// radius 6, one hairline, no fill; sans 10 medium for a word, mono 10 for a figure. Tone is a
// second voice and only for the exceptional word (`tight · missing · asks · off` amber; `too big ·
// failed` red); every resting word is titanium. Every badge word is pinned by a `check-kit` line;
// any new coloured word goes through this file.

enum ConsoleBadgeWords {
    static let fits = "fits"
    static let tight = "tight"
    static let tooBig = "too big"
    static let noTools = "no tools"
    static let loaded = "loaded"
    static let saved = "saved"
    static let auto = "auto"
    static let `default` = "default"
    static let noKey = "no key"
    static let thisMac = "this Mac"
    static let ready = "Ready"
    static let allOk = "all ok"
    static let off = "off"
    static let asks = "asks"
    static let failed = "failed"
    static func missing(_ n: Int) -> String { "\(n) missing" }
}

struct ConsoleBadge: View {
    enum Word: Hashable {
        case fits, tight, tooBig, noTools, loaded, saved, auto, `default`, noKey, thisMac, ready, allOk, off, asks, failed
        case missing(Int)
        /// A figure in mono: `17 GB`, `12 of 16`, `$0.85`, `0.9`.
        case figure(String)
        /// Any other resting word (`working`, `idle`, `done`, `live`, `fact`, `pref`).
        case word(String)
    }

    /// The two tones and rest, so the harness pins them by name.
    enum Tone: String { case rest, speaking, error }

    let word: Word
    /// A fixed width so a column aligns (`fit` 62, `$` 46, `count` 30).
    var width: CGFloat? = nil

    static func text(_ w: Word) -> String {
        switch w {
        case .fits: return ConsoleBadgeWords.fits
        case .tight: return ConsoleBadgeWords.tight
        case .tooBig: return ConsoleBadgeWords.tooBig
        case .noTools: return ConsoleBadgeWords.noTools
        case .loaded: return ConsoleBadgeWords.loaded
        case .saved: return ConsoleBadgeWords.saved
        case .auto: return ConsoleBadgeWords.auto
        case .default: return ConsoleBadgeWords.default
        case .noKey: return ConsoleBadgeWords.noKey
        case .thisMac: return ConsoleBadgeWords.thisMac
        case .ready: return ConsoleBadgeWords.ready
        case .allOk: return ConsoleBadgeWords.allOk
        case .off: return ConsoleBadgeWords.off
        case .asks: return ConsoleBadgeWords.asks
        case .failed: return ConsoleBadgeWords.failed
        case .missing(let n): return ConsoleBadgeWords.missing(n)
        case .figure(let s), .word(let s): return s
        }
    }

    static func toneKind(_ w: Word) -> Tone {
        switch w {
        case .tight, .missing, .asks, .off: return .speaking
        case .tooBig, .failed: return .error
        default: return .rest
        }
    }

    static func tone(_ w: Word) -> Color {
        switch toneKind(w) {
        case .rest: return ConsoleTheme.titanium
        case .speaking: return ConsoleTheme.speaking
        case .error: return ConsoleTheme.error
        }
    }

    /// A session's status as a badge word: `blocked` is the one that asks (amber); the resting
    /// words (`working · idle · done · ended · offline`) stay titanium; `unknown` is no badge.
    static func agent(_ s: AgentStatus) -> Word? {
        switch s {
        case .blocked: return .asks
        case .unknown: return nil
        default: return .word(s.rawValue)
        }
    }

    static func isFigure(_ w: Word) -> Bool {
        if case .figure = w { return true }
        return false
    }

    var body: some View {
        let tone = Self.tone(word)
        Text(Self.text(word))
            .font(Self.isFigure(word) ? ConsoleTheme.badgeFigure : ConsoleTheme.badge)
            .foregroundStyle(tone)
            .lineLimit(1)
            .padding(.horizontal, 5)
            .frame(width: width, height: 16)
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Self.toneKind(word) == .rest ? ConsoleTheme.hair : tone, lineWidth: 1))
            .accessibilityLabel(Self.text(word))
    }
}

/// A filter chip: 22 tall, radius 6, hairline; word sans 11 medium fg2 + count mono 11 fg3;
/// selected = inverted (fg fill, ground letters — the segments idiom).
struct ConsoleChip: View {
    let word: String
    var count: String? = nil
    let on: Bool
    let tap: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: tap) {
            HStack(spacing: 5) {
                Text(word).font(ConsoleTheme.sans(11, .medium)).foregroundStyle(on ? ConsoleTheme.ground : ConsoleTheme.fg2)
                if let count { Text(count).font(ConsoleTheme.mono(11)).foregroundStyle(on ? ConsoleTheme.ground : ConsoleTheme.fg3) }
            }
            .lineLimit(1)
            .padding(.horizontal, 8)
            .frame(height: 22)
            .background(RoundedRectangle(cornerRadius: 6).fill(on ? ConsoleTheme.fg : (hovering ? ConsoleTheme.hover : .clear)))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(on ? .clear : ConsoleTheme.hair, lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(ConsoleMotion.hover, value: hovering)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

/// A shortcut as a key: mono 10 fg3 in a 16 pt hairline box, radius 6, min width 16, pad 4.
struct ConsoleKeyCap: View {
    let key: String

    var body: some View {
        Text(key)
            .font(ConsoleTheme.mono(10))
            .foregroundStyle(ConsoleTheme.fg3)
            .lineLimit(1)
            .padding(.horizontal, 4)
            .frame(minWidth: 16)
            .frame(height: 16)
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(ConsoleTheme.hair, lineWidth: 1))
            .accessibilityLabel(key)
    }
}
