// Left rail: agents grouped by connector kind, with inline prompt composer.

import { h, icon, chip, clear } from "../shared/dom.js";
import { icons } from "../shared/icons.js";
import { fmtRelative, truncPath } from "../shared/format.js";
import { statusMeta, agentKindLabel } from "../shared/phase.js";

const KIND_ORDER = ["claude-code", "herdr", "t3"];

export function createAgentsRail({ root, refreshButton, send }) {
  let openId = null;
  let lastSig = "";
  let snapshot = null;

  refreshButton.append(icon(icons.refresh));
  refreshButton.addEventListener("click", () => {
    send({ type: "agent.refresh" });
    refreshButton.animate?.([{ transform: "rotate(0)" }, { transform: "rotate(360deg)" }], { duration: 500, easing: "ease-out" });
  });

  function render(snap, force = false) {
    snapshot = snap;
    const sig = JSON.stringify([snap.agents, snap.connectors, openId]);
    if (!force && sig === lastSig) return;
    lastSig = sig;

    // preserve a draft being typed
    const draft = root.querySelector(".agent-composer textarea");
    const saved = draft ? { text: draft.value, focused: document.activeElement === draft, pos: draft.selectionStart } : null;

    clear(root);

    if (snap.agents.length === 0 && snap.connectors.every((c) => c.ok)) {
      root.append(
        h("div", { class: "empty" }, h("strong", null, "No agents found"), h("span", null, "Start a Claude Code session, a herdr pane, or pair T3 Code and they show up here.")),
      );
    }

    for (const kind of KIND_ORDER) {
      const connector = snap.connectors.find((c) => c.kind === kind);
      const agents = snap.agents.filter((a) => a.kind === kind).sort((a, b) => b.updatedAt - a.updatedAt);
      if (!connector && agents.length === 0) continue;
      root.append(groupNode(kind, connector, agents, saved));
    }
    if (saved?.focused) {
      const ta = root.querySelector(".agent-composer textarea");
      if (ta) {
        ta.focus();
        ta.setSelectionRange(saved.pos, saved.pos);
      }
    }
  }

  function groupNode(kind, connector, agents, saved) {
    const ok = connector ? connector.ok : true;
    const head = h(
      "div",
      { class: "group-head" },
      h(
        "h3",
        { class: "eyebrow" },
        h("span", { class: "dot", style: { "--dot": ok ? "var(--phase-acting)" : "var(--phase-error)" }, title: ok ? "connector ok" : "connector down" }),
        agentKindLabel(kind),
        agents.length ? h("span", { class: "mono", style: "color:var(--fg-3);font-weight:400" }, String(agents.length)) : null,
      ),
      connector ? h("div", { class: `health${ok ? "" : " bad"}`, title: connector.detail }, connector.detail) : null,
    );
    const group = h("section", { class: "agent-group", dataset: { kind } }, head);

    if (kind === "t3" && connector && !connector.ok) group.append(pairNode());

    if (agents.length === 0 && connector?.ok) {
      group.append(h("div", { class: "empty", style: "padding:10px 14px 12px" }, h("span", null, "Nothing running")));
    }

    for (const a of agents) {
      const meta = statusMeta(a.status);
      const row = h(
        "button",
        {
          type: "button",
          class: `agent${openId === a.id ? " open" : ""}`,
          dataset: { status: a.status, id: a.id },
          style: { "--tone": meta.token },
          "aria-expanded": String(openId === a.id),
          title: a.detail ?? a.name,
          onclick: () => {
            openId = openId === a.id ? null : a.id;
            render(snapshot, true);
            if (openId === a.id) root.querySelector(".agent-composer textarea")?.focus();
          },
        },
        h("span", { class: "name" }, a.name),
        chip(meta.label, meta.token),
        h("span", { class: "cwd", title: a.cwd ?? "" }, truncPath(a.cwd, 30)),
        h("span", { class: "when", title: new Date(a.updatedAt).toLocaleString(), dataset: { at: String(a.updatedAt) } }, fmtRelative(a.updatedAt)),
        a.detail ? h("span", { class: "detail" }, a.detail) : null,
      );
      group.append(row);
      if (openId === a.id) group.append(composerNode(a, saved));
    }
    return group;
  }

  function composerNode(agent, saved) {
    const ta = h("textarea", {
      class: "field",
      placeholder: `Prompt ${agent.name}…`,
      "aria-label": `Prompt for ${agent.name}`,
      value: saved?.text ?? "",
      onkeydown: (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          submit();
        } else if (e.key === "Escape") {
          openId = null;
          render(snapshot, true);
        }
      },
    });
    const submit = () => {
      const text = ta.value.trim();
      if (!text) return;
      send({ type: "agent.send", agentId: agent.id, text });
      ta.value = "";
    };
    return h(
      "div",
      { class: "agent-composer" },
      ta,
      h("button", { type: "button", class: "btn primary icon-only", title: "Send", "aria-label": "Send prompt", onclick: submit }, icon(icons.send)),
    );
  }

  function pairNode() {
    const input = h("input", { class: "field", placeholder: "Paste T3 Code pairing code", "aria-label": "T3 Code pairing code", onkeydown: (e) => e.key === "Enter" && submit() });
    const submit = () => {
      const value = input.value.trim();
      if (!value) return;
      send({ type: "t3.pair", input: value });
      input.value = "";
    };
    return h("div", { class: "pair" }, input, h("button", { type: "button", class: "btn", onclick: submit }, icon(icons.key), "Pair"));
  }

  /** Refresh relative times in place; never rebuilds rows. */
  function tick() {
    const now = Date.now();
    for (const el of root.querySelectorAll(".when[data-at]")) el.textContent = fmtRelative(Number(el.dataset.at), now);
  }

  return { render, tick };
}
