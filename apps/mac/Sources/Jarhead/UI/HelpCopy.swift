import Foundation

// The words every surface shares: the Console's tips, the notch's `helpText(for:)`, the dock
// accessibility element and the status item read from here, so a control is described once.
// AppKit-free on purpose (the onboarding harness compiles it beside UI/Motion.swift). The entry
// shape, the table, and the `check-copy` rules the harness pins over the whole table. Builders
// add entries beside these as their controls migrate; a name that varies (a thread's) is a func.
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

    // MARK: the transport and the composers

    static let go = Entry(name: "Go", hint: "Open the live session", key: "⌘P")
    static let pause = Entry(name: "Pause", hint: "Close the session — the context stays", key: "⌘P")
    static let stop = Entry(name: "Stop", hint: "Stop this turn — the threads carry on", key: "⌥⌘.")
    static let stopAll = Entry(name: "Stop all", hint: "Stop everything — close the session, sleep", key: "⌘.")
    static let check = Entry(name: "Check", hint: "Probe the brain again")
    static let search = Entry(name: "Search", hint: "Find a line in every conversation", key: "⌘F")
    static let circle = Entry(name: "Circle", hint: "Circle something — needs Screen Recording", key: "⌥⇧C")
    static let mute = Entry(name: "Mute", hint: "Stop sending — the session and the mic stay open")
    static let unmute = Entry(name: "Unmute", hint: "Listen again")
    static let send = Entry(name: "Send", hint: "Send the line", key: "⏎")
    static let sendAsleep = Entry(name: "Send", hint: "Asleep: the engine keeps the words — press Go", key: "⏎")
    static let sendYes = Entry(name: "Allow", hint: "Send “yes” to the session")
    static let sendNo = Entry(name: "Deny", hint: "Send “no” to the session")
    static let allow = Entry(name: "Allow", hint: "Yes — a click, never Return")
    static let deny = Entry(name: "Deny", hint: "No — the question is dropped")

    // MARK: the stream and the panes

    static let backStream = Entry(name: "Stream", hint: "Back to the live stream")
    static let backStreamEsc = Entry(name: "Stream", hint: "Back to the live stream — Esc from the composer")
    static let backNow = Entry(name: "Now", hint: "Back to Now — Esc from the composer", key: "⌘0")
    static let latest = Entry(name: "Latest", hint: "Jump to the latest")
    static let undoCleared = Entry(name: "Undo", hint: "Bring the cleared items back")
    static let retryPage = Entry(name: "Try again", hint: "Ask the engine for the page again")
    static let undoMove = Entry(name: "Undo", hint: "Put it back where it was", key: "⌘Z")
    static let liveThread = Entry(name: "Live", hint: "Live — the thread is working")
    static let liveWriting = Entry(name: "Live", hint: "Live — the session is writing")
    static let liveQuiet = Entry(name: "Live", hint: "Live — following the session; quiet for now")
    static let pinned = Entry(name: "Pinned", hint: "Kept at the top of the rail")
    static let restoreTrash = Entry(name: "Restore", hint: "Back from the Trash")
    static let restoreArchive = Entry(name: "Restore", hint: "Back from Archived")
    static let logView = Entry(name: "Log", hint: "Every ledger row of this conversation")
    static let conversationView = Entry(name: "Conversation", hint: "The conversation as the stream showed it")

    /// The threads' verbs carry the thread's name; the rule set is the same.
    static func resumeThread(_ name: String) -> Entry { Entry(name: "Resume", hint: "Resume \(name) — one continuation turn") }
    static func pauseThread(_ name: String) -> Entry { Entry(name: "Pause", hint: "Pause \(name) — its turn stops, its place is kept") }
    static func stopThread(_ name: String) -> Entry { Entry(name: "Stop", hint: "Stop \(name) — the others carry on", key: "⌥⌘.") }
    static func allowThread(_ name: String) -> Entry { Entry(name: "Allow", hint: "Yes to \(name) — a click, never Return") }
    static func denyThread(_ name: String) -> Entry { Entry(name: "Deny", hint: "No — \(name) drops the question") }
    static func sendMode(_ words: String?) -> Entry { words.map { Entry(name: "Send", hint: "Send — \($0)", key: "⏎") } ?? send }

    // MARK: automations (design11) — the ring's presses, a row's verbs, the recipes

    /// Snooze carries the minutes the island's press would use (Settings.snoozeMinutes).
    static func snooze(_ minutes: Int) -> Entry { Entry(name: "Snooze", hint: "Snooze — rings again in \(minutes) min", key: "⌥⇧S") }
    static let done = Entry(name: "Done", hint: "Done — stops the ring, the row stays")
    static let skip = Entry(name: "Skip", hint: "Skip — the next fire rolls past without ringing")
    static let pauseAutomation = Entry(name: "Pause", hint: "Pause — keeps it, fires nothing")
    static let runNow = Entry(name: "Run now", hint: "Fire it now — only while someone is here to hear it")
    static let trashAutomation = Entry(name: "Trash", hint: "Move to Trash — hidden, restorable, never deleted")
    static let addRecipe = Entry(name: "Add recipe", hint: "Name a command a routine may run unattended")
    static let asksRecipe = Entry(name: "Asks", hint: "The shell gate would ask about this — listed, never armed")

    // MARK: audio (design12) — the island's mute box while the guard holds, the recording chip, the menu row

    /// The mute box while the software echo guard holds the wire (Recording, or the fallback rung).
    static let micHeld = Entry(name: "Mute", hint: "Mic held while he speaks — a word over him opens it")
    /// The peek chip while Recording is on (a glyph, no figure).
    static let recordingChip = Entry(name: "Recording", hint: "Recording — mic shared, echo guarded")
    /// The status menu row (and the Dock menu's); the key rides last as the menu's own equivalent.
    static let recordingRow = Entry(name: "Recording", hint: "Hand back the mic, guard the echo — apps keep their sound", key: "⌥⇧R")

    // MARK: voices (design13) — the composer chip, Switch now at rest and while work runs

    /// The composer's `🇬🇧 Ballad ⌄` chip: a pick is free; only Switch now (or Kevin asking aloud) pays.
    static let voiceChip = Entry(name: "Voice", hint: "Voice and accent — a pick is free; Switch now hears it")
    /// Switch now: one paid restart, behind this press alone.
    static let switchVoice = Entry(name: "Switch now", hint: "Pause, then resume on the new voice — one restart")
    /// The same button while a delegation or a thread runs (the engine refuses the reopen).
    static let switchVoiceBusy = Entry(name: "Switch now", hint: "Pause, then resume on the new voice — not while work runs")

    static let all: [Entry] = [go, pause, stop, stopAll, check, search, circle, mute, unmute, send, sendAsleep, sendYes, sendNo, allow, deny,
                               backStream, backStreamEsc, backNow, latest, undoCleared, retryPage, undoMove, liveThread, liveWriting, liveQuiet,
                               pinned, restoreTrash, restoreArchive, logView, conversationView,
                               resumeThread("Slack"), pauseThread("Slack"), stopThread("Slack"), allowThread("Slack"), denyThread("Slack"),
                               sendMode("queued in Codex"),
                               snooze(10), done, skip, pauseAutomation, runNow, trashAutomation, addRecipe, asksRecipe,
                               micHeld, recordingChip, recordingRow,
                               voiceChip, switchVoice, switchVoiceBusy]

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

/// design12: the words the island, the status menu and the harness spell Recording with. Here rather than
/// beside `RingWords` (NotchPanel.swift) because check-kit compiles UI/ without UI/Orb; every literal once.
enum RecordingWords {
    /// The head badge, the tucked chip's name: lowercase, titanium — a resting state, not an alarm.
    static let badge = "recording"
    /// `helpText(for: .mute)` while the guard holds (HelpCopy.micHeld, so check-copy pins it).
    static let heldTip = HelpCopy.micHeld.hint
    /// Appended to the mute box's tooltip while Recording is on.
    static let recordingSuffix = " · recording"
    /// Appended while another process reads the mic: ` · shared with QuickTime Player`.
    static func sharedSuffix(_ name: String) -> String { " · shared with \(name)" }
    /// The peek chip: `record.circle`, no figure, this tooltip.
    static let chipGlyph = "record.circle"
    static let chipTip = HelpCopy.recordingChip.hint
    /// The status menu row: the title never flips (the checkmark is the state), the tooltip carries the key last.
    static let menuRow = HelpCopy.recordingRow.name
    static let menuTip = HelpCopy.recordingRow.hint
    static let menuKey = HelpCopy.recordingRow.key ?? ""
    static var menuTipSpoken: String { HelpCopy.spoken(HelpCopy.recordingRow) }
    /// The menu tooltip's shared tail: ` · shared with QuickTime Player` after the key.
    static func menuTip(sharedWith name: String?) -> String { menuTipSpoken + (name.map(sharedSuffix) ?? "") }
    /// Bundle ids or `pid:<n>` from the HAL → the first process's name, or nil while nobody shares.
    static func firstShared(_ names: [String]?) -> String? { names?.first }
}
