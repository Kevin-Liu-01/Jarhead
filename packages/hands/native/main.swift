import Foundation

// A Stop that arrives before this process's first type op must not be lost: the handler installs now.
_ = typeCancelHandlerInstalled
import AppKit
import IOKit.hid

// A helper inside Jarhead.app inherits the app's Info.plist (LSUIElement false), so LaunchServices
// would register it as a Foreground app: a second "Jarhead" Dock tile per helper process. Say what
// we are before AppKit checks us in. `.prohibited`, not `.accessory`: no UI, no windows. CGEvent
// posting, AX reads, NSPasteboard, NSRunningApplication.activate and NSWorkspace.openApplication
// all keep working from a prohibited process. Never an embedded __info_plist with a bundle id:
// it would change the nested code's ad-hoc signing identifier that the --deep verify expects.
_ = NSApplication.shared
NSApp.setActivationPolicy(.prohibited)

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
    case "user_idle": return opUserIdle()
    case "wait": return try opWait(params)
    default: throw HandsError.badRequest("unknown op '\(op)'")
    }
}

// The grants a helper process can read for itself. TCC keys every one of them on
// the responsible app (Jarhead.app when the daemon spawned us; the terminal when a
// shell did), so these answers are the app's when run under it. None of the four
// reads shows a dialog: AXIsProcessTrusted, CGPreflightScreenCaptureAccess and
// IOHIDCheckAccess only check, and Full Disk Access has no prompt at all — the
// probe below opens something only that grant unlocks and looks at errno.
func permissionsJSON() -> JSONObject {
    return [
        "accessibility": AXIsProcessTrusted(),
        "screenRecording": CGPreflightScreenCaptureAccess(),
        "inputMonitoring": IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) == kIOHIDAccessTypeGranted,
        "fullDiskAccess": fullDiskAccessGranted(),
    ]
}

// Full Disk Access is the one permission with neither API nor prompt: the only read
// is to try. The user TCC database and ~/Library/Safari exist on every account and
// are FDA-only (no folder prompt covers them); opening one for reading succeeds with
// the grant and fails with EPERM without it. Nothing is read, the descriptor is
// closed at once, and a denied open never shows a dialog or a Settings row.
func fullDiskAccessGranted() -> Bool {
    let home = NSHomeDirectory()
    let files = [
        "\(home)/Library/Application Support/com.apple.TCC/TCC.db",
        "\(home)/Library/Safari/Bookmarks.plist",
        "\(home)/Library/Safari/CloudTabs.db",
    ]
    for path in files {
        let fd = open(path, O_RDONLY)
        if fd >= 0 {
            close(fd)
            return true
        }
    }
    // A folder listing is the same test for accounts whose files above are missing.
    for dir in ["\(home)/Library/Safari", "\(home)/Library/Application Support/com.apple.TCC"] {
        if let handle = opendir(dir) {
            closedir(handle)
            return true
        }
    }
    return false
}

// `jarhead-hands --permissions`: print the grants and exit. A fresh process is the
// only reliable way to read TCC after the user changes it — a running process may
// keep the answer it got at launch (Screen Recording notoriously does). Prints all
// four: accessibility, screenRecording, inputMonitoring, fullDiskAccess.
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

// `prompt: true` asks for one of the two grants a helper process can prompt for from
// here — `which`: "accessibility" or "screenRecording" (the dialogs name the
// responsible app) — one dialog per call: two at once and the second is dismissed
// with the first, so the caller (the engine's prompt queue) asks for the next only
// once this one lands. `which` omitted or "all" asks for the first of the two still
// missing, never both. Input Monitoring's prompt belongs to the app
// (IOHIDRequestAccess from its own process, so the grant lands on the app's global
// key monitors) and Full Disk Access has none; all four are still *read* by every call.
func opPermissions(_ params: Params) throws -> JSONObject {
    if try params.bool("prompt") ?? false {
        let which = try params.string("which") ?? "all"
        switch which {
        case "accessibility": promptAccessibility()
        case "screenRecording": promptScreenRecording()
        case "all":
            if !AXIsProcessTrusted() { promptAccessibility() }
            else if !CGPreflightScreenCaptureAccess() { promptScreenRecording() }
        default: throw HandsError.badRequest("'which' must be accessibility, screenRecording or all")
        }
    }
    return permissionsJSON()
}

func promptAccessibility() {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    _ = AXIsProcessTrustedWithOptions(options)
}

func promptScreenRecording() {
    _ = CGRequestScreenCaptureAccess()
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
