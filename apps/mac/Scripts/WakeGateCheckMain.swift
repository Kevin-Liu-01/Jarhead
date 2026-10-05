import Foundation

// The wake gate under test (WG-12; the wake audit's harness of 2026-10-04, moved into the repo).
// Drives the REAL Wake/WakeGate.swift, Model/AppState.swift + Model/Protocol.swift and the REAL
// passphrase half of Wake/LocalAuth.swift (PBKDF2, the 0600 record, normalisation). The gate's
// three seams are scripted here: the recogniser (`WakeListening`: no microphone, no
// SFSpeechRecognizer), the voice (`WakeSpeaking`: records, plays nothing) and the owner sheet
// (`OwnerFactor`: scripted answers, no LAContext, so no Touch ID sheet can appear). The gate
// runs on a short clock (`WakeGate.Timing`); `seams` pins the shipped one.
//
// The passphrase record lives under JARHEAD_STATE_DIR, which Scripts/wake-gate-check.sh points
// at a fresh temp dir; the check refuses to run without it. Each scenario prints `check:` lines,
// "ok" or "FAIL" first; exit 1 on a FAIL.
//   Scripts/wake-gate-check.sh                    # every scenario
//   Scripts/wake-gate-check.sh owner-retrigger    # one or more by name

nonisolated(unsafe) var failures = 0
func check(_ ok: Bool, _ what: String, _ detail: @autoclosure () -> String = "") {
    if !ok { failures += 1 }
    print("check: \(ok ? "ok" : "FAIL") \(what)\(ok || detail().isEmpty ? "" : " (\(detail()))")")
}

/// The recogniser, scripted. Segments are numbered upward for the listener's whole life, as
/// `SegmentedRecognizer` numbers them: a start opens one, a roll opens the next.
final class ScriptedListener: WakeListening {
    var onTranscript: ((String, Bool, Int) -> Void)?
    var onStatus: ((WakeWordListener.Status) -> Void)?
    private(set) var running = false
    private(set) var segment = 0
    private(set) var starts = 0
    private(set) var rolls = 0
    func start() { running = true; starts += 1; segment += 1 }
    func stop() { running = false }
    func setContextualStrings(_ strings: [String]) {}
    func rollSegment(_ completion: @escaping (Int?) -> Void) {
        guard running else { DispatchQueue.main.async { completion(nil) }; return }
        segment += 1
        rolls += 1
        let seg = segment
        DispatchQueue.main.async { completion(seg) }
    }
    /// What the recogniser delivers: the cumulative text of the live segment.
    func hear(_ text: String, final: Bool = false) { onTranscript?(text, final, segment) }
    /// The recogniser revising an older segment after a roll, as a cancelled task still does.
    func revise(_ text: String, inSegment old: Int, final: Bool = false) { onTranscript?(text, final, old) }
}

/// The voice, recorded. Never a sound.
final class RecordingSpeaker: WakeSpeaking {
    var said: [String] = []
    var earcons: [String] = []
    func isQuiet(now: Date) -> Bool { true }
    func speak(_ text: String) { said.append(text) }
    func stop() {}
    func earcon(_ name: String) { earcons.append(name) }
}

/// The owner sheet, scripted: whether a factor exists, what the sheet answers and after how long.
final class ScriptedOwner: OwnerFactor {
    var exists = false
    var answer = false
    var delay: Double = 0.05
    private(set) var sheets = 0
    func available() -> Bool { exists }
    func name() -> String { "Touch ID" }
    func prompt() -> OwnerPrompt {
        sheets += 1
        return ScriptedSheet(answer: answer, delay: delay)
    }
}

final class ScriptedSheet: OwnerPrompt, @unchecked Sendable {
    private let answer: Bool
    private let delay: Double
    private let lock = NSLock()
    private var cancelled = false
    init(answer: Bool, delay: Double) { self.answer = answer; self.delay = delay }
    func evaluate(reason: String) async -> Bool {
        try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
        return isCancelled() ? false : answer
    }
    func cancel() { lock.lock(); cancelled = true; lock.unlock() }
    private func isCancelled() -> Bool { lock.lock(); defer { lock.unlock() }; return cancelled }
}

final class Box<T> { var v: T; init(_ v: T) { self.v = v } }

/// The short clock. Three spoken attempts (a PBKDF2 verify each, ~0.3 s) fit one prompt.
let clock = WakeGate.Timing(authTimeout: 4, unansweredWindow: 40, lockout: 3, cooldown: 0.5, candidateSettle: 0.3, grantWatchdog: 12)

@MainActor
struct Rig {
    let state: AppState
    let gate: WakeGate
    let mic: ScriptedListener
    let voice: RecordingSpeaker
    let owner: ScriptedOwner
    let sent: Box<[EngineCommand]>
    var gos: Int { sent.v.filter { $0 == .go }.count }
    var locked: Bool { if case .lockedOut = state.wakeGate { return true } else { return false } }
    var authenticating: Bool { state.wakeGate.isAuthenticating }
    var denied: Bool { if case .denied = state.wakeGate { return true } else { return false } }
}

@MainActor
func rig(auth: WakeAuth, phase: Phase = .asleep, phrases: [String] = ["jarhead", "jar head", "hey jarhead"],
         ownerExists: Bool = false, ownerAnswer: Bool = false, audio: Bool = true) -> Rig {
    let state = AppState()
    var s = Snapshot.empty
    s.phase = phase
    s.settings.wake = WakeSettings(enabled: true, phrases: phrases, auth: auth)
    state.snapshot = s
    state.connected = true
    let sent = Box<[EngineCommand]>([])
    state.sendHandler = { sent.v.append($0) }
    let mic = ScriptedListener()
    let voice = RecordingSpeaker()
    let owner = ScriptedOwner()
    owner.exists = ownerExists
    owner.answer = ownerAnswer
    let gate = WakeGate(state: state, listener: mic, speaker: voice, owner: owner, timing: clock, audioEnabled: audio)
    gate.setMicrophone(granted: true)
    gate.setSpeechRecognition(authorized: true, detail: "check")
    return Rig(state: state, gate: gate, mic: mic, voice: voice, owner: owner, sent: sent)
}

func pump(_ seconds: Double) async { try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) }

/// Wait until `cond` holds, up to `timeout` seconds; true if it did.
@MainActor
func until(_ timeout: Double, _ cond: () -> Bool) async -> Bool {
    let end = Date().addingTimeInterval(timeout)
    while Date() < end {
        if cond() { return true }
        await pump(0.02)
    }
    return cond()
}

@main
struct WakeGateCheck {
    @MainActor
    static func main() async {
        let stateDir = ((ProcessInfo.processInfo.environment["JARHEAD_STATE_DIR"] ?? "") as NSString).standardizingPath
        let realState = (NSHomeDirectory() as NSString).appendingPathComponent(".jarhead")
        guard !stateDir.isEmpty, !stateDir.hasPrefix(realState), LocalAuth.fileURL.path.hasPrefix(stateDir) else {
            print("refusing to run: JARHEAD_STATE_DIR must be a temp dir (got '\(stateDir)'); use Scripts/wake-gate-check.sh")
            exit(2)
        }
        let only = Set(CommandLine.arguments.dropFirst())
        func on(_ name: String) -> Bool { only.isEmpty || only.contains(name) }
        LocalAuth.clearPassphrase()

        if on("seams") {
            print("== seams: the shipped clock, JARHEAD_NO_AUDIO, and the check's own clock")
            let t = WakeGate.Timing.standard
            check(t.authTimeout == 15 && t.unansweredWindow == 120 && t.lockout == 60 && t.cooldown == 2.5,
                  "the shipped clock: 15 s to answer, three unanswered in 120 s, a 60 s lock, a 2.5 s cooldown", "\(t)")
            check(!WakeGate.audioEnabled(["JARHEAD_NO_AUDIO": "1"]) && WakeGate.audioEnabled([:]),
                  "JARHEAD_NO_AUDIO=1 keeps the gate off, anything else leaves it on")
            let r = rig(auth: .passphrase, audio: false)
            check(r.state.wakeGate == .off(reason: "audio disabled (JARHEAD_NO_AUDIO)") && r.mic.starts == 0,
                  "with audio off the gate is off and the listener never starts", "\(r.state.wakeGate), starts=\(r.mic.starts)")
            let on = rig(auth: .passphrase)
            check(on.state.wakeGate == .listening && on.mic.running, "with audio on the gate listens", "\(on.state.wakeGate)")
        }

        if on("pbkdf2") {
            print("== pbkdf2: README:42 'a passphrase (PBKDF2)'; apps/mac/README '200 000 rounds, random salt, mode 0600'; 'punctuation and case never matter'")
            do { try LocalAuth.setPassphrase("Open, Sesame! Banana") } catch { check(false, "enrol", "\(error)") }
            let attrs = try? FileManager.default.attributesOfItem(atPath: LocalAuth.fileURL.path)
            let mode = (attrs?[.posixPermissions] as? NSNumber)?.intValue ?? -1
            check(mode == 0o600, "record is mode 0600", String(format: "mode %o", mode))
            let rec = (try? JSONSerialization.jsonObject(with: Data(contentsOf: LocalAuth.fileURL))) as? [String: Any] ?? [:]
            check((rec["rounds"] as? Int) == 200_000, "rounds = 200000", "\(rec["rounds"] ?? "nil")")
            check(Data(base64Encoded: rec["salt"] as? String ?? "")?.count == 16, "salt is 16 bytes")
            check(Data(base64Encoded: rec["hash"] as? String ?? "")?.count == 32, "hash is 32 bytes")
            check(rec.keys.sorted() == ["hash", "rounds", "salt", "words"], "no plaintext field in the record", "\(rec.keys.sorted())")
            let raw = (try? String(contentsOf: LocalAuth.fileURL, encoding: .utf8)) ?? ""
            check(!raw.lowercased().contains("sesame"), "plaintext never written")
            let t0 = Date()
            check(LocalAuth.verify("open sesame banana"), "normalised phrase verifies")
            print(String(format: "  measure: one verify %.0f ms", Date().timeIntervalSince(t0) * 1000))
            check(LocalAuth.verify("OPEN... sesame -- banana!!"), "case and punctuation ignored")
            check(!LocalAuth.verify("open sesame bananas"), "a near miss fails")
            check(!LocalAuth.verify(""), "empty fails")
            do { try LocalAuth.setPassphrase("hello"); check(false, "one-word phrase refused") } catch { check(true, "one-word phrase refused") }
            check(LocalAuth.verify("open sesame banana"), "a refused enrolment leaves the old record")
            try? LocalAuth.setPassphrase("open sesame banana")
            let rec2 = (try? JSONSerialization.jsonObject(with: Data(contentsOf: LocalAuth.fileURL))) as? [String: Any] ?? [:]
            check((rec2["salt"] as? String) != (rec["salt"] as? String), "re-enrolment draws a new random salt")
        }

        if on("boundaries") {
            print("== boundaries: apps/mac/README 'any of settings.wake.phrases on word boundaries'")
            LocalAuth.clearPassphrase()
            let r = rig(auth: .passphrase) // no passphrase, no owner: a heard word ends in the 'nothing to check' denial
            r.mic.hear("the jarheads were marching")
            await pump(0.1)
            check(r.voice.earcons.isEmpty, "'jarheads' is not the word")
            r.mic.hear("the jarheads were marching hey jarhead")
            await pump(0.1)
            check(r.voice.earcons == ["Pop"], "'hey jarhead' is heard once", "\(r.voice.earcons)")
            check(r.gos == 0, "with nothing to authenticate against, nothing opens", "gos=\(r.gos)")
            check(r.voice.said.contains("I can't check it's you. Set a passphrase first."), "says why it stays shut")
        }

        if on("spoken-lockout") {
            print("== spoken-lockout: README:42 'Three misses lock the gate for a minute'")
            try? LocalAuth.setPassphrase("open sesame banana")
            let r = rig(auth: .passphrase)
            r.mic.hear("jarhead")
            _ = await until(1) { r.authenticating }
            await pump(0.1) // the answer segment opens after the prompt
            for attempt in 1...3 {
                check(r.authenticating, "attempt \(attempt): the prompt is open", "\(r.state.wakeGate)")
                r.mic.hear("close sesame banana", final: true)
                if attempt < 3 {
                    _ = await until(3) { r.voice.said.filter { $0 == "No." }.count == attempt }
                    await pump(0.1)
                } else {
                    _ = await until(3) { r.locked }
                }
            }
            check(r.locked, "three wrong spoken answers lock the gate", "\(r.state.wakeGate)")
            check(r.voice.said.last == "Locked for a minute.", "says 'Locked for a minute.'", "\(r.voice.said)")
            let promptsBefore = r.voice.said.filter { $0 == "Password?" }.count
            r.mic.hear("jarhead"); await pump(0.1)
            r.mic.hear("jarhead open sesame banana", final: true); await pump(0.6)
            check(r.voice.said.filter { $0 == "Password?" }.count == promptsBefore, "the word during the lock opens no prompt")
            r.state.wakeActions.submitPassphrase("open sesame banana"); await pump(0.6)
            check(r.gos == 0, "the right phrase typed during the lock opens nothing", "gos=\(r.gos)")
            check(r.gate.requestWake(source: "jarhead://go") && r.gos == 0, "jarhead://go during the lock opens nothing")
        }

        if on("spoken-grant") {
            print("== spoken-grant: the right spoken phrase opens the session once")
            try? LocalAuth.setPassphrase("open sesame banana")
            let r = rig(auth: .passphrase)
            r.mic.hear("hey jarhead")
            _ = await until(1) { r.authenticating }
            await pump(0.1)
            r.mic.hear("um open sesame banana", final: true)
            _ = await until(3) { r.gos > 0 }
            await pump(0.1)
            check(r.gos == 1, "one go after the phrase (filler tolerated)", "gos=\(r.gos) \(r.state.wakeGate)")
            check(r.mic.running == false, "the listener let go of the mic at the grant")
        }

        if on("typed-lockout") {
            print("== typed-lockout: three wrong typed phrases lock; the right one is then refused")
            try? LocalAuth.setPassphrase("open sesame banana")
            let r = rig(auth: .passphrase)
            for _ in 1...3 { r.state.wakeActions.submitPassphrase("nope nope nope"); await pump(0.6) }
            check(r.locked, "three wrong typed phrases lock", "\(r.state.wakeGate)")
            r.state.wakeActions.submitPassphrase("open sesame banana"); await pump(0.6)
            check(r.gos == 0, "the right one during the lock opens nothing", "gos=\(r.gos)")
        }

        if on("owner-retrigger") {
            print("== owner-retrigger (WG-6): auth either, no passphrase, so the owner sheet alone. One utterance, one sheet.")
            LocalAuth.clearPassphrase()
            let r = rig(auth: .either, ownerExists: true, ownerAnswer: false) // every sheet answers 'Not now'
            let heardIn = r.mic.segment // read first: hearing the word rolls the listener
            r.mic.hear("hey jarhead")
            check(await until(1) { r.owner.sheets == 1 }, "the word pops one sheet", "sheets=\(r.owner.sheets)")
            _ = await until(2) { r.denied }
            await pump(clock.cooldown + 0.3) // the denial's cooldown; the gate is listening again
            // Nobody says anything new. The recogniser revises the words it already sent, as it does:
            // "hey jarhead" becomes "hey jar head", and the match ends one character later.
            r.mic.revise("hey jar head", inSegment: heardIn); await pump(0.3)
            check(r.owner.sheets == 1, "a revision of the same words pops no second sheet",
                  "sheets=\(r.owner.sheets): the match moved past consumedUpTo and the dismissed sheet came back, a second miss counted")
            r.mic.revise("hey jar head", inSegment: heardIn, final: true); await pump(0.3)
            check(r.owner.sheets == 1, "the old segment's late final pops no sheet either", "sheets=\(r.owner.sheets)")
            check(r.state.wakeGate == .listening, "one utterance, one miss: listening again, not locked", "\(r.state.wakeGate)")
            r.mic.hear("jarhead")
            check(await until(1) { r.owner.sheets == 2 }, "a new word after the cooldown pops the sheet again: the roll deafens nothing",
                  "sheets=\(r.owner.sheets), segment \(r.mic.segment) vs \(heardIn)")
        }

        if on("revision-in-cooldown") {
            print("== revision-in-cooldown (WG-6): the revision lands during the cooldown, then silence")
            LocalAuth.clearPassphrase()
            let r = rig(auth: .either, ownerExists: true, ownerAnswer: false)
            let heardIn = r.mic.segment
            r.mic.hear("hey jarhead")
            _ = await until(2) { r.denied }
            r.mic.revise("hey jar head", inSegment: heardIn); await pump(0.1)
            await pump(clock.cooldown + 0.4)
            check(r.owner.sheets == 1, "a revision held through the cooldown pops no second sheet", "sheets=\(r.owner.sheets)")
        }

        if on("paused") {
            print("== paused: README:43 'Go, or the wake word, resumes'; no auth asked twice for one conversation")
            try? LocalAuth.setPassphrase("open sesame banana")
            let r = rig(auth: .either, phase: .paused, ownerExists: true, ownerAnswer: false)
            r.mic.hear("say jarhead to resume"); await pump(0.2)
            check(r.gos == 1 && r.owner.sheets == 0, "the word while paused resumes: one go, no sheet", "gos=\(r.gos), sheets=\(r.owner.sheets)")
            let r2 = rig(auth: .either, phase: .paused, ownerExists: true, ownerAnswer: false)
            _ = r2.gate.requestWake(source: "jarhead://go"); await pump(0.2)
            check(r2.gos == 1 && r2.owner.sheets == 0, "jarhead://go while paused resumes the same way", "gos=\(r2.gos)")
            let r3 = rig(auth: .either, phase: .paused, ownerExists: true, ownerAnswer: false)
            r3.state.wakeActions.submitPassphrase("x"); await pump(0.2)
            check(r3.gos == 1, "a typed line while paused resumes; no passphrase is asked for", "gos=\(r3.gos)")
        }

        if on("unanswered") {
            print("== unanswered: no answer → 'Never mind.'; three unanswered inside the window lock")
            try? LocalAuth.setPassphrase("open sesame banana")
            let r = rig(auth: .passphrase)
            let t0 = Date()
            for i in 1...3 {
                r.mic.hear(String(repeating: "x ", count: i) + "jarhead"); await pump(0.2)
                await pump(clock.authTimeout + 0.3)
                if i < 3 {
                    check(r.voice.said.last == "Never mind.", "prompt \(i) closes with 'Never mind.' at the timeout", "\(r.voice.said)")
                    await pump(clock.cooldown + 0.2)
                }
            }
            check(r.locked, "three unanswered prompts lock", "\(r.state.wakeGate)")
            print(String(format: "  measure: %.1f s for three unanswered prompts (a %.0f s clock)", Date().timeIntervalSince(t0), clock.authTimeout))
        }

        if on("lock-minute") {
            print("== lock-minute: the lock lifts after its time (a minute when shipped)")
            try? LocalAuth.setPassphrase("open sesame banana")
            let r = rig(auth: .passphrase)
            for _ in 1...3 { r.state.wakeActions.submitPassphrase("nope nope nope"); await pump(0.5) }
            check(r.locked, "locked")
            await pump(clock.lockout - 1.5)
            check(r.locked, "still locked just before the lock's end")
            check(await until(3) { r.state.wakeGate == .listening }, "listening again after the lock", "\(r.state.wakeGate)")
            r.mic.hear("jarhead")
            check(await until(1) { r.authenticating }, "the word prompts again after the lock", "\(r.state.wakeGate)")
        }

        LocalAuth.clearPassphrase()
        print(failures == 0 ? "wake-gate-check: all ok" : "wake-gate-check: \(failures) FAIL")
        exit(failures == 0 ? 0 : 1)
    }
}
