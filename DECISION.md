> **Read `DECISION-AMENDMENTS.md` first.** Two of this document's recommendations were
> overridden by Kevin, and its claim that Jarvis must live inside kevin-wiki is refuted
> by direct verification. Kept verbatim below because the underlying evidence is good.

# Jarvis — Decision Document

## 1. Verdict

**Winner: Architecture 3 (three-plane latency-maximalist), with Architecture 2's build sequencing grafted in.** Jarvis is three thermal planes: a HOT Swift process that owns mic-to-first-audio and is forbidden from awaiting any tool call; a WARM resident TypeScript daemon (`jarvisd`, new workspace package in `/Users/kevinliu/repos/kevin-wiki-rebuild`) that imports the wiki's runtime core in-process (EventStore, ArtifactStore, AutomationRuntime, localSearch, contracts) and spends idle time making answers pre-exist; and the COLD `pnpm kw` governance surface, shelled only off the voice path (verified: CLI startup ~3s, disqualifying it from any live turn). The critical graft from Architecture 2: **M0 is pure TypeScript with zero Swift** — hold-to-talk, real answers, one evening — because the Swift overlay is M3 polish, not the product's proof of life.

**Swift over Electron/Tauri for the shell, no hedging.** The research is unambiguous: Electron cannot do macOS forward-click-through (`setIgnoreMouseEvents(true, {forward:true})` is Windows-only), Tauri needs `macOSPrivateApi` transparency plus objc2 FFI for a correct NSPanel anyway, and neither gives you AXUIElement or ScreenCaptureKit. Everything hard about the overlay (non-activating NSPanel, per-region hitTest click-through, AX tree, CGEvent, system AEC via `setVoiceProcessingEnabled`, stable TCC identity) is native-only. The brain stays in TS where the wiki packages import directly.

**Rejected from the runners-up:** Architecture 1's "native app owns the voice brain" split (puts too much logic behind a compile-and-re-sign cycle, which breaks the self-modification story — Jarvis can safely rewrite TS behind `pnpm run check`, not a signed Swift binary); Architecture 2's `apps/jarvis` placement in favor of `packages/jarvis` (it's a runtime dependency of the shell, not a leaf app, though this is cosmetic); and all three architectures' temptation to treat the `schedulers/registrations.json` direct-write shortcut as permanent (accepted as the v1 path — verified below — but with a mandatory follow-up proposal to land the `SCHEDULE_BINDINGS` entry so `automation-v2 audit` reconciles).

## 2. System diagram

```
┌─────────────────────────── HOT PLANE (Swift, signed, LSUIElement) ────────────────────────┐
│  jarvis.app (menu-bar only)                                                               │
│  ┌──────────────┐  ┌──────────────────────────┐  ┌─────────────────────────────────────┐  │
│  │ Overlay      │  │ Ears                     │  │ Voice Turn Engine                   │  │
│  │ NSPanel/scrn │  │ AVAudioEngine AEC        │  │ Haiku 4.5 SSE (speculative fire)    │  │
│  │ click-through│  │ openWakeWord hey_jarvis  │  │ → sentence splitter                 │  │
│  │ + hitTest    │  │ Silero VAD + endpointer  │  │ → ElevenLabs Flash v2.5 ws (warm)   │  │
│  │ islands      │  │ Parakeet TDT v3 (ANE)    │  │ barge-in: fade/flush/abort/truncate │  │
│  └──────────────┘  └──────────────────────────┘  └─────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────┐   HARD RULE: no tool call, file read,     │
│  │ Eyes & Hands: SCScreenshotManager,         │   or subprocess awaited in-turn.          │
│  │ AXUIElement, CGEvent/AXPress               │   Cache reads <20ms only.                 │
│  └────────────────────────────────────────────┘                                           │
└───────────────────────────────┬───────────────────────────────────────────────────────────┘
                                │ unix socket JSON-RPC (~10 typed primitives each way)
┌───────────────────────────────▼─────────── WARM PLANE (TS, launchd-resident) ─────────────┐
│  jarvisd  =  packages/jarvis in ~/repos/kevin-wiki-rebuild (tsx, Node ≥24)                │
│  ┌────────────────┐ ┌─────────────────┐ ┌───────────────────┐ ┌────────────────────────┐  │
│  │ Memory         │ │ Prefetch cache  │ │ Intent router     │ │ Background agent pool  │  │
│  │ @kw/store      │ │ briefd :4318    │ │ @kw/workflow-     │ │ Claude Agent SDK       │  │
│  │ (jarvis.sqlite)│ │ HN Firebase 15m │ │ registry router   │ │ + agent-hygiene ledger │  │
│  │ @kw/artifact-  │ │ ack-audio bank  │ │ + run-intent fns  │ │ + agent-broom reaping  │  │
│  │ store (CAS)    │ │ TLS pre-warm    │ │                   │ │ + agent-reach toolbelt │  │
│  └────────────────┘ └─────────────────┘ └───────────────────┘ └────────────────────────┘  │
│  ┌──────────────────────────────┐ ┌──────────────────────────────────────────────────┐    │
│  │ Scheduler host (the missing  │ │ Retrieval: @kw/local-search → qmd BM25 (0.18s)   │    │
│  │ clock): AutomationRuntime    │ │ Browser arm: agent-browser / browser-use CLIs    │    │
│  │ .tick() q5min + .deliver()   │ │ Computer-use policy engine (confirm taxonomy)    │    │
│  └──────────────────────────────┘ └──────────────────────────────────────────────────┘    │
└───────────────────────────────┬───────────────────────────────────────────────────────────┘
                                │ shell-out, NEVER on the voice path (~3s tsx startup)
┌───────────────────────────────▼─────────── COLD PLANE (existing kw governance) ───────────┐
│  pnpm kw route / run / workflow propose|approve / automation-v2 register|tick|audit /     │
│  capability doctor / public doctor  ·  workflows/*/workflow.yaml  ·  proposals →          │
│  exact-hash ApprovalReceipts → proof receipts  ·  pnpm run check (46-check doctor)        │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

## 3. Import manifest from kevin-wiki

Ranked by value. Verified: `tickLocalSchedules` in `packages/cli/src/automation-audit.ts` reads `schedulers/registrations.json` directly, validates only against `assertContract("scheduler-registration-registry")`, and its generic-input branch `{requestId, profile, intent, payload}` exactly satisfies `workflows/research.refresh/input.schema.json` (required: `requestId, profile, intent`) — the "go for it" shortcut is real.

| wiki path | what it gives Jarvis | import as | confidence |
|---|---|---|---|
| `packages/automation-runtime/src/{runtime,registry}.ts` | The literal "make it recurring" engine: `due()/tick()/deliver()`, bucket-idempotent | workspace dep | high |
| `packages/store/src/event-store.ts` | Durable memory: conversation events, "remember this", run states (own db path) | workspace dep | high |
| `packages/contracts/src/index.ts` | Fail-closed validation; proposal/approval-receipt/proof-receipt; hard transitive dep anyway (schemas resolve relative to src — must stay in-repo) | workspace dep | high |
| `packages/artifact-store/src/store.ts` | Content-addressed evidence: screenshots, TTS audio, HN snapshots, self-mod diffs | workspace dep | high |
| `packages/local-search/src/index.ts` | 0.18s BM25 "answer from my brain" (only retrieval mode inside the voice budget) | workspace dep | high |
| `apps/briefd/src/{server,service}.ts` | Daily briefing: `POST /brief/compile`, `GET /brief/latest` (verified routes) | in-process import of `BriefService` | high |
| `packages/cli/src/{run-intent,workflow-run,automation-audit}.ts` | `routeWorkflows`, `executeRegisteredWorkflow`, `registerLocalSchedules`, tick semantics | workspace dep (import the functions, never the CLI entry) | high |
| `skills/productivity/cleanup-terminals-browsers/scripts/*` (5 scripts, ~1,074 lines) + `packages/agent-broom` | Worker ledger, audit, ownerToken-gated reaping; powers the "running tasks" HUD | copy scripts + workspace dep | high |
| `workflows/workflow.evolve/workflow.yaml` + `workflows/wiki.migrate-cluster/workflow.yaml` + `scripts/run-agent-self-evals.ts` + `evals/agent-self-improvement/suite.json` | The entire self-modification governance template + deterministic receipt judge | read-only reference / shell-out | high |
| `packages/capability-registry/src/registry.ts` + `capabilities/{git.worktree,qmd.search,output.compact-explicit}/capability.yaml` | Fail-closed gating for every new Jarvis power; manifest exemplars | workspace dep + reference | high |
| `packages/source-sdk/src/fabric.ts` + `connectors/url/src/url.ts` | Receipted capture for HN/web provenance (async, post-answer) | workspace dep | medium |
| `skills/personal/kevin-voice/SKILL.md` + `references/proof-bank.md` + `skills/personal/slack-voice/SKILL.md` | The spoken persona: Spoken Answer Mode + lowercase register + fact whitelist | read-only reference (baked into system prompt) | high |
| `skills/misc/elevenlabs-sfx/SKILL.md` | ElevenLabs auth resolution, xi-api-key, error map, afplay loop (swap endpoint to TTS) | read-only reference | high |
| `skills/engineering/{agent-browser,browser-use,electron,playwright,webwright}/SKILL.md` | Browser routing contract, preserved verbatim | shell-out (external CLIs) | high |
| `skills/engineering/computer-use/SKILL.md` | Confirmation-mode risk taxonomy (prose policy — the only reusable part; zero actuation code exists) | read-only reference | high |
| `automations/_schema.md` + `schedulers/registrations.json` + `workflows/catalog.json` | The artifacts the automation creator writes | data files (write path) | high |
| `skills/engineering/{loading-screens,make-interfaces-feel-better}/SKILL.md` | HUD design language (braille spinners, 17 interaction rules) | read-only reference | medium |
| `packages/agent-machines-adapter/src/index.ts` | Least-authority worker presets (~30 lines; import or inline) | workspace dep | medium |
| `wiki/SOUL.md`, `wiki/USER.md`, `wiki/HEARTBEAT.md`, `AGENTS.md`, `wiki/meta/agent-operations-hub.md` | Constitution: stop conditions, transitive-authority rule, escalation policy | read-only reference | high |

**Do NOT import:** `packages/cli/src/index.ts` as a module (top-level script, executes on import — shell-out only, off-hot-path); `packages/{review,brain-compiler,corpus,automation-audit}` beyond the named functions (wiki-repo-layout coupled — drive via `kw`); `packages/{anim-core,fieldwork-adapter,reticle-edges,public-compiler}` (off-mission); `skills/engineering/control-in-app-browser` (missing its `browser-client.mjs`, Codex-runtime-coupled); `skills/engineering/screenshot/scripts/` (documented but **absent from the checkout** — use raw `screencapture` / SCScreenshotManager); Clicky's Cloudflare Worker pattern (verified unauthenticated key-drain; local Keychain keys instead); qmd `vsearch`/`query` (measured ~7s + Metal compile error on this machine).

## 4. Latency budget

Mic-open to first spoken syllable. Numbers are vendor/third-party best-cases plus one benchmark harness (kwindla/Pipecat) — **M1's exit gate is a measured 50-utterance suite on Kevin's actual hardware**, not this table.

| stage | target ms | technique that buys it |
|---|---|---|
| Wake word detect | 0 (≈90ms hidden) | openWakeWord `hey_jarvis` overlaps the utterance; earcon fires on detect |
| Endpoint detection | 150 | Silero VAD + semantic endpointer, not naive silence (saves 350–650ms) |
| STT final flush | 50 marginal | Parakeet TDT v3 on the Neural Engine; partials streamed during speech |
| IPC to jarvisd | 5 | unix socket, cache-read-only in-turn |
| Retrieval (when used) | 0 marginal | qmd BM25 (0.18s measured) fired in parallel with the LLM leg |
| Claude Haiku 4.5 TTFT | 400 effective | speculative fire on stable partial (~250ms overlap), pre-warmed TLS, stable prompt prefix; raw 500–650ms median |
| First sentence → TTS TTFB | 200 | ElevenLabs Flash v2.5 websocket, pre-opened and kept warm, sentence-boundary chunking (Clicky's verified biggest miss: it buffers the whole mp3) |
| Audio out | 40 | CoreAudio, wired/built-in output — Bluetooth adds 100–200ms and is banned from the budget |
| **Total (novel query)** | **~845 typical, <1000 p75** | |
| **Cached path (brief/HN/memory)** | **~250–350** | jarvisd prefetch: brief pre-compiled each morning, HN polled q15min |
| **Perceived floor (tail/tool turns)** | **~150–250** | earcon + pre-synthesized acknowledgment bank masks Haiku's ~0.9s p95 TTFT |

Caching caveat (verified against the API reference): Haiku 4.5's minimum cacheable prefix is 4096 tokens — a short system prompt silently won't cache. Either keep it small and eat cheap uncached prefill, or deliberately build a >4K stable prefix (persona + memory digest) and pre-warm at launch.

## 5. The four flagship loops

### A. Wake + greet ("hey jarvis" → "hi back")
1. `Ears` (Swift): openWakeWord fires on `hey_jarvis`; earcon plays <30ms; overlay buddy switches to `breathe`→`scan` braille state.
2. If the utterance ends at the wake phrase (VAD endpoint, no command), the Voice Turn Engine skips the LLM: pre-synthesized greeting variant from the ack-audio bank plays at ~150ms.
3. Turn logged: `EventStore.append({streamId:"conversation", eventType:"jarvis.greeting", idempotencyKey, ...})` in `jarvisd`.

### B. Daily briefing
1. Overnight: jarvisd's morning tick calls `BriefService.compile(requestedAt)` (in-process import from `apps/briefd/src/service.ts`) — fixes the verified staleness trap (latest projection dated 2026-07-21).
2. On "what's my daily briefing": Voice Turn Engine asks jarvisd, which reads `latestProjection()` (ms) + the HN cache.
3. Narration layer renders `counts` + top `cards[].title/explanation` into breath-unit speech (kevin-voice Spoken Answer Mode), prepends HN/news headlines — honest framing: today's brief is a governance/review projection, so the news half comes from the HN arm.
4. First sentence hits the warm ElevenLabs socket at ~250ms.

### C. HN research ("what's on hackernews")
1. Instant path: jarvisd's prefetcher polled `https://hacker-news.firebaseio.com/v0/topstories.json` + items q15min; cached ranked summaries narrated immediately (~250ms). Nothing in-repo covers HN — this fetcher is new (~100 LOC).
2. Deep path ("dig into that Postgres thread"): Voice Turn says "on it" (ack bank), jarvisd spawns a Claude Agent SDK worker with the agent-reach toolbelt, registered via `agent-hygiene.sh add --pid --purpose`.
3. Provenance, fire-and-forget after speaking: snapshot via the SSRF-guarded url connector / a new `hn` connector manifest through `SourceFabric.capture()` into ArtifactStore.
4. Worker completion re-enters as an async turn: "that HN research is done — want the summary?"

### D. "Make it recurring" → "go for it"
1. After answering, jarvisd checks `routeWorkflows(currentWorkflowRegistry(root), intent)` in-process — is there already an automation?
2. Jarvis asks aloud. On "go for it":
3. Write `automations/<slug>.md` with V1 frontmatter per `automations/_schema.md`.
4. Record the spoken consent as an ApprovalReceipt (`assertContract("approval-receipt")`) bound to the registration digest.
5. Append a schema-valid `enabled:true` entry to `schedulers/registrations.json` bound to `research.refresh` + a declared profile — **verified**: `tickLocalSchedules` reads this file directly, re-checks nothing but the contract, and its generic `{requestId, profile, intent}` input satisfies `research.refresh/input.schema.json`. Add catalog aliases in `workflows/catalog.json` so the phrase stays voice-routable.
6. Speak the constraint honestly: schedule vocabulary is `every-4-hours|daily|weekly` only (verified enum) — "every hour" gets a counter-offer.
7. jarvisd's clock (the repo's confirmed missing daemon) runs `AutomationRuntime.tick(now, execute)` q5min, refreshing `kw capability doctor` observations first (TTL'd, fail-closed).
8. On completion, read the `AutomationRunState` projection, speak the result, stamp `deliver(registrationId, deliveredAt)` — Jarvis IS the previously-unimplemented delivery channel.
9. Debt repayment: queue a proposal to add the `SCHEDULE_BINDINGS` entry in `packages/automation-audit/src/schedule.ts` so `pnpm kw automation-v2 audit` reconciles instead of flagging drift.

**Known soft spot, stated plainly:** recurring runs bound to `research.refresh` execute `ResearchRefreshExecutor` — a deterministic re-verifier of already-captured sources, not an agent. A recurring job that genuinely *re-answers* a question needs the Agent-SDK runner bridge (worker run → receipt → proofReceiptId), which has no precedent in the repo and is the least-proven component here (M4).

## 6. Computer use & browser use

**Pointing: AX-first, vision-fallback, never vision-only.** Query `AXUIElementCreateApplication(pid)` → focused window → element frames + labels (30–80ms, zero tokens, no mis-click); fly the overlay buddy to the real frame using Clicky's verified bezier choreography (0.6–1.4s distance-scaled, 1.3x apex pulse — copy the constants, replace the 60Hz mouse-poll with event-driven tracking). Only when AX is empty — Electron/Chromium/canvas, which is honestly **most of Kevin's desktop** (Cursor, Chrome, Slack, Discord), so the "fallback" carries real weight — fall back to `SCScreenshotManager` one-shot capture (overlay excluded via `SCContentFilter`), XGA downscale, Haiku vision coordinates, proportional remap. This ships the path Clicky built and left as dead code (`ElementLocationDetector.swift`, verified never instantiated).

**Clicking:** `AXUIElementPerformAction(kAXPressAction)` when AX-reachable (survives layout shifts); CGEvent synthesis otherwise, with a ~200–500ms eased real-cursor glide so Kevin sees what's coming. Every action classified by the confirmation taxonomy in `skills/engineering/computer-use/SKILL.md` (hand-off / always-confirm / pre-approvable / always-allowed) — the repo's only reusable computer-use asset; the actuation code is all new. Multi-step sequences run as background tasks narrating progress; they never block the voice loop.

**"Select stuff and tell it stuff":** a hold-hotkey arms a second, hit-testable overlay window. It captures `kAXSelectedText` from the focused element (Cmd+C clipboard fallback), the AX element under the cursor, and an optional drag-region screenshot. That bundle is pinned as context for the next voice turn ("what does this error mean" just works) and archived to ArtifactStore.

**Browser use — routing contract preserved verbatim:** agent-browser first for interactive voice-driven work (`batch`, `snapshot -i` refs, `--auto-connect` to logged-in Chrome); browser-use daemon (~50ms/cmd, `--mcp`) when command latency or tunnels matter; Electron desktop apps via CDP relaunch (`open -a "Slack" --args --remote-debugging-port=9222`) instead of pixels; Playwright only for Jarvis's own committed tests; webwright when a browsing task should become a rerunnable evidence-leaving script; AgentCore for cloud offload with the Live View URL surfaced on "show me". Browser tasks never route through the CGEvent hands.

## 7. Self-modification

Jarvis rewrites its own TS (`packages/jarvis`) — never its signed Swift shell autonomously — through the wiki's existing governance, because the wiki explicitly refuses the naive version:

1. **Edit in isolation:** disposable git worktree via the proven `capabilities/git.worktree/capability.yaml` (local-only, declared rollback). Inherits AGENTS.md verbatim: "Preserve uncommitted work you did not create."
2. **Prove:** `pnpm run check` (= contracts:check + typecheck + tests + the 46-check doctor in `packages/cli/src/doctor.ts`) plus a receipt scored by `npx tsx scripts/run-agent-self-evals.ts` against `evals/agent-self-improvement/suite.json` (min 0.9; evaluator-hardens-first: no behavior edit before the eval that would catch the failure exists). Two known gaps to fix first: the `npm run agent-self-eval` alias is missing from root package.json, and receipts are currently self-reported by the agent being judged — the harness must generate them.
3. **Propose:** full-byte diff + content hash emitted as a proposal into the review queue, per the exact-bytes discipline in `packages/review`.
4. **Approve:** a new `jarvis.self-modify` workflow manifest cloned from `workflows/wiki.migrate-cluster/workflow.yaml`'s shape — `approvalPolicy: exact-hash`, approval-required first phase, digest-keyed idempotency, single-flight. Per ADR 0005: changed hashes invalidate approval.
5. **Push/pull is a genuinely new authority domain** (verified: no capability grants remote git anywhere): a new `git.remote` capability manifest + doctor, with per-operation approval binding exact repo + head + branch + file bundle + message + token scope + expiry — because `workflows/workflow.evolve/workflow.yaml` rules verbatim that "a standing auto-commit, auto-push, or auto-PR preference does not count as exact approval," and the ops-hub transitive-authority rule forbids laundering a push through a wrapper labeled local. Spoken UX: "patch ready, doctor green, evals 0.94 — approve push of digest a3f…?" and "go for it" becomes the ApprovalReceipt over those exact hashes.
6. Old code is archived-not-deleted per the brain-compiler discipline; Jarvis-specific checks extend `runDoctor` rather than forking a parallel health system.

This is slower than the fantasy by design — and correctly so.

## 8. Build plan

- **M0 — one evening, pure TS, no Swift.** `pnpm jarvis` in the workspace: global hold-to-talk hotkey, mic → streaming STT (cloud STT acceptable tonight), Claude Haiku 4.5 streaming → sentence splitter → ElevenLabs POST per sentence → afplay (auth/error-map from `skills/misc/elevenlabs-sfx`). Three real answers wired: daily briefing (`BriefService.compile` + narrate top cards), "what's on hackernews" (new Firebase fetcher), "what do I know about X" (`localSearch` BM25). Kevin-voice Spoken Answer Mode prompt. Per-stage latency logger from turn one. **Done when:** Kevin holds a key, asks all three questions, and hears correct spoken answers with logged stage timings.
- **M1 — always-on ears + hot-loop hardening.** openWakeWord `hey_jarvis` + Silero VAD, ElevenLabs websocket pipelining, speculative fire with abort/refire, AEC + barge-in state machine, ack-audio bank, EventStore memory at `.kw/jarvis.sqlite`, launchd install. **Done when:** a 50-utterance benchmark on Kevin's hardware shows <750ms median / <300ms perceived, and barge-in works 10/10 with history correctly truncated.
- **M2 — the recurring loop, end to end.** Loop D above in full: answer → "make it recurring?" → "go for it" → `automations/<slug>.md` + validated registrations entry + aliases; jarvisd hosts tick with capability-doctor pre-flight; deliver() stamped on spoken report. **Done when:** a voice-created automation ticks on schedule, its `AutomationRunState` shows completed with a proofReceiptId, and `pnpm kw automation-v2 tick` (dry) lists it as due at the right bucket.
- **M3 — the Swift face.** Menu-bar app, per-screen non-activating NSPanel with hitTest islands, Clicky flight choreography, Parakeet/FluidAudio STT in-process, braille-spinner states, stable Apple Development signing + TCC preflight doctor; hot loop migrates from TS into Swift with jarvisd as brain over the unix socket. **Done when:** the buddy flies to a spoken target on screen over a full-screen app without stealing focus, and TCC grants survive a rebuild.
- **M4 — hands, selection, browser arm, agent pool.** AX-first pointing + vision fallback, CGEvent/AXPress behind the confirmation taxonomy, select-and-tell hotkey, agent-browser/browser-use routing, Agent SDK workers with hygiene-ledger registration and async report-back, running-tasks HUD panel, the Agent-SDK-runner bridge for generative recurring jobs. **Done when:** "click the export button" works in a native app AND a Chromium app, a selected error message is explained by voice, and a background research task reports back unprompted.
- **M5 — governed self-modification.** `jarvis.self-modify` manifest, `git.remote` capability + doctor, harness-generated receipts, fixed self-eval npm wiring, per-push spoken exact-hash approval, runDoctor extension, SCHEDULE_BINDINGS debt-repayment proposal landed. **Done when:** Jarvis proposes a real patch to itself, passes `pnpm run check` + eval ≥0.9, and the push executes only after a spoken approval of the exact digest — and a repeat "go for it" with a changed diff is refused.

## 9. Decisions Kevin must make

1. **Repo location** — build inside `~/repos/kevin-wiki-rebuild` as `packages/jarvis` (recommended: mandatory anyway, since packages export raw `./src/index.ts` and contracts' schemas resolve relative to src) vs. a standalone repo vendoring copies. Cost of the recommendation: Jarvis's uptime couples to a live rebuild branch (`codex/full-wiki-rebuild`).
2. **API spend** — ElevenLabs Flash (paid, cloud, best voice + IVC cloning) vs. Kokoro-82M local (free, no cloning). Recommend: ElevenLabs primary, Kokoro auto-fallback. Also: record a voice sample if Jarvis should literally sound like a chosen voice — no voice assets exist in the wiki.
3. **Wake-word vendor** — openWakeWord (free, offline, pretrained `hey_jarvis`, but a Python/ONNX third runtime) vs. Porcupine (better in noise, Swift-friendly, but AccessKey + license validation). Recommend: openWakeWord first; swap only if false accepts annoy you in practice.
4. **Hermes reconciliation** — jarvisd becomes a second persistent operator alongside the Hermes Mac-Mini stack (`skills/productivity/hermes-operator-stack`), which SOUL.md warns against. Recommend: declare Jarvis the desktop voice/HUD face and the *only* tick host on this Mac; Hermes keeps the Mac Mini. Decide before M2, not after.
5. **Apple Developer account** — required for stable-cert signing so TCC grants survive rebuilds (Sequoia silently blocks ScreenCaptureKit for ad-hoc binaries). Recommend: yes, before M3; it's the price of the native shell.
6. **STT cloud tier** — accept Deepgram/AssemblyAI as an accuracy fallback (network + per-minute cost) or stay Parakeet-only (25 European languages, weaker on jargon). Recommend: local-only until a measured failure.

## 10. Open risks (ranked)

1. **The Agent-SDK runner bridge is unproven.** Recurring "re-answer this question" jobs need an agent-run → receipt → proofReceiptId bridge with no precedent in the repo; until it exists, recurring automations are deterministic re-verifiers and the flagship promise under-delivers. This is the design's load-bearing new invention.
2. **Latency numbers are stacked best-cases.** Haiku p95 TTFT ~0.9s alone busts the 1s budget on tail turns; ElevenLabs' 75ms excludes network; Bluetooth output adds 100–200ms silently. The ack-bank masks this but will sound canned if overused. M1's measured gate is the real test.
3. **AX fails where Kevin lives.** Cursor/Chrome/Slack/Discord are Electron/Chromium with weak AX trees, so vision fallback (1–4s per step) is the *common* pointing path on his desktop, inheriting Clicky's mis-click problem.
4. **Governance drift from the registrations shortcut.** Direct-writing `schedulers/registrations.json` bypasses the `SCHEDULE_BINDINGS` gate — verified to work, but it's exactly the "scheduler row shadowing manifest truth" the ops hub warns about. Mitigated only if the M5 debt-repayment proposal actually lands.
5. **Coupling uptime to a live rebuild repo.** TS-source exports, experimental `node:sqlite` on Node 24, per-checkout `.kw` state, a mid-rebase tree — any of these can mute the assistant that's supposed to brief you.
6. **macOS platform churn.** Tahoe (26) has active overlay mouse-event regressions; content-protection is dead on 15+; TCC/signing friction on every dev build; the screenshot skill's helper scripts are confirmed missing from the checkout.
7. **Retrieval ceiling.** Semantic search is broken on this machine (qmd vsearch: Metal compile error, ~7s); "answer from my brain" is BM25 over a manually-indexed collection that was 5 days stale at inventory time.
8. **Three runtimes for one wake word.** Swift + TS + Python/ONNX must all be alive for "hey jarvis" to work; the unix-socket contract will drift without codegen'd types and an integration test in `pnpm run check`.
9. **Expectation mismatch on "daily briefing."** Today's brief is a governance/review-queue projection, not news + calendar; calendar/email sources don't exist in the repo at all and weren't scoped here.
10. **Inference debt in the evidence.** heyclicky's commercial features (agents, pricing, funding) are marketing/press-inferred, not source-verified; several 2026 vendor model names (Cartesia tiers, AssemblyAI naming) were flagged as possibly stale by the researcher — re-verify before committing to a vendor.