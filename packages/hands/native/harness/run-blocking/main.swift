import Foundation
import ScreenCaptureKit

// runBlocking (Protocol.swift) is how the serial worker awaits ScreenCaptureKit. Measured 2026-10-06 with
// the Mac locked: a second helper process from the same executable path captured, its callback never came,
// and every op queued behind it (move, cursor, browser_url) timed out until the process was restarted.
// After that loop the surviving process's captures failed SCStreamErrorDomain -3801 with Screen Recording
// granted, which read as "Screen Recording is not granted". A watchdog fails the run if runBlocking never returns.

var passed = 0
var failed = 0
func check(_ ok: Bool, _ name: String) {
    if ok { passed += 1; print("ok - \(name)") } else { failed += 1; print("not ok - \(name)") }
}

DispatchQueue.global().asyncAfter(deadline: .now() + 15) {
    print("not ok - runBlocking returned within 15 s (it is still waiting on a callback that never comes)")
    print("run-blocking: \(passed) passed, \(failed + 1) failed")
    exit(1)
}

/// How many times a body ran (bodies run on a detached task; runBlocking returns after it signals).
final class Calls {
    private let lock = NSLock()
    private var n = 0
    func bump() { lock.lock(); n += 1; lock.unlock() }
    var count: Int { lock.lock(); defer { lock.unlock() }; return n }
}

/// What a call threw: the HandsError's code and message, or the NSError's domain and code.
func outcome<T>(_ call: () throws -> T) -> (value: T?, code: String, message: String, domain: String, nsCode: Int) {
    do {
        return (try call(), "", "", "", 0)
    } catch let e as HandsError {
        return (nil, e.code, e.message, "", 0)
    } catch {
        let ns = error as NSError
        return (nil, "other", "", ns.domain, ns.code)
    }
}

let declined = NSError(domain: SCStreamErrorDomain, code: -3801)

// A body that answers: its value comes back.
check((try? runBlocking { () async throws -> Int in 42 }) == 42, "a body that answers returns its value")

// A body that never answers (a continuation nobody resumes, as a lost XPC callback leaves it): the worker
// gets capture_failed after the bound, not never, and the body is not tried again.
let lost = Calls()
let t0 = Date()
let never = outcome {
    try runBlocking { () async throws -> Int in
        lost.bump()
        return try await withCheckedThrowingContinuation { (_: CheckedContinuation<Int, Error>) in }
    }
}
let took = Date().timeIntervalSince(t0)
check(never.code == "capture_failed", "a body that never answers fails capture_failed (got \(never.code.isEmpty ? "nothing" : never.code))")
check(took >= runBlockingTimeoutSec - 0.2 && took < runBlockingTimeoutSec + 2, String(format: "after the bound, %.1f s (bound %.1f s)", took, runBlockingTimeoutSec))
check(lost.count == 1, "a capture that never answered is not tried again (\(lost.count) tries)")
check(runBlockingTimeoutSec < 6, "the bound is under the client's 6 s screenshot timeout")

// The worker is free again: the next body runs.
check((try? runBlocking { () async throws -> String in "next" }) == "next", "the next op after a lost callback runs")

// -3801 with Screen Recording granted: one more try, and a capture that then works is returned.
let flaky = Calls()
let retried = outcome {
    try runBlocking(granted: { true }) { () async throws -> Int in
        flaky.bump()
        if flaky.count == 1 { throw declined }
        return 7
    }
}
check(retried.value == 7 && flaky.count == 2, "a -3801 with the grant is tried once more and its capture returned (\(flaky.count) tries)")

// -3801 twice with Screen Recording granted: capture_failed, never "not granted", and no third try.
let twice = Calls()
let failedTwice = outcome {
    try runBlocking(granted: { true }) { () async throws -> Int in
        twice.bump()
        throw declined
    }
}
check(failedTwice.code == "capture_failed" && twice.count == 2, "a -3801 twice with the grant fails capture_failed after two tries (got \(failedTwice.code), \(twice.count) tries)")
check(failedTwice.message.contains("-3801") && !failedTwice.message.contains("not granted"), "its message names -3801 and does not say not granted")

// -3801 without the grant: the error itself comes back once, for mapCaptureError to name the missing grant.
let ungranted = Calls()
let refused = outcome {
    try runBlocking(granted: { false }) { () async throws -> Int in
        ungranted.bump()
        throw declined
    }
}
check(refused.code == "other" && refused.domain == SCStreamErrorDomain && refused.nsCode == -3801 && ungranted.count == 1, "a -3801 without the grant is not retried and reaches mapCaptureError as -3801")

// Any other ScreenCaptureKit error is not retried.
let other = Calls()
let otherError = outcome {
    try runBlocking(granted: { true }) { () async throws -> Int in
        other.bump()
        throw NSError(domain: SCStreamErrorDomain, code: -3805)
    }
}
check(otherError.code == "other" && otherError.nsCode == -3805 && other.count == 1, "another ScreenCaptureKit error is not retried")

print("run-blocking: \(passed) passed, \(failed) failed")
exit(failed == 0 ? 0 : 1)
