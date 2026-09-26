import type { ReactNode } from "react";

/** The two-line h2 with the grey second line (page.tsx:56 and every h2 after it; MAILROOM.md §3). */
export function Heading({ h2, as: Tag = "h2", className }: { readonly h2: readonly [string, string]; readonly as?: "h1" | "h2"; readonly className?: string }) {
  return (
    <Tag className={`mr-h2${className ? ` ${className}` : ""}`}>
      {h2[0]}
      <br />
      <span className="mr-grey">{h2[1]}</span>
    </Tag>
  );
}

/** The lede: two or three sentences at 21 px, the lead's grey, at most 640 wide (page.tsx:18). */
export function Lead({ children, after, className }: { readonly children: ReactNode; readonly after?: boolean; readonly className?: string }) {
  return <p className={`mr-lead${after ? " mr-after" : ""}${className ? ` ${className}` : ""}`}>{children}</p>;
}

/** One section of the rail: Mailroom's section space above and below, the two-line h2, the lede, then the children (a figure, a grid, the cards). */
export function Section({ id, h2, lead, className, children }: { readonly id: string; readonly h2: readonly [string, string]; readonly lead?: string; readonly className?: string; readonly children?: ReactNode }) {
  return (
    <section id={id} className={`mr-sec${className ? ` ${className}` : ""}`}>
      <Heading h2={h2} />
      {lead ? <Lead>{lead}</Lead> : null}
      {children}
    </section>
  );
}
