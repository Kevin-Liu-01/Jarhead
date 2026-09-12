import { NativeHandsProcess, type NativeHandsProcessOptions } from "./native.ts";

/**
 * Two helper processes from one binary: `focus` acts (every op that posts an event,
 * activates an app or touches the pasteboard — the main brain, dictation, screen-lane
 * workers) and `background` reads (the engine's AX warm tick and ear hints, the wake
 * shot, background workers' probes). The helper is serial, so a worker's 30 s
 * `open_app` or a long `type` on one process never stalls the gate probes and the
 * 500 ms tree walk on the other.
 *
 * Same daemon parent → same TCC identity: the second process needs no new grant and
 * no prompt. Both are spawned with Jarhead's keys stripped from the environment
 * (`NativeHandsProcess` does that for every spawn). The two coexist on nothing but the
 * pointer, the keyboard and the pasteboard — the lease and the lane rules keep the
 * acting ops on `focus`.
 */
export interface HandsPoolOptions extends NativeHandsProcessOptions {
  /** Per-helper overrides (a test hands each helper its own fake). */
  readonly background?: Partial<NativeHandsProcessOptions>;
}

export class HandsPool {
  readonly focus: NativeHandsProcess;
  readonly background: NativeHandsProcess;

  constructor(opts: HandsPoolOptions) {
    const { background, ...shared } = opts;
    this.focus = new NativeHandsProcess(shared);
    this.background = new NativeHandsProcess({ ...shared, ...(background ?? {}) });
  }

  /** Both helpers, acting one first. */
  get all(): readonly [NativeHandsProcess, NativeHandsProcess] {
    return [this.focus, this.background];
  }

  /** The acting helper is running (what the status line means by "hands ready"); `background.ready` for the other. */
  get ready(): boolean {
    return this.focus.ready;
  }

  /** Is either helper running? */
  get anyReady(): boolean {
    return this.focus.ready || this.background.ready;
  }

  /** The binary exists (one binary, so one answer). */
  get available(): boolean {
    return this.focus.available;
  }

  /** Requests in flight on both helpers. */
  get pendingCount(): number {
    return this.focus.pendingCount + this.background.pendingCount;
  }

  /**
   * A cut: every pending request on both helpers fails `cancelled`. Each client sends
   * SIGURG only when it has a `type` in flight — so the signal reaches the child that
   * is typing and no other. Returns how many requests were dropped in all.
   */
  cancelAll(reason = "stopped"): number {
    return this.focus.cancelPending(reason) + this.background.cancelPending(reason);
  }

  /** A grant landed: TCC answers are per process, so both helpers restart to read it. Both are tried; the first failure is rethrown after. */
  async restartAll(): Promise<void> {
    const results = await Promise.allSettled(this.all.map((h) => h.restart()));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw failed.reason instanceof Error ? failed.reason : new Error(String(failed.reason));
  }

  /** Shutdown: both helpers stopped, every pending failed `unavailable`. */
  stop(): void {
    for (const h of this.all) h.stop();
  }
}
