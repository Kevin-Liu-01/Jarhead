import SwiftUI
import AppKit

// The Console's floats: tips and menus drawn in the window, over the columns, from anchors the
// triggers publish. Nothing here opens a window. A trigger appends a `ConsoleFloat` to the
// `ConsoleFloatKey` anchor preference while it is on (`transformAnchorPreference`, so a tip on a
// menu field, or a verb's tip inside a carded row, composes with the floats under it); one
// `ConsoleFloatLayer` per window root (`ConsoleRootView.chromeA`, `OnboardingRootView`) reads them
// through `overlayPreferenceValue`, resolves each anchor in its own space and places the float
// with `ConsoleFloatPlacement`. A trigger republishes on `onGeometryChange`, so a popup follows
// its field under a rail scroll.

/// One floating surface a view asked for: who (a stable id), what kind, where (an anchor the root
/// resolves in its own space) and how to draw it. `AnyView` is taken exactly once, here, at the
/// content boundary. Equatable by id, kind and the anchor's last frame: a scroll inside a rail
/// never invalidates the root's overlay on its own, so the trigger tracks its frame with
/// `onGeometryChange` and republishes — the layer re-runs, `proxy[anchor]` re-resolves, and the
/// float follows its field.
struct ConsoleFloat: Identifiable, Equatable {
    enum Kind: Equatable { case tip, menu }
    /// Controls open below; a rail row's card opens beside it.
    enum Edge: Equatable { case below, trailing }

    let id: String
    let kind: Kind
    let edge: Edge
    let anchor: Anchor<CGRect>
    /// The trigger's frame in the window's space when it last laid out — the republish key.
    let frame: CGRect
    let content: () -> AnyView
    let dismiss: () -> Void

    static func == (a: ConsoleFloat, b: ConsoleFloat) -> Bool { a.id == b.id && a.kind == b.kind && a.frame == b.frame }
}

struct ConsoleFloatKey: PreferenceKey {
    static let defaultValue: [ConsoleFloat] = []
    static func reduce(value: inout [ConsoleFloat], nextValue: () -> [ConsoleFloat]) { value.append(contentsOf: nextValue()) }
}

/// The `previewNotification` keys the harness drives the kit with (`ConsolePreviewMain.swift`):
/// every trigger reads its own key from here, so the names live once.
enum ConsolePreviewKey {
    /// `menuOpen:<id>` → the menu field with that id opens.
    static let menuOpen = "menuOpen"
    /// `tipOpen:<id>` → the trigger with that id shows its tip pinned.
    static let tipOpen = "tipOpen"
    /// `focus:<id>` → the control with that id takes keyboard focus.
    static let focus = "focus"
    /// `fold:<id>:<open|closed>` → `["fold": id, "foldOpen": Bool]`.
    static let fold = "fold"
    static let foldOpen = "foldOpen"
    /// `chip:<kind>` → the memory rail's kind chip.
    static let chip = "chip"
    /// `highlight:<id>` → a list's focused row.
    static let highlight = "highlight"
    /// `hover:<id>` / `leave:<id>` → the pointer entering / leaving a tip's trigger (the real delay runs).
    static let hover = "hover"
    static let leave = "leave"
}

/// Where every trigger with an id last laid out, in the window's top-left space — written by
/// `ConsoleFloatPublisher` (a tip's trigger, a menu's field) as it tracks its frame. The layer's
/// monitor reads a menu's field from it (a mouse-down on the field is the field's toggle, not an
/// outside click); the harness's `click:<id>` hits the centre of an entry.
enum ConsoleClickTargets {
    @MainActor static var frames: [String: CGRect] = [:]
}

/// The harness's ear for what a click did: `press: <verb>` from the Console's actions,
/// `menu-pick: <id> <value>` from a field's pick, `menu: opened|closed <id>` from a field.
/// nil in the app.
enum ConsolePress {
    @MainActor static var report: ((String) -> Void)?

    /// A command's or a press's bare word: the enum case without its payload (`sayText`, `go`).
    static func word(_ value: Any) -> String {
        String(String(describing: value).prefix { $0 != "(" })
    }
}

/// Where the layer put a float, handed to its content through the environment so a tip's bubble
/// draws its arrow on the facing edge, pointing at the anchor. `.zero` until the slot has placed it.
struct ConsoleFloatGeometry: Equatable {
    var side: ConsoleFloatPlacement.Side = .below
    /// The arrow's centre along the facing edge, in the float's own space.
    var arrowOffset: CGFloat = ConsoleFloatPlacement.radius + 4
    var rect: CGRect = .zero
}

private struct ConsoleFloatGeometryKey: EnvironmentKey {
    static let defaultValue = ConsoleFloatGeometry()
}

extension EnvironmentValues {
    var consoleFloatGeometry: ConsoleFloatGeometry {
        get { self[ConsoleFloatGeometryKey.self] }
        set { self[ConsoleFloatGeometryKey.self] = newValue }
    }
}

extension View {
    /// Publish a float while `on`; this view is its anchor. The trigger owns `on` (its @State)
    /// and `dismiss` is how the layer asks it to let go (an outside click, a ⌘-key, the window
    /// leaving key).
    func consoleFloat<C: View>(_ id: String, kind: ConsoleFloat.Kind, edge: ConsoleFloat.Edge = .below, on: Bool,
                               dismiss: @escaping () -> Void, @ViewBuilder content: @escaping () -> C) -> some View {
        modifier(ConsoleFloatPublisher(id: id, kind: kind, edge: edge, on: on, dismiss: dismiss, content: content))
    }

    /// Installed once per window root, after everything the floats must draw over.
    func consoleFloatLayer() -> some View {
        overlayPreferenceValue(ConsoleFloatKey.self) { floats in ConsoleFloatLayer(floats: floats) }
    }
}

/// The trigger's half: its frame tracked (so a scroll republishes) and the float appended to the
/// subtree's floats while `on` — appended, never replacing, so a publisher above another (a tip on
/// a menu field, a row's card over its verbs' tips) keeps what its descendants published. The
/// innermost publisher transforms first, so the deepest float is first in the array.
struct ConsoleFloatPublisher<C: View>: ViewModifier {
    let id: String
    let kind: ConsoleFloat.Kind
    let edge: ConsoleFloat.Edge
    let on: Bool
    let dismiss: () -> Void
    let content: () -> C
    @State private var frame: CGRect = .zero

    func body(content view: Content) -> some View {
        view
            .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .global) }) { moved(to: $0) }
            .onDisappear { ConsoleClickTargets.frames[id] = nil }
            .transformAnchorPreference(key: ConsoleFloatKey.self, value: .bounds) { floats, anchor in
                if on { floats.append(ConsoleFloat(id: id, kind: kind, edge: edge, anchor: anchor, frame: frame, content: { AnyView(content()) }, dismiss: dismiss)) }
            }
    }

    /// A menu follows its field (the frame is the republish key); a tip lets go when its anchor
    /// moves (a scroll under the pointer) — NSMenu-like, and never a stale arrow. The trigger's
    /// frame is also the click target the monitor and the harness read by id.
    private func moved(to next: CGRect) {
        let was = frame
        frame = next
        ConsoleClickTargets.frames[id] = next
        if on, kind == .tip, was != .zero, was != next { dismiss() }
    }
}

/// Draws the floats over the whole root. While a menu is open only the menu is drawn (tips never
/// sit beside a menu). Nothing here takes a click: a tip never did, and a menu closes on the
/// mouse-DOWN outside it (the monitor's) and lets that down through, so the control under the
/// pointer — another field, Stop, a row — acts on the same click. Of several tips only the
/// innermost draws (the first published: the ⋯'s `More`, not the row's card under the same
/// pointer) — one float at a time. Everything goes when the window stops being key; one event
/// monitor lives while anything is open.
struct ConsoleFloatLayer: View {
    let floats: [ConsoleFloat]
    @Environment(\.controlActiveState) private var active
    @State private var monitor = ConsoleFloatMonitor()

    /// The harness pins this on so a shot behind the lock screen (the window inactive) keeps its floats.
    @MainActor static var holdWhileInactive = false

    private var menu: ConsoleFloat? { floats.first { $0.kind == .menu } }
    private var shown: [ConsoleFloat] { Self.shown(floats) }

    /// The menu alone while one is open; else the innermost tip alone (the first published).
    static func shown(_ floats: [ConsoleFloat]) -> [ConsoleFloat] {
        if let menu = floats.first(where: { $0.kind == .menu }) { return [menu] }
        return floats.first.map { [$0] } ?? []
    }

    /// Whether the layer puts anything under a float that would take a click meant for the
    /// control beneath — never: a tip is not hit-testable and a menu dismisses on the mouse-down
    /// and lets it through. Pure, and pinned by `check-kit` so a window-wide catcher cannot return.
    static func catches(kind: ConsoleFloat.Kind) -> Bool {
        switch kind {
        case .tip: return false
        case .menu: return false
        }
    }

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .topLeading) {
                ForEach(shown) { f in
                    ConsoleFloatSlot(float: f, anchor: proxy[f.anchor], bounds: proxy.frame(in: .local))
                        .zIndex(f.kind == .menu ? 2 : 1)
                }
            }
        }
        .animation(.easeOut(duration: Motion.instant), value: shown.map(\.id))
        .onChange(of: active) { if active != .key, !Self.holdWhileInactive { floats.forEach { $0.dismiss() } } }
        .onChange(of: floats.map(\.id)) { monitor.set(floats); closeTipsUnderMenu() }
    }

    /// A menu opening takes the tips with it: none draws beside a menu, and none waits behind one.
    private func closeTipsUnderMenu() {
        guard menu != nil else { return }
        floats.filter { $0.kind == .tip }.forEach { $0.dismiss() }
    }
}

/// Measures its content once, places it with `ConsoleFloatPlacement` and offsets it there. The
/// content is `.fixedSize()`, so the overlay never proposes a size to the window. Writes the
/// placed rect to `ConsoleFloatSlot.placed` for the harness's `probe-floats:`.
struct ConsoleFloatSlot: View {
    let float: ConsoleFloat
    let anchor: CGRect
    let bounds: CGRect
    @State private var size: CGSize = .zero

    /// The last rect each float was placed at (`probe-floats:` prints them; the layer writes them).
    @MainActor static var placed: [String: CGRect] = [:]

    var body: some View {
        let side = ConsoleFloatPlacement.side(anchor: anchor, size: size, bounds: bounds, edge: float.edge)
        let rect = ConsoleFloatPlacement.rect(anchor: anchor, size: size, bounds: bounds, edge: float.edge)
        let arrow = ConsoleFloatPlacement.arrowOffset(anchor: anchor, rect: rect, side: side)
        float.content()
            .environment(\.consoleFloatGeometry, ConsoleFloatGeometry(side: side, arrowOffset: arrow, rect: rect))
            .fixedSize()
            .onGeometryChange(for: CGSize.self, of: \.size) { size = $0 }
            .offset(x: rect.minX, y: rect.minY)
            .allowsHitTesting(float.kind == .menu)
            .accessibilityHidden(float.kind == .tip)
            .transition(.opacity)
            .onChange(of: rect, initial: true) { Self.placed[float.id] = rect }
            .onDisappear { Self.placed[float.id] = nil }
    }
}

/// One local event monitor while any float is open. It only observes (every event is returned
/// unchanged, so the control under the pointer still gets it) and it only looks at the key
/// window: a tip dismisses on any mouse-down, wheel or key-down; a menu on a ⌘ key-down (the
/// window's shortcut is about to run), on a wheel outside itself — a wheel over the popup scrolls
/// its list — and on a mouse-down outside both the popup and its own field. The field is left to
/// its Button: its click toggles the menu closed once (a dismiss here too would close on the down
/// and reopen on the up). Every test is a rect-contains in the root's top-left space, never a clock.
@MainActor
final class ConsoleFloatMonitor {
    private var token: Any?
    private var floats: [ConsoleFloat] = []

    private static let downs: Set<NSEvent.EventType> = [.leftMouseDown, .rightMouseDown, .otherMouseDown]

    func set(_ floats: [ConsoleFloat]) {
        self.floats = floats
        if floats.isEmpty { remove(); return }
        guard token == nil else { return }
        token = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel, .keyDown]) { [weak self] event in
            self?.observe(event)
            return event
        }
    }

    /// The key window's events — or, while the app is inactive and has no key window, the event's
    /// own window: a local monitor only ever sees this app's events, and a float open in an
    /// inactive window is one `holdWhileInactive` kept (the harness's shots and clicks).
    private func observe(_ event: NSEvent) {
        guard let window = event.window, window === NSApp.keyWindow || NSApp.keyWindow == nil else { return }
        let command = event.type == .keyDown && event.modifierFlags.contains(.command)
        for f in floats {
            switch f.kind {
            case .tip: f.dismiss()
            case .menu: if command || Self.outside(f, event: event, window: window) { f.dismiss() }
            }
        }
    }

    /// A wheel or a mouse-down that misses the menu: off the popup, and — for a down — off the
    /// field that owns it too.
    static func outside(_ f: ConsoleFloat, event: NSEvent, window: NSWindow) -> Bool {
        if event.type == .scrollWheel { return !inside(f.id, event: event, window: window) }
        guard downs.contains(event.type) else { return false }
        return !inside(f.id, event: event, window: window) && !onField(f, event: event, window: window)
    }

    /// Whether the wheel is over the float: the event's point flipped into the root's top-left
    /// space and tested against the rect the layer placed it at (an unplaced float is outside).
    static func inside(_ id: String, event: NSEvent, window: NSWindow) -> Bool {
        guard let rect = ConsoleFloatSlot.placed[id], let content = window.contentView else { return false }
        return rect.contains(point(of: event, in: content))
    }

    /// Whether the down is on the menu's own field: the frame its publisher tracks (the float's
    /// `frame` when the tracker has nothing newer), the same space as the placed rect.
    static func onField(_ f: ConsoleFloat, event: NSEvent, window: NSWindow) -> Bool {
        guard let content = window.contentView else { return false }
        let field = ConsoleClickTargets.frames[f.id] ?? f.frame
        return field.contains(point(of: event, in: content))
    }

    /// The event's point flipped into the root's top-left space.
    private static func point(of event: NSEvent, in content: NSView) -> CGPoint {
        CGPoint(x: event.locationInWindow.x, y: content.bounds.height - event.locationInWindow.y)
    }

    private func remove() {
        if let token { NSEvent.removeMonitor(token) }
        token = nil
    }
}
