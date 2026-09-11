// Bridge acquisition + a tiny event store.
//
// In Electron the preload injects `window.jarhead` before any module runs. In a
// plain browser it is undefined, so we import the mock and install it. The
// surface code never knows which one it got.

/**
 * @param {"orb"|"console"|"overlay"} windowName
 * @returns {Promise<typeof window.jarhead>}
 */
export async function connect(windowName) {
  if (window.jarhead) return window.jarhead;
  const { installMock } = await import("../mock/bridge.js");
  return installMock(windowName);
}

/**
 * Wraps bridge.onEvent into three streams: snapshot (coalesced to one per
 * animation frame), levels (raw, high frequency), toast.
 */
export function createStore(bridge) {
  let snapshot = null;
  let levels = { input: 0, output: 0 };
  const snapshotListeners = new Set();
  const levelListeners = new Set();
  const toastListeners = new Set();

  let frameQueued = false;
  const flush = () => {
    frameQueued = false;
    if (!snapshot) return;
    for (const fn of snapshotListeners) fn(snapshot);
  };

  bridge.onEvent((event) => {
    switch (event.type) {
      case "snapshot":
        snapshot = event.snapshot;
        if (!frameQueued) {
          frameQueued = true;
          requestAnimationFrame(flush);
        }
        break;
      case "levels":
        levels = event.levels;
        for (const fn of levelListeners) fn(levels);
        break;
      case "toast":
        for (const fn of toastListeners) fn(event.text, event.tone);
        break;
      default:
        break;
    }
  });

  return {
    get snapshot() {
      return snapshot;
    },
    get levels() {
      return levels;
    },
    /** Fires immediately if a snapshot is already known, then on each change. */
    onSnapshot(fn) {
      snapshotListeners.add(fn);
      if (snapshot) fn(snapshot);
      return () => snapshotListeners.delete(fn);
    },
    onLevels(fn) {
      levelListeners.add(fn);
      return () => levelListeners.delete(fn);
    },
    onToast(fn) {
      toastListeners.add(fn);
      return () => toastListeners.delete(fn);
    },
    send(command) {
      bridge.send(command);
    },
  };
}

/** Last transcript item by speaker, or undefined. */
export function lastBy(transcript, speaker) {
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    if (transcript[i].speaker === speaker) return transcript[i];
  }
  return undefined;
}

/** Active (running / awaiting) delegation, newest first. */
export function activeDelegation(delegations) {
  for (let i = delegations.length - 1; i >= 0; i -= 1) {
    const d = delegations[i];
    if (d.status === "running" || d.status === "awaiting-confirmation") return d;
  }
  return undefined;
}
