/**
 * What passes between the glass Install (InstallKey) and the hero's blob (HeroCharacter), as window events: the blob
 * loves the button. The key says when it is lit (hovered, focused by keyboard, touched, or answering the blob's first
 * look) and where its centre is on the screen, and when it is pressed; the blob says when it first looks at it.
 */

/** The glass tells the hero's blob what is happening to it: lit or not (and where it is), and pressed. */
export const GLASS_EVENT = "jh:glass";
export type GlassDetail = { readonly kind: "lit"; readonly on: boolean; readonly at: readonly [number, number] } | { readonly kind: "press" };
/** The hero's blob has arrived and looks at the glass once: the key lights in reply. */
export const GLANCE_EVENT = "jh:glance";

export function tellGlass(d: GlassDetail): void {
  window.dispatchEvent(new CustomEvent<GlassDetail>(GLASS_EVENT, { detail: d }));
}
