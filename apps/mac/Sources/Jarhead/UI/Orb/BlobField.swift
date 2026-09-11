import AppKit
import QuartzCore

// The blob: an ASCII field whose silhouette is a sum of wandering harmonics, drawn
// in one colour per phase, squished by spring-damped contacts, glowing.
//
// A faithful port of legacy/packages/overlay/src/renderer/overlay.js (the v1
// Electron buddy) onto a plain NSView with CoreGraphics glyph drawing:
//  * `BlobSim` owns every mutable animation value and turns (phase, levels,
//    contacts, motion, lean, time) into a 27×15 grid of ramp indices, a matching
//    halo coverage mask, per-cell flags (the wet patch), and two eyes (a blob with
//    eyes is a creature; without, a loading indicator). Every cell goes through one
//    inverse-mapping pipeline in the world frame — the contacts (flatten against a
//    plane at the surface's real distance, the adhesion patch spreading along it,
//    the smear, the neck while clinging), then the drag stretch (a teardrop along
//    the lag, sheared toward the grab, thinned to keep its volume), then the spun
//    harmonic outline plus the wobble modes — so the flat face always lies on the
//    real edge and the stretch always points at the hand.
//  * The eyes are ASCII — Kevin's `^ ^` — a pair of bold glyphs from the field's own
//    mono family at 1.7× its size, on the upper third of the body, a step brighter
//    than it and boxed in the ground colour. The expression is the glyph pair
//    (`- -` asleep, `O O` listening, `^ ^` talking or pleased, `o o` at work turning
//    `> >` / `< <` toward the target, `u u` paused, `x x` error, `. .` while the gate
//    asks), the lids a glyph swap (`-` for a blink, for the wall-side squint), the
//    look a shift of the pair by up to a cell and a half (`renderEyes`). The same
//    face is drawn in the notch (`NotchPanel`) from `BlobSim.face`.
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
    /// The house meta grey (Prototemplate's titanium): the paused blob wears it.
    static let titanium = RGB(hex: 0x8a8f98)
    static let connecting = RGB(hex: 0x9fb4c8)
    /// The house accent, spent on exactly one thing here — the wake gate asking who is
    /// there. Light `#2f5ce0`, dark its lift `#5b82ff`: the blob sits on the desktop
    /// (its halo backing is faint) beside a capsule and pill in the same accent, so it
    /// follows the appearance the way they do (`BlobSim.darkAppearance`).
    static let accentLight = RGB(hex: 0x2f5ce0)
    static let accentDark = RGB(hex: 0x5b82ff)
    static func accent(dark: Bool) -> RGB { dark ? accentDark : accentLight }

    /// The overlay's tone colours (OverlayPainter's, one for one), for the blob on a
    /// trace: the pen is the colour of the line it draws.
    static func tone(_ t: OverlayTone) -> RGB {
        switch t {
        case .accent: return accentDark
        case .ok: return acting
        case .warn: return error
        case .mark: return speaking
        }
    }

    static func color(for phase: Phase) -> RGB {
        switch phase {
        case .asleep: return asleep
        case .connecting: return connecting
        case .listening: return listening
        case .speaking: return speaking
        case .thinking: return thinking
        case .acting: return acting
        case .muted: return muted
        case .paused: return titanium
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

    /// The same creature on the wing: the surface wanders faster and churns harder,
    /// it sits taller, glows at least as bright as acting. It draws at full rate only
    /// while the body is actually moving (the panel is being re-placed every frame
    /// then anyway); parked beside the work it shimmers at the phase's own rate, like
    /// a blob at rest after a fling, so a long hover costs no more than sitting still.
    func inFlight(moving: Bool) -> BlobPersonality {
        var p = self
        p.speed = max(speed * 1.6, 2.6)
        p.churn = max(churn * 1.4, 2.4)
        p.squash = max(squash, 1.12)
        p.glow = max(glow, 0.62)
        p.jitter = 0
        if moving { p.fps = 24 }
        return p
    }

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
        case .paused:      // resting with the session open: calm, dim, slow breath.
            return BlobPersonality(amp: 0.26, speed: 0.35, churn: 0.4, pull: 0.08, squash: 0.90, spin: 0.02, jitter: 0, glow: 0.22, ramp: .soft, fps: 8)
        case .error:       // red, sharp, jittering.
            return BlobPersonality(amp: 0.40, speed: 2.6, churn: 3.2, pull: 0.10, squash: 1.00, spin: 0.00, jitter: 0.4, glow: 0.60, ramp: .sharp, fps: 24)
        }
    }
}

/// What the blob is pressed against: a normal pointing from the surface toward free
/// space (field/CG orientation, y down) and how hard (0 touching, 1 flattened, >1 squeezed in).
/// A sticky one adds the adhesion: `stuck` (the patch is glued on: the dome sags onto it
/// and breathes), `neck` (0 flat … 1 about to let go: the patch stays on the surface
/// while a neck stretches to the body) and `smear`, the body's speed along the surface
/// (pt/s, positive along (−ny, nx)) that the footprint lags behind.
struct BlobContact: Equatable {
    var nx: Double
    var ny: Double
    var press: Double
    /// Distance (pt) from the body's centre to the surface, when there is one to
    /// measure (a wall, a window; negative inside a window): the renderer puts the
    /// flat face and the neck's foot there. Nil for an impact's echo.
    var distance: Double? = nil
    var neck = 0.0
    var smear = 0.0
    var stuck = false
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
    private var phaseTarget = BlobPersonality.forPhase(.asleep)
    /// The personality the field eases toward: the phase's, quickened while in flight.
    private var target: BlobPersonality { flight ? phaseTarget.inFlight(moving: flightMoving) : phaseTarget }
    private var cur = BlobPersonality.forPhase(.asleep)
    /// Set by the controller for the whole of an `orb.fly` — out, hover, home. The
    /// field takes the acting colour and a faster shimmer, whatever the phase, so the
    /// blob on the move reads as Jarhead at work.
    var flight = false {
        didSet {
            guard flight != oldValue else { return }
            flightChangedAt = t
            if flight { nudge(reducedMotion ? 0.3 : 0.8) }
        }
    }
    /// The body is in the air (out or home) rather than parked beside the work; full
    /// frame rate only then. Set by the controller from the physics.
    var flightMoving = false
    private var flightChangedAt = -100.0
    /// The colour of a trace's line while the blob draws it (an `orb.trace` tone); nil
    /// for the acting green of an ordinary flight. Read only while `flight` is on.
    var traceColor: RGB?

    // MARK: the cursor (a trace)

    /// The cursor form: set by the controller for the whole of an `orb.trace` — from
    /// take-off, so the blob turns into the pen on its way to the first point — as the
    /// unit direction of travel (CG orientation). Nil morphs it back. The body pulls
    /// into a compact teardrop whose point leads: the stretch axis is turned against
    /// the travel — and swung `cursorPenAngle` off it, to the `cursorHand` side, the
    /// way a pen is held — so the tail, the end the drag physics draws to a point, is
    /// at the front on the pen while the body rides beside the line it has just drawn
    /// instead of trailing on it (the line paints above the orb, and ran through the
    /// face). The eyes narrow and look along the travel; the colour is the line's.
    /// Every quantity eases (`cursorTau`), so the morph is a morph and a corner swings
    /// the body round the pen instead of snapping it.
    var cursor: CGVector? {
        didSet {
            guard (cursor == nil) != (oldValue == nil) else { return }
            cursorChangedAt = t
            nudge(reducedMotion ? 0.2 : 0.7)
        }
    }
    /// Which side of the line the body rides on: +1 puts it above a line drawn to the
    /// right (the outside of a loop drawn clockwise on screen), −1 the other way. The
    /// controller sets it per trace from the stroke's turn so the body stays outside a
    /// loop instead of cutting through it.
    var cursorHand = 1.0
    /// How far the pen's axis is swung off the travel (radians): the body 36° to the
    /// side puts the eyes about two eye-widths clear of the line at full form.
    static let cursorPenAngle = 36.0 * .pi / 180
    /// How far into the cursor form (0 blob … 1 pen), eased.
    private var cursorK = 0.0
    /// The travel direction the form points along, eased as a vector so it turns.
    private var cursorDirX = 1.0, cursorDirY = 0.0
    private var cursorChangedAt = -100.0
    /// The eased elongation of the pen: a firm teardrop, short of the drag's maximum.
    static let cursorStretch = 0.66
    /// The pen is compact: the body's radius shrinks by this share at full form.
    static let cursorShrink = 0.2
    /// Extra pinch on the last third of the tail at full form: the needle.
    static let cursorPinch = 2.6
    static let cursorTau = 0.14
    /// The pen stick (`render`): glyphs rasterised along the axis from this share of
    /// the body's radius out to the point, so the needle reaches the pen whatever its
    /// angle — the thinned tail alone rendered only where a cell centre happened to
    /// fall inside it, and stopped a finger's width short of the line. Its glyph
    /// depth runs from `penDepthBody` at the body to `penDepthTip` at the point.
    static let penStickFrom = 0.8
    static let penDepthBody = 0.5
    static let penDepthTip = 0.3
    /// Where the pen's point is this frame, from the field's centre, in points (CG
    /// orientation): the tail's tip along the travel, as `render` last laid it out.
    /// The controller places the body so that `center + cursorTip` is the pen point.
    private(set) var cursorTip = CGVector.zero
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
    /// wakeHeard changed (or a flight landed): when the surface last swelled.
    private var rippleAt = -100.0
    /// Rows the ripple adds at its peak: half a row for "I hear you", a full one for a landing.
    private var rippleGain = 0.55
    static let flashTau = 0.32
    static let pulseTau = 0.45
    static let rippleLength = 0.36
    static let breathPeriod = 4.0

    /// Ramp index per cell, row-major; 0 is blank.
    private(set) var cells = [UInt8](repeating: 0, count: BlobSim.cellCount)
    /// Halo coverage per cell (0…255): the silhouette plus a soft margin. The view
    /// upscales it into the glow behind the glyphs.
    private(set) var halo = [UInt8](repeating: 0, count: BlobSim.cellCount)
    /// Per-cell flags: bit 0 set = the wet patch (drawn from the dense ramp, a step brighter).
    private(set) var flags = [UInt8](repeating: 0, count: BlobSim.cellCount)
    nonisolated static let wetFlag: UInt8 = 1

    // MARK: motion (the jelly)

    /// The last motion the physics reported, CG orientation: the drag's lag (grab
    /// target − centre, pt), the hand's hold relative to the centre, the velocity and
    /// acceleration (pt/s, pt/s²), and whether a hand is on it.
    private var lag = CGVector.zero
    private var grab: CGVector?
    private var velocity = CGVector.zero
    /// The body's change of velocity (pt/s) since the last field frame, summed over
    /// the physics ticks in between, so a one-tick wall impulse rings the wobble
    /// whichever tick it fell on.
    private var dvX = 0.0, dvY = 0.0
    private var dragging = false
    private var wasDragging = false
    /// The eased stretch: a unit direction (toward the hand, or along the flight) and
    /// the elongation 0…`maxStretch` — how far the silhouette is pulled into a teardrop.
    private var stretchX = 1.0, stretchY = 0.0
    private var stretch = 0.0
    /// The shear from where the hand holds the body: the grabbed side leads, the rest
    /// trails like a lifted skirt. Signed, in the stretch's perpendicular.
    private var shear = 0.0
    /// The body's speed (pt/s), eased, for the eyes and the flight elongation.
    private var speed = 0.0
    /// The wobble: three damped oscillators on the low harmonics, masses inside the
    /// body rung by its changes of velocity (impacts, the hand speeding up or
    /// stopping, the release) — a slosh (k = 1, a vector in rows: the mass lags the
    /// body), an ellipse mode along the motion (k = 2) and a triangle mode (k = 3),
    /// both fractions of the radius. `gain` is the share of the body's Δv the mode
    /// picks up (1 would be a free mass). ζ ≈ 0.13–0.16: ringing for ~0.8 s.
    private struct Mode { var x = 0.0, v = 0.0; let hz: Double; let zeta: Double; let gain: Double; let cap: Double }
    private var sloshX = Mode(hz: 3.2, zeta: 0.14, gain: 0.35, cap: 0.9)
    private var sloshY = Mode(hz: 3.2, zeta: 0.14, gain: 0.35, cap: 0.9)
    private var mode2 = Mode(hz: 4.6, zeta: 0.13, gain: 0.7, cap: 0.32)
    private var mode3 = Mode(hz: 6.4, zeta: 0.16, gain: 0.35, cap: 0.22)
    /// The motion's direction (eased angle vector) the k = 2 and 3 modes are aligned to.
    private var motionX = 1.0, motionY = 0.0
    /// A hard landing: one dense burst over the whole body, gone in a few frames.
    private var splat = 0.0
    static let splatTau = 0.09
    /// neck², while clinging: how hard the tail on the patch is pinched.
    private var necking = 0.0
    /// Elongation per point of lag, and its ceiling: 90 pt of lag (most of a radius)
    /// pulls the body to a 1.75 : 0.7 teardrop.
    static let stretchPerLag = 1 / 90.0
    static let maxStretch = 0.75
    /// The teardrop at unit stretch: the tail pulls out by this much of the radius,
    /// the leading side compresses by that much.
    static let tailStretch = 0.95
    static let leadCompress = 0.22
    /// Fixed volume: the stretched body's radius shrinks by 1 / (1 + this × stretch)
    /// (more for a vertical stretch, which the 15-row field has less room for), so
    /// the teardrop reads as thinner, not bigger, and its point stays on the field.
    static let stretchShrink = 0.3
    /// A thrown body elongates along its flight: this much per pt/s, capped lower.
    static let stretchPerSpeed = 1 / 3600.0
    static let maxFlightStretch = 0.42
    static let stretchTau = 0.07
    /// The most velocity change (pt/s) one field frame feeds the wobble: a hard bounce.
    static let maxImpulse = 800.0
    /// Sticky borders, in rows. `patchWidth`: how much the contact patch spreads along
    /// the surface per unit press (adhesion: the body wets the edge). `smearRows`: how
    /// far the footprint trails at `smearSpeed` along the surface.
    static let patchWidth = 0.55
    static let smearRows = 1.6
    static let smearSpeed = 700.0
    /// The neck, while clinging, × the body's radius: where its root sits inside the
    /// body (less as the neck grows — the body gives way to the neck past it), the
    /// root's half-width, the foot's on the surface (plus a share of the press: the
    /// patch it grew from), and the waist's at neck 0 — it narrows as (1 − neck)^0.8
    /// of that, to a hairline as the patch lets go.
    static let neckRoot = 0.66
    static let neckRootWidth = 0.5
    static let neckFootWidth = 0.35
    static let neckWaistWidth = 0.4
    /// The parked dome's breath: the patch's press swells this much over `breathPeriod`.
    static let domeBreath = 0.07

    // MARK: eyes

    /// One eye, for the view: its centre in cell units (fractional), the ASCII glyph
    /// it is drawn as (`BlobGlyphs.eyeGlyph`), the font size in points, how open the
    /// lid is (eased; the glyph already reflects it — under `shutOpenness` it is a
    /// `-`), and where the pair looks (−1…1; the pair is shifted by it).
    struct BlobEye {
        var col: Double
        var row: Double
        var glyph: Character
        var size: Double
        var open: Double
        var lookX: Double
        var lookY: Double
    }
    /// A glyph pair: left eye, right eye.
    struct Face: Equatable {
        var left: Character
        var right: Character
        init(_ both: Character) { left = both; right = both }
        init(left: Character, right: Character) { self.left = left; self.right = right }
    }
    private(set) var eyes: [BlobEye] = []
    /// The expression this frame, whether or not the pair found body to sit on: the
    /// glyphs as drawn (lids and squint applied), the eased look, the font size. The
    /// notch draws its face from this, so the face is one face wherever the blob is.
    private(set) var face = Face("-")
    private(set) var faceLookX = 0.0, faceLookY = 0.0
    private(set) var faceSize = BlobSim.eyeSizePt
    /// Cells under the eyes: the view draws no body glyph there.
    private(set) var eyeFootprint: [Int] = []
    /// Where the eyes look (−1…1), eased so they never snap.
    private var lookX = 0.0, lookY = -0.25
    /// Where the eyes sit (cells), eased the same way: a lobe or the squish moving
    /// under them shifts them, never jumps them.
    private var eyeRow = 0.0, eyeLeftCol = 0.0, eyeRightCol = 0.0
    private var eyesPlaced = false
    /// Why the last eye fit failed (the numbers), for the preview harness.
    private(set) var eyeFitNote = ""
    static let eyePlaceTau = 0.09
    /// Rows to try around the eyes' nominal row, in order: half a row up first, then down the face.
    static let eyeRowSearch: [Double] = [0, -0.5, 0.5, -1, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5]
    /// The same search on whole rows only, for muted's `_ _` (see `renderEyes`).
    static let eyeRowSearchWhole: [Double] = eyeRowSearch.filter { $0 == $0.rounded() }
    /// The least the eyes sit apart, in columns: a glyph (1.8 cells wide) plus a hair of face between.
    static let minEyeSpread = 1.9
    /// Each eye's openness, eased; the lids move fast (a blink is 120 ms) but not instantly.
    private var openL = 0.1, openR = 0.1
    private var nextBlinkAt = 3.0
    private var blinkUntil = -1.0
    private var blinkLength = 0.12
    private var doubleBlinkAt = -1.0
    private var pokedAt = -100.0
    /// A wandering glance (connecting looks around; listening turns to "the last sound").
    private var glanceX = 0.0, glanceY = -0.3
    private var nextGlanceAt = 0.0
    /// The listening perk-up: an onset in the input level widens the eyes, then decays.
    private var perk = 0.0
    private var lastInput = 0.0
    /// The hand's position relative to the body centre (pt, CG orientation), if the
    /// controller can say; the listening eyes follow it within `followReach`.
    var pointer: (() -> CGVector?)?
    /// What the acting eyes track (the flight target relative to the centre, pt); nil for the direction of motion.
    var attention: CGVector?
    static let followReach = 300.0
    /// Half an eye's width in points, for the drag's shear normalisation: about the
    /// eye glyph's half-advance at `eyeSizePt`.
    static let eyeRadiusPt = 8.6
    /// The eyes' font size: 1.7× the field's cell font, bold — big enough to read as a
    /// face from across the room, small enough to leave body around them.
    static let eyeScale = 1.7
    nonisolated static let eyeSizePt = 10.0 * 1.7
    /// Under this openness the eye is a `-`: the blink, the squint, a body pressed flat.
    static let shutOpenness = 0.3
    /// Row height in points, from the view's metrics: the eyes are sized in points.
    var rowHeightPt = 10.5

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

    // Contacts, each spring-damped toward the value physics reports. The adhesion
    // parts ride along: `stuck`, `neck` and `distance` adopted at once (they are the
    // physics' own eased quantities), `smear` eased here (in rows).
    private struct ContactSlot {
        var nx = 0.0, ny = 0.0, press = 0.0, target = 0.0, vel = 0.0
        var neck = 0.0, smear = 0.0, smearTarget = 0.0
        var distance: Double? = nil
        var stuck = false
    }
    private var contacts = [ContactSlot(), ContactSlot()]
    /// The contacts as drawn this frame: `contacts` plus the parked dome's breath.
    private var shown = [ContactSlot(), ContactSlot()]
    static let stiffness = 165.0
    static let damping = 15.0
    private var springsMoving = false

    init() {}

    // MARK: inputs

    func setPhase(_ p: Phase) {
        guard p != phase else { return }
        phase = p
        phaseTarget = .forPhase(p)
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
        rippleGain = 0.55
    }

    /// A flight arrived: one ring runs out through the surface, a row deep, and is gone.
    func rippleLanding() {
        rippleAt = t
        rippleGain = reducedMotion ? 0.5 : 1.0
    }

    /// Adopt the new normals immediately; only the magnitude is sprung, so a contact
    /// that jumps to another wall does not swing through the middle. The neck is
    /// adopted at once too (it is the physics' own eased quantity); the smear eases here.
    func setContacts(_ list: [BlobContact]) {
        for i in contacts.indices {
            if i < list.count {
                contacts[i].nx = list[i].nx
                contacts[i].ny = list[i].ny
                contacts[i].target = list[i].press
                contacts[i].neck = list[i].neck
                contacts[i].stuck = list[i].stuck
                contacts[i].distance = list[i].distance
                // The footprint trails the motion: the sample point shifts against it.
                contacts[i].smearTarget = -min(1, max(-1, list[i].smear / Self.smearSpeed)) * Self.smearRows
            } else {
                contacts[i].target = 0
                contacts[i].neck = 0
                contacts[i].stuck = false
                contacts[i].distance = nil
                contacts[i].smearTarget = 0
            }
        }
    }

    /// The body's motion this physics tick. Everything the jelly reads: the lag
    /// stretches it, the grab shears it, the change of velocity rings the wobble, the
    /// velocity elongates a throw and gives the eyes something to look along.
    func setMotion(lag l: CGVector, grab g: CGVector?, velocity v: CGVector, dragging d: Bool) {
        lag = l
        grab = g
        dvX += v.dx - velocity.dx
        dvY += v.dy - velocity.dy
        velocity = v
        dragging = d
    }

    /// Extra agitation (an impact, a summon landing), decaying away.
    func nudge(_ strength: Double) {
        shiver = min(4, shiver + (reducedMotion ? strength * 0.3 : strength))
        for i in harmonics.indices { harmonics[i].amp += gaussianRandom() * 0.12 * strength * harmonics[i].weight }
    }

    /// A hard landing: the whole body goes dense for a few frames and the patch
    /// spreads wide, then the bounce carries on. `strength` 0…1.
    func splat(_ strength: Double) {
        splat = min(1, max(splat, reducedMotion ? strength * 0.4 : strength))
        ring(mode2: 0.25 * strength, mode3: 0.12 * strength)
    }

    /// The patch let go of a surface whose outward normal is (nx, ny): a recoil wobble
    /// away from it, a ripple through the surface.
    func snapFree(nx: Double, ny: Double) {
        let k = reducedMotion ? 0.35 : 1.0
        sloshX.v -= nx * 3.2 * k
        sloshY.v -= ny * 3.2 * k
        ring(mode2: 0.22 * k, mode3: 0.1 * k)
        nudge(0.7)
        rippleAt = t
        rippleGain = 0.7 * k
    }

    /// A tap: wide eyes, then a blink (the blink is scheduled from the poke).
    func poke() {
        pokedAt = t
        blinkUntil = -1
        doubleBlinkAt = -1
        nextBlinkAt = t + 0.26
    }

    private func ring(mode2 a2: Double, mode3 a3: Double) {
        mode2.v += a2 * 2 * .pi * mode2.hz
        mode3.v += a3 * 2 * .pi * mode3.hz
    }

    // MARK: scheduling

    /// True while the contact springs are still settling or a transition is live. A
    /// flight counts around take-off and touch-down (the colour change, the tense
    /// shiver, the landing ripple), not for its whole length: the in-flight
    /// personality sets the rate while the body moves (`inFlight(moving:)`).
    var isLively: Bool {
        springsMoving || shiver > 0.03 || flash > 0.02 || pulse > 0.02 || t - rippleAt < Self.rippleLength
            || t - phaseChangedAt < 1.0 || t - gateChangedAt < 1.0 || t - flightChangedAt < 1.0 || t - cursorChangedAt < 1.0
            || motionLively
    }

    /// The jelly is still moving: stretched, wobbling, splatting, or a hand is on it.
    private var motionLively: Bool {
        dragging || stretch > 0.01 || splat > 0.02 || t - pokedAt < 0.6 || cursor != nil || cursorK > 0.01
            || abs(sloshX.x) + abs(sloshY.x) + abs(mode2.x) + abs(mode3.x) > 0.012
            || abs(sloshX.v) + abs(sloshY.v) + abs(mode2.v) + abs(mode3.v) > 0.08
    }

    var desiredFPS: Double { isLively ? 24 : target.fps }

    /// Nothing worth a frame: muted and settled, or fast asleep (asleep for a while
    /// with nothing happening — it stops breathing until something pokes it). The
    /// view then pauses the display link entirely. An ear keeps it awake: the gate's
    /// listening breath and authenticating pulse need frames, at the asleep cadence
    /// (10 fps), never more. A blob on a flight is never static — a muted one hovering
    /// beside the work still shimmers at muted's own rate rather than freezing.
    var isStatic: Bool {
        guard !isLively, !flight, rawInput < 0.02, rawOutput < 0.02 else { return false }
        switch phase {
        case .muted: return t - phaseChangedAt > 1.5
        // Paused breathes (slowly, at its own 8 fps) for a while, then rests as sleep
        // does — a session left paused for an hour should not cost frames all hour —
        // until a poke, sound or a phase change wakes it; at once under reduce motion,
        // where there is no breath to show.
        case .paused: return t - phaseChangedAt > (reducedMotion ? 1.5 : 20)
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

    /// The colour the field eases toward: the phase's, or the gate's while asleep, or
    /// acting's for the whole of a flight — the line's tone when the flight is a trace.
    private var targetColor: RGB {
        if flight { return traceColor ?? OrbPalette.acting }
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
        frameDt = dt
        easeParams(dt)
        smoothLevels(dt)
        stepHarmonics(dt)
        stepMotion(dt)
        springsMoving = stepSprings(dt)
        render()
    }

    /// The jelly: ease the stretch toward what the lag (or the flight) asks, the shear
    /// toward the grab, and ring the wobble modes with the acceleration. The release
    /// itself is a kick: the spring force vanished, and the body jiggles with what it had.
    private func stepMotion(_ dt: Double) {
        let lagLen = (lag.dx * lag.dx + lag.dy * lag.dy).squareRoot()
        let vLen = (velocity.dx * velocity.dx + velocity.dy * velocity.dy).squareRoot()
        speed += (vLen - speed) * min(1, dt * 14)
        let k = 1 - exp(-dt / Self.stretchTau)

        var want = 0.0
        var dx = stretchX, dy = stretchY
        // Clinging: the whole body is a teardrop pulled off the patch — the tail on the
        // wall, the hand's side compressed — so the neck has a body to narrow from.
        var neck = 0.0
        var neckNX = 0.0, neckNY = 0.0
        for c in contacts where c.neck > neck { neck = c.neck; neckNX = c.nx; neckNY = c.ny }
        necking = neck * neck
        if dragging {
            want = min(Self.maxStretch, lagLen * Self.stretchPerLag + neck * 0.5)
            if lagLen > 3 { dx = lag.dx / lagLen; dy = lag.dy / lagLen } else if neck > 0 { dx = neckNX; dy = neckNY }
        } else if vLen > 60 {
            want = min(Self.maxFlightStretch, vLen * Self.stretchPerSpeed)
            dx = velocity.dx / vLen; dy = velocity.dy / vLen
        }
        if reducedMotion { want *= 0.4 }
        // The pen: a fixed teardrop pointing along the travel — the stretch axis
        // turned against it, so the drawn-to-a-point tail is the front — blended in
        // by how far into the form the body is.
        let ck = 1 - exp(-dt / Self.cursorTau)
        cursorK += ((cursor == nil ? 0 : 1) - cursorK) * ck
        if let c = cursor {
            let cl = (c.dx * c.dx + c.dy * c.dy).squareRoot()
            if cl > 0.01 {
                cursorDirX += (c.dx / cl - cursorDirX) * ck
                cursorDirY += (c.dy / cl - cursorDirY) * ck
                let dl = (cursorDirX * cursorDirX + cursorDirY * cursorDirY).squareRoot()
                if dl > 0.01 { cursorDirX /= dl; cursorDirY /= dl } else { cursorDirX = c.dx / cl; cursorDirY = c.dy / cl }
            }
        }
        if cursorK > 0.01 {
            let formStretch = reducedMotion ? Self.cursorStretch * 0.4 : Self.cursorStretch
            want = want * (1 - cursorK) + formStretch * cursorK
            // Against the travel, then swung off it to the hand's side (see `cursorHand`).
            let (ax, ay) = Self.penAxis(dirX: cursorDirX, dirY: cursorDirY, hand: cursorHand)
            dx = dx * (1 - cursorK) + ax * cursorK
            dy = dy * (1 - cursorK) + ay * cursorK
        }
        // The direction eases as a vector so it turns instead of flipping.
        stretchX += (dx - stretchX) * k
        stretchY += (dy - stretchY) * k
        let len = (stretchX * stretchX + stretchY * stretchY).squareRoot()
        if len > 0.01 { stretchX /= len; stretchY /= len } else { stretchX = dx; stretchY = dy }
        stretch += (want - stretch) * k

        // Shear: the hand's hold, measured across the stretch — the held side leads.
        var wantShear = 0.0
        if dragging, let g = grab, want > 0.02 {
            let perp = -g.dx * stretchY + g.dy * stretchX
            wantShear = min(1, max(-1, perp / (Self.eyeRadiusPt * 9))) * 1.2 * want
        }
        shear += (wantShear - shear) * k

        // Motion axis for the k = 2 / 3 modes.
        if vLen > 40 {
            motionX += (velocity.dx / vLen - motionX) * min(1, dt * 10)
            motionY += (velocity.dy / vLen - motionY) * min(1, dt * 10)
        }

        // Wobble: the modes are masses inside the body, so its change of velocity since
        // the last frame — the hand speeding up or stopping, a wall, a flick — kicks
        // each by gain × Δv: in rows for the slosh, as a fraction of the radius for
        // the k = 2, 3 modes. A brisk drag's 4500 pt/s² holds the slosh about 0.4 row
        // behind the hand and swings it forward when the hand stops; a 600 pt/s bounce
        // throws it most of a row and rings the ellipse mode to its cap. Release is a
        // kick of its own: the spring force vanished, and the body jiggles with what it had.
        var jx = dvX / rowHeightPt, jy = dvY / rowHeightPt   // rows/s
        dvX = 0; dvY = 0
        let jLen = (jx * jx + jy * jy).squareRoot()
        let jCap = Self.maxImpulse / rowHeightPt
        if jLen > jCap { jx *= jCap / jLen; jy *= jCap / jLen }
        // The pen's surface is calm: the speed changes of being led along a line (the
        // ease-in, the corners) ring it half as hard, so its body — and the eye row —
        // is not pinched by a wobble mid-stroke.
        let g = (reducedMotion ? 0.3 : 1.0) * (1 - 0.5 * cursorK)
        sloshX.v -= jx * sloshX.gain * g
        sloshY.v -= jy * sloshY.gain * g
        let jr = min(jLen, jCap) / (Double(Self.rows) * 0.38)   // radii/s
        mode2.v += jr * mode2.gain * g
        mode3.v += jr * mode3.gain * g * (mode3.x >= 0 ? -1 : 1)
        if wasDragging, !dragging {
            let kick = (reducedMotion ? 0.3 : 1.0) * (0.35 + stretch)
            sloshX.v += stretchX * 2.4 * kick
            sloshY.v += stretchY * 2.4 * kick
            ring(mode2: 0.18 * kick, mode3: 0.08 * kick)
        }
        wasDragging = dragging

        Self.advance(&sloshX, dt)
        Self.advance(&sloshY, dt)
        Self.advance(&mode2, dt)
        Self.advance(&mode3, dt)
        splat *= exp(-dt / Self.splatTau)
    }

    /// One exact step of the damped oscillator (ζ < 1), stable for any dt. The asleep
    /// cadence (10 fps; a frame gap is clamped to 0.1 s) puts the fastest mode at
    /// ω·dt ≈ 4, where the semi-implicit Euler step this replaced — stable only below
    /// ω·dt ≈ 1.7, even halved — fed on its own error, re-armed `motionLively` every
    /// frame and never let the display link pause.
    private static func advance(_ m: inout Mode, _ dt: Double) {
        let w = 2 * .pi * m.hz
        let zw = m.zeta * w
        let wd = w * (1 - m.zeta * m.zeta).squareRoot()
        let decay = exp(-zw * dt)
        let c = cos(wd * dt), s = sin(wd * dt)
        let b = (m.v + zw * m.x) / wd
        let x = decay * (m.x * c + b * s)
        m.v = decay * ((b * wd - zw * m.x) * c - (m.x * wd + zw * b) * s)
        m.x = min(m.cap, max(-m.cap, x))
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
        // A flight changes colour on take-off and on touch-down, not over the first
        // stretch of the trip: the colour eases twice as fast around those moments.
        let colorK = t - flightChangedAt < 1.0 ? 1 - exp(-dt / (Self.easeTau * 0.45)) : k
        color = color.mixed(with: targetColor, colorK)
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

    /// The contact springs. The parked dome's breath is not here: it is a render-time
    /// term (`render`), so it never counts as spring motion and a fast-asleep blob
    /// stops breathing when the link pauses.
    private func stepSprings(_ dt: Double) -> Bool {
        let step = min(dt, 1.0 / 30)
        var moving = false
        for i in contacts.indices {
            var c = contacts[i]
            let accel = (c.target - c.press) * Self.stiffness - c.vel * Self.damping
            c.vel += accel * step
            c.press += c.vel * step
            c.smear += (c.smearTarget - c.smear) * min(1, step * 9)
            if abs(c.vel) > 0.002 || abs(c.target - c.press) > 0.002 || abs(c.smearTarget - c.smear) > 0.01 { moving = true }
            contacts[i] = c
        }
        return moving
    }

    // MARK: silhouette

    /// Radius multiplier at a given angle: the Brownian outline. The caller floors it
    /// (after adding the wobble) well above zero, because a sum that reaches -1 would
    /// fold the surface through the centre. `ampScale` is the frame's wander amplitude
    /// (see `ampBreath`).
    private func outline(_ angle: Double, ampScale: Double) -> Double {
        var sum = 0.0
        for h in harmonics { sum += h.amp * (h.k == 1 ? lobeScale : 1) * sin(h.k * angle + h.phase) }
        return 1 + (sum / weightSum) * ampScale
    }

    /// The k = 1 harmonic is a lopsided lobe — mass to one side. Pressed against a
    /// surface the surface decides where the mass is, so it fades with the press: a
    /// parked dome sits square on its edge instead of leaning off it.
    private var lobeScale = 1.0

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

    private static func smoothstep(_ x: Double) -> Double {
        let u = min(1, max(0, x))
        return u * u * (3 - 2 * u)
    }

    // MARK: deformation (all in the world frame; the spin turns only the outline)

    /// The drag stretch, as an inverse map: a field point is pulled back to where it
    /// samples the undeformed body. Along the stretch (u toward the hand) the trailing
    /// half is extended by up to 1 + `tailStretch`·e and the leading half compressed
    /// by 1 − `leadCompress`·e — the teardrop — blended across the middle; the tail
    /// thins as it goes out (its perpendicular grows in the inverse); the shear leads
    /// the grabbed side. `base` is the volume-kept (shrunk) radius, see `render`. Also
    /// returns a density multiplier: the tail's glyphs thin (surface tension), the
    /// front's bunch where the body piles up.
    private func stretched(_ x: Double, _ y: Double, base: Double) -> (Double, Double, Double) {
        let e = stretch
        let sx = stretchX, sy = stretchY
        var u = x * sx + y * sy
        let w = -x * sy + y * sx
        u -= shear * w
        // 0 deep in the tail … 1 on the leading side.
        let tLead = Self.smoothstep(u / base * 0.9 + 0.5)
        let along = (1 + Self.tailStretch * e) * (1 - tLead) + (1 - Self.leadCompress * e) * tLead
        let uu = u / along
        let tail = u < 0 ? min(1, -u / base) : 0
        // The tail draws to a point (harder the further out, harder still while the
        // patch holds it); the front bulges where the body piles up.
        let thin = 1 + e * (0.5 * tail + 1.4 * tail * tail) + necking * 2.5 * tail + cursorK * Self.cursorPinch * tail * tail * tail
        let widen = 1 + 0.22 * e * tLead
        let ww = w * thin / widen
        let density = (1 - 0.5 * e * tail) * (1 + 0.3 * e * tLead * tLead)
        return (uu * sx - ww * sy, uu * sy + ww * sx, density)
    }

    private struct Deformed {
        var x: Double, y: Double
        var clipped: Bool
        /// Depth of a neck cell (0…1), or −1 outside the neck.
        var neckDepth: Double
        /// How much of the wet patch this cell is (0…1).
        var wet: Double
        /// How much of the body is drawn here (1 all of it): clinging, the body ends
        /// at the neck's root and the neck takes over from there to the surface.
        var body: Double
    }

    /// The contacts. Per contact: compress along the normal and spread across it
    /// (fixed volume), the adhesion widening the spread near the surface into the
    /// contact patch (`patchWidth`, more on a splat) and the smear shifting the
    /// footprint along it; then the surface hard-clips anything past it — the flat
    /// face, on the surface's real distance when the contact knows it. Clinging, the
    /// face relaxes as the body is pulled off; the body ends at the neck's root and
    /// the neck (drawn here, not by the outline) bridges from there out to a foot on
    /// the surface, narrowing in the middle until it parts; only the foot is wet.
    private func deformed(_ dx: Double, _ dy: Double, base: Double, sq: Double) -> Deformed {
        var ox = dx, oy = dy
        var wet = 0.0
        var neckDepth = -1.0
        var clipped = false
        var body = 1.0
        var active = 0
        for c in shown where c.press > 0.01 { active += 1 }
        // A corner applies two contacts; multiplying both squashes collapsed the blob
        // into a line. Splitting the budget keeps a corner squish dramatic.
        let share = active > 1 ? 0.68 : 1.0

        for c in shown where c.press > 0.01 {
            let press = c.press * share
            let along = ox * c.nx + oy * c.ny
            let pw = -ox * c.ny + oy * c.nx
            let bodyPress = press * (1 - 0.55 * c.neck)
            // The surface's plane, along −n from the centre, in body units. A contact
            // that knows its distance (a wall, a window) puts it exactly there — the
            // vertical squash taken out for a horizontal surface — so the flat face
            // lies on the screen's own edge and the neck's foot lands on it, whatever
            // the press says. An impact (no surface left to measure) brings a plane
            // in with its press.
            let wall: Double
            if let d = c.distance, d > 0 {
                wall = d / rowHeightPt / (1 + (sq - 1) * c.ny * c.ny)
            } else {
                wall = base * (1 - min(0.66, bodyPress * 0.6))
            }

            if c.neck > 0.01 {
                // Root inside the body, foot on the surface, everything this side of
                // the plane. The body gives way to the neck past the root, over half a
                // row, as the neck takes hold (`grip`).
                let grip = min(1, c.neck / 0.35)
                let root = -min(wall, base) * (Self.neckRoot - 0.16 * c.neck)
                let foot = -wall
                body = min(body, 1 - grip * Self.smoothstep((root - along) / 0.6 + 0.5))
                if along < root, along > foot {
                    let s = (root - along) / (root - foot)   // 0 at the body, 1 at the surface
                    // A suction cup: the foot on the surface about as wide as the root on
                    // the body, the waist between them narrowing with the neck to a hairline.
                    let rootW = base * Self.neckRootWidth
                    let footW = base * (Self.neckFootWidth + 0.25 * min(1, press))
                    let waist = max(0.12, base * Self.neckWaistWidth * pow(max(0, 1 - c.neck), 0.8))
                    let bulge = sin(.pi * s)
                    let half = (rootW * (1 - s) + footW * s) * (1 - bulge) + waist * bulge
                    let off = abs(pw - c.smear * s) / half
                    if off < 1 {
                        let d = (1 - off * off) * (0.9 - 0.3 * c.neck) * (1 - 0.1 * s)
                        neckDepth = max(neckDepth, d * grip)
                        if s > 0.7 { wet = max(wet, press * min(1, (s - 0.7) / 0.2)) }
                    }
                }
            }
            if along < -wall { clipped = true; continue }

            let wallness = along < 0 ? Self.smoothstep(-along / wall) : 0
            // Fixed volume: flattened along the normal, spread across it — except
            // against a side wall, where the 15-row field has no room to spread into
            // (the resting body already spans most of it): a side contact spreads
            // little and flattens less, so its dome stays rounded inside the field.
            let sideways = c.nx * c.nx
            let spreadK = min(0.8, bodyPress * 0.66) * (1 - 0.8 * sideways)
            let compressK = min(0.55, bodyPress * 0.47) * (1 - 0.45 * sideways)
            let compress = 1 / (1 - compressK)
            var spread = 1 / (1 + spreadK)
            spread /= 1 + (Self.patchWidth * press * (1 - 0.6 * sideways) + splat * 0.7) * wallness * wallness
            let pws = pw - c.smear * wallness * wallness
            ox = c.nx * along * compress - c.ny * pws * spread
            oy = c.ny * along * compress + c.nx * pws * spread
            // The wet band on the face — gone once the body is being peeled off, when
            // only the neck's foot is wet.
            if press > 0.2, c.neck < 0.3 {
                wet = max(wet, min(1, press) * Self.smoothstep((wallness - 0.55) / 0.45) * (1 - c.neck / 0.3))
            }
        }
        return Deformed(x: ox, y: oy, clipped: clipped, neckDepth: neckDepth, wet: wet, body: body)
    }

    /// Net push direction (and total press), used to slide the body away from what it
    /// is pressed against and to aim the eyes.
    private func contactBias() -> (bx: Double, by: Double, total: Double) {
        var bx = 0.0, by = 0.0, total = 0.0
        for c in shown where c.press > 0.01 {
            bx += c.nx * c.press
            by += c.ny * c.press
            total += c.press
        }
        return (bx, by, total)
    }

    private func render() {
        let cols = Self.cols, rows = Self.rows
        let sq = cur.squash == 0 ? 1 : cur.squash
        // The contacts as drawn: the springs' state, plus the parked dome's breath — a
        // render-time swell of the patch's press, never spring motion, so it rides the
        // frames the phase already draws and stops with them when the link pauses.
        let domeBreath = reducedMotion ? 0 : Self.domeBreath * sin(2 * .pi * t / Self.breathPeriod)
        for i in contacts.indices {
            shown[i] = contacts[i]
            if contacts[i].stuck, contacts[i].neck == 0, !dragging { shown[i].press *= 1 + domeBreath }
        }
        let bias = contactBias()
        var stuckAny = false, anyContact = false
        for c in shown where c.press > 0.01 { anyContact = true; if c.stuck { stuckAny = true } }
        lobeScale = 1 - 0.65 * min(1, bias.total)
        // Pressed blobs slide their mass away from the wall — glued to it, the dome sags
        // onto the patch instead. The slosh mode moves the whole mass too.
        let slide = stuckAny ? 0.3 : 0.9
        // Smaller than v1's 0.42: the lobes reach 1.5× the base and were hard-clipping
        // into flat edges at the field boundary. The calibration ripple adds at most
        // half a row (about one column) to the radius for a third of a second.
        let base = Double(rows) * 0.38 * breath() + rippleGain * ripple
        // Stretched, the body keeps its volume — its radius shrinks as it lengthens
        // (`stretchShrink`) — and its outline smooths, as a skin under tension does.
        // The whole of it sits toward the hand in its field, by half the difference
        // between the tail's reach and the compressed front's, so the tail's point
        // lands inside the field and not in its fade. Not for the part of the stretch
        // that is the cling, whose foot must stay on the real edge.
        let e = stretch
        // The pen is compact (`cursorShrink`) and its surface calm, so its point holds still.
        let bodyBase = base / (1 + (Self.stretchShrink + 0.4 * stretchY * stretchY) * e) * (1 - Self.cursorShrink * cursorK)
        let toward = bodyBase * (Self.tailStretch + Self.leadCompress) / 2 * max(0, e - necking.squareRoot() * 0.5)
        let cx = Double(cols - 1) / 2 + (leanX * cur.pull + bias.bx * slide) * Double(cols) * 0.16 + jitterX + (sloshX.x + stretchX * toward) * aspect
        let cy = Double(rows - 1) / 2 + (leanY * cur.pull + bias.by * slide) * Double(rows) * 0.16 - lift + jitterY + sloshY.x + stretchY * toward * sq
        let ampScale = cur.amp * 2.6 * ampBreath * (1 - 0.4 * e) * (1 - 0.65 * cursorK)
        // Where the tail's point lands this frame — the pen: the outline's tip along
        // −stretch at 1 + tailStretch·e of the radius, from an outline centre `toward`
        // off the field's, in points. Columns are `aspect` per row, so a column
        // offset × cellWidth is a row offset × rowHeight; rows carry the squash.
        if cursorK > 0.01 {
            let reach = bodyBase * (1 + Self.tailStretch * e)
            let tipCol = (cx - Double(cols - 1) / 2) - stretchX * reach * aspect
            let tipRow = (cy - Double(rows - 1) / 2) - stretchY * reach * sq
            cursorTip = CGVector(dx: tipCol / aspect * rowHeightPt, dy: tipRow * rowHeightPt)
        } else {
            cursorTip = .zero
        }
        let rampLen = Double(ramp.glyphs.count)
        let maxIdx = UInt8(ramp.glyphs.count - 1)
        let stretching = stretch > 0.004
        let wobbling = abs(mode2.x) > 0.003 || abs(mode3.x) > 0.003
        let mAngle = atan2(motionY, motionX)
        let splatBoost = splat * 0.55
        let wetAll = splat > 0.45

        var i = 0
        for y in 0..<rows {
            let ry = (Double(y) - cy) / sq
            let edgeY = min(y, rows - 1 - y)
            for x in 0..<cols {
                // Squash vertically per personality; everything else is an inverse map
                // of this point back onto the undeformed body. The contacts go first —
                // a wall is a plane fixed in the field, so its clip and the neck's foot
                // must be measured here, not in the stretched body's frame — then the
                // stretch, whose tail the wall then cuts flat at the patch.
                var ox = (Double(x) - cx) / aspect, oy = ry
                var density = 1.0
                var wet = 0.0, neckDepth = -1.0, bodyKeep = 1.0
                var clipped = false
                if anyContact {
                    let d = deformed(ox, oy, base: bodyBase, sq: sq)
                    ox = d.x; oy = d.y; wet = d.wet; neckDepth = d.neckDepth; clipped = d.clipped; bodyKeep = d.body
                }
                if stretching, !clipped { (ox, oy, density) = stretched(ox, oy, base: bodyBase) }
                var depth = 0.0, g = 0.0
                if !clipped, bodyKeep > 0.001 {
                    let dist = (ox * ox + oy * oy).squareRoot()
                    let angle = atan2(oy, ox)
                    // The spun harmonic outline plus the wobble modes; floored so the
                    // surface never folds through the centre.
                    var mul = outline(angle + spinPhase, ampScale: ampScale)
                    if wobbling { mul += mode2.x * cos(2 * (angle - mAngle)) + mode3.x * cos(3 * (angle - mAngle)) }
                    let radius = bodyBase * max(0.35, mul)
                    // 0 at the surface, 1 deep inside.
                    depth = min(1, max(0, (radius - dist) / (radius * 0.8))) * density * bodyKeep
                    // The halo reaches past the surface and fades smoothly; the same lobes,
                    // so the glow hugs the silhouette instead of being a disc behind it.
                    g = min(1, max(0, (radius * 1.28 - dist) / (radius * 0.85)))
                    g = g * g * (3 - 2 * g) * (0.25 + 0.75 * bodyKeep)
                }
                if neckDepth > 0 {
                    depth = max(depth, neckDepth * density)
                    g = max(g, min(1, neckDepth + 0.45))
                }
                // The wet patch is where the body is pressed hardest: its glyphs go dense
                // however near the surface they are. A splat does that everywhere.
                if depth > 0 { depth = min(1, max(depth, wet * 0.85) + splatBoost) }
                // A lobe that runs off the field thins out instead of being cut flat.
                let edge = min(edgeY, min(x, cols - 1 - x))
                if edge == 0 { depth *= 0.3; g *= 0.35 } else if edge == 1 { depth *= 0.65; g *= 0.7 }
                cells[i] = depth <= 0 ? 0 : min(maxIdx, UInt8(depth * rampLen))
                halo[i] = UInt8(g * 255)
                flags[i] = depth > 0 && (wet > 0.5 || wetAll) ? Self.wetFlag : 0
                i += 1
            }
        }
        if cursorK > 0.05 {
            // The pen stick: glyphs along the axis from the body's surface to the point,
            // one per cell the line crosses, so the needle always reaches the pen — the
            // thinned tail above renders only where a cell centre falls inside it, and on
            // a diagonal or a half-cell offset that left the last finger's width blank.
            // It fades toward the point and blends in with the form. Same edge fade as the body.
            let reach = bodyBase * (1 + Self.tailStretch * e)
            let from = bodyBase * Self.penStickFrom
            let axisX = -stretchX, axisY = -stretchY
            var s = from
            while s <= reach {
                let col = cx + axisX * s * aspect, row = cy + axisY * s * sq
                let ci = Int(col.rounded()), ri = Int(row.rounded())
                if ci >= 0, ci < cols, ri >= 0, ri < rows {
                    let k = (s - from) / max(0.01, reach - from)
                    var depth = (Self.penDepthBody + (Self.penDepthTip - Self.penDepthBody) * k) * cursorK
                    let edge = min(min(ri, rows - 1 - ri), min(ci, cols - 1 - ci))
                    if edge == 0 { depth *= 0.3 } else if edge == 1 { depth *= 0.65 }
                    let idx = min(maxIdx, UInt8(depth * rampLen))
                    let j = ri * cols + ci
                    if cells[j] < idx { cells[j] = idx }
                    halo[j] = max(halo[j], UInt8(min(1, 0.55 - 0.3 * k) * cursorK * 255))
                }
                s += 0.3
            }
        }
        renderEyes(cx: cx, cy: cy, base: bodyBase, sq: sq, bias: bias)
    }

    /// The pen's stretch axis for a travel along (`dirX`, `dirY`) held on the `hand`
    /// side: against the travel, swung `cursorPenAngle` round. Screen orientation (y
    /// down): for a line drawn to the right, hand +1 puts the body up and to the left of
    /// the point. Shared by the form's easing and `cursorTipTarget`.
    static func penAxis(dirX: Double, dirY: Double, hand: Double) -> (Double, Double) {
        let a = cursorPenAngle * (hand >= 0 ? 1 : -1)
        let c = cos(a), s = sin(a)
        let bx = -dirX, by = -dirY
        return (bx * c - by * s, bx * s + by * c)
    }

    // MARK: eyes

    /// Where the listening eyes look: the hand, when it is within `followReach`;
    /// otherwise "the last sound" — the level has no direction, so an onset picks a
    /// glance that then holds — and slightly up, which reads as friendly, in silence.
    private func listeningLook() -> (Double, Double) {
        if let p = pointer?() {
            let d = (p.dx * p.dx + p.dy * p.dy).squareRoot()
            if d < Self.followReach, d > 1 {
                let k = min(1, d / 120)
                return (p.dx / d * k, p.dy / d * k)
            }
        }
        return input > 0.06 ? (glanceX, glanceY) : (glanceX * 0.3, -0.25)
    }

    /// The eyes: an ASCII glyph pair — Kevin's `^ ^` — big and bold on the upper third
    /// of the body. The expression is the pair of glyphs (the table below, per phase
    /// and gate state), the lids a glyph swap (`-` for a blink, for the wall-side
    /// squint, for a body pressed flat), the look a shift of the pair by up to a cell
    /// and a half toward what they follow (the hand, the work, the travel) and, at
    /// work, `> >` / `< <` toward it. The pair is pulled inward until body lies under
    /// both, so neither the squish nor a lobe running off the field can clip one; the
    /// spot eases so a lobe moving under them shifts them, never jumps them. Blinks
    /// on a 3–6 s clock (one in ten a double), 120 ms of `- -`. Every quantity eased.
    ///
    ///   asleep `- -` (a sleepy `~ ~` at the top of every other breath)  ·  gate listening `. .`
    ///   connecting `o o` glancing  ·  listening `O O`  ·  speaking `^ ^`  ·  thinking `- -` / `~ ~` looking up
    ///   acting `o o`, `> >` / `< <` toward the target  ·  muted `_ _` (small, dim, low, on a whole row)  ·  paused `u u`  ·  error `x x`
    ///   wake heard `O O` then `^ ^`  ·  authenticating `. .`  ·  granted `^ ^`  ·  denied `> <`  ·  locked `- -`
    ///   poked `O o` then a blink  ·  flick `O O`  ·  pressed side `- o`  ·  blink `- -`
    private func renderEyes(cx: Double, cy: Double, base: Double, sq: Double, bias: (bx: Double, by: Double, total: Double)) {
        eyes.removeAll(keepingCapacity: true)
        eyeFootprint.removeAll(keepingCapacity: true)
        let dt = frameDt
        let squishing = min(1, bias.total)
        let gateAge = t - gateChangedAt
        let shown: Phase = flight ? .acting : phase

        // The listening perk-up: an onset in the input level.
        if input - lastInput > 0.09 { perk = min(1, perk + 0.7); glanceX = Double.random(in: -0.7...0.7); glanceY = Double.random(in: -0.5...0.2) }
        lastInput = input
        perk *= exp(-dt / 0.5)

        // Expression: the glyph pair, how open the lids are (under `shutOpenness` the
        // eye is a `-` whatever the pair says), where they look, whether they blink,
        // how much brighter than the body they are, and whether a sideways look turns
        // the pair into `> >` / `< <` (at work: the eyes point at the target).
        var pair = Face("o")
        var open = 1.0
        var wantX = 0.0, wantY = -0.25
        var blinkable = true
        var lift = 0.85
        var aimed = false
        let breath = sin(2 * .pi * t / Self.breathPeriod)
        switch shown {
        case .asleep:
            // Shut, breathing with the body; a sleepy `~ ~` at the top of every other breath.
            let sleepy = breath > 0.92 && Int(t / Self.breathPeriod) % 2 == 1 && !reducedMotion
            pair = Face(sleepy ? "~" : "-")
            open = Self.shutOpenness * 0.8
            blinkable = false
            wantY = 0
        case .connecting:
            pair = Face("o")
            if t >= nextGlanceAt {
                glanceX = Double.random(in: -0.8...0.8)
                glanceY = Double.random(in: -0.7...0.3)
                nextGlanceAt = t + Double.random(in: 0.6...1.4)
            }
            wantX = glanceX; wantY = glanceY
        case .listening:
            pair = Face("O")
            open = 1.0 + 0.25 * perk
            (wantX, wantY) = listeningLook()
        case .speaking:
            // Kevin's favourite: the happy face, whenever Jarhead talks.
            pair = Face("^")
            blinkable = false
        case .thinking:
            // Looking up, lids low; `~ ~` as it churns.
            pair = Face(reducedMotion ? "-" : (Int(t / 1.7) % 3 == 2 ? "~" : "-"))
            open = Self.shutOpenness * 0.8
            wantX = -0.7; wantY = -0.75
            blinkable = false
        case .acting:
            pair = Face("o")
            aimed = true
            if let a = attention, a.dx * a.dx + a.dy * a.dy > 1 {
                wantX = min(1, max(-1, a.dx / 220)); wantY = min(1, max(-1, a.dy / 220))
            } else if speed > 80 {
                wantX = velocity.dx / max(speed, 1); wantY = velocity.dy / max(speed, 1)
            }
        case .muted:
            // Low, dim and small, looking down: `_` is the same bar as `-` in the eye
            // font, only on a lower baseline, so the pair is also kept to whole rows
            // (below) — half a row up would put it level with sleep's dashes.
            pair = Face("_")
            wantY = 0.35
            blinkable = false
            lift = 0.4
        case .paused:
            pair = Face("u")
            wantY = 0
            blinkable = false
            lift = 0.6
        case .error:
            pair = Face("x")
            blinkable = false
        }
        if phase == .asleep, !flight {
            switch gate {
            case .off:
                break
            case .listening:
                // An ear open: small, still eyes, brighter than sleep's dashes.
                pair = Face(".")
                open = 1
                blinkable = false
            case .heard:
                // Wide surprise, then pleased to be called.
                pair = Face(gateAge < 0.4 ? "O" : "^")
                open = 1
                blinkable = false
                wantY = -0.3
            case .authenticating:
                pair = Face(".")
                open = 1
                blinkable = false
                wantX = 0.55; wantY = -0.1
            case .granted:
                pair = Face("^")
                open = 1
                blinkable = false
                wantY = -0.35
            case .denied:
                pair = gateAge < 1.0 ? Face(left: ">", right: "<") : Face("-")
                open = gateAge < 1.0 ? 1 : Self.shutOpenness * 0.8
                blinkable = false
            case .lockedOut:
                pair = Face("-")
                open = Self.shutOpenness * 0.8
                blinkable = false
                wantY = 0.2
            }
        }

        // The pen: intent, looking along the travel — `> >` / `< <` along a line drawn
        // sideways — over the phase's look by how far into the form the body is.
        if cursorK > 0.02 {
            wantX = wantX * (1 - cursorK) + cursorDirX * cursorK
            wantY = wantY * (1 - cursorK) + cursorDirY * cursorK
            if cursorK > 0.5 {
                blinkable = false
                aimed = true
                if pair.left != "x" { pair = Face("o"); open = max(open, 0.8) }
            }
        }

        // Reactions. A tap: `O o`, then the blink the poke scheduled. A flick (a hard
        // drag, a fast throw): `O O`, looking ahead — along the stretch (toward the
        // hand) or the flight. Pressed against a wall the pair looks away from it, by
        // how hard it presses; pressed flat, the lids come down.
        if t - pokedAt < 0.24 { pair = Face(left: "O", right: "o"); open = max(open, 1.15) }
        let flick = dragging ? min(1, max(0, (stretch - 0.3) / 0.35)) : min(1, max(0, (speed - 900) / 900))
        if pair.left != "x" {
            if flick > 0.35 {
                pair = Face("O")
                open = max(open, 1 + 0.22 * flick)
                wantX = wantX * (1 - flick) + stretchX * flick
                wantY = wantY * (1 - flick) + stretchY * flick
            } else if dragging, stretch > 0.05 {
                wantX = wantX * 0.5 + stretchX * 0.5
                wantY = wantY * 0.5 + stretchY * 0.5
            }
        }
        if bias.total > 0.05 {
            let k = min(1, bias.total)
            wantX = wantX * (1 - k) + bias.bx / bias.total * k
            wantY = wantY * (1 - k) + bias.by / bias.total * k
        }
        if squishing > 0.85 { open = min(open, Self.shutOpenness * 0.8) }

        // Blinks: 120 ms of `- -`, one in ten a double.
        if blinkable {
            if t >= nextBlinkAt {
                blinkLength = 0.12
                blinkUntil = t + blinkLength
                nextBlinkAt = t + Double.random(in: 3...6)
                doubleBlinkAt = Double.random(in: 0..<1) < 0.1 ? blinkUntil + 0.1 : -1
            }
            if doubleBlinkAt > 0, t >= doubleBlinkAt { blinkUntil = t + blinkLength; doubleBlinkAt = -1 }
        }
        if t < blinkUntil { open = Self.shutOpenness * 0.6 }

        // Where they look, eased.
        let lk = min(1, dt * 9)
        lookX += (wantX - lookX) * lk
        lookY += (wantY - lookY) * lk
        faceLookX = lookX
        faceLookY = lookY

        // At work the pair turns toward what it follows: a strong sideways look is `> >` / `< <`.
        if aimed, pair.left == "o", abs(lookX) > 0.45, abs(lookX) > abs(lookY) * 1.2 {
            pair = Face(lookX > 0 ? ">" : "<")
        }

        // The pressed side squints: the eye nearer the wall, by how far toward it it
        // sits, in eye-spread units — so at a firm press the wall-side eye is a `-`
        // while the far one stays open. Measured from the pair's nominal spot: the
        // spread is what matters, and the fit below only pulls the eyes inward.
        let e = stretch
        let spread = max(Self.minEyeSpread, base * 0.22 * aspect * (1 - 0.12 * squishing))
        func squint(_ side: Double) -> Double {
            var k = 1.0
            let ex = side * spread / aspect
            let ey = -base * 0.34
            let unit = max(spread / aspect, 0.5)
            for c in self.shown where c.press > 0.05 {   // `shown` here is the phase
                let toward = max(0, -(ex * c.nx + ey * c.ny)) / unit
                k *= 1 - 0.75 * min(1, c.press) * min(1, toward * 1.6)
            }
            return k
        }
        let targetL = open * squint(-1), targetR = open * squint(1)
        let ok = min(1, dt * 26)
        openL += (targetL - openL) * ok
        openR += (targetR - openR) * ok

        // The lids as glyphs: under `shutOpenness` an eye is a `-`, unless the pair
        // is already a low glyph (asleep's `-`, muted's `_`, the sleepy `~`, the gate's `.`).
        func lidded(_ g: Character, _ o: Double) -> Character {
            if o < Self.shutOpenness, !["-", "_", "~", "."].contains(g) { return "-" }
            return g
        }
        let drawn = Face(left: lidded(pair.left, openL), right: lidded(pair.right, openR))
        // Past open the eye grows a little: surprise. Muted's `_ _` is drawn a step smaller.
        let mutedFace = shown == .muted
        let size = Self.eyeSizePt * (1 + 0.25 * max(0, min(openL, openR, 1.3) - 1)) * (mutedFace ? 0.8 : 1)
        face = drawn
        faceSize = size
        eyeLift = lift

        // Placement: the pair on the upper third, close-set (a `^ ^` with about a
        // glyph's width of face between), shifted by the look — a cell and a half
        // sideways at full look, most of a row up or down — and by the lean; stretched,
        // they ride toward the hand, where the body is (the tail behind is too thin to
        // hold them). The pen keeps them by its outline centre instead, a hair back
        // toward the blunt end — its body is short, and the blob's placement put them
        // past the blunt end whenever it pointed up or down.
        let blobCol = cx + lookX * 1.5 + leanX * 0.5 + stretchX * e * 2.2 * aspect
        let blobRow = cy - base * 0.30 * sq + lookY * 0.7 + stretchY * e * 2.2 * sq
        let penCol = cx + lookX * 0.6 + stretchX * base * 0.15 * aspect
        let penRow = cy + lookY * 0.4 + stretchY * base * 0.15 * sq
        let centreCol = blobCol * (1 - cursorK) + penCol * cursorK
        var row = blobRow * (1 - cursorK) + penRow * cursorK
        var leftCol = centreCol - spread, rightCol = centreCol + spread
        var placed = false
        // Half a row up first, then down the face (`eyeRowSearch`), until both eyes
        // sit on body with a clear gap between; failing that, anywhere three cells of
        // body will hold them. The pen's narrow body gets a hair less gap.
        let minGap = cursorK > 0.5 ? 3.2 : 3.6
        // Muted's low bar is kept to whole rows: a half-row up would lift it level with sleep's `-`.
        let rowSearch = mutedFace ? Self.eyeRowSearchWhole : Self.eyeRowSearch
        for pass in 0..<2 {
            for rowTry in rowSearch {
                let r = row + rowTry
                if let l = fittedColumn(leftCol, row: r, toward: cx, strict: pass == 0),
                   let rr = fittedColumn(rightCol, row: r, toward: cx, strict: pass == 0), rr - l >= minGap {
                    leftCol = l; rightCol = rr; row = r
                    placed = true
                    break
                }
            }
            if placed { break }
        }
        if !placed, eyesPlaced, cursorK > 0.5, onBody(eyeLeftCol, row: eyeRow), onBody(eyeRightCol, row: eyeRow) {
            // The pen, mid-stroke: a frame whose fit fails (a corner's wobble pinching
            // the eye row) keeps the eyes where they were, body still under them,
            // rather than blinking the face out for that frame.
            row = eyeRow; leftCol = eyeLeftCol; rightCol = eyeRightCol
            placed = true
        }
        guard placed else {
            eyeFitNote = String(format: "fit failed: want row %.1f cols %.1f/%.1f, centre %.1f,%.1f, cursorK %.2f stretch %.2f,%.2f, spread %.2f, previously placed %d at row %.1f cols %.1f/%.1f (on body %d/%d)",
                                row, leftCol, rightCol, cx, cy, cursorK, stretchX, stretchY, spread, eyesPlaced ? 1 : 0, eyeRow, eyeLeftCol, eyeRightCol,
                                onBody(eyeLeftCol, row: eyeRow) ? 1 : 0, onBody(eyeRightCol, row: eyeRow) ? 1 : 0)
            eyesPlaced = false; return
        }
        // The spot eases (τ ≈ 90 ms) so a lobe or the squish moving under the eyes
        // shifts them rather than jumping them a row; an eased spot that has left the
        // body snaps to the fitted one, which is on body by construction.
        if eyesPlaced {
            let pk = 1 - exp(-dt / Self.eyePlaceTau)
            let er = eyeRow + (row - eyeRow) * pk
            let el = eyeLeftCol + (leftCol - eyeLeftCol) * pk
            let erc = eyeRightCol + (rightCol - eyeRightCol) * pk
            if onBody(el, row: er), onBody(erc, row: er) { row = er; leftCol = el; rightCol = erc }
        }
        eyeRow = row; eyeLeftCol = leftCol; eyeRightCol = rightCol
        eyesPlaced = true
        if phase == .error, !reducedMotion {
            leftCol += gaussianRandom() * 0.18
            rightCol += gaussianRandom() * 0.18
        }

        eyes.append(BlobEye(col: leftCol, row: row, glyph: drawn.left, size: size, open: openL, lookX: lookX, lookY: lookY))
        eyes.append(BlobEye(col: rightCol, row: row, glyph: drawn.right, size: size, open: openR, lookX: lookX, lookY: lookY))

        // The cells under each glyph (its box on the shared baseline, plus the ground
        // outline): the body draws nothing there, so the face sits in a slot instead
        // of on top of the glyph soup — a `-` clears one row, an `O` two.
        let cellW = rowHeightPt / aspect
        let glyphs = BlobGlyphs.shared
        for eye in eyes {
            guard glyphs.eyeGlyph(eye.glyph) != nil else { continue }
            let box = glyphs.eyeBox(eye.glyph, size: eye.size)
            let ccol = eye.col + box.midX / cellW
            let crow = eye.row + box.midY / rowHeightPt
            let halfC = (box.width / 2 + 1.5) / cellW + 0.35
            let halfR = (box.height / 2 + 1.5) / rowHeightPt + 0.35
            let c0 = max(0, Int((ccol - halfC).rounded())), c1 = min(Self.cols - 1, Int((ccol + halfC).rounded()))
            let r0 = max(0, Int((crow - halfR).rounded())), r1 = min(Self.rows - 1, Int((crow + halfR).rounded()))
            guard c0 <= c1, r0 <= r1 else { continue }
            for r in r0...r1 {
                for c in c0...c1 where abs(Double(c) - ccol) < halfC && abs(Double(r) - crow) < halfR {
                    eyeFootprint.append(r * Self.cols + c)
                }
            }
        }
    }

    /// Three cells of body under this spot (the relaxed fit), for an eased eye position.
    private func onBody(_ col: Double, row: Double) -> Bool {
        let r = Int(row.rounded()), ci = Int(col.rounded())
        guard r >= 0, r < Self.rows, ci >= 1, ci < Self.cols - 1 else { return false }
        let base = r * Self.cols
        for d in -1...1 where cells[base + ci + d] == 0 { return false }
        return true
    }

    /// Pull an eye's column toward the body's centre until body lies under it: strictly,
    /// five cells on its row and three on the row below (the disc is nearly three cells
    /// wide and hangs into the face); relaxed, three cells on its row. Nil when there is
    /// no body to put it on.
    private func fittedColumn(_ col: Double, row: Double, toward: Double, strict: Bool) -> Double? {
        let r = Int(row.rounded())
        guard r >= 0, r < Self.rows else { return nil }
        let reach = strict ? 2 : 1
        var c = col
        for _ in 0..<9 {
            let ci = Int(c.rounded())
            if ci >= reach, ci < Self.cols - reach {
                let base = r * Self.cols
                var ok = true
                for d in -reach...reach where cells[base + ci + d] == 0 { ok = false; break }
                if ok, strict, r + 1 < Self.rows {
                    for d in -1...1 where cells[base + Self.cols + ci + d] == 0 { ok = false; break }
                }
                if ok { return c }
            }
            c += (toward - c) * 0.35
            if abs(toward - c) < 0.6 { return nil }
        }
        return nil
    }

    /// How far the eyes are lifted toward white over the body colour this frame: a
    /// step brighter so they read as eyes, except muted, whose eyes stay dim like the rest of it.
    private(set) var eyeLift = 0.85
    /// Seconds since the last field frame, for the eyes' easing.
    private var frameDt = 0.0
    /// Where the pen's point will be, from the body's centre, once the cursor form has
    /// fully eased in for a travel along `dir` (unit, CG) held on the current
    /// `cursorHand` side: `render`'s tip geometry with the form's constants, without
    /// the wobble. For aiming the flight that carries the pen to a stroke's first
    /// point; while drawing, the eased `cursorTip` rules.
    func cursorTipTarget(direction dir: CGVector, squash: Double) -> CGVector {
        let e = reducedMotion ? Self.cursorStretch * 0.4 : Self.cursorStretch
        let (sx, sy) = Self.penAxis(dirX: dir.dx, dirY: dir.dy, hand: cursorHand)
        let base = Double(Self.rows) * 0.38
        let bodyBase = base / (1 + (Self.stretchShrink + 0.4 * sy * sy) * e) * (1 - Self.cursorShrink)
        let toward = bodyBase * (Self.tailStretch + Self.leadCompress) / 2 * e
        let reach = bodyBase * (1 + Self.tailStretch * e)
        return CGVector(dx: (sx * toward - sx * reach) * rowHeightPt, dy: (sy * toward - sy * reach) * squash * rowHeightPt)
    }

    /// The in-flight squash the field draws at, for `cursorTipTarget`.
    var flightSquash: Double { max(phaseTarget.squash, 1.12) }

    /// The sim's clock (seconds since it started), for a face drawn elsewhere (the notch's breath).
    var time: Double { t }
    /// Sound is arriving: the levels the engine last sent are above the floor.
    var rawLevelsActive: Bool { rawInput > 0.02 || rawOutput > 0.02 }
    /// The louder of the eased levels (0…1), for the notch island's widening and pulse.
    var islandLevel: Double { max(input, output) }

    /// How far into the cursor form the body is (0…1), for the preview harness.
    var previewCursorK: Double { cursorK }
    /// The eased elongation, for the preview harness.
    var previewStretch: Double { stretch }
    /// The wobble this frame, for the preview harness: the slosh's displacement (rows) and the ellipse mode (× radius).
    var previewWobble: (slosh: Double, mode2: Double) { ((sloshX.x * sloshX.x + sloshY.x * sloshY.x).squareRoot(), mode2.x) }
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
///
/// The eyes' glyphs are ASCII from the bold face of the field's own mono family
/// (`eyeFont`): `- ~ o O ^ > < _ x . u`, measured with CTFont at launch — every one
/// has the font's single advance (6.18 pt at 10 pt; `eyeAdvancesUniform` says so),
/// so a pair stays centred whatever it swaps to. They are drawn at `BlobSim.eyeSizePt`,
/// so what matters is each glyph's box per unit of font size (`EyeGlyph`) and a shared
/// baseline: the `o`'s box centre (`eyeBaselineCentre`) sits on the eye's row, so `^`
/// rides high and `_` low the way they do in type, and a blink from `^` to `-` drops
/// the way a lid does.
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
    /// A glyph in the eye font with its bounding box per point of font size: the
    /// centre (from the glyph origin, y up), the width and height, and the advance.
    struct EyeGlyph {
        let glyph: CGGlyph
        let centre: CGPoint
        let width: CGFloat
        let height: CGFloat
        let advance: CGFloat
    }

    /// Every glyph an eye can be.
    static let eyeCharacters: [Character] = ["-", "~", "o", "O", "^", ">", "<", "_", "x", ".", "u"]

    nonisolated(unsafe) static let shared = BlobGlyphs()

    private(set) var fonts: [FontEntry] = []
    /// Per ramp, per ramp index; nil for blank.
    private(set) var tables: [[Ref?]] = []
    /// The eyes' face: the field's mono family, bold, at the field's size (drawn scaled).
    let eyeFont: FontEntry
    private var eyeGlyphs: [Character: EyeGlyph] = [:]
    /// The `o`'s box centre height per unit of font size: the shared baseline reference.
    private(set) var eyeBaselineCentre: CGFloat = 0.27
    /// Every eye glyph has the same advance in the eye font (measured at launch).
    private(set) var eyeAdvancesUniform = true
    /// That advance, per unit of font size.
    private(set) var eyeAdvance: CGFloat = 0.62

    private init() {
        let base = BlobMetrics.font as CTFont
        fonts.append(FontEntry(ct: base, cg: CTFontCopyGraphicsFont(base, nil), size: BlobMetrics.fontSize))
        let bold = NSFont.monospacedSystemFont(ofSize: BlobMetrics.fontSize, weight: .bold) as CTFont
        eyeFont = FontEntry(ct: bold, cg: CTFontCopyGraphicsFont(bold, nil), size: BlobMetrics.fontSize)
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
        // The eyes: ASCII only, all from the one bold font, measured.
        var advances: Set<Int> = []
        for ch in Self.eyeCharacters {
            guard let g = eyeGlyph(ch, font: bold) else { continue }
            eyeGlyphs[ch] = g
            advances.insert(Int((g.advance * 1000).rounded()))
        }
        if let o = eyeGlyphs["o"] { eyeBaselineCentre = o.centre.y; eyeAdvance = o.advance }
        eyeAdvancesUniform = advances.count == 1
    }

    /// The glyph an eye is drawn as; nil for a character outside `eyeCharacters`.
    func eyeGlyph(_ ch: Character) -> EyeGlyph? { eyeGlyphs[ch] }

    /// Where an eye glyph's box lies, in points from the eye's point (x right, y down),
    /// at `size`: horizontally centred, vertically on the shared baseline.
    func eyeBox(_ ch: Character, size: Double) -> CGRect {
        guard let g = eyeGlyphs[ch] else { return .zero }
        let s = CGFloat(size)
        let cy = -(g.centre.y - eyeBaselineCentre) * s
        return CGRect(x: -g.width * s / 2, y: cy - g.height * s / 2, width: g.width * s, height: g.height * s)
    }

    /// A glyph from one font only, with its box and advance measured per unit of size.
    private func eyeGlyph(_ ch: Character, font: CTFont) -> EyeGlyph? {
        var utf16 = Array(String(ch).utf16)
        var glyphs = [CGGlyph](repeating: 0, count: utf16.count)
        guard CTFontGetGlyphsForCharacters(font, &utf16, &glyphs, utf16.count), glyphs[0] != 0 else { return nil }
        let box = CTFontGetBoundingRectsForGlyphs(font, .horizontal, glyphs, nil, 1)
        guard box.width > 0, box.height > 0 else { return nil }
        var adv = CGSize.zero
        CTFontGetAdvancesForGlyphs(font, .horizontal, glyphs, &adv, 1)
        let s = CTFontGetSize(font)
        return EyeGlyph(glyph: glyphs[0], centre: CGPoint(x: box.midX / s, y: box.midY / s), width: box.width / s, height: box.height / s, advance: adv.width / s)
    }

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
        sim.rowHeightPt = Double(BlobMetrics.rowHeight)
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

    /// Redraw now from the sim's current frame — glyphs and halo both — for a caller
    /// that stepped the sim itself (the preview harness's expression strip).
    func renderNow() {
        updateHalo()
        needsDisplay = true
        displayIfNeeded()
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
        // view draws only glyphs: body cells from the phase ramp (the wet patch from
        // the dense ramp, a step brighter), nothing under the eyes, then the eyes.
        let cw = BlobMetrics.cellWidth, rh = BlobMetrics.rowHeight
        let shift = BlobMetrics.baselineShift
        let glyphs = BlobGlyphs.shared
        let table = glyphs.table(for: sim.ramp)
        let dense = glyphs.table(for: .dense)
        let fontCount = glyphs.fonts.count
        for c in sim.eyeFootprint where c >= 0 && c < skip.count { skip[c] = true }
        defer { for c in sim.eyeFootprint where c >= 0 && c < skip.count { skip[c] = false } }

        var runs = [[CGGlyph]](repeating: [], count: fontCount)
        var positions = [[CGPoint]](repeating: [], count: fontCount)
        var wetRuns = [[CGGlyph]](repeating: [], count: fontCount)
        var wetPositions = [[CGPoint]](repeating: [], count: fontCount)
        var anyWet = false
        var i = 0
        for row in 0..<BlobSim.rows {
            let baseline = origin.y + (CGFloat(row) + 0.5) * rh + shift
            for col in 0..<BlobSim.cols {
                let cell = i
                let idx = Int(sim.cells[i]); i += 1
                guard idx > 0, !skip[cell] else { continue }
                let wet = sim.flags[cell] & BlobSim.wetFlag != 0
                let ref: BlobGlyphs.Ref?
                if wet {
                    // The same depth on the dense ramp, pushed two steps denser.
                    let d = min(dense.count - 1, Int(Double(idx) / Double(table.count - 1) * Double(dense.count - 1)) + 2)
                    ref = dense[d]
                } else {
                    ref = idx < table.count ? table[idx] : nil
                }
                guard let ref else { continue }
                let x = origin.x + CGFloat(col) * cw + (cw - ref.advance) / 2
                // Text space is flipped below, so y maps to -y.
                let p = CGPoint(x: x, y: -baseline)
                if wet {
                    anyWet = true
                    wetRuns[ref.font].append(ref.glyph)
                    wetPositions[ref.font].append(p)
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
        // the colour; the wet patch a step brighter.
        cg.setFillColor(OrbPalette.ground.cgColor(alpha: 0.85))
        cg.textPosition = CGPoint(x: 0.6, y: 0.7)
        show(runs, positions)
        if anyWet { show(wetRuns, wetPositions) }
        cg.textPosition = .zero
        cg.setFillColor(color.cgColor)
        show(runs, positions)
        if anyWet {
            cg.setFillColor(color.mixed(with: RGB(1, 1, 1), 0.3).cgColor)
            show(wetRuns, wetPositions)
        }

        // The eyes, over everything: the glyph pair, a step brighter than the body.
        if !sim.eyes.isEmpty {
            let ink = color.mixed(with: RGB(1, 1, 1), sim.eyeLift)
            for eye in sim.eyes {
                let p = CGPoint(x: origin.x + (CGFloat(eye.col) + 0.5) * cw, y: origin.y + (CGFloat(eye.row) + 0.5) * rh)
                Self.drawEye(cg, glyph: eye.glyph, size: eye.size, at: p, ink: ink, glyphs: glyphs)
            }
        }
        cg.restoreGState()
    }

    /// Cells the body must not draw this frame (under the eyes); reused across frames.
    private var skip = [Bool](repeating: false, count: BlobSim.cellCount)

    /// One eye: its ASCII glyph from the bold eye font at `size`, on the baseline every
    /// eye glyph shares (the `o`'s centre on the eye's point), first a hair larger in
    /// the ground colour so it reads on the body's glyphs and on any desktop, then in
    /// the eye colour. `p` is the eye's point in a y-down context whose text matrix is
    /// flipped (`draw`); the notch's face draws with it too.
    static func drawEye(_ cg: CGContext, glyph ch: Character, size: Double, at p: CGPoint, ink: RGB, glyphs: BlobGlyphs) {
        guard let g = glyphs.eyeGlyph(ch) else { return }
        cg.setFont(glyphs.eyeFont.cg)
        cg.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
        let s = CGFloat(size)
        // The glyph's box centre: horizontally on the point, vertically on the shared baseline.
        let c = CGPoint(x: p.x, y: p.y - (g.centre.y - glyphs.eyeBaselineCentre) * s)
        func show(_ fs: CGFloat, _ color: CGColor) {
            cg.setFontSize(fs)
            cg.setFillColor(color)
            // Text space is flipped: the wanted user-space centre is mapped back through it.
            cg.showGlyphs([g.glyph], at: [CGPoint(x: c.x - g.centre.x * fs, y: -c.y - g.centre.y * fs)])
        }
        show(s * 1.12 + 1.6, OrbPalette.ground.cgColor)
        show(s, ink.cgColor)
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
