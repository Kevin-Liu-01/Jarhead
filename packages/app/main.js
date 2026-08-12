"use strict";

/**
 * Jarvis.app — the Dock citizen.
 *
 * Deliberately plain CommonJS, not TypeScript. Everything else in this repo runs
 * through tsx, but the packaged bundle would then have to carry tsx, esbuild and
 * the whole TS source tree just to boot. Instead this file is the face — Dock
 * icon, menu, hotkey, overlay — and it shells out to the repo's own CLI for the
 * heavy work. The repo path is baked in at package time.
 *
 * The bundle is also the TCC identity. Grants Kevin gave his terminal do NOT
 * transfer here: macOS will prompt again on first mic/screen/accessibility use,
 * which is why Info.plist carries real usage strings.
 */

const { app, BrowserWindow, Menu, Tray, globalShortcut, nativeImage, screen, shell, dialog } = require("electron");
const { spawn } = require("node:child_process");
const { existsSync, readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");
const { homedir } = require("node:os");

const REPO = require("./repo-path.json").repo;
const TSX = join(REPO, "node_modules", ".bin", "tsx");
const AGENT = join(REPO, "packages", "agent", "src", "main.ts");
const DAEMON = join(REPO, "packages", "daemon", "src", "main.ts");

const STATE_DIR = process.env.JARVIS_STATE_DIR || join(homedir(), ".jarvis");
const POSITION_FILE = join(STATE_DIR, "overlay-position.json");

const BUDDY_SIZE = 220;
/** Clear of the Dock and the screen edge, on the display holding the cursor. */
const INSET = { right: 28, bottom: 96 };

function savedPosition() {
  try {
    const p = JSON.parse(readFileSync(POSITION_FILE, "utf8"));
    if (Number.isFinite(p.x) && Number.isFinite(p.y)) return p;
  } catch {
    // No saved position yet.
  }
  return undefined;
}

function savePosition(x, y) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(POSITION_FILE, JSON.stringify({ x, y }));
  } catch {
    // Losing the position is cosmetic.
  }
}

/**
 * Default to the bottom-right of whichever display the cursor is on.
 *
 * Centre-screen is where Electron puts a window with no coordinates, and it is
 * the worst possible spot: the buddy lands on top of whatever Kevin is reading,
 * and — before the capture fix — directly in the middle of every screenshot.
 * Anchoring to the cursor's display matters here because the displays sit at
 * negative coordinates, so hardcoding anything would land off-screen.
 */
function defaultPosition() {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x, y, width, height } = display.workArea;
  return {
    x: Math.round(x + width - BUDDY_SIZE - INSET.right),
    y: Math.round(y + height - BUDDY_SIZE - INSET.bottom),
  };
}

/** True when the saved point still lands on a connected display. */
function onSomeDisplay(pos) {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return pos.x >= a.x - BUDDY_SIZE && pos.x <= a.x + a.width && pos.y >= a.y - BUDDY_SIZE && pos.y <= a.y + a.height;
  });
}

let tray;
let overlayWindow;
let daemon;
let busy = false;

/** Everything the app runs goes through here so one missing repo is one message. */
function runAgent(args, { onLine } = {}) {
  return new Promise((resolve) => {
    if (!existsSync(TSX)) {
      dialog.showErrorBox(
        "Jarvis cannot find its code",
        `Expected the repo at:\n${REPO}\n\nRun 'pnpm install' there, then relaunch.`,
      );
      resolve({ code: 1, out: "" });
      return;
    }
    const child = spawn(TSX, [AGENT, ...args], {
      cwd: REPO,
      env: { ...process.env, JARVIS_FROM_APP: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const feed = (buf) => {
      const text = buf.toString();
      out += text;
      if (onLine) for (const line of text.split("\n")) if (line.trim()) onLine(line);
    };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.on("error", () => resolve({ code: 1, out }));
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

function setTrayState(state) {
  if (!tray) return;
  const label = { idle: "Jarvis", listening: "Jarvis — listening", thinking: "Jarvis — thinking" }[state] ?? "Jarvis";
  tray.setToolTip(label);
}

/**
 * One spoken turn. Serialized: two overlapping turns would talk over each other,
 * and the second would also fight the first for the microphone.
 */
async function speakTurn(args, stateLabel) {
  if (busy) return;
  busy = true;
  setTrayState(stateLabel);
  try {
    await runAgent(args);
  } finally {
    busy = false;
    setTrayState("idle");
  }
}

function buildMenu() {
  return Menu.buildFromTemplate([
    { label: busy ? "Working…" : "Jarvis", enabled: false },
    { type: "separator" },
    {
      label: "Ask (hold to talk)",
      accelerator: "Alt+Space",
      click: () => void speakTurn(["listen"], "listening"),
    },
    {
      label: "What's on my screen?",
      click: () => void speakTurn(["see", "what am I looking at?"], "thinking"),
    },
    {
      label: "What's on Hacker News?",
      click: () => void speakTurn(["ask", "what's on hackernews"], "thinking"),
    },
    {
      label: "My daily briefing",
      click: () => void speakTurn(["ask", "what's my daily briefing today"], "thinking"),
    },
    { type: "separator" },
    { label: "Automations…", click: () => void runAgent(["automations"]) },
    { label: "Permissions…", click: () => void runAgent(["permissions", "--open"]) },
    {
      label: overlayWindow && overlayWindow.isVisible() ? "Hide buddy" : "Show buddy",
      click: () => toggleOverlay(),
    },
    {
      label: buddyDraggable ? "Lock buddy (click-through)" : "Move buddy…",
      click: () => setBuddyDraggable(!buddyDraggable),
    },
    { label: "Reset buddy position", click: () => resetBuddyPosition() },
    { type: "separator" },
    { label: "Open repo", click: () => void shell.openPath(REPO) },
    { label: "Quit Jarvis", role: "quit" },
  ]);
}

function refreshMenus() {
  const menu = buildMenu();
  if (tray) tray.setContextMenu(menu);
  if (process.platform === "darwin" && app.dock) app.dock.setMenu(menu);
}

let buddyDraggable = false;

/**
 * Toggle click-through so the buddy can be dragged.
 *
 * macOS has no per-region click-through — setIgnoreMouseEvents' `forward`
 * option is Windows-only — so this is all-or-nothing and has to be a deliberate
 * mode. While draggable, the buddy eats clicks meant for whatever is under it.
 */
function setBuddyDraggable(draggable) {
  if (!overlayWindow) return;
  buddyDraggable = draggable;
  overlayWindow.setIgnoreMouseEvents(!draggable, { forward: true });
  overlayWindow.setFocusable(draggable);
  refreshMenus();
}

function resetBuddyPosition() {
  if (!overlayWindow) return;
  const pos = defaultPosition();
  overlayWindow.setPosition(pos.x, pos.y, false);
  savePosition(pos.x, pos.y);
}

function toggleOverlay() {
  if (!overlayWindow) return;
  if (overlayWindow.isVisible()) overlayWindow.hide();
  else overlayWindow.showInactive();
  refreshMenus();
}

function createOverlay() {
  const saved = savedPosition();
  const pos = saved && onSomeDisplay(saved) ? saved : defaultPosition();

  overlayWindow = new BrowserWindow({
    width: BUDDY_SIZE,
    height: BUDDY_SIZE,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  overlayWindow.setAlwaysOnTop(true, "screen-saver");
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // NOT setContentProtection(true): it is a no-op on this macOS. Measured — a
  // protected window and an unprotected one gave byte-identical captures. The
  // vision path hides this window around each screenshot instead; see
  // packages/agent/src/capture.ts.
  overlayWindow.setContentProtection(false);
  // forward:true is a Windows-only option; on macOS this is all-or-nothing,
  // which is the concrete limitation that argues for a native shell later.
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });

  overlayWindow.on("moved", () => {
    const [x, y] = overlayWindow.getPosition();
    savePosition(x, y);
  });

  const renderer = join(REPO, "packages", "overlay", "src", "renderer", "index.html");
  if (existsSync(renderer)) void overlayWindow.loadFile(renderer);
  else void overlayWindow.loadURL("data:text/html,<body style='background:transparent'></body>");
}

function startDaemon() {
  if (!existsSync(TSX)) return;
  daemon = spawn(TSX, [DAEMON], { cwd: REPO, stdio: "ignore", detached: false });
  daemon.on("error", () => undefined);
}

app.whenReady().then(() => {
  const icon = nativeImage.createFromPath(join(__dirname, "icon.png"));
  if (process.platform === "darwin" && app.dock && !icon.isEmpty()) app.dock.setIcon(icon);

  // A purpose-built template image, NOT a resize of the colour icon. macOS reads
  // only the alpha of a template, so downscaling the full-colour squircle made
  // every opaque pixel silhouette and the menu bar showed a solid blob.
  const trayIcon = nativeImage.createFromPath(join(__dirname, "iconTemplate.png"));
  if (!trayIcon.isEmpty()) trayIcon.setTemplateImage(true);
  tray = new Tray(trayIcon.isEmpty() ? nativeImage.createEmpty() : trayIcon);
  setTrayState("idle");

  createOverlay();
  startDaemon();
  refreshMenus();

  globalShortcut.register("Alt+Space", () => void speakTurn(["listen"], "listening"));

  // Clicking the Dock icon with no windows open should still do something useful.
  app.on("activate", () => {
    if (overlayWindow && !overlayWindow.isVisible()) overlayWindow.showInactive();
  });
});

// The overlay is not a document window; closing it must not quit the app.
app.on("window-all-closed", () => undefined);

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  if (daemon && !daemon.killed) daemon.kill("SIGTERM");
});
