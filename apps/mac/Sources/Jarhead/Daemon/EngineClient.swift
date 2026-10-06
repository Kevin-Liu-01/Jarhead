import Foundation
import Network

/// The socket client: connects to jarheadd, reconnects while it (re)starts, decodes
/// frames, and publishes into `AppState` on the main actor. Speaker frames go to the
/// `AudioEngine`; mic frames come from it through `sendMic`.
/// Queue-confined (`net`); the class is safe to hand across threads.
///
/// Snapshots are decoded once, off `net`, on their own serial queue (voice PLAN W2.2): the speaker's
/// frames and the `audio` flush ride the same socket and are handed on from `net` in arrival order,
/// so a 283 KB snapshot decoded inline held every speaker frame behind it for the whole decode.
/// Every other JSON frame stays on `net`, in order with the PCM. At most one decode runs and one
/// payload waits, the newest (the app's half of W2.3): a burst is decoded twice, not once per frame.
final class EngineClient: @unchecked Sendable {
    private let socketPath: String
    private let state: AppState
    private let net = DispatchQueue(label: "jarhead.engine-client")
    /// Where snapshots are decoded, one at a time (`decodeNextSnapshot`).
    private let snapshotQueue = DispatchQueue(label: "jarhead.engine-client.snapshot", qos: .userInitiated)
    /// The newest snapshot payload not yet decoded, with its connection's epoch and its arrival number. A newer one
    /// replaces it: snapshots are whole states, so only the newest says anything. On `net`.
    private var snapshotSlot: (payload: Data, epoch: Int, seq: Int)?
    /// A decode is under way on `snapshotQueue`. On `net`.
    private var snapshotDecoding = false
    /// Snapshots in arrival order, and the newest one applied: a decode that finishes after a newer snapshot
    /// applied (on handleMessage's fallback path) is dropped. On `net`.
    private var snapshotSeq = 0
    private var snapshotAppliedSeq = 0
    /// Snapshots decoded off `net` since launch. On `net`; the snapshot probe reads it by reflection, once the socket is quiet.
    private var snapshotDecodes = 0
    /// Bumped whenever a connection opens, drops or stops (on `net`): a snapshot decoded for a connection
    /// that has gone since says nothing about the daemon now, and is not applied.
    private var connectionEpoch = 0
    private var connection: NWConnection?
    private let decoder = FrameDecoder()
    private var running = false
    private var reconnectDelay: TimeInterval = 0.3
    private var reconnectScheduled = false
    /// The socket is open (NWConnection `.ready`). Not yet "connected": a wedged daemon's kernel
    /// accepts the connection into its backlog and nothing ever answers on it. On `net`.
    private var transportReady = false
    /// The daemon said `hello` on this connection: it is serving. `connected` means this. On `net`.
    private var isConnected = false
    /// Commands sent while the daemon is (re)connecting. Stop, wake, pause must not
    /// vanish because a reconnect was in flight; they are delivered once the daemon's first
    /// snapshot after its hello is judged (`releaseOutbox`), oldest first, dropped when they
    /// were 5 s old at the hello or beyond 20 entries. `opens`: the command would open a paid
    /// session (`opensSession`); `typed`: it is a typed line (its toast says "Not sent"). On `net`.
    private var outbox: [(at: Date, json: [String: Any], opens: Bool, typed: Bool)] = []
    /// The hello came and this connection's first snapshot is not judged yet (APP-3): commands
    /// keep queueing behind the outbox, so nothing queued through an outage reaches a daemon
    /// before the app knows it can read it. A Go pressed while a daemon respawns from new source
    /// would otherwise open a paid session on a daemon whose snapshots this build cannot decode.
    /// Ended by the first snapshot, decoded or not, or after `outboxSnapshotWait`. On `net`.
    private var outboxHeld = false
    /// When this connection's hello came: a queued command's 5 s are counted to it, not to the snapshot after it. On `net`.
    private var helloAt: Date?

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
    // and not answering — a wedged event loop — was invisible. So: the client counts as
    // connected only once the daemon's `hello` arrives (the kernel accepts a connection for
    // a wedged daemon too), and one `ping` goes every 2 s from the moment the socket opens,
    // answered by the daemon on the wire with no engine work (`pong`). Two unanswered in a
    // row and this client drops the connection and reconnects. The kick is a SIGKILL that
    // takes the session, the threads and the turn in flight with it, so it waits longer:
    // only when the daemon has said nothing for `silenceBeforeKick` (it lands on the second
    // silent connection, about 12 s after its last answer) does this client tell
    // DaemonProcess (a notification: both are the app's, no AppDelegate wiring) to kill and
    // respawn it. A slow synchronous moment in the daemon (a long ledger search on a loaded
    // Mac) costs a reconnect, not the daemon. While no daemon answers for more than a beat,
    // the published snapshot carries one typed problem, `daemon`, whose remedy is "Restart
    // daemon" (the `daemon.restart` command, routed to DaemonProcess while nothing is
    // connected); the next real snapshot replaces it. The beat is `daemonProblemAfter` after
    // a drop, and `daemonProblemAtStartAfter` from launch for a daemon that never answered
    // at all (a fresh install whose daemon dies at start). And when the daemon comes back
    // asleep after a session was open — a crash, a kill, a self-update mid-conversation —
    // this client sends `go` once, inside 10 s of the reconnect; the engine resumes the
    // conversation from the ledger (Engine.resumeFromLedger). Never after Kevin pressed Stop
    // or Pause since that session's last snapshot; never twice.

    /// Posted on the main queue when the daemon has answered nothing for `silenceBeforeKick`, across a fresh connection. `userInfo`: `pid` (Int32, the daemon's, when this connection's hello said) and `seconds` (Int, the silence).
    nonisolated static let daemonUnresponsiveNotification = Notification.Name("jarhead.daemonUnresponsive")
    /// Posted on the main queue when the "Restart daemon" remedy is pressed while no daemon is connected. No `pid`: nothing is connected, so there is no daemon of ours to name.
    nonisolated static let restartDaemonNotification = Notification.Name("jarhead.restartDaemon")

    static let pingInterval: TimeInterval = 2
    /// Unanswered pings on one connection before it is dropped and opened again.
    static let missedPongsBeforeDrop = 2
    /// How long the daemon may say nothing (counted from the first ping it left unanswered)
    /// before the kick. A connection's two missed pings are 4 s, under it: that drop only
    /// reconnects. The fresh connection's two are past it, so the kick lands on the second
    /// silent connection, about 12 s after the daemon's last answer.
    static let silenceBeforeKick: TimeInterval = 8
    /// How long disconnected before the `daemon` row appears: a normal respawn is back in 1–3 s and must not flash it.
    static let daemonProblemAfter: TimeInterval = 3
    /// The same from launch, when no daemon has answered yet: a cold start (tsx compiling the engine on a fresh install) takes a few seconds more.
    static let daemonProblemAtStartAfter: TimeInterval = 8
    /// After a reconnect, a daemon reporting asleep inside this window gets one `go` when a session was open before the drop.
    static let autoResumeWindow: TimeInterval = 10
    static let daemonProblemText = "The engine is not answering; Jarhead cannot hear or act until it is back"

    private var pingTimer: DispatchSourceTimer?
    /// Pings sent on this connection and not yet answered, oldest first. On `net`.
    private var pendingPings: [(id: String, at: Date)] = []
    /// When the daemon went quiet: the send time of the first ping it left unanswered. Kept
    /// across a drop and the fresh connection after it; cleared by any hello or pong. On `net`.
    private var silentSince: Date?
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
    /// When the current outage began (launch, or the drop), nil while connected. On `net`.
    private var disconnectedAt: Date?
    /// How long this outage waits before the `daemon` row: `daemonProblemAtStartAfter` until a daemon has answered once. On `net`.
    private var outageGrace: TimeInterval = EngineClient.daemonProblemAtStartAfter
    /// The outage whose row is already scheduled, so every failed connect can arm it without stacking timers. On `net`.
    private var problemArmedFor: Date?

    // MARK: version skew (APP-3)
    //
    // The app and the daemon are built from one checkout, and a pull or a respawn from new source under an old binary
    // splits them. Two things say so: the daemon's hello names another PROTOCOL_VERSION (or none: a daemon from before
    // the field), or a snapshot this build cannot decode. Either one raises `app.version` (`skewProblemText`, remedy
    // Restart daemon with `pnpm build:mac` to copy) on top of every snapshot this client publishes, and refuses the
    // commands that open a paid session (`opensSession`) with a toast, the auto-resume's `go` included: the app could
    // not show the meter of a session it cannot read. It clears when a hello names this build's number and the
    // snapshots decode again (a Restart daemon fixes a daemon older than the app; only a rebuild fixes an app older
    // than the daemon).

    static let skewProblemText = "The app and the daemon are from different builds. Restart the daemon. If this stays, run pnpm build:mac."
    /// The toast when a command that would open a session is refused for the skew.
    static let skewRefusedText = "Not started. The app and the daemon are from different builds."
    static let skewNotSentText = "Not sent. The app and the daemon are from different builds."
    /// How long after a hello the outbox waits for the daemon's first snapshot (server.ts sends one right after its
    /// hello). None by then: what was queued goes, except what would open a session, which is refused with these.
    static let outboxSnapshotWait: TimeInterval = 3
    static let notJudgedRefusedText = "Not started. The daemon has not sent its state yet."
    static let notJudgedNotSentText = "Not sent. The daemon has not sent its state yet."

    /// This connection's hello named another contract, or none. Set at every hello. On `net`.
    private var helloSkew = false
    /// A snapshot frame did not decode, and none has since. Only a decoded snapshot clears it (a fresh connection's
    /// first snapshot judges the daemon that answers now). On `net`.
    private var undecodableSkew = false
    /// When the skew in force was first seen (ms), the row's `since`; nil while there is none. On `net`.
    private var skewSince: Double?
    /// The daemon's state dir from this connection's hello: where `settings.json` says whether Setup has run. On `net`.
    private var daemonStateDir: String?
    private var skewed: Bool { helloSkew || undecodableSkew }

    init(socketPath: String, state: AppState) {
        self.socketPath = socketPath
        self.state = state
    }

    // MARK: - lifecycle

    func start() {
        net.async {
            guard !self.running else { return }
            self.running = true
            // The outage starts now: nothing has answered yet. A daemon that never does (it dies
            // at every start, its checkout lacks node_modules) gets the `daemon` row like a drop.
            self.disconnectedAt = Date()
            self.outageGrace = EngineClient.daemonProblemAtStartAfter
            self.armDaemonProblem()
            self.openConnection()
        }
    }

    func stop() {
        net.async {
            self.running = false
            self.connectionEpoch += 1
            self.outboxHeld = false
            self.helloAt = nil
            self.stopPings()
            self.silentSince = nil
            self.resumeCandidate = false
            self.daemonPid = nil
            self.connection?.cancel()
            self.connection = nil
            self.transportReady = false
            self.isConnected = false
            self.failPendingLedger()
            self.publishConnected(false)
        }
    }

    private func openConnection() {
        guard running else { return }
        connection?.cancel()
        connectionEpoch += 1
        decoder.reset()
        transportReady = false
        let conn = NWConnection(to: .unix(path: socketPath), using: .tcp)
        connection = conn
        conn.stateUpdateHandler = { [weak self] st in
            guard let self, conn === self.connection else { return }
            switch st {
            case .ready:
                // The socket is open; the daemon is not proven until its hello (`helloReceived`).
                // The pings start now, so a daemon that never says hello is caught like one that
                // stops answering.
                self.transportReady = true
                self.sendHello()
                self.startPings()
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

    /// On `net`: the daemon's hello on this connection. Only now is the app connected:
    /// `connected` flips, the outage (and its `daemon` row) ends, the outbox waits for the
    /// first snapshot (`holdOutbox`), and the app re-sends what a fresh daemon must know.
    private func helloReceived() {
        guard transportReady, !isConnected else { return }
        reconnectDelay = 0.3
        isConnected = true
        disconnectedAt = nil
        problemArmedFor = nil
        holdOutbox()
        publishConnected(true)
        // The window for one `go` if the daemon comes back asleep after a session was open.
        if resumeCandidate { resumeDeadline = Date().addingTimeInterval(EngineClient.autoResumeWindow) }
        if let cb = onConnected { DispatchQueue.main.async(execute: cb) }
    }

    private func dropAndReconnect() {
        // A connect the socket refused or did not have (no file) is not silence: the daemon is
        // gone or starting, and the one that answers next owes nothing to the last one's quiet.
        if !transportReady { silentSince = nil }
        connection?.cancel()
        connection = nil
        connectionEpoch += 1
        transportReady = false
        // Whatever the hold kept stays in the outbox for the next hello.
        outboxHeld = false
        helloAt = nil
        stopPings()
        // The pid lives exactly as long as the connection that hello'd it.
        daemonPid = nil
        if isConnected {
            isConnected = false
            publishConnected(false)
            failPendingLedger()
            noteDisconnected()
        } else {
            // A connect that failed, or a socket that opened and never said hello: the outage
            // goes on, and its row is armed (once per outage) however it began.
            armDaemonProblem()
        }
        scheduleReconnect()
    }

    /// On `net`: the `daemon` row for the current outage, `outageGrace` after it began, unless
    /// a hello ends the outage first. Idempotent per outage: every failed connect calls it.
    private func armDaemonProblem() {
        if disconnectedAt == nil { disconnectedAt = Date() }
        guard let since = disconnectedAt, problemArmedFor != since else { return }
        problemArmedFor = since
        let wait = max(0, outageGrace - Date().timeIntervalSince(since))
        net.asyncAfter(deadline: .now() + wait) { [weak self] in
            guard let self, self.running, !self.isConnected, self.disconnectedAt == since else { return }
            self.publishDaemonProblem()
        }
    }

    /// On `net`, once per drop: arm the auto-resume from what the daemon last said, and
    /// schedule the `daemon` row for a drop that lasts.
    private func noteDisconnected() {
        let now = Date()
        disconnectedAt = now
        outageGrace = EngineClient.daemonProblemAfter
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
        armDaemonProblem()
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

    /// On `net`. Two pings unanswered on this connection: drop it, and the reconnect loop opens
    /// a fresh one. When the daemon has also been silent for `silenceBeforeKick` (so a fresh
    /// connection got nothing either), it is up and not listening: ask DaemonProcess to kill
    /// and respawn it as well. Otherwise send the next ping.
    private func pingTick() {
        guard transportReady, connection != nil else { return }
        if pendingPings.count >= EngineClient.missedPongsBeforeDrop {
            let now = Date()
            let since = silentSince ?? pendingPings.first?.at ?? now
            silentSince = since
            let silence = now.timeIntervalSince(since)
            let unanswered = "\(pendingPings.count) pings unanswered on this connection"
            if silence >= EngineClient.silenceBeforeKick {
                log("daemon unresponsive: nothing for \(Int(silence)) s (\(unanswered)); dropping the connection and asking for a respawn")
                var info: [AnyHashable: Any] = ["seconds": Int(silence)]
                if let pid = daemonPid { info["pid"] = pid }
                DispatchQueue.main.async { NotificationCenter.default.post(name: EngineClient.daemonUnresponsiveNotification, object: nil, userInfo: info) }
            } else {
                log("daemon quiet: nothing for \(Int(silence)) s (\(unanswered)); dropping the connection and reconnecting (the kick waits for \(Int(EngineClient.silenceBeforeKick)) s of silence)")
            }
            dropAndReconnect()
            return
        }
        let id = UUID().uuidString
        pendingPings.append((id, Date()))
        write(json: ["type": "ping", "id": id])
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
        guard !skewed else {
            log("auto-resume: the app and the daemon are from different builds; not sending go (app.version)")
            return
        }
        log("auto-resume: the daemon came back asleep after a session was open; sending go once")
        resumeGoSentAt = Date()
        rawSend(json: ["type": "command", "command": EngineCommand.go.json], opens: true)
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
        write(json: ["type": "hello", "pid": Int(ProcessInfo.processInfo.processIdentifier), "version": appVersion, "audio": true, "protocol": ProtocolVersion.current])
    }

    func send(_ command: EngineCommand) {
        net.async {
            if self.skewed, EngineClient.opensSession(command) {
                // APP-3: nothing opens a paid session the app cannot read. The row says what to do.
                self.log("refused \(command.json["type"] as? String ?? "?"): the app and the daemon are from different builds (app.version)")
                let words = EngineClient.isTypedLine(command) ? EngineClient.skewNotSentText : EngineClient.skewRefusedText
                self.onMain { $0.toast(words, tone: .warn) }
                return
            }
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
            self.rawSend(json: ["type": "command", "command": command.json], opens: EngineClient.opensSession(command), typed: EngineClient.isTypedLine(command))
        }
    }

    /// The commands that can open a paid session: Go, a resume, Switch now's reopen, and a typed line (it resumes a
    /// paused conversation, or wakes Jarhead with typed wakes on). Refused while the builds differ (APP-3).
    static func opensSession(_ command: EngineCommand) -> Bool {
        switch command {
        case .go, .resume, .voiceReopen: return true
        default: return isTypedLine(command)
        }
    }

    /// A line typed to the main conversation (the composer, the main thread's pane).
    static func isTypedLine(_ command: EngineCommand) -> Bool {
        switch command {
        case .sayText: return true
        case .threadSay(let threadId, _): return threadId == "main"
        default: return false
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

    /// On `net`, at the hello: the outbox waits for this connection's first snapshot (`releaseOutbox`), or
    /// `outboxSnapshotWait`, whichever comes first.
    private func holdOutbox() {
        helloAt = Date()
        outboxHeld = true
        let epoch = connectionEpoch
        net.asyncAfter(deadline: .now() + EngineClient.outboxSnapshotWait) { [weak self] in
            guard let self, self.connectionEpoch == epoch, self.outboxHeld else { return }
            self.log("no snapshot \(Int(EngineClient.outboxSnapshotWait)) s after the hello; the outbox goes, nothing that opens a session")
            self.releaseOutbox(judged: false)
        }
    }

    /// On `net`: this connection's first snapshot was judged (`judged`: decoded, or not, which raised the skew first),
    /// or none came in time. The hold ends, and the outbox goes.
    private func releaseOutbox(judged: Bool) {
        guard outboxHeld else { return }
        outboxHeld = false
        flushOutbox(judged: judged)
    }

    /// On `net`. Delivers what was queued while disconnected or held, oldest first. A command that would open a session
    /// goes only when the first snapshot was judged and the builds match: skewed, or with no snapshot yet, it is refused
    /// with a toast, the way `send` refuses one (APP-3). A Go from before a reconnect waits for the daemon's state.
    private func flushOutbox(judged: Bool) {
        let cutoff = helloAt ?? Date()
        let due = outbox.filter { cutoff.timeIntervalSince($0.at) < 5 }
        outbox.removeAll()
        var delivered = 0
        var toasts: [String] = []
        for item in due {
            if item.opens && (skewed || !judged) {
                let type = (item.json["command"] as? [String: Any])?["type"] as? String ?? "?"
                log("refused queued \(type): \(skewed ? "the app and the daemon are from different builds (app.version)" : "no snapshot from the daemon yet")")
                let words = skewed ? (item.typed ? EngineClient.skewNotSentText : EngineClient.skewRefusedText)
                    : (item.typed ? EngineClient.notJudgedNotSentText : EngineClient.notJudgedRefusedText)
                if !toasts.contains(words) { toasts.append(words) }
                continue
            }
            write(json: item.json)
            delivered += 1
        }
        if delivered > 0 { log("delivered \(delivered) queued command(s) after reconnect") }
        for words in toasts { onMain { $0.toast(words, tone: .warn) } }
    }

    /// On `net`. To a daemon that has said hello; a command sent before that, or while the outbox is held for the first
    /// snapshot, waits in the outbox. Any other frame goes at once, or nowhere while disconnected.
    private func rawSend(json: [String: Any], opens: Bool = false, typed: Bool = false) {
        let isCommand = json["type"] as? String == "command"
        if isCommand && (connection == nil || !isConnected || outboxHeld) {
            outbox.append((Date(), json, opens, typed))
            if outbox.count > 20 { outbox.removeFirst(outbox.count - 20) }
            let type = (json["command"] as? [String: Any])?["type"] as? String ?? "?"
            log(isConnected ? "queued command \(type) until the daemon's first snapshot" : "daemon not connected; queued command \(type)")
            return
        }
        guard connection != nil, isConnected else { return }
        write(json: json)
    }

    /// On `net`. Onto the open socket, hello or not: the app's own hello and the pings.
    private func write(json: [String: Any]) {
        guard let conn = connection, transportReady else { return }
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

    /// The day list, newest first, with each day's totals beside it (LM-6; none from a daemon before them). nil when
    /// nothing answered. A total that does not decode is left out, never the list.
    func ledgerDaysAnswer() async -> LedgerDays? {
        let any = await request(["type": "ledger.days"])
        guard let obj = any as? [String: Any], let days = obj["days"] as? [String] else { return nil }
        var totals: [String: LedgerDayTotals] = [:]
        for entry in (obj["totals"] as? [Any]) ?? [] {
            guard JSONSerialization.isValidJSONObject(entry), let data = try? JSONSerialization.data(withJSONObject: entry),
                  let t = try? jarheadJSONDecoder.decode(LedgerDayTotals.self, from: data) else { continue }
            totals[t.day] = t
        }
        // `partial`: the daemon answered within its budget with the days it had read; asking again finds more.
        return LedgerDays(days: days, totals: totals, partial: (obj["partial"] as? Bool) ?? false)
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

    /// Full-text hits over the live ledger for the Console's search box, one page (`ledger.search {before}` →
    /// `ledger.hits {older}`): the daemon reads a bounded slice of day files per request, and `older` is where the next
    /// page starts. nil when nothing answers (a disconnect, or the request timeout), so the rail can say so instead of
    /// "no hits".
    func ledgerSearchPage(query: String, limit: Int, before: String?) async -> LedgerSearchPage? {
        var message: [String: Any] = ["type": "ledger.search", "query": query, "limit": limit]
        if let before { message["before"] = before }
        let any = await request(message)
        guard let obj = any as? [String: Any], let list = obj["hits"] as? [Any] else { return nil }
        let older = (obj["older"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        return LedgerSearchPage(hits: list.compactMap { ($0 as? [String: Any]).flatMap(LedgerHit.init(json:)) }, older: older)
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
            // A snapshot goes to its own queue; nothing behind it waits for its decode.
            if EngineClient.isSnapshotFrame(frame.payload) {
                decodeSnapshot(frame.payload)
                return
            }
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
            daemonStateDir = dir
            noteHelloProtocol(obj["protocol"])
            onMain { st in
                if let dir, !dir.isEmpty { st.stateDir = URL(fileURLWithPath: dir) }
                // A daemon process numbers its thread events from 1: the replay guard restarts with it.
                st.noteDaemonHello()
            }
            silentSince = nil
            helloReceived()
        case "pong":
            // An answer: the daemon's loop is running, whatever came before.
            silentSince = nil
            if let id = obj["id"] as? String { pendingPings.removeAll { $0.id == id } }
        case "snapshot":
            // A snapshot frame that does not start with its type (`isSnapshotFrame`), decoded here as before.
            snapshotSeq += 1
            guard let sub = obj["snapshot"], let snap: Snapshot = decode(sub) else {
                snapshotUndecodable()
                return
            }
            applySnapshot(snap, seq: snapshotSeq)
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
            // The whole message: `days`, and the `totals` beside them (LM-6).
            if let id = obj["id"] as? String, let resolve = pendingLedger.removeValue(forKey: id) { resolve(obj) }
        case "ledger.sessions":
            if let id = obj["id"] as? String, let resolve = pendingLedger.removeValue(forKey: id) { resolve(obj["sessions"]) }
        case "ledger.hits":
            // The whole message: `hits`, and `older` when the page stopped with older days unread.
            if let id = obj["id"] as? String, let resolve = pendingLedger.removeValue(forKey: id) { resolve(obj) }
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

    // MARK: - snapshots, off `net`

    /// `{"type":"snapshot"` opens every snapshot frame: server.ts writes `type` first (JSON.stringify keeps
    /// insertion order). Checking it costs a few bytes; parsing the frame to learn its type cost the whole decode.
    static let snapshotPrefix = Data(#"{"type":"snapshot""#.utf8)

    static func isSnapshotFrame(_ payload: Data) -> Bool {
        payload.count >= snapshotPrefix.count && payload.prefix(snapshotPrefix.count).elementsEqual(snapshotPrefix)
    }

    /// The frame as the wire spells it, decoded in one pass: no `[String: Any]`, no re-serialisation.
    private struct SnapshotFrame: Decodable {
        let snapshot: Snapshot
    }

    /// On `net`: the payload waits in the one slot (replacing any older one), and a decode starts unless one runs.
    private func decodeSnapshot(_ payload: Data) {
        snapshotSeq += 1
        snapshotSlot = (payload, connectionEpoch, snapshotSeq)
        if !snapshotDecoding { decodeNextSnapshot() }
    }

    /// On `net`: decode the waiting payload on `snapshotQueue`, apply it back on `net` unless its connection has gone
    /// since, then take whatever arrived meanwhile (the newest only). A payload from a gone connection is dropped undecoded.
    private func decodeNextSnapshot() {
        guard let next = snapshotSlot else {
            snapshotDecoding = false
            return
        }
        snapshotSlot = nil
        guard next.epoch == connectionEpoch else {
            decodeNextSnapshot()
            return
        }
        snapshotDecoding = true
        snapshotDecodes += 1
        snapshotQueue.async { [weak self] in
            guard let self else { return }
            var snap: Snapshot?
            do {
                snap = try jarheadJSONDecoder.decode(SnapshotFrame.self, from: next.payload).snapshot
            } catch {
                self.log("decode Snapshot: \(error)")
            }
            self.net.async {
                if next.epoch == self.connectionEpoch {
                    if let snap {
                        self.applySnapshot(snap, seq: next.seq)
                    } else {
                        self.snapshotUndecodable()
                    }
                }
                self.decodeNextSnapshot()
            }
        }
    }

    /// On `net`: a snapshot frame that did not decode, from either path (the prefix path off `net`, which every
    /// daemon snapshot takes, or `handleMessage`'s fallback). It is logged and dropped, and it raises `app.version`
    /// (APP-3): an app that cannot read the daemon is not connected in any way Kevin can see.
    private func snapshotUndecodable() {
        log("undecodable snapshot")
        if !undecodableSkew {
            undecodableSkew = true
            noteSkew(because: "a snapshot this build cannot decode")
        }
        // Judged: the skew is up, so the outbox's Go is refused, never handed to this daemon.
        releaseOutbox(judged: true)
    }

    /// On `net`, at every hello: the daemon's PROTOCOL_VERSION against this build's.
    private func noteHelloProtocol(_ value: Any?) {
        let theirs = (value as? NSNumber)?.intValue
        let was = skewed
        helloSkew = theirs != ProtocolVersion.current
        if helloSkew {
            noteSkew(because: "the daemon's hello names protocol \(theirs.map(String.init) ?? "none"), this app \(ProtocolVersion.current)")
        } else if was && !skewed {
            skewSince = nil
            log("app.version: the daemon's hello names protocol \(ProtocolVersion.current), as this app does")
        }
    }

    /// On `net`: a skew was seen. The first one stamps `since` and publishes the row at once, over whatever this
    /// client last published: a snapshot that never decodes would otherwise leave the app connected and silent.
    private func noteSkew(because why: String) {
        log("app.version: \(why); Go is refused until it clears")
        if skewSince == nil { skewSince = Date().timeIntervalSince1970 * 1000 }
        publishSkewProblem()
    }

    /// The `app.version` row (mirror of the probe fixture's sample).
    private func skewProblem() -> Problem {
        Problem(kind: "app.version", text: EngineClient.skewProblemText,
                remedy: ProblemRemedy(label: "Restart daemon", command: ["type": .string("daemon.restart")], open: nil, copy: "pnpm build:mac"),
                since: skewSince ?? Date().timeIntervalSince1970 * 1000)
    }

    /// `snap` with the `app.version` row on top while the builds differ; as it is otherwise.
    private func withSkewProblem(_ snap: Snapshot) -> Snapshot {
        guard skewed else { return snap }
        var s = snap
        s.problems = s.problems.filter { $0.kind != "app.version" } + [skewProblem()]
        return s
    }

    /// On `net`: the row over what this client last published. Before any snapshot decoded, that is `Snapshot.empty`,
    /// which says Setup never ran: so the row's snapshot carries what `settings.json` says instead, and a skew alone
    /// never opens Setup on a Mac that finished it (AppDelegate opens it for the first connected snapshot that says not).
    private func publishSkewProblem() {
        let problem = skewProblem()
        let onboarded = daemonStateDir.flatMap { $0.isEmpty ? nil : EngineClient.onboardedOnDisk(stateDir: $0) }
        onMain { st in
            var s = st.snapshot == .empty ? Snapshot.empty : st.snapshot.finalisingTranscript()
            if st.snapshot == .empty, let onboarded { s.settings.onboarded = onboarded }
            s.problems = s.problems.filter { $0.kind != "app.version" } + [problem]
            st.snapshot = s
        }
    }

    /// Whether `<stateDir>/settings.json` says Setup has run (AppDelegate.onboardedOnDisk's read, here because this
    /// file builds without the app delegate in the probes).
    static func onboardedOnDisk(stateDir: String) -> Bool {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: stateDir).appendingPathComponent("settings.json")),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
        return obj["onboarded"] as? Bool ?? false
    }

    /// On `net`: the snapshot for the auto-resume, then the ≤ 30 Hz publish. One older than the last applied is dropped.
    /// A decoded snapshot ends a skew that only an undecodable one raised; a hello's skew rides on top of it.
    private func applySnapshot(_ snap: Snapshot, seq: Int) {
        guard seq > snapshotAppliedSeq else { return }
        snapshotAppliedSeq = seq
        if undecodableSkew {
            undecodableSkew = false
            if !helloSkew {
                skewSince = nil
                log("app.version: the daemon's snapshots decode again")
            }
        }
        // Judged: the outbox goes (its Go only when the hello matched), before the auto-resume's own Go.
        releaseOutbox(judged: true)
        noteSnapshotForResume(snap)
        queueSnapshot(sanitized(snap))
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
            // The `app.version` row as the skew stands at the publish, not at the decode: a skew raised in between
            // must not be overwritten by a snapshot queued before it (APP-3).
            guard let pending = self.pendingSnapshot else { return }
            self.pendingSnapshot = nil
            let s = self.withSkewProblem(pending)
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
