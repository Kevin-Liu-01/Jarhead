import AppKit

// The notch island's ink and the gradient that pools out of it.
//
// Shape: one path from the bezel down — the hardware notch's column (pure black,
// nothing lives behind it) through the menu bar band, concave fillets curving out
// onto the island's top edge, convex rounded top corners where the island hangs from
// the bar, and the notch's radius on the bottom corners. Every radius comes from the
// island's size that frame, so the spring (tucked → peek → island and back) never
// kinks: at the notch's width the shape is the column with rounded bottom corners
// only, and the fillets and top corners grow with the excess. Edges are snapped to
// device pixels so the column sits on the real notch without a seam.
//
// Gradient: the app icon's orb ramp (`Dither.orbStops` — pale cyan through the
// listening cyan and the accent blues to a deep blue), a diagonal ramp (light
// upper-left → deep lower-right) quantised into `Dither.bands` and dithered with the
// shared 8×8 Bayer tile in 1.5 pt cells (UI/Dither.swift: the icon's tile, the icon's
// palette), then blended into pure black toward the notch — longest under
// the notch, a short rim at the outer corners — so the island reads as the orb's
// colour pooling out of the black. Rendered once per (size, scale) into a CGImage and
// cached (an LRU capped at 32 MB by bytes — the 420×184 island at 2× is ≈ 1.24 MB, so
// about 25 fit; the open and peek sizes are prewarmed, and the peek never grows past
// `NotchGeometry.peekWidthCap`); the mode's intensity is the alpha it is drawn with, so
// a static island allocates nothing per frame.
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
        let bottomRadius: CGFloat
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
        let r = min(NotchGeometry.radius, h / 2)
        // Per side: the excess over the column is shared between the top corner (first —
        // the rounded top edge is what must read) and the fillet (what is left), each
        // capped, the corner also by the height, the fillet by the bar (it lives in it).
        func corners(excess e: CGFloat) -> (fillet: CGFloat, top: CGFloat) {
            guard e > 0.25 else { return (0, 0) }
            let t = min(topRadius, max(0, h - r), e * 0.6)
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
    private static let paleCyan = SIMD3<Float>(160, 240, 255)
    private static let ink = SIMD3<Float>(0, 0, 0)

    /// Bands in the gradient — the icon's count, so the two are one material. The dither
    /// cell is `Dither.cellPixels(scale:)` at the key's scale (1.5 pt: 3 px on Retina).
    static let bands = Dither.bands
    /// Where the diagonal ramp starts (0 = the palest cyan) and how far it runs. On the
    /// open island biased so its body — where the face and the words sit — is mid and
    /// deep blue (the face, at the left, over #5b82ff), the cyan the upper-left corner
    /// only, the lower right the deep blue. On the peek, a 26 pt strip half of which is
    /// the black under the notch, the bias is lifted toward the cyan so the strip is
    /// unmistakably the orb's colour (a deep blue at 26 pt read as near-black on the
    /// hardware, 2026-09-11) — the eyes keep their ground under-copy and still read.
    private static let rampBiasIsland: Float = 0.3
    private static let rampBiasPeek: Float = 0.08
    private static let rampSpan: Float = 0.78
    /// The glassy highlight (the icon's top-left spot): a pale cyan spot hugging the
    /// island's left end just under the black rim, in points so it is the same size
    /// whatever the island's — small enough that the eyes, 57 pt in, sit on the blue.
    private static let highlightSigma: Float = 18

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

    /// The key for an island of `size` (points) at `scale`: the size rounded UP to 2 pt
    /// so the image covers the island (the excess is clipped away) and the spring's
    /// dozen sizes fall into a handful of buckets; whole device pixels either way.
    static func key(size: CGSize, notchWidth: CGFloat, scale: CGFloat) -> Key {
        let s = max(1, scale)
        let w2 = (size.width / 2).rounded(.up) * 2, h2 = (size.height / 2).rounded(.up) * 2
        return Key(width: max(1, Int((w2 * s).rounded())), height: max(1, Int((h2 * s).rounded())),
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
    /// stretched. Main-actor state; the worker only ever calls the pure `render` and
    /// hops back.
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
        /// design; the resting sizes are prewarmed and exact.
        let capacityBytes = 32 << 20
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
                if images[k] != nil || warm.contains(k) || pending.contains(k) { continue }
                warm.append(k)
            }
            pump()
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

        /// Drop the least recently used images until the total fits; the one just landed stays.
        private func evict(keeping fresh: Key) {
            var total = renderedBytes
            var i = 0
            while total > capacityBytes, i < order.count {
                let k = order[i]
                if k == fresh { i += 1; continue }
                order.remove(at: i)
                total -= bytes[k] ?? 0
                images[k] = nil
                bytes[k] = nil
            }
        }
    }

    /// Pure Swift over an RGBX buffer: 360×132 pt at 2× is 190k pixels, a few ms
    /// optimised. Pure and thread-agnostic: it reads only the constants and the tile.
    /// The base is `Dither`'s banded diagonal ramp (its LUT, its tile, its quantiser);
    /// the notch's own shading — the highlight, the black into the notch, the vignette —
    /// is dithered the same way, in the same pass.
    static func render(_ key: Key) -> CGImage? {
        let W = key.width, H = key.height
        guard W > 0, H > 0 else { return nil }
        let s = Float(key.scale100) / 100
        let wPt = Float(W) / s, hPt = Float(H) / s
        let noise = Dither.tile, nz = Dither.tileSize
        let cell = Dither.cellPixels(scale: CGFloat(s))
        let nb = Float(bands)
        // 0 at the peek's height … 1 at the island's: the black under the notch reaches
        // deeper, the ramp shifts to the blues and the vignette comes in as the island opens.
        let sizeT = Dither.smoothstep(Float(NotchGeometry.peekHeight), Float(NotchGeometry.islandHeight), hPt)
        let halfW = wPt / 2
        let halfNotch = min(halfW, Float(key.notchWidth) / s / 2)
        let wing = max(1, halfW - halfNotch)
        // The highlight: centred a touch off the left edge, a third of the way down —
        // under the black rim at the corner — so it is the left end's glow, not the face's.
        let hlX = -0.01 * wPt, hlY = 0.36 * hPt
        // Faint on the peek (its face is centred and the spot would pull the eye to one
        // end of a breathing island), full on the open island.
        let hlAmp: Float = 0.3 + 0.5 * sizeT
        // Into the notch: black at the top edge everywhere, fading over most of the height
        // under the notch on the open island but only its top third on the peek (the strip
        // is 26 pt: two thirds of it must be colour to be seen), and over a shorter rim at
        // the outer corners — never shorter than the peek's half, so the breathing peek's
        // small shoulders stay ink rather than pulsing cyan ears beside the notch.
        let deepUnderNotch = Dither.mix(0.34, 0.82, sizeT)
        let rim = Dither.mix(0.5, 0.26, sizeT)
        let vignette = sizeT * 0.34
        let rampBias = Dither.mix(rampBiasPeek, rampBiasIsland, sizeT)

        // The ramp takes only `bands + 1` values once quantised: a table.
        let rampLUT = Dither.lut(stops: stops, bands: bands)
        // Per column and per row terms, so the pixel loop is lookups and three mixes.
        var colDiag = [Float](repeating: 0, count: W), colHL = [Float](repeating: 0, count: W)
        var colReach = [Float](repeating: 0, count: W), colV = [Float](repeating: 0, count: W)
        for x in 0..<W {
            let fx = (Float(x) + 0.5) / Float(W)
            let xPt = (Float(x) + 0.5) / s
            colDiag[x] = rampBias + rampSpan * 0.68 * fx
            let hx = (xPt - hlX) / highlightSigma
            colHL[x] = expf(-hx * hx / 2)
            let fromNotch = Dither.clamp01((abs(xPt - halfW) - halfNotch) / wing)
            colReach[x] = Dither.mix(deepUnderNotch, rim, Dither.smoothstep(0, 1, fromNotch))
            colV[x] = abs(fx - 0.5) * 2
        }
        var px = [UInt8](repeating: 0, count: W * H * 4)
        px.withUnsafeMutableBufferPointer { out in
            for y in 0..<H {
                let fy = (Float(y) + 0.5) / Float(H)
                let yPt = (Float(y) + 0.5) / s
                let rowDiag = rampSpan * 0.32 * fy
                let hy = (yPt - hlY) / highlightSigma
                let rowHL = hlAmp * expf(-hy * hy / 2)
                let vy = abs(fy - 0.5) * 2 * 0.9
                let noiseRow = ((y / cell) % nz) * nz
                let rowBase = y * W * 4
                for x in 0..<W {
                    let t = noise[noiseRow + (x / cell) % nz]
                    // The diagonal ramp, banded.
                    var col = rampLUT[Dither.quantise(colDiag[x] + rowDiag, nb, t)]
                    // The highlight.
                    col = Dither.mix(col, paleCyan, Float(Dither.quantise(rowHL * colHL[x], 6, t)) / 6)
                    // Into the notch.
                    let black = 1 - Dither.smoothstep(0, colReach[x], fy)
                    col = Dither.mix(col, ink, Float(Dither.quantise(black, nb, t)) / nb)
                    // A slight vignette on the open island, so the words read to the edges.
                    let v = vignette * Dither.smoothstep(0.55, 1, max(colV[x], vy))
                    col = Dither.mix(col, ink, Float(Dither.quantise(v, 6, t)) / 6)
                    let i = rowBase + x * 4
                    out[i] = UInt8(clamping: Int(col.x.rounded()))
                    out[i + 1] = UInt8(clamping: Int(col.y.rounded()))
                    out[i + 2] = UInt8(clamping: Int(col.z.rounded()))
                    out[i + 3] = 255
                }
            }
        }
        return Dither.image(rgbx: px, width: W, height: H)
    }
}
