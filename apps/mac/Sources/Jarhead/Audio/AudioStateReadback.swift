import CoreAudio
import Foundation

/// One audio device as the HAL describes it right now. `rate` is the nominal sample rate
/// — on a Bluetooth headset it is the hands-free tell: 48 000 while the link is AAC,
/// 16 000 / 8 000 once some process holds the headset microphone. `transport` uses the
/// words `MicInput.transportName` uses ("bluetooth", "built-in", "display", …).
struct AudioDeviceFacts: Equatable {
    var name: String
    var uid: String
    var rate: Double
    var channels: Int
    var transport: String
    /// The output side's volume scalar, 0…1, rounded to 0.01 (`kAudioDevicePropertyVolumeScalar`, the main
    /// element or the mean of the first two channels); nil for an input or a device with no volume control.
    var volume: Double?

    var isBluetooth: Bool { transport == "bluetooth" }

    /// "Kevin's AirPods Pro 24000 Hz ×1 bluetooth" — a log line's worth.
    var text: String { "\(name) \(Int(rate)) Hz ×\(channels) \(transport)" }

    /// Read-only HAL facts for `id`; `scope` picks the input or output stream side for the channel count.
    static func read(id: AudioDeviceID, scope: AudioObjectPropertyScope) -> AudioDeviceFacts? {
        guard id != 0, let uid = AudioEngine.deviceUID(id) else { return nil }
        let name = MicInputs.deviceName(id) ?? uid
        let rate = CoreAudioReads.nominalRate(id)
        let channels = CoreAudioReads.channelCount(id, scope: scope)
        let transport = MicInput.transportName(CoreAudioReads.transport(id))
        let volume = scope == kAudioObjectPropertyScopeOutput ? CoreAudioReads.volumeScalar(id, scope: scope, channels: channels) : nil
        return AudioDeviceFacts(name: name, uid: uid, rate: rate, channels: channels, transport: transport, volume: volume)
    }

    static func defaultInput() -> AudioDeviceFacts? {
        guard let id = CoreAudioReads.defaultDevice(kAudioHardwarePropertyDefaultInputDevice) else { return nil }
        return read(id: id, scope: kAudioObjectPropertyScopeInput)
    }

    static func defaultOutput() -> AudioDeviceFacts? {
        guard let id = CoreAudioReads.defaultDevice(kAudioHardwarePropertyDefaultOutputDevice) else { return nil }
        return read(id: id, scope: kAudioObjectPropertyScopeOutput)
    }
}

// MARK: - playback telemetry (voice PLAN W1.5)

/// The speaker's playout cushion since the graph started, in the frame's units: milliseconds rounded,
/// counts as counts. Built from `PlaybackTelemetry` (Playout.swift).
struct PlayoutReadback: Equatable {
    var chunks = 0
    var underruns = 0
    var underrunMs = 0
    var longestUnderrunMs = 0
    /// The zero-cushion policy's count on the same timeline (`PlayoutModel.Stats.wouldBeUnderruns`).
    var wouldBeUnderruns = 0
    var resets = 0
    var targetMs = 0
    var queuedMs = 0
    /// The smallest backlog this window (since the previous frame went out).
    var queuedMinMs: Int?
    /// The longest wait of a play block on `jarhead.audio`, enqueue to run: this window's, and since the graph started.
    var lateMaxMs = 0
    var lateMaxGraphMs = 0
    /// Chunks that arrived while the graph was down, since the last `start()`.
    var droppedChunks = 0
    var droppedMs = 0
}

/// The duck's last event: no words, only where it came from, how deep it went and how it ended.
struct DuckEventReadback: Equatable {
    var source: String
    var confirmed: Bool
    var depthDb: Double
    /// The mean level of the hot run that tripped the gate, and the threshold it cleared (nil for a silent level).
    var runDbfs: Double?
    var thresholdDbfs: Double?
    var releasedAfterMs: Int?
    var reason: String?
}

/// The barge-in duck since the graph started (`BargeInDuck.telemetry()`); nil on the plain path, where it is detached.
struct DuckReadback: Equatable {
    var ducks = 0
    var gate = 0
    var confirmed = 0
    var unconfirmed = 0
    var held = 0
    var refusedWords = 0
    /// Live items for Kevin refused as confirmation (`BargeInDuck.Stats.refusedLive`).
    var refusedLive = 0
    var wordOnsetsSkipped = 0
    /// Time at a gain under 0.9, and at -14 dB or deeper.
    var duckedMs = 0
    var deepMs = 0
    /// The mic's level while Jarhead is audible and the duck idle (where `echoFloor` learns): the residual echo.
    var residualP50Dbfs: Double?
    var residualP99Dbfs: Double?
    var echoFloorDbfs: Double?
    var last: DuckEventReadback?
}

/// Jarhead's voice on the way out since the graph started: voiced chunks before the duck (`rms`, `peak`) and
/// after its gain (`heardRms`), how much was voiced, the main mixer's connection format, the output volume.
struct OutputReadback: Equatable {
    var rmsDbfs: Double?
    var peakDbfs: Double?
    var heardRmsDbfs: Double?
    var audibleMs = 0
    var mixFormat = ""
    var volume: Double?
}

/// What the engine hands the state reader at each publish, read under the speaker's and the duck's own locks.
struct AudioCounters: Equatable {
    var playout: PlayoutReadback?
    var duck: DuckReadback?
    var output: OutputReadback?
}

/// A level as dBFS rounded to 0.1 (RMS or peak, 0…1); nil for silence or a non-finite level.
func levelDbfs(_ level: Double) -> Double? {
    guard level.isFinite, level > 0 else { return nil }
    return (20 * log10(min(1, level)) * 10).rounded() / 10
}

/// The words the frame and the Console spell the two states with (C's `SettingsWords` pins them).
enum AudioStateWords {
    static let echoCancelled = "echo cancelled"
    static let echoGuarded = "echo guarded"
    static let echoNone = "no echo cancellation"
    static let off = "off"
    static let fullQuality = "full quality"
    static let narrowed = "narrowed"
    /// Below this nominal rate an output is the hands-free codec, not music.
    static let narrowRate = 44_100.0
}

/// The audio graph's state as a value, read back from the nodes and the HAL — not what
/// was asked for, what is. Published through `AudioEngine.onAudioState` on start, stop,
/// route change, guard edges and every 5 s (for the counters), coalesced to changes; the
/// app forwards it to the daemon (`audio-state`) and the island. Strings and numbers only.
struct AudioStateReadback: Equatable {
    var running = false
    /// `input.isVoiceProcessingEnabled`, read after start / after stop.
    var voiceProcessing = false
    /// From `voiceProcessingOtherAudioDuckingConfiguration`; nil when the unit is off.
    var duckLevel: UInt32?
    var advancedDucking: Bool?
    var agc: Bool?
    var bypassed: Bool?
    /// 1-based rung that came up; 0 while stopped.
    var rung = 0
    var wiring = ""
    /// AEC: the system default input; plain: `kAudioOutputUnitProperty_CurrentDevice` on the input AU.
    var hears: AudioDeviceFacts?
    /// The default output — its `rate` is the HFP tell.
    var speaks: AudioDeviceFacts?
    var tapFormat = ""
    /// The policy asked for the plain graph (Settings › Audio › Recording).
    var recording = false
    /// The unit refused every rung and the plain graph runs guarded under an AEC policy.
    var fallback = false
    var guardOn = false
    var guardHeld = false
    var guardTailMs = 0
    var gated = 0
    var chunks = 0
    var breakthroughs = 0
    var heldSeconds = 0.0
    /// Bundle ids of other processes running input on `hears`; nil = the HAL cannot say.
    var sharedWith: [String]?
    /// `AVAudioApplication.shared.isInputMuted`.
    var inputMuted = false
    /// The voice-processing unit's own aggregate (`VPAUAggregateAudioDevice-0x…`) is in the
    /// device list — it appears with the unit and must be gone after stop. This is the field the
    /// wire frame (`AudioState.aggregatePresent`) and the doctor's `released at sleep` read.
    var aggregatePresent = false
    /// AVAudioEngine's own default-device aggregate (`CADefaultDeviceAggregate-<pid>-n`): present
    /// whenever the engine object exists on a Mac whose default input ≠ default output, unit or
    /// no unit. A fact to print, never a pin — not on the wire.
    var engineAggregatePresent = false
    /// Voice PLAN W1.5: the speaker's cushion, the barge-in duck and the output level since the graph
    /// started (`AudioCounters`); nil before the first graph. `output.volume` is the HAL's, from `speaks`.
    var playout: PlayoutReadback?
    var duck: DuckReadback?
    var output: OutputReadback?

    init() {}

    /// `echo cancelled` | `echo guarded` | `no echo cancellation` | `off`.
    var hearsState: String {
        guard running else { return AudioStateWords.off }
        if voiceProcessing { return AudioStateWords.echoCancelled }
        return recording ? AudioStateWords.echoGuarded : AudioStateWords.echoNone
    }

    /// `full quality` (rate ≥ 44 100) | `narrowed` (the hands-free codec); empty when no output is known.
    var speaksState: String {
        guard let speaks else { return "" }
        return speaks.rate >= AudioStateWords.narrowRate ? AudioStateWords.fullQuality : AudioStateWords.narrowed
    }

    /// One log line: the frame as `pnpm jarhead status` would print its first row.
    var summary: String {
        guard running else {
            let engineWord = engineAggregatePresent ? "present" : "gone"
            return "audio state: stopped, voice processing \(voiceProcessing ? "on" : "off"), unit aggregate \(aggregatePresent ? "present" : "gone"), engine aggregate \(engineWord)"
        }
        let vp = voiceProcessing ? "on" : (recording ? "off · recording" : "off · fallback")
        let guardWord = guardOn ? "guard on" : "guard off"
        let hearsText = hears?.text ?? "none"
        let speaksText = speaks?.text ?? "none"
        return "audio state: voice processing \(vp) · \(guardWord) · rung \(rung) \(wiring) · hears \(hearsText) · speaks \(speaksText) · \(speaksState)"
    }
}

/// The two aggregates a running graph can put in the device list, told apart by uid prefix.
enum AudioAggregates {
    /// AVAudioEngine's own default-device aggregate: lives with the engine object (default in ≠ out).
    static let enginePrefix = "CADefaultDeviceAggregate"
    /// The voice-processing unit's aggregate: appears with the unit, must go at stop.
    static let unitPrefix = "VPAUAggregateAudioDevice"

    /// Any device in `kAudioHardwarePropertyDevices` whose uid starts with `prefix`.
    static func present(_ prefix: String) -> Bool {
        AudioEngine.allDeviceIDs().contains { AudioEngine.deviceUID($0)?.hasPrefix(prefix) == true }
    }
}

/// The plain path's device set failed (`AudioEngine.pinInputDevice`) — the rung fails and
/// the ladder moves on to the system default microphone.
enum InputDeviceError: Error, LocalizedError {
    case noUnit
    case select(name: String, status: OSStatus)

    var errorDescription: String? {
        switch self {
        case .noUnit: return "input node has no audio unit"
        case let .select(name, status): return "could not select mic device \(name) (\(status))"
        }
    }
}

/// Small read-only Core Audio getters the read-back is made of. Every call is a plain
/// `AudioObjectGetPropertyData`; a failed read is a zero or a nil, never a throw.
enum CoreAudioReads {
    static let system = AudioObjectID(kAudioObjectSystemObject)

    static func address(_ selector: AudioObjectPropertySelector, scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    }

    static func defaultDevice(_ selector: AudioObjectPropertySelector) -> AudioDeviceID? {
        var id = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var addr = address(selector)
        guard AudioObjectGetPropertyData(system, &addr, 0, nil, &size, &id) == noErr, id != 0 else { return nil }
        return id
    }

    static func nominalRate(_ id: AudioObjectID) -> Double {
        var rate = 0.0
        var size = UInt32(MemoryLayout<Double>.size)
        var addr = address(kAudioDevicePropertyNominalSampleRate)
        guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &rate) == noErr, rate.isFinite else { return 0 }
        return rate
    }

    static func transport(_ id: AudioObjectID) -> UInt32 {
        var value: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        var addr = address(kAudioDevicePropertyTransportType)
        guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value) == noErr else { return 0 }
        return value
    }

    /// Channels across every stream on `scope` (`kAudioDevicePropertyStreamConfiguration`).
    static func channelCount(_ id: AudioObjectID, scope: AudioObjectPropertyScope) -> Int {
        var addr = address(kAudioDevicePropertyStreamConfiguration, scope: scope)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr, size > 0 else { return 0 }
        let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { raw.deallocate() }
        guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, raw) == noErr else { return 0 }
        let list = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
        return list.reduce(0) { $0 + Int($1.mNumberChannels) }
    }

    /// The device's volume scalar on `scope`: the main element when it has one, else the mean of channels 1
    /// and 2 (or 1 alone), rounded to 0.01; nil when no element answers. Read-only.
    static func volumeScalar(_ id: AudioObjectID, scope: AudioObjectPropertyScope, channels: Int) -> Double? {
        func read(_ element: AudioObjectPropertyElement) -> Double? {
            var addr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyVolumeScalar, mScope: scope, mElement: element)
            guard AudioObjectHasProperty(id, &addr) else { return nil }
            var value: Float32 = 0
            var size = UInt32(MemoryLayout<Float32>.size)
            guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value) == noErr, value.isFinite else { return nil }
            return Double(min(1, max(0, value)))
        }
        let raw: Double?
        if let main = read(kAudioObjectPropertyElementMain) {
            raw = main
        } else {
            let each = (1 ... max(1, min(2, channels))).compactMap { read(AudioObjectPropertyElement($0)) }
            raw = each.isEmpty ? nil : each.reduce(0, +) / Double(each.count)
        }
        return raw.map { ($0 * 100).rounded() / 100 }
    }

    static func uint32(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector, scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> UInt32? {
        var value: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        var addr = address(selector, scope: scope)
        guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value) == noErr else { return nil }
        return value
    }

    static func string(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        var addr = address(selector)
        let err = withUnsafeMutablePointer(to: &value) { AudioObjectGetPropertyData(id, &addr, 0, nil, &size, $0) }
        guard err == noErr, let cf = value?.takeRetainedValue() else { return nil }
        return cf as String
    }

    static func objectIDs(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector, scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> [AudioObjectID] {
        var addr = address(selector, scope: scope)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
        var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &ids) == noErr else { return [] }
        return ids
    }
}

/// The HAL's process objects (macOS 14.2 headers; runtime-guarded with
/// `AudioObjectHasProperty`): who else holds a microphone. Read-only.
enum AudioProcessObjects {
    static var listAddress: AudioObjectPropertyAddress { CoreAudioReads.address(kAudioHardwarePropertyProcessObjectList) }

    /// False on a HAL without process objects — the caller says "unknown", never "none".
    static var available: Bool {
        var addr = listAddress
        return AudioObjectHasProperty(CoreAudioReads.system, &addr)
    }

    /// Bundle ids (or `pid:<n>` for a process without one) of other processes running
    /// input on `device`; nil when the HAL cannot say.
    static func sharingInput(on device: AudioDeviceID) -> [String]? {
        guard available else { return nil }
        let me = getpid()
        var out: [String] = []
        for object in CoreAudioReads.objectIDs(CoreAudioReads.system, kAudioHardwarePropertyProcessObjectList) {
            guard let pid = CoreAudioReads.uint32(object, kAudioProcessPropertyPID), pid_t(bitPattern: pid) != me else { continue }
            guard CoreAudioReads.uint32(object, kAudioProcessPropertyIsRunningInput) == 1 else { continue }
            guard CoreAudioReads.objectIDs(object, kAudioProcessPropertyDevices, scope: kAudioObjectPropertyScopeInput).contains(device) else { continue }
            let bundle = CoreAudioReads.string(object, kAudioProcessPropertyBundleID)
            let label = (bundle?.isEmpty == false) ? bundle! : "pid:\(pid)"
            if !out.contains(label) { out.append(label) }
        }
        return out
    }
}
