import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeEnvSecrets, secretsPresent, Ledger, logger, newId, readConfig, type JarheadConfig } from "@jarhead/core";
import { LiveSession, Transcript, buildLiveInstructions, type SessionConfig } from "@jarhead/live";
import { ComputerToolset, ConfirmationState, DEFAULT_SHOT_BUDGET, NativeHandsProcess, YES_PATTERN, fakeHandsSpawn, type ActionEvent, type ElementInfo, type NativeHands, type ScreenshotResult, type WindowInfo } from "@jarhead/hands";
import { AgentRegistry, DEFAULT_PAGE, defaultConnectors, type AgentConnector, type TranscriptPage } from "@jarhead/agents";
import { ClaudeBrain, Delegator, ReflexRunner, ResponsesBrain, ToolRunner, responsesDelegationConfig, screenNote, type Brain, type BrainAttachment, type BrainSink, type Reflex, type ReflexOutcome } from "@jarhead/brain";
import {
  DEFAULT_SETTINGS,
  DEFAULT_WAKE,
  type AgentInfo,
  type AudioLevels,
  type ConnectorHealth,
  type Delegation,
  type EngineCommand,
  type EngineEvent,
  type OverlayCommand,
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
  type WakeSettings,
} from "@jarhead/protocol";

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
}

const SETTINGS_FILE = "settings.json";

export class Engine extends EventEmitter<EngineEvents> {
  /** Re-read after `config.set-secrets`; everything else treats it as constant. */
  config: JarheadConfig;
  readonly ledger: Ledger;
  readonly transcript = new Transcript();
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
  private lastAddressedAt = 0;
  /**
   * The output gate: Live has no interrupt, so after a stop the voice's audio is
   * dropped here (and its transcript deltas do not count as speaking) until Kevin's
   * next input-transcript delta or OUTPUT_GATE_MS pass. Wall clock of `now()`.
   */
  private outputGateUntil = 0;
  private gatedFrames = 0;
  private readonly reflexRunner: ReflexRunner;
  private outputLevel = 0;
  private inputLevel = 0;
  private snapshotTimer: NodeJS.Timeout | undefined;
  private tickTimer: NodeJS.Timeout | undefined;
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
    this.settings = this.loadSettings();
    // The seam: a stand-in answers the helper's request lines as a fake child, so the
    // real client (pending map, timeouts, a stop's cancelPending) runs unchanged.
    this.hands = new NativeHandsProcess({ binPath: this.config.handsBin, ...(opts.hands ? { spawnImpl: fakeHandsSpawn(opts.hands), assumeAvailable: true } : {}) });
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
    this.reflexRunner = new ReflexRunner({ runner: this.runner, frontmostApp: () => this.frontmostAppName() });
    this.transcript.onChange((item, kind) => {
      if (kind === "final") {
        this.ledger.append({ at: item.at, type: item.speaker === "kevin" ? "heard" : "said", item });
        this.emit("utterance", item);
      }
      this.scheduleSnapshot();
    });
  }

  /** How long the voice stays muted locally after a stop when Kevin says nothing. */
  static readonly OUTPUT_GATE_MS = 2500;
  /** "Mid-exchange": Jarhead spoke or was delegated to this recently, so a bare reflex without the wake word may fire ahead of the delegation. */
  static readonly EXCHANGE_WINDOW_MS = 8000;

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
      this.permissions = {
        ...this.permissions,
        accessibility: hello.permissions.accessibility ? "granted" : "denied",
        screenRecording: hello.permissions.screenRecording ? "granted" : "denied",
      };
      if (!hello.permissions.accessibility) this.problem(Engine.PERMISSION_PROBLEMS.accessibility);
      if (!hello.permissions.screenRecording) this.problem(Engine.PERMISSION_PROBLEMS.screenRecording);
    } catch (e) {
      this.problem(`hands helper failed: ${(e as Error).message}`);
    }
    this.scheduleSnapshot();
  }

  /** Ask macOS for the grants (prompts appear for the responsible app). */
  async requestPermission(which: keyof Permissions): Promise<void> {
    if (which === "microphone") return; // the app owns the microphone prompt and reports the grant itself
    try {
      await this.hands.request("permissions", { prompt: true }, 5000);
    } catch (e) {
      log.warn(`permission prompt failed: ${(e as Error).message}`);
    }
    // Kevin is in System Settings now: watch closely for the next minute and a half.
    this.permissionFastUntil = this.now() + 90_000;
    this.permissionPollAt = 0;
    await this.pollPermissions();
  }

  private static readonly PERMISSION_PROBLEMS: Record<"accessibility" | "screenRecording", string> = {
    accessibility: "Accessibility not granted: clicks and typing will silently do nothing until it is (if System Settings already shows Jarhead on, that row is from an earlier build — remove it and press Request)",
    screenRecording: "Screen Recording not granted: screenshots will fail until it is (if System Settings already shows Jarhead on, remove that row and press Request)",
  };

  /**
   * Grants change while we run — Kevin flips a switch in System Settings — and a
   * running process may never notice. So: ask a fresh helper process on a timer
   * (3 s while something is missing, 1.5 s right after a prompt, 30 s when all is
   * well) and, when a grant appears, restart the resident helper so its capture
   * and accessibility connections are made with the new rights. No relaunch.
   */
  private async pollPermissions(): Promise<void> {
    if (this.permissionPolling || !this.hands.available) return;
    const now = this.now();
    const allGranted = this.permissions.accessibility === "granted" && this.permissions.screenRecording === "granted";
    const interval = now < this.permissionFastUntil ? 1500 : allGranted ? 30_000 : 3000;
    if (now - this.permissionPollAt < interval) return;
    this.permissionPollAt = now;
    this.permissionPolling = true;
    try {
      const fresh = await this.hands.probePermissions();
      let changed = false;
      let regained = false;
      for (const which of ["accessibility", "screenRecording"] as const) {
        const state: Permissions[typeof which] = fresh[which] ? "granted" : "denied";
        if (this.permissions[which] === state) continue;
        changed = true;
        const label = which === "accessibility" ? "Accessibility" : "Screen Recording";
        const problemText = Engine.PERMISSION_PROBLEMS[which];
        if (state === "granted") {
          regained = true;
          this.problems = this.problems.filter((p) => p !== problemText);
          this.toast(`${label} granted${which === "accessibility" ? " — hands can click and type now" : " — screenshots will work now"}`, "info");
        } else if (this.permissions[which] === "granted") {
          this.problem(problemText);
          this.toast(`${label} was revoked`, "warn");
        }
        this.permissions = { ...this.permissions, [which]: state };
      }
      if (regained) {
        try {
          await this.hands.restart();
        } catch (e) {
          log.warn(`hands restart after grant failed: ${(e as Error).message}`);
        }
      }
      if (changed) this.scheduleSnapshot();
    } catch (e) {
      log.debug(`permission probe failed: ${(e as Error).message}`);
    } finally {
      this.permissionPolling = false;
    }
  }

  setMicrophonePermission(state: Permissions["microphone"]): void {
    this.permissions = { ...this.permissions, microphone: state };
    if (state === "denied") this.problem("Microphone access denied; Jarhead cannot hear you");
    this.scheduleSnapshot();
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

  private sessionConfig(): SessionConfig {
    const brain = this.brain;
    const delegation =
      brain instanceof ResponsesBrain
        ? responsesDelegationConfig({ model: this.settings.brain === "openai-responses" ? this.settings.brainModel : undefined, effort: "low" })
        : ({ type: "client" } as const);
    return {
      model: this.config.liveModel,
      instructions: buildLiveInstructions({ alwaysOn: true }),
      audio: { format: { type: "audio/pcm", rate: 24000 }, output: { voice: this.settings.voice } },
      delegation,
    };
  }

  /** Open a Live session. Idempotent while one is open or opening. */
  async wake(reason = "command"): Promise<void> {
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
    if (!this.wantAwake) {
      this.connecting = false;
      this.setPhase("asleep");
      return;
    }
    const config = this.sessionConfig();
    const live = this.opts.makeLive ? this.opts.makeLive(config) : new LiveSession({ apiKey: this.config.openaiApiKey, config });
    this.live = live;
    this.wire(live);
    try {
      const res = await live.start();
      this.sessionStartedAt = this.now();
      this.lastAddressedAt = this.now();
      this.usageSeconds = 0;
      this.ledger.append({ at: this.now(), type: "session.started", sessionId: res.id, voice: this.settings.voice });
      if (this.muted) live.mute();
      this.setPhase(this.muted ? "muted" : "listening");
      log.info(`session ${res.id} started (${config.delegation?.type ?? "client"} delegation)`);
    } catch (e) {
      this.problem(`could not start a Live session: ${(e as Error).message}`);
      this.live = undefined;
      this.delegator?.dispose();
      this.delegator = undefined;
      this.setPhase("error");
    } finally {
      this.connecting = false;
    }
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
              match: (u) => this.reflexRunner.match(u),
              run: (reflex, sink) => this.runReflex(reflex, sink),
              inExchange: () => this.now() - this.lastAddressedAt < Engine.EXCHANGE_WINDOW_MS,
            },
          }),
      // A spoken "stop" is a Stop like any other: the whole stop, not only the delegation.
      onStop: (reason) => void this.stopEverything(reason, "said"),
    });
    delegator.on("change", () => this.scheduleSnapshot());
    delegator.on("phase", () => this.recomputePhase());
    delegator.on("cancelled", () => this.flushSpeaker());
    delegator.on("reflex", (label, ms, prefired) => {
      log.info(`reflex ${label} in ${ms}ms${prefired ? " (ahead of the delegation)" : ""}`);
      this.emit("reflex", label, ms, prefired);
    });
    this.delegator = delegator;

    live.on("audio", (pcm) => {
      // After a stop the voice is muted here until Kevin speaks or the gate lapses:
      // the API has no interrupt, so a sentence already in flight is simply not played.
      if (this.now() < this.outputGateUntil) {
        this.gatedFrames++;
        this.outputLevel = 0;
        return;
      }
      this.outputLevel = rms(pcm);
      this.emit("audio", pcm);
    });
    live.on("inputTranscript", (delta, s, e) => {
      if (this.outputGateUntil) this.liftOutputGate("Kevin spoke");
      this.transcript.push({ speaker: "kevin", delta, startMs: s, endMs: e });
    });
    live.on("outputTranscript", (delta, s, e) => {
      // What the model said goes on the record even when the gate kept it off the speaker.
      this.transcript.push({ speaker: "jarhead", delta, startMs: s, endMs: e });
      if (this.now() < this.outputGateUntil) return; // muted locally: not "speaking"
      this.lastOutputSpeechAt = this.now();
      this.lastAddressedAt = this.now();
      this.recomputePhase();
    });
    live.on("delegation", () => {
      this.lastAddressedAt = this.now();
    });
    live.on("usage", (seconds, ratio) => {
      this.usageSeconds = seconds;
      this.contextRatio = ratio;
      this.scheduleSnapshot();
    });
    live.on("error", (e, cid) => {
      log.warn(`live error${cid ? ` (${cid})` : ""}: ${e.message}`);
      if (!/context_injection_incomplete/.test(e.message)) this.problem(`voice: ${e.message}`);
    });
    live.on("closed", (reason, usage) => {
      this.ledger.append({ at: this.now(), type: "session.closed", sessionId: live.session?.id ?? "?", reason, usageSeconds: usage });
      this.live = undefined;
      this.delegator?.dispose();
      this.delegator = undefined;
      this.transcript.finalizeOpen();
      if (this.wantAwake && (reason === "expired" || reason === "connection_lost")) {
        this.toast(reason === "expired" ? "session expired; reconnecting" : "connection lost; reconnecting", "warn");
        setTimeout(() => void this.wake(`reconnect after ${reason}`), 500);
      } else {
        this.setPhase("asleep");
      }
    });
  }

  async sleep(): Promise<void> {
    this.wantAwake = false;
    await this.delegator?.cancel("going to sleep");
    this.live?.close();
    this.flushSpeaker();
    this.setPhase("asleep");
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) this.live?.mute();
    else this.live?.unmute();
    this.recomputePhase();
  }

  /** Mic PCM16 mono 24 kHz. */
  feedMic(pcm: Buffer): void {
    if (this.muted) return;
    this.live?.appendAudio(pcm);
  }

  /** App-measured mic level, 0..1. */
  reportInputLevel(level: number): void {
    this.inputLevel = level;
  }

  /** Text Kevin typed in the Console. */
  sayText(text: string): void {
    const t = text.trim();
    if (!t || !this.live) return;
    this.lastAddressedAt = this.now();
    if (YES_PATTERN.test(t)) this.confirmations.arm();
    this.live.appendInstructions(null, `Kevin just typed (treat it exactly like speech): "${t}". Respond to it now; delegate if it asks for anything the backend does.`);
  }

  /**
   * Every Stop entry lands here — the Console's button and ⌘., the capsule's Stop,
   * ⌥⎋, the orb menu, `jarhead cmd stop`, and a spoken "stop" (the Delegator's
   * `onStop`, which runs after the fragment's other listeners so the gate set here
   * is not lifted by the words that asked for it). Within a frame or two
   * everything Kevin can perceive ends: the speaker is flushed and the voice gated
   * locally (Live cannot be interrupted), the running delegation is cancelled and
   * its brain turn interrupted, the hands' pending request is dropped so a late
   * answer never acts, background jobs this task started are stopped, the voice
   * is told once, and a toast says "stopped". The delegation's `finished` ledger
   * row (status cancelled, summary "Kevin pressed/said stop") is the record; with
   * nothing running there is nothing to record beyond the log line.
   */
  async stopEverything(source = "stop", how: "pressed" | "said" = "pressed"): Promise<void> {
    const t0 = this.now();
    const running = this.delegator?.active;
    const reason = `Kevin ${how} stop`;
    // The gate first, so a frame arriving between here and the flush is dropped too.
    this.outputGateUntil = t0 + Engine.OUTPUT_GATE_MS;
    this.gatedFrames = 0;
    this.flushSpeaker();
    const dropped = this.hands.cancelPending(reason);
    const aborted = this.runner.abortTask("stop");
    // The brain's own cancel may take a moment (SIGINT, an interrupt request); the
    // stop must not wait on it to be felt, so it is capped here. The delegator's own
    // word to the voice is skipped: the one instruction below speaks for the whole stop.
    const cancel = this.delegator?.cancel(reason, { quiet: true }) ?? Promise.resolve();
    this.live?.appendInstructions(null, `${reason}. Stop speaking now and wait.`);
    this.toast("stopped", "info");
    this.recomputePhase();
    await Promise.race([cancel, new Promise((r) => setTimeout(r, 1500))]);
    log.info(`stop (${source}) in ${this.now() - t0}ms: ${running ? `cancelled ${running.id}` : "nothing was running"}; ${dropped} hands request(s) dropped; ${aborted.jobs} background job(s) stopped; voice gated for ${Engine.OUTPUT_GATE_MS} ms`);
  }

  /** The gate ends early when Kevin speaks; the clock ends it otherwise. */
  private liftOutputGate(why: string): void {
    if (!this.outputGateUntil) return;
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

  // ------------------------------------------------------- pause / reflexes
  // Filled in by the reflex fan-out; stubs keep the contract compiling.

  async pause(): Promise<void> {
    log.info("pause (not implemented yet)");
  }

  async resume(): Promise<void> {
    log.info("resume (not implemented yet)");
  }

  /** On-device partial/final transcript from the app's ear (the reflex path). */
  ear(text: string, isFinal: boolean, segment: number, at: number): void {
    log.debug(`ear ${isFinal ? "final" : "partial"} #${segment} @${at}: ${text.slice(0, 80)}`);
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
        return this.stopEverything("stop command");
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
    this.closeConversations();
    await this.sleep();
    await this.brain?.stop();
    this.hands.stop();
  }

  // ----------------------------------------------------------------- state

  private onAction(a: ActionEvent): void {
    if (a.member === "mouse_move" && a.points) this.emit("overlay", { cmd: "point", x: a.points.x, y: a.points.y, ttlMs: 3000 });
    this.lastAddressedAt = this.now();
  }

  private tick(): void {
    // Speaking decays when the transcript stops arriving; levels alone lie (silence frames).
    this.recomputePhase();
    this.pruneMarks();
    const idleMs = this.settings.idleSleepMinutes * 60_000;
    if (this.live && this.live.currentState === "started" && !this.delegator?.active && idleMs > 0 && this.now() - this.lastAddressedAt > idleMs) {
      log.info(`idle for ${this.settings.idleSleepMinutes} min; sleeping`);
      this.toast("asleep — tap the orb to wake", "info");
      void this.sleep();
    }
    if (this.live) this.transcript.settle(this.live.nowMs);
    void this.pollPermissions();
    this.emit("event", { type: "levels", levels: this.levels() });
  }

  private levels(): AudioLevels {
    return { input: this.inputLevel, output: this.live ? this.outputLevel : 0 };
  }

  private recomputePhase(): void {
    if (!this.live) {
      if (this.phase !== "connecting" && this.phase !== "error") this.setPhase("asleep");
      return;
    }
    if (this.muted) return this.setPhase("muted");
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
      transcript: this.transcript.all().slice(-200),
      delegations: (this.delegator?.all() ?? this.pastDelegations()).slice(-50),
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
