import type { JSX } from "react";

/**
 * A block of short mono lines set like the standing orders: no rules, no bullets, one word or
 * phrase per line, an optional mono foot under it. The seven brains, the ten families, the seven
 * required permissions.
 */
export function Block({ items, foot, className }: { readonly items: readonly string[]; readonly foot?: string; readonly className?: string }): JSX.Element {
  return (
    <div className={`sec-block${className ? ` ${className}` : ""}`}>
      <ul className="sec-block-list">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      {foot ? <div className="sec-fig">{foot}</div> : null}
    </div>
  );
}
