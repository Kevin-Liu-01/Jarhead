# T3 Code local server API (observed from T3 Code (Alpha) 0.0.33, 2026-09-10)

Extracted from `/Applications/T3 Code (Alpha).app/Contents/Resources/app.asar/apps/server/dist/bin.mjs`
and the running server. Not official documentation; verify against the running app.

- Base URL: `~/.t3/userdata/server-runtime.json` → `{"host":"127.0.0.1","port":3773,"origin":"http://127.0.0.1:3773"}`.
- `GET /.well-known/t3/environment` (no auth) → `{environmentId,label,platform,serverVersion,capabilities}`.
- `GET /api/auth/session` (no auth) → `{"authenticated":false,"auth":{"policy":"desktop-managed-local","bootstrapMethods":["desktop-bootstrap"],"sessionMethods":["browser-session-cookie","bearer-access-token","dpop-access-token"],...}}`.
  With a bearer → `{authenticated:true, scopes:[...], sessionMethod, expiresAt}`.

## Pairing (how an external client gets a bearer token)

An authenticated client (the desktop UI) creates a pairing credential:
`POST /api/auth/pairing-token` body `{label?, scopes?}` → `{id, credential, label?, expiresAt}`.
`GET /api/auth/pairing-links` lists them; `POST /api/auth/pairing-links/revoke` `{id}`.
Headless serve prints a "Pairing URL" of the form `<origin>/pair#token=<credential>` (token is in the URL *hash*).

The new client exchanges the credential:
`POST /oauth/token` — `application/x-www-form-urlencoded`:
```
grant_type=urn:ietf:params:oauth:grant-type:token-exchange
subject_token=<credential>
subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap
requested_token_type=urn:ietf:params:oauth:token-type:access_token
scope=orchestration:read orchestration:operate      (optional, space separated)
client_label=Jarhead                                (optional)
client_device_type=<AuthClientMetadataDeviceType>   (optional; unknown literals — omit)
client_os=macOS                                     (optional)
```
→ `{access_token, issued_token_type, token_type:"Bearer"|"DPoP", expires_in, scope}`.
Scopes: `orchestration:read`, `orchestration:operate`, `terminal:operate`, `review:write`, `access:read`, `access:write`, `relay:read`, `relay:write`.
Use `Authorization: Bearer <access_token>`. Sessions default TTL 30 days.
`POST /api/auth/websocket-ticket` (bearer) → `{ticket, expiresAt}`; WebSocket at `/ws?wsTicket=<ticket>` speaks Effect RPC (JSON serialization) — not needed for v1 of the connector.

## Orchestration (bearer)

- `GET /api/orchestration/snapshot` → `OrchestrationReadModel {snapshotSequence, projects: OrchestrationProject[], threads: OrchestrationThread[], updatedAt}`
- `GET /api/orchestration/shell` → shell snapshot (threads without messages/activities)
- `GET /api/orchestration/threads/:threadId?turnLimit=&beforeCursor=` → thread detail
- `POST /api/orchestration/dispatch` body = one `ClientOrchestrationCommand` → `{sequence}`

```
OrchestrationProject { id, title, workspaceRoot, repositoryIdentity?, defaultModelSelection: ModelSelection|null,
  defaultThreadEnvMode?: "local"|"worktree"|null, faviconPath?, scripts: [], createdAt, updatedAt, deletedAt|null }
OrchestrationThread  { id, projectId, title, modelSelection, runtimeMode, interactionMode, branch|null, worktreePath|null,
  latestTurn: {turnId, state: "running"|"interrupted"|"completed"|"error", requestedAt, startedAt|null, completedAt|null, assistantMessageId|null}|null,
  createdAt, updatedAt, archivedAt|null, settledOverride, settledAt, snoozedUntil?, pinnedAt?, deletedAt|null,
  messages: OrchestrationMessage[], proposedPlans: [], activities: [{id,tone,kind,summary,payload,turnId,createdAt}], checkpoints: [],
  session: {threadId, status: "idle"|"starting"|"running"|"ready"|"interrupted"|"stopped"|"error", providerName|null, providerInstanceId?, runtimeMode, activeTurnId|null, lastError|null, updatedAt}|null }
OrchestrationMessage { id, role: "user"|"assistant" (OrchestrationMessageRole), text, attachments?, turnId|null, streaming: boolean, createdAt, updatedAt }
ModelSelection { provider?, instanceId?, model, options? }   // e.g. {instanceId:"claudeAgent", model:"claude-fable-5", options:{effort:"high"}}
RuntimeMode = "approval-required"|"auto-accept-edits"|"auto"|"full-access"
ProviderInteractionMode = "default"|"plan"
```

Commands (all ids are arbitrary non-empty strings; use UUIDs; `createdAt` is ISO-8601):
```
{ type:"thread.create", commandId, threadId, projectId, title, modelSelection, runtimeMode, interactionMode?, branch:null, worktreePath:null, createdAt }
{ type:"thread.turn.start", commandId, threadId, message:{messageId, role:"user", text, attachments:[]}, modelSelection?, titleSeed?, runtimeMode, interactionMode, bootstrap?, sourceProposedPlan?, createdAt }
{ type:"thread.turn.interrupt", commandId, threadId, turnId?, createdAt }
{ type:"thread.approval.respond", commandId, threadId, requestId, decision, createdAt }
{ type:"thread.user-input.respond", commandId, threadId, requestId, answers, createdAt }
{ type:"thread.session.stop", commandId, threadId, createdAt? }
{ type:"thread.archive"|"thread.unarchive"|"thread.delete", commandId, threadId }
{ type:"project.create", commandId, projectId, title, workspaceRoot, ... }
```
Provider instance ids seen in `~/.t3/caches/*.json`: `claudeAgent` (Claude, installed, authenticated), `codex`, `cursor`, `grok`, `opencode`.
