// Right rail: Now / Settings / Ledger tabs.

import { h, icon, chip, clear } from "../shared/dom.js";
import { icons } from "../shared/icons.js";
import { fmtDuration, fmtMinutes, fmtDay, fmtRelative, shortId } from "../shared/format.js";
import { phaseMeta, GRANT_META, VOICES, BRAINS, EFFORTS } from "../shared/phase.js";

export function createRightRail({ panels, tabs, send, bridge, onLedgerPick }) {
  let snapshot = null;
  let active = "now";

  // ------------------------------------------------------------------ tabs
  for (const tab of tabs) {
    tab.addEventListener("click", () => select(tab.dataset.tab));
    tab.addEventListener("keydown", (e) => {
      const i = tabs.indexOf(tab);
      if (e.key === "ArrowRight") tabs[(i + 1) % tabs.length].focus();
      else if (e.key === "ArrowLeft") tabs[(i - 1 + tabs.length) % tabs.length].focus();
      else return;
      e.preventDefault();
      document.activeElement.click();
    });
  }

  const listeners = new Set();
  function select(name) {
    active = name;
    for (const tab of tabs) tab.setAttribute("aria-selected", String(tab.dataset.tab === name));
    for (const [key, panel] of Object.entries(panels)) panel.hidden = key !== name;
    if (name === "ledger") loadLedgerDays();
    for (const fn of listeners) fn(name);
  }

  // ------------------------------------------------------------------- now
  const nowRefs = { meters: null, timer: null };
  let nowSig = "";

  function renderNow(snap) {
    const sig = JSON.stringify([snap.phase, snap.session?.id, snap.session?.usageSeconds, snap.session?.contextRatio, snap.permissions, snap.problems, snap.brainReady, snap.handsReady]);
    if (sig === nowSig) return;
    nowSig = sig;
    const meta = phaseMeta(snap.phase);
    const s = snap.session;

    const inFill = h("div", { class: "fill", style: { "--fill": "var(--phase-listening)" } });
    const outFill = h("div", { class: "fill", style: { "--fill": "var(--phase-speaking)" } });
    const inVal = h("span", { class: "v" }, "0");
    const outVal = h("span", { class: "v" }, "0");
    nowRefs.meters = { inFill, outFill, inVal, outVal };
    nowRefs.timer = h("span", { class: "v mono" }, s ? fmtDuration((Date.now() - s.startedAt) / 1000) : "—");

    clear(panels.now).append(
      h(
        "section",
        { class: "sec" },
        h("div", { class: "now-phase" }, h("span", { class: "orb-dot" }), h("div", null, h("div", { class: "big" }, meta.label), h("div", { class: "hint" }, meta.hint))),
        s
          ? h(
              "div",
              { class: "kv" },
              h("span", { class: "k" }, "Session"),
              h("span", { class: "v mono", title: s.id }, shortId(s.id, 12)),
              h("span", { class: "k" }, "Elapsed"),
              nowRefs.timer,
              h("span", { class: "k" }, "Billed"),
              h("span", { class: "v mono" }, `${fmtMinutes(s.usageSeconds)} · ${fmtDuration(s.usageSeconds)}`),
              h("span", { class: "k" }, "Expires"),
              h("span", { class: "v mono" }, `in ${fmtDuration(Math.max(0, (s.expiresAt - Date.now()) / 1000))}`),
              ...(s.contextRatio != null
                ? [
                    h("span", { class: "k" }, "Context"),
                    h(
                      "span",
                      { class: "v", style: "display:flex;align-items:center;gap:8px" },
                      h("span", { class: "bar", style: "flex:1" }, h("span", { class: "fill", style: { width: `${Math.round(s.contextRatio * 100)}%`, "--fill": "var(--phase-thinking)" } })),
                      h("span", { class: "mono", style: "color:var(--fg-3);font-size:11px" }, `${Math.round(s.contextRatio * 100)}%`),
                    ),
                  ]
                : []),
            )
          : h("div", { class: "empty", style: "padding:4px 0 2px;place-items:start;text-align:left" }, h("button", { class: "btn primary", type: "button", onclick: () => send({ type: "wake" }) }, icon(icons.bolt), "Wake")),
      ),
      h(
        "section",
        { class: "sec" },
        h("div", { class: "sec-head" }, h("h3", { class: "eyebrow" }, "Audio")),
        h(
          "div",
          { class: "meters" },
          h("span", { class: "k" }, "In"),
          h("span", { class: "bar" }, inFill),
          inVal,
          h("span", { class: "k" }, "Out"),
          h("span", { class: "bar" }, outFill),
          outVal,
        ),
      ),
      h(
        "section",
        { class: "sec" },
        h("div", { class: "sec-head" }, h("h3", { class: "eyebrow" }, "Readiness")),
        h(
          "div",
          { class: "ready" },
          readyRow(icons.brain, "Brain", snap.brainReady, snap.settings.brain),
          readyRow(icons.hand, "Hands", snap.handsReady, snap.handsReady ? "see + click" : "needs permissions"),
        ),
      ),
      h(
        "section",
        { class: "sec" },
        h("div", { class: "sec-head" }, h("h3", { class: "eyebrow" }, "Permissions")),
        h("div", { class: "ready" }, permRow("microphone", "Microphone", snap.permissions.microphone, icons.mic), permRow("screenRecording", "Screen recording", snap.permissions.screenRecording, icons.eye), permRow("accessibility", "Accessibility", snap.permissions.accessibility, icons.cursor)),
      ),
      h(
        "section",
        { class: "sec" },
        h(
          "div",
          { class: "sec-head" },
          h("h3", { class: "eyebrow" }, `Problems${snap.problems.length ? ` · ${snap.problems.length}` : ""}`),
          snap.problems.length ? h("button", { class: "btn ghost", type: "button", onclick: () => send({ type: "clear-problems" }) }, "Clear") : null,
        ),
        snap.problems.length
          ? h("div", { class: "problems" }, ...snap.problems.slice().reverse().map((p) => h("div", { class: "problem-row" }, icon(icons.alert, "sm"), h("span", null, p))))
          : h("div", { class: "empty", style: "padding:4px 0 6px;place-items:start" }, h("span", null, "No problems.")),
      ),
    );
  }

  function readyRow(svg, name, ok, detail) {
    return h("div", { class: "row" }, icon(svg), h("span", { class: "name" }, name, " ", h("span", { style: "color:var(--fg-3);font-size:11px" }, detail)), chip(ok ? "ready" : "not ready", ok ? "var(--phase-acting)" : "var(--phase-speaking)"));
  }

  function permRow(which, name, grant, svg) {
    const meta = GRANT_META[grant] ?? GRANT_META.unknown;
    return h(
      "div",
      { class: "perm" },
      icon(svg),
      h("span", { class: "name" }, name),
      grant === "denied" ? h("button", { class: "btn", type: "button", onclick: () => send({ type: "request-permission", which }) }, "Request") : null,
      chip(meta.label, meta.token),
    );
  }

  function levels({ input, output }) {
    const m = nowRefs.meters;
    if (!m) return;
    m.inFill.style.width = `${Math.round(Math.min(1, input) * 100)}%`;
    m.outFill.style.width = `${Math.round(Math.min(1, output) * 100)}%`;
    m.inVal.textContent = input.toFixed(2);
    m.outVal.textContent = output.toFixed(2);
  }

  function tick() {
    const s = snapshot?.session;
    if (s && nowRefs.timer) nowRefs.timer.textContent = fmtDuration((Date.now() - s.startedAt) / 1000);
  }

  // -------------------------------------------------------------- settings
  const controls = {};
  let settingsBuilt = false;

  function buildSettings() {
    settingsBuilt = true;
    const patch = (p) => send({ type: "set-settings", patch: p });
    const sel = (key, options, labelFn = (v) => v) => {
      const el = h("select", { class: "field", id: `set-${key}`, onchange: () => patch({ [key]: el.value }) }, ...options.map((v) => h("option", { value: v }, labelFn(v))));
      controls[key] = el;
      return el;
    };
    const text = (key) => {
      const el = h("input", { class: "field mono", id: `set-${key}`, type: "text", spellcheck: false, onchange: () => patch({ [key]: el.value.trim() }), onkeydown: (e) => e.key === "Enter" && el.blur() });
      controls[key] = el;
      return el;
    };
    const num = (key, min, max) => {
      const el = h("input", { class: "field mono", id: `set-${key}`, type: "number", min, max, onchange: () => patch({ [key]: Math.max(min, Math.min(max, Number(el.value) || min)) }) });
      controls[key] = el;
      return el;
    };
    const toggle = (key) => {
      const el = h("button", { class: "switch", id: `set-${key}`, type: "button", role: "switch", "aria-checked": "false", onclick: () => patch({ [key]: el.getAttribute("aria-checked") !== "true" }) });
      controls[key] = el;
      return el;
    };
    const mic = h("select", { class: "field", id: "set-micDeviceId", onchange: () => patch({ micDeviceId: mic.value || undefined }) }, h("option", { value: "" }, "System default"));
    controls.micDeviceId = mic;
    const micHelp = h("div", { class: "help" }, "");
    populateMics(mic, micHelp);
    navigator.mediaDevices?.addEventListener?.("devicechange", () => populateMics(mic, micHelp));

    const row = (label, id, control) => h("div", { class: "row" }, h("label", { for: `set-${id}` }, label), control);

    clear(panels.settings).append(
      h(
        "section",
        { class: "sec" },
        h("div", { class: "sec-head" }, h("h3", { class: "eyebrow" }, "Voice")),
        h("div", { class: "form" }, row("Voice", "voice", sel("voice", VOICES)), row("Microphone", "micDeviceId", mic), micHelp),
      ),
      h(
        "section",
        { class: "sec" },
        h("div", { class: "sec-head" }, h("h3", { class: "eyebrow" }, "Brain")),
        h("div", { class: "form" }, row("Brain", "brain", sel("brain", BRAINS)), row("Model", "brainModel", text("brainModel")), row("Effort", "effort", sel("effort", EFFORTS))),
      ),
      h(
        "section",
        { class: "sec" },
        h("div", { class: "sec-head" }, h("h3", { class: "eyebrow" }, "Session")),
        h(
          "div",
          { class: "form" },
          row("Idle sleep", "idleSleepMinutes", h("div", { style: "display:flex;align-items:center;gap:8px" }, num("idleSleepMinutes", 1, 240), h("span", { style: "color:var(--fg-3);font-size:11px" }, "min"))),
          h("div", { class: "row toggle" }, h("label", { for: "set-autoWake" }, "Auto-wake on launch"), toggle("autoWake")),
        ),
      ),
    );
  }

  async function populateMics(select, help) {
    if (!navigator.mediaDevices?.enumerateDevices) {
      help.textContent = "Device list unavailable in this context.";
      return;
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter((d) => d.kind === "audioinput");
      const current = select.value;
      clear(select).append(h("option", { value: "" }, "System default"));
      let unlabeled = 0;
      inputs.forEach((d, i) => {
        if (!d.deviceId || d.deviceId === "default") return;
        const label = d.label || `Microphone ${i + 1} (${d.deviceId.slice(0, 6)}…)`;
        if (!d.label) unlabeled += 1;
        select.append(h("option", { value: d.deviceId }, label));
      });
      select.value = current;
      help.textContent = unlabeled ? "Some devices are unnamed until the microphone permission is granted." : inputs.length ? "" : "No microphones found.";
    } catch (err) {
      help.textContent = `Could not list devices: ${err?.message ?? err}`;
    }
  }

  function syncSettings(settings) {
    if (!settingsBuilt) buildSettings();
    for (const [key, el] of Object.entries(controls)) {
      // Only typed fields carry a draft worth protecting; switches and selects
      // commit atomically and must always mirror the snapshot.
      if (el.tagName === "INPUT" && document.activeElement === el) continue;
      const value = settings[key];
      if (el.classList.contains("switch")) el.setAttribute("aria-checked", String(Boolean(value)));
      else if (el.tagName === "SELECT") {
        if (key === "micDeviceId") {
          el.value = value ?? "";
          if (el.value !== (value ?? "")) el.value = "";
        } else if (value != null && ![...el.options].some((o) => o.value === value)) {
          el.append(h("option", { value }, value));
          el.value = value;
        } else el.value = value ?? "";
      } else el.value = value ?? "";
    }
  }

  // ---------------------------------------------------------------- ledger
  let ledgerDays = null;
  let pickedDay = null;

  async function loadLedgerDays() {
    if (ledgerDays) return;
    clear(panels.ledger).append(h("section", { class: "sec" }, h("div", { class: "empty" }, h("span", null, "Loading ledger…"))));
    try {
      ledgerDays = await bridge.ledgerDays();
    } catch (err) {
      ledgerDays = [];
      clear(panels.ledger).append(h("section", { class: "sec" }, h("div", { class: "empty" }, h("strong", null, "Ledger unavailable"), h("span", null, String(err?.message ?? err)))));
      return;
    }
    renderLedgerPicker();
  }

  function renderLedgerPicker(stats) {
    clear(panels.ledger).append(
      h(
        "section",
        { class: "sec" },
        h("div", { class: "sec-head" }, h("h3", { class: "eyebrow" }, "Days"), h("button", { class: "btn ghost", type: "button", onclick: () => send({ type: "open-ledger" }) }, icon(icons.external, "sm"), "Open folder")),
        ledgerDays.length
          ? h(
              "div",
              { class: "ledger-days" },
              ...ledgerDays.map((day) =>
                h(
                  "button",
                  { type: "button", class: "ledger-day", "aria-pressed": String(day === pickedDay), onclick: () => pickDay(day) },
                  h("span", null, fmtDay(day)),
                  h("span", { class: "mono" }, day),
                ),
              ),
            )
          : h("div", { class: "empty" }, h("strong", null, "No ledger yet"), h("span", null, "Days appear here once a session has been recorded.")),
      ),
      stats
        ? h(
            "section",
            { class: "sec" },
            h("div", { class: "sec-head" }, h("h3", { class: "eyebrow" }, fmtDay(pickedDay))),
            h(
              "div",
              { class: "ledger-stats" },
              h("div", { class: "stat" }, h("div", { class: "n" }, String(stats.sessions)), h("div", { class: "l" }, "sessions")),
              h("div", { class: "stat" }, h("div", { class: "n" }, String(stats.utterances)), h("div", { class: "l" }, "utterances")),
              h("div", { class: "stat" }, h("div", { class: "n" }, String(stats.delegations)), h("div", { class: "l" }, "delegations")),
            ),
            stats.billed != null ? h("div", { class: "kv", style: "margin-top:10px" }, h("span", { class: "k" }, "Billed"), h("span", { class: "v mono" }, fmtMinutes(stats.billed))) : null,
          )
        : null,
    );
  }

  async function pickDay(day) {
    pickedDay = day;
    renderLedgerPicker();
    const rows = await bridge.readLedger(day);
    const stats = {
      sessions: rows.filter((r) => r.type === "session.started").length,
      utterances: rows.filter((r) => r.type === "heard" || r.type === "said").length,
      delegations: rows.filter((r) => r.type === "delegation.created").length,
      billed: rows.filter((r) => r.type === "session.closed").reduce((acc, r) => acc + r.usageSeconds, 0),
    };
    renderLedgerPicker(stats);
    onLedgerPick(day, rows);
  }

  // ------------------------------------------------------------------ api
  return {
    render(snap) {
      snapshot = snap;
      renderNow(snap);
      syncSettings(snap.settings);
    },
    levels,
    tick,
    select,
    onSelect(fn) {
      listeners.add(fn);
    },
    get active() {
      return active;
    },
    get pickedDay() {
      return pickedDay;
    },
    /** Dev aid: open the ledger tab and pick the newest day. */
    async pickNewestDay() {
      select("ledger");
      await loadLedgerDays();
      if (ledgerDays?.length) await pickDay(ledgerDays[0]);
    },
  };
}
