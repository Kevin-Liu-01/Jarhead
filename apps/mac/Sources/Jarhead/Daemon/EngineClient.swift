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

    /// Speaker frames and flush requests land here. Set before `start()`.
    var audio: AudioEngine?
    /// Fired (on the main queue) after each successful hello; re-send anything the daemon must know.
    var onConnected: (() -> Void)?

    // Snapshot coalescing: at most ~30 publishes per second.
    private var pendingSnapshot: Snapshot?
    private var snapshotPublishScheduled = false
    private var lastSnapshotPublish = DispatchTime.now()
    private static let minSnapshotInterval: Double = 1.0 / 30.0

    // Ledger requests: id → resolver. Resolved with nil on timeout/disconnect.
    private var pendingLedger: [String: (Any?) -> Void] = [:]
    private static let ledgerTimeout: TimeInterval = 5

    private let appVersion: String = {
        (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "2.0.0"
    }()

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
                self.sendHello()
                self.publishConnected(true)
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
        if isConnected {
            isConnected = false
            publishConnected(false)
            failPendingLedger()
        }
        scheduleReconnect()
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
        net.async { self.rawSend(json: ["type": "command", "command": command.json]) }
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

    func sendPermission(which: String, state grant: Grant) {
        net.async { self.rawSend(json: ["type": "permission", "which": which, "state": grant.rawValue]) }
    }

    /// Must run on `net`.
    private func rawSend(json: [String: Any]) {
        guard let conn = connection, isConnected else { return }
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
        guard let rows = any as? [Any] else { return [] }
        return EngineClient.decodeRows(rows)
    }

    private func request(_ message: [String: Any]) async -> Any? {
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
                self.net.asyncAfter(deadline: .now() + EngineClient.ledgerTimeout) { [weak self] in
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
            onMain { st in
                if let dir, !dir.isEmpty { st.stateDir = URL(fileURLWithPath: dir) }
            }
        case "snapshot":
            guard let sub = obj["snapshot"], let snap: Snapshot = decode(sub) else {
                log("undecodable snapshot")
                return
            }
            queueSnapshot(snap)
        case "levels":
            guard let sub = obj["levels"], let levels: AudioLevels = decode(sub) else { return }
            onMain { $0.levels = levels }
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
        case "ledger.rows":
            if let id = obj["id"] as? String, let resolve = pendingLedger.removeValue(forKey: id) { resolve(obj["rows"]) }
        case "ledger.days":
            if let id = obj["id"] as? String, let resolve = pendingLedger.removeValue(forKey: id) { resolve(obj["days"]) }
        case "error":
            let message = obj["message"] as? String ?? "daemon error"
            log("daemon error: \(message)")
            onMain { $0.toast(message, tone: .error) }
        default:
            break
        }
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
            self.onMain { $0.snapshot = s }
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
