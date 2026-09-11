import { classifyAction, logger, type ActionContext, type Decision } from "@jarhead/core";
import type { OverlayCommand } from "@jarhead/protocol";
import { NativeRequestError, type ElementInfo, type FocusedText, type FrontmostInfo, type NativeHands, type ScreenshotResult, type WindowInfo } from "./native.ts";
import { DEFAULT_SHOT_BUDGET, Screen, type ShotBudget } from "./screen.ts";
import { screencaptureFallback } from "./fallback.ts";
import type { DisplayInfo } from "./native.ts";

/**
 * Claude's computer toolset (`computer_toolset_20260801`, 17 members) plus a
 * handful of desktop tools, implemented over the native helper.
 *
 * Each member returns a ToolResult the caller renders for whichever model is
 * driving: as a `tool_result` image block for the Anthropic API, as MCP content
 * for Claude Code, as a function output plus an `input_image` item for OpenAI.
 * The policy check happens here, once, so every brain gets the same rules.
 */

const log = logger("hands");

export const COMPUTER_MEMBERS = [
  "screenshot", "zoom", "left_click", "right_click", "middle_click", "double_click", "triple_click",
  "left_click_drag", "mouse_move", "left_mouse_down", "left_mouse_up", "cursor_position", "scroll",
  "type", "key", "hold_key", "wait",
] as const;
export type ComputerMember = (typeof COMPUTER_MEMBERS)[number];

export const DESKTOP_TOOLS = ["open_app", "focus_app", "list_windows", "read_focused_text", "element_at", "frontmost_app"] as const;
export type DesktopTool = (typeof DESKTOP_TOOLS)[number];

export type ToolResult =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "image"; readonly pngBase64: string; readonly width: number; readonly height: number; readonly note?: string }
  | { readonly kind: "error"; readonly message: string }
  /** The action is allowed only after Kevin says yes. The brain must ask him and stop. */
  | { readonly kind: "needs-confirmation"; readonly question: string; readonly pendingId: string };

export interface ActionEvent {
  readonly member: string;
  readonly input: Record<string, unknown>;
  readonly points?: { readonly x: number; readonly y: number };
  readonly decision?: Decision;
  readonly ms: number;
  readonly ok: boolean;
}

export interface PendingConfirmation {
  readonly id: string;
  readonly description: string;
  readonly member: string;
  readonly input: Record<string, unknown>;
  readonly at: number;
}

/**
 * Confirmation is a two-delegation handshake: the tool refuses with a question,
 * Live asks Kevin, Kevin says "go ahead", the next delegation arms this state,
 * and the *same* action then runs once. A yes never carries over to a different
 * action, and it expires.
 */
export class ConfirmationState {
  pending: PendingConfirmation | undefined;
  private armed = false;
  private seq = 0;

  constructor(private readonly ttlMs = 3 * 60_000, private readonly now: () => number = Date.now) {}

  ask(description: string, member: string, input: Record<string, unknown>): PendingConfirmation {
    this.pending = { id: `confirm_${++this.seq}`, description, member, input, at: this.now() };
    this.armed = false;
    return this.pending;
  }

  /** Called when Kevin's new request reads as a yes. Returns what he is confirming. */
  arm(): PendingConfirmation | undefined {
    if (!this.pending || this.now() - this.pending.at > this.ttlMs) {
      this.pending = undefined;
      return undefined;
    }
    this.armed = true;
    return this.pending;
  }

  /** True once, for an action matching the pending one. */
  consume(member: string, input: Record<string, unknown>): boolean {
    if (!this.armed || !this.pending) return false;
    if (this.now() - this.pending.at > this.ttlMs) {
      this.clear();
      return false;
    }
    const same = this.pending.member === member && sameTarget(this.pending.input, input);
    if (!same) return false;
    this.clear();
    return true;
  }

  clear(): void {
    this.pending = undefined;
    this.armed = false;
  }
}

function sameTarget(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ca = a["coordinate"] as number[] | undefined;
  const cb = b["coordinate"] as number[] | undefined;
  if (ca && cb) return Math.abs((ca[0] ?? 0) - (cb[0] ?? 0)) <= 40 && Math.abs((ca[1] ?? 0) - (cb[1] ?? 0)) <= 40;
  if (typeof a["text"] === "string" && typeof b["text"] === "string") return a["text"] === b["text"];
  if (typeof a["command"] === "string" && typeof b["command"] === "string") return a["command"] === b["command"];
  return JSON.stringify(a) === JSON.stringify(b);
}

export const YES_PATTERN = /^\s*(yes|yeah|yep|yup|sure|ok(ay)?|go ahead|do it|send it|go for it|confirm(ed)?|please do|that'?s fine|approved?|proceed|make it so)\b/i;

export interface ToolsetOptions {
  readonly hands: NativeHands;
  readonly screen?: Screen;
  readonly confirmations?: ConfirmationState;
  readonly budget?: ShotBudget;
  /** Windows to leave out of screenshots (Jarhead's own). */
  readonly excludePids?: () => number[];
  readonly annotate?: (cmd: OverlayCommand) => void;
  readonly onAction?: (event: ActionEvent) => void;
  readonly policy?: (ctx: ActionContext) => Decision;
  readonly now?: () => number;
}

const SCROLL_PX_PER_CLICK = 60;

export class ComputerToolset {
  readonly screen: Screen;
  readonly confirmations: ConfirmationState;
  private readonly policy: (ctx: ActionContext) => Decision;
  private readonly now: () => number;

  constructor(private readonly opts: ToolsetOptions) {
    this.screen = opts.screen ?? new Screen();
    this.confirmations = opts.confirmations ?? new ConfirmationState();
    this.policy = opts.policy ?? classifyAction;
    this.now = opts.now ?? Date.now;
  }

  isKnown(name: string): boolean {
    return (COMPUTER_MEMBERS as readonly string[]).includes(name) || (DESKTOP_TOOLS as readonly string[]).includes(name);
  }

  /** Run one member. Never throws; every failure is a result the model can read. */
  async run(name: string, rawInput: unknown): Promise<ToolResult> {
    const input = (typeof rawInput === "object" && rawInput !== null ? rawInput : {}) as Record<string, unknown>;
    const started = this.now();
    let points: { x: number; y: number } | undefined;
    let decision: Decision | undefined;
    try {
      const outcome = await this.dispatch(name, input, (p) => (points = p), (d) => (decision = d));
      this.opts.onAction?.({ member: name, input, ...(points ? { points } : {}), ...(decision ? { decision } : {}), ms: this.now() - started, ok: outcome.kind !== "error" });
      return outcome;
    } catch (e) {
      const message = e instanceof NativeRequestError ? e.message : (e as Error).message;
      this.opts.onAction?.({ member: name, input, ...(points ? { points } : {}), ...(decision ? { decision } : {}), ms: this.now() - started, ok: false });
      log.warn(`${name} failed: ${message}`);
      return { kind: "error", message };
    }
  }

  private async dispatch(
    name: string,
    input: Record<string, unknown>,
    notePoints: (p: { x: number; y: number }) => void,
    noteDecision: (d: Decision) => void,
  ): Promise<ToolResult> {
    const hands = this.opts.hands;
    switch (name) {
      case "screenshot": {
        const budget = this.opts.budget ?? DEFAULT_SHOT_BUDGET;
        const display = (input["display"] as string | number | undefined) ?? "cursor";
        let shot: ScreenshotResult;
        try {
          shot = await hands.request<ScreenshotResult>("screenshot", {
            display,
            maxLongEdge: budget.maxLongEdge,
            maxPixels: budget.maxPixels,
            excludePids: this.opts.excludePids?.() ?? [],
            showCursor: true,
          }, 6000);
        } catch (e) {
          if (!(e instanceof NativeRequestError) || (e.detail.code !== "permission_denied" && e.detail.code !== "capture_failed" && e.detail.code !== "unavailable")) throw e;
          shot = await this.fallbackScreenshot(display, budget);
          log.warn(`native screenshot unavailable (${e.detail.code}); used screencapture`);
        }
        this.screen.remember(shot);
        return { kind: "image", pngBase64: shot.pngBase64, width: shot.width, height: shot.height, note: `display ${shot.displayId}, ${shot.width}x${shot.height} px covering ${Math.round(shot.points.w)}x${Math.round(shot.points.h)} points` };
      }
      case "zoom": {
        const region = input["region"];
        if (!Array.isArray(region) || region.length !== 4 || !region.every((n) => typeof n === "number" && Number.isFinite(n))) {
          return { kind: "error", message: "zoom needs region: [x0, y0, x1, y1] in screenshot pixels" };
        }
        const rect = this.screen.regionToRect(region as number[]);
        const shot = await hands.request<ScreenshotResult>("zoom", { ...rect, maxLongEdge: (this.opts.budget ?? DEFAULT_SHOT_BUDGET).maxLongEdge }, 6000);
        return { kind: "image", pngBase64: shot.pngBase64, width: shot.width, height: shot.height, note: "zoomed view; click coordinates still refer to the last full screenshot" };
      }
      case "cursor_position": {
        const c = await hands.request<{ x: number; y: number }>("cursor");
        const m = this.screen.last;
        if (!m) return { kind: "text", text: `X=${Math.round(c.x)}, Y=${Math.round(c.y)} (global points; no screenshot yet)` };
        const px = this.screen.fromPoints(c.x, c.y);
        return { kind: "text", text: `X=${Math.round(px.x)}, Y=${Math.round(px.y)}` };
      }
      case "mouse_move": {
        const p = this.coord(input);
        notePoints(p);
        await hands.request("move", p);
        return ok();
      }
      case "left_click":
      case "right_click":
      case "middle_click":
      case "double_click":
      case "triple_click": {
        const p = input["coordinate"] === undefined ? await this.cursorPoints() : this.coord(input);
        notePoints(p);
        const gate = await this.gate(name, input, { points: p });
        noteDecision(gate.decision);
        if (gate.result) return gate.result;
        const button = name === "right_click" ? "right" : name === "middle_click" ? "middle" : "left";
        const count = name === "double_click" ? 2 : name === "triple_click" ? 3 : 1;
        await hands.request("click", { ...p, button, count, modifiers: modifiersOf(input) });
        this.opts.annotate?.({ cmd: "click-pulse", x: p.x, y: p.y });
        return ok();
      }
      case "left_mouse_down":
      case "left_mouse_up": {
        await hands.request(name === "left_mouse_down" ? "mouse_down" : "mouse_up", { button: "left" });
        return ok();
      }
      case "left_click_drag": {
        const from = this.coord({ coordinate: input["start_coordinate"] });
        const to = this.coord(input);
        notePoints(to);
        const gate = await this.gate(name, input, { points: to });
        noteDecision(gate.decision);
        if (gate.result) return gate.result;
        await hands.request("drag", { from, to, modifiers: modifiersOf(input) }, 8000);
        return ok();
      }
      case "scroll": {
        const p = input["coordinate"] === undefined ? undefined : this.coord(input);
        if (p) notePoints(p);
        const dir = String(input["scroll_direction"] ?? "down");
        const amount = Number(input["scroll_amount"] ?? 3);
        if (!Number.isFinite(amount) || amount <= 0) return { kind: "error", message: "scroll_amount must be a positive number" };
        const px = amount * SCROLL_PX_PER_CLICK;
        const dy = dir === "up" ? px : dir === "down" ? -px : 0;
        const dx = dir === "left" ? px : dir === "right" ? -px : 0;
        if (dx === 0 && dy === 0) return { kind: "error", message: `scroll_direction must be up, down, left or right (got ${dir})` };
        await hands.request("scroll", { ...(p ?? {}), dx, dy, modifiers: modifiersOf(input) });
        return ok();
      }
      case "type": {
        const text = String(input["text"] ?? "");
        if (!text) return { kind: "error", message: "type needs text" };
        const gate = await this.gate(name, input, { text });
        noteDecision(gate.decision);
        if (gate.result) return gate.result;
        await hands.request("type", { text }, 5000 + text.length * 15);
        return ok();
      }
      case "key": {
        const combo = String(input["text"] ?? "");
        if (!combo) return { kind: "error", message: "key needs text like 'Return' or 'cmd+s'" };
        const repeat = Math.min(100, Math.max(1, Number(input["repeat"] ?? 1) || 1));
        const gate = await this.gate(name, input, { text: combo });
        noteDecision(gate.decision);
        if (gate.result) return gate.result;
        await hands.request("key", { combo, repeat }, 3000 + repeat * 40);
        return ok();
      }
      case "hold_key": {
        const combo = String(input["text"] ?? "");
        const duration = Math.min(300, Math.max(0, Number(input["duration"] ?? 1) || 0));
        if (!combo) return { kind: "error", message: "hold_key needs text" };
        await hands.request("hold_key", { combo, durationMs: Math.round(duration * 1000) }, duration * 1000 + 2000);
        return ok();
      }
      case "wait": {
        const duration = Math.min(300, Math.max(0, Number(input["duration"] ?? 1) || 0));
        await new Promise((r) => setTimeout(r, duration * 1000));
        return ok();
      }
      // ---------------------------------------------------- desktop tools
      case "open_app": {
        const target = String(input["name"] ?? input["app"] ?? "");
        if (!target) return { kind: "error", message: "open_app needs name" };
        const decision = this.policy({ kind: "open_app", target });
        noteDecision(decision);
        const r = await hands.request<{ pid: number; bundleId?: string; app: string }>("open_app", { name: target, activate: true }, 8000);
        return { kind: "text", text: `opened ${r.app} (pid ${r.pid})` };
      }
      case "focus_app": {
        const target = String(input["name"] ?? input["app"] ?? "");
        await hands.request("focus_app", { name: target });
        return { kind: "text", text: `focused ${target}` };
      }
      case "frontmost_app": {
        const f = await hands.request<FrontmostInfo>("frontmost");
        return { kind: "text", text: JSON.stringify(f) };
      }
      case "list_windows": {
        const w = await hands.request<{ windows: WindowInfo[] }>("windows");
        const rows = w.windows.map((x) => `${x.app}${x.title ? ` — ${x.title}` : ""} [${Math.round(x.x)},${Math.round(x.y)} ${Math.round(x.w)}x${Math.round(x.h)}]`);
        return { kind: "text", text: rows.length ? rows.join("\n") : "no windows on screen" };
      }
      case "read_focused_text": {
        const f = await hands.request<FocusedText>("focused_text");
        if (f.secure) return { kind: "text", text: `focused element is a password field in ${f.app ?? "the app"}; contents are not read` };
        return { kind: "text", text: JSON.stringify({ app: f.app, role: f.role, title: f.title, value: f.value?.slice(0, 4000), selectedText: f.selectedText }) };
      }
      case "element_at": {
        const p = this.coord(input);
        const el = await hands.request<ElementInfo>("element_at", p);
        return { kind: "text", text: JSON.stringify(el) };
      }
      default:
        return { kind: "error", message: `unknown computer tool ${name}` };
    }
  }

  /** `screencapture` when ScreenCaptureKit is refused; needs only the display list. */
  private async fallbackScreenshot(display: string | number, budget: ShotBudget): Promise<ScreenshotResult> {
    let displays: DisplayInfo[] = [];
    try {
      displays = (await this.opts.hands.request<{ displays: DisplayInfo[] }>("displays", {}, 2000)).displays;
    } catch {
      displays = [];
    }
    if (displays.length === 0) displays = [{ id: 1, x: 0, y: 0, w: 1728, h: 1117, scale: 2, main: true }];
    let target = displays.find((d) => d.main) ?? displays[0]!;
    if (typeof display === "number") target = displays.find((d) => d.id === display) ?? target;
    else if (display === "cursor") {
      try {
        const c = await this.opts.hands.request<{ x: number; y: number }>("cursor", {}, 1000);
        target = displays.find((d) => c.x >= d.x && c.x < d.x + d.w && c.y >= d.y && c.y < d.y + d.h) ?? target;
      } catch {
        // main display it is
      }
    }
    return screencaptureFallback(displays, target.id, budget);
  }

  private coord(input: Record<string, unknown>): { x: number; y: number } {
    const c = input["coordinate"];
    if (!Array.isArray(c) || c.length !== 2 || typeof c[0] !== "number" || typeof c[1] !== "number") {
      throw new Error("coordinate must be [x, y] in screenshot pixels");
    }
    return this.screen.toPoints(c[0], c[1]);
  }

  private async cursorPoints(): Promise<{ x: number; y: number }> {
    return this.opts.hands.request<{ x: number; y: number }>("cursor");
  }

  /**
   * The policy needs to know what is under the pointer and which app is up. One
   * element_at plus one frontmost call costs a few ms with the native helper and
   * is what makes "confirm before Send" possible at all.
   */
  private async gate(member: string, input: Record<string, unknown>, about: { points?: { x: number; y: number }; text?: string }): Promise<{ decision: Decision; result?: ToolResult }> {
    let app = "";
    let target = "";
    let secure = false;
    try {
      const front = await this.opts.hands.request<FrontmostInfo>("frontmost", {}, 1500);
      app = front.app;
      if (about.points) {
        const el = await this.opts.hands.request<ElementInfo>("element_at", about.points, 1500);
        target = [el.title, el.description, el.value, el.role].filter((s) => typeof s === "string" && s.length > 0).join(" · ");
      }
      if (member === "type" || member === "key") {
        const f = await this.opts.hands.request<FocusedText>("focused_text", {}, 1500);
        secure = f.secure;
        if (!target) target = f.title ?? f.role;
      }
    } catch {
      // Without AX the policy sees less; it errs toward asking, never toward acting.
    }
    const confirmed = this.confirmations.consume(member, input);
    const decision = this.policy({ kind: member, app, target, text: about.text, secureField: secure, confirmed });
    if (decision.verdict === "run") return { decision };
    if (decision.verdict === "refuse") return { decision, result: { kind: "error", message: `refused: ${decision.reason}` } };
    const description = describe(member, input, app, target);
    const pending = this.confirmations.ask(description, member, input);
    return {
      decision,
      result: {
        kind: "needs-confirmation",
        pendingId: pending.id,
        question: `About to ${description}. ${decision.reason}. Ask Kevin to confirm out loud, then stop; do not retry until he says yes.`,
      },
    };
  }
}

function describe(member: string, input: Record<string, unknown>, app: string, target: string): string {
  const where = app ? ` in ${app}` : "";
  switch (member) {
    case "type":
      return `type "${String(input["text"]).slice(0, 80)}"${where}`;
    case "key":
      return `press ${String(input["text"])}${where}`;
    default:
      return `${member.replace(/_/g, " ")}${target ? ` on "${target.slice(0, 80)}"` : ""}${where}`;
  }
}

function modifiersOf(input: Record<string, unknown>): string[] {
  const t = input["text"];
  if (typeof t !== "string" || !t.trim()) return [];
  return t.split("+").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function ok(): ToolResult {
  return { kind: "text", text: "OK" };
}
