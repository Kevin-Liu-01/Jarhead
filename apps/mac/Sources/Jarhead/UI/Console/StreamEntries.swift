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

        for (index, row) in rows.enumerated() {
            switch row.type {
            case "session.started":
                out.append(.system(SystemEntry(id: "s:\(row.at):\(index)", at: row.at, symbol: "bolt.fill", text: "Session started",
                                               mono: ConsoleFormat.shortId(row.sessionId), trailing: nil)))
            case "session.closed":
                let reason = row.reason ?? "closed"
                out.append(.system(SystemEntry(id: "c:\(row.at):\(index)", at: row.at, symbol: "moon.fill", text: "Session closed · \(reason)",
                                               trailing: "\(ConsoleFormat.minutes(row.usageSeconds ?? 0)) billed")))
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
