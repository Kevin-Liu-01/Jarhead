import Foundation

/// What the ear is biased to hear: the reflex grammar's phrases (packages/brain/src/reflex.ts,
/// the SLEEP and SCROLL … DOUBLE_CLICK regexes), the engine's dictation commands
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
        // SEARCH (reflex.ts SEARCH_A / SEARCH_B): "search <where> for <what>", "search for <what> in|on <where>",
        // "look up <what> in <where>", "find <what> on <where>"; the places are in `names` / `places`.
        "search", "search for", "search the wiki for", "search google for", "look up", "lookup", "find",
        "search this page for", "on this page", "in this page", "here", "this page", "this tab", "the current page",
        // stop words (ear.ts STOP_WORDS) and the app's own controls
        "stop", "pause", "resume", "cancel", "never mind", "hold on",
    ]

    /// Apps and names a bare "open X" / "switch to X" / "search X for …" may carry (reflex.ts SEARCH_APPS).
    static let names: [String] = [
        "Safari", "Chrome", "Google Chrome", "Arc", "Firefox", "Slack", "Codex", "Terminal", "Cursor", "Finder", "Claude", "Xcode",
        "Notes", "Mail", "Messages", "Notion", "Linear", "Figma", "Spotify", "Discord", "Obsidian", "VS Code", "Visual Studio Code",
        "Jarhead",
    ]

    /// Sites a search may name (reflex.ts SEARCH_SITES): the front browser tab must already be on them.
    static let places: [String] = [
        "the wiki", "wiki", "Google", "Gmail", "YouTube", "GitHub", "Twitter", "Reddit", "Hacker News", "Wikipedia", "Amazon",
        "Netflix", "ChatGPT", "LinkedIn", "Vercel", "Google Docs", "Google Drive", "Stack Overflow", "npm", "Google Maps",
    ]

    /// The sleep cues (reflex.ts SLEEP): "go to sleep", "shut off", "goodnight", "that's all for
    /// now" and the rest, as whole phrases so the first partial comes back as those words and
    /// not "go to sleet". Bias only — the app matches nothing: the engine decides, and only when
    /// the words address Jarhead (a "goodnight" to someone in the room sleeps nothing). Bare
    /// "sleep", "night", "shut down" and "stop" are not cues and are not here.
    static let sleepCues: [String] = [
        "go to sleep", "go back to sleep", "back to sleep", "go to bed", "sleep now",
        "shut off", "shut yourself off", "shut yourself down", "turn yourself off",
        "power down", "power off",
        "good night", "goodnight", "night night",
        "that's all", "that is all", "that will be all", "that'll be all",
        "that's all for now", "that's all for today", "that's all for tonight", "that's it for now",
        "dismissed", "you're dismissed", "you can rest", "you may rest", "stand down", "go dormant",
    ]

    /// The whole bias list; the order does not matter to the recogniser.
    static var contextualStrings: [String] { verbs + names + places + sleepCues }
}
