// Console window: wires the bridge to the three regions.

import { connect, createStore } from "../shared/bridge.js";
import { h, icon, clear, makeToaster } from "../shared/dom.js";
import { icons } from "../shared/icons.js";
import { fmtDay } from "../shared/format.js";
import { phaseMeta, BUSY_PHASES, SESSION_PHASES } from "../shared/phase.js";
import { createStream, entriesFromSnapshot, entriesFromLedger } from "./stream.js";
import { createAgentsRail } from "./agents.js";
import { createRightRail } from "./rail.js";

const bridge = await connect("console");
const store = createStore(bridge);
const toast = makeToaster(document.body);
const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------- lightbox
const lightbox = $("#lightbox");
const lightboxImg = lightbox.querySelector("img");
const lightboxCap = lightbox.querySelector(".caption");
function openLightbox(src, caption) {
  lightboxImg.src = src;
  lightboxImg.alt = caption;
  lightboxCap.textContent = caption;
  lightbox.showModal();
}
lightbox.addEventListener("click", () => lightbox.close());

// ------------------------------------------------------------------ stream
const feed = $("#feed");
const banner = $("#stream-banner");
const stream = createStream({ feed, jump: $("#jump"), screenshotUrl: (p) => bridge.screenshotUrl(p), openLightbox });

let mode = { kind: "live" }; // | { kind: "ledger", day, rows }

function renderStream(snap) {
  if (mode.kind === "ledger") {
    stream.render(entriesFromLedger(mode.rows), { kind: "ledger-empty", title: "Nothing recorded", body: `The ledger for ${fmtDay(mode.day)} is empty.` });
    return;
  }
  const entries = entriesFromSnapshot(snap);
  const empty = !snap.session
    ? {
        kind: "asleep",
        title: "Jarhead is asleep",
        body: "No live session, nothing billed. Wake to start listening.",
        action: h("button", { class: "btn primary", type: "button", onclick: () => store.send({ type: "wake" }) }, icon(icons.bolt), "Wake"),
      }
    : { kind: "quiet", title: "Nothing heard yet", body: "Say something. Kevin appears on the left, Jarhead on the right." };
  stream.render(entries, empty);
}

function showLedger(day, rows) {
  mode = { kind: "ledger", day, rows };
  stream.reset();
  clear(banner).append(
    icon(icons.ledger),
    h("span", null, "Viewing ", h("b", null, fmtDay(day)), h("span", { class: "mono", style: "color:var(--fg-3);margin-left:6px" }, day)),
    h("button", { class: "btn ghost", type: "button", onclick: showLive }, "Back to live"),
  );
  banner.hidden = false;
  if (store.snapshot) renderStream(store.snapshot);
}

function showLive() {
  if (mode.kind === "live") return;
  mode = { kind: "live" };
  banner.hidden = true;
  stream.reset();
  if (rail.active === "ledger") rail.select("now");
  if (store.snapshot) renderStream(store.snapshot);
}

// ------------------------------------------------------------------- rails
const agents = createAgentsRail({ root: $("#agents"), refreshButton: $("#agents-refresh"), send: (c) => store.send(c) });

const rail = createRightRail({
  panels: { now: $("#tab-now"), settings: $("#tab-settings"), ledger: $("#tab-ledger") },
  tabs: [...document.querySelectorAll(".tab")],
  send: (c) => store.send(c),
  bridge,
  onLedgerPick: showLedger,
});
rail.onSelect((name) => {
  if (name !== "ledger" && mode.kind === "ledger") showLive();
});

// ------------------------------------------------------------------ header
const phasePill = $("#phase-pill");
$("#open-ledger").prepend(icon(icons.ledger));
$("#open-ledger").addEventListener("click", () => store.send({ type: "open-ledger" }));

function renderHeader(snap) {
  const meta = phaseMeta(snap.phase);
  document.documentElement.style.setProperty("--accent", meta.token);
  phasePill.querySelector(".label").textContent = meta.label;
  phasePill.title = meta.hint;
  document.title = `Jarhead — ${meta.label}`;
}

// ---------------------------------------------------------------- composer
const composer = $("#composer");
const say = $("#say");
const wakeToggle = $("#wake-toggle");
const muteToggle = $("#mute-toggle");
const stopBtn = $("#stop");
stopBtn.prepend(icon(icons.stop));

composer.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = say.value.trim();
  if (!text) return;
  store.send({ type: "say-text", text });
  say.value = "";
  autosize();
});
say.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    composer.requestSubmit();
  } else if (e.key === "Escape") say.blur();
});
say.addEventListener("input", autosize);
function autosize() {
  say.style.height = "auto";
  say.style.height = `${Math.min(140, say.scrollHeight)}px`;
}
stopBtn.addEventListener("click", () => store.send({ type: "stop" }));

let composerPhase = null;
function renderComposer(snap) {
  if (snap.phase === composerPhase) return;
  composerPhase = snap.phase;
  const inSession = SESSION_PHASES.has(snap.phase);
  const muted = snap.phase === "muted";
  clear(wakeToggle).append(icon(inSession ? icons.moon : icons.bolt));
  wakeToggle.title = inSession ? "Sleep (close the live session)" : "Wake (open a live session)";
  wakeToggle.setAttribute("aria-label", wakeToggle.title);
  wakeToggle.classList.toggle("on", !inSession && snap.phase !== "error");
  wakeToggle.onclick = () => store.send({ type: inSession ? "sleep" : "wake" });

  clear(muteToggle).append(icon(muted ? icons.micOff : icons.mic));
  muteToggle.title = muted ? "Unmute" : "Mute";
  muteToggle.setAttribute("aria-label", muteToggle.title);
  muteToggle.classList.toggle("on", muted);
  muteToggle.style.setProperty("--accent", "var(--phase-muted)");
  muteToggle.disabled = !inSession;
  muteToggle.onclick = () => store.send({ type: muted ? "unmute" : "mute" });

  stopBtn.classList.toggle("solid", BUSY_PHASES.has(snap.phase));
  say.placeholder = inSession ? "Say something to Jarhead… (Enter to send)" : "Wake Jarhead to talk, or type here to send text";
}

// ------------------------------------------------------------------- boot
store.onSnapshot((snap) => {
  renderHeader(snap);
  renderComposer(snap);
  renderStream(snap);
  agents.render(snap);
  rail.render(snap);
});
store.onLevels((levels) => rail.levels(levels));
store.onToast((text, tone) => toast(text, tone));

setInterval(() => {
  stream.tick();
  rail.tick();
}, 1000);
setInterval(() => agents.tick(), 10_000);

// Dev aid for previews: ?tab=settings | ?tab=ledger&day=first
const params = new URLSearchParams(location.search);
if (params.get("tab") === "ledger" && params.get("day") === "first") rail.pickNewestDay();
else if (params.get("tab")) rail.select(params.get("tab"));

window.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "k") {
    e.preventDefault();
    say.focus();
  }
  if ((e.metaKey || e.ctrlKey) && e.key === ".") {
    e.preventDefault();
    store.send({ type: "stop" });
  }
});
