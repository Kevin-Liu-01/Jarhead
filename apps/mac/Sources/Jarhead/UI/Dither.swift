import AppKit
import SwiftUI

// The one way a shaded surface is drawn in this app.
//
// Kevin (2026-09-11): "make the icon and any gradients or designs be dithered." Flat
// fills stay flat; anything that shades — a ramp, a glow, a vignette — is quantised
// into a few bands and dithered with an ordered Bayer matrix in cells a pixel or three
// wide, so the pattern is SEEN. Kevin (2026-09-12): the first cut — blue noise at one
// device pixel, seven bands — was "so grainy it just looks smooth"; the cell is now
// sized in points (`cellPoints`), the tile is the classic 8×8 matrix and the bands are
// five, so every step of a ramp is a legible crosshatch. The app icon does the same
// (`scripts/make-icon.ts`: the same matrix, the same `ORB_STOPS` palette, the same
// band count), so the Dock, the notch island and any future shaded surface are one
// material. Kevin (2026-09-12, later): "use the dither theme across ascii loading
// states, the app background and more — this is our cool aesthetic" — so the Console
// and Onboarding grounds (`groundStops`), the onboarding heroes, the Jarhead mark, the
// meters (`DitheredBar`), the thumbnail skeletons, the capsule's floor
// (`DitheredShadow`) and every loading state (`DitherGlyphs`) are this material, and
// view switches dissolve through it: small ones as a mask (`DitherWipe` behind
// `Motion.wipe`), a pane behind a curtain of ground-coloured cells (`DitherCurtain`
// behind `Motion.curtain`) — never a mask on a pane of text, which RenderBox rasterises
// through CoreGraphics at 0.3–0.5 s a frame.
//
// `Dither.gradientImage` is the renderer: a banded, dithered ramp between `stops`
// along a `direction`, as a `CGImage` at a backing scale. `Dither.coverageImage` is its
// coverage-only sibling for the capsule's shadow. Both are pure and thread-agnostic; they
// block only on the tile, which is computed once and cached — on `renderQueue`, never
// on the main thread (`prewarm(scale:)` starts it early and builds `Dither.Tiles`, the
// tiny precomputed wipe and edge tiles; a surface that finds them missing asks for them
// itself through `Tiles.ensure(scale:)`, so a launch that forgot to prewarm degrades once,
// not for good). `Dither.Cache` renders in the background,
// budgets by bytes, and hands the image back on the main thread; `DitheredGradient` is
// the SwiftUI view over it, for the Console, Onboarding and anything else declarative.
// `NotchInk` composes its island out of the same pieces (the tile, the palette, `lut` /
// `quantise`) with its own notch-specific shading; the blob's halo quantises its
// coverage MASK with the same tile (the bilinear + box pass before it is a smoothing of
// that mask, not a visible blur). Per-frame code does dictionary lookups and layout; it
// never touches a pixel buffer.
// The Dock icon and the README banner wear the blob's `^ ^` (scripts/dither.ts FACE: one cell
// pattern from 64 to 1024, hand bitmaps at 32 and 16). Below the Dock's 32 px class — the 14 pt
// `JarheadMark` in the Console, the notch island's gradient — the orb stays FACELESS: a face that
// small reads as noise, not as Jarhead.
enum Dither {
    // MARK: palette

    /// A colour stop: `u` in 0…1 along the ramp, the colour in 0…255 sRGB.
    struct Stop: Hashable {
        let u: Float
        let color: SIMD3<Float>
        init(_ u: Float, _ color: SIMD3<Float>) { self.u = u; self.color = color }
        init(_ u: Float, hex: UInt32) {
            self.u = u
            color = SIMD3(Float((hex >> 16) & 0xff), Float((hex >> 8) & 0xff), Float(hex & 0xff))
        }
    }

    /// The orb's ramp, Kevin's reference (`ORB_STOPS` in make-icon.ts): pale cyan →
    /// the listening cyan → lift → accent → a deep blue. Blue all the way, no violet.
    static let orbStops: [Stop] = [
        Stop(0.00, SIMD3(160, 240, 255)),
        Stop(0.24, hex: 0x5ad7ff),
        Stop(0.50, hex: 0x5b82ff),
        Stop(0.74, hex: 0x2f5ce0),
        Stop(1.00, SIMD3(24, 58, 168)),
    ]
    /// The quiet mark's ramp — the orb's five bands in titanium's own hue (#8a8f98, 219°, 9 %), so a
    /// conversation that is over wears the same crosshatch beside the stamp and the section heads
    /// as one neutral. Pale grey → titanium → fg3-ish → the deep end; ≈ 25 % darker than the blue
    /// ramp at its bright end, level with it at the dark end. LUT (5 bands):
    /// a9adb5 · 8f949d · 747881 · 595d64 · 40444b · 2e3137.
    static let markQuietStops: [Stop] = [
        Stop(0.00, hex: 0xa9adb5),
        Stop(0.24, hex: 0x8a8f98),
        Stop(0.50, hex: 0x666a72),
        Stop(0.74, hex: 0x464a51),
        Stop(1.00, hex: 0x2e3137),
    ]
    /// Ink to the accent: for a shaded ground rather than a coloured one.
    static let inkStops: [Stop] = [
        Stop(0.0, hex: 0x070707),
        Stop(0.5, hex: 0x101010),
        Stop(1.0, hex: 0x2f5ce0),
    ]
    /// The Console's ground: ink, a step to raised ink past the middle, the accent as a
    /// whisper (18 % into #2f5ce0) in the lower-right corner. Text reads on every cell.
    static let groundStops: [Stop] = [Stop(0.00, hex: 0x070707), Stop(0.40, hex: 0x070707),
                                      Stop(0.75, hex: 0x101010), Stop(1.00, hex: 0x161e35)]
    /// The same ground in the aqua appearance: paper → the raised paper → paper 6 % into the accent.
    static let paperStops: [Stop] = [Stop(0.00, hex: 0xffffff), Stop(0.40, hex: 0xffffff),
                                     Stop(0.75, hex: 0xf6f6f6), Stop(1.00, hex: 0xf2f5fd)]
    /// Bands on the ground: few, so the field stays quiet (the LUT lands on #070707 ×2, #0a0a0a, #101010, #161e35).
    static let groundBands = 4
    /// A loading skeleton (a thumbnail before it decodes): ground → raised, two bands, so the crosshatch is the placeholder.
    static let skeletonStopsDark: [Stop] = [Stop(0, hex: 0x070707), Stop(1, hex: 0x101010)]
    static let skeletonStopsLight: [Stop] = [Stop(0, hex: 0xffffff), Stop(1, hex: 0xf6f6f6)]
    /// The ASCII ramp the thinking indicator steps through, sparse → solid, one glyph per matrix cell.
    static let glyphRamp: [Character] = Array(" .:-=+*#%@")
    /// A wipe has 64 steps: one per Bayer rank.
    static let wipeSteps = 64

    /// Bands in a ramp (the icon's count): few, so each step is a wide zone the pattern carries.
    static let bands = 5
    /// Dither cell in POINTS: 1.5 pt — 3 device pixels on a Retina display, 2 at 1× — on the
    /// notch island, the meters and the blob's halo (whose pixels are a quarter cell: ≈ 1.5 pt
    /// wide × 2.6 pt tall at the field); `DitheredGradient` uses 2 pt on the Console's larger
    /// surfaces (grounds, heroes, skeletons, wipes), and the icon 2 pt at Dock size. One device
    /// pixel was too fine to see.
    static let cellPoints: CGFloat = 1.5
    /// The cell in device pixels at a backing scale, never below one pixel.
    static func cellPixels(scale: CGFloat, points: CGFloat = cellPoints) -> Int {
        let s = scale.isFinite ? max(1, scale) : 1
        let p = points.isFinite ? max(0, points) : cellPoints
        return max(1, Int((s * p).rounded()))
    }

    // MARK: pattern

    /// The threshold tile. `bayer8` (the default) is the classic ordered matrix — a regular,
    /// legible crosshatch with 64 densities between two bands; `bayer4` is coarser (16);
    /// `blueNoise` is the old void-and-cluster grain, kept for reference; `check-dither` in
    /// the Console harness pins the Bayer ranks.
    enum Pattern { case bayer8, bayer4, blueNoise }
    static let pattern: Pattern = .bayer8

    /// The raw ranks (0…63), row-major — `bayer8` is these as thresholds. Exposed for the tiles and the glyphs.
    static let bayer8Ranks: [Int] = [0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21]

    /// The 8×8 Bayer matrix as thresholds in (0,1): `(rank + 0.5) / 64`, row-major.
    static let bayer8: [Float] = bayer8Ranks.map { (Float($0) + 0.5) / 64 }
    /// The 4×4 matrix, the same way.
    static let bayer4: [Float] = {
        let ranks: [Int] = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]
        return ranks.map { (Float($0) + 0.5) / 16 }
    }()

    /// The active tile (thresholds, row-major, tileable) and its side. Stored, so a hot
    /// loop's read is a load; hoist both into locals before a pixel loop anyway.
    static let tile: [Float] = {
        switch pattern {
        case .bayer8: return bayer8
        case .bayer4: return bayer4
        case .blueNoise: return blueNoise
        }
    }()
    static let tileSize: Int = {
        switch pattern {
        case .bayer8: return 8
        case .bayer4: return 4
        case .blueNoise: return noiseSize
        }
    }()

    // MARK: direction

    /// Which way the ramp runs across the box; `u` = 0 at the start, 1 at the far edge.
    enum Direction: Hashable {
        /// Left → right.
        case horizontal
        /// Top → bottom.
        case vertical
        /// Upper-left → lower-right (the icon's light, always from the upper left).
        case diagonal
        /// Any angle, degrees clockwise from left → right.
        case angle(Int)

        /// The unit direction (x right, y down).
        var vector: SIMD2<Float> {
            switch self {
            case .horizontal: return SIMD2(1, 0)
            case .vertical: return SIMD2(0, 1)
            case .diagonal: return SIMD2(1, 1) / Float(2).squareRoot()
            case .angle(let d):
                let r = Float(d) * .pi / 180
                return SIMD2(cosf(r), sinf(r))
            }
        }

        /// The ramp parameter at a unit-box point (0…1 each way), spanning the whole box.
        @inline(__always) func parameter(x: Float, y: Float) -> Float {
            let v = vector
            let span = abs(v.x) + abs(v.y)
            return 0.5 + ((x - 0.5) * v.x + (y - 0.5) * v.y) / max(span, 1e-4)
        }
    }

    // MARK: ramp

    /// The colour at `u` along the stops (piecewise linear).
    static func ramp(_ u: Float, stops: [Stop]) -> SIMD3<Float> {
        guard let first = stops.first, let last = stops.last else { return SIMD3(repeating: 0) }
        if u <= first.u { return first.color }
        for i in 1..<stops.count where u <= stops[i].u {
            let lo = stops[i - 1], hi = stops[i]
            return mix(lo.color, hi.color, hi.u > lo.u ? (u - lo.u) / (hi.u - lo.u) : 1)
        }
        return last.color
    }

    /// The ramp at each of `bands + 1` quantised levels: a table, so a pixel is a lookup.
    static func lut(stops: [Stop], bands: Int) -> [SIMD3<Float>] {
        let n = max(1, bands)
        return (0...n).map { ramp(Float($0) / Float(n), stops: stops) }
    }

    /// Quantise `v` (0…1) to a step 0…`levels` with the tile's threshold `t`.
    @inline(__always) static func quantise(_ v: Float, _ levels: Float, _ t: Float) -> Int {
        Int(min(levels, floorf(clamp01(v) * levels + t)))
    }

    /// The tile's threshold for a device pixel (cells of `cell` pixels).
    @inline(__always) static func threshold(x: Int, y: Int, cell: Int) -> Float {
        let c = max(1, cell), n = tileSize
        return tile[((y / c) % n) * n + (x / c) % n]
    }

    // MARK: image

    /// A banded, dithered ramp as an image of `size` points at `scale`: `stops` along
    /// `direction`, `bands` levels, `cell`-pixel dither cells (nil = `cellPixels(scale:)`).
    /// Pure; blocks only on the tile (once). Draw it 1:1 with interpolation off so the
    /// dither stays crisp — or render at scale 1 and magnify by a whole factor (the same
    /// pixels, a quarter of the work), never stretch by a fraction.
    static func gradientImage(size: CGSize, scale: CGFloat, stops: [Stop] = orbStops, direction: Direction = .diagonal,
                              bands: Int = bands, cell: Int? = nil) -> CGImage? {
        let s = max(1, scale)
        // `Int(nan)` traps: a size that is not a number is no image.
        guard size.width.isFinite, size.height.isFinite, s.isFinite else { return nil }
        let W = Int((size.width * s).rounded()), H = Int((size.height * s).rounded())
        guard W > 0, H > 0, !stops.isEmpty else { return nil }
        let table = lut(stops: stops, bands: bands)
        let nb = Float(max(1, bands))
        let c = max(1, cell ?? cellPixels(scale: s))
        let tile = Dither.tile, n = tileSize
        var px = [UInt8](repeating: 0, count: W * H * 4)
        px.withUnsafeMutableBufferPointer { out in
            for y in 0..<H {
                let fy = (Float(y) + 0.5) / Float(H)
                let rowBase = y * W * 4
                let noiseRow = ((y / c) % n) * n
                for x in 0..<W {
                    let fx = (Float(x) + 0.5) / Float(W)
                    let t = tile[noiseRow + (x / c) % n]
                    let col = table[quantise(direction.parameter(x: fx, y: fy), nb, t)]
                    let i = rowBase + x * 4
                    out[i] = UInt8(clamping: Int(col.x.rounded()))
                    out[i + 1] = UInt8(clamping: Int(col.y.rounded()))
                    out[i + 2] = UInt8(clamping: Int(col.z.rounded()))
                    out[i + 3] = 255
                }
            }
        }
        return image(rgbx: px, width: W, height: H)
    }

    /// A coverage image (white × alpha, see `image(alpha:)`) of a rounded rect grown by `spread`
    /// pt: coverage 1 inside, falling linearly to 0 over `spread` outside the rect, quantised to
    /// `levels` and dithered in `cell` px. The image is `size + 2·spread` points a side; the
    /// rect sits centred in it. The dithered shadow under the capsule; nothing else uses it.
    static func coverageImage(size: CGSize, scale: CGFloat, cornerRadius: CGFloat, spread: CGFloat, levels: Int, cell: Int?) -> CGImage? {
        let s = max(1, scale)
        guard size.width.isFinite, size.height.isFinite, s.isFinite, spread.isFinite, cornerRadius.isFinite else { return nil }
        let grow = max(0, spread)
        let W = Int(((size.width + 2 * grow) * s).rounded()), H = Int(((size.height + 2 * grow) * s).rounded())
        guard W > 0, H > 0, size.width > 0, size.height > 0 else { return nil }
        let nl = Float(max(1, levels))
        let c = max(1, cell ?? cellPixels(scale: s))
        let tile = Dither.tile, n = tileSize
        // The rect in pixels, and its corner radius clamped to half its shorter side.
        let rw = Float(size.width * s), rh = Float(size.height * s)
        let r = Float(min(max(0, cornerRadius) * s, CGFloat(min(rw, rh)) / 2))
        let spreadPx = Float(grow * s)
        let cx = Float(W) / 2, cy = Float(H) / 2
        let hx = rw / 2 - r, hy = rh / 2 - r
        var px = [UInt8](repeating: 0, count: W * H)
        px.withUnsafeMutableBufferPointer { out in
            for y in 0..<H {
                let dy = max(0, abs(Float(y) + 0.5 - cy) - hy)
                let rowBase = y * W
                let noiseRow = ((y / c) % n) * n
                for x in 0..<W {
                    let dx = max(0, abs(Float(x) + 0.5 - cx) - hx)
                    // Signed distance to the rounded rect: the corner disc's, or the edge's.
                    let d = (dx * dx + dy * dy).squareRoot() - r
                    let cov: Float = d <= 0 ? 1 : (spreadPx > 0 ? clamp01(1 - d / spreadPx) : 0)
                    let t = tile[noiseRow + (x / c) % n]
                    let q = Float(quantise(cov, nl, t)) / nl
                    out[rowBase + x] = UInt8(clamping: Int((q * 255).rounded()))
                }
            }
        }
        return image(alpha: px, width: W, height: H)
    }

    /// An opaque sRGB image over an RGBX buffer (the notch's renderer uses it too).
    static func image(rgbx px: [UInt8], width W: Int, height H: Int) -> CGImage? {
        guard W > 0, H > 0, px.count >= W * H * 4,
              let provider = CGDataProvider(data: Data(px) as CFData),
              let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        return CGImage(width: W, height: H, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: W * 4, space: space,
                       bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue), provider: provider,
                       decode: nil, shouldInterpolate: false, intent: .defaultIntent)
    }

    /// A premultiplied RGBA image (the wipe tiles: white where covered, clear elsewhere).
    static func image(rgba px: [UInt8], width W: Int, height H: Int) -> CGImage? {
        guard W > 0, H > 0, px.count >= W * H * 4,
              let provider = CGDataProvider(data: Data(px) as CFData),
              let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        return CGImage(width: W, height: H, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: W * 4, space: space,
                       bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue), provider: provider,
                       decode: nil, shouldInterpolate: false, intent: .defaultIntent)
    }

    /// A coverage image over a one-byte-a-pixel buffer: white at that alpha, premultiplied
    /// (SwiftUI masks with the alpha; CoreGraphics' 8 bpp alpha-only format has no Swift
    /// initializer that takes the nil colour space it needs, so this is 4 bytes a pixel).
    static func image(alpha px: [UInt8], width W: Int, height H: Int) -> CGImage? {
        guard W > 0, H > 0, px.count >= W * H else { return nil }
        var rgba = [UInt8](repeating: 0, count: W * H * 4)
        for i in 0..<(W * H) {
            let a = px[i]
            let o = i * 4
            rgba[o] = a; rgba[o + 1] = a; rgba[o + 2] = a; rgba[o + 3] = a
        }
        return image(rgba: rgba, width: W, height: H)
    }

    // MARK: glyphs

    /// `cols` glyphs of Bayer row `row % 8`, advanced by 8 ranks per `frame` (0…7, one cycle
    /// per second at 8 fps): glyphRamp[((rank + 8·frame) % 64) * glyphRamp.count / 64].
    /// `frame < 0` is the still two-tone frame: "." below rank 32, "#" above. No allocation
    /// beyond the String; 16 lookups per 1/8 s for the largest indicator.
    static func glyphLine(frame: Int, row: Int, cols: Int) -> String {
        let r = ((row % 8) + 8) % 8
        let n = glyphRamp.count
        var line = ""
        line.reserveCapacity(max(0, cols))
        for c in 0..<max(0, cols) {
            let rank = bayer8Ranks[r * 8 + (c % 8)]
            if frame < 0 {
                line.append(rank < 32 ? "." : "#")
            } else {
                line.append(glyphRamp[((rank + 8 * (frame % 8)) % 64) * n / 64])
            }
        }
        return line
    }

    // MARK: cache

    struct Key: Hashable {
        /// What the key renders: a colour ramp (`gradientImage`) or the capsule's shadow
        /// coverage (`coverageImage`, alpha-only, a corner radius and a spread in pt × 100).
        enum Kind: Hashable {
            case ramp
            case coverage(cornerRadius100: Int, spread100: Int, levels: Int)
        }

        /// Pixels.
        let width: Int
        let height: Int
        let stops: [Stop]
        let direction: Direction
        let bands: Int
        let cell: Int
        /// Backing scale × 100.
        let scale100: Int
        var kind: Kind = .ramp

        init(size: CGSize, scale: CGFloat, stops: [Stop], direction: Direction, bands: Int, cell: Int, kind: Kind = .ramp) {
            // A size that is not a number keys a 1×1 image rather than trapping in `Int(nan)`.
            let s = scale.isFinite ? max(1, scale) : 1
            width = size.width.isFinite ? max(1, Int((size.width * s).rounded())) : 1
            height = size.height.isFinite ? max(1, Int((size.height * s).rounded())) : 1
            self.stops = stops
            self.direction = direction
            self.bands = bands
            self.cell = cell
            scale100 = Int((s * 100).rounded())
            self.kind = kind
        }

        var pointSize: CGSize {
            let s = CGFloat(scale100) / 100
            return CGSize(width: CGFloat(width) / s, height: CGFloat(height) / s)
        }

        /// What the rendered image costs: 4 bytes a pixel (a coverage image is the grown rect, a little more).
        var bytes: Int { width * height * 4 }
    }

    /// Rendered gradients by key, filled by one background worker: ask, get the image
    /// at once if it is there, else nil now and a call on the main thread when it lands.
    /// LRU by BYTES (`budgetBytes`; `capacity` is a second cap on the count), so a few
    /// ground-sized images and many small ones share the same ceiling; a static surface
    /// is a dictionary hit every frame. The queue of sizes waiting to render is capped
    /// (`pendingCap`): a live resize drops its stalest sizes instead of rendering every
    /// frame's.
    @MainActor
    final class Cache {
        static let shared = Cache()

        private var images: [Key: CGImage] = [:]
        private var order: [Key] = []
        private var bytes: [Key: Int] = [:]
        private var totalBytes = 0
        private var waiting: [Key: [(CGImage) -> Void]] = [:]
        private var pending: [Key] = []
        /// The key on the render queue right now (nil between renders): a second ask for it
        /// registers its waiter and renders nothing twice.
        private var inFlight: Key?
        private let capacity = 32
        private let budgetBytes = 48 << 20
        private let pendingCap = 4

        /// The image for `key` if rendered; otherwise it is queued (most recent first)
        /// and `landed` is called on the main thread with it — once, when it is.
        func image(for key: Key, landed: ((CGImage) -> Void)? = nil) -> CGImage? {
            if let img = images[key] {
                if order.last != key, let i = order.firstIndex(of: key) { order.remove(at: i); order.append(key) }
                return img
            }
            if let landed { waiting[key, default: []].append(landed) }
            // Already rendering (every JarheadMark in the rail asks for the same 28 px key on its
            // first frame): the waiter is registered above; the image lands once for all of them.
            if key == inFlight { return nil }
            if let i = pending.firstIndex(of: key) { pending.remove(at: i) }
            pending.append(key)
            // Too many sizes in flight (a resize drag): the stalest go, with their waiters.
            while pending.count > pendingCap {
                let stale = pending.removeFirst()
                waiting[stale] = nil
            }
            pump()
            return nil
        }

        private func pump() {
            guard inFlight == nil, let key = pending.popLast() else { return }
            inFlight = key
            let owner = self
            Dither.renderQueue.async {
                let scale = CGFloat(key.scale100) / 100
                let img: CGImage?
                switch key.kind {
                case .ramp:
                    img = Dither.gradientImage(size: key.pointSize, scale: scale, stops: key.stops,
                                               direction: key.direction, bands: key.bands, cell: key.cell)
                case .coverage(let radius100, let spread100, let levels):
                    img = Dither.coverageImage(size: key.pointSize, scale: scale, cornerRadius: CGFloat(radius100) / 100,
                                               spread: CGFloat(spread100) / 100, levels: levels, cell: key.cell)
                }
                DispatchQueue.main.async {
                    MainActor.assumeIsolated { owner.landed(key, img) }
                }
            }
        }

        private func landed(_ key: Key, _ img: CGImage?) {
            inFlight = nil
            if let img {
                if images[key] == nil {
                    order.append(key)
                    let b = key.bytes
                    bytes[key] = b
                    totalBytes += b
                }
                images[key] = img
                // Over budget (bytes or count): the least recently used go, never the one that just landed.
                while (totalBytes > budgetBytes || order.count > capacity), order.count > 1 {
                    evict(order.removeFirst())
                }
                for cb in waiting.removeValue(forKey: key) ?? [] { cb(img) }
            } else {
                waiting[key] = nil
            }
            pump()
        }

        private func evict(_ key: Key) {
            images[key] = nil
            totalBytes -= bytes.removeValue(forKey: key) ?? 0
        }
    }

    // MARK: tiles

    /// The tiny precomputed tiles per-frame code masks with: the 65 wipe tiles (one per Bayer
    /// rank, plus the empty and the full) and the progress bar's leading edge. Built once by
    /// `prewarm(scale:)` on the render queue and landed here; nil until then, so a wipe before
    /// they exist degrades to a fade and a bar's edge to a hard cell boundary. An
    /// ObservableObject (`generation` bumps as a set lands), so a view that asked before they
    /// were there — a static meter — redraws with them once. The app should `prewarm` at launch
    /// (AppDelegate; the harnesses do); if nothing did, the first wipe or meter that asks
    /// (`ensure(scale:)`) starts the build for its scale and takes its fallback once — never
    /// forever.
    @MainActor
    final class Tiles: ObservableObject {
        static let shared = Tiles()

        /// Bumped each time a tile set lands.
        @Published private(set) var generation = 0

        private struct EdgeKey: Hashable { let cell: Int; let rows: Int }
        private var wipes: [Int: [CGImage]] = [:]
        private var wipesInverted: [Int: [CGImage]] = [:]
        private var edges: [EdgeKey: CGImage] = [:]
        /// Wipe cell sizes a `prewarm(scale:)` has been started for (landed or not).
        private var requested: Set<Int> = []

        /// The lazy path: build the tiles for `scale` unless a `prewarm(scale:)` already started
        /// them. Cheap when they are there (one set lookup); a surface calls it before it asks.
        func ensure(scale: CGFloat) {
            let cell = Dither.cellPixels(scale: scale, points: 2)
            guard wipes[cell] == nil, !requested.contains(cell) else { return }
            Dither.prewarm(scale: scale)
        }

        fileprivate func noteRequested(wipeCell: Int) { requested.insert(wipeCell) }

        /// 65 wipe tiles per cell size: tile k is 8·cell px square, premultiplied white α 255 where
        /// bayer8Ranks[i] < k, else 0; `inverted` tiles hold the complement (ranks ≥ k). Nil until
        /// `prewarm(scale:)` has landed them.
        func wipe(step k: Int, cell: Int, inverted: Bool) -> CGImage? {
            guard let set = (inverted ? wipesInverted : wipes)[cell], set.count == wipeSteps + 1 else { return nil }
            return set[max(0, min(wipeSteps, k))]
        }

        /// The progress bar's leading edge: 8 cells wide × `rows` cells tall, a coverage image; cell (i, j)
        /// is opaque iff bayer8 threshold (i, j) ≥ (i + 0.5) / 8 — coverage falls left → right across
        /// one Bayer period.
        func edge(cell: Int, rows: Int) -> CGImage? { edges[EdgeKey(cell: cell, rows: rows)] }

        var hasWipe: Bool { !wipes.isEmpty }

        fileprivate func land(wipes w: [CGImage], inverted wi: [CGImage], cell: Int) {
            guard w.count == wipeSteps + 1, wi.count == wipeSteps + 1 else { return }
            wipes[cell] = w
            wipesInverted[cell] = wi
            generation += 1
        }

        fileprivate func land(edge: CGImage, cell: Int, rows: Int) {
            edges[EdgeKey(cell: cell, rows: rows)] = edge
            generation += 1
        }
    }

    /// One wipe tile (see `Tiles.wipe`). Pure.
    static func wipeTile(step k: Int, cell: Int, inverted: Bool) -> CGImage? {
        let c = max(1, cell), side = 8 * c
        var px = [UInt8](repeating: 0, count: side * side * 4)
        for y in 0..<side {
            for x in 0..<side {
                let rank = bayer8Ranks[(y / c) * 8 + (x / c)]
                let on = inverted ? rank >= k : rank < k
                if on {
                    let i = (y * side + x) * 4
                    px[i] = 255; px[i + 1] = 255; px[i + 2] = 255; px[i + 3] = 255
                }
            }
        }
        return image(rgba: px, width: side, height: side)
    }

    /// One edge tile (see `Tiles.edge`). Pure.
    static func edgeTile(cell: Int, rows: Int) -> CGImage? {
        let c = max(1, cell), r = max(1, rows)
        let W = 8 * c, H = r * c
        var px = [UInt8](repeating: 0, count: W * H)
        for y in 0..<H {
            for x in 0..<W {
                let i = x / c, j = (y / c) % 8
                if bayer8[j * 8 + i] >= (Float(i) + 0.5) / 8 { px[y * W + x] = 255 }
            }
        }
        return image(alpha: px, width: W, height: H)
    }

    /// Build the tile sets for one backing scale on `renderQueue` and land them on main: wipes at
    /// cellPixels(scale, 2 pt) both ways, edges at cellPixels(scale, 1.5 pt) for rows 4 and 2. ~70 k
    /// pixels, once. Also starts the threshold tile so the first surface that asks does not pay for it.
    static func prewarm(scale: CGFloat) {
        let wipeCell = cellPixels(scale: scale, points: 2)
        let edgeCell = cellPixels(scale: scale, points: cellPoints)
        // Remember the ask (callers are on main: AppDelegate, the harnesses, `Tiles.ensure`), so the
        // lazy path does not build the same set twice; off main it is merely not remembered.
        if Thread.isMainThread { MainActor.assumeIsolated { Tiles.shared.noteRequested(wipeCell: wipeCell) } }
        renderQueue.async {
            _ = tile
            let w = (0...wipeSteps).compactMap { wipeTile(step: $0, cell: wipeCell, inverted: false) }
            let wi = (0...wipeSteps).compactMap { wipeTile(step: $0, cell: wipeCell, inverted: true) }
            let e4 = edgeTile(cell: edgeCell, rows: 4)
            let e2 = edgeTile(cell: edgeCell, rows: 2)
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    Tiles.shared.land(wipes: w, inverted: wi, cell: wipeCell)
                    if let e4 { Tiles.shared.land(edge: e4, cell: edgeCell, rows: 4) }
                    if let e2 { Tiles.shared.land(edge: e2, cell: edgeCell, rows: 2) }
                }
            }
        }
    }

    /// The old entry point: a Retina backing scale.
    static func prewarm() { prewarm(scale: 2) }

    // MARK: render queue + blue noise (reference)

    /// Serial: the tile is computed here (swift_once on this thread, never on main), and
    /// so is every cached image.
    nonisolated static let renderQueue = DispatchQueue(label: "jarhead.dither", qos: .userInitiated)

    static let noiseSize = 64

    /// A tileable void-and-cluster threshold array in [0,1), computed once. swift_once
    /// blocks whoever reads it first until it is done — `renderQueue` is the intended
    /// first reader (`prewarm`, the cache's worker), so the main thread never waits for
    /// it. The Gaussian is truncated at 4σ — a 13×13 stamp instead of the whole tile per
    /// update — so a 64×64 tile is tens of milliseconds in an optimised build (seconds
    /// in a -Onone one).
    static let blueNoise: [Float] = voidAndCluster(n: noiseSize, sigma: 1.5, seed: 7, fill: 0.1)

    private struct Mulberry32 {
        var s: UInt32
        mutating func next() -> Float {
            s = s &+ 0x6d2b_79f5
            var t = (s ^ (s >> 15)) &* (1 | s)
            t = (t &+ ((t ^ (t >> 7)) &* (61 | t))) ^ t
            return Float(t ^ (t >> 14)) / 4_294_967_296
        }
    }

    /// Ulichney's void-and-cluster (the icon's, `scripts/make-icon.ts`): under a toroidal
    /// Gaussian the "largest void" rule of phase 2 and the "tightest cluster of zeros"
    /// rule of phase 3 pick the same pixel, so both phases share one loop.
    static func voidAndCluster(n: Int, sigma: Float, seed: UInt32, fill: Float) -> [Float] {
        let N = n * n
        var rnd = Mulberry32(s: seed)
        let radius = min(n / 2, Int((sigma * 4).rounded(.up)))
        let span = 2 * radius + 1
        var kern = [Float](repeating: 0, count: span * span)
        for dy in -radius...radius {
            for dx in -radius...radius {
                kern[(dy + radius) * span + (dx + radius)] = expf(-Float(dx * dx + dy * dy) / (2 * sigma * sigma))
            }
        }
        var E = [Float](repeating: 0, count: N)
        var on = [Bool](repeating: false, count: N)
        func add(_ p: Int, _ sign: Float) {
            let px = p % n, py = p / n
            for dy in -radius...radius {
                let y = (py + dy + n) % n
                let krow = (dy + radius) * span
                for dx in -radius...radius {
                    let x = (px + dx + n) % n
                    E[y * n + x] += sign * kern[krow + dx + radius]
                }
            }
        }
        func tightest() -> Int {
            var best = -1, bv = -Float.infinity
            for i in 0..<N where on[i] && E[i] > bv { bv = E[i]; best = i }
            return best
        }
        func largestVoid() -> Int {
            var best = -1, bv = Float.infinity
            for i in 0..<N where !on[i] && E[i] < bv { bv = E[i]; best = i }
            return best
        }

        var count = 0
        let target = max(1, Int(Float(N) * fill))
        while count < target {
            let p = min(N - 1, Int(rnd.next() * Float(N)))
            if !on[p] { on[p] = true; add(p, 1); count += 1 }
        }
        // Relax the initial pattern until removing the tightest cluster and filling the
        // largest void would put the same pixel back.
        for _ in 0..<N {
            let c = tightest()
            on[c] = false
            add(c, -1)
            let v = largestVoid()
            if v == c { on[c] = true; add(c, 1); break }
            on[v] = true
            add(v, 1)
        }
        var rank = [Int32](repeating: -1, count: N)
        let initialOn = on
        let initialE = E
        var r = count - 1
        while r >= 0 {
            let c = tightest()
            rank[c] = Int32(r)
            on[c] = false
            add(c, -1)
            r -= 1
        }
        on = initialOn
        E = initialE
        for rr in count..<N {
            let v = largestVoid()
            rank[v] = Int32(rr)
            on[v] = true
            add(v, 1)
        }
        var t = [Float](repeating: 0, count: N)
        for i in 0..<N { t[i] = (Float(rank[i]) + 0.5) / Float(N) }
        return t
    }

    // MARK: maths

    @inline(__always) static func clamp01(_ v: Float) -> Float { v < 0 ? 0 : (v > 1 ? 1 : v) }

    @inline(__always) static func mix(_ a: Float, _ b: Float, _ t: Float) -> Float { a + (b - a) * t }

    @inline(__always) static func mix(_ a: SIMD3<Float>, _ b: SIMD3<Float>, _ t: Float) -> SIMD3<Float> { a + (b - a) * t }

    @inline(__always) static func smoothstep(_ e0: Float, _ e1: Float, _ x: Float) -> Float {
        guard e1 > e0 else { return x >= e1 ? 1 : 0 }
        let t = clamp01((x - e0) / (e1 - e0))
        return t * t * (3 - 2 * t)
    }
}

// MARK: - SwiftUI

/// A dithered gradient filling its frame: the shaded surface for SwiftUI (a ground, a
/// hero, a skeleton). Renders in the background at the view's size and backing scale and
/// draws the image 1:1 with interpolation off; until the first image lands (a frame or
/// two, longer in a -Onone build) it shows `placeholder` (the ramp's middle colour by
/// default) flat. Once an image has landed it stays up while a new size renders — the
/// new one dissolves in over it (`Motion.wipe`), so a live resize never drops to the flat
/// colour. `sizeStep` rounds the rendered size UP to a multiple (the ground passes 64:
/// the key changes only across a 64 pt boundary and the image is drawn at that size
/// pinned to `anchor` inside the clip, so the whisper corner stays in the window's
/// corner and the uniform ink is what gets cropped). `renderScale` renders at another
/// backing scale and magnifies by nearest (the ground passes 1: 2 px cells drawn 2×
/// are the same pixels as a 2× render with 4 px cells, a quarter of the work and
/// memory). Use it where a `LinearGradient` would have gone; flat fills stay `Color`.
struct DitheredGradient: View {
    var stops: [Dither.Stop] = Dither.orbStops
    var direction: Dither.Direction = .diagonal
    var bands: Int = Dither.bands
    /// The dither cell in points: 2 on the Console's larger surfaces (the island uses `Dither.cellPoints`).
    var cellPoints: CGFloat = 2
    /// The flat colour before the first image lands; nil = the ramp's middle.
    var placeholder: Color? = nil
    /// Round the rendered size up to a multiple of this many points (0 = exact).
    var sizeStep: CGFloat = 0
    /// Render at this backing scale instead of the display's (nil), magnified by nearest.
    var renderScale: CGFloat? = nil
    /// Where a rendered image larger than the frame is pinned.
    var anchor: Alignment = .center

    @Environment(\.displayScale) private var displayScale
    @State private var image: CGImage?
    @State private var imageKey: Dither.Key?
    /// The key asked for last: a render that lands for an older one (the cache pops its queue
    /// newest first, so under a resize drag an older size can land last) is ignored.
    @State private var requested: Dither.Key?

    /// `size` rounded up to a multiple of `step` on each side (the ground's 64 pt step).
    static func rounded(_ size: CGSize, step: CGFloat) -> CGSize {
        guard step > 0, step.isFinite, size.width.isFinite, size.height.isFinite else { return size }
        return CGSize(width: (size.width / step).rounded(.up) * step, height: (size.height / step).rounded(.up) * step)
    }

    var body: some View {
        GeometryReader { geo in
            let scale = renderScale ?? displayScale
            let size = Self.rounded(geo.size, step: sizeStep)
            let key = Dither.Key(size: size, scale: scale, stops: stops, direction: direction, bands: bands,
                                 cell: Dither.cellPixels(scale: scale, points: cellPoints))
            ZStack(alignment: anchor) {
                if let image, let imageKey {
                    Image(decorative: image, scale: CGFloat(imageKey.scale100) / 100)
                        .resizable()
                        .interpolation(.none)
                        .frame(width: imageKey.pointSize.width, height: imageKey.pointSize.height)
                        .id(imageKey)
                        .transition(Motion.wipe)
                } else {
                    placeholderColor
                }
            }
            .frame(width: geo.size.width, height: geo.size.height, alignment: anchor)
            .clipped()
            .animation(Motion.animation(Motion.easeOut, Motion.base), value: imageKey)
            .onAppear { request(key) }
            .onChange(of: key) { _, k in request(k) }
        }
    }

    /// The flat colour while the image renders: `placeholder`, or the ramp's middle.
    private var placeholderColor: Color {
        if let placeholder { return placeholder }
        let c = Dither.ramp(0.5, stops: stops) / 255
        return Color(red: Double(c.x), green: Double(c.y), blue: Double(c.z))
    }

    private func request(_ key: Dither.Key) {
        guard key.width > 0, key.height > 0 else { return }
        requested = key
        if let img = Dither.Cache.shared.image(for: key, landed: { img in
            guard key == requested else { return }
            image = img
            imageKey = key
        }) {
            image = img
            imageKey = key
        }
    }
}

/// The dither wipe: the view is masked to the cells whose Bayer rank is below `progress`
/// × 64 (or, `inverted`, at or above (1 − `progress`) × 64 — the complement, so a leaving
/// view and an arriving one tile the surface exactly at every instant), tiled at
/// `cellPoints` from the view's top-leading corner. Animatable, so `.modifier(active:
/// identity:)` drives it as a transition (`Motion.wipe`). The mask is always applied while
/// the modifier is present — a full `Rectangle` once every rank is in, `Color.clear` before
/// any is — never an `if` around the content, so the view's state survives the wipe. When
/// the tiles are not there yet it degrades to opacity. For SMALL views only (a thumbnail,
/// a mark, a ground image landing): a mask makes RenderBox rasterise the masked view
/// through CoreGraphics every frame, 0.3–0.5 s for a pane of text — a pane switches
/// behind `DitherCurtain` instead.
struct DitherWipe: ViewModifier, Animatable {
    var progress: Double
    var inverted = false
    var cellPoints: CGFloat = 2

    @Environment(\.displayScale) private var displayScale

    var animatableData: Double {
        get { progress }
        set { progress = newValue }
    }

    func body(content: Content) -> some View {
        let p = progress.isFinite ? max(0, min(1, progress)) : 1
        let k = Int((Double(Dither.wipeSteps) * (inverted ? 1 - p : p)).rounded())
        let cell = Dither.cellPixels(scale: displayScale, points: cellPoints)
        content.mask(alignment: .topLeading) { maskView(k: k, cell: cell, visible: p) }
    }

    @ViewBuilder private func maskView(k: Int, cell: Int, visible: Double) -> some View {
        let full = inverted ? k <= 0 : k >= Dither.wipeSteps
        let none = inverted ? k >= Dither.wipeSteps : k <= 0
        let _ = Dither.Tiles.shared.ensure(scale: displayScale)
        if full {
            Rectangle()
        } else if none {
            Color.clear
        } else if let tile = Dither.Tiles.shared.wipe(step: k, cell: cell, inverted: inverted) {
            Image(decorative: tile, scale: displayScale)
                .resizable(resizingMode: .tile)
                .interpolation(.none)
        } else {
            Rectangle().opacity(visible)
        }
    }
}

/// The curtain a pane switch happens behind: an opaque sheet of `color` — the ground the panes
/// sit on, passed in because this file must not name `ConsoleTheme` — laid OVER the arriving pane
/// as the inverted wipe tiles, gone rank by rank as `progress` runs 0 → 1 (at 0 every cell is
/// there, at 1 none), so the new pane emerges through the crosshatch from the ground. The pane
/// renders plainly underneath: nothing is masked, no pane is rasterised through CoreGraphics (a
/// `.mask` on a pane of text cost the main thread 0.3–0.5 s for its first frame, longer than the
/// wipe). Per frame this is one precomputed 8×8-cell tile (`Dither.Tiles`, a dictionary lookup)
/// tiled across the sheet as a template image in `color` — a layer's contents changing, never
/// pixel work. Animatable; `Motion.curtain(_:)` drives it as a transition through `Reveal`.
/// Under Reduce Motion, or before the tiles have landed, the sheet fades instead (`color` at
/// 1 − progress): a plain fade through the ground. Never hit-testable; the pane under it is.
/// Deliberately NOT `Animatable` itself: `Reveal` is, and hands the interpolated progress down
/// each frame — a second `Animatable` layer here made SwiftUI chase each frame's value with a
/// fresh animation of its own, and the curtain crawled (0.5 of the ranks 2.4 s into a 2 s wipe).
struct DitherCurtain: View {
    /// 0 = every cell (the pane is covered), 1 = none (the curtain is gone).
    var progress: Double
    /// The ground colour behind the panes (`ConsoleTheme.ground`, dynamic for both appearances).
    var color: Color
    var cellPoints: CGFloat = 2

    @Environment(\.displayScale) private var displayScale

    var body: some View {
        let p = progress.isFinite ? max(0, min(1, progress)) : 1
        let k = Int((Double(Dither.wipeSteps) * p).rounded())
        let cell = Dither.cellPixels(scale: displayScale, points: cellPoints)
        let _ = Dither.Tiles.shared.ensure(scale: displayScale)
        let _ = Motion.noteCurtain(progress: p)
        ZStack {
            if k >= Dither.wipeSteps {
                Color.clear
            } else if k <= 0 {
                color
            } else if !Motion.reduced, let tile = Dither.Tiles.shared.wipe(step: k, cell: cell, inverted: true) {
                // The inverted tile: white α 255 where rank ≥ k. As a template image it is `color` there
                // and nothing elsewhere, tiled from the top-leading corner, drawn 1:1.
                Image(decorative: tile, scale: displayScale)
                    .resizable(resizingMode: .tile)
                    .interpolation(.none)
                    .renderingMode(.template)
                    .foregroundStyle(color)
            } else {
                color.opacity(1 - p)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    /// The transition vehicle: laid over a clear placeholder that fills the pane's frame
    /// (`Motion.curtain`), so `.modifier(active: Reveal(progress: 0), identity: Reveal(progress: 1))`
    /// animates the curtain away as the placeholder arrives.
    struct Reveal: ViewModifier, Animatable {
        var progress: Double
        var color: Color

        var animatableData: Double {
            get { progress }
            set { progress = newValue }
        }

        func body(content: Content) -> some View {
            content.overlay(DitherCurtain(progress: progress, color: color))
        }
    }
}

/// A banded, cell-aligned meter: `track` flat, `fill` flat for fillCells − 8 cells, then the
/// 8-cell edge tile (coverage falling through the Bayer thresholds). fillCells = floor(fraction
/// · floor(width / cell)); every width is a multiple of `cellPoints`. `height` 6 pt = 4 rows of
/// 1.5 pt (`DitheredBar.height`; 3 pt = rows 2, whose edge tile is prewarmed too). Animatable
/// on `fraction`, so the parent's `.animation(_, value:)` steps the fill per cell.
struct DitheredBar: View, Animatable {
    var fraction: Double
    let fill: Color
    let track: Color
    var height: CGFloat = DitheredBar.height
    var cellPoints: CGFloat = 1.5

    /// The meter's height: 6 pt, four rows of 1.5 pt cells (Prototemplate's 3 pt is rows 2).
    static let height: CGFloat = 6
    /// The leading edge is one Bayer period wide.
    static let edgeCells = 8

    @Environment(\.displayScale) private var displayScale
    /// The edge tile may land after the first body: observe, so a static bar picks it up.
    @ObservedObject private var tiles = Dither.Tiles.shared

    init(fraction: Double, fill: Color, track: Color, height: CGFloat = DitheredBar.height, cellPoints: CGFloat = 1.5) {
        self.fraction = fraction
        self.fill = fill
        self.track = track
        self.height = height
        self.cellPoints = cellPoints
    }

    var animatableData: Double {
        get { fraction }
        set { fraction = newValue }
    }

    /// How many whole cells fit across `width`.
    static func totalCells(width: CGFloat, cell: CGFloat) -> Int {
        guard cell > 0, width.isFinite, width > 0 else { return 0 }
        return Int((width / cell).rounded(.down))
    }

    /// How many cells `fraction` fills of a `width`-wide bar: floor(fraction · floor(width / cell)).
    static func fillCells(fraction: Double, width: CGFloat, cell: CGFloat) -> Int {
        let total = totalCells(width: width, cell: cell)
        let f = fraction.isFinite ? max(0, min(1, fraction)) : 0
        return Int((f * Double(total)).rounded(.down))
    }

    var body: some View {
        GeometryReader { g in
            let cell = cellPoints
            let total = Self.totalCells(width: g.size.width, cell: cell)
            let filled = Self.fillCells(fraction: fraction, width: g.size.width, cell: cell)
            let rows = max(1, Int((height / cell).rounded()))
            let solid = max(0, filled - Self.edgeCells)
            let edge = min(Self.edgeCells, filled)
            let cellPx = Dither.cellPixels(scale: displayScale, points: cell)
            let _ = tiles.ensure(scale: displayScale)
            ZStack(alignment: .leading) {
                track.frame(width: CGFloat(total) * cell)
                HStack(spacing: 0) {
                    fill.frame(width: CGFloat(solid) * cell)
                    if edge > 0 {
                        fill.frame(width: CGFloat(Self.edgeCells) * cell, height: CGFloat(rows) * cell)
                            .mask(alignment: .leading) {
                                if let tile = tiles.edge(cell: cellPx, rows: rows) {
                                    Image(decorative: tile, scale: displayScale).interpolation(.none)
                                } else {
                                    Rectangle()
                                }
                            }
                            .frame(width: CGFloat(edge) * cell, alignment: .leading)
                            .clipped()
                    }
                }
            }
        }
        .frame(height: height)
    }
}

/// The ASCII thinking indicator: `rows` lines of `cols` mono glyphs, one per matrix cell,
/// stepping the Bayer ranks through `Dither.glyphRamp` at `Motion.asciiFrame` (8 fps) on a
/// TimelineView; every instance shares the phase (frame = Int(date / Motion.asciiFrame) % 8).
/// Reduce Motion (the environment value or `Motion.reduced`): the TimelineView period is a
/// day and the line is `glyphLine(frame: -1)` — static two-tone.
struct DitherGlyphs: View {
    var cols = 8
    var rows = 1
    var font: Font = .system(size: 11, weight: .medium, design: .monospaced)
    var color: Color

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let still = reduceMotion || Motion.reduced
        TimelineView(.periodic(from: .now, by: still ? 86_400 : Motion.asciiFrame)) { ctx in
            let frame = still ? -1 : Int(ctx.date.timeIntervalSinceReferenceDate / Motion.asciiFrame) % 8
            VStack(alignment: .leading, spacing: 0) {
                ForEach(0..<max(1, rows), id: \.self) { row in
                    Text(Dither.glyphLine(frame: frame, row: row, cols: cols))
                }
            }
            .font(font)
            .foregroundStyle(color)
            .lineLimit(1)
            .fixedSize()
        }
        .accessibilityLabel("Working")
    }
}

/// The capsule's floor: `color` masked by `Dither.coverageImage` of the capsule's rect — a
/// rounded rect grown by `spread`, its coverage in 4 levels, 1.5 pt cells — offset `offsetY`.
/// Sized to the capsule (`size`) so it centres under it as a `.background`; the image is
/// `spread` larger each side and overflows. Rendered once per (size, scale) by `Dither.Cache`.
struct DitheredShadow: View {
    let size: CGSize
    let cornerRadius: CGFloat
    let color: Color
    var spread: CGFloat = 12
    var offsetY: CGFloat = 6

    @Environment(\.displayScale) private var displayScale
    @State private var image: CGImage?
    /// The key asked for last; an older render landing after it is ignored (see DitheredGradient).
    @State private var requested: Dither.Key?

    private var key: Dither.Key {
        Dither.Key(size: size, scale: displayScale, stops: [], direction: .diagonal, bands: 4,
                   cell: Dither.cellPixels(scale: displayScale, points: Dither.cellPoints),
                   kind: .coverage(cornerRadius100: Int((cornerRadius * 100).rounded()), spread100: Int((spread * 100).rounded()), levels: 4))
    }

    var body: some View {
        let key = self.key
        let grown = CGSize(width: size.width + 2 * spread, height: size.height + 2 * spread)
        ZStack {
            if let image {
                color
                    .frame(width: grown.width, height: grown.height)
                    .mask {
                        Image(decorative: image, scale: CGFloat(key.scale100) / 100)
                            .resizable()
                            .interpolation(.none)
                            .frame(width: grown.width, height: grown.height)
                    }
            }
        }
        .frame(width: size.width, height: size.height)
        .offset(y: offsetY)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .onAppear { request(key) }
        .onChange(of: key) { _, k in request(k) }
    }

    private func request(_ key: Dither.Key) {
        guard size.width > 0, size.height > 0, size.width.isFinite, size.height.isFinite else { return }
        requested = key
        if let img = Dither.Cache.shared.image(for: key, landed: { img in
            guard key == requested else { return }
            image = img
        }) {
            image = img
        }
    }
}
