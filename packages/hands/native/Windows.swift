import Foundation
import AppKit
import CoreGraphics

// MARK: - Windows and applications (CGWindowList + NSWorkspace).

struct WindowInfo {
    let windowId: Int
    let pid: Int
    let app: String
    let title: String
    let bounds: CGRect
    let layer: Int

    var json: JSONObject {
        return [
            "windowId": windowId,
            "pid": pid,
            "app": app,
            "title": title,
            "x": Double(bounds.origin.x),
            "y": Double(bounds.origin.y),
            "w": Double(bounds.width),
            "h": Double(bounds.height),
            "layer": layer,
            "onScreen": true,
        ]
    }
}

/// On-screen windows, front to back. Titles (kCGWindowName) are only populated when the
/// responsible process has Screen Recording permission; otherwise they are "".
func windowInfos(allLayers: Bool) -> [WindowInfo] {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else { return [] }
    var result: [WindowInfo] = []
    for entry in list {
        let layer = (entry[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
        if !allLayers && layer != 0 { continue }
        guard let windowId = (entry[kCGWindowNumber as String] as? NSNumber)?.intValue else { continue }
        let pid = (entry[kCGWindowOwnerPID as String] as? NSNumber)?.intValue ?? 0
        var bounds = CGRect.zero
        if let dict = entry[kCGWindowBounds as String] as? NSDictionary,
           let rect = CGRect(dictionaryRepresentation: dict as CFDictionary) {
            bounds = rect
        }
        result.append(WindowInfo(
            windowId: windowId,
            pid: pid,
            app: entry[kCGWindowOwnerName as String] as? String ?? "",
            title: entry[kCGWindowName as String] as? String ?? "",
            bounds: bounds,
            layer: layer
        ))
    }
    return result
}

func opWindows(_ params: Params) throws -> JSONObject {
    let allLayers = try params.bool("allLayers") ?? false
    return ["windows": windowInfos(allLayers: allLayers).map { $0.json }]
}

func opFrontmost() throws -> JSONObject {
    let app = onMain { NSWorkspace.shared.frontmostApplication }
    guard let app else { throw HandsError.notFound("no frontmost application") }
    let pid = Int(app.processIdentifier)
    let window = windowInfos(allLayers: false).first { $0.pid == pid }
    var windowJSON: Any = NSNull()
    if let window {
        windowJSON = [
            "title": window.title,
            "x": Double(window.bounds.origin.x),
            "y": Double(window.bounds.origin.y),
            "w": Double(window.bounds.width),
            "h": Double(window.bounds.height),
            "windowId": window.windowId,
        ] as JSONObject
    }
    return [
        "app": orNull(app.localizedName),
        "bundleId": orNull(app.bundleIdentifier),
        "pid": pid,
        "window": windowJSON,
    ]
}

// MARK: - expectFront: the app in front, read right before an event goes out

/// The frontmost app's pid and name now (a main-thread read; nil when nothing is in front).
func frontmostNow() -> (pid: pid_t, name: String)? {
    guard let app = onMain({ NSWorkspace.shared.frontmostApplication }) else { return nil }
    return (app.processIdentifier, app.localizedName ?? "an app")
}

/// `expectFront: {pid}` on an acting op: the caller judged the action against the app it saw in
/// front; if another one is in front now, nothing is posted. Read on the worker queue immediately
/// before the first CGEvent.post — the gap between the caller's probe and the post is where a
/// Kevin's click or a dialog moves the focus, and only this process can close it.
func requireFront(_ params: Params) throws {
    guard let expect = try params.object("expectFront") else { return }
    let pid = try expect.requireInt("pid")
    try requireFront(pid: pid_t(truncatingIfNeeded: pid))
}

func requireFront(pid: pid_t) throws {
    let front = frontmostNow()
    if let front, front.pid == pid { return }
    let name = front.map { "\($0.name) (pid \($0.pid))" } ?? "nothing"
    throw HandsError.focusMoved("the front app is \(name), not pid \(pid); nothing was posted")
}

// MARK: - open_app / focus_app

private let applicationDirectories: [String] = {
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    return [
        "/Applications",
        "/Applications/Utilities",
        "\(home)/Applications",
        "/System/Applications",
        "/System/Applications/Utilities",
        "/System/Library/CoreServices",
        "/System/Library/CoreServices/Applications",
    ]
}()

/// Last resort: ask Spotlight for an application bundle with this display name (3 s budget).
private func spotlightApplication(named name: String) -> URL? {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/mdfind")
    let escaped = name.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
    process.arguments = ["kMDItemContentType == 'com.apple.application-bundle' && kMDItemDisplayName == \"\(escaped)\"c"]
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice
    let exited = DispatchGroup()
    exited.enter()
    process.terminationHandler = { _ in exited.leave() }
    do { try process.run() } catch { return nil }

    // Drain the pipe on another thread so a hung mdfind cannot block past the deadline.
    let output = ResultBox<Data>()
    let drained = DispatchGroup()
    drained.enter()
    DispatchQueue.global(qos: .utility).async {
        output.value = .success(pipe.fileHandleForReading.readDataToEndOfFile())
        drained.leave()
    }
    if exited.wait(timeout: .now() + .seconds(3)) == .timedOut {
        process.terminate()
        return nil
    }
    guard drained.wait(timeout: .now() + .seconds(1)) == .success,
          case .success(let data)? = output.value,
          let text = String(data: data, encoding: .utf8) else { return nil }
    for line in text.split(separator: "\n") {
        let path = String(line)
        if path.lowercased().hasSuffix(".app") { return URL(fileURLWithPath: path) }
    }
    return nil
}

func resolveApplicationURL(name: String?, bundleId: String?, path: String?) -> URL? {
    if let path, !path.isEmpty {
        let expanded = (path as NSString).expandingTildeInPath
        return FileManager.default.fileExists(atPath: expanded) ? URL(fileURLWithPath: expanded) : nil
    }
    if let bundleId, !bundleId.isEmpty {
        return NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId)
    }
    guard let rawName = name?.trimmingCharacters(in: .whitespacesAndNewlines), !rawName.isEmpty else { return nil }

    if rawName.hasPrefix("/") || rawName.hasPrefix("~") {
        let expanded = (rawName as NSString).expandingTildeInPath
        return FileManager.default.fileExists(atPath: expanded) ? URL(fileURLWithPath: expanded) : nil
    }
    let base = rawName.lowercased().hasSuffix(".app") ? String(rawName.dropLast(4)) : rawName
    let wanted = base.lowercased()

    // 1. A running app with that name (covers apps installed anywhere).
    let running = onMain { NSWorkspace.shared.runningApplications }
    if let app = running.first(where: { $0.localizedName?.lowercased() == wanted }), let url = app.bundleURL {
        return url
    }
    // 2. The name is actually a bundle identifier.
    if base.contains("."), let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: base) {
        return url
    }
    // 3. <name>.app in the standard application folders (case-insensitive).
    for dir in applicationDirectories {
        guard let items = try? FileManager.default.contentsOfDirectory(atPath: dir) else { continue }
        if let match = items.first(where: { $0.lowercased() == wanted + ".app" }) {
            return URL(fileURLWithPath: dir).appendingPathComponent(match)
        }
    }
    // 4. Spotlight.
    return spotlightApplication(named: base)
}

func launchApplication(at url: URL, activate: Bool) throws -> NSRunningApplication {
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = activate
    let box = ResultBox<NSRunningApplication>()
    let semaphore = DispatchSemaphore(value: 0)
    NSWorkspace.shared.openApplication(at: url, configuration: configuration) { app, error in
        if let app {
            box.value = .success(app)
        } else {
            box.value = .failure(error ?? HandsError.internalError("launch failed"))
        }
        semaphore.signal()
    }
    if semaphore.wait(timeout: .now() + .seconds(30)) == .timedOut {
        throw HandsError.internalError("timed out launching \(url.lastPathComponent)")
    }
    guard let result = box.value else { throw HandsError.internalError("launch produced no result") }
    do {
        return try result.get()
    } catch let error as HandsError {
        throw error
    } catch {
        throw HandsError.internalError("launch failed: \((error as NSError).localizedDescription)")
    }
}

func appJSON(_ app: NSRunningApplication) -> JSONObject {
    return [
        "pid": Int(app.processIdentifier),
        "bundleId": orNull(app.bundleIdentifier),
        "app": orNull(app.localizedName),
    ]
}

func opOpenApp(_ params: Params) throws -> JSONObject {
    let name = try params.string("name")
    let bundleId = try params.string("bundleId")
    let path = try params.string("path")
    guard name != nil || bundleId != nil || path != nil else {
        throw HandsError.badRequest("one of 'name', 'bundleId' or 'path' is required")
    }
    let activate = try params.bool("activate") ?? true
    guard let url = resolveApplicationURL(name: name, bundleId: bundleId, path: path) else {
        throw HandsError.notFound("could not find application \(name ?? bundleId ?? path ?? "")")
    }
    let app = try launchApplication(at: url, activate: activate)
    var result = appJSON(app)
    result["path"] = url.path
    return result
}

func opFocusApp(_ params: Params) throws -> JSONObject {
    let pid = try params.int("pid")
    let name = try params.string("name")
    guard pid != nil || name != nil else { throw HandsError.badRequest("'pid' or 'name' is required") }

    var target: NSRunningApplication?
    if let pid {
        target = NSRunningApplication(processIdentifier: pid_t(truncatingIfNeeded: pid))
        guard target != nil else { throw HandsError.notFound("no running application with pid \(pid)") }
    } else if let name {
        let wanted = name.lowercased()
        let running = onMain { NSWorkspace.shared.runningApplications }
        target = running.first { $0.localizedName?.lowercased() == wanted || $0.bundleIdentifier?.lowercased() == wanted }
        guard target != nil else { throw HandsError.notFound("no running application named \(name)") }
    }
    guard let app = target else { throw HandsError.notFound("application not found") }

    var activated = onMain { app.activate(options: [.activateAllWindows]) }
    if !activated, let url = app.bundleURL {
        // Cooperative activation was refused; go through Launch Services instead.
        activated = (try? launchApplication(at: url, activate: true)) != nil
    }
    var result = appJSON(app)
    result["activated"] = activated
    return result
}
