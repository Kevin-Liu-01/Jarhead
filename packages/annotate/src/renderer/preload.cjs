// The only bridge between the main process and the page. Same shape as the
// overlay's preload: one callback registration in, a couple of one-way sends
// out, no ipcRenderer or node exposed — this window covers every pixel of
// every display and deserves the smallest possible attack surface.
const { contextBridge, ipcRenderer } = require("electron");

// Announce that the bridge exists. Without this, a renderer that failed to
// run is indistinguishable from one that ran and simply drew nothing.
ipcRenderer.send("annotate:ready");

contextBridge.exposeInMainWorld("jarvisAnnotate", {
  onCommand(callback) {
    ipcRenderer.on("annotate:command", (_event, message) => callback(message));
  },
  // The measured cell size flows UP: only the page knows which font resolved
  // and what a cell really measures, and the main process needs it to render
  // shapes and convert pixels to cells before sending rows back down.
  reportMetrics(cell) {
    ipcRenderer.send("annotate:metrics", cell);
  },
});
