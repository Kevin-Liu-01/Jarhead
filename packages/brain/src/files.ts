import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { secretPathReason } from "@jarhead/core";

/**
 * The file tools' mechanics: reading with a window, exact-string editing,
 * listing and searching. Policy (which paths are secrets, where writes ask) is
 * decided by the runner through packages/core/src/policy.ts before anything
 * here runs; this module only makes sure the results stay bounded and honest,
 * and that a symlink never stands in for the file it points at: listing and
 * searching skip links, and realPathOf gives the runner the target to judge.
 */

/**
 * The path with every symlink resolved. For a path that does not exist yet, the
 * nearest existing ancestor is resolved and the rest appended, so a write through
 * a linked folder is judged by where it lands.
 */
export function realPathOf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    if (parent === path) return path;
    return join(realPathOf(parent), basename(path));
  }
}

/** A secret store under either spelling of a path. */
export function secretReasonEither(path: string): string | undefined {
  return secretPathReason(path) ?? secretPathReason(realPathOf(path));
}

// ------------------------------------------------------------ macOS blocks ---
//
// TCC answers a read or write it guards with EPERM ("Operation not permitted") and
// nothing else — no dialog for Full Disk Access, and a raw errno is all a model would
// see. The three user folders have a prompt of their own (Setup asks for it); Mail,
// Safari, Messages and the rest of ~/Library and the Trash need Full Disk Access,
// which only System Settings grants. These helpers turn that errno into
// the one line the voice can say. They decide nothing: policy ran before the read.

const HOME = homedir();
const TCC_FOLDERS: readonly { readonly prefix: string; readonly lacks: string }[] = [
  { prefix: join(HOME, "Desktop"), lacks: "access to the Desktop folder" },
  { prefix: join(HOME, "Documents"), lacks: "access to the Documents folder" },
  { prefix: join(HOME, "Downloads"), lacks: "access to the Downloads folder" },
  { prefix: join(HOME, "Library"), lacks: "Full Disk Access" },
  { prefix: join(HOME, ".Trash"), lacks: "Full Disk Access" },
];

/** Where a grant is obtained, for the line's tail. */
export const PERMISSIONS_HINT = "Setup › Permissions › Ask for everything";

/** `~/x` and `$HOME/x` as absolute paths; anything else unchanged. */
function expandHome(path: string): string {
  if (path === "~") return HOME;
  if (path.startsWith("~/")) return join(HOME, path.slice(2));
  if (path.startsWith("$HOME/")) return join(HOME, path.slice(6));
  return path;
}

/** What Jarhead lacks when macOS blocks `path`, or undefined for a path TCC does not guard. */
export function tccGrantFor(path: string): string | undefined {
  const p = expandHome(path).replace(/^\/private(\/|$)/, "/").replace(/\/+$/, "");
  for (const f of TCC_FOLDERS) if (p === f.prefix || p.startsWith(f.prefix + sep)) return f.lacks;
  return undefined;
}

/** The line for a blocked path: "macOS blocked this: Jarhead lacks Full Disk Access. Setup › Permissions › Ask for everything". */
export function macOSBlockedLine(path: string): string | undefined {
  const lacks = tccGrantFor(path);
  return lacks ? `macOS blocked this: Jarhead lacks ${lacks}. ${PERMISSIONS_HINT}` : undefined;
}

/** EPERM is TCC's answer (a plain Unix denial is EACCES and stays what it is). */
export function isMacOSBlock(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === "EPERM") return true;
  return /operation not permitted/i.test(String((e as { message?: unknown } | null)?.message ?? ""));
}

/** An fs error as a model should read it: the permission line for a guarded path, else the message as it was. */
export function explainFsError(e: unknown, path: string): string {
  if (isMacOSBlock(e)) {
    const line = macOSBlockedLine(path);
    if (line) return line;
  }
  return e instanceof Error ? e.message : String(e);
}

/** Rethrow an fs error with the permission line when macOS blocked a guarded path. */
function rethrowExplained(e: unknown, path: string): never {
  const text = explainFsError(e, path);
  if (e instanceof Error && text === e.message) throw e;
  throw new Error(text);
}

/** Characters of file content a single read returns. */
export const READ_CAP = 40_000;
export const SEARCH_MAX_RESULTS = 200;
export const LIST_MAX_ENTRIES = 500;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
const MAX_SEARCH_FILES = 20_000;
const SKIP_DIRS = new Set(["node_modules", ".git", ".build", "build", "dist", ".next", ".cache", ".turbo", "DerivedData", ".venv", "__pycache__", "Library"]);

export function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export interface ReadWindow {
  readonly text: string;
  /** 1-based first and last line returned, and the file's total. */
  readonly from: number;
  readonly to: number;
  readonly total: number;
  readonly truncated: boolean;
}

/** Lines `offset` (1-based) through `offset + limit - 1`, capped at READ_CAP characters. */
export function readWindow(path: string, offset = 1, limit?: number, cap = READ_CAP): ReadWindow | { readonly binary: true; readonly bytes: number } {
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch (e) {
    rethrowExplained(e, path);
  }
  if (isBinary(buf)) return { binary: true, bytes: buf.length };
  const lines = buf.toString("utf8").split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const total = lines.length;
  const from = Math.max(1, Math.min(offset, Math.max(1, total)));
  const wanted = lines.slice(from - 1, limit !== undefined ? from - 1 + Math.max(1, limit) : undefined);
  let text = wanted.join("\n");
  let to = from + wanted.length - 1;
  let truncated = false;
  if (text.length > cap) {
    text = text.slice(0, cap);
    const nl = text.lastIndexOf("\n");
    if (nl > cap / 2) text = text.slice(0, nl);
    to = from + text.split("\n").length - 1;
    truncated = true;
  }
  return { text, from, to: Math.max(from - 1, to), total, truncated };
}

/** The header a model reads above the content. */
export function describeWindow(path: string, w: ReadWindow): string {
  const range = w.total === 0 ? "empty file" : `lines ${w.from}–${w.to} of ${w.total}`;
  return `${path} (${range}${w.truncated ? `; cut at ${READ_CAP} characters, continue with offset ${w.to + 1}` : w.to < w.total ? `; continue with offset ${w.to + 1}` : ""})`;
}

export function writeText(path: string, content: string): void {
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  } catch (e) {
    rethrowExplained(e, path);
  }
}

export type EditOutcome = { readonly ok: true; readonly count: number } | { readonly ok: false; readonly reason: string };

/** Replace `oldText` with `newText`; exactly once unless `all`. Never writes on failure. */
export function editText(path: string, oldText: string, newText: string, all = false): EditOutcome {
  if (!oldText) return { ok: false, reason: "old must not be empty" };
  let before: string;
  try {
    before = readFileSync(path, "utf8");
  } catch (e) {
    return { ok: false, reason: explainFsError(e, path) };
  }
  let count = 0;
  let idx = before.indexOf(oldText);
  while (idx !== -1) {
    count++;
    idx = before.indexOf(oldText, idx + oldText.length);
  }
  if (count === 0) return { ok: false, reason: `old text not found in ${path}; read the file and copy the exact text (whitespace included)` };
  if (count > 1 && !all) return { ok: false, reason: `old text appears ${count} times in ${path}; include more surrounding lines to make it unique, or set all: true` };
  const after = all ? before.split(oldText).join(newText) : before.replace(oldText, () => newText);
  try {
    writeFileSync(path, after);
  } catch (e) {
    return { ok: false, reason: explainFsError(e, path) };
  }
  return { ok: true, count };
}

/** A tree listing to `depth`; folders end in /, files carry their size; node_modules and .git are named, not entered. */
export function listTree(root: string, depth = 1): string {
  const lines: string[] = [];
  let entries = 0;
  const walk = (dir: string, level: number): void => {
    if (entries >= LIST_MAX_ENTRIES) return;
    let names: string[];
    try {
      names = readdirSync(dir).sort((a, b) => a.localeCompare(b));
    } catch (e) {
      // The root itself blocked by macOS: the whole result is the one line to say.
      if (level === 0 && isMacOSBlock(e) && macOSBlockedLine(dir)) throw new Error(explainFsError(e, dir));
      lines.push(`${"  ".repeat(level)}[unreadable: ${explainFsError(e, dir)}]`);
      return;
    }
    for (const name of names) {
      if (entries >= LIST_MAX_ENTRIES) {
        lines.push(`${"  ".repeat(level)}… (more entries; list a subfolder)`);
        return;
      }
      const full = join(dir, name);
      if (secretPathReason(full)) continue;
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      entries++;
      if (st.isSymbolicLink()) {
        // Named, never followed: what it points at is judged when read_file is asked for it.
        lines.push(`${"  ".repeat(level)}${name}  -> ${linkTargetLabel(full)}`);
      } else if (st.isDirectory()) {
        lines.push(`${"  ".repeat(level)}${name}/`);
        if (level + 1 < depth && !SKIP_DIRS.has(name)) walk(full, level + 1);
      } else {
        lines.push(`${"  ".repeat(level)}${name}  ${size(st.size)}`);
      }
    }
  };
  walk(root, 0);
  return lines.length ? lines.join("\n") : "(empty folder)";
}

/** Where a symlink points, or "(a secret store)" when that is somewhere Jarhead never reads. */
function linkTargetLabel(link: string): string {
  const target = realPathOf(link);
  return secretPathReason(target) ? "(a secret store; not followed)" : `${target} (symlink)`;
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** '*.ts' → matches basenames; 'src/**\/*.swift' → matches the path relative to the root. */
export function globToRegExp(glob: string): { readonly re: RegExp; readonly onBasename: boolean } {
  const onBasename = !glob.includes("/");
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end === -1) re += "\\{";
      else {
        re += `(${glob
          .slice(i + 1, end)
          .split(",")
          .map((s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&"))
          .join("|")})`;
        i = end;
      }
    } else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return { re: new RegExp(`^${re}$`), onBasename };
}

export interface SearchHit {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export interface SearchOptions {
  readonly glob?: string | undefined;
  readonly max?: number | undefined;
  /** Test seam / override: the ripgrep binary; undefined tries PATH and the usual homes. */
  readonly rg?: string | false | undefined;
  readonly signal?: AbortSignal | undefined;
  /**
   * Letter case: true / false decide; undefined lets the pattern decide — a
   * leading (?i) or no uppercase letter in it means case-insensitive (ripgrep's
   * smart case), so "design" finds "Design" and "Design" finds only that.
   */
  readonly caseInsensitive?: boolean | undefined;
}

/**
 * The inline flag groups a model writes at the front of a pattern — (?i), (?s),
 * (?m) or a combination like (?im) — split off, since JavaScript's RegExp rejects
 * them ("Invalid group") while ripgrep's regex accepts them. The letters become
 * RegExp flags for the walk and options for ripgrep; anything else stays in the
 * pattern and fails the way an invalid pattern does.
 */
export function splitInlineFlags(pattern: string): { readonly pattern: string; readonly flags: ReadonlySet<string> } {
  const flags = new Set<string>();
  let rest = pattern;
  let m: RegExpExecArray | null;
  while ((m = /^\(\?([ims]+)\)/.exec(rest)) !== null) {
    for (const f of m[1]!) flags.add(f);
    rest = rest.slice(m[0].length);
  }
  return { pattern: rest, flags };
}

/** ripgrep's smart case: a literal uppercase letter in the pattern (escapes such as \S aside) asks for an exact case. */
export function hasUppercase(pattern: string): boolean {
  return /[A-Z]/.test(pattern.replace(/\\./g, ""));
}

/** How a search treats case and line structure, decided once for ripgrep and the walk alike. */
export interface SearchMode {
  readonly pattern: string;
  readonly insensitive: boolean;
  readonly multiline: boolean;
  readonly dotAll: boolean;
}

export function searchMode(pattern: string, caseInsensitive?: boolean): SearchMode {
  const split = splitInlineFlags(pattern);
  return {
    pattern: split.pattern,
    insensitive: caseInsensitive ?? (split.flags.has("i") || !hasUppercase(split.pattern)),
    multiline: split.flags.has("m"),
    dotAll: split.flags.has("s"),
  };
}

/** ripgrep when it answers, otherwise a bounded walk; secret stores are skipped either way. */
export async function searchFiles(root: string, pattern: string, opts: SearchOptions = {}): Promise<{ hits: SearchHit[]; via: "rg" | "walk"; note?: string }> {
  const max = opts.max ?? SEARCH_MAX_RESULTS;
  const mode = searchMode(pattern, opts.caseInsensitive);
  let regex: RegExp;
  try {
    regex = new RegExp(mode.pattern, `${mode.insensitive ? "i" : ""}${mode.multiline ? "m" : ""}${mode.dotAll ? "s" : ""}`);
  } catch (e) {
    throw new Error(`pattern is not a valid regular expression: ${(e as Error).message}`);
  }
  // A root macOS blocks: rg exits 2 and the walk finds nothing — say why instead of "no hits".
  try {
    if (statSync(root).isDirectory()) readdirSync(root);
  } catch (e) {
    if (isMacOSBlock(e) && macOSBlockedLine(root)) throw new Error(explainFsError(e, root));
  }
  if (opts.rg !== false) {
    const viaRg = await ripgrep(root, mode, opts.glob, max, opts.rg, opts.signal);
    if (viaRg) return { hits: viaRg.filter((h) => !secretReasonEither(h.path)), via: "rg" };
  }
  return { hits: walkSearch(root, regex, opts.glob, max), via: "walk" };
}

const RG_CANDIDATES = ["rg", "/opt/homebrew/bin/rg", "/usr/local/bin/rg"];

/** ripgrep's flags for a mode: case decided explicitly either way (a user config could say --smart-case), multiline only when a flag asked. */
export function ripgrepModeArgs(mode: SearchMode): string[] {
  return [mode.insensitive ? "-i" : "-s", ...(mode.multiline || mode.dotAll ? ["--multiline"] : []), ...(mode.dotAll ? ["--multiline-dotall"] : [])];
}

function ripgrep(root: string, mode: SearchMode, glob: string | undefined, max: number, bin: string | undefined, signal: AbortSignal | undefined): Promise<SearchHit[] | undefined> {
  const candidates = bin ? [bin] : RG_CANDIDATES;
  const tryOne = (i: number): Promise<SearchHit[] | undefined> =>
    new Promise((resolve) => {
      const file = candidates[i];
      if (!file) return resolve(undefined);
      const args = ["-n", "--no-heading", "--color", "never", "--max-count", "50", "--max-filesize", "1M", ...ripgrepModeArgs(mode), ...(glob ? ["-g", glob] : []), "-e", mode.pattern, root];
      execFile(file, args, { timeout: 20_000, maxBuffer: 8 * 1024 * 1024, ...(signal ? { signal } : {}) }, (err, stdout) => {
        const code = (err as { code?: number | string } | null)?.code;
        if (err && code === "ENOENT") return resolve(tryOne(i + 1));
        // rg exits 1 for "no matches" and 2 for an error (a bad pattern, an unreadable root).
        if (err && code !== 1) return resolve(undefined);
        const hits: SearchHit[] = [];
        for (const line of String(stdout).split("\n")) {
          const m = /^(.*?):(\d+):(.*)$/.exec(line);
          if (!m) continue;
          hits.push({ path: m[1]!, line: Number(m[2]), text: m[3]!.slice(0, 300) });
          if (hits.length >= max) break;
        }
        resolve(hits);
      });
    });
  return tryOne(0);
}

function walkSearch(root: string, regex: RegExp, glob: string | undefined, max: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const matcher = glob ? globToRegExp(glob) : undefined;
  let visited = 0;
  const walk = (dir: string): void => {
    if (hits.length >= max || visited >= MAX_SEARCH_FILES) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (hits.length >= max || visited >= MAX_SEARCH_FILES) return;
      const full = join(dir, name);
      if (secretPathReason(full)) continue;
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      // Links are not followed: a link into a secret store would read it under an innocent name.
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(full);
        continue;
      }
      if (!st.isFile() || st.size > MAX_SEARCH_FILE_BYTES) continue;
      if (matcher) {
        const subject = matcher.onBasename ? basename(full) : relative(root, full).split(sep).join("/");
        if (!matcher.re.test(subject)) continue;
      }
      visited++;
      let buf: Buffer;
      try {
        buf = readFileSync(full);
      } catch {
        continue;
      }
      if (isBinary(buf)) continue;
      const lines = buf.toString("utf8").split("\n");
      for (let i = 0; i < lines.length && hits.length < max; i++) {
        if (regex.test(lines[i]!)) hits.push({ path: full, line: i + 1, text: lines[i]!.slice(0, 300) });
      }
    }
  };
  if (existsSync(root) && statSync(root).isFile()) {
    if (secretReasonEither(root)) return hits;
    let buf: Buffer;
    try {
      buf = readFileSync(root);
    } catch (e) {
      rethrowExplained(e, root);
    }
    if (!isBinary(buf)) buf.toString("utf8").split("\n").forEach((l, i) => regex.test(l) && hits.length < max && hits.push({ path: root, line: i + 1, text: l.slice(0, 300) }));
    return hits;
  }
  walk(root);
  return hits;
}
