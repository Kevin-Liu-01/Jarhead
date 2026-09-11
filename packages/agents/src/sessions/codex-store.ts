import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  DEFAULT_LIMIT,
  DEFAULT_MAX_AGE_DAYS,
  MAX_ASSISTANT_CHARS,
  ParseCache,
  extrapolateCount,
  isRecord,
  newestFirst,
  parseJsonLine,
  parseTimestamp,
  readHeadTail,
  str,
  truncate,
  type DiscoveredSession,
  type SessionSource,
  type StoreOptions,
} from "./store.ts";

/**
 * Codex CLI / Codex Desktop rollouts: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl
 * plus ~/.codex/archived_sessions/*.jsonl for threads Kevin archived.
 *
 * Line shapes seen on this machine (codex 0.145–0.153):
 *   {"timestamp","type":"session_meta","payload":{"session_id","id","cwd","originator","cli_version","source",
 *       "thread_source":"user"|"subagent"|"automation","parent_thread_id","agent_nickname",...}}
 *   {"type":"response_item","payload":{"type":"message","role":"user"|"assistant"|"developer","content":[{"type":"input_text"|"output_text","text"}]}}
 *   {"type":"response_item","payload":{"type":"agent_message","author":"/root/x",...}}   inter-agent chatter, skipped
 *   {"type":"event_msg","payload":{"type":"task_started"|"item_completed"|"token_count"|"task_complete"|...}}
 *   {"type":"event_msg","payload":{"type":"user_message"|"agent_message","message":"..."}}   0.145–0.147 only
 *
 * Turns are recorded once, as response_item messages. Up to 0.147 every turn was also
 * echoed as an event_msg user_message/agent_message; 0.148+ stopped writing those, so the
 * event shape is only a fallback for old files that carry nothing else.
 *
 * A sub-agent rollout's `session_id` is its PARENT thread's id; its own id is `id` (also the
 * filename). The parent is named top-level (`parent_thread_id`) or, in forked sub-agents,
 * under `source.subagent.thread_spawn.parent_thread_id`; those forks also copy the parent's
 * history in, its own session_meta line included, so only the FIRST session_meta describes
 * the file. Sub-agents are children of a thread, not sessions Kevin sat in, and automation
 * rollouts are Codex's own scheduled jobs with no typed prompt; neither is listed.
 *
 * The first real user prompt sits after ~15 KB of base instructions and the AGENTS.md
 * injection, sometimes past 100 KB, hence the larger head budget. Codex Desktop also names
 * every thread in ~/.codex/session_index.jsonl ({"id","thread_name","updated_at"} per line);
 * that name is the session's title, so a thread whose prompt is out of reach still reads well.
 */

const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 256 * 1024;
const ROLLOUT_FILE = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/;
const TIMESTAMP_RE = /^\{"timestamp":"([^"]+)"/;
const INTERESTING = /"type":"session_meta"|"payload":\{"type":"(user_message|agent_message|message)"/;

/** Rollouts the Console lists; see the header. */
const LISTED_SOURCES: ReadonlySet<SessionSource> = new Set<SessionSource>(["user", "unknown"]);

/**
 * Injected context that arrives as a "user" message but Kevin never typed:
 * AGENTS.md, environment/app context, plugin lists, browser state, attachments.
 * Anything opening with an XML-ish tag counts; Kevin does not start prompts that way.
 */
const SYNTHETIC_USER = /^\s*(#\s*AGENTS\.md instructions|#\s*Files mentioned by the user|<[a-z_][\w-]*(\s|>))/i;

export function defaultCodexRoot(home = homedir()): string {
  return join(home, ".codex");
}

interface Candidate {
  readonly path: string;
  readonly mtimeMs: number;
  readonly size: number;
  readonly archived: boolean;
}

export class CodexStore {
  readonly root: string;
  private readonly maxAgeDays: number;
  private readonly limit: number;
  private readonly now: () => number;
  private readonly cache = new ParseCache<DiscoveredSession>();
  private names: { mtimeMs: number; size: number; byId: Map<string, string> } | undefined;

  constructor(opts: StoreOptions & { readonly root?: string } = {}) {
    this.root = opts.root ?? defaultCodexRoot();
    this.maxAgeDays = opts.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
    this.limit = opts.limit ?? DEFAULT_LIMIT;
    this.now = opts.now ?? Date.now;
  }

  get sessionsDir(): string {
    return join(this.root, "sessions");
  }

  get archivedDir(): string {
    return join(this.root, "archived_sessions");
  }

  get indexPath(): string {
    return join(this.root, "session_index.jsonl");
  }

  async exists(): Promise<boolean> {
    try {
      return (await stat(this.sessionsDir)).isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Newest listed threads within the age window, capped, one per id. Sub-agent and
   * automation rollouts outnumber Kevin's own threads several times over, so the cap
   * applies after the filter; files are parsed newest-first in cap-sized batches and
   * the scan stops as soon as the cap is met (usually after the first batch).
   */
  async scan(): Promise<DiscoveredSession[]> {
    const [candidates, names] = await Promise.all([this.candidates().then((c) => newestFirst(c, Number.POSITIVE_INFINITY)), this.threadNames()]);
    const out: DiscoveredSession[] = [];
    const ids = new Set<string>();
    const parsed = new Set<string>();
    for (let i = 0; i < candidates.length && out.length < this.limit; i += this.limit) {
      const batch = candidates.slice(i, i + this.limit);
      const sessions = await Promise.all(batch.map((c) => this.load(c)));
      for (const c of batch) parsed.add(c.path);
      for (const s of sessions) {
        if (!s || !LISTED_SOURCES.has(s.source) || ids.has(s.id)) continue;
        ids.add(s.id);
        out.push(withTitle(s, names));
        if (out.length >= this.limit) break;
      }
    }
    this.cache.retain(parsed);
    return out;
  }

  /** Parse one rollout by its own id (the filename's), whatever its source or age. */
  async find(id: string): Promise<DiscoveredSession | undefined> {
    const [all, names] = await Promise.all([this.candidates(true), this.threadNames()]);
    const c = all.find((x) => idFromFilename(basename(x.path)) === id);
    const s = c ? await this.load(c) : undefined;
    return s ? withTitle(s, names) : undefined;
  }

  /** id → thread_name from session_index.jsonl, re-read only when the file changes. Missing file: no names. */
  private async threadNames(): Promise<ReadonlyMap<string, string>> {
    let st;
    try {
      st = await stat(this.indexPath);
    } catch {
      return new Map();
    }
    if (this.names && this.names.mtimeMs === st.mtimeMs && this.names.size === st.size) return this.names.byId;
    const byId = new Map<string, string>();
    try {
      for (const line of (await readFile(this.indexPath, "utf8")).split("\n")) {
        const o = parseJsonLine(line);
        const id = o && str(o["id"]);
        const name = o && str(o["thread_name"])?.trim();
        if (id && name) byId.set(id, name); // later lines win: the index is appended as threads are renamed
      }
    } catch {
      return new Map();
    }
    this.names = { mtimeMs: st.mtimeMs, size: st.size, byId };
    return byId;
  }

  private async candidates(ignoreAge = false): Promise<Candidate[]> {
    const cutoff = ignoreAge ? -Infinity : this.now() - this.maxAgeDays * 86_400_000;
    const [live, archived] = await Promise.all([
      walkJsonl(this.sessionsDir, 3),
      walkJsonl(this.archivedDir, 0),
    ]);
    const all = [...live.map((path) => ({ path, archived: false })), ...archived.map((path) => ({ path, archived: true }))];
    const stats = await Promise.all(
      all.map(async ({ path, archived }) => {
        if (!ROLLOUT_FILE.test(basename(path))) return undefined;
        try {
          const st = await stat(path);
          return st.isFile() && st.mtimeMs >= cutoff ? { path, mtimeMs: st.mtimeMs, size: st.size, archived } : undefined;
        } catch {
          return undefined;
        }
      }),
    );
    return stats.filter((c): c is Candidate => c !== undefined);
  }

  private async load(c: Candidate): Promise<DiscoveredSession | undefined> {
    const cached = this.cache.get(c.path, c.mtimeMs, c.size);
    if (cached) return cached;
    try {
      const slices = await readHeadTail(c.path, HEAD_BYTES, TAIL_BYTES);
      const parsed = parseCodexSession(c.path, slices.head, slices.tail, {
        whole: slices.whole,
        bytesRead: slices.bytesRead,
        size: slices.size,
        mtimeMs: slices.mtimeMs,
        archived: c.archived,
      });
      this.cache.set(c.path, slices.mtimeMs, slices.size, parsed);
      return parsed;
    } catch {
      return undefined;
    }
  }
}

/** The parse is cached per file; the name comes from the index, which changes on its own, so it is applied on the way out. */
function withTitle(s: DiscoveredSession, names: ReadonlyMap<string, string>): DiscoveredSession {
  const name = names.get(s.id);
  return name ? { ...s, title: truncate(name, 80) } : s;
}

/** All *.jsonl under `dir`, descending at most `depth` directory levels (YYYY/MM/DD = 3). */
async function walkJsonl(dir: string, depth: number): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  const subdirs: Promise<string[]>[] = [];
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith(".jsonl")) out.push(join(dir, e.name));
    else if (e.isDirectory() && depth > 0) subdirs.push(walkJsonl(join(dir, e.name), depth - 1));
  }
  for (const list of await Promise.all(subdirs)) out.push(...list);
  return out;
}

export function idFromFilename(name: string): string | undefined {
  return ROLLOUT_FILE.exec(name)?.[1];
}

interface FileFacts {
  readonly whole: boolean;
  readonly bytesRead: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly archived: boolean;
}

/** `source: {"subagent": {"thread_spawn": {"parent_thread_id": …, "agent_path": …}}}` on forked sub-agents. */
function spawnParent(source: unknown): string | undefined {
  if (!isRecord(source)) return undefined;
  const sub = source["subagent"];
  if (!isRecord(sub)) return undefined;
  const spawn = sub["thread_spawn"];
  return isRecord(spawn) ? str(spawn["parent_thread_id"]) : undefined;
}

function sourceOf(threadSource: string | undefined, parentId: string | undefined, id: string | undefined): SessionSource {
  if (threadSource === "user" || threadSource === "subagent" || threadSource === "automation") return threadSource;
  // No thread_source but a parent that is not itself: a child rollout from a build that predates the field.
  if (parentId !== undefined && parentId !== id) return "subagent";
  return "unknown";
}

/** Pure: build a DiscoveredSession from the head and tail lines of one rollout file. */
export function parseCodexSession(path: string, head: readonly string[], tail: readonly string[], file: FileFacts): DiscoveredSession {
  let id: string | undefined;
  let cwd: string | undefined;
  let source: SessionSource = "unknown";
  let parentId: string | undefined;
  let metaSeen = false;
  let firstPrompt: string | undefined;
  let lastAssistantText: string | undefined;
  let startedAt: number | undefined;
  let lastTimestamp: number | undefined;
  /** response_item user + assistant messages: one per turn in every codex version seen. */
  let turns = 0;
  /** event_msg user_message + agent_message: the 0.145–0.147 echo of the same turns. */
  let events = 0;

  // token_count, reasoning and tool-call lines are the bulk of a rollout and carry
  // nothing a listing needs; a substring check spares them the JSON.parse.
  const visit = (line: string): void => {
    const ts = parseTimestamp(TIMESTAMP_RE.exec(line)?.[1]);
    if (ts !== undefined) {
      startedAt = startedAt === undefined ? ts : Math.min(startedAt, ts);
      lastTimestamp = lastTimestamp === undefined ? ts : Math.max(lastTimestamp, ts);
    }
    if (!INTERESTING.test(line)) return;
    const o = parseJsonLine(line);
    if (!o) return;
    const type = str(o["type"]);
    const payload = o["payload"];
    if (!isRecord(payload)) return;
    if (type === "session_meta") {
      // A later session_meta is a parent's, copied in with its history; the first one is this file's.
      if (metaSeen) return;
      metaSeen = true;
      // `id` is this rollout's own thread id (the filename's); `session_id` is the parent's
      // for sub-agent rollouts, so it is the last resort, not the first.
      id = str(payload["id"]) ?? idFromFilename(basename(path)) ?? str(payload["session_id"]);
      cwd = str(payload["cwd"]);
      parentId = str(payload["parent_thread_id"]) ?? spawnParent(payload["source"]);
      source = sourceOf(str(payload["thread_source"]), parentId, id);
      const metaTs = parseTimestamp(payload["timestamp"]);
      if (metaTs !== undefined) startedAt = startedAt === undefined ? metaTs : Math.min(startedAt, metaTs);
      return;
    }
    const ptype = str(payload["type"]);
    if (type === "event_msg") {
      if (ptype === "user_message") {
        const text = str(payload["message"]);
        if (text && !SYNTHETIC_USER.test(text)) {
          events += 1;
          firstPrompt ??= text;
        }
      } else if (ptype === "agent_message") {
        const text = str(payload["message"])?.trim();
        if (text) {
          events += 1;
          lastAssistantText = text;
        }
      }
      return;
    }
    if (type === "response_item" && ptype === "message") {
      const role = str(payload["role"]);
      const text = contentText(payload["content"]);
      if (!text) return;
      if (role === "user") {
        if (SYNTHETIC_USER.test(text)) return;
        turns += 1;
        firstPrompt ??= text;
      } else if (role === "assistant") {
        turns += 1;
        lastAssistantText = text;
      }
    }
  };

  for (const line of head) visit(line);
  for (const line of tail) visit(line);

  // Count each turn once: response_item is authoritative; the event echo only stands in
  // for files (0.145–0.147 event-only slices) that have no response_item messages at all.
  const seen = turns > 0 ? turns : events;
  const ownId = id ?? idFromFilename(basename(path)) ?? basename(path, ".jsonl");
  return {
    tool: "codex",
    id: ownId,
    source,
    parentId: parentId === ownId ? undefined : parentId,
    path,
    cwd,
    title: undefined,
    firstPrompt: firstPrompt ? truncate(firstPrompt, 80) : undefined,
    lastAssistantText: lastAssistantText ? lastAssistantText.slice(0, MAX_ASSISTANT_CHARS) : undefined,
    startedAt,
    lastActivityAt: Math.max(file.mtimeMs, lastTimestamp ?? 0),
    mtimeMs: file.mtimeMs,
    sizeBytes: file.size,
    messageCount: file.whole ? seen : extrapolateCount(seen, file.bytesRead, file.size),
    messageCountExact: file.whole,
    archived: file.archived,
  };
}

function contentText(content: unknown): string | undefined {
  if (typeof content === "string") return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    const t = block["type"];
    if ((t === "input_text" || t === "output_text" || t === "text") && typeof block["text"] === "string") parts.push(block["text"]);
  }
  const text = parts.join("\n").trim();
  return text || undefined;
}
