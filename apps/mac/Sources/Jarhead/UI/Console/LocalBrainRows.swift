import AppKit
import SwiftUI

// The Local model brain's rows, shared by Settings › Brain (RightRailView) and the Setup
// wizard's Brain step (OnboardingSteps): the Model menu over what the server lists, the Server
// field for a pinned root, the one-line status note with its Copy chip, and the "Leaves the Mac"
// rows. Every title is a helper `func` on `LocalBrainWords`, never an inline closure with `??`,
// and every row is its own small struct — the CI runner's older Swift type-checker gives up on
// large single expressions (memory: jarhead-ci-swift-typecheck-limits). Nothing here installs,
// pulls or runs anything: the chip copies a command Kevin runs himself.

private let iconGap: CGFloat = 8

/// The pure words of the Local rows, so the console preview's `check-local` lines can pin them
/// without a window (the package has no test target).
enum LocalBrainWords {
    /// Bytes → "17 GB" / "6.6 GB" (one decimal under 10 GB).
    static func gigabytes(_ bytes: Double) -> String {
        let gb = bytes / 1e9
        if gb >= 10 { return "\(Int(gb.rounded())) GB" }
        return String(format: "%.1f GB", gb)
    }

    /// The fit as one or two words beside a model.
    static func fitWord(_ fit: LocalFit) -> String {
        switch fit {
        case .good: return "fits"
        case .tight: return "tight fit"
        case .no: return "too big"
        case .unknown: return "size unknown"
        }
    }

    /// "Ollama 0.34.0" / "LM Studio" / "local server" — the server as the rows name it.
    static func serverName(_ status: LocalServerStatus) -> String {
        let flavor = status.flavor ?? .unknown
        if let v = status.version, !v.isEmpty { return "\(flavor.name) \(v)" }
        return flavor.name
    }

    /// The root without its scheme: "127.0.0.1:11434".
    static func host(_ baseUrl: String) -> String {
        var s = baseUrl
        for prefix in ["https://", "http://"] where s.hasPrefix(prefix) { s = String(s.dropFirst(prefix.count)) }
        while s.hasSuffix("/") { s.removeLast() }
        return s
    }

    /// The menu's rows: "" (best fit) always first — the setting's own default, so a pin is
    /// one click to undo when a newer model lands and the engine's pick should move again —
    /// the tool-capable models best fit first, then the saved id when the server does not
    /// list it (the `voiceOptions` idiom: a pick never shows nothing).
    static func modelOptions(saved: String, status: LocalServerStatus) -> [String] {
        var ids = status.pickable.map(\.id)
        ids.insert("", at: 0)
        if !saved.isEmpty, !ids.contains(saved) { ids.append(saved) }
        return ids
    }

    /// One menu row: "qwen3.5:27b  ·  17 GB · fits"; the best-fit row names the engine's pick;
    /// a saved id the server does not list says so.
    static func modelTitle(_ id: String, status: LocalServerStatus) -> String {
        if id.isEmpty {
            if let picked = status.picked, !picked.isEmpty { return "best fit · \(picked)" }
            return "best fit"
        }
        guard let model = status.models.first(where: { $0.id == id }) else {
            return status.reachable ? "\(id) · not on \(serverName(status))" : id
        }
        if let bytes = model.sizeBytes { return "\(id)  ·  \(gigabytes(bytes)) · \(fitWord(model.fit))" }
        return "\(id)  ·  \(fitWord(model.fit))"
    }

    /// The collapsed field: "best fit · qwen3.5:27b" while the engine picks, "pick a model" when
    /// nothing on the server can call tools, else the saved id.
    static func collapsedTitle(saved: String, status: LocalServerStatus) -> String {
        if !saved.isEmpty { return saved }
        if let picked = status.picked, !picked.isEmpty { return "best fit · \(picked)" }
        return "pick a model"
    }

    /// A row drawn quiet: a model that does not fit this Mac.
    static func isDim(_ id: String, status: LocalServerStatus) -> Bool {
        guard let model = status.models.first(where: { $0.id == id }) else { return false }
        return model.fit == .no
    }

    /// The Server field's placeholder: the discovered root and server, or where the engine looked.
    static func serverPlaceholder(_ status: LocalServerStatus) -> String {
        if status.reachable, !status.baseUrl.isEmpty { return "\(host(status.baseUrl)) · \(serverName(status))" }
        return "nothing found — 11434, 1234, 8080"
    }

    /// The Server row is drawn when a pin exists or nothing answered; a found server needs no row.
    static func serverRowShown(status: LocalServerStatus, pin: String) -> Bool {
        !status.reachable || !pin.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The models that fit (good or tight) among the tool-capable ones.
    static func fittingCount(_ status: LocalServerStatus) -> Int {
        status.pickable.filter { $0.fit == .good || $0.fit == .tight }.count
    }

    /// The one-line status under the picker: "Ollama 0.34.0 · 3 models fit this Mac" /
    /// "No local server. Open Ollama, then Check." / "Nothing here can call tools."
    static func statusLine(_ status: LocalServerStatus) -> String {
        guard status.reachable else { return "No local server. Open Ollama, then Check." }
        if status.pickable.isEmpty { return "Nothing here can call tools." }
        let n = fittingCount(status)
        let models = n == 1 ? "1 model fits" : "\(n) models fit"
        return "\(serverName(status)) · \(models) this Mac"
    }

    /// The Automatic step's nudge when a server with fitting models is up; nil otherwise.
    static func autoNudge(_ status: LocalServerStatus) -> String? {
        let n = fittingCount(status)
        guard status.reachable, n > 0 else { return nil }
        let models = n == 1 ? "1 model that fits" : "\(n) models that fit"
        return "\(serverName(status)) is running with \(models). Pick Local model to keep the brain on this Mac."
    }

    /// The `where` glyph's tooltip.
    static func whereWord(_ where: String) -> String {
        switch `where` {
        case "cloud": return "leaves for the cloud"
        case "mac": return "stays on this Mac"
        case "lan": return "goes to a machine on your network"
        case "off": return "off"
        default: return `where`
        }
    }
}

/// The Model row for the Local brain: a menu over the tool-capable models the server lists
/// (size and fit beside each; one that does not fit drawn quiet), the engine's best fit as the
/// first row always — the way back from a pin — and the saved id even when the server no
/// longer lists it.
struct LocalModelMenu: View {
    let status: LocalServerStatus
    /// Settings.brainModel (or the wizard's draft): "" = the best fit on this Mac.
    let saved: String
    let pick: (String) -> Void

    private var options: [String] { LocalBrainWords.modelOptions(saved: saved, status: status) }

    private func title(_ id: String) -> String { LocalBrainWords.modelTitle(id, status: status) }
    private func fieldTitle(_ id: String) -> String { LocalBrainWords.collapsedTitle(saved: id, status: status) }
    private func dim(_ id: String) -> Bool { LocalBrainWords.isDim(id, status: status) }

    var body: some View {
        ConsoleMenuField(value: saved, options: options, title: title, pick: pick, mono: true, fieldTitle: fieldTitle, dim: dim)
            .help(status.reachable ? "The models on \(LocalBrainWords.serverName(status)) that can call tools; best fit lets the engine choose" : "No local server answered")
            .accessibilityLabel("Model: \(fieldTitle(saved))")
    }
}

/// The Server row for the Local brain: a pinned root (a second Ollama on another port, a LAN
/// box), or empty to discover. The placeholder names what discovery found or where it looked.
/// The caller binds focus and submit, as it does for every field in its panel.
struct LocalServerRow: View {
    let status: LocalServerStatus
    @Binding var text: String
    var focused = false
    var height: CGFloat = 26

    var body: some View {
        TextField(LocalBrainWords.serverPlaceholder(status), text: $text)
            .consoleField(mono: true, height: height, focused: focused)
            .help("Leave empty to find Ollama, LM Studio or llama.cpp on this Mac; paste a root to pin one")
            .accessibilityLabel("Local server root")
    }
}

/// One quiet line on the server: found and how many models fit, not found, or nothing that can
/// call tools — with the pull command's Copy chip when the engine suggested one.
struct LocalStatusNote: View {
    let status: LocalServerStatus

    private var line: String { LocalBrainWords.statusLine(status) }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(line).font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg3)
                .fixedSize(horizontal: false, vertical: true)
                .contentTransition(.opacity)
                .animation(Motion.fade, value: line)
            if status.reachable, status.pickable.isEmpty, let s = status.suggested {
                Text(s.command).font(ConsoleTheme.mono(11)).foregroundStyle(ConsoleTheme.fg2)
                    .lineLimit(1).truncationMode(.middle)
                    .textSelection(.enabled)
                CopyChip(text: s.command)
                    .transition(Motion.appear)
            }
        }
        .animation(Motion.gentle, value: status.reachable)
    }
}

/// A ghost "Copy" that puts a command on the pasteboard — a step that is Kevin's (a pull, an
/// install) is printed and copied, never run by this app.
struct CopyChip: View {
    let text: String

    var body: some View {
        Button("Copy") { CopyChip.copy(text) }
            .buttonStyle(ConsoleButtonStyle(kind: .ghost, height: 22, small: true))
            .help("Copies the command — you run it: \(text)")
            .accessibilityLabel("Copy \(text)")
    }

    static func copy(_ text: String) {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
    }
}

/// One "where words go" row (the `readyRow` shape): the kind's glyph, its name, the detail in
/// mono, and where it goes as the trailing glyph — the cloud, this Mac, the LAN, off.
struct DataPathRow: View {
    let path: DataPath

    private var whereWord: String { LocalBrainWords.whereWord(path.where) }

    var body: some View {
        HStack(spacing: iconGap) {
            ConsoleIcon(name: ConsoleTheme.dataPathSymbol(path.what))
            Text(ConsoleTheme.dataPathName(path.what)).font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg)
            Text(path.detail).font(ConsoleTheme.mono(11)).foregroundStyle(ConsoleTheme.titanium).lineLimit(1).truncationMode(.tail)
                .contentTransition(.opacity)
                .animation(Motion.fade, value: path.detail)
            Spacer(minLength: 4)
            ConsoleIcon(name: ConsoleTheme.dataPathWhereSymbol(path.where), tint: ConsoleTheme.dataPathTint(path.where))
                .help(whereWord)
                .accessibilityLabel(whereWord)
        }
        .frame(height: 28)
        .help(path.detail)
        .accessibilityElement(children: .combine)
    }
}

/// The rail section "Leaves the Mac": the four rows the engine computed (SetupStatus.dataPaths),
/// so the Console and `pnpm jarhead doctor` say the same thing. A row whose destination moves
/// (the brain going local) crossfades its glyph and detail.
struct DataPathsSection: View {
    let paths: [DataPath]

    var body: some View {
        RailSection("Leaves the Mac") {
            VStack(spacing: 0) {
                if paths.isEmpty {
                    Text("Not read yet.").font(ConsoleTheme.sans(12)).foregroundStyle(ConsoleTheme.fg3).frame(height: 22)
                        .transition(.opacity)
                }
                ForEach(paths) { path in
                    DataPathRow(path: path).transition(Motion.appear)
                }
            }
            .animation(Motion.gentle, value: paths.map(\.what))
        }
    }
}
