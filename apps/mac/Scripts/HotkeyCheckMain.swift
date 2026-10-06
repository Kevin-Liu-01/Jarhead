import AppKit
import Carbon

// The global hotkeys type nothing (APP-12, decision D3). For every combo App/Hotkeys.swift
// registers, UCKeyTranslate is asked what the US layout types for that key with those
// modifiers. A hotkey that types a character eats it: ⌥⇧J was Ô, ⌥⇧M Â, ⌥⇧C Ç, ⌥⇧S Í,
// ⌥⇧R ‰, so a French or Portuguese sentence lost its capitals to the Console. Every
// registered combo must type nothing, or be on `typesAllowed` below with its reason.
//
// Headless and read-only: nothing is registered (RegisterEventHotKey would take the combos
// from every other app for as long as this runs), no event is posted, no window opens.
// Run by Scripts/hotkey-check.sh, once plain and once with `-hotkeys.off YES` (the argument
// domain, so the off switch is read exactly as the app reads it and no plist is written). The
// switch leaves ⌥⎋ Stop registered and nothing else.
// One `check:` line per check, "ok" or "FAIL" first; exit 1 on a FAIL.

nonisolated(unsafe) var failures = 0
func check(_ ok: Bool, _ what: String) {
    if !ok { failures += 1 }
    print("check: \(ok ? "ok" : "FAIL") \(what)")
}

/// The US layout's 'uchr' data, looked up by id so the Mac's current layout does not matter.
func usLayout() -> Data? {
    let filter = [kTISPropertyInputSourceID as String: "com.apple.keylayout.US"] as CFDictionary
    guard let list = TISCreateInputSourceList(filter, true)?.takeRetainedValue() as? [TISInputSource],
          let source = list.first,
          let raw = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return nil }
    return Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue() as Data
}

/// What a key down types on `layout` with Carbon `modifiers`, and whether it starts a dead key.
func typed(keyCode: UInt32, modifiers: UInt32, layout: Data) -> (text: String, dead: Bool) {
    var dead: UInt32 = 0
    var length = 0
    var chars = [UniChar](repeating: 0, count: 8)
    let status = layout.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> OSStatus in
        let ptr = raw.baseAddress!.assumingMemoryBound(to: UCKeyboardLayout.self)
        return UCKeyTranslate(ptr, UInt16(keyCode), UInt16(kUCKeyActionDown), (modifiers >> 8) & 0xFF,
                              UInt32(LMGetKbdType()), 0, &dead, chars.count, &length, &chars)
    }
    guard status == noErr else { return ("", false) }
    return (String(utf16CodeUnits: chars, count: length), dead != 0)
}

/// A character lands in a text field: anything but control characters (Return, Escape and
/// the ⌃ letters are commands to a text view, never text).
func isText(_ s: String) -> Bool {
    s.unicodeScalars.contains { $0.properties.generalCategory != .control }
}

func spelled(_ s: String) -> String {
    s.unicodeScalars.map { String(format: "U+%04X", $0.value) }.joined(separator: " ")
}

/// The registered combos allowed to type a character, with exactly what they type. Each entry
/// is a decision on record, never a default. Decided (D8, 2026-10-06): Go / Pause keeps
/// ⌥⇧Space; this entry stays. On the US layout ⌥⇧Space types U+00A0, a no-break space, so
/// that combo never reaches a field while Jarhead runs (⌥Space still types one). The choices
/// passed over: ⌃⌥Space types nothing but is macOS's "next input source"; ⌃⌥ + a letter types
/// nothing. A new hotkey that types a character fails here.
let typesAllowed: [Hotkeys.Action: String] = [.transportToggle: "U+00A0"]

func glyph(_ modifiers: UInt32) -> String {
    var g = ""
    if modifiers & UInt32(controlKey) != 0 { g += "⌃" }
    if modifiers & UInt32(optionKey) != 0 { g += "⌥" }
    if modifiers & UInt32(shiftKey) != 0 { g += "⇧" }
    if modifiers & UInt32(cmdKey) != 0 { g += "⌘" }
    return g
}

@main
struct HotkeyCheck {
    @MainActor
    static func main() {
        guard let layout = usLayout() else {
            check(false, "the US layout's key data is readable (TISCreateInputSourceList com.apple.keylayout.US)")
            exit(1)
        }
        let switchedOff = CommandLine.arguments.contains("-hotkeys.off")

        if switchedOff {
            // The off switch: `defaults write com.kevinliu.jarhead hotkeys.off -bool YES`. It turns
            // off every hotkey but ⌥⎋: Stop is the one key that stops the hands mid-drive.
            let actions = Hotkeys.actionsToRegister()
            let names = actions.map(\.glyph).joined(separator: " ")
            check(actions.contains(.stop), "hotkeys.off YES: ⌥⎋ Stop still registers (registers: \(names))")
            check(actions == [.stop], "hotkeys.off YES: nothing but ⌥⎋ registers (registers: \(names))")
            print(failures == 0 ? "hotkey-check: all ok" : "hotkey-check: \(failures) FAIL")
            exit(failures == 0 ? 0 : 1)
        }

        check(Hotkeys.actionsToRegister() == Hotkeys.Action.allCases, "without the switch every hotkey registers")

        // The combos, as registered. Each must type nothing at all (a control character is a
        // command to a text view, not text), or exactly what `typesAllowed` records for it.
        let letters: Set<UInt32> = [UInt32(kVK_ANSI_J), UInt32(kVK_ANSI_M), UInt32(kVK_ANSI_C), UInt32(kVK_ANSI_S), UInt32(kVK_ANSI_R)]
        var seen = Set<String>()
        for action in Hotkeys.Action.allCases {
            let (text, dead) = typed(keyCode: action.keyCode, modifiers: action.modifiers, layout: layout)
            let name = "\(glyph(action.modifiers)) key \(action.keyCode) (\(action))"
            let what = dead ? "a dead key" : (text.isEmpty ? "nothing" : spelled(text))
            if let allowed = typesAllowed[action] {
                check(!dead && spelled(text) == allowed, "\(name) types \(what), allowed as \(allowed) (D8)")
            } else {
                check(!dead && !isText(text), "\(name) types no character on the US layout (it types \(what))")
            }
            if letters.contains(action.keyCode) {
                check(action.modifiers == UInt32(controlKey | optionKey), "\(name) is ⌃⌥ + its letter (D3)")
            }
            // The menus mirror the hotkey: the same key and the same modifiers.
            let (key, flags) = action.keyEquivalent
            let mirrored = (flags.contains(.control) == (action.modifiers & UInt32(controlKey) != 0))
                && (flags.contains(.option) == (action.modifiers & UInt32(optionKey) != 0))
                && (flags.contains(.shift) == (action.modifiers & UInt32(shiftKey) != 0))
                && (flags.contains(.command) == (action.modifiers & UInt32(cmdKey) != 0))
            check(mirrored && !key.isEmpty, "\(action)'s menu key equivalent carries the hotkey's modifiers")
            check(action.glyph.hasPrefix(glyph(action.modifiers)), "\(action)'s glyph \(action.glyph) names its modifiers")
            seen.insert("\(action.keyCode)/\(action.modifiers)")
        }
        check(seen.count == Hotkeys.Action.allCases.count, "no two hotkeys share a combo")

        // The old combos, for the record: what ⌥⇧ + each letter typed.
        for code in letters.sorted() {
            let (text, _) = typed(keyCode: code, modifiers: UInt32(optionKey | shiftKey), layout: layout)
            print("note: the old ⌥⇧ key \(code) typed \(text) (\(spelled(text)))")
        }

        print(failures == 0 ? "hotkey-check: all ok" : "hotkey-check: \(failures) FAIL")
        exit(failures == 0 ? 0 : 1)
    }
}
