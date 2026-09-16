import Foundation

/// How mainMixer → output is wired for one start attempt (`AudioEngine.startGraph`).
/// VoiceIO wants input and output on one clock; the wiring is what decides whether the
/// unit initialises, so the ladder tries the plausible ones in turn.
enum OutputWiring: Equatable, CustomStringConvertible {
    /// Let AVAudioEngine wire mainMixer → output itself when the mixer is first touched.
    case automatic
    /// Explicit connection at the input hardware format (VoiceIO runs both sides at one rate).
    case inputRate
    /// Explicit connection at the output hardware format.
    case hardware

    var description: String {
        switch self {
        case .automatic: return "automatic"
        case .inputRate: return "input-rate"
        case .hardware: return "hardware"
        }
    }
}

/// One rung of the start ladder: voice processing on or off, the output wiring, whether the
/// plain input AU is pinned to the ranked microphone (`kAudioOutputUnitProperty_CurrentDevice`
/// — a set that can fail: on a Mac whose default input ≠ default output it knocks the shared
/// I/O unit's output out, −10875 on every wiring, so the last plain rung hears the system
/// default instead), and whether the unit runs on Jarhead's own private aggregate
/// (`PrivateRoute`, probe-only).
struct StartAttempt: Equatable {
    var voice: Bool
    var wiring: OutputWiring
    var pinDevice = false
    var privateRoute = false

    /// `voice processing off, output hardware, ranked mic` — the attempt loop's failure line.
    var description: String {
        guard !voice else { return "voice processing on, output \(wiring)" }
        let mic = pinDevice ? "ranked mic" : "system default mic"
        return "voice processing off, output \(wiring), \(mic)"
    }
}

/// What the input node is told the moment voice processing is switched on. A value, so
/// the probe prints it and check lines pin it. The ducking level is a constant, not a
/// setting: `.min` (10) is the least macOS allows — there is no off — and advanced
/// ducking ducks other apps only while a voice is present.
struct VoiceProcessingPolicy: Equatable {
    /// false = Recording: the plain graph, the ranked microphone and the software echo guard.
    var echoCancel: Bool
    /// AUVoiceIOOtherAudioDuckingLevel: default 0 · min 10 · mid 20 · max 30.
    var duckLevel: UInt32 = 10
    /// Duck only while a voice is present; V2 measures both and this flips if the figure says so.
    var advancedDucking = true
    /// Explicit, printed (Apple's default is on).
    var agc = true
    /// Explicit, printed (Apple's default is off; Mic Mode overrides it anyway, AUP:2629).
    var bypass = false

    static let aec = VoiceProcessingPolicy(echoCancel: true)
    static let recording = VoiceProcessingPolicy(echoCancel: false)

    static func from(recording: Bool) -> VoiceProcessingPolicy { recording ? .recording : .aec }

    /// The ladder `startLocked` walks, top first. Pure; pinned by duck-probe. With echo
    /// cancellation: the three VoiceIO wirings, then the plain graph as the fallback rungs
    /// (guarded) — the ranked mic pinned, then the system default. Recording: the plain rungs
    /// only — hardware and automatic wiring on the ranked mic, then hardware on the system
    /// default (`ranked mic refused; hearing the system default`). The private aggregate adds
    /// two rungs at the top only while `PrivateRoute.enabled` — a follow-up flips it once
    /// V1-private is green.
    var attempts: [StartAttempt] {
        guard echoCancel else { return VoiceProcessingPolicy.plainRungs }
        var rungs: [StartAttempt] = []
        if PrivateRoute.enabled {
            rungs.append(StartAttempt(voice: true, wiring: .automatic, privateRoute: true))
            rungs.append(StartAttempt(voice: true, wiring: .inputRate, privateRoute: true))
        }
        rungs.append(StartAttempt(voice: true, wiring: .automatic))
        rungs.append(StartAttempt(voice: true, wiring: .inputRate))
        rungs.append(StartAttempt(voice: true, wiring: .hardware))
        rungs.append(StartAttempt(voice: false, wiring: .hardware, pinDevice: true))
        rungs.append(StartAttempt(voice: false, wiring: .hardware))
        return rungs
    }

    /// Recording's ladder: plain/hardware and plain/automatic on the ranked mic, then
    /// plain/hardware without the device set (the system default microphone).
    static let plainRungs: [StartAttempt] = [
        StartAttempt(voice: false, wiring: .hardware, pinDevice: true),
        StartAttempt(voice: false, wiring: .automatic, pinDevice: true),
        StartAttempt(voice: false, wiring: .hardware),
    ]

    /// Where `startLocked` begins: the remembered winning rung (0-based), clamped into the
    /// ladder; 0 when nothing is remembered. Pure, for the probe's `winningRung` arithmetic.
    static func firstRung(remembered: Int?, count: Int) -> Int {
        guard count > 0 else { return 0 }
        let clamped = remembered.map { min(max($0, 0), count - 1) }
        return clamped ?? 0
    }

    /// "default" · "min" · "mid" · "max" (or the raw figure).
    var duckLevelWord: String {
        switch duckLevel {
        case 0: return "default"
        case 10: return "min"
        case 20: return "mid"
        case 30: return "max"
        default: return "\(duckLevel)"
        }
    }

    /// The knobs as the status line spells them: `duck min advanced, agc on, bypass off`.
    var knobsDescription: String {
        let duck = advancedDucking ? "duck \(duckLevelWord) advanced" : "duck \(duckLevelWord)"
        let agcWord = agc ? "on" : "off"
        let bypassWord = bypass ? "on" : "off"
        return "\(duck), agc \(agcWord), bypass \(bypassWord)"
    }
}
