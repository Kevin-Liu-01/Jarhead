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
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var rollTimer: DispatchSourceTimer?
    /// Words to bias recognition toward (the wake phrases). Applied at the next roll. On `queue` only.
    private var contextualStrings: [String] = []
    /// The caller wants us running (start() without a stop()); the deferred restart
    /// after a configuration change honours it. On `queue` only.
    private var wanted = false
    private var running = false
    private var segment = 0
    private var configObserver: NSObjectProtocol?
    private let requestLock = NSLock()

    static let rollInterval: TimeInterval = 50

    init() {
        recognizer = SFSpeechRecognizer(locale: locale)
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
        queue.async { self.contextualStrings = strings }
    }

    /// End the current recognition task and start a fresh one, so what is said next
    /// lands in a new, empty segment. Reports the new segment number on the main queue,
    /// or nil when the listener is not running.
    func rollSegment(_ completion: @escaping (Int?) -> Void) {
        queue.async {
            guard self.running else {
                DispatchQueue.main.async { completion(nil) }
                return
            }
            self.beginTaskLocked()
            let seg = self.segment
            DispatchQueue.main.async { completion(seg) }
        }
    }

    private func startLocked() {
        guard !running else { return }
        guard let recognizer, recognizer.isAvailable else {
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
            guard let self else { return }
            self.requestLock.lock()
            let req = self.request
            self.requestLock.unlock()
            req?.append(buffer)
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
        beginTaskLocked()
        status(.started("listening on-device (\(Int(format.sampleRate)) Hz ×\(format.channelCount))"))
    }

    private func stopLocked() {
        rollTimer?.cancel(); rollTimer = nil
        endTaskLocked()
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

    // MARK: recognition tasks

    /// On `queue`. Starts a fresh request/task and the 50 s roll timer.
    private func beginTaskLocked() {
        guard running, let recognizer else { return }
        endTaskLocked()
        segment += 1
        let seg = segment
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.requiresOnDeviceRecognition = true
        req.taskHint = .dictation
        if #available(macOS 13.0, *) { req.addsPunctuation = false }
        if !contextualStrings.isEmpty { req.contextualStrings = contextualStrings }
        requestLock.lock(); request = req; requestLock.unlock()

        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            guard let self else { return }
            if let result {
                let text = result.bestTranscription.formattedString
                let final = result.isFinal
                DispatchQueue.main.async { self.onTranscript?(text, final, seg) }
                if final { self.queue.async { self.rollIfCurrent(seg) } }
            }
            if let error {
                // Cancelled tasks report an error too; only roll when this task is still the live one.
                let ns = error as NSError
                let benign = ns.domain == "kAFAssistantErrorDomain" && (ns.code == 216 || ns.code == 1110 || ns.code == 209)
                if !benign { self.status(.recognitionError("recognition: \(error.localizedDescription)")) }
                self.queue.async { self.rollIfCurrent(seg, delay: benign ? 0.05 : 0.6) }
            }
        }

        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + WakeWordListener.rollInterval)
        timer.setEventHandler { [weak self] in self?.rollIfCurrent(seg) }
        timer.resume()
        rollTimer?.cancel()
        rollTimer = timer
    }

    /// On `queue`. Rolls to a new task only if `seg` is still the live segment.
    private func rollIfCurrent(_ seg: Int, delay: TimeInterval = 0) {
        guard running, seg == segment else { return }
        if delay > 0 {
            queue.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self, self.running, seg == self.segment else { return }
                self.beginTaskLocked()
            }
        } else {
            beginTaskLocked()
        }
    }

    private func endTaskLocked() {
        requestLock.lock()
        let req = request
        request = nil
        requestLock.unlock()
        req?.endAudio()
        task?.cancel()
        task = nil
    }

    private func status(_ s: Status) {
        DispatchQueue.main.async { self.onStatus?(s) }
    }
}
