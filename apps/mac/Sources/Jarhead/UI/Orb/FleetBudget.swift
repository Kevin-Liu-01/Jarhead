import Foundation

/// The fleet's frame-cost ladder: the first real per-frame measurement the orb has.
/// Every fleet frame's wall time (every satellite stepped and rendered, on the main
/// thread) goes in; the rolling mean over `window` frames decides the rung — up one
/// when the mean is over `frameBudgetMs` (a fresh window each step, so the ladder
/// climbs at most one rung per `window` frames), and back to 0 once the mean of the
/// last `recoverWindow` frames has stayed under `recoverMs` for `recoverAfter`
/// seconds (the short window so a load that has ended is seen to have ended within
/// a few frames, not after thirty heavy samples have aged out; ten frames still ride
/// over the single-frame spikes the window server hands a moving panel). The way
/// down is bounded by the idle link: ten frames at 24 fps are 0.42 s, so 1.5 s of
/// `recoverAfter` puts the rung back at 0 inside 2 s of the load ending. The fleet
/// reads the rung:
///
///   0  full: the satellite fields at their phase rate, the halo every rendered frame
///   1  the satellite fields capped at 12 fps
///   2  the halo refined every other rendered frame (the CGImage is the expensive allocation)
///   3  the fleet's link asks 30 Hz while a satellite moves (the main blob's stays 60)
///   4  no third satellite: a thread past two is a notch dot only
///
/// `ORB_FLEET_BUDGET_LOG=1` prints the mean, the p95 and the rung once a second;
/// `ORB_FLEET_BUDGET_FORCE_MS` adds a synthetic load so the ladder can be seen to step.
struct FleetBudget {
    static let frameBudgetMs = 6.0
    static let recoverMs = 3.0
    static let window = 30
    static let recoverWindow = 10
    static let recoverAfter = 1.5
    static let maxRung = 4

    private(set) var rung = 0
    /// The rolling window, and how much of it has filled since the last step.
    private var samples = [Double](repeating: 0, count: FleetBudget.window)
    private var count = 0
    private var index = 0
    /// The last `recoverWindow` frames, whatever the step window holds.
    private var recent = [Double](repeating: 0, count: FleetBudget.recoverWindow)
    private var recentCount = 0
    private var recentIndex = 0
    /// When the recent mean first read under `recoverMs` (< 0: it does not).
    private var underSince = -1.0
    /// The last full window's mean, ms; 0 until one has filled.
    private(set) var mean = 0.0

    // The per-second readout (`line`): every sample since the last line.
    private var logSamples: [Double] = []
    private(set) var frames = 0

    /// One fleet frame cost `ms`. Returns true when the rung changed.
    mutating func note(ms: Double, now: Double) -> Bool {
        guard ms.isFinite, ms >= 0 else { return false }
        frames += 1
        logSamples.append(ms)
        samples[index] = ms
        index = (index + 1) % Self.window
        count = min(count + 1, Self.window)
        recent[recentIndex] = ms
        recentIndex = (recentIndex + 1) % Self.recoverWindow
        recentCount = min(recentCount + 1, Self.recoverWindow)
        let before = rung
        var recentMean = ms
        if recentCount == Self.recoverWindow {
            var r = 0.0
            for i in 0..<recentCount { r += recent[i] }
            recentMean = r / Double(recentCount)
        }

        // The way down: the recent mean under `recoverMs` for `recoverAfter`.
        if rung > 0, recentCount == Self.recoverWindow {
            if recentMean < Self.recoverMs {
                if underSince < 0 {
                    underSince = now
                } else if now - underSince >= Self.recoverAfter {
                    rung = 0
                    underSince = -1
                    count = 0
                    index = 0
                }
            } else {
                underSince = -1
            }
        }

        // The way up: the step window's mean over `frameBudgetMs` — and the recent
        // frames too, so a window that straddles a load's end does not climb on samples
        // that are already history.
        guard count == Self.window else { return rung != before }
        var sum = 0.0
        for i in 0..<count { sum += samples[i] }
        mean = sum / Double(count)
        if mean > Self.frameBudgetMs, recentMean > Self.frameBudgetMs, rung < Self.maxRung, rung == before {
            rung += 1
            underSince = -1
            // A fresh window before the next step: the rung that was just taken
            // must show in the numbers before another is.
            count = 0
            index = 0
        }
        return rung != before
    }

    /// The readout since the last call — "fleet budget: mean 1.8 ms p95 3.1 ms max 4.0 ms
    /// over 61 frames, rung 0" — and the samples cleared for the next second.
    mutating func line() -> String {
        defer { logSamples.removeAll(keepingCapacity: true) }
        guard !logSamples.isEmpty else { return "fleet budget: no frames, rung \(rung)" }
        let sorted = logSamples.sorted()
        let m = sorted.reduce(0, +) / Double(sorted.count)
        let p95 = sorted[min(sorted.count - 1, Int(Double(sorted.count) * 0.95))]
        return String(format: "fleet budget: mean %.2f ms p95 %.2f ms max %.2f ms over %d frames, rung %d", m, p95, sorted[sorted.count - 1], sorted.count, rung)
    }
}
