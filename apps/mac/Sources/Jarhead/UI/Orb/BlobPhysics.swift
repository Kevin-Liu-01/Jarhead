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
    private var ignoreWindows = false

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

    // Tuning.
    static let restitution = 0.55
    static let windowRestitution = 0.42
    static let friction = 1.4            // 1/s, exponential
    static let decel = 90.0              // pt/s², so it actually stops
    static let maxSpeed = 4500.0
    static let dragStiffness = 380.0
    static let dragDamping = 26.0        // ζ ≈ 0.67: lags and overshoots a little
    static let goalStiffness = 48.0
    static let goalDamping = 4.8         // ζ ≈ 0.35: flies past the cursor and swings back
    static let stopFraction = 0.90       // centre may approach a wall to this × radius in flight
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
        impacts.removeAll()
        dragging = false
        isActive = false
        refreshScreens()
        updateLean()
    }

    func beginDrag(pointer p: CGPoint) {
        dragging = true
        goal = nil
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
    func summon(to g: CGPoint) {
        dragging = false
        refreshScreens()
        let target = ScreenArea.containing(g, in: areas)
        if let target, let here = area, target.frame != here.frame || !here.frame.contains(center) {
            let mid = CGPoint(x: target.work.midX, y: target.work.midY)
            var dx = mid.x - g.x, dy = mid.y - g.y
            let len = (dx * dx + dy * dy).squareRoot()
            if len < 1 { dx = -1; dy = 0 } else { dx /= len; dy /= len }
            center = target.work.insetBy(dx: radius, dy: radius).clamped(CGPoint(x: g.x + dx * 320, y: g.y + dy * 320))
            velocity = .zero
        }
        goal = g
        goalArmed = false
        ignoreWindows = true
        impacts.removeAll()
        isActive = true
    }

    private func capSpeed() {
        let s = (velocity.dx * velocity.dx + velocity.dy * velocity.dy).squareRoot()
        if s > Self.maxSpeed { velocity = CGVector(dx: velocity.dx / s * Self.maxSpeed, dy: velocity.dy / s * Self.maxSpeed) }
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
            let ax = Self.goalStiffness * (g.x - center.x) - Self.goalDamping * velocity.dx
            let ay = Self.goalStiffness * (g.y - center.y) - Self.goalDamping * velocity.dy
            velocity.dx += ax * dt
            velocity.dy += ay * dt
            // The moment it starts coming back is the landing: splat a little.
            let toward = (g.x - center.x) * velocity.dx + (g.y - center.y) * velocity.dy
            if toward > 0 { goalArmed = true }
            else if goalArmed, toward < 0 {
                goalArmed = false
                let s = speed
                if s > 1 {
                    impacts.append(Impact(nx: -velocity.dx / s, ny: -velocity.dy / s, press: 0.7))
                    onImpact?(s)
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
                if abs(g.x - center.x) < 1.5, abs(g.y - center.y) < 1.5, speed < 12 {
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

    private var speed: Double { (velocity.dx * velocity.dx + velocity.dy * velocity.dy).squareRoot() }

    private func settle() {
        velocity = .zero
        goal = nil
        ignoreWindows = false
        isActive = false
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
