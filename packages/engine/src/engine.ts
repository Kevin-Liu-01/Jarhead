import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HANDS_OFF_APPS, classifyAction, writeEnvSecrets, secretsPresent, Ledger, Trash, logger, newId, readConfig, type JarheadConfig, type SweepResult } from "@jarhead/core";
import { LiveSession, Transcript, buildLiveInstructions, classifyLiveError, type SessionConfig } from "@jarhead/live";
import { ComputerToolset, ConfirmationDesk, ConfirmationState, DEFAULT_SHOT_BUDGET, FocusLease, HELPER_PERMISSION_KINDS, HandsPool, QUICK_SHOT_BUDGET, YES_PATTERN, fakeHandsSpawn, type ActionEvent, type AxNodeInfo, type AxTreeResult, type ElementInfo, type FocusedText, type FrontmostInfo, type HelloPermissions, type HelperPermissionKind, type NativeHands, type NativeHandsProcess, type ScreenshotResult, type ToolsetOptions, type WindowInfo } from "@jarhead/hands";
import { AgentRegistry, DEFAULT_PAGE, defaultConnectors, type AgentConnector, type TranscriptPage } from "@jarhead/agents";
import { BROWSER_APPS, ClaudeBrain, Delegator, FiredReflexes, RECONCILE_THRESHOLD, ReflexRunner, ResponsesBrain, normalizeUtterance, responsesDelegationConfig, screenNote, similarity, type Brain, type BrainAttachment, type BrainSink, type BrainTask, type Reconciliation, type Reflex, type ReflexOutcome, type RunnerOptions, type ToolRunner } from "@jarhead/brain";
import { EarReflexes, type ReflexLedgerRow } from "./ear.ts";
import { WorkerAwareRunner, WorkerPool, type WorkerBrainFactory, type WorkerParent, type WorkerVoice } from "./workers.ts";
import {
  DEFAULT_SETTINGS,
  DEFAULT_WAKE,
  type AgentInfo,
  type AudioLevels,
  type ConnectorHealth,
  type Delegation,
  type EngineCommand,
  type EngineEvent,
  type LedgerRow,
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
  /** Builds a worker's brain over its lane runner (tests inject a scripted fake); absent, the engine builds one for the running brain kind. */
  readonly makeWorkerBrain?: WorkerBrainFactory;
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
  /** Two helper processes, one binary, one parent: `focus` acts, `background` reads and serves background workers. */
  readonly pool: HandsPool;
  /** The acting helper (`pool.focus`), under the name every caller knows. */
  readonly hands: NativeHandsProcess;
  /** One holder of the pointer, keyboard and frontmost app: Jarhead's own hands with priority, workers in turn. */
  readonly lease: FocusLease;
  readonly toolset: ComputerToolset;
  readonly agents: AgentRegistry;
  /** The main lane's runner: `worker_*` answered from the pool, screen tools under the lease. */
  readonly runner: WorkerAwareRunner;
  /** The workers: a second pair of hands inside one delegation. */
  readonly workers: WorkerPool;
  /** Builds a worker's brain for the running brain kind; undefined while it cannot run a second thread (Responses, a test brain without a seam). */
  private workerBrainFactory: WorkerBrainFactory | undefined;
  /** The sleep in flight: the ear, Live and the dock saying so at once are one sleep. */
  private sleeping: Promise<void> | undefined;
  /** Ends the farewell wait early when a harder cause (Stop, the dock) lands mid-farewell. */
  private farewellEnd: (() => void) | undefined;

  private brain: Brain | undefined;
  private brainReady = false;
  private brainDetail = "not started";
  private setupProbe: { openaiKey: SetupStatus["openaiKey"]; brain: SetupStatus["brain"] } = { openaiKey: "unchecked", brain: "unchecked" };
  /** Regions Kevin circled for Jarhead; the delegator hands the unconsumed ones to the brain. */
  protected marks: ScreenMark[] = [];
  /** Captures still in flight, by mark id; the delegator waits for them before taking the marks. */
  private readonly markCaptures = new Map<string, Promise<void>>();
  /** When each consumed mark was handed over (the contract has no field for it); it ages out from here, not from when it was drawn. */
  private readonly markConsumedAt = new Map<string, number>();
  /** Conversations a surface has stepped into, by agent id: how many viewers, and the live tail kept while any remain. */
  private readonly openConversations = new Map<string, { viewers: number; unwatch: (() => void) | undefined }>();
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
   * The problem lines, oldest first, capped at eight: the snapshot's `problems`, the order
   * and the cap for `typedProblems()`. `clear-problems` empties it; `problemMeta` carries
   * each line's kind, remedy and first-seen (see the "problems, typed" region).
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
  private permissions: Permissions = { microphone: "unknown", screenRecording: "unknown", accessibility: "unknown" };
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
    const toolsetBase: Omit<ToolsetOptions, "hands" | "screen" | "confirmations"> = {
      excludePids: () => [...this.excludePids, process.pid],
      annotate: (cmd) => this.emit("overlay", cmd),
      onAction: (a) => this.onAction(a),
      presenceAt: () => this.lastKevinAt || undefined,
      now: this.now,
    };
    this.toolset = new ComputerToolset({ ...toolsetBase, hands: this.hands, confirmations: this.desk.lane(WorkerAwareRunner.ACTOR, "Jarhead") });
    const connectors =
      opts.connectors ??
      defaultConnectors({
        claudeModel: this.settings.brainModel,
        claudeBin: this.config.claudeBin,
      });
    this.agents = new AgentRegistry(connectors);
    this.agents.onChange((list) => {
      this.agentsList = list;
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
    // Workers get the same runner and toolset options over their own lane (hands, Screen, desk lane).
    this.workers = new WorkerPool({
      now: this.now,
      ledger: this.ledger,
      desk: this.desk,
      lease: this.lease,
      hands: { focus: this.pool.focus, background: this.pool.background },
      runnerOptions: () => runnerBase,
      toolsetOptions: () => toolsetBase,
      makeBrain: () => this.opts.makeWorkerBrain ?? this.workerBrainFactory,
      parentFor: (task) => this.workerParentFor(task),
      voice: () => this.workerVoice(),
      enabled: () => this.settings.workers !== false,
      onChange: () => this.scheduleSnapshot(),
    });
    this.runner = new WorkerAwareRunner({ ...runnerBase, toolset: this.toolset, pool: this.workers, lease: this.lease, desk: this.desk });
    // Reflexes run through the same runner as every brain call; the click pre-check asks which app is up.
    this.reflexRunner = new ReflexRunner({ runner: this.runner, frontmostApp: () => this.frontmostAppName(), browserInFront: async () => BROWSER_APPS.test(this.frontApp || (await this.frontmostAppName())), now: this.now });
    this.firedReflexes = new FiredReflexes(this.now, Engine.RECONCILE_WINDOW_MS);
    this.earReflexes = new EarReflexes({
      now: this.now,
      enabled: () => this.reflexesOn(),
      match: (u) => this.matchReflex(u),
      run: (reflex, phrase) => this.runEarReflex(reflex, phrase),
      // A spoken "stop" interrupts: work and speech end, the session stays open and listening.
      onStop: () => {
        if (this.delegator?.active || this.workers.running() > 0 || (this.now() - this.lastOutputSpeechAt < 1200 && !this.outputGated)) void this.interrupt("ear", "said");
      },
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
      }
      this.scheduleSnapshot();
    });
    return t;
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
    try {
      if (existsSync(this.settingsPath())) {
        const saved = JSON.parse(readFileSync(this.settingsPath(), "utf8")) as Partial<Settings>;
        // Nested objects merge field-wise so a settings.json from before a field existed still validates.
        return { ...base, ...saved, wake: { ...DEFAULT_WAKE, ...(saved.wake ?? {}) } };
      }
    } catch (e) {
      log.warn(`settings unreadable: ${(e as Error).message}`);
    }
    return base;
  }

  get currentSettings(): Settings {
    return this.settings;
  }

  updateSettings(patch: SettingsPatch): void {
    const next: Record<string, unknown> = { ...this.settings };
    for (const [key, value] of Object.entries(patch)) {
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
    void this.probeHands();
    void this.agents.refresh().then((r) => {
      this.connectorHealth = r.health;
      this.agentsList = r.agents;
      this.scheduleSnapshot();
    });
    // The brain can take a while to prove its auth; nothing else should wait for it.
    this.brainStarted = this.startBrain().then(() => {
      this.setupProbe = { ...this.setupProbe, brain: this.brainReady ? "ok" : "unavailable" };
      this.scheduleSnapshot();
      // One cheap key check at start, so Setup and the Console show the truth without a click.
      void this.probeSetup();
    });
    this.scheduleSnapshot();
  }

  /** Resolves once the brain has been chosen (ready or fallen back). */
  ready(): Promise<void> {
    return this.brainStarted ?? Promise.resolve();
  }

  private async probeHands(): Promise<void> {
    if (!this.hands.available) {
      this.problemOf("hands.helper", `hands helper not built (${this.config.handsBin}); run pnpm build:hands`, Engine.HANDS_REMEDY);
      this.permissions = { ...this.permissions, screenRecording: "unknown", accessibility: "unknown" };
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

  /** The grant the engine currently holds for a kind: its own field for the three legacy ones, else the row. */
  private grantOf(kind: PermissionKind): Grant {
    if (kind === "microphone" || kind === "screenRecording" || kind === "accessibility") return this.permissions[kind];
    return this.permissions.all?.find((p) => p.kind === kind)?.grant ?? "unknown";
  }

  /**
   * Fold grants for the helper's kinds into the permission state: the legacy fields,
   * the rows of `permissions.all` (an app row keeps its label, why, ask and required;
   * only the grant and checkedAt move; a kind the app has not listed gets the
   * catalogue row), the problem lines and the toasts. Rows the app owns are not
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
    const at = this.now();
    let changed = this.permissions.all === undefined;
    let regained = false;
    const rows: PermissionInfo[] = [...(this.permissions.all ?? [])];
    const fields = { microphone: this.permissions.microphone, screenRecording: this.permissions.screenRecording, accessibility: this.permissions.accessibility };
    for (const kind of HELPER_PERMISSION_KINDS) {
      const seen = fresh[kind];
      if (seen === undefined) continue;
      const state: Grant = seen ? "granted" : "denied";
      if (source === "helper") this.helperGrants[kind] = state;
      const before = this.grantOf(kind);
      const i = rows.findIndex((r) => r.kind === kind);
      const base: Omit<PermissionInfo, "grant" | "checkedAt"> = i >= 0 ? rows[i]! : { kind, ...Engine.PERMISSION_CATALOGUE[kind] };
      const row: PermissionInfo = { ...base, grant: state, checkedAt: at };
      if (i >= 0) rows[i] = row;
      else rows.push(row);
      if (kind === "accessibility" || kind === "screenRecording") fields[kind] = state;
      if (before === state) continue;
      changed = true;
      const text = Engine.PERMISSION_PROBLEMS[kind];
      if (state === "granted") {
        // A grant that APPEARED (denied → granted) needs a fresh helper process; the first
        // read of the daemon's life (unknown → granted) does not — restarting then would
        // cut the helper's own greeting short and report a failure that never happened.
        if ((kind === "accessibility" || kind === "screenRecording") && before === "denied") regained = true;
        this.clearProblemText(text);
        if (before !== "unknown") this.toast(`${base.label} granted — ${Engine.GRANTED_NOTE[kind]}`, "info");
      } else {
        this.problemOf(Engine.permissionProblemKind(kind), text, Engine.permissionRemedy(kind));
        if (before === "granted") this.toast(`${base.label} was revoked`, "warn");
      }
    }
    this.permissions = { ...fields, all: rows };
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

  setMicrophonePermission(state: Permissions["microphone"]): void {
    this.permissions = { ...this.permissions, microphone: state };
    if (state === "denied") this.problemOf("permission.microphone", Engine.MICROPHONE_PROBLEM, Engine.permissionRemedy("microphone"));
    else if (state === "granted") this.clearProblemText(Engine.MICROPHONE_PROBLEM);
    this.scheduleSnapshot();
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
   * One permission as the app read it (any kind). The three legacy fields follow;
   * the row in `permissions.all` takes the grant (a kind not listed yet gets the
   * catalogue row, so `jarhead status` sees it before the app's first full list).
   * For the four helper kinds see `applyAppWord`: the row's grant is the engine's
   * own when it has read one; the detail and checkedAt are the app's.
   */
  setPermission(which: string, state: Grant, detail?: string): void {
    if (which === "microphone") this.setMicrophonePermission(state);
    if (!Engine.isPermissionKind(which)) {
      log.debug(`permission message for an unknown kind ${which}; ignored`);
      this.scheduleSnapshot();
      return;
    }
    const word = Engine.isHelperKind(which) ? this.applyAppWord(which, state) : { regained: false };
    const rows: PermissionInfo[] = [...(this.permissions.all ?? [])];
    const i = rows.findIndex((p) => p.kind === which);
    const base: Omit<PermissionInfo, "grant" | "checkedAt"> = i >= 0 ? rows[i]! : { kind: which, ...Engine.PERMISSION_CATALOGUE[which] };
    const grant = Engine.isHelperKind(which) ? this.grantOf(which) : state;
    const row: PermissionInfo = { ...base, grant, ...(detail !== undefined ? { detail } : {}), checkedAt: this.now() };
    if (i >= 0) rows[i] = row;
    else rows.push(row);
    this.permissions = { ...this.permissions, all: rows };
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
      const kept = this.permissions.all?.find((r) => r.kind === kind);
      if (kept) rows.push(kept);
    }
    const pick = (kind: PermissionKind): Grant | undefined => rows.find((p) => p.kind === kind)?.grant;
    const mic = pick("microphone");
    if (mic !== undefined && mic !== this.permissions.microphone) this.setMicrophonePermission(mic);
    this.permissions = {
      ...this.permissions,
      all: rows,
      screenRecording: pick("screenRecording") ?? this.permissions.screenRecording,
      accessibility: pick("accessibility") ?? this.permissions.accessibility,
    };
    this.scheduleSnapshot();
    if (regained) void this.restartHandsAfterGrant();
  }

  /** Stop the current brain (cancelling any running task) and start the configured one. */
  async restartBrain(reason: string): Promise<void> {
    if (this.brainRestart) return this.brainRestart;
    this.brainRestart = (async () => {
      log.info(`restarting brain: ${reason}`);
      await this.delegator?.cancel("brain restarting");
      // Workers run brains of the old kind: they go with it.
      await this.bounded(this.workers.stopAll());
      const old = this.brain;
      this.brain = undefined;
      this.workerBrainFactory = undefined;
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
      await this.startBrain();
      this.setupProbe = { ...this.setupProbe, brain: this.brainReady ? "ok" : "unavailable" };
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
    })().finally(() => {
      this.brainRestart = undefined;
    });
    return this.brainRestart;
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
    await this.ready();
    this.setupProbe = { openaiKey, brain: this.brainReady ? "ok" : "unavailable" };
    this.scheduleSnapshot();
    return this.setupStatus();
  }

  private setupStatus(): SetupStatus {
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
    };
  }

  private async startBrain(): Promise<void> {
    if (this.opts.brain) {
      this.brain = this.opts.brain;
      // A test brain has no second thread of its own; the `makeWorkerBrain` seam stands in.
      this.workerBrainFactory = undefined;
      const r = await this.brain.start();
      this.brainReady = r.ready;
      this.brainDetail = r.detail;
      return;
    }
    const wanted = this.settings.brain;
    // Settings.brainModel is "" for "that backend's default"; only a real id is an override.
    const model = this.settings.brainModel.trim() || undefined;
    const looksOpenAI = /^(gpt-|o\d|chatgpt)/i.test(model ?? "");
    const looksClaude = /^claude/i.test(model ?? "");
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
      }
    };

    // Every brain proves itself before it takes a task. The same builder makes a worker's
    // brain over its lane runner: a Codex worker is its own app-server process with one
    // thread, no primer (a spare's boot is a process, not a model request) and the
    // worker's id on the bridge env; the HTTP and Claude kinds are a second instance;
    // Live's own Responses delegation has no thread of its own to give.
    type Worker = { readonly runner: ToolRunner; readonly workerId: string; readonly secondsCap: number };
    const build = (kind: Kind, worker?: Worker): { brain: Brain; label: string; warning?: string } | undefined => {
      const runner = worker?.runner ?? this.runner;
      switch (kind) {
        case "codex":
          return {
            label: "Codex",
            brain: new CodexBrain({
              runner,
              probe: codexProbe,
              stateDir: this.config.stateDir,
              socketPath: this.config.socketPath,
              // Under `auto` a leftover Claude id is not an override for Codex; an explicit choice keeps what Kevin set.
              ...(model && !(wanted === "auto" && looksClaude) ? { model } : {}),
              effort: this.settings.effort,
              // A worker: its id on the bridge env (the daemon routes its tool calls to its lane), one thread, no primer, the pool's wall clock as the backstop.
              ...(worker ? { worker: worker.workerId, primeThreads: false, maxWallMs: worker.secondsCap * 1000 } : {}),
            }),
          };
        case "claude-code":
          return {
            label: "Claude Code",
            brain: new ClaudeBrain({
              runner,
              stateDir: this.config.stateDir,
              // Under `auto` a leftover OpenAI id must not sink the Claude login; an explicit choice keeps what Kevin set.
              ...(model && !(wanted === "auto" && looksOpenAI) ? { model } : {}),
              effort: this.settings.effort,
              ...(this.config.claudeBin ? { pathToClaudeCodeExecutable: this.config.claudeBin } : {}),
            }),
          };
        case "anthropic-api":
          return { label: "Anthropic API", brain: new AnthropicBrain({ runner, apiKey: this.config.anthropicApiKey, model, effort: this.settings.effort }) };
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
            brain: new OpenAICompatibleBrain({ runner, baseUrl, apiKey: key.apiKey, model }),
          };
        }
        case "openai-responses":
          if (worker) return undefined;
          // The model override only applies when Kevin chose this backend; under `auto` it may be another vendor's id.
          return { label: "OpenAI Responses", brain: new ResponsesBrain({ runner: this.runner, model: wanted === "openai-responses" ? model : undefined, effort: "low" }) };
      }
    };
    const workerFactoryFor = (kind: Kind): WorkerBrainFactory | undefined => (kind === "openai-responses" ? undefined : (w) => build(kind, w)?.brain);

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
      if (candidate.warning) this.problemOf("brain.probe", candidate.warning, Engine.PROBE_REMEDY);
      const r = await candidate.brain.start();
      if (r.ready) {
        this.brain = candidate.brain;
        this.workerBrainFactory = workerFactoryFor(kind);
        this.brainReady = true;
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
      // A configured backend that cannot start is worth a line in the Console.
      this.problemOf("brain.unavailable", `${candidate.label} brain unavailable (${r.detail}); ${order.length > 1 ? "trying the next backend" : "using the OpenAI backend instead"}`, Engine.PROBE_REMEDY);
    }
    // An explicit choice that could not start: the Live session's own Responses delegation always can.
    const responses = new ResponsesBrain({ runner: this.runner, effort: "low" });
    const r = await responses.start();
    this.brain = responses;
    this.workerBrainFactory = undefined;
    this.brainReady = r.ready;
    this.brainDetail = r.detail;
  }

  /** Called by the shell when the brain fails to authenticate mid-run. */
  private async swapToResponses(reason: string): Promise<void> {
    this.problemOf("brain.unavailable", `brain failed (${reason}); switching to the OpenAI backend for the next session`, Engine.PROBE_REMEDY);
    await this.brain?.stop();
    const responses = new ResponsesBrain({ runner: this.runner, effort: "low" });
    await responses.start();
    this.brain = responses;
    this.workerBrainFactory = undefined;
    this.brainReady = true;
    this.brainDetail = "responses delegation (fallback)";
  }

  // -------------------------------------------------------------- session

  // The transport: one state machine — asleep / connecting / awake / paused — and
  // three verbs. Go opens (or resumes), Pause closes the session and holds the
  // conversation, Stop closes the session and sleeps. GPT-Live-1 bills every second
  // a session is open (docs/REDESIGN.md §13), so every state but `awake` and
  // `connecting` has NO session; the watchdog in tick() enforces it.

  /** The one place a session's config is built; `continuity` is the "# Continuity" section a resume appends. */
  private sessionConfig(continuity?: string): SessionConfig {
    const brain = this.brain;
    const delegation =
      brain instanceof ResponsesBrain
        ? responsesDelegationConfig({ model: this.settings.brain === "openai-responses" ? this.settings.brainModel : undefined, effort: "low" })
        : ({ type: "client" } as const);
    const base = buildLiveInstructions({ alwaysOn: true });
    return {
      model: this.config.liveModel,
      instructions: continuity ? `${base}\n\n${continuity}` : base,
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

  /** Open a Live session (legacy verb). While paused it is a resume. Idempotent while one is open or opening. */
  async wake(reason = "command"): Promise<void> {
    if (this.pauseInfo) return this.resume();
    return this.connect(reason);
  }

  /**
   * Open a session. `resume` carries the pause it continues: the config gets the
   * continuity section, the started row says `resumedFrom`, and a `resume` row
   * follows. A stop or sleep that lands while the socket opens sets `wantAwake`
   * false; the session is then closed the moment it exists (it billed for the
   * handshake, nothing more) and the transport stays asleep.
   */
  private async connect(reason: string, resume?: { readonly pause: PauseInfo; readonly continuity: string }): Promise<void> {
    log.info(`wake requested (${reason})`);
    this.wantAwake = true;
    if (this.live || this.connecting) return;
    if (!this.config.openaiApiKey) {
      this.endVoiceReconnect();
      this.problemOf("voice.key", "OPENAI_API_KEY is missing; set it in ~/.jarhead/env or .env.local", Engine.SETUP_REMEDY);
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
    // arrives with its continuity already). Then the disk: a session may open with no room
    // for shots, but the row says so before the first screenshot is skipped.
    resume ??= this.resumeFromLedger(reason);
    this.checkDisk();
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
      this.ledger.append({ at, type: "session.started", sessionId: res.id, voice: this.settings.voice, ...(resume ? { resumedFrom: resume.pause.sessionId } : {}) });
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
        this.toast("resumed", "info");
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
      // The session timeline's zero on the wall clock: the triggering utterance's end becomes timings.speechEndAt.
      sessionStartedAt: () => this.sessionStartedAt,
      // Live's path for a dismissal (the voice's attention gate is the addressing test there): the one sleep function.
      onSleep: (phrase) => void this.fallAsleep("said", { phrase, farewell: true }),
      // The workers a delegation's brain split off: the parent drains before it finishes; Kevin's yes reaches the floor's lane.
      workers: {
        drain: (id, signal) => this.workers.drain(id, signal),
        running: (id) => this.workers.running(id),
        resume: (laneId) => this.workers.resume(laneId),
        floorLane: () => this.workers.floorLane(),
        inExchange: () => this.now() - this.lastAddressedAt < Engine.EXCHANGE_WINDOW_MS,
      },
    });
    delegator.on("change", () => this.scheduleSnapshot());
    delegator.on("phase", () => this.recomputePhase());
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
    });
    live.on("closed", (reason, usage) => {
      // The record and the meter, whichever session this was. A socket that never
      // reached session.started has no started row and gets no closed row.
      this.foldUsage(live, usage);
      const id = live.session?.id;
      if (id) this.ledger.append({ at: this.now(), type: "session.closed", sessionId: id, reason, usageSeconds: usage });
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
        // Re-checked when it fires: a stop or a pause in the meantime wins over the reconnect.
        setTimeout(() => {
          if (this.wantAwake && !this.pauseInfo) void this.connect(`reconnect after ${reason}`);
        }, 500).unref?.();
      } else {
        this.setPhase("asleep");
      }
    });
  }

  /** The legacy verb: the `sleep` command without a cause. */
  sleep(): Promise<void> {
    return this.fallAsleep("command");
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
   * worker, the questions, the delegation) → for a dismissal, one word from the voice
   * (FAREWELL_LINE, unless it already said "night."), waited for until its first words
   * plus FAREWELL_QUIET_MS, capped at FAREWELL_CAP_MS — the session bills meanwhile →
   * detach and close (`sleep:<cause>`) → phase asleep → toast → the worker processes
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
      // The worker processes — the spare too — and the brain's own cancel; neither holds anything up.
      await this.bounded(Promise.all([this.workers.stopAll(), cancel]));
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

  /** Text Kevin typed in the Console. Typing while paused resumes first: the words then reach the new session. */
  async sayText(text: string): Promise<void> {
    const t = text.trim();
    if (!t) return;
    if (this.pauseInfo) await this.resume();
    if (!this.live) return;
    this.kevinSpoke();
    if (YES_PATTERN.test(t)) {
      // A typed yes grants the way a spoken one does: only with its ledger row.
      this.confirmations.arm((g) => this.ledger.append({ at: this.now(), type: "grant", chainId: this.confirmations.conversationId, app: g.app, actionClass: g.actionClass, until: g.until }));
    }
    this.live.appendInstructions(null, `Kevin just typed (treat it exactly like speech): "${t}". Respond to it now; delegate if it asks for anything the backend does.`);
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
    // Both helpers' pending requests (each signals its own in-flight type), the lease, every worker.
    const dropped = this.pool.cancelAll(reason);
    this.lease.cancelAll(reason);
    const workers = this.workers.cancelAll(reason);
    const { jobs } = this.runner.abortTask(abortReason);
    // The question on the floor and every queued one go; the grants sleep until the same conversation resumes.
    this.confirmations.clear();
    this.desk.clear();
    if (this.dictating) this.stopDictation("said");
    this.earReflexes.quiesce();
    // Quiet: the caller's one instruction (interrupt) or the closing session (stop, pause) speaks for the whole stop.
    const cancel = Promise.all([this.delegator?.cancel(reason, { quiet: true }) ?? Promise.resolve(), workers]);
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
    // Only a session that has started is spoken to: one still opening has no id for the row and would
    // hear "stop speaking" as its first instruction after session.started.
    const open = !this.connecting && this.live?.session ? this.live : undefined;
    // The gate first, so a frame arriving between here and the flush is dropped too.
    if (open) this.outputGateUntil = t0 + Engine.OUTPUT_GATE_MS;
    const { running, dropped, jobs, cancel } = this.cutEverything(reason, "stop");
    if (open || running) this.ledger.append({ at: t0, type: "stop", how, ...(running ? { cancelled: running.id } : {}) });
    open?.appendInstructions(null, `${reason}. Stop speaking now and wait.`);
    this.toast(open || running || jobs ? "stopped" : "nothing running", "info");
    this.recomputePhase();
    await this.bounded(cancel);
    log.info(`interrupt (${source}, ${how}) in ${this.now() - t0}ms: ${running ? `cancelled ${running.id}` : "nothing was running"}; ${dropped} hands request(s) dropped; ${jobs} background job(s) stopped; voice gated for ${Engine.OUTPUT_GATE_MS} ms`);
  }

  /** The pre-transport name of `interrupt`; the bench and older notes say it. */
  stopEverything(source = "stop", how: "pressed" | "said" = "pressed"): Promise<void> {
    return this.interrupt(source, how);
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
    const workersRunning = this.workers.running() > 0;
    this.wantAwake = false;
    // Kevin's Stop wins over a restart's resume: the conversation the previous process was
    // cut from is not picked up by the next Go once he has said stop in this one.
    this.ledgerResumeUsed = true;
    this.lostSession = undefined;
    const { running, dropped, jobs, cancel } = this.cutEverything("Kevin pressed stop", "stop");
    this.endVoiceReconnect();
    // The stop row is written whenever there was something to stop — a pending reconnect
    // included, so the next process reads Kevin's word and does not resume the cut session.
    const happened = live !== undefined || wasConnecting || wasPaused || wasReconnecting || running !== undefined || workersRunning || jobs > 0;
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

  // -------------------------------------------------------------- workers
  // The pool lives in ./workers.ts; the engine gives it what only the engine knows: the
  // delegation behind a task, the parent's voice, the brain kind's factory, the two helpers.

  /** The runner a `tool.run {worker}` frame lands on (the daemon's `runnerFor`); undefined for a worker nobody owns — refused there. */
  runnerFor(worker: string): ToolRunner | undefined {
    return this.workers.laneRunner(worker);
  }

  /**
   * The desk promoted a queued question onto the floor. A worker's is spoken with its
   * name by the pool ("Spotify asks: …"). The MAIN lane's ("Jarhead") has no worker to
   * speak for it — its brain was told to wait, and may be blocked in worker_wait or done
   * — so Jarhead asks in its own words on the delegation under way (running or draining;
   * Jarhead's own line, never gated), else through the voice's instructions. Either way
   * the question Kevin's next yes lands on is the one he heard, and no other.
   */
  private speakPromoted(name: string, question: string): void {
    if (this.workers.speakQuestion(name, question)) return;
    const d = this.delegator?.active;
    if (d) this.delegator?.workerSay(d.id, "Jarhead", `May I ${question}? Say yes.`);
    else this.live?.appendInstructions(null, `Your earlier question is Kevin's to answer now. Ask him: "${question}".`);
  }

  /** The delegation a main-lane task belongs to, with Kevin's words for the worker's gates. */
  private workerParentFor(task: BrainTask | undefined): WorkerParent | undefined {
    if (!task) return undefined;
    const d = this.delegator?.all().find((x) => x.liveId === task.delegationId && x.status === "running");
    if (!d) return undefined;
    return { id: d.id, liveId: d.liveId, request: task.request, ...(task.kevinDialogue !== undefined ? { kevinDialogue: task.kevinDialogue } : {}), offsetMs: task.offsetMs };
  }

  /**
   * How a worker's two lines and its steps reach the parent delegation: the Delegator's
   * own hooks — the parent's `say(text, false)` and 600 ms coalescer for the lines, the
   * parent's timeline with `step.worker` for the steps — while the parent runs or drains.
   */
  private workerVoice(): WorkerVoice | undefined {
    return this.delegator;
  }

  // ------------------------------------------------------- conversations
  // Implemented in packages/agents-backed methods below; the UI sends agent.open
  // when Kevin hops into a session, receives `agent.transcript` events while it
  // is open, and agent.close when he leaves.

  private async openAgent(agentId: string): Promise<void> {
    // Count the viewer first so a close() that races the page read is not lost.
    const open = this.openConversations.get(agentId);
    if (open) open.viewers += 1;
    else this.openConversations.set(agentId, { viewers: 1, unwatch: undefined });
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
    // One tail per conversation however many surfaces show it; its deltas cannot arrive before the page below is emitted.
    if (!entry.unwatch) {
      let ended = false;
      try {
        const stop = this.agents.watch(
          agentId,
          (delta) => {
            if (!this.openConversations.has(agentId)) return;
            this.emit("event", { type: "agent.transcript", transcript: { agentId, messages: delta.messages, total: delta.total, complete: false, live: true }, mode: "append" });
          },
          (reason) => {
            // The tail could not start (the session is gone, its file unreadable): the
            // conversation stays open but is no longer live, and the surfaces hear so.
            ended = true;
            const current = this.openConversations.get(agentId);
            if (!current) return;
            current.unwatch?.(); // lets the connector drop its timers; a no-op once the tail has ended
            current.unwatch = undefined;
            log.warn(`agent.open ${agentId}: live tail ended (${reason})`);
            this.emit("event", { type: "agent.transcript", transcript: { agentId, messages: [], total: page.total, complete: false, live: false }, mode: "append" });
          },
        );
        // `ended` may already be set when the connector gave up synchronously.
        if (ended) stop?.();
        else entry.unwatch = stop;
      } catch (e) {
        log.warn(`agent.open ${agentId}: no live tail (${(e as Error).message})`);
      }
    }
    this.emit("event", { type: "agent.transcript", transcript: { agentId, ...page, live: entry.unwatch !== undefined }, mode: "replace" });
  }

  private async closeAgent(agentId: string): Promise<void> {
    const open = this.openConversations.get(agentId);
    if (!open) return;
    open.viewers -= 1;
    if (open.viewers > 0) return;
    this.openConversations.delete(agentId);
    open.unwatch?.();
  }

  private async agentHistory(agentId: string, before: string): Promise<void> {
    try {
      const page = await this.agents.transcript(agentId, { limit: DEFAULT_PAGE, before });
      this.emit("event", { type: "agent.transcript", transcript: { agentId, ...page, live: this.openConversations.has(agentId) }, mode: "replace" });
    } catch (e) {
      this.toast(`no older turns for ${agentId}: ${(e as Error).message}`, "warn");
    }
  }

  /** Stop every live tail; the surfaces are going away with the engine. */
  private closeConversations(): void {
    for (const open of this.openConversations.values()) open.unwatch?.();
    this.openConversations.clear();
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

  private async addMark(rawRect: Rect, path?: readonly Point[]): Promise<void> {
    const bbox = normalizeRect(rawRect);
    const id = newId("mark");
    const at = this.now();
    const size = `${Math.round(bbox.w)}×${Math.round(bbox.h)} at ${Math.round(bbox.x)},${Math.round(bbox.y)}`;
    // Registered before the capture, so a delegation fired while the hands work
    // sees a mark to wait for instead of missing it.
    const mark: ScreenMark = { id, rect: bbox, ...(path && path.length > 0 ? { path } : {}), at, consumed: false };
    this.marks = [...this.marks, mark].slice(-Engine.MAX_MARKS);
    this.scheduleSnapshot();
    // Asleep, the mark simply waits for the next session; awake, the voice hears about it now.
    this.live?.appendInstructions(null, `Kevin just circled a region of his screen (${size}). The brain will see the image with the next task; acknowledge briefly if he is asking about it.`);
    // What did he surround? The element under the stroke's centroid and the window
    // list say; the mark snaps to the smallest frame that holds the centroid and
    // sits mostly inside his stroke. Failing that, the stroke's own box stands.
    const capture = (async () => {
      const snapped = await this.resolveMarkTarget(bbox, path);
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
  async pause(): Promise<void> {
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
    this.toast("paused · meter stopped", "info");
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
      this.toast(this.live ? "not paused" : "asleep — wake it instead", "info");
      return;
    }
    if (this.connecting) return; // the resume is already opening its session
    await this.connect("resume", { pause, continuity: this.continuityFor(pause) });
  }

  /**
   * The "# Continuity" section a resumed session starts with: the last lines of the
   * conversation and the last task. `how` says what the gap was: a pause Kevin chose
   * (the default: carry on silently), or a restart of the engine that cut the
   * conversation — then the lines come from the LEDGER (this process never heard them)
   * and the voice says one word, "back", so Kevin knows it is the same conversation.
   */
  private continuityFor(pause: PauseInfo, how: "paused" | "restarted" = "paused"): string {
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
  private reflexesOn(): boolean {
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
    // workers drain under a parent that is merely `draining` (B3's second slot), and not while
    // the main brain's turn is blocked in worker_wait (its hands are still for up to 240 s):
    // a colleague working Spotify by Apple events would still scroll for you.
    const active = this.delegator?.active;
    const draining = this.delegator?.draining;
    if (active && (!draining || active.id !== draining.id) && !this.runner.waitingOnWorkers) return "a task is running";
    // A screen-lane worker has the pointer: a reflex click would land in its work. Jarhead's own
    // hold (a reflex that just ran, dictation) is the ear's own doing and holds nothing.
    const holder = this.lease.holder;
    if (holder !== undefined && holder !== WorkerAwareRunner.ACTOR && holder !== "dictation") return "a task is running";
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

  /** The grammar, gated by the setting and by dictation (while dictating, words are text, not commands). */
  private matchReflex(utterance: string): Reflex | undefined {
    if (this.settings.reflexes === false || this.dictating) return undefined;
    return this.reflexRunner.match(utterance);
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
  private async runEarReflex(reflex: Reflex, _phrase: string): Promise<ReflexOutcome & { readonly dropped?: string }> {
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
            // Queued behind a worker's question: nobody will relay it either; it leaves the queue so it is never promoted unspoken.
            this.desk.drop(WorkerAwareRunner.ACTOR);
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
      // Reads, on the reading helper: the acting one may be mid-click for a worker or the brain.
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
    // Kevin's live typing is never interleaved with a worker's: dictation holds the screen with priority until it
    // ends, and holds it as ONE op in flight — a holder that merely falls silent for LEASE_IDLE_MS lets a waiting
    // worker take the lease, and Kevin pausing between sentences is not letting go. (A long dictation can cost a
    // waiting worker its three waits; it then reports "could not get the screen".)
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
      else if (ConfirmationDesk.isQueuedId(r.pendingId)) this.desk.drop(WorkerAwareRunner.ACTOR);
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
    // One spare worker process, so the first split lands at once (no model request: primeThreads off).
    if (this.settings.workers !== false) this.workers.warmSpare();
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
      case "wake":
        return this.wake("wake command");
      case "sleep":
        // The app's dock drop sends cause "dock"; a bare sleep is the legacy command. Only a spoken cue gets the farewell.
        return this.fallAsleep(cmd.cause ?? "command", { ...(cmd.phrase ? { phrase: cmd.phrase } : {}), farewell: cmd.cause === "said" });
      case "worker.stop": {
        const w = this.workers.get(cmd.workerId);
        const cut = await this.workers.stop(cmd.workerId, "kevin");
        // A row still lingering for the Console after its worker finished: nothing was stopped, and the word says so.
        this.toast(!w ? "no such worker" : cut ? `${w.name} stopped` : `${w.name} had already finished`, w ? "info" : "warn");
        return;
      }
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
        const r = await this.agents.send(cmd.agentId, cmd.text);
        this.toast(r.accepted ? `sent to ${cmd.agentId}` : `not sent: ${r.detail ?? "refused"}`, r.accepted ? "info" : "warn");
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
        return this.openAgent(cmd.agentId);
      case "agent.close":
        return this.closeAgent(cmd.agentId);
      case "agent.history":
        return this.agentHistory(cmd.agentId, cmd.before);
      case "mark.add":
        return this.addMark(cmd.rect, cmd.path);
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
    // A question queued behind one Kevin moved on from comes up now (the desk cannot see the root's drop).
    this.desk.promote();
    const idleMs = this.settings.idleSleepMinutes * 60_000;
    // Not idle while a task runs — or while a worker still works for one (Live stays open for its
    // question and for the spoken stop; its caps bound the worst case at about five minutes).
    const busy = this.delegator?.active !== undefined || this.workers.running() > 0;
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
    if (this.live) this.transcript.settle(this.live.nowMs);
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
  // (REDESIGN §16, "Problems, typed"). `problems` (the snapshot's plain list) stays the
  // order and the cap; `problemMeta` carries kind, remedy and first-seen per line, so
  // `typedProblems()` is the same list with its remedies. Deduped by kind + text; a line
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

  /** The problems with their kind, remedy and first-seen: the snapshot's `problemsTyped`, the same list as `problems`. */
  typedProblems(): Problem[] {
    this.pruneProblemMeta();
    return this.problems.map((text) => {
      const meta = this.problemMeta.get(text);
      return { kind: meta?.kind ?? "other", text, ...(meta?.remedy ? { remedy: meta.remedy } : {}), since: meta?.since ?? this.now() };
    });
  }

  /** The remedies that are one command away. */
  private static readonly PROBE_REMEDY: ProblemRemedy = { label: "Retry", command: { type: "config.probe" } };
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
   * a new process; the disk is measured again. A limit is over by the time anyone
   * presses it; a crash report and the daemon row are the surface's to dismiss.
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
      case "daemon":
      case "crash":
      case "other":
        this.clearProblems(kind);
        return;
    }
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
      transcript: this.nowVisible(this.wholeTranscript(), (i) => i.at).slice(-200),
      // Delegations survive a pause and resume (and a sleep): the Console keeps the day's work, newest last.
      delegations: this.nowVisible([...this.pastDelegations(), ...(this.delegator?.all() ?? [])], (d) => d.createdAt).slice(-Engine.MAX_DELEGATIONS),
      agents: this.agentsList,
      connectors: this.connectorHealth,
      settings: this.settings,
      permissions: this.permissions,
      problems: this.problems,
      problemsTyped: this.typedProblems(),
      brainReady: this.brainReady,
      setup: this.setupStatus(),
      marks: this.marks,
      handsReady: this.hands.ready || this.hands.available,
      // The Trash line and the hidden agents (K1); both are read when they change, not here.
      trash: this.trashInfo,
      hiddenAgents: this.hiddenAgents,
      // Running workers and those finished within WORKER_LINGER_MS, for the Console's rail.
      workers: this.workers.list(),
    };
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
    this.lostSession = undefined;
    this.ledgerResumeUsed = true;
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

function normalizeForLog(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 80);
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
