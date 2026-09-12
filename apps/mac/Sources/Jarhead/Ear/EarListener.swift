import AVFoundation
import Foundation
import Speech

/// The on-device ear's recogniser: `SFSpeechRecognizer` with
/// `requiresOnDeviceRecognition`, fed from the voice engine's microphone tap (the
/// mono float buffer `AudioEngine` builds for the wire — never a second
/// `AVAudioEngine`), rolled every 50 s through `SegmentedRecognizer`. Every changed
/// partial and every final comes out of `onTranscript`, throttled to at most 20 a
/// second (finals never wait) and stamped with the moment the recogniser's callback
/// fired, so the engine's reflex layer can act ~100–200 ms behind Kevin's speech and
/// later reconcile with Live's own transcript of the same words.
///
/// Thread shape: `start`/`stop` are asynchronous onto `queue`; `ingest` is called on
/// AVAudioEngine's tap thread (not real-time) and does one lock, one RMS pass and one
/// `append`; the recogniser's callbacks are pointed at `queue` (`recognizer.queue`,
/// which defaults to the app's MAIN queue and would otherwise put every partial behind
/// orb rendering and SwiftUI before it was even stamped), where the throttle lives.
/// Nothing on the ear path touches the main queue.
extension Notification.Name {
    /// The engine's `ear.hints` arrived (wire.ts): `userInfo["strings"]` is what is on the
    /// screen right now. Posted by EngineClient on its own queue; ReflexEar hands it to the
    /// listener (`applyHints`), which is where the recogniser's contextual strings live.
    static let jarheadEarHints = Notification.Name("jarhead.earHints")
}

/// The engine's `ear.hints` — the front app, its window title, the visible controls'
/// titles, the agents' names — merged with the grammar into the recogniser's
/// `contextualStrings`: the grammar first, then up to `maxHints` cleaned hints
/// (whitespace collapsed, ellipses and edge punctuation dropped, at most `maxWords`
/// words, 2–40 characters with a letter in them), deduplicated case-insensitively.
/// `click Add Folder` is then heard as those words on the first partial, which is the
/// one the reflex grammar matches (REDESIGN §12).
enum EarHints {
    static let maxHints = 100
    static let maxWords = 3

    static func clean(_ raw: String) -> String? {
        let unellipsed = raw.replacingOccurrences(of: "…", with: " ").replacingOccurrences(of: "...", with: " ")
        let words = unellipsed.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).prefix(maxWords).map(String.init)
        let joined = words.joined(separator: " ")
        let trimmed = joined.trimmingCharacters(in: CharacterSet.punctuationCharacters.union(.symbols).union(.whitespaces))
        guard trimmed.count >= 2, trimmed.count <= 40, trimmed.contains(where: { $0.isLetter }) else { return nil }
        return trimmed
    }

    static func merge(base: [String], hints: [String]) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        for s in base where seen.insert(s.lowercased()).inserted { out.append(s) }
        var taken = 0
        for raw in hints {
            guard taken < maxHints, let s = clean(raw) else { continue }
            if seen.insert(s.lowercased()).inserted {
                out.append(s)
                taken += 1
            }
        }
        return out
    }
}

final class EarListener: @unchecked Sendable {
    enum Status {
        /// Recognition is running.
        case started(String)
        /// The recogniser or its on-device model is not usable; worth re-checking now and then.
        case unavailable(String)
        /// A recognition task ended with an error. Already rolled to a fresh task.
        case recognitionError(String)

        var text: String {
            switch self {
            case .started(let s), .unavailable(let s), .recognitionError(let s): return s
            }
        }
    }

    /// The last window's latency figures, for harnesses and the log line.
    struct LatencyWindow {
        /// Callback time minus the end of the newest recognised word (its position on the
        /// request's audio, mapped back to the tap's capture clock): the ear's true lag.
        var wordMeanMs: Double = 0
        var wordMaxMs: Double = 0
        var wordCount = 0
        /// For results without word timing: callback time minus the end of the newest
        /// appended audio — only a floor (the recogniser cannot have heard anything newer).
        var floorMeanMs: Double = 0
        var floorMaxMs: Double = 0
        var floorCount = 0

        var isEmpty: Bool { wordCount == 0 && floorCount == 0 }
        var description: String {
            var parts: [String] = []
            if wordCount > 0 {
                parts.append(String(format: "≈ %.0f ms after the word ended (max %.0f ms, %d partials)", wordMeanMs, wordMaxMs, wordCount))
            }
            if floorCount > 0 {
                parts.append(String(format: "floor ≈ %.0f ms after the newest audio (max %.0f ms, %d partials without word timing)", floorMeanMs, floorMaxMs, floorCount))
            }
            return parts.joined(separator: "; ")
        }
    }

    /// (text, isFinal, segment, atMs). `atMs` is ms since epoch when the recogniser
    /// produced the partial, even when the throttle held it a few ms. On `queue`.
    var onTranscript: ((String, Bool, Int, Int) -> Void)?
    /// Status and errors. On `queue`.
    var onStatus: ((Status) -> Void)?

    /// Throttle: at most one message per 50 ms (20 a second); the newest partial of
    /// a segment replaces an older one still waiting, so nothing stale is ever sent.
    /// Finals bypass the wait (see `EarThrottle`).
    static let minSendInterval: TimeInterval = 0.05
    /// How often the latency line is logged while partials arrive.
    static var latencyLogInterval: TimeInterval = 10
    /// The latency line is on in debug builds; `JARHEAD_EAR_LOG=1` turns it on elsewhere.
    static var logsLatency: Bool = {
        #if DEBUG
        return true
        #else
        return ProcessInfo.processInfo.environment["JARHEAD_EAR_LOG"] == "1"
        #endif
    }()
    /// The microphone counts as hot for this long after a buffer above the noise floor,
    /// and a due 50 s roll waits while it is, so a command is not split across segments.
    static let hotHold: TimeInterval = 0.3
    /// Below this RMS nothing counts as speech whatever the noise floor says.
    static let minimumHotRMS: Double = 0.004

    private let locale = Locale(identifier: "en-US")
    private let queue = DispatchQueue(label: "jarhead.ear", qos: .userInteractive)
    private let recognizer: SFSpeechRecognizer?
    private let segments: SegmentedRecognizer?
    private let throttle: EarThrottle
    private var running = false

    // Tap-thread side. `ingestLock` guards `open`, `noiseFloor` and `lastHotHost`.
    private let ingestLock = NSLock()
    private var open = false
    /// Running estimate of the room's RMS: falls at once, rises slowly.
    private var noiseFloor: Double = 0.02
    /// Host time (mach ticks) of the end of the last buffer that was louder than the room.
    private var lastHotHost: UInt64 = 0

    // The live segment, on `queue`: transcripts of older segments are late callbacks of
    // a cancelled task and are dropped, so the engine sees segments in order.
    private var currentSegment = -1
    private var segmentText = ""
    private var segmentFinalSeen = false

    // Latency, on `queue`.
    private var window = LatencyWindow()
    private var wordSum: Double = 0
    private var floorSum: Double = 0
    private var lastLatencyLogAt: CFAbsoluteTime = 0

    // Screen hints, on `queue`: the first hint is the front app; a change of it may roll early.
    private var hintsHead = ""
    private var lastEarlyRollAt: CFAbsoluteTime = 0
    private var lastPartialAt: CFAbsoluteTime = 0
    /// An early roll waits for this much quiet since the last words and this much segment age.
    static let earlyRollQuiet: TimeInterval = 2
    static let earlyRollMinAge: TimeInterval = 3
    static let earlyRollSpacing: TimeInterval = 5

    init(contextualStrings: [String] = EarGrammar.contextualStrings) {
        let recognizer = SFSpeechRecognizer(locale: locale)
        self.recognizer = recognizer
        throttle = EarThrottle(queue: queue, minInterval: EarListener.minSendInterval)
        if let recognizer {
            // Callbacks straight onto the ear's queue: `recognizer.queue` defaults to the main queue.
            let callbacks = OperationQueue()
            callbacks.name = "jarhead.ear.recognizer"
            callbacks.maxConcurrentOperationCount = 1
            callbacks.underlyingQueue = queue
            recognizer.queue = callbacks
            // Segment ids unique per process: the engine keys its ear state by segment and
            // forgets it on sleep/stop/pause, not on a new client hello, so a relaunch must
            // not reuse the previous run's numbers.
            let seed = (Int(Date().timeIntervalSince1970) % 100_000) * 1_000
            let segments = SegmentedRecognizer(recognizer: recognizer, queue: queue, firstSegment: seed)
            segments.contextualStrings = contextualStrings
            self.segments = segments
            segments.onTranscript = { [weak self] t in self?.received(t) }
            segments.onError = { [weak self] message in self?.onStatus?(.recognitionError("ear recognition: \(message)")) }
            segments.onRoll = { [weak self] retired, new in self?.rolled(from: retired, to: new) }
            segments.shouldDeferRoll = { [weak self] in self?.microphoneHot ?? false }
        } else {
            segments = nil
        }
        throttle.send = { [weak self] item in
            self?.onTranscript?(item.text, item.isFinal, item.segment, item.atMs)
        }
    }

    /// False when the on-device English model is missing (downloadable under
    /// System Settings › Keyboard › Dictation) or the recogniser is unavailable.
    var onDeviceAvailable: Bool {
        guard let r = recognizer else { return false }
        return r.isAvailable && r.supportsOnDeviceRecognition
    }

    var isRunning: Bool { queue.sync { running } }

    // MARK: control

    func start() {
        queue.async { self.startLocked() }
    }

    func stop() {
        queue.async { self.stopLocked() }
    }

    /// Words to bias recognition toward; takes effect at the next roll.
    func setContextualStrings(_ strings: [String]) {
        queue.async { self.segments?.contextualStrings = strings }
    }

    /// The engine's `ear.hints`: what is on the screen right now, merged with the grammar
    /// (`EarHints.merge`) into the recogniser's contextual strings, applied at the next
    /// segment. When the front app changed (the first hint) and nothing is being said —
    /// the mic quiet, no words for 2 s, no text in the current segment, the segment at
    /// least 3 s old, no early roll in the last 5 s — the segment rolls now rather than at
    /// the 50 s mark, so the new app's controls are heard on the first command in it.
    /// Any thread.
    func applyHints(_ strings: [String]) {
        queue.async {
            guard let segments = self.segments else { return }
            segments.contextualStrings = EarHints.merge(base: EarGrammar.contextualStrings, hints: strings)
            let head = strings.first ?? ""
            let headChanged = head != self.hintsHead
            self.hintsHead = head
            guard headChanged, self.running, !self.microphoneHot, self.segmentText.isEmpty else { return }
            let now = CFAbsoluteTimeGetCurrent()
            guard now - self.lastPartialAt >= EarListener.earlyRollQuiet, now - self.lastEarlyRollAt >= EarListener.earlyRollSpacing, segments.segmentAge >= EarListener.earlyRollMinAge else { return }
            self.lastEarlyRollAt = now
            let seg = segments.begin()
            if EarListener.logsLatency { NSLog("ear: rolled early for the screen's words (%@); segment %d", head, seg) }
        }
    }

    private func startLocked() {
        guard !running else { return }
        guard let recognizer, recognizer.isAvailable, let segments else {
            onStatus?(.unavailable("ear: speech recogniser unavailable for \(locale.identifier)"))
            return
        }
        guard recognizer.supportsOnDeviceRecognition else {
            onStatus?(.unavailable("ear: on-device speech model missing — download it under System Settings › Keyboard › Dictation"))
            return
        }
        running = true
        throttle.reset()
        window = LatencyWindow(); wordSum = 0; floorSum = 0
        lastLatencyLogAt = CFAbsoluteTimeGetCurrent()
        ingestLock.lock()
        open = true
        noiseFloor = 0.02
        lastHotHost = 0
        ingestLock.unlock()
        // The new task cannot call back before this returns (callbacks land on this queue).
        let seg = segments.begin()
        currentSegment = seg
        segmentText = ""
        segmentFinalSeen = false
        onStatus?(.started("ear listening on-device (segment \(seg), ≤ \(Int(1 / EarListener.minSendInterval)) msg/s, finals unthrottled)"))
    }

    private func stopLocked() {
        guard running else { return }
        ingestLock.lock()
        open = false
        ingestLock.unlock()
        segments?.end()
        throttle.reset()
        running = false
    }

    // MARK: microphone (AVAudioEngine tap thread)

    /// The voice engine's microphone buffer (mono Float32 at the hardware rate) and the
    /// tap's timestamp. Called on AVAudioEngine's tap thread (not the real-time render
    /// thread; default QoS): one lock, one RMS pass, one `append`. Dropped while the ear
    /// is closed. Note that the tap hands over 100 ms buffers however small a size the
    /// engine asks for, so a word reaches the recogniser 0–100 ms (mean ~50) after it was
    /// spoken plus the tap's own ~10 ms delivery — a floor the latency line does not include.
    func ingest(_ buffer: AVAudioPCMBuffer, at when: AVAudioTime) {
        guard let segments else { return }
        ingestLock.lock()
        let isOpen = open
        if isOpen {
            let rms = EarListener.rms(buffer)
            // Falls to any quiet buffer at once; rises with a ~20 s time constant (10 buffers/s), so
            // a long utterance does not lift the floor above itself and end the roll deferral early.
            if rms < noiseFloor { noiseFloor = rms } else { noiseFloor += (rms - noiseFloor) * 0.005 }
            if rms > max(noiseFloor * 3, EarListener.minimumHotRMS) {
                let rate = buffer.format.sampleRate
                let duration = rate > 0 ? Double(buffer.frameLength) / rate : 0
                let start = when.isHostTimeValid ? when.hostTime : mach_absolute_time()
                lastHotHost = start &+ AVAudioTime.hostTime(forSeconds: duration)
            }
        }
        ingestLock.unlock()
        guard isOpen else { return }
        segments.append(buffer, at: when)
    }

    /// True within `hotHold` of the last buffer louder than the room. Any thread.
    var microphoneHot: Bool {
        ingestLock.lock()
        let last = lastHotHost
        ingestLock.unlock()
        guard last > 0 else { return false }
        let now = mach_absolute_time()
        return now < last || AVAudioTime.seconds(forHostTime: now - last) < EarListener.hotHold
    }

    static func rms(_ buffer: AVAudioPCMBuffer) -> Double {
        let n = Int(buffer.frameLength)
        guard n > 0, let p = buffer.floatChannelData?[0] else { return 0 }
        var acc: Double = 0
        for i in 0 ..< n { acc += Double(p[i] * p[i]) }
        // Finite and 0…1 whatever the samples held: a NaN here would poison the noise
        // floor for good (every comparison false) and the roll deferral with it.
        return clampLevel((acc / Double(n)).squareRoot())
    }

    // MARK: transcripts (on `queue`)

    private func received(_ t: SegmentedRecognizer.Transcript) {
        guard running else { return }
        // A retired task's late callback: its segment was closed at the roll.
        guard t.segment >= currentSegment else { return }
        if t.segment > currentSegment {
            currentSegment = t.segment
            segmentText = ""
            segmentFinalSeen = false
        }
        if let audio = t.audio { noteLatency(callbackHost: t.hostTime, audio: audio) }
        if !t.isFinal, t.text.isEmpty { return }
        if !t.text.isEmpty { lastPartialAt = CFAbsoluteTimeGetCurrent() }
        // Words arriving while Jarhead speaks: the barge-in duck's second cue, and its
        // confirmation that the energy the gate heard is speech, not a cough — when they
        // carry a word Jarhead did not just say (the duck knows his transcript; a partial
        // made only of his words may be residual echo and confirms nothing).
        if !t.isFinal, t.text != segmentText { BargeInDuck.shared.noteEarWords(t.text) }
        if t.isFinal { segmentFinalSeen = true } else { segmentText = t.text }
        let item = EarThrottle.Item(text: t.text, isFinal: t.isFinal, segment: t.segment, atMs: Int((t.at.timeIntervalSince1970 * 1000).rounded()))
        guard !throttle.isRepeat(item) else { return }
        throttle.offer(item)
    }

    /// The segments rolled (50 s, or a task ended). The retired task was cancelled, so
    /// its words end with the last partial: send that as the segment's final, now, before
    /// the new task can call back — the engine reads an unknown older segment arriving
    /// late as a new one and would restart on its words.
    private func rolled(from retired: Int, to new: Int) {
        guard running else { return }
        if retired == currentSegment, !segmentFinalSeen, !segmentText.isEmpty {
            let nowMs = Int((Date().timeIntervalSince1970 * 1000).rounded())
            throttle.offer(EarThrottle.Item(text: segmentText, isFinal: true, segment: retired, atMs: nowMs))
        }
        currentSegment = new
        segmentText = ""
        segmentFinalSeen = false
    }

    // MARK: latency

    /// The ear's own lag: callback time minus the end of the newest recognised word,
    /// placed on the tap's capture clock through the request's audio position
    /// (`SFTranscriptionSegment.timestamp + duration`). Measuring against the newest
    /// *appended* buffer instead would alias modulo the 100 ms tap period and read
    /// "tens of ms" however far behind the recogniser was; that figure is kept only as
    /// a labelled floor for results without word timing. Logged as a mean over the last window.
    private func noteLatency(callbackHost: UInt64, audio: SegmentedRecognizer.AudioClock) {
        if let wordEnd = audio.lastWordEndHost {
            let ms = callbackHost > wordEnd ? AVAudioTime.seconds(forHostTime: callbackHost - wordEnd) * 1000 : 0
            guard ms.isFinite, ms < 60_000 else { return }
            wordSum += ms
            window.wordMaxMs = max(window.wordMaxMs, ms)
            window.wordCount += 1
            window.wordMeanMs = wordSum / Double(window.wordCount)
        } else if let end = audio.appendedEndHost, callbackHost > end {
            let ms = AVAudioTime.seconds(forHostTime: callbackHost - end) * 1000
            guard ms.isFinite, ms < 60_000 else { return }
            floorSum += ms
            window.floorMaxMs = max(window.floorMaxMs, ms)
            window.floorCount += 1
            window.floorMeanMs = floorSum / Double(window.floorCount)
        } else {
            return
        }
        let now = CFAbsoluteTimeGetCurrent()
        guard now - lastLatencyLogAt >= EarListener.latencyLogInterval else { return }
        lastLatencyLogAt = now
        if EarListener.logsLatency {
            NSLog("ear: on-device partial latency %@", window.description)
        }
        window = LatencyWindow(); wordSum = 0; floorSum = 0
    }

    /// The window so far, for harnesses. On the caller's thread; a snapshot.
    func latencyWindow() -> LatencyWindow {
        queue.sync { window }
    }
}
