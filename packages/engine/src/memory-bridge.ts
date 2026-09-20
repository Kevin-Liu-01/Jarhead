import { join } from "node:path";
import { logger, type Ledger } from "@jarhead/core";
import { normalizeUtterance } from "@jarhead/brain";
import {
  ChatExtractor,
  KeywordEmbedder,
  LocalEmbedder,
  MemoryService,
  OpenAIEmbedder,
  ResponsesExtractor,
  RulesDecider,
  RulesExtractor,
  type Decider,
  type Embedder,
  type Extractor,
  type IngestOptions,
  type IngestResult,
  type RememberResult,
  type Rendered,
  pickMemoryModel,
  DEFAULT_MEMORY_MODEL,
} from "@jarhead/memory";
import type { EngineCommand, LedgerRow, LocalFlavor, MemoryItem, MemoryKind, MemoryState, MemorySummary, TranscriptItem } from "@jarhead/protocol";

/**
 * The engine's one door to @jarhead/memory: what Jarhead durably knows about Kevin.
 *
 * Everything here is off the voice loop by construction. Extraction runs from
 * `drain()` on the engine's tick, and only when the engine says the moment is quiet —
 * no session open, none opening, no pause held, no reconnect pending — one closed
 * CONVERSATION per tick (the chain a pause → resume → reconnect makes, keyed by its
 * root: 23 of 28 closes on 09-11 were pauses, and read segment by segment none of
 * those segments alone would clear the line gate), and only when it has at least
 * EXTRACT_MIN_KEVIN_LINES new Kevin lines since the store's watermark. Retrieval for
 * the brain races the memory package against RETRIEVE_RACE_MS so a slow embedding
 * never delays the first action. The spoken reflexes ("remember that …", "forget
 * that") cost nothing and need no brain. Memory never calls Codex: the extractor is a
 * Responses call on Kevin's OpenAI key (dollars, bounded by the caps), or rules when
 * there is no key — or, under `Settings.brain === "local"`, the brain's own model on the
 * server on this Mac (`ChatExtractor`) with a discovered embedding model (`LocalEmbedder`)
 * or keywords, so item text and closed conversations never leave the Mac. Memory follows
 * the SETTING, not the running brain: a fallback to OpenAI never re-routes memory text.
 * `relink()` rebuilds the service when that identity moves and `reembed` heals the
 * vectors at quiet ticks.
 *
 * Tests inject a FakeMemoryService through `EngineOptions.memory.service`; a store
 * that cannot start leaves memory off with one warning and the engine runs on.
 */

const log = logger("memory");

/** A closed conversation is read only when this many Kevin lines landed since its watermark (mirrors the package's MIN_NEW_KEVIN_LINES; the service gates again). */
export const EXTRACT_MIN_KEVIN_LINES = 4;
/** The brain's retrieval is bounded at this; past it the turn goes out without memory and the embedding lands in the cache for the next one. */
export const RETRIEVE_RACE_MS = 250;
/** "forget that" tombstones what was learned in this window (mirrors the package's FORGET_RECENT_MS). */
export const FORGET_RECENT_MS = 10 * 60_000;
/** Catch-up at start and `memory.run`: closed conversations of the last week, at most this many, one per quiet tick. */
export const CATCHUP_MAX = 10;
export const CATCHUP_WINDOW_MS = 7 * 24 * 3_600_000;
/** Consolidation (near-duplicates, decay to archived) is one pass a day, sliced across quiet ticks. */
export const CONSOLIDATE_EVERY_MS = 24 * 3_600_000;

/**
 * Kevin's spoken verbs, judged on the normalised utterance (lowercase, the wake word
 * and "please" gone, no trailing punctuation). "forget it" is deliberately absent — it
 * is how he says "never mind", not an order about his memory. "remember" needs its
 * connective ("remember that …", "keep in mind …", "note that …"): "remember to email
 * Ben" is a task and "remember the last time" a recollection, neither a fact to keep.
 */
const FORGET_PLAIN = /^(?:forget (?:that|this|what i (?:just )?said|the last (?:thing|bit))|don'?t remember (?:that|this)|scratch that from (?:your )?memory|don'?t (?:save|keep|store) that)\b/;
const REMEMBER_PLAIN = /^(?:remember that|keep in mind(?: that)?|note that)\s+\S.{7,}/;
/** The clause to keep, from the ORIGINAL text so names keep their case; the trailing full stop goes. */
const REMEMBER_CLAUSE = /\b(?:remember that|keep in mind(?: that)?|note that)\s+(.{8,200}?)[.!?]*\s*$/i;

/**
 * The memory service as the bridge uses it — the public surface of the package's
 * MemoryService (assigning the real one below is the type check), and what a test's
 * FakeMemoryService implements.
 */
export interface MemoryServiceLike {
  /** The store, for the extraction watermark per conversation (the bridge's cheap gate before a run). */
  readonly store?: { watermark(sessionId: string): { readonly upToAt: number } | undefined };
  /** Read a conversation's ledger rows past its watermark; idempotent — a second call over the same rows is skipped ("nothing-new"). */
  ingestSession(sessionId: string, rows: readonly LedgerRow[], opts?: IngestOptions): Promise<IngestResult>;
  /** Embed a line Kevin just said so the delegation-time query is a cache hit (QUERY_LRU); never throws. */
  prime(text: string): Promise<void>;
  retrieveForBrain(query: string, opts?: { readonly signal?: AbortSignal; readonly timeoutMs?: number }): Promise<Rendered>;
  retrieveForVoice(): Rendered;
  /** An explicit "remember that …" (origin kevin) or a Console/CLI add; undefined = refused (a secret shape, the redactor changed it). */
  remember(text: string, kind?: MemoryKind, origin?: "extracted" | "kevin" | "tool"): Promise<RememberResult | undefined>;
  /** Tombstone every live item said in the last `ms` (and write the exclusion window); returns how many. */
  forgetRecent(ms?: number, sessionId?: string): number;
  forget(id: string, by: "kevin" | "reflex" | "cli"): boolean;
  restore(id: string): boolean;
  edit(id: string, text: string, kind?: MemoryKind): boolean;
  list(state?: MemoryState | "all", limit?: number): MemoryItem[];
  search(query: string, limit?: number, state?: MemoryState | "all"): Promise<MemoryItem[]>;
  summary(): Omit<MemorySummary, "enabled" | "pending">;
  /** One slice of housekeeping (≤ 200 pair checks); the cursor carries across calls; `done` ends the pass. */
  consolidateStep(opts?: { readonly signal?: AbortSignal }): Promise<{ readonly merged: number; readonly archived: number; readonly done: boolean }>;
  /** Live items with no vector in the current embedding space, `limit` at a time; returns how many were embedded, 0 when every item has one. */
  reembed(limit?: number): Promise<number>;
  flush(): void;
}

/** The local server memory runs on under `Settings.brain === "local"`: the brain's model reads conversations, the embedding model (when one is pulled) matches items. */
export interface LocalMemoryTarget {
  readonly flavor: LocalFlavor;
  readonly baseUrl: string;
  /** The brain's model id, verbatim (Kevin's pick or the engine's best fit); "" when none is known yet — rules read then. */
  readonly chatModel: string;
  /** The model's trained window, when discovery knows it; sizes the extractor's slice. */
  readonly chatContext?: number;
  /** The model carries Ollama's `thinking` capability: the extractor asks for no reasoning and leaves the JSON room to finish. */
  readonly thinking?: boolean;
  /** First of EMBED_PREFERENCE on the server; absent = keyword matching. */
  readonly embedModel?: string;
}

/** Test seams: a whole service, or the parts the bridge would otherwise build from the package. */
export interface MemoryBridgeSeams {
  readonly service?: MemoryServiceLike;
  readonly embedder?: Embedder;
  readonly extractor?: Extractor;
  readonly decider?: Decider;
  readonly fetchImpl?: typeof fetch;
}

export interface MemoryBridgeOptions extends MemoryBridgeSeams {
  readonly stateDir: string;
  readonly ledger: Ledger;
  readonly now: () => number;
  /** The runner's public redactor (values and shapes); a line that changed is dropped before any extractor or embedder sees it. */
  readonly redact: (s: string) => string;
  /** Kevin's OpenAI key, read live (a `config.set-secrets` changes it). */
  readonly apiKey: () => string | undefined;
  /** The token Kevin set for the brain (JARHEAD_BRAIN_API_KEY, an LM Studio bearer), read live; it rides on every call to the local server, as the brain's own do. */
  readonly brainApiKey: () => string | undefined;
  /** `JARHEAD_MEMORY_MODEL`, read live; undefined = the package's default (a mini-class Responses id the doctor picks). */
  readonly model: () => string | undefined;
  /** `Settings.memory !== false`, read live: off means no extraction, no injection, no embedding call, no memory.* row. */
  readonly enabled: () => boolean;
  /**
   * Where memory runs, read live. A target: `Settings.brain === "local"` and the server answers —
   * memory runs there and the OpenAI branch is skipped even with a key. `"offline"`: the setting is
   * `local` but nothing answers — keywords and rules, nothing leaves. undefined: every other kind.
   */
  readonly local: () => LocalMemoryTarget | "offline" | undefined;
  /** The snapshot wants redrawing (counts, pending, the last run). */
  readonly onChange: () => void;
  /** The user's name (release F1), read live: the extractor's subject, the transcript's label, the voice block's header. A change relinks. */
  readonly userName?: (() => string) | undefined;
}

type MemoryCommand = Extract<EngineCommand, { type: `memory.${string}` }>;

/** How long the start waits for the key's model list before running the package default. */
const PICK_TIMEOUT_MS = 8_000;

export class MemoryBridge {
  private service: MemoryServiceLike | undefined;
  /** Closed conversations (chain roots) waiting for a quiet tick, oldest first. */
  private readonly pending = new Set<string>();
  /** Conversations Kevin asked to read now (`memory.run`): the line gate is skipped for them. */
  private readonly forced = new Set<string>();
  private running: Promise<void> | undefined;
  /** When this process last read a conversation (the gate's fallback when the service exposes no store). */
  private readonly ran = new Map<string, number>();
  private lastRunAt: number | undefined;
  private lastRun: MemorySummary["lastRun"];
  private budgetUsed = { brain: 0, voice: 0 };
  private lastUsedIds: readonly string[] = [];
  private caughtUp = false;
  /** A consolidation pass is under way (sliced across quiet ticks) until the service says done; the next starts CONSOLIDATE_EVERY_MS later. */
  private consolidating = false;
  private consolidateAt = 0;
  /** The extractor model the key's own list names when JARHEAD_MEMORY_MODEL is not set (one free GET at start). */
  private pickedModel: string | undefined;
  /** Whether the key's list was asked yet (once per process; a wrong default would fall to rules on every run). */
  private pickedOnce = false;
  /** The build or relink under way; `ready()` waits on it. */
  private building: Promise<void> | undefined;
  /** Which providers the service is built over ("local|url|embed|chat", "openai|model", "keyword"); relink() rebuilds only when it moves. */
  private identity: string | undefined;
  /** A relink changed the embedding space: `reembed()` runs at quiet ticks until it returns 0. */
  private reembedPending = false;
  /** A reembed slice is the run in flight (not a conversation: the summary's `pending` leaves it out). */
  private reembedding = false;

  constructor(private readonly opts: MemoryBridgeOptions) {
    if (opts.service) {
      this.service = opts.service;
      return;
    }
    this.building = this.start().finally(() => {
      this.building = undefined;
    });
  }

  /** Build the service (once) over the providers the settings name and read what the ledger holds; a store that cannot start is one warning. */
  private async start(): Promise<void> {
    const target = this.opts.local();
    try {
      this.service = await this.build(target);
      this.identity = this.identityOf(target);
    } catch (e) {
      // The store lives under <stateDir>/memory; a dir that cannot be made or read is one warning, not a dead engine.
      log.warn(`could not start the memory store: ${(e as Error).message.split("\n")[0]}; memory is off until it does`);
      return;
    }
    const s = this.service.summary();
    log.info(`store at ${join(this.opts.stateDir, "memory")} · ${s.embeddings} matching${s.embeddingModel ? ` (${s.embeddingModel})` : ""} · ${s.count} live`);
    this.catchUp();
  }

  /** One free GET /v1/models: the mini-class Responses id this key lists, or nothing (the package default runs, and the doctor says what to pin). */
  private async pickModel(): Promise<void> {
    const key = this.opts.apiKey();
    if (!key) return;
    this.pickedOnce = true;
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    try {
      const r = await fetchImpl("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(PICK_TIMEOUT_MS) });
      if (!r.ok) {
        log.warn(`model list answered ${r.status}; the extractor runs ${DEFAULT_MEMORY_MODEL} (pin JARHEAD_MEMORY_MODEL to choose)`);
        return;
      }
      const body = (await r.json()) as { data?: readonly { id?: unknown }[] };
      const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
      this.pickedModel = pickMemoryModel(ids);
      if (this.pickedModel) log.info(`extractor model ${this.pickedModel} (picked from the key's ${ids.length} models; JARHEAD_MEMORY_MODEL overrides)`);
      else log.warn(`the key lists no mini-class Responses model; the extractor runs ${DEFAULT_MEMORY_MODEL}`);
    } catch (e) {
      log.warn(`model list unavailable (${(e as Error).message.split("\n")[0]}); the extractor runs ${DEFAULT_MEMORY_MODEL}`);
    }
  }

  /** Resolves once the service exists (after the model pick when one runs, after a relink's rebuild). */
  ready(): Promise<void> {
    return this.building ?? Promise.resolve();
  }

  /** The providers a target names, as one string: what `relink()` compares. */
  private identityOf(target: LocalMemoryTarget | "offline" | undefined): string {
    // The user's name is part of every identity: the extractors and the renderer are built with it, so a rename rebuilds them.
    const who = `|who=${this.userName()}`;
    if (target === "offline") return `keyword${who}`;
    // The token's presence is part of the identity: a `config.set-secrets` that adds one relinks onto a server that wanted it.
    if (target) return `local|${target.baseUrl}|${target.embedModel ?? ""}|${target.chatModel}|${this.opts.brainApiKey() ? "token" : ""}${who}`;
    return this.opts.apiKey() ? `openai|${this.opts.model() ?? ""}${who}` : `keyword${who}`;
  }

  /** The effective name as the engine reads it; "Kevin" when no getter is wired (tests). */
  private userName(): string {
    return this.opts.userName?.() || "Kevin";
  }

  /**
   * The store over the providers the settings name. Under `local` with a reachable server: the
   * discovered embedding model (probed once for its dims; a probe that fails is keywords with a
   * warning) and the brain's model as extractor and decider in Chat Completions JSON mode, both
   * carrying the brain's token when Kevin set one (an LM Studio bearer) — the OpenAI branch is
   * skipped even with a key. Under `local` with nothing answering: keywords and
   * rules. Otherwise Kevin's OpenAI key when there is one (embeddings and the Responses extractor,
   * which is also the decider — the key's model list is asked once when no model is pinned),
   * rules and keywords when there is not.
   */
  private async build(target: LocalMemoryTarget | "offline" | undefined): Promise<MemoryServiceLike> {
    const dir = join(this.opts.stateDir, "memory");
    const fetchImpl = this.opts.fetchImpl;
    let embedder: Embedder;
    let extractor: Extractor;
    let decider: Decider;
    let maxChars: number | undefined;
    const userName = this.userName();
    if (target === "offline") {
      embedder = this.opts.embedder ?? new KeywordEmbedder();
      extractor = this.opts.extractor ?? new RulesExtractor(userName);
      decider = this.opts.decider ?? new RulesDecider();
    } else if (target) {
      // The brain's token (an LM Studio bearer) goes with every call, or a token-protected server would give the brain and refuse memory.
      const key = this.opts.brainApiKey();
      const auth = key ? { apiKey: key } : {};
      if (this.opts.embedder) embedder = this.opts.embedder;
      else if (target.embedModel) {
        try {
          embedder = await LocalEmbedder.probe({ flavor: target.flavor, baseUrl: target.baseUrl, model: target.embedModel, ...auth, ...(fetchImpl ? { fetchImpl } : {}) });
        } catch (e) {
          log.warn(`local embeddings (${target.embedModel}) did not answer the probe: ${(e as Error).message.split("\n")[0]}; matching by keywords until they do`);
          embedder = new KeywordEmbedder();
        }
      } else embedder = new KeywordEmbedder();
      const chat =
        target.chatModel && !this.opts.extractor
          ? new ChatExtractor({
              baseUrl: target.baseUrl,
              model: target.chatModel,
              userName,
              ...(target.chatContext !== undefined ? { contextLength: target.chatContext } : {}),
              ...(target.thinking !== undefined ? { thinking: target.thinking } : {}),
              ...auth,
              ...(fetchImpl ? { fetchImpl } : {}),
            })
          : undefined;
      extractor = this.opts.extractor ?? chat ?? new RulesExtractor(userName);
      decider = this.opts.decider ?? chat ?? new RulesDecider();
      maxChars = chat?.maxChars;
    } else {
      const apiKey = this.opts.apiKey;
      const withKey = Boolean(apiKey());
      // With a key and no pinned model, ask the key which mini-class Responses model it lists before the
      // extractor is built (a wrong default would fall to rules on every run) — at most PICK_TIMEOUT_MS, once.
      if (withKey && !this.opts.model() && !this.opts.extractor && !this.pickedOnce) await this.pickModel();
      const model = this.opts.model() ?? this.pickedModel;
      embedder = this.opts.embedder ?? (withKey ? new OpenAIEmbedder({ apiKey, ...(fetchImpl ? { fetchImpl } : {}) }) : new KeywordEmbedder());
      const responses = withKey && !this.opts.extractor ? new ResponsesExtractor({ apiKey, userName, ...(model ? { model } : {}), ...(fetchImpl ? { fetchImpl } : {}) }) : undefined;
      extractor = this.opts.extractor ?? responses ?? new RulesExtractor(userName);
      decider = this.opts.decider ?? responses ?? new RulesDecider();
    }
    // The assignment to MemoryServiceLike is the check that the package still has the shape the bridge calls.
    const service: MemoryServiceLike = new MemoryService({
      dir,
      now: this.opts.now,
      embedder,
      extractor,
      decider,
      redact: this.opts.redact,
      userName,
      retrieveTimeoutMs: RETRIEVE_RACE_MS,
      ...(maxChars !== undefined ? { maxChars } : {}),
      // The audit rows carry ids only (protocol LedgerRow memory.*); the words live in the store.
      onRow: (row) => this.opts.ledger.append(row),
    });
    return service;
  }

  /**
   * The brain setting moved (a restart, a pick): when the providers' identity changed — local ↔
   * OpenAI ↔ keywords, another server, another embedding or chat model — wait for the run in
   * flight, flush, rebuild the service over the same <stateDir>/memory and schedule `reembed()` at
   * quiet ticks until it returns 0. Unchanged → nothing. A test's whole fake service is never rebuilt.
   */
  async relink(): Promise<void> {
    if (this.opts.service) return;
    await this.ready();
    const target = this.opts.local();
    const id = this.identityOf(target);
    if (this.service && id === this.identity) return;
    this.building = (async () => {
      await this.running?.catch(() => undefined);
      this.service?.flush();
      try {
        this.service = await this.build(target);
      } catch (e) {
        log.warn(`memory could not move to ${id.split("|")[0]}: ${(e as Error).message.split("\n")[0]}; the store stays as it was`);
        return;
      }
      this.identity = id;
      this.reembedPending = true;
      const s = this.service.summary();
      const where = target && target !== "offline" ? `extractor ${target.chatModel || "rules"} on ${target.baseUrl}` : target === "offline" ? "rules (the local server is down)" : this.opts.apiKey() ? "the Responses extractor" : "rules";
      log.info(`memory now ${s.embeddings} matching${s.embeddingModel ? ` (${s.embeddingModel}, ${s.embeddingDims ?? "?"} dims)` : ""} · ${where}; vectors heal at quiet ticks`);
      this.catchUp();
      this.opts.onChange();
    })().finally(() => {
      this.building = undefined;
    });
    return this.building;
  }

  /** The conversation a session belongs to: its chain's root (itself when it resumed nothing the ledger knows). */
  private rootOf(sessionId: string): string {
    try {
      return this.opts.ledger.chainRootOf(sessionId) ?? sessionId;
    } catch {
      return sessionId;
    }
  }

  /**
   * The closed conversations of the last week, newest first: one entry per chain, closed
   * when every member is (a member without a closed row is the open one — or a lost one
   * the walk closed at the next start), trashed chains left out.
   */
  private closedChains(): { root: string; closedAt: number }[] {
    let sessions;
    try {
      sessions = this.opts.ledger.sessions();
    } catch (e) {
      log.debug(`ledger walk skipped: ${(e as Error).message}`);
      return [];
    }
    const since = this.opts.now() - CATCHUP_WINDOW_MS;
    const byRoot = new Map<string, { closedAt: number; open: boolean; trashed: boolean }>();
    for (const s of sessions) {
      const root = this.rootOf(s.id);
      const cur = byRoot.get(root) ?? { closedAt: 0, open: false, trashed: false };
      if (s.closedAt === undefined) cur.open = true;
      else cur.closedAt = Math.max(cur.closedAt, s.closedAt);
      if (s.state === "trashed") cur.trashed = true;
      byRoot.set(root, cur);
    }
    const out: { root: string; closedAt: number }[] = [];
    for (const [root, c] of byRoot) if (!c.open && !c.trashed && c.closedAt >= since) out.push({ root, closedAt: c.closedAt });
    return out.sort((a, b) => b.closedAt - a.closedAt);
  }

  /** Closed conversations of the last week the store never read, queued oldest first — only when the service can say which those are. */
  private catchUp(): void {
    const service = this.service;
    if (!service?.store || this.caughtUp) return;
    this.caughtUp = true;
    const todo: string[] = [];
    for (const c of this.closedChains()) {
      if (todo.length >= CATCHUP_MAX) break;
      if (service.store.watermark(c.root)) continue;
      todo.push(c.root);
    }
    for (const id of todo.reverse()) this.pending.add(id);
    if (todo.length) log.info(`${todo.length} closed conversation(s) never read; queued for a quiet moment`);
  }

  // ------------------------------------------------------------------ hooks

  /**
   * A final Kevin utterance landed. Two spoken reflexes need no brain: "remember that …"
   * → one item (origin kevin) and the toast "remembered"; "forget that" → every item
   * learned in the last ten minutes tombstoned (Forget is a state; nothing is deleted)
   * and the toast says how many. Anything else is embedded ahead of the delegation
   * that may follow, so the brain's retrieval is a cache hit — unless the redactor
   * changed it (a key read aloud never reaches the embeddings endpoint either).
   * Resolves to the toast, if any.
   */
  async onHeard(item: TranscriptItem, sessionId?: string): Promise<string | undefined> {
    if (item.speaker !== "kevin" || !this.opts.enabled()) return undefined;
    const service = this.service;
    if (!service) return undefined;
    const text = item.text.trim();
    if (!text) return undefined;
    const plain = normalizeUtterance(text);
    if (FORGET_PLAIN.test(plain)) {
      const n = service.forgetRecent(FORGET_RECENT_MS, sessionId);
      log.info(`forget that: ${n} item(s) tombstoned`);
      this.opts.onChange();
      return n > 0 ? `forgot ${n} ${n === 1 ? "memory" : "memories"}` : "nothing recent to forget";
    }
    if (REMEMBER_PLAIN.test(plain)) {
      const clause = REMEMBER_CLAUSE.exec(text)?.[1]?.trim();
      if (clause) return this.remember(clause);
    }
    if (this.opts.redact(text) !== text) return undefined;
    void service.prime(text).catch(() => undefined);
    return undefined;
  }

  /** An explicit add (spoken or pressed): the store classifies, redacts, refuses and dedupes it; the toast says what happened. */
  private async remember(text: string, kind?: MemoryKind): Promise<string> {
    const service = this.service;
    if (!service) return "memory is not available";
    try {
      const r = await service.remember(text, kind, "kevin");
      this.opts.onChange();
      if (!r) return "not remembered";
      return r.op === "noop" ? "already remembered" : "remembered";
    } catch (e) {
      log.warn(`remember failed: ${(e as Error).message}`);
      return "not remembered";
    }
  }

  /**
   * A session's rows are complete: its conversation (the chain it belongs to) is queued
   * for the next quiet tick. A pause and its resume queue the same conversation once;
   * the run, when it comes, reads the whole chain since the watermark.
   */
  sessionClosed(sessionId: string): void {
    if (!this.opts.enabled()) return;
    this.pending.add(this.rootOf(sessionId));
    this.opts.onChange();
  }

  /**
   * One unit of work per tick, and only when `quiet` (the engine: no session, none
   * opening, no pause held, no reconnect pending): the oldest pending conversation with
   * enough new Kevin lines across its chain is read; a run the embedder could not serve
   * is requeued (the service retries and lands by words after its DEFER_MAX_TRIES); with
   * nothing pending, one slice of consolidation when a pass is due. Never two runs at once.
   */
  drain(quiet: boolean): void {
    if (!quiet || this.running || !this.opts.enabled()) return;
    const service = this.service;
    if (!service) return;
    const next = this.pending.values().next();
    if (next.done) {
      // Nothing to read: heal the vectors after a relink first, then the daily consolidation slice.
      if (this.reembedPending) this.reembed(service);
      else this.consolidate(service);
      return;
    }
    const root = next.value;
    this.pending.delete(root);
    const force = this.forced.delete(root);
    const trashed = this.opts.ledger.conversation(root)?.state === "trashed";
    if (trashed) {
      log.debug(`${root} is trashed; not read`);
      this.opts.onChange();
      return;
    }
    const rows = this.chainRows(root);
    if (!force) {
      const fresh = this.newKevinLines(root, rows, service);
      if (fresh < EXTRACT_MIN_KEVIN_LINES) {
        log.debug(`${root}: ${fresh} new Kevin line(s) across the conversation, under ${EXTRACT_MIN_KEVIN_LINES}; not read`);
        this.opts.onChange();
        return;
      }
    }
    const t0 = this.opts.now();
    this.running = service
      .ingestSession(root, rows, { ...(force ? { force: true } : {}) })
      .then((r) => {
        if (r.status === "deferred") {
          // The candidates wait in the service; the next quiet tick tries the embedder again — forced,
          // so the line gate does not stop the continuation of a run that was already approved.
          this.pending.add(root);
          this.forced.add(root);
          log.info(`${root} deferred (try ${r.tries ?? "?"}): embeddings unavailable; again at a later quiet tick`);
          return;
        }
        if (r.status === "skipped") {
          log.debug(`${root} skipped (${r.reason ?? "?"})`);
          return;
        }
        // Rows past the watermark remain (the slice cap): the next quiet tick continues, forced.
        if (r.more) {
          this.pending.add(root);
          this.forced.add(root);
        }
        this.ran.set(root, t0);
        this.lastRunAt = this.opts.now();
        this.lastRun = { extractor: r.extractor ?? "rules", added: r.added, updated: r.updated, noop: r.noop, refused: r.refused, ms: r.ms };
        log.info(`learned ${r.added} · updated ${r.updated} · noop ${r.noop} · refused ${r.refused} · ${r.ms} ms · ${r.extractor ?? "rules"} (${root})`);
      })
      .catch((e: unknown) => log.warn(`run over ${root} failed: ${(e as Error).message}`))
      .finally(() => {
        this.running = undefined;
        this.opts.onChange();
      });
  }

  /** One `reembed` slice after a relink: the live items without a vector in the new space, ≤ 96 a tick, until none is left. */
  private reembed(service: MemoryServiceLike): void {
    this.reembedding = true;
    this.running = service
      .reembed()
      .then((n) => {
        if (n === 0) this.reembedPending = false;
        else log.info(`re-embedded ${n} item(s) in the new space`);
      })
      .catch((e: unknown) => log.debug(`re-embed slice failed: ${(e as Error).message}; again at a later quiet tick`))
      .finally(() => {
        this.running = undefined;
        this.reembedding = false;
        this.opts.onChange();
      });
  }

  /** One slice of a consolidation pass when one is due (a pass a day, the first at start), never overlapping a run. */
  private consolidate(service: MemoryServiceLike): void {
    const now = this.opts.now();
    if (!this.consolidating && now < this.consolidateAt) return;
    this.consolidating = true;
    this.running = service
      .consolidateStep()
      .then((r) => {
        if (r.merged || r.archived) log.info(`consolidated: ${r.merged} merged · ${r.archived} archived`);
        if (r.done) {
          this.consolidating = false;
          this.consolidateAt = this.opts.now() + CONSOLIDATE_EVERY_MS;
        }
      })
      .catch((e: unknown) => {
        this.consolidating = false;
        this.consolidateAt = this.opts.now() + CONSOLIDATE_EVERY_MS;
        log.debug(`consolidation failed: ${(e as Error).message}`);
      })
      .finally(() => {
        this.running = undefined;
      });
  }

  /** The whole conversation's rows (every session of the chain, oldest first; the ledger bounds it at CHAIN_ROWS_MAX). */
  private chainRows(root: string): LedgerRow[] {
    try {
      const chain = this.opts.ledger.readChain(root);
      if (chain.truncated) log.warn(`${root}: the conversation is longer than the ledger returns in one read; the oldest rows are not read`);
      if (chain.rows.length > 0) return chain.rows;
    } catch (e) {
      log.debug(`${root}: chain read failed (${(e as Error).message}); reading the session alone`);
    }
    return this.opts.ledger.readSession(root);
  }

  /** Kevin's lines across the conversation since the store's watermark for it (or since this process last read it). */
  private newKevinLines(root: string, rows: readonly LedgerRow[], service: MemoryServiceLike): number {
    const since = service.store?.watermark(root)?.upToAt ?? this.ran.get(root) ?? 0;
    let n = 0;
    for (const row of rows) if (row.type === "heard" && row.at > since && row.item?.text?.trim()) n++;
    return n;
  }

  // ------------------------------------------------------------- retrieval

  /**
   * The brain's block for one delegation (≤ BRAIN_MEMORY_TOKENS; the package caps it),
   * or undefined: memory off, the store empty, or the package slower than
   * RETRIEVE_RACE_MS — the turn goes out without it and the embedding lands in the
   * cache for the next one. Joins the delegator's `Promise.all` with the eyes.
   */
  async brainBlock(query: string, signal?: AbortSignal): Promise<string | undefined> {
    if (!this.opts.enabled()) return undefined;
    const service = this.service;
    const q = query.trim();
    if (!service || !q) return undefined;
    const race = new AbortController();
    const onAbort = (): void => race.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          race.abort();
          resolve(undefined);
        }, RETRIEVE_RACE_MS);
        timer.unref?.();
      });
      const r = await Promise.race([service.retrieveForBrain(q, { signal: race.signal, timeoutMs: RETRIEVE_RACE_MS }), timeout]);
      if (!r) {
        log.debug(`retrieval past ${RETRIEVE_RACE_MS} ms; the turn goes out without memory`);
        return undefined;
      }
      this.lastUsedIds = r.ids.slice(0, 8);
      this.budgetUsed = { ...this.budgetUsed, brain: r.tokens };
      this.opts.onChange();
      return r.text;
    } catch (e) {
      log.debug(`retrieval failed: ${(e as Error).message}`);
      return undefined;
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** The `# Kevin, in brief` section for a session's instructions (≤ VOICE_MEMORY_TOKENS), or undefined when off or empty. Synchronous: from the index. */
  voiceBlock(): string | undefined {
    if (!this.opts.enabled()) return undefined;
    const service = this.service;
    if (!service) return undefined;
    try {
      const r = service.retrieveForVoice();
      this.budgetUsed = { ...this.budgetUsed, voice: r.tokens };
      return r.text;
    } catch (e) {
      log.debug(`voice block failed: ${(e as Error).message}`);
      return undefined;
    }
  }

  /** The snapshot's `memory`: counts and mode from the store, pending and the last run from here. Never a vector. */
  summary(): MemorySummary {
    let base: Omit<MemorySummary, "enabled" | "pending"> | undefined;
    try {
      base = this.service?.summary();
    } catch (e) {
      log.debug(`summary failed: ${(e as Error).message}`);
    }
    const lastRunAt = this.lastRunAt ?? base?.lastRunAt;
    const lastRun = this.lastRun ?? base?.lastRun;
    const lastUsedIds = this.lastUsedIds.length ? this.lastUsedIds : base?.lastUsedIds;
    return {
      enabled: this.opts.enabled(),
      count: base?.count ?? 0,
      forgotten: base?.forgotten ?? 0,
      archived: base?.archived ?? 0,
      embeddings: base?.embeddings ?? (this.opts.local() || !this.opts.apiKey() ? "keyword" : "openai"),
      ...(base?.embeddingModel ? { embeddingModel: base.embeddingModel } : {}),
      ...(base?.embeddingDims ? { embeddingDims: base.embeddingDims } : {}),
      pending: this.pending.size + (this.running && !this.consolidating && !this.reembedding ? 1 : 0),
      ...(lastRunAt !== undefined ? { lastRunAt } : {}),
      ...(lastRun ? { lastRun } : {}),
      budgetUsed: this.budgetUsed,
      ...(lastUsedIds && lastUsedIds.length ? { lastUsedIds } : {}),
    };
  }

  // -------------------------------------------------------------- commands

  /**
   * The Console's and the CLI's verbs; the answer is the toast. Forget and Restore work
   * whatever the toggle says (they are Kevin's decisions about what is stored); Add and
   * Run need memory on. `quiet` is the engine's word on whether a run may start now.
   */
  async command(cmd: MemoryCommand, quiet: boolean): Promise<string> {
    const service = this.service;
    if (!service) return "memory is not available · the memory store did not start";
    switch (cmd.type) {
      case "memory.forget": {
        const ok = service.forget(cmd.id, "kevin");
        this.opts.onChange();
        return ok ? "forgotten · Restore brings it back" : "no such memory";
      }
      case "memory.restore": {
        const ok = service.restore(cmd.id);
        this.opts.onChange();
        return ok ? "restored" : "no such memory";
      }
      case "memory.edit": {
        const ok = service.edit(cmd.id, cmd.text, cmd.kind);
        this.opts.onChange();
        return ok ? "edited" : "not saved";
      }
      case "memory.add":
        if (!this.opts.enabled()) return "memory is off · turn it on in Settings first";
        return this.remember(cmd.text, cmd.kind);
      case "memory.run": {
        if (!this.opts.enabled()) return "memory is off · turn it on in Settings first";
        const queued = this.queueRecent();
        if (!quiet) return queued ? `queued ${queued} conversation(s) · read once the session is closed` : "nothing new to read";
        if (!queued && this.pending.size === 0) return "nothing new to read";
        // Kevin pressed Learn now: the oldest queued conversation is read now (its line gate skipped), the rest at the quiet ticks.
        const before = this.lastRunAt;
        this.drain(true);
        await this.running;
        this.opts.onChange();
        if (this.lastRun && this.lastRunAt !== before) return `learned ${this.lastRun.added} · updated ${this.lastRun.updated} · ${this.pending.size} more queued`;
        return this.pending.size ? `${this.pending.size} queued` : "nothing new to read";
      }
    }
  }

  /** `memory.run`: the closed conversations of the last week, newest last, queued and forced past the line gate (the store's watermark makes a rerun cheap). */
  private queueRecent(): number {
    const todo: string[] = [];
    for (const c of this.closedChains()) {
      if (todo.length >= CATCHUP_MAX) break;
      if (this.pending.has(c.root)) continue;
      todo.push(c.root);
    }
    for (const id of todo.reverse()) {
      this.pending.add(id);
      this.forced.add(id);
    }
    return todo.length;
  }

  // ---------------------------------------------------------- daemon reads

  /** The Memory rail's list (default live). Vectors never leave the store. */
  list(state?: MemoryState | "all", limit?: number): MemoryItem[] {
    return MemoryBridge.clean(this.service?.list(state, limit) ?? []);
  }

  async search(query: string, limit?: number): Promise<MemoryItem[]> {
    if (!this.service) return [];
    return MemoryBridge.clean(await this.service.search(query, limit));
  }

  flush(): void {
    this.service?.flush();
  }

  /** An item as the wire sees it: the contract's fields, never an embedding that happened to ride along. */
  private static clean(items: readonly MemoryItem[]): MemoryItem[] {
    return items.map((item) => {
      const { vec: _vec, ...rest } = item as MemoryItem & { vec?: unknown };
      return rest as MemoryItem;
    });
  }
}
