/**
 * The page's one live state: the kind the island wears, the section in view and whether the page is still. Written by the
 * top engine (components/site/Top.tsx) and the section spy (components/site/SectionSpy.tsx); read by the menu bar and the
 * hero's blob through `useLive`. A tiny external store so the engine's rAF never re-renders the page: only a kind change or
 * a section change notifies.
 */
import { useSyncExternalStore } from "react";
import type { DeskKind } from "./phase";

interface LiveState {
  readonly kind: DeskKind;
  readonly section: string;
  readonly still: boolean;
}

const SERVER: LiveState = { kind: "listening", section: "", still: false };
let state: LiveState = SERVER;
const subs = new Set<() => void>();

export function getLive(): LiveState {
  return state;
}

export function setLive(patch: Partial<LiveState>): void {
  let changed = false;
  for (const k of Object.keys(patch) as (keyof LiveState)[]) {
    if (patch[k] !== undefined && patch[k] !== state[k]) changed = true;
  }
  if (!changed) return;
  state = { ...state, ...patch };
  for (const cb of subs) cb();
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

/** The engine registers this once it is mounted; a press on the hero's blob calls it. */
export const liveActions: { advance: () => void } = {
  advance: () => undefined,
};
