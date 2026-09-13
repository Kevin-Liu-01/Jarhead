# Latency: from Kevin's words to a visible action (2026-09-11)

Kevin: "simple commands like 'search the wiki for design' produce a visible
action within two to five seconds after I finish speaking"; later, "tool uses
should literally be sub 2 second". This is the report for that work: what was
measured before, what was found, what was changed, and what it measures after.
Every number is marked **measured** (a ledger row, a wire timestamp, a bench
sample) or **reasoned** (derived, estimated, or believed). Sections marked
in §5 come from the AFTER run on a quiet machine (load ≈ 4).

## 1. Goal and targets

| what Kevin experiences | target | before (measured) |
|---|---|---|
| speech end → first visible action (a click, a scroll, a typed text, an app coming to front, a search result, a circle drawn on the screen) | **2–5 s** | 12.5 s median from the delegation on the 11 simple app-server commands (§3a; 12.2 s over all 39, §3b); speech end → delegation adds 0.4–1.6 s (n=4) → ≈ 13–14 s |
| one tool use (the brain deciding on a tool → the tool's effect) | **< 2 s** | a model generation is 3.4 s median / 5.9 s p90; the tool's own round trip is 55 ms median |
| the tool path Jarhead controls (runner → toolset → helper → back) | already met: 55 ms median, 211 ms p95 | 0.4–2.2 % of a delegation's wall time |

The reflex path (REDESIGN §12) already meets the target for the one-step
commands the grammar catches ("scroll down", "open safari", "press enter":
3 ms with canned hands, ~125–455 ms through the ear with the real helper). This
report is about everything that still needs the model.

## 2. Method

### What was traced

- **The real ledger.** `~/.jarhead/ledger/2026-09-10.jsonl` and `2026-09-11.jsonl`
  joined with `daemon.log` by delegation id: 39 delegations at the first pull (51 by
  the evening), every `delegation.created` / `delegation.step` / `delegation.finished`
  row with its wall clock, the `heard` / `said` rows around them. Phases: speech end →
  delegation (Live's session clock: `delegation.offsetMs − heard.endMs`), delegation →
  "On it", → eyes' shot, → first model thinking, → first model tool (the eyes' shot
  excluded), → first visible action (`ACTING_MEMBERS` plus shell / AppleScript / file
  writes / browser actions / overlays), → first verification, → done, → spoken reply.
  Only 4 of 51 delegations had their triggering utterance on the ledger (§4, the
  `finalizeOpen` finding), so speech-end phases are a small biased sample.
- **The prompt and context Codex sees.** The developer instructions the brain sends
  (6,423 chars ≈ 1.7k tokens), the delegation prompt (~450 chars), what Codex 0.154
  adds on its own: the skills catalog (~8.4k tokens, 260 of 718 skills listed and a
  "458 additional skills were not included" warning every turn), `~/.codex/AGENTS.md`
  (~0.7k tokens), the multi-agent role text (~0.7k), and how the 63 `jarhead` MCP tools
  reach the model — **not** as inlined schemas but through code-mode `exec`
  (`tools.mcp__jarhead__<name>`) with no descriptions or parameter schemas, ≤ ~780
  tokens for the whole server. Measured through `thread/tokenUsage/updated`
  (21.6k input tokens on a cold turn, 21.4k of them cached when warm).
- **The code path.** `Delegator` → `Brain.handle` → `codex app-server` `turn/start` →
  the model → `mcpToolCall` → the MCP bridge → the daemon socket → `ToolRunner` →
  `ComputerToolset` → the Swift helper, and back; where each stamp in
  `DelegationTimings` / `DelegationTimingsExtra` is taken; `needsFreshThread()` and
  the context rollover.
- **Controlled runs of the real brain.** Tiny `codex app-server` sessions by hand
  ("reply pong": cold 4.3 s to the first token, warm 1.8–3.1 s; effort low / medium /
  high made no difference on trivial turns), and the representative-command harness
  below: 10 runs on the real Codex brain with a stand-in Live and canned hands.

### The harness: `pnpm jarhead bench --brain`

`packages/cli/src/bench-brain.ts` drives a real `Engine` with the REAL brain
(`auto`, Codex on this Mac: the resident app-server, one thread across delegations,
one `turn/start` per delegation — exactly the product's path), a stand-in Live
session (no socket, no billing) and canned hands (Safari in front on a wiki page, a
1280×800 synthetic screen, `find_element` answering the search field, click / type /
key succeeding, a typed text visible to `read_focused_text` afterwards). Five
commands, in the product's two paths:

```
jarhead search the wiki for design
jarhead open safari
jarhead what is on my screen
jarhead click the search bar and type hello
jarhead scroll down
```

Phase 1, reflexes ON: the commands the grammar catches (open safari, scroll down)
finish without a model turn — the rows Kevin gets. Phase 2, reflexes OFF: every
command N times (default 2) on the model. Per run it records delegation → first
thinking, → first model tool (the first `ToolRunner` call the brain made; the eyes'
shot excluded), → first ACTION (the first acting tool that returned ok — a
confirmation question is not one), → done; the model steps (MCP tool calls + Codex
shell commands + a final message — one generation each; reasoning items as a
cross-check), the tool calls by name, context rollovers (off the app-server wire: a
turn on a different thread than the previous turn's), wiki-bootstrap calls (the stale
`~/Documents/GitHub/kevin-wiki` root, `~/.codex/AGENTS.md`, `npm run status`),
no-such-file errors (file tools only), the first words, and the gaps between
consecutive model events (the per-generation cost). It prints medians and p95 per
command and overall; `--json` prints everything; `--out FILE` writes it; `--effort
low|medium|high|xhigh|max` is the A/B flag; `--no-reflex` is the brain path alone.
Nothing touches the Mac; the Codex turns cost Kevin's ChatGPT plan, not dollars, and
the header says so, with the load average (the numbers depend on it). Without a
signed-in Codex the bench refuses to run — the engine's `auto` would otherwise spend
API dollars on ten screenshot-carrying turns — unless `--allow-api-spend` is passed.

Seconds in this report are **from the delegation** (Live's hand-off to the brain)
unless a row says "speech end". Speech end → delegation is Live's own transcription
and decision time (0.4–1.6 s in the 4 measurable cases); it is now stamped on every
delegation (`DelegationTimings.speechEndAt`, §5) so the next pull of the ledger has it
for all of them.

## 3. BEFORE (the analysts' numbers, 2026-09-11)

Measured on the real ledger (39 delegations) and the controlled runs. Load average
4–16 during Kevin's sessions. Two populations, and every row below comes from ONE
of them: **the 11 simple commands on the codex app-server transport** (Kevin's target
class — "search the wiki for design", "open safari", "click …"; the numbers the brief
quotes) and **all 39 delegations** (every class and transport, the long multi-step
ones included). Source for both: the ledger (`traces/phases.md`); p95 is nearest-rank.

### 3a. The 11 simple commands on the app-server (Kevin's target class)

| phase | median | p90 | p95 | n |
|---|---:|---:|---:|---:|
| delegation → "On it" (Live acknowledges) | 0.2 s | 0.5 | 0.6 | 11 |
| delegation → eyes' shot | 0.1 s | 0.2 | 0.2 | 11 |
| delegation → first model thought | **5.7 s** | 6.9 | 9.3 | 11 |
| first thought → first model tool (narration gap) | 4.4 s | 7.3 | 8.3 | 11 |
| delegation → first model tool | **11.3 s** | **13.0** | 13.2 | 11 |
| delegation → first visible action (overlays included — `ACTING_TOOLS`) | **12.5 s** | **17.5** | **19.8** | 10 |
| delegation → first world action (overlays excluded) | 12.1 s | 19.1 | 20.6 | 7 |
| first action → first verification | 3.6 s | 5.7 | 7.2 | 8 |
| delegation → first verification | 14.7 s | 19.7 | 21.8 | 8 |
| first verification → done | 7.8 s | 25.2 | 25.6 | 8 |
| delegation → verified completion (done) | **22.1 s** | **40.7** | 40.8 | 11 |
| done → spoken reply | **0.7 s** | 4.6 | 5.7 | 6 |

### 3b. All 39 delegations

| phase | median | p90 | p95 | n |
|---|---:|---:|---:|---:|
| speech end → delegation | 0.9 s (0.4–1.6) | 1.5 | 1.5 | 4 — only 4 utterances survived (§4) |
| delegation → "On it" | 0.2 s | 0.5 | 0.6 | 35 |
| delegation → eyes' shot | 0.1 s | 0.1 | 0.2 | 18 |
| delegation → first model thought | 6.2 s | 8.4 | 10.6 | 34 |
| first thought → first model tool (narration gap) | 4.8 s | 6.6 | 7.2 | 28 |
| delegation → first model tool | 11.5 s | 13.1 | 13.5 | 28 |
| delegation → first visible action | 12.2 s | 17.0 | 21.8 | 21 — **0 of 39 inside 5 s** |
| first action → first verification | 3.7 s | 7.5 | 8.9 | 19 |
| delegation → verified completion (done) | **16.8 s** | 40.7 | 41.6 | 39 |
| done → spoken reply | 0.7 s | 9.0 | 13.1 | 24 |

Over all 39 the done median is **16.8 s, not 22.1 s**: Kevin's target class runs
longer to completion than the average delegation (its verification loops), which is
why this report quotes the 11-command figures (§3a) as the numbers to beat and keeps
the two populations apart.

### 3c. Controlled runs (the real brain, by hand and through the harness)

| what | value | n | source |
|---|---|---:|---|
| one model generation (gap between consecutive model steps) | **3.4 s** median / **5.9 s** p90 | 35 | harness, real Codex |
| tool round trip inside the runner | **55 ms** median / 145 p90 / **211 ms** p95 | 120 | ledger |
| share of a delegation's wall time spent inside tools | 0.4–2.2 % | 16/18 | ledger, app-server delegations |
| warm no-tool turn, first token | 1.8–3.1 s | 3 | `app-server` by hand |
| cold no-tool turn, first token | 4.3 s | 3 | `app-server` by hand |
| fresh thread's first turn, first tool | 10.6–12.2 s | 2 | `bench --codex` |
| warm thread, first tool | 3.1–4.9 s | 2 | `bench --codex` |

Counts over the first 39 delegations (measured): **147 tool calls** in the trace
(132 by the model + 15 eyes' shots; the brief's "152" counts differently — same
trace), **56 screenshots**, 8 zooms, **13 wiki-bootstrap calls**
(12–17 depending on the pattern), **6 read_file "no such file"** (plus 4 `run_shell
cat` of a missing file), 5 failed `read_focused_text` (all on Chromium windows), 13
failed MCP calls, `npm run status` 2.1 s once, 2 AppleScript calls over 3 s. Context
rollovers: 11 in daemon.log over ~31 app-server delegations; 14 of the 18 app-server
delegations in the first 39 ran their first turn on a fresh thread.

Reasoned from the above: **latency ≈ 0.7 s + (model generations) × 3.4 s.** A
visible action inside 5 s needs the first generation to BE the action and a
per-generation cost under ~3 s; nothing in the tool path is worth optimising for
this goal.

### BEFORE, the worktree as the builders started (`pnpm jarhead bench --brain --runs 2`, 2026-09-12 02:35 UTC)

The second BEFORE sample, taken with the harness as shipped in this change (real
Codex, canned hands, effort medium, load average 8.9 → 11.6, warm app-server, thread
start 3.4 s). Saved in the repo as [`docs/latency/before-worktree.json`](latency/before-worktree.json)
for the integrator's diff (the analysts' own `baseline.json` is not in the repo: the
model read real wiki pages into it; its numbers are quoted in §3c). **Read it with two
caveats.** (1) It is not the clean baseline:
the builders were already editing the same worktree when it ran — the developer
instructions were 10,140 chars (6,423 in the analysts' baseline), the app-server
argv had 37 entries (29), the brain ran from a private CODEX_HOME with "no AGENTS.md,
no skills", and there were **0 rollovers over 846k cumulative tokens** where the
baseline rolled over 3 times in 10 — so the wiki-bootstrap, skills and rollover
findings are already absent from it. (2) The canned world differs from the analysts'
harness: Safari shows a **wiki page** with a search field, so "search the wiki for
design" is answered by clicking that field and typing (`left_click`, `browser_type`)
rather than by `search_files` on disk; and a typed text is visible to
`read_focused_text`, so the verification loops that inflated the baseline's
click-and-type rows (4–6 generations) do not occur. Compare AFTER against this table,
same harness; compare against §3 only for the shape. Two fields are missing from
this sample because it predates them: `t.speechToDelegation` (the delegator's
`speechEndAt` stamp landed after the run) and the per-run `threadId` the rollover
count is now read from (its `rollovers: 0` came from the old log grep, corroborated
by `tokenUsage.last` rising 21.8k → 39.0k over the 10 turns — one thread).

| command (brain path) | n | 1st thinking | 1st tool | 1st action | done | model steps (median) | tool calls |
|---|---:|---:|---:|---:|---:|---:|---|
| wiki-search | 2 | 3.9 / 11.6 | 3.9 / 11.6 | 3.9 / 11.6 | 9.9 / 16.1 | 3 | left_click×2 browser_type×2 |
| open-safari | 2 | 4.5 / 8.5 | 4.5 / 8.5 | 4.5 / 8.5 | 9.9 / 12.1 | 2 | open_app×2 |
| whats-on-screen | 2 | 3.8 / 4.4 | – | – | 3.8 / 4.4 | 1 | (answered from the eyes' shot) |
| click-search-type | 2 | 3.1 / 3.9 | 3.1 / 3.9 | 3.1 / 3.9 | 8.3 / 9.0 | 3 | left_click×2 browser_type×2 |
| scroll-down | 2 | 4.1 / 8.0 | 4.1 / 8.0 | 4.1 / 8.0 | 11.4 / 14.5 | 3 | scroll×2 screenshot×2 |
| **all** | 10 | **4.1 / 11.6** | **4.1 / 11.6** | **4.1 / 11.6** | **9.9 / 16.1** | 3 | 2 |

Seconds after the delegation, median / p95. Model step gap 3.2 s median / 7.6 s
p95 / 10.4 s max (n=24); tool round trip 1 ms median (canned hands); rollovers 0;
wiki-bootstrap calls 0; no-such-file 0; narration before the first tool 0/10; timed
out 0. Reflex path (reflexes on): open-safari done in 3 ms (action @2 ms),
scroll-down 4 ms (@1 ms); "search the wiki for design" matched a new grammar row
whose engine handler was mid-edit ("did not apply … the brain takes it") and went to
the model (13.8 s, `search_files` on ~/repos/Kevin-Wiki-v3). Reasoned: the first
action now sits at the model's first generation (3–4.5 s medians), the p95s are the
generation's own variance (7.6–11.6 s), and every acting command still spends 1–2
generations verifying and summarising after the action (done − first action ≈ 5–7 s).

### 3d. Speech end → delegation

Live's own transcription and decision time sits in front of every number above.
Measured on 4 of 51 delegations only (0.4, 0.6, 1.2, 1.6 s) because the triggering
utterance was closed by `finalizeOpen` without a `final` emission and never reached
the ledger. Fixed in this change: `finalizeOpen` emits `final` for each item it
closes (`packages/live/src/transcript.ts`), and every delegation now carries
`timings.speechEndAt` — not measurable before this change (4 of 51 delegations had their triggering utterance on the ledger); every `delegation.finished` row now carries it, so after a day of use the medians of `delegatedAt − speechEndAt` and `firstActionAt − speechEndAt` are the end-to-end numbers Kevin asked for.

## 4. Investigated inefficiencies, with the verdict on each

| suspected waste | verdict | measured |
|---|---|---|
| **Inherited wiki bootstrap** (`~/.codex/AGENTS.md` "Start" list → `~/Documents/GitHub/kevin-wiki`, which no longer exists; `npm run status`) | **yes, large** | 22.5 s of the 40.8 s wiki-search delegation dlg_mtxozu93ntp10k; 13 bootstrap-shaped calls over 39 delegations; `npm run status` 2.1 s once; in the harness 1 of 2 wiki searches spent a generation on it |
| **Oversized skill context** (Codex's skills catalog on every fresh thread) | **yes, per fresh thread** | ~8.4k of the 21.6k cold input tokens; "458 additional skills were not included" every turn; no knob in 0.154; the thread's prompt cache hides it while the thread lives — which is why rollovers hurt |
| **Context rollover on a cumulative counter** (`needsFreshThread()` compares Codex's cumulative `total.totalTokens` — 19.4k → 38.8k → 58.2k over three trivial turns — with the 258,400 window) | **yes** | 6 rollovers in 18 warm delegations; 3 in the harness's 10; a fresh thread costs +1.3–5.7 s to the first tool (bridge restart 0.3–0.4 s, `userMessage` 1.25 s vs 0.65 s warm, cache loss); the real per-call context (`last.totalTokens`) was 23–33k = 9–13 % of the window |
| **Tool schemas the model cannot see** (Codex 0.154 does not inline MCP schemas; the model reaches tools through code-mode `exec` with no descriptions or parameter shapes) | **yes; explains the guesses** | `applescript "get name of every application process whose frontmost is true"` 3.9 s where `frontmost_app` is 18 ms; `search_files` with a `(?i)` group `files.ts` rejects (2 of 2 wiki searches, one wasted generation each); `read_focused_text` on Chromium 5/5 failed |
| **Nonexistent-file reads** | **yes, 6** | 6 `read_file` → no such file (+4 `run_shell cat`), all the stale wiki root |
| **Narration before the first action** (the first generation is a sentence, not a tool) | **yes, sometimes** | 4 of 10 harness runs; +1.9–4.7 s to the first tool; in the ledger the first-thought → first-tool gap is 4.4 s median |
| **Verification after acting** (screenshot + `read_focused_text` + retry) | **yes, by design; 2–3 generations** | first action → first verification 3.6 s; verification → done 7.8 s median (both n=8, the simple app-server commands, §3a); both click-and-type harness runs spent 4–6 generations verifying (partly a fake-hands artifact: the canned field never showed the text — the new harness's field does) |
| **The quick-budget pre-warm shot** (1280 px on a 5120-wide display) | **yes, costs a zoom** | unreadable at that size; the model zooms (8 zooms in 39 delegations) |
| Redundant screenshots (the same screen shot twice with nothing between) | **no** | 0 observed |
| Truncated dumps / result caps forcing a re-read | **no** | 0 observed |
| Serial round trips the model could batch | **no** (1 avoidable) | the model already batches its look-only calls; the runner has no lock |
| Narration blocking the tool path | **no** | commentary is fire-and-forget (600 ms coalesce) |
| Tool transport / screenshot capture cost | **no** | 55 ms median round trip; the helper's shot 80–120 ms; 0.4–2.2 % of wall time |
| Jarhead's own prompt size | **no** | ~1.7k tokens of the 21.6k |

## 5. The fixes (this change set)

| item | what changed | files | before → after (measured) |
|---|---|---|---|
| I1 | the rollover judged on the current context (`last.totalTokens`) instead of the cumulative bill; the replacement thread started in the background and primed; a private `CODEX_HOME` (auth.json symlinked, a config.toml with only the model keys, no AGENTS.md, empty skills) plus `skills.include_instructions=false` and the other prompt trims; Jarhead's own `baseInstructions` replacing Codex's (no "preamble message" habit); opt-in per-turn effort for short imperatives | `packages/brain/src/codex-app-server.ts`, `codex-config.ts`, `codex.ts` | rollovers per 10 delegations: 3 → 0 (after run, wire-counted); cold-thread input tokens 22.3k → 10.7k (−52 %, measured with the real model); primed first tool 3.2 s vs 5.2 s unprimed (n=1 each) |
| I2 | standing orders v3.2: act first (the first output is the tool call unless two readings differ materially), verify from results that confirm, one screenshot only when none does, finish at the first verified state; the Codex addendum countermands the inherited preset, states the wiki's real path and carries the tool cheat-sheet the model never sees; `search_files` accepts `(?i)` and is case-insensitive for lowercase patterns; misleading tool descriptions (applescript, focus_app, browser_navigate, type) corrected | `packages/brain/src/brain.ts`, `codex.ts`, `tools.ts`, `files.ts` | narration-first runs: 4/10 → 0/10 (after run); wiki search: 4–6 generations with 2–4 failed calls → 2 generations, 1 `search_files`, 0 failed; bootstrap calls 13 → 0 |
| I3 | the ear was held for the whole session (`earHeld` judged speaking on output-frame arrival; GPT-Live-1 streams silence) — now judged on the transcript or audible frames; the multi-step `search <where> for <what>` reflex through the gated hands with focus checks, site/app guards and hand-over with findings; `read_focused_text` retries with `AXManualAccessibility` in Chromium apps; the quick shot budget 2000 px / 1.1 MP | `packages/brain/src/reflex.ts`, `packages/engine/src/{engine,ear}.ts`, `apps/mac/.../Ear/*.swift`, `packages/hands/native/AX*.swift`, `packages/hands/src/screen.ts` | commands caught without the model: 2/5 → 3/5; "search the wiki for design" on the reflex path: 13.8 s (fell to the brain) → 6 ms typed (canned hands); ear partial → typed 452 ms median; quick shot on the ultrawide 1280×360 → 1978×556 at 66 ms |
| I4 | the benchmark inside the repo (`pnpm jarhead bench --brain`), `DelegationTimings.speechEndAt` / `firstActionAt` in the contract and on every `delegation.finished` row (the done log line reads `speech@… action@…`), `finalizeOpen` emitting `final` so the triggering utterance reaches the ledger | `packages/cli/src/bench-brain.ts`, `packages/protocol/src/index.ts`, `apps/mac/.../Protocol.swift`, `packages/brain/src/delegator.ts`, `packages/engine/src/engine.ts`, `packages/live/src/transcript.ts` | triggering utterance on the ledger: 4/51 → every delegation (test); speech end → action measurable for every delegation from the next pull |

The AFTER table below is the same harness on the same machine (`pnpm jarhead bench --brain --runs 2 --json --out docs/latency/after.json`), diffed against `docs/latency/before-worktree.json`; rollovers are counted off the app-server wire (a turn on a different thread than the previous turn's).

AFTER run: 2026-09-12 03:23 UTC, load average 3.9 / 4.3 / 4.8, `--runs 2`, effort medium, one warm app-server thread, canned hands, real Codex (`docs/latency/after.json`). Before = `docs/latency/before-worktree.json` (same harness, load 8.9, mid-fan-out: I1–I3 partly in). Medians of two runs, seconds after the delegation; "—" = the command needs no action (a question) or was answered without one.

| command (brain path) | 1st tool before → after | 1st action before → after | done before → after | generations before → after |
|---|---|---|---|---|
| wiki-search | 7.7 → 5.9 | 7.7 → — (one `search_files`, no world action) | 13.0 → 9.0 | 3 → 2 |
| open-safari | 6.5 → 3.5 | 6.5 → 3.5 | 11.0 → 5.5 | 2 → 2 |
| whats-on-screen | — | — | 4.1 → 5.1 | 1 → 1 |
| click-search-type | 3.5 → 2.2 | 3.5 → 4.7 | 8.7 → 18.4 (25.6 and 11.2: one run re-verified with a screenshot, `click_element`, `type`, a screenshot — 7 generations) | 3 → 5.5 |
| scroll-down | 6.0 → 4.7 | 6.0 → 4.7 | 13.0 → 12.2 | 3 → 3 |

Overall, brain path (n = 10 delegations): first model tool 4.3 s → 4.5 s median, p95 11.6 s → 6.7 s; first action 4.3 s → 4.5 s median, p95 11.6 s → 5.1 s; done 9.9 s → 9.0 s median, p95 16.1 s → 25.6 s (the one 7-generation click run); generation gap 3.2 s → 3.9 s median (the model, unchanged within noise); rollovers 0 → 0; bootstrap calls 0 → 0 (the private home was already in for the before-worktree sample; the analysts' production baseline had 13). Against the production baseline (§3a): first action 12.5 s / p95 17.5 s → 4.5 s / p95 5.1 s; verified completion 22.1 s / p90 40.7 s → 9.0 s median.

Reflex path (reflexes on, the product path): open-safari 1 ms, scroll-down 1 ms, and **"search the wiki for design" 6 ms** (before-worktree: 13.8 s, it fell to the brain) — the target class is instant when the grammar catches it and the search field is exposed.

Effort A/B (`--effort low`, `docs/latency/after-effort-low.json`, load 3.0): first action 4.7 s median / p95 5.4 s; done 9.5 s; generation gap 4.4 s median — no gain over medium (4.5 / 5.1 / 9.0 / 3.9). Effort is not a lever here; the knob stays opt-in (`JARHEAD_CODEX_SIMPLE_EFFORT`).

## 6. Regression checks

- `pnpm -s typecheck && pnpm -s test` green from the worktree; `swift build
  --package-path apps/mac` for the Protocol mirror.
- The confirmation handshake (`ConfirmationState` / `YES_PATTERN`, `toolset.ts`),
  the secret protections (`policy.ts` never-list, `shell.ts` scrubbing, `codexEnv`),
  the wake gate (`apps/mac/Sources/Jarhead/Wake`), the Stop / Pause / Go transport
  (`engine.ts`) and the verification requirement (a claimed action is verified by a
  tool result or a screenshot before it is reported done) are untouched by I4 and
  covered by their existing tests; `bench --brain`'s stand-in-brain test proves an
  acting tool outside the canned hands is refused at the runner.
- `packages/cli/src/__tests__/bench-brain.test.ts`: the canned screen is a real
  PNG, the canned hands answer what the tools ask, the wire parser and the per-run
  analysis find the right moments (the eyes' shot is not the first model tool; the
  first action is the first acting tool that returned ok — a confirmation question is
  not one; bootstrap and no-such-file counted narrowly; rollovers off the wire's
  thread id, with the app-server's current fresh-thread log line as the fallback;
  model steps / think gaps), a whole run with a stand-in brain produces the report
  with both paths and a near-zero speech end → delegation on every row — no Codex
  turn spent — and without a signed-in Codex the bench refuses before anything
  starts unless `--allow-api-spend` is passed.
- The two copies of `ACTING_TOOLS` (`delegator.ts`, `bench-brain.ts`) are each pinned
  to the same list by their own test (the brain's index does not export the set).
- `packages/live/src/__tests__/transcript.test.ts`: `finalizeOpen` emits `final`
  once for each item it closes; `settle` does not emit it again.
- `packages/engine/src/__tests__/timings.test.ts` and
  `packages/brain/src/__tests__/delegator-timings.test.ts`: `speechEndAt` is the
  triggering utterance's end on the session's start clock, `firstActionAt` is the
  first acting tool that returned ok (a failed click and a look-only tool do not
  stamp it), both ride on the ledger's `delegation.finished` row.
- The `bench --brain` gate is only "no run timed out"; the numbers are read, not
  asserted, because they depend on the model and the machine's load.

## 7. The field, side by side (2026-09-12)

Five research reports on 2026-09-12 (Wispr Flow / Superwhisper / Aqua; Grok; Hermes,
OpenClaw, Operator, Anthropic computer use, Gemini Live; the Mac-native screen
assistants; conversation history across nine products) put numbers next to ours.
They do not all time the same thing, so the second column says what the clock
runs between. **p95 is the headline** where one exists; the field mostly publishes
a median, a p99 or a range, and that is marked. "Measured" means a third party or
this repo's own harness ran a clock; "claimed" means the vendor's page says so.

| product | the clock runs from … to … | **p95** | median / other | measured or claimed | source, date |
|---|---|---:|---|---|---|
| **Jarhead — reflex path** (the 250 ms path, REDESIGN §12) | the ear's partial → the acting op dispatched to the hands, careful window (450 ms) included, real Swift helper | **457 ms** (n = 30) | 455 ms median; prefire kinds (scroll, page) 122 / **126 ms p95**; a final with no window 3 / **6 ms p95** (n = 50) | **measured** — `pnpm jarhead bench`, this Mac | [REDESIGN §12](REDESIGN.md#12-reflexes-and-the-250-ms-path-2026-09-11), 2026-09-11 |
| **Jarhead — model path** (Codex through the app-server) | Live's delegation → the first visible action on the screen (a click, a type, an app in front, a search sent) | **5.1 s** (n = 6) | 4.4 s median; first model tool 4.4 s / 6.7 s p95 (n = 8); verified completion 8.9 s / **25.6 s p95** (n = 10, one 7-generation run); speech end → delegation adds 0.4–1.6 s (n = 4, the ledger) | **measured** — the in-repo harness, real Codex, canned hands, load 3.9 | [`docs/latency/after.json`](latency/after.json), 2026-09-12 03:23 UTC; §5 |
| Wispr Flow (dictation) | key release (the turn ends on the key, not on speech) → the cleaned text pasted | — (p99 **< 700 ms** claimed: the vendor's target, budgeted ASR < 200 ms + LLM < 200 ms + network 200 ms) | reviewers: "closer to 1 to 2 seconds" felt (Spokenly, a competitor, 2026-05); "a brief delay" (Proser, 2026-08-01) | **claimed** — the vendor's own engineering post states the p99 as its target and its infra partner quotes it as met; reviewer numbers are impressions | [Wispr engineering post](https://wisprflow.ai/post/technical-challenges) 2025-09-11; [Baseten customer story](https://www.baseten.co/resources/customers/wispr-flow/) (undated, ~2025); [Spokenly review](https://spokenly.app/blog/wispr-flow-review) 2026-05; [Proser](https://zackproser.com/blog/wisprflow-review) 2026-08-01 |
| Aqua Voice (dictation, Instant mode) | key release → text in the field | — | **~450 ms** "after you stop"; start-up < 200 ms | **claimed** (vendor's llms.txt) | [aquavoice.com/llms.txt](https://aquavoice.com/llms.txt), updated 2026-08-16 |
| Grok Voice Think Fast 2.0 (speech-to-speech) | end of the user's turn → first audio back (no action) | — | **0.70 s** time-to-first-audio; reviewer 300–500 ms perceived end to end | vendor claim, **corroborated** by an independent index (0.70 s) | [x.ai](https://x.ai/news/grok-voice-think-fast-2) 2026-07-29; [Artificial Analysis](https://artificialanalysis.ai/speech-to-speech) read 2026-09-12 |
| GPT-Live-1 (Jarhead's own voice) | last frame of the user's speech → first audible frame of the reply (an early "let me check that" counts); and speech during the reply → the reply stops | — (p90 **1.21 s**) | **1.11 s median** response (1,105 ms / P90 1,209 ms; n = 30 per condition, artificial mouth, iPhone 13, the ChatGPT app in launch week, 2026-07-09); stop on barge-in ~1.4 s, about 0.5 s slower to yield than Advanced Voice; the vendor's own turn-taking figure 0.798 s | **measured** by a third party (Agora). Two of the research reports read the same post as 1.1 / 1.2 s and as 1.3 / 1.4 s; the page re-read on 2026-09-12 says 1,105 / 1,209 ms. The 0.798 s is claimed | [Agora](https://www.agora.io/en/blog/openai-didnt-publish-gpt-lives-latency-so-we-measured-it/) 2026-07-10, re-read 2026-09-12; [unite.ai on the API launch](https://www.unite.ai/openais-gpt-live-1-arrives-in-the-api-at-0-05-per-minute/) 2026-09-10 |
| Gemini Live API | end of the user's turn → first packet / audible reply; and barge-in → the model stops | — | 300–500 ms end to end, 200–400 ms first packet; interrupt round trip 200–500 ms while the model keeps talking | **measured** by developers, no percentiles | [eastondev](https://eastondev.com/blog/en/posts/ai/20260227-gemini-live-api-tutorial/) 2026-02-27; [Google Cloud community](https://medium.com/google-cloud/why-your-voice-bot-feels-robotic-and-how-gemini-live-fixes-it-05c7a4d5355a) |
| Perplexity Computer / Personal Computer (browser control) | one action → the next: screenshot up, remote model, mouse or keyboard back | — | **2–5 s per action** cycle, processing remote | reviewer range | [fazm.ai](https://fazm.ai/blog/perplexity-computer-browser-control) 2026-04-06 |
| Operator / ChatGPT agent / Atlas, Claude computer use, Claude in Chrome (screenshot-loop agents) | a whole errand | — | Atlas: 10 min for three Amazon items, 16 min for flights; Claude in Chrome: "tasks that take you seconds can take Claude minutes"; Claude on the Mac: ~50 % success over 12 operations; Operator: 38.1 % OSWorld, 13 nuisance errors per 100 tasks unmitigated | reviewers and the vendor's system card; no per-action clock published | [Futurism](https://futurism.com/artificial-intelligence/openai-atlas-web-browser-messy) 2025-10-23; [aitoolanalysis](https://aitoolanalysis.com/claude-in-chrome-review/) 2026-03-04; [jock.pl](https://thoughts.jock.pl/p/claude-cowork-dispatch-computer-use-honest-agent-review-2026) 2026-03-24; [Operator system card](https://cdn.openai.com/operator_system_card.pdf) 2025-01-23 |
| Hermes Agent, CLI voice (chained STT → LLM → TTS) | speech → the reply's audio | — | **3.0 s of silence** before the turn even ends, then STT 0.5–2 s (Groq / OpenAI), then TTS 1–2 s | vendor docs (design numbers) | [voice-mode doc](https://hermes-agent.nousresearch.com/docs/user-guide/features/voice-mode); [tts doc](https://hermes-agent.nousresearch.com/docs/user-guide/features/tts), 2026 |

**What is measured versus claimed.** Both Jarhead rows are measured by this repo's
own harness on this Mac and read from the ledger (§2, §5): nearest-rank p95 over
small n (6–50), so a single slow run moves them; the reflex row is like-for-like
with the dictation tools (speech → an effect on the screen) and is faster than any
published dictation figure, claimed or felt; the model path row stops at an
*action*, which no dictation timer and no voice-model TTFA includes at all. Wispr's
"< 700 ms p99" is the vendor's own target from its engineering post, quoted by its
infrastructure partner as met, and the only p99 in the table; every reviewer who
used the product reports one to two seconds.
Grok's 0.70 s is a vendor number an independent index reproduced. GPT-Live-1's 1.1 s
is the one third-party measurement with percentiles, and it is our own voice: it is
the floor under every spoken reply Jarhead gives. The agent rows are the only
products doing what the model path does — acting on a screen — and they publish no
per-action clock at all; the 2–5 s per action and the minutes per errand are what
reviewers saw, and they are the honest comparison for our 5.1 s p95 to the first
action and 8.9 s median to a verified finish.

## 8. What remains (the bottlenecks no plumbing removes)

- **The model's per-generation latency**: 3.4 s median / 5.9 s p90 per generation
  at effort medium on gpt-6-astra through the app-server; 1.8–3.1 s for a warm
  no-tool turn. A one-generation action is therefore ~3–4 s after the delegation at
  best, ~4–5 s after speech end — the top of Kevin's 2–5 s window, met only when the
  first generation is the action. The "< 2 s per tool use" target is not reachable
  on this transport for anything that needs the model; it is met by the reflex path.
- **Speech end → delegation**: Live's own transcription and decision, 0.4–1.6 s
  (n=4). Not Jarhead's to shorten; now measured on every delegation.
- **Codex 0.154's context**: the skills catalog and the missing tool schemas have no
  knob; a fresh thread pays them every time, so the rollover policy is the lever.
- **Verification**: a claimed action must be verified before it is reported done;
  one generation (a `read_focused_text` or a quick shot) is the floor.

## 9. Honest assessment

**2–5 s to a visible action after Kevin stops speaking — met at the top of the
window on the model path, met outright on the reflex path.** On the brain path the
first action lands 4.5 s after the delegation (median, p95 5.1 s, n = 6, load ≈ 4,
canned hands); Live adds 0.4–1.6 s from speech end to delegation, so the spoken-word
number is about 5–6 s — the edge of the window, not inside it, and the whole of it is
one model generation (3.9 s median between consecutive tools, 6.0 s p95) plus ~0.7 s
of hand-off. Nothing in Jarhead's plumbing remains on that path: turn/start is
acknowledged in 5 ms, the model has the task in 0.65 s, tools answer in 1–55 ms. On
the reflex path — "open safari", "scroll down", and now "search the wiki for design"
when a search field is exposed — the action lands in milliseconds after the ear's
450 ms careful window (ear partial → typed 452 ms median), well inside the window.
Compared with production before this change (first action 12.5 s median / 17.5 s
p90, verified completion 22.1 s / 40.7 s), the model path is roughly three times
faster to act and twice as fast to finish, and the wiki search no longer detours
through a bootstrap that does not exist.

**Tool uses under 2 s — met for the tool, not for the model's decision between
tools.** Every tool round trip is under 2 s (55 ms median in production, 211 ms
p95; applescript queries that took 3.9 s are steered to the millisecond tools),
but the model spends 3.9 s median between one tool result and the next call, and
effort low does not change that (4.4 s). No prompt or transport change shortens a
generation on gpt-6-astra through the app-server; the levers left are fewer
generations (this change cut the wiki search from 4–6 to 2 and removed the
narration generation in 10 of 10 runs, though one click-and-type run still spent 7
on re-verification), more reflexes for the phrases Kevin says most, or a faster
model tier on the Codex side.

**What is measured vs. reasoned.** The after numbers come from the in-repo harness
with canned hands (the model plans against a real screenshot fixture; clicks and
typing succeed instantly), so completion times understate the real Mac by the tool
time (tens of ms) and overstate nothing. Speech end → first action on Kevin's real
sessions is now stamped on every `delegation.finished` row (`speechEndAt`,
`firstActionAt`); after a day of use, `pnpm jarhead ledger` medians of
`firstActionAt − speechEndAt` are the number this report could not measure before
(only 4 of 51 delegations had their triggering utterance on the ledger). The reflex
path's focus checks and the private Codex home's auth.json write-through are
verified by tests and reasoning, not on a live session (no paid session was opened).

**Next lever, in order:** (1) run a day and read the ledger; (2) if the
click-and-type re-verification recurs, tighten rule 3's "one screenshot" to "none
when the result confirms" for `browser_type`; (3) more reflex grammar for Kevin's
own top phrases (the ear now reaches the engine); (4) a faster Codex model tier if
one is offered for the ChatGPT plan.

## 10. The speed levers of the threads pass, and how to measure each (2026-09-13)

The floor did not move — one generation is still 3.8 s median in the harness (§5) and
4.4–5.0 s in production, and effort / tier measured as no gain (§4) — so the threads pass
cuts GENERATIONS and lets several lines of work run at once. Each lever below names the
number it promises and the command that reads it back. Numbers marked **measured** come
from the ledger or a bench run on this Mac; the rest are the targets the levers were
built to and stay **reasoned** until a day of use is read back with `pnpm jarhead ledger
--speed`.

| lever | what it removes | promise | how to measure |
|---|---|---|---|
| observation line (`Settings.observe`, default on) | the verifying screenshot after 45 % of acting steps (**measured**, 85/189 on 09-10..12) and the 5.3 s median generation that reads it | acting step → screenshot ≤ 15 %; ≥ 95 % of acting results carry `now:`; generations per command p95 ≤ 4 (from 7) | `pnpm jarhead bench --brain --runs 5 --compare docs/latency/after.json` (rows `verificationShots`, `observedResults`, `generationsPerCommand`; `--observe off` is the A/B); after a day: `pnpm jarhead ledger --speed --days 1` |
| composite look (`ScreenStateCache` into `notes[0]`) | the look-first generation on 15 of ~93 tool tasks (**measured**) and coordinate clicks where a label exists | first action, brain path, ≤ 4.0 s median in the harness (from 4.4) | `bench --brain` row "1st action" (report it apart from the product-mix number) |
| SplitHands | reads queued behind a `type` (≥ 8 ms per grapheme) or an `open_app` (up to 30 s) on the one serial helper; read p95 370 ms in production (**measured**, n=58) | a read during a 2 s type < 20 ms; read-only round trip p95 ≤ 80 ms | `pnpm jarhead bench --runs 20` rows "read during a type" and "tool round trip (frontmost_app)"; `ledger --speed` "tool round trip, read-only" |
| acting serializer | racy parallel acts inside one generation; queued acts running after a needs-confirmation | reads overlap, acts in order, halted acts answer "not run: … waiting for Kevin's answer" | engine tests `observe` / `serializer` (invariants I1–I7); no production number — it is a correctness lever |
| reflex tail + rows | 0 of 119 requests parsed (**measured**): fillers at the head, ≥ 9-word clauses at the tail | each hit removes ≥ 1 generation (4.5–14 s wall) | `pnpm jarhead reflex-miss --days 7` weekly; `bench` "ear" rows unchanged (122 / 455 ms) |
| thread verbs from the table | "what is spotify doing" superseding the running turn at ≥ 2 generations | 0 generations, engine cost ≤ 5 ms, running turn untouched; "stop the slack one" stops one | `pnpm jarhead bench --fake-hands` rows "status reflex" and "targeted stop" |
| warm brain pool (`Settings.warmThreads` 2) | the second thread's cold boot inside `runJob` (0.6–2.9 s; 555 / 1048 ms for the two spares ever logged, **measured**) | the first two thread starts return in < 5 ms; the third awaits its boot as `starting` | daemon.log "spare ready" ×2 after wake; `brain-pool` tests |

What the bench measured on this Mac with fake hands and the stand-in brain the day the rows
landed (`pnpm jarhead bench --fake-hands --runs 3`, load ≈ 4): the numbers in the run log
below this section's commit — read them as the BEFORE for SplitHands and the observer, since
the engine wiring lands after the rows. Rows that need the threads engine (status reflex,
targeted stop) report "not measured" until `thread_start` is admitted; the bench says so
instead of failing.

The two honest caveats stand from §9: the brain-path-only first action cannot go under one
generation plus ~0.65 s of hand-off (≈ 3.6–4.3 s), so the ≤ 3.0 s median target is a
product-mix number (reflex tails + replay + brain path) and must be reported as such; and
the observation's 150 ms settle can read "nothing changed" before a page load lands — the
`<N> ms after` suffix and the `--observe off` A/B are the guards, and `browser_navigate` is
the first tool to drop it if the model starts double-acting.
