import AppKit
import QuartzCore

// The fluid body: where the blob is, how fast it is going, and what it is pressed
// against. Everything here is in global CoreGraphics space (origin at the top-left
// of the primary display, y down) because that is what CGWindowListCopyWindowInfo
// and the saved `orbPosition` speak; only the panel-frame write converts to AppKit.
//
// Drag: the body is a mass on an under-damped spring toward the grab point (ζ ≈ 0.5),
// so it lags behind the hand, overshoots when the hand stops, and the renderer
// stretches the silhouette along the lag (`lag`, `grab`, `accel` are what it reads).
// Release: momentum, friction, bounces off the work-area edges of the display it is
// on (restitution 0.55) and off other windows, each impact feeding a squish contact
// into the renderer. Rest: velocity under a threshold → settle, persist.
//
// Borders are sticky (`Adhesion`): pressed into an edge by hand past `adhereDepth`,
// let go touching one, or arriving slower than `stickSpeed`, the body sticks; let go
// it sags into a parked dome; dragged along it smears; pulled away it clings until
// `clingLength` of pull, then the patch lets go and it snaps to the hand. A corner
// holds two patches, one per wall. Faster arrivals bounce, the hardest splat first.
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
/// the point and swings back, splatting on the turn. The flight eases in and out: its
/// speed ramps up over `launchRamp`, is capped by how far there is left to go
/// (`decel`: never faster than it can brake from), and the last `Landing.distance`
/// points blend into a stiffer, well-damped catch (`Motion.body`) so it settles once
/// instead of sailing through the spot and being yanked back. The drift is the way
/// home in free mode: slower, nearly critically damped, no splat — it settles like a
/// leaf. The tuck is the approach to the notch (`Motion.approach`): critically damped,
/// capped under the startle speed, and it does not snap onto its goal — the slip that
/// follows starts from wherever it came to rest.
struct GoalSpring: Equatable {
    /// The catch at the end of a flight: the spring the flight blends into over the
    /// last `distance` points, and where the arrival is called.
    struct Landing: Equatable {
        var stiffness: Double
        var damping: Double
        var distance: Double
    }

    var stiffness: Double
    var damping: Double
    var maxSpeed: Double
    /// Record an impact (a squish) the moment the body starts coming back to the goal.
    var splat: Bool
    /// Parked: within this many points of the goal, slower than this (pt/s) — the body
    /// snaps the rest of the way (`snaps`). Tight for the summon (it is Kevin's cursor);
    /// looser for a flight, so the last few points of the wobble do not eat into the hover.
    var settleDistance: Double
    var settleSpeed: Double
    /// Seconds over which the speed cap ramps up from the launch: the ease-in. 0 is the
    /// old shot from a standing start.
    var launchRamp = 0.0
    /// Braking (pt/s²): the speed is also capped at √(2·decel·distance left), so the
    /// body slows into the goal instead of arriving at the cap. Nil: no such cap.
    var decel: Double? = nil
    /// The catch on the last stretch; nil keeps one spring the whole way.
    var landing: Landing? = nil
    /// Settled, the centre is put exactly on the goal. Off for the tuck: the slip that
    /// follows begins from the real centre, so nothing jumps.
    var snaps = true

    /// ζ ≈ 0.35: flies past the cursor and swings back. The ceiling is the body's own (`BlobBody.maxSpeed`).
    static let summon = GoalSpring(stiffness: 48, damping: 4.8, maxSpeed: 4500, splat: true, settleDistance: 1.5, settleSpeed: 12)
    /// An `orb.fly`: as quick as the summon but ζ ≈ 0.65, eased in over `Motion.quick`
    /// and braked at 5000 pt/s² so it arrives at a few hundred pt/s, then caught by
    /// `Motion.body` over the last 70 pt: one small overshoot, one soft squish, parked
    /// well under a second after take-off. (Before: it hit the goal at the 4500 cap and
    /// the spring yanked it back — the slam.)
    static var flight: GoalSpring {
        let catchSpring = Motion.body
        return GoalSpring(stiffness: 48, damping: 9.0, maxSpeed: 4500, splat: true, settleDistance: 8, settleSpeed: 60,
                          launchRamp: Motion.seconds(Motion.quick), decel: 5000,
                          landing: Landing(stiffness: catchSpring.stiffness, damping: catchSpring.damping, distance: 70))
    }
    /// ζ ≈ 0.8 and a low ceiling, so a long way home is a glide, not a shot; braked
    /// gently so a long glide eases onto the perch rather than overshooting it, and
    /// caught by `Motion.body` over the last 50 pt so it settles instead of crawling
    /// the last few points for most of a second.
    static var drift: GoalSpring {
        let catchSpring = Motion.body
        return GoalSpring(stiffness: 14, damping: 6, maxSpeed: 1400, splat: false, settleDistance: 3, settleSpeed: 30,
                          launchRamp: Motion.seconds(Motion.base), decel: 2600,
                          landing: Landing(stiffness: catchSpring.stiffness, damping: catchSpring.damping, distance: 50))
    }
    /// The approach to the notch (`Motion.approach`): critically damped, so it
    /// decelerates to rest under the ink with no swing back; eased in over
    /// `Motion.base` so a sleepy blob is not jolted off its spot; capped well under
    /// `BlobSim`'s flick threshold (a startled `O O` past ~1200 pt/s), so the sleepy
    /// `- -` survives the whole way to bed. It settles loosely and without snapping:
    /// the controller's slip carries the last stretch from wherever it stopped.
    static var tuck: GoalSpring {
        let a = Motion.approach
        return GoalSpring(stiffness: a.stiffness, damping: a.damping, maxSpeed: 760, splat: false, settleDistance: 7, settleSpeed: 90,
                          launchRamp: Motion.seconds(Motion.base), snaps: false)
    }
}

// MARK: - Body

@MainActor
final class BlobBody {
    let size: CGSize
    private(set) var center: CGPoint
    private(set) var velocity = CGVector.zero
    /// The last finite centre: where the body comes back to when a step, a place or a
    /// goal hands it a number that is not one (`BadNumber`). A NaN in the body would
    /// otherwise be forever — every spring and wall test inherits it — and the panel
    /// would be asked for a frame at (nan, nan).
    private var lastGoodCenter: CGPoint

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
    /// Seconds since the flight was launched (the launch ramp); a retarget keeps it.
    private var goalAge = 0.0
    /// A retarget mid-flight blends the goal from where it was over `retargetBlend`
    /// instead of snapping the spring to the new point: nil when the goal was set from
    /// rest. `blendAge` is the seconds into that blend.
    private var goalFrom: CGPoint?
    private var blendAge = 0.0
    static let retargetBlend = Motion.quick
    private var ignoreWindows = false
    /// True while a goal spring is pulling the body somewhere (summon, flight, drift home).
    var hasGoal: Bool { goal != nil }
    /// Led by the controller (a trace: the pen decides where the body is, frame by
    /// frame); `step` integrates nothing and no wall or window pushes back, the
    /// contacts still report. Any other motion — a teleport, a drag, a fling, a goal —
    /// takes the lead back.
    private(set) var guided = false

    private struct Impact { var nx: Double; var ny: Double; var press: Double }
    private var impacts: [Impact] = []

    /// What the body is glued to. Adhesion begins when the body is pressed into a
    /// surface — by hand past `adhereDepth`, let go while touching a wall, or by
    /// arriving slower than `stickSpeed` — and holds the centre `restDepth` from it.
    /// Pressed deeper by hand it re-sticks deeper; let go, `restDepth` sags to
    /// `stuckDepth` and the body parks there (the settled dome, which `contacts()`
    /// keeps reporting at rest). Pulled away by hand it clings: `clingStiffness`
    /// drags the centre back per point of pull while the patch stays on the surface
    /// and `neck` (0…1) says how far it has stretched; past `clingLength` the patch
    /// lets go (`onSnap`) and the drag spring, no longer fought, throws the body to
    /// the hand — the recoil. Let go mid-cling, the stuck spot is re-pinned where the
    /// hand left the centre and sags back onto the patch, the neck shrinking with it.
    /// One adhesion per surface, at most `maxAdhesions` (a corner's two walls).
    /// Windows stick only while the hand is on the body: a parked blob overlapping a
    /// window simply sits there.
    private struct Adhesion {
        enum Surface: Equatable { case wall(nx: Double, ny: Double); case window(UInt32) }
        var surface: Surface
        var nx: Double, ny: Double
        /// Distance (pt) from the centre to the surface at the patch: the stuck spot.
        var restDepth: Double
        /// 0 flat on the surface … 1 about to let go.
        var neck = 0.0
    }
    private var adhesions: [Adhesion] = []
    private func adhesion(to surface: Adhesion.Surface) -> Adhesion? { adhesions.first { $0.surface == surface } }
    /// Surfaces the body can be glued to at once: a corner's two walls.
    static let maxAdhesions = 2

    var obstacles: [Obstacle] = []
    /// Windows the body already overlapped when it was let go: they are not solid until it leaves them.
    private var ignored = Set<UInt32>()

    private(set) var leanX = 0.0
    private(set) var leanY = 0.0
    private(set) var isActive = false
    private(set) var area: ScreenArea?
    private var areas: [ScreenArea] = []

    /// The drag's lag: grab target minus centre (pt); zero when not dragging. The
    /// renderer stretches the silhouette along it.
    private(set) var lag = CGVector.zero
    /// Last step's acceleration (pt/s²), wall impulses included: what rings the renderer's wobble.
    private(set) var accel = CGVector.zero
    /// Where the hand holds the body, relative to the centre (pt); nil when not dragging.
    var grab: CGVector? { dragging ? CGVector(dx: -grabOffset.dx, dy: -grabOffset.dy) : nil }
    /// The preview harness drags with no real button held; the missed-mouse-up guard must not end it.
    var syntheticDrag = false
    /// How far the patch has been pulled (0 not clinging … 1 about to let go); the most-pulled of a corner's two.
    var neck: Double { adhesions.map(\.neck).max() ?? 0 }
    var isStuck: Bool { !adhesions.isEmpty }
    /// How many surfaces the body is glued to (a corner: two).
    var stuckCount: Int { adhesions.count }

    var onSettle: (() -> Void)?
    /// Called with the impact speed (pt/s) on every bounce, and on a slow arrival that sticks.
    var onImpact: ((Double) -> Void)?
    /// Called once per goal flight, the moment the body first turns back toward its
    /// goal: the visible arrival, well before the wobble settles.
    var onArrive: (() -> Void)?
    /// The patch let go of a surface: (nx, ny) is the surface's outward normal.
    var onSnap: ((Double, Double) -> Void)?
    /// A bounce hard enough to splat first, with the impact speed (pt/s).
    var onSplat: ((Double) -> Void)?

    // Tuning.
    static let restitution = 0.55
    static let windowRestitution = 0.42
    static let friction = 1.4            // 1/s, exponential
    static let decel = 90.0              // pt/s², so it actually stops
    static let maxSpeed = 4500.0
    /// The drag spring. ζ = c / 2√k ≈ 0.49: the body trails the hand by c/k ≈ 57 ms of
    /// its speed (a slow 300 pt/s pull lags 17 pt, a 1200 pt/s sweep 68 pt — most of a
    /// radius, which is the teardrop), overshoots once when the hand stops, and rings
    /// at √k/2π ≈ 2.8 Hz. Was 380/26 (ζ 0.67, 68 ms): a stiff follow with no visible lag.
    static let dragStiffness = 300.0
    static let dragDamping = 17.0
    static let stopFraction = 0.90       // centre may approach a wall to this × radius in flight
    /// Clear air between the body's surface and an `orb.fly` target (pt).
    static let flyClearance: CGFloat = 36
    static let dragFraction = 0.25       // … and this deep while being pushed by hand
    static let restSpeed = 8.0
    static let reach = 0.82              // contacts.js REACH
    static let edgeSlop: CGFloat = 40    // main.js EDGE_SLOP: "near" an edge, for the lean

    // Sticky borders (see `Adhesion`).
    /// Arriving at a wall slower than this (pt/s along the normal) sticks instead of bouncing.
    static let stickSpeed = 420.0
    /// A bounce faster than this splats first (`onSplat`): the renderer's one-frame dense burst.
    static let splatSpeed = 1300.0
    /// Where a released stick's centre settles, × radius: the dome's depth (press ≈ 0.63 in `contacts()`).
    static let stuckDepth = 0.62
    /// Seconds for a released stick to sag from where the hand left it to `stuckDepth`.
    static let stickRelaxTau = 0.35
    /// Points of pull from the stuck spot before the patch lets go — the neck's full
    /// length: two thirds of a radius, so the body visibly leaves the wall (its
    /// surface clears the edge after ~22 pt) and a neck has room to be seen before
    /// the snap. The hand travels about 1.8× this (see `clingStiffness`): ~70 pt.
    static let clingLength = 40.0
    /// The adhesion spring, pt/s² per point of pull. Against the drag spring (300) it
    /// holds the body back to about 55% of the hand's lead until the snap.
    static let clingStiffness = 230.0
    /// Pressed this deep by hand (× radius) the body sticks to a wall or window — a
    /// firm push, well short of the `dragFraction` stop the hand can shove it to.
    static let adhereDepth = 0.72
    /// Tangential velocity kept when a slow arrival sticks: the surface scrubs the rest.
    static let stickFriction = 0.55
    /// A fling gentler than this (pt/s) — a poke's hop — leaves a stuck body stuck;
    /// let go moving away from a wall faster than this, it is a flick, not a park.
    static let unstickSpeed = 300.0

    init(size: CGSize, center: CGPoint) {
        self.size = size
        self.center = center.isFinitePoint ? center : .zero
        lastGoodCenter = self.center
        refreshScreens()
    }

    /// `c` when it is a point, else the last good centre (logged once per site).
    private func finiteOrLastGood(_ c: CGPoint, _ site: String) -> CGPoint {
        guard c.isFinitePoint else { BadNumber.noteOnce(site, "\(c)"); return lastGoodCenter }
        lastGoodCenter = c
        return c
    }

    /// The body back at its last good centre, motionless, holding nothing.
    private func resetToLastGood() {
        center = lastGoodCenter
        velocity = .zero
        lag = .zero
        accel = .zero
        goal = nil
        goalFrom = nil
        arrived = false
        impacts.removeAll()
        adhesions.removeAll()
        dragging = false
        guided = false
        isActive = false
        area = ScreenArea.containing(center, in: areas)
        updateLean()
    }

    func refreshScreens() {
        areas = ScreenArea.all()
        area = ScreenArea.containing(center, in: areas)
    }

    // MARK: control

    /// Put the body somewhere with no motion (initial placement, collapse, saved position).
    func teleport(to c: CGPoint) {
        center = finiteOrLastGood(c, "BlobBody.teleport")
        velocity = .zero
        lag = .zero
        accel = .zero
        goal = nil
        goalFrom = nil
        arrived = false
        impacts.removeAll()
        adhesions.removeAll()
        dragging = false
        guided = false
        isActive = false
        refreshScreens()
        updateLean()
    }

    /// Put the still body at a point this frame — the controller's slip into and out
    /// of the notch places it every frame — without re-reading the displays or
    /// touching anything else: a teleport's cheap sibling.
    func place(at c: CGPoint) {
        center = finiteOrLastGood(c, "BlobBody.place")
        velocity = .zero
        lag = .zero
        accel = .zero
        goal = nil
        goalFrom = nil
        isActive = false
        area = ScreenArea.containing(center, in: areas)
        updateLean()
    }

    /// Put the body where the pen wants it this frame, moving at `v` (pt/s, for the
    /// renderer's stretch and wobble), and keep it awake so the display link runs at
    /// full rate. Walls, windows and adhesion are out of the picture until the lead
    /// is taken back; the last goal and any grip are dropped.
    func lead(to c: CGPoint, velocity v: CGVector) {
        if !guided {
            guided = true
            dragging = false
            goal = nil
            arrived = false
            lag = .zero
            impacts.removeAll()
            adhesions.removeAll()
            ignoreWindows = true
        }
        center = finiteOrLastGood(c, "BlobBody.lead")
        if v.isFiniteVector { velocity = v } else { BadNumber.noteOnce("BlobBody.lead velocity", "\(v)"); velocity = .zero }
        isActive = true
    }

    func beginDrag(pointer p: CGPoint) {
        guard p.isFinitePoint else { BadNumber.noteOnce("BlobBody.beginDrag", "\(p)"); return }
        dragging = true
        guided = false
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
        guard p.isFinitePoint else { BadNumber.noteOnce("BlobBody.moveDrag", "\(p)"); return }
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
    /// Stuck to a wall it stays stuck and sags into its dome from wherever the hand
    /// left it (flicked away faster than `unstickSpeed`, the patch tears off instead);
    /// merely touching a wall it sticks, as a slow arrival would; a window lets go of
    /// it, since a released blob never squishes into windows.
    func endDrag() {
        guard dragging else { return }
        dragging = false
        lag = .zero
        let stale = CACurrentMediaTime() - pointerAt > 0.12   // held still before release
        let pv = stale ? CGVector.zero : pointerVel
        velocity = CGVector(dx: velocity.dx * 0.6 + pv.dx * 0.4, dy: velocity.dy * 0.6 + pv.dy * 0.4)
        capSpeed()
        let r = Double(radius)
        var kept: [Adhesion] = []
        for var a in adhesions {
            guard case .wall = a.surface, let (d, nx, ny) = surfaceDistance(a.surface) else { continue }
            let vn = velocity.dx * nx + velocity.dy * ny
            if a.neck > 0, vn > Self.unstickSpeed {
                onSnap?(nx, ny)
                continue
            }
            // Re-pin the stuck spot where the centre is: `cling` sags it (and the neck)
            // back to the dome instead of `resolveWalls` writing the pull back in one step.
            a.restDepth = max(d, r * Self.dragFraction)
            kept.append(a)
        }
        adhesions = kept
        for wall in walls() where adhesions.count < Self.maxAdhesions && wall.d < r * Self.stopFraction {
            let surface = Adhesion.Surface.wall(nx: wall.nx, ny: wall.ny)
            guard adhesion(to: surface) == nil else { continue }
            let vn = velocity.dx * wall.nx + velocity.dy * wall.ny
            guard vn < Self.unstickSpeed else { continue }
            stick(to: surface, nx: wall.nx, ny: wall.ny, depth: wall.d)
        }
        ignoreTouchingObstacles()
        isActive = true
    }

    /// Come to rest here after a flight ("stay where you worked"): the goal and the lead
    /// are dropped, the velocity with them, and any wall the surface is touching takes
    /// the body the way a slow arrival does — it sticks, and sags into the parked dome
    /// over the next few frames (so it stays active until that settles). A body touching
    /// nothing is at rest at once.
    func park() {
        dragging = false
        guided = false
        goal = nil
        arrived = false
        velocity = .zero
        lag = .zero
        accel = .zero
        ignoreWindows = false
        impacts.removeAll()
        refreshScreens()
        let r = Double(radius)
        for wall in walls() where adhesions.count < Self.maxAdhesions && wall.d < r * Self.stopFraction + 1 {
            let surface = Adhesion.Surface.wall(nx: wall.nx, ny: wall.ny)
            guard adhesion(to: surface) == nil else { continue }
            stick(to: surface, nx: wall.nx, ny: wall.ny, depth: wall.d)
        }
        ignoreTouchingObstacles()
        isActive = !adhesions.isEmpty
        updateLean()
    }

    /// Throw it. A hard throw tears a stuck body off its wall; a poke's hop leaves it stuck.
    func fling(_ v: CGVector) {
        guard v.isFiniteVector else { BadNumber.noteOnce("BlobBody.fling", "\(v)"); return }
        dragging = false
        guided = false
        lag = .zero
        goal = nil
        arrived = false
        ignoreWindows = false
        velocity = v
        if (v.dx * v.dx + v.dy * v.dy).squareRoot() > Self.unstickSpeed { adhesions.removeAll() }
        capSpeed()
        ignoreTouchingObstacles()
        isActive = true
        refreshScreens()
    }

    /// Fly to a point (the cursor) with an under-damped spring, so it overshoots and
    /// bounces back. Across displays it flies straight when the seam is crossable, and
    /// hops first (`hop`) when a straight line would leave every screen.
    func summon(to g: CGPoint) { fly(to: g, spring: .summon) }

    /// The way home: the same path, a gentler spring, no splat — `.drift` to the perch,
    /// `.tuck` up into the notch.
    func drift(to g: CGPoint, spring: GoalSpring = .drift) { fly(to: g, spring: spring) }

    /// Fly to a goal on the given spring. Windows are ignored on the way (the body
    /// passes over them; a flight that bounced off every window would never arrive),
    /// walls are not. A goal already being flown to is simply retargeted mid-air.
    func fly(to g: CGPoint, spring: GoalSpring) {
        guard g.isFinitePoint else { BadNumber.noteOnce("BlobBody.fly", "\(g)"); return }
        dragging = false
        refreshScreens()
        hop(toward: g)
        aim(at: g, spring: spring)
    }

    /// Fly to a spot beside `target` (`landing(for:)`), never onto it. Across displays
    /// any hop comes first, so the spot is ranked against the approach the body will
    /// actually make from where it lands on the far display — ranked from the origin
    /// display, the chosen side could lie right along the real flight line and the
    /// overshoot swept the target. `avoiding` is where the other blobs sit (the fleet
    /// passes the main body and the other satellites); an empty list is the main
    /// blob's path, unchanged. Returns the spot.
    @discardableResult
    func flyBeside(_ target: CGPoint, spring: GoalSpring, avoiding: [CGRect] = []) -> CGPoint {
        dragging = false
        refreshScreens()
        hop(toward: target)
        let spot = landing(for: target, avoiding: avoiding)
        aim(at: spot, spring: spring)
        return spot
    }

    /// A goal on another display (or the body has fallen off its own). When a straight
    /// line from here to the goal stays on the displays — the two touch along the seam
    /// the line crosses (Kevin's second display sits right above the first) — the body
    /// flies it, one flight across both, and `walls()` lets it through the seam. Only
    /// when the line would leave every screen (displays that do not touch, a corner, a
    /// gap) does it jump to a point 320 pt from the goal toward the middle of that
    /// display's work area and fly the rest.
    private func hop(toward g: CGPoint) {
        let target = ScreenArea.containing(g, in: areas)
        guard let target, let here = area, target.frame != here.frame || !here.frame.contains(center) else { return }
        if here.frame.contains(center), straightPathStaysOnScreens(to: g) { return }
        let mid = CGPoint(x: target.work.midX, y: target.work.midY)
        var dx = mid.x - g.x, dy = mid.y - g.y
        let len = (dx * dx + dy * dy).squareRoot()
        if len < 1 { dx = -1; dy = 0 } else { dx /= len; dy /= len }
        center = target.work.insetBy(dx: radius, dy: radius).clamped(CGPoint(x: g.x + dx * 320, y: g.y + dy * 320))
        velocity = .zero
        area = target
    }

    /// Every point of the segment from the centre to `g`, sampled a few cells apart,
    /// lies on some display's frame (the menu bar and Dock strips count: only the
    /// frame matters for passing through). A hairline of slack absorbs the rounding
    /// at a seam where two frames meet edge to edge.
    private func straightPathStaysOnScreens(to g: CGPoint) -> Bool {
        let dx = g.x - center.x, dy = g.y - center.y
        let steps = max(1, Int((hypot(dx, dy) / 24).rounded(.up)))
        for i in 0...steps {
            let t = CGFloat(i) / CGFloat(steps)
            let p = CGPoint(x: center.x + dx * t, y: center.y + dy * t)
            if !areas.contains(where: { $0.frame.insetBy(dx: -1, dy: -1).contains(p) }) { return false }
        }
        return true
    }

    /// Arm the goal spring. A retarget mid-flight — a goal already armed on a body
    /// still moving — keeps the launch ramp where it is and blends the goal over from
    /// the old point (`retargetBlend`), so the spring's pull swings round instead of
    /// snapping to the new heading.
    private func aim(at g: CGPoint, spring: GoalSpring) {
        guided = false
        let retarget = goal != nil && isActive && !dragging
        if retarget, let old = goal, hypot(old.x - g.x, old.y - g.y) > 1 {
            goalFrom = blendedGoal() ?? old
            blendAge = 0
        } else {
            goalFrom = nil
            if !retarget { goalAge = 0 }
        }
        goal = g
        goalSpring = spring
        goalArmed = false
        arrived = false
        ignoreWindows = true
        impacts.removeAll()
        adhesions.removeAll()
        lag = .zero
        isActive = true
    }

    /// The goal the spring pulls toward this frame: the retarget blend's in-between point, else the goal.
    private func blendedGoal() -> CGPoint? {
        guard let g = goal else { return nil }
        guard let from = goalFrom else { return g }
        let u = min(1, blendAge / Self.retargetBlend)
        let k = u * u * (3 - 2 * u)
        return CGPoint(x: from.x + (g.x - from.x) * k, y: from.y + (g.y - from.y) * k)
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
    ///
    /// `avoiding`: the other blobs' body rects. A spot whose body (radius + `avoidPad`)
    /// would overlap one is skipped for the next direction, so two satellites flown to
    /// one point land on two sides of it; only when every direction is taken or off the
    /// work area does the chooser fall back to the plain ranking. Empty (the main blob),
    /// the choice is exactly what it was before the fleet.
    func landing(for target: CGPoint, avoiding occupied: [CGRect] = []) -> CGPoint {
        refreshScreens()
        guard let s = ScreenArea.containing(target, in: areas) else { return target }
        let stop = radius * CGFloat(Self.stopFraction) + 2
        let room = s.work.insetBy(dx: min(stop, s.work.width / 2), dy: min(stop, s.work.height / 2))
        let reach = Double(radius + Self.flyClearance)
        let pad = radius + Self.avoidPad
        func free(_ p: CGPoint) -> Bool {
            let mine = CGRect(x: p.x - pad, y: p.y - pad, width: 2 * pad, height: 2 * pad)
            return !occupied.contains { $0.intersects(mine) }
        }
        if isBeside(target), room.contains(center), free(center) { lastLandingNote = "already beside"; return center }
        // Unit direction of travel; already on top of the target: up-left, plainly.
        var ux = Double(target.x - center.x), uy = Double(target.y - center.y)
        let len = (ux * ux + uy * uy).squareRoot()
        if len > 1 { ux /= len; uy /= len } else { ux = 0; uy = 0 }
        let d = 1 / 2.0.squareRoot()
        // Unit offsets from the target, upper ones first so ties fall upward.
        let directions: [(Double, Double)] = [(-d, -d), (0, -1), (d, -d), (-1, 0), (1, 0), (-d, d), (0, 1), (d, d)]
        let names = ["up-left", "up", "up-right", "left", "right", "down-left", "down", "down-right"]
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
        var taken: [String] = []
        for (i, dir) in ranked {
            let p = CGPoint(x: target.x + CGFloat(reach * dir.0), y: target.y + CGFloat(reach * dir.1))
            guard room.contains(p) else { continue }
            if !free(p) { taken.append(names[i]); continue }
            lastLandingNote = taken.isEmpty ? names[i] : "\(taken.joined(separator: ", ")) occupied → \(names[i])"
            return p
        }
        // Every free direction is off the work area: the plain ranking, as before the fleet.
        for (i, dir) in ranked {
            let p = CGPoint(x: target.x + CGFloat(reach * dir.0), y: target.y + CGFloat(reach * dir.1))
            if room.contains(p) { lastLandingNote = "\(names[i]) (every side taken)"; return p }
        }
        lastLandingNote = "clamped up-left"
        return room.clamped(CGPoint(x: target.x - CGFloat(reach * d), y: target.y - CGFloat(reach * d)))
    }

    /// Air kept between a landing body and another blob's body (pt), over the radius.
    static let avoidPad: CGFloat = 6
    /// Which direction the last `landing(for:avoiding:)` chose and what it stepped
    /// round ("up-left occupied → up"), for the preview harness.
    private(set) var lastLandingNote = ""

    /// Parked (still) beside the target: about radius + clearance away — from 90% of
    /// it (26 pt of air still) to 160% (close enough to read as "at the work") — and
    /// not moving. What a repeat `orb.fly` to the same spot leaves alone.
    func isBeside(_ target: CGPoint) -> Bool {
        guard speed < 1, !dragging else { return false }
        let reach = Double(radius + Self.flyClearance)
        let off = Double(hypot(center.x - target.x, center.y - target.y))
        return off >= reach * 0.9 && off <= reach * 1.6
    }

    /// The speed ceiling this frame: the body's own, or a goal spring's — ramped up from
    /// the launch (`launchRamp`: the ease-in) and, with `decel`, never more than the
    /// body could brake from over the distance left (the ease-out).
    private func capSpeed() {
        var cap = Self.maxSpeed
        if goal != nil, !dragging {
            cap = goalSpring.maxSpeed
            if goalSpring.launchRamp > 0 {
                let u = min(1, goalAge / goalSpring.launchRamp)
                cap *= 0.12 + 0.88 * u * u * (3 - 2 * u)
            }
            if let a = goalSpring.decel, let g = blendedGoal() {
                let d = Double(hypot(g.x - center.x, g.y - center.y))
                cap = min(cap, max(90, (2 * a * d).squareRoot()))
            }
        }
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
        guard dtRaw.isFinite else { BadNumber.noteOnce("BlobBody.step dt", "\(dtRaw)"); return contacts() }
        let dt = min(max(dtRaw, 0), 1.0 / 30)
        guard isActive || dragging else { return contacts() }
        if guided {
            // Led: the controller already placed the body and set its velocity this
            // frame. Only the bookkeeping the renderer reads — which display, the lean.
            area = ScreenArea.containing(center, in: areas)
            accel = .zero
            updateLean()
            return contacts()
        }
        if dragging, !syntheticDrag, NSEvent.pressedMouseButtons & 1 == 0 {
            // A missed mouse-up would otherwise glue the body to the pointer forever.
            endDrag()
        }

        area = ScreenArea.containing(center, in: areas)
        let v0 = velocity

        if dragging {
            let tx = pointer.x + grabOffset.dx, ty = pointer.y + grabOffset.dy
            lag = CGVector(dx: tx - center.x, dy: ty - center.y)
            let ax = Self.dragStiffness * lag.dx - Self.dragDamping * velocity.dx
            let ay = Self.dragStiffness * lag.dy - Self.dragDamping * velocity.dy
            velocity.dx += ax * dt
            velocity.dy += ay * dt
        } else if goal != nil, let g = blendedGoal() {
            goalAge += dt
            blendAge += dt
            let dx = g.x - center.x, dy = g.y - center.y
            let dist = (dx * dx + dy * dy).squareRoot()
            // The catch: over the last `landing.distance` points the flight spring blends
            // into the landing spring (Motion.body), so the acceleration turns over
            // smoothly rather than switching.
            var k = goalSpring.stiffness, c = goalSpring.damping
            if let land = goalSpring.landing, dist < land.distance {
                let u = dist / land.distance
                let w = u * u * (3 - 2 * u)
                k = land.stiffness + (goalSpring.stiffness - land.stiffness) * w
                c = land.damping + (goalSpring.damping - land.damping) * w
            }
            let ax = k * dx - c * velocity.dx
            let ay = k * dy - c * velocity.dy
            velocity.dx += ax * dt
            velocity.dy += ay * dt
            let toward = dx * velocity.dx + dy * velocity.dy
            if toward > 0 { goalArmed = true }
            if let land = goalSpring.landing, !arrived, dist < land.distance, toward > 0 {
                // Entering the catch, still on the way in: the visible arrival. One
                // soft squish, scaled by how fast it came in — the braking cap keeps
                // that to a few hundred pt/s, so this is a settle, not a slam.
                arrived = true
                let s = speed
                if goalSpring.splat, s > 60 {
                    impacts.append(Impact(nx: -velocity.dx / s, ny: -velocity.dy / s, press: min(0.55, 0.16 + s / 3000)))
                    onImpact?(s)
                }
                onArrive?()
            } else if goalArmed, toward < 0 {
                // The moment it starts coming back is the landing (the summon's swing
                // past the cursor; a flight's small overshoot): splat a little.
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
        cling(dt)
        capSpeed()

        center.x += velocity.dx * dt
        center.y += velocity.dy * dt
        // One bad number and the body is back at its last good place, still, holding
        // nothing; the controller syncs the panel to it as on any frame.
        guard center.isFinitePoint, velocity.isFiniteVector else {
            BadNumber.noteOnce("BlobBody.step", "centre \(center) velocity \(velocity) goal \(goal.map { "\($0)" } ?? "none") dragging \(dragging)")
            resetToLastGood()
            return contacts()
        }

        resolveWalls()
        if !dragging, !ignoreWindows { resolveObstacles() }
        if dragging { adhereToObstacles() }
        keepOnSomeScreen()
        lastGoodCenter = center
        if dt > 0 { accel = CGVector(dx: (velocity.dx - v0.dx) / dt, dy: (velocity.dy - v0.dy) / dt) }

        for i in impacts.indices { impacts[i].press *= exp(-dt / 0.22) }
        impacts.removeAll { $0.press < 0.02 }

        updateLean()

        // Rest.
        if !dragging {
            if let g = goal {
                let near = goalSpring.settleDistance
                if abs(g.x - center.x) < near, abs(g.y - center.y) < near, speed < goalSpring.settleSpeed {
                    if goalSpring.snaps { center = g }
                    settle()
                }
            } else if speed < Self.restSpeed, domeSettled {
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

    /// A released stick is still sagging toward its dome: not at rest yet.
    private var domeSettled: Bool {
        adhesions.allSatisfy { abs($0.restDepth - Double(radius) * Self.stuckDepth) < 0.6 && $0.neck == 0 }
    }

    private func settle() {
        velocity = .zero
        lag = .zero
        accel = .zero
        goal = nil
        goalFrom = nil
        ignoreWindows = false
        isActive = false
        arrived = false
        onSettle?()
    }

    // MARK: adhesion

    /// Distance from the centre to an adhered surface and its outward normal; nil when
    /// the surface is gone (a display or window went away).
    private func surfaceDistance(_ s: Adhesion.Surface) -> (Double, Double, Double)? {
        switch s {
        case .wall(let nx, let ny):
            guard let w = walls().first(where: { $0.nx == nx && $0.ny == ny }) else { return nil }
            return (w.d, w.nx, w.ny)
        case .window(let id):
            guard let ob = obstacles.first(where: { $0.id == id }) else { return nil }
            return distance(to: ob.rect)
        }
    }

    /// Glue the body to a surface, its centre `depth` from it (never shallower than
    /// the hand's stop). A surface it is already glued to is re-pinned; a third
    /// surface is ignored.
    private func stick(to surface: Adhesion.Surface, nx: Double, ny: Double, depth: Double) {
        let a = Adhesion(surface: surface, nx: nx, ny: ny, restDepth: max(depth, Double(radius) * Self.dragFraction))
        if let i = adhesions.firstIndex(where: { $0.surface == surface }) { adhesions[i] = a; return }
        guard adhesions.count < Self.maxAdhesions else { return }
        adhesions.append(a)
    }

    /// The adhesion springs, run before the move. By hand: pulled off its stuck spot
    /// the body is dragged back in proportion to the pull and the neck grows; past
    /// `clingLength` the patch lets go (`onSnap`) — the recoil is the drag spring's,
    /// suddenly unopposed. Pressed deeper instead, it re-sticks deeper. Let go: the
    /// stuck spot sags to `stuckDepth` (the dome) and `resolveWalls` holds the centre
    /// there, so a body released mid-cling is drawn back over `stickRelaxTau`; the
    /// neck it was left with shrinks with the pull that is left, and never grows.
    private func cling(_ dt: Double) {
        guard !adhesions.isEmpty else { return }
        let r = Double(radius)
        var kept: [Adhesion] = []
        for var a in adhesions {
            guard let (d, nx, ny) = surfaceDistance(a.surface) else { continue }
            a.nx = nx
            a.ny = ny
            if dragging {
                let pull = d - a.restDepth
                if pull > 0 {
                    a.neck = pull / Self.clingLength
                    if a.neck >= 1 {
                        onSnap?(nx, ny)
                        continue
                    }
                    velocity.dx -= nx * Self.clingStiffness * pull * dt
                    velocity.dy -= ny * Self.clingStiffness * pull * dt
                } else {
                    a.neck = 0
                    a.restDepth = max(d, r * Self.dragFraction)
                }
            } else {
                let want = r * Self.stuckDepth
                a.restDepth += (want - a.restDepth) * (1 - exp(-dt / Self.stickRelaxTau))
                a.neck = max(0, min(a.neck, (d - want) / Self.clingLength))
            }
            kept.append(a)
        }
        adhesions = kept
    }

    /// By hand, pressed into a window past `adhereDepth`: stuck to it (patch, smear,
    /// cling) for as long as the hand stays on the body. One window at a time.
    private func adhereToObstacles() {
        guard adhesions.count < Self.maxAdhesions,
              !adhesions.contains(where: { if case .window = $0.surface { return true } else { return false } }) else { return }
        let deep = Double(radius) * Self.adhereDepth
        for ob in obstacles {
            let (d, nx, ny) = distance(to: ob.rect)
            if d < deep { stick(to: .window(ob.id), nx: nx, ny: ny, depth: d); return }
        }
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
        let r = Double(radius)
        let stop = r * (dragging ? Self.dragFraction : Self.stopFraction)
        for wall in walls() {
            let surface = Adhesion.Surface.wall(nx: wall.nx, ny: wall.ny)
            if let a = adhesion(to: surface) {
                if dragging {
                    // The hand may press it in as far as ever; `cling` handles the pull.
                    guard wall.d < stop else { continue }
                    let push = stop - wall.d
                    center.x += wall.nx * push
                    center.y += wall.ny * push
                    bounce(nx: wall.nx, ny: wall.ny, restitution: Self.restitution)
                } else {
                    // Parked on its patch: held exactly `restDepth` from the wall, no
                    // motion along the normal, so the dome sags in place as that eases.
                    let push = a.restDepth - wall.d
                    center.x += wall.nx * push
                    center.y += wall.ny * push
                    let vn = velocity.dx * wall.nx + velocity.dy * wall.ny
                    velocity.dx -= wall.nx * vn
                    velocity.dy -= wall.ny * vn
                }
                continue
            }
            if dragging, wall.d < r * Self.adhereDepth {
                // Pushed in by hand past `adhereDepth`: stuck where it is. (`cling`
                // follows the hand deeper, and holds it back when it pulls away.)
                // Checked before the stop below, which the hand reaches only by
                // shoving the centre almost onto the edge.
                stick(to: surface, nx: wall.nx, ny: wall.ny, depth: max(wall.d, stop))
            }
            guard wall.d < stop else { continue }
            let push = stop - wall.d
            center.x += wall.nx * push
            center.y += wall.ny * push
            if dragging {
                bounce(nx: wall.nx, ny: wall.ny, restitution: Self.restitution)
                continue
            }
            let vn = velocity.dx * wall.nx + velocity.dy * wall.ny
            if goal == nil, vn < 0, -vn < Self.stickSpeed {
                // Slow enough that the surface takes it: no bounce, the tangential
                // motion mostly scrubbed, and the stuck spot starts at the stop and
                // sags in from there (`cling`) — sucked onto the edge.
                let tx = velocity.dx - wall.nx * vn, ty = velocity.dy - wall.ny * vn
                velocity.dx = tx * Self.stickFriction
                velocity.dy = ty * Self.stickFriction
                stick(to: surface, nx: wall.nx, ny: wall.ny, depth: stop)
                impacts.append(Impact(nx: wall.nx, ny: wall.ny, press: min(0.6, 0.2 + (-vn) / 1200)))
                onImpact?(-vn)
                continue
            }
            bounce(nx: wall.nx, ny: wall.ny, restitution: Self.restitution)
        }
    }

    /// Kill or reflect the velocity component into a surface; record the impact. The
    /// hardest hits splat first (`onSplat`).
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
        if -vn > Self.splatSpeed { onSplat?(-vn) }
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
            adhesions.removeAll()
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

    /// Everything the blob is pressed against right now, strongest first, capped at
    /// two. A surface's contact carries the real distance from the centre to it, so
    /// the renderer can put its flat face and the neck's foot on the true edge. An
    /// adhered surface's contact carries the stick: `stuck`, the `neck` while
    /// clinging (its press held at the patch's, since the patch is still on the
    /// surface however far the body has been pulled), and the tangential speed for the
    /// renderer's smear.
    func contacts() -> [BlobContact] {
        let r = Double(radius)
        var found: [BlobContact] = []
        func stickInfo(_ c: inout BlobContact, _ surface: Adhesion.Surface, d: Double) {
            guard let a = adhesion(to: surface) else { return }
            c.stuck = true
            c.neck = a.neck
            if a.neck > 0 { c.press = max(c.press, min(1.4, (r - a.restDepth) / (r * 0.6))) }
            c.smear = velocity.dx * -c.ny + velocity.dy * c.nx
        }

        // Screen edges are hard walls and always press back.
        for wall in walls() {
            let surface = Adhesion.Surface.wall(nx: wall.nx, ny: wall.ny)
            guard wall.d < r || adhesion(to: surface) != nil else { continue }
            var c = BlobContact(nx: wall.nx, ny: wall.ny, press: min(1.4, max(0, (r - wall.d) / (r * 0.6))), distance: wall.d)
            stickInfo(&c, surface, d: wall.d)
            found.append(c)
        }

        // Windows squish only while Kevin is pushing; a parked blob overlapping a
        // window should simply sit there.
        if dragging {
            for ob in obstacles {
                let (d, nx, ny) = distance(to: ob.rect)
                var c: BlobContact
                if d < 0 {
                    // Inside: flatten against the wall it came in through, deeper means more.
                    c = BlobContact(nx: nx, ny: ny, press: min(1.6, 1 + (-d) / r), distance: d)
                } else if d < r * Self.reach || adhesion(to: .window(ob.id)) != nil {
                    c = BlobContact(nx: nx, ny: ny, press: min(1, max(0, (r * Self.reach - d) / r)), distance: d)
                } else { continue }
                stickInfo(&c, .window(ob.id), d: d)
                found.append(c)
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
