import AVFoundation
import AudioToolbox
import CoreAudio
import Foundation

/// Microphone in, speaker out, both PCM16 mono 24 kHz on the wire.
///
/// By default (`VoiceProcessingPolicy.aec`) voice processing is enabled on the input
/// node BEFORE the engine starts so the system echo canceller removes Jarhead's own
/// voice from the mic — the Live model is full duplex: without this it hears itself and
/// answers itself. The moment it is switched on the unit is told to duck other apps at
/// the least macOS allows and only while a voice is present (`VoiceProcessingKnobs`),
/// and it is released at every stop, so nothing lingers after Jarhead sleeps. With
/// Recording on (`VoiceProcessingPolicy.recording`, `setPolicy`) the plain graph runs
/// on the ranked microphone and the software echo guard (`EchoGuard`) holds the wire
/// while he speaks. What the graph is actually doing is read back as an
/// `AudioStateReadback` (`onAudioState`) — never assumed.
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
    /// Kevin's explicit pick (`Settings.micDeviceId`); nil = "Auto (ranked)".
    private var preferredInputUID: String?
    /// The microphone the graph last ran on, so the ranking can prefer it once the
    /// explicit pick and the built-in are out (`MicRanking.rank`). On `queue`.
    private var lastUsedInputUID: String?
    /// What the running graph hears through (nil while stopped). On the echo-cancelled
    /// path this is the system default input, whatever the ranking wanted (see
    /// `applyInputDevice`); on the plain path it is the ranked or explicit choice.
    private var activeInputUID: String?
    private var voiceProcessingOn = false
    /// design12: what the input node is told at start (`setPolicy`); consulted at every start,
    /// so a flip while asleep costs nothing and is used at the next wake.
    private var wantedPolicy: VoiceProcessingPolicy = .aec
    /// The policy the running graph was built from (`finishStart`); the deferred rebuild
    /// compares it with `wantedPolicy` — a flip and a flip back within the deferral rebuilds nothing.
    private var runningPolicy: VoiceProcessingPolicy = .aec
    /// The rung that came up last (0-based index into `wantedPolicy.attempts`), so a device
    /// change does not re-walk the refused rungs (dead air); nil = walk from the top.
    private var winningRung: Int?
    /// The running graph's rung (1-based), wiring, guard tail and tap format, for the frame.
    private var currentRung = 0
    private var currentWiring: OutputWiring = .automatic
    private var currentTailMs = 0
    private var currentTapFormat = ""
    private var lastAudioState: AudioStateReadback?
    private var rebuildPending = false
    /// The private aggregate the unit runs on (probe-only rungs; `PrivateRoute.enabled`).
    private var privateRoute: PrivateRoute?
    /// Device list / default-input / default-output / mic-client listeners (Core Audio), answering on `queue`.
    private let router = MicRouter()
    private var lastRouteSummary = ""
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
    /// design12: the graph's state as a value (`AudioStateReadback`) — on start, stop, route
    /// change, guard edges and every 5 s with the `mic diag` tick, coalesced to changes.
    /// Called on the audio queue. The app forwards it to the daemon and the island.
    var onAudioState: ((AudioStateReadback) -> Void)?

    var isRunning: Bool { queue.sync { running } }

    init() {
        configObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self] _ in
            self?.restartAfterConfigurationChange()
        }
        // The guard's hold beginning or ending is a state the island shows (the mic box dims).
        // Twice per sentence, on the queue that schedules the sentence's chunks — so only the
        // guard's own fields are refreshed, never the device tables or the HAL's process list.
        EchoGuard.shared.onHeldChange = { [weak self] _ in
            self?.queue.async { self?.publishGuardEdge() }
        }
        // The device list and the system default input, watched from the start: a
        // microphone that vanishes mid-session is rebuilt around on the next-ranked one
        // (`routeChanged`), and the Console's mic picker learns the ranked list.
        router.onChange = { [weak self] reason in self?.routeChanged(reason) }
        router.start(on: queue)
        installRouteRequestObserver()
    }

    deinit {
        if let configObserver { NotificationCenter.default.removeObserver(configObserver) }
        if let routeRequestObserver { NotificationCenter.default.removeObserver(routeRequestObserver) }
        router.stop()
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
            // Nothing queued is audible any more: the duck's gate disarms with the backlog,
            // and the echo guard's audible window ends with it.
            BargeInDuck.shared.noteFlush()
            EchoGuard.shared.noteFlush()
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
            self.winningRung = nil
            if self.wanted {
                self.stopLocked()
                self.retryAttempt = 0
                self.startLocked()
            }
        }
    }

    // MARK: - design12: the policy, mute, the state frame

    /// Settings › Audio › Recording flipped (or the app's first read of it): remember the
    /// policy and, if the graph is up, rebuild it from rung 1 — once Jarhead has finished
    /// the sentence he is on (`stopLocked` drops the speaker backlog), capped at 3 s. A second
    /// flip while that rebuild waits only moves `wantedPolicy`; the rebuild reads it when it runs.
    func setPolicy(_ p: VoiceProcessingPolicy) {
        queue.async {
            guard p != self.wantedPolicy else { return }
            self.wantedPolicy = p
            guard self.wanted, self.running else {
                // Stopped: the next start walks the new policy's ladder from the top.
                self.winningRung = nil
                return
            }
            guard !self.rebuildPending else { return }
            self.rebuildPending = true
            self.rebuildWhenQuiet(deadline: CFAbsoluteTimeGetCurrent() + 3, noted: false)
        }
    }

    /// On `queue`: the deferred rebuild — now if the speaker is quiet (nothing audible queued
    /// for 0.3 s) or the deadline has passed, else look again in 250 ms. Nothing is torn down
    /// when the running graph already carries the wanted policy (flipped on and off meanwhile):
    /// the remembered rung stays, the speaker backlog and the microphone are not interrupted.
    private func rebuildWhenQuiet(deadline: CFAbsoluteTime, noted: Bool) {
        guard wanted, running else {
            // Stopped meanwhile: the next start reads the policy anyway.
            rebuildPending = false
            winningRung = nil
            return
        }
        if BargeInDuck.shared.outputQuiet(for: 0.3) || CFAbsoluteTimeGetCurrent() >= deadline {
            rebuildPending = false
            guard wantedPolicy != runningPolicy else {
                onStatus?("audio: policy flipped back before the rebuild — the running graph already matches; nothing rebuilt")
                publishAudioState("policy")
                return
            }
            winningRung = nil
            stopLocked()
            retryAttempt = 0
            startLocked()
            return
        }
        if !noted { onStatus?("audio: policy flip deferred — Jarhead is speaking") }
        queue.asyncAfter(deadline: .now() + 0.25) { [weak self] in
            self?.rebuildWhenQuiet(deadline: deadline, noted: true)
        }
    }

    /// Mute (phase `muted`): this process's input is zeroed at the HAL
    /// (`kAudioHardwarePropertyProcessInputMute`, via `AVAudioApplication`) so the orange dot
    /// is honest; the graph stays up so unmute is instant, and the echo guard freezes with it.
    func setProcessInputMuted(_ muted: Bool) {
        queue.async {
            do {
                try AVAudioApplication.shared.setInputMuted(muted)
            } catch {
                self.onStatus?("process input mute \(muted ? "on" : "off") refused: \(error.localizedDescription)")
            }
            EchoGuard.shared.frozen = muted
            self.publishAudioState(muted ? "muted" : "unmuted")
        }
    }

    /// The frame, read back from the nodes and the HAL. On `queue`.
    private func readback() -> AudioStateReadback {
        let input = engine.inputNode
        var s = AudioStateReadback()
        var knobs: VoiceProcessingKnobs.Readback?
        try? objcTry {
            s.voiceProcessing = input.isVoiceProcessingEnabled
            if s.voiceProcessing { knobs = VoiceProcessingKnobs.read(input) }
        }
        s.running = running
        s.duckLevel = knobs?.duckLevel
        s.advancedDucking = knobs?.advanced
        s.agc = knobs?.agc
        s.bypassed = knobs?.bypassed
        s.rung = running ? currentRung : 0
        s.wiring = running ? currentWiring.description : ""
        s.hears = hearsFacts(input: input, voiceProcessing: s.voiceProcessing)
        s.speaks = AudioDeviceFacts.defaultOutput()
        s.tapFormat = running ? currentTapFormat : ""
        s.recording = !wantedPolicy.echoCancel
        s.fallback = running && !s.voiceProcessing && wantedPolicy.echoCancel
        refreshGuardFields(&s)
        s.sharedWith = s.hears.flatMap { AudioEngine.deviceID(matching: $0.uid) }.flatMap { AudioProcessObjects.sharingInput(on: $0) }
        s.inputMuted = AVAudioApplication.shared.isInputMuted
        s.aggregatePresent = AudioAggregates.present(AudioAggregates.unitPrefix)
        s.engineAggregatePresent = AudioAggregates.present(AudioAggregates.enginePrefix)
        return s
    }

    /// The guard's own fields — one lock, no HAL.
    private func refreshGuardFields(_ s: inout AudioStateReadback) {
        let guardStats = EchoGuard.shared.stats
        s.guardOn = EchoGuard.shared.isAttached
        s.guardHeld = EchoGuard.shared.isHeld
        s.guardTailMs = s.guardOn ? currentTailMs : 0
        s.gated = guardStats.gated
        s.chunks = guardStats.chunks
        s.breakthroughs = guardStats.breakthroughs
        s.heldSeconds = guardStats.heldSeconds
    }

    /// A hold began or ended: the last frame with the guard's fields refreshed — the device
    /// tables, the aggregate scans and the process list are read on the tick and on route
    /// changes only. Without a frame yet, the full read-back. On `queue`.
    private func publishGuardEdge() {
        guard var s = lastAudioState else {
            publishAudioState("guard")
            return
        }
        refreshGuardFields(&s)
        publish(s, reason: "guard")
    }

    /// The device the graph hears through: under AEC the system default input (the unit
    /// follows it); on the plain path the microphone `applyInputDevice` settled on
    /// (`activeInputUID`); on the private route the ranked mic behind the aggregate.
    /// Stopped: the default input.
    private func hearsFacts(input: AVAudioInputNode, voiceProcessing: Bool) -> AudioDeviceFacts? {
        if running, let route = privateRoute, let id = AudioEngine.deviceID(matching: route.micUID) {
            return AudioDeviceFacts.read(id: id, scope: kAudioObjectPropertyScopeInput)
        }
        if running, !voiceProcessing {
            // The AU's `CurrentDevice` reads as the engine's own aggregate on a Mac whose default
            // input ≠ default output (`CADefaultDeviceAggregate-<pid>-n`), so the microphone the
            // graph was pointed at is the fact: `activeInputUID`, then the AU, then the default.
            if let uid = activeInputUID, let id = AudioEngine.deviceID(matching: uid) {
                return AudioDeviceFacts.read(id: id, scope: kAudioObjectPropertyScopeInput)
            }
            if let dev = AudioEngine.currentDevice(of: input), let uid = AudioEngine.deviceUID(dev), !uid.hasPrefix(AudioAggregates.enginePrefix) {
                return AudioDeviceFacts.read(id: dev, scope: kAudioObjectPropertyScopeInput)
            }
        }
        return AudioDeviceFacts.defaultInput()
    }

    /// The input AU's `kAudioOutputUnitProperty_CurrentDevice`, or nil.
    static func currentDevice(of input: AVAudioInputNode) -> AudioDeviceID? {
        guard let au = input.audioUnit else { return nil }
        var dev = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        guard AudioUnitGetProperty(au, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &dev, &size) == noErr, dev != 0 else { return nil }
        return dev
    }

    /// Publish the frame when it changed. On `queue`.
    private func publishAudioState(_ reason: String) {
        publish(readback(), reason: reason)
    }

    private func publish(_ state: AudioStateReadback, reason: String) {
        guard state != lastAudioState else { return }
        lastAudioState = state
        onAudioState?(state)
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
            var energy = 0.0
            for i in 0 ..< frames {
                let s = Float(samples[i]) * scale
                dst[i] = s
                energy += Double(s * s)
            }
            // What the speaker is about to say, for the barge-in duck and the echo guard:
            // GPT-Live-1 streams silence between sentences too, so audibility (not arrival)
            // is what arms them.
            let rms = clampLevel((energy / Double(frames)).squareRoot())
            let seconds = Double(frames) / self.playFormat.sampleRate
            BargeInDuck.shared.noteOutput(rms: rms, seconds: seconds)
            EchoGuard.shared.noteOutput(rms: rms, seconds: seconds)
            self.guardPlayer("schedule") {
                self.player.scheduleBuffer(buf, completionHandler: nil)
                if !self.player.isPlaying { self.player.play() }
            }
        }
    }

    // MARK: - engine setup (all on `queue`)

    /// Walk the policy's ladder (`VoiceProcessingPolicy.attempts`) from the remembered
    /// winning rung. Voice processing (system echo cancellation) is what makes full duplex
    /// livable next to speakers, but it fails to initialise (-10875) with some virtual or
    /// Bluetooth devices: with AEC the three wirings are tried, then the plain graph,
    /// guarded, rather than being deaf. Recording walks the plain rungs only.
    private func startLocked() {
        guard !running else { return }
        let attempts = wantedPolicy.attempts
        let first = VoiceProcessingPolicy.firstRung(remembered: winningRung, count: attempts.count)
        var lastError: Error?
        for (index, attempt) in attempts.enumerated() where index >= first {
            do {
                try startGraph(attempt, rung: index + 1)
                winningRung = index
                return
            } catch {
                lastError = error
                let how = error is ObjCException ? "raised" : "failed"
                onStatus?("audio start (\(attempt.description), rung \(index + 1)) \(how): \(error.localizedDescription) — \(deviceSummary())")
                tearDownGraph()
            }
        }
        if first > 0 {
            // The remembered rung died (a device pair changed under it): walk from the top once.
            winningRung = nil
            return startLocked()
        }
        running = false
        winningRung = nil
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

    private func startGraph(_ attempt: StartAttempt, rung: Int) throws {
        // Every AVFoundation call below can raise an NSException (a connection at a rate
        // the hardware no longer runs, a tap on a stale format, a start with no device).
        // Inside the ObjC shim (`objcTry`) a raise is a thrown error the attempt loop
        // handles — not the end of the process.
        let input = engine.inputNode
        let voiceProcessing = attempt.voice
        // Still while the engine is stopped (`setVoiceProcessingEnabled` and the ducking
        // configuration require it, AVIO:150). The knob writes sit in the same `objcTry`:
        // AVFAudio raises when it dislikes the node's state, and a raise must stay a caught
        // attempt failure.
        try objcTry(throwing: {
            if input.isVoiceProcessingEnabled != voiceProcessing {
                try input.setVoiceProcessingEnabled(voiceProcessing)
            }
            if voiceProcessing {
                VoiceProcessingKnobs.apply(self.wantedPolicy, to: input)   // ducking · agc · bypass
            }
        })
        voiceProcessingOn = voiceProcessing
        if attempt.privateRoute {
            try applyPrivateRoute(to: input)
        } else {
            try applyInputDevice(to: input, voiceProcessing: voiceProcessing, pinDevice: attempt.pinDevice)
        }

        let hw = input.outputFormat(forBus: 0)
        guard hw.sampleRate > 0, hw.channelCount > 0 else {
            throw NSError(domain: "Jarhead.Audio", code: 1, userInfo: [NSLocalizedDescriptionKey: "no input device"])
        }
        micAccumulator.removeAll(keepingCapacity: true)

        var live = hw
        try objcTry(throwing: {
            self.wireGraph(attempt.wiring, hw: hw)
            self.installMicTap(on: input)
            self.engine.prepare()
            live = input.outputFormat(forBus: 0)
            try self.engine.start()
            self.player.play()
        })
        finishStart(voiceProcessing: voiceProcessing, wiring: attempt.wiring, rung: rung, hw: hw, live: live)
    }

    /// The player onto the main mixer, and mainMixer → output per the wiring. Inside the caller's `objcTry`.
    private func wireGraph(_ wiring: OutputWiring, hw: AVAudioFormat) {
        if !engine.attachedNodes.contains(player) { engine.attach(player) }
        engine.connect(player, to: engine.mainMixerNode, format: playFormat)
        switch wiring {
        case .automatic:
            break
        case .inputRate:
            let outChannels = engine.outputNode.inputFormat(forBus: 0).channelCount
            let f = AVAudioFormat(standardFormatWithSampleRate: hw.sampleRate, channels: outChannels > 0 ? outChannels : 2) ?? hw
            engine.connect(engine.mainMixerNode, to: engine.outputNode, format: f)
        case .hardware:
            let outFormat = engine.outputNode.inputFormat(forBus: 0)
            if outFormat.sampleRate > 0 {
                engine.connect(engine.mainMixerNode, to: engine.outputNode, format: outFormat)
            }
        }
    }

    /// The one microphone tap. Inside the caller's `objcTry`.
    private func installMicTap(on input: AVAudioInputNode) {
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
    }

    /// The graph is up: arm the duck (AEC only) or the echo guard (plain graph only), say so, publish.
    private func finishStart(voiceProcessing: Bool, wiring: OutputWiring, rung: Int, hw: AVAudioFormat, live: AVAudioFormat) {
        running = true
        runningPolicy = wantedPolicy
        currentRung = rung
        currentWiring = wiring
        currentTapFormat = live.brief
        if let uid = activeInputUID { lastUsedInputUID = uid }
        // The duck drives the player's own volume (its bus on the main mixer): −20 dB the
        // moment Kevin's voice is heard over Jarhead's, back over 300 ms. Only with echo
        // cancellation on — without it the gate would hear Jarhead and duck itself. The
        // write goes through the ObjC shim like every other player call: it runs on the
        // duck's queue and can land while `engine.reset()` runs for a device change.
        let playerNode = self.player
        BargeInDuck.shared.attach(echoCancelled: voiceProcessing) { gain in
            try? objcTry { playerNode.volume = gain }
        }
        // On the plain graph the microphone hears Jarhead at full level: the guard holds the
        // wire while he is audible plus a tail sized for the room and the output's latency, and
        // learns the echo floor only once that latency (plus the tap's 100 ms) has passed — a
        // floor taught from pre-echo silence would let the echo itself break through.
        let latency = outputLatency()
        let tail = guardTail(latency: latency, speaks: AudioDeviceFacts.defaultOutput())
        currentTailMs = Int((tail * 1000).rounded())
        if voiceProcessing {
            EchoGuard.shared.detach()
        } else {
            EchoGuard.shared.attach(tail: tail, learnDelay: AudioEngine.guardLearnDelay(latency: latency))
        }
        let formatNote = live.brief == hw.brief ? live.brief : "\(live.brief) (was \(hw.brief) before prepare)"
        onStatus?(AudioEngine.runningLine(mic: formatNote, policy: wantedPolicy, voiceProcessing: voiceProcessing, wiring: wiring, rung: rung, tailMs: currentTailMs))
        if voiceProcessing { logKnobsReadback() }
        publishRoute("audio running")
    }

    /// The knobs as the unit holds them now, in both spellings — the Swift properties and
    /// the raw AU property 2108 — so run.log carries V1's cross-check without the probe.
    private func logKnobsReadback() {
        var line = ""
        try? objcTry { line = VoiceProcessingKnobs.readbackLine(self.engine.inputNode) }
        if !line.isEmpty { onStatus?(line) }
    }

    /// The output node's presentation latency in seconds (0 when unreadable or absurd).
    private func outputLatency() -> Double {
        var latency = 0.0
        try? objcTry { latency = self.engine.outputNode.presentationLatency }
        return latency.isFinite ? max(0, latency) : 0
    }

    /// `baseTail + the output's presentation latency (+ the Bluetooth allowance)`, clamped.
    private func guardTail(latency: Double, speaks: AudioDeviceFacts?) -> Double {
        var tail = EchoGuardModel.baseTail + latency
        if speaks?.isBluetooth == true { tail += EchoGuardModel.bluetoothTail }
        return min(EchoGuardModel.maxTail, max(EchoGuardModel.baseTail, tail))
    }

    /// How long after a hold begins the guard starts learning: the output's latency plus the
    /// tap's 100 ms, clamped to `EchoGuardModel.maxLearnDelay`. Pure, for duck-probe.
    static func guardLearnDelay(latency: Double) -> Double {
        let l = latency.isFinite ? max(0, latency) : 0
        return min(EchoGuardModel.maxLearnDelay, l + EchoGuardModel.tapDelay)
    }

    /// `audio running: mic <fmt>, voice processing on (duck min advanced, agc on, bypass off) | off (guard on[, fallback]), output wiring <w>, rung <n>, tail <ms> ms`
    static func runningLine(mic: String, policy: VoiceProcessingPolicy, voiceProcessing: Bool, wiring: OutputWiring, rung: Int, tailMs: Int) -> String {
        let vp: String
        if voiceProcessing {
            vp = "on (\(policy.knobsDescription))"
        } else {
            vp = policy.echoCancel ? "off (guard on, fallback)" : "off (guard on)"
        }
        return "audio running: mic \(mic), voice processing \(vp), output wiring \(wiring), rung \(rung), tail \(tailMs) ms"
    }

    /// Probe-only while `PrivateRoute.enabled` is false: the unit on Jarhead's own aggregate
    /// (the default output as the clock, the ranked microphone beside it), so it need not
    /// follow the system default input. Throws to fail the rung; the ladder falls through.
    private func applyPrivateRoute(to input: AVAudioInputNode) throws {
        let inputs = MicInputs.enumerate()
        let systemDefault = MicInputs.systemDefaultUID()
        let ranked = MicRanking.rank(inputs, explicit: preferredInputUID, lastUsed: lastUsedInputUID, systemDefault: systemDefault)
        guard let mic = ranked.first else { throw PrivateRoute.RouteError.noMic }
        guard let output = AudioDeviceFacts.defaultOutput() else { throw PrivateRoute.RouteError.noOutput }
        guard let au = input.audioUnit else { throw PrivateRoute.RouteError.select(-1) }
        let route = try PrivateRoute.make(micUID: mic.uid, outputUID: output.uid).get()
        var dev = route.id
        let err = AudioUnitSetProperty(au, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &dev, UInt32(MemoryLayout<AudioDeviceID>.size))
        guard err == noErr else {
            route.destroy()
            throw PrivateRoute.RouteError.select(err)
        }
        privateRoute = route
        activeInputUID = mic.uid
        onStatus?("private route \(PrivateRoute.uid): \(output.name) + \(mic.name) [\(route.subDevices().joined(separator: ", "))]")
    }

    /// Release the voice-processing unit with the graph: it exists exactly while the graph
    /// runs, so nothing ducks or holds a headset microphone after Jarhead sleeps, and a
    /// refused AEC rung never hands a stale `true` to the plain rung that follows. The
    /// guard and the private aggregate go with it. On `queue`, after `engine.stop()`.
    private func releaseVoiceProcessing() {
        let input = engine.inputNode
        do {
            try objcTry(throwing: {
                if input.isVoiceProcessingEnabled { try input.setVoiceProcessingEnabled(false) }
            })
        } catch {
            onStatus?("voice processing release raised: \(error.localizedDescription)")
        }
        voiceProcessingOn = false
        EchoGuard.shared.detach()
        privateRoute?.destroy()
        privateRoute = nil
    }

    private func tearDownGraph() {
        BargeInDuck.shared.detach()
        activeInputUID = nil
        // The graph may be half-built after a failed attempt; a teardown must never raise.
        try? objcTry {
            self.engine.inputNode.removeTap(onBus: 0)
            if self.engine.isRunning { self.engine.stop() }
            self.engine.reset()
        }
        releaseVoiceProcessing()
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
        BargeInDuck.shared.detach()
        try? objcTry {
            self.engine.inputNode.removeTap(onBus: 0)
            // Always drop the speaker backlog: after a device change the engine may have
            // stopped itself, and whatever was queued must not replay at the next start.
            self.player.stop()
            if self.engine.isRunning { self.engine.stop() }
        }
        releaseVoiceProcessing()
        running = false
        activeInputUID = nil
        currentRung = 0
        currentTapFormat = ""
        publishRoute("audio stopped")
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
        let rate = buffer.format.sampleRate
        chooseChannel(floats, frames: frames, channels: channels)

        // Mono float at the hardware rate, then one converter to 24 kHz Int16.
        guard let monoFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false),
              let mono = AVAudioPCMBuffer(pcmFormat: monoFormat, frameCapacity: AVAudioFrameCount(frames)),
              let dst = mono.floatChannelData?[0] else { return }
        let src = floats[min(chosenChannel, channels - 1)]
        for i in 0..<frames { dst[i] = src[i] }
        mono.frameLength = AVAudioFrameCount(frames)
        // The barge-in gate reads the same channel in 10 ms slices: the tap only hands over
        // 100 ms buffers, so the slices are what let "60 ms of speech" be judged inside one.
        // (It returns at once on the plain path: the duck stays detached there.)
        BargeInDuck.shared.noteMic(mono: dst, frames: frames, sampleRate: rate, capturedAt: when)
        // The ear hears the raw buffer first (echo-cancelled when voice processing is on;
        // Jarhead's own voice too on the plain path — the engine holds reflexes while the
        // voice speaks, and the `stop` reflex is barge-in by word), fresh each callback.
        onMicBuffer?(mono, when)
        // The echo guard (plain graph only): `.hold` while Jarhead is audible plus the tail.
        let verdict = EchoGuard.shared.judge(mono: dst, frames: frames, sampleRate: rate)

        guard let out = convertToWire(mono, format: monoFormat, frames: frames, channels: channels) else { return }
        guard out.frameLength > 0, let ch = out.int16ChannelData?[0] else { return }
        // Held: zero-filled, not dropped — the wire keeps its 100 ms cadence and Live's
        // timeline does not jump. What reaches the wire is what the Input meter shows.
        if verdict == .hold { memset(ch, 0, Int(out.frameLength) * 2) }
        let bytes = Data(bytes: ch, count: Int(out.frameLength) * 2)
        queue.async { self.accumulate(bytes) }
    }

    /// Per-channel leaky energy (time constant ≈ 20 buffers ≈ 2 s of the tap's 100 ms
    /// buffers) and the channel choice, with 1.5× hysteresis. A non-finite mean (a NaN
    /// sample from a driver mid-switch) counts as silence: once NaN, the energy would never
    /// compare again and the channel choice would freeze.
    private func chooseChannel(_ floats: UnsafePointer<UnsafeMutablePointer<Float>>, frames: Int, channels: Int) {
        if channelEnergy.count != channels { channelEnergy = Array(repeating: 0, count: channels) }
        for c in 0..<channels {
            var acc = 0.0
            let p = floats[c]
            for i in 0..<frames { acc += Double(p[i] * p[i]) }
            let mean = acc / Double(frames)
            channelEnergy[c] = channelEnergy[c] * 0.95 + (mean.isFinite ? mean : 0)
        }
        guard channels > 1 else {
            chosenChannel = 0
            return
        }
        var best = min(chosenChannel, channels - 1)
        for c in 0..<channels where channelEnergy[c] > channelEnergy[best] * 1.5 { best = c }
        chosenChannel = best
    }

    /// One `AVAudioConverter` (mono@hw → Int16 24 kHz), rebuilt when the rate changes; the
    /// `mic diag` line every 5 s, and the state frame's tick with it. nil on a converter error.
    private func convertToWire(_ mono: AVAudioPCMBuffer, format monoFormat: AVAudioFormat, frames: Int, channels: Int) -> AVAudioPCMBuffer? {
        let rate = monoFormat.sampleRate
        if monoConverter == nil || monoConverterRate != rate {
            monoConverter = AVAudioConverter(from: monoFormat, to: wireFormat)
            monoConverterRate = rate
        }
        guard let converter = monoConverter else { return nil }
        let capacity = AVAudioFrameCount(Double(frames) * (wireFormat.sampleRate / rate)) + 32
        guard let out = AVAudioPCMBuffer(pcmFormat: wireFormat, frameCapacity: capacity) else { return nil }
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
            let convert = status == .error ? "ERROR \(error?.localizedDescription ?? "")" : "ok \(out.frameLength) frames"
            onStatus?("mic diag: \(channels) ch, using ch\(chosenChannel), rms per ch [\(energies)], convert \(convert)\(BargeInDuck.shared.diagSuffix())\(EchoGuard.shared.diagSuffix())")
            queue.async { self.publishAudioState("tick") }
        }
        return status == .error ? nil : out
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

    /// The microphone the graph should run on: `MicRanking.rank` over the connected input
    /// devices — Kevin's explicit pick, else the connected built-in, else the one used
    /// last, else the system default; an aggregate or virtual device only when picked by
    /// name. Applied on the plain path only. The voice-processing unit has ONE device
    /// property (`kAudioOutputUnitProperty_CurrentDevice`, global scope) for input and
    /// output: pointing it at a microphone also routes Jarhead's speech there, or fails
    /// outright for an input-only device and knocks the graph onto the no-AEC fallback.
    /// With echo cancellation on, the graph therefore follows the system default input;
    /// the ranking is logged and the Console's picker says so. The default is Kevin's to
    /// change (System Settings › Sound) and is never written from here.
    ///
    /// The plain path's set is a rung that can fail (`StartAttempt.pinDevice`): on a Mac
    /// whose default input ≠ default output the engine's I/O is one unit on its own
    /// aggregate, and pointing the input AU at an input-only microphone knocks the output
    /// side out (−10875 on every wiring). So: the ranked mic already the default → nothing is
    /// set; pinned and the set fails → the rung throws and the ladder moves on; not pinned →
    /// the system default mic, said as `ranked mic refused; hearing the system default`.
    ///
    /// One exception to "never a virtual device unless picked": when the only connected
    /// inputs are aggregate or virtual, the first of them is used — deaf is not better —
    /// and the log and the picker say it is virtual.
    private func applyInputDevice(to input: AVAudioInputNode, voiceProcessing: Bool, pinDevice: Bool) throws {
        let inputs = MicInputs.enumerate()
        let systemDefault = MicInputs.systemDefaultUID()
        let ranked = MicRanking.rank(inputs, explicit: preferredInputUID, lastUsed: lastUsedInputUID, systemDefault: systemDefault)
        guard let choice = ranked.first else {
            activeInputUID = systemDefault
            return
        }
        if voiceProcessing {
            activeInputUID = systemDefault
            if choice.uid != systemDefault {
                onStatus?("mic ranking wants \(choice.name); echo cancellation follows the system default microphone (\(MicInputs.name(of: systemDefault) ?? "none")) — pick it in System Settings › Sound")
            }
            return
        }
        if choice.uid == systemDefault {
            // Already the default: the engine's unit hears it without a device set (which
            // would knock the output out on a Mac whose default input ≠ default output).
            activeInputUID = systemDefault
            noteInputChoice(choice)
            return
        }
        guard pinDevice else {
            activeInputUID = systemDefault
            onStatus?("ranked mic \(choice.name) refused; hearing the system default (\(MicInputs.name(of: systemDefault) ?? "none"))")
            return
        }
        try pinInputDevice(choice, on: input)
        activeInputUID = choice.uid
        noteInputChoice(choice)
    }

    /// `kAudioOutputUnitProperty_CurrentDevice` on the input AU → `choice`; throws when the
    /// unit has no AU or refuses the device, so the rung fails and the ladder moves on.
    private func pinInputDevice(_ choice: MicInput, on input: AVAudioInputNode) throws {
        guard let au = input.audioUnit else { throw InputDeviceError.noUnit }
        var dev = choice.id
        let err = AudioUnitSetProperty(au, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &dev, UInt32(MemoryLayout<AudioDeviceID>.size))
        guard err == noErr else { throw InputDeviceError.select(name: choice.name, status: err) }
    }

    /// The log line that explains a plain-path choice that is not simply Kevin's pick.
    private func noteInputChoice(_ choice: MicInput) {
        if let wanted = preferredInputUID, wanted != choice.uid {
            onStatus?("mic device \(wanted) is not connected; using \(choice.name) (ranked)")
        } else if preferredInputUID == nil, choice.isVirtual {
            onStatus?("only aggregate/virtual inputs are connected; using \(choice.name) (\(choice.transportName)) rather than nothing")
        }
    }

    // MARK: - route changes (Core Audio listeners, on `queue`)

    private var routeChangeScheduled = false
    private var routeChangeReasons: [String] = []

    /// The device list or the system default input changed. Bursts (a device arriving
    /// fires both listeners) are folded into one look 50 ms later.
    private func routeChanged(_ reason: String) {
        if !routeChangeReasons.contains(reason) { routeChangeReasons.append(reason) }
        guard !routeChangeScheduled else { return }
        routeChangeScheduled = true
        queue.asyncAfter(deadline: .now() + 0.05) {
            self.routeChangeScheduled = false
            let why = self.routeChangeReasons.joined(separator: ", ")
            self.routeChangeReasons.removeAll()
            self.applyRouteChange(why)
        }
    }

    /// Three things can follow a change: the microphone the graph hears through is gone
    /// — rebuild on the next-ranked one (an `AVAudioEngineConfigurationChange` usually
    /// arrives for the same event; `restartPending` folds the two into one restart 0.3 s
    /// after the first); Kevin's explicit pick came back on the plain path — move to it;
    /// otherwise only the published route moves. The system default is never written.
    private func applyRouteChange(_ reason: String) {
        let inputs = MicInputs.enumerate()
        let systemDefault = MicInputs.systemDefaultUID()
        let ranked = MicRanking.rank(inputs, explicit: preferredInputUID, lastUsed: lastUsedInputUID, systemDefault: systemDefault)
        var restart: String?
        if running, let active = activeInputUID, !inputs.contains(where: { $0.uid == active }) {
            restart = "microphone \(MicInputs.name(of: active) ?? active) vanished; rebuilding on \(ranked.first?.name ?? "the system default")"
        } else if running, !voiceProcessingOn, let explicit = preferredInputUID, activeInputUID != explicit, ranked.first?.uid == explicit {
            restart = "picked microphone \(ranked.first?.name ?? explicit) is back; moving to it"
        }
        publishRoute(reason)
        guard let restart, wanted, !restartPending else { return }
        restartPending = true
        onStatus?("mic route: \(restart) — restarting in 0.3 s")
        if running { stopLocked() }
        try? objcTry { self.engine.reset() }
        queue.asyncAfter(deadline: .now() + 0.3) {
            self.restartPending = false
            guard self.wanted, !self.running else { return }
            self.retryAttempt = 0
            self.startLocked()
        }
    }

    /// The route as the Console's picker and the ear report it: the ranked list, the
    /// active device, what the choice follows. Posted on the main queue as
    /// `.jarheadMicRoute` with plain strings (the Console harness compiles without this
    /// file) and logged through `onStatus` when it changed. Answers the picker's
    /// `jarhead.micRoute.request` too, so a Console opened later still gets the list.
    private func publishRoute(_ reason: String) {
        let inputs = MicInputs.enumerate()
        let systemDefault = MicInputs.systemDefaultUID()
        let ranked = MicRanking.rank(inputs, explicit: preferredInputUID, lastUsed: lastUsedInputUID, systemDefault: systemDefault)
        let state = readback()
        let route = MicRoute(ranked: ranked, active: activeInputUID, systemDefault: systemDefault, explicit: preferredInputUID, echoCancelled: running && voiceProcessingOn, running: running, state: state)
        let summary = route.summary
        if summary != lastRouteSummary {
            lastRouteSummary = summary
            onStatus?("mic route (\(reason)): \(summary)")
        }
        let info = route.userInfo
        DispatchQueue.main.async { NotificationCenter.default.post(name: .jarheadMicRoute, object: nil, userInfo: info) }
        publish(state, reason: reason)
    }

    /// The Console's picker asks for the route when it appears (`MicRoute.requestName`).
    private func installRouteRequestObserver() {
        routeRequestObserver = NotificationCenter.default.addObserver(forName: MicRoute.requestName, object: nil, queue: nil) { [weak self] _ in
            guard let self else { return }
            self.queue.async { self.publishRoute("picker") }
        }
    }

    private var routeRequestObserver: NSObjectProtocol?

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

// MARK: - microphones: enumeration, ranking, listeners

extension Notification.Name {
    /// The voice engine's microphone route changed (`MicRoute.userInfo`, main queue).
    /// The Console's picker and the ear listen; the raw name is spelled out in
    /// RightRailView.swift, which the Console harness compiles without this file.
    static let jarheadMicRoute = Notification.Name("jarhead.micRoute")
}

/// One input device as Core Audio lists it.
struct MicInput: Equatable {
    let id: AudioDeviceID
    let uid: String
    let name: String
    let transport: UInt32

    var isBuiltIn: Bool { transport == UInt32(kAudioDeviceTransportTypeBuiltIn) }
    /// Aggregate and virtual devices (a loopback, BlackHole, an aggregate Kevin built):
    /// listed, never auto-picked — they carry no room and often no microphone at all.
    var isVirtual: Bool {
        transport == UInt32(kAudioDeviceTransportTypeAggregate) || transport == UInt32(kAudioDeviceTransportTypeAutoAggregate) || transport == UInt32(kAudioDeviceTransportTypeVirtual)
    }

    var transportName: String { MicInput.transportName(transport) }

    /// The transport as one word — shared with `AudioDeviceFacts` (outputs too).
    static func transportName(_ transport: UInt32) -> String {
        switch transport {
        case UInt32(kAudioDeviceTransportTypeBuiltIn): return "built-in"
        case UInt32(kAudioDeviceTransportTypeUSB): return "usb"
        case UInt32(kAudioDeviceTransportTypeBluetooth), UInt32(kAudioDeviceTransportTypeBluetoothLE): return "bluetooth"
        case UInt32(kAudioDeviceTransportTypeAggregate), UInt32(kAudioDeviceTransportTypeAutoAggregate): return "aggregate"
        case UInt32(kAudioDeviceTransportTypeVirtual): return "virtual"
        case UInt32(kAudioDeviceTransportTypeContinuityCaptureWired), UInt32(kAudioDeviceTransportTypeContinuityCaptureWireless): return "continuity"
        case UInt32(kAudioDeviceTransportTypeAirPlay): return "airplay"
        case UInt32(kAudioDeviceTransportTypeHDMI), UInt32(kAudioDeviceTransportTypeDisplayPort): return "display"
        case UInt32(kAudioDeviceTransportTypeThunderbolt), UInt32(kAudioDeviceTransportTypePCI), UInt32(kAudioDeviceTransportTypeFireWire): return "wired"
        default: return "other"
        }
    }
}

/// Core Audio reads, all read-only: the connected input devices, the system default input, a name.
enum MicInputs {
    static func enumerate() -> [MicInput] {
        var out: [MicInput] = []
        for id in AudioEngine.allDeviceIDs() where hasInputStreams(id) && isAlive(id) {
            guard let uid = AudioEngine.deviceUID(id), !uid.isEmpty else { continue }
            // Our own private aggregate is visible to its creator; it is a route, not a microphone.
            if uid == PrivateRoute.uid { continue }
            out.append(MicInput(id: id, uid: uid, name: deviceName(id) ?? uid, transport: transport(id)))
        }
        return out
    }

    static func systemDefaultUID() -> String? {
        var deviceID = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultInputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &deviceID) == noErr, deviceID != 0 else { return nil }
        return AudioEngine.deviceUID(deviceID)
    }

    static func name(of uid: String?) -> String? {
        guard let uid, let id = AudioEngine.deviceID(matching: uid) else { return nil }
        return deviceName(id)
    }

    static func deviceName(_ id: AudioDeviceID) -> String? {
        var addr = AudioObjectPropertyAddress(mSelector: kAudioObjectPropertyName, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        let err = withUnsafeMutablePointer(to: &value) { ptr in AudioObjectGetPropertyData(id, &addr, 0, nil, &size, ptr) }
        guard err == noErr, let cf = value?.takeRetainedValue() else { return nil }
        return cf as String
    }

    private static func hasInputStreams(_ id: AudioDeviceID) -> Bool {
        var addr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams, mScope: kAudioObjectPropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        return AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr && size > 0
    }

    private static func isAlive(_ id: AudioDeviceID) -> Bool {
        var addr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceIsAlive, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var alive: UInt32 = 1
        var size = UInt32(MemoryLayout<UInt32>.size)
        guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &alive) == noErr else { return true }
        return alive != 0
    }

    private static func transport(_ id: AudioDeviceID) -> UInt32 {
        var addr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyTransportType, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var value: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value) == noErr else { return 0 }
        return value
    }
}

/// Which microphone, in what order: Kevin's explicit pick (any kind — an aggregate he
/// asked for is his), then the connected built-in, then the one the graph ran on last,
/// then the system default, then the rest by name, and every aggregate / virtual device
/// last — never excluded, so a Mac whose only inputs are virtual still hears through
/// one (`applyInputDevice` says so). Pure, so the probe and the Console can show the
/// order for the devices at hand.
enum MicRanking {
    static func rank(_ inputs: [MicInput], explicit: String?, lastUsed: String?, systemDefault: String?) -> [MicInput] {
        var out: [MicInput] = []
        func add(_ device: MicInput) { if !out.contains(device) { out.append(device) } }
        let byName: (MicInput, MicInput) -> Bool = { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        if let explicit, let picked = inputs.first(where: { $0.uid == explicit }) { add(picked) }
        for d in inputs.filter({ $0.isBuiltIn && !$0.isVirtual }).sorted(by: byName) { add(d) }
        if let lastUsed, let used = inputs.first(where: { $0.uid == lastUsed && !$0.isVirtual }) { add(used) }
        if let systemDefault, let def = inputs.first(where: { $0.uid == systemDefault && !$0.isVirtual }) { add(def) }
        for d in inputs.filter({ !$0.isVirtual }).sorted(by: byName) { add(d) }
        for d in inputs.filter({ $0.isVirtual }).sorted(by: byName) { add(d) }
        return out
    }
}

/// What the voice engine publishes about its microphones (`.jarheadMicRoute`).
struct MicRoute {
    /// The picker's request for a fresh route when it appears; the raw name is repeated in RightRailView.swift.
    static let requestName = Notification.Name("jarhead.micRoute.request")

    let ranked: [MicInput]
    let active: String?
    let systemDefault: String?
    let explicit: String?
    let echoCancelled: Bool
    let running: Bool
    /// design12: the Hears / Speaks figures and the other mic clients, for the Console's rows.
    let state: AudioStateReadback

    /// "explicit" | "ranked" | "system default (echo cancellation)" | "off".
    var follows: String {
        guard running else { return "off" }
        if echoCancelled { return "system default (echo cancellation)" }
        return explicit != nil && active == explicit ? "explicit" : "ranked"
    }

    var summary: String {
        let list = ranked.map { d -> String in
            var tags = [d.transportName]
            if d.uid == systemDefault { tags.append("default") }
            if d.uid == explicit { tags.append("picked") }
            return "\(d.name) (\(tags.joined(separator: ", ")))"
        }.joined(separator: " › ")
        let activeName = running ? (MicInputs.name(of: active) ?? active ?? "none") : "off"
        return "\(list.isEmpty ? "no input devices" : list); active \(activeName), follows \(follows)"
    }

    /// Plain values only (the Console harness compiles without this file). design12 keys:
    /// `hearsName` String · `hearsRate` Double (Hz, 0 unknown) · `hearsState` String
    /// (`echo cancelled` | `echo guarded` | `no echo cancellation` | `off`) · `speaksName`
    /// String · `speaksRate` Double · `speaksState` String (`full quality` | `narrowed` | "")
    /// · `shared` [String] bundle ids of other processes on the mic — the key is absent
    /// when the HAL cannot say · `rung` Int (0 while stopped) · `duckLevel` Double (absent
    /// while the unit is off) · `hearsUid` · `speaksUid` String.
    var userInfo: [String: Any] {
        var info: [String: Any] = [
            "ids": ranked.map(\.uid),
            "names": ranked.map(\.name),
            "transports": ranked.map(\.transportName),
            "virtual": ranked.filter(\.isVirtual).map(\.uid),
            "active": active ?? "",
            "default": systemDefault ?? "",
            "follows": follows,
            "summary": summary,
            "hearsName": state.hears?.name ?? "",
            "hearsRate": state.hears?.rate ?? 0,
            "hearsState": state.hearsState,
            "speaksName": state.speaks?.name ?? "",
            "speaksRate": state.speaks?.rate ?? 0,
            "speaksState": state.speaksState,
            "rung": state.rung,
            "hearsUid": state.hears?.uid ?? "",
            "speaksUid": state.speaks?.uid ?? "",
        ]
        if let shared = state.sharedWith { info["shared"] = shared }
        if let duck = state.duckLevel { info["duckLevel"] = Double(duck) }
        return info
    }
}

/// Core Audio listeners for the device list, the system default input and output, and
/// (where the HAL has process objects) the list of processes holding devices; `onChange`
/// runs on the queue handed to `start`, with a short reason. Bursts are coalesced by the
/// engine's 50 ms fold (`routeChanged`).
final class MicRouter {
    var onChange: ((String) -> Void)?
    private var queue: DispatchQueue?
    private var block: AudioObjectPropertyListenerBlock?

    /// The selectors watched on the system object, with the reason each one gives.
    private static let watched: [(selector: AudioObjectPropertySelector, reason: String)] = [
        (kAudioHardwarePropertyDevices, "device list changed"),
        (kAudioHardwarePropertyDefaultInputDevice, "default input changed"),
        (kAudioHardwarePropertyDefaultOutputDevice, "default output changed"),
        (kAudioHardwarePropertyProcessObjectList, "mic clients changed"),
    ]

    private static func reason(for selector: AudioObjectPropertySelector) -> String {
        watched.first { $0.selector == selector }?.reason ?? "audio hardware changed"
    }

    /// The addresses that exist on this HAL (the process list is runtime-guarded).
    private static func addresses() -> [AudioObjectPropertyAddress] {
        watched.compactMap { entry in
            var addr = CoreAudioReads.address(entry.selector)
            return AudioObjectHasProperty(CoreAudioReads.system, &addr) ? addr : nil
        }
    }

    func start(on queue: DispatchQueue) {
        guard block == nil else { return }
        self.queue = queue
        let block: AudioObjectPropertyListenerBlock = { [weak self] count, addresses in
            var reasons: [String] = []
            for i in 0 ..< Int(count) {
                let reason = MicRouter.reason(for: addresses[i].mSelector)
                if !reasons.contains(reason) { reasons.append(reason) }
            }
            self?.onChange?(reasons.joined(separator: ", "))
        }
        self.block = block
        for var addr in MicRouter.addresses() {
            AudioObjectAddPropertyListenerBlock(CoreAudioReads.system, &addr, queue, block)
        }
    }

    func stop() {
        guard let block, let queue else { return }
        for var addr in MicRouter.addresses() {
            AudioObjectRemovePropertyListenerBlock(CoreAudioReads.system, &addr, queue, block)
        }
        self.block = nil
    }
}

// MARK: - barge-in duck

/// The barge-in duck: the instant the microphone hears Kevin over Jarhead's voice, the
/// speaker comes down 20 dB — before GPT-Live-1 has noticed the interruption (its own
/// stop lands ~1.4 s later on the public model) — and comes back once he has finished,
/// or after 700 ms when nothing follows (a cough, a chair). The microphone is never
/// touched; only the player's volume moves.
///
/// Inputs, from five threads: the mono mic tap in 10 ms slices (`noteMic`, the tap
/// thread), what the speaker has queued (`noteOutput` / `noteFlush`, the audio queue),
/// Live's transcript of Kevin and Jarhead's own recent words (`noteLiveHeardKevin`,
/// `noteJarheadSaid`, main), the engine's phase (`noteVoiceSpeaking`, main) and the
/// ear's partials (`noteEarWords`, the ear queue). One lock guards the state; the gain
/// steps and the timers run on `queue`.
///
/// Onset: speech energy over the room floor for ≥ 60 ms (six slices), judged inside the
/// 100 ms tap buffer, while the player has audible output queued (or had within the last
/// 300 ms — the queue is modelled from the seconds scheduled, so a network burst that
/// hands the player half a second at once keeps the gate armed until it has played) —
/// or the ear's words, or Live's transcript of Kevin, each with energy the gate saw in
/// the last 300 ms, whichever comes first. The gain reaches 0.1 (−20 dB) in three 4 ms
/// steps.
///
/// Confirmation — Live heard Kevin too — in the order it can arrive: the ear's partial
/// carrying a word Jarhead did not just say (100–200 ms; a partial made only of words
/// from Jarhead's own transcript may be residual echo and confirms nothing), Kevin's
/// non-final item growing in the snapshot's transcript (Live's
/// `session.input_transcript.delta`, typically around a second), the phase leaving
/// `speaking` (≥ 1.2 s after Jarhead's last words: a fallback).
///
/// Release: confirmed, when the mic has been quiet 250 ms (capped at 4 s), a 300 ms ramp
/// back to 1 and a 500 ms hold-off. Unconfirmed at 700 ms with the mic gone quiet: a
/// cough — the ramp, and a 1 s hold-off (3 s after two in ten seconds). A mic still hot
/// at 700 ms is not a cough and not Jarhead's echo (that dropped 20 dB with the
/// speaker): the deadline extends 100 ms at a time to 1.5 s from the duck — about when
/// Live's own stop lands — then the ramp and the hold-off. After an unconfirmed release
/// the floor takes the level that tripped the gate, so a fan that switched on ducks once,
/// not every few seconds (the floor falls again the moment the room is quieter).
///
/// Off without echo cancellation: the gate would hear Jarhead and duck Jarhead.
final class BargeInDuck: @unchecked Sendable {
    static let shared = BargeInDuck()

    /// −20 dB.
    static let duckGain: Float = 0.1
    static let sliceSeconds = 0.01
    /// Six 10 ms slices: 60 ms of speech energy.
    static let onsetSlices = 6
    /// The first look at a duck nobody confirmed.
    static let confirmWindow: TimeInterval = 0.7
    /// While the mic stays hot, the unconfirmed deadline moves on by this much at a time…
    static let extendStep: TimeInterval = 0.1
    /// …up to this long from the duck (GPT-Live-1's own stop on barge-in is ~1.4 s).
    static let unconfirmedCap: TimeInterval = 1.5
    /// A hot slice this recent at the deadline means he is still talking (a pause between
    /// phrases, plus the tap's 100 ms delivery, fits inside it).
    static let stillSpeakingWindow: TimeInterval = 0.3
    static let releaseSeconds: TimeInterval = 0.3
    /// The gate stays armed this long after the last audible sample the player has queued.
    static let armTail: TimeInterval = 0.3
    static let quietHold: TimeInterval = 0.25
    static let maxDuck: TimeInterval = 4
    /// Below this RMS nothing is speech whatever the floor says (residual echo after AEC sits under it).
    static let minimumHotRMS = 0.008
    static let floorFactor = 3.0
    /// Over the mic level measured while Jarhead speaks unducked (residual echo), by this factor.
    static let echoFactor = 2.5
    /// The engine's AUDIBLE_OUTPUT_LEVEL: the silence the API streams between sentences is ~0.
    static let audibleOutput = 0.02
    static let holdoff: TimeInterval = 1
    static let longHoldoff: TimeInterval = 3
    /// After every release, confirmed or not, at least this long before the next duck.
    static let releaseHoldoff: TimeInterval = 0.5
    /// The ear's words and Live's transcript count as an onset only with energy this recent.
    static let earEnergyWindow: TimeInterval = 0.3
    /// A word this long that Jarhead did not just say is what lets a partial confirm.
    static let novelWordMinLength = 3

    enum Event {
        /// The gain reached −20 dB; `latencyMs` is from the first hot slice's capture time (or the ear's cue).
        case ducked(source: String, latencyMs: Double)
        case confirmed(String)
        /// The 700 ms deadline moved on because the mic was still hot; `afterMs` since the duck.
        case extended(afterMs: Double)
        /// A partial made only of Jarhead's own words was not taken as confirmation.
        case refusedWords(String)
        /// Back at unity; `afterMs` since the duck.
        case released(String, afterMs: Double)
    }
    /// Harnesses and the log; called on `queue`.
    var onEvent: ((Event) -> Void)?

    struct Stats {
        var ducks = 0
        var confirmed = 0
        var unconfirmed = 0
        /// Unconfirmed ducks held past 700 ms because the mic stayed hot.
        var held = 0
        /// Partials refused as confirmation (Jarhead's own words).
        var refusedWords = 0
    }

    private enum State {
        case idle
        case ducked(since: CFAbsoluteTime, onsetHost: UInt64, confirmed: Bool)
        case releasing
    }

    private let lock = NSLock()
    private let queue = DispatchQueue(label: "jarhead.duck", qos: .userInteractive)
    private var gain: ((Float) -> Void)?
    private var echoCancelled = false
    private var state: State = .idle
    private var currentGain: Float = 1
    /// The room: falls to any quieter slice at once, rises with a ~20 s time constant.
    private var floor = 0.02
    /// The mic while Jarhead speaks unducked and nobody else does: residual echo.
    private var echoFloor = 0.0
    private var hotRun = 0
    private var hotSinceHost: UInt64 = 0
    private var lastHotHost: UInt64 = 0
    /// The player's queue as scheduled: when the last sample handed over will have played,
    /// and when the last *audible* one will have (silence between sentences arms nothing).
    private var queueEnd: CFAbsoluteTime = 0
    private var audibleUntil: CFAbsoluteTime = 0
    private var voiceSpeaking = false
    private var holdoffUntil: CFAbsoluteTime = 0
    private var unconfirmedAt: [CFAbsoluteTime] = []
    /// Whether the current duck's deadline has been extended at least once.
    private var extendedThisDuck = false
    /// Hot slices during the current duck: the level that tripped the gate, for the floor when nothing confirms.
    private var hotSum = 0.0
    private var hotCount = 0
    /// Jarhead's recent words (lowercased, ≥ `novelWordMinLength`), from the snapshot's transcript.
    private var jarheadWords: Set<String> = []
    /// Bumped by every state change that invalidates queued timers.
    private var generation = 0
    private var stats = Stats()

    // MARK: wiring

    /// The graph is up: `gain` sets the player's volume. Called on the audio queue.
    func attach(echoCancelled: Bool, gain: @escaping (Float) -> Void) {
        lock.lock()
        self.gain = gain
        self.echoCancelled = echoCancelled
        state = .idle
        currentGain = 1
        generation += 1
        hotRun = 0
        queueEnd = 0
        audibleUntil = 0
        lock.unlock()
        queue.async { gain(1) }
    }

    /// The graph is going down: unity first, then no player to drive.
    func detach() {
        lock.lock()
        let gain = self.gain
        self.gain = nil
        state = .idle
        currentGain = 1
        generation += 1
        queueEnd = 0
        audibleUntil = 0
        lock.unlock()
        if let gain { queue.async { gain(1) } }
    }

    /// Harnesses: forget floors, hold-offs, words and counts between runs.
    func resetForHarness() {
        lock.lock()
        state = .idle
        currentGain = 1
        floor = 0.02
        echoFloor = 0
        hotRun = 0
        hotSinceHost = 0
        lastHotHost = 0
        queueEnd = 0
        audibleUntil = 0
        voiceSpeaking = false
        holdoffUntil = 0
        unconfirmedAt.removeAll()
        extendedThisDuck = false
        hotSum = 0
        hotCount = 0
        jarheadWords.removeAll()
        generation += 1
        stats = Stats()
        let gain = self.gain
        lock.unlock()
        if let gain { queue.async { gain(1) } }
    }

    var currentStats: Stats {
        lock.lock(); defer { lock.unlock() }
        return stats
    }

    /// For the mic diag line: empty until something has happened.
    func diagSuffix() -> String {
        let s = currentStats
        guard s.ducks > 0 else { return "" }
        return ", duck \(s.ducks) (\(s.confirmed) confirmed, \(s.unconfirmed) unconfirmed, \(s.held) held past 700 ms, \(s.refusedWords) echo partials refused)"
    }

    // MARK: inputs

    /// What the speaker is about to play (the audio queue): `seconds` of audio at `rms`,
    /// queued behind whatever is still playing.
    func noteOutput(rms: Double, seconds: TimeInterval) {
        guard seconds.isFinite, seconds > 0 else { return }
        lock.lock()
        let now = CFAbsoluteTimeGetCurrent()
        queueEnd = max(queueEnd, now) + seconds
        if rms >= BargeInDuck.audibleOutput { audibleUntil = queueEnd }
        lock.unlock()
    }

    /// The speaker backlog was dropped (a stop, a barge-in the engine confirmed): nothing queued is audible any more.
    func noteFlush() {
        lock.lock()
        let now = CFAbsoluteTimeGetCurrent()
        queueEnd = now
        audibleUntil = min(audibleUntil, now)
        lock.unlock()
    }

    /// True when no audible output is queued and none has been for `seconds` (the policy
    /// flip's deferral asks this so a rebuild does not cut Jarhead mid-sentence).
    func outputQuiet(for seconds: TimeInterval) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return CFAbsoluteTimeGetCurrent() >= audibleUntil + seconds
    }

    /// The engine's phase entered or left `speaking` (main queue). Leaving it while ducked
    /// unconfirmed is a confirmation: Live heard Kevin too. A fallback — the phase leaves
    /// `speaking` 1.2 s after Jarhead's last words at the earliest.
    func noteVoiceSpeaking(_ speaking: Bool) {
        lock.lock()
        let was = voiceSpeaking
        voiceSpeaking = speaking
        var confirm = false
        if was, !speaking, case .ducked(_, _, false) = state { confirm = true }
        if confirm { confirmLocked("voice stopped") }
        lock.unlock()
    }

    /// Jarhead's recent words as the snapshot's transcript has them (main queue): a
    /// partial made only of these may be his echo and confirms nothing.
    func noteJarheadSaid(_ text: String) {
        let words = BargeInDuck.words(of: text)
        lock.lock()
        jarheadWords = words
        lock.unlock()
    }

    /// Live's transcript of Kevin grew (a new or longer non-final item in the snapshot,
    /// main queue): the confirmation when the ear is off. With the room still hot and the
    /// speaker audible it is also an onset — confirmed at once, through any hold-off:
    /// Live's word outranks the gate's caution.
    func noteLiveHeardKevin() {
        lock.lock()
        switch state {
        case .ducked(_, _, false):
            confirmLocked("live transcript")
        case .idle, .releasing:
            let now = CFAbsoluteTimeGetCurrent()
            if recentEnergyLocked(), echoCancelled, gain != nil, outputAudibleLocked(now) {
                duckLocked(source: "live transcript", onsetHost: lastHotHost, confirmed: true)
            }
        case .ducked:
            break
        }
        lock.unlock()
    }

    /// The ear produced words (a partial that grew), on the ear queue. With a word
    /// Jarhead did not just say they are an onset (confirmed at once) or the confirmation;
    /// made only of his words they are left to the gate — residual echo says his words.
    func noteEarWords(_ text: String) {
        lock.lock()
        let novel = hasNovelWordLocked(text)
        switch state {
        case .idle, .releasing:
            if novel, recentEnergyLocked(), armedLocked() { duckLocked(source: "ear words", onsetHost: hotRun > 0 ? hotSinceHost : lastHotHost, confirmed: true) }
        case .ducked(_, _, false):
            if novel {
                confirmLocked("ear words")
            } else {
                stats.refusedWords += 1
                queue.async { [weak self] in self?.onEvent?(.refusedWords(text)) }
            }
        case .ducked:
            break
        }
        lock.unlock()
    }

    /// The mono microphone buffer (the tap thread): 10 ms slices, floor, onset.
    func noteMic(mono: UnsafePointer<Float>, frames: Int, sampleRate: Double, capturedAt: AVAudioTime) {
        guard frames > 0, sampleRate > 0 else { return }
        let slice = max(1, Int(sampleRate * BargeInDuck.sliceSeconds))
        let startHost = capturedAt.isHostTimeValid ? capturedAt.hostTime : mach_absolute_time() &- AVAudioTime.hostTime(forSeconds: Double(frames) / sampleRate)
        lock.lock()
        defer { lock.unlock() }
        guard echoCancelled, gain != nil else { return }
        let now = CFAbsoluteTimeGetCurrent()
        let outputAudible = outputAudibleLocked(now)
        var offset = 0
        while offset < frames {
            let n = min(slice, frames - offset)
            var acc = 0.0
            for i in offset ..< offset + n { acc += Double(mono[i] * mono[i]) }
            let rms = clampLevel((acc / Double(n)).squareRoot())
            offset += n
            // The room, and the residual echo of Jarhead's own voice while it plays unducked.
            if rms < floor { floor = rms } else { floor += (rms - floor) * 0.0005 }
            if outputAudible, case .idle = state {
                if rms > echoFloor { echoFloor += (rms - echoFloor) * 0.02 } else { echoFloor *= 0.995 }
            } else if !outputAudible {
                echoFloor *= 0.999
            }
            let threshold = max(floor * BargeInDuck.floorFactor, BargeInDuck.minimumHotRMS, echoFloor * BargeInDuck.echoFactor)
            let sliceHost = startHost &+ AVAudioTime.hostTime(forSeconds: Double(offset - n) / sampleRate)
            if rms > threshold {
                if hotRun == 0 { hotSinceHost = sliceHost }
                hotRun += 1
                lastHotHost = sliceHost &+ AVAudioTime.hostTime(forSeconds: Double(n) / sampleRate)
                if case .ducked = state {
                    hotSum += rms
                    hotCount += 1
                }
                if hotRun == BargeInDuck.onsetSlices, armedLocked() {
                    switch state {
                    case .idle, .releasing: duckLocked(source: "gate", onsetHost: hotSinceHost, confirmed: false)
                    case .ducked: break
                    }
                }
            } else {
                hotRun = 0
            }
        }
    }

    // MARK: the machine (under `lock`)

    /// Audible output is queued, or was within `armTail`.
    private func outputAudibleLocked(_ now: CFAbsoluteTime) -> Bool {
        now < audibleUntil + BargeInDuck.armTail
    }

    /// The gate saw speech energy within `earEnergyWindow`.
    private func recentEnergyLocked() -> Bool {
        guard lastHotHost > 0 else { return false }
        let nowHost = mach_absolute_time()
        return nowHost < lastHotHost || AVAudioTime.seconds(forHostTime: nowHost - lastHotHost) < BargeInDuck.earEnergyWindow
    }

    /// Seconds since the last hot slice; infinite when none was seen.
    private func quietForLocked() -> TimeInterval {
        guard lastHotHost > 0 else { return .infinity }
        let nowHost = mach_absolute_time()
        return nowHost < lastHotHost ? 0 : AVAudioTime.seconds(forHostTime: nowHost - lastHotHost)
    }

    /// Words of `text`, lowercased, letters and digits only, at least `novelWordMinLength` long.
    static func words(of text: String) -> Set<String> {
        var out: Set<String> = []
        for piece in text.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber }) where piece.count >= novelWordMinLength {
            out.insert(String(piece))
        }
        return out
    }

    /// True when `text` has a word Jarhead did not just say (or nothing of his is known yet).
    private func hasNovelWordLocked(_ text: String) -> Bool {
        let words = BargeInDuck.words(of: text)
        guard !words.isEmpty else { return false }
        guard !jarheadWords.isEmpty else { return true }
        return words.contains { !jarheadWords.contains($0) }
    }

    private func armedLocked() -> Bool {
        guard echoCancelled, gain != nil else { return false }
        let now = CFAbsoluteTimeGetCurrent()
        guard now >= holdoffUntil else { return false }
        return outputAudibleLocked(now)
    }

    private func duckLocked(source: String, onsetHost: UInt64, confirmed: Bool) {
        let now = CFAbsoluteTimeGetCurrent()
        state = .ducked(since: now, onsetHost: onsetHost, confirmed: confirmed)
        generation += 1
        let gen = generation
        stats.ducks += 1
        if confirmed { stats.confirmed += 1 }
        extendedThisDuck = false
        hotSum = 0
        hotCount = 0
        guard let gain else { return }
        // Three steps, 4 ms apart: −20 dB within one render cycle or two, without a click.
        let steps: [Float] = [0.5, 0.25, BargeInDuck.duckGain]
        for (i, g) in steps.enumerated() {
            queue.asyncAfter(deadline: .now() + .milliseconds(4 * i)) { [weak self] in
                guard let self, self.stillCurrent(gen) else { return }
                gain(g)
                self.setGain(g)
                if i == steps.count - 1 {
                    let nowHost = mach_absolute_time()
                    let ms = nowHost > onsetHost ? AVAudioTime.seconds(forHostTime: nowHost - onsetHost) * 1000 : 0
                    self.onEvent?(.ducked(source: source, latencyMs: ms.isFinite ? ms : 0))
                }
            }
        }
        if confirmed {
            // Already Live's word: release when he has finished.
            queue.async { [weak self] in
                self?.onEvent?(.confirmed(source))
                self?.pollRelease(gen, source: source)
            }
        } else {
            // Nothing follows within 700 ms and the mic is quiet: a cough. Back up, and hold off.
            queue.asyncAfter(deadline: .now() + BargeInDuck.confirmWindow) { [weak self] in
                self?.unconfirmedDeadline(gen)
            }
        }
    }

    private func confirmLocked(_ source: String) {
        guard case .ducked(let since, let onset, false) = state else { return }
        state = .ducked(since: since, onsetHost: onset, confirmed: true)
        stats.confirmed += 1
        let gen = generation
        queue.async { [weak self] in
            self?.onEvent?(.confirmed(source))
            self?.pollRelease(gen, source: source)
        }
    }

    private func stillCurrent(_ gen: Int) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return gen == generation && gain != nil
    }

    private func setGain(_ g: Float) {
        lock.lock()
        currentGain = g
        lock.unlock()
    }

    /// On `queue`: the deadline for a duck nobody confirmed — 700 ms, moved on while the
    /// mic stays hot (he is still talking; Jarhead's echo dropped with the speaker) up to
    /// 1.5 s, unless two ducks in ten seconds already went unconfirmed.
    private func unconfirmedDeadline(_ gen: Int) {
        lock.lock()
        guard gen == generation, case .ducked(let since, _, false) = state else { lock.unlock(); return }
        let now = CFAbsoluteTimeGetCurrent()
        let stillSpeaking = quietForLocked() < BargeInDuck.stillSpeakingWindow
        let recentUnconfirmed = unconfirmedAt.filter { now - $0 < 10 }.count
        if stillSpeaking, now - since + BargeInDuck.extendStep <= BargeInDuck.unconfirmedCap + 0.001, recentUnconfirmed < 2 {
            if !extendedThisDuck {
                extendedThisDuck = true
                stats.held += 1
            }
            lock.unlock()
            onEvent?(.extended(afterMs: (now - since) * 1000))
            queue.asyncAfter(deadline: .now() + BargeInDuck.extendStep) { [weak self] in self?.unconfirmedDeadline(gen) }
            return
        }
        stats.unconfirmed += 1
        unconfirmedAt = unconfirmedAt.filter { now - $0 < 10 } + [now]
        holdoffUntil = now + (unconfirmedAt.count >= 2 ? BargeInDuck.longHoldoff : BargeInDuck.holdoff)
        // The level that tripped the gate is the floor now, until the room is quieter than it.
        if hotCount > 0 { floor = max(floor, min(1, (hotSum / Double(hotCount)) / BargeInDuck.floorFactor)) }
        let held = extendedThisDuck
        lock.unlock()
        beginRelease(held ? "unconfirmed, held to \(Int(((now - since) * 1000).rounded())) ms" : "unconfirmed at 700 ms", since: since)
    }

    /// On `queue`: once confirmed, release when the mic has been quiet a while (or at the cap).
    private func pollRelease(_ gen: Int, source: String) {
        lock.lock()
        guard gen == generation, case .ducked(let since, _, true) = state else { lock.unlock(); return }
        let now = CFAbsoluteTimeGetCurrent()
        let quietFor = quietForLocked()
        let done = quietFor >= BargeInDuck.quietHold || now - since >= BargeInDuck.maxDuck
        lock.unlock()
        if done {
            beginRelease(quietFor >= BargeInDuck.quietHold ? "quiet after \(source)" : "capped at 4 s", since: since)
        } else {
            queue.asyncAfter(deadline: .now() + .milliseconds(50)) { [weak self] in self?.pollRelease(gen, source: source) }
        }
    }

    /// On `queue`: the 300 ms ramp back to unity, 15 ms a step, and a hold-off after it.
    private func beginRelease(_ why: String, since: CFAbsoluteTime) {
        lock.lock()
        state = .releasing
        generation += 1
        let gen = generation
        let from = currentGain
        let gain = self.gain
        holdoffUntil = max(holdoffUntil, CFAbsoluteTimeGetCurrent() + BargeInDuck.releaseHoldoff)
        lock.unlock()
        guard let gain else { return }
        let steps = max(1, Int(BargeInDuck.releaseSeconds / 0.015))
        for i in 1 ... steps {
            queue.asyncAfter(deadline: .now() + .milliseconds(15 * i)) { [weak self] in
                guard let self, self.stillCurrent(gen) else { return }
                let t = Float(i) / Float(steps)
                // Ease out: most of the level comes back early, the tail is smooth.
                let eased = 1 - (1 - t) * (1 - t)
                let g = from + (1 - from) * eased
                gain(g)
                self.setGain(g)
                if i == steps {
                    self.lock.lock()
                    if gen == self.generation { self.state = .idle }
                    self.lock.unlock()
                    self.onEvent?(.released(why, afterMs: (CFAbsoluteTimeGetCurrent() - since) * 1000))
                }
            }
        }
    }
}
