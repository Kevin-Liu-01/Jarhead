import Foundation
import ImageIO
import CoreGraphics

/// Decodes and downsamples screenshots off the main thread with ImageIO, once per path and
/// size, and hands the UI a small CGImage on the main queue. Shared by the Console's
/// `ScreenshotThumb` / `MarkThumb` and the notch's thumb strip (the orb harness compiles
/// `Model + UI + UI/Orb + UI/Overlay`, so nothing here is SwiftUI). The full-resolution read
/// is only for the lightbox.
public final class Thumbnails {
    public static let shared = Thumbnails()

    /// Set only by the Console preview harness (PREVIEW_SLOW_THUMBS=1): every thumbnail waits a
    /// minute before decoding, so the dithered skeletons stay on screen to shoot.
    public static var holdForPreview = false

    private let queue = DispatchQueue(label: "jarhead.thumbnails", qos: .utility, attributes: .concurrent)
    private let lock = NSLock()
    private var cache: [String: CGImage] = [:]
    /// Callbacks waiting on a decode already under way for the same key, so a mark shown on the
    /// notch and in the Console decodes once.
    private var waiting: [String: [(CGImage?) -> Void]] = [:]

    /// The crop at most `maxPixel` a side; `done` on the main queue, at once from the cache.
    public func thumbnail(for url: URL, maxPixel: Int, done: @escaping (CGImage?) -> Void) {
        let key = "\(maxPixel)|\(url.path)"
        lock.lock()
        if let hit = cache[key] {
            lock.unlock()
            done(hit)
            return
        }
        let first = waiting[key] == nil
        waiting[key, default: []].append(done)
        lock.unlock()
        guard first else { return }
        queue.async { [weak self] in
            if Self.holdForPreview { Thread.sleep(forTimeInterval: 60) }
            let image = Self.decodeThumbnail(url, maxPixel: maxPixel)
            guard let self else { return }
            self.lock.lock()
            if let image {
                if self.cache.count >= 256 { self.cache.removeAll(keepingCapacity: true) }
                self.cache[key] = image
            }
            let callbacks = self.waiting.removeValue(forKey: key) ?? []
            self.lock.unlock()
            DispatchQueue.main.async { for cb in callbacks { cb(image) } }
        }
    }

    /// The same decode for a SwiftUI `.task`.
    public func thumbnail(for url: URL, maxPixel: Int) async -> CGImage? {
        await withCheckedContinuation { c in thumbnail(for: url, maxPixel: maxPixel) { c.resume(returning: $0) } }
    }

    public static func decodeThumbnail(_ url: URL, maxPixel: Int) -> CGImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }

    /// Full resolution, decoded immediately so the first draw does no work on the main thread.
    public static func decodeFull(_ url: URL) -> CGImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        let options: [CFString: Any] = [kCGImageSourceShouldCacheImmediately: true]
        return CGImageSourceCreateImageAtIndex(source, 0, options as CFDictionary)
    }
}
