import AVFoundation
import Foundation
import Speech

/// Continuous on-device speech recognition over its own microphone tap, used only
/// while the engine is asleep. `SFSpeechRecognizer` with
/// `requiresOnDeviceRecognition = true`: audio never leaves the Mac and nothing is
/// billed. The caller gets the running transcript of the current segment (cumulative
/// partials, then a final) and decides what counts as the wake word or the passphrase.
///
/// Recognition tasks are capped at about a minute, so the listener rolls to a fresh
/// request every 50 s and whenever a task ends; each roll starts a new "segment",
/// signalled through the `segment` counter passed with every transcript. The gate can
/// also ask for a roll (`rollSegment`) so a passphrase answer starts in a clean segment.
/// The request/task/roll machinery is `SegmentedRecognizer` (Ear/), shared with the
/// reflex ear that listens while awake; what is here is the microphone and the status.
final class WakeWordListener {
    /// What the listener has to say about itself. Typed, so the gate never has to
    /// read error text to know whether recognition is running.
    enum Status {
        /// Recognition is running ("listening on-device (24000 Hz ×1)").
        case started(String)
        /// The recogniser or its on-device model is not usable; worth re-checking now
        /// and then (the model can be downloaded under Dictation).
        case unavailable(String)
        /// The audio engine could not start (no input device, a device switching):
        /// transient, retry with backoff.
        case startFailed(String)
        /// A recognition task ended with an error. The listener already rolls to a fresh task.
        case recognitionError(String)

        var text: String {
            switch self {
            case .started(let s), .unavailable(let s), .startFailed(let s), .recognitionError(let s): return s
            }
        }
    }

    /// (text, isFinal, segment). Delivered on the main queue.
    var onTranscript: ((String, Bool, Int) -> Void)?
    /// Status and errors. Main queue.
    var onStatus: ((Status) -> Void)?

    private let locale = Locale(identifier: "en-US")
    private let engine = AVAudioEngine()
    private let queue = DispatchQueue(label: "jarhead.wake.listener")
    private let recognizer: SFSpeechRecognizer?
    /// The request/task/segment machinery; nil only when the recogniser could not be made for the locale.
    private let segments: SegmentedRecognizer?
    /// The caller wants us running (start() without a stop()); the deferred restart
    /// after a configuration change honours it. On `queue` only.
    private var wanted = false
    private var running = false
    private var configObserver: NSObjectProtocol?
    /// Consecutive starts that did not come up, for the quick retry ladder. On `queue` only.
    private var startFailures = 0
    private var retryScheduled = false
    private var restartPending = false

    static let rollInterval: TimeInterval = SegmentedRecognizer.rollInterval
    /// Failed starts retried here (0.5, 1, 2, 5 s) before the gate is told; see `startDidFail`.
    static let quickRetries = 4
    /// Where the listener's own lines go — the tap's first buffer format, a failed start
    /// and its retry, a configuration change's format before → after. NSLog unless the
    /// app points it at a log that also reaches the crash report and daemon.log (this
    /// file is compiled by the probes without App/, so the hook is a closure, not a call).
    static var log: (String) -> Void = { NSLog("WakeListener: %@", $0) }

    private enum StartFailure: LocalizedError {
        case noInputDevice
        var errorDescription: String? { "no input device for the wake word" }
    }

    init() {
        let recognizer = SFSpeechRecognizer(locale: locale)
        self.recognizer = recognizer
        if let recognizer {
            let segments = SegmentedRecognizer(recognizer: recognizer, queue: queue)
            self.segments = segments
            segments.onTranscript = { [weak self] t in
                DispatchQueue.main.async { self?.onTranscript?(t.text, t.isFinal, t.segment) }
            }
            segments.onError = { [weak self] message in
                self?.status(.recognitionError("recognition: \(message)"))
            }
        } else {
            segments = nil
        }
        configObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self] _ in
            self?.queue.async { self?.restartAfterConfigurationChange() }
        }
    }

    deinit {
        if let configObserver { NotificationCenter.default.removeObserver(configObserver) }
    }

    // MARK: authorization / availability

    /// Prompts when undetermined (needs NSSpeechRecognitionUsageDescription). Main
    /// queue. The detail explains a refusal in words the status menu can show.
    static func requestAuthorization(_ completion: @escaping (Bool, String) -> Void) {
        SFSpeechRecognizer.requestAuthorization { status in
            let (ok, detail) = describe(status)
            DispatchQueue.main.async { completion(ok, detail) }
        }
    }

    /// The current grant, without prompting. Re-read on activation so a grant made in
    /// System Settings takes effect without a relaunch.
    static func currentAuthorization() -> (authorized: Bool, detail: String) {
        describe(SFSpeechRecognizer.authorizationStatus())
    }

    private static func describe(_ status: SFSpeechRecognizerAuthorizationStatus) -> (Bool, String) {
        switch status {
        case .authorized: return (true, "Speech Recognition granted")
        case .denied: return (false, "Speech Recognition denied — enable it in System Settings › Privacy › Speech Recognition")
        case .restricted: return (false, "Speech Recognition restricted on this Mac")
        case .notDetermined: return (false, "Speech Recognition not decided")
        @unknown default: return (false, "Speech Recognition unavailable")
        }
    }

    /// False when the on-device English model is missing (it is downloadable under
    /// System Settings › Keyboard › Dictation) or the recogniser is unavailable.
    var onDeviceAvailable: Bool {
        guard let r = recognizer else { return false }
        return r.isAvailable && r.supportsOnDeviceRecognition
    }

    var isRunning: Bool { queue.sync { running } }

    // MARK: control

    func start() {
        queue.async {
            self.wanted = true
            self.startFailures = 0
            self.startLocked()
        }
    }

    /// Harnesses only: run the configuration-change path (stop, reset, re-query the input
    /// format, restart through the shim) as if the input device had just changed.
    func simulateConfigurationChange() {
        queue.async { self.restartAfterConfigurationChange() }
    }

    func stop() {
        queue.async {
            self.wanted = false
            self.stopLocked()
        }
    }

    /// Words to bias recognition toward; takes effect at the next roll.
    func setContextualStrings(_ strings: [String]) {
        queue.async { self.segments?.contextualStrings = strings }
    }

    /// End the current recognition task and start a fresh one, so what is said next
    /// lands in a new, empty segment. Reports the new segment number on the main queue,
    /// or nil when the listener is not running.
    func rollSegment(_ completion: @escaping (Int?) -> Void) {
        queue.async {
            guard self.running, let segments = self.segments else {
                DispatchQueue.main.async { completion(nil) }
                return
            }
            let seg = segments.begin()
            DispatchQueue.main.async { completion(seg) }
        }
    }

    private func startLocked() {
        guard !running else { return }
        guard let recognizer, recognizer.isAvailable, let segments else {
            status(.unavailable("speech recogniser unavailable for \(locale.identifier)"))
            return
        }
        guard recognizer.supportsOnDeviceRecognition else {
            status(.unavailable("on-device speech model missing — download it under System Settings › Keyboard › Dictation (nothing is sent to a server)"))
            return
        }
        // Everything AVFoundation can raise from runs inside the ObjC shim (`objcTry`):
        // uncaught, a raise here aborted the app five times on 2026-09-11 — `installTap`
        // asked for a format read before the input device had finished switching, and
        // AVFoundation answered "Failed to create tap due to format mismatch".
        var formatBefore = "unreadable", formatAfter = "unreadable"
        do {
            try objcTry(throwing: {
                let input = self.engine.inputNode
                let before = input.outputFormat(forBus: 0)
                formatBefore = before.brief
                guard before.sampleRate > 0, before.channelCount > 0 else { throw StartFailure.noInputDevice }
                input.removeTap(onBus: 0)
                // `format: nil` is the node's own output format at the moment the tap is
                // created, whatever it has become — nothing to mismatch. The recogniser
                // accepts any PCM format, so no conversion is needed here.
                var loggedFirst = false
                input.installTap(onBus: 0, bufferSize: 4096, format: nil) { [weak self] buffer, _ in
                    if !loggedFirst {
                        loggedFirst = true
                        WakeWordListener.log("first buffer \(buffer.format.brief), \(buffer.frameLength) frames")
                    }
                    self?.segments?.append(buffer)
                }
                self.engine.prepare()
                formatAfter = input.outputFormat(forBus: 0).brief
                try self.engine.start()
            })
        } catch {
            try? objcTry {
                self.engine.inputNode.removeTap(onBus: 0)
                if self.engine.isRunning { self.engine.stop() }
            }
            startDidFail(error, formats: "\(formatBefore) → \(formatAfter)")
            return
        }
        running = true
        startFailures = 0
        segments.begin()
        let note = formatBefore == formatAfter ? "" : ", was \(formatBefore) before prepare"
        status(.started("listening on-device (\(formatAfter); tap at the node's own format\(note))"))
    }

    /// A start that did not come up. Devices come and go — the first failures are retried
    /// here on a quick ladder (0.5, 1, 2, 5 s), which covers an input device that is still
    /// switching; if it keeps failing the gate is told (`.startFailed`) and takes over with
    /// its own 2 → 30 s backoff. The gate stops this listener while it waits (`wanted`
    /// drops), so the two loops never race. A raise caught by the shim is named as such.
    private func startDidFail(_ error: Error, formats: String) {
        startFailures += 1
        let what: String
        if let raised = error as? ObjCException {
            what = "AVFoundation raised \(raised.name): \(raised.reason)"
        } else {
            what = error.localizedDescription
        }
        guard startFailures <= WakeWordListener.quickRetries else {
            startFailures = 0
            status(.startFailed("wake listener could not start: \(what) (input \(formats))"))
            return
        }
        let delay = AudioBackoff.delay(attempt: startFailures - 1)
        WakeWordListener.log("start failed: \(what) (input \(formats)) — retry \(startFailures)/\(WakeWordListener.quickRetries) in \(String(format: "%.1f", delay)) s")
        guard !retryScheduled else { return }
        retryScheduled = true
        queue.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self else { return }
            self.retryScheduled = false
            guard self.wanted, !self.running else { return }
            self.startLocked()
        }
    }

    private func stopLocked() {
        segments?.end()
        // Tearing down can raise too (a node mid-switch); a stop must never abort the app.
        try? objcTry {
            self.engine.inputNode.removeTap(onBus: 0)
            if self.engine.isRunning { self.engine.stop() }
        }
        running = false
    }

    /// The input device changed under us (`AVAudioEngineConfigurationChange`: the engine
    /// has stopped itself). Stop, reset, re-query the input format and log before → after,
    /// then start again through the shim after a short settle — unless the caller stopped
    /// us meanwhile (the voice engine may have taken the microphone). Bursts coalesce.
    private func restartAfterConfigurationChange() {
        guard wanted, !restartPending else { return }
        restartPending = true
        let before = inputFormatText()
        if running { stopLocked() }
        try? objcTry { self.engine.reset() }
        let after = inputFormatText()
        WakeWordListener.log("input configuration changed: \(before) → \(after); restarting in 0.4 s")
        queue.asyncAfter(deadline: .now() + 0.4) { [weak self] in
            guard let self else { return }
            self.restartPending = false
            guard self.wanted, !self.running else { return }
            self.startLocked()
        }
    }

    /// The input node's current output format, for a log line; never raises.
    private func inputFormatText() -> String {
        var text = "unreadable"
        try? objcTry { text = self.engine.inputNode.outputFormat(forBus: 0).brief }
        return text
    }

    private func status(_ s: Status) {
        DispatchQueue.main.async { self.onStatus?(s) }
    }
}
