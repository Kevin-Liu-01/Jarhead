import SwiftUI

// The Console's tooltip. Kit step 0: `consoleHelp(_:)` is a thin alias of `.help(_:)` so the
// 173-site sweep lands in one commit and the later change (the bubble, the card, the keycap)
// stays inside this file. The timing statics and the pure delay rule are here already, pinned
// by `check-kit`. This is the only file in UI/Console or UI/Onboarding allowed to say `.help(`.

enum ConsoleTip {
    /// The pointer rests this long before a tip shows.
    static let delay: Double = 0.35
    /// A tip within this long of the last hide shows at once.
    static let warm: Double = 0.40
    /// When the last tip hid (seconds on the same clock the trigger reads); −1 = never.
    @MainActor static var lastHiddenAt: Double = -1
    /// The harness pins the delay (0 in every shot but `tip-warm`); nil in the app.
    @MainActor static var delayOverride: Double?

    /// Pure: warm → 0, else `delay`. `sinceLastHide` < 0 means no tip has hidden yet.
    static func delay(sinceLastHide: Double) -> Double {
        sinceLastHide >= 0 && sinceLastHide < warm ? 0 : delay
    }
}

extension View {
    /// Tier 1: one line on a control. For now the system tooltip; the bubble replaces it in the
    /// next wave without a call site changing. `key` and `id` are accepted today and used then.
    func consoleHelp(_ text: String, key: String? = nil, id: String? = nil) -> some View {
        help(text)
    }
}
