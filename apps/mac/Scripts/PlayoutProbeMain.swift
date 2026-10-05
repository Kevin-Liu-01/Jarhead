import AVFoundation
import Darwin
import Foundation

// The speaker's playout cushion and the queue it runs on, measured without a device (voice
// PLAN W1.1, W1.2). Nothing is played, recorded or opened: every AVAudioEngine here runs in
// manual rendering mode and its output is only inspected. No TCC, no window, no session.
// Compiled only by Scripts/playout-probe.sh, with Audio/*.swift: the probe drives the shipped
// `SpeakerScheduler`, `PlayoutModel` and `AudioStateReader`, not copies.
//
//   Scripts/playout-probe.sh            offline: 24 kHz mono player → mainMixer → 48 kHz stereo,
//                                       pulled 10 ms at a time; each arrival trace through three
//                                       policies, then the gates
//   Scripts/playout-probe.sh --stall    real time: the play queue beside the real AudioStateReader
//   Scripts/playout-probe.sh --stall --legacy   …plus a rig with the reads back on the play queue
//   PLAYOUT_PROBE_SECONDS=60            content per offline trace
//   PLAYOUT_PROBE_STALL_S=150           length of the --stall run
//   PLAYOUT_PROBE_DEBUG=1               print every hole with where it sits against the last cut
//
// Offline policies: `today` is main's play(pcm:) and flush() line for line (schedule on arrival,
// stop at once); `cushion` is SpeakerScheduler (pre-roll after a reset, fade-in after silence,
// the mixer fade at a flush); `reprime` is the cushion that also re-primes after an underrun.
// The content carries a +4 LSB DC marker, so an exact zero in the output is the player gone dry:
// a hole is ≥ 0.5 ms of exact zeros between voiced samples inside one stream (a flush starts the
// next stream). A click is a sample-to-sample step over 0.05 (the content's own steps stay
// under 0.01).
//
// Offline gates: today shows ≥ 3 holes/min on paced arrival with the readback ticks (the defect);
// the cushion has 0 holes on paced and on |N(0,50 ms)| jitter, ≤ 30% of today's speech-hole time
// on the Wi-Fi model, the source's level within 0.1 dB, an added p50 latency ≤ 130 ms (≤ the
// grown target + 10 ms on a trace whose underruns raised it; PLAN W1.1 asked for 130 ms flat);
// its `underruns` equal its rendered holes, and its `wouldBeUnderruns` equal today's holes
// (traces without a flush); three chunks scheduled before the player's first render get one
// pre-roll between them, with 0 holes and 0 underruns. --stall gates: the HAL on its own queue
// keeps every play block's wait ≤ 10 ms (or within 2 ms of the rig with no HAL work, when a
// loaded machine holds that rig past 10 ms; PLAN W1.2 asked for 10 ms flat) and that rig's
// holes ± 1; --legacy must show waits ≥ 20 ms.

let outFormat = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 2)!
let playFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24_000, channels: 1, interleaved: false)!
/// One render pull: 10 ms at 48 kHz.
let pullFrames = 480
/// One of Live's deltas: 40 ms at 24 kHz.
let chunkFrames = 960
let chunkSeconds = 0.04
/// ≥ 0.5 ms of exact zeros at 48 kHz.
let holeMinFrames = 24
/// Dry 0.5 s or longer is between replies, a new stream (`PlayoutModel.dryResetFrames`), not a hole.
let streamGapFrames = PlayoutModel.dryResetFrames * 2
let clickStep: Float = 0.05

func say(_ s: String) { print(s) }

@main
struct PlayoutProbeMain {
    static func main() {
        setlinebuf(stdout)
        let args = CommandLine.arguments
        let env = ProcessInfo.processInfo.environment
        if args.contains("--stall") {
            let seconds = max(10, Double(env["PLAYOUT_PROBE_STALL_S"] ?? "") ?? 150)
            let probe = StallProbe(seconds: seconds, legacy: args.contains("--legacy"))
            Thread.detachNewThread {
                let ok = probe.run()
                DispatchQueue.main.async { exit(ok ? 0 : 2) }
            }
            RunLoop.main.run()
        } else {
            let seconds = max(10, Double(env["PLAYOUT_PROBE_SECONDS"] ?? "") ?? 60)
            exit(OfflineProbe(seconds: seconds).run() ? 0 : 2)
        }
    }
}

// MARK: - content and arrivals

struct ProbeRNG {
    var state: UInt64
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
    mutating func uniform() -> Double { Double(next() >> 11) / Double(1 << 53) }
    mutating func uniform(_ a: Double, _ b: Double) -> Double { a + (b - a) * uniform() }
    mutating func gauss() -> Double {
        let u1 = max(1e-12, uniform()), u2 = uniform()
        return (-2 * log(u1)).squareRoot() * cos(2 * .pi * u2)
    }
    mutating func exp(mean: Double) -> Double { -mean * log(max(1e-12, 1 - uniform())) }
}

/// Live-like output at 24 kHz, with the time each 40 ms chunk leaves Live.
struct Content {
    var pcm: [Int16] = []
    /// When each chunk is sent, paced at real time within its reply (s).
    var sent: [Double] = []
    /// Seconds of reply audio.
    var seconds: Double { Double(pcm.count) / 24_000 }
}

func replyCount(_ c: Content) -> Int {
    zip(c.sent, c.sent.dropFirst()).filter { $1 - $0 > chunkSeconds * 1.5 }.count + 1
}

/// Replies of 4–12 s (sentences of 1.5–4.5 s and 0.4–1.2 s of silence) separated by 1.5–4 s of
/// Kevin's turn, when nothing is sent and the player runs dry: each reply opens a new stream.
/// Speech is three harmonics of 180 Hz under a 4 Hz syllable envelope that never reaches zero
/// (peak about −12 dBFS), ramped over 5 ms at each sentence's edges so the content itself never
/// clicks; every sample + 4 LSB, so the player's own silence is the only exact zero.
/// `replies: false` makes one continuous reply of `seconds`.
func makeContent(seconds: Double, seed: UInt64, replies: Bool = true) -> Content {
    var rng = ProbeRNG(state: seed)
    var c = Content()
    var wall = 0.0
    while wall < seconds {
        let length = replies ? rng.uniform(4, 12) : seconds
        let frames = Int(length * 24_000) / chunkFrames * chunkFrames
        var reply = [Int16](repeating: 4, count: frames)
        var i = Int(0.2 * 24_000)
        while i < frames {
            let len = min(frames - i, Int(rng.uniform(1.5, 4.5) * 24_000))
            let ramp = 120
            for k in i ..< i + len {
                let t = Double(k) / 24_000
                let edge = min(1, Double(min(k - i, i + len - 1 - k)) / Double(ramp))
                let env = 0.25 * (0.55 + 0.45 * sin(2 * .pi * 4 * t)) * edge
                let v = env * (sin(2 * .pi * 180 * t) + 0.5 * sin(2 * .pi * 360 * t) + 0.25 * sin(2 * .pi * 540 * t)) / 1.75
                reply[k] = Int16(max(-32_767, min(32_763, v * 32_768))) + 4
            }
            i += len + Int(rng.uniform(0.4, 1.2) * 24_000)
        }
        for j in 0 ..< frames / chunkFrames { c.sent.append(wall + Double(j) * chunkSeconds) }
        c.pcm += reply
        wall += Double(frames) / 24_000 + (replies ? rng.uniform(1.5, 4) : 0)
    }
    return c
}

/// One socket and serial queues: a late chunk holds every later one.
func inOrder(_ a: [Double]) -> [Double] {
    var out = a
    for i in out.indices.dropFirst() where out[i] < out[i - 1] { out[i] = out[i - 1] }
    return out
}

/// Serial-queue stalls: anything that lands inside [t, t + d) runs at t + d.
func queueStalls(_ a: [Double], _ stalls: [(Double, Double)]) -> [Double] {
    var out = a
    for (t, d) in stalls {
        for i in out.indices where out[i] >= t && out[i] < t + d { out[i] = t + d }
    }
    return inOrder(out)
}

struct Trace {
    let name: String
    let arrivals: [Double]
    var flushes: [Double] = []
}

/// After a cut, the mixer's converter still holds ~1.3 ms of the old stream: skip 2 ms.
let cutTailFrames = 96

func traces(_ content: Content) -> [Trace] {
    let paced = content.sent
    var rng = ProbeRNG(state: 11)
    func jitter(_ sdMs: Double) -> [Double] { inOrder(paced.map { $0 + abs(rng.gauss()) * sdMs / 1000 }) }
    let readback = Traces.values(Traces.readbackMs)
    let replay = Traces.values(Traces.replayLatenessMs)
    var out: [Trace] = [
        Trace(name: "paced", arrivals: paced),
        Trace(name: "jitter |N(0,20)|", arrivals: jitter(20)),
        Trace(name: "jitter |N(0,50)|", arrivals: jitter(50)),
        Trace(name: "jitter |N(0,100)|", arrivals: jitter(100)),
    ]
    // Poisson stalls of 50–250 ms, one every 5 s on average: what was produced meanwhile lands at the end.
    var stalls: [(Double, Double)] = []
    var t = rng.exp(mean: 5)
    while t < paced.last ?? 0 {
        let d = rng.uniform(0.05, 0.25)
        stalls.append((t, d))
        t += d + rng.exp(mean: 5)
    }
    out.append(Trace(name: "stalls 50-250 ms", arrivals: queueStalls(paced, stalls)))
    // The 5 s readback tick holding the speaker's queue for a measured duration.
    var ticks: [(Double, Double)] = []
    var k = 0
    var tick = 2.5
    while tick < paced.last ?? 0 {
        ticks.append((tick, readback[(k * 37) % readback.count] / 1000))
        k += 1
        tick += 5
    }
    out.append(Trace(name: "paced + readback ticks", arrivals: queueStalls(paced, ticks)))
    out.append(Trace(name: "replay (prove-14 link)", arrivals: inOrder(paced.enumerated().map { $0.element + max(0, replay[($0.offset + 400) % replay.count]) / 1000 })))
    // prove-5 M2, the Wi-Fi model: |N(0,10)| and 1% of deltas held 50–250 ms.
    out.append(Trace(name: "wifi", arrivals: inOrder(paced.map { a -> Double in
        var x = a + abs(rng.gauss()) * 0.010
        if rng.uniform() < 0.01 { x += rng.uniform(0.05, 0.25) }
        return x
    })))
    var flushed = Trace(name: "jitter |N(0,20)| + flush every 7 s", arrivals: jitter(20))
    flushed.flushes = Array(stride(from: 7.0, to: paced.last ?? 0, by: 7.0))
    out.append(flushed)
    return out
}

func pcmData(_ pcm: [Int16], chunk i: Int) -> Data {
    pcm[(i * chunkFrames) ..< ((i + 1) * chunkFrames)].withUnsafeBufferPointer { Data(buffer: $0) }
}

func percentile(_ v: [Double], _ p: Double) -> Double {
    guard !v.isEmpty else { return .nan }
    let s = v.sorted()
    return s[min(s.count - 1, max(0, Int((p / 100 * Double(s.count)).rounded(.up)) - 1))]
}

/// The scheduling of a buffer reaches the render side asynchronously; a pull issued at once can
/// miss a buffer on an empty queue (prove-5 cal). Real time has 0–10 ms here; give it 400 µs.
func settle() {
    let t0 = DispatchTime.now().uptimeNanoseconds
    while DispatchTime.now().uptimeNanoseconds - t0 < 400_000 {}
}

// MARK: - offline: the three policies on each trace

enum Policy: String, CaseIterable {
    case today, cushion, reprime
}

struct RunResult {
    var holes = 0
    var holeMs = 0.0
    var longestMs = 0.0
    var speechHoles = 0
    var speechHoleMs = 0.0
    var clicks = 0
    /// Output vs source energy, dB (every chunk played exactly once: traces without a flush).
    var levelDb: Double?
    var latencyP50 = 0.0
    var latencyP95 = 0.0
    var stats = PlayoutModel.Stats()
    var targetMs = 0.0
    /// The frame's `playout` and `output` objects as the app would send them (voice PLAN W1.5), the cushion only.
    var frame: (playout: PlayoutReadback, output: OutputReadback)?
}

final class OfflineRig {
    let engine = AVAudioEngine()
    let player = AVAudioPlayerNode()
    let speaker: SpeakerScheduler
    let buffer: AVAudioPCMBuffer
    var out: [Float] = []
    var touched = false

    init() throws {
        try engine.enableManualRenderingMode(.offline, format: outFormat, maximumFrameCount: 4096)
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: playFormat)
        engine.connect(engine.mainMixerNode, to: engine.outputNode, format: outFormat)
        try engine.start()
        player.play()
        speaker = SpeakerScheduler(player: player, format: playFormat)
        speaker.restart(mixer: engine.mainMixerNode)
        buffer = AVAudioPCMBuffer(pcmFormat: engine.manualRenderingFormat, frameCapacity: 4096)!
    }

    func pull() {
        if touched {
            settle()
            touched = false
        }
        let status = try? engine.renderOffline(AVAudioFrameCount(pullFrames), to: buffer)
        precondition(status == .success, "render failed")
        out.append(contentsOf: UnsafeBufferPointer(start: buffer.floatChannelData![0], count: Int(buffer.frameLength)))
    }

    /// main's play(pcm:) after the queue hop, line for line: convert, schedule, play if idle.
    func playToday(_ pcm: Data) {
        let frames = pcm.count / 2
        guard frames > 0, let buf = AVAudioPCMBuffer(pcmFormat: playFormat, frameCapacity: AVAudioFrameCount(frames)) else { return }
        buf.frameLength = AVAudioFrameCount(frames)
        guard let dst = buf.floatChannelData?[0] else { return }
        var samples = [Int16](repeating: 0, count: frames)
        _ = samples.withUnsafeMutableBytes { pcm.copyBytes(to: $0, count: frames * 2) }
        let scale = Float(1.0 / 32768.0)
        for i in 0 ..< frames { dst[i] = Float(samples[i]) * scale }
        player.scheduleBuffer(buf, completionHandler: nil)
        if !player.isPlaying { player.play() }
    }

    /// The re-prime variant: SpeakerScheduler's steps, plus a reset when the player has run dry.
    func playReprime(_ pcm: Data, model: inout PlayoutModel) {
        let frames = pcm.count / 2
        let now = speaker.playerNow()
        if model.primed, let now, now > model.scheduledEnd, now - model.scheduledEnd < Int64(PlayoutModel.dryResetFrames) { model.reset() }
        let plan = model.plan(frames: frames, now: now)
        guard let buf = AVAudioPCMBuffer(pcmFormat: playFormat, frameCapacity: AVAudioFrameCount(frames)), let dst = buf.floatChannelData?[0] else { return }
        buf.frameLength = AVAudioFrameCount(frames)
        var samples = [Int16](repeating: 0, count: frames)
        _ = samples.withUnsafeMutableBytes { pcm.copyBytes(to: $0, count: frames * 2) }
        for i in 0 ..< frames { dst[i] = Float(samples[i]) / 32768 }
        if plan.fadeIn { for i in 0 ..< min(frames, PlayoutModel.fadeFrames) { dst[i] *= PlayoutModel.fadeGain(i) } }
        if plan.prerollFrames > 0, let silence = AVAudioPCMBuffer(pcmFormat: playFormat, frameCapacity: AVAudioFrameCount(plan.prerollFrames)) {
            silence.frameLength = AVAudioFrameCount(plan.prerollFrames)
            for i in 0 ..< plan.prerollFrames { silence.floatChannelData![0][i] = 0 }
            player.scheduleBuffer(silence, completionHandler: nil)
        }
        player.scheduleBuffer(buf, completionHandler: nil)
        if !player.isPlaying { player.play() }
    }
}

struct OfflineProbe {
    let seconds: Double

    func run() -> Bool {
        let content = makeContent(seconds: seconds, seed: 3)
        let all = traces(content)
        let minutes = content.seconds / 60
        say(String(format: "playout-probe offline: %d replies, %.0f s of Live-like speech per trace, 40 ms chunks, 10 ms pulls, 24 kHz mono player → mainMixer → 48 kHz stereo (manual rendering, nothing audible)", replyCount(content), content.seconds))
        var results: [String: [Policy: RunResult]] = [:]
        for trace in all {
            var row: [Policy: RunResult] = [:]
            for policy in Policy.allCases {
                let r = run(trace, policy, pcm: content.pcm)
                row[policy] = r
                let level = r.levelDb.map { String(format: "%+.3f dB", $0) } ?? "n/a"
                var line = String(format: "  %-36@ %-8@ holes %3d (%6.1f ms, longest %5.1f; touching speech %3d, %6.1f ms) %5.2f/min · clicks %3d · level %@ · arrival→play p50 %5.1f p95 %5.1f ms", trace.name as NSString, policy.rawValue as NSString, r.holes, r.holeMs, r.longestMs, r.speechHoles, r.speechHoleMs, Double(r.holes) / minutes, r.clicks, level, r.latencyP50, r.latencyP95)
                if policy != .today { line += String(format: " · model: %d underruns, %d resets, zero-cushion would be %d, target %.0f ms", r.stats.underruns, r.stats.resets, r.stats.wouldBeUnderruns, r.targetMs) }
                say(line)
            }
            results[trace.name] = row
        }
        return gates(all, results, minutes: minutes)
    }

    private func gates(_ all: [Trace], _ results: [String: [Policy: RunResult]], minutes: Double) -> Bool {
        var fails: [String] = []
        var oks = 0
        func check(_ name: String, _ ok: Bool, _ detail: String) {
            if ok { oks += 1; say("gate: \(name) ok (\(detail))") } else { fails.append(name); say("gate: \(name) FAIL (\(detail))") }
        }
        func r(_ t: String, _ p: Policy) -> RunResult { results[t]![p]! }
        if let f = r("paced", .cushion).frame {
            let p = f.playout, o = f.output
            say("frame playout (paced): {\"chunks\":\(p.chunks),\"underruns\":\(p.underruns),\"underrunMs\":\(p.underrunMs),\"longestUnderrunMs\":\(p.longestUnderrunMs),\"wouldBeUnderruns\":\(p.wouldBeUnderruns),\"resets\":\(p.resets),\"targetMs\":\(p.targetMs),\"queuedMs\":\(p.queuedMs),\"queuedMinMs\":\(p.queuedMinMs ?? -1),\"lateMaxMs\":\(p.lateMaxMs),\"droppedChunks\":\(p.droppedChunks),\"droppedMs\":\(p.droppedMs)} output: {\"rmsDbfs\":\(o.rmsDbfs ?? 0),\"peakDbfs\":\(o.peakDbfs ?? 0),\"heardRmsDbfs\":\(o.heardRmsDbfs ?? 0),\"audibleMs\":\(o.audibleMs),\"mixFormat\":\"\(o.mixFormat)\"}")
        }
        let rb = r("paced + readback ticks", .today)
        check("today reproduces the defect on paced + readback ticks", Double(rb.holes) / minutes >= 3, String(format: "%.1f holes/min", Double(rb.holes) / minutes))
        check("cushion: 0 holes on paced", r("paced", .cushion).holes == 0, "\(r("paced", .cushion).holes) holes")
        check("cushion: 0 holes on |N(0,50)|", r("jitter |N(0,50)|", .cushion).holes == 0, "\(r("jitter |N(0,50)|", .cushion).holes) holes")
        let wToday = r("wifi", .today).speechHoleMs, wCushion = r("wifi", .cushion).speechHoleMs
        check("cushion: ≤ 30% of today's speech-hole time on the Wi-Fi model", wCushion <= 0.3 * wToday && wToday > 0, String(format: "%.1f ms vs %.1f ms", wCushion, wToday))
        for trace in all {
            let c = r(trace.name, .cushion), t = r(trace.name, .today)
            if let level = c.levelDb { check("cushion: level within 0.1 dB on \(trace.name)", abs(level) <= 0.1, String(format: "%+.3f dB", level)) }
            // 130 ms on a calm stream; where underruns raised the target, the target + 10 ms (PLAN W1.1 risk).
            let bound = c.targetMs > PlayoutModel.ms(PlayoutModel.defaultTargetFrames) ? c.targetMs + 10 : 130
            check("cushion: added p50 latency ≤ \(Int(bound)) ms on \(trace.name)", c.latencyP50 - t.latencyP50 <= bound, String(format: "%.1f ms, target %.0f ms", c.latencyP50 - t.latencyP50, c.targetMs))
            check("cushion: underruns equal the rendered holes on \(trace.name)", c.stats.underruns == c.holes, "\(c.stats.underruns) vs \(c.holes)")
            if trace.flushes.isEmpty {
                check("cushion: wouldBeUnderruns equal today's holes on \(trace.name)", c.stats.wouldBeUnderruns == t.holes, "\(c.stats.wouldBeUnderruns) vs \(t.holes)")
            }
            // The frame's objects (voice PLAN W1.5) say what was rendered.
            if let f = c.frame {
                let counts = f.playout.underruns == c.holes && f.playout.chunks == c.stats.chunks && f.playout.resets == c.stats.resets
                    && (!trace.flushes.isEmpty || f.playout.wouldBeUnderruns == t.holes)
                let level = f.output.rmsDbfs != nil && f.output.heardRmsDbfs == f.output.rmsDbfs && f.output.audibleMs > 0 && f.output.mixFormat == "48000 Hz ×2"
                check("telemetry: the frame's playout and output objects match the render on \(trace.name)", counts && level,
                      "underruns \(f.playout.underruns) vs \(c.holes) holes · would be \(f.playout.wouldBeUnderruns) vs today \(t.holes) · rms \(f.output.rmsDbfs ?? .nan) dBFS · \(f.output.audibleMs) ms voiced · mix \(f.output.mixFormat)")
            } else {
                check("telemetry: the frame's playout and output objects match the render on \(trace.name)", false, "no readback")
            }
        }
        // The re-prime variant: keep it only if it has less speech-hole time at equal p50 latency.
        var reprimeWins = 0, ties = 0, losses = 0
        for trace in all {
            let c = r(trace.name, .cushion), p = r(trace.name, .reprime)
            if p.speechHoleMs < c.speechHoleMs, p.latencyP50 <= c.latencyP50 + 1 { reprimeWins += 1 } else if p.speechHoleMs == c.speechHoleMs, abs(p.latencyP50 - c.latencyP50) <= 1 { ties += 1 } else { losses += 1 }
        }
        say("re-prime vs reset-only: re-prime better on \(reprimeWins) traces, tied on \(ties), worse on \(losses) → \(reprimeWins > losses ? "re-prime" : "reset-only (shipped)")")
        let b = burstBeforeFirstRender()
        check("cushion: 3 chunks scheduled before the first pull play with one pre-roll, 0 holes, 0 underruns", b.holes == 0 && b.stats.underruns == 0 && b.stats.resets == 1 && b.prerolls == [PlayoutModel.defaultTargetFrames, 0, 0] && b.targetFrames == PlayoutModel.defaultTargetFrames, "pre-rolls \(b.prerolls), holes \(b.holes), underruns \(b.stats.underruns), resets \(b.stats.resets), target \(Int(PlayoutModel.ms(b.targetFrames))) ms")
        say("gates: \(oks) ok, \(fails.count) FAIL")
        return fails.isEmpty
    }

    /// A restart that queued chunks behind it (play blocks waiting on the audio queue run right
    /// after `finishStart`): three chunks reach the shipped SpeakerScheduler before the player
    /// has rendered once, then the stream goes on paced. The player's render time is nil for
    /// all three; the stream is primed by the first, so the next two are contiguous.
    private func burstBeforeFirstRender() -> (holes: Int, stats: PlayoutModel.Stats, prerolls: [Int], targetFrames: Int) {
        guard let rig = try? OfflineRig() else { fatalError("no offline engine") }
        let content = makeContent(seconds: 3, seed: 5, replies: false)
        let chunks = content.pcm.count / chunkFrames
        var prerolls: [Int] = []
        var next = 0
        func send() {
            if let s = rig.speaker.schedule(pcm: pcmData(content.pcm, chunk: next)) { prerolls.append(s.plan.prerollFrames) }
            next += 1
            rig.touched = true
        }
        for _ in 0 ..< 3 { send() }
        // Then one 40 ms chunk every four 10 ms pulls, and half a second to drain.
        let pulls = chunks * 4 + 50
        for k in 0 ..< pulls {
            if k > 0, k % 4 == 0, next < chunks { send() }
            rig.pull()
        }
        let r = analyze(rig.out, cuts: [0])
        return (r.holes, rig.speaker.model.stats, Array(prerolls.prefix(3)), rig.speaker.model.targetFrames)
    }

    private func run(_ trace: Trace, _ policy: Policy, pcm: [Int16]) -> RunResult {
        guard let rig = try? OfflineRig() else { fatalError("no offline engine") }
        let chunks = pcm.count / chunkFrames
        var reprime = PlayoutModel()
        var next = 0
        var flushIndex = 0
        var base48 = 0
        var todayEnd: Int64 = 0
        var latencies: [Double] = []
        var cuts: [Int] = [0]
        var pending: (token: Int, at: Int)?
        var restore: (token: Int, at: Int)?
        var heldArrivals: [Double] = []
        // The app's telemetry, fed exactly as AudioEngine.noteSpeaker feeds it (no duck here: gain 1).
        let telemetry = PlaybackTelemetry()
        let mix = rig.engine.mainMixerNode.outputFormat(forBus: 0)
        telemetry.restart(mixFormat: "\(Int(mix.sampleRate)) Hz ×\(mix.channelCount)")
        let end = (trace.arrivals.last ?? 0) + 1.5
        let pulls = Int(end / 0.01)

        func noteStart(_ start: Int64, arrival: Double) {
            latencies.append((Double(base48) + 2 * Double(start)) / 48_000 * 1000 - arrival * 1000)
        }

        for k in 0 ..< pulls {
            let t = Double(k) * 0.01
            if let r = restore, k >= r.at {
                restore = nil
                rig.speaker.restoreAfterFlush(token: r.token)
            }
            if let p = pending, k >= p.at {
                pending = nil
                restore = (p.token, k + Int((SpeakerScheduler.flushRestore / 0.01).rounded()))
                let resumed = rig.speaker.finishFlush(token: p.token, engineRunning: true)
                for chunk in resumed { telemetry.noteScheduled(chunk, model: rig.speaker.model, gain: 1) }
                base48 = rig.out.count
                cuts.append(rig.out.count)
                let scheduledEnd = rig.speaker.model.scheduledEnd
                for (i, arrival) in heldArrivals.prefix(resumed.count).enumerated() {
                    noteStart(scheduledEnd - Int64((resumed.count - i) * chunkFrames), arrival: arrival)
                }
                heldArrivals.removeAll()
                rig.touched = true
            }
            while flushIndex < trace.flushes.count, trace.flushes[flushIndex] <= t {
                flushIndex += 1
                switch policy {
                case .today:
                    rig.player.stop()
                    rig.player.play()
                    base48 = rig.out.count
                    todayEnd = 0
                    cuts.append(rig.out.count)
                case .cushion:
                    heldArrivals.removeAll()
                    if let token = rig.speaker.beginFlush() { pending = (token, k + Int((SpeakerScheduler.flushFade / 0.01).rounded())) }
                case .reprime:
                    rig.player.stop()
                    rig.player.play()
                    reprime.reset()
                    base48 = rig.out.count
                    cuts.append(rig.out.count)
                }
                rig.touched = true
            }
            while next < chunks, trace.arrivals[next] <= t {
                let data = pcmData(pcm, chunk: next)
                let arrival = trace.arrivals[next]
                switch policy {
                case .today:
                    let now = rig.speaker.playerNow() ?? 0
                    let start = max(todayEnd, now)
                    todayEnd = start + Int64(chunkFrames)
                    noteStart(start, arrival: arrival)
                    rig.playToday(data)
                case .cushion:
                    if let scheduled = rig.speaker.schedule(pcm: data) {
                        telemetry.noteScheduled(scheduled, model: rig.speaker.model, gain: 1)
                        noteStart(rig.speaker.model.scheduledEnd - Int64(chunkFrames), arrival: arrival)
                    } else {
                        heldArrivals.append(arrival)
                    }
                case .reprime:
                    rig.playReprime(data, model: &reprime)
                    noteStart(reprime.scheduledEnd - Int64(chunkFrames), arrival: arrival)
                }
                next += 1
                rig.touched = true
            }
            rig.pull()
        }
        var result = analyze(rig.out, cuts: cuts)
        if trace.flushes.isEmpty {
            var source = 0.0
            for s in pcm { source += Double(s) * Double(s) / (32_768.0 * 32_768.0) }
            let rendered = rig.out.reduce(0.0) { $0 + Double($1) * Double($1) }
            result.levelDb = 10 * log10(rendered / (2 * source))
        }
        result.latencyP50 = percentile(latencies, 50)
        result.latencyP95 = percentile(latencies, 95)
        switch policy {
        case .today: break
        case .cushion:
            result.stats = rig.speaker.model.stats
            result.targetMs = PlayoutModel.ms(rig.speaker.model.targetFrames)
            result.frame = telemetry.readback()
        case .reprime:
            result.stats = reprime.stats
            result.targetMs = PlayoutModel.ms(reprime.targetFrames)
        }
        return result
    }

    /// Holes inside each stream (between flush cuts), and clicks anywhere.
    private func analyze(_ y: [Float], cuts: [Int]) -> RunResult {
        var r = RunResult()
        let bounds = cuts + [y.count]
        for s in 0 ..< bounds.count - 1 {
            let lo = s == 0 ? bounds[s] : min(bounds[s + 1], bounds[s] + cutTailFrames), hi = bounds[s + 1]
            guard lo < hi, let first = y[lo ..< hi].firstIndex(where: { $0 != 0 }), let last = y[lo ..< hi].lastIndex(where: { $0 != 0 }) else { continue }
            var run = 0
            for n in first ... last {
                if y[n] == 0 {
                    run += 1
                    continue
                }
                if run >= holeMinFrames, run < streamGapFrames {
                    let ms = Double(run) / 48
                    if ProcessInfo.processInfo.environment["PLAYOUT_PROBE_DEBUG"] != nil {
                        let start = n - run
                        let preVoiced = y[max(lo, start - 480) ..< start].filter { $0 != 0 }.count
                        say(String(format: "    hole at %.3f s, %.1f ms, %d after cut %.3f s; non-zero in the 10 ms before: %d, max before %.5f", Double(start) / 48_000, ms, start - lo, Double(lo) / 48_000, preVoiced, y[max(lo, start - 480) ..< start].map { abs($0) }.max() ?? 0))
                    }
                    r.holes += 1
                    r.holeMs += ms
                    r.longestMs = max(r.longestMs, ms)
                    let before = y[max(first, n - run - 240) ..< (n - run)].map { abs($0) }.max() ?? 0
                    let after = y[n ..< min(last + 1, n + 240)].map { abs($0) }.max() ?? 0
                    if max(before, after) > 0.01 {
                        r.speechHoles += 1
                        r.speechHoleMs += ms
                    }
                }
                run = 0
            }
        }
        var lastClick = -1_000
        for n in 1 ..< y.count where abs(y[n] - y[n - 1]) > clickStep {
            if n - lastClick > 96 { r.clicks += 1 }
            lastClick = n
        }
        return r
    }
}

// MARK: - --stall: the play queue beside the real AudioStateReader, in real time

var timebase: mach_timebase_info_data_t = {
    var tb = mach_timebase_info_data_t()
    mach_timebase_info(&tb)
    return tb
}()

func hostToMs(_ h: UInt64) -> Double { Double(h) * Double(timebase.numer) / Double(timebase.denom) / 1e6 }
func msToHost(_ ms: Double) -> UInt64 { UInt64(max(0, ms) * 1e6 * Double(timebase.denom) / Double(timebase.numer)) }

/// The calling thread becomes a time-constraint thread with this period, as the device's IO thread is.
func makeRealtime(periodMs: Double, computationMs: Double) {
    var policy = thread_time_constraint_policy_data_t(period: UInt32(msToHost(periodMs)), computation: UInt32(msToHost(computationMs)), constraint: UInt32(msToHost(periodMs)), preemptible: 1)
    let count = mach_msg_type_number_t(MemoryLayout<thread_time_constraint_policy_data_t>.size / MemoryLayout<integer_t>.size)
    _ = withUnsafeMutablePointer(to: &policy) { p in
        p.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
            thread_policy_set(pthread_mach_thread_np(pthread_self()), thread_policy_flavor_t(THREAD_TIME_CONSTRAINT_POLICY), $0, count)
        }
    }
}

/// One rig: a `.realtime` manual-rendering engine pulled every 10 ms by its own time-constraint
/// thread, the shipped SpeakerScheduler on a serial `jarhead.audio` queue, and the HAL work
/// where `kind` says.
final class StallRig: @unchecked Sendable {
    enum Kind: String {
        case none = "no HAL work"
        case reader = "HAL on its own queue"
        case legacy = "HAL on the play queue"
    }

    let kind: Kind
    let engine = AVAudioEngine()
    let player = AVAudioPlayerNode()
    let queue = DispatchQueue(label: "jarhead.audio")
    let speaker: SpeakerScheduler
    let reader: AudioStateReader?
    private let buffer: AVAudioPCMBuffer
    private var render: AVAudioEngineManualRenderingBlock?
    private var local = AudioLocalFacts()
    /// Play-queue waits, ms (written on `queue` only).
    private(set) var waits: [Double] = []
    // Render-thread counters (written on the render thread only, read after it stops).
    private var zeroRun = 0
    private var voiced = false
    private(set) var holes = 0
    private(set) var holeFrames = 0
    private(set) var renderLateMaxMs = 0.0
    private var stop = false
    private let done = DispatchSemaphore(value: 0)

    init(kind: Kind) throws {
        self.kind = kind
        try engine.enableManualRenderingMode(.realtime, format: outFormat, maximumFrameCount: 4096)
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: playFormat)
        engine.connect(engine.mainMixerNode, to: engine.outputNode, format: outFormat)
        engine.prepare()
        try engine.start()
        player.play()
        render = engine.manualRenderingBlock
        buffer = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: AVAudioFrameCount(pullFrames))!
        speaker = SpeakerScheduler(player: player, format: playFormat)
        speaker.restart(mixer: engine.mainMixerNode)
        switch kind {
        case .none: reader = nil
        case .reader: reader = AudioStateReader()
        case .legacy: reader = AudioStateReader(queue: queue)
        }
        waits.reserveCapacity(8_000)
        // Kevin's setup: voice processing on, following the system default input.
        local.running = true
        local.voiceProcessing = true
        local.echoCancelled = true
        local.rung = 2
        local.wiring = "input-rate"
        local.activeInputUID = MicInputs.systemDefaultUID()
        reader?.start()
        reader?.route(local, reason: "audio running")
    }

    func startRendering(t0: UInt64) {
        Thread.detachNewThread { [self] in
            makeRealtime(periodMs: 10, computationMs: 2)
            var k: UInt64 = 1
            while !stop {
                let due = t0 + msToHost(Double(k) * 10)
                mach_wait_until(due)
                renderLateMaxMs = max(renderLateMaxMs, hostToMs(mach_absolute_time() &- due))
                pull()
                k += 1
            }
            done.signal()
        }
    }

    func stopRendering() {
        stop = true
        done.wait()
    }

    private func pull() {
        guard let render else { return }
        let abl = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
        for i in 0 ..< abl.count { abl[i].mDataByteSize = UInt32(pullFrames * MemoryLayout<Float>.size) }
        var err: OSStatus = noErr
        let status = render(AVAudioFrameCount(pullFrames), buffer.mutableAudioBufferList, &err)
        guard status == .success, let l = buffer.floatChannelData?[0] else { return }
        for n in 0 ..< pullFrames {
            if l[n] == 0 {
                zeroRun += 1
                continue
            }
            if voiced, zeroRun >= holeMinFrames {
                holes += 1
                holeFrames += zeroRun
            }
            zeroRun = 0
            voiced = true
        }
    }

    func play(_ pcm: Data, enqueued: UInt64) {
        queue.async {
            self.waits.append(hostToMs(mach_absolute_time() &- enqueued))
            _ = self.speaker.schedule(pcm: pcm)
        }
    }

    /// The 5 s tick: the counters on the reader's queue (the fix), or today's whole read-back on the play queue.
    func tick() {
        switch kind {
        case .none: break
        case .reader: reader?.refreshCounters("tick")
        case .legacy: reader?.update(local, reason: "tick", readHAL: true)
        }
    }

    func routeEvent(_ reason: String) {
        reader?.simulateRouteChange(reason)
    }

    func waitsSnapshot() -> [Double] {
        queue.sync { waits }
    }
}

struct StallProbe {
    let seconds: Double
    let legacy: Bool

    func run() -> Bool {
        let kinds: [StallRig.Kind] = legacy ? [.none, .reader, .legacy] : [.none, .reader]
        guard let rigs = try? kinds.map({ try StallRig(kind: $0) }) else {
            say("playout-probe --stall: could not build a manual-rendering engine")
            return false
        }
        var load = [Double](repeating: 0, count: 3)
        getloadavg(&load, 3)
        say(String(format: "playout-probe --stall: %.0f s, rigs [%@], paced 40 ms chunks behind the shipped cushion, a tick every 5 s, a device-list change every 10 s and a burst of 5 process-list changes every 7 s; load %.1f", seconds, kinds.map(\.rawValue).joined(separator: " · ") as NSString, load[0]))
        let pcm = makeContent(seconds: seconds + 1, seed: 5, replies: false).pcm
        let chunks = Int(seconds / chunkSeconds)
        let t0 = mach_absolute_time() &+ msToHost(50)
        for rig in rigs { rig.startRendering(t0: t0) }
        makeRealtime(periodMs: 40, computationMs: 2)
        var nextTick = 2.5, nextDevice = 5.0, nextClients = 3.5
        for k in 0 ..< chunks {
            let atMs = Double(k) * chunkSeconds * 1000
            mach_wait_until(t0 &+ msToHost(atMs))
            let data = pcmData(pcm, chunk: k)
            let enqueued = mach_absolute_time()
            for rig in rigs { rig.play(data, enqueued: enqueued) }
            let t = atMs / 1000
            if t >= nextTick {
                nextTick += 5
                for rig in rigs { rig.tick() }
            }
            if t >= nextDevice {
                nextDevice += 10
                for rig in rigs { rig.routeEvent("device list changed") }
            }
            if t >= nextClients {
                nextClients += 7
                for _ in 0 ..< 5 { for rig in rigs { rig.routeEvent(MicRouter.clientsReason) } }
            }
        }
        mach_wait_until(t0 &+ msToHost((Double(chunks) * chunkSeconds + 1) * 1000))
        for rig in rigs { rig.stopRendering() }
        var oks = 0
        var fails: [String] = []
        func check(_ name: String, _ ok: Bool, _ detail: String) {
            if ok { oks += 1; say("gate: \(name) ok (\(detail))") } else { fails.append(name); say("gate: \(name) FAIL (\(detail))") }
        }
        var maxWait: [StallRig.Kind: Double] = [:]
        var holes: [StallRig.Kind: Int] = [:]
        for rig in rigs {
            let w = rig.waitsSnapshot()
            maxWait[rig.kind] = w.max() ?? .nan
            holes[rig.kind] = rig.holes
            say(String(format: "  %-24@ play-block wait p50 %5.2f p99 %6.2f max %7.2f ms · %d over 10 ms · holes %d (%.1f ms) · render late max %.2f ms", rig.kind.rawValue as NSString, percentile(w, 50), percentile(w, 99), w.max() ?? .nan, w.filter { $0 > 10 }.count, rig.holes, Double(rig.holeFrames) / 48, rig.renderLateMaxMs))
        }
        // 10 ms, unless the machine itself held the no-HAL rig longer: then the HAL may add at most 2 ms to that.
        let base = maxWait[.none] ?? 0
        let bound = max(10, base + 2)
        getloadavg(&load, 3)
        check("HAL on its own queue: every play block waits ≤ \(String(format: "%.1f", bound)) ms", (maxWait[.reader] ?? .infinity) <= bound, String(format: "max %.2f ms; no-HAL rig %.2f ms; load %.1f", maxWait[.reader] ?? .nan, base, load[0]))
        check("HAL on its own queue: holes equal the no-HAL rig ± 1", abs((holes[.reader] ?? 0) - (holes[.none] ?? 0)) <= 1, "\(holes[.reader] ?? -1) vs \(holes[.none] ?? -1)")
        if legacy {
            check("legacy (HAL on the play queue) shows waits ≥ 20 ms", (maxWait[.legacy] ?? 0) >= 20, String(format: "max %.2f ms", maxWait[.legacy] ?? .nan))
        }
        say("gates: \(oks) ok, \(fails.count) FAIL")
        return fails.isEmpty
    }
}

// Measured arrival traces, embedded so the probe needs nothing outside the repo (voice PLAN W1.1).
enum Traces {
    /// `readback()` wall times on this Mac, ms (scratchpad/voice/playout/readback_ms.txt, 300 ticks):
    /// how long each 5 s tick held the speaker's queue.
    static let readbackMs = """
25,172,41,186,30,29,30,261,23,23,28,24,28,88,162,43,24,23,31,158,23,27,24,87,37,129,96,31,34,22,29,22,23,95,
30,90,31,149,26,25,27,26,106,124,66,31,37,19,116,38,28,41,29,19,22,62,28,32,147,26,22,26,106,34,55,53,33,96,
29,101,23,116,101,37,63,40,132,156,20,32,21,26,102,89,32,25,165,46,23,22,206,37,104,29,69,27,23,86,32,77,21,
22,20,23,21,94,30,126,31,54,39,286,25,26,25,168,21,21,22,29,173,23,26,24,291,37,30,21,73,30,23,136,27,22,21,
20,25,147,77,24,93,37,126,44,31,35,131,35,31,24,27,25,40,232,152,28,25,25,38,224,79,98,27,25,21,21,219,19,24,
102,24,262,25,19,20,24,21,201,26,21,131,57,28,31,124,32,27,22,20,19,221,22,76,38,141,59,35,25,160,28,29,31,23,
23,25,224,28,161,22,26,27,203,25,30,38,26,34,27,131,38,32,29,24,154,27,26,24,158,32,25,27,27,197,49,33,30,38,
222,23,27,185,20,23,20,157,43,41,284,38,28,26,24,31,56,36,43,211,29,187,46,173,29,23,24,20,160,29,35,26,266,
76,37,109,51,37,23,24,122,45,19,22,34,22,109,137,42,30,28,23,159,24,30,29,124,33,34,25,41,215,28
"""
    /// Per-40 ms-frame lateness through the daemon, the socket and the app's receiver, ms
    /// (scratchpad/voice/prove-14/out/replay-lateness-ms.txt, 1501 frames; negative = early).
    static let replayLatenessMs = """
0,-4,1,-2,-1,-4,-4,-1,2,5,-2,-2,-4,8,5,-3,-1,-3,-3,-2,-4,-2,-3,-4,-4,-4,3,13,-3,18,-3,29,1,2,7,-1,-2,-4,-4,-4,
-1,4,-4,-3,-4,-4,-4,-4,-1,-2,-2,-4,-4,-4,-3,-2,-4,-4,-4,-2,-3,-4,-4,-4,-2,-3,0,-3,-3,-4,-4,-3,-3,-2,-4,-1,-4,
-3,-4,-3,-4,-3,-3,5,-3,0,-3,-4,-4,6,-3,-4,-4,-4,-3,0,-3,-3,-3,-4,-4,84,44,4,18,8,-4,-4,10,-2,-3,-1,-3,-2,-3,
-3,1,6,-2,-3,-3,-4,-3,-4,-4,-3,2,-2,-3,-4,-3,-4,-4,-2,-4,-4,-4,-4,-4,-3,-4,-4,-4,-3,-4,-3,-3,-4,-4,-3,-3,-4,
-4,-4,-3,-4,-2,-3,-3,-4,-4,-4,-4,-2,-1,-4,-4,-4,-2,-3,-4,-4,-4,-4,-4,-2,-3,-3,-2,4,-4,4,-2,-4,10,-4,-4,-4,1,3,
-3,-3,-3,-4,-3,-3,-1,-4,-3,-4,-4,-3,-2,-3,-4,0,-3,-4,-3,-2,-3,-4,-3,-4,2,-4,-4,-4,-4,-4,-3,-4,-3,-4,-3,-3,-4,
-3,-4,-1,-4,-3,-3,-4,-3,-3,-2,-4,-2,-4,-3,-4,-4,-4,-4,-4,-3,-4,-1,-3,-4,3,-3,-4,4,6,-3,-3,-4,3,-4,-4,-2,-2,-4,
-4,-3,-3,-2,-3,-4,-4,-3,-4,-3,-4,-3,-3,-4,-3,-4,-2,-4,-1,-4,0,-2,-3,-3,-4,-3,-4,-4,-4,-3,-2,-4,-3,-4,-4,-4,-3,
-3,-4,-4,-4,-3,-4,-3,-4,-3,-4,-2,-3,-4,-3,-4,-3,-4,-4,-4,-3,-4,-3,0,-4,-3,-4,-2,-2,13,5,-3,-1,-3,-3,-2,-4,-3,
-3,-4,0,-3,-3,-4,-4,-3,0,-4,-4,-4,-3,-4,-2,-3,-2,-3,-4,-4,-3,-4,-4,-4,-4,-3,-3,-1,-4,-4,-4,-4,-4,-3,-2,-4,-3,
-3,-4,-3,-4,-2,-1,8,10,-4,-3,-1,-4,-3,-4,-3,-4,-3,-4,-3,-2,-4,-2,-4,-4,-4,9,12,-3,-3,-4,-4,-4,-4,-4,-4,-4,-2,
-1,-3,-2,-2,-4,-3,-3,-2,-4,-3,-1,-1,-4,-3,-4,-3,-4,-1,-4,-3,-4,-4,-3,-4,-2,-4,-4,-4,-3,-4,-3,-3,-2,-3,-4,-3,
-4,-2,-4,-3,-4,-4,-4,-3,-3,-4,-4,-4,-4,-3,-4,-2,-3,-4,-4,-2,-4,-3,-2,-3,-4,-4,-3,22,14,-3,-4,-4,-4,-4,-1,5,-3,
-3,-3,-4,-3,-3,-4,-3,-3,-2,-3,-4,-3,-2,-4,-4,-3,-4,-4,-3,-1,-4,-4,-4,-3,-4,0,-3,-4,-4,-4,-4,-4,-4,-4,-3,-3,-4,
-4,-4,-3,0,-3,-3,-4,-3,-4,-4,-4,-4,-4,-3,-2,-4,-4,2,-3,-3,1,-4,-4,-3,-3,-2,-4,-3,2,4,-4,-3,-3,-3,-3,2,-4,-3,
-4,-4,-3,-4,-4,-4,-3,-4,-4,-4,-2,-4,-4,0,-4,-3,-4,-3,-1,-4,-3,-3,-4,-3,-4,-4,-4,-4,-4,-4,-2,-4,-4,-3,-4,-4,-4,
-3,-4,-3,-1,-3,-3,-2,-4,-3,-4,-4,-4,-2,0,-4,-4,-4,-3,-4,-3,-4,-3,-4,-4,-3,-3,-4,-4,4,-4,-4,-4,-4,-3,-2,-3,-3,
-4,-4,5,0,-3,-4,-3,-4,-3,-4,-2,-3,-1,-3,-4,-3,-3,-4,-4,-2,-3,-4,-4,-4,-4,-4,-3,-3,-3,0,-4,-4,-3,-3,-4,-3,-3,
-3,-4,-4,-4,-4,-3,-3,-3,-3,-4,-4,-4,-4,-2,-1,0,-3,-3,-4,-4,-3,-4,-4,-4,-4,-3,7,-2,1,-3,210,170,130,90,50,10,
-3,-3,-1,-3,-3,-3,-3,-4,-4,-4,-4,0,-3,-4,-2,-4,-4,-4,-3,-3,-4,-1,-1,-1,-3,-1,-4,-3,-2,-4,-4,-4,-3,-2,-3,-4,-2,
1,-2,0,-4,-2,-2,-1,-4,-3,-2,-3,-1,-4,-3,-2,-4,-3,-3,-4,-2,-4,1,-3,-3,-4,1,-3,1,2,9,1,3,2,1,63,23,-3,-4,-2,-3,
1,-1,-4,-1,-2,-4,-4,-3,-1,0,-3,-4,-4,21,0,-1,-4,-4,-3,-3,-3,-4,-3,-4,-3,-2,-4,-1,1,1,-4,0,-3,-4,-4,-4,-4,-3,
-3,2,-2,-3,4,-3,-3,-2,-2,-3,-2,-2,-4,-4,-4,-4,-4,-4,-4,0,-4,-3,-2,3,1,-3,-2,0,-1,-4,6,2,84,49,9,3,6,1,5,-4,-3,
-2,-3,-4,2,-3,-4,2,-4,5,-4,-3,-3,-4,-4,-2,-4,0,-3,-4,-4,3,-4,-2,-3,-4,17,-3,-3,-4,-3,2,3,-4,-2,-4,-3,-3,1,-3,
-3,-4,-4,-4,-4,-4,-3,-4,-4,-4,-3,-4,-3,-4,-3,-4,-1,-2,-4,-3,-4,-3,-4,51,11,110,77,37,-3,52,12,6,-4,-3,-4,-3,2,
-4,-2,-4,-4,5,-3,11,2,-4,-3,-4,-4,-4,-4,-3,-4,-4,2,-3,-2,-4,-4,-4,-4,-2,-4,-3,-4,-3,-3,-3,-4,-3,-3,2,-4,-4,-4,
-4,-3,-3,-4,-3,-4,-4,4,-4,-4,-3,-3,-3,-4,-4,-3,2,-4,-4,-3,-3,-3,-4,31,147,107,67,27,34,19,0,-3,-4,-4,-2,-4,-4,
-4,-3,-2,-3,-4,-4,-3,-4,0,-3,-4,-4,-4,-4,-3,-4,-4,-4,-4,-4,-1,-4,-4,-4,-3,-4,-1,-3,-4,-3,-3,-4,-3,-4,0,-4,-4,
-3,-4,-3,-3,-3,-4,-3,-4,-4,-4,-3,-3,-3,-4,-4,-4,-4,-2,-4,-3,-3,-4,-3,-4,-3,3,8,-4,-3,-3,-4,-4,-2,-4,3,-4,-3,
-3,-3,-3,-4,-4,-3,-3,-4,-4,-3,-4,-3,-3,-4,-3,-3,-4,-4,-3,-3,-4,-4,-3,-4,-4,-4,-4,-3,-4,-4,-4,-4,-3,-4,-2,-4,
-4,-3,-4,-4,-4,-4,-3,-3,1,-3,-4,-3,-4,-1,-3,-4,-3,-3,-4,2,-3,-4,-2,-3,-4,-4,-3,2,8,17,-1,18,-4,3,-2,-3,-3,-4,
-4,-4,-4,-2,-4,-4,-4,-3,-3,-4,-1,-3,-3,-2,-4,-4,-4,-3,-4,-3,-3,-4,0,-3,-3,-3,-4,-4,-4,-4,-3,-4,-4,-3,-4,-3,-3,
-4,-3,-4,-4,-4,-4,-4,-1,-1,-4,-4,-4,-2,-3,-4,-4,-4,-4,-3,-2,-4,0,-3,-4,1,0,1,8,74,34,4,-4,2,20,-2,-4,-3,6,7,3,
-3,-4,-4,-4,-4,-4,-4,-4,4,-4,-4,-3,12,-4,-4,-4,-3,-4,-2,2,-3,1,-4,-4,-1,-3,-1,-2,-3,-3,-3,-4,-2,-4,-3,-3,-2,
-3,-2,-2,-3,-4,-1,-3,-3,-4,-2,2,-4,-4,-4,-4,0,-3,-3,-4,-3,-4,-4,-1,-4,-3,32,0,-4,-3,-1,-3,-1,-4,-4,-3,-3,-4,
-3,-3,-4,-2,-2,-3,-4,-3,-2,-3,-4,-3,-2,-4,-2,13,-3,-4,-3,-4,-4,-4,2,-3,-3,-2,-4,-3,-3,-4,-3,-3,-4,-4,-4,-3,-1,
0,-2,-4,-3,-3,-3,-2,-3,-4,2,1,-3,-4,-3,-4,-3,0,-4,-4,-4,-4,-1,-2,-4,-3,-4,-4,39,-1,19,-4,-1,0,-2,2,-1,0,-3,-4,
-4,-3,-3,-3,1,-3,-4,-4,-3,-4,2,-3,-1,-4,-3,-4,-3,3,-2,-3,-4,-3,-3,-3,-4,-3,-4,-3,-4,-2,-3,-4,-4,-4,-2,-2,-3,
-4,-4,-3,-4,-4,2,10,-4,0,-3,-3,-3,1,-4,-3,-4,-2,-4,-4,-4,-4,2,-4,-1,-3,-4,-3,0,-4,-4,1,2,-4,-3,-4,-3,-4,-4,-4,
-4,-3,-4,-2,-3,-4,-3,-4,-4,-3,-4,-2,-4,-3,-3,-4,-1,-3,-3,-2,-2,-3,-4,4,-3,-3,-3,-4,-3,-2,-3,-3,-4,1,-3
"""

    static func values(_ text: String) -> [Double] {
        text.split(whereSeparator: { $0 == "," || $0 == "\n" }).compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
    }
}
