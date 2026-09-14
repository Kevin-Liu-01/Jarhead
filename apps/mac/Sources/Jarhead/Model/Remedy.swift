import Foundation

// A typed problem's remedy (`ProblemRemedy.command`, the wire's `{type, …}`) as the case the
// app can send. One table, read from either of the two shapes a remedy reaches the app in:
// the Console holds it decoded (`[String: JSONValue]`), the notch's pill holds it as the JSON
// text it was given and reads it back with JSONSerialization (`[String: Any]`).

extension EngineCommand {
    /// The Console's shape: the remedy as `Snapshot.problems` decoded it. nil for a type the
    /// app does not know, when the caller falls back to `problem.retry` for the kind.
    public init?(remedyJSON o: [String: JSONValue]) {
        guard case .string(let type)? = o["type"] else { return nil }
        self.init(remedyType: type,
                  str: { key in if case .string(let s)? = o[key] { return s } else { return nil } },
                  bool: { key in if case .bool(let b)? = o[key] { return b } else { return nil } })
    }

    /// The notch's shape: the same remedy read back from its JSON text with JSONSerialization.
    public init?(remedyJSON o: [String: Any]) {
        guard let type = o["type"] as? String else { return nil }
        self.init(remedyType: type, str: { o[$0] as? String }, bool: { o[$0] as? Bool })
    }

    /// The one table: the remedy's type and its string / bool fields → the case.
    private init?(remedyType type: String, str: (String) -> String?, bool: (String) -> Bool?) {
        switch type {
        case "sleep":
            // With a cause the ledger records it ("dock", "command"); without, today's bare sleep.
            if let cause = str("cause"), !cause.isEmpty { self = .sleepCause(cause) } else { self = .sleep }
        case "mute": self = .mute
        case "unmute": self = .unmute
        case "stop": self = .stop
        case "go": self = .go
        case "pause": self = .pause
        case "resume": self = .resume
        case "interrupt": self = .interrupt(how: str("how") ?? "pressed")
        case "clear-problems": self = .clearProblems
        case "agent.refresh": self = .agentRefresh
        case "daemon.restart": self = .daemonRestart
        case "config.probe": self = .probeSetup
        case "open-console": self = .openConsole
        case "open-ledger": self = .openLedger
        case "ledger.sweep": self = .ledgerSweep
        case "conversation.new": self = .conversationNew
        case "now.clear": self = .nowClear
        case "now.restore": self = .nowRestore
        case "mark.clear": self = .markClear
        case "mark.remove":
            // The × on one circled thumbnail; the engine ignores an id it does not hold.
            guard let id = str("id"), !id.isEmpty else { return nil }
            self = .markRemove(id: id)
        case "mark.window": self = .markWindow
        case "request-permission":
            guard let which = str("which") else { return nil }
            self = .requestPermission(which)
        case "problem.retry":
            guard let kind = str("kind") else { return nil }
            self = .problemRetry(kind: kind)
        case "agent.hide":
            guard let id = str("agentId") else { return nil }
            self = .agentHide(agentId: id, hidden: bool("hidden") ?? true)
        case "thread.stop":
            // One thread, never the transport: the session and the other threads stay.
            guard let id = str("threadId"), !id.isEmpty else { return nil }
            self = .threadStop(threadId: id)
        case "ledger.restore-day":
            guard let day = str("day") else { return nil }
            self = .ledgerRestoreDay(day: day)
        case "ledger.trash-day":
            guard let day = str("day") else { return nil }
            self = .ledgerTrashDay(day: day, what: str("what") ?? "both")
        case "automation.run":
            // "Run now" on a missed alarm; the engine refuses it unless Kevin is there to hear it.
            guard let id = str("id"), !id.isEmpty else { return nil }
            self = .automationRun(id: id)
        case "automation.resume":
            guard let id = str("id"), !id.isEmpty else { return nil }
            self = .automationResume(id: id)
        case "automation.restore":
            guard let id = str("id"), !id.isEmpty else { return nil }
            self = .automationRestore(id: id)
        default:
            return nil
        }
    }
}
