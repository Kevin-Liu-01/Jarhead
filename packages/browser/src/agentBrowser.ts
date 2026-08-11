import { spawn } from "node:child_process";

/**
 * Typed wrapper around the `agent-browser` CLI.
 *
 * Built against the OBSERVED surface of agent-browser 0.32.3 on this machine
 * (2026-08-11, `agent-browser --help` plus live probes against a data: URL),
 * not the docs. What the probes showed:
 *
 *   agent-browser --session <s> --json open <url>
 *     → {"success":true,"data":{"title":"…","url":"…",…},"error":null}
 *   agent-browser --session <s> --json snapshot -i
 *     → data.refs  = {"e1":{"name":"Hi","role":"heading"},…}
 *       data.snapshot = "- heading \"Hi\" [level=1, ref=e1]\n…"
 *       data.origin = the page URL (there is no data.url on snapshot)
 *   agent-browser --session <s> --json read
 *     → data.content (readable text of the active tab), data.finalUrl,
 *       data.truncated
 *   agent-browser --json batch "open <url>" "snapshot -i" …
 *     → a JSON ARRAY of {command:[…],success,result,error}, NOT the single
 *       {success,data,error} envelope. Each batch argument is one shell-words
 *       string, so multi-word values need embedded double quotes — verified:
 *       'type @e1 "hello world"' typed the full phrase.
 *   failures → exit 1 and {"success":false,"data":null,"error":"Unknown ref: e99"}
 *
 * Batching matters because every invocation is a fresh CLI process (~200ms)
 * even though the browser itself persists in a daemon; the daemon only spares
 * us the Chrome launch, not the process spawn.
 */

export interface AgentBrowserOptions {
  /** Isolated agent-browser session so Jarvis never trips over another agent's tabs. */
  readonly session: string;
  readonly binary: string;
  /** Applied when a call does not pass its own timeout. First Chrome launch can take seconds. */
  readonly defaultTimeoutMs: number;
  /** Ceiling on extract/snapshot text so a heavy page cannot flood the model context. */
  readonly maxOutputChars: number;
}

export const DEFAULT_AGENT_BROWSER: AgentBrowserOptions = {
  session: "jarvis",
  binary: "agent-browser",
  defaultTimeoutMs: 20_000,
  maxOutputChars: 16_000,
};

export interface CallOptions {
  readonly timeoutMs?: number;
}

/**
 * Every method returns this instead of throwing. Browser automation fails
 * constantly (stale refs, slow pages, dead daemon) and the caller is a voice
 * assistant that must narrate the failure, not crash on it.
 */
export type BrowserResult<T> =
  | { readonly ok: true; readonly value: T; readonly ms: number }
  | { readonly ok: false; readonly error: string; readonly ms: number };

export interface OpenedPage {
  readonly url: string;
  readonly title: string;
}

export interface SnapshotRef {
  /** Always @-prefixed, ready to pass to click/type. */
  readonly ref: string;
  readonly role: string;
  readonly name: string;
}

export interface PageSnapshot {
  readonly url: string;
  readonly refs: readonly SnapshotRef[];
  /** The accessibility-tree text agent-browser prints, bounded. */
  readonly tree: string;
}

export interface Extraction {
  readonly instruction: string;
  readonly url: string;
  readonly content: string;
  readonly truncated: boolean;
}

export interface BatchStep {
  readonly command: string;
  readonly ok: boolean;
  readonly error: string | undefined;
}

export interface BatchOutcome {
  readonly steps: readonly BatchStep[];
  readonly failures: number;
}

/**
 * Commands are a closed union rather than raw strings so batch construction
 * is testable and a typo'd subcommand is a compile error, not a runtime one.
 */
export type BrowserCommand =
  | { readonly kind: "open"; readonly url: string }
  | { readonly kind: "click"; readonly ref: string }
  | { readonly kind: "type"; readonly ref: string; readonly text: string }
  | { readonly kind: "fill"; readonly ref: string; readonly text: string }
  | { readonly kind: "press"; readonly key: string }
  | { readonly kind: "wait"; readonly ms: number }
  | { readonly kind: "scroll"; readonly direction: "up" | "down" | "left" | "right"; readonly px?: number }
  | { readonly kind: "snapshot" };

/** Snapshot emits bare refs ("e1") but click/type expect "@e1". Accept either. */
export function normalizeRef(ref: string): string {
  return ref.startsWith("@") ? ref : `@${ref}`;
}

export function commandToArgv(cmd: BrowserCommand): string[] {
  switch (cmd.kind) {
    case "open":
      return ["open", cmd.url];
    case "click":
      return ["click", normalizeRef(cmd.ref)];
    case "type":
      return ["type", normalizeRef(cmd.ref), cmd.text];
    case "fill":
      return ["fill", normalizeRef(cmd.ref), cmd.text];
    case "press":
      return ["press", cmd.key];
    case "wait":
      return ["wait", String(cmd.ms)];
    case "scroll":
      return cmd.px === undefined ? ["scroll", cmd.direction] : ["scroll", cmd.direction, String(cmd.px)];
    case "snapshot":
      return ["snapshot", "-i"];
  }
}

/**
 * Join an argv into ONE batch argument string. The quoting here is for
 * agent-browser's internal shell-words parser, not for a shell — we spawn
 * without one. Verified: batch 'type @e1 "hello world"' types the full phrase.
 */
export function toBatchString(argv: readonly string[]): string {
  return argv
    .map((word) =>
      /[\s"'\\]/.test(word) || word.length === 0
        ? `"${word.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
        : word,
    )
    .join(" ");
}

/** Global flags go before the subcommand; that is the order every help example uses. */
export function buildArgs(session: string, command: readonly string[]): string[] {
  return ["--session", session, "--json", ...command];
}

function excerpt(text: string, max = 200): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export type ParsedEnvelope =
  | { readonly ok: true; readonly data: Record<string, unknown> }
  | { readonly ok: false; readonly error: string };

export function parseSingleEnvelope(stdout: string): ParsedEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, error: `agent-browser returned non-JSON output: ${excerpt(stdout)}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: `agent-browser returned an unexpected shape: ${excerpt(stdout)}` };
  }
  const env = parsed as { success?: unknown; data?: unknown; error?: unknown };
  if (env.success !== true) {
    return {
      ok: false,
      error: str(env.error) ?? "agent-browser reported failure without a message",
    };
  }
  const data = env.data;
  return {
    ok: true,
    data: typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {},
  };
}

export type ParsedBatch =
  | { readonly ok: true; readonly steps: readonly BatchStep[] }
  | { readonly ok: false; readonly error: string };

export function parseBatchEnvelope(stdout: string): ParsedBatch {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, error: `agent-browser batch returned non-JSON output: ${excerpt(stdout)}` };
  }
  if (!Array.isArray(parsed)) {
    // A batch that dies before running (bad session, daemon gone) falls back
    // to the single {success:false,…} envelope; surface its error message.
    const single = parseSingleEnvelope(stdout);
    return single.ok
      ? { ok: false, error: "agent-browser batch returned a non-array result" }
      : { ok: false, error: single.error };
  }
  const steps: BatchStep[] = parsed.map((entry) => {
    const e = (typeof entry === "object" && entry !== null ? entry : {}) as {
      command?: unknown;
      success?: unknown;
      error?: unknown;
    };
    return {
      command: Array.isArray(e.command) ? e.command.map(String).join(" ") : "(unknown)",
      ok: e.success === true,
      error: str(e.error),
    };
  });
  return { ok: true, steps };
}

function refNumber(ref: string): number {
  const m = /(\d+)/.exec(ref);
  return m?.[1] ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

export function parseSnapshotData(data: Record<string, unknown>): PageSnapshot {
  const refs: SnapshotRef[] = [];
  const raw = data["refs"];
  if (typeof raw === "object" && raw !== null) {
    for (const [ref, info] of Object.entries(raw as Record<string, unknown>)) {
      const o = typeof info === "object" && info !== null ? (info as Record<string, unknown>) : {};
      refs.push({ ref: normalizeRef(ref), role: str(o["role"]) ?? "", name: str(o["name"]) ?? "" });
    }
  }
  // Object key order is not a contract; refs must come back in page order.
  refs.sort((a, b) => refNumber(a.ref) - refNumber(b.ref));
  return {
    // Snapshot reports the page URL as `origin`, unlike every other command.
    url: str(data["origin"]) ?? str(data["url"]) ?? "",
    refs,
    tree: str(data["snapshot"]) ?? "",
  };
}

interface CliRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly spawnError: string | undefined;
}

/**
 * Spawn with a hard kill timer, always. The mic taught this repo that a child
 * process which "cannot fail" can still hang forever (ffmpeg on a missing TCC
 * grant); agent-browser launching Chrome for the first time is exactly the
 * kind of slow, opaque startup that must never wedge a caller.
 */
function runCli(binary: string, args: readonly string[], timeoutMs: number): Promise<CliRun> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawnError: string | undefined;

    const guard = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (e) => {
      spawnError = e.message;
    });
    // Node emits 'close' even after a spawn 'error', so this always settles.
    child.on("close", () => {
      clearTimeout(guard);
      resolve({ stdout, stderr, timedOut, spawnError });
    });
  });
}

export class AgentBrowser {
  private readonly opts: AgentBrowserOptions;

  constructor(overrides: Partial<AgentBrowserOptions> = {}) {
    this.opts = { ...DEFAULT_AGENT_BROWSER, ...overrides };
  }

  private async call(
    command: readonly string[],
    opts: CallOptions,
  ): Promise<BrowserResult<Record<string, unknown>>> {
    const startedAt = Date.now();
    const timeoutMs = opts.timeoutMs ?? this.opts.defaultTimeoutMs;
    const run = await runCli(this.opts.binary, buildArgs(this.opts.session, command), timeoutMs);
    const ms = Date.now() - startedAt;

    const guardError = this.guard(run, command, timeoutMs);
    if (guardError !== undefined) return { ok: false, error: guardError, ms };

    const parsed = parseSingleEnvelope(run.stdout);
    if (!parsed.ok) {
      const detail = run.stdout.trim() === "" && run.stderr.trim() !== "" ? ` (stderr: ${excerpt(run.stderr)})` : "";
      return { ok: false, error: `${parsed.error}${detail}`, ms };
    }
    return { ok: true, value: parsed.data, ms };
  }

  private guard(run: CliRun, command: readonly string[], timeoutMs: number): string | undefined {
    if (run.spawnError !== undefined) {
      return run.spawnError.includes("ENOENT")
        ? "`agent-browser` is not on PATH. Install it (`brew install agent-browser`) — or check detectBrowserTools() before routing here."
        : `agent-browser failed to start: ${run.spawnError}`;
    }
    if (run.timedOut) {
      return (
        `agent-browser ${command[0] ?? ""} timed out after ${timeoutMs}ms and was killed. ` +
        `Chrome may still be launching; retry with a longer timeout or run \`agent-browser doctor\`.`
      );
    }
    return undefined;
  }

  async open(url: string, opts: CallOptions = {}): Promise<BrowserResult<OpenedPage>> {
    const res = await this.call(["open", url], opts);
    if (!res.ok) return res;
    return {
      ok: true,
      ms: res.ms,
      value: { url: str(res.value["url"]) ?? url, title: str(res.value["title"]) ?? "" },
    };
  }

  /** Interactive elements only (`-i`): the full tree on a real page is thousands of lines. */
  async snapshot(opts: CallOptions = {}): Promise<BrowserResult<PageSnapshot>> {
    const res = await this.call(["snapshot", "-i"], opts);
    if (!res.ok) return res;
    const snap = parseSnapshotData(res.value);
    return {
      ok: true,
      ms: res.ms,
      value: { ...snap, tree: snap.tree.slice(0, this.opts.maxOutputChars) },
    };
  }

  async click(ref: string, opts: CallOptions = {}): Promise<BrowserResult<{ clicked: string }>> {
    const target = normalizeRef(ref);
    const res = await this.call(["click", target], opts);
    if (!res.ok) return res;
    return { ok: true, ms: res.ms, value: { clicked: str(res.value["clicked"]) ?? target } };
  }

  async type(ref: string, text: string, opts: CallOptions = {}): Promise<BrowserResult<{ typed: string }>> {
    const res = await this.call(["type", normalizeRef(ref), text], opts);
    if (!res.ok) return res;
    return { ok: true, ms: res.ms, value: { typed: str(res.value["typed"]) ?? text } };
  }

  /**
   * Readable text of the active tab, labeled with the caller's instruction.
   *
   * No model runs in here on purpose: agent-browser's only in-CLI intelligence
   * (`chat`) needs a Vercel AI Gateway key this machine does not have, and
   * Jarvis already has a model in the loop. So "extract" means: hand the
   * Brain bounded page text plus the instruction and let it do the reading.
   */
  async extract(instruction: string, opts: CallOptions = {}): Promise<BrowserResult<Extraction>> {
    const res = await this.call(["read"], opts);
    if (!res.ok) return res;
    const full = str(res.value["content"]) ?? "";
    return {
      ok: true,
      ms: res.ms,
      value: {
        instruction,
        url: str(res.value["finalUrl"]) ?? str(res.value["url"]) ?? "",
        content: full.slice(0, this.opts.maxOutputChars),
        truncated: res.value["truncated"] === true || full.length > this.opts.maxOutputChars,
      },
    };
  }

  /**
   * Run several commands in ONE process invocation. Process startup is the
   * dominant per-command cost, so a login flow should be one batch, not five
   * calls. Without --bail, agent-browser keeps going after a failed step;
   * the per-step results say which ones landed.
   */
  async batch(commands: readonly BrowserCommand[], opts: CallOptions = {}): Promise<BrowserResult<BatchOutcome>> {
    if (commands.length === 0) return { ok: false, error: "batch called with no commands", ms: 0 };
    const startedAt = Date.now();
    const timeoutMs = opts.timeoutMs ?? this.opts.defaultTimeoutMs;
    const strings = commands.map((c) => toBatchString(commandToArgv(c)));
    const run = await runCli(this.opts.binary, buildArgs(this.opts.session, ["batch", ...strings]), timeoutMs);
    const ms = Date.now() - startedAt;

    const guardError = this.guard(run, ["batch"], timeoutMs);
    if (guardError !== undefined) return { ok: false, error: guardError, ms };

    const parsed = parseBatchEnvelope(run.stdout);
    if (!parsed.ok) return { ok: false, error: parsed.error, ms };
    return {
      ok: true,
      ms,
      value: { steps: parsed.steps, failures: parsed.steps.filter((s) => !s.ok).length },
    };
  }

  /** Close this session's browser so a research errand doesn't leave Chrome resident. */
  async close(opts: CallOptions = {}): Promise<BrowserResult<Record<string, unknown>>> {
    return this.call(["close"], opts);
  }
}
