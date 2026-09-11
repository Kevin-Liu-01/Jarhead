import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

/** What the token exchange gave us, plus where it is valid. */
export interface T3Token {
  readonly accessToken: string;
  /** "Bearer" or "DPoP" as reported by the server. */
  readonly tokenType: string;
  readonly scope?: string;
  /** Epoch ms; absent when the server did not say. */
  readonly expiresAt?: number;
  readonly baseUrl: string;
  /** The client_label we paired with; shown in health as "paired as <label>". */
  readonly label?: string;
}

export interface T3TokenStore {
  load(): Promise<T3Token | undefined>;
  save(token: T3Token): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryT3TokenStore implements T3TokenStore {
  constructor(private token?: T3Token) {}

  async load(): Promise<T3Token | undefined> {
    return this.token;
  }

  async save(token: T3Token): Promise<void> {
    this.token = token;
  }

  async clear(): Promise<void> {
    this.token = undefined;
  }
}

export function defaultT3TokenPath(stateDir: string): string {
  return join(stateDir, "t3.json");
}

/** JSON file, mode 0600: it holds a bearer that can drive Kevin's agents. */
export class FileT3TokenStore implements T3TokenStore {
  constructor(readonly path: string) {}

  static inStateDir(stateDir: string): FileT3TokenStore {
    return new FileT3TokenStore(defaultT3TokenPath(stateDir));
  }

  async load(): Promise<T3Token | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    try {
      const value = JSON.parse(raw) as unknown;
      return isToken(value) ? value : undefined;
    } catch {
      // A corrupt file is the same as no pairing; re-pairing rewrites it.
      return undefined;
    }
  }

  async save(token: T3Token): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.path);
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}

function isToken(value: unknown): value is T3Token {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Record<string, unknown>;
  return typeof t["accessToken"] === "string" && typeof t["tokenType"] === "string" && typeof t["baseUrl"] === "string";
}
