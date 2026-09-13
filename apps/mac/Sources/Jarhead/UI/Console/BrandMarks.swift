import SwiftUI

// The tool behind a session, as its real mark: the vendor's own SVG path data,
// drawn as a SwiftUI Path through a small SVG path parser (`SVGPathParser`),
// monochrome in the brand colour, 14pt on the fixed 20pt icon column (REDESIGN §9;
// Kevin: "add proper codex and claude code icons https://thesvg.org/"). No image
// asset ships — each logo is path data in `BrandLogos`, with where it came from and
// the licence theSVG lists for it. Tools whose logo theSVG does not carry (Amp — its
// `amp` is Google AMP; Droid; Hermes, the parcel carrier there) keep the drawn glyph
// or the titanium monogram. Never an SF Symbol the Console already uses on the icon
// column (terminal.fill is a tool call, bolt.fill is Wake), so a mark is never
// mistaken for a row kind. The colour is the status dot's ring and the conversation
// header; the Codex mark keeps its paper-on-ink chip.

enum ConsoleBrand {
    static let claude = ConsoleTheme.rgb(0xd97757)
    static let gemini = ConsoleTheme.rgb(0x4796e3)
    static let opencode = ConsoleTheme.rgb(0x6ee7a0)
    static let amp = ConsoleTheme.rgb(0xffb454)
    /// Codex's chip: ink under paper. In dark mode the ground is already ink, so the
    /// chip lifts to raised ink and keeps a hairline edge.
    static let chip = ConsoleTheme.dynamic(light: ConsoleTheme.nsColor(0x070707), dark: ConsoleTheme.nsColor(0x101010))
    static let paper = Color.white

    /// Display order of tool groups in the agents rail.
    static let order: [AgentTool] = [.claude, .codex, .cursor, .gemini, .opencode, .amp, .droid, .hermes, .pi, .other]

    static func color(_ tool: AgentTool) -> Color {
        switch tool {
        case .claude: return claude
        case .gemini: return gemini
        case .opencode: return opencode
        case .amp: return amp
        // Paper on ink: the text colour is paper in dark, ink in light.
        case .codex, .cursor: return ConsoleTheme.fg
        case .droid, .hermes, .pi, .other: return ConsoleTheme.titanium
        }
    }
}

/// The colour a tool's status ring and conversation header carry.
func brandColor(_ tool: AgentTool) -> Color { ConsoleBrand.color(tool) }

/// A tool's mark at `size` (14 by default) on the 20pt icon column. Rows align it
/// to text with `.firstTextBaseline`, so it publishes a baseline of its own.
struct BrandMark: View {
    let tool: AgentTool
    var size: CGFloat = 14

    var body: some View {
        glyph
            .frame(width: size, height: size)
            .frame(width: 20, height: 20)
            .alignmentGuide(.firstTextBaseline) { d in d[.bottom] - 5 }
            .alignmentGuide(.lastTextBaseline) { d in d[.bottom] - 5 }
            .accessibilityLabel(tool.label)
    }

    @ViewBuilder
    private var glyph: some View {
        switch tool {
        case .claude:
            SVGShape(glyph: BrandLogos.claudeCode).fill(ConsoleBrand.claude, style: FillStyle(eoFill: true))
        case .codex:
            // The blossom in paper on the ink chip; its `>_` is the chip showing
            // through, fattened a hair so it reads at 14pt (the logo's strokes are 0.85
            // of 24 — half a point here).
            ZStack {
                RoundedRectangle(cornerRadius: size * 0.22).fill(ConsoleBrand.chip)
                RoundedRectangle(cornerRadius: size * 0.22).stroke(ConsoleTheme.hair, lineWidth: 1)
                SVGShape(glyph: BrandLogos.codexBody).fill(ConsoleBrand.paper).padding(size * 0.1)
                SVGShape(glyph: BrandLogos.codexCuts).fill(ConsoleBrand.chip).padding(size * 0.1)
                SVGShape(glyph: BrandLogos.codexCuts)
                    .stroke(ConsoleBrand.chip, style: StrokeStyle(lineWidth: size * 0.05, lineCap: .round, lineJoin: .round))
                    .padding(size * 0.1)
            }
        case .cursor:
            SVGShape(glyph: BrandLogos.cursor).fill(ConsoleTheme.fg, style: FillStyle(eoFill: true))
        case .gemini:
            SVGShape(glyph: BrandLogos.gemini).fill(ConsoleBrand.gemini)
        case .opencode:
            SVGShape(glyph: BrandLogos.opencode).fill(ConsoleBrand.opencode, style: FillStyle(eoFill: true))
        case .pi:
            SVGShape(glyph: BrandLogos.pi).fill(ConsoleTheme.titanium, style: FillStyle(eoFill: true))
        case .amp:
            AmpBolt().fill(ConsoleBrand.amp)
        case .droid:
            monogram("D")
        case .hermes:
            monogram("H")
        case .other:
            // "Agent" → A: the monogram the spec gives every tool without a mark of its own.
            monogram(String(tool.label.prefix(1)))
        }
    }

    private func monogram(_ letter: String) -> some View {
        Text(letter)
            .font(.system(size: size * 0.9, weight: .semibold, design: .rounded))
            .foregroundStyle(ConsoleTheme.titanium)
    }
}

// MARK: - The logos

/// Path data from theSVG (https://thesvg.org — "the open SVG brand library"; its own
/// code is MIT, https://github.com/GLINCKER/thesvg). Each entry names the SVG it was
/// taken from and the licence theSVG's icon page lists for that logo; the marks are
/// the vendors' trademarks, used here to identify the vendor's tool (nominative use,
/// theSVG's `legal#trademark`). Coordinates are the SVGs' own; `SVGGlyph` fits them.
enum BrandLogos {
    /// Claude Code — https://thesvg.org/icon/claude-code, SVG https://thesvg.org/icons/claude-code/default.svg
    /// (viewBox 0 0 24 24, fill #D97757). Licence listed: MIT — "Claude Code logo © 2026 Claude
    /// Code. Distributed under MIT." Brand: https://code.claude.com
    static let claudeCode = SVGGlyph(
        "M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z",
        evenOdd: true)

    /// Codex — https://thesvg.org/icon/codex, SVG https://thesvg.org/icons/codex/default.svg
    /// (viewBox 0 0 24 24, fill #111, evenodd). Licence listed: brand-use — "Codex logo © 2026
    /// Codex. Distributed under brand-use." (theSVG's trademark policy, https://thesvg.org/legal#trademark).
    /// Brand: https://openai.com/codex/. The one path is split in two so the `>_` can be
    /// drawn in the chip's colour: `codexBody` is its first subpath (the blossom), `codexCuts`
    /// the second and third (the chevron and the underscore), re-based to absolute moves.
    static let codexBody = SVGGlyph(
        "M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457z")
    static let codexCuts = SVGGlyph(
        "M7.282 8.307a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zM12.728 14.547a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z",
        fitBox: codexBody.fitBox)

    /// Cursor — https://thesvg.org/icon/cursor, SVG https://thesvg.org/icons/cursor/default.svg
    /// (viewBox 0 0 466.73 532.09, fill #edecec). Licence listed: CC0-1.0 — "Cursor logo © 2026
    /// Cursor. Distributed under CC0-1.0." Brand: https://www.cursor.com
    static let cursor = SVGGlyph(
        "M457.43,125.94L244.42,2.96c-6.84-3.95-15.28-3.95-22.12,0L9.3,125.94c-5.75,3.32-9.3,9.46-9.3,16.11v247.99c0,6.65,3.55,12.79,9.3,16.11l213.01,122.98c6.84,3.95,15.28,3.95,22.12,0l213.01-122.98c5.75-3.32,9.3-9.46,9.3-16.11v-247.99c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05,151.99l-205.63,356.16c-1.39,2.4-5.06,1.42-5.06-1.36v-233.21c0-4.66-2.49-8.97-6.53-11.31L24.87,145.67c-2.4-1.39-1.42-5.06,1.36-5.06h411.26c5.84,0,9.49,6.33,6.57,11.39h-.01Z",
        evenOdd: true)

    /// Gemini — https://thesvg.org/icon/google-gemini, SVG https://thesvg.org/icons/google-gemini/default.svg
    /// (viewBox 0 0 24 24, fill #8E75B2; drawn here in the Console's Gemini blue). Licence
    /// listed: CC0-1.0 — "Google Gemini logo © 2026 Google Gemini. Distributed under CC0-1.0."
    /// Brand: https://gemini.google.com
    static let gemini = SVGGlyph(
        "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81")

    /// OpenCode — https://thesvg.org/icon/opencode, SVG https://thesvg.org/icons/opencode/default.svg
    /// (viewBox 0 0 24 24, fill currentColor, evenodd). Licence listed: MIT — "opencode logo ©
    /// 2026 opencode. Distributed under MIT." Brand: https://opencode.ai
    static let opencode = SVGGlyph("M16 6H8v12h8V6zm4 16H4V2h16v20z", evenOdd: true)

    /// Pi — https://thesvg.org/icon/pi, SVG https://thesvg.org/icons/pi/default.svg (viewBox
    /// 0 0 800 800, two paths, fill by scheme; drawn here in titanium like the other
    /// monograms). Licence listed: MIT — "Pi logo © 2026 Pi. Distributed under MIT." Brand: https://pi.dev/
    static let pi = SVGGlyph(
        "M165.29 165.29 H517.36 V400 H400 V517.36 H282.65 V634.72 H165.29 Z M282.65 282.65 V400 H400 V282.65 Z",
        "M517.36 400 H634.72 V634.72 H517.36 Z",
        evenOdd: true)

    /// Every logo with its element count and bounds, for the parser check in the
    /// preview harness: a logo that parsed to nothing, or to a box far from its
    /// viewBox, shows up here before it shows up in a rail.
    static var report: [(name: String, elements: Int, bounds: CGRect)] {
        [("claude-code", claudeCode), ("codex-body", codexBody), ("codex-cuts", codexCuts), ("cursor", cursor),
         ("gemini", gemini), ("opencode", opencode), ("pi", pi)].map { name, g in
            var n = 0
            g.path.forEach { _ in n += 1 }
            return (name, n, g.path.boundingRect)
        }
    }
}

// MARK: - SVG path data → Path

/// A parsed SVG `d` attribute (or several sharing one coordinate space): the path
/// in the SVG's own units and the box it is fitted by — its bounds, unless told a
/// `fitBox` (a companion glyph's, so two pieces of one logo land together).
struct SVGGlyph {
    let path: Path
    let fitBox: CGRect
    let evenOdd: Bool

    init(_ paths: String..., fitBox: CGRect? = nil, evenOdd: Bool = false) {
        var p = Path()
        for d in paths { p.addPath(SVGPathParser.path(d)) }
        path = p
        self.fitBox = fitBox ?? p.boundingRect
        self.evenOdd = evenOdd
    }

    /// The path scaled uniformly into `rect` (the fit box's aspect kept) and centred.
    func path(in rect: CGRect) -> Path {
        guard fitBox.width > 0, fitBox.height > 0 else { return Path() }
        let s = min(rect.width / fitBox.width, rect.height / fitBox.height)
        let w = fitBox.width * s, h = fitBox.height * s
        let t = CGAffineTransform(translationX: rect.midX - w / 2 - fitBox.minX * s, y: rect.midY - h / 2 - fitBox.minY * s)
            .scaledBy(x: s, y: s)
        return path.applying(t)
    }
}

/// A glyph as a Shape, for `.fill` / `.stroke`.
struct SVGShape: Shape {
    let glyph: SVGGlyph
    func path(in rect: CGRect) -> Path { glyph.path(in: rect) }
}

/// The SVG path grammar, enough for logos: M/m L/l H/h V/v C/c S/s Q/q T/t A/a Z/z,
/// absolute and relative, implicit repeats (a run of numbers after a command repeats
/// it; after M/m it is L/l), the compact number forms (`4.7-2.6`, `.079-.23`,
/// `1.5.1`, exponents) and arc flags run together (`0 01-3.8`). Elliptical arcs
/// become cubic Béziers a quarter turn at a time. Anything unparsable ends the path
/// where it is rather than guessing.
enum SVGPathParser {
    static func path(_ d: String) -> Path {
        var out = Path()
        var s = Scanner(bytes: Array(d.utf8))
        var cmd: UInt8 = 0
        var cur = CGPoint.zero, start = CGPoint.zero
        /// The last cubic or quadratic control point, for S/T's reflection.
        var ctrl = CGPoint.zero
        /// The last command drawn (lowercased), for whether S/T may reflect.
        var prev: UInt8 = 0
        while true {
            s.skip()
            guard let c = s.peek() else { break }
            if Scanner.isCommand(c) {
                cmd = c
                s.advance()
                if cmd | 0x20 == UInt8(ascii: "z") {
                    out.closeSubpath()
                    cur = start
                    prev = UInt8(ascii: "z")
                    continue
                }
            } else if cmd == 0 {
                break
            }
            let rel = cmd >= UInt8(ascii: "a")
            func at(_ x: Double, _ y: Double) -> CGPoint { rel ? CGPoint(x: cur.x + x, y: cur.y + y) : CGPoint(x: x, y: y) }
            func reflect(_ ok: Bool) -> CGPoint { ok ? CGPoint(x: 2 * cur.x - ctrl.x, y: 2 * cur.y - ctrl.y) : cur }
            let lower = cmd | 0x20
            switch lower {
            case UInt8(ascii: "m"):
                guard let x = s.number(), let y = s.number() else { return out }
                cur = at(x, y); start = cur
                out.move(to: cur)
                // Further pairs are lines.
                cmd = rel ? UInt8(ascii: "l") : UInt8(ascii: "L")
            case UInt8(ascii: "l"):
                guard let x = s.number(), let y = s.number() else { return out }
                cur = at(x, y); out.addLine(to: cur)
            case UInt8(ascii: "h"):
                guard let x = s.number() else { return out }
                cur = CGPoint(x: rel ? cur.x + x : x, y: cur.y); out.addLine(to: cur)
            case UInt8(ascii: "v"):
                guard let y = s.number() else { return out }
                cur = CGPoint(x: cur.x, y: rel ? cur.y + y : y); out.addLine(to: cur)
            case UInt8(ascii: "c"):
                guard let x1 = s.number(), let y1 = s.number(), let x2 = s.number(), let y2 = s.number(), let x = s.number(), let y = s.number() else { return out }
                let c1 = at(x1, y1), c2 = at(x2, y2), end = at(x, y)
                out.addCurve(to: end, control1: c1, control2: c2)
                ctrl = c2; cur = end
            case UInt8(ascii: "s"):
                guard let x2 = s.number(), let y2 = s.number(), let x = s.number(), let y = s.number() else { return out }
                let c1 = reflect(prev == UInt8(ascii: "c") || prev == UInt8(ascii: "s"))
                let c2 = at(x2, y2), end = at(x, y)
                out.addCurve(to: end, control1: c1, control2: c2)
                ctrl = c2; cur = end
            case UInt8(ascii: "q"):
                guard let x1 = s.number(), let y1 = s.number(), let x = s.number(), let y = s.number() else { return out }
                let c1 = at(x1, y1), end = at(x, y)
                out.addQuadCurve(to: end, control: c1)
                ctrl = c1; cur = end
            case UInt8(ascii: "t"):
                guard let x = s.number(), let y = s.number() else { return out }
                let c1 = reflect(prev == UInt8(ascii: "q") || prev == UInt8(ascii: "t"))
                let end = at(x, y)
                out.addQuadCurve(to: end, control: c1)
                ctrl = c1; cur = end
            case UInt8(ascii: "a"):
                guard let rx = s.number(), let ry = s.number(), let rot = s.number(), let large = s.flag(), let sweep = s.flag(),
                      let x = s.number(), let y = s.number() else { return out }
                let end = at(x, y)
                arc(from: cur, to: end, rx: rx, ry: ry, rotationDegrees: rot, largeArc: large, sweep: sweep, into: &out)
                cur = end
            default:
                return out
            }
            prev = lower
        }
        return out
    }

    /// SVG's endpoint arc (F.6.5 of the spec) as centre and angles, then as cubics of
    /// at most a quarter turn each (the usual 4/3·tan(δ/4) handles).
    private static func arc(from p0: CGPoint, to p1: CGPoint, rx rx0: Double, ry ry0: Double, rotationDegrees: Double,
                            largeArc: Bool, sweep: Bool, into path: inout Path) {
        if p0 == p1 { return }
        var rx = abs(rx0), ry = abs(ry0)
        guard rx > 1e-9, ry > 1e-9 else { path.addLine(to: p1); return }
        let phi = rotationDegrees * .pi / 180
        let cosP = cos(phi), sinP = sin(phi)
        let dx2 = Double(p0.x - p1.x) / 2, dy2 = Double(p0.y - p1.y) / 2
        let x1p = cosP * dx2 + sinP * dy2
        let y1p = -sinP * dx2 + cosP * dy2
        let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
        if lambda > 1 { let k = lambda.squareRoot(); rx *= k; ry *= k }
        let sign: Double = largeArc != sweep ? 1 : -1
        let num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
        let den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
        let coef = den > 0 ? sign * max(0, num / den).squareRoot() : 0
        let cxp = coef * (rx * y1p / ry)
        let cyp = coef * -(ry * x1p / rx)
        let cx = cosP * cxp - sinP * cyp + Double(p0.x + p1.x) / 2
        let cy = sinP * cxp + cosP * cyp + Double(p0.y + p1.y) / 2
        func angle(_ ux: Double, _ uy: Double, _ vx: Double, _ vy: Double) -> Double { atan2(ux * vy - uy * vx, ux * vx + uy * vy) }
        let ux = (x1p - cxp) / rx, uy = (y1p - cyp) / ry
        let vx = (-x1p - cxp) / rx, vy = (-y1p - cyp) / ry
        let theta1 = angle(1, 0, ux, uy)
        var delta = angle(ux, uy, vx, vy)
        if !sweep, delta > 0 { delta -= 2 * .pi } else if sweep, delta < 0 { delta += 2 * .pi }
        let segments = max(1, Int(ceil(abs(delta) / (.pi / 2) - 1e-9)))
        let step = delta / Double(segments)
        let handle = 4.0 / 3.0 * tan(step / 4)
        func point(_ t: Double) -> CGPoint {
            let x = rx * cos(t), y = ry * sin(t)
            return CGPoint(x: cosP * x - sinP * y + cx, y: sinP * x + cosP * y + cy)
        }
        func tangent(_ t: Double) -> CGVector {
            let x = -rx * sin(t), y = ry * cos(t)
            return CGVector(dx: cosP * x - sinP * y, dy: sinP * x + cosP * y)
        }
        var a = theta1
        for i in 0..<segments {
            let b = i == segments - 1 ? theta1 + delta : a + step
            let pa = point(a), pb = point(b)
            let ta = tangent(a), tb = tangent(b)
            path.addCurve(to: pb,
                          control1: CGPoint(x: pa.x + handle * ta.dx, y: pa.y + handle * ta.dy),
                          control2: CGPoint(x: pb.x - handle * tb.dx, y: pb.y - handle * tb.dy))
            a = b
        }
    }

    /// Byte-wise tokens of a `d` attribute: commands, numbers, arc flags.
    private struct Scanner {
        let bytes: [UInt8]
        var i = 0

        static func isCommand(_ c: UInt8) -> Bool {
            switch c | 0x20 {
            case UInt8(ascii: "m"), UInt8(ascii: "l"), UInt8(ascii: "h"), UInt8(ascii: "v"), UInt8(ascii: "c"),
                 UInt8(ascii: "s"), UInt8(ascii: "q"), UInt8(ascii: "t"), UInt8(ascii: "a"), UInt8(ascii: "z"):
                return true
            default:
                return false
            }
        }

        private static func isDigit(_ c: UInt8) -> Bool { c >= UInt8(ascii: "0") && c <= UInt8(ascii: "9") }

        func peek() -> UInt8? { i < bytes.count ? bytes[i] : nil }
        mutating func advance() { i += 1 }

        /// Whitespace and commas between tokens.
        mutating func skip() {
            while i < bytes.count {
                switch bytes[i] {
                case 0x20, 0x09, 0x0A, 0x0D, UInt8(ascii: ","): i += 1
                default: return
                }
            }
        }

        /// One number: sign, digits, a fraction, an exponent — the next `.` or sign
        /// starts the next one (`1.5.1`, `4-2`), as SVG allows.
        mutating func number() -> Double? {
            skip()
            let from = i
            if i < bytes.count, bytes[i] == UInt8(ascii: "+") || bytes[i] == UInt8(ascii: "-") { i += 1 }
            var digits = 0
            while i < bytes.count, Self.isDigit(bytes[i]) { i += 1; digits += 1 }
            if i < bytes.count, bytes[i] == UInt8(ascii: ".") {
                i += 1
                while i < bytes.count, Self.isDigit(bytes[i]) { i += 1; digits += 1 }
            }
            guard digits > 0 else { i = from; return nil }
            if i < bytes.count, bytes[i] | 0x20 == UInt8(ascii: "e") {
                var j = i + 1
                if j < bytes.count, bytes[j] == UInt8(ascii: "+") || bytes[j] == UInt8(ascii: "-") { j += 1 }
                if j < bytes.count, Self.isDigit(bytes[j]) {
                    i = j
                    while i < bytes.count, Self.isDigit(bytes[i]) { i += 1 }
                }
            }
            return Double(String(decoding: bytes[from..<i], as: UTF8.self))
        }

        /// An arc flag: a single `0` or `1`, which may be run into its neighbours.
        mutating func flag() -> Bool? {
            skip()
            guard i < bytes.count, bytes[i] == UInt8(ascii: "0") || bytes[i] == UInt8(ascii: "1") else { return nil }
            let on = bytes[i] == UInt8(ascii: "1")
            i += 1
            return on
        }
    }
}

// MARK: - Drawn glyphs (tools without a logo on theSVG)

/// A lightning bolt, drawn: two strokes that jog at the waist. Not SF's
/// `bolt.fill`, which is the stream's Wake glyph. theSVG's `amp` is Google AMP, not
/// Sourcegraph's Amp, so the bolt stays.
private struct AmpBolt: Shape {
    func path(in rect: CGRect) -> Path {
        let s = min(rect.width, rect.height) / 14
        func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: rect.minX + x * s, y: rect.minY + y * s) }
        var p = Path()
        p.move(to: pt(8.4, 0.8))
        p.addLine(to: pt(2.4, 8.0))
        p.addLine(to: pt(6.3, 8.0))
        p.addLine(to: pt(5.4, 13.2))
        p.addLine(to: pt(11.6, 5.9))
        p.addLine(to: pt(7.6, 5.9))
        p.closeSubpath()
        return p
    }
}

/// Jarhead's own mark on the icon column and in the Console's header: the orb — the
/// icon's dithered ramp (`Dither.orbStops`, diagonal, five bands, 1 pt cells: ≈ 14 cells
/// across, the 64 px icon's grain) in a disc carrying the blob's highlight — at 14pt like
/// the tool marks, so Jarhead's conversations sit beside the agents' as siblings. Not a
/// ring (the working status glyph is one) and not an SF Symbol the stream uses for a row
/// kind. One 28×28 px image in `Dither.Cache`, shared by every mark.
struct JarheadMark: View {
    var size: CGFloat = 14

    var body: some View {
        ZStack {
            DitheredGradient(stops: Dither.orbStops, direction: .diagonal, bands: Dither.bands, cellPoints: 1)
                .clipShape(Circle())
            // The highlight the blob wears: a faint paper disc, up and to the left.
            Circle().fill(Color.white.opacity(0.34))
                .frame(width: size * 0.42, height: size * 0.42)
                .offset(x: -size * 0.15, y: -size * 0.17)
        }
        .frame(width: size, height: size)
        .frame(width: 20, height: 20)
        .alignmentGuide(.firstTextBaseline) { d in d[.bottom] - 5 }
        .alignmentGuide(.lastTextBaseline) { d in d[.bottom] - 5 }
        .accessibilityLabel("Jarhead")
    }
}

/// An agent's status on the icon column. Working is the pulsing dot inside a
/// 1pt ring in the tool's colour — the ring says whose work it is. Idle is the
/// plain titanium dot, as `ConsoleStatusGlyph` draws it: ringed, a settled dot
/// reads as a radio button. The other states keep their solid symbol.
struct BrandStatusGlyph: View {
    let status: AgentStatus
    let tool: AgentTool

    var body: some View {
        let meta = ConsoleTheme.status(status)
        // A ZStack, so a status that changes crossfades the glyph it had into the one it gets.
        ZStack {
            if let symbol = meta.symbol {
                ConsoleIcon(name: symbol, tint: meta.color).transition(.opacity)
            } else if meta.live {
                ZStack {
                    Circle().stroke(brandColor(tool), lineWidth: 1).frame(width: 12, height: 12)
                    ConsoleDot(color: meta.color, live: true, size: 6)
                }
                .transition(.opacity)
            } else {
                ConsoleDot(color: meta.color, live: false, size: 6).transition(.opacity)
            }
        }
        .frame(width: 20, height: 20)
        .animation(Motion.fade, value: status)
        .help(status.rawValue)
        .accessibilityLabel(status.rawValue)
    }
}
