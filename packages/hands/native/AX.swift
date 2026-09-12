import Foundation
import AppKit
import ApplicationServices

// MARK: - Accessibility (focused element, element under a point).
//
// AX frames are already global top-left-origin screen points, the same convention as CGEvent.

let accessibilityHint =
    "Accessibility is not granted. Grant it to the app that launched this helper "
    + "(the terminal or Jarhead.app) in System Settings > Privacy & Security > Accessibility."

let systemWideElement: AXUIElement = {
    let element = AXUIElementCreateSystemWide()
    // Bound every call so an unresponsive app cannot hang the worker.
    AXUIElementSetMessagingTimeout(element, 2.0)
    return element
}()

func axAttribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}

func axString(_ element: AXUIElement, _ name: String, limit: Int? = nil) -> String? {
    guard let value = axAttribute(element, name) else { return nil }
    var string: String?
    if let s = value as? String {
        string = s
    } else if let attributed = value as? NSAttributedString {
        string = attributed.string
    } else if let number = value as? NSNumber {
        string = isJSONBool(number) ? (number.boolValue ? "true" : "false") : number.stringValue
    } else if let url = value as? URL {
        string = url.absoluteString
    }
    guard let result = string else { return nil }
    if let limit { return truncated(result, to: limit) }
    return result
}

func axFrame(_ element: AXUIElement) -> CGRect? {
    guard let positionRef = axAttribute(element, kAXPositionAttribute),
          CFGetTypeID(positionRef) == AXValueGetTypeID(),
          let sizeRef = axAttribute(element, kAXSizeAttribute),
          CFGetTypeID(sizeRef) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(positionRef as! AXValue, .cgPoint, &point),
          AXValueGetValue(sizeRef as! AXValue, .cgSize, &size) else { return nil }
    return CGRect(origin: point, size: size)
}

func axAppName(_ element: AXUIElement) -> String? {
    var pid: pid_t = 0
    guard AXUIElementGetPid(element, &pid) == .success else { return nil }
    return NSRunningApplication(processIdentifier: pid)?.localizedName
}

func requireAccessibility() throws {
    guard AXIsProcessTrusted() else { throw HandsError.permissionDenied(accessibilityHint) }
}

func axElement(from value: CFTypeRef?) -> AXUIElement? {
    guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    let element = value as! AXUIElement
    AXUIElementSetMessagingTimeout(element, 2.0)
    return element
}

func axErrorName(_ error: AXError) -> String {
    switch error {
    case .success: return "success"
    case .apiDisabled: return "apiDisabled"
    case .noValue: return "noValue"
    case .attributeUnsupported: return "attributeUnsupported"
    case .cannotComplete: return "cannotComplete"
    case .invalidUIElement: return "invalidUIElement"
    case .notImplemented: return "notImplemented"
    case .failure: return "failure"
    default: return "AXError(\(error.rawValue))"
    }
}

/// The focused element system-wide, or the AX error that stood in the way.
private func focusedElement() -> (AXUIElement?, AXError) {
    var focusedRef: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(systemWideElement, kAXFocusedUIElementAttribute as CFString, &focusedRef)
    return (error == .success ? axElement(from: focusedRef) : nil, error)
}

/// Chromium-based browsers and Electron apps: their web content is exposed to AX clients
/// only once asked (`AXManualAccessibility`, as AXTree.swift sets for the tree walk), and
/// until then the focused element reads as nothing, or as a bare element with no role.
/// Names for the Chrome family; the Electron framework on disk for everything else
/// (Slack, Discord, Notion, VS Code, Cursor, Figma, Linear, Obsidian …).
private let chromiumNames: Set<String> = ["google chrome", "google chrome canary", "chromium", "brave browser", "microsoft edge", "vivaldi", "arc", "opera", "orion", "dia", "zen"]

func isChromiumOrElectron(_ app: NSRunningApplication) -> Bool {
    if let name = app.localizedName?.lowercased(), chromiumNames.contains(name) { return true }
    if let id = app.bundleIdentifier?.lowercased(), id.contains("chrom") || id.contains("electron") { return true }
    guard let url = app.bundleURL else { return false }
    let frameworks = url.appendingPathComponent("Contents/Frameworks", isDirectory: true)
    return FileManager.default.fileExists(atPath: frameworks.appendingPathComponent("Electron Framework.framework").path)
        || FileManager.default.fileExists(atPath: frameworks.appendingPathComponent("Chromium Embedded Framework.framework").path)
}

/// The processes whose web accessibility (`AXManualAccessibility`) this helper has switched
/// on already. The switch is per process lifetime, so it is asked for once: the type / key
/// gate reads the focused element before every keystroke, and a 60 ms wait for a switch
/// that already landed would tax every key into a Chromium app whose focus reads as nothing.
private let webAccessibilityLock = NSLock()
private var webAccessibilityOn: Set<pid_t> = []

/// Switch a Chromium / Electron process's web accessibility on. Returns false when it was on
/// already (nothing to wait for).
@discardableResult
func enableWebAccessibility(pid: pid_t, app: AXUIElement) -> Bool {
    webAccessibilityLock.lock()
    let first = webAccessibilityOn.insert(pid).inserted
    webAccessibilityLock.unlock()
    AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    return first
}

func opFocusedText() throws -> JSONObject {
    try requireAccessibility()
    var (element, error) = focusedElement()
    if error == .apiDisabled { throw HandsError.permissionDenied(accessibilityHint) }
    var role = element.flatMap { axString($0, kAXRoleAttribute) }
    var retried = false
    if element == nil || role == nil {
        // Nothing, or a shell of an element: for a Chromium / Electron front app, switch its
        // web accessibility on and look once more (the switch lands asynchronously; ~60 ms).
        // Switched on already: nothing to wait for — one quick look at the app's own focus.
        if let front = onMain({ NSWorkspace.shared.frontmostApplication }), isChromiumOrElectron(front) {
            let app = AXUIElementCreateApplication(front.processIdentifier)
            AXUIElementSetMessagingTimeout(app, 1.0)
            if enableWebAccessibility(pid: front.processIdentifier, app: app) { sleepMs(60) }
            retried = true
            // The app element's own focused element first (system-wide can lag it), then system-wide.
            var appFocused: CFTypeRef?
            if AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute as CFString, &appFocused) == .success, let e = axElement(from: appFocused), axString(e, kAXRoleAttribute) != nil {
                element = e
            } else {
                let again = focusedElement()
                if let e = again.0 { element = e } else { error = again.1 }
            }
            role = element.flatMap { axString($0, kAXRoleAttribute) }
            debugLog("focused_text: retried after AXManualAccessibility on \(front.localizedName ?? "?"): \(role ?? "still nothing")")
        }
    }
    guard let element else {
        throw HandsError.notFound("no focused UI element (\(axErrorName(error)))\(retried ? " even after enabling web accessibility on the front app" : "")")
    }

    let subrole = axString(element, kAXSubroleAttribute)
    let secure = role == kAXTextFieldRole && subrole == kAXSecureTextFieldSubrole
    let frame = axFrame(element)
    var out: JSONObject = [
        "role": orNull(role),
        "subrole": orNull(subrole),
        "title": orNull(axString(element, kAXTitleAttribute)),
        // Never read the contents of a password field.
        "value": secure ? NSNull() : orNull(axString(element, kAXValueAttribute, limit: 4000)),
        "selectedText": secure ? NSNull() : orNull(axString(element, kAXSelectedTextAttribute, limit: 4000)),
        "secure": secure,
        "app": orNull(axAppName(element)),
        "frame": frame.map { rectJSON($0) } ?? NSNull(),
    ]
    if retried { out["retried"] = true }
    return out
}

func opElementAt(_ params: Params) throws -> JSONObject {
    let point = try params.requireXY()
    try requireAccessibility()
    var elementRef: AXUIElement?
    let error = AXUIElementCopyElementAtPosition(systemWideElement, Float(point.x), Float(point.y), &elementRef)
    if error == .apiDisabled { throw HandsError.permissionDenied(accessibilityHint) }
    guard error == .success, let element = elementRef else {
        throw HandsError.notFound("no accessibility element at (\(point.x), \(point.y)) (\(axErrorName(error)))")
    }
    AXUIElementSetMessagingTimeout(element, 2.0)
    let frame = axFrame(element)
    return [
        "role": orNull(axString(element, kAXRoleAttribute)),
        "subrole": orNull(axString(element, kAXSubroleAttribute)),
        "title": orNull(axString(element, kAXTitleAttribute)),
        "description": orNull(axString(element, kAXDescriptionAttribute)),
        "value": orNull(axString(element, kAXValueAttribute, limit: 400)),
        "frame": frame.map { rectJSON($0) } ?? NSNull(),
        "app": orNull(axAppName(element)),
    ]
}
