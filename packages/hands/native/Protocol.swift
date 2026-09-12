import Foundation
import CoreGraphics

// MARK: - Protocol primitives shared by every op.
//
// Request:  {"id": string, "op": string, ...params}
// Response: {"id": string, "ok": true, "result": {...}}
//        or {"id": string, "ok": false, "error": {"code": string, "message": string}}

typealias JSONObject = [String: Any]

enum HandsError: Error {
    case badRequest(String)
    case permissionDenied(String)
    case captureFailed(String)
    case notFound(String)
    case internalError(String)
    /// Kevin used the keyboard or mouse within the quiet window: nothing was posted (Input.swift).
    case busy(String)
    /// The app in front is not the one the caller judged the action against (`expectFront`): nothing was posted.
    case focusMoved(String)

    var code: String {
        switch self {
        case .badRequest: return "bad_request"
        case .permissionDenied: return "permission_denied"
        case .captureFailed: return "capture_failed"
        case .notFound: return "not_found"
        case .internalError: return "internal"
        case .busy: return "busy"
        case .focusMoved: return "focus_moved"
        }
    }

    var message: String {
        switch self {
        case .badRequest(let m), .permissionDenied(let m), .captureFailed(let m),
             .notFound(let m), .internalError(let m), .busy(let m), .focusMoved(let m):
            return m
        }
    }
}

let debugEnabled = ProcessInfo.processInfo.environment["JARHEAD_HANDS_DEBUG"] == "1"

/// Debug logging goes to stderr only, and only when JARHEAD_HANDS_DEBUG=1.
/// stdout is reserved for JSON responses.
func debugLog(_ message: @autoclosure () -> String) {
    guard debugEnabled else { return }
    let line = "[jarhead-hands] " + message() + "\n"
    if let data = line.data(using: .utf8) {
        try? FileHandle.standardError.write(contentsOf: data)
    }
}

/// JSON booleans arrive from JSONSerialization as NSNumber; tell them apart from real numbers.
func isJSONBool(_ value: Any) -> Bool {
    guard let number = value as? NSNumber else { return false }
    return CFGetTypeID(number) == CFBooleanGetTypeID()
}

/// Defensive, typed access to request parameters. Numbers may arrive as Int or Double.
struct Params {
    let dict: JSONObject

    private func raw(_ key: String) -> Any? {
        guard let value = dict[key], !(value is NSNull) else { return nil }
        return value
    }

    func has(_ key: String) -> Bool { raw(key) != nil }

    func double(_ key: String) throws -> Double? {
        guard let value = raw(key) else { return nil }
        guard let number = value as? NSNumber, !isJSONBool(number) else {
            throw HandsError.badRequest("'\(key)' must be a number")
        }
        let d = number.doubleValue
        guard d.isFinite else { throw HandsError.badRequest("'\(key)' must be a finite number") }
        return d
    }

    func requireDouble(_ key: String) throws -> Double {
        guard let d = try double(key) else { throw HandsError.badRequest("'\(key)' is required") }
        return d
    }

    func int(_ key: String) throws -> Int? {
        guard let d = try double(key) else { return nil }
        guard abs(d) < 9.0e15 else { throw HandsError.badRequest("'\(key)' is out of range") }
        return Int(d.rounded())
    }

    func requireInt(_ key: String) throws -> Int {
        guard let i = try int(key) else { throw HandsError.badRequest("'\(key)' is required") }
        return i
    }

    func bool(_ key: String) throws -> Bool? {
        guard let value = raw(key) else { return nil }
        guard isJSONBool(value), let number = value as? NSNumber else {
            throw HandsError.badRequest("'\(key)' must be a boolean")
        }
        return number.boolValue
    }

    func string(_ key: String) throws -> String? {
        guard let value = raw(key) else { return nil }
        guard let s = value as? String else { throw HandsError.badRequest("'\(key)' must be a string") }
        return s
    }

    func requireString(_ key: String) throws -> String {
        guard let s = try string(key) else { throw HandsError.badRequest("'\(key)' is required") }
        return s
    }

    func stringArray(_ key: String) throws -> [String]? {
        guard let value = raw(key) else { return nil }
        guard let array = value as? [Any] else { throw HandsError.badRequest("'\(key)' must be an array of strings") }
        return try array.map { item -> String in
            guard let s = item as? String else { throw HandsError.badRequest("'\(key)' must be an array of strings") }
            return s
        }
    }

    func intArray(_ key: String) throws -> [Int]? {
        guard let value = raw(key) else { return nil }
        guard let array = value as? [Any] else { throw HandsError.badRequest("'\(key)' must be an array of numbers") }
        return try array.map { item -> Int in
            guard let n = item as? NSNumber, !isJSONBool(n), n.doubleValue.isFinite, abs(n.doubleValue) < 9.0e15 else {
                throw HandsError.badRequest("'\(key)' must be an array of numbers")
            }
            return Int(n.doubleValue.rounded())
        }
    }

    func object(_ key: String) throws -> Params? {
        guard let value = raw(key) else { return nil }
        guard let object = value as? JSONObject else { throw HandsError.badRequest("'\(key)' must be an object") }
        return Params(dict: object)
    }

    /// A required {x, y} object.
    func point(_ key: String) throws -> CGPoint {
        guard let object = try object(key) else { throw HandsError.badRequest("'\(key)' is required") }
        return CGPoint(x: try object.requireDouble("x"), y: try object.requireDouble("y"))
    }

    /// Optional top-level x/y pair. Both or neither.
    func optionalXY() throws -> CGPoint? {
        let x = try double("x")
        let y = try double("y")
        switch (x, y) {
        case (nil, nil):
            return nil
        case let (x?, y?):
            return CGPoint(x: x, y: y)
        default:
            throw HandsError.badRequest("'x' and 'y' must be given together")
        }
    }

    func requireXY() throws -> CGPoint {
        return CGPoint(x: try requireDouble("x"), y: try requireDouble("y"))
    }
}

/// Serialized, flushed writes of one JSON line per response.
enum Output {
    private static let lock = NSLock()

    static func send(_ object: JSONObject) {
        var payload = object
        if !JSONSerialization.isValidJSONObject(payload) {
            payload = [
                "id": object["id"] ?? NSNull(),
                "ok": false,
                "error": ["code": "internal", "message": "response was not JSON-serializable"],
            ]
        }
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.withoutEscapingSlashes]) else {
            return
        }
        var line = data
        line.append(0x0A)
        lock.lock()
        defer { lock.unlock() }
        do {
            // FileHandle writes are unbuffered write(2) calls: the line is flushed as it is written.
            try FileHandle.standardOutput.write(contentsOf: line)
        } catch {
            // stdout is gone (parent died); nothing useful left to do.
            exit(0)
        }
    }

    static func success(id: Any, result: JSONObject) {
        send(["id": id, "ok": true, "result": result])
    }

    static func failure(id: Any, error: HandsError) {
        send(["id": id, "ok": false, "error": ["code": error.code, "message": error.message]])
    }
}

// MARK: - Small helpers

func rectJSON(_ r: CGRect) -> JSONObject {
    return ["x": Double(r.origin.x), "y": Double(r.origin.y), "w": Double(r.size.width), "h": Double(r.size.height)]
}

func pointJSON(_ p: CGPoint) -> JSONObject {
    return ["x": Double(p.x), "y": Double(p.y)]
}

func orNull(_ value: Any?) -> Any {
    return value ?? NSNull()
}

func clamp<T: Comparable>(_ value: T, _ lower: T, _ upper: T) -> T {
    return min(max(value, lower), upper)
}

func sleepMs(_ ms: Int) {
    guard ms > 0 else { return }
    usleep(useconds_t(min(ms, 60_000)) * 1000)
}

func elapsedMs(since start: DispatchTime) -> Double {
    return Double(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1_000_000
}

func truncated(_ s: String, to limit: Int) -> String {
    return s.count > limit ? String(s.prefix(limit)) : s
}

/// Runs an async body to completion from a synchronous (non-cooperative) thread.
/// Used by the serial worker to await ScreenCaptureKit; the main RunLoop keeps spinning.
final class ResultBox<T> {
    var value: Result<T, Error>?
}

func runBlocking<T>(_ body: @escaping () async throws -> T) throws -> T {
    let box = ResultBox<T>()
    let semaphore = DispatchSemaphore(value: 0)
    Task.detached(priority: .userInitiated) {
        do {
            box.value = .success(try await body())
        } catch {
            box.value = .failure(error)
        }
        semaphore.signal()
    }
    semaphore.wait()
    guard let result = box.value else { throw HandsError.internalError("async task produced no result") }
    return try result.get()
}

/// Runs AppKit-touching code on the main thread (the main RunLoop is always running).
func onMain<T>(_ body: () throws -> T) rethrows -> T {
    if Thread.isMainThread { return try body() }
    return try DispatchQueue.main.sync(execute: body)
}
