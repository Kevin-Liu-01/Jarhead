import AVFAudio
import AudioToolbox

/// The voice-processing property writes and their read-back, in both spellings: the
/// AVFAudio properties (macOS 14) and the raw AU property for the probe's cross-check.
/// Everything here runs while the engine is stopped, inside the caller's `objcTry`
/// (AVFAudio raises when it dislikes the node's state; a raise must stay a caught
/// attempt failure).
enum VoiceProcessingKnobs {
    /// kAUVoiceIOProperty_OtherAudioDuckingConfiguration = 2108, global scope, 8 bytes:
    /// `{ Boolean mEnableAdvancedDucking; UInt32 mDuckingLevel }` (AUP:2707-2724).
    struct RawDucking {
        var advanced: UInt8 = 1
        var pad: (UInt8, UInt8, UInt8) = (0, 0, 0)
        var level: UInt32 = 10
    }

    static let duckingSelector: AudioUnitPropertyID = 2108

    /// What the input node read back: the ducking pair, AGC and bypass.
    struct Readback: Equatable {
        var duckLevel: UInt32
        var advanced: Bool
        var agc: Bool
        var bypassed: Bool
    }

    /// Ducking (level + advanced), AGC and bypass — set explicitly so the state is known,
    /// not assumed. Only meaningful once `setVoiceProcessingEnabled(true)` has run.
    static func apply(_ p: VoiceProcessingPolicy, to input: AVAudioInputNode) {
        var cfg = AVAudioVoiceProcessingOtherAudioDuckingConfiguration()
        cfg.enableAdvancedDucking = ObjCBool(p.advancedDucking)   // a C struct field: BOOL imports as ObjCBool
        let level = AVAudioVoiceProcessingOtherAudioDuckingConfiguration.Level(rawValue: Int(p.duckLevel))
        cfg.duckingLevel = level ?? .min
        input.voiceProcessingOtherAudioDuckingConfiguration = cfg
        input.isVoiceProcessingAGCEnabled = p.agc
        input.isVoiceProcessingBypassed = p.bypass
    }

    /// The Swift-side view of the knobs.
    static func read(_ input: AVAudioInputNode) -> Readback {
        let cfg = input.voiceProcessingOtherAudioDuckingConfiguration
        let level = UInt32(max(0, cfg.duckingLevel.rawValue))
        return Readback(duckLevel: level, advanced: cfg.enableAdvancedDucking.boolValue, agc: input.isVoiceProcessingAGCEnabled, bypassed: input.isVoiceProcessingBypassed)
    }

    /// One status line with both spellings, for run.log and the probe:
    /// `voice processing knobs: duck 10 advanced true, agc true, bypass false · raw 2108 duck 10 advanced true`
    /// (`raw 2108 n/a` when the unit has no such property). Inside the caller's `objcTry`.
    static func readbackLine(_ input: AVAudioInputNode) -> String {
        let swift = read(input)
        let head = "voice processing knobs: duck \(swift.duckLevel) advanced \(swift.advanced), agc \(swift.agc), bypass \(swift.bypassed)"
        let rawWord: String
        if let raw = readRawDucking(input) {
            rawWord = "raw 2108 duck \(raw.level) advanced \(raw.advanced)"
        } else {
            rawWord = "raw 2108 n/a"
        }
        return "\(head) · \(rawWord)"
    }

    /// The raw AU view, for the probe's cross-check: (advanced, level), or nil when the
    /// unit has no such property (voice processing off, or no audio unit yet).
    static func readRawDucking(_ input: AVAudioInputNode) -> (advanced: Bool, level: UInt32)? {
        guard let au = input.audioUnit else { return nil }
        var raw = RawDucking()
        var size = UInt32(MemoryLayout<RawDucking>.size)
        let err = AudioUnitGetProperty(au, duckingSelector, kAudioUnitScope_Global, 0, &raw, &size)
        guard err == noErr else { return nil }
        return (raw.advanced != 0, raw.level)
    }
}
