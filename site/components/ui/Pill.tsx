import type { CSSProperties, ReactNode } from "react";
import { Tip } from "@/components/kit";
import { PHASE_META, type DeskKind } from "@/lib/phase";
import { PHASES } from "@/content/deck";

/**
 * Mailroom's pill badge (globals.css:111-114; MAILROOM.md §6 take 7): 24 tall, one hairline, muted words; `on` inverts
 * it (the state that acts), `danger` hatches it in the error tone. With `phase` it carries the phase's dot and word and
 * the phase's hint as its tip (COPY.md: a dot, a badge or a tooltip at most). A phase pill is a tab stop (a note, never a
 * control) so the tip opens on keyboard focus as the stat cards' do; the ring is the page's :focus-visible.
 */
export function Pill({ word, phase, on, danger, icon, className }: { readonly word?: string; readonly phase?: DeskKind; readonly on?: boolean; readonly danger?: boolean; readonly icon?: ReactNode; readonly className?: string }) {
  const cls = ["mr-pill", on ? "mr-pill--on" : "", danger ? "mr-pill--danger" : "", className ?? ""].filter(Boolean).join(" ");
  const style = phase ? ({ "--mr-phase": `var(${PHASE_META[phase].token})` } as CSSProperties) : undefined;
  const pill = (
    <span className={cls} style={style} role={phase ? "note" : undefined} tabIndex={phase ? 0 : undefined}>
      {phase ? <span className="kit-dot" aria-hidden="true" /> : icon}
      {phase ? PHASES[phase].word : word}
    </span>
  );
  return phase ? <Tip line={PHASES[phase].hint}>{pill}</Tip> : pill;
}
