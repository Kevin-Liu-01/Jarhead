import Foundation

/// What the ear is biased to hear: the reflex grammar's phrases (packages/brain/src/reflex.ts,
/// the SCROLL … DOUBLE_CLICK regexes), the engine's dictation commands
/// (packages/engine/src/ear.ts DICTATION_COMMANDS) and the names Kevin says most.
/// `SFSpeechRecognizer.contextualStrings` raises the odds that "scroll down" comes back
/// as those two words on the first partial rather than as "scrolled on" three revisions
/// later — the reflex layer matches partials, so the first spelling is the one that
/// counts. Keep this list in step with reflex.ts by hand; contextual strings only bias
/// recognition, so a phrase missing here still works, just with worse odds of a clean
/// first partial.
enum EarGrammar {
    /// The one-step commands the engine's reflex table knows.
    static let verbs: [String] = [
        // SCROLL / SCROLL_TO / PAGE
        "scroll", "scroll down", "scroll up", "scroll left", "scroll right",
        "scroll to the top", "scroll to the bottom", "swipe up", "swipe down", "a bit", "a lot",
        "page down", "page up",
        // KEY
        "press", "press enter", "hit enter", "tap", "enter", "return", "escape", "space", "spacebar", "delete", "backspace",
        // SELECT_ALL / EDIT
        "select all", "copy", "cut", "paste", "undo", "redo",
        // tabs / navigation / zoom
        "new tab", "next tab", "previous tab", "close this tab", "close the tab",
        "reload", "refresh", "reload the page",
        "go back", "navigate back", "go forward", "forward",
        "zoom in", "zoom out", "reset zoom", "actual size",
        // TYPE / dictation
        "type", "write", "dictating", "start dictating", "stop dictating", "dictation", "take dictation",
        "new line", "new paragraph", "delete that", "scratch that",
        // OPEN / CLOSE / SHOT
        "open", "launch", "switch to", "go to",
        "close this window", "close the window",
        "screenshot", "take a screenshot", "capture",
        // CLICK / DOUBLE_CLICK / CIRCLE
        "click", "click on", "double click", "button", "link", "checkbox", "menu", "icon",
        "circle", "highlight", "outline", "circle that",
        // stop words (ear.ts STOP_WORDS) and the app's own controls
        "stop", "pause", "resume", "cancel", "never mind", "hold on",
    ]

    /// Apps and names a bare "open X" / "switch to X" may carry.
    static let names: [String] = [
        "Safari", "Chrome", "Slack", "Codex", "Terminal", "Cursor", "Finder", "Claude", "Xcode", "Notes", "Messages",
        "Jarhead",
    ]

    /// The whole bias list; the order does not matter to the recogniser.
    static var contextualStrings: [String] { verbs + names }
}
