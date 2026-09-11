// The only bridge between the renderer and the engine. Nothing here has access
// to Node APIs beyond what is exposed, and the renderer never sees a credential.
const { contextBridge, ipcRenderer } = require("electron");

const windowKind = new URLSearchParams(location.search).get("window") || "console";

function on(channel, listener) {
  const handler = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("jarhead", {
  window: windowKind,
  onEvent(listener) {
    const off = on("engine:event", listener);
    ipcRenderer.send("engine:subscribe");
    return off;
  },
  send(command) {
    ipcRenderer.send("engine:command", command);
  },
  orbDrag(phase, screenX, screenY) {
    ipcRenderer.send("orb:drag", { phase, screenX, screenY });
  },
  orbResize(width, height) {
    ipcRenderer.send("orb:resize", { width, height });
  },
  onOverlay(listener) {
    return on("overlay:command", listener);
  },
  overlayBounds() {
    return ipcRenderer.invoke("overlay:bounds");
  },
  openExternal(url) {
    ipcRenderer.send("shell:open-external", String(url));
  },
  readLedger(date) {
    return ipcRenderer.invoke("ledger:read", String(date));
  },
  ledgerDays() {
    return ipcRenderer.invoke("ledger:days");
  },
  screenshotUrl(path) {
    return `jarhead-shot://local/${String(path).replace(/^\/+/, "")}`;
  },
});

// The hidden audio window uses this half: PCM in both directions.
contextBridge.exposeInMainWorld("jarheadAudio", {
  sendPcm(buffer) {
    ipcRenderer.send("audio:in", buffer);
  },
  reportLevel(level) {
    ipcRenderer.send("audio:level", level);
  },
  reportMic(state) {
    ipcRenderer.send("audio:mic", state);
  },
  onPcm(listener) {
    return on("audio:out", listener);
  },
  onControl(listener) {
    return on("audio:control", listener);
  },
  micDevice() {
    return ipcRenderer.invoke("audio:mic-device");
  },
});
