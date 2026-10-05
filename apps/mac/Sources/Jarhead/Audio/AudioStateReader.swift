import AVFoundation
import CoreAudio
import Foundation

/// What the voice engine knows about its graph in-process, read on `jarhead.audio` with no
/// HAL round trip: the flags it set, the unit's own properties, the guard's counters, and the
/// ids the HAL half needs to look its devices up.
struct AudioLocalFacts: Equatable {
    var running = false
    var voiceProcessing = false
    var duckLevel: UInt32?
    var advancedDucking: Bool?
    var agc: Bool?
    var bypassed: Bool?
    var rung = 0
    var wiring = ""
    var tapFormat = ""
    var recording = false
    var fallback = false
    var tailMs = 0
    var guardOn = false
    var guardHeld = false
    var gated = 0
    var chunks = 0
    var breakthroughs = 0
    var heldSeconds = 0.0
    /// The private route's microphone, the plain path's microphone, the input AU's device.
    var privateRouteMicUID: String?
    var activeInputUID: String?
    var currentDevice: AudioDeviceID?
    var preferredInputUID: String?
    var lastUsedInputUID: String?
    /// The graph runs with echo cancellation.
    var echoCancelled = false

    /// The guard's own fields: one lock, no HAL.
    mutating func refreshGuard() {
        let stats = EchoGuard.shared.stats
        guardOn = EchoGuard.shared.isAttached
        guardHeld = EchoGuard.shared.isHeld
        gated = stats.gated
        chunks = stats.chunks
        breakthroughs = stats.breakthroughs
        heldSeconds = stats.heldSeconds
    }
}

/// The HAL half of the frame: the device tables, the process list, the aggregate scans and
/// the HAL's input mute. Every read is a round trip that can take tens of milliseconds.
struct AudioHALFacts: Equatable {
    var hears: AudioDeviceFacts?
    var speaks: AudioDeviceFacts?
    var sharedWith: [String]?
    var inputMuted = false
    var aggregatePresent = false
    var engineAggregatePresent = false

    static func read(_ local: AudioLocalFacts) -> AudioHALFacts {
        var h = AudioHALFacts()
        h.hears = hears(local)
        h.speaks = AudioDeviceFacts.defaultOutput()
        h.sharedWith = h.hears.flatMap { AudioEngine.deviceID(matching: $0.uid) }.flatMap { AudioProcessObjects.sharingInput(on: $0) }
        h.inputMuted = AVAudioApplication.shared.isInputMuted
        h.aggregatePresent = AudioAggregates.present(AudioAggregates.unitPrefix)
        h.engineAggregatePresent = AudioAggregates.present(AudioAggregates.enginePrefix)
        return h
    }

    /// The device the graph hears through: under AEC the system default input (the unit
    /// follows it); on the plain path the microphone the engine settled on
    /// (`activeInputUID`); on the private route the ranked mic behind the aggregate.
    /// Stopped: the default input.
    private static func hears(_ local: AudioLocalFacts) -> AudioDeviceFacts? {
        if local.running, let mic = local.privateRouteMicUID, let id = AudioEngine.deviceID(matching: mic) {
            return AudioDeviceFacts.read(id: id, scope: kAudioObjectPropertyScopeInput)
        }
        if local.running, !local.voiceProcessing {
            // The AU's `CurrentDevice` reads as the engine's own aggregate on a Mac whose default
            // input ≠ default output (`CADefaultDeviceAggregate-<pid>-n`), so the microphone the
            // graph was pointed at is the fact: `activeInputUID`, then the AU, then the default.
            if let uid = local.activeInputUID, let id = AudioEngine.deviceID(matching: uid) {
                return AudioDeviceFacts.read(id: id, scope: kAudioObjectPropertyScopeInput)
            }
            if let dev = local.currentDevice, let uid = AudioEngine.deviceUID(dev), !uid.hasPrefix(AudioAggregates.enginePrefix) {
                return AudioDeviceFacts.read(id: dev, scope: kAudioObjectPropertyScopeInput)
            }
        }
        return AudioDeviceFacts.defaultInput()
    }
}

extension AudioStateReadback {
    init(local l: AudioLocalFacts, hal h: AudioHALFacts) {
        self.init()
        running = l.running
        voiceProcessing = l.voiceProcessing
        duckLevel = l.duckLevel
        advancedDucking = l.advancedDucking
        agc = l.agc
        bypassed = l.bypassed
        rung = l.rung
        wiring = l.wiring
        tapFormat = l.tapFormat
        recording = l.recording
        fallback = l.fallback
        guardOn = l.guardOn
        guardHeld = l.guardHeld
        guardTailMs = l.guardOn ? l.tailMs : 0
        gated = l.gated
        chunks = l.chunks
        breakthroughs = l.breakthroughs
        heldSeconds = l.heldSeconds
        hears = h.hears
        speaks = h.speaks
        sharedWith = h.sharedWith
        inputMuted = h.inputMuted
        aggregatePresent = h.aggregatePresent
        engineAggregatePresent = h.engineAggregatePresent
    }
}

/// The graph's state frame and the microphone route, read off the speaker's queue.
///
/// Every HAL read used to run on `jarhead.audio`, the serial queue that schedules the
/// speaker's chunks: 20–40 ms a tick, 100–290 ms tails, whole seconds under load, each one a
/// hole in Jarhead's voice. Here they run on their own utility queue:
/// - the engine pushes its in-process facts (`AudioLocalFacts`) at start, stop, a policy
///   flip and mute; a guard edge and the 5 s tick refresh only the guard's counters;
/// - the HAL is read again only when a Core Audio listener marked it dirty, when the engine
///   asks (start, stop, mute), or every 30 s;
/// - `mic clients changed` (the process list) is read at most once per 2 s; device-list and
///   default-device changes keep the 50 ms fold;
/// - a route verdict that needs a restart (a vanished mic, the picked mic back on the plain
///   path) goes to the engine (`onRestart`), which checks it again on its own queue.
///
/// The frame can lag the graph by milliseconds: it is a report, never a decision.
final class AudioStateReader {
    static let halRefresh: TimeInterval = 30
    static let clientsDebounce: TimeInterval = 2
    static let routeFold: TimeInterval = 0.05

    /// A route change the engine should rebuild for, with the microphone the verdict saw.
    struct RouteRestart: Equatable {
        let why: String
        let activeInputUID: String?
    }

    let queue: DispatchQueue
    /// The frame when it changed. Called on `queue`.
    var onAudioState: ((AudioStateReadback) -> Void)?
    /// The route summary when it changed. Called on `queue`.
    var onStatus: ((String) -> Void)?
    /// A route verdict that needs a restart. Called on `queue`; the engine hops to its own.
    var onRestart: ((RouteRestart) -> Void)?

    private let router = MicRouter()
    private var local = AudioLocalFacts()
    private var hal: AudioHALFacts?
    private var halDirty = true
    private var halReadAt: CFAbsoluteTime = 0
    private var lastState: AudioStateReadback?
    private var lastRouteSummary = ""
    private var pendingReasons: [String] = []
    private var foldAt: CFAbsoluteTime?
    private var foldToken = 0
    private var clientsReadAt = -Double.infinity
    private var routeRequestObserver: NSObjectProtocol?

    /// `queue`: harnesses only (playout-probe's `--legacy` puts the reads back on the play queue).
    init(queue: DispatchQueue = DispatchQueue(label: "jarhead.audio.state", qos: .utility)) {
        self.queue = queue
    }

    deinit {
        stop()
    }

    /// Watch the device list, the default devices and the process list, and answer the
    /// Console's picker (`MicRoute.requestName`).
    func start() {
        router.onChange = { [weak self] reason in self?.routeChanged(reason) }
        router.start(on: queue)
        guard routeRequestObserver == nil else { return }
        routeRequestObserver = NotificationCenter.default.addObserver(forName: MicRoute.requestName, object: nil, queue: nil) { [weak self] _ in
            guard let self else { return }
            self.queue.async { self.publishRoute("picker") }
        }
    }

    func stop() {
        router.stop()
        if let routeRequestObserver { NotificationCenter.default.removeObserver(routeRequestObserver) }
        routeRequestObserver = nil
    }

    /// The engine's facts changed (a policy flip, mute). `readHAL`: the HAL changed with them.
    func update(_ facts: AudioLocalFacts, reason: String, readHAL: Bool) {
        queue.async {
            self.local = facts
            if readHAL { self.halDirty = true }
            self.publishFrame(reason)
        }
    }

    /// The graph started or stopped: the facts, a fresh HAL read, the route for the picker.
    func route(_ facts: AudioLocalFacts, reason: String) {
        queue.async {
            self.local = facts
            self.halDirty = true
            self.publishRoute(reason)
        }
    }

    /// A guard edge or the 5 s tick: the guard's counters only. The HAL is read when a
    /// listener marked it dirty or 30 s have passed.
    func refreshCounters(_ reason: String) {
        queue.async {
            self.local.refreshGuard()
            self.publishFrame(reason)
        }
    }

    /// Harnesses: as if a Core Audio listener had fired with `reason`.
    func simulateRouteChange(_ reason: String) {
        queue.async { self.routeChanged(reason) }
    }

    // MARK: on `queue`

    private func publishFrame(_ reason: String) {
        let now = CFAbsoluteTimeGetCurrent()
        if hal == nil || halDirty || now - halReadAt >= AudioStateReader.halRefresh { readHAL(now) }
        publish(AudioStateReadback(local: local, hal: hal ?? AudioHALFacts()))
    }

    private func readHAL(_ now: CFAbsoluteTime) {
        hal = AudioHALFacts.read(local)
        halDirty = false
        halReadAt = now
    }

    private func publish(_ state: AudioStateReadback) {
        guard state != lastState else { return }
        lastState = state
        onAudioState?(state)
    }

    /// A listener fired. Bursts fold into one look 50 ms later; a burst of nothing but
    /// process-list changes waits until 2 s after the last such look.
    private func routeChanged(_ reason: String) {
        halDirty = true
        if !pendingReasons.contains(reason) { pendingReasons.append(reason) }
        let now = CFAbsoluteTimeGetCurrent()
        let clientsOnly = pendingReasons.allSatisfy { $0 == MicRouter.clientsReason }
        let soonest = now + AudioStateReader.routeFold
        let due = clientsOnly ? max(soonest, clientsReadAt + AudioStateReader.clientsDebounce) : soonest
        if let foldAt, foldAt <= due + 0.001 { return }
        foldAt = due
        foldToken += 1
        let token = foldToken
        queue.asyncAfter(deadline: .now() + max(0, due - now)) { [weak self] in self?.fold(token) }
    }

    private func fold(_ token: Int) {
        guard token == foldToken else { return }
        foldAt = nil
        if pendingReasons.contains(MicRouter.clientsReason) { clientsReadAt = CFAbsoluteTimeGetCurrent() }
        let why = pendingReasons.joined(separator: ", ")
        pendingReasons.removeAll()
        applyRouteChange(why)
    }

    /// Three things can follow a change: the microphone the graph hears through is gone —
    /// the engine rebuilds on the next-ranked one; Kevin's explicit pick came back on the
    /// plain path — the engine moves to it; otherwise only the published route moves. The
    /// system default is never written.
    private func applyRouteChange(_ reason: String) {
        let inputs = MicInputs.enumerate()
        let systemDefault = MicInputs.systemDefaultUID()
        let ranked = MicRanking.rank(inputs, explicit: local.preferredInputUID, lastUsed: local.lastUsedInputUID, systemDefault: systemDefault)
        var restart: String?
        if local.running, let active = local.activeInputUID, !inputs.contains(where: { $0.uid == active }) {
            restart = "microphone \(MicInputs.name(of: active) ?? active) vanished; rebuilding on \(ranked.first?.name ?? "the system default")"
        } else if local.running, !local.echoCancelled, let explicit = local.preferredInputUID, local.activeInputUID != explicit, ranked.first?.uid == explicit {
            restart = "picked microphone \(ranked.first?.name ?? explicit) is back; moving to it"
        }
        publishRoute(reason, ranked: ranked, systemDefault: systemDefault)
        if let restart { onRestart?(RouteRestart(why: restart, activeInputUID: local.activeInputUID)) }
    }

    /// The route as the Console's picker and the ear report it: the ranked list, the active
    /// device, what the choice follows. Posted on the main queue as `.jarheadMicRoute` with
    /// plain strings (the Console harness compiles without this file) and logged through
    /// `onStatus` when it changed. The frame goes out with it, the HAL read fresh.
    private func publishRoute(_ reason: String) {
        let inputs = MicInputs.enumerate()
        let systemDefault = MicInputs.systemDefaultUID()
        let ranked = MicRanking.rank(inputs, explicit: local.preferredInputUID, lastUsed: local.lastUsedInputUID, systemDefault: systemDefault)
        publishRoute(reason, ranked: ranked, systemDefault: systemDefault)
    }

    private func publishRoute(_ reason: String, ranked: [MicInput], systemDefault: String?) {
        readHAL(CFAbsoluteTimeGetCurrent())
        let state = AudioStateReadback(local: local, hal: hal ?? AudioHALFacts())
        let route = MicRoute(ranked: ranked, active: local.activeInputUID, systemDefault: systemDefault, explicit: local.preferredInputUID, echoCancelled: local.echoCancelled, running: local.running, state: state)
        let summary = route.summary
        if summary != lastRouteSummary {
            lastRouteSummary = summary
            onStatus?("mic route (\(reason)): \(summary)")
        }
        let info = route.userInfo
        DispatchQueue.main.async { NotificationCenter.default.post(name: .jarheadMicRoute, object: nil, userInfo: info) }
        publish(state)
    }
}
