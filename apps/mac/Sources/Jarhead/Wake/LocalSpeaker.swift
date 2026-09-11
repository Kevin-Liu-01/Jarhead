import AppKit
import AVFoundation

/// The gate's own voice: the system speech synthesiser, entirely on-device. It
/// says only a handful of short things ("Password?", "No.", "Locked for a
/// minute.") while the paid voice model is asleep. Reports whether it is talking so
/// the listener can ignore its own words coming back through the microphone.
final class LocalSpeaker: NSObject, AVSpeechSynthesizerDelegate, @unchecked Sendable {
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

    /// A short system sound for "heard you" / "welcome back", no words needed.
    func earcon(_ name: String = "Pop") {
        NSSound(named: NSSound.Name(name))?.play()
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
