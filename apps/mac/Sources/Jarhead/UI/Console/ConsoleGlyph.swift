import Foundation

// Every glyph a Console control wears, by name (design13, § The glyph table). The rule: a glyph
// that IS the button's verb goes filled; a glyph that is chrome inside another box — a field's ×,
// a stepper's ±, a chevron, the ⋯ in its ghost tile — stays a line, because the box is its solid.
// Arrows and × have no filled form except the `.circle.fill` family, right on an icon-only button
// of 24 pt or more and wrong inside a field or beside a word; a line glyph beside a word keeps the
// line (the tile is the solid there). `check-kit` pins that every name on `all` is filled or kept.

enum ConsoleGlyph {
    // MARK: verbs — filled

    /// Send: a solid arrow, not a disc inside the 32 box.
    static let send = "arrowshape.up.fill"
    /// ↻ on an icon-only button (the Agents head's refresh).
    static let reload = "arrow.clockwise.circle.fill"
    /// Undo / Restore when the strip is too narrow for the word.
    static let undo = "arrow.uturn.backward.circle.fill"
    /// Jump to newest / Load earlier as icon-only 24 chips.
    static let newest = "arrow.down.circle.fill"
    static let earlier = "arrow.up.circle.fill"
    /// The Agents rail's search button.
    static let search = "magnifyingglass.circle.fill"
    /// A lone dismiss × on a card or a toast.
    static let dismiss = "xmark.circle.fill"
    /// An external link beside its word (Setup's "Get a key", "Open ollama.com").
    static let externalLink = "arrow.up.right.square.fill"
    /// The island's Window box, beside its three filled neighbours.
    static let islandWindow = "rectangle.inset.filled"
    /// The status menu's Quit, Ask for everything and Voice ▸ rows.
    static let quit = "power.circle.fill"
    static let ask = "checklist.checked"
    static let voice = "person.wave.2.fill"
    /// Switch now when the composer is too narrow for the word (design13 review: the fit at the window's minimum).
    static let switchVoice = "arrow.triangle.2.circlepath.circle.fill"
    /// The transport, already solid.
    static let stop = "stop.fill"
    static let play = "play.fill"
    static let pause = "pause.fill"
    static let mic = "mic.fill"
    static let muted = "mic.slash.fill"

    // MARK: chrome — kept as lines

    /// × inside a field, a filter strip or a selection strip.
    static let cross = "xmark"
    /// The filter field's magnifier.
    static let magnifier = "magnifyingglass"
    /// The ⋯ in its ghost tile.
    static let ellipsis = "ellipsis"
    /// Row and disclosure chevrons; the menu field's picker chevron.
    static let chevron = "chevron.right"
    static let picker = "chevron.up.chevron.down"
    /// The stepper's cells.
    static let plus = "plus"
    static let minus = "minus"
    /// Circle something — Kevin's pick, kept.
    static let circle = "pencil.and.outline"
    /// Summon Orb — no filled twin.
    static let summon = "cursorarrow.click.2"
    /// The island's timer pill — information, not a verb.
    static let timer = "timer"
    /// Connecting "…" on the transport — a state, not a verb.
    static let connecting = "ellipsis"
    /// A line glyph beside a word on a ghost button: the tile is the solid.
    static let reloadLine = "arrow.clockwise"
    static let earlierLine = "arrow.up"
    static let newestLine = "arrow.down"
    static let undoLine = "arrow.uturn.backward"

    /// The chrome that stays a line.
    static let keep: Set<String> = [cross, magnifier, ellipsis, chevron, picker, plus, minus, circle, summon, timer,
                                    reloadLine, earlierLine, newestLine, undoLine]

    /// Every name above, for the pin.
    static let all: [String] = [send, reload, undo, newest, earlier, search, dismiss, externalLink, islandWindow, quit, ask, voice, switchVoice,
                                stop, play, pause, mic, muted, cross, magnifier, ellipsis, chevron, picker, plus, minus, circle,
                                summon, timer, connecting, reloadLine, earlierLine, newestLine, undoLine]

    /// The rule as a predicate: filled (`.fill` / `.filled` / `.checked`), or on the keep-list.
    static func filledOrKept(_ name: String) -> Bool {
        name.hasSuffix(".fill") || name.hasSuffix(".filled") || name.hasSuffix(".checked") || keep.contains(name)
    }

    /// The names on `all` that break the rule — empty when the kit is whole.
    static var violations: [String] { all.filter { !filledOrKept($0) } }
}
