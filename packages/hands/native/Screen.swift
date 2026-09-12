import Foundation
import AppKit
import CoreGraphics
import ScreenCaptureKit

// MARK: - Displays
//
// All coordinates are global screen points, origin at the top-left of the main display,
// y increasing downward (CGDisplayBounds / CGEvent.location convention). A display above
// the main one has negative y; that is normal and never clamped.

struct DisplayInfo {
    let id: CGDirectDisplayID
    let bounds: CGRect
    let pixelWidth: Int
    let pixelHeight: Int

    var isMain: Bool { id == CGMainDisplayID() }
    var scale: Double { bounds.width > 0 ? Double(pixelWidth) / Double(bounds.width) : 1 }
}

func activeDisplayIDs() -> [CGDirectDisplayID] {
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return [] }
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    guard CGGetActiveDisplayList(count, &ids, &count) == .success else { return [] }
    return Array(ids.prefix(Int(count)))
}

func activeDisplays() -> [DisplayInfo] {
    return activeDisplayIDs().map { id in
        let bounds = CGDisplayBounds(id)
        let mode = CGDisplayCopyDisplayMode(id)
        return DisplayInfo(
            id: id,
            bounds: bounds,
            pixelWidth: mode?.pixelWidth ?? Int(bounds.width),
            pixelHeight: mode?.pixelHeight ?? Int(bounds.height)
        )
    }
}

/// Cheap fingerprint of the display arrangement, used to validate the ScreenCaptureKit cache.
func displaySignature() -> String {
    return activeDisplayIDs().map { id in
        let b = CGDisplayBounds(id)
        return "\(id):\(Int(b.origin.x)),\(Int(b.origin.y)),\(Int(b.width)),\(Int(b.height))"
    }.joined(separator: ";")
}

// MARK: - Frames and the display-configuration hash
//
// A screenshot is a frame; a coordinate action is aimed at one. The model may act on a frame
// only while the screen is still that frame's: the same displays with the same bounds, the same
// app in front with the same front window. The hash below says so in one short string, carried
// by every screenshot and by every probe the click gate runs (`element_at`, `focused_text`), so
// the TypeScript side compares two strings and never a pair of screenshots.

/// Frame numbers, one per captured image, for the model to refer to ("frame 12").
final class FrameCounter {
    static let shared = FrameCounter()
    private let lock = NSLock()
    private var value = 0

    func next() -> Int {
        lock.lock()
        defer { lock.unlock() }
        value += 1
        return value
    }
}

/// FNV-1a over UTF-8, as 16 hex digits: deterministic across helper restarts (Swift's Hasher is not).
func fnv1a(_ s: String) -> String {
    var hash: UInt64 = 0xcbf2_9ce4_8422_2325
    for byte in s.utf8 {
        hash ^= UInt64(byte)
        hash = hash &* 0x0000_0100_0000_01b3
    }
    return String(hash, radix: 16).leftPadded(to: 16)
}

private extension String {
    func leftPadded(to width: Int) -> String {
        return count >= width ? self : String(repeating: "0", count: width - count) + self
    }
}

/// The display arrangement plus the front app and its front (layer 0) window. Menus, sheets
/// inside the window and the cursor are not part of it: a menu opening does not stale the frame,
/// a new window, a switched app or a moved display does. ~1–3 ms (one CGWindowList read).
func displayConfigHash() -> String {
    var parts = displaySignature()
    if let app = onMain({ NSWorkspace.shared.frontmostApplication }) {
        parts += "|\(app.bundleIdentifier ?? "")|\(app.processIdentifier)"
        if let window = windowInfos(allLayers: false).first(where: { $0.pid == Int(app.processIdentifier) }) {
            parts += "|\(window.windowId)"
        }
    }
    return fnv1a(parts)
}

private func distance(from point: CGPoint, to rect: CGRect) -> CGFloat {
    let dx = max(rect.minX - point.x, 0, point.x - rect.maxX)
    let dy = max(rect.minY - point.y, 0, point.y - rect.maxY)
    return (dx * dx + dy * dy).squareRoot()
}

func displayContaining(_ point: CGPoint, in displays: [DisplayInfo]) -> DisplayInfo? {
    // CGRect.contains excludes the max edges; fall back to the nearest display so a cursor
    // parked on the right/bottom edge still resolves.
    if let hit = displays.first(where: { $0.bounds.contains(point) }) { return hit }
    return displays.min { distance(from: point, to: $0.bounds) < distance(from: point, to: $1.bounds) }
}

func opDisplays() -> JSONObject {
    let list: [JSONObject] = activeDisplays().map { d in
        [
            "id": Int(d.id),
            "x": Double(d.bounds.origin.x),
            "y": Double(d.bounds.origin.y),
            "w": Double(d.bounds.width),
            "h": Double(d.bounds.height),
            "scale": d.scale,
            "main": d.isMain,
        ]
    }
    return ["displays": list]
}

/// display: number | "main" | "cursor" (default "cursor").
func resolveDisplay(_ params: Params) throws -> DisplayInfo {
    let displays = activeDisplays()
    guard !displays.isEmpty else { throw HandsError.captureFailed("no active displays") }
    let mainDisplay = displays.first(where: { $0.isMain }) ?? displays[0]
    func cursorDisplay() -> DisplayInfo {
        return displayContaining(cursorLocation(), in: displays) ?? mainDisplay
    }

    guard let raw = params.dict["display"], !(raw is NSNull) else { return cursorDisplay() }
    if let s = raw as? String {
        switch s.lowercased() {
        case "main": return mainDisplay
        case "cursor": return cursorDisplay()
        default:
            if let n = UInt32(s), let d = displays.first(where: { $0.id == n }) { return d }
            throw HandsError.badRequest("'display' must be a display id, \"main\" or \"cursor\"")
        }
    }
    if let n = raw as? NSNumber, !isJSONBool(n) {
        let id = n.int64Value
        guard let d = displays.first(where: { Int64($0.id) == id }) else {
            throw HandsError.notFound("display \(id) is not active")
        }
        return d
    }
    throw HandsError.badRequest("'display' must be a display id, \"main\" or \"cursor\"")
}

// MARK: - ScreenCaptureKit shareable-content cache
//
// SCShareableContent.excludingDesktopWindows costs 30-45 ms per call. The only things a
// capture needs from it are SCDisplay objects (stable per display id) and SCRunningApplication
// objects for the excluded pids (stable per process), so the snapshot is cached and refreshed
// when the display arrangement changes, when a needed pid is unknown, or every 30 s.

final class ShareableContentCache {
    static let shared = ShareableContentCache()

    private let lock = NSLock()
    private var content: SCShareableContent?
    private var signature = ""
    private var fetchedAt = DispatchTime.now()

    func invalidate() {
        lock.lock()
        content = nil
        lock.unlock()
    }

    func cached(displayID: CGDirectDisplayID, pids: Set<pid_t>, signature current: String) -> SCShareableContent? {
        lock.lock()
        defer { lock.unlock() }
        guard let content, signature == current else { return nil }
        let age = elapsedMs(since: fetchedAt)
        guard age < 30_000 else { return nil }
        guard content.displays.contains(where: { $0.displayID == displayID }) else { return nil }
        if !pids.isEmpty {
            let known = Set(content.applications.map { $0.processID })
            // Unknown pid: refetch, but at most once a second (the app may simply have no windows yet).
            if !pids.isSubset(of: known) && age > 1_000 { return nil }
        }
        return content
    }

    func store(_ fresh: SCShareableContent, signature current: String) {
        lock.lock()
        content = fresh
        signature = current
        fetchedAt = DispatchTime.now()
        lock.unlock()
    }
}

/// Must be called on the main thread before the run loop starts.
func installDisplayReconfigurationWatcher() {
    CGDisplayRegisterReconfigurationCallback({ _, _, _ in
        ShareableContentCache.shared.invalidate()
    }, nil)
}

// MARK: - Capture

struct CaptureSpec {
    let display: DisplayInfo
    /// Region in display-local points (origin top-left of that display); nil = whole display.
    let sourceRect: CGRect?
    /// Output size in pixels. SCK scales on the GPU.
    let width: Int
    let height: Int
    /// Every window owned by these processes is excluded (Jarhead hides its own overlays this way).
    let excludePids: Set<pid_t>
    let showCursor: Bool
}

private let screenRecordingHint =
    "Screen Recording is not granted. Grant it to the app that launched this helper "
    + "(the terminal or Jarhead.app) in System Settings > Privacy & Security > Screen Recording, "
    + "then relaunch that app."

func mapCaptureError(_ error: Error) -> HandsError {
    let ns = error as NSError
    // -3801 SCStreamErrorUserDeclined, -3803 SCStreamErrorMissingEntitlements
    let tccError = ns.domain == SCStreamErrorDomain && (ns.code == -3801 || ns.code == -3803)
    if tccError || !CGPreflightScreenCaptureAccess() {
        return .permissionDenied("\(screenRecordingHint) (\(ns.domain) \(ns.code))")
    }
    return .captureFailed("\(ns.domain) \(ns.code): \(ns.localizedDescription)")
}

func captureCGImage(_ spec: CaptureSpec) throws -> CGImage {
    do {
        return try runBlocking {
            let signature = displaySignature()
            let content: SCShareableContent
            if let cached = ShareableContentCache.shared.cached(displayID: spec.display.id, pids: spec.excludePids,
                                                                signature: signature) {
                content = cached
            } else {
                let t0 = DispatchTime.now()
                content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
                ShareableContentCache.shared.store(content, signature: signature)
                debugLog(String(format: "shareable content refreshed in %.1f ms", elapsedMs(since: t0)))
            }
            guard let scDisplay = content.displays.first(where: { $0.displayID == spec.display.id }) else {
                throw HandsError.captureFailed("display \(spec.display.id) is not available to ScreenCaptureKit")
            }
            let excludedApps = spec.excludePids.isEmpty ? [] : content.applications.filter {
                spec.excludePids.contains($0.processID)
            }
            let filter = SCContentFilter(display: scDisplay, excludingApplications: excludedApps, exceptingWindows: [])
            let config = SCStreamConfiguration()
            config.width = spec.width
            config.height = spec.height
            config.showsCursor = spec.showCursor
            config.pixelFormat = kCVPixelFormatType_32BGRA
            config.colorSpaceName = CGColorSpace.sRGB
            config.captureResolution = .best
            if let rect = spec.sourceRect { config.sourceRect = rect }
            return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        }
    } catch let error as HandsError {
        throw error
    } catch {
        throw mapCaptureError(error)
    }
}

private let useImageIOPNG = ProcessInfo.processInfo.environment["JARHEAD_HANDS_PNG"] == "imageio"

func encodePNG(_ image: CGImage) throws -> Data {
    if !useImageIOPNG, let fast = FastPNG.encode(image) { return fast }
    let rep = NSBitmapImageRep(cgImage: image)
    guard let data = rep.representation(using: .png, properties: [:]) else {
        throw HandsError.captureFailed("PNG encoding failed")
    }
    return data
}

/// Shared result shape for screenshot and zoom. `points` is the captured region in global points;
/// `scale` is exact image pixels per point (width / points.w) so the caller can map back with
/// points.x + px / scale.
func captureResult(spec: CaptureSpec, points: CGRect) throws -> JSONObject {
    // The configuration is read before the capture: what the model sees is the screen as it
    // was when the shutter opened, and a change during the encode stales the frame, not the hash.
    let config = displayConfigHash()
    let t0 = DispatchTime.now()
    let image = try captureCGImage(spec)
    let captureMs = elapsedMs(since: t0)
    let t1 = DispatchTime.now()
    let png = try encodePNG(image)
    debugLog(String(format: "capture %.1f ms, png %.1f ms, %dx%d, %d bytes",
                    captureMs, elapsedMs(since: t1), image.width, image.height, png.count))
    return [
        "displayId": Int(spec.display.id),
        "pngBase64": png.base64EncodedString(),
        "width": image.width,
        "height": image.height,
        "points": rectJSON(points),
        "scale": points.width > 0 ? Double(image.width) / Double(points.width) : 1,
        "frameId": FrameCounter.shared.next(),
        "config": config,
    ]
}

func downscaledSize(pixelWidth: Int, pixelHeight: Int, maxLongEdge: Double, maxPixels: Double) -> (Int, Int) {
    let pw = Double(max(pixelWidth, 1))
    let ph = Double(max(pixelHeight, 1))
    var s = min(1.0, maxLongEdge / max(pw, ph), (maxPixels / (pw * ph)).squareRoot())
    if !s.isFinite || s <= 0 { s = 1 }
    return (max(1, Int((pw * s).rounded())), max(1, Int((ph * s).rounded())))
}

func excludePidsParam(_ params: Params) throws -> Set<pid_t> {
    return Set((try params.intArray("excludePids") ?? []).map { pid_t(truncatingIfNeeded: $0) })
}

func opScreenshot(_ params: Params) throws -> JSONObject {
    let display = try resolveDisplay(params)
    let maxLongEdge = try params.double("maxLongEdge") ?? 2576
    let maxPixels = try params.double("maxPixels") ?? 3_750_000
    guard maxLongEdge >= 1 else { throw HandsError.badRequest("'maxLongEdge' must be >= 1") }
    guard maxPixels >= 1 else { throw HandsError.badRequest("'maxPixels' must be >= 1") }
    let showCursor = try params.bool("showCursor") ?? true
    let (w, h) = downscaledSize(pixelWidth: display.pixelWidth, pixelHeight: display.pixelHeight,
                                maxLongEdge: maxLongEdge, maxPixels: maxPixels)
    let spec = CaptureSpec(display: display, sourceRect: nil, width: w, height: h,
                           excludePids: try excludePidsParam(params), showCursor: showCursor)
    return try captureResult(spec: spec, points: display.bounds)
}

func opZoom(_ params: Params) throws -> JSONObject {
    let region = CGRect(x: try params.requireDouble("x"), y: try params.requireDouble("y"),
                        width: try params.requireDouble("w"), height: try params.requireDouble("h"))
    guard region.width > 0, region.height > 0 else { throw HandsError.badRequest("'w' and 'h' must be > 0") }
    let maxLongEdge = try params.double("maxLongEdge") ?? 2576
    guard maxLongEdge >= 1 else { throw HandsError.badRequest("'maxLongEdge' must be >= 1") }
    let showCursor = try params.bool("showCursor") ?? false

    let displays = activeDisplays()
    guard !displays.isEmpty else { throw HandsError.captureFailed("no active displays") }
    let center = CGPoint(x: region.midX, y: region.midY)
    let candidate = displays.first(where: { $0.bounds.contains(center) })
        ?? displays.max(by: { a, b in
            a.bounds.intersection(region).area < b.bounds.intersection(region).area
        })
    guard let display = candidate else { throw HandsError.badRequest("region is not on any display") }

    let clipped = region.intersection(display.bounds)
    guard !clipped.isNull, clipped.width >= 1, clipped.height >= 1 else {
        throw HandsError.badRequest("region is not on any display")
    }
    let local = CGRect(x: clipped.minX - display.bounds.minX, y: clipped.minY - display.bounds.minY,
                       width: clipped.width, height: clipped.height)

    var outW = Double(clipped.width) * display.scale
    var outH = Double(clipped.height) * display.scale
    let longEdge = max(outW, outH)
    if longEdge > maxLongEdge {
        let f = maxLongEdge / longEdge
        outW *= f
        outH *= f
    }
    let spec = CaptureSpec(display: display, sourceRect: local,
                           width: max(1, Int(outW.rounded())), height: max(1, Int(outH.rounded())),
                           excludePids: try excludePidsParam(params), showCursor: showCursor)
    return try captureResult(spec: spec, points: clipped)
}

private extension CGRect {
    var area: CGFloat { isNull ? 0 : width * height }
}
