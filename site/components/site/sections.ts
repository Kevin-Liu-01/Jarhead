import { COSTS, HANDS, INSTALL, NUMBERS, RAILS, SAY, SLEEP, THREADS, WAKE } from "@/content/deck";
import type { DeskKind } from "@/lib/phase";

/**
 * The page's sections in reading order: the anchor id, the deck name the menu bar shows, the kind the island wears while
 * the section is in view and its demo has claimed nothing yet (lib/live.ts), and the phase tone its plate's field is
 * dithered in. Read by
 * the server page, the menu bar and the top engine (a client module, so nothing here may import a server-only file).
 */
export interface SectionMeta {
  readonly id: string;
  readonly name: string;
  readonly kind: DeskKind;
  readonly tone: `--jh-${string}`;
}

export const SECTIONS: readonly SectionMeta[] = [
  { id: "wake", name: WAKE.name, kind: "asleep", tone: "--jh-listening" },
  { id: "say", name: SAY.name, kind: "listening", tone: "--jh-thinking" },
  { id: "threads", name: THREADS.name, kind: "listening", tone: "--jh-acting" },
  { id: "hands", name: HANDS.name, kind: "listening", tone: "--jh-accent" },
  { id: "rails", name: RAILS.name, kind: "listening", tone: "--jh-speaking" },
  { id: "sleep", name: SLEEP.name, kind: "asleep", tone: "--jh-asleep" },
  { id: "numbers", name: NUMBERS.name, kind: "listening", tone: "--jh-connecting" },
  { id: "costs", name: COSTS.name, kind: "listening", tone: "--jh-listening" },
  { id: "install", name: INSTALL.name, kind: "asleep", tone: "--jh-titanium" },
];

export const SECTION_KIND: Readonly<Record<string, DeskKind>> = Object.fromEntries(SECTIONS.map((s) => [s.id, s.kind]));

export function section(id: string): SectionMeta {
  const s = SECTIONS.find((x) => x.id === id);
  if (!s) throw new Error(`no section ${id}`);
  return s;
}
