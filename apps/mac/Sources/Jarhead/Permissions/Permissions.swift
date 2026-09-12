import AppKit
import AVFoundation
import ApplicationServices
import Contacts
import CoreGraphics
import EventKit
import IOKit.hid
import Speech
import UserNotifications

/// TCC as this process sees it, for every permission Jarhead can use (the sixteen
/// `PermissionKind`s of the contract), read without ever prompting.
///
/// Two facts shape everything here. First: macOS keys every grant on the *responsible
/// process* — the app bundle when this runs as /Applications/Jarhead.app (the daemon and
/// the hands helper are its children, so their prompts and grants are the app's), and
/// Terminal when a dev binary or a harness runs from a shell. A status this file reports
/// is the status of *that* process. Second: nothing grants a permission programmatically.
/// A `prompt` kind gets one system dialog, once, through its API; a `settings` kind (Full
/// Disk Access; any prompt kind that was denied) is granted only in System Settings, so
/// the most this code can do is deep-link to the exact pane, reveal the app for dragging
/// in, and watch for the change. The asking lives in `PermissionsRequests.swift`; the
/// sweep that asks for everything in order lives in `PermissionsSweep.swift`. Nothing in
/// this file shows a dialog.
enum PermissionsKit {

    // MARK: - what each kind is

    struct Meta: Equatable {
        let label: String
        /// One line, lowercase: what stops working without it.
        let why: String
        let ask: PermissionAsk
        /// Without it the voice or the hands do not work.
        let required: Bool
        /// Solid SF Symbol for the row.
        let symbol: String
        /// The System Settings pane that grants it.
        let pane: Pane
    }

    static func meta(_ kind: PermissionKind) -> Meta {
        switch kind {
        case .microphone:
            return Meta(label: "Microphone", why: "so it can hear you", ask: .prompt, required: true, symbol: "mic.fill", pane: .microphone)
        case .speechRecognition:
            return Meta(label: "Speech Recognition", why: "the wake word, on device", ask: .prompt, required: true, symbol: "captions.bubble.fill", pane: .speechRecognition)
        case .screenRecording:
            return Meta(label: "Screen Recording", why: "so the hands can see the screen", ask: .prompt, required: true, symbol: "rectangle.inset.filled.badge.record", pane: .screenRecording)
        case .accessibility:
            return Meta(label: "Accessibility", why: "so the hands can click, type and read", ask: .prompt, required: true, symbol: "hand.raised.fill", pane: .accessibility)
        case .inputMonitoring:
            return Meta(label: "Input Monitoring", why: "typing and clicks land, and it notices yours", ask: .prompt, required: true, symbol: "keyboard.fill", pane: .inputMonitoring)
        case .automation:
            return Meta(label: "Automation", why: "the browser fast path and the AppleScript tool", ask: .perApp, required: true, symbol: "applescript.fill", pane: .automation)
        case .fullDiskAccess:
            return Meta(label: "Full Disk Access", why: "the file tools reach every folder without a wall", ask: .settings, required: true, symbol: "internaldrive.fill", pane: .fullDiskAccess)
        case .notifications:
            return Meta(label: "Notifications", why: "a word when a task finishes while you are away", ask: .prompt, required: false, symbol: "bell.fill", pane: .notifications)
        case .camera:
            return Meta(label: "Camera", why: "a look through the camera, only when you ask", ask: .prompt, required: false, symbol: "camera.fill", pane: .camera)
        case .contacts:
            return Meta(label: "Contacts", why: "names and addresses when you ask", ask: .prompt, required: false, symbol: "person.crop.circle.fill", pane: .contacts)
        case .calendars:
            return Meta(label: "Calendars", why: "reading and adding events", ask: .prompt, required: false, symbol: "calendar", pane: .calendars)
        case .reminders:
            return Meta(label: "Reminders", why: "reading and adding reminders", ask: .prompt, required: false, symbol: "checklist", pane: .reminders)
        case .localNetwork:
            return Meta(label: "Local Network", why: "devices and servers on your network", ask: .prompt, required: false, symbol: "network", pane: .localNetwork)
        case .filesDesktop:
            return Meta(label: "Desktop folder", why: "files on the Desktop", ask: .prompt, required: false, symbol: "desktopcomputer", pane: .filesAndFolders)
        case .filesDocuments:
            return Meta(label: "Documents folder", why: "files in Documents", ask: .prompt, required: false, symbol: "doc.fill", pane: .filesAndFolders)
        case .filesDownloads:
            return Meta(label: "Downloads folder", why: "files in Downloads", ask: .prompt, required: false, symbol: "arrow.down.circle.fill", pane: .filesAndFolders)
        }
    }

    /// The order the sweep asks in: required kinds first, in contract order, then the rest.
    static var sweepOrder: [PermissionKind] {
        PermissionKind.allCases.filter { meta($0).required } + PermissionKind.allCases.filter { !meta($0).required }
    }

    static var requiredKinds: [PermissionKind] { PermissionKind.allCases.filter { meta($0).required } }

    /// A placeholder row before the first read: the metadata, grant unknown.
    static func placeholder(_ kind: PermissionKind) -> PermissionInfo {
        let m = meta(kind)
        return PermissionInfo(kind: kind, grant: .unknown, ask: m.ask, required: m.required, label: m.label, why: m.why)
    }

    /// The whole list before the first read.
    static var placeholders: [PermissionInfo] { PermissionKind.allCases.map(placeholder) }

    // MARK: - System Settings panes

    /// Every pane a grant lives in. Privacy panes are queries on the Privacy & Security
    /// preference; Notifications is its own pane (not under Privacy), addressed by app.
    enum Pane: Equatable {
        case microphone, screenRecording, accessibility, speechRecognition
        case inputMonitoring, automation, fullDiskAccess, notifications, camera
        case contacts, calendars, reminders, localNetwork, filesAndFolders

        private var privacyQuery: String? {
            switch self {
            case .microphone: return "Privacy_Microphone"
            case .screenRecording: return "Privacy_ScreenCapture"
            case .accessibility: return "Privacy_Accessibility"
            case .speechRecognition: return "Privacy_SpeechRecognition"
            case .inputMonitoring: return "Privacy_ListenEvent"
            case .automation: return "Privacy_Automation"
            case .fullDiskAccess: return "Privacy_AllFiles"
            case .camera: return "Privacy_Camera"
            case .contacts: return "Privacy_Contacts"
            case .calendars: return "Privacy_Calendars"
            case .reminders: return "Privacy_Reminders"
            case .localNetwork: return "Privacy_LocalNetwork"
            case .filesAndFolders: return "Privacy_FilesAndFolders"
            case .notifications: return nil
            }
        }

        var url: URL {
            if let q = privacyQuery {
                return URL(string: "x-apple.systempreferences:com.apple.preference.security?\(q)")!
            }
            // Notifications › Jarhead. The `id` lands on the app's own row on macOS 13+.
            let id = Bundle.main.bundleIdentifier ?? "com.kevinliu.jarhead"
            return URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=\(id)")!
        }

        /// "Privacy & Security › Accessibility", for tooltips and toasts.
        var path: String {
            switch self {
            case .microphone: return "Privacy & Security › Microphone"
            case .screenRecording: return "Privacy & Security › Screen & System Audio Recording"
            case .accessibility: return "Privacy & Security › Accessibility"
            case .speechRecognition: return "Privacy & Security › Speech Recognition"
            case .inputMonitoring: return "Privacy & Security › Input Monitoring"
            case .automation: return "Privacy & Security › Automation"
            case .fullDiskAccess: return "Privacy & Security › Full Disk Access"
            case .notifications: return "Notifications › Jarhead"
            case .camera: return "Privacy & Security › Camera"
            case .contacts: return "Privacy & Security › Contacts"
            case .calendars: return "Privacy & Security › Calendars"
            case .reminders: return "Privacy & Security › Reminders"
            case .localNetwork: return "Privacy & Security › Local Network"
            case .filesAndFolders: return "Privacy & Security › Files and Folders"
            }
        }
    }

    static func pane(for kind: PermissionKind) -> Pane { meta(kind).pane }

    static func openSettings(pane: Pane) {
        NSWorkspace.shared.open(pane.url)
    }

    static func openSettings(for kind: PermissionKind) {
        openSettings(pane: pane(for: kind))
    }

    /// The bundle TCC keys the grants on: this one when we run as an app, else the
    /// installed one (the dev binary and the harnesses are not what Kevin drags in).
    static var appBundleURL: URL {
        let own = Bundle.main.bundleURL
        if own.pathExtension == "app" { return own }
        return URL(fileURLWithPath: "/Applications/Jarhead.app")
    }

    /// Select Jarhead.app in Finder so it can be dragged into a System Settings list
    /// (Full Disk Access has no prompt and no + button shortcut for an app that never asked).
    static func revealAppInFinder() {
        NSWorkspace.shared.activateFileViewerSelecting([appBundleURL])
    }

    /// True inside a real .app bundle. UNUserNotificationCenter aborts the process without one.
    static var runsAsBundle: Bool {
        Bundle.main.bundleURL.pathExtension == "app" && Bundle.main.bundleIdentifier != nil
    }

    // MARK: - reading: one kind, or all

    /// One kind, read now, without prompting. Async because a few kinds ask another
    /// process (Automation asks each target app, Notifications asks the notification
    /// centre, Local Network browses for a moment).
    static func read(_ kind: PermissionKind) async -> PermissionInfo {
        let m = meta(kind)
        if dryRunDenied.contains(kind) {
            return PermissionInfo(kind: kind, grant: .denied, ask: m.ask, required: m.required, label: m.label, why: m.why,
                                  detail: "dry run: pretend denied", checkedAt: Date().timeIntervalSince1970 * 1000)
        }
        let (grant, detail) = await readGrant(kind)
        return PermissionInfo(kind: kind, grant: grant, ask: m.ask, required: m.required, label: m.label, why: m.why,
                              detail: detail, checkedAt: Date().timeIntervalSince1970 * 1000)
    }

    /// Dry-run aid only: kinds to report as denied whatever TCC says, so the harness can
    /// walk the prompt-wait and the grouped-pane paths on a Mac that has granted them
    /// (`JARHEAD_PERMISSIONS_DRY_RUN_DENY=screenRecording,filesDesktop,…`). Read only
    /// while `JARHEAD_PERMISSIONS_DRY_RUN=1`, under which nothing is ever asked.
    static let dryRunDenied: Set<PermissionKind> = {
        let env = ProcessInfo.processInfo.environment
        guard env["JARHEAD_PERMISSIONS_DRY_RUN"] == "1", let raw = env["JARHEAD_PERMISSIONS_DRY_RUN_DENY"] else { return [] }
        return Set(raw.split(separator: ",").compactMap { PermissionKind(rawValue: $0.trimmingCharacters(in: .whitespaces)) })
    }()

    /// Every kind, in contract order. Read-only.
    static func readAll() async -> [PermissionInfo] {
        var out: [PermissionInfo] = []
        out.reserveCapacity(PermissionKind.allCases.count)
        for kind in PermissionKind.allCases { out.append(await read(kind)) }
        return out
    }

    private static func readGrant(_ kind: PermissionKind) async -> (Grant, String?) {
        switch kind {
        case .microphone: return (microphoneStatus(), nil)
        case .camera: return (cameraStatus(), nil)
        case .speechRecognition: return (speechRecognitionStatus(), nil)
        case .screenRecording: return (screenRecordingStatus(), nil)
        case .accessibility: return (accessibilityStatus(), nil)
        case .inputMonitoring: return (inputMonitoringStatus(), nil)
        case .automation: return await automationStatus()
        case .fullDiskAccess: return fullDiskAccessStatus()
        case .notifications: return await notificationsStatus()
        case .contacts: return contactsStatus()
        case .calendars: return calendarsStatus()
        case .reminders: return remindersStatus()
        case .localNetwork: return await localNetworkStatus()
        case .filesDesktop, .filesDocuments, .filesDownloads: return folderStatus(kind)
        }
    }

    // MARK: microphone, camera

    static func microphoneStatus() -> Grant { captureGrant(AVCaptureDevice.authorizationStatus(for: .audio)) }
    static func cameraStatus() -> Grant { captureGrant(AVCaptureDevice.authorizationStatus(for: .video)) }

    private static func captureGrant(_ s: AVAuthorizationStatus) -> Grant {
        switch s {
        case .authorized: return .granted
        case .denied, .restricted: return .denied
        case .notDetermined: return .unknown
        @unknown default: return .unknown
        }
    }

    /// Prompts when undetermined; otherwise reports the current state. Completion on the main queue.
    /// (The launch path asks for the microphone this way; the sweep uses `PermissionsRequests`.)
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

    // MARK: speech recognition

    static func speechRecognitionStatus() -> Grant {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: return .granted
        case .denied, .restricted: return .denied
        case .notDetermined: return .unknown
        @unknown default: return .unknown
        }
    }

    // MARK: fresh reads through the bundled helper

    /// TCC answers can be stale inside a running process (Screen Recording notoriously
    /// keeps the answer it got at launch), so while anyone is asking a background
    /// refresher runs the bundled `jarhead-hands --permissions` — a fresh process, the
    /// app's child and so the app's TCC identity — and the getters return its latest
    /// answer. Nothing here blocks the main thread; without the bundled helper (a dev
    /// binary, a harness) the getters fall back to the in-process APIs.
    private static let refreshQueue = DispatchQueue(label: "jarhead.permissions.refresh", qos: .utility)
    private static let lock = NSLock()
    private static var freshAX: Bool?
    private static var freshSR: Bool?
    private static var freshIM: Bool?
    private static var freshFDA: Bool?
    private static var lastRefreshAt: Date = .distantPast
    private static var refreshing = false

    private static var helperURL: URL? {
        guard let url = Bundle.main.executableURL?.deletingLastPathComponent().appendingPathComponent("jarhead-hands") else { return nil }
        return FileManager.default.isExecutableFile(atPath: url.path) ? url : nil
    }

    /// Called by the four getters: refreshes through the helper at most every 1.5 s.
    private static func noteAsked() {
        lock.lock()
        let due = Date().timeIntervalSince(lastRefreshAt) > 1.5 && !refreshing
        if due { refreshing = true }
        lock.unlock()
        guard due else { return }
        guard let helper = helperURL else {
            lock.lock(); refreshing = false; lock.unlock()
            return
        }
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
            // The helper prints all four (packages/hands/native/main.swift permissionsJSON).
            lock.lock()
            freshAX = obj["accessibility"] as? Bool
            freshSR = obj["screenRecording"] as? Bool
            freshIM = obj["inputMonitoring"] as? Bool
            freshFDA = obj["fullDiskAccess"] as? Bool
            lock.unlock()
        }
    }

    /// Forget the throttle (after the user returns from System Settings, say) so the next read is fresh.
    static func invalidate() {
        lock.lock(); lastRefreshAt = .distantPast; lock.unlock()
    }

    // MARK: screen recording, accessibility

    static func screenRecordingStatus() -> Grant {
        noteAsked()
        lock.lock(); let fresh = freshSR; lock.unlock()
        if let fresh { return fresh ? .granted : .denied }
        return CGPreflightScreenCaptureAccess() ? .granted : .denied
    }

    static func accessibilityStatus() -> Grant {
        noteAsked()
        lock.lock(); let fresh = freshAX; lock.unlock()
        if let fresh { return fresh ? .granted : .denied }
        return AXIsProcessTrusted() ? .granted : .denied
    }

    // MARK: input monitoring

    /// Listening for events (the ear's key and click notices, CGEvent taps). Posting
    /// events rides on Accessibility; this is the other half. A grant made while the app
    /// runs reaches this process only at relaunch, so the helper's fresh answer is
    /// preferred; the in-process read still tells "not asked" from "denied".
    static func inputMonitoringStatus() -> Grant {
        noteAsked()
        lock.lock(); let fresh = freshIM; lock.unlock()
        if fresh == true { return .granted }
        switch IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) {
        case kIOHIDAccessTypeGranted: return fresh == false ? .denied : .granted // a fresh no beats a stale yes
        case kIOHIDAccessTypeDenied: return .denied
        default: return .unknown
        }
    }

    // MARK: automation (per target app)

    struct AutomationTarget: Equatable {
        let name: String
        let bundleId: String
    }

    /// The apps Jarhead scripts. Fixed list first; `automationTargets()` adds the curated
    /// extras that are running right now.
    static let fixedAutomationTargets: [AutomationTarget] = [
        AutomationTarget(name: "System Events", bundleId: "com.apple.systemevents"),
        AutomationTarget(name: "Finder", bundleId: "com.apple.finder"),
        AutomationTarget(name: "Safari", bundleId: "com.apple.Safari"),
        AutomationTarget(name: "Google Chrome", bundleId: "com.google.Chrome"),
        AutomationTarget(name: "Terminal", bundleId: "com.apple.Terminal"),
        AutomationTarget(name: "Mail", bundleId: "com.apple.mail"),
        AutomationTarget(name: "Messages", bundleId: "com.apple.MobileSMS"),
        AutomationTarget(name: "Notes", bundleId: "com.apple.Notes"),
        AutomationTarget(name: "Calendar", bundleId: "com.apple.iCal"),
        AutomationTarget(name: "Reminders", bundleId: "com.apple.reminders"),
        AutomationTarget(name: "Music", bundleId: "com.apple.Music"),
    ]

    /// Apps beyond the fixed list that Jarhead scripts when they are up: the other
    /// browsers (the browser fast path), terminals and editors. Counted only while
    /// running. Nothing else that happens to be scriptable (System Settings, Preview, a
    /// chat app) is ever a target: every target is one consent dialog in the sweep.
    static let extraAutomationTargets: [AutomationTarget] = [
        AutomationTarget(name: "Arc", bundleId: "company.thebrowser.Browser"),
        AutomationTarget(name: "Brave", bundleId: "com.brave.Browser"),
        AutomationTarget(name: "Microsoft Edge", bundleId: "com.microsoft.edgemac"),
        AutomationTarget(name: "Chromium", bundleId: "org.chromium.Chromium"),
        AutomationTarget(name: "Firefox", bundleId: "org.mozilla.firefox"),
        AutomationTarget(name: "Orion", bundleId: "com.kagi.kagimacOS"),
        AutomationTarget(name: "iTerm", bundleId: "com.googlecode.iterm2"),
        AutomationTarget(name: "Warp", bundleId: "dev.warp.Warp-Stable"),
        AutomationTarget(name: "Ghostty", bundleId: "com.mitchellh.ghostty"),
        AutomationTarget(name: "Visual Studio Code", bundleId: "com.microsoft.VSCode"),
        AutomationTarget(name: "Cursor", bundleId: "com.todesktop.230313mzl4w4u92"),
        AutomationTarget(name: "Zed", bundleId: "dev.zed.Zed"),
        AutomationTarget(name: "Xcode", bundleId: "com.apple.dt.Xcode"),
        AutomationTarget(name: "Sublime Text", bundleId: "com.sublimetext.4"),
    ]

    /// The fixed list plus the curated extras that are running right now.
    static func automationTargets() -> [AutomationTarget] {
        fixedAutomationTargets + extraAutomationTargets.filter { isRunning(bundleId: $0.bundleId) }
    }

    enum AutomationAnswer: Equatable {
        case granted, denied, notAsked, notRunning
        case other(Int32)
    }

    /// What TCC says about sending Apple events to one app. `ask: false` never prompts
    /// and never launches: a target that is not running answers `notRunning`.
    /// With `ask: true` the call blocks until the user answers the dialog — call it off
    /// the main thread (PermissionsRequests does).
    static func automationAnswer(bundleId: String, ask: Bool) -> AutomationAnswer {
        let desc = NSAppleEventDescriptor(bundleIdentifier: bundleId)
        guard let ae = desc.aeDesc else { return .other(-1) }
        let status = AEDeterminePermissionToAutomateTarget(ae, typeWildCard, typeWildCard, ask)
        switch status {
        case 0: return .granted                 // noErr
        case -1743: return .denied              // errAEEventNotPermitted
        case -1744: return .notAsked            // errAEEventWouldRequireUserConsent
        case -600: return .notRunning           // procNotFound
        default: return .other(status)
        }
    }

    static func isRunning(bundleId: String) -> Bool {
        !NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).isEmpty
    }

    private static let automationQueue = DispatchQueue(label: "jarhead.permissions.automation", qos: .userInitiated)

    /// Every target read without prompting. Granted when every *running* target is
    /// granted, denied when any is denied, unknown otherwise (a running target never
    /// asked, or nothing scriptable running). Detail names them.
    static func automationStatus() async -> (Grant, String?) {
        let targets = automationTargets()
        let answers: [(AutomationTarget, AutomationAnswer)] = await withCheckedContinuation { cont in
            automationQueue.async {
                cont.resume(returning: targets.map { ($0, automationAnswer(bundleId: $0.bundleId, ask: false)) })
            }
        }
        return summarizeAutomation(answers)
    }

    /// "granted: Finder, System Events · not asked: Chrome · denied: Mail · 6 not running".
    static func summarizeAutomation(_ answers: [(AutomationTarget, AutomationAnswer)]) -> (Grant, String?) {
        var granted: [String] = [], denied: [String] = [], notAsked: [String] = []
        var notRunning = 0
        for (t, a) in answers {
            switch a {
            case .granted: granted.append(t.name)
            case .denied: denied.append(t.name)
            case .notAsked: notAsked.append(t.name)
            case .notRunning: notRunning += 1
            case .other: notAsked.append(t.name)
            }
        }
        var parts: [String] = []
        if !granted.isEmpty { parts.append("granted: " + granted.joined(separator: ", ")) }
        if !notAsked.isEmpty { parts.append("not asked: " + notAsked.joined(separator: ", ")) }
        if !denied.isEmpty { parts.append("denied: " + denied.joined(separator: ", ")) }
        if notRunning > 0 { parts.append("\(notRunning) not running") }
        let running = granted.count + denied.count + notAsked.count
        let grant: Grant
        if !denied.isEmpty { grant = .denied }
        else if running > 0, notAsked.isEmpty { grant = .granted }
        else { grant = .unknown }
        if running == 0 { parts.insert("nothing scriptable running", at: 0) }
        return (grant, parts.joined(separator: " · "))
    }

    // MARK: full disk access

    /// The canonical probe: can this process open the user's TCC database (or list
    /// ~/Library/Safari)? EPERM means no; success means yes. No prompt exists for it. The
    /// helper's fresh answer (the same probe from a new process) is preferred when it has
    /// landed: the kernel remembers this process's answer.
    static func fullDiskAccessStatus() -> (Grant, String?) {
        noteAsked()
        lock.lock(); let fresh = freshFDA; lock.unlock()
        if let fresh { return (fresh ? .granted : .denied, nil) }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let db = home + "/Library/Application Support/com.apple.TCC/TCC.db"
        let fd = open(db, O_RDONLY)
        if fd >= 0 {
            close(fd)
            return (.granted, nil)
        }
        if errno == EPERM { return (.denied, nil) }
        if let d = opendir(home + "/Library/Safari") {
            closedir(d)
            return (.granted, nil)
        }
        if errno == EPERM { return (.denied, nil) }
        return (.unknown, "could not probe")
    }

    // MARK: notifications

    static func notificationsStatus() async -> (Grant, String?) {
        guard runsAsBundle else { return (.unknown, "needs the app bundle") }
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral: return (.granted, nil)
        case .denied: return (.denied, nil)
        case .notDetermined: return (.unknown, nil)
        @unknown default: return (.unknown, nil)
        }
    }

    // MARK: contacts, calendars, reminders

    static func contactsStatus() -> (Grant, String?) {
        switch CNContactStore.authorizationStatus(for: .contacts) {
        case .authorized: return (.granted, nil)
        case .denied, .restricted: return (.denied, nil)
        case .notDetermined: return (.unknown, nil)
        // `.limited` (macOS 15) and anything newer: some access is access.
        default: return (.granted, "limited")
        }
    }

    static func calendarsStatus() -> (Grant, String?) { eventKitGrant(EKEventStore.authorizationStatus(for: .event)) }
    static func remindersStatus() -> (Grant, String?) { eventKitGrant(EKEventStore.authorizationStatus(for: .reminder)) }

    private static func eventKitGrant(_ s: EKAuthorizationStatus) -> (Grant, String?) {
        switch s {
        case .fullAccess, .authorized: return (.granted, nil)
        case .writeOnly: return (.denied, "write only · needs full access")
        case .denied, .restricted: return (.denied, nil)
        case .notDetermined: return (.unknown, nil)
        @unknown default: return (.unknown, nil)
        }
    }

    // MARK: local network and the three folders (first touch is the prompt)

    /// Kinds whose first real attempt *is* the system prompt. The reader must not touch
    /// them until the sweep has asked, so it reports unknown until then; the "asked"
    /// mark is kept per bundle in UserDefaults (TCC keeps the answer, so a later read
    /// only reads).
    private static func askedKey(_ kind: PermissionKind) -> String { "jarhead.permissions.asked.\(kind.rawValue)" }

    static func hasAsked(_ kind: PermissionKind) -> Bool { UserDefaults.standard.bool(forKey: askedKey(kind)) }

    static func markAsked(_ kind: PermissionKind) { UserDefaults.standard.set(true, forKey: askedKey(kind)) }

    /// The folder a files kind guards.
    static func folderURL(_ kind: PermissionKind) -> URL? {
        let fm = FileManager.default
        switch kind {
        case .filesDesktop: return fm.urls(for: .desktopDirectory, in: .userDomainMask).first
        case .filesDocuments: return fm.urls(for: .documentDirectory, in: .userDomainMask).first
        case .filesDownloads: return fm.urls(for: .downloadsDirectory, in: .userDomainMask).first
        default: return nil
        }
    }

    /// Lists the folder: success is granted, EPERM is denied. This is what prompts the
    /// first time, so it is called by the reader only after `hasAsked`, and by the request.
    static func probeFolder(_ kind: PermissionKind) -> Grant {
        guard let url = folderURL(kind) else { return .unknown }
        if let d = opendir(url.path) {
            closedir(d)
            return .granted
        }
        return errno == EPERM ? .denied : .unknown
    }

    static func folderStatus(_ kind: PermissionKind) -> (Grant, String?) {
        let path = folderURL(kind).map { ($0.path as NSString).abbreviatingWithTildeInPath }
        guard hasAsked(kind) else { return (.unknown, path) }
        return (probeFolder(kind), path)
    }

    /// No status API exists: unknown until the sweep has browsed once; afterwards a short
    /// browse (no second prompt) says whether the policy denies it. The answer is kept
    /// for 10 s so the 2 s poll and the 1.5 s watch do not browse back to back.
    private static var localNetworkCache: (at: Date, grant: Grant)?

    private static func cachedLocalNetwork() -> Grant? {
        lock.lock(); defer { lock.unlock() }
        guard let c = localNetworkCache, Date().timeIntervalSince(c.at) < 10 else { return nil }
        return c.grant
    }

    private static func rememberLocalNetwork(_ grant: Grant) {
        lock.lock(); localNetworkCache = (Date(), grant); lock.unlock()
    }

    static func localNetworkStatus() async -> (Grant, String?) {
        guard hasAsked(.localNetwork) else { return (.unknown, nil) }
        if let cached = cachedLocalNetwork() { return (cached, nil) }
        let grant = await PermissionsRequests.browseLocalNetwork(timeout: 1.5)
        rememberLocalNetwork(grant)
        return (grant, nil)
    }

    /// Forget the local-network answer (after its request, so the next read is the fresh one).
    static func forgetLocalNetwork() {
        lock.lock(); localNetworkCache = nil; lock.unlock()
    }

    // MARK: - what the sweep does with a row that is not granted

    /// Whether opening the pane can still help: anything not granted with a pane, except
    /// Automation with no target denied (nothing to switch on) and Notifications outside a
    /// bundle (no row exists).
    static func settingsCanHelp(_ info: PermissionInfo) -> Bool {
        guard info.grant != .granted else { return false }
        switch info.kind {
        case .automation: return info.grant == .denied
        case .notifications: return runsAsBundle
        default: return true
        }
    }

    /// "14 of 16 granted · Full Disk Access needs System Settings"
    static func summary(_ list: [PermissionInfo]) -> String {
        let granted = list.filter { $0.grant == .granted }.count
        var s = "\(granted) of \(list.count) granted"
        let pending = list.filter { $0.grant != .granted }
        let settings = pending.filter { $0.ask == .settings || $0.grant == .denied }.map(\.label)
        if settings.count == 1 { s += " · \(settings[0]) needs System Settings" }
        else if settings.count > 1 { s += " · \(settings.count) need System Settings" }
        let unasked = pending.filter { !settings.contains($0.label) }
        if !unasked.isEmpty, settings.isEmpty { s += " · \(unasked.count) not asked" }
        return s
    }
}
