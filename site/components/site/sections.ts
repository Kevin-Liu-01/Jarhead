import { COSTS, HANDS, INSTALL, NUMBERS, RAILS, SAY, SLEEP, THREADS, WAKE } from "@/content/deck";
import type { DeskKind } from "@/lib/phase";

/**
 * The page's sections in reading order: the anchor id, the word the menu bar's nav shows (the deck block's own name), the
 * kind the sticky island wears while the section is in view (Sleep plays asleep, then the alarm that still rings), and the
 * tone its full-bleed ground is dithered in at low intensity. The picture sits on the side the field rises behind. Read by
 * the server page, the menu bar and the island's timeline (a client module, so nothing here may import a server-only file).
 */
export interface SectionMeta {
  readonly id: string;
  readonly name: string;
  readonly kind: DeskKind;
  /** The tone token the ground is dithered in. */
  readonly tone: `--jh-${string}`;
  /** Which side the picture stands on at desktop widths; the words take the other. */
  readonly pic: "left" | "right";
}

export const SECTIONS: readonly SectionMeta[] = [
  { id: "wake", name: WAKE.name, kind: "listening", tone: "--jh-listening", pic: "right" },
  { id: "say", name: SAY.name, kind: "thinking", tone: "--jh-thinking", pic: "left" },
  { id: "threads", name: THREADS.name, kind: "acting", tone: "--jh-acting", pic: "right" },
  { id: "hands", name: HANDS.name, kind: "acting", tone: "--jh-accent", pic: "left" },
  { id: "rails", name: RAILS.name, kind: "speaking", tone: "--jh-speaking", pic: "right" },
  { id: "sleep", name: SLEEP.name, kind: "asleep", tone: "--jh-asleep", pic: "left" },
  { id: "numbers", name: NUMBERS.name, kind: "listening", tone: "--jh-connecting", pic: "right" },
  { id: "costs", name: COSTS.name, kind: "listening", tone: "--jh-listening", pic: "left" },
  { id: "install", name: INSTALL.name, kind: "listening", tone: "--jh-titanium", pic: "right" },
];

export const SECTION_KIND: Readonly<Record<string, DeskKind>> = Object.fromEntries(SECTIONS.map((s) => [s.id, s.kind]));

export function section(id: string): SectionMeta {
  const s = SECTIONS.find((x) => x.id === id);
  if (!s) throw new Error(`no section ${id}`);
  return s;
}
