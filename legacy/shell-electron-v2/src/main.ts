import { app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, nativeImage, net, protocol, screen, shell, type Display } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { REPO_ROOT, logger, replaceDefaultSink, setLogLevel } from "@jarhead/core";
import { isEngineCommand, type EngineEvent, type OverlayCommand } from "@jarhead/protocol";
import { Engine } from "@jarhead/engine";

/**
 * Jarhead.app — Dock citizen, menu-bar item, and three kinds of window:
 *
 *   orb      the presence: small, draggable, always on top, always interactive
 *   console  the control surface: transcript, delegations, agents, settings
 *   overlay  one per display, click-through, draws where the hands are going
 *
 * plus a hidden audio window that owns the microphone and the speaker, because
 * Chromium's echo cancellation is the cheapest good AEC on this machine.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const RENDERER = join(HERE, "renderer");
const log = logger("shell");

replaceDefaultSink((level, scope, message) => {
  const line = `${new Date().toISOString().slice(11, 23)} ${level.padEnd(5)} ${scope}: ${message}`;
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
});

const ORB = { collapsed: { width: 112, height: 112 }, expanded: { width: 360, height: 240 } };

class Shell {
  readonly engine = new Engine();
  private orb: BrowserWindow | undefined;
  private consoleWin: BrowserWindow | undefined;
  private audio: BrowserWindow | undefined;
  private overlays = new Map<number, BrowserWindow>();
  private tray: Tray | undefined;
  private dragOrigin: { x: number; y: number; wx: number; wy: number } | undefined;
  private lastSnapshotEvent: EngineEvent | undefined;

  async start(): Promise<void> {
    setLogLevel(this.engine.config.logLevel);
    this.registerProtocol();
    this.wireIpc();
    this.engine.registerOwnPid(process.pid);
    this.engine.on("event", (e) => this.broadcast(e));
    this.engine.on("audio", (pcm) => this.audio?.webContents.send("audio:out", pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength)));
    this.engine.on("overlay", (cmd) => this.overlayCommand(cmd));

    this.createAudioWindow();
    this.createOrb();
    this.createOverlays();
    this.createTray();
    this.installMenu();
    this.installShortcuts();
    screen.on("display-added", () => this.createOverlays());
    screen.on("display-removed", () => this.createOverlays());

    await this.engine.start();
    // JARHEAD_AUTO_WAKE=0 keeps a dev launch quiet (no session, no billing) until the orb is tapped.
    const autoWake = process.env["JARHEAD_AUTO_WAKE"] === undefined ? this.engine.currentSettings.autoWake : process.env["JARHEAD_AUTO_WAKE"] !== "0";
    if (autoWake) void this.engine.wake();
  }

  // ------------------------------------------------------------ windows

  private savedOrbPosition(): { x: number; y: number } {
    const saved = this.engine.currentSettings.orbPosition;
    const displays = screen.getAllDisplays();
    if (saved && displays.some((d) => contains(d, saved))) return saved;
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const a = d.workArea;
    return { x: Math.round(a.x + a.width - ORB.collapsed.width - 24), y: Math.round(a.y + a.height - ORB.collapsed.height - 96) };
  }

  private createOrb(): void {
    const pos = this.savedOrbPosition();
    const win = new BrowserWindow({
      ...ORB.collapsed,
      x: pos.x,
      y: pos.y,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: true,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      webPreferences: { preload: join(HERE, "preload.cjs"), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    win.setAlwaysOnTop(true, "screen-saver");
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    void win.loadURL(`${pathToFileURL(join(RENDERER, "orb", "index.html")).href}?window=orb`);
    win.once("ready-to-show", () => win.showInactive());
    win.on("closed", () => (this.orb = undefined));
    this.orb = win;
  }

  private createConsole(): BrowserWindow {
    if (this.consoleWin && !this.consoleWin.isDestroyed()) {
      this.consoleWin.show();
      this.consoleWin.focus();
      return this.consoleWin;
    }
    const win = new BrowserWindow({
      width: 1180,
      height: 760,
      minWidth: 820,
      minHeight: 520,
      title: "Jarhead",
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 14, y: 14 },
      backgroundColor: "#0b0c10",
      webPreferences: { preload: join(HERE, "preload.cjs"), contextIsolation: true, nodeIntegration: false },
    });
    void win.loadURL(`${pathToFileURL(join(RENDERER, "console", "index.html")).href}?window=console`);
    win.on("closed", () => (this.consoleWin = undefined));
    this.consoleWin = win;
    return win;
  }

  private createAudioWindow(): void {
    const win = new BrowserWindow({
      show: false,
      width: 200,
      height: 100,
      webPreferences: { preload: join(HERE, "preload.cjs"), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    // getUserMedia in Electron asks the main process for the media permission.
    win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === "media"));
    void win.loadURL(`${pathToFileURL(join(RENDERER, "audio", "index.html")).href}?window=audio`);
    win.webContents.on("console-message", (e) => {
      if (e.level === "error") log.warn(`audio window: ${e.message}`);
    });
    this.audio = win;
  }

  private createOverlays(): void {
    const live = new Set<number>();
    for (const d of screen.getAllDisplays()) {
      live.add(d.id);
      if (this.overlays.has(d.id)) {
        this.overlays.get(d.id)?.setBounds(d.bounds);
        continue;
      }
      const win = new BrowserWindow({
        ...d.bounds,
        frame: false,
        transparent: true,
        hasShadow: false,
        resizable: false,
        movable: false,
        focusable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        show: false,
        enableLargerThanScreen: true,
        webPreferences: { preload: join(HERE, "preload.cjs"), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
      });
      win.setAlwaysOnTop(true, "screen-saver");
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      win.setIgnoreMouseEvents(true);
      void win.loadURL(`${pathToFileURL(join(RENDERER, "overlay", "index.html")).href}?window=overlay&display=${d.id}`);
      win.once("ready-to-show", () => win.showInactive());
      this.overlays.set(d.id, win);
    }
    for (const [id, win] of this.overlays) {
      if (!live.has(id)) {
        win.destroy();
        this.overlays.delete(id);
      }
    }
  }

  private overlayCommand(cmd: OverlayCommand): void {
    for (const win of this.overlays.values()) if (!win.isDestroyed()) win.webContents.send("overlay:command", cmd);
  }

  // --------------------------------------------------------------- tray

  private createTray(): void {
    const template = join(REPO_ROOT, "build", "iconTemplate.png");
    const icon = existsSync(template) ? nativeImage.createFromPath(template) : nativeImage.createEmpty();
    icon.setTemplateImage(true);
    this.tray = new Tray(icon);
    this.tray.setToolTip("Jarhead");
    this.refreshTray();
  }

  private refreshTray(): void {
    const snap = this.engine.snapshot();
    const awake = snap.phase !== "asleep" && snap.phase !== "error";
    const menu = Menu.buildFromTemplate([
      { label: `Jarhead — ${snap.phase}`, enabled: false },
      { type: "separator" },
      { label: awake ? "Sleep" : "Wake", click: () => void this.engine.command({ type: awake ? "sleep" : "wake" }) },
      { label: snap.phase === "muted" ? "Unmute" : "Mute", accelerator: "Alt+Shift+M", click: () => void this.engine.command({ type: snap.phase === "muted" ? "unmute" : "mute" }) },
      { label: "Stop", accelerator: "Alt+Escape", click: () => void this.engine.command({ type: "stop" }) },
      { type: "separator" },
      { label: "Open Console", accelerator: "Alt+Shift+J", click: () => this.createConsole() },
      { label: "Summon Orb to cursor", click: () => this.summonOrb() },
      { label: "Open ledger folder", click: () => void shell.openPath(this.engine.ledger.dir) },
      { type: "separator" },
      { label: "Quit Jarhead", role: "quit" },
    ]);
    this.tray?.setContextMenu(menu);
    if (process.platform === "darwin") app.dock?.setMenu(menu);
  }

  private installMenu(): void {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: "appMenu" },
        { role: "editMenu" },
        { label: "View", submenu: [{ role: "reload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "togglefullscreen" }] },
        { role: "windowMenu" },
      ]),
    );
  }

  private installShortcuts(): void {
    const bind = (accel: string, fn: () => void): void => {
      if (!globalShortcut.register(accel, fn)) log.warn(`could not bind ${accel}`);
    };
    bind("Alt+Shift+J", () => this.createConsole());
    bind("Alt+Shift+M", () => void this.engine.command({ type: this.engine.currentPhase === "muted" ? "unmute" : "mute" }));
    bind("Alt+Escape", () => void this.engine.command({ type: "stop" }));
    bind("Alt+Shift+Space", () => void this.engine.command({ type: this.engine.currentPhase === "asleep" ? "wake" : "sleep" }));
  }

  private summonOrb(): void {
    const win = this.orb;
    if (!win) return;
    const p = screen.getCursorScreenPoint();
    const [w, h] = win.getSize();
    const x = Math.round(p.x - (w ?? 112) / 2);
    const y = Math.round(p.y - (h ?? 112) / 2 - 30);
    win.setPosition(x, y, false);
    win.showInactive();
    this.engine.updateSettings({ orbPosition: { x, y } });
  }

  // ---------------------------------------------------------------- ipc

  private broadcast(e: EngineEvent): void {
    if (e.type === "snapshot") {
      this.lastSnapshotEvent = e;
      this.refreshTray();
    }
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send("engine:event", e);
  }

  private wireIpc(): void {
    ipcMain.on("engine:subscribe", (event) => {
      const e = this.lastSnapshotEvent ?? { type: "snapshot", snapshot: this.engine.snapshot() };
      event.sender.send("engine:event", e);
    });
    ipcMain.on("engine:command", (_e, cmd: unknown) => {
      if (!isEngineCommand(cmd)) return log.warn(`bad command ${JSON.stringify(cmd).slice(0, 120)}`);
      if (cmd.type === "open-console") return void this.createConsole();
      if (cmd.type === "open-ledger") return void shell.openPath(this.engine.ledger.dir);
      void this.engine.command(cmd).catch((err: unknown) => this.engine.problem(`command ${cmd.type} failed: ${(err as Error).message}`));
    });
    ipcMain.on("orb:drag", (_e, m: { phase: string; screenX: number; screenY: number }) => {
      const win = this.orb;
      if (!win) return;
      if (m.phase === "start") {
        const [wx, wy] = win.getPosition();
        this.dragOrigin = { x: m.screenX, y: m.screenY, wx: wx ?? 0, wy: wy ?? 0 };
      } else if (m.phase === "move" && this.dragOrigin) {
        win.setPosition(Math.round(this.dragOrigin.wx + (m.screenX - this.dragOrigin.x)), Math.round(this.dragOrigin.wy + (m.screenY - this.dragOrigin.y)), false);
      } else if (m.phase === "end") {
        this.dragOrigin = undefined;
        const [x, y] = win.getPosition();
        this.engine.updateSettings({ orbPosition: { x: x ?? 0, y: y ?? 0 } });
      }
    });
    ipcMain.on("orb:resize", (_e, m: { width: number; height: number }) => {
      const win = this.orb;
      if (!win) return;
      const [x, y] = win.getPosition();
      const [w] = win.getSize();
      // Grow leftwards when expanding near the right edge so the capsule stays on screen.
      const d = screen.getDisplayNearestPoint({ x: x ?? 0, y: y ?? 0 }).workArea;
      const nx = Math.min(x ?? 0, d.x + d.width - m.width);
      const ny = Math.min(y ?? 0, d.y + d.height - m.height);
      win.setBounds({ x: Math.round(Math.max(d.x, nx)), y: Math.round(Math.max(d.y, ny)), width: Math.round(m.width), height: Math.round(m.height) }, false);
      if ((w ?? 0) > m.width) win.setPosition(Math.round(Math.max(d.x, nx)), Math.round(Math.max(d.y, ny)), false);
    });
    ipcMain.handle("overlay:bounds", (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const b = win?.getBounds() ?? { x: 0, y: 0, width: 0, height: 0 };
      const d = screen.getDisplayMatching(b);
      return { x: b.x, y: b.y, w: b.width, h: b.height, scaleFactor: d.scaleFactor };
    });
    ipcMain.on("shell:open-external", (_e, url: string) => {
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    });
    ipcMain.handle("ledger:read", (_e, date: string) => {
      const t = Date.parse(`${date}T12:00:00`);
      return Number.isFinite(t) ? this.engine.ledger.read(t) : [];
    });
    // The Console picks the first entry by default, so newest comes first.
    ipcMain.handle("ledger:days", () => this.engine.ledger.days().map((f) => f.replace(/\.jsonl$/, "")).reverse());
    ipcMain.on("audio:in", (_e, buf: ArrayBuffer) => this.engine.feedMic(Buffer.from(buf)));
    ipcMain.on("audio:level", (_e, level: number) => this.engine.reportInputLevel(Number(level) || 0));
    ipcMain.on("audio:mic", (_e, state: "granted" | "denied" | "unknown") => this.engine.setMicrophonePermission(state));
    ipcMain.handle("audio:mic-device", () => this.engine.currentSettings.micDeviceId ?? null);
  }

  private registerProtocol(): void {
    // Screenshots live under the state dir; serve them read-only to the Console.
    protocol.handle("jarhead-shot", (request) => {
      const rel = decodeURIComponent(new URL(request.url).pathname.replace(/^\/+/, ""));
      if (rel.includes("..")) return new Response("forbidden", { status: 403 });
      const path = join(this.engine.config.stateDir, rel);
      return net.fetch(pathToFileURL(path).href);
    });
  }

  async stop(): Promise<void> {
    globalShortcut.unregisterAll();
    await this.engine.stop();
  }
}

function contains(d: Display, p: { x: number; y: number }): boolean {
  const a = d.workArea;
  return p.x >= a.x - 50 && p.x <= a.x + a.width && p.y >= a.y - 50 && p.y <= a.y + a.height;
}

protocol.registerSchemesAsPrivileged([{ scheme: "jarhead-shot", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

async function main(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  await app.whenReady();
  app.setName("Jarhead");
  const iconPath = join(REPO_ROOT, "build", "icon.png");
  if (process.platform === "darwin" && existsSync(iconPath)) app.dock?.setIcon(nativeImage.createFromPath(iconPath));

  const shellApp = new Shell();
  app.on("activate", () => shellApp["createConsole"]());
  app.on("second-instance", () => shellApp["createConsole"]());
  app.on("window-all-closed", () => {
    // The orb and overlays are windows too; quitting is explicit.
  });
  app.on("before-quit", () => {
    void shellApp.stop();
  });
  await shellApp.start();
  log.info(`Jarhead up (${shellApp.engine.brainInfo.kind}: ${shellApp.engine.brainInfo.detail})`);
  // Persist a pid so the CLI can tell whether the app is running.
  try {
    writeFileSync(join(shellApp.engine.config.stateDir, "app.pid"), String(process.pid));
  } catch {
    // cosmetic
  }
}

main().catch((e: unknown) => {
  console.error(`jarhead failed to start: ${(e as Error).stack ?? (e as Error).message}`);
  process.exit(1);
});

export { readFileSync };
