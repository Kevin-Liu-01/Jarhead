import Darwin
import Foundation

// The app's receive path under big snapshots, without the app (voice PLAN W2.2, cause #6). The real
// Daemon/EngineClient.swift, Daemon/Wire.swift and Model/*.swift, compiled with this file only by
// Scripts/snapshot-probe.sh, connect to a fake daemon on a scratch unix socket in this process: no
// window, no TCC, no microphone, no sound, no real daemon, nothing under ~/.jarhead. The speaker is
// the stub `AudioEngine` below, which only records when each frame reached it.
//
//   order     speaker frames, `audio` flushes and big snapshots interleaved: play/flush arrive in the
//             exact order sent (a flush is never reordered against the PCM)
//   behind    one speaker frame right behind a 283 KB snapshot, and behind a 283 KB speaker frame (the
//             socket's own cost), 20 times each: what the snapshot adds is its decode, when that runs on `net`
//   paced     40 ms speaker frames in real time, 283 KB snapshots at 3.8/s, SNAPSHOT_PROBE_SECONDS
//             (default 20): each frame's lateness against its ideal time
//   decoded   a snapshot carrying the playback telemetry (audioState.playout/duck/output, liveAudio)
//             reaches AppState through the new path; a malformed snapshot is dropped and the next applies
//
// Gates: order exact; behind adds ≤ 2 ms at p50; paced p99 ≤ 35 ms; decoded fields equal. SNAPSHOT_PROBE_NO_GATES=1
// prints the figures without judging them (to run the same probe against another EngineClient.swift).

// MARK: - stubs for what EngineClient reaches outside Model/ and Daemon/

/// The speaker, as EngineClient sees it: `play(pcm:)` and `flush()`, called on `net`. Records arrival times only.
final class AudioEngine: @unchecked Sendable {
    struct Event {
        let seq: Int
        let at: UInt64
    }
    private let lock = NSLock()
    private var log: [Event] = []

    func play(pcm: Data) {
        let seq = pcm.count >= 4 ? Int(pcm.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }) : -1
        let now = DispatchTime.now().uptimeNanoseconds
        lock.lock(); log.append(Event(seq: seq, at: now)); lock.unlock()
    }

    func flush() {
        let now = DispatchTime.now().uptimeNanoseconds
        lock.lock(); log.append(Event(seq: -100, at: now)); lock.unlock()
    }

    func take() -> [Event] {
        lock.lock(); defer { lock.unlock() }
        let out = log
        log.removeAll()
        return out
    }

    var count: Int {
        lock.lock(); defer { lock.unlock() }
        return log.count
    }
}

enum CrashGuard {
    static func remember(_ line: String) {}
}

extension Notification.Name {
    static let jarheadEarHints = Notification.Name("jarhead.earHints")
}

// MARK: - the fake daemon

final class FakeDaemon: @unchecked Sendable {
    let path: String
    private var listenFD: Int32 = -1
    private var fd: Int32 = -1
    private let writeLock = NSLock()
    private let ready = DispatchSemaphore(value: 0)

    init(path: String) {
        self.path = path
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

    /// One client at a time; a new one replaces the old. Pings are answered, hello is said.
    private func acceptLoop() {
        while true {
            let c = accept(listenFD, nil, nil)
            guard c >= 0 else { return }
            writeLock.lock()
            if fd >= 0 { close(fd) }
            fd = c
            writeLock.unlock()
            send(json: #"{"type":"hello","version":"probe","pid":\#(getpid()),"stateDir":"/tmp/jh-snapshot-probe"}"#)
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
                guard let o = try? JSONSerialization.jsonObject(with: f.payload) as? [String: Any], o["type"] as? String == "ping", let id = o["id"] as? String else { continue }
                send(json: #"{"type":"pong","id":"\#(id)","at":0}"#)
            }
        }
    }

    func waitForClient() { ready.wait() }

    /// Blocking writes of whole frames, never interleaved with a pong.
    func send(_ bytes: Data) {
        writeLock.lock()
        defer { writeLock.unlock() }
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

    func send(json: String) { send(SnapshotProbe.frame(.json, Data(json.utf8))) }

    func dropClient() {
        writeLock.lock()
        if fd >= 0 { close(fd); fd = -1 }
        writeLock.unlock()
    }
}

// MARK: - the probe

enum SnapshotProbe {
    static func frame(_ type: FrameType, _ payload: Data) -> Data {
        var out = Data(capacity: payload.count + 5)
        out.append(type.rawValue)
        let n = UInt32(payload.count)
        out.append(contentsOf: [UInt8(n >> 24 & 0xff), UInt8(n >> 16 & 0xff), UInt8(n >> 8 & 0xff), UInt8(n & 0xff)])
        out.append(payload)
        return out
    }

    /// 40 ms of PCM16 whose first four bytes are `seq`.
    static func speaker(_ seq: Int) -> Data {
        var pcm = Data(count: 1920)
        pcm.withUnsafeMutableBytes { $0.storeBytes(of: UInt32(seq), as: UInt32.self) }
        return frame(.speaker, pcm)
    }

    static let flush = frame(.json, Data(#"{"type":"audio","control":"flush"}"#.utf8))

    /// A snapshot frame as server.ts writes it (`type` first), about `bytes` long: the fixture's first snapshot
    /// with its transcript grown, `phase` and `extra` keys spliced in.
    static func snapshot(_ base: [String: Any], bytes: Int, phase: String = "speaking", extra: [String: Any] = [:]) -> Data {
        var snap = base
        snap["phase"] = phase
        for (k, v) in extra { snap[k] = v }
        let item = (base["transcript"] as? [[String: Any]])?.first ?? ["id": "u_1", "speaker": "kevin", "text": "hello", "startMs": 0, "endMs": 1, "at": 0, "final": true]
        var items: [[String: Any]] = []
        var size = (try? JSONSerialization.data(withJSONObject: snap).count) ?? 0
        var i = 0
        while size < bytes {
            var it = item
            it["id"] = "u_probe_\(i)"
            it["text"] = "the probe's line \(i), long enough to weigh what a real utterance weighs on the wire"
            items.append(it)
            size += ((try? JSONSerialization.data(withJSONObject: it).count) ?? 170) + 1
            i += 1
        }
        if !items.isEmpty { snap["transcript"] = items }
        let body = try! JSONSerialization.data(withJSONObject: snap)
        var payload = Data(#"{"type":"snapshot","snapshot":"#.utf8)
        payload.append(body)
        payload.append(Data("}".utf8))
        return frame(.json, payload)
    }
}

func percentile(_ v: [Double], _ p: Double) -> Double {
    guard !v.isEmpty else { return 0 }
    let s = v.sorted()
    return s[min(s.count - 1, max(0, Int((p * Double(s.count)).rounded(.up)) - 1))]
}

func ms(_ ns: UInt64) -> Double { Double(ns) / 1e6 }

func spin(_ seconds: Double) {
    let end = Date().addingTimeInterval(seconds)
    while Date() < end { _ = RunLoop.main.run(mode: .default, before: min(end, Date().addingTimeInterval(0.01))) }
}

@main
struct SnapshotProbeMain {
    static func main() {
        setlinebuf(stdout)
        let env = ProcessInfo.processInfo.environment
        let gates = env["SNAPSHOT_PROBE_NO_GATES"] != "1"
        let pacedSeconds = Double(env["SNAPSHOT_PROBE_SECONDS"] ?? "") ?? 20
        let fixture = CommandLine.arguments.dropFirst().first ?? "Scripts/fixtures/snapshot-threads.json"
        guard let data = FileManager.default.contents(atPath: fixture),
              let frames = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]],
              let base = frames.first(where: { $0["type"] as? String == "snapshot" })?["snapshot"] as? [String: Any] else {
            print("usage: snapshot-probe <fixture with a snapshot frame>")
            exit(2)
        }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("jh-snapshot-probe-\(getpid())")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let sock = dir.appendingPathComponent("d.sock").path
        var failures = 0
        func check(_ ok: Bool, _ line: String) {
            let judged = gates ? (ok ? "ok  " : "FAIL") : "    "
            print("\(judged) \(line)")
            if gates, !ok { failures += 1 }
        }

        MainActor.assumeIsolated {
            let daemon = FakeDaemon(path: sock)
            let state = AppState()
            let speaker = AudioEngine()
            let client = EngineClient(socketPath: sock, state: state)
            client.audio = speaker
            client.start()
            daemon.waitForClient()
            spin(0.3)
            let big = SnapshotProbe.snapshot(base, bytes: 283_000)
            print("snapshot frame: \(big.count / 1000) KB")

            // order: interleaved, written in one go per group.
            _ = speaker.take()
            var sent: [Int] = []
            var stream = Data()
            var seq = 0
            for group in 0 ..< 6 {
                for _ in 0 ..< 5 {
                    stream.append(SnapshotProbe.speaker(seq)); sent.append(seq); seq += 1
                }
                if group % 2 == 0 { stream.append(big) }
                stream.append(SnapshotProbe.flush); sent.append(-100)
            }
            daemon.send(stream)
            let deadline = Date().addingTimeInterval(5)
            while speaker.count < sent.count, Date() < deadline { spin(0.02) }
            let got = speaker.take().map(\.seq)
            check(got == sent, "order: \(sent.count) speaker frames and flushes around three 283 KB snapshots arrive exactly as sent")

            // behind: one speaker frame right behind a 283 KB frame, alternately a snapshot and a speaker frame of the
            // same size (the socket's own cost, no JSON at all). What the snapshot adds over the plain frame is its decode on `net`.
            func behind(_ lead: Data, _ tag: Int) -> Double? {
                spin(0.1)
                _ = speaker.take()
                var burst = lead
                burst.append(SnapshotProbe.speaker(tag))
                let t0 = DispatchTime.now().uptimeNanoseconds
                daemon.send(burst)
                let until = Date().addingTimeInterval(2)
                while Date() < until {
                    if let hit = speaker.take().first(where: { $0.seq == tag }) { return ms(hit.at &- t0) }
                    usleep(200)
                }
                return nil
            }
            var pcm = Data(count: big.count - 5)
            pcm.withUnsafeMutableBytes { $0.storeBytes(of: UInt32(99_999), as: UInt32.self) }
            let plain = SnapshotProbe.frame(.speaker, pcm)
            var afterSnapshot: [Double] = []
            var afterPlain: [Double] = []
            for i in 0 ..< 20 {
                if let t = behind(big, 10_000 + 2 * i) { afterSnapshot.append(t) }
                if let t = behind(plain, 10_001 + 2 * i) { afterPlain.append(t) }
            }
            let added = percentile(afterSnapshot, 0.5) - percentile(afterPlain, 0.5)
            check(afterSnapshot.count == 20 && added <= 2,
                  String(format: "behind: a speaker frame behind a 283 KB snapshot waits p50 %.1f ms (max %.1f), behind a 283 KB speaker frame p50 %.1f ms: the snapshot adds %.1f ms", percentile(afterSnapshot, 0.5), afterSnapshot.max() ?? 0, percentile(afterPlain, 0.5), added))

            // paced: real time, snapshots at 3.8/s.
            spin(0.3)
            _ = speaker.take()
            let frameNs: UInt64 = 40_000_000
            let snapEveryNs: UInt64 = UInt64(1e9 / 3.8)
            let total = Int(pacedSeconds * 25)
            let t0 = DispatchTime.now().uptimeNanoseconds + 50_000_000
            var ideal: [Int: UInt64] = [:]
            let sender = Thread {
                var nextSnap = t0
                for k in 0 ..< total {
                    let due = t0 + UInt64(k) * frameNs
                    while DispatchTime.now().uptimeNanoseconds < due { usleep(200) }
                    daemon.send(SnapshotProbe.speaker(20_000 + k))
                    if DispatchTime.now().uptimeNanoseconds >= nextSnap {
                        daemon.send(big)
                        nextSnap += snapEveryNs
                    }
                }
            }
            for k in 0 ..< total { ideal[20_000 + k] = t0 + UInt64(k) * frameNs }
            sender.start()
            spin(pacedSeconds + 1.5)
            let paced = speaker.take().compactMap { e -> Double? in ideal[e.seq].map { ms(e.at &- $0) } }
            let p99 = percentile(paced, 0.99)
            check(paced.count == total && p99 <= 35, String(format: "paced: %d frames at 40 ms with 283 KB snapshots at 3.8/s: lateness p50 %.1f ms, p99 %.1f ms, max %.1f ms (n %d)", total, percentile(paced, 0.5), p99, paced.max() ?? 0, paced.count))

            // decoded: the telemetry reaches AppState; a malformed snapshot is dropped and the next one applies.
            spin(0.5)
            let audio: [String: Any] = [
                "running": true, "voiceProcessing": true, "rung": 2, "wiring": "input-rate", "tapFormat": "48000 Hz ×1 Float32", "recording": false,
                "fallback": false, "guardOn": false, "guardTailMs": 0, "gated": 0, "chunks": 0, "breakthroughs": 0, "inputMuted": false, "aggregatePresent": true,
                "playout": ["chunks": 412, "underruns": 0, "underrunMs": 0, "longestUnderrunMs": 0, "wouldBeUnderruns": 4, "resets": 3, "targetMs": 120, "queuedMs": 121, "queuedMinMs": 96, "lateMaxMs": 7, "droppedChunks": 0, "droppedMs": 0],
                "duck": ["ducks": 2, "gate": 2, "confirmed": 2, "unconfirmed": 0, "held": 0, "refusedWords": 0, "wordOnsetsSkipped": 1, "duckedMs": 900, "deepMs": 400, "residualP50Dbfs": -61, "residualP99Dbfs": -49.5,
                         "last": ["source": "gate", "confirmed": true, "depthDb": -20, "runDbfs": -31.5, "thresholdDbfs": -42, "releasedAfterMs": 640, "reason": "quiet after ear words"]],
                "output": ["rmsDbfs": -21.8, "peakDbfs": -4.1, "heardRmsDbfs": -22, "audibleMs": 61000, "mixFormat": "48000 Hz ×2", "volume": 0.62],
            ]
            let live: [String: Any] = ["deltas": 900, "deltaMsP50": 40, "deltaMsMax": 120, "arrivalP99Ms": 31, "arrivalMaxMs": 182, "aheadMs": 0, "gatedFrames": 0, "loopDelayMaxMs": 12, "formatRate": 24000]
            var bad = Data(#"{"type":"snapshot","snapshot":{"phase":7}}"#.utf8)
            bad = SnapshotProbe.frame(.json, bad)
            daemon.send(bad)
            daemon.send(SnapshotProbe.snapshot(base, bytes: 0, phase: "listening", extra: ["audioState": audio, "liveAudio": live]))
            spin(0.5)
            let s = state.snapshot
            let a = s.audioState
            check(s.phase == .listening && a?.playout?.wouldBeUnderruns == 4 && a?.playout?.queuedMinMs == 96 && a?.duck?.last?.reason == "quiet after ear words"
                  && a?.duck?.residualP99Dbfs == -49.5 && a?.output?.volume == 0.62 && a?.output?.mixFormat == "48000 Hz ×2" && s.liveAudio?.formatRate == 24000 && s.liveAudio?.deltas == 900,
                  "decoded: audioState.playout/duck/output and liveAudio reach AppState; the malformed snapshot before it was dropped")
            // The frame the app sends back carries the same objects, by the protocol's names.
            if let a {
                let json = a.json
                let playout = json["playout"] as? [String: Any]
                let duck = json["duck"] as? [String: Any]
                check(playout?["wouldBeUnderruns"] as? Int == 4 && (duck?["last"] as? [String: Any])?["source"] as? String == "gate" && (json["output"] as? [String: Any])?["volume"] as? Double == 0.62,
                      "encoded: AudioStateInfo.json carries playout, duck (with last) and output under the protocol's names")
            }
            client.stop()
            daemon.dropClient()
            spin(0.2)
        }
        print(failures == 0 ? (gates ? "snapshot-probe: all gates ok" : "snapshot-probe: figures only") : "snapshot-probe: \(failures) FAIL")
        exit(failures == 0 ? 0 : 1)
    }
}
