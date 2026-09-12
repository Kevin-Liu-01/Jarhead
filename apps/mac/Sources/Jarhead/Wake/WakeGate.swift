import AppKit
import Combine
import Foundation

/// The slice of the snapshot the gate reacts to.
private struct GateInputs: Equatable {
    var phase: Phase
    var wake: WakeSettings
}

/// The wake word gate. While the engine is asleep it listens on-device for one of
/// the wake phrases; when it hears one it authenticates — Touch ID / Apple Watch /
/// Mac password through the system sheet, or a spoken or typed passphrase — and only
/// then sends `wake`, which is the moment the paid voice session opens.
///
/// Everything here is local: the recogniser runs on the Mac, the prompts come from
/// the system speech synthesiser, and the passphrase is checked against a PBKDF2
/// hash. Three wrong answers lock the gate for a minute; so do three prompts nobody
/// answers within two minutes (a recording that says the word cannot pop the sheet
/// forever). A spoken passphrase is a static secret — a recording of Kevin saying it
/// replays — so the owner sheet is the factor that resists replay; `either` offers both.
///
/// Paused is the other place the gate listens. A pause closes the Live session (the
/// meter stops) and holds the conversation; hearing the word then sends `go`, which
/// resumes it — without Touch ID or the passphrase (see `isPaused`).
///
/// Inputs: microphone grant, Speech Recognition grant, whether the voice audio
/// engine is running (they never share the mic), and the snapshot (phase, wake
/// settings, connection). `update()` folds them into: listen, or not, and why.
/// Snapshot-derived inputs arrive as the *payloads* of the `AppState` publishers and
/// are never re-read from `state` inside a sink: `@Published` emits in `willSet`, so
/// there the property still holds the previous value.
@MainActor
final class WakeGate {
    private let state: AppState
    private let listener = WakeWordListener()
    private let speaker = LocalSpeaker()
    private var cancellables = Set<AnyCancellable>()

    // Inputs.
    private var inputs: GateInputs
    private var connected: Bool
    private var micGranted = false
    private(set) var speechAuthorized = false
    private var speechDetail = "Speech Recognition not requested yet"
    private var voiceAudioActive = false
    private let enabledByEnvironment: Bool

    // Machine.
    private enum Mode: Equatable { case idle, listening, authenticating, granting }
    private var mode: Mode = .idle
    private var listenerRunning = false
    /// Why the listener cannot run right now. Cleared by the retry timer, by a new
    /// Speech Recognition grant, or by the listener reporting that it started.
    private var listenerBlocked: String?
    private var listenerRetry: Task<Void, Never>?
    private var listenerRetryDelay: TimeInterval = WakeGate.retryDelayFloor
    private var warnedNoAuth = false

    // Transcript bookkeeping (normalised text of the current recogniser segment).
    private var currentSegment = 0
    private var consumedUpTo = 0
    /// While a passphrase prompt is open: the recogniser segment the answer must come
    /// from. The listener rolls to a fresh segment at the prompt, so the answer is
    /// never spliced out of the wake word's own (still being revised) transcript. nil
    /// until that roll has happened; anything from an older segment is ignored.
    private var answerSegment: Int?
    private var lastCandidate = ""
    /// A newer candidate that arrived while a previous one was being hashed.
    private var pendingCandidate: String?
    /// Normalised words the gate itself said since the prompt. They come back through
    /// the microphone and must never count as an answer.
    private var promptEcho: Set<String> = []

    // Authentication.
    private var currentMethod = ""
    private var passphraseOpen = false
    private var ownerAuth: LocalAuth.OwnerAuth?
    private var candidateTimer: Task<Void, Never>?
    private var authDeadline: Task<Void, Never>?
    private var grantWatchdog: Task<Void, Never>?
    private var verifying = false
    /// Bumped whenever a prompt opens or closes, so a hash that finishes late cannot
    /// speak for a different prompt.
    private var authGeneration = 0
    private var failures = 0
    /// When prompts went unanswered. A sound-only source that never answers must not
    /// pop the sheet forever: `maxUnanswered` within `unansweredWindow` locks the gate.
    private var unanswered: [Date] = []
    private var lockedUntil: Date?
    private var cooldownUntil: Date = .distantPast

    static let authTimeout: TimeInterval = 15
    static let maxFailures = 3
    static let maxUnanswered = 3
    static let unansweredWindow: TimeInterval = 120
    static let lockout: TimeInterval = 60
    static let cooldown: TimeInterval = 2.5
    static let retryDelayFloor: TimeInterval = 2
    static let retryDelayCeiling: TimeInterval = 30
    static let unavailableRecheck: TimeInterval = 30

    init(state: AppState) {
        self.state = state
        inputs = GateInputs(phase: state.snapshot.phase, wake: state.snapshot.settings.wakeSettings)
        connected = state.connected
        enabledByEnvironment = ProcessInfo.processInfo.environment["JARHEAD_NO_AUDIO"] != "1"

        listener.onTranscript = { [weak self] text, isFinal, segment in
            MainActor.assumeIsolated { self?.handleTranscript(text, isFinal: isFinal, segment: segment) }
        }
        listener.onStatus = { [weak self] status in
            MainActor.assumeIsolated { self?.handleListenerStatus(status) }
        }

        state.wakePassphraseSet = LocalAuth.hasPassphrase
        var actions = WakeActions()
        actions.setPassphrase = { [weak self] phrase in self?.setPassphrase(phrase) ?? false }
        actions.clearPassphrase = { [weak self] in self?.clearPassphrase() }
        actions.submitPassphrase = { [weak self] phrase in self?.submitTypedPassphrase(phrase) }
        actions.cancelAuth = { [weak self] in self?.cancelAuth() }
        state.wakeActions = actions

        // Phase, wake settings and the connection decide whether we listen. The sink
        // payload is the new value; `state.snapshot` inside the sink is still the old one.
        state.$snapshot
            .map { (s: Snapshot) -> GateInputs in GateInputs(phase: s.phase, wake: s.settings.wakeSettings) }
            .removeDuplicates()
            .sink { [weak self] (inputs: GateInputs) in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.inputs = inputs
                    self.update()
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

    func setMicrophone(granted: Bool) {
        micGranted = granted
        update()
    }

    func setSpeechRecognition(authorized: Bool, detail: String) {
        speechAuthorized = authorized
        speechDetail = detail
        listenerRetry?.cancel(); listenerRetry = nil
        listenerBlocked = nil
        listenerRetryDelay = WakeGate.retryDelayFloor
        update()
    }

    /// The voice audio engine and the gate never hold the microphone at the same time.
    func setVoiceAudioActive(_ active: Bool) {
        voiceAudioActive = active
        update()
    }

    /// The engine takes a `wake` in these phases: nothing is open, nothing is billed.
    /// `.error` is where a missing key or a failed Live connect leaves it; listening
    /// there keeps the hands-free path alive, and the next authenticated wake retries.
    static func isDormant(_ phase: Phase) -> Bool { phase == .asleep || phase == .error }

    /// Paused: the session is closed (nothing is billed) and the conversation is held.
    /// The gate listens here too, and a heard word sends `go` with **no authentication** —
    /// no Touch ID, no passphrase. The pause was authenticated minutes ago, when the
    /// session it holds was opened, and it is bounded: an unresumed pause decays to asleep
    /// on its own (`snapshot.pause.sleepsAt`), after which the word is gated again. Asking
    /// for the passphrase a second time for the same conversation would only teach Kevin to
    /// say it into a room. The deliberate ways in (the Go button, ⌥⇧Space, `jarhead://go`)
    /// resume the same way.
    static func isPaused(_ phase: Phase) -> Bool { phase == .paused }

    /// Where the gate holds the microphone: dormant (asleep, error) or paused. Anywhere
    /// else the voice engine has it and the gate rests.
    static func listens(in phase: Phase) -> Bool { isDormant(phase) || isPaused(phase) }

    // MARK: - decide

    func update() {
        let settings = inputs.wake
        listener.setContextualStrings(settings.phrases.map { $0.capitalized })

        if !enabledByEnvironment { return setOff("audio disabled (JARHEAD_NO_AUDIO)") }
        if !settings.enabled { return setOff("wake word off") }
        if normalizedPhrases().isEmpty { return setOff("no wake phrases") }
        if !WakeGate.listens(in: inputs.phase) {
            leaveGranting()
            return setOff("awake")
        }
        // The wake we sent did not open a session: go back to listening rather than hang.
        if mode == .granting, inputs.phase == .error { leaveGranting() }
        if !connected { return setOff("daemon not connected") }
        if !micGranted { return setOff("microphone not granted") }
        if !speechAuthorized { return setOff(speechDetail) }
        if voiceAudioActive { return setOff("voice audio running") }
        if let blocked = listenerBlocked { return setOff(blocked) }
        if mode == .granting || mode == .authenticating { return }

        if settings.auth == .none, !warnedNoAuth {
            // Configured to trust the word alone (settings.wake.auth = none). Say so, once per launch.
            warnedNoAuth = true
            state.toast("Wake authentication is off: the wake word alone will open the session.", tone: .warn)
        }
        if !listenerRunning {
            listener.start()
            listenerRunning = true
        }
        mode = .listening
        if let until = lockedUntil, until > Date() {
            publish(.lockedOut(until: until))
        } else {
            publish(.listening)
        }
    }

    private func setOff(_ reason: String) {
        if mode == .authenticating { cancelAuthInternal() }
        stopListener()
        if mode != .granting { mode = .idle }
        state.wakeHeard = ""
        publish(mode == .granting ? .granted : .off(reason: reason))
    }

    private func stopListener() {
        guard listenerRunning else { return }
        listener.stop()
        listenerRunning = false
    }

    private func leaveGranting() {
        guard mode == .granting else { return }
        grantWatchdog?.cancel(); grantWatchdog = nil
        mode = .idle
    }

    private func normalizedPhrases() -> [String] {
        inputs.wake.phrases.map(LocalAuth.normalize).filter { !$0.isEmpty }
    }

    // MARK: - transcripts

    private func handleTranscript(_ raw: String, isFinal: Bool, segment: Int) {
        let text = LocalAuth.normalize(raw)
        if segment != currentSegment {
            currentSegment = segment
            consumedUpTo = 0
        }
        // Our own prompts come back through the microphone; never act on them.
        guard speaker.isQuiet() else { return }

        switch mode {
        case .listening:
            state.wakeHeard = WakeGate.tail(text, words: 6)
            guard let matchEnd = matchWakePhrase(in: text, after: consumedUpTo) else { return }
            let now = Date()
            if let until = lockedUntil, until > now {
                consumedUpTo = matchEnd
                publish(.lockedOut(until: until))
                return
            }
            // Not consumed during the cooldown: a word said then still counts once it ends.
            if now < cooldownUntil { return }
            consumedUpTo = matchEnd
            heard()

        case .authenticating:
            // The answer comes from the segment(s) opened after the prompt (see `answerSegment`).
            guard passphraseOpen, let answer = answerSegment, segment >= answer else { return }
            let candidate = text
            // Never show the secret, only that something is being heard.
            state.wakeHeard = WakeGate.masked(candidate)
            guard !candidate.isEmpty, candidate != lastCandidate || isFinal else { return }
            lastCandidate = candidate
            scheduleCandidateCheck(candidate, immediate: isFinal)

        case .idle, .granting:
            break
        }
    }

    private func handleListenerStatus(_ status: WakeWordListener.Status) {
        NSLog("Wake: %@", status.text)
        switch status {
        case .started:
            listenerBlocked = nil
            listenerRetryDelay = WakeGate.retryDelayFloor
        case .recognitionError:
            break // the listener rolls to a fresh task on its own
        case .unavailable(let text), .startFailed(let text):
            // The listener is not running: make the gate agree, drop any prompt in
            // flight (its answer could never arrive), and try again later.
            listenerBlocked = text
            stopListener()
            if mode == .authenticating { cancelAuthInternal() }
            if mode != .granting {
                mode = .idle
                publish(.off(reason: text))
            }
            state.wakeHeard = ""
            let delay: TimeInterval
            if case .startFailed = status {
                // Devices come and go (a headset switching): back off 2 s → 30 s.
                delay = listenerRetryDelay
                listenerRetryDelay = min(listenerRetryDelay * 2, WakeGate.retryDelayCeiling)
            } else {
                // Recogniser or on-device model unavailable: the model can be downloaded meanwhile.
                delay = WakeGate.unavailableRecheck
            }
            scheduleListenerRetry(after: delay)
        }
    }

    private func scheduleListenerRetry(after delay: TimeInterval) {
        listenerRetry?.cancel()
        listenerRetry = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled, let self else { return }
            self.listenerRetry = nil
            self.listenerBlocked = nil
            self.update()
        }
    }

    /// End offset (in characters) of the last wake phrase that ends after `after`,
    /// matched on word boundaries so "jarheads" does not count.
    private func matchWakePhrase(in text: String, after: Int) -> Int? {
        let phrases = normalizedPhrases()
        guard !phrases.isEmpty, !text.isEmpty else { return nil }
        var best: Int?
        for phrase in phrases {
            var search = text.startIndex..<text.endIndex
            while let r = text.range(of: phrase, range: search) {
                let beforeOK = r.lowerBound == text.startIndex || text[text.index(before: r.lowerBound)] == " "
                let afterOK = r.upperBound == text.endIndex || text[r.upperBound] == " "
                let end = text.distance(from: text.startIndex, to: r.upperBound)
                if beforeOK && afterOK && end > after { best = max(best ?? 0, end) }
                search = r.upperBound..<text.endIndex
            }
        }
        return best
    }

    private static func tail(_ text: String, words: Int) -> String {
        text.split(separator: " ").suffix(words).joined(separator: " ")
    }

    /// One "•••" per word heard: shows the recogniser is following without showing what it heard.
    private static func masked(_ text: String) -> String {
        let n = text.split(separator: " ").count
        return Array(repeating: "•••", count: n).joined(separator: " ")
    }

    // MARK: - heard → authenticate

    private func heard() {
        if WakeGate.isPaused(inputs.phase) {
            // Paused: the word resumes, unauthenticated (see `isPaused`). Straight to the grant.
            grant()
            return
        }
        publish(.heard)
        speaker.earcon("Pop")
        beginAuthentication(inputs.wake.auth)
    }

    /// A go asked for by something other than the spoken word (the `jarhead://go` URL and
    /// its old names `wake` / `resume`). While the gate is on and the engine is dormant it
    /// goes through the same authentication as the word; while paused it resumes as the
    /// word does; it never opens the session by itself. Returns false when the gate is not
    /// in charge (disabled, or a session is open or opening), in which case the caller
    /// decides what a plain go means.
    @discardableResult
    func requestWake(source: String) -> Bool {
        guard inputs.wake.enabled, WakeGate.listens(in: inputs.phase) else { return false }
        NSLog("Wake: wake requested by %@", source)
        guard connected else {
            state.toast("Can't wake: the daemon is not connected.", tone: .warn)
            return true
        }
        if let until = lockedUntil, until > Date() {
            publish(.lockedOut(until: until))
            return true
        }
        guard mode == .listening || mode == .idle else { return true } // already authenticating or waking
        heard()
        return true
    }

    private func beginAuthentication(_ auth: WakeAuth) {
        let hasPassphrase = LocalAuth.hasPassphrase
        let ownerAvailable = LocalAuth.ownerAuthAvailable()
        var useOwner = false
        var usePassphrase = false
        switch auth {
        case .touchId:
            useOwner = ownerAvailable
            usePassphrase = !ownerAvailable && hasPassphrase
        case .passphrase:
            usePassphrase = hasPassphrase
            useOwner = !hasPassphrase && ownerAvailable
        case .either:
            useOwner = ownerAvailable
            usePassphrase = hasPassphrase
        case .none:
            // Configured to trust the word alone; update() warned about it.
            grant()
            return
        }
        guard useOwner || usePassphrase else {
            // Nothing to check against: stay shut rather than open the session unguarded.
            deny(reason: "no passphrase set and no Touch ID or password available",
                 say: "I can't check it's you. Set a passphrase first.", countsAsFailure: false)
            state.toast("Wake word heard, but there is nothing to authenticate with. Set a passphrase under Set Up… › Wake word, or enable Touch ID.", tone: .warn)
            return
        }

        mode = .authenticating
        authGeneration += 1
        passphraseOpen = usePassphrase
        lastCandidate = ""
        pendingCandidate = nil
        promptEcho = []
        answerSegment = nil
        let ownerName = LocalAuth.ownerAuthName()
        currentMethod = useOwner && usePassphrase ? "\(ownerName) or passphrase" : (useOwner ? ownerName : "passphrase")
        publish(.authenticating(method: currentMethod))
        say(usePassphrase ? "Password?" : "\(ownerName)?")
        if usePassphrase { openAnswerSegment() }

        if useOwner {
            let owner = LocalAuth.OwnerAuth()
            ownerAuth = owner
            Task { @MainActor [weak self] in
                let ok = await owner.evaluate(reason: "wake Jarhead")
                self?.ownerAuthFinished(ok, owner: owner)
            }
        }
        authDeadline = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(WakeGate.authTimeout * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.authTimedOut()
        }
    }

    /// Everything the gate says while a prompt is open is remembered, so its own echo
    /// through the microphone is never taken for an answer.
    private func say(_ text: String) {
        for w in LocalAuth.normalize(text).split(separator: " ") { promptEcho.insert(String(w)) }
        speaker.speak(text)
    }

    /// Start (or restart) the answer in a fresh recogniser segment. Until the listener
    /// confirms the roll, transcripts are ignored; if it is not running (nil) only the
    /// sheet or a typed phrase can answer, and the deadline closes the prompt.
    private func openAnswerSegment() {
        answerSegment = nil
        lastCandidate = ""
        pendingCandidate = nil
        let generation = authGeneration
        listener.rollSegment { [weak self] seg in
            MainActor.assumeIsolated {
                guard let self, self.mode == .authenticating, self.passphraseOpen, self.authGeneration == generation else { return }
                self.answerSegment = seg
            }
        }
    }

    private func ownerAuthFinished(_ ok: Bool, owner: LocalAuth.OwnerAuth) {
        guard mode == .authenticating, ownerAuth === owner else { return }
        ownerAuth = nil
        if ok {
            grant()
        } else if !passphraseOpen {
            deny(reason: "\(LocalAuth.ownerAuthName()) did not confirm", say: "No.", countsAsFailure: true)
        }
        // With the passphrase path open, a cancelled sheet just leaves the spoken path until the deadline.
    }

    private func scheduleCandidateCheck(_ candidate: String, immediate: Bool) {
        candidateTimer?.cancel()
        candidateTimer = Task { @MainActor [weak self] in
            if !immediate { try? await Task.sleep(nanoseconds: 1_100_000_000) }
            guard !Task.isCancelled, let self, self.mode == .authenticating else { return }
            await self.verifyCandidate(candidate)
        }
    }

    private func verifyCandidate(_ candidate: String) async {
        if verifying {
            // Judge the newest words once the current hash finishes, not only the stale partial.
            pendingCandidate = candidate
            return
        }
        let words = candidate.split(separator: " ").map(String.init)
        let enrolledWords = LocalAuth.passphraseWords
        // Fewer words than the phrase has: Kevin is still talking. Wait for more.
        guard enrolledWords > 0, words.count >= enrolledWords else { return }
        // Only our own prompt coming back through the microphone: not an attempt.
        if words.allSatisfy({ promptEcho.contains($0) }) { return }
        verifying = true
        let generation = authGeneration
        // The phrase may follow filler or our echo ("um, open sesame"): try the tail of the right length too.
        var attempts = [candidate]
        for extra in 0...1 where words.count > enrolledWords + extra {
            let tail = words.suffix(enrolledWords + extra).joined(separator: " ")
            if !attempts.contains(tail) { attempts.append(tail) }
        }
        let ok = await Task.detached(priority: .userInitiated) { attempts.contains { LocalAuth.verify($0) } }.value
        verifying = false
        guard mode == .authenticating, passphraseOpen, authGeneration == generation else { return }
        if ok {
            grant()
            return
        }
        if let next = pendingCandidate {
            // Newer words arrived meanwhile; they, not the stale partial, are the answer.
            pendingCandidate = nil
            await verifyCandidate(next)
            return
        }
        failures += 1
        if failures >= WakeGate.maxFailures {
            lockOut(after: "three failed attempts")
        } else {
            say("No.")
            publish(.authenticating(method: currentMethod))
            // Start the next attempt in a clean segment.
            state.wakeHeard = ""
            openAnswerSegment()
        }
    }

    private func authTimedOut() {
        guard mode == .authenticating else { return }
        let now = Date()
        unanswered = unanswered.filter { now.timeIntervalSince($0) < WakeGate.unansweredWindow }
        unanswered.append(now)
        if unanswered.count >= WakeGate.maxUnanswered {
            lockOut(after: "three unanswered prompts")
            return
        }
        deny(reason: "no answer in \(Int(WakeGate.authTimeout)) s", say: "Never mind.", countsAsFailure: false)
    }

    // MARK: - outcomes

    /// The only way to the session. While dormant it is reached from the owner sheet, a
    /// verified spoken or typed passphrase, or `auth = none` — never from the wake word
    /// alone. While paused it is reached from the word itself (`heard`, see `isPaused`).
    /// Either way the command is the transport's `go`: the engine wakes when asleep and
    /// resumes the held conversation when paused.
    private func grant() {
        let resuming = WakeGate.isPaused(inputs.phase)
        cancelTimers()
        ownerAuth?.cancel()
        ownerAuth = nil
        speaker.stop()
        mode = .granting
        authGeneration += 1
        failures = 0
        unanswered = []
        passphraseOpen = false
        answerSegment = nil
        pendingCandidate = nil
        promptEcho = []
        state.wakeHeard = ""
        publish(.granted)
        speaker.earcon("Glass")
        stopListener()
        state.send(.go)
        // If the engine never wakes (daemon trouble), go back to listening rather than hang.
        grantWatchdog = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 12_000_000_000)
            guard !Task.isCancelled, let self, self.mode == .granting else { return }
            self.mode = .idle
            self.state.toast(resuming ? "Said the word, but the engine did not resume." : "Said the word and authenticated, but the engine did not wake.", tone: .warn)
            self.update()
        }
    }

    private func deny(reason: String, say text: String?, countsAsFailure: Bool) {
        cancelAuthInternal()
        mode = .idle
        state.wakeHeard = ""
        if countsAsFailure { failures += 1 }
        if failures >= WakeGate.maxFailures {
            lockOut(after: "three failed attempts")
            return
        }
        publish(.denied(reason: reason))
        if let text { speaker.speak(text) }
        cooldownUntil = Date().addingTimeInterval(WakeGate.cooldown)
        // Leave the denial visible for the length of the cooldown, then listen again.
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(WakeGate.cooldown * 1_000_000_000))
            self?.update()
        }
    }

    private func lockOut(after reason: String) {
        cancelAuthInternal()
        mode = .idle
        failures = 0
        unanswered = []
        state.wakeHeard = ""
        let until = Date().addingTimeInterval(WakeGate.lockout)
        lockedUntil = until
        publish(.lockedOut(until: until))
        speaker.speak("Locked for a minute.")
        state.toast("Wake word locked for a minute after \(reason).", tone: .warn)
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(WakeGate.lockout * 1_000_000_000) + 200_000_000)
            guard let self else { return }
            if let l = self.lockedUntil, l <= Date() { self.lockedUntil = nil }
            self.update()
        }
    }

    private func cancelAuthInternal() {
        cancelTimers()
        ownerAuth?.cancel()
        ownerAuth = nil
        authGeneration += 1
        passphraseOpen = false
        answerSegment = nil
        lastCandidate = ""
        pendingCandidate = nil
        promptEcho = []
    }

    private func cancelTimers() {
        candidateTimer?.cancel(); candidateTimer = nil
        authDeadline?.cancel(); authDeadline = nil
        grantWatchdog?.cancel(); grantWatchdog = nil
    }

    private func publish(_ s: WakeGateState) {
        if state.wakeGate != s { state.wakeGate = s }
    }

    // MARK: - UI actions

    private func setPassphrase(_ phrase: String) -> Bool {
        do {
            try LocalAuth.setPassphrase(phrase)
            state.wakePassphraseSet = true
            state.toast("Wake passphrase set.", tone: .info)
            return true
        } catch {
            state.toast(error.localizedDescription, tone: .warn)
            return false
        }
    }

    private func clearPassphrase() {
        LocalAuth.clearPassphrase()
        state.wakePassphraseSet = false
        state.toast("Wake passphrase cleared.", tone: .info)
    }

    /// Typed in the capsule or the Console. Answers a pending prompt, or — while
    /// dormant with the gate on — wakes directly without the spoken word. Honours the
    /// configured factor: with Touch ID chosen, the phrase only stands in when the
    /// sheet is unavailable on this Mac. While paused anything typed here resumes
    /// (see `isPaused`): the phrase is not checked because none is asked for.
    private func submitTypedPassphrase(_ phrase: String) {
        let settings = inputs.wake
        guard settings.enabled, WakeGate.listens(in: inputs.phase), mode != .granting else { return }
        guard connected else {
            state.toast("Can't wake: the daemon is not connected.", tone: .warn)
            return
        }
        if WakeGate.isPaused(inputs.phase) {
            grant()
            return
        }
        guard LocalAuth.hasPassphrase else {
            state.toast("No wake passphrase is set.", tone: .warn)
            return
        }
        guard settings.auth != .touchId || !LocalAuth.ownerAuthAvailable() else {
            state.toast("Wake authentication is set to \(LocalAuth.ownerAuthName()); the passphrase is not accepted.", tone: .warn)
            return
        }
        if let until = lockedUntil, until > Date() {
            publish(.lockedOut(until: until))
            return
        }
        Task { @MainActor [weak self] in
            let ok = await Task.detached(priority: .userInitiated) { LocalAuth.verify(phrase) }.value
            guard let self, WakeGate.listens(in: self.inputs.phase), self.connected, self.mode != .granting else { return }
            if ok {
                self.grant()
            } else {
                self.failures += 1
                if self.failures >= WakeGate.maxFailures { self.lockOut(after: "three failed attempts") } else { self.state.toast("Wrong passphrase.", tone: .warn) }
            }
        }
    }

    private func cancelAuth() {
        guard mode == .authenticating else { return }
        deny(reason: "cancelled", say: nil, countsAsFailure: false)
    }
}
