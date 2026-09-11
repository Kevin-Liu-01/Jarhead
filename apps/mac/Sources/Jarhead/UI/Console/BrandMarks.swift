import SwiftUI

// The tool behind a session, drawn in code — no vendor logo ships in the bundle.
// One glyph per AgentTool at 14pt on the fixed 20pt icon column, and the brand
// colour that rings its status dot and marks its conversation (REDESIGN §9):
// Claude Code an asterisk in terracotta, Codex a `>_` prompt in paper on ink,
// Cursor a pointer, Gemini a four-point sparkle, OpenCode a bracket pair, Amp a
// bolt, and a titanium monogram for the rest. Every glyph is a Path or text of
// its own, never an SF Symbol the Console already uses on the icon column
// (terminal.fill is a tool call, bolt.fill is Wake), so a mark is never
// mistaken for a row kind.

enum ConsoleBrand {
    static let claude = ConsoleTheme.rgb(0xd97757)
    static let gemini = ConsoleTheme.rgb(0x4796e3)
    static let opencode = ConsoleTheme.rgb(0x6ee7a0)
    static let amp = ConsoleTheme.rgb(0xffb454)
    /// Codex's chip: ink under paper. In dark mode the ground is already ink, so the
    /// chip lifts to raised ink and keeps a hairline edge.
    static let chip = ConsoleTheme.dynamic(light: ConsoleTheme.nsColor(0x070707), dark: ConsoleTheme.nsColor(0x101010))
    static let paper = Color.white

    /// Display order of tool groups in the agents rail.
    static let order: [AgentTool] = [.claude, .codex, .cursor, .gemini, .opencode, .amp, .droid, .hermes, .pi, .other]

    static func color(_ tool: AgentTool) -> Color {
        switch tool {
        case .claude: return claude
        case .gemini: return gemini
        case .opencode: return opencode
        case .amp: return amp
        // Paper on ink: the text colour is paper in dark, ink in light.
        case .codex, .cursor: return ConsoleTheme.fg
        case .droid, .hermes, .pi, .other: return ConsoleTheme.titanium
        }
    }
}

/// The colour a tool's status ring and conversation header carry.
func brandColor(_ tool: AgentTool) -> Color { ConsoleBrand.color(tool) }

/// A tool's mark at `size` (14 by default) on the 20pt icon column. Rows align it
/// to text with `.firstTextBaseline`, so it publishes a baseline of its own.
struct BrandMark: View {
    let tool: AgentTool
    var size: CGFloat = 14

    var body: some View {
        glyph
            .frame(width: size, height: size)
            .frame(width: 20, height: 20)
            .alignmentGuide(.firstTextBaseline) { d in d[.bottom] - 5 }
            .alignmentGuide(.lastTextBaseline) { d in d[.bottom] - 5 }
            .accessibilityLabel(tool.label)
    }

    @ViewBuilder
    private var glyph: some View {
        switch tool {
        case .claude:
            ClaudeAsterisk().stroke(ConsoleBrand.claude, style: StrokeStyle(lineWidth: size * 0.16, lineCap: .round))
        case .codex:
            ZStack {
                RoundedRectangle(cornerRadius: size * 0.22).fill(ConsoleBrand.chip)
                RoundedRectangle(cornerRadius: size * 0.22).stroke(ConsoleTheme.hair, lineWidth: 1)
                Text(">_")
                    .font(.system(size: size * 0.6, weight: .bold, design: .monospaced))
                    .foregroundStyle(ConsoleBrand.paper)
                    .offset(y: -size * 0.03)
            }
        case .cursor:
            CursorPointer().fill(ConsoleTheme.fg)
        case .gemini:
            GeminiSparkle().fill(ConsoleBrand.gemini)
        case .opencode:
            OpenCodeBrackets().stroke(ConsoleBrand.opencode, style: StrokeStyle(lineWidth: size * 0.13, lineCap: .square, lineJoin: .miter))
        case .amp:
            AmpBolt().fill(ConsoleBrand.amp)
        case .droid:
            monogram("D")
        case .hermes:
            monogram("H")
        case .pi:
            monogram("π")
        case .other:
            // "Agent" → A: the monogram the spec gives every tool without a mark of its own.
            monogram(String(tool.label.prefix(1)))
        }
    }

    private func monogram(_ letter: String) -> some View {
        Text(letter)
            .font(.system(size: size * 0.9, weight: .semibold, design: .rounded))
            .foregroundStyle(ConsoleTheme.titanium)
    }
}

/// Four arms through the centre — eight rays; the diagonals a touch shorter.
private struct ClaudeAsterisk: Shape {
    func path(in rect: CGRect) -> Path {
        var p = Path()
        let c = CGPoint(x: rect.midX, y: rect.midY)
        let r = min(rect.width, rect.height) / 2 - rect.width * 0.08
        for i in 0..<4 {
            let angle = Double(i) * .pi / 4
            let len = i % 2 == 0 ? r : r * 0.82
            let dx = CGFloat(cos(angle)) * len, dy = CGFloat(sin(angle)) * len
            p.move(to: CGPoint(x: c.x - dx, y: c.y - dy))
            p.addLine(to: CGPoint(x: c.x + dx, y: c.y + dy))
        }
        return p
    }
}

/// The classic arrow pointer, filled.
private struct CursorPointer: Shape {
    func path(in rect: CGRect) -> Path {
        let s = min(rect.width, rect.height) / 14
        func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: rect.minX + x * s, y: rect.minY + y * s) }
        var p = Path()
        p.move(to: pt(3.2, 1.2))
        p.addLine(to: pt(3.2, 12.4))
        p.addLine(to: pt(5.9, 9.8))
        p.addLine(to: pt(7.9, 13.4))
        p.addLine(to: pt(9.8, 12.5))
        p.addLine(to: pt(7.8, 8.9))
        p.addLine(to: pt(11.6, 8.9))
        p.closeSubpath()
        return p
    }
}

/// A four-point sparkle: the points on the box edges, the sides pulled toward the centre.
private struct GeminiSparkle: Shape {
    func path(in rect: CGRect) -> Path {
        let c = CGPoint(x: rect.midX, y: rect.midY)
        let r = min(rect.width, rect.height) / 2
        let top = CGPoint(x: c.x, y: c.y - r), right = CGPoint(x: c.x + r, y: c.y)
        let bottom = CGPoint(x: c.x, y: c.y + r), left = CGPoint(x: c.x - r, y: c.y)
        // Control points a little off the centre toward each corner give the arms some body.
        let k = r * 0.14
        var p = Path()
        p.move(to: top)
        p.addQuadCurve(to: right, control: CGPoint(x: c.x + k, y: c.y - k))
        p.addQuadCurve(to: bottom, control: CGPoint(x: c.x + k, y: c.y + k))
        p.addQuadCurve(to: left, control: CGPoint(x: c.x - k, y: c.y + k))
        p.addQuadCurve(to: top, control: CGPoint(x: c.x - k, y: c.y - k))
        p.closeSubpath()
        return p
    }
}

/// A lightning bolt, drawn: two strokes that jog at the waist. Not SF's
/// `bolt.fill`, which is the stream's Wake glyph.
private struct AmpBolt: Shape {
    func path(in rect: CGRect) -> Path {
        let s = min(rect.width, rect.height) / 14
        func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: rect.minX + x * s, y: rect.minY + y * s) }
        var p = Path()
        p.move(to: pt(8.4, 0.8))
        p.addLine(to: pt(2.4, 8.0))
        p.addLine(to: pt(6.3, 8.0))
        p.addLine(to: pt(5.4, 13.2))
        p.addLine(to: pt(11.6, 5.9))
        p.addLine(to: pt(7.6, 5.9))
        p.closeSubpath()
        return p
    }
}

/// `[ ]`
private struct OpenCodeBrackets: Shape {
    func path(in rect: CGRect) -> Path {
        let s = min(rect.width, rect.height) / 14
        func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: rect.minX + x * s, y: rect.minY + y * s) }
        var p = Path()
        p.move(to: pt(4.6, 1.6)); p.addLine(to: pt(2.0, 1.6)); p.addLine(to: pt(2.0, 12.4)); p.addLine(to: pt(4.6, 12.4))
        p.move(to: pt(9.4, 1.6)); p.addLine(to: pt(12.0, 1.6)); p.addLine(to: pt(12.0, 12.4)); p.addLine(to: pt(9.4, 12.4))
        return p
    }
}

/// An agent's status on the icon column. Working is the pulsing dot inside a
/// 1pt ring in the tool's colour — the ring says whose work it is. Idle is the
/// plain titanium dot, as `ConsoleStatusGlyph` draws it: ringed, a settled dot
/// reads as a radio button. The other states keep their solid symbol.
struct BrandStatusGlyph: View {
    let status: AgentStatus
    let tool: AgentTool

    var body: some View {
        let meta = ConsoleTheme.status(status)
        Group {
            if let symbol = meta.symbol {
                ConsoleIcon(name: symbol, tint: meta.color)
            } else if meta.live {
                ZStack {
                    Circle().stroke(brandColor(tool), lineWidth: 1).frame(width: 12, height: 12)
                    ConsoleDot(color: meta.color, live: true, size: 6)
                }
            } else {
                ConsoleDot(color: meta.color, live: false, size: 6)
            }
        }
        .frame(width: 20, height: 20)
        .help(status.rawValue)
        .accessibilityLabel(status.rawValue)
    }
}
