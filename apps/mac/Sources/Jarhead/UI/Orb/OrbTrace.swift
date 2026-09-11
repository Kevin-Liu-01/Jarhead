import Foundation
import QuartzCore

/// A stroke the blob draws by hand (`orb.trace`), as the pen walks it: the points
/// (global CG, y down; a closed loop already has its first point appended), the arc
/// length at each vertex, and where the pen is (`s`). Everything the controller needs
/// to lead the body along the line and to publish the line so far.
///
/// The pen cruises at `OrbPanelController.traceSpeed`, eases in over the first
/// `traceEase` points and out over the last, and slows into a corner by how sharp it
/// is (a right angle to about half speed, a hairpin to a third), so the line reads as
/// drawn rather than plotted.
struct TracePath {
    let id: String
    let points: [CGPoint]
    let tone: OverlayTone
    let label: String?
    let ttlMs: Double
    let reason: String?
    /// Arc length at each vertex; `cumulative[i]` is the distance from the start to `points[i]`.
    let cumulative: [Double]
    let length: Double
    /// Which side of the line the pen's body rides (`BlobSim.cursorHand`): the outside
    /// of the stroke's overall turn — +1 for a loop drawn clockwise on screen (the
    /// brain's circles and rectangles, Kevin's marks echoed by the engine) and for a
    /// straight line, −1 for a counter-clockwise one — so the blob never cuts through
    /// what it is drawing round. From the signed area of the polygon the points close.
    let hand: Double
    /// The turn at each vertex (radians, 0 at the ends), for the corner slowdown.
    private let turns: [Double]
    /// The pen's arc length so far.
    var s = 0.0
    var startedAt = 0.0

    /// Points either side of a vertex over which the corner slowdown blends in and out.
    static let cornerReach = 46.0

    init(id: String, points: [CGPoint], tone: OverlayTone, label: String?, ttlMs: Double, reason: String?) {
        self.id = id
        self.points = points
        self.tone = tone
        self.label = (label?.isEmpty == false) ? label : nil
        self.ttlMs = ttlMs
        self.reason = reason
        var cum: [Double] = [0]
        cum.reserveCapacity(points.count)
        for i in 1..<max(1, points.count) {
            cum.append(cum[i - 1] + Double(hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)))
        }
        cumulative = cum
        length = cum.last ?? 0
        // Shoelace sum, y down: positive is clockwise as seen on screen.
        var area = 0.0
        if points.count >= 3 {
            for i in 0..<points.count {
                let a = points[i], b = points[(i + 1) % points.count]
                area += Double(a.x * b.y - b.x * a.y)
            }
        }
        hand = area < 0 ? -1 : 1
        var t = [Double](repeating: 0, count: points.count)
        if points.count >= 3 {
            for i in 1..<(points.count - 1) {
                let a = CGVector(dx: points[i].x - points[i - 1].x, dy: points[i].y - points[i - 1].y)
                let b = CGVector(dx: points[i + 1].x - points[i].x, dy: points[i + 1].y - points[i].y)
                let la = hypot(a.dx, a.dy), lb = hypot(b.dx, b.dy)
                guard la > 0.01, lb > 0.01 else { continue }
                let cosine = max(-1, min(1, (a.dx * b.dx + a.dy * b.dy) / (la * lb)))
                t[i] = acos(cosine)
            }
        }
        turns = t
    }

    /// The segment holding arc length `s` (its start vertex), clamped to the stroke.
    private func segment(at s: Double) -> Int {
        guard points.count >= 2 else { return 0 }
        // Linear scan: strokes are at most a couple of hundred points, once a frame.
        var i = 0
        while i < points.count - 2, cumulative[i + 1] <= s { i += 1 }
        return i
    }

    /// The pen at arc length `s`: the point, the unit direction of travel there, and
    /// the segment it is on (the index of the last vertex passed).
    func sample(at sRaw: Double) -> (CGPoint, CGVector, Int) {
        let s = max(0, min(length, sRaw))
        let i = segment(at: s)
        let a = points[i], b = points[min(points.count - 1, i + 1)]
        let seg = cumulative[min(points.count - 1, i + 1)] - cumulative[i]
        let u = seg > 0.001 ? (s - cumulative[i]) / seg : 0
        let p = CGPoint(x: a.x + (b.x - a.x) * CGFloat(u), y: a.y + (b.y - a.y) * CGFloat(u))
        return (p, direction(at: i), i)
    }

    /// Unit direction of the segment starting at vertex `i` (the last one, for the end).
    func direction(at i: Int) -> CGVector {
        guard points.count >= 2 else { return CGVector(dx: 1, dy: 0) }
        var j = min(max(0, i), points.count - 2)
        // Skip degenerate segments toward the end.
        while j > 0, hypot(points[j + 1].x - points[j].x, points[j + 1].y - points[j].y) < 0.01 { j -= 1 }
        let dx = Double(points[j + 1].x - points[j].x), dy = Double(points[j + 1].y - points[j].y)
        let len = hypot(dx, dy)
        return len > 0.001 ? CGVector(dx: dx / len, dy: dy / len) : CGVector(dx: 1, dy: 0)
    }

    /// The pen's speed (pt/s) at arc length `s`: cruise, eased in and out, slowed
    /// through the corners. Never below a crawl, so the line always advances.
    func speed(at s: Double) -> Double {
        let cruise = OrbPanelController.traceSpeed
        let ease = min(OrbPanelController.traceEase, max(1, length / 3))
        func smooth(_ x: Double) -> Double { let u = min(1, max(0, x)); return u * u * (3 - 2 * u) }
        let easeIn = 0.22 + 0.78 * smooth(s / ease)
        let easeOut = 0.22 + 0.78 * smooth((length - s) / ease)
        var corner = 1.0
        if points.count >= 3 {
            for i in 1..<(points.count - 1) where turns[i] > 0.15 {
                let d = abs(s - cumulative[i])
                guard d < Self.cornerReach else { continue }
                // A right angle halves the speed at the vertex, a hairpin takes two thirds.
                let depth = min(0.66, 0.5 * turns[i] / (.pi / 2))
                let f = 1 - depth * (1 - smooth(d / Self.cornerReach))
                corner = min(corner, f)
            }
        }
        return max(120, cruise * easeIn * easeOut * corner)
    }

    /// The line so far as a `LiveStroke`: the vertices through `upTo`, then the pen
    /// (nil once the stroke is whole). Same id every time; `done` seals it.
    func stroke(upTo: Int, pen: CGPoint?, done: Bool, ttlMs: Double) -> LiveStroke {
        var pts: [Point2] = []
        pts.reserveCapacity(upTo + 2)
        for p in points[0...min(upTo, points.count - 1)] { pts.append(Point2(x: p.x, y: p.y)) }
        if let pen, let last = pts.last, abs(last.x - pen.x) > 0.01 || abs(last.y - pen.y) > 0.01 { pts.append(Point2(x: pen.x, y: pen.y)) }
        return LiveStroke(id: id, points: pts, tone: tone, label: label, done: done, ttlMs: ttlMs)
    }
}
