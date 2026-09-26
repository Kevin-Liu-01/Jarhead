import type { ReactNode } from "react";
import { Badge, type BadgeTone } from "./Badge";

/**
 * ConsoleGroupHead's twin (ConsoleRow.swift:389-440): 22 tall, sans 11 medium titanium; a count in mono 11; a figure
 * (the summary of what is inside) in mono 11 at the right; one badge; padding 12; paints its surface behind itself so the
 * rows it pins over never show through (`sticky`). `rule` draws the --jh-hair-row above it.
 */
export function GroupHead({ title, count, figure, badge, trailing, rule, sticky, className }: { readonly title: string; readonly count?: string | number; readonly figure?: string; readonly badge?: { readonly word?: string; readonly figure?: string; readonly tone?: BadgeTone }; readonly trailing?: ReactNode; readonly rule?: boolean; readonly sticky?: boolean; readonly className?: string }) {
  const cls = ["kit-group-head", rule ? "kit-group-head--rule" : "", sticky ? "is-sticky" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <header className={cls}>
      <span className="kit-group-title">{title}</span>
      {count !== undefined ? <span className="kit-group-count">{count}</span> : null}
      {figure ? <span className="kit-group-figure">{figure}</span> : null}
      {badge || trailing ? (
        <span className="kit-group-trailing">
          {badge ? <Badge word={badge.word} figure={badge.figure} tone={badge.tone} /> : null}
          {trailing}
        </span>
      ) : null}
    </header>
  );
}
