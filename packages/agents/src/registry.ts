import { logger } from "@jarhead/core";
import type { AgentInfo, ConnectorHealth } from "@jarhead/protocol";
import { splitAgentId, type AgentConnector, type ReadOptions, type SendResult, type StartOptions, type TranscriptDelta, type TranscriptOptions, type TranscriptPage } from "./types.ts";

/**
 * All connectors behind one door. The brain's `agents_*` tools call this; the
 * Console lists what it returns. Health and lists are cached briefly because the
 * model tends to call `agents_list` several times per task.
 */

const log = logger("agents");

export class AgentRegistry {
  private readonly connectors: AgentConnector[];
  private cache: { at: number; agents: AgentInfo[]; health: ConnectorHealth[] } | undefined;
  private readonly listeners = new Set<(agents: AgentInfo[]) => void>();
  private readonly known = new Map<string, AgentInfo>();

  constructor(connectors: readonly AgentConnector[], private readonly cacheMs = 3000) {
    this.connectors = [...connectors];
    for (const c of this.connectors) {
      c.subscribe?.((agent) => {
        this.known.set(agent.id, agent);
        this.cache = undefined;
        this.broadcast();
      });
    }
  }

  onChange(listener: (agents: AgentInfo[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private broadcast(): void {
    const agents = [...this.known.values()];
    for (const l of this.listeners) l(agents);
  }

  async refresh(): Promise<{ agents: AgentInfo[]; health: ConnectorHealth[] }> {
    const health: ConnectorHealth[] = [];
    const agents: AgentInfo[] = [];
    await Promise.all(
      this.connectors.map(async (c) => {
        try {
          const h = await c.health();
          health.push(h);
          if (!h.ok) return;
          const list = await c.list();
          agents.push(...list);
        } catch (e) {
          log.warn(`${c.kind} failed: ${(e as Error).message}`);
          health.push({ kind: c.kind, ok: false, detail: (e as Error).message });
        }
      }),
    );
    this.known.clear();
    for (const a of agents) this.known.set(a.id, a);
    this.cache = { at: Date.now(), agents, health };
    this.broadcast();
    return { agents, health };
  }

  async snapshot(): Promise<{ agents: AgentInfo[]; health: ConnectorHealth[] }> {
    if (this.cache && Date.now() - this.cache.at < this.cacheMs) return this.cache;
    return this.refresh();
  }

  private connectorFor(agentIdValue: string): AgentConnector {
    const parts = splitAgentId(agentIdValue);
    if (!parts) throw new Error(`malformed agent id "${agentIdValue}" (expected kind:id)`);
    const c = this.connectors.find((x) => x.kind === parts.kind);
    if (!c) throw new Error(`no connector for ${parts.kind}`);
    return c;
  }

  connector(kind: string): AgentConnector | undefined {
    return this.connectors.find((c) => c.kind === kind);
  }

  /** Find by id, or by a loose name match ("the reviewer", "gt-cloud"). */
  async find(query: string): Promise<AgentInfo | undefined> {
    const { agents } = await this.snapshot();
    const exact = agents.find((a) => a.id === query);
    if (exact) return exact;
    const q = query.toLowerCase().trim();
    const scored = agents
      .map((a) => ({ a, score: score(q, a) }))
      .filter((x) => x.score > 0)
      .sort((x, y) => y.score - x.score);
    return scored[0]?.a;
  }

  async send(agentIdValue: string, text: string): Promise<SendResult> {
    const r = await this.connectorFor(agentIdValue).send(agentIdValue, text);
    this.cache = undefined;
    return r;
  }

  read(agentIdValue: string, opts?: ReadOptions): Promise<string> {
    return this.connectorFor(agentIdValue).read(agentIdValue, opts);
  }

  async start(kind: string, opts: StartOptions): Promise<AgentInfo> {
    const c = this.connector(kind);
    if (!c) throw new Error(`no connector for ${kind}`);
    if (!c.start) throw new Error(`${kind} cannot start new agents`);
    const info = await c.start(opts);
    this.cache = undefined;
    return info;
  }

  async waitSettled(agentIdValue: string, timeoutMs: number): Promise<AgentInfo | undefined> {
    const c = this.connectorFor(agentIdValue);
    if (!c.waitSettled) return undefined;
    const info = await c.waitSettled(agentIdValue, timeoutMs);
    this.cache = undefined;
    return info;
  }

  async interrupt(agentIdValue: string): Promise<void> {
    const c = this.connectorFor(agentIdValue);
    await c.interrupt?.(agentIdValue);
  }

  /** A page of an agent's conversation; rejects when its connector keeps no transcript. */
  async transcript(agentIdValue: string, opts?: TranscriptOptions): Promise<TranscriptPage> {
    const c = this.connectorFor(agentIdValue);
    if (!c.transcript) throw new Error(`${c.kind} keeps no conversation transcript`);
    return c.transcript(agentIdValue, opts);
  }

  /** Follow an agent's conversation; undefined when its connector cannot. `onEnd` hears when the tail could not start or stopped. */
  watch(agentIdValue: string, onDelta: (delta: TranscriptDelta) => void, onEnd?: (reason: string) => void): (() => void) | undefined {
    const c = this.connectorFor(agentIdValue);
    return c.watch?.(agentIdValue, onDelta, onEnd);
  }
}

function score(q: string, a: AgentInfo): number {
  let s = 0;
  const name = a.name.toLowerCase();
  const cwd = (a.cwd ?? "").toLowerCase();
  if (name === q) s += 10;
  if (name.includes(q)) s += 5;
  for (const word of q.split(/\s+/)) {
    if (word.length < 3) continue;
    if (name.includes(word)) s += 2;
    if (cwd.includes(word)) s += 1;
    if (a.kind.includes(word)) s += 1;
  }
  return s;
}
