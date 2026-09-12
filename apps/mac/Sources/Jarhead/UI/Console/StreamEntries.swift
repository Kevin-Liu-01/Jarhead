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
        case .utterance(let t): return "t:\(t.id)"
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

struct LedgerStats: Equatable {
    var sessions = 0
    var utterances = 0
    var delegations = 0
    var billedSeconds: Double = 0
}

enum StreamBuilder {
    static func fromSnapshot(transcript: [TranscriptItem], delegations: [Delegation]) -> [StreamEntry] {
        var out: [StreamEntry] = []
        out.reserveCapacity(transcript.count + delegations.count)
        for t in transcript { out.append(.utterance(t)) }
        for d in delegations { out.append(.delegation(d)) }
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

        for (index, row) in rows.enumerated() {
            switch row.type {
            case "session.started":
                transport = nil
                out.append(.system(SystemEntry(id: "s:\(row.at):\(index)", at: row.at, symbol: "bolt.fill", text: "Session started",
                                               mono: ConsoleFormat.shortId(row.sessionId),
                                               trailing: row.resumedFrom.map { "resumed from \(ConsoleFormat.shortId($0))" })))
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
            default:
                break
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
    /// `pause`, "stopped" after a pressed `stop`, "closed" with neither (an idle sleep);
    /// every other reason (idle, connection_lost, …) is kept as recorded.
    static func closeReason(_ reason: String?, after transport: String? = nil) -> String {
        guard let reason, !reason.isEmpty else { return "closed" }
        guard reason == "close_requested" || reason == "client_closed" else { return reason }
        switch transport {
        case "pause": return "paused"
        case "stop": return "stopped"
        default: return "closed"
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
}
