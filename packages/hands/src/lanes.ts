import { logger } from "@jarhead/core";
import { ConfirmationState, type ArmedConfirmation, type ConfirmationGrant, type Grantable, type PendingConfirmation, type ToolResult } from "./toolset.ts";

/**
 * One question floor for every hand.
 *
 * The engine's root `ConfirmationState` stays what it is: the Delegator arms it on
 * Kevin's yes, a cut clears it, the ear-reflex drop reads its pending id. What
 * changes is who may post to it. Every toolset — the main lane included — gets a
 * `LaneConfirmationState` from the desk. Its `ask` posts to the root when the floor
 * is free (or already this lane's) and otherwise QUEUES the question and answers with
 * a `queued_<n>` id, so the second hand's brain is told to stop and wait instead of
 * having its question spoken over the first or silently overwrite it. `consume` is
 * true only for the floor's lane: a yes never lands another lane's action. When the
 * floor clears the next queued question is promoted — re-asked on the root and spoken
 * with its hand's name — so Kevin hears one question at a time, each one once.
 *
 * Grants are the conversation's, not a lane's: `granted`, `arm`, `beginConversation`
 * and `endConversation` forward to the root, so a recorded yes to "clicks in Slack"
 * covers every hand in Slack, and the policy's never-grant apps stay ungrantable in
 * every lane (the policy decides that; nothing here can grant).
 *
 * Built over the public members of `ConfirmationState` only — the handshake in
 * toolset.ts is a rail and is not edited.
 */

const log = logger("hands.desk");

/** A question waiting behind the floor. */
export interface QueuedQuestion {
  readonly id: string;
  readonly laneId: string;
  readonly laneName: string;
  readonly description: string;
  readonly member: string;
  readonly input: Record<string, unknown>;
  readonly grantable?: Grantable;
  readonly at: number;
}

/** The question on the floor: which lane's, and the root pending id it holds. */
export interface Floor {
  readonly laneId: string;
  /** The lane's spoken name ("Spotify"). */
  readonly name: string;
  /** The same name, under its longer label. */
  readonly laneName: string;
  readonly pendingId: string;
  readonly description: string;
}

/** The prefix of every queued id: `queued_<n>`. */
export const QUEUED_ID_PREFIX = "queued_";

/** What the second hand's brain reads instead of a question: wait, do not retry. */
export function queuedText(floor: { readonly laneName: string; readonly description: string }): string {
  return `Queued behind ${floor.laneName}'s question: ${floor.description}. Kevin will be asked after that one; stop and wait (thread_wait), do not retry`;
}

/** "left click on "Send · AXButton" in Slack" → "left click on "Send" in Slack": what is spoken, without the accessibility roles. */
export function spokenQuestion(description: string): string {
  return description.replace(/\s*·\s*AX\w+/g, "").replace(/\s+/g, " ").trim();
}

export class ConfirmationDesk {
  private readonly lanes = new Map<string, LaneConfirmationState>();
  private floorState: Floor | undefined;
  private readonly queue: QueuedQuestion[] = [];
  private seq = 0;
  private readonly now: () => number;

  /**
   * @param root the engine's ConfirmationState (armed by the Delegator, cleared by a cut)
   * @param speak how a promoted question reaches Kevin: the lane's name and the question, once
   * @param now the clock; `ttlMs` how long a queued question may wait before it is stale (the root's 3 min)
   */
  constructor(
    readonly root: ConfirmationState,
    private readonly speak: (laneName: string, question: string) => void,
    now?: () => number,
    private readonly ttlMs = 3 * 60_000,
  ) {
    this.now = now ?? Date.now;
  }

  /** The lane's confirmation state (one per id; the same object on every call, renamed when a spare is named as it is used). */
  lane(id: string, name: string): LaneConfirmationState {
    let lane = this.lanes.get(id);
    if (!lane) {
      lane = new LaneConfirmationState(this, id, name, this.now);
      this.lanes.set(id, lane);
    } else if (name && lane.name !== name) {
      lane.name = name;
    }
    return lane;
  }

  /**
   * A lane's question — on the floor or queued — goes (its thread stopped or was cut);
   * the next queued question comes up. Nothing else's is touched.
   */
  drop(laneId: string): void {
    if (this.floor?.laneId === laneId) {
      this.root.dropQuestion();
      this.floorState = undefined;
    }
    this.unqueue(laneId);
    this.promote();
  }

  /** `drop` and the lane object itself: a later `lane(id, …)` starts afresh. */
  forget(laneId: string): void {
    this.drop(laneId);
    this.lanes.delete(laneId);
  }

  /** The question a lane has waiting right now — the root's when it holds the floor, its queued stub otherwise. */
  pendingOf(laneId: string): PendingConfirmation | undefined {
    const floor = this.floor;
    if (floor?.laneId === laneId) return this.root.pending;
    const q = this.queue.find((x) => x.laneId === laneId);
    if (!q) return undefined;
    return { id: q.id, description: floor ? queuedText(floor) : q.description, member: q.member, input: q.input, at: q.at, ...(q.grantable ? { grantable: q.grantable } : {}) };
  }

  /** How many questions wait behind the floor. */
  get queuedCount(): number {
    return this.queue.length;
  }

  /**
   * Whose question is on the root right now. Heals itself: when the root's pending is
   * no longer the one the floor posted, the floor is free. A question that VANISHED
   * (the root's pending is undefined) went the way the engine drops them directly on
   * the root — Kevin moved on, a cut, a yes that came after the TTL — and none of
   * those should have another lane's question spoken next: the queue goes with it,
   * as `dropQuestion()` would have taken it. Only `consume` and `drop(laneId)` promote.
   */
  get floor(): Floor | undefined {
    const f = this.floorState;
    if (!f) return undefined;
    const p = this.root.pending;
    if (p?.id === f.pendingId) return f;
    this.floorState = undefined;
    if (p === undefined && this.queue.length > 0) {
      log.debug(`${f.laneName}'s question went from the root; ${this.queue.length} queued behind it dropped`);
      this.queue.length = 0;
    }
    return undefined;
  }

  /** The lane on the floor, if any (the Delegator's yes-routing reads this). */
  floorLane(): string | undefined {
    return this.floor?.laneId;
  }

  /** The questions waiting behind the floor, in order. */
  get queued(): readonly QueuedQuestion[] {
    return this.queue;
  }

  /** Is this the id a queued ask answered with? */
  static isQueuedId(pendingId: string): boolean {
    return pendingId.startsWith(QUEUED_ID_PREFIX);
  }

  /** A lane asks. The floor's lane (or a free floor) posts to the root; anyone else queues. */
  ask(lane: LaneConfirmationState, description: string, member: string, input: Record<string, unknown>, grantable?: Grantable): PendingConfirmation {
    const floor = this.floor;
    if (!floor || floor.laneId === lane.id) {
      const pending = this.root.ask(description, member, input, grantable);
      this.floorState = { laneId: lane.id, name: lane.name, laneName: lane.name, pendingId: pending.id, description };
      this.unqueue(lane.id);
      return pending;
    }
    // Behind the floor: one queued question per lane (a retry replaces, it does not multiply).
    this.unqueue(lane.id);
    const q: QueuedQuestion = { id: `${QUEUED_ID_PREFIX}${++this.seq}`, laneId: lane.id, laneName: lane.name, description, member, input, ...(grantable && grantable.app ? { grantable } : {}), at: this.now() };
    this.queue.push(q);
    log.debug(`${lane.name} queued behind ${floor.laneName}: ${description}`);
    return { id: q.id, description: queuedText(floor), member, input, at: q.at };
  }

  /** The floor's lane spends the yes; anyone else gets false however well the action matches. */
  consume(lane: LaneConfirmationState, member: string, input: Record<string, unknown>): boolean {
    const floor = this.floor;
    if (!floor || floor.laneId !== lane.id) return false;
    const ok = this.root.consume(member, input);
    if (!ok) return false;
    this.floorState = undefined;
    this.promote();
    return true;
  }

  /**
   * The floor is free: the next queued question is re-asked on the root and SPOKEN with
   * its hand's name (`speak(name, question)`), once. Returns it, or undefined when
   * nothing waited or the floor is still taken.
   */
  promote(): QueuedQuestion | undefined {
    if (this.floor) return undefined;
    // A question that waited past the root's own TTL is as stale as an unanswered one: never re-asked.
    while (this.queue.length > 0 && this.now() - this.queue[0]!.at > this.ttlMs) this.queue.shift();
    const next = this.queue.shift();
    if (!next) return undefined;
    const pending = this.root.ask(next.description, next.member, next.input, next.grantable);
    const name = this.lanes.get(next.laneId)?.name ?? next.laneName;
    this.floorState = { laneId: next.laneId, name, laneName: name, pendingId: pending.id, description: next.description };
    log.debug(`promoted ${name}'s question: ${next.description}`);
    this.speak(name, spokenQuestion(next.description));
    return next;
  }

  /** Kevin moved on (a new request that is not a yes): the question and everything queued behind it go; the grants stand. */
  dropQuestion(): void {
    this.root.dropQuestion();
    this.floorState = undefined;
    this.queue.length = 0;
  }

  /** The cut: the root's clear (question gone, grants asleep) plus the whole queue. */
  clear(): void {
    this.root.clear();
    this.floorState = undefined;
    this.queue.length = 0;
  }

  /** A question with this id is queued, not on the root: the tool result's question should read the queued text. */
  render(result: ToolResult): ToolResult {
    if (result.kind !== "needs-confirmation" || !ConfirmationDesk.isQueuedId(result.pendingId)) return result;
    const floor = this.floor;
    const q = this.queue.find((x) => x.id === result.pendingId);
    if (!q) return result;
    return { ...result, question: floor ? queuedText(floor) : `Queued: ${q.description}. Kevin will be asked shortly; stop and wait (thread_wait), do not retry` };
  }

  private unqueue(laneId: string): void {
    for (let i = this.queue.length - 1; i >= 0; i--) if (this.queue[i]!.laneId === laneId) this.queue.splice(i, 1);
  }
}

/**
 * A lane's view of the one handshake. Every method a toolset or runner calls lands on
 * the desk; `pending` and `conversationId` read through to the root (or to this
 * lane's queued question), so a reader of the lane sees what the root sees.
 */
export class LaneConfirmationState extends ConfirmationState {
  constructor(
    private readonly desk: ConfirmationDesk,
    readonly id: string,
    /** The spoken name; a spare lane is renamed when it is put to use (`desk.lane(id, name)`). */
    public name: string,
    now: () => number = Date.now,
  ) {
    super(3 * 60_000, now);
    // The base declares `pending` and `conversationId` as fields (an own property on this
    // instance, defined by the base constructor), and TypeScript forbids an accessor
    // override of a field — so the read-through is installed here, on the instance.
    Object.defineProperty(this, "pending", {
      configurable: true,
      enumerable: true,
      get: (): PendingConfirmation | undefined => this.desk.pendingOf(this.id),
      set: (v: PendingConfirmation | undefined): void => {
        // `lane.pending = undefined` is the base's idiom for "this question is gone": this lane's, nobody else's.
        if (v === undefined) this.desk.drop(this.id);
      },
    });
    Object.defineProperty(this, "conversationId", {
      configurable: true,
      enumerable: true,
      get: (): string => this.desk.root.conversationId,
      set: (v: string): void => {
        this.desk.root.conversationId = v;
      },
    });
  }

  override ask(description: string, member: string, input: Record<string, unknown>, grantable?: Grantable): PendingConfirmation {
    return this.desk.ask(this, description, member, input, grantable);
  }

  /** The floor's lane only. Kevin's yes stays on the root — the Delegator arms it there. */
  override consume(member: string, input: Record<string, unknown>): boolean {
    return this.desk.consume(this, member, input);
  }

  override arm(record?: (grant: ConfirmationGrant) => void): ArmedConfirmation | undefined {
    return this.desk.root.arm(record);
  }

  override granted(app: string | undefined, actionClass: string | undefined): boolean {
    return this.desk.root.granted(app, actionClass);
  }

  override get activeGrants(): readonly ConfirmationGrant[] {
    return this.desk.root.activeGrants;
  }

  override beginConversation(chainId: string): void {
    if (chainId !== this.desk.root.conversationId) this.desk.dropQuestion();
    this.desk.root.beginConversation(chainId);
  }

  override endConversation(): void {
    this.desk.dropQuestion();
    this.desk.root.endConversation();
  }

  /** The cut, for every lane at once: floor, queue, and the grants asleep. */
  override clear(): void {
    this.desk.clear();
  }

  /** Kevin moved on: the floor and the queue go; grants stand. */
  override dropQuestion(): void {
    this.desk.dropQuestion();
  }

  /** Is this lane's question the one on the floor? */
  get onFloor(): boolean {
    return this.desk.floor?.laneId === this.id;
  }

  /** The question this lane has waiting right now (`pending`, under the engine's name for it). */
  get waiting(): PendingConfirmation | undefined {
    return this.desk.pendingOf(this.id);
  }

  /** This lane's queued question, when it is waiting behind the floor. */
  get queuedQuestion(): QueuedQuestion | undefined {
    return this.desk.queued.find((x) => x.laneId === this.id);
  }
}
