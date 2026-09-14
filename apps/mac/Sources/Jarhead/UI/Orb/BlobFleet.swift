import AppKit
import Combine
import QuartzCore

// The fleet: one satellite (`SatelliteBlob`) per live spawned thread, at most three,
// keyed by the thread's id. It is driven by the thread records the app holds — the
// snapshot's `threads` list by default, AppState's event-fed table once the Console's
// model carries one (`observe(threads:)`) — never by reconciling the whole snapshot:
// a list that has not changed costs one array compare.
//
// What the fleet owns that a satellite cannot: the ONE display link every satellite
// is stepped from (60 while any body moves, 10–24 otherwise, paused when nothing
// wants a frame — made from the orb panel's screen, never a force-unwrapped
// `NSScreen.main`), the budget ladder (`FleetBudget`: the mean cost of a fleet frame
// decides how much each satellite may spend), the pool of three panels reused across
// threads, where a satellite goes when nothing told it (a rank slot beside the main
// blob, or its app's front window), the landing that avoids every other blob, the
// z-order (every satellite just under the main orb, newest highest), the tagged
// `orb.fly` / `orb.trace` routed by thread id (a fly for a thread not yet seen waits
// two seconds), the notch's dots, and the retirement of every satellite at once when
// Jarhead goes to sleep or a Stop is pressed.
//
// Safety: a satellite's drop into the notch is `thread.stop` for that thread — exactly
// one, never `sleep`; nothing here writes settings or `orbPosition`; no thread ever
// opens a session. The main blob's untagged path is the controller's, unchanged.

/// One live spawned thread as the notch draws it: a 5 pt square in the thread's phase
/// colour beside the counter, and "Name · word · m:ss" on the open island's third row.
struct ThreadDot: Equatable {
    let id: String
    let name: String
    let tone: RGB
    let status: ThreadStatus
    /// When it started, seconds since 1970 (the record's `startedAt` / 1000).
    let since: Double
}

@MainActor
public final class BlobFleet: NSObject {
    /// Satellites on screen at once (main + 3 = THREAD_MAX_LIVE). At budget rung 4, two.
    public static let maxSatellites = 3
    /// A satellite body's collision radius: 0.36 of its 120 pt panel.
    static let satelliteRadius: CGFloat = min(BlobMetrics.satellitePanelSize.width, BlobMetrics.satellitePanelSize.height) * 0.36
    /// The obstacle id the main body wears in a satellite's list (the fleet's ids are 0xfffe_….).
    static let mainObstacleId: UInt32 = 0xfffe_ffff

    public let state: AppState
    private let orb: OrbPanelController

    /// Thread id → its satellite (O(1)); the names, for the harness and the menu; the start order (z and rank).
    private(set) var satellites: [String: SatelliteBlob] = [:]
    private var byName: [String: String] = [:]
    private var order: [String] = []
    /// Satellites fading out: still stepped, their panels not yet back in the pool.
    private var leaving: [String: SatelliteBlob] = [:]
    /// Panels not in use. Three are made over a fleet's life and reused (BlobTrail's ghost ring, the same idea).
    private var panelPool: [SatellitePanel] = []
    private(set) var panelsMade = 0
    /// A tagged fly for a thread whose record has not arrived yet (the snapshot is
    /// debounced 50 ms; an overlay frame is not), or one Kevin is dragging: kept 2 s.
    private struct PendingFly { var target: CGPoint; var dwellMs: Double?; var expires: Double }
    private var pendingFlies: [String: PendingFly] = [:]
    /// Ids whose satellite has left (done, failed, stopped, a Stop, a sleep): the record
    /// lingers in the snapshot for THREAD_LINGER_MS, and nothing respawns it.
    private var finished: Set<String> = []
    /// The last acting point and app seen per thread, to notice a change.
    private var lastAt: [String: Point2] = [:]
    private var lastApp: [String: String] = [:]
    /// The live spawned threads as last applied (the dots are derived from these), and
    /// the whole list, re-applied when a panel comes back for a thread that waited for one.
    private var live: [WorkThread] = []
    private var lastThreads: [WorkThread] = []
    private var dots: [ThreadDot] = []

    // The one link.
    private var link: CADisplayLink?
    private var linkRate = 0.0
    private var lastTick = 0.0
    private var idleSince = -1.0
    private var lastObstacleRefresh = 0.0
    /// The main body moved last frame: its settle is the moment a covered satellite steps aside.
    private var mainWasMoving = false
    private(set) var budget = FleetBudget()
    private var lastBudgetLine = 0.0
    private let budgetLog: Bool
    /// Synthetic ms added to every frame's measured cost (ORB_FLEET_BUDGET_FORCE_MS): the harness steps the ladder with it.
    var forcedMs = 0.0

    private var cancellables = Set<AnyCancellable>()
    private var threadsSource: AnyCancellable?
    private var observers: [NSObjectProtocol] = []

    /// A satellite was clicked (or its menu's Console chosen): the app opens that thread in the Console.
    public var onOpenThread: (String) -> Void = { _ in }
    /// Print for the preview harness (nil in the app; the budget line goes to NSLog then).
    public var log: ((String) -> Void)?

    public init(state: AppState, orb: OrbPanelController) {
        self.state = state
        self.orb = orb
        let env = ProcessInfo.processInfo.environment
        budgetLog = env["ORB_FLEET_BUDGET_LOG"] == "1"
        super.init()
        orb.fleet = self

        // The records, from the snapshot until a richer source is handed in (`observe`).
        observe(threads: state.$snapshot.map(\.threads).removeDuplicates().eraseToAnyPublisher())

        // Tagged flies and traces (the untagged ones are the main controller's).
        state.overlayCommands
            .receive(on: DispatchQueue.main)
            .sink { [weak self] cmd in _ = self?.route(cmd) }
            .store(in: &cancellables)

        // Jarhead going dormant (asleep, error) stops every thread at the engine
        // (`fallAsleep` → stopAll); the satellites go at once, not after the linger.
        state.$snapshot
            .map(\.phase)
            .removeDuplicates()
            .sink { [weak self] phase in
                guard let self, OrbPanelController.dormantPhases.contains(phase), !self.satellites.isEmpty else { return }
                self.retireAll(reason: phase.rawValue)
            }
            .store(in: &cancellables)

        let nc = NotificationCenter.default
        // A Stop pressed anywhere in the app cuts every thread: the satellites shiver and leave.
        observers.append(nc.addObserver(forName: OrbPanelController.stopPressedNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.stopPressed() }
        })
        observers.append(nc.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.screensDidChange() }
        })
        observers.append(nc.addObserver(forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                let reduced = Motion.reduced
                for s in self.satellites.values { s.sim.reducedMotion = reduced }
            }
        })
    }

    deinit {
        for o in observers { NotificationCenter.default.removeObserver(o) }
    }

    /// Where the thread records come from. The snapshot's list by default; the app
    /// hands in AppState's event-fed table (`thread.event` + `snapshot.threads`) once
    /// the Console's model carries one, so a status or an acting point arrives without
    /// a snapshot. Replaces the previous source.
    public func observe(threads publisher: AnyPublisher<[WorkThread], Never>) {
        threadsSource = publisher.sink { [weak self] threads in
            MainActor.assumeIsolated { self?.apply(threads: threads) }
        }
    }

    // MARK: - The records

    /// The thread list changed: a new live spawned thread gets a satellite (while
    /// there is room), a changed one a new face, an acting point a flight, an app a
    /// window to park by; a finished one holds its last face and leaves (the satellite
    /// times that itself); one gone from the list leaves quietly. O(n) over ≤ 16 records.
    public func apply(threads: [WorkThread]) {
        let now = CACurrentMediaTime()
        lastThreads = threads
        var seen = Set<String>()
        var liveNow: [WorkThread] = []
        for t in threads where t.id != OrbPanelController.mainThreadId {
            seen.insert(t.id)
            // A dot for every live thread the fleet has not retired — and for a finished
            // one while its satellite still holds its last face (the dot leaves with it).
            if t.status.isLive ? !finished.contains(t.id) : (satellites[t.id].map { !$0.retiring } ?? false) { liveNow.append(t) }
            if let s = satellites[t.id] {
                s.apply(thread: t)
                if !t.status.isLive { finished.insert(t.id) }
                if let at = t.at, lastAt[t.id] != at {
                    lastAt[t.id] = at
                    if s.body.dragging {
                        keepFly(id: t.id, PendingFly(target: CGPoint(x: at.x, y: at.y), dwellMs: nil, expires: now + Self.pendingFlySeconds))
                    } else {
                        s.fly(to: CGPoint(x: at.x, y: at.y), dwellMs: nil, avoiding: occupied(excluding: t.id))
                    }
                } else if let app = t.app, lastApp[t.id] != app {
                    lastApp[t.id] = app
                    if s.lastActingPoint == nil { locateAndPark(s, app: app) }
                }
            } else if t.status.isLive, !finished.contains(t.id), leaving[t.id] == nil {
                // Past the cap (or the budget's rung 4) a thread is a notch dot only; so is
                // one whose panel is still fading out under a finished thread — it waits
                // for that panel (`onRetired` re-applies the list), never a fourth.
                if satellites.count < effectiveMax, let panel = takePanel() { spawn(t, panel: panel, now: now) }
            }
        }
        // Gone from the list (a rebuild after an engine restart, a disconnect): leave quietly.
        for id in Array(satellites.keys) where !seen.contains(id) {
            satellites[id]?.retire()
        }
        finished = finished.intersection(seen)
        lastAt = lastAt.filter { seen.contains($0.key) }
        lastApp = lastApp.filter { seen.contains($0.key) }
        pendingFlies = pendingFlies.filter { $0.value.expires > now }
        live = liveNow
        refreshDots()
    }

    /// The cap this moment: three, or two at the budget's last rung.
    private var effectiveMax: Int { budget.rung >= FleetBudget.maxRung ? 2 : Self.maxSatellites }

    /// A panel from the pool, or a new one while fewer than `maxSatellites` exist; nil
    /// when all three are in use (a leaving satellite's counts until its fade is done).
    private func takePanel() -> SatellitePanel? {
        if let reused = panelPool.popLast() { return reused }
        guard panelsMade < Self.maxSatellites else { return nil }
        panelsMade += 1
        return SatellitePanel(size: SatelliteBlob.panelSize)
    }

    private func spawn(_ t: WorkThread, panel: SatellitePanel, now: Double) {
        let s = SatelliteBlob(thread: t, panel: panel)
        s.log = log
        s.occupied = { [weak self, weak s] in self?.occupied(excluding: s?.id) ?? [] }
        s.catchZone = { [weak self] in self?.orb.notchGeometryCurrent.map { NotchGeometry.catchZoneCG($0) } }
        s.onWake = { [weak self] in self?.wake() }
        s.onStatusChanged = { [weak self] in self?.refreshDots() }
        s.onClick = { [weak self] id in self?.onOpenThread(id) }
        s.onStop = { [weak self] id in self?.stopThread(id) }
        s.onDropInDock = { [weak self] id in self?.droppedInDock(id) }
        s.onLeaving = { [weak self, weak s] in
            guard let self, let s else { return }
            self.satellites.removeValue(forKey: s.id)
            self.byName = self.byName.filter { $0.value != s.id }
            self.order.removeAll { $0 == s.id }
            self.leaving[s.id] = s
            self.finished.insert(s.id)
            self.live.removeAll { $0.id == s.id }
            self.refreshDots()
        }
        s.onRetired = { [weak self, weak s] in
            guard let self, let s else { return }
            self.leaving.removeValue(forKey: s.id)
            self.panelPool.append(s.panel)
            self.log?("fleet: \(s.thread.name) gone; \(self.satellites.count) satellites, pool \(self.panelPool.count)")
            // A thread that waited for this panel gets it now.
            let waiting = self.lastThreads.contains { $0.id != OrbPanelController.mainThreadId && $0.status.isLive && self.satellites[$0.id] == nil && !self.finished.contains($0.id) }
            if waiting { self.apply(threads: self.lastThreads) }
        }
        satellites[t.id] = s
        byName[t.name.lowercased()] = t.id
        order.append(t.id)
        if t.status.isLive == false { finished.insert(t.id) }

        // Where it appears: a rank slot beside the anchor — then off to its work, if it has any.
        let slot = rankSlot(for: order.count - 1, excluding: t.id)
        s.spawn(at: slot, reducedMotion: Motion.reduced)
        mainCameForward()
        if let p = pendingFlies.removeValue(forKey: t.id), p.expires > now {
            log?("fleet: \(t.name) takes the fly kept for it")
            s.fly(to: p.target, dwellMs: p.dwellMs, avoiding: occupied(excluding: t.id))
        } else if let at = t.at {
            lastAt[t.id] = at
            s.fly(to: CGPoint(x: at.x, y: at.y), dwellMs: nil, avoiding: occupied(excluding: t.id))
        } else if let app = t.app {
            lastApp[t.id] = app
            locateAndPark(s, app: app)
        }
        wake()
        log?("fleet: \(t.name) spawned (\(satellites.count) satellites, pool \(panelPool.count), made \(panelsMade))")
    }

    /// A rank slot beside the anchor (the main body when it is out, the row under the
    /// notch while tucked): up-left, up, up-right — the first that overlaps no other
    /// blob, clamped onto the work area. Before anything is placed: the main display's
    /// upper left.
    private func rankSlot(for index: Int, excluding id: String) -> CGPoint {
        let r = Self.satelliteRadius
        guard let anchor = orb.fleetAnchorCG else {
            let work = ScreenArea.all().first?.work ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
            return CGPoint(x: work.minX + 120 + CGFloat(index) * 100, y: work.minY + 120)
        }
        let taken = occupied(excluding: id)
        var first: CGPoint?
        for k in 0..<SatelliteRank.angles.count {
            let p = clampToWork(SatelliteRank.slot(index + k, anchor: anchor.point, anchorRadius: anchor.radius, satRadius: r, below: anchor.below), radius: r)
            let pad = r + BlobBody.avoidPad
            let mine = CGRect(x: p.x - pad, y: p.y - pad, width: 2 * pad, height: 2 * pad)
            if !taken.contains(where: { $0.intersects(mine) }) { return p }
            if first == nil { first = p }
        }
        return first ?? anchor.point
    }

    private func clampToWork(_ p: CGPoint, radius: CGFloat) -> CGPoint {
        let areas = ScreenArea.all()
        guard let s = ScreenArea.containing(p, in: areas) else { return p }
        let stop = radius * CGFloat(BlobBody.stopFraction) + 2
        return s.work.insetBy(dx: min(stop, s.work.width / 2), dy: min(stop, s.work.height / 2)).clamped(p)
    }

    /// A background thread named its app: park by that app's front window, read off
    /// the main thread. Nothing flies when the app has no window on screen (the rank
    /// slot stands). ORB_NO_WINDOWS=1 in the harness: no lookup, deterministic shots.
    private func locateAndPark(_ s: SatelliteBlob, app: String) {
        #if JARHEAD_ORB_PREVIEW
        if ProcessInfo.processInfo.environment["ORB_NO_WINDOWS"] == "1" {
            log?("fleet: \(s.thread.name) names \(app); no window lookup under ORB_NO_WINDOWS — it keeps its rank slot")
            return
        }
        #endif
        let id = s.id
        // The window list is read off the main thread; `self` is only touched back on it.
        Task { @MainActor [weak self] in
            let rect = await Task.detached(priority: .userInitiated) { WindowLocator.frontWindowRect(ownerName: app) }.value
            guard let self, let s = self.satellites[id] else { return }
            guard let rect else { self.log?("fleet: \(s.thread.name): no window for \(app); it keeps its rank slot"); return }
            guard s.lastActingPoint == nil, !s.body.dragging else { return }
            s.park(beside: rect, app: app, avoiding: self.occupied(excluding: id))
        }
    }

    // MARK: - Commands

    /// A tagged `orb.fly` / `orb.trace` (the thread id its hands act for): that
    /// satellite flies beside the point; a trace's shape is stamped on the overlay
    /// untagged (satellites do not draw by hand). A tag for a thread not yet seen is
    /// kept 2 s for its spawn; one Kevin is dragging waits for his hand. Untagged (or
    /// tagged "main") commands are the main controller's: false.
    @discardableResult
    public func route(_ cmd: OverlayCommand) -> Bool {
        let now = CACurrentMediaTime()
        switch cmd {
        case .orbFly(let x, let y, let dwellMs, _, .some(let id)) where id != OrbPanelController.mainThreadId:
            deliverFly(id: id, target: CGPoint(x: x, y: y), dwellMs: dwellMs, now: now)
            return true
        case .orbTrace(let points, let closed, let label, let ttlMs, let tone, _, .some(let id)) where id != OrbPanelController.mainThreadId:
            if let first = points.first {
                deliverFly(id: id, target: CGPoint(x: first.x, y: first.y), dwellMs: 1500, now: now)
            }
            // The shape itself, whole, on the overlay (OverlayManager stamps `.stroke`,
            // which has no `closed`: a closed shape carries its first point again at the
            // end, so a show_rect keeps its fourth side).
            let pts = closed && points.count > 2 ? points + [points[0]] : points
            let state = self.state
            DispatchQueue.main.async { state.overlayCommands.send(.stroke(points: pts, label: label, ttlMs: ttlMs, tone: tone)) }
            log?("fleet: trace for \(id): \(pts.count) points stamped\(closed ? " (closed)" : "")")
            return true
        default:
            return false
        }
    }

    private func deliverFly(id: String, target: CGPoint, dwellMs: Double?, now: Double) {
        if let s = satellites[id], !s.body.dragging {
            s.fly(to: target, dwellMs: dwellMs, avoiding: occupied(excluding: id))
        } else if !finished.contains(id) {
            keepFly(id: id, PendingFly(target: target, dwellMs: dwellMs, expires: now + Self.pendingFlySeconds))
            log?("fleet: fly for \(id) kept 2 s (\(satellites[id] == nil ? "no satellite yet" : "in Kevin's hand"))")
        }
    }

    /// How long a fly for a thread not yet seen (or in Kevin's hand) waits.
    static let pendingFlySeconds = 2.0

    /// Keep a fly, and drop it on its own clock: a thread that never appears must not
    /// leave its fly behind until the next record happens to arrive.
    private func keepFly(id: String, _ fly: PendingFly) {
        pendingFlies[id] = fly
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.pendingFlySeconds + 0.05) { [weak self] in
            MainActor.assumeIsolated { self?.prunePendingFlies() }
        }
    }

    private func prunePendingFlies() {
        let now = CACurrentMediaTime()
        for (id, fly) in pendingFlies where fly.expires <= now {
            pendingFlies.removeValue(forKey: id)
            log?("fleet: fly for \(id) dropped (no thread in 2 s)")
        }
    }

    /// Dropped into the notch: that thread's stop — one `thread.stop`, never a sleep,
    /// never a settings write — and the satellite leaves after its shiver.
    private func droppedInDock(_ id: String) {
        guard let s = satellites[id] else { return }
        state.send(.threadStop(threadId: id))
        finished.insert(id)
        log?("fleet: \(s.thread.name) dropped into the dock -> thread.stop")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
            MainActor.assumeIsolated { self?.satellites[id]?.retire() }
        }
    }

    /// The menu's Stop <Name>: the command only; the engine's `stopped` brings the `- -` and the leave.
    private func stopThread(_ id: String) {
        state.send(.threadStop(threadId: id))
        log?("fleet: stop \(satellites[id]?.thread.name ?? id) -> thread.stop")
    }

    /// A Stop pressed in the app (the transport's: everything stops): every satellite
    /// shivers with wide eyes and leaves — within the fade, not the snapshot's linger.
    private func stopPressed() {
        guard !satellites.isEmpty else { return }
        for s in satellites.values {
            s.sim.nudge(1.6)
            s.sim.poke()
        }
        retireAll(reason: "stop")
    }

    /// Every satellite leaves at once (a sleep, a Stop, a hide); flies waiting for a spawn are dropped.
    public func retireAll(reason: String) {
        pendingFlies.removeAll()
        let all = Array(satellites.values)
        for s in all {
            finished.insert(s.id)
            s.retire()
        }
        if !all.isEmpty { log?("fleet: retired \(all.count) (\(reason))") }
        refreshDots()
    }

    // MARK: - Room and order

    /// The other blobs' body rects (CG): the main body when it is out, and every other
    /// satellite where it is — or where it is flying to.
    public func occupied(excluding id: String?) -> [CGRect] {
        var out: [CGRect] = []
        if orb.orbPanelVisible, !orb.isTucked { out.append(orb.mainBodyRect) }
        for (sid, s) in satellites where sid != id { out.append(s.occupiedRect) }
        return out
    }

    /// The satellites' bodies as obstacles for the main body (ids 0xfffe_0000 + index):
    /// a satellite Kevin drags the main blob into is something to squish against.
    func obstacles(excluding id: String?) -> [Obstacle] {
        var out: [Obstacle] = []
        for (i, sid) in order.enumerated() where sid != id {
            if let s = satellites[sid] { out.append(Obstacle(id: 0xfffe_0000 + UInt32(i), rect: s.occupiedRect)) }
        }
        return out
    }

    /// What a satellite's body bumps into by hand: the main body and the other satellites.
    private func obstacles(forSatellite id: String) -> [Obstacle] {
        var out = obstacles(excluding: id)
        if orb.orbPanelVisible, !orb.isTucked { out.append(Obstacle(id: Self.mainObstacleId, rect: orb.mainBodyRect)) }
        return out
    }

    /// The main orb came forward: every satellite is re-ordered just under it, oldest
    /// first so the newest ends highest (BlobTrail's idiom for the ghosts). With the
    /// orb panel hidden (tucked) they come to the front of their level.
    public func mainCameForward() {
        let main = orb.orbPanelVisible ? orb.orbWindowNumber : 0
        for id in order {
            guard let s = satellites[id], s.panel.isVisible else { continue }
            if main != 0 { s.panel.order(.below, relativeTo: main) } else { s.panel.orderFrontRegardless() }
        }
    }

    private func screensDidChange() {
        for s in satellites.values { s.screensDidChange() }
    }

    /// Every parked satellite the main body now covers moves: beside its own work again
    /// on a side the main leaves free (`landing(for:avoiding:)` with the main in the
    /// list), or, with no work point, a free rank slot.
    private func yieldToMain() {
        let main = orb.mainBodyRect.insetBy(dx: -BlobBody.avoidPad, dy: -BlobBody.avoidPad)
        for (i, id) in order.enumerated() {
            guard let s = satellites[id], !s.body.dragging, !s.retiring, !s.body.isActive, s.occupiedRect.intersects(main) else { continue }
            let taken = occupied(excluding: id)
            let spot = s.lastActingPoint.map { s.body.landing(for: $0, avoiding: taken) } ?? rankSlot(for: i, excluding: id)
            s.yield(to: spot)
        }
    }

    // MARK: - The notch's dots

    var threadDots: [ThreadDot] { dots }

    /// One dot per live spawned thread (a satellite or not), in its status's colour.
    private func refreshDots() {
        let new = live.map { t in
            ThreadDot(id: t.id, name: t.name, tone: OrbPalette.color(for: t.status.satellitePhase), status: t.status, since: t.startedAt / 1000)
        }
        guard new != dots else { return }
        dots = new
        orb.setThreadDots(new)
    }

    // MARK: - The link

    /// The one display link, made from the orb's screen (the main display, else the
    /// first) — never a force-unwrapped `NSScreen.main`, which is nil at launch on a
    /// headless start. Without a screen there is nothing to draw on; the next wake tries again.
    private func ensureLink() {
        guard link == nil else { return }
        guard let screen = orb.orbScreen ?? NSScreen.main ?? NSScreen.screens.first else { return }
        let l = screen.displayLink(target: self, selector: #selector(onFrame(_:)))
        l.add(to: .main, forMode: .common)
        link = l
        lastTick = 0
    }

    /// Something wants frames (a spawn, a fly, a status change, a poke): the link runs.
    func wake() {
        idleSince = -1
        ensureLink()
        guard let link else { return }
        if link.isPaused { lastTick = 0; link.isPaused = false }
    }

    @objc private func onFrame(_ link: CADisplayLink) {
        let now = CACurrentMediaTime()
        if lastTick == 0 { lastTick = now }
        let dt = min(0.1, max(0, now - lastTick))
        lastTick = now
        let t0 = CACurrentMediaTime()
        var anyMoving = false, anyWants = false
        for s in satellites.values {
            let r = s.frame(dt: dt, now: now)
            anyMoving = anyMoving || r.moving
            anyWants = anyWants || r.wants
        }
        for s in leaving.values {
            let r = s.frame(dt: dt, now: now)
            anyMoving = anyMoving || r.moving
            anyWants = anyWants || r.wants
        }
        // While something moves by hand the bodies must know where the others are (a
        // drag squishes against them); refreshed every half second, like the window scan.
        if anyMoving, now - lastObstacleRefresh > 0.5 {
            lastObstacleRefresh = now
            for (id, s) in satellites { s.body.obstacles = obstacles(forSatellite: id) }
        }
        // The main blob just parked (its own landing never looks at the fleet): a
        // satellite it landed on steps aside — beside its work on a free side, or its slot.
        let mainMoving = orb.mainBodyMoving
        if mainWasMoving, !mainMoving, orb.orbPanelVisible, !orb.isTucked { yieldToMain() }
        mainWasMoving = mainMoving
        let cost = (CACurrentMediaTime() - t0) * 1000 + forcedMs
        if budget.note(ms: cost, now: now) { applyRung() }
        if budgetLog, now - lastBudgetLine >= 1 {
            lastBudgetLine = now
            let line = budget.line()
            if let log { log(line) } else { NSLog("Jarhead: %@", line) }
        }
        // 60 while a body moves (30 at rung 3), else the fields' own 10–24; not
        // scheduled at all after half a second with nothing to do.
        let wantRate: Double = anyMoving ? (budget.rung >= 3 ? 30 : 60) : 24
        if wantRate != linkRate {
            linkRate = wantRate
            link.preferredFrameRateRange = anyMoving
                ? CAFrameRateRange(minimum: Float(wantRate), maximum: Float(wantRate), preferred: Float(wantRate))
                : CAFrameRateRange(minimum: 10, maximum: 24, preferred: 24)
        }
        if anyWants {
            idleSince = -1
        } else if idleSince < 0 {
            idleSince = now
        } else if now - idleSince > 0.5 {
            link.isPaused = true
            lastTick = 0
        }
    }

    /// The rung changed: rung 1 caps the satellite fields at 12 fps, rung 2 refines the
    /// halo every other rendered frame; rung 3 is the link's (above), rung 4 the cap's.
    private func applyRung() {
        let r = budget.rung
        for s in satellites.values {
            s.blobView.maxFPS = r >= 1 ? 12 : nil
            s.blobView.haloEveryOther = r >= 2
        }
        let line = String(format: "fleet budget: rung -> %d (mean %.2f ms over %d frames)", r, budget.mean, FleetBudget.window)
        if let log { log(line) } else { NSLog("Jarhead: %@", line) }
    }

    #if JARHEAD_ORB_PREVIEW
    // Hooks for Scripts/orb-preview.sh only.
    public var previewSatelliteCount: Int { satellites.count }
    public var previewLeavingCount: Int { leaving.count }
    public var previewPanelPoolCount: Int { panelPool.count }
    public var previewPanelsMade: Int { panelsMade }
    public var previewPendingFlies: Int { pendingFlies.count }
    public var previewRung: Int { budget.rung }
    public var previewBudgetMean: Double { budget.mean }
    public var previewLinkPaused: Bool { link?.isPaused ?? true }
    var previewSatellites: [SatelliteBlob] { order.compactMap { satellites[$0] } }
    func previewSatellite(named name: String) -> SatelliteBlob? { byName[name.lowercased()].flatMap { satellites[$0] } }
    /// Every satellite's body is at rest (parked or hovering, no hand on it) and no fly waits.
    public var previewAllStill: Bool {
        pendingFlies.isEmpty && satellites.values.allSatisfy { !$0.body.isActive && !$0.body.dragging }
    }
    /// The showing panels' frames (CG), for framing a shot.
    public var previewPanelFramesCG: [CGRect] {
        (Array(satellites.values) + Array(leaving.values)).filter { $0.panel.isVisible }.map { CGSpace.rect(fromAppKit: $0.panel.frame) }
    }
    /// Every panel showing is exactly `SatelliteBlob.panelSize` (no allocation past the pool; the same three windows).
    public var previewPanelSizesOK: Bool {
        (Array(satellites.values) + Array(leaving.values)).allSatisfy { $0.panel.frame.size == SatelliteBlob.panelSize }
    }
    /// Draw every showing satellite (leaving ones first, then in start order: the z-order)
    /// into a context whose origin is `offset` (AppKit screen space).
    public func previewRender(in ctx: CGContext, offset: NSPoint) {
        let all = Array(leaving.values) + order.compactMap { satellites[$0] }
        for s in all where s.panel.isVisible {
            let f = s.panel.frame
            ctx.saveGState()
            ctx.translateBy(x: f.minX - offset.x, y: f.minY - offset.y)
            s.previewRender(in: ctx)
            ctx.restoreGState()
        }
    }
    /// A synthetic drag of the named satellite from its centre to `to` (CG) over `ms`,
    /// through its own pointer path (the hand comes down, sweeps with an ease-in-out, lets go).
    func previewDrag(name: String, to: CGPoint, ms: Double, done: (() -> Void)? = nil) -> Bool {
        guard let s = previewSatellite(named: name) else { return false }
        let from = s.body.center
        s.body.syntheticDrag = true
        s.pointerDown(at: from, time: ProcessInfo.processInfo.systemUptime)
        let start = CACurrentMediaTime()
        let duration = max(0.05, ms / 1000)
        wake()
        Timer.scheduledTimer(withTimeInterval: 1.0 / 120, repeats: true) { [weak s] timer in
            MainActor.assumeIsolated {
                guard let s else { timer.invalidate(); return }
                let u = min(1, (CACurrentMediaTime() - start) / duration)
                let k = u * u * (3 - 2 * u)
                s.pointerDragged(to: CGPoint(x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k))
                if u >= 1 {
                    timer.invalidate()
                    s.pointerUp(clickCount: 1, time: ProcessInfo.processInfo.systemUptime)
                    s.body.syntheticDrag = false
                    done?()
                }
            }
        }
        return true
    }
    func previewClick(name: String) -> Bool {
        guard let s = previewSatellite(named: name) else { return false }
        s.previewClick()
        return true
    }
    #endif
}
