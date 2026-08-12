// The annotation surface: absolutely positioned <pre> blocks on a
// transparent full-screen window.
//
// Plain JS on purpose — the renderer has no build step, so this file is
// exactly what ships.
//
// Deliberately thin. Every decision worth testing (glyph choice, wrapping,
// placement, protocol validation) already happened in the main process,
// which sends finished rows plus a window-local pixel position. What remains
// here is DOM bookkeeping: create, position, fade, pulse, remove. There is
// no per-frame loop at all — a full-screen character grid would be ~120k
// cells on this display and could never repaint at frame rate, but a handful
// of static <pre> blocks costs nothing between commands.
"use strict";

(() => {
  /** id → element. Ids are the protocol's handles; redrawing an id replaces it. */
  const annotations = new Map();

  /**
   * Cell size in pixels, measured rather than assumed — same trick and same
   * reason as overlay.js: the real size depends on which font actually
   * resolved. The main process renders shapes and converts pixels to cells,
   * so the measurement is reported up through the bridge rather than kept.
   */
  function measureCell() {
    const probe = document.createElement("pre");
    probe.className = "metrics";
    probe.style.cssText = "visibility:hidden";
    probe.textContent = "X".repeat(10) + "\n" + "X".repeat(10);
    document.body.appendChild(probe);
    const rect = probe.getBoundingClientRect();
    probe.remove();
    const width = rect.width / 10;
    const height = rect.height / 2;
    return width > 0 && height > 0 ? { width, height, aspect: height / width } : { width: 8, height: 14, aspect: 1.75 };
  }

  const bridge = window.jarvisAnnotate;

  function reportMetrics() {
    if (bridge) bridge.reportMetrics(measureCell());
  }

  function draw(id, x, y, rows) {
    // Replace, don't stack: a redraw of the same id is a move or reshape,
    // and fading the old one out would leave two arrows disagreeing.
    const existing = annotations.get(id);
    if (existing) existing.remove();

    const el = document.createElement("pre");
    el.className = "ann";
    // textContent, never innerHTML: label text is model output quoting
    // arbitrary screen content.
    el.textContent = rows.join("\n");
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    document.body.appendChild(el);
    annotations.set(id, el);
    // Class added on the next frame so the opacity transition actually runs;
    // adding it before first layout paints at full opacity with no fade.
    requestAnimationFrame(() => el.classList.add("in"));
  }

  function erase(id) {
    const el = annotations.get(id);
    if (!el) return;
    annotations.delete(id);
    el.classList.remove("in");
    el.classList.add("out");
    el.addEventListener("transitionend", () => el.remove(), { once: true });
    // transitionend never fires on an occluded or hidden window, and reduced
    // motion skips the transition entirely; the timer guarantees removal.
    setTimeout(() => el.remove(), 500);
  }

  function clear() {
    for (const id of [...annotations.keys()]) erase(id);
  }

  function pulse(id) {
    const el = annotations.get(id);
    if (!el) return;
    // Remove-reflow-add restarts the animation when pulses stack; without the
    // forced reflow the browser coalesces the class flip and nothing flashes.
    el.classList.remove("pulse");
    void el.offsetWidth;
    el.classList.add("pulse");
  }

  if (bridge) {
    bridge.onCommand((message) => {
      switch (message.kind) {
        case "draw":
          draw(message.id, message.x, message.y, message.rows);
          break;
        case "erase":
          erase(message.id);
          break;
        case "clear":
          clear();
          break;
        case "pulse":
          pulse(message.id);
          break;
      }
    });
  }

  // Fonts can resolve after first paint, so measure once the document is
  // ready and again after fonts settle — a shape rendered against the wrong
  // cell size is a stretched circle.
  reportMetrics();
  if (document.fonts && document.fonts.ready) {
    void document.fonts.ready.then(reportMetrics);
  }
})();
