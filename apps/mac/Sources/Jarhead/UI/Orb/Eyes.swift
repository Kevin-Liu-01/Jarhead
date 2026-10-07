import CoreGraphics
import QuartzCore

// The face, dithered: the site's eyes (site/lib/eyes.ts) in Swift, cell for cell, so the
// app's face and the site's are one face. Ink ovals that catch the light as a four-point
// star and a small dot, and a small vocabulary of lines for the faces that close them, every
// shape rasterised in the cells of the world it sits on (`Dither.cellPoints`, 1.5 pt: the
// notch island's ink, the blob's halo) with the 8×8 Bayer tile deciding each edge cell and
// the light round the star. So the eyes are part of the same dithered picture as the island,
// never smooth shapes laid over it. One geometry in R units (the body's radius) for the blob
// (`BlobFieldView`, sized to its body as lib/blob.ts sizes it) and the notch island
// (`NotchView`, R 52 at (57, 40) open, as the site's island places it:
// components/desk/Island.tsx).
//
//  * The glyph pair still names the expression (`BlobSim.face`, one glyph per eye): `O`
//    open, `o` small open, `-` closed (a soft sag), `^` happy (an arc), `u` content (a
//    cup), `_` flat, `x` error, `>` `<` squeezed shut (each points at the middle), `~` a
//    thin sleepy ripple. Asleep the eyes are shut lids whatever the wake gate does, on the
//    blob, the island, the peek and the lip alike: `- -`, `~ ~` at the top of a breath.
//    Cute is low, close and round: the eyes sit just above the body's middle, a little over
//    half a radius apart, taller than wide. Small faces (R under 34) draw their eyes a
//    little larger and their lines never under 1.75 pt.
//  * The tones (`Tone`), one a cell: the ink; the paper of the catchlights; the glow, the
//    star's light dithered into the pupil round it; on a dark ground the rim, the
//    phase-tinted paper, which on the notch's island and peek ramps through the tile to a
//    foot of the phase's own tone (`FaceStyle.ramp`).
//  * The lids (`FacePose.open`, per eye): a blink squashes the oval, widens it a little
//    and drops its top; under 0.22 the eye is the closed lid (in ink within its rim, so a
//    blink never flashes); reopening past 1 it stretches a touch taller and narrower. The
//    look turns the face: the far eye narrows.
//  * The sparkle (`Twinkle`, `EyeSparkle`): each open eye's catchlights, a star toward
//    the gleam (upper left) and a dot across from it, in paper inside the pupil, breathe
//    in size (the star swells as the dot ebbs); on a pupil nine cells tall or more the
//    star blooms, its glow scattered round it through the tile, never near the pupil's
//    edge. Now and then a star flares: it twists, turns upright and stretches into a long
//    glint whose top arm reaches out past the pupil and bursts there into a four-point star
//    of cells that thins tips first as it falls, while the dot gives way, the other eye a
//    beat behind. The happy arcs wear a sparkle of their own off the right eye's outer top,
//    a small star and a dot that pop in as the face appears and pulse with each flare,
//    bursting the same way.
//  * On the grid (`faceCells`): each eye's centre snaps to a grid corner, the pair
//    together (a whole number of cells apart, the corner and the spread held by a
//    `FaceHold` until the place asked for is most of a cell away), and each eye is
//    dithered in its own space (the tile anchored at that corner and mirrored about it),
//    so an eye that moves moves whole, never crawls and never flickers; the catchlights
//    snap to cell centres, each on its own tile folded about its middle (a dot is a cell
//    or a plus, a star's arms pair up, its spine lit). The ovals' radii and the lines'
//    widths are whole cells and a line's straight run sits on the cells, so the tile
//    decides only the curved edges (a large oval's diagonals on a wider band, so it reads
//    round). Coverage is a cell's area share (4 × 4 samples), its middle 0.4 stretched over
//    the threshold. At rest every catchlight keeps to its pupil's inner cells (its arms a
//    quarter cell shorter at a time; too small even for its middle, a star steps a cell
//    toward the pupil's middle). The ink wears whole rings of rim (`rim` pt in cells, one at
//    least), and a flaring tip that crosses the rim is parted from it by a cell of ink. On
//    a ground that is always dark (the notch; the blob on a dark desktop) the lines are lit:
//    drawn in the rim's paper, only the pupils ink, so the sleeping lids read as two light
//    lids and never as the hollow outlines an inked line leaves there.
//
// Pure geometry plus one draw call: no AppKit, no state but the sparkle's clock, a face's
// held cell and a small cache of eyes drawn lately (a face that only moves is never
// rasterised again). The numbers and the rounding are lib/eyes.ts's (JS rounding: half up),
// so a pose on a grid is the same cells on the site and in the app.

/// What one eye is, from its glyph (lib/eyes.ts `eyeOf`); anything unknown is closed.
enum EyeKind: Equatable {
    case open, small, closed, happy, content, flat, error, inward, wavy

    init(_ glyph: Character) {
        switch glyph {
        case "O": self = .open
        case "o": self = .small
        case "^": self = .happy
        case "u": self = .content
        case "_": self = .flat
        case "x": self = .error
        case ">", "<": self = .inward
        case "~": self = .wavy
        default: self = .closed
        }
    }

    /// An oval that blinks and catches the light.
    var isOpen: Bool { self == .open || self == .small }
}

/// A face's pose (lib/eyes.ts `FacePose`): the lids, how lit it is, the turn, and the
/// sparkle's breath, flares and pop. Absent, the sparkle rests whole (a still).
struct FacePose {
    /// The left lid and the right: 1 open, 0 shut; past 1 the eye stretches as it reopens.
    var open: Double
    var openRight: Double
    /// 0…1: the eyes light up (a touch larger, the star as large as its pupil holds it, the dot starstruck).
    var sparkle: Double
    /// The look's sideways part, −1…1: the face turns, the far eye narrows.
    var turn: Double
    /// The catchlights' breath, 0…1: at 1 the star is largest and the dot smallest.
    var twinkle: Double?
    /// Each eye's flare (left, right): how far through its life, none outside 0…1.
    var flare: (left: Double, right: Double)?
    /// The happy sparkle's size: 1 at rest, past 1 in a pop or a pulse, 0 hides it.
    var spark: Double?
    /// Where the eyes look within themselves, −1…1 each way (`Eyes.gaze`): the catchlights move toward it.
    var gaze: (x: Double, y: Double)?

    init(open: Double = 1, openRight: Double? = nil, sparkle: Double = 0, turn: Double = 0,
         twinkle: Double? = nil, flare: (left: Double, right: Double)? = nil, spark: Double? = nil,
         gaze: (x: Double, y: Double)? = nil) {
        self.open = open
        self.openRight = openRight ?? open
        self.sparkle = sparkle
        self.turn = turn
        self.twinkle = twinkle
        self.flare = flare
        self.spark = spark
        self.gaze = gaze
    }

    static let rest = FacePose()
}

/// How a face is inked, one colour per tone (Island.tsx `FaceTones`): the pupils and inked
/// lines, the catchlights, the rim round the ink (the island's paper with 15 % of the
/// phase), the star's glow on the pupil (the ink lit half way by the phase's tone), and the
/// rim's foot (the phase's tone; the rim's own colour where it does not ramp).
struct FaceInk {
    var ink: CGColor
    var light: CGColor
    var rim: CGColor
    var glow: CGColor
    var foot: CGColor

    init(ink: CGColor, light: CGColor, rim: CGColor, glow: CGColor, foot: CGColor? = nil) {
        self.ink = ink
        self.light = light
        self.rim = rim
        self.glow = glow
        self.foot = foot ?? rim
    }
}

/// The grid a face is drawn on (lib/eyes.ts `FaceGrid`): its cell, and where cell (0, 0)'s
/// top-left corner sits, in the face's own points (y down).
struct FaceGrid: Equatable {
    var cell: Double
    var x: Double
    var y: Double
}

/// A face on the grid (lib/eyes.ts `FaceCells`): the box it covers (its first column and row
/// in grid cells, its size in cells) and one tone per cell, row-major (`Tone`).
struct FaceCells: Equatable {
    var col: Int
    var row: Int
    var w: Int
    var h: Int
    var tone: [UInt8]

    static let empty = FaceCells(col: 0, row: 0, w: 0, h: 0, tone: [])

    /// The tone at grid cell (col, row), or none outside the face.
    func tone(col c: Int, row r: Int) -> UInt8 {
        let i = c - col, j = r - row
        return i < 0 || j < 0 || i >= w || j >= h ? Tone.none : tone[j * w + i]
    }

    /// The same cells moved by whole cells.
    func shifted(cols: Int, rows: Int) -> FaceCells {
        FaceCells(col: col + cols, row: row + rows, w: w, h: h, tone: tone)
    }

    /// The first and last grid rows holding a cell of the eyes' body (the ink, its glow and
    /// its rim; not a catchlight, which may flare out past them), or nil for an empty face.
    var bodyRows: (first: Int, last: Int)? {
        var first: Int?, last = 0
        for j in 0..<h {
            var any = false
            for i in 0..<w {
                let t = tone[j * w + i]
                if t != Tone.none, t != Tone.light { any = true; break }
            }
            if any { if first == nil { first = row + j }; last = row + j }
        }
        return first.map { ($0, last) }
    }
}

/// A cell's tone, in the order a face overlaps itself (lib/eyes.ts `TONE`): none (the ground
/// shows), the rim's foot, the rim, the ink, the star's glow on the pupil, the paper of a catchlight.
enum Tone {
    static let none: UInt8 = 0
    static let foot: UInt8 = 1
    static let rim: UInt8 = 2
    static let ink: UInt8 = 3
    static let glow: UInt8 = 4
    static let light: UInt8 = 5
}

/// How a face is drawn on its ground (lib/eyes.ts `FaceStyle`): `rim` pt of rim round the
/// ink (0: none); `lit`, its lines in the rim's paper (a ground that is always dark);
/// `ramp`, its rim ramping to the foot's tone; `hold`, the cell it keeps while it moves.
struct FaceStyle {
    var rim: Double = 0
    var lit = false
    var ramp = false
    var hold: FaceHold?
}

/// The cell a moving face keeps (lib/eyes.ts `FaceHold`): its pair's corner and spread hop to
/// the nearest only once the place asked for is `Eyes.hold` of a cell away from the one held,
/// so a face hovering on a cell's edge (the body's wobble, the look) never flicks a cell to
/// and fro, and a monotonic move still steps a cell at a time. One per face that moves.
final class FaceHold {
    private var col = Double.nan
    private var row = Double.nan
    private var d = Double.nan

    /// The pair's spread in whole cells for `v` cells asked for.
    func spread(_ v: Double) -> Double {
        if !(abs(v - d) <= Eyes.hold) { d = max(1, Eyes.jround(v)) }
        return d
    }

    /// The corner held for a left eye asked to sit at (u, v) cells.
    func at(_ u: Double, _ v: Double) -> (Double, Double) {
        if !(abs(u - col) <= Eyes.hold) { col = Eyes.jround(u) }
        if !(abs(v - row) <= Eyes.hold) { row = Eyes.jround(v) }
        return (col, row)
    }

    /// Forget the held cell (a new grid): the next place is taken as it is.
    func reset() {
        col = .nan
        row = .nan
        d = .nan
    }
}

/// The geometry, in R units unless named otherwise (lib/eyes.ts `EYES`, one for one).
enum Eyes {
    /// The eyes' centre line from the body's middle (negative is up), scaled by the squash.
    static let row = -0.06
    static let spread = 0.31
    /// How far the face travels with the look (sideways, up and down).
    static let look = (x: 0.19, y: 0.13)
    static let openEye = (rx: 0.146, ry: 0.188)
    static let smallEye = (rx: 0.104, ry: 0.132)
    /// The catchlights: the star's centre as fractions of the pupil's radii, its arms in R
    /// units, its sides four quadratics whose control sits `full` of an arm out from the
    /// middle (a round bright middle); the dot low across from it.
    static let star = (x: -0.25, y: -0.32, ax: 0.088, ay: 0.118, full: 0.18)
    static let dot = (x: 0.4, y: 0.44, r: 0.034)
    /// Starstruck (lit): the dot becomes a small star, its arms these times its radius.
    static let struck = (ax: 1.1, ay: 1.55)
    /// A flare at its peak: the star's arms reach this much further, its sides pulled in
    /// to `sharp`, twisting out by `spin` rad and back, upright at its peak. On a pupil under
    /// `bloom.cells` tall a glint would split the pupil: there a flare only swells the resting
    /// star by `swell`, kept inside the pupil (a twinkle, never a glint).
    static let flare = (ax: 0.1, ay: 0.8, sharp: 0.12, spin: 0.45, swell: 0.35)
    /// Where the eyes look within themselves (`FacePose.gaze`): the catchlights move this much
    /// of the pupil's radii toward it, kept inside the pupil (the lip's face glances to Touch ID).
    static let gaze = 0.45
    /// How far a catchlight's tips may reach toward the pupil's edge: only a flare goes past it.
    static let fit = 0.96
    /// The happy arcs' own sparkle, from the right eye's centre: a small star (`a` its arms
    /// up and down, three quarters of that across) and a dot up and in from it.
    static let glee = (x: 0.24, y: -0.18, a: 0.108, dotX: 0.1, dotY: -0.32, dotR: 0.032)
    /// The lines' half width and weight; the happy arc a little bolder.
    static let half = 0.12
    static let stroke = 0.088
    static let joy = 1.12
    /// The happy arc and the content cup: a circle's radius, how far its centre sits below
    /// (happy) or above (content), and the sweep either side of straight up or down (× π).
    static let arc = (r: 0.128, drop: 0.07, sweep: 0.4)
    static let cup = (r: 0.112, lift: 0.07, sweep: 0.46)
    /// The closed lid: its ends a touch above the eye's line, its middle sagging below it; a
    /// lid under `small` cells across is laid level on the cells, its middle a row lower.
    static let lid = (ends: -0.008, sag: 0.035, small: 10.0)
    /// The sleepy `~`: one ripple `span` times the lid's half width either side, `amp` deep
    /// (half a cell at least), its line `weight` of the lid's: a dream, never a lumpy cloud.
    static let dream = (amp: 0.03, span: 1.2, weight: 0.4)
    /// Reopening past round stretches the oval this much taller per unit of overshoot, at most `max`.
    static let stretch = (k: 0.8, max: 0.1)
    /// The star outline's control that draws a circle to within a few percent: the dot before it is starstruck.
    static let roundControl = 0.914
    /// The light in cells (lib/eyes.ts `GLOW`): the bloom on a pupil `cells` tall, its glow a
    /// scatter `amp` of the cells within `from` of the star's arms falling to none at `reach`,
    /// `lit` brighter lit and `flare` more at a flare's peak, never within `inset` cells of the
    /// pupil's edge; the burst at a flare's tip, `arm` R·k up and down at its peak and `across`
    /// of that sideways (the happy sparkle's `glee` times its arms), none under `cells` cells.
    static let bloom = (cells: 9.0, inset: 1.5, from: 0.6, reach: 1.8, amp: 0.8, lit: 0.3, flare: 0.6)
    static let burst = (arm: 0.2, across: 0.8, glee: 1.3, cells: 2.5)
    /// The raster (lib/eyes.ts `DITHER`): the samples a side of an edge cell; the middle of
    /// its coverage stretched over the threshold (`edge`; `corner` on a large oval's diagonal
    /// edges, `diag` of the normal off the axes, an oval `round` cells across: a smaller one
    /// on the wide band came out a battery, its top corners gone and its sides square); a star's spine
    /// lit from `cross` cells (upright within `upright` rad) to `spine` of a cell short of its
    /// tips; a round dot under `dot` cells lights no corner cell; a diagonal drawn `lean` of a
    /// cell under its whole width; a light's arms held to 1/`quant` of a cell; the fit's step.
    static let dither = (samples: 4, edge: 0.4, corner: 0.8, diag: 0.38, round: 9.0, cross: 2.0, upright: 0.2,
                         dot: 1.6, lean: 0.3, quant: 8.0, fit: 0.25, spine: 0.75)
    /// The rim's ramp (lib/eyes.ts `RAMP`): paper under `from`, the foot past `to`, tilted `tilt`
    /// away from the light; a lit line ramps over its own rows from `lineFrom` to `lineTo` (its
    /// top row paper, its lowest the foot; the `~` stays plain).
    static let ramp = (from: 0.16, to: 0.68, tilt: 0.12, lineFrom: 0.35, lineTo: 0.85)
    /// How far (in cells) a face's place may stray from the cell it holds before it hops.
    static let hold = 0.75
    /// The smallest catchlight drawn, in cells at its resting size.
    static let minCell = 0.3

    /// The island's face (Island.tsx): R 52, its rim 1.9 island points, scaled with R for any other face.
    static let islandR = 52.0
    static let islandRim = 1.9

    /// A small face's eyes grow, up to 40 % at R 16, full size from R 34.
    static func scale(_ R: Double) -> Double {
        let u = (34 - R) / 18
        return 1 + 0.4 * min(1, max(0, u))
    }

    /// The line weight in pt: proportional, never under 1.75.
    static func strokeWidth(_ R: Double) -> Double { max(1.75, stroke * R * scale(R)) }

    /// The rim round every ink shape: the island's 1.9 at R 52, scaled, never under 1 pt
    /// (on the grid: that many whole cells, one at least).
    static func rimWidth(_ R: Double) -> Double { max(1, islandRim * R / islandR) }

    /// A flare's reach over its life `u` (0…1): up fast (out-cubic) to its peak, then down (in-quad); 0 outside.
    static func flareSize(_ u: Double) -> Double {
        guard u > 0, u < 1 else { return 0 }
        if u < Twinkle.peak {
            let v = 1 - u / Twinkle.peak
            return 1 - v * v * v
        }
        let v = (u - Twinkle.peak) / (1 - Twinkle.peak)
        return 1 - v * v
    }

    /// A flare's twist (rad): out and back on the way up, upright at its peak; none on the way down.
    static func flareTwist(_ u: Double) -> Double {
        u > 0 && u < Twinkle.peak ? flare.spin * sin(.pi * flareSize(u)) : 0
    }

    /// The happy sparkle's pop over `u` (0…1): from nothing past its size by a fifth (out-back), settling at 1.
    static func popSize(_ u: Double) -> Double {
        if u <= 0 { return 0 }
        if u >= 1 { return 1 }
        let c = 2.4, v = u - 1
        return 1 + (c + 1) * v * v * v + c * v * v
    }

    /// Half the distance between the eyes' centres for a face of radius R turned by `turn`.
    static func halfSpread(R: Double, turn: Double) -> Double { spread * R * (1 - 0.08 * abs(turn)) }

    // MARK: the shapes of one eye, in its own points (its centre at 0, 0, y down)

    /// An ink shape: a filled oval, or a stroked polyline (round caps and joins) of width `w`;
    /// `keep` keeps a line in ink even lit (a blink's shut lid); `plain`, a lit line never ramped (the `~`).
    fileprivate enum Ink {
        case oval(rx: Double, ry: Double, y: Double)
        case line(pts: [Double], w: Double, keep: Bool, plain: Bool)
    }

    /// A light as asked for (lib/eyes.ts `Light`): its centre on a cell centre, its arms at
    /// rest, how much of them shows now (`k`) and a flare's stretch of them, its sides'
    /// control now and at rest, its turn; a round `dot`; `fit`, kept to its pupil; the bloom's
    /// strength round it; a burst of `burst` pt at its top tip (`tip`) or its middle, `bf` through its life.
    fileprivate struct Light {
        var x: Double
        var y: Double
        var ax: Double
        var ay: Double
        var k: Double
        var sx: Double
        var sy: Double
        var full: Double
        var full0: Double
        var rot: Double
        var dot: Bool
        var fit: Bool
        var bloom: Double
        var burst: Double
        var bf: Double
        var tip: Bool
    }

    /// JS `Math.round`: half up (toward +∞), so the app rounds as the site does.
    @inline(__always) static func jround(_ v: Double) -> Double { (v + 0.5).rounded(.down) }

    /// A whole number of cells near `v` pt (at least `least`), in pt.
    fileprivate static func cells(_ v: Double, _ c: Double, least: Double = 1) -> Double { max(least, jround(v / c)) * c }

    /// A cell centre near `v` (pt), the eye's centre being a grid corner.
    fileprivate static func snapMid(_ v: Double, _ c: Double) -> Double { ((v / c).rounded(.down) + 0.5) * c }

    /// `v` held to 1/`n` of its unit `u`.
    fileprivate static func step(_ v: Double, _ u: Double, _ n: Double) -> Double { jround(v / u * n) / n * u }

    /// The most cells wide a diagonal reaching `n` cells each way may be drawn.
    fileprivate static func diagonal(_ n: Double) -> Double { max(1, ((2 * n + 1) / 3).rounded(.down)) }

    /// The largest arms (across, up and down) a star centred at (X, Y) — fractions of a
    /// pupil's radii rx, ry — has inside the pupil.
    fileprivate static func fitArms(_ rx: Double, _ ry: Double, _ X: Double, _ Y: Double) -> (Double, Double) {
        let m = fit * fit
        return (rx * ((max(0, m - Y * Y)).squareRoot() - abs(X)), ry * ((max(0, m - X * X)).squareRoot() - abs(Y)))
    }

    fileprivate static func quad(_ x0: Double, _ y0: Double, _ qx: Double, _ qy: Double, _ x1: Double, _ y1: Double, n: Int = 12) -> [Double] {
        var pts: [Double] = []
        pts.reserveCapacity(2 * n + 2)
        for i in 0...n {
            let t = Double(i) / Double(n), u = 1 - t
            pts.append(u * u * x0 + 2 * u * t * qx + t * t * x1)
            pts.append(u * u * y0 + 2 * u * t * qy + t * t * y1)
        }
        return pts
    }

    /// An arc of an ellipse (clockwise on screen, y down, from a0 to a1) as a polyline.
    fileprivate static func arcPts(_ x: Double, _ y: Double, _ rx: Double, _ ry: Double, _ a0: Double, _ a1: Double, n: Int = 16) -> [Double] {
        var pts: [Double] = []
        pts.reserveCapacity(2 * n + 2)
        for i in 0...n {
            let a = a0 + (a1 - a0) * Double(i) / Double(n)
            pts.append(x + rx * cos(a))
            pts.append(y + ry * sin(a))
        }
        return pts
    }

    /// A stroked line as the grid draws it: its width a whole number of cells, the line
    /// moved (by under a cell) so its point (rx, ry) sits on a cell centre when that number
    /// is odd, on a cell edge when even — a straight run through it has crisp edges.
    fileprivate static func strokeLine(_ pts: [Double], _ w: Double, _ c: Double, ry: Double, rx: Double? = nil, keep: Bool = false) -> Ink {
        let n = max(1, jround(w / c))
        let odd = Int(n) % 2 == 1
        func at(_ v: Double) -> Double { (odd ? ((v / c).rounded(.down) + 0.5) * c : jround(v / c) * c) - v }
        let dy = at(ry)
        let dx = rx.map(at) ?? 0
        var out = pts
        for i in out.indices { out[i] += i % 2 == 1 ? dy : dx }
        return .line(pts: out, w: n * c, keep: keep, plain: false)
    }

    /// The closed lid, `w` either side of the eye's middle: a soft sag in whole cells, one at
    /// least once the lid spans three, so a sleeping face is curved at every size. Under
    /// `lid.small` cells across the curve's raised ends would read as the content cup's walls:
    /// a small lid is laid on the cells, its line level across its span (a row less than the
    /// line is wide, one at least) over a row inset a cell each side (`######` over `.####.`).
    /// `keep`: a blink's.
    fileprivate static func lidMark(_ w: Double, _ Rk: Double, _ lw: Double, _ c: Double, keep: Bool = false) -> [Ink] {
        let mid = (lid.ends + lid.sag) / 2 * Rk
        let n = max(1, jround(lw / c))
        // its half span in cells: the line's ends and caps, as the curve would reach
        let m = max(2, jround((w + n * c / 2) / c))
        if 2 * m >= lid.small {
            let dip = cells((lid.sag - lid.ends) / 2 * Rk, c, least: 2 * w >= 3 * c ? 1 : 0)
            return [strokeLine(quad(-w, mid - dip, 0, mid + dip, w, mid - dip), lw, c, ry: mid, keep: keep)]
        }
        // the rows, centred on the lid's line: the level run (its ends' cells centred on the span's end cells), then the sag
        let rows = max(2, n)
        let r0 = jround(mid / c - rows / 2)
        let top = rows - 1
        let yb = (r0 + top / 2) * c
        let ys = (r0 + top + 0.5) * c
        let xe = (m - 0.5) * c
        return [.line(pts: [-xe, yb, xe, yb], w: top * c, keep: keep, plain: false),
                .line(pts: [-(xe - c), ys, xe - c, ys], w: c, keep: keep, plain: false)]
    }

    /// One eye's shapes (its centre at 0, 0): the glyph on side `side` (−1 the left eye) of a
    /// body of radius R, posed, on a grid of cell `c`.
    fileprivate static func eyeShapes(_ kind: EyeKind, side: Double, R: Double, pose: FacePose, c: Double, ink: inout [Ink], light: inout [Light]) {
        let k = scale(R)
        let Rk = R * k
        let lw = strokeWidth(R)
        let far = max(0, -side * pose.turn)
        let narrow = 1 - 0.14 * far
        let lidOpen = side < 0 ? pose.open : pose.openRight
        if kind.isOpen {
            let o = min(1, max(0, lidOpen))
            let shape = kind == .open ? openEye : smallEye
            let grow = 1 + 0.08 * pose.sparkle
            let rx = shape.rx * Rk * narrow * grow
            let ry = shape.ry * Rk * grow
            if o < 0.22 {
                // shut: the closed lid, as wide as the open eye, in ink within its rim
                ink.append(contentsOf: lidMark(rx * 1.05, Rk, lw, c, keep: true))
                return
            }
            // the blink: the oval squashes, widens a little and its top comes down; reopening it
            // overshoots a touch taller and narrower; radii and drop in whole cells
            let over = lidOpen > 1 ? min(stretch.max, (lidOpen - 1) * stretch.k) : 0
            let rxo = cells(rx * (1 + 0.18 * (1 - o)) * (1 - 0.4 * over), c)
            // open, it stays taller than wide however the radii round
            let ryo = max(cells(ry * o * (1 + over), c), o > 0.9 ? rxo + c : c)
            let yo = cells((ry - ryo) * 0.35, c, least: 0)
            ink.append(.oval(rx: rxo, ry: ryo, y: yo))
            // the catchlights come back as the lids open
            if o > 0.5 {
                catchlights(rxo, ryo, yo, s: Rk * (kind == .small ? 0.8 : 1), a: (o - 0.5) * 2, narrow: narrow, pose: pose, side: side, c: c, light: &light)
            }
            return
        }
        let w = half * Rk * narrow
        switch kind {
        case .closed, .open, .small:
            ink.append(contentsOf: lidMark(w, Rk, lw, c))
        case .happy:
            let r = arc.r * Rk
            let cy = arc.drop * Rk
            ink.append(strokeLine(arcPts(0, cy, r * narrow, r, .pi * (1.5 - arc.sweep), .pi * (1.5 + arc.sweep)), lw * joy, c, ry: cy - r))
            if side > 0 { gleeSparkle(Rk, narrow: narrow, pose: pose, c: c, light: &light) }
        case .content:
            let r = cup.r * Rk
            let cy = -cup.lift * Rk
            ink.append(strokeLine(arcPts(0, cy, r * narrow, r, .pi * (0.5 - cup.sweep), .pi * (0.5 + cup.sweep)), lw, c, ry: cy + r))
        case .flat:
            ink.append(strokeLine([-w * 0.9, 0.06 * Rk, w * 0.9, 0.06 * Rk], lw, c, ry: 0.06 * Rk))
        case .error:
            // two true diagonals crossing at the eye's centre, never so thick the cross fills in
            let n = max(1, jround(0.066 * Rk / c))
            let W = min(max(1, jround(lw / c)), diagonal(n))
            let d = (n + Double(Int(W) % 2) / 2) * c
            ink.append(.line(pts: [-d, -d, d, d], w: (W - dither.lean) * c, keep: false, plain: false))
            ink.append(.line(pts: [d, -d, -d, d], w: (W - dither.lean) * c, keep: false, plain: false))
        case .inward:
            // `>` on the left eye, `<` on the right: a true 45° chevron, its point on a cell
            let dir = -side
            let n = max(1, jround(0.074 * Rk / c))
            let W = min(max(1, jround(lw / c)), diagonal(n))
            let o = Double(Int(W) % 2) / 2
            let px = (jround(n / 2) + o) * dir * c
            let py = o * c
            ink.append(.line(pts: [px - dir * n * c, py - n * c, px, py, px - dir * n * c, py + n * c], w: (W - dither.lean) * c, keep: false, plain: false))
        case .wavy:
            // the sleepy ripple: one wave a little wider than the lid, thin, swinging half a cell at
            // least each way so it steps a row up and a row down, its crest on a cell; under
            // `lid.small` cells across (a sampled wave there is a step with a stray cell) a pixel
            // tilde on the lid's two rows, the same turned about its middle (`.##..#` over `#..##.`)
            let span = dream.span * w
            let m = max(2, jround((span + c / 2) / c))
            if 2 * m < lid.small {
                let r0 = jround((lid.ends + lid.sag) / 2 * Rk / c - 1)
                let yt = (r0 + 0.5) * c, yb = (r0 + 1.5) * c
                func at(_ i: Double) -> Double { (i - m + 0.5) * c }
                func run(_ a: Double, _ b: Double, _ y: Double) -> Ink { .line(pts: [at(a), y, at(b), y], w: c, keep: false, plain: true) }
                ink.append(contentsOf: [run(0, 0, yb), run(1, m - 1, yt), run(m, 2 * m - 2, yb), run(2 * m - 1, 2 * m - 1, yt)])
                return
            }
            let amp = max(dream.amp * Rk, 0.5 * c)
            var pts: [Double] = []
            pts.reserveCapacity(34)
            for i in 0...16 {
                pts.append(-span + 2 * span * Double(i) / 16)
                pts.append(amp * sin(Double(i) / 16 * 2 * .pi))
            }
            if case let .line(p, lw2, keep, _) = strokeLine(pts, lw * dream.weight, c, ry: -amp) {
                ink.append(.line(pts: p, w: lw2, keep: keep, plain: true))
            }
        }
    }

    /// An open eye's catchlights on its pupil (radii rx, ry, centred `y` below the eye's
    /// centre): `s` their scale (R·k), `a` how far the lids have let them back (0…1). A pupil
    /// under two cells across and four tall keeps no light, one under six across only its star.
    fileprivate static func catchlights(_ rx: Double, _ ry: Double, _ y: Double, s: Double, a: Double, narrow: Double,
                                        pose: FacePose, side: Double, c: Double, light: inout [Light]) {
        let lit = pose.sparkle
        let swell = pose.twinkle.map { 0.9 + 0.1 * $0 } ?? 1
        let ebb = pose.twinkle.map { 0.9 + 0.1 * (1 - $0) } ?? 1
        let u = pose.flare.map { side < 0 ? $0.left : $0.right } ?? 0
        let f = flareSize(u)
        let across = jround(rx / c), tall = jround(ry / c)
        // a pupil tall enough to bloom glints (stretched, twisted, bursting); a smaller one twinkles, its star swelling inside it
        let glints = 2 * ry >= bloom.cells * c
        let g = glints ? f : 0
        // the gaze: the catchlights' centres toward where the eyes look, in fractions of the pupil's radii
        let gx = pose.gaze.map { gaze * $0.x } ?? 0
        let gy = pose.gaze.map { gaze * $0.y } ?? 0
        let ax0 = star.ax * s * narrow
        if ax0 >= minCell * c, across >= 1, tall >= 2 {
            let (mx, my) = fitArms(rx, ry, star.x + gx, star.y + gy)
            let glow = glints ? a * (bloom.amp * (1 + bloom.lit * lit) + bloom.flare * f) : 0
            light.append(Light(x: snapMid(rx * (star.x + gx), c), y: snapMid(y + ry * (star.y + gy), c),
                               ax: min(ax0 * (1 + 0.24 * lit), mx), ay: min(star.ay * s * (1 + 0.15 * lit), my),
                               k: swell * a * (glints ? 1 : 1 + flare.swell * f), sx: 1 + flare.ax * g, sy: 1 + flare.ay * g,
                               full: star.full + (flare.sharp - star.full) * g, full0: star.full, rot: glints ? -side * flareTwist(u) : 0,
                               dot: false, fit: true, bloom: glow, burst: burst.arm * s * g, bf: g, tip: true))
        }
        // the dot, starstruck while lit; it gives way to a flare (on a small pupil it goes out for the flare's top)
        let r0 = dot.r * s * (1 + 0.4 * lit)
        if r0 >= minCell * c, across >= 3, glints || f < 0.5 {
            let round = lit < 0.02
            let (mx, my) = fitArms(rx, ry, dot.x + gx, dot.y + gy)
            let full = roundControl + (star.full - roundControl) * lit
            light.append(Light(x: snapMid(rx * (dot.x + gx), c), y: snapMid(y + ry * (dot.y + gy), c),
                               ax: round ? r0 : min(r0 * (1 + (struck.ax - 1) * lit), mx),
                               ay: round ? r0 : min(r0 * (1 + (struck.ay - 1) * lit), my),
                               k: ebb * a * (1 - 0.5 * f), sx: 1, sy: 1, full: full, full0: full, rot: 0,
                               dot: round, fit: true, bloom: 0, burst: 0, bf: 0, tip: false))
        }
    }

    /// The happy arcs' sparkle beside the right eye (`Rk` its scale): a small star and a dot
    /// up and in from it, breathing with the catchlights, popping in and pulsing with each
    /// flare, the star bursting as it overshoots.
    fileprivate static func gleeSparkle(_ Rk: Double, narrow: Double, pose: FacePose, c: Double, light: inout [Light]) {
        let swell = pose.twinkle.map { 0.9 + 0.1 * $0 } ?? 1
        let ebb = pose.twinkle.map { 0.9 + 0.1 * (1 - $0) } ?? 1
        let pop = pose.spark ?? 1
        guard pop > 0.02 else { return }
        let a = glee.a * Rk * (1 + 0.25 * pose.sparkle)
        let f = min(1, max(0, (pop - 1) * 2.5))
        if a * 0.75 >= minCell * c {
            light.append(Light(x: snapMid(glee.x * Rk * narrow, c), y: snapMid(glee.y * Rk, c), ax: a * 0.75, ay: a, k: swell * pop,
                               sx: 1, sy: 1, full: star.full, full0: star.full, rot: 0, dot: false, fit: false, bloom: 0,
                               burst: burst.glee * glee.a * Rk * f, bf: f, tip: false))
        }
        let r = glee.dotR * Rk
        if r >= minCell * c {
            light.append(Light(x: snapMid(glee.dotX * Rk * narrow, c), y: snapMid(glee.dotY * Rk, c), ax: r, ay: r, k: ebb * pop,
                               sx: 1, sy: 1, full: roundControl, full0: roundControl, rot: 0, dot: true, fit: false, bloom: 0,
                               burst: 0, bf: 0, tip: false))
        }
    }

    // MARK: distances (pt, negative inside)

    fileprivate static func sdOval(_ px: Double, _ py: Double, _ rx: Double, _ ry: Double) -> Double {
        let u = px / rx, v = py / ry
        let k = (u * u + v * v).squareRoot()
        if k < 1e-6 { return -min(rx, ry) }
        let gu = px / (rx * rx), gv = py / (ry * ry)
        let g = (gu * gu + gv * gv).squareRoot() / k
        return (k - 1) / g
    }

    /// The squared distance from (px, py) to a polyline: roots only where a distance is needed.
    fileprivate static func d2Polyline(_ px: Double, _ py: Double, _ v: [Double]) -> Double {
        if v.count < 4 {
            let dx = px - (v.first ?? 0), dy = py - (v.count > 1 ? v[1] : 0)
            return dx * dx + dy * dy
        }
        var d = Double.infinity
        v.withUnsafeBufferPointer { p in
            var i = 0
            while i + 3 < p.count {
                let ax = p[i], ay = p[i + 1]
                let ex = p[i + 2] - ax, ey = p[i + 3] - ay
                let wx = px - ax, wy = py - ay
                let l2 = ex * ex + ey * ey
                let h = l2 > 0 ? max(0, min(1, (wx * ex + wy * ey) / l2)) : 0
                let dx = wx - ex * h, dy = wy - ey * h
                d = min(d, dx * dx + dy * dy)
                i += 2
            }
        }
        return d
    }

    // MARK: the raster

    /// One eye on the grid, in its own cells (its centre the corner between cells −1 and 0): its box and tones.
    fileprivate struct EyeRaster {
        var i0: Int
        var j0: Int
        var w: Int
        var h: Int
        var tone: [UInt8]
        static let none = EyeRaster(i0: 0, j0: 0, w: 0, h: 0, tone: [])
    }

    /// An eye's ink rasterised in its own box (lib/eyes.ts `InkRaster`): its shapes and rim, a cell of margin each way.
    fileprivate struct InkRaster {
        var i0: Int
        var j0: Int
        var w: Int
        var h: Int
        var tone: [UInt8]
        var inside: [UInt8]
        var onOval: [UInt8]
        var lines: [UInt8]
        static let none = InkRaster(i0: 0, j0: 0, w: 0, h: 0, tone: [], inside: [], onOval: [], lines: [])
    }

    fileprivate typealias Oval = (rx: Double, ry: Double, y: Double)
    fileprivate typealias Stroke = (pts: [Double], w: Double, keep: Bool, box: (Double, Double, Double, Double))

    /// The tile's thresholds as doubles (`Dither.bayer8`, (rank + 0.5) / 64).
    fileprivate static let bayer: [Double] = Dither.bayer8.map(Double.init)

    /// A cell index folded about the eye's centre (the corner between cells −1 and 0).
    @inline(__always) fileprivate static func mirrored(_ v: Int) -> Int { v < 0 ? -1 - v : v }

    /// The eye's tile at its cell (I, J): anchored at its centre and mirrored about it.
    @inline(__always) fileprivate static func tile(_ I: Int, _ J: Int) -> Double {
        let row = mirrored(J) & 7, col = mirrored(I) & 7
        return bayer[row * 8 + col]
    }

    /// The chords a star's side is drawn with (lib/eyes.ts `STAR_STEPS`).
    fileprivate static let starSteps = 4

    /// How much of the cell centred at (X, Y) (side `c`) lies inside a shape, `d` its signed
    /// distance at the centre and `inside` its test at a point: its area share (samples²
    /// points), its middle `band` stretched to the whole range.
    @inline(__always)
    fileprivate static func cover(_ d: Double, _ X: Double, _ Y: Double, _ c: Double, band: Double, _ inside: (Double, Double) -> Bool) -> Double {
        if d >= 0.71 * c { return 0 }
        if d <= -0.71 * c { return 1 }
        let n = dither.samples
        var hit = 0
        for b in 0..<n {
            let y = Y + ((Double(b) + 0.5) / Double(n) - 0.5) * c
            for a in 0..<n where inside(X + ((Double(a) + 0.5) / Double(n) - 0.5) * c, y) { hit += 1 }
        }
        return min(1, max(0, (Double(hit) / Double(n * n) - 0.5) / band + 0.5))
    }

    /// A four-point star's outline in its own frame, folded into one quadrant (lib/eyes.ts
    /// `starProfile`): its vertices from (0, ay) to (ax, 0), x rising.
    fileprivate static func starProfile(_ ax: Double, _ ay: Double, full: Double) -> [Double] {
        var prof = [Double](repeating: 0, count: 2 * starSteps + 2)
        for i in 0...starSteps {
            let t = Double(i) / Double(starSteps), u = 1 - t
            prof[2 * i] = ax * (2 * u * t * full + t * t)
            prof[2 * i + 1] = ay * (u * u + 2 * u * t * full)
        }
        return prof
    }

    /// Whether (p, q) (|u|, |v| in the star's frame) is inside the star whose folded outline is `prof`.
    @inline(__always)
    fileprivate static func inStar(_ p: Double, _ q: Double, _ prof: UnsafeBufferPointer<Double>) -> Bool {
        if !(p < prof[2 * starSteps]) { return false }
        for i in 0..<starSteps {
            let x1 = prof[2 * i + 2]
            if p < x1 {
                let x0 = prof[2 * i], y0 = prof[2 * i + 1], y1 = prof[2 * i + 3]
                return q < y0 + (y1 - y0) * (p - x0) / (x1 - x0)
            }
        }
        return false
    }

    /// The star's signed distance at (p, q) (|u|, |v| in its frame): to the nearest chord of its folded outline.
    fileprivate static func sdStar(_ p: Double, _ q: Double, _ prof: UnsafeBufferPointer<Double>) -> Double {
        var d = Double.infinity
        for i in 0..<starSteps {
            let ax = prof[2 * i], ay = prof[2 * i + 1]
            let ex = prof[2 * i + 2] - ax, ey = prof[2 * i + 3] - ay
            let wx = p - ax, wy = q - ay
            let l2 = ex * ex + ey * ey
            let h = l2 > 0 ? max(0, min(1, (wx * ex + wy * ey) / l2)) : 0
            let dx = wx - ex * h, dy = wy - ey * h
            d = min(d, dx * dx + dy * dy)
        }
        return (inStar(p, q, prof) ? -1 : 1) * d.squareRoot()
    }

    /// The catchlights' cells lately drawn, by their shape and place.
    nonisolated(unsafe) private static var lightCache: [[Double]: [Int]] = [:]

    /// The cells a light lights (lib/eyes.ts `lightCells`), as grid cells [I, J, …], kept.
    fileprivate static func lightCells(_ x: Double, _ y: Double, _ ax: Double, _ ay: Double, full: Double, rot: Double, dot isDot: Bool, c: Double) -> [Int] {
        let key: [Double] = [c, x, y, ax, ay, full, rot, isDot ? 1 : 0]
        if let hit = lightCache[key] { return hit }
        let got = lightRaster(x, y, ax, ay, full: full, rot: rot, dot: isDot, c: c)
        if lightCache.count >= 4 * cacheMost { lightCache.removeAll(keepingCapacity: true) }
        lightCache[key] = got
        return got
    }

    /// The cells a light lights (lib/eyes.ts `lightRaster`): each cell's coverage on the light's
    /// own tile, folded about its middle cell (cells clear of the star's box or diamond in its
    /// own turned frame skipped); a small round dot keeps its corners dark; its middle always,
    /// and its spine once its arms reach `cross` cells upright.
    fileprivate static func lightRaster(_ x: Double, _ y: Double, _ ax: Double, _ ay: Double, full: Double, rot: Double, dot isDot: Bool, c: Double) -> [Int] {
        let mi = Int((x / c).rounded(.down)), mj = Int((y / c).rounded(.down))
        let r = max(ax, ay)
        let prof = starProfile(ax, ay, full: full)
        let ax2 = ax * ax
        let cs = cos(rot), sn = sin(rot)
        let m = 0.71 * c
        let diamond = !isDot && full <= 0.5 && ax > 0 && ay > 0
        let dn = diamond ? (1 / ax2 + 1 / (ay * ay)).squareRoot() : 0
        var out: [Int] = [mi, mj]
        let ri = Int((r / c).rounded(.up)) + 1
        let bayer = Self.bayer
        prof.withUnsafeBufferPointer { pf in
            for J in (mj - ri)...(mj + ri) {
                let dj = abs(J - mj)
                let Y = (Double(J) + 0.5) * c
                for I in (mi - ri)...(mi + ri) {
                    let di = abs(I - mi)
                    if di == 0, dj == 0 { continue }
                    if isDot, di != 0, dj != 0, r < dither.dot * c { continue }
                    let X = (Double(I) + 0.5) * c
                    let u = abs((X - x) * cs + (Y - y) * sn)
                    let v = abs((Y - y) * cs - (X - x) * sn)
                    if u > ax + m || v > ay + m { continue }
                    if diamond, (u / ax + v / ay - 1) / dn > m { continue }
                    let cv: Double
                    if isDot {
                        let d = ((X - x) * (X - x) + (Y - y) * (Y - y)).squareRoot() - ax
                        cv = cover(d, X, Y, c, band: dither.edge) { ($0 - x) * ($0 - x) + ($1 - y) * ($1 - y) < ax2 }
                    } else {
                        cv = cover(sdStar(u, v, pf), X, Y, c, band: dither.edge) { px, py in
                            inStar(abs((px - x) * cs + (py - y) * sn), abs((py - y) * cs - (px - x) * sn), pf)
                        }
                    }
                    if cv > bayer[(min(di, dj) & 7) * 8 + (max(di, dj) & 7)] { out.append(I); out.append(J) }
                }
            }
        }
        let upright = !isDot && abs(rot) < dither.upright
        func add(_ I: Int, _ J: Int) {
            var n = 0
            while n < out.count { if out[n] == I, out[n + 1] == J { return }; n += 2 }
            out.append(I); out.append(J)
        }
        // a plus at least once both arms reach a cell (the tile may light one arm's cells and not the other's: a dash)
        if upright, ax >= c, ay >= c {
            add(mi - 1, mj); add(mi + 1, mj); add(mi, mj - 1); add(mi, mj + 1)
        }
        // its spine: once an arm reaches `cross` cells, the cells along each arm a cell long or more out
        // to `spine` of a cell short of its tips, one at least (a plus, never a dash)
        let cross = upright && max(ax, ay) >= dither.cross * c
        if cross, ax >= c {
            let reach = max(1, Int((ax / c - dither.spine).rounded(.down)))
            for n in 1...reach { add(mi - n, mj); add(mi + n, mj) }
        }
        if cross, ay >= c {
            let reach = max(1, Int((ay / c - dither.spine).rounded(.down)))
            for n in 1...reach { add(mi, mj - n); add(mi, mj + n) }
        }
        return out
    }

    /// A burst at cell (bi, bj) (lib/eyes.ts `burstCells`): a four-point star of cells `arm`
    /// pt up and down and `burst.across` of that sideways, `f` through its life, its middle
    /// cross always lit and its arms thinning through its own folded tile.
    fileprivate static func burstCells(_ bi: Int, _ bj: Int, arm: Double, f: Double, c: Double) -> [Int] {
        let A = arm / c
        var out: [Int] = []
        guard A >= burst.cells else { return out }
        let B = A * burst.across
        let ra = Int(A.rounded(.up)), rb = Int(B.rounded(.up))
        let bayer = Self.bayer
        for dv in -ra...ra {
            for du in -rb...rb {
                let au = abs(du), av = abs(dv)
                let q = (Double(au) / (B + 0.5)).squareRoot() + (Double(av) / (A + 0.5)).squareRoot()
                if q >= 1 { continue }
                let v = au + av <= 1 ? 1 : f * (0.25 + 0.75 * min(1, (1 - q) * 2.4))
                if v > bayer[(min(au, av) & 7) * 8 + (max(au, av) & 7)] { out.append(bi + du); out.append(bj + dv) }
            }
        }
        return out
    }

    fileprivate static func near(_ m: [UInt8], _ w: Int, _ h: Int, _ i: Int, _ j: Int, diagonals: Bool = true) -> Bool {
        for dj in -1...1 {
            let y = j + dj
            guard y >= 0, y < h else { continue }
            for di in -1...1 where di != 0 || dj != 0 {
                if !diagonals, di != 0, dj != 0 { continue }
                let x = i + di
                if x >= 0, x < w, m[y * w + x] != 0 { return true }
            }
        }
        return false
    }

    /// The ink (lib/eyes.ts `inkRaster`): each cell's coverage of the oval and the lines held
    /// against the eye's tile (mirrored about its centre), a line's centre always inked;
    /// `inkLines` false (lit), the lines take the rim's tone and are marked as lines.
    fileprivate static func inkRaster(_ ov: Oval?, _ strokes: [Stroke], box: (Double, Double, Double, Double), c: Double, inkLines: Bool) -> InkRaster {
        guard box.2 > box.0, box.3 > box.1, box.0.isFinite, box.1.isFinite, box.2.isFinite, box.3.isFinite else { return .none }
        let i0 = Int((box.0 / c).rounded(.down)) - 1
        let j0 = Int((box.1 / c).rounded(.down)) - 1
        let w = Int((box.2 / c).rounded(.up)) + 1 - i0
        let h = Int((box.3 / c).rounded(.up)) + 1 - j0
        guard w > 0, h > 0, w < 4096, h < 4096 else { return .none }
        var tone = [UInt8](repeating: Tone.none, count: w * h)
        var inside = [UInt8](repeating: 0, count: w * h)
        var onOval = [UInt8](repeating: 0, count: w * h)
        var lines = [UInt8](repeating: 0, count: w * h)
        // a large oval's diagonal edges take the wider band (its corners round off through the tile)
        let roundOval = ov.map { 2 * $0.rx >= dither.round * c } ?? false
        let core2 = 0.25 * c * c
        for j in 0..<h {
            let J = j0 + j
            let Y = (Double(J) + 0.5) * c
            for i in 0..<w {
                let I = i0 + i
                let X = (Double(I) + 0.5) * c
                let t = tile(I, J)
                let k = j * w + i
                // a line: its centre within half a cell of the cell's (always inked), else its coverage
                var isLine = false
                var near2 = Double.infinity
                var d = Double.infinity
                for s in strokes {
                    if X < s.box.0 - c || X > s.box.2 + c || Y < s.box.1 - c || Y > s.box.3 + c { continue }
                    let q = d2Polyline(X, Y, s.pts)
                    near2 = min(near2, q)
                    d = min(d, q.squareRoot() - s.w / 2)
                }
                if near2 <= core2 {
                    isLine = true
                } else if near2 < Double.infinity {
                    isLine = cover(d, X, Y, c, band: dither.edge) { px, py in
                        for s in strokes where d2Polyline(px, py, s.pts) < (s.w / 2) * (s.w / 2) { return true }
                        return false
                    } > t
                }
                var isOval = false
                if let ov, abs(X) <= ov.rx + c, abs(Y - ov.y) <= ov.ry + c {
                    var band = dither.edge
                    if roundOval {
                        let gx = abs(X) / (ov.rx * ov.rx)
                        let gy = abs(Y - ov.y) / (ov.ry * ov.ry)
                        let g = (gx * gx + gy * gy).squareRoot()
                        if g > 0, min(gx, gy) / g > dither.diag { band = dither.corner }
                    }
                    isOval = cover(sdOval(X, Y - ov.y, ov.rx, ov.ry), X, Y, c, band: band) { px, py in
                        (px / ov.rx) * (px / ov.rx) + ((py - ov.y) / ov.ry) * ((py - ov.y) / ov.ry) < 1
                    } > t
                }
                onOval[k] = isOval ? 1 : 0
                // lit, the lines are the rim's paper (on the black an inked line would show only as its rim's outline)
                let isInk = isOval || (isLine && inkLines)
                inside[k] = isInk ? 1 : 0
                if isInk {
                    tone[k] = Tone.ink
                } else if isLine {
                    tone[k] = Tone.rim
                    lines[k] = 1
                }
            }
        }
        return InkRaster(i0: i0, j0: j0, w: w, h: h, tone: tone, inside: inside, onOval: onOval, lines: lines)
    }

    nonisolated(unsafe) private static var inkCache: [[Double]: InkRaster] = [:]

    fileprivate static func inkRasterKept(_ ov: Oval?, _ strokes: [Stroke], box: (Double, Double, Double, Double), c: Double, rim: Double, inkLines: Bool) -> InkRaster {
        var key: [Double] = [c, rim, inkLines ? 1 : 0]
        if let ov { key += [-1, ov.rx, ov.ry, ov.y] }
        for s in strokes { key += [-2, s.w, s.keep ? 1 : 0, Double(s.pts.count)]; key += s.pts }
        if let hit = inkCache[key] { return hit }
        let r = inkRaster(ov, strokes, box: box, c: c, inkLines: inkLines)
        if inkCache.count >= cacheMost { inkCache.removeAll(keepingCapacity: true) }
        inkCache[key] = r
        return r
    }

    /// One eye rasterised in its own cells (lib/eyes.ts `eyeCells`, step for step): the ink (in
    /// its own box, kept); the catchlights fitted to the pupil at rest (spines first, then a step
    /// at a time) and drawn as they are now, with a flare's or a pop's burst; the bloom; the
    /// rim's rings, the halo of ink round a loose catchlight and the ramp.
    fileprivate static func eyeRaster(_ ink: [Ink], _ light: [Light], c: Double, rim: Double, lit: Bool, ramp rampOn: Bool) -> EyeRaster {
        var x0 = Double.infinity, y0 = Double.infinity, x1 = -Double.infinity, y1 = -Double.infinity
        func grow(_ ax: Double, _ ay: Double, _ bx: Double, _ by: Double) {
            x0 = min(x0, ax); y0 = min(y0, ay); x1 = max(x1, bx); y1 = max(y1, by)
        }
        var oval: Oval?
        var strokes: [Stroke] = []
        var plain = false
        for s in ink {
            switch s {
            case let .oval(rx, ry, y):
                oval = (rx, ry, y)
                grow(-rx - rim, y - ry - rim, rx + rim, y + ry + rim)
            case let .line(pts, lw, keep, isPlain):
                if isPlain { plain = true }
                let p = lw / 2
                var bx0 = Double.infinity, by0 = Double.infinity, bx1 = -Double.infinity, by1 = -Double.infinity
                var i = 0
                while i + 1 < pts.count {
                    bx0 = min(bx0, pts[i] - p); by0 = min(by0, pts[i + 1] - p)
                    bx1 = max(bx1, pts[i] + p); by1 = max(by1, pts[i + 1] + p)
                    i += 2
                }
                strokes.append((pts, lw, keep, (bx0, by0, bx1, by1)))
                grow(bx0 - rim, by0 - rim, bx1 + rim, by1 + rim)
            }
        }
        // the ink's own box (rim included): the ink and the rim are rasterised only there, the lights wherever they reach
        let inkBox = (x0, y0, x1, y1)
        for l in light {
            let kk = max(1, l.k)
            let r = max(l.ax * kk * l.sx, l.ay * kk * l.sy) + 2 * c
            let reach = r + (l.burst > 0 ? l.burst * (1 + burst.across) + 2 * c : 0)
            grow(l.x - reach, l.y - reach, l.x + reach, l.y + reach)
        }
        guard x1 > x0, y1 > y0, x0.isFinite, y0.isFinite, x1.isFinite, y1.isFinite, c > 0 else { return .none }
        // a cell of margin each way for the ring
        let i0 = Int((x0 / c).rounded(.down)) - 1
        let j0 = Int((y0 / c).rounded(.down)) - 1
        let w = Int((x1 / c).rounded(.up)) + 1 - i0
        let h = Int((y1 / c).rounded(.up)) + 1 - j0
        guard w > 0, h > 0, w < 4096, h < 4096 else { return .none }
        let count = w * h
        var tone = [UInt8](repeating: Tone.none, count: count)
        var inside = [UInt8](repeating: 0, count: count)
        var onOval = [UInt8](repeating: 0, count: count)
        var loose = [UInt8](repeating: 0, count: count)
        var lines = [UInt8](repeating: 0, count: count)
        let inkLines = !lit || strokes.contains { $0.keep }
        @inline(__always) func tileAt(_ I: Int, _ J: Int) -> Double { tile(I, J) }
        // the ink's box in the eye's cells, a cell of margin each way (none when there is no ink)
        let hasInk = inkBox.2 > inkBox.0 && inkBox.3 > inkBox.1
        let ia = hasInk ? max(0, Int((inkBox.0 / c).rounded(.down)) - 1 - i0) : 0
        let ib = hasInk ? min(w, Int((inkBox.2 / c).rounded(.up)) + 1 - i0) : 0
        let ja = hasInk ? max(0, Int((inkBox.1 / c).rounded(.down)) - 1 - j0) : 0
        let jb = hasInk ? min(h, Int((inkBox.3 / c).rounded(.up)) + 1 - j0) : 0

        // 1. the ink, rasterised in its own box (kept: a face whose catchlights change keeps its ink)
        let ink0 = inkRasterKept(oval, strokes, box: inkBox, c: c, rim: rim, inkLines: inkLines)
        if ink0.w > 0 {
            let ox = ink0.i0 - i0, oy = ink0.j0 - j0
            for b in 0..<ink0.h {
                let src = b * ink0.w, dst = (oy + b) * w + ox
                for a in 0..<ink0.w {
                    tone[dst + a] = ink0.tone[src + a]
                    inside[dst + a] = ink0.inside[src + a]
                    onOval[dst + a] = ink0.onOval[src + a]
                    lines[dst + a] = ink0.lines[src + a]
                }
            }
        }

        // 2. the catchlights, each kept to its pupil's inner cells at rest
        func innerAt(_ I: Int, _ J: Int) -> Bool {
            let i = I - i0, j = J - j0
            if i < 1 || j < 1 || i >= w - 1 || j >= h - 1 { return false }
            let k = j * w + i
            return onOval[k] != 0 && onOval[k - 1] != 0 && onOval[k + 1] != 0 && onOval[k - w] != 0 && onOval[k + w] != 0
        }
        var shine = [UInt8](repeating: 0, count: count)
        func put(_ got: [Int]) {
            var n = 0
            while n + 1 < got.count {
                let i = got[n] - i0, j = got[n + 1] - j0
                if i >= 0, j >= 0, i < w, j < h { shine[j * w + i] = 1 }
                n += 2
            }
        }
        var blooms: [(x: Double, y: Double, ax: Double, ay: Double, amp: Double)] = []
        for l in light {
            var x = l.x
            var capX = l.ax, capY = l.ay
            // the fit depends only on the light at rest and its pupil: kept, so a breath or a flare never fits it again
            let fk: [Double]? = l.fit ? oval.map { [c, $0.rx, $0.ry, $0.y, l.x, l.y, l.ax, l.ay, l.full0, l.dot ? 1 : 0] } : nil
            if let fk, let hit = fitCache[fk] {
                if !hit.kept { continue }
                x = hit.x; capX = hit.ax; capY = hit.ay
            } else if l.fit {
                // at rest (unturned, its resting sides): first each arm's spine kept to the pupil's inner
                // cells, then its arms a step shorter at a time, the one that leaves the pupil first
                var kept = true
                let si = Int((x / c).rounded(.down)), sj = Int((l.y / c).rounded(.down))
                func spineOut(_ arm: Double, across: Bool) -> Bool {
                    if l.dot || arm < dither.cross * c { return false }
                    let reach = Int((arm / c - dither.spine).rounded(.down))
                    guard reach >= 1 else { return false }
                    for n in 1...reach {
                        if across ? (!innerAt(si - n, sj) || !innerAt(si + n, sj)) : (!innerAt(si, sj - n) || !innerAt(si, sj + n)) { return true }
                    }
                    return false
                }
                while capY > 0.5 * c, spineOut(capY, across: false) { capY = max(0, capY - dither.fit * c) }
                while capX > 0.5 * c, spineOut(capX, across: true) { capX = max(0, capX - dither.fit * c) }
                if !l.dot, capX < c { capY = min(capY, 0.5 * c) }
                while true {
                    let got = lightCells(x, l.y, capX, capY, full: l.full0, rot: 0, dot: l.dot, c: c)
                    let mi = Int((x / c).rounded(.down)), mj = Int((l.y / c).rounded(.down))
                    var miss: (Int, Int)?
                    var n = 0
                    while n + 1 < got.count {
                        if !innerAt(got[n], got[n + 1]) { miss = (got[n] - mi, got[n + 1] - mj); break }
                        n += 2
                    }
                    guard let m = miss else { break }
                    if capX <= 0.5 * c, capY <= 0.5 * c {
                        // even its middle is on the pupil's edge: a star steps a cell toward the pupil's middle, a dot gives way
                        let to = mi < -1 ? mi + 1 : (mi > 0 ? mi - 1 : mi)
                        if !l.dot, to != mi, innerAt(to, mj) {
                            x = (Double(to) + 0.5) * c
                        } else if l.dot || onOval[(mj - j0) * w + (mi - i0)] == 0 {
                            kept = false
                        }
                        break
                    }
                    if l.dot {
                        capX = max(0, capX - dither.fit * c)
                        capY = capX
                    } else if abs(m.1) > abs(m.0) || capX <= 0.5 * c {
                        capY = max(0, capY - dither.fit * c)
                    } else {
                        capX = max(0, capX - dither.fit * c)
                    }
                    // a star the fit leaves no arms across is one cell, never a dash
                    if !l.dot, capX < c { capY = min(capY, 0.5 * c) }
                }
                if let fk {
                    if fitCache.count >= cacheMost { fitCache.removeAll(keepingCapacity: true) }
                    fitCache[fk] = (kept, x, capX, capY)
                }
                if !kept { continue }
            }
            // as it is now: the breath, the lids or the pop (under its fit), a flare's stretch; held to the grid's steps
            let kq = jround(l.k * 64) / 64
            var ax = step((l.fit ? min(l.ax * kq, capX) : l.ax * kq) * l.sx, c, dither.quant)
            var ay = step((l.fit ? min(l.ay * kq, capY) : l.ay * kq) * l.sy, c, dither.quant)
            // and as drawn, a star with no arms one way is one cell, never a dash (a blink's reopening shrinks both at once)
            if !l.dot {
                if ax < c { ay = min(ay, 0.5 * c) }
                if ay < c { ax = min(ax, 0.5 * c) }
            }
            put(lightCells(x, l.y, ax, ay, full: l.full, rot: l.rot, dot: l.dot, c: c))
            if l.bloom > 0 { blooms.append((x, l.y, capX, capY, jround(l.bloom * 64) / 64)) }
            if l.burst > 0 {
                let bx = l.tip ? x + ay * sin(l.rot) : x
                let by = l.tip ? l.y - ay * cos(l.rot) : l.y
                put(burstCells(Int((bx / c).rounded(.down)), Int((by / c).rounded(.down)), arm: l.burst, f: l.bf, c: c))
            }
        }
        for k in 0..<count where shine[k] != 0 {
            loose[k] = inside[k] != 0 || lines[k] != 0 ? 0 : 1
            tone[k] = Tone.light
        }

        // 3. the bloom: the glow on the pupil round its star, never near the pupil's edge
        if let ov = oval, !blooms.isEmpty {
            let ix = ov.rx - bloom.inset * c
            let iy = ov.ry - bloom.inset * c
            let R2 = bloom.reach * bloom.reach
            for bl in blooms where ix > 0 && iy > 0 && bl.ax > 0 && bl.ay > 0 {
                let a0 = max(i0, Int(((bl.x - bl.ax * R2) / c).rounded(.down)))
                let a1 = min(i0 + w - 1, Int(((bl.x + bl.ax * R2) / c).rounded(.down)))
                let b0 = max(j0, Int(((bl.y - bl.ay * R2) / c).rounded(.down)))
                let b1 = min(j0 + h - 1, Int(((bl.y + bl.ay * R2) / c).rounded(.down)))
                guard a1 >= a0, b1 >= b0 else { continue }
                for J in b0...b1 {
                    let Y = (Double(J) + 0.5) * c
                    for I in a0...a1 {
                        let k = (J - j0) * w + (I - i0)
                        if tone[k] != Tone.ink || onOval[k] == 0 { continue }
                        let X = (Double(I) + 0.5) * c
                        let ex = X / ix, ey = (Y - ov.y) / iy
                        if ex * ex + ey * ey >= 1 { continue }
                        let qx = (X - bl.x) / bl.ax, qy = (Y - bl.y) / bl.ay
                        let q = (qx * qx + qy * qy).squareRoot()
                        if q >= bloom.reach { continue }
                        let u = max(0, (q - bloom.from) / (bloom.reach - bloom.from))
                        if bl.amp * (1 - u) * (1 - u) > tileAt(I, J) { tone[k] = Tone.glow }
                    }
                }
            }
        }

        if rim > 0, ib > ia, jb > ja {
            // 4. whole rings of rim round the ink, the first through the eight neighbours, the next through the four
            var grown = inside
            var ring = [UInt8](repeating: 0, count: count)
            for n in 0..<Int(max(1, jround(rim / c))) {
                let was = grown
                for j in ja..<jb {
                    for i in ia..<ib {
                        let k = j * w + i
                        if was[k] != 0 || !near(was, w, h, i, j, diagonals: n % 2 == 0) { continue }
                        grown[k] = 1
                        if tone[k] == Tone.none { tone[k] = Tone.rim; ring[k] = 1 }
                    }
                }
            }
            // the halo: a rim cell (of the rings, never a lit line) touching a catchlight over no ink turns ink
            for j in ja..<jb {
                for i in ia..<ib where ring[j * w + i] != 0 && near(loose, w, h, i, j) {
                    tone[j * w + i] = Tone.ink
                    ring[j * w + i] = 0
                }
            }
            if rampOn {
                // the ramp: down the rim's rows from its paper to its foot, tilted away from the light, through the eye's
                // tile; and down a lit line's rows the same way (a lid's ends paper, its sag the foot), so a shut eye is
                // dithered as an open one's rim is, never a flat cut-out of paper
                func ramped(_ on: (Int) -> Bool, from: Double, to: Double) {
                    var top = h, bot = -1, lef = w, rig = -1
                    for j in ja..<jb {
                        for i in ia..<ib where on(j * w + i) {
                            top = min(top, j); bot = max(bot, j); lef = min(lef, i); rig = max(rig, i)
                        }
                    }
                    guard bot >= top else { return }
                    let mid = Double(lef + rig) / 2
                    let halfW = max(1, Double(rig - lef + 1) / 2)
                    for j in top...bot {
                        for i in lef...rig where on(j * w + i) {
                            let p = (Double(j - top) + 0.5) / Double(bot - top + 1) + ramp.tilt * (Double(i) - mid) / halfW
                            if p >= to || (p > from && (p - from) / (to - from) > tileAt(i0 + i, j0 + j)) {
                                tone[j * w + i] = Tone.foot
                            }
                        }
                    }
                }
                ramped({ ring[$0] != 0 }, from: ramp.from, to: ramp.to)
                if !plain { ramped({ lines[$0] != 0 && tone[$0] == Tone.rim }, from: ramp.lineFrom, to: ramp.lineTo) }
            }
        }
        return EyeRaster(i0: i0, j0: j0, w: w, h: h, tone: tone)
    }

    /// The eyes drawn lately, by everything that shapes their cells (lib/eyes.ts's cache), so
    /// a face that only moves is never rasterised again.
    nonisolated(unsafe) private static var cache: [[Double]: EyeRaster] = [:]
    /// The catchlights fitted lately (their pupil and their resting shape: the fit's whole input).
    nonisolated(unsafe) private static var fitCache: [[Double]: (kept: Bool, x: Double, ax: Double, ay: Double)] = [:]
    private static let cacheMost = 96

    fileprivate static func eyeKey(_ ink: [Ink], _ light: [Light], c: Double, rim: Double, lit: Bool, ramp rampOn: Bool) -> [Double] {
        var key: [Double] = [c, rim, lit ? 1 : 0, rampOn ? 1 : 0]
        key.reserveCapacity(96)
        for s in ink {
            switch s {
            case let .oval(rx, ry, y): key += [-1, rx, ry, y]
            case let .line(pts, lw, keep, isPlain): key += [-2, lw, keep ? 1 : 0, isPlain ? 1 : 0, Double(pts.count)]; key += pts
            }
        }
        for l in light {
            key += [-3, l.x, l.y, l.ax, l.ay, jround(l.k * 64), l.sx, l.sy, l.full, l.full0, l.rot,
                    l.dot ? 1 : 0, l.fit ? 1 : 0, l.tip ? 1 : 0, jround(l.bloom * 64), l.burst, l.bf]
        }
        return key
    }

    fileprivate static func eyeRasterKept(_ ink: [Ink], _ light: [Light], c: Double, rim: Double, lit: Bool, ramp rampOn: Bool) -> EyeRaster {
        let key = eyeKey(ink, light, c: c, rim: rim, lit: lit, ramp: rampOn)
        if let hit = cache[key] { return hit }
        let e = eyeRaster(ink, light, c: c, rim: rim, lit: lit, ramp: rampOn)
        if cache.count >= cacheMost { cache.removeAll(keepingCapacity: true) }
        cache[key] = e
        return e
    }

    /// The pair `left`, `right` of a body of radius R, their centres `half` pt either side of
    /// (cx, cy), posed, on `grid`, drawn in `style`, snapped as one: the left eye's centre to
    /// the nearest grid corner (or the one `style.hold` keeps), the right a whole number of cells from it.
    static func pairCells(_ left: Character, _ right: Character, cx: Double, cy: Double, half: Double, R: Double, pose: FacePose,
                          grid: FaceGrid, style: FaceStyle = FaceStyle()) -> FaceCells {
        let c = grid.cell
        guard c > 0, c.isFinite, cx.isFinite, cy.isFinite, half.isFinite, R.isFinite, R > 0 else { return .empty }
        let rim = style.rim
        let lit = style.lit && rim > 0
        let rampOn = style.ramp && rim > 0
        let D = style.hold.map { $0.spread(2 * half / c) } ?? max(1, jround(2 * half / c))
        let u = (cx - grid.x) / c - D / 2
        let v = (cy - grid.y) / c
        let (colL, rowD) = style.hold.map { $0.at(u, v) } ?? (jround(u), jround(v))
        let row = Int(rowD)
        let at = [Int(colL), Int(colL) + Int(D)]
        var eyes: [EyeRaster] = []
        eyes.reserveCapacity(2)
        for e in 0..<2 {
            var ink: [Ink] = [], light: [Light] = []
            eyeShapes(EyeKind(e == 0 ? left : right), side: e == 0 ? -1 : 1, R: R, pose: pose, c: c, ink: &ink, light: &light)
            eyes.append(eyeRasterKept(ink, light, c: c, rim: rim, lit: lit, ramp: rampOn))
        }
        var c0 = Int.max, r0 = Int.max, c1 = Int.min, r1 = Int.min
        for (n, e) in eyes.enumerated() where e.w > 0 {
            c0 = min(c0, at[n] + e.i0); c1 = max(c1, at[n] + e.i0 + e.w)
            r0 = min(r0, row + e.j0); r1 = max(r1, row + e.j0 + e.h)
        }
        guard c1 > c0, r1 > r0 else { return .empty }
        let w = c1 - c0, h = r1 - r0
        var tone = [UInt8](repeating: Tone.none, count: w * h)
        for (n, e) in eyes.enumerated() where e.w > 0 {
            let ox = at[n] + e.i0 - c0, oy = row + e.j0 - r0
            for j in 0..<e.h {
                for i in 0..<e.w {
                    let t = e.tone[j * e.w + i]
                    let k = (oy + j) * w + ox + i
                    if t > tone[k] { tone[k] = t }
                }
            }
        }
        return FaceCells(col: c0, row: r0, w: w, h: h, tone: tone)
    }

    /// The face `left` `right` centred at (cx, cy) on a body of radius R, posed, on `grid`,
    /// drawn in `style`: the eyes 0.31 R either side, a touch closer as the face turns.
    static func faceCells(_ left: Character, _ right: Character, cx: Double, cy: Double, R: Double, pose: FacePose,
                          grid: FaceGrid, style: FaceStyle = FaceStyle()) -> FaceCells {
        pairCells(left, right, cx: cx, cy: cy, half: halfSpread(R: R, turn: pose.turn), R: R, pose: pose, grid: grid, style: style)
    }

    /// One eye's ink at rest with its rim, in its own points (its centre at 0, 0): the slot the
    /// blob clears of glyphs under it, on cells of `cell` pt.
    static func inkBounds(eye glyph: Character, side: Double, R: Double, cell c: Double, rim: Double) -> CGRect {
        var ink: [Ink] = [], light: [Light] = []
        eyeShapes(EyeKind(glyph), side: side, R: R, pose: .rest, c: c, ink: &ink, light: &light)
        var box = CGRect.null
        for s in ink {
            switch s {
            case let .oval(rx, ry, y): box = box.union(CGRect(x: -rx, y: y - ry, width: 2 * rx, height: 2 * ry).insetBy(dx: -rim, dy: -rim))
            case let .line(pts, w, _, _):
                var i = 0
                while i + 1 < pts.count {
                    box = box.union(CGRect(x: pts[i], y: pts[i + 1], width: 0, height: 0).insetBy(dx: -(w / 2 + rim), dy: -(w / 2 + rim)))
                    i += 2
                }
            }
        }
        return box
    }

    // MARK: drawing

    /// Fill the face's cells on `grid` (points, y down) in its tones, no antialiasing (a cell
    /// is a cell), the whole face at `alpha` (its tones never overlap). Runs of a tone are one rect.
    static func draw(_ cg: CGContext, _ f: FaceCells, grid: FaceGrid, ink: FaceInk, alpha: CGFloat = 1) {
        guard f.w > 0, f.h > 0, f.tone.count == f.w * f.h, grid.cell > 0, grid.cell.isFinite, grid.x.isFinite, grid.y.isFinite else { return }
        let a = alpha.isFinite ? min(1, max(0, alpha)) : 0
        guard a > 0.003 else { return }
        let c = CGFloat(grid.cell)
        var rects: [[CGRect]] = [[], [], [], [], [], []]
        for j in 0..<f.h {
            var i = 0
            while i < f.w {
                let t = f.tone[j * f.w + i]
                var e = i + 1
                while e < f.w, f.tone[j * f.w + e] == t { e += 1 }
                if t != Tone.none, Int(t) < rects.count {
                    rects[Int(t)].append(CGRect(x: CGFloat(grid.x) + CGFloat(f.col + i) * c, y: CGFloat(grid.y) + CGFloat(f.row + j) * c,
                                                width: CGFloat(e - i) * c, height: c))
                }
                i = e
            }
        }
        let paints: [(UInt8, CGColor)] = [(Tone.foot, ink.foot), (Tone.rim, ink.rim), (Tone.ink, ink.ink), (Tone.glow, ink.glow), (Tone.light, ink.light)]
        cg.saveGState()
        cg.setShouldAntialias(false)
        cg.setAlpha(a)
        for (t, color) in paints where !rects[Int(t)].isEmpty {
            cg.setFillColor(color)
            cg.fill(rects[Int(t)])
        }
        cg.restoreGState()
    }
}

/// The sparkle's timing in s (lib/eyes.ts `TWINKLE`): the catchlights' breath; a flare's
/// life, where its peak falls in it and how far the second eye trails the first; the wait
/// between flares on the lead face (the main blob and the island: `rest`) and on every
/// other (a satellite: `demo`), each a base and a random spread; never two on one face
/// within `gap`, nor two faces within `turn`; a flare `wake` after the eyes open from a
/// closed face; the happy sparkle's `pop`.
enum Twinkle {
    static let period = 3.2
    static let flare = 0.38
    static let peak = 0.35
    static let lag = 0.09
    static let rest = (base: 2.0, spread: 2.6)
    static let demo = (base: 3.0, spread: 3.0)
    static let gap = 0.5
    static let turn = 0.6
    static let wake = 0.32
    static let pop = 0.32

    /// The faces take turns to glint (lib/live.ts `glintTurn`): the last glint's time on
    /// the media clock, shared by every face in the app. A face's own clock asks and waits
    /// when refused; an event (eyes opening) insists.
    @MainActor private static var lastGlint = -Double.infinity
    @MainActor static func take(insist: Bool) -> Bool {
        let now = CACurrentMediaTime()
        if !insist, now - lastGlint < turn { return false }
        lastGlint = now
        return true
    }
}

/// One face's sparkle clock (lib/blob.ts's flare, its queue and the happy pop), stepped on
/// the face's own clock `t` (s) with the pair it shows: every few seconds a star flares on a
/// face that can show one — catchlights (`O`, `o`) or the happy arcs (`^`, whose sparkle
/// pulses) — once the lids are up, the eye the face is turned to first; eyes opening from a
/// closed face catch the light `Twinkle.wake` after; `^` arriving pops its sparkle in.
/// Nothing under Reduce Motion: the pose rests whole.
struct EyeSparkle {
    /// The lead face's quicker clock (`Twinkle.rest`); otherwise `Twinkle.demo`.
    let lead: Bool
    /// The face rests where it lives all day (the notch's lip, asleep in the menu bar):
    /// the catchlights still breathe, but no flare starts and `^` arrives without its
    /// pop — nothing winks from the menu bar, and no frames are spent on it. The first
    /// step after it ends may flare at once: the eyes catch the light as the island opens.
    var quiet = false
    private var flareAt = -9.0
    private var flareLead = -1.0
    private var flareBoth = true
    private var nextFlare: Double
    private var queued: (at: Double, lead: Double, both: Bool)?
    private var joyAt = -9.0
    private var wasHappy = false
    private var wasOpen = false

    init(lead: Bool) {
        self.lead = lead
        let w = lead ? Twinkle.rest : Twinkle.demo
        nextFlare = 1 + Double.random(in: 0..<1) * w.spread
    }

    private var clock: (base: Double, spread: Double) { lead ? Twinkle.rest : Twinkle.demo }
    private var flareEnd: Double { flareAt + Twinkle.flare + (flareBoth ? Twinkle.lag : 0) }

    /// A flare or a pop is on its way: the face wants frames at the sparkle's rate.
    func playing(_ t: Double) -> Bool { t < flareEnd || t < joyAt + Twinkle.pop }

    /// One step: the pair the face shows (before a blink), the lids (the lower), the turn.
    @MainActor mutating func step(t: Double, left: Character, right: Character, open: Double, turn: Double, reduced: Bool) {
        let happy = left == "^"
        if happy, !wasHappy, !quiet, t >= joyAt + Twinkle.pop { joyAt = t }
        wasHappy = happy
        let opens = EyeKind(left).isOpen || EyeKind(right).isOpen
        if opens, !wasOpen, !reduced { queued = (max(t + Twinkle.wake, flareEnd + Twinkle.gap), 0, true) }
        wasOpen = opens
        guard !reduced, !quiet else { queued = nil; return }
        let can = opens || happy
        let ready = can && (happy || open > 0.9)
        if let q = queued, t >= q.at {
            if !can || t > q.at + 1 {
                queued = nil
            } else if ready {
                _ = start(t, lead: q.lead, both: q.both, turn: turn, insist: true)
                queued = nil
            }
        }
        if t >= nextFlare {
            if !can {
                nextFlare = t + clock.base + Double.random(in: 0..<1) * clock.spread
            } else if !ready || queued != nil || t < flareEnd + Twinkle.gap || !start(t, lead: 0, both: true, turn: turn, insist: false) {
                nextFlare = t + 0.3 + Double.random(in: 0..<1) * 0.5
            }
        }
    }

    /// A flare starts now if it is this face's turn (or it insists), in the eye `lead`
    /// (0: the one the face is turned to, else the other eye from last time).
    @MainActor private mutating func start(_ t: Double, lead l: Double, both: Bool, turn: Double, insist: Bool) -> Bool {
        guard Twinkle.take(insist: insist) else { return false }
        flareAt = t
        flareLead = l != 0 ? l : (abs(turn) > 0.3 ? (turn > 0 ? 1 : -1) : (flareLead == 1 ? -1 : 1))
        flareBoth = both
        nextFlare = t + clock.base + Double.random(in: 0..<1) * clock.spread
        return true
    }

    /// The pose at `t`: the lids and the turn as given, the catchlights' breath, each eye's
    /// flare (the second `Twinkle.lag` behind the first) and the happy sparkle's pop and
    /// pulse. Reduce Motion: at rest.
    func pose(t: Double, open: Double, openRight: Double, turn: Double, reduced: Bool) -> FacePose {
        guard !reduced else { return FacePose(open: open, openRight: openRight, turn: turn) }
        let u = (t - flareAt) / Twinkle.flare
        let v = flareBoth ? u - Twinkle.lag / Twinkle.flare : -1
        return FacePose(open: open, openRight: openRight, turn: turn,
                        twinkle: 0.5 + 0.5 * sin(2 * .pi * t / Twinkle.period),
                        flare: flareLead < 0 ? (u, v) : (v, u),
                        spark: Eyes.popSize((t - joyAt) / Twinkle.pop) * (1 + 0.4 * Eyes.flareSize(u)))
    }
}
