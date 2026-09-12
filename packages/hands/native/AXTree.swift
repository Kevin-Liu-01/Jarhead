import Foundation
import AppKit
import ApplicationServices

// MARK: - The frontmost window's accessibility tree, cached, and `find_element` over it.
//
// The reflex path ("click Save", said out loud) cannot afford a screenshot and a model:
// it asks this module for the one control on the front window that carries that name.
// The tree is walked once (one AX round trip per element, all attributes at a time) and
// kept for a short while; the engine keeps it warm every 500 ms while Jarhead is awake,
// and it is rebuilt when the frontmost app or its focused window changes. A walk is
// capped in depth and node count so a huge web page cannot hang the worker.

struct AXNode {
    let index: Int
    let depth: Int
    let role: String
    let subrole: String?
    let title: String?
    let description: String?
    let value: String?
    /// A text field's placeholder ("Search…", "Type / to search"): how a person names an empty field.
    let placeholder: String?
    let frame: CGRect?
    let pressable: Bool
    let element: AXUIElement

    /// A field words are typed into: the one kind of control whose label may be *about* a thing ("Search the wiki").
    var isTextInput: Bool {
        role == kAXTextFieldRole || role == kAXTextAreaRole || role == kAXComboBoxRole || role == "AXSearchField" || subrole == kAXSearchFieldSubrole
    }

    /// The words a person would call this control by.
    var labels: [String] {
        var out: [String] = []
        if let title, !title.isEmpty { out.append(title) }
        if let description, !description.isEmpty { out.append(description) }
        if let placeholder, !placeholder.isEmpty, isTextInput { out.append(placeholder) }
        if let value, !value.isEmpty, value.count <= 60, role != kAXTextFieldRole, role != kAXTextAreaRole { out.append(value) }
        return out
    }

    var json: JSONObject {
        var o: JSONObject = ["i": index, "depth": depth, "role": role]
        if let subrole { o["subrole"] = subrole }
        if let title, !title.isEmpty { o["title"] = title }
        if let description, !description.isEmpty { o["description"] = description }
        if let value, !value.isEmpty { o["value"] = value }
        if let placeholder, !placeholder.isEmpty { o["placeholder"] = placeholder }
        if let frame {
            o["x"] = Double(frame.origin.x); o["y"] = Double(frame.origin.y)
            o["w"] = Double(frame.width); o["h"] = Double(frame.height)
        }
        if pressable { o["pressable"] = true }
        return o
    }
}

struct AXTreeSnapshot {
    let pid: pid_t
    let app: String
    let window: String
    let nodes: [AXNode]
    let builtAt: DispatchTime
    let buildMs: Double
    let truncated: Bool

    var ageMs: Double { elapsedMs(since: builtAt) }
}

/// Roles a spoken "click X" may land on. Static text is included: clicking a label focuses
/// its field in most apps, and web pages put their clickable words in static text often.
private let clickableRoles: Set<String> = [
    kAXButtonRole, "AXLink", kAXMenuItemRole, kAXMenuBarItemRole, kAXCheckBoxRole, kAXRadioButtonRole,
    kAXTabGroupRole, kAXPopUpButtonRole, kAXMenuButtonRole, kAXComboBoxRole, kAXDisclosureTriangleRole,
    kAXCellRole, kAXRowRole, kAXStaticTextRole, kAXImageRole, kAXTextFieldRole, kAXTextAreaRole,
    kAXSliderRole, kAXIncrementorRole, kAXToolbarRole, "AXTab", "AXSwitch", "AXToggle",
]

/// One IPC per element carries all of these; the placeholder rides along at no extra round trip.
private let walkAttributes: [String] = [
    kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute,
    kAXPositionAttribute, kAXSizeAttribute, kAXChildrenAttribute, kAXPlaceholderValueAttribute,
]

private func stringValue(_ value: CFTypeRef?, limit: Int) -> String? {
    guard let value, CFGetTypeID(value) != AXValueGetTypeID() else { return nil }
    var s: String?
    if let str = value as? String { s = str }
    else if let attributed = value as? NSAttributedString { s = attributed.string }
    else if let number = value as? NSNumber { s = isJSONBool(number) ? (number.boolValue ? "true" : "false") : number.stringValue }
    else if let url = value as? URL { s = url.absoluteString }
    guard let out = s?.trimmingCharacters(in: .whitespacesAndNewlines), !out.isEmpty else { return nil }
    return truncated(out, to: limit)
}

private func frameValue(position: CFTypeRef?, size: CFTypeRef?) -> CGRect? {
    guard let position, CFGetTypeID(position) == AXValueGetTypeID(),
          let size, CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
    var p = CGPoint.zero
    var sz = CGSize.zero
    guard AXValueGetValue(position as! AXValue, .cgPoint, &p), AXValueGetValue(size as! AXValue, .cgSize, &sz) else { return nil }
    return CGRect(origin: p, size: sz)
}

/// Walk the window breadth-first. One IPC per element (all attributes at once), a short
/// timeout per element, capped by `maxNodes` and `maxDepth`.
private func walk(window: AXUIElement, maxNodes: Int, maxDepth: Int, maxMs: Double) -> (nodes: [AXNode], truncated: Bool) {
    var nodes: [AXNode] = []
    var queue: [(AXUIElement, Int)] = [(window, 0)]
    var head = 0
    var truncated = false
    let attrs = walkAttributes as CFArray
    let start = DispatchTime.now()
    while head < queue.count {
        let (element, depth) = queue[head]
        head += 1
        // Breadth-first, so a budget that runs out still leaves the toolbar and the top-level
        // controls in the tree; a desktop full of icons or a long page is what gets cut.
        if nodes.count >= maxNodes || elapsedMs(since: start) > maxMs { truncated = true; break }
        AXUIElementSetMessagingTimeout(element, 0.3)
        var valuesRef: CFArray?
        guard AXUIElementCopyMultipleAttributeValues(element, attrs, AXCopyMultipleAttributeOptions(rawValue: 0), &valuesRef) == .success,
              let values = valuesRef as? [AnyObject], values.count == walkAttributes.count else { continue }
        func at(_ i: Int) -> CFTypeRef? {
            let v = values[i]
            // Missing attributes come back as AXValue errors; treat anything that is not a plain value as nil.
            if CFGetTypeID(v) == AXValueGetTypeID(), AXValueGetType(v as! AXValue) == .axError { return nil }
            return v
        }
        let role = stringValue(at(0), limit: 60) ?? "AXUnknown"
        let frame = frameValue(position: at(5), size: at(6))
        var actionsRef: CFArray?
        let pressable = AXUIElementCopyActionNames(element, &actionsRef) == .success && ((actionsRef as? [String])?.contains(kAXPressAction) ?? false)
        nodes.append(AXNode(
            index: nodes.count,
            depth: depth,
            role: role,
            subrole: stringValue(at(1), limit: 60),
            title: stringValue(at(2), limit: 200),
            description: stringValue(at(3), limit: 200),
            value: stringValue(at(4), limit: 200),
            placeholder: stringValue(at(8), limit: 200),
            frame: frame,
            pressable: pressable,
            element: element
        ))
        if depth >= maxDepth { truncated = true; continue }
        if let children = at(7) as? [AnyObject] {
            for child in children {
                guard CFGetTypeID(child) == AXUIElementGetTypeID() else { continue }
                queue.append((child as! AXUIElement, depth + 1))
            }
        }
    }
    return (nodes, truncated)
}

/// Chromium-based apps (Chrome, Electron) have tiny trees until `AXManualAccessibility` has
/// taken effect; a walk that finds almost nothing under a web window is tried once more.
private let sparseTreeNodes = 24

func runningApplication(named name: String) -> NSRunningApplication? {
    let wanted = name.lowercased()
    return onMain { NSWorkspace.shared.runningApplications.first { $0.localizedName?.lowercased() == wanted || $0.bundleIdentifier?.lowercased() == wanted } }
}

final class AXTreeCache {
    static let shared = AXTreeCache()
    private let lock = NSLock()
    /// One snapshot per app (pid); the frontmost one is what the reflex path reads.
    private var snapshots: [pid_t: AXTreeSnapshot] = [:]

    func invalidate() {
        lock.lock(); defer { lock.unlock() }
        snapshots.removeAll()
    }

    /// The tree of an app's focused window — the frontmost app unless `app` names another
    /// running one — reused while it is younger than `maxAgeMs` and the same window is up.
    func current(maxAgeMs: Double, maxNodes: Int, maxDepth: Int, maxMs: Double, app appName: String? = nil) throws -> (snapshot: AXTreeSnapshot, cached: Bool) {
        try requireAccessibility()
        let front: NSRunningApplication?
        if let appName, !appName.isEmpty {
            guard let named = runningApplication(named: appName) else { throw HandsError.notFound("\(appName) is not running") }
            front = named
        } else {
            front = onMain { NSWorkspace.shared.frontmostApplication }
        }
        guard let front else { throw HandsError.notFound("no frontmost application") }
        let pid = front.processIdentifier
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 1.0)
        var windowRef: CFTypeRef?
        var window: AXUIElement?
        for attribute in [kAXFocusedWindowAttribute, kAXMainWindowAttribute] {
            if AXUIElementCopyAttributeValue(app, attribute as CFString, &windowRef) == .success, let w = axElement(from: windowRef) { window = w; break }
        }
        if window == nil, let list = axAttribute(app, kAXWindowsAttribute) as? [AnyObject], let first = list.first {
            window = axElement(from: first as CFTypeRef)
        }
        guard let window else { throw HandsError.notFound("\(front.localizedName ?? "the frontmost app") has no focused window") }
        let title = axString(window, kAXTitleAttribute, limit: 200) ?? ""
        lock.lock()
        let existing = snapshots[pid]
        lock.unlock()
        if let existing, existing.window == title, existing.ageMs <= maxAgeMs {
            return (existing, true)
        }
        // Chromium and Electron expose their web content to AX clients only once asked. The
        // manual switch has none of the resizing side effects `AXEnhancedUserInterface` has;
        // the shared memory (AX.swift) lets the focused-element read skip its wait once it is on.
        enableWebAccessibility(pid: pid, app: app)
        let start = DispatchTime.now()
        var walked = walk(window: window, maxNodes: maxNodes, maxDepth: maxDepth, maxMs: maxMs)
        if walked.nodes.count < sparseTreeNodes, !walked.truncated, existing == nil {
            // The switch above lands asynchronously; give the app a moment and look again (once per window).
            sleepMs(120)
            let again = walk(window: window, maxNodes: maxNodes, maxDepth: maxDepth, maxMs: maxMs)
            if again.nodes.count > walked.nodes.count { walked = again }
        }
        let built = AXTreeSnapshot(pid: pid, app: front.localizedName ?? "", window: title, nodes: walked.nodes, builtAt: DispatchTime.now(), buildMs: elapsedMs(since: start), truncated: walked.truncated)
        lock.lock()
        if snapshots.count >= 4, snapshots[pid] == nil { snapshots.removeAll() }
        snapshots[pid] = built
        lock.unlock()
        debugLog("ax tree: \(built.app) \"\(title.prefix(40))\" \(built.nodes.count) nodes in \(String(format: "%.1f", built.buildMs)) ms\(built.truncated ? " (truncated)" : "")")
        return (built, false)
    }
}

// MARK: - Matching

/// Lowercase, one space between words, punctuation and a trailing ellipsis dropped.
func normalizeLabel(_ s: String) -> String {
    var t = s.lowercased()
    t = t.replacingOccurrences(of: "…", with: " ").replacingOccurrences(of: "...", with: " ")
    t = t.replacingOccurrences(of: "[\\p{P}\\p{S}]+", with: " ", options: .regularExpression)
    t = t.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
    return t.trimmingCharacters(in: .whitespaces)
}

func levenshtein(_ a: [Character], _ b: [Character]) -> Int {
    if a.isEmpty { return b.count }
    if b.isEmpty { return a.count }
    var prev = Array(0...b.count)
    var cur = [Int](repeating: 0, count: b.count + 1)
    for i in 1...a.count {
        cur[0] = i
        for j in 1...b.count {
            let cost = a[i - 1] == b[j - 1] ? 0 : 1
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
        }
        swap(&prev, &cur)
    }
    return prev[b.count]
}

/// 1 for identical strings, 0 for nothing in common: 1 − edits / longer length.
func similarity(_ a: String, _ b: String) -> Double {
    let ca = Array(a), cb = Array(b)
    let longest = max(ca.count, cb.count)
    if longest == 0 { return 1 }
    return 1 - Double(levenshtein(ca, cb)) / Double(longest)
}

/// A browser's own address bar, by the label the browser gives it (Chrome / Edge / Brave
/// "Address and search bar", Safari "Address and Search" / "Smart Search Field", Firefox
/// "Search or enter address", Arc "Address bar"): it always says "search", and a search on a
/// *site* must not land in it.
private let addressBarLabel = try! NSRegularExpression(pattern: "\\b(address|url|smart search|enter address|search or enter)\\b", options: [.caseInsensitive])

func isAddressBar(_ node: AXNode) -> Bool {
    guard node.isTextInput else { return false }
    return node.labels.contains { label in addressBarLabel.firstMatch(in: label, range: NSRange(label.startIndex..., in: label)) != nil }
}

private func roleMatches(_ node: AXNode, wanted: String?) -> Bool {
    guard let wanted, !wanted.isEmpty else { return true }
    let w = wanted.lowercased().replacingOccurrences(of: " ", with: "")
    let r = node.role.lowercased()
    // "field": anything words are typed into — a text field, a text area, a combo box, a
    // search field (a subrole: Finder's toolbar search is an AXButton/AXSearchField that
    // opens into a field on a click). "pagefield": the same minus a browser's address bar,
    // for a search on the page or site the tab shows.
    if w == "pagefield" { return node.isTextInput && !isAddressBar(node) }
    return r == w || r == "ax" + w || r.hasSuffix(w) || (w == "button" && r == "axpopupbutton") || ((w == "field" || w == "textfield" || w == "searchfield") && node.isTextInput) || (w == "tab" && (r == "axradiobutton" || r == "axtab"))
}

private func onSomeDisplay(_ frame: CGRect?, displays: [CGRect]) -> Bool {
    guard let frame, frame.width > 0, frame.height > 0 else { return false }
    return displays.contains { $0.intersects(frame) }
}

struct ElementMatch {
    let node: AXNode
    let score: Double
    let label: String
}

/// `wanted` appears in `label` as whole words ("search" in "search the wiki", "type / to search").
private func containsWords(_ label: String, _ wanted: String) -> Bool {
    let padded = " \(label) "
    return padded.contains(" \(wanted) ")
}

/// Exact (case- and punctuation-insensitive) matches first; then, for text inputs only, a
/// label that *contains* the words ("Search the wiki", a placeholder "Search…" already
/// normalises to exact) — a field's label is about what goes in it, and typing there is
/// judged by the type gate, not by this name; failing both, fuzzy ones at or above
/// `threshold`. Only visible, clickable elements count. Two candidates at the same tier
/// are two candidates: the caller decides that means no reflex.
func findMatches(in nodes: [AXNode], name: String, role: String?, threshold: Double) -> (matches: [ElementMatch], tier: String) {
    let wanted = normalizeLabel(name)
    guard !wanted.isEmpty else { return ([], "none") }
    var exact: [ElementMatch] = []
    var contains: [ElementMatch] = []
    var fuzzy: [ElementMatch] = []
    let displays = activeDisplayIDs().map { CGDisplayBounds($0) }
    for node in nodes {
        guard roleMatches(node, wanted: role) else { continue }
        guard node.pressable || clickableRoles.contains(node.role) else { continue }
        guard onSomeDisplay(node.frame, displays: displays) else { continue }
        var bestFuzzy: ElementMatch?
        var bestContains: ElementMatch?
        for raw in node.labels {
            let label = normalizeLabel(raw)
            if label.isEmpty { continue }
            if label == wanted { exact.append(ElementMatch(node: node, score: 1, label: raw)); break }
            if node.isTextInput, containsWords(label, wanted) {
                let score = Double(wanted.count) / Double(label.count)
                if score > (bestContains?.score ?? 0) { bestContains = ElementMatch(node: node, score: score, label: raw) }
            }
            let score = similarity(label, wanted)
            if score >= threshold, score > (bestFuzzy?.score ?? 0) { bestFuzzy = ElementMatch(node: node, score: score, label: raw) }
        }
        if exact.last?.node.index == node.index { continue }
        if let bestContains { contains.append(bestContains); continue }
        if let bestFuzzy { fuzzy.append(bestFuzzy) }
    }
    // The same control often appears twice in a tree (a cell and its static text child, a
    // button and its image): candidates whose frames coincide are one candidate.
    func dedupe(_ list: [ElementMatch]) -> [ElementMatch] {
        var out: [ElementMatch] = []
        for m in list.sorted(by: { $0.score > $1.score }) {
            if let f = m.node.frame, out.contains(where: { o in
                guard let g = o.node.frame else { return false }
                return abs(g.midX - f.midX) < 2 && abs(g.midY - f.midY) < 2
            }) { continue }
            out.append(m)
        }
        return out
    }
    let e = dedupe(exact)
    if !e.isEmpty { return (e, "exact") }
    let c = dedupe(contains)
    if !c.isEmpty { return (c, "contains") }
    let f = dedupe(fuzzy)
    return (f, f.isEmpty ? "none" : "fuzzy")
}

func nodeJSON(_ m: ElementMatch, app: String) -> JSONObject {
    var o = m.node.json
    o["app"] = app
    o["score"] = m.score
    o["label"] = m.label
    if let f = m.node.frame { o["center"] = pointJSON(CGPoint(x: f.midX, y: f.midY)) }
    return o
}

// MARK: - Ops

/// `find_element {name, role?, app?, maxAgeMs?, maxMs?, threshold?}` → the one control on the front window
/// with that name, or how many there were.
func opFindElement(_ params: Params) throws -> JSONObject {
    let name = try params.requireString("name")
    let role = try params.string("role")
    let maxAge = try params.double("maxAgeMs") ?? 500
    let threshold = try params.double("threshold") ?? 0.85
    let start = DispatchTime.now()
    let (snap, cached) = try AXTreeCache.shared.current(maxAgeMs: maxAge, maxNodes: try params.int("maxNodes") ?? 1500, maxDepth: try params.int("maxDepth") ?? 14, maxMs: try params.double("maxMs") ?? 250, app: try params.string("app"))
    let (matches, tier) = findMatches(in: snap.nodes, name: name, role: role, threshold: threshold)
    var out: JSONObject = [
        "app": snap.app,
        "window": snap.window,
        "found": !matches.isEmpty,
        "unique": matches.count == 1,
        "candidates": matches.count,
        "tier": tier,
        "cached": cached,
        "treeMs": snap.buildMs,
        "nodes": snap.nodes.count,
        "truncated": snap.truncated,
        "ms": elapsedMs(since: start),
    ]
    if let best = matches.first { out["element"] = nodeJSON(best, app: snap.app) }
    if matches.count > 1 { out["others"] = matches.dropFirst().prefix(5).map { nodeJSON($0, app: snap.app) } }
    return out
}

/// `ax_tree {app?, maxAgeMs?, maxNodes?, maxDepth?, maxMs?, summary?}` → the cached tree (or only its size
/// with `summary: true`, which is what keeps it warm).
func opAXTree(_ params: Params) throws -> JSONObject {
    let maxAge = try params.double("maxAgeMs") ?? 500
    let summary = try params.bool("summary") ?? false
    let (snap, cached) = try AXTreeCache.shared.current(maxAgeMs: maxAge, maxNodes: try params.int("maxNodes") ?? 1500, maxDepth: try params.int("maxDepth") ?? 14, maxMs: try params.double("maxMs") ?? 250, app: try params.string("app"))
    var out: JSONObject = [
        "app": snap.app,
        "pid": Int(snap.pid),
        "window": snap.window,
        "count": snap.nodes.count,
        "cached": cached,
        "ageMs": snap.ageMs,
        "treeMs": snap.buildMs,
        "truncated": snap.truncated,
    ]
    if !summary { out["nodes"] = snap.nodes.map { $0.json } }
    return out
}
