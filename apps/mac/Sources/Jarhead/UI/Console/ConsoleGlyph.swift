import Foundation

// Every glyph a Console control wears, by name (design13, § The glyph table). The rule: a glyph
// that IS the button's verb goes filled; a glyph that is chrome inside another box — a field's ×,
// a stepper's ±, a chevron, the ⋯ in its ghost tile — stays a line, because the box is its solid.
// Arrows and × have no filled form except the `.circle.fill` family, right on an icon-only button
// of 24 pt or more and wrong inside a field or beside a word; a line glyph beside a word keeps the
// line (the tile is the solid there). `check-kit` pins that every name on `all` is filled or kept —
// and, over the sources (design13 review), that no `systemName:` / `systemImage:` literal is left in
// UI/Console and that every member here is drawn somewhere: `all` describes what is on screen.
// Two surfaces draw their own literals and are not on this enum: the island (UI/Orb/NotchPanel) and the
// transport table (Model/AppState) — the orb harness compiles without the Console kit.

enum ConsoleGlyph {
    // MARK: verbs — filled

    /// Send: a solid arrow, not a disc inside the 32 box.
    static let send = "arrowshape.up.fill"
    /// ↻ on an icon-only button (the Agents head's refresh).
    static let reload = "arrow.clockwise.circle.fill"
    /// Undo / Restore when the strip is too narrow for the word.
    static let undo = "arrow.uturn.backward.circle.fill"
    /// The Agents rail's search button.
    static let search = "magnifyingglass.circle.fill"
    /// A lone dismiss × on a card or a toast.
    static let dismiss = "xmark.circle.fill"
    /// An external link beside its word (Setup's "Get a key", "Open ollama.com").
    static let externalLink = "arrow.up.right.square.fill"
    /// Reveal in Finder (a conversation's file, the Trash) — beside its word and as the file row's mark.
    static let folder = "folder.fill"
    /// The Ledger day's `Live` button back to the Now stream.
    static let live = "bolt.fill"
    /// The status menu's Quit, Ask for everything and Voice ▸ rows.
    static let quit = "power.circle.fill"
    static let ask = "checklist.checked"
    static let voice = "person.wave.2.fill"
    /// Switch now when the composer is too narrow for the word (design13 review: the fit at the window's minimum).
    static let switchVoice = "arrow.triangle.2.circlepath.circle.fill"
    /// The transport (the composer's Stop, the status menu's Mute and Stop, a thread pane's Resume · Pause · Stop, the empty stream's Go), already solid.
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
    /// Row and disclosure chevrons; the menu field's picker chevron; the back buttons' chevron beside their word.
    static let chevron = "chevron.right"
    static let chevronLeft = "chevron.left"
    static let picker = "chevron.up.chevron.down"
    /// The verb menu's ✓ on the current pick — NSMenu draws its own.
    static let checkmark = "checkmark"
    /// The Circled card's skeleton before its screenshot lands — information, not a verb.
    static let scopeMark = "scope"
    /// The stepper's cells.
    static let plus = "plus"
    static let minus = "minus"
    /// Circle something — Kevin's pick, kept.
    static let circle = "pencil.and.outline"
    /// Summon Orb — no filled twin.
    static let summon = "cursorarrow.click.2"
    /// A line glyph beside a word on a ghost button: the tile is the solid.
    static let reloadLine = "arrow.clockwise"
    static let earlierLine = "arrow.up"
    static let newestLine = "arrow.down"
    static let undoLine = "arrow.uturn.backward"

    /// The chrome that stays a line.
    static let keep: Set<String> = [cross, magnifier, ellipsis, chevron, chevronLeft, picker, checkmark, scopeMark, plus, minus, circle, summon,
                                    reloadLine, earlierLine, newestLine, undoLine]

    /// Every name above, for the pin.
    static let all: [String] = [send, reload, undo, search, dismiss, externalLink, folder, live, quit, ask, voice, switchVoice,
                                stop, play, pause, mic, muted, cross, magnifier, ellipsis, chevron, chevronLeft, picker, checkmark, scopeMark,
                                plus, minus, circle, summon, reloadLine, earlierLine, newestLine, undoLine]

    /// The rule as a predicate: filled (`.fill` / `.filled` / `.checked`), or on the keep-list.
    static func filledOrKept(_ name: String) -> Bool {
        name.hasSuffix(".fill") || name.hasSuffix(".filled") || name.hasSuffix(".checked") || keep.contains(name)
    }

    /// The names on `all` that break the rule — empty when the kit is whole.
    static var violations: [String] { all.filter { !filledOrKept($0) } }
}
