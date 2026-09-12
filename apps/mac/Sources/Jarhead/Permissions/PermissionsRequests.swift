import AppKit
import AVFoundation
import ApplicationServices
import Contacts
import CoreGraphics
import EventKit
import IOKit.hid
import Network
import Speech
import UserNotifications

/// The asking. One function per kind, each `async` and settled only when the system
/// dialog has been answered (or the API has said it will not show one), so a sweep can
/// await one prompt before firing the next — TCC dialogs stack badly. Every prompt here
/// needs its usage string in Resources/Info.plist (a missing one kills the app on first
/// access) and, under the hardened runtime, its entitlement in Resources/entitlements.plist:
///
///   AVCaptureDevice.requestAccess(.audio)      NSMicrophoneUsageDescription        device.audio-input
///   AVCaptureDevice.requestAccess(.video)      NSCameraUsageDescription            device.camera
///   SFSpeechRecognizer.requestAuthorization    NSSpeechRecognitionUsageDescription
///   AEDeterminePermissionToAutomateTarget      NSAppleEventsUsageDescription       automation.apple-events
///   CNContactStore.requestAccess               NSContactsUsageDescription          personal-information.addressbook
///   EKEventStore.requestFullAccessToEvents     NSCalendarsFullAccessUsageDescription   personal-information.calendars
///   EKEventStore.requestFullAccessToReminders  NSRemindersFullAccessUsageDescription   (calendars covers EventKit)
///   UNUserNotificationCenter.requestAuthorization   —                              (bundle only)
///   NWBrowser (_http._tcp)                     NSLocalNetworkUsageDescription + NSBonjourServices
///   opendir(~/Desktop | ~/Documents | ~/Downloads)   NS{Desktop,Documents,Downloads}FolderUsageDescription
///   IOHIDRequestAccess(listen), AXIsProcessTrustedWithOptions(prompt), CGRequestScreenCaptureAccess   —
///
/// Nothing here opens System Settings; that is the sweep's job (`PermissionsSweep`).
enum PermissionsRequests {

    /// Which API a kind's request goes through — for the dry run's log and the row's tooltip.
    static func describe(_ kind: PermissionKind) -> String {
        switch kind {
        case .microphone: return "AVCaptureDevice.requestAccess(.audio)"
        case .camera: return "AVCaptureDevice.requestAccess(.video)"
        case .speechRecognition: return "SFSpeechRecognizer.requestAuthorization"
        case .screenRecording: return "CGRequestScreenCaptureAccess"
        case .accessibility: return "AXIsProcessTrustedWithOptions(prompt)"
        case .inputMonitoring: return "IOHIDRequestAccess(listenEvent)"
        case .automation: return "AEDeterminePermissionToAutomateTarget(askUserIfNeeded) per running target"
        case .fullDiskAccess: return "System Settings only (Privacy_AllFiles) + reveal Jarhead.app"
        case .notifications: return "UNUserNotificationCenter.requestAuthorization(.alert, .sound)"
        case .contacts: return "CNContactStore.requestAccess(.contacts)"
        case .calendars: return "EKEventStore.requestFullAccessToEvents"
        case .reminders: return "EKEventStore.requestFullAccessToReminders"
        case .localNetwork: return "NWBrowser(_http._tcp) for a moment"
        case .filesDesktop: return "opendir(~/Desktop)"
        case .filesDocuments: return "opendir(~/Documents)"
        case .filesDownloads: return "opendir(~/Downloads)"
        }
    }

    /// Fire the one prompt a kind has and settle with the grant afterwards. A `settings`
    /// kind (Full Disk Access) has no prompt: this returns its current status untouched.
    /// Never call two of these at once.
    static func request(_ kind: PermissionKind) async -> (Grant, String?) {
        switch kind {
        case .microphone: return (await requestCapture(.audio), nil)
        case .camera: return (await requestCapture(.video), nil)
        case .speechRecognition: return (await requestSpeech(), nil)
        case .screenRecording: return (requestScreenRecording(), nil)
        case .accessibility: return (requestAccessibility(), nil)
        case .inputMonitoring: return (requestInputMonitoring(), nil)
        case .automation: return await requestAutomation()
        case .fullDiskAccess: return PermissionsKit.fullDiskAccessStatus()
        case .notifications: return await requestNotifications()
        case .contacts: return await requestContacts()
        case .calendars: return await requestCalendars()
        case .reminders: return await requestReminders()
        case .localNetwork: return (await requestLocalNetwork(), nil)
        case .filesDesktop, .filesDocuments, .filesDownloads: return await requestFolderAsync(kind)
        }
    }

    // MARK: microphone, camera

    static func requestCapture(_ media: AVMediaType) async -> Grant {
        switch AVCaptureDevice.authorizationStatus(for: media) {
        case .notDetermined:
            let ok = await AVCaptureDevice.requestAccess(for: media)
            return ok ? .granted : .denied
        case .authorized: return .granted
        case .denied, .restricted: return .denied
        @unknown default: return .unknown
        }
    }

    // MARK: speech

    static func requestSpeech() async -> Grant {
        guard SFSpeechRecognizer.authorizationStatus() == .notDetermined else { return PermissionsKit.speechRecognitionStatus() }
        return await withCheckedContinuation { cont in
            SFSpeechRecognizer.requestAuthorization { status in
                switch status {
                case .authorized: cont.resume(returning: .granted)
                case .denied, .restricted: cont.resume(returning: .denied)
                case .notDetermined: cont.resume(returning: .unknown)
                @unknown default: cont.resume(returning: .unknown)
                }
            }
        }
    }

    // MARK: screen recording, accessibility, input monitoring (the dialog returns at once)

    /// Shows the system dialog the first time; every later call only answers. Not granted
    /// afterwards means System Settings.
    @discardableResult
    static func requestScreenRecording() -> Grant {
        if CGPreflightScreenCaptureAccess() { return .granted }
        return CGRequestScreenCaptureAccess() ? .granted : .denied
    }

    @discardableResult
    static func requestAccessibility() -> Grant {
        if AXIsProcessTrusted() { return .granted }
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        return AXIsProcessTrustedWithOptions(options) ? .granted : .denied
    }

    @discardableResult
    static func requestInputMonitoring() -> Grant {
        if IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) == kIOHIDAccessTypeGranted { return .granted }
        return IOHIDRequestAccess(kIOHIDRequestTypeListenEvent) ? .granted : .denied
    }

    // MARK: automation — one target at a time

    private static let queue = DispatchQueue(label: "jarhead.permissions.requests", qos: .userInitiated)

    /// Asks for every target that is running, one dialog at a time, awaiting each. Never
    /// launches an app for it — except System Events, which is invisible and is what the
    /// AppleScript tool talks to most.
    static func requestAutomation() async -> (Grant, String?) {
        var answers: [(PermissionsKit.AutomationTarget, PermissionsKit.AutomationAnswer)] = []
        for target in PermissionsKit.automationTargets() {
            if target.bundleId == "com.apple.systemevents", !PermissionsKit.isRunning(bundleId: target.bundleId) {
                await launchSystemEvents()
            }
            guard PermissionsKit.isRunning(bundleId: target.bundleId) else {
                answers.append((target, .notRunning))
                continue
            }
            let answer: PermissionsKit.AutomationAnswer = await withCheckedContinuation { cont in
                queue.async { cont.resume(returning: PermissionsKit.automationAnswer(bundleId: target.bundleId, ask: true)) }
            }
            answers.append((target, answer))
        }
        return PermissionsKit.summarizeAutomation(answers)
    }

    private static func launchSystemEvents() async {
        let url = URL(fileURLWithPath: "/System/Library/CoreServices/System Events.app")
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        let config = NSWorkspace.OpenConfiguration()
        config.activates = false
        config.hides = true
        _ = try? await NSWorkspace.shared.openApplication(at: url, configuration: config)
        // It starts in well under a second; give it up to three.
        for _ in 0..<15 where !PermissionsKit.isRunning(bundleId: "com.apple.systemevents") {
            try? await Task.sleep(nanoseconds: 200_000_000)
        }
    }

    // MARK: notifications

    static func requestNotifications() async -> (Grant, String?) {
        guard PermissionsKit.runsAsBundle else { return (.unknown, "needs the app bundle") }
        let centre = UNUserNotificationCenter.current()
        let before = await centre.notificationSettings().authorizationStatus
        if before == .notDetermined {
            _ = try? await centre.requestAuthorization(options: [.alert, .sound])
        }
        return await PermissionsKit.notificationsStatus()
    }

    // MARK: contacts, calendars, reminders

    static func requestContacts() async -> (Grant, String?) {
        if CNContactStore.authorizationStatus(for: .contacts) == .notDetermined {
            let store = CNContactStore()
            _ = try? await store.requestAccess(for: .contacts)
        }
        return PermissionsKit.contactsStatus()
    }

    static func requestCalendars() async -> (Grant, String?) {
        if EKEventStore.authorizationStatus(for: .event) == .notDetermined {
            let store = EKEventStore()
            _ = try? await store.requestFullAccessToEvents()
        }
        return PermissionsKit.calendarsStatus()
    }

    static func requestReminders() async -> (Grant, String?) {
        if EKEventStore.authorizationStatus(for: .reminder) == .notDetermined {
            let store = EKEventStore()
            _ = try? await store.requestFullAccessToReminders()
        }
        return PermissionsKit.remindersStatus()
    }

    // MARK: local network

    /// The first browse is the prompt (macOS 15+); the browser waits with a policy denial
    /// until the dialog is answered. Wait for it — up to 45 s — then read.
    static func requestLocalNetwork() async -> Grant {
        PermissionsKit.markAsked(.localNetwork)
        PermissionsKit.forgetLocalNetwork()
        return await browseLocalNetwork(timeout: 45)
    }

    /// Browse for `_http._tcp` on Bonjour for up to `timeout` seconds. Ready without a
    /// policy denial is granted; a denial that is still standing at the deadline is
    /// denied; nothing at all (no Bonjour, no network) is unknown.
    static func browseLocalNetwork(timeout: TimeInterval) async -> Grant {
        await withCheckedContinuation { (cont: CheckedContinuation<Grant, Never>) in
            let browser = NWBrowser(for: .bonjour(type: "_http._tcp", domain: nil), using: .tcp)
            let box = BrowseBox()
            let finish: (Grant) -> Void = { grant in
                guard box.settle() else { return }
                browser.cancel()
                cont.resume(returning: grant)
            }
            browser.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    finish(.granted)
                case .waiting(let error), .failed(let error):
                    if isPolicyDenied(error) {
                        box.noteDenied()
                        if case .failed = state { finish(.denied) }
                    } else if case .failed = state {
                        finish(.unknown)
                    }
                case .cancelled:
                    finish(.unknown)
                default:
                    break
                }
            }
            browser.start(queue: queue)
            queue.asyncAfter(deadline: .now() + timeout) {
                finish(box.denied ? .denied : .unknown)
            }
        }
    }

    /// The browse's two flags behind a lock (the handler and the deadline run on `queue`,
    /// the continuation must resume exactly once).
    private final class BrowseBox: @unchecked Sendable {
        private let lock = NSLock()
        private var settled = false
        private var wasDenied = false
        /// True the first time only.
        func settle() -> Bool {
            lock.lock(); defer { lock.unlock() }
            if settled { return false }
            settled = true
            return true
        }
        func noteDenied() { lock.lock(); wasDenied = true; lock.unlock() }
        var denied: Bool { lock.lock(); defer { lock.unlock() }; return wasDenied }
    }

    private static func isPolicyDenied(_ error: NWError) -> Bool {
        switch error {
        case .dns(let code): return code == -65570 // kDNSServiceErr_PolicyDenied
        case .posix(let code): return code == .EPERM
        default: return false
        }
    }

    // MARK: the three folders

    /// Listing the folder is the prompt. Blocks until answered, so it runs off the main
    /// thread; the "asked" mark is set first so the reader may probe from now on.
    static func requestFolder(_ kind: PermissionKind) -> (Grant, String?) {
        PermissionsKit.markAsked(kind)
        let grant = PermissionsKit.probeFolder(kind)
        let path = PermissionsKit.folderURL(kind).map { ($0.path as NSString).abbreviatingWithTildeInPath }
        return (grant, path)
    }

    /// `requestFolder` off the main thread.
    static func requestFolderAsync(_ kind: PermissionKind) async -> (Grant, String?) {
        let raw = kind.rawValue
        return await withCheckedContinuation { cont in
            queue.async {
                guard let k = PermissionKind(rawValue: raw) else { return cont.resume(returning: (.unknown, nil)) }
                cont.resume(returning: requestFolder(k))
            }
        }
    }
}
