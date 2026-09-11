/**
 * What Jarhead may do without asking.
 *
 * v1 asked before almost everything and was, as a result, useless for the thing it
 * was for. v2 inverts the default: reversible actions on Kevin's own machine run.
 * The brain must still stop and ask, by voice, before anything that leaves the
 * machine or cannot be undone, and it never types into a secret field.
 *
 * This module is a pure classifier. It knows nothing about screens; callers pass
 * what they know (the app, the visible label, the text about to be typed) and
 * get a verdict with a reason the model can read.
 */

export type Verdict = "run" | "confirm" | "refuse";

export interface ActionContext {
  /** left_click, type, key, scroll, drag, open_app, run_shell, screenshot, … */
  readonly kind: string;
  readonly app?: string | undefined;
  /** Label / title / role of the target element, when known. */
  readonly target?: string | undefined;
  /** Text about to be typed, or the shell command about to run. */
  readonly text?: string | undefined;
  /** True when the focused element is a secure text field. */
  readonly secureField?: boolean | undefined;
  /** Kevin said "go ahead" for this specific action already. */
  readonly confirmed?: boolean | undefined;
}

export interface Decision {
  readonly verdict: Verdict;
  readonly reason: string;
}

const READ_ONLY = new Set(["screenshot", "zoom", "cursor_position", "wait", "read", "list_windows", "focused_text", "element_at"]);
const POINTER = new Set(["left_click", "right_click", "middle_click", "double_click", "triple_click", "mouse_move", "left_mouse_down", "left_mouse_up", "left_click_drag", "scroll"]);
const KEYS = new Set(["type", "key", "hold_key"]);

/** Words on a control that mean "this leaves the machine or cannot be undone". */
const IRREVERSIBLE =
  /\b(send|reply|post|tweet|publish|submit|share|forward|pay|buy|purchase|checkout|place (your )?order|order now|transfer|donate|subscribe|delete|remove|erase|destroy|discard|empty trash|permanently|unsubscribe|sign|confirm|approve|merge|force[- ]push|deploy|release|shutdown|restart|log out|sign out)\b/i;

/** Apps where Kevin drives; Jarhead only looks. */
const HANDS_OFF_APPS = /\b(1password|keychain access|system settings|system preferences|bitwarden|authy|banking|wallet)\b/i;

/** Shell commands that only read. Anything else needs a yes. */
const SAFE_SHELL = /^\s*(ls|cat|head|tail|wc|pwd|echo|date|whoami|which|git (status|log|diff|branch|show|remote)|rg|grep|find|du|df|ps|uptime|open (-a )?[A-Za-z])\b/;

/** Shell commands that are never run by voice, confirmed or not. */
const FORBIDDEN_SHELL = /(rm -rf \/(\s|$)|\bmkfs\b|diskutil erase|\bdd if=|:\(\)\{ :\|:& \};:|\bshutdown\b|\breboot\b|launchctl (unload|remove)|security (delete|export)|defaults delete)/;

export function classifyAction(ctx: ActionContext): Decision {
  const kind = ctx.kind.trim().toLowerCase();
  const app = ctx.app ?? "";
  const target = ctx.target ?? "";
  const text = ctx.text ?? "";

  if (READ_ONLY.has(kind)) return { verdict: "run", reason: `${kind} only observes` };

  if (ctx.secureField && KEYS.has(kind)) {
    return { verdict: "refuse", reason: "the focused field is a password field; Kevin types secrets himself" };
  }

  if (kind === "run_shell") {
    if (FORBIDDEN_SHELL.test(text)) return { verdict: "refuse", reason: "that command is on the never-by-voice list" };
    if (SAFE_SHELL.test(text)) return { verdict: "run", reason: "read-only shell command" };
    return ctx.confirmed
      ? { verdict: "run", reason: "Kevin confirmed this command" }
      : { verdict: "confirm", reason: `shell command "${text.slice(0, 60)}" changes state; ask first` };
  }

  if (HANDS_OFF_APPS.test(app) && (POINTER.has(kind) || KEYS.has(kind))) {
    return ctx.confirmed
      ? { verdict: "run", reason: `Kevin confirmed acting in ${ctx.app}` }
      : { verdict: "confirm", reason: `${ctx.app} holds credentials or system settings; ask before acting there` };
  }

  if (IRREVERSIBLE.test(target)) {
    return ctx.confirmed
      ? { verdict: "run", reason: `Kevin confirmed "${target}"` }
      : { verdict: "confirm", reason: `"${target}" looks irreversible or leaves the machine; ask first` };
  }

  if (POINTER.has(kind) || KEYS.has(kind) || kind === "open_app" || kind === "focus_app") {
    return { verdict: "run", reason: `${kind} is reversible on Kevin's own machine` };
  }

  // Unknown kinds fail closed to a question, never to silence and never to action.
  return { verdict: "confirm", reason: `unknown action kind "${ctx.kind}"; ask before running it` };
}
