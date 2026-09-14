import SwiftUI

// The Console's dropdown, moved verbatim from ConsoleTheme.swift (kit step 0). The struct keeps
// its name and first seven parameters; Builder B rebuilds its body on the float layer.

/// A picker drawn as a field: value, chevron, hairline box; the menu lists the options.
/// `fieldTitle` is the collapsed label when the full title is too long for the field; `dim`
/// names the options drawn quiet (a model that does not fit this Mac) — still pickable.
struct ConsoleMenuField<Value: Hashable>: View {
    let value: Value
    let options: [Value]
    let title: (Value) -> String
    let pick: (Value) -> Void
    var mono = false
    var fieldTitle: ((Value) -> String)? = nil
    var dim: ((Value) -> Bool)? = nil

    @State private var hovering = false

    private func isDim(_ option: Value) -> Bool {
        guard let dim else { return false }
        return dim(option)
    }

    var body: some View {
        Menu {
            Picker("", selection: Binding(get: { value }, set: { pick($0) })) {
                ForEach(options, id: \.self) { option in
                    Text(title(option)).foregroundStyle(isDim(option) ? ConsoleTheme.fg3 : ConsoleTheme.fg).tag(option)
                }
            }
            .pickerStyle(.inline)
            .labelsHidden()
        } label: {
            HStack(spacing: 6) {
                Text((fieldTitle ?? title)(value))
                    .font(mono ? ConsoleTheme.mono(12) : ConsoleTheme.sans(12))
                    .foregroundStyle(ConsoleTheme.fg)
                    .lineLimit(1).truncationMode(.tail)
                Spacer(minLength: 4)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(ConsoleTheme.fg3)
            }
            .padding(.horizontal, 8)
            .frame(height: 26)
            .frame(maxWidth: .infinity)
            .background(RoundedRectangle(cornerRadius: 6).fill(hovering ? ConsoleTheme.hover : .clear))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(ConsoleTheme.hair, lineWidth: 1))
            .contentShape(Rectangle())
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .onHover { hovering = $0 }
        .animation(ConsoleMotion.hover, value: hovering)
    }
}
