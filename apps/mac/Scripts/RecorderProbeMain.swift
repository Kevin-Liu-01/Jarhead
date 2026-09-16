import AVFoundation
import CoreAudio
import Foundation

// Throwaway harness (design12 § Verification V3): recorders and self-echo — two processes on
// one microphone. Not part of the package; compiled only by Scripts/recorder-probe.sh.
//
//   R  this binary again with `--recorder <seconds>`: a plain `AVAudioEngine` tap on the default
//      input (what QuickTime is), one `recorder t=<s> <dBFS>` line per second on stdout.
//   X  `afplay` of a speech clip (RECORDER_PROBE_FILE, else `say -o` of a long paragraph) from
//      t = 5 to ≈ 25 s — the room's far end, independent of the graph.
//   G  Jarhead's `AudioEngine` in RECORDER_PROBE_MODE (recording | aec) from t = 10 to 20 s; at
//      t = 12 the same clip's first 5 s go through ITS player node (`play(pcm:)`, the path the
//      daemon's speaker frames take), so the guard arms and holds as it would for Jarhead's voice.
//
// Read: R's level in [10, 20) vs [5, 10) — a fall to the floor is forum 751100's cut (a second
// client beside a voice-processing unit), partial is attenuation, none is "unaffected";
// `check: recorder level unchanged within 1 dB (recording)`. The graph's own tap while the
// guard holds gives `couplingDb` (how far the raw microphone rose over the quiet floor) and
// `residualDbfs` (the wire, zero-filled → the floor); the number that matters is the tail leak:
// the wire's RMS in the 300 ms after each hold ends, `check: tailLeakDbfs ≤ −50 (recording)`.
// The record is merged into ~/.jarhead/audio-probe.json under the mode (the doctor's `leak` row).
//
// PLAYS SOUND: needs AUDIO_PROBE_PLAY=1; without it the plan is printed and the exit is 0. Both
// processes borrow the launching terminal's microphone grant (a bare tool; the terminal prompts
// when undecided). Nothing connects to the daemon; nothing opens a session; nothing is paid.
//   RECORDER_PROBE_MODE=recording|aec (default recording) · RECORDER_PROBE_FILE=/path.aiff
//   AUDIO_PROBE_STATE_DIR (default ~/.jarhead) · --json (the record as the last line)

@main
struct RecorderProbeMain {
    static func main() {
        setlinebuf(stdout)
        let args = CommandLine.arguments
        if let i = args.firstIndex(of: "--recorder") {
            let seconds = i + 1 < args.count ? Double(args[i + 1]) ?? 30 : 30
            RecorderRole(seconds: seconds).run()
        } else {
            MainActor.assumeIsolated { RecorderProbe.shared.begin(json: args.contains("--json")) }
        }
        RunLoop.main.run()
    }
}

enum RecorderWords {
    static let clipText = "Let me check that for you. Opening the settings now. The demo document is open on the second display; say go when you want the walkthrough, or stop if you would rather read it yourself first. I will wait here."
    static let tailWindow = 0.3
    static let leakLimitDbfs = -50.0
    static let recorderToleranceDb = 1.0
    static let plan = "would: start a plain recorder on the default mic (30 s) · afplay a speech clip 5→25 s · Jarhead's graph up 10→20 s · the clip through its player 12→17 s · compare the recorder's level and read the guard's tail leak"
}

/// dBFS from an RMS, −120 floor, one decimal.
func dbfs(_ rms: Double) -> Double {
    guard rms.isFinite, rms > 0 else { return -120 }
    return max(-120, (20 * log10(rms) * 10).rounded() / 10)
}

// MARK: - R · the plain recorder (a second HAL client, like QuickTime)

final class RecorderRole: @unchecked Sendable {
    private let engine = AVAudioEngine()
    private let seconds: Double
    private let lock = NSLock()
    private var energy = 0.0
    private var frames = 0
    private let t0 = Date()

    init(seconds: Double) { self.seconds = seconds }

    func run() {
        let input = engine.inputNode
        do {
            try objcTry(throwing: {
                input.installTap(onBus: 0, bufferSize: 2048, format: nil) { [weak self] buffer, _ in self?.note(buffer) }
                self.engine.prepare()
                try self.engine.start()
            })
        } catch {
            print("recorder: could not start: \(error.localizedDescription)")
            exit(2)
        }
        print("recorder: plain tap on the default input, \(input.outputFormat(forBus: 0).brief), \(Int(seconds)) s")
        var tick = 0
        let timer = Timer(timeInterval: 1.0, repeats: true) { [weak self] t in
            guard let self else { return }
            tick += 1
            self.lock.lock()
            let rms = self.frames > 0 ? (self.energy / Double(self.frames)).squareRoot() : 0
            self.energy = 0
            self.frames = 0
            self.lock.unlock()
            print("recorder t=\(tick) \(dbfs(rms))")
            if Double(tick) >= self.seconds {
                t.invalidate()
                try? objcTry { input.removeTap(onBus: 0); self.engine.stop() }
                exit(0)
            }
        }
        RunLoop.main.add(timer, forMode: .default)
    }

    private func note(_ buffer: AVAudioPCMBuffer) {
        guard let ch = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return }
        var acc = 0.0
        for i in 0 ..< Int(buffer.frameLength) { acc += Double(ch[i] * ch[i]) }
        lock.lock()
        energy += acc.isFinite ? acc : 0
        frames += Int(buffer.frameLength)
        lock.unlock()
    }
}

// MARK: - the graph's tally: wire chunks and raw buffers stamped, guard edges stamped

final class GraphTally: @unchecked Sendable {
    let lock = NSLock()
    var wire: [(t: Double, rms: Double)] = []
    var raw: [(t: Double, rms: Double)] = []
    /// (time, held) from the frames' `guardHeld` edges.
    var edges: [(t: Double, held: Bool)] = []

    func noteWire(_ chunk: Data) {
        let rms = AudioEngine.rms(chunk)
        lock.lock(); wire.append((CFAbsoluteTimeGetCurrent(), rms)); lock.unlock()
    }

    func noteRaw(_ buffer: AVAudioPCMBuffer) {
        guard let ch = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return }
        var acc = 0.0
        for i in 0 ..< Int(buffer.frameLength) { acc += Double(ch[i] * ch[i]) }
        let rms = (acc / Double(buffer.frameLength)).squareRoot()
        lock.lock(); raw.append((CFAbsoluteTimeGetCurrent(), rms.isFinite ? rms : 0)); lock.unlock()
    }

    func noteHeld(_ held: Bool) {
        lock.lock(); edges.append((CFAbsoluteTimeGetCurrent(), held)); lock.unlock()
    }

    /// Mean RMS (as dBFS) of `series` samples within [from, to).
    static func level(_ series: [(t: Double, rms: Double)], from: Double, to: Double) -> Double? {
        let picked = series.filter { $0.t >= from && $0.t < to }
        guard !picked.isEmpty else { return nil }
        let mean = (picked.reduce(0) { $0 + $1.rms * $1.rms } / Double(picked.count)).squareRoot()
        return dbfs(mean)
    }

    /// The held windows as (start, end) pairs; an unterminated hold ends at `now`.
    func holds(now: Double) -> [(Double, Double)] {
        lock.lock(); defer { lock.unlock() }
        var out: [(Double, Double)] = []
        var start: Double?
        for e in edges {
            if e.held, start == nil { start = e.t }
            if !e.held, let s = start { out.append((s, e.t)); start = nil }
        }
        if let s = start { out.append((s, now)) }
        return out
    }
}

// MARK: - the orchestrator

@MainActor
final class RecorderProbe {
    static let shared = RecorderProbe()

    private let env = ProcessInfo.processInfo.environment
    private let t0 = Date()
    private var json = false
    private var mode = "recording"
    private var recorder: Process?
    private var player: Process?
    private var recorderLevels: [(t: Int, dbfs: Double)] = []
    private var engine: AudioEngine?
    private let tally = GraphTally()
    private var graphUpAt = 0.0
    private var graphDownAt = 0.0
    private var lastHeld = false
    private var runningFrame: AudioStateReadback?
    private var clipURL: URL?

    private func stamp() -> String { String(format: "+%6.3f", Date().timeIntervalSince(t0)) }
    private func say(_ s: String) { print("\(stamp())  \(s)") }
    private func at(_ seconds: Double, _ body: @escaping @MainActor () -> Void) {
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { MainActor.assumeIsolated(body) }
    }

    func begin(json: Bool) {
        self.json = json
        mode = env["RECORDER_PROBE_MODE"] == "aec" ? "aec" : "recording"
        say("recorder-probe: mode \(mode) · default input \(AudioDeviceFacts.defaultInput()?.text ?? "none") · default output \(AudioDeviceFacts.defaultOutput()?.text ?? "none")")
        guard env["AUDIO_PROBE_PLAY"] == "1" else {
            say("dry run: \(RecorderWords.plan) — set AUDIO_PROBE_PLAY=1 to run it")
            if json { print("{\"dryRun\":true,\"mode\":\"\(mode)\"}") }
            exit(0)
        }
        guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
            say("refused: this process has no microphone grant (\(AVCaptureDevice.authorizationStatus(for: .audio).rawValue)) — run from a terminal that holds it")
            exit(3)
        }
        guard let clip = prepareClip() else { exit(2) }
        clipURL = clip
        startRecorder(seconds: 30)
        at(5) { [weak self] in self?.startAfplay(clip) }
        at(10) { [weak self] in self?.startGraph() }
        at(12) { [weak self] in self?.feedClip(clip, seconds: 5) }
        at(20) { [weak self] in self?.stopGraph() }
        at(26) { [weak self] in self?.report() }
    }

    /// RECORDER_PROBE_FILE, else `say -o` of the paragraph into .build (≈ 15 s at the default voice).
    private func prepareClip() -> URL? {
        if let path = env["RECORDER_PROBE_FILE"], FileManager.default.fileExists(atPath: path) { return URL(fileURLWithPath: path) }
        let dir = URL(fileURLWithPath: ".build/recorder-probe", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("clip.aiff")
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/say")
        p.arguments = ["-o", url.path, RecorderWords.clipText]
        do {
            try p.run()
            p.waitUntilExit()
        } catch {
            say("say failed: \(error.localizedDescription)")
            return nil
        }
        guard p.terminationStatus == 0 else { say("say exited \(p.terminationStatus)"); return nil }
        say("clip: \(url.path)")
        return url
    }

    // MARK: R and X

    private func startRecorder(seconds: Int) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
        p.arguments = ["--recorder", "\(seconds)"]
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = FileHandle.standardError
        pipe.fileHandleForReading.readabilityHandler = { [weak self] h in
            let text = String(decoding: h.availableData, as: UTF8.self)
            for line in text.split(separator: "\n") {
                DispatchQueue.main.async { MainActor.assumeIsolated { self?.noteRecorder(String(line)) } }
            }
        }
        do {
            try p.run()
            recorder = p
            say("R: recorder started (pid \(p.processIdentifier))")
        } catch {
            say("R: could not start: \(error.localizedDescription)")
            exit(2)
        }
    }

    private func noteRecorder(_ line: String) {
        say("  \(line)")
        let words = line.split(separator: " ")
        guard words.count == 3, words[0] == "recorder", words[1].hasPrefix("t="), let t = Int(words[1].dropFirst(2)), let db = Double(words[2]) else { return }
        recorderLevels.append((t, db))
    }

    private func startAfplay(_ clip: URL) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/afplay")
        p.arguments = [clip.path]
        do {
            try p.run()
            player = p
            say("X: afplay \(clip.lastPathComponent) (pid \(p.processIdentifier))")
        } catch {
            say("X: afplay failed: \(error.localizedDescription)")
        }
    }

    // MARK: G · the graph

    private func startGraph() {
        let engine = AudioEngine()
        self.engine = engine
        let tally = self.tally
        engine.onStatus = { [weak self] line in DispatchQueue.main.async { MainActor.assumeIsolated { self?.say("engine: \(line)") } } }
        engine.onAudioState = { [weak self] frame in DispatchQueue.main.async { MainActor.assumeIsolated { self?.noteFrame(frame) } } }
        engine.onMicChunk = { chunk in tally.noteWire(chunk) }
        engine.onMicBuffer = { buffer, _ in tally.noteRaw(buffer) }
        engine.setPolicy(.from(recording: mode == "recording"))
        graphUpAt = CFAbsoluteTimeGetCurrent()
        engine.start()
        say("G: graph start (\(mode))")
    }

    private func noteFrame(_ frame: AudioStateReadback) {
        if frame.running, runningFrame == nil { runningFrame = frame }
        if frame.guardHeld != lastHeld {
            lastHeld = frame.guardHeld
            tally.noteHeld(frame.guardHeld)
            say("G: guard \(frame.guardHeld ? "held" : "open")")
        }
    }

    /// The clip's first `seconds` as PCM16 mono 24 kHz through the graph's player — the daemon's path.
    private func feedClip(_ clip: URL, seconds: Double) {
        guard let engine else { return }
        guard let chunks = ClipReader.wireChunks(of: clip, seconds: seconds) else {
            say("G: could not read the clip for the player")
            return
        }
        say("G: \(chunks.count) wire chunks (\(Double(chunks.count) / 10) s) of the clip through the player node")
        for chunk in chunks { engine.play(pcm: chunk) }
    }

    private func stopGraph() {
        graphDownAt = CFAbsoluteTimeGetCurrent()
        engine?.stop()
        say("G: graph stop")
    }

    // MARK: the report

    private func report() {
        player?.terminate()
        recorder?.terminate()
        let now = CFAbsoluteTimeGetCurrent()
        var record: [String: Any] = ["at": Int(Date().timeIntervalSince1970 * 1000), "mode": mode]
        var ok = 0, failed = 0
        func check(_ name: String, _ holds: Bool, _ why: String) {
            if holds { ok += 1; say("check: \(name) ok") } else { failed += 1; say("check: \(name) FAIL \(why)") }
        }
        // R: [5, 10) with the clip alone vs [10, 20) with the graph up.
        let before = recorderLevels.filter { $0.t >= 6 && $0.t <= 10 }.map(\.dbfs)
        let during = recorderLevels.filter { $0.t >= 11 && $0.t <= 20 }.map(\.dbfs)
        if !before.isEmpty, !during.isEmpty {
            let b = before.reduce(0, +) / Double(before.count), d = during.reduce(0, +) / Double(during.count)
            let delta = ((d - b) * 10).rounded() / 10
            record["recorderDeltaDb"] = delta
            say("R: clip alone \(b) dBFS · with the graph (\(mode)) \(d) dBFS · Δ \(delta) dB")
            if mode == "recording" {
                check("recorder level unchanged within 1 dB (recording)", abs(delta) <= RecorderWords.recorderToleranceDb, "Δ \(delta) dB")
            } else {
                say("info: under aec a second client beside the unit reads Δ \(delta) dB (751100: a fall to the floor is the cut)")
            }
        } else {
            check("recorder produced levels", false, "before \(before.count), during \(during.count) samples")
        }
        guardFigures(&record, now: now, check: check)
        say("checks: \(ok) ok, \(failed) FAIL")
        record["checks"] = ["ok": ok, "fail": failed]
        ProbeStateFile.merge(record, mode: mode, stateDir: env["AUDIO_PROBE_STATE_DIR"], say: { [weak self] in self?.say($0) })
        if json, let data = try? JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]) { print(String(decoding: data, as: UTF8.self)) }
        at(0.3) { exit(failed == 0 ? 0 : 1) }
    }

    /// coupling · residual · floor · the tail leak after every hold, from the graph's own tap.
    private func guardFigures(_ record: inout [String: Any], now: Double, check: (String, Bool, String) -> Void) {
        tally.lock.lock()
        let wire = tally.wire, raw = tally.raw
        tally.lock.unlock()
        let holds = tally.holds(now: now)
        let quietFrom = graphUpAt + 0.5, quietTo = graphUpAt + 1.9
        let floorWire = GraphTally.level(wire, from: quietFrom, to: quietTo)
        let floorRaw = GraphTally.level(raw, from: quietFrom, to: quietTo)
        if let floorWire { record["floorDbfs"] = floorWire }
        if let f = runningFrame { record["tailMs"] = f.guardTailMs; record["rung"] = f.rung }
        guard mode == "recording" else {
            if let floorRaw, let d = GraphTally.level(raw, from: graphUpAt + 2, to: graphUpAt + 7) { say("G: raw mic under aec: floor \(floorRaw) · with the clip \(d) dBFS (the unit's cancellation is what the wire hears)") }
            return
        }
        guard !holds.isEmpty else {
            check("guard held while the clip played (recording)", false, "no hold edge — did the player play?")
            return
        }
        var residuals: [Double] = [], couplings: [Double] = [], leaks: [Double] = []
        for (s, e) in holds {
            if let r = GraphTally.level(wire, from: s, to: e) { residuals.append(r) }
            if let floorRaw, let c = GraphTally.level(raw, from: s, to: e) { couplings.append(c - floorRaw) }
            if let l = GraphTally.level(wire, from: e, to: e + RecorderWords.tailWindow) { leaks.append(l) }
        }
        say("G: \(holds.count) hold\(holds.count == 1 ? "" : "s"), \(holds.map { String(format: "%.1f s", $1 - $0) }.joined(separator: ", "))")
        if let r = residuals.max() { record["residualDbfs"] = r; say("G: residual on the wire while held \(r) dBFS (zero-filled → the floor)") }
        if let c = couplings.max() { record["couplingDb"] = (c * 10).rounded() / 10; say("G: coupling: the raw mic rose \((c * 10).rounded() / 10) dB over its floor while Jarhead was audible") }
        if let l = leaks.max() {
            record["tailLeakDbfs"] = l
            check("tailLeakDbfs ≤ −50 (recording)", l <= RecorderWords.leakLimitDbfs, "the wire read \(l) dBFS in the 300 ms after a hold ended")
        } else {
            check("tail leak measured", false, "no wire chunks in the 300 ms after a hold")
        }
    }
}

// MARK: - the clip as wire chunks

enum ClipReader {
    /// The first `seconds` of `url` as PCM16 mono 24 kHz in 100 ms chunks (`AudioEngine.chunkBytes`).
    static func wireChunks(of url: URL, seconds: Double) -> [Data]? {
        guard let file = try? AVAudioFile(forReading: url) else { return nil }
        let src = file.processingFormat
        let frames = AVAudioFrameCount(min(Double(file.length), seconds * src.sampleRate))
        guard frames > 0, let inBuf = AVAudioPCMBuffer(pcmFormat: src, frameCapacity: frames) else { return nil }
        do { try file.read(into: inBuf, frameCount: frames) } catch { return nil }
        guard let wire = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24_000, channels: 1, interleaved: true),
              let converter = AVAudioConverter(from: src, to: wire) else { return nil }
        let outFrames = AVAudioFrameCount(Double(frames) * 24_000 / src.sampleRate) + 32
        guard let out = AVAudioPCMBuffer(pcmFormat: wire, frameCapacity: outFrames) else { return nil }
        var consumed = false
        var error: NSError?
        let status = converter.convert(to: out, error: &error) { _, outStatus in
            if consumed { outStatus.pointee = .noDataNow; return nil }
            consumed = true
            outStatus.pointee = .haveData
            return inBuf
        }
        guard status != .error, let ch = out.int16ChannelData?[0] else { return nil }
        let all = Data(bytes: ch, count: Int(out.frameLength) * 2)
        var chunks: [Data] = []
        var i = 0
        while i + AudioEngine.chunkBytes <= all.count {
            chunks.append(all.subdata(in: i ..< i + AudioEngine.chunkBytes))
            i += AudioEngine.chunkBytes
        }
        return chunks
    }
}

// MARK: - ~/.jarhead/audio-probe.json

enum ProbeStateFile {
    /// Merge `record`'s figures into the mode's entry (V1's fields stay; `at` moves).
    static func merge(_ record: [String: Any], mode: String, stateDir: String?, say: (String) -> Void) {
        let dir = stateDir.map { URL(fileURLWithPath: $0) } ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".jarhead")
        let url = dir.appendingPathComponent("audio-probe.json")
        var root: [String: Any] = [:]
        if let data = try? Data(contentsOf: url), let existing = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            root = existing.filter { ["aec", "recording", "private", "asleep"].contains($0.key) }
        }
        var entry = root[mode] as? [String: Any] ?? [:]
        for (k, v) in record { entry[k] = v }
        root[mode] = entry
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try JSONSerialization.data(withJSONObject: root, options: [.sortedKeys, .prettyPrinted]).write(to: url, options: .atomic)
            say("wrote \(url.path) (\(mode))")
        } catch {
            say("could not write \(url.path): \(error.localizedDescription)")
        }
    }
}
