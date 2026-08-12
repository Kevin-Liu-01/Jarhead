/**
 * Electron main process — the only file in this package that imports
 * "electron", because it is the file that gets deleted if M3 goes native.
 *
 * DECISION.md §1 is right that Swift is the better shell for this window, and
 * the sharpest reason is contained in one line below: Electron's
 * `setIgnoreMouseEvents(true, {forward: true})` forwards mouse events to the
 * page on Windows only. On macOS the overlay is therefore either fully
 * click-through or fully interactive — no per-region hitTest islands, no
 * hover awareness while click-through. Kevin chose all-TypeScript for M0–M2
 * (DECISION-AMENDMENTS.md §2), so this file keeps every Electron-specific
 * compromise in one place, and the unix socket in ipc.ts is exactly the seam
 * a Swift NSPanel would plug back into.
 */

import { app, BrowserWindow, screen } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OverlayServer, overlaySocketPath, type OverlayHandler } from "./ipc.ts";
import { reduce, type BuddyEvent, type BuddyState, type OverlayState } from "./state.ts";
import { distance, flightDuration, flightFrame, type Point } from "./pointer.ts";
import { clampToWorkArea, nearestDisplay, windowTopLeftFor, type DisplayInfo } from "./display.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

const WINDOW = { width: 280, height: 220 } as const;
/** The buddy's pointer tip, in window coordinates. Flights place this pixel on the target. */
const ANCHOR: Point = { x: 140, y: 196 };
/** ~60Hz. The timer exists only while a flight is running — idle cost is zero. */
const FRAME_MS = 16;

type RendererMessage =
  | { readonly kind: "state"; readonly state: OverlayState }
  | { readonly kind: "say"; readonly text: string; readonly ttlMs: number | undefined }
  | { readonly kind: "flight"; readonly durationMs: number }
  | { readonly kind: "interactive"; readonly interactive: boolean };

class Overlay implements OverlayHandler {
  private win: BrowserWindow | undefined;
  private state: BuddyState = "idle";
  private flight: NodeJS.Timeout | undefined;

  async start(): Promise<void> {
    const win = new BrowserWindow({
      width: WINDOW.width,
      height: WINDOW.height,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      // Never a focus target. Combined with showInactive() below, the buddy
      // can appear over whatever Kevin is typing into without stealing a
      // single keystroke.
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      webPreferences: {
        preload: join(HERE, "renderer", "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    // "screen-saver" is the highest level Electron exposes; anything lower
    // loses to full-screen video and system palettes.
    win.setAlwaysOnTop(true, "screen-saver");
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    // Click-through by default. Honesty note: `forward: true` is a no-op on
    // macOS (Electron forwards mouse-move to the page on Windows only), so
    // while click-through the page gets no hover events at all. This binary
    // all-or-nothing is the concrete limitation that argues for a native
    // NSPanel with per-region hitTest at M3.
    win.setIgnoreMouseEvents(true, { forward: true });

    await win.loadFile(join(HERE, "renderer", "index.html"));
    // show() would activate the app and yank focus mid-keystroke.
    win.showInactive();
    this.win = win;
  }

  private post(message: RendererMessage): void {
    this.win?.webContents.send("overlay:command", message);
  }

  private apply(event: BuddyEvent): void {
    const next = reduce(this.state, event);
    if (next === this.state) return;
    const wasHidden = this.state === "hidden";
    this.state = next;
    if (next === "hidden") {
      this.cancelFlight();
      this.win?.hide();
      return;
    }
    if (wasHidden) this.win?.showInactive();
    this.post({ kind: "state", state: next });
  }

  private cancelFlight(): void {
    if (this.flight !== undefined) clearInterval(this.flight);
    this.flight = undefined;
  }

  setState(state: OverlayState): void {
    // A direct state command supersedes any flight in progress; the window
    // simply stays where the interrupted arc left it.
    if (state !== "pointing") this.cancelFlight();
    this.apply({ type: "set", state });
  }

  flyTo(x: number, y: number): void {
    const win = this.win;
    if (!win) throw new Error("overlay window is not ready yet");
    if (this.state === "hidden") throw new Error("overlay is hidden; send show first");

    this.cancelFlight();

    const displays: DisplayInfo[] = screen
      .getAllDisplays()
      .map((d) => ({ id: d.id, bounds: d.bounds, workArea: d.workArea }));
    const display = nearestDisplay(displays, { x, y });
    const to = clampToWorkArea(windowTopLeftFor({ x, y }, ANCHOR), WINDOW, display.workArea);

    const [px, py] = win.getPosition();
    const from: Point = { x: px ?? 0, y: py ?? 0 };
    const durationMs = flightDuration(distance(from, to));

    this.apply({ type: "set", state: "pointing" });
    // The renderer runs the apex scale pulse over the same duration, so the
    // pulse peaks exactly when the arc does.
    this.post({ kind: "flight", durationMs });

    const startedAt = Date.now();
    // setInterval, not requestAnimationFrame: the main process has no rAF.
    // Wall-clock elapsed (rather than a frame counter) keeps the landing time
    // honest even if the event loop hiccups.
    this.flight = setInterval(() => {
      const frame = flightFrame(from, to, Date.now() - startedAt, durationMs);
      win.setPosition(Math.round(frame.position.x), Math.round(frame.position.y), false);
      if (frame.done) {
        this.cancelFlight();
        this.apply({ type: "land" });
      }
    }, FRAME_MS);
  }

  say(text: string, ttlMs: number | undefined): void {
    if (this.state === "hidden") throw new Error("overlay is hidden; send show first");
    this.post({ kind: "say", text, ttlMs });
  }

  hide(): void {
    this.apply({ type: "hide" });
  }

  show(): void {
    this.apply({ type: "show" });
  }

  setInteractive(interactive: boolean): void {
    // Because macOS ignores `forward`, this toggle is the whole interaction
    // story: fully grabbable or fully ghost. The renderer adds a drag region
    // and a visual affordance while interactive.
    this.win?.setIgnoreMouseEvents(!interactive, { forward: true });
    this.post({ kind: "interactive", interactive });
  }

  /**
   * Move to the cursor and flash.
   *
   * The escape hatch for "where did it go" — which is a real failure mode: it can
   * sit on a display that is no longer attached, behind a full-screen window, or
   * render perfectly while being invisible against a bright wallpaper.
   */
  summon(): void {
    const win = this.win;
    if (!win) return;
    const p = screen.getCursorScreenPoint();
    const size = win.getSize();
    const w = size[0] ?? 220;
    const h = size[1] ?? 220;
    win.setPosition(Math.round(p.x - w / 2), Math.round(p.y - h / 2 - 40), false);
    win.showInactive();
    this.setState("listening");
    setTimeout(() => this.setState("idle"), 1400);
  }
}

async function main(): Promise<void> {
  // The socket server recovers stale socket files by unlinking them, so two
  // live overlays would silently steal each other's socket. The instance lock
  // turns that into an explicit "already running".
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  await app.whenReady();
  // A HUD, not an app: no Dock icon, no Cmd-Tab entry.
  app.dock?.hide();

  const overlay = new Overlay();
  await overlay.start();

  const server = new OverlayServer(overlay, overlaySocketPath());
  await server.listen();
  console.log(`overlay listening on ${overlaySocketPath()}`);

  app.on("will-quit", () => {
    void server.close();
  });
}

main().catch((e: unknown) => {
  console.error(`overlay failed to start: ${(e as Error).message}`);
  process.exit(1);
});
