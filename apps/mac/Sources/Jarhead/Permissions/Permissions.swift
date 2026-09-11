import AppKit
import AVFoundation
import ApplicationServices
import CoreGraphics

/// TCC status and requests. The engine's hands helper reports screen recording and
/// accessibility itself (it inherits this app's TCC identity because the app is the
/// responsible process), so the app only *reports* the microphone to the daemon; the
/// other two are here for the Console's "open Settings" buttons and local display.
enum PermissionsKit {
    enum Pane: String {
        case microphone = "Privacy_Microphone"
        case screenRecording = "Privacy_ScreenCapture"
        case accessibility = "Privacy_Accessibility"
    }

    // MARK: microphone

    static func microphoneStatus() -> Grant {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return .granted
        case .denied, .restricted: return .denied
        case .notDetermined: return .unknown
        @unknown default: return .unknown
        }
    }

    /// Prompts when undetermined; otherwise reports the current state. Completion on the main queue.
    static func requestMicrophone(_ completion: @escaping (Grant) -> Void) {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { ok in
                DispatchQueue.main.async { completion(ok ? .granted : .denied) }
            }
        default:
            DispatchQueue.main.async { completion(microphoneStatus()) }
        }
    }

    // MARK: fresh reads through the bundled helper

    /// TCC answers can be stale inside a running process, so while anyone is asking
    /// (the Setup window polls every 2 s) a background refresher runs the bundled
    /// `jarhead-hands --permissions` — a fresh process — and the getters return its
    /// latest answer. Nothing here blocks the main thread; without the bundled
    /// helper the getters fall back to the in-process APIs.
    private static let refreshQueue = DispatchQueue(label: "jarhead.permissions.refresh", qos: .utility)
    private static let lock = NSLock()
    private static var freshAX: Bool?
    private static var freshSR: Bool?
    private static var lastAskedAt: Date = .distantPast
    private static var lastRefreshAt: Date = .distantPast
    private static var refreshing = false

    private static var helperURL: URL? {
        guard let url = Bundle.main.executableURL?.deletingLastPathComponent().appendingPathComponent("jarhead-hands") else { return nil }
        return FileManager.default.isExecutableFile(atPath: url.path) ? url : nil
    }

    /// Called by every getter: remembers that someone is watching and refreshes at most every 1.5 s.
    private static func noteAsked() {
        lock.lock()
        lastAskedAt = Date()
        let due = Date().timeIntervalSince(lastRefreshAt) > 1.5 && !refreshing
        if due { refreshing = true }
        lock.unlock()
        guard due, let helper = helperURL else { return }
        refreshQueue.async {
            defer { lock.lock(); refreshing = false; lastRefreshAt = Date(); lock.unlock() }
            let p = Process()
            p.executableURL = helper
            p.arguments = ["--permissions"]
            let out = Pipe()
            p.standardOutput = out
            p.standardError = FileHandle.nullDevice
            do { try p.run() } catch { return }
            let deadline = Date().addingTimeInterval(3)
            while p.isRunning && Date() < deadline { usleep(20_000) }
            if p.isRunning { p.terminate(); return }
            let data = out.fileHandleForReading.readDataToEndOfFile()
            guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
            lock.lock()
            freshAX = obj["accessibility"] as? Bool
            freshSR = obj["screenRecording"] as? Bool
            lock.unlock()
        }
    }

    /// Forget cached answers (after the user returns from System Settings, say).
    static func invalidate() {
        lock.lock(); lastRefreshAt = .distantPast; lock.unlock()
    }

    // MARK: screen recording

    static func screenRecordingStatus() -> Grant {
        noteAsked()
        lock.lock(); let fresh = freshSR; lock.unlock()
        if let fresh { return fresh ? .granted : .denied }
        return CGPreflightScreenCaptureAccess() ? .granted : .denied
    }

    /// Shows the system prompt the first time; later calls only open Settings.
    @discardableResult
    static func requestScreenRecording() -> Grant {
        if CGPreflightScreenCaptureAccess() { return .granted }
        return CGRequestScreenCaptureAccess() ? .granted : .denied
    }

    // MARK: accessibility

    static func accessibilityStatus() -> Grant {
        noteAsked()
        lock.lock(); let fresh = freshAX; lock.unlock()
        if let fresh { return fresh ? .granted : .denied }
        return AXIsProcessTrusted() ? .granted : .denied
    }

    @discardableResult
    static func requestAccessibility() -> Grant {
        if AXIsProcessTrusted() { return .granted }
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        return AXIsProcessTrustedWithOptions(options) ? .granted : .denied
    }

    // MARK: settings

    static func openSettings(pane: Pane) {
        let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane.rawValue)")!
        NSWorkspace.shared.open(url)
    }
}
