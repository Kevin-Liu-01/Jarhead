import Foundation

// The words every surface shares: the Console's tips, the notch's `helpText(for:)`, the dock
// accessibility element and the status item read from here, so a control is described once.
// AppKit-free on purpose (the onboarding harness compiles it beside UI/Motion.swift). Kit step 0
// is the skeleton: the entry shape, a handful of entries, and the `check-copy` rules the harness
// pins. Builders add entries under `HelpCopy.Entry`s as their controls migrate.
//
// Rules (M§7): R1 one line, verb first, no full stop, ≤ 60 characters · R2 one em dash at most ·
// R3 the shortcut last (a keycap in the Console) · R4 figures ` · `-joined · R6 never the visible
// label · R7 never the only carrier · R10 never "you" or "Kevin".

enum HelpCopy {
    /// `name` ≤ 2 words: the control's spoken name and the notch's AX label; `hint` is the tip.
    struct Entry: Equatable {
        let name: String
        let hint: String
        /// The key equivalent, shown last as a keycap (`⌘P`, `⌥⌘.`); nil when there is none.
        var key: String? = nil
    }

    static let maxHintLength = 60
    static let maxNameWords = 2

    // MARK: entries (the seeds; builders add theirs beside these)

    static let go = Entry(name: "Go", hint: "Open the live session", key: "⌘P")
    static let pause = Entry(name: "Pause", hint: "Close the session — the context stays", key: "⌘P")
    static let stop = Entry(name: "Stop", hint: "Stop this turn — the threads carry on", key: "⌥⌘.")
    static let stopAll = Entry(name: "Stop all", hint: "Stop everything", key: "⌘.")
    static let check = Entry(name: "Check", hint: "Probe the brain again")
    static let search = Entry(name: "Search", hint: "Find a line in every conversation", key: "⌘F")
    static let circle = Entry(name: "Circle", hint: "Circle something — needs Screen Recording", key: "⌥⇧C")

    static let all: [Entry] = [go, pause, stop, stopAll, check, search, circle]

    // MARK: check-copy

    /// Every rule the words break, named; empty when the entry is clean. Pure, so the harness
    /// pins it over `all` and over a builder's own table.
    static func violations(_ e: Entry) -> [String] {
        var out: [String] = []
        if e.name.split(separator: " ").count > maxNameWords { out.append("name over \(maxNameWords) words") }
        if e.hint.count > maxHintLength { out.append("hint over \(maxHintLength)") }
        if e.hint.hasSuffix(".") { out.append("full stop") }
        if e.hint.filter({ $0 == "—" }).count > 1 { out.append("two em dashes") }
        if e.hint.contains("\n") { out.append("two lines") }
        if e.hint.lowercased().contains("kevin") { out.append("names Kevin") }
        if e.hint.split(separator: " ").contains(where: { $0.lowercased() == "you" || $0.lowercased() == "your" }) { out.append("says you") }
        if let key = e.key, e.hint.contains(key) { out.append("shortcut in the hint") }
        return out
    }

    /// The hint with its shortcut spelled last, for a surface with no keycap (the notch).
    static func spoken(_ e: Entry) -> String {
        guard let key = e.key else { return e.hint }
        return "\(e.hint) (\(key))"
    }
}
