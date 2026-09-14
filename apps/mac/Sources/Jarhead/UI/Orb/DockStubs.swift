import AppKit
import Combine
import ImageIO

// STUBS — every declaration in this file stands in for App-side API another builder
// lands (design7 § Contract, "App-side API"). The integrator deletes this file at merge
// and the panel compiles against the real members with the same spellings:
//
//   Model/AppState.swift        `@Published public var marking: Bool`, `markCommitted`,
//                               `markRemove(_:)`, `markWindow()`
//                               (here: `marking` / `markingPublisher` / `markCommitted` are
//                               computed over statics; the two verbs log instead of sending —
//                               `EngineCommand.markRemove/.markWindow` do not exist on this base.
//                               OrbPanelController reads `state.markingPublisher`: replace with
//                               `state.$marking.eraseToAnyPublisher()` when the real property lands.)
//   Model/ComposerWords.swift   `ComposerWords.placeholder/keepsText/askAboutMarks/markCaption`
//   Model/ProblemGlyphs.swift   `ProblemGlyphs.symbol(for:)` / `isWarning(_:)`
//   UI/Thumbnails.swift         `Thumbnails.shared.thumbnail(for:maxPixel:done:)`
//   Model/Remedy.swift          `EngineCommand.init?(remedyJSON: [String: Any])`
//   Model/Protocol.swift        `ScreenMark.source` / `isWindow` / `isPending`
//
// Nothing here is drawn on; nothing here is a design decision.

extension AppState {
    private static let stubMarking = CurrentValueSubject<Bool, Never>(false)
    private static let stubMarkCommitted = PassthroughSubject<Void, Never>()

    /// STUB for `@Published public var marking: Bool`.
    public var marking: Bool {
        get { Self.stubMarking.value }
        set { Self.stubMarking.send(newValue) }
    }
    /// STUB for `state.$marking`.
    public var markingPublisher: AnyPublisher<Bool, Never> { Self.stubMarking.eraseToAnyPublisher() }
    /// STUB for `public let markCommitted = PassthroughSubject<Void, Never>()`.
    public var markCommitted: PassthroughSubject<Void, Never> { Self.stubMarkCommitted }
    /// STUB for `send(.markRemove(id: id))`.
    public func markRemove(_ id: String) {
        #if JARHEAD_ORB_PREVIEW
        print("stub send: {\"type\":\"mark.remove\",\"id\":\"\(id)\"}")
        #endif
    }
    /// STUB for `send(.markWindow)`.
    public func markWindow() {
        #if JARHEAD_ORB_PREVIEW
        print("stub send: {\"type\":\"mark.window\"}")
        #endif
    }
}

extension ScreenMark {
    /// STUB for the wire's `source?: "circle" | "window"` (absent on this base: every mark is a circle).
    public var source: String? { nil }
    public var isWindow: Bool { source == "window" }
    public var isPending: Bool { !consumed }
}

/// STUB for `Model/ComposerWords.swift`.
public enum ComposerWords {
    public static func placeholder(phase: Phase, paused: Bool, typedWakes: Bool) -> String {
        if paused || phase == .paused { return "Paused — press Go or type to resume" }
        if phase == .asleep || phase == .error {
            return typedWakes ? "Type to wake Jarhead…" : "Type to Jarhead… (asleep: press Go)"
        }
        return "Say something…"
    }

    public static func keepsText(phase: Phase, typedWakes: Bool) -> Bool {
        (phase == .asleep || phase == .error) && !typedWakes
    }

    public static func askAboutMarks(window: Bool) -> String {
        window ? "What's in this window?" : "What did I circle?"
    }

    public static func markCaption(_ m: ScreenMark, now: Date) -> String {
        var parts: [String] = []
        let w = Int(m.rect.w.rounded()), h = Int(m.rect.h.rounded())
        if m.isWindow {
            parts.append("Captured")
            if let app = m.element?.app, !app.isEmpty { parts.append(app) }
            parts.append("\(w)×\(h)")
        } else {
            parts.append("Circled")
            parts.append("\(w)×\(h)")
        }
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        parts.append(f.string(from: Date(timeIntervalSince1970: m.at / 1000)))
        parts.append(m.consumed ? "used" : "pending")
        if !m.isWindow, let e = m.element {
            var el = ""
            if let role = e.role, !role.isEmpty { el = role }
            if let title = e.title, !title.isEmpty { el += (el.isEmpty ? "" : " ") + "\"\(title)\"" }
            if let app = e.app, !app.isEmpty { el += (el.isEmpty ? "" : " in ") + app }
            if !el.isEmpty { parts.append(el) }
        }
        let s = Int(max(0, now.timeIntervalSince1970 - m.at / 1000))
        let age: String
        if s < 5 { age = "now" } else if s < 60 { age = "\(s)s" } else if s < 3600 { age = "\(s / 60)m" } else { age = "\(s / 3600)h" }
        parts.append(age)
        return parts.joined(separator: " · ")
    }
}

/// STUB for `Model/ProblemGlyphs.swift` (the table `ConsoleTheme.problemSymbol` keeps today).
public enum ProblemGlyphs {
    public static func symbol(for kind: String) -> String {
        switch kind {
        case "permission.accessibility": return "hand.raised.fill"
        case "permission.screenRecording": return "rectangle.inset.filled.badge.record"
        case "permission.microphone": return "mic.slash.fill"
        case "permission.fullDiskAccess": return "externaldrive.fill.badge.person.crop"
        case "permission.other": return "lock.fill"
        case "brain.unavailable", "brain.probe", "brain.local": return "brain.head.profile.fill"
        case "voice.limit": return "waveform.badge.exclamationmark"
        case "voice.connection": return "wifi.exclamationmark"
        case "voice.key": return "key.fill"
        case "hands.helper": return "hand.tap.fill"
        case "disk.low": return "externaldrive.fill.badge.exclamationmark"
        case "dock": return "dock.rectangle"
        case "daemon": return "gearshape.2.fill"
        case "crash": return "bolt.trianglebadge.exclamationmark.fill"
        default: return "exclamationmark.triangle.fill"
        }
    }

    public static func isWarning(_ kind: String) -> Bool {
        kind.hasPrefix("permission.") || kind == "dock"
    }
}

/// STUB for `UI/Thumbnails.swift` (`ConsoleThumbnails` moved): decodes a PNG to at most
/// `maxPixel` a side on a background queue, answers on the main queue, caches by URL and size.
public final class Thumbnails {
    public static let shared = Thumbnails()
    private let queue = DispatchQueue(label: "jarhead.dock.thumbnails", qos: .userInitiated)
    private var cache: [String: CGImage] = [:]
    private let lock = NSLock()

    public func thumbnail(for url: URL, maxPixel: Int, done: @escaping (CGImage?) -> Void) {
        let key = url.path + "|\(maxPixel)"
        lock.lock()
        let hit = cache[key]
        lock.unlock()
        if let hit { done(hit); return }
        queue.async { [weak self] in
            var image: CGImage?
            if let src = CGImageSourceCreateWithURL(url as CFURL, nil) {
                let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
                                             kCGImageSourceThumbnailMaxPixelSize: maxPixel,
                                             kCGImageSourceCreateThumbnailWithTransform: true]
                image = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary)
            }
            if let image, let self {
                self.lock.lock(); self.cache[key] = image; self.lock.unlock()
            }
            DispatchQueue.main.async { done(image) }
        }
    }
}

extension EngineCommand {
    /// STUB for `Model/Remedy.swift`'s decoder over `[String: Any]` (the Console's takes
    /// `[String: JSONValue]`). The real one adds `case "mark.remove"` / `case "mark.window"`.
    public init?(remedyJSON o: [String: Any]) {
        guard let type = o["type"] as? String else { return nil }
        func str(_ key: String) -> String? { o[key] as? String }
        switch type {
        case "sleep":
            if let cause = str("cause"), !cause.isEmpty { self = .sleepCause(cause) } else { self = .sleep }
        case "mute": self = .mute
        case "unmute": self = .unmute
        case "stop": self = .stop
        case "go": self = .go
        case "pause": self = .pause
        case "resume": self = .resume
        case "interrupt": self = .interrupt(how: str("how") ?? "pressed")
        case "clear-problems": self = .clearProblems
        case "agent.refresh": self = .agentRefresh
        case "daemon.restart": self = .daemonRestart
        case "config.probe": self = .probeSetup
        case "open-console": self = .openConsole
        case "open-ledger": self = .openLedger
        case "ledger.sweep": self = .ledgerSweep
        case "conversation.new": self = .conversationNew
        case "now.clear": self = .nowClear
        case "now.restore": self = .nowRestore
        case "mark.clear": self = .markClear
        case "request-permission":
            guard let which = str("which") else { return nil }
            self = .requestPermission(which)
        case "problem.retry":
            guard let kind = str("kind") else { return nil }
            self = .problemRetry(kind: kind)
        case "thread.stop":
            guard let id = str("threadId"), !id.isEmpty else { return nil }
            self = .threadStop(threadId: id)
        default:
            return nil
        }
    }
}
