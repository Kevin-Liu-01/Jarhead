import SwiftUI
import Combine

/// Window-local UI state for the Console: which tab is open, which agent row is
/// expanded, the ledger day being viewed, the lightbox. Lives as long as the
/// controller. Changes here are rare, so views may observe the whole object.
@MainActor
final class ConsoleSession: ObservableObject {
    enum Tab: String, CaseIterable, Identifiable {
        case now = "Now", settings = "Settings", ledger = "Ledger"
        var id: String { rawValue }
    }

    @Published var tab: Tab = .now
    @Published var openAgentId: String?

    /// nil until the first load; then newest first.
    @Published var ledgerDays: [String]?
    @Published var ledgerLoading = false
    @Published var ledgerError: String?
    @Published var ledgerDay: String?
    @Published var ledgerEntries: [StreamEntry] = []
    @Published var ledgerStats: LedgerStats?

    @Published var lightbox: ConsoleLightboxItem?

    /// Bumped by the window controller to focus the composer (⌘K).
    @Published var composerFocusRequest = 0

    var isLedgerMode: Bool { ledgerDay != nil }

    func select(_ tab: Tab) {
        self.tab = tab
        if tab != .ledger, isLedgerMode { showLive() }
    }

    func showLive() {
        ledgerDay = nil
        ledgerEntries = []
        ledgerStats = nil
        // An abandoned read must not leave the flag stuck for the next pick.
        ledgerLoading = false
        if tab == .ledger { tab = .now }
    }

    func loadDays(from state: AppState, force: Bool = false) async {
        if ledgerDays != nil && !force { return }
        ledgerLoading = true
        ledgerError = nil
        let days = await state.ledgerDays()
        ledgerDays = days
        ledgerLoading = false
    }

    func pick(day: String, from state: AppState) async {
        ledgerDay = day
        // Clear the previous day before the read so the feed shows its loading
        // state instead of the old rows under the new banner.
        ledgerEntries = []
        ledgerStats = nil
        ledgerLoading = true
        let rows = await state.ledgerRows(day: day)
        // The user may have moved on while we were reading: either showLive()
        // already reset the flag, or a newer pick owns it now.
        guard ledgerDay == day else { return }
        ledgerEntries = StreamBuilder.fromLedger(rows)
        ledgerStats = StreamBuilder.stats(rows)
        ledgerLoading = false
    }
}

struct ConsoleLightboxItem: Identifiable, Equatable {
    let url: URL
    let caption: String
    var id: String { url.path }
}

/// Side-effect hooks handed down through the environment so leaf views stay
/// pure value types (and therefore cheap to diff) without observing AppState.
struct ConsoleActions {
    var send: (EngineCommand) -> Void = { _ in }
    var screenshotURL: (String) -> URL = { URL(fileURLWithPath: $0) }
    var loadLedgerDays: () -> Void = {}
    var pickLedgerDay: (String) -> Void = { _ in }
    /// Settings › "Set up again…": the first-run wizard.
    var openOnboarding: () -> Void = {}
    /// The wake gate's passphrase (AppState.wakeActions, read at call time so the
    /// gate may install them after the window exists). Set returns false when too short.
    var setWakePassphrase: (String) -> Bool = { _ in false }
    var clearWakePassphrase: () -> Void = {}
    /// Now › "Circle something…": mark mode on the overlay (AppState.beginMarkMode).
    var beginMarkMode: () -> Void = {}
    /// A conversation's Reveal: the session's folder or file in Finder.
    var reveal: (URL) -> Void = { _ in }
}

private struct ConsoleActionsKey: EnvironmentKey {
    static let defaultValue = ConsoleActions()
}

extension EnvironmentValues {
    var consoleActions: ConsoleActions {
        get { self[ConsoleActionsKey.self] }
        set { self[ConsoleActionsKey.self] = newValue }
    }
}
