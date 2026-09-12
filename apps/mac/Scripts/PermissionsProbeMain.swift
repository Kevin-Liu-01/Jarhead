import AppKit
import Foundation

// Read-only permissions harness. Not part of the package; compiled only by
// Scripts/permissions-probe.sh. Prints every PermissionInfo as the readers see it —
// for THIS process, which TCC attributes to whatever launched it (Terminal, usually),
// never to Jarhead.app — then runs the sweep under JARHEAD_PERMISSIONS_DRY_RUN=1, which
// logs each ask and each System Settings pane it would open instead of doing it.
// Nothing here prompts, opens System Settings or reveals anything in Finder.
//   PROBE_SWEEP=0   skip the dry-run sweep (readers only)
@main
struct PermissionsProbeMain {
    static func main() {
        // Never a real sweep from here, whatever the shell says.
        setenv("JARHEAD_PERMISSIONS_DRY_RUN", "1", 1)
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited) // no Dock tile, no activation: this only reads
        let delegate = PermissionsProbeDelegate()
        app.delegate = delegate
        app.run()
    }
}

@MainActor
final class PermissionsProbeDelegate: NSObject, NSApplicationDelegate {
    let state = AppState()
    var centre: PermissionsCenter?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let owner = self
        Task { @MainActor in
            await owner.run()
            exit(0)
        }
    }

    private func run() async {
        let bundle = Bundle.main.bundleURL.pathExtension == "app" ? Bundle.main.bundleURL.path : "none (statuses below are this shell's, not Jarhead.app's)"
        print("process \(ProcessInfo.processInfo.processIdentifier) · bundle: \(bundle)")
        print("")
        print("readers (read-only, no prompt):")
        let list = await PermissionsKit.readAll()
        let width = list.map(\.label.count).max() ?? 12
        for info in list {
            let label = info.label.padding(toLength: width, withPad: " ", startingAt: 0)
            let req = info.required ? "required" : "        "
            let ask = info.ask.rawValue.padding(toLength: 8, withPad: " ", startingAt: 0)
            let detail = info.detail.map { " · " + $0 } ?? ""
            print("  \(label)  \(info.grant.rawValue.padding(toLength: 7, withPad: " ", startingAt: 0))  \(req)  \(ask)\(detail)")
        }
        print("")
        print("summary: " + PermissionsKit.summary(list))
        print("sweep order: " + PermissionsKit.sweepOrder.map(\.rawValue).joined(separator: ", "))

        guard ProcessInfo.processInfo.environment["PROBE_SWEEP"] != "0" else { return }
        print("")
        print("dry-run sweep (JARHEAD_PERMISSIONS_DRY_RUN=1):")
        let centre = PermissionsCenter(state: state, dryRun: true)
        centre.log = { print("  " + $0) }
        centre.onOne = { kind, grant, detail in print("  → permission {which: \(kind.rawValue), state: \(grant.rawValue)\(detail.map { ", detail: \"\($0)\"" } ?? "")}") }
        centre.onList = { all in print("  → permissions {all: \(all.count) rows}") }
        self.centre = centre
        centre.start()
        centre.requestAll()
        // The dry run paces itself at ~150 ms a step; wait for the summary.
        for _ in 0..<200 {
            try? await Task.sleep(nanoseconds: 100_000_000)
            if state.permissionSweep?.stage == .done { break }
        }
        print("")
        print("progress at end: " + (state.permissionSweep?.line ?? "none"))
    }
}
