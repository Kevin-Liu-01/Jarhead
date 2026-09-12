import AVFoundation
import Foundation
import JarheadObjC

/// An Objective-C exception caught by the `JarheadObjC` shim (`JHTry`) and surfaced
/// as a Swift error. AVFoundation raises NSExceptions for graph mistakes — a tap
/// installed with a format the node no longer has ("Failed to create tap due to
/// format mismatch"), a connection at the wrong rate, a player started while the
/// engine is down ("required condition is false: _engine->IsRunning()") — and Swift
/// cannot catch them: uncaught, one aborts the whole app. Five of the eight crashes of
/// 2026-09-11 were exactly that, each a moment after the input device changed.
///
/// Every AVFoundation call that can raise goes through `objcTry`; the caught reason is
/// logged and the graph is retried with backoff instead of the process dying.
struct ObjCException: LocalizedError, CustomStringConvertible {
    let name: String
    let reason: String
    /// The first frames of the stack the exception was raised from, one per line.
    let callStack: String

    init(_ error: NSError?) {
        let info = error?.userInfo ?? [:]
        name = info[JHExceptionNameKey] as? String ?? "NSException"
        reason = info[JHExceptionReasonKey] as? String ?? error?.localizedDescription ?? "(no reason)"
        callStack = info[JHExceptionCallStackKey] as? String ?? ""
    }

    var description: String { "\(name): \(reason)" }
    var errorDescription: String? { description }
}

/// Runs `body`; an NSException raised inside it becomes a thrown `ObjCException`.
/// Keep the body to the framework call(s) in question: Swift frames the exception
/// unwinds through run no cleanups, so whatever they held is leaked, not released.
func objcTry(_ body: () -> Void) throws {
    var nsError: NSError?
    let ok = withoutActuallyEscaping(body) { escapable -> Bool in
        JHTry(escapable, &nsError)
    }
    if !ok { throw ObjCException(nsError) }
}

/// `body` may throw a Swift error (`engine.start()`) or raise an NSException; either
/// comes out as a thrown error.
func objcTry(throwing body: () throws -> Void) throws {
    var swiftError: Error?
    try objcTry {
        do { try body() } catch { swiftError = error }
    }
    if let swiftError { throw swiftError }
}

/// Retry delays for an audio graph that would not come up: quick first (an input device
/// is still switching and settles within a second or two), then patient, never giving up
/// while audio is wanted. Attempt 0 waits 0.5 s, then 1, 2, 5, 10, and 30 s from there on.
enum AudioBackoff {
    static let ladder: [TimeInterval] = [0.5, 1, 2, 5, 10, 30]
    static let cap: TimeInterval = 30

    static func delay(attempt: Int) -> TimeInterval {
        ladder[min(max(attempt, 0), ladder.count - 1)]
    }
}

/// A level for the wire or the UI: finite and within 0…1 whatever the arithmetic did.
/// 0/0 over an empty buffer, an infinite sample, a NaN from a broken driver — all 0.
/// (Swift's `min`/`max` pass NaN straight through, so `isFinite` has to come first.)
@inline(__always)
func clampLevel(_ value: Double) -> Double {
    guard value.isFinite else { return 0 }
    return min(1, max(0, value))
}

extension AVAudioFormat {
    /// "48000 Hz ×1 Float32" — what a log line needs to tell two formats apart.
    var brief: String {
        let kind: String
        switch commonFormat {
        case .pcmFormatFloat32: kind = "Float32"
        case .pcmFormatFloat64: kind = "Float64"
        case .pcmFormatInt16: kind = "Int16"
        case .pcmFormatInt32: kind = "Int32"
        case .otherFormat: kind = "other"
        @unknown default: kind = "?"
        }
        let layout = channelCount > 1 ? (isInterleaved ? " interleaved" : " non-interleaved") : ""
        return "\(Int(sampleRate)) Hz ×\(channelCount) \(kind)\(layout)"
    }
}
