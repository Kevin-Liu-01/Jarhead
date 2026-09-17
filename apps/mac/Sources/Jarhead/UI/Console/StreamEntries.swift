import Foundation

// The stream is one chronological list. Entries are built from a live Snapshot
// or reconstructed from a day of ledger rows; both render identically.

struct SystemEntry: Equatable, Identifiable {
    enum Tone: Equatable { case normal, problem }
    let id: String
    let at: Double
    let symbol: String
    let text: String
    var mono: String? = nil
    var trailing: String? = nil
    var agentStatus: AgentStatus? = nil
    var tone: Tone = .normal
}

enum StreamEntry: Identifiable, Equatable {
    case utterance(TranscriptItem)
    case delegation(Delegation)
    case system(SystemEntry)

    var id: String {
        switch self {
        // id + clock: the engine numbers utterances per daemon life now, but day files written before that carry
        // `t_1…` per session, and a ForEach with two equal ids draws the first row for both. `at` is set once.
        case .utterance(let t): return "t:\(t.id)@\(Int(t.at))"
        case .delegation(let d): return "d:\(d.id)"
        case .system(let s): return s.id
        }
    }

    var at: Double {
        switch self {
        case .utterance(let t): return t.at
        case .delegation(let d): return d.createdAt
        case .system(let s): return s.at
        }
    }
}

extension StreamEntry {
    /// The threads this row draws: the ones a delegation card started (`Thread.parentDelegationId`),
    /// in the rail's order; none for an utterance or a system line — so a thread turning
    /// re-evaluates its card and no other row (StreamRow is Equatable over its threads).
    func threads(from all: [WorkThread]) -> [WorkThread] {
        guard case .delegation(let d) = self, !all.isEmpty else { return [] }
        return AppState.railOrder(all.filter { $0.parentDelegationId == d.id })
    }
}

struct LedgerStats: Equatable {
    var sessions = 0
    var utterances = 0
    var delegations = 0
    var billedSeconds: Double = 0
}

enum StreamBuilder {
    /// `clearedAt`: Kevin cleared the Now stream then (AppState.nowClearedAt) — items at or
    /// before it are hidden here at once, and by the engine's snapshot a round trip later.
    static func fromSnapshot(transcript: [TranscriptItem], delegations: [Delegation], clearedAt: Double? = nil) -> [StreamEntry] {
        var out: [StreamEntry] = []
        out.reserveCapacity(transcript.count + delegations.count)
        for t in transcript where clearedAt.map({ t.at > $0 }) ?? true { out.append(.utterance(t)) }
        for d in delegations where clearedAt.map({ d.createdAt > $0 }) ?? true { out.append(.delegation(d)) }
        out.sort { $0.at < $1.at }
        return out
    }

    /// Rebuilds delegations from created/step/finished rows so a past day reads
    /// exactly like it did live. System ids carry the row index: the engine
    /// writes problem rows back to back, so two rows can share a millisecond.
    static func fromLedger(_ rows: [LedgerRow]) -> [StreamEntry] {
        var out: [StreamEntry] = []
        var delegations: [String: Delegation] = [:]
        var order: [String] = []
        // The last transport row: what a close the engine asked for meant (ConsoleFormat.closeReason).
        var transport: String?
        // A thread's name, from its `thread.started` row, for the rows that carry only its id.
        var threadNames: [String: String] = [:]
        // An automation, from its `automation.set` row, for the fired / state / missed rows that carry only its id (design11).
        var automationRows: [String: Automation] = [:]
        // The voice and accent the last session opened on: a `session.started` resumed on another
        // pair is the voice switch, and reads as one mono row (design13).
        var spoken: ConsoleFormat.Spoken?

        for (index, row) in rows.enumerated() {
            switch row.type {
            case "thread.started":
                // A thread's life on the record: one line when it starts, one when it ends (below);
                // the status rows between (starting, the waits, paused) are the log's, not the stream's.
                guard let t = row.thread else { break }
                threadNames[t.id] = t.name
                if let l = ConsoleFormat.tombstone(row) {
                    out.append(.system(SystemEntry(id: "th:\(row.at):\(index)", at: row.at, symbol: l.symbol, text: ConsoleFormat.sentence(l.text), mono: l.mono, trailing: l.trailing)))
                }
            case "thread.ended":
                guard row.threadId != nil, let l = ConsoleFormat.tombstone(row) else { break }
                let name = row.threadId.flatMap { threadNames[$0] } ?? ConsoleFormat.shortId(row.threadId)
                out.append(.system(SystemEntry(id: "th:\(row.at):\(index)", at: row.at, symbol: l.symbol, text: ConsoleFormat.sentence(l.text.replacingOccurrences(of: "%NAME%", with: name)),
                                               mono: l.mono, trailing: l.trailing, tone: row.status == .failed ? .problem : .normal)))
            case "thread.said":
                // What the engine spoke for a thread ("Spotify: playing Focus."), on the record as a line.
                guard let text = row.text, !text.isEmpty else { break }
                let name = row.threadId.flatMap { threadNames[$0] } ?? ConsoleFormat.shortId(row.threadId)
                out.append(.system(SystemEntry(id: "th:\(row.at):\(index)", at: row.at, symbol: "waveform", text: "\(name): \(text)")))
            case "thread.status":
                break
            case "session.started":
                transport = nil
                if let line = ConsoleFormat.voiceSwitchLine(row, before: spoken) {
                    // The one visible line of a Switch now: the words are the mono column's (titanium), the glyph the Voice row's.
                    // It is the record's line: the live Now stream is built from the snapshot (`fromSnapshot`), whose transcript
                    // and delegations carry no session rows and whose `session` names no `resumedFrom` or previous voice —
                    // live, the switch is the toast and "Marin here." in the new voice; the Ledger day shows this row.
                    out.append(.system(SystemEntry(id: "s:\(row.at):\(index)", at: row.at, symbol: ConsoleGlyph.voice, text: "", mono: line)))
                } else {
                    out.append(.system(SystemEntry(id: "s:\(row.at):\(index)", at: row.at, symbol: "bolt.fill", text: "Session started",
                                                   mono: ConsoleFormat.shortId(row.sessionId),
                                                   trailing: row.resumedFrom.map { "resumed from \(ConsoleFormat.shortId($0))" })))
                }
                if let voice = row.voice { spoken = ConsoleFormat.Spoken(voice: voice, accent: row.accent) }
            case "session.closed":
                let reason = ConsoleFormat.closeReason(row.reason, after: transport)
                out.append(.system(SystemEntry(id: "c:\(row.at):\(index)", at: row.at, symbol: "moon.fill",
                                               text: reason == "closed" ? "Session closed" : "Session closed · \(reason)",
                                               trailing: "\(TransportFormat.minutes(row.usageSeconds ?? 0)) billed")))
            case "pause":
                // A pause closes the Live session: the meter stops, the conversation is held.
                transport = "pause"
                out.append(.system(SystemEntry(id: "pz:\(row.at):\(index)", at: row.at, symbol: "pause.fill", text: "Paused · meter stopped",
                                               trailing: row.usageSeconds.map { "\(TransportFormat.minutes($0)) billed" })))
            case "resume":
                out.append(.system(SystemEntry(id: "rs:\(row.at):\(index)", at: row.at, symbol: "play.fill",
                                               text: ConsoleFormat.sentence(ConsoleFormat.resumedAfter(row.pausedMs)),
                                               mono: row.resumedFrom.map { ConsoleFormat.shortId($0) })))
            case "stop":
                // Only a pressed stop closes the session; a spoken one keeps it listening.
                if row.how == "pressed" { transport = "stop" }
                out.append(.system(SystemEntry(id: "st:\(row.at):\(index)", at: row.at, symbol: "stop.fill",
                                               text: ConsoleFormat.sentence(ConsoleFormat.stopped(row.how)),
                                               trailing: row.cancelled.map { "cancelled \(ConsoleFormat.shortId($0))" })))
            case "heard", "said":
                if let item = row.item { out.append(.utterance(item)) }
            case "delegation.created":
                if let d = row.delegation {
                    delegations[d.id] = d
                    order.append(d.id)
                }
            case "delegation.step":
                if let id = row.delegationId, let step = row.step, var d = delegations[id] {
                    d.steps.append(step)
                    if step.kind == .thinking, d.timings.firstThinkingAt == nil { d.timings.firstThinkingAt = step.at }
                    if step.kind == .commentary, d.timings.firstCommentaryAt == nil { d.timings.firstCommentaryAt = step.at }
                    delegations[id] = d
                }
            case "delegation.finished":
                if let id = row.delegationId, var d = delegations[id] {
                    if let status = row.status { d.status = status }
                    // The Swift LedgerRow carries no `timings`; the row's wall clock is the close.
                    if d.timings.doneAt == nil { d.timings.doneAt = row.at }
                    if let summary = row.summary { d.summary = summary }
                    delegations[id] = d
                }
            case "problem":
                out.append(.system(SystemEntry(id: "p:\(row.at):\(index)", at: row.at, symbol: "exclamationmark.triangle.fill",
                                               text: row.text ?? "Problem", tone: .problem)))
            case "agent":
                if let a = row.agent {
                    out.append(.system(SystemEntry(id: "a:\(row.at):\(index):\(a.id)", at: row.at, symbol: "terminal.fill", text: a.name,
                                                   trailing: a.detail, agentStatus: a.status)))
                }
            case "sleep":
                // Jarhead went to sleep: the row says why, and the cue when one was spoken. It is
                // written before the close, so the `session.closed` that follows reads "asleep · why"
                // (ConsoleFormat.closeReason) — the server's own word says nothing about it. A
                // pressed Stop's sleep row is the close's bookkeeping: the stop row above it is the
                // record and the close reads "stopped"; it gets no moon of its own.
                transport = "sleep:" + (row.sleepCause ?? "command")
                if row.sleepCause != "stop", let t = ConsoleFormat.tombstone(row) {
                    out.append(.system(SystemEntry(id: "zz:\(row.at):\(index)", at: row.at, symbol: t.symbol, text: ConsoleFormat.sentence(t.text), mono: t.mono, trailing: t.trailing)))
                }
            case "automation.set", "automation.fired", "automation.state", "automation.missed":
                // The record of what the daemon carried out asleep: "07:10 · Wake up · fired · 12 min late", "snoozed until 07:20",
                // "done"; a miss wears the problem tone. The set row names the row for the ones after it.
                if let a = row.automation { automationRows[a.id] = a }
                if let t = ConsoleFormat.tombstone(row, automation: row.rowId.flatMap { automationRows[$0] }) {
                    out.append(.system(SystemEntry(id: "au:\(row.at):\(index)", at: row.at, symbol: t.symbol, text: ConsoleFormat.sentence(t.text), mono: t.mono, trailing: t.trailing,
                                                   tone: row.type == "automation.missed" ? .problem : .normal)))
                }
            default:
                // The cleanup's tombstone rows read as terse system lines: "Moved to Trash", "Restored",
                // "Renamed". A type the Console does not know yields no line and is skipped — including
                // the `worker` rows in day files from before 2026-09-13.
                if let t = ConsoleFormat.tombstone(row) {
                    out.append(.system(SystemEntry(id: "tb:\(row.at):\(index)", at: row.at, symbol: t.symbol, text: ConsoleFormat.sentence(t.text), mono: t.mono, trailing: t.trailing)))
                }
            }
        }
        for id in order { if let d = delegations[id] { out.append(.delegation(d)) } }
        out.sort { $0.at < $1.at }
        return out
    }

    static func stats(_ rows: [LedgerRow]) -> LedgerStats {
        var s = LedgerStats()
        for row in rows {
            switch row.type {
            case "session.started": s.sessions += 1
            case "heard", "said": s.utterances += 1
            case "delegation.created": s.delegations += 1
            case "session.closed": s.billedSeconds += row.usageSeconds ?? 0
            default: break
            }
        }
        return s
    }
}

// MARK: - The transport rows' words (pure)

extension ConsoleFormat {
    /// The voice and accent a `session.started` row opened on.
    struct Spoken: Equatable {
        let voice: String
        let accent: String?
    }

    /// design13: a `session.started` row resumed from another session (`resumedFrom`) on a voice or
    /// accent the last one did not speak is the Switch now the stream shows as one mono row —
    /// `voice → Marin 🇬🇧 · one restart · 0.7 s` (`ms` when the row carries it). A plain resume on the
    /// same pair keeps its "Session started · resumed from" line; nil when the row is not a resume,
    /// names no voice, or the day has no earlier session to compare with.
    static func voiceSwitchLine(_ row: LedgerRow, before: Spoken?) -> String? {
        guard row.resumedFrom != nil, let voice = row.voice, let before else { return nil }
        let now = Spoken(voice: voice, accent: row.accent)
        guard now != before else { return nil }
        return VoiceSwitchWords.switched(name: VoiceWords.name(voice), flag: row.accent.flatMap(AccentWords.flag), ms: row.ms)
    }

    /// "resumed after 3 min" · "resumed after 12 s" · "resumed" when the row does not say.
    static func resumedAfter(_ pausedMs: Double?) -> String {
        guard let ms = pausedMs, ms.isFinite, ms >= 0 else { return "resumed" }
        return "resumed after \(pausedFor(ms))"
    }

    /// A pause's length in words: "12 s", "3 min", "1 h 5 min".
    static func pausedFor(_ ms: Double) -> String {
        let s = Int((ms / 1000).rounded())
        if s < 60 { return "\(s) s" }
        let m = s / 60
        if m < 60 { return "\(m) min" }
        let h = m / 60, rest = m % 60
        return rest == 0 ? "\(h) h" : "\(h) h \(rest) min"
    }

    /// "stopped (pressed)" · "interrupted (said)".
    static func stopped(_ how: String?) -> String {
        how == "said" ? "interrupted (said)" : "stopped (pressed)"
    }

    /// The server's word for a close the engine asked for (`close_requested`) — or ours
    /// when it had to force one (`client_closed`) — says nothing about why; the
    /// transport row before it does. Mirrors `Ledger.sessions()`: "paused" after a
    /// `pause`, "stopped" after a pressed `stop`, "asleep · why" after a `sleep` row
    /// (`transport` "sleep:<cause>"), "closed" with none (a close no transport row preceded);
    /// every other reason (idle, connection_lost, …) is kept as recorded — except the
    /// engine's own sleep label, "sleep:<cause>", which reads the same as the row.
    static func closeReason(_ reason: String?, after transport: String? = nil) -> String {
        guard let reason, !reason.isEmpty else { return "closed" }
        if let words = sleepWords(reason) { return words }
        guard reason == "close_requested" || reason == "client_closed" else { return reason }
        switch transport {
        case "pause": return "paused"
        case "stop": return "stopped"
        default: return transport.flatMap(sleepWords) ?? "closed"
        }
    }

    /// "sleep:<cause>" → "asleep · <cause words>"; a pressed Stop's sleep (`sleep:stop`) stays
    /// "stopped" — the stop row before it is the record, as today. nil for anything else.
    static func sleepWords(_ label: String) -> String? {
        guard let cause = SleepCauseFormat.cause(fromCloseReason: label) else { return nil }
        return cause == "stop" ? "stopped" : SleepCauseFormat.line(cause)
    }

    /// A `thread.ended` row's status is the wire's "done" | "failed" | "stopped", which the loosely
    /// typed LedgerRow decodes as a DelegationStatus ("stopped" is not one and lands on the
    /// decoder's default, `running`): the thread words, with the default read as stopped.
    static func threadEndWords(_ s: DelegationStatus) -> String {
        switch s {
        case .done: return "done"
        case .failed: return "failed"
        case .cancelled, .running, .awaitingConfirmation: return "stopped"
        }
    }

    /// The tombstone's symbol from the same word (ConsoleTheme.thread's settled set), so a
    /// stopped thread never wears the checkmark: done → check, failed → octagon, stopped → slash.
    static func threadEndSymbol(_ words: String) -> String {
        switch words {
        case "done": return ConsoleTheme.thread(.done).symbol
        case "failed": return ConsoleTheme.thread(.failed).symbol
        default: return ConsoleTheme.thread(.stopped).symbol
        }
    }

    /// "HH:mm" — the rail's meta line has no room for seconds.
    static func clock(_ ms: Double) -> String {
        let t = time(ms)
        return t.count > 5 ? String(t.prefix(5)) : t
    }

    /// First letter up, for the stream's system lines; the log keeps them lower.
    static func sentence(_ s: String) -> String {
        guard let first = s.first else { return s }
        return first.uppercased() + s.dropFirst()
    }

    // MARK: the cleanup's tombstone rows

    /// A tombstone row as one terse line: the solid symbol, the log's kind column, the
    /// words (lower case; the stream capitalises), a mono figure and a trailing note. nil
    /// for any other row. `conversation.trashed` by retention says so; `ledger.moved` names
    /// the day, what moved and where. The `sleep` row is the moon: "asleep · said" with the
    /// cue in quotes. A `thread.started` / `thread.ended` row is "Spotify · started" / "Spotify ·
    /// done" with its lane in mono.
    static func tombstone(_ row: LedgerRow, automation: Automation? = nil) -> (symbol: String, kind: String, text: String, mono: String?, trailing: String?)? {
        switch row.type {
        case "automation.set", "automation.fired", "automation.state", "automation.missed":
            return automationTombstone(row, automation: row.automation ?? automation)
        case "recipe.set":
            guard let r = row.recipe else { return nil }
            return ("terminal.fill", "recipe", "recipe “\(r.name)” saved", truncPath(r.command, max: 40), row.by == "brain" ? "approved by voice" : nil)
        case "recipe.trashed":
            return ("trash.fill", "recipe", "recipe “\(row.name ?? "")” moved to Trash", nil, nil)
        case "recipe.restored":
            return ("arrow.uturn.backward", "recipe", "recipe “\(row.name ?? "")” back from the Trash", nil, nil)
        case "sleep":
            return ("moon.zzz.fill", "sleep", SleepCauseFormat.line(row.sleepCause ?? "command"), row.sessionId.map { shortId($0) }, row.quotedPhrase)
        case "thread.started":
            // The whole record rides the row: "Spotify · started" with its lane in mono and the brief trailing.
            guard let t = row.thread else { return nil }
            return (ConsoleTheme.threadsSymbol, "thread", "\(t.name) · started", ConsoleTheme.lane(t.lane), t.task.isEmpty ? nil : t.task)
        case "thread.ended":
            // The row carries the id, not the name: the caller fills %NAME% from the started row it saw.
            guard row.threadId != nil else { return nil }
            let status = row.status.map { ConsoleFormat.threadEndWords($0) } ?? "done"
            let figures = [row.steps.map { "\($0) step\($0 == 1 ? "" : "s")" }, row.seconds.map { duration($0) }].compactMap { $0 }.joined(separator: " · ")
            return (ConsoleFormat.threadEndSymbol(status), "thread", "%NAME% · \(status)", figures.isEmpty ? nil : figures, row.summary)
        case "conversation.trashed":
            return ("trash.fill", "trash", "moved to Trash", nil, row.by == "retention" ? "by retention" : nil)
        case "conversation.restored":
            return ("arrow.uturn.backward", "restore", "restored", nil, nil)
        case "conversation.archived":
            return ("archivebox.fill", "archive", "archived", nil, nil)
        case "conversation.renamed":
            let name = row.name ?? ""
            return ("pencil", "rename", name.isEmpty ? "name cleared · back to the auto title" : "renamed to “\(name)”", nil, nil)
        case "conversation.pinned":
            let on = row.pinned ?? true
            return (on ? "pin.fill" : "pin.slash.fill", "pin", on ? "pinned" : "unpinned", nil, nil)
        case "now.cleared":
            return ("eraser.fill", "clear", "Now cleared · the ledger keeps the rows", row.sessionId.map { shortId($0) }, nil)
        case "now.restored":
            return ("arrow.uturn.backward", "clear", "Now restored", row.sessionId.map { shortId($0) }, nil)
        case "ledger.moved":
            let what = row.what ?? "ledger"
            let to = row.to == "trash" ? "to the Trash" : "back from the Trash"
            let by = row.by == "retention" ? " · by retention" : ""
            return ("folder.fill", "moved", "\(row.day ?? "day") \(what) moved \(to)\(by)", nil, row.path.map { truncPath($0, max: 40) })
        case "agent.hidden":
            let on = row.hidden ?? true
            return (on ? "eye.slash.fill" : "eye.fill", "agent", on ? "agent hidden from the rail" : "agent shown again", row.agentId.map { shortId($0, 12) }, nil)
        case "grant":
            let until = row.until.map { " · until \(clock($0))" } ?? ""
            return ("checkmark.seal.fill", "grant", "granted \(row.app ?? "app") · \(row.actionClass ?? "action") for this conversation\(until)", nil, nil)
        case "audio.guard":
            // design12: the software echo guard's per-turn counters — "guard held 1.2 s · gated 12 of 340 · 0 breaks", the
            // session in mono, "fallback rung" trailing when the unit refused and the guard was the backstop.
            return ("mic.fill", "audio", guardWords(row), row.sessionId.map { shortId($0) }, row.fallback == true ? "fallback rung" : nil)
        default:
            return nil
        }
    }

    /// The `audio.guard` row's words: the held time as seconds to one place (absent when the row has none), the gated
    /// chunks over the total, the break-throughs — every figure the engine wrote, none invented.
    static func guardWords(_ row: LedgerRow) -> String {
        var parts: [String] = []
        if let held = row.heldMs { parts.append(String(format: "guard held %.1f s", held / 1000)) } else { parts.append("guard on") }
        parts.append("gated \(row.gated ?? 0) of \(row.chunks ?? 0)")
        let breaks = row.breakthroughs ?? 0
        parts.append("\(breaks) break\(breaks == 1 ? "" : "s")")
        return parts.joined(separator: " · ")
    }

    /// The automation rows as one line each (design11): the kind's glyph and word when the row is known (its `set`
    /// row went by, or the row itself carries it), else the plain automation glyph and word; `fired` reads the line the
    /// daemon rang with, how late, and what it did; `state` the new state (`snoozed until 07:20`, `done`, `moved to
    /// Trash`); `missed` when it was due and why. A `firing` state row is bookkeeping and yields no line.
    static func automationTombstone(_ row: LedgerRow, automation: Automation?) -> (symbol: String, kind: String, text: String, mono: String?, trailing: String?)? {
        let kind = automation?.kind
        let symbol = automationSymbol(kind)
        let word = kind?.rawValue ?? "automation"
        let name = automation?.name ?? row.line ?? ""
        switch row.type {
        case "automation.set":
            guard let a = row.automation else { return nil }
            return (symbol, word, "\(a.name) · armed", nil, a.echo)
        case "automation.fired":
            let line = row.line ?? name
            return (symbol, word, "\(line) · \(row.ok == false ? "failed" : "fired")", row.lateMs.map { lateWords($0) }, row.detail)
        case "automation.state":
            guard let state = row.state, state != "firing" else { return nil }
            var parts: [String] = []
            if !name.isEmpty { parts.append(name) }
            parts.append(stateWords(state, until: row.until))
            return (symbol, word, parts.joined(separator: AutomationWords.dot), nil, row.detail)
        case "automation.missed":
            // One statement per word (CI's older Swift gives up on ternaries concatenating inside one interpolation).
            var parts: [String] = []
            if !name.isEmpty { parts.append(name) }
            parts.append(row.skipped == true ? "skipped" : "missed")
            if let dueAt = row.dueAt { parts.append("due " + clock(dueAt)) }
            if let why = row.why { parts.append(missedWhyWords(why)) }
            return ("clock.badge.exclamationmark", word, parts.joined(separator: AutomationWords.dot), row.lateMs.map { lateWords($0) }, nil)
        default:
            return nil
        }
    }

    /// The kind's glyph (the rail's), or the plain clock for a row whose kind the log does not know.
    static func automationSymbol(_ kind: AutomationKindWord?) -> String {
        switch kind {
        case .alarm: return "alarm.fill"
        case .timer: return "timer"
        case .reminder: return "bell.fill"
        case .routine: return "repeat"
        case .watcher: return "eye.fill"
        case nil: return "clock.fill"
        }
    }

    /// `snoozed until 07:20` · `done` · `paused` · `moved to Trash` · `failed` — the state's word, Kevin's vocabulary.
    static func stateWords(_ state: String, until: Double?) -> String {
        switch state {
        case "snoozed": return until.map { "snoozed until \(clock($0))" } ?? "snoozed"
        case "trashed": return "moved to Trash"
        default: return state
        }
    }

    /// `12 min late` · `40 s late`.
    static func lateWords(_ ms: Double) -> String {
        ms >= 60_000 ? "\(Int((ms / 60_000).rounded())) min late" : "\(Int((ms / 1000).rounded())) s late"
    }

    /// The MissedWhy words: `Jarhead was off` · `the Mac slept` · `quiet hours` · `the brain budget was spent`.
    static func missedWhyWords(_ why: String) -> String {
        switch why {
        case "daemon-down": return "Jarhead was off"
        case "mac-slept": return "the Mac slept"
        case "quiet-hours": return "quiet hours"
        case "budget": return "the brain budget was spent"
        default: return why
        }
    }
}
