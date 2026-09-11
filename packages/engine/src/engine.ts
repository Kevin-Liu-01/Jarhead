import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeEnvSecrets, secretsPresent, Ledger, logger, readConfig, type JarheadConfig } from "@jarhead/core";
import { LiveSession, Transcript, buildLiveInstructions, type SessionConfig } from "@jarhead/live";
import { ComputerToolset, ConfirmationState, NativeHandsProcess, YES_PATTERN, type ActionEvent } from "@jarhead/hands";
import { AgentRegistry, defaultConnectors, type AgentConnector } from "@jarhead/agents";
import { ClaudeBrain, Delegator, ResponsesBrain, ToolRunner, responsesDelegationConfig, type Brain } from "@jarhead/brain";
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
}

export interface EngineOptions {
  readonly config?: JarheadConfig;
  readonly connectors?: readonly AgentConnector[];
  /** Test seams. */
  readonly makeLive?: (config: SessionConfig) => LiveSession;
  readonly brain?: Brain;
  readonly now?: () => number;
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
    this.hands = new NativeHandsProcess({ binPath: this.config.handsBin });
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
    this.runner = new ToolRunner({ toolset: this.toolset, agents: this.agents, stateDir: this.config.stateDir });
    this.transcript.onChange((item, kind) => {
      if (kind === "final") {
        this.ledger.append({ at: item.at, type: item.speaker === "kevin" ? "heard" : "said", item });
        this.emit("utterance", item);
      }
      this.scheduleSnapshot();
    });
  }

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
      brainDetail: this.brainDetail,
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
    const delegator = new Delegator({ live, transcript: this.transcript, brain: this.brainProxy, confirmations: this.confirmations, ledger: this.ledger, now: this.now });
    delegator.on("change", () => this.scheduleSnapshot());
    delegator.on("phase", () => this.recomputePhase());
    delegator.on("cancelled", () => this.flushSpeaker());
    this.delegator = delegator;

    live.on("audio", (pcm) => {
      this.outputLevel = rms(pcm);
      this.emit("audio", pcm);
    });
    live.on("inputTranscript", (delta, s, e) => {
      this.transcript.push({ speaker: "kevin", delta, startMs: s, endMs: e });
    });
    live.on("outputTranscript", (delta, s, e) => {
      this.transcript.push({ speaker: "jarhead", delta, startMs: s, endMs: e });
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

  async stopEverything(): Promise<void> {
    this.flushSpeaker();
    await this.delegator?.cancel("stopped from the console");
    this.live?.appendInstructions(null, "Kevin pressed stop. Stop speaking now and wait.");
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
        return this.stopEverything();
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
    if (this.now() - this.lastOutputSpeechAt < 1200) return this.setPhase("speaking");
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
      handsReady: this.hands.ready || this.hands.available,
    };
  }

  private lastDelegations: readonly Delegation[] = [];

  private pastDelegations(): readonly Delegation[] {
    return this.lastDelegations;
  }

  get brainInfo(): { kind: string; ready: boolean; detail: string } {
    return { kind: this.brain?.kind ?? "none", ready: this.brainReady, detail: this.brainDetail };
  }
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
