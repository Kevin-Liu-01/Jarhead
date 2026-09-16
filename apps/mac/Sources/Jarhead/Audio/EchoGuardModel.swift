import Foundation

/// The software echo guard, as a pure machine over 10 ms slices (no AVFoundation, so the
/// probe pins it). Used on the plain graph only — Recording, or the fallback rung when
/// the voice-processing unit refused — where the microphone hears Jarhead's own voice at
/// full level and a self-talk loop on a per-second bill would be a cost incident.
///
/// While the speaker is audible (plus a tail for the room and the tap's 100 ms delay) the
/// wire is held: chunks are zero-filled, not dropped, so Live's timeline keeps its cadence.
/// Once the echo can have reached the microphone (`learnDelay`: the output's latency plus the
/// tap's 100 ms), the first half second of a hold teaches the echo floor from every slice;
/// after that only slices near the floor teach it, so Kevin's voice never inflates it. Once
/// two seconds of held speech have taught the floor, Kevin clearly over the echo (+12 dB,
/// 120 ms) breaks through and his sentence passes, echo and all, until the audible window ends.
struct EchoGuardModel: Equatable {
    enum State: Equatable {
        case open
        case held(since: Double)
        case broken(since: Double)
    }

    enum Verdict: Equatable {
        case pass
        case hold
    }

    static let sliceSeconds = 0.01
    /// The room rings and the tap is 100 ms late.
    static let baseTail = 0.30
    /// Bluetooth output buffers are long and uneven.
    static let bluetoothTail = 0.20
    static let maxTail = 0.80
    /// No break-through until this much held speech has taught the floor.
    static let learnSeconds = 2.0
    /// The first half second of a hold teaches from every slice…
    static let learnAll = 0.5
    /// …after that only slices ≤ 2× the floor teach (Kevin's voice never inflates it).
    static let outlierFactor = 2.0
    /// Kevin over the echo by this factor (+12 dB)…
    static let breakFactor = 4.0
    /// …and above this whatever the floor says…
    static let breakMinimumRMS = 0.02
    /// …for 120 ms.
    static let breakSlices = 12
    /// `BargeInDuck.audibleOutput`: the silence the API streams between sentences is ~0.
    static let audibleOutput = 0.02
    /// Per open slice: a moved laptop relearns in ~10 s.
    static let floorDecay = 0.999
    /// The tap hands the microphone over 100 ms late (`installMicTap`): the echo of the first
    /// audible sample cannot reach a judged slice before this — the engine adds the output's
    /// presentation latency (`guardLearnDelay`).
    static let tapDelay = 0.10
    /// The most the learning is put off: a longer delay would eat the two-second lesson.
    static let maxLearnDelay = 0.60

    struct Stats: Equatable {
        var holds = 0
        var breakthroughs = 0
    }

    var tail: Double
    /// Held slices this soon after a hold begins neither teach nor count towards `learned`: the
    /// echo has not reached the microphone yet (the output's latency plus the tap's 100 ms). A
    /// floor taught from that pre-echo silence would reject the real echo as an outlier and, two
    /// seconds in, let the echo itself break through — Jarhead's voice on the wire.
    var learnDelay: Double
    var state: State = .open
    /// When the last sample handed to the player will have played, and when the last
    /// *audible* one will have (silence between sentences arms nothing).
    var queueEnd = 0.0
    var audibleUntil = 0.0
    var echoFloor = 0.0
    var learned = 0.0
    /// Since this hold began (the `learnDelay` clock).
    var heldFor = 0.0
    var heldSeconds = 0.0
    var hotRun = 0
    var stats = Stats()

    init(tail: Double, learnDelay: Double = 0) {
        self.tail = tail
        self.learnDelay = learnDelay.isFinite ? min(EchoGuardModel.maxLearnDelay, max(0, learnDelay)) : 0
    }

    var isHeld: Bool {
        if case .held = state { return true }
        return false
    }

    /// `seconds` of output at `rms`, queued behind whatever is still playing.
    mutating func noteOutput(rms: Double, seconds: Double, now: Double) {
        guard seconds.isFinite, seconds > 0 else { return }
        queueEnd = max(queueEnd, now) + seconds
        if rms >= EchoGuardModel.audibleOutput { audibleUntil = queueEnd }
    }

    /// The speaker backlog was dropped: nothing queued is audible any more.
    mutating func noteFlush(now: Double) {
        queueEnd = min(queueEnd, now)
        audibleUntil = min(audibleUntil, now)
    }

    /// Audible output is queued, or was within `tail`.
    func outputAudible(_ now: Double) -> Bool {
        now < audibleUntil + tail
    }

    /// One 10 ms slice at `rms` (NaN counts as silence).
    mutating func step(rms raw: Double, now: Double) -> Verdict {
        let rms = raw.isFinite ? max(0, raw) : 0
        switch state {
        case .open:
            return stepOpen(rms, now)
        case .held:
            return stepHeld(rms, now)
        case .broken:
            if !outputAudible(now) { state = .open }
            return .pass
        }
    }

    private mutating func stepOpen(_ rms: Double, _ now: Double) -> Verdict {
        guard outputAudible(now) else {
            echoFloor *= EchoGuardModel.floorDecay
            return .pass
        }
        state = .held(since: now)
        stats.holds += 1
        hotRun = 0
        learned = 0
        heldFor = 0
        return .hold
    }

    private mutating func stepHeld(_ rms: Double, _ now: Double) -> Verdict {
        guard outputAudible(now) else {
            state = .open
            return .pass
        }
        heldFor += EchoGuardModel.sliceSeconds
        heldSeconds += EchoGuardModel.sliceSeconds
        // Before the echo can have arrived: hold, learn nothing, count nothing.
        guard heldFor > learnDelay else { return .hold }
        learned += EchoGuardModel.sliceSeconds
        let teaches = learned < EchoGuardModel.learnAll || rms <= max(echoFloor * EchoGuardModel.outlierFactor, EchoGuardModel.breakMinimumRMS)
        if teaches {
            echoFloor = echoFloor == 0 ? rms : echoFloor + (rms - echoFloor) * 0.05
        }
        guard learned >= EchoGuardModel.learnSeconds else { return .hold }
        let threshold = max(echoFloor * EchoGuardModel.breakFactor, EchoGuardModel.breakMinimumRMS)
        hotRun = rms > threshold ? hotRun + 1 : 0
        guard hotRun >= EchoGuardModel.breakSlices else { return .hold }
        state = .broken(since: now)
        stats.breakthroughs += 1
        return .pass
    }
}
