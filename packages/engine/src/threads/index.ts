/**
 * Threads: independent lines of work, each as capable as the main conversation.
 * The table answers "what is running" in O(1); the scheduler runs spawned threads'
 * turns on warm brains from the pool; the runners keep the lanes and the lease; the
 * lines are the deterministic English Kevin hears. This index carries what engine.ts
 * and the engine's tests read; the modules import each other directly.
 */
export { ThreadTable, RESTART_REASON } from "./table.ts";
export { ThreadScheduler } from "./scheduler.ts";
export type { ThreadParent, ThreadVoice, ThreadBrainSpec, ThreadBrainFactory } from "./scheduler.ts";
export { ThreadLog } from "./turns.ts";
export { LaneRunner, ThreadAwareRunner, LANE_REFUSAL, MAIN_LEASE_WAIT_MS, needsFocus } from "./runner.ts";
