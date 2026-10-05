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
    noteOwnPost(type)
    event.post(tap: .cghidEventTap)
}

func postKey(_ keyCode: CGKeyCode, down: Bool, flags: CGEventFlags) {
    guard let event = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: down) else { return }
    event.flags = flags
    if down { noteOwnPost(.keyDown) }
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
        if down { noteOwnPost(.keyDown) }
        event.post(tap: .cghidEventTap)
    }
    return posted
}

// MARK: - Kevin's hands win
//
// Every event this process posts is noted by kind in `handsLedger`. Before an acting op's first
// post, and before every grapheme of a `type`, the session is read (CGEventSource on the combined
// session state, which counts our own posts too): the newest key press, click and scroll by time,
// and how many of each the session counted. A newest event that is not within `ownPostSlackSec`
// of our last post of the kind is someone else's; so is every event the session counted beyond
// our own posts, however many of ours came after it (HandsWin.swift). One younger than
// `kevinQuietMs` is Kevin's hands on the machine: the op answers `busy` with nothing posted, and a
// type stops there and says how many characters landed. Pointer moves are not counted: a resting
// hand jitters. Dictation passes `ownDriver: true`: Kevin is the one typing there, so his keys are
// read and attributed but hold nothing. The check lives here, not in the client, because only this
// process knows every event it posted; an engine-side subtraction guesses.

/// What `user_idle` reports for a kind of event the session has never seen (JSON has no Infinity).
let userIdleNoneMs: Double = 1.0e12

/// Our own posts and the foreign events the session counted beyond them. Worker queue only.
/// With JARHEAD_HANDS_DEBUG=1, every event found by count is logged, and so is the case that
/// should be rare: one found while the session's newest event of the kind is a post of ours. Many
/// of those during a run of our own posts with hands off would mean the session counts our posts
/// twice or late, and every op would be held as busy (the K5 negative control).
private var handsLedger: HandsLedger = {
    var ledger = HandsLedger()
    ledger.onCountedForeign = { kind, n, behindOwn in
        debugLog("hands-win: \(n) \(kind) event(s) counted beyond our posts\(behindOwn ? "; the newest of the kind is our own post" : "")")
    }
    return ledger
}()

/// A monotonic clock on the same base as the session's event timestamps (mach absolute time).
func uptimeNow() -> TimeInterval {
    return ProcessInfo.processInfo.systemUptime
}

/// The session's event types for each kind the ledger counts.
private func eventTypes(_ kind: InputKind) -> [CGEventType] {
    switch kind {
    case .key: return [.keyDown]
    case .click: return [.leftMouseDown, .rightMouseDown, .otherMouseDown]
    case .scroll: return [.scrollWheel]
    }
}

/// Called immediately before each post, on the worker queue.
func noteOwnPost(_ type: CGEventType) {
    switch type {
    case .keyDown: handsLedger.noteOwnPost(.key, at: uptimeNow())
    case .leftMouseDown, .rightMouseDown, .otherMouseDown: handsLedger.noteOwnPost(.click, at: uptimeNow())
    case .scrollWheel: handsLedger.noteOwnPost(.scroll, at: uptimeNow())
    default: break
    }
}

/// Milliseconds since the session's last event of `type`; nil when there was none.
private func msSinceLast(_ type: CGEventType) -> Double? {
    let seconds = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: type)
    guard seconds.isFinite, seconds >= 0, seconds < 1.0e9 else { return nil }
    return seconds * 1000
}

/// One kind as the session reports it: the count from every source, and the age of each type's newest event.
private func readSessionKind(_ kind: InputKind) -> KindReading {
    var count: Int64 = 0
    var ages: [Double] = []
    for type in eventTypes(kind) {
        count += Int64(CGEventSource.counterForEventType(.combinedSessionState, eventType: type))
        if let ms = msSinceLast(type) { ages.append(ms) }
    }
    return KindReading(count: count, msAgo: ages)
}

/// The window server as the ledger reads it.
private let sessionClock = EventClock(now: uptimeNow, read: readSessionKind)

/// The newest event of any of `types`, in ms; nil when there was none.
private func newestMs(_ types: [CGEventType]) -> Double? {
    return types.compactMap { msSinceLast($0) }.min()
}

/// `user_idle {}`: how long since Kevin (or anyone) last touched the machine, by kind, and since the last input that was not ours.
func opUserIdle() -> JSONObject {
    let foreign = handsLedger.foreignMs(sessionClock)
    return [
        "keyMs": newestMs(eventTypes(.key)) ?? userIdleNoneMs,
        "clickMs": newestMs(eventTypes(.click)) ?? userIdleNoneMs,
        "scrollMs": newestMs(eventTypes(.scroll)) ?? userIdleNoneMs,
        "moveMs": msSinceLast(.mouseMoved) ?? userIdleNoneMs,
        "foreignMs": foreign ?? userIdleNoneMs,
    ]
}

/// Kevin's last key/click/scroll in ms when it is inside the quiet window; nil when the machine is free to act on.
func kevinBusyMs() -> Int? {
    return handsLedger.busyMs(sessionClock)
}

/// The two refusals every acting op makes before its first post: Kevin's hands (unless `ownDriver`), then the front app (`expectFront`).
func guardActing(_ params: Params, busyCheck: Bool = true) throws {
    if busyCheck, try params.bool("ownDriver") != true {
        if let ms = kevinBusyMs() {
            // The helper knows no name: the client (native.ts nameBusyMessage) puts the user's in front.
            throw HandsError.busy("the user used the keyboard/mouse \(ms) ms ago; nothing was posted")
        }
    } else {
        // Not judged, still read: his events so far are attributed before this op posts its own.
        handsLedger.observe(sessionClock)
    }
    try requireFront(params)
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
    // The pointer is Kevin's too: it does not jump out from under his hand while he is using it.
    try guardActing(params)
    postMouseMove(to: point)
    return pointJSON(point)
}

func opClick(_ params: Params) throws -> JSONObject {
    let button = try MouseButton(name: try params.string("button"))
    let count = try params.int("count") ?? 1
    guard (1...3).contains(count) else { throw HandsError.badRequest("'count' must be 1, 2 or 3") }
    let flags = try parseModifiers(try params.stringArray("modifiers"))
    try guardActing(params)

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
    try guardActing(params)
    let point = cursorLocation()
    postMouseButton(button.downType, button: button, at: point, clickState: 1, flags: flags)
    return ["x": Double(point.x), "y": Double(point.y), "button": button.rawValue]
}

func opMouseUp(_ params: Params) throws -> JSONObject {
    let button = try MouseButton(name: try params.string("button"))
    let flags = try parseModifiers(try params.stringArray("modifiers"))
    // The up completes a press already posted: refusing it for Kevin's click would leave a
    // synthetic button held down, which is worse than releasing it. `expectFront` still applies.
    try guardActing(params, busyCheck: false)
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
    try guardActing(params)

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
    try guardActing(params)
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
    noteOwnPost(.scrollWheel)
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
    /// Stopped before the cell was done: the client's stop, Kevin's hands, or the focus moved, with
    /// `landed` of the cell's characters in (graphemes typed; 0 before an insertion or a paste).
    case cancelled(TypeCancelReason, landed: Int)
}

/// Whether an element with this role takes typed text (FocusedTarget.isTextField's rule).
private func takesText(role: String?, subrole: String?) -> Bool {
    guard let role else { return false }
    return textRoles.contains(role) || subrole == "AXSearchField"
}

/// The app's own focused element as a FocusMark (the place its keystrokes land), read with the
/// app element's short timeout so a busy app slows the watch, never hangs it; nil when AX cannot say.
/// When the focused element is still `base`'s, `base` comes back as it is: one AX read, not four.
private func focusMark(inApp app: AXUIElement, base: FocusMark?) -> FocusMark? {
    var focusedRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute as CFString, &focusedRef) == .success,
          let focused = focusedRef, CFGetTypeID(focused) == AXUIElementGetTypeID() else { return nil }
    let element = focused as! AXUIElement
    if let base, base.element == AnyHashable(element) { return base }
    AXUIElementSetMessagingTimeout(element, 0.25)
    var window: AnyHashable? = nil
    var windowRef: CFTypeRef?
    if AXUIElementCopyAttributeValue(element, kAXWindowAttribute as CFString, &windowRef) == .success,
       let value = windowRef, CFGetTypeID(value) == AXUIElementGetTypeID() {
        window = AnyHashable(value as! AXUIElement)
    }
    let text = takesText(role: axString(element, kAXRoleAttribute), subrole: axString(element, kAXSubroleAttribute))
    return FocusMark(element: AnyHashable(element), window: window, takesText: text)
}

/// One `type` op's running state.
struct TypeSession {
    let generation: sig_atomic_t
    let delayMs: Int
    var watch: TypeWatch
    /// Key and paste events posted so far. The characters that landed are counted by walkType.
    var events = 0
    /// Why to stop now, if at all: the stop signal, Kevin's hands, then where the keystrokes land.
    mutating func cancelReason() -> TypeCancelReason? {
        return watch.cancelReason(stopped: typeCancelGeneration != generation, ledger: &handsLedger, clock: sessionClock)
    }
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

private func deliverAX(_ cell: String, target: FocusedTarget?, session: inout TypeSession) -> Delivery {
    guard let target else { return .skipped("no focused element known") }
    guard target.isTextField else { return .skipped("\(target.role ?? "the focused element") is not a text field") }
    guard trustsReadBack(target) else { return .skipped("a Chromium / Electron field: keystrokes go in directly") }
    guard axCanInsertText(target.element) else { return .skipped("the field does not take accessibility insertion") }
    // The insertion goes to the focused element of whatever is in front: the same check as a keystroke.
    if let why = session.cancelReason() { return .cancelled(why, landed: 0) }
    let before = readBack(target)
    guard axInsertText(cell, into: target.element) else { return .failed("the app refused accessibility insertion") }
    // The set was accepted: whatever the read-back says, something may have landed — never fall through.
    return judge(cell, before: before, target: target, polls: 4, everyMs: 15, landedForSure: true)
}

private func deliverKeystrokes(_ cell: String, target: FocusedTarget?, session: inout TypeSession) -> Delivery {
    let before = readBack(target)
    // Kevin's key, click or scroll, the client's stop and a moved focus are all judged before each grapheme.
    let run = runGraphemes(cell, cancel: { session.cancelReason() }, post: { cluster in
        let units = Array(String(cluster).utf16)
        let chunks = units.count <= 20 ? [units] : utf16Chunks(Substring(String(cluster)), maxUnits: 20)
        for chunk in chunks {
            guard postUnicode(chunk) else { return false }
            session.events += 1
        }
        sleepMs(session.delayMs)
        return true
    })
    let posted: Int
    switch run {
    case .cancelled(let typed, let why):
        return .cancelled(why, landed: typed)
    case .postFailed(let typed):
        if typed == 0 { return .failed("keyboard events could not be created") }
        return .done(verified: false, note: "keyboard events stopped being created part way")
    case .done(let typed):
        posted = typed
    }
    // The events were posted at the HID tap: they land wherever focus is, on the app's own clock —
    // a main thread busy for a quarter second (Mail syncing, Xcode indexing) shows nothing yet. So
    // the read-back gets up to ~250 ms, and an unchanged value is "not verified", never "nothing
    // landed": re-delivering by paste would double Kevin's text, the worse failure.
    return judge(cell, before: before, target: target, polls: 10, everyMs: 25, landedForSure: posted > 0)
}

private func deliverPaste(_ cell: String, target: FocusedTarget?, session: inout TypeSession, keepOnFailure: Bool) -> Delivery {
    let pb = NSPasteboard.general
    // ⌘V lands in the front app: not one Kevin switched to since the caller looked.
    if let why = session.cancelReason() { return .cancelled(why, landed: 0) }
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
    // The text's length as the walk counts it (grapheme clusters, a line break one), for a stop's "N of total".
    let total = typeText(text).count
    if typeCancelGeneration != typeCancelConsumed {
        return ["characters": 0, "total": total, "events": 0, "via": TypeStrategy.keystrokes.rawValue, "attempts": 0, "cancelled": true, "reason": TypeCancelReason.stop.rawValue, "field": NSNull()]
    }
    // Kevin's hands, then the front app — before anything is posted (a mismatch here is an error,
    // like a click's; one that appears mid-text is a cancelled result that says how far it got).
    try guardActing(params)
    // A stop from here on is this op's, even one that lands while the focus is being resolved.
    let generation = typeCancelGeneration
    let expectPid: pid_t? = try params.object("expectFront").map { pid_t(truncatingIfNeeded: try $0.requireInt("pid")) }
    let ownDriver = try params.bool("ownDriver") == true
    let trusted = AXIsProcessTrusted()
    // Where the text lands. Refused for a password field here too — the gate said no already;
    // this is the hands' own no, so no caller can reach one by another road.
    var target = trusted ? resolveFocused().target : nil
    let passwordRefusal = HandsError.badRequest("the focused field is a password field; Kevin types secrets himself")
    if let t = target, t.secure { throw passwordRefusal }
    // Between graphemes the type watches where its keystrokes land: the app the caller judged it
    // against, and that app's focused element, read through the app's own element (the way the
    // Chromium retry above reads it) with a short timeout.
    let watchPid: pid_t? = trusted ? (expectPid ?? frontmostNow()?.pid) : nil
    let watchApp: AXUIElement? = watchPid.map { pid in
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.25)
        return app
    }
    let readFocus: FocusReader = { base in watchApp.flatMap { focusMark(inApp: $0, base: base) } }
    let front = FrontWatch(pid: expectPid, focus: readFocus(nil), now: uptimeNow, readPid: { frontmostNow()?.pid }, readFocus: readFocus)
    var session = TypeSession(generation: generation, delayMs: delay, watch: TypeWatch(busyCheck: !ownDriver, front: front))
    var field = target?.describedField
    var via: TypeStrategy = .keystrokes
    var attempts = 0
    var allVerified = true
    var anyDelivered = false
    var notes: [String] = []

    /// A separator key (Return / Tab) moves focus or submits: re-resolve where the next cell lands. Returns why it did not, if it did not.
    func separator(_ key: TypeSeparator) throws -> TypeCancelReason? {
        if let why = session.cancelReason() { return why }
        pressKey(CGKeyCode(key == .returnKey ? kVK_Return : kVK_Tab), flags: [])
        session.events += 1
        sleepMs(max(delay, 8))
        if trusted {
            target = resolveFocused().target
            if let t = target, t.secure { throw passwordRefusal }
            if let t = target { field = t.describedField }
            // The separator moved the focus on purpose: where it landed is the place to watch now.
            session.watch.front.rebase()
        }
        return nil
    }
    /// One cell, through the strategy chain: whole, or stopped with what of it landed.
    func deliver(_ cell: String) throws -> CellEnd {
        if let why = session.cancelReason() { return .stopped(why, landed: 0) }
        var delivered = false
        var cellAttempts = 0
        var failures: [String] = []
        for (i, strategy) in order.enumerated() where !delivered && cellAttempts < 3 {
            let last = i == order.count - 1
            let outcome: Delivery
            switch strategy {
            case .ax: outcome = deliverAX(cell, target: target, session: &session)
            case .keystrokes: outcome = deliverKeystrokes(cell, target: target, session: &session)
            case .paste: outcome = deliverPaste(cell, target: target, session: &session, keepOnFailure: last || cellAttempts >= 2)
            }
            switch outcome {
            case .skipped(let why):
                debugLog("type: \(strategy.rawValue) skipped — \(why)")
            case .cancelled(let why, let landed):
                return .stopped(why, landed: landed)
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
        return .whole
    }

    let walk = try walkType(text, separator: separator, cell: deliver)
    if let why = walk.stopped {
        // Kevin's hands before anything went out: the guard's refusal, so the runner may retry it.
        if stopRefuses(why, landed: walk.landed, events: session.events) {
            throw HandsError.busy("the user used the keyboard/mouse \(session.watch.busyMs ?? 0) ms ago; nothing was posted")
        }
        return ["characters": walk.landed, "total": total, "events": session.events, "via": via.rawValue, "attempts": attempts, "cancelled": true, "reason": why.rawValue, "field": orNull(field)]
    }
    var out: JSONObject = [
        "characters": total,
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
    try guardActing(params)
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
    try guardActing(params)
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
