import type { ReactElement } from "react";

/**
 * A light/dark capture pair: both files as lazy <img>s, html[data-theme] shows one (globals.css: .shot-dark / .shot-light).
 * A lazy image with no box never loads, so only the shown file is fetched, the choice is the attribute's from the first
 * paint (the boot script stamps it before the body parses), and a toggle fetches the other file only then. Nothing here
 * runs on the client, so a stored theme that disagrees with the system never paints the other theme's Console first.
 */
export function ThemeImage({
  dark,
  light,
  width,
  height,
}: {
  readonly dark: { readonly src: string; readonly alt: string };
  readonly light: { readonly src: string; readonly alt: string };
  readonly width: number;
  readonly height: number;
}): ReactElement {
  return (
    <>
      <img className="shot-dark" src={dark.src} alt={dark.alt} width={width} height={height} decoding="async" loading="lazy" />
      <img className="shot-light" src={light.src} alt={light.alt} width={width} height={height} decoding="async" loading="lazy" />
    </>
  );
}
