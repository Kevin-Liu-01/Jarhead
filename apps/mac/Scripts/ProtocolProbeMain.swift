import Foundation

// Contract probe: decodes captured daemon frames with the app's own Codable mirrors
// (Model/Protocol.swift) and `jarheadJSONDecoder`, the way Daemon/EngineClient.swift
// does it — the frame read as [String: Any], the `snapshot` sub-object re-serialised
// and decoded as Snapshot, every `ledger.rows` row decoded on its own so one odd row
// never hides the day. Not part of the package; compiled only by
// Scripts/protocol-probe.sh over Protocol.swift and this file — no AppKit, no
// SwiftUI, no AppState, so it runs anywhere swiftc does.
//
// What it proves, per fixture (Scripts/fixtures/*.json, each a JSON array of frames):
//   - the whole capture decodes: a daemon from before workers (snapshot-f6c3b40.json —
//     no `workers`, no `settings.workers`, no worker or sleep rows) as well as one that
//     has them (snapshot-workers.json);
//   - a worker status or lane this app does not know decodes to the documented default
//     (.working / .background) instead of failing the snapshot — every worker's raw
//     JSON is compared against its decoded value;
//   - `settings.workers` absent → workersOn; `DelegationStep.worker` (the [Name] chip)
//     survives on snapshot steps and `delegation.step` rows; `worker` and `sleep` ledger
//     rows keep their columns (the worker record vs its raw JSON; cause, phrase,
//     sessionId, farewell);
//   - the commands the app sends for these features encode as the daemon's
//     isEngineCommand expects: {"type":"sleep","cause":…} and {"type":"worker.stop","workerId":…}.
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
        print(probe.failures == 0 ? "ok · \(probe.checks) checks" : "FAILED · \(probe.failures) of \(probe.checks) checks")
        exit(probe.failures == 0 ? 0 : 1)
    }
}

struct Probe {
    var checks = 0
    var failures = 0

    mutating func check(_ ok: Bool, _ what: String) {
        checks += 1
        if !ok { failures += 1 }
        print("  \(ok ? "ok  " : "FAIL") \(what)")
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
        let stop = EngineCommand.workerStop(workerId: "w_7f3a").json
        check(stop["type"] as? String == "worker.stop" && stop["workerId"] as? String == "w_7f3a", "workerStop → \(compact(stop))")
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

        // settings.workers: absent on an older daemon → on (the Swift default), present → as sent.
        let rawWorkers = (raw["settings"] as? [String: Any])?["workers"]
        let wanted = (rawWorkers as? Bool) ?? true
        check(snap.settings.workersOn == wanted, "settings.workers \(rawWorkers.map { "\($0)" } ?? "absent") → workersOn \(snap.settings.workersOn)")

        // Steps, and the worker chip on each: the decoded `worker` column must equal the raw one,
        // step for step — a renamed key or a dropped optional would silently lose the [Name] chip.
        let steps = snap.delegations.flatMap(\.steps)
        let rawSteps = (raw["delegations"] as? [[String: Any]] ?? []).flatMap { ($0["steps"] as? [[String: Any]]) ?? [] }
        let byWorkers = steps.map(\.worker)
        let rawByWorkers = rawSteps.map { $0["worker"] as? String }
        let chips = Set(byWorkers.compactMap { $0 }).sorted().joined(separator: ", ")
        let named = byWorkers.compactMap { $0 }.count
        check(steps.count == rawSteps.count && byWorkers == rawByWorkers,
              "delegations \(snap.delegations.count) · steps \(steps.count) · \(named == 0 ? "none by workers" : "\(named) by workers: \(chips)") (as raw)")

        // Workers: count against the raw array, then every worker's raw record against its decoded value.
        let rawList = raw["workers"] as? [[String: Any]]
        let where_ = rawList == nil ? "no workers field: a daemon from before them" : "\(snap.runningWorkers.count) running"
        check(snap.allWorkers.count == (rawList?.count ?? 0), "workers \(snap.allWorkers.count) (\(where_))")
        for (w, rw) in zip(snap.allWorkers, rawList ?? []) {
            let (ok, what) = workerMatches(w, rw)
            check(ok, what)
        }
    }

    /// A decoded Worker against its raw JSON: id, name and steps verbatim; status and lane
    /// verbatim when this app knows the string, the documented default when it does not.
    func workerMatches(_ w: Worker, _ rw: [String: Any]) -> (Bool, String) {
        let rawStatus = rw["status"] as? String ?? "?"
        let rawLane = rw["lane"] as? String ?? "?"
        let knownStatus = WorkerStatus(rawValue: rawStatus) != nil
        let knownLane = WorkerLane(rawValue: rawLane) != nil
        var what = "\(w.name) · \(w.lane.rawValue) · \(w.status.rawValue)"
        if !knownStatus { what += " (raw \"\(rawStatus)\" unknown to this app → .working)" }
        if !knownLane { what += " (raw lane \"\(rawLane)\" unknown to this app → .background)" }
        what += " · \(w.steps) steps · \(w.status.isRunning ? "running" : "finished")"
        if let d = w.detail { what += " · \(d)" }
        let statusOk = knownStatus ? w.status.rawValue == rawStatus : w.status == .working
        let laneOk = knownLane ? w.lane.rawValue == rawLane : w.lane == .background
        let recordOk = w.id == rw["id"] as? String && w.name == rw["name"] as? String && w.steps == rw["steps"] as? Int && w.delegationId == rw["delegationId"] as? String
        return (statusOk && laneOk && recordOk, what)
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

        // delegation.step rows: the worker chip, row for row, as raw (nil where the main brain ran it).
        let stepRows = pairs.filter { $0.row.type == "delegation.step" }
        if !stepRows.isEmpty {
            let decodedChips = stepRows.map { $0.row.step?.worker }
            let rawChips = stepRows.map { ($0.raw["step"] as? [String: Any])?["worker"] as? String }
            let named = rawChips.compactMap { $0 }
            check(decodedChips == rawChips && stepRows.allSatisfy { $0.row.step != nil },
                  "\(stepRows.count) delegation.step rows → \(named.isEmpty ? "no worker chips" : "worker chips \(named.joined(separator: ", "))") (as raw)")
        }
        for (rw, r) in pairs where r.type == "worker" {
            guard let w = r.worker, let rawW = rw["worker"] as? [String: Any] else { check(false, "worker row → the worker record decodes"); continue }
            let (ok, what) = workerMatches(w, rawW)
            check(ok, "worker row → \(what)")
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
    }
}

func compact(_ o: [String: Any]) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]), let s = String(data: data, encoding: .utf8) else { return "?" }
    return s
}
