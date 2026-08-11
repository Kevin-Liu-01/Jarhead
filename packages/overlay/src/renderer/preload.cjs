// The only bridge between the main process and the page. The page gets one
// callback registration and nothing else — no ipcRenderer, no node — because
// this window sits above everything on screen and deserves the smallest
// possible attack surface.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("jarvisOverlay", {
  onCommand(callback) {
    ipcRenderer.on("overlay:command", (_event, message) => callback(message));
  },
});
