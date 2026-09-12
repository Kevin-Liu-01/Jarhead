import AVFoundation
import Foundation
import Speech

/// One on-device `SFSpeechRecognizer` request at a time, rolled to a fresh one every
/// 50 s (recognition tasks are capped at about a minute), whenever a task ends, and on
/// demand. Each roll starts a new "segment", numbered so a caller can tell which
/// partial belongs to what and can ask for a clean segment (the wake gate does, so a
/// passphrase answer is never spliced onto the wake word's own transcript).
///
/// Shared by the wake word listener (asleep, its own microphone tap) and the reflex
/// ear (awake, fed from the voice engine's tap). Neither microphone lives here: the
/// owner appends buffers. Control (`begin`, `end`) runs on the owner's `queue`;
/// `append` is safe from any thread (the tap thread included). Transcripts and errors
/// are delivered on `recognizer.queue` — the app's main queue unless the owner sets it
/// (the ear points it at its own queue; the wake listener keeps the default) — stamped
/// with the moment the callback fired, so the owner decides where they go and how fast.
final class SegmentedRecognizer {
    /// Where a transcript sits on the request's audio timeline, so the owner can turn
    /// "the recogniser said this at callback time" into "… N ms after the word ended".
    struct AudioClock {
        /// Host time (mach ticks) at which the first frame appended to this request was
        /// captured (the tap's timestamp); 0 when no buffer carried a valid host time.
        let requestStartHost: UInt64
        /// Seconds of audio appended to the request when the callback fired.
        let appendedSeconds: TimeInterval
        /// End of the newest recognised word (`timestamp + duration` of the last
        /// `SFTranscriptionSegment`), in seconds from the start of the request's audio;
        /// nil when the result carried no segment timing.
        let lastWordEnd: TimeInterval?

        /// Host time at which the newest recognised word ended, when known.
        var lastWordEndHost: UInt64? {
            guard requestStartHost > 0, let end = lastWordEnd, end > 0 else { return nil }
            return requestStartHost &+ AVAudioTime.hostTime(forSeconds: end)
        }

        /// Host time at which the newest appended audio ended: the floor of any latency
        /// figure (the recogniser cannot have heard anything newer).
        var appendedEndHost: UInt64? {
            guard requestStartHost > 0 else { return nil }
            return requestStartHost &+ AVAudioTime.hostTime(forSeconds: appendedSeconds)
        }
    }

    struct Transcript {
        /// The cumulative transcript of the segment so far (`bestTranscription`).
        let text: String
        let isFinal: Bool
        let segment: Int
        /// When the recogniser's callback fired, wall clock …
        let at: Date
        /// … and the same moment in mach host ticks (`AVAudioTime.hostTime`), for latency arithmetic.
        let hostTime: UInt64
        /// Where on the request's audio this transcript sits; nil for a synthesised transcript.
        let audio: AudioClock?
    }

    /// Every partial and final. On `recognizer.queue`.
    var onTranscript: ((Transcript) -> Void)?
    /// A task ended with an error worth reporting (cancellations and the recogniser's
    /// own end-of-task codes are not). The task has already been rolled. On `recognizer.queue`.
    var onError: ((String) -> Void)?
    /// The live segment changed: `(retired, new)`. Called on `queue` inside `begin()`
    /// after the retired task is cancelled and before the new task can call back, so the
    /// owner can close the retired segment (a final of its own) before anything new arrives.
    var onRoll: ((Int, Int) -> Void)?
    /// Asked on `queue` when the 50 s roll comes due: true means someone is mid-word
    /// (the owner's microphone is hot) and the roll should wait, re-asked every
    /// `rollDeferStep` up to `rollDeferMax`, so a command is not cut in two across
    /// segments. nil (the wake listener) rolls on the dot as before.
    var shouldDeferRoll: (() -> Bool)?
    /// Words to bias recognition toward. Applied at the next roll. On `queue` only.
    var contextualStrings: [String] = []
    /// Applied at the next roll. On `queue` only.
    var taskHint: SFSpeechRecognitionTaskHint = .dictation

    /// The live segment number; `firstSegment` before the first `begin()`. On `queue`.
    private(set) var segment: Int
    /// True between `begin()` and `end()`. On `queue`.
    private(set) var isActive = false
    /// When the live segment began (`begin()`), for the ear's early-roll guard. On `queue`.
    private(set) var beganAt = DispatchTime.now()
    var segmentAge: TimeInterval {
        let now = DispatchTime.now().uptimeNanoseconds
        return now > beganAt.uptimeNanoseconds ? Double(now - beganAt.uptimeNanoseconds) / 1e9 : 0
    }

    private let recognizer: SFSpeechRecognizer
    private let queue: DispatchQueue
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var rollTimer: DispatchSourceTimer?
    /// Guards `request` and the audio clock below (`append` runs off `queue`).
    private let requestLock = NSLock()
    private var requestStartHost: UInt64 = 0
    private var appendedFrames: Int64 = 0
    private var appendedRate: Double = 0

    static let rollInterval: TimeInterval = 50
    static let rollDeferStep: TimeInterval = 0.1
    /// A roll waits at most this long for silence; on-device tasks are good for about a minute.
    static let rollDeferMax: TimeInterval = 5

    /// `queue` is the owner's serial queue; every control call must come from it.
    /// `firstSegment` seeds the counter: the ear seeds it per process so segment ids never
    /// repeat across app relaunches (the engine keys its ear state by segment number and
    /// forgets it only on sleep/stop/pause, not on a new client hello); the wake
    /// listener keeps 0.
    init(recognizer: SFSpeechRecognizer, queue: DispatchQueue, firstSegment: Int = 0) {
        self.recognizer = recognizer
        self.queue = queue
        segment = firstSegment
    }

    /// On `queue`. Ends the current task (if any) and starts a fresh request/task and
    /// the roll timer, in a new segment. Returns the new segment number.
    @discardableResult
    func begin() -> Int {
        isActive = true
        let hadTask = task != nil
        let retired = segment
        endTaskLocked()
        segment += 1
        let seg = segment
        beganAt = DispatchTime.now()
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.requiresOnDeviceRecognition = true
        req.taskHint = taskHint
        if #available(macOS 13.0, *) { req.addsPunctuation = false }
        if !contextualStrings.isEmpty { req.contextualStrings = contextualStrings }
        requestLock.lock()
        request = req
        requestStartHost = 0
        appendedFrames = 0
        appendedRate = 0
        requestLock.unlock()
        if hadTask { onRoll?(retired, seg) }

        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            guard let self else { return }
            let hostNow = mach_absolute_time()
            if let result {
                let text = result.bestTranscription.formattedString
                let final = result.isFinal
                let lastWordEnd = result.bestTranscription.segments.last.map { $0.timestamp + $0.duration }
                self.requestLock.lock()
                let clock = AudioClock(
                    requestStartHost: self.requestStartHost,
                    appendedSeconds: self.appendedRate > 0 ? Double(self.appendedFrames) / self.appendedRate : 0,
                    lastWordEnd: lastWordEnd
                )
                self.requestLock.unlock()
                self.onTranscript?(Transcript(text: text, isFinal: final, segment: seg, at: Date(), hostTime: hostNow, audio: clock))
                if final { self.queue.async { self.rollIfCurrent(seg) } }
            }
            if let error {
                // Cancelled tasks report an error too; only roll when this task is still the live one.
                let ns = error as NSError
                let benign = ns.domain == "kAFAssistantErrorDomain" && (ns.code == 216 || ns.code == 1110 || ns.code == 209)
                if !benign { self.onError?(error.localizedDescription) }
                self.queue.async { self.rollIfCurrent(seg, delay: benign ? 0.05 : 0.6) }
            }
        }

        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + SegmentedRecognizer.rollInterval)
        timer.setEventHandler { [weak self] in
            self?.plannedRoll(seg, until: .now() + SegmentedRecognizer.rollDeferMax)
        }
        timer.resume()
        rollTimer?.cancel()
        rollTimer = timer
        return seg
    }

    /// On `queue`. Ends the current task; nothing rolls until the next `begin()`.
    /// Buffers appended meanwhile are dropped.
    func end() {
        isActive = false
        rollTimer?.cancel(); rollTimer = nil
        endTaskLocked()
    }

    /// Any thread (the tap thread included). Dropped while no request is open. `when`
    /// is the buffer's capture timestamp when the owner has one; it anchors the request's
    /// audio clock (its first buffer) so transcripts can be placed in host time.
    func append(_ buffer: AVAudioPCMBuffer, at when: AVAudioTime? = nil) {
        requestLock.lock()
        let req = request
        if req != nil {
            if requestStartHost == 0, let when, when.isHostTimeValid { requestStartHost = when.hostTime }
            appendedFrames += Int64(buffer.frameLength)
            appendedRate = buffer.format.sampleRate
        }
        requestLock.unlock()
        req?.append(buffer)
    }

    /// On `queue`. The 50 s roll: waits, in `rollDeferStep` steps up to `until`, while the
    /// owner says the microphone is hot, then rolls if `seg` is still live.
    private func plannedRoll(_ seg: Int, until: DispatchTime) {
        guard isActive, seg == segment else { return }
        if let shouldDeferRoll, shouldDeferRoll(), DispatchTime.now() < until {
            queue.asyncAfter(deadline: .now() + SegmentedRecognizer.rollDeferStep) { [weak self] in
                self?.plannedRoll(seg, until: until)
            }
            return
        }
        begin()
    }

    /// On `queue`. Rolls to a new task only if `seg` is still the live segment.
    private func rollIfCurrent(_ seg: Int, delay: TimeInterval = 0) {
        guard isActive, seg == segment else { return }
        if delay > 0 {
            queue.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self, self.isActive, seg == self.segment else { return }
                self.begin()
            }
        } else {
            begin()
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
}
