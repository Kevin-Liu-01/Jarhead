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

// MARK: - The focused element, resolved once for every caller (focused_text, the type chain)

/// What the type chain and `focused_text` need to know about the element with keyboard focus.
struct FocusedTarget {
    let element: AXUIElement
    let role: String?
    let subrole: String?
    let title: String?
    let app: String?
    let frame: CGRect?
    /// A password field: its contents are never read and nothing is ever typed into it from here.
    var secure: Bool { role == kAXTextFieldRole && subrole == kAXSecureTextFieldSubrole }
    /// A field whose value is text a person types: accessibility insertion is tried there first.
    var isTextField: Bool {
        guard let role else { return false }
        return textRoles.contains(role) || subrole == "AXSearchField"
    }
    /// "the "Subject" text field in Mail" — how a result or a failure names the field.
    var describedField: String {
        let kind = (role ?? "field").replacingOccurrences(of: "AX", with: "").replacingOccurrences(of: "([a-z])([A-Z])", with: "$1 $2", options: .regularExpression).lowercased()
        let named = title.map { "the \"\(truncated($0, to: 40))\" \(kind)" } ?? "the \(kind)"
        return app.map { "\(named) in \($0)" } ?? named
    }
}

/// Roles whose value is the text in the field.
let textRoles: Set<String> = [kAXTextFieldRole, kAXTextAreaRole, kAXComboBoxRole, "AXSearchField"]

/// The focused element system-wide, with the Chromium / Electron retry: nothing, or a shell of
/// an element, and the front app is one of those → switch its web accessibility on and look
/// once more (the switch lands asynchronously; ~60 ms the first time, nothing after).
func resolveFocused() -> (target: FocusedTarget?, error: AXError, retried: Bool) {
    var (element, error) = focusedElement()
    var role = element.flatMap { axString($0, kAXRoleAttribute) }
    var retried = false
    if element == nil || role == nil {
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
            debugLog("focused: retried after AXManualAccessibility on \(front.localizedName ?? "?"): \(role ?? "still nothing")")
        }
    }
    guard let element else { return (nil, error, retried) }
    return (FocusedTarget(element: element, role: role, subrole: axString(element, kAXSubroleAttribute), title: axString(element, kAXTitleAttribute),
                          app: axAppName(element), frame: axFrame(element)), error, retried)
}

/// The field's whole value, capped at 1 MB (a text view holding a book is still one attribute read).
func axFullValue(_ element: AXUIElement) -> String? {
    return axString(element, kAXValueAttribute, limit: 1_000_000)
}

/// Whether accessibility insertion can be tried here: the field exposes a value to read back
/// and lets its selected text be set. Both must hold, or a "success" could not be checked.
func axCanInsertText(_ element: AXUIElement) -> Bool {
    var settable: DarwinBoolean = false
    guard AXUIElementIsAttributeSettable(element, kAXSelectedTextAttribute as CFString, &settable) == .success, settable.boolValue else { return false }
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &value) == .success
}

/// Replace the selection (or insert at the caret) through accessibility. True when the app accepted the set.
func axInsertText(_ text: String, into element: AXUIElement) -> Bool {
    return AXUIElementSetAttributeValue(element, kAXSelectedTextAttribute as CFString, text as CFString) == .success
}

/// The screen is locked, or another user's session holds the console (CGSessionCopyCurrentDictionary).
/// A probe carries it so the presence gate can hold a Send while the Mac sits locked.
func sessionLocked() -> Bool {
    guard let dict = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
    if let locked = dict["CGSSessionScreenIsLocked"] as? Bool, locked { return true }
    if let onConsole = dict[kCGSessionOnConsoleKey as String] as? Bool, !onConsole { return true }
    return false
}

func opFocusedText() throws -> JSONObject {
    try requireAccessibility()
    let (target, error, retried) = resolveFocused()
    if error == .apiDisabled { throw HandsError.permissionDenied(accessibilityHint) }
    guard let target else {
        throw HandsError.notFound("no focused UI element (\(axErrorName(error)))\(retried ? " even after enabling web accessibility on the front app" : "")")
    }
    let element = target.element
    let secure = target.secure
    var out: JSONObject = [
        "role": orNull(target.role),
        "subrole": orNull(target.subrole),
        "title": orNull(target.title),
        // Never read the contents of a password field.
        "value": secure ? NSNull() : orNull(axString(element, kAXValueAttribute, limit: 4000)),
        "selectedText": secure ? NSNull() : orNull(axString(element, kAXSelectedTextAttribute, limit: 4000)),
        "secure": secure,
        "app": orNull(target.app),
        "frame": target.frame.map { rectJSON($0) } ?? NSNull(),
        // The gate's probe doubles as the stale-frame and presence read.
        "config": displayConfigHash(),
        "locked": sessionLocked(),
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
        // The click gate's probe: is the screen still the one the screenshot showed, and is it unlocked.
        "config": displayConfigHash(),
        "locked": sessionLocked(),
    ]
}
