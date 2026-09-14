import AVFoundation
import Combine
import Foundation

/// The slice of the snapshot the ear reacts to.
private struct EarInputs: Equatable {
    var phase: Phase
    var reflexes: Bool
}

/// The slice of the snapshot's transcript the barge-in duck reacts to: Kevin's open
/// (non-final) item as Live transcribes him — a new id or a longer text is "Live heard
/// Kevin" — and Jarhead's recent words, so a partial made only of them is not taken as
/// Kevin's confirmation.
private struct EarTranscriptInputs: Equatable {
    var kevinOpenId: String?
    var kevinOpenLength = 0
    var jarheadRecent = ""

    init(_ transcript: [TranscriptItem]) {
        if let open = transcript.last(where: { $0.speaker == .kevin }), !open.final {
            kevinOpenId = open.id
            kevinOpenLength = open.text.count
        }
        // His last two items, capped: what the speaker is saying now and what it just said.
        let recent = transcript.suffix(8).filter { $0.speaker == .jarhead }.suffix(2).map(\.text).joined(separator: " ")
        jarheadRecent = String(recent.suffix(800))
    }
}

/// The on-device ear while awake. Speech → Live → delegation → brain → first tool
/// call is seconds: the model has to think. A command that needs no thinking
/// ("scroll down", "open Safari") must not wait for it, so while the voice engine is
/// running the app also runs Apple's on-device recogniser on the same microphone
/// buffers and sends every changed partial to the daemon as an `ear` message within
/// ~100–200 ms of speech. The engine's reflex layer matches unambiguous commands on
/// those partials and runs them through the policy-gated hands at once; Live's own
/// transcript of the same words is reconciled later ("already done").
///
/// Inputs: whether the voice `AudioEngine` is running (asleep, the wake listener owns
/// the microphone and the ear is off), the phase (never while paused or muted), the
/// connection, `settings.reflexes`, and the Speech Recognition grant, read the way the
/// wake gate reads it (`WakeWordListener.currentAuthorization`, re-read whenever the
/// ear is asked to start and every 30 s while it is blocked, so a grant made later in
/// System Settings counts without a relaunch). `update()` folds them into: listen, or
/// not, and why. Snapshot inputs are the *payloads* of the `AppState` publishers, never
/// re-read from `state` inside a sink (`@Published` emits in `willSet`).
@MainActor
final class ReflexEar {
    private let state: AppState
    private nonisolated let listener: EarListener
    /// Where partials go: `EngineClient.sendEar`. A `let` closure, so the listener's
    /// queue calls it without touching main-actor state.
    private nonisolated let send: (String, Bool, Int, Int) -> Void
    private var cancellables = Set<AnyCancellable>()

    // Inputs.
    private var inputs: EarInputs
    private var transcriptInputs = EarTranscriptInputs([])
    private var connected: Bool
    private var voiceAudioActive = false
    private let enabledByEnvironment: Bool

    // Machine.
    private var listening = false
    /// Why the listener cannot run right now (grant, model). Cleared by the retry timer
    /// or by the listener reporting that it started.
    private var blocked: String?
    private var retry: Task<Void, Never>?
    private var lastReason = ""
    private var lastRoute = ""
    /// Notification observers (screen hints from the client, the mic route from the
    /// audio engine), removed when the ear goes away; a nonisolated bag so `deinit` needs
    /// no actor hop.
    private nonisolated let observers = ObserverBag()

    static let recheckInterval: TimeInterval = 30

    /// `send(text, isFinal, segment, atMs)` is called on the ear's own queue, at most 20 times a second.
    init(state: AppState, send: @escaping (String, Bool, Int, Int) -> Void) {
        self.state = state
        self.send = send
        listener = EarListener()
        inputs = EarInputs(phase: state.snapshot.phase, reflexes: state.snapshot.settings.reflexes)
        connected = state.connected
        enabledByEnvironment = ProcessInfo.processInfo.environment["JARHEAD_NO_AUDIO"] != "1"

        listener.onTranscript = send
        listener.onStatus = { [weak self] status in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.handleListenerStatus(status) } }
        }

        // What is on the screen (the engine's `ear.hints`, decoded by EngineClient): straight
        // to the listener on whatever thread posted it; `applyHints` hops to the ear queue.
        let listener = self.listener
        observers.add(NotificationCenter.default.addObserver(forName: .jarheadEarHints, object: nil, queue: nil) { note in
            guard let strings = note.userInfo?["strings"] as? [String] else { return }
            listener.applyHints(strings)
        })
        // The microphone route (AudioEngine's ranking): told to the daemon through the ear's
        // status frame, so a vanished mic and what replaced it are in daemon.log.
        observers.add(NotificationCenter.default.addObserver(forName: .jarheadMicRoute, object: nil, queue: .main) { [weak self] note in
            guard let summary = note.userInfo?["summary"] as? String else { return }
            MainActor.assumeIsolated { self?.reportRoute(summary) }
        })

        state.$snapshot
            .map { (s: Snapshot) -> EarInputs in EarInputs(phase: s.phase, reflexes: s.settings.reflexes) }
            .removeDuplicates()
            .sink { [weak self] (inputs: EarInputs) in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.inputs = inputs
                    // The barge-in duck's fallback confirmation: the voice leaving `speaking` means
                    // Live heard Kevin too (1.2 s after Jarhead's last words at the earliest).
                    BargeInDuck.shared.noteVoiceSpeaking(inputs.phase == .speaking)
                    self.update()
                }
            }
            .store(in: &cancellables)
        // Live's own transcript, for the duck: Kevin's non-final item growing is Live's
        // `session.input_transcript.delta` — the confirmation the ear cannot give when it
        // is off (no grant, reflexes off) and the one that outranks residual echo.
        state.$snapshot
            .map { (s: Snapshot) -> EarTranscriptInputs in EarTranscriptInputs(s.transcript) }
            .removeDuplicates()
            .sink { [weak self] (t: EarTranscriptInputs) in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    let was = self.transcriptInputs
                    self.transcriptInputs = t
                    if t.jarheadRecent != was.jarheadRecent { BargeInDuck.shared.noteJarheadSaid(t.jarheadRecent) }
                    if let id = t.kevinOpenId, id != was.kevinOpenId || t.kevinOpenLength > was.kevinOpenLength {
                        BargeInDuck.shared.noteLiveHeardKevin()
                    }
                }
            }
            .store(in: &cancellables)
        state.$connected
            .removeDuplicates()
            .sink { [weak self] (on: Bool) in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.connected = on
                    self.update()
                }
            }
            .store(in: &cancellables)
    }

    // MARK: - inputs

    /// The voice audio engine started (awake) or stopped (asleep). The ear only ever
    /// hears through that engine's tap, so this is also what gates the microphone.
    func setVoiceAudioActive(_ active: Bool) {
        voiceAudioActive = active
        update()
    }

    /// The voice engine's microphone buffer, on AVAudioEngine's tap thread (not
    /// real-time). Always wired; the listener drops it while the ear is off.
    nonisolated func ingest(_ buffer: AVAudioPCMBuffer, at when: AVAudioTime) {
        listener.ingest(buffer, at: when)
    }

    var isListening: Bool { listening }

    // MARK: - decide

    func update() {
        if !enabledByEnvironment { return setOff("audio disabled (JARHEAD_NO_AUDIO)") }
        if !voiceAudioActive { return setOff("voice audio not running") } // asleep: the wake listener owns the mic
        if !connected { return setOff("daemon not connected") }
        if !inputs.reflexes { return setOff("reflexes off") }
        switch inputs.phase {
        case .paused: return setOff("paused")
        case .muted: return setOff("muted")
        case .asleep, .error: return setOff("asleep")
        case .connecting, .listening, .speaking, .thinking, .acting: break
        }
        let grant = WakeWordListener.currentAuthorization()
        if !grant.authorized {
            scheduleRecheck()
            return setOff(grant.detail)
        }
        if let blocked {
            scheduleRecheck()
            return setOff(blocked)
        }
        if !listening {
            listener.start()
            listening = true
            note("on (\(inputs.phase.rawValue))")
        }
    }

    private func setOff(_ reason: String) {
        if listening {
            listener.stop()
            listening = false
        }
        note("off: \(reason)")
    }

    private func handleListenerStatus(_ status: EarListener.Status) {
        report(status.text)
        switch status {
        case .started:
            blocked = nil
        case .recognitionError:
            break // the listener rolls to a fresh task on its own
        case .unavailable(let text):
            // Not running: make the ear agree, and look again later (the model can be downloaded meanwhile).
            blocked = text
            listening = false
            scheduleRecheck()
            update()
        }
    }

    /// While the ear is wanted but blocked (grant undecided, model missing), look again every 30 s.
    private func scheduleRecheck() {
        guard retry == nil else { return }
        retry = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(ReflexEar.recheckInterval * 1_000_000_000))
            guard !Task.isCancelled, let self else { return }
            self.retry = nil
            self.blocked = nil
            self.update()
        }
    }

    /// One log line per change of mind, not one per snapshot.
    private func note(_ reason: String) {
        guard reason != lastReason else { return }
        lastReason = reason
        report(reason)
    }

    /// The ear's state, logged here and told to the engine. The app's NSLog lines are not
    /// kept by the unified log on Kevin's Mac, so the daemon's log is where a production
    /// session can be read back: the report rides the `ear` frame with a negative segment
    /// (`Engine.ear` logs it as "ear (app): …" and judges no words), so no wire change is
    /// needed. One line per change of mind; while disconnected the client drops it.
    private func report(_ text: String) {
        NSLog("Ear: %@", text)
        let nowMs = Int((Date().timeIntervalSince1970 * 1000).rounded())
        send(text, true, ReflexEar.statusSegment, nowMs)
    }

    /// The microphone route, once per change (`mic route: …` in daemon.log through the
    /// status frame). The typed "microphone" problem is the engine's to raise from it.
    private func reportRoute(_ summary: String) {
        guard summary != lastRoute else { return }
        lastRoute = summary
        report("mic route: \(summary)")
    }

    /// The `segment` of an `ear` frame that carries a status line instead of words.
    static let statusSegment = -1
}

/// Notification tokens removed together when their owner goes away.
final class ObserverBag: @unchecked Sendable {
    private let lock = NSLock()
    private var tokens: [NSObjectProtocol] = []

    func add(_ token: NSObjectProtocol) {
        lock.lock()
        tokens.append(token)
        lock.unlock()
    }

    deinit {
        for t in tokens { NotificationCenter.default.removeObserver(t) }
    }
}
