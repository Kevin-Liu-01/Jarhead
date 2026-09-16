import AVFoundation
import CoreAudio
import Foundation
import Speech

// Throwaway harness (design12 § Verification V1): the audio graph's state read back on this
// Mac, without the app, the daemon or a session. Not part of the package; compiled only by
// Scripts/audio-probe.sh into a minimal AudioProbe.app (its own TCC identity for the
// microphone) or run inline with AUDIO_PROBE_DIRECT=1 under a terminal that holds the grant.
//
//   AUDIO_PROBE_MODE=aec|recording|private|asleep   (default aec)
//     aec        `AudioEngine` with `VoiceProcessingPolicy.aec`: the unit on, the knobs read back
//                in both spellings (the Swift properties and the raw AU property 2108), the
//                rung, `hears` following the system default, released at stop
//     recording  `VoiceProcessingPolicy.recording`: no unit, the ranked microphone, the guard on,
//                no voice-processing aggregate (VPAUAggregateAudioDevice-*) appears
//     asleep     a `WakeWordListener` start: the listener's own input AU pointed at the ranked
//                microphone (its `hears <name> (ranked | system default)` line), no unit
//     private    the spike: Jarhead's own aggregate (`PrivateRoute`) built and offered to a
//                voice-processing unit — printed as `spike:` lines, never counted
//   AUDIO_PROBE_SECONDS=3     how long the graph stays up
//   AUDIO_PROBE_PLAY=1        allow sound: without it `--test` prints what it would do (dryRun) and exits 0
//   AUDIO_PROBE_NO_PROMPT=1   never ask TCC: an undecided microphone grant is a refusal, not a prompt
//   AUDIO_PROBE_STATE_DIR     where audio-probe.json goes (default ~/.jarhead)
//   --json                    the last JSON line is the run record (what audio-probe.json holds for this mode; `probe exit n` follows)
//   --test                    `pnpm jarhead doctor --test-audio`: the graph as the current setting
//                             (~/.jarhead/settings.json audio.recording) would build it, 1 s quiet,
//                             a 1 s −12 dBFS 1 kHz chime through the player node, 1 s more; prints
//                             `leakDb` (the wire's residual while the chime plays, dBFS) and what the
//                             guard gated. Refuses while Jarhead.app holds a microphone
//                             (`warn: Jarhead is awake; sleep it first`).
//
// Every claim is a `check: <mode>: <what> ok | FAIL <why>` line and the run ends
// `checks: N ok, M FAIL`; the record for the doctor's `leak` row lands in
// ~/.jarhead/audio-probe.json keyed by mode. Nothing connects to the daemon, nothing opens a
// session, nothing is paid; without AUDIO_PROBE_PLAY=1 nothing is played.

@main
struct AudioProbeMain {
    static func main() {
        setlinebuf(stdout)
        let config = ProbeConfig.fromEnvironment(CommandLine.arguments)
        MainActor.assumeIsolated { AudioProbe.shared.begin(config) }
        RunLoop.main.run()
    }
}

enum ProbeMode: String {
    case aec, recording, `private`, asleep

    var policy: VoiceProcessingPolicy { self == .recording ? .recording : .aec }
}

/// The words every line is made of, in one place.
enum ProbeWords {
    static let awake = "warn: Jarhead is awake; sleep it first"
    static let refusedAwake = "Jarhead is awake; sleep it first"
    static let dryRun = "nothing played — set AUDIO_PROBE_PLAY=1 to play the 1 s −12 dBFS chime"
    static let jarheadBundle = "com.kevinliu.jarhead"
    /// AVAudioEngine's own default-device aggregate (default input ≠ default output): lives with
    /// the engine object, unit or no unit — NOT the voice-processing unit's.
    static let enginePrefix = AudioAggregates.enginePrefix
    /// The voice-processing unit's aggregate: appears with the unit, must go at stop.
    static let unitPrefix = AudioAggregates.unitPrefix
    static let stateFile = "audio-probe.json"
    static let settingsFile = "settings.json"
}

struct ProbeConfig {
    var mode: ProbeMode
    var test: Bool
    var json: Bool
    var play: Bool
    var mayPrompt: Bool
    var holdSeconds: Double
    var stateDir: URL

    static func fromEnvironment(_ args: [String]) -> ProbeConfig {
        let env = ProcessInfo.processInfo.environment
        let home = FileManager.default.homeDirectoryForCurrentUser
        let stateDir = env["AUDIO_PROBE_STATE_DIR"].map { URL(fileURLWithPath: $0) } ?? home.appendingPathComponent(".jarhead")
        let test = args.contains("--test")
        var mode = ProbeMode(rawValue: env["AUDIO_PROBE_MODE"] ?? "") ?? .aec
        if let i = args.firstIndex(of: "--mode"), i + 1 < args.count, let m = ProbeMode(rawValue: args[i + 1]) { mode = m }
        if test, env["AUDIO_PROBE_MODE"] == nil, !args.contains("--mode") {
            mode = ProbeConfig.recordingSetting(stateDir) ? .recording : .aec
        }
        let hold = Double(env["AUDIO_PROBE_SECONDS"] ?? "") ?? 3
        return ProbeConfig(mode: mode, test: test, json: args.contains("--json"), play: env["AUDIO_PROBE_PLAY"] == "1",
                           mayPrompt: env["AUDIO_PROBE_NO_PROMPT"] != "1", holdSeconds: min(60, max(1, hold)), stateDir: stateDir)
    }

    /// `audio.recording` from ~/.jarhead/settings.json (the current setting `--test` builds against); false when unreadable.
    static func recordingSetting(_ stateDir: URL) -> Bool {
        let url = stateDir.appendingPathComponent(ProbeWords.settingsFile)
        guard let data = try? Data(contentsOf: url),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let audio = root["audio"] as? [String: Any] else { return false }
        return audio["recording"] as? Bool ?? false
    }
}

// MARK: - the HAL as a table

/// One row of `kAudioHardwarePropertyDevices` at a moment: enough to diff and to read the rate.
struct DeviceRow: Equatable {
    var uid: String
    var name: String
    var rate: Double
    var transport: String
    var input: Bool
    var output: Bool

    var isAggregate: Bool { uid.hasPrefix(ProbeWords.enginePrefix) || uid.hasPrefix(ProbeWords.unitPrefix) }
    var text: String { "\(name) [\(uid)] \(Int(rate)) Hz \(transport)\(input ? " in" : "")\(output ? " out" : "")" }
}

enum DeviceTable {
    static func snapshot() -> [DeviceRow] {
        AudioEngine.allDeviceIDs().compactMap { id in
            guard let uid = AudioEngine.deviceUID(id) else { return nil }
            return DeviceRow(uid: uid, name: MicInputs.deviceName(id) ?? uid, rate: CoreAudioReads.nominalRate(id),
                             transport: MicInput.transportName(CoreAudioReads.transport(id)),
                             input: CoreAudioReads.channelCount(id, scope: kAudioObjectPropertyScopeInput) > 0,
                             output: CoreAudioReads.channelCount(id, scope: kAudioObjectPropertyScopeOutput) > 0)
        }
    }

    /// (appeared, gone) by uid.
    static func diff(_ before: [DeviceRow], _ after: [DeviceRow]) -> ([String], [String]) {
        let b = Set(before.map(\.uid)), a = Set(after.map(\.uid))
        return (a.subtracting(b).sorted(), b.subtracting(a).sorted())
    }

    static func aggregates(_ rows: [DeviceRow]) -> [String] { rows.filter(\.isAggregate).map(\.uid).sorted() }
}

/// Does Jarhead.app hold a microphone right now? The HAL's process objects name it by bundle id;
/// on a HAL without them the fallback is a running `Jarhead` process beside a default-device
/// aggregate (the unit's own). nil = not awake (or nothing to say).
enum JarheadAwake {
    static func detect() -> String? {
        if AudioProcessObjects.available {
            for object in CoreAudioReads.objectIDs(CoreAudioReads.system, kAudioHardwarePropertyProcessObjectList) {
                guard CoreAudioReads.string(object, kAudioProcessPropertyBundleID) == ProbeWords.jarheadBundle else { continue }
                guard CoreAudioReads.uint32(object, kAudioProcessPropertyIsRunningInput) == 1 else { continue }
                let pid = CoreAudioReads.uint32(object, kAudioProcessPropertyPID) ?? 0
                return "Jarhead (pid \(pid)) is running input"
            }
            return nil
        }
        let pids = shell("/usr/bin/pgrep", ["-x", "Jarhead"]).split(separator: "\n").map(String.init)
        guard !pids.isEmpty else { return nil }
        let aggregates = DeviceTable.aggregates(DeviceTable.snapshot())
        let owned = aggregates.filter { uid in pids.contains { uid.hasPrefix("\(ProbeWords.enginePrefix)-\($0)-") } }
        return owned.isEmpty ? nil : "Jarhead (pid \(pids.joined(separator: ","))) holds \(owned.joined(separator: ", "))"
    }

    private static func shell(_ path: String, _ args: [String]) -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return "" }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

// MARK: - the tally (tap thread, audio queue)

/// Energy on both sides of the guard: the raw tap buffer (`onMicBuffer`) and the wire chunks
/// (`onMicChunk`), per window — `quiet` before the chime, `chime` while it plays (+ the tail),
/// `after`. Every access under `lock`.
final class Tally: @unchecked Sendable {
    enum Window: Int { case quiet, chime, after }

    let lock = NSLock()
    var window = Window.quiet
    var rawEnergy = [Double](repeating: 0, count: 3)
    var rawFrames = [Int](repeating: 0, count: 3)
    var wireEnergy = [Double](repeating: 0, count: 3)
    var wireChunks = [Int](repeating: 0, count: 3)
    var firstBuffer: String?

    func noteRaw(_ buffer: AVAudioPCMBuffer) {
        guard let ch = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return }
        var acc = 0.0
        for i in 0 ..< Int(buffer.frameLength) { acc += Double(ch[i] * ch[i]) }
        lock.lock()
        rawEnergy[window.rawValue] += acc.isFinite ? acc : 0
        rawFrames[window.rawValue] += Int(buffer.frameLength)
        if firstBuffer == nil { firstBuffer = buffer.format.brief }
        lock.unlock()
    }

    func noteWire(_ chunk: Data) {
        let rms = AudioEngine.rms(chunk)
        lock.lock()
        wireEnergy[window.rawValue] += rms * rms
        wireChunks[window.rawValue] += 1
        lock.unlock()
    }

    func set(_ w: Window) {
        lock.lock(); window = w; lock.unlock()
    }

    /// RMS in dBFS (−120 floor) of the raw side and the wire side of one window.
    func dbfs(_ w: Window) -> (raw: Double?, wire: Double?) {
        lock.lock(); defer { lock.unlock() }
        let raw = rawFrames[w.rawValue] > 0 ? Tally.db((rawEnergy[w.rawValue] / Double(rawFrames[w.rawValue])).squareRoot()) : nil
        let wire = wireChunks[w.rawValue] > 0 ? Tally.db((wireEnergy[w.rawValue] / Double(wireChunks[w.rawValue])).squareRoot()) : nil
        return (raw, wire)
    }

    static func db(_ rms: Double) -> Double {
        guard rms.isFinite, rms > 0 else { return -120 }
        return max(-120, (20 * log10(rms) * 10).rounded() / 10)
    }
}

// MARK: - the checks

final class Checks {
    private(set) var lines: [String] = []
    private(set) var ok = 0
    private(set) var failed = 0
    private let say: (String) -> Void

    init(say: @escaping (String) -> Void) { self.say = say }

    func check(_ name: String, _ holds: Bool, _ why: @autoclosure () -> String) {
        if holds {
            ok += 1
            lines.append("\(name) ok")
            say("check: \(name) ok")
        } else {
            failed += 1
            let w = why()
            lines.append("\(name) FAIL \(w)")
            say("check: \(name) FAIL \(w)")
        }
    }

    func info(_ text: String) { say("info: \(text)") }

    var summary: String { "checks: \(ok) ok, \(failed) FAIL" }
    var json: [String: Any] { ["ok": ok, "fail": failed, "lines": lines] }
}

// MARK: - the probe

@MainActor
final class AudioProbe {
    static let shared = AudioProbe()

    private let t0 = Date()
    private var config = ProbeConfig.fromEnvironment([])
    private var checks: Checks!
    private var engine: AudioEngine?
    private var listener: WakeWordListener?
    private let tally = Tally()
    private var frames: [AudioStateReadback] = []
    private var statusLines: [String] = []
    private var listenerLines: [String] = []
    private var listenerStatus: WakeWordListener.Status?
    private var before: [DeviceRow] = []
    private var during: [DeviceRow] = []
    private var speaksRates: [Double] = []
    private var rateTimer: Timer?
    private var awakeNote: String?

    private var latest: AudioStateReadback? { frames.last }
    private var runningFrame: AudioStateReadback? { frames.first { $0.running } }

    private func stamp() -> String { String(format: "+%6.3f", Date().timeIntervalSince(t0)) }
    func say(_ s: String) { print("\(stamp())  \(s)") }
    private func after(_ seconds: Double, _ body: @escaping @MainActor () -> Void) {
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { MainActor.assumeIsolated(body) }
    }

    func begin(_ config: ProbeConfig) {
        self.config = config
        checks = Checks(say: { [weak self] in self?.say($0) })
        say("audio-probe: mode \(config.mode.rawValue)\(config.test ? " · --test" : "") · play \(config.play ? "allowed" : "off") · hold \(Int(config.holdSeconds)) s · bundle \(Bundle.main.bundleIdentifier ?? "none (inline)") · PrivateRoute.enabled \(PrivateRoute.enabled)")
        awakeNote = JarheadAwake.detect()
        if let awakeNote {
            say("\(ProbeWords.awake) — \(awakeNote)")
            if config.test { return refuse(ProbeWords.refusedAwake) }
        }
        checkGrant()
    }

    private func checkGrant() {
        let status = AVCaptureDevice.authorizationStatus(for: .audio)
        switch status {
        case .authorized:
            say("microphone: granted")
            run()
        case .notDetermined where !config.mayPrompt:
            refuse("microphone grant undecided (AUDIO_PROBE_NO_PROMPT=1, not asking) — run once without it to answer the prompt")
        case .notDetermined:
            say("asking for the microphone (the prompt names \(Bundle.main.bundleIdentifier ?? "the terminal"))…")
            AVCaptureDevice.requestAccess(for: .audio) { ok in
                DispatchQueue.main.async { MainActor.assumeIsolated {
                    self.say("microphone: \(ok ? "granted" : "denied")")
                    ok ? self.run() : self.refuse("microphone denied")
                } }
            }
        default:
            refuse("microphone denied/restricted (\(status.rawValue)) — System Settings › Privacy › Microphone")
        }
    }

    private func refuse(_ why: String) {
        say("refused: \(why)")
        if config.test || config.json { print(jsonLine(["refused": why, "mode": config.mode.rawValue])) }
        finish(code: 3)
    }

    private func finish(code: Int32) {
        rateTimer?.invalidate()
        print("probe exit \(code)")
        after(0.2) { exit(code) }
    }

    // MARK: before

    private func run() {
        before = DeviceTable.snapshot()
        say("before: \(before.count) devices; default input \(AudioDeviceFacts.defaultInput()?.text ?? "none"); default output \(AudioDeviceFacts.defaultOutput()?.text ?? "none")")
        for row in before where row.isAggregate { say("before: aggregate already present: \(row.uid)") }
        printRanking()
        printSharing()
        switch config.mode {
        case .aec, .recording: startGraph()
        case .asleep: startListener()
        case .private: PrivateSpike(say: { [weak self] in self?.say($0) }).run { [weak self] in self?.afterSpike() }
        }
    }

    private func printRanking() {
        let inputs = MicInputs.enumerate()
        let systemDefault = MicInputs.systemDefaultUID()
        let ranked = MicRanking.rank(inputs, explicit: nil, lastUsed: nil, systemDefault: systemDefault)
        let words = ranked.map { "\($0.name) (\($0.transportName)\($0.uid == systemDefault ? ", default" : ""))" }
        say("ranking: \(words.isEmpty ? "no input devices" : words.joined(separator: " › "))")
        for row in before { say("  device: \(row.text)") }
    }

    private func printSharing() {
        guard let id = CoreAudioReads.defaultDevice(kAudioHardwarePropertyDefaultInputDevice) else { return }
        if let shared = AudioProcessObjects.sharingInput(on: id) {
            say("sharing: \(shared.isEmpty ? "nobody else runs input on the default microphone" : "default microphone shared with \(shared.joined(separator: ", "))")")
        } else {
            say("sharing: the HAL has no process objects (unknown)")
        }
    }

    // MARK: the graph (aec · recording · --test)

    private func startGraph() {
        let engine = AudioEngine()
        self.engine = engine
        let tally = self.tally
        engine.onStatus = { [weak self] line in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.noteStatus(line) } }
        }
        engine.onAudioState = { [weak self] frame in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.noteFrame(frame) } }
        }
        engine.onMicBuffer = { buffer, _ in tally.noteRaw(buffer) }
        engine.onMicChunk = { chunk in tally.noteWire(chunk) }
        engine.setPolicy(config.mode.policy)
        say("start: policy \(config.mode.rawValue) — \(config.mode.policy.knobsDescription); ladder \(config.mode.policy.attempts.map { "\($0.voice ? "vp" : "plain")/\($0.wiring)" }.joined(separator: " › "))")
        engine.start()
        waitForGraph(deadline: Date().addingTimeInterval(8))
    }

    private func noteStatus(_ line: String) {
        statusLines.append(line)
        say("engine: \(line)")
    }

    private func noteFrame(_ frame: AudioStateReadback) {
        frames.append(frame)
        say("frame: \(frame.summary)")
    }

    private func waitForGraph(deadline: Date) {
        if runningFrame != nil { return graphIsUp() }
        guard Date() < deadline else {
            checks.check("\(config.mode.rawValue): graph came up", false, "no running frame within 8 s")
            return teardown()
        }
        after(0.1) { [weak self] in self?.waitForGraph(deadline: deadline) }
    }

    private func graphIsUp() {
        during = DeviceTable.snapshot()
        let (appeared, gone) = DeviceTable.diff(before, during)
        say("during: devices appeared \(appeared.isEmpty ? "none" : appeared.joined(separator: ", ")); gone \(gone.isEmpty ? "none" : gone.joined(separator: ", "))")
        rateTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            let rate = AudioDeviceFacts.defaultOutput()?.rate ?? 0
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.speaksRates.append(rate) } }
        }
        // The knobs line lands a moment after the running frame; read the state at +1 s.
        after(1.0) { [weak self] in self?.duringChecks(appeared: appeared) }
    }

    private func duringChecks(appeared: [String]) {
        guard let frame = runningFrame else { return }
        let latestFrame = latest ?? frame
        say("during: hears \(latestFrame.hears?.text ?? "none") · \(latestFrame.hearsState); speaks \(latestFrame.speaks?.text ?? "none") · \(latestFrame.speaksState); tap \(latestFrame.tapFormat); rung \(latestFrame.rung) \(latestFrame.wiring); inputMuted \(latestFrame.inputMuted)")
        if config.mode == .aec { aecChecks(latestFrame, appeared: appeared) } else { recordingChecks(latestFrame, appeared: appeared) }
        if let shared = latestFrame.sharedWith {
            checks.info("shared with: \(shared.isEmpty ? "nobody" : shared.joined(separator: ", "))")
        } else {
            checks.info("shared with: the HAL cannot say")
        }
        if config.test { return testPhase() }
        after(max(0, config.holdSeconds - 1)) { [weak self] in self?.teardown() }
    }

    private func aecChecks(_ f: AudioStateReadback, appeared: [String]) {
        let p = VoiceProcessingPolicy.aec
        checks.check("aec: voiceProcessing on", f.voiceProcessing && !f.fallback, "voiceProcessing \(f.voiceProcessing), fallback \(f.fallback), rung \(f.rung)")
        let knobs = f.duckLevel == p.duckLevel && f.advancedDucking == p.advancedDucking && f.agc == p.agc && f.bypassed == p.bypass
        checks.check("aec: duck \(p.duckLevel) · advanced \(p.advancedDucking) · agc \(p.agc) · bypass \(p.bypass)", knobs,
                     "read duck \(f.duckLevel.map(String.init) ?? "nil") advanced \(f.advancedDucking.map(String.init) ?? "nil") agc \(f.agc.map(String.init) ?? "nil") bypass \(f.bypassed.map(String.init) ?? "nil")")
        let raw = rawDucking()
        checks.check("aec: raw 2108 == swift", raw != nil && raw?.level == f.duckLevel && raw?.advanced == f.advancedDucking,
                     raw.map { "raw duck \($0.level) advanced \($0.advanced) vs swift \(f.duckLevel.map(String.init) ?? "nil") \(f.advancedDucking.map(String.init) ?? "nil")" } ?? "no `raw 2108` line in the engine's log")
        checks.check("aec: hears follows the system default", f.hears?.uid == MicInputs.systemDefaultUID(), "hears \(f.hears?.uid ?? "nil") vs default \(MicInputs.systemDefaultUID() ?? "nil")")
        checks.check("aec: rung 1–3 (a voice-processing rung)", (1 ... 3).contains(f.rung), "rung \(f.rung)")
        checks.check("aec: guard off", !f.guardOn, "guardOn \(f.guardOn)")
        let unit = appeared.filter { $0.hasPrefix(ProbeWords.unitPrefix) }
        checks.check("aec: the unit's aggregate (\(ProbeWords.unitPrefix)-*) appeared", !unit.isEmpty, "appeared \(appeared)")
        engineAggregateInfo(appeared, frame: f)
    }

    private func recordingChecks(_ f: AudioStateReadback, appeared: [String]) {
        let inputs = MicInputs.enumerate()
        let ranked = MicRanking.rank(inputs, explicit: nil, lastUsed: nil, systemDefault: MicInputs.systemDefaultUID())
        checks.check("recording: voiceProcessing off", !f.voiceProcessing && f.recording && !f.fallback, "voiceProcessing \(f.voiceProcessing), recording \(f.recording), fallback \(f.fallback)")
        // On a Mac whose default input ≠ default output the plain input AU's CurrentDevice reads as the
        // engine's own aggregate; the route line then names the microphone behind it (`active <name>`).
        let hearsAggregate = f.hears?.uid.hasPrefix(ProbeWords.enginePrefix) == true
        let active = activeFromRoute()
        let hearsRanked = f.hears?.uid == ranked.first?.uid || (hearsAggregate && active == ranked.first?.name)
        checks.check("recording: hears == ranked first (\(ranked.first?.name ?? "none"))", hearsRanked,
                     "hears \(f.hears?.name ?? "nil") [\(f.hears?.uid ?? "")], route active \(active ?? "nil"), ranked \(ranked.first?.name ?? "nil") [\(ranked.first?.uid ?? "")]")
        if hearsAggregate { checks.info("hears reads the engine's aggregate \(f.hears?.uid ?? ""); the microphone behind it is \(active ?? "unknown") (the route line)") }
        checks.check("recording: guard on · tail ≥ 300 ms", f.guardOn && f.guardTailMs >= 300, "guardOn \(f.guardOn), tail \(f.guardTailMs) ms")
        let unit = appeared.filter { $0.hasPrefix(ProbeWords.unitPrefix) }
        checks.check("recording: no voice-processing aggregate (\(ProbeWords.unitPrefix)-*) appeared", unit.isEmpty, "appeared \(unit)")
        engineAggregateInfo(appeared, frame: f)
        checks.check("recording: rung 1–3 (plain)", (1 ... 3).contains(f.rung), "rung \(f.rung) \(f.wiring)")
        checks.check("recording: hears is a microphone, not the engine's aggregate", !hearsAggregate, "hears \(f.hears?.uid ?? "nil")")
        checks.check("recording: duck knobs absent", f.duckLevel == nil && f.agc == nil, "duck \(f.duckLevel.map(String.init) ?? "nil") agc \(f.agc.map(String.init) ?? "nil")")
    }

    /// The engine's own aggregate is a fact to print, not a pin: it appears with the first plain
    /// attempt too and lives with the `AVAudioEngine` object (the frame's `engineAggregatePresent`;
    /// `aggregatePresent` is the unit's).
    private func engineAggregateInfo(_ appeared: [String], frame f: AudioStateReadback) {
        let engine = appeared.filter { $0.hasPrefix(ProbeWords.enginePrefix) }
        checks.info("engine's own aggregate (\(ProbeWords.enginePrefix)-<pid>-n, default in ≠ default out): \(engine.isEmpty ? "none" : engine.joined(separator: ", ")) · frame engineAggregatePresent \(f.engineAggregatePresent) · unit aggregatePresent \(f.aggregatePresent)")
    }

    /// `mic route (audio running): … ; active <name>, follows …` → the name; nil when no such line.
    private func activeFromRoute() -> String? {
        for line in statusLines.reversed() where line.hasPrefix("mic route (audio running)") {
            guard let a = line.range(of: "; active "), let b = line.range(of: ", follows", range: a.upperBound ..< line.endIndex) else { return nil }
            return String(line[a.upperBound ..< b.lowerBound])
        }
        return nil
    }

    /// `… · raw 2108 duck 10 advanced true` from the engine's knobs line; nil when absent or `n/a`.
    private func rawDucking() -> (level: UInt32, advanced: Bool)? {
        for line in statusLines.reversed() {
            guard let range = line.range(of: "raw 2108 duck ") else { continue }
            let words = line[range.upperBound...].split(separator: " ").map(String.init)
            guard words.count >= 3, let level = UInt32(words[0]), words[1] == "advanced" else { return nil }
            return (level, words[2] == "true")
        }
        return nil
    }

    // MARK: --test: quiet, chime, after

    private func testPhase() {
        guard config.play else {
            say("dry run: would play a 1 s −12 dBFS 1 kHz chime through the player node and read the wire's residual")
            return teardown()
        }
        tally.set(.quiet)
        say("test: 1 s quiet (the floor)…")
        after(1.0) { [weak self] in
            guard let self, let engine = self.engine else { return }
            self.tally.set(.chime)
            self.say("test: chime 1 s −12 dBFS 1 kHz through the player node")
            for chunk in Chime.chunks(seconds: 1.0) { engine.play(pcm: chunk) }
            self.after(1.5) { [weak self] in
                self?.tally.set(.after)
                self?.say("test: 1 s after")
                self?.after(1.0) { [weak self] in self?.teardown() }
            }
        }
    }

    // MARK: stop and after

    private func teardown() {
        rateTimer?.invalidate()
        rateTimer = nil
        if let min = speaksRates.min(), let max = speaksRates.max() {
            let word = min >= AudioStateWords.narrowRate ? AudioStateWords.fullQuality : AudioStateWords.narrowed
            say("during: default output rate \(Int(min))…\(Int(max)) Hz over \(speaksRates.count) samples · \(word)")
        }
        say("stop")
        engine?.stop()
        listener?.stop()
        after(2.0) { [weak self] in self?.afterStop() }
    }

    private func afterStop() {
        // A fresh frame if anything changed since the stop frame (coalesced: silence means equal).
        NotificationCenter.default.post(name: MicRoute.requestName, object: nil)
        after(0.5) { [weak self] in self?.afterChecks() }
    }

    private func afterChecks() {
        let now = DeviceTable.snapshot()
        let (appeared, gone) = DeviceTable.diff(during.isEmpty ? before : during, now)
        say("after stop (2 s): devices appeared \(appeared.isEmpty ? "none" : appeared.joined(separator: ", ")); gone \(gone.isEmpty ? "none" : gone.joined(separator: ", "))")
        let stillNew = DeviceTable.diff(before, now).0
        let unitLeft = stillNew.filter { $0.hasPrefix(ProbeWords.unitPrefix) }
        let engineLeft = stillNew.filter { $0.hasPrefix(ProbeWords.enginePrefix) }
        let mode = config.mode.rawValue
        if config.mode != .asleep {
            let f = latest
            say("after stop: \(f?.summary ?? "no frame")")
            checks.check("\(mode): after stop isVoiceProcessingEnabled false", f != nil && f?.running == false && f?.voiceProcessing == false, "running \(f?.running ?? false), voiceProcessing \(f?.voiceProcessing ?? false)")
            checks.check("\(mode): after stop the unit's aggregate is gone", unitLeft.isEmpty, "still present \(unitLeft)")
            checks.check("\(mode): after stop the frame's aggregatePresent (the unit's) is false", f?.aggregatePresent == false, "aggregatePresent \(f?.aggregatePresent ?? false)")
            checks.info("after stop the engine's own aggregate \(engineLeft.isEmpty ? "is gone" : "stays while the AVAudioEngine object lives: \(engineLeft.joined(separator: ", "))") · frame engineAggregatePresent \(f?.engineAggregatePresent ?? false)")
        } else {
            checks.check("asleep: no voice-processing aggregate appeared", unitLeft.isEmpty, "present \(unitLeft)")
        }
        bluetoothPin()
        report()
    }

    /// The HFP fact: with a Bluetooth default output the rate must hold ≥ 44 100 in recording and
    /// asleep; under aec it drops only while the unit follows the headset microphone — printed.
    private func bluetoothPin() {
        let speaks = (runningFrame?.speaks) ?? AudioDeviceFacts.defaultOutput()
        guard let speaks, speaks.isBluetooth else {
            checks.info("bluetooth pin skipped — default output is \(speaks?.transport ?? "unknown")")
            return
        }
        let minRate = speaksRates.min() ?? speaks.rate
        switch config.mode {
        case .recording, .asleep:
            checks.check("bluetooth: \(speaks.name) rate ≥ 44100 throughout (\(config.mode.rawValue))", minRate >= AudioStateWords.narrowRate, "fell to \(Int(minRate)) Hz")
        case .aec:
            let followsHeadset = runningFrame?.hears?.isBluetooth == true
            checks.info("bluetooth: \(speaks.name) rate during aec \(Int(minRate)) Hz (\(minRate >= AudioStateWords.narrowRate ? AudioStateWords.fullQuality : AudioStateWords.narrowed)) — the unit \(followsHeadset ? "follows the headset microphone" : "follows \(runningFrame?.hears?.name ?? "the default")")")
        case .private:
            break
        }
    }

    // MARK: the listener (asleep)

    private func startListener() {
        WakeWordListener.log = { [weak self] line in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.noteListener(line) } }
        }
        let (ok, detail) = WakeWordListener.currentAuthorization()
        say("speech recognition: \(detail)\(ok ? "" : " — the device pin needs only the engine; recognition itself may error")")
        let listener = WakeWordListener()
        self.listener = listener
        listener.onStatus = { [weak self] status in
            self?.listenerStatus = status
            self?.say("listener status: \(status.text)")
        }
        say("start: wake listener (its own engine, no unit); ranked \(rankedName() ?? "none") · default \(MicInputs.name(of: MicInputs.systemDefaultUID()) ?? "none")")
        listener.start()
        waitForListener(deadline: Date().addingTimeInterval(8))
    }

    private func noteListener(_ line: String) {
        listenerLines.append(line)
        say("listener: \(line)")
    }

    private func rankedName() -> String? {
        let ranked = MicRanking.rank(MicInputs.enumerate(), explicit: nil, lastUsed: nil, systemDefault: MicInputs.systemDefaultUID())
        return ranked.first?.name
    }

    private func waitForListener(deadline: Date) {
        if let status = listenerStatus {
            switch status {
            case .started: return listenerIsUp()
            case .unavailable, .startFailed:
                checks.check("asleep: listener started", false, status.text)
                return teardown()
            case .recognitionError: break
            }
        }
        guard Date() < deadline else {
            checks.check("asleep: listener started", false, "no status within 8 s")
            return teardown()
        }
        after(0.1) { [weak self] in self?.waitForListener(deadline: deadline) }
    }

    private func listenerIsUp() {
        during = DeviceTable.snapshot()
        rateTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            let rate = AudioDeviceFacts.defaultOutput()?.rate ?? 0
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.speaksRates.append(rate) } }
        }
        checks.check("asleep: listener started", true, "")
        let ranked = MicRanking.rank(MicInputs.enumerate(), explicit: nil, lastUsed: nil, systemDefault: MicInputs.systemDefaultUID())
        let systemDefault = MicInputs.systemDefaultUID()
        let hears = listenerLines.last { $0.hasPrefix("hears ") } ?? ""
        let want: String
        if let first = ranked.first, first.uid != systemDefault {
            want = "hears \(first.name) (ranked)"
        } else {
            want = "hears \(MicInputs.name(of: systemDefault) ?? "the system default") (system default)"
        }
        checks.check("asleep: listener CurrentDevice == ranked uid", hears == want, "log says \"\(hears)\", want \"\(want)\"")
        after(config.holdSeconds) { [weak self] in self?.teardown() }
    }

    private func afterSpike() {
        say("spike done — nothing counted; PrivateRoute.enabled stays \(PrivateRoute.enabled)")
        after(0.5) { [weak self] in self?.report() }
    }

    // MARK: the report

    private func report() {
        say(checks.summary)
        let record = runRecord()
        writeRecord(record)
        if config.test {
            print(jsonLine(testJSON(record)))
        } else if config.json {
            print(jsonLine(record))
        }
        finish(code: checks.failed == 0 ? 0 : 1)
    }

    /// One run as ~/.jarhead/audio-probe.json holds it under this mode (the doctor's reader: `at` and `mode` required).
    private func runRecord() -> [String: Any] {
        var r: [String: Any] = [
            "at": Int(Date().timeIntervalSince1970 * 1000),
            "mode": config.mode.rawValue,
            "checks": checks.json,
        ]
        if let f = runningFrame {
            r["rung"] = f.rung
            r["wiring"] = f.wiring
            r["tailMs"] = f.guardTailMs
            r["voiceProcessing"] = f.voiceProcessing
            if let shared = f.sharedWith { r["sharedWith"] = shared }
            if let hears = f.hears { r["hears"] = ["name": hears.name, "uid": hears.uid, "rate": hears.rate, "transport": hears.transport] }
            if let speaks = f.speaks { r["speaks"] = ["name": speaks.name, "uid": speaks.uid, "rate": speaks.rate, "transport": speaks.transport] }
        }
        if let f = latest, !f.running {
            r["vpAfterStop"] = f.voiceProcessing
            r["aggregateAfterStop"] = f.aggregatePresent
            r["gated"] = f.gated
            r["chunks"] = f.chunks
        }
        if let min = speaksRates.min() { r["speaksRateDuring"] = min }
        if let awakeNote { r["jarheadAwake"] = awakeNote }
        if config.test, config.play { for (k, v) in leakFigures() { r[k] = v } }
        return r
    }

    /// `leakDb` = the wire's RMS while the chime plays (+ 0.5 s), dBFS — with the guard holding, the zero-filled
    /// floor by construction; `tailLeakDbfs` = the wire in the second after that, once the hold has released —
    /// the figure the doctor's `leak` row judges first; `couplingDb` = how far the raw microphone rose over the
    /// quiet second; `floorDbfs` = the wire at rest.
    private func leakFigures() -> [String: Any] {
        let quiet = tally.dbfs(.quiet), chime = tally.dbfs(.chime), after = tally.dbfs(.after)
        var out: [String: Any] = [:]
        if let wire = chime.wire { out["leakDb"] = wire; out["residualDbfs"] = wire }
        if let tail = after.wire { out["tailLeakDbfs"] = tail }
        if let floor = quiet.wire { out["floorDbfs"] = floor }
        if let rq = quiet.raw, let rc = chime.raw { out["couplingDb"] = ((rc - rq) * 10).rounded() / 10 }
        return out
    }

    /// The last line `pnpm jarhead doctor --test-audio` reads.
    private func testJSON(_ record: [String: Any]) -> [String: Any] {
        guard config.play else { return ["dryRun": true, "note": "\(ProbeWords.dryRun); \(checks.summary) in \(config.mode.rawValue)", "mode": config.mode.rawValue] }
        var j: [String: Any] = ["mode": config.mode.rawValue]
        for key in ["leakDb", "residualDbfs", "tailLeakDbfs", "couplingDb", "floorDbfs", "gated", "chunks", "rung"] where record[key] != nil { j[key] = record[key] }
        if j["leakDb"] == nil { j["refused"] = "the chime played but no wire chunks were counted" }
        return j
    }

    private func writeRecord(_ record: [String: Any]) {
        let url = config.stateDir.appendingPathComponent(ProbeWords.stateFile)
        var root: [String: Any] = [:]
        if let data = try? Data(contentsOf: url), let existing = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            // Keep only the record-by-mode shape; a single-run or {runs} file from an older probe is replaced.
            root = existing.filter { ProbeMode(rawValue: $0.key) != nil }
        }
        root[config.mode.rawValue] = record
        do {
            try FileManager.default.createDirectory(at: config.stateDir, withIntermediateDirectories: true)
            let data = try JSONSerialization.data(withJSONObject: root, options: [.sortedKeys, .prettyPrinted])
            try data.write(to: url, options: .atomic)
            say("wrote \(url.path) (\(root.keys.sorted().joined(separator: ", ")))")
        } catch {
            say("could not write \(url.path): \(error.localizedDescription)")
        }
    }

    private func jsonLine(_ object: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return "{}" }
        return String(decoding: data, as: UTF8.self)
    }
}

// MARK: - the chime

/// 1 kHz at −12 dBFS as PCM16 mono 24 kHz, in the wire's 100 ms chunks — the same path the
/// daemon's speaker frames take (`AudioEngine.play`), so it is the unit's far-end reference.
enum Chime {
    static let rate = 24_000.0
    static let hz = 1000.0
    static let amplitude = 0.251 // −12 dBFS

    static func chunks(seconds: Double) -> [Data] {
        let framesPerChunk = AudioEngine.chunkBytes / 2
        let total = Int(seconds * rate)
        var out: [Data] = []
        var n = 0
        while n < total {
            var chunk = Data(capacity: AudioEngine.chunkBytes)
            for i in 0 ..< framesPerChunk {
                let t = Double(n + i) / rate
                var s = Int16((sin(2 * .pi * hz * t) * amplitude * 32767).rounded())
                withUnsafeBytes(of: &s) { chunk.append(contentsOf: $0) }
            }
            out.append(chunk)
            n += framesPerChunk
        }
        return out
    }
}

// MARK: - the private-route spike

/// Builds Jarhead's own aggregate (`PrivateRoute`) and offers it to a voice-processing unit on a
/// bare engine: does the unit accept `kAudioOutputUnitProperty_CurrentDevice = jarhead.route`?
/// Printed as `spike:` lines only — green here is what a follow-up flips `PrivateRoute.enabled` on.
@MainActor
final class PrivateSpike {
    private let say: (String) -> Void
    private let engine = AVAudioEngine()

    init(say: @escaping (String) -> Void) { self.say = say }

    func run(_ done: @escaping @MainActor () -> Void) {
        let ranked = MicRanking.rank(MicInputs.enumerate(), explicit: nil, lastUsed: nil, systemDefault: MicInputs.systemDefaultUID())
        guard let mic = ranked.first, let output = AudioDeviceFacts.defaultOutput() else {
            say("spike: no microphone or no default output — nothing to build")
            return done()
        }
        switch PrivateRoute.make(micUID: mic.uid, outputUID: output.uid) {
        case .failure(let err):
            say("spike: AudioHardwareCreateAggregateDevice refused: \(err)")
            done()
        case .success(let route):
            let subs = route.subDevices()
            say("spike: built \(PrivateRoute.uid) = \(output.name) + \(mic.name); subdevices [\(subs.joined(separator: ", "))] \(subs == [output.uid, mic.uid] ? "ok" : "unexpected order")")
            offer(route, output: output, mic: mic, done: done)
        }
    }

    private func offer(_ route: PrivateRoute, output: AudioDeviceFacts, mic: MicInput, done: @escaping @MainActor () -> Void) {
        let input = engine.inputNode
        var selected: String?
        var vpOn = false
        do {
            try objcTry(throwing: {
                try input.setVoiceProcessingEnabled(true)
                guard let au = input.audioUnit else { throw PrivateRoute.RouteError.select(-1) }
                var dev = route.id
                let err = AudioUnitSetProperty(au, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &dev, UInt32(MemoryLayout<AudioDeviceID>.size))
                guard err == noErr else { throw PrivateRoute.RouteError.select(err) }
                input.installTap(onBus: 0, bufferSize: 2048, format: nil) { _, _ in }
                self.engine.prepare()
                try self.engine.start()
                vpOn = input.isVoiceProcessingEnabled
                var back = AudioDeviceID(0)
                var size = UInt32(MemoryLayout<AudioDeviceID>.size)
                if AudioUnitGetProperty(au, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &back, &size) == noErr {
                    selected = AudioEngine.deviceUID(back)
                }
            })
            say("spike: vp on \(vpOn) · CurrentDevice.uid \(selected ?? "nil") \(selected == PrivateRoute.uid ? "ok" : "not the route")")
            say("spike: speaks.rate \(Int(AudioDeviceFacts.defaultOutput()?.rate ?? 0)) Hz · CADefaultDeviceAggregate present \(DeviceTable.aggregates(DeviceTable.snapshot()).isEmpty ? "no" : "yes")")
        } catch {
            say("spike: the unit refused the route: \(error.localizedDescription)")
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { MainActor.assumeIsolated { self.tearDown(route, done: done) } }
    }

    private func tearDown(_ route: PrivateRoute, done: @escaping @MainActor () -> Void) {
        try? objcTry {
            self.engine.inputNode.removeTap(onBus: 0)
            if self.engine.isRunning { self.engine.stop() }
            if self.engine.inputNode.isVoiceProcessingEnabled { try? self.engine.inputNode.setVoiceProcessingEnabled(false) }
        }
        route.destroy()
        say("spike: torn down; \(PrivateRoute.uid) \(AudioEngine.deviceID(matching: PrivateRoute.uid) == nil ? "destroyed" : "STILL PRESENT")")
        done()
    }
}
