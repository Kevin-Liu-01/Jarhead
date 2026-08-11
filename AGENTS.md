# jarvis — agent index

Local macOS voice + computer-use assistant. Standalone repo; borrows from Kevin's wiki
at `~/repos/kevin-wiki-rebuild` by linking, not copying.

## Boot

1. Read `DECISION-AMENDMENTS.md` — it overrides `DECISION.md` where they disagree.
2. Read `DECISION.md` for architecture, the import manifest, and the M0–M5 plan.
3. Run `pnpm run doctor` and report failures before doing anything else.

## Rules

- **Nothing on the voice path may await a tool call, a file read, or a subprocess.**
  Cache reads under ~20ms are the only exception. This is the design's one hard rule;
  see `packages/core/src/turn.ts` and `DECISION.md` §4.
- All kevin-wiki imports go through `packages/wiki-bridge/src/index.ts`. Never import
  `@kevin-wiki/*` directly from another package — the bridge is the seam that keeps the
  coupling one grep away.
- Never import `@kevin-wiki/cli`'s index as a module; it executes on import. Shell out to
  `pnpm kw`, and never from a live turn (~3s startup).
- Don't edit the wiki checkout from here. It is a shared linked worktree on
  `codex/full-wiki-rebuild`; AGENTS.md there says preserve uncommitted work you did not
  create.
- Latency claims require a measurement, not an argument. `DECISION.md` §4's table is
  targets; M1's exit gate is a 50-utterance run on this hardware.
- Self-modification is governed, not autonomous — worktree → `pnpm run check` → proposal
  → exact-hash approval → push. See `DECISION.md` §7. A standing "yes" is not approval
  for a changed diff.

## Commands

```bash
pnpm run doctor      # keys, wiki link, TCC grants, toolchain
pnpm run typecheck
pnpm run test
pnpm run check       # all three
```

## State — M0 done

Working and measured: streaming TTS out, three answer sources (Hacker News, the
wiki's brief projection, BM25 memory search), intent routing, the
"make it recurring" loop with contract-validated registrations, and a latency
benchmark. 29 tests pass; typecheck and doctor are clean.

Blocked: the microphone. Code is written but macOS has not granted the TCC
prompt to the terminal, and ffmpeg hangs rather than erroring — hence the
4s startup guard in `packages/voice/src/mic.ts`.

Not built: screen capture, pointing/clicking, browser automation, the resident
daemon that ticks automations, self-modification. M1–M5.

Measured on this hardware (`pnpm jarvis bench`, 15 turns): first audio p50
1239ms / p95 1866ms. Over the 1s target; LLM TTFT (p50 572ms) dominates.

## Things that cost real time to learn

- `qmd search --format files` does not return paths. Rows are
  `#colour,score,qmd://collection/path.md,"description"`. The wiki's
  `localSearch` passes them through verbatim.
- The `wiki-rebuild-private` collection is rooted at `<wikiRoot>/wiki`, not the
  repo root.
- briefd writes to `generated/runtime/brief`, and the newest projection on this
  machine is months stale — narration must say so.
- readline drops piped lines when no question is pending, which silently ate
  every scripted run. Hence `packages/agent/src/lines.ts`.
- ffmpeg does not error without the Microphone grant; it hangs forever.
