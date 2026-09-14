import AVFoundation
import Combine
import Foundation
import Speech

// Throwaway harness: runs the on-device ear on the built-in microphone for a few
// seconds without the app or the daemon, and prints every partial with timestamps.
// Not part of the package; compiled only by Scripts/ear-probe.sh.
//   EAR_PROBE_SECONDS=10          how long to listen (default 10)
//   EAR_PROBE_SAY="scroll down"   speak this through the speakers 2 s in (`/usr/bin/say`);
//                                 with the Mac muted nothing reaches the microphone
//   EAR_PROBE_FILE=/path.aiff     instead of the microphone, feed this file into the ear the
//                                 way the tap would (100 ms buffers, one every 100 ms, stamped
//                                 with capture time) — mute-independent; make one with
//                                 `say -o /tmp/scroll.aiff "scroll down"`
//   EAR_PROBE_PHASE=listening     the fake snapshot phase (paused / muted show the ear staying off)
//   EAR_PROBE_REFLEXES=0          settings.reflexes off (the ear must stay off)
// Every partial prints as
//   +1.234  partial #1 "scroll down"  at=<ms since epoch>  held=<ms the throttle delayed it>
// the ear's own "ear: on-device partial latency …" line lands on stderr every 2 s, and the
// end shows the end-to-end numbers: when the phrase started/finished playing and when the
// first partial carrying its first word / the whole phrase arrived.

@main
struct EarProbeMain {
    static func main() {
        setlinebuf(stdout)
        MainActor.assumeIsolated { Probe.shared.begin() }
        RunLoop.main.run()
    }
}

/// Counters and end-to-end timestamps touched from the tap thread, the ear queue, the
/// file feeder and `say`'s termination handler; every access under `lock`.
final class Tally: @unchecked Sendable {
    let lock = NSLock()
    var buffers = 0
    var firstBufferDescribed = false
    var partials = 0
    var finals = 0
    var phrase: String?
    var speechStartedAt: Date?
    var speechEndedAt: Date?
    var firstWordAt: Date?
    var fullPhraseAt: Date?
}

@MainActor
final class Probe {
    static let shared = Probe()

    private let t0 = Date()
    private let env = ProcessInfo.processInfo.environment
    private var state: AppState!
    private var audio: AudioEngine?
    private var ear: ReflexEar!
    private let tally = Tally()
    private var fileFeeder: DispatchSourceTimer?

    private func stamp() -> String { String(format: "+%6.3f", Date().timeIntervalSince(t0)) }
    private func rel(_ d: Date) -> String { String(format: "+%6.3f", d.timeIntervalSince(t0)) }
    func say(_ s: String) { print("\(stamp())  \(s)") }

    /// `EAR_PROBE_NO_PROMPT=1`: never ask TCC; an undecided grant leaves the ear off and the
    /// probe still shows the microphone → ear buffer path and the gating.
    private var mayPrompt: Bool { env["EAR_PROBE_NO_PROMPT"] != "1" }

    func begin() {
        EarListener.logsLatency = true
        EarListener.latencyLogInterval = 2

        let usage = Bundle.main.infoDictionary?["NSSpeechRecognitionUsageDescription"] as? String
        say("Bundle.main: \(Bundle.main.bundleIdentifier ?? "no bundle id"), speech usage string \(usage == nil ? "MISSING" : "present")")
        let (speechOK, speechDetail) = WakeWordListener.currentAuthorization()
        say("speech recognition: \(speechDetail)")
        if !speechOK, SFSpeechRecognizer.authorizationStatus() == .notDetermined, mayPrompt {
            say("asking for Speech Recognition (the prompt names the responsible process)…")
            WakeWordListener.requestAuthorization { [weak self] ok, detail in
                self?.say("speech recognition: \(detail)")
                self?.checkMicrophone()
            }
            return
        }
        checkMicrophone()
    }

    private func checkMicrophone() {
        if env["EAR_PROBE_FILE"] != nil {
            say("microphone: not used (EAR_PROBE_FILE)")
            start()
            return
        }
        let status = AVCaptureDevice.authorizationStatus(for: .audio)
        switch status {
        case .authorized:
            say("microphone: granted")
            start()
        case .notDetermined where !mayPrompt:
            // Starting the engine would raise the system's own mic prompt and block until it is answered.
            say("microphone: not decided (EAR_PROBE_NO_PROMPT=1, not asking; the audio engine stays off — use EAR_PROBE_FILE to exercise the ear without it)")
            start(withMicrophone: false)
        case .notDetermined:
            say("asking for the microphone…")
            AVCaptureDevice.requestAccess(for: .audio) { ok in
                DispatchQueue.main.async { MainActor.assumeIsolated {
                    self.say("microphone: \(ok ? "granted" : "denied")")
                    self.start()
                } }
            }
        default:
            say("microphone: denied/restricted (\(status.rawValue)) — the audio engine will report what it can")
            start()
        }
    }

    private func start(withMicrophone: Bool = true) {
        let phase = Phase(rawValue: env["EAR_PROBE_PHASE"] ?? "listening") ?? .listening
        let seconds = Double(env["EAR_PROBE_SECONDS"] ?? "") ?? 10
        state = AppState()
        state.connected = true
        state.snapshot.phase = phase
        if env["EAR_PROBE_REFLEXES"] == "0" { state.snapshot.settings.reflexes = false }
        if let p = env["EAR_PROBE_SAY"], !p.isEmpty { tally.phrase = p }
        if tally.phrase == nil, let p = env["EAR_PROBE_PHRASE"], !p.isEmpty { tally.phrase = p }

        let tally = self.tally
        let t0 = self.t0
        ear = ReflexEar(state: state) { text, isFinal, segment, atMs in
            // On the ear queue. `held` is how long the ≤ 20/s throttle kept this one.
            let nowMs = Int((Date().timeIntervalSince1970 * 1000).rounded())
            let at = Date(timeIntervalSince1970: Double(atMs) / 1000)
            tally.lock.lock()
            if isFinal { tally.finals += 1 } else { tally.partials += 1 }
            if let phrase = tally.phrase {
                let heard = text.lowercased()
                let words = phrase.lowercased().split(separator: " ").map(String.init)
                if tally.firstWordAt == nil, let w = words.first, heard.contains(w) { tally.firstWordAt = at }
                if tally.fullPhraseAt == nil, heard.contains(phrase.lowercased()) { tally.fullPhraseAt = at }
            }
            tally.lock.unlock()
            let t = String(format: "+%6.3f", at.timeIntervalSince(t0))
            print("\(t)  \(isFinal ? "FINAL  " : "partial") #\(segment) \"\(text)\"  at=\(atMs)  held=\(nowMs - atMs) ms")
        }
        let ear = self.ear!
        let onBuffer: (AVAudioPCMBuffer, AVAudioTime) -> Void = { buffer, when in
            ear.ingest(buffer, at: when)
            tally.lock.lock()
            tally.buffers += 1
            let first = !tally.firstBufferDescribed
            tally.firstBufferDescribed = true
            tally.lock.unlock()
            if first {
                let desc = "\(Int(buffer.format.sampleRate)) Hz ×\(buffer.format.channelCount) \(buffer.format.commonFormat == .pcmFormatFloat32 ? "Float32" : "?") \(buffer.frameLength) frames/buffer (\(Int(Double(buffer.frameLength) / buffer.format.sampleRate * 1000)) ms), hostTime \(when.isHostTimeValid ? "valid" : "INVALID")"
                DispatchQueue.main.async { MainActor.assumeIsolated { Probe.shared.say("first buffer for the ear: \(desc)") } }
            }
        }

        say("phase \(phase.rawValue), reflexes \(state.snapshot.settings.reflexes ? "on" : "off"); listening for \(Int(seconds)) s")
        if let path = env["EAR_PROBE_FILE"] {
            feedFile(path, onBuffer: onBuffer)
        } else if !withMicrophone {
            say("audio engine not started (microphone grant undecided)")
        } else {
            let audio = AudioEngine()
            audio.onStatus = { [weak self] text in
                DispatchQueue.main.async { MainActor.assumeIsolated { self?.say("audio: \(text)") } }
            }
            audio.onMicBuffer = onBuffer
            self.audio = audio
            audio.start()
            if let phrase = tally.phrase {
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                    MainActor.assumeIsolated { self.speak(phrase) }
                }
            }
        }
        ear.setVoiceAudioActive(true)
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) {
            MainActor.assumeIsolated { self.finish() }
        }
    }

    /// Play `path` into the ear the way the tap would: mono Float32 at the file's rate,
    /// 100 ms per buffer, one buffer every 100 ms, each stamped with the host time its
    /// audio "was captured" (100 ms before delivery), after 1 s of silence so the
    /// recogniser is warm. The phrase is taken to start at the first buffer of the file
    /// and to end at its last, for the end-to-end numbers.
    private func feedFile(_ path: String, onBuffer: @escaping (AVAudioPCMBuffer, AVAudioTime) -> Void) {
        guard let file = try? AVAudioFile(forReading: URL(fileURLWithPath: path)) else {
            say("EAR_PROBE_FILE: cannot open \(path)")
            return
        }
        let rate = file.processingFormat.sampleRate
        guard let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false),
              let whole = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)),
              (try? file.read(into: whole)) != nil else {
            say("EAR_PROBE_FILE: cannot read \(path)")
            return
        }
        let frames = Int(whole.frameLength)
        let chunk = Int(rate / 10)
        let leadIn = 10 // 1 s of silence first
        let total = leadIn + (frames + chunk - 1) / chunk
        say("file: \(path) — \(String(format: "%.2f", Double(frames) / rate)) s at \(Int(rate)) Hz ×\(file.processingFormat.channelCount), fed as \(total - leadIn) buffers of \(chunk) frames after 1 s of silence")
        var index = 0
        let src = whole.floatChannelData
        let tally = self.tally
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "ear-probe.feeder", qos: .userInteractive))
        timer.schedule(deadline: .now() + 0.1, repeating: 0.1, leeway: .milliseconds(1))
        timer.setEventHandler {
            guard index < total else { return }
            let i = index
            index += 1
            guard let buf = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: AVAudioFrameCount(chunk)), let dst = buf.floatChannelData?[0] else { return }
            var n = chunk
            if i >= leadIn, let src {
                let start = (i - leadIn) * chunk
                n = min(chunk, frames - start)
                for k in 0 ..< n { dst[k] = src[0][start + k] }
                for k in n ..< chunk { dst[k] = 0 }
                n = chunk
            } else {
                for k in 0 ..< chunk { dst[k] = 0 }
            }
            buf.frameLength = AVAudioFrameCount(n)
            // "Captured" 100 ms ago: the tap hands a buffer over once it is full.
            let capturedStart = mach_absolute_time() &- AVAudioTime.hostTime(forSeconds: 0.1)
            let now = Date()
            tally.lock.lock()
            if i == leadIn { tally.speechStartedAt = now.addingTimeInterval(-0.1) }
            if i == total - 1 { tally.speechEndedAt = now }
            tally.lock.unlock()
            onBuffer(buf, AVAudioTime(hostTime: capturedStart))
        }
        timer.resume()
        fileFeeder = timer
    }

    private func speak(_ phrase: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/say")
        p.arguments = [phrase]
        let tally = self.tally
        p.terminationHandler = { _ in
            tally.lock.lock()
            tally.speechEndedAt = Date()
            tally.lock.unlock()
        }
        do {
            try p.run()
            tally.lock.lock()
            tally.speechStartedAt = Date()
            tally.lock.unlock()
            say("say \"\(phrase)\" (through the speakers; muted output never reaches the microphone)")
        } catch {
            say("say failed: \(error.localizedDescription)")
        }
    }

    private func finish() {
        ear.setVoiceAudioActive(false)
        audio?.stop()
        fileFeeder?.cancel()
        tally.lock.lock()
        let b = tally.buffers, p = tally.partials, f = tally.finals
        let phrase = tally.phrase
        let started = tally.speechStartedAt, ended = tally.speechEndedAt, first = tally.firstWordAt, full = tally.fullPhraseAt
        tally.lock.unlock()
        say("done: \(b) buffers ingested, \(p) partials + \(f) finals sent, ear listening = \(ear.isListening)")
        if b == 0 { say("no buffers: nothing fed the ear (the audio engine never ran — see the audio: lines above — or the file could not be read)") }
        if b > 0, p + f == 0 { say("buffers flowed but no partials: nothing intelligible reached the ear (muted speakers?), or the recogniser is off (see Ear: lines on stderr)") }
        if let phrase, let started {
            func ms(_ a: Date?, _ b: Date?) -> String {
                guard let a, let b else { return "—" }
                return String(format: "%.0f ms", b.timeIntervalSince(a) * 1000)
            }
            say("end-to-end for \"\(phrase)\": speech started \(rel(started)), finished \(ended.map(rel) ?? "—")")
            say("  first partial with its first word: \(first.map(rel) ?? "never")  (\(ms(started, first)) after speech started)")
            say("  first partial with the whole phrase: \(full.map(rel) ?? "never")  (\(ms(ended, full)) after speech finished; negative = before `say`/the file ended)")
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { exit(0) }
    }
}
