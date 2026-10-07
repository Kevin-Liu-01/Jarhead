import AVFoundation
import Foundation

// Throwaway harness for Scripts/earcon-check.sh: the palette (Audio/Earcons.swift), its cues
// (App/EarconCues.swift) and LocalSpeaker's echo rule, pure and through a recorder sink on a scripted
// clock; then every file the app can ask for, opened and decoded. Nothing is played: the recorder
// stands in for the player, and the files are read with AVAudioFile, never handed to an output.

/// Plays nothing: remembers what it was asked to do, and says a sound is playing for as long as the real
/// player would (its length from the start, or to the end of a fade) on the check's scripted clock.
@MainActor
final class RecorderSink: EarconSink {
    var plays: [(Earcon, Float)] = []
    var fades: [(Earcon, Double)] = []
    var stopped = 0
    private var until: [Earcon: Double] = [:]
    private let clock: () -> Double

    init(clock: @escaping () -> Double) { self.clock = clock }

    func load(_ files: [Earcon: URL]) -> [Earcon: Double] {
        var out: [Earcon: Double] = [:]
        for e in files.keys { out[e] = e.seconds }
        return out
    }

    func play(_ e: Earcon, gain: Float) -> Bool {
        plays.append((e, gain))
        until[e] = clock() + e.seconds
        return true
    }

    func fadeOut(_ e: Earcon, over seconds: Double) {
        guard isPlaying(e) else { return }
        fades.append((e, seconds))
        until[e] = min(until[e] ?? 0, clock() + seconds)
    }

    func isPlaying(_ e: Earcon) -> Bool { (until[e] ?? 0) > clock() }

    func stopAll() {
        stopped += 1
        until.removeAll()
    }

    var played: [Earcon] { plays.map(\.0) }
    var faded: [Earcon] { fades.map(\.0) }
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
        let gate = [Earcon.gate("Pop"), Earcon.gate("Glass"), Earcon.gate("Ping"), Earcon.gate("")]
        check(s, "the gate's door: Pop → heard, Glass → awake, anything else → heard", gate == [.heard, .awake, .heard, .heard])
        let files = ["Pop", "Glass", "Ping", "Hero", "Basso"].map(Earcon.named)
        check(s, "a local.say name picks the file: Pop → opened, Glass → chime, Ping → timer, Hero → alarm, unknown → none", files == [.opened, .chime, .timer, .alarm, nil])
        let kinds = ["alarm", "timer", "chime", "nap"].map { Ring.of(kind: $0, name: "Pop") }
        check(s, "the frame's ring decides the ring, whatever the name (an unknown kind is a chime)", kinds == [.alarm, .timer, .chime, .chime])
        let legacy = ["Hero", "Ping", "Glass", "Pop", "Basso"].map { Ring.of(kind: nil, name: $0) }
        check(s, "a daemon before `ring`: the name says it — Hero alarm, Ping timer, Glass chime, Pop an open (no ring), unknown chime",
              legacy == [.alarm, .timer, .chime, nil, .chime] && Ring.of(kind: nil, name: nil) == .chime)
        check(s, "each ring's own file is chime, timer and alarm", Ring.allCases.map(\.earcon) == [.alarm, .timer, .chime])
        let order: [Earcon] = [.alarm, .timer, .chime, .problem, .awake, .snooze, .heard, .cue, .opened, .mark]
        let descending = zip(order, order.dropFirst()).allSatisfy { $0.priority > $1.priority }
        let tied = Earcon.awake.priority == Earcon.sleep.priority && Earcon.sleep.priority == Earcon.pause.priority
        check(s, "priority: alarm > timer > chime > problem > awake · sleep · pause > snooze > heard > cue > opened > mark", descending && tied)
        check(s, "a ring plays at its ring's priority, whichever file it names", EarconModel.priority(.opened, ring: .chime) == Earcon.chime.priority && EarconModel.priority(.opened, ring: nil) == Earcon.opened.priority)
        let lengths = Earcon.allCases.map(\.seconds)
        let ringFiles = Set(Ring.allCases.map(\.earcon))
        let interfaceShort = Earcon.allCases.filter { !ringFiles.contains($0) }.allSatisfy { $0.seconds < 1 }
        check(s, "every sound is short: 0.12–1.6 s, interface sounds under 1 s", lengths.allSatisfy { $0 >= 0.12 && $0 <= 1.6 } && interfaceShort)
    }

    // MARK: - the one gate (pure)

    static func model() {
        let s = "gate"
        var m = EarconModel()
        let t = 1000.0
        check(s, "a session's microphone runs: an interface sound is dropped", m.decide(.heard, now: t, voiceRuns: true, voiceAudibleUntil: 0, requestedAt: t) == .drop(.session))
        check(s, "a ring is dropped in a session too (the voice says the line)", m.decide(.chime, ring: .chime, now: t, voiceRuns: true, voiceAudibleUntil: 0, requestedAt: t) == .drop(.session))
        check(s, "awake plays at the session edge (connecting; the wire hold covers it)", m.decide(.awake, now: t, voiceRuns: true, voiceAudibleUntil: 0, requestedAt: t) == .play(gain: 0.7))
        check(s, "the gate's Glass and the connecting edge are one awake (deduped within 1.5 s)", m.decide(.awake, now: t + 1.0, voiceRuns: true, voiceAudibleUntil: 0, requestedAt: t + 1.0) == .drop(.duplicate))
        check(s, "…and a second awake 1.6 s later plays", m.decide(.awake, now: t + 1.6, voiceRuns: false, voiceAudibleUntil: 0, requestedAt: t + 1.6) == .play(gain: 0.7))

        m = EarconModel()
        m.config = EarconModel.Config(interface: false, volume: 0.5)
        check(s, "Sounds off: an interface sound is dropped", m.decide(.pause, now: t, voiceRuns: false, voiceAudibleUntil: 0, requestedAt: t) == .drop(.off))
        check(s, "Sounds off: the timer still rings at the volume", m.decide(.timer, ring: .timer, now: t, voiceRuns: false, voiceAudibleUntil: 0, requestedAt: t) == .play(gain: 0.5))
        check(s, "Sounds off: a chime that names Pop still rings (the kind decides; the name picks the file)",
              m.decide(.opened, ring: .chime, now: t + 3, voiceRuns: false, voiceAudibleUntil: 0, requestedAt: t + 3) == .play(gain: 0.5))
        check(s, "Sounds off: an open's tink (Pop with no ring) is dropped", m.decide(.opened, now: t + 6, voiceRuns: false, voiceAudibleUntil: 0, requestedAt: t + 6) == .drop(.off))
        m.config.volume = 0
        check(s, "volume 0: the chime is silent", m.decide(.chime, ring: .chime, now: t + 10, voiceRuns: false, voiceAudibleUntil: 0, requestedAt: t + 10) == .drop(.silent))
        let zero = m.decide(.alarm, ring: .alarm, now: t + 20, voiceRuns: false, voiceAudibleUntil: 0, requestedAt: t + 20, automationId: "a")
        check(s, "volume 0 and Sounds off: the alarm still rings, at its floor 0.67", zero == .play(gain: EarconModel.alarmFloor), "\(zero)")
        let glass = m.decide(.chime, ring: .alarm, now: t + 25, voiceRuns: false, voiceAudibleUntil: 0, requestedAt: t + 25, automationId: "g")
        check(s, "an alarm that names Glass rings at the alarm's floor too, never the volume", glass == .play(gain: EarconModel.alarmFloor), "\(glass)")

        var firsts: [Double] = []
        for v in [0.0, 0.4, 0.7, 1.0] {
            var a = EarconModel()
            a.config.volume = v
            if case .play(let g) = a.decide(.alarm, ring: .alarm, now: t, voiceRuns: false, voiceAudibleUntil: 0, requestedAt: t, automationId: "x") { firsts.append(g) }
        }
        check(s, "the alarm's first ring is the same at Volume 0, 40, 70 and 100 %", firsts == [0.67, 0.67, 0.67, 0.67], "\(firsts)")
        let effective = -16.0 + 20 * log10(EarconModel.alarmFloor)
        check(s, "…alarm.caf (−16.0 LUFS) at 0.67 is −19.5 LUFS: level with the system Hero it replaces, never under", near(effective, -19.5, 0.05), "\(effective)")

        m = EarconModel()
        _ = m.decide(.alarm, ring: .alarm, now: t, voiceRuns: false, voiceAudibleUntil: 0, requestedAt: t, automationId: "a")
        check(s, "a lower sound under 250 ms after a higher one is dropped", m.decide(.heard, now: t + 0.1, voiceRuns: false, voiceAudibleUntil: 0, requestedAt: t + 0.1) == .drop(.outranked))
        check(s, "…and plays at 300 ms", m.decide(.heard, now: t + 0.3, voiceRuns: false, voiceAudibleUntil: 0, requestedAt: t + 0.3) == .play(gain: 0.7))
        check(s, "a higher sound right after a lower one plays", m.decide(.timer, ring: .timer, now: t + 0.35, voiceRuns: false, voiceAudibleUntil: 0, requestedAt: t + 0.35) == .play(gain: 0.7))
        check(s, "…and supersedes it: the lower one, 50 ms old, is the one to fade", m.superseded(by: .timer, ring: .timer, now: t + 0.35) == [.heard])
        m.forgetRings()
        check(s, "after Snooze faded the rings, the snooze sound is not outranked", m.decide(.snooze, now: t + 0.4, voiceRuns: false, voiceAudibleUntil: 0, requestedAt: t + 0.4) == .play(gain: 0.7))

        m = EarconModel()
        _ = m.decide(.heard, now: t, voiceRuns: false, voiceAudibleUntil: 0, requestedAt: t)
        check(s, "auth none: heard, then awake 10 ms later — awake plays", m.decide(.awake, now: t + 0.01, voiceRuns: false, voiceAudibleUntil: 0, requestedAt: t + 0.01) == .play(gain: 0.7))
        check(s, "…and supersedes heard", m.superseded(by: .awake, ring: nil, now: t + 0.01) == [.heard])
        check(s, "a lower sound never supersedes a higher one", m.superseded(by: .heard, ring: nil, now: t + 0.02).isEmpty)

        m = EarconModel()
        _ = m.decide(.opened, now: t, voiceRuns: false, voiceAudibleUntil: 0, requestedAt: t)
        check(s, "an open's tink, then a chime that names Pop 0.5 s later: the chime still rings",
              m.decide(.opened, ring: .chime, now: t + 0.5, voiceRuns: false, voiceAudibleUntil: 0, requestedAt: t + 0.5) == .play(gain: 0.7))
        check(s, "…at the chime's priority: a cue 100 ms after it is outranked", m.decide(.cue, now: t + 0.6, voiceRuns: false, voiceAudibleUntil: 0, requestedAt: t + 0.6) == .drop(.outranked))
        check(s, "…and the same chime again within 1.5 s plays once", m.decide(.opened, ring: .chime, now: t + 1.0, voiceRuns: false, voiceAudibleUntil: 0, requestedAt: t + 1.0) == .drop(.duplicate))

        m = EarconModel()
        check(s, "the voice still audible: wait, looking again every 100 ms", m.decide(.sleep, now: t, voiceRuns: false, voiceAudibleUntil: t + 0.5, requestedAt: t) == .wait(until: t + 0.1))
        check(s, "…until its end + 150 ms", m.decide(.sleep, now: t + 0.6, voiceRuns: false, voiceAudibleUntil: t + 0.5, requestedAt: t) == .wait(until: t + 0.65))
        check(s, "…drained by then: it plays", m.decide(.sleep, now: t + 0.65, voiceRuns: false, voiceAudibleUntil: t + 0.5, requestedAt: t) == .play(gain: 0.7))
        check(s, "a flush ends the wait early (the queue's end moves to the flush)", m.decide(.pause, now: t + 5.3, voiceRuns: false, voiceAudibleUntil: t + 5.1, requestedAt: t + 5) == .play(gain: 0.7))
        let drainWait = m.decide(.chime, ring: .chime, now: t + 10, voiceRuns: false, voiceAudibleUntil: t + 12, requestedAt: t + 10)
        let drainDrop = m.decide(.chime, ring: .chime, now: t + 12, voiceRuns: false, voiceAudibleUntil: t + 12.5, requestedAt: t + 10)
        check(s, "a drain still running 2 s after the request drops it (the farewell is protected)", drainWait == .wait(until: t + 10.1) && drainDrop == .drop(.drain))

        m = EarconModel()
        var ramp: [Double] = []
        for i in 0..<6 {
            let at = t + Double(i) * 30
            if case .play(let g) = m.decide(.alarm, ring: .alarm, now: at, voiceRuns: false, voiceAudibleUntil: 0, requestedAt: at, automationId: "wake") { ramp.append((20 * log10(g) * 10).rounded() / 10) }
        }
        check(s, "the alarm's repeats: the floor (−3.5 dB, Hero's level), then −3, −2, −1 dB, then the file's full level", ramp == [-3.5, -3, -2, -1, 0, 0], "\(ramp)")
        let late = m.decide(.alarm, ring: .alarm, now: t + 400, voiceRuns: false, voiceAudibleUntil: 0, requestedAt: t + 400, automationId: "wake")
        check(s, "a ring after a long gap starts the ramp over", late == .play(gain: EarconModel.alarmFloor), "\(late)")
        let other = m.decide(.alarm, ring: .alarm, now: t + 405, voiceRuns: false, voiceAudibleUntil: 0, requestedAt: t + 405, automationId: "other")
        check(s, "the ramp is per row", other == .play(gain: EarconModel.alarmFloor), "\(other)")
        m.quitting = true
        check(s, "quitting: nothing starts", m.decide(.chime, ring: .chime, now: t + 900, voiceRuns: false, voiceAudibleUntil: 0, requestedAt: t + 900) == .drop(.quitting))
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
        w.note(.heard, start: 100, duration: 0.18, latency: 0.01, bluetooth: false, holdsWire: false)
        check(s, "heard never holds the wire", !w.holdsWire(at: 100.05))
        check(s, "…but its audible window is kept for the wake listener", near(w.audibleUntil, 100.19) && near(w.endsAt, 100.18))
        w.note(.awake, start: 200, duration: 0.42, latency: 0.01, bluetooth: false, holdsWire: true)
        check(s, "awake holds the wire until its tail has passed", w.holdsWire(at: 200.5) && w.holdsWire(at: 200.739) && !w.holdsWire(at: 200.741))
        let chunks = (0..<10).map { w.judgeChunk(at: 200.05 + Double($0) * 0.1, seconds: 0.1) }
        check(s, "seven 100 ms chunks are zero-filled, then the wire is open", chunks == [true, true, true, true, true, true, true, false, false, false], "\(chunks)")
        check(s, "the holds are counted for `jarhead status`", w.counters.holds == 7 && near(w.counters.heldSeconds, 0.7))
        w.resetCounters()
        check(s, "the counters start over with the graph", w.counters == EarconWire.Stats())

        let v = EarconWire()
        v.note(.alarm, start: 300, duration: 1.6, latency: 0.01, bluetooth: false, holdsWire: false)
        v.note(.awake, start: 300.1, duration: 0.42, latency: 0.01, bluetooth: false, holdsWire: true)
        v.cut([.alarm], at: 300.22)
        check(s, "a fade (Snooze, Done) ends only the faded sound's window", near(v.endsAt, 300.52) && near(v.audibleUntil, 300.53), "ends \(v.endsAt)")
        check(s, "…and never shortens awake's hold", near(v.holdUntil, 300.84), "\(v.holdUntil)")
        v.cut([.awake], at: 300.2)
        check(s, "…not even when awake itself is cut", near(v.holdUntil, 300.84) && near(v.endsAt, 300.22))

        let x = EarconWire()
        x.note(.alarm, start: 500, duration: 1.6, latency: 0.01, bluetooth: false, holdsWire: false)
        check(s, "a ring alone never holds the wire", !x.holdsWire(at: 500.2))
        x.cut([.alarm], at: 500.25)
        let held = x.holdSounding()
        check(s, "the session's edge at +0.2 s: the wire is held through the 50 ms fade, the latency and the guard's tail", near(held, 500.25 + 0.01 + 0.31), "\(held)")
        let y = EarconWire()
        y.note(.chime, start: 10, duration: 1.4, latency: 0.01, bluetooth: false, holdsWire: false)
        y.holdSounding()
        check(s, "…a sound long over holds nothing now", !y.holdsWire(at: 100))
        let z = EarconWire()
        z.note(.awake, start: 600, duration: 0.42, latency: 0.01, bluetooth: false, holdsWire: true)
        z.cutAll(at: 600.1)
        check(s, "quitting ends every window and the hold", !z.holdsWire(at: 600.2) && near(z.endsAt, 600.1))

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

        let intoVoice = [EarconCues.entersVoice(from: .asleep, to: .connecting), EarconCues.entersVoice(from: .paused, to: .connecting),
                         EarconCues.entersVoice(from: .error, to: .connecting), EarconCues.entersVoice(from: .asleep, to: .listening)]
        check(s, "the edge into the mic's phases: asleep, paused or error → connecting, and asleep → listening (a skipped snapshot)", intoVoice == [true, true, true, true])
        let notInto = [EarconCues.entersVoice(from: .connecting, to: .listening), EarconCues.entersVoice(from: .listening, to: .asleep),
                       EarconCues.entersVoice(from: .asleep, to: .paused), EarconCues.entersVoice(from: .asleep, to: .asleep)]
        check(s, "…not inside a session, not out of one, not between quiet phases", notInto == [false, false, false, false])

        var hold = EarconCues.LocalSayHold()
        let tea = LocalSayMessage(sound: "Ping", ring: "timer", automationId: "tea")
        check(s, "local.say asleep: it plays", hold.arrive(tea, phase: .asleep, now: 0) == .play)
        check(s, "…in a session: dropped (the voice says the fire's lines)", hold.arrive(tea, phase: .listening, now: 0) == .drop)
        check(s, "…connecting: held, not lost", hold.arrive(tea, phase: .connecting, now: 1) == .hold && hold.held.count == 1)
        check(s, "…still connecting: nothing yet", hold.settle(phase: .connecting, now: 2).isEmpty && hold.held.count == 1)
        check(s, "…the handshake failed (error): it plays then", hold.settle(phase: .error, now: 3) == [tea] && hold.held.isEmpty)
        _ = hold.arrive(tea, phase: .connecting, now: 10)
        check(s, "…a session opened: dropped, the voice has it", hold.settle(phase: .listening, now: 11).isEmpty && hold.held.isEmpty)
        _ = hold.arrive(tea, phase: .connecting, now: 20)
        check(s, "…older than 30 s when the phase settles: dropped", hold.settle(phase: .asleep, now: 51).isEmpty && hold.held.isEmpty)

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
        var clock = 10_000.0
        let rec = RecorderSink(clock: { clock })
        let wire = EarconWire()
        let earcons = Earcons(sink: rec, wire: wire)
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

        if let sounds {
            let loaded = earcons.load(directory: URL(fileURLWithPath: sounds, isDirectory: true))
            check(s, "every sound is found in \(sounds)", loaded == Set(Earcon.allCases), "missing \(Set(Earcon.allCases).subtracting(loaded).map(\.rawValue).sorted())")
        }
        check(s, "nothing loads from nowhere", earcons.load(directory: nil).isEmpty)

        earcons.play(.awake)
        advance(0.2)
        earcons.play(.awake)
        check(s, "grant then the connecting edge: one awake at 70 %", rec.played == [.awake] && rec.plays.first?.1 == 0.7)
        check(s, "awake holds the wire past its own end", wire.holdsWire(at: clock + 0.4) && !wire.holdsWire(at: clock + 0.6))

        runs = true
        advance(5)
        earcons.play(.cue)
        earcons.ring("Glass", kind: "chime", automationId: "r1")
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
        earcons.ring("Hero", kind: "alarm", automationId: "wake")
        let alarmGain = Double(rec.plays.last?.1 ?? 0)
        check(s, "an alarm rings at its floor 0.67 at the default 70 %", rec.played.last == .alarm && abs(alarmGain - EarconModel.alarmFloor) < 1e-4, "\(alarmGain)")
        advance(0.5)
        let sounded = earcons.fadeRings(for: "wake")
        if sounded { earcons.play(.snooze) }
        check(s, "Snooze fades the sounding alarm over 120 ms and plays the snooze sound", sounded && rec.faded == [.alarm] && rec.fades.last?.1 == Earcons.ringFade && rec.played.last == .snooze)
        check(s, "a row that never rang gets no snooze sound", !earcons.fadeRings(for: "never"))
        advance(700)
        check(s, "a ring older than the 10-minute linger gets none either", !earcons.fadeRings(for: "wake"))

        earcons.configure(interface: false, volume: 0.5)
        advance(5)
        earcons.play(.mark)
        earcons.ring("Ping", kind: "timer", automationId: "tea")
        check(s, "Sounds off: the mark is silent, the timer rings at 50 %", rec.played.last == .timer && rec.plays.last?.1 == 0.5 && !rec.played.contains(.mark))
        advance(2)
        earcons.ring("Pop", kind: "chime", automationId: "pop")
        check(s, "Sounds off: a chime that names Pop rings (the opened file, at 50 %)", rec.played.last == .opened && rec.plays.last?.1 == 0.5)
        advance(2)
        let tink = earcons.ring("Pop", kind: nil, automationId: "open")
        check(s, "Sounds off: an open's tink (Pop, no ring) is silent", tink == .drop(.off))
        advance(2)
        earcons.configure(interface: false, volume: 0)
        earcons.ring("Glass", kind: "alarm", automationId: "glass-alarm")
        let glassGain = Double(rec.plays.last?.1 ?? 0)
        check(s, "Volume 0 and Sounds off: an alarm that names Glass rings the chime file at the alarm's floor", rec.played.last == .chime && abs(glassGain - EarconModel.alarmFloor) < 1e-4, "\(glassGain)")
        let snoozedGlass = earcons.fadeRings(for: "glass-alarm")
        check(s, "…and Snooze fades it like any ring", snoozedGlass && rec.faded.last == .chime)
        earcons.configure(interface: true, volume: 0.7)
        advance(5)
        earcons.play(.heard)
        check(s, "the wake listener waits out the sound (LocalSpeaker.isQuiet)",
              !LocalSpeaker.isQuiet(speaking: false, lastFinishedAt: .distantPast, earconAudibleUntil: earcons.audibleUntil, now: Date(timeIntervalSinceReferenceDate: clock + 0.3)))

        // auth none: the gate's heard, then its awake at once — heard gives way.
        advance(5)
        earcons.play(.heard)
        advance(0.01)
        earcons.play(.awake)
        check(s, "auth none: heard, then awake 10 ms later — heard fades over 50 ms under it",
              Array(rec.played.suffix(2)) == [.heard, .awake] && rec.faded.last == .heard && rec.fades.last?.1 == Earcons.quickFade)
        check(s, "…and the line after it waits only for awake's tail", near(wire.endsAt, clock + 0.42))

        // The session's edge: an alarm ringing, then Go (or the notch) 0.2 s in.
        advance(5)
        earcons.ring("Hero", kind: "alarm", automationId: "edge")
        advance(0.2)
        runs = true
        let faded = earcons.enterVoice()
        let edgeHold = wire.holdUntil
        check(s, "connecting 0.2 s into an alarm: the alarm fades over 50 ms", faded == [.alarm] && rec.faded.last == .alarm && rec.fades.last?.1 == Earcons.quickFade)
        check(s, "…and the wire is held through the fade and the guard's tail before awake asks (+0.37 s)", near(edgeHold, clock + 0.05 + 0.01 + 0.31), "\(edgeHold - clock)")
        earcons.play(.awake)
        let awakeAt = clock
        check(s, "…then awake plays: the faded alarm outranks nothing", rec.played.last == .awake)
        check(s, "…and the hold is the later of the two (awake's +0.74 s)", near(wire.holdUntil, awakeAt + 0.74), "\(wire.holdUntil - awakeAt)")
        advance(0.1)
        check(s, "…awake itself never fades at the edge", earcons.enterVoice().isEmpty && near(wire.holdUntil, awakeAt + 0.74))

        // A timer that rang 100 ms before connecting: under the 250 ms that used to drop awake and leave no hold.
        runs = false
        advance(5)
        earcons.ring("Ping", kind: "timer", automationId: "t2")
        advance(0.1)
        runs = true
        let early = earcons.enterVoice()
        check(s, "a ring 100 ms before connecting: faded, and the wire held with no awake at all", early == [.timer] && near(wire.holdUntil, clock + 0.37), "\(wire.holdUntil - clock)")
        earcons.play(.awake)
        check(s, "…awake still plays and holds its own window", rec.played.last == .awake && near(wire.holdUntil, clock + 0.74))

        // The gate's grant over a ringing alarm, then Snooze inside awake's hold: the ring's window ends, the hold stays.
        runs = false
        advance(5)
        earcons.ring("Hero", kind: "alarm", automationId: "grant")
        advance(0.3)
        earcons.play(.awake)
        let grantHold = wire.holdUntil
        earcons.fadeRings(for: "grant")
        check(s, "Snooze or Done inside awake's hold fades the ring and never shortens the hold",
              rec.faded.last == .alarm && wire.holdUntil == grantHold && near(grantHold, clock + 0.74), "\(wire.holdUntil - clock)")

        // Retry from error: no awake on that edge, the problem sound still ringing.
        runs = false
        advance(5)
        earcons.play(.problem)
        advance(0.1)
        runs = true
        let retry = earcons.enterVoice()
        check(s, "Retry 0.1 s into the problem sound (error → connecting has no awake): it fades and the wire is held",
              retry == [.problem] && wire.holdsWire(at: clock + 0.3) && !wire.holdsWire(at: clock + 0.4))

        // A sound waiting for the voice's drain at the edge is dropped, and never plays later.
        runs = false
        advance(5)
        let before = rec.plays.count
        voiceUntil = clock + 0.4
        earcons.play(.sleep)
        runs = true
        earcons.enterVoice()
        runs = false
        voiceUntil = 0
        for _ in 0..<10 { advance(0.1) }
        check(s, "a sound waiting for the drain at the edge is dropped, never played later", rec.plays.count == before)

        earcons.silence()
        advance(5)
        earcons.ring("Hero", kind: "alarm", automationId: "late")
        check(s, "quitting: everything stops and nothing new starts", rec.stopped == 1 && rec.plays.count == before)
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
