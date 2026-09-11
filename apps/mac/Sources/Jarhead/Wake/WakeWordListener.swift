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

    static let rollInterval: TimeInterval = SegmentedRecognizer.rollInterval

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
            self.startLocked()
        }
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
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            status(.startFailed("no input device for the wake word"))
            return
        }
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
            self?.segments?.append(buffer)
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            status(.startFailed("wake listener could not start: \(error.localizedDescription)"))
            return
        }
        running = true
        segments.begin()
        status(.started("listening on-device (\(Int(format.sampleRate)) Hz ×\(format.channelCount))"))
    }

    private func stopLocked() {
        segments?.end()
        engine.inputNode.removeTap(onBus: 0)
        if engine.isRunning { engine.stop() }
        running = false
    }

    /// The input device changed under us: restart after a short settle, unless the
    /// caller stopped us meanwhile (the voice engine may have taken the microphone).
    private func restartAfterConfigurationChange() {
        guard running else { return }
        stopLocked()
        queue.asyncAfter(deadline: .now() + 0.4) { [weak self] in
            guard let self, self.wanted, !self.running else { return }
            self.startLocked()
        }
    }

    private func status(_ s: Status) {
        DispatchQueue.main.async { self.onStatus?(s) }
    }
}
