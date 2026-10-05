import AVFoundation
import Foundation

/// The speaker's playout cushion, as a value: what goes in front of each chunk of Live's
/// audio so that a late chunk is absorbed instead of heard as a hole.
///
/// Live paces its stream at real time. With nothing queued ahead, any chunk that arrives
/// late (the network, a busy queue, the daemon) leaves the player dry: a hole in a word,
/// with a click at each edge. The model keeps the player `target` ahead, 120 ms by default:
/// - **Reset** (start, flush, a graph restart, the player dry for ≥ 0.5 s, or no render
///   time yet): the next chunk is preceded by `target` of silence. Not an underrun.
/// - **Underrun** (the player ran dry mid-stream, for less than 0.5 s): counted, scheduled
///   at once behind a 5 ms fade-in, and `target` grows to `min(200 ms, longest gap + 40 ms)`
///   for the resets that follow. No re-prime on the spot: that measured longer tail holes.
/// - **Otherwise**: contiguous, nothing added.
///
/// Alongside it keeps today's zero-cushion policy on the same timeline
/// (`wouldBeUnderruns`), so one session gives the before and the after.
///
/// Times are 24 kHz player samples. `now` is the player's own sample time
/// (`playerTime(forNodeTime: lastRenderTime)`), nil before the player has rendered. Pure:
/// no AVFoundation in the logic, pinned by duck-probe's `playout` section.
struct PlayoutModel: Equatable {
    static let sampleRate = 24_000.0
    /// 120 ms of silence in front of the first chunk after a reset.
    static let defaultTargetFrames = 2_880
    /// The target never grows past 200 ms…
    static let maxTargetFrames = 4_800
    /// …and grows to the longest gap seen plus 40 ms.
    static let targetMarginFrames = 960
    /// Dry this long and the next chunk opens a new stream (0.5 s).
    static let dryResetFrames = 12_000
    /// The fade-in after silence: 5 ms.
    static let fadeFrames = 120

    struct Plan: Equatable {
        /// Silence to schedule before the chunk.
        var prerollFrames = 0
        /// Ramp the chunk's first `fadeFrames` up: it follows silence.
        var fadeIn = false
        /// The player ran dry mid-stream before this chunk, for `gapFrames`.
        var underrun = false
        var gapFrames = 0
        /// The chunk opens a new stream (start, flush, restart, a long dry spell, no render time).
        var reset = false
    }

    struct Stats: Equatable {
        var chunks = 0
        var underruns = 0
        var underrunFrames = 0
        var longestUnderrunFrames = 0
        /// What the zero-cushion policy (schedule on arrival) would have counted.
        var wouldBeUnderruns = 0
        var resets = 0
        /// The backlog ahead of the last chunk, and the smallest ahead of any chunk since the graph started.
        var queuedFrames = 0
        var queuedMinFrames: Int?
    }

    private(set) var targetFrames = PlayoutModel.defaultTargetFrames
    private(set) var stats = Stats()
    /// Where the queued audio runs out, on the player's timeline (meaningful once primed).
    private(set) var scheduledEnd: Int64 = 0
    private(set) var primed = false
    /// The zero-cushion policy's `scheduledEnd`, on the same timeline.
    private(set) var shadowEnd: Int64 = 0

    init() {}

    /// Start, flush, graph restart: the next chunk opens a new stream behind `target` of silence.
    mutating func reset() {
        primed = false
    }

    /// The plan for a chunk of `frames` arriving with the player at `now`.
    mutating func plan(frames: Int, now: Int64?) -> Plan {
        let count = Int64(max(0, frames))
        stats.chunks += 1
        guard let now, primed, now - scheduledEnd < Int64(PlayoutModel.dryResetFrames) else {
            // A new stream: the player's timeline starts at 0 when it has not rendered yet.
            let base = now ?? 0
            primed = true
            stats.resets += 1
            scheduledEnd = base + Int64(targetFrames) + count
            shadowEnd = base + count
            noteQueued(targetFrames)
            return Plan(prerollFrames: targetFrames, fadeIn: true, reset: true)
        }
        // Today's policy alongside: dry is a hole, then the chunk plays at once.
        if shadowEnd < now {
            stats.wouldBeUnderruns += 1
            shadowEnd = now + count
        } else {
            shadowEnd += count
        }
        let backlog = scheduledEnd - now
        guard backlog < 0 else {
            noteQueued(Int(backlog))
            scheduledEnd += count
            return Plan()
        }
        let gap = Int(-backlog)
        stats.underruns += 1
        stats.underrunFrames += gap
        stats.longestUnderrunFrames = max(stats.longestUnderrunFrames, gap)
        targetFrames = max(targetFrames, min(PlayoutModel.maxTargetFrames, stats.longestUnderrunFrames + PlayoutModel.targetMarginFrames))
        noteQueued(0)
        scheduledEnd = now + count
        return Plan(fadeIn: true, underrun: true, gapFrames: gap)
    }

    private mutating func noteQueued(_ frames: Int) {
        stats.queuedFrames = frames
        stats.queuedMinFrames = min(stats.queuedMinFrames ?? frames, frames)
    }

    /// The fade-in's gain at sample `i` of `fadeFrames`: (i + 1) / fadeFrames, rising to 1.
    static func fadeGain(_ i: Int) -> Float {
        let n = max(1, fadeFrames)
        return Float(min(max(i, 0), n - 1) + 1) / Float(n)
    }

    static func ms(_ frames: Int) -> Double {
        Double(frames) / sampleRate * 1000
    }
}

/// The few lines between a speaker chunk and the player, factored out of
/// `AudioEngine.play(pcm:)` so playout-probe runs the shipped code against an offline
/// engine: PCM16 → Float32, the cushion's plan, the pre-roll, the fade-in, the schedule —
/// and the flush, which fades the main mixer out before it drops the backlog (the mixer
/// smooths a volume write over ~20 ms; measured offline), so a barge-in does not click. The
/// mixer comes back only once its converter has let go of the last ~1.3 ms of the old stream
/// (`flushRestore` later), under the next stream's pre-roll.
///
/// Not thread-safe: the engine calls it on `jarhead.audio` only. Scheduling and the player
/// can raise: the caller wraps those calls in `objcTry`. The mixer's volume writes sit in
/// their own `objcTry` here, so a raise never leaves a flush half begun.
final class SpeakerScheduler {
    /// How long the mixer gets to fade out before the flush drops the backlog.
    static let flushFade: TimeInterval = 0.03
    /// After the drop, how long the mixer stays silent while its converter drains (two IO
    /// cycles); the next stream's pre-roll (≥ 120 ms) covers it.
    static let flushRestore: TimeInterval = 0.02

    struct Scheduled {
        /// The chunk as Live sent it (before the fade-in), for the duck and the guard.
        let rms: Double
        let seconds: Double
        /// Silence scheduled in front of it.
        let prerollSeconds: Double
        let plan: PlayoutModel.Plan
    }

    let player: AVAudioPlayerNode
    let format: AVAudioFormat
    /// The main mixer the player feeds, handed over at each start: the engine creates it (and
    /// its implicit connection to the output) while it wires the graph, never earlier.
    private(set) var mixer: AVAudioMixerNode?
    private(set) var model = PlayoutModel()
    /// A flush is fading out; chunks that arrive meanwhile wait for it (they are the next reply).
    private(set) var fading = false
    private var held: [Data] = []
    private var flushToken = 0

    init(player: AVAudioPlayerNode, format: AVAudioFormat) {
        self.player = player
        self.format = format
    }

    /// A new graph (start, restart): a fresh model, counters since this start, the mixer at unity.
    func restart(mixer: AVAudioMixerNode) {
        self.mixer = mixer
        model = PlayoutModel()
        cancelFlush()
    }

    /// The graph is going down: no fade to finish, nothing held, the mixer back at unity.
    func cancelFlush() {
        fading = false
        held.removeAll()
        flushToken += 1
        setMixer(1)
    }

    /// The player's own sample time now; nil before it has rendered.
    func playerNow() -> Int64? {
        guard let last = player.lastRenderTime, last.isSampleTimeValid || last.isHostTimeValid,
              let t = player.playerTime(forNodeTime: last), t.isSampleTimeValid else { return nil }
        return t.sampleTime
    }

    /// Convert, plan, fade, schedule. While a flush fades, the chunk is held and nil returned.
    func schedule(pcm: Data) -> Scheduled? {
        guard !fading else {
            held.append(pcm)
            return nil
        }
        return enqueue(pcm)
    }

    /// Flush, step one: the mixer fades out. Returns the token `finishFlush` takes, or nil
    /// when a fade is already running (what it holds is dropped: it came before this flush).
    func beginFlush() -> Int? {
        held.removeAll()
        guard !fading else { return nil }
        fading = true
        flushToken += 1
        setMixer(0)
        return flushToken
    }

    /// Flush, step two (`flushFade` later): the backlog dropped, the next chunk opens a new
    /// stream, the held chunks scheduled behind its pre-roll. Empty for a stale token.
    func finishFlush(token: Int, engineRunning: Bool) -> [Scheduled] {
        guard fading, token == flushToken else { return [] }
        fading = false
        model.reset()
        let waiting = held
        held.removeAll()
        guard engineRunning else {
            setMixer(1)
            player.stop()
            return []
        }
        player.stop()
        player.play()
        return waiting.compactMap { enqueue($0) }
    }

    /// Flush, step three (`flushRestore` later): the mixer back at unity, unless another flush
    /// or a stop has taken over since.
    func restoreAfterFlush(token: Int) {
        guard !fading, token == flushToken else { return }
        setMixer(1)
    }

    private func setMixer(_ volume: Float) {
        guard let mixer else { return }
        try? objcTry { mixer.outputVolume = volume }
    }

    private func enqueue(_ pcm: Data) -> Scheduled? {
        let frames = pcm.count / 2
        guard frames > 0, let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)),
              let dst = buf.floatChannelData?[0] else { return nil }
        buf.frameLength = AVAudioFrameCount(frames)
        var samples = [Int16](repeating: 0, count: frames)
        _ = samples.withUnsafeMutableBytes { pcm.copyBytes(to: $0, count: frames * 2) }
        let scale = Float(1.0 / 32768.0)
        var energy = 0.0
        for i in 0 ..< frames {
            let s = Float(samples[i]) * scale
            dst[i] = s
            energy += Double(s * s)
        }
        let plan = model.plan(frames: frames, now: playerNow())
        if plan.fadeIn {
            for i in 0 ..< min(frames, PlayoutModel.fadeFrames) { dst[i] *= PlayoutModel.fadeGain(i) }
        }
        if plan.prerollFrames > 0, let silence = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(plan.prerollFrames)),
           let zeros = silence.floatChannelData?[0] {
            silence.frameLength = AVAudioFrameCount(plan.prerollFrames)
            for i in 0 ..< plan.prerollFrames { zeros[i] = 0 }
            player.scheduleBuffer(silence, completionHandler: nil)
        }
        player.scheduleBuffer(buf, completionHandler: nil)
        if !player.isPlaying { player.play() }
        let rate = format.sampleRate
        return Scheduled(rms: clampLevel((energy / Double(frames)).squareRoot()), seconds: Double(frames) / rate, prerollSeconds: Double(plan.prerollFrames) / rate, plan: plan)
    }
}
