import AVFoundation
import CoreAudio
import Foundation

// Throwaway harness (design12 § Verification V2): how much the voice-processing unit ducks
// OTHER apps, as a figure. Not part of the package; compiled only by Scripts/duck-leak-probe.sh.
// LAST and droppable: nothing else depends on it.
//
// Two processes, one generated tone. This probe writes a 20 s 1 kHz −20 dBFS WAV into .build/,
// spawns `afplay` on it, opens a Core Audio process tap on that pid (`AudioHardwareCreateProcessTap`,
// macOS 14.2 — `#available`-guarded; skipped with a line below it) inside a private aggregate
// device and logs the tapped RMS per second; Jarhead's graph comes up at t = 5 s in mode M and
// goes down at t = 15 s. Reports ΔdB = level[6…14] − level[1…4] for
//   aec-default        the unit as Apple ships it (duck level 0 · advanced off) — today's behaviour
//   aec-min-advanced   design12's constant (`VoiceProcessingPolicy.aec`: min · advanced)
//   aec-min-plain      min · advanced off (the alternative constant; the smaller step wins)
//   recording          no unit — expected 0 dB
// If no mode steps at all the tap sits before the duck (`tap is pre-duck — measure at the device`).
//
// PLAYS SOUND: needs AUDIO_PROBE_PLAY=1; without it the plan is printed and the exit is 0. A process
// tap needs the system-audio-recording grant, asked of the launching terminal. Nothing connects to
// the daemon; nothing opens a session; nothing is paid.
//   DUCK_LEAK_MODES=aec-default,aec-min-advanced,aec-min-plain,recording   (default all four; ≈ 20 s each)

@main
struct DuckLeakProbeMain {
    static func main() {
        setlinebuf(stdout)
        MainActor.assumeIsolated { DuckLeakProbe.shared.begin() }
        RunLoop.main.run()
    }
}

enum DuckLeakWords {
    static let toneSeconds = 20.0
    static let toneHz = 1000.0
    static let toneAmplitude = 0.1 // −20 dBFS
    static let stepDb = 0.5
    static let preDuck = "tap is pre-duck — measure at the device (record the speakers with the iPhone continuity mic across modes)"
    static let plan = "would: write a 20 s 1 kHz −20 dBFS WAV · afplay it · tap afplay's output (macOS 14.2 process tap) · Jarhead's graph up 5→15 s per mode · report ΔdB per mode"
}

/// One mode of the ladder the probe measures: a name and the policy the engine is told.
struct LeakMode {
    var name: String
    var policy: VoiceProcessingPolicy

    static let all: [LeakMode] = [
        LeakMode(name: "aec-default", policy: VoiceProcessingPolicy(echoCancel: true, duckLevel: 0, advancedDucking: false)),
        LeakMode(name: "aec-min-advanced", policy: .aec),
        LeakMode(name: "aec-min-plain", policy: VoiceProcessingPolicy(echoCancel: true, duckLevel: 10, advancedDucking: false)),
        LeakMode(name: "recording", policy: .recording),
    ]

    static func pick(_ names: String?) -> [LeakMode] {
        guard let names, !names.isEmpty else { return all }
        let wanted = names.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        return all.filter { wanted.contains($0.name) }
    }
}

// MARK: - the tone

enum Tone {
    /// A mono 48 kHz Int16 WAV of `seconds` at 1 kHz, −20 dBFS.
    static func write(to url: URL, seconds: Double) -> Bool {
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: 48_000.0,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
        ]
        guard let file = try? AVAudioFile(forWriting: url, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false),
              let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: 1, interleaved: false) else { return false }
        let frames = AVAudioFrameCount(seconds * 48_000)
        guard let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames), let ch = buf.floatChannelData?[0] else { return false }
        for i in 0 ..< Int(frames) { ch[i] = Float(sin(2 * .pi * DuckLeakWords.toneHz * Double(i) / 48_000) * DuckLeakWords.toneAmplitude) }
        buf.frameLength = frames
        return (try? file.write(from: buf)) != nil
    }
}

// MARK: - the tap (macOS 14.2)

/// A private process tap on one pid inside a private aggregate, with an IOProc that sums energy
/// per second. Every Core Audio call is a plain OSStatus; a failure is a nil, never a raise.
final class ProcessTap: @unchecked Sendable {
    private(set) var tapID = AudioObjectID(0)
    private(set) var aggregateID = AudioObjectID(0)
    private var procID: AudioDeviceIOProcID?
    private let lock = NSLock()
    private var energy = 0.0
    private var frames = 0
    private(set) var levels: [(t: Int, dbfs: Double)] = []
    private var tick = 0
    private var timer: Timer?

    /// The HAL's process object for `pid`, or nil.
    static func processObject(pid: pid_t) -> AudioObjectID? {
        var addr = CoreAudioReads.address(kAudioHardwarePropertyTranslatePIDToProcessObject)
        var object = AudioObjectID(0)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        var q = pid
        let err = withUnsafePointer(to: &q) { AudioObjectGetPropertyData(CoreAudioReads.system, &addr, UInt32(MemoryLayout<pid_t>.size), $0, &size, &object) }
        return err == noErr && object != 0 ? object : nil
    }

    /// Create the tap and its aggregate; returns the failing step's words, or nil.
    func open(pid: pid_t, outputUID: String) -> String? {
        guard #available(macOS 14.2, *) else { return "process taps need macOS 14.2 (skipped)" }
        guard let object = ProcessTap.processObject(pid: pid) else { return "no process object for pid \(pid)" }
        let description = CATapDescription(stereoMixdownOfProcesses: [object])
        description.name = "jarhead.duck-leak"
        description.isPrivate = true
        description.muteBehavior = .unmuted
        var tap = AudioObjectID(0)
        let made = AudioHardwareCreateProcessTap(description, &tap)
        guard made == noErr, tap != 0 else { return "AudioHardwareCreateProcessTap \(made)" }
        tapID = tap
        let desc: [String: Any] = [
            kAudioAggregateDeviceUIDKey: "jarhead.duck-leak.aggregate",
            kAudioAggregateDeviceNameKey: "duck-leak",
            kAudioAggregateDeviceIsPrivateKey: 1,
            kAudioAggregateDeviceIsStackedKey: 0,
            kAudioAggregateDeviceTapAutoStartKey: 1,
            kAudioAggregateDeviceMainSubDeviceKey: outputUID,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
            kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: description.uuid.uuidString, kAudioSubTapDriftCompensationKey: 1]],
        ]
        var agg = AudioObjectID(0)
        let built = AudioHardwareCreateAggregateDevice(desc as CFDictionary, &agg)
        guard built == noErr, agg != 0 else { return "AudioHardwareCreateAggregateDevice \(built)" }
        aggregateID = agg
        return startProc()
    }

    private func startProc() -> String? {
        var proc: AudioDeviceIOProcID?
        let err = AudioDeviceCreateIOProcIDWithBlock(&proc, aggregateID, nil) { [weak self] _, inInput, _, _, _ in
            self?.note(inInput)
        }
        guard err == noErr, let proc else { return "AudioDeviceCreateIOProcIDWithBlock \(err)" }
        procID = proc
        let started = AudioDeviceStart(aggregateID, proc)
        guard started == noErr else { return "AudioDeviceStart \(started)" }
        let t = Timer(timeInterval: 1.0, repeats: true) { [weak self] _ in self?.second() }
        RunLoop.main.add(t, forMode: .default)
        timer = t
        return nil
    }

    /// The tap's buffers are Float32 (the tap's own format); every channel counts.
    private func note(_ list: UnsafePointer<AudioBufferList>) {
        let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: list))
        var acc = 0.0
        var n = 0
        for b in buffers {
            guard let data = b.mData else { continue }
            let count = Int(b.mDataByteSize) / MemoryLayout<Float>.size
            let p = data.assumingMemoryBound(to: Float.self)
            for i in 0 ..< count { acc += Double(p[i] * p[i]) }
            n += count
        }
        lock.lock()
        energy += acc.isFinite ? acc : 0
        frames += n
        lock.unlock()
    }

    private func second() {
        lock.lock()
        let rms = frames > 0 ? (energy / Double(frames)).squareRoot() : 0
        energy = 0
        frames = 0
        lock.unlock()
        tick += 1
        levels.append((tick, ProcessTap.dbfs(rms)))
    }

    static func dbfs(_ rms: Double) -> Double {
        guard rms.isFinite, rms > 0 else { return -120 }
        return max(-120, (20 * log10(rms) * 10).rounded() / 10)
    }

    func close() {
        timer?.invalidate()
        timer = nil
        if let procID, aggregateID != 0 {
            _ = AudioDeviceStop(aggregateID, procID)
            _ = AudioDeviceDestroyIOProcID(aggregateID, procID)
        }
        procID = nil
        if aggregateID != 0 { _ = AudioHardwareDestroyAggregateDevice(aggregateID) }
        aggregateID = 0
        if #available(macOS 14.2, *), tapID != 0 { _ = AudioHardwareDestroyProcessTap(tapID) }
        tapID = 0
    }

    /// Mean dBFS over the seconds `range` (1-based ticks).
    func level(_ range: ClosedRange<Int>) -> Double? {
        let picked = levels.filter { range.contains($0.t) }.map(\.dbfs)
        guard !picked.isEmpty else { return nil }
        return ((picked.reduce(0, +) / Double(picked.count)) * 10).rounded() / 10
    }
}

// MARK: - the probe

@MainActor
final class DuckLeakProbe {
    static let shared = DuckLeakProbe()

    private let env = ProcessInfo.processInfo.environment
    private let t0 = Date()
    private var modes: [LeakMode] = []
    private var results: [(String, Double?)] = []
    private var engine: AudioEngine?
    private var tap: ProcessTap?
    private var player: Process?
    private let toneURL = URL(fileURLWithPath: ".build/duck-leak-probe/tone.wav")

    private func stamp() -> String { String(format: "+%6.3f", Date().timeIntervalSince(t0)) }
    private func say(_ s: String) { print("\(stamp())  \(s)") }
    private func at(_ seconds: Double, _ body: @escaping @MainActor () -> Void) {
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { MainActor.assumeIsolated(body) }
    }

    func begin() {
        modes = LeakMode.pick(env["DUCK_LEAK_MODES"])
        say("duck-leak-probe: modes \(modes.map(\.name).joined(separator: ", ")) · default output \(AudioDeviceFacts.defaultOutput()?.text ?? "none")")
        guard env["AUDIO_PROBE_PLAY"] == "1" else {
            say("dry run: \(DuckLeakWords.plan) — set AUDIO_PROBE_PLAY=1 to run it")
            exit(0)
        }
        guard #available(macOS 14.2, *) else {
            say("process taps need macOS 14.2 — skipped; \(DuckLeakWords.preDuck)")
            exit(0)
        }
        try? FileManager.default.createDirectory(at: toneURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard Tone.write(to: toneURL, seconds: DuckLeakWords.toneSeconds) else {
            say("could not write the tone")
            exit(2)
        }
        say("tone: \(toneURL.path) (\(Int(DuckLeakWords.toneSeconds)) s, 1 kHz, −20 dBFS)")
        nextMode()
    }

    private func nextMode() {
        guard !modes.isEmpty else { return finish() }
        let mode = modes.removeFirst()
        say("== \(mode.name): \(mode.policy.echoCancel ? mode.policy.knobsDescription : "no unit")")
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/afplay")
        p.arguments = [toneURL.path]
        do { try p.run() } catch {
            say("afplay failed: \(error.localizedDescription)")
            exit(2)
        }
        player = p
        let tap = ProcessTap()
        self.tap = tap
        // afplay opens its output a moment after launch; the HAL needs the process object to exist.
        at(0.5) { [weak self] in
            guard let self else { return }
            if let why = tap.open(pid: p.processIdentifier, outputUID: AudioDeviceFacts.defaultOutput()?.uid ?? "") {
                self.say("tap: \(why)")
                p.terminate()
                self.results.append((mode.name, nil))
                return self.at(1) { [weak self] in self?.nextMode() }
            }
            self.say("tap: on afplay pid \(p.processIdentifier), aggregate \(tap.aggregateID)")
        }
        at(5) { [weak self] in self?.graphUp(mode) }
        at(15) { [weak self] in self?.graphDown() }
        at(19) { [weak self] in self?.endMode(mode) }
    }

    private func graphUp(_ mode: LeakMode) {
        let engine = AudioEngine()
        self.engine = engine
        engine.onStatus = { [weak self] line in
            guard line.hasPrefix("audio running") || line.hasPrefix("voice processing knobs") || line.hasPrefix("audio start") else { return }
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.say("engine: \(line)") } }
        }
        engine.setPolicy(mode.policy)
        engine.start()
        say("graph up (\(mode.name))")
    }

    private func graphDown() {
        engine?.stop()
        say("graph down")
    }

    private func endMode(_ mode: LeakMode) {
        player?.terminate()
        player = nil
        engine = nil
        guard let tap else { return }
        let before = tap.level(1 ... 4), during = tap.level(6 ... 14), after = tap.level(16 ... 18)
        tap.close()
        self.tap = nil
        let beforeWord = before.map { "\($0)" } ?? "—"
        let duringWord = during.map { "\($0)" } ?? "—"
        let afterWord = after.map { "\($0)" } ?? "—"
        guard let before, let during else {
            say("\(mode.name): no tapped levels (before \(beforeWord), during \(duringWord))")
            results.append((mode.name, nil))
            return at(1) { [weak self] in self?.nextMode() }
        }
        let delta = ((during - before) * 10).rounded() / 10
        say("\(mode.name): tone alone \(before) dBFS · with the graph \(during) dBFS · after \(afterWord) · ΔdB \(delta)")
        results.append((mode.name, delta))
        at(1) { [weak self] in self?.nextMode() }
    }

    private func finish() {
        say("== results")
        for (name, delta) in results {
            let word = delta.map { "ΔdB \($0)" } ?? "not measured"
            say("  \(name): \(word)")
        }
        let measured = results.compactMap { $0.1 }
        if !measured.isEmpty, measured.allSatisfy({ abs($0) < DuckLeakWords.stepDb }) {
            say(DuckLeakWords.preDuck)
        } else if let rec = results.first(where: { $0.0 == "recording" })?.1 {
            say("recording: \(abs(rec) < DuckLeakWords.stepDb ? "0 dB — other apps untouched" : "ΔdB \(rec) — something still ducks without the unit")")
        }
        let advanced = results.first { $0.0 == "aec-min-advanced" }?.1
        let plain = results.first { $0.0 == "aec-min-plain" }?.1
        if let advanced, let plain {
            say("constant: \(abs(advanced) <= abs(plain) ? "advanced (ΔdB \(advanced)) is the smaller step — keep VoiceProcessingPolicy.advancedDucking = true" : "plain (ΔdB \(plain)) is the smaller step — flip VoiceProcessingPolicy.advancedDucking to false")")
        }
        at(0.3) { exit(0) }
    }
}
