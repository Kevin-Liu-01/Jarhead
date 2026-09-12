import AppKit
import QuartzCore
import SwiftUI

/// The one motion vocabulary for the app. Every transition — the notch island, the
/// blob's tuck and drop, flights, the capsule, the Console's views, toasts and pills,
/// the overlay's shapes — picks from here, so the whole thing moves like one object.
///
/// Rules of thumb:
///   - Things that follow the hand or answer a press use `quick`/`snappy`; things that
///     happen on their own (a phase change, a settle) use `base`/`gentle`.
///   - Enter eases out (arrive fast, settle soft); exit eases in (leave gaining speed);
///     a move from A to B eases in-out.
///   - Nothing cuts. A value that changes gets a transition; a view that appears fades
///     and rises a few points; a view that leaves fades and drops.
///   - Reduce Motion (`Motion.reduced`) halves durations, removes overshoot and
///     replaces slides with plain fades; the app stays usable, just stiller.
enum Motion {
    // MARK: durations (seconds)

    /// A press being felt, a hover state.
    static let instant = 0.08
    /// Something answering the hand: a toggle, a selection, a button's fill.
    static let quick = 0.16
    /// The default for anything that moves on its own: a view switch, a fade.
    static let base = 0.24
    /// A larger change of state: the capsule opening, a panel arriving.
    static let slow = 0.40
    /// Ambient: a drift, a breath, a colour crossfade.
    static let drift = 0.60

    // MARK: durations (the blob)

    /// The crouch before a flight: a squash toward the target, then the launch. None under Reduce Motion.
    static let anticipation = 0.07
    /// The blink an expression change goes through: lids down, the new glyph behind them, lids up.
    static let blink = 0.09
    /// The last stretch into the notch: the body rises under the ink, shrinking and fading, while
    /// the notch face comes up in its place. Halved under Reduce Motion (which takes the instant path anyway).
    static let tuckSlip = slow
    /// Out of the notch: the body appears small and clear under the ink and grows in as it hops down.
    static let dropOut = base
    /// The most one row waits on the row before it when a list staggers in.
    static let stagger = 0.03

    // MARK: curves (Core Animation)

    /// Arrive fast, settle soft — for anything entering or answering a press.
    static let easeOut = CAMediaTimingFunction(controlPoints: 0.16, 1, 0.3, 1)
    /// Leave gaining speed — for anything exiting.
    static let easeIn = CAMediaTimingFunction(controlPoints: 0.7, 0, 0.84, 0)
    /// A to B — for a move between two resting places.
    static let easeInOut = CAMediaTimingFunction(controlPoints: 0.65, 0, 0.35, 1)

    // MARK: curves as numbers (display-link driven code)

    /// The same cubic Bézier as a CAMediaTimingFunction, evaluated by hand, for motion
    /// that is stepped per frame instead of handed to Core Animation (the blob's slip
    /// into the notch, its hop out). `value(at:)` maps progress 0…1 to 0…1.
    struct Curve {
        let p1x: Double, p1y: Double, p2x: Double, p2y: Double
        init(_ p1x: Double, _ p1y: Double, _ p2x: Double, _ p2y: Double) {
            self.p1x = p1x; self.p1y = p1y; self.p2x = p2x; self.p2y = p2y
        }
        private func bezier(_ t: Double, _ a: Double, _ b: Double) -> Double {
            let u = 1 - t
            return 3 * u * u * t * a + 3 * u * t * t * b + t * t * t
        }
        func value(at x: Double) -> Double {
            let x = min(1, max(0, x))
            if x <= 0 { return 0 }
            if x >= 1 { return 1 }
            // Newton–Raphson on the x polynomial, seeded with x itself; the curves in
            // use are monotonic in x, so a handful of steps lands within a pixel.
            var t = x
            for _ in 0..<8 {
                let fx = bezier(t, p1x, p2x) - x
                let u = 1 - t
                let dx = 3 * u * u * p1x + 6 * u * t * (p2x - p1x) + 3 * t * t * (1 - p2x)
                if abs(dx) < 1e-6 { break }
                let next = t - fx / dx
                if abs(next - t) < 1e-5 { t = next; break }
                t = min(1, max(0, next))
            }
            return bezier(t, p1y, p2y)
        }
    }

    /// `easeOut`, `easeIn` and `easeInOut` above, as numbers.
    static let easeOutCurve = Curve(0.16, 1, 0.3, 1)
    static let easeInCurve = Curve(0.7, 0, 0.84, 0)
    static let easeInOutCurve = Curve(0.65, 0, 0.35, 1)

    // MARK: springs (SwiftUI)

    /// Answers the hand: selection, toggles, the segmented thumb.
    static var snappy: Animation { reduced ? .easeOut(duration: quick / 2) : .spring(response: 0.28, dampingFraction: 0.82) }
    /// Moves on its own: a view switch, a card arriving.
    static var gentle: Animation { reduced ? .easeInOut(duration: base / 2) : .spring(response: 0.42, dampingFraction: 0.90) }
    /// A little life: the capsule popping open, a toast landing.
    static var bouncy: Animation { reduced ? .easeOut(duration: base / 2) : .spring(response: 0.36, dampingFraction: 0.70) }
    /// A plain fade at `base`.
    static var fade: Animation { .easeInOut(duration: reduced ? base / 2 : base) }

    // MARK: springs (display-link driven, stiffness/damping)

    struct SpringSpec {
        let stiffness: Double
        let damping: Double
        /// A spring with a damping ratio: 1 is critically damped, < 1 overshoots a little.
        static func of(stiffness: Double, ratio: Double) -> SpringSpec {
            SpringSpec(stiffness: stiffness, damping: 2 * stiffness.squareRoot() * ratio)
        }
    }

    /// The notch island growing and shrinking.
    static var island: SpringSpec { .of(stiffness: 520, ratio: reduced ? 1.0 : 0.78) }
    /// The blob answering a poke or a press — and catching a flight on its last stretch,
    /// so a landing settles instead of slamming.
    static var body: SpringSpec { .of(stiffness: 380, ratio: reduced ? 1.0 : 0.72) }
    /// The blob's way to bed: the approach to the notch, all but critically damped — it
    /// decelerates to rest under the ink with no swing back anyone could see (ζ 0.94:
    /// from rest an overshoot of 0.02%), and without a critically damped spring's long
    /// crawl. A long approach runs at `GoalSpring.tuck`'s speed cap for a while, which
    /// breaks the spring's phase: it comes to rest a few points short of the staging
    /// point rather than on it, still moving at a few dozen pt/s (under a pixel a frame)
    /// when the settle's catch takes it — and the slip starts from wherever that is.
    static var approach: SpringSpec { .of(stiffness: 30, ratio: reduced ? 1.0 : 0.94) }

    // MARK: transitions (SwiftUI)

    /// A view arriving: fade + rise 6 pt; leaving: fade + drop 4 pt. Plain fade under Reduce Motion.
    static var appear: AnyTransition {
        if reduced { return .opacity }
        return .asymmetric(insertion: .opacity.combined(with: .offset(y: 6)), removal: .opacity.combined(with: .offset(y: 4)))
    }

    /// Switching between two views that occupy the same place.
    static var swap: AnyTransition {
        if reduced { return .opacity }
        return .asymmetric(insertion: .opacity.combined(with: .offset(y: 4)), removal: .opacity)
    }

    // MARK: reduce motion

    /// The system's Reduce Motion setting, read live — or `reducedOverride` when a
    /// harness pins it (the orb preview's ORB_REDUCE_MOTION), so every path that asks
    /// here sees the same answer as the blob's sim.
    static var reduced: Bool { reducedOverride ?? NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }
    /// Pinned by a preview harness only; nil in the app.
    static var reducedOverride: Bool?

    /// A duration honouring Reduce Motion.
    static func seconds(_ d: Double) -> Double { reduced ? d / 2 : d }

    /// Run an AppKit animation group with one of the curves above.
    static func animate(_ duration: Double, curve: CAMediaTimingFunction = Motion.easeOut, _ body: () -> Void, completion: (() -> Void)? = nil) {
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = seconds(duration)
            ctx.timingFunction = curve
            ctx.allowsImplicitAnimation = true
            body()
        }, completionHandler: completion)
    }
}
