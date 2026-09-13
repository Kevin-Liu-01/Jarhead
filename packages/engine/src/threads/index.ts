/**
 * Threads: independent lines of work, each as capable as the main conversation.
 * The table answers "what is running" in O(1); the scheduler runs spawned threads'
 * turns on warm brains from the pool; the runners keep the lanes and the lease; the
 * lines are the deterministic English Kevin hears. ../workers.ts re-exports the
 * workers-pass names over these for one release.
 */
export { ThreadTable, ThreadEventCoalescer, THREAD_TABLE_MAX, THREAD_EVENTS_RING, ACTING_HOLD_MS, THREAD_APPS_MAX, THREAD_EVENT_COALESCE_MS, EVENT_DETAIL_CHARS, RESTART_REASON } from "./table.ts";
export type { ThreadTableOptions, StepPatch, RebuildResult } from "./table.ts";
export { ThreadScheduler, LaneHands, LaneConfirmations, workerStatus, appHint, THREAD_WAITS_MAX, THREAD_IDLE_END_MS, THREAD_PROGRESS_PER_TURN, THREAD_PROGRESS_GAP_MS, MEMORY_RECALL_MS, SUPERSEDE_WAIT_MS } from "./scheduler.ts";
export type { ThreadSchedulerOptions, ThreadParent, ThreadVoice, ThreadBrainSpec, ThreadBrainFactory, SpawnSpec, StopBy, Lane } from "./scheduler.ts";
export { BrainPool, rssMbOfPid, WARM_SPARES_DEFAULT, WARM_SPARES_MAX, WARM_SPARE_RETRY_MS } from "./brain-pool.ts";
export type { BrainPoolOptions, PoolLane, Ready } from "./brain-pool.ts";
export { ThreadLog, ThreadTurns, STEPS_IN_MEMORY, THREAD_TURNS_MAX, THREAD_LOG_RING } from "./turns.ts";
export type { ThreadTurn, ThreadPage, ThreadTurnsOptions } from "./turns.ts";
export {
  LeasedRunner,
  LaneRunner,
  WorkerAwareRunner,
  ThreadAwareRunner,
  THREAD_TOOLS,
  WORKER_TOOLS,
  FOCUS_TOOLS,
  FOCUS_APPLESCRIPT,
  BACKGROUND_SHELL_REFUSE,
  DENIED_FOR_THREADS,
  DENIED_FOR_WORKERS,
  LANE_REFUSAL,
  MAIN_LEASE_WAIT_MS,
  needsFocus,
  shellSteals,
  canonicalThreadTool,
  recordStep,
  argsOf,
} from "./runner.ts";
export type { SpawnLane, LaneRunnerOptions, WorkerAwareRunnerOptions, LeasedRunnerOptions, ActionObserverLike, ActingSerializerLike, ThreadToolSource } from "./runner.ts";
export { threadBrief, workerBrief, threadLine, mainLine, overviewLine, unknownNameLine, shortStatus, phraseForTool, phraseForLine, joinNames, cutLine, THREAD_LINE_CHARS, PHRASE_CHARS, CONFIRMATION_RESUME, resumeText } from "./lines.ts";
