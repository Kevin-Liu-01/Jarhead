import type { Point } from "@jarhead/protocol";
import type { AxNodeInfo, AxTreeResult, ElementInfo, FocusedText, FrontmostInfo, NativeHands, WindowInfo } from "./native.ts";

/**
 * What the screen is like right now, read from the helper without a screenshot:
 * the front app and window, the focused field, the element under the pointer, the
 * windows on screen and the labelled controls of the front window. One `ScreenState`
 * is what an acting tool's result carries as its `now:` line (the model verifies from
 * it instead of spending a screenshot and the 5 s generation that reads it), and what
 * the eyes hand a brain beside its first shot so the first move can be by name.
 *
 * Cached because the same answers are asked for many times a second — the engine's
 * 500 ms AX tick, the gate, the observer — and the helper answers each in 4–16 ms on
 * the reading helper. A read is O(1); a refresh is a few probes in flight together,
 * raced against a budget so a slow app never holds an acting result hostage.
 */

/** A control a brain may name: its role, its visible label and its centre in global points. */
export interface AxLabel {
  readonly role: string;
  readonly label: string;
  readonly center: Point;
  readonly pressable?: boolean;
  readonly editable?: boolean;
}

export interface ScreenState {
  /** When the newest probe in this state landed (the cache's clock). */
  readonly at: number;
  /** The display-configuration hash the probes reported (display arrangement, front app, front window). */
  readonly config?: string;
  readonly front?: FrontmostInfo;
  readonly focused?: Pick<FocusedText, "role" | "title" | "value" | "secure" | "app" | "frame">;
  /** What sits under the pointer, and where the pointer was when asked. */
  readonly under?: ElementInfo & { readonly point?: Point };
  /** ≤ WINDOWS_MAX on-screen windows, front first as the helper lists them. */
  readonly windows?: readonly WindowInfo[];
  /** The front window's labelled controls (≤ LABELS_MAX), pressable or editable roles only. */
  readonly ax?: { readonly app: string; readonly window: string; readonly labels: readonly AxLabel[]; readonly truncated?: boolean };
}

/** Which probes a refresh runs (frontmost always). */
export interface ScreenStateWant {
  readonly focused?: boolean;
  readonly windows?: boolean;
  readonly ax?: boolean;
  /** Read the element under this point (global). */
  readonly point?: Point;
  /** Read the pointer's position, then the element under it (two hops on the reading helper). */
  readonly underCursor?: boolean;
}

export interface ScreenStateCacheOptions {
  readonly now?: () => number;
  /** Each probe's own timeout on the helper (default 1500 ms, the gate's). */
  readonly probeTimeoutMs?: number;
  /** Probes in flight at once (default 3): the reading helper is serial, more would only queue there. */
  readonly parallel?: number;
  /** Test seam for the budget timer. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** The whole-screen budget a refresh is raced against when the caller names none. */
export const STATE_BUDGET_MS = 300;
export const WINDOWS_MAX = 12;
export const LABELS_MAX = 25;

/** Roles a brain can act on by name (a click or a type lands there); static text, groups and images are left out. */
const LABEL_ROLE = /^AX(?:Button|Link|MenuItem|MenuBarItem|MenuButton|PopUpButton|CheckBox|RadioButton|Tab|TextField|TextArea|SearchField|ComboBox|Slider|Incrementor|DisclosureTriangle|ColorWell|Cell|Row)$/;
const EDITABLE_ROLE = /^AX(?:TextField|TextArea|SearchField|ComboBox)$/;

export class ScreenStateCache {
  private state: ScreenState | undefined;
  private version_ = 0;
  /** Bumped by every invalidate: a probe that started before the bump answers about a screen that is gone. */
  private generation = 0;
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly hands: NativeHands,
    private readonly opts: ScreenStateCacheOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Changes so far: every landed probe, every absorb, every invalidate bumps it (tests and the observer read it). */
  get version(): number {
    return this.version_;
  }

  /**
   * The state, when it is younger than `maxAgeMs` and — when the caller knows the hash
   * the screen must still be under — taken under the same `config`. A state that knows
   * no config (a frontmost-only refresh, the AX tick's absorb: only focused_text and
   * element_at report one) is a MISS for such a caller: it cannot vouch for the screen
   * it was read under. O(1), never probes.
   */
  get(maxAgeMs: number, config?: string): ScreenState | undefined {
    const s = this.state;
    if (!s) return undefined;
    if (this.now() - s.at > maxAgeMs) return undefined;
    if (config !== undefined && s.config !== config) return undefined;
    return s;
  }

  /** The screen changed (an acting call landed): whatever was known is stale. */
  invalidate(_why: string): void {
    this.generation++;
    if (this.state) {
      this.state = undefined;
      this.version_++;
    }
  }

  /**
   * Fold an answer somebody else already paid for (the engine's AX tick, a gate's
   * probes) into the state, so the next `get` is a hit without a probe.
   */
  absorb(patch: Partial<Omit<ScreenState, "at">>): ScreenState {
    const at = this.now();
    this.state = { ...(this.state ?? {}), ...patch, at };
    this.version_++;
    return this.state;
  }

  /**
   * Read the screen: frontmost plus the probes `want` names, ≤ `parallel` in flight
   * together, each with its own helper timeout, the whole raced against `budgetMs`.
   * Resolves with what has landed by then (a partial state past the budget, never a
   * throw); probes that land later still fill the cache for the next `get`, unless an
   * invalidate came in between (then they describe a screen that is gone and are dropped).
   */
  async refresh(want: ScreenStateWant = {}, budgetMs = STATE_BUDGET_MS): Promise<ScreenState> {
    const gen = this.generation;
    const t0 = this.now();
    let landed: Partial<ScreenState> = {};
    const merge = (patch: Partial<ScreenState>): void => {
      if (this.generation !== gen) return;
      landed = { ...landed, ...patch };
      const at = this.now();
      this.state = { ...(this.state ?? {}), ...patch, at };
      this.version_++;
    };
    const probes: Array<Promise<void>> = [];
    probes.push(this.probe(() => this.hands.request<FrontmostInfo>("frontmost", {}, this.timeout), (front) => merge({ front })));
    if (want.focused) {
      probes.push(
        this.probe(
          () => this.hands.request<FocusedText>("focused_text", {}, this.timeout),
          (f) => merge({ focused: { role: f.role, secure: f.secure, ...(f.title !== undefined ? { title: f.title } : {}), ...(f.value !== undefined ? { value: f.value } : {}), ...(f.app !== undefined ? { app: f.app } : {}), ...(f.frame !== undefined ? { frame: f.frame } : {}) }, ...(f.config ? { config: f.config } : {}) }),
        ),
      );
    }
    if (want.point) {
      const p = want.point;
      probes.push(this.probe(() => this.hands.request<ElementInfo>("element_at", { x: p.x, y: p.y }, this.timeout), (el) => merge({ under: { ...el, point: p }, ...(el.config ? { config: el.config } : {}) })));
    } else if (want.underCursor) {
      probes.push(
        this.probe(
          async () => {
            const c = await this.hands.request<{ x: number; y: number }>("cursor", {}, this.timeout);
            const el = await this.hands.request<ElementInfo>("element_at", { x: c.x, y: c.y }, this.timeout);
            return { el, point: { x: c.x, y: c.y } };
          },
          ({ el, point }) => merge({ under: { ...el, point }, ...(el.config ? { config: el.config } : {}) }),
        ),
      );
    }
    if (want.windows) probes.push(this.probe(() => this.hands.request<{ windows: WindowInfo[] }>("windows", {}, this.timeout), (w) => merge({ windows: (w.windows ?? []).slice(0, WINDOWS_MAX) })));
    if (want.ax) probes.push(this.probe(() => this.hands.request<AxTreeResult>("ax_tree", { maxAgeMs: 500, maxMs: 120, maxNodes: 1500 }, this.timeout), (tree) => merge({ ax: axLabels(tree) })));
    const all = Promise.allSettled(probes).then(() => undefined);
    await Promise.race([all, this.sleep(Math.max(0, budgetMs - (this.now() - t0)))]);
    // What this refresh saw, stamped when its newest probe landed; the cache may hold more (an earlier absorb).
    const at = this.state?.at ?? this.now();
    return { ...(this.state ?? {}), ...landed, at };
  }

  private get timeout(): number {
    return this.opts.probeTimeoutMs ?? 1500;
  }

  /** One probe under the concurrency cap; a failure (timeout, cancel, an old helper) is a probe that did not land. */
  private async probe<T>(run: () => Promise<T>, land: (v: T) => void): Promise<void> {
    await this.slot();
    try {
      land(await run());
    } catch {
      // not landed
    } finally {
      this.inFlight--;
      this.waiters.shift()?.();
    }
  }

  private slot(): Promise<void> {
    const cap = Math.max(1, this.opts.parallel ?? 3);
    if (this.inFlight < cap) {
      this.inFlight++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) =>
      this.waiters.push(() => {
        this.inFlight++;
        resolve();
      }),
    );
  }
}

/** The front window's controls a brain may name, from an `ax_tree` answer: ≤ LABELS_MAX, one per (role, label). */
export function axLabels(tree: AxTreeResult): NonNullable<ScreenState["ax"]> {
  const labels: AxLabel[] = [];
  const seen = new Set<string>();
  for (const n of tree.nodes ?? []) {
    if (labels.length >= LABELS_MAX) break;
    const label = labelOf(n);
    if (!label) continue;
    if (!(n.pressable === true || LABEL_ROLE.test(n.role))) continue;
    if (n.x === undefined || n.y === undefined) continue;
    const key = `${n.role} ${label.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push({ role: n.role, label, center: { x: Math.round(n.x + (n.w ?? 0) / 2), y: Math.round(n.y + (n.h ?? 0) / 2) }, ...(n.pressable ? { pressable: true } : {}), ...(EDITABLE_ROLE.test(n.role) ? { editable: true } : {}) });
  }
  return { app: tree.app, window: tree.window, labels, ...(tree.truncated ? { truncated: true } : {}) };
}

function labelOf(n: AxNodeInfo): string {
  const raw = n.title || n.description || (EDITABLE_ROLE.test(n.role) ? "" : n.value) || "";
  return oneLine(raw).slice(0, 40);
}

// ------------------------------------------------------------- rendering

/** The hard cap on an observation line: one line the model reads after every action, never a paragraph. */
export const OBSERVATION_MAX_CHARS = 240;

/** What the line names the action as ("150 ms after the click"). */
function verbOf(name: string): string {
  switch (name) {
    case "left_click":
    case "right_click":
    case "middle_click":
    case "double_click":
    case "triple_click":
    case "click_element":
    case "browser_click":
      return "the click";
    case "left_click_drag":
      return "the drag";
    case "type":
    case "browser_type":
      return "the typing";
    case "key":
    case "hold_key":
      return "the key";
    case "scroll":
      return "the scroll";
    case "open_app":
    case "focus_app":
      return "the switch";
    case "browser_navigate":
      return "the navigation";
    case "applescript":
      return "the script";
    case "run_shell":
      return "the command";
    case "mouse_move":
    case "left_mouse_down":
    case "left_mouse_up":
      return "the pointer";
    default:
      return `the ${name.replace(/^show_/, "").replace(/_/g, " ")}`;
  }
}

export function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** `s` cut to `max` characters with an ellipsis, whitespace collapsed. */
export function cut(s: string, max: number): string {
  const t = oneLine(s);
  return t.length > max ? `${t.slice(0, Math.max(0, max - 1))}…` : t;
}

/**
 * The one line an acting tool's result ends with:
 * `now: Safari — "GitHub" (was Finder); focused: AXTextField "Search" = "hello"; under the pointer: AXButton "Save"; 150 ms after the click`
 * ≤ OBSERVATION_MAX_CHARS. A secure field renders as `a password field`, value omitted.
 * `(was X)` only when the front app changed. Empty when nothing is known about `after`.
 */
export function renderObservation(before: ScreenState | undefined, after: ScreenState, action: { readonly name: string; readonly point?: Point; readonly settleMs?: number }): string {
  if (!after.front && !after.focused && !after.under) return "";
  const front = after.front;
  const title = front?.window?.title ? oneLine(front.window.title) : "";
  const was = before?.front && front && before.front.app !== front.app ? ` (was ${cut(before.front.app, 30)})` : "";
  const focused = after.focused;
  const under = after.under;
  const underLabel = under ? oneLine(under.title || under.description || under.value || "") : "";
  const tail = `${Math.max(0, Math.round(action.settleMs ?? 0))} ms after ${verbOf(action.name)}`;

  // Built longest first, then trimmed piece by piece until it fits: the value, the pointer, the titles.
  const build = (o: { value: boolean; under: boolean; titleMax: number; valueMax: number }): string => {
    const parts: string[] = [];
    if (front) parts.push(`now: ${cut(front.app, 30)}${title ? ` — "${cut(title, o.titleMax)}"` : ""}${was}`);
    else parts.push("now:");
    if (focused && focused.role) {
      if (focused.secure) parts.push("focused: a password field");
      else {
        const t = focused.title ? ` "${cut(focused.title, 40)}"` : "";
        const v = o.value && typeof focused.value === "string" && focused.value !== "" ? ` = "${cut(focused.value, o.valueMax)}"` : "";
        parts.push(`focused: ${focused.role}${t}${v}`);
      }
    }
    if (o.under && under?.role) parts.push(`under the pointer: ${under.role}${underLabel ? ` "${cut(underLabel, 40)}"` : ""}`);
    parts.push(tail);
    return parts.join("; ");
  };
  const attempts = [
    { value: true, under: true, titleMax: 60, valueMax: 80 },
    { value: true, under: true, titleMax: 60, valueMax: 40 },
    { value: true, under: false, titleMax: 60, valueMax: 40 },
    { value: false, under: true, titleMax: 40, valueMax: 0 },
    { value: false, under: false, titleMax: 30, valueMax: 0 },
  ];
  for (const a of attempts) {
    const line = build(a);
    if (line.length <= OBSERVATION_MAX_CHARS) return line;
  }
  return `${build(attempts[attempts.length - 1]!).slice(0, OBSERVATION_MAX_CHARS - 1)}…`;
}

/**
 * The composite look's preamble (the eyes at delegation time): the front app and
 * window, the focused field, ≤ 8 windows, and ≤ LABELS_MAX controls with centres in
 * the pixels of the screenshot they ride with (`toPixels` = Screen.fromPoints); in
 * global points, said so, when there is no shot to map through. Multi-line, bounded
 * by the counts; a truncated tree is named so the model knows a control may be missing.
 */
export function renderCompositeLook(state: ScreenState, toPixels?: (p: Point) => Point): string {
  const lines: string[] = [];
  const front = state.front;
  const title = front?.window?.title ? ` — "${cut(front.window.title, 60)}"` : "";
  lines.push(`screen: ${front ? `${cut(front.app, 30)}${title}` : "unknown"}`);
  const f = state.focused;
  if (f?.role) lines.push(f.secure ? "focused: a password field" : `focused: ${f.role}${f.title ? ` "${cut(f.title, 40)}"` : ""}${typeof f.value === "string" && f.value ? ` = "${cut(f.value, 80)}"` : ""}`);
  const windows = (state.windows ?? []).slice(0, 8);
  if (windows.length) lines.push(`windows: ${windows.map((w) => `${cut(w.app, 24)}${w.title ? ` — "${cut(w.title, 40)}"` : ""}`).join(", ")}`);
  const ax = state.ax;
  if (ax && ax.labels.length) {
    const unit = toPixels ? "screenshot pixels" : "global points";
    const rows = ax.labels.slice(0, LABELS_MAX).map((l) => {
      const p = toPixels ? toPixels(l.center) : l.center;
      return `${l.role} "${l.label}" @${Math.round(p.x)},${Math.round(p.y)}`;
    });
    lines.push(`controls (${unit}${ax.truncated ? "; the tree was cut short, a control may be missing" : ""}): ${rows.join("; ")}`);
  }
  return lines.join("\n");
}
