import AppKit
import SwiftUI

// The one way a shaded surface is drawn in this app.
//
// Kevin (2026-09-11): "make the icon and any gradients or designs be dithered." Flat
// fills stay flat; anything that shades — a ramp, a glow, a vignette — is quantised
// into a few bands and dithered with a blue-noise tile at device-pixel resolution, so
// it reads as grain, never as a smooth gradient. The app icon does the same
// (`scripts/make-icon.ts`: the same void-and-cluster tile, the same `ORB_STOPS`
// palette, the same band count), so the Dock, the notch island and any future shaded
// surface are one material.
//
// `Dither.gradientImage` is the renderer: a banded, dithered ramp between `stops`
// along a `direction`, as a `CGImage` at a backing scale. It is pure and thread-
// agnostic; it blocks only on the tile, which is computed once and cached — on
// `renderQueue`, never on the main thread (`prewarm` starts it early). `Dither.Cache`
// renders in the background and hands the image back on the main thread;
// `DitheredGradient` is the SwiftUI view over it, for the Console, Onboarding and
// anything else declarative. `NotchInk` composes its island out of the same pieces
// (the tile, the palette, `lut` / `quantise`) with its own notch-specific shading.
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
    /// Ink to the accent: for a shaded ground rather than a coloured one.
    static let inkStops: [Stop] = [
        Stop(0.0, hex: 0x070707),
        Stop(0.5, hex: 0x101010),
        Stop(1.0, hex: 0x2f5ce0),
    ]

    /// Bands in a ramp (the icon's count below 256 px): few enough that the dither shows.
    static let bands = 7
    /// Dither cell in device pixels: 1 at every point size (the icon uses 1 px below 128).
    static let cell = 1

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

    /// Quantise `v` (0…1) to a step 0…`levels` with the blue-noise threshold `t`.
    @inline(__always) static func quantise(_ v: Float, _ levels: Float, _ t: Float) -> Int {
        Int(min(levels, floorf(clamp01(v) * levels + t)))
    }

    /// The tile's threshold for a device pixel (cells of `cell` pixels).
    @inline(__always) static func threshold(x: Int, y: Int, cell: Int = cell) -> Float {
        let c = max(1, cell)
        return blueNoise[((y / c) % noiseSize) * noiseSize + (x / c) % noiseSize]
    }

    // MARK: image

    /// A banded, dithered ramp as an image of `size` points at `scale`: `stops` along
    /// `direction`, `bands` levels, `cell`-pixel dither cells. Pure; blocks only on the
    /// tile (once). Draw it 1:1 with interpolation off so the dither stays crisp.
    static func gradientImage(size: CGSize, scale: CGFloat, stops: [Stop] = orbStops, direction: Direction = .diagonal,
                              bands: Int = bands, cell: Int = cell) -> CGImage? {
        let s = max(1, scale)
        let W = Int((size.width * s).rounded()), H = Int((size.height * s).rounded())
        guard W > 0, H > 0, !stops.isEmpty else { return nil }
        let table = lut(stops: stops, bands: bands)
        let nb = Float(max(1, bands))
        let c = max(1, cell)
        var px = [UInt8](repeating: 0, count: W * H * 4)
        px.withUnsafeMutableBufferPointer { out in
            for y in 0..<H {
                let fy = (Float(y) + 0.5) / Float(H)
                let rowBase = y * W * 4
                let noiseRow = ((y / c) % noiseSize) * noiseSize
                for x in 0..<W {
                    let fx = (Float(x) + 0.5) / Float(W)
                    let t = blueNoise[noiseRow + (x / c) % noiseSize]
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

    /// An opaque sRGB image over an RGBX buffer (the notch's renderer uses it too).
    static func image(rgbx px: [UInt8], width W: Int, height H: Int) -> CGImage? {
        guard W > 0, H > 0, px.count >= W * H * 4,
              let provider = CGDataProvider(data: Data(px) as CFData),
              let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        return CGImage(width: W, height: H, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: W * 4, space: space,
                       bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue), provider: provider,
                       decode: nil, shouldInterpolate: false, intent: .defaultIntent)
    }

    // MARK: cache

    struct Key: Hashable {
        /// Pixels.
        let width: Int
        let height: Int
        let stops: [Stop]
        let direction: Direction
        let bands: Int
        let cell: Int
        /// Backing scale × 100.
        let scale100: Int

        init(size: CGSize, scale: CGFloat, stops: [Stop], direction: Direction, bands: Int, cell: Int) {
            let s = max(1, scale)
            width = max(1, Int((size.width * s).rounded()))
            height = max(1, Int((size.height * s).rounded()))
            self.stops = stops
            self.direction = direction
            self.bands = bands
            self.cell = cell
            scale100 = Int((s * 100).rounded())
        }

        var pointSize: CGSize {
            let s = CGFloat(scale100) / 100
            return CGSize(width: CGFloat(width) / s, height: CGFloat(height) / s)
        }
    }

    /// Rendered gradients by key, filled by one background worker: ask, get the image
    /// at once if it is there, else nil now and a call on the main thread when it lands.
    /// Small LRU; a static surface is a dictionary hit every frame.
    @MainActor
    final class Cache {
        static let shared = Cache()

        private var images: [Key: CGImage] = [:]
        private var order: [Key] = []
        private var waiting: [Key: [(CGImage) -> Void]] = [:]
        private var pending: [Key] = []
        private var rendering = false
        private let capacity = 32

        /// The image for `key` if rendered; otherwise it is queued (most recent first)
        /// and `landed` is called on the main thread with it — once, when it is.
        func image(for key: Key, landed: ((CGImage) -> Void)? = nil) -> CGImage? {
            if let img = images[key] {
                if order.last != key, let i = order.firstIndex(of: key) { order.remove(at: i); order.append(key) }
                return img
            }
            if let landed { waiting[key, default: []].append(landed) }
            if let i = pending.firstIndex(of: key) { pending.remove(at: i) }
            pending.append(key)
            pump()
            return nil
        }

        private func pump() {
            guard !rendering, let key = pending.popLast() else { return }
            rendering = true
            let owner = self
            Dither.renderQueue.async {
                let img = Dither.gradientImage(size: key.pointSize, scale: CGFloat(key.scale100) / 100, stops: key.stops,
                                               direction: key.direction, bands: key.bands, cell: key.cell)
                DispatchQueue.main.async {
                    MainActor.assumeIsolated { owner.landed(key, img) }
                }
            }
        }

        private func landed(_ key: Key, _ img: CGImage?) {
            rendering = false
            if let img {
                images[key] = img
                order.append(key)
                if order.count > capacity { images[order.removeFirst()] = nil }
                for cb in waiting.removeValue(forKey: key) ?? [] { cb(img) }
            } else {
                waiting[key] = nil
            }
            pump()
        }
    }

    // MARK: blue noise

    /// Serial: the tile is computed here (swift_once on this thread, never on main), and
    /// so is every cached image.
    nonisolated static let renderQueue = DispatchQueue(label: "jarhead.dither", qos: .userInitiated)

    /// Start the tile on the render queue so the first surface that asks does not pay for it.
    static func prewarm() {
        renderQueue.async { _ = blueNoise }
    }

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

/// A dithered gradient filling its frame: the shaded surface for SwiftUI (a card's
/// ground, a header, a hero). Renders in the background at the view's size and backing
/// scale and draws the image 1:1 with interpolation off; until the first image lands
/// (a frame or two, longer in a -Onone build) it shows the ramp's middle colour flat.
/// Use it where a `LinearGradient` would have gone; flat fills stay `Color`.
struct DitheredGradient: View {
    var stops: [Dither.Stop] = Dither.orbStops
    var direction: Dither.Direction = .diagonal
    var bands: Int = Dither.bands

    @Environment(\.displayScale) private var displayScale
    @State private var image: CGImage?
    @State private var imageKey: Dither.Key?

    var body: some View {
        GeometryReader { geo in
            let key = Dither.Key(size: geo.size, scale: displayScale, stops: stops, direction: direction, bands: bands, cell: Dither.cell)
            ZStack {
                if let image, imageKey == key {
                    Image(decorative: image, scale: CGFloat(key.scale100) / 100)
                        .resizable()
                        .interpolation(.none)
                        .frame(width: geo.size.width, height: geo.size.height)
                } else {
                    placeholder
                }
            }
            .onAppear { request(key) }
            .onChange(of: key) { _, k in request(k) }
        }
    }

    /// The ramp's middle, flat, while the image renders.
    private var placeholder: Color {
        let c = Dither.ramp(0.5, stops: stops) / 255
        return Color(red: Double(c.x), green: Double(c.y), blue: Double(c.z))
    }

    private func request(_ key: Dither.Key) {
        guard key.width > 0, key.height > 0 else { return }
        if let img = Dither.Cache.shared.image(for: key, landed: { img in
            image = img
            imageKey = key
        }) {
            image = img
            imageKey = key
        }
    }
}
