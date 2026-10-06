import AppKit
import Darwin

// One Jarhead per state dir (App/SingleInstance.swift), checked headless: the decision table, the
// claim's flock against a real temp state dir (a SIGKILLed holder never blocks a launch, no child
// inherits the claim, a folder that cannot hold a lock never stops one), the reads checking nothing
// in with LaunchServices, and `ensureOne` end to end in child processes of this binary: a launch
// with the claim free proceeds; a launch with the claim held logs one line, posts the hand-off the
// holder hears, and exits 0 without proceeding.
//
// No NSApplication, no window, no Dock tile, nothing of Jarhead's launched. Run by
// Scripts/single-instance-check.sh. One `check:` line per check, "ok" or "FAIL" first; exit 1 on a FAIL.

nonisolated(unsafe) var failures = 0
/// Hand-offs the one instance heard.
nonisolated(unsafe) var heard = 0
func check(_ ok: Bool, _ what: String) {
    if !ok { failures += 1 }
    print("check: \(ok ? "ok" : "FAIL") \(what)")
}

/// SingleInstance logs through the app's appLog (CrashGuard.swift); here it prints.
func appLog(_ line: String) {
    print("log: \(line)")
}

/// This binary again, with `args`; stdout captured.
func child(_ args: [String]) -> (process: Process, out: Pipe) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
    p.arguments = args
    let out = Pipe()
    p.standardOutput = out
    try? p.run()
    return (p, out)
}

func text(_ pipe: Pipe) -> String {
    String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
}

/// What LaunchServices calls this process: nil when it never checked in.
func launchServicesType(_ pid: pid_t) -> String? {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/lsappinfo")
    p.arguments = ["info", String(pid)]
    let out = Pipe()
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    guard (try? p.run()) != nil else { return "lsappinfo unavailable" }
    p.waitUntilExit()
    let line = text(out).split(separator: "\n").first { $0.contains("type=") }
    guard let line, let r = line.range(of: #"type="([^"]*)""#, options: .regularExpression) else { return nil }
    return String(line[r]).replacingOccurrences(of: "type=", with: "").replacingOccurrences(of: "\"", with: "")
}

@main
struct SingleInstanceCheck {
    static func main() {
        let args = CommandLine.arguments
        // Child roles.
        if args.count >= 3, args[1] == "--hold" {
            // Take the claim, say so, and wait to be killed.
            let claim = SingleInstance.takeClaim(stateDir: URL(fileURLWithPath: args[2]))
            print(claim == .ours ? "held" : "not held")
            fflush(stdout)
            sleep(30)
            exit(0)
        }
        if args.count >= 2, args[1] == "--sleep" {
            sleep(30)
            exit(0)
        }
        if args.count >= 3, args[1] == "--ensure" {
            // What main.swift does first; "proceeded" only when this launch is the one.
            SingleInstance.ensureOne(stateDir: URL(fileURLWithPath: args[2]))
            print("proceeded")
            exit(0)
        }

        print("== the rule")
        let me: pid_t = 500
        let app = "Jarhead"
        func twin(_ pid: pid_t, _ exe: String? = "Jarhead", terminated: Bool = false) -> SingleInstance.Twin {
            .init(pid: pid, executable: exe, terminated: terminated)
        }
        func decide(_ claim: SingleInstance.Claim, _ twins: [SingleInstance.Twin], waited: Bool = false, exe: String? = app) -> SingleInstance.Decision {
            SingleInstance.decide(me: me, executable: exe, claim: claim, twins: twins, waited: waited)
        }
        check(decide(.ours, []) == .proceed, "the claim and nobody else: proceed")
        check(decide(.ours, [twin(me)]) == .proceed, "only us under the bundle id: proceed")
        check(decide(.ours, [twin(me), twin(77, terminated: true)]) == .proceed, "a terminated twin: proceed")
        check(decide(.ours, [twin(me), twin(66, "jarhead-hands")]) == .proceed, "the hands helper under the same bundle id is never a twin: proceed")
        check(decide(.ours, [twin(0), twin(-1)]) == .proceed, "no pid is no twin: proceed")
        check(decide(.ours, [twin(77, nil)]) == .proceed, "a process LaunchServices names no executable for is not proven a twin: proceed")
        check(decide(.ours, [twin(77)], exe: nil) == .proceed, "we cannot name our own executable: the claim alone decides, proceed")
        check(decide(.ours, [twin(me), twin(77)]) == .waitFor([77]), "a live twin with no claim (quitting, or a build from before the guard): wait for it")
        check(decide(.ours, [twin(77), twin(78)]) == .waitFor([77, 78]), "every unclaimed twin is waited for")
        check(decide(.ours, [twin(77)], waited: true) == .handOff(77), "still there after the wait: hand off to it")
        check(decide(.heldBy(4242), []) == .handOff(4242), "another pid holds the claim: hand off to it and exit")
        check(decide(.heldBy(4242), [twin(77)]) == .handOff(4242), "the claim's holder wins over a twin")
        check(decide(.heldBy(nil), [twin(77)]) == .handOff(77), "a held claim with no pid written: hand off to the twin")
        check(decide(.heldBy(nil), []) == .handOff(nil), "a held claim, nobody named: still exit (the holder is alive, the kernel says so)")

        print("== the claim")
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("jarhead-single-instance-\(getpid())", isDirectory: true)
        try? FileManager.default.removeItem(at: root)
        let state = root.appendingPathComponent("state", isDirectory: true)
        let lock = state.appendingPathComponent(SingleInstance.lockName).path
        defer { try? FileManager.default.removeItem(at: root) }

        check(SingleInstance.takeClaim(stateDir: state) == .ours, "a fresh state dir: the claim is ours")
        check(SingleInstance.holder(of: lock) == getpid(), "the lock file carries our pid")
        check(SingleInstance.takeClaim(stateDir: state) == .heldBy(getpid()), "a second open of the claim fails while it is held, naming the holder")
        SingleInstance.giveUpClaim()
        check(SingleInstance.holder(of: lock) == nil, "given up: the pid is blanked")
        check(SingleInstance.takeClaim(stateDir: state) == .ours, "given up: the next launch takes it")

        // No child inherits the claim (close-on-exec): a daemon that outlives the app must not hold it.
        // A bare posix_spawn, which (unlike Process) passes every descriptor not marked close-on-exec.
        var sleeper: pid_t = 0
        let argv: [UnsafeMutablePointer<CChar>?] = [strdup(CommandLine.arguments[0]), strdup("--sleep"), nil]
        let spawned = posix_spawn(&sleeper, CommandLine.arguments[0], nil, nil, argv, environ)
        SingleInstance.giveUpClaim()
        check(spawned == 0 && SingleInstance.takeClaim(stateDir: state) == .ours, "a child spawned while we held the claim does not keep it after we give it up")
        kill(sleeper, SIGKILL)
        var status: Int32 = 0
        waitpid(sleeper, &status, 0)
        SingleInstance.giveUpClaim()

        // A holder that dies without a word (a crash, SIGKILL) never blocks the next launch.
        let holder = child(["--hold", state.path])
        let said = holder.out.fileHandleForReading.availableData
        check(String(data: said, encoding: .utf8)?.hasPrefix("held") == true, "a child process takes the claim")
        check(SingleInstance.takeClaim(stateDir: state) == .heldBy(holder.process.processIdentifier), "while it lives, a launch sees the claim held by its pid")
        kill(holder.process.processIdentifier, SIGKILL)
        holder.process.waitUntilExit()
        check(SingleInstance.holder(of: lock) == holder.process.processIdentifier, "after SIGKILL the file still names the dead holder (a stale file)")
        check(SingleInstance.takeClaim(stateDir: state) == .ours, "…and the stale file blocks nothing: the claim is ours")
        check(SingleInstance.holder(of: lock) == getpid(), "…and it names us now")

        let nowhere = URL(fileURLWithPath: "/System/jarhead-single-instance-check-cannot-exist", isDirectory: true)
        check(SingleInstance.takeClaim(stateDir: nowhere) == .ours, "a state dir that cannot hold a lock never stops a launch")

        print("== the reads")
        check(SingleInstance.twins(bundleId: nil).isEmpty, "no bundle id (a swift build binary): no twins, the claim decides")
        check(SingleInstance.twins(bundleId: "com.kevinliu.jarhead.single-instance-check.nobody").isEmpty, "an id nothing runs under: no twins")
        let finder = SingleInstance.twins(bundleId: "com.apple.finder")
        check(finder.contains { $0.executable == "Finder" && !$0.terminated }, "a running app is read with its executable's name (Finder)")
        let type = launchServicesType(getpid())
        check(type == nil || type == "lsappinfo unavailable", "the reads did not check this process in with LaunchServices (lsappinfo type: \(type ?? "none"))")

        print("== ensureOne, end to end")
        // The claim is ours (above): a second launch for this state dir hands off and exits 0.
        SingleInstance.observeHandOffs(stateDir: state) { heard += 1 }
        let second = child(["--ensure", state.path])
        second.process.waitUntilExit()
        let secondOut = text(second.out)
        check(second.process.terminationStatus == 0 && !secondOut.contains("proceeded"), "a second launch while the claim is held exits 0 without proceeding")
        check(secondOut.split(separator: "\n").filter { $0.hasPrefix("log: one Jarhead:") }.count == 1, "…and logs one line: \(secondOut.split(separator: "\n").first { $0.hasPrefix("log:") } ?? "none")")
        let until = Date().addingTimeInterval(3)
        while heard == 0, Date() < until { _ = RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.05)) }
        check(heard == 1, "…and the one instance hears the hand-off (\(heard))")

        SingleInstance.giveUpClaim()
        let first = child(["--ensure", state.path])
        first.process.waitUntilExit()
        check(text(first.out).contains("proceeded"), "with the claim free, a launch proceeds")
        let other = root.appendingPathComponent("other-state", isDirectory: true)
        heard = 0
        let elsewhere = child(["--ensure", other.path])
        elsewhere.process.waitUntilExit()
        check(text(elsewhere.out).contains("proceeded"), "another state dir is another Jarhead (a test launch with JARHEAD_STATE_DIR)")

        print(failures == 0 ? "single-instance: all checks ok" : "single-instance: \(failures) FAIL")
        exit(failures == 0 ? 0 : 1)
    }
}
