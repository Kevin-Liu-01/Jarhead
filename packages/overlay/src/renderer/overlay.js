// The buddy. Plain JS on purpose: the renderer has no build step and no
// framework, so this file is exactly what ships.
//
// CPU discipline: idle/listening/speaking/pointing are compositor-run CSS
// animations (see overlay.css). The only JS timers are the thinking spinner
// (80ms interval, alive only while thinking) and the bubble TTL. Nothing
// polls, and no requestAnimationFrame loop runs when the buddy is idle.
"use strict";

(() => {
  // The wiki's loading-screens vocabulary: braille Unicode is the canonical
  // spinner, and "thinking" is its overlay incarnation.
  const BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const SPINNER_FRAME_MS = 80;
  const DEFAULT_BUBBLE_TTL_MS = 6000;
  // Keep in sync with APEX_SCALE in ../pointer.ts.
  const APEX_SCALE = 1.3;

  const buddy = document.getElementById("buddy");
  const core = document.getElementById("core");
  const glyph = document.getElementById("glyph");
  const bubble = document.getElementById("bubble");

  let spinner = null;
  let bubbleTimer = null;

  function startSpinner() {
    if (spinner !== null) return;
    let i = 0;
    glyph.textContent = BRAILLE[0];
    spinner = setInterval(() => {
      i = (i + 1) % BRAILLE.length;
      glyph.textContent = BRAILLE[i];
    }, SPINNER_FRAME_MS);
  }

  function stopSpinner() {
    if (spinner !== null) clearInterval(spinner);
    spinner = null;
    glyph.textContent = "";
  }

  function setState(state) {
    buddy.className = "state-" + state;
    if (state === "thinking") startSpinner();
    else stopSpinner();
  }

  function say(text, ttlMs) {
    // textContent, never innerHTML: bubble text is whatever the agent decided
    // to say, which can quote arbitrary screen content.
    bubble.textContent = text;
    bubble.hidden = false;
    if (bubbleTimer !== null) clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(
      () => {
        bubble.hidden = true;
      },
      typeof ttlMs === "number" ? ttlMs : DEFAULT_BUBBLE_TTL_MS,
    );
  }

  // The main process flies the window along the arc; the buddy pulses in
  // place. Same duration on both, so the pulse peaks with the arc's apex.
  // element.animate() is one-shot and compositor-run — no JS per frame.
  function flightPulse(durationMs) {
    core.animate(
      [
        { transform: "scale(1)" },
        { transform: "scale(" + APEX_SCALE + ")" },
        { transform: "scale(1)" },
      ],
      { duration: durationMs, easing: "ease-in-out" },
    );
  }

  window.jarvisOverlay.onCommand((message) => {
    switch (message.kind) {
      case "state":
        setState(message.state);
        break;
      case "say":
        say(message.text, message.ttlMs);
        break;
      case "flight":
        flightPulse(message.durationMs);
        break;
      case "interactive":
        document.body.classList.toggle("interactive", message.interactive);
        break;
    }
  });
})();
