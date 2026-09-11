/**
 * The confirmation taxonomy from the wiki's computer-use skill
 * (skills/engineering/computer-use/SKILL.md), as enforceable code instead of
 * prose. DECISION.md §5 calls that skill the repo's only reusable
 * computer-use asset; this module is its executable form.
 *
 * The one rule that matters more than any individual regex: this is a
 * fail-closed boundary. An action kind this module has never heard of gets
 * the strictest level, not a shrug — new capabilities must be classified on
 * purpose, in this file, before they can run unconfirmed.
 */

export const CONFIRM_LEVELS = ["always-allowed", "pre-approvable", "always-confirm", "hand-off"] as const;
export type ConfirmLevel = (typeof CONFIRM_LEVELS)[number];

export interface ComputerAction {
  /** e.g. "screenshot", "click", "type". Open set on purpose; unknowns fail closed. */
  readonly kind: string;
  readonly app?: string | undefined;
  /** What the action touches: an element title, field label, or URL. */
  readonly target?: string | undefined;
  /** True only when the caller has verified the window already holds focus. */
  readonly focusedWindow?: boolean | undefined;
}

export interface Classification {
  readonly level: ConfirmLevel;
  readonly reason: string;
}

// "read-selection" is NOT in here. Reading the AX selection is pure, but the
// clipboard fallback synthesizes Cmd+C and overwrites the clipboard, and the
// caller does not know in advance which path select.ts will take. Classifying
// the whole operation read-only was a fail-open bug: an action with real side
// effects was returning always-allowed.
const READ_ONLY_KINDS: ReadonlySet<string> = new Set(["screenshot", "ax-query", "read-selection-ax"]);

// Reads the selection but may press Cmd+C and round-trip the clipboard.
const CLIPBOARD_KINDS: ReadonlySet<string> = new Set(["read-selection", "read-selection-clipboard"]);
const POINTER_KINDS: ReadonlySet<string> = new Set([
  "move",
  "click",
  "double-click",
  "right-click",
  "scroll",
  "press-element",
]);
const TYPING_KINDS: ReadonlySet<string> = new Set(["type", "key"]);
const HAND_OFF_KINDS: ReadonlySet<string> = new Set([
  "terminal-command",
  "credential-entry",
  "system-settings-change",
]);

const HAND_OFF_APPS = /\b(system settings|system preferences|terminal|iterm2?|ghostty|warp|keychain access|1password)\b/i;
const HAND_OFF_TARGETS =
  /\b(password|passcode|passphrase|credential|keychain|sudo|2fa|otp|one-time|verification code|recovery key)\b/i;
const BROWSER_APPS = /\b(safari|chrome|chromium|arc|firefox|brave|edge|opera|orion|dia|comet)\b/i;
const CONFIRM_TARGETS =
  /\b(pay|buy|purchase|checkout|order|transfer|invoice|subscribe|donate|delete|remove|trash|erase|discard|send|reply|post|tweet|publish|submit|share|forward|sign|confirm|cancel|unsubscribe)\b/i;

export function classify(action: ComputerAction): Classification {
  const kind = action.kind.trim().toLowerCase();
  const app = action.app ?? "";
  const target = action.target ?? "";
  const known =
    READ_ONLY_KINDS.has(kind) ||
    CLIPBOARD_KINDS.has(kind) ||
    POINTER_KINDS.has(kind) ||
    TYPING_KINDS.has(kind) ||
    HAND_OFF_KINDS.has(kind);

  if (!known) {
    return {
      level: "hand-off",
      reason: `unknown action kind ${JSON.stringify(action.kind)} — unclassified actions are never allowed to run`,
    };
  }

  if (READ_ONLY_KINDS.has(kind)) {
    return { level: "always-allowed", reason: `${kind} is read-only; it observes the screen without side effects` };
  }

  if (CLIPBOARD_KINDS.has(kind)) {
    return {
      level: "pre-approvable",
      reason: `${kind} may synthesize Cmd+C and round-trip the clipboard, so it is not side-effect free`,
    };
  }

  // Hand-off outranks everything with side effects: a pre-approvable click
  // stops being pre-approvable the moment it lands in System Settings.
  if (HAND_OFF_KINDS.has(kind)) {
    return { level: "hand-off", reason: `${kind} is in the hand-off class; Kevin does this step himself` };
  }
  if (HAND_OFF_APPS.test(app)) {
    return {
      level: "hand-off",
      reason: `"${action.app}" is a system-settings/terminal/credential surface; Kevin drives those directly`,
    };
  }
  if (HAND_OFF_TARGETS.test(target)) {
    return {
      level: "hand-off",
      reason: `target "${action.target}" looks credential-shaped; Kevin enters secrets himself`,
    };
  }

  if (TYPING_KINDS.has(kind)) {
    return { level: "always-confirm", reason: `${kind} writes into whatever holds focus; confirm at action time` };
  }
  if (BROWSER_APPS.test(app)) {
    return {
      level: "always-confirm",
      reason: `"${action.app}" is a browser; a live web page can turn any click into an external side effect`,
    };
  }
  if (CONFIRM_TARGETS.test(target)) {
    return { level: "always-confirm", reason: `target "${action.target}" touches money, messages, or deletion` };
  }

  if (action.focusedWindow === true) {
    return { level: "pre-approvable", reason: `${kind} in the already-focused window; pre-approval covers it` };
  }
  // Unknown focus is treated like wrong focus: stricter, never looser.
  return {
    level: "always-confirm",
    reason: `${kind} outside the focused window (or with focus unknown) can steal focus mid-task; confirm first`,
  };
}

/**
 * The enforcement half: whether an action at this level may run right now.
 * Pre-approval only ever unlocks the pre-approvable tier — passing
 * preApproved=true for a hand-off action changes nothing.
 */
export function isAllowed(level: ConfirmLevel, preApproved: boolean): boolean {
  if (level === "always-allowed") return true;
  if (level === "pre-approvable") return preApproved;
  return false;
}
