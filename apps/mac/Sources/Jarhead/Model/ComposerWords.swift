import Foundation

/// The words a typed line and a circled region get, wherever they are shown: the Console's
/// composer and the notch's field read one placeholder table; the Console's MarkThumb and the
/// notch's thumb tooltip read one caption builder; the Ask box sends one question.
public enum ComposerWords {
    /// The field's placeholder: what typing does in this phase. Paused: resumes (the engine's
    /// own rule). In session (or connecting): "Say something…". Asleep or in error: refused
    /// unless typed lines wake, and the placeholder says which — a typed line under
    /// `typedWakes` opens a paid session.
    public static func placeholder(phase: Phase, paused: Bool, typedWakes: Bool) -> String {
        if paused || phase == .paused { return "Paused — press Go or type to resume" }
        if AppState.inSessionPhases.contains(phase) || phase == .connecting { return "Say something…" }
        return typedWakes ? "Type to wake Jarhead…" : "Type to Jarhead… (asleep: press Go)"
    }

    /// Whether a submitted line stays in the field: asleep (or in error) with typed wakes off,
    /// the engine refuses it — no paid session on a stray Return — so the words are kept for the Go.
    public static func keepsText(phase: Phase, typedWakes: Bool) -> Bool {
        (phase == .asleep || phase == .error) && !typedWakes
    }

    /// The one question the Ask box sends about what is circled.
    public static func askAboutMarks(window: Bool) -> String {
        window ? "What's in this window?" : "What did I circle?"
    }

    /// One caption for the Console's MarkThumb and the notch's thumb tooltip:
    /// `Circled · 640×400 · 14:03 · pending · button "Send" in Slack · 2m`,
    /// `Captured · Safari · 1280×800 · 14:03 · pending · 2m`; `used` once a delegation took it.
    public static func markCaption(_ m: ScreenMark, now: Date) -> String {
        let size = "\(Int(m.rect.w.rounded()))×\(Int(m.rect.h.rounded()))"
        var parts: [String] = []
        if m.isWindow {
            parts.append("Captured")
            if let app = m.element?.app?.trimmingCharacters(in: .whitespaces), !app.isEmpty { parts.append(app) }
            parts.append(size)
        } else {
            parts.append("Circled")
            parts.append(size)
        }
        parts.append(clock.string(from: Date(timeIntervalSince1970: m.at / 1000)))
        parts.append(m.consumed ? "used" : "pending")
        if !m.isWindow, let e = m.element, let described = describe(e) { parts.append(described) }
        parts.append(age(seconds: now.timeIntervalSince1970 - m.at / 1000))
        return parts.joined(separator: " · ")
    }

    /// The snapped element as a phrase: `button "Send" in Slack`, `"Send" in Slack`, `Slack`.
    private static func describe(_ e: ScreenMark.MarkElement) -> String? {
        var words: [String] = []
        if let role = e.role?.trimmingCharacters(in: .whitespaces), !role.isEmpty { words.append(role) }
        if let title = e.title?.trimmingCharacters(in: .whitespaces), !title.isEmpty { words.append("\"\(title)\"") }
        if let app = e.app?.trimmingCharacters(in: .whitespaces), !app.isEmpty {
            words.append(words.isEmpty ? app : "in \(app)")
        }
        return words.isEmpty ? nil : words.joined(separator: " ")
    }

    /// "now", "12s", "3m", "2h" — a mark lives minutes, never days (`PENDING_MARK_TTL_MS`).
    private static func age(seconds: TimeInterval) -> String {
        let s = Int(max(0, seconds.isFinite ? seconds : 0))
        if s < 5 { return "now" }
        if s < 60 { return "\(s)s" }
        if s < 3600 { return "\(s / 60)m" }
        return "\(s / 3600)h"
    }

    private static let clock: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f
    }()
}
