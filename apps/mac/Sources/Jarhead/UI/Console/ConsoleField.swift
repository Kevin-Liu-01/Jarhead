import SwiftUI
import AppKit

// The Console's text field: one struct, four heights, one blur rule. `ground` flat, one hairline
// that turns accent while focused and red (with a shake) on a rejection — never a second stroke.
// A leading glyph (the magnifier, a key), a trailing slot (× while text · a count · a 22 pt verb),
// and the commit rule spelled once (`ConsoleField.Commit`): Return commits · Esc cancels · focus
// leaving commits · an empty commit reverts to the last value unless the site says `emptyClears`.
// `ConsoleFilterField` is the `.filter` face with the magnifier, the count and ↑↓ forwarded;
// `ConsoleSecretRow` the three faces of a key that is written and never read back. `ConsoleFormRow`
// and `ConsoleHint` are the form's two shared pieces (they absorb the wizard's copies).

enum ConsoleFieldWords {
    static let clear = "Clear"
    static let change = "Change"
    static let save = "Save"
    static let set = "Set"
    static let saving = "Saving…"
    static let onFile = "on file"
    static let secretHint = "Written once, never shown again"
    static let magnifier = "magnifyingglass"
    static let cross = "xmark"
}

/// Text field chrome as a modifier — the old spelling, kept for the sites the other builders
/// migrate in their own wave (`.consoleField(mono:height:focused:error:grows:)`).
struct ConsoleFieldModifier: ViewModifier {
    var mono = false
    var height: CGFloat = 32
    var focused = false
    var error = false
    var grows = false

    func body(content: Content) -> some View {
        content
            .textFieldStyle(.plain)
            .font(mono ? ConsoleTheme.mono(12) : ConsoleTheme.sans(13))
            .foregroundStyle(ConsoleTheme.fg)
            .tint(ConsoleTheme.accent)
            .padding(.horizontal, 10)
            .padding(.vertical, grows ? 5 : 0)
            .frame(minHeight: height, maxHeight: grows ? nil : height)
            .background(RoundedRectangle(cornerRadius: 6).fill(ConsoleTheme.ground))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(error ? ConsoleTheme.error : (focused ? ConsoleTheme.accent : ConsoleTheme.hair), lineWidth: 1))
            // The ring answers focus and a rejection at once.
            .animation(Motion.snappy, value: error)
            .animation(Motion.snappy, value: focused)
    }
}

extension View {
    func consoleField(mono: Bool = false, height: CGFloat = 32, focused: Bool = false, error: Bool = false, grows: Bool = false) -> some View {
        modifier(ConsoleFieldModifier(mono: mono, height: height, focused: focused, error: error, grows: grows))
    }
}

/// One field, four heights. Owns its focus so the blur rule lives here; a site that must move
/// focus itself passes `focus:` (a `FocusState<Bool>.Binding`) and the field follows it.
struct ConsoleField: View {
    enum Size { case edit, filter, row, composer }
    struct Commit { var emptyClears = false }
    enum Trailing {
        case none
        /// × while there is text.
        case clear
        /// `k of n` mono 11 titanium.
        case count(String)
        /// A 22 pt verb (`Save`, `Set`, `Apply`): primary while there is text, else ghost.
        case verb(String, primary: Bool, () -> Void)
    }

    @Binding var text: String
    let placeholder: String
    var size: Size = .row
    var mono = false
    var grows = false
    var secure = false
    /// An SF Symbol at 11 in the leading slot (the magnifier, a key).
    var lead: String? = nil
    var trailing: Trailing = .none
    var error = false
    var commit = Commit()
    /// `focus:<id>` from the harness lands here.
    var id: String? = nil
    var accessibilityLabel: String? = nil
    var onCommit: () -> Void = {}
    var onCancel: () -> Void = {}
    var onMove: ((MoveCommandDirection) -> Void)? = nil

    @FocusState private var focused: Bool
    @State private var last = ""
    @State private var shakes: CGFloat = 0

    static func height(_ size: Size) -> CGFloat {
        switch size {
        case .edit: return 22
        case .filter: return 24
        case .row: return 26
        case .composer: return 32
        }
    }

    static func font(_ size: Size, mono: Bool) -> Font {
        if mono { return ConsoleTheme.mono(12) }
        return size == .composer || size == .row ? ConsoleTheme.sans(13) : ConsoleTheme.sans(12)
    }

    var body: some View {
        ConsoleFieldBox(size: size, focused: focused, error: error, grows: grows, shakes: shakes) {
            HStack(spacing: 6) {
                if let lead { Image(systemName: lead).font(.system(size: 11, weight: .medium)).foregroundStyle(ConsoleTheme.fg3) }
                input
                ConsoleFieldTrailing(trailing: trailing, hasText: !text.isEmpty, clear: { text = ""; onCommitIfClears() })
            }
        }
        .onChange(of: focused) { was, now in blur(was: was, now: now) }
        .onChange(of: error) { if error { withAnimation(Motion.snappy) { shakes += 1 } } }
        .onReceive(NotificationCenter.default.publisher(for: ConsoleSession.previewNotification)) { note in
            if let id, note.userInfo?[ConsolePreviewKey.focus] as? String == id { focused = true }
        }
    }

    @ViewBuilder private var input: some View {
        Group {
            if secure {
                SecureField(placeholder, text: $text)
            } else if grows {
                TextField(placeholder, text: $text, axis: .vertical)
            } else {
                TextField(placeholder, text: $text)
            }
        }
        .textFieldStyle(.plain)
        .font(Self.font(size, mono: mono))
        .foregroundStyle(ConsoleTheme.fg)
        .tint(ConsoleTheme.accent)
        .focused($focused)
        .onSubmit(submit)
        .onExitCommand(perform: cancel)
        .onMoveCommand { direction in onMove?(direction) }
        .accessibilityLabel(accessibilityLabel ?? placeholder)
    }

    private func onCommitIfClears() { if commit.emptyClears { onCommit() } }

    /// Return: an empty commit reverts; otherwise commit and let go of focus.
    private func submit() {
        if text.isEmpty, !commit.emptyClears { text = last; focused = false; return }
        last = text
        onCommit()
        focused = false
    }

    private func cancel() {
        text = last
        onCancel()
        focused = false
    }

    /// Focus arriving remembers the value; focus leaving commits (or reverts an empty field).
    private func blur(was: Bool, now: Bool) {
        if now { last = text; return }
        guard was else { return }
        if text.isEmpty, !commit.emptyClears { text = last; return }
        if text != last { last = text; onCommit() }
    }
}

/// The box: ground flat, the one ring (hair → accent → red), radius 6, the shake on a rejection.
struct ConsoleFieldBox<C: View>: View {
    let size: ConsoleField.Size
    let focused: Bool
    let error: Bool
    let grows: Bool
    let shakes: CGFloat
    @ViewBuilder let content: () -> C

    private var ring: Color { error ? ConsoleTheme.error : (focused ? ConsoleTheme.accent : ConsoleTheme.hair) }

    var body: some View {
        let h = ConsoleField.height(size)
        content()
            .padding(.horizontal, size == .edit ? 8 : 10)
            .padding(.vertical, grows ? 5 : 0)
            .frame(minHeight: h, maxHeight: grows ? nil : h)
            .background(RoundedRectangle(cornerRadius: 6).fill(ConsoleTheme.ground))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(ring, lineWidth: 1))
            .modifier(ConsoleShake(shakes: shakes))
            .animation(Motion.snappy, value: error)
            .animation(Motion.snappy, value: focused)
    }
}

/// The trailing slot: nothing · × while text · a count · a verb (primary while there is text).
struct ConsoleFieldTrailing: View {
    let trailing: ConsoleField.Trailing
    let hasText: Bool
    let clear: () -> Void

    var body: some View {
        switch trailing {
        case .none:
            EmptyView()
        case .clear:
            if hasText {
                Button(action: clear) { Image(systemName: ConsoleFieldWords.cross).font(.system(size: 9, weight: .semibold)) }
                    .buttonStyle(ConsoleButtonStyle(kind: .plain, iconOnly: true, height: 18))
                    .consoleHelp(ConsoleFieldWords.clear)
                    .accessibilityLabel(ConsoleFieldWords.clear)
                    .transition(.opacity)
            }
        case .count(let word):
            Text(word).font(ConsoleTheme.mono(11)).monospacedDigit().foregroundStyle(ConsoleTheme.titanium)
                .contentTransition(.opacity)
        case .verb(let word, let primary, let run):
            Button(word, action: run)
                .buttonStyle(ConsoleButtonStyle(kind: primary && hasText ? .primary : .ghost, height: 22, small: true))
                .disabled(!hasText)
        }
    }
}

/// `.filter` with the magnifier, the count (`n` at rest → `k of n` while typing), × while text,
/// ↑↓ / Return / Esc forwarded to the list that owns it. Filtering is the owner's: the popup's is
/// local (no debounce); a rail's search debounces 250 ms itself (`ConsoleSession`).
struct ConsoleFilterField: View {
    @Binding var text: String
    let placeholder: String
    var count: String? = nil
    var focus: FocusState<Bool>.Binding
    var accessibilityLabel: String? = nil
    var onMove: (MoveCommandDirection) -> Void = { _ in }
    var onSubmit: () -> Void = {}
    /// Esc: the owner clears the text if any, else closes.
    var onExit: () -> Void = {}

    var body: some View {
        ConsoleFieldBox(size: .filter, focused: focus.wrappedValue, error: false, grows: false, shakes: 0) {
            HStack(spacing: 6) {
                Image(systemName: ConsoleFieldWords.magnifier).font(.system(size: 11, weight: .medium)).foregroundStyle(ConsoleTheme.fg3)
                TextField(placeholder, text: $text)
                    .textFieldStyle(.plain)
                    .font(ConsoleTheme.sans(12))
                    .foregroundStyle(ConsoleTheme.fg)
                    .tint(ConsoleTheme.accent)
                    .focused(focus)
                    .onSubmit(onSubmit)
                    .onExitCommand(perform: onExit)
                    .onMoveCommand(perform: onMove)
                    .accessibilityLabel(accessibilityLabel ?? placeholder)
                if let count { ConsoleFieldTrailing(trailing: .count(count), hasText: !text.isEmpty, clear: {}) }
                ConsoleFieldTrailing(trailing: .clear, hasText: !text.isEmpty, clear: { text = "" })
            }
        }
        .animation(ConsoleMotion.hover, value: text.isEmpty)
    }
}

// MARK: - Secret row

/// A secret that is written, never read back: the field with its verb until a key is on file,
/// `Saving…` while the engine writes it, then a dot, `on file`, Change — and the env var it
/// went to as a mono line under (today a tooltip). A rejection is the red ring, a shake and a
/// red hint under the field.
struct ConsoleSecretRow: View {
    let placeholder: String
    let onFile: Bool
    var saving = false
    /// `ANTHROPIC_API_KEY` — printed under the on-file face.
    var envVar: String? = nil
    var statusColor: Color = ConsoleTheme.acting
    var statusText: String = ConsoleFieldWords.onFile
    var verb: String = ConsoleFieldWords.save
    /// The red hint under the field (a rejected passphrase); the ring turns red with it.
    var error: String? = nil
    var id: String? = nil
    var accessibilityLabel: String? = nil
    let save: (String) -> Void

    @State private var text = ""
    @State private var editing = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if saving {
                ConsoleSecretSaving()
            } else if onFile, !editing {
                ConsoleSecretOnFile(color: statusColor, text: statusText, envVar: envVar) { editing = true }
            } else {
                ConsoleField(text: $text, placeholder: placeholder, size: .row, mono: true, secure: true,
                             trailing: .verb(verb, primary: true, submit), error: error != nil, id: id,
                             accessibilityLabel: accessibilityLabel ?? placeholder, onCommit: submit, onCancel: { editing = false })
                if let error {
                    ConsoleHint(error, tone: ConsoleTheme.error, indent: 0).transition(Motion.appear)
                }
            }
        }
        .animation(Motion.gentle, value: saving)
        .animation(Motion.gentle, value: onFile)
        .animation(Motion.gentle, value: error)
        .onChange(of: onFile) { if onFile { editing = false } }
    }

    private func submit() {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        save(value)
        text = ""
    }
}

struct ConsoleSecretSaving: View {
    var body: some View {
        HStack(spacing: 8) {
            ConsoleDot(color: ConsoleTheme.thinking, live: true, size: 6)
            Text(ConsoleFieldWords.saving).font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg2)
        }
        .frame(height: 26)
        .transition(.opacity)
    }
}

struct ConsoleSecretOnFile: View {
    let color: Color
    let text: String
    let envVar: String?
    let change: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 8) {
                ConsoleDot(color: color, size: 6)
                Text(text).font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg2).contentTransition(.opacity)
                Spacer(minLength: 8)
                Button(ConsoleFieldWords.change, action: change)
                    .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 22, small: true))
                    .consoleHelp(ConsoleFieldWords.secretHint)
            }
            .frame(height: 26)
            if let envVar {
                Text(envVar).font(ConsoleTheme.mono(10)).foregroundStyle(ConsoleTheme.fg3).lineLimit(1)
            }
        }
        .transition(.opacity)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Form pieces

/// A key on the left, a control on the right: 28 tall, the key 80 wide (the wizard passes 88).
/// The label centres on the control's first `height`, so a field with a hint under it keeps
/// its label on the field, not on the gap.
struct ConsoleFormRow<C: View>: View {
    let label: String
    var keyWidth: CGFloat = 80
    var height: CGFloat = 28
    let control: C

    init(_ label: String, keyWidth: CGFloat = 80, height: CGFloat = 28, @ViewBuilder control: () -> C) {
        self.label = label
        self.keyWidth = keyWidth
        self.height = height
        self.control = control()
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Text(label).font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.titanium)
                .frame(width: keyWidth, height: height, alignment: .leading)
            control.frame(maxWidth: .infinity, minHeight: height, alignment: .leading)
        }
    }
}

/// One quiet line under a control: sans 11 titanium, indented to the control column (90 in the
/// rail; the wizard's rows pass their own), red for a rejection.
struct ConsoleHint: View {
    let text: String
    var tone: Color = ConsoleTheme.titanium
    var indent: CGFloat = 90

    init(_ text: String, tone: Color = ConsoleTheme.titanium, indent: CGFloat = 90) {
        self.text = text
        self.tone = tone
        self.indent = indent
    }

    var body: some View {
        Text(text).font(ConsoleTheme.sans(11)).lineSpacing(1).foregroundStyle(tone)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.leading, indent)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentTransition(.opacity)
    }
}
