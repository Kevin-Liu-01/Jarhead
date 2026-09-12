import Foundation
import Darwin

/// Owns the `jarheadd` child process: spawn, log, restart with backoff, stop cleanly.
///
/// If a daemon already answers on the socket (the CLI started one), we attach to it
/// instead of spawning and only spawn our own if it later goes away. The daemon exits
/// when its stdin closes, so the stdin pipe is the primary stop signal; SIGTERM is the
/// fallback.
@MainActor
final class DaemonProcess {
    private let location: RepoLocation
    private let socketPath: String
    private let state: AppState

    private var process: Process?
    private var stdinPipe: Pipe?
    private var stopping = false
    private var backoff: TimeInterval = 1
    private var spawnedAt: Date?
    private var restartTimer: Timer?
    private var attachTimer: Timer?
    private(set) var attached = false

    /// Queue-confined; safe to append to from the pipe reader threads.
    nonisolated private let logFile: DaemonLog
    /// The daemon's "restart me" exit code (sysexits EX_TEMPFAIL).
    static let restartRequestedExit: Int32 = 75

    var pid: Int32? { process.flatMap { $0.isRunning ? $0.processIdentifier : nil } }

    init(location: RepoLocation, socketPath: String, state: AppState) {
        self.location = location
        self.socketPath = socketPath
        self.state = state
        // The log lives in the state dir (~/.jarhead by default) regardless of where the socket is.
        let env = ProcessInfo.processInfo.environment
        let stateDir = env["JARHEAD_STATE_DIR"].map { URL(fileURLWithPath: ($0 as NSString).expandingTildeInPath) }
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".jarhead")
        self.logFile = DaemonLog(url: stateDir.appendingPathComponent("daemon.log"))
        // The client's two liveness signals (EngineClient, REDESIGN §16 "Liveness"): a daemon
        // that stopped answering pings, and the `daemon` row's "Restart daemon" pressed while
        // nothing answers. Both arrive on the main queue; both end in `kick`.
        for (name, why) in [(EngineClient.daemonUnresponsiveNotification, "daemon unresponsive"), (EngineClient.restartDaemonNotification, "restart requested from the daemon row")] {
            let observer = NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                let pid = note.userInfo?["pid"] as? Int32
                let seconds = note.userInfo?["seconds"] as? Int
                let reason = seconds.map { "\(why): no pong for \($0) s" } ?? why
                MainActor.assumeIsolated { self?.kick(why: reason, pid: pid) }
            }
            observers.append(observer)
        }
    }

    deinit {
        for o in observers { NotificationCenter.default.removeObserver(o) }
    }

    private var observers: [NSObjectProtocol] = []
    /// When `kick` last acted; one kick per `kickDebounce` so a slow Mac is not kicked into a restart loop.
    private var lastKickAt: Date?
    static let kickDebounce: TimeInterval = 5

    /// The daemon is up and not answering (EngineClient missed two pongs), or Kevin pressed
    /// "Restart daemon" while nothing answers. What we own is SIGKILLed — its exit runs the
    /// usual `handleExit` → `scheduleRestart` with the backoff, so a daemon that dies on
    /// every start is not respawned hot. A daemon we only attached to is killed by the pid
    /// its hello gave on the connection that just stopped answering — and only when that
    /// pid is still a `node` (`proc_pidpath`): a pid is a number the kernel reuses, and the
    /// one thing this must never do is kill one of Kevin's own processes. Then we take over
    /// on the next probe. A kick inside the debounce window is logged and ignored: the
    /// previous one is still working.
    func kick(why: String, pid hint: Int32?) {
        guard !stopping else { return }
        if let last = lastKickAt, Date().timeIntervalSince(last) < DaemonProcess.kickDebounce {
            log("[app] \(why); a restart is already under way (\(Int(Date().timeIntervalSince(last))) s ago)")
            return
        }
        lastKickAt = Date()
        if let p = process, p.isRunning {
            log("[app] \(why); killing daemon pid \(p.processIdentifier) and respawning")
            setDetail("daemon unresponsive; restarting")
            kill(p.processIdentifier, SIGKILL)
            return
        }
        if let hint, hint > 0, hint != ProcessInfo.processInfo.processIdentifier {
            if let exe = DaemonProcess.executablePath(of: hint), isDaemonExecutable(exe) {
                log("[app] \(why); killing the attached daemon pid \(hint) (\(exe)) and starting our own")
                kill(hint, SIGKILL)
            } else {
                log("[app] \(why); pid \(hint) from the daemon's hello is not a node process any more (gone, or the number was reused) — not killed; starting our own")
            }
        } else {
            log("[app] \(why); no daemon of ours is running — starting one")
        }
        attachTimer?.invalidate(); attachTimer = nil
        attached = false
        backoff = 1
        setDetail("starting")
        // Through the restart timer, not spawn() directly: it probes the socket first, so a
        // daemon that still answers (a wrong pid hint) is attached to again rather than doubled.
        scheduleRestart(why: why)
    }

    /// The executable behind a pid (`proc_pidpath`), or nil when there is no such process or it is not ours to see.
    nonisolated static func executablePath(of pid: Int32) -> String? {
        var buf = [CChar](repeating: 0, count: 4 * Int(PATH_MAX))
        let n = proc_pidpath(pid, &buf, UInt32(buf.count))
        guard n > 0 else { return nil }
        return String(cString: buf)
    }

    /// True for the node this app spawns daemons with, or any `node` (a CLI-started daemon may
    /// run under another version): a process that hello'd on our socket a moment ago and is
    /// still a node is the daemon; anything else is a reused pid.
    private func isDaemonExecutable(_ path: String) -> Bool {
        let exe = URL(fileURLWithPath: path).resolvingSymlinksInPath()
        if exe.path == location.node.resolvingSymlinksInPath().path { return true }
        return exe.lastPathComponent == "node"
    }

    // MARK: - lifecycle

    func start() {
        stopping = false
        if DaemonProcess.socketAnswers(socketPath) {
            attached = true
            setDetail("attached to a running daemon on \(shortPath(socketPath))")
            log("[app] attached to an existing daemon on \(socketPath)")
            scheduleAttachProbe()
            return
        }
        spawn()
    }

    /// Blocking, ≤ `timeout` seconds. Called from applicationWillTerminate.
    func stop(timeout: TimeInterval = 5) {
        stopping = true
        restartTimer?.invalidate(); restartTimer = nil
        attachTimer?.invalidate(); attachTimer = nil
        // A clean quit says so first: the daemon then treats the stdin EOF that follows as
        // a shutdown. Without a bye (the app crashed) it lingers 90 s for the relaunch and
        // keeps the brain warm (packages/daemon/src/main.ts). Sent even when attached to a
        // daemon this app did not spawn: one orphaned by an earlier crash — we were its
        // relaunch — has no other way to hear that Kevin quit.
        switch DaemonProcess.sendBye(socketPath) {
        case .acked: log("[app] bye acknowledged by the daemon (clean quit)")
        case .unacknowledged: log("[app] bye sent but not acknowledged within 600 ms; the daemon may linger")
        case .noDaemon: break
        }
        guard let p = process, p.isRunning else {
            process = nil
            CrashGuard.setDaemonPid(nil)
            return
        }
        log("[app] stopping daemon pid \(p.processIdentifier)")
        let start = Date()
        // 1. Close stdin: the daemon treats EOF as shutdown.
        try? stdinPipe?.fileHandleForWriting.close()
        waitUntilExit(p, deadline: start.addingTimeInterval(min(3, timeout)))
        // 2. SIGTERM.
        if p.isRunning {
            p.terminate()
            waitUntilExit(p, deadline: start.addingTimeInterval(timeout))
        }
        // 3. Give up politely.
        if p.isRunning {
            kill(p.processIdentifier, SIGKILL)
            log("[app] daemon did not exit within \(Int(timeout)) s; killed")
        } else {
            log("[app] daemon exited (\(p.terminationStatus))")
        }
        process = nil
        stdinPipe = nil
        CrashGuard.setDaemonPid(nil)
        logFile.flush()
    }

    /// The previous run's crash (CrashGuard's report), into daemon.log next to the engine's
    /// lines, so the two halves of the story sit in one file.
    func noteCrash(_ notice: CrashNotice) {
        let came = notice.relaunched ? "relaunched by the crash guard" : "not relaunched (three crashes in ten minutes)"
        log("[app] crashed \(CrashNotice.ago(notice.at)): \(notice.reason) — report \(notice.fileURL.path) · \(came)")
    }

    private func waitUntilExit(_ p: Process, deadline: Date) {
        while p.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
    }

    // MARK: - spawn / restart

    private func spawn() {
        guard !stopping else { return }
        attached = false
        attachTimer?.invalidate(); attachTimer = nil

        let p = Process()
        p.executableURL = location.node
        p.arguments = [location.tsx.path, location.daemon.path, "--socket", socketPath]
        p.currentDirectoryURL = location.repo

        var env = ProcessInfo.processInfo.environment
        env["PATH"] = DaemonProcess.daemonPath(nodeDir: location.node.deletingLastPathComponent().path, inherited: env["PATH"])
        env["JARHEAD_SOCKET"] = socketPath
        if let hands = location.handsBin, env["JARHEAD_HANDS_BIN"] == nil {
            env["JARHEAD_HANDS_BIN"] = hands.path
        }
        // JARHEAD_AUTO_WAKE and everything else are inherited as-is.
        p.environment = env

        let stdin = Pipe()
        let stdout = Pipe()
        let stderr = Pipe()
        p.standardInput = stdin
        p.standardOutput = stdout
        p.standardError = stderr
        stdout.fileHandleForReading.readabilityHandler = { [weak self] h in
            let d = h.availableData
            if !d.isEmpty { self?.logFile.append(d) }
        }
        stderr.fileHandleForReading.readabilityHandler = { [weak self] h in
            let d = h.availableData
            if !d.isEmpty { self?.logFile.append(d) }
        }
        p.terminationHandler = { [weak self] proc in
            stdout.fileHandleForReading.readabilityHandler = nil
            stderr.fileHandleForReading.readabilityHandler = nil
            // The crash reason is usually the last few lines, still sitting in the
            // pipes; drain them off-main (a grandchild holding the write end would
            // otherwise stall us) so the log ends where the daemon did.
            if let logFile = self?.logFile {
                DispatchQueue.global(qos: .utility).async {
                    let restOut = stdout.fileHandleForReading.readDataToEndOfFile()
                    if !restOut.isEmpty { logFile.append(restOut) }
                    let restErr = stderr.fileHandleForReading.readDataToEndOfFile()
                    if !restErr.isEmpty { logFile.append(restErr) }
                }
            }
            let status = proc.terminationStatus
            let reason = proc.terminationReason
            let owner = self
            DispatchQueue.main.async {
                MainActor.assumeIsolated { owner?.handleExit(status: status, reason: reason, proc: proc) }
            }
        }

        logFile.rotateIfNeeded()
        log("[app] spawning \(location.node.path) \(p.arguments!.joined(separator: " ")) (cwd \(location.repo.path))")
        do {
            try p.run()
        } catch {
            setDetail("failed to start daemon: \(error.localizedDescription)")
            log("[app] spawn failed: \(error.localizedDescription)")
            scheduleRestart(why: "spawn failed")
            return
        }
        process = p
        stdinPipe = stdin
        spawnedAt = Date()
        CrashGuard.setDaemonPid(p.processIdentifier)
        setDetail("running pid \(p.processIdentifier)")
    }

    private func handleExit(status: Int32, reason: Process.TerminationReason, proc: Process) {
        guard proc === process else { return }
        process = nil
        stdinPipe = nil
        CrashGuard.setDaemonPid(nil)
        let how = reason == .uncaughtSignal ? "signal \(status)" : "exit \(status)"
        log("[app] daemon ended: \(how)")
        if stopping { return }
        // Exit 75 (EX_TEMPFAIL) is the daemon asking to be restarted — after it has
        // rewritten its own code and passed its checks. Fresh start, no backoff.
        if reason == .exit && status == DaemonProcess.restartRequestedExit {
            log("[app] daemon requested a restart (self-update); respawning now")
            backoff = 1
            setDetail("restarting (self-update)")
            spawn()
            return
        }
        // A daemon that lived a while has earned a fresh backoff.
        if let at = spawnedAt, Date().timeIntervalSince(at) > 60 { backoff = 1 }
        scheduleRestart(why: how)
    }

    private func scheduleRestart(why: String) {
        guard !stopping else { return }
        let delay = backoff
        backoff = min(backoff * 2, 30)
        setDetail("restarting in \(Int(delay.rounded())) s: \(why)")
        restartTimer?.invalidate()
        restartTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
            let owner = self
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let self = owner, !self.stopping else { return }
                    // Someone else may have brought a daemon up in the meantime.
                    if DaemonProcess.socketAnswers(self.socketPath) {
                        self.attached = true
                        self.setDetail("attached to a running daemon on \(self.shortPath(self.socketPath))")
                        self.scheduleAttachProbe()
                    } else {
                        self.setDetail("starting")
                        self.spawn()
                    }
                }
            }
        }
    }

    /// While attached to a daemon we did not start, poll it; take over if it vanishes.
    private func scheduleAttachProbe() {
        attachTimer?.invalidate()
        attachTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            let owner = self
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let self = owner, self.attached, !self.stopping else { return }
                    // A live engine connection is proof enough; only probe the socket
                    // (hello + full snapshot on the daemon side) while disconnected.
                    if self.state.connected { return }
                    if !DaemonProcess.socketAnswers(self.socketPath) {
                        self.attachTimer?.invalidate(); self.attachTimer = nil
                        self.log("[app] the attached daemon went away; starting our own")
                        self.backoff = 1
                        self.setDetail("starting")
                        self.spawn()
                    }
                }
            }
        }
    }

    // MARK: - PATH

    /// The PATH the daemon (and everything it spawns: claude, codex, gemini…) sees.
    /// Apps launched from the Dock inherit a bare PATH, so this unions the login
    /// shell's PATH with the places CLIs actually live on a Mac, including the Codex
    /// binary bundled inside ChatGPT.app / Codex.app. Vendor-neutral by design.
    nonisolated static func daemonPath(nodeDir: String, inherited: String?) -> String {
        var parts: [String] = []
        func add(_ p: String) {
            let trimmed = p.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty, !parts.contains(trimmed) else { return }
            parts.append(trimmed)
        }
        add(nodeDir)
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        for p in ["\(home)/.local/bin", "\(home)/.codex/bin", "\(home)/.claude/local", "\(home)/.bun/bin", "\(home)/Library/pnpm", "\(home)/.cargo/bin", "\(home)/go/bin", "/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"] {
            if FileManager.default.fileExists(atPath: p) { add(p) }
        }
        for p in loginShellPath().split(separator: ":") { add(String(p)) }
        for p in (inherited ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(separator: ":") { add(String(p)) }
        // CLIs that ship inside an app bundle and are never on PATH.
        for p in ["/Applications/ChatGPT.app/Contents/Resources", "/Applications/Codex.app/Contents/Resources"] {
            if FileManager.default.isExecutableFile(atPath: p + "/codex") { add(p) }
        }
        return parts.joined(separator: ":")
    }

    /// `$PATH` as the user's login shell sets it (nvm, homebrew, cargo…), or "" on failure.
    nonisolated private static func loginShellPath() -> String {
        let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
        let p = Process()
        p.executableURL = URL(fileURLWithPath: shell)
        p.arguments = ["-lic", "printf %s \"$PATH\""]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return "" }
        let deadline = Date().addingTimeInterval(4)
        while p.isRunning && Date() < deadline { usleep(50_000) }
        if p.isRunning { p.terminate(); return "" }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    // MARK: - socket probe

    /// True when something accepts a connection on the unix socket right now.
    nonisolated static func socketAnswers(_ path: String) -> Bool {
        guard let fd = connectSocket(path) else { return false }
        close(fd)
        return true
    }

    enum ByeOutcome { case acked, unacknowledged, noDaemon }

    /// One `{type:"bye"}` frame (wire.ts) on a fresh connection, then read until the
    /// daemon's `bye` ack (≤ 600 ms) before closing. Blocking; on the way out.
    ///
    /// The ack is the point. The daemon answers a fresh connection with its hello and a
    /// snapshot that can run to tens of kilobytes (64 agent sessions); a client that closes
    /// before that write has drained fails it with EPIPE, Node destroys the socket, and a
    /// bye still unread in the receive buffer is lost with it — measured against a real
    /// daemon, twice. Once the ack has arrived the daemon has processed the bye.
    nonisolated static func sendBye(_ path: String) -> ByeOutcome {
        guard let fd = connectSocket(path) else { return .noDaemon }
        defer { close(fd) }
        guard let frame = try? Wire.encodeJSON(["type": "bye"]) else { return .noDaemon }
        let sent = frame.withUnsafeBytes { raw -> Int in
            guard let base = raw.baseAddress else { return -1 }
            return Int(write(fd, base, raw.count))
        }
        guard sent == frame.count else { return .noDaemon }
        let decoder = FrameDecoder()
        var scratch = [UInt8](repeating: 0, count: 64 * 1024)
        let deadline = Date().addingTimeInterval(0.6)
        while true {
            let left = Int32(max(0, deadline.timeIntervalSinceNow * 1000))
            var pfd = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            guard left > 0, poll(&pfd, 1, left) > 0 else { return .unacknowledged }
            let n = recv(fd, &scratch, scratch.count, 0)
            guard n > 0 else { return .unacknowledged }
            guard let frames = try? decoder.push(Data(scratch[0..<n])) else { return .unacknowledged }
            for f in frames where f.type == FrameType.json.rawValue {
                if let obj = try? JSONSerialization.jsonObject(with: f.payload) as? [String: Any], obj["type"] as? String == "bye" { return .acked }
            }
        }
    }

    /// A connected fd to the unix socket, or nil when nobody listens (caller closes it).
    nonisolated private static func connectSocket(_ path: String) -> Int32? {
        guard FileManager.default.fileExists(atPath: path) else { return nil }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let maxLen = MemoryLayout.size(ofValue: addr.sun_path) - 1
        let bytes = Array(path.utf8)
        guard bytes.count <= maxLen else {
            close(fd)
            return nil
        }
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            for (i, b) in bytes.enumerated() { raw[i] = b }
            raw[bytes.count] = 0
        }
        let len = socklen_t(MemoryLayout<sockaddr_un>.size)
        let rc = withUnsafePointer(to: &addr) { ptr -> Int32 in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, len) }
        }
        guard rc == 0 else {
            close(fd)
            return nil
        }
        return fd
    }

    // MARK: - log

    /// Into daemon.log (the `[app]` lines) and the crash guard's ring, so a report carries
    /// the daemon's last moves too.
    func log(_ line: String) {
        logFile.line(line)
        CrashGuard.remember(line)
    }

    private func setDetail(_ text: String) {
        state.daemonDetail = text
    }

    private func shortPath(_ p: String) -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return p.hasPrefix(home) ? "~" + p.dropFirst(home.count) : p
    }
}

/// Append-only log file with size-based rotation. All state lives on its own queue.
final class DaemonLog: @unchecked Sendable {
    static let rotateBytes: UInt64 = 5 * 1024 * 1024
    private let url: URL
    private let queue = DispatchQueue(label: "jarhead.daemon.log")
    private var handle: FileHandle?
    private var written: UInt64 = 0
    private let stamp = ISO8601DateFormatter()

    init(url: URL) {
        self.url = url
        queue.sync { open() }
    }

    func append(_ data: Data) {
        queue.async {
            try? self.handle?.write(contentsOf: data)
            self.written += UInt64(data.count)
            // Rotation is checked on every write, not only at spawn, so a daemon that
            // runs for days cannot grow the log without bound.
            if self.written > DaemonLog.rotateBytes { self.rotateLocked() }
        }
    }

    func line(_ text: String) {
        let s = stamp.string(from: Date())
        append(Data("\(s) \(text)\n".utf8))
    }

    func rotateIfNeeded() {
        queue.async {
            if self.written > DaemonLog.rotateBytes { self.rotateLocked() }
        }
    }

    /// On `queue`.
    private func rotateLocked() {
        let fm = FileManager.default
        try? handle?.close()
        handle = nil
        let rotated = url.deletingPathExtension().appendingPathExtension("log.1")
        try? fm.removeItem(at: rotated)
        try? fm.moveItem(at: url, to: rotated)
        open()
    }

    func flush() {
        queue.sync { try? handle?.synchronize() }
    }

    /// On `queue`. O_APPEND, not a remembered offset: a daemon orphaned by an app crash
    /// appends its own lines to this file once its stdout pipe is gone (main.ts), and a
    /// handle writing at the offset it last knew would overwrite them.
    private func open() {
        let fm = FileManager.default
        try? fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let fd = Darwin.open(url.path, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0o644)
        guard fd >= 0 else {
            handle = nil
            written = 0
            return
        }
        handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        written = (try? handle?.seekToEnd()) ?? 0
    }
}
