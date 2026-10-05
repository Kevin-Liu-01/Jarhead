import AVFoundation
import Foundation

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
