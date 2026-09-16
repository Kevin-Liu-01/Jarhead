import CoreAudio
import Foundation

/// Jarhead's own aggregate device: the default output as the clock, the ranked microphone
/// drift-compensated beside it — so the voice-processing unit could run on the MacBook
/// mic while the AirPods stay the output, instead of following the system default input.
///
/// PROBE-ONLY in this pass: `enabled` is false, so the start ladder never gains its two
/// rungs (`VoiceProcessingPolicy.attempts`). `audio-probe.sh --mode private` builds one
/// and reports whether the unit accepts it on this Mac (design12 § Verification V1-private);
/// a one-line follow-up flips `enabled` once that check is green on Kevin's devices.
/// Private: visible only to this process (never in System Settings, never in another
/// app's device list) and destroyed with the graph. `uid` is stable so a survivor from a
/// crash is found and destroyed before a new one is made.
struct PrivateRoute: Equatable {
    static let enabled = false
    static let uid = "jarhead.route"
    static let name = "Jarhead"

    /// The raw key strings, spelled out beside the SDK constants (CI's older SDK may lack a spelling).
    enum Key {
        static let uid = "uid"               // kAudioAggregateDeviceUIDKey
        static let name = "name"             // kAudioAggregateDeviceNameKey
        static let subDevices = "subdevices" // kAudioAggregateDeviceSubDeviceListKey
        static let main = "master"           // kAudioAggregateDeviceMainSubDeviceKey (== ...MasterSubDeviceKey)
        static let isPrivate = "private"     // kAudioAggregateDeviceIsPrivateKey
        static let isStacked = "stacked"     // kAudioAggregateDeviceIsStackedKey
        static let subUID = "uid"            // kAudioSubDeviceUIDKey
        static let drift = "drift"           // kAudioSubDeviceDriftCompensationKey
    }

    enum RouteError: Error, Equatable {
        case create(OSStatus)
        case select(OSStatus)
        case noOutput
        case noMic
    }

    let id: AudioDeviceID
    let micUID: String
    let outputUID: String

    /// The aggregate's description. Pure: `private == 1`, `master == outputUID`, the mic sub-device drift-compensated.
    static func description(micUID: String, outputUID: String) -> [String: Any] {
        [
            Key.uid: uid,
            Key.name: name,
            Key.isPrivate: 1,
            Key.isStacked: 0,
            Key.main: outputUID,
            Key.subDevices: [
                [Key.subUID: outputUID],
                [Key.subUID: micUID, Key.drift: 1],
            ],
        ]
    }

    /// Destroys a survivor with our UID, then creates the aggregate.
    static func make(micUID: String, outputUID: String) -> Result<PrivateRoute, RouteError> {
        if let stale = AudioEngine.deviceID(matching: uid) { _ = AudioHardwareDestroyAggregateDevice(stale) }
        var id = AudioDeviceID(0)
        let err = AudioHardwareCreateAggregateDevice(description(micUID: micUID, outputUID: outputUID) as CFDictionary, &id)
        guard err == noErr, id != 0 else { return .failure(.create(err)) }
        return .success(PrivateRoute(id: id, micUID: micUID, outputUID: outputUID))
    }

    func destroy() {
        _ = AudioHardwareDestroyAggregateDevice(id)
    }

    /// Read-back for the log and the probe: the sub-device UIDs the HAL holds.
    func subDevices() -> [String] {
        var addr = CoreAudioReads.address(kAudioAggregateDevicePropertyFullSubDeviceList)
        var value: Unmanaged<CFArray>?
        var size = UInt32(MemoryLayout<Unmanaged<CFArray>?>.size)
        let err = withUnsafeMutablePointer(to: &value) { AudioObjectGetPropertyData(id, &addr, 0, nil, &size, $0) }
        guard err == noErr, let array = value?.takeRetainedValue() as? [String] else { return [] }
        return array
    }
}
