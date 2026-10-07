import AppKit

// The notch island's ink and the gradient that pools out of it.
//
// Shape: one path from the bezel down — the hardware notch's column (pure black,
// nothing lives behind it) through the menu bar band, concave fillets curving out
// onto the island's top edge, convex rounded top corners where the island hangs from
// the bar, and bottom corners that grow from the notch's radius (the lip, the peek)
// to the open island's generous `NotchGeometry.bottomRadius` as it opens (`openLevel`).
// The menu bar keeps its status items: nothing is laid over the bar beside the notch
// (the site draws its own bar, and there the island's band covers it: styles/site.css
// .top-band; a real bar's items are the user's). Every radius comes from the island's
// size that frame, so the spring (tucked → peek → island and back) never kinks: at the
// notch's width the shape is the column with rounded bottom corners only, and the
// fillets and top corners grow with the excess. Edges are snapped to device pixels so
// the column sits on the real notch without a seam.
//
// Gradient: the app icon's orb ramp (`Dither.orbStops` — pale cyan through the
// listening cyan and the accent blues to a deep blue) poured out of the black: the black
// reaches deepest under the notch and falls away diagonally over the wings to a short
// rim at the outer corners, so the island reads as the orb's colour pooling out of the
// notch, never as a strip laid along its top. Under it a diagonal ramp (light toward
// the face's corner, deep at the far one), the icon's pale-cyan highlight at the left
// end and a slight vignette so the words read to the edges, the light falling toward
// the foot (`footShade`). Two quantities per 1.5 pt
// cell and ONE threshold per cell (the shared 8×8 Bayer tile, UI/Dither.swift): where
// the cell is on the ramp (`bands` steps, the highlight folded in) and how much light it
// keeps (`lightSteps`, the vignette folded in), its colour the band times the step. Both
// round the same way on the threshold: a cell that steps toward the deep end also steps
// toward the black (the light on `1 − t`), so the two errors add into one crosshatch, as the
// installed ink's did; rounded against each other they cancelled into vertical streaks and
// lost most of the grain. The light going (the pour, the vignette) also walks the ramp
// toward its deep end, so the black pools through navy, never through a muddy teal (the
// pale cyan dimmed). (It once stacked four dithers whose steps crossed: ramp, highlight,
// black, vignette.) Every phase wears it, asleep included. The site's lib/island.ts
// renderIslandInk is the same math, cell for cell.
//
// Rendered once per (size, scale) into a CGImage and
// cached (an LRU capped at 32 MB by bytes — the 420×184 island at 2× is ≈ 1.24 MB, so
// about 25 fit; the open and peek sizes are prewarmed and pinned (evicted last), and the
// peek never grows past `NotchGeometry.peekWidthCap`); the mode's intensity is the alpha
// it is drawn with, so a static island allocates nothing per frame.
//
// Nothing here blocks a frame: the tile and every image are rendered on
// `Dither.renderQueue` (a few ms optimised, hundreds of ms in a -Onone build — `swift
// build`'s debug configuration), the view draws the nearest rendered size, stretched,
// until the exact one lands, and is woken then (`NotchInkObserver`). A static island,
// once rendered, is a dictionary hit.

/// Told on the main thread when a gradient image has landed: redraw.
@MainActor
protocol NotchInkObserver: AnyObject {
    func notchInkRendered()
}

enum NotchInk {
    // MARK: shape

    /// The island's convex top corners, where it hangs from the menu bar: generous, so
    /// the open island's top edges read rounded against the bar (Kevin, 2026-09-11:
    /// "these are the top edges we need to make rounded") — larger than the fillet, which
    /// only has to carry the eye from the column onto the edge.
    static let topRadius: CGFloat = 18
    /// The concave fillet from the notch's column onto the island's top edge. Inside
    /// the menu bar band by construction (the arc is tangent to the column `fillet`
    /// above the bar's bottom edge): the widening begins on the notch itself, about
    /// where the hardware notch's own bottom corners begin to round, and the flare
    /// continues that curve instead of a hard-cornered rectangle hung under the bar.
    static let fillet: CGFloat = 14

    struct Shape {
        let path: CGPath
        /// The island, snapped to device pixels (view coordinates, y down).
        let island: CGRect
        let topRadius: CGFloat
        let fillet: CGFloat
        /// The bottom corners: the notch's 12 pt folded, `NotchGeometry.bottomRadius` open.
        let bottomRadius: CGFloat
    }

    /// How open the island is for a `height` points tall: 0 up to the peek's height (the
    /// lip, the peek and the strip), 1 at the island's, eased between, so it follows the
    /// height spring and never steps. The bottom corners grow with it; `render(_:)`'s
    /// `sizeT` is the same function of the height, so the ink opens with the silhouette.
    static func openLevel(height h: CGFloat) -> CGFloat {
        let lo = NotchGeometry.peekHeight, hi = NotchGeometry.islandHeight
        guard h.isFinite, hi > lo else { return 0 }
        let t = min(1, max(0, (h - lo) / (hi - lo)))
        return t * t * (3 - 2 * t)
    }

    /// The bottom corners' radius for an island `h` points tall: the notch's 12 pt folded,
    /// growing to `NotchGeometry.bottomRadius` open, never past half the height.
    static func bottomCornerRadius(height h: CGFloat) -> CGFloat {
        min(NotchGeometry.radius + (NotchGeometry.bottomRadius - NotchGeometry.radius) * openLevel(height: h), h / 2)
    }

    /// A convex top corner's radius on a side where the island runs `e` points past the
    /// notch's column: the rounded top edge is what must read, so it takes the excess first
    /// (the fillet gets what is left), capped by `topRadius` and by the height left over
    /// the bottom corner `r`. None without an excess (the lip, a peek the notch's width).
    static func topCornerRadius(excess e: CGFloat, height h: CGFloat, bottomRadius r: CGFloat) -> CGFloat {
        guard e > 0.25 else { return 0 }
        return min(topRadius, max(0, h - r), e * 0.6)
    }

    /// `column` is the notch's x-span, `island` the island rect this frame (its minY is
    /// the menu bar's bottom edge, the column's end), both in the view's flipped
    /// coordinates; `scale` the backing scale for the pixel snapping.
    static func shape(column: ClosedRange<CGFloat>, island islandIn: CGRect, scale: CGFloat) -> Shape {
        let s = scale.isFinite ? max(1, scale) : 2
        func snap(_ v: CGFloat) -> CGFloat { (v * s).rounded() / s }
        let cL = snap(column.lowerBound), cR = snap(column.upperBound)
        // An island that is not a rect (a spring gone bad) is the column alone, no island.
        let island = islandIn.isFiniteRect ? islandIn : CGRect(x: cL, y: islandIn.minY.isFinite ? islandIn.minY : 0, width: cR - cL, height: 0)
        let y0 = snap(island.minY)
        let y1 = max(y0, snap(island.maxY))
        // Never narrower than the column: the spring undershoots a hair on the way back.
        let x0 = min(snap(island.minX), cL), x1 = max(snap(island.maxX), cR)
        let h = y1 - y0
        let snapped = CGRect(x: x0, y: y0, width: x1 - x0, height: h)
        let path = CGMutablePath()
        if h < 0.5 {
            path.addRect(CGRect(x: cL, y: 0, width: cR - cL, height: y0))
            return Shape(path: path, island: snapped, topRadius: 0, fillet: 0, bottomRadius: 0)
        }
        let r = bottomCornerRadius(height: h)
        // Per side: the excess over the column is shared between the top corner (first —
        // the rounded top edge is what must read) and the fillet (what is left), each
        // capped, the corner also by the height, the fillet by the bar (it lives in it).
        func corners(excess e: CGFloat) -> (fillet: CGFloat, top: CGFloat) {
            guard e > 0.25 else { return (0, 0) }
            let t = topCornerRadius(excess: e, height: h, bottomRadius: r)
            let f = min(fillet, e - t, y0)
            return (f, t)
        }
        let left = corners(excess: cL - x0), right = corners(excess: x1 - cR)

        path.move(to: CGPoint(x: cL, y: 0))
        if left.fillet > 0.25 {
            path.addLine(to: CGPoint(x: cL, y: y0 - left.fillet))
            path.addArc(tangent1End: CGPoint(x: cL, y: y0), tangent2End: CGPoint(x: cL - left.fillet, y: y0), radius: left.fillet)
        } else {
            path.addLine(to: CGPoint(x: cL, y: y0))
        }
        if left.top > 0.25 {
            path.addLine(to: CGPoint(x: x0 + left.top, y: y0))
            path.addArc(tangent1End: CGPoint(x: x0, y: y0), tangent2End: CGPoint(x: x0, y: y0 + left.top), radius: left.top)
        } else {
            path.addLine(to: CGPoint(x: x0, y: y0))
        }
        path.addLine(to: CGPoint(x: x0, y: y1 - r))
        path.addArc(tangent1End: CGPoint(x: x0, y: y1), tangent2End: CGPoint(x: x0 + r, y: y1), radius: r)
        path.addLine(to: CGPoint(x: x1 - r, y: y1))
        path.addArc(tangent1End: CGPoint(x: x1, y: y1), tangent2End: CGPoint(x: x1, y: y1 - r), radius: r)
        if right.top > 0.25 {
            path.addLine(to: CGPoint(x: x1, y: y0 + right.top))
            path.addArc(tangent1End: CGPoint(x: x1, y: y0), tangent2End: CGPoint(x: x1 - right.top, y: y0), radius: right.top)
        } else {
            path.addLine(to: CGPoint(x: x1, y: y0))
        }
        if right.fillet > 0.25 {
            path.addLine(to: CGPoint(x: cR + right.fillet, y: y0))
            path.addArc(tangent1End: CGPoint(x: cR, y: y0), tangent2End: CGPoint(x: cR, y: y0 - right.fillet), radius: right.fillet)
        } else {
            path.addLine(to: CGPoint(x: cR, y: y0))
        }
        path.addLine(to: CGPoint(x: cR, y: 0))
        path.closeSubpath()
        return Shape(path: path, island: snapped, topRadius: max(left.top, right.top), fillet: max(left.fillet, right.fillet), bottomRadius: r)
    }

    // MARK: ramp

    /// The icon's ramp, shared (`Dither.orbStops`).
    private static let stops = Dither.orbStops

    /// The ramp's steps (the icon's five, one more so the blues step gently) and the
    /// light's (the black poured in). The dither cell is `Dither.cellPixels(scale:)` at the
    /// key's scale (1.5 pt: 3 px on Retina).
    static let bands = Dither.bands + 1
    static let lightSteps = 6
    /// Where the diagonal ramp starts (0 = the palest cyan) at the top-left and how far it
    /// runs to the bottom-right, across x then down. On the open island the face's corner is
    /// the light blues, the far corner the deep blue. On the peek, a 26 pt strip half of
    /// which is the black under the notch, the bias sits at the accent blue so the strip is
    /// unmistakably the orb's colour (a deep blue at 26 pt read as near-black on the
    /// hardware, 2026-09-11) but never the pale cyan: lifted to the cyan it read as a light
    /// blue bar under the notch (Kevin's bar rule, site/docs/TWIN.md). The eyes keep their
    /// ground under-copy and still read.
    private static let rampBiasIsland: Float = 0.16
    private static let rampBiasPeek: Float = 0.3
    private static let rampSpanIsland: Float = 0.84
    private static let rampSpanPeek: Float = 0.78
    private static let rampAcross: Float = 0.68
    private static let rampDown: Float = 0.32
    /// The pour, as fractions of the height: how far the black reaches under the notch and
    /// at the island's ends, open and on the peek (26 pt: over half of it must be colour to
    /// be seen; the black pours down its top as it does the island's, and its shoulders stay
    /// ink rather than pulsing cyan ears beside the notch).
    private static let pourUnderIsland: Float = 0.76
    private static let pourEndsIsland: Float = 0.26
    private static let pourUnderPeek: Float = 0.45
    private static let pourEndsPeek: Float = 0.6
    /// The glassy highlight (the icon's top-left spot): a pale cyan pull on the ramp at the
    /// island's left end, a third of the way down, in points so it is the same size whatever
    /// the island's; a trace of it on the peek (its face is centred, and a cyan end would
    /// read as a light blue bar).
    private static let highlightX: Float = 2
    private static let highlightY: Float = 0.36
    private static let highlightSigma: Float = 20
    private static let highlightIsland: Float = 0.45
    private static let highlightPeek: Float = 0.12
    /// The vignette's depth on the open island, and the rows under the bezel kept black outright
    /// (points), so the join under the bar never shows a dithered fringe.
    private static let vignetteIsland: Float = 0.24
    private static let solidPoints: Float = 2
    /// The light falls toward the foot, open only: by `footShade` from `footShadeTop` points
    /// above the island's bottom edge (under the middle beat) to `footShadeFull` above it (the
    /// foot's words), so the foot's 0.72 clause and 0.92 noun clear 4.5:1 over the ramp's pale
    /// end, where they fell to 2.5:1, and the Say box's placeholder with them. A long fall,
    /// never a band: over the seam's 12 pt alone it read as a dark footer bar. Its light
    /// going walks the ramp to navy there too.
    private static let footShade: Float = 0.35
    private static let footShadeTop: Float = 90
    private static let footShadeFull: Float = 20

    // MARK: gradient image

    struct Key: Hashable {
        /// Pixels.
        let width: Int
        let height: Int
        /// The notch's width in pixels (the black pools longest under it).
        let notchWidth: Int
        /// Backing scale × 100.
        let scale100: Int
    }

    /// A gradient to draw over the island: the image and the size (points) to draw it
    /// at, centred on the island, its top at the island's. `exact` when it is the
    /// island's own size (a 1-px dither, drawn 1:1); else the nearest rendered size,
    /// to be stretched over the island while the exact one renders.
    struct Rendered {
        let image: CGImage
        let size: CGSize
        let exact: Bool
    }

    /// The key for an island of `size` (points) at `scale`: the height rounded UP to 2 pt and
    /// the width, with a device pixel to spare each side, UP to whole pairs of dither cells
    /// (`Dither.cellPixels` × 2: 3 pt at 2x, 4 pt at 1x), so the image covers the island
    /// wherever its snapped edges fall (the excess is clipped away) and, centred on the notch's
    /// snapped middle (NotchView), its cells keep one phase at every width — the peek breathing
    /// with the voice never shifts the grain or the face by a pixel; the spring's dozen sizes
    /// fall into a handful of buckets. Whole device pixels either way.
    static func key(size: CGSize, notchWidth: CGFloat, scale: CGFloat) -> Key {
        let s = max(1, scale)
        let pair = 2 * Dither.cellPixels(scale: s)
        let wpx = (Int((size.width * s + 2 - 1e-6).rounded(.up)) + pair - 1) / pair * pair
        let h2 = (size.height / 2).rounded(.up) * 2
        return Key(width: max(pair, wpx), height: max(1, Int((h2 * s).rounded())),
                   notchWidth: Int((notchWidth * s).rounded()), scale100: Int((s * 100).rounded()))
    }

    /// The size a key's image is drawn at, in points.
    static func pointSize(of key: Key) -> CGSize {
        let s = CGFloat(key.scale100) / 100
        return CGSize(width: CGFloat(key.width) / s, height: CGFloat(key.height) / s)
    }

    /// The gradient for an island of `size` (points) at `scale`: the exact image when it
    /// has been rendered, else the nearest rendered size (stretched) while the exact one
    /// renders in the background — nil before anything has (plain ink). Observers are
    /// told when it lands. Never blocks: a debug build's 200 ms render and the 3 s tile
    /// happen off the main thread.
    @MainActor
    static func gradient(size: CGSize, notchWidth: CGFloat, scale: CGFloat) -> Rendered? {
        // `key` rounds the size into an Int, which traps on a NaN: no image for a size
        // that is not one (plain ink that frame).
        guard size.width.isFinite, size.height.isFinite, notchWidth.isFinite, scale.isFinite, size.width > 0, size.height > 0 else { return nil }
        return Cache.shared.image(for: key(size: size, notchWidth: notchWidth, scale: scale))
    }

    /// The gradient, rendered here and now (blocking on the tile): for the bench and
    /// one-off shots, never for a frame.
    static func renderNow(size: CGSize, notchWidth: CGFloat, scale: CGFloat) -> Rendered? {
        let k = key(size: size, notchWidth: notchWidth, scale: scale)
        guard let img = render(k) else { return nil }
        return Rendered(image: img, size: pointSize(of: k), exact: true)
    }

    /// Start the shared tile on the render queue so the first island's image is not the
    /// one that pays for it.
    static func prewarm() { Dither.prewarm() }

    /// The rendered gradients, an LRU capped by bytes — the spring passes through a dozen
    /// sizes on its way open or closed, the peek breathes through a few, and a static
    /// island hits the same one every frame — fed by one background worker that renders
    /// the most recently asked-for size first (the island's current size lands before
    /// the sizes the spring has already left behind), then backfills. `prewarm` queues
    /// the sizes the dock knows it will show (the open island, the lip, the peek and its
    /// breath) behind the live requests, so the first open is drawn exact, never
    /// stretched. Main-actor state; the render queue only ever calls the pure `render`
    /// and hops back.
    @MainActor
    final class Cache {
        static let shared = Cache()
        /// The shared render queue: the tile is computed there too (never on main).
        nonisolated static var renderQueue: DispatchQueue { Dither.renderQueue }

        private var images: [Key: CGImage] = [:]
        private var bytes: [Key: Int] = [:]
        private var order: [Key] = []
        /// Asked for and not yet rendered, oldest first; the worker takes the last.
        private var pending: [Key] = []
        /// Prewarm sizes, drained after `pending` is empty, in the order given.
        private var warm: [Key] = []
        private var rendering = false
        private let observers = NSHashTable<AnyObject>.weakObjects()
        /// 32 MB holds about 25 open-island images (420×184 at 2× is ≈ 1.24 MB); one
        /// open+close spring is ~25 distinct sizes and the peek's breath up to 16 more,
        /// most of them a fraction of that — stretched neighbours mid-spring are the
        /// design. The resting sizes are prewarmed and exact, and stay so: `prewarm`'s
        /// keys are pinned — the LRU evicts them last, only once every spring size is
        /// gone — so a close never costs the peek its breath buckets (their last hit was
        /// before the pointer arrived, which would make them the first to go).
        let capacityBytes = 32 << 20
        /// The keys `prewarm` asked for: the resting sizes, evicted only when nothing else is left.
        private var pinned: Set<Key> = []
        /// Sizes the spring has left behind are the least useful to render.
        private let pendingCap = 8

        func addObserver(_ o: NotchInkObserver) { observers.add(o) }

        func image(for key: Key) -> Rendered? {
            if let img = images[key] {
                if order.last != key, let i = order.firstIndex(of: key) { order.remove(at: i); order.append(key) }
                return Rendered(image: img, size: NotchInk.pointSize(of: key), exact: true)
            }
            request(key)
            // Meanwhile: the nearest rendered size at this scale and notch, stretched.
            var best: Key?
            var bestDistance = Int.max
            for k in order where k.scale100 == key.scale100 && k.notchWidth == key.notchWidth {
                let d = abs(k.width - key.width) + abs(k.height - key.height)
                if d < bestDistance { bestDistance = d; best = k }
            }
            guard let best, let img = images[best] else { return nil }
            return Rendered(image: img, size: NotchInk.pointSize(of: key), exact: false)
        }

        /// Whether the exact image for this size is in the cache (the bench's and the harness's check).
        func has(size: CGSize, notchWidth: CGFloat, scale: CGFloat) -> Bool {
            images[NotchInk.key(size: size, notchWidth: notchWidth, scale: scale)] != nil
        }

        var count: Int { images.count }
        /// Bytes held right now (the harness pins `renderedBytes ≤ capacityBytes`).
        var renderedBytes: Int { bytes.values.reduce(0, +) }

        /// Render these sizes (points) at `scale` for a notch of `notchWidth` in the
        /// background, after whatever the live island asks for. Sizes already held are skipped.
        func prewarm(sizes: [CGSize], notchWidth: CGFloat, scale: CGFloat) {
            for size in sizes {
                guard size.width.isFinite, size.height.isFinite, size.width > 0, size.height > 0 else { continue }
                let k = NotchInk.key(size: size, notchWidth: notchWidth, scale: scale)
                pinned.insert(k)
                if images[k] != nil || warm.contains(k) || pending.contains(k) { continue }
                warm.append(k)
            }
            pump()
        }

        /// Whether a size is one `prewarm` pinned (the harness reads it).
        func isPinned(size: CGSize, notchWidth: CGFloat, scale: CGFloat) -> Bool {
            pinned.contains(NotchInk.key(size: size, notchWidth: notchWidth, scale: scale))
        }

        private func request(_ key: Key) {
            if let i = pending.firstIndex(of: key) { pending.remove(at: i) }
            pending.append(key)
            if pending.count > pendingCap { pending.removeFirst() }
            pump()
        }

        private func pump() {
            guard !rendering else { return }
            let next: Key?
            if let live = pending.popLast() { next = live } else if !warm.isEmpty { next = warm.removeFirst() } else { next = nil }
            guard let key = next else { return }
            rendering = true
            let owner = self
            Self.renderQueue.async {
                let img = NotchInk.render(key)
                DispatchQueue.main.async {
                    MainActor.assumeIsolated { owner.landed(key, img) }
                }
            }
        }

        private func landed(_ key: Key, _ img: CGImage?) {
            rendering = false
            if let img {
                if images[key] == nil { order.append(key) }
                images[key] = img
                bytes[key] = img.bytesPerRow * img.height
                evict(keeping: key)
            }
            for o in observers.allObjects { (o as? NotchInkObserver)?.notchInkRendered() }
            pump()
        }

        /// Drop the least recently used images until the total fits; the one just landed
        /// stays, and the pinned (prewarmed) sizes go only once every other is gone.
        private func evict(keeping fresh: Key) {
            var total = renderedBytes
            for pass in 0..<2 where total > capacityBytes {
                var i = 0
                while total > capacityBytes, i < order.count {
                    let k = order[i]
                    if k == fresh || (pass == 0 && pinned.contains(k)) { i += 1; continue }
                    order.remove(at: i)
                    total -= bytes[k] ?? 0
                    images[k] = nil
                    bytes[k] = nil
                }
            }
        }
    }

    /// Pure Swift over an RGBX buffer, one colour per dither cell (the cell's centre) filled
    /// over the cell's pixels: 420×184 pt at 2× is 34k cells, a few ms optimised. Pure and
    /// thread-agnostic: it reads only the constants, the table and the tile.
    static func render(_ key: Key) -> CGImage? {
        let W = key.width, H = key.height
        guard W > 0, H > 0 else { return nil }
        let s = Float(key.scale100) / 100
        let wPt = Float(W) / s, hPt = Float(H) / s
        let noise = Dither.tile, nz = Dither.tileSize
        let cell = Dither.cellPixels(scale: CGFloat(s))
        let cellPt = Float(cell) / s
        let nx = (W + cell - 1) / cell, ny = (H + cell - 1) / cell
        let nb = Float(bands), nk = Float(lightSteps)
        // 0 at the peek's height … 1 at the island's: the pour reaches deeper under the notch,
        // the ramp shifts to the blues, the highlight and the vignette come in as it opens.
        let sizeT = Dither.smoothstep(Float(NotchGeometry.peekHeight), Float(NotchGeometry.islandHeight), hPt)
        let halfW = wPt / 2
        let halfNotch = min(halfW, Float(key.notchWidth) / s / 2)
        let wing = max(1, halfW - halfNotch)
        let under = Dither.mix(pourUnderPeek, pourUnderIsland, sizeT)
        let ends = Dither.mix(pourEndsPeek, pourEndsIsland, sizeT)
        let bias = Dither.mix(rampBiasPeek, rampBiasIsland, sizeT)
        let span = Dither.mix(rampSpanPeek, rampSpanIsland, sizeT)
        let hlAmp = Dither.mix(highlightPeek, highlightIsland, sizeT)
        let hlY = highlightY * hPt
        let sig2 = 2 * highlightSigma * highlightSigma
        let vignette = vignetteIsland * sizeT
        let shade = footShade * sizeT
        let rampLUT = Dither.lut(stops: stops, bands: bands)

        // Per column and per row terms, so the cell loop is lookups and a few products.
        var colDiag = [Float](repeating: 0, count: nx), colHL = [Float](repeating: 0, count: nx)
        var colReach = [Float](repeating: 0, count: nx), colV = [Float](repeating: 0, count: nx)
        for cx in 0..<nx {
            let xPt = (Float(cx) + 0.5) * cellPt
            colDiag[cx] = span * rampAcross * (xPt / wPt)
            let hx = xPt - highlightX
            colHL[cx] = expf(-hx * hx / sig2)
            let fromNotch = Dither.clamp01((abs(xPt - halfW) - halfNotch) / wing)
            colReach[cx] = Dither.mix(under, ends, Dither.smoothstep(0, 1, fromNotch))
            colV[cx] = abs(xPt / wPt - 0.5) * 2
        }
        var row = [SIMD3<Float>](repeating: .zero, count: nx)
        var px = [UInt8](repeating: 0, count: W * H * 4)
        px.withUnsafeMutableBufferPointer { out in
            for cy in 0..<ny {
                let yPt = (Float(cy) + 0.5) * cellPt
                let fy = yPt / hPt
                let rowDiag = bias + span * rampDown * fy
                let hy = yPt - hlY
                let rowHL = hlAmp * expf(-hy * hy / sig2)
                let vy = abs(fy - 0.5) * 2 * 0.9
                let foot = 1 - shade * Dither.smoothstep(hPt - footShadeTop, hPt - footShadeFull, yPt)
                let noiseRow = (cy % nz) * nz
                for cx in 0..<nx {
                    guard yPt >= solidPoints else { row[cx] = .zero; continue }
                    let t = noise[noiseRow + cx % nz]
                    // The light it keeps: the pour (the black under the notch, deepest there, a
                    // short rim at the ends) with the vignette and the foot's shade folded in.
                    let lit = Dither.smoothstep(0, colReach[cx], fy) * (1 - vignette * Dither.smoothstep(0.55, 1, max(colV[cx], vy))) * foot
                    // The ramp with the highlight's pull to the pale end, walked toward the deep
                    // end as the light goes (at every size: the peek's black pools through navy
                    // too, never a teal fringe), banded.
                    var u = colDiag[cx] + rowDiag
                    u -= u * rowHL * colHL[cx]
                    u = 1 - (1 - Dither.clamp01(u)) * lit
                    let band = rampLUT[Dither.quantise(u, nb, t)]
                    // The light, stepped on the same threshold rounding the same way (toward the
                    // black where the band rounds toward the deep end), so the errors add.
                    row[cx] = band * (Float(Dither.quantise(lit, nk, 1 - t)) / nk)
                }
                let y1 = min(H, (cy + 1) * cell)
                for y in (cy * cell)..<y1 {
                    let rowBase = y * W * 4
                    for x in 0..<W {
                        let col = row[x / cell]
                        let i = rowBase + x * 4
                        out[i] = UInt8(clamping: Int(col.x.rounded()))
                        out[i + 1] = UInt8(clamping: Int(col.y.rounded()))
                        out[i + 2] = UInt8(clamping: Int(col.z.rounded()))
                        out[i + 3] = 255
                    }
                }
            }
        }
        return Dither.image(rgbx: px, width: W, height: H)
    }
}
