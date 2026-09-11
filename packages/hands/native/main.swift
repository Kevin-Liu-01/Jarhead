import Foundation
import AppKit

// jarhead-hands: resident macOS "hands" helper for Jarhead.
// Newline-delimited JSON over stdin/stdout. One request per line, one response per request,
// processed serially in arrival order. Debug output goes to stderr only (JARHEAD_HANDS_DEBUG=1).

let handsVersion = "2.0.0"

// A dead parent must not kill us with SIGPIPE; the failed write exits cleanly instead.
signal(SIGPIPE, SIG_IGN)

let workerQueue = DispatchQueue(label: "jarhead.hands.worker", qos: .userInteractive)

func dispatch(op: String, params: Params) throws -> JSONObject {
    switch op {
    case "hello": return opHello()
    case "permissions": return try opPermissions(params)
    case "displays": return opDisplays()
    case "screenshot": return try opScreenshot(params)
    case "zoom": return try opZoom(params)
    case "cursor": return opCursor()
    case "move": return try opMove(params)
    case "click": return try opClick(params)
    case "mouse_down": return try opMouseDown(params)
    case "mouse_up": return try opMouseUp(params)
    case "drag": return try opDrag(params)
    case "scroll": return try opScroll(params)
    case "type": return try opType(params)
    case "key": return try opKey(params)
    case "hold_key": return try opHoldKey(params)
    case "frontmost": return try opFrontmost()
    case "windows": return try opWindows(params)
    case "open_app": return try opOpenApp(params)
    case "focus_app": return try opFocusApp(params)
    case "focused_text": return try opFocusedText()
    case "element_at": return try opElementAt(params)
    case "find_element": return try opFindElement(params)
    case "ax_tree": return try opAXTree(params)
    case "browser_js": return try opBrowserJS(params)
    case "browser_tabs": return try opBrowserTabs(params)
    case "browser_navigate": return try opBrowserNavigate(params)
    case "browser_url": return try opBrowserURL(params)
    case "wait": return try opWait(params)
    default: throw HandsError.badRequest("unknown op '\(op)'")
    }
}

func permissionsJSON() -> JSONObject {
    return [
        "accessibility": AXIsProcessTrusted(),
        "screenRecording": CGPreflightScreenCaptureAccess(),
    ]
}

// `jarhead-hands --permissions`: print the grants and exit. A fresh process is the
// only reliable way to read TCC after the user changes it — a running process may
// keep the answer it got at launch (Screen Recording notoriously does).
if CommandLine.arguments.contains("--permissions") {
    let data = (try? JSONSerialization.data(withJSONObject: permissionsJSON())) ?? Data("{}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(0)
}

func opHello() -> JSONObject {
    return [
        "version": handsVersion,
        "pid": Int(getpid()),
        "permissions": permissionsJSON(),
    ]
}

func opPermissions(_ params: Params) throws -> JSONObject {
    if try params.bool("prompt") ?? false {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
        _ = CGRequestScreenCaptureAccess()
    }
    return permissionsJSON()
}

func opWait(_ params: Params) throws -> JSONObject {
    let ms = try params.requireInt("ms")
    guard ms >= 0 else { throw HandsError.badRequest("'ms' must be >= 0") }
    sleepMs(min(ms, 10_000))
    return [:]
}

func handleLine(_ line: String) {
    let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return }

    guard let data = trimmed.data(using: .utf8),
          let parsed = try? JSONSerialization.jsonObject(with: data),
          let object = parsed as? JSONObject else {
        Output.failure(id: NSNull(), error: .badRequest("request must be a JSON object"))
        return
    }

    let id: Any
    if let s = object["id"] as? String {
        id = s
    } else if let n = object["id"] as? NSNumber, !isJSONBool(n) {
        id = n
    } else {
        id = NSNull()
    }

    guard let op = object["op"] as? String else {
        Output.failure(id: id, error: .badRequest("'op' must be a string"))
        return
    }

    let start = DispatchTime.now()
    do {
        let result = try dispatch(op: op, params: Params(dict: object))
        Output.success(id: id, result: result)
    } catch let error as HandsError {
        Output.failure(id: id, error: error)
    } catch {
        Output.failure(id: id, error: .internalError(String(describing: error)))
    }
    debugLog("\(op) \(String(format: "%.1f", elapsedMs(since: start))) ms")
}

// stdin is read on its own thread; every line is queued on the serial worker.
// When stdin closes, the exit is queued behind any in-flight requests.
let readerThread = Thread {
    while let line = readLine(strippingNewline: true) {
        workerQueue.async { handleLine(line) }
    }
    workerQueue.async {
        debugLog("stdin closed; exiting")
        exit(0)
    }
}
readerThread.name = "jarhead.hands.stdin"
readerThread.start()

debugLog("ready pid=\(getpid()) version=\(handsVersion)")

// Invalidate the ScreenCaptureKit cache when displays change (callback is delivered on the main run loop).
installDisplayReconfigurationWatcher()

// AppKit, Accessibility and ScreenCaptureKit all want a live main run loop.
RunLoop.main.run()
