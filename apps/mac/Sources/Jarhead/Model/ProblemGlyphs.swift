import Foundation

/// One solid SF Symbol per `ProblemKind`, and whether the kind is a warning or an error — the
/// table the Console's Problems section and the notch's problem chip and pill both read
/// (`ConsoleTheme.problem(_:)` adds the Console's colours).
public enum ProblemGlyphs {
    /// The kind's glyph; the triangle for one the app does not know.
    public static func symbol(for kind: String) -> String {
        switch kind {
        case "permission.accessibility": return "hand.raised.fill"
        case "permission.screenRecording": return "rectangle.inset.filled.badge.record"
        case "permission.microphone": return "mic.fill"
        case "permission.fullDiskAccess": return "internaldrive.fill"
        case "permission.other": return "lock.fill"
        case "brain.unavailable", "brain.probe", "brain.local": return "brain.fill"
        case "voice.limit": return "waveform.badge.exclamationmark"
        case "voice.connection": return "wifi.exclamationmark"
        case "voice.key": return "key.fill"
        case "hands.helper": return "hand.tap.fill"
        case "disk.low": return "externaldrive.fill.badge.exclamationmark"
        case "dock": return "dock.rectangle"
        case "daemon": return "gearshape.2.fill"
        case "crash": return "bolt.trianglebadge.exclamationmark.fill"
        default: return "exclamationmark.triangle.fill"
        }
    }

    /// A permission missing is a warning (the hands work less), and so is Jarhead twice in the
    /// Dock (`dock`: cosmetic, one press fixes it) and the local server or model needing Kevin
    /// (`brain.local`: he runs the printed command); everything else is an error.
    public static func isWarning(_ kind: String) -> Bool {
        kind.hasPrefix("permission.") || kind == "dock" || kind == "brain.local"
    }
}
