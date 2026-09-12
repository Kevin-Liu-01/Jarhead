import Foundation
import AppKit
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

/// Types up to 20 UTF-16 code units in one keyDown/keyUp pair. False when the events could not be created.
@discardableResult
func postUnicode(_ units: [UInt16], flags: CGEventFlags = []) -> Bool {
    guard !units.isEmpty else { return true }
    var posted = true
    for down in [true, false] {
        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down) else {
            posted = false
            continue
        }
        units.withUnsafeBufferPointer { buffer in
            event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: buffer.baseAddress)
        }
        event.flags = flags
        event.post(tap: .cghidEventTap)
    }
    return posted
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

// MARK: - Type: delivery as a strategy chain, with a stop that lands mid-word
//
// A careful person types into the field, looks, and only then moves on. So: accessibility
// insertion first when the focus is a text field the app lets us set (the value is read back
// to check); else keystrokes, one grapheme cluster at a time with the cancel flag read between
// them; else a paste that swaps the clipboard in, marks the item concealed, and restores what
// was there. Three attempts at most; then a failure that names the field, with the whole text
// left on the clipboard so one ⌘V finishes the job. The read-back is trusted only where it
// mirrors typing (a Cocoa or WebKit text field): a Chromium / Electron field's value may not,
// and doubling Kevin's text by "retrying" a delivery that landed is worse than saying
// "not verified". A password field is refused here too, whatever the caller asked.

/// Bumped by the client's stop (SIGURG from `cancelPending`); the type loop reads it between clusters.
var typeCancelGeneration: sig_atomic_t = 0
/// The generation the last `type` op ended on. The client signals as soon as a `type` is *pending*
/// (written, maybe still queued behind other ops on the serial worker), so a bump that landed before
/// the op even started is a stop for that op: at its start, a generation ahead of this means cancelled.
var typeCancelConsumed: sig_atomic_t = 0

/// Installs the SIGURG handler once, on first use (a global in a non-main file initialises lazily).
/// SIGURG is the one signal whose default action is "ignore": a helper built before this shrugs it off.
let typeCancelHandlerInstalled: Bool = {
    _ = signal(SIGURG) { _ in typeCancelGeneration = typeCancelGeneration &+ 1 }
    return true
}()

enum TypeStrategy: String {
    case ax, keystrokes, paste
}

enum Delivery {
    /// The text landed. `verified` is true when the field read it back, false when it could not be checked.
    case done(verified: Bool, note: String?)
    /// Nothing landed; the next strategy may try.
    case failed(String)
    /// Not applicable here (no text field under focus, no permission); not counted as an attempt.
    case skipped(String)
    /// Kevin stopped it between two graphemes.
    case cancelled
}

/// One `type` op's running state.
struct TypeSession {
    let generation: sig_atomic_t
    let delayMs: Int
    var events = 0
    /// Characters delivered so far (for a cancelled result).
    var typed = 0
    var isCancelled: Bool { typeCancelGeneration != generation }
}

private let concealedType = NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType")
private let transientType = NSPasteboard.PasteboardType("org.nspasteboard.TransientType")

/// Everything on the general pasteboard, as raw data per type, so it can be put back.
private func snapshotPasteboard(_ pb: NSPasteboard) -> [[(NSPasteboard.PasteboardType, Data)]] {
    return (pb.pasteboardItems ?? []).map { item in
        item.types.compactMap { type in item.data(forType: type).map { (type, $0) } }
    }
}

private func restorePasteboard(_ pb: NSPasteboard, _ saved: [[(NSPasteboard.PasteboardType, Data)]]) {
    pb.clearContents()
    let items = saved.map { entry -> NSPasteboardItem in
        let item = NSPasteboardItem()
        for (type, data) in entry { item.setData(data, forType: type) }
        return item
    }
    if !items.isEmpty { pb.writeObjects(items) }
}

/// Put `text` on the pasteboard, marked concealed (clipboard managers skip it) and transient.
private func writeConcealed(_ pb: NSPasteboard, _ text: String) {
    pb.clearContents()
    let item = NSPasteboardItem()
    item.setString(text, forType: .string)
    item.setData(Data(), forType: concealedType)
    item.setData(Data(), forType: transientType)
    pb.writeObjects([item])
}

/// The field's value now, or nil when it exposes none.
private func readBack(_ target: FocusedTarget?) -> String? {
    guard let target, !target.secure else { return nil }
    return axFullValue(target.element)
}

/// Whether a value that did not change proves nothing landed: a Cocoa / WebKit text field mirrors
/// what is typed; a Chromium / Electron one may keep a hidden textarea whose value says nothing.
private func trustsReadBack(_ target: FocusedTarget?) -> Bool {
    guard let target, target.isTextField else { return false }
    if let front = onMain({ NSWorkspace.shared.frontmostApplication }), isChromiumOrElectron(front) { return false }
    return true
}

/// Judge a delivery by the value before and after, polling briefly for the app to catch up.
private func judge(_ cell: String, before: String?, target: FocusedTarget?, polls: Int, everyMs: Int, landedForSure: Bool) -> Delivery {
    guard target != nil, before != nil || readBack(target) != nil else { return .done(verified: false, note: nil) }
    var after: String? = nil
    for i in 0..<max(1, polls) {
        if i > 0 { sleepMs(everyMs) }
        after = readBack(target)
        if let after, after.contains(cell), after != before || before?.contains(cell) != true { return .done(verified: true, note: nil) }
    }
    guard let after else { return .done(verified: false, note: nil) }
    if after != before { return .done(verified: false, note: "the field changed but does not read the text back as typed (reformatted?)") }
    if landedForSure || !trustsReadBack(target) { return .done(verified: false, note: "the field did not read the text back; if the screen shows nothing typed, retry with strategy \"paste\"") }
    return .failed("nothing landed in \(target?.describedField ?? "the field")")
}

private func deliverAX(_ cell: String, target: FocusedTarget?) -> Delivery {
    guard let target else { return .skipped("no focused element known") }
    guard target.isTextField else { return .skipped("\(target.role ?? "the focused element") is not a text field") }
    guard trustsReadBack(target) else { return .skipped("a Chromium / Electron field: keystrokes go in directly") }
    guard axCanInsertText(target.element) else { return .skipped("the field does not take accessibility insertion") }
    let before = readBack(target)
    guard axInsertText(cell, into: target.element) else { return .failed("the app refused accessibility insertion") }
    // The set was accepted: whatever the read-back says, something may have landed — never fall through.
    return judge(cell, before: before, target: target, polls: 4, everyMs: 15, landedForSure: true)
}

private func deliverKeystrokes(_ cell: String, target: FocusedTarget?, session: inout TypeSession) -> Delivery {
    let before = readBack(target)
    var posted = 0
    for cluster in cell {
        if session.isCancelled { return .cancelled }
        let units = Array(String(cluster).utf16)
        let chunks = units.count <= 20 ? [units] : utf16Chunks(Substring(String(cluster)), maxUnits: 20)
        for chunk in chunks {
            guard postUnicode(chunk) else {
                return posted == 0 ? .failed("keyboard events could not be created") : .done(verified: false, note: "keyboard events stopped being created part way")
            }
            session.events += 1
        }
        posted += 1
        session.typed += 1
        sleepMs(session.delayMs)
    }
    // The events were posted at the HID tap: they land wherever focus is, on the app's own clock —
    // a main thread busy for a quarter second (Mail syncing, Xcode indexing) shows nothing yet. So
    // the read-back gets up to ~250 ms, and an unchanged value is "not verified", never "nothing
    // landed": re-delivering by paste would double Kevin's text, the worse failure.
    return judge(cell, before: before, target: target, polls: 10, everyMs: 25, landedForSure: posted > 0)
}

private func deliverPaste(_ cell: String, target: FocusedTarget?, session: inout TypeSession, keepOnFailure: Bool) -> Delivery {
    let pb = NSPasteboard.general
    let saved = onMain { snapshotPasteboard(pb) }
    let before = readBack(target)
    onMain { writeConcealed(pb, cell) }
    pressKey(CGKeyCode(kVK_ANSI_V), flags: .maskCommand)
    session.events += 1
    // The app reads the pasteboard when it handles the key; give it a moment, then look.
    sleepMs(40)
    let outcome = judge(cell, before: before, target: target, polls: 8, everyMs: 40, landedForSure: false)
    switch outcome {
    case .failed where keepOnFailure:
        // The final attempt failed: the text stays on the clipboard for Kevin's own ⌘V.
        break
    case .done(let verified, _) where !verified:
        // Unverifiable: leave the item long enough for the app to have taken it, then put the old contents back.
        sleepMs(200)
        onMain { restorePasteboard(pb, saved) }
    default:
        onMain { restorePasteboard(pb, saved) }
    }
    if case .done = outcome { session.typed += cell.count }
    return outcome
}

func opType(_ params: Params) throws -> JSONObject {
    _ = typeCancelHandlerInstalled
    // Every stop that arrived since the last type op ended was aimed at a type still queued
    // (the client signals only while one is pending): this one. Consumed either way on exit.
    defer { typeCancelConsumed = typeCancelGeneration }
    let text = try params.requireString("text")
    let delay = try params.int("delayMs") ?? 3
    guard delay >= 0, delay <= 1000 else { throw HandsError.badRequest("'delayMs' must be 0...1000") }
    let order: [TypeStrategy]
    switch try params.string("strategy") ?? "auto" {
    case "auto": order = [.ax, .keystrokes, .paste]
    case "ax": order = [.ax]
    case "keystrokes": order = [.keystrokes]
    case "paste": order = [.paste, .paste]
    default: throw HandsError.badRequest("'strategy' must be auto, ax, keystrokes or paste")
    }
    if typeCancelGeneration != typeCancelConsumed {
        return ["characters": 0, "events": 0, "via": TypeStrategy.keystrokes.rawValue, "attempts": 0, "cancelled": true, "field": NSNull()]
    }
    var session = TypeSession(generation: typeCancelGeneration, delayMs: delay)
    let trusted = AXIsProcessTrusted()
    // Where the text lands. Refused for a password field here too — the gate said no already;
    // this is the hands' own no, so no caller can reach one by another road.
    var target = trusted ? resolveFocused().target : nil
    let passwordRefusal = HandsError.badRequest("the focused field is a password field; Kevin types secrets himself")
    if let t = target, t.secure { throw passwordRefusal }
    var field = target?.describedField
    var via: TypeStrategy = .keystrokes
    var attempts = 0
    var allVerified = true
    var anyDelivered = false
    var notes: [String] = []

    func cancelledResult() -> JSONObject {
        return ["characters": session.typed, "events": session.events, "via": via.rawValue, "attempts": attempts, "cancelled": true, "field": orNull(field)]
    }
    /// A separator key (Return / Tab) moves focus or submits: re-resolve where the next cell lands.
    func separator(_ key: Int) throws -> Bool {
        if session.isCancelled { return false }
        pressKey(CGKeyCode(key), flags: [])
        session.events += 1
        sleepMs(max(delay, 8))
        if trusted {
            target = resolveFocused().target
            if let t = target, t.secure { throw passwordRefusal }
            if let t = target { field = t.describedField }
        }
        return true
    }

    let normalized = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
    let lines = normalized.split(separator: "\n", omittingEmptySubsequences: false)
    for (lineIndex, line) in lines.enumerated() {
        if lineIndex > 0, try !separator(kVK_Return) { return cancelledResult() }
        let cells = line.split(separator: "\t", omittingEmptySubsequences: false)
        for (cellIndex, cellSub) in cells.enumerated() {
            if cellIndex > 0, try !separator(kVK_Tab) { return cancelledResult() }
            let cell = String(cellSub)
            if cell.isEmpty { continue }
            if session.isCancelled { return cancelledResult() }
            var delivered = false
            var cellAttempts = 0
            var failures: [String] = []
            for (i, strategy) in order.enumerated() where !delivered && cellAttempts < 3 {
                let last = i == order.count - 1
                let outcome: Delivery
                switch strategy {
                case .ax: outcome = deliverAX(cell, target: target)
                case .keystrokes: outcome = deliverKeystrokes(cell, target: target, session: &session)
                case .paste: outcome = deliverPaste(cell, target: target, session: &session, keepOnFailure: last || cellAttempts >= 2)
                }
                switch outcome {
                case .skipped(let why):
                    debugLog("type: \(strategy.rawValue) skipped — \(why)")
                case .cancelled:
                    return cancelledResult()
                case .done(let verified, let note):
                    cellAttempts += 1
                    attempts += cellAttempts
                    delivered = true
                    anyDelivered = true
                    via = strategy
                    if !verified { allVerified = false }
                    if let note, !notes.contains(note) { notes.append(note) }
                case .failed(let why):
                    cellAttempts += 1
                    failures.append("\(strategy.rawValue): \(why)")
                    debugLog("type: \(strategy.rawValue) failed — \(why)")
                }
            }
            if !delivered {
                attempts += cellAttempts
                // Out of attempts: the whole text goes on the clipboard, concealed, and the failure says so.
                onMain { writeConcealed(NSPasteboard.general, text) }
                let tried = failures.isEmpty ? "no strategy applied" : failures.joined(separator: "; ")
                throw HandsError.internalError("could not type into \(field ?? "the focused field") after \(max(1, cellAttempts)) attempt\(cellAttempts == 1 ? "" : "s") (\(tried)); the text is on the clipboard — one ⌘V in the right field pastes it")
            }
        }
    }
    var out: JSONObject = [
        "characters": text.count,
        "events": session.events,
        "via": via.rawValue,
        "attempts": attempts,
        "field": orNull(field),
    ]
    if anyDelivered { out["verified"] = allVerified }
    if !notes.isEmpty { out["note"] = notes.joined(separator: "; ") }
    return out
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
