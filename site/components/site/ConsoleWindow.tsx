import type { ReactElement } from "react";
import { AgentMark, type AgentTool } from "@/components/kit/AgentMark";
import { Badge } from "@/components/kit/Badge";
import { Glyph } from "@/components/kit/Glyph";
import { JarheadMark } from "@/components/kit/Mark";
import { ALT, NAV, PHASES } from "@/content/deck";
import { RAIL_APP } from "@/content/rail";

/** A fold head as the Console draws it: the chevron, an optional mark, the word, its count, the summary at the right. */
function Fold({ word, count, summary, tool, open }: { readonly word: string; readonly count: number; readonly summary?: string; readonly tool?: AgentTool; readonly open?: boolean }): ReactElement {
  return (
    <div className={`win-fold${open ? " is-open" : ""}`}>
      <span className="win-fold-chevron">
        <Glyph name="chevron" size={14} />
      </span>
      {tool ? <AgentMark tool={tool} size={14} quiet={tool !== "claude"} /> : null}
      <span className="win-fold-word">{word}</span>
      <span className="win-fold-count">{count}</span>
      {summary ? <span className="win-fold-summary">{summary}</span> : null}
    </div>
  );
}

/** A row: the 20 column, the title (+ a badge or a live word, a value), the meta line under it. */
function Line({ icon, title, badge, quiet, live, value, meta, strong }: { readonly icon: ReactElement; readonly title: string; readonly badge?: string; readonly quiet?: boolean; readonly live?: string; readonly value?: string; readonly meta?: string; readonly strong?: boolean }): ReactElement {
  return (
    <div className={`win-row${meta ? " has-meta" : ""}${strong ? " is-strong" : ""}`}>
      <span className="win-row-icon">{icon}</span>
      <span className="win-row-main">
        <span className="win-row-line">
          <span className="win-row-title">{title}</span>
          {badge ? <Badge word={badge} tone={quiet ? "rest" : "speaking"} /> : null}
          {live ? (
            <span className="win-live">
              <i className="kit-dot" style={{ ["--kit-phase" as string]: "var(--jh-listening)" }} />
              {live}
            </span>
          ) : null}
          {value ? <span className="win-row-value">{value}</span> : null}
        </span>
        {meta ? <span className="win-row-meta">{meta}</span> : null}
      </span>
    </div>
  );
}

/**
 * The Threads picture: a Console window drawn with the kit at the app's own density (560 × 420, scaled as one to its
 * frame), the app's rendered rows over the harness's fixed data (content/rail.ts), byte for byte. The title bar with the
 * lights, the mark, `Jarhead` and the phase; at the left the Threads group (Slack asks, Spotify and Notes done) and the
 * conversations; at the right the Agents group with the Claude Code sessions and the Codex and Cursor folds. A drawing of
 * the app, so one image with the deck's alt.
 */
export function ConsoleWindow(): ReactElement {
  const t = RAIL_APP.threads;
  const a = RAIL_APP.agents;
  return (
    <div className="winbox" role="img" aria-label={ALT.consoleThreads}>
      <div className="win" aria-hidden="true">
        <div className="win-bar">
          <span className="win-lights">
            <i className="win-light win-light-r" />
            <i className="win-light win-light-y" />
            <i className="win-light win-light-g" />
          </span>
          <JarheadMark size={14} />
          <span className="win-name">{NAV.brand}</span>
          <span className="win-phase">
            <i className="kit-dot is-live" style={{ ["--kit-phase" as string]: "var(--jh-acting)" }} />
            {PHASES.acting.word}
          </span>
        </div>
        <div className="win-body">
          <div className="win-col">
            <div className="win-head">
              <span>{t.word}</span>
              <span className="win-head-fig">{t.figure}</span>
            </div>
            {t.rows.map((r) => (
              <Line
                key={r.name}
                icon={r.status === "asks" ? <span className="win-tone win-tone--speaking"><Glyph name="handRaised" size={16} /></span> : <span className="win-tone win-tone--acting"><Glyph name="checkCircle" size={16} /></span>}
                title={r.name}
                badge={r.status === "asks" ? r.status : undefined}
                value={r.status === "done" ? r.status : undefined}
                meta={r.meta}
                strong
              />
            ))}
            <div className="win-head win-head--rule">
              <span>{RAIL_APP.pinned.word}</span>
              <span className="win-fold-count">{RAIL_APP.pinned.count}</span>
            </div>
            <Line icon={<JarheadMark size={14} quiet />} title={RAIL_APP.pinned.row.name} value={RAIL_APP.pinned.row.value} />
            <Fold word={RAIL_APP.today.word} count={RAIL_APP.today.count} open />
            <Line icon={<JarheadMark size={14} />} title={RAIL_APP.today.row.name} badge={RAIL_APP.today.row.badge} quiet value={RAIL_APP.today.row.value} strong />
            {RAIL_APP.folds.map((f) => (
              <Fold key={f.word} word={f.word} count={f.count} summary={f.summary} />
            ))}
          </div>
          <div className="win-col">
            <div className="win-head">
              <span>{a.word}</span>
              <span className="win-fold-count">{a.count}</span>
            </div>
            <Fold word={a.claude.word} count={a.claude.count} tool="claude" open />
            {a.claude.rows.map((r) => (
              <Line key={r.name} icon={<AgentMark tool="claude" size={14} quiet={!r.badge && !r.live} />} title={r.name} badge={r.badge} live={r.live} value={r.value} meta={r.meta} strong={Boolean(r.badge || r.live)} />
            ))}
            {a.folds.map((f) => (
              <Fold key={f.word} word={f.word} count={f.count} summary={f.summary} tool={f.tool} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
