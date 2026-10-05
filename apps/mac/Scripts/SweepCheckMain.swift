import AppKit

// "Ask for everything" ends (APP-7). The REAL Permissions/PermissionsSweep.swift and Model/,
// with the centre's Mac side scripted (`PermissionsIO`: fake reads, a Screen Recording dialog
// that returns at once denied, no helper, no System Settings, no Finder, nothing written to
// UserDefaults) and a short watch (`PermissionsCenter.Watch`).
//
// The finding: a sweep step that waits on Kevin (the Screen Recording dialog, a System
// Settings pane) kept the 1.5 s poll alive for as long as it waited. Setup closed, Kevin gone,
// and every poll re-read sixteen kinds and spawned the helper: 81 spawns in two minutes, for
// ever. Now the poll ends at the watch span and the step parks, still resumable.
// One `check:` line per check, "ok" or "FAIL" first; exit 1 on a FAIL.

nonisolated(unsafe) var failures = 0
func check(_ ok: Bool, _ what: String, _ detail: @autoclosure () -> String = "") {
    if !ok { failures += 1 }
    print("check: \(ok ? "ok" : "FAIL") \(what)\(ok || detail().isEmpty ? "" : " (\(detail()))")")
}

/// The Mac, scripted. Everything granted except what a scenario denies.
@MainActor
final class FakeMac {
    var grants: [PermissionKind: Grant] = Dictionary(uniqueKeysWithValues: PermissionKind.allCases.map { ($0, .granted) })
    private(set) var readAlls = 0
    private(set) var reads = 0
    private(set) var asks: [PermissionKind] = []
    private(set) var panes: [String] = []
    private(set) var reveals = 0
    var asked: Set<PermissionKind> = []

    func info(_ kind: PermissionKind) -> PermissionInfo {
        var i = PermissionsKit.placeholder(kind)
        i.grant = grants[kind] ?? .unknown
        i.checkedAt = Date().timeIntervalSince1970 * 1000
        return i
    }

    var io: PermissionsIO {
        PermissionsIO(
            readAll: { @MainActor in self.readAlls += 1; return PermissionKind.allCases.map(self.info) },
            read: { @MainActor kind in self.reads += 1; return self.info(kind) },
            request: { @MainActor kind in self.asks.append(kind); return (self.grants[kind] ?? .unknown, nil) },
            invalidate: {},
            hasAsked: { kind in MainActor.assumeIsolated { self.asked.contains(kind) } },
            markAsked: { kind in MainActor.assumeIsolated { _ = self.asked.insert(kind) } },
            openSettings: { pane in MainActor.assumeIsolated { self.panes.append(pane.path) } },
            revealApp: { MainActor.assumeIsolated { self.reveals += 1 } })
    }
}

let watch = PermissionsCenter.Watch(interval: 0.05, span: 0.6)

@MainActor
struct Rig {
    let state: AppState
    let mac: FakeMac
    let center: PermissionsCenter
    var sweep: PermissionSweepProgress? { state.permissionSweep }
    var waiting: Bool { sweep.map { $0.running && ($0.stage == .waiting || $0.stage == .settings) } ?? false }
    var done: Bool { sweep?.stage == .done }
}

@MainActor
func rig(denied: [PermissionKind]) async -> Rig {
    let state = AppState()
    let mac = FakeMac()
    for k in denied { mac.grants[k] = .denied }
    let center = PermissionsCenter(state: state, dryRun: false, io: mac.io, watch: watch)
    center.log = { _ in }
    center.start()
    _ = await until(1) { state.permissionList.contains { $0.checkedAt != nil } }
    return Rig(state: state, mac: mac, center: center)
}

func pump(_ seconds: Double) async { try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) }

@MainActor
func until(_ timeout: Double, _ cond: () -> Bool) async -> Bool {
    let end = Date().addingTimeInterval(timeout)
    while Date() < end {
        if cond() { return true }
        await pump(0.02)
    }
    return cond()
}

/// Start the sweep and let it reach the step that waits; then outlast the watch span.
@MainActor
func parked(denied: [PermissionKind]) async -> (Rig, before: Int, after: Int) {
    let r = await rig(denied: denied)
    r.state.permissionActions.requestAll()
    _ = await until(2) { r.waiting }
    await pump(watch.span + 4 * watch.interval) // the span ends; one poll may still be landing
    let before = r.mac.readAlls
    await pump(20 * watch.interval)
    return (r, before, r.mac.readAlls)
}

@main
struct SweepCheck {
    @MainActor
    static func main() async {
        check(PermissionsCenter.Watch.standard == PermissionsCenter.Watch(interval: 1.5, span: 90),
              "the shipped watch: every 1.5 s for 90 s")

        do {
            print("== parked: the Screen Recording dialog returns at once, denied; nobody presses anything (Setup closed)")
            let (r, before, after) = await parked(denied: [.screenRecording])
            check(r.waiting && r.sweep?.current == .screenRecording, "the sweep waits on Screen Recording",
                  "\(String(describing: r.sweep?.stage)) \(String(describing: r.sweep?.current))")
            check(after == before, "past the span the poll stops: no read in \(20) more intervals",
                  "\(after - before) reads after the span: the parked step polls for ever")
            check(r.waiting, "the step parks, still waiting: nothing is lost")
            check(r.mac.panes.isEmpty, "a first ask opens no pane (the dialog has its own Open System Settings)", "\(r.mac.panes)")
            // Kevin turns it on in System Settings and comes back to Jarhead.
            r.mac.grants[.screenRecording] = .granted
            r.center.appActivated()
            check(await until(2) { r.done }, "back in Jarhead, the parked step re-reads and moves on to the end",
                  "\(String(describing: r.sweep?.stage)) \(r.sweep?.line ?? "")")
            check(r.sweep?.line.hasPrefix("stopped") == false, "the sweep ends as done, not stopped", r.sweep?.line ?? "")
        }

        do {
            print("== next: a parked step, Next (Setup or the status menu)")
            let (r, _, _) = await parked(denied: [.screenRecording])
            r.state.permissionSweepNext()
            check(await until(2) { r.done }, "Next moves a parked step on, to the end", r.sweep?.line ?? "")
        }

        do {
            print("== cancel: a parked step, Cancel (Setup or the status menu)")
            let (r, _, _) = await parked(denied: [.screenRecording])
            r.state.permissionSweepCancel()
            check(await until(2) { r.done }, "Cancel ends a parked sweep", String(describing: r.sweep?.stage))
            check(r.sweep?.line.hasPrefix("stopped · ") == true, "and says it stopped", r.sweep?.line ?? "")
        }

        do {
            print("== settings: Full Disk Access (System Settings only), its pane open, nobody switches it on")
            let (r, before, after) = await parked(denied: [.fullDiskAccess])
            check(r.waiting && r.sweep?.stage == .settings && r.sweep?.current == .fullDiskAccess,
                  "the walk waits on the Full Disk Access pane", "\(String(describing: r.sweep?.stage))")
            check(r.mac.panes.count == 1 && r.mac.reveals == 1, "its pane opened once and Jarhead.app was shown in Finder",
                  "panes=\(r.mac.panes) reveals=\(r.mac.reveals)")
            check(after == before, "past the span the pane's poll stops too", "\(after - before) reads after the span")
            r.state.permissionSweepNext()
            check(await until(2) { r.done }, "Next ends the walk", r.sweep?.line ?? "")
        }

        do {
            print("== live (control): inside the span the poll alone sees the grant land")
            let r = await rig(denied: [.screenRecording])
            r.state.permissionActions.requestAll()
            _ = await until(2) { r.waiting }
            r.mac.grants[.screenRecording] = .granted
            check(await until(watch.span / 2) { r.done }, "the grant lands, the sweep moves on with no press and no activation",
                  r.sweep?.line ?? "")
        }

        print(failures == 0 ? "sweep-check: all ok" : "sweep-check: \(failures) FAIL")
        exit(failures == 0 ? 0 : 1)
    }
}
