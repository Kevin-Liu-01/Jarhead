/** ConsoleKeyCap's twin (ConsoleBadge.swift:160-175): mono 10 --jh-fg-3, 16 tall, min width 16, one hairline, radius 6. Reads as its key. */
export function KeyCap({ children, className }: { readonly children: string; readonly className?: string }) {
  return <kbd className={`kit-key${className ? ` ${className}` : ""}`}>{children}</kbd>;
}
