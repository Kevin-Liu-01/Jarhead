import AppKit
@preconcurrency import UserNotifications

/// The macOS banner for a fired automation (design11 § macOS notification): one category, `jarhead.automation`,
/// with `Snooze N` · `Done` (and `Open` when the ring carries a target); a press lands on the same row as the
/// island's presses through the closures the app installs. `willPresent` shows the banner with no sound — the
/// earcon already rang, and two sounds is a bug. Degrades silently without the grant; the engine's
/// `automation.notifications` problem says so once. `.active`: time-sensitive needs an entitlement this
/// bundle does not carry. Bundle-only: `UNUserNotificationCenter` aborts a bare binary (the harness).
@MainActor
final class Notifications: NSObject, UNUserNotificationCenterDelegate {
    enum Words {
        static let category = "jarhead.automation"
        static let categoryWithOpen = "jarhead.automation.open"
        static let snooze = "snooze"
        static let done = "done"
        static let open = "open"
        static func snoozeTitle(_ minutes: Int) -> String { "Snooze \(minutes)" }
    }

    /// What a press does: the same closures the island's presses reach.
    var onSnooze: (String, Int) -> Void = { _, _ in }
    var onDone: (String) -> Void = { _ in }
    var onOpen: (String, String) -> Void = { _, _ in }
    /// A tap on the banner's body: the Console.
    var onTap: (String) -> Void = { _ in }

    private var snoozeMinutes = AutomationSettings.standard.snoozeMinutes
    private var installed = false
    private var available: Bool { PermissionsKit.runsAsBundle }

    /// The delegate and the category, once, at launch (the action titles carry the snooze minutes; a change re-registers).
    func install(snoozeMinutes: Int) {
        guard available else { return }
        self.snoozeMinutes = snoozeMinutes
        let centre = UNUserNotificationCenter.current()
        if !installed {
            centre.delegate = self
            installed = true
        }
        centre.setNotificationCategories(Self.categories(snoozeMinutes: snoozeMinutes))
    }

    /// Settings › Automations › Snooze moved: the buttons say the new minutes.
    func setSnoozeMinutes(_ minutes: Int) {
        guard minutes != snoozeMinutes else { return }
        install(snoozeMinutes: minutes)
    }

    static func categories(snoozeMinutes: Int) -> Set<UNNotificationCategory> {
        let snooze = UNNotificationAction(identifier: Words.snooze, title: Words.snoozeTitle(snoozeMinutes), options: [])
        let done = UNNotificationAction(identifier: Words.done, title: "Done", options: [])
        let open = UNNotificationAction(identifier: Words.open, title: "Open", options: [.foreground])
        return [UNNotificationCategory(identifier: Words.category, actions: [snooze, done], intentIdentifiers: [], options: []),
                UNNotificationCategory(identifier: Words.categoryWithOpen, actions: [open, done], intentIdentifiers: [], options: [])]
    }

    /// A `notify` frame: title = the row's name, body = the line (a wake-brain answer's redacted line). Nothing
    /// without the grant — no prompt from here; the Permissions sweep asks.
    func post(_ n: NotifyMessage) {
        guard available, installed else { return }
        let openTarget = n.presses.first { $0.kind == "open" }?.target
        let snooze = n.presses.first { $0.kind == "snooze" }?.minutes ?? snoozeMinutes
        // Built here, on the actor; the settings callback only carries the request across.
        let content = UNMutableNotificationContent()
        content.title = n.title
        if let body = n.body, !body.isEmpty { content.body = body }
        content.categoryIdentifier = openTarget == nil ? Words.category : Words.categoryWithOpen
        content.interruptionLevel = .active
        content.userInfo = ["automationId": n.automationId, "snooze": snooze, "open": openTarget ?? ""]
        let request = UNNotificationRequest(identifier: "automation-\(n.id)", content: content, trigger: nil)
        let centre = UNUserNotificationCenter.current()
        centre.getNotificationSettings { settings in
            guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else { return }
            centre.add(request) { error in
                if let error { appLog("notifications: add failed — \(error.localizedDescription)") }
            }
        }
    }

    // MARK: - UNUserNotificationCenterDelegate (AppKit calls these off the actor; hop to the main queue)

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        // The banner even while Jarhead is frontmost; never a sound — the earcon rang (design11: `[.banner]`).
        completionHandler([.banner])
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        let id = info["automationId"] as? String ?? ""
        let minutes = info["snooze"] as? Int ?? AutomationSettings.standard.snoozeMinutes
        let target = info["open"] as? String ?? ""
        let action = response.actionIdentifier
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                guard !id.isEmpty else { completionHandler(); return }
                CrashGuard.remember("automation → banner \(action) \(id)")
                switch action {
                case Words.snooze: self.onSnooze(id, minutes)
                case Words.done: self.onDone(id)
                case Words.open: self.onOpen(id, target)
                case UNNotificationDefaultActionIdentifier: self.onTap(id)
                default: break
                }
                completionHandler()
            }
        }
    }
}
