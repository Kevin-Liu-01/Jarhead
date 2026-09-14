import SwiftUI

// TEMPORARY — kit step 0's spike, kept so the next wave can drive the layer before a real menu
// field lands (Builder A's `menu-escape` / `menu-outside`, Builder B's Voice field). Mounted at
// both roots only while `ConsoleFloatSpike.enabled` (the harness's `kit-spike` scenario sets it);
// the app never sees it. Delete this file when `ConsoleMenuField` opens on the layer.

enum ConsoleFloatSpikeWords {
    static let one = "One"
    static let two = "Two"
    static let field = "Spike"
    static let id = "kit.spike"
}

/// The spike's mount: a small box over the stream with a scrolling rail of twelve rows, the
/// field on the fourth (the box's last visible row), so `spikeScroll:2` moves it 48 pt up
/// while it stays in view and the popup's anchor is tested under a real scroll.
enum ConsoleFloatSpike {
    @MainActor static var enabled = false
    /// The harness's ear: every key the popup took, every open / close, printed as `spike:` lines.
    @MainActor static var report: ((String) -> Void)?
    /// `spikeScroll:<row>` → the rail scrolls that row to its top.
    static let scrollKey = "spikeScroll"

    @MainActor @ViewBuilder static func mount() -> some View {
        if enabled { ConsoleFloatSpikeRail().padding(.top, 60).padding(.leading, 300) }
    }
}

struct ConsoleFloatSpikeRail: View {
    @State private var target: Int?

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.vertical) {
                VStack(spacing: 0) {
                    ForEach(0..<12, id: \.self) { row in
                        if row == 3 { ConsoleFloatSpikeField().id(row) } else { Color.clear.frame(height: 24).id(row) }
                    }
                }
            }
            .frame(width: 200, height: 96)
            .background(RoundedRectangle(cornerRadius: 6).fill(ConsoleTheme.raised))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(ConsoleTheme.hair, lineWidth: 1))
            .onReceive(NotificationCenter.default.publisher(for: ConsoleSession.previewNotification)) { note in
                guard let row = note.userInfo?[ConsoleFloatSpike.scrollKey] as? Int else { return }
                proxy.scrollTo(row, anchor: .top)
                ConsoleFloatSpike.report?("scroll → row \(row) at top")
            }
        }
    }
}

/// The field: opens on click, Space, Return or ↓ — and on `menuOpen:kit.spike` from the harness.
struct ConsoleFloatSpikeField: View {
    @State private var open = false
    @State private var picked = ConsoleFloatSpikeWords.one

    var body: some View {
        Button { open = true } label: {
            HStack(spacing: 6) {
                Text(picked).font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg)
                Spacer(minLength: 4)
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 9, weight: .semibold)).foregroundStyle(ConsoleTheme.fg3)
            }
            .padding(.horizontal, 8).frame(height: 24)
            .background(RoundedRectangle(cornerRadius: 6).fill(ConsoleTheme.ground))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(open ? ConsoleTheme.accent : ConsoleTheme.hair, lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 8)
        .accessibilityLabel(ConsoleFloatSpikeWords.field)
        .consoleFloat(ConsoleFloatSpikeWords.id, kind: .menu, on: open, dismiss: { close("dismissed by the layer") }) {
            ConsoleFloatSpikePopup(rows: [ConsoleFloatSpikeWords.one, ConsoleFloatSpikeWords.two], current: picked) { pick in
                if let pick { picked = pick }
                close(pick.map { "picked \($0)" } ?? "escape")
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: ConsoleSession.previewNotification)) { note in
            guard note.userInfo?[ConsolePreviewKey.menuOpen] as? String == ConsoleFloatSpikeWords.id else { return }
            open = true
            ConsoleFloatSpike.report?("open")
        }
    }

    private func close(_ why: String) {
        open = false
        ConsoleFloatSpike.report?("closed — \(why)")
    }
}

/// Two rows, `.focusable()`, taking ↑↓ / Return / Esc through `.onKeyPress`. Focus is asked for
/// one hop after it appears (the one-hop-later idiom), and every key it takes is reported.
struct ConsoleFloatSpikePopup: View {
    let rows: [String]
    let current: String
    let finish: (String?) -> Void
    @State private var highlight = 0
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                ConsoleFloatSpikeRow(title: row, selected: row == current, highlighted: index == highlight) { finish(row) }
            }
        }
        .padding(.vertical, 4)
        .frame(width: 200)
        .background(RoundedRectangle(cornerRadius: 6).fill(ConsoleTheme.raised))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(ConsoleTheme.hair, lineWidth: 1))
        .padding(ConsoleTheme.seam)
        .background(RoundedRectangle(cornerRadius: 6 + ConsoleTheme.seam).fill(ConsoleTheme.ground))
        .focusable()
        .focusEffectDisabled()
        .focused($focused)
        .modifier(ConsoleFloatSpikeKeys(count: rows.count, highlight: $highlight, pick: { finish(rows[highlight]) }, escape: { finish(nil) }))
        .onAppear { DispatchQueue.main.async { focused = true } }
        .onChange(of: focused) { ConsoleFloatSpike.report?("focus \(focused ? "in" : "out")") }
    }
}

struct ConsoleFloatSpikeRow: View {
    let title: String
    let selected: Bool
    let highlighted: Bool
    let tap: () -> Void

    var body: some View {
        Button(action: tap) {
            HStack(spacing: 0) {
                RoundedRectangle(cornerRadius: 1).fill(selected ? ConsoleTheme.accent : .clear).frame(width: 2).padding(.vertical, 4)
                Text(title).font(ConsoleTheme.sans(12, selected ? .medium : .regular)).foregroundStyle(ConsoleTheme.fg).padding(.leading, 10)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 4)
            .frame(height: 26)
            .background(highlighted ? ConsoleTheme.lift : .clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

struct ConsoleFloatSpikeKeys: ViewModifier {
    let count: Int
    @Binding var highlight: Int
    let pick: () -> Void
    let escape: () -> Void

    func body(content: Content) -> some View {
        content
            .onKeyPress(.downArrow) { move(1); return .handled }
            .onKeyPress(.upArrow) { move(-1); return .handled }
            .onKeyPress(.return) { ConsoleFloatSpike.report?("return → pick \(highlight)"); pick(); return .handled }
            .onKeyPress(.escape) { ConsoleFloatSpike.report?("escape"); escape(); return .handled }
    }

    private func move(_ delta: Int) {
        // Computed once and reported from the local: a @Binding read straight after its write can
        // still answer the old value inside the same event (the spike's first run showed it).
        let next = min(max(highlight + delta, 0), count - 1)
        highlight = next
        ConsoleFloatSpike.report?("\(delta > 0 ? "down" : "up") → highlight \(next)")
    }
}
