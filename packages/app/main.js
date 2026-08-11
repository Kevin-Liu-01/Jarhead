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

const { app, BrowserWindow, Menu, Tray, globalShortcut, nativeImage, shell, dialog } = require("electron");
const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join } = require("node:path");

const REPO = require("./repo-path.json").repo;
const TSX = join(REPO, "node_modules", ".bin", "tsx");
const AGENT = join(REPO, "packages", "agent", "src", "main.ts");
const DAEMON = join(REPO, "packages", "daemon", "src", "main.ts");

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

function toggleOverlay() {
  if (!overlayWindow) return;
  if (overlayWindow.isVisible()) overlayWindow.hide();
  else overlayWindow.showInactive();
  refreshMenus();
}

function createOverlay() {
  overlayWindow = new BrowserWindow({
    width: 220,
    height: 220,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    // Excluded from screen capture so Jarvis never sees itself in its own
    // screenshots — otherwise the vision path describes the buddy back to Kevin.
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  overlayWindow.setAlwaysOnTop(true, "screen-saver");
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.setContentProtection(false);
  // forward:true is a Windows-only option; on macOS this is all-or-nothing,
  // which is the concrete limitation that argues for a native shell later.
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });

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
