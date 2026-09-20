import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";
import type { Settings } from "@jarhead/protocol";

/**
 * The name the voice and the brain call the person they work for (release F1).
 * `Settings.userName` when set; otherwise the fallback the engine computed at start —
 * the account's full name. Trimmed, so a name of spaces is unset.
 */
export function effectiveUserName(settings: Pick<Settings, "userName">, fallback: string): string {
  const set = typeof settings.userName === "string" ? settings.userName.trim() : "";
  return set || fallback;
}

export interface AccountNameOptions {
  /** The shell-out (default `execFileSync`); tests script it. */
  readonly exec?: (file: string, args: readonly string[]) => string;
  /** The short login name (default `os.userInfo().username`). */
  readonly username?: string;
  /** `process.platform`; `dscl` exists on darwin only. */
  readonly platform?: string;
}

/** The first letter upper-cased, the rest as it is ("kevin" → "Kevin"). */
export function capitalizeName(s: string): string {
  const t = s.trim();
  return t.length > 0 ? t[0]!.toUpperCase() + t.slice(1) : t;
}

/**
 * The account's full name, read once at start: `dscl . -read /Users/<user> RealName`
 * (guarded — a 2 s cap, any failure swallowed), else the login name with its first letter
 * upper-cased. Never empty: a login name always exists.
 */
export function accountFullName(o: AccountNameOptions = {}): string {
  const username = (o.username ?? safeUsername()).trim();
  const platform = o.platform ?? process.platform;
  if (platform === "darwin" && /^[A-Za-z0-9._-]{1,64}$/.test(username)) {
    try {
      const exec = o.exec ?? ((file: string, args: readonly string[]) => execFileSync(file, [...args], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }));
      const real = parseRealName(exec("dscl", [".", "-read", `/Users/${username}`, "RealName"]));
      if (real) return real;
    } catch {
      // dscl missing, the record unreadable, a timeout: the login name below.
    }
  }
  return capitalizeName(username) || "there";
}

/** `RealName:\n Kevin Liu` (dscl's multi-line form) or `RealName: Kevin Liu`; "" when neither. */
export function parseRealName(out: string): string {
  const m = /RealName:\s*([^\n]*)\n?\s*([^\n]*)?/.exec(out);
  if (!m) return "";
  const first = (m[1] ?? "").trim();
  const value = first || (m[2] ?? "").trim();
  return value.replace(/\s+/g, " ");
}

function safeUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return "";
  }
}

/**
 * The voice.key line for a valid OpenAI key whose project has no Live model (release F4): the
 * engine's problem, Setup › Voice, the report line and the doctor's key row all say it.
 */
export function noLiveModelLine(liveModel: string): string {
  return `OpenAI key works, but ${liveModel} is not on it — enable ${liveModel} on the OpenAI project this key belongs to, or paste a key from a project that has it`;
}
