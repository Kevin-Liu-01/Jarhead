import { classifyAction, logger, type ActionContext, type Decision } from "@jarhead/core";
import type { OverlayCommand } from "@jarhead/protocol";
import { NativeRequestError, type ElementInfo, type FindElementResult, type FocusedText, type FrontmostInfo, type NativeHands, type ScreenshotResult, type WindowInfo } from "./native.ts";
import { DEFAULT_SHOT_BUDGET, QUICK_SHOT_BUDGET, Screen, type ShotBudget } from "./screen.ts";
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

export const DESKTOP_TOOLS = ["open_app", "focus_app", "list_windows", "read_focused_text", "element_at", "frontmost_app", "find_element", "click_element"] as const;
export type DesktopTool = (typeof DESKTOP_TOOLS)[number];

/**
 * The members that move something or type something — an *action* as opposed to
 * a look. The delegator's `firstActionAt` timing and the reflex table read this;
 * screenshots, zooms and the AX reads are not in it.
 */
export const ACTING_MEMBERS: ReadonlySet<string> = new Set([
  "left_click", "right_click", "middle_click", "double_click", "triple_click", "left_click_drag", "mouse_move", "left_mouse_down", "left_mouse_up",
  "scroll", "type", "key", "hold_key", "open_app", "focus_app", "click_element",
]);

/**
 * Tools that only look: several of these in one model turn can run at once
 * without one changing what the next one sees. Anything else runs in order.
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "screenshot", "zoom", "cursor_position", "list_windows", "read_focused_text", "element_at", "frontmost_app", "find_element",
  "browser_read", "browser_find", "browser_tabs",
  "read_file", "list_dir", "search_files", "web_fetch", "web_search", "agents_list", "agent_read", "recall", "clipboard_read", "self_status", "self_review",
  "show_circle", "show_arrow", "show_rect", "show_text", "show_stroke", "show_clear",
]);

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

  /** The helper this toolset drives (the browser tools share it). */
  get hands(): NativeHands {
    return this.opts.hands;
  }

  /** The annotation layer, for tools outside this class that still want a click pulse. */
  get annotate(): ((cmd: OverlayCommand) => void) | undefined {
    return this.opts.annotate;
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
        // `quick: true` trades pixels for time (a 1280-pixel long edge): the pre-warm
        // shot at delegation, a reflex, the bench. The default budget stays for reading.
        const budget = input["quick"] === true ? QUICK_SHOT_BUDGET : this.opts.budget ?? DEFAULT_SHOT_BUDGET;
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
        return { kind: "image", pngBase64: shot.pngBase64, width: shot.width, height: shot.height, note: `display ${shot.displayId}, ${shot.width}x${shot.height} px covering ${Math.round(shot.points.w)}x${Math.round(shot.points.h)} points${input["quick"] === true ? " (quick budget)" : ""}` };
      }
      case "zoom": {
        const region = input["region"];
        if (!Array.isArray(region) || region.length !== 4 || !region.every((n) => typeof n === "number" && Number.isFinite(n))) {
          return { kind: "error", message: "zoom needs region: [x0, y0, x1, y1] in screenshot pixels" };
        }
        const rect = this.screen.regionToRect(region as number[]);
        // Frame what is being read, briefly.
        this.opts.annotate?.({ cmd: "rect", rect, ttlMs: 1500, tone: "accent" });
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
        // The blob flies to where the action lands, then the click pulses under it.
        this.opts.annotate?.({ cmd: "orb.fly", x: p.x, y: p.y, dwellMs: 1500, reason: name });
        await hands.request("click", { ...p, button, count, modifiers: modifiersOf(input) });
        this.opts.annotate?.({ cmd: "click-pulse", x: p.x, y: p.y });
        return ok();
      }
      case "left_mouse_down":
      case "left_mouse_up": {
        if (name === "left_mouse_down") {
          // The press lands under the pointer; the blob goes there (best effort: no pointer position, no flight).
          try {
            const c = await this.cursorPoints();
            if (Number.isFinite(c.x) && Number.isFinite(c.y)) this.opts.annotate?.({ cmd: "orb.fly", x: c.x, y: c.y, dwellMs: 1500, reason: name });
          } catch {
            // no pointer position, no flight
          }
        }
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
        // The blob flies to the grab point and the layer traces the drag.
        this.opts.annotate?.({ cmd: "orb.fly", x: from.x, y: from.y, dwellMs: 1500, reason: name });
        this.opts.annotate?.({ cmd: "path", from, to, ttlMs: 1500 });
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
        if (p) this.opts.annotate?.({ cmd: "orb.fly", x: p.x, y: p.y, dwellMs: 1500, reason: name });
        await hands.request("scroll", { ...(p ?? {}), dx, dy, modifiers: modifiersOf(input) });
        return ok();
      }
      case "type": {
        const text = String(input["text"] ?? "");
        if (!text) return { kind: "error", message: "type needs text" };
        const gate = await this.gate(name, input, { text });
        noteDecision(gate.decision);
        if (gate.result) return gate.result;
        // Typing lands in the focused element; when accessibility knows where that is, the blob hovers there.
        try {
          const f = await hands.request<FocusedText>("focused_text", {}, 1500);
          if (f.frame) this.opts.annotate?.({ cmd: "orb.fly", x: f.frame.x + f.frame.w / 2, y: f.frame.y + f.frame.h / 2, dwellMs: 1500, reason: name });
        } catch {
          // no frame, no flight
        }
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
      case "find_element": {
        const name = String(input["name"] ?? "").trim();
        if (!name) return { kind: "error", message: "find_element needs name: the control's visible label" };
        const found = await this.findElement(name, input);
        return { kind: "text", text: JSON.stringify(summarizeFind(found)) };
      }
      case "click_element": {
        // The reflex path's click: the one control on the front window with that name, judged
        // by its label (no screenshot, no pixel mapping), then a click at its centre.
        const name = String(input["name"] ?? "").trim();
        if (!name) return { kind: "error", message: "click_element needs name: the control's visible label" };
        const found = await this.findElement(name, input);
        if (!found.found || !found.element) return { kind: "error", message: `no control named "${name}" on the front window of ${found.app}${found.truncated ? " (the window's tree was cut short; try a screenshot and left_click)" : ""}` };
        if (!found.unique) return { kind: "error", message: `${found.candidates} controls could be "${name}" in ${found.app}: ${[found.element, ...(found.others ?? [])].map((e) => `${e.role} "${e.label}"`).join(", ")}; take a screenshot and left_click the right one` };
        const el = found.element;
        const p = el.center ?? (el.x !== undefined && el.y !== undefined ? { x: el.x + (el.w ?? 0) / 2, y: el.y + (el.h ?? 0) / 2 } : undefined);
        if (!p) return { kind: "error", message: `"${el.label}" has no frame to click` };
        notePoints(p);
        // The tree named a control; the click is a global event at a point. Before it
        // goes out: the control's app must be the one in front (an `app` argument may
        // name a browser behind another window — its coordinates are real, what is on
        // top of them is not its), and what is actually under the point must be that
        // control (a dialog or a sheet may have covered it since the tree was built).
        const frame = el.x !== undefined && el.y !== undefined ? { x: el.x, y: el.y, w: el.w ?? 0, h: el.h ?? 0 } : undefined;
        const under = await this.underPoint(found.app, el.label, el.role, p, frame);
        if (under.stopped) return { kind: "error", message: "stopped: Kevin pressed stop before this action ran" };
        if (under.problem) return { kind: "error", message: under.problem };
        const confirmed = this.confirmations.consume("click_element", { name });
        // The policy judges the name the tree gave and whatever the point itself says.
        const target = [el.label, el.role, ...under.words].filter(Boolean).join(" · ");
        const decision = this.policy({ kind: "left_click", app: found.app, target, confirmed });
        noteDecision(decision);
        if (decision.verdict === "refuse") return { kind: "error", message: `refused: ${decision.reason}` };
        if (decision.verdict === "confirm") {
          const pending = this.confirmations.ask(`click "${el.label}" in ${found.app}`, "click_element", { name });
          return { kind: "needs-confirmation", pendingId: pending.id, question: `About to click "${el.label}" in ${found.app}. ${decision.reason}. Ask Kevin to confirm out loud, then stop; do not retry until he says yes.` };
        }
        const button = input["button"] === "right" ? "right" : "left";
        const count = Number(input["count"]) === 2 ? 2 : 1;
        this.opts.annotate?.({ cmd: "orb.fly", x: p.x, y: p.y, dwellMs: 1500, reason: "click_element" });
        await hands.request("click", { ...p, button, count, modifiers: [] });
        this.opts.annotate?.({ cmd: "click-pulse", x: p.x, y: p.y });
        return { kind: "text", text: `clicked "${el.label}" (${el.role}) in ${found.app} at ${Math.round(p.x)},${Math.round(p.y)}${found.tier === "fuzzy" ? ` (matched "${name}" at ${Math.round(el.score * 100)} %)` : ""}` };
      }
      default:
        return { kind: "error", message: `unknown computer tool ${name}` };
    }
  }

  /**
   * Is `app` in front, and is the control named `label` what sits at `p`? One
   * `frontmost` and one `element_at`, in flight together (a few ms with the helper).
   * Geometry decides where it can: the element under the point must lie inside the
   * control's frame (the control itself, or its label / icon) — a sheet's button
   * over it has a frame of its own that does not. Words decide only when a frame
   * is missing, and then a control with another name is a cover. `words` is the
   * text under the point, for the policy. Without accessibility answers the click
   * is refused, never guessed: `click_element` is the reflex path's click and
   * nobody looked at a screenshot first.
   */
  private async underPoint(app: string, label: string, role: string, p: { x: number; y: number }, frame: { x: number; y: number; w: number; h: number } | undefined): Promise<{ problem?: string; stopped?: boolean; words: string[] }> {
    const hands = this.opts.hands;
    let stopped = false;
    const probe = <T>(q: Promise<T>): Promise<T | undefined> =>
      q.catch((e: unknown) => {
        if (e instanceof NativeRequestError && e.detail.code === "cancelled") stopped = true;
        return undefined;
      });
    const [front, el] = await Promise.all([probe(hands.request<FrontmostInfo>("frontmost", {}, 1500)), probe(hands.request<ElementInfo>("element_at", p, 1500))]);
    if (stopped) return { stopped: true, words: [] };
    if (!front) return { problem: `could not tell which app is in front; take a screenshot and left_click "${label}" instead`, words: [] };
    if (front.app.toLowerCase() !== app.toLowerCase()) return { problem: `"${label}" is in ${app}, but ${front.app} is in front: focus_app ${app} first (its window may be behind another), or take a screenshot and left_click`, words: [] };
    const words = el ? [el.title, el.description, el.value].filter((s): s is string => typeof s === "string" && s.length > 0) : [];
    if (el?.app && el.app.toLowerCase() !== app.toLowerCase()) return { problem: `the point where "${label}" is (${Math.round(p.x)},${Math.round(p.y)}) is covered by ${el.app}${words.length ? ` ("${words[0]}")` : ""}; take a screenshot and left_click`, words };
    if (!el) return { words };
    const what = `${el.role ?? "an element"}${words.length ? ` "${words[0]}"` : ""}`;
    if (frame && el.frame) {
      // Inside the control's frame: the control or one of its children, whatever it says.
      if (within(el.frame, frame)) return { words };
      // Around it: the point resolved to an enclosing element — the row or group the control
      // sits in when the app exposes nothing deeper there. A leaf control (a button, a link, a
      // menu item) enclosing another control is not a thing; it is a sheet's button over it.
      if (within(frame, el.frame)) {
        if (LEAF_CONTROL.test(el.role ?? "")) return { problem: `"${label}" (${role}) is covered at its point (${Math.round(p.x)},${Math.round(p.y)}) by ${what}; take a screenshot and left_click the right one`, words };
        return { words };
      }
      return { problem: `"${label}" (${role}) is covered at its point (${Math.round(p.x)},${Math.round(p.y)}) by ${what}; take a screenshot and left_click the right one`, words };
    }
    // No frame to compare: a control with a name of its own that is not this one is a cover
    // (a sheet's button, a menu). Static text, images and groups are taken as the control's own.
    if (words.length > 0 && !words.some((w) => relates(w, label)) && CONTROL_ROLE.test(el.role ?? "")) {
      return { problem: `"${label}" (${role}) is not what is under its point: ${what} is; take a screenshot and left_click the right one`, words };
    }
    return { words };
  }

  /** The helper's `find_element`: the front window's cached accessibility tree searched by label. */
  private findElement(name: string, input: Record<string, unknown>): Promise<FindElementResult> {
    const role = typeof input["role"] === "string" && input["role"].trim() ? { role: input["role"].trim() } : {};
    const app = typeof input["app"] === "string" && input["app"].trim() ? { app: input["app"].trim() } : {};
    return this.opts.hands.request<FindElementResult>("find_element", { name, ...role, ...app, maxAgeMs: 500 }, 2500);
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
    // Only the probes this member needs, and all of them in flight together: the
    // helper answers them in order, but the pipeline saves a round trip each.
    const hands = this.opts.hands;
    const wantsElement = about.points !== undefined;
    const wantsFocus = member === "type" || member === "key";
    // A probe dropped by a stop (cancelPending) means Kevin pressed stop while this
    // action was being judged: it does not run, whatever the policy would have said.
    let stopped = false;
    const probe = <T>(p: Promise<T>): Promise<T | undefined> =>
      p.catch((e: unknown) => {
        if (e instanceof NativeRequestError && e.detail.code === "cancelled") stopped = true;
        return undefined;
      });
    const [front, el, f] = await Promise.all([
      probe(hands.request<FrontmostInfo>("frontmost", {}, 1500)),
      wantsElement ? probe(hands.request<ElementInfo>("element_at", about.points, 1500)) : Promise.resolve(undefined),
      wantsFocus ? probe(hands.request<FocusedText>("focused_text", {}, 1500)) : Promise.resolve(undefined),
    ]);
    if (stopped) return { decision: { verdict: "refuse", reason: "Kevin pressed stop" }, result: { kind: "error", message: "stopped: Kevin pressed stop before this action ran" } };
    // Without AX the policy sees less; it errs toward asking, never toward acting.
    if (front) app = front.app;
    if (el) target = [el.title, el.description, el.value, el.role].filter((s) => typeof s === "string" && s.length > 0).join(" · ");
    if (f) {
      secure = f.secure;
      if (!target) target = f.title ?? f.role;
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

/** What a model needs from a find: where it is and whether it was the only one, not the helper's timings. */
function summarizeFind(found: FindElementResult): Record<string, unknown> {
  const el = (e: FindElementResult["element"]): Record<string, unknown> | undefined =>
    e ? { role: e.role, label: e.label, ...(e.title ? { title: e.title } : {}), ...(e.description ? { description: e.description } : {}), ...(e.center ? { center: { x: Math.round(e.center.x), y: Math.round(e.center.y) } } : {}), ...(e.x !== undefined ? { frame: { x: Math.round(e.x), y: Math.round(e.y ?? 0), w: Math.round(e.w ?? 0), h: Math.round(e.h ?? 0) } } : {}), score: Math.round(e.score * 100) / 100 } : undefined;
  return {
    app: found.app,
    window: found.window,
    found: found.found,
    unique: found.unique,
    candidates: found.candidates,
    match: found.tier,
    ...(found.element ? { element: el(found.element) } : {}),
    ...(found.others?.length ? { others: found.others.map(el) } : {}),
    ...(found.truncated ? { note: "the window's accessibility tree was cut short (huge page or slow app); a control deeper in it may be missing" } : {}),
    coordinates: "global points (not screenshot pixels): click_element by name clicks it; left_click needs screenshot pixels",
  };
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

/** Accessibility roles that are controls of their own (one under a named control's point means the control is covered). */
const CONTROL_ROLE = /^AX(Button|Link|MenuItem|MenuBarItem|MenuButton|PopUpButton|CheckBox|RadioButton|TextField|TextArea|ComboBox|Tab|Cell|Row|Slider|Incrementor|DisclosureTriangle|ColorWell)$/;
/** The controls that never enclose another control: found around a control's frame, one of these is a cover. */
const LEAF_CONTROL = /^AX(Button|Link|MenuItem|MenuBarItem|MenuButton|PopUpButton|CheckBox|RadioButton|TextField|TextArea|ComboBox|Slider|Incrementor|DisclosureTriangle|ColorWell)$/;

/** `a` lies inside `b`, with a couple of points of slack for rounding. */
function within(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }, slack = 2): boolean {
  return a.x >= b.x - slack && a.y >= b.y - slack && a.x + a.w <= b.x + b.w + slack && a.y + a.h <= b.y + b.h + slack;
}

/** Two labels are about the same control when one contains the other, case and punctuation folded. */
function relates(a: string, b: string): boolean {
  const fold = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const x = fold(a);
  const y = fold(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

function modifiersOf(input: Record<string, unknown>): string[] {
  const t = input["text"];
  if (typeof t !== "string" || !t.trim()) return [];
  return t.split("+").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function ok(): ToolResult {
  return { kind: "text", text: "OK" };
}
