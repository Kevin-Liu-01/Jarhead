import SwiftUI

// Annotation model + renderer for one overlay window. Coordinates here are LOCAL to
// the window's content view, origin top-left, y down (what SwiftUI Canvas uses).

enum AnnotationKind {
    case point(CGPoint, label: String?)
    case highlight(CGRect, label: String?)
    case path(from: CGPoint, to: CGPoint)
    case clickPulse(CGPoint)
}

struct Annotation: Identifiable {
    let id = UUID()
    let kind: AnnotationKind
    let createdAt: Date
    /// Seconds until it is removed. The last 0.3 s fade out.
    let ttl: TimeInterval
}

@MainActor
final class OverlayModel: ObservableObject {
    @Published private(set) var items: [Annotation] = []
    private var pruneTimer: Timer?

    func add(_ kind: AnnotationKind, ttl: TimeInterval) {
        items.append(Annotation(kind: kind, createdAt: Date(), ttl: max(0.2, ttl)))
        schedulePrune()
    }

    func clear() {
        items.removeAll()
        pruneTimer?.invalidate()
        pruneTimer = nil
    }

    private func schedulePrune() {
        guard pruneTimer == nil else { return }
        pruneTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                let now = Date()
                self.items.removeAll { now.timeIntervalSince($0.createdAt) >= $0.ttl }
                if self.items.isEmpty {
                    self.pruneTimer?.invalidate()
                    self.pruneTimer = nil
                }
            }
        }
    }
}

struct OverlayCanvasView: View {
    @ObservedObject var model: OverlayModel

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: model.items.isEmpty)) { timeline in
            Canvas(opaque: false, rendersAsynchronously: false) { ctx, _ in
                let now = timeline.date
                let reduced = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
                for a in model.items {
                    let age = now.timeIntervalSince(a.createdAt)
                    let fade = min(1, max(0, (a.ttl - age) / 0.3))
                    OverlayPainter.draw(a, age: age, fade: fade, reducedMotion: reduced, in: ctx)
                }
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

enum OverlayPainter {
    static let cyan = Color(red: 0x5a / 255, green: 0xd7 / 255, blue: 0xff / 255)
    static let green = Color(red: 0x6e / 255, green: 0xe7 / 255, blue: 0xa0 / 255)
    static let ground = Color(red: 0x0b / 255, green: 0x0c / 255, blue: 0x10 / 255)
    static let text = Color(red: 0xe8 / 255, green: 0xea / 255, blue: 0xf0 / 255)

    static func easeOut(_ x: Double) -> Double { let k = min(max(x, 0), 1); return 1 - pow(1 - k, 3) }

    static func draw(_ a: Annotation, age: TimeInterval, fade: Double, reducedMotion: Bool, in ctx: GraphicsContext) {
        var g = ctx
        g.opacity = fade
        switch a.kind {
        case .point(let p, let label):
            drawPoint(p, label: label, age: age, reducedMotion: reducedMotion, in: g)
        case .highlight(let r, let label):
            drawHighlight(r, label: label, age: age, reducedMotion: reducedMotion, in: g)
        case .path(let from, let to):
            drawPath(from: from, to: to, age: age, reducedMotion: reducedMotion, in: g)
        case .clickPulse(let p):
            drawPulse(p, age: age, in: g)
        }
    }

    // MARK: point → arrow sliding in from the upper-left, landing on the point.

    private static func drawPoint(_ p: CGPoint, label: String?, age: TimeInterval, reducedMotion: Bool, in ctx: GraphicsContext) {
        let slide = reducedMotion ? 1 : easeOut(age / 0.28)
        let dir = CGVector(dx: -1, dy: -1)          // arrow comes from the upper-left
        let len: CGFloat = 34
        let offset: CGFloat = 26 * CGFloat(1 - slide)
        let tip = CGPoint(x: p.x + dir.dx * offset, y: p.y + dir.dy * offset)
        let tail = CGPoint(x: tip.x + dir.dx * len, y: tip.y + dir.dy * len)

        var g = ctx
        g.opacity *= 0.35 + 0.65 * slide

        // Shaft.
        var shaft = Path()
        shaft.move(to: tail)
        shaft.addLine(to: CGPoint(x: tip.x + dir.dx * 7, y: tip.y + dir.dy * 7))
        g.stroke(shaft, with: .color(ground.opacity(0.6)), style: StrokeStyle(lineWidth: 5, lineCap: .round))
        g.stroke(shaft, with: .color(cyan), style: StrokeStyle(lineWidth: 2.5, lineCap: .round))

        // Head.
        let ang = atan2(-dir.dy, -dir.dx)       // pointing toward the target
        let headLen: CGFloat = 12, spread: CGFloat = 0.45
        var head = Path()
        head.move(to: tip)
        head.addLine(to: CGPoint(x: tip.x - headLen * cos(ang - spread), y: tip.y - headLen * sin(ang - spread)))
        head.addLine(to: CGPoint(x: tip.x - headLen * cos(ang + spread), y: tip.y - headLen * sin(ang + spread)))
        head.closeSubpath()
        g.stroke(head, with: .color(ground.opacity(0.6)), style: StrokeStyle(lineWidth: 3, lineJoin: .round))
        g.fill(head, with: .color(cyan))

        // Landing dot with a soft halo that settles as the arrow lands.
        let halo = 10 + 10 * CGFloat(1 - slide)
        ctx.fill(Path(ellipseIn: CGRect(x: p.x - halo, y: p.y - halo, width: halo * 2, height: halo * 2)),
                 with: .color(cyan.opacity(0.18 * slide)))
        ctx.fill(Path(ellipseIn: CGRect(x: p.x - 3, y: p.y - 3, width: 6, height: 6)), with: .color(cyan.opacity(slide)))

        if let label, !label.isEmpty {
            let anchor = CGPoint(x: tail.x + 6, y: tail.y - 8)
            drawPill(label, at: anchor, anchorEdge: .bottomLeading, tint: cyan, in: g)
        }
    }

    // MARK: highlight → rounded rect that draws itself.

    private static func drawHighlight(_ r: CGRect, label: String?, age: TimeInterval, reducedMotion: Bool, in ctx: GraphicsContext) {
        let p = reducedMotion ? 1 : easeOut(age / 0.5)
        let rect = r.insetBy(dx: -4, dy: -4)
        let radius = min(8, min(rect.width, rect.height) / 2)
        let full = Path(roundedRect: rect, cornerRadius: radius, style: .continuous)
        ctx.fill(full, with: .color(cyan.opacity(0.07 * p)))
        let drawn = p < 1 ? full.trimmedPath(from: 0, to: CGFloat(p)) : full
        ctx.stroke(drawn, with: .color(ground.opacity(0.5)), style: StrokeStyle(lineWidth: 4, lineCap: .round))
        ctx.stroke(drawn, with: .color(cyan), style: StrokeStyle(lineWidth: 2, lineCap: .round))
        if let label, !label.isEmpty, p > 0.6 {
            var g = ctx
            g.opacity *= (p - 0.6) / 0.4
            let above = rect.minY > 34
            let anchor = CGPoint(x: rect.minX, y: above ? rect.minY - 6 : rect.maxY + 6)
            drawPill(label, at: anchor, anchorEdge: above ? .bottomLeading : .topLeading, tint: cyan, in: g)
        }
    }

    // MARK: path → dotted trail growing from → to with a travelling head.

    private static func drawPath(from: CGPoint, to: CGPoint, age: TimeInterval, reducedMotion: Bool, in ctx: GraphicsContext) {
        let p = reducedMotion ? 1 : easeOut(age / 0.65)
        var line = Path()
        line.move(to: from)
        line.addLine(to: to)
        let drawn = p < 1 ? line.trimmedPath(from: 0, to: CGFloat(p)) : line
        let phase = reducedMotion ? 0 : -CGFloat(age) * 40
        ctx.stroke(drawn, with: .color(ground.opacity(0.5)), style: StrokeStyle(lineWidth: 5, lineCap: .round, dash: [3, 7], dashPhase: phase))
        ctx.stroke(drawn, with: .color(green), style: StrokeStyle(lineWidth: 2.5, lineCap: .round, dash: [3, 7], dashPhase: phase))
        let head = CGPoint(x: from.x + (to.x - from.x) * CGFloat(p), y: from.y + (to.y - from.y) * CGFloat(p))
        ctx.fill(Path(ellipseIn: CGRect(x: head.x - 9, y: head.y - 9, width: 18, height: 18)), with: .color(green.opacity(0.22)))
        ctx.fill(Path(ellipseIn: CGRect(x: head.x - 3.5, y: head.y - 3.5, width: 7, height: 7)), with: .color(green))
        // Origin marker.
        ctx.stroke(Path(ellipseIn: CGRect(x: from.x - 4, y: from.y - 4, width: 8, height: 8)), with: .color(green.opacity(0.8)), lineWidth: 1.5)
    }

    // MARK: click pulse → expanding ring, ~600 ms.

    private static func drawPulse(_ p: CGPoint, age: TimeInterval, in ctx: GraphicsContext) {
        let k = min(1, age / 0.6)
        let r = 6 + 26 * CGFloat(easeOut(k))
        var g = ctx
        g.opacity *= (1 - k)
        g.stroke(Path(ellipseIn: CGRect(x: p.x - r, y: p.y - r, width: r * 2, height: r * 2)), with: .color(green), lineWidth: 2.5)
        let r2 = r * 0.55
        g.fill(Path(ellipseIn: CGRect(x: p.x - r2, y: p.y - r2, width: r2 * 2, height: r2 * 2)), with: .color(green.opacity(0.18)))
        ctx.fill(Path(ellipseIn: CGRect(x: p.x - 3, y: p.y - 3, width: 6, height: 6)), with: .color(green.opacity(1 - k)))
    }

    // MARK: label pill

    enum PillAnchor { case bottomLeading, topLeading }

    private static func drawPill(_ label: String, at anchor: CGPoint, anchorEdge: PillAnchor, tint: Color, in ctx: GraphicsContext) {
        let resolved = ctx.resolve(Text(label).font(.system(size: 11.5, weight: .medium)).foregroundColor(text))
        let size = resolved.measure(in: CGSize(width: 320, height: 60))
        let padX: CGFloat = 9, padY: CGFloat = 5
        let w = size.width + padX * 2, h = size.height + padY * 2
        let origin: CGPoint
        switch anchorEdge {
        case .bottomLeading: origin = CGPoint(x: anchor.x, y: anchor.y - h)
        case .topLeading: origin = CGPoint(x: anchor.x, y: anchor.y)
        }
        let rect = CGRect(origin: origin, size: CGSize(width: w, height: h))
        let pill = Path(roundedRect: rect, cornerRadius: h / 2)
        ctx.fill(pill, with: .color(ground.opacity(0.88)))
        ctx.stroke(pill, with: .color(tint.opacity(0.55)), lineWidth: 1)
        ctx.draw(resolved, at: CGPoint(x: rect.midX, y: rect.midY), anchor: .center)
    }
}
