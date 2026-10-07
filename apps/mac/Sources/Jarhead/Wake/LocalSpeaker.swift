import AppKit
import AVFoundation

/// The gate's own voice: the system speech synthesiser, entirely on-device. It
/// says only a handful of short things ("Password?", "No.", "Locked for a
/// minute.") while the paid voice model is asleep — and, since design11, an automation's
/// fixed line (`local.say`). One instance for both (`AppState.localSpeaker`):
/// the wake listener ignores words while *this* speaker talks (`isQuiet`), so a spoken
/// "It's seven ten" can never be heard as the wake word — nor while an earcon sounds.
/// Reports whether it is talking.
final class LocalSpeaker: NSObject, AVSpeechSynthesizerDelegate, @unchecked Sendable {
    /// The one speaker: the gate's and the automations' (the echo rail holds because they share it).
    static let shared = LocalSpeaker()
    /// A line starts this long before its earcon's last sample: on the tail, never under the sound.
    static let overlapEarcon = 0.05
    /// Quiet once this long has passed after the last word or the last earcon.
    static let echoTail = 0.35

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

    /// Quiet between utterances and earcons plus a little tail, so a transcript that arrives
    /// right after we stop (or after a sound) is still treated as our own echo.
    func isQuiet(now: Date = Date()) -> Bool {
        LocalSpeaker.isQuiet(speaking: isSpeaking, lastFinishedAt: lastFinishedAt, earconAudibleUntil: EarconWire.shared.audibleUntil, now: now)
    }

    /// Pure, for the check: not speaking, and past the later of the last word and the last earcon by `echoTail`.
    static func isQuiet(speaking: Bool, lastFinishedAt: Date, earconAudibleUntil: Double, now: Date) -> Bool {
        let earcon = Date(timeIntervalSinceReferenceDate: earconAudibleUntil)
        return !speaking && now.timeIntervalSince(max(lastFinishedAt, earcon)) > echoTail
    }

    /// How long a line waits so it starts `overlapEarcon` before the sound's end (0 when nothing sounds).
    static func delay(beforeEarconEnding endsAt: Double, now: Double) -> Double {
        min(3, max(0, endsAt - overlapEarcon - now))
    }

    func speak(_ text: String) {
        let u = AVSpeechUtterance(string: text)
        u.voice = voice
        u.rate = AVSpeechUtteranceDefaultSpeechRate
        u.prefersAssistiveTechnologySettings = false
        // "Touch ID?" after the heard sound, an automation's line after its cue: on the sound's tail, never under it.
        u.preUtteranceDelay = LocalSpeaker.delay(beforeEarconEnding: EarconWire.shared.endsAt, now: CFAbsoluteTimeGetCurrent())
        isSpeaking = true
        synth.speak(u)
    }

    func stop() {
        synth.stopSpeaking(at: .immediate)
        isSpeaking = false
        lastFinishedAt = Date()
    }

    /// The gate's door to the palette (WakeGate is untouched and still names system sounds): its `Pop`
    /// is `heard`, its `Glass` is `awake` (`Earcon.gate`). Through `Earcons`, the one gate, on main.
    func earcon(_ name: String = "Pop") {
        MainActor.assumeIsolated { _ = Earcons.shared.play(Earcon.gate(name)) }
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
    /// The one on-device speaker (design11): the wake gate's prompts and earcons, and an automation's
    /// fixed line, through the same instance — so `WakeGate.handleTranscript`'s `isQuiet` guard covers the
    /// automations' echo too. A computed accessor: Model/ is compiled without Wake/ in the orb harness.
    var localSpeaker: LocalSpeaker { LocalSpeaker.shared }
}
