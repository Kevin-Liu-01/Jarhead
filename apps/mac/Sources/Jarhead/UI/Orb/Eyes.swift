import CoreGraphics
import QuartzCore

// The face, drawn: the site's eyes (site/lib/eyes.ts) in CoreGraphics, so the app's face
// and the site's are one face. Ink ovals that catch the light as a four-point star and a
// small dot, and a small vocabulary of lines for the faces that close them. One geometry
// in R units (the body's radius) for the blob (`BlobFieldView`, sized to its body as
// lib/blob.ts sizes it) and the notch island (`NotchView`, R 52 at (57, 40) open, as the
// site's island places it: components/desk/Island.tsx).
//
//  * The glyph pair still names the expression (`BlobSim.face`, one glyph per eye): `O`
//    open, `o` small open, `.` a bead (the gate's ear asleep: a small round pupil with one
//    point of light that holds still, the installed `. .` drawn), `-`
//    closed (a soft sag), `^` happy (an arc), `u` content (a cup), `_` flat, `x` error,
//    `>` `<` squeezed shut (each points at the middle), `~` wavy. Cute is low, close and
//    round: the eyes sit just above the body's middle, a little over half a radius
//    apart, taller than wide. Small faces (R under 34) draw their eyes a little larger
//    and their lines never under 1.75 pt, so a small face still reads.
//  * The lids (`FacePose.open`, per eye): a blink squashes the oval, widens it a little
//    and drops its top; under 0.22 the eye is the closed lid; reopening past 1 it
//    stretches a touch taller and narrower. The look turns the face: the far eye narrows.
//  * The sparkle (`Twinkle`, `EyeSparkle`): each open eye's catchlights, a star toward
//    the gleam (upper left) and a dot across from it, in solid paper inside the pupil,
//    breathe in size (the star swells as the dot ebbs), and now and then a star flares:
//    it twists, turns upright and stretches into a long glint whose top arm reaches out
//    past the pupil while the dot gives way, the other eye a beat behind. The happy arcs
//    wear a sparkle of their own off the right eye's outer top, a small star and a dot
//    that pop in as the face appears and pulse with each flare. A mark under
//    `minMark` pt at its resting size is left out, so no face smudges.
//  * Inked as the site's island inks it (Island.tsx `islandFace`): every ink shape
//    rimmed in the phase-tinted paper, then the ink, then a thin ink halo round each
//    light mark (shown only over the rims), then the light marks. The face reads on the
//    island's dark, on the blob's glyphs and on any desktop, and a flaring star that
//    crosses a pupil's rim keeps its points.
//
// Pure geometry plus one draw call: no AppKit, no state but the sparkle's clock.

/// What one eye is, from its glyph (lib/eyes.ts `eyeOf`); anything unknown is closed.
/// The gate's `.` (an ear open while asleep) is the bead: round, still, one point of light.
enum EyeKind: Equatable {
    case open, small, bead, closed, happy, content, flat, error, inward, wavy

    init(_ glyph: Character) {
        switch glyph {
        case "O": self = .open
        case "o": self = .small
        case ".": self = .bead
        case "^": self = .happy
        case "u": self = .content
        case "_": self = .flat
        case "x": self = .error
        case ">", "<": self = .inward
        case "~": self = .wavy
        default: self = .closed
        }
    }

    /// An oval that blinks and catches the light (the bead holds still: it does neither).
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

    init(open: Double = 1, openRight: Double? = nil, sparkle: Double = 0, turn: Double = 0,
         twinkle: Double? = nil, flare: (left: Double, right: Double)? = nil, spark: Double? = nil) {
        self.open = open
        self.openRight = openRight ?? open
        self.sparkle = sparkle
        self.turn = turn
        self.twinkle = twinkle
        self.flare = flare
        self.spark = spark
    }

    static let rest = FacePose()
}

/// One shape of the face (lib/eyes.ts `FaceMark`): its path in the face's y-down
/// coordinates, its paint, filled or stroked at `width` (round caps and joins).
struct FaceMark {
    enum Paint { case ink, light }
    let path: CGPath
    let paint: Paint
    let fill: Bool
    let width: CGFloat
}

/// How a face is inked: the pupils and lines, the catchlights, and the rim round every ink
/// shape (Island.tsx: the island's black, paper, and paper with 15 % of the phase).
struct FaceInk {
    var ink: CGColor
    var light: CGColor
    var rim: CGColor
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
    /// The bead: a round pupil `r` a touch under the eyes' line (`y`), its one point of light
    /// up and toward the gleam (fractions of its radius, `r` in R units).
    static let bead = (r: 0.07, y: 0.02, light: (x: -0.32, y: -0.34, r: 0.026))
    /// The catchlights: the star's centre as fractions of the pupil's radii, its arms in R
    /// units, its sides four quadratics whose control sits `full` of an arm out from the
    /// middle (a round bright middle); the dot low across from it.
    static let star = (x: -0.25, y: -0.32, ax: 0.088, ay: 0.118, full: 0.18)
    static let dot = (x: 0.4, y: 0.44, r: 0.034)
    /// Starstruck (lit): the dot becomes a small star, its arms these times its radius.
    static let struck = (ax: 1.1, ay: 1.55)
    /// A flare at its peak: the star's arms reach this much further, its sides pulled in
    /// to `sharp`, twisting out by `spin` rad and back, upright at its peak.
    static let flare = (ax: 0.1, ay: 0.8, sharp: 0.12, spin: 0.45)
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
    /// The closed lid: its ends a touch above the eye's line, its middle sagging below it.
    static let lid = (ends: -0.008, sag: 0.035)
    /// Reopening past round stretches the oval this much taller per unit of overshoot, at most `max`.
    static let stretch = (k: 0.8, max: 0.1)
    /// The smallest sparkle drawn, in pt on screen (a star's arm across, a dot's radius).
    static let minMark = 0.7
    /// The star outline's control that draws a circle to within a few percent: the dot before it is starstruck.
    static let roundControl = 0.914

    /// The island's face (Island.tsx): R 52, its rim 1.9, the glints' ink halo 0.6 at rest
    /// and 1.5 through a flare — all in island points, scaled with R for any other face.
    static let islandR = 52.0
    static let islandRim = 1.9
    static let haloRest = 0.6
    static let haloFlare = 1.5

    /// A small face's eyes grow, up to 40 % at R 16, full size from R 34.
    static func scale(_ R: Double) -> Double {
        let u = (34 - R) / 18
        return 1 + 0.4 * min(1, max(0, u))
    }

    /// The line weight in pt: proportional, never under 1.75.
    static func strokeWidth(_ R: Double) -> Double { max(1.75, stroke * R * scale(R)) }

    /// The rim round every ink shape: the island's 1.9 at R 52, scaled, never under 1 pt.
    static func rimWidth(_ R: Double) -> CGFloat { CGFloat(max(1, islandRim * R / islandR)) }

    /// The glints' ink halo (its full stroke width): the island's, grown through a flare.
    static func haloWidth(_ R: Double, pose: FacePose) -> CGFloat {
        let f = max(flareSize(pose.flare?.left ?? 0), flareSize(pose.flare?.right ?? 0))
        let h = 2 * (haloRest + (haloFlare - haloRest) * min(1, f * 2.5))
        return CGFloat(h * R / islandR)
    }

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

    /// An eye's centre (x) for a face centred at `cx`, turned by `turn`.
    static func eyeX(cx: Double, R: Double, side: Double, turn: Double) -> Double {
        cx + side * spread * R * (1 - 0.08 * abs(turn))
    }

    // MARK: the marks

    /// The pair centred at (cx, cy) on a body of radius R (pt, y down), as marks
    /// (lib/eyes.ts `drawFace`). `unit` is how many screen pt one of these pt is at its
    /// smallest, so the sparkle's floor is judged on screen.
    static func marks(_ left: Character, _ right: Character, cx: Double, cy: Double, R: Double, pose: FacePose, unit: Double = 1) -> [FaceMark] {
        let pen = Pen(lineWidth: strokeWidth(R))
        for (side, glyph) in [(-1.0, left), (1.0, right)] {
            eye(pen, glyph, side: side, ex: eyeX(cx: cx, R: R, side: side, turn: pose.turn), cy: cy, R: R, pose: pose, unit: unit)
        }
        return pen.marks
    }

    /// One eye at (ex, cy), for a face whose eyes are placed one by one (the blob fits
    /// each on its body). `side` −1 is the left eye, +1 the right.
    static func marks(eye glyph: Character, side: Double, ex: Double, cy: Double, R: Double, pose: FacePose, unit: Double = 1) -> [FaceMark] {
        let pen = Pen(lineWidth: strokeWidth(R))
        eye(pen, glyph, side: side, ex: ex, cy: cy, R: R, pose: pose, unit: unit)
        return pen.marks
    }

    /// The box the marks cover, their strokes and the rim included (ink and light alike).
    static func bounds(_ marks: [FaceMark], rim: CGFloat) -> CGRect {
        var box = CGRect.null
        for m in marks {
            let pad = m.paint == .ink ? m.width / 2 + rim : 0
            box = box.union(m.path.boundingBoxOfPath.insetBy(dx: -pad, dy: -pad))
        }
        return box
    }

    private static func eye(_ g: Pen, _ glyph: Character, side: Double, ex: Double, cy: Double, R: Double, pose: FacePose, unit: Double) {
        let k = scale(R)
        let lw = strokeWidth(R)
        let kind = EyeKind(glyph)
        let far = max(0, -side * pose.turn)
        let narrow = 1 - 0.14 * far
        let lidOpen = side < 0 ? pose.open : pose.openRight
        if kind == .bead {
            // still and round: no blink squashes it and no flare lights it (the gate listens; the face rests)
            let r = bead.r * R * k
            let by = cy + bead.y * R * k
            if lidOpen < 0.22 {
                lidMark(g, ex, by, r * 1.2, R * k)
                return
            }
            g.beginPath()
            g.ellipse(ex, by, r * narrow, r, 0, 2 * .pi)
            g.fill(.ink)
            let l = bead.light.r * R * k
            if l * unit >= minMark { dotMark(g, ex + r * narrow * bead.light.x, by + r * bead.light.y, l) }
            return
        }
        if kind.isOpen {
            let o = min(1, max(0, lidOpen))
            let shape = kind == .open ? openEye : smallEye
            let grow = 1 + 0.08 * pose.sparkle
            let rx = shape.rx * R * k * narrow * grow
            let ry = shape.ry * R * k * grow
            if o < 0.22 {
                // shut: the closed lid, as wide as the open eye
                lidMark(g, ex, cy, rx * 1.05, R * k)
                return
            }
            // the blink: the oval squashes, widens a little and its top comes down; reopening,
            // it overshoots a touch taller and narrower, then settles
            let over = lidOpen > 1 ? min(stretch.max, (lidOpen - 1) * stretch.k) : 0
            let ryo = ry * o * (1 + over)
            let rxo = rx * (1 + 0.18 * (1 - o)) * (1 - 0.4 * over)
            let yo = cy + (ry - ryo) * 0.35
            g.beginPath()
            g.ellipse(ex, yo, rxo, ryo, 0, 2 * .pi)
            g.fill(.ink)
            // the catchlights come back as the lids open
            if o > 0.5 {
                catchlights(g, ex, yo, rxo, ryo, s: R * k * (kind == .small ? 0.8 : 1), a: (o - 0.5) * 2, narrow: narrow, pose: pose, side: side, unit: unit)
            }
            return
        }
        let w = half * R * k * narrow
        g.lineWidth = lw
        g.beginPath()
        switch kind {
        case .closed, .open, .small, .bead:
            lidMark(g, ex, cy, w, R * k)
            return
        case .happy:
            g.lineWidth = lw * joy
            let r = arc.r * R * k
            let c = cy + arc.drop * R * k
            g.ellipse(ex, c, r * narrow, r, .pi * (1.5 - arc.sweep), .pi * (1.5 + arc.sweep))
        case .content:
            let r = cup.r * R * k
            let c = cy - cup.lift * R * k
            g.ellipse(ex, c, r * narrow, r, .pi * (0.5 - cup.sweep), .pi * (0.5 + cup.sweep))
        case .flat:
            g.move(ex - w * 0.9, cy + 0.06 * R * k)
            g.line(ex + w * 0.9, cy + 0.06 * R * k)
        case .error:
            let d = 0.066 * R * k
            g.move(ex - d * narrow, cy - d)
            g.line(ex + d * narrow, cy + d)
            g.move(ex + d * narrow, cy - d)
            g.line(ex - d * narrow, cy + d)
        case .inward:
            // `>` on the left eye, `<` on the right: each points at the middle, squeezed shut
            let dir = -side
            let a = 0.082 * R * k
            let v = 0.074 * R * k
            g.move(ex - dir * a * narrow, cy - v)
            g.line(ex + dir * a * narrow, cy)
            g.line(ex - dir * a * narrow, cy + v)
        case .wavy:
            // a soft ripple, half the open eye's height: a dream, not a moustache
            let amp = 0.022 * R * k
            for i in 0...16 {
                let x = ex - w * 0.9 + 1.8 * w * Double(i) / 16
                let y = cy + amp * sin(Double(i) / 16 * 2 * .pi)
                if i == 0 { g.move(x, y) } else { g.line(x, y) }
            }
        }
        g.stroke(.ink)
        if kind == .happy, side > 0 { gleeSparkle(g, ex, cy, R * k, narrow: narrow, pose: pose, unit: unit) }
    }

    /// A four-point star at (x, y), arms `ax` across and `ay` up and down, its sides
    /// quadratics through a control `full` of an arm out from the middle, turned by `rot`.
    private static func starMark(_ g: Pen, _ x: Double, _ y: Double, _ ax: Double, _ ay: Double, full: Double, rot: Double) {
        let c = cos(rot), s = sin(rot)
        func p(_ px: Double, _ py: Double) -> (Double, Double) { (x + px * c - py * s, y + px * s + py * c) }
        let fx = full * ax, fy = full * ay
        g.beginPath()
        g.move(p(0, -ay))
        g.quad(p(fx, -fy), p(ax, 0))
        g.quad(p(fx, fy), p(0, ay))
        g.quad(p(-fx, fy), p(-ax, 0))
        g.quad(p(-fx, -fy), p(0, -ay))
        g.close()
        g.fill(.light)
    }

    private static func dotMark(_ g: Pen, _ x: Double, _ y: Double, _ r: Double) {
        g.beginPath()
        g.ellipse(x, y, r, r, 0, 2 * .pi)
        g.fill(.light)
    }

    /// The largest arms (across, up and down) a star centred at (X, Y) — fractions of a
    /// pupil's radii rx, ry — has inside the pupil.
    private static func fitArms(_ rx: Double, _ ry: Double, _ X: Double, _ Y: Double) -> (Double, Double) {
        let m = fit * fit
        return (rx * ((max(0, m - Y * Y)).squareRoot() - abs(X)), ry * ((max(0, m - X * X)).squareRoot() - abs(Y)))
    }

    /// An open eye's catchlights on its pupil at (x, y), radii (rx, ry): `s` their scale
    /// (R·k), `a` how far the lids have let them back (0…1). Lit, the star grows as far as
    /// the pupil holds it and the dot turns into a small star; a flare stretches the
    /// star's arms past the pupil and twists it upright at its peak; the breath trades
    /// the star's size for the dot's. Each mark's floor is judged at its resting size.
    private static func catchlights(_ g: Pen, _ x: Double, _ y: Double, _ rx: Double, _ ry: Double, s: Double, a: Double, narrow: Double,
                                    pose: FacePose, side: Double, unit: Double) {
        let lit = pose.sparkle
        let swell = pose.twinkle.map { 0.9 + 0.1 * $0 } ?? 1
        let ebb = pose.twinkle.map { 0.9 + 0.1 * (1 - $0) } ?? 1
        let u = pose.flare.map { side < 0 ? $0.left : $0.right } ?? 0
        let f = flareSize(u)
        // the star: narrowed with its eye, fitted inside the pupil, then a flare's reach past it
        let ax0 = star.ax * s * narrow
        if ax0 * unit >= minMark {
            let (mx, my) = fitArms(rx, ry, star.x, star.y)
            let ax = min(ax0 * (1 + 0.24 * lit) * swell * a, mx) * (1 + flare.ax * f)
            let ay = min(star.ay * s * (1 + 0.15 * lit) * swell * a, my) * (1 + flare.ay * f)
            starMark(g, x + rx * star.x, y + ry * star.y, ax, ay, full: star.full + (flare.sharp - star.full) * f, rot: -side * flareTwist(u))
        }
        // the dot, starstruck while lit; it gives way to a flare, so the light gathers in the glint
        let r0 = dot.r * s * (1 + 0.4 * lit)
        if r0 * unit >= minMark {
            let r = r0 * ebb * a * (1 - 0.5 * f)
            let dx = x + rx * dot.x, dy = y + ry * dot.y
            if lit < 0.02 {
                dotMark(g, dx, dy, r)
            } else {
                let (mx, my) = fitArms(rx, ry, dot.x, dot.y)
                starMark(g, dx, dy, min(r * (1 + (struck.ax - 1) * lit), mx), min(r * (1 + (struck.ay - 1) * lit), my),
                          full: roundControl + (star.full - roundControl) * lit, rot: 0)
            }
        }
    }

    /// The happy arcs' sparkle beside the right eye (centre (ex, cy), `Rk` its scale): a
    /// small star and a dot up and in from it, breathing with the catchlights, popping in
    /// and pulsing with each flare.
    private static func gleeSparkle(_ g: Pen, _ ex: Double, _ cy: Double, _ Rk: Double, narrow: Double, pose: FacePose, unit: Double) {
        let swell = pose.twinkle.map { 0.9 + 0.1 * $0 } ?? 1
        let ebb = pose.twinkle.map { 0.9 + 0.1 * (1 - $0) } ?? 1
        let pop = pose.spark ?? 1
        guard pop > 0.02 else { return }
        let a = glee.a * Rk * (1 + 0.25 * pose.sparkle)
        if a * 0.75 * unit >= minMark {
            starMark(g, ex + glee.x * Rk * narrow, cy + glee.y * Rk, a * 0.75 * swell * pop, a * swell * pop, full: star.full, rot: 0)
        }
        let r = glee.dotR * Rk
        if r * unit >= minMark { dotMark(g, ex + glee.dotX * Rk * narrow, cy + glee.dotY * Rk, r * ebb * pop) }
    }

    /// The closed lid: a soft sag, its middle a little lower than its ends.
    private static func lidMark(_ g: Pen, _ ex: Double, _ cy: Double, _ w: Double, _ Rk: Double) {
        g.beginPath()
        g.move(ex - w, cy + lid.ends * Rk)
        g.quad((ex, cy + lid.sag * Rk), (ex + w, cy + lid.ends * Rk))
        g.stroke(.ink)
    }

    // MARK: drawing

    /// Ink the marks into a y-down context as the site's island does: every ink shape's
    /// rim in `ink.rim` (`rim` pt either side of it), the ink, a `halo`-wide ink stroke
    /// round every light mark shown only over the rims, then the light marks. `alpha`
    /// fades the face as one (a transparency layer), never shape by shape.
    static func draw(_ cg: CGContext, _ marks: [FaceMark], ink: FaceInk, rim: CGFloat, halo: CGFloat, alpha: CGFloat = 1) {
        guard !marks.isEmpty, rim.isFinite, halo.isFinite else { return }
        let a = alpha.isFinite ? min(1, max(0, alpha)) : 0
        guard a > 0.003 else { return }
        let box = bounds(marks, rim: rim + halo)
        guard !box.isNull, box.width.isFinite, box.height.isFinite else { return }
        cg.saveGState()
        cg.setLineCap(.round)
        cg.setLineJoin(.round)
        let layered = a < 0.999
        if layered {
            cg.setAlpha(a)
            cg.beginTransparencyLayer(in: box.insetBy(dx: -1, dy: -1), auxiliaryInfo: nil)
        } else {
            cg.setAlpha(1)
        }
        let inks = marks.filter { $0.paint == .ink }
        let lights = marks.filter { $0.paint == .light }
        // the rims: each ink shape filled (a pupil) and stroked wider by the rim either side
        cg.setFillColor(ink.rim)
        cg.setStrokeColor(ink.rim)
        for m in inks {
            if m.fill { cg.addPath(m.path); cg.fillPath() }
            cg.addPath(m.path)
            cg.setLineWidth(m.width + 2 * rim)
            cg.strokePath()
        }
        // the ink
        cg.setFillColor(ink.ink)
        cg.setStrokeColor(ink.ink)
        for m in inks {
            cg.addPath(m.path)
            if m.fill { cg.fillPath() } else { cg.setLineWidth(m.width); cg.strokePath() }
        }
        if !lights.isEmpty {
            // the halos, only over the rims (inside a pupil they are ink on ink): clipped to
            // each ink shape's rim band in turn — opaque ink, so an overlap draws the same
            if halo > 0.01 {
                for m in inks {
                    cg.saveGState()
                    cg.addPath(m.path)
                    cg.setLineWidth(m.width + 2 * rim)
                    cg.replacePathWithStrokedPath()
                    cg.clip()
                    cg.setLineWidth(halo)
                    for l in lights { cg.addPath(l.path); cg.strokePath() }
                    cg.restoreGState()
                }
            }
            cg.setFillColor(ink.light)
            for l in lights { cg.addPath(l.path); cg.fillPath() }
        }
        if layered { cg.endTransparencyLayer() }
        cg.restoreGState()
    }

    // MARK: the pen

    /// What `eye` draws with: canvas-shaped calls (lib/eyes.ts `FacePen`) that write each
    /// fill and stroke down as a mark instead of painting it.
    private final class Pen {
        var lineWidth: Double
        private var path = CGMutablePath()
        private(set) var marks: [FaceMark] = []

        init(lineWidth: Double) { self.lineWidth = lineWidth }

        func beginPath() { path = CGMutablePath() }
        func move(_ x: Double, _ y: Double) { path.move(to: CGPoint(x: x, y: y)) }
        func move(_ p: (Double, Double)) { move(p.0, p.1) }
        func line(_ x: Double, _ y: Double) {
            if path.isEmpty { move(x, y) } else { path.addLine(to: CGPoint(x: x, y: y)) }
        }
        func quad(_ c: (Double, Double), _ p: (Double, Double)) {
            path.addQuadCurve(to: CGPoint(x: p.0, y: p.1), control: CGPoint(x: c.0, y: c.1))
        }
        /// An arc of an ellipse clockwise on screen (y down) from a0 to a1, joined to the
        /// path by a line as canvas joins it.
        func ellipse(_ x: Double, _ y: Double, _ rx: Double, _ ry: Double, _ a0: Double, _ a1: Double) {
            guard rx > 0, ry > 0, rx.isFinite, ry.isFinite, x.isFinite, y.isFinite else { return }
            let t = CGAffineTransform(a: rx, b: 0, c: 0, d: ry, tx: x, ty: y)
            path.addRelativeArc(center: .zero, radius: 1, startAngle: a0, delta: a1 - a0, transform: t)
        }
        func close() { path.closeSubpath() }
        func fill(_ paint: FaceMark.Paint) { record(paint, fill: true) }
        func stroke(_ paint: FaceMark.Paint) { record(paint, fill: false) }

        private func record(_ paint: FaceMark.Paint, fill: Bool) {
            guard !path.isEmpty, !path.boundingBoxOfPath.isNull else { return }
            marks.append(FaceMark(path: path.copy() ?? path, paint: paint, fill: fill, width: fill ? 0 : CGFloat(lineWidth)))
        }
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
/// face that can show one — catchlights (`O`, `o`; the gate's `.` bead holds still) or the happy arcs (`^`, whose
/// sparkle pulses) — once the lids are up, the eye the face is turned to first; eyes
/// opening from a closed face catch the light `Twinkle.wake` after; `^` arriving pops its
/// sparkle in. Nothing under Reduce Motion: the pose rests whole.
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
