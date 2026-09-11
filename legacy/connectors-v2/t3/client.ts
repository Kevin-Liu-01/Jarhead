import { randomUUID } from "node:crypto";
import type {
  ClientOrchestrationCommand,
  ModelSelection,
  OrchestrationReadModel,
  OrchestrationThread,
  ProviderInteractionMode,
  RuntimeMode,
  T3Environment,
  T3SessionState,
  T3TokenResponse,
} from "./model.ts";
import { parsePairingInput } from "./pairing.ts";
import type { T3Token, T3TokenStore } from "./store.ts";

/**
 * HTTP client for T3 Code's local server (docs/vendor/t3-code-api.md).
 *
 * Failures are values, not exceptions: the connector turns them into health and
 * SendResult details. A 401 is reported as `unauthenticated` and the stored token
 * is left alone, because a transient server restart looks identical to a revoked
 * pairing and Kevin should decide which it was.
 */

export interface T3Unauthenticated {
  readonly kind: "unauthenticated";
  readonly detail: string;
}
export interface T3Unreachable {
  readonly kind: "unreachable";
  readonly detail: string;
}
export interface T3HttpError {
  readonly kind: "http";
  readonly status: number;
  readonly detail: string;
}
export interface T3BadInput {
  readonly kind: "bad-input";
  readonly detail: string;
}
export type T3Failure = T3Unauthenticated | T3Unreachable | T3HttpError | T3BadInput;

export type T3Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: T3Failure };

export interface T3ClientOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
  readonly tokenStore: T3TokenStore;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly uuid?: () => string;
  /** Sent as client_label during pairing; T3 shows it in its pairing list. */
  readonly clientLabel?: string;
}

export interface StartTurnInput {
  readonly threadId: string;
  readonly text: string;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
  readonly modelSelection?: ModelSelection;
}

export interface CreateThreadInput {
  readonly projectId: string;
  readonly title: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
}

export const DEFAULT_T3_BASE_URL = "http://127.0.0.1:3773";
export const DEFAULT_T3_TIMEOUT_MS = 8_000;
export const T3_PAIRING_SCOPES = "orchestration:read orchestration:operate";

const fail = <T>(error: T3Failure): T3Result<T> => ({ ok: false, error });
const succeed = <T>(value: T): T3Result<T> => ({ ok: true, value });

export class T3Client {
  private baseUrlValue: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly uuid: () => string;
  private readonly clientLabel: string;
  readonly tokenStore: T3TokenStore;

  constructor(opts: T3ClientOptions) {
    this.baseUrlValue = normalizeBaseUrl(opts.baseUrl);
    this.fetchImpl = opts.fetch ?? fetch;
    this.tokenStore = opts.tokenStore;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_T3_TIMEOUT_MS;
    this.now = opts.now ?? Date.now;
    this.uuid = opts.uuid ?? randomUUID;
    this.clientLabel = opts.clientLabel ?? "Jarhead";
  }

  get baseUrl(): string {
    return this.baseUrlValue;
  }

  // ------------------------------------------------------------ unauthenticated ---

  environment(): Promise<T3Result<T3Environment>> {
    return this.getJson<T3Environment>("/.well-known/t3/environment", false);
  }

  /** Reports whether the stored bearer (if any) is accepted. */
  sessionState(): Promise<T3Result<T3SessionState>> {
    return this.getJson<T3SessionState>("/api/auth/session", true, { optionalAuth: true });
  }

  // ------------------------------------------------------------------- pairing ---

  /** RFC 8693 token exchange with the pairing credential; stores the result. */
  async pair(input: string): Promise<T3Result<T3Token>> {
    const parsed = parsePairingInput(input);
    if (!parsed) return fail({ kind: "bad-input", detail: "expected a T3 pairing URL or credential" });
    if (parsed.baseUrl) this.baseUrlValue = normalizeBaseUrl(parsed.baseUrl);

    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: parsed.credential,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      scope: T3_PAIRING_SCOPES,
      client_label: this.clientLabel,
      client_os: "macOS",
    });
    const res = await this.send("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
    });
    if (!res.ok) return res;
    if (res.value.status === 401 || res.value.status === 400 || res.value.status === 403) {
      return fail({ kind: "http", status: res.value.status, detail: `pairing rejected: ${await snippet(res.value)}` });
    }
    if (!res.value.ok) return fail(await httpFailure(res.value));
    const json = (await parseJson(res.value)) as T3TokenResponse | undefined;
    if (!json || typeof json.access_token !== "string") {
      return fail({ kind: "http", status: res.value.status, detail: "token response had no access_token" });
    }
    const token: T3Token = {
      accessToken: json.access_token,
      tokenType: typeof json.token_type === "string" ? json.token_type : "Bearer",
      ...(typeof json.scope === "string" ? { scope: json.scope } : {}),
      ...(typeof json.expires_in === "number" ? { expiresAt: this.now() + json.expires_in * 1000 } : {}),
      baseUrl: this.baseUrlValue,
      label: this.clientLabel,
    };
    await this.tokenStore.save(token);
    return succeed(token);
  }

  // --------------------------------------------------------------- read model ---

  snapshot(): Promise<T3Result<OrchestrationReadModel>> {
    return this.getJson<OrchestrationReadModel>("/api/orchestration/snapshot", true);
  }

  /** Threads without messages/activities: enough for list() and health(). */
  shellSnapshot(): Promise<T3Result<OrchestrationReadModel>> {
    return this.getJson<OrchestrationReadModel>("/api/orchestration/shell", true);
  }

  thread(threadId: string, opts: { readonly turnLimit?: number } = {}): Promise<T3Result<OrchestrationThread>> {
    const query = opts.turnLimit !== undefined ? `?turnLimit=${encodeURIComponent(String(opts.turnLimit))}` : "";
    return this.getJson<OrchestrationThread>(`/api/orchestration/threads/${encodeURIComponent(threadId)}${query}`, true);
  }

  // ----------------------------------------------------------------- dispatch ---

  async dispatch(command: ClientOrchestrationCommand): Promise<T3Result<{ sequence: number }>> {
    const token = await this.tokenStore.load();
    if (!token) return fail({ kind: "unauthenticated", detail: "not paired with T3 Code" });
    const res = await this.send("/api/orchestration/dispatch", {
      method: "POST",
      headers: { authorization: `${token.tokenType} ${token.accessToken}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(command),
    });
    if (!res.ok) return res;
    if (res.value.status === 401) return fail({ kind: "unauthenticated", detail: "T3 Code rejected the pairing token" });
    if (!res.value.ok) return fail(await httpFailure(res.value));
    const json = (await parseJson(res.value)) as { sequence?: unknown } | undefined;
    return succeed({ sequence: typeof json?.sequence === "number" ? json.sequence : -1 });
  }

  async startTurn(input: StartTurnInput): Promise<T3Result<{ sequence: number; messageId: string; commandId: string }>> {
    const commandId = this.uuid();
    const messageId = this.uuid();
    const command: ClientOrchestrationCommand = {
      type: "thread.turn.start",
      commandId,
      threadId: input.threadId,
      message: { messageId, role: "user", text: input.text, attachments: [] },
      ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
      runtimeMode: input.runtimeMode ?? "approval-required",
      interactionMode: input.interactionMode ?? "default",
      createdAt: new Date(this.now()).toISOString(),
    };
    const res = await this.dispatch(command);
    return res.ok ? succeed({ sequence: res.value.sequence, messageId, commandId }) : res;
  }

  async createThread(input: CreateThreadInput): Promise<T3Result<{ threadId: string; sequence: number }>> {
    const threadId = this.uuid();
    const command: ClientOrchestrationCommand = {
      type: "thread.create",
      commandId: this.uuid(),
      threadId,
      projectId: input.projectId,
      title: input.title,
      modelSelection: input.modelSelection,
      runtimeMode: input.runtimeMode ?? "approval-required",
      interactionMode: input.interactionMode ?? "default",
      branch: null,
      worktreePath: null,
      createdAt: new Date(this.now()).toISOString(),
    };
    const res = await this.dispatch(command);
    return res.ok ? succeed({ threadId, sequence: res.value.sequence }) : res;
  }

  interrupt(threadId: string, turnId?: string): Promise<T3Result<{ sequence: number }>> {
    return this.dispatch({
      type: "thread.turn.interrupt",
      commandId: this.uuid(),
      threadId,
      ...(turnId !== undefined ? { turnId } : {}),
      createdAt: new Date(this.now()).toISOString(),
    });
  }

  // ----------------------------------------------------------------- plumbing ---

  private async getJson<T>(path: string, auth: boolean, opts: { readonly optionalAuth?: boolean } = {}): Promise<T3Result<T>> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (auth) {
      const token = await this.tokenStore.load();
      if (token) headers["authorization"] = `${token.tokenType} ${token.accessToken}`;
      else if (!opts.optionalAuth) return fail({ kind: "unauthenticated", detail: "not paired with T3 Code" });
    }
    const res = await this.send(path, { method: "GET", headers });
    if (!res.ok) return res;
    if (res.value.status === 401) return fail({ kind: "unauthenticated", detail: "T3 Code rejected the pairing token" });
    if (!res.value.ok) return fail(await httpFailure(res.value));
    const json = await parseJson(res.value);
    if (json === undefined) return fail({ kind: "http", status: res.value.status, detail: `non-JSON response from ${path}` });
    return succeed(json as T);
  }

  private async send(path: string, init: RequestInit): Promise<T3Result<Response>> {
    const url = `${this.baseUrlValue}${path}`;
    try {
      const response = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
      return succeed(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      return fail({ kind: "unreachable", detail: timedOut ? `T3 Code did not answer within ${this.timeoutMs} ms` : `T3 Code unreachable at ${this.baseUrlValue}: ${message}` });
    }
  }
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

async function parseJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

async function snippet(res: Response): Promise<string> {
  try {
    const text = (await res.text()).trim();
    return text.length > 200 ? `${text.slice(0, 200)}…` : text || res.statusText || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

async function httpFailure(res: Response): Promise<T3HttpError> {
  return { kind: "http", status: res.status, detail: `HTTP ${res.status}: ${await snippet(res)}` };
}
