import AppKit
import Carbon

/// Global hotkeys through Carbon's RegisterEventHotKey: they work without an
/// Accessibility grant, unlike CGEventTap.
///
///   ⌃⌥J      open console
///   ⌃⌥M      mute / unmute
///   ⌥⎋       stop (AppState.transportStop: close the session, sleep)
///   ⌥⇧Space  go / pause (AppState.transportToggle: wake or resume · pause)
///   ⌃⌥C      circle something on screen for Jarhead (mark mode)
///   ⌥⇧⏎      type to Jarhead (the notch's field while the blob is parked there, else the Console)
///   ⌃⌥S      snooze the ringing automation (nothing while none rings)
///   ⌃⌥R      Recording on / off (design12: Settings › Audio's one switch, through `set-settings` only)
///
/// The letters are ⌃⌥ (APP-12, decision D3). A registered combo is taken from every app, so
/// it must be one that types nothing: ⌥⇧ + a letter types a character on most layouts
/// (⌥⇧J is Ô on the US layout, ⌥⇧C is Ç), and those characters stopped reaching the
/// field. ⌃⌥ + a letter types no character. `Scripts/hotkey-check.sh` asks UCKeyTranslate.
///
/// `defaults write com.kevinliu.jarhead hotkeys.off -bool YES` turns every global hotkey off
/// (for a layout or an app that needs the combos); read at launch. The menus keep working.
@MainActor
final class Hotkeys {
    enum Action: UInt32, CaseIterable {
        case openConsole = 1
        case toggleMute = 2
        /// 3 is `stop` and stays `stop` (the ids are stable across builds; the design pins it).
        case stop = 3
        case transportToggle = 4
        case markScreen = 5
        /// 6 is retired and never reused (ids are stable across builds).
        case sayLine = 7
        case snooze = 8
        case toggleRecording = 9

        var keyCode: UInt32 {
            switch self {
            case .openConsole: return UInt32(kVK_ANSI_J)
            case .toggleMute: return UInt32(kVK_ANSI_M)
            case .stop: return UInt32(kVK_Escape)
            case .transportToggle: return UInt32(kVK_Space)
            case .markScreen: return UInt32(kVK_ANSI_C)
            case .sayLine: return UInt32(kVK_Return)
            case .snooze: return UInt32(kVK_ANSI_S)
            case .toggleRecording: return UInt32(kVK_ANSI_R)
            }
        }

        var modifiers: UInt32 {
            switch self {
            case .openConsole, .toggleMute, .markScreen, .snooze, .toggleRecording: return UInt32(controlKey | optionKey)
            case .transportToggle, .sayLine: return UInt32(optionKey | shiftKey)
            case .stop: return UInt32(optionKey)
            }
        }

        /// For menu items that mirror the hotkey.
        var keyEquivalent: (String, NSEvent.ModifierFlags) {
            switch self {
            case .openConsole: return ("j", [.control, .option])
            case .toggleMute: return ("m", [.control, .option])
            case .stop: return ("\u{1b}", [.option])
            case .transportToggle: return (" ", [.option, .shift])
            case .markScreen: return ("c", [.control, .option])
            case .sayLine: return ("\r", [.option, .shift])
            case .snooze: return ("s", [.control, .option])
            case .toggleRecording: return ("r", [.control, .option])
            }
        }

        /// How a tooltip names the hotkey: "⌃⌥C", "⌥⇧Space", "⌥⎋".
        var glyph: String {
            switch self {
            case .openConsole: return "⌃⌥J"
            case .toggleMute: return "⌃⌥M"
            case .stop: return "⌥⎋"
            case .transportToggle: return "⌥⇧Space"
            case .markScreen: return "⌃⌥C"
            case .sayLine: return "⌥⇧Return"
            case .snooze: return "⌃⌥S"
            case .toggleRecording: return "⌃⌥R"
            }
        }
    }

    /// The UserDefaults switch that turns every global hotkey off.
    static let offKey = "hotkeys.off"

    /// What `register()` registers: every action, or none while `hotkeys.off` is set.
    static func actionsToRegister(_ defaults: UserDefaults = .standard) -> [Action] {
        defaults.bool(forKey: offKey) ? [] : Action.allCases
    }

    private static let signature: OSType = 0x4A48_4B59 // "JHKY"
    private var handlerRef: EventHandlerRef?
    private var registered: [EventHotKeyRef] = []
    private let onAction: (Action) -> Void

    init(onAction: @escaping (Action) -> Void) {
        self.onAction = onAction
    }

    func register() {
        guard handlerRef == nil else { return }
        let actions = Hotkeys.actionsToRegister()
        guard !actions.isEmpty else {
            NSLog("Hotkeys: off (\(Hotkeys.offKey) is set); none registered")
            return
        }
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let selfPtr = Unmanaged.passUnretained(self).toOpaque()
        let status = InstallEventHandler(GetApplicationEventTarget(), hotkeyEventHandler, 1, &spec, selfPtr, &handlerRef)
        guard status == noErr else {
            NSLog("Hotkeys: InstallEventHandler failed (\(status))")
            return
        }
        for action in actions {
            var ref: EventHotKeyRef?
            let id = EventHotKeyID(signature: Hotkeys.signature, id: action.rawValue)
            let err = RegisterEventHotKey(action.keyCode, action.modifiers, id, GetApplicationEventTarget(), 0, &ref)
            if err == noErr, let ref { registered.append(ref) }
            else { NSLog("Hotkeys: RegisterEventHotKey \(action) failed (\(err))") }
        }
    }

    func unregister() {
        for ref in registered { UnregisterEventHotKey(ref) }
        registered.removeAll()
        if let handlerRef {
            RemoveEventHandler(handlerRef)
            self.handlerRef = nil
        }
    }

    fileprivate func fire(id: UInt32) {
        guard let action = Action(rawValue: id) else { return }
        onAction(action)
    }
}

/// C callback: no captures allowed, so the instance rides along in userData.
private func hotkeyEventHandler(_ handler: EventHandlerCallRef?, _ event: EventRef?, _ userData: UnsafeMutableRawPointer?) -> OSStatus {
    guard let event, let userData else { return OSStatus(eventNotHandledErr) }
    var hotKeyID = EventHotKeyID()
    let status = GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil,
                                   MemoryLayout<EventHotKeyID>.size, nil, &hotKeyID)
    guard status == noErr else { return status }
    let hotkeys = Unmanaged<Hotkeys>.fromOpaque(userData).takeUnretainedValue()
    let id = hotKeyID.id
    DispatchQueue.main.async {
        MainActor.assumeIsolated { hotkeys.fire(id: id) }
    }
    return noErr
}
