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

func opFocusedText() throws -> JSONObject {
    try requireAccessibility()
    var focusedRef: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(systemWideElement, kAXFocusedUIElementAttribute as CFString, &focusedRef)
    if error == .apiDisabled { throw HandsError.permissionDenied(accessibilityHint) }
    guard error == .success, let element = axElement(from: focusedRef) else {
        throw HandsError.notFound("no focused UI element (\(axErrorName(error)))")
    }

    let role = axString(element, kAXRoleAttribute)
    let subrole = axString(element, kAXSubroleAttribute)
    let secure = role == kAXTextFieldRole && subrole == kAXSecureTextFieldSubrole
    let frame = axFrame(element)
    return [
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
