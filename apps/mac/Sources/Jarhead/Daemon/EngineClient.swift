import Foundation
import Network

/// The socket client: connects to jarheadd, reconnects while it (re)starts, decodes
/// frames, and publishes into `AppState` on the main actor. Speaker frames go to the
/// `AudioEngine`; mic frames come from it through `sendMic`.
/// Queue-confined (`net`); the class is safe to hand across threads.
final class EngineClient: @unchecked Sendable {
    private let socketPath: String
    private let state: AppState
    private let net = DispatchQueue(label: "jarhead.engine-client")
    private var connection: NWConnection?
    private let decoder = FrameDecoder()
    private var running = false
    private var reconnectDelay: TimeInterval = 0.3
    private var reconnectScheduled = false
    private var isConnected = false
    /// Commands sent while the daemon is (re)connecting. Stop, wake, pause must not
    /// vanish because a reconnect was in flight; they are delivered on `.ready`,
    /// newest last, dropped after 5 s or beyond 20 entries. On `net`.
    private var outbox: [(at: Date, json: [String: Any])] = []

    /// Speaker frames and flush requests land here. Set before `start()`.
    var audio: AudioEngine?
    /// Fired (on the main queue) after each successful hello; re-send anything the daemon must know.
    var onConnected: (() -> Void)?
    /// An automation fired while asleep (design11): `local.say` — the earcon and a fixed line through the app's
    /// on-device speaker; `notify` — a banner with the ring's presses. Both on the main actor; the app installs them.
    var onLocalSay: (@MainActor (LocalSayMessage) -> Void)?
    var onNotify: (@MainActor (NotifyMessage) -> Void)?

    // Snapshot coalescing: at most ~30 publishes per second.
    private var pendingSnapshot: Snapshot?
    private var snapshotPublishScheduled = false
    private var lastSnapshotPublish = DispatchTime.now()
    private static let minSnapshotInterval: Double = 1.0 / 30.0

    // Ledger requests: id → resolver. Resolved with nil on timeout/disconnect.
    private var pendingLedger: [String: (Any?) -> Void] = [:]
    private static let ledgerTimeout: TimeInterval = 5
    /// A whole chain in one answer is up to 20 000 rows (Ledger.readChain's cap) read across
    /// as many as 60 day files; a day's 5 s would cut a long conversation short.
    static let chainTimeout: TimeInterval = 15

    private let appVersion: String = {
        (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "2.0.0"
    }()

    // MARK: - liveness, the daemon row, auto-resume (REDESIGN §16 "Liveness")
    //
    // A daemon that exits is caught by DaemonProcess; a daemon that is alive on the socket
    // and not answering — a wedged event loop — was invisible. So: one `ping` every 2 s
    // while connected, answered by the daemon on the wire with no engine work (`pong`);
    // two unanswered in a row and this client drops the connection and tells
    // DaemonProcess (a notification: both are the app's, no AppDelegate wiring) to kill and
    // respawn it. While no daemon answers for more than a beat, the published snapshot
    // carries one typed problem, `daemon`, whose remedy is "Restart daemon" (the
    // `daemon.restart` command, routed to DaemonProcess while nothing is connected); the
    // next real snapshot replaces it. And when the daemon comes back asleep after a session
    // was open — a crash, a kill, a self-update mid-conversation — this client sends `go`
    // once, inside 10 s of the reconnect; the engine resumes the conversation from the
    // ledger (Engine.resumeFromLedger). Never after Kevin pressed Stop or Pause since that
    // session's last snapshot; never twice.

    /// Posted on the main queue when `missedPongsBeforeRespawn` pings went unanswered. `userInfo`: `pid` (Int32, the daemon's, when its hello said) and `seconds` (Int).
    nonisolated static let daemonUnresponsiveNotification = Notification.Name("jarhead.daemonUnresponsive")
    /// Posted on the main queue when the "Restart daemon" remedy is pressed while no daemon is connected. No `pid`: nothing is connected, so there is no daemon of ours to name.
    nonisolated static let restartDaemonNotification = Notification.Name("jarhead.restartDaemon")

    static let pingInterval: TimeInterval = 2
    static let missedPongsBeforeRespawn = 2
    /// How long disconnected before the `daemon` row appears: a normal respawn is back in 1–3 s and must not flash it.
    static let daemonProblemAfter: TimeInterval = 3
    /// After a reconnect, a daemon reporting asleep inside this window gets one `go` when a session was open before the drop.
    static let autoResumeWindow: TimeInterval = 10
    static let daemonProblemText = "The engine is not answering; Jarhead cannot hear or act until it is back"

    private var pingTimer: DispatchSourceTimer?
    /// Ping ids sent and not yet answered, oldest first. On `net`.
    private var pendingPings: [String] = []
    /// The daemon's pid from THIS connection's hello, for the kill when it stops answering.
    /// Cleared the moment the connection drops: a pid from a dead connection may have been
    /// reused by one of Kevin's own processes, and is nobody's to kill. On `net`.
    private var daemonPid: Int32?
    /// When this client last sent an auto-resume `go`; no second one inside `resumeCooldown`. On `net`.
    private var resumeGoSentAt: Date = .distantPast
    /// The drops inside `dropLoopWindow`: a second one is a daemon dying (or wedging) on every start, and a resume would be a paid loop. On `net`.
    private var recentDrops: [Date] = []
    /// "Exactly once" needs memory across respawns — each is a new engine process with no memory of the last resume.
    static let resumeCooldown: TimeInterval = 300
    static let dropLoopWindow: TimeInterval = 120
    /// The last snapshot the daemon sent (before any drop), and when. On `net`.
    private var lastSnapshot: Snapshot?
    private var lastSnapshotAt: Date = .distantPast
    /// When this app last sent `stop` or `pause`: Kevin's word against an auto-resume. On `net`.
    private var stopSentAt: Date = .distantPast
    /// Armed at a drop when a session was open (or opening) and Kevin had not stopped it; consumed by the first snapshot after the reconnect.
    private var resumeCandidate = false
    private var resumeDeadline: Date = .distantPast
    private var disconnectedAt: Date?

    init(socketPath: String, state: AppState) {
        self.socketPath = socketPath
        self.state = state
    }

    // MARK: - lifecycle

    func start() {
        net.async {
            guard !self.running else { return }
            self.running = true
            self.openConnection()
        }
    }

    func stop() {
        net.async {
            self.running = false
            self.stopPings()
            self.resumeCandidate = false
            self.daemonPid = nil
            self.connection?.cancel()
            self.connection = nil
            self.failPendingLedger()
            self.publishConnected(false)
        }
    }

    private func openConnection() {
        guard running else { return }
        connection?.cancel()
        decoder.reset()
        let conn = NWConnection(to: .unix(path: socketPath), using: .tcp)
        connection = conn
        conn.stateUpdateHandler = { [weak self] st in
            guard let self, conn === self.connection else { return }
            switch st {
            case .ready:
                self.reconnectDelay = 0.3
                self.isConnected = true
                self.disconnectedAt = nil
                self.sendHello()
                self.flushOutbox()
                self.publishConnected(true)
                self.startPings()
                // The window for one `go` if the daemon comes back asleep after a session was open.
                if self.resumeCandidate { self.resumeDeadline = Date().addingTimeInterval(EngineClient.autoResumeWindow) }
                if let cb = self.onConnected { DispatchQueue.main.async(execute: cb) }
                self.receiveLoop(conn)
            case .waiting(let err):
                // For a unix socket "waiting" means nobody is listening; there is no path
                // change to wait for, so treat it like a failure and retry ourselves.
                self.log("waiting: \(err)")
                self.dropAndReconnect()
            case .failed(let err):
                self.log("failed: \(err)")
                self.dropAndReconnect()
            case .cancelled:
                break
            default:
                break
            }
        }
        conn.start(queue: net)
    }

    private func dropAndReconnect() {
        connection?.cancel()
        connection = nil
        stopPings()
        // The pid lives exactly as long as the connection that hello'd it.
        daemonPid = nil
        if isConnected {
            isConnected = false
            publishConnected(false)
            failPendingLedger()
            noteDisconnected()
        }
        scheduleReconnect()
    }

    /// On `net`, once per drop: arm the auto-resume from what the daemon last said, and
    /// schedule the `daemon` row for a drop that lasts.
    private func noteDisconnected() {
        let now = Date()
        disconnectedAt = now
        recentDrops = recentDrops.filter { now.timeIntervalSince($0) < EngineClient.dropLoopWindow }
        let dropsBefore = recentDrops.count
        recentDrops.append(now)
        // A session open or opening in the last snapshot, and no Stop / Pause from this app
        // since that snapshot: the daemon coming back asleep is a cut conversation.
        if let s = lastSnapshot {
            let open = s.session != nil || s.phase == .connecting
            let wanted = open && stopSentAt <= lastSnapshotAt
            // The loop guards: a resume `go` inside the cooldown, or a second drop inside the
            // window, means the daemon is dying after every resume — each cycle a paid Live
            // session and a "back". One resume; then Kevin's own Go.
            let sinceResume = now.timeIntervalSince(resumeGoSentAt)
            if wanted && sinceResume < EngineClient.resumeCooldown {
                resumeCandidate = false
                log("disconnected with a session open \(Int(sinceResume)) s after an auto-resume; not arming another (a resume loop, not a conversation)")
            } else if wanted && dropsBefore >= 1 {
                resumeCandidate = false
                log("disconnected with a session open, the \(dropsBefore + 1)th drop in \(Int(EngineClient.dropLoopWindow)) s; not arming a resume (the daemon is looping)")
            } else {
                resumeCandidate = wanted
                if resumeCandidate { log("disconnected with a session open (phase \(s.phase.rawValue)); one go is armed for a daemon that comes back asleep") }
            }
        } else {
            resumeCandidate = false
        }
        net.asyncAfter(deadline: .now() + EngineClient.daemonProblemAfter) { [weak self] in
            guard let self, self.running, !self.isConnected, self.disconnectedAt == now else { return }
            self.publishDaemonProblem()
        }
    }

    // MARK: pings

    /// On `net`. One ping every `pingInterval` while connected; `pingTick` judges the answers.
    private func startPings() {
        stopPings()
        pendingPings.removeAll()
        let timer = DispatchSource.makeTimerSource(queue: net)
        timer.schedule(deadline: .now() + EngineClient.pingInterval, repeating: EngineClient.pingInterval, leeway: .milliseconds(200))
        timer.setEventHandler { [weak self] in self?.pingTick() }
        timer.resume()
        pingTimer = timer
    }

    private func stopPings() {
        pingTimer?.cancel()
        pingTimer = nil
        pendingPings.removeAll()
    }

    /// On `net`. Two pings unanswered (4 s of silence) is a daemon that is up and not
    /// listening: drop the connection — the reconnect loop takes over — and ask
    /// DaemonProcess to kill and respawn it. Otherwise send the next ping.
    private func pingTick() {
        guard isConnected, connection != nil else { return }
        if pendingPings.count >= EngineClient.missedPongsBeforeRespawn {
            let seconds = Int(EngineClient.pingInterval * Double(pendingPings.count))
            log("daemon unresponsive: no pong for \(seconds) s (\(pendingPings.count) pings unanswered); dropping the connection and asking for a respawn")
            var info: [AnyHashable: Any] = ["seconds": seconds]
            if let pid = daemonPid { info["pid"] = pid }
            DispatchQueue.main.async { NotificationCenter.default.post(name: EngineClient.daemonUnresponsiveNotification, object: nil, userInfo: info) }
            dropAndReconnect()
            return
        }
        let id = UUID().uuidString
        pendingPings.append(id)
        rawSend(json: ["type": "ping", "id": id])
    }

    // MARK: the daemon row

    /// On `net`. The last snapshot, republished with one problem on top: `daemon`, with
    /// "Restart daemon" as its remedy. Every utterance is sealed first: nothing is being typed by a daemon
    /// that is gone, and a `final: false` item would keep its caret blinking for the whole
    /// outage (the last snapshot is all this client has; the engine's settle never runs).
    /// The daemon's next snapshot replaces the whole thing, row included.
    private func publishDaemonProblem() {
        let sinceMs = (disconnectedAt ?? Date()).timeIntervalSince1970 * 1000
        onMain { st in
            var s = st.snapshot.finalisingTranscript()
            let text = EngineClient.daemonProblemText
            var problems = s.problems.filter { $0.kind != "daemon" }
            problems.append(Problem(kind: "daemon", text: text,
                                    remedy: ProblemRemedy(label: "Restart daemon", command: ["type": .string("daemon.restart")], open: nil),
                                    since: sinceMs))
            s.problems = problems
            st.snapshot = s
        }
    }

    // MARK: auto-resume

    /// On `net`, for every snapshot the daemon sends: remember it for the next drop, and
    /// spend the armed `go` when a daemon that just came back reports asleep. Anything
    /// else it reports — awake (a daemon that lingered through an app crash), paused (the
    /// engine held the pause again), error — means there is nothing to resume.
    private func noteSnapshotForResume(_ snap: Snapshot) {
        defer {
            lastSnapshot = snap
            lastSnapshotAt = Date()
        }
        guard resumeCandidate else { return }
        resumeCandidate = false
        guard Date() <= resumeDeadline else {
            log("auto-resume: the daemon's first snapshot came after the \(Int(EngineClient.autoResumeWindow)) s window; not resuming")
            return
        }
        guard snap.phase == .asleep, snap.session == nil, snap.pause == nil else {
            log("auto-resume: the daemon is back \(snap.phase.rawValue); nothing to resume")
            return
        }
        log("auto-resume: the daemon came back asleep after a session was open; sending go once")
        resumeGoSentAt = Date()
        rawSend(json: ["type": "command", "command": EngineCommand.go.json])
    }

    private func scheduleReconnect() {
        guard running, !reconnectScheduled else { return }
        reconnectScheduled = true
        let delay = reconnectDelay
        reconnectDelay = min(reconnectDelay * 1.7, 3)
        net.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self else { return }
            self.reconnectScheduled = false
            self.openConnection()
        }
    }

    private func receiveLoop(_ conn: NWConnection) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) { [weak self] data, _, isComplete, error in
            guard let self, conn === self.connection else { return }
            if let data, !data.isEmpty {
                do {
                    for frame in try self.decoder.push(data) { self.handle(frame) }
                } catch {
                    self.log("dropping connection: \(error.localizedDescription)")
                    self.dropAndReconnect()
                    return
                }
            }
            if isComplete || error != nil {
                if let error { self.log("receive error: \(error)") } else { self.log("daemon closed the connection") }
                self.dropAndReconnect()
                return
            }
            self.receiveLoop(conn)
        }
    }

    // MARK: - sending

    private func sendHello() {
        rawSend(json: ["type": "hello", "pid": Int(ProcessInfo.processInfo.processIdentifier), "version": appVersion, "audio": true])
    }

    func send(_ command: EngineCommand) {
        net.async {
            switch command {
            case .stop, .pause:
                // Kevin's word: a daemon that comes back asleep after this is not resumed.
                self.stopSentAt = Date()
                self.resumeCandidate = false
            case .agentSend(let agentId, let text):
                // The pending echo: the row shows the moment Send is pressed, 0 round trips; the
                // engine's own echo (the same words, `pending: true`) folds into it and the real
                // user turn from the tool's file drops it (AppState.applyTranscript).
                let at = Date().timeIntervalSince1970 * 1000
                self.onMain { $0.echoPendingSend(agentId: agentId, text: text, at: at) }
            case .daemonRestart where !self.isConnected:
                // The `daemon` row's remedy with nothing to send it to: DaemonProcess spawns (or
                // kills and respawns) one now. Queued, the command would restart the daemon that
                // had just come back. No pid travels with it: the daemon this app last heard from
                // is gone with its connection, and a pid from it may be someone else's by now —
                // only the ping path (a live connection) names one to kill.
                self.log("restart daemon requested while disconnected; asking DaemonProcess")
                DispatchQueue.main.async { NotificationCenter.default.post(name: EngineClient.restartDaemonNotification, object: nil, userInfo: [:]) }
                return
            default:
                break
            }
            self.rawSend(json: ["type": "command", "command": command.json])
        }
    }

    func sendMic(_ pcm: Data) {
        net.async {
            guard let conn = self.connection, self.isConnected, let frame = try? Wire.encode(type: .mic, payload: pcm) else { return }
            conn.send(content: frame, completion: .contentProcessed { _ in })
        }
    }

    func sendMicLevel(_ level: Double) {
        let clamped = max(0, min(1, level.isFinite ? level : 0))
        net.async { self.rawSend(json: ["type": "mic-level", "level": clamped]) }
    }

    /// design12: the audio graph's read-back (wire.ts `audio-state`, beside `mic-level`): the daemon keeps it in
    /// `snapshot.audioState` for `pnpm jarhead status` / `doctor` and the per-turn `audio.guard` ledger row. The
    /// AppDelegate coalesces to ≤ 1 Hz; the field names are the protocol's, exactly (`AudioStateInfo.json`).
    func sendAudioState(_ state: AudioStateInfo) {
        let json = state.json
        net.async { self.rawSend(json: ["type": "audio-state", "state": json]) }
    }

    /// One permission as this app read it (wire.ts `permission`); `detail` is the row's
    /// extra line (Automation's targets, a folder's path).
    func sendPermission(which: String, state grant: Grant, detail: String? = nil) {
        var json: [String: Any] = ["type": "permission", "which": which, "state": grant.rawValue]
        if let detail { json["detail"] = detail }
        net.async { self.rawSend(json: json) }
    }

    /// The whole list after a read that changed something (wire.ts `permissions`); the
    /// daemon puts it in `snapshot.permissions.all`.
    func sendPermissions(all: [PermissionInfo]) {
        let rows = all.map(\.json)
        net.async { self.rawSend(json: ["type": "permissions", "all": rows]) }
    }

    /// A signal the app observed on Kevin's behalf (wire.ts `system.signal`, design11): an app quit, the Mac
    /// woke, a display came. Data for the daemon's watchers, never a command — so never queued: a signal from
    /// before a reconnect is stale, and the daemon's resync covers what it slept through.
    func sendSignal(_ signal: SystemSignal) {
        let json = signal.json(at: Date().timeIntervalSince1970 * 1000)
        net.async {
            guard self.connection != nil, self.isConnected else { return }
            self.rawSend(json: json)
        }
    }

    /// The on-device ear's partial or final transcript (wire.ts `ear`): `at` is ms
    /// since epoch when the recogniser produced it. Never queued: a partial from before
    /// a reconnect is stale by the time the socket is back, so it is simply dropped.
    func sendEar(text: String, isFinal: Bool, segment: Int, at: Int) {
        net.async {
            guard self.connection != nil, self.isConnected else { return }
            self.rawSend(json: ["type": "ear", "text": text, "isFinal": isFinal, "segment": segment, "at": at])
        }
    }

    /// Must run on `net`.
    /// On `net`. Delivers what was queued while disconnected, oldest first.
    private func flushOutbox() {
        let now = Date()
        let due = outbox.filter { now.timeIntervalSince($0.at) < 5 }
        outbox.removeAll()
        for item in due { rawSend(json: item.json) }
        if !due.isEmpty { log("delivered \(due.count) queued command(s) after reconnect") }
    }

    private func rawSend(json: [String: Any]) {
        guard let conn = connection, isConnected else {
            if json["type"] as? String == "command" {
                outbox.append((Date(), json))
                if outbox.count > 20 { outbox.removeFirst(outbox.count - 20) }
                log("daemon not connected; queued command \((json["command"] as? [String: Any])?["type"] as? String ?? "?")")
            }
            return
        }
        do {
            let frame = try Wire.encodeJSON(json)
            conn.send(content: frame, completion: .contentProcessed { [weak self] err in
                if let err { self?.log("send error: \(err)") }
            })
        } catch {
            log("encode error: \(error.localizedDescription)")
        }
    }

    // MARK: - ledger

    func ledgerDays() async -> [String] {
        let any = await request(["type": "ledger.days"])
        return (any as? [String]) ?? []
    }

    func ledgerRows(day: String) async -> [LedgerRow] {
        let any = await request(["type": "ledger.read", "date": day])
        return EngineClient.decodeRows(EngineClient.rows(in: any))
    }

    /// A `ledger.rows` answer resolves with the whole message (so `truncated` travels with the
    /// rows); the rows are its `rows`, or none.
    private static func rows(in any: Any?) -> [Any] {
        ((any as? [String: Any])?["rows"] as? [Any]) ?? []
    }

    /// Jarhead's own Live sessions across the ledger, newest first (`ledger.sessions`).
    func jarheadSessions() async -> [JarheadSessionSummary] {
        let any = await request(["type": "ledger.sessions"])
        guard let list = any as? [Any] else { return [] }
        // One at a time, like the rows: an odd entry must not hide the list.
        var out: [JarheadSessionSummary] = []
        out.reserveCapacity(list.count)
        for entry in list {
            guard JSONSerialization.isValidJSONObject(entry), let data = try? JSONSerialization.data(withJSONObject: entry) else { continue }
            if let s = try? jarheadJSONDecoder.decode(JarheadSessionSummary.self, from: data) { out.append(s) }
        }
        return out
    }

    /// One session's rows, its started row through its closed row (`ledger.session`; answered with `ledger.rows`).
    func jarheadSessionRows(_ id: String) async -> [LedgerRow] {
        let any = await request(["type": "ledger.session", "sessionId": id])
        return EngineClient.decodeRows(EngineClient.rows(in: any))
    }

    /// A whole chain's rows, oldest first, in one request (`ledger.chain` → `ledger.rows` with
    /// `truncated`), in place of one 5 s read per member session. nil when nothing answered
    /// inside `chainTimeout` — a daemon from before the message ignores it — and ConsoleSession
    /// falls back to the per-session reads.
    func jarheadChainRows(_ rootId: String) async -> JarheadChainRows? {
        let any = await request(["type": "ledger.chain", "rootId": rootId], timeout: EngineClient.chainTimeout)
        guard let obj = any as? [String: Any], let rows = obj["rows"] as? [Any] else { return nil }
        return JarheadChainRows(rows: EngineClient.decodeRows(rows), truncated: (obj["truncated"] as? Bool) ?? false)
    }

    // MARK: - memory

    /// What Jarhead remembers, one state at a time (`memory.list` → `memory.items`; `state` is
    /// live | forgotten | merged | archived | all, `limit` ≤ 200 at the daemon). nil when nothing
    /// answered — a daemon from before memory — so the rail says so instead of "nothing remembered".
    /// Items carry text and counts, never a vector (the store keeps those by sha).
    func memoryList(state: String = "live", limit: Int = 50) async -> [MemoryItem]? {
        let any = await request(["type": "memory.list", "state": state, "limit": limit])
        guard let list = any as? [Any] else { return nil }
        return EngineClient.decodeMemoryItems(list)
    }

    /// Items matching `query` (`memory.search` → `memory.items`), best first; nil when nothing answered.
    func memorySearch(query: String, limit: Int = 30) async -> [MemoryItem]? {
        let any = await request(["type": "memory.search", "query": query, "limit": limit])
        guard let list = any as? [Any] else { return nil }
        return EngineClient.decodeMemoryItems(list)
    }

    static func decodeMemoryItems(_ list: [Any]) -> [MemoryItem] {
        // One at a time, like the rows: an odd item must not hide the list.
        var out: [MemoryItem] = []
        out.reserveCapacity(list.count)
        for entry in list {
            guard JSONSerialization.isValidJSONObject(entry), let data = try? JSONSerialization.data(withJSONObject: entry) else { continue }
            if let item = try? jarheadJSONDecoder.decode(MemoryItem.self, from: data) { out.append(item) }
        }
        return out
    }

    // MARK: - search

    /// Full-text hits over the live ledger for the Console's search box (`ledger.search`,
    /// answered with `ledger.hits`). nil when nothing answers — a disconnect, or the request
    /// timeout — so the rail can say so instead of "no hits".
    func ledgerSearch(query: String, limit: Int = 50) async -> [LedgerHit]? {
        let any = await request(["type": "ledger.search", "query": query, "limit": limit])
        guard let list = any as? [Any] else { return nil }
        return list.compactMap { ($0 as? [String: Any]).flatMap(LedgerHit.init(json:)) }
    }

    /// One request → one answer by id, or nil after `timeout` or on a disconnect.
    private func request(_ message: [String: Any], timeout: TimeInterval = EngineClient.ledgerTimeout) async -> Any? {
        await withCheckedContinuation { (cont: CheckedContinuation<Any?, Never>) in
            net.async {
                let id = UUID().uuidString
                guard self.connection != nil, self.isConnected else {
                    cont.resume(returning: nil)
                    return
                }
                self.pendingLedger[id] = { cont.resume(returning: $0) }
                var msg = message
                msg["id"] = id
                self.rawSend(json: msg)
                self.net.asyncAfter(deadline: .now() + timeout) { [weak self] in
                    if let resolve = self?.pendingLedger.removeValue(forKey: id) { resolve(nil) }
                }
            }
        }
    }

    private func failPendingLedger() {
        let all = pendingLedger
        pendingLedger.removeAll()
        for (_, resolve) in all { resolve(nil) }
    }

    static func decodeRows(_ rows: [Any]) -> [LedgerRow] {
        // The rows are loosely typed; decode one at a time so a single odd row does not hide the day.
        var out: [LedgerRow] = []
        out.reserveCapacity(rows.count)
        for row in rows {
            guard JSONSerialization.isValidJSONObject(row), let data = try? JSONSerialization.data(withJSONObject: row) else { continue }
            if let r = try? jarheadJSONDecoder.decode(LedgerRow.self, from: data) { out.append(r) }
        }
        return out
    }

    // MARK: - receiving

    private func handle(_ frame: Frame) {
        switch frame.type {
        case FrameType.speaker.rawValue:
            audio?.play(pcm: frame.payload)
        case FrameType.json.rawValue:
            guard let obj = try? JSONSerialization.jsonObject(with: frame.payload) as? [String: Any],
                  let type = obj["type"] as? String else { return }
            handleMessage(type: type, obj)
        default:
            break // type 2 (mic) never flows daemon → app
        }
    }

    private func handleMessage(type: String, _ obj: [String: Any]) {
        switch type {
        case "hello":
            let dir = obj["stateDir"] as? String
            if let pid = obj["pid"] as? Int, pid > 0, pid <= Int(Int32.max) { daemonPid = Int32(pid) }
            onMain { st in
                if let dir, !dir.isEmpty { st.stateDir = URL(fileURLWithPath: dir) }
                // A daemon process numbers its thread events from 1: the replay guard restarts with it.
                st.noteDaemonHello()
            }
        case "pong":
            if let id = obj["id"] as? String { pendingPings.removeAll { $0 == id } }
        case "snapshot":
            guard let sub = obj["snapshot"], let snap: Snapshot = decode(sub) else {
                log("undecodable snapshot")
                return
            }
            noteSnapshotForResume(snap)
            queueSnapshot(sanitized(snap))
        case "levels":
            guard let sub = obj["levels"], let levels: AudioLevels = decode(sub) else { return }
            let clean = AudioLevels(input: finiteLevel(levels.input), output: finiteLevel(levels.output))
            onMain { $0.levels = clean }
        case "toast":
            let text = obj["text"] as? String ?? ""
            let tone = Toast.Tone(rawValue: obj["tone"] as? String ?? "info") ?? .info
            guard !text.isEmpty else { return }
            onMain { $0.toast(text, tone: tone) }
        case "overlay":
            guard let cmdObj = obj["command"] as? [String: Any], let cmd = OverlayCommand(json: cmdObj) else { return }
            onMain { $0.overlayCommands.send(cmd) }
        case "audio":
            if obj["control"] as? String == "flush" { audio?.flush() }
        case "agent.transcript":
            guard let sub = obj["transcript"], let t: AgentTranscript = decode(sub) else { return }
            let mode = obj["mode"] as? String ?? "replace"
            onMain { $0.applyTranscript(t, mode: mode) }
        case "thread.event":
            // One ≤ 200 B delta on one thread (broadcast, coalesced 50 ms per thread by the engine):
            // never a snapshot. `started` carries the record; the rest patch what AppState holds.
            guard let sub = obj["event"], let e: ThreadEvent = decode(sub) else { return }
            onMain { $0.applyThreadEvent(e) }
        case "thread.transcript":
            // A thread's conversation page or delta, to this pane's viewer only (Model/ThreadStore.swift).
            guard let sub = obj["transcript"], let t: ThreadTranscript = decode(sub) else { return }
            let mode = obj["mode"] as? String ?? "replace"
            onMain { $0.applyThreadTranscript(t, mode: mode) }
        case "ledger.rows":
            // The whole message: `rows`, and `truncated` when a chain read hit its cap.
            if let id = obj["id"] as? String, let resolve = pendingLedger.removeValue(forKey: id) { resolve(obj) }
        case "memory.items":
            if let id = obj["id"] as? String, let resolve = pendingLedger.removeValue(forKey: id) { resolve(obj["items"]) }
        case "ledger.days":
            if let id = obj["id"] as? String, let resolve = pendingLedger.removeValue(forKey: id) { resolve(obj["days"]) }
        case "ledger.sessions":
            if let id = obj["id"] as? String, let resolve = pendingLedger.removeValue(forKey: id) { resolve(obj["sessions"]) }
        case "ledger.hits":
            if let id = obj["id"] as? String, let resolve = pendingLedger.removeValue(forKey: id) { resolve(obj["hits"]) }
        case "automation.event":
            // One ≤ 200 B delta on one automation row (design11): `set` carries the row, the rest patch what
            // AppState holds; `fired` is what a crash report should know the app was doing.
            guard let sub = obj["event"], let e: AutomationEvent = decode(sub) else { return }
            if e.kind == "fired" {
                var note = "automation → fired \(e.id)"
                if let line = e.line { note += " “\(line.prefix(40))”" }
                CrashGuard.remember(note)
            }
            onMain { $0.applyAutomationEvent(e) }
        case "local.say":
            // The daemon has no speaker: the app plays the earcon and reads the fixed line (never model text but a
            // redacted wake-brain line ≤ 160) through the gate's LocalSpeaker — never while a session is open.
            guard let msg: LocalSayMessage = decode(obj) else { return }
            CrashGuard.remember("automation → local.say \(msg.automationId)")
            onMain { [onLocalSay] _ in onLocalSay?(msg) }
        case "notify":
            guard let msg: NotifyMessage = decode(obj) else { return }
            CrashGuard.remember("automation → notify \(msg.automationId)")
            onMain { [onNotify] _ in onNotify?(msg) }
        case "ear.hints":
            // What is on the screen (wire.ts `ear.hints`): the words the on-device ear should
            // be biased toward. Handed over by notification on this queue; ReflexEar owns the
            // listener and applies them (Ear/EarListener.swift `applyHints`).
            guard let strings = obj["strings"] as? [String] else { return }
            NotificationCenter.default.post(name: .jarheadEarHints, object: nil, userInfo: ["strings": strings])
        case "error":
            let message = obj["message"] as? String ?? "daemon error"
            log("daemon error: \(message)")
            onMain { $0.toast(message, tone: .error) }
        default:
            break
        }
    }

    // MARK: - bad numbers

    /// JSON cannot carry a NaN or an infinity — `JSON.stringify` writes `null`, which
    /// the decoder refuses for a `Double` — so none arrives today; a future producer or
    /// serializer must not be able to hand the sim, the meter or a layout one either.
    /// Every level, and every number of the snapshot the app does arithmetic on, becomes
    /// 0 when it is not finite; the first such frame is logged, then silence. On `net`.
    private var badNumberLogged = false

    private func noteBadNumber(_ what: String) {
        guard !badNumberLogged else { return }
        badNumberLogged = true
        log("non-finite \(what) from the daemon — clamped to 0 (logged once)")
    }

    /// A level as the app keeps it: finite and 0…1. `min(1, max(0, x))` would hand a
    /// NaN on unchanged (`0 >= nan` is false), which is why this checks first.
    private func finiteLevel(_ x: Double) -> Double {
        guard x.isFinite else { noteBadNumber("level"); return 0 }
        return min(1, max(0, x))
    }

    private func finite(_ x: Double, _ what: String) -> Double {
        guard x.isFinite else { noteBadNumber(what); return 0 }
        return x
    }

    /// The snapshot's numbers the app computes with (the meter, the pause countdown,
    /// the session's context ratio), finite or 0.
    private func sanitized(_ snap: Snapshot) -> Snapshot {
        var s = snap
        if var session = s.session {
            session.startedAt = finite(session.startedAt, "session.startedAt")
            session.expiresAt = finite(session.expiresAt, "session.expiresAt")
            session.usageSeconds = finite(session.usageSeconds, "session.usageSeconds")
            if let ratio = session.contextRatio { session.contextRatio = finite(ratio, "session.contextRatio") }
            s.session = session
        }
        if var pause = s.pause {
            pause.at = finite(pause.at, "pause.at")
            pause.usageSeconds = finite(pause.usageSeconds, "pause.usageSeconds")
            pause.sleepsAt = finite(pause.sleepsAt, "pause.sleepsAt")
            s.pause = pause
        }
        if var usage = s.usageToday {
            usage.seconds = finite(usage.seconds, "usageToday.seconds")
            s.usageToday = usage
        }
        return s
    }

    private func decode<T: Decodable>(_ any: Any) -> T? {
        guard JSONSerialization.isValidJSONObject(any), let data = try? JSONSerialization.data(withJSONObject: any) else { return nil }
        do {
            return try jarheadJSONDecoder.decode(T.self, from: data)
        } catch {
            log("decode \(T.self): \(error)")
            return nil
        }
    }

    private func queueSnapshot(_ snap: Snapshot) {
        pendingSnapshot = snap
        guard !snapshotPublishScheduled else { return }
        let elapsed = Double(DispatchTime.now().uptimeNanoseconds - lastSnapshotPublish.uptimeNanoseconds) / 1e9
        let wait = max(0, EngineClient.minSnapshotInterval - elapsed)
        snapshotPublishScheduled = true
        net.asyncAfter(deadline: .now() + wait) { [weak self] in
            guard let self else { return }
            self.snapshotPublishScheduled = false
            self.lastSnapshotPublish = .now()
            guard let s = self.pendingSnapshot else { return }
            self.pendingSnapshot = nil
            // The snapshot's thread summaries merge into AppState.threads beside the events.
            self.onMain { st in
                st.snapshot = s
                st.applySnapshotThreads(s.threads)
            }
        }
    }

    // MARK: - publishing

    private func publishConnected(_ on: Bool) {
        onMain { st in
            if st.connected != on { st.connected = on }
            if !on { st.levels = .silent }
        }
    }

    private func onMain(_ body: @escaping @MainActor (AppState) -> Void) {
        let st = state
        DispatchQueue.main.async {
            MainActor.assumeIsolated { body(st) }
        }
    }

    private func log(_ s: String) {
        NSLog("EngineClient: %@", s)
    }
}
