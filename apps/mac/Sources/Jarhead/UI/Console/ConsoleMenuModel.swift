import Foundation
import SwiftUI

// The dropdown's pure half: sections, the highlight's steps, type-ahead, the filter's words and
// the popup's width — no view in here, so the console preview's `check-kit` lines pin every rule
// without a window (the package has no test target). Beside it, the words the two big sites
// hand the menu (`VoiceWords`, `BrainWords`) and the Effort foot (`HelpCopy.effort`).

/// Every literal the dropdown itself says.
enum ConsoleMenuWords {
    /// "Filter 22 voices" — the count is in the words, so the field never needs a second line.
    static func filterPlaceholder(_ count: Int, _ noun: String) -> String { "Filter \(count) \(noun)" }
    /// "2 of 22" while typing.
    static func countOf(_ shown: Int, _ total: Int) -> String { "\(shown) of \(total)" }
    static let optionsNoun = "options"
    /// The head a saved value outside the list sits under.
    static let savedHead = "Saved, not listed"
    /// The field's accessibility hint.
    static let opensList = "Opens the list"
    /// The popup's accessibility label: "Voice options".
    static func optionsLabel(_ label: String) -> String { "\(label) \(optionsNoun)" }
    /// The VoiceOver announcement on open: "Voice: 22 options".
    static func announcement(_ label: String, _ count: Int) -> String { "\(label): \(count) \(optionsNoun)" }
    static let fallbackLabel = "Menu"
    // design13 (§ Voices): the badge a field wears while a pick waits for the next wake, and the
    // detail on the row of the voice the open session speaks.
    static let waits = "waits"
    static let speaking = "speaking"
}

/// design13 (§ Flags): the emoji flag rides on the **Accent** — a prompt clause, never a property
/// of a voice (all 22 take every accent). `flag` is nil for `none`; `title` is the segment's cell:
/// short (`🇬🇧 UK`) in the 296 rail and the popup head, long (`🇬🇧 British`) in Setup and the fold
/// summary. `ConsoleTheme.accents` stays the source of the ids and the plain words.
enum AccentWords {
    static let american = "🇺🇸"
    static let british = "🇬🇧"
    static let us = "US"
    static let uk = "UK"

    /// american → 🇺🇸 · british → 🇬🇧 · none (or an id the app does not know) → nil. Pinned.
    static func flag(_ id: String) -> String? {
        switch id {
        case "american": return american
        case "british": return british
        default: return nil
        }
    }

    /// `🇬🇧 UK` · `🇬🇧 British` · `None`; an unknown id reads as its own word, no flag. Pinned.
    static func title(_ id: String, short: Bool) -> String {
        let word = short ? shortWord(id) : ConsoleTheme.accentLabel(id)
        guard let flag = flag(id) else { return word }
        return "\(flag) \(word)"
    }

    /// The two-letter word for the rail's 158 pt control column: US · UK; the rest keep their label.
    static func shortWord(_ id: String) -> String {
        switch id {
        case "american": return us
        case "british": return uk
        default: return ConsoleTheme.accentLabel(id)
        }
    }
}

enum ConsoleMenuModel {
    struct Section<V: Hashable>: Identifiable {
        let id: String
        /// nil = the one untitled section (no `group` closure).
        let title: String?
        let rows: [V]
    }

    /// Trimmed and lower-cased — the same normalisation as `ConsoleSession.searchKey`, spelled here so
    /// the model stays pure (no main-actor call).
    static func key(_ query: String) -> String { query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }

    /// The query's letters appear in `text` in that order (`ma` finds Marin and Meridian) — the
    /// way a list is looked through by typing, not searched.
    static func lettersInOrder(_ q: String, in text: String) -> Bool {
        var rest = Substring(text)
        for ch in q {
            guard let at = rest.firstIndex(of: ch) else { return false }
            rest = rest[rest.index(after: at)...]
        }
        return true
    }

    /// The rows an option matches a query on: the title by letters in order, the detail by a plain
    /// substring, both `key`-normalised.
    static func matches<V>(_ option: V, title: (V) -> String, detail: ((V) -> String)?, query: String) -> Bool {
        let q = key(query)
        if q.isEmpty { return true }
        if lettersInOrder(q, in: key(title(option))) { return true }
        guard let detail else { return false }
        return key(detail(option)).contains(q)
    }

    /// Groups in first-seen order of `group(option)`; a nil `group` is one untitled section; a
    /// group every row of which the query drops vanishes.
    static func sections<V>(_ options: [V], group: ((V) -> String)?, title: (V) -> String,
                            detail: ((V) -> String)?, query: String) -> [Section<V>] {
        let kept = options.filter { matches($0, title: title, detail: detail, query: query) }
        guard let group else { return kept.isEmpty ? [] : [Section(id: "all", title: nil, rows: kept)] }
        var order: [String] = []
        var rows: [String: [V]] = [:]
        for option in kept {
            let g = group(option)
            if rows[g] == nil { order.append(g); rows[g] = [] }
            rows[g]?.append(option)
        }
        return order.map { Section(id: $0, title: $0, rows: rows[$0] ?? []) }
    }

    /// The highlight moved by `delta` rows (±1, or ±rows.count for ⌥↑↓ / Home / End): clamped,
    /// never wrapping, skipping disabled rows; nil current → the first (or last) enabled row.
    static func step<V: Hashable>(_ current: V?, by delta: Int, in rows: [V], disabled: (V) -> Bool) -> V? {
        guard !rows.isEmpty, delta != 0 else { return current }
        let enabled = rows.indices.filter { !disabled(rows[$0]) }
        guard !enabled.isEmpty else { return current }
        guard let current, let at = rows.firstIndex(of: current) else { return rows[delta > 0 ? enabled.first! : enabled.last!] }
        let target = min(max(at + delta, 0), rows.count - 1)
        if delta > 0 { return rows[enabled.first { $0 >= target } ?? enabled.last!] }
        return rows[enabled.last { $0 <= target } ?? enabled.first!]
    }

    /// Type-ahead on titles: the first title with that prefix after `after`, else from the top (wraps).
    static func typeAhead<V: Hashable>(_ rows: [V], title: (V) -> String, prefix: String, after: V?) -> V? {
        let p = key(prefix)
        guard !p.isEmpty else { return nil }
        let start = after.flatMap { rows.firstIndex(of: $0) }.map { $0 + 1 } ?? 0
        let order = Array(rows[min(start, rows.count)...]) + Array(rows[..<min(start, rows.count)])
        return order.first { key(title($0)).hasPrefix(p) }
    }

    static func filterPlaceholder(count: Int, noun: String) -> String { ConsoleMenuWords.filterPlaceholder(count, noun) }

    /// "22" at rest · "2 of 22" while typing.
    static func countWord(shown: Int, of total: Int, typing: Bool) -> String {
        typing ? ConsoleMenuWords.countOf(shown, total) : "\(total)"
    }

    /// The popup's x and width: `max(field, minimum)` wide, leading-aligned with the field and
    /// clamped so it ends `margin` short of the window (a right-rail popup overhangs into the stream).
    static func width(field: CGFloat, minimum: CGFloat, bounds: CGRect, anchorMinX: CGFloat) -> (x: CGFloat, w: CGFloat) {
        let w = min(max(field, minimum), bounds.width - 2 * ConsoleFloatPlacement.margin)
        let x = ConsoleFloatPlacement.clamp(anchorMinX, w, bounds.minX, bounds.maxX)
        return (x, w)
    }

    /// The list's natural height: heads 22, rows 26 or 40.
    static func listHeight<V>(_ sections: [Section<V>], twoLine: Bool) -> CGFloat {
        let rows = sections.reduce(0) { $0 + $1.rows.count }
        let heads = sections.filter { $0.title != nil }.count
        return CGFloat(rows) * (twoLine ? 40 : 26) + CGFloat(heads) * 22
    }

    /// Whether the filter strip is drawn: the site's say, else past eight rows.
    static func showsFilter(_ filter: Bool?, count: Int) -> Bool { filter ?? (count > 8) }
}

// MARK: - The two big sites' words

/// Settings › Audio › Voice and Setup › Voice: the honest groups (Default / Also / All voices —
/// the engine carries no timbre or gender), the default marked, a saved id outside the list
/// kept under its own head.
enum VoiceWords {
    static let `default` = "Default"
    static let also = "Also"
    static let all = "All voices"
    static let noun = "voices"
    static let label = "Voice"
    /// Where an id outside the list came from.
    static let fromEnv = "from env"
    static let alsoIds: Set<String> = ["cedar", "marin"]
    static let defaultId = "ballad"

    /// The voice's name alone (Language is its own row); an unknown id shows as itself.
    static func name(_ id: String) -> String { ConsoleTheme.voiceOptions.first { $0.id == id }?.name ?? id }

    static func group(_ id: String) -> String {
        if id == defaultId { return `default` }
        if alsoIds.contains(id) { return also }
        return ConsoleTheme.voices.contains(id) ? all : ConsoleMenuWords.savedHead
    }

    static func badges(_ id: String) -> [ConsoleBadge.Word] {
        if id == defaultId { return [.default] }
        return ConsoleTheme.voices.contains(id) ? [] : [.saved]
    }

    /// The provenance of a saved id the list does not carry; nil for a listed voice.
    static func meta(_ id: String) -> String? { ConsoleTheme.voices.contains(id) ? nil : fromEnv }
    /// The same as the row's detail column (empty for a listed voice, so the rows stay one line).
    static func detail(_ id: String) -> String { meta(id) ?? "" }

    /// design13: the detail with the open session's voice marked `speaking` (a saved id's provenance
    /// otherwise); nil `speaking` (asleep, or a daemon that did not say) marks nothing.
    static func detail(_ id: String, speaking: String?) -> String {
        id == speaking ? ConsoleMenuWords.speaking : detail(id)
    }

    static func fieldBadge(_ id: String) -> ConsoleBadge.Word? {
        if id == defaultId { return .default }
        return ConsoleTheme.voices.contains(id) ? nil : .saved
    }
}

/// Settings › Brain › Backend and Setup › Brain: every kind's requirement on its row, the
/// exceptional word as a badge, the whole sentence in the foot.
enum BrainWords {
    static let label = "Backend"
    static func needs(_ kind: BrainKind) -> String { kind.needs }

    static func badge(_ kind: BrainKind) -> [ConsoleBadge.Word] {
        switch kind {
        case .codex, .claudeCode: return [.noKey]
        case .local: return [.thisMac]
        default: return []
        }
    }

    static func fieldBadge(_ kind: BrainKind) -> ConsoleBadge.Word? { badge(kind).first }
}

extension HelpCopy {
    /// One line per effort level for the Effort dropdown's foot — five words get a sentence,
    /// no protocol change.
    static func effort(_ level: String) -> String? {
        switch level {
        case "low": return "Fast — a short think, the cheapest turn"
        case "medium": return "Balanced — the everyday setting"
        case "high": return "Deeper — slower, more careful"
        case "xhigh": return "Slow — a long think before every step"
        case "max": return "Slowest — everything the model has"
        default: return nil
        }
    }
}
