import Foundation
import CoreGraphics
import Carbon.HIToolbox

// MARK: - Key names (xdotool / X11 style, case-insensitive) -> US-layout virtual key codes.

struct KeyDef {
    let code: CGKeyCode
    let shift: Bool
    init(_ code: Int, shift: Bool = false) {
        self.code = CGKeyCode(code)
        self.shift = shift
    }
}

struct KeyStroke {
    /// Virtual key code when the key exists on the US layout.
    let keyCode: CGKeyCode?
    /// Fallback: type the character through CGEventKeyboardSetUnicodeString.
    let unicode: [UInt16]?
    let flags: CGEventFlags
}

let modifierFlagsByName: [String: CGEventFlags] = [
    "cmd": .maskCommand, "command": .maskCommand, "super": .maskCommand, "meta": .maskCommand,
    "super_l": .maskCommand, "super_r": .maskCommand, "meta_l": .maskCommand, "meta_r": .maskCommand,
    "win": .maskCommand, "windows": .maskCommand,
    "ctrl": .maskControl, "control": .maskControl, "control_l": .maskControl, "control_r": .maskControl,
    "alt": .maskAlternate, "option": .maskAlternate, "alt_l": .maskAlternate, "alt_r": .maskAlternate,
    "shift": .maskShift, "shift_l": .maskShift, "shift_r": .maskShift,
    "fn": .maskSecondaryFn, "function": .maskSecondaryFn,
]

let modifierKeyCodesByName: [String: CGKeyCode] = [
    "cmd": CGKeyCode(kVK_Command), "command": CGKeyCode(kVK_Command), "super": CGKeyCode(kVK_Command),
    "meta": CGKeyCode(kVK_Command), "super_l": CGKeyCode(kVK_Command), "meta_l": CGKeyCode(kVK_Command),
    "win": CGKeyCode(kVK_Command), "windows": CGKeyCode(kVK_Command),
    "super_r": CGKeyCode(kVK_RightCommand), "meta_r": CGKeyCode(kVK_RightCommand),
    "ctrl": CGKeyCode(kVK_Control), "control": CGKeyCode(kVK_Control), "control_l": CGKeyCode(kVK_Control),
    "control_r": CGKeyCode(kVK_RightControl),
    "alt": CGKeyCode(kVK_Option), "option": CGKeyCode(kVK_Option), "alt_l": CGKeyCode(kVK_Option),
    "alt_r": CGKeyCode(kVK_RightOption),
    "shift": CGKeyCode(kVK_Shift), "shift_l": CGKeyCode(kVK_Shift), "shift_r": CGKeyCode(kVK_RightShift),
    "fn": CGKeyCode(kVK_Function), "function": CGKeyCode(kVK_Function),
]

let keyTable: [String: KeyDef] = {
    var t: [String: KeyDef] = [:]

    // Letters
    let letters: [(String, Int)] = [
        ("a", kVK_ANSI_A), ("b", kVK_ANSI_B), ("c", kVK_ANSI_C), ("d", kVK_ANSI_D), ("e", kVK_ANSI_E),
        ("f", kVK_ANSI_F), ("g", kVK_ANSI_G), ("h", kVK_ANSI_H), ("i", kVK_ANSI_I), ("j", kVK_ANSI_J),
        ("k", kVK_ANSI_K), ("l", kVK_ANSI_L), ("m", kVK_ANSI_M), ("n", kVK_ANSI_N), ("o", kVK_ANSI_O),
        ("p", kVK_ANSI_P), ("q", kVK_ANSI_Q), ("r", kVK_ANSI_R), ("s", kVK_ANSI_S), ("t", kVK_ANSI_T),
        ("u", kVK_ANSI_U), ("v", kVK_ANSI_V), ("w", kVK_ANSI_W), ("x", kVK_ANSI_X), ("y", kVK_ANSI_Y),
        ("z", kVK_ANSI_Z),
    ]
    for (name, code) in letters { t[name] = KeyDef(code) }

    // Digits and their shifted symbols
    let digits: [(String, String, Int)] = [
        ("1", "!", kVK_ANSI_1), ("2", "@", kVK_ANSI_2), ("3", "#", kVK_ANSI_3), ("4", "$", kVK_ANSI_4),
        ("5", "%", kVK_ANSI_5), ("6", "^", kVK_ANSI_6), ("7", "&", kVK_ANSI_7), ("8", "*", kVK_ANSI_8),
        ("9", "(", kVK_ANSI_9), ("0", ")", kVK_ANSI_0),
    ]
    for (digit, shifted, code) in digits {
        t[digit] = KeyDef(code)
        t[shifted] = KeyDef(code, shift: true)
    }
    t["exclam"] = KeyDef(kVK_ANSI_1, shift: true)
    t["at"] = KeyDef(kVK_ANSI_2, shift: true)
    t["numbersign"] = KeyDef(kVK_ANSI_3, shift: true)
    t["dollar"] = KeyDef(kVK_ANSI_4, shift: true)
    t["percent"] = KeyDef(kVK_ANSI_5, shift: true)
    t["asciicircum"] = KeyDef(kVK_ANSI_6, shift: true)
    t["ampersand"] = KeyDef(kVK_ANSI_7, shift: true)
    t["asterisk"] = KeyDef(kVK_ANSI_8, shift: true)
    t["parenleft"] = KeyDef(kVK_ANSI_9, shift: true)
    t["parenright"] = KeyDef(kVK_ANSI_0, shift: true)

    // Punctuation: name, character, shifted character
    let punct: [(String, String, String, Int)] = [
        ("minus", "-", "_", kVK_ANSI_Minus),
        ("equal", "=", "+", kVK_ANSI_Equal),
        ("bracketleft", "[", "{", kVK_ANSI_LeftBracket),
        ("bracketright", "]", "}", kVK_ANSI_RightBracket),
        ("backslash", "\\", "|", kVK_ANSI_Backslash),
        ("semicolon", ";", ":", kVK_ANSI_Semicolon),
        ("apostrophe", "'", "\"", kVK_ANSI_Quote),
        ("comma", ",", "<", kVK_ANSI_Comma),
        ("period", ".", ">", kVK_ANSI_Period),
        ("slash", "/", "?", kVK_ANSI_Slash),
        ("grave", "`", "~", kVK_ANSI_Grave),
    ]
    for (name, ch, shifted, code) in punct {
        t[name] = KeyDef(code)
        t[ch] = KeyDef(code)
        t[shifted] = KeyDef(code, shift: true)
    }
    t["quote"] = KeyDef(kVK_ANSI_Quote)
    t["quotedbl"] = KeyDef(kVK_ANSI_Quote, shift: true)
    t["underscore"] = KeyDef(kVK_ANSI_Minus, shift: true)
    t["plus"] = KeyDef(kVK_ANSI_Equal, shift: true)
    t["braceleft"] = KeyDef(kVK_ANSI_LeftBracket, shift: true)
    t["braceright"] = KeyDef(kVK_ANSI_RightBracket, shift: true)
    t["bar"] = KeyDef(kVK_ANSI_Backslash, shift: true)
    t["colon"] = KeyDef(kVK_ANSI_Semicolon, shift: true)
    t["less"] = KeyDef(kVK_ANSI_Comma, shift: true)
    t["greater"] = KeyDef(kVK_ANSI_Period, shift: true)
    t["question"] = KeyDef(kVK_ANSI_Slash, shift: true)
    t["asciitilde"] = KeyDef(kVK_ANSI_Grave, shift: true)

    // Named keys
    t["return"] = KeyDef(kVK_Return)
    t["enter"] = KeyDef(kVK_Return)
    t["kp_enter"] = KeyDef(kVK_ANSI_KeypadEnter)
    t["tab"] = KeyDef(kVK_Tab)
    t["space"] = KeyDef(kVK_Space)
    t[" "] = KeyDef(kVK_Space)
    t["escape"] = KeyDef(kVK_Escape)
    t["esc"] = KeyDef(kVK_Escape)
    t["backspace"] = KeyDef(kVK_Delete)
    t["delete"] = KeyDef(kVK_Delete)          // xdotool "Delete" is the backspace key on macOS
    t["forwarddelete"] = KeyDef(kVK_ForwardDelete)
    t["forward_delete"] = KeyDef(kVK_ForwardDelete)
    t["kp_delete"] = KeyDef(kVK_ForwardDelete)
    t["insert"] = KeyDef(kVK_Help)
    t["help"] = KeyDef(kVK_Help)
    t["up"] = KeyDef(kVK_UpArrow)
    t["down"] = KeyDef(kVK_DownArrow)
    t["left"] = KeyDef(kVK_LeftArrow)
    t["right"] = KeyDef(kVK_RightArrow)
    t["home"] = KeyDef(kVK_Home)
    t["end"] = KeyDef(kVK_End)
    t["page_up"] = KeyDef(kVK_PageUp)
    t["pageup"] = KeyDef(kVK_PageUp)
    t["prior"] = KeyDef(kVK_PageUp)
    t["page_down"] = KeyDef(kVK_PageDown)
    t["pagedown"] = KeyDef(kVK_PageDown)
    t["next"] = KeyDef(kVK_PageDown)
    t["caps_lock"] = KeyDef(kVK_CapsLock)
    t["capslock"] = KeyDef(kVK_CapsLock)

    // Function keys
    let fkeys: [Int] = [
        kVK_F1, kVK_F2, kVK_F3, kVK_F4, kVK_F5, kVK_F6, kVK_F7, kVK_F8, kVK_F9, kVK_F10,
        kVK_F11, kVK_F12, kVK_F13, kVK_F14, kVK_F15, kVK_F16, kVK_F17, kVK_F18, kVK_F19, kVK_F20,
    ]
    for (i, code) in fkeys.enumerated() { t["f\(i + 1)"] = KeyDef(code) }

    // Keypad
    let keypad: [(String, Int)] = [
        ("kp_0", kVK_ANSI_Keypad0), ("kp_1", kVK_ANSI_Keypad1), ("kp_2", kVK_ANSI_Keypad2),
        ("kp_3", kVK_ANSI_Keypad3), ("kp_4", kVK_ANSI_Keypad4), ("kp_5", kVK_ANSI_Keypad5),
        ("kp_6", kVK_ANSI_Keypad6), ("kp_7", kVK_ANSI_Keypad7), ("kp_8", kVK_ANSI_Keypad8),
        ("kp_9", kVK_ANSI_Keypad9), ("kp_decimal", kVK_ANSI_KeypadDecimal),
        ("kp_multiply", kVK_ANSI_KeypadMultiply), ("kp_add", kVK_ANSI_KeypadPlus),
        ("kp_subtract", kVK_ANSI_KeypadMinus), ("kp_divide", kVK_ANSI_KeypadDivide),
        ("kp_equal", kVK_ANSI_KeypadEquals), ("kp_clear", kVK_ANSI_KeypadClear),
    ]
    for (name, code) in keypad { t[name] = KeyDef(code) }

    return t
}()

/// Parses `+`-joined combos like "cmd+shift+p", "ctrl+c", "alt+Tab", "Return", "A", "é", "+".
func parseCombo(_ combo: String) throws -> KeyStroke {
    let trimmed = combo.trimmingCharacters(in: .whitespaces)
    guard !trimmed.isEmpty else { throw HandsError.badRequest("'combo' must not be empty") }

    var tokens: [String]
    if trimmed == "+" {
        tokens = ["+"]
    } else {
        let parts = trimmed.split(separator: "+", omittingEmptySubsequences: false).map(String.init)
        tokens = parts.filter { !$0.isEmpty }
        // "cmd++" splits as ["cmd", "", ""]: the key is a literal "+".
        if parts.contains("") { tokens.append("+") }
    }
    guard let keyToken = tokens.last else { throw HandsError.badRequest("'combo' must name a key") }

    var flags = CGEventFlags()
    for token in tokens.dropLast() {
        guard let f = modifierFlagsByName[token.lowercased()] else {
            throw HandsError.badRequest("unknown modifier '\(token)' in combo '\(combo)'")
        }
        flags.insert(f)
    }

    let lower = keyToken.lowercased()

    // A modifier on its own (or last) is pressed as a key itself.
    if let f = modifierFlagsByName[lower], let code = modifierKeyCodesByName[lower] {
        return KeyStroke(keyCode: code, unicode: nil, flags: flags.union(f))
    }

    if keyToken.count == 1, let ch = keyToken.first, ch.isLetter, ch.isUppercase {
        flags.insert(.maskShift)
    }
    if let def = keyTable[lower] {
        if def.shift { flags.insert(.maskShift) }
        return KeyStroke(keyCode: def.code, unicode: nil, flags: flags)
    }
    if keyToken.count == 1 {
        return KeyStroke(keyCode: nil, unicode: Array(keyToken.utf16), flags: flags)
    }
    throw HandsError.badRequest("unknown key '\(keyToken)' in combo '\(combo)'")
}

/// modifiers: ["cmd"|"command", "shift", "alt"|"option", "ctrl"|"control", "fn"]
func parseModifiers(_ names: [String]?) throws -> CGEventFlags {
    var flags = CGEventFlags()
    for name in names ?? [] {
        guard let f = modifierFlagsByName[name.lowercased()] else {
            throw HandsError.badRequest("unknown modifier '\(name)'")
        }
        flags.insert(f)
    }
    return flags
}
