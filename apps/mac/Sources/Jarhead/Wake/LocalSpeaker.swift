import AppKit
import AVFoundation

/// The gate's own voice: the system speech synthesiser, entirely on-device. It
/// says only a handful of short things ("Password?", "No.", "Locked for a
/// minute.") while the paid voice model is asleep — and, since design11, an automation's
/// fixed line and its chime (`local.say`). One instance for both (`AppState.localSpeaker`):
/// the wake listener ignores words while *this* speaker talks (`isQuiet`), so a spoken
/// "It's seven ten" can never be heard as the wake word. Reports whether it is talking.
final class LocalSpeaker: NSObject, AVSpeechSynthesizerDelegate, @unchecked Sendable {
    /// The one speaker: the gate's and the automations' (the echo rail holds because they share it).
    static let shared = LocalSpeaker()
    /// The earcons an automation may name (`chime.sound`); anything else is `Pop`.
    static let earcons: Set<String> = ["Pop", "Glass", "Ping", "Hero"]

    private let synth = AVSpeechSynthesizer()
    private let voice: AVSpeechSynthesisVoice?
    /// Read and written on the main thread only (the delegate hops there).
    private(set) var isSpeaking = false
    private(set) var lastFinishedAt: Date = .distantPast

    override init() {
        voice = LocalSpeaker.bestVoice()
        super.init()
        synth.delegate = self
    }

    /// Quiet between utterances plus a little tail, so a transcript that arrives
    /// right after we stop is still treated as our own echo.
    func isQuiet(now: Date = Date()) -> Bool {
        !isSpeaking && now.timeIntervalSince(lastFinishedAt) > 0.35
    }

    func speak(_ text: String) {
        let u = AVSpeechUtterance(string: text)
        u.voice = voice
        u.rate = AVSpeechUtteranceDefaultSpeechRate
        u.prefersAssistiveTechnologySettings = false
        isSpeaking = true
        synth.speak(u)
    }

    func stop() {
        synth.stopSpeaking(at: .immediate)
        isSpeaking = false
        lastFinishedAt = Date()
    }

    /// A short system sound for "heard you" / "welcome back" / an automation's chime, no
    /// words needed: `Pop` · `Glass` · `Ping` · `Hero` (an unknown name is `Pop`).
    func earcon(_ name: String = "Pop") {
        let sound = LocalSpeaker.earcons.contains(name) ? name : "Pop"
        NSSound(named: NSSound.Name(sound))?.play()
    }

    /// The best installed English voice: premium, then enhanced, then whatever exists.
    static func bestVoice() -> AVSpeechSynthesisVoice? {
        let english = AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix("en") }
        func rank(_ v: AVSpeechSynthesisVoice) -> Int {
            var score = 0
            switch v.quality {
            case .premium: score += 300
            case .enhanced: score += 200
            default: score += 100
            }
            if v.language == "en-US" { score += 10 }
            return score
        }
        return english.max { rank($0) < rank($1) } ?? AVSpeechSynthesisVoice(language: "en-US")
    }

    // MARK: AVSpeechSynthesizerDelegate

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        let still = synthesizer.isSpeaking
        DispatchQueue.main.async { self.isSpeaking = still; self.lastFinishedAt = Date() }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        let still = synthesizer.isSpeaking
        DispatchQueue.main.async { self.isSpeaking = still; self.lastFinishedAt = Date() }
    }
}

extension AppState {
    /// The one on-device speaker (design11): the wake gate's prompts and earcons, and an automation's chime and
    /// fixed line, through the same instance — so `WakeGate.handleTranscript`'s `isQuiet` guard covers the
    /// automations' echo too. A computed accessor: Model/ is compiled without Wake/ in the orb harness.
    var localSpeaker: LocalSpeaker { LocalSpeaker.shared }
}
