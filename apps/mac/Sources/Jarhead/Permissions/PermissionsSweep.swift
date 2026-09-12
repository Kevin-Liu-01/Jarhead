import AppKit
import Foundation

/// The one place the app reads, asks for and reports permissions. Owns `AppState`'s
/// permissions region: the published list, the sweep progress and the actions the
/// views call. Reads are `PermissionsKit` (never a prompt); asks are `PermissionsRequests`
/// (one prompt at a time, awaited); System Settings is opened here and watched.
///
/// Reporting: after every read that changed anything the full list goes out through
/// `onList` (the daemon's `permissions {all}`) and each changed kind through `onOne`
/// (`permission {which,state,detail}`); the AppDelegate wires both to the EngineClient
/// and re-sends the list when a daemon (re)connects. The daemon's `snapshot.permissions.all`
/// then carries it to every surface that reads snapshots (the Console rail, `jarhead
/// status`, the doctor).
///
/// `JARHEAD_PERMISSIONS_DRY_RUN=1` logs every ask and every pane instead of doing it —
/// for the harness (`Scripts/permissions-probe.sh`) and for a reviewer at the keyboard.
@MainActor
final class PermissionsCenter {
    private let state: AppState
    let dryRun: Bool
    /// One line per event; NSLog by default, the harness prints.
    var log: (String) -> Void = { NSLog("Permissions: %@", $0) }
    /// The full list, after a read that changed something.
    var onList: ([PermissionInfo]) -> Void = { _ in }
    /// One kind that changed.
    var onOne: (PermissionKind, Grant, String?) -> Void = { _, _, _ in }

    private(set) var list: [PermissionInfo]
    /// At least one read has landed (the placeholders are gone).
    var hasRead: Bool { list.contains { $0.checkedAt != nil } }
    private var refreshing = false
    private var refreshAgain = false
    private var watchTimer: Timer?
    private var watchUntil: Date = .distantPast
    private var sweepTask: Task<Void, Never>?
    private var sweepCancelled = false
    /// A sweep step that waits on the user (a prompt whose dialog returns at once, a
    /// System Settings pane) parks here; Next, the grant landing, or Cancel resume it.
    private var walkContinuation: CheckedContinuation<Bool, Never>?
    private var summaryClear: Task<Void, Never>?

    static let watchInterval: TimeInterval = 1.5
    static let watchSpan: TimeInterval = 90

    init(state: AppState, dryRun: Bool? = nil) {
        self.state = state
        self.dryRun = dryRun ?? (ProcessInfo.processInfo.environment["JARHEAD_PERMISSIONS_DRY_RUN"] == "1")
        self.list = PermissionsKit.placeholders
        state.permissionList = list
        install()
    }

    /// Wire the views' actions to this centre.
    private func install() {
        var a = PermissionActions()
        a.requestAll = { [weak self] in self?.requestAll() }
        a.request = { [weak self] kind in self?.requestOne(kind) }
        a.openSettings = { [weak self] kind in self?.openSettings(for: kind, reveal: kind == .fullDiskAccess) }
        a.refresh = { [weak self] in self?.refresh() }
        a.sweepNext = { [weak self] in self?.sweepNext() }
        a.sweepCancel = { [weak self] in self?.sweepCancel() }
        state.permissionActions = a
    }

    /// The first read. Call once the app is up.
    func start() {
        if dryRun { log("dry run: nothing will be asked, every ask is logged") }
        refresh()
    }

    /// Returning from System Settings (or from a dialog's Open System Settings): read
    /// again, fresh, and let a waiting sweep step move on if its grant landed.
    func appActivated() {
        PermissionsKit.invalidate()
        Task { @MainActor [weak self] in
            guard let self else { return }
            await self.refreshNow()
            self.advanceIfLanded()
        }
    }

    // MARK: - reading

    /// Re-read everything (read-only). Overlapping calls fold into one more read.
    func refresh() {
        Task { @MainActor [weak self] in await self?.refreshNow() }
    }

    /// Read every kind and publish what changed. Returns the kinds that changed. A call
    /// that lands while a read is in flight asks for one more pass and waits for it, so a
    /// sweep that starts right after launch sees the real list, not the placeholders.
    @discardableResult
    func refreshNow() async -> [PermissionKind] {
        if refreshing {
            refreshAgain = true
            while refreshing { try? await Task.sleep(nanoseconds: 50_000_000) }
            return []
        }
        refreshing = true
        defer { refreshing = false }
        var changed: [PermissionKind] = []
        repeat {
            refreshAgain = false
            let fresh = await PermissionsKit.readAll()
            changed.append(contentsOf: apply(fresh))
        } while refreshAgain
        return changed
    }

    /// One kind, read now and applied.
    @discardableResult
    private func refreshOne(_ kind: PermissionKind) async -> PermissionInfo {
        let info = await PermissionsKit.read(kind)
        apply(replacing: info)
        return info
    }

    /// A grant learned elsewhere (the launch's microphone ask): apply it and report.
    func set(_ kind: PermissionKind, grant: Grant, detail: String? = nil) {
        guard var info = list.first(where: { $0.kind == kind }) else { return }
        info.grant = grant
        if let detail { info.detail = detail }
        info.checkedAt = Date().timeIntervalSince1970 * 1000
        apply(replacing: info)
    }

    func info(_ kind: PermissionKind) -> PermissionInfo? { list.first { $0.kind == kind } }

    /// Merge a read into the list — per kind the newer `checkedAt` wins, so a slow
    /// `readAll` (a helper spawn, a dozen Apple events) that began before a prompt's
    /// answer landed cannot flip the fresh grant back for a poll — then publish and
    /// report only what changed (grant or detail).
    @discardableResult
    private func apply(_ fresh: [PermissionInfo]) -> [PermissionKind] {
        var next = list
        var changed: [PermissionKind] = []
        for info in fresh {
            guard let i = next.firstIndex(where: { $0.kind == info.kind }) else {
                next.append(info)
                changed.append(info.kind)
                continue
            }
            let old = next[i]
            if let a = old.checkedAt, let b = info.checkedAt, a > b { continue } // an older read: keep what we have
            next[i] = info
            if old.grant != info.grant || old.detail != info.detail { changed.append(info.kind) }
        }
        list = next
        state.permissionList = next
        guard !changed.isEmpty else { return [] }
        for kind in changed {
            if let info = next.first(where: { $0.kind == kind }) {
                log("\(info.label): \(info.grant.rawValue)\(info.detail.map { " · " + $0 } ?? "")")
                onOne(kind, info.grant, info.detail)
            }
        }
        onList(next)
        return changed
    }

    private func apply(replacing info: PermissionInfo) {
        apply([info])
    }

    // MARK: - watching System Settings

    /// Poll every 1.5 s for 90 s (and on activation, which the AppDelegate forwards). A
    /// sweep step that waits on the user keeps the watch alive past the 90 s.
    private func startWatch() {
        watchUntil = Date().addingTimeInterval(PermissionsCenter.watchSpan)
        guard watchTimer == nil else { return }
        let owner = self
        watchTimer = Timer.scheduledTimer(withTimeInterval: PermissionsCenter.watchInterval, repeats: true) { _ in
            DispatchQueue.main.async { MainActor.assumeIsolated { owner.watchTick() } }
        }
    }

    private func watchTick() {
        if Date() > watchUntil, walkContinuation == nil {
            stopWatch()
            return
        }
        PermissionsKit.invalidate()
        Task { @MainActor [weak self] in
            guard let self else { return }
            await self.refreshNow()
            self.advanceIfLanded()
        }
    }

    private func stopWatch() {
        watchTimer?.invalidate()
        watchTimer = nil
    }

    /// The waiting step's kinds are all granted: the sweep moves on by itself.
    private func advanceIfLanded() {
        guard walkContinuation != nil, let cur = state.permissionSweep, cur.stage == .settings || cur.stage == .waiting else { return }
        let kinds = cur.group.isEmpty ? (cur.current.map { [$0] } ?? []) : cur.group
        guard !kinds.isEmpty, kinds.allSatisfy({ info($0)?.grant == .granted }) else { return }
        resumeWalk(advance: true)
    }

    // MARK: - one kind

    /// Kinds whose prompt API returns at once while tccd shows the dialog (nothing to
    /// await), whose readers never say "not asked" (denied until granted), and whose prompt
    /// is what creates the row in System Settings. They are asked with `promptAndWait`:
    /// fire the prompt, then wait for the grant like the settings walk does. The dialog
    /// shows once per app; it offers Open System Settings itself, so the pane is opened
    /// here only when the dialog was already shown on an earlier ask.
    static let promptBeforePane: Set<PermissionKind> = [.accessibility, .screenRecording, .inputMonitoring]

    /// A row's Request / Open Settings: the prompt when the kind has one and was never
    /// asked; the pane (and, for Full Disk Access, the app revealed in Finder) otherwise.
    func requestOne(_ kind: PermissionKind) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            let before = self.info(kind) ?? PermissionsKit.placeholder(kind)
            if before.grant == .granted { return }
            if PermissionsCenter.promptBeforePane.contains(kind) {
                // First press: the dialog (it has its own Open System Settings) and the
                // watch. A later press: the dialog will not come back, so the pane —
                // after the prompt API, which recreates a row a `tccutil reset` removed.
                let askedBefore = PermissionsKit.hasAsked(kind)
                let after = await self.ask(kind)
                guard after.grant != .granted else { return }
                if askedBefore { self.openSettings(for: kind, reveal: false) } else { self.startWatch() }
                return
            }
            let asks = before.ask != .settings && (before.grant == .unknown || kind == .automation)
            var after = before
            if asks {
                after = await self.ask(kind)
            }
            if PermissionsKit.settingsCanHelp(after) {
                self.openSettings(for: kind, reveal: kind == .fullDiskAccess)
            }
        }
    }

    /// Fire the prompt (or log it under dry run), then re-read the kind.
    private func ask(_ kind: PermissionKind) async -> PermissionInfo {
        let label = PermissionsKit.meta(kind).label
        if dryRun {
            log("dry run: would ask for \(label) via \(PermissionsRequests.describe(kind))")
            try? await Task.sleep(nanoseconds: 120_000_000)
            return await refreshOne(kind)
        }
        log("asking for \(label) via \(PermissionsRequests.describe(kind))")
        let (grant, detail) = await PermissionsRequests.request(kind)
        if PermissionsCenter.promptBeforePane.contains(kind) { PermissionsKit.markAsked(kind) }
        PermissionsKit.invalidate()
        var info = await refreshOne(kind)
        // The request's own answer wins when the re-read is behind it (Screen Recording's
        // in-process read is stale until the helper's fresh one lands).
        if grant == .granted, info.grant != .granted {
            info.grant = grant
            if let detail { info.detail = detail }
            apply(replacing: info)
        }
        return info
    }

    /// Deep-link to the kind's pane; for Full Disk Access also select the app in Finder
    /// so it can be dragged into the list. Then watch for the change.
    func openSettings(for kind: PermissionKind, reveal: Bool) {
        let pane = PermissionsKit.pane(for: kind)
        if dryRun {
            log("dry run: would open System Settings › \(pane.path) (\(pane.url.absoluteString))")
            if reveal { log("dry run: would reveal \(PermissionsKit.appBundleURL.path) in Finder") }
        } else {
            log("opening System Settings › \(pane.path)")
            if reveal { PermissionsKit.revealAppInFinder() }
            PermissionsKit.openSettings(pane: pane)
        }
        startWatch()
    }

    // MARK: - the sweep

    /// Ask for everything: required kinds first, then the rest; skip what is granted;
    /// await each prompt before the next; when only settings-only kinds remain, walk
    /// them one pane at a time with Next; end with a summary.
    func requestAll() {
        guard sweepTask == nil else { return }
        sweepCancelled = false
        summaryClear?.cancel()
        let owner = self
        sweepTask = Task { @MainActor in
            await owner.runSweep()
            owner.sweepTask = nil
        }
    }

    func sweepCancel() {
        guard sweepTask != nil else { return }
        sweepCancelled = true
        resumeWalk(advance: false)
    }

    /// The waiting step's Next: skip it, on to the following one.
    func sweepNext() {
        resumeWalk(advance: true)
    }

    private func resumeWalk(advance: Bool) {
        guard let cont = walkContinuation else { return }
        walkContinuation = nil
        cont.resume(returning: advance)
    }

    private func publish(_ p: PermissionSweepProgress?) {
        state.permissionSweep = p
    }

    private func runSweep() async {
        log(dryRun ? "sweep (dry run): starting" : "sweep: starting")
        await refreshNow()
        let order = PermissionsKit.sweepOrder
        let total = order.count
        var settingsQueue: [PermissionKind] = []
        var progress = PermissionSweepProgress(stage: .asking, total: total, index: 0, current: nil, line: "reading…", dryRun: dryRun)
        publish(progress)

        for (i, kind) in order.enumerated() {
            if sweepCancelled { break }
            let info = self.info(kind) ?? PermissionsKit.placeholder(kind)
            let label = info.label
            progress.stage = .asking
            progress.index = i + 1
            progress.current = kind
            progress.group = []
            progress.remaining = []
            if info.grant == .granted {
                log("sweep: \(i + 1) of \(total) · \(label) already granted")
                continue
            }
            if info.ask == .settings {
                progress.line = "\(i + 1) of \(total) · \(label) needs System Settings"
                publish(progress)
                log("sweep: " + progress.line)
                settingsQueue.append(kind)
                try? await Task.sleep(nanoseconds: 150_000_000)
                continue
            }
            if PermissionsCenter.promptBeforePane.contains(kind) {
                // The dialog cannot be awaited: fire it, then wait for the grant, Next or
                // Cancel — never the next dialog on top of this one.
                let advance = await promptAndWait(kind, total: total, progress: &progress)
                if !advance { break }
                continue
            }
            if info.grant == .denied, kind != .automation {
                // Denied means the prompt was shown once already; only the pane helps now.
                progress.line = "\(i + 1) of \(total) · \(label) was denied · System Settings"
                publish(progress)
                log("sweep: " + progress.line)
                settingsQueue.append(kind)
                try? await Task.sleep(nanoseconds: 150_000_000)
                continue
            }
            progress.line = "\(i + 1) of \(total) · asking for \(label)…"
            publish(progress)
            log("sweep: " + progress.line)
            let after = await ask(kind)
            if after.grant != .granted, PermissionsKit.settingsCanHelp(after) {
                settingsQueue.append(kind)
            }
        }

        if !sweepCancelled, !settingsQueue.isEmpty {
            await walkSettings(settingsQueue, total: total, progress: &progress)
        }

        // The watch keeps running after a sweep (Kevin may still be in System Settings); it stops itself at `watchUntil`.
        await refreshNow()
        let summary = PermissionsKit.summary(list)
        progress.stage = .done
        progress.current = nil
        progress.remaining = []
        progress.group = []
        progress.summary = summary
        progress.line = sweepCancelled ? "stopped · " + summary : summary
        publish(progress)
        log("sweep: done · " + summary)
        state.toast(progress.line, tone: state.permissionsMissingRequired.isEmpty ? .info : .warn)
        // The summary stays a while, then the surfaces go back to the list alone.
        let owner = self
        summaryClear = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 12_000_000_000)
            if !Task.isCancelled, owner.state.permissionSweep?.stage == .done { owner.publish(nil) }
        }
    }

    /// Screen Recording, Accessibility, Input Monitoring: the prompt API returns at once
    /// while tccd shows the dialog, and the dialog's answer is nothing we can read but the
    /// grant itself. So: fire the prompt (it creates the System Settings row and shows the
    /// dialog, once), then wait as the settings walk does — for the grant to land (the
    /// 1.5 s watch; the app becoming active again on the way back from System Settings),
    /// for Next (skip), or for Cancel. Asked before (the dialog will not come back): the
    /// pane is opened right away as well. Returns false only on Cancel.
    private func promptAndWait(_ kind: PermissionKind, total: Int, progress: inout PermissionSweepProgress) async -> Bool {
        let m = PermissionsKit.meta(kind)
        let askedBefore = PermissionsKit.hasAsked(kind)
        progress.stage = .waiting
        progress.current = kind
        progress.group = [kind]
        progress.remaining = [kind]
        progress.line = "\(progress.index) of \(total) · \(m.label) · allow it, or switch Jarhead on in \(m.pane.path)"
        publish(progress)
        log("sweep: " + progress.line)
        let after = await ask(kind)
        if after.grant == .granted { return true }
        if sweepCancelled { return false }
        if askedBefore { openSettings(for: kind, reveal: false) } else { startWatch() }
        if dryRun {
            log("dry run: would wait for \(m.label) to land (the dialog, or System Settings) · Next skips")
            try? await Task.sleep(nanoseconds: 150_000_000)
            return true
        }
        return await withCheckedContinuation { cont in walkContinuation = cont }
    }

    /// One pane at a time — the kinds that share a pane (the three folders under Files
    /// and Folders) in one step: open it (Full Disk Access also reveals the app), watch,
    /// and wait for Next, for every kind of the step to land, or for Cancel. Under dry run
    /// the panes are logged and the walk advances on its own.
    private func walkSettings(_ queue: [PermissionKind], total: Int, progress: inout PermissionSweepProgress) async {
        var remaining = queue
        progress.stage = .settings
        while !sweepCancelled {
            remaining.removeAll { info($0)?.grant == .granted }
            guard let kind = remaining.first else { break }
            let pane = PermissionsKit.pane(for: kind)
            let group = remaining.filter { PermissionsKit.pane(for: $0) == pane }
            let labels = group.map { PermissionsKit.meta($0).label }
            progress.current = kind
            progress.group = group
            progress.remaining = group + remaining.filter { !group.contains($0) }
            progress.index = (PermissionsKit.sweepOrder.firstIndex(of: kind) ?? 0) + 1
            progress.line = group.count == 1
                ? "\(progress.index) of \(total) · \(labels[0]) · switch Jarhead on in \(pane.path)"
                : "\(progress.index) of \(total) · \(labels.joined(separator: ", ")) · switch Jarhead on for each in \(pane.path)"
            publish(progress)
            log("sweep: " + progress.line)
            openSettings(for: kind, reveal: kind == .fullDiskAccess)
            if dryRun {
                try? await Task.sleep(nanoseconds: 150_000_000)
                remaining.removeAll { group.contains($0) }
                continue
            }
            let advance: Bool = await withCheckedContinuation { cont in walkContinuation = cont }
            if !advance { break }
            remaining.removeAll { group.contains($0) }
        }
        progress.remaining = []
        progress.group = []
    }
}
