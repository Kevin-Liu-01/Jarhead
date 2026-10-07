import AVFoundation
import CoreAudio
import Foundation

// The palette (docs/AUDIO.md § The sounds): twelve short sounds, a soft felt mallet on a small crystal
// glass over a rosewood bar, every note in D major pentatonic. Rising means "he's with you", falling
// "he's let go", a low B-minor fall "something needs you". Interface sounds sit at −30…−24 LUFS, the
// rings that reach across a room at −20…−16.
//
// Rule zero: no sound plays while the session's microphone runs. A sound played here is not in the
// voice-processing unit's echo reference, so the mic would hear it at full level and Live could take
// it for a turn. `awake` is the one exception: it plays at the edge into `connecting`, before the
// graph's first tap buffer, and the wire stays zero-filled until it has passed (`EarconWire`). At that
// edge anything else still sounding fades out over 50 ms and the wire is held through it too
// (`Earcons.enterVoice`), so a ring that started just before Go never reaches Live either.
//
// This file compiles with Audio/ alone (the duck, leak, playout and recorder probes): the phase rules
// that need `Phase` live in App/EarconCues.swift, and the app hands `Earcons` a `voiceRuns` closure.

/// One sound of the palette; the raw value is the file's name in `Resources/Sounds/<name>.caf`.
enum Earcon: String, CaseIterable, Sendable {
    case heard, awake, pause, sleep, chime, timer, alarm, snooze, opened, mark, cue, problem

    /// The length each file is cut to; `earcon-check.sh` pins every file to it (± 10 ms).
    var seconds: Double {
        switch self {
        case .heard: return 0.18
        case .awake: return 0.42
        case .pause: return 0.32
        case .sleep: return 0.85
        case .chime: return 1.40
        case .timer: return 1.30
        case .alarm: return 1.60
        case .snooze: return 0.55
        case .opened: return 0.14
        case .mark: return 0.12
        case .cue: return 0.30
        case .problem: return 0.50
        }
    }

    /// One at a time: alarm > timer > chime > problem > awake · sleep · pause > snooze > heard > cue > opened > mark.
    /// A sound played as a ring takes its ring's priority instead (`Ring.priority`), whichever file it plays.
    var priority: Int {
        switch self {
        case .alarm: return 10
        case .timer: return 9
        case .chime: return 8
        case .problem: return 7
        case .awake, .sleep, .pause: return 6
        case .snooze: return 5
        case .heard: return 4
        case .cue: return 3
        case .opened: return 2
        case .mark: return 1
        }
    }

    /// The wake gate's door (`WakeSpeaking.earcon`; WakeGate itself is untouched): the gate's `Pop` is
    /// `heard`, its `Glass` is `awake`. Anything else the gate names is `heard`.
    static func gate(_ name: String) -> Earcon { name == "Glass" ? .awake : .heard }

    /// The file a `local.say` sound names, in the protocol's names: `Pop` the opened tink, `Glass` the chime,
    /// `Ping` the timer, `Hero` the alarm; nil for a name the app does not know.
    static func named(_ name: String) -> Earcon? {
        switch name {
        case "Pop": return .opened
        case "Glass": return .chime
        case "Ping": return .timer
        case "Hero": return .alarm
        default: return nil
        }
    }

    static let directory = "Sounds"
    static let fileExtension = "caf"
}

/// What a `local.say` rings for: the frame's `ring`, the automation's kind as the engine set it. The kind, not
/// the sound's name, makes it a ring: it sounds with Settings › Audio › Sounds off, Snooze and Done fade it,
/// and an alarm keeps its own level and ramp whatever the Volume says. The name only picks the file.
enum Ring: String, CaseIterable, Sendable {
    case alarm, timer, chime

    var priority: Int { earcon.priority }

    /// The file when the frame names no sound, or one the app does not know.
    var earcon: Earcon {
        switch self {
        case .alarm: return .alarm
        case .timer: return .timer
        case .chime: return .chime
        }
    }

    /// `kind` the frame's `ring` (an unknown kind from a newer daemon is a chime). A daemon before `ring` sends
    /// none: the name says it, as it did — `Hero` an alarm, `Ping` a timer, `Pop` an open (no ring), else a chime.
    static func of(kind: String?, name: String?) -> Ring? {
        if let kind { return Ring(rawValue: kind) ?? .chime }
        switch name {
        case "Pop": return nil
        case "Ping": return .timer
        case "Hero": return .alarm
        default: return .chime
        }
    }
}

// MARK: - The decision (pure, pinned by earcon-check)

/// Whether a sound plays now, waits for the voice's playout to drain, or is dropped — and at what gain.
/// No AVFoundation and no clock of its own: every input is an argument.
struct EarconModel: Equatable {
    struct Config: Equatable {
        /// Settings › Audio › Sounds: the interface sounds. Rings sound either way.
        var interface = true
        /// Settings › Audio › Volume, 0…1, times the system's own output volume (never read or changed here).
        /// The alarm ignores it (`gainFor`).
        var volume = 0.7
    }

    enum Decision: Equatable {
        case play(gain: Double)
        /// The voice still has audible output queued: try again at `until` (its end + 150 ms, or the next
        /// 100 ms poll, whichever is sooner: a flush or the graph's stop can end the queue early).
        case wait(until: Double)
        case drop(Reason)
    }

    enum Reason: String, Equatable {
        /// The session's microphone runs (asleep, paused and error are the only quiet phases).
        case session
        /// Sounds are off and this is an interface sound.
        case off
        /// The volume is zero.
        case silent
        /// The same sound started under 1.5 s ago (the gate's Glass and the connecting edge are one `awake`).
        case duplicate
        /// A higher-priority sound started under 250 ms ago.
        case outranked
        /// The voice's playout did not drain within 2 s of the request (the farewell "night." is protected).
        case drain
        /// The app is quitting.
        case quitting
    }

    /// A start the gate allowed: when, at what priority, and whether it rang (and for what).
    struct Started: Equatable {
        var at: Double
        var priority: Int
        var ring: Ring?
    }

    struct AlarmRing: Equatable {
        var count: Int
        var at: Double
    }

    static let dedupeSeconds = 1.5
    static let outrankSeconds = 0.25
    static let drainPad = 0.15
    static let drainMax = 2.0
    static let drainPoll = 0.1
    /// The alarm's ramp: its first ring is 4 dB under the file's own level, each repeat (every 30 s) 1 dB louder, up to 0 dB.
    static let alarmStartDb = -4.0
    /// A repeat further apart than this starts the ramp over (the engine re-rings every 30 s).
    static let alarmRepeatWindow = 45.0
    /// The alarm never plays under this, applied after the ramp: alarm.caf is −16.0 LUFS and the system's Hero,
    /// which NSSound played at full level before the palette, −19.5; 10^(−3.5/20) ≈ 0.67 puts the first ring
    /// level with it, never under. Measured offline with ffmpeg's ebur128 (re-measure if the file changes).
    static let alarmFloor = 0.67
    static let defaultVolume = 0.7

    var config = Config()
    var quitting = false
    /// When each sound last started (a decision to play), for the dedupe and the priorities.
    var lastStart: [Earcon: Started] = [:]
    /// The alarm's ramp, per automation row.
    var alarmRings: [String: AlarmRing] = [:]

    /// The priority `e` plays at: its ring's, when it rings, else its own.
    static func priority(_ e: Earcon, ring: Ring?) -> Int { ring?.priority ?? e.priority }

    /// `ring`: what a `local.say` rings for (nil for every other sound). `voiceRuns`: the session's microphone runs
    /// (`AppState.voiceAudioRuns(in:)`). `voiceAudibleUntil`: when the voice's queued audible output ends (0 = nothing
    /// queued). `requestedAt`: when the sound was first asked for, so a wait never stretches past `drainMax`.
    mutating func decide(_ e: Earcon, ring: Ring? = nil, now: Double, voiceRuns: Bool, voiceAudibleUntil: Double, requestedAt: Double, automationId: String? = nil) -> Decision {
        if quitting { return .drop(.quitting) }
        // `awake` is the session-edge sound: it is asked for only at the edge, before the graph starts,
        // and the wire hold covers it. Everything else waits for a phase with no microphone.
        if voiceRuns && e != .awake { return .drop(.session) }
        if !config.interface && ring == nil { return .drop(.off) }
        let gain = gainFor(e, ring: ring, now: now, automationId: automationId)
        if gain <= 0 { return .drop(.silent) }
        let priority = EarconModel.priority(e, ring: ring)
        // The same file again within 1.5 s plays once — unless this one rings and that one did not (an open's tink, then a chime that names Pop).
        if let last = lastStart[e], now - last.at < EarconModel.dedupeSeconds, last.priority >= priority { return .drop(.duplicate) }
        for (_, s) in lastStart where s.priority > priority && now - s.at >= 0 && now - s.at < EarconModel.outrankSeconds {
            return .drop(.outranked)
        }
        let ready = voiceAudibleUntil + EarconModel.drainPad
        if now < ready {
            if now - requestedAt >= EarconModel.drainMax { return .drop(.drain) }
            return .wait(until: min(ready, now + EarconModel.drainPoll, requestedAt + EarconModel.drainMax))
        }
        lastStart[e] = Started(at: now, priority: priority, ring: ring)
        if ring == .alarm, let id = automationId { noteAlarm(id, now: now) }
        return .play(gain: gain)
    }

    /// The volume; an alarm's ramp and floor instead (the Volume knob never makes an alarm quieter).
    func gainFor(_ e: Earcon, ring: Ring?, now: Double, automationId: String?) -> Double {
        guard ring == .alarm else { return min(1, max(0, config.volume.isFinite ? config.volume : EarconModel.defaultVolume)) }
        let ramp = min(0, EarconModel.alarmStartDb + Double(alarmRepeats(automationId, now: now)))
        return max(EarconModel.alarmFloor, pow(10, ramp / 20))
    }

    /// How many rings of this row came before this one inside the repeat window (0 = the first).
    func alarmRepeats(_ id: String?, now: Double) -> Int {
        guard let id, let ring = alarmRings[id], now - ring.at < EarconModel.alarmRepeatWindow else { return 0 }
        return ring.count + 1
    }

    private mutating func noteAlarm(_ id: String, now: Double) {
        alarmRings[id] = AlarmRing(count: alarmRepeats(id, now: now), at: now)
    }

    /// The sounds a start of `e` supersedes: lower priority, started under `outrankSeconds` before it (the gate's
    /// `heard`, then `awake` at once when the wake needs no authentication). The front door fades those still sounding.
    func superseded(by e: Earcon, ring: Ring?, now: Double) -> [Earcon] {
        let priority = EarconModel.priority(e, ring: ring)
        let lower = lastStart.filter { $0.key != e && $0.value.priority < priority && now - $0.value.at >= 0 && now - $0.value.at < EarconModel.outrankSeconds }
        return lower.keys.sorted { $0.rawValue < $1.rawValue }
    }

    /// Snooze and Done faded the rings: they no longer outrank what comes next (the snooze sound).
    mutating func forgetRings() {
        lastStart = lastStart.filter { $0.value.ring == nil }
    }

    /// These were faded out (a session's edge, a higher sound): they no longer outrank or dedupe anything.
    mutating func forget(_ sounds: Set<Earcon>) {
        for e in sounds { lastStart[e] = nil }
    }
}

// MARK: - The wire hold and the echo window (any thread)

/// Each sound's window — when its samples end, and when it stops being audible — and until when the
/// microphone's wire chunks are zero-filled: `awake`'s own window plus the echo guard's tail, and at the
/// edge into a session whatever else was still sounding, faded, plus its tail (`holdSounding`). Read on
/// the tap thread (`AudioEngine.handleMic`), the main thread (`LocalSpeaker.isQuiet`, `speak`) and the
/// reader's queue (the counters), so one lock.
final class EarconWire: @unchecked Sendable {
    static let shared = EarconWire()

    struct Stats: Equatable {
        /// Wire chunks zero-filled because an earcon was audible, and their seconds.
        var holds = 0
        var heldSeconds = 0.0
    }

    /// One sound's last start: its samples end at `ends`, it is audible until `ends + latency`, and its echo
    /// in the room has passed `tail` after that (`EchoGuardModel.tail` for the output it played on).
    private struct Window {
        var ends: Double
        var latency: Double
        var tail: Double
    }

    private let lock = NSLock()
    private var windows: [Earcon: Window] = [:]
    private var holdUntilValue = 0.0
    private var stats = Stats()

    /// `audibleUntil + tail`: the guard's own tail (`EchoGuardModel.tail`), the output latency counted in both.
    static func holdUntil(start: Double, duration: Double, latency: Double, bluetooth: Bool) -> Double {
        let l = latency.isFinite ? max(0, latency) : 0
        return start + duration + l + EchoGuardModel.tail(latency: l, bluetooth: bluetooth)
    }

    /// `e` started at `start` (CFAbsoluteTime) and lasts `duration`; `holdsWire` for `awake`.
    func note(_ e: Earcon, start: Double, duration: Double, latency: Double, bluetooth: Bool, holdsWire: Bool) {
        let l = latency.isFinite ? max(0, latency) : 0
        lock.lock()
        windows[e] = Window(ends: start + duration, latency: l, tail: EchoGuardModel.tail(latency: l, bluetooth: bluetooth))
        if holdsWire { holdUntilValue = max(holdUntilValue, EarconWire.holdUntil(start: start, duration: duration, latency: l, bluetooth: bluetooth)) }
        lock.unlock()
    }

    /// `sounds` faded out by `at` (Snooze, Done, a session's edge, a higher sound): their samples end then.
    /// Only their windows move; a wire hold already set (awake's, the edge's) is never shortened.
    func cut(_ sounds: Set<Earcon>, at: Double) {
        lock.lock()
        for e in sounds {
            guard var w = windows[e] else { continue }
            w.ends = min(w.ends, at)
            windows[e] = w
        }
        lock.unlock()
    }

    /// Quitting: every sound stopped at `at`, and the wire held no longer (the graph stops with the app).
    func cutAll(at: Double) {
        lock.lock()
        for (e, w) in windows { windows[e] = Window(ends: min(w.ends, at), latency: w.latency, tail: w.tail) }
        holdUntilValue = min(holdUntilValue, at)
        lock.unlock()
    }

    /// The edge into a session (`Earcons.enterVoice`): the wire is held until every sound's echo has passed —
    /// its end, plus its output's latency, plus the guard's tail. A sound long over adds nothing (its end is
    /// behind `now`). Returns the hold.
    @discardableResult
    func holdSounding() -> Double {
        lock.lock(); defer { lock.unlock() }
        for w in windows.values { holdUntilValue = max(holdUntilValue, w.ends + w.latency + w.tail) }
        return holdUntilValue
    }

    /// When the last sound's samples end (a spoken line may start 50 ms before this).
    var endsAt: Double {
        lock.lock(); defer { lock.unlock() }
        return windows.values.map(\.ends).max() ?? 0
    }

    /// When the last sound stops being audible (its end plus the output latency).
    var audibleUntil: Double {
        lock.lock(); defer { lock.unlock() }
        return windows.values.map { $0.ends + $0.latency }.max() ?? 0
    }

    /// Until when the wire is held (0 = never held).
    var holdUntil: Double {
        lock.lock(); defer { lock.unlock() }
        return holdUntilValue
    }

    /// The wire is held at `now`: `awake` (or what the edge faded) was audible, or its tail has not passed.
    func holdsWire(at now: Double) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return now < holdUntilValue
    }

    /// The tap's verdict for one wire chunk (`seconds` long) captured at `now`; counts the holds.
    func judgeChunk(at now: Double, seconds: Double) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard now < holdUntilValue else { return false }
        stats.holds += 1
        if seconds.isFinite, seconds > 0 { stats.heldSeconds += seconds }
        return true
    }

    /// The counters since the graph started (the `awake held` figure in `jarhead status`).
    var counters: Stats {
        lock.lock(); defer { lock.unlock() }
        return stats
    }

    func resetCounters() {
        lock.lock()
        stats = Stats()
        lock.unlock()
    }

    /// Harnesses: forget every window.
    func resetForHarness() {
        lock.lock()
        windows.removeAll()
        holdUntilValue = 0
        stats = Stats()
        lock.unlock()
    }
}

/// The voice's own playout, as the speaker scheduled it: when its last audible sample will have played.
/// Noted on the audio queue (`AudioEngine.noteSpeaker`, `flush`, the stop), read on main by `Earcons`
/// (the drain rule: a sound never starts over Jarhead's voice, the farewell "night." included).
final class VoiceOutputClock: @unchecked Sendable {
    static let shared = VoiceOutputClock()

    private let lock = NSLock()
    private var queueEnd = 0.0
    private var audibleUntilValue = 0.0

    /// `seconds` of output at `rms`, queued behind whatever still plays (silence between sentences arms nothing).
    func noteOutput(rms: Double, seconds: Double, now: Double = CFAbsoluteTimeGetCurrent()) {
        guard seconds.isFinite, seconds > 0 else { return }
        lock.lock()
        queueEnd = max(queueEnd, now) + seconds
        if rms >= EchoGuardModel.audibleOutput { audibleUntilValue = queueEnd }
        lock.unlock()
    }

    /// The backlog was dropped (a flush, the graph's stop): nothing queued is audible any more.
    func noteFlush(now: Double = CFAbsoluteTimeGetCurrent()) {
        lock.lock()
        queueEnd = min(queueEnd, now)
        audibleUntilValue = min(audibleUntilValue, now)
        lock.unlock()
    }

    var audibleUntil: Double {
        lock.lock(); defer { lock.unlock() }
        return audibleUntilValue
    }
}

/// The default output's latency and transport, read once per sound (HAL reads on main, a few µs each).
enum EarconOutput {
    struct Facts: Equatable {
        var latency: Double
        var bluetooth: Bool
    }

    static func defaultFacts() -> Facts {
        guard let id = CoreAudioReads.defaultDevice(kAudioHardwarePropertyDefaultOutputDevice) else { return Facts(latency: 0, bluetooth: false) }
        let bluetooth = MicInput.transportName(CoreAudioReads.transport(id)) == "bluetooth"
        return Facts(latency: latency(id), bluetooth: bluetooth)
    }

    /// (device latency + safety offset + buffer) / rate on the output scope, clamped to 0…0.5 s.
    static func latency(_ id: AudioDeviceID) -> Double {
        func read(_ selector: AudioObjectPropertySelector) -> UInt32 {
            var value: UInt32 = 0
            var size = UInt32(MemoryLayout<UInt32>.size)
            var addr = CoreAudioReads.address(selector, scope: kAudioObjectPropertyScopeOutput)
            guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value) == noErr else { return 0 }
            return value
        }
        let rate = CoreAudioReads.nominalRate(id)
        guard rate > 0 else { return 0 }
        let frames = Double(read(kAudioDevicePropertyLatency)) + Double(read(kAudioDevicePropertySafetyOffset)) + Double(read(kAudioDevicePropertyBufferFrameSize))
        return min(0.5, max(0, frames / rate))
    }
}

// MARK: - The sink: what actually makes the sound

/// Plays the files. `PlayerSink` in the app (one `AVAudioPlayer` per sound); a recorder in the check,
/// which plays nothing (the AUDIO_PROBE_PLAY rule: nothing an agent runs makes a sound).
@MainActor
protocol EarconSink: AnyObject {
    /// Load and prepare every file found; returns each loaded sound's duration in seconds.
    func load(_ files: [Earcon: URL]) -> [Earcon: Double]
    /// From the top at `gain` (0…1, times the system volume); false when the sound is not loaded.
    func play(_ e: Earcon, gain: Float) -> Bool
    /// Fade a sounding sound to silence over `seconds`, then stop it.
    func fadeOut(_ e: Earcon, over seconds: Double)
    func isPlaying(_ e: Earcon) -> Bool
    func stopAll()
}

/// One `AVAudioPlayer` per sound, prepared at launch: the system default output at the system volume
/// times the gain. Never the voice's `AVAudioEngine`, its player node, the duck or the echo guard, and
/// never a pinned device. Not `NSSound` (no preload, no duration, no latency control) and not a second
/// `AVAudioEngine` (another default-device aggregate, the −10875 history).
@MainActor
final class PlayerSink: EarconSink {
    private var players: [Earcon: AVAudioPlayer] = [:]
    private var files: [Earcon: URL] = [:]
    /// The default output each player was prepared on: after a switch (AirPods in) it is prepared again.
    private var preparedOn: [Earcon: AudioDeviceID] = [:]
    /// Bumped by every play, so a fade's late stop never cuts the next ring.
    private var generation: [Earcon: Int] = [:]

    func load(_ files: [Earcon: URL]) -> [Earcon: Double] {
        var out: [Earcon: Double] = [:]
        for (e, url) in files {
            guard let p = prepare(e, url) else { continue }
            self.files[e] = url
            out[e] = p.duration
        }
        return out
    }

    private func prepare(_ e: Earcon, _ url: URL) -> AVAudioPlayer? {
        guard let p = try? AVAudioPlayer(contentsOf: url) else { return nil }
        p.prepareToPlay()
        players[e] = p
        preparedOn[e] = CoreAudioReads.defaultDevice(kAudioHardwarePropertyDefaultOutputDevice)
        return p
    }

    func play(_ e: Earcon, gain: Float) -> Bool {
        if let url = files[e], players[e]?.isPlaying != true,
           preparedOn[e] != CoreAudioReads.defaultDevice(kAudioHardwarePropertyDefaultOutputDevice) {
            _ = prepare(e, url)
        }
        guard let p = players[e] else { return false }
        generation[e, default: 0] += 1
        if p.isPlaying { p.stop() }
        p.currentTime = 0
        p.volume = max(0, min(1, gain))
        return p.play()
    }

    func fadeOut(_ e: Earcon, over seconds: Double) {
        guard let p = players[e], p.isPlaying else { return }
        p.setVolume(0, fadeDuration: seconds)
        let gen = generation[e, default: 0]
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.generation[e, default: 0] == gen else { return }
                self.players[e]?.stop()
            }
        }
    }

    func isPlaying(_ e: Earcon) -> Bool { players[e]?.isPlaying ?? false }

    func stopAll() {
        for p in players.values where p.isPlaying { p.stop() }
    }
}

// MARK: - The front door

/// The app's sound player: the one gate (`EarconModel`), the wire hold, the files. Main actor.
/// `voiceRuns` and `now` are installed by the app (and by the check, with a scripted clock).
@MainActor
final class Earcons {
    static let shared = Earcons(sink: PlayerSink())

    /// Snooze and Done fade a sounding ring out over this long.
    static let ringFade = 0.12
    /// The edge into a session fades whatever still sounds (but `awake`) over this long, and so does a
    /// higher sound starting on top of a lower one (`EarconModel.superseded`).
    static let quickFade = 0.05
    /// A request waiting for the voice's drain; a newer request of the same sound replaces it.
    private struct Pending {
        var requestedAt: Double
        var ring: Ring?
        var automationId: String?
    }

    private let sink: EarconSink
    let wire: EarconWire
    private(set) var model = EarconModel()
    /// Each loaded sound's length (the palette's figure until a file says otherwise).
    private(set) var durations: [Earcon: Double] = [:]
    private var pending: [Earcon: Pending] = [:]
    /// The files whose last start rang (Snooze and Done fade these, whichever file a ring named).
    private var ringFiles: Set<Earcon> = []
    /// When each automation row's ring last sounded (Snooze's sound needs one inside the linger window).
    private var ringSounded: [String: Double] = [:]

    /// `AppState.voiceAudioRuns(in: phase)` at the phase the app last saw.
    var voiceRuns: () -> Bool = { false }
    var now: () -> Double = { CFAbsoluteTimeGetCurrent() }
    /// When the voice's audible playout ends (`VoiceOutputClock`).
    var voiceAudibleUntil: () -> Double = { VoiceOutputClock.shared.audibleUntil }
    var output: () -> EarconOutput.Facts = { EarconOutput.defaultFacts() }
    /// How a wait is scheduled (the check fires them by hand).
    var schedule: (Double, @escaping @MainActor () -> Void) -> Void = { delay, work in
        DispatchQueue.main.asyncAfter(deadline: .now() + max(0, delay)) { MainActor.assumeIsolated { work() } }
    }
    /// Every play and drop, and the first wait of a request, for the app's log (`earcon: awake play(gain: 0.7)`).
    var onDecision: ((Earcon, EarconModel.Decision) -> Void)?

    /// The engine's linger: a ring older than this is not "sounding" for Snooze.
    static let ringLinger = 600.0

    init(sink: EarconSink, wire: EarconWire = .shared) {
        self.sink = sink
        self.wire = wire
    }

    /// Every `<name>.caf` found in `directory` (the bundle's `Contents/Resources/Sounds`; from a `swift build`
    /// binary, the checkout's `apps/mac/Resources/Sounds`), prepared. Returns the sounds that loaded.
    @discardableResult
    func load(directory: URL?) -> Set<Earcon> {
        guard let directory else { return [] }
        var files: [Earcon: URL] = [:]
        for e in Earcon.allCases {
            let url = directory.appendingPathComponent(e.rawValue).appendingPathExtension(Earcon.fileExtension)
            if FileManager.default.fileExists(atPath: url.path) { files[e] = url }
        }
        let loaded = sink.load(files)
        for (e, d) in loaded where d.isFinite && d > 0 { durations[e] = d }
        return Set(loaded.keys)
    }

    /// The bundle's sounds directory, if the bundle has one.
    static func bundleDirectory(_ bundle: Bundle = .main) -> URL? {
        guard let resources = bundle.resourceURL else { return nil }
        let dir = resources.appendingPathComponent(Earcon.directory, isDirectory: true)
        return FileManager.default.fileExists(atPath: dir.path) ? dir : nil
    }

    /// Settings › Audio: the interface sounds on or off, and the volume (0…1).
    func configure(interface: Bool, volume: Double) {
        model.config = EarconModel.Config(interface: interface, volume: volume)
    }

    /// The decision for `e` now, played when it says so. A wait is retried at its time. `ring`: what it rings for.
    @discardableResult
    func play(_ e: Earcon, ring: Ring? = nil, automationId: String? = nil) -> EarconModel.Decision {
        let t = now()
        return attempt(e, pending: Pending(requestedAt: t, ring: ring, automationId: automationId), at: t)
    }

    /// A `local.say` sound: `kind` its `ring` (the automation's kind; nil from a daemon before it, or an open's tink),
    /// `name` its sound (Pop · Glass · Ping · Hero), which only picks the file.
    @discardableResult
    func ring(_ name: String?, kind: String?, automationId: String?) -> EarconModel.Decision {
        let ring = Ring.of(kind: kind, name: name)
        let file = name.flatMap(Earcon.named) ?? ring?.earcon ?? .chime
        return play(file, ring: ring, automationId: automationId)
    }

    /// Snooze or Done pressed on a ring: every sounding ring fades out over 120 ms. Returns whether
    /// this row's ring sounded inside the linger window (Snooze's own sound plays only then).
    @discardableResult
    func fadeRings(for automationId: String?) -> Bool {
        let t = now()
        var faded: Set<Earcon> = []
        for e in ringFiles where sink.isPlaying(e) {
            sink.fadeOut(e, over: Earcons.ringFade)
            faded.insert(e)
        }
        for (e, p) in pending where p.ring != nil { pending[e] = nil }
        wire.cut(faded, at: t + Earcons.ringFade)
        ringFiles.removeAll()
        model.forgetRings()
        guard let id = automationId, let at = ringSounded[id] else { return false }
        return t - at < Earcons.ringLinger
    }

    /// The phase moved into one where the session's microphone runs (`AppState.voiceAudioRuns`), before the graph
    /// starts: nothing waits any more, whatever still sounds but `awake` fades out over 50 ms, and the wire is held
    /// until every sound's echo has passed — a ring that started a moment before Go, or one whose `local.say`
    /// overtook the connecting snapshot, never reaches Live. Returns the sounds it faded.
    @discardableResult
    func enterVoice() -> [Earcon] {
        let t = now()
        pending.removeAll()
        let faded = Earcon.allCases.filter { $0 != .awake && sink.isPlaying($0) }
        for e in faded { sink.fadeOut(e, over: Earcons.quickFade) }
        let set = Set(faded)
        wire.cut(set, at: t + Earcons.quickFade)
        // Faded, they outrank nothing: `awake`, asked for right after this, plays.
        model.forget(set)
        ringFiles.subtract(set)
        wire.holdSounding()
        return faded
    }

    /// The app is quitting: stop everything, and nothing new starts.
    func silence() {
        model.quitting = true
        pending.removeAll()
        sink.stopAll()
        wire.cutAll(at: now())
    }

    /// When the last sound stops being audible (`LocalSpeaker.isQuiet` waits this out).
    var audibleUntil: Double { wire.audibleUntil }

    private func attempt(_ e: Earcon, pending p: Pending, at t: Double) -> EarconModel.Decision {
        let decision = model.decide(e, ring: p.ring, now: t, voiceRuns: voiceRuns(), voiceAudibleUntil: voiceAudibleUntil(), requestedAt: p.requestedAt, automationId: p.automationId)
        switch decision {
        case .play(let gain):
            pending[e] = nil
            start(e, gain: gain, at: t, pending: p)
        case .wait(let until):
            pending[e] = p
            schedule(until - t) { [weak self] in self?.retry(e) }
        case .drop:
            pending[e] = nil
        }
        // A wait is logged once, at the request; its 100 ms polls stay out of the log.
        var poll = false
        if case .wait = decision { poll = p.requestedAt != t }
        if !poll { onDecision?(e, decision) }
        return decision
    }

    private func retry(_ e: Earcon) {
        guard let p = pending[e] else { return }
        _ = attempt(e, pending: p, at: now())
    }

    private func start(_ e: Earcon, gain: Double, at t: Double, pending p: Pending) {
        // One at a time: a lower sound that started under 250 ms ago and still sounds gives way (heard, then awake at once).
        let lower = Set(model.superseded(by: e, ring: p.ring, now: t).filter { sink.isPlaying($0) })
        for other in lower { sink.fadeOut(other, over: Earcons.quickFade) }
        wire.cut(lower, at: t + Earcons.quickFade)
        model.forget(lower)
        ringFiles.subtract(lower)
        guard sink.play(e, gain: Float(gain)) else { return }
        let facts = output()
        wire.note(e, start: t, duration: durations[e] ?? e.seconds, latency: facts.latency, bluetooth: facts.bluetooth, holdsWire: e == .awake)
        if p.ring != nil {
            ringFiles.insert(e)
            if let id = p.automationId { ringSounded[id] = t }
        } else {
            ringFiles.remove(e)
        }
    }
}
