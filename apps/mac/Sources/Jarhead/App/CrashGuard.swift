import AppKit
import Darwin
import Foundation
import os

// CrashGuard: when Jarhead dies, learn from it and come back.
//
// Eight crash reports on 2026-09-11 were uncaught NSExceptions — AVFoundation's "tap format
// mismatch" after an input-device change, CoreText fed a NaN geometry by the notch island —
// and every one took the daemon down with it (its stdin closed) and left the app dead until
// Kevin noticed. This file is the net under whatever goes wrong next:
//
//   1. An uncaught-exception handler and POSIX signal handlers (SIGABRT, SIGSEGV, SIGBUS,
//      SIGILL, SIGFPE, SIGTRAP) write `<state dir>/crashes/<time>.txt`: the reason, a
//      symbolicated backtrace, version and commit, uptime, the phase, the last 40 lines of
//      the app's own log ring and the daemon's pid — then chain to the previous handler, so
//      the system's .ips is still written and `lastExceptionBacktrace` is untouched.
//   2. The handler relaunches the app once through a detached `/bin/sh` (its own session,
//      so it survives our death), capped at three relaunches in ten minutes — the crash
//      files are the counter. Beyond the cap the report says why and the app stays down.
//   3. On the next launch `install` hands back the fresh report (< 10 min) as a `Notice`
//      for the Console rail, the status menu and daemon.log. Never a modal.
//
// The signal path is async-signal-safe by construction. Everything it touches — the
// directory fd, every label, the phase and signal names, the ring, the frame array, the
// relaunch argv/envp and spawn attributes, the scratch buffer — is allocated at install
// time; the handler only loads pointers, formats integers into that scratch and calls
// write(2), openat(2), backtrace(3), backtrace_symbols_fd(3), sigaction(2), raise(3) and
// posix_spawn(2). No Swift String, Array, closure or class object is created there. A
// crash handler that itself crashes is worse than none.

// MARK: - storage the handlers read (set once in install; constant initialisers only, so
// nothing here runs a lazy initialiser under a lock inside a handler)

private let cgSlotBytes = 512
private let cgSlots = 40
private let cgFrameCap = 128
private let cgRecentCap = 16
/// Relaunches allowed per `cgWindowSeconds`.
private let cgRelaunchCap: Int32 = 3
private let cgWindowSeconds: Int = 600

nonisolated(unsafe) private var cgInstalled = false
nonisolated(unsafe) private var cgDirFd: Int32 = -1
nonisolated(unsafe) private var cgReportFd: Int32 = -1
nonisolated(unsafe) private var cgReported: Int32 = 0
nonisolated(unsafe) private var cgRelaunched: Int32 = 0
nonisolated(unsafe) private var cgLaunchEpoch: Int = 0
nonisolated(unsafe) private var cgTzOffset: Int = 0
nonisolated(unsafe) private var cgPhase: Int = 0
nonisolated(unsafe) private var cgPhaseCount: Int = 0
nonisolated(unsafe) private var cgDaemonPid: Int32 = 0
nonisolated(unsafe) private var cgRecentCount: Int = 0
nonisolated(unsafe) private var cgRingHead = 0
nonisolated(unsafe) private var cgRingCount = 0
nonisolated(unsafe) private var cgSignalCount = 0
nonisolated(unsafe) private var cgRelaunchWanted = false
nonisolated(unsafe) private var cgPrevExceptionHandler: (@convention(c) (NSException) -> Void)? = nil

nonisolated(unsafe) private var cgScratch: UnsafeMutablePointer<CChar>? = nil
nonisolated(unsafe) private var cgNameBuf: UnsafeMutablePointer<CChar>? = nil
nonisolated(unsafe) private var cgRing: UnsafeMutablePointer<CChar>? = nil
nonisolated(unsafe) private var cgRingLock: UnsafeMutablePointer<os_unfair_lock>? = nil
nonisolated(unsafe) private var cgFrames: UnsafeMutablePointer<UnsafeMutableRawPointer?>? = nil
nonisolated(unsafe) private var cgRecentTimes: UnsafeMutablePointer<Int>? = nil
nonisolated(unsafe) private var cgPhaseNames: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>? = nil
nonisolated(unsafe) private var cgSignals: UnsafeMutablePointer<Int32>? = nil
nonisolated(unsafe) private var cgSignalNames: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>? = nil
nonisolated(unsafe) private var cgPrevActions: UnsafeMutablePointer<sigaction>? = nil
nonisolated(unsafe) private var cgDefaultAction: UnsafeMutablePointer<sigaction>? = nil
nonisolated(unsafe) private var cgExcName: UnsafeMutablePointer<CChar>? = nil
nonisolated(unsafe) private var cgExcReason: UnsafeMutablePointer<CChar>? = nil
nonisolated(unsafe) private var cgVersion: UnsafeMutablePointer<CChar>? = nil
nonisolated(unsafe) private var cgCommit: UnsafeMutablePointer<CChar>? = nil
nonisolated(unsafe) private var cgLabels: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>? = nil
nonisolated(unsafe) private var cgSpawnAttr: UnsafeMutablePointer<posix_spawnattr_t?>? = nil
nonisolated(unsafe) private var cgSpawnActions: UnsafeMutablePointer<posix_spawn_file_actions_t?>? = nil
nonisolated(unsafe) private var cgSpawnPid: UnsafeMutablePointer<pid_t>? = nil
nonisolated(unsafe) private var cgArgv: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>? = nil
nonisolated(unsafe) private var cgEnvp: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>? = nil

private let cgExcNameBytes = 256
private let cgExcReasonBytes = 2048
private let cgCommitBytes = 64

/// The fixed lines of a report, strdup'd at install; indexed by this enum in the handlers.
private enum L: Int, CaseIterable {
    case header, at, kindSignal, kindException, reason, fault, version, commit, uptime, seconds, phase, daemonPid, daemonNone
    case relaunchYes, relaunchYesMid, relaunchYesEnd, relaunchNo, relaunchNoEnd, relaunchDisabled
    case backtrace, logHead, logEmpty, thenSignal, thenSignalEnd, survived, nl, colon, paren, close, closeNl, unknownSignal

    var text: String {
        switch self {
        case .header: return "Jarhead crash report\n"
        case .at: return "at: "
        case .kindSignal: return "kind: signal\nreason: "
        case .kindException: return "kind: uncaught exception\nreason: "
        case .reason: return "reason: "
        case .fault: return "fault address: 0x"
        case .version: return "version: "
        case .commit: return "commit: "
        case .uptime: return "uptime: "
        case .seconds: return " s\n"
        case .phase: return "phase: "
        case .daemonPid: return "daemon pid: "
        case .daemonNone: return "daemon pid: none (not spawned by this app)\n"
        case .relaunchYes: return "relaunch: yes ("
        case .relaunchYesMid: return " of "
        case .relaunchYesEnd: return " in the last 10 min)\n"
        case .relaunchNo: return "relaunch: no — "
        case .relaunchNoEnd: return " crashes in 10 minutes; staying down until you open Jarhead yourself\n"
        case .relaunchDisabled: return "relaunch: no — JARHEAD_NO_RELAUNCH=1\n"
        case .backtrace: return "\nbacktrace:\n"
        case .logHead: return "\nlog (last lines, oldest first):\n"
        case .logEmpty: return "(nothing logged yet)\n"
        case .thenSignal: return "\nthen: signal "
        case .thenSignalEnd: return " — the runtime's abort after the exception above\n"
        case .survived: return "\nsurvived: the runtime did not abort — AppKit reported the exception and the app kept running; no relaunch, the guard is re-armed\n"
        case .nl: return "\n"
        case .colon: return ": "
        case .paren: return " ("
        case .close: return ")"
        case .closeNl: return ")\n"
        case .unknownSignal: return "signal"
        }
    }
}

// MARK: - the async-signal-safe primitives

/// write(2) a C string to the open report; a no-op without one.
private func cgPut(_ p: UnsafeMutablePointer<CChar>?) {
    guard cgReportFd >= 0, let p else { return }
    _ = write(cgReportFd, p, strlen(p))
}

private func cgPut(_ label: L) {
    guard let labels = cgLabels else { return }
    cgPut(labels[label.rawValue])
}

/// Decimal digits of `value` into `buf` at `pos`, zero-padded to `width` (0 = none). Returns the new position.
private func cgPutInt(_ buf: UnsafeMutablePointer<CChar>, _ pos: Int, _ value: Int, width: Int = 0) -> Int {
    var p = pos
    var v = value
    if v < 0 {
        buf[p] = 45 // '-'
        p += 1
        v = -v
    }
    var digits = 0
    var probe = v
    repeat {
        digits += 1
        probe /= 10
    } while probe > 0
    let n = max(digits, width)
    var i = n - 1
    while i >= 0 {
        buf[p + i] = CChar(48 + v % 10)
        v /= 10
        i -= 1
    }
    return p + n
}

/// write(2) a decimal integer through the scratch buffer.
private func cgPutInt(_ value: Int) {
    guard let s = cgScratch else { return }
    let n = cgPutInt(s, 0, value)
    s[n] = 0
    cgPut(s)
}

/// write(2) a hexadecimal integer (no prefix) through the scratch buffer.
private func cgPutHex(_ value: UInt) {
    guard let s = cgScratch else { return }
    var v = value
    var digits = 0
    var probe = v
    repeat {
        digits += 1
        probe >>= 4
    } while probe > 0
    var i = digits - 1
    while i >= 0 {
        let d = Int(v & 0xf)
        s[i] = CChar(d < 10 ? 48 + d : 87 + d) // '0'… / 'a'…
        v >>= 4
        i -= 1
    }
    s[digits] = 0
    cgPut(s)
}

/// Civil date from days since 1970-01-01 (Howard Hinnant's algorithm; integers only).
private func cgCivil(_ days: Int) -> (y: Int, m: Int, d: Int) {
    let z = days + 719_468
    let era = (z >= 0 ? z : z - 146_096) / 146_097
    let doe = z - era * 146_097
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365
    let y = yoe + era * 400
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
    let mp = (5 * doy + 2) / 153
    let d = doy - (153 * mp + 2) / 5 + 1
    let m = mp < 10 ? mp + 3 : mp - 9
    return (m <= 2 ? y + 1 : y, m, d)
}

/// "2026-09-11T23-05-58-0700" (local time, `-` for `:` so the file name reads in Finder) into `buf`, NUL-terminated. Returns the length.
private func cgStamp(into buf: UnsafeMutablePointer<CChar>, epoch: Int) -> Int {
    let local = epoch + cgTzOffset
    let days = local >= 0 ? local / 86400 : (local - 86399) / 86400
    let secs = local - days * 86400
    let (y, m, d) = cgCivil(days)
    var p = cgPutInt(buf, 0, y, width: 4)
    buf[p] = 45; p += 1
    p = cgPutInt(buf, p, m, width: 2)
    buf[p] = 45; p += 1
    p = cgPutInt(buf, p, d, width: 2)
    buf[p] = 84; p += 1 // 'T'
    p = cgPutInt(buf, p, secs / 3600, width: 2)
    buf[p] = 45; p += 1
    p = cgPutInt(buf, p, (secs % 3600) / 60, width: 2)
    buf[p] = 45; p += 1
    p = cgPutInt(buf, p, secs % 60, width: 2)
    let off = cgTzOffset
    buf[p] = off < 0 ? 45 : 43; p += 1 // '-' / '+'
    let a = off < 0 ? -off : off
    p = cgPutInt(buf, p, a / 3600, width: 2)
    p = cgPutInt(buf, p, (a % 3600) / 60, width: 2)
    buf[p] = 0
    return p
}

/// Open `<crashes>/<stamp>.txt` for this crash and write the head of the report.
private func cgOpenReport(now: Int) {
    guard cgDirFd >= 0, let name = cgNameBuf else { return }
    let n = cgStamp(into: name, epoch: now)
    name[n] = 46; name[n + 1] = 116; name[n + 2] = 120; name[n + 3] = 116; name[n + 4] = 0 // ".txt"
    var fd = openat(cgDirFd, name, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0o644)
    if fd < 0 { fd = openat(cgDirFd, name, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0o644) }
    cgReportFd = fd
    cgPut(.header)
    cgPut(.at)
    name[n] = 0 // the stamp alone
    cgPut(name)
    cgPut(.nl)
}

/// Version, commit, uptime, phase, daemon pid, the relaunch decision and the log ring.
private func cgWriteTail(now: Int) {
    cgPut(.version); cgPut(cgVersion); cgPut(.nl)
    cgPut(.commit); cgPut(cgCommit); cgPut(.nl)
    cgPut(.uptime); cgPutInt(now - cgLaunchEpoch); cgPut(.seconds)
    cgPut(.phase)
    if let names = cgPhaseNames, cgPhase >= 0, cgPhase < cgPhaseCount { cgPut(names[cgPhase]) }
    cgPut(.nl)
    if cgDaemonPid > 0 {
        cgPut(.daemonPid); cgPutInt(Int(cgDaemonPid)); cgPut(.nl)
    } else {
        cgPut(.daemonNone)
    }
    // The relaunch decision, written before the spawn so the reason is on disk whatever happens next.
    var recent = 0
    if let times = cgRecentTimes {
        for i in 0..<cgRecentCount where now - times[i] < cgWindowSeconds { recent += 1 }
    }
    if !cgRelaunchWanted {
        cgPut(.relaunchDisabled)
    } else if recent < Int(cgRelaunchCap) {
        cgPut(.relaunchYes); cgPutInt(recent + 1); cgPut(.relaunchYesMid); cgPutInt(Int(cgRelaunchCap)); cgPut(.relaunchYesEnd)
        cgRelaunched = 1
    } else {
        cgPut(.relaunchNo); cgPutInt(recent + 1); cgPut(.relaunchNoEnd)
        cgRelaunched = 2
    }
    // The ring, oldest first. Read without the lock: a torn line is acceptable in a crash.
    cgPut(.logHead)
    if cgRingCount == 0 {
        cgPut(.logEmpty)
    } else if let ring = cgRing {
        let start = cgRingCount < cgSlots ? 0 : cgRingHead
        for i in 0..<cgRingCount {
            let slot = ring + ((start + i) % cgSlots) * cgSlotBytes
            slot[cgSlotBytes - 1] = 0
            cgPut(slot)
            cgPut(.nl)
        }
    }
}

/// Spawn the detached relauncher, once, when `cgWriteTail` decided so.
private func cgSpawnRelaunch() {
    guard cgRelaunched == 1, let argv = cgArgv, let path = argv[0], let pid = cgSpawnPid else { return }
    cgRelaunched = 3 // spawned (or tried)
    _ = posix_spawn(pid, path, cgSpawnActions, cgSpawnAttr, argv, cgEnvp)
}

// MARK: - the handlers

/// The ObjC uncaught-exception handler. Not a signal context: Foundation is allowed here,
/// but the report goes through the same writer and the runtime aborts right after we return —
/// the signal handler then only appends one line.
private func cgExceptionHandler(_ exception: NSException) {
    guard cgInstalled, cgReported == 0 else {
        cgPrevExceptionHandler?(exception)
        return
    }
    cgReported = 1
    if let n = cgExcName { strlcpy(n, exception.name.rawValue, cgExcNameBytes) }
    if let r = cgExcReason { strlcpy(r, exception.reason ?? "(no reason)", cgExcReasonBytes) }
    let now = Int(time(nil))
    cgOpenReport(now: now)
    cgPut(.kindException); cgPut(cgExcName); cgPut(.colon); cgPut(cgExcReason); cgPut(.nl)
    cgWriteTail(now: now)
    cgPut(.backtrace)
    for line in exception.callStackSymbols {
        line.withCString { _ = write(cgReportFd, $0, strlen($0)) }
        cgPut(.nl)
    }
    cgSpawnRelaunch()
    cgPrevExceptionHandler?(exception)
    // The runtime aborts right after this returns — normally. AppKit's own handler can
    // instead report an exception raised inside its event loop and keep the app running;
    // then this fires, says so in the report, and re-arms the guard. (The relauncher
    // spawned above sees this pid stay alive and exits without launching anything.)
    DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 1.5) { cgNoteSurvived() }
}

/// Reached only when an uncaught exception did not end the process.
private func cgNoteSurvived() {
    guard cgReported == 1, cgReportFd >= 0 else { return }
    cgPut(.survived)
    close(cgReportFd)
    cgReportFd = -1
    cgReported = 0
    cgRelaunched = 0
    CrashGuard.remember("the uncaught exception did not end the process; the crash guard is re-armed")
}

/// The signal handler (SA_SIGINFO). Async-signal-safe: see the file comment.
private func cgSignalHandler(_ sig: Int32, _ info: UnsafeMutablePointer<siginfo_t>?, _ ctx: UnsafeMutableRawPointer?) {
    var index = -1
    if let sigs = cgSignals {
        for i in 0..<cgSignalCount where sigs[i] == sig { index = i }
    }
    let name: UnsafeMutablePointer<CChar>? = (index >= 0 && cgSignalNames != nil) ? cgSignalNames![index] : cgLabels?[L.unknownSignal.rawValue]
    if cgReported == 0 {
        cgReported = 1
        let now = Int(time(nil))
        cgOpenReport(now: now)
        cgPut(.kindSignal); cgPut(name); cgPut(.paren); cgPutInt(Int(sig)); cgPut(.closeNl)
        if sig == SIGSEGV || sig == SIGBUS, let info {
            cgPut(.fault); cgPutHex(UInt(bitPattern: info.pointee.si_addr)); cgPut(.nl)
        }
        cgWriteTail(now: now)
        cgPut(.backtrace)
        if let frames = cgFrames, cgReportFd >= 0 {
            let n = backtrace(frames, Int32(cgFrameCap))
            if n > 0 { backtrace_symbols_fd(frames, n, cgReportFd) }
        }
        cgSpawnRelaunch()
    } else {
        // The abort that follows an uncaught exception (already reported above).
        cgPut(.thenSignal); cgPut(name); cgPut(.paren); cgPutInt(Int(sig)); cgPut(.close)
        cgPut(.thenSignalEnd)
    }
    if cgReportFd >= 0 { fsync(cgReportFd) }

    // Chain: a previous handler is called; otherwise the default disposition is restored
    // and the signal re-raised, so the process dies the normal way and the .ips is written.
    if index >= 0, let prevs = cgPrevActions {
        let prev = prevs[index]
        let raw = unsafeBitCast(prev.__sigaction_u.__sa_handler, to: Int.self)
        if raw != 0 && raw != 1 { // not SIG_DFL, not SIG_IGN
            if prev.sa_flags & SA_SIGINFO != 0 {
                prev.__sigaction_u.__sa_sigaction(sig, info, ctx)
            } else {
                prev.__sigaction_u.__sa_handler(sig)
            }
            return
        }
    }
    if let dfl = cgDefaultAction { sigaction(sig, dfl, nil) }
    raise(sig)
}

// MARK: - CrashGuard

enum CrashGuard {
    /// The previous run's report, when it is fresh enough to show.
    struct Notice {
        let url: URL
        let at: Date
        let reason: String
        let relaunched: Bool
    }

    /// How old a report may be and still be shown at launch (and the relaunch window).
    static let freshSeconds: TimeInterval = TimeInterval(cgWindowSeconds)

    private static let signals: [(Int32, String)] = [
        (SIGABRT, "SIGABRT"), (SIGSEGV, "SIGSEGV"), (SIGBUS, "SIGBUS"), (SIGILL, "SIGILL"), (SIGFPE, "SIGFPE"), (SIGTRAP, "SIGTRAP"),
    ]

    /// Install once, as early as the process allows. Returns the fresh report of the run
    /// before this one, if there is one. `stateDir` is `~/.jarhead` (or JARHEAD_STATE_DIR).
    @discardableResult
    static func install(stateDir: URL, appVersion: String) -> Notice? {
        guard !cgInstalled else { return nil }
        let dir = stateDir.appendingPathComponent("crashes", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let notice = latestNotice(in: dir)

        // Everything the handlers touch, allocated now.
        cgScratch = UnsafeMutablePointer<CChar>.allocate(capacity: 128)
        cgNameBuf = UnsafeMutablePointer<CChar>.allocate(capacity: 96)
        cgRing = UnsafeMutablePointer<CChar>.allocate(capacity: cgSlots * cgSlotBytes)
        cgRing?.initialize(repeating: 0, count: cgSlots * cgSlotBytes)
        cgRingLock = UnsafeMutablePointer<os_unfair_lock>.allocate(capacity: 1)
        cgRingLock?.initialize(to: os_unfair_lock())
        cgFrames = UnsafeMutablePointer<UnsafeMutableRawPointer?>.allocate(capacity: cgFrameCap)
        cgFrames?.initialize(repeating: nil, count: cgFrameCap)
        cgExcName = UnsafeMutablePointer<CChar>.allocate(capacity: cgExcNameBytes)
        cgExcName?.initialize(repeating: 0, count: cgExcNameBytes)
        cgExcReason = UnsafeMutablePointer<CChar>.allocate(capacity: cgExcReasonBytes)
        cgExcReason?.initialize(repeating: 0, count: cgExcReasonBytes)
        cgVersion = strdup(appVersion)
        cgCommit = UnsafeMutablePointer<CChar>.allocate(capacity: cgCommitBytes)
        cgCommit?.initialize(repeating: 0, count: cgCommitBytes)
        strlcpy(cgCommit!, "unknown", cgCommitBytes)
        cgLabels = UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>.allocate(capacity: L.allCases.count)
        for l in L.allCases { cgLabels![l.rawValue] = strdup(l.text) }
        cgPhaseCount = Phase.allCases.count
        cgPhaseNames = UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>.allocate(capacity: cgPhaseCount)
        for (i, p) in Phase.allCases.enumerated() { cgPhaseNames![i] = strdup(p.rawValue) }
        cgSignalCount = signals.count
        cgSignals = UnsafeMutablePointer<Int32>.allocate(capacity: signals.count)
        cgSignalNames = UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>.allocate(capacity: signals.count)
        for (i, s) in signals.enumerated() {
            cgSignals![i] = s.0
            cgSignalNames![i] = strdup(s.1)
        }
        cgLaunchEpoch = Int(time(nil))
        cgTzOffset = TimeZone.current.secondsFromGMT()
        cgPhase = 0
        cgRelaunchWanted = ProcessInfo.processInfo.environment["JARHEAD_NO_RELAUNCH"] != "1"

        // The crash files of the last ten minutes are the relaunch counter.
        cgRecentTimes = UnsafeMutablePointer<Int>.allocate(capacity: cgRecentCap)
        cgRecentTimes?.initialize(repeating: 0, count: cgRecentCap)
        let recent = reportTimes(in: dir).filter { Date().timeIntervalSince($0) < freshSeconds }.suffix(cgRecentCap)
        for (i, t) in recent.enumerated() { cgRecentTimes![i] = Int(t.timeIntervalSince1970) }
        cgRecentCount = recent.count

        // The directory, pre-opened: the handler only needs openat(2).
        cgDirFd = open(dir.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC)

        prepareRelaunch()

        // Signals: an alternate stack for the main thread (a stack overflow there still
        // reports), SA_SIGINFO for the fault address, the previous actions kept for chaining.
        var alt = stack_t()
        alt.ss_size = 256 * 1024
        alt.ss_sp = malloc(alt.ss_size)
        alt.ss_flags = 0
        if alt.ss_sp != nil { sigaltstack(&alt, nil) }
        cgDefaultAction = UnsafeMutablePointer<sigaction>.allocate(capacity: 1)
        cgDefaultAction?.initialize(to: sigaction())
        cgDefaultAction?.pointee.__sigaction_u.__sa_handler = SIG_DFL
        cgPrevActions = UnsafeMutablePointer<sigaction>.allocate(capacity: signals.count)
        cgPrevActions?.initialize(repeating: sigaction(), count: signals.count)
        for (i, s) in signals.enumerated() {
            var sa = sigaction()
            sa.__sigaction_u.__sa_sigaction = cgSignalHandler
            sa.sa_flags = SA_SIGINFO | SA_ONSTACK
            sigemptyset(&sa.sa_mask)
            sigaction(s.0, &sa, cgPrevActions! + i)
        }

        cgPrevExceptionHandler = NSGetUncaughtExceptionHandler()
        NSSetUncaughtExceptionHandler(cgExceptionHandler)
        cgInstalled = true
        remember("crash guard on: reports go to \(dir.path)\(notice.map { _ in "; the previous run crashed" } ?? "")")
        return notice
    }

    // MARK: what the handlers report

    /// The phase, as the app last published it.
    static func setPhase(_ phase: Phase) {
        cgPhase = Phase.allCases.firstIndex(of: phase) ?? 0
    }

    /// The daemon this app spawned (nil once it has exited or when attached to someone else's).
    static func setDaemonPid(_ pid: Int32?) {
        cgDaemonPid = pid ?? 0
    }

    /// The commit the running tree is at (the app reads `.git/HEAD` once the repo is located).
    static func setCommit(_ commit: String) {
        guard let c = cgCommit else { return }
        strlcpy(c, commit.isEmpty ? "unknown" : commit, cgCommitBytes)
    }

    /// One line into the ring (and the unified log). The app's own log() — every site that
    /// used to NSLog goes through here so the last 40 lines land in the report.
    static func log(_ line: String) {
        NSLog("%@", line)
        remember(line)
    }

    /// Into the ring only (for lines that already reach a log, like daemon.log's `[app]` lines).
    static func remember(_ line: String) {
        guard let ring = cgRing, let lock = cgRingLock else { return }
        var t = time(nil)
        var parts = tm()
        localtime_r(&t, &parts)
        let stamped = String(format: "%02d:%02d:%02d ", parts.tm_hour, parts.tm_min, parts.tm_sec) + line.replacingOccurrences(of: "\n", with: " ⏎ ")
        os_unfair_lock_lock(lock)
        let slot = ring + cgRingHead * cgSlotBytes
        strlcpy(slot, stamped, cgSlotBytes)
        cgRingHead = (cgRingHead + 1) % cgSlots
        cgRingCount = min(cgRingCount + 1, cgSlots)
        os_unfair_lock_unlock(lock)
    }

    // MARK: the crash test knob

    /// `JARHEAD_CRASH_TEST=exception|signal`: crash on purpose two seconds in, so the report,
    /// the relaunch and the notice can be seen on a dev build. Anything else is ignored.
    static func armTestCrash(_ kind: String) {
        switch kind {
        case "exception":
            log("JARHEAD_CRASH_TEST=exception: raising an uncaught NSException in 2 s")
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                NSException(name: .internalInconsistencyException, reason: "JARHEAD_CRASH_TEST: a deliberate uncaught exception", userInfo: nil).raise()
            }
        case "signal":
            log("JARHEAD_CRASH_TEST=signal: faulting on a background queue in 2 s")
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 2) {
                // A real fault, not raise(): the kernel path is what the handler must survive.
                let bad = UnsafeMutablePointer<Int>(bitPattern: 0x10)!
                bad.pointee = 1
            }
        default:
            break
        }
    }

    // MARK: reports on disk

    /// The newest report in `dir` when it is younger than `freshSeconds`, parsed for the rail.
    static func latestNotice(in dir: URL, now: Date = Date()) -> Notice? {
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: dir.path) else { return nil }
        var newest: (URL, Date)?
        for name in names where name.hasSuffix(".txt") {
            let url = dir.appendingPathComponent(name)
            guard let attrs = try? fm.attributesOfItem(atPath: url.path), let m = attrs[.modificationDate] as? Date else { continue }
            if newest == nil || m > newest!.1 { newest = (url, m) }
        }
        guard let found = newest, now.timeIntervalSince(found.1) < freshSeconds, now.timeIntervalSince(found.1) > -60 else { return nil }
        return parse(url: found.0, at: found.1)
    }

    /// The report's `reason:` and `relaunch:` lines. The reason is one line, trimmed for a rail.
    static func parse(url: URL, at: Date) -> Notice? {
        guard let data = readHead(url, limit: 16 * 1024), let text = String(data: data, encoding: .utf8) else { return nil }
        // An exception the process outlived is a report, not a crash: nothing to announce.
        if text.contains("\nsurvived:") { return nil }
        var reason = "unknown"
        var relaunched = false
        for line in text.split(separator: "\n", omittingEmptySubsequences: false).prefix(40) {
            if line.hasPrefix("reason: ") {
                reason = String(line.dropFirst("reason: ".count)).trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("relaunch: ") {
                relaunched = line.hasPrefix("relaunch: yes")
            }
        }
        return Notice(url: url, at: at, reason: reason, relaunched: relaunched)
    }

    private static func readHead(_ url: URL, limit: Int) -> Data? {
        guard let h = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? h.close() }
        return try? h.read(upToCount: limit)
    }

    private static func reportTimes(in dir: URL) -> [Date] {
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: dir.path) else { return [] }
        return names.filter { $0.hasSuffix(".txt") }
            .compactMap { (try? fm.attributesOfItem(atPath: dir.appendingPathComponent($0).path))?[.modificationDate] as? Date }
            .sorted()
    }

    // MARK: the relauncher

    /// argv, envp and spawn attributes for the detached relauncher, built now so the
    /// handler only calls posix_spawn(2). `/bin/sh` waits for this pid to be gone — up to
    /// 60 s: the crash reporter holds an aborting process for seconds while it writes the
    /// .ips — then `open -a` the bundle, or exec's the dev binary when not running from
    /// one. A pid still alive after the wait (AppKit swallowed the exception) means no launch.
    private static func prepareRelaunch() {
        let bundle = Bundle.main.bundleURL
        let fromBundle = bundle.pathExtension == "app"
        let exe = Bundle.main.executableURL?.path ?? CommandLine.arguments.first ?? ""
        func quoted(_ s: String) -> String { "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }
        let launch = fromBundle ? "exec /usr/bin/open -a \(quoted(bundle.path))" : "exec \(quoted(exe))"
        let pid = ProcessInfo.processInfo.processIdentifier
        let script = "n=0; while kill -0 \(pid) 2>/dev/null && [ $n -lt 240 ]; do sleep 0.25; n=$((n+1)); done; kill -0 \(pid) 2>/dev/null && exit 0; sleep 0.5; \(launch)"
        let args = ["/bin/sh", "-c", script]
        cgArgv = UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>.allocate(capacity: args.count + 1)
        for (i, a) in args.enumerated() { cgArgv![i] = strdup(a) }
        cgArgv![args.count] = nil
        // The environment minus the crash knob, so a relaunched dev build does not crash again on purpose.
        let env = ProcessInfo.processInfo.environment.filter { $0.key != "JARHEAD_CRASH_TEST" }.map { "\($0.key)=\($0.value)" }
        cgEnvp = UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>.allocate(capacity: env.count + 1)
        for (i, e) in env.enumerated() { cgEnvp![i] = strdup(e) }
        cgEnvp![env.count] = nil
        cgSpawnPid = UnsafeMutablePointer<pid_t>.allocate(capacity: 1)
        cgSpawnPid?.initialize(to: 0)

        cgSpawnAttr = UnsafeMutablePointer<posix_spawnattr_t?>.allocate(capacity: 1)
        cgSpawnAttr?.initialize(to: nil)
        posix_spawnattr_init(cgSpawnAttr!)
        // Its own session (survives our death), every fd but the three below closed, the
        // signal mask cleared and dispositions reset (main.swift ignores SIGTERM/SIGINT).
        let flags = POSIX_SPAWN_SETSID | POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF
        posix_spawnattr_setflags(cgSpawnAttr!, Int16(truncatingIfNeeded: flags))
        var none = sigset_t()
        sigemptyset(&none)
        posix_spawnattr_setsigmask(cgSpawnAttr!, &none)
        var all = sigset_t()
        sigfillset(&all)
        posix_spawnattr_setsigdefault(cgSpawnAttr!, &all)

        cgSpawnActions = UnsafeMutablePointer<posix_spawn_file_actions_t?>.allocate(capacity: 1)
        cgSpawnActions?.initialize(to: nil)
        posix_spawn_file_actions_init(cgSpawnActions!)
        posix_spawn_file_actions_addopen(cgSpawnActions!, 0, "/dev/null", O_RDONLY, 0)
        posix_spawn_file_actions_addopen(cgSpawnActions!, 1, "/dev/null", O_WRONLY, 0)
        posix_spawn_file_actions_addopen(cgSpawnActions!, 2, "/dev/null", O_WRONLY, 0)
    }
}

/// The app's log line: the unified log and the crash guard's ring, in one call.
func appLog(_ line: String) {
    CrashGuard.log(line)
}
