import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { totalmem } from "node:os";
import { join } from "node:path";
import { HANDS_OFF_APPS, classifyAction, dataPaths, isLoopbackHost, writeEnvSecrets, secretsPresent, Ledger, Trash, logger, newId, readConfig, type JarheadConfig, type SweepResult } from "@jarhead/core";
import { LiveSession, Transcript, buildLiveInstructions, classifyLiveError, languageSection, type SessionConfig } from "@jarhead/live";
import { ComputerToolset, ConfirmationDesk, ConfirmationState, DEFAULT_SHOT_BUDGET, FocusLease, HELPER_PERMISSION_KINDS, HandsPool, QUICK_SHOT_BUDGET, ScreenStateCache, SplitHands, YES_PATTERN, axLabels, fakeHandsSpawn, renderCompositeLook, type ActionEvent, type AxNodeInfo, type AxTreeResult, type ElementInfo, type FocusedText, type FrontmostInfo, type HelloPermissions, type HelperPermissionKind, type NativeHands, type NativeHandsProcess, type ScreenshotResult, type ToolResult, type ToolsetOptions, type WindowInfo } from "@jarhead/hands";
import { AgentRegistry, DEFAULT_PAGE, defaultConnectors, splitAgentId, type AgentConnector, type TranscriptDelta, type TranscriptOptions, type TranscriptPage } from "@jarhead/agents";
import { BROWSER_APPS, ClaudeBrain, Delegator, FiredReflexes, LOCAL_NUM_CTX_MIN, LocalBrain, RECONCILE_THRESHOLD, ReflexRunner, ResponsesBrain, discoverLocalServer, foreignModel, normalizeUtterance, resolveLocalModel, responsesDelegationConfig, screenNote, serverLabel, similarity, suggestedPull, type Brain, type BrainAttachment, type BrainSink, type BrainTask, type DelegatorThreads, type Reconciliation, type Reflex, type ReflexOutcome, type RunOutcome, type RunnerOptions, type ToolRunner } from "@jarhead/brain";
import { INSTALLED_URL, JARHEAD_BUNDLE_ID, defaultExec, describeDock, describeDockChanges, readDock, repairDock, restartDock, type DockAudit, type Exec } from "@jarhead/cli/install";
import { EarReflexes, STOP_NAME_WAIT_MS, type ReflexLedgerRow } from "./ear.ts";
import { MemoryBridge, type LocalMemoryTarget, type MemoryBridgeSeams } from "./memory-bridge.ts";
import { ActionObserver, ActingSerializer } from "./observe.ts";
import { LaneRunner, ThreadAwareRunner, ThreadLog, ThreadScheduler, ThreadTable, type ThreadBrainFactory, type ThreadBrainSpec, type ThreadParent, type ThreadVoice } from "./threads/index.ts";
import {
  BRAIN_KINDS,
  DEFAULT_SETTINGS,
  DEFAULT_WAKE,
  LOCAL_NONE,
  MAIN_THREAD_ID,
  SETTINGS_KEYS,
  grantOf,
  THREAD_PAGE,
  THREAD_TERMINAL,
  type Accent,
  type AgentInfo,
  type AgentMessage,
  type AgentStatus,
  type AudioLevels,
  type ConnectorHealth,
  type Delegation,
  type DelegationStatus,
  type DelegationStep,
  type DelegationTimings,
  type EngineCommand,
  type EngineEvent,
  type LedgerRow,
  type LocalServerStatus,
  type OverlayCommand,
  type PauseInfo,
  type Permissions,
  type Phase,
  type Problem,
  type ProblemKind,
  type ProblemRemedy,
  type Settings,
  type Point,
  type Rect,
  type ScreenMark,
  type SecretKey,
  type SettingsPatch,
  type SetupStatus,
  type SleepCause,
  type Snapshot,
  type Thread,
  type ThreadEntry,
  type TranscriptItem,
  type TrashInfo,
  type UsageToday,
  type WakeSettings,
} from "@jarhead/protocol";
import type { Grant, PermissionInfo, PermissionKind } from "@jarhead/protocol";

/**
 * The engine: everything Jarhead is, minus windows and audio devices.
 *
 * The daemon (jarheadd, spawned by Jarhead.app) hosts it and feeds it the app's
 * microphone PCM; the CLI hosts the same object and feeds it ffmpeg. Both get
 * the same snapshots, the same commands, the same ledger. Keeping it free of any
 * window or audio device is what makes `jarhead probe` — a synthesized utterance
 * through the whole stack — a real end-to-end test.
 */

const log = logger("engine");

export interface EngineEvents {
  event: [event: EngineEvent];
  /** Output PCM16 mono 24 kHz from the voice, as it arrives. */
  audio: [pcm: Buffer];
  overlay: [command: OverlayCommand];
  /** Emitted when the transcript gains a finalized utterance. */
  utterance: [item: TranscriptItem];
  /** The engine wants its host process replaced (self-update); the daemon exits 75 and the app respawns it. */
  restart: [reason: string];
  /** A reflex ran: its label, how long the tool took, and whether it fired ahead of the delegation. */
  reflex: [label: string, ms: number, prefired: boolean];
  /** A reflex through the ear finished (or was dropped): the timing chain the ledger keeps. */
  "reflex.fired": [row: ReflexLedgerRow];
  /**
   * What is on the screen, for the app's on-device ear (wire.ts `ear.hints`): the front
   * app, its window title, the visible controls' titles, the agents' names — at most 100
   * strings of at most three words, only when the set changed, at most twice a second.
   */
  "ear.hints": [strings: readonly string[]];
}

export interface EngineOptions {
  readonly config?: JarheadConfig;
  readonly connectors?: readonly AgentConnector[];
  /** Test seams. */
  readonly makeLive?: (config: SessionConfig) => LiveSession;
  readonly brain?: Brain;
  readonly now?: () => number;
  /** Answers the helper's requests instead of the Swift binary (tests, `jarhead bench --fake-hands`). */
  readonly hands?: NativeHands;
  /** The second helper's stand-in (the reading / background lane); absent, `hands` answers both. */
  readonly backgroundHands?: NativeHands;
  /** Builds a thread's brain over its lane runner (tests inject a scripted fake); absent, the engine builds one for the running brain kind. */
  readonly makeThreadBrain?: ThreadBrainFactory;
  /** The observer's settle before it reads the screen after an acting tool (default OBSERVE_SETTLE_MS 150 / 400 for browser tools); tests set 0. */
  readonly observeSettleMs?: number;
  /** What a fresh helper process would print for `--permissions` (tests; the real client runs the binary). */
  readonly probePermissions?: () => Promise<HelloPermissions>;
  /** The ear's stability window for a partial of a prefire kind — scroll, page, screenshot, circle (default 120 ms); tests shorten it. */
  readonly earStableMs?: number;
  /** The ear's stability window for a partial of every other kind — keys, edits, typing, clicks (default 450 ms); tests shorten it. */
  readonly earCarefulMs?: number;
  /** How long a graceful `close()` may go unanswered before the session is `terminate()`d (default 1000 ms); tests shorten it. */
  readonly closeDeadlineMs?: number;
  /** The disk preflight's statvfs (default `fs.statfsSync` on the state dir): free bytes are `bavail * bsize`. Tests fake a full disk. */
  readonly statfs?: (path: string) => { readonly bavail: number | bigint; readonly bsize: number | bigint };
  /**
   * The shell-outs the engine makes itself — the Dock audit's `defaults export`, Fix the
   * Dock's `defaults import` and `killall Dock` (default: spawnSync, argv only). Tests
   * script it; with one given, the audit runs off macOS too.
   */
  readonly exec?: Exec;
  /** How long after start() the Dock is first read (DOCK_AUDIT_DELAY_MS); tests shorten it. */
  readonly dockAuditDelayMs?: number;
  /** The memory module's seams: a whole fake service (tests), or the embedder / extractor / fetch the real one is built over. */
  readonly memory?: MemoryBridgeSeams;
  /** Test seam: answers the local model server discovery instead of the three loopback ports. */
  readonly discoverLocal?: (o: { baseUrl?: string | undefined; ramBytes: number }) => Promise<LocalServerStatus>;
}

/** Where a page's messages sit in the session file (`TranscriptPage.cursor`); "Load earlier" reads backward from `startOffset`. */
type PageCursor = NonNullable<TranscriptPage["cursor"]>;

/**
 * A conversation some surface has stepped into. `viewers` are pane tokens (the daemon
 * prefixes each with its client id, so a dead client's panes can be dropped; an open
 * without a token gets an anonymous one and counts as before). The tail lives while any
 * viewer remains. `cursor` is where the earliest page served began, for "Load earlier"
 * by byte offset, and `firstId` the first message of that page: only a request for what
 * lies before THAT message may use the offset (the connector gives `beforeOffset`
 * precedence, so an id the pane kept after trimming would otherwise skip the span
 * between); `status` is the agent's last known status, so a turn to `ended` settles the
 * running calls once.
 */
interface OpenConversation {
  readonly viewers: Set<string>;
  unwatch: (() => void) | undefined;
  total: number;
  cursor?: PageCursor;
  firstId: string | undefined;
  status?: AgentStatus;
}

/**
 * A thread pane some surface stepped into (`thread.open`): its viewers (pane tokens the daemon prefixes with
 * its client id), the one subscription to the thread's log, and the entries held for the next coalesced
 * `append` (THREAD_TRANSCRIPT_COALESCE_MS, ≤ 10 frames/s per open pane; a step entry ≤ 1 KB; viewers only).
 */
interface OpenThread {
  readonly viewers: Set<string>;
  unwatch: (() => void) | undefined;
  pending: ThreadEntry[];
  timer: NodeJS.Timeout | undefined;
}

/** What the engine knows about a problem beyond its line: its kind, its one remedy, when it was first seen. */
interface ProblemMeta {
  readonly kind: ProblemKind;
  readonly remedy?: ProblemRemedy;
  readonly since: number;
}

/** The session the previous engine process left open (no closed row, no pressed stop): a Go soon after the restart resumes it. */
interface LostSession {
  readonly sessionId: string;
  /** Wall clock of its last row: when the conversation was cut. */
  readonly at: number;
  readonly usageSeconds: number;
}

const SETTINGS_FILE = "settings.json";

export class Engine extends EventEmitter<EngineEvents> {
  /** Re-read after `config.set-secrets`; everything else treats it as constant. */
  config: JarheadConfig;
  readonly ledger: Ledger;
  /** The Trash under the state dir: whole day files move there and back by rename; Jarhead never empties it (K1). */
  readonly trash: Trash;
  /** What the Trash holds, refreshed when something moves — never per snapshot. */
  private trashInfo: TrashInfo;
  /** A local-day rollover happened while a session was up: the retention sweep waits for the first quiet tick (nothing on the voice loop copies or walks folders). */
  private sweepPending = false;
  /** Agents Kevin hid from the rail (`agent.hidden` rows), sorted. */
  private hiddenAgents: readonly string[] = [];
  /** Kevin cleared the Now stream at this wall-clock ms: items at or before it are hidden from the snapshot only. */
  private nowClearedAt: number | undefined;
  /**
   * The open session's transcript. Session-timeline ms restart with every session,
   * so each gets its own: a Delegator's request window (`since(lastDelegationEnd)`)
   * over a shared one would carry every earlier utterance into a resumed session's
   * first request. Earlier sessions' utterances live in `heldTranscript`.
   */
  private transcript: Transcript = this.newTranscript();
  /** Earlier sessions' utterances, kept across a pause and a sleep: the Console shows them and a resume is reminded of them. */
  private heldTranscript: readonly TranscriptItem[] = [];
  readonly confirmations = new ConfirmationState();
  /** The one question floor over `confirmations`: every lane — the main one included — asks through it; the root keeps the slot the Delegator arms. */
  readonly desk: ConfirmationDesk;
  /** Two helper processes, one binary, one parent: `focus` acts, `background` reads and serves background threads. */
  readonly pool: HandsPool;
  /** The acting helper (`pool.focus`), under the name every caller knows. */
  readonly hands: NativeHandsProcess;
  /** One holder of the pointer, keyboard and frontmost app: Jarhead's own hands with priority, threads in turn. */
  readonly lease: FocusLease;
  readonly toolset: ComputerToolset;
  readonly agents: AgentRegistry;
  /** The main lane's runner: `thread_*` answered from the scheduler, screen tools under the lease, every acting result observed and serialized. */
  readonly runner: ThreadAwareRunner;
  /**
   * The threads: the scheduler over the one table — the main thread's record included, so "what are you doing"
   * and the snapshot's `threads` come from one place — and the warm brain pool. Spawned threads' turns never touch
   * the snapshot: one `thread.event` per change, their conversations over `thread.transcript` to viewers.
   */
  readonly threads: ThreadScheduler;
  /** The main toolset's hands: reads on the reading helper, acts on the acting one — a look never queues behind a `type`. */
  readonly splitHands: SplitHands;
  /** What the screen is like right now, from the reading helper: the observer's `now:` line reads it, the composite look reads it, the AX tick feeds it. */
  readonly screenState: ScreenStateCache;
  /** After every acting tool of any lane: the `now:` line on its result (Settings.observe, the A/B). */
  readonly observer: ActionObserver;
  /** The main lane's acting queue — one act in flight, a needs-confirmation halts the rest; each thread lane gets its own as its brain is built. */
  readonly serializer: ActingSerializer;
  /** Builds a thread's brain for the running brain kind; undefined while it cannot run a second thread (Responses, a test brain without a seam). */
  private threadFactoryOfKind: ThreadBrainFactory | undefined;
  /** The main thread's conversation for its pane (thread.open "main"): utterances, cards, steps and statuses by seq. */
  private readonly mainLog = new ThreadLog();
  /** Delegation ids already carded on the main log; a later `change` for one patches through its steps, never a second card. */
  private readonly mainCarded = new Set<string>();
  /** Thread panes some surface stepped into, by thread id. */
  private readonly openThreads = new Map<string, OpenThread>();
  /** The sleep in flight: the ear, Live and the dock saying so at once are one sleep. */
  private sleeping: Promise<void> | undefined;
  /** Ends the farewell wait early when a harder cause (Stop, the dock) lands mid-farewell. */
  private farewellEnd: (() => void) | undefined;

  private brain: Brain | undefined;
  private brainReady = false;
  private brainDetail = "not started";
  /** The local model server as last seen (`lookLocal`): on the snapshot whatever the brain kind is. */
  private localStatus: LocalServerStatus = LOCAL_NONE;
  /** The local heal timer: when the next look falls due while `brain === "local"` and no local brain is ready; 0 = disarmed. */
  private localHealAt = 0;
  /** The local server (`localServerIdentity`) that resolved the pick and still refused the start; the heal timer waits for it to change. */
  private localRefusedOn: string | undefined;
  /** The settings (`brainIdentity`) the last selection pass read; a patch that lands after that read runs one more pass. */
  private selectedAgainst: string | undefined;
  private setupProbe: { openaiKey: SetupStatus["openaiKey"]; brain: SetupStatus["brain"] } = { openaiKey: "unchecked", brain: "unchecked" };
  /** Regions Kevin circled for Jarhead; the delegator hands the unconsumed ones to the brain. */
  protected marks: ScreenMark[] = [];
  /** Captures still in flight, by mark id; the delegator waits for them before taking the marks. */
  private readonly markCaptures = new Map<string, Promise<void>>();
  /** When each consumed mark was handed over (the contract has no field for it); it ages out from here, not from when it was drawn. */
  private readonly markConsumedAt = new Map<string, number>();
  /** Conversations a surface has stepped into, by agent id: the viewers (pane tokens), and the live tail kept while any remain. */
  private readonly openConversations = new Map<string, OpenConversation>();
  /** Opens that named no viewer get one of these; a close without a viewer takes one back (the old counting behaviour). */
  private anonViewers = 0;
  /** What Jarhead durably knows about Kevin (memory-bridge.ts): never on the voice loop; the daemon reads `list` / `search` through it. */
  readonly memory: MemoryBridge;
  /** The voice and accent the open session was started with (a pick while awake is heard at the next wake). */
  private sessionVoice: string | undefined;
  private sessionAccent: Accent | undefined;
  private permissionPollAt = 0;
  private permissionFastUntil = 0;
  private permissionPolling = false;
  /** What a fresh helper process last said, per kind — the engine's own reads; the app's reports never land here. */
  private helperGrants: Partial<Record<HelperPermissionKind, Grant>> = {};
  /** Helper kinds still to prompt for, one dialog at a time; the one on screen now and how long to wait for it. */
  private promptQueue: HelperPermissionKind[] = [];
  private prompting: HelperPermissionKind | undefined;
  private promptDeadline = 0;
  private brainRestart: Promise<void> | undefined;
  private live: LiveSession | undefined;
  private delegator: Delegator | undefined;
  private settings: Settings;
  private phase: Phase = "asleep";
  private muted = false;
  private wantAwake = false;
  private connecting = false;
  /**
   * The problem lines, oldest first, capped at eight: the order and the cap of the
   * snapshot's `problems` (`typedProblems()`). `clear-problems` empties it; `problemMeta`
   * carries each line's kind, remedy and first-seen (see the "problems, typed" region).
   */
  private problems: string[] = [];
  private readonly problemMeta = new Map<string, ProblemMeta>();
  /** The disk preflight's last verdict (`checkDisk`): shots are skipped while true. */
  private diskLow = false;
  /** Wall clock of Kevin's last own input (wake, ear, Live transcript, typed line, dictation) — never Jarhead's speech or the model's actions: the presence gate reads it. */
  private lastKevinAt = 0;
  /** When the announced idle sleep falls due: fixed once announced, so the announcement itself cannot push it. */
  private sleepDeadlineAt: number | undefined;
  private diskCheckedAt = 0;
  /** While the voice reconnects after `expired` / `connection_lost`: since when, for the problem line's elapsed figure. 0 otherwise. */
  private voiceReconnectSince = 0;
  private voiceReconnectLabel = "";
  /** Wall clock of `start()`: the auto-resume window (`AUTO_RESUME_WINDOW_MS`) is measured from it. */
  private startedAt = 0;
  /** The session the previous process left open, found in the ledger at start; consumed by the first connect inside the window. */
  private lostSession: LostSession | undefined;
  /** The ledger resume happens at most once per process — and never after Kevin pressed Stop in this one. */
  private ledgerResumeUsed = false;
  /**
   * The conversation the server cut (expired, connection lost) and the reconnect has not
   * yet carried on: set at the `closed` event, taken by the connect that reopens it (the
   * 500 ms timer's, or Kevin's Go inside the window), held again when that connect fails
   * (the network still down), let go by Stop, a new conversation, or the pause's decay.
   * While set the conversation is held, as a pause holds one: memory does not read it.
   */
  private heldReconnect: PauseInfo | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private permissions: Permissions = { all: [] };
  private agentsList: AgentInfo[] = [];
  private connectorHealth: ConnectorHealth[] = [];
  private lastOutputSpeechAt = 0;
  /** The last output audio frame that reached the speaker (not gated): the voice is audible for a moment after it. */
  private lastOutputAudioAt = 0;
  private lastAddressedAt = 0;
  /**
   * The output gate: Live has no interrupt, so after a stop the voice's audio is
   * dropped here (and its transcript deltas do not count as speaking) until Kevin's
   * next input-transcript delta or OUTPUT_GATE_MS pass. Wall clock of `now()`.
   */
  private outputGateUntil = 0;
  private gatedFrames = 0;
  private readonly reflexRunner: ReflexRunner;
  /** Reflexes the ear fired in the last seconds, so Live's delegation for the same words is finished as done, not redone. */
  private readonly firedReflexes: FiredReflexes;
  /** The on-device ear: partials matched against the grammar, dictation. */
  private readonly earReflexes: EarReflexes;
  /** Wall clock of the last output frame that was audible (RMS above `AUDIBLE_OUTPUT_LEVEL`); the ear's speaking hold reads this, not every frame. */
  private lastAudibleOutputAt = 0;
  /**
   * Kevin pressed pause: the Live session is closed (the meter stops) and the
   * conversation is held here — transcript, marks, brain and hands stay warm —
   * until a resume opens a new session with the continuity, or the pause decays to
   * sleep at `sleepsAt`. Present exactly while the transport state is `paused`.
   */
  private pauseInfo: PauseInfo | undefined;
  /** Live seconds billed today by sessions already closed (from the ledger, folded as sessions close), and how many started. */
  private usageBase: UsageToday = { seconds: 0, sessions: 0 };
  /** The ledger day `usageBase` was summed for; the base is re-read when the local day changes. */
  private usageDay = "";
  /** How much of each session's usage has already been folded into `usageBase` (provisionally at detach, finally at close). */
  private readonly usageFolded = new WeakMap<LiveSession, number>();
  /** Close deadlines in flight (close() → terminate()); cleared at shutdown. */
  private readonly closeTimers = new Set<NodeJS.Timeout>();
  /** Watchdog: since when a session has been open with nobody wanting it. */
  private outlivedSince = 0;
  /** Watchdog incidents already logged (one line each). */
  private readonly watchdogSeen = new Map<string, number>();
  /** "start dictating": the ear's finals are typed into the focused field until "stop dictating". */
  private dictating = false;
  /** The frontmost app as the accessibility warm loop last saw it (avoids a helper round trip on the reflex path). */
  private frontApp = "";
  private axWarmTimer: NodeJS.Timeout | undefined;
  private axWarmBusy = false;
  private outputLevel = 0;
  private inputLevel = 0;
  private snapshotTimer: NodeJS.Timeout | undefined;
  private tickTimer: NodeJS.Timeout | undefined;
  /** The startup Dock read, armed in start(); cleared by stop(). */
  private dockAuditTimer: NodeJS.Timeout | undefined;
  /** After a Fix the Dock: when tick() reads the Dock once more to prove the tile stayed gone. 0 = nothing pending. */
  private dockRecheckAt = 0;
  /**
   * A Fix the Dock imported the clean document but `killall Dock` failed: cfprefsd holds
   * the import while the Dock process still draws both tiles (and writes its own copy back
   * on its next event), so a clean read is not the truth — the row stays, and the next
   * press owes only the restart.
   */
  private dockRestartOwed = false;
  private readonly exec: Exec;
  /** When tick() last logged process memory (the OOM watch; 0 = log on the first tick). */
  private memoryLoggedAt = 0;
  private readonly excludePids = new Set<number>();
  private readonly now: () => number;
  private sessionStartedAt = 0;
  private brainStarted: Promise<void> | undefined;
  private usageSeconds = 0;
  private contextRatio: number | undefined;

  constructor(private readonly opts: EngineOptions = {}) {
    super();
    this.now = opts.now ?? Date.now;
    this.exec = opts.exec ?? defaultExec;
    this.config = opts.config ?? readConfig();
    mkdirSync(this.config.stateDir, { recursive: true });
    this.ledger = new Ledger(this.config.stateDir);
    this.loadUsageToday();
    // The Trash asks the ledger which days hold a pinned or open conversation and records every move in it (K1).
    this.trash = new Trash(this.config.stateDir, this.ledger, { now: this.now, openSessionIds: () => this.openSessionIds(), log: (line) => log.info(line) });
    this.trashInfo = this.trash.info();
    this.hiddenAgents = this.ledger.hiddenAgents();
    this.settings = this.loadSettings();
    // The seam: a stand-in answers the helper's request lines as a fake child, so the
    // real client (pending map, timeouts, a stop's cancelPending) runs unchanged. Two
    // helpers, both spawned with Jarhead's keys stripped from the environment (the
    // client scrubs every spawn).
    this.pool = new HandsPool({
      binPath: this.config.handsBin,
      ...(opts.hands ? { spawnImpl: fakeHandsSpawn(opts.hands), assumeAvailable: true } : {}),
      ...(opts.backgroundHands ? { background: { spawnImpl: fakeHandsSpawn(opts.backgroundHands), assumeAvailable: true } } : {}),
      ...(opts.probePermissions ? { probeImpl: opts.probePermissions } : {}),
    });
    this.hands = this.pool.focus;
    this.desk = new ConfirmationDesk(this.confirmations, (name, question) => this.speakPromoted(name, question), this.now);
    // Over the ACTING helper: `user_idle` is judged against the events that helper posted itself
    // (its own typing is not Kevin's), and the re-front's `focus_app` is an acting op.
    this.lease = new FocusLease({ hands: this.pool.focus, now: this.now });
    // The main toolset reads on the reading helper and acts on the acting one (DECISIONS §11c): the gate's
    // probes, the observer's reads and the model's own looks never wait behind a `type` or an `open_app`.
    // No verdict moves — `expectFront`, `busy`, STALE_FRAME are judged in the acting helper and in the gate.
    this.splitHands = new SplitHands(this.pool);
    this.screenState = new ScreenStateCache(this.pool.background, { now: this.now });
    // The `now:` line after every acting tool (§11a): read 150 ms after it landed on the reading helper, redacted
    // like every text a model gets, off under Settings.observe = false (the A/B).
    this.observer = new ActionObserver({
      state: this.screenState,
      redact: (s) => this.runner.redactor.redact(s),
      enabled: () => this.settings.observe !== false,
      now: this.now,
      ...(opts.observeSettleMs !== undefined ? { settleMs: opts.observeSettleMs, slowSettleMs: opts.observeSettleMs } : {}),
    });
    this.serializer = new ActingSerializer();
    const toolsetBase: Omit<ToolsetOptions, "hands" | "screen" | "confirmations"> = {
      excludePids: () => [...this.excludePids, process.pid],
      annotate: (cmd) => this.emit("overlay", cmd),
      onAction: (a) => this.onAction(a),
      presenceAt: () => this.lastKevinAt || undefined,
      now: this.now,
    };
    this.toolset = new ComputerToolset({ ...toolsetBase, hands: this.splitHands, confirmations: this.desk.lane(ThreadAwareRunner.ACTOR, "Jarhead") });
    const connectors =
      opts.connectors ??
      defaultConnectors({
        claudeModel: this.settings.brainModel,
        claudeBin: this.config.claudeBin,
      });
    this.agents = new AgentRegistry(connectors);
    this.agents.onChange((list) => {
      this.agentsList = list;
      // An open conversation whose process is gone: its running calls read `interrupted`, once.
      this.settleEndedConversations(list);
      this.scheduleSnapshot();
    });
    const runnerBase: Omit<RunnerOptions, "toolset"> = {
      agents: this.agents,
      stateDir: this.config.stateDir,
      ledger: this.ledger,
      overlay: (cmd) => this.emit("overlay", cmd),
      // Self-edit: after a change to engine code passes its checks and Kevin confirms,
      // the daemon restarts on the new code (exit 75 → the app respawns it).
      requestRestart: (reason) => this.requestRestart(reason),
      socketPath: this.config.socketPath,
      selfEdit: {
        ...(this.config.codexBin ? { codexBin: this.config.codexBin } : {}),
        ...(this.config.claudeBin ? { claudeBin: this.config.claudeBin } : {}),
      },
    };
    // The table: what the last daemon left — a thread live when it died is ended `failed` with one row each,
    // and nothing acts — plus the main thread's own record, idle. Every summary, event and status line reads from it.
    const rebuilt = ThreadTable.rebuildFrom(this.ledger, { now: this.now });
    const table = rebuilt.table;
    if (!table.get(MAIN_THREAD_ID)) table.started(this.mainRecord());
    // Threads get the same runner and toolset options over their own lane (hands, Screen, desk lane), the memory
    // block and the composite look the main task gets, and the observer; the LIST of threads changing is the one
    // time the scheduler asks for a snapshot — a step or a status is one `thread.event` on the wire.
    this.threads = new ThreadScheduler({
      now: this.now,
      ledger: this.ledger,
      desk: this.desk,
      lease: this.lease,
      hands: { focus: this.pool.focus, background: this.pool.background },
      runnerOptions: () => runnerBase,
      toolsetOptions: () => toolsetBase,
      makeBrain: () => this.threadBrainFactory(),
      parentFor: (task) => this.threadParentFor(task),
      voice: () => this.threadVoice(),
      enabled: () => this.settings.threads,
      onChange: () => this.scheduleSnapshot(),
      table,
      onEvent: (e) => this.emit("event", { type: "thread.event", event: e }),
      warmThreads: () => this.settings.warmThreads,
      memory: (query, signal) => this.memory.brainBlock(query, signal),
      look: () => this.compositeLook(),
      observer: this.observer,
    });
    this.runner = new ThreadAwareRunner({ ...runnerBase, toolset: this.toolset, pool: this.threads, lease: this.lease, desk: this.desk, observer: this.observer, serializer: serializerLike(this.serializer) });
    // Durable memory (K: "jarhead preferences save across sessions"): built over the runner's
    // redactor (nothing reaches an extractor or the store unredacted), Kevin's OpenAI key when
    // there is one, and Settings.memory read live. Extraction runs from tick() only when quiet.
    this.memory = new MemoryBridge({
      stateDir: this.config.stateDir,
      ledger: this.ledger,
      now: this.now,
      redact: (s) => this.runner.redactor.redact(s),
      apiKey: () => this.config.openaiApiKey,
      // Only a key Kevin set for the brain (an LM Studio token) goes to the local server, never OPENAI_API_KEY — as the brain itself sends it.
      brainApiKey: () => (secretsPresent().brainApiKey ? this.config.brainApiKey : undefined),
      model: () => this.config.memoryModel,
      enabled: () => this.settings.memory !== false,
      // Memory follows the SETTING: under `local` it runs on the server on this Mac, and while
      // that server is down it runs on keywords and rules — never on OpenAI, whatever brain the
      // fallback is running (docs/LOCAL.md §4).
      local: () => this.localMemoryTarget(),
      onChange: () => this.scheduleSnapshot(),
      ...(opts.memory ?? {}),
    });
    // Reflexes run through the same runner as every brain call; the click pre-check asks which app is up. The
    // grammar reads the LIVE thread names from the table, and a thread verb is answered from it (`meta`).
    this.reflexRunner = new ReflexRunner({
      runner: this.runner,
      frontmostApp: () => this.frontmostAppName(),
      browserInFront: async () => BROWSER_APPS.test(this.frontApp || (await this.frontmostAppName())),
      now: this.now,
      threadNames: () => this.threads.threadNames(),
      meta: (reflex) => this.metaReflex(reflex),
    });
    this.firedReflexes = new FiredReflexes(this.now, Engine.RECONCILE_WINDOW_MS);
    this.earReflexes = new EarReflexes({
      now: this.now,
      enabled: () => this.reflexesEnabled(),
      match: (u, o) => this.matchReflex(u, o),
      run: (reflex, phrase, via) => this.runEarReflex(reflex, phrase, via ?? "ear"),
      // A spoken "stop" interrupts: work and speech end, the session stays open and listening.
      onStop: () => {
        if (this.delegator?.active || this.threads.running() > 0 || (this.now() - this.lastOutputSpeechAt < 1200 && !this.outputGated)) void this.interrupt("ear", "said");
      },
      // With ≥ 2 spawned threads live the speech is gated on the stop word and the work cut waits STOP_NAME_WAIT_MS
      // for a name; "stop the slack one" then fires the thread_stop reflex → metaReflex → stopNamed (§6). With ≤ 1
      // the ear's stop is the old one — unless Live's fragments just stopped a thread by name: the same utterance.
      liveThreads: () => this.threads.table.spawnedLiveCount(),
      recentNamedStop: () => this.delegator?.namedStopEcho("live") ?? false,
      onGateSpeech: () => this.gateSpeech("Kevin said stop"),
      // A dismissal ("go to sleep", "goodnight jarhead", "that's all"): the one sleep function, with the farewell.
      onSleep: (phrase) => void this.fallAsleep("said", { phrase, farewell: true }),
      // Room talk never sleeps it: a bare "goodnight" counts only mid-exchange (Jarhead spoke or was spoken to within
      // EXCHANGE_WINDOW_MS) — and never when the words are Jarhead's own line back through the microphone.
      addressed: (phrase) => this.now() - this.lastAddressedAt < Engine.EXCHANGE_WINDOW_MS && !this.echoOfJarhead(phrase),
      dictation: {
        active: () => this.dictating,
        start: () => this.startDictation(),
        stop: (reason) => this.stopDictation(reason),
        type: (text) => this.dictateText(text),
        newline: async (count) => {
          await this.toolset.run("key", { text: "Return", repeat: count });
        },
        deleteWord: async () => {
          await this.toolset.run("key", { text: "alt+Delete" });
        },
      },
      fired: this.firedReflexes,
      ledger: (row) => {
        this.ledger.append(row as unknown as LedgerRow);
        this.emit("reflex.fired", row);
      },
      suppressed: () => this.earHeld(),
      ...(opts.earStableMs !== undefined ? { stableMs: opts.earStableMs } : {}),
      ...(opts.earCarefulMs !== undefined ? { carefulMs: opts.earCarefulMs } : {}),
    });
    // The ear's "the voice is speaking" hold reads audible output, not output frames:
    // `audio` is emitted per ungated frame after `outputLevel` is set (see the session
    // wiring), and the API streams silence as frames too.
    this.on("audio", () => {
      if (this.outputLevel >= Engine.AUDIBLE_OUTPUT_LEVEL) this.lastAudibleOutputAt = this.now();
    });
  }

  /** A session's transcript: every finalized utterance goes on the ledger (heard / said) and out as an event. */
  private newTranscript(): Transcript {
    // The engine's clock, like every other timestamp here: a cleared Now stream compares item.at against it (K1).
    // Read lazily — the first transcript is a field initializer, built before the constructor body sets `this.now`.
    const t = new Transcript(() => this.now());
    t.onChange((item, kind) => {
      if (kind === "final") {
        this.ledger.append({ at: item.at, type: item.speaker === "kevin" ? "heard" : "said", item });
        this.emit("utterance", item);
        // The main thread's pane: every utterance as it settles (typed lines included).
        this.mainLog.append({ kind: "utterance", item });
        // Kevin's final line: the spoken memory reflexes ("remember that …", "forget that") answer with a toast; every other line is pre-embedded for the delegation that may follow.
        if (item.speaker === "kevin") {
          void this.memory.onHeard(item, this.live?.session?.id).then((toast) => {
            if (toast) this.toast(toast, "info");
          });
        }
      }
      this.scheduleSnapshot();
    });
    return t;
  }

  /** The main thread's record: the voice's own conversation, `idle` between turns; its budget is the main brain's (40 steps, 5 min). */
  private mainRecord(): Thread {
    const at = this.now();
    return { id: MAIN_THREAD_ID, name: "Jarhead", lane: "voice", status: "idle", task: "", apps: [], startedAt: at, updatedAt: at, turns: 0, steps: 0, waits: 0, budget: { steps: 40, seconds: 300 }, canSay: true, canStop: true };
  }

  /** Everything said so far, earlier sessions first: what the Console shows and a resume is reminded of. */
  private wholeTranscript(): readonly TranscriptItem[] {
    return [...this.heldTranscript, ...this.transcript.all()];
  }

  /** How many earlier utterances are kept across sessions. */
  static readonly HELD_TRANSCRIPT_ITEMS = 400;

  /** How long the voice stays muted locally after a stop when Kevin says nothing. */
  static readonly OUTPUT_GATE_MS = 2500;
  /** "Mid-exchange": Jarhead spoke or was delegated to this recently, so a bare reflex without the wake word may fire ahead of the delegation. */
  static readonly EXCHANGE_WINDOW_MS = 8000;
  /** A reflex the ear fired is "already done" for Live's delegation of the same words within this long. */
  static readonly RECONCILE_WINDOW_MS = 4000;
  /** The voice counts as speaking for this long after its last transcript delta or audio frame (the phase uses the same figure). */
  static readonly SPEAKING_WINDOW_MS = 1200;
  /** How often the frontmost window's accessibility tree is refreshed while awake, so a spoken click finds its control at once. */
  static readonly AX_WARM_MS = 500;
  /** A graceful close() unanswered for this long is terminate()d: the session bills per second while it is open. */
  static readonly CLOSE_DEADLINE_MS = 1000;
  /** The watchdog terminates a session still open this long after nobody wanted it awake. */
  static readonly WATCHDOG_OUTLIVED_MS = 2000;
  /** A pause holds the conversation at least this long before it decays to sleep (longer when idleSleepMinutes says so). */
  static readonly PAUSE_MIN_MS = 60_000;
  /** How long a stop / pause / sleep waits on the brain's own cancel before moving on. */
  static readonly CANCEL_CAP_MS = 1500;
  /** How many finished delegations the snapshot keeps across sessions (a pause and resume must not empty the Console). */
  static readonly MAX_DELEGATIONS = 50;
  /** How many utterances the snapshot's `transcript` carries (the Console's Now; the ledger holds the rest). */
  static readonly SNAPSHOT_UTTERANCES = 200;
  /** With ≥ 2 spawned threads live a stop word gates the speech at once and cuts the work this much later unless a name follows — at both sources (§6). */
  static readonly STOP_NAME_WAIT_MS = STOP_NAME_WAIT_MS;
  /** A thread pane's `append` frames are held this long and sent as one (≤ 10/s per open pane). */
  static readonly THREAD_TRANSCRIPT_COALESCE_MS = 100;

  // ------------------------------------------------------------- settings

  private settingsPath(): string {
    return join(this.config.stateDir, SETTINGS_FILE);
  }

  private loadSettings(): Settings {
    const base: Settings = {
      ...DEFAULT_SETTINGS,
      voice: this.config.liveVoice,
      brain: this.config.brain,
      brainModel: this.config.brainModel,
      effort: this.config.brainEffort,
      idleSleepMinutes: this.config.idleSleepMinutes,
    };
    if (!existsSync(this.settingsPath())) return base;
    let saved: Record<string, unknown>;
    try {
      saved = JSON.parse(readFileSync(this.settingsPath(), "utf8")) as Record<string, unknown>;
    } catch (e) {
      log.warn(`settings unreadable: ${(e as Error).message}`);
      return base;
    }
    // Only the keys Settings has; nested objects merge field-wise so a file from before a field existed still validates.
    const known: Record<string, unknown> = {};
    for (const key of SETTINGS_KEYS) if (key in saved) known[key] = saved[key];
    if ("workers" in saved && !("threads" in saved)) known["threads"] = saved["workers"]; // settings.json written before 2026-09-13 says `workers`
    const wake = known["wake"];
    const settings: Settings = { ...base, ...(known as Partial<Settings>), wake: { ...DEFAULT_WAKE, ...(typeof wake === "object" && wake !== null ? (wake as Partial<WakeSettings>) : {}) } };
    // A key Settings no longer has is written out once; a file holding only known keys is never rewritten here.
    if (Object.keys(saved).some((k) => !(SETTINGS_KEYS as readonly string[]).includes(k))) {
      try {
        writeFileSync(this.settingsPath(), JSON.stringify(settings, null, 2));
      } catch (e) {
        log.warn(`settings not rewritten: ${(e as Error).message}`);
      }
    }
    return settings;
  }

  get currentSettings(): Settings {
    return this.settings;
  }

  updateSettings(patch: SettingsPatch): void {
    const next: Record<string, unknown> = { ...this.settings };
    for (const [key, value] of Object.entries(patch)) {
      // A brain kind this build does not know would otherwise fall through selection as Responses; it is refused here, with a line.
      if (key === "brain" && value !== null && value !== undefined && !(BRAIN_KINDS as readonly unknown[]).includes(value)) {
        log.warn(`settings: unknown brain ${JSON.stringify(value)} dropped (one of ${BRAIN_KINDS.join(", ")})`);
        continue;
      }
      if (value === null) {
        // Clearing is only meaningful for optional fields; required ones keep their value.
        if (key in DEFAULT_SETTINGS) continue;
        delete next[key];
      } else if (value !== undefined) {
        next[key] = key === "wake" ? { ...DEFAULT_WAKE, ...(value as Partial<WakeSettings>) } : value;
      }
    }
    const before = this.settings;
    this.settings = next as unknown as Settings;
    // A different brain (or model / server) takes effect now, not at the next launch.
    if (this.brainStarted && (before.brain !== this.settings.brain || before.brainModel !== this.settings.brainModel || before.brainBaseUrl !== this.settings.brainBaseUrl || before.effort !== this.settings.effort)) {
      void this.restartBrain(`settings changed to ${this.settings.brain} ${this.settings.brainModel}`);
    }
    // A voice, accent or language is fixed at session.start (session.update carries only the
    // delegation), so a pick while awake is silent until the next session — say so, and where
    // the button is that reopens now (voice.reopen, Kevin-pressed only: never a paid start on a menu browse).
    if ((this.live || this.connecting) && (before.voice !== this.settings.voice || before.accent !== this.settings.accent || before.language !== this.settings.language)) {
      this.toast("voice change heard at the next wake · Switch now in Settings to hear it", "info");
    }
    try {
      writeFileSync(this.settingsPath(), JSON.stringify(this.settings, null, 2));
    } catch (e) {
      this.problem(`could not save settings: ${(e as Error).message}`);
    }
    this.scheduleSnapshot();
  }

  // ------------------------------------------------------------ lifecycle

  /** Spawn the helper, probe permissions, start the brain. Does not open a session. */
  async start(): Promise<void> {
    this.startedAt = this.now();
    this.tickTimer = setInterval(() => this.tick(), 1000);
    // What the previous process left behind: a pause to hold again, a session it was cut
    // from, a crash report to point at, a disk with no room for shots (the K3 region below).
    this.restoreFromLedger();
    this.noteCrashReports();
    this.checkDisk();
    // Retention (K1): days past the windows move to the Trash — listed in the log first; 0 = never.
    this.runSweep("startup");
    // The Dock, read once (the "one Jarhead" region below): 20 s in, when the app's own
    // launch has finished moving tiles around. A read, never a restart — that is Kevin's press.
    if (this.dockAuditable()) {
      this.dockAuditTimer = setTimeout(() => {
        this.dockAuditTimer = undefined;
        this.checkDock("startup");
      }, this.opts.dockAuditDelayMs ?? Engine.DOCK_AUDIT_DELAY_MS);
      this.dockAuditTimer.unref?.();
    }
    void this.probeHands();
    void this.agents.refresh().then((r) => {
      this.connectorHealth = r.health;
      this.agentsList = r.agents;
      this.scheduleSnapshot();
    });
    // The brain can take a while to prove its auth; nothing else should wait for it. The local
    // server is looked at first (one round of loopback probes), so an explicit `local` starts on
    // a fresh listing and every other kind's Setup can say what is running on this Mac.
    this.brainStarted = this.lookLocal()
      .then(() => this.startBrain())
      .then(async () => {
        this.setupProbe = { ...this.setupProbe, brain: this.brainReady ? "ok" : "unavailable" };
        this.armLocalHeal();
        this.scheduleSnapshot();
        // Memory's providers follow the brain setting: the bridge rebuilds only when its identity moved.
        await this.memory.relink();
        // One cheap key check at start, so Setup and the Console show the truth without a click.
        void this.probeSetup();
      });
    this.scheduleSnapshot();
  }

  // -------------------------------------------------------- the local server
  // Discovery is the engine's: one look at start, at every probe and brain restart, and — while
  // Kevin picked `local` and no local brain is ready — every LOCAL_HEAL_MS from tick(), so a server
  // opened after the daemon is picked up without a click. Read-only throughout (docs/LOCAL.md).

  /** How often the heal timer looks while `brain === "local"` and the local brain is not ready. */
  static readonly LOCAL_HEAL_MS = 60_000;

  /** One look at the local server (pinned root under `local`, else the three loopback ports); stores it and redraws. Never throws. */
  private async lookLocal(): Promise<LocalServerStatus> {
    const baseUrl = this.settings.brain === "local" ? this.settings.brainBaseUrl?.trim() || undefined : undefined;
    const ramBytes = totalmem();
    try {
      const status = this.opts.discoverLocal
        ? await this.opts.discoverLocal({ baseUrl, ramBytes })
        : await discoverLocalServer({ baseUrl, ramBytes, fetch, now: this.now, apiKey: secretsPresent().brainApiKey ? this.config.brainApiKey : undefined });
      // A look never forgets the running brain's pick while the server still lists it (discovery itself does not pick).
      const picked = this.brain instanceof LocalBrain ? this.brain.status.picked : undefined;
      this.localStatus = picked && status.models.some((m) => m.id === picked) ? { ...status, picked } : status;
    } catch (e) {
      log.debug(`local server look failed: ${(e as Error).message}`);
      this.localStatus = { ...LOCAL_NONE, ...(baseUrl ? { baseUrl } : {}), ramBytes, checkedAt: this.now() };
    }
    this.scheduleSnapshot();
    return this.localStatus;
  }

  /** Whether the running brain is the local one and ready. */
  private localBrainUp(): boolean {
    return this.brainReady && this.brain instanceof LocalBrain;
  }

  /** Arm the heal timer when Kevin picked `local` and no local brain is ready; disarm it otherwise (a ready local brain, another kind). */
  private armLocalHeal(): void {
    this.localHealAt = this.settings.brain === "local" && !this.localBrainUp() ? this.now() + Engine.LOCAL_HEAL_MS : 0;
  }

  /**
   * From tick(): the heal timer fell due — look again, and when the start would succeed restart the
   * brain onto the server. "Would succeed" is the start's own question, `resolveLocalModel` (the exact
   * id, `<id>:latest`, a unique name, the best fit — and never a listed model without tools or a cloud
   * tag), so the timer neither restarts every minute onto a pin the server cannot run nor sits out a
   * name the resolver takes. A server that resolved the pick and still refused the start is tried
   * again only once its listing, root or version moved; Kevin's Retry and a settings change try it now.
   */
  private async healLocal(): Promise<void> {
    if (this.brainRestart) return;
    const status = await this.lookLocal();
    if (this.settings.brain !== "local" || this.localBrainUp()) {
      this.armLocalHeal();
      return;
    }
    const fits = !("error" in resolveLocalModel(this.settings.brainModel.trim(), status));
    if (fits && this.localRefusedOn !== Engine.localServerIdentity(status)) await this.restartBrain("local server appeared");
    else this.armLocalHeal();
  }

  /** The local server as the heal compares it: root, flavour, version and the ids listed (a model loading or unloading is not a change). */
  private static localServerIdentity(status: LocalServerStatus): string {
    return `${status.baseUrl}|${status.flavor ?? ""}|${status.version ?? ""}|${status.models.map((m) => m.id).sort().join(",")}`;
  }

  /**
   * Where memory runs (memory-bridge.ts `local`): under `local`, the server on this Mac with the
   * brain's model as the extractor and the discovered embedding model — or `"offline"` while nothing
   * answers, so item text stays on the Mac on keywords and rules; undefined under every other kind.
   */
  private localMemoryTarget(): LocalMemoryTarget | "offline" | undefined {
    if (this.settings.brain !== "local") return undefined;
    const s = this.localStatus;
    if (!s.reachable || !s.flavor) return "offline";
    const chatModel = (this.brain instanceof LocalBrain ? this.brain.status.picked : undefined) ?? this.settings.brainModel.trim();
    const model = s.models.find((m) => m.id === chatModel);
    return {
      flavor: s.flavor,
      baseUrl: s.baseUrl,
      chatModel,
      ...(model?.contextLength !== undefined ? { chatContext: model.contextLength } : {}),
      // A thinking model reasons before its JSON unless told not to: the extractor turns it off (or down, for gpt-oss) and leaves room.
      ...(model ? { thinking: model.capabilities.includes("thinking") } : {}),
      ...(s.embedModel ? { embedModel: s.embedModel } : {}),
    };
  }

  /** Resolves once the brain has been chosen (ready or fallen back). */
  ready(): Promise<void> {
    return this.brainStarted ?? Promise.resolve();
  }

  private async probeHands(): Promise<void> {
    if (!this.hands.available) {
      this.problemOf("hands.helper", `hands helper not built (${this.config.handsBin}); run pnpm build:hands`, Engine.HANDS_REMEDY);
      return;
    }
    try {
      const hello = await this.hands.hello();
      // The greeting is a fresh process's read (the helper was just spawned): fold it like a poll.
      this.applyHelperRead(hello.permissions);
      // A helper that greets is a helper that works: whatever was said about it before is over.
      this.clearProblems("hands.helper");
    } catch (e) {
      // A restart (a grant appeared while the greeting was pending) ends the first helper on
      // purpose; the successor greets again. Only a second failure is a problem.
      if (/hands helper stopped/.test((e as Error).message) && this.hands.available) {
        try {
          const hello = await this.hands.hello();
          this.applyHelperRead(hello.permissions);
          this.clearProblems("hands.helper");
          this.scheduleSnapshot();
          return;
        } catch (again) {
          this.problemOf("hands.helper", `hands helper failed: ${(again as Error).message}`, Engine.HANDS_REMEDY);
          this.scheduleSnapshot();
          return;
        }
      }
      this.problemOf("hands.helper", `hands helper failed: ${(e as Error).message}`, Engine.HANDS_REMEDY);
    }
    this.scheduleSnapshot();
  }

  /** The one thing to press for a hands problem: a fresh helper process (`retryProblem("hands.helper")`). */
  private static readonly HANDS_REMEDY: ProblemRemedy = { label: "Restart helper", command: { type: "problem.retry", kind: "hands.helper" } };

  // ---------------------------------------------------------- permissions
  //
  // macOS TCC keys every grant on the app bundle; the daemon and the hands helper
  // are its children, so their prompts and grants are Jarhead.app's. Nothing can
  // grant a permission programmatically: "give it all permissions" is a sweep that
  // asks for every kind with a prompt, one at a time, and deep-links to System
  // Settings for the rest. The *app* runs that sweep and reads the twelve kinds only
  // its process can (microphone, speech, camera, contacts, calendars, reminders,
  // notifications, local network, Automation, the three folders); it reports them
  // here as `permission` / `permissions` messages. The engine owns the four a fresh
  // helper process can read reliably — Accessibility, Screen Recording, Input
  // Monitoring, Full Disk Access — because a resident process keeps the answer it
  // got at launch, and the app is resident.

  /** How long one prompted dialog is waited for before the next kind is asked (a denied dialog leaves no trace to read). */
  static readonly PROMPT_WAIT_MS = 30_000;

  /** The two kinds the helper can prompt for from a fresh process, in the order they are asked. */
  private static readonly HELPER_PROMPT_KINDS: readonly HelperPermissionKind[] = ["accessibility", "screenRecording"];

  /** Ask macOS for the grants (prompts appear for the responsible app). */
  async requestPermission(which: PermissionKind | "all"): Promise<void> {
    // The app owns every prompt TCC keys on it (the microphone, speech, camera, contacts,
    // calendars, reminders, notifications, the folders, Automation, and the panes that
    // only System Settings grants); it reports the grants itself. The hands helper — a
    // child of the app, so the same TCC identity — asks for the two the engine tracks
    // in-process and can prompt for from a fresh process: Accessibility and Screen
    // Recording. "all" queues those two here, one dialog at a time (two at once and the
    // second is dismissed with the first): the next is asked once the one on screen is
    // granted, or after PROMPT_WAIT_MS. The app runs the rest of the sweep.
    const kinds: HelperPermissionKind[] = which === "all" ? [...Engine.HELPER_PROMPT_KINDS] : which === "accessibility" || which === "screenRecording" ? [which] : [];
    if (kinds.length === 0) return;
    this.promptQueue = kinds.filter((k) => this.grantOf(k) !== "granted");
    this.prompting = undefined;
    if (process.env["JARHEAD_PERMISSIONS_DRY_RUN"] === "1" && this.promptQueue.length === 0) log.info(`permissions dry run: ${kinds.map((k) => Engine.PERMISSION_CATALOGUE[k].label).join(" and ")} already granted; nothing to ask`);
    await this.promptNext();
  }

  /**
   * Show the next queued dialog (or say what it would be, under JARHEAD_PERMISSIONS_DRY_RUN=1,
   * which asks nothing), then read fresh at once and closely for the next minute and a half.
   */
  private async promptNext(): Promise<void> {
    const next = this.promptQueue.shift();
    this.prompting = next;
    if (next) {
      this.promptDeadline = this.now() + Engine.PROMPT_WAIT_MS;
      const label = Engine.PERMISSION_CATALOGUE[next].label;
      const then = this.promptQueue.length ? `, then ${this.promptQueue.map((k) => Engine.PERMISSION_CATALOGUE[k].label).join(", then ")} once it lands (${Engine.PROMPT_WAIT_MS / 1000} s at most)` : "";
      if (process.env["JARHEAD_PERMISSIONS_DRY_RUN"] === "1") {
        log.info(`permissions dry run: would prompt ${label} through the hands helper${then}, then poll every 1.5 s for 90 s`);
      } else {
        try {
          await this.hands.request("permissions", { prompt: true, which: next }, 5000);
        } catch (e) {
          log.warn(`permission prompt for ${label} failed: ${(e as Error).message}`);
        }
      }
    }
    // Kevin is in a dialog or System Settings now: watch closely.
    this.permissionFastUntil = this.now() + 90_000;
    this.permissionPollAt = 0;
    await this.pollPermissions();
  }

  /**
   * The problem line for each kind the engine reads itself, raised when the grant
   * is missing and cleared when it appears. The "earlier build" hint: a System
   * Settings row made by an ad-hoc build is bound to the old cdhash — it shows on
   * and does nothing until it is removed and the app asks again.
   */
  static readonly PERMISSION_PROBLEMS: Record<HelperPermissionKind, string> = {
    accessibility: "Accessibility not granted: clicks and typing will silently do nothing until it is (if System Settings already shows Jarhead on, that row is from an earlier build — remove it and press Request)",
    screenRecording: "Screen Recording not granted: screenshots will fail until it is (if System Settings already shows Jarhead on, remove that row and press Request)",
    inputMonitoring: "Input Monitoring not granted: the keys Jarhead watches for while you circle or dictate will not arrive until it is (System Settings › Privacy & Security › Input Monitoring; if it already shows Jarhead on, that row is from an earlier build — remove it and ask again)",
    fullDiskAccess: "Full Disk Access not granted: files under Desktop/Documents/Downloads/Mail/Safari will fail with EPERM until Jarhead.app is added in System Settings › Privacy & Security › Full Disk Access (if it already shows Jarhead on, that row is from an earlier build — remove it and add the app again)",
  };

  /** What a grant that just appeared means, for the toast. */
  private static readonly GRANTED_NOTE: Record<HelperPermissionKind, string> = {
    accessibility: "hands can click and type now",
    screenRecording: "screenshots will work now",
    inputMonitoring: "the keys you press while circling reach Jarhead now",
    fullDiskAccess: "Mail, Safari and every folder are readable now",
  };

  /**
   * Every kind Jarhead asks for, as the engine describes it when the app has not
   * sent its own list (`jarhead status` without the app, a `permission` message for
   * a kind not yet listed). The app's rows win the moment they arrive. `required`
   * mirrors the app's `PermissionsKit.meta` (apps/mac/.../Permissions/Permissions.swift)
   * — the seven without which the voice, the hands or the tools do not work — so
   * `jarhead status` and Setup's `missingRequired` name the same kinds.
   */
  static readonly PERMISSION_CATALOGUE: Record<PermissionKind, Omit<PermissionInfo, "kind" | "grant" | "checkedAt">> = {
    microphone: { ask: "prompt", required: true, label: "Microphone", why: "without it Jarhead cannot hear you" },
    speechRecognition: { ask: "prompt", required: true, label: "Speech Recognition", why: "the wake word and the on-device ear run on it" },
    screenRecording: { ask: "prompt", required: true, label: "Screen Recording", why: "screenshots, and the screen Jarhead looks at" },
    accessibility: { ask: "prompt", required: true, label: "Accessibility", why: "clicks, typing, reading controls" },
    inputMonitoring: { ask: "prompt", required: true, label: "Input Monitoring", why: "the keys watched while you circle or dictate" },
    automation: { ask: "perApp", required: true, label: "Automation", why: "the browser fast path and the AppleScript tool" },
    fullDiskAccess: { ask: "settings", required: true, label: "Full Disk Access", why: "Mail, Safari, Messages and every folder without a prompt of its own" },
    notifications: { ask: "prompt", required: false, label: "Notifications", why: "a banner when a task finishes in the background" },
    camera: { ask: "prompt", required: false, label: "Camera", why: "looking at something you hold up" },
    contacts: { ask: "prompt", required: false, label: "Contacts", why: "names and addresses when you say who" },
    calendars: { ask: "prompt", required: false, label: "Calendars", why: "what is on today, adding events" },
    reminders: { ask: "prompt", required: false, label: "Reminders", why: "reading and adding reminders" },
    localNetwork: { ask: "prompt", required: false, label: "Local Network", why: "devices and servers on your network" },
    filesDesktop: { ask: "prompt", required: false, label: "Desktop folder", why: "files on your Desktop" },
    filesDocuments: { ask: "prompt", required: false, label: "Documents folder", why: "files in Documents" },
    filesDownloads: { ask: "prompt", required: false, label: "Downloads folder", why: "files in Downloads" },
  };

  private static isPermissionKind(kind: string): kind is PermissionKind {
    return Object.prototype.hasOwnProperty.call(Engine.PERMISSION_CATALOGUE, kind);
  }

  private static isHelperKind(kind: string): kind is HelperPermissionKind {
    return (HELPER_PERMISSION_KINDS as readonly string[]).includes(kind);
  }

  /** The grant the engine currently holds for a kind: its row's, "unknown" before any read. */
  private grantOf(kind: PermissionKind): Grant {
    return grantOf(this.permissions, kind);
  }

  /** One row written: the kind's row takes the grant (and the detail when given); a kind without a row gets the catalogue's. */
  private setRow(kind: PermissionKind, grant: Grant, detail?: string): PermissionInfo {
    const rows: PermissionInfo[] = [...this.permissions.all];
    const i = rows.findIndex((r) => r.kind === kind);
    const base: Omit<PermissionInfo, "grant" | "checkedAt"> = i >= 0 ? rows[i]! : { kind, ...Engine.PERMISSION_CATALOGUE[kind] };
    const row: PermissionInfo = { ...base, grant, ...(detail !== undefined ? { detail } : {}), checkedAt: this.now() };
    if (i >= 0) rows[i] = row;
    else rows.push(row);
    this.permissions = { all: rows };
    return row;
  }

  /**
   * Fold grants for the helper's kinds into the permission rows (an app row keeps its
   * label, why, ask and required; only the grant and checkedAt move; a kind the app
   * has not listed gets the catalogue row), the problem lines and the toasts. Rows the app owns are not
   * touched. `source` is "helper" for the engine's own reads — the resident helper's
   * greeting at start, or a fresh `--permissions` process on the poll — which are
   * remembered in `helperGrants` and win over the app's word from then on; it is
   * "app" for a `permission` / `permissions` message about a kind the engine has not
   * read itself yet (the helper not built, or not yet greeted), taken at face value
   * so the problem line and the restart follow it too. Returns what flipped and
   * whether an Accessibility or Screen Recording grant appeared (the resident helper
   * must be restarted to use it).
   */
  private applyHelperRead(fresh: Partial<Record<HelperPermissionKind, boolean>>, source: "helper" | "app" = "helper"): { changed: boolean; regained: boolean } {
    let changed = false;
    let regained = false;
    for (const kind of HELPER_PERMISSION_KINDS) {
      const seen = fresh[kind];
      if (seen === undefined) continue;
      const state: Grant = seen ? "granted" : "denied";
      if (source === "helper") this.helperGrants[kind] = state;
      const before = this.grantOf(kind);
      const row = this.setRow(kind, state);
      if (before === state) continue;
      changed = true;
      const text = Engine.PERMISSION_PROBLEMS[kind];
      if (state === "granted") {
        // A grant that APPEARED (denied → granted) needs a fresh helper process; the first
        // read of the daemon's life (unknown → granted) does not — restarting then would
        // cut the helper's own greeting short and report a failure that never happened.
        if ((kind === "accessibility" || kind === "screenRecording") && before === "denied") regained = true;
        this.clearProblemText(text);
        if (before !== "unknown") this.toast(`${row.label} granted — ${Engine.GRANTED_NOTE[kind]}`, "info");
      } else {
        this.problemOf(Engine.permissionProblemKind(kind), text, Engine.permissionRemedy(kind));
        if (before === "granted") this.toast(`${row.label} was revoked`, "warn");
      }
    }
    return { changed, regained };
  }

  /** A grant appeared for a connection the resident helpers made without it: restart both (no relaunch of anything else). */
  private async restartHandsAfterGrant(): Promise<void> {
    if (!this.hands.available) return;
    try {
      await this.pool.restartAll();
    } catch (e) {
      log.warn(`hands restart after grant failed: ${(e as Error).message}`);
    }
  }

  /**
   * How often a fresh helper process is asked, from the last read: 1.5 s for 90 s
   * after a prompt or an app report that disagrees with us (Kevin is in a dialog or
   * System Settings); 3 s while a kind *with a prompt* — Accessibility, Screen
   * Recording, Input Monitoring — is missing or unread; 30 s otherwise, including
   * when only Full Disk Access is missing: it has no prompt, is dragged in by hand
   * (the app watches that pane and reports the change, which reads fresh at once),
   * and a process every 3 s for the daemon's life would be the wrong price for it.
   */
  private permissionPollInterval(now: number): number {
    if (now < this.permissionFastUntil) return 1500;
    const promptKindMissing = HELPER_PERMISSION_KINDS.some((k) => Engine.PERMISSION_CATALOGUE[k].ask === "prompt" && this.grantOf(k) !== "granted");
    return promptKindMissing ? 3000 : 30_000;
  }

  /**
   * Grants change while we run — Kevin flips a switch in System Settings — and a
   * running process may never notice. So: ask a fresh helper process on a timer
   * (`permissionPollInterval`) and, when a grant appears, restart the resident helper
   * so its capture and accessibility connections are made with the new rights. No
   * relaunch. The read also moves the prompt queue on: the next queued dialog is
   * shown once the one on screen is granted, or after PROMPT_WAIT_MS.
   */
  private async pollPermissions(): Promise<void> {
    if (this.permissionPolling || !this.hands.available) return;
    const now = this.now();
    if (now - this.permissionPollAt < this.permissionPollInterval(now)) return;
    this.permissionPollAt = now;
    this.permissionPolling = true;
    let advance = false;
    try {
      const fresh = await this.hands.probePermissions();
      const { changed, regained } = this.applyHelperRead(fresh, "helper");
      if (regained) await this.restartHandsAfterGrant();
      if (changed) this.scheduleSnapshot();
      if (this.prompting && (this.grantOf(this.prompting) === "granted" || this.now() >= this.promptDeadline)) {
        this.prompting = undefined;
        advance = this.promptQueue.length > 0;
      }
    } catch (e) {
      log.debug(`permission probe failed: ${(e as Error).message}`);
    } finally {
      this.permissionPolling = false;
    }
    if (advance) await this.promptNext();
  }

  private static readonly MICROPHONE_PROBLEM = "Microphone access denied; Jarhead cannot hear you";

  /** The microphone is the app's to read: its problem line follows the grant the app reports. */
  private microphoneProblem(state: Grant): void {
    if (state === "denied") this.problemOf("permission.microphone", Engine.MICROPHONE_PROBLEM, Engine.permissionRemedy("microphone"));
    else if (state === "granted") this.clearProblemText(Engine.MICROPHONE_PROBLEM);
  }

  /** The typed kind of a missing grant: the four the contract names, `permission.other` for the rest. */
  static permissionProblemKind(kind: PermissionKind): ProblemKind {
    switch (kind) {
      case "accessibility":
        return "permission.accessibility";
      case "screenRecording":
        return "permission.screenRecording";
      case "microphone":
        return "permission.microphone";
      case "fullDiskAccess":
        return "permission.fullDiskAccess";
      default:
        return "permission.other";
    }
  }

  /**
   * The one button for a missing grant: "Request" where a prompt exists (the helper asks
   * for Accessibility and Screen Recording; the app asks for the rest), "Open pane" where
   * only System Settings grants it (Full Disk Access; a denied microphone — the app opens
   * the pane for a kind that cannot be prompted again). Both are the `request-permission`
   * command the surfaces already route (AppDelegate answers the app-owned kinds itself).
   */
  static permissionRemedy(kind: PermissionKind): ProblemRemedy {
    const ask = Engine.PERMISSION_CATALOGUE[kind].ask;
    return { label: ask === "settings" || kind === "microphone" ? "Open pane" : "Request", command: { type: "request-permission", which: kind } };
  }

  /**
   * The app's word on one of the helper's kinds. The engine's own fresh read wins
   * whenever it has one (a resident app can be reading a stale answer, and the
   * grant's problem line, toast and helper restart must follow *our* read, not the
   * app's): the row keeps the engine's grant, and a report that disagrees with it
   * makes the next tick (within a second) read fresh, then closely for a while — the
   * app usually sees a grant it just asked for a beat before our poll, and that read
   * is what clears the problem and restarts the helper. Without a read of its own
   * (the helper not built, or not greeted yet) the engine takes the app's word
   * through the same transition logic, so the problem and the restart follow it.
   */
  private applyAppWord(kind: HelperPermissionKind, state: Grant): { regained: boolean } {
    if (state === "unknown") return { regained: false };
    if (this.helperGrants[kind] === undefined) return this.applyHelperRead({ [kind]: state === "granted" }, "app");
    if (this.helperGrants[kind] !== state) {
      this.permissionFastUntil = Math.max(this.permissionFastUntil, this.now() + 90_000);
      this.permissionPollAt = 0;
    }
    return { regained: false };
  }

  /**
   * One permission as the app read it (any kind, the microphone included). The row in
   * `permissions.all` takes the grant (a kind not listed yet gets the catalogue row, so
   * `jarhead status` sees it before the app's first full list); the microphone's problem
   * line follows its grant. For the four helper kinds see `applyAppWord`: the row's grant
   * is the engine's own when it has read one; the detail and checkedAt are the app's.
   */
  setPermission(which: string, state: Grant, detail?: string): void {
    if (!Engine.isPermissionKind(which)) {
      log.debug(`permission message for an unknown kind ${which}; ignored`);
      this.scheduleSnapshot();
      return;
    }
    const word = Engine.isHelperKind(which) ? this.applyAppWord(which, state) : { regained: false };
    const grant = Engine.isHelperKind(which) ? this.grantOf(which) : state;
    this.setRow(which, grant, detail);
    if (which === "microphone") this.microphoneProblem(grant);
    this.scheduleSnapshot();
    if (word.regained) void this.restartHandsAfterGrant();
  }

  /**
   * The app's full read after a sweep or a poll: its rows become the list, in its
   * order, with its labels, one row per kind (the last wins). For the four kinds the
   * helper reads, a grant the engine knows from a fresh process wins over the app's
   * (`applyAppWord`; a disagreement reads fresh at the next tick); a helper kind the app left out
   * keeps the engine's row so the list never loses a grant it has. The microphone is
   * the app's to know.
   */
  setPermissions(all: unknown[]): void {
    const byKind = new Map<PermissionKind, PermissionInfo>();
    for (const p of all) {
      if (typeof p === "object" && p !== null && typeof (p as PermissionInfo).kind === "string" && Engine.isPermissionKind((p as PermissionInfo).kind)) {
        const info = p as PermissionInfo;
        byKind.set(info.kind, info); // a repeated kind keeps its first place and takes the last row
      }
    }
    let regained = false;
    for (const [kind, info] of byKind) if (Engine.isHelperKind(kind) && this.applyAppWord(kind, info.grant).regained) regained = true;
    const rows: PermissionInfo[] = [...byKind.values()].map((p) => (Engine.isHelperKind(p.kind) ? { ...p, grant: this.grantOf(p.kind) } : p));
    for (const kind of HELPER_PERMISSION_KINDS) {
      if (byKind.has(kind)) continue;
      const kept = this.permissions.all.find((r) => r.kind === kind);
      if (kept) rows.push(kept);
    }
    const micBefore = this.grantOf("microphone");
    this.permissions = { all: rows };
    const mic = this.grantOf("microphone");
    if (mic !== micBefore) this.microphoneProblem(mic);
    this.scheduleSnapshot();
    if (regained) void this.restartHandsAfterGrant();
  }

  /** The settings a selection reads: kind, model, server root, effort — what `updateSettings` restarts the brain for. */
  private brainIdentity(): string {
    const s = this.settings;
    return `${s.brain}|${s.brainModel}|${s.brainBaseUrl ?? ""}|${s.effort}`;
  }

  /**
   * Stop the current brain (cancelling any running task) and start the configured one. A restart asked
   * for while one runs joins it — and when the running pass had already read the settings that
   * request changed (a click during the heal timer's own restart), the pass runs once more on what
   * stands now, so the brain never ends on settings Kevin has since moved away from.
   */
  async restartBrain(reason: string): Promise<void> {
    if (this.brainRestart) return this.brainRestart;
    this.brainRestart = (async () => {
      let why = reason;
      do {
        await this.selectionPass(why);
        why = "settings changed during the restart";
      } while (this.selectedAgainst !== this.brainIdentity());
    })().finally(() => {
      this.brainRestart = undefined;
    });
    return this.brainRestart;
  }

  /** One restart: the old brain and its threads stop, the local server is looked at, the kind is selected, Live is re-bound, memory follows. */
  private async selectionPass(reason: string): Promise<void> {
    log.info(`restarting brain: ${reason}`);
    await this.delegator?.cancel("brain restarting");
    // Threads run brains of the old kind: they go with it.
    await this.bounded(this.threads.stopAll());
    const old = this.brain;
    this.brain = undefined;
    this.threadFactoryOfKind = undefined;
    this.brainReady = false;
    this.brainDetail = "restarting";
    this.setupProbe = { ...this.setupProbe, brain: "unchecked" };
    this.scheduleSnapshot();
    try {
      await old?.stop();
    } catch (e) {
      log.warn(`old brain did not stop cleanly: ${(e as Error).message}`);
    }
    const wasResponses = old instanceof ResponsesBrain;
    await this.lookLocal();
    await this.startBrain();
    this.setupProbe = { ...this.setupProbe, brain: this.brainReady ? "ok" : "unavailable" };
    this.armLocalHeal();
    if (this.live && this.brain) {
      // Live fixes the delegation target (client vs Responses) when the session
      // starts, so a swap across that line needs a fresh session; within a kind the
      // proxy carries on and a Responses brain is simply re-bound.
      const isResponses = (this.brain as Brain | undefined) instanceof ResponsesBrain;
      if (isResponses !== wasResponses) {
        this.toast("brain changed; reconnecting the voice session", "info");
        await this.fallAsleep("brain-changed");
        void this.wake("brain changed");
      } else {
        this.rebindBrain();
      }
    }
    this.scheduleSnapshot();
    // The brain setting may have moved memory's providers (local ↔ OpenAI ↔ keywords).
    await this.memory.relink();
  }

  /** Secrets go to ~/.jarhead/env; the config is re-read and the brain restarted. */
  private async setSecrets(secrets: Partial<Record<SecretKey, string | null>>): Promise<void> {
    try {
      writeEnvSecrets(secrets);
    } catch (e) {
      this.toast(`could not save keys: ${(e as Error).message}`, "error");
      return;
    }
    this.config = readConfig();
    this.setupProbe = { openaiKey: "unchecked", brain: "unchecked" };
    this.toast("keys saved", "info");
    await this.restartBrain("keys changed");
    await this.probeSetup();
  }

  /** Check the OpenAI key (the voice) and report the brain's state; never throws. */
  async probeSetup(): Promise<SetupStatus> {
    let openaiKey: SetupStatus["openaiKey"] = "missing";
    if (this.config.openaiApiKey) {
      try {
        const r = await fetch(`https://api.openai.com/v1/models/${encodeURIComponent(this.config.liveModel)}`, {
          headers: { authorization: `Bearer ${this.config.openaiApiKey}` },
          signal: AbortSignal.timeout(8000),
        });
        openaiKey = r.status === 200 ? "ok" : r.status === 401 ? "invalid" : r.status === 404 ? "ok" : "invalid";
        if (r.status === 404) this.problemOf("voice.key", `OpenAI key works but ${this.config.liveModel} is not listed for it`, Engine.SETUP_REMEDY);
        // The key answered: a missing or stale key is not the problem any more; nor is reaching the host.
        if (r.status === 200) this.clearProblems("voice.key");
        this.clearProblems("voice.connection", (t) => t.startsWith("could not reach api.openai.com"));
      } catch (e) {
        this.problemOf("voice.connection", `could not reach api.openai.com: ${(e as Error).message}`, Engine.PROBE_REMEDY);
        openaiKey = "unchecked";
      }
    }
    // The local server, for every kind: Setup says "Ollama 0.34.0 · 3 models" under the Local option before Kevin commits.
    await this.lookLocal();
    await this.ready();
    this.setupProbe = { openaiKey, brain: this.brainReady ? "ok" : "unavailable" };
    this.scheduleSnapshot();
    return this.setupNow();
  }

  private setupNow(): SetupStatus {
    return {
      openaiKey: this.setupProbe.openaiKey,
      brain: this.setupProbe.brain,
      // A brain whose state moves after start() (Codex's warm transport landing later) says so itself.
      brainDetail: this.brain?.detail ?? this.brainDetail,
      // What `auto` resolved to. startBrain() only installs brains whose `kind` is a
      // contract BrainKind; a test-injected brain (opts.brain) need not be one.
      ...(this.brainReady && this.brain && this.brain !== this.opts.brain ? { brainResolved: this.brain.kind as Exclude<Settings["brain"], "auto"> } : {}),
      liveModel: this.config.liveModel,
      secrets: secretsPresent(),
      local: this.localStatus,
      dataPaths: this.dataPathsNow(),
    };
  }

  /** The four "where words go" rows, from the one function the doctor prints too (@jarhead/core `dataPaths`). */
  private dataPathsNow(): SetupStatus["dataPaths"] {
    const resolved = this.brainReady && this.brain && this.brain !== this.opts.brain ? (this.brain.kind as Exclude<Settings["brain"], "auto">) : undefined;
    return dataPaths({
      brain: this.settings.brain,
      brainModel: this.settings.brainModel,
      ...(resolved ? { brainResolved: resolved } : {}),
      brainDetail: this.brain?.detail ?? this.brainDetail,
      local: this.localStatus,
      memory: this.memory.summary(),
      hasOpenAIKey: Boolean(this.config.openaiApiKey),
      liveModel: this.config.liveModel,
    });
  }

  private async startBrain(): Promise<void> {
    // The settings this pass selects against; a patch landing after this read is a pass of its own (restartBrain).
    this.selectedAgainst = this.brainIdentity();
    if (this.opts.brain) {
      this.brain = this.opts.brain;
      // A test brain has no second thread of its own; the `makeThreadBrain` seam stands in.
      this.threadFactoryOfKind = undefined;
      const r = await this.brain.start();
      this.brainReady = r.ready;
      this.brainDetail = r.detail;
      return;
    }
    // The rows the last selection raised go first — the amber local row, the fallback lines, the probe
    // lines (the local LAN line, the compatible key warning; nothing else raises brain.probe) — so a switch
    // of kind leaves nothing about the old one standing; what still holds is raised again below.
    this.clearProblems("brain.local");
    this.clearProblems("brain.unavailable");
    this.clearProblems("brain.probe");
    const wanted = this.settings.brain;
    // Settings.brainModel is "" for "that backend's default"; only a real id is an override.
    const model = this.settings.brainModel.trim() || undefined;
    const baseUrl = this.settings.brainBaseUrl?.trim() || this.config.brainBaseUrl;
    // Same modules as the static imports above; loaded here so this body stays self-contained.
    const { AUTO_BRAIN_ORDER } = await import("@jarhead/protocol");
    const { AnthropicBrain, CodexBrain, OpenAICompatibleBrain, probeCodex, resolveCompatibleApiKey } = await import("@jarhead/brain");
    type Kind = Exclude<Settings["brain"], "auto">;

    // One cheap look at the Codex install (binary, version, login) serves the
    // "configured?" question here and the brain's own start() below.
    const codexProbe = await probeCodex({ bin: this.config.codexBin });

    /**
     * "Configured" means Kevin did something that names this backend: a binary
     * and a login, a key, a server URL. Under `auto`, an unconfigured backend is
     * skipped with a log line only; a configured one that cannot start gets a
     * problem() line, because that is a thing he can fix.
     */
    const notConfigured = (kind: Kind): string | undefined => {
      switch (kind) {
        case "codex":
          if (!codexProbe.bin) return codexProbe.detail; // nothing installed
          if (codexProbe.version && !codexProbe.signedIn) return codexProbe.detail; // installed, never signed in
          return undefined; // signed in — or a binary that will not run, which start() reports
        case "claude-code":
          return this.config.claudeBin || this.config.anthropicApiKey || existsSync(join(process.env["HOME"] ?? "", ".claude")) ? undefined : "no claude binary, Claude login or ANTHROPIC_API_KEY on this Mac";
        case "anthropic-api":
          return this.config.anthropicApiKey ? undefined : "ANTHROPIC_API_KEY is not set";
        case "openai-compatible":
          return baseUrl ? undefined : "no server URL (Settings or JARHEAD_BRAIN_BASE_URL)";
        case "openai-responses":
          return undefined;
        case "local":
          // Never in AUTO_BRAIN_ORDER: a server another project left running is not a choice Kevin made.
          return wanted === "local" ? undefined : "only when picked (Settings › Brain › Local model)";
      }
    };

    // Every brain proves itself before it takes a task. The same builder makes a spawned
    // thread's brain over its lane runner: a Codex thread is its own app-server process with
    // one conversation, no primer (a spare's boot is a process, not a model request) and the
    // thread's id on the bridge env; the HTTP and Claude kinds are a second instance;
    // Live's own Responses delegation has no thread of its own to give.
    const build = (kind: Kind, spec?: ThreadBrainSpec): { brain: Brain; label: string; warning?: string } | undefined => {
      const runner = spec?.runner ?? this.runner;
      switch (kind) {
        case "codex":
          return {
            label: "Codex",
            brain: new CodexBrain({
              runner,
              probe: codexProbe,
              stateDir: this.config.stateDir,
              socketPath: this.config.socketPath,
              // Under `auto` another vendor's leftover id is not an override for Codex; an explicit choice keeps what Kevin set.
              ...(model && !(wanted === "auto" && foreignModel("codex", model)) ? { model } : {}),
              effort: this.settings.effort,
              // A spawned thread: its id on the bridge env (the daemon routes its tool calls to its lane), one conversation, no primer, the pool's wall clock as the backstop.
              ...(spec ? { thread: spec.threadId, primeThreads: false, maxWallMs: spec.secondsCap * 1000 } : {}),
            }),
          };
        case "claude-code":
          return {
            label: "Claude Code",
            brain: new ClaudeBrain({
              runner,
              stateDir: this.config.stateDir,
              // Under `auto` another vendor's leftover id must not sink the Claude login; an explicit choice keeps what Kevin set.
              ...(model && !(wanted === "auto" && foreignModel("claude-code", model)) ? { model } : {}),
              effort: this.settings.effort,
              ...(this.config.claudeBin ? { pathToClaudeCodeExecutable: this.config.claudeBin } : {}),
            }),
          };
        case "anthropic-api":
          return { label: "Anthropic API", brain: new AnthropicBrain({ runner, apiKey: this.config.anthropicApiKey, model, effort: this.settings.effort, ...(spec ? { maxWallMs: spec.secondsCap * 1000 } : {}) }) };
        case "openai-compatible": {
          // Only a key Kevin set for this brain (JARHEAD_BRAIN_API_KEY) goes to an arbitrary
          // host; config.brainApiKey falls back to OPENAI_API_KEY, which belongs to OpenAI alone.
          const key = resolveCompatibleApiKey({
            baseUrl,
            explicitKey: secretsPresent().brainApiKey ? this.config.brainApiKey : undefined,
            openaiKey: this.config.openaiApiKey,
          });
          return {
            label: "OpenAI-compatible",
            ...(key.warning ? { warning: key.warning } : {}),
            brain: new OpenAICompatibleBrain({ runner, baseUrl, apiKey: key.apiKey, model, ...(spec ? { maxWallMs: spec.secondsCap * 1000 } : {}) }),
          };
        }
        case "local":
          // The model on this Mac: discovered (or pinned by brainBaseUrl), Kevin's id or the best fit; only a
          // key Kevin set for this brain (an LM Studio token) ever goes to it, never OPENAI_API_KEY. A
          // thread's brain shares main's discovery and sends no thread_* tools of its own.
          return {
            label: "Local",
            brain: new LocalBrain({
              runner,
              baseUrl: this.settings.brainBaseUrl?.trim() || undefined,
              model: this.settings.brainModel.trim(),
              effort: this.settings.effort,
              threads: () => this.settings.threads && !spec,
              status: this.localStatus,
              ramBytes: this.localStatus.ramBytes || totalmem(),
              apiKey: secretsPresent().brainApiKey ? this.config.brainApiKey : undefined,
              maxWallMs: spec ? spec.secondsCap * 1000 : undefined,
              onStatus: (status) => {
                this.localStatus = status;
                this.scheduleSnapshot();
              },
            }),
          };
        case "openai-responses":
          if (spec) return undefined;
          // The model override only applies when Kevin chose this backend; under `auto` it may be another vendor's id.
          return { label: "OpenAI Responses", brain: new ResponsesBrain({ runner: this.runner, model: wanted === "openai-responses" ? model : undefined, effort: "low" }) };
      }
    };
    const threadFactoryFor = (kind: Kind): ThreadBrainFactory | undefined => (kind === "openai-responses" ? undefined : (spec) => build(kind, spec)?.brain);

    // `auto` walks the contract order (codex → claude-code → anthropic-api →
    // openai-compatible → openai-responses) and takes the first that is ready.
    // An explicit `codex` that cannot start walks on from there the same way;
    // any other explicit choice keeps its fallback below, the Live session's own
    // Responses delegation.
    const order: readonly Kind[] = wanted === "auto" || wanted === "codex" ? AUTO_BRAIN_ORDER : [wanted];
    const tried: string[] = []; // for the log: every kind passed over, and why
    const failed: string[] = []; // labels of configured backends that would not start
    let skipped = 0; // kinds that were simply not configured
    for (const kind of order) {
      // The kind Kevin asked for is always tried; the rest only when configured.
      const skip = kind === wanted ? undefined : notConfigured(kind);
      if (skip) {
        log.info(`${wanted}: skipping ${kind} (${skip})`);
        tried.push(`${kind} not configured`);
        skipped++;
        continue;
      }
      const candidate = build(kind);
      if (!candidate) continue;
      if (candidate.warning) this.problemOf("brain.probe", candidate.warning, Engine.BRAIN_REMEDY);
      const r = await candidate.brain.start();
      if (r.ready) {
        this.brain = candidate.brain;
        this.threadFactoryOfKind = threadFactoryFor(kind);
        this.brainReady = true;
        if (kind === "local") this.localBrainReady(candidate.brain as LocalBrain);
        // Landing on Responses under `auto` deserves a why: which backends broke
        // (they have a problem() line each) and whether the rest were merely absent.
        const why = [failed.length ? `${failed.join(", ")} could not start` : "", skipped ? "no other brain is signed in or configured" : ""].filter(Boolean).join("; ");
        this.brainDetail = wanted === "auto" && kind === "openai-responses" && why ? `${r.detail} (auto: ${why})` : r.detail;
        log.info(`${wanted}: using ${kind}${tried.length ? ` after ${tried.join("; ")}` : ""}`);
        return;
      }
      await candidate.brain.stop().catch(() => undefined);
      tried.push(`${candidate.label}: ${r.detail}`);
      failed.push(candidate.label);
      // A configured backend that cannot start is worth a line in the Console. For `local` the line is
      // Kevin's to act on (amber, with the command to run) and the fallback is said out loud: his brain
      // was free, and until the server is back the work bills OpenAI; memory stays on the Mac.
      if (kind === "local") {
        const problem = this.localProblem(r.detail);
        // The pick resolved and the server still refused: the heal timer waits for the server to change; Retry and a settings change do not.
        this.localRefusedOn = problem.refused ? Engine.localServerIdentity(this.localStatus) : undefined;
        this.problemOf("brain.local", problem.text, problem.remedy);
        this.problemOf("brain.unavailable", `Local brain unavailable (${r.detail}); using the OpenAI backend instead — until it is back, the brain's work goes to OpenAI too. Memory stays local.`, Engine.BRAIN_REMEDY);
        continue;
      }
      this.problemOf("brain.unavailable", `${candidate.label} brain unavailable (${r.detail}); ${order.length > 1 ? "trying the next backend" : "using the OpenAI backend instead"}`, Engine.BRAIN_REMEDY);
    }
    // An explicit choice that could not start: the Live session's own Responses delegation always can.
    const responses = new ResponsesBrain({ runner: this.runner, effort: "low" });
    const r = await responses.start();
    this.brain = responses;
    this.threadFactoryOfKind = undefined;
    this.brainReady = r.ready;
    this.brainDetail = r.detail;
  }

  /**
   * The local brain came up: the rows about it go, and what is left to say is informational —
   * a trained window under LOCAL_NUM_CTX_MIN (Jarhead's tools alone are ~11k tokens), or a
   * pinned root off this Mac (the words leave for the network). Both texts are docs/LOCAL.md §10's.
   */
  private localBrainReady(brain: LocalBrain): void {
    this.clearProblems("brain.local");
    this.clearProblems("brain.unavailable", (t) => t.startsWith("Local brain unavailable"));
    const status = brain.status;
    const id = this.settings.brainModel.trim() || status.picked || "";
    const model = status.models.find((m) => m.id === id);
    if (model?.contextLength !== undefined && model.contextLength < LOCAL_NUM_CTX_MIN) {
      this.problemOf("brain.local", `Local brain: ${model.id}'s window is ${Math.round(model.contextLength / 1024)}k tokens; Jarhead's tools alone are ~11k. Pick a larger model.`, Engine.SETUP_REMEDY);
    }
    const host = hostOf(status.baseUrl);
    if (host && !isLoopbackHost(host)) this.problemOf("brain.probe", `Local brain on ${new URL(status.baseUrl).host}: leaves this Mac for your network`);
  }

  /**
   * The amber row for a local brain that did not start, from what the last look found: the text
   * table of docs/LOCAL.md §10 — nothing answering, nothing that can call tools (with the pull to
   * run), the picked id gone (with its pull), else the resolver's own sentence. `copy` is the
   * command Kevin runs himself; no surface ever runs it. `refused`: the pick resolved and the
   * server itself turned the start down — the heal timer holds off until that server changes.
   */
  private localProblem(detail: string): { text: string; remedy: ProblemRemedy; refused?: true } {
    const status = this.localStatus;
    const pinned = this.settings.brainBaseUrl?.trim();
    if (!status.reachable) {
      const where = pinned ? `at ${hostOf(status.baseUrl) ? new URL(status.baseUrl).host : pinned}` : "on this Mac (127.0.0.1:11434, :1234, :8080)";
      return { text: `Local brain: nothing answers ${where}. Open Ollama, or install it — see docs/LOCAL.md.`, remedy: Engine.LOCAL_REMEDY };
    }
    const server = serverLabel(status);
    const wanted = this.settings.brainModel.trim();
    const resolved = resolveLocalModel(wanted, status);
    if ("error" in resolved) {
      if (!wanted) {
        if (status.flavor !== "ollama") return { text: `Local brain: ${server} is up but nothing on it can call tools. Load a model that can.`, remedy: Engine.LOCAL_REMEDY };
        const s = status.suggested ?? suggestedPull(status.ramBytes);
        return { text: `Local brain: ${server} is up but nothing on it can call tools. In a terminal: ${s.command} (${Math.round(s.sizeBytes / 1e9)} GB, fits this Mac).`, remedy: { ...Engine.LOCAL_REMEDY, copy: s.command } };
      }
      const listed = status.models.some((m) => m.id === wanted || m.id === `${wanted}:latest` || m.id.split(":")[0] === wanted);
      if (!listed && !/:cloud$|-cloud$/i.test(wanted)) {
        const have = status.models.map((m) => m.id);
        const has = have.length ? `it has ${have.slice(0, 6).join(", ")}${have.length > 6 ? ` and ${have.length - 6} more` : ""}` : "it lists nothing";
        return { text: `Local brain: ${wanted} is not on ${server} (${has}). Pull it, or pick another.`, remedy: status.flavor === "ollama" ? { ...Engine.SETUP_REMEDY, copy: `ollama pull ${wanted}` } : Engine.SETUP_REMEDY };
      }
      return { text: resolved.error, remedy: Engine.SETUP_REMEDY };
    }
    // The model resolved and the server still refused the start (a token, a 5xx): the brain's own sentence, with Retry.
    return { text: `Local brain: ${detail}`, remedy: Engine.LOCAL_REMEDY, refused: true };
  }

  /** Called by the shell when the brain fails to authenticate mid-run. */
  private async swapToResponses(reason: string): Promise<void> {
    this.problemOf("brain.unavailable", `brain failed (${reason}); switching to the OpenAI backend for the next session`, Engine.BRAIN_REMEDY);
    await this.brain?.stop();
    const responses = new ResponsesBrain({ runner: this.runner, effort: "low" });
    await responses.start();
    this.brain = responses;
    this.threadFactoryOfKind = undefined;
    this.brainReady = true;
    this.brainDetail = "responses delegation (fallback)";
  }

  // -------------------------------------------------------------- session

  // The transport: one state machine — asleep / connecting / awake / paused — and
  // three verbs. Go opens (or resumes), Pause closes the session and holds the
  // conversation, Stop closes the session and sleeps. GPT-Live-1 bills every second
  // a session is open (docs/REDESIGN.md §13), so every state but `awake` and
  // `connecting` has NO session; the watchdog in tick() enforces it.

  /**
   * The one place a session's config is built. The instructions, in this order: the
   * standing orders (instructions.ts, a rail with its own word budget), `# Language`
   * (English by default, the accent as one fragment — assembled here so the rail and its
   * budget stay untouched), `# Kevin, in brief` (≤ VOICE_MEMORY_TOKENS of durable
   * memory, when on and non-empty), and `continuity` (the "# Continuity" section a
   * resume or a reconnect appends). An engine test pins the order.
   */
  private sessionConfig(continuity?: string): SessionConfig {
    const brain = this.brain;
    const delegation =
      brain instanceof ResponsesBrain
        ? responsesDelegationConfig({ model: this.settings.brain === "openai-responses" ? this.settings.brainModel : undefined, effort: "low" })
        : ({ type: "client" } as const);
    const base = buildLiveInstructions({ alwaysOn: true });
    const language = languageSection("Kevin", this.settings.language, this.settings.accent);
    const about = this.memory.voiceBlock();
    return {
      model: this.config.liveModel,
      instructions: [base, language, about, continuity].filter((s): s is string => Boolean(s)).join("\n\n"),
      audio: { format: { type: "audio/pcm", rate: 24000 }, output: { voice: this.settings.voice } },
      delegation,
    };
  }

  /** Where the transport is. `paused` wins (a resume in flight is still "paused" until its session starts). */
  get transportState(): "asleep" | "connecting" | "awake" | "paused" {
    if (this.pauseInfo) return "paused";
    if (this.live && !this.connecting) return "awake";
    if (this.connecting) return "connecting";
    return "asleep";
  }

  /**
   * Go: wake when asleep, resume when paused, nothing when awake or connecting —
   * the transport's one button. A Go pressed after a Stop landed during the
   * handshake re-arms the connect (`wantAwake` back to true, as `wake()` does), so
   * the session that is about to start is kept instead of closed at once.
   */
  async go(): Promise<void> {
    if (this.pauseInfo) return this.resume();
    if (this.live || this.connecting) {
      if (!this.wantAwake) {
        log.info(`go: re-armed the ${this.connecting ? "connect" : "session"} a stop had disarmed`);
        this.wantAwake = true;
        if (this.connecting) this.setPhase("connecting");
        else this.recomputePhase();
        return;
      }
      log.debug(`go: already ${this.connecting ? "connecting" : "awake"}`);
      return;
    }
    return this.connect("go");
  }

  /** Open a Live session (`go`). While paused it is a resume. Idempotent while one is open or opening. */
  async wake(reason = "command"): Promise<void> {
    if (this.pauseInfo) return this.resume();
    return this.connect(reason);
  }

  /**
   * Open a session. `resume` carries the pause it continues: the config gets the
   * continuity section, the started row says `resumedFrom`, and a `resume` row
   * follows — for a pause Kevin chose, a restart that cut the conversation, or a
   * reconnect after the server dropped it (`how`; the toast says "back" for the last).
   * A stop or sleep that lands while the socket opens sets `wantAwake` false; the
   * session is then closed the moment it exists (it billed for the handshake, nothing
   * more) and the transport stays asleep.
   */
  private async connect(reason: string, resume?: { readonly pause: PauseInfo; readonly continuity: string; readonly how?: "paused" | "restarted" | "reconnected" }): Promise<void> {
    log.info(`wake requested (${reason})`);
    this.wantAwake = true;
    if (this.live || this.connecting) return;
    if (!this.config.openaiApiKey) {
      this.endVoiceReconnect();
      this.problemOf("voice.key", "OPENAI_API_KEY is missing; set it in ~/.jarhead/env (Setup › Voice writes it)", Engine.SETUP_REMEDY);
      this.setPhase("error");
      return;
    }
    this.connecting = true;
    if (!reason.startsWith("reconnect")) this.kevinSpoke();
    else this.lastAddressedAt = this.now();
    this.setPhase("connecting");
    await this.ready();
    // A brain swap in flight (keys changed, settings changed) leaves `this.brain` undefined for a moment; wire() needs it.
    if (this.brainRestart) await this.brainRestart.catch(() => undefined);
    if (!this.wantAwake) {
      this.connecting = false;
      this.setPhase("asleep");
      return;
    }
    // A fresh process whose predecessor was cut mid-conversation: the first Go inside the
    // window resumes that conversation from the ledger (the K3 region; a real pause's resume
    // arrives with its continuity already), and a conversation the server cut is carried on by
    // whichever connect comes first — the reconnect timer's or Kevin's Go (heldReconnect). Then
    // the disk: a session may open with no room for shots, but the row says so before the
    // first screenshot is skipped.
    resume ??= this.resumeFromLedger(reason) ?? this.takeHeldReconnect(reason);
    this.checkDisk();
    // What this session speaks with is fixed now; a later pick is heard at the next one.
    this.sessionVoice = this.settings.voice;
    this.sessionAccent = this.settings.accent;
    const config = this.sessionConfig(resume?.continuity);
    let live: LiveSession | undefined;
    try {
      live = this.opts.makeLive ? this.opts.makeLive(config) : new LiveSession({ apiKey: this.config.openaiApiKey, config });
      this.live = live;
      // Inside the try: a wire() that throws (no brain) must not leave `connecting` set and a never-started session attached.
      this.wire(live);
      const res = await live.start();
      const at = this.now();
      this.sessionStartedAt = at;
      this.lastAddressedAt = at;
      this.usageSeconds = 0;
      this.contextRatio = undefined;
      this.ledger.append({ at, type: "session.started", sessionId: res.id, voice: this.settings.voice, language: this.settings.language, accent: this.settings.accent, ...(resume ? { resumedFrom: resume.pause.sessionId } : {}) });
      // Grants live with the conversation: a resume continues the chain it left, a new session starts one.
      this.confirmations.beginConversation(resume ? (this.ledger.chainRootOf(resume.pause.sessionId) ?? resume.pause.sessionId) : res.id);
      this.usageBase = { ...this.usageBase, sessions: this.usageBase.sessions + 1 };
      if (!this.wantAwake) {
        // Stop (or sleep) landed while the socket was opening: close the session the moment it exists.
        log.info(`session ${res.id} started after a stop; closing it at once`);
        this.detachLive(live);
        this.closeWithDeadline(live, "stopped while connecting");
        this.setPhase("asleep");
        return;
      }
      if (resume) {
        this.ledger.append({ at, type: "resume", sessionId: res.id, resumedFrom: resume.pause.sessionId, pausedMs: at - resume.pause.at });
        this.pauseInfo = undefined;
        this.toast(resume.how === "reconnected" ? "back" : "resumed", "info");
      }
      if (this.muted) live.mute();
      this.setPhase(this.muted ? "muted" : "listening");
      // The voice is back: a reconnect's "connection lost" row (and a failed start's) is over.
      this.endVoiceReconnect();
      this.clearProblems("voice.connection");
      log.info(`session ${res.id} started (${config.delegation?.type ?? "client"} delegation${resume ? `; resumed from ${resume.pause.sessionId}` : ""})`);
      this.warmStart();
    } catch (e) {
      if (live && this.live === live) this.detachLive(live);
      if (!this.wantAwake) {
        // Closed on purpose (a stop while connecting): not a problem.
        log.info(`session start abandoned: ${(e as Error).message}`);
        this.setPhase("asleep");
      } else {
        // A reconnect that failed is not reconnecting any more: its counting row ends here, so
        // the failed start's own line (with Retry → go) stands and tick() does not rewrite it.
        this.endVoiceReconnect();
        this.voiceProblem(`could not start a Live session: ${(e as Error).message}`, Engine.GO_REMEDY);
        this.setPhase("error");
        // The conversation the server cut is not lost with the failed start: Kevin's Go (or Retry)
        // carries it on with the same continuity — the network being down is the common case here.
        if (resume?.how === "reconnected" && !this.heldReconnect) {
          this.heldReconnect = resume.pause;
          log.info(`the reconnect failed; the conversation (${resume.pause.sessionId}) is held for the next Go until ${new Date(resume.pause.sleepsAt).toISOString()}`);
        }
      }
    } finally {
      this.connecting = false;
    }
  }

  /**
   * Close a session and make sure it closes: a graceful `close()` (the server
   * finalizes usage and answers `session.closed`), and if that answer has not come
   * within the deadline, `terminate()` — the socket is dropped and the meter stops
   * regardless. The session must already be detached from `this.live`.
   */
  private closeWithDeadline(live: LiveSession, why: string): void {
    // Read through a call each time: close() changes the state under the type checker's nose.
    const closed = (): boolean => live.currentState === "closed";
    if (closed()) return;
    try {
      live.close();
    } catch (e) {
      log.warn(`${why}: close failed (${(e as Error).message}); terminating`);
      live.terminate();
      return;
    }
    if (closed()) return;
    const deadline = this.opts.closeDeadlineMs ?? Engine.CLOSE_DEADLINE_MS;
    const timer = setTimeout(() => {
      this.closeTimers.delete(timer);
      if (closed()) return;
      log.warn(`${why}: the session did not close within ${deadline} ms; terminating it so the meter stops`);
      live.terminate();
    }, deadline);
    timer.unref?.();
    this.closeTimers.add(timer);
    live.once("closed", () => {
      clearTimeout(timer);
      this.closeTimers.delete(timer);
    });
  }

  /**
   * The session is no longer ours: the very next snapshot has no `session`, its
   * events are ignored (the `closed` handler still records the row), its
   * delegations move to the kept list, and everything that only makes sense with
   * a session open ends. The pause, when there is one, survives this — it is the
   * conversation being held, not the session.
   */
  private detachLive(live: LiveSession): void {
    if (this.live !== live) return;
    // The meter never dips: what the session has billed so far counts now; the closed row adds the rest.
    this.foldUsage(live, this.usageSeconds);
    this.live = undefined;
    this.usageSeconds = 0;
    this.contextRatio = undefined;
    this.outputLevel = 0;
    this.outlivedSince = 0;
    if (this.delegator) {
      this.lastDelegations = [...this.lastDelegations, ...this.delegator.all()].slice(-Engine.MAX_DELEGATIONS);
      this.delegator.dispose();
      this.delegator = undefined;
      // The main turn went with its Delegator; the spawned threads did not (the scheduler is the engine's).
      this.threads.publish(this.threads.table.status(MAIN_THREAD_ID, "idle"));
    }
    // Whatever was still open is an utterance now (on the ledger, out as an event), and
    // this session's words move to the held record; the next session starts its own clock.
    this.transcript.settle(Number.MAX_SAFE_INTEGER);
    this.heldTranscript = [...this.heldTranscript, ...this.transcript.all()].slice(-Engine.HELD_TRANSCRIPT_ITEMS);
    this.transcript = this.newTranscript();
    if (this.dictating) this.stopDictation("asleep");
    this.outputGateUntil = 0;
    this.gatedFrames = 0;
    this.stopAxWarm();
    this.earReflexes.forgetAll();
    this.scheduleSnapshot();
  }

  /** Fold a session's billed seconds into today's base, counting each second once however many times it is reported. */
  private foldUsage(live: LiveSession, total: number): void {
    const before = this.usageFolded.get(live) ?? 0;
    if (!(total > before)) return;
    this.usageBase = { ...this.usageBase, seconds: this.usageBase.seconds + (total - before) };
    this.usageFolded.set(live, total);
  }

  /** Today's Live seconds from the ledger: closed sessions' usage, and how many sessions started. */
  private loadUsageToday(): void {
    const now = this.now();
    let seconds = 0;
    let sessions = 0;
    for (const row of this.ledger.read(now)) {
      if (row.type === "session.closed") seconds += Number(row.usageSeconds) || 0;
      else if (row.type === "session.started") sessions += 1;
    }
    // A session open across midnight is one of today's sessions too.
    if (this.live?.session) sessions += 1;
    const day = Ledger.fileNameFor(now);
    const rolled = this.usageDay !== "" && this.usageDay !== day;
    this.usageBase = { seconds, sessions };
    this.usageDay = day;
    // A new local day (K1): the retention sweep runs once, at the next tick with no session up (`runPendingSweep`); the day that just ended is today − 1 and never moves.
    if (rolled) this.sweepPending = true;
  }

  /** The meter: today's closed sessions plus what the open one has billed so far. */
  private usageToday(): UsageToday {
    const live = this.live;
    const open = live ? Math.max(0, this.usageSeconds - (this.usageFolded.get(live) ?? 0)) : 0;
    return { seconds: this.usageBase.seconds + open, sessions: this.usageBase.sessions };
  }

  /** The brain's own cancel may take a while (a Codex interrupt on a loaded Mac); nothing perceptible waits on it. */
  private bounded(p: Promise<unknown>): Promise<unknown> {
    return Promise.race([
      p,
      new Promise((r) => {
        setTimeout(r, Engine.CANCEL_CAP_MS).unref?.();
      }),
    ]);
  }

  /** A restarted brain must talk to the open Live session (Responses delegation is bound per session). */
  private rebindBrain(): void {
    if (this.live && this.brain instanceof ResponsesBrain) this.brain.bind(this.live);
  }

  /**
   * The delegator keeps one Brain for the life of the session; this forwards to
   * whichever brain is current, so a brain restart mid-session just works.
   */
  private readonly brainProxy: Brain = {
    get kind() {
      return "proxy";
    },
    start: async () => ({ ready: this.brainReady, detail: this.brainDetail }),
    handle: (task, sink) => {
      const b = this.brain;
      if (!b) return Promise.resolve({ status: "failed", summary: "the brain is restarting; ask again in a moment" } as Awaited<ReturnType<Brain["handle"]>>);
      return b.handle(task, sink);
    },
    cancel: () => this.brain?.cancel() ?? Promise.resolve(),
    stop: () => this.brain?.stop() ?? Promise.resolve(),
  };

  private wire(live: LiveSession): void {
    const brain = this.brain;
    if (!brain) throw new Error("brain not started");
    if (brain instanceof ResponsesBrain) brain.bind(live);
    this.delegator?.dispose();
    const delegator = new Delegator({
      live,
      transcript: this.transcript,
      brain: this.brainProxy,
      // Kevin hears the first acting tool as it lands ("clicking the search bar"), not
      // a narration generation before it: the model's first output is the tool call.
      voiceFirstTool: true,
      confirmations: this.confirmations,
      ledger: this.ledger,
      now: this.now,
      // Whatever Kevin circled since the last task goes in with the next one.
      marks: {
        pending: () => this.marks.filter((m) => !m.consumed),
        consume: (ids) => this.consumeMarks(ids),
        release: (ids) => this.releaseMarks(ids),
        settled: () => this.marksSettled(),
        stateDir: this.config.stateDir,
      },
      // The eyes: a quick shot of the screen as the task begins, in parallel with the marks.
      eyes: (sink) => this.lookAtScreen(sink),
      // Reflexes: one-step commands that need no brain. Not when Live's own Responses
      // backend is the brain — it would act on the same words a second time.
      ...(brain instanceof ResponsesBrain
        ? {}
        : {
            reflexes: {
              match: (u) => this.matchReflex(u),
              run: (reflex, sink) => this.runReflex(reflex, sink),
              inExchange: () => this.now() - this.lastAddressedAt < Engine.EXCHANGE_WINDOW_MS,
              // The ear may have done these words already; the delegation then only confirms.
              // The prefire check only peeks: a claim there would hide the reflex from the delegation.
              reconcile: (u) => this.reconcileReflex(u),
              peek: (u) => this.firedReflexes.peek(u),
            },
          }),
      // Paused (or dictating, or going to sleep): delegations are recorded and refused, never run.
      refuse: () => (this.paused ? "paused" : this.dictating ? "Kevin is dictating" : this.sleeping ? "going to sleep" : undefined),
      // A spoken "stop" is an interrupt: the whole of what is running and being said ends; the session stays.
      onStop: (reason) => void this.interrupt(reason, "said"),
      // …and with ≥ 2 threads live the speech half comes first, on the stop word, while the work cut waits for a name.
      onGateSpeech: () => this.gateSpeech("Kevin said stop"),
      // The session timeline's zero on the wall clock: the triggering utterance's end becomes timings.speechEndAt.
      sessionStartedAt: () => this.sessionStartedAt,
      // Live's path for a dismissal (the voice's attention gate is the addressing test there): the one sleep function.
      onSleep: (phrase) => void this.fallAsleep("said", { phrase, farewell: true }),
      // The table and the scheduler: thread verbs and follow-ups by name answered before the supersede, the 350 ms stop rule,
      // the overflow rule, the parent's drain before it finishes, Kevin's yes reaching the floor's lane.
      threads: this.delegatorThreads(),
      // The composite look for notes[0], raced with the eyes' shot; a cache read of what the reading helper already knows.
      look: () => this.compositeLook(),
      // What Jarhead knows about Kevin, ≤ BRAIN_MEMORY_TOKENS per delegation, raced at 250 ms
      // (B4 wires `DelegatorOptions.memory` and `BrainTask.memory`; spread so it typechecks before that lands).
      ...this.memoryForDelegator(),
    });
    delegator.on("change", (d) => this.onMainChange(d));
    delegator.on("step", (id, step) => this.onMainStep(id, step));
    delegator.on("settled", (id, status, summary, timings) => this.onMainSettled(id, status, summary, timings));
    delegator.on("phase", (phase) => {
      this.recomputePhase();
      this.mainPhase(phase);
    });
    delegator.on("cancelled", () => this.flushSpeaker());
    delegator.on("reflex", (label, ms, prefired) => {
      log.info(`reflex ${label} in ${ms}ms${prefired ? " (ahead of the delegation)" : ""}`);
      this.emit("reflex", label, ms, prefired);
    });
    this.delegator = delegator;

    // A session that was paused, stopped or replaced still emits for a moment (its
    // closed event, a last frame): nothing from it may touch the transport's state.
    const current = (): boolean => this.live === live;
    live.on("audio", (pcm) => {
      if (!current()) return;
      // After a stop the voice is muted here until Kevin speaks or the gate lapses:
      // the API has no interrupt, so a sentence already in flight is simply not played.
      if (this.now() < this.outputGateUntil) {
        this.gatedFrames++;
        this.outputLevel = 0;
        return;
      }
      this.outputLevel = rms(pcm);
      this.lastOutputAudioAt = this.now();
      this.emit("audio", pcm);
    });
    live.on("inputTranscript", (delta, s, e) => {
      if (!current()) return;
      if (this.outputGateUntil) this.liftOutputGate("Kevin spoke");
      this.kevinSpoke();
      this.transcript.push({ speaker: "kevin", delta, startMs: s, endMs: e });
    });
    live.on("outputTranscript", (delta, s, e) => {
      if (!current()) return;
      // What the model said goes on the record even when the gate kept it off the speaker.
      this.transcript.push({ speaker: "jarhead", delta, startMs: s, endMs: e });
      if (this.now() < this.outputGateUntil) return; // muted locally: not "speaking"
      this.lastOutputSpeechAt = this.now();
      this.lastAddressedAt = this.now();
      this.recomputePhase();
    });
    live.on("delegation", () => {
      if (!current()) return;
      this.kevinSpoke();
    });
    live.on("usage", (seconds, ratio) => {
      if (!current()) return;
      this.usageSeconds = seconds;
      this.contextRatio = ratio;
      this.scheduleSnapshot();
    });
    live.on("error", (e, cid) => {
      if (!current()) return;
      log.warn(`live error${cid ? ` (${cid})` : ""}: ${e.message}`);
      if (!/context_injection_incomplete/.test(e.message)) this.voiceProblem(`voice: ${e.message}`);
      // An error with no `closed` behind it stops the session clock; the wall clock (ORPHAN_MS, here and on every tick) finalises what was left open.
      this.transcript.settle(live.nowMs, this.now());
    });
    live.on("closed", (reason, usage) => {
      // The record and the meter, whichever session this was. A socket that never
      // reached session.started has no started row and gets no closed row.
      this.foldUsage(live, usage);
      const id = live.session?.id;
      if (id) this.ledger.append({ at: this.now(), type: "session.closed", sessionId: id, reason, usageSeconds: usage });
      // Its rows are complete: memory reads them at the next quiet tick (never while a session is up).
      if (id) this.memory.sessionClosed(id);
      if (!current()) {
        log.debug(`session ${id ?? "(never started)"} closed (${reason}, ${usage}s) after it was detached`);
        this.scheduleSnapshot();
        return;
      }
      // The open session ended under us: expired, the connection dropped, or the server closed it.
      this.detachLive(live);
      if (!id) {
        // The socket closed before session.started (refused, network down): start() rejects and connect()'s
        // catch reports the failed start once. No reconnect — it would loop every 500 ms against the same wall.
        log.debug(`session closed before it started (${reason}); leaving the failed start to connect()`);
        return;
      }
      if (this.wantAwake && !this.pauseInfo && (reason === "expired" || reason === "connection_lost")) {
        this.toast(reason === "expired" ? "session expired; reconnecting" : "connection lost; reconnecting", "warn");
        this.noteVoiceReconnect(reason === "expired" ? "session expired" : "connection lost");
        // The new session carries the conversation: the dead one's id as `resumedFrom`
        // (one chain in the Console, the grants stay), its last lines under `# Continuity`
        // (the "reconnected" wording), and a `resume` row. Usage is the closed event's
        // figure — detachLive has already zeroed the field. Sessions expire by design, so
        // without this the voice forgot the conversation mid-flow every hour.
        // Held like a pause until a connect carries it on (the timer's below, or Kevin's Go inside the
        // window): the continuity is built when that connect runs, so the gap it names is the real one;
        // it decays as a pause would, and memory does not read the conversation while it is held.
        const at = this.now();
        this.heldReconnect = { at, sessionId: id, usageSeconds: usage, sleepsAt: at + Math.max(Engine.PAUSE_MIN_MS, this.settings.idleSleepMinutes * 60_000) };
        // Re-checked when it fires: a stop or a pause in the meantime wins over the reconnect.
        this.cancelReconnectTimer();
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = undefined;
          if (this.wantAwake && !this.pauseInfo && this.heldReconnect) void this.connect(`reconnect after ${reason}`);
        }, 500);
        this.reconnectTimer.unref?.();
      } else {
        this.setPhase("asleep");
      }
    });
  }

  /** How long the voice gets for its one-word farewell before the session closes regardless. */
  static readonly FAREWELL_CAP_MS = 1800;
  /** Quiet after the farewell's first words (no transcript delta, no audible frame) before the close. */
  static readonly FAREWELL_QUIET_MS = 300;
  static readonly FAREWELL_LINE = 'Kevin dismissed you. Say exactly one word — "night." — and nothing else.';
  /** The voice said its farewell on its own (Live's path) within this long: no second one is asked for. */
  private static readonly FAREWELL_SAID_MS = 2000;

  /**
   * Sleep — the ONE closer for every cause: a spoken dismissal ("said"), the idle
   * timer, a pause that decayed, a brain swap, the blob dropped into the dock, the
   * app's sleep command, the transport's Stop (which writes its own `stop` row first)
   * and shutdown. Idempotent: the ear, Live's delegation and the dock saying so at once
   * are one sleep. Order: the `sleep` row (before the detach, so it lands in the
   * closing session's log) → everything a stop cuts (both helpers, the lease, every
   * thread, the questions, the delegation) → for a dismissal, one word from the voice
   * (FAREWELL_LINE, unless it already said "night."), waited for until its first words
   * plus FAREWELL_QUIET_MS, capped at FAREWELL_CAP_MS — the session bills meanwhile →
   * detach and close (`sleep:<cause>`) → phase asleep → toast → the thread processes
   * end. Without a farewell the phase flips before the first await, which `pressStop`
   * needs (asleep synchronously). From paused, the held conversation is let go.
   */
  fallAsleep(cause: SleepCause, o: { readonly phrase?: string | undefined; readonly farewell?: boolean | undefined } = {}): Promise<void> {
    if (this.sleeping) {
      // A harder cause mid-farewell (Stop, the dock, shutdown) does not wait for the word.
      if (cause !== "said") this.farewellEnd?.();
      return this.sleeping;
    }
    const run = (async (): Promise<void> => {
      const t0 = this.now();
      const live = this.live;
      const wasPaused = this.pauseInfo !== undefined;
      const wasConnecting = this.connecting;
      const sessionId = live?.session?.id;
      this.wantAwake = false;
      this.pauseInfo = undefined;
      // The held conversation is let go — a pause's, and the one a pending reconnect was to carry on.
      this.dropHeldReconnect();
      // Only when there is something to put to sleep: asleep already, there is nothing to record.
      const farewell = o.farewell === true && live !== undefined && !wasConnecting && live.currentState === "started" && !this.outputGated;
      if (live || wasPaused || wasConnecting) this.ledger.append({ at: t0, type: "sleep", cause, ...(o.phrase ? { phrase: o.phrase } : {}), ...(sessionId ? { sessionId } : {}), ...(farewell ? { farewell: true } : {}) });
      // Quiet: the closing session speaks for the whole stop; nothing else is appended to it.
      const { cancel } = this.cutEverything(`going to sleep (${cause})`, "sleep");
      if (farewell && live) {
        // Live's path: the voice may have said "night." before its delegation landed here — then only the word's tail is waited for.
        const said = this.transcript.last("jarhead");
        const alreadySaid = said !== undefined && t0 - said.at < Engine.FAREWELL_SAID_MS && /\b(night|sleeping)\b/i.test(said.text);
        if (!alreadySaid) live.appendInstructions(null, Engine.FAREWELL_LINE);
        await this.farewell(live, alreadySaid);
      }
      if (live && !this.connecting) {
        this.detachLive(live);
        this.closeWithDeadline(live, `sleep:${cause}`);
      }
      // A farewell's tail plays out of the app's buffer; nothing else is queued after the cut.
      if (!farewell) this.flushSpeaker();
      this.setPhase("asleep");
      if (wasPaused) log.info("pause ended: asleep");
      if (cause === "said") this.toast("night", "info");
      else if (cause === "dock") this.toast("asleep", "info");
      log.info(`asleep (${cause}${o.phrase ? `: "${o.phrase}"` : ""}${farewell ? ", after the farewell" : ""})`);
      // The thread processes — the spare too — and the brain's own cancel; neither holds anything up.
      await this.bounded(Promise.all([this.threads.stopAll(), cancel]));
      // Asleep in the notch, the weights need not sit in memory: a local brain lets them go (Ollama keep_alive 0); warmUp() reloads them at wake.
      await this.bounded((this.brain?.cool?.() ?? Promise.resolve()).catch((e: Error) => log.debug(`brain cool at sleep: ${e.message}`)));
    })();
    this.sleeping = run.finally(() => {
      this.sleeping = undefined;
      this.farewellEnd = undefined;
    });
    return this.sleeping;
  }

  /**
   * Wait for the farewell: the voice's first output-transcript delta after the
   * append, then FAREWELL_QUIET_MS with no further delta and no audible frame; or
   * FAREWELL_CAP_MS. `spoken`: the word is already out — only its tail is waited
   * for. Real timers (they pace the voice, not the session clock); every one is
   * cleared however the wait ends.
   */
  private farewell(live: LiveSession, spoken = false): Promise<void> {
    return new Promise<void>((resolve) => {
      let quiet: NodeJS.Timeout | undefined;
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(cap);
        if (quiet) clearTimeout(quiet);
        live.off("outputTranscript", onDelta);
        this.off("audio", onAudio);
        this.farewellEnd = undefined;
        resolve();
      };
      const armQuiet = (): void => {
        if (quiet) clearTimeout(quiet);
        quiet = setTimeout(finish, Engine.FAREWELL_QUIET_MS);
        quiet.unref?.();
      };
      const onDelta = (): void => armQuiet();
      // Audible frames stretch the quiet window once the word has begun; the API's silence frames do not.
      const onAudio = (): void => {
        if (quiet && this.outputLevel >= Engine.AUDIBLE_OUTPUT_LEVEL) armQuiet();
      };
      const cap = setTimeout(finish, Engine.FAREWELL_CAP_MS);
      cap.unref?.();
      live.on("outputTranscript", onDelta);
      this.on("audio", onAudio);
      this.farewellEnd = finish;
      if (spoken) armQuiet();
    });
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) {
      this.live?.mute();
      // Whatever the ear had half-heard is not a command now; nothing heard while muted is.
      this.earReflexes.quiesce();
    } else this.live?.unmute();
    this.recomputePhase();
  }

  /**
   * Mic PCM16 mono 24 kHz. Dropped while muted or paused — except during a resume's
   * handshake, when the opening session queues it until `session.started` exactly as a
   * wake does, so the first word Kevin says after pressing Go is not clipped.
   */
  feedMic(pcm: Buffer): void {
    if (this.muted || (this.paused && !this.connecting)) return;
    this.live?.appendAudio(pcm);
  }

  /** App-measured mic level, 0..1. */
  reportInputLevel(level: number): void {
    this.inputLevel = level;
  }

  /**
   * Text Kevin typed in the Console (DECISIONS §10). On the record FIRST — `Transcript.pushTyped`, so the `heard`
   * row is written and the request window, the yes check and the reflexes read typed words as they read speech —
   * then offered to the ear's grammar (a hands op within ~300 ms and the voice told it is
   * done), a typed yes armed as a spoken one is (or relayed to the thread whose question holds the floor, never
   * superseding the main turn), and finally the one instruction to Live. Typing while paused resumes first: the
   * words reach the new session. Typing while ASLEEP is REFUSED with a toast and the text kept in the composer —
   * `Settings.typedWakes` (default false): a stray Return must never open a paid session; with it on, the line
   * wakes Jarhead and reaches the new session. One log line with ms per call.
   */
  async sayText(text: string): Promise<void> {
    const t0 = performance.now();
    const t = text.trim();
    if (!t) return;
    if (this.pauseInfo) await this.resume();
    if (!this.live) {
      if (this.settings.typedWakes !== true) {
        this.toast("asleep — press Go", "warn");
        log.info(`say-text: ${t.length} chars while asleep → refused in ${Math.round(performance.now() - t0)} ms (Settings.typedWakes off; the text stays in the composer)`);
        return;
      }
      await this.wake("typed");
      if (!this.live) {
        this.toast("not sent · could not wake", "warn");
        log.info(`say-text: ${t.length} chars → the wake failed in ${Math.round(performance.now() - t0)} ms`);
        return;
      }
    }
    const live = this.live;
    this.kevinSpoke();
    const item = this.transcript.pushTyped(t, live.nowMs);
    const isYes = YES_PATTERN.test(t);
    if (isYes) {
      // A typed yes while a thread's question holds the floor is that thread's: relayed, the main turn untouched.
      const floor = this.threads.floorThread();
      if (floor && floor.id !== MAIN_THREAD_ID) {
        const r = await this.threads.answerYes(floor.id);
        if (item) this.delegator?.typedHandled(item);
        live.appendInstructions(null, r.ok ? `Kevin just typed "${t}": his yes went to ${floor.name}'s question. Say one word and wait.` : `Kevin just typed "${t}", but ${r.reason ?? "it was refused"}. Tell him in one sentence.`);
        log.info(`say-text: yes → ${floor.name} (${r.ok ? "relayed" : (r.reason ?? "refused")}) in ${Math.round(performance.now() - t0)} ms`);
        return;
      }
      // A typed yes grants the way a spoken one does: only with its ledger row.
      this.confirmations.arm((g) => this.ledger.append({ at: this.now(), type: "grant", chainId: this.confirmations.conversationId, app: g.app, actionClass: g.actionClass, until: g.until }));
    }
    // The reflex first (M5): the hands act before the voice has decided anything; the instruction then says so,
    // and the words are done with (they must not ride into the next spoken request).
    let did: string | undefined;
    let meta = false;
    if (!isYes) {
      const outcome = await this.earReflexes.typed(t, this.now());
      if (outcome?.ok) {
        meta = outcome.reflex.meta === true;
        // A meta reflex's answer (a status line from the table, the clock) travels by this instruction ALONE — the ear's
        // path did not speak it as an aside for a typed line — so Live says it once; a named stop has no line of its own.
        did = meta ? (outcome.result.kind === "text" ? outcome.result.text : "") : outcome.reflex.said || outcome.reflex.label;
        if (item) this.delegator?.typedHandled(item);
      }
    }
    const typed = `Kevin just typed (treat it exactly like speech): "${t}".`;
    live.appendInstructions(
      null,
      did === undefined
        ? `${typed} Respond to it now; delegate if it asks for anything the backend does.`
        : meta
          ? did
            ? `${typed} Jarhead already answered it: "${did}" Say that to Kevin, in these words, and wait.`
            : `${typed} Jarhead already handled it. Say one word and wait.`
          : `${typed} Jarhead already did it: ${did} Say one word, or the answer, and wait.`,
    );
    log.info(`say-text: ${t.length} chars → ${live.session?.id ?? "(connecting)"} in ${Math.round(performance.now() - t0)} ms${did !== undefined ? ` (reflex: ${(did || "handled").slice(0, 60)})` : ""}`);
  }

  /**
   * What every stop begins with, whichever verb it is: within a frame or two
   * everything Kevin can perceive ends. The speaker is flushed, the hands' pending
   * request is dropped so a late answer never acts, background jobs this task
   * started are stopped, the question the task asked is cleared (a later "yes"
   * must not arm it), a dictation ends, the ear holds its segment with every word
   * consumed (the recogniser's late partial for the words he just stopped must not
   * run them again), and the running delegation is cancelled — finished before the
   * brain's own cancel is awaited, which the caller caps.
   */
  private cutEverything(reason: string, abortReason: string): { running: Delegation | undefined; dropped: number; jobs: number; cancel: Promise<unknown> } {
    const running = this.delegator?.active;
    this.gatedFrames = 0;
    this.flushSpeaker();
    // Both helpers' pending requests (each signals its own in-flight type), the lease, every thread, the acting queue.
    const dropped = this.pool.cancelAll(reason);
    this.lease.cancelAll(reason);
    const threads = this.threads.cancelAll(reason);
    this.serializer.drain(reason);
    const { jobs } = this.runner.abortTask(abortReason);
    // The question on the floor and every queued one go; the grants sleep until the same conversation resumes.
    this.confirmations.clear();
    this.desk.clear();
    if (this.dictating) this.stopDictation("said");
    this.earReflexes.quiesce();
    // Quiet: the caller's one instruction (interrupt) or the closing session (stop, pause) speaks for the whole stop.
    const cancel = Promise.all([this.delegator?.cancel(reason, { quiet: true }) ?? Promise.resolve(), threads]);
    return { running, dropped, jobs, cancel };
  }

  /**
   * Interrupt — a spoken "stop" / "cancel" / "never mind" (the ear's and the
   * Delegator's `onStop`, which run after the fragment's other listeners so the
   * gate set here is not lifted by the words that asked for it) and the
   * `interrupt` command. Work and speech end, the session stays open and
   * listening: the voice is gated locally (Live cannot be interrupted) until Kevin
   * speaks or OUTPUT_GATE_MS pass, told once to stop speaking and wait, and a toast
   * says "stopped". A `stop` ledger row (how said/pressed) names the cut delegation.
   */
  async interrupt(source = "interrupt", how: "pressed" | "said" = "said"): Promise<void> {
    const t0 = this.now();
    const reason = `Kevin ${how} stop`;
    const open = this.openSession();
    // The gate first, so a frame arriving between here and the flush is dropped too.
    if (open) this.outputGateUntil = t0 + Engine.OUTPUT_GATE_MS;
    await this.cutWork(source, how, reason, open, t0);
  }

  /** Only a session that has started is spoken to: one still opening has no id for the row and would hear "stop speaking" as its first instruction after session.started. */
  private openSession(): LiveSession | undefined {
    return !this.connecting && this.live?.session ? this.live : undefined;
  }

  /**
   * The SPEECH half of a stop on its own (§6): the voice gated locally until Kevin's next words or OUTPUT_GATE_MS,
   * the speaker flushed. The Delegator's fragment path and the ear call it the moment a stop word lands with two
   * or more threads live, while the WORK cut waits STOP_NAME_WAIT_MS for a name; `interrupt` is the two halves at once.
   */
  gateSpeech(reason: string): void {
    const open = this.openSession();
    if (!open) return;
    this.outputGateUntil = this.now() + Engine.OUTPUT_GATE_MS;
    this.gatedFrames = 0;
    this.flushSpeaker();
    this.recomputePhase();
    log.info(`speech gated (${reason}) for ${Engine.OUTPUT_GATE_MS} ms; the work cut waits for a name`);
  }

  /** The WORK half of a stop: everything a stop cuts, the `stop` row, the one instruction, the toast — the brain's own cancel capped. */
  private async cutWork(source: string, how: "pressed" | "said", reason: string, open: LiveSession | undefined, t0: number): Promise<void> {
    const { running, dropped, jobs, cancel } = this.cutEverything(reason, "stop");
    if (open || running) this.ledger.append({ at: t0, type: "stop", how, ...(running ? { cancelled: running.id } : {}) });
    open?.appendInstructions(null, `${reason}. Stop speaking now and wait.`);
    this.toast(open || running || jobs ? "stopped" : "nothing running", "info");
    this.recomputePhase();
    await this.bounded(cancel);
    log.info(`interrupt (${source}, ${how}) in ${this.now() - t0}ms: ${running ? `cancelled ${running.id}` : "nothing was running"}; ${dropped} hands request(s) dropped; ${jobs} background job(s) stopped; voice gated for ${Engine.OUTPUT_GATE_MS} ms`);
  }

  /**
   * Stop — the transport's stop: the Stop button, ⌥⎋, `jarhead cmd stop`, the
   * `stop` command. Everything an interrupt cuts, then the session is closed so
   * the meter stops and the transport is asleep — synchronously: the phase is
   * `asleep` and the snapshot has no session before anything is awaited. From
   * paused the held conversation is let go. From asleep it still stops background
   * jobs; "nothing running" is the toast only when nothing at all happened. During
   * a connect, `wantAwake` false makes connect() close the session the moment it
   * starts. Ledger: a `stop` row (how pressed, the cut delegation), then the
   * session's own `session.closed` row when the close is answered.
   */
  async pressStop(source = "stop"): Promise<void> {
    const t0 = this.now();
    const live = this.live;
    const wasPaused = this.pauseInfo !== undefined;
    const wasConnecting = this.connecting;
    // A reconnect pending after expired / connection_lost (the 500 ms window, or the row still
    // counting): the session is detached and not yet connecting, but something is running.
    const wasReconnecting = this.voiceReconnectSince > 0;
    const threadsRunning = this.threads.running() > 0;
    this.wantAwake = false;
    // Kevin's Stop wins over a restart's resume: the conversation the previous process was
    // cut from is not picked up by the next Go once he has said stop in this one — nor the
    // one the server cut and the reconnect still held.
    this.ledgerResumeUsed = true;
    this.lostSession = undefined;
    this.dropHeldReconnect();
    const { running, dropped, jobs, cancel } = this.cutEverything("Kevin pressed stop", "stop");
    this.endVoiceReconnect();
    // The stop row is written whenever there was something to stop — a pending reconnect
    // included, so the next process reads Kevin's word and does not resume the cut session.
    const happened = live !== undefined || wasConnecting || wasPaused || wasReconnecting || running !== undefined || threadsRunning || jobs > 0;
    if (happened) this.ledger.append({ at: t0, type: "stop", how: "pressed", ...(running ? { cancelled: running.id } : {}) });
    // The closing half is the one sleep function's (its own row after the stop row, the pause let go,
    // detach and close, phase asleep before the first await); the cut above makes its cut a no-op.
    const sleeping = this.fallAsleep("stop");
    this.toast(happened ? "stopped" : "nothing running", "info");
    await sleeping;
    await this.bounded(cancel);
    log.info(`stop (${source}) in ${this.now() - t0}ms: ${live ? `session ${live.session?.id ?? "(connecting)"} closed` : wasPaused ? "pause ended" : "no session"}; ${running ? `cancelled ${running.id}` : "nothing was running"}; ${dropped} hands request(s) dropped; ${jobs} background job(s) stopped`);
  }

  /** The gate ends early when Kevin speaks; the clock ends it otherwise. */
  private liftOutputGate(why: string): void {
    if (!this.outputGateUntil || this.paused) return;
    if (this.now() < this.outputGateUntil) log.debug(`output gate lifted (${why}) after dropping ${this.gatedFrames} frame(s)`);
    this.outputGateUntil = 0;
    this.gatedFrames = 0;
  }

  /** True while the voice is being muted locally after a stop. */
  get outputGated(): boolean {
    return this.now() < this.outputGateUntil;
  }

  /**
   * The eyes' pre-warm shot: the display under the cursor at the quick budget,
   * archived like every screenshot (it is this delegation's first step) and handed
   * to the brain as an attachment. Nothing when the brain is Live's own Responses
   * delegation (it is already answering; there is nowhere to put an image first)
   * or when there are no hands.
   */
  private async lookAtScreen(sink: BrainSink): Promise<BrainAttachment | undefined> {
    if (this.brain instanceof ResponsesBrain) return undefined;
    // A text-only model (a local one without vision) has nowhere to put the pixels: no pre-warm shot for it.
    if (this.brain?.acceptsImages === false) return undefined;
    if (!this.hands.ready && !this.hands.available) return undefined;
    this.runner.attach(sink);
    try {
      const out = await this.runner.run("screenshot", { quick: true });
      if (out.result.kind !== "image" || !out.screenshotPath) return undefined;
      return { path: join(this.config.stateDir, out.screenshotPath), mediaType: "image/png", note: screenNote(out.result.width, out.result.height, out.result.note), kind: "screen" };
    } finally {
      this.runner.attach(undefined);
    }
  }

  /** A reflex through the runner, its steps in the delegation when there is one (a prefire has none yet). */
  private async runReflex(reflex: Reflex, sink?: BrainSink): Promise<ReflexOutcome> {
    if (sink) this.runner.attach(sink);
    try {
      return await this.reflexRunner.run(reflex);
    } finally {
      if (sink) this.runner.attach(undefined);
    }
  }

  private async frontmostAppName(): Promise<string> {
    try {
      const r = await this.toolset.run("frontmost_app", {});
      return r.kind === "text" ? String((JSON.parse(r.text) as { app?: string }).app ?? "") : "";
    } catch {
      return "";
    }
  }

  // -------------------------------------------------------------- threads
  // The scheduler lives in ./threads/; the engine gives it what only the engine knows — the delegation behind a
  // task, the parent's voice, the brain kind's factory, the two helpers, the memory block, the composite look —
  // and answers the thread verbs, the thread.* commands and the panes from its table.

  /** The runner a `tool.run {thread}` frame lands on (the daemon's `runnerFor`); undefined for a thread nobody owns — refused there. */
  runnerFor(threadId: string): ToolRunner | undefined {
    return this.threads.runnerFor(threadId);
  }

  /**
   * The desk promoted a queued question onto the floor. A thread's is spoken with its
   * name by the scheduler ("Spotify asks: …"). The MAIN lane's ("Jarhead") has no thread to
   * speak for it — its brain was told to wait, and may be blocked in thread_wait or done
   * — so Jarhead asks in its own words on the delegation under way (running or draining;
   * Jarhead's own line, never gated), else through the voice's instructions. Either way
   * the question Kevin's next yes lands on is the one he heard, and no other.
   */
  private speakPromoted(name: string, question: string): void {
    if (this.threads.speakQuestion(name, question)) return;
    const d = this.delegator?.active;
    if (d) this.delegator?.threadSay(d.id, "Jarhead", `May I ${question}? Say yes.`);
    else this.live?.appendInstructions(null, `Your earlier question is Kevin's to answer now. Ask him: "${question}".`);
  }

  /** The delegation a main-lane task belongs to, with Kevin's words for the thread's gates; a thread of main's sits at depth one. */
  private threadParentFor(task: BrainTask | undefined): ThreadParent | undefined {
    if (!task) return undefined;
    const d = this.delegator?.all().find((x) => x.liveId === task.delegationId && x.status === "running");
    if (!d) return undefined;
    return { id: d.id, liveId: d.liveId, request: task.request, ...(task.kevinDialogue !== undefined ? { kevinDialogue: task.kevinDialogue } : {}), offsetMs: task.offsetMs, threadId: MAIN_THREAD_ID, depth: 0 };
  }

  /**
   * How a thread's lines reach the parent delegation: the Delegator's own hooks — the
   * parent's `say(text, false)` and 600 ms coalescer while the parent runs or drains, and
   * the record's own Live id (`Thread.liveId`) once its slot has closed.
   */
  private threadVoice(): ThreadVoice | undefined {
    return this.delegator;
  }

  /** The factory the scheduler builds a thread's brain with; each lane gets its own acting queue (I1: one act in flight PER lane). */
  private threadBrainFactory(): ThreadBrainFactory | undefined {
    const inner = this.opts.makeThreadBrain ?? this.threadFactoryOfKind;
    if (!inner) return undefined;
    return (spec) => {
      if (spec.runner instanceof LaneRunner) spec.runner.setHooks({ serializer: serializerLike(new ActingSerializer()) });
      return inner(spec);
    };
  }

  /**
   * "stop the Slack one" — the ear's, the Delegator's fragment path's, a thread verb's, a typed line's: that live
   * thread alone, by Kevin, with a toast. `via` says which source served it; the Delegator is told, so Live's
   * delegation for the same words says and stops nothing twice, and Live's fragments echoing the ear's named
   * stop (or the ear's partial echoing Live's) cut nothing Kevin did not name — the two sources hear one utterance.
   */
  async stopNamed(name: string, how: "said" | "pressed" = "said", via: "ear" | "live" | "other" = "other"): Promise<boolean> {
    const t = this.threads.table.byNameLive(name);
    if (!t) return false;
    // The fact BEFORE the stop is awaited: the other source's word for the same utterance may land while the thread's
    // turn is being ended (the stop publishes `stopped` first, then waits on its brain), and must find it already noted.
    this.delegator?.noteNamedStop(t.name, via);
    const cut = await this.threads.stop(t.id, "kevin");
    if (cut) this.toast(`${t.name} stopped`, "info");
    log.info(`stop ${t.name} (${how}, ${via}): ${cut ? "stopped" : "had already finished"}`);
    return cut;
  }

  /**
   * The Delegator's view of the threads (`DelegatorOptions.threads`): names, lines, verbs, the overflow hooks, the
   * parent's drain and Kevin's yes to the floor's lane — all from the table and the scheduler.
   */
  private delegatorThreads(): DelegatorThreads {
    const t = this.threads;
    const live = (name: string): Thread | undefined => t.table.byNameLive(name);
    return {
      drain: (id, signal) => t.drain(id, signal),
      running: (id) => t.running(id),
      resume: (threadId) => t.resume(threadId),
      inExchange: () => this.now() - this.lastAddressedAt < Engine.EXCHANGE_WINDOW_MS,
      liveNames: () => t.threadNames(),
      recentNames: () =>
        t
          .threads()
          .filter((x) => x.id !== MAIN_THREAD_ID && THREAD_TERMINAL.has(x.status))
          .map((x) => x.name),
      byNameLive: (name) => {
        const x = live(name);
        return x ? { id: x.id, name: x.name } : undefined;
      },
      statusLine: (name) => t.statusLine(name),
      followUp: (id, request, o) => t.followUp(id, request, o),
      stopNamed: (name) => this.stopNamed(name, "said", "live"),
      floorThread: () => t.floorThread(),
      pauseNamed: async (name) => {
        const x = live(name);
        return x ? t.pause(x.id, "kevin") : false;
      },
      resumeNamed: async (name) => {
        const x = live(name);
        if (!x || x.status !== "paused") return false;
        await t.resume(x.id);
        return true;
      },
      overflow: () => (this.settings.threadOverflow === "spawn" ? "spawn" : "supersede"),
      appClaimed: (app) => t.table.byApp(app).length > 0,
      spawn: (parentDelegationId, name, task) => this.spawnOverflow(parentDelegationId, name, task),
    };
  }

  /** The overflow rule's spawn (Settings.threadOverflow = "spawn"): a thread named after the app, under the running delegation, on the screen lane. */
  private spawnOverflow(parentDelegationId: string, name: string, task: string): boolean {
    const d = this.delegator?.all().find((x) => x.id === parentDelegationId && x.status === "running");
    if (!d) return false;
    const r = this.threads.start({ id: d.id, liveId: d.liveId, request: task, offsetMs: d.offsetMs, threadId: MAIN_THREAD_ID, depth: 0 }, { name, task, lane: "screen" });
    if (r.kind !== "text") log.info(`overflow thread ${name} refused: ${r.kind === "error" ? r.message : r.kind}`);
    return r.kind === "text";
  }

  /**
   * Whose words a meta reflex is being run for right now: set by `runEarReflex` around the ReflexRunner's call,
   * read by `metaReflex` on entry (the runner calls the meta hook before its first await, so nothing interleaves).
   */
  private metaVia: "ear" | "typed" | "other" = "other";

  /**
   * A meta reflex from the ear — a thread verb — answered from the table: zero generations, no hands. A named stop
   * answers an empty text (the scheduler speaks "<Name> stopped." itself) — also when the name was stopped a moment
   * ago by the other source (the same utterance heard twice is answered once); the rest is the line Kevin hears.
   */
  private async metaReflex(reflex: Reflex): Promise<ToolResult> {
    const via = this.metaVia;
    const t = this.threads;
    const name = typeof reflex.input["name"] === "string" ? reflex.input["name"] : undefined;
    switch (reflex.kind) {
      case "thread_status":
        return { kind: "text", text: t.statusLine(name) };
      case "thread_list":
        return { kind: "text", text: t.statusLine() };
      case "thread_stop":
        if (!name) return { kind: "error", message: "no thread named" };
        if (await this.stopNamed(name, "said", via === "ear" ? "ear" : "other")) return { kind: "text", text: "" };
        return this.delegator?.stoppedByNameRecently(name) ? { kind: "text", text: "" } : { kind: "text", text: t.statusLine(name) };
      case "thread_pause": {
        const x = name ? t.table.byNameLive(name) : undefined;
        return x && (await t.pause(x.id, "kevin")) ? { kind: "text", text: `${x.name} paused.` } : { kind: "text", text: t.statusLine(name) };
      }
      case "thread_resume": {
        const x = name ? t.table.byNameLive(name) : undefined;
        if (x && x.status === "paused") {
          await t.resume(x.id);
          return { kind: "text", text: `${x.name} resumed.` };
        }
        return { kind: "text", text: t.statusLine(name) };
      }
      default:
        return { kind: "error", message: `not a reflex: ${reflex.kind} is not the engine's to answer` };
    }
  }

  /**
   * Jarhead's own line with no delegation of its own to carry it (a thread verb answered from the ear): on the
   * delegation under way when there is one — never gated, through the 600 ms coalescer — else the voice is told
   * to say it now. Never a generation.
   */
  private speakAside(text: string): void {
    const line = text.trim();
    if (!line) return;
    const d = this.delegator?.active;
    if (d && this.delegator) {
      this.delegator.threadSay(d.id, "Jarhead", line);
      return;
    }
    this.live?.appendInstructions(null, `Say this to Kevin now, in these words: "${line}" Then wait.`);
  }

  // ---- the main thread's record: idle between turns, thinking/acting with the Delegator's phase, a question while one waits.

  private onMainChange(d: Delegation): void {
    const fresh = !this.mainCarded.has(d.id);
    if (fresh) {
      this.mainCarded.add(d.id);
      if (this.mainCarded.size > 400) {
        const oldest = this.mainCarded.values().next().value;
        if (oldest !== undefined) this.mainCarded.delete(oldest);
      }
      this.mainLog.append({ kind: "delegation", delegation: d });
      this.threads.publish(this.threads.table.turn(MAIN_THREAD_ID, d.id, d.request));
    }
    // Every change rebuilds the snapshot: the Console's cards read their steps from it.
    this.scheduleSnapshot();
  }

  private onMainStep(id: string, step: DelegationStep): void {
    this.mainLog.append({ kind: "step", delegationId: id, step });
    // A thread's line on the parent's record is the thread's, not a step of main's.
    if (step.thread) return;
    if (step.kind !== "tool" && step.kind !== "screenshot" && step.kind !== "confirm" && step.kind !== "error") return;
    this.threads.publish(
      this.threads.table.step(MAIN_THREAD_ID, {
        ...(step.tool ? { tool: step.tool.name, ok: step.tool.ok } : {}),
        ...(step.kind === "screenshot" ? { screenshot: true } : {}),
        ...(step.screenshotPath ? { screenshotPath: step.screenshotPath } : {}),
      }),
    );
    if (step.kind === "confirm" && step.text) this.threads.publish(this.threads.table.question(MAIN_THREAD_ID, step.text));
  }

  private onMainSettled(id: string, status: DelegationStatus, summary: string | undefined, timings: DelegationTimings): void {
    this.mainLog.append({ kind: "status", delegationId: id, status, ...(summary !== undefined ? { summary } : {}), timings });
  }

  /** The Delegator's phase on the main record — `idle` reads `waiting-kevin` while the main lane's question holds the floor. */
  private mainPhase(phase: "thinking" | "acting" | "idle"): void {
    const status = phase === "idle" && this.desk.floor?.laneId === ThreadAwareRunner.ACTOR ? "waiting-kevin" : phase;
    this.threads.publish(this.threads.table.status(MAIN_THREAD_ID, status));
  }

  // ---- the thread.* commands (the Console's panes, the satellites' drops, the CLI).

  /** `thread.stop {threadId}`: "main" parks the main turn — its threads carry on, never the interrupt; a spawned thread (by id or live name) is stopped by Kevin. */
  private async stopThread(threadId: string): Promise<void> {
    if (threadId === MAIN_THREAD_ID) {
      const running = this.delegator?.active;
      if (!running || !this.delegator) {
        this.toast("nothing running on the main thread", "info");
        return;
      }
      await this.delegator.parkRunning("Kevin stopped this thread", { status: "cancelled", summary: "Kevin stopped this thread" });
      this.toast("main thread stopped", "info");
      log.info(`thread.stop main: parked ${running.id}; the threads carry on`);
      return;
    }
    const t = this.threads.get(threadId) ?? this.threads.table.byNameLive(threadId);
    const cut = t ? await this.threads.stop(t.id, "kevin") : false;
    this.toast(!t ? "no such thread" : cut ? `${t.name} stopped` : `${t.name} had already finished`, t ? "info" : "warn");
  }

  private async pauseThread(threadId: string): Promise<void> {
    if (threadId === MAIN_THREAD_ID) {
      this.toast("the main thread pauses with the transport (Pause)", "info");
      return;
    }
    const t = this.threads.get(threadId) ?? this.threads.table.byNameLive(threadId);
    const ok = t ? await this.threads.pause(t.id, "kevin") : false;
    this.toast(!t ? "no such thread" : ok ? `${t.name} paused` : `${t.name} is not running`, t ? "info" : "warn");
  }

  private async resumeThread(threadId: string): Promise<void> {
    if (threadId === MAIN_THREAD_ID) return this.resume();
    const t = this.threads.get(threadId) ?? this.threads.table.byNameLive(threadId);
    if (!t) {
      this.toast("no such thread", "warn");
      return;
    }
    if (t.status !== "paused") {
      this.toast(`${t.name} is not paused`, "info");
      return;
    }
    await this.threads.resume(t.id);
    this.toast(`${t.name} resumed`, "info");
  }

  /**
   * The Console's Allow / Deny on a thread's pane (`thread.answer`). A yes arms ONLY when that thread's question
   * is the one on the floor — for "main", the main lane's — else it is refused ("another question is on the
   * floor: <Name>'s"): a click on Slack's pane never says yes to Spotify's action. A no forgets that lane's
   * question alone. Never a default keyboard action anywhere.
   */
  private async answerThread(threadId: string, yes: boolean): Promise<void> {
    const floor = this.desk.floor;
    if (threadId === MAIN_THREAD_ID) {
      if (!yes) {
        // The main lane's question alone goes — on the floor or queued. Its record leaves `waiting-kevin` now (no
        // Delegator phase follows a click), and the voice, which a spoken no would have reached, is told the same.
        const question = this.desk.pendingOf(ThreadAwareRunner.ACTOR)?.description;
        if (question === undefined) {
          this.toast("no question is waiting", "info");
          return;
        }
        this.desk.drop(ThreadAwareRunner.ACTOR);
        this.threads.publish(this.threads.table.status(MAIN_THREAD_ID, this.delegator?.active ? "thinking" : "idle"));
        this.live?.appendInstructions(null, `Kevin denied "${question.slice(0, 160)}" in the Console. Say one word and wait.`);
        this.toast("denied", "info");
        log.info(`thread.answer no main: dropped "${question.slice(0, 80)}"`);
        return;
      }
      if (!floor) {
        this.toast("no question is waiting", "info");
        return;
      }
      if (floor.laneId !== ThreadAwareRunner.ACTOR) {
        this.toast(`another question is on the floor: ${floor.name}'s`, "warn");
        log.info(`thread.answer yes main refused: the floor is ${floor.name}'s`);
        return;
      }
      // The main thread's yes is the typed yes: on the record, armed with its grant row, the voice told.
      await this.sayText("yes");
      return;
    }
    const t = this.threads.get(threadId);
    if (!t) {
      this.toast("no such thread", "warn");
      return;
    }
    if (yes) {
      const r = await this.threads.answerYes(t.id);
      this.toast(r.ok ? `${t.name}: allowed` : (r.reason ?? "refused"), r.ok ? "info" : "warn");
      log.info(`thread.answer yes ${t.name}: ${r.ok ? "armed and resumed" : `refused (${r.reason ?? "?"})`}`);
      return;
    }
    await this.threads.answerNo(t.id);
    this.toast(`${t.name}: denied`, "info");
  }

  /** `thread.say`: to "main" it is the composer's line (`sayText`); to a spawned thread a follow-up turn on its own brain. */
  private async sayToThread(threadId: string, text: string): Promise<void> {
    if (threadId === MAIN_THREAD_ID) return this.sayText(text);
    const t0 = performance.now();
    const t = this.threads.get(threadId);
    const ok = t ? await this.threads.followUp(t.id, text) : false;
    if (!ok) this.toast(t ? `${t.name} is not live` : "no such thread", "warn");
    log.info(`thread.say ${t?.name ?? threadId}: ${ok ? "a follow-up turn" : "refused"} in ${Math.round(performance.now() - t0)} ms`);
  }

  // ---- thread panes: the agent.open shape over a seq-numbered log, per viewer, to viewers only.

  private threadLog(threadId: string): ThreadLog | undefined {
    return threadId === MAIN_THREAD_ID ? this.mainLog : this.threads.log(threadId);
  }

  private threadLive(threadId: string): boolean {
    if (threadId === MAIN_THREAD_ID) return this.live !== undefined;
    const t = this.threads.get(threadId);
    return t !== undefined && !THREAD_TERMINAL.has(t.status);
  }

  private threadTranscript(threadId: string, entries: readonly ThreadEntry[], total: number, complete: boolean, cursor?: { readonly startSeq: number; readonly endSeq: number }, readMs?: number): Extract<EngineEvent, { type: "thread.transcript" }> {
    return { type: "thread.transcript", transcript: { threadId, entries, total, complete, live: this.threadLive(threadId), ...(cursor ? { cursor } : {}), ...(readMs !== undefined ? { readMs } : {}) }, mode: "replace" };
  }

  /** `thread.open`: register the viewer, subscribe once to the log, send the newest page (`replace`) with a seq cursor. */
  private openThread(threadId: string, viewer?: string): void {
    const t0 = performance.now();
    const key = viewer ?? `anon:${++this.anonViewers}`;
    let open = this.openThreads.get(threadId);
    if (!open) {
      open = { viewers: new Set(), unwatch: undefined, pending: [], timer: undefined };
      this.openThreads.set(threadId, open);
    }
    open.viewers.add(key);
    const logOf = this.threadLog(threadId);
    if (!logOf) {
      this.emit("event", this.threadTranscript(threadId, [], 0, true));
      log.info(`thread.open ${threadId} viewer ${key}: no such thread`);
      return;
    }
    if (!open.unwatch) open.unwatch = logOf.onEntry((e) => this.queueThreadEntry(threadId, e));
    const page = logOf.page(undefined, THREAD_PAGE);
    const readMs = Math.round(performance.now() - t0);
    this.emit("event", this.threadTranscript(threadId, page.entries, page.total, page.complete, { startSeq: page.startSeq, endSeq: page.endSeq }, readMs));
    log.info(`thread.open ${threadId} viewer ${key}: page ${page.entries.length}/${page.total} in ${readMs} ms`);
  }

  private closeThread(threadId: string, viewer?: string): void {
    const open = this.openThreads.get(threadId);
    if (!open) return;
    if (viewer !== undefined) open.viewers.delete(viewer);
    else {
      const anon = [...open.viewers].find((v) => v.startsWith("anon:"));
      if (anon) open.viewers.delete(anon);
    }
    if (open.viewers.size > 0) return;
    this.dropThreadPane(threadId, open);
  }

  private dropThreadPane(threadId: string, open: OpenThread): void {
    this.openThreads.delete(threadId);
    open.unwatch?.();
    if (open.timer) clearTimeout(open.timer);
    open.pending = [];
  }

  /** `thread.history {before}`: THREAD_PAGE older entries from the log's ring as a `prepend`; `complete` when the ring's oldest is in it. */
  private threadHistory(threadId: string, before: number): void {
    const t0 = performance.now();
    const logOf = this.threadLog(threadId);
    if (!logOf) {
      this.toast(`no thread ${threadId}`, "warn");
      return;
    }
    const page = logOf.page(before, THREAD_PAGE);
    const readMs = Math.round(performance.now() - t0);
    this.emit("event", { ...this.threadTranscript(threadId, page.entries, page.total, page.complete, { startSeq: page.startSeq, endSeq: page.endSeq }, readMs), mode: "prepend" });
    log.info(`thread.history ${threadId} before ${before}: ${page.entries.length} in ${readMs} ms`);
  }

  /** A new entry on an open thread's log: held THREAD_TRANSCRIPT_COALESCE_MS and sent with the rest as one `append`. */
  private queueThreadEntry(threadId: string, entry: ThreadEntry): void {
    const open = this.openThreads.get(threadId);
    if (!open) return;
    open.pending.push(entry);
    if (open.timer) return;
    open.timer = setTimeout(() => {
      open.timer = undefined;
      this.flushThreadEntries(threadId);
    }, Engine.THREAD_TRANSCRIPT_COALESCE_MS);
    open.timer.unref?.();
  }

  private flushThreadEntries(threadId: string): void {
    const open = this.openThreads.get(threadId);
    if (!open || open.pending.length === 0) return;
    const entries = open.pending;
    open.pending = [];
    const total = this.threadLog(threadId)?.total ?? entries[entries.length - 1]!.seq;
    this.emit("event", { ...this.threadTranscript(threadId, entries, total, false), mode: "append" });
  }

  /**
   * The composite look for `BrainTask.notes[0]` (DECISIONS §11b): what the reading helper already knows — the
   * front app and window from the AX tick, the labelled controls from the ear-hints read, what the observer last
   * saw — rendered in the pixels of the last screenshot when one was taken. A cache read, never a probe: the
   * eyes' shot is the one round trip a task pays at its start; a stale or empty cache gives no preamble.
   */
  private async compositeLook(): Promise<string | undefined> {
    const state = this.screenState.get(Engine.EAR_HINTS_REREAD_MS + Engine.AX_WARM_MS);
    if (!state || (!state.front && !state.ax && !state.focused)) return undefined;
    // The AX tick knows the app and the window by name only; for the rendering that is a front app with no frame.
    const front = state.front ?? (state.ax ? { app: state.ax.app, pid: 0, window: { title: state.ax.window, x: 0, y: 0, w: 0, h: 0, windowId: 0 } } : undefined);
    const toPixels = this.toolset.screen.last ? (p: Point): Point => this.toolset.screen.fromPoints(p.x, p.y) : undefined;
    return renderCompositeLook({ ...state, ...(front ? { front } : {}) }, toPixels) || undefined;
  }

  // ------------------------------------------------------- conversations
  // Implemented in packages/agents-backed methods below; the UI sends agent.open
  // when Kevin hops into a session, receives `agent.transcript` events while it
  // is open, and agent.close when he leaves. Long-horizon rules (Kevin: "threads
  // don't break after a while"): opens are per VIEWER (a pane token the daemon
  // prefixes with its client id), so a re-open after a reconnect never double-counts
  // and a client that dies takes its tails with it (`dropViewers`); a tail that ends
  // says so — `gone` → live:false plus the calls it left running as `interrupted`,
  // `replaced` / `truncated` → the page is read again and the tail re-attached; an
  // agent whose process is gone (status `ended`) has its running calls settled; older
  // pages arrive as `prepend`, read by byte offset (never from the file's end again);
  // and a clean shutdown tells every open pane live:false before the tails close.

  private async openAgent(agentId: string, viewer?: string): Promise<void> {
    const t0 = performance.now();
    // Register the viewer first so a close() that races the page read is not lost.
    const key = viewer ?? `anon:${++this.anonViewers}`;
    const open = this.openConversations.get(agentId);
    if (open) open.viewers.add(key);
    else this.openConversations.set(agentId, { viewers: new Set([key]), unwatch: undefined, total: 0, firstId: undefined, ...this.statusEntry(agentId) });
    let page: TranscriptPage;
    try {
      page = await this.agents.transcript(agentId, { limit: DEFAULT_PAGE });
    } catch (e) {
      this.toast(`could not open ${agentId}: ${(e as Error).message}`, "warn");
      this.emit("event", { type: "agent.transcript", transcript: { agentId, messages: [], total: 0, complete: true, live: false }, mode: "replace" });
      return;
    }
    const entry = this.openConversations.get(agentId);
    if (!entry) return; // closed while the page was read
    entry.total = page.total;
    if (page.cursor) entry.cursor = page.cursor;
    entry.firstId = page.messages[0]?.id;
    // One tail per conversation however many viewers show it; its deltas cannot arrive before the page below is emitted.
    if (!entry.unwatch) this.attachTail(agentId, entry);
    const readMs = Math.round(performance.now() - t0);
    this.emit("event", { type: "agent.transcript", transcript: { agentId, ...page, live: entry.unwatch !== undefined, readMs }, mode: "replace" });
    log.info(`agent.open ${agentId} viewer ${key}: page ${page.messages.length}/${page.total} in ${readMs} ms`);
  }

  /** The agent's last known status, for the entry (a status already `ended` at open settles nothing: the page reads it as is). */
  private statusEntry(agentId: string): { status?: AgentStatus } {
    const status = this.agentsList.find((a) => a.id === agentId)?.status;
    return status ? { status } : {};
  }

  /** Follow the file: deltas go out as `append`; the end of the tail is handled by `onTailEnd`. */
  private attachTail(agentId: string, entry: OpenConversation): void {
    let ended = false;
    try {
      const stop = this.agents.watch(
        agentId,
        (delta) => {
          const current = this.openConversations.get(agentId);
          if (!current) return;
          current.total = delta.total;
          this.emit("event", { type: "agent.transcript", transcript: { agentId, messages: delta.messages, total: delta.total, complete: false, live: true }, mode: "append" });
        },
        (reason) => {
          ended = true;
          this.onTailEnd(agentId, reason);
        },
      );
      // `ended` may already be set when the connector gave up synchronously.
      if (ended) stop?.();
      else entry.unwatch = stop;
    } catch (e) {
      log.warn(`agent.open ${agentId}: no live tail (${(e as Error).message})`);
    }
  }

  /**
   * The tail stopped on its own. `replaced` / `truncated` (the tool rewrote the file):
   * the conversation is read again from the file as it is now and followed on, the
   * viewers untouched. Anything else — `gone` (the file disappeared for 10 s and no
   * archived copy took over), or a tail that could not start — means nothing more will
   * arrive: the panes hear live:false, and whatever calls were still running read
   * `interrupted` in the same delta, so no card pulses for a process that is gone.
   */
  private onTailEnd(agentId: string, reason: string): void {
    const current = this.openConversations.get(agentId);
    if (!current) return;
    current.unwatch?.(); // lets the connector drop its timers; a no-op once the tail has ended
    current.unwatch = undefined;
    if (reason === "replaced" || reason === "truncated") {
      log.info(`agent ${agentId}: file ${reason}; reading it again`);
      void this.reopenAgent(agentId, reason);
      return;
    }
    log.warn(`agent ${agentId}: live tail ended (${reason})`);
    void this.settleAgent(agentId).then((delta) => {
      const still = this.openConversations.get(agentId);
      if (!still) return;
      this.emit("event", { type: "agent.transcript", transcript: { agentId, messages: delta?.messages ?? [], total: delta?.total ?? still.total, complete: false, live: false }, mode: "append" });
    });
  }

  /** Read the newest page again and follow on (the file was replaced or truncated under the tail); the viewers stay. */
  private async reopenAgent(agentId: string, reason: string): Promise<void> {
    if (!this.openConversations.has(agentId)) return;
    let page: TranscriptPage;
    try {
      page = await this.agents.transcript(agentId, { limit: DEFAULT_PAGE });
    } catch (e) {
      log.warn(`agent ${agentId}: could not read it again after ${reason} (${(e as Error).message})`);
      const gone = this.openConversations.get(agentId);
      if (gone) this.emit("event", { type: "agent.transcript", transcript: { agentId, messages: [], total: gone.total, complete: false, live: false }, mode: "append" });
      return;
    }
    const entry = this.openConversations.get(agentId);
    if (!entry) return; // closed meanwhile
    entry.total = page.total;
    if (page.cursor) entry.cursor = page.cursor;
    entry.firstId = page.messages[0]?.id;
    if (!entry.unwatch) this.attachTail(agentId, entry);
    this.emit("event", { type: "agent.transcript", transcript: { agentId, ...page, live: entry.unwatch !== undefined }, mode: "replace" });
  }

  /** The connector's word on the calls a session left running when its process ended (`interrupted`), or undefined when it keeps none. */
  private async settleAgent(agentId: string): Promise<TranscriptDelta | undefined> {
    const parts = splitAgentId(agentId);
    const connector = parts ? this.agents.connector(parts.kind) : undefined;
    if (!connector?.settle) return undefined;
    try {
      return await connector.settle(agentId);
    } catch (e) {
      log.debug(`agent ${agentId}: settle failed (${(e as Error).message})`);
      return undefined;
    }
  }

  /** The agents' statuses moved: an open conversation that turned `ended` has its running calls flipped to `interrupted`, once per ending. */
  private settleEndedConversations(list: readonly AgentInfo[]): void {
    for (const [agentId, entry] of this.openConversations) {
      const status = list.find((a) => a.id === agentId)?.status;
      if (!status) continue;
      const before = entry.status;
      entry.status = status;
      if (status !== "ended" || before === "ended") continue;
      void this.settleAgent(agentId).then((delta) => {
        const still = this.openConversations.get(agentId);
        if (!still || !delta || delta.messages.length === 0) return;
        still.total = delta.total;
        this.emit("event", { type: "agent.transcript", transcript: { agentId, messages: delta.messages, total: delta.total, complete: false, live: still.unwatch !== undefined }, mode: "append" });
      });
    }
  }

  private async closeAgent(agentId: string, viewer?: string): Promise<void> {
    const open = this.openConversations.get(agentId);
    if (!open) return;
    if (viewer !== undefined) open.viewers.delete(viewer);
    else {
      // The old counting behaviour: a close without a token takes one anonymous viewer back.
      const anon = [...open.viewers].find((v) => v.startsWith("anon:"));
      if (anon) open.viewers.delete(anon);
    }
    if (open.viewers.size > 0) return;
    this.openConversations.delete(agentId);
    open.unwatch?.();
  }

  /**
   * A daemon client went away (its socket closed): every viewer it registered leaves,
   * and a conversation nobody else shows stops being tailed. Without this a Console that
   * crashed or was force-quit left its tails running until the daemon restarted.
   */
  dropViewers(clientId: string): void {
    const prefix = `${clientId}/`;
    let closed = 0;
    for (const [agentId, open] of [...this.openConversations]) {
      for (const v of [...open.viewers]) if (v.startsWith(prefix)) open.viewers.delete(v);
      if (open.viewers.size > 0) continue;
      this.openConversations.delete(agentId);
      open.unwatch?.();
      closed++;
    }
    for (const [threadId, open] of [...this.openThreads]) {
      for (const v of [...open.viewers]) if (v.startsWith(prefix)) open.viewers.delete(v);
      if (open.viewers.size > 0) continue;
      this.dropThreadPane(threadId, open);
      closed++;
    }
    if (closed) log.info(`client ${clientId} left: ${closed} conversation tail(s) closed`);
  }

  /**
   * Older turns, as a `prepend` page: the connector resolves `before` (a message id the
   * app still has) and, when the conversation is open and `before` is the first message
   * of what the engine has served, is told the byte offset that page began at, so a
   * "Load earlier" reads backward from there instead of re-reading from the file's end.
   * Any other `before` — the oldest message a pane kept after its 400-message trim, one
   * that arrived as an append — goes alone: the connector gives the offset precedence,
   * and reading from the page start would skip everything between. The page's
   * `complete` says whether the first message is in it.
   */
  private async agentHistory(agentId: string, before: string): Promise<void> {
    const t0 = performance.now();
    const entry = this.openConversations.get(agentId);
    const atStart = entry?.cursor !== undefined && entry.firstId !== undefined && before === entry.firstId;
    const opts: TranscriptOptions = { limit: DEFAULT_PAGE, before, ...(atStart && entry?.cursor ? { beforeOffset: entry.cursor.startOffset } : {}) };
    try {
      const page = await this.agents.transcript(agentId, opts);
      log.info(`agent.history ${agentId}: ${page.messages.length} in ${Math.round(performance.now() - t0)} ms`);
      if (entry && page.cursor) {
        // The served range grows backward only when the page reached below it; a gap fill leaves the start where it was.
        const start = entry.cursor?.startOffset;
        if (start === undefined || page.cursor.startOffset <= start) {
          entry.cursor = { startOffset: page.cursor.startOffset, endOffset: entry.cursor?.endOffset ?? page.cursor.endOffset };
          if (page.messages.length > 0) entry.firstId = page.messages[0]?.id;
        }
      }
      this.emit("event", { type: "agent.transcript", transcript: { agentId, ...page, live: entry?.unwatch !== undefined }, mode: "prepend" });
    } catch (e) {
      this.toast(`no older turns for ${agentId}: ${(e as Error).message}`, "warn");
    }
  }

  /** Stop every live tail; the surfaces are going away with the engine — and hear so first, so no pane keeps a "live" it will never see end. */
  private closeConversations(): void {
    for (const [agentId, open] of this.openConversations) {
      this.emit("event", { type: "agent.transcript", transcript: { agentId, messages: [], total: open.total, complete: false, live: false }, mode: "append" });
      open.unwatch?.();
    }
    this.openConversations.clear();
    for (const [threadId, open] of [...this.openThreads]) {
      this.flushThreadEntries(threadId);
      this.emit("event", { type: "thread.transcript", transcript: { threadId, entries: [], total: this.threadLog(threadId)?.total ?? 0, complete: false, live: false }, mode: "append" });
      this.dropThreadPane(threadId, open);
    }
  }

  // --------------------------------------------------------------- marks
  // Kevin circles a region on screen (⌥⇧C, then a stroke): the engine records it
  // as a pending mark at once, tells Live, screenshots it through the hands, and
  // the next delegation carries it (waiting for the capture if it is still going).

  /** Marks the snapshot carries (pending plus recently consumed); the oldest go first. */
  private static readonly MAX_MARKS = 6;
  /** A consumed mark stays this long after it was handed over so the Console can show what the brain saw. */
  private static readonly CONSUMED_MARK_TTL_MS = 2 * 60_000;
  /** A circle nobody asked about for this long is not context any more; it leaves rather than ride into an unrelated task. */
  private static readonly PENDING_MARK_TTL_MS = 15 * 60_000;

  private async addMark(rawRect: Rect, path?: readonly Point[], opts?: { readonly source?: "window"; readonly element?: ScreenMark["element"] }): Promise<void> {
    const bbox = normalizeRect(rawRect);
    const id = newId("mark");
    const at = this.now();
    const size = `${Math.round(bbox.w)}×${Math.round(bbox.h)} at ${Math.round(bbox.x)},${Math.round(bbox.y)}`;
    const window = opts?.source === "window";
    // Registered before the capture, so a delegation fired while the hands work
    // sees a mark to wait for instead of missing it. A window mark carries how it was
    // made and what it is; its rect is the window's frame already.
    const mark: ScreenMark = { id, rect: bbox, ...(path && path.length > 0 ? { path } : {}), at, consumed: false, ...(window ? { source: "window" as const, ...(opts?.element ? { element: opts.element } : {}) } : {}) };
    this.marks = [...this.marks, mark].slice(-Engine.MAX_MARKS);
    this.scheduleSnapshot();
    // Asleep, the mark simply waits for the next session; awake, the voice hears about it now.
    this.live?.appendInstructions(
      null,
      window
        ? `Kevin just captured a window of his screen (${opts?.element?.app ?? "a window"}, ${Math.round(bbox.w)}×${Math.round(bbox.h)}). The brain will see the image with the next task; acknowledge briefly if he is asking about it.`
        : `Kevin just circled a region of his screen (${size}). The brain will see the image with the next task; acknowledge briefly if he is asking about it.`,
    );
    // What did he surround? The element under the stroke's centroid and the window
    // list say; the mark snaps to the smallest frame that holds the centroid and
    // sits mostly inside his stroke. Failing that, the stroke's own box stands. A
    // window is already the target: no probes, no snap.
    const capture = (async () => {
      const snapped = window ? (opts?.element ? { rect: bbox, element: opts.element } : undefined) : await this.resolveMarkTarget(bbox, path);
      if (snapped) this.marks = this.marks.map((m) => (m.id === id ? { ...m, rect: snapped.rect, ...(snapped.element ? { element: snapped.element } : {}) } : m));
      const rect = snapped?.rect ?? bbox;
      const what = snapped?.element ? ` (${[snapped.element.role, snapped.element.title ? `"${snapped.element.title}"` : "", snapped.element.app ? `in ${snapped.element.app}` : ""].filter(Boolean).join(" ")})` : "";
      await this.captureMark(id, rect, at, `${size}${what}`);
      return { rect, element: snapped?.element };
    })();
    this.markCaptures.set(id, capture.then(() => undefined));
    let target: { rect: Rect; element: ScreenMark["element"] };
    try {
      target = await capture;
    } finally {
      this.markCaptures.delete(id);
    }
    // A sender with a stroke (the overlay's mark mode) has drawn it on the layer
    // already; echoing it again would double the glow. A bare box (no path) gets
    // its outline echoed once the capture is done, so the echo is never in the shot.
    // Then the blob outlines what he meant: it flies over and drags a rounded frame
    // around the snapped target, labelled with what it is.
    if (!path || path.length < 2) this.emit("overlay", { cmd: "stroke", points: rectCorners(target.rect), tone: "mark", ttlMs: 2500 });
    const label = target.element?.title || target.element?.app;
    this.emit("overlay", { cmd: "orb.trace", points: roundedRectPoints(target.rect), closed: true, tone: "mark", ttlMs: 6000, ...(label ? { label: label.slice(0, 40) } : {}), reason: "mark" });
  }

  /** A mark id as `newId("mark")` mints it: "mark_" and lowercase base36. Anything else is malformed and ignored. */
  private static readonly MARK_ID = /^mark_[a-z0-9]+$/;

  /**
   * The × on one thumbnail: the mark leaves now, consumed or not. A capture still in flight
   * for it finishes into nothing — captureMark writes through `this.marks.map`, which no
   * longer finds the id. An unknown or malformed id changes nothing and says nothing: the
   * snapshot is the truth.
   */
  private removeMark(id: string): void {
    if (!Engine.MARK_ID.test(id)) return;
    if (!this.marks.some((m) => m.id === id)) return;
    this.marks = this.marks.filter((m) => m.id !== id);
    this.markConsumedAt.delete(id);
    this.scheduleSnapshot();
  }

  /** The notch's Window box: the front window as a mark, whole, no snap. Works asleep. No front window: a toast, no mark. */
  private async markFrontWindow(): Promise<void> {
    const fm = await this.hands.request<FrontmostInfo>("frontmost", {}, 1500).catch((e: Error) => {
      log.debug(`mark.window: ${e.message}`);
      return undefined;
    });
    const w = fm?.window;
    if (!w || !(w.w >= 16 && w.h >= 16)) {
      this.toast("No front window to capture", "warn");
      return;
    }
    const element: NonNullable<ScreenMark["element"]> = { role: "window", ...(w.title ? { title: w.title } : {}), ...(fm.app ? { app: fm.app } : {}) };
    void this.addMark({ x: w.x, y: w.y, w: w.w, h: w.h }, undefined, { source: "window", element });
    this.toast(`Captured ${fm.app || "window"} · ${Math.round(w.w)}×${Math.round(w.h)}`);
  }

  /** Over this share of a frame inside the padded stroke box, the frame is what Kevin surrounded. */
  private static readonly MARK_SNAP_COVERAGE = 0.6;

  /**
   * The LARGEST element or window frame that contains the stroke's centroid and
   * lies at least 60 % inside the stroke's padded box: what Kevin surrounded is the
   * biggest thing mostly inside his stroke. (The element under the centroid of a
   * circled dialog is a label inside it; the label always fits, the dialog is what
   * he meant. A circled button: the window around it fails the coverage test and
   * the button is the largest fit.) Both probes run at once and either may fail
   * (no Accessibility, no helper): then the box itself stands, with the app under
   * the centroid noted when the window list could say.
   */
  private async resolveMarkTarget(bbox: Rect, path?: readonly Point[]): Promise<{ rect: Rect; element?: ScreenMark["element"] } | undefined> {
    const centroid = path && path.length >= 2 ? centroidOf(path) : { x: bbox.x + bbox.w / 2, y: bbox.y + bbox.h / 2 };
    const pad = Math.max(12, 0.1 * Math.max(bbox.w, bbox.h));
    const padded: Rect = { x: bbox.x - pad, y: bbox.y - pad, w: bbox.w + 2 * pad, h: bbox.h + 2 * pad };
    const [el, wins] = await Promise.all([
      this.hands.request<ElementInfo>("element_at", { x: centroid.x, y: centroid.y }, 1500).catch(() => undefined),
      this.hands.request<{ windows: WindowInfo[] }>("windows", {}, 1500).catch(() => undefined),
    ]);
    type Candidate = { rect: Rect; element: NonNullable<ScreenMark["element"]> };
    const candidates: Candidate[] = [];
    if (el?.frame && el.frame.w > 0 && el.frame.h > 0) {
      candidates.push({ rect: el.frame, element: { ...(el.role ? { role: el.role } : {}), ...(el.title || el.description ? { title: (el.title || el.description) as string } : {}), ...(el.app ? { app: el.app } : {}) } });
    }
    const under = (wins?.windows ?? []).filter((w) => w.w > 0 && w.h > 0 && contains({ x: w.x, y: w.y, w: w.w, h: w.h }, centroid));
    for (const w of under) candidates.push({ rect: { x: w.x, y: w.y, w: w.w, h: w.h }, element: { role: "AXWindow", ...(w.title ? { title: w.title } : {}), ...(w.app ? { app: w.app } : {}) } });
    const fits = candidates.filter((c) => contains(c.rect, centroid) && c.rect.w * c.rect.h >= 16 && coverage(c.rect, padded) >= Engine.MARK_SNAP_COVERAGE).sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h);
    const best = fits[0];
    if (best) {
      log.info(`mark snapped to ${best.element.role ?? "?"}${best.element.title ? ` "${best.element.title}"` : ""}${best.element.app ? ` in ${best.element.app}` : ""}: ${Math.round(best.rect.w)}×${Math.round(best.rect.h)}`);
      return { rect: normalizeRect(best.rect), element: best.element };
    }
    // Nothing fits the stroke; his box stands, with the app it is over when known.
    const app = under.sort((a, b) => a.w * a.h - b.w * b.h)[0]?.app ?? el?.app;
    return app ? { rect: bbox, element: { app } } : undefined;
  }

  /** Screenshot the region through the hands and fill the mark's screenshotPath in place; never throws. */
  private async captureMark(id: string, rect: Rect, at: number, size: string): Promise<void> {
    // The disk preflight, measured before EVERY capture (statfs is microseconds): a disk that
    // fills mid-session is caught at the next shot, not the next connect. Under DISK_LOW_BYTES
    // free the region is not captured — the mark still counts and the brain gets the region
    // without the pixels (the same fallback as no eyes).
    if (!this.checkDisk()) {
      log.warn(`mark ${id}: ${size}; not captured — disk low (${Math.round(Engine.DISK_LOW_BYTES / 1_048_576)} MB floor)`);
      this.scheduleSnapshot();
      return;
    }
    try {
      // Jarhead's own windows (the orb, the overlay with the stroke on it) stay out of the shot, as with every capture.
      const shot = await this.hands.request<ScreenshotResult>("zoom", { ...rect, maxLongEdge: DEFAULT_SHOT_BUDGET.maxLongEdge, excludePids: [...this.excludePids, process.pid] }, 6000);
      const day = Ledger.dayFor(at);
      const rel = join("shots", day, `${id}.png`);
      mkdirSync(join(this.config.stateDir, "shots", day), { recursive: true });
      writeFileSync(join(this.config.stateDir, rel), Buffer.from(shot.pngBase64, "base64"));
      // The mark may be gone already (mark.clear, or pushed out by the cap); then the file is just a shot on disk.
      this.marks = this.marks.map((m) => (m.id === id ? { ...m, screenshotPath: rel } : m));
      log.info(`mark ${id}: ${size} → ${rel}`);
    } catch (e) {
      // No eyes right now (helper not built, Screen Recording denied): the mark still
      // counts; the brain gets the region without the pixels.
      log.warn(`mark ${id}: ${size}; could not capture the region: ${(e as Error).message}`);
    }
    this.scheduleSnapshot();
  }

  /** Resolves when no capture is in flight; a capture that failed counts as landed. */
  private async marksSettled(): Promise<void> {
    while (this.markCaptures.size > 0) await Promise.all([...this.markCaptures.values()]);
  }

  /** The delegator handed these to the brain; they stay in the snapshot a while so the Console can show what went in. */
  private consumeMarks(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const set = new Set(ids);
    const now = this.now();
    this.marks = this.marks.map((m) => {
      if (!set.has(m.id) || m.consumed) return m;
      this.markConsumedAt.set(m.id, now);
      return { ...m, consumed: true };
    });
    this.scheduleSnapshot();
  }

  /** The brain never took the task those marks went with; they are pending again for the next one. */
  private releaseMarks(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const set = new Set(ids);
    let changed = false;
    this.marks = this.marks.map((m) => {
      if (!set.has(m.id) || !m.consumed) return m;
      changed = true;
      this.markConsumedAt.delete(m.id);
      return { ...m, consumed: false };
    });
    if (changed) {
      log.info(`marks released, pending again: ${ids.join(", ")}`);
      this.scheduleSnapshot();
    }
  }

  /**
   * Called from tick: a consumed mark leaves CONSUMED_MARK_TTL_MS after it was
   * handed over; a mark nobody asked about leaves after PENDING_MARK_TTL_MS.
   */
  private pruneMarks(): void {
    const now = this.now();
    const kept = this.marks.filter((m) => {
      if (m.consumed) return (this.markConsumedAt.get(m.id) ?? m.at) >= now - Engine.CONSUMED_MARK_TTL_MS;
      return m.at >= now - Engine.PENDING_MARK_TTL_MS;
    });
    if (kept.length !== this.marks.length) {
      const alive = new Set(kept.map((m) => m.id));
      for (const id of this.markConsumedAt.keys()) if (!alive.has(id)) this.markConsumedAt.delete(id);
      this.marks = kept;
      this.scheduleSnapshot();
    }
  }

  private clearMarks(): void {
    this.marks = [];
    this.markConsumedAt.clear();
    this.scheduleSnapshot();
  }

  // ------------------------------------------------------------- pause

  /**
   * Pause: the session is CLOSED — GPT-Live-1 bills every second it is open, and a
   * muted session is an open one — and the conversation is held here instead: the
   * transcript (in memory), the marks, the brain (warm, not stopped) and the hands
   * stay. Everything perceptible ends as a stop does; then the session is detached
   * at once (the next snapshot has none) and closed with the deadline. While
   * paused: mic PCM is dropped, the ear ignored, reflexes off, levels 0; typing in
   * the Console resumes first. Unresumed, the pause decays to sleep at `sleepsAt`
   * (idleSleepMinutes, at least a minute).
   */
  async pause(o: { readonly quiet?: boolean } = {}): Promise<void> {
    if (this.sleeping) {
      // A dismissal already in flight wins: its farewell ends now and the sleep finishes (the
      // session closes, the spare goes). A pause over it would flip the phase to paused for a
      // tick and then be undone by the sleep's tail; there is nothing left to hold.
      this.farewellEnd?.();
      await this.sleeping;
      this.toast("asleep already", "info");
      return;
    }
    if (this.pauseInfo) {
      this.toast("paused already", "info");
      return;
    }
    const live = this.live;
    if (!live?.session || this.connecting) {
      this.toast(this.connecting ? "still connecting" : "asleep already", "info");
      return;
    }
    const t0 = this.now();
    const sessionId = live.session.id;
    // The meter bills per second of open session; `session.usage.updated` arrives late,
    // so the figure at the pause is at least the seconds the session has been open.
    const usageSeconds = Math.max(this.usageSeconds, Math.floor((t0 - this.sessionStartedAt) / 1000));
    const { running, dropped, cancel } = this.cutEverything("paused", "pause");
    this.wantAwake = false;
    this.pauseInfo = { at: t0, sessionId, usageSeconds, sleepsAt: t0 + Math.max(Engine.PAUSE_MIN_MS, this.settings.idleSleepMinutes * 60_000) };
    this.ledger.append({ at: t0, type: "pause", sessionId, usageSeconds });
    this.detachLive(live);
    this.closeWithDeadline(live, "pause");
    this.setPhase("paused");
    if (!o.quiet) this.toast("paused · meter stopped", "info");
    await this.bounded(cancel);
    log.info(`paused in ${this.now() - t0}ms: session ${sessionId} closed at ${usageSeconds}s; ${running ? `cancelled ${running.id}` : "nothing was running"}; ${dropped} hands request(s) dropped; sleeps at +${Math.round((this.pauseInfo?.sleepsAt ?? t0) - t0) / 60_000} min unless resumed`);
  }

  /**
   * Resume: a NEW session whose instructions carry the continuity — what was said
   * before the pause and the last task — so the voice picks up where it left off.
   * The started row says `resumedFrom`; a `resume` row follows. Not paused: a word.
   */
  async resume(): Promise<void> {
    const pause = this.pauseInfo;
    if (!pause) {
      this.toast(this.live ? "not paused" : "asleep — press Go", "info");
      return;
    }
    if (this.connecting) return; // the resume is already opening its session
    await this.connect("resume", { pause, continuity: this.continuityFor(pause) });
  }

  /**
   * Kevin pressed Switch now after picking a voice or accent: the session is paused
   * (closed, the conversation held) and reopened at once with the new voice and the
   * "reconnected" continuity — strictly the two existing verbs, so one session at a
   * time and both rows on the ledger. Refused while a task or a thread runs (a pause
   * would cancel them: "busy — heard at the next wake"), and while paused, asleep or
   * connecting (nothing to reopen: the pick is heard at the next wake anyway). Only
   * ever on Kevin's press — browsing 22 voices must never churn paid starts.
   */
  async reopenVoice(): Promise<void> {
    if (this.delegator?.active !== undefined || this.threads.running() > 0) {
      this.toast("busy — heard at the next wake", "info");
      return;
    }
    if (!this.live?.session || this.connecting || this.pauseInfo || this.sleeping) {
      this.toast("heard at the next wake", "info");
      return;
    }
    const was = `${this.sessionVoice ?? "?"} / ${this.sessionAccent ?? "?"}`;
    await this.pause({ quiet: true });
    const pause = this.pauseInfo;
    if (!pause) return; // a sleep raced the pause: nothing is held, nothing to reopen
    log.info(`voice change: reopening the session (${was} → ${this.settings.voice} / ${this.settings.accent})`);
    await this.connect("voice change", { pause, continuity: this.continuityFor(pause, "reconnected"), how: "reconnected" });
  }

  /**
   * The "# Continuity" section a resumed session starts with: the last lines of the
   * conversation and the last task. `how` says what the gap was: a pause Kevin chose
   * (the default: carry on silently); a restart of the engine that cut the
   * conversation — then the lines come from the LEDGER (this process never heard them)
   * and the voice says one word, "back", so Kevin knows it is the same conversation; or
   * a reconnect after the server dropped the session (expired, connection lost, a voice
   * switch) — the same conversation picked up where it was cut, silently unless Kevin
   * was mid-request.
   */
  private continuityFor(pause: PauseInfo, how: "paused" | "restarted" | "reconnected" = "paused"): string {
    const gapMs = this.now() - pause.at;
    const minutes = Math.round(gapMs / 60_000);
    const when = minutes < 1 ? "less than a minute ago" : minutes === 1 ? "a minute ago" : `${minutes} minutes ago`;
    const lines: string[] = [];
    let chars = 0;
    // A fresh process holds no transcript: what was said lives in the ledger's heard / said rows.
    const recalled = this.wholeTranscript().length > 0 ? undefined : this.recallFromLedger(pause.sessionId);
    const whole = recalled?.items ?? this.wholeTranscript();
    for (let i = whole.length - 1; i >= 0 && lines.length < Engine.CONTINUITY_LINES; i--) {
      const item = whole[i];
      const text = item?.text.trim();
      if (!item || !text) continue;
      const line = `${item.speaker === "kevin" ? "Kevin" : "Jarhead"}: ${text}`;
      if (chars + line.length > Engine.CONTINUITY_CHARS) {
        // The most recent line always makes it, cut if it must.
        if (lines.length === 0) lines.unshift(line.slice(0, Engine.CONTINUITY_CHARS));
        break;
      }
      lines.unshift(line);
      chars += line.length + 1;
    }
    const last = this.lastDelegations[this.lastDelegations.length - 1];
    const task = last?.summary ? `Last task: "${last.request.replace(/\s+/g, " ").trim().slice(0, 160)}" — ${last.status}: ${last.summary}` : recalled?.task;
    if (how === "reconnected") {
      const seconds = Math.max(1, Math.round(gapMs / 1000));
      const gap = seconds < 90 ? `${seconds} ${seconds === 1 ? "second" : "seconds"}` : `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
      return [
        "# Continuity",
        `The voice connection dropped ${gap} ago and just came back. This is the same conversation, picked up where it was cut. What was said before, most recent last:`,
        lines.length > 0 ? lines.join("\n") : "(nothing had been said yet)",
        ...(task ? [task] : []),
        "Carry on as before; do not recap or apologise. Say nothing now unless Kevin was mid-request — then answer it.",
      ].join("\n");
    }
    if (how === "restarted") {
      const seconds = Math.max(1, Math.round(gapMs / 1000));
      return [
        "# Continuity",
        `Jarhead's engine restarted ${seconds < 90 ? `${seconds} seconds` : `${minutes} minutes`} ago in the middle of this conversation (a crash, or an update). This is the same conversation, picked up where it was cut. What was said before, most recent last:`,
        lines.length > 0 ? lines.join("\n") : "(nothing had been said yet)",
        ...(task ? [task] : []),
        'Say exactly one word now — "back" — and then wait for Kevin. Do not recap, do not apologise, do not redo the last task unless he asks.',
      ].join("\n");
    }
    return [
      "# Continuity",
      `Kevin paused you ${when} and just resumed. This is the same conversation. What was said before the pause, most recent last:`,
      lines.length > 0 ? lines.join("\n") : "(nothing had been said yet)",
      ...(task ? [task] : []),
      "Carry on as before; do not recap unless he asks. Say nothing now: stay silent until Kevin speaks to you again.",
    ].join("\n");
  }

  /** How much of the conversation a resumed session is reminded of. */
  static readonly CONTINUITY_LINES = 12;
  static readonly CONTINUITY_CHARS = 1200;

  /** True while the transport is paused (the session closed, the conversation held). */
  private get paused(): boolean {
    return this.pauseInfo !== undefined;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  // ------------------------------------------------------------- reflexes
  // The 250 ms path. `ear()` takes the app's on-device partials; the grammar and
  // the stability rules live in ./ear.ts and packages/brain/src/reflex.ts; every
  // match runs through the same gated hands as a brain's tool call and is
  // remembered so Live's delegation for the same words is finished as done.

  /**
   * On-device partial/final transcript from the app's ear (the reflex path). A
   * negative `segment` is not words: it is the app's ear reporting its own state
   * ("on (listening)", "off: Speech Recognition not decided", "ear: on-device model
   * missing") — the app's NSLog lines are not kept by the unified log on this Mac, so
   * this is the one place the ear's health is visible in production (daemon.log).
   */
  ear(text: string, isFinal: boolean, segment: number, at: number): void {
    if (segment < 0) {
      log.info(`ear (app): ${text.slice(0, 200)}`);
      return;
    }
    if (!this.live) return;
    log.debug(`ear ${isFinal ? "final" : "partial"} #${segment} @${at}: ${text.slice(0, 80)}`);
    this.earReflexes.hear(text, isFinal, segment, at);
  }

  /** Reflexes are on: awake, not paused, not muted (the mic button; `feedMic` drops PCM on the same flag), and Settings.reflexes true. */
  private reflexesEnabled(): boolean {
    return this.live !== undefined && !this.paused && !this.muted && this.settings.reflexes !== false;
  }

  /** Output frames at or above this RMS (`rms()`'s 0–1 scale) are Jarhead audibly speaking; the silence the API streams between sentences is ~0. */
  static readonly AUDIBLE_OUTPUT_LEVEL = 0.02;

  /**
   * Why the ear must hold still right now, or undefined. While the voice is audible
   * the recogniser may be hearing Jarhead's own words back through the microphone
   * (echo cancellation is best effort: the app falls back to plain input when
   * VoiceIO will not start) — "Now press enter." must not press Return. While a
   * brain task runs, a scroll under its hands would move what it just looked at.
   * The words heard meanwhile are consumed by the ear, not queued; "stop" is not
   * held (it is what Kevin says over Jarhead's voice).
   *
   * "Speaking" is judged on the output transcript and on *audible* frames, never on
   * the mere arrival of output audio: GPT-Live-1 streams output audio continuously,
   * silence included, so `lastOutputAudioAt` is always "just now" while a session is
   * open — judged on it, the ear was held for the whole session and no partial ever
   * reached the grammar (39 production delegations, zero ear reflexes).
   */
  private earHeld(): string | undefined {
    if (this.muted) return "muted";
    // Held while the main brain's turn runs or the screen is leased — not while only background
    // threads drain under a parent that is merely `draining` (B3's second slot), and not while
    // the main brain's turn is blocked in thread_wait (its hands are still for up to 240 s):
    // a colleague working Spotify by Apple events would still scroll for you.
    const active = this.delegator?.active;
    const draining = this.delegator?.draining;
    if (active && (!draining || active.id !== draining.id) && !this.runner.waitingOnThreads) return "a task is running";
    // A SCREEN thread is at work (thinking, acting, waiting for the screen): a reflex click would land in its
    // work. Background threads never hold the ear — a colleague working Spotify by Apple events still scrolls
    // for you. Jarhead's own hold (a reflex that just ran, dictation) is the ear's own doing and holds nothing.
    if (this.threads.anyScreenBusy()) return "a task is running";
    const holder = this.lease.holder;
    if (holder !== undefined && holder !== ThreadAwareRunner.ACTOR && holder !== "dictation") return "a task is running";
    const now = this.now();
    const speaking = now - this.lastOutputSpeechAt < Engine.SPEAKING_WINDOW_MS;
    const audible = now - this.lastAudibleOutputAt < Engine.SPEAKING_WINDOW_MS && now - this.lastOutputAudioAt < Engine.SPEAKING_WINDOW_MS;
    if (!this.outputGated && (speaking || audible)) return "the voice is speaking";
    return undefined;
  }

  /** Jarhead's own voice back through the microphone within this long is not Kevin's word. */
  private static readonly ECHO_WINDOW_MS = 1500;

  /**
   * Are these words Jarhead's own, just said? The mic hears the speaker: a line of
   * Jarhead's that happens to be a cue ("That's all for now.") would otherwise dismiss
   * it a moment later, because its own speech opens the exchange window. The tail of
   * its last utterance is compared (≥ RECONCILE_THRESHOLD similar, as reconciliation
   * judges the ear against Live) while its last words are under ECHO_WINDOW_MS old. A
   * cue that names Jarhead is never an echo (the ear does not ask here for one).
   */
  private echoOfJarhead(phrase: string): boolean {
    if (this.now() - this.lastOutputSpeechAt > Engine.ECHO_WINDOW_MS) return false;
    const said = this.transcript.last("jarhead");
    if (!said) return false;
    const own = normalizeUtterance(said.text);
    if (!own || !phrase) return false;
    const tail = own.slice(Math.max(0, own.length - phrase.length));
    return own === phrase || similarity(tail, phrase) >= RECONCILE_THRESHOLD;
  }

  /**
   * The grammar, gated by the setting and by dictation (while dictating, words are text, not
   * commands). The thread names it knows are the LIVE ones; `recentNames` adds the threads that
   * ended within the linger — for the name after a stop word only, so "the slack one" still
   * parses once the other stop source got to Slack first (the table answers false, nothing more).
   */
  private matchReflex(utterance: string, opts?: { readonly recentNames?: boolean }): Reflex | undefined {
    if (this.settings.reflexes === false || this.dictating) return undefined;
    if (!opts?.recentNames) return this.reflexRunner.match(utterance);
    const recent = this.threads
      .threads()
      .filter((x) => x.id !== MAIN_THREAD_ID && THREAD_TERMINAL.has(x.status))
      .map((x) => x.name);
    return this.reflexRunner.match(utterance, { threadNames: [...new Set([...this.threads.threadNames(), ...recent])], now: this.now });
  }

  /**
   * Live's words against the ear's recent reflexes, claimed for the delegation that
   * asks. A mismatch is undone first (⌘Z for a typed text) and comes back with
   * `undone`, so the delegator knows whether the effect stands.
   */
  private async reconcileReflex(utterance: string): Promise<Reconciliation | undefined> {
    const r = this.firedReflexes.reconcile(utterance);
    if (r?.kind === "mismatch") return { ...r, undone: await this.undoMismatch(r.fired.reflex, r.fired.phrase, utterance) };
    return r;
  }

  /**
   * The ear acted on other words than Kevin said (a partial that changed after it
   * fired). A typed text is taken back with ⌘Z while a text field is still focused;
   * either way the voice is told, so Kevin hears what happened — when the undo could
   * not run (the focus is a terminal, a canvas, an Electron view with no text role)
   * the typed words stand and he has to know. Idempotent reflexes (a scroll, a
   * screenshot) need nothing. Returns whether the effect was undone.
   */
  private async undoMismatch(reflex: Reflex, heard: string, said: string): Promise<boolean> {
    this.ledger.append({ at: this.now(), type: "reflex.mismatch", action: reflex.label, heard, said } as unknown as LedgerRow);
    log.warn(`reflex mismatch: the ear heard "${heard}" and ran ${reflex.label}; Kevin said "${normalizeForLog(said)}"`);
    if (reflex.idempotent) return false;
    if (reflex.kind !== "type") {
      this.live?.appendInstructions(null, `You ran "${reflex.label}" by reflex on words the on-device ear heard ("${heard}"), but Kevin actually said "${normalizeForLog(said).slice(0, 80)}". Tell him in one short sentence what was done, then carry on with what he asked.`);
      return false;
    }
    const typed = String(reflex.input["text"]).slice(0, 60);
    try {
      const f = await this.hands.request<FocusedText>("focused_text", {}, 1500);
      if (f && /AXText(Field|Area)|AXComboBox|AXWebArea/.test(f.role) && !f.secure) {
        const r = await this.toolset.run("key", { text: "cmd+z" });
        if (r.kind === "text") {
          this.live?.appendInstructions(null, `You typed "${typed}" by reflex but Kevin said something else; it has been undone. Tell him in one short sentence.`);
          return true;
        }
      }
    } catch (e) {
      log.debug(`undo after mismatch: ${(e as Error).message}`);
    }
    this.live?.appendInstructions(null, `You typed "${typed}" by reflex but Kevin said something else, and it could not be undone (the focus is not in a text field). Tell him in one short sentence so he can fix it; do not type it again on top.`);
    return false;
  }

  /**
   * A reflex on the ear's words: the engine-level kinds (circle, dictation) here,
   * everything else through the ReflexRunner and the gated toolset. A reflex the
   * policy wants a question for is dropped — the pending question it left is
   * cleared so a later "yes" cannot arm it — and the model path will ask.
   */
  private async runEarReflex(reflex: Reflex, _phrase: string, via: "ear" | "typed" = "ear"): Promise<ReflexOutcome & { readonly dropped?: string }> {
    const dispatchedAt = this.now();
    this.lastAddressedAt = dispatchedAt;
    switch (reflex.kind) {
      case "dictate_start":
      case "dictate_stop":
        return { reflex, result: { kind: "text", text: "OK" }, ms: 0, ok: true, dispatchedAt };
      case "circle": {
        const t0 = this.now();
        const ok = await this.circleUnderCursor();
        return { reflex, result: ok ? { kind: "text", text: "OK" } : { kind: "error", message: "nothing to circle" }, ms: this.now() - t0, ok, dispatchedAt };
      }
      default: {
        if (reflex.meta) {
          // A thread verb or the clock: the RESULT text is what Kevin hears, from Jarhead itself, now — no generation.
          // By ONE channel: spoken as an aside for the ear's words; for a typed line the typed instruction carries it.
          this.metaVia = via;
          let outcome: ReflexOutcome;
          try {
            outcome = await this.reflexRunner.run(reflex);
          } finally {
            this.metaVia = "other";
          }
          if (outcome.ok && outcome.result.kind === "text" && via !== "typed") this.speakAside(outcome.result.text);
          if (outcome.ok) this.emit("reflex", reflex.label, outcome.ms, true);
          return outcome;
        }
        const outcome = await this.reflexRunner.run(reflex);
        if (outcome.result.kind === "needs-confirmation") {
          // The runner recorded a question nobody will relay; the model path asks properly.
          // Unless Live's delegation for the same words joined this very run (`shared`): it
          // got the same outcome and relays the question, so the pending must stay for the yes.
          if (outcome.shared) {
            log.info(`ear reflex ${reflex.label} asks (${outcome.result.question.slice(0, 80)}); the delegation that joined it relays the question, the pending stays`);
          } else if (this.confirmations.pending?.id === outcome.result.pendingId) {
            this.confirmations.dropQuestion();
          } else if (ConfirmationDesk.isQueuedId(outcome.result.pendingId)) {
            // Queued behind a thread's question: nobody will relay it either; it leaves the queue so it is never promoted unspoken.
            this.desk.drop(ThreadAwareRunner.ACTOR);
          }
          if (!outcome.shared) log.info(`ear reflex ${reflex.label} dropped: the policy wants a yes (${outcome.result.question.slice(0, 80)})`);
          return { ...outcome, ok: false, dropped: "needs confirmation" };
        }
        if (outcome.result.kind === "error" && /^(refused|not a reflex)/.test(outcome.result.message)) {
          return { ...outcome, ok: false, dropped: outcome.result.message.slice(0, 120) };
        }
        if (outcome.ok) this.emit("reflex", reflex.label, outcome.ms, true);
        return outcome;
      }
    }
  }

  /** "Circle that": the blob traces a frame around the element under the cursor, else the frontmost window. */
  private async circleUnderCursor(): Promise<boolean> {
    let rect: Rect | undefined;
    let label: string | undefined;
    try {
      // Reads, on the reading helper: the acting one may be mid-click for a thread or the brain.
      const c = await this.pool.background.request<{ x: number; y: number }>("cursor", {}, 1000);
      const el = await this.pool.background.request<ElementInfo>("element_at", c, 1500).catch(() => undefined);
      if (el?.frame && el.frame.w >= 4 && el.frame.h >= 4 && el.frame.w * el.frame.h < 4_000_000) {
        rect = el.frame;
        label = el.title || el.description || el.role;
      }
      if (!rect) {
        const f = await this.pool.background.request<FrontmostInfo>("frontmost", {}, 1500);
        if (f.window) {
          rect = { x: f.window.x, y: f.window.y, w: f.window.w, h: f.window.h };
          label = f.window.title || f.app;
        }
      }
    } catch (e) {
      log.debug(`circle that: ${(e as Error).message}`);
    }
    if (!rect) return false;
    const padded: Rect = { x: rect.x - 6, y: rect.y - 6, w: rect.w + 12, h: rect.h + 12 };
    this.emit("overlay", { cmd: "orb.trace", points: roundedRectPoints(padded), closed: true, tone: "accent", ttlMs: 6000, ...(label ? { label: label.slice(0, 40) } : {}), reason: "reflex circle" });
    return true;
  }

  // ------------------------------------------------------------ dictation

  private startDictation(): void {
    if (this.dictating) return;
    this.dictating = true;
    this.kevinSpoke();
    // Kevin's live typing is never interleaved with a thread's: dictation holds the screen with priority until it
    // ends, and holds it as ONE op in flight — a holder that merely falls silent for LEASE_IDLE_MS lets a waiting
    // thread take the lease, and Kevin pausing between sentences is not letting go. (A long dictation can cost a
    // waiting thread its three waits; it then reports "could not get the screen".)
    void this.lease.acquire("dictation", { priority: true }).then((g) => {
      if (!g.ok) {
        log.debug(`dictation: the lease said ${g.reason}; typing anyway (Kevin's hands win)`);
        return;
      }
      if (this.dictating) this.lease.beginOp("dictation");
      else this.lease.release("dictation", "done");
    });
    this.live?.appendInstructions(null, "Kevin is dictating into a field on his screen: his words are being typed as he says them. Stay completely silent until he says \"stop dictating\"; do not delegate what he says.");
    this.ledger.append({ at: this.now(), type: "dictation", state: "started" } as unknown as LedgerRow);
    this.toast("dictating — say \"stop dictating\" to end", "info");
    this.recomputePhase();
  }

  private stopDictation(reason: "said" | "refused" | "asleep"): void {
    if (!this.dictating) return;
    this.dictating = false;
    this.lease.endOp("dictation");
    this.lease.release("dictation", "done");
    this.ledger.append({ at: this.now(), type: "dictation", state: "stopped", reason } as unknown as LedgerRow);
    if (reason !== "asleep") {
      this.live?.appendInstructions(null, reason === "refused" ? "Dictation stopped: the focused field is a password field or a hands-off app, so nothing was typed. Tell Kevin in one sentence." : "Kevin stopped dictating. Say \"done\" and carry on.");
      this.toast(reason === "refused" ? "dictation stopped: that field is off limits" : "dictation ended", reason === "refused" ? "warn" : "info");
    }
    this.recomputePhase();
  }

  /** Type dictated words into the focused field; false when the policy refuses (dictation ends). */
  private async dictateText(text: string): Promise<boolean> {
    const app = this.frontApp || (await this.frontmostAppName());
    if (HANDS_OFF_APPS.test(app)) return false;
    // The focused field decides: a password field is never typed into.
    const focused = await this.hands.request<FocusedText>("focused_text", {}, 1500).catch(() => undefined);
    const decision = classifyAction({ kind: "dictate", app, secureField: focused?.secure === true, text });
    if (decision.verdict !== "run") return false;
    // `ownDriver`: Kevin is the one typing, so the helper's "Kevin used the keyboard" check does not apply (B2's type op reads it).
    const r = await this.toolset.run("type", { text, ownDriver: true });
    this.lease.touch("dictation");
    if (r.kind === "needs-confirmation") {
      if (this.confirmations.pending?.id === r.pendingId) this.confirmations.dropQuestion();
      else if (ConfirmationDesk.isQueuedId(r.pendingId)) this.desk.drop(ThreadAwareRunner.ACTOR);
      return false;
    }
    if (r.kind === "error") {
      log.warn(`dictation type failed: ${r.message}`);
      return !/^refused/.test(r.message);
    }
    this.kevinSpoke();
    return true;
  }

  get isDictating(): boolean {
    return this.dictating;
  }

  // ---------------------------------------------------------- warm starts
  // At wake, before Kevin's first request: the brain's resident thread, one quick
  // screenshot (ScreenCaptureKit's first capture is the slow one, and the Screen
  // mapping is set), and the frontmost window's accessibility tree, kept fresh
  // every 500 ms so a spoken click finds its control without a walk.

  private warmStart(): void {
    const brain = this.brain;
    if (brain?.warmUp) {
      void brain.warmUp().then((r) => log.info(`brain warm at wake: ${r.warm ? "yes" : "not yet"} (${r.detail})`)).catch((e: Error) => log.debug(`brain warm-up: ${e.message}`));
    }
    // The warm thread brains (Settings.warmThreads processes), so the first splits land at once (no model request: primeThreads off).
    if (this.settings.threads) this.threads.warm();
    if (!this.hands.available && !this.hands.ready) return;
    if (!(this.brain instanceof ResponsesBrain)) {
      // The wake shot goes to the reading helper (ScreenCaptureKit's first capture is the slow one) and
      // still sets the main lane's Screen mapping, so a spoken click maps through it at once.
      const t0 = this.now();
      void this.pool.background
        .request<ScreenshotResult>("screenshot", { display: "cursor", maxLongEdge: QUICK_SHOT_BUDGET.maxLongEdge, maxPixels: QUICK_SHOT_BUDGET.maxPixels, excludePids: [...this.excludePids, process.pid], showCursor: true }, 6000)
        .then((shot) => {
          this.toolset.screen.remember(shot);
          log.info(`first screenshot at wake: image in ${this.now() - t0} ms`);
        })
        .catch((e: Error) => log.info(`first screenshot at wake: ${e.message}`));
    }
    this.startAxWarm();
  }

  private startAxWarm(): void {
    if (this.axWarmTimer || this.opts.hands === undefined && !this.hands.available) return;
    const tick = (): void => {
      if (!this.live || this.axWarmBusy) return;
      this.axWarmBusy = true;
      this.pool.background
        .request<AxTreeResult>("ax_tree", { summary: true, maxAgeMs: Engine.AX_WARM_MS - 100, maxMs: 80 }, 1500)
        .then((r) => {
          if (r.app) this.frontApp = r.app;
          // What the tick knows feeds the composite look for free: the app and the window by name.
          if (r.app) this.screenState.absorb({ ax: { ...(this.screenState.get(Number.POSITIVE_INFINITY)?.ax ?? { labels: [] }), app: r.app, window: r.window } });
          this.noteAxForHints(r);
        })
        .catch((e: Error) => log.debug(`ax warm: ${e.message}`))
        .finally(() => {
          this.axWarmBusy = false;
        });
    };
    tick();
    this.axWarmTimer = setInterval(tick, Engine.AX_WARM_MS);
    this.axWarmTimer.unref?.();
  }

  private stopAxWarm(): void {
    if (this.axWarmTimer) clearInterval(this.axWarmTimer);
    this.axWarmTimer = undefined;
    this.frontApp = "";
    this.resetEarHints();
  }

  // ------------------------------------------------------------ ear hints
  // What is on the screen, whispered to the app's on-device recogniser: the front app,
  // its window title, the visible controls' titles and the agents' names become
  // `SFSpeechAudioBufferRecognitionRequest.contextualStrings` on the ear's next segment
  // (apps/mac Ear/EarListener.swift `applyHints`), so "click Add Folder" comes back as
  // those words on the first partial — the one the reflex grammar matches (§12). Fed by
  // the AX warm tick above (every 500 ms while awake): the nodes are read from the
  // helper's cache only when the tree's summary changed (app, window, node count) or
  // every EAR_HINTS_REREAD_MS; the set is compared whole and `ear.hints` goes out only
  // when it changed, never more than twice a second (a trailing send carries the newest).
  // Real-clock timers here: they pace a wire message, not the session. Nothing on the
  // voice path or the reflex path awaits any of it.

  static readonly EAR_HINTS_MIN_INTERVAL_MS = 500;
  static readonly EAR_HINTS_REREAD_MS = 3000;
  private earHintsSummary = "";
  private earHintsReadAt = 0;
  private earHintsBusy = false;
  private earHintsLast = "";
  private earHintsSentAt = 0;
  private earHintsPending: readonly string[] | undefined;
  private earHintsTimer: NodeJS.Timeout | undefined;

  /** The warm tick's summary: is the tree worth reading for hints right now? */
  private noteAxForHints(r: AxTreeResult): void {
    if (!this.live || this.earHintsBusy) return;
    const summary = `${r.app}|${r.window}|${r.count}|${r.truncated ? 1 : 0}`;
    const now = performance.now();
    if (summary === this.earHintsSummary && now - this.earHintsReadAt < Engine.EAR_HINTS_REREAD_MS) return;
    this.earHintsSummary = summary;
    this.earHintsReadAt = now;
    this.earHintsBusy = true;
    this.pool.background
      .request<AxTreeResult>("ax_tree", { maxAgeMs: Engine.AX_WARM_MS + 200, maxMs: 80 }, 1500)
      .then((tree) => {
        if (!this.live) return;
        // The labelled controls, read once per change of the tree: the composite look's list, at no extra probe.
        this.screenState.absorb({ ax: axLabels(tree) });
        this.sendEarHints(earHintsFrom(tree.nodes ?? [], tree.app, tree.window, this.agentsList.map((a) => a.name)));
      })
      .catch((e: Error) => log.debug(`ear hints: ${e.message}`))
      .finally(() => {
        this.earHintsBusy = false;
      });
  }

  /** `ear.hints` when the set changed, at most twice a second. */
  private sendEarHints(strings: readonly string[]): void {
    const key = strings.join("");
    if (key === this.earHintsLast) return;
    const now = performance.now();
    const wait = Engine.EAR_HINTS_MIN_INTERVAL_MS - (now - this.earHintsSentAt);
    if (wait > 0) {
      this.earHintsPending = strings;
      if (!this.earHintsTimer) {
        this.earHintsTimer = setTimeout(() => {
          this.earHintsTimer = undefined;
          const pending = this.earHintsPending;
          this.earHintsPending = undefined;
          if (pending && this.live) this.sendEarHints(pending);
        }, wait);
        this.earHintsTimer.unref?.();
      }
      return;
    }
    this.earHintsLast = key;
    this.earHintsSentAt = now;
    log.debug(`ear hints: ${strings.length} strings (${strings.slice(0, 6).join(", ")}${strings.length > 6 ? ", …" : ""})`);
    this.emit("ear.hints", strings);
  }

  private resetEarHints(): void {
    if (this.earHintsTimer) clearTimeout(this.earHintsTimer);
    this.earHintsTimer = undefined;
    this.earHintsPending = undefined;
    this.earHintsSummary = "";
    this.earHintsReadAt = 0;
    this.earHintsLast = "";
  }

  /** Ask the host to restart this process on the current code (the app respawns on exit 75). */
  requestRestart(reason: string): void {
    log.info(`restart requested: ${reason}`);
    this.toast("Jarhead is restarting on its new code", "info");
    this.emit("restart", reason);
  }

  /** Tell every surface to drop queued speaker audio. */
  private flushSpeaker(): void {
    this.emit("event", { type: "speaker-flush" });
  }

  registerOwnPid(pid: number): void {
    this.excludePids.add(pid);
  }

  async command(cmd: EngineCommand): Promise<void> {
    switch (cmd.type) {
      case "sleep":
        // The app's dock drop sends cause "dock"; the CLI's bare sleep sends none ("command"). Only a spoken cue gets the farewell.
        return this.fallAsleep(cmd.cause ?? "command", { ...(cmd.phrase ? { phrase: cmd.phrase } : {}), farewell: cmd.cause === "said" });
      case "thread.stop":
        return this.stopThread(cmd.threadId);
      case "thread.pause":
        return this.pauseThread(cmd.threadId);
      case "thread.resume":
        return this.resumeThread(cmd.threadId);
      case "thread.answer":
        return this.answerThread(cmd.threadId, cmd.yes === true);
      case "thread.say":
        return this.sayToThread(cmd.threadId, String(cmd.text ?? ""));
      case "thread.open":
        return this.openThread(cmd.threadId, cmd.viewer);
      case "thread.close":
        return this.closeThread(cmd.threadId, cmd.viewer);
      case "thread.history":
        return this.threadHistory(cmd.threadId, Number(cmd.before) || 0);
      case "mute":
        return this.setMuted(true);
      case "unmute":
        return this.setMuted(false);
      case "stop":
        return this.pressStop("stop command");
      case "go":
        return this.go();
      case "interrupt":
        return this.interrupt("interrupt command", cmd.how ?? "pressed");
      case "say-text":
        return this.sayText(cmd.text);
      case "set-settings":
        return this.updateSettings(cmd.patch);
      case "clear-problems":
        this.problems = [];
        return this.scheduleSnapshot();
      case "agent.send": {
        // M7: the pane shows Kevin's line at once — one `pending` echo before the await (dropped by the app when the
        // real turn lands) — then a toast with the agent's NAME and how the line travelled, and one log line with ms.
        const t0 = performance.now();
        const name = this.agentsList.find((a) => a.id === cmd.agentId)?.name ?? cmd.agentId;
        const open = this.openConversations.get(cmd.agentId);
        const echo: AgentMessage = { id: `pending:${newId("msg")}`, role: "user", text: cmd.text, at: this.now(), pending: true };
        this.emit("event", { type: "agent.transcript", transcript: { agentId: cmd.agentId, messages: [echo], total: open?.total ?? 0, complete: false, live: open?.unwatch !== undefined }, mode: "append" });
        const r = await this.agents.send(cmd.agentId, cmd.text);
        const ms = Math.round(performance.now() - t0);
        const mode = r.mode === "queue" ? "queued" : r.mode === "resume" ? "resumed" : r.mode === "answer" ? "answered" : undefined;
        this.toast(r.accepted ? `Sent to ${name}${mode ? ` · ${mode}` : ""}` : `Not sent · ${r.detail ?? "refused"}`, r.accepted ? "info" : "warn");
        log.info(`agent.send ${name}: ${r.accepted ? (r.mode ?? "sent") : `refused: ${r.detail ?? "?"}`} in ${ms} ms`);
        return;
      }
      case "agent.refresh": {
        const r = await this.agents.refresh();
        this.connectorHealth = r.health;
        this.agentsList = r.agents;
        return this.scheduleSnapshot();
      }
      case "config.set-secrets":
        return this.setSecrets(cmd.secrets);
      case "config.probe": {
        await this.probeSetup();
        return;
      }
      case "agent.open":
        return this.openAgent(cmd.agentId, cmd.viewer);
      case "agent.close":
        return this.closeAgent(cmd.agentId, cmd.viewer);
      case "agent.history":
        return this.agentHistory(cmd.agentId, cmd.before);
      case "voice.reopen":
        return this.reopenVoice();
      case "memory.forget":
      case "memory.restore":
      case "memory.edit":
      case "memory.add":
      case "memory.run": {
        // Forget is a state, never a deletion; a run starts only when no session is up (the same rule as the tick's).
        this.toast(await this.memory.command(cmd, this.quiet), "info");
        return this.scheduleSnapshot();
      }
      case "mark.add":
        return this.addMark(cmd.rect, cmd.path);
      case "mark.remove":
        return this.removeMark(String((cmd as { id?: unknown }).id ?? ""));
      case "mark.window":
        void this.markFrontWindow();
        return;
      case "mark.clear":
        return this.clearMarks();
      case "daemon.restart":
        return this.requestRestart("restart command");
      case "pause":
        return this.pause();
      case "resume":
        return this.resume();
      case "request-permission":
        return this.requestPermission(cmd.which);
      // ---- conversation cleanup (K1): commands only, never a brain tool; nothing is deleted.
      case "conversation.trash":
        return this.markConversation(cmd.chainId, (at, chainId) => ({ at, type: "conversation.trashed", chainId, by: "kevin" }));
      case "conversation.restore":
        return this.markConversation(cmd.chainId, (at, chainId) => ({ at, type: "conversation.restored", chainId }));
      case "conversation.archive":
        return this.markConversation(cmd.chainId, (at, chainId) => ({ at, type: "conversation.archived", chainId }));
      case "conversation.rename":
        return this.markConversation(cmd.chainId, (at, chainId) => ({ at, type: "conversation.renamed", chainId, name: String(cmd.name ?? "").replace(/\s+/g, " ").trim().slice(0, Engine.NAME_CHARS) }));
      case "conversation.pin":
        return this.markConversation(cmd.chainId, (at, chainId) => ({ at, type: "conversation.pinned", chainId, pinned: cmd.pinned === true }));
      case "conversation.new":
        return this.newConversation();
      case "now.clear":
        return this.clearNow();
      case "now.restore":
        return this.restoreNow();
      case "ledger.trash-day":
        return this.trashDay(String(cmd.day), cmd.what === "shots" || cmd.what === "both" ? cmd.what : "ledger");
      case "ledger.restore-day":
        return this.restoreDay(String(cmd.day));
      case "ledger.sweep":
        this.runSweep("command");
        return;
      case "agent.hide":
        return this.hideAgent(String(cmd.agentId), cmd.hidden === true);
      case "problem.retry":
        return this.retryProblem(cmd.kind);
      case "open-console":
      case "open-ledger":
        return; // the shell handles window commands
    }
  }

  async stop(): Promise<void> {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.localHealAt = 0;
    if (this.dockAuditTimer) clearTimeout(this.dockAuditTimer);
    this.dockAuditTimer = undefined;
    this.stopAxWarm();
    this.closeConversations();
    await this.fallAsleep("shutdown");
    // The process is going away with the session; no deadline may fire into a gone engine.
    for (const t of this.closeTimers) clearTimeout(t);
    this.closeTimers.clear();
    this.lease.cancelAll("shutdown");
    await this.brain?.stop();
    this.pool.stop();
  }

  // ----------------------------------------------------------------- state

  /** Kevin's own input landed: presence, attention, and any announced sleep is off. */
  private kevinSpoke(): void {
    this.lastKevinAt = this.now();
    this.lastAddressedAt = this.lastKevinAt;
    this.sleepDeadlineAt = undefined;
  }

  private onAction(a: ActionEvent): void {
    if (a.member === "mouse_move" && a.points) this.emit("overlay", { cmd: "point", x: a.points.x, y: a.points.y, ttlMs: 3000 });
    this.lastAddressedAt = this.now();
  }

  private tick(): void {
    const now = this.now();
    // Speaking decays when the transcript stops arriving; levels alone lie (silence frames).
    this.recomputePhase();
    this.pruneMarks();
    if (Ledger.fileNameFor(now) !== this.usageDay) this.loadUsageToday();
    if (this.sweepPending) this.runPendingSweep();
    this.watchdog();
    if (now - this.memoryLoggedAt >= Engine.MEMORY_LOG_MS) {
      this.memoryLoggedAt = now;
      this.logMemory();
    }
    this.problemsTick(now);
    // The local heal: Kevin picked `local`, no local brain is ready, a minute passed — look again (and restart onto the server when it can run the pick).
    if (this.localHealAt !== 0 && now >= this.localHealAt) {
      this.localHealAt = now + Engine.LOCAL_HEAL_MS;
      void this.healLocal();
    }
    // A question queued behind one Kevin moved on from comes up now (the desk cannot see the root's drop).
    this.desk.promote();
    const idleMs = this.settings.idleSleepMinutes * 60_000;
    // Not idle while a task runs — or while a thread still works (Live stays open for its question and
    // for the spoken stop; its caps bound the worst case at about five minutes).
    const busy = this.delegator?.active !== undefined || this.threads.running() > 0;
    // The table's clock: acting→thinking after 4 s without a step, the spares topped up, the idle threads ended.
    this.threads.tick(now);
    // Five seconds before the idle sleep, one clause ("going to sleep") — and the sleep then
    // falls due on a fixed deadline, so the announcement (Jarhead's own speech moves
    // lastAddressedAt) cannot postpone it; only Kevin's input does (kevinSpoke).
    if (this.live && !this.connecting && this.live.currentState === "started" && !busy && idleMs > 5000 && this.sleepDeadlineAt === undefined && now - this.lastAddressedAt > idleMs - 5000 && now - this.lastKevinAt > idleMs - 5000) {
      this.sleepDeadlineAt = now + 5000;
      this.delegator?.announceSleep(5);
    }
    if (this.live && !this.connecting && this.live.currentState === "started" && !busy && idleMs > 0 && (now - this.lastAddressedAt > idleMs || (this.sleepDeadlineAt !== undefined && now >= this.sleepDeadlineAt))) {
      this.sleepDeadlineAt = undefined;
      log.info(`idle for ${this.settings.idleSleepMinutes} min; sleeping`);
      this.toast("asleep — tap the orb to wake", "info");
      void this.fallAsleep("idle");
    }
    // A pause nobody resumed decays to sleep: the held conversation is let go.
    if (this.pauseInfo && !this.connecting && now >= this.pauseInfo.sleepsAt) {
      log.info(`paused ${Math.round((now - this.pauseInfo.at) / 60_000)} min without a resume; sleeping`);
      this.toast("paused too long · asleep", "info");
      void this.fallAsleep("pause-decayed");
    }
    // Whatever state the session is in: the session clock closes utterances after GAP_MS, the wall clock after ORPHAN_MS (an errored session's clock stops).
    if (this.live) this.transcript.settle(this.live.nowMs, now);
    // A conversation a failed reconnect held decays as a pause would: the next Go starts afresh.
    if (this.heldReconnect && !this.live && !this.connecting && now >= this.heldReconnect.sleepsAt) {
      log.info(`the conversation cut ${Math.round((now - this.heldReconnect.at) / 60_000)} min ago was never reconnected; let go`);
      this.dropHeldReconnect();
    }
    // Memory reads closed conversations only when nothing is up — no session, none opening, no pause
    // held, no reconnect pending (a pause closes the session too; the run waits for the resume or the decay).
    this.memory.drain(this.quiet);
    void this.pollPermissions();
    this.emit("event", { type: "levels", levels: this.levels() });
  }

  /** How often tick() writes the memory line. */
  private static readonly MEMORY_LOG_MS = 5 * 60_000;
  /** Above this heap the line becomes a warning naming what is held. */
  private static readonly HEAP_WARN_BYTES = 1.5 * 1024 * 1024 * 1024;

  /**
   * The memory watch (REDESIGN §16): `process.memoryUsage()` every five minutes at info,
   * so a V8 heap OOM (node-2026-09-11-151650.ips: `node::OOMErrorHandler`, path masked,
   * possibly this daemon) can be read against a trend next time rather than guessed at.
   * Past 1.5 GB of heap the line is a warning and names the holders this class can
   * count: the two transcripts, the delegations kept and live, the marks and their
   * captures in flight, the open conversations (each holds a live tail), the problems.
   * Screenshots are files under `shots/`, not buffers here. No heap flag changes: a watch.
   */
  private logMemory(): void {
    const m = process.memoryUsage();
    const mb = (n: number): number => Math.round(n / 1_048_576);
    const line = `memory: rss ${mb(m.rss)} MB · heap ${mb(m.heapUsed)} / ${mb(m.heapTotal)} MB · external ${mb(m.external)} MB · arrayBuffers ${mb(m.arrayBuffers)} MB`;
    if (m.heapUsed <= Engine.HEAP_WARN_BYTES) {
      log.info(line);
      return;
    }
    const holders = [
      `transcript ${this.transcript.all().length} items + ${this.heldTranscript.length} held`,
      `delegations ${this.lastDelegations.length} kept + ${this.delegator?.all().length ?? 0} live`,
      `marks ${this.marks.length} (${this.markCaptures.size} captures in flight)`,
      `open conversations ${this.openConversations.size}`,
      `problems ${this.problems.length}`,
      `close timers ${this.closeTimers.size}`,
    ];
    log.warn(`${line} — heap over ${mb(Engine.HEAP_WARN_BYTES)} MB; holders: ${holders.join(", ")}`);
  }

  /**
   * The transport's invariants, enforced once a second: no session while paused
   * (a resume's opening session excepted: the pause is held until it starts); no
   * session that outlived a stop (nobody wants it awake, it is not connecting, and
   * it is still here after WATCHDOG_OUTLIVED_MS); no phase but asleep / error
   * without a session, a connect or a pause. A normal connect never trips it — a
   * wake's or a resume's: every rule that names a session excludes `connecting`,
   * which is set for the whole handshake. Each incident is logged once.
   */
  private watchdog(): void {
    const now = this.now();
    const live = this.live;
    // A session mid-handshake is never the watchdog's to close: `connecting` covers it,
    // and so does its state, so a stale flag can never cut a resume short. A session
    // already asked to close (state closing) is still its business: that is the one
    // that outlives a stop when the server never answers.
    const handshaking = live !== undefined && (live.currentState === "idle" || live.currentState === "connecting");
    if (live && !handshaking && this.pauseInfo && !this.connecting) {
      this.incident(`paused-open:${live.session?.id ?? "?"}`, "watchdog: a session was open while paused; closing it");
      this.detachLive(live);
      this.closeWithDeadline(live, "watchdog (paused)");
      return;
    }
    if (live && !handshaking && !this.wantAwake && !this.connecting) {
      if (!this.outlivedSince) this.outlivedSince = now;
      else if (now - this.outlivedSince > Engine.WATCHDOG_OUTLIVED_MS) {
        const id = live.session?.id ?? "?";
        this.incident(`outlived:${id}`, `watchdog: session ${id} outlived stop; terminating it`);
        this.detachLive(live);
        live.terminate();
        this.setPhase("asleep");
      }
    } else {
      this.outlivedSince = 0;
    }
    if (!live && !this.connecting && !this.pauseInfo && this.phase !== "asleep" && this.phase !== "error") {
      this.incident(`phase:${this.phase}`, `watchdog: phase ${this.phase} with no session; asleep`);
      this.setPhase("asleep");
    }
  }

  private incident(key: string, text: string): void {
    // Once a minute per kind: a repeat is worth knowing about, a storm is not.
    const last = this.watchdogSeen.get(key) ?? 0;
    if (this.now() - last < 60_000) return;
    this.watchdogSeen.set(key, this.now());
    log.warn(text);
  }

  private levels(): AudioLevels {
    return { input: this.inputLevel, output: this.live && !this.pauseInfo ? this.outputLevel : 0 };
  }

  private recomputePhase(): void {
    // Paused is decided first: there is no session while paused, and that is not asleep.
    if (this.pauseInfo) {
      if (!this.connecting) this.setPhase("paused");
      return;
    }
    if (!this.live || this.connecting) {
      if (this.phase !== "connecting" && this.phase !== "error") this.setPhase("asleep");
      return;
    }
    if (this.muted) return this.setPhase("muted");
    if (this.dictating) return this.setPhase("acting");
    const active = this.delegator?.active;
    if (this.now() - this.lastOutputSpeechAt < 1200 && !this.outputGated) return this.setPhase("speaking");
    if (active) {
      const acting = active.steps.some((s) => (s.kind === "tool" || s.kind === "screenshot") && this.now() - s.at < 4000);
      return this.setPhase(acting ? "acting" : "thinking");
    }
    this.setPhase("listening");
  }

  private setPhase(phase: Phase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.scheduleSnapshot();
  }

  get currentPhase(): Phase {
    return this.phase;
  }

  // ------------------------------------------------------- problems, typed
  // A problem is one line Kevin can read, its kind, and the ONE thing to press for it
  // (REDESIGN §16, "Problems, typed"). `problems` (the lines) is the order and the cap;
  // `problemMeta` carries kind, remedy and first-seen per line, so `typedProblems()` —
  // the snapshot's `problems` — is the same list with its remedies. Deduped by kind + text; a line
  // raised again while present keeps its `since`; a fixed problem clears itself at the
  // site that knows (a grant appears, the helper greets, the key answers, the voice
  // reconnects) or on `problem.retry`, which re-runs that kind's check.

  /** How many problem lines the snapshot carries; the oldest leave first. */
  static readonly MAX_PROBLEMS = 8;

  /** A problem of no particular kind (the daemon's "command failed", a settings write). */
  problem(text: string): void {
    this.problemOf("other", text);
  }

  /** Raise a problem: the log line, the ledger row and the snapshot on the first sighting; a repeat only refreshes the remedy. */
  problemOf(kind: ProblemKind, text: string, remedy?: ProblemRemedy): void {
    const have = this.problemMeta.get(text);
    if (have && have.kind === kind) {
      // Present already: keep its place and its since; a remedy may have been added since.
      if (remedy && !have.remedy) this.problemMeta.set(text, { ...have, remedy });
      return;
    }
    log.warn(text);
    this.problems = [...this.problems.filter((p) => p !== text), text].slice(-Engine.MAX_PROBLEMS);
    this.problemMeta.set(text, { kind, ...(remedy ? { remedy } : {}), since: this.now() });
    this.pruneProblemMeta();
    this.ledger.append({ at: this.now(), type: "problem", text });
    this.scheduleSnapshot();
  }

  /**
   * One row per kind, its text refreshed in place: the disk figure, the reconnect's
   * elapsed seconds. The first sighting is a problem like any other; a refresh keeps the
   * row's `since` and writes no ledger row and no log line.
   */
  private replaceProblem(kind: ProblemKind, text: string, remedy?: ProblemRemedy): void {
    const existing = this.problems.filter((p) => this.problemMeta.get(p)?.kind === kind);
    if (existing.length === 0) {
      this.problemOf(kind, text, remedy);
      return;
    }
    const since = Math.min(...existing.map((p) => this.problemMeta.get(p)?.since ?? this.now()));
    const keep = existing[existing.length - 1]!;
    if (keep === text && existing.length === 1) return;
    // The newest row of the kind takes the new text in place; older rows of the kind leave; the text appears once.
    const next: string[] = [];
    for (const p of this.problems) {
      if (p === keep) {
        if (!next.includes(text)) next.push(text);
      } else if (this.problemMeta.get(p)?.kind !== kind && p !== text) {
        next.push(p);
      }
    }
    this.problems = next;
    for (const p of existing) if (p !== text) this.problemMeta.delete(p);
    this.problemMeta.set(text, { kind, ...(remedy ? { remedy } : {}), since });
    this.scheduleSnapshot();
  }

  /** Every problem of a kind is over — or only those whose text `where` picks. */
  private clearProblems(kind: ProblemKind, where: (text: string) => boolean = () => true): void {
    const gone = this.problems.filter((p) => this.problemMeta.get(p)?.kind === kind && where(p));
    if (gone.length === 0) return;
    this.problems = this.problems.filter((p) => !gone.includes(p));
    for (const p of gone) this.problemMeta.delete(p);
    this.scheduleSnapshot();
  }

  /** One exact line is over (the permission sites clear by their catalogue text). */
  private clearProblemText(text: string): void {
    if (!this.problems.includes(text)) return;
    this.problems = this.problems.filter((p) => p !== text);
    this.problemMeta.delete(text);
    this.scheduleSnapshot();
  }

  /** Meta for a line that left the capped list (or `clear-problems` emptied it) is garbage. */
  private pruneProblemMeta(): void {
    for (const text of this.problemMeta.keys()) if (!this.problems.includes(text)) this.problemMeta.delete(text);
  }

  /** The problems with their kind, remedy and first-seen: the snapshot's `problems`. */
  typedProblems(): Problem[] {
    this.pruneProblemMeta();
    return this.problems.map((text) => {
      const meta = this.problemMeta.get(text);
      return { kind: meta?.kind ?? "other", text, ...(meta?.remedy ? { remedy: meta.remedy } : {}), since: meta?.since ?? this.now() };
    });
  }

  /** The remedies that are one command away. */
  private static readonly PROBE_REMEDY: ProblemRemedy = { label: "Retry", command: { type: "config.probe" } };
  /** A brain row's Retry restarts the brain (`config.probe` only re-checks the key and never re-selects). */
  private static readonly BRAIN_REMEDY: ProblemRemedy = { label: "Retry", command: { type: "problem.retry", kind: "brain.unavailable" } };
  private static readonly LOCAL_REMEDY: ProblemRemedy = { label: "Retry", command: { type: "problem.retry", kind: "brain.local" } };
  private static readonly SETUP_REMEDY: ProblemRemedy = { label: "Open Setup", open: "jarhead://setup" };
  private static readonly GO_REMEDY: ProblemRemedy = { label: "Retry", command: { type: "go" } };
  private static readonly LIMIT_REMEDY: ProblemRemedy = { label: "Retry in 30 s", command: { type: "problem.retry", kind: "voice.limit" } };

  /**
   * A GPT-Live-1 error as a typed problem: a cap (`voice.limit`, clears itself after
   * VOICE_LIMIT_CLEAR_MS), the socket (`voice.connection`), the key (`voice.key` → Setup),
   * anything else as it is. `classifyLiveError` (packages/live) reads the message.
   */
  private voiceProblem(text: string, connectionRemedy: ProblemRemedy = Engine.GO_REMEDY): void {
    switch (classifyLiveError(text)) {
      case "limit":
        return this.problemOf("voice.limit", text, Engine.LIMIT_REMEDY);
      case "key":
        return this.problemOf("voice.key", text, Engine.SETUP_REMEDY);
      case "connection":
        return this.problemOf("voice.connection", text, connectionRemedy);
      default:
        return this.problemOf("other", text);
    }
  }

  /**
   * The remedy button was pressed (`problem.retry {kind}`): re-run that kind's check and
   * let the row clear when it passes. The permission kinds ask again (the helper's two
   * prompt; the app owns the rest, so the engine reads fresh and closely); the brain
   * restarts and is probed; the voice reconnects when it should be awake; the helper is
   * a new process; the disk is measured again; the Dock is repaired (the one retry that
   * writes: `defaults import` + `killall Dock`, what `pnpm jarhead dock --fix` does) and
   * read again. A limit is over by the time anyone presses it; a crash report and the
   * daemon row are the surface's to dismiss.
   */
  async retryProblem(kind: ProblemKind): Promise<void> {
    log.info(`problem.retry ${kind}`);
    switch (kind) {
      case "permission.accessibility":
      case "permission.screenRecording":
        await this.requestPermission(kind === "permission.accessibility" ? "accessibility" : "screenRecording");
        return;
      case "permission.microphone":
      case "permission.fullDiskAccess":
      case "permission.other":
        // The app owns these prompts and panes; what the engine can do is read fresh, now and closely.
        this.permissionFastUntil = this.now() + 90_000;
        this.permissionPollAt = 0;
        await this.pollPermissions();
        this.scheduleSnapshot();
        return;
      case "brain.unavailable":
      case "brain.probe":
      case "brain.local":
        this.clearProblems(kind);
        await this.restartBrain("problem.retry");
        await this.probeSetup();
        return;
      case "voice.limit":
        this.clearProblems(kind);
        return;
      case "voice.connection":
        this.clearProblems(kind);
        this.voiceReconnectSince = 0;
        if (this.wantAwake && !this.live && !this.connecting && !this.pauseInfo) await this.connect("problem.retry");
        return;
      case "voice.key":
        await this.probeSetup(); // clears itself when the key answers
        return;
      case "hands.helper":
        this.clearProblems(kind);
        if (this.hands.available) {
          try {
            await this.pool.restartAll();
          } catch (e) {
            this.problemOf("hands.helper", `hands helper failed: ${(e as Error).message}`, Engine.HANDS_REMEDY);
            return;
          }
        }
        await this.probeHands();
        return;
      case "disk.low":
        this.checkDisk();
        this.scheduleSnapshot();
        return;
      case "dock":
        this.fixDock();
        return;
      case "daemon":
      case "crash":
      case "other":
        this.clearProblems(kind);
        return;
    }
  }

  // ------------------------------------------------------------ one Jarhead: the Dock
  // "There should only be one Jarhead." The install keeps the bundle directory's inode so
  // the pin's bookmark stays valid, but a Dock that had already grown a second tile keeps
  // it until something removes it. The engine READS the Dock — `defaults export
  // com.apple.dock -`, ~100 ms; never lsregister, which waits on lsd for up to two
  // minutes — 20 s after start(), and when Jarhead is there twice (a recent tile next to
  // the pin, or two pins) raises `dock`, "Two Jarhead tiles in the Dock", with Fix the Dock
  // as its one remedy. The fix runs only on that press (`problem.retry {kind:"dock"}`):
  // the Dock half of `pnpm jarhead dock --fix` — drop Jarhead's recent tiles, keep one
  // pin stripped to the keys the Dock rebuilds its bookmark from, `defaults import`
  // behind the mod-count race check, `killall Dock` — then a re-read clears the row, and
  // tick() reads once more 10 s later to see the tile stayed gone. An import whose
  // `killall Dock` failed is not fixed — the Dock still draws both tiles and cfprefsd's
  // clean copy is not the truth — so the row stays ("— Dock not restarted"), no recheck
  // is armed, and the next press runs only the restart. No pin → one tile at most and
  // nothing the fix could do, so no row (pinning is Kevin's). Every shell-out is capped
  // at DOCK_EXEC_TIMEOUT_MS (spawnSync on the event loop). Nothing here touches a file;
  // the Trash is never read.

  /** How long after start() the Dock is first read: the app's own launch is still moving tiles for a few seconds. */
  static readonly DOCK_AUDIT_DELAY_MS = 20_000;
  /** After a fix, tick() reads the Dock once more this much later: a relaunched Dock rewrites its domain. */
  static readonly DOCK_RECHECK_MS = 10_000;
  /** The one thing to press: the repair, then a re-read. */
  static readonly DOCK_REMEDY: ProblemRemedy = { label: "Fix the Dock", command: { type: "problem.retry", kind: "dock" } };
  /**
   * Cap on each Dock shell-out (`defaults export` is ~100 ms; `defaults import`, `killall
   * Dock`). They run spawnSync on the daemon's event loop — 20 s in and on a press only —
   * so a hung cfprefsd stalls a voice session for at most this long, not defaultExec's 20 s.
   * A timed-out export reads as `skipped`.
   */
  static readonly DOCK_EXEC_TIMEOUT_MS = 3_000;
  private static readonly DOCK_OPTS = { bundleId: JARHEAD_BUNDLE_ID, installedUrl: INSTALLED_URL, timeoutMs: Engine.DOCK_EXEC_TIMEOUT_MS } as const;

  /** The Dock exists on macOS; a scripted exec (tests) runs the audit anywhere. */
  private dockAuditable(): boolean {
    return this.opts.exec !== undefined || process.platform === "darwin";
  }

  /**
   * The row an audit earns, or none: two or more Jarhead tiles with a pin among them
   * ("Two Jarhead tiles in the Dock"; the count past two), else a pin whose URL is not
   * the installed bundle's. A recent tile with no pin is one tile — nothing to fix.
   */
  static dockProblemText(a: DockAudit): string | undefined {
    const tiles = a.pinned + a.recent;
    if (a.pinned >= 1 && tiles >= 2) return tiles === 2 ? "Two Jarhead tiles in the Dock" : `${tiles} Jarhead tiles in the Dock`;
    const rebuild = a.changes.find((c) => c.kind === "rebuild-pin");
    if (rebuild && rebuild.urlWas !== INSTALLED_URL) return `The Dock's Jarhead pin points at ${rebuild.urlWas ?? "nothing"}`;
    return undefined;
  }

  /** Read the Dock (one `defaults export`, no write) and set or clear the `dock` row from what it says. */
  checkDock(reason: string): DockAudit | undefined {
    const read = readDock(this.exec, Engine.DOCK_OPTS);
    if ("skipped" in read) {
      // No Dock to read (headless, or cfprefsd said no): not a problem of Kevin's to fix.
      log.debug(`dock audit (${reason}) skipped: ${read.skipped}`);
      return undefined;
    }
    const text = Engine.dockProblemText(read);
    if (text) this.replaceProblem("dock", text, Engine.DOCK_REMEDY);
    // A clean read while a restart is owed is cfprefsd's import, not what the Dock draws: the row stays.
    else if (!this.dockRestartOwed) this.clearProblems("dock");
    log.info(`dock audit (${reason}): ${describeDock(read)}${text ? ` — ${text}` : ""}${!text && this.dockRestartOwed ? " — Dock not restarted, row kept" : ""}`);
    this.scheduleSnapshot();
    return read;
  }

  /**
   * Fix the Dock was pressed: the repair (the same rounds, import and `killall Dock` as
   * `pnpm jarhead dock --fix`), then the re-read that clears the row when it is clean and
   * keeps it — with the reason — when it is not; tick() reads once more DOCK_RECHECK_MS later.
   * An import whose `killall Dock` failed keeps the row too ("— Dock not restarted"): the
   * re-read is only cfprefsd's copy until the Dock relaunches, so no recheck is armed and
   * the next press runs just the restart. A read that fails toasts why and leaves the row.
   */
  private fixDock(): void {
    const opts = { ...Engine.DOCK_OPTS, log: (line: string) => log.info(line) };
    const before = readDock(this.exec, opts);
    if ("skipped" in before) {
      // The row stands — the read that raised it worked — and a press has to be seen to do something.
      log.warn(`fix the Dock: ${before.skipped}`);
      this.toast(`Could not read the Dock: ${before.skipped}`, "warn");
      return;
    }
    let did: string;
    let written: boolean;
    let restarted: boolean;
    let after: DockAudit = before;
    let skipped: string | undefined;
    if (before.changes.length > 0) {
      const r = repairDock(this.exec, before, opts);
      did = describeDockChanges(before.changes);
      written = r.imported;
      restarted = r.restarted;
      after = r.after ?? before;
      skipped = r.skipped;
    } else if (this.dockRestartOwed) {
      // The last press imported the clean document; only the relaunch is owed.
      did = "restarted";
      written = true;
      restarted = restartDock(this.exec, opts);
    } else {
      log.info(`fix the Dock: nothing to repair (${describeDock(before)})`);
      this.clearProblems("dock");
      this.scheduleSnapshot();
      return;
    }
    log.info(`fix the Dock: ${describeDock(after)} (${did}${restarted ? ", Dock restarted" : written ? ", Dock NOT restarted" : ", nothing written"})${skipped ? ` — ${skipped}` : ""}`);
    this.dockRestartOwed = written && !restarted;
    if (this.dockRestartOwed) {
      const stood = Engine.dockProblemText(before) ?? this.typedProblems().find((p) => p.kind === "dock")?.text.replace(/ — .*$/, "") ?? "Two Jarhead tiles in the Dock";
      this.replaceProblem("dock", `${stood} — Dock not restarted`, Engine.DOCK_REMEDY);
      this.toast("Dock written, not restarted — press Fix the Dock again", "warn");
      this.scheduleSnapshot();
      return;
    }
    const text = Engine.dockProblemText(after);
    if (!text) {
      this.clearProblems("dock");
      this.toast(`Dock fixed: ${did}`, "info");
    } else {
      this.replaceProblem("dock", skipped ? `${text} — ${skipped}` : text, Engine.DOCK_REMEDY);
    }
    this.dockRecheckAt = this.now() + Engine.DOCK_RECHECK_MS;
    this.scheduleSnapshot();
  }

  // --------------------------------------- liveness, preflight, auto-resume (K3)
  // What survives the engine process dying: the disk is measured before a session opens
  // and before a shot is written; a crash report younger than ten minutes becomes a row
  // with the file behind it; and the ledger says what the previous process was doing —
  // a pause is held again (meter stopped, decaying as it would have), a session cut
  // mid-conversation is resumed by the first Go inside the window with its last lines
  // read back from the ledger, and the voice says "back" once. Never twice; never after
  // Kevin's Stop (a pressed stop row before the cut, or one in this process). The daemon's
  // liveness itself is the app's (ping / pong on the wire, DaemonProcess respawns).

  /** Under this much free space on the state dir's volume, shots are skipped and `disk.low` is raised. */
  static readonly DISK_LOW_BYTES = 500 * 1024 * 1024;
  /** How often a low disk is measured again from tick(), so the row clears when space returns. */
  static readonly DISK_RECHECK_MS = 60_000;
  /** A `voice.limit` row clears itself after this long: the cap it names is per request or per minute. */
  static readonly VOICE_LIMIT_CLEAR_MS = 30_000;
  /** A Go this long after start() still resumes the session the previous process was cut from. */
  static readonly AUTO_RESUME_WINDOW_MS = 30_000;
  /** A session whose last row is older than this was not cut by the restart that just happened. */
  static readonly LOST_SESSION_MAX_AGE_MS = 30 * 60_000;
  /**
   * A session that was itself a resume and whose rows span less than this before the next
   * cut is a resume that died young — a loop (a daemon that dies soon after every resume),
   * not a conversation; the next process does not resume it again. A pause's resume is
   * Kevin's own chain and is exempt.
   */
  static readonly RESUME_LOOP_SPAN_MS = 60_000;
  /** A crash report older than this is history, not a problem (the app's own notice uses the same window). */
  static readonly CRASH_FRESH_MS = 10 * 60_000;

  /**
   * statvfs on the state dir: true when there is room. Under DISK_LOW_BYTES the typed
   * problem `disk.low` names the figure and reveals the shots folder (the one thing that
   * grows: 129 MB of shots against 638 KB of ledger on this Mac); `captureMark` and the
   * preflight before a session read `diskLow`. Space coming back clears the row (tick).
   */
  private checkDisk(): boolean {
    this.diskCheckedAt = this.now();
    let free: number;
    try {
      const s = (this.opts.statfs ?? statfsSync)(this.config.stateDir);
      free = Number(s.bavail) * Number(s.bsize);
    } catch (e) {
      // A volume that will not answer is not a low disk; the next shot's own write reports its error.
      log.debug(`statfs ${this.config.stateDir}: ${(e as Error).message}`);
      return true;
    }
    if (!Number.isFinite(free) || free < 0) return true;
    const low = free < Engine.DISK_LOW_BYTES;
    const mb = Math.round(free / 1_048_576);
    if (low) {
      if (!this.diskLow) log.warn(`disk low: ${mb} MB free on ${this.config.stateDir} (floor ${Math.round(Engine.DISK_LOW_BYTES / 1_048_576)} MB); screenshots are skipped until space returns`);
      this.replaceProblem("disk.low", `Disk low: ${mb} MB free on ${this.config.stateDir}; screenshots are not being saved`, { label: "Reveal shots", open: join(this.config.stateDir, "shots") });
    } else {
      if (this.diskLow) log.info(`disk ok again: ${mb} MB free on ${this.config.stateDir}`);
      this.clearProblems("disk.low");
    }
    this.diskLow = low;
    return !low;
  }

  /** The voice is reconnecting on its own (expired / connection_lost): one row that counts the seconds until it is back. */
  private noteVoiceReconnect(label: string): void {
    this.voiceReconnectSince = this.now();
    this.voiceReconnectLabel = label;
    this.replaceProblem("voice.connection", `${label} · reconnecting`, Engine.GO_REMEDY);
  }

  /**
   * Nobody is reconnecting any more — the session is back, Kevin stopped or paused, or the
   * reconnect's own start failed: the counting row leaves and tick() stops rewriting it. A
   * failed start's line (with Retry → go) is a different text of the same kind and stays.
   */
  private endVoiceReconnect(): void {
    if (!this.voiceReconnectSince) return;
    this.voiceReconnectSince = 0;
    const label = this.voiceReconnectLabel;
    this.clearProblems("voice.connection", (t) => t.startsWith(label));
  }

  /** The problem rows' own clock, from tick(): limits expire, the reconnect row counts, a low disk is re-measured. */
  private problemsTick(now: number): void {
    for (const text of this.problems) {
      const meta = this.problemMeta.get(text);
      if (meta?.kind === "voice.limit" && now - meta.since >= Engine.VOICE_LIMIT_CLEAR_MS) this.clearProblemText(text);
    }
    if (this.voiceReconnectSince) {
      if (!this.wantAwake || this.pauseInfo || (this.live && !this.connecting) || this.phase === "error") {
        // Back, stopped, paused, or the reconnect failed: whichever it was, nobody is reconnecting any more.
        this.endVoiceReconnect();
      } else {
        const seconds = Math.max(1, Math.round((now - this.voiceReconnectSince) / 1000));
        this.replaceProblem("voice.connection", `${this.voiceReconnectLabel} · reconnecting for ${seconds} s`, Engine.GO_REMEDY);
      }
    }
    if (this.diskLow && now - this.diskCheckedAt >= Engine.DISK_RECHECK_MS) this.checkDisk();
    if (this.dockRecheckAt && now >= this.dockRecheckAt) {
      this.dockRecheckAt = 0;
      this.checkDock("after the fix");
    }
  }

  /**
   * The newest crash report under <stateDir>/crashes (CrashGuard writes them; the app
   * relaunches on them), when it is younger than CRASH_FRESH_MS: one `crash` row with
   * its `reason:` line and the file to open. A report that says `survived:` was an
   * exception the process outlived — a note, not a crash. File times are wall clock.
   */
  private noteCrashReports(): void {
    const dir = join(this.config.stateDir, "crashes");
    let newest: { path: string; mtimeMs: number } | undefined;
    try {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".txt")) continue;
        const path = join(dir, name);
        const st = statSync(path);
        if (!newest || st.mtimeMs > newest.mtimeMs) newest = { path, mtimeMs: st.mtimeMs };
      }
    } catch {
      return; // no folder yet: no crashes
    }
    const age = Date.now() - (newest?.mtimeMs ?? 0);
    if (!newest || age > Engine.CRASH_FRESH_MS || age < -60_000) return;
    let reason = "unknown";
    try {
      const head = readFileSync(newest.path, "utf8").slice(0, 16_384);
      if (/\nsurvived:/.test(head)) return;
      const m = head.match(/^reason: (.+)$/m);
      if (m?.[1]) reason = m[1].trim();
    } catch {
      // unreadable: the row still points at it
    }
    const minutes = Math.round(age / 60_000);
    this.problemOf("crash", `Jarhead crashed ${minutes < 1 ? "just now" : `${minutes} min ago`} · ${reason.slice(0, 140)}`, { label: "Details", open: newest.path });
  }

  /**
   * At start: what the previous engine process left in the ledger, by its most recent
   * session. A pressed `stop` inside it means Kevin ended it — nothing to pick up. A
   * `pause` row means he paused it: the pause is held again (`pauseInfo` from the row,
   * phase `paused`, the meter still stopped) unless its decay has passed, in which case
   * it sleeps as it would have. No `session.closed` row (or one the engine would have
   * reconnected from: `expired`, `connection_lost`) and a last row inside
   * LOST_SESSION_MAX_AGE_MS means the process died mid-conversation: `lostSession` is set,
   * and the first Go within AUTO_RESUME_WINDOW_MS resumes it (`resumeFromLedger`).
   */
  private restoreFromLedger(): void {
    let latest;
    try {
      latest = this.ledger.sessions()[0];
    } catch (e) {
      log.debug(`ledger walk at start failed: ${(e as Error).message}`);
      return;
    }
    if (!latest) return;
    // A conversation Kevin moved to the trash or archived is his decision about it; it is not picked up again.
    if (latest.state === "trashed" || latest.state === "archived") {
      log.debug(`last session ${latest.id} is ${latest.state}; nothing to resume`);
      return;
    }
    const now = this.now();
    const rows = this.ledger.readSession(latest.id);
    const startedAt = rows.findIndex((r) => r.type === "session.started" && r.sessionId === latest.id);
    const inside = startedAt >= 0 ? rows.slice(startedAt) : rows;
    if (inside.some((r) => r.type === "stop" && r.how === "pressed")) {
      log.debug(`last session ${latest.id} was stopped by Kevin; nothing to resume`);
      return;
    }
    const lastAt = inside.reduce((m, r) => Math.max(m, r.at), latest.startedAt);
    const pauseRow = [...inside].reverse().find((r): r is Extract<LedgerRow, { type: "pause" }> => r.type === "pause");
    if (pauseRow) {
      const sleepsAt = pauseRow.at + Math.max(Engine.PAUSE_MIN_MS, this.settings.idleSleepMinutes * 60_000);
      if (now >= sleepsAt) {
        log.info(`last session ${latest.id} was paused ${Math.round((now - pauseRow.at) / 60_000)} min ago and would have slept by now; asleep`);
        return;
      }
      this.pauseInfo = { at: pauseRow.at, sessionId: latest.id, usageSeconds: typeof pauseRow.usageSeconds === "number" ? pauseRow.usageSeconds : latest.usageSeconds, sleepsAt };
      // A Now Kevin cleared in that session stays cleared across the restart (and `now.restore` still has a mark to lift).
      this.nowClearedAt = this.ledger.nowClearedAt(latest.id);
      this.setPhase("paused");
      log.info(`last session ${latest.id} was paused ${Math.round((now - pauseRow.at) / 1000)} s ago and the engine restarted since: holding the pause again (sleeps in ${Math.round((sleepsAt - now) / 1000)} s unless Go)`);
      return;
    }
    const closed = inside.find((r): r is Extract<LedgerRow, { type: "session.closed" }> => r.type === "session.closed" && r.sessionId === latest.id);
    if (closed && closed.reason !== "expired" && closed.reason !== "connection_lost") return; // ended on purpose: sleep, idle, the server
    // Kevin's Stop inside the reconnect window after connection_lost is written after the
    // session's closed row — outside its span — so the day's own rows are asked.
    if (closed && this.stoppedAfter(closed.at, now)) {
      log.debug(`last session ${latest.id} lost its connection and Kevin pressed stop before it reconnected; nothing to resume`);
      return;
    }
    if (now - lastAt > Engine.LOST_SESSION_MAX_AGE_MS) {
      log.debug(`last session ${latest.id} was left open ${Math.round((now - lastAt) / 60_000)} min ago; too old to resume`);
      return;
    }
    // The loop guard: a session that was itself resumed from a cut one and died young is a
    // daemon dying after every resume, not a conversation to pick up a third time.
    const startedRow = startedAt >= 0 ? (rows[startedAt] as Extract<LedgerRow, { type: "session.started" }>) : undefined;
    const span = lastAt - latest.startedAt;
    if (startedRow?.resumedFrom && span < Engine.RESUME_LOOP_SPAN_MS && !this.ledger.readSession(startedRow.resumedFrom).some((r) => r.type === "pause")) {
      log.warn(`last session ${latest.id} was itself resumed from ${startedRow.resumedFrom} and lived ${Math.round(span / 1000)} s before the engine ended again: a resume loop, not a conversation; not resumed (a Go opens a fresh session)`);
      return;
    }
    this.lostSession = { sessionId: latest.id, at: lastAt, usageSeconds: latest.usageSeconds };
    this.nowClearedAt = this.ledger.nowClearedAt(latest.id);
    log.info(`last session ${latest.id} was open when the previous engine ended (${Math.round((now - lastAt) / 1000)} s ago); a Go within ${Engine.AUTO_RESUME_WINDOW_MS / 1000} s resumes it from the ledger`);
  }

  /**
   * A pressed `stop` row at or after `at` in the day files that could hold it (the day of
   * `at`, and today when that is another day): Kevin's word after a session's closed row,
   * which `readSession` places outside the session.
   */
  private stoppedAfter(at: number, now: number): boolean {
    const days = Ledger.dayFor(at) === Ledger.dayFor(now) ? [at] : [at, now];
    for (const day of days) {
      let rows: LedgerRow[];
      try {
        rows = this.ledger.read(day);
      } catch {
        continue;
      }
      if (rows.some((r) => r.type === "stop" && r.how === "pressed" && r.at >= at)) return true;
    }
    return false;
  }

  /**
   * The resume a connect gets when there is no pause to resume but the previous process
   * was cut mid-conversation: once per process, inside the window, never after a Stop.
   * The `resume` row and `resumedFrom` on the started row chain the sessions into one
   * conversation, as a pause's resume does.
   */
  private resumeFromLedger(reason: string): { readonly pause: PauseInfo; readonly continuity: string } | undefined {
    const lost = this.lostSession;
    if (!lost || this.ledgerResumeUsed) return undefined;
    // Trashed or archived since this process started (a command here, a row from elsewhere): Kevin's decision about it stands.
    const state = this.ledger.conversation(lost.sessionId)?.state;
    if (state === "trashed" || state === "archived") {
      log.info(`${reason}: the session the previous engine left open (${lost.sessionId}) is ${state}; not resumed`);
      this.lostSession = undefined;
      return undefined;
    }
    if (this.now() - this.startedAt > Engine.AUTO_RESUME_WINDOW_MS) {
      log.info(`${reason}: the session the previous engine left open (${lost.sessionId}) is not resumed — the ${Engine.AUTO_RESUME_WINDOW_MS / 1000} s window has passed`);
      this.lostSession = undefined;
      return undefined;
    }
    this.ledgerResumeUsed = true;
    this.lostSession = undefined;
    const pause: PauseInfo = { at: lost.at, sessionId: lost.sessionId, usageSeconds: lost.usageSeconds, sleepsAt: lost.at };
    log.info(`${reason}: resuming session ${lost.sessionId}, cut ${Math.round((this.now() - lost.at) / 1000)} s ago by the previous engine's end, from the ledger`);
    return { pause, continuity: this.continuityFor(pause, "restarted") };
  }

  /**
   * The resume a connect gets for a conversation the server cut (`heldReconnect`): the
   * "reconnected" continuity, built now so the gap it names is the real one. Taken by
   * the reconnect timer's connect or by Kevin's Go inside the window; a connect that then
   * fails holds it again (connect's catch). Decayed, trashed or archived → nothing.
   */
  private takeHeldReconnect(reason: string): { readonly pause: PauseInfo; readonly continuity: string; readonly how: "reconnected" } | undefined {
    const held = this.heldReconnect;
    if (!held) return undefined;
    this.heldReconnect = undefined;
    const state = this.ledger.conversation(held.sessionId)?.state;
    if (state === "trashed" || state === "archived") {
      log.info(`${reason}: the conversation the server cut (${held.sessionId}) is ${state}; not carried on`);
      return undefined;
    }
    if (this.now() >= held.sleepsAt) {
      log.info(`${reason}: the conversation the server cut (${held.sessionId}) was held past its decay; a fresh one`);
      return undefined;
    }
    return { pause: held, continuity: this.continuityFor(held, "reconnected"), how: "reconnected" };
  }

  /** The held conversation is let go (Stop, a new conversation, sleep, the decay), the pending reconnect with it. */
  private dropHeldReconnect(): void {
    this.heldReconnect = undefined;
    this.cancelReconnectTimer();
  }

  private cancelReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  /**
   * Nothing is up, opening, held or about to reopen: the one moment memory may read closed
   * conversations (the tick and `memory.run` agree on it). A pause holds the conversation
   * and so does a reconnect the server forced — the 500 ms window included — so no
   * extraction ever runs against a conversation that is about to continue.
   */
  private get quiet(): boolean {
    return !this.live && !this.connecting && !this.pauseInfo && !this.heldReconnect;
  }

  /**
   * What a session said, from its ledger rows: the heard / said items in order (the
   * continuity's lines when this process never heard them) and the last finished task
   * with a summary. Bounded to the rows of that one session.
   */
  private recallFromLedger(sessionId: string): { items: TranscriptItem[]; task?: string } {
    const items: TranscriptItem[] = [];
    let task: string | undefined;
    const requests = new Map<string, string>();
    for (const row of this.ledger.readSession(sessionId)) {
      if ((row.type === "heard" || row.type === "said") && row.item?.text) items.push(row.item);
      else if (row.type === "delegation.created") requests.set(row.delegation.id, row.delegation.request);
      else if (row.type === "delegation.finished" && row.summary) {
        const request = requests.get(row.delegationId);
        task = `Last task: "${(request ?? "").replace(/\s+/g, " ").trim().slice(0, 160)}" — ${row.status}: ${row.summary}`;
      }
    }
    return { items, ...(task ? { task } : {}) };
  }

  toast(text: string, tone: "info" | "warn" | "error" = "info"): void {
    this.emit("event", { type: "toast", text, tone });
  }

  private scheduleSnapshot(): void {
    if (this.snapshotTimer) return;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = undefined;
      this.emit("event", { type: "snapshot", snapshot: this.snapshot() });
    }, 50);
  }

  snapshot(): Snapshot {
    const live = this.live;
    return {
      phase: this.phase,
      ...(live?.session
        ? {
            session: {
              id: live.session.id,
              ...(this.sessionVoice !== undefined ? { voice: this.sessionVoice } : {}),
              ...(this.sessionAccent !== undefined ? { accent: this.sessionAccent } : {}),
              startedAt: this.sessionStartedAt,
              expiresAt: live.session.expires_at * 1000,
              usageSeconds: this.usageSeconds,
              ...(this.contextRatio !== undefined ? { contextRatio: this.contextRatio } : {}),
            },
          }
        : {}),
      // Present exactly while paused; the meter counts today's closed sessions plus the open one.
      ...(this.pauseInfo ? { pause: this.pauseInfo } : {}),
      usageToday: this.usageToday(),
      // A cleared Now stream (K1) hides items at or before the mark HERE only: the ledger, Live's context and every gate still see them.
      transcript: this.snapshotTranscript(),
      // Delegations survive a pause and resume (and a sleep): the Console keeps the day's work, newest last.
      delegations: this.snapshotDelegations(),
      agents: this.agentsList,
      connectors: this.connectorHealth,
      settings: this.settings,
      permissions: this.permissions,
      problems: this.typedProblems(),
      brainReady: this.brainReady,
      setup: this.setupNow(),
      marks: this.marks,
      handsReady: this.hands.ready || this.hands.available,
      // The Trash line and the hidden agents (K1); both are read when they change, not here.
      trash: this.trashInfo,
      hiddenAgents: this.hiddenAgents,
      // What Jarhead remembers: counts, mode, the last run, what the last turn used — never a vector.
      memory: this.memory.summary(),
      // Every live thread (main first) and those finished within THREAD_LINGER_MS, ≤ THREADS_MAX summaries.
      threads: this.threads.threads(),
      // Automations (design11): the contract's field; the Automations table projects the rows, the ring and the next fire here.
      automations: [],
    };
  }

  /** The snapshot's utterances: the last SNAPSHOT_UTTERANCES the Now stream has not cleared. */
  private snapshotTranscript(): readonly TranscriptItem[] {
    return this.nowVisible(this.wholeTranscript(), (i) => i.at).slice(-Engine.SNAPSHOT_UTTERANCES);
  }

  /** The snapshot's main-thread delegations: the last MAX_DELEGATIONS, every step of each. */
  private snapshotDelegations(): readonly Delegation[] {
    const all = this.nowVisible([...this.pastDelegations(), ...(this.delegator?.all() ?? [])], (d) => d.createdAt);
    return all.slice(-Engine.MAX_DELEGATIONS);
  }

  /**
   * The delegator's memory hook: the brain's block for a task (≤ BRAIN_MEMORY_TOKENS),
   * raced at 250 ms in the bridge. Spread into `new Delegator({...})` so the engine
   * typechecks before B4 adds `DelegatorOptions.memory` (an unknown key in a spread
   * is not an excess property); the delegator takes it up once the option exists.
   */
  private memoryForDelegator(): { readonly memory: (query: string, signal: AbortSignal) => Promise<string | undefined> } {
    return { memory: (query, signal) => this.memory.brainBlock(query, signal) };
  }

  private lastDelegations: readonly Delegation[] = [];

  private pastDelegations(): readonly Delegation[] {
    return this.lastDelegations;
  }

  // ------------------------------------------------ conversation cleanup (K1)
  //
  // Commands only — none of this is a brain tool. Tombstone rows go to TODAY's ledger
  // file and the bytes of a conversation stay where they were written; bytes move only
  // as whole day files through `Trash` (rename, never unlink); the Now stream's clear
  // is a filter at snapshot output, so Live's context and every naming gate still see
  // everything. Nothing here is on the voice path or the reflex path.

  /** How much of Kevin's own name for a conversation is kept. */
  static readonly NAME_CHARS = 120;

  /**
   * The sessions in progress, whose chains' days the Trash must keep and whose chains a
   * trash or archive ends: the open one, the paused one, and the one a crashed process
   * left for the next Go (`lostSession`, until the window passes or it is consumed).
   */
  private openSessionIds(): string[] {
    const ids: string[] = [];
    const open = this.live?.session?.id;
    if (open) ids.push(open);
    if (this.pauseInfo) ids.push(this.pauseInfo.sessionId);
    if (this.lostSession) ids.push(this.lostSession.sessionId);
    if (this.heldReconnect) ids.push(this.heldReconnect.sessionId);
    return ids;
  }

  /** The chain roots of `openSessionIds()`. */
  private openRoots(): Set<string> {
    const roots = new Set<string>();
    for (const id of this.openSessionIds()) roots.add(this.ledger.chainRootOf(id) ?? id);
    return roots;
  }

  /** Items of the Now stream still shown after a clear: those after the mark. */
  private nowVisible<T>(items: readonly T[], at: (item: T) => number): readonly T[] {
    const cleared = this.nowClearedAt;
    return cleared === undefined ? items : items.filter((i) => at(i) > cleared);
  }

  /** The Trash line is refreshed on change, never per snapshot. */
  private refreshTrash(): void {
    try {
      this.trashInfo = this.trash.info();
    } catch (e) {
      log.warn(`trash: could not read ${this.trash.dir}: ${(e as Error).message}`);
    }
    this.scheduleSnapshot();
  }

  /**
   * One tombstone for the chain `chainId` names — any session of it resolves to the
   * root, and the root is what the row carries. An id the ledger never saw start (a day
   * file already in the Trash, a stale rail) is a word, not a row.
   *
   * Trashing or archiving the conversation Kevin is IN — the open session's chain, the
   * paused one's, or the one a crashed process left for the next Go — ends it the way
   * `conversation.new` does: the session closes (the meter stops), the pause or the
   * pending resume is let go, Now empties, and the next Go opens a chain of its own.
   * Without this the live session would sit stamped `trashed` under a rail that hides
   * it, and the next Go would resume straight into the trashed chain.
   */
  private async markConversation(chainId: string, row: (at: number, root: string) => LedgerRow): Promise<void> {
    const root = this.ledger.chainRootOf(String(chainId));
    if (root === undefined) {
      this.toast("no such conversation", "warn");
      return;
    }
    const r = row(this.now(), root);
    this.ledger.append(r);
    const puts = r.type === "conversation.trashed" || r.type === "conversation.archived";
    if (puts && this.openRoots().has(root)) {
      log.info(`${r.type} names the conversation in progress (${root}); ending it as a new conversation would`);
      await this.newConversation();
      return;
    }
    this.scheduleSnapshot();
  }

  /**
   * New conversation: the transport's stop (the open session closes so the meter stops;
   * a pause is let go), then the Now stream starts empty — the ledger and the rail keep
   * what was said. With no pause left to resume, the next Go opens a chain of its own:
   * its started row carries no `resumedFrom`.
   */
  private async newConversation(): Promise<void> {
    const closing = this.live || this.connecting || this.pauseInfo ? this.pressStop("new conversation") : undefined;
    // The session a crashed process left for the next Go is let go too. pressStop does this when it
    // runs; asleep inside the auto-resume window nothing else would, and the next Go would resume it.
    // Likewise the conversation a failed reconnect held.
    this.lostSession = undefined;
    this.ledgerResumeUsed = true;
    this.dropHeldReconnect();
    this.confirmations.endConversation();
    // pressStop detached the session synchronously (its words moved to the held record); the record is dropped now.
    this.heldTranscript = [];
    this.lastDelegations = [];
    this.nowClearedAt = undefined;
    this.scheduleSnapshot();
    if (closing) await closing;
  }

  /** The session a `now.*` row names: the open one, the paused one, else the last the ledger knows. */
  private nowSessionId(): string | undefined {
    return this.live?.session?.id ?? this.pauseInfo?.sessionId ?? this.ledger.sessions()[0]?.id;
  }

  /** Clear the Now stream: items at or before now leave the snapshot; the ledger keeps them, and so does Live. */
  private clearNow(): void {
    const at = this.now();
    this.nowClearedAt = at;
    const sessionId = this.nowSessionId();
    if (sessionId) this.ledger.append({ at, type: "now.cleared", sessionId });
    this.scheduleSnapshot();
  }

  private restoreNow(): void {
    if (this.nowClearedAt === undefined) return;
    this.nowClearedAt = undefined;
    const sessionId = this.nowSessionId();
    if (sessionId) this.ledger.append({ at: this.now(), type: "now.restored", sessionId });
    this.scheduleSnapshot();
  }

  /** Move a day's ledger file, its shots, or both to the Trash; the toast says what moved and why anything stayed. */
  private trashDay(day: string, what: "ledger" | "shots" | "both"): void {
    const whats: ("ledger" | "shots")[] = what === "both" ? ["ledger", "shots"] : [what];
    const moved: string[] = [];
    const kept: { what: string; reason: string }[] = [];
    for (const w of whats) {
      const r = this.trash.moveDay(day, w, "kevin");
      if (r.ok) moved.push(r.move.what);
      else kept.push({ what: r.what, reason: r.reason });
    }
    // "both" on a day with no shots is not a refusal worth a line once the ledger moved.
    const worth = kept.filter((k) => !(what === "both" && moved.length > 0 && /^no /.test(k.reason)));
    const parts = [moved.length ? `${day} ${moved.join(" and ")} moved to the Trash` : "", ...worth.map((k) => `${k.what} kept · ${k.reason}`)].filter(Boolean);
    this.toast(parts.join(" · "), moved.length ? "info" : "warn");
    if (moved.length) this.refreshTrash();
  }

  private restoreDay(day: string): void {
    const r = this.trash.restoreDay(day);
    const parts = [r.restored.length ? `${day} ${r.restored.map((m) => m.what).join(" and ")} restored` : "", ...r.refused.map((x) => `${x.what} · ${x.reason}`)].filter(Boolean);
    this.toast(parts.join(" · "), r.restored.length ? "info" : "warn");
    if (r.restored.length) this.refreshTrash();
  }

  /**
   * The retention sweep (`Settings.ledgerRetentionDays` / `shotsRetentionDays`, 0 =
   * never): at startup, at the day rollover `loadUsageToday` notices, and on the
   * `ledger.sweep` command. The Trash logs what it would move before it moves anything.
   */
  private runSweep(why: "startup" | "rollover" | "command"): SweepResult | undefined {
    let result: SweepResult | undefined;
    const { ledgerRetentionDays, shotsRetentionDays } = this.settings;
    if (!(ledgerRetentionDays > 0) && !(shotsRetentionDays > 0)) {
      if (why === "command") this.toast("retention is off · nothing to sweep", "info");
    } else {
      try {
        const r = this.trash.sweep({ ledgerRetentionDays, shotsRetentionDays }, this.now());
        log.info(`sweep (${why}): ${r.moved.length} moved, ${r.refused.length} kept, ${r.failed.length} failed`);
        if (why === "command") this.toast(r.moved.length ? `${r.moved.length} ${r.moved.length === 1 ? "day" : "days"} moved to the Trash` : r.refused.length ? `nothing moved · ${r.refused.length} kept` : "nothing to move", "info");
        result = r;
      } catch (e) {
        this.problem(`sweep failed: ${(e as Error).message}`);
      }
    }
    // Re-read whether or not anything moved: Finder may have emptied the Trash since (Trash.info() is memoised on the folders' mtimes, so an unchanged one costs a few stats).
    this.refreshTrash();
    return result;
  }

  /**
   * The rollover's sweep, once nothing is up: a sweep walks and may copy whole folders
   * (the cross-device fallback), and `tick()` is the loop the mic audio rides while a
   * session is live. Paused counts as quiet — the transport is closed while paused.
   */
  private runPendingSweep(): void {
    if (this.live || this.connecting) return;
    this.sweepPending = false;
    this.runSweep("rollover");
  }

  /** Hide an agent from the rail (or show it again): a row, and the snapshot's list. Never a file operation on another tool's store. */
  private hideAgent(agentId: string, hidden: boolean): void {
    this.ledger.append({ at: this.now(), type: "agent.hidden", agentId, hidden });
    const set = new Set(this.hiddenAgents);
    if (hidden) set.add(agentId);
    else set.delete(agentId);
    this.hiddenAgents = [...set].sort();
    this.scheduleSnapshot();
  }

  get brainInfo(): { kind: string; ready: boolean; detail: string } {
    return { kind: this.brain?.kind ?? "none", ready: this.brainReady, detail: this.brain?.detail ?? this.brainDetail };
  }
}

/** The hostname of a server root, "" when the URL does not parse. */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return "";
  }
}

function normalizeForLog(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 80);
}

/**
 * The runners' `ActingSerializerLike.run<T>` over observe.ts's `ActingSerializer.run` (typed to RunOutcome): the
 * runner only ever hands it a tool call, so the two are one thing — this is the seam between the threads'
 * runner interface and the speed pass's class, kept here rather than in either builder's file.
 */
function serializerLike(s: ActingSerializer): { run<T>(name: string, fn: () => Promise<T>): Promise<T> } {
  return { run: <T>(name: string, fn: () => Promise<T>): Promise<T> => s.run(name, fn as unknown as () => Promise<RunOutcome>) as unknown as Promise<T> };
}

/** A stroke drawn right-to-left gives a negative size; the capture needs a positive box at least a point wide. */
function normalizeRect(r: Rect): Rect {
  return { x: Math.min(r.x, r.x + r.w), y: Math.min(r.y, r.y + r.h), w: Math.max(1, Math.abs(r.w)), h: Math.max(1, Math.abs(r.h)) };
}

/** Where a stroke's mass is: the mean of its points. */
function centroidOf(path: readonly Point[]): Point {
  let x = 0;
  let y = 0;
  for (const p of path) {
    x += p.x;
    y += p.y;
  }
  return { x: x / path.length, y: y / path.length };
}

function contains(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

/** The share of `inner`'s area that lies inside `outer`. */
function coverage(inner: Rect, outer: Rect): number {
  const area = inner.w * inner.h;
  if (area <= 0) return 0;
  const x0 = Math.max(inner.x, outer.x);
  const y0 = Math.max(inner.y, outer.y);
  const x1 = Math.min(inner.x + inner.w, outer.x + outer.w);
  const y1 = Math.min(inner.y + inner.h, outer.y + outer.h);
  if (x1 <= x0 || y1 <= y0) return 0;
  return ((x1 - x0) * (y1 - y0)) / area;
}

/** A rounded frame for the blob to drag around what Kevin circled: four straight runs and four quarter arcs, clockwise from the top-left. */
/** Roles whose title names a control Kevin might say ("click Add Folder"); anything pressable counts too. */
const EAR_HINT_ROLES = new Set([
  "AXButton", "AXPopUpButton", "AXMenuButton", "AXMenuItem", "AXMenuBarItem", "AXCheckBox", "AXRadioButton", "AXLink", "AXTab",
  "AXDisclosureTriangle", "AXComboBox", "AXTextField", "AXSearchField", "AXCell", "AXRow", "AXTabGroup", "AXToolbar", "AXSlider", "AXIncrementor",
]);

/**
 * One hint as the recogniser wants it: whitespace collapsed, ellipses and edge punctuation
 * dropped, at most three words (a longer title keeps its first three: the words a spoken
 * "click …" starts with), 2–40 characters with a letter in them. Mirrors the app's
 * `EarHints.clean` (Ear/EarListener.swift), which cleans again on its side.
 */
export function cleanEarHint(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const words = raw.replace(/…|\.\.\./g, " ").split(/\s+/).filter(Boolean).slice(0, 3);
  const s = words.join(" ").replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, "");
  if (s.length < 2 || s.length > 40 || !/\p{L}/u.test(s)) return undefined;
  return s;
}

/**
 * The `ear.hints` set for a front window: the app first (the ear treats a change of it as
 * a new screen), its window title, then the visible controls' titles in the tree's
 * breadth-first order (the toolbar and the top-level controls before a long page's
 * links; at most `caps.controls`), then the agents' names — deduplicated
 * case-insensitively, at most `caps.total` strings.
 */
export function earHintsFrom(nodes: readonly AxNodeInfo[], app: string, window: string, agents: readonly string[], caps = { controls: 80, total: 100 }): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string | undefined): boolean => {
    const s = cleanEarHint(raw);
    if (!s) return false;
    const k = s.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    out.push(s);
    return true;
  };
  add(app);
  add(window);
  let controls = 0;
  for (const n of nodes) {
    if (controls >= caps.controls || out.length >= caps.total) break;
    if (!(EAR_HINT_ROLES.has(n.role) || n.pressable === true)) continue;
    if (add(n.title || n.description || (n as { placeholder?: string }).placeholder)) controls++;
  }
  for (const a of agents) {
    if (out.length >= caps.total) break;
    add(a);
  }
  return out;
}

export function roundedRectPoints(r: Rect, radius = Math.min(12, r.w / 4, r.h / 4), arcSteps = 4): Point[] {
  const rad = Math.max(0, radius);
  const out: Point[] = [];
  const arc = (cx: number, cy: number, from: number): void => {
    for (let i = 0; i <= arcSteps; i++) {
      const a = from + (i / arcSteps) * (Math.PI / 2);
      out.push({ x: cx + Math.cos(a) * rad, y: cy + Math.sin(a) * rad });
    }
  };
  // top-left corner → along the top → top-right → right side → bottom-right → bottom → bottom-left → left side (closed by the layer)
  arc(r.x + rad, r.y + rad, Math.PI);
  arc(r.x + r.w - rad, r.y + rad, -Math.PI / 2);
  arc(r.x + r.w - rad, r.y + r.h - rad, 0);
  arc(r.x + rad, r.y + r.h - rad, Math.PI / 2);
  return out;
}

/** The echo for a mark that arrived without a stroke: its outline. */
function rectCorners(r: Rect): Point[] {
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
    { x: r.x, y: r.y },
  ];
}

function rms(pcm: Buffer): number {
  const n = pcm.length >> 1;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2) / 32768;
    sum += s * s;
  }
  return Math.min(1, Math.sqrt(sum / n) * 3);
}
