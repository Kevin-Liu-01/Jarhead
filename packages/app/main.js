"use strict";

/**
 * Jarhead.app — the Dock citizen.
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

const { app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, nativeImage, screen, shell, dialog } = require("electron");
const { spawn } = require("node:child_process");
const { existsSync, readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { windowBounds } = require("./window-bounds.js");
const { computeContacts } = require("./contacts.js");
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
let overlayServer;
let busy = false;

/** Everything the app runs goes through here so one missing repo is one message. */
function runAgent(args, { onLine } = {}) {
  return new Promise((resolve) => {
    if (!existsSync(TSX)) {
      dialog.showErrorBox(
        "Jarhead cannot find its code",
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

/**
 * Which display edges the buddy is currently touching.
 *
 * Sent to the renderer so the blob can lean away from them and open its bubble
 * into free space. Computed here rather than in the renderer because only the
 * main process knows the display geometry — and these displays sit at negative
 * coordinates, so nothing about it can be assumed.
 */
const EDGE_SLOP = 40;

function nearEdges() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return [];
  const b = overlayWindow.getBounds();
  const area = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 }).workArea;
  const edges = [];
  if (b.x - area.x <= EDGE_SLOP) edges.push("left");
  if (area.x + area.width - (b.x + b.width) <= EDGE_SLOP) edges.push("right");
  if (b.y - area.y <= EDGE_SLOP) edges.push("top");
  if (area.y + area.height - (b.y + b.height) <= EDGE_SLOP) edges.push("bottom");
  return edges;
}

/**
 * Windows to squish against, refreshed when a drag begins.
 *
 * Not per-frame: the CoreGraphics query costs ~90ms, and other windows do not
 * move while Kevin is dragging the buddy, so one snapshot per drag is both
 * cheap and correct.
 */
let obstacles = [];
/** True only between dragstart and dragend — window squish is a drag effect. */
let dragging = false;

async function refreshObstacles() {
  obstacles = await windowBounds();
}

function pushContacts() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const b = overlayWindow.getBounds();
  const area = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 }).workArea;
  const contacts = computeContacts(b, area, obstacles, dragging);
  overlayWindow.webContents.send("overlay:command", { kind: "contacts", contacts });
}

function pushEdges() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayWindow.webContents.send("overlay:command", { kind: "edges", edges: nearEdges() });
}

function setBuddyState(state) {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send("overlay:command", { kind: "state", state });
  }
}

function buddySay(text) {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send("overlay:command", { kind: "say", text });
  }
}

function setTrayState(state) {
  if (!tray) return;
  const label = { idle: "Jarhead", listening: "Jarhead — listening", thinking: "Jarhead — thinking" }[state] ?? "Jarhead";
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
  // A tap already set "alert"; do not demote it back to plain listening.
  setBuddyState(stateLabel === "listening" ? "alert" : "thinking");
  refreshMenus();
  try {
    // Surface the answer in the bubble so a tap-to-talk turn has a visible
    // result even when Kevin is looking at the buddy rather than a terminal.
    let spoken;
    await runAgent(args, {
      onLine: (line) => {
        const m = /^\s*jarvis:\s*(.+)$/.exec(line);
        if (m && m[1]) {
          spoken = m[1];
          setBuddyState("speaking");
        }
      },
    });
    if (spoken) buddySay(spoken);
  } finally {
    busy = false;
    setTrayState("idle");
    setBuddyState("idle");
    refreshMenus();
  }
}

function buildMenu() {
  return Menu.buildFromTemplate([
    { label: busy ? "Working…" : "Jarhead", enabled: false },
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
      label: ghost ? "Make buddy clickable" : "Ghost mode (click-through)",
      click: () => setGhost(!ghost),
    },
    { label: "Summon buddy to cursor", click: () => summonBuddy() },
    { label: "Reset buddy position", click: () => resetBuddyPosition() },
    { type: "separator" },
    { label: "Open repo", click: () => void shell.openPath(REPO) },
    { label: "Quit Jarhead", role: "quit" },
  ]);
}

function refreshMenus() {
  const menu = buildMenu();
  if (tray) tray.setContextMenu(menu);
  if (process.platform === "darwin" && app.dock) app.dock.setMenu(menu);
}

/**
 * Ghost mode: click-through, so the buddy cannot intercept a click meant for
 * whatever is beneath it. Off by default — see createOverlay.
 */
let ghost = false;

function setGhost(on) {
  if (!overlayWindow) return;
  ghost = on;
  overlayWindow.setIgnoreMouseEvents(on, { forward: true });
  refreshMenus();
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
  // The renderer turns #core into a -webkit-app-region drag handle and rings it,
  // so the mode is visible. Dragging and tapping cannot coexist on one element.
  overlayWindow.webContents.send("overlay:command", { kind: "interactive", interactive: draggable });
  if (draggable) setGhost(false);
  refreshMenus();
}

/**
 * Bring the buddy to the cursor and make it obvious.
 *
 * Needed because "where did it go" is a real failure mode: it can end up on a
 * display that is no longer attached, behind a full-screen app, or — as happened
 * here — rendering perfectly but invisible against a bright wallpaper. Summoning
 * puts it under Kevin's eyes rather than making him hunt.
 */
function summonBuddy() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const p = screen.getCursorScreenPoint();
  const x = Math.round(p.x - BUDDY_SIZE / 2);
  const y = Math.round(p.y - BUDDY_SIZE / 2 - 40);
  overlayWindow.setPosition(x, y, false);
  savePosition(x, y);
  overlayWindow.showInactive();
  setGhost(false);
  pushEdges();
  pushContacts();
  // A state change kicks the harmonics, so this visibly shivers on arrival.
  setBuddyState("listening");
  setTimeout(() => setBuddyState("idle"), 1400);
}

function resetBuddyPosition() {
  if (!overlayWindow) return;
  const pos = defaultPosition();
  overlayWindow.setPosition(pos.x, pos.y, false);
  savePosition(pos.x, pos.y);
  pushEdges();
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
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(REPO, "packages", "overlay", "src", "renderer", "preload.cjs"),
    },
  });
  overlayWindow.setAlwaysOnTop(true, "screen-saver");
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // NOT setContentProtection(true): it is a no-op on this macOS. Measured — a
  // protected window and an unprotected one gave byte-identical captures. The
  // vision path hides this window around each screenshot instead; see
  // packages/agent/src/capture.ts.
  overlayWindow.setContentProtection(false);

  // Clickable by DEFAULT, which is the opposite of what this used to do.
  // Click-through matters for a full-screen overlay; this is a 220px buddy in a
  // corner, and making it a ghost meant the only thing Kevin could do with it
  // was look at it. Ghost mode is now the deliberate opt-in, via the menu.

  overlayWindow.on("show", () => overlayWindow.webContents.send("overlay:command", { kind: "visible", visible: true }));
  overlayWindow.on("hide", () => overlayWindow.webContents.send("overlay:command", { kind: "visible", visible: false }));

  overlayWindow.on("moved", () => {
    const [x, y] = overlayWindow.getPosition();
    savePosition(x, y);
    pushEdges();
    // Recomputed after dragging clears, so window squish releases and the
    // springs get to wobble back.
    pushContacts();
  });

  // Orientation depends on display geometry, which changes when a monitor is
  // plugged in or the arrangement is edited.
  screen.on("display-metrics-changed", pushEdges);
  screen.on("display-added", pushEdges);
  screen.on("display-removed", pushEdges);

  overlayWindow.webContents.on("did-finish-load", () => {
    pushEdges();
    // One snapshot at startup so a buddy parked against a window is already
    // squished before it is ever touched.
    void refreshObstacles().then(pushContacts);
  });

  // Renderer failures are otherwise completely silent: the buddy still paints,
  // it just stops responding, which reads as "the click did nothing".
  overlayWindow.webContents.on("console-message", (_e, level, message, line, source) => {
    if (level >= 2) console.error(`overlay[${source}:${line}] ${message}`);
  });
  overlayWindow.webContents.on("preload-error", (_e, path, error) => {
    console.error(`overlay preload failed (${path}): ${error.message}`);
  });
  overlayWindow.webContents.on("did-fail-load", (_e, code, desc) => {
    console.error(`overlay failed to load (${code}): ${desc}`);
  });

  const renderer = join(REPO, "packages", "overlay", "src", "renderer", "index.html");
  if (existsSync(renderer)) void overlayWindow.loadFile(renderer);
  else void overlayWindow.loadURL("data:text/html,<body style='background:transparent'></body>");
}

/**
 * Expose the overlay on a unix socket.
 *
 * Without this the buddy is only reachable from inside this process, so the
 * CLI's withOverlayHidden() silently no-ops and the vision path photographs the
 * buddy after all. That was not caught earlier because the buddy happened to be
 * on a different display from the one screencapture grabs.
 *
 * The server is loaded through tsx from the repo, so the .app does not have to
 * carry the overlay package.
 */
async function startOverlayServer() {
  try {
    // createRequire rooted in the repo: tsx lives under pnpm's content-addressed
    // store, so a literal node_modules/tsx path does not exist. Resolving from
    // the repo's package.json follows the symlinks pnpm actually created.
    const { createRequire } = require("node:module");
    const repoRequire = createRequire(join(REPO, "package.json"));
    repoRequire("tsx/esm/api").register();
    const { OverlayServer } = await import(pathToFileURL(repoRequire.resolve("@jarvis/overlay")).href);

    overlayServer = new OverlayServer({
      setState: (state) => setBuddyState(state),
      flyTo: (x, y) => {
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          overlayWindow.setPosition(Math.round(x), Math.round(y), true);
          setBuddyState("pointing");
          pushEdges();
        }
      },
      say: (text, ttlMs) => {
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          overlayWindow.webContents.send("overlay:command", { kind: "say", text, ttlMs });
        }
      },
      hide: () => overlayWindow && overlayWindow.hide(),
      show: () => overlayWindow && overlayWindow.showInactive(),
      setInteractive: (interactive) => setBuddyDraggable(interactive),
      summon: () => summonBuddy(),
    });
    await overlayServer.listen();
    console.log("overlay: socket listening");
  } catch (e) {
    console.error(`overlay: socket unavailable (${e.message}) — screenshots may include the buddy`);
  }
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
  void startOverlayServer();
  startDaemon();
  refreshMenus();

  ipcMain.on("overlay:ready", () => console.log("overlay: renderer bridge ready"));

  /**
   * Free dragging, implemented by hand.
   *
   * -webkit-app-region: drag would be less code but it swallows every mouse
   * event before the page sees it, so click-to-talk would stop working. Moving
   * the window ourselves keeps both: drag past a few pixels and it moves, let
   * go without moving and it is a tap.
   */
  let dragOrigin;
  ipcMain.on("overlay:dragstart", (_e, p) => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    const [wx, wy] = overlayWindow.getPosition();
    dragOrigin = { wx, wy, sx: p.screenX, sy: p.screenY };
    dragging = true;
    // Fire and forget: the first few frames squish against screen edges only,
    // then window edges join in ~90ms later. Awaiting here would stall the drag.
    void refreshObstacles();
  });
  ipcMain.on("overlay:dragmove", (_e, p) => {
    if (!dragOrigin || !overlayWindow || overlayWindow.isDestroyed()) return;
    overlayWindow.setPosition(
      Math.round(dragOrigin.wx + (p.screenX - dragOrigin.sx)),
      Math.round(dragOrigin.wy + (p.screenY - dragOrigin.sy)),
      false,
    );
    pushContacts();
  });
  ipcMain.on("overlay:dragend", () => {
    dragOrigin = undefined;
    dragging = false;
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    const [x, y] = overlayWindow.getPosition();
    savePosition(x, y);
    pushEdges();
    pushContacts();
  });
  /**
   * A tap means "I am talking to you" — it should look like being listened to,
   * not just silently start a recording. The buddy goes alert immediately, well
   * before the microphone or any model has anything to say, because that
   * acknowledgement is the entire point of clicking a face.
   */
  ipcMain.on("overlay:tap", () => {
    console.log("overlay: tap");
    setBuddyState("alert");
    void speakTurn(["listen"], "listening");
  });

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
  if (overlayServer) void overlayServer.close();
  if (daemon && !daemon.killed) daemon.kill("SIGTERM");
});
