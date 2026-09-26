"use client";

import { Fragment, useEffect, useId, useState, type KeyboardEvent, type ReactElement, type ReactNode } from "react";
import { Badge, type BadgeTone } from "./Badge";
import { Glyph } from "./Glyph";

/** Summary items while closed: words in sans 11 --jh-fg-3, figures and ids in mono 11 titanium, one badge; ` · `-joined (ConsoleDisclosure.swift:102-110, 258-277). */
export type SummaryItem = string | { readonly figure: string } | { readonly badge: { readonly word?: string; readonly figure?: string; readonly tone?: BadgeTone } };

/**
 * ConsoleDisclosure's twin (ConsoleDisclosure.swift:4-9, 62-95, 164-191, 206-255): a head that IS the summary while
 * closed and gets its own control back while open; the content arrives with 6 pt of air and a fade-rise; `section` (28)
 * replaces a rail section head and draws its own hairline below, `group` (24) is a fold inside a list. The chevron
 * rotates 0 → 90. Keys: Enter and Space toggle (a fold is not a yes), → opens, ← folds. `remember` keeps the open
 * state per id in localStorage (the app's console.fold.<id>). aria-expanded on the head, aria-controls to the body. The
 * head's title, count and summary are separated by space text nodes (unrendered between flex items) so the button's
 * name and text read as words, never `title4git clone`.
 */
export function Disclosure({ id, kind = "section", title, count, summary, control, defaultOpen, inset, remember, className, children }: { readonly id: string; readonly kind?: "section" | "group"; readonly title: string; readonly count?: string | number; readonly summary?: readonly SummaryItem[]; readonly control?: ReactNode; readonly defaultOpen?: boolean; readonly inset?: boolean; readonly remember?: boolean; readonly className?: string; readonly children: ReactNode }): ReactElement {
  const bodyId = useId();
  const [open, setOpen] = useState(Boolean(defaultOpen));
  const [arrived, setArrived] = useState(false);
  const key = `kit.fold.${id}`;

  useEffect(() => {
    if (!remember) return;
    try {
      const v = localStorage.getItem(key);
      if (v === "1") setOpen(true);
      if (v === "0") setOpen(false);
    } catch {
      // Private mode: the fold lives for this page only.
    }
  }, [remember, key]);

  const set = (next: boolean) => {
    setOpen(next);
    setArrived(next);
    if (remember) {
      try {
        localStorage.setItem(key, next ? "1" : "0");
      } catch {
        // as above
      }
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowRight" && !open) {
      e.preventDefault();
      set(true);
    } else if (e.key === "ArrowLeft" && open) {
      e.preventDefault();
      set(false);
    }
  };

  const cls = ["kit-fold", `kit-fold--${kind}`, inset ? "kit-fold--inset" : "", open ? "is-open" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <div className={cls} data-fold={id}>
      <div className="kit-fold-bar">
        <button type="button" className="kit-fold-head" aria-expanded={open} aria-controls={bodyId} onClick={() => set(!open)} onKeyDown={onKeyDown}>
          <span className="kit-fold-chevron">
            <Glyph name="chevron" size={14} />
          </span>
          <span className="kit-fold-title">{title}</span>{" "}
          {count !== undefined ? <span className="kit-fold-count">{count}</span> : null}{" "}
          {!open && summary && summary.length > 0 ? (
            <span className="kit-fold-summary">
              {summary.map((s, i) => (
                <Fragment key={i}>
                  {i > 0 ? (
                    <span className="kit-fold-sep" aria-hidden="true">
                      {" · "}
                    </span>
                  ) : null}
                  {typeof s === "string" ? <span>{s}</span> : "figure" in s ? <span className="is-figure">{s.figure}</span> : <Badge word={s.badge.word} figure={s.badge.figure} tone={s.badge.tone} />}
                </Fragment>
              ))}
            </span>
          ) : null}
        </button>
        {open && control ? <span className="kit-fold-control">{control}</span> : null}
      </div>
      <div id={bodyId} className={`kit-fold-body${arrived ? " is-in" : ""}`} hidden={!open}>
        {children}
      </div>
    </div>
  );
}
