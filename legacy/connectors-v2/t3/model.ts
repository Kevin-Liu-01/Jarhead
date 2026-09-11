/**
 * T3 Code's orchestration read model and dispatch commands, as observed in
 * T3 Code (Alpha) 0.0.33 (docs/vendor/t3-code-api.md). Only the fields the
 * connector reads are typed; everything else stays open so a newer server does
 * not break parsing.
 */

export type RuntimeMode = "approval-required" | "auto-accept-edits" | "auto" | "full-access";
export type ProviderInteractionMode = "default" | "plan";
export type TurnState = "running" | "interrupted" | "completed" | "error";
export type SessionStatus = "idle" | "starting" | "running" | "ready" | "interrupted" | "stopped" | "error";

export interface ModelSelection {
  readonly provider?: string;
  readonly instanceId?: string;
  readonly model: string;
  readonly options?: Record<string, unknown>;
}

export interface OrchestrationProject {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly defaultModelSelection?: ModelSelection | null;
  readonly defaultThreadEnvMode?: "local" | "worktree" | null;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly deletedAt?: string | null;
}

export interface OrchestrationLatestTurn {
  readonly turnId: string;
  readonly state: TurnState;
  readonly requestedAt?: string;
  readonly startedAt?: string | null;
  readonly completedAt?: string | null;
  readonly assistantMessageId?: string | null;
}

export interface OrchestrationActivity {
  readonly id: string;
  readonly tone?: string;
  readonly kind: string;
  readonly summary?: string;
  readonly payload?: unknown;
  readonly turnId?: string | null;
  readonly createdAt?: string;
}

export interface OrchestrationSession {
  readonly threadId: string;
  readonly status: SessionStatus;
  readonly providerName?: string | null;
  readonly runtimeMode?: RuntimeMode;
  readonly activeTurnId?: string | null;
  readonly lastError?: string | null;
  readonly updatedAt?: string;
}

export interface OrchestrationMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly turnId?: string | null;
  readonly streaming?: boolean;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface OrchestrationThread {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly modelSelection?: ModelSelection | null;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
  readonly latestTurn?: OrchestrationLatestTurn | null;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly archivedAt?: string | null;
  readonly deletedAt?: string | null;
  /** Absent in the shell snapshot. */
  readonly messages?: OrchestrationMessage[];
  /** Absent in the shell snapshot. */
  readonly activities?: OrchestrationActivity[];
  readonly session?: OrchestrationSession | null;
}

export interface OrchestrationReadModel {
  readonly snapshotSequence?: number;
  readonly projects: OrchestrationProject[];
  readonly threads: OrchestrationThread[];
  readonly updatedAt?: string;
}

export interface T3Environment {
  readonly environmentId: string;
  readonly label: string;
  readonly platform?: { readonly os?: string; readonly arch?: string };
  readonly serverVersion: string;
  readonly capabilities?: Record<string, unknown>;
}

export interface T3SessionState {
  readonly authenticated: boolean;
  readonly scopes?: string[];
  readonly sessionMethod?: string;
  readonly expiresAt?: string;
  readonly auth?: Record<string, unknown>;
}

export interface T3TokenResponse {
  readonly access_token: string;
  readonly issued_token_type?: string;
  readonly token_type: string;
  readonly expires_in?: number;
  readonly scope?: string;
}

export interface UserMessageInput {
  readonly messageId: string;
  readonly role: "user";
  readonly text: string;
  readonly attachments: unknown[];
}

export type ClientOrchestrationCommand =
  | {
      readonly type: "thread.create";
      readonly commandId: string;
      readonly threadId: string;
      readonly projectId: string;
      readonly title: string;
      readonly modelSelection: ModelSelection;
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode?: ProviderInteractionMode;
      readonly branch: null;
      readonly worktreePath: null;
      readonly createdAt: string;
    }
  | {
      readonly type: "thread.turn.start";
      readonly commandId: string;
      readonly threadId: string;
      readonly message: UserMessageInput;
      readonly modelSelection?: ModelSelection;
      readonly titleSeed?: string;
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
      readonly createdAt: string;
    }
  | {
      readonly type: "thread.turn.interrupt";
      readonly commandId: string;
      readonly threadId: string;
      readonly turnId?: string;
      readonly createdAt: string;
    }
  | {
      readonly type: "thread.session.stop";
      readonly commandId: string;
      readonly threadId: string;
      readonly createdAt?: string;
    }
  | {
      readonly type: "thread.archive" | "thread.unarchive" | "thread.delete";
      readonly commandId: string;
      readonly threadId: string;
    };
