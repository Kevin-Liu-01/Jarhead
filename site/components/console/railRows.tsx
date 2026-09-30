import type { CSSProperties, ReactElement, ReactNode } from "react";
import { AgentMark, Glyph, Group, GroupHead, JarheadMark, Row } from "@/components/kit";
import { RAIL_APP, type FoldHead, type ThreadRow } from "@/content/rail";
import { Tone } from "./stream/parts";

/**
 * The app's own rail pieces (AgentsRailView.swift, ThreadsRailView.swift; console-jarhead.jpg, console-threads.jpg),
 * drawn from the kit over the harness's fixed strings (content/rail.ts): the Threads group with a Stop square on each
 * thread, the conversations under Pinned and Today with their orbs and the closed folds with their summaries, the
 * Agents group with Claude Code open and the other agents folded. The left rail holds them all; on a phone the Threads
 * and Hands conversations take the Threads and Agents groups into their right-rail groups (railGroups.tsx).
 */

/** The ⋯ the app draws at rest on every conversation and agent row (ConsoleRow.swift:474-503): a drawing here, the row acts nowhere. */
function More(): ReactElement {
  return (
    <span className="lr-more" aria-hidden="true">
      <Glyph name="ellipsis" size={14} />
    </span>
  );
}

/** A thread's Stop square (the island's tile Stop, notch-island-working.png): a drawing on the thread rows. */
function StopSquare(): ReactElement {
  return (
    <span className="lr-stop" aria-hidden="true">
      <Glyph name="stop" size={14} />
    </span>
  );
}

/** A closed or open fold head as the app draws it (ConsoleDisclosure.swift): the chevron, the word, the count, the summary at the right. Drawn: nothing folds on the page. */
export function Fold({ word, count, summary, open, mark }: { readonly word: string; readonly count: number; readonly summary?: string; readonly open?: boolean; readonly mark?: ReactNode }): ReactElement {
  return (
    <li className={`lr-fold${open ? " is-open" : ""}`}>
      <span className="kit-fold-chevron lr-fold-chevron">
        <Glyph name="chevron" size={14} />
      </span>
      {mark}
      <span className="lr-fold-word">{word}</span>
      <span className="kit-fold-count">{count}</span>
      {summary ? (
        <span className="kit-fold-summary">
          <span className="is-figure">{summary}</span>
        </span>
      ) : null}
    </li>
  );
}

const LIVE_DOT = { "--kit-phase": "var(--jh-listening)" } as CSSProperties;

/** `● working` at the right of an agent row: the live dot in the listening tone and the word (AgentsRailView.swift: blue means alive). */
function LiveWord({ word }: { readonly word: string }): ReactElement {
  return (
    <span className="lr-live">
      <span className="kit-dot is-live" style={LIVE_DOT} aria-hidden="true" />
      {word}
    </span>
  );
}

/** One thread: the status glyph in its tone on the icon column, `asks` as a badge, `done` as the value, the meta line, a Stop square (the left rail) or the Now rail's Stop verb on the thread that asks. */
function ThreadRow({ t, stop }: { readonly t: ThreadRow; readonly stop: "square" | "verb" }): ReactElement {
  return (
    <Row
      size={13}
      icon={t.status === "asks" ? <Tone name="handRaised" tone="speaking" /> : <Tone name="checkCircle" tone="acting" />}
      title={t.name}
      badge={t.status === "asks" ? { word: "asks", tone: "speaking" } : undefined}
      value={t.status === "done" ? t.status : undefined}
      meta={t.meta}
      trailing={
        stop === "verb" ? (
          t.status === "asks" ? (
            <span className="kit-btn kit-btn--ghost kit-btn--sm lr-verb" aria-hidden="true">
              {RAIL_APP.threadsNow.stop}
            </span>
          ) : undefined
        ) : (
          <StopSquare />
        )
      }
    />
  );
}

/** The three threads with their Stop squares (console-threads.jpg, left). */
export function ThreadRows(): ReactElement {
  return (
    <>
      {RAIL_APP.threads.rows.map((t) => (
        <ThreadRow key={t.name} t={t} stop="square" />
      ))}
    </>
  );
}

/** The Threads group as the left rail shows it: `Threads · 3 · 1 asks` over the three rows. */
export function ThreadsGroup({ className }: { readonly className?: string }): ReactElement {
  return (
    <Group className={className} head={<GroupHead title={RAIL_APP.threads.word} figure={RAIL_APP.threads.figure} rule />}>
      <ThreadRows />
    </Group>
  );
}

/** The Now rail's Threads group (console-threads.jpg, right): `Threads 4 · 1 running`, Slack with its Stop verb, the Jarhead row, Spotify and Notes done. */
export function ThreadsNowGroup({ className }: { readonly className?: string }): ReactElement {
  const j = RAIL_APP.threadsNow.jarhead;
  const [slack, ...rest] = RAIL_APP.threads.rows;
  return (
    <Group className={className} head={<GroupHead title={RAIL_APP.threads.word} count={RAIL_APP.threadsNow.count} figure={RAIL_APP.threadsNow.figure} rule />}>
      {slack ? <ThreadRow t={slack} stop="verb" /> : null}
      <Row size={13} icon={<JarheadMark size={14} quiet />} title={j.name} value={j.value} meta={j.meta} />
      {rest.map((t) => (
        <ThreadRow key={t.name} t={t} stop="verb" />
      ))}
    </Group>
  );
}

/** Pinned and Today with their rows, then the four closed folds (Yesterday · Older · Archived · Trash): quiet orbs for what is over, the bright one for today's. */
export function ConversationsGroup({ className }: { readonly className?: string }): ReactElement {
  return (
    <section className={`kit-group${className ? ` ${className}` : ""}`}>
      <GroupHead title={RAIL_APP.pinned.word} count={RAIL_APP.pinned.count} rule />
      <ul role="list" className="kit-rows">
        <Row size={13} icon={<JarheadMark size={14} quiet />} title={RAIL_APP.pinned.row.name} value={RAIL_APP.pinned.row.value} trailing={<More />} />
      </ul>
      <ul role="list" className="kit-rows lr-folds">
        <Fold word={RAIL_APP.today.word} count={RAIL_APP.today.count} open />
        <Row size={13} icon={<JarheadMark size={14} />} title={RAIL_APP.today.row.name} badge={{ figure: RAIL_APP.today.row.badge }} value={RAIL_APP.today.row.value} trailing={<More />} className="lr-today" />
        {RAIL_APP.folds.map((f: FoldHead) => (
          <Fold key={f.word} word={f.word} count={f.count} summary={f.summary} />
        ))}
      </ul>
    </section>
  );
}

/** The Agents group: the head with the app's refresh glyph, Claude Code open with its four sessions, then Ended, Codex and Cursor folded. */
export function AgentsGroup({ className }: { readonly className?: string }): ReactElement {
  const a = RAIL_APP.agents;
  return (
    <section className={`kit-group${className ? ` ${className}` : ""}`}>
      <GroupHead
        title={a.word}
        count={a.count}
        rule
        trailing={
          <span className="lr-reload" aria-hidden="true">
            <Glyph name="reload" size={16} />
          </span>
        }
      />
      <ul role="list" className="kit-rows lr-folds">
        <Fold word={a.claude.word} count={a.claude.count} open />
        {a.claude.rows.map((r) => (
          <Row
            key={r.name}
            size={13}
            icon={<AgentMark tool="claude" size={14} />}
            title={r.name}
            badge={r.badge ? { word: r.badge, tone: "speaking" } : undefined}
            value={r.value}
            meta={r.meta}
            trailing={
              <>
                {r.live ? <LiveWord word={r.live} /> : null}
                <More />
              </>
            }
          />
        ))}
        {a.folds.map((f) => (
          <Fold key={f.word} word={f.word} count={f.count} summary={f.summary} mark={f.tool ? <AgentMark tool={f.tool} size={14} quiet className="lr-fold-mark" /> : undefined} />
        ))}
      </ul>
    </section>
  );
}
