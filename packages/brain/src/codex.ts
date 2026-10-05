import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LineSplitter, REPO_ROOT, logger } from "@jarhead/core";
import { DaemonClient, DaemonServer, type ToolHost } from "@jarhead/daemon";
import { SECRET_KEYS, type Effort } from "@jarhead/protocol";
import type { Brain, BrainAttachment, BrainResult, BrainSink, BrainTask } from "./brain.ts";
import { SYSTEM_PROMPT_VERSION, brainSystemPrompt } from "./brain.ts";
import { delegationPrompt } from "./anthropic.ts";
import { progressLine } from "./responses.ts";
import type { ToolRunner } from "./runner.ts";
import { CODEX_MCP_SERVER, codexBuiltinsOffArgs, codexMcpConfigArgs, codexPromptTrimArgs, prepareCodexHome, toml, type CodexHome } from "./codex-config.ts";
import { codexModel } from "./models.ts";
import { CodexAppServer, type AppServerItem, type TurnResult, type UserInput } from "./codex-app-server.ts";

export { CODEX_MCP_SERVER } from "./codex-config.ts";

/**
 * The Codex brain: the Codex CLI (`codex exec`) on Kevin's ChatGPT login, with
 * Jarhead's tools mounted as an MCP server.
 *
 * Kevin uses Codex Desktop, which ships inside ChatGPT.app; the CLI binary sits
 * in its Resources folder and is not on PATH, so the finder below looks there
 * after JARHEAD_CODEX_BIN and PATH. Auth is whatever ~/.codex/auth.json holds
 * (a ChatGPT login, or an API key from `codex login --with-api-key`).
 *
 * Two transports, one brain. The warm one is a resident `codex app-server`
 * (`codex-app-server.ts`): started with the brain, one ephemeral thread that
 * lives across delegations — so "do it again" means something and the MCP bridge
 * is already up when a task arrives — each delegation one `turn/start`, a stop
 * one `turn/interrupt`, and a fresh thread once the context grows past its
 * rollover point (the last exchanges carried over as text). When the app-server
 * cannot start or dies, each delegation is one `codex exec --json --ephemeral`
 * run instead: the prompt on stdin, JSONL events on stdout, nothing left on
 * disk. The app-server's start never sits on a task's path: start() waits a
 * short patience window for it and reports "still starting" otherwise, a task
 * that arrives before it is up runs on exec, and a failed start is retried in
 * the background a minute later. `detail` says which transport is live and why.
 *
 * Either way Codex runs in its read-only sandbox with its own shell, image reader
 * and plugin runtime switched off (`codexBuiltinsOffArgs`: the sandbox stops
 * writes, not reads, and the plugin runtime binds his ChatGPT connectors) and
 * Kevin's own MCP servers off (`--ignore-user-config` for exec; per-server
 * `enabled=false` for the app-server, which has no such flag). His config.toml
 * enables Codex's own computer-use, browser and REPL servers, which would let it
 * act on the Mac and on his accounts around Jarhead's policy. So the only way it
 * can read or act is through
 * the `jarhead` MCP server (`mcp-bridge.ts`), whose calls land in the same
 * ToolRunner as every other brain: policy, ledger, screenshot archive,
 * confirmation handshake included. A call to any other MCP server, or a command
 * of Codex's own shell, fails the turn outright: the runner lets go at once,
 * nothing more of that turn reaches the timeline, and the warm thread that saw it
 * is retired. The bridge reaches the runner over the daemon socket when the daemon
 * is this process; otherwise (`jarhead live` / `probe`, or another Jarhead on the
 * default path) the brain serves a socket of its own. Jarhead's secrets never
 * enter Codex's environment.
 */

const log = logger("brain.codex");

// ----------------------------------------------------------------- finding it

export interface CodexBinary {
  readonly path: string;
  readonly source: "env" | "path" | "bundle";
  /** Where it came from, for humans: "ChatGPT.app", "Codex.app", "PATH", "JARHEAD_CODEX_BIN". */
  readonly label: string;
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function labelFor(p: string, fallback: string): string {
  if (/ChatGPT\.app\//.test(p)) return "ChatGPT.app";
  if (/Codex\.app\//.test(p)) return "Codex.app";
  return fallback;
}

/** The desktop apps that bundle the CLI, system-wide and per-user. */
export function codexBundleCandidates(home: string): string[] {
  return ["/Applications", join(home, "Applications")].flatMap((apps) => [join(apps, "ChatGPT.app/Contents/Resources/codex"), join(apps, "Codex.app/Contents/Resources/codex")]);
}

export interface FindCodexOptions {
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** The bundled copies to look for after PATH; tests pass their own so the real /Applications stays out. */
  readonly bundles?: readonly string[] | undefined;
}

/**
 * JARHEAD_CODEX_BIN → PATH → the ChatGPT.app / Codex.app bundles. An explicit
 * override that is not executable is a definite answer, not a reason to search.
 */
export function findCodexBinary(explicit?: string | undefined, opts: FindCodexOptions = {}): CodexBinary | undefined {
  const env = opts.env ?? process.env;
  if (explicit) return isExecutable(explicit) ? { path: explicit, source: "env", label: labelFor(explicit, "JARHEAD_CODEX_BIN") } : undefined;
  for (const dir of (env["PATH"] ?? "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, "codex");
    if (isExecutable(p)) return { path: p, source: "path", label: labelFor(p, "PATH") };
  }
  const bundles = opts.bundles ?? codexBundleCandidates(env["HOME"] || homedir());
  for (const p of bundles) if (isExecutable(p)) return { path: p, source: "bundle", label: labelFor(p, "app bundle") };
  return undefined;
}

/** Codex's own convention: $CODEX_HOME, else ~/.codex. */
export function codexHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env["CODEX_HOME"] || join(env["HOME"] || homedir(), ".codex");
}

interface AuthFile {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: { access_token?: string | null; refresh_token?: string | null } | null;
}

function readAuth(codexHome: string): AuthFile | undefined {
  try {
    return JSON.parse(readFileSync(join(codexHome, "auth.json"), "utf8")) as AuthFile;
  } catch {
    return undefined;
  }
}

/** A JWT's `exp` in ms, when the token is one (ChatGPT access tokens are); undefined otherwise. Reads the claim only, never a signature. */
function jwtExpiryMs(token: string | null | undefined): number | undefined {
  const payload = typeof token === "string" ? token.split(".")[1] : undefined;
  if (!payload) return undefined;
  try {
    const exp = (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown }).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Logins the server refused at run time (a 401, "token has expired", "could not
 * be refreshed"), by auth.json's real path, with the file's mtime and size then.
 * auth.json alone cannot say a refresh token died, so the refusal is the proof;
 * it holds until the file changes (Codex refreshed, or a new sign-in). This
 * process only: a restarted daemon tries once more and learns it again.
 */
const refusedLogins = new Map<string, { mtimeMs: number; size: number }>();

/** auth.json's real path (Jarhead's private home links it to the user's) and its stat, or undefined. */
function authFileStat(codexHome: string): { path: string; mtimeMs: number; size: number } | undefined {
  try {
    const path = realpathSync(join(codexHome, "auth.json"));
    const st = statSync(path);
    return { path, mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return undefined;
  }
}

/** A turn failed on the login itself: the next probe of this auth.json says signed out until the file changes. */
export function markCodexLoginRefused(codexHome: string): void {
  const st = authFileStat(codexHome);
  if (st) refusedLogins.set(st.path, { mtimeMs: st.mtimeMs, size: st.size });
}

/**
 * A Codex error that is about the login, not the task: the backend's 401 and Codex's
 * own words for a refresh that failed ("…could not be refreshed… Please log out and
 * sign in again"). Narrow on purpose: a match reads the login as signed out until
 * auth.json changes, so a bare "401" from some tool must not count.
 */
export const CODEX_AUTH_FAILURE = /\b401 Unauthorized\b|authentication token has expired|could not be refreshed|sign(?:ing)? in again|not logged in/i;

/**
 * Why this login cannot work, or undefined while it may: the server refused this
 * very auth.json at run time, or its access token has expired with no refresh
 * token to renew it. An expired access token beside a refresh token is Codex's
 * to renew (it does on the next request), so that is not "expired" here.
 */
export function codexLoginExpired(codexHome: string = codexHomeDir(), now = Date.now()): string | undefined {
  const st = authFileStat(codexHome);
  const refused = st ? refusedLogins.get(st.path) : undefined;
  if (refused && st && refused.mtimeMs === st.mtimeMs && refused.size === st.size) return "its login was refused";
  const auth = readAuth(codexHome);
  const tokens = auth?.tokens;
  if (!tokens || auth?.OPENAI_API_KEY || tokens.refresh_token) return undefined;
  const exp = jwtExpiryMs(tokens.access_token);
  return exp !== undefined && exp <= now ? "its login has expired" : undefined;
}

/** auth.json says yes/no (an expired login is a no); undefined when there is no readable file (then `codex login status` decides). Never returns a token. */
export function codexSignedIn(codexHome: string = codexHomeDir()): boolean | undefined {
  const auth = readAuth(codexHome);
  if (!auth) return undefined;
  if (codexLoginExpired(codexHome)) return false;
  return Boolean(auth.tokens?.access_token || auth.tokens?.refresh_token || auth.OPENAI_API_KEY);
}

/** The `model = "…"` at the top of ~/.codex/config.toml, if any: what Codex itself would run. */
export function codexConfigModel(codexHome: string = codexHomeDir()): string | undefined {
  try {
    const text = readFileSync(join(codexHome, "config.toml"), "utf8");
    const top = text.split(/^\s*\[/m)[0] ?? "";
    return /^\s*model\s*=\s*"([^"]+)"/m.exec(top)?.[1];
  } catch {
    return undefined;
  }
}

/**
 * The environment Codex runs in. Jarhead's secrets (SECRET_KEYS: the voice's
 * OPENAI_API_KEY, ANTHROPIC_API_KEY, JARHEAD_BRAIN_API_KEY) sit in the daemon's
 * environment and would otherwise reach Codex's sandboxed shell (`env` works in
 * read-only) and, through Codex, the bridge. None of them is Codex's business:
 * this brain runs on Kevin's ChatGPT login, and an OPENAI_API_KEY is one of the
 * ways Codex authenticates, so the voice key in particular must not be there (a
 * key he gave Codex itself via `codex login --with-api-key` lives in auth.json
 * and still counts). CODEX_HOME is pinned so probe and run agree.
 */
export function codexEnv(env: NodeJS.ProcessEnv, codexHome: string): NodeJS.ProcessEnv {
  const rest: NodeJS.ProcessEnv = { ...env };
  for (const key of SECRET_KEYS) delete rest[key];
  return { ...rest, CODEX_HOME: codexHome };
}

function run(cmd: string, args: readonly string[], opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
  return new Promise((resolve) => {
    execFile(cmd, [...args], { env: opts.env ?? process.env, timeout: opts.timeoutMs ?? 8000, maxBuffer: 256 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr), ...(err ? { error: err.message } : {}) });
    });
  });
}

export interface CodexProbe {
  readonly bin: CodexBinary | undefined;
  /** "0.153.4" */
  readonly version: string | undefined;
  readonly signedIn: boolean;
  /** "chatgpt" | "apikey" | … from auth.json, when known. */
  readonly authMode: string | undefined;
  /** The desktop app's app-server has its IPC socket up. */
  readonly desktopRunning: boolean;
  /** The model Codex's own config names, when brainModel is empty. */
  readonly configModel: string | undefined;
  /** One human line: what was found, or what is missing. */
  readonly detail: string;
}

export interface CodexProbeOptions extends FindCodexOptions {
  /** JARHEAD_CODEX_BIN. */
  readonly bin?: string | undefined;
  readonly codexHome?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

/**
 * Binary, version, login, desktop app: the facts the engine's `auto`, the
 * brain's start() and the doctor all need, gathered once (about 40 ms).
 */
export async function probeCodex(opts: CodexProbeOptions = {}): Promise<CodexProbe> {
  const env = opts.env ?? process.env;
  const codexHome = opts.codexHome ?? codexHomeDir(env);
  const childEnv = codexEnv(env, codexHome);
  const desktopRunning = existsSync(join(codexHome, "ipc", "ipc.sock"));
  const configModel = codexConfigModel(codexHome);
  const bin = findCodexBinary(opts.bin, { env, bundles: opts.bundles });
  const base = { version: undefined, signedIn: false, authMode: undefined, desktopRunning, configModel };
  if (!bin) {
    return {
      ...base,
      bin: undefined,
      detail: opts.bin ? `JARHEAD_CODEX_BIN=${opts.bin} is not an executable file` : "no codex binary on PATH or in ChatGPT.app / Codex.app (install Codex Desktop, or set JARHEAD_CODEX_BIN)",
    };
  }
  const v = await run(bin.path, ["--version"], { env: childEnv, timeoutMs: opts.timeoutMs ?? 8000 });
  const version = v.ok ? v.stdout.trim().replace(/^codex(?:-cli)?\s+/i, "") || undefined : undefined;
  if (!version) return { ...base, bin, detail: `${bin.path} did not answer --version${v.error ? ` (${v.error.split("\n")[0]})` : ""}` };
  const auth = readAuth(codexHome);
  let signedIn = codexSignedIn(codexHome);
  if (signedIn === undefined) {
    const st = await run(bin.path, ["login", "status"], { env: childEnv, timeoutMs: opts.timeoutMs ?? 8000 });
    const out = `${st.stdout}\n${st.stderr}`;
    signedIn = st.ok && /logged in/i.test(out) && !/not logged in/i.test(out);
  }
  const authMode = auth?.auth_mode;
  const where = `Codex ${version} via ${bin.label}`;
  const expired = signedIn ? undefined : codexLoginExpired(codexHome);
  const detail = signedIn
    ? `${where}, signed in${authMode === "chatgpt" ? " with ChatGPT" : authMode ? ` (${authMode})` : ""}${desktopRunning ? ", desktop app running" : ""}`
    : expired
      ? `${where} is signed out: ${expired}. Sign in to Codex in ChatGPT or run \`codex login\``
      : `${where} is not signed in; sign in to Codex in ChatGPT or run \`codex login\``;
  return { ...base, bin, version, signedIn, authMode, detail };
}

// --------------------------------------------------------------- the command

/** Jarhead's effort scale → Codex's `model_reasoning_effort` values. */
export function codexEffort(effort: Effort): "low" | "medium" | "high" | "xhigh" {
  return effort === "max" ? "xhigh" : effort;
}

export interface CodexExecOptions {
  readonly cwd: string;
  readonly model?: string | undefined;
  readonly effort?: Effort | undefined;
  /** The node that runs the bridge (the daemon's own, by default). */
  readonly node: string;
  readonly tsxCli: string;
  readonly bridgePath: string;
  /** Where the bridge's tool.run messages go. */
  readonly socketPath: string;
  /** MCP server start / per-tool budgets, in seconds. */
  readonly startupTimeoutSec?: number | undefined;
  readonly toolTimeoutSec?: number | undefined;
  /** PNGs attached to the prompt with `-i` (the regions Kevin circled). */
  readonly images?: readonly string[] | undefined;
  /** `-c service_tier=…`; unset = the config's. */
  readonly serviceTier?: string | undefined;
  /** Switch off the coding-session prompt blocks (default true; see codexPromptTrimArgs). */
  readonly trimPrompt?: boolean | undefined;
  /** A thread's brain: its bridge stamps every tool.run with this id (env JARHEAD_THREAD), so the daemon routes to that thread's lane. */
  readonly thread?: string | undefined;
  /** The user's name for the bridge's env (JARHEAD_USER_NAME): the tool descriptions Codex reads say it. */
  readonly userName?: string | undefined;
}

/** The argv of one delegation; the prompt itself arrives on stdin (`-`). */
export function codexExecArgs(o: CodexExecOptions): string[] {
  return [
    "exec",
    "--json",
    // Nothing on disk: these turns are Jarhead's, not entries in Kevin's Codex history.
    "--ephemeral",
    // Read-only stops writes, not reads of the secret stores: Codex's own shell and image
    // reader are switched off below. Reading and acting are the jarhead tools' job.
    "-s",
    "read-only",
    "--skip-git-repo-check",
    // Kevin's config.toml wires Codex's own computer-use, browser and REPL servers;
    // loaded, they would act on the Mac around Jarhead's policy. Auth still comes from CODEX_HOME.
    "--ignore-user-config",
    // `-i <FILE>...` is variadic; one flag per file, and a flag always follows, so it never swallows the `-`.
    ...(o.images ?? []).flatMap((p) => ["-i", p]),
    ...(o.model ? ["-m", o.model] : []),
    ...(o.effort ? ["-c", `model_reasoning_effort=${toml(codexEffort(o.effort))}`] : []),
    ...codexBuiltinsOffArgs(),
    ...codexMcpConfigArgs(o),
    // --ignore-user-config skips the CODEX_HOME config.toml, so the prompt trims and the tier ride the argv here too.
    ...(o.trimPrompt === false ? [] : codexPromptTrimArgs()),
    ...(o.serviceTier ? ["-c", `service_tier=${toml(o.serviceTier)}`] : []),
    "-C",
    o.cwd,
    "-",
  ];
}

/**
 * Jarhead's own base prompt for the app-server thread (`thread/start.baseInstructions`),
 * in place of Codex's coding-agent text. That text tells the model to "start with a
 * message in the commentary channel" when a request needs tools — measured as a
 * 4.4 s narration generation (median) before the first tool call — and spends
 * ~5.6k tokens on patches, PR descriptions, plans, skills and plugins. Code mode's
 * calling convention comes from the `exec` tool's own description, not from here.
 */
export function codexBaseInstructions(userName = "Kevin"): string {
  return `You are the brain of Jarhead, a voice assistant that uses ${userName}'s Mac for ${userName}. The developer message that follows holds your standing orders; obey it. You act through the jarhead tools, which you call through the exec function as \`await tools.mcp__jarhead__<name>({...})\`, and speed is the point: when a request needs a tool, your very first output is the tool call — no commentary message before it, no plan, no narration; Jarhead shows ${userName} every call as it happens and speaks for you. Write a message only as the final answer (one or two spoken sentences, plain words, no Markdown, no headings, no lists, no file links) or when a tool returned needs_confirmation, in which case the final answer is that one question. Keep reasoning short. Nothing here is a coding task: there is no repository, no patch to write, no tests to run, no skills, plugins or sub-agents to use, and you have no shell of your own; the jarhead tools are how you read and act on ${userName}'s Mac.`;
}

const QUESTION_START = /^(what|what's|whats|why|how|is|are|am|can|could|would|should|do|does|did|where|who|whose|which|when|will|tell me|explain|describe)\b/i;
const IMPERATIVE_VERBS = new Set([
  "open", "close", "quit", "click", "tap", "press", "type", "scroll", "search", "find", "look", "show", "hide", "switch", "go", "play", "pause", "stop", "mute", "unmute", "read", "copy", "paste", "save", "select", "focus", "launch", "start", "run", "zoom",
  "take", "screenshot", "minimize", "minimise", "maximize", "maximise", "move", "drag", "turn", "set", "toggle", "refresh", "reload", "navigate", "enter", "hit", "send", "delete", "undo", "redo", "cut", "dismiss", "cancel", "confirm", "check", "mark", "circle",
  "point", "highlight", "draw", "clear", "expand", "collapse", "create", "add", "remove", "insert", "pick", "choose", "bring", "put", "double", "right", "lower", "raise", "increase", "decrease", "volume", "fullscreen", "back", "forward", "next", "previous",
  "wait", "again", "repeat", "reply", "answer", "call", "text", "mail", "email", "message", "download", "upload", "install", "print", "rename", "sort", "filter", "resize", "snap", "arrange", "tile", "split", "empty", "trash", "eject", "restart", "log", "sign",
]);
const CONFIRMATION_WORDS = /^(yes|yeah|yep|yup|no|nope|ok|okay|sure|go ahead|do it|go for it|cancel|never mind|nevermind|stop)\b/i;

/**
 * A short imperative request — a few words, starting with a verb, not a question —
 * or a one-word answer to a confirmation: the kind of turn that never needed
 * medium reasoning. Used only when the simple-effort knob is set (opt-in A/B).
 */
export function isSimpleRequest(request: string): boolean {
  let text = request.trim().toLowerCase();
  text = text.replace(/^(hey|hi|ok|okay)?[\s,]*jar\s*head[\s,.!]*/i, "").replace(/^(please|now|just|can you|could you|would you)[\s,]+/i, "").replace(/[\s,]*(please|now|for me)[.!\s]*$/i, "");
  if (!text || text.includes("?")) return false;
  if (CONFIRMATION_WORDS.test(text)) return true;
  if (QUESTION_START.test(text)) return false;
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 7) return false;
  const first = (words[0] ?? "").replace(/[^a-z]/g, "");
  return IMPERATIVE_VERBS.has(first);
}

/** What the Codex brain adds to the shared standing orders. */
/** The author's wiki checkout, named in the addendum only while it exists on this Mac: a clone elsewhere gets no paragraph about it. */
const WIKI_ROOT = join(homedir(), "repos", "Kevin-Wiki-v3");
export function wikiRootHere(root = WIKI_ROOT): string | undefined {
  return existsSync(root) ? root : undefined;
}

export function codexAddendum(userName = "Kevin", wiki = wikiRootHere()): string {
  const wikiLine = wiki
    ? ` The wiki is ${wiki}; its pages are under ${wiki}/wiki, so a wiki search is one search_files call with root ${wiki}/wiki and glob "*.md", widened to the repo root only when that finds nothing.`
    : "";
  return `You are running as the Codex CLI with no project of ${userName}'s. Your own shell and file tools are switched off. Every read and every action on this Mac goes through the tools of the "${CODEX_MCP_SERVER}" MCP server: read_file, list_dir and search_files to read, run_shell to run a command, and the rest below. Jarhead's policy judges each call, so the secret stores stay refused. When any of them returns needs_confirmation, do not retry it and do not work around it: make your final answer the one-sentence question it asked and stop; ${userName} will answer out loud and you will be asked again with the same tool and exactly the same arguments.

Any AGENTS.md pointer index, skills catalog or multi-agent role text in your context is ${userName}'s Codex-app preset, not Jarhead's: do not load a wiki, its hub or its command index, run npm status, or read SKILL.md files unless the task is literally about them.${wikiLine}

The ${CODEX_MCP_SERVER} tools may reach you without descriptions or parameter schemas, so here they are; arguments are one JSON object, coordinates are pixels of the last screenshot.
Look: screenshot {quick?} (quick: a reduced-resolution shot; zoom for small text); zoom {region: [x0, y0, x1, y1]} a full-resolution crop; frontmost_app {} the front app and window, about 20 ms; list_windows {}; find_element {name, role?} a control on the front window by its label, with its centre; element_at {coordinate: [x, y]}; read_focused_text {} the focused field's text — fails in Chromium browsers, use browser_read there.
Act: left_click {coordinate: [x, y]} (also double_click, right_click); click_element {name, role?} clicks the one control with that label, no screenshot, and answers with what it clicked; type {text} into the focused element (OK means delivered, not which field); key {text: "Return" | "cmd+s" | "Escape", repeat?}; scroll {scroll_direction: "down", scroll_amount: 3, coordinate?}; open_app {name} answers with the app it opened; focus_app {name} only echoes the name, frontmost_app confirms; left_click_drag {start_coordinate, coordinate}; wait {duration}.
Browser pages in Safari, Chrome, Arc or Edge (Apple events, tens of milliseconds; never applescript for a page): browser_read {} the page as text; browser_find {text} an element and its bounds; browser_click {text} or {selector} for a link or button not on the screenshot (a visible one: left_click or click_element); browser_type {text, submit?} into the page's focused field; browser_navigate {url} answers "is loading", browser_read confirms the page; browser_tabs {}.
Files: read_file {path, offset?, limit?}; list_dir {path, depth?}; search_files {root, pattern, glob?} — a regular expression, (?i) accepted, case-insensitive when all lowercase, ripgrep when installed and otherwise a JavaScript regex walk (no PCRE-only syntax), at most 200 hits; edit_file {path, old, new}; write_file {path, content}.
Shell and web: run_shell {command, cwd?, background?, timeout?} is a login shell and slow (seconds); applescript {script} runs osascript, often seconds — never for the front app (frontmost_app) or a browser page (the browser tools); web_search {query}; web_fetch {url}; open_url {url}.
Voice and drawing: speak_progress {text} says one sentence now; show_circle {x, y, radius, label?}, show_arrow {from, to}, show_rect {rect: [x, y, w, h]}, show_text {x, y, text}, show_stroke {points}, show_clear {} draw fading shapes on ${userName}'s screen.
Agents and self: agents_list {}, agent_send {agent, text}, agent_read {agent}, agent_wait {agent, timeout?}, agent_start {tool, cwd, prompt}; self_edit {task}, self_review {id}, self_apply {id}, self_discard {id}, self_status {}.
Threads: thread_start {name, task, lane?, budget?} — one thread per independent app (background = Apple events/browser/files/shell/web only, screen = waits for the pointer), started in the same turn as your own first action; do not thread_wait: end your turn and Jarhead speaks their finish lines; thread_read {name}; thread_stop {name}. On a thread, speak_progress speaks once, with your name.
Automations: automation_set {name, when | on, then[1..3], clauses?, echo, recipeCommand?} arms one row the daemon carries out while Jarhead is asleep — say the echo line back; a run-recipe, press or wake-brain answers needs_confirmation once, and after ${userName}'s yes you call it again with exactly the same arguments; automation_list {state?}; automation_change {name, verb: snooze | done | skip | pause | resume | trash | restore | run, minutes?} — trash is Move to Trash, restorable, nothing is deleted; recipe_list {}.
Every acting tool answers with what is now in front, focused and under the pointer, read 150 ms after it landed: that line is your verification; screenshot only when it says something you did not expect.
Look-only tools may be awaited together in one exec (await Promise.all([...])); acting tools run in order and stop at the first needs_confirmation — the ones queued behind it answer "not run: … is waiting for ${userName}'s answer" and must not be retried.`;
}

// ------------------------------------------------------------ carried history

/**
 * What a fresh thread is told about the exchanges before it (REDESIGN §15's
 * `carryHistory`, compacted here). A thread that rolled over knows nothing; the
 * next turn carries the last exchanges as text so a "yes" still knows what it
 * confirms and "do it again" knows what "it" was. The block is bounded on
 * purpose: the fresh thread pays for it on every request until its own rollover,
 * and a tool result copied whole (a 3 KB page, a directory listing) would be the
 * old context smuggled back in. So: Kevin's words verbatim, always; the spoken
 * answers; and each tool result either as it was (short) or as one line naming
 * its size — Hermes' Phase-1 placeholders, OpenClaw's soft-trim, the same idea.
 */
export interface CarriedResult {
  readonly tool: string;
  /** The result's text (its text parts joined), kept up to CARRY_RESULT_KEEP_CHARS. */
  readonly text: string;
  /** The whole result's size in bytes as the model saw it — images and structured content included. */
  readonly bytes: number;
}

export interface CarriedExchange {
  readonly request: string;
  readonly answer: string;
  readonly results: readonly CarriedResult[];
}

/** A tool result longer than this — in text, or in bytes as the model saw it — is carried as a placeholder. */
export const CARRY_RESULT_MAX_CHARS = 200;
/** The carried block's budget in characters (~500 tokens). */
export const CARRY_MAX_CHARS = 2048;
/** How much of a result's text stays in memory per exchange; the placeholder names the true size. */
const CARRY_RESULT_KEEP_CHARS = 1200;
/** Results kept per exchange: the last ones, the state the answer was given from. */
const CARRY_RESULTS_PER_EXCHANGE = 6;
export const CARRY_HEADER = "Earlier in this session:";

/** "[tool result, 3.1 KB]" — one line in place of a result too long to carry. */
export function resultPlaceholder(bytes: number): string {
  const kb = Math.max(0, bytes) / 1024;
  return `[tool result, ${kb >= 10 ? String(Math.round(kb)) : kb.toFixed(1)} KB]`;
}

/** A finished MCP tool call as the history keeps it. */
export function carriedResult(tool: string, result: unknown): CarriedResult {
  const text = toolResultText(result);
  let bytes: number;
  try {
    bytes = Buffer.byteLength(typeof result === "string" ? result : JSON.stringify(result ?? ""), "utf8");
  } catch {
    bytes = Buffer.byteLength(text, "utf8");
  }
  return { tool, text: text.slice(0, CARRY_RESULT_KEEP_CHARS), bytes: Math.max(bytes, Buffer.byteLength(text, "utf8")) };
}

/** The text parts of an MCP result (`{content: [{type: "text", text}, …]}`), else the value's own text. */
function toolResultText(result: unknown): string {
  if (result === null || result === undefined) return "";
  if (typeof result === "string") return result;
  if (typeof result === "object") {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      return content
        .map((part) => (part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
        .filter(Boolean)
        .join("\n");
    }
    try {
      return JSON.stringify(result);
    } catch {
      return String(result);
    }
  }
  return String(result);
}

/**
 * One result as one carried line: verbatim when short, the placeholder otherwise —
 * or always the placeholder when `placeholder` is set (the newest exchange over
 * budget), still naming the result's true size. Never a newline.
 */
export function carriedResultLine(r: CarriedResult, placeholder = false): string {
  const short = !placeholder && r.bytes <= CARRY_RESULT_MAX_CHARS && r.text.length <= CARRY_RESULT_MAX_CHARS;
  const body = short ? r.text.replace(/\s*\n\s*/g, " ").trim() || "(empty)" : resultPlaceholder(r.bytes);
  return `  ${r.tool} → ${body}`;
}

/**
 * The carried block, newest exchange last, within `maxChars`: older exchanges are
 * dropped first (whole), then the newest exchange's result lines, then its answer
 * is cut; Kevin's own words are never cut — the newest request is always carried
 * whole. Undefined when there is nothing to carry.
 */
export function renderCarry(history: readonly CarriedExchange[], userName = "Kevin", maxChars = CARRY_MAX_CHARS): string | undefined {
  if (history.length === 0) return undefined;
  type Results = "verbatim" | "placeholders" | "none";
  const block = (h: CarriedExchange, results: Results, answer: string): string =>
    [`${userName} said: "${h.request}"`, ...(results === "none" ? [] : h.results.map((r) => carriedResultLine(r, results === "placeholders"))), `You answered: ${answer}`].join("\n");
  const newest = history[history.length - 1]!;
  let tail = block(newest, "verbatim", newest.answer);
  const budget = Math.max(0, maxChars - CARRY_HEADER.length - 1);
  if (tail.length > budget) {
    // Placeholders first (each naming its true size), then no result lines, then the answer cut to what is left; the request stands.
    tail = block(newest, "placeholders", newest.answer);
    if (tail.length > budget) tail = block(newest, "none", newest.answer);
    if (tail.length > budget) {
      const fixed = block(newest, "none", "").length;
      const room = budget - fixed - 1;
      tail = block(newest, "none", room > 0 ? `${newest.answer.slice(0, room)}…` : "…");
    }
  }
  const blocks = [tail];
  let used = tail.length;
  for (let i = history.length - 2; i >= 0; i--) {
    const b = block(history[i]!, "verbatim", history[i]!.answer);
    if (used + 1 + b.length > budget) break;
    blocks.unshift(b);
    used += 1 + b.length;
  }
  return [CARRY_HEADER, ...blocks].join("\n");
}

// ------------------------------------------------------------------ the brain

export interface CodexBrainOptions {
  readonly runner: ToolRunner;
  /** The daemon socket the bridge should call — used only when the daemon there is this very process; otherwise the brain serves its own. */
  readonly socketPath: string;
  readonly stateDir: string;
  /** The pid a daemon must report to be trusted with tool.run (default: this process). Tests pass another to stand in for a foreign daemon. */
  readonly ownPid?: number | undefined;
  /** From the engine, so the install is examined once; otherwise start() probes. */
  readonly probe?: CodexProbe | undefined;
  /** JARHEAD_CODEX_BIN. */
  readonly bin?: string | undefined;
  readonly codexHome?: string | undefined;
  /** Model override; empty = Codex's own default (config.toml's model, else the CLI's). */
  readonly model?: string | undefined;
  readonly effort?: Effort | undefined;
  readonly userName?: string | undefined;
  /** Jarhead tool calls per delegation before the brain gives up (default 40). */
  readonly maxSteps?: number | undefined;
  /** Wall clock per delegation (default 5 min). */
  readonly maxWallMs?: number | undefined;
  /** Request/answer pairs carried into the next delegation (default 3). */
  readonly historyTurns?: number | undefined;
  /** SIGINT → SIGKILL grace (default 3 s). */
  readonly killGraceMs?: number | undefined;
  readonly node?: string | undefined;
  readonly tsxCli?: string | undefined;
  readonly bridgePath?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  /**
   * Which Codex to drive: `auto` (default) tries the resident app-server and falls
   * back to `exec` per task when it cannot start; `app-server` / `exec` force one.
   */
  readonly transport?: "auto" | "app-server" | "exec" | undefined;
  /** initialize + thread/start budget for the app-server (default 25 s). */
  readonly appServerStartTimeoutMs?: number | undefined;
  /** How long start() waits for the app-server before reporting ready on exec with the warm start continuing in the background (default 4 s). */
  readonly appServerPatienceMs?: number | undefined;
  /** After a failed start or a crash, the warm transport is tried again this much later (default 60 s). */
  readonly appServerRetryMs?: number | undefined;
  /** Test seam for the app-server process. */
  readonly spawnImpl?: typeof spawn | undefined;
  /**
   * Per-turn effort A/B (opt-in): short imperative requests (`isSimpleRequest`) run
   * at this effort, everything else at `effort`. Default: env JARHEAD_CODEX_SIMPLE_EFFORT
   * (unset = off). Logged per turn as "effort low (simple: …)".
   */
  readonly simpleEffort?: Effort | undefined;
  /** Prime every fresh thread with one tiny background turn (default: on unless env JARHEAD_CODEX_PRIME is 0/false). */
  readonly primeThreads?: boolean | undefined;
  /** `-c service_tier=…` for both entry points (default: env JARHEAD_CODEX_SERVICE_TIER, else Kevin's config line). */
  readonly serviceTier?: string | undefined;
  /** Which base prompt the thread gets: Jarhead's (`codexBaseInstructions`, default) or Codex's own (env JARHEAD_CODEX_BASE=codex). */
  readonly baseInstructions?: "jarhead" | "codex" | undefined;
  /**
   * This brain is a spawned thread's (the engine's scheduler builds one per thread over
   * that thread's lane runner): the thread id rides to the bridge as JARHEAD_THREAD so the
   * daemon routes its tool calls to the right lane, and the Codex thread is never primed —
   * it runs one task and costs Kevin's plan nothing more.
   */
  readonly thread?: string | undefined;
}

/** One `codex exec --json` event, as far as this brain reads it. */
interface CodexEvent {
  type?: string;
  thread_id?: string;
  message?: string;
  error?: { message?: string } | string | null;
  item?: CodexItem;
}

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  summary?: string;
  message?: string;
  server?: string;
  tool?: string;
  arguments?: unknown;
  status?: string;
  error?: { message?: string } | string | null;
  command?: string | string[];
  exit_code?: number;
  aggregated_output?: string;
  result?: unknown;
}

interface RunState {
  readonly task: BrainTask;
  readonly sink: BrainSink;
  readonly child: ChildProcess;
  readonly started: number;
  /** The runner was let go (at the stop, when the brain failed the run, or when it settled): a late bridge call is refused. */
  released: boolean;
  /** The most recent agent_message; becomes the summary at turn.completed. */
  candidate: string | undefined;
  /** What Jarhead's tools returned this run, for the carried history (compacted there). */
  readonly results: CarriedResult[];
  steps: number;
  completed: boolean;
  failed: string | undefined;
  cancelled: boolean;
  stderr: string;
  resolve: (r: BrainResult) => void;
  timer: NodeJS.Timeout | undefined;
  killTimer: NodeJS.Timeout | undefined;
}

function errorMessage(e: CodexItem["error"] | undefined, fallback: string): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && typeof e.message === "string") return e.message;
  return fallback;
}

/** A turn on the resident app-server, as this brain tracks it. */
interface WarmTurn {
  readonly task: BrainTask;
  readonly sink: BrainSink;
  readonly started: number;
  /** The runner was let go (at the stop, when the brain failed the turn, or when it ended): a late bridge call is refused. */
  released: boolean;
  candidate: string | undefined;
  /** What Jarhead's tools returned this turn, for the carried history (compacted there). */
  readonly results: CarriedResult[];
  steps: number;
  /** Set when this brain asked for the interrupt itself (budget), so the result reads as failed, not cancelled. */
  failed: string | undefined;
  cancelled: boolean;
  /** Codex acted around Jarhead on this turn (its own shell, another MCP server): the thread's history holds what nothing redacted, so the thread is retired when the turn ends. */
  tainted: boolean;
  timer: NodeJS.Timeout | undefined;
}

/** The turn is over for Jarhead (a stop, or the brain failed it): nothing more of it reaches the sink. */
function turnOver(t: { failed: string | undefined; cancelled: boolean }): boolean {
  return t.failed !== undefined || t.cancelled;
}

export class CodexBrain implements Brain {
  readonly kind = "codex";
  private probe: CodexProbe | undefined;
  private ready = false;
  private readyDetail = "not started";
  private started = false;
  private current: RunState | undefined;
  private warm: WarmTurn | undefined;
  private history: CarriedExchange[] = [];
  private toolSocket: string | undefined;
  private privateServer: DaemonServer | undefined;
  private readonly model: string | undefined;
  private appServer: CodexAppServer | undefined;
  /** Which transport the next task takes. */
  private transport: "app-server" | "exec" = "exec";
  /** Why the app-server is not in use, for the detail line and the log. */
  private appServerFailure: string | undefined;
  private appServerRetryAt = 0;
  /** The warm start in flight, if any: never awaited by a task, only by start()'s patience window. */
  private appServerStarting: Promise<string> | undefined;
  /** The detail line up to the transport fragment; `detail` completes it with the transport's current state. */
  private baseDetail = "";
  /** The next warm turn carries the recent exchanges as text (a fresh thread knows nothing). */
  private carryHistory = false;
  /** Jarhead's own CODEX_HOME (or the source home when it could not be built); set by start(). */
  private home: CodexHome | undefined;

  constructor(private readonly opts: CodexBrainOptions) {
    this.probe = opts.probe;
    // The override alone; the config model joins it once the probe has read ~/.codex/config.toml.
    this.model = codexModel(opts.model, undefined);
  }

  /** Where Codex runs from: `<stateDir>/codex-home`, or Kevin's ~/.codex when that could not be built. */
  get codexHome(): CodexHome | undefined {
    return this.home;
  }

  /** The socket the bridge calls: the daemon's own, or this brain's private one (set by start(), cleared by stop()). */
  get toolSocketPath(): string | undefined {
    return this.toolSocket;
  }

  private env(): NodeJS.ProcessEnv {
    return this.opts.env ?? process.env;
  }

  /** The effort for short imperative turns, when the A/B knob is on. */
  private simpleEffort(): Effort | undefined {
    if (this.opts.simpleEffort) return this.opts.simpleEffort;
    const v = this.env()["JARHEAD_CODEX_SIMPLE_EFFORT"];
    return v === "low" || v === "medium" || v === "high" || v === "xhigh" || v === "max" ? v : undefined;
  }

  private primeThreads(): boolean {
    // A spawned thread's brain runs one task: a primer would be a paid request for nothing.
    if (this.opts.thread) return false;
    if (this.opts.primeThreads !== undefined) return this.opts.primeThreads;
    const v = (this.env()["JARHEAD_CODEX_PRIME"] ?? "").trim().toLowerCase();
    return !(v === "0" || v === "false" || v === "off" || v === "no");
  }

  private serviceTier(): string | undefined {
    return this.opts.serviceTier ?? (this.env()["JARHEAD_CODEX_SERVICE_TIER"]?.trim() || undefined);
  }

  /** The bridge's env (`codexMcpConfigArgs` reads `thread` and `userName`): the thread id for a thread's brain, and the user's name when one is set. */
  private bridgeConfig(): { readonly thread?: string; readonly userName?: string } {
    return { ...(this.opts.thread ? { thread: this.opts.thread } : {}), ...(this.opts.userName ? { userName: this.opts.userName } : {}) };
  }

  private baseInstructions(): string | undefined {
    const which = this.opts.baseInstructions ?? ((this.env()["JARHEAD_CODEX_BASE"] ?? "").trim().toLowerCase() === "codex" ? "codex" : "jarhead");
    return which === "codex" ? undefined : codexBaseInstructions(this.opts.userName);
  }

  /** "app-server" (warm) or "exec" (per task): what the next delegation will use. */
  get activeTransport(): "app-server" | "exec" {
    return this.transport;
  }

  /** The one-line status as of now: the transport fragment follows the warm start as it lands, fails or falls. */
  get detail(): string {
    return this.ready && this.baseDetail ? `${this.baseDetail}; ${this.transportDetail()}` : this.readyDetail;
  }

  private transportDetail(): string {
    if (this.appServer?.running && this.transport === "app-server") return `warm app-server (thread ${this.appServer.thread?.slice(0, 8) ?? "?"})`;
    const transport = this.opts.transport ?? "auto";
    if (transport === "exec") return "codex exec per task";
    if (this.appServerStarting) return "codex exec per task until the app-server is up (still starting)";
    return this.appServerFailure ? `codex exec per task (app-server: ${this.appServerFailure})` : "codex exec per task";
  }

  async start(): Promise<{ ready: boolean; detail: string }> {
    if (this.started) return { ready: this.ready, detail: this.detail };
    this.started = true;
    try {
      const probe = this.probe ?? (await probeCodex({ bin: this.opts.bin, codexHome: this.opts.codexHome, env: this.opts.env }));
      this.probe = probe;
      if (!probe.bin || !probe.version || !probe.signedIn) {
        this.readyDetail = probe.detail;
        return { ready: false, detail: this.readyDetail };
      }
      for (const [what, p] of [["node", this.node()], ["tsx", this.tsxCli()], ["the MCP bridge", this.bridgePath()]] as const) {
        if (!existsSync(p)) {
          this.readyDetail = `${what} is missing at ${p}`;
          return { ready: false, detail: this.readyDetail };
        }
      }
      mkdirSync(this.cwd(), { recursive: true });
      // Codex's home: Jarhead's own, with Kevin's login linked in and his model line
      // copied — none of his skills, AGENTS.md, plugins or hooks (REDESIGN §15).
      this.home = prepareCodexHome({ stateDir: this.opts.stateDir, sourceHome: this.opts.codexHome ?? codexHomeDir(this.env()) });
      (this.home.isolated ? log.info : log.warn)(this.home.detail);
      const socket = await this.ensureToolSocket();
      const model = codexModel(this.model, probe.configModel);
      // The warm transport gets a short patience window; past it the brain is ready
      // on exec and the app-server keeps starting in the background (an explicit
      // `transport: "app-server"` still waits for it, since there is no fallback).
      const starting = this.startAppServer(probe);
      const patience = this.opts.appServerPatienceMs ?? 4000;
      const warm = (this.opts.transport ?? "auto") === "app-server" ? await starting : await Promise.race([starting, new Promise<string>((r) => setTimeout(() => r("codex exec per task until the app-server is up (still starting)"), patience).unref?.())]);
      this.ready = true;
      this.baseDetail = `${probe.detail}; ${model ? `model ${model}` : "default model"}${this.model ? "" : model ? " (from ~/.codex/config.toml)" : ""}${this.opts.effort ? `, effort ${codexEffort(this.opts.effort)}` : ""}; tools over ${socket === this.opts.socketPath ? "the daemon socket" : "a private socket"}`;
      this.readyDetail = `${this.baseDetail}; ${warm}`;
      log.info(`ready; standing orders v${SYSTEM_PROMPT_VERSION}; transport ${this.transport}${this.appServerStarting ? " (app-server still starting)" : ""}`);
      return { ready: true, detail: this.readyDetail };
    } catch (e) {
      this.ready = false;
      this.readyDetail = (e as Error).message;
      return { ready: false, detail: this.readyDetail };
    }
  }

  /**
   * The warm transport: spawn the app-server and open its thread. Never throws
   * under `auto`; on any failure the brain runs `exec` per task and says so, and
   * tries again after the retry window. Returns the detail fragment for the ready
   * line. One start at a time: a second call while one is in flight joins it.
   */
  private startAppServer(probe: CodexProbe): Promise<string> {
    if (this.appServerStarting) return this.appServerStarting;
    const transport = this.opts.transport ?? "auto";
    if (transport === "exec" || !probe.bin || !this.toolSocket) {
      this.transport = "exec";
      return Promise.resolve("codex exec per task");
    }
    const bin = probe.bin;
    const base = this.env();
    const codexHome = this.home?.path ?? this.opts.codexHome ?? codexHomeDir(base);
    const server = new CodexAppServer({
      bin: bin.path,
      cwd: this.cwd(),
      env: codexEnv(base, codexHome),
      codexHome,
      model: codexModel(this.model, probe.configModel),
      effort: this.opts.effort,
      serviceTier: this.serviceTier(),
      node: this.node(),
      tsxCli: this.tsxCli(),
      bridgePath: this.bridgePath(),
      socketPath: this.toolSocket,
      ...this.bridgeConfig(),
      developerInstructions: `${brainSystemPrompt(this.opts.userName)}\n\n${codexAddendum(this.opts.userName)}`,
      baseInstructions: this.baseInstructions(),
      primeThreads: this.primeThreads(),
      startTimeoutMs: this.opts.appServerStartTimeoutMs,
      killGraceMs: this.opts.killGraceMs,
      spawnImpl: this.opts.spawnImpl,
    });
    // A rollover (background, after the turn that filled the thread) means the next
    // turn's thread knows nothing: the recent exchanges ride along as text.
    server.on("rollover", () => {
      this.carryHistory = this.history.length > 0;
    });
    const t0 = Date.now();
    const starting = (async (): Promise<string> => {
      try {
        const r = await server.start();
        if (!this.started) {
          // stop() ran while we were starting: nothing may stay warm.
          await server.stop();
          return "codex exec per task";
        }
        this.appServer = server;
        this.transport = "app-server";
        this.appServerFailure = undefined;
        this.carryHistory = this.history.length > 0;
        server.on("exit", (reason) => {
          if (this.appServer !== server) return;
          this.appServer = undefined;
          this.transport = "exec";
          this.appServerFailure = reason;
          // Try the warm path again a minute later; until then exec carries the tasks.
          this.appServerRetryAt = Date.now() + (this.opts.appServerRetryMs ?? 60_000);
          log.warn(`falling back to codex exec per task: ${reason}`);
        });
        log.info(`warm app-server up after ${Date.now() - t0} ms (thread ${r.threadId.slice(0, 8)}, initialize ${r.initMs} ms, thread/start ${r.threadMs} ms)`);
        return `warm app-server (thread ${r.threadId.slice(0, 8)}, initialize ${r.initMs} ms, thread/start ${r.threadMs} ms)`;
      } catch (e) {
        this.transport = "exec";
        this.appServerFailure = (e as Error).message;
        this.appServerRetryAt = Date.now() + (this.opts.appServerRetryMs ?? 60_000);
        log.warn(`app-server unavailable after ${Date.now() - t0} ms (${this.appServerFailure}); codex exec per task`);
        if (transport === "app-server") throw new Error(`codex app-server: ${this.appServerFailure}`);
        return `codex exec per task (app-server: ${this.appServerFailure})`;
      } finally {
        this.appServerStarting = undefined;
      }
    })();
    this.appServerStarting = starting;
    return starting;
  }

  /**
   * Before a task: the warm transport if it is up; else exec — now, without
   * waiting. A warm start that is due (first time, or the retry window has passed)
   * is kicked off in the background for the tasks that follow.
   */
  private ensureTransport(): "app-server" | "exec" {
    if (this.appServer?.running) return "app-server";
    const transport = this.opts.transport ?? "auto";
    if (transport === "exec" || !this.probe || !this.started) return "exec";
    if (!this.appServerStarting && Date.now() >= this.appServerRetryAt) {
      const probe = this.probe;
      log.info("warm app-server is not up; this task runs on exec while it starts");
      this.startAppServer(probe).catch((e: Error) => log.warn(`app-server start failed: ${e.message}`));
    }
    return "exec";
  }

  private node(): string {
    return this.opts.node ?? process.execPath;
  }

  private tsxCli(): string {
    return this.opts.tsxCli ?? join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  }

  private bridgePath(): string {
    return this.opts.bridgePath ?? fileURLToPath(new URL("./mcp-bridge.ts", import.meta.url));
  }

  /** Codex gets an empty directory of its own, not Kevin's home, as its working root. */
  private cwd(): string {
    return join(this.opts.stateDir, "codex-cwd");
  }

  /**
   * The bridge needs a socket that answers `tool.run` with THIS brain's runner.
   * Under jarheadd / the app that is the daemon's own socket — but only when the
   * daemon there is this process (its hello carries its pid). Another Jarhead on
   * the same path (the app's daemon while `jarhead live` hosts an engine, or
   * `jarheadd --socket X` with the default path still busy) would take the steps,
   * the screenshots and the pending confirmation into a runner that a "yes"
   * heard here can never reach. In every other case the brain serves the same
   * DaemonServer itself, with a runner-only engine, on a socket of its own
   * (`privateToolSocketPath`): the main brain and a thread's spare that both
   * missed the daemon's self-ping used to share one path, so main's calls landed
   * in the spare's host and stopping the spare unlinked main's socket.
   */
  private async ensureToolSocket(): Promise<string> {
    if (this.toolSocket) return this.toolSocket;
    const ownPid = this.opts.ownPid ?? process.pid;
    const pid = await daemonPidAt(this.opts.socketPath);
    if (pid === ownPid) {
      this.toolSocket = this.opts.socketPath;
      return this.toolSocket;
    }
    sweepDeadToolSockets(this.opts.stateDir);
    const path = privateToolSocketPath(this.opts.stateDir, this.opts.thread);
    const server = new DaemonServer(toolHost(this.opts.runner, this.opts.thread), path);
    await server.listen();
    this.privateServer = server;
    this.toolSocket = path;
    log.info(`${pid === undefined ? `no daemon at ${this.opts.socketPath}` : `the daemon at ${this.opts.socketPath} is pid ${pid}, not this process`}; serving tools at ${path}`);
    return path;
  }

  /** The whole prompt; `attached` are the images going in with `-i`, so the preamble numbers exactly those. */
  private prompt(task: BrainTask, attached: readonly BrainAttachment[]): string {
    const parts = [brainSystemPrompt(this.opts.userName), codexAddendum(this.opts.userName)];
    const carry = renderCarry(this.history, this.opts.userName ?? "Kevin");
    if (carry) parts.push(carry);
    parts.push(delegationPrompt(task, this.opts.userName, attached));
    return parts.join("\n\n");
  }

  /**
   * At wake: the resident app-server and its thread, started now if it is not up
   * (or its retry is due), never awaited by a task. Reuses the thread across
   * delegations; a fresh one is opened only when the context rolls over.
   */
  async warmUp(): Promise<{ warm: boolean; detail: string }> {
    if (!this.ready || !this.probe?.bin) return { warm: false, detail: this.readyDetail };
    const transport = this.ensureTransport();
    if (transport === "app-server" && this.appServer) return { warm: true, detail: `warm app-server, thread ${this.appServer.thread?.slice(0, 8) ?? "?"} reused across tasks` };
    return { warm: false, detail: this.appServerStarting ? "app-server starting in the background; the next task runs on exec if it lands first" : this.detail };
  }

  async handle(task: BrainTask, sink: BrainSink): Promise<BrainResult> {
    const probe = this.probe;
    if (!this.ready || !probe?.bin || !this.toolSocket) return { status: "failed", error: this.readyDetail };
    if (this.current || this.warm) return { status: "failed", error: "already handling a task" };
    if (task.signal.aborted) return { status: "cancelled" };
    if (this.ensureTransport() === "app-server" && this.appServer) return this.handleWarm(task, sink, this.appServer);
    return this.handleExec(task, sink, probe);
  }

  // ------------------------------------------------------------ warm turns

  private async handleWarm(task: BrainTask, sink: BrainSink, server: CodexAppServer): Promise<BrainResult> {
    const attached = existingAttachments(task);
    // A replacement thread started in the background after the last turn is awaited
    // here (usually long done), a primer still running is interrupted, and a thread
    // that filled up with no rollover yet is replaced now; the `rollover` listener
    // has set carryHistory, so a "yes" still knows what it confirms.
    await server.settleThread();
    if (task.signal.aborted) return { status: "cancelled" };
    // The server closed the thread and no replacement is up (it failed, or is not
    // started yet): this task runs on exec now and a fresh thread starts behind it.
    const probe = this.probe;
    if (!server.thread && probe) {
      log.warn("the warm app-server has no thread; this task runs on exec while a fresh one starts");
      server.reopenThread("no thread at a task");
      return this.handleExec(task, sink, probe);
    }
    // Per-turn effort A/B (opt-in): a few imperative words run at the simple effort.
    const simple = this.simpleEffort();
    let effort: Effort | undefined;
    if (simple) {
      const isSimple = isSimpleRequest(task.request);
      effort = isSimple ? simple : this.opts.effort;
      log.info(`effort ${effort ? codexEffort(effort) : "thread default"} (${isSimple ? "simple" : "not simple"}: "${task.request.slice(0, 80)}")`);
    }
    const parts: string[] = [];
    // The carried block is compacted (renderCarry): Kevin's words whole, results as
    // lines or size placeholders, the whole thing capped — a fresh thread is not the
    // old one's context by another name.
    const carry = this.carryHistory ? renderCarry(this.history, this.opts.userName ?? "Kevin") : undefined;
    if (carry) parts.push(carry);
    this.carryHistory = false;
    parts.push(delegationPrompt(task, this.opts.userName, attached));
    const input: UserInput[] = [{ type: "text", text: parts.join("\n\n"), text_elements: [] }, ...attached.map((a): UserInput => ({ type: "localImage", path: a.path, detail: "high" }))];

    const warm: WarmTurn = { task, sink, started: Date.now(), released: false, candidate: undefined, results: [], steps: 0, failed: undefined, cancelled: false, tainted: false, timer: undefined };
    this.warm = warm;
    this.opts.runner.attach(sink, task);
    const maxWallMs = this.opts.maxWallMs ?? 5 * 60_000;
    warm.timer = setTimeout(() => this.failWarm(warm, server, `I ran out of time after ${Math.round(maxWallMs / 1000)} seconds`), maxWallMs);
    const onAbort = (): void => {
      warm.cancelled = true;
      // Let go of the runner now, not when the server's turn/completed arrives: a
      // bridge call Codex already sent is refused instead of acting after the stop.
      this.release(warm);
      void server.interrupt();
    };
    task.signal.addEventListener("abort", onAbort, { once: true });
    let result: TurnResult;
    try {
      result = await server.turn(
        input,
        {
          onItemStarted: (item) => this.onWarmItemStarted(warm, server, item),
          onItemCompleted: (item) => this.onWarmItemCompleted(warm, server, item),
          onWarning: (m) => log.debug(`codex warning: ${m}`),
          onError: (m, willRetry) => {
            if (turnOver(warm)) return;
            if (willRetry) sink.step({ kind: "note", text: `codex: ${m.slice(0, 200)} (retrying)` });
            else this.failWarm(warm, server, m);
          },
        },
        { effort },
      );
    } catch (e) {
      result = { status: "failed", error: (e as Error).message, turnId: "" };
    } finally {
      task.signal.removeEventListener("abort", onAbort);
      if (warm.timer) clearTimeout(warm.timer);
      // Codex acted around Jarhead on this thread: its history holds the command and
      // what it printed, unredacted. No later turn runs on it, and the failed
      // exchange is never carried (remember() runs on success only).
      if (warm.tainted) server.retireThread("Codex acted around Jarhead on it");
      if (this.warm === warm) {
        this.warm = undefined;
        this.release(warm);
      }
    }
    const ms = Date.now() - warm.started;
    let out: BrainResult;
    if (warm.cancelled || (result.status === "interrupted" && !warm.failed)) out = { status: "cancelled" };
    else if (warm.failed) out = { status: "failed", error: warm.failed };
    else if (result.status === "failed") out = { status: "failed", error: result.error ?? "the Codex turn failed" };
    else {
      const summary = warm.candidate || "done.";
      this.remember(task.request, summary, warm.results);
      out = { status: "done", summary };
    }
    this.noteLoginRefusal(out);
    log.debug(`${out.status} in ${ms}ms after ${warm.steps} step(s) (app-server)`);
    return out;
  }

  /**
   * The runner lets go of this turn's task once: at the stop, when the brain fails the
   * turn itself, or when the turn ends, whichever is first. A second release (the turn
   * ending after a stop) must not detach a task attached since.
   */
  private release(owner: WarmTurn | RunState): void {
    if (owner.released) return;
    owner.released = true;
    this.opts.runner.attach(undefined);
  }

  /** A task that failed on the login itself: the next probe of this auth.json reads signed out, so a restart does not pick this brain again. */
  private noteLoginRefusal(out: BrainResult): void {
    if (out.status !== "failed" || !CODEX_AUTH_FAILURE.test(out.error ?? "")) return;
    const home = this.home?.path ?? this.opts.codexHome ?? codexHomeDir(this.env());
    markCodexLoginRefused(home);
    log.warn(`Codex refused the login (${(out.error ?? "").slice(0, 160)}); sign in to Codex in ChatGPT or run \`codex login\``);
  }

  /**
   * The brain's own stop (its own shell, around Jarhead, the step budget, the wall
   * clock, an error): the runner lets go now, as at Kevin's stop, so a bridge call
   * already in flight is refused instead of acting for a turn Jarhead has ended.
   */
  private failWarm(warm: WarmTurn, server: CodexAppServer, error: string): void {
    if (turnOver(warm)) return;
    warm.failed = error;
    this.release(warm);
    void server.interrupt();
  }

  /**
   * Codex acting around Jarhead: its own shell (switched off in the argv,
   * codexBuiltinsOffArgs) or an MCP server that is not Jarhead's (switched off too).
   * Either ran with no policy and no redactor. The turn fails here, the runner lets
   * go, and the thread is marked for retirement however the turn ends. Seen at the
   * item's start or, when only its completion is reported, there. Returns whether
   * the item was one; the command is named, its output never.
   */
  private warmActedAround(warm: WarmTurn, server: CodexAppServer, item: AppServerItem): boolean {
    const shell = item.type === "commandExecution";
    if (!shell && !(item.type === "mcpToolCall" && item.server !== CODEX_MCP_SERVER)) return false;
    warm.tainted = true;
    const what = shell ? `its own shell (${(item.command ?? "").slice(0, 120) || "a command"})` : `${item.server ?? "?"}.${item.tool ?? "?"}`;
    if (turnOver(warm)) {
      log.warn(`codex acted around Jarhead after the turn was over (${what}); its thread is retired`);
      return true;
    }
    warm.sink.step({ kind: "error", text: shell ? `codex ran ${what}; the turn was stopped` : `codex tried to act around Jarhead through ${what}; the turn was stopped` });
    this.failWarm(warm, server, shell ? ownShell((item.command ?? "").slice(0, 120)) : aroundJarhead(item.server, item.tool ?? "?"));
    return true;
  }

  private onWarmItemStarted(warm: WarmTurn, server: CodexAppServer, item: AppServerItem): void {
    if (this.warmActedAround(warm, server, item) || turnOver(warm)) return;
    if (item.type !== "mcpToolCall") return;
    if (!this.countWarmStep(warm, server)) return;
    warm.sink.thinking(progressLine(item.tool ?? "?", item.arguments));
  }

  private countWarmStep(warm: WarmTurn, server: CodexAppServer): boolean {
    const maxSteps = this.opts.maxSteps ?? 40;
    if (++warm.steps > maxSteps) {
      this.failWarm(warm, server, `I stopped after ${maxSteps} tool calls without finishing`);
      return false;
    }
    return true;
  }

  private onWarmItemCompleted(warm: WarmTurn, server: CodexAppServer, item: AppServerItem): void {
    // After a stop or a failure nothing of this turn reaches the sink: an agentMessage
    // quoting what Codex's own shell printed would otherwise be shown and spoken.
    if (this.warmActedAround(warm, server, item) || turnOver(warm)) return;
    const { sink } = warm;
    switch (item.type) {
      case "agentMessage": {
        const text = (item.text ?? "").trim();
        if (!text) return;
        if (warm.candidate) sink.step({ kind: "note", text: warm.candidate.slice(0, 1000) });
        warm.candidate = text;
        // Before the first tool call this is the only speakable thing; see the exec path.
        if (warm.steps === 0) sink.thinking(text.slice(0, 200));
        return;
      }
      case "reasoning": {
        const text = [...(item.summary ?? []), ...(item.content ?? [])].join(" ").trim();
        if (text) sink.thinking(text.slice(0, 300));
        return;
      }
      case "mcpToolCall": {
        // Jarhead's own tools only: any other server failed the turn above.
        const tool = item.tool ?? "?";
        if (item.status === "failed" || item.error) {
          const why = errorMessage(item.error, "failed");
          sink.step({ kind: "error", text: `${tool}: ${why}` });
          if (/approval/i.test(why)) log.warn(`${tool}: ${why}`);
        } else {
          warm.results.push(carriedResult(tool, item.result));
        }
        return;
      }
      default:
        return;
    }
  }

  // -------------------------------------------------------------- exec runs

  private handleExec(task: BrainTask, sink: BrainSink, probe: CodexProbe): Promise<BrainResult> {
    const bin = probe.bin;
    if (!bin || !this.toolSocket) return Promise.resolve({ status: "failed", error: this.readyDetail });
    const attached = existingAttachments(task);
    const args = codexExecArgs({
      cwd: this.cwd(),
      model: codexModel(this.model, probe.configModel),
      effort: this.opts.effort,
      node: this.node(),
      tsxCli: this.tsxCli(),
      bridgePath: this.bridgePath(),
      socketPath: this.toolSocket,
      ...this.bridgeConfig(),
      images: attached.map((a) => a.path),
      serviceTier: this.serviceTier(),
    });
    const base = this.env();
    const env = codexEnv(base, this.home?.path ?? this.opts.codexHome ?? codexHomeDir(base));
    this.opts.runner.attach(sink, task);
    return new Promise<BrainResult>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(bin.path, args, { cwd: this.cwd(), env, stdio: ["pipe", "pipe", "pipe"] });
      } catch (e) {
        this.opts.runner.attach(undefined);
        resolve({ status: "failed", error: `could not start Codex: ${(e as Error).message}` });
        return;
      }
      const state: RunState = { task, sink, child, started: Date.now(), released: false, candidate: undefined, results: [], steps: 0, completed: false, failed: undefined, cancelled: false, stderr: "", resolve, timer: undefined, killTimer: undefined };
      this.current = state;
      const maxWallMs = this.opts.maxWallMs ?? 5 * 60_000;
      state.timer = setTimeout(() => this.fail(state, `I ran out of time after ${Math.round(maxWallMs / 1000)} seconds`), maxWallMs);
      const onAbort = (): void => {
        state.cancelled = true;
        // Let go of the runner now, not when the SIGINT'd child has exited: a bridge
        // call it already sent is refused instead of acting after the stop.
        this.release(state);
        this.kill(state);
      };
      task.signal.addEventListener("abort", onAbort, { once: true });

      const lines = new LineSplitter(64 * 1024 * 1024);
      child.stdout?.on("data", (chunk: Buffer) => {
        let out: string[];
        try {
          out = lines.push(chunk);
        } catch (e) {
          log.warn((e as Error).message);
          return;
        }
        for (const line of out) this.onLine(state, line);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        state.stderr = (state.stderr + chunk.toString("utf8")).slice(-4000);
      });
      child.on("error", (e) => this.fail(state, `could not start Codex: ${e.message}`));
      child.on("close", (code, signal) => {
        task.signal.removeEventListener("abort", onAbort);
        this.settle(state, code, signal);
      });
      child.stdin?.on("error", (e) => log.debug(`stdin: ${e.message}`));
      child.stdin?.end(this.prompt(task, attached));
    });
  }

  private onLine(state: RunState, line: string): void {
    let ev: CodexEvent;
    try {
      ev = JSON.parse(line) as CodexEvent;
    } catch {
      log.debug(`non-JSON line from codex: ${line.slice(0, 200)}`);
      return;
    }
    const { sink } = state;
    switch (ev.type) {
      case "thread.started":
        log.debug(`thread ${ev.thread_id ?? "?"} started`);
        return;
      case "turn.started":
        return;
      case "item.started":
        this.onItemStarted(state, ev.item ?? {});
        return;
      case "item.updated":
        return;
      case "item.completed":
        this.onItemCompleted(state, ev.item ?? {});
        return;
      case "turn.completed":
        state.completed = true;
        return;
      case "turn.failed":
        this.fail(state, errorMessage(ev.error, ev.message ?? "the Codex turn failed"));
        return;
      case "error":
        this.fail(state, errorMessage(ev.error, ev.message ?? "Codex reported an error"));
        return;
      default:
        if (ev.type && !turnOver(state)) sink.step({ kind: "note", text: `codex: ${ev.type}` });
    }
  }

  private countStep(state: RunState): boolean {
    const maxSteps = this.opts.maxSteps ?? 40;
    if (++state.steps > maxSteps) {
      this.fail(state, `I stopped after ${maxSteps} tool calls without finishing`);
      return false;
    }
    return true;
  }

  /**
   * The exec run's twin of `warmActedAround`: Codex's own shell (switched off in the
   * argv) or an MCP server that is not Jarhead's (exec runs with --ignore-user-config,
   * so none should exist). The run fails and the runner lets go; the process is
   * ephemeral, so there is no thread to retire. Returns whether the item was one.
   */
  private execActedAround(state: RunState, item: CodexItem): boolean {
    const shell = item.type === "command_execution";
    if (!shell && !(item.type === "mcp_tool_call" && item.server !== CODEX_MCP_SERVER)) return false;
    const cmd = (Array.isArray(item.command) ? item.command.join(" ") : (item.command ?? "")).slice(0, 120);
    const what = shell ? `its own shell (${cmd || "a command"})` : `${item.server ?? "?"}.${item.tool ?? "?"}`;
    if (turnOver(state)) {
      log.warn(`codex acted around Jarhead after the run was over (${what})`);
      return true;
    }
    state.sink.step({ kind: "error", text: shell ? `codex ran ${what}; the run was stopped` : `codex tried to act around Jarhead through ${what}; the run was stopped` });
    this.fail(state, shell ? ownShell(cmd) : aroundJarhead(item.server, item.tool ?? "?"));
    return true;
  }

  private onItemStarted(state: RunState, item: CodexItem): void {
    if (this.execActedAround(state, item) || turnOver(state)) return;
    if (item.type !== "mcp_tool_call") return;
    if (!this.countStep(state)) return;
    // Our own tools report through the runner (the bridge lands there); this is the
    // "about to" line the in-process brains emit before each call.
    state.sink.thinking(progressLine(item.tool ?? "?", item.arguments));
  }

  private onItemCompleted(state: RunState, item: CodexItem): void {
    // After a stop or a failure nothing of this run reaches the sink (see onWarmItemCompleted).
    if (this.execActedAround(state, item) || turnOver(state)) return;
    const { sink } = state;
    switch (item.type) {
      case "agent_message": {
        const text = (item.text ?? "").trim();
        if (!text) return;
        // Only the last message is the answer; earlier ones were narration between tool calls.
        if (state.candidate) sink.step({ kind: "note", text: state.candidate.slice(0, 1000) });
        state.candidate = text;
        // Before the first tool call nothing else has reached the voice, and
        // Codex's start-up (auth, the skills catalog, the first model turn) is
        // several seconds of silence otherwise. The "I'll check…" line is
        // speakable, so it goes out as thinking too and Live can say "still on
        // it"; when it turns out to be the whole answer, the delegator speaks it
        // as the summary anyway.
        if (state.steps === 0) sink.thinking(text.slice(0, 200));
        return;
      }
      case "reasoning": {
        const text = (item.text ?? item.summary ?? "").trim();
        if (text) sink.thinking(text.slice(0, 300));
        return;
      }
      case "mcp_tool_call": {
        // Jarhead's own tools only: any other server failed the run above.
        const tool = item.tool ?? "?";
        if (item.status === "failed" || item.error) {
          const why = errorMessage(item.error, "failed");
          sink.step({ kind: "error", text: `${tool}: ${why}` });
          if (/approval/i.test(why)) log.warn(`${tool}: ${why}`);
        } else {
          state.results.push(carriedResult(tool, item.result));
        }
        return;
      }
      case "error":
        // Not fatal (the turn goes on): e.g. "Exceeded skills context budget…" on every run.
        log.debug(`codex item error: ${item.message ?? "?"}`);
        return;
      default:
        return;
    }
  }

  /** The brain's own stop on the exec run: as `failWarm`, the runner lets go now, then the child is told to stop. */
  private fail(state: RunState, error: string): void {
    if (turnOver(state)) return;
    state.failed = error;
    this.release(state);
    this.kill(state);
  }

  /** SIGINT first so Codex can tidy up, SIGKILL if it lingers. */
  private kill(state: RunState): void {
    const { child } = state;
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill("SIGINT");
    } catch {
      // already gone
    }
    if (!state.killTimer) {
      state.killTimer = setTimeout(() => {
        try {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }, this.opts.killGraceMs ?? 3000);
    }
  }

  private settle(state: RunState, code: number | null, signal: NodeJS.Signals | null): void {
    if (state.timer) clearTimeout(state.timer);
    if (state.killTimer) clearTimeout(state.killTimer);
    if (this.current === state) {
      this.current = undefined;
      this.release(state);
    }
    const ms = Date.now() - state.started;
    let result: BrainResult;
    if (state.cancelled) result = { status: "cancelled" };
    else if (state.failed) result = { status: "failed", error: state.failed };
    else if (state.completed || (code === 0 && state.candidate)) {
      const summary = state.candidate || "done.";
      this.remember(state.task.request, summary, state.results);
      result = { status: "done", summary };
    } else {
      const tail = state.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300);
      result = { status: "failed", error: `Codex exited ${signal ? `on ${signal}` : `with code ${code ?? "?"}`} before finishing${tail ? `: ${tail}` : ""}` };
    }
    this.noteLoginRefusal(result);
    log.debug(`${result.status} in ${ms}ms after ${state.steps} step(s)`);
    state.resolve(result);
  }

  private remember(request: string, answer: string, results: readonly CarriedResult[] = []): void {
    const turns = this.opts.historyTurns ?? 3;
    if (turns <= 0) return;
    this.history.push({ request, answer, results: results.slice(-CARRY_RESULTS_PER_EXCHANGE) });
    if (this.history.length > turns) this.history.splice(0, this.history.length - turns);
  }

  async cancel(): Promise<void> {
    const warm = this.warm;
    if (warm) {
      warm.cancelled = true;
      this.release(warm);
      await this.appServer?.interrupt();
    }
    const cur = this.current;
    if (!cur) return;
    cur.cancelled = true;
    this.release(cur);
    this.kill(cur);
  }

  async stop(): Promise<void> {
    await this.cancel();
    this.started = false; // a later start() probes again; a warm start still in flight sees this and stops its server
    const app = this.appServer;
    this.appServer = undefined;
    await app?.stop();
    const server = this.privateServer;
    this.privateServer = undefined;
    this.toolSocket = undefined;
    await server?.close();
    this.ready = false;
    this.readyDetail = "stopped";
    this.baseDetail = "";
    this.transport = "exec";
    this.appServerRetryAt = 0;
    this.history = [];
  }
}

/** The error a turn ends with when Codex calls an MCP server other than Jarhead's. */
function aroundJarhead(server: string | undefined, tool: string): string {
  return `Codex tried to act around Jarhead (an MCP call to ${server ?? "?"}.${tool}); the turn was stopped`;
}

/** The error a turn ends with when Codex runs its own shell, which the argv switched off. */
function ownShell(cmd: string): string {
  return `Codex ran its own shell around Jarhead (${cmd || "a command"}); the turn was stopped`;
}

/** The circled regions Codex gets with `-i`; a file already gone is left out rather than failing the run, and the prompt names only these. */
function existingAttachments(task: BrainTask): BrainAttachment[] {
  return (task.attachments ?? []).filter((a) => existsSync(a.path));
}

/**
 * The pid of the Jarhead daemon at the path (from its `hello`), or undefined
 * when nothing there answers like one within the timeout.
 */
export function daemonPidAt(socketPath: string, timeoutMs = 1000): Promise<number | undefined> {
  if (!existsSync(socketPath)) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const client = new DaemonClient(socketPath);
    let done = false;
    const finish = (pid: number | undefined): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      client.close();
      resolve(pid);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    client.on("error", () => finish(undefined));
    client.on("close", () => finish(undefined));
    client.on("message", (m) => {
      if (m.type === "hello") finish(Number.isInteger(m.pid) ? m.pid : undefined);
    });
    client.connect({ pid: process.pid, audio: false }).catch(() => finish(undefined));
  });
}

/** Private tool sockets handed out by this process; with the pid in the name, no two brains anywhere share a path. */
let privateSocketSeq = 0;
const PRIVATE_SOCKET = /^codex-tools-(?:main|thread)-(\d+)-\d+\.sock$/;

/**
 * `<stateDir>/codex-tools-<main|thread>-<pid>-<n>.sock`: one per brain. Short on
 * purpose (a unix socket path is capped at 103 bytes on macOS), so the role and
 * not the thread id; the thread id rides the bridge's env instead.
 */
export function privateToolSocketPath(stateDir: string, thread?: string | undefined): string {
  return join(stateDir, `codex-tools-${thread ? "thread" : "main"}-${process.pid}-${++privateSocketSeq}.sock`);
}

/** Private sockets left by a process that is gone (a crash skips close()): removed, so the state dir does not collect them. */
function sweepDeadToolSockets(stateDir: string): void {
  let names: string[];
  try {
    names = readdirSync(stateDir);
  } catch {
    return;
  }
  for (const name of names) {
    const pid = Number(PRIVATE_SOCKET.exec(name)?.[1]);
    if (!pid || pid === process.pid || processAlive(pid)) continue;
    try {
      unlinkSync(join(stateDir, name));
    } catch {
      // gone already, or not ours to remove
    }
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** True when a Jarhead daemon (any process) answers at the path within the timeout. */
export async function socketAnswers(socketPath: string, timeoutMs = 1000): Promise<boolean> {
  return (await daemonPidAt(socketPath, timeoutMs)) !== undefined;
}

/**
 * The private socket's host: only `tool.run` is answered there. A spawned thread's brain
 * lands here when the daemon's pid check fails (a 1 s self-ping under wake load): its
 * bridge stamps every call with the thread id, and the daemon routes a stamped call
 * through `runnerFor` only — so the host answers for exactly that id with the thread's
 * own lane runner, or the thread would be refused every tool for its whole life. Any
 * other id is not this brain's.
 */
function toolHost(runner: ToolRunner, thread?: string): ToolHost {
  return {
    runner,
    runnerFor: (id) => (thread !== undefined && id === thread ? runner : undefined),
    userName: runner.userName,
  };
}
