import Darwin
import Foundation

// The app's half of W3-3, without the app: the real Daemon/EngineClient.swift, Daemon/Wire.swift, Model/*.swift,
// UI/*.swift and UI/Console/*.swift, compiled with this file only by Scripts/w3-3-check.sh, against a fake daemon on a
// scratch unix socket in this process. No window, no TCC, no microphone, no sound, no real daemon, nothing under
// ~/.jarhead: the state dir the fake's hello names is a temp folder.
//
//   control      a hello with this build's protocol and a snapshot that decodes: it lands, no `app.version`, Go reaches
//                the daemon
//   hello-skew   a hello with another protocol (and one with none): the snapshot lands with the `app.version` row on
//                top (Restart daemon, `pnpm build:mac` to copy); Go, a resume, Switch now and a typed line are refused
//                with a toast and never reach the daemon; Stop still does
//   undecodable  a hello that matches, then a snapshot this build cannot decode (DROP_KEY, `threads` by default): the
//                row appears over the empty snapshot, which says Setup ran because settings.json does; Go is refused;
//                the next snapshot that decodes clears it and Go goes again
//   outbox       a Go (and a typed line, and a Stop) queued while no daemon answers (a respawn): the outbox waits for
//                the first snapshot after the hello. A skewed hello, or a snapshot this build cannot decode, refuses the
//                Go with the toast, and the skewed daemon gets only the Stop; a daemon of this build gets them in order;
//                a daemon that sends no snapshot in 3 s gets the Stop and not the Go
//   ledger       LM-6: the `ledger.days` answer's totals reach the Console (ConsoleSession.ledgerTotals), and the day
//                rows and month heads read them; a `partial` answer is asked again and fills in; an ask with no answer
//                keeps the list loading and asks again. Search older: the Console's search reads page after page
//                (`before` = the last page's `older`) until nothing older is left, and lands every page's hits; an
//                older page with no answer keeps the hits and says the older days were not searched
//   composer     V6: a line sent while paused (or connecting, or asleep with typed wakes) stays in the field until it
//                lands in the conversation, or until the session is back (a voice pick lands no typed line); an edit
//                drops the hold; in session it clears at once; asleep it stays; while the builds differ it stays in
//                any phase (the daemon client refuses it)
//   carried      a day's rows annotate a decision a move carried (`carried · decided …`); a session's read does not
//
// Exit 1 on any failure.

// MARK: - stubs for what EngineClient reaches outside Model/, Daemon/ and UI/

final class AudioEngine: @unchecked Sendable {
    func play(pcm: Data) {}
    func flush() {}
}

enum CrashGuard {
    static func remember(_ line: String) {}
}

extension Notification.Name {
    static let jarheadEarHints = Notification.Name("jarhead.earHints")
}

// MARK: - the fake daemon

/// One client at a time. Says hello (with `helloProtocol`, or none when nil) and the given snapshot, answers pings,
/// `ledger.days` and `ledger.search` (one day per page, `older` until the oldest), and records every command's type.
final class FakeDaemon: @unchecked Sendable {
    let path: String
    let stateDir: String
    var helloProtocol: Int?
    var firstSnapshot: Data
    /// How many `ledger.days` answers, from the first, are `partial`: the first day's totals only.
    var partialDaysAnswers = 0
    private var daysAnswered = 0
    private var listenFD: Int32 = -1
    private var fd: Int32 = -1
    private let lock = NSLock()
    private var _commands: [String] = []
    private var _searches: [String] = []
    private let ready = DispatchSemaphore(value: 0)

    var commands: [String] { lock.lock(); defer { lock.unlock() }; return _commands }
    /// The `before` of every `ledger.search` asked, "-" for none.
    var searches: [String] { lock.lock(); defer { lock.unlock() }; return _searches }

    /// The ledger the fake answers from: three days of hits, newest first, and their totals.
    static let days = ["2026-09-12", "2026-09-11", "2026-09-10"]
    static let totals: [[String: Any]] = [
        ["day": "2026-09-12", "sessions": 5, "billedSeconds": 723],
        ["day": "2026-09-11", "sessions": 2, "billedSeconds": 181],
        ["day": "2026-09-10", "sessions": 0, "billedSeconds": 0],
    ]

    init(path: String, stateDir: String, helloProtocol: Int?, firstSnapshot: Data) {
        self.path = path
        self.stateDir = stateDir
        self.helloProtocol = helloProtocol
        self.firstSnapshot = firstSnapshot
        unlink(path)
        listenFD = socket(AF_UNIX, SOCK_STREAM, 0)
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in path.utf8CString.withUnsafeBytes { raw.copyMemory(from: $0) } }
        let size = socklen_t(MemoryLayout<sockaddr_un>.size)
        let bound = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(listenFD, $0, size) } }
        precondition(bound == 0, "bind \(path): \(errno)")
        precondition(listen(listenFD, 4) == 0)
        Thread.detachNewThread { [self] in acceptLoop() }
    }

    private func acceptLoop() {
        while true {
            let c = accept(listenFD, nil, nil)
            guard c >= 0 else { return }
            lock.lock()
            if fd >= 0 { close(fd) }
            fd = c
            lock.unlock()
            var hello: [String: Any] = ["type": "hello", "version": "w3-3-check", "pid": Int(getpid()), "stateDir": stateDir]
            if let helloProtocol { hello["protocol"] = helloProtocol }
            send(json: hello)
            send(firstSnapshot)
            ready.signal()
            Thread.detachNewThread { [self] in readLoop(c) }
        }
    }

    private func readLoop(_ c: Int32) {
        let decoder = FrameDecoder()
        var buf = [UInt8](repeating: 0, count: 65_536)
        while true {
            let n = read(c, &buf, buf.count)
            guard n > 0, let frames = try? decoder.push(Data(buf[0 ..< n])) else { return }
            for f in frames where f.type == FrameType.json.rawValue {
                guard let o = try? JSONSerialization.jsonObject(with: f.payload) as? [String: Any], let type = o["type"] as? String else { continue }
                let id = o["id"] as? String ?? ""
                switch type {
                case "ping":
                    send(json: ["type": "pong", "id": id, "at": 0])
                case "command":
                    let what = (o["command"] as? [String: Any])?["type"] as? String ?? "?"
                    lock.lock(); _commands.append(what); lock.unlock()
                case "ledger.days":
                    lock.lock(); daysAnswered += 1; let partial = daysAnswered <= partialDaysAnswers; lock.unlock()
                    if partial {
                        send(json: ["type": "ledger.days", "id": id, "days": FakeDaemon.days, "totals": Array(FakeDaemon.totals.prefix(1)), "partial": true])
                    } else {
                        send(json: ["type": "ledger.days", "id": id, "days": FakeDaemon.days, "totals": FakeDaemon.totals])
                    }
                case "ledger.search":
                    // One day per page, newest first: `before` skips the days at or after it.
                    let before = o["before"] as? String
                    lock.lock(); _searches.append(before ?? "-"); lock.unlock()
                    let left = FakeDaemon.days.filter { before == nil || $0 < before! }
                    guard let day = left.first else {
                        send(json: ["type": "ledger.hits", "id": id, "hits": [] as [Any]])
                        continue
                    }
                    let at = W33.ms(day, hour: 9)
                    var page: [String: Any] = ["type": "ledger.hits", "id": id,
                                               "hits": [["sessionId": "s_\(day)", "chainId": "s_\(day)", "state": "active", "at": at, "kind": "heard", "text": "the needle on \(day)"]]]
                    if left.count > 1 { page["older"] = day }
                    send(json: page)
                default:
                    break
                }
            }
        }
    }

    func waitForClient() { _ = ready.wait(timeout: .now() + 5) }

    func send(json: [String: Any]) {
        send(W33.frame(.json, try! JSONSerialization.data(withJSONObject: json)))
    }

    func send(_ bytes: Data) {
        lock.lock()
        defer { lock.unlock() }
        guard fd >= 0 else { return }
        bytes.withUnsafeBytes { raw in
            var off = 0
            while off < raw.count {
                let n = write(fd, raw.baseAddress! + off, raw.count - off)
                if n <= 0 { return }
                off += n
            }
        }
    }

    func shutdown() {
        lock.lock()
        if fd >= 0 { close(fd); fd = -1 }
        lock.unlock()
        close(listenFD)
        unlink(path)
    }
}

// MARK: - helpers

enum W33 {
    static func frame(_ type: FrameType, _ payload: Data) -> Data {
        var out = Data(capacity: payload.count + 5)
        out.append(type.rawValue)
        let n = UInt32(payload.count)
        out.append(contentsOf: [UInt8(n >> 24 & 0xff), UInt8(n >> 16 & 0xff), UInt8(n >> 8 & 0xff), UInt8(n & 0xff)])
        out.append(payload)
        return out
    }

    /// A snapshot frame as server.ts writes it (`type` first), the fixture's first snapshot with `phase` set and
    /// `drop` taken out (a key this build requires: the frame does not decode).
    static func snapshot(_ base: [String: Any], phase: String = "asleep", drop: String? = nil) -> Data {
        var snap = base
        snap["phase"] = phase
        snap["session"] = nil
        if let drop { snap[drop] = nil }
        var payload = Data(#"{"type":"snapshot","snapshot":"#.utf8)
        payload.append(try! JSONSerialization.data(withJSONObject: snap))
        payload.append(Data("}".utf8))
        return frame(.json, payload)
    }

    /// A local instant on a ledger day.
    static func ms(_ day: String, hour: Int) -> Double {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd HH"
        f.locale = Locale(identifier: "en_US_POSIX")
        return (f.date(from: "\(day) \(String(format: "%02d", hour))")?.timeIntervalSince1970 ?? 0) * 1000
    }
}

/// A flag a task sets and the check reads, on the main actor.
@MainActor
final class Flag {
    var on = false
}

/// A count a stubbed fetch keeps (the stubs run off the main actor).
final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var n = 0
    func next() -> Int { lock.lock(); defer { lock.unlock() }; n += 1; return n }
}

func spin(_ seconds: Double) {
    let end = Date().addingTimeInterval(seconds)
    while Date() < end { _ = RunLoop.main.run(mode: .default, before: min(end, Date().addingTimeInterval(0.01))) }
}

/// Spin until `done` or `seconds` pass; true when it came.
@MainActor
func wait(_ seconds: Double, until done: () -> Bool) -> Bool {
    let end = Date().addingTimeInterval(seconds)
    while !done() && Date() < end { spin(0.02) }
    return done()
}

// MARK: - the check

@main
struct W33CheckMain {
    static func main() {
        setlinebuf(stdout)
        let env = ProcessInfo.processInfo.environment
        let fixture = CommandLine.arguments.dropFirst().first ?? "Scripts/fixtures/snapshot-threads.json"
        let dropKey = env["DROP_KEY"] ?? "threads"
        guard let data = FileManager.default.contents(atPath: fixture),
              let frames = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]],
              let base = frames.first(where: { $0["type"] as? String == "snapshot" })?["snapshot"] as? [String: Any] else {
            print("usage: w3-3-check <fixture with a snapshot frame>")
            exit(2)
        }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("jh-w3-3-check-\(getpid())")
        let stateDir = dir.appendingPathComponent("state")
        try? FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        // Setup has run on this "Mac": the row laid over the empty snapshot must say so too.
        try? Data(#"{"onboarded":true}"#.utf8).write(to: stateDir.appendingPathComponent("settings.json"))
        var failures = 0
        func check(_ ok: Bool, _ line: String) {
            print("\(ok ? "ok  " : "FAIL") \(line)")
            if !ok { failures += 1 }
        }
        var round = 0

        MainActor.assumeIsolated {
            /// A fresh app (AppState + EngineClient, its handlers installed as AppDelegate installs them) on a fresh fake.
            @MainActor func app(helloProtocol: Int?, snapshot: Data) -> (AppState, EngineClient, FakeDaemon) {
                round += 1
                let daemon = FakeDaemon(path: dir.appendingPathComponent("d\(round).sock").path, stateDir: stateDir.path, helloProtocol: helloProtocol, firstSnapshot: snapshot)
                let state = AppState()
                let client = EngineClient(socketPath: daemon.path, state: state)
                client.audio = AudioEngine()
                state.sendHandler = { client.send($0) }
                state.ledgerDaysHandler = { await client.ledgerDays() }
                state.ledgerSearchHandler = { q, limit in await client.ledgerSearch(query: q, limit: limit) }
                client.start()
                daemon.waitForClient()
                return (state, client, daemon)
            }
            func skewRow(_ s: Snapshot) -> Problem? { s.problems.first { $0.kind == "app.version" } }
            @MainActor func end(_ client: EngineClient, _ daemon: FakeDaemon) {
                client.stop()
                spin(0.1)
                daemon.shutdown()
            }

            print("control:")
            do {
                let (state, client, daemon) = app(helloProtocol: ProtocolVersion.current, snapshot: W33.snapshot(base))
                let landed = wait(4) { state.connected && state.snapshot != .empty }
                check(landed && skewRow(state.snapshot) == nil, "a hello naming protocol \(ProtocolVersion.current) and a snapshot that decodes: it lands, no app.version (problems \(state.snapshot.problems.map(\.kind)))")
                state.send(.go)
                check(wait(2) { daemon.commands.contains("go") }, "Go reaches the daemon (commands \(daemon.commands))")
                end(client, daemon)
            }

            for theirs in [ProtocolVersion.current + 1, nil] {
                let label = theirs.map { "protocol \($0)" } ?? "no protocol"
                print("hello-skew (\(label)):")
                let (state, client, daemon) = app(helloProtocol: theirs, snapshot: W33.snapshot(base))
                let raised = wait(4) { state.snapshot != .empty && skewRow(state.snapshot) != nil }
                let row = skewRow(state.snapshot)
                check(raised, "a hello with \(label): the snapshot lands with the app.version row on top")
                check(row?.text == EngineClient.skewProblemText && row?.remedy?.label == "Restart daemon" && row?.remedy?.copy == "pnpm build:mac"
                        && row?.remedy?.command == ["type": .string("daemon.restart")],
                      "the row: “\(row?.text ?? "-")” · \(row?.remedy?.label ?? "-") · copy \(row?.remedy?.copy ?? "-")")
                for cmd: EngineCommand in [.go, .resume, .voiceReopen, .sayText("hello"), .threadSay(threadId: "main", text: "hello")] { state.send(cmd) }
                state.send(.stop)
                _ = wait(2) { daemon.commands.contains("stop") }
                spin(0.2)
                check(daemon.commands == ["stop"], "Go, resume, Switch now and a typed line are refused; Stop goes (the daemon saw \(daemon.commands))")
                let toasts = state.toasts.map(\.text)
                check(toasts.contains(EngineClient.skewRefusedText) && toasts.contains(EngineClient.skewNotSentText), "each refusal says why: \(Set(toasts).sorted())")
                end(client, daemon)
            }

            print("undecodable (\(dropKey) missing):")
            do {
                let (state, client, daemon) = app(helloProtocol: ProtocolVersion.current, snapshot: W33.snapshot(base, drop: dropKey))
                let raised = wait(4) { skewRow(state.snapshot) != nil }
                check(raised && state.connected, "a snapshot this build cannot decode raises app.version while connected (problems \(state.snapshot.problems.map(\.kind)))")
                check(state.snapshot.settings.onboarded, "the row's snapshot says Setup ran, as settings.json does: a skew alone never opens Setup")
                state.send(.go)
                spin(0.3)
                check(!daemon.commands.contains("go"), "Go is refused while the snapshots do not decode (the daemon saw \(daemon.commands))")
                daemon.send(W33.snapshot(base, phase: "asleep"))
                let cleared = wait(4) { skewRow(state.snapshot) == nil && !state.snapshot.threads.isEmpty }
                check(cleared, "the next snapshot that decodes clears it (problems \(state.snapshot.problems.map(\.kind)))")
                state.send(.go)
                check(wait(2) { daemon.commands.contains("go") }, "and Go goes again (the daemon saw \(daemon.commands))")
                end(client, daemon)
            }

            /// A fresh app with no daemon yet (a respawn): `commands` are sent while nothing answers, then the fake comes up.
            @MainActor func queued(_ commands: [EngineCommand], helloProtocol: Int?, snapshot: Data) -> (AppState, EngineClient, FakeDaemon) {
                round += 1
                let path = dir.appendingPathComponent("q\(round).sock").path
                let state = AppState()
                let client = EngineClient(socketPath: path, state: state)
                client.audio = AudioEngine()
                state.sendHandler = { client.send($0) }
                client.start()
                spin(0.4)
                for c in commands { state.send(c) }
                spin(0.2)
                let daemon = FakeDaemon(path: path, stateDir: stateDir.path, helloProtocol: helloProtocol, firstSnapshot: snapshot)
                daemon.waitForClient()
                return (state, client, daemon)
            }

            print("outbox:")
            do {
                let (state, client, daemon) = queued([.go, .sayText("hello"), .stop], helloProtocol: ProtocolVersion.current + 1, snapshot: W33.snapshot(base))
                let raised = wait(5) { skewRow(state.snapshot) != nil && daemon.commands.contains("stop") }
                spin(0.3)
                check(raised && daemon.commands == ["stop"], "a Go and a typed line queued in an outage never reach a daemon whose hello names another protocol; the Stop does (the daemon saw \(daemon.commands))")
                let toasts = state.toasts.map(\.text)
                check(toasts.contains(EngineClient.skewRefusedText) && toasts.contains(EngineClient.skewNotSentText), "each refusal says why: \(Set(toasts).sorted())")
                end(client, daemon)
            }
            do {
                let (state, client, daemon) = queued([.go], helloProtocol: ProtocolVersion.current, snapshot: W33.snapshot(base, drop: dropKey))
                let raised = wait(5) { skewRow(state.snapshot) != nil }
                spin(0.5)
                check(raised && daemon.commands.isEmpty, "a Go queued in an outage waits for the first snapshot, and one this build cannot decode refuses it (the daemon saw \(daemon.commands))")
                daemon.send(W33.snapshot(base, phase: "asleep"))
                _ = wait(4) { skewRow(state.snapshot) == nil }
                spin(0.3)
                check(daemon.commands.isEmpty, "the refused Go stays refused when the snapshots decode again (the daemon saw \(daemon.commands))")
                end(client, daemon)
            }
            do {
                let (_, client, daemon) = queued([.go, .stop], helloProtocol: ProtocolVersion.current, snapshot: W33.snapshot(base))
                let both = wait(5) { daemon.commands.count >= 2 }
                check(both && daemon.commands == ["go", "stop"], "a daemon of this build gets the queued Go and Stop, in order (the daemon saw \(daemon.commands))")
                end(client, daemon)
            }
            do {
                let (state, client, daemon) = queued([.go, .stop], helloProtocol: ProtocolVersion.current, snapshot: Data())
                let stopped = wait(6) { daemon.commands.contains("stop") }
                spin(0.3)
                check(stopped && daemon.commands == ["stop"], "no snapshot \(Int(EngineClient.outboxSnapshotWait)) s after the hello: the Stop goes, the Go does not (the daemon saw \(daemon.commands))")
                check(state.toasts.map(\.text).contains(EngineClient.notJudgedRefusedText), "and the toast says so: \(Set(state.toasts.map(\.text)).sorted())")
                end(client, daemon)
            }

            print("ledger:")
            do {
                let (state, client, daemon) = app(helloProtocol: ProtocolVersion.current, snapshot: W33.snapshot(base))
                _ = wait(4) { state.connected }
                let session = ConsoleSession()
                let loaded = Flag()
                Task { @MainActor in
                    await session.loadDays(from: state)
                    loaded.on = true
                }
                _ = wait(4) { loaded.on }
                check(session.ledgerDays == FakeDaemon.days, "the day list, newest first: \(session.ledgerDays ?? [])")
                check(session.ledgerTotals["2026-09-12"]?.billedSeconds == 723 && session.ledgerTotals["2026-09-11"]?.sessions == 2 && session.ledgerTotals.count == 3,
                      "LM-6: every day's totals reached the Console, none of them opened (\(session.ledgerTotals.keys.sorted()))")
                let row = LedgerPanel.figures("2026-09-11", in: session.ledgerDayStats, totals: session.ledgerTotals)
                check(row == ConsoleFormat.billed(181), "a day row never opened shows its figures: \(row)")
                let month = ConsoleSession.monthStats(FakeDaemon.days, totals: session.ledgerTotals, stats: session.ledgerDayStats)
                check(month.read == 3 && month.billedSeconds == 904, "the month head sums its days: \(month.read) days · \(month.billedSeconds) s")
                let read = LedgerStats(sessions: 1, utterances: 2, delegations: 0, billedSeconds: 60)
                check(LedgerPanel.figures("2026-08-01", in: ["2026-08-01": read], totals: session.ledgerTotals) == ConsoleFormat.billed(60)
                        && LedgerPanel.figures("2026-08-02", in: [:], totals: [:]) == LedgerWords.unread,
                      "a day with no total reads its own rows, else the dash")

                session.searchOpen = true
                session.search("needle", from: state)
                let done = wait(6) { !session.searching && (session.searchHits?.count ?? 0) == 3 }
                check(done, "search older: the box read on page after page and landed every hit (\(session.searchHits?.map(\.text) ?? []))")
                check(daemon.searches == ["-", "2026-09-12", "2026-09-11"], "each page asked from the last page's older: \(daemon.searches)")
                check(session.searchGap == nil, "every page answered: no gap line")
                end(client, daemon)
            }

            print("ledger, partial and late:")
            do {
                let (state, client, daemon) = app(helloProtocol: ProtocolVersion.current, snapshot: W33.snapshot(base))
                daemon.partialDaysAnswers = 1
                _ = wait(4) { state.connected }
                let session = ConsoleSession()
                let loaded = Flag()
                Task { @MainActor in
                    await session.loadDays(from: state)
                    loaded.on = true
                }
                _ = wait(4) { loaded.on }
                check(session.ledgerDays == FakeDaemon.days && session.ledgerTotals.keys.sorted() == ["2026-09-12"],
                      "a partial answer: the whole list at once, and the totals read so far (\(session.ledgerTotals.keys.sorted()))")
                let filled = wait(Double(ConsoleSession.daysRetryAfterMs) / 1000 + 3) { session.ledgerTotals.count == 3 }
                check(filled, "it is asked again and fills in (\(session.ledgerTotals.keys.sorted()))")
                end(client, daemon)
            }
            do {
                // No answer in time (a cold read on a loaded Mac, before the daemon's budget): the list keeps loading, then lands.
                let asked = Counter()
                LedgerDays.fetch = {
                    asked.next() == 1 ? nil : LedgerDays(days: FakeDaemon.days, totals: ["2026-09-11": LedgerDayTotals(day: "2026-09-11", sessions: 2, billedSeconds: 181)])
                }
                let session = ConsoleSession()
                let loaded = Flag()
                Task { @MainActor in
                    await session.loadDays(from: AppState())
                    loaded.on = true
                }
                _ = wait(2) { loaded.on }
                check(session.ledgerDays == nil, "no answer: the tab still says Loading, never an empty ledger")
                let landed = wait(Double(ConsoleSession.daysRetryAfterMs) / 1000 + 3) { session.ledgerDays == FakeDaemon.days }
                check(landed && session.ledgerTotals["2026-09-11"]?.billedSeconds == 181, "asked again, the list and its totals land (\(session.ledgerDays ?? []))")
                LedgerDays.fetch = nil
            }
            do {
                // An older page that does not answer: the newest page's hits stand, and the gap line says what went unread.
                let pages = Counter()
                LedgerSearchPage.fetch = { _, _, _ in
                    pages.next() == 1 ? LedgerSearchPage(hits: [LedgerHit(json: ["sessionId": "s_1", "chainId": "s_1", "state": "active", "at": 1.0, "kind": "heard", "text": "the needle"])!], older: "2026-09-12") : nil
                }
                let state = AppState()
                state.ledgerSearchHandler = { _, _ in [] }
                let session = ConsoleSession()
                session.searchOpen = true
                session.search("needle", from: state)
                let done = wait(4) { !session.searching && session.searchHits != nil }
                check(done && session.searchHits?.map(\.text) == ["the needle"] && session.searchGap == .older,
                      "an older page with no answer: the hits stand, and “\(session.searchGap?.line ?? "-")”")
                check(ConsoleSession.SearchGap.older.line.range(of: "—") == nil, "no em dash in the gap line")
                LedgerSearchPage.fetch = nil
            }

            print("composer:")
            do {
                var text = "  play the next one "
                var held = ComposerHold.submitted("play the next one", phase: .paused, typedWakes: false, lastTypedId: "t_4", text: &text)
                check(held != nil && text == "  play the next one ", "paused: the line stays in the field, held until it lands")
                held = ComposerHold.landed(held, lastTypedId: "t_4", text: &text)
                check(held != nil && !text.isEmpty, "no newer typed line (the resume failed: not sent): the words stay")
                held = ComposerHold.landed(held, lastTypedId: "t_5", text: &text)
                check(held == nil && text.isEmpty, "the line landed: the field clears")

                text = "first"
                held = ComposerHold.submitted("first", phase: .connecting, typedWakes: false, lastTypedId: nil, text: &text)
                text = "first, then more"
                held = ComposerHold.edited(held, text: text)
                held = ComposerHold.landed(held, lastTypedId: "t_1", text: &text)
                check(held == nil && text == "first, then more", "an edit drops the hold: a later landing never clears what is being typed")

                text = "hi"
                check(ComposerHold.submitted("hi", phase: .listening, typedWakes: false, lastTypedId: nil, text: &text) == nil && text.isEmpty, "in session the field clears at once")
                text = "hi"
                check(ComposerHold.submitted("hi", phase: .asleep, typedWakes: false, lastTypedId: nil, text: &text) == nil && text == "hi", "asleep, typed wakes off: refused, the words stay")
                text = "hi"
                check(ComposerHold.submitted("hi", phase: .asleep, typedWakes: true, lastTypedId: nil, text: &text) != nil && text == "hi", "asleep, typed wakes on: it wakes first, held until it lands")
                text = "hi"
                check(ComposerHold.submitted("hi", phase: .listening, typedWakes: false, skewed: true, lastTypedId: nil, text: &text) == nil && text == "hi",
                      "in session while the builds differ: the daemon client refuses the line, and the words stay")
                text = "hi"
                check(ComposerHold.submitted("hi", phase: .paused, typedWakes: false, skewed: true, lastTypedId: nil, text: &text) == nil && text == "hi",
                      "paused while the builds differ: refused, kept, and not held (nothing will land)")
                let skewProblems = [Problem(kind: "app.version", text: EngineClient.skewProblemText, remedy: nil, since: 0)]
                check(ComposerHold.skewed(skewProblems) && !ComposerHold.skewed([]), "the app.version row is the skew")

                text = "switch to the ballad voice"
                held = ComposerHold.submitted("switch to the ballad voice", phase: .paused, typedWakes: false, lastTypedId: "t_4", text: &text)
                held = ComposerHold.phaseChanged(held, phase: .connecting, text: &text)
                check(held != nil && text == "switch to the ballad voice", "a voice pick typed while paused lands no typed line: still held while connecting")
                held = ComposerHold.phaseChanged(held, phase: .listening, text: &text)
                check(held == nil && text.isEmpty, "the session is back on the new voice: the hold ends and the field clears")
                text = "play it"
                held = ComposerHold.submitted("play it", phase: .paused, typedWakes: false, lastTypedId: nil, text: &text)
                text = "play it louder"
                held = ComposerHold.edited(held, text: text)
                held = ComposerHold.phaseChanged(held, phase: .listening, text: &text)
                check(held == nil && text == "play it louder", "an edit before the session is back: the field is his, nothing clears")
                let typed = TranscriptItem(id: "t_9", speaker: .kevin, text: "x", startMs: 0, endMs: 0, at: 0, final: true, source: "typed")
                let spoken = TranscriptItem(id: "t_10", speaker: .kevin, text: "y", startMs: 0, endMs: 0, at: 1, final: true, source: nil)
                check(ComposerHold.lastTypedId([typed, spoken]) == "t_9", "only a typed line of Kevin's is a landing")
            }

            print("carried:")
            do {
                let decided = W33.ms("2026-09-08", hour: 14)
                let json = #"[{"at":1789243500000,"type":"conversation.renamed","chainId":"s_a","name":"Budget","carried":true,"decidedAt":\#(decided)},{"at":1789243500001,"type":"conversation.trashed","chainId":"s_b","by":"kevin"}]"#
                let rows = (try? jarheadJSONDecoder.decode([LedgerRow].self, from: Data(json.utf8))) ?? []
                check(rows.first?.carried == true && rows.first?.decidedAt == decided, "LedgerRow reads carried and decidedAt")
                let lines = { (r: LedgerReading) in StreamBuilder.fromLedger(rows, reading: r).compactMap { e -> String? in if case .system(let s) = e { return s.trailing ?? "-" } else { return nil } } }
                let day = lines(.day), record = lines(.record)
                check(day.first?.hasPrefix("carried · decided ") == true && day.first?.hasSuffix(" 14:00") == true && day.last == "-",
                      "a day's rows say which decision was carried and when it was decided: \(day)")
                check(record == ["-", "-"], "a session's or a chain's read shows the decision itself: \(record)")
                let moved = try? jarheadJSONDecoder.decode(LedgerRow.self, from: Data(#"{"at":1,"type":"ledger.moved","day":"2026-09-08","what":"ledger","to":"trash","path":"/x","by":"kevin","lineage":{"s_b":["s_a"]}}"#.utf8))
                check(moved?.lineage == ["s_b": ["s_a"]], "ledger.moved's lineage decodes")
            }
        }
        print(failures == 0 ? "w3-3-check: all ok" : "w3-3-check: \(failures) failure(s)")
        exit(failures == 0 ? 0 : 1)
    }
}
