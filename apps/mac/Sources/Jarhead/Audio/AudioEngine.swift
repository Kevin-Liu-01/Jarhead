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
    /// RMS 0..1 at ≤ 10 Hz, always finite (`clampLevel`). Called on the audio queue.
    var onMicLevel: ((Double) -> Void)?
    /// A second consumer of the same microphone tap (the on-device ear): the voice
    /// channel as mono Float32 at the hardware rate, every tap callback (100 ms of
    /// audio, see `installTap` below), with the tap's timestamp, before it is converted
    /// for the wire. Called on AVAudioEngine's tap thread — not the real-time render
    /// thread (default QoS, so a lock is fine, but keep it cheap: it is the first thread
    /// to be delayed under load). Set before `start()`.
    var onMicBuffer: ((AVAudioPCMBuffer, AVAudioTime) -> Void)?
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
            // The player raises (not throws) when the engine has just stopped itself under
            // it; the engine is about to be restarted anyway, so log and move on.
            self.guardPlayer("flush") {
                self.player.stop()
                if self.engine.isRunning { self.player.play() }
            }
        }
    }

    private var lastPlayerRaiseAt: CFAbsoluteTime = 0

    /// Runs a player call inside the ObjC shim; a raise is logged (at most every 5 s)
    /// instead of aborting the app. On `queue`.
    private func guardPlayer(_ what: String, _ body: () -> Void) {
        do {
            try objcTry(body)
        } catch {
            let now = CFAbsoluteTimeGetCurrent()
            if now - lastPlayerRaiseAt > 5 {
                lastPlayerRaiseAt = now
                onStatus?("speaker \(what) raised: \(error.localizedDescription) (engine \(engine.isRunning ? "running" : "stopped"))")
            }
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
            self.guardPlayer("schedule") {
                self.player.scheduleBuffer(buf, completionHandler: nil)
                if !self.player.isPlaying { self.player.play() }
            }
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
                let how = error is ObjCException ? "raised" : "failed"
                onStatus?("audio start (voice processing \(attempt.voice ? "on" : "off"), output \(attempt.wiring)) \(how): \(error.localizedDescription) — \(deviceSummary())")
                tearDownGraph()
            }
        }
        running = false
        scheduleRetryLocked(after: lastError)
    }

    /// A start that failed outright (no input device, unit refused to initialise, a raise
    /// caught by the shim) is not final: devices come and go. Back off on the ladder
    /// 0.5, 1, 2, 5, 10, 30 s (`AudioBackoff`) while `wanted` holds. The first two
    /// retries are quick and quiet — an input device that is still switching settles
    /// within a second or two — and only from the third on does the line carry the
    /// "audio failed" prefix the app turns into a toast, so a headset switch does not
    /// flash an error at Kevin.
    private func scheduleRetryLocked(after error: Error?) {
        guard wanted, !retryScheduled else { return }
        let delay = AudioBackoff.delay(attempt: retryAttempt)
        let quiet = retryAttempt < 2
        retryAttempt += 1
        retryScheduled = true
        let why = error?.localizedDescription ?? "unknown"
        let when = delay < 1 ? String(format: "%.1f s", delay) : "\(Int(delay)) s"
        onStatus?(quiet ? "audio start deferred: \(why) — retrying in \(when)" : "audio failed to start: \(why) — retrying in \(when)")
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
        // Every AVFoundation call below can raise an NSException (a connection at a rate
        // the hardware no longer runs, a tap on a stale format, a start with no device).
        // Inside the ObjC shim (`objcTry`) a raise is a thrown error the attempt loop
        // handles — not the end of the process.
        let input = engine.inputNode
        try objcTry(throwing: {
            if input.isVoiceProcessingEnabled != voiceProcessing {
                try input.setVoiceProcessingEnabled(voiceProcessing)
            }
        })
        applyPreferredInputDevice(to: input)

        let hw = input.outputFormat(forBus: 0)
        guard hw.sampleRate > 0, hw.channelCount > 0 else {
            throw NSError(domain: "Jarhead.Audio", code: 1, userInfo: [NSLocalizedDescriptionKey: "no input device"])
        }
        micAccumulator.removeAll(keepingCapacity: true)

        var live = hw
        try objcTry(throwing: {
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
            // AVAudioEngine clamps tap buffers to [100, 400] ms whatever size is asked for
            // (AVAudioNode.h; measured 4800 frames = 100 ms at 48 kHz here), so 2048 is a
            // wish, not the period: every word waits 0–100 ms (mean ~50) in the tap before
            // the wire and the ear see it, plus ~10 ms delivery. Going below that needs a
            // render-block source (an `AVAudioSinkNode` on the input, ~10 ms slices), not a
            // tap setting.
            //
            // `format: nil` is the node's own output format at the moment the tap is
            // created — nothing to mismatch. `hw`, read a moment ago, can be stale right
            // after a device switch, and a tap asked for it raised "Failed to create tap
            // due to format mismatch" and took the app down. `handleMic` converts from
            // `buffer.format` and rebuilds its converter when that changes, so the tap's
            // real format is never assumed.
            var loggedFirst = false
            input.installTap(onBus: 0, bufferSize: 2048, format: nil) { [weak self] buffer, when in
                if !loggedFirst {
                    loggedFirst = true
                    self?.onStatus?("mic tap first buffer: \(buffer.format.brief), \(buffer.frameLength) frames")
                }
                self?.handleMic(buffer, at: when)
            }

            engine.prepare()
            live = input.outputFormat(forBus: 0)
            try engine.start()
            player.play()
        })
        running = true
        let formatNote = live.brief == hw.brief ? live.brief : "\(live.brief) (was \(hw.brief) before prepare)"
        onStatus?("audio running: mic \(formatNote), voice processing \(voiceProcessing ? "on" : "off (no echo cancellation)"), output wiring \(wiring)")
    }

    private func tearDownGraph() {
        // The graph may be half-built after a failed attempt; a teardown must never raise.
        try? objcTry {
            self.engine.inputNode.removeTap(onBus: 0)
            if self.engine.isRunning { self.engine.stop() }
            self.engine.reset()
        }
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
        try? objcTry {
            self.engine.inputNode.removeTap(onBus: 0)
            // Always drop the speaker backlog: after a device change the engine may have
            // stopped itself, and whatever was queued must not replay at the next start.
            self.player.stop()
            if self.engine.isRunning { self.engine.stop() }
        }
        running = false
    }

    /// `AVAudioEngineConfigurationChange`: an input or output device changed and the
    /// engine has stopped itself. Stop and reset now (drops the speaker backlog, frees the
    /// tap), re-query the input format so the log shows what changed, and rebuild the
    /// graph through the shim after a short settle. Bursts coalesce into one restart.
    private func restartAfterConfigurationChange() {
        queue.async {
            guard self.wanted, !self.restartPending else { return }
            self.restartPending = true
            let before = self.inputFormatText()
            if self.running { self.stopLocked() }
            try? objcTry { self.engine.reset() }
            let after = self.inputFormatText()
            self.onStatus?("audio configuration changed: input \(before) → \(after); restarting in 0.3 s — \(self.deviceSummary())")
            // Let the device settle before rebuilding the graph.
            self.queue.asyncAfter(deadline: .now() + 0.3) {
                self.restartPending = false
                guard self.wanted, !self.running else { return }
                self.retryAttempt = 0
                self.startLocked()
            }
        }
    }

    /// Harnesses only: run the configuration-change path as if a device had just changed.
    func simulateConfigurationChange() {
        restartAfterConfigurationChange()
    }

    /// The input node's current output format, for a log line; never raises.
    private func inputFormatText() -> String {
        var text = "unreadable"
        try? objcTry { text = self.engine.inputNode.outputFormat(forBus: 0).brief }
        return text
    }

    // MARK: - microphone path (AVAudioEngine tap thread, not real-time)

    /// Per-channel energy over the last second, so a multi-channel input (VoiceIO on a
    /// mic array reports 9 channels here) is reduced to the channel that actually
    /// carries the voice rather than to silence.
    private var channelEnergy: [Double] = []
    private var chosenChannel = 0
    private var lastDiagAt: CFAbsoluteTime = 0
    private var monoConverter: AVAudioConverter?
    private var monoConverterRate: Double = 0

    private func handleMic(_ buffer: AVAudioPCMBuffer, at when: AVAudioTime) {
        guard buffer.frameLength > 0, let floats = buffer.floatChannelData else { return }
        let frames = Int(buffer.frameLength)
        let channels = Int(buffer.format.channelCount)
        if channelEnergy.count != channels { channelEnergy = Array(repeating: 0, count: channels) }
        for c in 0..<channels {
            var acc = 0.0
            let p = floats[c]
            for i in 0..<frames { acc += Double(p[i] * p[i]) }
            // Leaky integration; time constant ≈ 20 buffers ≈ 2 s of the tap's 100 ms buffers.
            // A non-finite mean (a NaN sample from a driver mid-switch) counts as silence:
            // once NaN, the energy would never compare again and the channel choice would freeze.
            let mean = acc / Double(frames)
            channelEnergy[c] = channelEnergy[c] * 0.95 + (mean.isFinite ? mean : 0)
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
        // The ear hears the same buffer the voice gets (echo-cancelled when voice
        // processing is on), fresh each callback, so appending it elsewhere is safe.
        onMicBuffer?(mono, when)

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
        // Finite and 0…1 whatever came in: this is what the wire and the orb see.
        return clampLevel(sqrt(acc / Double(n)))
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
