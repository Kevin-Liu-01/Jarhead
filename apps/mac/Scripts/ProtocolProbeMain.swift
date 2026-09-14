import Foundation

// Contract probe: decodes captured daemon frames with the app's own Codable mirrors
// (Model/Protocol.swift) and `jarheadJSONDecoder`, the way Daemon/EngineClient.swift
// does it — the frame read as [String: Any], the `snapshot` sub-object re-serialised
// and decoded as Snapshot, every `ledger.rows` row decoded on its own so one odd row
// never hides the day. Not part of the package; compiled only by
// Scripts/protocol-probe.sh over the Model and Console sources and this file (the Console
// sources for ConsoleFormat.tombstone and StreamBuilder, which the old-rows check below
// drives) — no window, no AppState instance, no daemon.
//
// What it proves over Scripts/fixtures/snapshot-threads.json (a JSON array of frames in
// packages/protocol's shapes — the probe is what keeps the fixture faithful to the contract):
//   - the whole capture decodes: Settings with every required field present (`threads`, the
//     language / accent / memory / observe / typedWakes / threadOverflow / warmThreads knobs),
//     `permissions.all` row for row, `problems` typed (kind, text, remedy), `setup`, `marks`
//     and `threads` present in every snapshot;
//   - `DelegationStep.thread` (the [Name] tag) survives on snapshot steps and `delegation.step`
//     rows; `sleep` ledger rows keep their columns (cause, phrase, sessionId, farewell);
//   - the commands the app sends encode as the daemon's isEngineCommand expects:
//     {"type":"sleep","cause":…} and the eight thread.* commands
//     ({"type":"thread.open","threadId":…,"viewer":…} …);
//   - the ONE compatibility, over the three rows appended to the fixture's `ledger.rows` frame
//     as day files before 2026-09-13 hold them: a row of the retired type decodes (all-optional
//     columns) and is skipped — ConsoleFormat.tombstone is nil, StreamBuilder yields no entry; a
//     `delegation.step` whose step carries the retired key decodes with step.thread nil (the tag
//     is lost, the step is main's); a `session.started` without `language` decodes with language nil;
//   - threads: `snapshot.threads` record for record against the raw
//     JSON — a status or lane this app does not know decodes to .thinking / .background, a
//     live thread never reads as finished — plus `Delegation.threadId` / `stepCount`,
//     `TranscriptItem.source`, the new Settings knobs; every `thread.event` kind
//     (started … ended) as ThreadEvent; a `thread.transcript` page with every entry kind
//     (utterance, delegation, step, status, system) as ThreadTranscript, cursor and all;
//     `overlay` orb.fly / orb.trace carrying their `thread` tag (absent = the main blob);
//     and the `thread.started` / `thread.status` / `thread.said` / `thread.ended` ledger rows —
//     their `status` and `detail` columns fail-closed where the mirror carries them, and a
//     distinct `warn` line where it does not yet (today: LedgerRow.status is DelegationStatus?,
//     so a ThreadStatus outside that enum reads as .running; LedgerRow has no `detail`). The
//     columns are read through reflection, so the same source tightens itself the day
//     Protocol.swift gains them; PROBE_STRICT=1 fails the warns.
// One block per fixture; exits 1 when any check fails, 2 on usage.
@main
struct ProtocolProbeMain {
    static func main() {
        setlinebuf(stdout)
        let paths = Array(CommandLine.arguments.dropFirst())
        guard !paths.isEmpty else {
            FileHandle.standardError.write(Data("usage: protocol-probe <capture.json>...\n".utf8))
            exit(2)
        }
        var probe = Probe()
        probe.commands()
        for path in paths { probe.capture(path) }
        print("")
        let gaps = probe.warnings == 0 ? "" : " · \(probe.warnings) mirror gap\(probe.warnings == 1 ? "" : "s") (warn; PROBE_STRICT=1 fails them)"
        print(probe.failures == 0 ? "ok · \(probe.checks) checks\(gaps)" : "FAILED · \(probe.failures) of \(probe.checks) checks\(gaps)")
        exit(probe.failures == 0 ? 0 : 1)
    }
}

struct Probe {
    var checks = 0
    var failures = 0
    /// Known mirror gaps — a column the wire carries that Protocol.swift does not yet — printed as
    /// `warn`, counted apart from the checks so the run stays green today and the gap stays visible
    /// in every run's last line; PROBE_STRICT=1 makes each one a failure.
    var warnings = 0
    let strict = ProcessInfo.processInfo.environment["PROBE_STRICT"] == "1"

    mutating func check(_ ok: Bool, _ what: String) {
        checks += 1
        if !ok { failures += 1 }
        print("  \(ok ? "ok  " : "FAIL") \(what)")
    }

    mutating func warn(_ what: String) {
        if strict { check(false, what); return }
        warnings += 1
        print("  warn \(what)")
    }

    /// EngineClient's `decode(_:)`: re-serialise the sub-object, decode with the shared decoder.
    func decode<T: Decodable>(_ any: Any) -> T? {
        guard JSONSerialization.isValidJSONObject(any), let data = try? JSONSerialization.data(withJSONObject: any) else { return nil }
        return try? jarheadJSONDecoder.decode(T.self, from: data)
    }

    // MARK: - app → daemon

    mutating func commands() {
        print("commands (app → daemon):")
        let dock = EngineCommand.sleepCause("dock").json
        check(dock["type"] as? String == "sleep" && dock["cause"] as? String == "dock", "sleepCause(\"dock\") → \(compact(dock))")
        let bare = EngineCommand.sleep.json
        check(bare["type"] as? String == "sleep" && bare["cause"] == nil, ".sleep stays the bare sleep → \(compact(bare))")

        // The eight thread.* commands, as packages/protocol's ENGINE_COMMAND_TYPES spells them.
        let open = EngineCommand.threadOpen(threadId: "t_9a1c", viewer: "p1").json
        check(open["type"] as? String == "thread.open" && open["threadId"] as? String == "t_9a1c" && open["viewer"] as? String == "p1", "threadOpen → \(compact(open))")
        let openBare = EngineCommand.threadOpen(threadId: "main", viewer: nil).json
        check(openBare["type"] as? String == "thread.open" && openBare["threadId"] as? String == "main" && openBare["viewer"] == nil, "threadOpen without a pane sends no viewer (the daemon fills \"pane\") → \(compact(openBare))")
        let close = EngineCommand.threadClose(threadId: "t_9a1c", viewer: "p1").json
        check(close["type"] as? String == "thread.close" && close["threadId"] as? String == "t_9a1c" && close["viewer"] as? String == "p1", "threadClose → \(compact(close))")
        let history = EngineCommand.threadHistory(threadId: "t_9a1c", before: 120).json
        check(history["type"] as? String == "thread.history" && history["threadId"] as? String == "t_9a1c" && history["before"] as? Int == 120, "threadHistory(before: a seq) → \(compact(history))")
        let tstop = EngineCommand.threadStop(threadId: "main").json
        check(tstop["type"] as? String == "thread.stop" && tstop["threadId"] as? String == "main", "threadStop(main) parks the main turn, never the transport's stop → \(compact(tstop))")
        let pause = EngineCommand.threadPause(threadId: "t_b02d").json
        check(pause["type"] as? String == "thread.pause" && pause["threadId"] as? String == "t_b02d", "threadPause → \(compact(pause))")
        let resume = EngineCommand.threadResume(threadId: "t_b02d").json
        check(resume["type"] as? String == "thread.resume" && resume["threadId"] as? String == "t_b02d", "threadResume → \(compact(resume))")
        let answer = EngineCommand.threadAnswer(threadId: "t_9a1c", yes: true).json
        check(answer["type"] as? String == "thread.answer" && answer["threadId"] as? String == "t_9a1c" && answer["yes"] as? Bool == true, "threadAnswer(yes: true) → \(compact(answer))")
        let deny = EngineCommand.threadAnswer(threadId: "t_9a1c", yes: false).json
        check(deny["yes"] as? Bool == false, "threadAnswer(yes: false) → \(compact(deny))")
        let say = EngineCommand.threadSay(threadId: "t_b02d", text: "skip this song").json
        check(say["type"] as? String == "thread.say" && say["threadId"] as? String == "t_b02d" && say["text"] as? String == "skip this song", "threadSay → \(compact(say))")
        let eight = Set([open, close, history, tstop, pause, resume, answer, say].compactMap { $0["type"] as? String })
        check(eight == ["thread.open", "thread.close", "thread.history", "thread.stop", "thread.pause", "thread.resume", "thread.answer", "thread.say"], "exactly eight thread.* command types")
    }

    // MARK: - daemon → app

    mutating func capture(_ path: String) {
        let name = (path as NSString).lastPathComponent
        print("")
        print("\(name):")
        guard let data = FileManager.default.contents(atPath: path) else { check(false, "readable at \(path)"); return }
        guard let frames = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] else { check(false, "a JSON array of daemon frames"); return }
        check(!frames.isEmpty, "\(frames.count) frames")
        for (i, obj) in frames.enumerated() {
            guard let type = obj["type"] as? String else { check(false, "frame \(i) has a type"); continue }
            switch type {
            case "hello":
                print("  hello · daemon \(obj["version"] as? String ?? "?") · pid \(obj["pid"] as? Int ?? 0) · \(obj["stateDir"] as? String ?? "?")")
            case "snapshot":
                snapshot(obj["snapshot"], frame: i)
            case "ledger.rows":
                rows(obj["rows"], frame: i)
            case "thread.event":
                threadEvent(obj["event"], frame: i)
            case "thread.transcript":
                threadTranscript(obj["transcript"], mode: obj["mode"] as? String, frame: i)
            case "overlay":
                overlay(obj["command"], frame: i)
            default:
                print("  \(type) · not decoded here (EngineClient handles or ignores it)")
            }
        }
    }

    mutating func snapshot(_ sub: Any?, frame: Int) {
        guard let sub, let snap: Snapshot = decode(sub) else { check(false, "frame \(frame): snapshot decodes"); return }
        let raw = sub as? [String: Any] ?? [:]
        var line = "frame \(frame): snapshot decodes · phase \(snap.phase.rawValue)"
        if let s = snap.session { line += " · session \(s.id) · \(Int(s.usageSeconds)) s" }
        check(true, line)

        // Steps, and the thread tag on each: the decoded `thread` column must equal the raw one,
        // step for step — a renamed key or a dropped optional would silently lose the [Name] tag.
        let steps = snap.delegations.flatMap(\.steps)
        let rawSteps = (raw["delegations"] as? [[String: Any]] ?? []).flatMap { ($0["steps"] as? [[String: Any]]) ?? [] }
        let byThreads = steps.map(\.thread)
        let rawByThreads = rawSteps.map { $0["thread"] as? String }
        let tags = Set(byThreads.compactMap { $0 }).sorted().joined(separator: ", ")
        let named = byThreads.compactMap { $0 }.count
        check(steps.count == rawSteps.count && byThreads == rawByThreads,
              "delegations \(snap.delegations.count) · steps \(steps.count) · \(named == 0 ? "none by spawned threads" : "\(named) by spawned threads: \(tags)") (as raw)")

        // Permissions: the row list, kind for kind and grant for grant.
        let rawPerms = (raw["permissions"] as? [String: Any])?["all"] as? [[String: Any]]
        let permsOk = rawPerms != nil && snap.permissions.all.count == (rawPerms?.count ?? -1)
            && zip(snap.permissions.all, rawPerms ?? []).allSatisfy { $0.kind.rawValue == $1["kind"] as? String && $0.grant.rawValue == $1["grant"] as? String && $0.required == $1["required"] as? Bool }
        check(permsOk, "permissions.all \(snap.permissions.all.count) rows · \(snap.permissions.all.filter { $0.grant == .granted }.count) granted · missing required \(snap.permissions.missingRequired.map(\.rawValue)) (as raw)")

        // Problems: typed, kind and remedy label for label.
        let rawProblems = raw["problems"] as? [[String: Any]] ?? []
        let problemsOk = snap.problems.count == rawProblems.count
            && zip(snap.problems, rawProblems).allSatisfy { $0.kind == $1["kind"] as? String && $0.text == $1["text"] as? String && $0.remedy?.label == ($1["remedy"] as? [String: Any])?["label"] as? String }
        check(problemsOk, "problems \(snap.problems.count)\(snap.problems.isEmpty ? "" : ": " + snap.problems.map { "\($0.kind) → \($0.remedy?.label ?? "Retry")" }.joined(separator: ", ")) (as raw)")
        check(snap.marks.count == (raw["marks"] as? [Any])?.count, "marks \(snap.marks.count) · setup \(snap.setup.brain.rawValue) · \(snap.setup.brainResolved?.rawValue ?? "unresolved") (as raw)")

        // Threads: count against the raw array, every record against its raw JSON, and the
        // live / spawned splits the rail and the fleet read — a status this app does not know
        // must read as a live thinking thread, never as finished (a satellite would vanish).
        let rawThreads = raw["threads"] as? [[String: Any]] ?? []
        check(raw["threads"] != nil && snap.threads.count == rawThreads.count, "threads \(snap.threads.count) (\(snap.liveThreads.count) live · \(snap.spawnedLiveThreads.count) spawned live)")
        for (t, rt) in zip(snap.threads, rawThreads) {
            let (ok, what) = threadMatches(t, rt)
            check(ok, what)
        }
        let rawLive = rawThreads.filter { !threadTerminal.contains($0["status"] as? String ?? "") }.count
        let rawSpawned = rawThreads.filter { !threadTerminal.contains($0["status"] as? String ?? "") && $0["id"] as? String != "main" }.count
        check(snap.liveThreads.count == rawLive && snap.spawnedLiveThreads.count == rawSpawned,
              "liveThreads \(snap.liveThreads.count) = raw statuses outside done/failed/stopped; spawned live \(snap.spawnedLiveThreads.map(\.name).joined(separator: ", "))")

        // A thread's delegation keeps its threadId and (in the small snapshot) its stepCount, card for card.
        let rawDelegations = raw["delegations"] as? [[String: Any]] ?? []
        let byThread = snap.delegations.map(\.threadId)
        let rawByThread = rawDelegations.map { $0["threadId"] as? String }
        let stepCounts = snap.delegations.map(\.stepCount)
        let rawStepCounts = rawDelegations.map { $0["stepCount"] as? Int }
        let threaded = byThread.compactMap { $0 }
        check(byThread == rawByThread && stepCounts == rawStepCounts,
              "delegations by thread: \(threaded.isEmpty ? "all main" : threaded.joined(separator: ", ")) · stepCount \(stepCounts.compactMap { $0 }) (as raw)")

        // Typed lines are on the record with their source; spoken ones carry none.
        let rawItems = raw["transcript"] as? [[String: Any]] ?? []
        let sources = snap.transcript.map(\.source)
        check(sources == rawItems.map { $0["source"] as? String }, "transcript \(snap.transcript.count) · \(sources.compactMap { $0 }.count) typed (source as raw)")

        // The settings, every required field as sent.
        let rs = raw["settings"] as? [String: Any] ?? [:]
        let knobsOk = snap.settings.threads == rs["threads"] as? Bool && snap.settings.observe == rs["observe"] as? Bool
            && snap.settings.typedWakes == rs["typedWakes"] as? Bool && snap.settings.threadOverflow == rs["threadOverflow"] as? String
            && snap.settings.warmThreads == rs["warmThreads"] as? Int && snap.settings.language == rs["language"] as? String
            && snap.settings.accent == rs["accent"] as? String && snap.settings.memory == rs["memory"] as? Bool
            && snap.settings.onboarded == rs["onboarded"] as? Bool && snap.settings.reflexes == rs["reflexes"] as? Bool
            && snap.settings.orbHome == rs["orbHome"] as? String && snap.settings.wake.enabled == (rs["wake"] as? [String: Any])?["enabled"] as? Bool
            && snap.settings.ledgerRetentionDays == rs["ledgerRetentionDays"] as? Int && snap.settings.shotsRetentionDays == rs["shotsRetentionDays"] as? Int
        let knobs = "threads \(snap.settings.threads) · observe \(snap.settings.observe) · typedWakes \(snap.settings.typedWakes) · threadOverflow \(snap.settings.threadOverflow) · warmThreads \(snap.settings.warmThreads) · \(snap.settings.language) / \(snap.settings.accent) · memory \(snap.settings.memory) · notch \(snap.settings.livesInNotch)"
        check(knobsOk, "settings \(knobs) (as raw)")
    }

    /// A decoded thread against its raw JSON: every column verbatim; status and lane verbatim
    /// when this app knows the string, the documented default (.thinking / .background) when not.
    func threadMatches(_ t: WorkThread, _ rt: [String: Any]) -> (Bool, String) {
        let rawStatus = rt["status"] as? String ?? "?"
        let rawLane = rt["lane"] as? String ?? "?"
        let knownStatus = ThreadStatus(rawValue: rawStatus) != nil
        let knownLane = ThreadLane(rawValue: rawLane) != nil
        var what = "\(t.name) · \(t.lane.rawValue) · \(t.status.rawValue)"
        if !knownStatus { what += " (raw \"\(rawStatus)\" unknown to this app → .thinking)" }
        if !knownLane { what += " (raw lane \"\(rawLane)\" unknown to this app → .background)" }
        what += " · \(t.turns) turn(s) · \(t.steps) steps · \(t.status.isLive ? (t.status.isBusy ? "busy" : "idle") : "finished")"
        if let q = t.question { what += " · asks \"\(q)\"" }
        if let app = t.app { what += " · in \(app)" }
        let statusOk = knownStatus ? t.status.rawValue == rawStatus : t.status == .thinking
        let laneOk = knownLane ? t.lane.rawValue == rawLane : t.lane == .background
        let budget = rt["budget"] as? [String: Any]
        let at = rt["at"] as? [String: Any]
        let idsOk = t.id == rt["id"] as? String && t.name == rt["name"] as? String && t.parentId == rt["parentId"] as? String
            && t.parentDelegationId == rt["parentDelegationId"] as? String && t.liveId == rt["liveId"] as? String && t.currentDelegationId == rt["currentDelegationId"] as? String
        let textOk = t.task == rt["task"] as? String && t.detail == rt["detail"] as? String && t.question == rt["question"] as? String
            && t.lastScreenshotPath == rt["lastScreenshotPath"] as? String && t.apps == (rt["apps"] as? [String] ?? []) && t.app == rt["app"] as? String
        let countsOk = t.steps == rt["steps"] as? Int && t.turns == rt["turns"] as? Int && t.waits == rt["waits"] as? Int
            && t.budget.steps == budget?["steps"] as? Int && t.budget.seconds == budget?["seconds"] as? Int
            && t.canSay == rt["canSay"] as? Bool && t.canStop == rt["canStop"] as? Bool
        let timesOk = t.startedAt == (rt["startedAt"] as? NSNumber)?.doubleValue && t.updatedAt == (rt["updatedAt"] as? NSNumber)?.doubleValue
            && t.doneAt == (rt["doneAt"] as? NSNumber)?.doubleValue
            && t.at?.x == (at?["x"] as? NSNumber)?.doubleValue && t.at?.y == (at?["y"] as? NSNumber)?.doubleValue
        return (statusOk && laneOk && idsOk && textOk && countsOk && timesOk, what)
    }

    /// One `thread.event` frame: decoded as ThreadEvent, its head verbatim, and the fields its kind promises present and as raw.
    mutating func threadEvent(_ sub: Any?, frame: Int) {
        guard let sub, let raw = sub as? [String: Any], let e: ThreadEvent = decode(sub) else { check(false, "frame \(frame): thread.event decodes"); return }
        let size = (try? JSONSerialization.data(withJSONObject: sub))?.count ?? 0
        var what = "frame \(frame): thread.event \(e.kind) · seq \(e.seq) · \(e.threadId) · \(size) B"
        let headOk = e.kind == raw["kind"] as? String && e.seq == raw["seq"] as? Int && e.threadId == raw["threadId"] as? String && e.at == (raw["at"] as? NSNumber)?.doubleValue
        var kindOk: Bool
        switch e.kind {
        case "started":
            if let t = e.thread, let rt = raw["thread"] as? [String: Any] {
                let (ok, tw) = threadMatches(t, rt)
                kindOk = ok
                what += " · \(tw)"
            } else { kindOk = false; what += " · no thread record" }
        case "status":
            let rawStatus = raw["status"] as? String ?? "?"
            let known = ThreadStatus(rawValue: rawStatus) != nil
            kindOk = (known ? e.status?.rawValue == rawStatus : e.status == .thinking) && e.detail == raw["detail"] as? String
            what += " · \(e.status?.rawValue ?? "nil")\(known ? "" : " (raw \"\(rawStatus)\" → .thinking)")\(e.detail.map { " · \($0)" } ?? "")"
        case "step":
            kindOk = e.steps == raw["steps"] as? Int && e.tool == raw["tool"] as? String && e.ok == raw["ok"] as? Bool
            what += " · \(e.steps ?? -1) steps · \(e.tool ?? "?") \(e.ok == true ? "ok" : "failed")"
        case "turn":
            kindOk = e.delegationId == raw["delegationId"] as? String && e.request == raw["request"] as? String && e.delegationId != nil && e.request != nil
            what += " · \(e.delegationId ?? "?") · \"\(e.request ?? "")\""
        case "question":
            kindOk = e.question == raw["question"] as? String && e.question != nil
            what += " · \"\(e.question ?? "")\""
        case "said":
            kindOk = e.text == raw["text"] as? String && e.text != nil
            what += " · \"\(e.text ?? "")\""
        case "at":
            kindOk = e.x == (raw["x"] as? NSNumber)?.doubleValue && e.y == (raw["y"] as? NSNumber)?.doubleValue && e.app == raw["app"] as? String && e.x != nil && e.y != nil
            what += " · (\(e.x ?? 0), \(e.y ?? 0))\(e.app.map { " in \($0)" } ?? "")"
        case "ended":
            kindOk = e.status?.rawValue == raw["status"] as? String && e.summary == raw["summary"] as? String && e.status.map { !$0.isLive } == true
            what += " · \(e.status?.rawValue ?? "nil")\(e.summary.map { " · \($0)" } ?? "")"
        default:
            kindOk = false
            what += " · a kind this probe does not know"
        }
        check(headOk && kindOk, what)
    }

    /// One `thread.transcript` frame: the page's head and cursor verbatim, then every entry against its raw JSON by kind.
    mutating func threadTranscript(_ sub: Any?, mode: String?, frame: Int) {
        guard let sub, let raw = sub as? [String: Any], let t: ThreadTranscript = decode(sub) else { check(false, "frame \(frame): thread.transcript decodes"); return }
        let rawEntries = raw["entries"] as? [[String: Any]] ?? []
        let rawCursor = raw["cursor"] as? [String: Any]
        let cursorOk = t.cursor?.startSeq == rawCursor?["startSeq"] as? Int && t.cursor?.endSeq == rawCursor?["endSeq"] as? Int
        let headOk = t.threadId == raw["threadId"] as? String && t.total == raw["total"] as? Int && t.complete == raw["complete"] as? Bool && t.live == raw["live"] as? Bool
            && t.readMs == (raw["readMs"] as? NSNumber)?.doubleValue && t.entries.count == rawEntries.count
        let size = (try? JSONSerialization.data(withJSONObject: sub))?.count ?? 0
        let cursor = t.cursor.map { " · seq \($0.startSeq)…\($0.endSeq)" } ?? " · no cursor"
        let read = t.readMs.map { " · read \($0) ms" } ?? ""
        check(headOk && cursorOk, "frame \(frame): thread.transcript \(mode ?? "?") · \(t.threadId) · \(t.entries.count) entries of \(t.total) · \(t.complete ? "complete" : "partial") · \(t.live ? "live" : "closed")\(cursor)\(read) · \(size) B")
        for (e, re) in zip(t.entries, rawEntries) {
            let (ok, what) = entryMatches(e, re)
            check(ok, "  entry \(what)")
        }
    }

    /// A decoded ThreadEntry against its raw JSON: kind and seq verbatim, and the fields its kind carries.
    func entryMatches(_ e: ThreadEntry, _ re: [String: Any]) -> (Bool, String) {
        var what = "\(e.seq) \(e.kind)"
        let headOk = e.kind == re["kind"] as? String && e.seq == re["seq"] as? Int
        var kindOk: Bool
        switch e.kind {
        case "utterance":
            let ri = re["item"] as? [String: Any]
            kindOk = e.item != nil && e.item?.id == ri?["id"] as? String && e.item?.text == ri?["text"] as? String && e.item?.source == ri?["source"] as? String
            what += " · \(e.item?.speaker.rawValue ?? "?")\(e.item?.source == "typed" ? " (typed)" : ""): \"\(e.item?.text ?? "")\""
        case "delegation":
            let rd = re["delegation"] as? [String: Any]
            kindOk = e.delegation != nil && e.delegation?.id == rd?["id"] as? String && e.delegation?.threadId == rd?["threadId"] as? String
                && e.delegation?.stepCount == rd?["stepCount"] as? Int && e.delegation?.steps.count == (rd?["steps"] as? [Any])?.count
            what += " · \(e.delegation?.id ?? "?") · thread \(e.delegation?.threadId ?? "main") · \(e.delegation?.steps.count ?? 0) steps\(e.delegation?.stepCount.map { " of \($0)" } ?? "") · \(e.delegation?.status.rawValue ?? "?")"
        case "step":
            let rs = re["step"] as? [String: Any]
            kindOk = e.delegationId == re["delegationId"] as? String && e.delegationId != nil && e.step != nil && e.step?.id == rs?["id"] as? String && e.step?.kind.rawValue == rs?["kind"] as? String
            what += " · \(e.delegationId ?? "?") · \(e.step?.kind.rawValue ?? "?")\(e.step?.tool.map { " \($0.name)" } ?? "")\(e.step?.text.map { " \"\($0)\"" } ?? "")"
        case "status":
            let rt = re["timings"] as? [String: Any]
            kindOk = e.delegationId == re["delegationId"] as? String && e.delegationId != nil && e.status?.rawValue == re["status"] as? String
                && e.summary == re["summary"] as? String && e.timings?.delegatedAt == (rt?["delegatedAt"] as? NSNumber)?.doubleValue && e.timings != nil
            what += " · \(e.delegationId ?? "?") → \(e.status?.rawValue ?? "?")\(e.summary.map { " · \($0)" } ?? "")"
        case "system":
            kindOk = e.at == (re["at"] as? NSNumber)?.doubleValue && e.at != nil && e.symbol == re["symbol"] as? String && e.symbol != nil
                && e.text == re["text"] as? String && e.text != nil && e.mono == re["mono"] as? String && e.trailing == re["trailing"] as? String
            what += " · \(e.symbol ?? "?") \(e.text ?? "")\(e.mono.map { " · \($0)" } ?? "")\(e.trailing.map { " · \($0)" } ?? "")"
        default:
            kindOk = false
            what += " · a kind this probe does not know"
        }
        return (headOk && kindOk, what)
    }

    /// An `overlay` frame: orb.fly / orb.trace read their `thread` tag (absent = the main blob); other commands are only decoded.
    mutating func overlay(_ sub: Any?, frame: Int) {
        guard let json = sub as? [String: Any], let cmd = OverlayCommand(json: json) else { check(false, "frame \(frame): overlay decodes"); return }
        let rawThread = json["thread"] as? String
        switch cmd {
        case .orbFly(let x, let y, let dwellMs, let reason, let thread):
            let ok = thread == rawThread && x == (json["x"] as? NSNumber)?.doubleValue && y == (json["y"] as? NSNumber)?.doubleValue && dwellMs == (json["dwellMs"] as? NSNumber)?.doubleValue
            check(ok, "frame \(frame): overlay orb.fly (\(x), \(y)) · \(thread.map { "thread \($0)" } ?? "the main blob (no tag)")\(reason.map { " · \($0)" } ?? "")")
        case .orbTrace(let points, _, _, _, _, _, let thread):
            check(thread == rawThread && points.count == (json["points"] as? [Any])?.count, "frame \(frame): overlay orb.trace \(points.count) points · \(thread.map { "thread \($0)" } ?? "the main blob (no tag)")")
        default:
            print("  frame \(frame): overlay \(json["cmd"] as? String ?? "?") · decoded, not checked here")
        }
    }

    mutating func rows(_ any: Any?, frame: Int) {
        guard let raw = any as? [Any] else { check(false, "frame \(frame): ledger.rows carries rows"); return }
        // EngineClient.decodeRows: one row at a time, a bad row skipped. In a fixture every row
        // is well formed, so a skipped one is a column the mirror lost — that fails.
        var pairs: [(raw: [String: Any], row: LedgerRow)] = []
        var skipped: [String] = []
        for row in raw {
            let dict = row as? [String: Any] ?? [:]
            if let r: LedgerRow = decode(row) { pairs.append((dict, r)) } else { skipped.append(dict["type"] as? String ?? "?") }
        }
        check(skipped.isEmpty, "frame \(frame): \(pairs.count) of \(raw.count) rows decode\(skipped.isEmpty ? "" : "; skipped \(skipped.joined(separator: ", "))")")
        print("  row types: \(pairs.map(\.row.type).joined(separator: " "))")

        // delegation.step rows: the thread tag, row for row, as raw (nil where the main brain ran it).
        let stepRows = pairs.filter { $0.row.type == "delegation.step" }
        if !stepRows.isEmpty {
            let decodedTags = stepRows.map { $0.row.step?.thread }
            let rawTags = stepRows.map { ($0.raw["step"] as? [String: Any])?["thread"] as? String }
            let named = rawTags.compactMap { $0 }
            check(decodedTags == rawTags && stepRows.allSatisfy { $0.row.step != nil },
                  "\(stepRows.count) delegation.step rows → \(named.isEmpty ? "no thread tags" : "thread tags \(named.joined(separator: ", "))") (as raw)")
        }

        // The ONE compatibility: rows as day files before 2026-09-13 hold them decode and are skipped, never a crash.
        print("  rows from before 2026-09-13:")
        let oldTypeRows = pairs.filter { $0.row.type == "worker" } // the row type day files before 2026-09-13 hold
        check(!oldTypeRows.isEmpty, "the fixture carries a `worker` row, a step keyed `worker` and a session.started without language (before 2026-09-13)")
        for (_, r) in oldTypeRows {
            let noLine = StreamBuilder.fromLedger([r]).isEmpty
            check(ConsoleFormat.tombstone(r) == nil && noLine, "a `\(r.type)` row (before 2026-09-13) decodes as \(r.id) and is skipped: tombstone nil, no stream entry")
        }
        for (rw, r) in stepRows where (rw["step"] as? [String: Any])?["worker"] != nil { // the step key from before 2026-09-13
            check(r.step != nil && r.step?.thread == nil, "a delegation.step whose step says `worker` (before 2026-09-13) decodes with step.thread nil — the tag is lost, the step is main's")
        }
        for (rw, r) in pairs where r.type == "session.started" && rw["language"] == nil {
            check(r.language == nil && r.accent == nil && r.sessionId == rw["sessionId"] as? String && r.voice == rw["voice"] as? String,
                  "session.started \(r.sessionId ?? "?") without language (before 2026-09-13) decodes: voice \(r.voice ?? "?") · language nil")
        }
        for (rw, r) in pairs where r.type == "session.started" && rw["language"] != nil {
            check(r.language == rw["language"] as? String && r.accent == rw["accent"] as? String, "session.started \(r.sessionId ?? "?") · \(r.language ?? "?") / \(r.accent ?? "?") (as raw)")
        }
        for (rw, r) in pairs where r.type == "sleep" {
            let cue = r.phrase.map { " · \"\($0)\"" } ?? ""
            let session = r.sessionId.map { " · \($0)" } ?? ""
            let asRaw = r.cause == rw["cause"] as? String && r.phrase == rw["phrase"] as? String && r.sessionId == rw["sessionId"] as? String && r.farewell == rw["farewell"] as? Bool
            check(r.cause != nil && asRaw, "sleep row → cause \(r.cause ?? "?")\(cue)\(session) · farewell \(r.farewell.map { "\($0)" } ?? "absent") (as raw)")
        }
        for r in pairs.map(\.row) where r.type == "session.closed" {
            print("  session.closed · \(r.reason ?? "?") · \(Int(r.usageSeconds ?? 0)) s")
        }

        // heard / said rows keep a typed line's source; delegation.created rows keep the thread that owns the card.
        let itemRows = pairs.filter { $0.row.type == "heard" || $0.row.type == "said" }
        if !itemRows.isEmpty {
            let sources = itemRows.map { $0.row.item?.source }
            let rawSources = itemRows.map { ($0.raw["item"] as? [String: Any])?["source"] as? String }
            check(sources == rawSources && itemRows.allSatisfy { $0.row.item != nil }, "\(itemRows.count) heard/said rows → \(sources.compactMap { $0 }.count) typed (source as raw)")
        }
        let cardRows = pairs.filter { $0.row.type == "delegation.created" }
        if !cardRows.isEmpty {
            let threads = cardRows.map { $0.row.delegation?.threadId }
            let rawThreads = cardRows.map { ($0.raw["delegation"] as? [String: Any])?["threadId"] as? String }
            check(threads == rawThreads && cardRows.allSatisfy { $0.row.delegation != nil }, "\(cardRows.count) delegation.created rows → threads \(threads.map { $0 ?? "main" }.joined(separator: ", ")) (as raw)")
        }

        // thread.* rows: the table rebuilds from these at daemon start, so every column must survive.
        for (rw, r) in pairs where r.type == "thread.started" {
            guard let t = r.thread, let rawT = rw["thread"] as? [String: Any] else { check(false, "thread.started row → the thread record decodes"); continue }
            let (ok, what) = threadMatches(t, rawT)
            check(ok, "thread.started row → \(what)")
        }
        for (rw, r) in pairs where r.type == "thread.status" {
            let rawStatus = rw["status"] as? String ?? "?"
            let known = ThreadStatus(rawValue: rawStatus) != nil
            check(r.threadId == rw["threadId"] as? String && r.threadId != nil,
                  "thread.status row → \(r.threadId ?? "?") · raw status \"\(rawStatus)\"\(known ? "" : " (unknown to this app)")")
            threadRowColumns(rw, r)
        }
        for (rw, r) in pairs where r.type == "thread.said" {
            check(r.threadId == rw["threadId"] as? String && r.threadId != nil && r.text == rw["text"] as? String && r.text != nil, "thread.said row → \(r.threadId ?? "?"): \"\(r.text ?? "")\"")
        }
        for (rw, r) in pairs where r.type == "thread.ended" {
            let ok = r.threadId == rw["threadId"] as? String && r.threadId != nil && r.summary == rw["summary"] as? String
                && r.steps == rw["steps"] as? Int && r.steps != nil && r.seconds == (rw["seconds"] as? NSNumber)?.doubleValue && r.seconds != nil
            check(ok, "thread.ended row → \(r.threadId ?? "?") · raw status \"\(rw["status"] as? String ?? "?")\" · \(r.steps ?? -1) steps · \(r.seconds ?? 0) s\(r.summary.map { " · \($0)" } ?? "")")
            threadRowColumns(rw, r)
        }
    }

    /// A thread.status / thread.ended row's `status` and `detail` columns against the raw row. The table
    /// rebuilds from these at daemon start and the Console's ThreadStore reads them for a past day, so a
    /// misread here is a wrong glyph on a finished thread. Fail-closed where the mirror carries the column
    /// as the wire spells it; a `warn` where it does not yet: `LedgerRow.status` is `DelegationStatus?`
    /// (waiting-kevin, stopped, idle … decode as .running — done and failed survive by name), and there
    /// is no `detail`. Read through `column(_:_:)`, so this tightens itself when Protocol.swift changes.
    mutating func threadRowColumns(_ rw: [String: Any], _ r: LedgerRow) {
        let head = "\(r.type) row → \(r.threadId ?? "?")"
        let rawStatus = rw["status"] as? String
        switch column(r, "status") {
        case .missing:
            check(false, "\(head) · LedgerRow has no status column")
        case .value(let s, delegationTyped: true):
            if s == rawStatus {
                check(true, "\(head) · status \(s ?? "nil") (as raw — through DelegationStatus, the same name)")
            } else {
                warn("\(head) · status column reads \(s ?? "nil") for raw \"\(rawStatus ?? "?")\": LedgerRow.status is DelegationStatus?, a ThreadStatus outside that enum is lost (Protocol.swift)")
            }
        case .value(let s, delegationTyped: false):
            check(s == rawStatus, "\(head) · status \(s ?? "nil") (as raw)")
        }
        if let rawDetail = rw["detail"] as? String {
            switch column(r, "detail") {
            case .missing:
                warn("\(head) · detail \"\(rawDetail)\" has no column in LedgerRow (Protocol.swift)")
            case .value(let d, _):
                check(d == rawDetail, "\(head) · detail \"\(d ?? "nil")\" (as raw)")
            }
        } else if case .value(let d?, _) = column(r, "detail") {
            check(false, "\(head) · detail \"\(d)\" decoded from a row that carries none")
        }
    }
}

/// A stored column of a LedgerRow, by name, through reflection. This probe must compile against
/// today's Protocol.swift and tighten itself the day the mirror gains a column or retypes one, with
/// no second edit here. `.missing`: no stored property of that name. `.value`: the column as the raw
/// JSON spells it (a String verbatim, an enum by its rawValue) and whether it is still typed as
/// DelegationStatus — the one known gap: a ThreadStatus outside that enum decodes as .running.
enum Column {
    case missing
    case value(String?, delegationTyped: Bool)
}

func column(_ row: LedgerRow, _ label: String) -> Column {
    guard let child = Mirror(reflecting: row).children.first(where: { $0.label == label }) else { return .missing }
    let columnType: Any.Type = type(of: child.value)
    let delegationTyped = columnType == DelegationStatus?.self || columnType == DelegationStatus.self
    var value: Any = child.value
    let m = Mirror(reflecting: value)
    if m.displayStyle == .optional {
        guard let some = m.children.first?.value else { return .value(nil, delegationTyped: delegationTyped) }
        value = some
    }
    if let s = value as? String { return .value(s, delegationTyped: delegationTyped) }
    if let d = value as? DelegationStatus { return .value(d.rawValue, delegationTyped: true) }
    if let t = value as? ThreadStatus { return .value(t.rawValue, delegationTyped: false) }
    return .value(String(describing: value), delegationTyped: delegationTyped)
}

/// Mirror of the protocol's THREAD_TERMINAL: a raw status outside this set is a live thread.
let threadTerminal: Set<String> = ["done", "failed", "stopped"]

func compact(_ o: [String: Any]) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]), let s = String(data: data, encoding: .utf8) else { return "?" }
    return s
}
