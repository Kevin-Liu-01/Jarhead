// The buddy: an ASCII blob that breathes, reacts, and gets out of its own way.
//
// Plain JS on purpose — the renderer has no build step, so this file is exactly
// what ships.
//
// Honesty about cost: the previous buddy was a CSS circle with zero JS per
// frame. An ASCII blob cannot be that, because every cell changes every frame.
// So the loop is throttled hard (8fps idle, 24fps active) and stops entirely
// when the window is hidden.
"use strict";

(() => {
  const FIELD_W = 27;
  const FIELD_H = 15;

  // Density ramp, sparse to solid. The blob's edge is the interesting part, so
  // most of the ramp is spent on the low end where the falloff happens.
  const RAMP = " ..::--~~==++**##%%@@";

  const FPS = { idle: 8, active: 24 };

  const blob = document.getElementById("blob");

  /**
   * Cell aspect (height / width), measured rather than assumed.
   *
   * Hardcoding it produced a blob stretched nearly 2:1, because the real ratio
   * depends on font-size, line-height, letter-spacing AND which font actually
   * resolved. Measuring a rendered row is self-correcting when any of those
   * change or the font falls back.
   */
  function measureAspect() {
    const probe = document.createElement("pre");
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;margin:0";
    probe.className = "metrics";
    probe.textContent = "X".repeat(10) + "\n" + "X".repeat(10);
    blob.parentElement.appendChild(probe);
    const rect = probe.getBoundingClientRect();
    probe.remove();
    const cellW = rect.width / 10;
    const cellH = rect.height / 2;
    return cellW > 0 && cellH > 0 ? cellH / cellW : 1.7;
  }

  let ASPECT = 1.7;
  const bubble = document.getElementById("bubble");
  const root = document.body;

  let state = "idle";
  let t = 0;
  let raf = null;
  let lastFrame = 0;
  let bubbleTimer = null;

  // Where the free space is. The blob leans this way and the bubble opens this
  // way, so a buddy parked in a corner never argues with the screen edge.
  const lean = { x: 0, y: 0 };

  /**
   * Per-state character of the motion.
   *
   * amp   how far the surface wobbles
   * speed how fast the field evolves
   * lobes how many bulges travel around the perimeter
   * pull  how strongly the whole body leans toward free space
   */
  const SHAPE = {
    idle: { amp: 0.06, speed: 0.55, lobes: 3, pull: 0.1 },
    listening: { amp: 0.15, speed: 1.5, lobes: 4, pull: 0.16 },
    thinking: { amp: 0.1, speed: 2.4, lobes: 5, pull: 0.12 },
    speaking: { amp: 0.22, speed: 3.2, lobes: 2, pull: 0.14 },
    pointing: { amp: 0.08, speed: 1.1, lobes: 3, pull: 0.55 },
  };

  /** Slow size pulse. Speaking pulses hardest — that is the "voice" of it. */
  function breath(s) {
    const rate = state === "speaking" ? 6 : state === "listening" ? 2.6 : 1.1;
    const depth = state === "speaking" ? 0.09 : 0.045;
    return 1 + Math.sin(t * rate) * depth + s.amp * 0.15;
  }

  /**
   * One frame of the blob.
   *
   * A radial field with travelling sinusoidal lobes: for each cell, compare its
   * distance from the (leaning) centre against a radius that varies by angle
   * and time. Cells deep inside get the densest glyph, cells outside get
   * nothing, and the band between is the soft edge that makes it read as a blob
   * rather than a circle.
   */
  function frame() {
    const s = SHAPE[state] ?? SHAPE.idle;
    const cx = (FIELD_W - 1) / 2 + lean.x * s.pull * FIELD_W * 0.5;
    const cy = (FIELD_H - 1) / 2 + lean.y * s.pull * FIELD_H * 0.5;

    const base = FIELD_H * 0.44;

    let out = "";
    for (let y = 0; y < FIELD_H; y++) {
      for (let x = 0; x < FIELD_W; x++) {
        const dx = (x - cx) / ASPECT;
        const dy = y - cy;
        const dist = Math.hypot(dx, dy);
        const angle = Math.atan2(dy, dx);

        const wobble =
          Math.sin(angle * s.lobes + t * s.speed) * s.amp +
          Math.sin(angle * (s.lobes + 2) - t * s.speed * 0.7) * s.amp * 0.5;
        const radius = base * (1 + wobble) * breath(s);

        // 0 at the surface, 1 deep inside. Clamped so the ramp index is safe.
        const depth = Math.max(0, Math.min(1, (radius - dist) / (radius * 0.85)));
        out += depth <= 0 ? " " : RAMP[Math.min(RAMP.length - 1, Math.floor(depth * RAMP.length))];
      }
      out += "\n";
    }
    blob.textContent = out;
  }

  function loop(now) {
    raf = requestAnimationFrame(loop);
    const interval = 1000 / (state === "idle" ? FPS.idle : FPS.active);
    if (now - lastFrame < interval) return;
    // Advance by wall-clock so a throttled window drops frames rather than
    // playing the animation in slow motion.
    t += (now - lastFrame) / 1000;
    lastFrame = now;
    frame();
  }

  function start() {
    if (raf === null) {
      lastFrame = performance.now();
      raf = requestAnimationFrame(loop);
    }
  }

  function stop() {
    if (raf !== null) cancelAnimationFrame(raf);
    raf = null;
  }

  function setState(next) {
    state = SHAPE[next] ? next : "idle";
    root.dataset.state = state;
    frame();
  }

  /**
   * Reorient against the screen edges.
   *
   * `edges` names the sides the window is touching. The blob leans away from
   * them and the bubble opens toward whichever side has room, so a buddy parked
   * in the bottom-right corner does not try to speak off the display.
   */
  function setEdges(edges) {
    const near = new Set(Array.isArray(edges) ? edges : []);
    lean.x = (near.has("right") ? -1 : 0) + (near.has("left") ? 1 : 0);
    lean.y = (near.has("bottom") ? -1 : 0) + (near.has("top") ? 1 : 0);

    root.dataset.bubble = near.has("right") ? "left" : "right";
    root.dataset.vbubble = near.has("bottom") ? "above" : "below";
    root.dataset.edges = [...near].join(" ") || "none";
    frame();
  }

  function say(text, ttlMs) {
    // textContent, never innerHTML: this is model output quoting arbitrary
    // screen content.
    bubble.textContent = text;
    bubble.hidden = false;
    if (bubbleTimer !== null) clearTimeout(bubbleTimer);
    const ttl = typeof ttlMs === "number" ? ttlMs : Math.min(14000, 3000 + text.length * 45);
    bubbleTimer = setTimeout(() => {
      bubble.hidden = true;
    }, ttl);
  }

  const bridge = window.jarvisOverlay;

  /**
   * The ENTIRE window is the hit target, and it both drags and taps.
   *
   * The old buddy put its click handler on a 64px circle pinned to the bottom of
   * a 220px window, so clicking the obvious middle did nothing. Dragging then
   * needed a menu toggle, because -webkit-app-region eats the events a tap
   * needs. Tracking the pointer ourselves gives both: move past DRAG_SLOP and it
   * is a drag, release without moving and it is a tap.
   */
  const DRAG_SLOP = 4;
  let down = null;

  root.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || !bridge) return;
    down = { x: e.screenX, y: e.screenY, moved: false };
    bridge.dragStart({ screenX: e.screenX, screenY: e.screenY });
    root.classList.add("dragging");
  });

  function endDrag(wasTap) {
    if (!down || !bridge) return;
    const tap = wasTap && !down.moved;
    down = null;
    root.classList.remove("dragging");
    bridge.dragEnd();
    if (tap) bridge.tap();
  }

  window.addEventListener("mousemove", (e) => {
    if (!down || !bridge) return;
    // A missed mouseup would otherwise glue the buddy to the cursor forever —
    // observed once during testing, and unrecoverable without quitting the app.
    // buttons===0 means nothing is held, whatever we think we saw.
    if (e.buttons === 0) {
      endDrag(false);
      return;
    }
    if (!down.moved && Math.hypot(e.screenX - down.x, e.screenY - down.y) < DRAG_SLOP) return;
    down.moved = true;
    bridge.dragMove({ screenX: e.screenX, screenY: e.screenY });
  });

  window.addEventListener("mouseup", () => endDrag(true));
  window.addEventListener("blur", () => endDrag(false));

  if (bridge) {
    bridge.onCommand((message) => {
      switch (message.kind) {
        case "state":
          setState(message.state);
          break;
        case "say":
          say(message.text, message.ttlMs);
          break;
        case "edges":
          setEdges(message.edges);
          break;
        case "flight":
          setState("pointing");
          break;
        case "interactive":
          root.classList.toggle("interactive", message.interactive);
          break;
        case "visible":
          if (message.visible) start();
          else stop();
          break;
      }
    });
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else start();
  });

  // Fonts can resolve after first paint, so measure once the document is ready
  // and again after fonts settle.
  ASPECT = measureAspect();
  if (document.fonts && document.fonts.ready) {
    void document.fonts.ready.then(() => {
      ASPECT = measureAspect();
      frame();
    });
  }

  setState("idle");
  start();
})();
