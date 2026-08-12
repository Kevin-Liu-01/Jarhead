// The only bridge between the main process and the page. The page gets one
// callback registration and nothing else — no ipcRenderer, no node — because
// this window sits above everything on screen and deserves the smallest
// possible attack surface.
const { contextBridge, ipcRenderer } = require("electron");

// Announce that the bridge exists. Without this, a renderer that failed to run
// is indistinguishable from one that ran and simply ignored the click.
ipcRenderer.send("overlay:ready");

contextBridge.exposeInMainWorld("jarvisOverlay", {
  onCommand(callback) {
    ipcRenderer.on("overlay:command", (_event, message) => callback(message));
  },
  /** Kevin clicked the buddy. One-way; the main process decides what that means. */
  tap() {
    ipcRenderer.send("overlay:tap");
  },
  // Dragging is tracked here rather than with -webkit-app-region, which would
  // swallow the events tap() needs.
  dragStart(point) {
    ipcRenderer.send("overlay:dragstart", point);
  },
  dragMove(point) {
    ipcRenderer.send("overlay:dragmove", point);
  },
  dragEnd() {
    ipcRenderer.send("overlay:dragend");
  },
});
