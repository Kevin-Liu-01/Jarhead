import QuartzCore
import SwiftUI

// Annotation model + renderer for one overlay window. Coordinates here are LOCAL to
// the window's content view, origin top-left, y down (what SwiftUI Canvas uses).
//
// Two families live here. The hands' cues (point / highlight / path / click pulse)
// predate the teaching shapes and keep their cyan/green on the shapes themselves. The
// teaching shapes — circle / arrow / rect / text / stroke — take a tone: accent for
// Jarhead pointing, ok / warn for feedback, mark for Kevin's own circles (warm). Every
// label on the layer is the same pill (`drawLabel`: raised ink, paper text, a dot in
// the shape's colour) so the two families read as one product. Timing is Motion's
// (UI/Motion.swift), its curves evaluated per frame by `Motion.easeOutCurve` /
// `easeInCurve` (the same numbers Core Animation gets elsewhere): a shape draws itself on
// over `Motion.base` along `Motion.easeOut` (a text pill fades in over `Motion.quick`),
// its label fades in over `Motion.quick` once the shape has landed, it lives its ttl
// (6 s by default) and fades out over the last `Motion.base` along `Motion.easeIn`,
// gaining speed. Reduce Motion: no draw-on — the shape fades in whole — and every
// duration halved (`Motion.seconds`).
//
// A shape that touches two displays is handed to both windows; its label is drawn by
// exactly one of them (`Annotation.showsLabel`, decided in OverlayManager.spread from
// `OverlayPainter.label(for:)`), so a pill is never clamped into view on a display
// the shape is not on.
//
// Live strokes (`LiveStrokeItem`) are the third thing here: a line still being drawn
// — Kevin's in mark mode, the blob's on a trace — arrives on `AppState.liveStrokes`
// as the same id with more points each time and is updated in place, so it grows
// from under the pen with no draw-on; `done` seals it and it lives its ttl, then
// fades like a shape. Its label rides the pen while it draws and settles at the
// top-left of the line's box when done. One code path draws both hands' lines.

enum AnnotationKind {
    case point(CGPoint, label: String?)
    case highlight(CGRect, label: String?)
    case path(from: CGPoint, to: CGPoint)
    case clickPulse(CGPoint)
    // Teaching shapes.
    case circle(center: CGPoint, radius: CGFloat, label: String?, tone: OverlayTone)
    case arrow(from: CGPoint, to: CGPoint, label: String?, tone: OverlayTone)
    case rect(CGRect, label: String?, tone: OverlayTone)
    case text(CGPoint, String, tone: OverlayTone)
    case stroke([CGPoint], label: String?, tone: OverlayTone)
}

struct Annotation: Identifiable {
    let id = UUID()
    let kind: AnnotationKind
    let createdAt: Date
    /// Seconds until it is removed. The last `OverlayPainter.fadeSeconds` fade out.
    let ttl: TimeInterval
    /// Animate the shape drawing itself on. Off for a stroke that was already on
    /// screen live (mark mode's echo) so it does not redraw from the start.
    let drawOn: Bool
    /// Whether this window draws the label. Of the windows sharing a shape, only the
    /// one whose display holds the label's anchor does; the others draw the shape alone.
    let showsLabel: Bool
}

/// A line being drawn live on this window (local points): whose tone, its label,
/// and — once `done` — when it was sealed and how long it stays before fading.
struct LiveStrokeItem: Identifiable {
    let id: String
    var points: [CGPoint]
    var tone: OverlayTone
    var label: String?
    var done = false
    var doneAt: Date?
    /// Seconds it stays after `doneAt`; the last `OverlayPainter.fadeSeconds` fade.
    var ttl: TimeInterval = 0
    /// Whether this window draws the label (the one whose display holds its anchor).
    var showsLabel = true
}

@MainActor
final class OverlayModel: ObservableObject {
    @Published private(set) var items: [Annotation] = []
    /// Lines being drawn, in arrival order; sealed ones stay their ttl (see `LiveStrokeItem`).
    @Published private(set) var strokes: [LiveStrokeItem] = []

    // Mark mode, per window: a faint accent wash and an accent frame while it is on,
    // and the hint pill on the display under the cursor. Kevin's stroke itself comes
    // through `strokes`, like the blob's. The wash, the frame and the pill fade in when
    // the mode begins and out when it ends (`markModeChangedAt`, `markFading`): the
    // pill rides the same alpha, so `markHint` is left as it stands when the mode ends
    // and cleared here once the fade-out has run — a controller that cleared it first
    // would cut the pill on the frame the wash starts fading.
    @Published var markMode = false {
        didSet {
            guard markMode != oldValue else { return }
            markModeChangedAt = Date()
            if markMode {
                markFading = false
                fadeTimer?.invalidate(); fadeTimer = nil
            } else {
                // Keep painting until the fade-out has run (OverlayCanvasView's clock
                // watches `markFading`), then let the layer go quiet.
                markFading = true
                fadeTimer?.invalidate()
                fadeTimer = Timer.scheduledTimer(withTimeInterval: OverlayPainter.fadeSeconds + 0.05, repeats: false) { [weak self] _ in
                    MainActor.assumeIsolated {
                        guard let self, !self.markMode else { return }
                        self.markFading = false
                        self.markHint = false
                        self.fadeTimer = nil
                    }
                }
            }
        }
    }
    /// The hint pill is on this display. Set by the mark controller while the mode is
    /// on; it outlives the mode by the fade-out (see `markMode`).
    @Published var markHint = false
    /// When `markMode` last flipped: the wash and frame ease in or out from here.
    @Published private(set) var markModeChangedAt = Date.distantPast
    /// Mark mode has just ended and its frame is still fading out.
    @Published private(set) var markFading = false

    private var pruneTimer: Timer?
    private var fadeTimer: Timer?

    func add(_ kind: AnnotationKind, ttl: TimeInterval, drawOn: Bool = true, showsLabel: Bool = true) {
        items.append(Annotation(kind: kind, createdAt: Date(), ttl: max(0.2, ttl), drawOn: drawOn, showsLabel: showsLabel))
        schedulePrune()
    }

    func hasStroke(_ id: String) -> Bool { strokes.contains { $0.id == id } }

    /// A live stroke's latest state: updated in place by id (the points only ever
    /// grow), added when new. Sealing it starts its clock. One write to `strokes` per
    /// update — the item is built first — so the canvas is asked to repaint once, not
    /// once per field.
    func upsertStroke(id: String, points: [CGPoint], tone: OverlayTone, label: String?, done: Bool, ttl: TimeInterval, showsLabel: Bool) {
        if let i = strokes.firstIndex(where: { $0.id == id }) {
            var item = strokes[i]
            item.points = points
            item.tone = tone
            item.label = label
            item.showsLabel = showsLabel
            if done {
                if !item.done { item.doneAt = Date() }
                item.done = true
                item.ttl = ttl
            }
            strokes[i] = item
        } else {
            strokes.append(LiveStrokeItem(id: id, points: points, tone: tone, label: label, done: done, doneAt: done ? Date() : nil, ttl: ttl, showsLabel: showsLabel))
        }
        if done { schedulePrune() }
    }

    func removeStroke(id: String) {
        strokes.removeAll { $0.id == id }
    }

    func clear() {
        items.removeAll()
        strokes.removeAll()
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
                self.strokes.removeAll { s in s.done && s.doneAt.map { now.timeIntervalSince($0) >= s.ttl } ?? false }
                if self.items.isEmpty, !self.strokes.contains(where: \.done) {
                    self.pruneTimer?.invalidate()
                    self.pruneTimer = nil
                }
            }
        }
    }
}

struct OverlayCanvasView: View {
    @ObservedObject var model: OverlayModel
    /// Where the hint pill hangs from: the menu bar's height on this display (0 elsewhere).
    var topInset: CGFloat = 0

    var body: some View {
        // The clock runs only while something on the layer moves on its own: a shape
        // drawing itself on or fading, a sealed stroke fading, mark mode's frame (and
        // its fade-out after the mode ends). A line still being drawn has no motion of
        // its own — every change to it arrives as a publish, which repaints the canvas
        // by itself — so the clock stays paused for it and the display is painted once
        // per publish, not once per publish and 30 more times a second besides.
        TimelineView(.animation(minimumInterval: 1 / 30, paused: model.items.isEmpty && !model.markMode && !model.markFading && !model.strokes.contains(where: \.done))) { timeline in
            Canvas(opaque: false, rendersAsynchronously: false) { ctx, size in
                OverlayCanvasView.paint(model, now: timeline.date, topInset: topInset, size: size, in: ctx)
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    #if JARHEAD_ORB_PREVIEW
    /// Every paint of every overlay window, for the harness's paint-rate check.
    nonisolated(unsafe) static var paintCount = 0
    #endif

    /// One frame of the layer at `now`. The live view paints this every tick; the
    /// preview harness paints it offscreen (ImageRenderer) when it cannot screenshot.
    @MainActor
    static func paint(_ model: OverlayModel, now: Date, topInset: CGFloat, size: CGSize, in ctx: GraphicsContext) {
        #if JARHEAD_ORB_PREVIEW
        paintCount += 1
        #endif
        let reduced = Motion.reduced
        // Mark mode's wash and frame ease in (Motion.easeOut over Motion.base) when the
        // mode begins and out (Motion.easeIn) when it ends; the hint pill rides the same
        // alpha. Both are fades already, so Reduce Motion only shortens them.
        let markAlpha: Double
        if model.markMode || model.markFading {
            let since = now.timeIntervalSince(model.markModeChangedAt)
            markAlpha = model.markMode
                ? OverlayPainter.easeOut(since / OverlayPainter.drawSeconds)
                : 1 - OverlayPainter.easeIn(since / OverlayPainter.fadeSeconds)
        } else {
            markAlpha = 0
        }
        if markAlpha > 0 {
            OverlayPainter.drawMarkModeFrame(size, alpha: markAlpha, in: ctx)
        }
        for a in model.items {
            let age = now.timeIntervalSince(a.createdAt)
            let fade = OverlayPainter.fadeOut(remaining: a.ttl - age)
            OverlayPainter.draw(a, age: age, fade: fade, reducedMotion: reduced, bounds: size, in: ctx)
        }
        for s in model.strokes {
            OverlayPainter.drawLiveStroke(s, now: now, bounds: size, in: ctx)
        }
        if markAlpha > 0, model.markHint {
            var g = ctx
            g.opacity = markAlpha
            OverlayPainter.drawLabel("Circle something for Jarhead · Esc to cancel",
                                     at: CGPoint(x: size.width / 2, y: topInset + 12), anchor: .top,
                                     tone: .mark, mono: false, bounds: size, in: g)
        }
    }
}

enum OverlayPainter {
    // The hands' cues keep their colours.
    static let cyan = Color(red: 0x5a / 255, green: 0xd7 / 255, blue: 0xff / 255)
    static let green = Color(red: 0x6e / 255, green: 0xe7 / 255, blue: 0xa0 / 255)
    static let ground = Color(red: 0x0b / 255, green: 0x0c / 255, blue: 0x10 / 255)

    // Prototemplate: ink, raised ink, paper; one accent (dark), plus the feedback tones.
    static let ink = rgb(0x070707)
    static let raised = rgb(0x101010)
    static let paper = Color.white
    static let accent = rgb(0x5b82ff)
    static let ok = rgb(0x6ee7a0)
    static let warn = rgb(0xff5d6c)
    static let mark = rgb(0xffb454)

    static func rgb(_ hex: UInt32) -> Color {
        Color(.sRGB, red: Double((hex >> 16) & 0xff) / 255, green: Double((hex >> 8) & 0xff) / 255, blue: Double(hex & 0xff) / 255, opacity: 1)
    }

    static func color(_ tone: OverlayTone) -> Color {
        switch tone {
        case .accent: return accent
        case .ok: return ok
        case .warn: return warn
        case .mark: return mark
        }
    }

    // MARK: - Timing: Motion's, halved under Reduce Motion

    /// A teaching shape drawing itself on (`Motion.base`).
    static var drawSeconds: Double { Motion.seconds(Motion.base) }
    /// A text pill fading in; a label following its shape (`Motion.quick`).
    static var quickSeconds: Double { Motion.seconds(Motion.quick) }
    /// The fade at the end of a life (`Motion.base`, along `Motion.easeIn`).
    static var fadeSeconds: Double { Motion.seconds(Motion.base) }

    // The hands' cues (point / highlight / path / click pulse) run on the same curve and
    // on Motion's durations too — one vocabulary for both families, so a cue landing
    // next to a teaching shape moves like it. Draw-on is skipped under Reduce Motion.
    /// The point cue's arrow sliding in (`Motion.base`).
    static var pointSlideSeconds: Double { Motion.base }
    /// The highlight's rounded frame drawing itself around a region (`Motion.slow`).
    static var highlightSeconds: Double { Motion.slow }
    /// The path's dotted trail growing from → to (`Motion.drift`).
    static var pathSeconds: Double { Motion.drift }
    /// The click pulse's ring expanding and fading (`Motion.drift`; its ttl covers it).
    static var pulseSeconds: Double { Motion.drift }

    /// `Motion.easeOut` at `x` (clamped to 0…1): arrive fast, settle soft.
    static func easeOut(_ x: Double) -> Double { Motion.easeOutCurve.value(at: x) }
    /// `Motion.easeIn` at `x` (clamped to 0…1): leave gaining speed.
    static func easeIn(_ x: Double) -> Double { Motion.easeInCurve.value(at: x) }

    /// Opacity with `remaining` seconds of life left: 1 with time to spare, then a
    /// fade over the last `fadeSeconds` that starts slow and gains speed (`Motion.easeIn`).
    static func fadeOut(remaining: TimeInterval) -> Double {
        guard remaining < fadeSeconds else { return 1 }
        return 1 - easeIn(1 - max(0, remaining) / fadeSeconds)
    }

    // MARK: - Labels: where each kind's pill hangs

    /// A kind's label: the text, where the pill hangs (local points, once the shape has
    /// landed) and which edge of the pill sits on that point.
    struct LabelSpec {
        let text: String
        let point: CGPoint
        let edge: UnitPoint
    }

    /// Placement is decided here, once, for the painters (which draw it) and for
    /// OverlayManager.spread (which converts the point to global CG and lets the one
    /// display that holds it draw the label). nil when the kind has no label text.
    static func label(for kind: AnnotationKind) -> LabelSpec? {
        func text(_ s: String?) -> String? { (s?.isEmpty == false) ? s : nil }
        switch kind {
        case .point(let p, let label):
            guard let t = text(label) else { return nil }
            // Above the arrow's tail once it has landed (drawPoint's geometry at slide = 1).
            let tail = CGPoint(x: p.x + pointArrowDirection.dx * pointArrowLength, y: p.y + pointArrowDirection.dy * pointArrowLength)
            return LabelSpec(text: t, point: CGPoint(x: tail.x + 6, y: tail.y - 8), edge: .bottomLeading)
        case .highlight(let r, let label):
            guard let t = text(label) else { return nil }
            let rect = r.insetBy(dx: -4, dy: -4)
            let above = rect.minY > 34
            return LabelSpec(text: t, point: CGPoint(x: rect.minX, y: above ? rect.minY - 6 : rect.maxY + 6), edge: above ? .bottomLeading : .topLeading)
        case .path, .clickPulse:
            return nil
        case .circle(let c, let r, let label, _):
            guard let t = text(label) else { return nil }
            let above = c.y - r > 44
            return LabelSpec(text: t, point: CGPoint(x: c.x, y: above ? c.y - r - 10 : c.y + r + 10), edge: above ? .bottom : .top)
        case .arrow(let a, let b, let label, _):
            guard let t = text(label) else { return nil }
            // Midpoint of the shaft, pushed out on the bowed side (or above a straight one).
            let s = arrowShaft(from: a, to: b)
            let side: CGFloat = s.bow == 0 ? -1 : 1
            let off: CGFloat = 12
            let at = CGPoint(x: s.midpoint.x + s.normal.dx * off * side, y: s.midpoint.y + s.normal.dy * off * side)
            return LabelSpec(text: t, point: at, edge: (s.normal.dy * side) < 0 ? .bottom : .top)
        case .rect(let r0, let label, _):
            guard let t = text(label) else { return nil }
            let rect = r0.standardized
            let above = rect.minY > 40
            return LabelSpec(text: t, point: CGPoint(x: rect.minX, y: above ? rect.minY - 8 : rect.maxY + 8), edge: above ? .bottomLeading : .topLeading)
        case .text(let p, let s, _):
            guard let t = text(s) else { return nil }
            return LabelSpec(text: t, point: p, edge: .topLeading)
        case .stroke(let pts, let label, _):
            guard let t = text(label), !pts.isEmpty else { return nil }
            let box = OverlayGeometry.bounds(pts)
            let above = box.minY > 44
            return LabelSpec(text: t, point: CGPoint(x: box.midX, y: above ? box.minY - 10 : box.maxY + 10), edge: above ? .bottom : .top)
        }
    }

    // MARK: - Dispatch

    static func draw(_ a: Annotation, age: TimeInterval, fade: Double, reducedMotion: Bool, bounds: CGSize, in ctx: GraphicsContext) {
        var g = ctx
        g.opacity = fade
        // No draw-on for reduced motion, or for a shape that was already on screen.
        let still = reducedMotion || !a.drawOn
        // Reduce Motion: the shape arrives whole, with a plain fade in its place.
        if reducedMotion, a.drawOn { g.opacity *= easeOut(age / quickSeconds) }
        // The teaching shapes draw on over Motion.base; their label fades in over
        // Motion.quick once the shape has landed (at once when there was no draw-on).
        let progress = still ? 1 : easeOut(age / drawSeconds)
        let labelProgress = still ? 1 : easeOut((age - drawSeconds) / quickSeconds)
        let label = a.showsLabel ? label(for: a.kind) : nil
        switch a.kind {
        case .point(let p, _):
            drawPoint(p, label: label, age: age, reducedMotion: reducedMotion, bounds: bounds, in: g)
        case .highlight(let r, _):
            drawHighlight(r, label: label, age: age, reducedMotion: reducedMotion, bounds: bounds, in: g)
        case .path(let from, let to):
            drawPath(from: from, to: to, age: age, reducedMotion: reducedMotion, in: g)
        case .clickPulse(let p):
            drawPulse(p, age: age, reducedMotion: reducedMotion, in: g)
        case .circle(let c, let r, _, let tone):
            drawCircle(c, radius: r, label: label, tone: tone, progress: progress, labelProgress: labelProgress, bounds: bounds, in: g)
        case .arrow(let from, let to, _, let tone):
            drawArrow(from: from, to: to, label: label, tone: tone, progress: progress, labelProgress: labelProgress, bounds: bounds, in: g)
        case .rect(let r, _, let tone):
            drawRect(r, label: label, tone: tone, progress: progress, labelProgress: labelProgress, bounds: bounds, in: g)
        case .text(_, _, let tone):
            // The label is the whole shape: only its owning display draws anything.
            guard let label else { return }
            drawText(label, tone: tone, progress: still ? 1 : easeOut(age / quickSeconds), bounds: bounds, in: g)
        case .stroke(let pts, _, let tone):
            drawStroke(pts, label: label, tone: tone, progress: progress, labelProgress: labelProgress, bounds: bounds, in: g)
        }
    }

    // MARK: point → arrow sliding in from the upper-left, landing on the point.

    /// The point cue's arrow comes from the upper-left, this long once landed.
    private static let pointArrowDirection = CGVector(dx: -1, dy: -1)
    private static let pointArrowLength: CGFloat = 34

    private static func drawPoint(_ p: CGPoint, label: LabelSpec?, age: TimeInterval, reducedMotion: Bool, bounds: CGSize, in ctx: GraphicsContext) {
        let slide = reducedMotion ? 1 : easeOut(age / pointSlideSeconds)
        let dir = pointArrowDirection
        let len = pointArrowLength
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

        if let label {
            // The pill rides the tail as the arrow slides in.
            let at = CGPoint(x: label.point.x + dir.dx * offset, y: label.point.y + dir.dy * offset)
            drawLabel(label.text, at: at, anchor: label.edge, dot: cyan, mono: false, bounds: bounds, in: g)
        }
    }

    // MARK: highlight → rounded rect that draws itself.

    private static func drawHighlight(_ r: CGRect, label: LabelSpec?, age: TimeInterval, reducedMotion: Bool, bounds: CGSize, in ctx: GraphicsContext) {
        let p = reducedMotion ? 1 : easeOut(age / highlightSeconds)
        let rect = r.insetBy(dx: -4, dy: -4)
        let radius = min(8, min(rect.width, rect.height) / 2)
        let full = Path(roundedRect: rect, cornerRadius: radius, style: .continuous)
        ctx.fill(full, with: .color(cyan.opacity(0.07 * p)))
        let drawn = p < 1 ? full.trimmedPath(from: 0, to: CGFloat(p)) : full
        ctx.stroke(drawn, with: .color(ground.opacity(0.5)), style: StrokeStyle(lineWidth: 4, lineCap: .round))
        ctx.stroke(drawn, with: .color(cyan), style: StrokeStyle(lineWidth: 2, lineCap: .round))
        if let label, p > 0.6 {
            var g = ctx
            g.opacity *= (p - 0.6) / 0.4
            drawLabel(label, dot: cyan, bounds: bounds, in: g)
        }
    }

    // MARK: path → dotted trail growing from → to with a travelling head.

    private static func drawPath(from: CGPoint, to: CGPoint, age: TimeInterval, reducedMotion: Bool, in ctx: GraphicsContext) {
        let p = reducedMotion ? 1 : easeOut(age / pathSeconds)
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

    // MARK: click pulse → expanding ring over Motion.drift (a still ring fading under Reduce Motion).

    private static func drawPulse(_ p: CGPoint, age: TimeInterval, reducedMotion: Bool, in ctx: GraphicsContext) {
        let k = min(1, age / pulseSeconds)
        let r = 6 + 26 * CGFloat(reducedMotion ? 1 : easeOut(k))
        var g = ctx
        g.opacity *= (1 - k)
        g.stroke(Path(ellipseIn: CGRect(x: p.x - r, y: p.y - r, width: r * 2, height: r * 2)), with: .color(green), lineWidth: 2.5)
        let r2 = r * 0.55
        g.fill(Path(ellipseIn: CGRect(x: p.x - r2, y: p.y - r2, width: r2 * 2, height: r2 * 2)), with: .color(green.opacity(0.18)))
        ctx.fill(Path(ellipseIn: CGRect(x: p.x - 3, y: p.y - 3, width: 6, height: 6)), with: .color(green.opacity(1 - k)))
    }

    // MARK: - Teaching shapes

    /// A tone line the way every teaching shape draws one: a thin ink under-stroke so
    /// it reads on paper-white windows, a glow so it reads on ink, and the line itself.
    /// The glow is two flat rings (the tone at 0.14 then 0.26, 8 and 4 pt wider than the
    /// line) — banded, not blurred (canon: never a blur), and not dithered either: this
    /// Canvas repaints at 30 fps while a shape draws on, and a dither here would be a
    /// per-frame pixel pass on the main thread. The one banded-only shade in the app.
    private static func strokeTone(_ path: Path, tone: OverlayTone, width: CGFloat, glow: Bool = true, in ctx: GraphicsContext) {
        let c = color(tone)
        let style = StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round)
        if glow {
            ctx.stroke(path, with: .color(c.opacity(0.14)), style: StrokeStyle(lineWidth: width + 8, lineCap: .round, lineJoin: .round))
            ctx.stroke(path, with: .color(c.opacity(0.26)), style: StrokeStyle(lineWidth: width + 4, lineCap: .round, lineJoin: .round))
        }
        ctx.stroke(path, with: .color(ink.opacity(0.35)), style: StrokeStyle(lineWidth: width + 2.5, lineCap: .round, lineJoin: .round))
        ctx.stroke(path, with: .color(c), style: style)
    }

    /// The label of a teaching shape: it fades in (and rises 4pt) with `k`, which the
    /// caller starts once the shape has landed.
    private static func drawShapeLabel(_ label: LabelSpec?, tone: OverlayTone, progress k: Double, bounds: CGSize, in ctx: GraphicsContext) {
        guard let label, k > 0 else { return }
        var g = ctx
        g.opacity *= k
        let lift: CGFloat = label.edge.y >= 0.5 ? 4 : -4
        let at = CGPoint(x: label.point.x, y: label.point.y + lift * CGFloat(1 - k))
        drawLabel(label.text, at: at, anchor: label.edge, dot: color(tone), mono: false, bounds: bounds, in: g)
    }

    // circle → 2pt ring drawing itself on from the upper-left, glow, label above.

    private static func drawCircle(_ c: CGPoint, radius r: CGFloat, label: LabelSpec?, tone: OverlayTone, progress p: Double, labelProgress k: Double, bounds: CGSize, in ctx: GraphicsContext) {
        var ring = Path()
        ring.addArc(center: c, radius: r, startAngle: .degrees(-120), endAngle: .degrees(240), clockwise: false)
        let drawn = p < 1 ? ring.trimmedPath(from: 0, to: CGFloat(p)) : ring
        ctx.fill(Path(ellipseIn: CGRect(x: c.x - r, y: c.y - r, width: r * 2, height: r * 2)), with: .color(color(tone).opacity(0.05 * p)))
        strokeTone(drawn, tone: tone, width: 2, in: ctx)
        drawShapeLabel(label, tone: tone, progress: k, bounds: bounds, in: ctx)
    }

    // arrow → gently curved shaft (straight when short) with a filled head; label at the midpoint.

    /// The arrow's shaft: a quadratic from `a` to `b` bowing to the left of travel
    /// (straight when short). Shared by the painter and the label placement.
    struct ArrowShaft {
        let a: CGPoint
        let b: CGPoint
        let control: CGPoint
        /// Unit perpendicular to a→b, on the bowed side.
        let normal: CGVector
        let bow: CGFloat
        /// The quadratic at t = 0.5.
        var midpoint: CGPoint {
            CGPoint(x: 0.25 * a.x + 0.5 * control.x + 0.25 * b.x, y: 0.25 * a.y + 0.5 * control.y + 0.25 * b.y)
        }
    }

    static func arrowShaft(from a: CGPoint, to b: CGPoint) -> ArrowShaft {
        let dx = b.x - a.x, dy = b.y - a.y
        let len = max(1, hypot(dx, dy))
        let n = CGVector(dx: -dy / len, dy: dx / len)
        let bow: CGFloat = len < 60 ? 0 : min(40, len * 0.14)
        let control = CGPoint(x: (a.x + b.x) / 2 + n.dx * bow, y: (a.y + b.y) / 2 + n.dy * bow)
        return ArrowShaft(a: a, b: b, control: control, normal: n, bow: bow)
    }

    private static func drawArrow(from a: CGPoint, to b: CGPoint, label: LabelSpec?, tone: OverlayTone, progress p: Double, labelProgress k: Double, bounds: CGSize, in ctx: GraphicsContext) {
        let s = arrowShaft(from: a, to: b)
        var shaft = Path()
        shaft.move(to: a)
        shaft.addQuadCurve(to: b, control: s.control)
        // The shaft grows from the tail toward the head.
        let drawn = p < 1 ? shaft.trimmedPath(from: 0, to: CGFloat(p)) : shaft
        strokeTone(drawn, tone: tone, width: 2, in: ctx)
        // Origin marker.
        ctx.fill(Path(ellipseIn: CGRect(x: a.x - 3, y: a.y - 3, width: 6, height: 6)), with: .color(color(tone)))

        // Head: appears over the last fifth of the draw-on, along the end tangent.
        if p > 0.8 {
            let k = CGFloat((p - 0.8) / 0.2)
            let ang = atan2(b.y - s.control.y, b.x - s.control.x)
            let headLen: CGFloat = 13 * k, spread: CGFloat = 0.42
            var head = Path()
            head.move(to: b)
            head.addLine(to: CGPoint(x: b.x - headLen * cos(ang - spread), y: b.y - headLen * sin(ang - spread)))
            head.addLine(to: CGPoint(x: b.x - headLen * cos(ang + spread), y: b.y - headLen * sin(ang + spread)))
            head.closeSubpath()
            ctx.stroke(head, with: .color(ink.opacity(0.35)), style: StrokeStyle(lineWidth: 3, lineJoin: .round))
            ctx.fill(head, with: .color(color(tone)))
        }

        drawShapeLabel(label, tone: tone, progress: k, bounds: bounds, in: ctx)
    }

    // rect → 6pt rounded hairline plus glow, drawing itself on; label above-left.

    private static func drawRect(_ r: CGRect, label: LabelSpec?, tone: OverlayTone, progress p: Double, labelProgress k: Double, bounds: CGSize, in ctx: GraphicsContext) {
        let rect = r.standardized
        let radius = min(6, min(rect.width, rect.height) / 2)
        let full = Path(roundedRect: rect, cornerRadius: radius, style: .continuous)
        ctx.fill(full, with: .color(color(tone).opacity(0.05 * p)))
        let drawn = p < 1 ? full.trimmedPath(from: 0, to: CGFloat(p)) : full
        strokeTone(drawn, tone: tone, width: 1, in: ctx)
        drawShapeLabel(label, tone: tone, progress: k, bounds: bounds, in: ctx)
    }

    // text → a label pill anchored top-left at the point; fades in over Motion.quick, rises 4pt.

    private static func drawText(_ label: LabelSpec, tone: OverlayTone, progress k: Double, bounds: CGSize, in ctx: GraphicsContext) {
        var g = ctx
        g.opacity *= k
        let at = CGPoint(x: label.point.x, y: label.point.y + 4 * CGFloat(1 - k))
        drawLabel(label.text, at: at, anchor: label.edge, dot: color(tone), mono: looksLikeCoordinates(label.text), bounds: bounds, in: g)
    }

    // stroke → freehand line, round caps, slight smoothing; label above its bounds.

    private static func drawStroke(_ pts: [CGPoint], label: LabelSpec?, tone: OverlayTone, progress p: Double, labelProgress k: Double, bounds: CGSize, in ctx: GraphicsContext) {
        guard let first = pts.first else { return }
        let path = smoothed(pts)
        let drawn = p < 1 ? path.trimmedPath(from: 0, to: CGFloat(p)) : path
        strokeTone(drawn, tone: tone, width: 2.5, in: ctx)
        if pts.count == 1 {
            ctx.fill(Path(ellipseIn: CGRect(x: first.x - 2, y: first.y - 2, width: 4, height: 4)), with: .color(color(tone)))
        }
        drawShapeLabel(label, tone: tone, progress: k, bounds: bounds, in: ctx)
    }

    // MARK: - Live strokes (mark mode's, the blob's)

    /// A line as it is drawn: the same treatment as a finished stroke (glow, ink rim,
    /// round caps, its tone — the rim is what keeps a warm line legible on a light
    /// window) with no draw-on and no easing on the tip, so it feels like ink following
    /// the pen. Sealed, it fades out over its last `fadeSeconds` (Motion.easeIn). The
    /// label rides just ahead of the pen while the line grows and settles above the
    /// line's box (below when there is no room).
    static func drawLiveStroke(_ s: LiveStrokeItem, now: Date, bounds: CGSize, in ctx: GraphicsContext) {
        guard let first = s.points.first else { return }
        var g = ctx
        if s.done, let at = s.doneAt {
            g.opacity *= fadeOut(remaining: s.ttl - now.timeIntervalSince(at))
        }
        let c = color(s.tone)
        if s.points.count == 1 {
            g.fill(Path(ellipseIn: CGRect(x: first.x - 2.5, y: first.y - 2.5, width: 5, height: 5)), with: .color(c))
        } else {
            strokeTone(smoothed(s.points), tone: s.tone, width: 2.5, in: g)
        }
        if s.showsLabel, let text = s.label, !text.isEmpty {
            drawLabel(liveStrokeLabel(points: s.points, done: s.done, text: text), dot: c, bounds: bounds, in: g)
        }
    }

    /// Where a live stroke's pill hangs: off the pen's upper right while the line is
    /// drawn (the body that holds the pen trails behind it), then at the top-left of
    /// the line's box once sealed. Works in any one coordinate space — the manager
    /// asks in global points to pick the display that draws it, the painter in local.
    static func liveStrokeLabel(points: [CGPoint], done: Bool, text: String) -> LabelSpec {
        let box = OverlayGeometry.bounds(points)
        if !done, let pen = points.last {
            return LabelSpec(text: text, point: CGPoint(x: pen.x + 18, y: pen.y - 14), edge: .bottomLeading)
        }
        let above = box.minY > 44
        return LabelSpec(text: text, point: CGPoint(x: box.minX, y: above ? box.minY - 10 : box.maxY + 10), edge: above ? .bottomLeading : .topLeading)
    }

    // MARK: - Mark mode

    /// While mark mode is on: a faint accent wash over the display and a 2pt accent
    /// frame at its edge, at `alpha` (they ease in as the mode begins and out as it
    /// ends). The wash alone is lost over a light window and the crosshair is only
    /// ours while the cursor is over the overlay; the frame reads everywhere.
    static func drawMarkModeFrame(_ size: CGSize, alpha: Double = 1, in ctx: GraphicsContext) {
        let full = CGRect(origin: .zero, size: size)
        var g = ctx
        g.opacity = min(1, max(0, alpha))
        g.fill(Path(full), with: .color(accent.opacity(0.06)))
        g.stroke(Path(full.insetBy(dx: 1, dy: 1)), with: .color(accent.opacity(0.6)), lineWidth: 2)
    }

    // MARK: - Geometry helpers

    /// Quadratic smoothing round the vertices: keeps the hand's shape, loses the
    /// jitter. Each curve leaves its segments `maxRound` short of the vertex — or at
    /// their midpoints when they are shorter — so a dense freehand stroke is smoothed
    /// through its midpoints as before, and a sparse polyline (an `orb.trace` of a
    /// rectangle's four corners) keeps its corners, filleted rather than ballooned
    /// into a loop.
    static func smoothed(_ pts: [CGPoint], maxRound: CGFloat = 7) -> Path {
        var path = Path()
        guard let first = pts.first else { return path }
        path.move(to: first)
        guard pts.count > 2 else {
            if pts.count == 2 { path.addLine(to: pts[1]) }
            return path
        }
        func toward(_ v: CGPoint, _ p: CGPoint) -> CGPoint {
            let dx = p.x - v.x, dy = p.y - v.y
            let len = hypot(dx, dy)
            guard len > 0.001 else { return v }
            let d = min(maxRound, len / 2)
            return CGPoint(x: v.x + dx / len * d, y: v.y + dy / len * d)
        }
        for i in 1..<(pts.count - 1) {
            let v = pts[i]
            path.addLine(to: toward(v, pts[i - 1]))
            path.addQuadCurve(to: toward(v, pts[i + 1]), control: v)
        }
        path.addLine(to: pts[pts.count - 1])
        return path
    }

    /// "1280 × 720", "412, 96", "0.5" — digits and separators only → SF Mono.
    static func looksLikeCoordinates(_ s: String) -> Bool {
        let allowed = " ,.:;×x()[]-–+%/@"
        return s.contains(where: \.isNumber) && s.allSatisfy { $0.isNumber || allowed.contains($0) }
    }

    // MARK: - The label pill: raised ink, paper text, a dot in the shape's colour, 6pt radius.

    static func drawLabel(_ spec: LabelSpec, dot: Color, mono: Bool = false, bounds: CGSize, in ctx: GraphicsContext) {
        drawLabel(spec.text, at: spec.point, anchor: spec.edge, dot: dot, mono: mono, bounds: bounds, in: ctx)
    }

    static func drawLabel(_ label: String, at point: CGPoint, anchor: UnitPoint, tone: OverlayTone, mono: Bool, bounds: CGSize, in ctx: GraphicsContext) {
        drawLabel(label, at: point, anchor: anchor, dot: color(tone), mono: mono, bounds: bounds, in: ctx)
    }

    /// `anchor` is the edge of the pill that sits on `point`. The pill is kept on this
    /// display — callers only ask the display that owns the label (Annotation.showsLabel),
    /// so the clamp never drags a pill onto a display its shape is not on.
    static func drawLabel(_ label: String, at point: CGPoint, anchor: UnitPoint, dot: Color, mono: Bool, bounds: CGSize, in ctx: GraphicsContext) {
        let font: Font = mono ? .system(size: 11, weight: .medium, design: .monospaced) : .system(size: 11, weight: .medium)
        let resolved = ctx.resolve(Text(label).font(font).foregroundStyle(paper))
        let size = resolved.measure(in: CGSize(width: 360, height: 80))
        let padX: CGFloat = 8, padY: CGFloat = 5, dotSize: CGFloat = 5, gap: CGFloat = 6
        let w = padX + dotSize + gap + size.width + padX
        let h = size.height + padY * 2
        var origin = CGPoint(x: point.x - w * anchor.x, y: point.y - h * anchor.y)
        origin.x = min(max(8, origin.x), max(8, bounds.width - w - 8))
        origin.y = min(max(8, origin.y), max(8, bounds.height - h - 8))
        let rect = CGRect(origin: origin, size: CGSize(width: w, height: h))
        let pill = Path(roundedRect: rect, cornerRadius: 6, style: .continuous)
        ctx.fill(pill, with: .color(raised.opacity(0.94)))
        ctx.stroke(Path(roundedRect: rect.insetBy(dx: 0.5, dy: 0.5), cornerRadius: 5.5, style: .continuous), with: .color(paper.opacity(0.22)), lineWidth: 1)
        ctx.fill(Path(ellipseIn: CGRect(x: rect.minX + padX, y: rect.midY - dotSize / 2, width: dotSize, height: dotSize)), with: .color(dot))
        ctx.draw(resolved, at: CGPoint(x: rect.minX + padX + dotSize + gap, y: rect.midY), anchor: .leading)
    }
}

/// Point-set helpers shared by the manager (splitting across displays), the painter
/// and mark mode (the stroke Kevin sends).
enum OverlayGeometry {
    static func bounds(_ pts: [CGPoint]) -> CGRect {
        guard let first = pts.first else { return .null }
        var minX = first.x, minY = first.y, maxX = first.x, maxY = first.y
        for p in pts.dropFirst() {
            minX = min(minX, p.x); minY = min(minY, p.y)
            maxX = max(maxX, p.x); maxY = max(maxY, p.y)
        }
        return CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
    }

    /// Ramer–Douglas–Peucker down to at most `maxPoints`, tightening the tolerance
    /// until it fits; a uniform pick as the last resort. Endpoints always survive.
    static func simplify(_ input: [CGPoint], maxPoints: Int) -> [CGPoint] {
        var pts: [CGPoint] = []
        pts.reserveCapacity(input.count)
        for p in input where pts.last.map({ abs($0.x - p.x) > 0.01 || abs($0.y - p.y) > 0.01 }) ?? true { pts.append(p) }
        guard pts.count > maxPoints, maxPoints >= 2 else { return pts }
        var eps: CGFloat = 0.5
        var out = rdp(pts, epsilon: eps)
        while out.count > maxPoints, eps < 256 {
            eps *= 1.6
            out = rdp(pts, epsilon: eps)
        }
        if out.count > maxPoints {
            let step = Double(pts.count - 1) / Double(maxPoints - 1)
            out = (0..<maxPoints).map { pts[Int((Double($0) * step).rounded())] }
        }
        return out
    }

    static func rdp(_ pts: [CGPoint], epsilon: CGFloat) -> [CGPoint] {
        guard pts.count > 2 else { return pts }
        var keep = [Bool](repeating: false, count: pts.count)
        keep[0] = true; keep[pts.count - 1] = true
        var stack: [(Int, Int)] = [(0, pts.count - 1)]
        while let (lo, hi) = stack.popLast() {
            guard hi - lo > 1 else { continue }
            let a = pts[lo], b = pts[hi]
            var best = -1, bestD: CGFloat = 0
            for i in (lo + 1)..<hi {
                let d = distance(pts[i], toSegment: a, b)
                if d > bestD { bestD = d; best = i }
            }
            if best >= 0, bestD > epsilon {
                keep[best] = true
                stack.append((lo, best)); stack.append((best, hi))
            }
        }
        return pts.indices.filter { keep[$0] }.map { pts[$0] }
    }

    private static func distance(_ p: CGPoint, toSegment a: CGPoint, _ b: CGPoint) -> CGFloat {
        let dx = b.x - a.x, dy = b.y - a.y
        let l2 = dx * dx + dy * dy
        if l2 == 0 { return hypot(p.x - a.x, p.y - a.y) }
        let t = min(1, max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2))
        return hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
    }
}
