import AVFoundation
import AudioToolbox
import CoreAudio
import Foundation

/// Microphone in, speaker out, both PCM16 mono 24 kHz on the wire.
///
/// Voice processing is enabled on the input node BEFORE the engine starts so the
/// system echo canceller removes Jarhead's own voice from the mic. The Live model is
/// full duplex: without this it hears itself and answers itself.
///
/// Call `start()` only once microphone permission is known to be granted.
final class AudioEngine {
    /// 100 ms of 24 kHz Int16 mono.
    static let chunkBytes = 4800

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let queue = DispatchQueue(label: "jarhead.audio")

    private let wireFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24_000, channels: 1, interleaved: true)!
    private let playFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24_000, channels: 1, interleaved: false)!

    private var converter: AVAudioConverter?
    private var micAccumulator = Data()
    private var lastLevelAt: CFAbsoluteTime = 0
    private var preferredInputUID: String?
    private var running = false
    /// True between start() and stop(): the graph should be up, and a dead graph
    /// (failed start, device yanked) is retried until it is.
    private var wanted = false
    private var retryAttempt = 0
    private var retryScheduled = false
    private var configObserver: NSObjectProtocol?
    private var restartPending = false

    /// A 4800-byte PCM16 chunk, every 100 ms while running. Called on the audio queue.
    var onMicChunk: ((Data) -> Void)?
    /// RMS 0..1 at ≤ 10 Hz. Called on the audio queue.
    var onMicLevel: ((Double) -> Void)?
    /// Human-readable status/errors. Called on the audio queue.
    var onStatus: ((String) -> Void)?

    var isRunning: Bool { queue.sync { running } }

    init() {
        configObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self] _ in
            self?.restartAfterConfigurationChange()
        }
    }

    deinit {
        if let configObserver { NotificationCenter.default.removeObserver(configObserver) }
    }

    // MARK: - control

    func start() {
        queue.async {
            self.wanted = true
            self.retryAttempt = 0
            self.startLocked()
        }
    }

    func stop() {
        queue.async {
            self.wanted = false
            self.stopLocked()
        }
    }

    /// Barge-in / stop: drop everything queued for the speaker.
    func flush() {
        queue.async {
            guard self.running else { return }
            self.player.stop()
            if self.engine.isRunning { self.player.play() }
        }
    }

    /// Core Audio device UID (kAudioDevicePropertyDeviceUID) or a numeric AudioDeviceID;
    /// nil = system default. Restarts the engine if it is running.
    func setPreferredInputDevice(uid: String?) {
        queue.async {
            let normalized = uid?.trimmingCharacters(in: .whitespaces)
            let value = (normalized?.isEmpty ?? true) ? nil : normalized
            guard value != self.preferredInputUID else { return }
            self.preferredInputUID = value
            if self.wanted {
                self.stopLocked()
                self.retryAttempt = 0
                self.startLocked()
            }
        }
    }

    /// Speaker PCM16 mono 24 kHz from the daemon. Scheduled immediately; the player queues.
    func play(pcm: Data) {
        queue.async {
            guard self.running, self.engine.isRunning else { return }
            let frames = pcm.count / 2
            guard frames > 0, let buf = AVAudioPCMBuffer(pcmFormat: self.playFormat, frameCapacity: AVAudioFrameCount(frames)) else { return }
            buf.frameLength = AVAudioFrameCount(frames)
            guard let dst = buf.floatChannelData?[0] else { return }
            var samples = [Int16](repeating: 0, count: frames)
            _ = samples.withUnsafeMutableBytes { pcm.copyBytes(to: $0, count: frames * 2) }
            let scale = Float(1.0 / 32768.0)
            for i in 0 ..< frames { dst[i] = Float(samples[i]) * scale }
            self.player.scheduleBuffer(buf, completionHandler: nil)
            if !self.player.isPlaying { self.player.play() }
        }
    }

    // MARK: - engine setup (all on `queue`)

    private func startLocked() {
        guard !running else { return }
        // Voice processing (system echo cancellation) is what makes full duplex livable
        // next to speakers, but it fails to initialise (-10875) with some virtual or
        // Bluetooth devices. Try with it, then fall back without it rather than being deaf.
        var lastError: Error?
        // VoiceIO wants input and output on one clock: the output wiring is the part
        // that decides whether initialization succeeds, so try the plausible ones.
        let attempts: [(voice: Bool, wiring: OutputWiring)] = [(true, .automatic), (true, .inputRate), (true, .hardware), (false, .hardware)]
        for attempt in attempts {
            do {
                try startGraph(voiceProcessing: attempt.voice, wiring: attempt.wiring)
                return
            } catch {
                lastError = error
                onStatus?("audio start (voice processing \(attempt.voice ? "on" : "off"), output \(attempt.wiring)) failed: \(error.localizedDescription) — \(deviceSummary())")
                tearDownGraph()
            }
        }
        running = false
        scheduleRetryLocked(after: lastError)
    }

    /// A start that failed outright (no input device, unit refused to initialise) is
    /// not final: devices come and go. Back off 2 s → 30 s while `wanted` holds.
    private func scheduleRetryLocked(after error: Error?) {
        guard wanted, !retryScheduled else { return }
        let delay = min(30.0, 2.0 * pow(2.0, Double(min(retryAttempt, 4))))
        retryAttempt += 1
        retryScheduled = true
        onStatus?("audio failed to start: \(error?.localizedDescription ?? "unknown") — retrying in \(Int(delay)) s")
        queue.asyncAfter(deadline: .now() + delay) {
            self.retryScheduled = false
            guard self.wanted, !self.running else { return }
            self.startLocked()
        }
    }

    private enum OutputWiring: CustomStringConvertible {
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

    private func startGraph(voiceProcessing: Bool, wiring: OutputWiring) throws {
        let input = engine.inputNode
        if input.isVoiceProcessingEnabled != voiceProcessing {
            try input.setVoiceProcessingEnabled(voiceProcessing)
        }
        applyPreferredInputDevice(to: input)

        let hw = input.outputFormat(forBus: 0)
        guard hw.sampleRate > 0, hw.channelCount > 0 else {
            throw NSError(domain: "Jarhead.Audio", code: 1, userInfo: [NSLocalizedDescriptionKey: "no input device"])
        }
        guard let conv = AVAudioConverter(from: hw, to: wireFormat) else {
            throw NSError(domain: "Jarhead.Audio", code: 2, userInfo: [NSLocalizedDescriptionKey: "cannot convert \(hw) to 24 kHz Int16"])
        }
        converter = conv
        micAccumulator.removeAll(keepingCapacity: true)

        if !engine.attachedNodes.contains(player) { engine.attach(player) }
        engine.connect(player, to: engine.mainMixerNode, format: playFormat)
        switch wiring {
        case .automatic:
            break
        case .inputRate:
            let f = AVAudioFormat(standardFormatWithSampleRate: hw.sampleRate, channels: engine.outputNode.inputFormat(forBus: 0).channelCount > 0 ? engine.outputNode.inputFormat(forBus: 0).channelCount : 2) ?? hw
            engine.connect(engine.mainMixerNode, to: engine.outputNode, format: f)
        case .hardware:
            let outFormat = engine.outputNode.inputFormat(forBus: 0)
            if outFormat.sampleRate > 0 {
                engine.connect(engine.mainMixerNode, to: engine.outputNode, format: outFormat)
            }
        }

        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 2048, format: hw) { [weak self] buffer, _ in
            self?.handleMic(buffer)
        }

        engine.prepare()
        try engine.start()
        player.play()
        running = true
        onStatus?("audio running: mic \(Int(hw.sampleRate)) Hz ×\(hw.channelCount), voice processing \(voiceProcessing ? "on" : "off (no echo cancellation)"), output wiring \(wiring)")
    }

    private func tearDownGraph() {
        engine.inputNode.removeTap(onBus: 0)
        if engine.isRunning { engine.stop() }
        engine.reset()
    }

    /// Default input/output device names, for the log line that explains a failure.
    private func deviceSummary() -> String {
        func name(_ selector: AudioObjectPropertySelector) -> String {
            var deviceID = AudioDeviceID(0)
            var size = UInt32(MemoryLayout<AudioDeviceID>.size)
            var addr = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
            guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &deviceID) == noErr else { return "?" }
            var nameAddr = AudioObjectPropertyAddress(mSelector: kAudioObjectPropertyName, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
            var cfName: Unmanaged<CFString>?
            var nameSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
            guard AudioObjectGetPropertyData(deviceID, &nameAddr, 0, nil, &nameSize, &cfName) == noErr, let str = cfName?.takeRetainedValue() else { return "?" }
            return str as String
        }
        return "input: \(name(kAudioHardwarePropertyDefaultInputDevice)), output: \(name(kAudioHardwarePropertyDefaultOutputDevice))"
    }

    private func stopLocked() {
        engine.inputNode.removeTap(onBus: 0)
        // Always drop the speaker backlog: after a device change the engine may have
        // stopped itself, and whatever was queued must not replay at the next start.
        player.stop()
        if engine.isRunning { engine.stop() }
        converter = nil
        running = false
    }

    private func restartAfterConfigurationChange() {
        queue.async {
            guard self.wanted, !self.restartPending else { return }
            self.restartPending = true
            self.onStatus?("audio configuration changed; restarting")
            // Let the device settle before rebuilding the graph.
            self.queue.asyncAfter(deadline: .now() + 0.3) {
                self.restartPending = false
                guard self.wanted else { return }
                if self.running { self.stopLocked() }
                self.retryAttempt = 0
                self.startLocked()
            }
        }
    }

    // MARK: - microphone path (audio render thread)

    /// Per-channel energy over the last second, so a multi-channel input (VoiceIO on a
    /// mic array reports 9 channels here) is reduced to the channel that actually
    /// carries the voice rather than to silence.
    private var channelEnergy: [Double] = []
    private var chosenChannel = 0
    private var lastDiagAt: CFAbsoluteTime = 0
    private var monoConverter: AVAudioConverter?
    private var monoConverterRate: Double = 0

    private func handleMic(_ buffer: AVAudioPCMBuffer) {
        guard buffer.frameLength > 0, let floats = buffer.floatChannelData else { return }
        let frames = Int(buffer.frameLength)
        let channels = Int(buffer.format.channelCount)
        if channelEnergy.count != channels { channelEnergy = Array(repeating: 0, count: channels) }
        for c in 0..<channels {
            var acc = 0.0
            let p = floats[c]
            for i in 0..<frames { acc += Double(p[i] * p[i]) }
            // Leaky integration over ~1 s of 20 ms buffers.
            channelEnergy[c] = channelEnergy[c] * 0.95 + acc / Double(frames)
        }
        if channels > 1 {
            var best = chosenChannel
            for c in 0..<channels where channelEnergy[c] > channelEnergy[best] * 1.5 { best = c }
            chosenChannel = best
        } else {
            chosenChannel = 0
        }

        // Mono float at the hardware rate, then one converter to 24 kHz Int16.
        guard let monoFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: buffer.format.sampleRate, channels: 1, interleaved: false),
              let mono = AVAudioPCMBuffer(pcmFormat: monoFormat, frameCapacity: AVAudioFrameCount(frames)),
              let dst = mono.floatChannelData?[0] else { return }
        let src = floats[min(chosenChannel, channels - 1)]
        for i in 0..<frames { dst[i] = src[i] }
        mono.frameLength = AVAudioFrameCount(frames)

        if monoConverter == nil || monoConverterRate != buffer.format.sampleRate {
            monoConverter = AVAudioConverter(from: monoFormat, to: wireFormat)
            monoConverterRate = buffer.format.sampleRate
        }
        guard let converter = monoConverter else { return }
        let ratio = wireFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(frames) * ratio) + 32
        guard let out = AVAudioPCMBuffer(pcmFormat: wireFormat, frameCapacity: capacity) else { return }
        var consumed = false
        var error: NSError?
        let status = converter.convert(to: out, error: &error) { _, outStatus in
            if consumed {
                outStatus.pointee = .noDataNow
                return nil
            }
            consumed = true
            outStatus.pointee = .haveData
            return mono
        }
        let now = CFAbsoluteTimeGetCurrent()
        if now - lastDiagAt > 5 {
            lastDiagAt = now
            let energies = channelEnergy.map { String(format: "%.4f", sqrt($0)) }.joined(separator: " ")
            onStatus?("mic diag: \(channels) ch, using ch\(chosenChannel), rms per ch [\(energies)], convert \(status == .error ? "ERROR \(error?.localizedDescription ?? "")" : "ok \(out.frameLength) frames")")
        }
        guard status != .error, out.frameLength > 0, let ch = out.int16ChannelData?[0] else { return }
        let bytes = Data(bytes: ch, count: Int(out.frameLength) * 2)
        queue.async { self.accumulate(bytes) }
    }

    private func accumulate(_ bytes: Data) {
        guard running else { return }
        micAccumulator.append(bytes)
        while micAccumulator.count >= AudioEngine.chunkBytes {
            let chunk = Data(micAccumulator.prefix(AudioEngine.chunkBytes))
            micAccumulator.removeFirst(AudioEngine.chunkBytes)
            onMicChunk?(chunk)
            let now = CFAbsoluteTimeGetCurrent()
            if now - lastLevelAt >= 0.1 {
                lastLevelAt = now
                onMicLevel?(AudioEngine.rms(chunk))
            }
        }
    }

    static func rms(_ pcm16: Data) -> Double {
        let n = pcm16.count / 2
        guard n > 0 else { return 0 }
        var acc: Double = 0
        pcm16.withUnsafeBytes { raw in
            for i in 0 ..< n {
                let s = Double(raw.loadUnaligned(fromByteOffset: i * 2, as: Int16.self)) / 32768.0
                acc += s * s
            }
        }
        return min(1, sqrt(acc / Double(n)))
    }

    // MARK: - input device selection (Core Audio)

    private func applyPreferredInputDevice(to input: AVAudioInputNode) {
        guard let uid = preferredInputUID else { return }
        // The voice-processing unit drives input and output from one device property:
        // pointing it at a microphone would also send Jarhead's speech there (or fail
        // outright for input-only devices), so the echo canceller follows the system
        // default input instead. The explicit choice only applies on the no-AEC path.
        if input.isVoiceProcessingEnabled {
            onStatus?("echo cancellation follows the system default microphone; pick the mic in System Settings › Sound (Jarhead's choice \(uid) applies only without echo cancellation)")
            return
        }
        guard let deviceID = AudioEngine.deviceID(matching: uid) else {
            onStatus?("mic device \(uid) not found; using the system default")
            return
        }
        guard let au = input.audioUnit else {
            onStatus?("input node has no audio unit; using the system default mic")
            return
        }
        var dev = deviceID
        let err = AudioUnitSetProperty(au, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &dev, UInt32(MemoryLayout<AudioDeviceID>.size))
        if err != noErr {
            onStatus?("could not select mic device \(uid) (\(err)); using the system default")
        }
    }

    /// Match a Core Audio device UID, falling back to a literal AudioDeviceID.
    static func deviceID(matching uid: String) -> AudioDeviceID? {
        for id in allDeviceIDs() where deviceUID(id) == uid { return id }
        if let n = UInt32(uid), allDeviceIDs().contains(n) { return n }
        return nil
    }

    static func allDeviceIDs() -> [AudioDeviceID] {
        var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
        var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids) == noErr else { return [] }
        return ids
    }

    static func deviceUID(_ id: AudioDeviceID) -> String? {
        var addr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceUID, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        let err = withUnsafeMutablePointer(to: &value) { ptr in
            AudioObjectGetPropertyData(id, &addr, 0, nil, &size, ptr)
        }
        guard err == noErr, let cf = value?.takeRetainedValue() else { return nil }
        return cf as String
    }
}
