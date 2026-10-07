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
/// `AudioStateReadback` (`onAudioState`), never assumed. `jarhead.audio` schedules the
/// speaker, so the state frame's HAL reads (the 5 s tick, route changes, the picker) run on
/// `AudioStateReader`'s own queue. Start and mute still make a few HAL calls here: the guard's
/// tail (output latency, default output), the ranked mic (the input list), a failed start's
/// device names, and the process input mute.
/// The speaker keeps a playout cushion (`SpeakerScheduler`, `PlayoutModel`) so a late chunk
/// is absorbed instead of heard as a hole.
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
    private var rebuildPending = false
    /// The private aggregate the unit runs on (probe-only rungs; `PrivateRoute.enabled`).
    private var privateRoute: PrivateRoute?
    /// The frame and the microphone route, read on their own queue (the HAL never runs on `queue`).
    private let stateReader = AudioStateReader()
    /// The speaker path: PCM16 → the player behind the playout cushion. On `queue`.
    private lazy var speaker = SpeakerScheduler(player: player, format: playFormat)
    /// The speaker's figures for the frame (voice PLAN W1.5): written on `queue`, read on the reader's.
    private let telemetry = PlaybackTelemetry()
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
    /// Called on `AudioStateReader`'s queue. The app forwards it to the daemon and the island.
    var onAudioState: ((AudioStateReadback) -> Void)?

    var isRunning: Bool { queue.sync { running } }

    init() {
        configObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self] _ in
            self?.restartAfterConfigurationChange()
        }
        // The guard's hold beginning or ending is a state the island shows (the mic box dims).
        // Twice per sentence: only the guard's own fields are refreshed, on the reader's queue.
        EchoGuard.shared.onHeldChange = { [weak self] _ in
            self?.stateReader.refreshCounters("guard")
        }
        // The device list, the default devices and the process list, watched from the start
        // on the reader's queue: a microphone that vanishes mid-session is rebuilt around on
        // the next-ranked one (`restartForRoute`), and the Console's mic picker learns the
        // ranked list.
        stateReader.onAudioState = { [weak self] state in self?.onAudioState?(state) }
        stateReader.onStatus = { [weak self] text in self?.onStatus?(text) }
        stateReader.onRestart = { [weak self] verdict in
            self?.queue.async { self?.restartForRoute(verdict) }
        }
        // The playout, duck and output objects ride every frame, each read under its own lock.
        stateReader.counters = { [telemetry] in
            let speaker = telemetry.readback()
            return AudioCounters(playout: speaker?.playout, duck: BargeInDuck.shared.telemetry(), output: speaker?.output)
        }
        // A frame went out: `lateMaxMs` and `queuedMinMs` start a new window (PLAN §3).
        stateReader.published = { [telemetry] in telemetry.closeWindow() }
        stateReader.start()
    }

    deinit {
        if let configObserver { NotificationCenter.default.removeObserver(configObserver) }
        stateReader.stop()
    }

    // MARK: - control

    func start() {
        queue.async {
            self.wanted = true
            self.retryAttempt = 0
            self.telemetry.resetDropped()
            // The `earcon held` figure counts from here: `awake` holds the first wire chunks of this graph.
            EarconWire.shared.resetCounters()
            self.startLocked()
        }
    }

    func stop() {
        queue.async {
            self.wanted = false
            self.stopLocked()
        }
    }

    /// Barge-in / stop: drop everything queued for the speaker. The mixer fades out first
    /// (`SpeakerScheduler.flushFade`, 30 ms) so the cut does not click, and comes back 20 ms
    /// after the drop, under the next stream's pre-roll; a chunk that arrives meanwhile is the
    /// next reply and plays after it, behind the cushion.
    func flush() {
        queue.async {
            guard self.running else { return }
            // Nothing queued is audible any more: the duck's gate disarms with the backlog,
            // and the echo guard's audible window ends with it.
            BargeInDuck.shared.noteFlush()
            EchoGuard.shared.noteFlush()
            VoiceOutputClock.shared.noteFlush()
            var token: Int?
            // The player and the mixer raise (not throw) when the engine has just stopped itself
            // under them; the engine is about to be restarted anyway, so log and move on.
            self.guardPlayer("flush") { token = self.speaker.beginFlush() }
            guard let token else { return }
            self.queue.asyncAfter(deadline: .now() + SpeakerScheduler.flushFade) { [weak self] in
                self?.finishFlush(token)
            }
        }
    }

    /// On `queue`: the fade is over — drop the backlog, then whatever arrived meanwhile; the
    /// mixer comes back once its converter has drained.
    private func finishFlush(_ token: Int) {
        var resumed: [SpeakerScheduler.Scheduled] = []
        guardPlayer("flush") {
            resumed = self.speaker.finishFlush(token: token, engineRunning: self.running && self.engine.isRunning)
        }
        for chunk in resumed { noteSpeaker(chunk) }
        queue.asyncAfter(deadline: .now() + SpeakerScheduler.flushRestore) { [weak self] in
            self?.guardPlayer("flush") { self?.speaker.restoreAfterFlush(token: token) }
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
            } else {
                // Asleep: no start or stop pushes the pick, so the picker's ranking takes it now.
                self.stateReader.choices(preferredInputUID: value, recording: !self.wantedPolicy.echoCancel, reason: "picker")
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
                // Stopped: the next start walks the new policy's ladder from the top, and the
                // frame says Recording now.
                self.winningRung = nil
                self.stateReader.choices(preferredInputUID: self.preferredInputUID, recording: !p.echoCancel, reason: "policy")
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
                stateReader.update(localFacts(), reason: "policy", readHAL: false)
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
            self.stateReader.update(self.localFacts(), reason: muted ? "muted" : "unmuted", readHAL: true)
        }
    }

    /// What the graph is, from in-process reads only — the flags, the unit's own properties,
    /// the guard's counters; the HAL half is `AudioStateReader`'s. On `queue`.
    private func localFacts() -> AudioLocalFacts {
        let input = engine.inputNode
        var l = AudioLocalFacts()
        var knobs: VoiceProcessingKnobs.Readback?
        try? objcTry {
            l.voiceProcessing = input.isVoiceProcessingEnabled
            if l.voiceProcessing { knobs = VoiceProcessingKnobs.read(input) }
        }
        l.running = running
        l.duckLevel = knobs?.duckLevel
        l.advancedDucking = knobs?.advanced
        l.agc = knobs?.agc
        l.bypassed = knobs?.bypassed
        l.rung = running ? currentRung : 0
        l.wiring = running ? currentWiring.description : ""
        l.tapFormat = running ? currentTapFormat : ""
        l.recording = !wantedPolicy.echoCancel
        l.fallback = running && !l.voiceProcessing && wantedPolicy.echoCancel
        l.tailMs = currentTailMs
        l.refreshGuard()
        l.privateRouteMicUID = running ? privateRoute?.micUID : nil
        l.activeInputUID = activeInputUID
        l.currentDevice = running && !l.voiceProcessing ? AudioEngine.currentDevice(of: input) : nil
        l.preferredInputUID = preferredInputUID
        l.lastUsedInputUID = lastUsedInputUID
        l.echoCancelled = running && voiceProcessingOn
        return l
    }

    /// The input AU's `kAudioOutputUnitProperty_CurrentDevice`, or nil.
    static func currentDevice(of input: AVAudioInputNode) -> AudioDeviceID? {
        guard let au = input.audioUnit else { return nil }
        var dev = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        guard AudioUnitGetProperty(au, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &dev, &size) == noErr, dev != 0 else { return nil }
        return dev
    }

    /// Speaker PCM16 mono 24 kHz from the daemon, scheduled behind the playout cushion
    /// (`SpeakerScheduler`): silence in front of the first chunk of a stream, a fade-in after
    /// any silence, contiguous otherwise.
    func play(pcm: Data) {
        let enqueued = DispatchTime.now().uptimeNanoseconds
        queue.async {
            guard self.running, self.engine.isRunning else {
                self.telemetry.noteDropped(seconds: Double(pcm.count / 2) / self.wireFormat.sampleRate)
                return
            }
            // How long this block waited behind others on the speaker's queue.
            self.telemetry.noteLate(Double(DispatchTime.now().uptimeNanoseconds &- enqueued) / 1e9)
            var scheduled: SpeakerScheduler.Scheduled?
            self.guardPlayer("schedule") { scheduled = self.speaker.schedule(pcm: pcm) }
            if let scheduled { self.noteSpeaker(scheduled) }
        }
    }

    /// What the speaker is about to say, for the barge-in duck, the echo guard and the earcons'
    /// drain rule (`VoiceOutputClock`): the pre-roll as a silent stretch, then the chunk. GPT-Live-1
    /// streams silence between sentences too, so audibility (not arrival) is what arms them. On `queue`.
    private func noteSpeaker(_ chunk: SpeakerScheduler.Scheduled) {
        telemetry.noteScheduled(chunk, model: speaker.model, gain: BargeInDuck.shared.gainNow)
        if chunk.prerollSeconds > 0 {
            BargeInDuck.shared.noteOutput(rms: 0, seconds: chunk.prerollSeconds)
            EchoGuard.shared.noteOutput(rms: 0, seconds: chunk.prerollSeconds)
            VoiceOutputClock.shared.noteOutput(rms: 0, seconds: chunk.prerollSeconds)
        }
        BargeInDuck.shared.noteOutput(rms: chunk.rms, seconds: chunk.seconds)
        EchoGuard.shared.noteOutput(rms: chunk.rms, seconds: chunk.seconds)
        VoiceOutputClock.shared.noteOutput(rms: chunk.rms, seconds: chunk.seconds)
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
        onStatus?(quiet ? "audio start deferred: \(why) — retrying in \(when)" : "audio failed to start: \(why). Retrying in \(when)")
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
        // A new stream on a new graph: the cushion's counters start here, the mixer at unity.
        let mixer = engine.mainMixerNode
        try? objcTry { self.speaker.restart(mixer: mixer) }
        var mixFormat = ""
        try? objcTry {
            let f = mixer.outputFormat(forBus: 0)
            mixFormat = "\(Int(f.sampleRate)) Hz ×\(f.channelCount)"
        }
        telemetry.restart(mixFormat: mixFormat)
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
        stateReader.route(localFacts(), reason: "audio running")
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

    /// `baseTail + the output's presentation latency (+ the Bluetooth allowance)`, clamped (`EchoGuardModel.tail`).
    private func guardTail(latency: Double, speaks: AudioDeviceFacts?) -> Double {
        EchoGuardModel.tail(latency: latency, bluetooth: speaks?.isBluetooth == true)
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
            self.speaker.cancelFlush()
        }
        // The backlog went with the player: nothing of the voice is audible any more (the earcons' drain rule).
        VoiceOutputClock.shared.noteFlush()
        if running { logPlayout() }
        releaseVoiceProcessing()
        running = false
        activeInputUID = nil
        currentRung = 0
        currentTapFormat = ""
        stateReader.route(localFacts(), reason: "audio stopped")
    }

    /// The cushion's counters for this graph, once at its stop (zero-cushion's count beside them).
    private func logPlayout() {
        let st = speaker.model.stats
        guard st.chunks > 0 else { return }
        let gap = String(format: "%.0f", PlayoutModel.ms(st.underrunFrames))
        let longest = String(format: "%.0f", PlayoutModel.ms(st.longestUnderrunFrames))
        let target = String(format: "%.0f", PlayoutModel.ms(speaker.model.targetFrames))
        onStatus?("playout: \(st.chunks) chunks, \(st.underruns) underruns (\(gap) ms, longest \(longest) ms; zero-cushion would be \(st.wouldBeUnderruns)), \(st.resets) resets, target \(target) ms")
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
        // The session's edge (both policies): `awake`, and whatever the edge faded (`Earcons.enterVoice`), play
        // outside the unit's echo reference, so the chunks captured before they and the guard's tail have passed
        // are held the same way (`EarconWire`).
        let earconHeld = EarconWire.shared.judgeChunk(at: CFAbsoluteTimeGetCurrent(), seconds: Double(frames) / rate)

        guard let out = convertToWire(mono, format: monoFormat, frames: frames, channels: channels) else { return }
        guard out.frameLength > 0, let ch = out.int16ChannelData?[0] else { return }
        // Held: zero-filled, not dropped — the wire keeps its 100 ms cadence and Live's
        // timeline does not jump. What reaches the wire is what the Input meter shows.
        if verdict == .hold || earconHeld { memset(ch, 0, Int(out.frameLength) * 2) }
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
            // The counters only, on the reader's queue: the speaker's queue never waits on the HAL.
            stateReader.refreshCounters("tick")
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

    // MARK: - route changes (judged on the reader's queue, acted on here)

    /// A route verdict from `AudioStateReader` (a vanished microphone, the picked one back on
    /// the plain path), checked again here before anything stops: the graph must still be up
    /// and still on the microphone the verdict saw. An `AVAudioEngineConfigurationChange`
    /// usually arrives for the same event; `restartPending` folds the two into one restart
    /// 0.3 s after the first. The system default is never written. On `queue`.
    private func restartForRoute(_ verdict: AudioStateReader.RouteRestart) {
        guard wanted, running, !restartPending, activeInputUID == verdict.activeInputUID else { return }
        restartPending = true
        onStatus?("mic route: \(verdict.why) — restarting in 0.3 s")
        stopLocked()
        try? objcTry { self.engine.reset() }
        queue.asyncAfter(deadline: .now() + 0.3) {
            self.restartPending = false
            guard self.wanted, !self.running else { return }
            self.retryAttempt = 0
            self.startLocked()
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

    /// "explicit" | "ranked" | "system default (echo cancellation)" | "system default (ranked mic refused)" | "off".
    /// The last one: the plain graph's unpinned rung won (`applyInputDevice`: `ranked mic refused; hearing the
    /// system default`) — the Console's route word then says `follows the system default`, not `ranked`.
    var follows: String {
        guard running else { return "off" }
        if echoCancelled { return "system default (echo cancellation)" }
        if explicit != nil && active == explicit { return "explicit" }
        if let active, active == systemDefault, let first = ranked.first, first.uid != active { return "system default (ranked mic refused)" }
        return "ranked"
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
/// runs on the queue handed to `start`, with a short reason. Bursts are coalesced by
/// `AudioStateReader` (a 50 ms fold; the process list at most once per 2 s).
final class MicRouter {
    var onChange: ((String) -> Void)?
    private var queue: DispatchQueue?
    private var block: AudioObjectPropertyListenerBlock?

    /// The process list's reason: another app took or let go of a microphone.
    static let clientsReason = "mic clients changed"

    /// The selectors watched on the system object, with the reason each one gives.
    private static let watched: [(selector: AudioObjectPropertySelector, reason: String)] = [
        (kAudioHardwarePropertyDevices, "device list changed"),
        (kAudioHardwarePropertyDefaultInputDevice, "default input changed"),
        (kAudioHardwarePropertyDefaultOutputDevice, "default output changed"),
        (kAudioHardwarePropertyProcessObjectList, clientsReason),
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
