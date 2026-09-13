import Foundation

// A thread's held conversation (Model/ThreadStore.swift) as the stream's rows, so a ThreadPane
// draws with the same StreamFeed, cards and step rows as Now: an `utterance` is a row, a
// `delegation` a card (its steps and status were patched in by the store), a `system` entry a
// system line. A `step` or `status` still standing on its own is one whose card is not held
// (above the fold, or a page that carried the delta without the card): it reads as one quiet
// line rather than vanish. Seq order is kept — the engine's order is the record's.

enum ThreadEntries {
    static func build(_ store: ThreadStore?) -> [StreamEntry] {
        guard let store else { return [] }
        var out: [StreamEntry] = []
        out.reserveCapacity(store.entries.count)
        for e in store.entries {
            if let row = entry(e) { out.append(row) }
        }
        return out
    }

    /// One wire entry → one row, or nil for a kind this build does not know (a newer engine's).
    static func entry(_ e: ThreadEntry) -> StreamEntry? {
        switch e.kind {
        case "utterance":
            guard let item = e.item else { return nil }
            return .utterance(item)
        case "delegation":
            guard let d = e.delegation else { return nil }
            return .delegation(d)
        case "system":
            return .system(SystemEntry(id: "ts:\(e.seq)", at: e.at ?? 0, symbol: e.symbol ?? "text.alignleft", text: e.text ?? "",
                                       mono: e.mono, trailing: e.trailing))
        case "step":
            guard let step = e.step else { return nil }
            return .system(SystemEntry(id: "tstep:\(e.seq)", at: step.at, symbol: symbol(step.kind),
                                       text: stepLine(step), mono: ConsoleFormat.shortId(e.delegationId),
                                       tone: step.kind == .error ? .problem : .normal))
        case "status":
            guard let status = e.status else { return nil }
            let meta = ConsoleTheme.delegation(status)
            return .system(SystemEntry(id: "tstat:\(e.seq)", at: e.timings?.doneAt ?? e.timings?.delegatedAt ?? 0, symbol: meta.symbol,
                                       text: "delegation · \(meta.label)", mono: ConsoleFormat.shortId(e.delegationId), trailing: e.summary,
                                       tone: status == .failed ? .problem : .normal))
        default:
            return nil
        }
    }

    /// An orphan step's line: the tool and its outcome, else its text.
    static func stepLine(_ step: DelegationStep) -> String {
        if let tool = step.tool {
            return tool.ok ? "\(tool.name) · ok · \(ConsoleFormat.ms(tool.ms))" : "\(tool.name) · failed · \(ConsoleFormat.ms(tool.ms))"
        }
        let text = step.text ?? step.screenshotPath ?? ""
        return text.isEmpty ? step.kind.rawValue : ConversationFormat.oneLine(text, max: 160)
    }

    /// The step rows' own symbols (StepRow), so an orphan reads the same.
    static func symbol(_ kind: StepKind) -> String {
        switch kind {
        case .thinking: return "ellipsis"
        case .commentary: return "speaker.wave.2.fill"
        case .tool: return "terminal.fill"
        case .screenshot: return "photo.fill"
        case .confirm: return "hand.raised.fill"
        case .error: return "exclamationmark.triangle.fill"
        case .note: return "text.alignleft"
        }
    }
}
