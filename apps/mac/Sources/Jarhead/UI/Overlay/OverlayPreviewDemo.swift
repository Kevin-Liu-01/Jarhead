#if JARHEAD_ORB_PREVIEW
import AppKit
import SwiftUI

// The overlay's half of the orb preview harness (Scripts/orb-preview.sh compiles this
// with -D JARHEAD_ORB_PREVIEW; OverlayManager.start() installs it). It reads the same
// ORB_* environment as OrbPreviewApp and prints what it does. Nothing here exists in
// the app.
//
//   ORB_OVERLAY=1   also fire one of each teaching shape to the right of the orb's
//                   own cues, and shoot <ORB_SHOT_DIR>/preview-overlay-shapes.png at 3.6 s;
//                   at 3 s a seam probe (a labelled rect 40pt below the main display's
//                   top, a text 20pt above it) and a per-window count of items and of
//                   labels — a shape near the seam must not grow a pill on the other display
//   ORB_MARK=1      enter mark mode at 1 s and synthesise a stroke through the overlay
//                   window (sendEvent): the harness's fake sender prints the resulting
//                   mark.add; shoots preview-overlay-mark.png mid-stroke and prints the
//                   live stroke's point count per window
//   ORB_MARK=seam   … the stroke centred on the main display's top edge, so it crosses
//                   onto the display above (when there is one): every window must carry
//                   the live stroke and the mark.add rect has a negative y
//   ORB_MARK=click  … a mouse-down/up that does not move (expects a cancel, no send)
//   ORB_MARK=cancel … then an Escape posted to the app (expects a cancel, no send)

@MainActor
enum OverlayPreviewDemo {
    static func install(on manager: OverlayManager) {
        let env = ProcessInfo.processInfo.environment
        let orb = CGPoint(x: Double(env["ORB_X"] ?? "") ?? 200, y: Double(env["ORB_Y"] ?? "") ?? 200)
        let shotDir = env["ORB_SHOT_DIR"]
        if env["ORB_OVERLAY"] == "1" { shapes(manager, orb: orb, shotDir: shotDir) }
        if let mode = env["ORB_MARK"], !mode.isEmpty, mode != "0" { mark(manager, mode: mode, orb: orb, shotDir: shotDir) }
    }

    // MARK: - Teaching shapes

    private static func shapes(_ manager: OverlayManager, orb: CGPoint, shotDir: String?) {
        let b = CGPoint(x: orb.x + 520, y: orb.y + 20)
        func fire(_ at: TimeInterval, _ what: String, _ cmd: OverlayCommand) {
            DispatchQueue.main.asyncAfter(deadline: .now() + at) {
                manager.state.overlayCommands.send(cmd)
                print("overlay:", what)
                fflush(stdout)
            }
        }
        fire(1.0, "circle accent", .circle(x: b.x + 80, y: b.y + 130, radius: 44, label: "Start here", ttlMs: nil, tone: .accent))
        fire(1.4, "arrow ok", .arrow(from: Point2(x: b.x + 140, y: b.y + 130), to: Point2(x: b.x + 330, y: b.y + 80), label: "then drag it here", ttlMs: nil, tone: .ok))
        fire(1.8, "rect warn", .rect(rect: Rect(x: b.x + 340, y: b.y + 50, w: 220, h: 64), label: "Unsaved changes", ttlMs: nil, tone: .warn))
        fire(2.2, "text accent (mono)", .text(x: b.x + 340, y: b.y + 130, text: "1280 × 720", ttlMs: nil, tone: .accent))
        let loop = wobblyLoop(center: CGPoint(x: b.x + 130, y: b.y + 290), rx: 70, ry: 44, samples: 40, seed: 7)
        fire(2.6, "stroke mark (\(loop.count) points)", .stroke(points: loop.map { Point2(x: $0.x, y: $0.y) }, label: "Your mark", ttlMs: nil, tone: .mark))

        // Seam probe. The rect's padded bounds reach the display above the main one
        // (when there is one), the text sits on it: each is handed to both windows, and
        // exactly one window may draw each label — the one whose display holds it.
        let main = manager.windows.first?.cgFrame ?? .zero
        fire(3.0, "seam rect, 40pt below the main display's top", .rect(rect: Rect(x: main.midX - 150, y: main.minY + 40, w: 300, h: 60), label: "Top of main", ttlMs: 2500, tone: .accent))
        fire(3.0, "seam text, 20pt above the main display", .text(x: main.midX + 200, y: main.minY - 20, text: "Above the seam", ttlMs: 2500, tone: .ok))
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.3) {
            for (i, w) in manager.windows.enumerated() {
                let items = w.model.items
                let labelled = items.filter { OverlayPainter.label(for: $0.kind) != nil }
                let drawn = labelled.filter(\.showsLabel).map { OverlayPainter.label(for: $0.kind)!.text }
                print("overlay: window \(i) CG \(Int(w.cgFrame.minX)),\(Int(w.cgFrame.minY)) \(Int(w.cgFrame.width))×\(Int(w.cgFrame.height)) -> items \(items.count), labelled \(labelled.count), labels drawn here \(drawn.count): \(drawn.joined(separator: " | "))")
            }
            fflush(stdout)
        }
        if let dir = shotDir {
            DispatchQueue.main.asyncAfter(deadline: .now() + 3.6) {
                let region = CGRect(x: orb.x - 24, y: orb.y - 40, width: 1140, height: 420)
                shoot(manager, regionCG: region, path: "\(dir)/preview-overlay-shapes.png", note: "teaching shapes")
            }
        }
    }

    // MARK: - Mark mode

    private static func mark(_ manager: OverlayManager, mode: String, orb: CGPoint, shotDir: String?) {
        var controller: MarkModeController?
        func report(_ label: String) {
            let through = manager.windows.map { $0.ignoresMouseEvents ? "click-through" : "interactive" }
            print("mark: \(label) -> marking: \(manager.isMarking), windows: \(through.joined(separator: ", ")), key: \(NSApp.keyWindow.map { String(describing: type(of: $0)) } ?? "nil"), active: \(NSApp.isActive), focus: \(controller?.focus ?? "?")")
            if let o = controller?.outcome { print("mark: outcome:", o) }
            fflush(stdout)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
            manager.beginMarkMode()
            controller = manager.markMode
            report("begin")
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) {
            guard manager.isMarking else { print("mark: not marking, skipped"); return }
            // "seam": a loop centred 20pt below the main display's top edge, so it
            // crosses onto the display above when there is one.
            let main = manager.windows.first?.cgFrame ?? .zero
            let centre = mode == "seam" ? CGPoint(x: main.midX, y: main.minY + 20) : CGPoint(x: orb.x + 300, y: orb.y + 90)
            guard let w = manager.windows.first(where: { $0.cgFrame.contains(centre) }) ?? manager.windows.first else { return }
            switch mode {
            case "click":
                let p = w.windowPoint(w.local(centre))
                send(.leftMouseDown, at: p, in: w)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                    send(.leftMouseUp, at: p, in: w)
                    print("mark: synthesised a click without movement through window \(w.windowNumber)")
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { report("after click") }
                }
            case "cancel":
                let esc = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                           windowNumber: w.windowNumber, context: nil, characters: "\u{1b}", charactersIgnoringModifiers: "\u{1b}",
                                           isARepeat: false, keyCode: 53)
                if let esc { NSApp.postEvent(esc, atStart: false) }
                print("mark: posted Escape")
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { report("after Escape") }
            default:
                let pts = mode == "seam"
                    ? wobblyLoop(center: centre, rx: 160, ry: 60, samples: 48, seed: 3)
                    : wobblyLoop(center: centre, rx: 120, ry: 70, samples: 48, seed: 3)
                let step = 0.012
                // The whole stroke goes through the window it started in, as AppKit
                // delivers a real drag — points past its frame included.
                send(.leftMouseDown, at: w.windowPoint(w.local(pts[0])), in: w)
                for (i, p) in pts.enumerated().dropFirst() {
                    DispatchQueue.main.asyncAfter(deadline: .now() + step * Double(i)) {
                        send(.leftMouseDragged, at: w.windowPoint(w.local(p)), in: w)
                    }
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + step * Double(pts.count - 12)) {
                    let live = manager.windows.map { String($0.model.liveStroke.count) }
                    let box = OverlayGeometry.bounds(Array(pts.prefix(pts.count - 12)))
                    print("mark: mid-drag, live stroke points per window: \(live.joined(separator: ", ")); stroke so far spans CG y \(Int(box.minY))…\(Int(box.maxY))")
                    fflush(stdout)
                    if let dir = shotDir {
                        // Wide enough for the hint pill at the display's top centre.
                        let region = CGRect(x: orb.x - 24, y: 0, width: 1000, height: orb.y + 220)
                        shoot(manager, regionCG: region, path: "\(dir)/preview-overlay-mark.png", note: "mark mode, mid-stroke")
                    }
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + step * Double(pts.count) + 0.25) {
                    send(.leftMouseUp, at: w.windowPoint(w.local(pts[pts.count - 1])), in: w)
                    print("mark: synthesised a stroke of \(pts.count) samples through window \(w.windowNumber) (CG \(w.cgFrame))")
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { report("after stroke") }
                }
            }
        }
    }

    private static func send(_ type: NSEvent.EventType, at p: NSPoint, in w: NSWindow) {
        guard let ev = NSEvent.mouseEvent(with: type, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                          windowNumber: w.windowNumber, context: nil, eventNumber: 0, clickCount: 1,
                                          pressure: type == .leftMouseUp ? 0 : 1) else { return }
        w.sendEvent(ev)
    }

    /// A hand-drawn-looking loop: an ellipse with a little wobble and a slight overshoot.
    private static func wobblyLoop(center c: CGPoint, rx: CGFloat, ry: CGFloat, samples: Int, seed: Int) -> [CGPoint] {
        (0..<samples).map { i in
            let t = Double(i) / Double(samples - 1)
            let ang = -100.0 * .pi / 180 + t * (2 * .pi + 0.35)
            let wob = 1 + 0.05 * sin(ang * 3 + Double(seed)) + 0.03 * cos(ang * 5 - Double(seed))
            let drift = CGFloat(t) * 6
            return CGPoint(x: c.x + rx * CGFloat(cos(ang) * wob) + drift, y: c.y + ry * CGFloat(sin(ang) * wob) - drift * 0.5)
        }
    }

    // MARK: - Screenshots

    /// `screencapture -R` of the region (needs the Screen Recording grant for whatever
    /// launched the harness); without it each overlay window's canvas is painted
    /// offscreen (ImageRenderer, the same `OverlayCanvasView.paint` the live layer
    /// runs) over ink — or over light grey with ORB_BACKDROP_LIGHT=1 — which shows the
    /// shapes and nothing of the desktop.
    private static func shoot(_ manager: OverlayManager, regionCG: CGRect, path: String, note: String) {
        var f = regionCG
        let mainMaxY = NSScreen.screens.first?.frame.maxY ?? 0
        let centre = CGPoint(x: f.midX, y: f.midY)
        if let screen = NSScreen.screens.first(where: { s in
            CGRect(x: s.frame.minX, y: mainMaxY - s.frame.maxY, width: s.frame.width, height: s.frame.height).contains(centre)
        }) {
            f = f.intersection(CGRect(x: screen.frame.minX, y: mainMaxY - screen.frame.maxY, width: screen.frame.width, height: screen.frame.height))
        }
        let region = String(format: "%.0f,%.0f,%.0f,%.0f", f.minX, f.minY, f.width, f.height)
        if ProcessInfo.processInfo.environment["ORB_SHOT_INPROCESS"] != "1" {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
            p.arguments = ["-x", "-R", region, path]
            do {
                try p.run()
                p.waitUntilExit()
                if p.terminationStatus == 0, FileManager.default.fileExists(atPath: path) {
                    print("shot:", path, "(\(note))", "region", region)
                    fflush(stdout)
                    return
                }
                print("screencapture failed (status \(p.terminationStatus)); capturing in-process")
            } catch {
                print("screencapture failed:", error, "; capturing in-process")
            }
        }
        let scale: CGFloat = 2
        let w = Int(f.width * scale), h = Int(f.height * scale)
        guard w > 0, h > 0,
              let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h, bitsPerSample: 8, samplesPerPixel: 4,
                                         hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
              let gctx = NSGraphicsContext(bitmapImageRep: rep) else { print("shot failed: no bitmap for", region); return }
        let cg = gctx.cgContext
        cg.scaleBy(x: scale, y: scale)
        let light = ProcessInfo.processInfo.environment["ORB_BACKDROP_LIGHT"] == "1"
        cg.setFillColor(light ? NSColor(white: 0.93, alpha: 1).cgColor : NSColor(srgbRed: 0x07 / 255, green: 0x07 / 255, blue: 0x07 / 255, alpha: 1).cgColor)
        cg.fill(CGRect(origin: .zero, size: f.size))
        let now = Date()
        for win in manager.windows where win.cgFrame.intersects(f) {
            // Paint just the part of this window inside the region, at the window's
            // full size for the clamps, then place it (bitmap origin bottom-left).
            let sub = f.intersection(win.cgFrame)
            guard sub.width >= 1, sub.height >= 1 else { continue }
            let origin = win.local(sub.origin)
            let canvas = Canvas(opaque: false, rendersAsynchronously: false) { ctx, _ in
                ctx.translateBy(x: -origin.x, y: -origin.y)
                OverlayCanvasView.paint(win.model, now: now, topInset: win.topInset, size: win.cgFrame.size, in: ctx)
            }
            .frame(width: sub.width, height: sub.height)
            let renderer = ImageRenderer(content: canvas)
            renderer.scale = scale
            renderer.isOpaque = false
            guard let image = renderer.cgImage else { print("shot: no image for window \(win.windowNumber)"); continue }
            cg.draw(image, in: CGRect(x: sub.minX - f.minX, y: f.maxY - sub.maxY, width: sub.width, height: sub.height))
        }
        guard let png = rep.representation(using: .png, properties: [:]) else { print("shot failed: no PNG for", path); return }
        do {
            try png.write(to: URL(fileURLWithPath: path))
            print("shot:", path, "(\(note))", "region", region, "rendered in-process \(w)×\(h)")
        } catch {
            print("shot failed:", error)
        }
        fflush(stdout)
    }
}
#endif
