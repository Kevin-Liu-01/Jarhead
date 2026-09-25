/** Data chips: mono 11.5 on --jh-lift, radius 6. Glances, never sentences. */
export function Chips({ items, className }: { readonly items: readonly string[]; readonly className?: string }) {
  return (
    <ul className={`jh-chips${className ? ` ${className}` : ""}`}>
      {items.map((item) => (
        <li key={item} className="jh-chip">
          {item}
        </li>
      ))}
    </ul>
  );
}
