import AppKit
import Carbon

/// Global hotkeys through Carbon's RegisterEventHotKey: they work without an
/// Accessibility grant, unlike CGEventTap.
///
///   ⌥⇧J      open console
///   ⌥⇧M      mute / unmute
///   ⌥⎋       stop (AppState.transportStop: close the session, sleep)
///   ⌥⇧Space  go / pause (AppState.transportToggle: wake or resume · pause)
///   ⌥⇧C      circle something on screen for Jarhead (mark mode)
///   ⌥⇧⏎      type to Jarhead (the notch's field while the blob is parked there, else the Console)
@MainActor
final class Hotkeys {
    enum Action: UInt32, CaseIterable {
        case openConsole = 1
        case toggleMute = 2
        case stop = 3
        case transportToggle = 4
        case markScreen = 5
        /// 6 was ⌥⇧P, the old pause alias, deleted with the no-legacy contract; never reused.
        case sayLine = 7

        var keyCode: UInt32 {
            switch self {
            case .openConsole: return UInt32(kVK_ANSI_J)
            case .toggleMute: return UInt32(kVK_ANSI_M)
            case .stop: return UInt32(kVK_Escape)
            case .transportToggle: return UInt32(kVK_Space)
            case .markScreen: return UInt32(kVK_ANSI_C)
            case .sayLine: return UInt32(kVK_Return)
            }
        }

        var modifiers: UInt32 {
            switch self {
            case .openConsole, .toggleMute, .transportToggle, .markScreen, .sayLine: return UInt32(optionKey | shiftKey)
            case .stop: return UInt32(optionKey)
            }
        }

        /// For menu items that mirror the hotkey.
        var keyEquivalent: (String, NSEvent.ModifierFlags) {
            switch self {
            case .openConsole: return ("j", [.option, .shift])
            case .toggleMute: return ("m", [.option, .shift])
            case .stop: return ("\u{1b}", [.option])
            case .transportToggle: return (" ", [.option, .shift])
            case .markScreen: return ("c", [.option, .shift])
            case .sayLine: return ("\r", [.option, .shift])
            }
        }
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
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let selfPtr = Unmanaged.passUnretained(self).toOpaque()
        let status = InstallEventHandler(GetApplicationEventTarget(), hotkeyEventHandler, 1, &spec, selfPtr, &handlerRef)
        guard status == noErr else {
            NSLog("Hotkeys: InstallEventHandler failed (\(status))")
            return
        }
        for action in Action.allCases {
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
