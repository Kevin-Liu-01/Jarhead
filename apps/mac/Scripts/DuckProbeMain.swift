import AVFoundation
import Foundation

// Throwaway harness: the barge-in duck (Audio/BargeInDuck.swift) on synthetic tap buffers,
// and the microphone ranking (`MicRanking`) on this Mac's devices — read-only, nothing is
// played, recorded, or changed. Not part of the package; compiled only by
// Scripts/duck-probe.sh, which `pnpm jarhead bench` runs for its "barge-in" rows.
//
//   DUCK_PROBE_RUNS=3      runs; each run plays the five scenarios below, the speech onset
//                          0, 30 or 70 ms into a 100 ms buffer in turn
//   DUCK_PROBE_LIVE_MS=900 when Live's transcript of Kevin first grows, after his onset
//                          (modelled: no live session is opened here; at least 400, since
//                          an item sooner than BargeInDuck.liveTranscriptLag confirms nothing)
//   DUCK_PROBE_RESIDUAL_S  seconds of the residual round (default 60; 0 skips it; under
//                          --json it runs only when set, so the bench stays quick)
//   --json                 the last line is the report the bench reads
//
// The scenarios, each with audible output "playing" (noteOutput every 100 ms, as the speaker
// path does), Jarhead's transcript "Let me check that for you. Opening the settings now.", and
// the ear's partial of Kevin's last turn ("can you open the settings") seen before the reply:
//   live    Kevin speaks 1.5 s; the ear is off; Live's transcript of him opens at +LIVE_MS and
//           grows every 300 ms after; Live stops Jarhead's audio at +1.4 s (its measured stop on
//           barge-in); the phase leaves `speaking` at +2.6 s (1.2 s after Jarhead's last words)
//   cough   200 ms of energy, nothing follows: a dip to −6 dB, back at 700 ms
//   ear     Kevin speaks 1.0 s; the ear's cumulative partial gains "open safari" at +200 ms
//           ("safari": a word neither his last turn nor Jarhead had); Live stops Jarhead at +1.4 s
//   echo    200 ms of energy and the partial gains "check that for you" at +200 ms — Jarhead's
//           own words, the residual echo case: it must not confirm
//   phase   Kevin speaks 1.5 s; no ear, no Live transcript; Live stops Jarhead at +1.4 s; only
//           the phase leaves `speaking`, at +2.6 s
// An unconfirmed duck holds at −6 dB; live and ear must reach −20 dB within 8 ms of their
// confirmation (voice PLAN W1.4).
//
// Then the word rounds (voice PLAN W1.3): Jarhead audible, the room quiet but for one hot
// 10 ms slice, and 120 ms later words that are not a barge-in. Each must duck nothing:
//   stale      the ear's cumulative partial: Kevin's last turn plus Jarhead's own words
//   revise     the ear revises Kevin's own last turn
//   late-live  Live's transcript of Kevin grows after Jarhead has started
// Then the echo-stale rounds (W1.4's bound): Kevin silent, a 100 ms residual leak at 0.012
// trips the gate (−6 dB), and inside that duck come the ear's cumulative partial (his last turn
// plus Jarhead's echo) and a late Live item for his last turn (opening 150 ms after the onset,
// growing 300 ms later). Nothing of it is new, so each must hold at −6.0 dB and release
// unconfirmed:
//   baseline   the ear posted his last turn before the reply (what EarListener always does)
//   revised    as baseline, and the partial inside the duck revises his turn ("the" inserted)
//   cold       no partial before the duck: the ear's first words land inside it
// And the residual round (W1.4): Jarhead talks for 60 s over bursty residual echo at −50 dBFS
// with Kevin silent; at most 1% of his audible speech may sit under −6 dB.
//
// Buffers are 100 ms of 48 kHz mono, delivered every 100 ms and stamped "captured" 100 ms
// before delivery — the tap's own cadence (AVAudioEngine clamps tap buffers to ≥ 100 ms) — so
// a sample is what the app measures: the first hot 10 ms slice's capture time → the player's
// gain reaching the duck (−6 dB). What it cannot include: the mixer's own render cycle after
// the volume is set (one quantum, ~5–10 ms at 48 kHz).

@main
struct DuckProbeMain {
    static func main() {
        setlinebuf(stdout)
        let json = CommandLine.arguments.contains("--json")
        let env = ProcessInfo.processInfo.environment
        let runs = max(1, Int(env["DUCK_PROBE_RUNS"] ?? "") ?? 3)
        let liveMs = max(400, Int(env["DUCK_PROBE_LIVE_MS"] ?? "") ?? 900)
        let residualSeconds = max(0, Double(env["DUCK_PROBE_RESIDUAL_S"] ?? "") ?? (json ? 0 : 60))
        let probe = DuckProbe(runs: runs, liveMs: liveMs, residualSeconds: residualSeconds, json: json)
        probe.begin()
        RunLoop.main.run()
    }
}

final class DuckProbe: @unchecked Sendable {
    enum Scenario: String, CaseIterable {
        case live, cough, ear, echo, phase

        /// How long Kevin's (or the cough's) energy lasts.
        var speechSeconds: Double {
            switch self {
            case .live, .phase: return 1.5
            case .ear: return 1.0
            case .cough, .echo: return 0.2
            }
        }
        /// Live stops Jarhead's audio at +1.4 s when Kevin really speaks.
        var liveStops: Bool { self == .live || self == .ear || self == .phase }
    }

    private struct Round {
        let run: Int
        let scenario: Scenario
        let offset: Double
    }

    private let runs: Int
    private let liveMs: Int
    private let residualSeconds: Double
    private let json: Bool
    private let duck = BargeInDuck.shared
    private let lock = NSLock()
    private let t0 = Date()
    private let rate = 48_000.0
    private let framesPerBuffer = 4800
    private let offsets: [Double] = [0, 0.03, 0.07]
    private let feeder = DispatchQueue(label: "duck-probe.feeder", qos: .userInteractive)
    private let events = DispatchQueue(label: "duck-probe.events", qos: .userInteractive)
    static let jarheadSaid = "Let me check that for you. Opening the settings now."
    /// The ear's partial before the reply: Kevin's last turn, the segment the barge-in grows.
    static let kevinBefore = "can you open the settings"
    /// −6 dB: where a duck nobody confirmed holds (voice PLAN W1.4).
    static let unconfirmedGain: Float = 0.5
    static let phaseLeavesSpeakingMs = 2600
    static let liveStopMs = 1400
    static let earPartialMs = 200

    private var samples: [Double] = []
    private var unconfirmedRestores: [Double] = []
    private var confirmedReleases: [Double] = []
    private var speechEndToUnity: [Double] = []
    private var heldRestores: [Double] = []
    private var liveConfirms: [Double] = []
    private var earConfirms: [Double] = []
    private var refusedEchoPartials = 0
    private var rankedNames: [String] = []
    private var currentGain: Float = 1
    private var minGainSeen: Float = 1
    private var rounds: [Round] = []
    private var failures: [String] = []
    private var pureChecks = (ok: 0, failed: 0)
    /// Confirmation → the gain at −20 dB, per confirmed round (W1.4: ≤ 8 ms).
    private var confirmToDeep: [Double] = []
    /// Ducks the word rounds caused (W1.3: 0), and the residual round's share of speech under −6 dB.
    private var wordRoundDucks = 0
    private var residualUnderPct: Double?
    private var residualDucks = 0
    /// The echo-stale rounds' lowest gain, dB (W1.4: -6.0 each).
    private var echoStaleLowestDb: [Double] = []

    // The round in flight.
    private var current: Round?
    private var duckedAt: Date?
    private var confirmedAt: Date?
    private var deepAt: Date?
    private var confirmedBy: String?
    private var releasedWhy: String?
    private var speechEndWall: Date?
    private var pendingEvents = 0
    private var roundTimer: DispatchSourceTimer?

    init(runs: Int, liveMs: Int, residualSeconds: Double, json: Bool) {
        self.runs = runs
        self.liveMs = liveMs
        self.residualSeconds = residualSeconds
        self.json = json
    }

    private func say(_ s: String) {
        guard !json else { return }
        print(String(format: "+%6.3f  %@", Date().timeIntervalSince(t0), s))
    }

    func begin() {
        // V4 (design12): the echo guard's machine and the start ladder, table-driven, before the duck rounds.
        let (pureOk, pureFailed) = PureSections.run(say: { [weak self] in self?.say($0) }, fail: { [weak self] in self?.failures.append($0) })
        pureChecks = (pureOk, pureFailed)
        rankingSelfCheck()
        rankingOnThisMac()

        duck.onEvent = { [weak self] event in self?.handle(event) }
        duck.resetForHarness()
        duck.attach(echoCancelled: true) { [weak self] gain in
            guard let self else { return }
            self.lock.lock()
            self.currentGain = gain
            self.minGainSeen = min(self.minGainSeen, gain)
            if gain <= BargeInDuck.duckGain, self.current != nil, self.deepAt == nil { self.deepAt = Date() }
            self.lock.unlock()
        }
        for run in 0 ..< runs {
            for (i, scenario) in Scenario.allCases.enumerated() {
                rounds.append(Round(run: run, scenario: scenario, offset: offsets[(run + i) % offsets.count]))
            }
        }
        say("duck: \(rounds.count) rounds (\(runs) runs × \(Scenario.allCases.count) scenarios); Live's transcript modelled at +\(liveMs) ms, its stop at +\(DuckProbe.liveStopMs) ms, the phase at +\(DuckProbe.phaseLeavesSpeakingMs) ms; buffers 100 ms @ 48 kHz, stamped 100 ms before delivery")
        nextRound()
    }

    // MARK: the ranking

    /// The tiers on a synthetic device set: explicit › built-in › last used › default › rest › virtual.
    private func rankingSelfCheck() {
        let usb = MicInput(id: 1, uid: "usb", name: "USB Mic", transport: UInt32(kAudioDeviceTransportTypeUSB))
        let builtIn = MicInput(id: 2, uid: "bltn", name: "MacBook Pro Microphone", transport: UInt32(kAudioDeviceTransportTypeBuiltIn))
        let aggregate = MicInput(id: 3, uid: "agg", name: "Aggregate Device", transport: UInt32(kAudioDeviceTransportTypeAggregate))
        let airpods = MicInput(id: 4, uid: "bt", name: "AirPods", transport: UInt32(kAudioDeviceTransportTypeBluetooth))
        let all = [usb, builtIn, aggregate, airpods]
        func names(_ r: [MicInput]) -> [String] { r.map(\.name) }
        let auto = names(MicRanking.rank(all, explicit: nil, lastUsed: nil, systemDefault: "usb"))
        let explicitAggregate = names(MicRanking.rank(all, explicit: "agg", lastUsed: nil, systemDefault: "usb"))
        let lastUsed = names(MicRanking.rank(all, explicit: nil, lastUsed: "bt", systemDefault: "usb"))
        let gone = names(MicRanking.rank([usb, aggregate], explicit: "bt", lastUsed: "bltn", systemDefault: "usb"))
        let onlyVirtual = names(MicRanking.rank([aggregate], explicit: nil, lastUsed: nil, systemDefault: "agg"))
        let cases: [(String, [String], [String])] = [
            ("auto, usb default", auto, ["MacBook Pro Microphone", "USB Mic", "AirPods", "Aggregate Device"]),
            ("explicit aggregate", explicitAggregate, ["Aggregate Device", "MacBook Pro Microphone", "USB Mic", "AirPods"]),
            ("last used AirPods", lastUsed, ["MacBook Pro Microphone", "AirPods", "USB Mic", "Aggregate Device"]),
            ("pick and built-in gone", gone, ["USB Mic", "Aggregate Device"]),
            ("only a virtual device (used rather than nothing)", onlyVirtual, ["Aggregate Device"]),
        ]
        for (label, got, want) in cases {
            if got == want {
                say("ranking \(label): \(got.joined(separator: " › "))")
            } else {
                failures.append("ranking \(label): got \(got) want \(want)")
                say("ranking \(label): MISMATCH got \(got) want \(want)")
            }
        }
    }

    /// This Mac's input devices, ranked as Auto would (nothing picked, nothing used yet). Read-only.
    private func rankingOnThisMac() {
        let inputs = MicInputs.enumerate()
        let systemDefault = MicInputs.systemDefaultUID()
        let ranked = MicRanking.rank(inputs, explicit: nil, lastUsed: nil, systemDefault: systemDefault)
        rankedNames = ranked.map { d in
            var tags = [d.transportName]
            if d.uid == systemDefault { tags.append("default") }
            if d.isVirtual { tags.append("virtual, never auto-picked") }
            return "\(d.name) (\(tags.joined(separator: ", ")))"
        }
        say("this Mac, auto: \(rankedNames.isEmpty ? "no input devices" : rankedNames.joined(separator: " › "))")
        if let first = ranked.first, first.uid != systemDefault {
            say("  note: the ranking prefers \(first.name); with echo cancellation on the graph follows the system default (\(MicInputs.name(of: systemDefault) ?? "none")) and says so")
        }
    }

    // MARK: the duck

    private func handle(_ event: BargeInDuck.Event) {
        lock.lock()
        defer { lock.unlock() }
        guard let round = current else { return }
        switch event {
        case .ducked(let source, let latencyMs):
            samples.append(latencyMs)
            duckedAt = Date()
            say(String(format: "  ducked by %@ %.0f ms after speech onset (gain %.2f)", source, latencyMs, currentGain))
        case .confirmed(let how):
            confirmedBy = how
            confirmedAt = Date()
            let sinceDuck = duckedAt.map { Date().timeIntervalSince($0) * 1000 } ?? .nan
            if how == "live transcript" { liveConfirms.append(sinceDuck) }
            if how == "ear words" { earConfirms.append(sinceDuck) }
            say(String(format: "  confirmed: %@ (%.0f ms after the duck)", how, sinceDuck))
            if round.scenario == .echo || round.scenario == .phase || round.scenario == .cough {
                failures.append("\(round.scenario.rawValue) round confirmed by \(how); it must not be")
            }
        case .extended(let afterMs):
            say(String(format: "  still hot at %.0f ms: the deadline moves on", afterMs))
        case .refusedWords(let text):
            refusedEchoPartials += 1
            say("  partial \"\(text)\" refused as confirmation: no new word")
        case .refusedLive(let item):
            say("  Live item \(item) refused as confirmation: it opened before the duck or too soon after it")
            failures.append("\(round.scenario.rawValue) round: Live item \(item) refused; a barge-in's own item must confirm")
        case .released(let why, let afterMs):
            releasedWhy = why
            if why.hasPrefix("unconfirmed, held") {
                heldRestores.append(afterMs)
            } else if why.hasPrefix("unconfirmed") {
                unconfirmedRestores.append(afterMs)
            } else {
                confirmedReleases.append(afterMs)
                if let end = speechEndWall { speechEndToUnity.append(Date().timeIntervalSince(end) * 1000) }
            }
            say(String(format: "  released (%@) %.0f ms after the duck; gain back to %.2f", why, afterMs, currentGain))
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in self?.finishRoundIfDone() }
        }
    }

    private func noise(rms: Double, frames: Int, into dst: UnsafeMutablePointer<Float>, from start: Int = 0) {
        // Uniform noise in [-1, 1] has RMS 1/√3; scale to the wanted level.
        let scale = Float(rms * 3.0.squareRoot())
        for i in start ..< frames { dst[i] = Float.random(in: -1 ... 1) * scale }
    }

    private func nextRound() {
        guard !rounds.isEmpty else {
            // The word, echo-stale and residual rounds sleep between buffers: off the main run loop.
            Thread.detachNewThread { [weak self] in
                guard let self else { return }
                self.extraRounds()
                DispatchQueue.main.async { self.finish() }
            }
            return
        }
        let round = rounds.removeFirst()
        duck.resetForHarness()
        // Kevin's last turn, as the ear posted it while he spoke (nothing playing, nothing ducked).
        duck.noteEarWords(DuckProbe.kevinBefore)
        duck.noteJarheadSaid(DuckProbe.jarheadSaid)
        duck.noteVoiceSpeaking(true)
        lock.lock()
        minGainSeen = 1
        current = round
        duckedAt = nil
        confirmedAt = nil
        deepAt = nil
        confirmedBy = nil
        releasedWhy = nil
        speechEndWall = nil
        pendingEvents = 0
        lock.unlock()
        say(String(format: "round %d %@, onset %.0f ms into the buffer", round.run, round.scenario.rawValue, round.offset * 1000))
        let roomBuffers = 6
        let speechBuffers = Int((round.scenario.speechSeconds / 0.1).rounded())
        let maxBuffers = 48
        var index = 0
        var liveStopped = false
        let timer = DispatchSource.makeTimerSource(queue: feeder)
        timer.schedule(deadline: .now() + 0.1, repeating: 0.1, leeway: .milliseconds(1))
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            guard index < maxBuffers else {
                timer.cancel()
                self.lock.lock()
                let released = self.releasedWhy != nil
                self.lock.unlock()
                if !released { self.lock.lock(); self.failures.append("\(round.scenario.rawValue) round never released"); self.lock.unlock() }
                DispatchQueue.main.async { self.finishRound() }
                return
            }
            let i = index
            index += 1
            // The speaker keeps "talking" until Live's own stop; the daemon's silence frames are ~0.
            self.duck.noteOutput(rms: liveStopped ? 0.0 : 0.1, seconds: 0.1)
            guard let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: self.rate, channels: 1, interleaved: false),
                  let buf = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: AVAudioFrameCount(self.framesPerBuffer)),
                  let dst = buf.floatChannelData?[0] else { return }
            let frames = self.framesPerBuffer
            // "Captured" 100 ms ago: the tap hands a buffer over once it is full.
            let capturedStart = mach_absolute_time() &- AVAudioTime.hostTime(forSeconds: 0.1)
            if i < roomBuffers || i >= roomBuffers + speechBuffers {
                self.noise(rms: 0.002, frames: frames, into: dst)
            } else if i == roomBuffers {
                let onsetFrame = Int(round.offset * self.rate)
                self.noise(rms: 0.002, frames: onsetFrame, into: dst)
                self.noise(rms: 0.05, frames: frames, into: dst, from: onsetFrame)
                let onsetWall = Date().addingTimeInterval(-0.1 + round.offset)
                self.scheduleEvents(for: round, onsetWall: onsetWall) { liveStopped = true }
            } else {
                self.noise(rms: 0.05, frames: frames, into: dst)
            }
            if i == roomBuffers + speechBuffers - 1 {
                self.lock.lock()
                self.speechEndWall = Date() // the last hot slice was captured just before this delivery
                self.lock.unlock()
            }
            buf.frameLength = AVAudioFrameCount(frames)
            self.duck.noteMic(mono: dst, frames: frames, sampleRate: self.rate, capturedAt: AVAudioTime(hostTime: capturedStart))
        }
        timer.resume()
        roundTimer = timer
    }

    /// Live's transcript, its stop, the phase and the ear's partial, on the feeder's clock,
    /// relative to Kevin's onset; `onLiveStop` runs on the feeder queue.
    private func scheduleEvents(for round: Round, onsetWall: Date, onLiveStop: @escaping () -> Void) {
        func at(_ ms: Int, _ body: @escaping () -> Void) {
            lock.lock(); pendingEvents += 1; lock.unlock()
            let delay = max(0, onsetWall.addingTimeInterval(Double(ms) / 1000).timeIntervalSinceNow)
            events.asyncAfter(deadline: .now() + delay) { [weak self] in
                body()
                guard let self else { return }
                self.lock.lock(); self.pendingEvents -= 1; self.lock.unlock()
                DispatchQueue.main.async { self.finishRoundIfDone() }
            }
        }
        switch round.scenario {
        case .live:
            var t = liveMs
            // One item for his barge-in: it opens at +LIVE_MS and grows every 300 ms after.
            let item = "t_barge\(round.run)"
            while Double(t) / 1000 < round.scenario.speechSeconds + 0.3 {
                at(t) { [duck] in duck.noteLiveHeardKevin(item: item) }
                t += 300
            }
        case .ear:
            at(DuckProbe.earPartialMs) { [duck] in duck.noteEarWords("\(DuckProbe.kevinBefore) open safari") }
        case .echo:
            at(DuckProbe.earPartialMs) { [duck] in duck.noteEarWords("\(DuckProbe.kevinBefore) check that for you") }
        case .cough, .phase:
            break
        }
        if round.scenario.liveStops {
            at(DuckProbe.liveStopMs) { [duck, feeder] in
                feeder.async { onLiveStop() }
                duck.noteFlush()
            }
            at(DuckProbe.phaseLeavesSpeakingMs) { [duck] in duck.noteVoiceSpeaking(false) }
        }
    }

    /// The round is over once it has released and every modelled event has fired.
    private func finishRoundIfDone() {
        lock.lock()
        let done = current != nil && releasedWhy != nil && pendingEvents == 0
        lock.unlock()
        if done { finishRound() }
    }

    private func finishRound() {
        roundTimer?.cancel()
        roundTimer = nil
        lock.lock()
        guard let round = current else { lock.unlock(); return }
        current = nil
        let ducked = duckedAt != nil
        let confirmed = confirmedBy
        let why = releasedWhy ?? "never released"
        let lowest = minGainSeen
        let confirmWall = confirmedAt
        let deepWall = deepAt
        lock.unlock()
        let name = round.scenario.rawValue
        if !ducked { failures.append("\(name) round never ducked") }
        switch round.scenario {
        case .live where confirmed != "live transcript":
            failures.append("live round confirmed by \(confirmed ?? "nothing"), not Live's transcript (released: \(why))")
        case .ear where confirmed != "ear words":
            failures.append("ear round confirmed by \(confirmed ?? "nothing"), not the ear's words (released: \(why))")
        case .cough where !why.hasPrefix("unconfirmed at"):
            failures.append("cough round released as \"\(why)\", not at 700 ms")
        case .echo where !why.hasPrefix("unconfirmed at"):
            failures.append("echo round released as \"\(why)\", not at 700 ms")
        case .phase where !why.hasPrefix("unconfirmed, held"):
            failures.append("phase round released as \"\(why)\", not held while the mic stayed hot")
        default:
            break
        }
        // W1.4: a duck nobody confirmed holds at −6 dB; a confirmation takes it to −20 dB at once.
        switch round.scenario {
        case .cough, .echo, .phase:
            if lowest != DuckProbe.unconfirmedGain {
                failures.append(String(format: "%@ round dipped to %.1f dB; an unconfirmed duck holds at -6.0 dB", name, 20 * log10(Double(max(lowest, 1e-6)))))
            }
        case .live, .ear:
            if let confirmWall, let deepWall {
                let ms = deepWall.timeIntervalSince(confirmWall) * 1000
                confirmToDeep.append(ms)
                if ms < -1 || ms > 8 {
                    failures.append(String(format: "%@ round reached -20 dB %.0f ms from its confirmation; it must land within 8 ms after it", name, ms))
                }
            } else {
                failures.append("\(name) round: confirmed \(confirmWall != nil), reached -20 dB \(deepWall != nil)")
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in self?.nextRound() }
    }

    // MARK: the word rounds, the echo-stale rounds and the residual round (voice PLAN W1.3, W1.4)

    static let wordJarhead = "Sure, opening System Settings for you now."
    static let kevinTurn = "can you open system settings"

    enum WordRound: String, CaseIterable {
        case stale, revise
        case lateLive = "late-live"
    }

    /// One 100 ms buffer of `sliceRMS` (ten 10 ms slices), stamped as the tap would.
    private func feedSlices(_ sliceRMS: [Double], rng: inout ProbeRNG) {
        var samples = [Float](repeating: 0, count: framesPerBuffer)
        let per = framesPerBuffer / sliceRMS.count
        for (s, level) in sliceRMS.enumerated() {
            for i in 0 ..< per { samples[s * per + i] = Float(rng.gauss() * level) }
        }
        let captured = mach_absolute_time() &- AVAudioTime.hostTime(forSeconds: 0.1)
        samples.withUnsafeBufferPointer { p in
            duck.noteMic(mono: p.baseAddress!, frames: samples.count, sampleRate: rate, capturedAt: AVAudioTime(hostTime: captured))
        }
    }

    /// The word rounds, the echo-stale rounds, then the residual round; on a background thread, sleeping between buffers.
    private func extraRounds() {
        var rng = ProbeRNG(state: 7)
        for round in WordRound.allCases {
            let ducks = wordRound(round, rng: &rng)
            let skipped = duck.currentStats.wordOnsetsSkipped
            lock.lock(); wordRoundDucks += ducks; lock.unlock()
            if ducks == 0, skipped == 1 {
                say("word round \(round.rawValue): no duck (1 word onset skipped)")
            } else {
                say("word round \(round.rawValue): FAIL \(ducks) duck(s), \(skipped) word onset(s) skipped")
                lock.lock(); failures.append("word round \(round.rawValue) ducked \(ducks) time(s) and counted \(skipped) skipped word onset(s); the words must only confirm a duck, and count the onset once"); lock.unlock()
            }
        }
        for round in EchoStaleRound.allCases {
            let c = echoStaleRound(round, rng: &rng)
            let db = 20 * log10(Double(max(c.lowest, 1e-6)))
            lock.lock(); echoStaleLowestDb.append((db * 10).rounded() / 10); lock.unlock()
            let line = String(format: "echo-stale round %@: %d duck(s), %d confirmed, %d partial(s) and %d Live call(s) refused, lowest %.1f dB, released %@", round.rawValue, c.ducks, c.confirmed, c.refusedWords, c.refusedLive, db, c.released ?? "never")
            if c.ducks == 1, c.confirmed == 0, c.lowest == DuckProbe.unconfirmedGain, c.refusedWords == 1, c.refusedLive == 2, c.released?.hasPrefix("unconfirmed at") == true {
                say(line)
            } else {
                say("\(line): FAIL")
                lock.lock(); failures.append("echo-stale round \(round.rawValue): \(line); stale words must leave an echo duck at -6.0 dB"); lock.unlock()
            }
        }
        guard residualSeconds > 0 else { return }
        let (pct, ducks) = residualRound(seconds: residualSeconds, medianDBFS: -50, rng: &rng)
        lock.lock()
        residualUnderPct = pct
        residualDucks = ducks
        if pct > 1 { failures.append(String(format: "residual round: %.1f%% of Jarhead's audible speech under -6 dB (%d ducks); at most 1%%", pct, ducks)) }
        lock.unlock()
        say(String(format: "residual round: %.0f s at -50 dBFS bursty, Kevin silent: %d duck(s), %.1f%% of audible speech under -6 dB", residualSeconds, ducks, pct))
    }

    /// Jarhead audible, the room quiet but one hot slice, then words that are not a barge-in. Returns the ducks.
    private func wordRound(_ round: WordRound, rng: inout ProbeRNG) -> Int {
        let counter = EventCounter()
        duck.onEvent = { counter.note($0) }
        duck.resetForHarness()
        duck.noteJarheadSaid(DuckProbe.wordJarhead)
        duck.noteVoiceSpeaking(true)
        // Jarhead audible: 4 s queued at speech level.
        for _ in 0 ..< 40 { duck.noteOutput(rms: 0.08, seconds: 0.1) }
        for _ in 0 ..< 5 {
            feedSlices(Array(repeating: 0.001, count: 10), rng: &rng)
            Thread.sleep(forTimeInterval: 0.1)
        }
        // One buffer whose last 10 ms slice is a residual blip at 0.015 (−36.5 dBFS): one hot slice, not an onset.
        var blip = Array(repeating: 0.001, count: 10)
        blip[9] = 0.015
        feedSlices(blip, rng: &rng)
        Thread.sleep(forTimeInterval: 0.12)
        switch round {
        case .stale: duck.noteEarWords("\(DuckProbe.kevinTurn) opening system settings for")
        case .revise: duck.noteEarWords("can you open the system settings")
        case .lateLive: duck.noteLiveHeardKevin(item: "t_late")
        }
        for _ in 0 ..< 25 {
            feedSlices(Array(repeating: 0.001, count: 10), rng: &rng)
            Thread.sleep(forTimeInterval: 0.1)
        }
        Thread.sleep(forTimeInterval: 0.2)
        return counter.ducks
    }

    enum EchoStaleRound: String, CaseIterable {
        case baseline, revised, cold
    }

    /// Kevin silent; a residual leak trips the gate, and stale words arrive inside the duck.
    /// Returns what the duck did: its ducks, confirmations, refusals, lowest gain, release.
    private func echoStaleRound(_ round: EchoStaleRound, rng: inout ProbeRNG) -> EventCounter {
        let counter = EventCounter()
        duck.onEvent = { counter.note($0) }
        duck.resetForHarness()
        Thread.sleep(forTimeInterval: 0.05)
        lock.lock(); minGainSeen = 1; lock.unlock()
        // His last turn, posted by the ear while he spoke (`cold`: the ear had posted nothing).
        if round != .cold { duck.noteEarWords(DuckProbe.kevinTurn) }
        duck.noteJarheadSaid(DuckProbe.wordJarhead)
        duck.noteVoiceSpeaking(true)
        for _ in 0 ..< 40 { duck.noteOutput(rms: 0.08, seconds: 0.1) }
        for _ in 0 ..< 5 {
            feedSlices(Array(repeating: 0.001, count: 10), rng: &rng)
            Thread.sleep(forTimeInterval: 0.1)
        }
        // The leak: 100 ms at 0.012 (−38 dBFS), over the 0.008 floor. The gate ducks to −6 dB.
        feedSlices(Array(repeating: 0.012, count: 10), rng: &rng)
        Thread.sleep(forTimeInterval: 0.05)
        // 150 ms after the leak's onset: a late Live item for his last turn opens.
        duck.noteLiveHeardKevin(item: "t_late")
        Thread.sleep(forTimeInterval: 0.05)
        // The ear's cumulative partial: his last turn (`revised`: a word inserted into it), then Jarhead's echo.
        let turn = round == .revised ? "can you open the system settings" : DuckProbe.kevinTurn
        duck.noteEarWords("\(turn) sure opening system settings")
        for i in 0 ..< 12 {
            feedSlices(Array(repeating: 0.001, count: 10), rng: &rng)
            Thread.sleep(forTimeInterval: 0.1)
            // The late item grows.
            if i == 2 { duck.noteLiveHeardKevin(item: "t_late") }
        }
        Thread.sleep(forTimeInterval: 0.2)
        lock.lock(); counter.lowest = minGainSeen; lock.unlock()
        return counter
    }

    /// Port of the DUCK investigation's E2 sweep (bursty): Jarhead's utterances of syllables, the
    /// residual echo two slices late, following the player's gain, NLP-clamped 15 dB under the median
    /// with leaks of 60–200 ms at the median + 3 dB. Kevin silent. Returns (% of audible speech
    /// slices at a gain under −6 dB, ducks).
    private func residualRound(seconds: Double, medianDBFS: Double, rng: inout ProbeRNG) -> (Double, Int) {
        let counter = EventCounter()
        duck.onEvent = { counter.note($0) }
        duck.resetForHarness()
        duck.noteJarheadSaid("Sure, opening System Settings for you now and then I will check the display panel")
        duck.noteVoiceSpeaking(true)
        let total = Int(seconds * 100)
        var env = [Double](repeating: 0, count: total + 400)
        var talking = [Bool](repeating: false, count: total + 400)
        var i = 30
        while i < total {
            let uttLen = Int(200 + rng.uniform() * 200)
            var j = i
            while j < min(i + uttLen, total) {
                let syl = Int(12 + rng.uniform() * 10)
                let level = 0.08 * pow(10, rng.gauss() * 5 / 20)
                for k in 0 ..< syl where j + k < env.count {
                    env[j + k] = level * sin(.pi * Double(k) / Double(syl))
                    talking[j + k] = true
                }
                j += syl
                let gap = Int(3 + rng.uniform() * 6)
                for k in 0 ..< gap where j + k < talking.count { talking[j + k] = true }
                j += gap
            }
            i = j + Int(40 + rng.uniform() * 50)
        }
        let scale = pow(10, medianDBFS / 20) / 0.08
        let room = 0.0008
        var leakLeft = 0
        var leakLevel = 0.0
        var audible = 0
        var under = 0
        var mic = 0
        let start = CFAbsoluteTimeGetCurrent()
        while mic < total {
            var acc = 0.0
            for k in 0 ..< 10 { acc += env[mic + k] * env[mic + k] }
            duck.noteOutput(rms: (acc / 10).squareRoot(), seconds: 0.1)
            var slices = [Double](repeating: 0, count: 10)
            lock.lock()
            let g = Double(currentGain)
            lock.unlock()
            for k in 0 ..< 10 {
                let t = mic + k
                var residual = env[max(0, t - 2)] * g * scale * pow(10, rng.gauss() * 6 / 20) * pow(10, -15.0 / 20)
                if leakLeft == 0, talking[t], rng.uniform() < 0.005 {
                    leakLeft = Int(6 + rng.uniform() * 14)
                    leakLevel = pow(10, (medianDBFS + 3 + rng.gauss() * 3) / 20)
                }
                if leakLeft > 0 {
                    leakLeft -= 1
                    residual = max(residual, leakLevel * g * pow(10, rng.gauss() * 2 / 20))
                }
                slices[k] = (residual * residual + room * room).squareRoot()
                if talking[t], env[t] >= 0.02 {
                    audible += 1
                    if g < 0.5 { under += 1 }
                }
            }
            mic += 10
            feedSlices(slices, rng: &rng)
            let wait = start + Double(mic) / 100 - CFAbsoluteTimeGetCurrent()
            if wait > 0 { Thread.sleep(forTimeInterval: wait) }
        }
        Thread.sleep(forTimeInterval: 1.2)
        return (100 * Double(under) / Double(max(1, audible)), counter.ducks)
    }

    private func percentile(_ values: [Double], _ p: Double) -> Double {
        guard !values.isEmpty else { return .nan }
        let sorted = values.sorted()
        let idx = min(sorted.count - 1, max(0, Int((p / 100 * Double(sorted.count)).rounded(.up)) - 1))
        return sorted[idx]
    }

    private func finish() {
        duck.detach()
        lock.lock()
        let s = samples, u = unconfirmedRestores, c = confirmedReleases, e = speechEndToUnity, h = heldRestores, l = liveConfirms, w = earConfirms
        let refused = refusedEchoPartials, min = minGainSeen, names = rankedNames, fails = failures
        let deep = confirmToDeep, wordDucks = wordRoundDucks, residualPct = residualUnderPct, residualN = residualDucks
        let echoStale = echoStaleLowestDb
        lock.unlock()
        let onsets = runs * Scenario.allCases.count
        say(String(format: "done: %d ducks of %d onsets; onset → duck (−6 dB) median %.0f ms, p95 %.0f ms, max %.0f ms; lowest gain %.2f", s.count, onsets, percentile(s, 50), percentile(s, 95), s.max() ?? .nan, min))
        if !deep.isEmpty { say(String(format: "  confirmation → −20 dB: median %.1f ms, max %.1f ms", percentile(deep, 50), deep.max() ?? .nan)) }
        if !u.isEmpty { say(String(format: "  cough / echo words, unconfirmed → unity: median %.0f ms after the duck (700 ms + the 300 ms ramp); %d echo partials refused", percentile(u, 50), refused)) }
        if !l.isEmpty { say(String(format: "  Live's transcript confirmed %.0f ms after the duck (modelled at +%d ms from onset)", percentile(l, 50), liveMs)) }
        if !w.isEmpty { say(String(format: "  the ear's words confirmed %.0f ms after the duck", percentile(w, 50))) }
        if !c.isEmpty { say(String(format: "  confirmed → unity: median %.0f ms after the duck; %.0f ms after Kevin's last word", percentile(c, 50), percentile(e, 50))) }
        if !h.isEmpty { say(String(format: "  no confirmation, mic still hot → unity: median %.0f ms after the duck (held to 1.5 s, then the ramp)", percentile(h, 50))) }
        for f in fails { say("FAIL \(f)") }
        func r(_ v: [Double]) -> [Double] { v.map { ($0 * 10).rounded() / 10 } }
        var report: [String: Any] = [
            "samples": r(s),
            "unconfirmedRestoreMs": r(u),
            "confirmedReleaseMs": r(c),
            "speechEndToUnityMs": r(e),
            "heldRestoreMs": r(h),
            "liveConfirmMs": r(l),
            "earConfirmMs": r(w),
            "refusedEchoPartials": refused,
            "liveModelledMs": liveMs,
            "ranked": names,
            "lowestGain": Double(min),
            "pureChecksOk": pureChecks.ok,
            "pureChecksFailed": pureChecks.failed,
            "confirmToDeepMs": r(deep),
            "wordRoundDucks": wordDucks,
            "echoStaleLowestDb": echoStale,
        ]
        if let residualPct {
            report["residualUnderMinus6dBPct"] = (residualPct * 100).rounded() / 100
            report["residualDucks"] = residualN
        }
        if !fails.isEmpty { report["failures"] = fails }
        if let data = try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]), let line = String(data: data, encoding: .utf8) {
            print(line)
        }
        let missing = s.count < onsets
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { exit(fails.isEmpty && !missing ? 0 : 2) }
    }
}

/// Counts the duck's events for the word and residual rounds (called on the duck's queue).
final class EventCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    private var confirms = 0
    private var words = 0
    private var live = 0
    private var why: String?
    /// The lowest gain the round saw; the round sets it.
    var lowest: Float = 1
    func note(_ event: BargeInDuck.Event) {
        lock.lock(); defer { lock.unlock() }
        switch event {
        case .ducked: count += 1
        case .confirmed: confirms += 1
        case .refusedWords: words += 1
        case .refusedLive: live += 1
        case .released(let w, _): why = w
        case .extended: break
        }
    }
    var ducks: Int { lock.lock(); defer { lock.unlock() }; return count }
    var confirmed: Int { lock.lock(); defer { lock.unlock() }; return confirms }
    var refusedWords: Int { lock.lock(); defer { lock.unlock() }; return words }
    var refusedLive: Int { lock.lock(); defer { lock.unlock() }; return live }
    var released: String? { lock.lock(); defer { lock.unlock() }; return why }
}

/// A small deterministic generator, so a round's levels repeat run to run.
struct ProbeRNG {
    var state: UInt64
    mutating func next() -> UInt64 { state = state &* 6364136223846793005 &+ 1442695040888963407; return state }
    mutating func uniform() -> Double { Double(next() >> 11) / Double(1 << 53) }
    mutating func gauss() -> Double {
        let u1 = max(1e-12, uniform()), u2 = uniform()
        return (-2 * log(u1)).squareRoot() * cos(2 * .pi * u2)
    }
}

// MARK: - V4 · the pure parts (design12 § Verification)

/// Table-driven `check:` lines over `EchoGuardModel`, `EchoGuard`, `VoiceProcessingPolicy` and `PlayoutModel`
/// — nothing played, no microphone, no TCC. Each case returns nil when it holds, else the
/// mismatch in words; `run` prints `check: <section> · <name> ok | FAIL <why>` and hands the
/// failures to the duck's tally so `--json` and the exit code carry them.
struct PureSections {
    typealias Case = (name: String, body: () -> String?)

    static let slice = EchoGuardModel.sliceSeconds
    static let tail = EchoGuardModel.baseTail

    /// Hand every failure to the caller; returns (ok, failed).
    static func run(say: (String) -> Void, fail: (String) -> Void) -> (Int, Int) {
        var ok = 0, failed = 0
        for (section, cases) in [("guard", guardCases()), ("policy", policyCases()), ("playout", playoutCases())] {
            for c in cases {
                if let why = c.body() {
                    failed += 1
                    fail("\(section) · \(c.name): \(why)")
                    say("check: \(section) · \(c.name) FAIL \(why)")
                } else {
                    ok += 1
                    say("check: \(section) · \(c.name) ok")
                }
            }
        }
        say("check: pure sections \(ok) ok, \(failed) FAIL")
        return (ok, failed)
    }

    /// `slices` steps of 10 ms at `rms`, starting at `from`; returns the verdicts and the time after the last.
    static func feed(_ m: inout EchoGuardModel, rms: Double, from: Double, slices: Int) -> ([EchoGuardModel.Verdict], Double) {
        var out: [EchoGuardModel.Verdict] = []
        var t = from
        for _ in 0 ..< slices {
            out.append(m.step(rms: rms, now: t))
            t += slice
        }
        return (out, t)
    }

    /// A model with one second of audible output queued at t = 0 (audible until 1.0 + tail).
    static func speaking(seconds: Double = 1.0) -> EchoGuardModel {
        var m = EchoGuardModel(tail: tail)
        m.noteOutput(rms: 0.1, seconds: seconds, now: 0)
        return m
    }

    /// A model that has been held on echo at `echoRMS` for `seconds` (the floor taught), the window 10 s long.
    static func taught(echoRMS: Double, seconds: Double) -> (EchoGuardModel, Double) {
        var m = speaking(seconds: 10)
        let (_, t) = feed(&m, rms: echoRMS, from: 0, slices: Int((seconds / slice).rounded()))
        return (m, t)
    }

    static func guardCases() -> [Case] {
        [
            ("silence before any output passes", {
                // The engine's clock is CFAbsoluteTime (~8e8 s): a fresh model's `audibleUntil 0`
                // is long past. At t = 0 exactly the tail would still cover it, so the line starts later.
                var m = EchoGuardModel(tail: tail)
                return m.step(rms: 0.001, now: 100) == .pass && m.state == .open ? nil : "held with nothing queued"
            }),
            ("hold begins on the first slice after noteOutput", {
                var m = speaking()
                let v = m.step(rms: 0.001, now: 0)
                return v == .hold && m.isHeld && m.stats.holds == 1 ? nil : "verdict \(v), holds \(m.stats.holds)"
            }),
            ("silence between sentences arms nothing", {
                var m = speaking()
                m.noteOutput(rms: 0.0, seconds: 5, now: 0)
                return m.audibleUntil == 1.0 && m.queueEnd == 6.0 ? nil : "audibleUntil \(m.audibleUntil), queueEnd \(m.queueEnd)"
            }),
            ("release at audibleUntil + tail, not before", {
                var m = speaking()
                _ = m.step(rms: 0.001, now: 0)
                let before = m.step(rms: 0.001, now: 1.0 + tail - slice)
                let at = m.step(rms: 0.001, now: 1.0 + tail)
                return before == .hold && at == .pass && m.state == .open ? nil : "at tail−10ms \(before), at tail \(at), state \(m.state)"
            }),
            ("no break-through in the first 2 s however loud", {
                var m = speaking(seconds: 10)
                let (verdicts, _) = feed(&m, rms: 0.9, from: 0, slices: 199)
                return verdicts.allSatisfy { $0 == .hold } && m.stats.breakthroughs == 0 ? nil : "passed \(verdicts.filter { $0 == .pass }.count) slices, breaks \(m.stats.breakthroughs)"
            }),
            ("break-through after 12 slices over max(4 × floor, 0.02)", {
                var (m, t) = taught(echoRMS: 0.01, seconds: 2.0)
                let threshold = max(m.echoFloor * EchoGuardModel.breakFactor, EchoGuardModel.breakMinimumRMS)
                let (verdicts, _) = feed(&m, rms: threshold * 1.5, from: t, slices: 12)
                let firstEleven = verdicts.prefix(11).allSatisfy { $0 == .hold }
                let twelfth = verdicts.last == .pass
                var broken = false
                if case .broken = m.state { broken = true }
                return firstEleven && twelfth && broken && m.stats.breakthroughs == 1 ? nil : "verdicts \(verdicts.map { $0 == .hold ? "h" : "p" }.joined()), state \(m.state)"
            }),
            ("a Kevin-loud slice after 0.5 s does not move the floor", {
                var (m, t) = taught(echoRMS: 0.01, seconds: 0.6)
                let before = m.echoFloor
                _ = m.step(rms: 0.5, now: t)
                return m.echoFloor == before ? nil : "floor \(before) → \(m.echoFloor)"
            }),
            ("the first half second teaches from every slice", {
                var m = speaking(seconds: 10)
                _ = feed(&m, rms: 0.3, from: 0, slices: 10)
                return m.echoFloor > 0.1 ? nil : "floor \(m.echoFloor) after 100 ms at 0.3"
            }),
            ("a late echo (0.5 s of silence, then steady 0.1 for 3 s) never breaks through with learnDelay 0.5", {
                // A high-latency output (Bluetooth): the first judged slices are pre-echo silence.
                // Without the delay the floor learns that silence, the outlier cap rejects the
                // echo, and at 2 s the echo itself is the break-through — Jarhead on the wire.
                var m = EchoGuardModel(tail: tail, learnDelay: 0.5)
                m.noteOutput(rms: 0.1, seconds: 10, now: 0)
                let (quiet, t) = feed(&m, rms: 0.001, from: 0, slices: 50)
                let (echo, _) = feed(&m, rms: 0.1, from: t, slices: 300)
                let allHeld = quiet.allSatisfy { $0 == .hold } && echo.allSatisfy { $0 == .hold }
                let floorIsEcho = m.echoFloor > 0.05
                return allHeld && m.stats.breakthroughs == 0 && floorIsEcho && m.learned >= 2.9 ? nil : "passed \(echo.filter { $0 == .pass }.count) echo slices, breaks \(m.stats.breakthroughs), floor \(m.echoFloor), learned \(m.learned)"
            }),
            ("slices before learnDelay neither teach nor count; the clamp and the engine's arithmetic", {
                var m = EchoGuardModel(tail: tail, learnDelay: 0.2)
                m.noteOutput(rms: 0.1, seconds: 10, now: 0)
                _ = feed(&m, rms: 0.3, from: 0, slices: 20)
                let untaught = m.echoFloor == 0 && m.learned == 0 && abs(m.heldSeconds - 0.19) < 0.001
                let clamped = EchoGuardModel(tail: tail, learnDelay: 5).learnDelay == EchoGuardModel.maxLearnDelay
                let engine = abs(AudioEngine.guardLearnDelay(latency: 0.25) - 0.35) < 1e-9 && AudioEngine.guardLearnDelay(latency: 3) == EchoGuardModel.maxLearnDelay && AudioEngine.guardLearnDelay(latency: .nan) == EchoGuardModel.tapDelay
                return untaught && clamped && engine ? nil : "floor \(m.echoFloor), learned \(m.learned), held \(m.heldSeconds), clamped \(clamped), engine \(engine)"
            }),
            (".broken passes until the window ends", {
                var (m, t) = taught(echoRMS: 0.01, seconds: 2.0)
                _ = feed(&m, rms: 0.2, from: t, slices: 12)
                let (during, t2) = feed(&m, rms: 0.001, from: t + 0.12, slices: 5)
                var stillBroken = false
                if case .broken = m.state { stillBroken = true }
                let after = m.step(rms: 0.001, now: max(t2, m.audibleUntil + tail))
                return during.allSatisfy { $0 == .pass } && stillBroken && after == .pass && m.state == .open ? nil : "during \(during), state \(m.state)"
            }),
            ("noteFlush shortens the window", {
                var m = speaking(seconds: 10)
                m.noteFlush(now: 1)
                return m.audibleUntil == 1 && m.queueEnd == 1 && m.outputAudible(1 + tail - slice) && !m.outputAudible(1 + tail) ? nil : "audibleUntil \(m.audibleUntil), queueEnd \(m.queueEnd)"
            }),
            ("NaN counts as silence", {
                var m = speaking(seconds: 10)
                let v = m.step(rms: .nan, now: 0)
                _ = feed(&m, rms: .nan, from: slice, slices: 60)
                var open = EchoGuardModel(tail: tail)
                let quiet = open.step(rms: .nan, now: 100)
                return v == .hold && m.echoFloor.isFinite && m.echoFloor == 0 && quiet == .pass ? nil : "verdict \(v), floor \(m.echoFloor), open \(quiet)"
            }),
            ("counters: holds, heldSeconds, breakthroughs", {
                // 200 slices taught = 1 open→held slice (not counted as held) + 199 held; + 12 to the break.
                var (m, t) = taught(echoRMS: 0.01, seconds: 2.0)
                _ = feed(&m, rms: 0.2, from: t, slices: 12)
                _ = m.step(rms: 0.001, now: 10 + tail)
                m.noteOutput(rms: 0.1, seconds: 1, now: 11)
                _ = m.step(rms: 0.001, now: 11)
                let held = abs(m.heldSeconds - 2.11) < 0.001
                return m.stats.holds == 2 && m.stats.breakthroughs == 1 && held ? nil : "holds \(m.stats.holds), breaks \(m.stats.breakthroughs), held \(m.heldSeconds)"
            }),
            ("EchoGuard: detached passes, attached holds and counts, frozen passes", {
                let g = EchoGuard.shared
                g.detach()
                var samples = [Float](repeating: 0.001, count: 480)
                let pass = samples.withUnsafeBufferPointer { g.judge(mono: $0.baseAddress!, frames: 480, sampleRate: 48_000) }
                g.attach(tail: tail)
                g.noteOutput(rms: 0.1, seconds: 1)
                let hold = samples.withUnsafeBufferPointer { g.judge(mono: $0.baseAddress!, frames: 480, sampleRate: 48_000) }
                let s1 = g.stats
                g.frozen = true
                let frozen = samples.withUnsafeBufferPointer { g.judge(mono: $0.baseAddress!, frames: 480, sampleRate: 48_000) }
                let s2 = g.stats
                g.frozen = false
                g.detach()
                samples.removeAll()
                let ok = pass == .pass && hold == .hold && s1.gated == 1 && s1.chunks == 1 && frozen == .pass && s2.chunks == 2 && s2.gated == 1 && !g.isAttached
                return ok ? nil : "detached \(pass), attached \(hold) gated \(s1.gated)/\(s1.chunks), frozen \(frozen) \(s2.gated)/\(s2.chunks)"
            }),
        ]
    }

    static func policyCases() -> [Case] {
        [
            ("from(recording: true) walks plain rungs only: ranked/hardware › ranked/automatic › default/hardware", {
                let a = VoiceProcessingPolicy.from(recording: true).attempts
                let plain = a.count == 3 && a.allSatisfy { !$0.voice && !$0.privateRoute }
                let shape = a[0].wiring == .hardware && a[0].pinDevice && a[1].wiring == .automatic && a[1].pinDevice && a[2].wiring == .hardware && !a[2].pinDevice
                return plain && shape ? nil : "\(a)"
            }),
            (".aec.attempts.count == 5 (private route off): three VoiceIO wirings, then plain ranked, then plain default", {
                let a = VoiceProcessingPolicy.aec.attempts
                let voice = a.count == 5 && a[0].voice && a[0].wiring == .automatic && a[1].wiring == .inputRate && a[2].wiring == .hardware
                let plain = !a[3].voice && a[3].wiring == .hardware && a[3].pinDevice && !a[4].voice && a[4].wiring == .hardware && !a[4].pinDevice
                let noPin = a.prefix(3).allSatisfy { !$0.pinDevice }
                return voice && plain && noPin && !PrivateRoute.enabled && a.allSatisfy { !$0.privateRoute } ? nil : "\(a), private \(PrivateRoute.enabled)"
            }),
            ("StartAttempt.description names the mic on the plain rungs", {
                let ranked = StartAttempt(voice: false, wiring: .hardware, pinDevice: true).description
                let fallback = StartAttempt(voice: false, wiring: .automatic).description
                let vp = StartAttempt(voice: true, wiring: .inputRate).description
                return ranked == "voice processing off, output hardware, ranked mic" && fallback == "voice processing off, output automatic, system default mic" && vp == "voice processing on, output input-rate" ? nil : "\(ranked) | \(fallback) | \(vp)"
            }),
            ("from(recording:) maps to the two policies", {
                VoiceProcessingPolicy.from(recording: false) == .aec && VoiceProcessingPolicy.from(recording: true) == .recording && VoiceProcessingPolicy.aec != .recording ? nil : "mapping"
            }),
            ("the constants: duck min (10) advanced, agc on, bypass off", {
                let p = VoiceProcessingPolicy.aec
                return p.duckLevel == 10 && p.advancedDucking && p.agc && !p.bypass && p.knobsDescription == "duck min advanced, agc on, bypass off" ? nil : p.knobsDescription
            }),
            ("winningRung arithmetic (firstRung)", {
                let f = VoiceProcessingPolicy.firstRung
                let table: [(Int?, Int, Int)] = [(nil, 4, 0), (2, 4, 2), (7, 4, 3), (-1, 4, 0), (0, 0, 0), (3, 2, 1)]
                for (r, n, want) in table where f(r, n) != want { return "firstRung(\(r.map(String.init) ?? "nil"), \(n)) = \(f(r, n)), want \(want)" }
                return nil
            }),
            ("the running line spells the rung and the knobs", {
                let on = AudioEngine.runningLine(mic: "48000 Hz ×1 Float32", policy: .aec, voiceProcessing: true, wiring: .inputRate, rung: 2, tailMs: 0)
                let off = AudioEngine.runningLine(mic: "m", policy: .recording, voiceProcessing: false, wiring: .hardware, rung: 1, tailMs: 420)
                let fb = AudioEngine.runningLine(mic: "m", policy: .aec, voiceProcessing: false, wiring: .hardware, rung: 4, tailMs: 300)
                let okOn = on == "audio running: mic 48000 Hz ×1 Float32, voice processing on (duck min advanced, agc on, bypass off), output wiring input-rate, rung 2, tail 0 ms"
                let okOff = off.contains("voice processing off (guard on), output wiring hardware, rung 1, tail 420 ms")
                let okFb = fb.contains("off (guard on, fallback)") && fb.contains("rung 4")
                return okOn && okOff && okFb ? nil : "\(on) | \(off) | \(fb)"
            }),
            ("the state words", {
                var s = AudioStateReadback()
                let off = s.hearsState == AudioStateWords.off
                s.running = true; s.voiceProcessing = true
                let aec = s.hearsState == AudioStateWords.echoCancelled
                s.voiceProcessing = false; s.recording = true
                let rec = s.hearsState == AudioStateWords.echoGuarded
                s.recording = false
                let fb = s.hearsState == AudioStateWords.echoNone
                s.speaks = AudioDeviceFacts(name: "AirPods", uid: "bt", rate: 16_000, channels: 2, transport: "bluetooth")
                let narrow = s.speaksState == AudioStateWords.narrowed
                s.speaks?.rate = 48_000
                let full = s.speaksState == AudioStateWords.fullQuality
                return off && aec && rec && fb && narrow && full ? nil : "off \(off) aec \(aec) rec \(rec) fb \(fb) narrow \(narrow) full \(full)"
            }),
        ]
    }

    // MARK: voice PLAN W1.1 · the playout cushion

    /// 40 ms chunks, as Live sends them.
    static let chunk = 960

    static func playoutCases() -> [Case] {
        let f = chunk
        let target = PlayoutModel.defaultTargetFrames
        return [
            ("the first chunk after a reset gets exactly target frames of pre-roll", {
                var m = PlayoutModel()
                let p = m.plan(frames: f, now: 1_000)
                let ok = p.prerollFrames == target && p.reset && p.fadeIn && !p.underrun && m.scheduledEnd == Int64(1_000 + target + f) && m.stats.resets == 1 && m.stats.underruns == 0
                return ok ? nil : "\(p), end \(m.scheduledEnd), \(m.stats)"
            }),
            ("contiguous chunks get none", {
                var m = PlayoutModel()
                _ = m.plan(frames: f, now: 0)
                var plans: [PlayoutModel.Plan] = []
                for k in 1 ... 20 { plans.append(m.plan(frames: f, now: Int64(k * f))) }
                let ok = plans.allSatisfy { $0 == PlayoutModel.Plan() } && m.stats.underruns == 0 && m.stats.wouldBeUnderruns == 0 && m.stats.queuedFrames == target
                return ok ? nil : "\(plans.filter { $0 != PlayoutModel.Plan() }.count) chunks planned something, \(m.stats)"
            }),
            ("a chunk that lands as the backlog runs out is contiguous", {
                var m = PlayoutModel()
                _ = m.plan(frames: f, now: 0)
                let p = m.plan(frames: f, now: m.scheduledEnd)
                return p == PlayoutModel.Plan() && m.stats.underruns == 0 ? nil : "\(p)"
            }),
            ("backlog -40 ms counts 1 underrun of 40 ms with a fade-in", {
                var m = PlayoutModel()
                _ = m.plan(frames: f, now: 0)
                let end = m.scheduledEnd
                let p = m.plan(frames: f, now: end + 960)
                let ms = PlayoutModel.ms(m.stats.underrunFrames)
                let ok = p.underrun && p.gapFrames == 960 && p.fadeIn && p.prerollFrames == 0 && !p.reset && m.stats.underruns == 1 && abs(ms - 40) < 1e-9 && m.scheduledEnd == end + 960 + Int64(f)
                return ok ? nil : "\(p), \(ms) ms, end \(m.scheduledEnd)"
            }),
            ("dry for 0.5 s is a reset, not an underrun; just under it is an underrun", {
                var m = PlayoutModel()
                _ = m.plan(frames: f, now: 0)
                var n = m
                let dry = m.plan(frames: f, now: m.scheduledEnd + Int64(PlayoutModel.dryResetFrames))
                let under = n.plan(frames: f, now: n.scheduledEnd + Int64(PlayoutModel.dryResetFrames - 1))
                let ok = dry.reset && dry.prerollFrames == target && !dry.underrun && m.stats.underruns == 0 && m.stats.resets == 2 && under.underrun && !under.reset && n.stats.underruns == 1
                return ok ? nil : "dry \(dry), just under \(under)"
            }),
            ("flush resets: the next chunk is primed on the restarted timeline", {
                var m = PlayoutModel()
                _ = m.plan(frames: f, now: 0)
                _ = m.plan(frames: f, now: 960)
                m.reset()
                let p = m.plan(frames: f, now: 0)
                let ok = p.reset && p.prerollFrames == target && m.scheduledEnd == Int64(target + f) && m.stats.underruns == 0 && m.stats.wouldBeUnderruns == 0 && m.stats.resets == 2
                return ok ? nil : "\(p), end \(m.scheduledEnd), \(m.stats)"
            }),
            ("a nil nowSample before priming is a reset; while primed it appends", {
                // A burst before the player's first render: one pre-roll, then contiguous.
                var m = PlayoutModel()
                let first = m.plan(frames: f, now: nil)
                let second = m.plan(frames: f, now: nil)
                let third = m.plan(frames: f, now: nil)
                let burst = first.reset && first.prerollFrames == target && second == PlayoutModel.Plan() && third == PlayoutModel.Plan() && m.scheduledEnd == Int64(target + 3 * f) && m.stats.resets == 1
                // Once the player renders, the backlog is read on the same timeline: no underrun.
                let rendered = m.plan(frames: f, now: Int64(2 * f))
                let continues = rendered == PlayoutModel.Plan() && m.stats.underruns == 0 && m.stats.wouldBeUnderruns == 0 && m.stats.queuedFrames == target + f
                // A primed stream with a valid clock that then reads nil also appends.
                var n = PlayoutModel()
                _ = n.plan(frames: f, now: 4_800)
                let end = n.scheduledEnd
                let appended = n.plan(frames: f, now: nil)
                let primedAppend = appended == PlayoutModel.Plan() && n.scheduledEnd == end + Int64(f) && n.stats.resets == 1
                return burst && continues && primedAppend ? nil : "burst \(first) \(second) \(third) end \(m.scheduledEnd); then \(rendered) \(m.stats); primed nil \(appended) end \(n.scheduledEnd)"
            }),
            ("target grows to the longest gap + 40 ms, capped at 200 ms, and never shrinks", {
                var m = PlayoutModel()
                _ = m.plan(frames: f, now: 0)
                _ = m.plan(frames: f, now: m.scheduledEnd + 2_400)
                let after100 = m.targetFrames
                _ = m.plan(frames: f, now: m.scheduledEnd + 7_200)
                let after300 = m.targetFrames
                _ = m.plan(frames: f, now: m.scheduledEnd + 240)
                m.reset()
                let p = m.plan(frames: f, now: 0)
                let ok = after100 == 2_400 + PlayoutModel.targetMarginFrames && after300 == PlayoutModel.maxTargetFrames && m.targetFrames == PlayoutModel.maxTargetFrames && p.prerollFrames == PlayoutModel.maxTargetFrames && PlayoutModel.ms(PlayoutModel.maxTargetFrames) == 200
                return ok ? nil : "after 100 ms \(after100), after 300 ms \(after300), then \(m.targetFrames), pre-roll \(p.prerollFrames)"
            }),
            ("the shadow counts the zero-cushion holes of a fixed trace (2), the cushion none", {
                // 40 ms chunks; chunk 4 arrives 40 ms late, chunk 7 80 ms late with 8 and 9 behind it.
                // Zero cushion by hand: dry at chunk 4 (3840 < 4800) and at chunk 7 (7680 < 8640): 2.
                let arrivals: [Int64] = [0, 960, 1_920, 2_880, 4_800, 4_800, 5_760, 8_640, 8_640, 8_640, 9_600, 10_560]
                var m = PlayoutModel()
                for a in arrivals { _ = m.plan(frames: f, now: a) }
                return m.stats.wouldBeUnderruns == 2 && m.stats.underruns == 0 && m.stats.queuedMinFrames == 960 ? nil : "\(m.stats)"
            }),
            ("the frame's late max and backlog minimum are per window, the graph's late max stays, and a wait between a read and its close is the next window's", {
                // Voice PLAN §3: lateMaxMs and queuedMinMs per window (since the previous frame went out); lateMaxGraphMs since the graph started.
                let t = PlaybackTelemetry()
                t.restart(mixFormat: "48000 Hz ×2")
                var m = PlayoutModel()
                func scheduled(_ plan: PlayoutModel.Plan) -> SpeakerScheduler.Scheduled {
                    SpeakerScheduler.Scheduled(rms: 0.1, peak: 0.3, seconds: 0.04, prerollSeconds: 0, plan: plan)
                }
                // Window 1: a play block waited 300 ms behind a restart; the backlog fell to 40 ms.
                t.noteLate(0.300)
                t.noteScheduled(scheduled(m.plan(frames: f, now: 0)), model: m, gain: 1)
                t.noteScheduled(scheduled(m.plan(frames: f, now: Int64(target))), model: m, gain: 1)
                let first = t.readback()?.playout
                // A 20 ms wait lands after the read, before the frame's close.
                t.noteLate(0.020)
                t.closeWindow()
                // Window 2: the backlog at 80 ms; this frame does not go out (no close), so window 2 runs on.
                t.noteScheduled(scheduled(m.plan(frames: f, now: Int64(target))), model: m, gain: 1)
                let second = t.readback()?.playout
                t.noteLate(0.050)
                let third = t.readback()?.playout
                t.closeWindow()
                let fourth = t.readback()?.playout
                let ok = first?.lateMaxMs == 300 && first?.lateMaxGraphMs == 300 && first?.queuedMinMs == 40
                    && second?.lateMaxMs == 20 && second?.lateMaxGraphMs == 300 && second?.queuedMinMs == 80
                    && third?.lateMaxMs == 50 && third?.queuedMinMs == 80
                    && fourth?.lateMaxMs == 0 && fourth?.queuedMinMs == nil && fourth?.lateMaxGraphMs == 300
                func w(_ p: PlayoutReadback?) -> String { "late \(p?.lateMaxMs ?? -1) graph \(p?.lateMaxGraphMs ?? -1) min \(p?.queuedMinMs.map(String.init) ?? "nil")" }
                return ok ? nil : "\(w(first)) | \(w(second)) | \(w(third)) | \(w(fourth))"
            }),
            ("a coalesced frame carries the longest wait and the smallest backlog of every window since the last frame sent", {
                // AppDelegate.sendAudioFrame forwards at most one frame a second, the newest of a burst. Frames 1 to 3
                // close their windows in the reader; only frame 3 goes out, so it carries frame 2's 300 ms stall.
                var fold = PlayoutWindowFold()
                fold.note(lateMaxMs: 7, queuedMinMs: 96)
                fold.note(lateMaxMs: 300, queuedMinMs: nil)
                fold.note(lateMaxMs: 4, queuedMinMs: 40)
                let burst = fold.take()
                // The next frame goes out alone: its own figures, nothing carried over.
                fold.note(lateMaxMs: 5, queuedMinMs: nil)
                let alone = fold.take()
                let empty = fold.take()
                // A non-finite figure (a corrupted mirror) never wins.
                fold.note(lateMaxMs: .infinity, queuedMinMs: .nan)
                fold.note(lateMaxMs: 2, queuedMinMs: 80)
                let guarded = fold.take()
                let ok = burst.lateMaxMs == 300 && burst.queuedMinMs == 40 && alone.lateMaxMs == 5 && alone.queuedMinMs == nil
                    && empty.lateMaxMs == nil && empty.queuedMinMs == nil && guarded.lateMaxMs == 2 && guarded.queuedMinMs == 80
                return ok ? nil : "burst \(burst) · alone \(alone) · empty \(empty) · guarded \(guarded)"
            }),
            ("the fade ramp is monotonic, finite, inside (0, 1], and ends at 1", {
                let n = PlayoutModel.fadeFrames
                let g = (0 ..< n).map { PlayoutModel.fadeGain($0) }
                let rising = zip(g, g.dropFirst()).allSatisfy { $0 < $1 }
                let bounded = g.allSatisfy { $0.isFinite && $0 > 0 && $0 <= 1 }
                let clamped = PlayoutModel.fadeGain(-3) == g[0] && PlayoutModel.fadeGain(n + 7) == 1
                let ok = n == 120 && rising && bounded && g.last == 1 && clamped && PlayoutModel.ms(n) == 5
                return ok ? nil : "n \(n), rising \(rising), bounded \(bounded), last \(g.last ?? .nan), clamped \(clamped)"
            }),
        ]
    }
}
