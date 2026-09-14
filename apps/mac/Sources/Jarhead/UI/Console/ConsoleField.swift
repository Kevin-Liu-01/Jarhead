import SwiftUI

// The Console's text-field chrome, moved verbatim from ConsoleTheme.swift (kit step 0).
// Builder B grows this into `ConsoleField` / `ConsoleFilterField` / `ConsoleSecretRow`.

/// Text field chrome: 6pt box, hairline at rest, accent ring while focused; the
/// one ring turns red while `error` (a rejected passphrase), never a second stroke.
/// `grows` is for a `TextField(axis: .vertical)`: `height` becomes the minimum and
/// the box wraps with the text instead of clipping it.
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
