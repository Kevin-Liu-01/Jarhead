import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { AUTOMATION_ACTING_KINDS, AUTOMATION_ACTION_KINDS, AUTOMATION_ACTIONS_MAX, AUTOMATION_FOLDER_WATCHERS_MAX, AUTOMATION_LINE_CHARS, AUTOMATION_POLL_MIN_S, AUTOMATION_WAKE_COOLDOWN_MIN_S, recipeNamed, type AutomationAction, type AutomationActionKind, type AutomationClauses, type AutomationSettings, type AutomationWhen } from "@jarhead/protocol";
import { REPO_ROOT } from "./env.ts";

/**
 * What Jarhead may do without asking.
 *
 * An assistant that asks before almost everything is useless for the thing it is
 * for. The default here: anything on Kevin's own machine runs, unless it
 * is destructive (then a spoken yes first) or on the never-list (then never, yes or
 * no). Jarhead is gated by policy, not by absence: the tools can do everything, and
 * this module is the one place that says what needs a question.
 *
 * Four classifiers, one vocabulary:
 *   classifyAction      the hands and run_shell (the shell gate lives here)
 *   classifyPath        the file tools: which paths are secrets, where writes ask
 *   classifyAppleScript osascript, with `do shell script` sent through the shell gate
 *   classifyUrl         web_fetch / open_url
 *   classifyAutomation  an automation at set-up (never at fire: nobody is there to ask)
 *
 * Pure: callers pass what they know (the app, the visible label, the command, the
 * request Kevin made, the resolved real path) and get a verdict with a reason the
 * model can read out loud. The shell gate is lexical — it reads the command, it
 * does not run it — so it is written to fail closed: wrappers are stripped, inner
 * shells are read, paths are normalised, and anything that sweeps a folder holding
 * a secret is refused whether or not the secret's own name appears. The runner adds
 * what a pure function cannot know (the real path behind a symlink, the working
 * directory, the frontmost app) and redacts secret values from every result.
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
  /**
   * A standing yes from earlier in this conversation covers this app and this
   * action class (`Decision.grant`): the hands-off question is not asked again.
   * Never a destructive verb — those keep asking — and never anything refused.
   */
  readonly granted?: boolean | undefined;
  /** Kevin at the Mac, as the hands see it; absent when the caller cannot tell (the shell, the browser tools). */
  readonly presence?: Presence | undefined;
  /** run_shell: pids of processes Jarhead itself started; stopping them is housekeeping, not destruction. */
  readonly ownedPids?: readonly number[] | undefined;
  /** run_shell: Jarhead's own scratch directories (self-edit worktrees); deleting inside them runs. */
  readonly scratchRoots?: readonly string[] | undefined;
  /** run_shell: the working directory (relative paths and `git commit` are judged against it). */
  readonly cwd?: string | undefined;
  /** The running Jarhead checkout; shell writes into it ask (default REPO_ROOT). */
  readonly repoRoot?: string | undefined;
  /** Kevin's home, for tests; defaults to the real one. */
  readonly home?: string | undefined;
  /** browser_*: the page the action lands on; payment and credential pages ask first. */
  readonly url?: string | undefined;
}

export interface Decision {
  readonly verdict: Verdict;
  readonly reason: string;
  /**
   * On a `confirm`: the action class a yes opens for the rest of the conversation in
   * this app ("click", "type"). Absent when the yes is good for this one action only —
   * every destructive verb (send, pay, purchase, delete, post, publish, transfer…) and
   * everything outside the hands-off table.
   */
  readonly grant?: string;
  /**
   * On a `confirm`: this is not a question but a hold — the presence gate found Kevin
   * away from the Mac. Nothing to arm: the tool tells the brain, the brain tells Kevin,
   * and the action goes through the whole gate again when he is back and asks again.
   */
  readonly hold?: boolean;
}

/**
 * Whether Kevin is at the Mac, leg by leg. Each leg is true, false, or unknown
 * (undefined); only a leg that is known false holds an action back.
 */
export interface Presence {
  /** The wake word or ear activity within `PRESENCE_WINDOW_MS` (the engine's presenceAt). */
  readonly recent?: boolean | undefined;
  /** The screen is not locked (CGSessionCopyCurrentDictionary, read by the hands). */
  readonly unlocked?: boolean | undefined;
  /** The app the action lands on is the one in front. */
  readonly frontmost?: boolean | undefined;
}

const READ_ONLY = new Set(["screenshot", "zoom", "cursor_position", "wait", "read", "list_windows", "focused_text", "element_at"]);
const POINTER = new Set(["left_click", "right_click", "middle_click", "double_click", "triple_click", "mouse_move", "left_mouse_down", "left_mouse_up", "left_click_drag", "scroll"]);
const KEYS = new Set(["type", "key", "hold_key"]);

/**
 * The action class a conversation-scoped grant is keyed on: pointer members are one
 * class ("click"), `type` another ("type"). Undefined for everything else — `key` and
 * `hold_key` included: a key press in a password manager (cmd+delete on a login item,
 * space on a checkbox) is not covered by a yes to "type there", and the policy never
 * reads the combo, so each one asks on its own.
 */
export function grantClassOf(kind: string): string | undefined {
  const k = kind.trim().toLowerCase();
  if (POINTER.has(k)) return "click";
  if (k === "type") return "type";
  return undefined;
}

/**
 * Hands-off apps where no yes is kept: System Settings and Keychain Access are the
 * machine's security surface, where one click flips FileVault or a privacy grant. A
 * yes there is good for that one action.
 */
export const GRANT_NEVER_APPS = /\b(system settings|system preferences|keychain access)\b/i;

/**
 * Under a standing grant in a hands-off app, controls that still ask: anything that
 * flips a setting (a checkbox, a switch, a radio button) or moves, opens or hands out
 * what the app guards. The grant opened the app for ordinary clicks and typing, not
 * for these.
 */
export const GRANTED_STILL_ASKS = /\b(AXCheckBox|AXSwitch|AXRadioButton|AXToggle|trash|archive|allow|enable|disable|turn (on|off)|reset|revoke|export|import|autofill|unlock)\b/i;

/** The accessibility roles that flip a setting, in the words the question uses. */
const SETTING_ROLE: Record<string, string> = { checkbox: "checkbox", switch: "switch", radiobutton: "radio button", toggle: "toggle" };

/** The grant class a hands-off question may carry: the kind's class, unless the app keeps every yes per action. */
function grantableIn(kind: string, app: string): string | undefined {
  if (GRANT_NEVER_APPS.test(app)) return undefined;
  return grantClassOf(kind);
}

/** Words on a control that mean "this leaves the machine or cannot be undone". */
const IRREVERSIBLE =
  /\b(send|reply|post|tweet|publish|submit|share|forward|pay|buy|purchase|checkout|place (your )?order|order now|transfer|donate|subscribe|delete|remove|erase|destroy|discard|empty trash|permanently|unsubscribe|sign|confirm|approve|merge|force[- ]push|deploy|release|shutdown|restart|log out|sign out)\b/i;

/** Apps where Kevin drives; Jarhead only looks. */
export const HANDS_OFF_APPS = /\b(1password|keychain access|system settings|system preferences|bitwarden|authy|banking|wallet)\b/i;

// ---- presence gate (added 2026-09-12; Operator's Watch Mode, kept because it costs nothing when Kevin is there) ----

/**
 * Apps where a confirm-tier action also needs Kevin at the Mac: mail, messaging,
 * money and password managers. Adjacent to HANDS_OFF_APPS: those ask before *any*
 * action; these ask only for the actions that already ask, and add the question
 * "is he here" — so a yes said an hour ago, or a brain acting while the screen is
 * locked, sends nothing. Matched on the front app's name, by whole word.
 */
export const PRESENCE_GATED_APPS = /\b(mail|messages|outlook|airmail|spark|mimestream|thunderbird|slack|discord|whatsapp|telegram|signal|teams|1password|bitwarden|keychain access|authy|banking|wallet|venmo|paypal|zelle|cash app|robinhood|coinbase)\b/i;
/** The same kinds as web apps, for an action whose page URL is known (the browser tools pass `url`). */
export const PRESENCE_GATED_HOSTS = /(^|\.)(mail\.google\.com|outlook\.(live|office)\.com|mail\.proton\.me|mail\.yahoo\.com|web\.whatsapp\.com|web\.telegram\.org|app\.slack\.com|discord\.com|messages\.google\.com|teams\.microsoft\.com|paypal\.com|venmo\.com|coinbase\.com|binance\.com|kraken\.com|robinhood\.com|schwab\.com|fidelity\.com|chase\.com|wellsfargo\.com|bankofamerica\.com|citi\.com|1password\.com|bitwarden\.com|lastpass\.com)$/i;
/** How long the wake word or ear activity counts as "Kevin is here". */
export const PRESENCE_WINDOW_MS = 60_000;
/** What the tool says when it holds an action for him (terse; the brain reads it out). */
export const PRESENCE_ABSENT = "I'll do this when you're back at the Mac";

/** Whether the app or page an action lands on is one of the presence-gated kinds. */
export function presenceGated(app: string | undefined, url: string | undefined): boolean {
  if (app && PRESENCE_GATED_APPS.test(app)) return true;
  if (!url) return false;
  try {
    return PRESENCE_GATED_HOSTS.test(new URL(url.trim()).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Why a confirm-tier action in a presence-gated app waits for Kevin, if it does: the first leg known to be false. */
export function presenceReason(ctx: Pick<ActionContext, "app" | "url" | "presence">): string | undefined {
  const p = ctx.presence;
  if (!p || !presenceGated(ctx.app, ctx.url)) return undefined;
  const where = ctx.app ? ` in ${ctx.app}` : "";
  if (p.unlocked === false) return `the screen is locked, so nothing${where} happens now; ${PRESENCE_ABSENT}`;
  if (p.frontmost === false) return `${ctx.app ?? "the target app"} is not the app in front; ${PRESENCE_ABSENT}`;
  if (p.recent === false) return `Kevin has not said anything for a minute, so this${where} waits; ${PRESENCE_ABSENT}`;
  return undefined;
}

const run = (reason: string): Decision => ({ verdict: "run", reason });
const confirm = (reason: string, grant?: string): Decision => (grant ? { verdict: "confirm", reason, grant } : { verdict: "confirm", reason });
const refuse = (reason: string): Decision => ({ verdict: "refuse", reason });

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ------------------------------------------------------------------- paths ---

/** Directories whose contents are disposable; deleting there is housekeeping. */
export const TEMP_ROOTS: readonly string[] = ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];

/**
 * Files and folders that hold secrets. Never read, never written, never named in
 * a shell command, confirmed or not: keys, tokens, cookies, saved logins, the
 * wake gate's passphrase. Each entry matches inside an absolute path and inside
 * a command line (hence the lookahead instead of `$`).
 */
const END = String.raw`(?=$|[\s"'/;|&)>])`;
const START = String.raw`(^|[\s"'=/])`;
const SECRET_PATHS: ReadonlyArray<{ readonly re: RegExp; readonly what: string }> = [
  { re: new RegExp(String.raw`\.jarhead/env(\.[\w.-]+)?${END}`), what: "~/.jarhead/env" },
  { re: new RegExp(String.raw`\.jarhead/wake-auth\.json${END}`), what: "the wake gate's passphrase file" },
  { re: /(^|[\s"'=/])~?\/?\.ssh(\/|(?=$|[\s"';|&)]))/, what: "~/.ssh" },
  { re: /(^|[\s"'=/])~?\/?\.aws(\/|(?=$|[\s"';|&)]))/, what: "~/.aws" },
  { re: /(^|[\s"'=/])~?\/?\.gnupg(\/|(?=$|[\s"';|&)]))/, what: "~/.gnupg" },
  { re: /(^|\/)Library\/Keychains(\/|(?=$|[\s"';|&)]))/, what: "the keychain" },
  { re: /(^|\/)Library\/Cookies(\/|(?=$|[\s"';|&)]))/, what: "the browser cookie store" },
  { re: new RegExp(String.raw`${START}(Cookies|Cookies-journal|Cookies\.binarycookies|Login Data|Login Data-journal|Login Data For Account|Web Data)${END}`), what: "a browser cookie or saved-login store" },
  { re: new RegExp(String.raw`\.(pem|p12|pfx)${END}`, "i"), what: "a private key or certificate bundle" },
  { re: /(^|\/)\.codex\/auth\.json/, what: "~/.codex/auth.json" },
  { re: /(^|\/)\.claude\/\.credentials/, what: "~/.claude/.credentials" },
  { re: new RegExp(String.raw`${START}\.env(\.(?!example|sample|template|dist)[\w.-]+)?${END}`), what: "a .env file" },
  { re: new RegExp(String.raw`${START}\.(netrc|git-credentials|pypirc|npmrc)${END}`), what: "a credentials file" },
  { re: /(^|\/)\.docker\/config\.json/, what: "the Docker credentials store" },
  { re: /(^|\/)\.config\/gh\/hosts\.yml/, what: "the GitHub CLI token store" },
  { re: new RegExp(String.raw`${START}\.kube/config${END}`), what: "the kubeconfig" },
];

/** Which secret store a path or command names, if any. */
export function secretPathReason(pathOrCommand: string): string | undefined {
  for (const { re, what } of SECRET_PATHS) if (re.test(pathOrCommand)) return what;
  return undefined;
}

/**
 * Folders that hold a secret store among ordinary files. Naming the folder
 * itself to anything that reads recursively, archives, copies or globs reaches
 * the secret without spelling its name; so does running a command from inside it.
 */
const SECRET_HOLDERS: ReadonlyArray<{ readonly re: RegExp; readonly dir: string; readonly what: string }> = [
  { re: /(^|[\s"'=])~\/\.jarhead\/?(\.|\*\*?)?(?=$|[\s"';|&)])/, dir: ".jarhead", what: "~/.jarhead, which holds env" },
  { re: /(^|[\s"'=])~\/\.codex\/?(\.|\*\*?)?(?=$|[\s"';|&)])/, dir: ".codex", what: "~/.codex, which holds auth.json" },
  { re: /(^|[\s"'=])~\/\.claude\/?(\.|\*\*?)?(?=$|[\s"';|&)])/, dir: ".claude", what: "~/.claude, which holds its credentials" },
  { re: /~\/Library\/Application Support\/(Google\/Chrome|Chromium|BraveSoftware\/Brave-Browser|Microsoft Edge|Vivaldi|Arc)(\/(Default|Profile \d+|Guest Profile))?\/?(\*\*?)?(?=$|[\s"';|&)])/, dir: "a browser profile", what: "a browser profile, which holds cookies and saved logins" },
  { re: /~\/Library\/Application Support\/Firefox(\/Profiles(\/[^\s"'/]+)?)?\/?(\*\*?)?(?=$|[\s"';|&)])/, dir: "a browser profile", what: "a Firefox profile, which holds cookies and saved logins" },
];

/** Commands that only look at a folder's names or size; naming a secret holder to them is fine. */
const LOOK_ONLY = new Set(["ls", "open", "mkdir", "du", "df", "stat", "tree", "test", "[", "[[", "echo", "printf", "file", "realpath", "readlink", "exa", "eza", "lsd", "dirname", "basename", "cd", "pushd", "pwd", "which", "type", "mdls", "xattr", "GetFileInfo"]);

export function expandPath(p: string, home: string = homedir()): string {
  let out = p.trim();
  if (out === "~" || out.startsWith("~/")) out = home + out.slice(1);
  out = out.replace(/^\$\{?HOME\}?(?=\/|$)/, home).replace(/^\$\{?TMPDIR\}?(?=\/|$)/, process.env["TMPDIR"] ?? "/tmp");
  if (!isAbsolute(out)) out = resolve(home, out);
  return resolve(out);
}

/** macOS spells /var, /tmp and /etc as /private/var, /private/tmp, /private/etc once a path is resolved; one spelling for comparisons. */
function canon(p: string): string {
  return p.replace(/^\/private(?=\/(var|tmp|etc)(\/|$))/, "");
}

function isUnder(path: string, root: string): boolean {
  const p = canon(path);
  const r0 = canon(root);
  const r = r0.endsWith(sep) ? r0.slice(0, -1) : r0;
  return p === r || p.startsWith(r + sep);
}

/** Strictly inside: the root itself does not count (wiping /tmp is not housekeeping). */
function isInside(path: string, root: string): boolean {
  const p = canon(path);
  const r0 = canon(root);
  const r = r0.endsWith(sep) ? r0.slice(0, -1) : r0;
  return p !== r && p.startsWith(r + sep);
}

/** The temp roots, minus any that contain the home itself (a test's home under /var/folders is not disposable). */
function tempRoots(home: string): string[] {
  return TEMP_ROOTS.filter((r) => !isUnder(home, r));
}

/** Paths Kevin spoke or typed in his request ("save it in ~/notes", "/Users/kevinliu/jarvis"). */
export function namedPaths(request: string | undefined, home: string = homedir()): string[] {
  if (!request) return [];
  const out: string[] = [];
  for (const m of request.matchAll(/(?:^|[\s"'`(])((?:~|\$HOME)?\/[A-Za-z0-9._~-][^\s"'`,;:)]*)/g)) {
    const token = (m[1] ?? "").replace(/[.,;:!?]+$/, "");
    if (token.length > 1) out.push(expandPath(token, home));
  }
  return out;
}

/** Files and folders that decide what runs at login or in every shell; a write there is persistence, named folder or not. */
function autostartReason(p: string, home: string): string | undefined {
  const rel = p.startsWith(home + sep) ? `~${p.slice(home.length)}` : p;
  if (/^~\/Library\/LaunchAgents(\/|$)/.test(rel) || /^\/Library\/Launch(Agents|Daemons)(\/|$)/.test(rel) || /^\/System\/Library\/Launch(Agents|Daemons)(\/|$)/.test(rel)) return "that changes what runs at login";
  if (/^~\/Library\/Application Support\/com\.apple\.backgroundtaskmanagement(\/|$)/.test(rel) || /^~\/\.config\/autostart(\/|$)/.test(rel)) return "that changes what runs at login";
  if (/^~\/\.(zshrc|zprofile|zshenv|zlogin|zlogout|bashrc|bash_profile|bash_login|profile|hushlogin)$/.test(rel)) return "that changes every shell Kevin opens";
  if (/^\/etc\/(paths|paths\.d\/|profile|zshrc|zprofile|bashrc|hosts|sudoers)/.test(rel)) return "that changes every shell Kevin opens";
  return undefined;
}

/** The trash is move-only: the one refusal both the path gate and the shell gate give for writing or deleting there. */
export const TRASH_REASON = "the trash (~/.jarhead/trash) is move-only: whole days move in and out by rename and nothing is written or deleted there by a tool; Jarhead never deletes Kevin's data, and Reveal in Finder is how he empties it";

export type PathAccess = "read" | "write" | "delete";

export interface PathContext {
  readonly path: string;
  readonly access: PathAccess;
  readonly home?: string | undefined;
  /**
   * The real path behind `path` once symlinks are resolved (the runner computes
   * it; for a file that does not exist yet, its parent's real path plus the name).
   * Both spellings are checked against the secret stores and the write roots.
   */
  readonly realPath?: string | undefined;
  /** Where writes run without asking, beyond /tmp and ~/.jarhead: the current self-edit worktrees. */
  readonly writableRoots?: readonly string[] | undefined;
  /** Kevin's own words for this task (never the model's); a folder he named in them is writable for this task. */
  readonly request?: string | undefined;
  readonly confirmed?: boolean | undefined;
  /** For writes: the file already exists … */
  readonly exists?: boolean | undefined;
  /** … and the brain read it during this task (overwriting something it never looked at asks first). */
  readonly readThisTask?: boolean | undefined;
  /** The running Jarhead checkout (default REPO_ROOT); writes into it ask even when Kevin named the folder. */
  readonly repoRoot?: string | undefined;
}

/**
 * Reads run anywhere but the secret stores. Writes run inside Jarhead's own
 * places (its worktrees, /tmp, ~/.jarhead) and folders Kevin named; elsewhere,
 * over a file the brain has not read this task, or for any deletion, they ask.
 * The ledger is append-only and settings.json carries the wake gate: both ask.
 * The running checkout and anything that runs at login ask whatever he named.
 */
export function classifyPath(ctx: PathContext): Decision {
  const home = ctx.home ?? homedir();
  const p = expandPath(ctx.path, home);
  const real = ctx.realPath ? resolve(ctx.realPath) : p;
  const secret = secretPathReason(p) ?? (real !== p ? secretPathReason(real) : undefined);
  if (secret) return refuse(`${secret} holds secrets; Jarhead never reads or writes it, and Kevin handles it himself`);
  if (ctx.access === "read") return run("reading is harmless on Kevin's own machine");
  const stateDir = resolve(home, ".jarhead");
  const targets = real !== p ? [p, real] : [p];
  // The trash (added 2026-09-12): where Kevin's moved conversations and screenshots live. Move-only — whole
  // days move in and out by rename(2), from the engine; no tool writes or deletes there, yes or no. Compared
  // case-folded: APFS is case-insensitive by default, so ~/.jarhead/Trash IS the trash.
  const trashDir = resolve(stateDir, "trash").toLowerCase();
  if (targets.some((t) => isUnder(t.toLowerCase(), trashDir))) return refuse(TRASH_REASON);
  if (ctx.confirmed) return run(`Kevin confirmed ${ctx.access === "delete" ? "deleting" : "writing"} ${p}`);
  if (ctx.access === "delete") return confirm(`deleting ${p} cannot be undone; ask first`);
  if (targets.some((t) => isUnder(t, resolve(stateDir, "ledger")))) return confirm("the ledger is append-only; writing there needs a yes");
  if (targets.some((t) => t === resolve(stateDir, "settings.json"))) return confirm("settings.json carries the wake gate and the brain choice; changing it needs a yes");
  for (const t of targets) {
    const auto = autostartReason(t, home);
    if (auto) return confirm(`${auto}; ask first`);
  }
  const writable = [...tempRoots(home), stateDir, ...(ctx.writableRoots ?? []).map((r) => expandPath(r, home))];
  const repo = expandPath(ctx.repoRoot ?? REPO_ROOT, home);
  if (targets.some((t) => isUnder(t, repo)) && !targets.every((t) => writable.some((r) => isUnder(t, r)))) {
    return confirm(`${p} is inside the running Jarhead checkout; self_edit is the way to change Jarhead, so editing it in place needs a yes`);
  }
  const roots = [...writable, ...namedPaths(ctx.request, home)];
  if (!targets.every((t) => roots.some((r) => isUnder(t, r)))) {
    const where = real !== p ? `${p} (really ${real})` : p;
    return confirm(`${where} is outside the places Jarhead writes without asking (its worktrees, /tmp, ~/.jarhead, or a folder Kevin named); ask first`);
  }
  if (ctx.exists && !ctx.readThisTask) return confirm(`${p} exists and was not read during this task; overwriting it needs a yes`);
  return run(`writing ${p} is inside Jarhead's own places or a folder Kevin named`);
}

// ------------------------------------------------------------------- shell ---

/** Commands that are never run by voice, confirmed or not. */
const NEVER_SHELL: ReadonlyArray<{ readonly re: RegExp; readonly why: string }> = [
  { re: /\bmkfs(\.\w+)?\b/, why: "formats a disk" },
  { re: /\bdiskutil\s+(erase\w*|reformat|partitionDisk|zeroDisk|randomDisk|secureErase|apfs\s+delete\w*)\b/i, why: "erases a disk" },
  { re: /\bdd\b[^|;&]*\bof=\/dev\//, why: "writes raw bytes to a device" },
  { re: /(^|[\s;&|(])(shutdown|reboot|halt|poweroff)\b/, why: "powers the Mac off or restarts it" },
  { re: /\bsecurity\s+(dump-keychain|export|delete-keychain|delete-(generic|internet)-password|find-(generic|internet)-password|unlock-keychain|set-keychain-password)\b/, why: "reads or destroys the keychain" },
  { re: /\btccutil\s+reset\b(?![^|;&]*jarhead)/i, why: "resets another app's privacy grants" },
  { re: /\bcrontab\s+(-\w*r|--remove)\b/, why: "wipes the crontab" },
  { re: /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:\s*&[^}]*\}\s*;?\s*:/, why: "is a fork bomb" },
  { re: /\brm\s+(-\w+\s+)*(--\s+)?("?(\/|~|\$\{?HOME\}?|\/Users\/[\w.-]+|\/System|\/Library|\/usr|\/etc|\/var|\/private)\/?"?)(\s|$)/, why: "deletes the system or the home folder" },
  { re: /\b(chmod|chown)\s+(-\w+\s+)*\S+\s+\/(\s|$)/, why: "changes permissions on the root of the disk" },
  { re: /\blaunchctl\s+(bootout|unload|remove|disable)\s+system\b/, why: "unloads system services" },
  { re: /\b(csrutil|nvram|sysadminctl)\b/, why: "changes system security settings" },
  { re: /\bspctl\s+--(master|global)-disable\b/, why: "disables Gatekeeper" },
  { re: /\bdscl\b[^|;&]*\s-(passwd|delete|create)\b/, why: "changes user accounts" },
  { re: /\bosascript\b[^|;&]*\b(shut down|log out)\b/i, why: "powers the Mac off or logs Kevin out" },
  { re: /\b(shred|srm)\s/, why: "destroys files beyond recovery" },
  { re: /\bhistory\s+-c\b/, why: "erases the shell history" },
];

/** Environment variables whose names say they hold a secret; reading one is refused even though the child environment is scrubbed. */
const SECRET_NAME = /(^|_)(API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_KEY|ACCESS_KEY|CLIENT_SECRET|AUTH_KEY)(_|$)/i;

/** Why a command would read a secret out of the environment, if it would: `$X`, `${X}`, `printenv X`, `os.environ["X"]`, `process.env.X`, `$ENV{X}`. */
export function secretEnvReason(text: string): string | undefined {
  const refs = [
    ...text.matchAll(/\$\{?[#!]?([A-Za-z_]\w*)/g),
    ...text.matchAll(/\bprintenv\s+(?:-\w+\s+)*([A-Za-z_]\w*)/g),
    ...text.matchAll(/(?:os\.environ(?:\.get)?\s*[[(]\s*["']|process\.env\.|process\.env\[["']|\$ENV\{|\bENV\[["']|getenv\(\s*["']|\bsystem attribute\s+")([A-Za-z_]\w*)/g),
  ];
  for (const m of refs) if (m[1] && SECRET_NAME.test(m[1])) return `that command would reveal ${m[1]} from the environment`;
  return undefined;
}

/** Downloads piped into an interpreter: the classic install one-liner. */
const PIPE_TO_SHELL: readonly RegExp[] = [
  /\b(curl|wget|fetch)\b[^|]*\|\s*(sudo\s+(-\w+\s+)*)?(ba|z|k|da|fi)?sh\b/,
  /\b(curl|wget)\b[^|]*\|\s*(sudo\s+(-\w+\s+)*)?(python\d*|node|perl|ruby|php|deno|bun)\b/,
  /\b(ba|z|k)?sh\s+(-\w+\s+)*-c\s+["']?\$\(\s*(curl|wget)\b/,
  /\b(ba|z|k)?sh\s+<\(\s*(curl|wget)\b/,
  /\beval\s+["']?\$\(\s*(curl|wget)\b/,
  /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh)\s+-s\b/,
];

/** Destructive but sometimes wanted: a spoken yes first. */
const DESTRUCTIVE_SHELL: ReadonlyArray<{ readonly re: RegExp; readonly why: string }> = [
  { re: /(^|[\s;&|(])(sudo|doas)\s/, why: "runs as root" },
  { re: /\bgit\s+push\b[^|;&]*(--force(-with-lease)?\b|\s-f\b|\s-\w*f\w*\b)/, why: "a force push rewrites history on the remote" },
  { re: /\bgit\s+push\b[^|;&]*(--delete\b|\s:\S)/, why: "that deletes a remote branch" },
  { re: /\bgit\s+push\b/, why: "a push leaves this machine" },
  { re: /\bgit\s+reset\s+(-\w+\s+)*--hard\b/, why: "git reset --hard discards uncommitted work" },
  { re: /\bgit\s+clean\b[^|;&]*(\s-\w*f|--force)/, why: "git clean -f deletes untracked files" },
  { re: /\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/, why: "that discards every uncommitted change" },
  { re: /\bgit\s+stash\s+(drop|clear)\b/, why: "that drops stashed work" },
  { re: /\bgit\s+branch\s+(-\w*D\b|--delete\s+--force)/, why: "that deletes an unmerged branch" },
  { re: /\b(npm|pnpm|yarn|cargo|gem|twine|poetry)\s+(publish|unpublish|push|upload)\b/, why: "publishing leaves this machine and cannot be taken back" },
  { re: /\bbrew\s+(uninstall|remove|rm|autoremove|zap)\b/, why: "uninstalls software" },
  { re: /\bollama\s+(pull|rm|create|push|cp|run|launch)\b/, why: "fetches, runs, changes or removes local model weights (gigabytes; `run` and `launch` pull a missing model and wait at a prompt) — ask first" },
  { re: /\b(lms)\s+(get|import|rm)\b/, why: "fetches or removes local model weights — ask first" },
  { re: /\bdefaults\s+(write|delete|import)\b/, why: "changes app or system preferences" },
  { re: /\blaunchctl\b/, why: "launchctl changes what runs at login" },
  { re: /(^|[\s;&|(])killall\b/, why: "killall stops processes Jarhead did not start" },
  { re: /(^|[\s;&|(])pkill\b/, why: "pkill stops processes Jarhead did not start" },
  { re: /\b(chmod|chown|chgrp)\s+(-\w*R\b|--recursive)/, why: "recursive permission changes are hard to undo" },
  { re: /\b(DROP\s+(DATABASE|TABLE|SCHEMA)|TRUNCATE(\s+TABLE)?|dropdb|db:(drop|reset|schema:load)|migrate\s+reset|flushall|flushdb)\b/i, why: "that drops data" },
  { re: /\b(docker|podman)\s+(system\s+prune|rm\b|rmi\b|volume\s+(rm|prune)|compose\s+down\b[^|;&]*(\s-v\b|--volumes)|container\s+(rm|prune)|image\s+(rm|prune))/, why: "that deletes containers or their data" },
  { re: /\bkubectl\s+(delete|drain)\b/, why: "that deletes cluster resources" },
  { re: /\b(aws|gcloud|az)\b[^|;&]*\b(delete|terminate|rm|remove|destroy|purge)\b/, why: "that deletes cloud resources" },
  { re: /\bterraform\s+(destroy|apply)\b/, why: "that changes infrastructure" },
  { re: /\b(vercel|fly|flyctl|netlify|heroku|wrangler|firebase)\b[^|;&]*(\b(deploy|publish)\b|--prod\b)/, why: "deploying publishes to the internet" },
  { re: /\bgh\s+(pr|issue|release|repo|gist)\s+(create|merge|close|delete|comment|edit|review|reopen|transfer)\b/, why: "that posts to GitHub on Kevin's behalf" },
  { re: /\b(scp|sftp|rsync)\b[^|;&]*\s\S+:\S*/, why: "that copies files to or from another machine" },
  { re: /\brsync\b[^|;&]*\s--delete\w*/, why: "rsync --delete removes whatever the destination has that the source lacks" },
  { re: /(^|[\s;&|(])(mail|mailx|sendmail|msmtp)\s/, why: "that sends mail" },
  { re: /\bfind\b[^|;&]*\s-delete\b/, why: "find -delete removes files" },
  { re: /\bfind\b[^|;&]*\s-(exec|execdir|ok|okdir)\s+(\S+\/)?(rm|unlink|shred|srm|truncate|mv|chmod|chown)\b/, why: "find -exec runs a destructive command on whatever it finds" },
  { re: /\bxargs\b[^|;&]*\b(rm|unlink|shred|mv|truncate)\b/, why: "that deletes or moves whatever the pipeline names" },
  { re: /\bxargs\b[^|;&]*\b(cat|grep|rg|ag|head|tail|base64|xxd|strings|less|more|curl|scp)\b/, why: "that reads or sends whatever the pipeline names" },
  { re: /(^|[\s;&|(])unlink\s/, why: "that deletes a file" },
  { re: /\bcp\s+(-\w+\s+)*\/dev\/null\s+\S/, why: "that empties a file" },
  { re: /\btccutil\b/, why: "that changes privacy grants" },
  { re: /\b(spctl|systemsetup|networksetup|pmset|scutil)\b/, why: "that changes system settings" },
  { re: /\bcodex\s+exec\b[^|;&]*(\s-s\s+(workspace-write|danger-full-access)|--full-auto|--dangerously-bypass-approvals-and-sandbox|--sandbox\s+(workspace-write|danger-full-access))/, why: "that lets Codex write files outside Jarhead's own gates (self_edit and agent_start are the checked ways)" },
  { re: /\bclaude\b[^|;&]*(--dangerously-skip-permissions|--permission-mode\s+(acceptEdits|bypassPermissions))/, why: "that lets Claude Code write files outside Jarhead's own gates" },
  ...PIPE_TO_SHELL.map((re) => ({ re, why: "that pipes a download straight into a shell" })),
];

/** Commands that only look, so mentioning /System or /usr is fine. */
const READ_ONLY_SHELL = /^\s*(ls|cat|head|tail|less|more|grep|rg|ag|find|stat|file|wc|du|df|which|type|open|mdls|mdfind|plutil\s+-p|defaults\s+read|codesign|otool|nm|strings|xattr\s+-l|tree|bat|readlink|realpath|diff|cmp|md5|shasum|sha256sum|echo|printf|man|ps|lsof|pgrep|uptime|date|whoami|id|uname|sw_vers|system_profiler|log\s+show|log\s+stream)\b/;
const SYSTEM_PATH = /(^|[\s"'=])\/(System|Library|usr\/(?!local\/)|bin|sbin|etc|var\/(?!folders)|private\/(?!tmp|var\/folders))/;
/** A redirect or tee into a system directory writes there whatever the command's first word is. */
const SYSTEM_WRITE = /(>{1,2}\s*["']?|\btee\s+(-a\s+)?["']?)\/(System|Library|usr\/(?!local\/)|bin|sbin|etc|var\/(?!folders)|private\/(?!tmp|var\/folders))/;
/** Writes into what runs at login, in the home: LaunchAgents, login items, rc files. */
const PERSISTENCE_WRITE = /(>{1,2}\s*["']?|\btee\s+(-a\s+)?["']?|\b(cp|mv|ln|install|ditto|rsync)\b[^|;&]*\s["']?)(~\/Library\/LaunchAgents|~\/Library\/Application Support\/com\.apple\.backgroundtaskmanagement|~\/\.config\/autostart|~\/\.(zshrc|zprofile|zshenv|zlogin|zlogout|bashrc|bash_profile|bash_login|profile|hushlogin)(?=$|[\s"';|&)]))/;
/** `>` over a config file, wherever the command came from. */
const CONFIG_TRUNCATE = /(^|[^>])>\|?\s*["']?~\/(\.(gitconfig|vimrc|tmux\.conf|npmrc|yarnrc|config\/[^\s"']+)|\.jarhead\/settings\.json|\.jarhead\/ledger\/[^\s"']+)(?=$|[\s"';|&)])/;

interface Stmt {
  readonly text: string;
  /** The operator before this statement: `|` means it reads the previous one's output. */
  readonly sep: string | undefined;
}

/** Statements of a command line, split at ; && || | & and newlines, with the separator that preceded each. */
function splitStatements(text: string): Stmt[] {
  const parts = text.split(/(\|\||&&|;|\n|\|(?!\|)|(?<![<>&])&(?![&>\d]))/);
  const out: Stmt[] = [];
  let sep: string | undefined;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? "";
    if (i % 2 === 1) {
      sep = part.trim() || sep;
      continue;
    }
    const t = part.trim();
    if (t) out.push({ text: t, sep });
    if (i % 2 === 0) sep = undefined;
  }
  return out;
}

/** Just the text of each statement. */
function statements(text: string): string[] {
  return splitStatements(text).map((s) => s.text);
}

/** Wrappers that run another command: what follows them is what matters. */
const WRAPPERS = new Set(["command", "exec", "nohup", "time", "builtin", "caffeinate", "nice", "ionice", "then", "else", "do", "elif", "if", "until", "while", "sudo", "doas", "timeout", "gtimeout", "env", "!", "{", "("]);

/** `env FOO=1 nohup command rm x` → `rm x`. */
export function stripWrappers(stmt: string): string {
  const toks = stmt.trim().split(/\s+/);
  for (;;) {
    const t = toks[0];
    if (!t) break;
    if (/^[A-Za-z_]\w*=/.test(t)) {
      toks.shift();
      continue;
    }
    const bare = t.replace(/^\\|^\/usr\/bin\/|^\/bin\//, "");
    if (!WRAPPERS.has(bare)) break;
    toks.shift();
    if (bare === "timeout" || bare === "gtimeout") {
      while (toks[0]?.startsWith("-")) toks.shift();
      if (/^\d/.test(toks[0] ?? "")) toks.shift();
    } else if (bare === "nice") {
      if (toks[0] === "-n") toks.splice(0, 2);
      else if (/^-n?\d+$/.test(toks[0] ?? "")) toks.shift();
    } else if (bare === "sudo" || bare === "doas") {
      while (toks[0]?.startsWith("-")) {
        const f = toks.shift()!;
        if (/^-[ugCDhpRrtU]$/.test(f)) toks.shift();
      }
    } else if (bare === "env") {
      while (toks[0] && (toks[0].startsWith("-") || /^[A-Za-z_]\w*=/.test(toks[0]))) {
        const f = toks.shift()!;
        if (f === "-u" || f === "-C" || f === "-S") toks.shift();
      }
    } else {
      while (toks[0]?.startsWith("-")) {
        const f = toks.shift()!;
        if ((bare === "caffeinate" && f === "-t") || (bare === "exec" && f === "-a") || (bare === "time" && f === "-f")) toks.shift();
      }
    }
  }
  return toks.join(" ");
}

/** The program a statement runs, without its path. */
function commandOf(stmt: string): string {
  const first = stripWrappers(stmt).split(/\s+/)[0] ?? "";
  return first.replace(/^\\/, "").replace(/^.*\//, "");
}

/** The command an inner shell or eval would run, when it is written out: `bash -c 'rm -rf x'`, `eval "rm x"`, `su kevin -c '…'`. */
function innerCommands(stmt: string): string[] {
  const out: string[] = [];
  const s = stripWrappers(stmt);
  const shell = /^(?:\S*\/)?(?:ba|z|k|da|fi|c|tc)?sh\b[^'"]*?\s-\w*c\w*\s+(?:(['"])([\s\S]*?)\1|(\S+))/.exec(s);
  if (shell) out.push(shell[2] ?? shell[3] ?? "");
  const ev = /^eval\s+(?:(['"])([\s\S]*?)\1|([\s\S]+))$/.exec(s);
  if (ev) out.push(ev[2] ?? ev[3] ?? "");
  const su = /^su\b[^'"]*?-c\s+(?:(['"])([\s\S]*?)\1|(\S+))/.exec(s);
  if (su) out.push(su[2] ?? su[3] ?? "");
  return out.filter((c) => c.trim());
}

/** The command line plus every literal inner command it would run, a few levels deep. */
function expandInner(text: string, depth = 0): string[] {
  const out = [text];
  if (depth >= 3) return out;
  for (const stmt of statements(text)) for (const inner of innerCommands(stmt)) out.push(...expandInner(inner, depth + 1));
  return out;
}

/** Home, `$HOME` and `/Users/<name>` as `~`; `/./` and `//` collapsed, so a path reads the same however it was spelt. */
export function normalizeShell(text: string, home: string): string {
  let s = text;
  if (home && home !== "/") for (const h of new Set([home, canon(home), `/private${canon(home)}`])) s = s.replaceAll(h, "~");
  s = s.replace(/\$\{?HOME\}?(?=\/|\s|$|["'])/g, "~");
  s = s.replace(/(?<![:/])\/(\.\/)+/g, "/");
  s = s.replace(/(?<![:/])\/{2,}/g, "/");
  return s;
}

function pathIsDisposable(raw: string, home: string, scratch: readonly string[]): boolean {
  const p = expandPath(raw.replace(/^["']|["']$/g, ""), home);
  if (p === "/dev/null") return true;
  return [...tempRoots(home), ...scratch].some((r) => isInside(p, expandPath(r, home)));
}

/** A destination in a temp root (the root itself included) or the bit bucket: what lands there is gone for practical purposes. */
function destIsTemp(raw: string, home: string, scratch: readonly string[]): boolean {
  const p = expandPath(raw.replace(/^["']|["']$/g, ""), home);
  if (p === "/dev/null") return true;
  return [...tempRoots(home), ...scratch].some((r) => isUnder(p, expandPath(r, home)));
}

/** `rm` of anything outside the temp dirs and Jarhead's scratch, whatever wrapper it hides behind. */
function rmReason(text: string, home: string, scratch: readonly string[]): string | undefined {
  for (const stmt of statements(text)) {
    const s = stripWrappers(stmt);
    const m = /^(?:\\|\/bin\/|\/usr\/bin\/)?rm\s+(.*)$/.exec(s);
    if (!m) continue;
    const args = (m[1] ?? "").split(/\s+/).filter(Boolean);
    const flags = args.filter((a) => a.startsWith("-") && a !== "--");
    const paths = args.filter((a) => !a.startsWith("-") || a === "--").filter((a) => a !== "--");
    const forced = flags.some((f) => /^-\w*[rRf]/.test(f) || f === "--recursive" || f === "--force");
    const kept = paths.filter((p) => !pathIsDisposable(p, home, scratch));
    if (kept.length > 0) return `rm${forced ? " -rf" : ""} of ${kept.slice(0, 3).join(", ")} cannot be undone`;
  }
  return undefined;
}

const HOME_TOP_LEVEL = new Set(["Documents", "Desktop", "Downloads", "Library", "Pictures", "Movies", "Music", "Applications", "Public", "Developer", "Sites"]);

/** `mv` of a top-level home folder, or of anything real into a temp folder (a deletion by another name). */
function mvReason(text: string, home: string, scratch: readonly string[]): string | undefined {
  for (const stmt of statements(text)) {
    const s = stripWrappers(stmt);
    const m = /^(?:\\|\/bin\/|\/usr\/bin\/)?mv\s+(.*)$/.exec(s);
    if (!m) continue;
    const args = (m[1] ?? "").split(/\s+/).filter((a) => a && !a.startsWith("-"));
    if (args.length < 2) continue;
    const dest = args[args.length - 1]!;
    const srcs = args.slice(0, -1);
    for (const src of srcs) {
      const p = expandPath(src.replace(/^["']|["']$/g, ""), home);
      if (p === home || (dirname(p) === home && HOME_TOP_LEVEL.has(basename(p)))) return `that moves ${src}, a top-level home folder`;
    }
    if (destIsTemp(dest, home, scratch) && srcs.some((src) => !destIsTemp(src, home, scratch))) return `moving ${srcs[0]} into a temp folder is a deletion by another name`;
  }
  return undefined;
}

/** `> file`, `: > file`, `true > file`: emptying a file that is not disposable. */
function truncateReason(text: string, home: string, scratch: readonly string[]): string | undefined {
  for (const stmt of statements(text)) {
    const s = stripWrappers(stmt);
    const m = /^(?::|true)?\s*>\|?\s*(["']?)([^\s"']+)\1\s*$/.exec(s);
    if (m && m[2] && !pathIsDisposable(m[2], home, scratch)) return `that empties ${m[2]}`;
  }
  return undefined;
}

/** `kill` of a pid Jarhead did not start (its own background processes are fair game). */
function killReason(text: string, owned: readonly number[]): string | undefined {
  for (const stmt of statements(text)) {
    const s = stripWrappers(stmt);
    const m = /^kill\s+(.*)$/.exec(s);
    if (!m) continue;
    const args = (m[1] ?? "").split(/\s+/).filter(Boolean);
    const targets = args.filter((a) => !a.startsWith("-") && !/^(KILL|TERM|INT|HUP|USR1|USR2|SIGKILL|SIGTERM|SIGINT|SIGHUP)$/.test(a));
    if (targets.length === 0) return "kill without a pid Jarhead started";
    const foreign = targets.filter((t) => !/^\d+$/.test(t) || !owned.includes(Number(t)));
    if (foreign.length > 0) return `kill of ${foreign.join(", ")}, which Jarhead did not start`;
  }
  return undefined;
}

/** `env`, `printenv`, `export -p`, `set`, `ps -E`: the whole environment, which can carry keys Kevin's shell exported. */
function envDumpReason(text: string): string | undefined {
  for (const stmt of statements(text)) {
    const s = stmt.replace(/^(?:[A-Za-z_]\w*=\S*\s+)+/, "").trim();
    if (/^(?:\\|\/usr\/bin\/)?(env|printenv)(\s+(-0|--null))?\s*$/.test(s)) return "that dumps the environment, which can carry keys Kevin's shell exported";
    if (/^(export(\s+-p)?|set|(declare|typeset)(\s+-[xp]+)?)\s*$/.test(s)) return "that dumps the shell's variables, which can carry keys Kevin's shell exported";
    if (/^ps\s+(-\w*[Ee]\w*|e\w*)(\s|$)/.test(s) || /^ps\b[^|;&]*\s-o\s+\S*(env|command=?\s*-E)/.test(s)) return "that dumps other processes' environments, which can carry keys";
    if (/^launchctl\s+(getenv|export)\b/.test(s)) return "that reads the login environment, which can carry keys";
  }
  return undefined;
}

const INTERPRETER = /(^|[\s;&|(])(python[\d.]*|node|bun|deno|perl|ruby|php)\s+(?:-\w+\s+)*?(-c|-e|--eval|-p|-r|eval)\s+/;
const NET_IN_CODE = /(urlopen|urllib|requests\.|http\.client|httpx|aiohttp|\bsocket\b|fetch\(|https?:\/\/|\bnet\.|dgram|XMLHttpRequest|axios|\bLWP\b|Net::|open-uri|\bSocket\b|\bcurl\b|\bwget\b|smtplib|paramiko|ftplib|websocket)/;
const DELETE_IN_CODE = /(rmtree|os\.remove|os\.unlink|os\.rmdir|\.unlink\(|rmSync|unlinkSync|rmdirSync|fs\.rm\b|promises\.rm\b|FileUtils\.(rm|remove)|\bunlink\b|remove_tree|File\.delete|shutil\.move|renameSync)/;

/**
 * A script written on the command line that reaches the network or deletes
 * files: the gate cannot read it, so it asks. Judged on the whole line, because
 * the `;` inside the quoted script would otherwise split it into harmless halves.
 */
function interpreterReason(text: string): string | undefined {
  const m = INTERPRETER.exec(text);
  if (!m) return undefined;
  const code = text.slice(m.index);
  if (NET_IN_CODE.test(code)) return "that script reaches the network from code the gate cannot read";
  if (DELETE_IN_CODE.test(code)) return "that script deletes or moves files from code the gate cannot read";
  return undefined;
}

/**
 * Outbound data: a network client carrying a file, the output of another command,
 * a request body, or the previous statement's output. A plain GET of a URL runs.
 */
function egressReason(text: string): string | undefined {
  for (const st of splitStatements(text)) {
    const s = stripWrappers(st.text);
    const cmd = commandOf(st.text);
    if (/^(nc|ncat|netcat|socat|telnet)$/.test(cmd) && /\s\S/.test(s)) return "that opens a raw network connection";
    if (/^openssl$/.test(cmd) && /^openssl\s+s_client\b/.test(s)) return "that opens a raw network connection";
    const client = /^(curl|wget|http|https|xh|ssh|sftp|ftp|lftp)$/.test(cmd);
    if (!client) continue;
    if (st.sep === "|") return "that pipes data to the network";
    if (/\$\(|`/.test(s)) return "that sends the output of another command off this machine";
    if (/\s<\s*["']?[\w./~$-]/.test(s)) return "that sends a file off this machine";
    if (cmd === "curl") {
      if (/(^|[\s=,"'])@[\w./~$-]/.test(s)) return "that sends a file off this machine";
      if (/\s(--upload-file|--data(-\w+)?|--json|--form(-string)?)(\s|=|$)/.test(s) || /\s-[a-zA-Z]*[dFT][a-zA-Z]*(\s|=|$)/.test(s)) return "that sends data off this machine";
      if (/\s(-X|--request)\s*(POST|PUT|PATCH|DELETE)\b/i.test(s)) return "that sends data off this machine";
    } else if (cmd === "wget") {
      if (/\s--(post-file|post-data|body-file|body-data)(\s|=)/.test(s) || /\s--method=(POST|PUT|PATCH|DELETE)\b/i.test(s)) return "that sends data off this machine";
    } else if (/^(http|https|xh)$/.test(cmd)) {
      if (/(^|[\s=])@[\w./~$-]/.test(s) || /\s(POST|PUT|PATCH|DELETE)\s/.test(s)) return "that sends data off this machine";
    }
  }
  return undefined;
}

/** Sweeping the home folder or its Library: a recursive reader prints secrets; an archiver copies them. */
const HOME_ROOT = /(^|[\s"'=])(~|~\/|~\/Library|~\/Library\/)(?=$|[\s"';|&)])/;
const RECURSIVE_READER = /^(grep\s+(-\w*[rR]\w*|--recursive|--dereference-recursive)|rg\b|ag\b|ack\b|ugrep\b|ripgrep\b)/;
const FIND_EXEC_READER = /\bfind\b[^|;&]*\s-(exec|execdir|ok|okdir)\s+(\S+\/)?(cat|head|tail|grep|rg|base64|xxd|strings|less|more|cp|scp|curl|wget|tar|zip|(ba|z|k)?sh|python\S*|node|perl|ruby)\b/;
const ARCHIVER = /^(tar|zip|7z|7za|ditto|hdiutil|rsync|cp\s+(-\w*[rRa]\w*|--recursive)|cpio|pax)\b/;

function homeSweepReason(norm: string): { readonly refuse?: string; readonly confirm?: string } {
  for (const stmt of statements(norm)) {
    if (!HOME_ROOT.test(stmt)) continue;
    const s = stripWrappers(stmt);
    if (RECURSIVE_READER.test(s) || FIND_EXEC_READER.test(s)) return { refuse: "that reads every file under the home folder, secret stores included" };
    if (ARCHIVER.test(s)) return { confirm: "that copies the whole home folder, secret stores included" };
  }
  return {};
}

/** Why a command reaches a secret store without naming it, if it does. Text is normalised (home → ~). */
function secretSweepReason(norm: string): string | undefined {
  for (const stmt of statements(norm)) {
    const s = stripWrappers(stmt);
    const cmd = commandOf(stmt);
    if (/~\/\.(jarhead|codex|claude)\/[^\s"']*[*?[]/.test(stmt)) return "a wildcard inside that folder can expand to its secret file";
    if (/(^|[\s"'=])~\/\.[\w-]*[*?[][^\s"']*/.test(stmt)) return "a wildcard over the hidden folders in the home can reach a secret store";
    for (const holder of SECRET_HOLDERS) {
      if (!holder.re.test(stmt)) continue;
      if (/^(cd|pushd)$/.test(cmd) || /\s(-C|--directory(=|\s))\s*["']?~\//.test(s) || /\s-C\s*["']?~\//.test(stmt)) return `commands run from ${holder.what.split(",")[0]} reach its secrets by their bare names; run them from another folder with full paths`;
      if (LOOK_ONLY.has(cmd)) continue;
      return `that command sweeps ${holder.what}`;
    }
  }
  return undefined;
}

/**
 * `.jarhead/trash` named on a command line — under `~`, `$HOME`, any home spelling, a quote,
 * `./` or `//` in the path, any case (APFS folds it) — followed by `/` or the end of a word.
 * Text is normalised (home → ~) before the test; the pattern does not rely on it.
 */
const TRASH_PATH = /(^|[\s"'=\/~])\.jarhead(\/\.)*\/+trash(\/|(?=$|[\s"';|&),}]))/i;
/** `~/.jarhead/{trash,}`, `~/.jarhead/{ledger,trash}`: a brace that expands to the trash. */
const TRASH_BRACE = /\.jarhead(\/\.)*\/+\{[^}]*\btrash\b[^}]*\}/i;
/** Deleting and emptying, wherever on the line: once the trash is named anywhere, its name flows through pipes, variables and braces the gate cannot follow. */
const TRASH_DELETERS = /^(rm|rmdir|unlink|shred|srm|truncate)$/;
/** Code the gate cannot read, on a line that names the trash: refused whole. */
const TRASH_INTERPRETERS = /^(python[\d.]*|node|bun|deno|perl|ruby|php|osascript|swift|tclsh|lua[\d.]*)$/;
/** Copy-like commands: the destination decides (into the trash is a write); `mv` moves the trash or into it either way. */
const TRASH_COPIERS = /^(cp|rsync|ln|install|ditto|scp)$/;

function namesTrash(s: string): boolean {
  return TRASH_PATH.test(s) || TRASH_BRACE.test(s);
}

/**
 * Why a shell command would write into, delete from, empty or move the trash, if it
 * would: the trash is move-only (added 2026-09-12). Lexical and fail-closed: once the
 * trash is named anywhere on the line, every deleter, interpreter and in-place editor
 * on that line is refused (names travel down pipes, into variables and braces); a
 * `cd` / `pushd` into it or a variable holding it puts the rest of the line in the
 * trash, where anything that is not look-only is refused; `cp` / `rsync` / `ln` /
 * `install` are refused when their destination is the trash, `mv` / `dd` / `tee` /
 * `sed -i` whenever the statement names it, and a redirect into it always.
 */
function trashReason(norm: string): string | undefined {
  if (!namesTrash(norm)) return undefined;
  let inTrash = false; // `cd ~/.jarhead/trash`, or `T=~/.jarhead/trash`: what follows runs there or reaches it by the variable
  for (const st of splitStatements(norm)) {
    const stmt = st.text;
    const s = stripWrappers(stmt);
    const cmd = commandOf(stmt);
    const named = namesTrash(stmt) || inTrash;
    if (/^(cd|pushd)$/.test(cmd)) {
      inTrash = namesTrash(stmt);
      continue;
    }
    if (/^(export\s+|declare\s+(-\w+\s+)*|local\s+|typeset\s+)?[A-Za-z_]\w*=/.test(stmt) && s === "") {
      // A bare assignment: `T=~/.jarhead/trash` puts the trash in every `$T` that follows.
      if (namesTrash(stmt)) inTrash = true;
      continue;
    }
    if (TRASH_DELETERS.test(cmd) || TRASH_INTERPRETERS.test(cmd)) return TRASH_REASON;
    if (cmd === "find" && /\s-(delete|exec|execdir|ok|okdir)\b/.test(s)) return TRASH_REASON;
    if (cmd === "xargs" && /\b(rm|rmdir|unlink|shred|srm|mv|cp|truncate|tee|dd|ln|install)\b/.test(s)) return TRASH_REASON;
    if (!named) continue;
    if (/^(mv|dd|tee|rmdir|chmod|chown|touch|mkdir|patch|zip|tar|unzip)$/.test(cmd)) return TRASH_REASON;
    if (/^(sed|perl|ruby)$/.test(cmd) && /\s-\w*i/.test(s)) return TRASH_REASON;
    if (TRASH_COPIERS.test(cmd)) {
      const args = s.split(/\s+/).filter((a) => a && !a.startsWith("-"));
      const dest = args[args.length - 1] ?? "";
      if (inTrash || namesTrash(` ${dest}`) || (cmd === "rsync" && /\s--delete/.test(s)) || (cmd === "ln" && namesTrash(s))) return TRASH_REASON;
    }
    if (/(^|[^>&\d])>{1,2}(?!&)/.test(stmt) && (inTrash || /(^|[^>&\d])>{1,2}(?!&)\s*["']?[^\s"']*\.jarhead(\/\.)*\/+trash/i.test(stmt))) return TRASH_REASON;
    if (inTrash && cmd !== "" && !LOOK_ONLY.has(cmd) && !TRASH_READERS.test(cmd)) return TRASH_REASON;
  }
  return undefined;
}
/** Reading from inside the trash (after a `cd` there) is fine: these only print. */
const TRASH_READERS = /^(cat|head|tail|less|more|grep|rg|wc|bat|jq|sort|uniq|diff|cmp|md5|shasum|sha256sum|strings|hexdump|xxd)$/;

/** ssh and friends name a key file after -i without reading it into anything; only that form passes, and only on that statement. */
function withoutIdentityFlags(stmt: string): string {
  const s = stripWrappers(stmt);
  if (!/^(ssh|scp|sftp|rsync|ssh-add|ssh-keygen|git)\b/.test(s)) return stmt;
  return stmt.replace(/(^|\s)(-i|-F)\s+\S+/g, "$1").replace(/IdentityFile=\S+/g, "");
}

/** Why a shell command is refused outright, if it is. */
export function shellNeverReason(text: string, home: string = homedir()): string | undefined {
  for (const expansion of expandInner(text)) {
    for (const { re, why } of NEVER_SHELL) if (re.test(expansion)) return `that command ${why}`;
    const norm = normalizeShell(expansion, home);
    const cleaned = statements(norm).map(withoutIdentityFlags).join(" ; ");
    const secret = secretPathReason(cleaned);
    if (secret) return `that command touches ${secret}, which holds secrets`;
    const env = secretEnvReason(expansion);
    if (env) return env;
    const sweep = secretSweepReason(norm);
    if (sweep) return sweep;
    const trash = trashReason(norm);
    if (trash) return trash;
    const home_ = homeSweepReason(norm);
    if (home_.refuse) return home_.refuse;
  }
  return undefined;
}

/** Why a shell command with the working directory in a secret-holding folder is refused, if it is; the runner passes both spellings of the cwd. */
export function shellCwdReason(cwd: string, home: string = homedir(), realCwd?: string): string | undefined {
  for (const c of realCwd && realCwd !== cwd ? [cwd, realCwd] : [cwd]) {
    const p = canon(expandPath(c, home));
    const secret = secretPathReason(p);
    if (secret) return `the working directory is inside ${secret}, which holds secrets`;
    const rel = normalizeShell(p, home);
    if (/^~\/\.(jarhead|codex|claude)\/?$/.test(rel)) return `commands run from ${rel} reach its secrets by their bare names; run them from another folder with full paths`;
  }
  return undefined;
}

const REPO_REASON = "that edits the running Jarhead checkout; self_edit is the way to change Jarhead, so doing it in place asks first";
const GIT_WRITE = /^git\s+(?:-C\s+\S+\s+)?(?:-c\s+\S+\s+)*(commit|merge|apply|checkout|switch|reset|rebase|cherry-pick|am|revert|pull|rm|mv|clean|worktree|stash\s+(pop|apply|drop|clear)|branch\s+(-[dDmM]|--delete|--move)|tag|filter-branch|update-ref|symbolic-ref|restore)\b/;
const PKG_WRITE = /^(pnpm|npm|yarn|bun)\s+(add|remove|rm|uninstall|un|update|up|upgrade|link|dedupe|i|install)\s+[^-\s]/;

/** Writes into the running Jarhead checkout by shell, whether it is named or is the working directory. */
function repoWriteReason(norm: string, repoNorm: string, cwdInRepo: boolean): string | undefined {
  const repoRe = new RegExp(String.raw`(^|[\s"'=])${escapeRe(repoNorm)}(\/|(?=$|[\s"';|&)]))`);
  let inRepo = cwdInRepo;
  for (const st of splitStatements(norm)) {
    const s = stripWrappers(st.text);
    const names = repoRe.test(st.text);
    if (/^(cd|pushd)\s/.test(s)) {
      inRepo = names;
      continue;
    }
    if (!names && !inRepo) continue;
    if (GIT_WRITE.test(s)) return REPO_REASON;
    if (/^(sed|perl|ruby)\s+(?:-\w+\s+)*-\w*i/.test(s)) return REPO_REASON;
    if (/(^|[^>&\d])>{1,2}(?!&)\s*(?!\s)["']?(?!\/dev\/null|\/tmp\/|\/private\/tmp\/|\$TMPDIR|~\/\.jarhead\/|&)/.test(st.text) || /\btee\b/.test(s)) return REPO_REASON;
    if (/^(cp|mv|rsync|ln|install|ditto)\s/.test(s)) {
      const args = s.split(/\s+/).filter((a) => a && !a.startsWith("-"));
      const dest = args[args.length - 1] ?? "";
      if (repoRe.test(` ${dest}`) || (inRepo && !isAbsolute(dest) && !dest.startsWith("~"))) return REPO_REASON;
    }
    if (/^codex\b/.test(s) && (names || inRepo)) {
      if (!/\s-s\s+read-only\b|--sandbox\s+read-only\b/.test(s) && /\bexec\b|--full-auto|-s\s|--sandbox/.test(s)) return REPO_REASON;
    }
    if (/^claude\b/.test(s) && (names || inRepo) && /\s-p\b|--print|--dangerously|--permission-mode/.test(s)) return REPO_REASON;
    if (PKG_WRITE.test(s)) return REPO_REASON;
    if (/^(patch|touch|mkdir|truncate|chmod|chown|dd)\s/.test(s) && names) return REPO_REASON;
  }
  return undefined;
}

/** Why a shell command needs a yes, if it does. */
export function shellDestructiveReason(text: string, ctx: Pick<ActionContext, "ownedPids" | "scratchRoots" | "home" | "cwd" | "repoRoot"> = {}): string | undefined {
  const home = ctx.home ?? homedir();
  const repo = expandPath(ctx.repoRoot ?? REPO_ROOT, home);
  const cwdInRepo = ctx.cwd ? isUnder(expandPath(ctx.cwd, home), repo) : false;
  for (const expansion of expandInner(text)) {
    for (const { re, why } of DESTRUCTIVE_SHELL) if (re.test(expansion)) return why;
    const rm = rmReason(expansion, home, ctx.scratchRoots ?? []);
    if (rm) return rm;
    const kill = killReason(expansion, ctx.ownedPids ?? []);
    if (kill) return kill;
    const mv = mvReason(expansion, home, ctx.scratchRoots ?? []);
    if (mv) return mv;
    const trunc = truncateReason(expansion, home, ctx.scratchRoots ?? []);
    if (trunc) return trunc;
    const dump = envDumpReason(expansion);
    if (dump) return dump;
    const egress = egressReason(expansion);
    if (egress) return egress;
    const script = interpreterReason(expansion);
    if (script) return script;
    const norm = normalizeShell(expansion, home);
    const sweep = homeSweepReason(norm);
    if (sweep.confirm) return sweep.confirm;
    if (PERSISTENCE_WRITE.test(norm)) return "that changes what runs at login or in every shell";
    if (CONFIG_TRUNCATE.test(norm)) return "that overwrites a config file";
    const repoWrite = repoWriteReason(norm, normalizeShell(repo, home), cwdInRepo);
    if (repoWrite) return repoWrite;
    if (SYSTEM_WRITE.test(expansion)) return "that writes into a system directory";
    if (SYSTEM_PATH.test(expansion) && !READ_ONLY_SHELL.test(expansion)) return "that touches a system directory";
    if (/\bosascript\b/.test(expansion)) {
      const as = classifyAppleScript({ script: expansion, confirmed: false, home });
      if (as.verdict === "confirm") return as.reason.replace(/; ask first$/, "");
    }
  }
  return undefined;
}

function classifyShell(text: string, ctx: ActionContext): Decision {
  const home = ctx.home ?? homedir();
  if (!text.trim()) return refuse("empty command");
  const never = shellNeverReason(text, home);
  if (never) return refuse(`${never}; it is on the never list`);
  if (ctx.cwd) {
    const cwd = shellCwdReason(ctx.cwd, home);
    if (cwd) return refuse(`${cwd}; it is on the never list`);
  }
  if (/\bosascript\b/.test(text)) {
    const as = classifyAppleScript({ script: text, confirmed: ctx.confirmed, home, ownedPids: ctx.ownedPids });
    if (as.verdict === "refuse") return as;
  }
  const risk = shellDestructiveReason(text, ctx);
  if (risk) return ctx.confirmed ? run("Kevin confirmed this command") : confirm(`${risk}; ask first`);
  return run("nothing in that command is destructive on Kevin's own machine");
}

// ------------------------------------------------------------- applescript ---

export interface AppleScriptContext {
  readonly script: string;
  readonly confirmed?: boolean | undefined;
  readonly ownedPids?: readonly number[] | undefined;
  readonly home?: string | undefined;
  /** The frontmost app: where keystrokes land when the script names no target of its own. */
  readonly app?: string | undefined;
}

const TELL_APP = /\btell\s+(?:application|app|process)\s+"([^"]+)"/gi;
const INPUT_WORDS = /\b(keystroke|key code|click|set value|set the value|perform action)\b/i;
const MESSAGING_APPS = "Mail|Messages|Microsoft Outlook|Outlook|Slack|Discord|WhatsApp|Telegram|Signal|Airmail|Spark";
const SENDS_MESSAGE = new RegExp(String.raw`\btell\s+(application|app)\s+"(${MESSAGING_APPS})"[\s\S]*\bsend\b`, "i");

/** `"a" & "b"` → `"ab"`, repeatedly, so a path split across literals is still one path. */
export function foldAppleScriptLiterals(script: string): string {
  let s = script;
  for (;;) {
    const next = s.replace(/"((?:[^"\\]|\\.)*)"\s*&\s*"((?:[^"\\]|\\.)*)"/g, '"$1$2"');
    if (next === s) return s;
    s = next;
  }
}

/**
 * osascript. The whole script is read for secret stores and secret variables
 * (literals folded first); `do shell script` must be one literal string and goes
 * through the shell gate; a path built from pieces asks; keystrokes into a
 * hands-off app — named, or in front — are refused or asked like the hands';
 * anything that sends or deletes asks; power and login changes are never.
 */
export function classifyAppleScript(ctx: AppleScriptContext): Decision {
  const s = ctx.script;
  const home = ctx.home ?? homedir();
  if (!s.trim()) return refuse("empty script");
  if (/\btell\s+(application|app)\s+"(System Events|Finder|loginwindow)"[\s\S]*\b(shut down|restart|log out|sleep)\b/i.test(s) || /^\s*(shut down|restart|log out)\s*$/im.test(s)) {
    return refuse("that script powers the Mac off, restarts it or logs Kevin out; it is on the never list");
  }
  if (/with administrator privileges/i.test(s)) return refuse("that script needs an administrator password; Kevin does that himself");
  const folded = foldAppleScriptLiterals(s);
  const norm = normalizeShell(folded, home);
  // HFS paths spell the separator as a colon ("Macintosh HD:Users:kevin:.aws:credentials").
  const secret = secretPathReason(norm) ?? secretPathReason(norm.replace(/:/g, "/"));
  if (secret) return refuse(`that script touches ${secret}, which holds secrets; it is on the never list`);
  const env = secretEnvReason(folded);
  if (env) return refuse(`${env}; it is on the never list`);
  const sweep = secretSweepReason(norm);
  if (sweep) return refuse(`${sweep}; it is on the never list`);
  const targets: string[] = [];
  for (const m of s.matchAll(TELL_APP)) {
    const app = m[1] ?? "";
    targets.push(app);
    if (HANDS_OFF_APPS.test(app) && INPUT_WORDS.test(s)) return refuse(`${app} holds credentials or system settings; Jarhead never types or clicks there`);
  }
  const asks: string[] = [];
  for (const m of folded.matchAll(/do shell script\s+([^\n]+)/g)) {
    const arg = (m[1] ?? "").trim();
    const lit = /^"((?:[^"\\]|\\.)*)"(?:\s+(?:with|without|in|as|user name|password|altering)\b.*)?$/.exec(arg);
    if (!lit) return refuse("do shell script with a computed command cannot be checked; make it one literal string, or use run_shell");
    const inner = (lit[1] ?? "").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    const d = classifyAction({ kind: "run_shell", text: inner, confirmed: ctx.confirmed, ownedPids: ctx.ownedPids, home });
    if (d.verdict === "refuse") return d;
    if (d.verdict === "confirm") asks.push(d.reason.replace(/; ask first$/, ""));
  }
  const landsInFront = ctx.app && INPUT_WORDS.test(s) && targets.every((t) => /^system events$/i.test(t));
  if (landsInFront && HANDS_OFF_APPS.test(ctx.app!)) asks.push(`${ctx.app} is in front and holds credentials or system settings; the keystrokes would land there`);
  const builtPath = /\bset\s+\w+\s+to\s+[^\n]*&[^\n]*/i.test(folded) || /\(\s*[^"\n()]*&[^"\n()]*\)/.test(folded);
  if (builtPath && /\b(read|open for access|POSIX file|POSIX path|alias|file)\b/i.test(folded)) asks.push("that script builds a file path from pieces the gate cannot read; one literal path, or read_file, would not need asking");
  if (SENDS_MESSAGE.test(s) || /^\s*send\b/im.test(s)) asks.push("that sends a message on Kevin's behalf");
  if (/\b(delete|empty(\s+the)?\s+trash|move\b[^\n]*\bto\s+(the\s+)?trash|erase)\b/i.test(s)) asks.push("that deletes something");
  if (asks.length > 0) return ctx.confirmed ? run("Kevin confirmed this script") : confirm(`${asks.join("; ")}; ask first`);
  return run("nothing in that script sends, deletes or touches a hands-off app");
}

// -------------------------------------------------------------------- urls ---

/** `::ffff:127.0.0.1`, `::ffff:7f00:1`, `::7f00:1` → `127.0.0.1`; `::` → `0.0.0.0`. */
function mappedIPv4(host: string): string | undefined {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "::" || /^(0{1,4}:){7}0{1,4}$/.test(h)) return "0.0.0.0";
  let rest: string;
  if (h.startsWith("::")) rest = h.slice(2);
  else if (/^(0{1,4}:)+/.test(h)) rest = h.replace(/^(0{1,4}:)+/, "");
  else return undefined;
  const parts = rest.split(":");
  if (parts[0] === "ffff") parts.shift();
  if (parts.length === 1 && /^\d+\.\d+\.\d+\.\d+$/.test(parts[0]!)) return parts[0];
  if (parts.length === 2 && parts.every((p) => /^[0-9a-f]{1,4}$/.test(p))) {
    const hi = parseInt(parts[0]!, 16);
    const lo = parseInt(parts[1]!, 16);
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return undefined;
}

/** localhost, 127/8, ::1, 0.0.0.0, their IPv6-mapped spellings, and the *.localhost names. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const v4 = mappedIPv4(h);
  if (v4 && v4 !== h) return isLoopbackHost(v4);
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h) || h === "0.0.0.0" || h === "::";
}

/** RFC 1918 / link-local / ULA / .local: the same LAN, not the internet. */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isLoopbackHost(h)) return true;
  const v4 = mappedIPv4(h);
  if (v4 && v4 !== h) return isPrivateHost(v4);
  if (h.endsWith(".local") || h.endsWith(".lan") || h.endsWith(".home.arpa") || h.endsWith(".internal")) return true;
  if (/^10\.\d+\.\d+\.\d+$/.test(h)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(h)) return true;
  if (/^169\.254\.\d+\.\d+$/.test(h)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(h) || /^fe80:/i.test(h)) return true;
  return false;
}

export interface UrlContext {
  readonly url: string;
  /** Kevin's own words for this task; a private host is fetched only when he named it (or its port, or "localhost"). */
  readonly request?: string | undefined;
}

/** https from the internet; http only to a private host Kevin named; never file:// or other schemes. */
export function classifyUrl(ctx: UrlContext): Decision {
  let u: URL;
  try {
    u = new URL(ctx.url.trim());
  } catch {
    return refuse(`"${ctx.url.slice(0, 80)}" is not a URL`);
  }
  if (u.protocol === "file:") return refuse("file:// is what the file tools are for; use read_file");
  if (u.protocol !== "http:" && u.protocol !== "https:") return refuse(`${u.protocol.replace(/:$/, "")} URLs are not fetched`);
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isPrivateHost(host)) {
    const req = ctx.request ?? "";
    const port = u.port ? new RegExp(String.raw`(^|\D)${u.port}(\D|$)`) : undefined;
    const named = req.includes(host) || (isLoopbackHost(host) && /\b(localhost|local(?:\s+dev)?\s+server|127\.0\.0\.1|dev server|my server)\b/i.test(req)) || (port !== undefined && port.test(req));
    if (!named) return refuse(`${host} is a private address; Jarhead fetches it only when Kevin names it`);
    return run(`Kevin named ${host}`);
  }
  if (u.protocol === "http:") return refuse("only https is fetched from the internet");
  return run("an https page on the internet");
}

// ------------------------------------------------------------------ actions ---

// ---------------------------------------------------------- browser, dictation ---

/** The browser tools that only look. */
const BROWSER_READS = new Set(["browser_read", "browser_find", "browser_tabs"]);
/** The browser tools that act on a page. */
const BROWSER_ACTIONS = new Set(["browser_click", "browser_type", "browser_navigate"]);

/**
 * Pages where a click or a keystroke moves money or a credential: checkout and payment
 * flows, logins and password screens, second factors, bank and wallet sites. Matched on
 * the host and path of the URL (the query string is noise), by whole word or segment.
 */
const RISKY_URL = /(^|[\/.\-_?=&#])(checkout|payments?|pay|billing|purchase|order|cart|subscribe|donate|transfer|withdraw|login|log-in|signin|sign-in|signup|sign-up|register|password|passwd|reset|auth|authorize|oauth|sso|saml|2fa|mfa|otp|verify|verification|credentials?|security|bank|banking|wallet|paypal|stripe|venmo|zelle|coinbase|binance|kraken|robinhood|schwab|fidelity|chase|wellsfargo|bankofamerica|citi)([\/.\-_?=&#]|$)/i;

/** Why a page URL asks for a yes before Jarhead clicks or types on it, if it does. */
export function riskyUrlReason(url: string | undefined): string | undefined {
  if (!url) return undefined;
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return undefined;
  }
  const where = `${u.hostname}${u.pathname}`.toLowerCase();
  const m = RISKY_URL.exec(where);
  if (!m) return undefined;
  return `the page looks like a payment or sign-in page (${m[2]} in ${u.hostname}${u.pathname.length > 1 ? u.pathname.slice(0, 40) : ""})`;
}

/**
 * The browser fast path. Reading (`browser_read`, `browser_find`, `browser_tabs`) runs.
 * Clicking, typing and navigating run on ordinary pages; on a payment or credential page
 * (URL keywords) or onto a control whose label says it is irreversible they ask first, and
 * typing into a password field is refused, yes or no.
 */
function classifyBrowser(kind: string, ctx: ActionContext): Decision {
  if (BROWSER_READS.has(kind)) return run(`${kind} only reads the page`);
  if (ctx.secureField && kind === "browser_type") return refuse("the focused field is a password field; Kevin types secrets himself");
  const app = ctx.app ?? "";
  if (HANDS_OFF_APPS.test(app)) return ctx.confirmed ? run(`Kevin confirmed acting in ${app}`) : confirm(`${app} holds credentials or system settings; ask before acting there`);
  const target = ctx.target ?? "";
  if (IRREVERSIBLE.test(target)) return ctx.confirmed ? run(`Kevin confirmed "${target}"`) : confirm(`"${target}" looks irreversible or leaves the machine; ask first`);
  const risky = riskyUrlReason(ctx.url);
  if (risky) return ctx.confirmed ? run(`Kevin confirmed ${kind} on that page`) : confirm(`${risky}; ask first`);
  return run(`${kind} is reversible on an ordinary page`);
}

/**
 * Dictation types Kevin's own words into the focused field as he says them. Never into a
 * password field, never into a hands-off app (a password manager, System Settings) — both
 * refused rather than asked, because a question mid-sentence is worse than a no.
 */
function classifyDictation(ctx: ActionContext): Decision {
  if (ctx.secureField) return refuse("the focused field is a password field; Kevin types secrets himself");
  const app = ctx.app ?? "";
  if (HANDS_OFF_APPS.test(app)) return refuse(`${app} holds credentials or system settings; Kevin types there himself`);
  return run("dictation into an ordinary field");
}

/**
 * The verdict, then the presence gate over it (added 2026-09-12): in a mail, messaging,
 * money or password-manager app, an action that is confirm-tier on its own merits — the
 * question it would ask, or did ask and got a yes or a standing grant for — also needs
 * Kevin at the Mac: spoken to Jarhead within the last minute, the screen unlocked, the
 * app in front. A leg known to be false turns the verdict into a `confirm` that says
 * "I'll do this when you're back at the Mac"; nothing lands. A refusal is never softened,
 * a plain `run` (a scroll, a click on Search) is never held, and a caller that cannot
 * tell (no `presence`) gets the plain verdict.
 */
export function classifyAction(ctx: ActionContext): Decision {
  const decision = classifyActionCore(ctx);
  if (decision.verdict === "refuse" || !ctx.presence) return decision;
  const tier = ctx.confirmed || ctx.granted ? classifyActionCore({ ...ctx, confirmed: false, granted: false }) : decision;
  if (tier.verdict !== "confirm") return decision;
  const away = presenceReason(ctx);
  return away ? { verdict: "confirm", reason: away, hold: true } : decision;
}

function classifyActionCore(ctx: ActionContext): Decision {
  const kind = ctx.kind.trim().toLowerCase();
  const app = ctx.app ?? "";
  const target = ctx.target ?? "";
  const text = ctx.text ?? "";

  if (READ_ONLY.has(kind)) return run(`${kind} only observes`);
  if (BROWSER_READS.has(kind) || BROWSER_ACTIONS.has(kind)) return classifyBrowser(kind, ctx);
  if (kind === "dictate") return classifyDictation(ctx);

  if (ctx.secureField && KEYS.has(kind)) {
    return refuse("the focused field is a password field; Kevin types secrets himself");
  }

  if (kind === "run_shell") return classifyShell(text, ctx);

  if (HANDS_OFF_APPS.test(app) && (POINTER.has(kind) || KEYS.has(kind))) {
    if (ctx.confirmed) return run(`Kevin confirmed acting in ${ctx.app}`);
    // The one question a yes may answer for the whole conversation (`grant`): acting in this
    // app, this class of action. A grant opens the app, not its destructive controls — a
    // "Delete" under a granted click still asks below.
    if (!ctx.granted) return confirm(`${ctx.app} holds credentials or system settings; ask before acting there`, grantableIn(kind, app));
  }

  if (IRREVERSIBLE.test(target)) {
    return ctx.confirmed ? run(`Kevin confirmed "${target}"`) : confirm(`"${target}" looks irreversible or leaves the machine; ask first`);
  }

  if (POINTER.has(kind) || KEYS.has(kind) || kind === "open_app" || kind === "focus_app") {
    if (ctx.granted && HANDS_OFF_APPS.test(app)) {
      // The grant covers the ordinary controls; a setting, a switch or a hand-out still asks, and its yes keeps nothing.
      const role = /\bAX(CheckBox|Switch|RadioButton|Toggle)\b/i.exec(target);
      const word = GRANTED_STILL_ASKS.exec(target);
      if (role || word || !grantableIn(kind, app)) {
        const why = role ? `is a ${SETTING_ROLE[role[1]!.toLowerCase()] ?? "setting"} control` : word ? `says "${word[1]}", which changes a setting or hands something out` : "is not covered by a standing yes";
        return confirm(`"${target}" in ${ctx.app} ${why}; Kevin's earlier yes does not cover it, ask first`);
      }
      return run(`Kevin's earlier yes covers ${grantClassOf(kind) ?? kind} in ${ctx.app} for this conversation`);
    }
    return run(`${kind} is reversible on Kevin's own machine`);
  }

  // Unknown kinds fail closed to a question, never to silence and never to action.
  return confirm(`unknown action kind "${ctx.kind}"; ask before running it`);
}

// ------------------------------------------------------------ automations ---
//
// The set-up gate (design11, 2026-09-14). An automation is judged ONCE, awake, when it is
// armed; at fire time nobody is there to answer, so anything that would be confirm-tier at
// fire is refused now — not asked now. `confirm` here is the one set-up question (a recipe
// running unattended, a key pressed unattended, the brain woken at a cost); Kevin's yes to
// this exact set-up (`ctx.confirmed`, the runner's consume()) turns it into `run`. Pure.

export interface AutomationContext {
  readonly when: AutomationWhen;
  readonly then: readonly AutomationAction[];
  readonly clauses: AutomationClauses;
  readonly settings: Pick<AutomationSettings, "enabled" | "unattended" | "wakeBudgetMinutesPerDay" | "recipes">;
  /** A recipe text arriving with the row (the engine writes it to Settings after the yes). */
  readonly recipeCommand?: string | undefined;
  /** Kevin said yes to this exact set-up (the runner's consume()). */
  readonly confirmed?: boolean | undefined;
  /** folder.file / download.done rows already armed. */
  readonly folderWatchers: number;
  /** A spawned thread is arming it (depth one: it may arm free kinds, never a brain wake). */
  readonly fromThread?: boolean | undefined;
  /** The brain is a local model (the cost line says warm-up, not plan). */
  readonly localBrain?: boolean | undefined;
  /** Kevin's own words for the row, when known; a folder he named is one `file` may move into. */
  readonly request?: string | undefined;
  readonly home?: string | undefined;
  readonly repoRoot?: string | undefined;
}

/** Trigger kinds typed for a later pass: never armed in pass 1, refused by name. */
export const AUTOMATION_RESERVED_TRIGGERS: ReadonlySet<string> = new Set(["clipboard.match", "network.changed", "automation.fired"]);
const AUTOMATION_TRIGGERS: ReadonlySet<string> = new Set(["folder.file", "download.done", "app.launch", "app.quit", "mac.wake", "screen.unlock", "display.connected", "display.disconnected", "recipe.red", "agent.status"]);
const FOLDER_TRIGGERS: ReadonlySet<string> = new Set(["folder.file", "download.done"]);
/** A key or chord a `press` may name: letters, digits, `+` and spaces ("cmd+s", "space", "cmd+shift+r"). */
const PRESS_KEY = /^[a-z0-9+ ]{1,32}$/i;
/** Keys that delete, quit, log out, force-quit, power off or eject: never pressed unattended, with or without a yes (the trash rule and IRREVERSIBLE, for a chord). */
const PRESS_NEVER_KEYS: ReadonlySet<string> = new Set(["delete", "del", "backspace", "forwarddelete", "power", "eject"]);
const PRESS_MODIFIERS: Readonly<Record<string, string>> = { cmd: "cmd", command: "cmd", meta: "cmd", opt: "opt", option: "opt", alt: "opt", ctrl: "ctrl", control: "ctrl", shift: "shift", fn: "fn" };

/**
 * Why a `press` combo may not be pressed unattended, if it may not: malformed, or a key that
 * deletes / quits / logs out / force-quits / powers off / ejects — `cmd+shift+delete` empties
 * the Trash for good, `cmd+q` discards state, `cmd+shift+q` logs out, `cmd+opt+esc` force-quits.
 * Judged at set-up and again by the executor before the key goes, so an older row cannot slip by.
 */
export function pressKeyReason(key: string): string | undefined {
  if (!PRESS_KEY.test(key)) return `"${key.slice(0, 40)}" is not a key or chord (letters, digits, + and spaces, up to 32)`;
  const parts = key.toLowerCase().split("+").map((w) => w.trim()).filter(Boolean).map((w) => PRESS_MODIFIERS[w] ?? w);
  const has = (k: string): boolean => parts.includes(k);
  const never = parts.some((w) => PRESS_NEVER_KEYS.has(w)) || (has("cmd") && has("q")) || (has("cmd") && has("opt") && (has("esc") || has("escape")));
  return never ? `\`${key}\` deletes, quits or shuts something down; that key is never pressed unattended — a notify can ask Kevin to press it` : undefined;
}
const WAKE_PROMPT_CHARS = 400;
const UNATTENDED_HINT = "a notify or a chime is";

/**
 * A shell head that brings something to the front: `open` (unless a flag cluster carries g or
 * j, or `--background` / `--hide`) or `osascript`. The ONE copy: the engine's background lane
 * (threads/runner.ts) imports `shellSteals` from here to refuse these, and the automations'
 * set-up gate tells a recipe that fronts an app to use the `open` action instead.
 */
export const BACKGROUND_SHELL_REFUSE = /^(?:open|osascript)$/;
export const OPEN_BACKGROUND_FLAG = /^-[A-Za-z]*[gj][A-Za-z]*$|^--(?:background|hide)$/;
const SHELL_PREFIXES: ReadonlySet<string> = new Set(["sudo", "env", "nohup", "exec", "command", "time", "nice", "caffeinate", "builtin", "doas"]);

/** Does any command in this line front an app? Every segment of `a; b && c | d` is judged past its wrappers and the head's directory. */
export function shellSteals(command: string): boolean {
  return shellSegments(command).some((segment) => {
    const words = shellWords(segment);
    const head = words[0];
    if (!head || !BACKGROUND_SHELL_REFUSE.test(head)) return false;
    if (head === "osascript") return true;
    return !words.slice(1).some((w) => OPEN_BACKGROUND_FLAG.test(w));
  });
}

/** The line split at `;`, `&`, `&&`, `|`, `||` and newlines outside quotes. */
function shellSegments(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | undefined;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      cur += ch;
      if (ch === quote) quote = undefined;
      else if (ch === "\\" && quote === '"') {
        cur += command[i + 1] ?? "";
        i++;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "\\") {
      cur += ch + (command[i + 1] ?? "");
      i++;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&" || ch === "\n") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** A segment's words with the command's wrappers and leading assignments gone, the head reduced to its lower-cased basename. */
function shellWords(segment: string): string[] {
  const words = segment.split(/\s+/).filter(Boolean);
  let i = 0;
  let afterPrefix = false;
  while (i < words.length) {
    const w = words[i]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      i++;
      continue;
    }
    if (SHELL_PREFIXES.has(shellBasename(w))) {
      afterPrefix = true;
      i++;
      continue;
    }
    if (afterPrefix && w.startsWith("-")) {
      i++;
      continue;
    }
    break;
  }
  const rest = words.slice(i);
  if (rest[0] !== undefined) rest[0] = shellBasename(rest[0]).toLowerCase();
  return rest;
}

function shellBasename(word: string): string {
  const bare = word.replace(/^["']|["']$/g, "");
  return bare.slice(bare.lastIndexOf("/") + 1);
}

/** An `mv` or `cp` in the line that could overwrite: no `-n` / `--no-clobber` on it. */
function clobberReason(command: string): string | undefined {
  for (const segment of shellSegments(command)) {
    const words = shellWords(segment);
    const head = words[0];
    if (head !== "mv" && head !== "cp") continue;
    const safe = words.slice(1).some((w) => w === "--no-clobber" || /^-[A-Za-z]*n[A-Za-z]*$/.test(w));
    if (!safe) return `${head} needs -n so it never overwrites`;
  }
  return undefined;
}

/**
 * The cost line for `wake-brain`, said word for word before the yes and recorded as
 * `confirmed.heard`: N = ceil(budget.seconds / 60), M = Settings.wakeBudgetMinutesPerDay;
 * a local brain warms a model on this Mac instead of spending Kevin's plan.
 */
export function costLine(budget: { readonly steps: number; readonly seconds: number }, cap: number, local: boolean): string {
  const n = Math.max(1, Math.ceil(budget.seconds / 60));
  const minutes = n === 1 ? "brain minute" : "brain minutes";
  const where = local ? "a model warm-up on this Mac" : "on your plan";
  return `this wakes the brain — not the voice — while Jarhead is asleep: about ${n} ${minutes} per fire ${where}, up to ${cap} a day; its one-line answer is spoken by the local speaker / shown as a banner`;
}

/** The recipe a row names (never one in the Trash), or the text that arrived with it. */
function recipeCommandOf(name: string, ctx: AutomationContext): string | undefined {
  return recipeNamed(ctx.settings.recipes, name)?.command ?? ctx.recipeCommand;
}

/** Why a recipe may not run unattended, if it may not: the shell gate must say `run` on its own, with nobody to ask. */
function recipeReason(name: string, ctx: AutomationContext, home: string): string | undefined {
  const trashed = recipeNamed(ctx.settings.recipes, name, "any");
  if (trashed?.trashedAt !== undefined) return `recipe "${trashed.name}" is in the Trash; restore it (Settings › Automations › Recipes, or \`jarhead recipes restore\`) or pick another name`;
  const command = recipeCommandOf(name, ctx);
  if (!command || !command.trim()) return `no recipe named "${name}"; add it in Settings › Automations › Recipes, or give its command`;
  if (shellSteals(command)) return `the recipe fronts an app (open / osascript); use the open action instead`;
  const known = recipeNamed(ctx.settings.recipes, name);
  if (known?.cwd) {
    const cwd = shellCwdReason(known.cwd, home);
    if (cwd) return cwd;
    if (isUnder(expandPath(known.cwd, home), resolve(home, ".jarhead"))) return "a recipe never runs from inside ~/.jarhead (the ledger, the trash, the wake gate live there)";
  }
  const clobber = clobberReason(command);
  if (clobber) return clobber;
  const d = classifyAction({ kind: "run_shell", text: command, confirmed: false, home, ...(known?.cwd ? { cwd: known.cwd } : {}), ...(ctx.repoRoot ? { repoRoot: ctx.repoRoot } : {}) });
  if (d.verdict === "refuse") return d.reason;
  if (d.verdict === "confirm") return `${d.reason.replace(/; ask first$/, "")} — that would need a yes when it runs; nobody is there then — notify instead, or make it non-destructive`;
  return undefined;
}

/**
 * Why the trigger cannot be armed, if it cannot: a reserved or unknown kind, a secret or
 * guarded folder, the folder cap, the poll floor, a recipe the gate would question, `file`
 * without a folder trigger, a watcher that wakes the brain without a ten-minute cooldown,
 * a recurrence from a later pass.
 */
export function triggerReason(ctx: AutomationContext): string | undefined {
  const home = ctx.home ?? homedir();
  const w = ctx.when;
  const hasFile = ctx.then.some((a) => a.kind === "file");
  if (w.kind === "on") {
    const kind = String((w.on as { readonly kind?: unknown }).kind ?? "");
    if (AUTOMATION_RESERVED_TRIGGERS.has(kind)) return `${kind} is a later pass; nothing listens for it yet`;
    if (!AUTOMATION_TRIGGERS.has(kind)) return `unknown trigger kind "${kind}"; not armed`;
    if (w.on.kind === "folder.file") {
      const p = expandPath(w.on.path, home);
      const secret = secretPathReason(p);
      if (secret) return `${secret} holds secrets; Jarhead never watches it`;
      if (isUnder(p, resolve(home, ".jarhead"))) return "~/.jarhead is Jarhead's own; it is not watched";
      if (!isUnder(p, home)) return `${w.on.path} is outside Kevin's home; folders are watched inside ~ only`;
    }
    if (FOLDER_TRIGGERS.has(kind) && ctx.folderWatchers >= AUTOMATION_FOLDER_WATCHERS_MAX) return `${AUTOMATION_FOLDER_WATCHERS_MAX} folder watchers are already armed; trash one first`;
    if (w.on.kind === "recipe.red") {
      if (!(w.on.everySeconds >= AUTOMATION_POLL_MIN_S)) return `a recipe is checked at most every ${AUTOMATION_POLL_MIN_S} s`;
      const recipe = recipeReason(w.on.recipe, ctx, home);
      if (recipe) return recipe;
    }
    if (ctx.then.some((a) => a.kind === "wake-brain") && !((ctx.clauses.cooldown ?? 0) >= AUTOMATION_WAKE_COOLDOWN_MIN_S)) {
      return `a watcher that wakes the brain needs a cooldown of at least ${AUTOMATION_WAKE_COOLDOWN_MIN_S} s between fires`;
    }
    if (hasFile && !FOLDER_TRIGGERS.has(kind)) return "file moves the triggering file; only a folder.file or download.done watcher has one";
    return undefined;
  }
  if (hasFile) return "file moves the triggering file; only a folder.file or download.done watcher has one";
  if (w.kind === "every") {
    const r = w.every;
    if (r.kind === "monthly" || r.kind === "monthday") return "not yet — say the date";
    if (r.kind === "interval" && !(r.everyMs >= 60_000)) return "an interval needs at least a minute";
    if (r.kind === "weekly" && r.days.length === 0) return "a weekly needs at least one day";
    return undefined;
  }
  if (w.kind === "in") return w.ms >= 1_000 ? undefined : "a timer needs at least a second";
  if (w.kind === "at") return Number.isFinite(w.at) && w.at > 0 ? undefined : "an alarm needs a time";
  return `unknown trigger "${String((w as { readonly kind?: unknown }).kind)}"; not armed`;
}

/** A fixed line the local speaker reads or a banner shows: 1–AUTOMATION_LINE_CHARS chars, naming no secret. */
function lineReason(line: string, what: string): string | undefined {
  const t = line.trim();
  if (!t) return `say what the ${what} should say`;
  if (t.length > AUTOMATION_LINE_CHARS) return `the local speaker reads a sentence, not a briefing (${t.length} chars, ${AUTOMATION_LINE_CHARS} at most) — use wake-brain for a briefing`;
  const secret = secretEnvReason(t) ?? secretPathReason(t);
  if (secret) return `the ${what} names a secret (${secret}); Kevin handles those himself`;
  return undefined;
}

/**
 * A path `/usr/bin/open` would RUN rather than show: an app bundle, a shell or script file,
 * an AppleScript, an Automator workflow, an installer, a disk image, a Terminal profile. An
 * `open` is a free kind (armed silently, no yes), so none of these is ever its target — a
 * `run-recipe` executes things, behind its one yes.
 */
export const OPEN_EXECUTABLE_EXT = /\.(app|command|tool|sh|zsh|bash|py|rb|pl|scpt|applescript|workflow|pkg|mpkg|dmg|terminal)$/i;

/**
 * Why an `open { path }` may not be armed or fired, if it may not: an executable or bundle
 * by extension (the hands-off apps by their bundle name), anything inside an app bundle, or a
 * path the read gate does not rate `run` (a secret store). Lexical: the executor adds the
 * execute-bit check at fire. Shared by the set-up gate and the executor so the two agree.
 */
export function openPathReason(path: string, home: string = homedir()): string | undefined {
  const p = expandPath(path.trim(), home).replace(/\/+$/, "");
  if (!p) return "open needs an app, an https URL or a path";
  const base = basename(p);
  if (/\.app$/i.test(base)) {
    const app = base.replace(/\.app$/i, "");
    if (HANDS_OFF_APPS.test(app)) return `${app} is hands-off; Kevin opens it himself`;
    return `${base} is an app bundle; open the app by name instead (open { app: "${app}" })`;
  }
  if (/\.app(\/|$)/i.test(p)) return `${base} is inside an app bundle; nothing runs from an open`;
  if (OPEN_EXECUTABLE_EXT.test(base)) return `${base} would run when opened; an open never executes anything — a run-recipe does, with a yes`;
  const d = classifyPath({ path: p, access: "read", home });
  return d.verdict === "run" ? undefined : d.reason;
}

/** An `open` target judged lexically, as the executor will judge it again at fire. */
function openReason(a: { readonly app?: string; readonly url?: string; readonly path?: string }, ctx: AutomationContext, home: string): string | undefined {
  if (a.app) {
    if (HANDS_OFF_APPS.test(a.app)) return `${a.app} is hands-off; Kevin opens it himself`;
    return undefined;
  }
  if (a.url) {
    const d = classifyUrl({ url: a.url, ...(ctx.request ? { request: ctx.request } : {}) });
    if (d.verdict !== "run") return d.reason;
    const risky = riskyUrlReason(a.url);
    if (risky) return `${risky}; Kevin opens those himself`;
    return undefined;
  }
  if (a.path) return openPathReason(a.path, home);
  return "open needs an app, an https URL or a path";
}

/** Where `file` moves the triggering file: inside ~, never ~/.jarhead, never a secret store, a write the path gate rates run. */
function fileReason(into: string, ctx: AutomationContext, home: string): string | undefined {
  if (!into.trim()) return "file needs a folder to move into";
  const p = expandPath(into, home);
  const secret = secretPathReason(p);
  if (secret) return `${secret} holds secrets; nothing is filed there`;
  if (isUnder(p, resolve(home, ".jarhead"))) return "~/.jarhead is Jarhead's own; nothing is filed there";
  if (!isUnder(p, home)) return `${into} is outside Kevin's home; files move inside ~ only`;
  const d = classifyPath({ path: p, access: "write", home, request: ctx.request ?? into, ...(ctx.repoRoot ? { repoRoot: ctx.repoRoot } : {}) });
  return d.verdict === "run" ? undefined : d.reason;
}

/**
 * One action's verdict at set-up. `run`: a fixed line, a reversible open, a file move inside ~.
 * `confirm`: a recipe the gate rates run, a press in an ordinary app, a brain wake with budget —
 * the reason is the question (for wake-brain, the cost line). `refuse`: everything else, with
 * the nearest safe kind named. An unknown kind refuses (fail closed).
 */
export function actionReason(action: AutomationAction, ctx: AutomationContext): Decision {
  const home = ctx.home ?? homedir();
  const kind = String((action as { readonly kind?: unknown }).kind ?? "");
  switch (action.kind) {
    case "chime":
    case "say": {
      const why = lineReason(action.line, action.kind);
      return why ? refuse(why) : run(`a ${action.kind} with a fixed line`);
    }
    case "notify": {
      const why = lineReason(action.title, "banner") ?? (action.body ? lineReason(action.body, "banner's body") : undefined);
      if (why) return refuse(why);
      if (action.open) {
        const target = /^[a-z][a-z0-9+.-]*:\/\//i.test(action.open) ? { url: action.open } : action.open.startsWith("/") || action.open.startsWith("~") ? { path: action.open } : { app: action.open };
        const open = openReason(target, ctx, home);
        if (open) return refuse(open);
      }
      return run("a banner with a fixed title");
    }
    case "open": {
      const why = openReason(action, ctx, home);
      return why ? refuse(why) : run("open is reversible on Kevin's own machine");
    }
    case "file": {
      const why = fileReason(action.into, ctx, home);
      return why ? refuse(why) : run(`filing into ${action.into} never overwrites or deletes`);
    }
    case "run-recipe": {
      const why = recipeReason(action.recipe, ctx, home);
      if (why) return refuse(why);
      const command = recipeCommandOf(action.recipe, ctx) ?? "";
      return confirm(`recipe ${action.recipe} (${command.length > 80 ? `${command.slice(0, 77)}…` : command}) will run unattended, without a yes each time`);
    }
    case "press": {
      if (!action.app.trim()) return refuse("press needs the app it lands in");
      if (HANDS_OFF_APPS.test(action.app)) return refuse(`${action.app} is hands-off; nothing is pressed there unattended`);
      const never = pressKeyReason(action.key);
      if (never) return refuse(never);
      return confirm(`\`${action.key}\` will be pressed in ${action.app} unattended, only while it is in front and no password field has focus`);
    }
    case "wake-brain": {
      if (!(ctx.settings.wakeBudgetMinutesPerDay > 0)) return refuse("Settings › Automations › Brain minutes is 0; the brain is not woken by an automation");
      const prompt = action.prompt.trim();
      if (!prompt) return refuse("wake-brain needs a prompt");
      if (prompt.length > WAKE_PROMPT_CHARS) return refuse(`the prompt is ${prompt.length} chars; ${WAKE_PROMPT_CHARS} at most`);
      if (ctx.fromThread) return refuse("a spawned thread cannot arm a brain wake (depth one); the main conversation can");
      return confirm(costLine(action.budget, ctx.settings.wakeBudgetMinutesPerDay, ctx.localBrain === true));
    }
    default:
      return refuse(`unknown action kind "${kind}"; not armed`);
  }
}

/**
 * Whether an automation may be ARMED. Asked here, once, awake; at fire nobody is asked, so
 * anything confirm-tier at fire is refused now, not asked now. Order: the master switch → the
 * action count and one acting kind → the trigger → per action its unattended chip, then its
 * own reason. `confirm` reasons are joined into the one question; `ctx.confirmed` makes the
 * whole thing `run`. Pure. Fails closed: an unknown action or trigger kind refuses.
 */
export function classifyAutomation(ctx: AutomationContext): Decision {
  if (!ctx.settings.enabled) return refuse("automations are off (Settings › Automations); nothing is armed while the switch is off");
  if (ctx.then.length === 0) return refuse("an automation needs at least one action");
  if (ctx.then.length > AUTOMATION_ACTIONS_MAX) return refuse(`an automation runs at most ${AUTOMATION_ACTIONS_MAX} actions; this one has ${ctx.then.length}`);
  const acting = ctx.then.filter((a) => AUTOMATION_ACTING_KINDS.has(a.kind as AutomationActionKind));
  if (acting.length > 1) return refuse(`one acting kind per automation (${acting.map((a) => a.kind).join(", ")} act); split it or keep one`);
  const trigger = triggerReason(ctx);
  if (trigger) return refuse(trigger);
  const asks: string[] = [];
  // A recipe.red trigger naming a recipe not yet approved, with its text arriving as `recipeCommand`: the poll is a shell
  // running unattended every `everySeconds`, so it needs the one set-up yes exactly as run-recipe does (the engine then
  // saves the recipe after that yes). One recipeCommand names one recipe: a run-recipe action under another new name refuses.
  if (ctx.when.kind === "on" && ctx.when.on.kind === "recipe.red" && ctx.recipeCommand && !recipeNamed(ctx.settings.recipes, ctx.when.on.recipe)) {
    const red = ctx.when.on;
    const other = ctx.then.find((a) => a.kind === "run-recipe" && a.recipe.trim().toLowerCase() !== red.recipe.trim().toLowerCase() && !recipeNamed(ctx.settings.recipes, a.recipe));
    if (other?.kind === "run-recipe") return refuse(`one recipeCommand names one recipe: the trigger polls "${red.recipe}" and the action runs "${other.recipe}", both new — approve one at a time`);
    const command = ctx.recipeCommand.trim();
    asks.push(`recipe ${red.recipe} (${command.length > 80 ? `${command.slice(0, 77)}…` : command}) will be run every ${red.everySeconds} s unattended to watch its exit code, without a yes each time`);
  }
  for (const action of ctx.then) {
    const kind = String((action as { readonly kind?: unknown }).kind ?? "");
    if (!(AUTOMATION_ACTION_KINDS as readonly string[]).includes(kind)) return refuse(`unknown action kind "${kind}"; not armed`);
    if (!ctx.settings.unattended.includes(kind as AutomationActionKind)) {
      return refuse(`${kind} is not allowed while Jarhead is asleep (Settings › Automations › While asleep); ${UNATTENDED_HINT}`);
    }
    const d = actionReason(action, ctx);
    if (d.verdict === "refuse") return d;
    if (d.verdict === "confirm") asks.push(d.reason);
  }
  if (asks.length === 0) return run("nothing here needs a yes: fixed lines, reversible opens, moves inside ~");
  const question = asks.join("; ");
  return ctx.confirmed ? run(`Kevin confirmed: ${question}`) : confirm(question);
}
