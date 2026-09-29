"use client";
import { useEffect, type ReactElement } from "react";
import { AgentMark, Glyph, Group, GroupHead, JarheadMark, Row, AGENT_LABELS } from "@/components/kit";
import { NAV, RAIL } from "@/content/deck";
import { setLive, useLive } from "@/lib/live";

/** The three coding agents the Console lists (AgentsRailView.swift), with the kit's own badge words. */
const AGENTS = [
  { tool: "claude", badge: { word: "asks", tone: "speaking" } },
  { tool: "codex", badge: { word: "working", tone: "rest" } },
  { tool: "cursor", badge: { word: "idle", tone: "rest" } },
] as const;

/**
 * The agents rail (AgentsRailView.swift): "blue means alive, grey means over". The page's conversations are its rows:
 * the ten sections with their orbs, bright for the one in view and quiet for the rest, the section in view selected with
 * the 2 px accent bar (the hero, the live conversation, is the title bar's brand link); the agents with their marks below.
 * Sticky beside the stream; on a phone the same rows become the strip under the title bar.
 */
export function LeftRail(): ReactElement {
  const live = useLive();

  // The section in view: the last one whose top has passed the line a fifth of the way down the stream under its sticky chrome
  // (the title bar, plus the strip on a phone: the sections' own scroll margin), so an anchored section is the one selected and
  // the rail's selection follows the stream as the reader goes on. A short conversation (Rails, Sleep, Costs) sits whole above
  // a lower line.
  useEffect(() => {
    const secs = Array.from(document.querySelectorAll<HTMLElement>("[data-sec]"));
    let raf = 0;
    const measure = () => {
      raf = 0;
      const chrome = secs[0] ? parseFloat(getComputedStyle(secs[0]).scrollMarginTop) || 0 : 0;
      const line = chrome + (window.innerHeight - chrome) * 0.2;
      let cur = "";
      for (const s of secs) {
        if (s.getBoundingClientRect().top <= line) cur = s.id;
      }
      setLive({ section: cur });
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  // On a phone the rail is a strip: it slides so the selected section stays in view.
  useEffect(() => {
    const strip = document.querySelector<HTMLElement>(".lr");
    if (!strip || strip.scrollWidth <= strip.clientWidth) return;
    const row = strip.querySelector<HTMLElement>(".lr-secs .kit-row.is-selected");
    const left = row ? row.offsetLeft - 12 : 0;
    if (Math.abs(strip.scrollLeft - left) > 4) strip.scrollTo({ left, behavior: "smooth" });
  }, [live.section]);

  return (
    <nav className="lr" aria-label={NAV.brand}>
      <div className="kit-head lr-head">
        <span>{NAV.brand}</span>
        <span className="kit-head-count">{RAIL.length}</span>
        <span className="kit-head-trailing lr-search" aria-hidden="true">
          <Glyph name="search" size={16} />
        </span>
      </div>
      <Group className="lr-secs">
        {RAIL.map((r) => {
          const on = live.section === r.id;
          return <Row key={r.id} size={13} icon={<JarheadMark size={14} quiet={!on} />} title={r.name} value={r.value} href={`#${r.id}`} selected={on} open={on} />;
        })}
      </Group>
      <Group className="lr-agents" head={<GroupHead title="Agents" count={AGENTS.length} rule />}>
        {AGENTS.map((a) => (
          <Row key={a.tool} size={13} icon={<AgentMark tool={a.tool} size={14} />} title={AGENT_LABELS[a.tool]} badge={a.badge} />
        ))}
      </Group>
    </nav>
  );
}
