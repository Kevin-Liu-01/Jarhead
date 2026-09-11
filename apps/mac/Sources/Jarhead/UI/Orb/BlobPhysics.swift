import AppKit
import QuartzCore

// The fluid body: where the blob is, how fast it is going, and what it is pressed
// against. Everything here is in global CoreGraphics space (origin at the top-left
// of the primary display, y down) because that is what CGWindowListCopyWindowInfo
// and the saved `orbPosition` speak; only the panel-frame write converts to AppKit.
//
// Drag: a short spring toward the pointer, so the body lags and stretches like
// liquid, and its velocity is recorded. Release: momentum, friction, bounces off the
// work-area edges of the display it is on (restitution 0.55) and off other windows,
// each impact feeding a squish contact into the renderer. Rest: velocity under a
// threshold → settle, persist.
//
// The squish maths is legacy/packages/app/contacts.js: half-plane walls for the work
// area, closest-point-on-rect for windows, merged and capped at two.

// MARK: - Coordinate spaces

/// Global CoreGraphics points ⇄ AppKit screen points.
enum CGSpace {
    /// The primary display's top edge in AppKit space; CG's origin sits there.
    static var mainMaxY: CGFloat { NSScreen.screens.first?.frame.maxY ?? 0 }

    static func rect(fromAppKit r: NSRect) -> CGRect {
        CGRect(x: r.minX, y: mainMaxY - r.maxY, width: r.width, height: r.height)
    }

    static func point(fromAppKit p: NSPoint) -> CGPoint { CGPoint(x: p.x, y: mainMaxY - p.y) }

    static func appKitOrigin(topLeft p: CGPoint, size: CGSize) -> NSPoint {
        NSPoint(x: p.x, y: mainMaxY - p.y - size.height)
    }

    static func topLeft(ofAppKitFrame f: NSRect) -> CGPoint { CGPoint(x: f.minX, y: mainMaxY - f.maxY) }
}

/// One display, in CG space: its full frame and its work area (minus menu bar and Dock).
struct ScreenArea: Equatable {
    var frame: CGRect
    var work: CGRect

    @MainActor
    static func all() -> [ScreenArea] {
        NSScreen.screens.map { ScreenArea(frame: CGSpace.rect(fromAppKit: $0.frame), work: CGSpace.rect(fromAppKit: $0.visibleFrame)) }
    }

    /// The display whose frame holds the point, else the nearest one.
    static func containing(_ p: CGPoint, in areas: [ScreenArea]) -> ScreenArea? {
        if let hit = areas.first(where: { $0.frame.contains(p) }) { return hit }
        return areas.min { $0.frame.distanceSquared(to: p) < $1.frame.distanceSquared(to: p) }
    }
}

extension CGRect {
    func distanceSquared(to p: CGPoint) -> CGFloat {
        let dx = max(minX - p.x, 0, p.x - maxX)
        let dy = max(minY - p.y, 0, p.y - maxY)
        return dx * dx + dy * dy
    }

    func clamped(_ p: CGPoint) -> CGPoint {
        CGPoint(x: min(max(p.x, minX), maxX), y: min(max(p.y, minY), maxY))
    }
}

// MARK: - Obstacles

/// Another application's window, to squish against and bounce off.
struct Obstacle: Equatable, Sendable {
    let id: UInt32
    let rect: CGRect
}

enum ObstacleScanner {
    /// Windows on the normal layer, big enough to matter, not ours. Bounds come back
    /// without Screen Recording consent (only names need it), so this works everywhere.
    nonisolated static func scan(excludingPID pid: pid_t) -> [Obstacle] {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
            return []
        }
        var out: [Obstacle] = []
        // The list is front to back; a window entirely behind another one is invisible,
        // and bouncing off an edge nobody can see reads as a glitch.
        for w in list {
            guard (w[kCGWindowLayer as String] as? Int) == 0 else { continue }
            guard (w[kCGWindowOwnerPID as String] as? Int32) != pid else { continue }
            if let alpha = w[kCGWindowAlpha as String] as? Double, alpha < 0.05 { continue }
            guard let b = w[kCGWindowBounds as String] as? [String: CGFloat],
                  let x = b["X"], let y = b["Y"], let width = b["Width"], let height = b["Height"] else { continue }
            // Ignore slivers: tooltips and shadows are not worth squishing against.
            guard width >= 140, height >= 100 else { continue }
            let rect = CGRect(x: x, y: y, width: width, height: height)
            if out.contains(where: { $0.rect.contains(rect) }) { continue }
            let id = (w[kCGWindowNumber as String] as? UInt32) ?? 0
            out.append(Obstacle(id: id, rect: rect))
        }
        return out
    }
}

// MARK: - Goal springs

/// How the body flies to a goal. The summon is under-damped and quick: it flies past
/// the point and swings back, splatting on the turn. The drift is the way home after a
/// flight: slower, nearly critically damped, no splat — it settles like a leaf.
struct GoalSpring: Equatable {
    var stiffness: Double
    var damping: Double
    var maxSpeed: Double
    /// Record an impact (a squish) the moment the body starts coming back to the goal.
    var splat: Bool
    /// Parked: within this many points of the goal, slower than this (pt/s) — the body
    /// snaps the rest of the way. Tight for the summon (it is Kevin's cursor); looser
    /// for a flight, so the last few points of the wobble do not eat into the hover.
    var settleDistance: Double
    var settleSpeed: Double

    /// ζ ≈ 0.35: flies past the cursor and swings back. The ceiling is the body's own (`BlobBody.maxSpeed`).
    static let summon = GoalSpring(stiffness: 48, damping: 4.8, maxSpeed: 4500, splat: true, settleDistance: 1.5, settleSpeed: 12)
    /// An `orb.fly`: as quick as the summon but ζ ≈ 0.65, so it lands once — one
    /// overshoot (about 5% of the distance, 48 pt on 860), one squish — and is parked
    /// still about a second after take-off. The summon's ζ 0.35 sailed past by a third
    /// of the trip and squished four times over 1.8 s, which was the whole hover.
    static let flight = GoalSpring(stiffness: 48, damping: 9.0, maxSpeed: 4500, splat: true, settleDistance: 8, settleSpeed: 60)
    /// ζ ≈ 0.8 and a low ceiling, so a long way home is a glide, not a shot.
    static let drift = GoalSpring(stiffness: 14, damping: 6, maxSpeed: 1400, splat: false, settleDistance: 3, settleSpeed: 30)
}

// MARK: - Body

@MainActor
final class BlobBody {
    let size: CGSize
    private(set) var center: CGPoint
    private(set) var velocity = CGVector.zero

    /// The body's collision radius: where the blob's surface visually is, well inside
    /// the panel, so the panel edge can poke past a wall while the glyphs cannot.
    var radius: CGFloat { min(size.width, size.height) * 0.36 }
    var topLeft: CGPoint { CGPoint(x: center.x - size.width / 2, y: center.y - size.height / 2) }

    private(set) var dragging = false
    private var pointer = CGPoint.zero
    private var pointerVel = CGVector.zero
    private var pointerAt = 0.0
    private var grabOffset = CGVector.zero

    private var goal: CGPoint?
    private var goalArmed = false
    private var goalSpring = GoalSpring.summon
    /// `onArrive` has fired for the current goal.
    private var arrived = false
    private var ignoreWindows = false
    /// True while a goal spring is pulling the body somewhere (summon, flight, drift home).
    var hasGoal: Bool { goal != nil }

    private struct Impact { var nx: Double; var ny: Double; var press: Double }
    private var impacts: [Impact] = []

    var obstacles: [Obstacle] = []
    /// Windows the body already overlapped when it was let go: they are not solid until it leaves them.
    private var ignored = Set<UInt32>()

    private(set) var leanX = 0.0
    private(set) var leanY = 0.0
    private(set) var isActive = false
    private(set) var area: ScreenArea?
    private var areas: [ScreenArea] = []

    var onSettle: (() -> Void)?
    /// Called with the impact speed (pt/s) on every bounce.
    var onImpact: ((Double) -> Void)?
    /// Called once per goal flight, the moment the body first turns back toward its
    /// goal: the visible arrival, well before the wobble settles.
    var onArrive: (() -> Void)?

    // Tuning.
    static let restitution = 0.55
    static let windowRestitution = 0.42
    static let friction = 1.4            // 1/s, exponential
    static let decel = 90.0              // pt/s², so it actually stops
    static let maxSpeed = 4500.0
    static let dragStiffness = 380.0
    static let dragDamping = 26.0        // ζ ≈ 0.67: lags and overshoots a little
    static let stopFraction = 0.90       // centre may approach a wall to this × radius in flight
    /// Clear air between the body's surface and an `orb.fly` target (pt).
    static let flyClearance: CGFloat = 36
    static let dragFraction = 0.25       // … and this deep while being pushed by hand
    static let restSpeed = 8.0
    static let reach = 0.82              // contacts.js REACH
    static let edgeSlop: CGFloat = 40    // main.js EDGE_SLOP: "near" an edge, for the lean

    init(size: CGSize, center: CGPoint) {
        self.size = size
        self.center = center
        refreshScreens()
    }

    func refreshScreens() {
        areas = ScreenArea.all()
        area = ScreenArea.containing(center, in: areas)
    }

    // MARK: control

    /// Put the body somewhere with no motion (initial placement, collapse, saved position).
    func teleport(to c: CGPoint) {
        center = c
        velocity = .zero
        goal = nil
        arrived = false
        impacts.removeAll()
        dragging = false
        isActive = false
        refreshScreens()
        updateLean()
    }

    func beginDrag(pointer p: CGPoint) {
        dragging = true
        goal = nil
        arrived = false
        ignoreWindows = false
        pointer = p
        pointerVel = .zero
        pointerAt = CACurrentMediaTime()
        grabOffset = CGVector(dx: center.x - p.x, dy: center.y - p.y)
        isActive = true
        refreshScreens()
    }

    func moveDrag(pointer p: CGPoint) {
        let now = CACurrentMediaTime()
        let dt = now - pointerAt
        if dt > 0.001 {
            let v = CGVector(dx: (p.x - pointer.x) / dt, dy: (p.y - pointer.y) / dt)
            let a = min(1, dt * 18)
            pointerVel = CGVector(dx: pointerVel.dx + (v.dx - pointerVel.dx) * a, dy: pointerVel.dy + (v.dy - pointerVel.dy) * a)
        }
        pointer = p
        pointerAt = now
    }

    /// Let go: keep the momentum. The body already carries the pointer's velocity
    /// through the spring; blending in the raw pointer velocity makes a flick snappier.
    func endDrag() {
        guard dragging else { return }
        dragging = false
        let stale = CACurrentMediaTime() - pointerAt > 0.12   // held still before release
        let pv = stale ? CGVector.zero : pointerVel
        velocity = CGVector(dx: velocity.dx * 0.6 + pv.dx * 0.4, dy: velocity.dy * 0.6 + pv.dy * 0.4)
        capSpeed()
        ignoreTouchingObstacles()
        isActive = true
    }

    /// Throw it.
    func fling(_ v: CGVector) {
        dragging = false
        goal = nil
        arrived = false
        ignoreWindows = false
        velocity = v
        capSpeed()
        ignoreTouchingObstacles()
        isActive = true
        refreshScreens()
    }

    /// Fly to a point (the cursor) with an under-damped spring, so it overshoots and
    /// bounces back. Across displays it first hops to the far side of the target's
    /// display, because the edges between displays may not be passable.
    func summon(to g: CGPoint) { fly(to: g, spring: .summon) }

    /// The way home after a flight: the same path, a gentler spring, no splat.
    func drift(to g: CGPoint) { fly(to: g, spring: .drift) }

    /// Fly to a goal on the given spring. Windows are ignored on the way (the body
    /// passes over them; a flight that bounced off every window would never arrive),
    /// walls are not. A goal already being flown to is simply retargeted mid-air.
    func fly(to g: CGPoint, spring: GoalSpring) {
        dragging = false
        refreshScreens()
        hop(toward: g)
        aim(at: g, spring: spring)
    }

    /// Fly to a spot beside `target` (`landing(for:)`), never onto it. Across displays
    /// the hop comes first, so the spot is ranked against the approach the body will
    /// actually make from where it lands on the far display — ranked from the origin
    /// display, the chosen side could lie right along the real flight line and the
    /// overshoot swept the target. Returns the spot.
    @discardableResult
    func flyBeside(_ target: CGPoint, spring: GoalSpring) -> CGPoint {
        dragging = false
        refreshScreens()
        hop(toward: target)
        let spot = landing(for: target)
        aim(at: spot, spring: spring)
        return spot
    }

    /// A goal on another display (or the body has fallen off its own): jump to a point
    /// 320 pt from the goal toward the middle of that display's work area and fly the
    /// rest, because the seams between displays may not be passable.
    private func hop(toward g: CGPoint) {
        let target = ScreenArea.containing(g, in: areas)
        guard let target, let here = area, target.frame != here.frame || !here.frame.contains(center) else { return }
        let mid = CGPoint(x: target.work.midX, y: target.work.midY)
        var dx = mid.x - g.x, dy = mid.y - g.y
        let len = (dx * dx + dy * dy).squareRoot()
        if len < 1 { dx = -1; dy = 0 } else { dx /= len; dy /= len }
        center = target.work.insetBy(dx: radius, dy: radius).clamped(CGPoint(x: g.x + dx * 320, y: g.y + dy * 320))
        velocity = .zero
        area = target
    }

    private func aim(at g: CGPoint, spring: GoalSpring) {
        goal = g
        goalSpring = spring
        goalArmed = false
        arrived = false
        ignoreWindows = true
        impacts.removeAll()
        isActive = true
    }

    /// Where to park beside an `orb.fly` target so the body never covers it: up-left
    /// of it, `flyClearance` of air between the surface and the point (the centre
    /// sits radius + clearance away).
    ///
    /// A body already parked beside the target stays put: a repeat fly to the same
    /// work (click here, then type here) must not swing it round to another side.
    ///
    /// Otherwise: the flight is a straight spring with an overshoot, so the body sweeps
    /// through the landing spot along its line of flight. A landing spot on that line
    /// — up-left of a target approached from up-left, or from down-right — puts the
    /// target under the sweep. So the spot is chosen among eight directions around
    /// the target (the corners and the sides) by how square it is to the approach:
    /// the more perpendicular, the wider the body passes the point (radius + clearance
    /// at 90°). Up-left keeps its place whenever it is square enough (28 pt of air on
    /// the pass); otherwise the squarest direction wins, ties going to the side the
    /// body is already on, then upward. A spot off the work area (near the display's
    /// edges) is skipped for the next. If none fits, up-left is clamped onto the work
    /// area and the target may be grazed.
    func landing(for target: CGPoint) -> CGPoint {
        refreshScreens()
        guard let s = ScreenArea.containing(target, in: areas) else { return target }
        let stop = radius * CGFloat(Self.stopFraction) + 2
        let room = s.work.insetBy(dx: min(stop, s.work.width / 2), dy: min(stop, s.work.height / 2))
        let reach = Double(radius + Self.flyClearance)
        if isBeside(target), room.contains(center) { return center }
        // Unit direction of travel; already on top of the target: up-left, plainly.
        var ux = Double(target.x - center.x), uy = Double(target.y - center.y)
        let len = (ux * ux + uy * uy).squareRoot()
        if len > 1 { ux /= len; uy /= len } else { ux = 0; uy = 0 }
        let d = 1 / 2.0.squareRoot()
        // Unit offsets from the target, upper ones first so ties fall upward.
        let directions: [(Double, Double)] = [(-d, -d), (0, -1), (d, -d), (-1, 0), (1, 0), (-d, d), (0, 1), (d, d)]
        let ranked = directions.enumerated().sorted { a, b in
            // |cos| between the offset and the flight; up-left is squared off to the
            // front while its own |cos| ≤ 0.4 (sin ≥ 0.92: 28 pt of air on the pass).
            let ca = abs(a.element.0 * ux + a.element.1 * uy), cb = abs(b.element.0 * ux + b.element.1 * uy)
            let sa = a.offset == 0 && ca <= 0.4 ? -1 : ca, sb = b.offset == 0 && cb <= 0.4 ? -1 : cb
            if sa != sb { return sa < sb }
            // Squareness ties (the two sides of the flight line): the side the body is
            // coming from, so it never crosses over the target to park.
            return a.element.0 * -ux + a.element.1 * -uy > b.element.0 * -ux + b.element.1 * -uy
        }
        for (_, dir) in ranked {
            let p = CGPoint(x: target.x + CGFloat(reach * dir.0), y: target.y + CGFloat(reach * dir.1))
            if room.contains(p) { return p }
        }
        return room.clamped(CGPoint(x: target.x - CGFloat(reach * d), y: target.y - CGFloat(reach * d)))
    }

    /// Parked (still) beside the target: about radius + clearance away — from 90% of
    /// it (26 pt of air still) to 160% (close enough to read as "at the work") — and
    /// not moving. What a repeat `orb.fly` to the same spot leaves alone.
    func isBeside(_ target: CGPoint) -> Bool {
        guard speed < 1, !dragging else { return false }
        let reach = Double(radius + Self.flyClearance)
        let off = Double(hypot(center.x - target.x, center.y - target.y))
        return off >= reach * 0.9 && off <= reach * 1.6
    }

    private func capSpeed() {
        let cap = goal != nil && !dragging ? goalSpring.maxSpeed : Self.maxSpeed
        let s = (velocity.dx * velocity.dx + velocity.dy * velocity.dy).squareRoot()
        if s > cap { velocity = CGVector(dx: velocity.dx / s * cap, dy: velocity.dy / s * cap) }
    }

    private func ignoreTouchingObstacles() {
        ignored.removeAll()
        let stop = radius * Self.stopFraction
        for ob in obstacles {
            let (d, _, _) = distance(to: ob.rect)
            if d < stop { ignored.insert(ob.id) }
        }
    }

    // MARK: stepping

    /// Advance the body and return what it is pressed against (for the renderer).
    func step(_ dtRaw: Double) -> [BlobContact] {
        let dt = min(max(dtRaw, 0), 1.0 / 30)
        guard isActive || dragging else { return contacts() }
        if dragging, NSEvent.pressedMouseButtons & 1 == 0 {
            // A missed mouse-up would otherwise glue the body to the pointer forever.
            endDrag()
        }

        area = ScreenArea.containing(center, in: areas)

        if dragging {
            let tx = pointer.x + grabOffset.dx, ty = pointer.y + grabOffset.dy
            let ax = Self.dragStiffness * (tx - center.x) - Self.dragDamping * velocity.dx
            let ay = Self.dragStiffness * (ty - center.y) - Self.dragDamping * velocity.dy
            velocity.dx += ax * dt
            velocity.dy += ay * dt
        } else if let g = goal {
            let ax = goalSpring.stiffness * (g.x - center.x) - goalSpring.damping * velocity.dx
            let ay = goalSpring.stiffness * (g.y - center.y) - goalSpring.damping * velocity.dy
            velocity.dx += ax * dt
            velocity.dy += ay * dt
            // The moment it starts coming back is the landing: splat a little.
            let toward = (g.x - center.x) * velocity.dx + (g.y - center.y) * velocity.dy
            if toward > 0 { goalArmed = true }
            else if goalArmed, toward < 0 {
                goalArmed = false
                let s = speed
                // The splat scales with the swing: the arrival lands hard, the dying
                // wobble barely dents it, a crawl not at all.
                if goalSpring.splat, s > 60 {
                    impacts.append(Impact(nx: -velocity.dx / s, ny: -velocity.dy / s, press: min(0.75, 0.3 + s / 2000)))
                    onImpact?(s)
                }
                if !arrived {
                    arrived = true
                    onArrive?()
                }
            }
        } else {
            let k = exp(-Self.friction * dt)
            velocity.dx *= k
            velocity.dy *= k
            let s = speed
            if s > 0 {
                let ns = max(0, s - Self.decel * dt)
                velocity.dx *= ns / s
                velocity.dy *= ns / s
            }
        }
        capSpeed()

        center.x += velocity.dx * dt
        center.y += velocity.dy * dt

        resolveWalls()
        if !dragging, !ignoreWindows { resolveObstacles() }
        keepOnSomeScreen()

        for i in impacts.indices { impacts[i].press *= exp(-dt / 0.22) }
        impacts.removeAll { $0.press < 0.02 }

        updateLean()

        // Rest.
        if !dragging {
            if let g = goal {
                let near = goalSpring.settleDistance
                if abs(g.x - center.x) < near, abs(g.y - center.y) < near, speed < goalSpring.settleSpeed {
                    center = g
                    settle()
                }
            } else if speed < Self.restSpeed {
                if let back = nearestWorkPoint(), back != center {
                    // Came to rest in a menu bar or Dock strip: slide back onto the work area.
                    goal = back
                    goalArmed = true
                } else {
                    settle()
                }
            }
        }
        return contacts()
    }

    /// How fast the centre is moving, pt/s.
    var speed: Double { (velocity.dx * velocity.dx + velocity.dy * velocity.dy).squareRoot() }

    private func settle() {
        velocity = .zero
        goal = nil
        ignoreWindows = false
        isActive = false
        arrived = false
        onSettle?()
    }

    // MARK: walls

    private struct Wall {
        var nx: Double, ny: Double   // toward free space
        var d: Double                // distance from centre, positive inside
    }

    /// The four work-area walls of the current display. A wall is left out when
    /// another display sits right behind it (Kevin's second display is above the
    /// first), so the body can travel across instead of bouncing off the seam.
    private func walls() -> [Wall] {
        guard let s = area else { return [] }
        var out: [Wall] = []
        let w = s.work, f = s.frame
        func adjacent(_ t: ScreenArea, dx: CGFloat, dy: CGFloat) -> Bool {
            if t.frame == f { return false }
            if dx != 0 {
                let edge = dx < 0 ? f.minX : f.maxX
                let tEdge = dx < 0 ? t.frame.maxX : t.frame.minX
                return abs(tEdge - edge) < 2 && center.y >= t.frame.minY && center.y <= t.frame.maxY
            } else {
                let edge = dy < 0 ? f.minY : f.maxY
                let tEdge = dy < 0 ? t.frame.maxY : t.frame.minY
                return abs(tEdge - edge) < 2 && center.x >= t.frame.minX && center.x <= t.frame.maxX
            }
        }
        if !areas.contains(where: { adjacent($0, dx: -1, dy: 0) }) { out.append(Wall(nx: 1, ny: 0, d: center.x - w.minX)) }
        if !areas.contains(where: { adjacent($0, dx: 1, dy: 0) }) { out.append(Wall(nx: -1, ny: 0, d: w.maxX - center.x)) }
        if !areas.contains(where: { adjacent($0, dx: 0, dy: -1) }) { out.append(Wall(nx: 0, ny: 1, d: center.y - w.minY)) }
        if !areas.contains(where: { adjacent($0, dx: 0, dy: 1) }) { out.append(Wall(nx: 0, ny: -1, d: w.maxY - center.y)) }
        return out
    }

    private func resolveWalls() {
        let stop = Double(radius) * (dragging ? Self.dragFraction : Self.stopFraction)
        for wall in walls() where wall.d < stop {
            let push = stop - wall.d
            center.x += wall.nx * push
            center.y += wall.ny * push
            bounce(nx: wall.nx, ny: wall.ny, restitution: Self.restitution)
        }
    }

    /// Kill or reflect the velocity component into a surface; record the impact.
    private func bounce(nx: Double, ny: Double, restitution: Double) {
        let vn = velocity.dx * nx + velocity.dy * ny
        guard vn < 0 else { return }
        if dragging {
            velocity.dx -= nx * vn
            velocity.dy -= ny * vn
            return
        }
        // Reflect the normal component, scrub a little off the tangential one.
        let tx = velocity.dx - nx * vn, ty = velocity.dy - ny * vn
        velocity.dx = -nx * vn * restitution + tx * 0.92
        velocity.dy = -ny * vn * restitution + ty * 0.92
        let press = min(1.3, 0.35 + (-vn) / 900)
        impacts.append(Impact(nx: nx, ny: ny, press: press))
        onImpact?(-vn)
    }

    // MARK: windows

    /// Distance from the centre to a rect's surface (negative inside), the outward
    /// normal, and whether the centre is inside. Inside, the normal is the nearest wall's.
    private func distance(to rect: CGRect) -> (Double, Double, Double) {
        let inside = rect.contains(center)
        if inside {
            let dl = center.x - rect.minX, dr = rect.maxX - center.x
            let dt = center.y - rect.minY, db = rect.maxY - center.y
            let m = min(dl, dr, dt, db)
            if m == dl { return (-Double(m), -1, 0) }
            if m == dr { return (-Double(m), 1, 0) }
            if m == dt { return (-Double(m), 0, -1) }
            return (-Double(m), 0, 1)
        }
        let p = rect.clamped(center)
        let dx = center.x - p.x, dy = center.y - p.y
        let dist = (dx * dx + dy * dy).squareRoot()
        if dist == 0 { return (0, 0, -1) }
        return (Double(dist), Double(dx / dist), Double(dy / dist))
    }

    private func resolveObstacles() {
        let stop = Double(radius) * Self.stopFraction
        let leave = Double(radius) * 1.05
        for ob in obstacles {
            let (d, nx, ny) = distance(to: ob.rect)
            if ignored.contains(ob.id) {
                if d > leave { ignored.remove(ob.id) }
                continue
            }
            guard d < stop else { continue }
            let push = stop - d
            center.x += nx * push
            center.y += ny * push
            bounce(nx: nx, ny: ny, restitution: Self.windowRestitution)
        }
    }

    // MARK: safety

    /// After the displays change: if the centre is on no display, or has stopped
    /// outside every work area, put it on the nearest work area, motionless. A resting
    /// body is never stepped, so `step()`'s own safety net would not reach it. Returns
    /// true when the body moved.
    @discardableResult
    func rescueOntoScreens() -> Bool {
        refreshScreens()
        let before = center
        keepOnSomeScreen()
        if !dragging, !isActive, let back = nearestWorkPoint() {
            center = back
            velocity = .zero
        }
        if center != before {
            area = ScreenArea.containing(center, in: areas)
            impacts.removeAll()
            goal = nil
            updateLean()
            return true
        }
        return false
    }

    /// The body can never be lost: if its centre is on no display, pull it onto the nearest work area.
    private func keepOnSomeScreen() {
        guard !areas.isEmpty, !areas.contains(where: { $0.frame.contains(center) }) else { return }
        guard let near = ScreenArea.containing(center, in: areas) else { return }
        let inset = near.work.insetBy(dx: radius, dy: radius)
        center = inset.clamped(center)
        velocity = .zero
    }

    /// Where the centre should sit if it has stopped outside every work area (menu bar strip, Dock).
    private func nearestWorkPoint() -> CGPoint? {
        guard let s = area else { return nil }
        if s.work.contains(center) { return nil }
        let stop = radius * CGFloat(Self.stopFraction)
        let inset = s.work.insetBy(dx: min(stop, s.work.width / 2), dy: min(stop, s.work.height / 2))
        return inset.clamped(center)
    }

    private func updateLean() {
        guard let s = area else { leanX = 0; leanY = 0; return }
        let half = size.width / 2
        let w = s.work
        leanX = (w.maxX - (center.x + half) <= Self.edgeSlop ? -1 : 0) + ((center.x - half) - w.minX <= Self.edgeSlop ? 1 : 0)
        leanY = (w.maxY - (center.y + half) <= Self.edgeSlop ? -1 : 0) + ((center.y - half) - w.minY <= Self.edgeSlop ? 1 : 0)
    }

    // MARK: contacts (contacts.js)

    /// Everything the blob is pressed against right now, strongest first, capped at two.
    func contacts() -> [BlobContact] {
        let r = Double(radius)
        var found: [BlobContact] = []

        // Screen edges are hard walls and always press back.
        for wall in walls() where wall.d < r {
            found.append(BlobContact(nx: wall.nx, ny: wall.ny, press: min(1.4, max(0, (r - wall.d) / (r * 0.6)))))
        }

        // Windows squish only while Kevin is pushing; a parked blob overlapping a
        // window should simply sit there.
        if dragging {
            for ob in obstacles {
                let (d, nx, ny) = distance(to: ob.rect)
                if d < 0 {
                    // Inside: flatten against the wall it came in through, deeper means more.
                    found.append(BlobContact(nx: nx, ny: ny, press: min(1.6, 1 + (-d) / r)))
                } else if d > 0, d < r * Self.reach {
                    found.append(BlobContact(nx: nx, ny: ny, press: min(1, (r * Self.reach - d) / r)))
                }
            }
        }

        for i in impacts { found.append(BlobContact(nx: i.nx, ny: i.ny, press: i.press)) }

        found.sort { $0.press > $1.press }

        // Merge near-parallel contacts so two surfaces sharing an edge do not
        // double-squish the same axis.
        var kept: [BlobContact] = []
        for c in found {
            if kept.contains(where: { $0.nx * c.nx + $0.ny * c.ny > 0.85 }) { continue }
            kept.append(c)
            if kept.count == 2 { break }
        }
        return kept
    }

    /// The strongest current press, for the preview harness.
    var maxPress: Double { contacts().map(\.press).max() ?? 0 }
}
