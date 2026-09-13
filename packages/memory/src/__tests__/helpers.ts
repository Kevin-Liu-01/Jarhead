import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LedgerRow, MemoryItem, TranscriptItem } from "@jarhead/protocol";
import type { Candidate, ExtractInput } from "../types.ts";
import type { Extractor } from "../extract/extractor.ts";

/** The fixture's session start (local 2026-09-11 10:00); every row is T0 + an offset. */
export const T0 = new Date(2026, 8, 11, 10, 0, 0).getTime();

export function fresh(): string {
  return mkdtempSync(join(tmpdir(), "jh-memory-"));
}

/** An injectable clock: `now()` reads it, `tick` advances it. */
export function clock(start = T0 + 100_000): { now: () => number; tick: (ms: number) => void; set: (at: number) => void } {
  let t = start;
  return { now: () => t, tick: (ms) => (t += ms), set: (at) => (t = at) };
}

/** Deterministic ids: m_0001, m_0002, … */
export function ids(prefix = "m"): () => string {
  let n = 0;
  return () => `${prefix}_${String(++n).padStart(4, "0")}`;
}

function tItem(id: string, speaker: "kevin" | "jarhead", text: string, at: number): TranscriptItem {
  return { id, speaker, text, startMs: 0, endMs: 1000, at, final: true };
}
export const heard = (at: number, text: string, id = `h${at}`): LedgerRow => ({ at, type: "heard", item: tItem(id, "kevin", text, at) });
export const said = (at: number, text: string, id = `s${at}`): LedgerRow => ({ at, type: "said", item: tItem(id, "jarhead", text, at) });

/** Stands in for the runner's redactor: known key shapes become the mark. */
export const redactFake = (s: string): string => s.replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, "[redacted secret]").replace(/\bghp_[A-Za-z0-9]{30,}\b/g, "[redacted secret]");

const here = dirname(fileURLToPath(import.meta.url));

export function fixtureRows(name = "session-1.jsonl"): LedgerRow[] {
  return readFileSync(join(here, "fixtures", name), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as LedgerRow);
}

export function fixtureJson<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(here, "fixtures", name), "utf8")) as T;
}

export function item(over: Partial<MemoryItem> & { readonly id: string; readonly text: string }): MemoryItem {
  const at = over.createdAt ?? T0;
  return {
    kind: "fact",
    subjects: [],
    confidence: 0.8,
    importance: 0.6,
    createdAt: at,
    lastSeenAt: over.lastSeenAt ?? at,
    seenCount: 1,
    sources: [{ at, type: "heard" }],
    state: "live",
    origin: "extracted",
    ...over,
  };
}

/** A canned extractor: returns the given candidates (per call, cycling the last), records every input it saw. */
export class ScriptedExtractor implements Extractor {
  readonly kind = "responses" as const;
  readonly inputs: ExtractInput[] = [];
  constructor(private readonly script: readonly (readonly Candidate[])[] | ((input: ExtractInput) => Candidate[])) {}
  async extract(input: ExtractInput): Promise<Candidate[]> {
    this.inputs.push(input);
    if (typeof this.script === "function") return this.script(input);
    const i = Math.min(this.inputs.length - 1, this.script.length - 1);
    return [...(this.script[i] ?? [])];
  }
}

export interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/** A fetch seam that records calls and answers from a handler (or a queue of responses). */
export function fakeFetch(answer: (call: FetchCall, n: number) => Response | Promise<Response>): { readonly fetch: typeof fetch; readonly calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    const h = init?.headers;
    if (h && !(h instanceof Headers) && !Array.isArray(h)) for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = String(v);
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call = { url, method: init?.method ?? "GET", headers, body };
    calls.push(call);
    return answer(call, calls.length);
  }) as typeof fetch;
  return { fetch: f, calls };
}

export function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(typeof obj === "string" ? obj : JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

/** Unit vectors with a chosen cosine to [1, 0, 0]: [c, sqrt(1 − c²), 0]. */
export function atCosine(c: number): number[] {
  return [c, Math.sqrt(Math.max(0, 1 - c * c)), 0];
}
