import AppKit

/// The main menu bar. Small on purpose: the status item and the Console carry the
/// real controls; this exists so ⌘Q, Edit shortcuts and window management behave.
@MainActor
final class Menus: NSObject {
    private let actions: AppActions

    init(actions: AppActions) {
        self.actions = actions
        super.init()
    }

    func install() {
        let main = NSMenu()

        // App menu
        let appItem = NSMenuItem()
        let app = NSMenu(title: "Jarhead")
        app.addItem(withTitle: "About Jarhead", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        let prefs = NSMenuItem(title: "Preferences…", action: #selector(openConsole), keyEquivalent: ",")
        prefs.target = self
        app.addItem(prefs)
        app.addItem(.separator())
        app.addItem(withTitle: "Hide Jarhead", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = app.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        app.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        app.addItem(.separator())
        let quit = NSMenuItem(title: "Quit Jarhead", action: #selector(quitApp), keyEquivalent: "q")
        quit.target = self
        app.addItem(quit)
        appItem.submenu = app
        main.addItem(appItem)

        // Edit menu (standard responder-chain actions so text fields work)
        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)

        // View menu
        let viewItem = NSMenuItem()
        let view = NSMenu(title: "View")
        let console = NSMenuItem(title: "Open Console", action: #selector(openConsole), keyEquivalent: "j")
        console.keyEquivalentModifierMask = [.option, .shift]
        console.target = self
        view.addItem(console)
        let summon = NSMenuItem(title: "Summon Orb to Cursor", action: #selector(summonOrb), keyEquivalent: "")
        summon.target = self
        view.addItem(summon)
        viewItem.submenu = view
        main.addItem(viewItem)

        // Window menu
        let windowItem = NSMenuItem()
        let window = NSMenu(title: "Window")
        window.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        window.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        window.addItem(.separator())
        window.addItem(withTitle: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        windowItem.submenu = window
        main.addItem(windowItem)

        NSApp.mainMenu = main
        NSApp.windowsMenu = window
    }

    @objc private func openConsole() { actions.openConsole() }
    @objc private func summonOrb() { actions.summonOrb() }
    @objc private func quitApp() { actions.quit() }
}
