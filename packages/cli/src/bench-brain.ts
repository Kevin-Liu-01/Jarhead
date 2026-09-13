import { EventEmitter } from "node:events";
import { spawn as realSpawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { readConfig, replaceDefaultSink, setLogLevel, type JarheadConfig, type LogLevel } from "@jarhead/core";
import type { LiveSession } from "@jarhead/live";
import { CodexBrain, parseReflex, probeCodex, type Brain, type BrainResult, type BrainSink, type BrainTask, type CodexProbe, type DelegationTimingsExtra, type RunOutcome, type ToolRunner } from "@jarhead/brain";
import { ACTING_MEMBERS, type NativeHands } from "@jarhead/hands";
import { Engine } from "@jarhead/engine";
import type { Delegation, DelegationStep, Effort } from "@jarhead/protocol";

/**
 * `pnpm jarhead bench --brain` — the representative-command benchmark
 * (docs/LATENCY.md). Five things Kevin says most, run through a real Engine and
 * the REAL brain (`auto`, which is Codex on this Mac: the resident app-server,
 * one thread across delegations, one turn per delegation, exactly as the product
 * runs it) with a stand-in Live session and canned hands:
 *
 *   "jarhead search the wiki for design"
 *   "jarhead open safari"
 *   "jarhead what is on my screen"
 *   "jarhead click the search bar and type hello"
 *   "jarhead scroll down"
 *
 * Two phases. First the product path with reflexes ON: the commands the grammar
 * catches (open safari, scroll down) never reach the brain and finish in
 * milliseconds — those rows show what Kevin gets. Then the brain path with
 * reflexes OFF: every command N times (default 2) on the model, sequentially, so
 * the model-path numbers are comparable run to run. `--no-reflex` skips the first
 * phase (brain path only).
 *
 * Per run: delegation → first thinking, → first model tool (the first ToolRunner
 * call the brain made; the eyes' own shot excluded), → first ACTION (the first
 * acting tool — click, type, key, scroll, open_app, applescript, run_shell, a
 * file write, a browser action — that returned ok), → done; the model steps
 * (MCP tool calls + Codex shell commands + a final message, each one generation;
 * reasoning items as a cross-check), the tool calls by name, context rollovers,
 * wiki-bootstrap calls (kevin-wiki / AGENTS.md / `npm run status`), no-such-file
 * errors, the first words. Then medians and p95 per command and overall, the tool
 * counts, and the gaps between consecutive model steps (the per-generation cost).
 *
 * Nothing here touches the Mac. Live is a stand-in (no socket, no billing); the
 * hands are canned answers (Safari in front on a wiki page, a 1280×800 synthetic
 * screen, `find_element` answering the search field, click/type/key succeeding —
 * a typed text shows up in `read_focused_text`, as it would on a real Mac); every
 * non-hands tool that could act (run_shell, applescript, write_file, edit_file,
 * open_url, clipboard_*, agent_*, self_*) is answered with an error at the
 * ToolRunner. Read-only file and web tools run for real. The Codex turns run on
 * Kevin's ChatGPT login: the run costs his ChatGPT plan, not dollars — the header
 * says so. When Codex is not signed in the bench REFUSES to run: the engine's
 * `auto` would pick the next brain (Claude Code, then the API keys) and spend real
 * dollars on ten screenshot-carrying turns; `--allow-api-spend` is the override.
 * `--effort low|medium` overrides the brain's effort for the run (one flag for an
 * A/B); `--json` prints everything as JSON; `--out FILE` writes it.
 *
 * Rollovers are read off the app-server wire, not the log's wording: a run whose
 * `turn/start` names a different thread than the previous turn's ran on a fresh
 * thread (wherever the `thread/start` itself landed — inside a run or in the gap
 * between two). The log line is only the fallback when there is no wire.
 */

// ------------------------------------------------------------------ options

export interface BrainBenchOptions {
  /** Runs per command on the brain path (default 2). */
  readonly runs: number;
  /** Brain effort for this run; default: the configured one (JARHEAD_BRAIN_EFFORT, else medium). */
  readonly effort?: Effort | undefined;
  /** Skip the reflexes-on phase: brain path only. */
  readonly noReflex?: boolean | undefined;
  readonly json: boolean;
  /** Also write the JSON report here. */
  readonly out?: string | undefined;
  /** Restrict to these command ids (smoke runs). */
  readonly only?: readonly string[] | undefined;
  /** Test seam: a stand-in brain instead of Codex (no wire, no ChatGPT plan) — given the engine's runner once it exists. */
  readonly brain?: Brain | ((runner: ToolRunner) => Brain) | undefined;
  /**
   * Run even when Codex is not available and the engine's `auto` would pick a brain
   * that costs API dollars (Claude Code, the Anthropic / OpenAI keys). Off by default:
   * without it the bench refuses to run on anything but Codex or a stand-in.
   */
  readonly allowApiSpend?: boolean | undefined;
  /** Test seam: the Codex probe to trust instead of probing this Mac (drives the refusal path without a Codex). */
  readonly probe?: CodexProbe | undefined;
  /** How long to wait for the warm app-server before running (default 150 s; tests pass 0). */
  readonly warmWaitMs?: number | undefined;
  /** Per-delegation cap before the run is interrupted and recorded as timed out (default 180 s). */
  readonly delegationTimeoutMs?: number | undefined;
  /** Where lines go (default console.log / console.error). */
  readonly print?: ((line: string) => void) | undefined;
  /** `Settings.observe` for the run: false = the A/B without the observation line on acting results (default: the setting's default, on). */
  readonly observe?: boolean | undefined;
  /** A previous report (--out FILE) to print deltas against, per command. */
  readonly compare?: string | undefined;
}

export interface BenchCommand {
  readonly id: string;
  readonly text: string;
}

/** The five representative commands, in the order they run. */
export const BRAIN_BENCH_COMMANDS: readonly BenchCommand[] = [
  { id: "wiki-search", text: "jarhead search the wiki for design" },
  { id: "open-safari", text: "jarhead open safari" },
  { id: "whats-on-screen", text: "jarhead what is on my screen" },
  { id: "click-search-type", text: "jarhead click the search bar and type hello" },
  { id: "scroll-down", text: "jarhead scroll down" },
];

/** Tools that could act outside the canned hands: answered with an error at the runner. */
export const BLOCKED_TOOLS: ReadonlySet<string> = new Set(["run_shell", "applescript", "write_file", "edit_file", "open_url", "clipboard_write", "clipboard_read", "agent_send", "agent_start", "self_edit", "self_check", "self_review", "self_apply", "self_discard"]);

/**
 * What counts as a visible action for "delegation → first action": the hands'
 * acting members, the tools that act on the Mac without the hands, and the
 * overlays Kevin sees drawn on his screen (the analysts' "first visible action",
 * which the BEFORE numbers in docs/LATENCY.md use, counted show_* the same way;
 * `show_clear` removes, it does not show). The same set the Delegator stamps
 * `firstActionAt` with (packages/brain/src/delegator.ts) — a copy, because the
 * brain's index does not export it; both tests pin the two to this list.
 */
export const ACTING_TOOLS: ReadonlySet<string> = new Set([...ACTING_MEMBERS, "applescript", "run_shell", "write_file", "edit_file", "browser_navigate", "browser_click", "browser_type", "show_circle", "show_arrow", "show_rect", "show_text", "show_stroke"]);

/**
 * Kevin's global ~/.codex/AGENTS.md bootstrap, as it shows up in tool inputs and
 * shell commands: the stale wiki root under Documents/GitHub, ~/.codex/AGENTS.md
 * itself, the "Start" list's pages, `npm run status`. A search of the real wiki
 * (~/repos/Kevin-Wiki-v3) is the task, not bootstrap, and is not matched; nor is
 * any other AGENTS.md (this repo's, or the one the canned page mentions).
 */
export const BOOTSTRAP_RE = /Documents\/GitHub\/kevin-wiki|\.codex\/AGENTS\.md|agent-operations-hub|slash-command-index|capability-routing|SKILL-RESOLVER|npm run status/i;
/** A file tool's "the path does not exist" — not `read_focused_text`'s "not_found: no focused UI element". */
export const NO_SUCH_FILE_RE = /no such file|ENOENT|does not exist/i;
/** The tools whose errors NO_SUCH_FILE_RE is read on. */
export const FILE_TOOLS: ReadonlySet<string> = new Set(["read_file", "list_dir", "search_files", "write_file", "edit_file"]);
/**
 * The app-server's fresh-thread line (`codex-app-server.ts`: "context … → fresh
 * thread abcd1234 (…)") and the older wording, for a run without a wire (a
 * stand-in brain, the exec fallback). With a wire the thread id decides.
 */
export const ROLLOVER_LOG_RE = /→ fresh thread|rolled over to a fresh thread/;
/** A gap between consecutive model events longer than this is the model thinking (a tool round trip is tens of ms). */
export const GENERATION_GAP_MIN_MS = 300;

// ------------------------------------------------------------------- fake Live

/**
 * A stand-in Live session: no socket, no billing. Session time IS real elapsed
 * time since `start()` — never skewed — so `speechEndAt` (the engine's session
 * start + the utterance's end) sits on the wall clock and `delegatedAt −
 * speechEndAt` is a real, near-zero number rather than an artifact.
 */
class BenchLive extends EventEmitter {
  currentState = "idle";
  session: { id: string; expires_at: number } | undefined;
  nowMs = 0;
  commentary: string[] = [];
  thinking: string[] = [];
  private startedWall = 0;
  private lastUtteranceEndMs = -Infinity;
  async start(): Promise<{ id: string; expires_at: number }> {
    this.currentState = "started";
    this.startedWall = Date.now();
    this.session = { id: "bench-brain", expires_at: Math.floor(Date.now() / 1000) + 3600 };
    return this.session;
  }
  tick(): number {
    this.nowMs = Date.now() - this.startedWall;
    return this.nowMs;
  }
  /** An utterance the bench feeds lasts this long on the session timeline. */
  static readonly UTTERANCE_MS = 1200;
  /** A new utterance's START must fall this far after the previous one's end: the transcript's merge gap (1400 ms) plus a margin. */
  static readonly SPACING_MS = 1400 + 400;
  /**
   * Session time for a new utterance ending now. Its START must fall more than the
   * transcript's merge gap after the previous utterance's end, or the two become
   * one request ("jarhead open safari jarhead scroll down"); when a run finished
   * faster than that (a reflex, in milliseconds) the bench WAITS the difference in
   * real time — at most ~3 s per fast row — instead of moving the clock.
   */
  async nextUtterance(): Promise<number> {
    const need = this.lastUtteranceEndMs + BenchLive.UTTERANCE_MS + BenchLive.SPACING_MS;
    const wait = need - this.tick();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastUtteranceEndMs = this.tick();
    return this.nowMs;
  }
  appendInstructions(): string {
    return "i";
  }
  appendThinking(_id: string | null, content: string): string {
    this.thinking.push(content);
    return "t";
  }
  appendCommentary(_id: string | null, content: string): string {
    this.commentary.push(content);
    return "c";
  }
  appendAudio(): void {}
  mute(): string {
    return "m";
  }
  unmute(): string {
    return "u";
  }
  createResponseItem(): void {}
  createResponse(): void {}
  close(): void {
    this.currentState = "closed";
    this.emit("closed", "client_closed", 0);
  }
}

// ------------------------------------------------------------------ the screen

const FIXTURE_PNG = fileURLToPath(new URL("../fixtures/bench-screen-wiki-1280x800.png", import.meta.url));

const crcTable = ((): Uint32Array => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = (crcTable[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([len, typeAndData, crc]);
}

/**
 * A 1280×800 PNG drawn from rectangles alone — a Safari-like window with a dark
 * header bar, a sidebar and a white search field — for when the fixture file is
 * missing. No text (no font here); the AX tree the canned hands answer carries
 * the labels.
 */
export function syntheticScreenPng(width = 1280, height = 800): Buffer {
  const px = Buffer.alloc(width * height * 3, 236);
  const fill = (x: number, y: number, w: number, h: number, rgb: readonly [number, number, number]): void => {
    for (let yy = Math.max(0, y); yy < Math.min(height, y + h); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(width, x + w); xx++) {
        const o = (yy * width + xx) * 3;
        px[o] = rgb[0];
        px[o + 1] = rgb[1];
        px[o + 2] = rgb[2];
      }
    }
  };
  fill(0, 0, width, 24, [246, 246, 246]); // menu bar
  fill(0, 24, width, 66, [240, 240, 242]); // toolbar
  fill(340, 44, 600, 34, [255, 255, 255]); // address field
  fill(0, 90, width, 28, [230, 230, 232]); // tab strip
  fill(0, 118, width, 60, [29, 40, 56]); // wiki header
  fill(780, 130, 400, 36, [255, 255, 255]); // search field
  fill(0, 178, 260, height - 178, [245, 246, 248]); // sidebar
  fill(260, 178, width - 260, height - 178, [255, 255, 255]); // article
  for (let i = 0; i < 7; i++) fill(32, 210 + i * 40, 120, 14, [90, 100, 120]); // sidebar rows
  fill(300, 205, 90, 30, [30, 30, 30]); // heading
  for (let i = 0; i < 3; i++) fill(300, 270 + i * 30, 640 - i * 80, 12, [120, 120, 120]); // lines
  // Filtered scanlines (filter byte 0 = none).
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    px.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}

/** The canned screen: the fixture (Safari on the wiki index, with text) or the drawn stand-in. */
export function benchScreenPng(): { png: Buffer; source: string } {
  if (existsSync(FIXTURE_PNG)) return { png: readFileSync(FIXTURE_PNG), source: FIXTURE_PNG };
  return { png: syntheticScreenPng(), source: "synthetic (fixture missing)" };
}

/** Width and height from a PNG's IHDR. */
export function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

// ------------------------------------------------------------------ canned hands

interface AxNode {
  readonly i: number;
  readonly depth: number;
  readonly role: string;
  readonly subrole?: string;
  readonly title?: string;
  readonly description?: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly pressable?: boolean;
}

const WIKI_TITLE = "Kevin Wiki — Index";
const WIKI_URL = "https://wiki.kevin.local/wiki/index";
const WIKI_TEXT = "Kevin Wiki\nSearch the wiki\nIndex Design Engineering Productivity Personal Projects Log\nIndex\nThis wiki holds Kevin's notes on design, engineering and the tools he runs.\nStart with Design for the visual canon, Engineering for repo rules, Log for the day's changes.\nPages are Markdown under wiki/; the agent index lives in AGENTS.md.\nRecently changed\n- Design system tokens\n- Agent operations hub\n- Slash command index\nKevin Wiki · 718 pages · last built today";
const DISPLAY = { id: 1, x: 0, y: 0, w: 1280, h: 800, scale: 1, main: true };
const SEARCH_FIELD: AxNode = { i: 6, depth: 3, role: "AXTextField", subrole: "AXSearchField", title: "Search the wiki", description: "Search the wiki", x: 780, y: 130, w: 400, h: 36, pressable: true };
const ADDRESS_FIELD: AxNode = { i: 2, depth: 2, role: "AXTextField", title: "Address and Search", description: "Smart Search Field", x: 340, y: 44, w: 600, h: 34, pressable: true };
const SIDEBAR = ["Index", "Design", "Engineering", "Productivity", "Personal", "Projects", "Log"];
const AX_NODES: readonly AxNode[] = [
  { i: 0, depth: 0, role: "AXWindow", title: WIKI_TITLE, x: 0, y: 24, w: 1280, h: 776 },
  { i: 1, depth: 1, role: "AXToolbar", x: 0, y: 24, w: 1280, h: 66 },
  ADDRESS_FIELD,
  { i: 3, depth: 1, role: "AXWebArea", title: WIKI_TITLE, x: 0, y: 118, w: 1280, h: 682 },
  { i: 4, depth: 2, role: "AXGroup", description: "header", x: 0, y: 118, w: 1280, h: 60 },
  { i: 5, depth: 3, role: "AXHeading", title: "Kevin Wiki", x: 40, y: 134, w: 130, h: 30 },
  SEARCH_FIELD,
  ...SIDEBAR.map((t, k): AxNode => ({ i: 7 + k, depth: 3, role: "AXLink", title: t, x: 32, y: 210 + k * 40, w: 120, h: 22, pressable: true })),
  { i: 14, depth: 3, role: "AXHeading", title: "Index", x: 300, y: 205, w: 90, h: 34 },
  { i: 15, depth: 3, role: "AXStaticText", title: "This wiki holds Kevin's notes on design, engineering and the tools he runs.", x: 300, y: 270, w: 560, h: 20 },
];
const SEARCHY = /search|find|query|address|url|omni|smart/i;

function center(n: AxNode): { x: number; y: number } {
  return { x: n.x + n.w / 2, y: n.y + n.h / 2 };
}

function found(n: AxNode, score: number): Record<string, unknown> {
  return { ...n, app: "Safari", score, label: n.title ?? n.description ?? n.role, center: center(n) };
}

export interface HandsCall {
  readonly op: string;
  readonly params: Record<string, unknown>;
  readonly at: number;
}

/**
 * Canned hands: one 1280×800 display at scale 1, Safari in front on the wiki
 * index; `find_element` answers the search field for anything search-shaped and
 * the sidebar links by name; a `type` lands in the focused field so a
 * `read_focused_text` afterwards shows it. Every op answers at once.
 */
export class WikiHands implements NativeHands {
  ready = true;
  readonly calls: HandsCall[] = [];
  /** What has been typed into the focused (search) field so far. */
  typed = "";
  private readonly shotB64: string;
  constructor(png: Buffer = benchScreenPng().png) {
    this.shotB64 = png.toString("base64");
  }
  async request<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ op, params, at: Date.now() });
    switch (op) {
      case "hello":
        return { version: "bench-canned", pid: 1, permissions: { accessibility: true, screenRecording: true, inputMonitoring: true, fullDiskAccess: false } } as T;
      case "permissions":
        return { accessibility: true, screenRecording: true, inputMonitoring: true, fullDiskAccess: false } as T;
      case "displays":
        return { displays: [DISPLAY] } as T;
      case "screenshot":
        return { displayId: 1, pngBase64: this.shotB64, width: 1280, height: 800, points: { x: 0, y: 0, w: 1280, h: 800 }, scale: 1 } as T;
      case "zoom": {
        const r = { x: Number(params["x"] ?? 0), y: Number(params["y"] ?? 0), w: Number(params["w"] ?? 400), h: Number(params["h"] ?? 300) };
        return { displayId: 1, pngBase64: this.shotB64, width: 1280, height: 800, points: r, scale: 1280 / Math.max(1, r.w) } as T;
      }
      case "frontmost":
        return { app: "Safari", bundleId: "com.apple.Safari", pid: 501, window: { title: WIKI_TITLE, x: 0, y: 24, w: 1280, h: 776, windowId: 11 } } as T;
      case "cursor":
        return { x: 640, y: 400 } as T;
      case "windows":
        return { windows: [{ windowId: 11, pid: 501, app: "Safari", title: WIKI_TITLE, x: 0, y: 24, w: 1280, h: 776, layer: 0 }] } as T;
      case "element_at": {
        const x = Number(params["x"] ?? 0);
        const y = Number(params["y"] ?? 0);
        const hit = [...AX_NODES].filter((n) => n.pressable || n.role === "AXHeading" || n.role === "AXStaticText").find((n) => x >= n.x && x <= n.x + n.w && y >= n.y && y <= n.y + n.h);
        if (hit) return { role: hit.role, ...(hit.subrole ? { subrole: hit.subrole } : {}), ...(hit.title ? { title: hit.title } : {}), ...(hit.description ? { description: hit.description } : {}), frame: { x: hit.x, y: hit.y, w: hit.w, h: hit.h }, app: "Safari" } as T;
        return { role: "AXWebArea", title: WIKI_TITLE, frame: { x: 0, y: 118, w: 1280, h: 682 }, app: "Safari" } as T;
      }
      case "focused_text":
        return { role: "AXTextField", subrole: "AXSearchField", title: "Search the wiki", value: this.typed, secure: false, app: "Safari", frame: { x: SEARCH_FIELD.x, y: SEARCH_FIELD.y, w: SEARCH_FIELD.w, h: SEARCH_FIELD.h } } as T;
      case "ax_tree":
        return { app: "Safari", pid: 501, window: WIKI_TITLE, count: AX_NODES.length, cached: false, ageMs: 0, treeMs: 4, truncated: false, nodes: AX_NODES } as T;
      case "find_element": {
        const name = String(params["name"] ?? "").trim();
        const link = SIDEBAR.find((t) => t.toLowerCase() === name.toLowerCase());
        const hit = SEARCHY.test(name) ? SEARCH_FIELD : link ? AX_NODES.find((n) => n.role === "AXLink" && n.title === link) : undefined;
        return { app: "Safari", window: WIKI_TITLE, found: Boolean(hit), unique: Boolean(hit), candidates: hit ? 1 : 0, tier: hit ? (link ? "exact" : "fuzzy") : "none", ...(hit ? { element: found(hit, link ? 1 : 0.9) } : {}), cached: false, treeMs: 4, nodes: AX_NODES.length, truncated: false, ms: 2 } as T;
      }
      case "open_app":
      case "focus_app":
        return { pid: 501, bundleId: "com.apple.Safari", app: String(params["name"] ?? "Safari") } as T;
      case "browser_url":
        return { url: WIKI_URL, title: WIKI_TITLE } as T;
      case "browser_tabs":
        return { tabs: [{ index: 1, title: WIKI_TITLE, url: WIKI_URL, active: true }], active: 1 } as T;
      case "browser_js": {
        const script = String(params["script"] ?? "");
        if (script.trim() === "1+1") return { result: "2", ms: 3 } as T;
        if (/document\.title/.test(script) && /text/.test(script)) return { result: JSON.stringify({ url: WIKI_URL, title: WIKI_TITLE, text: WIKI_TEXT, length: WIKI_TEXT.length }), ms: 4 } as T;
        return { result: JSON.stringify({ ok: true, count: 1, exact: false, first: { tag: "input", text: "Search the wiki", x: SEARCH_FIELD.x, y: SEARCH_FIELD.y - 24, w: SEARCH_FIELD.w, h: SEARCH_FIELD.h } }), ms: 4 } as T;
      }
      case "type":
        this.typed += String(params["text"] ?? "");
        return {} as T;
      case "key": {
        const combo = String(params["combo"] ?? "");
        if (/^(cmd\+a|Delete|BackSpace)$/i.test(combo)) this.typed = "";
        return {} as T;
      }
      default:
        // click, move, drag, mouse_down/up, scroll, hold_key, browser_navigate: done, nothing to say.
        return {} as T;
    }
  }
}

// ------------------------------------------------------------------- the wire

/** One JSON-RPC line between the brain and the app-server, as far as the bench reads it. */
export interface WireRow {
  readonly at: number;
  readonly dir: "out" | "in";
  readonly id?: number;
  readonly method?: string;
  readonly itemType?: string;
  readonly tool?: string;
  readonly server?: string;
  readonly status?: string;
  readonly command?: string;
  readonly exitCode?: number | null;
  readonly text?: string;
  readonly inputChars?: number;
  readonly images?: number;
  readonly tokenUsage?: { total?: number; last?: number; window?: number | null };
  readonly turnStatus?: string;
  /** The thread a `turn/start` went out on, or the one a `thread/start` ack opened. */
  readonly threadId?: string;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (typeof v === "object" && v !== null ? (v as Json) : {});

/** Parse one wire line into a row; undefined for anything that is not JSON. */
export function parseWireLine(dir: "out" | "in", line: string, at = Date.now()): WireRow | undefined {
  let msg: Json;
  try {
    msg = obj(JSON.parse(line));
  } catch {
    return undefined;
  }
  const row: Record<string, unknown> = { at, dir };
  if (typeof msg["id"] === "number") row["id"] = msg["id"];
  if (typeof msg["method"] === "string") row["method"] = msg["method"];
  const p = obj(msg["params"]);
  if (dir === "out" && msg["method"] === "turn/start") {
    const input = Array.isArray(p["input"]) ? (p["input"] as Json[]) : [];
    row["inputChars"] = input.filter((i) => i["type"] === "text").reduce((n, i) => n + String(i["text"] ?? "").length, 0);
    row["images"] = input.filter((i) => i["type"] === "localImage").length;
    if (typeof p["threadId"] === "string") row["threadId"] = p["threadId"];
  }
  if (dir === "out" && msg["method"] === "thread/start") row["inputChars"] = String(p["developerInstructions"] ?? "").length;
  if (dir === "in" && typeof msg["method"] === "string") {
    const item = obj(p["item"]);
    if (typeof item["type"] === "string") row["itemType"] = item["type"];
    if (typeof item["tool"] === "string") row["tool"] = item["tool"];
    if (typeof item["server"] === "string") row["server"] = item["server"];
    if (typeof item["status"] === "string") row["status"] = item["status"];
    if (item["command"] !== undefined) row["command"] = String(item["command"]).slice(0, 200);
    if (item["exitCode"] !== undefined) row["exitCode"] = item["exitCode"];
    if (item["type"] === "agentMessage" && item["text"]) row["text"] = String(item["text"]).slice(0, 400);
    if (item["type"] === "reasoning") row["text"] = [...((item["summary"] as unknown[] | undefined) ?? []), ...((item["content"] as unknown[] | undefined) ?? [])].join(" ").slice(0, 400);
    if (msg["method"] === "thread/tokenUsage/updated") {
      const u = obj(p["tokenUsage"]);
      row["tokenUsage"] = { total: obj(u["total"])["totalTokens"], last: obj(u["last"])["totalTokens"], window: u["modelContextWindow"] ?? null };
    }
    if (msg["method"] === "turn/completed") row["turnStatus"] = obj(p["turn"])["status"];
  }
  if (dir === "in" && row["id"] !== undefined && msg["method"] === undefined) {
    const result = obj(msg["result"]);
    if (obj(result["thread"])["id"]) {
      row["threadId"] = String(obj(result["thread"])["id"]);
      row["text"] = `thread ${String(obj(result["thread"])["id"])} model=${String(result["model"] ?? "?")} effort=${String(result["reasoningEffort"] ?? "?")}`;
    }
    if (msg["error"]) row["text"] = `error: ${String(obj(msg["error"])["message"] ?? JSON.stringify(msg["error"])).slice(0, 200)}`;
  }
  return row as unknown as WireRow;
}

/** Wrap `spawn` so every JSON-RPC line between the brain and the app-server lands in `wire`. */
function teeSpawn(wire: WireRow[], note: (line: string) => void): typeof realSpawn {
  return ((cmd: string, args: readonly string[], opts: unknown) => {
    const child = (realSpawn as (c: string, a: readonly string[], o: unknown) => ChildProcess)(cmd, args, opts);
    note(`spawned ${cmd} ${args.slice(0, 3).join(" ")} … (${args.length} args) pid ${child.pid ?? "?"}`);
    let buf = "";
    child.stdout?.on("data", (c: Buffer | string) => {
      buf += typeof c === "string" ? c : c.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const row = line.trim() ? parseWireLine("in", line) : undefined;
        if (row) wire.push(row);
      }
    });
    if (child.stdin) {
      const w = child.stdin.write.bind(child.stdin);
      (child.stdin as { write: unknown }).write = (chunk: unknown, ...rest: unknown[]) => {
        for (const line of String(chunk).split("\n")) {
          const row = line.trim() ? parseWireLine("out", line) : undefined;
          if (row) wire.push(row);
        }
        return (w as (c: unknown, ...r: unknown[]) => boolean)(chunk, ...rest);
      };
    }
    return child;
  }) as typeof realSpawn;
}

// ------------------------------------------------------------------ records

export interface RunnerCall {
  readonly at: number;
  readonly ms: number;
  readonly name: string;
  readonly input: string;
  readonly kind: string;
  readonly ok: boolean;
  readonly blocked: boolean;
  readonly output?: string;
}

export interface RunRecord {
  readonly phase: "reflex-path" | "brain-path";
  readonly cmd: string;
  readonly request: string;
  readonly run: number;
  readonly liveId: string;
  readonly delegationId?: string;
  /** What the delegator handed the brain — must be `request` alone, or two utterances merged (a bench bug, not the brain's). */
  readonly delegationRequest?: string;
  readonly status: string;
  readonly summary?: string;
  readonly timedOut: boolean;
  /** ms relative to delegatedAt (the delegator's marks; `speechToDelegation` is delegatedAt − speechEndAt). */
  readonly t: {
    readonly eyesMs?: number;
    readonly speechToDelegation?: number;
    readonly firstThinking?: number;
    readonly firstToolPerDelegator?: number;
    readonly firstModelTool?: number;
    readonly firstAction?: number;
    readonly firstActionPerDelegator?: number;
    readonly firstCommentary?: number;
    readonly done: number;
    readonly wall: number;
  };
  /** The app-server wire for this delegation, ms relative to delegatedAt. */
  readonly wire: {
    readonly turnStartSent?: number;
    readonly turnStartAck?: number;
    readonly userMessage?: number;
    readonly firstReasoningCompleted?: number;
    readonly firstAgentMessageDelta?: number;
    readonly firstAgentMessageCompleted?: number;
    readonly firstMcpToolStarted?: number;
    readonly firstMcpTool?: string;
    readonly turnCompleted?: number;
    readonly turnStatus?: string;
    readonly promptChars?: number;
    readonly images?: number;
    readonly tokenUsage?: { total?: number; last?: number; window?: number | null };
    readonly mcpToolCalls: number;
    readonly mcpTools: readonly string[];
    readonly reasoningItems: number;
    readonly agentMessages: number;
  };
  /** MCP tool calls + Codex shell commands + agent messages: each one model generation (reasoningItems is the cross-check). */
  readonly generations: number;
  /** Gaps > 300 ms between consecutive model events (the model's own time), ms. */
  readonly generationGapsMs: readonly number[];
  readonly firstWords: { readonly firstThinkingStep?: string; readonly firstReasoningSummary?: string; readonly firstAgentMessage?: string; readonly firstCommentary?: string };
  readonly runnerCalls: readonly (RunnerCall & { readonly rel: number; readonly preBrain: boolean })[];
  readonly codexShell: readonly { readonly rel: number; readonly command: string; readonly exitCode?: number | null; readonly out?: string }[];
  readonly toolCount: number;
  /** The model's tool calls in order; a suffix says what came back: `(err)`, `(blocked)`, `(asked)` for a confirmation question. */
  readonly toolNames: readonly string[];
  /** Acting calls that returned ok, how many were followed by a screenshot/zoom as the next model call (the verifying shot the observation line is meant to make unnecessary), and how many carried a `now:` line. */
  readonly actingCalls: number;
  readonly verificationShots: number;
  readonly observedResults: number;
  /** The app-server thread this run's turn went out on (wire only). */
  readonly threadId?: string;
  /**
   * 1 when this run's turn ran on a different thread than the previous turn's (a
   * rollover between the two, wherever its `thread/start` landed); with no wire,
   * the count of fresh-thread log lines inside the run's window.
   */
  readonly rollovers: number;
  readonly bootstrap: { readonly calls: readonly string[]; readonly npmRunStatus: boolean; readonly noSuchFile: readonly string[] };
  readonly steps: readonly { readonly rel: number; readonly kind: string; readonly text?: string; readonly tool?: string }[];
  readonly logLines: readonly string[];
}

export interface AnalyzeInput {
  readonly phase: RunRecord["phase"];
  readonly cmd: BenchCommand;
  readonly run: number;
  readonly liveId: string;
  readonly delegation: Delegation | undefined;
  readonly timedOut: boolean;
  /** Wall clock when the delegation was emitted (the fallback base) and when the run ended. */
  readonly t0: number;
  readonly t1: number;
  readonly wire: readonly WireRow[];
  readonly runnerCalls: readonly RunnerCall[];
  readonly logLines: readonly { at: number; level: string; scope: string; message: string }[];
  readonly commentary: readonly string[];
  /** The thread the previous turn in this process went out on (the start thread before the first run); decides `rollovers`. */
  readonly prevThreadId?: string | undefined;
}

const rel = (base: number, v: number | undefined): number | undefined => (v === undefined ? undefined : v - base);

/** One run's raw material → its record. Pure; the tests feed it by hand. */
export function analyzeRun(input: AnalyzeInput): RunRecord {
  const { phase, cmd, run, liveId, delegation: d, timedOut, t0, t1, wire, runnerCalls, logLines } = input;
  const timings = (d?.timings ?? { delegatedAt: t0 }) as DelegationTimingsExtra;
  const base = timings.delegatedAt;

  const turnStart = wire.find((r) => r.dir === "out" && r.method === "turn/start");
  const turnStartAck = turnStart ? wire.find((r) => r.dir === "in" && r.id === turnStart.id && r.method === undefined) : undefined;
  const after = turnStart ? wire.filter((r) => r.at >= turnStart.at) : [];
  const userMessage = after.find((r) => r.method === "item/started" && r.itemType === "userMessage");
  const firstReasoningDone = after.find((r) => r.method === "item/completed" && r.itemType === "reasoning");
  const firstDelta = after.find((r) => r.method === "item/agentMessage/delta");
  const firstAgentMessage = after.find((r) => r.method === "item/completed" && r.itemType === "agentMessage");
  const firstMcpStarted = after.find((r) => r.method === "item/started" && r.itemType === "mcpToolCall");
  const turnCompleted = after.find((r) => r.method === "turn/completed");
  const usage = [...after].reverse().find((r) => r.tokenUsage);
  const completed = (type: string): WireRow[] => after.filter((r) => r.method === "item/completed" && r.itemType === type);
  const mcpItems = completed("mcpToolCall");
  const reasoningItems = completed("reasoning");
  const agentMessages = completed("agentMessage");
  const codexShell = completed("commandExecution").map((r) => ({ rel: r.at - base, command: r.command ?? "", ...(r.exitCode !== undefined ? { exitCode: r.exitCode } : {}), ...(r.text ? { out: r.text } : {}) }));

  // The eyes' shot is the engine's, not the brain's: before the turn went out, or (no wire: a
  // stand-in brain) a screenshot that is the very first call within the first moment.
  const calls = runnerCalls.map((c, i) => ({ ...c, rel: c.at - base, preBrain: turnStart ? c.at < turnStart.at : i === 0 && c.name === "screenshot" && c.at - base < 1500 }));
  const modelCalls = calls.filter((c) => !c.preBrain);
  const firstModelTool = modelCalls[0];
  // The first action: an acting tool that returned ok — not an error, not a confirmation question
  // (`ok` is false for both; the delegator's stamp refuses a `confirm` step the same way).
  const firstAction = modelCalls.find((c) => ACTING_TOOLS.has(c.name) && c.ok && c.kind !== "question");
  // P1 of the speed pass: an acting call followed by a shot is the model verifying by eye; a `now:` line in the result is the observation that should make that shot unnecessary.
  const actingOk = modelCalls.filter((c) => ACTING_TOOLS.has(c.name) && c.ok && c.kind !== "question");
  const verificationShots = modelCalls.filter((c, i) => ACTING_TOOLS.has(c.name) && c.ok && c.kind !== "question" && (modelCalls[i + 1]?.name === "screenshot" || modelCalls[i + 1]?.name === "zoom")).length;
  const observedResults = actingOk.filter((c) => /(^|\n)now: /.test(c.output ?? "")).length;
  const steps = (d?.steps ?? []).map((s: DelegationStep) => ({ rel: s.at - base, kind: s.kind, ...(s.text ? { text: s.text.slice(0, 300) } : {}), ...(s.tool ? { tool: s.tool.name } : {}) }));
  const everything = [...calls.map((c) => `${c.name} ${c.input}`), ...codexShell.map((c) => `shell ${c.command}`)];
  const noSuchFile = calls.filter((c) => c.kind === "error" && !c.blocked && FILE_TOOLS.has(c.name) && NO_SUCH_FILE_RE.test(c.output ?? "")).map((c) => `${c.name} ${c.input.slice(0, 100)} → ${(c.output ?? "").slice(0, 80)}`);
  // Rollovers: with a wire, this turn's thread against the previous turn's; without one, the log's fresh-thread line.
  const threadId = turnStart?.threadId;
  const rolloverLogLines = logLines.filter((l) => ROLLOVER_LOG_RE.test(l.message)).length;
  const rollovers = threadId !== undefined && input.prevThreadId !== undefined ? (threadId === input.prevThreadId ? 0 : 1) : rolloverLogLines;

  // Model events in order: the task landing, every model tool, every shell command, the final
  // message, done. A gap over GENERATION_GAP_MIN_MS between two of them is the model thinking.
  const events = [...new Set([...modelCalls.map((c) => c.rel), ...codexShell.map((c) => c.rel), ...(firstAgentMessage ? [firstAgentMessage.at - base] : []), ...(timings.doneAt !== undefined ? [timings.doneAt - base] : [])])].sort((a, b) => a - b);
  const generationGapsMs: number[] = [];
  let prev = userMessage ? userMessage.at - base : 0;
  for (const e of events) {
    if (e - prev > GENERATION_GAP_MIN_MS) generationGapsMs.push(e - prev);
    prev = e;
  }

  const doneRel = rel(base, timings.doneAt) ?? t1 - base;
  const firstThinkingStep = steps.find((s) => s.kind === "thinking")?.text;
  const firstCommentaryStep = steps.find((s) => s.kind === "commentary")?.text ?? input.commentary[0];
  return {
    phase,
    cmd: cmd.id,
    request: cmd.text,
    run,
    liveId,
    ...(d ? { delegationId: d.id, delegationRequest: d.request } : {}),
    status: d?.status ?? "unknown",
    ...(d?.summary ? { summary: d.summary } : {}),
    timedOut,
    t: {
      ...(timings.eyesMs !== undefined ? { eyesMs: timings.eyesMs } : {}),
      ...(timings.speechEndAt !== undefined ? { speechToDelegation: base - timings.speechEndAt } : {}),
      ...(timings.firstThinkingAt !== undefined ? { firstThinking: timings.firstThinkingAt - base } : {}),
      ...(timings.firstToolAt !== undefined ? { firstToolPerDelegator: timings.firstToolAt - base } : {}),
      ...(firstModelTool ? { firstModelTool: firstModelTool.rel } : {}),
      ...(firstAction ? { firstAction: firstAction.rel } : timings.firstActionAt !== undefined ? { firstAction: timings.firstActionAt - base } : {}),
      ...(timings.firstActionAt !== undefined ? { firstActionPerDelegator: timings.firstActionAt - base } : {}),
      ...(timings.firstCommentaryAt !== undefined ? { firstCommentary: timings.firstCommentaryAt - base } : {}),
      done: doneRel,
      wall: t1 - t0,
    },
    wire: {
      ...(turnStart ? { turnStartSent: turnStart.at - base } : {}),
      ...(turnStartAck ? { turnStartAck: turnStartAck.at - base } : {}),
      ...(userMessage ? { userMessage: userMessage.at - base } : {}),
      ...(firstReasoningDone ? { firstReasoningCompleted: firstReasoningDone.at - base } : {}),
      ...(firstDelta ? { firstAgentMessageDelta: firstDelta.at - base } : {}),
      ...(firstAgentMessage ? { firstAgentMessageCompleted: firstAgentMessage.at - base } : {}),
      ...(firstMcpStarted ? { firstMcpToolStarted: firstMcpStarted.at - base, ...(firstMcpStarted.tool ? { firstMcpTool: firstMcpStarted.tool } : {}) } : {}),
      ...(turnCompleted ? { turnCompleted: turnCompleted.at - base, ...(turnCompleted.turnStatus ? { turnStatus: turnCompleted.turnStatus } : {}) } : {}),
      ...(turnStart?.inputChars !== undefined ? { promptChars: turnStart.inputChars } : {}),
      ...(turnStart?.images !== undefined ? { images: turnStart.images } : {}),
      ...(usage?.tokenUsage ? { tokenUsage: usage.tokenUsage } : {}),
      mcpToolCalls: mcpItems.length,
      mcpTools: mcpItems.map((r) => `${r.tool ?? "?"}${r.status && r.status !== "completed" ? `(${r.status})` : ""}`),
      reasoningItems: reasoningItems.length,
      agentMessages: agentMessages.length,
    },
    generations: mcpItems.length + codexShell.length + agentMessages.length,
    generationGapsMs,
    firstWords: {
      ...(firstThinkingStep ? { firstThinkingStep } : {}),
      ...(firstReasoningDone?.text ? { firstReasoningSummary: firstReasoningDone.text } : {}),
      ...(firstAgentMessage?.text ? { firstAgentMessage: firstAgentMessage.text } : {}),
      ...(firstCommentaryStep ? { firstCommentary: firstCommentaryStep } : {}),
    },
    runnerCalls: calls,
    codexShell,
    toolCount: modelCalls.length,
    toolNames: modelCalls.map((c) => `${c.name}${c.blocked ? "(blocked)" : c.kind === "question" ? "(asked)" : c.ok ? "" : "(err)"}`),
    actingCalls: actingOk.length,
    verificationShots,
    observedResults,
    ...(threadId !== undefined ? { threadId } : {}),
    rollovers,
    bootstrap: {
      calls: everything.filter((s) => BOOTSTRAP_RE.test(s)).map((s) => s.slice(0, 160)),
      npmRunStatus: everything.some((s) => /npm run status/.test(s)),
      noSuchFile,
    },
    steps,
    logLines: logLines.map((l) => `+${((l.at - base) / 1000).toFixed(2)}s ${l.level} ${l.scope}: ${l.message.slice(0, 220)}`),
  };
}

// ------------------------------------------------------------------ statistics

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? Number.NaN;
}

export interface Stat {
  readonly n: number;
  readonly median: number;
  readonly p95: number;
  readonly min: number;
  readonly max: number;
}

export function stat(values: readonly number[]): Stat {
  const xs = values.filter((v) => Number.isFinite(v));
  return { n: xs.length, median: percentile(xs, 50), p95: percentile(xs, 95), min: xs.length ? Math.min(...xs) : Number.NaN, max: xs.length ? Math.max(...xs) : Number.NaN };
}

export const METRICS = ["firstThinking", "firstModelTool", "firstAction", "firstCommentary", "done"] as const;
export type Metric = (typeof METRICS)[number];

export interface CommandSummary {
  readonly cmd: string;
  readonly n: number;
  readonly statuses: Record<string, number>;
  readonly metrics: Record<Metric, Stat>;
  readonly generations: Stat;
  readonly toolCalls: Stat;
  readonly toolNames: Record<string, number>;
}

export interface BenchSummary {
  readonly brainPath: { readonly overall: CommandSummary; readonly perCommand: readonly CommandSummary[] };
  /** Generations per command on the brain path (the same numbers as brainPath.overall.generations, under the name the speed pass tracks). */
  readonly generationsPerCommand: Stat;
  /** Acting calls followed by a verifying screenshot/zoom: count and share (target ≤ 15 %). */
  readonly verificationShots: { readonly acting: number; readonly shots: number; readonly share: number };
  /** Acting calls whose result carried the observation line: count and share (target ≥ 95 % with Settings.observe on). */
  readonly observedResults: { readonly acting: number; readonly withLine: number; readonly share: number };
  readonly reflexPath: readonly { readonly cmd: string; readonly status: string; readonly doneMs: number; readonly firstActionMs?: number; readonly summary?: string }[];
  readonly generationGapMs: Stat;
  readonly toolRoundTripMs: Stat;
  readonly rollovers: number;
  readonly bootstrapCalls: number;
  readonly npmRunStatusRuns: number;
  readonly noSuchFile: number;
  readonly narrationFirst: number;
  readonly timedOut: number;
  readonly speechToDelegationMs: Stat;
}

function summarizeCommand(cmd: string, recs: readonly RunRecord[]): CommandSummary {
  const metrics = {} as Record<Metric, Stat>;
  for (const m of METRICS) metrics[m] = stat(recs.map((r) => r.t[m]).filter((v): v is number => typeof v === "number"));
  const toolNames: Record<string, number> = {};
  const statuses: Record<string, number> = {};
  for (const r of recs) {
    statuses[r.status] = (statuses[r.status] ?? 0) + 1;
    for (const n of r.toolNames) toolNames[n] = (toolNames[n] ?? 0) + 1;
  }
  return { cmd, n: recs.length, statuses, metrics, generations: stat(recs.map((r) => r.generations)), toolCalls: stat(recs.map((r) => r.toolCount)), toolNames };
}

export function summarize(records: readonly RunRecord[]): BenchSummary {
  const brain = records.filter((r) => r.phase === "brain-path");
  const cmds = [...new Set(brain.map((r) => r.cmd))];
  const acting = brain.reduce((n, r) => n + r.actingCalls, 0);
  const shots = brain.reduce((n, r) => n + r.verificationShots, 0);
  const withLine = brain.reduce((n, r) => n + r.observedResults, 0);
  return {
    brainPath: { overall: summarizeCommand("all", brain), perCommand: cmds.map((c) => summarizeCommand(c, brain.filter((r) => r.cmd === c))) },
    generationsPerCommand: stat(brain.map((r) => r.generations)),
    verificationShots: { acting, shots, share: acting ? shots / acting : 0 },
    observedResults: { acting, withLine, share: acting ? withLine / acting : 0 },
    reflexPath: records.filter((r) => r.phase === "reflex-path").map((r) => ({ cmd: r.cmd, status: r.status, doneMs: r.t.done, ...(r.t.firstAction !== undefined ? { firstActionMs: r.t.firstAction } : {}), ...(r.summary ? { summary: r.summary } : {}) })),
    generationGapMs: stat(brain.flatMap((r) => r.generationGapsMs)),
    toolRoundTripMs: stat(brain.flatMap((r) => r.runnerCalls.filter((c) => !c.preBrain && !c.blocked).map((c) => c.ms))),
    rollovers: brain.reduce((n, r) => n + r.rollovers, 0),
    bootstrapCalls: brain.reduce((n, r) => n + r.bootstrap.calls.length, 0),
    npmRunStatusRuns: brain.filter((r) => r.bootstrap.npmRunStatus).length,
    noSuchFile: brain.reduce((n, r) => n + r.bootstrap.noSuchFile.length, 0),
    // The first generation was words, not a tool: a message streamed before the first model tool.
    narrationFirst: brain.filter((r) => r.wire.firstAgentMessageDelta !== undefined && r.t.firstModelTool !== undefined && r.wire.firstAgentMessageDelta < r.t.firstModelTool).length,
    timedOut: brain.filter((r) => r.timedOut).length,
    speechToDelegationMs: stat(records.map((r) => r.t.speechToDelegation).filter((v): v is number => typeof v === "number")),
  };
}

export interface BrainBenchReport {
  readonly meta: Record<string, unknown>;
  readonly records: readonly RunRecord[];
  readonly summary: BenchSummary;
  /** Deltas against a previous report (--compare FILE), when one was given. */
  readonly compare?: CompareReport;
}

export interface CompareRow {
  readonly cmd: string;
  /** This run's median minus the baseline's, ms (negative = faster); undefined when either side lacks the command. */
  readonly firstActionMs?: number;
  readonly doneMs?: number;
  readonly generations?: number;
}

export interface CompareReport {
  readonly baseline: string;
  readonly baselineStartedAt?: string;
  readonly rows: readonly CompareRow[];
  readonly generationsP95: { readonly before: number; readonly after: number };
  readonly verificationShare: { readonly before: number | undefined; readonly after: number };
}

/** This report against an older one: per-command median deltas of the first action, done and the model steps, plus the two headline shares. Pure. */
export function compareReports(current: BrainBenchReport, baseline: BrainBenchReport, baselinePath: string): CompareReport {
  const before = new Map(baseline.summary.brainPath.perCommand.map((c) => [c.cmd, c]));
  const delta = (a: number | undefined, b: number | undefined): number | undefined => (a === undefined || b === undefined || !Number.isFinite(a) || !Number.isFinite(b) ? undefined : a - b);
  const rows: CompareRow[] = [...current.summary.brainPath.perCommand, current.summary.brainPath.overall].map((c) => {
    const b = c.cmd === "all" ? baseline.summary.brainPath.overall : before.get(c.cmd);
    const firstActionMs = delta(c.metrics.firstAction.median, b?.metrics.firstAction.median);
    const doneMs = delta(c.metrics.done.median, b?.metrics.done.median);
    const generations = delta(c.generations.median, b?.generations.median);
    return { cmd: c.cmd, ...(firstActionMs !== undefined ? { firstActionMs } : {}), ...(doneMs !== undefined ? { doneMs } : {}), ...(generations !== undefined ? { generations } : {}) };
  });
  // Older reports predate these fields; read what is there.
  const bs = baseline.summary as Partial<BenchSummary>;
  return {
    baseline: baselinePath,
    ...(typeof baseline.meta["startedAt"] === "string" ? { baselineStartedAt: baseline.meta["startedAt"] } : {}),
    rows,
    generationsP95: { before: bs.generationsPerCommand?.p95 ?? baseline.summary.brainPath.overall.generations.p95, after: current.summary.generationsPerCommand.p95 },
    verificationShare: { before: bs.verificationShots?.share, after: current.summary.verificationShots.share },
  };
}

// ------------------------------------------------------------------ the run

/** A stand-in for Codex whose real instance can only be built once the engine (and its runner) exists. */
function lazyBrain(kind: string, make: () => Brain): Brain {
  let real: Brain | undefined;
  return {
    get kind() {
      return real?.kind ?? kind;
    },
    get detail(): string {
      return real?.detail ?? "not started";
    },
    start: async () => {
      real = make();
      return real.start();
    },
    handle: (task: BrainTask, sink: BrainSink): Promise<BrainResult> => (real ? real.handle(task, sink) : Promise.resolve({ status: "failed", error: "brain not started" })),
    cancel: () => real?.cancel() ?? Promise.resolve(),
    stop: () => real?.stop() ?? Promise.resolve(),
    warmUp: () => real?.warmUp?.() ?? Promise.resolve({ warm: false, detail: "not started" }),
  };
}

/**
 * Run the benchmark and return the report. `benchBrain` below prints it; tests
 * call this with a stand-in brain.
 */
export async function runBrainBench(opts: BrainBenchOptions): Promise<BrainBenchReport> {
  const print = opts.print ?? ((line: string) => (opts.json ? console.error(line) : console.log(line)));
  const runs = Math.max(1, opts.runs || 1);
  const commands = opts.only?.length ? BRAIN_BENCH_COMMANDS.filter((c) => opts.only?.includes(c.id)) : BRAIN_BENCH_COMMANDS;
  const delegationTimeoutMs = opts.delegationTimeoutMs ?? 180_000;
  const base = readConfig();
  const effort: Effort = opts.effort ?? base.brainEffort;
  // The real brain: Codex when it is installed and signed in (the same construction as the engine's own
  // `auto` → codex, plus the wire tee). Anything else `auto` would pick costs API dollars, so without
  // --allow-api-spend the bench stops here, before an engine or a brain is started.
  const standIn = opts.brain;
  const probe = standIn ? undefined : (opts.probe ?? (await probeCodex({ bin: base.codexBin })));
  const useCodex = probe !== undefined && probe.bin !== undefined && probe.signedIn;
  if (!standIn && !useCodex && !opts.allowApiSpend) {
    throw new Error(`Codex is not available (${probe?.detail ?? "no probe"}); bench --brain runs on Kevin's ChatGPT plan only — the auto brain would spend API dollars. Pass --allow-api-spend to run on it anyway.`);
  }
  const dir = mkdtempSync(join(tmpdir(), "jh-bb-"));
  const config: JarheadConfig = {
    ...base,
    openaiApiKey: base.openaiApiKey || "sk-bench-never-used",
    brain: "auto",
    brainEffort: effort,
    stateDir: join(dir, "state"),
    socketPath: join(dir, "state", "j.sock"),
  };

  // Every log line, timestamped: per-run windows (rollovers, the delegator's own line) come from here.
  // Info lines stay off stdout (the JSON report goes there); warnings and errors still reach stderr.
  const logLines: { at: number; level: LogLevel; scope: string; message: string }[] = [];
  setLogLevel("debug");
  replaceDefaultSink((level, scope, message) => {
    logLines.push({ at: Date.now(), level, scope, message });
    if (level === "warn" || level === "error") process.stderr.write(`${new Date().toISOString().slice(11, 23)} ${level.padEnd(5)} ${scope}: ${message}\n`);
  });
  const say = (s: string): void => {
    logLines.push({ at: Date.now(), level: "info", scope: "bench", message: s });
    print(`${new Date().toISOString().slice(11, 23)} ${s}`);
  };

  const screen = benchScreenPng();
  const live = new BenchLive();
  const hands = new WikiHands(screen.png);
  const wire: WireRow[] = [];
  let engine: Engine;
  let codexDetail = "";
  // Without Codex (and with --allow-api-spend) the engine's `auto` picks whatever is next; the report
  // says so, and there is no wire then.
  const brain: Brain | undefined =
    typeof standIn === "function"
      ? lazyBrain("stand-in", () => standIn(engine.runner))
      : (standIn ??
        (useCodex
          ? lazyBrain("codex", () => new CodexBrain({ runner: engine.runner, probe, stateDir: config.stateDir, socketPath: config.socketPath, ...(base.brainModel.trim() ? { model: base.brainModel.trim() } : {}), effort, spawnImpl: teeSpawn(wire, say) }))
          : undefined));
  engine = new Engine({ config, connectors: [], ...(brain ? { brain } : {}), makeLive: () => live as unknown as LiveSession, hands });
  if (useCodex) codexDetail = probe.detail;

  // Every runner call recorded; the tools that could act outside the canned hands answered with an error.
  const runnerCalls: RunnerCall[] = [];
  const runner: ToolRunner = engine.runner;
  const realRun = runner.run.bind(runner);
  runner.run = async (name: string, input: unknown): Promise<RunOutcome> => {
    const at = Date.now();
    const inputStr = JSON.stringify(input ?? {}).slice(0, 300);
    if (BLOCKED_TOOLS.has(name)) {
      const message = `${name} is unavailable in this session (read-only benchmark); do not retry it — use the other tools or answer from what you can see.`;
      runnerCalls.push({ at, ms: 0, name, input: inputStr, kind: "error", ok: false, blocked: true, output: message });
      return { result: { kind: "error", message }, ms: 0 };
    }
    const out = await realRun(name, input);
    const r = out.result;
    const output = r.kind === "text" ? r.text.slice(0, 300) : r.kind === "error" ? r.message.slice(0, 300) : r.kind === "image" ? `${r.width}x${r.height} image` : r.question.slice(0, 300);
    // ok = the tool did its thing: a text or an image. An error did nothing; a `question` (the
    // confirmation handshake asking before a Send/Delete-shaped click) did nothing yet either.
    runnerCalls.push({ at, ms: Date.now() - at, name, input: inputStr, kind: r.kind, ok: r.kind === "text" || r.kind === "image", blocked: false, output });
    return out;
  };

  const load = loadavg().map((v) => v.toFixed(1)).join(" ");
  say(`bench --brain: ${runs} run(s) per command on the brain path${opts.noReflex ? " (reflexes off throughout)" : ", after the reflex path"}; effort ${effort}; load average ${load}`);
  say(`brain: ${opts.brain ? `stand-in (${brain?.kind ?? "?"})` : useCodex ? "REAL Codex through the product's resident app-server — the turns run on Kevin's ChatGPT login and cost his ChatGPT plan, not dollars" : `auto (Codex is not available here: ${probe?.detail ?? "?"}) — --allow-api-spend given: the turns cost REAL API DOLLARS on whatever brain auto picks`}`);
  say(`hands: canned (Safari in front on ${WIKI_TITLE}; screen ${screen.source === FIXTURE_PNG ? "fixture" : screen.source}, ${pngSize(screen.png).width}x${pngSize(screen.png).height}); Live: stand-in (no socket, no billing); nothing on this Mac is touched; blocked tools: ${[...BLOCKED_TOOLS].join(", ")}`);

  const meta: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    node: process.version,
    loadAvgBefore: loadavg().map((v) => Math.round(v * 10) / 10),
    runsPerCommand: runs,
    effort,
    reflexPhase: !opts.noReflex,
    commands: commands.map((c) => c.id),
    screen: screen.source,
    blockedTools: [...BLOCKED_TOOLS],
    stateDir: config.stateDir,
    costs: opts.brain ? "nothing (stand-in brain)" : useCodex ? "Kevin's ChatGPT plan (Codex turns); no API dollars" : "REAL API DOLLARS on the brain auto picked (--allow-api-spend)",
  };

  const records: RunRecord[] = [];
  const t0 = Date.now();
  await engine.start();
  await engine.ready();
  say(`engine ready in ${Date.now() - t0} ms; brain: ${engine.brainInfo.kind} — ${engine.brainInfo.detail}`);
  meta["brainKind"] = engine.brainInfo.kind;
  meta["brainDetailAtReady"] = engine.brainInfo.detail;
  // The second gate, after the engine chose: only Codex (or a stand-in) runs without --allow-api-spend,
  // whatever the probe said a moment ago.
  if (!standIn && !opts.allowApiSpend && (engine.brainInfo.kind !== "codex" || !engine.brainInfo.ready)) {
    await Promise.race([engine.stop(), new Promise((r) => setTimeout(r, 8000))]);
    throw new Error(`Codex is not available (${engine.brainInfo.detail}; probe: ${codexDetail || probe?.detail || "?"}); bench --brain runs on Kevin's ChatGPT plan only — pass --allow-api-spend to run on the ${engine.brainInfo.kind} brain (API dollars).`);
  }
  // The thread the last turn went out on: the start thread first; a run whose turn/start names another is a rollover.
  let lastThreadId: string | undefined;
  try {
    engine.updateSettings({ idleSleepMinutes: 0, reflexes: !opts.noReflex, ...(opts.observe !== undefined ? { observe: opts.observe } : {}) });
    meta["observe"] = engine.snapshot().settings.observe;
    await engine.wake("bench");

    // The product's resident thread: wait for the warm app-server so the first delegation is the warm path.
    if (useCodex) {
      const warmWait = opts.warmWaitMs ?? 150_000;
      const tWarm = Date.now();
      while (Date.now() - tWarm < warmWait && !/warm app-server \(thread/.test(engine.brainInfo.detail)) await new Promise((r) => setTimeout(r, 250));
      const warm = /warm app-server \(thread/.test(engine.brainInfo.detail);
      const warmLine = logLines.find((l) => /warm app-server up after/.test(l.message));
      meta["warm"] = warm;
      meta["warmWaitMs"] = Date.now() - tWarm;
      meta["warmLine"] = warmLine?.message;
      const ts = wire.find((r) => r.dir === "out" && r.method === "thread/start");
      const tsAck = ts ? wire.find((r) => r.dir === "in" && r.id === ts.id && r.method === undefined) : undefined;
      const init = wire.find((r) => r.dir === "out" && r.method === "initialize");
      const initAck = init ? wire.find((r) => r.dir === "in" && r.id === init.id && r.method === undefined) : undefined;
      meta["appServer"] = { initializeMs: init && initAck ? initAck.at - init.at : undefined, threadStartMs: ts && tsAck ? tsAck.at - ts.at : undefined, developerInstructionsChars: ts?.inputChars, thread: tsAck?.text };
      lastThreadId = tsAck?.threadId;
      say(`brain: ${engine.brainInfo.detail} (${warm ? `warm after ${meta["warmWaitMs"]} ms of waiting` : `NOT warm after ${meta["warmWaitMs"]} ms; the runs go through exec`})`);
    }

    const waitForDelegation = (liveId: string): Promise<Delegation | undefined> =>
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          engine.off("event", onEvent as never);
          resolve(undefined);
        }, delegationTimeoutMs);
        const onEvent = (e: { type: string; snapshot?: { delegations: readonly Delegation[] } }): void => {
          if (e.type !== "snapshot") return;
          const d = e.snapshot?.delegations.find((x) => x.liveId === liveId);
          if (d && d.status !== "running") {
            clearTimeout(timer);
            engine.off("event", onEvent as never);
            resolve(d);
          }
        };
        engine.on("event", onEvent as never);
      });

    const runOne = async (phase: RunRecord["phase"], cmd: BenchCommand, run: number): Promise<RunRecord> => {
      const liveId = `${phase}_${cmd.id}_${run}`;
      const callsBefore = runnerCalls.length;
      const wireBefore = wire.length;
      const logBefore = logLines.length;
      const commentaryBefore = live.commentary.length;
      hands.typed = ""; // every run starts with an empty search field
      const now = await live.nextUtterance();
      const start = Date.now();
      say(`▶ ${liveId}: "${cmd.text}"`);
      const finished = waitForDelegation(liveId);
      // Live heard the whole utterance (ending now) and delegates on it.
      live.emit("inputTranscript", ` ${cmd.text}`, now - BenchLive.UTTERANCE_MS, now);
      live.emit("delegation", liveId, "client", now);
      let d = await finished;
      let timedOut = false;
      if (!d) {
        timedOut = true;
        say(`  ${liveId}: no finish within ${delegationTimeoutMs / 1000}s; interrupting`);
        await engine.command({ type: "interrupt" });
        await new Promise((r) => setTimeout(r, 1500));
        d = engine.snapshot().delegations.find((x) => x.liveId === liveId);
      }
      const end = Date.now();
      const rec = analyzeRun({ phase, cmd, run, liveId, delegation: d, timedOut, t0: start, t1: end, wire: wire.slice(wireBefore), runnerCalls: runnerCalls.slice(callsBefore), logLines: logLines.slice(logBefore).filter((l) => l.scope !== "bench"), commentary: live.commentary.slice(commentaryBefore), prevThreadId: lastThreadId });
      if (rec.threadId !== undefined) lastThreadId = rec.threadId;
      const f = (v: number | undefined): string => (v === undefined ? "-" : String(Math.round(v)));
      if (rec.delegationRequest !== undefined && rec.delegationRequest !== cmd.text) say(`  ${liveId}: WARNING the delegation carried "${rec.delegationRequest}" — utterances merged; the row is not this command alone`);
      say(`  ${liveId}: ${rec.status}${timedOut ? " (timed out)" : ""} in ${f(rec.t.done)} ms — thinking@${f(rec.t.firstThinking)} tool@${f(rec.t.firstModelTool)} action@${f(rec.t.firstAction)} said@${f(rec.t.firstCommentary)}; ${rec.generations} model step(s), ${rec.toolCount} tool call(s): ${rec.toolNames.join(", ") || "-"}${rec.rollovers ? `; ${rec.rollovers} rollover(s)` : ""}${rec.bootstrap.calls.length ? `; bootstrap×${rec.bootstrap.calls.length}` : ""}${rec.bootstrap.noSuchFile.length ? `; no-such-file×${rec.bootstrap.noSuchFile.length}` : ""}${rec.summary ? ` — "${rec.summary.slice(0, 100)}"` : ""}`);
      return rec;
    };

    // Phase 1: the product path, reflexes on, for the commands the grammar catches (no model turn).
    if (!opts.noReflex) {
      for (const cmd of commands.filter((c) => parseReflex(c.text) !== undefined)) {
        records.push(await runOne("reflex-path", cmd, 1));
        await new Promise((r) => setTimeout(r, 300));
      }
      engine.updateSettings({ reflexes: false });
      say(`reflexes off; ${commands.length} command(s) × ${runs} run(s) on the brain`);
    }
    // Phase 2: the brain path, every command, reflexes off.
    for (let run = 1; run <= runs; run++) {
      for (const cmd of commands) {
        records.push(await runOne("brain-path", cmd, run));
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  } finally {
    meta["loadAvgAfter"] = loadavg().map((v) => Math.round(v * 10) / 10);
    meta["finishedAt"] = new Date().toISOString();
    meta["brainDetailEnd"] = engine.brainInfo.detail;
    meta["handsOps"] = hands.calls.reduce<Record<string, number>>((m, c) => ((m[c.op] = (m[c.op] ?? 0) + 1), m), {});
    // Rollovers over the whole process, off the wire: every thread/start after the first one (wherever it
    // landed, inside a run or between two); the log's fresh-thread lines are the cross-check and the fallback.
    const threadStarts = wire.filter((r) => r.dir === "out" && r.method === "thread/start").length;
    const rolloverLogLines = logLines.filter((l) => ROLLOVER_LOG_RE.test(l.message)).length;
    meta["threads"] = [...new Set(wire.filter((r) => r.dir === "in" && r.threadId !== undefined && r.method === undefined).map((r) => r.threadId))];
    meta["contextRollovers"] = threadStarts > 0 ? threadStarts - 1 : rolloverLogLines;
    meta["rolloverLogLines"] = rolloverLogLines;
    meta["execFallbacks"] = logLines.filter((l) => /falling back to codex exec|runs on exec/.test(l.message)).length;
    await Promise.race([engine.stop(), new Promise((r) => setTimeout(r, 10_000))]);
  }
  let report: BrainBenchReport = { meta, records, summary: summarize(records) };
  if (opts.compare) {
    try {
      const baseline = JSON.parse(readFileSync(opts.compare, "utf8")) as BrainBenchReport;
      report = { ...report, compare: compareReports(report, baseline, opts.compare) };
    } catch (e) {
      say(`--compare ${opts.compare}: not read (${(e as Error).message}); no deltas`);
    }
  }
  if (opts.out) {
    writeFileSync(opts.out, JSON.stringify(report, null, 2));
    say(`wrote ${opts.out}`);
  }
  return report;
}

// ------------------------------------------------------------------ printing

const sec = (v: number): string => (Number.isFinite(v) ? (v / 1000).toFixed(1) : "-");
const ms = (v: number): string => (Number.isFinite(v) ? String(Math.round(v)) : "-");

/** The tables, as `pnpm jarhead bench --brain` prints them. */
export function renderReport(report: BrainBenchReport): string[] {
  const { meta, summary } = report;
  const out: string[] = [];
  const pad = (s: string, n: number): string => s.padEnd(n);
  const cell = (s: Stat): string => `${sec(s.median).padStart(6)} /${sec(s.p95).padStart(6)}`;
  out.push("");
  out.push(`  brain path — seconds after the delegation, median / p95 (n runs per command); "1st action" is the first acting tool that returned ok`);
  out.push(`  ${pad("command", 20)}${"n".padStart(3)}  ${pad("1st thinking", 15)}${pad("1st tool", 15)}${pad("1st action", 15)}${pad("done", 15)}${pad("steps", 8)}tools`);
  for (const c of [...summary.brainPath.perCommand, summary.brainPath.overall]) {
    const m = c.metrics;
    out.push(`  ${pad(c.cmd, 20)}${String(c.n).padStart(3)}  ${cell(m.firstThinking)}  ${cell(m.firstModelTool)}  ${cell(m.firstAction)}  ${cell(m.done)}  ${ms(c.generations.median).padStart(3)}     ${ms(c.toolCalls.median).padStart(3)}${c.cmd === "all" ? "" : `  ${Object.entries(c.toolNames).map(([k, v]) => `${k}×${v}`).join(" ")}`}`);
  }
  const g = summary.generationGapMs;
  out.push("");
  out.push(`  model step gap (>${GENERATION_GAP_MIN_MS} ms between consecutive model events): median ${sec(g.median)} s, p95 ${sec(g.p95)} s, max ${sec(g.max)} s (n=${g.n}) — the per-generation cost`);
  out.push(`  tool round trip inside the runner: median ${ms(summary.toolRoundTripMs.median)} ms, p95 ${ms(summary.toolRoundTripMs.p95)} ms (n=${summary.toolRoundTripMs.n})`);
  out.push(`  context rollovers ${summary.rollovers}; wiki-bootstrap calls ${summary.bootstrapCalls}; npm run status in ${summary.npmRunStatusRuns} run(s); no-such-file errors ${summary.noSuchFile}; narration before the first tool in ${summary.narrationFirst} run(s); timed out ${summary.timedOut}`);
  const pctOf = (v: number): string => `${Math.round(v * 100)} %`;
  out.push(`  generations per command: median ${ms(summary.generationsPerCommand.median)}, p95 ${ms(summary.generationsPerCommand.p95)} (target p95 ≤ 4); acting calls followed by a verifying shot ${summary.verificationShots.shots}/${summary.verificationShots.acting} (${pctOf(summary.verificationShots.share)}, target ≤ 15 %); acting results carrying a now: line ${summary.observedResults.withLine}/${summary.observedResults.acting} (${pctOf(summary.observedResults.share)}; observe ${meta["observe"] === false ? "OFF — the A/B" : "on"})`);
  if (report.compare) {
    const c = report.compare;
    out.push("");
    out.push(`  against ${c.baseline}${c.baselineStartedAt ? ` (${c.baselineStartedAt})` : ""}: median deltas, this run minus the baseline (negative = faster)`);
    out.push(`  ${pad("command", 20)}${pad("1st action", 14)}${pad("done", 14)}steps`);
    const signed = (v: number | undefined, unit: string): string => (v === undefined ? "-" : `${v > 0 ? "+" : ""}${unit === "s" ? (v / 1000).toFixed(1) : Math.round(v)}${unit === "s" ? " s" : ""}`);
    for (const r of c.rows) out.push(`  ${pad(r.cmd, 20)}${pad(signed(r.firstActionMs, "s"), 14)}${pad(signed(r.doneMs, "s"), 14)}${signed(r.generations, "")}`);
    out.push(`  generations p95 ${ms(c.generationsP95.before)} → ${ms(c.generationsP95.after)}; verifying-shot share ${c.verificationShare.before === undefined ? "-" : pctOf(c.verificationShare.before)} → ${pctOf(c.verificationShare.after)}`);
  }
  if (summary.speechToDelegationMs.n) out.push(`  speech end → delegation: median ${ms(summary.speechToDelegationMs.median)} ms (n=${summary.speechToDelegationMs.n}) — the stand-in Live delegates the moment the utterance ends, so ≈ 0 here; on the real path this is Live's own transcription and decision time (the ledger has it)`);
  if (summary.reflexPath.length) {
    out.push("");
    out.push("  reflex path (reflexes on; the product path for these — no model turn)");
    for (const r of summary.reflexPath) out.push(`  ${pad(r.cmd, 20)} ${r.status.padEnd(8)} done in ${ms(r.doneMs)} ms${r.firstActionMs !== undefined ? `, action@${ms(r.firstActionMs)} ms` : ""}${r.summary ? ` — "${r.summary}"` : ""}`);
  }
  out.push("");
  out.push(`  brain: ${String(meta["brainDetailEnd"] ?? meta["brainDetailAtReady"] ?? "?")}`);
  out.push(`  effort ${String(meta["effort"])}; load average before ${(meta["loadAvgBefore"] as number[] | undefined)?.join(" ") ?? "?"}, after ${(meta["loadAvgAfter"] as number[] | undefined)?.join(" ") ?? "?"}; ${String(meta["costs"])}; state dir ${String(meta["stateDir"])}`);
  out.push("");
  return out;
}

/** `pnpm jarhead bench --brain`: run, print (or emit JSON), never touch the Mac. */
export async function benchBrain(opts: BrainBenchOptions): Promise<{ ok: boolean }> {
  let report: BrainBenchReport;
  try {
    report = await runBrainBench(opts);
  } catch (e) {
    console.error(`  ${(e as Error).message}`);
    return { ok: false };
  }
  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else for (const line of renderReport(report)) console.log(line);
  return { ok: report.summary.timedOut === 0 };
}
