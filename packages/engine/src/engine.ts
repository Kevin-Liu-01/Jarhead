import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HANDS_OFF_APPS, classifyAction, writeEnvSecrets, secretsPresent, Ledger, logger, newId, readConfig, type JarheadConfig } from "@jarhead/core";
import { LiveSession, Transcript, buildLiveInstructions, type SessionConfig } from "@jarhead/live";
import { ComputerToolset, ConfirmationState, DEFAULT_SHOT_BUDGET, HELPER_PERMISSION_KINDS, NativeHandsProcess, YES_PATTERN, fakeHandsSpawn, type ActionEvent, type AxTreeResult, type ElementInfo, type FocusedText, type FrontmostInfo, type HelloPermissions, type HelperPermissionKind, type NativeHands, type ScreenshotResult, type WindowInfo } from "@jarhead/hands";
import { AgentRegistry, DEFAULT_PAGE, defaultConnectors, type AgentConnector, type TranscriptPage } from "@jarhead/agents";
import { BROWSER_APPS, ClaudeBrain, Delegator, FiredReflexes, ReflexRunner, ResponsesBrain, ToolRunner, responsesDelegationConfig, screenNote, type Brain, type BrainAttachment, type BrainSink, type Reconciliation, type Reflex, type ReflexOutcome } from "@jarhead/brain";
import { EarReflexes, type ReflexLedgerRow } from "./ear.ts";
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
  type Settings,
  type Point,
  type Rect,
  type ScreenMark,
  type SecretKey,
  type SettingsPatch,
  type SetupStatus,
  type Snapshot,
  type TranscriptItem,
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
  /** What a fresh helper process would print for `--permissions` (tests; the real client runs the binary). */
  readonly probePermissions?: () => Promise<HelloPermissions>;
  /** The ear's stability window for a partial of a prefire kind — scroll, page, screenshot, circle (default 120 ms); tests shorten it. */
  readonly earStableMs?: number;
  /** The ear's stability window for a partial of every other kind — keys, edits, typing, clicks (default 450 ms); tests shorten it. */
  readonly earCarefulMs?: number;
  /** How long a graceful `close()` may go unanswered before the session is `terminate()`d (default 1000 ms); tests shorten it. */
  readonly closeDeadlineMs?: number;
}

const SETTINGS_FILE = "settings.json";

export class Engine extends EventEmitter<EngineEvents> {
  /** Re-read after `config.set-secrets`; everything else treats it as constant. */
  config: JarheadConfig;
  readonly ledger: Ledger;
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
  readonly hands: NativeHandsProcess;
  readonly toolset: ComputerToolset;
  readonly agents: AgentRegistry;
  readonly runner: ToolRunner;

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
  private problems: string[] = [];
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
    this.settings = this.loadSettings();
    // The seam: a stand-in answers the helper's request lines as a fake child, so the
    // real client (pending map, timeouts, a stop's cancelPending) runs unchanged.
    this.hands = new NativeHandsProcess({ binPath: this.config.handsBin, ...(opts.hands ? { spawnImpl: fakeHandsSpawn(opts.hands), assumeAvailable: true } : {}), ...(opts.probePermissions ? { probeImpl: opts.probePermissions } : {}) });
    this.toolset = new ComputerToolset({
      hands: this.hands,
      confirmations: this.confirmations,
      excludePids: () => [...this.excludePids, process.pid],
      annotate: (cmd) => this.emit("overlay", cmd),
      onAction: (a) => this.onAction(a),
    });
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
    this.runner = new ToolRunner({
      toolset: this.toolset,
      agents: this.agents,
      stateDir: this.config.stateDir,
      overlay: (cmd) => this.emit("overlay", cmd),
      // Self-edit: after a change to engine code passes its checks and Kevin confirms,
      // the daemon restarts on the new code (exit 75 → the app respawns it).
      requestRestart: (reason) => this.requestRestart(reason),
      socketPath: this.config.socketPath,
      selfEdit: {
        ...(this.config.codexBin ? { codexBin: this.config.codexBin } : {}),
        ...(this.config.claudeBin ? { claudeBin: this.config.claudeBin } : {}),
      },
    });
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
        if (this.delegator?.active || (this.now() - this.lastOutputSpeechAt < 1200 && !this.outputGated)) void this.interrupt("ear", "said");
      },
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
    const t = new Transcript();
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
    this.tickTimer = setInterval(() => this.tick(), 1000);
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
      this.problem(`hands helper not built (${this.config.handsBin}); run pnpm build:hands`);
      this.permissions = { ...this.permissions, screenRecording: "unknown", accessibility: "unknown" };
      return;
    }
    try {
      const hello = await this.hands.hello();
      // The greeting is a fresh process's read (the helper was just spawned): fold it like a poll.
      this.applyHelperRead(hello.permissions);
    } catch (e) {
      // A restart (a grant appeared while the greeting was pending) ends the first helper on
      // purpose; the successor greets again. Only a second failure is a problem.
      if (/hands helper stopped/.test((e as Error).message) && this.hands.available) {
        try {
          const hello = await this.hands.hello();
          this.applyHelperRead(hello.permissions);
          this.scheduleSnapshot();
          return;
        } catch (again) {
          this.problem(`hands helper failed: ${(again as Error).message}`);
          this.scheduleSnapshot();
          return;
        }
      }
      this.problem(`hands helper failed: ${(e as Error).message}`);
    }
    this.scheduleSnapshot();
  }

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
        this.problems = this.problems.filter((p) => p !== text);
        if (before !== "unknown") this.toast(`${base.label} granted — ${Engine.GRANTED_NOTE[kind]}`, "info");
      } else {
        this.problem(text);
        if (before === "granted") this.toast(`${base.label} was revoked`, "warn");
      }
    }
    this.permissions = { ...fields, all: rows };
    return { changed, regained };
  }

  /** A grant appeared for a connection the resident helper made without it: restart it (no relaunch of anything else). */
  private async restartHandsAfterGrant(): Promise<void> {
    if (!this.hands.available) return;
    try {
      await this.hands.restart();
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
    if (state === "denied") this.problem(Engine.MICROPHONE_PROBLEM);
    else if (state === "granted") this.problems = this.problems.filter((p) => p !== Engine.MICROPHONE_PROBLEM);
    this.scheduleSnapshot();
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
      const old = this.brain;
      this.brain = undefined;
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
          await this.sleep();
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
        if (r.status === 404) this.problem(`OpenAI key works but ${this.config.liveModel} is not listed for it`);
      } catch (e) {
        this.problem(`could not reach api.openai.com: ${(e as Error).message}`);
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

    // Every brain proves itself before it takes a task.
    const build = (kind: Kind): { brain: Brain; label: string; warning?: string } => {
      switch (kind) {
        case "codex":
          return {
            label: "Codex",
            brain: new CodexBrain({
              runner: this.runner,
              probe: codexProbe,
              stateDir: this.config.stateDir,
              socketPath: this.config.socketPath,
              // Under `auto` a leftover Claude id is not an override for Codex; an explicit choice keeps what Kevin set.
              ...(model && !(wanted === "auto" && looksClaude) ? { model } : {}),
              effort: this.settings.effort,
            }),
          };
        case "claude-code":
          return {
            label: "Claude Code",
            brain: new ClaudeBrain({
              runner: this.runner,
              stateDir: this.config.stateDir,
              // Under `auto` a leftover OpenAI id must not sink the Claude login; an explicit choice keeps what Kevin set.
              ...(model && !(wanted === "auto" && looksOpenAI) ? { model } : {}),
              effort: this.settings.effort,
              ...(this.config.claudeBin ? { pathToClaudeCodeExecutable: this.config.claudeBin } : {}),
            }),
          };
        case "anthropic-api":
          return { label: "Anthropic API", brain: new AnthropicBrain({ runner: this.runner, apiKey: this.config.anthropicApiKey, model, effort: this.settings.effort }) };
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
            brain: new OpenAICompatibleBrain({ runner: this.runner, baseUrl, apiKey: key.apiKey, model }),
          };
        }
        case "openai-responses":
          // The model override only applies when Kevin chose this backend; under `auto` it may be another vendor's id.
          return { label: "OpenAI Responses", brain: new ResponsesBrain({ runner: this.runner, model: wanted === "openai-responses" ? model : undefined, effort: "low" }) };
      }
    };

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
      if (candidate.warning) this.problem(candidate.warning);
      const r = await candidate.brain.start();
      if (r.ready) {
        this.brain = candidate.brain;
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
      this.problem(`${candidate.label} brain unavailable (${r.detail}); ${order.length > 1 ? "trying the next backend" : "using the OpenAI backend instead"}`);
    }
    // An explicit choice that could not start: the Live session's own Responses delegation always can.
    const responses = new ResponsesBrain({ runner: this.runner, effort: "low" });
    const r = await responses.start();
    this.brain = responses;
    this.brainReady = r.ready;
    this.brainDetail = r.detail;
  }

  /** Called by the shell when the brain fails to authenticate mid-run. */
  private async swapToResponses(reason: string): Promise<void> {
    this.problem(`brain failed (${reason}); switching to the OpenAI backend for the next session`);
    await this.brain?.stop();
    const responses = new ResponsesBrain({ runner: this.runner, effort: "low" });
    await responses.start();
    this.brain = responses;
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
      this.problem("OPENAI_API_KEY is missing; set it in ~/.jarhead/env or .env.local");
      this.setPhase("error");
      return;
    }
    this.connecting = true;
    this.lastAddressedAt = this.now();
    this.setPhase("connecting");
    await this.ready();
    // A brain swap in flight (keys changed, settings changed) leaves `this.brain` undefined for a moment; wire() needs it.
    if (this.brainRestart) await this.brainRestart.catch(() => undefined);
    if (!this.wantAwake) {
      this.connecting = false;
      this.setPhase("asleep");
      return;
    }
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
      log.info(`session ${res.id} started (${config.delegation?.type ?? "client"} delegation${resume ? `; resumed from ${resume.pause.sessionId}` : ""})`);
      this.warmStart();
    } catch (e) {
      if (live && this.live === live) this.detachLive(live);
      if (!this.wantAwake) {
        // Closed on purpose (a stop while connecting): not a problem.
        log.info(`session start abandoned: ${(e as Error).message}`);
        this.setPhase("asleep");
      } else {
        this.problem(`could not start a Live session: ${(e as Error).message}`);
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
    this.usageBase = { seconds, sessions };
    this.usageDay = Ledger.fileNameFor(now);
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
      // Paused (or dictating): delegations are recorded and refused, never run.
      refuse: () => (this.paused ? "paused" : this.dictating ? "Kevin is dictating" : undefined),
      // A spoken "stop" is an interrupt: the whole of what is running and being said ends; the session stays.
      onStop: (reason) => void this.interrupt(reason, "said"),
      // The session timeline's zero on the wall clock: the triggering utterance's end becomes timings.speechEndAt.
      sessionStartedAt: () => this.sessionStartedAt,
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
      this.lastAddressedAt = this.now();
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
      if (!/context_injection_incomplete/.test(e.message)) this.problem(`voice: ${e.message}`);
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
        // Re-checked when it fires: a stop or a pause in the meantime wins over the reconnect.
        setTimeout(() => {
          if (this.wantAwake && !this.pauseInfo) void this.connect(`reconnect after ${reason}`);
        }, 500).unref?.();
      } else {
        this.setPhase("asleep");
      }
    });
  }

  /**
   * Sleep: a graceful close and asleep (idle sleep, a brain swap, shutdown, a
   * pause that decayed). From paused, the held conversation is let go. The session
   * is detached at once — the next snapshot has none — and closed with the deadline.
   */
  async sleep(): Promise<void> {
    this.wantAwake = false;
    const live = this.live;
    const wasPaused = this.pauseInfo !== undefined;
    this.pauseInfo = undefined;
    // Quiet: nothing appended to a session about to close (context_injection_incomplete otherwise).
    const cancel = this.delegator?.cancel("going to sleep", { quiet: true }) ?? Promise.resolve();
    if (live && !this.connecting) {
      this.detachLive(live);
      this.closeWithDeadline(live, "sleep");
    }
    this.flushSpeaker();
    this.setPhase("asleep");
    if (wasPaused) log.info("pause ended: asleep");
    // A brain whose cancel hangs must not hold anything up; the session is closing already.
    await this.bounded(cancel);
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
    this.lastAddressedAt = this.now();
    if (YES_PATTERN.test(t)) this.confirmations.arm();
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
    const dropped = this.hands.cancelPending(reason);
    const { jobs } = this.runner.abortTask(abortReason);
    this.confirmations.clear();
    if (this.dictating) this.stopDictation("said");
    this.earReflexes.quiesce();
    // Quiet: the caller's one instruction (interrupt) or the closing session (stop, pause) speaks for the whole stop.
    const cancel = this.delegator?.cancel(reason, { quiet: true }) ?? Promise.resolve();
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
    this.wantAwake = false;
    const { running, dropped, jobs, cancel } = this.cutEverything("Kevin pressed stop", "stop");
    this.pauseInfo = undefined;
    const happened = live !== undefined || wasConnecting || wasPaused || running !== undefined || jobs > 0;
    if (happened) this.ledger.append({ at: t0, type: "stop", how: "pressed", ...(running ? { cancelled: running.id } : {}) });
    if (live && !wasConnecting) {
      this.detachLive(live);
      this.closeWithDeadline(live, "stop");
    }
    this.setPhase("asleep");
    this.toast(happened ? "stopped" : "nothing running", "info");
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
    try {
      // Jarhead's own windows (the orb, the overlay with the stroke on it) stay out of the shot, as with every capture.
      const shot = await this.hands.request<ScreenshotResult>("zoom", { ...rect, maxLongEdge: DEFAULT_SHOT_BUDGET.maxLongEdge, excludePids: [...this.excludePids, process.pid] }, 6000);
      const day = new Date(at).toISOString().slice(0, 10);
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

  /** The "# Continuity" section a resumed session starts with: the last lines of the conversation and the last task. */
  private continuityFor(pause: PauseInfo): string {
    const minutes = Math.round((this.now() - pause.at) / 60_000);
    const when = minutes < 1 ? "less than a minute ago" : minutes === 1 ? "a minute ago" : `${minutes} minutes ago`;
    const lines: string[] = [];
    let chars = 0;
    const whole = this.wholeTranscript();
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
    const task = last?.summary ? `Last task: "${last.request.replace(/\s+/g, " ").trim().slice(0, 160)}" — ${last.status}: ${last.summary}` : undefined;
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
    if (this.delegator?.active) return "a task is running";
    const now = this.now();
    const speaking = now - this.lastOutputSpeechAt < Engine.SPEAKING_WINDOW_MS;
    const audible = now - this.lastAudibleOutputAt < Engine.SPEAKING_WINDOW_MS && now - this.lastOutputAudioAt < Engine.SPEAKING_WINDOW_MS;
    if (!this.outputGated && (speaking || audible)) return "the voice is speaking";
    return undefined;
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
            this.confirmations.clear();
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
      const c = await this.hands.request<{ x: number; y: number }>("cursor", {}, 1000);
      const el = await this.hands.request<ElementInfo>("element_at", c, 1500).catch(() => undefined);
      if (el?.frame && el.frame.w >= 4 && el.frame.h >= 4 && el.frame.w * el.frame.h < 4_000_000) {
        rect = el.frame;
        label = el.title || el.description || el.role;
      }
      if (!rect) {
        const f = await this.hands.request<FrontmostInfo>("frontmost", {}, 1500);
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
    this.lastAddressedAt = this.now();
    this.live?.appendInstructions(null, "Kevin is dictating into a field on his screen: his words are being typed as he says them. Stay completely silent until he says \"stop dictating\"; do not delegate what he says.");
    this.ledger.append({ at: this.now(), type: "dictation", state: "started" } as unknown as LedgerRow);
    this.toast("dictating — say \"stop dictating\" to end", "info");
    this.recomputePhase();
  }

  private stopDictation(reason: "said" | "refused" | "asleep"): void {
    if (!this.dictating) return;
    this.dictating = false;
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
    const r = await this.toolset.run("type", { text });
    if (r.kind === "needs-confirmation") {
      if (this.confirmations.pending?.id === r.pendingId) this.confirmations.clear();
      return false;
    }
    if (r.kind === "error") {
      log.warn(`dictation type failed: ${r.message}`);
      return !/^refused/.test(r.message);
    }
    this.lastAddressedAt = this.now();
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
    if (!this.hands.available && !this.hands.ready) return;
    if (!(this.brain instanceof ResponsesBrain)) {
      const t0 = this.now();
      void this.toolset.run("screenshot", { quick: true }).then((r) => log.info(`first screenshot at wake: ${r.kind} in ${this.now() - t0} ms`));
    }
    this.startAxWarm();
  }

  private startAxWarm(): void {
    if (this.axWarmTimer || this.opts.hands === undefined && !this.hands.available) return;
    const tick = (): void => {
      if (!this.live || this.axWarmBusy) return;
      this.axWarmBusy = true;
      this.hands
        .request<AxTreeResult>("ax_tree", { summary: true, maxAgeMs: Engine.AX_WARM_MS - 100, maxMs: 80 }, 1500)
        .then((r) => {
          if (r.app) this.frontApp = r.app;
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
        return this.sleep();
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
    await this.sleep();
    // The process is going away with the session; no deadline may fire into a gone engine.
    for (const t of this.closeTimers) clearTimeout(t);
    this.closeTimers.clear();
    await this.brain?.stop();
    this.hands.stop();
  }

  // ----------------------------------------------------------------- state

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
    this.watchdog();
    if (now - this.memoryLoggedAt >= Engine.MEMORY_LOG_MS) {
      this.memoryLoggedAt = now;
      this.logMemory();
    }
    const idleMs = this.settings.idleSleepMinutes * 60_000;
    if (this.live && !this.connecting && this.live.currentState === "started" && !this.delegator?.active && idleMs > 0 && now - this.lastAddressedAt > idleMs) {
      log.info(`idle for ${this.settings.idleSleepMinutes} min; sleeping`);
      this.toast("asleep — tap the orb to wake", "info");
      void this.sleep();
    }
    // A pause nobody resumed decays to sleep: the held conversation is let go.
    if (this.pauseInfo && !this.connecting && now >= this.pauseInfo.sleepsAt) {
      log.info(`paused ${Math.round((now - this.pauseInfo.at) / 60_000)} min without a resume; sleeping`);
      this.toast("paused too long · asleep", "info");
      void this.sleep();
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

  problem(text: string): void {
    log.warn(text);
    this.problems = [...this.problems.filter((p) => p !== text), text].slice(-8);
    this.ledger.append({ at: this.now(), type: "problem", text });
    this.scheduleSnapshot();
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
      transcript: this.wholeTranscript().slice(-200),
      // Delegations survive a pause and resume (and a sleep): the Console keeps the day's work, newest last.
      delegations: [...this.pastDelegations(), ...(this.delegator?.all() ?? [])].slice(-Engine.MAX_DELEGATIONS),
      agents: this.agentsList,
      connectors: this.connectorHealth,
      settings: this.settings,
      permissions: this.permissions,
      problems: this.problems,
      brainReady: this.brainReady,
      setup: this.setupStatus(),
      marks: this.marks,
      handsReady: this.hands.ready || this.hands.available,
    };
  }

  private lastDelegations: readonly Delegation[] = [];

  private pastDelegations(): readonly Delegation[] {
    return this.lastDelegations;
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
