/**
 * The page's one live state, so the island at the top answers what the visitor does. Every demo claims the island for its
 * own section with a Show: the kind, and where the flow says so the line it heard or says, its question, the thread tiles,
 * the foot's figure and the clock. The hero's blob claims it for the hero. The section spy writes the section in view, and
 * a claim shows only while its own section is in view (`resolveShow`), so the island never wears another demo's state. A
 * section whose demo has claimed nothing wears its own kind with nothing heard. A tiny external store, so the top engine's
 * rAF never re-renders the page: only a change notifies.
 */
import { useSyncExternalStore } from "react";
import type { DeskKind } from "./phase";

/** A thread tile on the island: the app's tile name and where its thread stands. */
export interface Tile {
  readonly name: string;
  readonly state: "working" | "asks" | "done" | "stopped";
}

/** What a demo puts on the island. Every string is a deck, island or rail string, or a cut of one. */
export interface Show {
  readonly kind: DeskKind;
  /** The island's big line: what it heard, or what it says. Absent, the island has heard nothing yet. */
  readonly line?: string;
  /** Speaking only: the island asks its own question (the Slack send) with Allow and Deny. */
  readonly ask?: boolean;
  /** The asking demo's own answer, so the island's Allow and Deny decide it too; absent, they are only drawn. */
  readonly answer?: (yes: boolean) => void;
  /** Acting: the thread tiles. */
  readonly tiles?: readonly Tile[];
  /** The foot's figure (`7.2 min · $0.36`) and the meter beside it, 0 to 1. */
  readonly foot?: string;
  readonly meter?: number;
  /** The clock: the asleep island's big line, and the foot's clock. */
  readonly clock?: string;
}

interface LiveState {
  /** The kind the island wears, as the top engine resolved it (the menu bar names it). */
  readonly kind: DeskKind;
  /** The section in view ("" over the hero). */
  readonly section: string;
  /** Each owner's claim: a section id, or "hero". */
  readonly claims: Readonly<Record<string, Show>>;
}

const SERVER: LiveState = { kind: "asleep", section: "", claims: {} };
let state: LiveState = SERVER;
const subs = new Set<() => void>();

function emit(): void {
  for (const cb of subs) cb();
}

export function getLive(): LiveState {
  return state;
}

export function setLive(patch: Partial<Pick<LiveState, "kind" | "section">>): void {
  if ((patch.kind === undefined || patch.kind === state.kind) && (patch.section === undefined || patch.section === state.section)) return;
  state = { ...state, ...patch };
  emit();
}

function same(a: Show | undefined, b: Show): boolean {
  if (!a) return false;
  return a.kind === b.kind && a.line === b.line && a.ask === b.ask && a.answer === b.answer && a.foot === b.foot && a.meter === b.meter && a.clock === b.clock && JSON.stringify(a.tiles) === JSON.stringify(b.tiles);
}

/** A demo (or the hero) puts its moment on the island; it shows while the owner's section is in view. */
export function claim(owner: string, show: Show): void {
  if (same(state.claims[owner], show)) return;
  state = { ...state, claims: { ...state.claims, [owner]: show } };
  emit();
}

export function subscribeLive(cb: () => void): () => void {
  subs.add(cb);
  return () => {
    subs.delete(cb);
  };
}

export function useLive(): LiveState {
  return useSyncExternalStore(subscribeLive, getLive, () => SERVER);
}

/** What the island wears: the claim of the section in view, else that section's own kind with nothing heard, else the hero's. */
export function resolveShow(l: LiveState, sectionKind: Readonly<Record<string, DeskKind>>): Show {
  if (l.section) return l.claims[l.section] ?? { kind: sectionKind[l.section] ?? "listening" };
  return l.claims["hero"] ?? { kind: "asleep" };
}

/**
 * The page's faces take turns to glint (lib/eyes.ts TWINKLE.page): the hero, every demo blob and the island share the last
 * glint's time, so two faces never flare together. A face's own clock asks for a turn and waits when it is refused; an
 * event (eyes opening, what it loves lighting up) `insists` and takes the turn anyway. `now` in ms (performance.now).
 */
let lastGlint = -Infinity;
export function glintTurn(now: number, pageGap: number, insist = false): boolean {
  if (!insist && now - lastGlint < pageGap) return false;
  lastGlint = now;
  return true;
}
