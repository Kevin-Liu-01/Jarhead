import { THREAD_LINGER_MS, THREAD_MAX_LIVE, THREAD_NAME_CHARS, THREAD_SECONDS_DEFAULT, THREAD_SECONDS_MAX, THREAD_STEPS_DEFAULT, THREAD_STEPS_MAX } from "@jarhead/protocol";
import { THREAD_LINE_CHARS, THREAD_WAITS_MAX } from "./threads/index.ts";

/**
 * Workers became threads (packages/engine/src/threads/). This module keeps the
 * workers pass's names for one release — the engine, the tests and the docs that
 * import `WorkerPool`, `LaneRunner`, `WorkerAwareRunner`, `FOCUS_TOOLS`,
 * `DENIED_FOR_WORKERS`, `workerBrief`… keep compiling — and nothing else. Read the
 * threads package for the design; write new code against it.
 */

export {
  ThreadScheduler as WorkerPool,
  LaneRunner,
  WorkerAwareRunner,
  LaneHands,
  LaneConfirmations,
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
  workerBrief,
  threadBrief,
} from "./threads/index.ts";
export type {
  ThreadSchedulerOptions as WorkerPoolOptions,
  ThreadParent as WorkerParent,
  ThreadVoice as WorkerVoice,
  ThreadBrainSpec as WorkerBrainSpec,
  ThreadBrainFactory as WorkerBrainFactory,
  LaneRunnerOptions,
  WorkerAwareRunnerOptions,
} from "./threads/index.ts";

/** @deprecated THREAD_STEPS_DEFAULT */
export const WORKER_STEPS_DEFAULT = THREAD_STEPS_DEFAULT;
/** @deprecated THREAD_STEPS_MAX */
export const WORKER_STEPS_MAX = THREAD_STEPS_MAX;
/** @deprecated THREAD_SECONDS_DEFAULT */
export const WORKER_SECONDS_DEFAULT = THREAD_SECONDS_DEFAULT;
/** @deprecated THREAD_SECONDS_MAX */
export const WORKER_SECONDS_MAX = THREAD_SECONDS_MAX;
/** @deprecated THREAD_WAITS_MAX */
export const WORKER_WAITS_MAX = THREAD_WAITS_MAX;
/** @deprecated THREAD_LINE_CHARS */
export const WORKER_LINE_CHARS = THREAD_LINE_CHARS;
/** @deprecated THREAD_NAME_CHARS */
export const WORKER_NAME_CHARS = THREAD_NAME_CHARS;
/** @deprecated THREAD_MAX_LIVE (main + 3; workers counted 2 in total). */
export const WORKER_MAX_LIVE = THREAD_MAX_LIVE;
/** @deprecated THREAD_LINGER_MS */
export const WORKER_LINGER_MS = THREAD_LINGER_MS;
