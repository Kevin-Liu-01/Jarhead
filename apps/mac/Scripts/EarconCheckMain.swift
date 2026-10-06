import AVFoundation
import Foundation

// Throwaway harness for Scripts/earcon-check.sh: the palette (Audio/Earcons.swift), its cues
// (App/EarconCues.swift) and LocalSpeaker's echo rule, pure and through a recorder sink on a scripted
// clock; then every file the app can ask for, opened and decoded. Nothing is played: the recorder
// stands in for the player, and the files are read with AVAudioFile, never handed to an output.

/// Plays nothing: remembers what it was asked to do.
@MainActor
final class RecorderSink: EarconSink {
    var plays: [(Earcon, Float)] = []
    var fades: [Earcon] = []
    var stopped = 0
    var sounding: Set<Earcon> = []

    func load(_ files: [Earcon: URL]) -> [Earcon: Double] {
        var out: [Earcon: Double] = [:]
        for e in files.keys { out[e] = e.seconds }
        return out
    }

    func play(_ e: Earcon, gain: Float) -> Bool {
        plays.append((e, gain))
        sounding.insert(e)
        return true
    }

    func fadeOut(_ e: Earcon, over seconds: Double) {
        guard sounding.contains(e) else { return }
        fades.append(e)
        sounding.remove(e)
    }

    func isPlaying(_ e: Earcon) -> Bool { sounding.contains(e) }

    func stopAll() {
        stopped += 1
        sounding.removeAll()
    }

    var played: [Earcon] { plays.map(\.0) }
}

@main
struct EarconCheckMain {
    nonisolated(unsafe) static var failed = 0
    nonisolated(unsafe) static var passed = 0

    static func check(_ section: String, _ name: String, _ ok: Bool, _ detail: @autoclosure () -> String = "") {
        if ok {
            passed += 1
            print("check: \(section) · \(name) ok")
        } else {
            failed += 1
            let d = detail()
            print("check: \(section) · \(name) FAIL\(d.isEmpty ? "" : " — \(d)")")
        }
    }

    static func near(_ a: Double, _ b: Double, _ eps: Double = 1e-6) -> Bool { abs(a - b) <= eps }

    @MainActor
    static func main() {
        setlinebuf(stdout)
        let args = CommandLine.arguments
        func value(_ flag: String) -> String? {
            guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
            return args[i + 1]
        }
        names()
        model()
        wire()
        echo()
        cues()
        player(sounds: value("--sounds"))
        if let dir = value("--sounds") { files(URL(fileURLWithPath: dir, isDirectory: true), label: "files") }
        if let app = value("--bundle") {
            files(URL(fileURLWithPath: app).appendingPathComponent("Contents/Resources/Sounds", isDirectory: true), label: "bundle")
        }
        print("check: earcons \(passed) ok, \(failed) FAIL")
        exit(failed == 0 ? 0 : 1)
    }

    // MARK: - the names

    static func names() {
        let s = "names"
        check(s, "twelve sounds, by file name", Earcon.allCases.map(\.rawValue) == ["heard", "awake", "pause", "sleep", "chime", "timer", "alarm", "snooze", "opened", "mark", "cue", "problem"])
        check(s, "the gate's door: Pop → heard, Glass → awake, anything else → heard",
              Earcon.gate("Pop") == .heard && Earcon.gate("Glass") == .awake && Earcon.gate("Ping") == .heard && Earcon.gate("") == .heard)
        check(s, "local.say: Pop → opened, Glass → chime, Ping → timer, Hero → alarm, unknown or none → chime",
              Earcon.ring("Pop") == .opened && Earcon.ring("Glass") == .chime && Earcon.ring("Ping") == .timer && Earcon.ring("Hero") == .alarm
                && Earcon.ring("Basso") == .chime && Earcon.ring(nil) == .chime)
        check(s, "the rings are chime, timer and alarm", Set(Earcon.allCases.filter(\.isRing)) == [.chime, .timer, .alarm])
        let order: [Earcon] = [.alarm, .timer, .chime, .problem, .awake, .snooze, .heard, .cue, .opened, .mark]
        let descending = zip(order, order.dropFirst()).allSatisfy { $0.priority > $1.priority }
        check(s, "priority: alarm > timer > chime > problem > awake · sleep · pause > snooze > heard > cue > opened > mark",
              descending && Earcon.awake.priority == Earcon.sleep.priority && Earcon.sleep.priority == Earcon.pause.priority)
        let lengths = Earcon.allCases.map(\.seconds)
        check(s, "every sound is short: 0.12–1.6 s, interface sounds under 1 s", lengths.allSatisfy { $0 >= 0.12 && $0 <= 1.6 }
              && Earcon.allCases.filter { !$0.isRing }.allSatisfy { $0.seconds < 1 })
    }

    // MARK: - the one gate (pure)

    static func model() {
        let s = "gate"
        var m = EarconModel()
        let t = 1000.0
        check(s, "a session's microphone runs: an interface sound is dropped", m.decide(.heard, now: t, voiceRuns: true, voiceAudibleUntil: 0, requestedAt: t) == .drop(.session))
        check(s, "a ring is dropped in a session too (the voice says the line)", m.decide(.chime, now: t, voiceRuns: true, voiceAudibleUntil: 0, requestedAt: t) == .drop(.session))
        check(s, "awake plays at the session edge (connecting; the wire hold covers it)", m.decide(.awake, now: t, voiceRuns: true, voiceAudibleUntil: 0, requestedAt: t) == .play(gain: 0.7))
        check(s, "the gate's Glass and the connecting edge are one awake (deduped within 1.5 s)", m.decide(.awake, now: t + 1.0, voiceRuns: true, voiceAudibleUntil: 0, requestedAt: t + 1.0) == .drop(.duplicate))
        check(s, "…and a second awake 1.6 s later plays", m.decide(.awake, now: t + 1.6, voiceRuns: false, voiceAudibleUntil: 0, requestedAt: t + 1.6) == .play(gain: 0.7))

        m = EarconModel()
        m.config = EarconModel.Config(interface: false, volume: 0.5)
        check(s, "Sounds off: an interface sound is dropped", m.decide(.pause, now: t, voiceRuns: false, voiceAudibleUntil: 0, requestedAt: t) == .drop(.off))
        check(s, "Sounds off: the timer still rings at the volume", m.decide(.timer, now: t, voiceRuns: false, voiceAudibleUntil: 0, requestedAt: t) == .play(gain: 0.5))
        m.config.volume = 0
        check(s, "volume 0: the chime is silent", m.decide(.chime, now: t + 10, voiceRuns: false, voiceAudibleUntil: 0, requestedAt: t + 10) == .drop(.silent))
        if case .play(let g) = m.decide(.alarm, now: t + 20, voiceRuns: false, voiceAudibleUntil: 0, requestedAt: t + 20, automationId: "a") {
            check(s, "volume 0: the alarm still rings at its floor 0.4, 4 dB down", near(g, 0.4 * pow(10, -4.0 / 20)), "gain \(g)")
        } else {
            check(s, "volume 0: the alarm still rings at its floor", false)
        }

        m = EarconModel()
        _ = m.decide(.alarm, now: t, voiceRuns: false, voiceAudibleUntil: 0, requestedAt: t, automationId: "a")
        check(s, "a lower sound under 250 ms after a higher one is dropped", m.decide(.heard, now: t + 0.1, voiceRuns: false, voiceAudibleUntil: 0, requestedAt: t + 0.1) == .drop(.outranked))
        check(s, "…and plays at 300 ms", m.decide(.heard, now: t + 0.3, voiceRuns: false, voiceAudibleUntil: 0, requestedAt: t + 0.3) == .play(gain: 0.7))
        check(s, "a higher sound right after a lower one plays", m.decide(.timer, now: t + 0.35, voiceRuns: false, voiceAudibleUntil: 0, requestedAt: t + 0.35) == .play(gain: 0.7))
        m.forgetRings()
        check(s, "after Snooze faded the rings, the snooze sound is not outranked", m.decide(.snooze, now: t + 0.4, voiceRuns: false, voiceAudibleUntil: 0, requestedAt: t + 0.4) == .play(gain: 0.7))

        m = EarconModel()
        check(s, "the voice still audible: wait, looking again every 100 ms", m.decide(.sleep, now: t, voiceRuns: false, voiceAudibleUntil: t + 0.5, requestedAt: t) == .wait(until: t + 0.1))
        check(s, "…until its end + 150 ms", m.decide(.sleep, now: t + 0.6, voiceRuns: false, voiceAudibleUntil: t + 0.5, requestedAt: t) == .wait(until: t + 0.65))
        check(s, "…drained by then: it plays", m.decide(.sleep, now: t + 0.65, voiceRuns: false, voiceAudibleUntil: t + 0.5, requestedAt: t) == .play(gain: 0.7))
        check(s, "a flush ends the wait early (the queue's end moves to the flush)", m.decide(.pause, now: t + 5.3, voiceRuns: false, voiceAudibleUntil: t + 5.1, requestedAt: t + 5) == .play(gain: 0.7))
        check(s, "a drain still running 2 s after the request drops it (the farewell is protected)",
              m.decide(.chime, now: t + 10, voiceRuns: false, voiceAudibleUntil: t + 12, requestedAt: t + 10) == .wait(until: t + 10.1)
                && m.decide(.chime, now: t + 12, voiceRuns: false, voiceAudibleUntil: t + 12.5, requestedAt: t + 10) == .drop(.drain))

        m = EarconModel()
        var ramp: [Double] = []
        for i in 0..<6 {
            let at = t + Double(i) * 30
            if case .play(let g) = m.decide(.alarm, now: at, voiceRuns: false, voiceAudibleUntil: 0, requestedAt: at, automationId: "wake") { ramp.append((20 * log10(g / 0.7) * 10).rounded() / 10) }
        }
        check(s, "the alarm's repeats rise from −4 dB by 1 dB per ring to 0 dB", ramp == [-4, -3, -2, -1, 0, 0], "\(ramp)")
        if case .play(let g) = m.decide(.alarm, now: t + 400, voiceRuns: false, voiceAudibleUntil: 0, requestedAt: t + 400, automationId: "wake") {
            check(s, "a ring after a long gap starts the ramp over", near(20 * log10(g / 0.7), -4, 0.05))
        } else {
            check(s, "a ring after a long gap starts the ramp over", false)
        }
        if case .play(let g) = m.decide(.alarm, now: t + 405, voiceRuns: false, voiceAudibleUntil: 0, requestedAt: t + 405, automationId: "other") {
            check(s, "the ramp is per row", near(20 * log10(g / 0.7), -4, 0.05))
        } else {
            check(s, "the ramp is per row (another row's ring at +5 s plays)", false)
        }
        m.quitting = true
        check(s, "quitting: nothing starts", m.decide(.chime, now: t + 900, voiceRuns: false, voiceAudibleUntil: 0, requestedAt: t + 900) == .drop(.quitting))
    }

    // MARK: - the wire hold

    static func wire() {
        let s = "wire"
        let built = EarconWire.holdUntil(start: 0, duration: 0.42, latency: 0.01, bluetooth: false)
        check(s, "awake on the built-in speakers holds 0.42 + 0.01 + (0.30 + 0.01) s", near(built, 0.74), "\(built)")
        check(s, "…which is about the first 0.75 s after the grant", built <= 0.76)
        let bt = EarconWire.holdUntil(start: 0, duration: 0.42, latency: 0.05, bluetooth: true)
        check(s, "Bluetooth adds 0.20 s to the tail", near(bt, 0.42 + 0.05 + 0.55), "\(bt)")
        let capped = EarconWire.holdUntil(start: 0, duration: 0.42, latency: 0.6, bluetooth: true)
        check(s, "the tail is capped at 0.80 s", near(capped, 0.42 + 0.6 + 0.8), "\(capped)")
        check(s, "the tail is the echo guard's own figure", EchoGuardModel.tail(latency: 0.01, bluetooth: false) == EchoGuardModel.baseTail + 0.01)

        let w = EarconWire()
        w.note(start: 100, duration: 0.18, latency: 0.01, bluetooth: false, holdsWire: false)
        check(s, "heard never holds the wire", !w.holdsWire(at: 100.05))
        check(s, "…but its audible window is kept for the wake listener", near(w.audibleUntil, 100.19) && near(w.endsAt, 100.18))
        w.note(start: 200, duration: 0.42, latency: 0.01, bluetooth: false, holdsWire: true)
        check(s, "awake holds the wire until its tail has passed", w.holdsWire(at: 200.5) && w.holdsWire(at: 200.739) && !w.holdsWire(at: 200.741))
        let chunks = (0..<10).map { w.judgeChunk(at: 200.05 + Double($0) * 0.1, seconds: 0.1) }
        check(s, "seven 100 ms chunks are zero-filled, then the wire is open", chunks == [true, true, true, true, true, true, true, false, false, false], "\(chunks)")
        check(s, "the holds are counted for `jarhead status`", w.counters.holds == 7 && near(w.counters.heldSeconds, 0.7))
        w.resetCounters()
        check(s, "the counters start over with the graph", w.counters == EarconWire.Stats())
        w.note(start: 300, duration: 2.6, latency: 0.01, bluetooth: false, holdsWire: false)
        w.cut(at: 300.12)
        check(s, "a fade (Snooze, Done) ends the audible window", near(w.audibleUntil, 300.12) && near(w.endsAt, 300.12))

        let clock = VoiceOutputClock()
        clock.noteOutput(rms: 0, seconds: 0.2, now: 10)
        check(s, "voice: a silent pre-roll arms nothing", clock.audibleUntil == 0)
        clock.noteOutput(rms: 0.1, seconds: 0.5, now: 10)
        check(s, "voice: an audible chunk queues behind the pre-roll", near(clock.audibleUntil, 10.7))
        clock.noteFlush(now: 10.3)
        check(s, "voice: a flush or the graph's stop drains it now", near(clock.audibleUntil, 10.3))
    }

    // MARK: - the wake listener's echo rule

    static func echo() {
        let s = "echo"
        let t = 500.0
        let now = { (dt: Double) in Date(timeIntervalSinceReferenceDate: t + dt) }
        check(s, "quiet only 0.35 s after the last earcon is audible",
              !LocalSpeaker.isQuiet(speaking: false, lastFinishedAt: .distantPast, earconAudibleUntil: t, now: now(0.3))
                && LocalSpeaker.isQuiet(speaking: false, lastFinishedAt: .distantPast, earconAudibleUntil: t, now: now(0.36)))
        check(s, "the later of the last word and the last earcon counts",
              !LocalSpeaker.isQuiet(speaking: false, lastFinishedAt: now(1), earconAudibleUntil: t, now: now(1.2)))
        check(s, "never quiet while speaking", !LocalSpeaker.isQuiet(speaking: true, lastFinishedAt: .distantPast, earconAudibleUntil: 0, now: now(10)))
        check(s, "a line starts 50 ms before its sound ends", near(LocalSpeaker.delay(beforeEarconEnding: t + 0.18, now: t), 0.13))
        check(s, "…not at all when nothing sounds, and never more than 3 s",
              LocalSpeaker.delay(beforeEarconEnding: 0, now: t) == 0 && LocalSpeaker.delay(beforeEarconEnding: t + 9, now: t) == 3)
    }

    // MARK: - which moments sound

    static func cues() {
        let s = "cues"
        let tuck = 0.55
        func edge(_ a: Phase, _ b: Phase) -> EarconCues.Cue? { EarconCues.edge(from: a, to: b, tuck: tuck) }
        check(s, "asleep or paused → connecting: awake, at once", edge(.asleep, .connecting) == .init(earcon: .awake, delay: 0) && edge(.paused, .connecting) == .init(earcon: .awake, delay: 0))
        check(s, "error → connecting is silent (a retry, not a wake)", edge(.error, .connecting) == nil)
        check(s, "connecting → listening (the session opens) and reconnects are silent", edge(.connecting, .listening) == nil && edge(.listening, .connecting) == nil)
        check(s, "a session phase or connecting → paused: pause", edge(.speaking, .paused) == .init(earcon: .pause, delay: 0) && edge(.connecting, .paused)?.earcon == .pause)
        check(s, "a session phase → asleep: sleep with the tuck", edge(.listening, .asleep) == .init(earcon: .sleep, delay: tuck) && edge(.connecting, .asleep)?.earcon == .sleep)
        check(s, "paused → asleep is silent (nothing audible changed)", edge(.paused, .asleep) == nil)
        check(s, "connecting → error: problem; a session phase → error is silent", edge(.connecting, .error)?.earcon == .problem && edge(.listening, .error) == nil)
        check(s, "mute, unmute and the turn phases are silent",
              edge(.listening, .muted) == nil && edge(.muted, .listening) == nil && edge(.listening, .speaking) == nil && edge(.thinking, .acting) == nil)
        check(s, "problem kinds: voice.*, brain.unavailable, daemon, crash, hands.helper, app.version, permission.microphone",
              ["voice.key", "voice.limit", "voice.connection", "brain.unavailable", "daemon", "crash", "hands.helper", "app.version", "permission.microphone"].allSatisfy(EarconCues.problemSounds))
        check(s, "automation.*, disk.low, dock and the other permissions stay silent",
              !["automation.missed", "automation.failed", "disk.low", "dock", "permission.screenRecording", "brain.local", "other"].contains(where: EarconCues.problemSounds))

        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        func at(_ h: Int, _ m: Int) -> Date { cal.date(from: DateComponents(year: 2026, month: 10, day: 6, hour: h, minute: m))! }
        let night = ClockSpan(from: "22:00", to: "07:00")
        check(s, "quiet hours wrap midnight", EarconCues.inQuiet(night, at: at(23, 30), calendar: cal) && EarconCues.inQuiet(night, at: at(6, 59), calendar: cal)
              && !EarconCues.inQuiet(night, at: at(7, 0), calendar: cal) && !EarconCues.inQuiet(night, at: at(12, 0), calendar: cal))
        check(s, "no quiet hours, a malformed clock or an empty span is never quiet",
              !EarconCues.inQuiet(nil, at: at(23, 0), calendar: cal) && !EarconCues.inQuiet(ClockSpan(from: "7:5", to: "08:00"), at: at(7, 30), calendar: cal)
                && !EarconCues.inQuiet(ClockSpan(from: "08:00", to: "08:00"), at: at(8, 0), calendar: cal))

        func p(_ kind: String) -> Problem { Problem(kind: kind, text: kind, remedy: nil, since: 0) }
        var gate = EarconCues.ProblemGate(launchedAt: 0)
        check(s, "problem: the first 15 s after launch are silent", gate.admit([p("daemon")], now: 10, quiet: false).isEmpty)
        check(s, "problem: a republished list is not new", gate.admit([p("daemon")], now: 20, quiet: false).isEmpty)
        check(s, "problem: a new needs-Kevin kind sounds once", gate.admit([p("daemon"), p("voice.key")], now: 30, quiet: false) == ["voice.key"])
        _ = gate.admit([p("daemon")], now: 40, quiet: false)
        check(s, "problem: the same kind again within 10 min is silent", gate.admit([p("daemon"), p("voice.key")], now: 100, quiet: false).isEmpty)
        _ = gate.admit([], now: 650, quiet: false)
        check(s, "problem: …and sounds again after 10 min", gate.admit([p("voice.key")], now: 700, quiet: false) == ["voice.key"])
        _ = gate.admit([], now: 710, quiet: false)
        check(s, "problem: quiet hours or a session keep it silent", gate.admit([p("crash")], now: 720, quiet: true).isEmpty)
        check(s, "problem: automation.* never sounds", gate.admit([p("crash"), p("automation.failed")], now: 730, quiet: false).isEmpty)
    }

    // MARK: - the front door, through a recorder

    @MainActor
    static func player(sounds: String?) {
        let s = "player"
        let rec = RecorderSink()
        let earcons = Earcons(sink: rec)
        var clock = 10_000.0
        var runs = false
        var voiceUntil = 0.0
        var scheduled: [(Double, @MainActor () -> Void)] = []
        earcons.now = { clock }
        earcons.voiceRuns = { runs }
        earcons.voiceAudibleUntil = { voiceUntil }
        earcons.output = { EarconOutput.Facts(latency: 0.01, bluetooth: false) }
        earcons.schedule = { delay, work in scheduled.append((clock + delay, work)) }
        func advance(_ dt: Double) {
            clock += dt
            let due = scheduled.filter { $0.0 <= clock + 1e-9 }
            scheduled.removeAll { $0.0 <= clock + 1e-9 }
            for (_, work) in due { work() }
        }
        EarconWire.shared.resetForHarness()

        if let sounds {
            let loaded = earcons.load(directory: URL(fileURLWithPath: sounds, isDirectory: true))
            check(s, "every sound is found in \(sounds)", loaded == Set(Earcon.allCases), "missing \(Set(Earcon.allCases).subtracting(loaded).map(\.rawValue).sorted())")
        }
        check(s, "nothing loads from nowhere", earcons.load(directory: nil).isEmpty)

        earcons.play(.awake)
        advance(0.2)
        earcons.play(.awake)
        check(s, "grant then the connecting edge: one awake at 70 %", rec.played == [.awake] && rec.plays.first?.1 == 0.7)
        check(s, "awake holds the wire past its own end", EarconWire.shared.holdsWire(at: clock + 0.4) && !EarconWire.shared.holdsWire(at: clock + 0.6))

        runs = true
        advance(5)
        earcons.play(.cue)
        earcons.ring("Glass", automationId: "r1")
        check(s, "in a session nothing plays", rec.played == [.awake])
        runs = false

        voiceUntil = clock + 0.4
        earcons.play(.sleep)
        check(s, "sleep waits while the farewell is still audible", rec.played == [.awake] && scheduled.count == 1)
        for _ in 0..<5 { advance(0.1) }
        check(s, "…polling, not yet", rec.played == [.awake])
        advance(0.1)
        check(s, "…and plays once it has drained (+150 ms)", rec.played == [.awake, .sleep])
        advance(5)
        voiceUntil = clock + 3
        earcons.play(.pause)
        for _ in 0..<25 { advance(0.1) }
        check(s, "a drain that runs past 2 s drops the sound", rec.played == [.awake, .sleep] && scheduled.isEmpty)
        voiceUntil = 0

        advance(5)
        earcons.ring("Hero", automationId: "wake")
        check(s, "Hero rings the alarm, 4 dB down at 70 %", rec.played.last == .alarm && abs(Double(rec.plays.last!.1) - 0.7 * pow(10, -4.0 / 20)) < 1e-4)
        advance(2)
        let sounded = earcons.fadeRings(for: "wake")
        if sounded { earcons.play(.snooze) }
        check(s, "Snooze fades the sounding alarm and plays the snooze sound", sounded && rec.fades == [.alarm] && rec.played.last == .snooze)
        check(s, "a row that never rang gets no snooze sound", !earcons.fadeRings(for: "never"))
        advance(700)
        check(s, "a ring older than the 10-minute linger gets none either", !earcons.fadeRings(for: "wake"))

        earcons.configure(interface: false, volume: 0.5)
        advance(5)
        earcons.play(.mark)
        earcons.ring("Ping", automationId: "tea")
        check(s, "Sounds off: the mark is silent, the timer rings at 50 %", rec.played.last == .timer && rec.plays.last?.1 == 0.5 && !rec.played.contains(.mark))
        earcons.configure(interface: true, volume: 0.7)
        advance(5)
        earcons.play(.heard)
        check(s, "the wake listener waits out the sound (LocalSpeaker.isQuiet)",
              !LocalSpeaker.isQuiet(speaking: false, lastFinishedAt: .distantPast, earconAudibleUntil: earcons.audibleUntil, now: Date(timeIntervalSinceReferenceDate: clock + 0.3)))
        earcons.silence()
        advance(5)
        earcons.ring("Hero", automationId: "late")
        check(s, "quitting: everything stops and nothing new starts", rec.stopped == 1 && rec.played.last == .heard)
    }

    // MARK: - the files, decoded (never played)

    static func files(_ dir: URL, label s: String) {
        let present = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        let cafs = Set(present.filter { $0.hasSuffix(".\(Earcon.fileExtension)") })
        let expected = Set(Earcon.allCases.map { "\($0.rawValue).\(Earcon.fileExtension)" })
        let shown = dir.pathComponents.suffix(3).joined(separator: "/")
        check(s, "\(shown): exactly the twelve files the app can ask for", cafs == expected,
              "missing \(expected.subtracting(cafs).sorted()), unknown \(cafs.subtracting(expected).sorted())")
        var total = 0
        for e in Earcon.allCases {
            let url = dir.appendingPathComponent(e.rawValue).appendingPathExtension(Earcon.fileExtension)
            total += ((try? FileManager.default.attributesOfItem(atPath: url.path)[.size]) as? Int) ?? 0
            guard let file = try? AVAudioFile(forReading: url) else {
                check(s, "\(e.rawValue) opens", false, url.path)
                continue
            }
            let f = file.fileFormat
            let seconds = Double(file.length) / f.sampleRate
            guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)),
                  (try? file.read(into: buffer)) != nil, let samples = buffer.floatChannelData?[0] else {
                check(s, "\(e.rawValue) decodes", false)
                continue
            }
            var peak: Float = 0
            for i in 0..<Int(buffer.frameLength) { peak = max(peak, abs(samples[i])) }
            let peakDb = 20 * log10(Double(max(peak, 1e-9)))
            let ok = f.sampleRate == 48_000 && f.channelCount == 1 && abs(seconds - e.seconds) <= 0.01 && Int(buffer.frameLength) == Int(file.length)
                && peakDb < -2 && peakDb > -30
            check(s, "\(e.rawValue): mono 48 kHz, \(String(format: "%.2f", seconds)) s, peak \(String(format: "%.1f", peakDb)) dBFS", ok,
                  "\(f.sampleRate) Hz ×\(f.channelCount), want \(e.seconds) s, peak under −2 and over −30 dBFS")
        }
        check(s, "all twelve together under 1.5 MB", total > 0 && total < 1_500_000, "\(total) bytes")
    }
}
