/**
 * The page's one live state: the phase the island is cycling through (the kind and the wake beat), whether the
 * island is open, and the section in view. Written by the top engine (components/console/Top.tsx) and the left
 * rail; read by the title bar, the Session card, the composer and the blob through `useLive`. A tiny external
 * store so the engine's rAF never re-renders the page: only a kind change or a section change notifies.
 */
import { useSyncExternalStore } from "react";
import type { BlobFrame } from "./blob";
import type { DeskKind } from "./phase";

export type Beat = "none" | "gate" | "heard";

export interface LiveState {
  readonly kind: DeskKind;
  readonly beat: Beat;
  readonly open: boolean;
  readonly section: string;
  readonly still: boolean;
}

const SERVER: LiveState = { kind: "listening", beat: "none", open: false, section: "", still: false };
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

/** The phase word's kind: the wake beat's gate is asleep, its heard beat is listening. */
export function shownKind(s: Pick<LiveState, "kind" | "beat">): DeskKind {
  return s.beat === "gate" ? "asleep" : s.beat === "heard" ? "listening" : s.kind;
}

/** The engine registers these once it is mounted; the blob and the rail call them. */
export const liveActions: { pick: (k: DeskKind) => void; advance: () => void; onBlobFrame: (f: BlobFrame) => void } = {
  pick: () => undefined,
  advance: () => undefined,
  onBlobFrame: () => undefined,
};
