import Foundation
import CoreGraphics
import Carbon.HIToolbox

// MARK: - Mouse and keyboard synthesis via CGEvent (posted at the HID event tap).
//
// Posting events without Accessibility permission silently does nothing; `hello` /
// `permissions` is how the caller learns that. Nothing here tries to detect it after the fact.

enum MouseButton: String {
    case left, right, middle

    init(name: String?) throws {
        guard let name else { self = .left; return }
        guard let button = MouseButton(rawValue: name.lowercased()) else {
            throw HandsError.badRequest("'button' must be \"left\", \"right\" or \"middle\"")
        }
        self = button
    }

    var cgButton: CGMouseButton {
        switch self {
        case .left: return .left
        case .right: return .right
        case .middle: return .center
        }
    }

    var downType: CGEventType {
        switch self {
        case .left: return .leftMouseDown
        case .right: return .rightMouseDown
        case .middle: return .otherMouseDown
        }
    }

    var upType: CGEventType {
        switch self {
        case .left: return .leftMouseUp
        case .right: return .rightMouseUp
        case .middle: return .otherMouseUp
        }
    }

    var draggedType: CGEventType {
        switch self {
        case .left: return .leftMouseDragged
        case .right: return .rightMouseDragged
        case .middle: return .otherMouseDragged
        }
    }
}

func cursorLocation() -> CGPoint {
    return CGEvent(source: nil)?.location ?? .zero
}

func postMouseMove(to point: CGPoint, flags: CGEventFlags = []) {
    guard let event = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved,
                              mouseCursorPosition: point, mouseButton: .left) else { return }
    event.flags = flags
    event.post(tap: .cghidEventTap)
}

func postMouseButton(_ type: CGEventType, button: MouseButton, at point: CGPoint,
                     clickState: Int, flags: CGEventFlags) {
    guard let event = CGEvent(mouseEventSource: nil, mouseType: type,
                              mouseCursorPosition: point, mouseButton: button.cgButton) else { return }
    event.setIntegerValueField(.mouseEventClickState, value: Int64(clickState))
    event.flags = flags
    event.post(tap: .cghidEventTap)
}

func postKey(_ keyCode: CGKeyCode, down: Bool, flags: CGEventFlags) {
    guard let event = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: down) else { return }
    event.flags = flags
    event.post(tap: .cghidEventTap)
}

func pressKey(_ keyCode: CGKeyCode, flags: CGEventFlags) {
    postKey(keyCode, down: true, flags: flags)
    sleepMs(4)
    postKey(keyCode, down: false, flags: flags)
}

/// Types up to 20 UTF-16 code units in one keyDown/keyUp pair.
func postUnicode(_ units: [UInt16], flags: CGEventFlags = []) {
    guard !units.isEmpty else { return }
    for down in [true, false] {
        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down) else { continue }
        units.withUnsafeBufferPointer { buffer in
            event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: buffer.baseAddress)
        }
        event.flags = flags
        event.post(tap: .cghidEventTap)
    }
}

func postStroke(_ stroke: KeyStroke) {
    if let code = stroke.keyCode {
        pressKey(code, flags: stroke.flags)
    } else if let units = stroke.unicode {
        postUnicode(units, flags: stroke.flags)
    }
}

// MARK: - Ops

func opCursor() -> JSONObject {
    return pointJSON(cursorLocation())
}

func opMove(_ params: Params) throws -> JSONObject {
    let point = try params.requireXY()
    postMouseMove(to: point)
    return pointJSON(point)
}

func opClick(_ params: Params) throws -> JSONObject {
    let button = try MouseButton(name: try params.string("button"))
    let count = try params.int("count") ?? 1
    guard (1...3).contains(count) else { throw HandsError.badRequest("'count' must be 1, 2 or 3") }
    let flags = try parseModifiers(try params.stringArray("modifiers"))

    var point = cursorLocation()
    if let target = try params.optionalXY() {
        point = target
        postMouseMove(to: point, flags: flags)
        sleepMs(12)
    }
    for i in 1...count {
        if i > 1 { sleepMs(60) }
        postMouseButton(button.downType, button: button, at: point, clickState: i, flags: flags)
        sleepMs(8)
        postMouseButton(button.upType, button: button, at: point, clickState: i, flags: flags)
    }
    return ["x": Double(point.x), "y": Double(point.y), "button": button.rawValue, "count": count]
}

func opMouseDown(_ params: Params) throws -> JSONObject {
    let button = try MouseButton(name: try params.string("button"))
    let flags = try parseModifiers(try params.stringArray("modifiers"))
    let point = cursorLocation()
    postMouseButton(button.downType, button: button, at: point, clickState: 1, flags: flags)
    return ["x": Double(point.x), "y": Double(point.y), "button": button.rawValue]
}

func opMouseUp(_ params: Params) throws -> JSONObject {
    let button = try MouseButton(name: try params.string("button"))
    let flags = try parseModifiers(try params.stringArray("modifiers"))
    let point = cursorLocation()
    postMouseButton(button.upType, button: button, at: point, clickState: 1, flags: flags)
    return ["x": Double(point.x), "y": Double(point.y), "button": button.rawValue]
}

private func easeInOut(_ t: Double) -> Double {
    return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) * (-2 * t + 2) / 2
}

func opDrag(_ params: Params) throws -> JSONObject {
    let from = try params.point("from")
    let to = try params.point("to")
    let button = try MouseButton(name: try params.string("button"))
    let flags = try parseModifiers(try params.stringArray("modifiers"))
    let duration = try params.int("durationMs") ?? 300
    guard duration >= 0, duration <= 10_000 else { throw HandsError.badRequest("'durationMs' must be 0...10000") }

    postMouseMove(to: from, flags: flags)
    sleepMs(15)
    postMouseButton(button.downType, button: button, at: from, clickState: 1, flags: flags)
    sleepMs(20)

    let steps = 30
    let stepDelay = max(1, duration / steps)
    for i in 1...steps {
        let e = easeInOut(Double(i) / Double(steps))
        let point = CGPoint(x: from.x + (to.x - from.x) * CGFloat(e), y: from.y + (to.y - from.y) * CGFloat(e))
        postMouseButton(button.draggedType, button: button, at: point, clickState: 1, flags: flags)
        sleepMs(stepDelay)
    }
    postMouseButton(button.upType, button: button, at: to, clickState: 1, flags: flags)
    return ["from": pointJSON(from), "to": pointJSON(to), "button": button.rawValue, "durationMs": duration]
}

func opScroll(_ params: Params) throws -> JSONObject {
    guard params.has("dx") || params.has("dy") else { throw HandsError.badRequest("'dx' or 'dy' is required") }
    let dx = try params.double("dx") ?? 0
    let dy = try params.double("dy") ?? 0
    let flags = try parseModifiers(try params.stringArray("modifiers"))
    if let target = try params.optionalXY() {
        postMouseMove(to: target, flags: flags)
        sleepMs(8)
    }
    let limit = Double(Int32.max)
    let wheel1 = Int32(clamp(dy.rounded(), -limit, limit)) // positive = content scrolls up (earlier content)
    let wheel2 = Int32(clamp(dx.rounded(), -limit, limit))
    guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2,
                              wheel1: wheel1, wheel2: wheel2, wheel3: 0) else {
        throw HandsError.internalError("could not create scroll event")
    }
    event.flags = flags
    event.post(tap: .cghidEventTap)
    return ["dx": Double(wheel2), "dy": Double(wheel1)]
}

/// Splits into chunks of <= maxUnits UTF-16 code units without splitting surrogate pairs.
func utf16Chunks(_ text: Substring, maxUnits: Int) -> [[UInt16]] {
    let units = Array(text.utf16)
    var chunks: [[UInt16]] = []
    var start = 0
    while start < units.count {
        var end = min(start + maxUnits, units.count)
        if end < units.count, UTF16.isLeadSurrogate(units[end - 1]) { end -= 1 }
        if end <= start { end = min(start + 2, units.count) }
        chunks.append(Array(units[start..<end]))
        start = end
    }
    return chunks
}

func opType(_ params: Params) throws -> JSONObject {
    let text = try params.requireString("text")
    let delay = try params.int("delayMs") ?? 8
    guard delay >= 0, delay <= 1000 else { throw HandsError.badRequest("'delayMs' must be 0...1000") }

    let normalized = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
    var events = 0
    let lines = normalized.split(separator: "\n", omittingEmptySubsequences: false)
    for (lineIndex, line) in lines.enumerated() {
        if lineIndex > 0 {
            pressKey(CGKeyCode(kVK_Return), flags: [])
            events += 1
            sleepMs(delay)
        }
        let cells = line.split(separator: "\t", omittingEmptySubsequences: false)
        for (cellIndex, cell) in cells.enumerated() {
            if cellIndex > 0 {
                pressKey(CGKeyCode(kVK_Tab), flags: [])
                events += 1
                sleepMs(delay)
            }
            for chunk in utf16Chunks(cell, maxUnits: 20) {
                postUnicode(chunk)
                events += 1
                sleepMs(delay)
            }
        }
    }
    return ["characters": text.count, "events": events]
}

func opKey(_ params: Params) throws -> JSONObject {
    let combo = try params.requireString("combo")
    let repeatCount = try params.int("repeat") ?? 1
    guard (1...100).contains(repeatCount) else { throw HandsError.badRequest("'repeat' must be 1...100") }
    let stroke = try parseCombo(combo)
    for i in 0..<repeatCount {
        if i > 0 { sleepMs(30) }
        postStroke(stroke)
    }
    return ["combo": combo, "repeat": repeatCount]
}

func opHoldKey(_ params: Params) throws -> JSONObject {
    let combo = try params.requireString("combo")
    let duration = try params.requireInt("durationMs")
    guard duration >= 0, duration <= 10_000 else { throw HandsError.badRequest("'durationMs' must be 0...10000") }
    let stroke = try parseCombo(combo)
    if let code = stroke.keyCode {
        postKey(code, down: true, flags: stroke.flags)
        sleepMs(duration)
        postKey(code, down: false, flags: stroke.flags)
    } else if let units = stroke.unicode {
        // No key code for this character: a held Unicode key is emulated as one keystroke.
        postUnicode(units, flags: stroke.flags)
        sleepMs(duration)
    }
    return ["combo": combo, "durationMs": duration]
}
