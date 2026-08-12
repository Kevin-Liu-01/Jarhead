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

  // 8fps was fine for a CSS circle but makes a Brownian outline look like it is
  // stuttering rather than drifting. The walk needs enough samples to read as
  // continuous motion; the window still stops entirely when hidden.
  const FPS = { idle: 18, active: 26 };

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
   * Contacts, each spring-damped toward the value the main process reports.
   *
   * Springs rather than direct assignment for one reason: pulling away from an
   * edge should overshoot and wobble back, not snap. That overshoot is most of
   * what makes the thing read as alive rather than as a resizing rectangle.
   */
  const CONTACT_SLOTS = 2;
  const STIFFNESS = 165;
  const DAMPING = 15;

  const contacts = [];
  for (let i = 0; i < CONTACT_SLOTS; i++) {
    contacts.push({ nx: 0, ny: 0, press: 0, target: 0, vel: 0 });
  }

  function setContacts(list) {
    const incoming = Array.isArray(list) ? list : [];
    for (let i = 0; i < CONTACT_SLOTS; i++) {
      const c = contacts[i];
      const next = incoming[i];
      if (next) {
        // Adopt the new normal immediately; only the magnitude is sprung, so a
        // contact that jumps to another wall does not swing through the middle.
        c.nx = next.nx;
        c.ny = next.ny;
        c.target = next.press;
      } else {
        c.target = 0;
      }
    }
  }

  function stepSprings(dt) {
    // Clamped because a long frame gap (window hidden, machine asleep) would
    // otherwise integrate into a violent snap on the next visible frame.
    const step = Math.min(dt, 1 / 30);
    let moving = false;
    for (const c of contacts) {
      const accel = (c.target - c.press) * STIFFNESS - c.vel * DAMPING;
      c.vel += accel * step;
      c.press += c.vel * step;
      if (Math.abs(c.vel) > 0.002 || Math.abs(c.target - c.press) > 0.002) moving = true;
    }
    return moving;
  }

  /**
   * Per-state character of the motion.
   *
   * amp   how far the surface wanders from a circle
   * speed how fast the wandering evolves
   * churn how violently the harmonics get re-randomised
   * pull  how strongly the whole body leans toward free space
   */
  const SHAPE = {
    idle: { amp: 0.3, speed: 0.5, churn: 0.55, pull: 0.1 },
    listening: { amp: 0.42, speed: 1.5, churn: 1.5, pull: 0.16 },
    thinking: { amp: 0.36, speed: 2.3, churn: 2.6, pull: 0.12 },
    speaking: { amp: 0.5, speed: 3.0, churn: 3.2, pull: 0.14 },
    pointing: { amp: 0.24, speed: 1.0, churn: 0.8, pull: 0.55 },
  };

  /**
   * Live shape parameters, eased toward the active state's values.
   *
   * Snapping these on a state change made the silhouette pop, which read as a
   * glitch rather than a mood shift. Easing them means "thinking" grows into
   * "speaking" over a few frames, and the colour transition in CSS lands on the
   * same beat.
   */
  const cur = { ...SHAPE.idle };
  const EASE_TAU = 0.28;

  /**
   * Extra churn injected on a state change, decaying away.
   *
   * Easing alone made transitions correct but limp — the shape arrived at its new
   * mood without ever reacting. A short burst of agitation reads as the creature
   * noticing something, then settling into the new state.
   */
  let shiver = 0;
  const SHIVER_TAU = 0.45;

  function easeParams(dt) {
    const target = SHAPE[state] ?? SHAPE.idle;
    // Exponential approach: frame-rate independent, and never overshoots into a
    // shape the state does not have.
    const k = 1 - Math.exp(-dt / EASE_TAU);
    for (const key of Object.keys(cur)) {
      cur[key] += (target[key] - cur[key]) * k;
    }
    shiver *= Math.exp(-dt / SHIVER_TAU);
    cur.churn += shiver;
  }

  /**
   * The silhouette is a sum of harmonics whose amplitudes and phases wander.
   *
   * Fixed sine lobes gave a shape that was too regular — it read as a rounded
   * rectangle or a gear, not a creature. Each harmonic here does its own random
   * walk (Ornstein-Uhlenbeck: nudged by noise, pulled back toward zero) so the
   * outline is genuinely Brownian and never repeats, while staying bounded
   * instead of drifting into spikes.
   */
  const HARMONICS = [1, 2, 3, 4, 5, 7].map((k) => ({
    k,
    // Higher harmonics get less room, or the surface turns to static.
    weight: 1 / (k * 0.85),
    amp: 0,
    phase: Math.random() * Math.PI * 2,
    // Irrational-ish drifts so the harmonics never re-align into a pattern.
    drift: (0.17 + k * 0.113) * (k % 2 === 0 ? -1 : 1),
  }));

  const OU_PULL = 1.7;
  /**
   * Noise scale, chosen from the stationary spread it produces.
   *
   * For an Ornstein-Uhlenbeck walk the resting deviation is SIGMA/sqrt(2*PULL),
   * so this lands each harmonic around ±0.5 of its weight. The first version
   * applied noise as `noise * dt`, which is not dt-invariant AND shrank the walk
   * by a factor of ~20 — the outline came out almost perfectly round, which was
   * the whole complaint.
   */
  const SIGMA = 1.3;

  /** Standard normal via Box-Muller: uniform noise gave a flat, buzzy wobble. */
  function gauss() {
    let u = 0;
    let v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function stepHarmonics(dt) {
    const step = Math.min(dt, 1 / 15);
    const root = Math.sqrt(step);
    for (const h of HARMONICS) {
      // Correct OU: drift scales with dt, noise with sqrt(dt), so the walk looks
      // the same whether it is running at 18fps or 60.
      const sigma = SIGMA * cur.churn * h.weight;
      h.amp += -OU_PULL * h.amp * step + sigma * root * gauss();

      // Bound it: an unbounded walk eventually inverts the radius and the blob
      // turns inside out.
      const cap = h.weight * 1.15;
      if (h.amp > cap) h.amp = cap;
      if (h.amp < -cap) h.amp = -cap;

      // Phases wander too, so the lobes never settle into a fixed rosette.
      h.phase += (h.drift * cur.speed + gauss() * 0.12) * step;
    }
  }

  // Sum of the weights: divides the harmonic sum so `amp` is a real bound on
  // deviation rather than something that grows with harmonic count.
  const WEIGHT_SUM = HARMONICS.reduce((n, h) => n + h.weight, 0);

  /**
   * Radius multiplier at a given angle: the Brownian outline.
   *
   * Floored well above zero because a harmonic sum that reaches -1 would fold
   * the surface through the centre, which looks like corruption rather than a
   * creature.
   */
  function outline(angle) {
    let sum = 0;
    for (const h of HARMONICS) sum += h.amp * Math.sin(h.k * angle + h.phase);
    return Math.max(0.35, 1 + (sum / WEIGHT_SUM) * cur.amp * 2.6);
  }

  /**
   * Slow size pulse, layered under the Brownian outline.
   *
   * Driven by the eased speed rather than the raw state, so the breathing rate
   * changes gradually with everything else instead of jumping.
   */
  function breath() {
    const rate = 1.1 + cur.speed * 1.6;
    const depth = 0.03 + cur.speed * 0.016;
    return 1 + Math.sin(t * rate) * depth;
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
  /**
   * Squash a point against the active contacts.
   *
   * Per contact: compress along the wall normal and spread perpendicular, which
   * is the squash-and-stretch that keeps the blob looking like it has a fixed
   * volume rather than just getting smaller. Then the wall itself hard-clips
   * anything past it, which is what produces the flat pressed face — without the
   * clip you get a small oval, not a creature splatted on glass.
   *
   * Returns the deformed offset plus whether this cell fell outside a wall.
   */
  function squash(dx, dy, base) {
    let ox = dx;
    let oy = dy;
    let clipped = false;

    // A corner applies two contacts, and multiplying both squashes collapsed the
    // blob into a one-pixel line — technically correct, visually dead. Splitting
    // the budget keeps a corner squish dramatic while still leaving a creature.
    const active = contacts.filter((c) => c.press > 0.01);
    const share = active.length > 1 ? 0.68 : 1;

    for (const c of active) {
      const press = c.press * share;
      const along = ox * c.nx + oy * c.ny;
      const perpX = ox - c.nx * along;
      const perpY = oy - c.ny * along;

      // Wall sits this far from centre along -n. As press rises it comes in,
      // so more of the body is cut away and has to go somewhere.
      const wall = base * (1 - Math.min(0.66, press * 0.6));
      if (along < -wall) clipped = true;

      const compress = 1 / (1 - Math.min(0.55, press * 0.47));
      const spread = 1 / (1 + Math.min(0.8, press * 0.66));

      ox = c.nx * along * compress + perpX * spread;
      oy = c.ny * along * compress + perpY * spread;
    }

    return { ox, oy, clipped };
  }

  /** Net push direction, used to lean the body and aim the eyes. */
  function contactBias() {
    let bx = 0;
    let by = 0;
    let total = 0;
    for (const c of contacts) {
      if (c.press <= 0.01) continue;
      bx += c.nx * c.press;
      by += c.ny * c.press;
      total += c.press;
    }
    return { bx, by, total };
  }

  function frame() {
    const bias = contactBias();

    // Pressed blobs slide their mass away from the wall, not just deform in place.
    const cx = (FIELD_W - 1) / 2 + (lean.x * cur.pull + bias.bx * 0.9) * FIELD_W * 0.16;
    const cy = (FIELD_H - 1) / 2 + (lean.y * cur.pull + bias.by * 0.9) * FIELD_H * 0.16;

    const base = FIELD_H * 0.42 * breath();
    const grid = [];

    for (let y = 0; y < FIELD_H; y++) {
      let row = "";
      for (let x = 0; x < FIELD_W; x++) {
        const { ox, oy, clipped } = squash((x - cx) / ASPECT, y - cy, base);
        if (clipped) {
          row += " ";
          continue;
        }

        const dist = Math.hypot(ox, oy);
        const radius = base * outline(Math.atan2(oy, ox));

        // 0 at the surface, 1 deep inside. Clamped so the ramp index is safe.
        const depth = Math.max(0, Math.min(1, (radius - dist) / (radius * 0.8)));
        row += depth <= 0 ? " " : RAMP[Math.min(RAMP.length - 1, Math.floor(depth * RAMP.length))];
      }
      grid.push(row.split(""));
    }

    drawEyes(grid, cx, cy, base, bias);
    blob.textContent = grid.map((r) => r.join("")).join("\n");
  }

  /**
   * Two eyes, because a blob with eyes is a creature and a blob without is a
   * loading indicator. They look toward open space (away from whatever it is
   * pressed against) and squint as the squish deepens.
   */
  function drawEyes(grid, cx, cy, base, bias) {
    const squishing = Math.min(1, bias.total);
    const glyph = squishing > 0.55 ? "-" : state === "listening" ? "O" : state === "thinking" ? "o" : "•";

    // Look away from the wall; default slightly up, which reads as friendly.
    const lookX = bias.total > 0.05 ? bias.bx / Math.max(1, bias.total) : 0;
    const lookY = bias.total > 0.05 ? bias.by / Math.max(1, bias.total) : -0.35;

    const eyeY = Math.round(cy + lookY * 1.6 - 0.6);
    const spread = Math.max(1, Math.round(base * (0.62 + squishing * 0.55) * ASPECT * 0.5));
    const centreX = Math.round(cx + lookX * 2.2);

    for (const dx of [-spread, spread]) {
      const gx = centreX + dx;
      const row = grid[eyeY];
      if (!row) continue;
      // Only draw an eye where there is body to draw it on, so eyes never float
      // outside a squashed silhouette.
      if (gx < 0 || gx >= FIELD_W || row[gx] === " ") continue;
      row[gx] = glyph;
    }
  }

  function loop(now) {
    raf = requestAnimationFrame(loop);
    // Springs need a high, steady rate to look elastic, so contact wobble
    // overrides the idle throttle while it is still settling.
    const settling = contacts.some((c) => c.press > 0.01 || c.target > 0.01);
    const interval = 1000 / (state === "idle" && !settling ? FPS.idle : FPS.active);
    if (now - lastFrame < interval) return;

    const dt = (now - lastFrame) / 1000;
    lastFrame = now;
    // Advance by wall-clock so a throttled window drops frames rather than
    // playing the animation in slow motion.
    t += dt;
    easeParams(dt);
    stepHarmonics(dt);
    stepSprings(dt);
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
    // A state change is a nudge, not a cut: kick the harmonics and raise the
    // agitation, both of which decay, so the transition has energy behind it.
    for (const h of HARMONICS) h.amp += gauss() * 0.3 * h.weight;
    shiver = 2.6;
    start();
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
        case "contacts":
          setContacts(message.contacts);
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
