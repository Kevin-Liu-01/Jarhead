import type { MouseEventHandler, ReactNode } from "react";

/**
 * A control: solid (the CTA, --jh-fg on --jh-ground text), tile (--jh-lift plus a hairline), text.
 * Heights 36 / 30, radius 6; colour, background and border move over --jh-instant, nothing else.
 * An href renders an <a>; otherwise a <button type="button">.
 */
export function Button({
  variant,
  size = "md",
  href,
  onClick,
  icon,
  ariaLabel,
  className,
  pressed,
  children,
}: {
  readonly variant: "solid" | "tile" | "text";
  readonly size?: "md" | "sm";
  readonly href?: string;
  readonly onClick?: MouseEventHandler<HTMLElement>;
  readonly icon?: ReactNode;
  readonly ariaLabel?: string;
  readonly className?: string;
  readonly pressed?: boolean;
  readonly children?: ReactNode;
}) {
  const cls = ["jh-btn", `jh-btn-${variant}`, size === "sm" ? "jh-btn-sm" : "", icon && !children ? "is-icon" : "", className ?? ""].filter(Boolean).join(" ");
  const inner = (
    <>
      {icon}
      {children}
    </>
  );
  if (href) {
    const external = /^https?:/.test(href);
    return (
      <a className={cls} href={href} aria-label={ariaLabel} onClick={onClick} rel={external ? "noopener" : undefined}>
        {inner}
      </a>
    );
  }
  return (
    <button type="button" className={cls} aria-label={ariaLabel} aria-pressed={pressed} onClick={onClick}>
      {inner}
    </button>
  );
}
