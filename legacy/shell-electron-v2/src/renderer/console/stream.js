// The Stream: one chronological feed of utterances and delegation cards.
// Rows are keyed and only rebuilt when their signature changes, so a 20 Hz
// snapshot rate costs almost nothing. The same renderer draws ledger days.

import { h, icon, chip, dot, clear } from "../shared/dom.js";
import { icons, stepIcon } from "../shared/icons.js";
import { fmtTime, fmtMs, fmtDelta, fmtMinutes, previewJson, shortId } from "../shared/format.js";
import { delegationMeta, statusMeta } from "../shared/phase.js";

const NEAR_BOTTOM = 32;

export function createStream({ feed, jump, screenshotUrl, openLightbox }) {
  /** key → { node, sig } */
  const live = new Map();
  let stuck = true;
  let emptyNode = null;
  let lastTop = 0;

  const nearBottom = () => feed.scrollHeight - feed.scrollTop - feed.clientHeight <= NEAR_BOTTOM;

  // Only an upward move unsticks; content growth and our own scroll-to-bottom
  // never decrease scrollTop, so they can't be mistaken for the user scrolling.
  feed.addEventListener("scroll", () => {
    const top = feed.scrollTop;
    if (nearBottom()) {
      stuck = true;
      jump.hidden = true;
    } else if (top < lastTop - 1) stuck = false;
    lastTop = top;
  });
  feed.addEventListener(
    "wheel",
    (e) => {
      if (e.deltaY < 0 && !nearBottom()) stuck = false;
    },
    { passive: true },
  );
  jump.addEventListener("click", () => {
    feed.scrollTop = feed.scrollHeight;
    stuck = true;
    jump.hidden = true;
  });
  jump.prepend(icon(icons.arrowDown));

  const ctx = { screenshotUrl, openLightbox };

  /**
   * entries: [{ key, at, sig, build: () => Node }] sorted by `at`.
   * Rebuilds only rows whose signature changed; fixes DOM order; autoscrolls.
   */
  function render(entries, emptyState) {
    let changed = false;

    if (entries.length === 0) {
      for (const rec of live.values()) rec.node.remove();
      live.clear();
      if (!emptyNode || emptyNode.dataset.kind !== emptyState.kind) {
        emptyNode?.remove();
        emptyNode = h("div", { class: "empty", dataset: { kind: emptyState.kind } }, h("strong", null, emptyState.title), h("span", null, emptyState.body), emptyState.action ?? null);
        feed.append(emptyNode);
      }
      return;
    }
    if (emptyNode) {
      emptyNode.remove();
      emptyNode = null;
    }

    const seen = new Set();
    const ordered = entries.map((entry) => {
      seen.add(entry.key);
      let rec = live.get(entry.key);
      if (!rec || rec.sig !== entry.sig) {
        const openSteps = rec ? new Set([...rec.node.querySelectorAll("details[open]")].map((d) => d.dataset.step)) : null;
        const node = entry.build(ctx);
        if (openSteps?.size) for (const d of node.querySelectorAll("details")) if (openSteps.has(d.dataset.step)) d.open = true;
        if (rec) rec.node.replaceWith(node);
        rec = { node, sig: entry.sig };
        live.set(entry.key, rec);
        changed = true;
      }
      return rec.node;
    });
    for (const [key, rec] of live) {
      if (!seen.has(key)) {
        rec.node.remove();
        live.delete(key);
        changed = true;
      }
    }
    ordered.forEach((node, i) => {
      if (feed.children[i] !== node) feed.insertBefore(node, feed.children[i] ?? null);
    });

    if (stuck) feed.scrollTop = feed.scrollHeight;
    else if (changed) jump.hidden = false;
  }

  /** Update live "running" timers without rebuilding cards. */
  function tick() {
    const now = Date.now();
    for (const el of feed.querySelectorAll("[data-live]")) {
      const since = Number(el.dataset.live);
      el.textContent = fmtMs(now - since);
    }
  }

  function reset() {
    for (const rec of live.values()) rec.node.remove();
    live.clear();
    emptyNode?.remove();
    emptyNode = null;
    stuck = true;
    jump.hidden = true;
  }

  return { render, tick, reset };
}

// -------------------------------------------------------------- entries ---

export function entriesFromSnapshot(snapshot) {
  const out = [];
  for (const t of snapshot.transcript) {
    out.push({ key: `t:${t.id}`, at: t.at, sig: `${t.text.length}|${t.final}|${t.endMs}`, build: () => utteranceNode(t) });
  }
  for (const d of snapshot.delegations) {
    out.push({ key: `d:${d.id}`, at: d.createdAt, sig: delegationSig(d), build: (ctx) => cardNode(d, ctx) });
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}

export function entriesFromLedger(rows) {
  const out = [];
  const delegations = new Map();
  for (const row of rows) {
    switch (row.type) {
      case "session.started":
        out.push(sysEntry(row.at, `s:${row.at}`, icons.bolt, [`Session started`, sep(), mono(shortId(row.sessionId)), sep(), `voice ${row.voice}`]));
        break;
      case "session.closed":
        out.push(sysEntry(row.at, `c:${row.at}`, icons.moon, [`Session closed (${row.reason})`, sep(), `${fmtMinutes(row.usageSeconds)} billed`]));
        break;
      case "heard":
      case "said":
        out.push({ key: `t:${row.item.id}`, at: row.item.at, sig: "ledger", build: () => utteranceNode(row.item) });
        break;
      case "delegation.created": {
        const d = { ...row.delegation, steps: [...row.delegation.steps], timings: { ...row.delegation.timings } };
        delegations.set(d.id, d);
        out.push({ key: `d:${d.id}`, at: d.createdAt, sig: "ledger", build: (ctx) => cardNode(delegations.get(d.id), ctx) });
        break;
      }
      case "delegation.step": {
        const d = delegations.get(row.delegationId);
        if (!d) break;
        d.steps.push(row.step);
        if (row.step.kind === "thinking" && !d.timings.firstThinkingAt) d.timings.firstThinkingAt = row.step.at;
        if (row.step.kind === "commentary" && !d.timings.firstCommentaryAt) d.timings.firstCommentaryAt = row.step.at;
        break;
      }
      case "delegation.finished": {
        const d = delegations.get(row.delegationId);
        if (!d) break;
        d.status = row.status;
        d.timings = { ...d.timings, ...row.timings };
        if (row.summary) d.summary = row.summary;
        break;
      }
      case "problem":
        out.push(sysEntry(row.at, `p:${row.at}`, icons.alert, [row.text], "problem"));
        break;
      case "agent": {
        const meta = statusMeta(row.agent.status);
        out.push(sysEntry(row.at, `a:${row.at}:${row.agent.id}`, icons.tool, [row.agent.name, chip(meta.label, meta.token), row.agent.detail ?? ""]));
        break;
      }
      default:
        break;
    }
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}

const sep = () => h("span", { class: "sep", style: "color:var(--fg-3)" }, "·");
const mono = (text) => h("span", { class: "mono" }, text);

function sysEntry(at, key, svg, parts, cls = "") {
  return {
    key,
    at,
    sig: "sys",
    build: () => h("div", { class: `sys ${cls}`.trim() }, h("span", { class: "ts" }, fmtTime(at)), h("span", { class: "body" }, icon(svg, "sm"), ...parts)),
  };
}

function delegationSig(d) {
  const last = d.steps[d.steps.length - 1];
  return `${d.status}|${d.steps.length}|${last?.id ?? ""}|${d.timings.doneAt ?? ""}|${d.summary?.length ?? 0}`;
}

// ---------------------------------------------------------------- nodes ---

export function utteranceNode(t) {
  return h(
    "div",
    { class: `utt ${t.speaker}`, dataset: { id: t.id } },
    h("span", { class: "ts", title: new Date(t.at).toLocaleString() }, fmtTime(t.at)),
    h("div", { class: `body${t.final ? "" : " streaming"}` }, t.text || "…"),
  );
}

export function cardNode(d, ctx) {
  const meta = delegationMeta(d.status);
  return h(
    "article",
    { class: "card", dataset: { status: d.status, id: d.id }, "aria-label": `Delegation ${meta.label}` },
    h(
      "div",
      { class: "card-head" },
      dot(meta.token, meta.live),
      h("span", { class: "title" }, "Delegation"),
      chip(meta.label, meta.token, "no-dot"),
      h("span", { class: "id", title: d.liveId }, shortId(d.id)),
      h("span", { class: "ts" }, fmtTime(d.createdAt)),
    ),
    h("p", { class: "card-req" }, d.request),
    timelineNode(d),
    d.steps.length ? h("div", { class: "steps" }, ...d.steps.map((s, i) => stepNode(s, i, d, ctx))) : null,
    d.summary ? h("div", { class: "card-foot" }, icon(d.status === "failed" ? icons.alert : d.status === "cancelled" ? icons.ban : icons.check), d.summary) : null,
  );
}

function timelineNode(d) {
  const T = d.timings;
  const t0 = T.delegatedAt;
  const running = !T.doneAt;
  const end = T.doneAt ?? Date.now();
  const total = Math.max(1, end - t0);
  const marks = [
    { label: "delegated", at: t0, tone: "var(--fg-2)" },
    { label: "thinking", at: T.firstThinkingAt, tone: "var(--phase-thinking)" },
    { label: "spoke", at: T.firstCommentaryAt, tone: "var(--phase-speaking)" },
    { label: running ? "running" : d.status, at: T.doneAt, tone: "var(--tone)", pending: running },
  ].filter((m) => m.at != null || m.pending);

  // Marks sit at proportional positions on the track; labels are laid out as a
  // space-between row so they can never collide. Colour ties label to mark.
  const track = h("div", { class: "tl-track" }, h("span", { class: "tl-line" }));
  for (const m of marks) {
    const pct = m.pending ? 100 : Math.min(100, ((m.at - t0) / total) * 100);
    track.append(h("span", { class: `tl-mark${m.pending ? " pending" : ""}`, style: { left: `${pct}%`, "--m": m.tone } }));
  }
  const labels = h(
    "div",
    { class: "tl-labels" },
    ...marks.map((m, i) =>
      h(
        "span",
        { class: "tl-lbl", style: { "--m": m.tone } },
        h("b", null, m.label),
        " ",
        m.pending ? h("span", { dataset: { live: String(t0) } }, fmtMs(Date.now() - t0)) : i === 0 ? "0" : fmtDelta(m.at - t0),
      ),
    ),
  );
  return h("div", { class: "tl", role: "img", "aria-label": `Timeline: ${marks.map((m) => m.label).join(" → ")}` }, track, labels);
}

function stepNode(step, index, d, ctx) {
  const delta = h("span", { class: "ts", title: fmtTime(step.at) }, fmtDelta(step.at - d.timings.delegatedAt));
  const base = (cls, ...body) => h("div", { class: `step ${cls}`, dataset: { step: step.id } }, icon(stepIcon[step.kind] ?? icons.note, "sm"), ...body, delta);

  switch (step.kind) {
    case "tool": {
      const tool = step.tool;
      if (!tool) return base("tool", h("span", { class: "text" }, step.text ?? "tool"));
      return base(
        "tool",
        h(
          "details",
          { dataset: { step: step.id } },
          h(
            "summary",
            null,
            icon(icons.chevronRight, "sm chev"),
            h("span", { class: "name" }, tool.name),
            h("span", { class: `ok${tool.ok ? "" : " bad"}`, title: tool.ok ? "ok" : "failed" }),
            h("span", { class: "ms" }, fmtMs(tool.ms)),
            step.text ? h("span", { class: "ms" }, `· ${step.text}`) : null,
          ),
          h(
            "div",
            { class: "io" },
            h("div", null, h("div", { class: "k" }, "input"), h("pre", null, previewJson(tool.input) || "—")),
            tool.output !== undefined ? h("div", null, h("div", { class: "k" }, "output"), h("pre", null, previewJson(tool.output))) : null,
          ),
        ),
      );
    }
    case "screenshot": {
      const src = step.screenshotPath ? ctx.screenshotUrl(step.screenshotPath) : "";
      const img = h("img", {
        src,
        alt: step.text ?? "Screenshot",
        loading: "lazy",
        onclick: () => ctx.openLightbox(src, step.text ?? step.screenshotPath ?? "Screenshot"),
      });
      return base("screenshot", h("div", { class: "shot" }, img, h("span", { class: "cap" }, step.text ?? step.screenshotPath ?? "")));
    }
    case "confirm": {
      const resolved = d.status !== "awaiting-confirmation" || index !== d.steps.length - 1;
      return base(
        `confirm${resolved ? " resolved" : ""}`,
        h("div", null, h("span", { class: "lead" }, resolved ? "Confirmation" : "Waiting for Kevin"), h("span", { class: "text" }, step.text ?? "")),
      );
    }
    default:
      return base(step.kind, h("span", { class: "text" }, step.text ?? ""));
  }
}
