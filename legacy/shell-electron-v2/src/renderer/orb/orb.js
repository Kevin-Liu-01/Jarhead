// Orb window controller: presence canvas + expanded capsule + context menu.

import { connect, createStore, lastBy, activeDelegation } from "../shared/bridge.js";
import { h, icon, dot, clear } from "../shared/dom.js";
import { icons } from "../shared/icons.js";
import { fmtDuration, fmtMinutes, truncate } from "../shared/format.js";
import { phaseMeta, SESSION_PHASES } from "../shared/phase.js";
import { OrbRenderer } from "./ring.js";

const COLLAPSED = { w: 96, h: 96 };
const EXPANDED = { w: 340, h: 220 };
const DRAG_THRESHOLD = 4;

const bridge = await connect("orb");
const store = createStore(bridge);

const root = document.getElementById("root");
const canvas = document.getElementById("orb");
const badge = document.getElementById("badge");
const panel = document.getElementById("panel");
const menu = document.getElementById("menu");
const toastHost = document.getElementById("toast");

const orb = new OrbRenderer(canvas, { size: 96 });

const ui = {
  expanded: new URLSearchParams(location.search).get("expanded") === "1",
  menuOpen: false,
  toastOpen: false,
  timer: null,
};

// ------------------------------------------------------------ window size ---

let lastSize = "";
function syncWindowSize() {
  const big = ui.expanded || ui.menuOpen || ui.toastOpen;
  root.classList.toggle("expanded", ui.expanded);
  root.classList.toggle("menu-open", ui.menuOpen);
  root.classList.toggle("toast-open", ui.toastOpen);
  const size = big ? EXPANDED : COLLAPSED;
  const key = `${size.w}x${size.h}`;
  if (key !== lastSize) {
    lastSize = key;
    bridge.orbResize(size.w, size.h);
  }
}

function setExpanded(next) {
  if (ui.expanded === next) return;
  ui.expanded = next;
  panel.hidden = !next;
  syncWindowSize();
  if (next) {
    renderPanel(store.snapshot);
    startTimer();
  } else stopTimer();
  canvas.setAttribute("aria-expanded", String(next));
}

function startTimer() {
  stopTimer();
  ui.timer = setInterval(() => renderMeta(store.snapshot), 1000);
}

function stopTimer() {
  if (ui.timer) clearInterval(ui.timer);
  ui.timer = null;
}

// -------------------------------------------------------------- rendering ---

let metaNode = null;

store.onSnapshot((snap) => {
  orb.setPhase(snap.phase);
  root.style.setProperty("--accent", phaseMeta(snap.phase).token);
  badge.hidden = !(snap.problems.length > 0 && !ui.expanded);
  canvas.setAttribute("aria-label", `Jarhead — ${phaseMeta(snap.phase).label}`);
  if (ui.expanded) renderPanel(snap);
  if (ui.menuOpen) renderMenu(snap);
});

store.onLevels((levels) => orb.setLevels(levels));

document.addEventListener("visibilitychange", () => orb.setVisible(document.visibilityState === "visible"));
window.addEventListener("resize", () => orb.resize());
matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener?.("change", () => orb.resize());

function renderPanel(snap) {
  if (!snap) return;
  const meta = phaseMeta(snap.phase);
  const kevin = lastBy(snap.transcript, "kevin");
  const jar = lastBy(snap.transcript, "jarhead");
  const deleg = activeDelegation(snap.delegations);
  const muted = snap.phase === "muted";

  metaNode = h("div", { class: "meta" });

  const head = h(
    "div",
    { class: "head" },
    h("div", { class: "phase" }, dot(meta.token, snap.phase !== "asleep" && snap.phase !== "muted"), meta.label),
    h(
      "div",
      { class: "actions" },
      h(
        "button",
        {
          class: `btn ghost icon-only${muted ? " on" : ""}`,
          title: muted ? "Unmute" : "Mute",
          "aria-label": muted ? "Unmute" : "Mute",
          onclick: () => store.send({ type: muted ? "unmute" : "mute" }),
        },
        icon(muted ? icons.micOff : icons.mic),
      ),
      h(
        "button",
        { class: "btn ghost icon-only", title: "Stop", "aria-label": "Stop", onclick: () => store.send({ type: "stop" }) },
        icon(icons.stop),
      ),
      h(
        "button",
        {
          class: "btn ghost icon-only",
          title: "Open console",
          "aria-label": "Open console",
          onclick: () => store.send({ type: "open-console" }),
        },
        icon(icons.console),
      ),
    ),
    metaNode,
    snap.problems.length
      ? h("div", { class: "problem", title: snap.problems[0] }, icon(icons.alert), h("span", null, snap.problems[0]))
      : null,
  );

  const body = h("div", { class: "body" });
  if (!snap.session && snap.transcript.length === 0) {
    body.append(
      h("div", { class: "line" }, h("span", { class: "who" }, "You"), h("span", { class: "what empty-text" }, "Nothing heard yet")),
      h("div", { class: "line jarhead" }, h("span", { class: "who" }, "Jarhead"), h("span", { class: "what empty-text" }, "Asleep — click Wake to start a session")),
      h("div", { class: "hint" }, meta.hint),
    );
  } else {
    const twoLines = !deleg;
    body.append(
      line("You", kevin, "kevin", twoLines),
      line("Jarhead", jar, "jarhead", twoLines),
      deleg ? delegStrip(deleg) : h("div", { class: "hint" }, meta.hint),
    );
  }

  clear(panel).append(head, body);
  renderMeta(snap);
}

function line(who, item, cls, two) {
  const streaming = item && !item.final;
  return h(
    "div",
    { class: `line ${cls}${two ? " two" : ""}` },
    h("span", { class: "who" }, who),
    h(
      "span",
      { class: `what${item ? "" : " empty-text"}${streaming ? " streaming" : ""}`, title: item?.text ?? "" },
      item ? item.text : cls === "kevin" ? "Nothing heard yet" : "Nothing said yet",
    ),
  );
}

function delegStrip(d) {
  const last = d.steps[d.steps.length - 1];
  const waiting = d.status === "awaiting-confirmation";
  const tone = waiting ? "var(--phase-speaking)" : "var(--phase-thinking)";
  const label = waiting ? "Waiting for you" : "Running";
  const text = last?.text ?? last?.tool?.name ?? truncate(d.request, 60);
  return h(
    "div",
    { class: "deleg", title: d.request },
    dot(tone, true),
    h("span", { class: "text" }, h("b", null, `${label} · `), text),
    h("span", { class: "count" }, `${d.steps.length}`),
  );
}

function renderMeta(snap) {
  if (!metaNode || !snap) return;
  const s = snap.session;
  if (!s) {
    metaNode.replaceChildren("no session", h("span", { class: "sep" }, "·"), "not billing");
    return;
  }
  const elapsed = Math.max(0, (Date.now() - s.startedAt) / 1000);
  metaNode.replaceChildren(fmtDuration(elapsed), h("span", { class: "sep" }, "·"), `${fmtMinutes(s.usageSeconds)} billed`);
  metaNode.title = s.contextRatio != null ? `Session ${s.id} · context ${Math.round(s.contextRatio * 100)}%` : `Session ${s.id}`;
}

// ---------------------------------------------------------- interaction ---

let press = null;
canvas.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  press = { x: e.screenX, y: e.screenY, dragging: false };
  e.preventDefault();
});

window.addEventListener("mousemove", (e) => {
  if (!press) return;
  if (!press.dragging) {
    const dx = e.screenX - press.x;
    const dy = e.screenY - press.y;
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    press.dragging = true;
    bridge.orbDrag("start", press.x, press.y);
  }
  bridge.orbDrag("move", e.screenX, e.screenY);
});

window.addEventListener("mouseup", (e) => {
  if (!press) return;
  const was = press;
  press = null;
  if (was.dragging) {
    bridge.orbDrag("end", e.screenX, e.screenY);
    return;
  }
  if (e.button === 0 && e.target === canvas) {
    closeMenu();
    setExpanded(!ui.expanded);
  }
});

canvas.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    setExpanded(!ui.expanded);
  }
});

window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (ui.menuOpen) closeMenu();
  else if (ui.expanded) setExpanded(false);
});

canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  openMenu();
});

window.addEventListener("blur", () => closeMenu());
window.addEventListener("mousedown", (e) => {
  if (ui.menuOpen && !menu.contains(e.target) && e.target !== canvas) closeMenu();
});

function openMenu() {
  ui.menuOpen = true;
  menu.hidden = false;
  renderMenu(store.snapshot);
  syncWindowSize();
  menu.querySelector("button")?.focus();
}

function closeMenu() {
  if (!ui.menuOpen) return;
  ui.menuOpen = false;
  menu.hidden = true;
  syncWindowSize();
}

function renderMenu(snap) {
  const phase = snap?.phase ?? "asleep";
  const inSession = SESSION_PHASES.has(phase);
  const muted = phase === "muted";
  const item = (label, svg, command) =>
    h(
      "button",
      {
        role: "menuitem",
        onclick: () => {
          store.send(command);
          closeMenu();
        },
      },
      icon(svg),
      label,
    );
  clear(menu).append(
    inSession ? item("Sleep", icons.moon, { type: "sleep" }) : item("Wake", icons.bolt, { type: "wake" }),
    muted ? item("Unmute", icons.mic, { type: "unmute" }) : item("Mute", icons.micOff, { type: "mute" }),
    item("Stop", icons.stop, { type: "stop" }),
    h("div", { class: "hair" }),
    item("Open Console", icons.console, { type: "open-console" }),
  );
  menu.addEventListener("keydown", menuKeys);
}

function menuKeys(e) {
  const items = [...menu.querySelectorAll("button")];
  const i = items.indexOf(document.activeElement);
  if (e.key === "ArrowDown") items[(i + 1) % items.length]?.focus();
  else if (e.key === "ArrowUp") items[(i - 1 + items.length) % items.length]?.focus();
  else return;
  e.preventDefault();
}

// ------------------------------------------------------------------ toast ---

let toastTimer = null;
store.onToast((text, tone) => {
  const node = h("div", { class: `toast ${tone}` }, text);
  clear(toastHost).append(node);
  toastHost.hidden = false;
  ui.toastOpen = true;
  syncWindowSize();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.classList.add("out");
    setTimeout(() => {
      toastHost.hidden = true;
      ui.toastOpen = false;
      syncWindowSize();
    }, 240);
  }, 2600);
});

// ------------------------------------------------------------------ boot ---

panel.hidden = !ui.expanded;
syncWindowSize();
if (ui.expanded) {
  renderPanel(store.snapshot);
  startTimer();
}
