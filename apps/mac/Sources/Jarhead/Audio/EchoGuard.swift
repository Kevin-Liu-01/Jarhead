import Foundation

/// The software echo guard in the microphone tap: `EchoGuardModel` behind one lock, fed
/// from three threads — the tap (`judge`), the audio queue (`noteOutput` / `noteFlush`)
/// and the main queue (`frozen`, mute). Attached only while the plain graph runs
/// (Recording, or the fallback rung); detached, every call is a no-op and every verdict
/// is `.pass`. The ear hears the raw buffer before the verdict; only the wire is held.
final class EchoGuard: @unchecked Sendable {
    static let shared = EchoGuard()

    /// The counters the `mic diag` line and the state frame print.
    struct Stats: Equatable {
        var gated = 0
        var chunks = 0
        var holds = 0
        var breakthroughs = 0
        var heldSeconds = 0.0
    }

    /// The hold began or ended (the tap thread). The engine publishes a state frame on it.
    var onHeldChange: ((Bool) -> Void)?

    private let lock = NSLock()
    private var model: EchoGuardModel?
    private var gated = 0
    private var chunks = 0
    private var frozenFlag = false

    /// Mute: this process's input is zeroed at the HAL, so there is nothing to judge — the
    /// machine stands still (no learning from silence) until unmute.
    var frozen: Bool {
        get { lock.lock(); defer { lock.unlock() }; return frozenFlag }
        set { lock.lock(); frozenFlag = newValue; lock.unlock() }
    }

    var isAttached: Bool {
        lock.lock(); defer { lock.unlock() }
        return model != nil
    }

    var isHeld: Bool {
        lock.lock(); defer { lock.unlock() }
        return model?.isHeld ?? false
    }

    var tailSeconds: Double {
        lock.lock(); defer { lock.unlock() }
        return model?.tail ?? 0
    }

    var stats: Stats {
        lock.lock(); defer { lock.unlock() }
        let m = model
        return Stats(gated: gated, chunks: chunks, holds: m?.stats.holds ?? 0, breakthroughs: m?.stats.breakthroughs ?? 0, heldSeconds: m?.heldSeconds ?? 0)
    }

    /// The plain graph is up: guard the wire with this tail (seconds).
    func attach(tail: Double) {
        lock.lock()
        model = EchoGuardModel(tail: tail)
        gated = 0
        chunks = 0
        lock.unlock()
    }

    func detach() {
        lock.lock()
        let wasHeld = model?.isHeld ?? false
        model = nil
        lock.unlock()
        if wasHeld { onHeldChange?(false) }
    }

    /// What the speaker is about to play (the audio queue).
    func noteOutput(rms: Double, seconds: Double) {
        lock.lock()
        model?.noteOutput(rms: rms, seconds: seconds, now: CFAbsoluteTimeGetCurrent())
        lock.unlock()
    }

    /// The speaker backlog was dropped.
    func noteFlush() {
        lock.lock()
        model?.noteFlush(now: CFAbsoluteTimeGetCurrent())
        lock.unlock()
    }

    /// The mono tap buffer (the tap thread), sliced into 10 ms pieces through the model;
    /// `.hold` if any slice held. Counts the buffer as one wire chunk.
    func judge(mono: UnsafePointer<Float>, frames: Int, sampleRate: Double) -> EchoGuardModel.Verdict {
        guard frames > 0, sampleRate > 0 else { return .pass }
        lock.lock()
        guard var m = model, !frozenFlag else { lock.unlock(); return .pass }
        let wasHeld = m.isHeld
        let now = CFAbsoluteTimeGetCurrent()
        let slice = max(1, Int(sampleRate * EchoGuardModel.sliceSeconds))
        var verdict = EchoGuardModel.Verdict.pass
        var offset = 0
        while offset < frames {
            let n = min(slice, frames - offset)
            var acc = 0.0
            for i in offset ..< offset + n { acc += Double(mono[i] * mono[i]) }
            if m.step(rms: (acc / Double(n)).squareRoot(), now: now) == .hold { verdict = .hold }
            offset += n
        }
        chunks += 1
        if verdict == .hold { gated += 1 }
        let held = m.isHeld
        model = m
        lock.unlock()
        if held != wasHeld { onHeldChange?(held) }
        return verdict
    }

    /// For the `mic diag` line: ` · guard held 3.2 s · gated 12 of 340 · 1 break · tail 420 ms`; empty while detached.
    func diagSuffix() -> String {
        lock.lock()
        let m = model
        let g = gated, c = chunks
        lock.unlock()
        guard let m else { return "" }
        let held = String(format: "%.1f", m.heldSeconds)
        let breaks = m.stats.breakthroughs == 1 ? "1 break" : "\(m.stats.breakthroughs) breaks"
        return " · guard held \(held) s · gated \(g) of \(c) · \(breaks) · tail \(Int((m.tail * 1000).rounded())) ms"
    }
}
