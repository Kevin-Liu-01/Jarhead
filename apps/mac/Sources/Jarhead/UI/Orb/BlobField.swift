import AppKit
import QuartzCore

// The blob: an ASCII field whose silhouette is a sum of wandering harmonics, drawn
// in one colour per phase, squished by spring-damped contacts, glowing.
//
// A faithful port of legacy/packages/overlay/src/renderer/overlay.js (the v1
// Electron buddy) onto a plain NSView with CoreGraphics glyph drawing:
//  * `BlobSim` owns every mutable animation value and turns (phase, levels,
//    contacts, lean, time) into a 27×15 grid of ramp indices, a matching halo
//    coverage mask, and two eyes (a blob with eyes is a creature; without, a
//    loading indicator).
//  * `BlobFieldView` runs one CADisplayLink for the whole orb (physics ticks at
//    display rate, the field re-renders at 10–24 fps like v1) and stops entirely
//    when nothing moves, when muted, when fast asleep, or when the panel is hidden.
//  * Glyphs are drawn with CGContext.showGlyphs — one call per font per pass — and
//    the glow is the halo mask, refined on the CPU to a 108×60 image and scaled the
//    rest of the way by the render server as a CALayer's contents (`BlobHaloView`),
//    so a frame costs about a millisecond and stays crisp on Retina. No blur
//    anywhere: a Gaussian per frame was half the CPU of the first port.

// MARK: - Colour

/// Linear-ish sRGB in 0…1, eased per channel during phase changes.
struct RGB: Equatable {
    var r: Double, g: Double, b: Double

    init(_ r: Double, _ g: Double, _ b: Double) { self.r = r; self.g = g; self.b = b }

    init(hex: UInt32) {
        r = Double((hex >> 16) & 0xff) / 255
        g = Double((hex >> 8) & 0xff) / 255
        b = Double(hex & 0xff) / 255
    }

    func mixed(with other: RGB, _ t: Double) -> RGB {
        let k = min(max(t, 0), 1)
        return RGB(r + (other.r - r) * k, g + (other.g - g) * k, b + (other.b - b) * k)
    }

    func cgColor(alpha: Double = 1) -> CGColor { CGColor(srgbRed: r, green: g, blue: b, alpha: alpha) }
    var cgColor: CGColor { cgColor(alpha: 1) }
}

/// The design-language phase palette (matches legacy/shell-electron-v2/src/renderer/shared/tokens.css).
enum OrbPalette {
    static let ground = RGB(hex: 0x0b0c10)
    static let text = RGB(hex: 0xe8eaf0)
    static let listening = RGB(hex: 0x5ad7ff)
    static let speaking = RGB(hex: 0xffb454)
    static let thinking = RGB(hex: 0xb48cff)
    static let acting = RGB(hex: 0x6ee7a0)
    static let error = RGB(hex: 0xff5d6c)
    static let asleep = RGB(hex: 0x7a6a5a)
    static let muted = RGB(hex: 0x6b7280)
    static let connecting = RGB(hex: 0x9fb4c8)
    /// The house accent, spent on exactly one thing here — the wake gate asking who is
    /// there. Light `#2f5ce0`, dark its lift `#5b82ff`: the blob sits on the desktop
    /// (its halo backing is faint) beside a capsule and pill in the same accent, so it
    /// follows the appearance the way they do (`BlobSim.darkAppearance`).
    static let accentLight = RGB(hex: 0x2f5ce0)
    static let accentDark = RGB(hex: 0x5b82ff)
    static func accent(dark: Bool) -> RGB { dark ? accentDark : accentLight }

    static func color(for phase: Phase) -> RGB {
        switch phase {
        case .asleep: return asleep
        case .connecting: return connecting
        case .listening: return listening
        case .speaking: return speaking
        case .thinking: return thinking
        case .acting: return acting
        case .muted: return muted
        case .error: return error
        }
    }
}

// MARK: - Personality

/// Glyph ramps, sparse to solid. Same field, different alphabet: a blob made of
/// braille-ish waves reads as a different creature from one made of hashes.
enum BlobRamp: Int, CaseIterable {
    case soft, sharp, dense, wave

    var glyphs: [Character] {
        switch self {
        case .soft: return Array(" ..::--~~==++**##%%@@")
        case .sharp: return Array(" ..'':;!|/\\<>()[]{}#%@")
        case .dense: return Array(" .:-=+*#%@&$8B0QMW")
        case .wave: return Array(" ....~~~≈≈≈≋≋≋∿∿∿◊◊◊●●")
        }
    }
}

/// Per-phase character of the motion (v1's SHAPE table, mapped onto the app's phases).
///
///  amp    how far the surface wanders from a circle
///  speed  how fast the wandering evolves
///  churn  how violently the harmonics get re-randomised
///  pull   how strongly the body leans toward free space
///  squash vertical bias: >1 tall and alert, <1 wide and settled
///  spin   slow rotation of the whole silhouette
///  jitter random centre offset in cells (the error buzz)
///  glow   base glow intensity, 0…1
///  fps    field frame rate while nothing else is happening
struct BlobPersonality {
    var amp: Double
    var speed: Double
    var churn: Double
    var pull: Double
    var squash: Double
    var spin: Double
    var jitter: Double
    var glow: Double
    var ramp: BlobRamp
    var fps: Double

    static func forPhase(_ p: Phase) -> BlobPersonality {
        switch p {
        case .asleep:      // v1 idle: barely awake, wide, slow, settled.
            return BlobPersonality(amp: 0.30, speed: 0.45, churn: 0.5, pull: 0.10, squash: 0.90, spin: 0.05, jitter: 0, glow: 0.30, ramp: .soft, fps: 10)
        case .connecting:  // waking up: a dimmer, calmer "listening".
            return BlobPersonality(amp: 0.36, speed: 1.0, churn: 1.0, pull: 0.12, squash: 1.05, spin: 0.10, jitter: 0, glow: 0.40, ramp: .soft, fps: 20)
        case .listening:   // perked up: taller, quicker, alive.
            return BlobPersonality(amp: 0.42, speed: 1.5, churn: 1.5, pull: 0.16, squash: 1.15, spin: 0.15, jitter: 0, glow: 0.60, ramp: .soft, fps: 24)
        case .speaking:    // talking: wide pulses, softer edge, like a mouth.
            return BlobPersonality(amp: 0.52, speed: 3.0, churn: 3.0, pull: 0.14, squash: 0.85, spin: 0.10, jitter: 0, glow: 0.65, ramp: .wave, fps: 24)
        case .thinking:    // churning: dense, agitated, mathematical.
            return BlobPersonality(amp: 0.36, speed: 2.4, churn: 2.8, pull: 0.12, squash: 1.00, spin: 0.55, jitter: 0, glow: 0.55, ramp: .dense, fps: 24)
        case .acting:      // v1 alert/pointing: leaning hard toward free space, sharp.
            return BlobPersonality(amp: 0.42, speed: 2.2, churn: 2.0, pull: 0.40, squash: 1.20, spin: 0.30, jitter: 0, glow: 0.60, ramp: .sharp, fps: 24)
        case .muted:       // a dim grey idle, nearly frozen.
            return BlobPersonality(amp: 0.22, speed: 0.30, churn: 0.3, pull: 0.08, squash: 0.88, spin: 0.02, jitter: 0, glow: 0.18, ramp: .soft, fps: 6)
        case .error:       // red, sharp, jittering.
            return BlobPersonality(amp: 0.40, speed: 2.6, churn: 3.2, pull: 0.10, squash: 1.00, spin: 0.00, jitter: 0.4, glow: 0.60, ramp: .sharp, fps: 24)
        }
    }
}

/// What the blob is pressed against: a normal pointing from the surface toward free
/// space (field/CG orientation, y down) and how hard (0 touching, 1 flattened, >1 squeezed in).
struct BlobContact: Equatable {
    var nx: Double
    var ny: Double
    var press: Double
}

/// What the wake word gate is doing, as far as the blob cares. Only read while the
/// phase is asleep: awake, the phase personality owns the field.
enum BlobGate: Equatable {
    case off, listening, heard, authenticating, granted, denied, lockedOut

    init(_ s: WakeGateState) {
        switch s {
        case .off: self = .off
        case .listening: self = .listening
        case .heard: self = .heard
        case .authenticating: self = .authenticating
        case .granted: self = .granted
        case .denied: self = .denied
        case .lockedOut: self = .lockedOut
        }
    }
}

// MARK: - Simulation

/// Standard normal via Box-Muller: uniform noise gave a flat, buzzy wobble.
func gaussianRandom() -> Double {
    var u = 0.0, v = 0.0
    while u == 0 { u = Double.random(in: 0..<1) }
    while v == 0 { v = Double.random(in: 0..<1) }
    return sqrt(-2 * log(u)) * cos(2 * .pi * v)
}

@MainActor
final class BlobSim {
    nonisolated static let cols = 27
    nonisolated static let rows = 15
    nonisolated static let cellCount = cols * rows

    /// Cell aspect (height / width); set by the view from its real metrics.
    var aspect: Double = 1.75

    // Eased parameters and their target.
    private(set) var phase: Phase = .asleep
    private var target = BlobPersonality.forPhase(.asleep)
    private var cur = BlobPersonality.forPhase(.asleep)
    private(set) var ramp: BlobRamp = .soft
    private var rampSwitchAt = -1.0
    static let easeTau = 0.28

    private var spinPhase = 0.0
    private var shiver = 0.0
    static let shiverTau = 0.45
    private var t = 0.0
    private var phaseChangedAt = 0.0
    private var lastErrorKick = 0.0

    /// Where the free space is; the blob leans this way (set by physics).
    var leanX = 0.0
    var leanY = 0.0
    /// Rows to lift the centre by (a status pill is showing beneath).
    var lift = 0.0

    // Levels: raw from the engine, smoothed for the eye.
    private var rawInput = 0.0, rawOutput = 0.0
    private var input = 0.0, output = 0.0
    /// The smoothed level currently driving the silhouette (input while listening, output while speaking).
    private(set) var react = 0.0

    private(set) var color = OrbPalette.asleep
    private(set) var glow = 0.30
    var reducedMotion = false
    /// Dark appearance: picks the accent's lift. Set by the view from its effective appearance.
    var darkAppearance = true

    private var jitterX = 0.0, jitterY = 0.0

    // The wake word gate, while asleep. Its one-shot cues — the heard flash, the
    // granted pulse, the calibration ripple — are decaying scalars, so a state that is
    // replaced in the same run-loop turn (heard → authenticating) still shows.
    private(set) var gate: BlobGate = .off
    private var gateChangedAt = -100.0
    /// Heard: toward the listening colour, then gone.
    private var flash = 0.0
    /// Granted: one bright pulse.
    private var pulse = 0.0
    /// wakeHeard changed: when the surface last swelled by a cell.
    private var rippleAt = -100.0
    static let flashTau = 0.32
    static let pulseTau = 0.45
    static let rippleLength = 0.36
    static let breathPeriod = 4.0

    /// Ramp index per cell, row-major; 0 is blank.
    private(set) var cells = [UInt8](repeating: 0, count: BlobSim.cellCount)
    /// Halo coverage per cell (0…255): the silhouette plus a soft margin. The view
    /// upscales it into the glow behind the glyphs.
    private(set) var halo = [UInt8](repeating: 0, count: BlobSim.cellCount)

    /// Cells carrying an eye this frame (0–2) and the glyph they show.
    private(set) var eyeCells: [Int] = []
    private(set) var eyeGlyph: Character = "•"
    private var nextBlinkAt = 2.5
    private var blinkUntil = -1.0

    // Harmonics: each amplitude does an Ornstein-Uhlenbeck random walk, phases drift.
    private struct Harmonic {
        let k: Double
        let weight: Double
        var amp: Double
        var phase: Double
        let drift: Double
    }
    private var harmonics: [Harmonic] = BlobSim.makeHarmonics()

    private static func makeHarmonics() -> [Harmonic] {
        var out: [Harmonic] = []
        for k in [1, 2, 3, 4, 5, 7] {
            let kd = Double(k)
            // Higher harmonics get less room, or the surface turns to static.
            let weight = 1.0 / (kd * 0.85)
            // Irrational-ish drifts so the harmonics never re-align into a pattern.
            let sign: Double = k % 2 == 0 ? -1 : 1
            let drift = (0.17 + kd * 0.113) * sign
            let phase = Double.random(in: 0..<(2 * Double.pi))
            out.append(Harmonic(k: kd, weight: weight, amp: 0, phase: phase, drift: drift))
        }
        return out
    }
    private lazy var weightSum: Double = harmonics.reduce(0) { $0 + $1.weight }
    static let ouPull = 1.7
    static let sigma = 1.3

    // Contacts, each spring-damped toward the value physics reports.
    private struct ContactSlot {
        var nx = 0.0, ny = 0.0, press = 0.0, target = 0.0, vel = 0.0
    }
    private var contacts = [ContactSlot(), ContactSlot()]
    static let stiffness = 165.0
    static let damping = 15.0
    private var springsMoving = false

    init() {}

    // MARK: inputs

    func setPhase(_ p: Phase) {
        guard p != phase else { return }
        phase = p
        target = .forPhase(p)
        phaseChangedAt = t
        // Ramp is categorical, so it swaps early in the transition rather than blending.
        rampSwitchAt = t + 0.12
        // A state change is a nudge, not a cut: kick the harmonics and raise the
        // agitation, both of which decay, so the transition has energy behind it.
        let kick = reducedMotion ? 0.1 : 0.3
        for i in harmonics.indices { harmonics[i].amp += gaussianRandom() * kick * harmonics[i].weight }
        shiver = reducedMotion ? 0.8 : 2.6
    }

    func setLevels(_ l: AudioLevels) {
        rawInput = min(max(l.input, 0), 1)
        rawOutput = min(max(l.output, 0), 1)
    }

    /// The gate moved. Colours ease like phase colours do (`targetColor`); the
    /// transitions get the same kind of energy a phase change gets, scaled down.
    func setGate(_ g: BlobGate) {
        guard g != gate else { return }
        gate = g
        gateChangedAt = t
        guard phase == .asleep else { return }
        switch g {
        case .heard:
            flash = 1
            shiver = reducedMotion ? 0.8 : 2.6      // the phase-change shiver
        case .granted:
            pulse = 1
        case .denied:
            shiver = min(4, shiver + (reducedMotion ? 0.5 : 1.6))
        case .off, .listening, .authenticating, .lockedOut:
            break
        }
    }

    /// The calibration cue: the recogniser heard something new. One cell of surface,
    /// never more — it says "I hear you", not "I am waking".
    func rippleHeard() {
        guard phase == .asleep, gate == .listening else { return }
        rippleAt = t
    }

    /// Adopt the new normals immediately; only the magnitude is sprung, so a contact
    /// that jumps to another wall does not swing through the middle.
    func setContacts(_ list: [BlobContact]) {
        for i in contacts.indices {
            if i < list.count {
                contacts[i].nx = list[i].nx
                contacts[i].ny = list[i].ny
                contacts[i].target = list[i].press
            } else {
                contacts[i].target = 0
            }
        }
    }

    /// Extra agitation (an impact, a summon landing), decaying away.
    func nudge(_ strength: Double) {
        shiver = min(4, shiver + (reducedMotion ? strength * 0.3 : strength))
        for i in harmonics.indices { harmonics[i].amp += gaussianRandom() * 0.12 * strength * harmonics[i].weight }
    }

    // MARK: scheduling

    /// True while the contact springs are still settling or a transition is live.
    var isLively: Bool {
        springsMoving || shiver > 0.03 || flash > 0.02 || pulse > 0.02 || t - rippleAt < Self.rippleLength
            || t - phaseChangedAt < 1.0 || t - gateChangedAt < 1.0
    }

    var desiredFPS: Double { isLively ? 24 : target.fps }

    /// Nothing worth a frame: muted and settled, or fast asleep (asleep for a while
    /// with nothing happening — it stops breathing until something pokes it). The
    /// view then pauses the display link entirely. An ear keeps it awake: the gate's
    /// listening breath and authenticating pulse need frames, at the asleep cadence
    /// (10 fps), never more.
    var isStatic: Bool {
        guard !isLively, rawInput < 0.02, rawOutput < 0.02 else { return false }
        switch phase {
        case .muted: return t - phaseChangedAt > 1.5
        case .asleep:
            if gateAnimates { return false }
            return t - max(phaseChangedAt, gateChangedAt) > 20
        default: return false
        }
    }

    /// The gate states with a continuous motion of their own (dropped under reduce motion).
    private var gateAnimates: Bool {
        guard !reducedMotion, phase == .asleep else { return false }
        switch gate {
        case .listening, .authenticating: return true
        case .off, .heard, .granted, .denied, .lockedOut: return false
        }
    }

    /// The colour the field eases toward: the phase's, or the gate's while asleep.
    private var targetColor: RGB {
        let base = OrbPalette.color(for: phase)
        guard phase == .asleep else { return base }
        switch gate {
        case .off, .listening, .heard: return base
        case .authenticating: return OrbPalette.accent(dark: darkAppearance)
        case .granted: return OrbPalette.listening
        // A short red, then back to the asleep colour while the denial is still showing.
        case .denied: return t - gateChangedAt < 1.0 ? OrbPalette.error : base
        case .lockedOut: return OrbPalette.muted
        }
    }

    /// The ~1 Hz wave while the gate waits for Touch ID or the passphrase; steady under reduce motion.
    private var authPulse: Double {
        guard phase == .asleep, gate == .authenticating else { return 0 }
        if reducedMotion { return 0.5 }
        return 0.5 - 0.5 * cos(2 * .pi * (t - gateChangedAt))
    }

    /// The current calibration ripple, 0…1 with a soft attack and release.
    private var ripple: Double {
        let u = (t - rippleAt) / Self.rippleLength
        return u >= 0 && u < 1 ? sin(.pi * u) : 0
    }

    /// The colour to draw with this frame: the eased phase colour, brightened by
    /// activity — the audio level, the heard flash, the granted pulse, the auth wave.
    var displayColor: RGB {
        var c = color
        if flash > 0.001 { c = c.mixed(with: OrbPalette.listening, flash * 0.85) }
        let lift = 0.22 * react + 0.3 * flash + 0.28 * pulse + 0.12 * authPulse
        return lift > 0.001 ? c.mixed(with: RGB(1, 1, 1), lift) : c
    }

    // MARK: stepping

    func step(_ dtRaw: Double) {
        // Clamped because a long frame gap (window hidden, machine asleep) would
        // otherwise integrate into a violent snap on the next visible frame.
        let dt = min(max(dtRaw, 0), 0.1)
        t += dt
        easeParams(dt)
        smoothLevels(dt)
        stepHarmonics(dt)
        springsMoving = stepSprings(dt)
        render()
    }

    private func easeParams(_ dt: Double) {
        // Exponential approach: frame-rate independent, never overshoots.
        let k = 1 - exp(-dt / Self.easeTau)
        cur.amp += (target.amp - cur.amp) * k
        cur.speed += (target.speed - cur.speed) * k
        cur.churn += (target.churn - cur.churn) * k
        cur.pull += (target.pull - cur.pull) * k
        cur.squash += (target.squash - cur.squash) * k
        cur.spin += (target.spin - cur.spin) * k
        cur.jitter += (target.jitter - cur.jitter) * k
        cur.glow += (target.glow - cur.glow) * k
        color = color.mixed(with: targetColor, k)
        if rampSwitchAt >= 0, t >= rampSwitchAt { ramp = target.ramp; rampSwitchAt = -1 }
        spinPhase += cur.spin * dt
        shiver *= exp(-dt / Self.shiverTau)
        flash *= exp(-dt / Self.flashTau)
        pulse *= exp(-dt / Self.pulseTau)
        // Error: keep it agitated with a periodic twitch.
        if phase == .error, !reducedMotion, t - lastErrorKick > 1.1 {
            lastErrorKick = t
            shiver += 1.0
        }
    }

    private func smoothLevels(_ dt: Double) {
        // Fast attack, slower release.
        input += (rawInput - input) * min(1, dt * (rawInput > input ? 30 : 8))
        output += (rawOutput - output) * min(1, dt * (rawOutput > output ? 30 : 10))
        let want: Double
        switch phase {
        case .listening, .connecting: want = input
        case .speaking: want = output
        default: want = 0
        }
        react += (want - react) * min(1, dt * 20)
        glow = min(1, cur.glow + 0.45 * react + gateGlow)
    }

    /// Glow the gate adds: the heard flash and granted pulse briefly, the auth wave for
    /// as long as the question is open ("glow up").
    private var gateGlow: Double {
        var g = 0.4 * flash + 0.5 * pulse
        if phase == .asleep, gate == .authenticating { g += 0.22 + 0.2 * authPulse }
        return g
    }

    private func stepHarmonics(_ dt: Double) {
        let step = min(dt, 1.0 / 15)
        let root = sqrt(step)
        // Speaking churns harder the louder it is; the shiver adds to everything.
        let churn = cur.churn + shiver + (phase == .speaking ? output * 1.2 : 0)
        for i in harmonics.indices {
            var h = harmonics[i]
            // Correct OU: drift scales with dt, noise with sqrt(dt), so the walk looks
            // the same whether it is running at 18fps or 60.
            let sigma = Self.sigma * churn * h.weight
            h.amp += -Self.ouPull * h.amp * step + sigma * root * gaussianRandom()
            // Bound it: an unbounded walk eventually inverts the radius.
            let cap = h.weight * 1.15
            h.amp = min(max(h.amp, -cap), cap)
            // Phases wander too, so the lobes never settle into a fixed rosette.
            h.phase += (h.drift * cur.speed + gaussianRandom() * 0.12) * step
            harmonics[i] = h
        }
        if cur.jitter > 0.005, !reducedMotion {
            jitterX = gaussianRandom() * cur.jitter
            jitterY = gaussianRandom() * cur.jitter * 0.6
        } else {
            jitterX = 0; jitterY = 0
        }
    }

    private func stepSprings(_ dt: Double) -> Bool {
        let step = min(dt, 1.0 / 30)
        var moving = false
        for i in contacts.indices {
            var c = contacts[i]
            let accel = (c.target - c.press) * Self.stiffness - c.vel * Self.damping
            c.vel += accel * step
            c.press += c.vel * step
            if abs(c.vel) > 0.002 || abs(c.target - c.press) > 0.002 { moving = true }
            contacts[i] = c
        }
        return moving
    }

    // MARK: silhouette

    /// Radius multiplier at a given angle: the Brownian outline. Floored well above
    /// zero because a sum that reaches -1 would fold the surface through the centre.
    /// `ampScale` is the frame's wander amplitude (see `ampBreath`).
    private func outline(_ angle: Double, ampScale: Double) -> Double {
        var sum = 0.0
        for h in harmonics { sum += h.amp * sin(h.k * angle + h.phase) }
        return max(0.35, 1 + (sum / weightSum) * ampScale)
    }

    /// The listening breath: the wander amplitude swells and settles over ~4 s,
    /// faintly, so an asleep blob with an ear reads differently from one fast asleep.
    /// Rides the frames the asleep personality already draws; nothing extra.
    private var ampBreath: Double {
        guard phase == .asleep, gate == .listening, !reducedMotion else { return 1 }
        return 1 + 0.18 * sin(2 * .pi * t / Self.breathPeriod)
    }

    /// Slow size pulse, layered under the Brownian outline, plus the audio swell.
    private func breath() -> Double {
        let rate = 1.1 + cur.speed * 1.6
        let depth = 0.03 + cur.speed * 0.016
        let swell = phase == .speaking ? react * 0.11 : react * 0.16
        return (1 + sin(t * rate) * depth) * (1 + swell)
    }

    /// Squash a point against the active contacts: compress along the wall normal and
    /// spread perpendicular (fixed volume), then hard-clip anything past the wall,
    /// which is what produces the flat pressed face.
    private func squash(_ dx: Double, _ dy: Double, base: Double) -> (Double, Double, Bool) {
        var ox = dx, oy = dy
        var clipped = false
        // A corner applies two contacts; multiplying both squashes collapsed the blob
        // into a line. Splitting the budget keeps a corner squish dramatic.
        var active = 0
        for c in contacts where c.press > 0.01 { active += 1 }
        let share = active > 1 ? 0.68 : 1.0

        for c in contacts where c.press > 0.01 {
            let press = c.press * share
            let along = ox * c.nx + oy * c.ny
            let perpX = ox - c.nx * along
            let perpY = oy - c.ny * along

            // Wall sits this far from centre along -n; as press rises it comes in.
            let wall = base * (1 - min(0.66, press * 0.6))
            if along < -wall { clipped = true }

            let compress = 1 / (1 - min(0.55, press * 0.47))
            let spread = 1 / (1 + min(0.8, press * 0.66))

            ox = c.nx * along * compress + perpX * spread
            oy = c.ny * along * compress + perpY * spread
        }
        return (ox, oy, clipped)
    }

    /// Net push direction (and total press), used to slide the body away from what it
    /// is pressed against and to aim the eyes.
    private func contactBias() -> (bx: Double, by: Double, total: Double) {
        var bx = 0.0, by = 0.0, total = 0.0
        for c in contacts where c.press > 0.01 {
            bx += c.nx * c.press
            by += c.ny * c.press
            total += c.press
        }
        return (bx, by, total)
    }

    private func render() {
        let cols = Self.cols, rows = Self.rows
        let bias = contactBias()
        // Pressed blobs slide their mass away from the wall, not just deform in place.
        let cx = Double(cols - 1) / 2 + (leanX * cur.pull + bias.bx * 0.9) * Double(cols) * 0.16 + jitterX
        let cy = Double(rows - 1) / 2 + (leanY * cur.pull + bias.by * 0.9) * Double(rows) * 0.16 - lift + jitterY
        // Smaller than v1's 0.42: the lobes reach 1.5× the base and were hard-clipping
        // into flat edges at the field boundary. The calibration ripple adds at most
        // half a row (about one column) to the radius for a third of a second.
        let base = Double(rows) * 0.38 * breath() + 0.55 * ripple
        let ampScale = cur.amp * 2.6 * ampBreath
        let cosS = cos(spinPhase), sinS = sin(spinPhase)
        let sq = cur.squash == 0 ? 1 : cur.squash
        let rampLen = Double(ramp.glyphs.count)
        let maxIdx = UInt8(ramp.glyphs.count - 1)

        var i = 0
        for y in 0..<rows {
            let ry = (Double(y) - cy) / sq
            let edgeY = min(y, rows - 1 - y)
            for x in 0..<cols {
                // Squash vertically per personality, then rotate the sampling frame so
                // the whole silhouette turns: a turning body reads as a creature.
                let rx = (Double(x) - cx) / aspect
                let dx = rx * cosS - ry * sinS
                let dy = rx * sinS + ry * cosS
                let (ox, oy, clipped) = squash(dx, dy, base: base)
                if clipped { cells[i] = 0; halo[i] = 0; i += 1; continue }
                let dist = (ox * ox + oy * oy).squareRoot()
                let radius = base * outline(atan2(oy, ox), ampScale: ampScale)
                // 0 at the surface, 1 deep inside.
                var depth = min(1, max(0, (radius - dist) / (radius * 0.8)))
                // The halo reaches past the surface and fades smoothly; the same lobes, so
                // the glow hugs the silhouette instead of being a disc behind it.
                var g = min(1, max(0, (radius * 1.28 - dist) / (radius * 0.85)))
                g = g * g * (3 - 2 * g)
                // A lobe that runs off the field thins out instead of being cut flat.
                let edge = min(edgeY, min(x, cols - 1 - x))
                if edge == 0 { depth *= 0.3; g *= 0.35 } else if edge == 1 { depth *= 0.65; g *= 0.7 }
                cells[i] = depth <= 0 ? 0 : min(maxIdx, UInt8(depth * rampLen))
                halo[i] = UInt8(g * 255)
                i += 1
            }
        }
        renderEyes(cx: cx, cy: cy, base: base, bias: bias)
    }

    /// Two eyes (v1's drawEyes): they look toward open space, away from whatever the
    /// body is pressed against, squint as the squish deepens, blink now and then, and
    /// stay shut while asleep. Only drawn where there is body to draw them on.
    private func renderEyes(cx: Double, cy: Double, base: Double, bias: (bx: Double, by: Double, total: Double)) {
        eyeCells.removeAll(keepingCapacity: true)
        let squishing = min(1, bias.total)
        if t >= nextBlinkAt {
            blinkUntil = t + 0.14
            nextBlinkAt = t + Double.random(in: 2.4...5.5)
        }
        // Asleep the eyes stay shut — except while the gate has heard the word and is
        // asking who is there: half-open, the way you answer a knock at night.
        let asking = phase == .asleep && (gate == .heard || gate == .authenticating || gate == .granted)
        let shut = t < blinkUntil || squishing > 0.55 || (phase == .asleep && !asking)
        eyeGlyph = shut ? "-" : (asking ? "o" : Self.eyeGlyph(for: phase))

        // Look away from the wall; default slightly up, which reads as friendly.
        let lookX = bias.total > 0.05 ? bias.bx / max(1, bias.total) : 0
        let lookY = bias.total > 0.05 ? bias.by / max(1, bias.total) : -0.35
        let row = Int((cy + lookY * 1.6 - 0.6).rounded())
        guard row >= 0, row < Self.rows else { return }
        // Spread widens as the body flattens.
        let spread = max(1, Int((base * (0.62 + squishing * 0.55) * aspect * 0.5).rounded()))
        let centre = Int((cx + lookX * 2.2).rounded())
        for dx in [-spread, spread] {
            let col = centre + dx
            guard col >= 0, col < Self.cols else { continue }
            let idx = row * Self.cols + col
            if cells[idx] > 0 { eyeCells.append(idx) }
        }
    }

    static func eyeGlyph(for phase: Phase) -> Character {
        switch phase {
        case .asleep: return "-"
        case .connecting, .thinking: return "o"
        case .listening: return "O"
        case .speaking, .acting: return "•"
        case .muted: return "·"      // awake but hushed: small, half-lidded, not staring
        case .error: return "x"
        }
    }

    /// How far the eyes are lifted toward white over the body colour: a step brighter
    /// so they read as eyes, except muted, whose eyes stay dim like the rest of it.
    static func eyeLift(for phase: Phase) -> Double { phase == .muted ? 0.35 : 0.8 }

    /// Every glyph an eye can be, so the glyph cache resolves them up front.
    nonisolated static let eyeGlyphs: [Character] = ["-", "o", "O", "•", "·", "x"]
}

// MARK: - Glyphs and metrics

/// Grid metrics. Cells are slightly narrower than the font's advance so 27 columns fit
/// the panel; the aspect the sim uses is derived from these, never assumed.
enum BlobMetrics {
    static let fontSize: CGFloat = 10
    static let font = NSFont.monospacedSystemFont(ofSize: fontSize, weight: .medium)
    static let advance: CGFloat = {
        let w = ("M" as NSString).size(withAttributes: [.font: font]).width
        return w > 0 ? w : fontSize * 0.6
    }()
    static let cellWidth: CGFloat = (advance * 0.97 * 20).rounded() / 20
    static let rowHeight: CGFloat = 10.5
    static var fieldSize: CGSize {
        CGSize(width: cellWidth * CGFloat(BlobSim.cols), height: rowHeight * CGFloat(BlobSim.rows))
    }
    /// The collapsed orb panel: the field plus a hair of margin for the glow.
    static let panelSize = NSSize(width: 164, height: 164)
    /// Baseline offset from a cell's vertical centre so the em box is centred in the row.
    static let baselineShift: CGFloat = (font.ascender + font.descender) / 2
}

/// Pre-resolved glyphs for every ramp character, grouped by the font that has them.
/// SF Mono lacks a couple of the wave glyphs; those fall back to Menlo / Apple Symbols
/// and are centred in their cell so the columns still line up.
final class BlobGlyphs {
    struct Ref {
        let font: Int
        let glyph: CGGlyph
        let advance: CGFloat
    }
    struct FontEntry {
        let ct: CTFont
        let cg: CGFont
        let size: CGFloat
    }

    nonisolated(unsafe) static let shared = BlobGlyphs()

    private(set) var fonts: [FontEntry] = []
    /// Per ramp, per ramp index; nil for blank.
    private(set) var tables: [[Ref?]] = []
    private var eyes: [Character: Ref] = [:]

    private init() {
        let base = BlobMetrics.font as CTFont
        fonts.append(FontEntry(ct: base, cg: CTFontCopyGraphicsFont(base, nil), size: BlobMetrics.fontSize))
        var byChar: [Character: Ref?] = [:]
        for ramp in BlobRamp.allCases {
            var table: [Ref?] = []
            for ch in ramp.glyphs {
                if let cached = byChar[ch] { table.append(cached); continue }
                let ref = ch == " " ? nil : resolve(ch, base: base)
                byChar[ch] = ref
                table.append(ref)
            }
            tables.append(table)
        }
        // Eyes resolve here too, so `fonts` is final once the view starts drawing.
        for ch in BlobSim.eyeGlyphs {
            if let ref = byChar[ch] ?? resolve(ch, base: base) { eyes[ch] = ref }
        }
    }

    func eye(_ ch: Character) -> Ref? { eyes[ch] }

    private func resolve(_ ch: Character, base: CTFont) -> Ref? {
        var utf16 = Array(String(ch).utf16)
        var glyphs = [CGGlyph](repeating: 0, count: utf16.count)
        var font = base
        var fontIndex = 0
        if !CTFontGetGlyphsForCharacters(base, &utf16, &glyphs, utf16.count) {
            let fb = CTFontCreateForString(base, String(ch) as CFString, CFRangeMake(0, utf16.count))
            guard CTFontGetGlyphsForCharacters(fb, &utf16, &glyphs, utf16.count) else { return nil }
            font = fb
            if let i = fonts.firstIndex(where: { CFEqual($0.ct, fb) }) {
                fontIndex = i
            } else {
                fonts.append(FontEntry(ct: fb, cg: CTFontCopyGraphicsFont(fb, nil), size: CTFontGetSize(fb)))
                fontIndex = fonts.count - 1
            }
        }
        var adv = CGSize.zero
        CTFontGetAdvancesForGlyphs(font, .horizontal, glyphs, &adv, 1)
        return Ref(font: fontIndex, glyph: glyphs[0], advance: adv.width)
    }

    func table(for ramp: BlobRamp) -> [Ref?] { tables[ramp.rawValue] }
}

// MARK: - View

/// Draws the field and runs the orb's one display link. `tick` is the physics hook:
/// called every display frame with dt, it returns true while the body still moves.
@MainActor
final class BlobFieldView: NSView {
    let sim = BlobSim()
    var tick: ((Double) -> Bool)?

    private var link: CADisplayLink?
    private var lastTick = 0.0
    private var lastRender = 0.0
    private var lastSimStep = 0.0
    private var idleSince = -1.0
    private var linkRate = 0.0

    /// The glow layer behind this view (owned by the controller's blob cell); fed a
    /// fresh halo image every rendered frame. Nil in a bare view: glyphs only.
    weak var halo: BlobHaloView?

    /// The halo is refined from the sim's 27×15 mask to this many pixels per cell
    /// (bilinear, then a box blur half a cell wide); the render server scales it the
    /// rest of the way on the GPU. CG resampling it here cost a millisecond a frame,
    /// and CG left to itself drew the raw mask as row-sized stair-steps.
    private static let haloScale = 4
    private static let haloW = BlobSim.cols * haloScale
    private static let haloH = BlobSim.rows * haloScale
    private var haloFine = [Float](repeating: 0, count: BlobFieldView.haloW * BlobFieldView.haloH)
    private var haloTmp = [Float](repeating: 0, count: BlobFieldView.haloW * BlobFieldView.haloH)
    /// Scratch RGBA for the halo image, rebuilt per frame.
    private var haloPixels = [UInt8](repeating: 0, count: BlobFieldView.haloW * BlobFieldView.haloH * 4)

    /// Set while the panel is ordered out: no ticks at all.
    var paused = false {
        didSet {
            guard paused != oldValue else { return }
            if paused { link?.isPaused = true; lastTick = 0 } else { poke() }
        }
    }

    override var isFlipped: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layerContentsRedrawPolicy = .onSetNeedsDisplay
        sim.aspect = Double(BlobMetrics.rowHeight / BlobMetrics.cellWidth)
        setAccessibilityElement(true)
        setAccessibilityRole(.image)
    }

    required init?(coder: NSCoder) { fatalError("BlobFieldView is code-only") }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        syncAppearance()
        guard window != nil, link == nil else { return }
        let l = displayLink(target: self, selector: #selector(onFrame(_:)))
        l.add(to: .main, forMode: .common)
        link = l
        poke()
    }

    /// The accent follows the appearance like the capsule's does; the colour eases over.
    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        syncAppearance()
    }

    private func syncAppearance() {
        let dark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        guard dark != sim.darkAppearance else { return }
        sim.darkAppearance = dark
        poke()
    }

    /// Something changed (phase, levels, contacts, physics): make sure frames are flowing.
    func poke() {
        idleSince = -1
        guard !paused, let link else { return }
        if link.isPaused { lastTick = 0; link.isPaused = false }
    }

    @objc private func onFrame(_ link: CADisplayLink) {
        let now = CACurrentMediaTime()
        if lastTick == 0 { lastTick = now; lastSimStep = now; lastRender = 0 }
        let dt = now - lastTick
        lastTick = now

        let physicsWants = tick?(dt) ?? false

        // The field re-renders on its own clock (10–24 fps like v1); the body can
        // move every display frame in between so a throw is smooth.
        if now - lastRender >= 1 / sim.desiredFPS - 0.002 {
            sim.step(now - lastSimStep)
            lastSimStep = now
            lastRender = now
            updateHalo()
            needsDisplay = true
        }

        // Ask the display for the rate we will actually use: 60 while the body moves
        // (the panel is re-placed every frame; 120 would double the window-server
        // traffic for no visible gain), else the field's own rate, so idle frames are
        // not even scheduled.
        let wantRate = physicsWants ? 60.0 : max(10, min(30, sim.desiredFPS))
        if wantRate != linkRate {
            linkRate = wantRate
            link.preferredFrameRateRange = physicsWants
                ? CAFrameRateRange(minimum: 60, maximum: 60, preferred: 60)
                : CAFrameRateRange(minimum: 10, maximum: 30, preferred: Float(wantRate))
        }

        let wants = physicsWants || !sim.isStatic
        if wants {
            idleSince = -1
        } else if idleSince < 0 {
            idleSince = now
        } else if now - idleSince > 0.5 {
            link.isPaused = true
            lastTick = 0
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let cg = NSGraphicsContext.current?.cgContext else { return }
        let size = bounds.size
        let color = sim.displayColor
        let field = BlobMetrics.fieldSize
        let origin = CGPoint(x: (size.width - field.width) / 2, y: (size.height - field.height) / 2)

        // The halo lives on its own layer beneath this view (see updateHalo); this
        // view draws only glyphs: body cells from the phase ramp, eye cells from the
        // eye glyph.
        let cw = BlobMetrics.cellWidth, rh = BlobMetrics.rowHeight
        let shift = BlobMetrics.baselineShift
        let glyphs = BlobGlyphs.shared
        let table = glyphs.table(for: sim.ramp)
        let eyeRef = glyphs.eye(sim.eyeGlyph)
        let eyeCells = sim.eyeCells
        let fontCount = glyphs.fonts.count

        var runs = [[CGGlyph]](repeating: [], count: fontCount)
        var positions = [[CGPoint]](repeating: [], count: fontCount)
        var eyeRuns = [[CGGlyph]](repeating: [], count: fontCount)
        var eyePositions = [[CGPoint]](repeating: [], count: fontCount)
        var i = 0
        for row in 0..<BlobSim.rows {
            let baseline = origin.y + (CGFloat(row) + 0.5) * rh + shift
            for col in 0..<BlobSim.cols {
                let cell = i
                let idx = Int(sim.cells[i]); i += 1
                guard idx > 0 else { continue }
                let isEye = !eyeCells.isEmpty && eyeCells.contains(cell)
                guard let ref = isEye ? eyeRef : (idx < table.count ? table[idx] : nil) else { continue }
                let x = origin.x + CGFloat(col) * cw + (cw - ref.advance) / 2
                // Text space is flipped below, so y maps to -y.
                let p = CGPoint(x: x, y: -baseline)
                if isEye {
                    eyeRuns[ref.font].append(ref.glyph)
                    eyePositions[ref.font].append(p)
                } else {
                    runs[ref.font].append(ref.glyph)
                    positions[ref.font].append(p)
                }
            }
        }

        cg.saveGState()
        cg.setAllowsAntialiasing(true)
        cg.setShouldAntialias(true)
        cg.setShouldSmoothFonts(false)
        cg.setAllowsFontSubpixelPositioning(true)
        cg.setShouldSubpixelPositionFonts(true)
        cg.textMatrix = CGAffineTransform(scaleX: 1, y: -1)   // the view is y-down
        func show(_ r: [[CGGlyph]], _ p: [[CGPoint]]) {
            for (f, entry) in glyphs.fonts.enumerated() where !r[f].isEmpty {
                cg.setFont(entry.cg)
                cg.setFontSize(entry.size)
                cg.showGlyphs(r[f], at: p[f])
            }
        }
        // One dark under-copy boxes each glyph in near-black (v1's text-stroke), then
        // the colour; the eyes a step brighter so they read as eyes.
        cg.setFillColor(OrbPalette.ground.cgColor(alpha: 0.85))
        cg.textPosition = CGPoint(x: 0.6, y: 0.7)
        show(runs, positions)
        show(eyeRuns, eyePositions)
        cg.textPosition = .zero
        cg.setFillColor(color.cgColor)
        show(runs, positions)
        if !eyeCells.isEmpty {
            cg.setFillColor(color.mixed(with: RGB(1, 1, 1), BlobSim.eyeLift(for: sim.phase)).cgColor)
            show(eyeRuns, eyePositions)
        }
        cg.restoreGState()
    }

    /// Refine the sim's halo and hand it to the glow layer as one premultiplied image:
    /// the phase colour over a faint dark backing, both shaped by the mask. Legibility
    /// on a bright desktop is the per-glyph under-copy's job (v1's text-stroke, in
    /// `draw`); the backing only gives the glow something to sit on, so it stays light
    /// and fades with the glow — a 58% disc turned the blob into a grey blot on paper.
    private func updateHalo() {
        guard let halo else { return }
        refineHalo()
        let glow = sim.glow
        halo.imageLayer.contents = haloImage(glow: sim.displayColor,
                                             glowAlpha: glow > 0.01 ? 0.16 + 0.34 * glow : 0,
                                             backingAlpha: 0.14 + 0.18 * glow)
    }

    /// 27×15 cell coverage → haloW×haloH smooth coverage: bilinear between cell
    /// centres, then a separable box blur half a cell wide to melt the creases. Row 0
    /// is the top, as CALayer.contents expects.
    private func refineHalo() {
        let cols = BlobSim.cols, rows = BlobSim.rows
        let s = Self.haloScale, w = Self.haloW, h = Self.haloH
        let halo = sim.halo
        let inv = 1 / Float(s)
        haloTmp.withUnsafeMutableBufferPointer { out in
            for py in 0..<h {
                let v = (Float(py) + 0.5) * inv - 0.5
                let y0 = max(0, min(rows - 1, Int(v.rounded(.down))))
                let y1 = min(rows - 1, y0 + 1)
                let fy = max(0, min(1, v - Float(y0)))
                let rowA = y0 * cols, rowB = y1 * cols
                let dst = py * w
                for px in 0..<w {
                    let u = (Float(px) + 0.5) * inv - 0.5
                    let x0 = max(0, min(cols - 1, Int(u.rounded(.down))))
                    let x1 = min(cols - 1, x0 + 1)
                    let fx = max(0, min(1, u - Float(x0)))
                    let a = Float(halo[rowA + x0]) + (Float(halo[rowA + x1]) - Float(halo[rowA + x0])) * fx
                    let b = Float(halo[rowB + x0]) + (Float(halo[rowB + x1]) - Float(halo[rowB + x0])) * fx
                    out[dst + px] = (a + (b - a) * fy) / 255
                }
            }
        }
        // Box blur, horizontal then vertical, radius s/2.
        let r = s / 2
        let norm = 1 / Float(2 * r + 1)
        haloFine.withUnsafeMutableBufferPointer { out in
            haloTmp.withUnsafeBufferPointer { src in
                for y in 0..<h {
                    let row = y * w
                    var acc: Float = 0
                    for x in -r...r { acc += src[row + max(0, min(w - 1, x))] }
                    for x in 0..<w {
                        out[row + x] = acc * norm
                        acc += src[row + min(w - 1, x + r + 1)] - src[row + max(0, x - r)]
                    }
                }
            }
        }
        haloTmp.withUnsafeMutableBufferPointer { out in
            haloFine.withUnsafeBufferPointer { src in
                for x in 0..<w {
                    var acc: Float = 0
                    for y in -r...r { acc += src[max(0, min(h - 1, y)) * w + x] }
                    for y in 0..<h {
                        out[y * w + x] = acc * norm
                        acc += src[min(h - 1, y + r + 1) * w + x] - src[max(0, y - r) * w + x]
                    }
                }
            }
        }
        swap(&haloFine, &haloTmp)
    }

    /// The refined halo as one premultiplied RGBA image: the glow colour composited
    /// over the dark backing, both with the mask as coverage.
    private func haloImage(glow: RGB, glowAlpha: Double, backingAlpha: Double) -> CGImage? {
        let w = Self.haloW, h = Self.haloH
        let ground = OrbPalette.ground
        let backingAlpha = Float(min(max(backingAlpha, 0), 1))
        let gr = Float(glow.r), gg = Float(glow.g), gb = Float(glow.b), ga = Float(glowAlpha)
        let br = Float(ground.r), bg = Float(ground.g), bb = Float(ground.b)
        haloFine.withUnsafeBufferPointer { fine in
            haloPixels.withUnsafeMutableBufferPointer { px in
                for i in 0..<(w * h) {
                    let f = fine[i]
                    let ag = f * ga
                    let ab = f * backingAlpha * (1 - ag)
                    let a = ag + ab
                    let o = i * 4
                    px[o] = UInt8((gr * ag + br * ab) * 255 + 0.5)
                    px[o + 1] = UInt8((gg * ag + bg * ab) * 255 + 0.5)
                    px[o + 2] = UInt8((gb * ag + bb * ab) * 255 + 0.5)
                    px[o + 3] = UInt8(a * 255 + 0.5)
                }
            }
        }
        guard let provider = CGDataProvider(data: Data(haloPixels) as CFData) else { return nil }
        return CGImage(width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: w * 4,
                       space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(),
                       bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
                       provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)
    }

    override func accessibilityLabel() -> String? {
        if sim.phase == .asleep, sim.gate != .off { return "Jarhead, asleep, wake word \(sim.gate)" }
        return "Jarhead, \(sim.phase.rawValue)"
    }
}

/// The glow: a layer whose contents is the refined halo image, scaled up to the
/// field by the render server (GPU bilinear), so this process never resamples a
/// pixel. Sits beneath the glyph view in the blob cell; never takes the mouse.
@MainActor
final class BlobHaloView: NSView {
    let imageLayer = CALayer()

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = .clear
        imageLayer.contentsGravity = .resize
        imageLayer.magnificationFilter = .linear
        imageLayer.minificationFilter = .linear
        imageLayer.isOpaque = false
        // A hand-made sublayer would otherwise cross-fade every contents change.
        imageLayer.actions = ["contents": NSNull(), "bounds": NSNull(), "position": NSNull(), "hidden": NSNull()]
        layer?.addSublayer(imageLayer)
        setAccessibilityElement(false)
    }

    required init?(coder: NSCoder) { fatalError("BlobHaloView is code-only") }

    override func layout() {
        super.layout()
        let field = BlobMetrics.fieldSize
        imageLayer.frame = CGRect(x: (bounds.width - field.width) / 2, y: (bounds.height - field.height) / 2, width: field.width, height: field.height)
    }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}
