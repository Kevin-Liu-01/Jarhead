import AppKit
import QuartzCore

// The flight trail: while the blob crosses the screen on an `orb.fly`, it leaves a
// short dotted wake of itself — a handful of ghosts, each a stencil of the cells it
// was made of at that instant, dropped 120 ms apart and fading out behind it — so
// the movement reads on a busy desktop. Each ghost is its own small click-through
// window parked where the blob was, holding one image; nothing here is redrawn
// after it is dropped, and the fade runs in the render server (a layer opacity
// animation), so a flight with a trail costs the one image every 120 ms and nothing
// per frame. Off under reduce motion (the controller never drops).

// MARK: - Ghost image

enum BlobGhostImage {
    /// Every other cell of the field, as its own glyph, in the flight colour, on
    /// nothing: the blob's silhouette as a dotted stencil. Same metrics as the live
    /// field so a ghost dropped at the panel's frame lines up with where the blob was.
    static func render(cells: [UInt8], ramp: BlobRamp, color: RGB, size: CGSize, scale: CGFloat) -> CGImage? {
        let w = Int(size.width * scale), h = Int(size.height * scale)
        guard w > 0, h > 0,
              let cg = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                 space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(),
                                 bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        cg.scaleBy(x: scale, y: scale)

        let field = BlobMetrics.fieldSize
        let origin = CGPoint(x: (size.width - field.width) / 2, y: (size.height - field.height) / 2)
        let cw = BlobMetrics.cellWidth, rh = BlobMetrics.rowHeight
        let shift = BlobMetrics.baselineShift
        let glyphs = BlobGlyphs.shared
        let table = glyphs.table(for: ramp)
        let fontCount = glyphs.fonts.count
        var runs = [[CGGlyph]](repeating: [], count: fontCount)
        var positions = [[CGPoint]](repeating: [], count: fontCount)

        var i = 0
        for row in 0..<BlobSim.rows {
            // The bitmap is y-up; the field's row 0 is its top.
            let baseline = size.height - (origin.y + (CGFloat(row) + 0.5) * rh + shift)
            for col in 0..<BlobSim.cols {
                let idx = Int(cells[i]); i += 1
                guard idx > 0, (row + col) % 2 == 0, idx < table.count, let ref = table[idx] else { continue }
                runs[ref.font].append(ref.glyph)
                positions[ref.font].append(CGPoint(x: origin.x + CGFloat(col) * cw + (cw - ref.advance) / 2, y: baseline))
            }
        }

        cg.setAllowsAntialiasing(true)
        cg.setShouldAntialias(true)
        cg.setShouldSmoothFonts(false)
        cg.textMatrix = .identity
        cg.setFillColor(color.cgColor)
        for (f, entry) in glyphs.fonts.enumerated() where !runs[f].isEmpty {
            cg.setFont(entry.cg)
            cg.setFontSize(entry.size)
            cg.showGlyphs(runs[f], at: positions[f])
        }
        return cg.makeImage()
    }
}

// MARK: - Ghost window

/// One parked ghost: a borderless click-through window the size of the collapsed
/// orb, showing a single image that fades. Reused from a ring; `generation` tells a
/// late order-out from a ghost that has since been dropped again.
@MainActor
final class BlobGhostWindow: NSWindow {
    let imageLayer = CALayer()
    var generation = 0

    init(size: NSSize) {
        super.init(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
        level = .floating
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        ignoresMouseEvents = true
        isReleasedWhenClosed = false
        animationBehavior = .none
        hidesOnDeactivate = false
        isExcludedFromWindowsMenu = true
        let host = NSView(frame: NSRect(origin: .zero, size: size))
        host.wantsLayer = true
        host.layer?.backgroundColor = .clear
        imageLayer.frame = host.bounds
        imageLayer.contentsGravity = .resize
        imageLayer.isOpaque = false
        imageLayer.actions = ["contents": NSNull(), "bounds": NSNull(), "position": NSNull(), "hidden": NSNull()]
        host.layer?.addSublayer(imageLayer)
        contentView = host
        setAccessibilityElement(false)
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

// MARK: - Trail

@MainActor
final class BlobTrail {
    /// Ghosts alive at once. Dropped every `spacing`, each living `life`: 4–5 on screen mid-flight.
    static let capacity = 5
    static let spacing = 0.12
    static let life = 0.55
    static let peakOpacity: Float = 0.62

    private let size: NSSize
    private var ghosts: [BlobGhostWindow] = []
    private var next = 0
    private(set) var lastDropAt = -1.0

    init(size: NSSize) { self.size = size }

    /// Drop a ghost at the panel's current frame (AppKit), ordered just under the orb
    /// so the live blob always paints over its own wake.
    func drop(image: CGImage, frame: NSRect, below orb: NSWindow, at now: Double) {
        lastDropAt = now
        if ghosts.count < Self.capacity {
            ghosts.append(BlobGhostWindow(size: size))
        }
        let ghost = ghosts[next % ghosts.count]
        next += 1
        ghost.generation += 1
        let gen = ghost.generation

        ghost.setFrame(NSRect(origin: frame.origin, size: size), display: false)
        ghost.imageLayer.removeAllAnimations()
        ghost.imageLayer.contents = image
        ghost.imageLayer.contentsScale = orb.backingScaleFactor
        ghost.imageLayer.opacity = 0
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = Self.peakOpacity
        fade.toValue = 0
        fade.duration = Self.life
        fade.timingFunction = CAMediaTimingFunction(name: .easeIn)
        fade.isRemovedOnCompletion = false
        fade.fillMode = .forwards
        ghost.imageLayer.add(fade, forKey: "fade")
        ghost.order(.below, relativeTo: orb.windowNumber)

        DispatchQueue.main.asyncAfter(deadline: .now() + Self.life + 0.05) { [weak ghost] in
            guard let ghost, ghost.generation == gen else { return }
            ghost.orderOut(nil)
        }
    }

    /// Take the wake down now (the flight was cancelled, the orb hidden).
    func clear() {
        for g in ghosts {
            g.generation += 1
            g.imageLayer.removeAllAnimations()
            g.orderOut(nil)
        }
        lastDropAt = -1
    }

    /// Frames (AppKit) of the ghosts currently showing, for the preview's screenshots.
    var visibleFrames: [NSRect] { ghosts.filter(\.isVisible).map(\.frame) }

    /// Draw the showing ghosts as they are mid-fade (the presentation layer carries the
    /// animated opacity; the model is already 0) into a context whose origin is
    /// `offset` in AppKit screen space. For the preview's in-process screenshots.
    func render(in ctx: CGContext, offset: NSPoint) {
        for g in ghosts where g.isVisible {
            guard let layer = g.imageLayer.presentation() ?? Optional(g.imageLayer) else { continue }
            ctx.saveGState()
            ctx.translateBy(x: g.frame.minX - offset.x, y: g.frame.minY - offset.y)
            layer.render(in: ctx)
            ctx.restoreGState()
        }
    }
}
