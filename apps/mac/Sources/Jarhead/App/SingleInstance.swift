import AppKit
import Darwin

// One Jarhead per state dir. A second launch hands off to the first and exits before any UI,
// audio, hotkey or daemon work — and before `NSApplication.shared`, so it never checks in with
// LaunchServices and never draws a Dock tile of its own.
//
// LaunchServices already keeps `open`, the Dock and Spotlight to one instance of a bundle. What it
// does not see: a binary exec'd directly (a `swift build` binary, Contents/MacOS/Jarhead from a
// shell, the crash relauncher's dev path), a second registered copy of the bundle at another path
// (a build stage, a worktree's build), and two launches racing before either has checked in. Two
// instances are two Dock tiles, two status items, two hotkey owners and two clients of one daemon.
//
// The claim is `<state dir>/jarhead-app.lock`, the daemon's own pattern (jarheadd.lock): an
// exclusive flock taken atomically with the open (O_EXLOCK | O_NONBLOCK), close-on-exec so no child
// (the daemon, the crash relauncher) inherits it, the holder's pid written in. The kernel drops it
// when the holder dies, a crash or SIGKILL included, so a stale file never blocks a launch: only a
// live process can hold it. An instance that starts quitting gives the claim up at once
// (`applicationWillTerminate`), so a relaunch inside its teardown waits for it to go instead of
// handing off to a dying app.
//
// Same bundle id and our executable's name (NSRunningApplication) catches what holds no claim: an
// instance that is quitting, or a build from before this guard. jarhead-hands shares the bundle id
// (it lives in Contents/MacOS) and is never a twin. None of the reads here checks the process in.
enum SingleInstance {
    /// A process LaunchServices files under our bundle id.
    struct Twin: Equatable {
        let pid: pid_t
        /// The executable's file name (`Jarhead`, or `jarhead-hands` for the helper); nil when LaunchServices does not say.
        let executable: String?
        let terminated: Bool
    }

    /// The state dir's claim, as `takeClaim(stateDir:)` found it.
    enum Claim: Equatable {
        /// Ours now — or no lock could be had for a reason other than a holder (a folder we may not
        /// write): never a reason not to launch.
        case ours
        /// Another live process holds it; its pid when the file says.
        case heldBy(pid_t?)
    }

    enum Decision: Equatable {
        /// This is the one Jarhead: launch.
        case proceed
        /// Another instance is the one: tell it to come forward, then exit.
        case handOff(pid_t?)
        /// Instances that hold no claim (quitting, or from before the guard): wait for them, then decide again.
        case waitFor([pid_t])
    }

    static let lockName = "jarhead-app.lock"
    /// How long a launch waits for an unclaimed twin to finish quitting (its teardown caps the daemon's stop at 5 s).
    static let waitSeconds: TimeInterval = 8
    /// Posted by a launch that hands off, with the state dir's path as the object; the one instance answers like a Dock click.
    static let handOffNotification = Notification.Name("com.kevinliu.jarhead.handoff")

    /// The rule, pure. `waited`: the unclaimed twins have been waited for once already.
    static func decide(me: pid_t, executable: String?, claim: Claim, twins: [Twin], waited: Bool) -> Decision {
        let live = twins.filter { $0.pid > 0 && $0.pid != me && !$0.terminated && executable != nil && $0.executable == executable }
        switch claim {
        case .heldBy(let holder):
            return .handOff(holder ?? live.first?.pid)
        case .ours:
            if live.isEmpty { return .proceed }
            // Still there after the wait: an older build that never took the claim, or one stuck
            // quitting. One Jarhead wins over a second.
            return waited ? .handOff(live.first?.pid) : .waitFor(live.map(\.pid))
        }
    }

    // MARK: - the launch

    /// The descriptor that holds the claim, for the life of the process (or until `giveUpClaim`).
    nonisolated(unsafe) private static var claimFd: Int32 = -1

    /// The top of main.swift: return when this launch is the one Jarhead; otherwise post the
    /// hand-off, log one line and exit.
    static func ensureOne(stateDir: URL) {
        let me = getpid()
        let executable = Bundle.main.executableURL?.lastPathComponent
        let claim = takeClaim(stateDir: stateDir)
        var waited = false
        while true {
            switch decide(me: me, executable: executable, claim: claim, twins: twins(bundleId: Bundle.main.bundleIdentifier), waited: waited) {
            case .proceed:
                return
            case .waitFor(let pids):
                appLog("one Jarhead: pid \(pids.map(String.init).joined(separator: ", ")) holds no claim; waiting up to \(Int(waitSeconds)) s for it to quit")
                waitForExit(pids, seconds: waitSeconds)
                waited = true
            case .handOff(let pid):
                appLog("one Jarhead: \(pid.map { "pid \($0)" } ?? "another instance") already runs for \(stateDir.path); handing off and exiting (pid \(me))")
                DistributedNotificationCenter.default().postNotificationName(handOffNotification, object: stateDir.standardizedFileURL.path, userInfo: nil, deliverImmediately: true)
                exit(0)
            }
        }
    }

    /// The one instance's half: a launch that handed off asks it to come forward.
    static func observeHandOffs(stateDir: URL, _ handler: @escaping @MainActor () -> Void) {
        DistributedNotificationCenter.default().addObserver(forName: handOffNotification, object: stateDir.standardizedFileURL.path, queue: .main) { _ in
            MainActor.assumeIsolated { handler() }
        }
    }

    /// At the start of `applicationWillTerminate`: a relaunch during the teardown takes the claim
    /// and waits for this process to exit, instead of handing off to it.
    static func giveUpClaim() {
        guard claimFd >= 0 else { return }
        _ = ftruncate(claimFd, 0)
        close(claimFd)
        claimFd = -1
    }

    // MARK: - the reads

    /// Take `<stateDir>/jarhead-app.lock`, or name the live process that has it.
    static func takeClaim(stateDir: URL) -> Claim {
        try? FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true)
        let path = stateDir.appendingPathComponent(lockName).path
        let fd = open(path, O_RDWR | O_CREAT | O_NONBLOCK | O_EXLOCK | O_CLOEXEC, 0o644)
        if fd < 0 {
            let err = errno
            if err == EWOULDBLOCK || err == EAGAIN { return .heldBy(holder(of: path)) }
            return .ours
        }
        _ = ftruncate(fd, 0)
        let line = "\(getpid())\n"
        _ = line.withCString { write(fd, $0, strlen($0)) }
        claimFd = fd
        return .ours
    }

    /// The pid written in a lock file, when there is one.
    static func holder(of path: String) -> pid_t? {
        guard let text = try? String(contentsOfFile: path, encoding: .utf8),
              let pid = Int32(text.trimmingCharacters(in: .whitespacesAndNewlines)), pid > 0 else { return nil }
        return pid
    }

    /// Running processes under our bundle id; none for a `swift build` binary (no bundle id — the claim covers it).
    static func twins(bundleId: String?) -> [Twin] {
        guard let bundleId, !bundleId.isEmpty else { return [] }
        return NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).map {
            Twin(pid: $0.processIdentifier, executable: $0.executableURL?.lastPathComponent, terminated: $0.isTerminated)
        }
    }

    /// Until every pid is gone or `seconds` pass.
    private static func waitForExit(_ pids: [pid_t], seconds: TimeInterval) {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline, pids.contains(where: { kill($0, 0) == 0 || errno == EPERM }) {
            usleep(100_000)
        }
    }
}
