import AVFoundation
import Foundation

// Throwaway harness: the barge-in duck (Audio/AudioEngine.swift `BargeInDuck`) on synthetic
// tap buffers, and the microphone ranking (`MicRanking`) on this Mac's devices — read-only,
// nothing is played, recorded, or changed. Not part of the package; compiled only by
// Scripts/duck-probe.sh, which `pnpm jarhead bench` runs for its "barge-in" rows.
//
//   DUCK_PROBE_RUNS=3      runs; each run plays the five scenarios below, the speech onset
//                          0, 30 or 70 ms into a 100 ms buffer in turn
//   DUCK_PROBE_LIVE_MS=900 when Live's transcript of Kevin first grows, after his onset
//                          (modelled: no live session is opened here)
//   --json                 the last line is the report the bench reads
//
// The scenarios, each with audible output "playing" (noteOutput every 100 ms, as the speaker
// path does) and Jarhead's transcript "Let me check that for you. Opening the settings now.":
//   live    Kevin speaks 1.5 s; the ear is off; Live's transcript of him grows at +LIVE_MS and
//           every 300 ms after; Live stops Jarhead's audio at +1.4 s (its measured stop on
//           barge-in); the phase leaves `speaking` at +2.6 s (1.2 s after Jarhead's last words)
//   cough   200 ms of energy, nothing follows
//   ear     Kevin speaks 1.0 s; the ear's partial "open safari" at +200 ms (words Jarhead did
//           not say); Live stops Jarhead at +1.4 s
//   echo    200 ms of energy and a partial "check that for you" at +200 ms — Jarhead's own words,
//           the residual echo case: it must not confirm
//   phase   Kevin speaks 1.5 s; no ear, no Live transcript; Live stops Jarhead at +1.4 s; only
//           the phase leaves `speaking`, at +2.6 s
//
// Buffers are 100 ms of 48 kHz mono, delivered every 100 ms and stamped "captured" 100 ms
// before delivery — the tap's own cadence (AVAudioEngine clamps tap buffers to ≥ 100 ms) — so
// a sample is what the app measures: the first hot 10 ms slice's capture time → the player's
// gain reaching −20 dB. What it cannot include: the mixer's own render cycle after the volume
// is set (one quantum, ~5–10 ms at 48 kHz).

@main
struct DuckProbeMain {
    static func main() {
        setlinebuf(stdout)
        let json = CommandLine.arguments.contains("--json")
        let env = ProcessInfo.processInfo.environment
        let runs = max(1, Int(env["DUCK_PROBE_RUNS"] ?? "") ?? 3)
        let liveMs = max(100, Int(env["DUCK_PROBE_LIVE_MS"] ?? "") ?? 900)
        let probe = DuckProbe(runs: runs, liveMs: liveMs, json: json)
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

    // The round in flight.
    private var current: Round?
    private var duckedAt: Date?
    private var confirmedBy: String?
    private var releasedWhy: String?
    private var speechEndWall: Date?
    private var pendingEvents = 0
    private var roundTimer: DispatchSourceTimer?

    init(runs: Int, liveMs: Int, json: Bool) {
        self.runs = runs
        self.liveMs = liveMs
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
            say("  partial \"\(text)\" refused as confirmation: Jarhead's own words")
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
        guard !rounds.isEmpty else { return finish() }
        let round = rounds.removeFirst()
        duck.resetForHarness()
        duck.noteJarheadSaid(DuckProbe.jarheadSaid)
        duck.noteVoiceSpeaking(true)
        lock.lock()
        minGainSeen = 1
        current = round
        duckedAt = nil
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
            while Double(t) / 1000 < round.scenario.speechSeconds + 0.3 {
                at(t) { [duck] in duck.noteLiveHeardKevin() }
                t += 300
            }
        case .ear:
            at(DuckProbe.earPartialMs) { [duck] in duck.noteEarWords("open safari") }
        case .echo:
            at(DuckProbe.earPartialMs) { [duck] in duck.noteEarWords("check that for you") }
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
        lock.unlock()
        if !ducked { failures.append("\(round.scenario.rawValue) round never ducked") }
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
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in self?.nextRound() }
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
        lock.unlock()
        let onsets = runs * Scenario.allCases.count
        say(String(format: "done: %d ducks of %d onsets; onset → −20 dB median %.0f ms, p95 %.0f ms, max %.0f ms; lowest gain %.2f", s.count, onsets, percentile(s, 50), percentile(s, 95), s.max() ?? .nan, min))
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
        ]
        if !fails.isEmpty { report["failures"] = fails }
        if let data = try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]), let line = String(data: data, encoding: .utf8) {
            print(line)
        }
        let missing = s.count < onsets
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { exit(fails.isEmpty && !missing ? 0 : 2) }
    }
}

// MARK: - V4 · the pure parts (design12 § Verification)

/// Table-driven `check:` lines over `EchoGuardModel`, `EchoGuard` and `VoiceProcessingPolicy`
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
        for (section, cases) in [("guard", guardCases()), ("policy", policyCases())] {
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
            ("from(recording: true) walks plain rungs only", {
                let a = VoiceProcessingPolicy.from(recording: true).attempts
                return a.count == 2 && a.allSatisfy { !$0.voice && !$0.privateRoute } && a[0].wiring == .hardware && a[1].wiring == .automatic ? nil : "\(a)"
            }),
            (".aec.attempts.count == 4 (private route off)", {
                let a = VoiceProcessingPolicy.aec.attempts
                let shape = a.count == 4 && a[0].voice && a[0].wiring == .automatic && a[1].wiring == .inputRate && a[2].wiring == .hardware && !a[3].voice && a[3].wiring == .hardware
                return shape && !PrivateRoute.enabled && a.allSatisfy { !$0.privateRoute } ? nil : "\(a), private \(PrivateRoute.enabled)"
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
}
