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

## State

Working and verified live: voice out, voice in, three answer sources, web research,
the "make it recurring" loop, `jarvisd` actually running those automations
(bucket-idempotent, re-tick returns []), screen vision, accessibility-first
pointing with a vision fallback, and the Electron overlay driven over IPC.

Built and tested but never run for real: `@jarvis/selfmod`.

230 tests. `pnpm run check` is clean. Measured: perceived (ack) p50 9ms, real
answer audio p50 1330ms. The real answer is still LLM-TTFT-bound; the ack is what
makes it feel instant.

## Things that cost real time to learn

- ffmpeg **hangs forever** without the Microphone grant; it never errors. Every
  AV subprocess needs a startup timeout.
- `size=` in ffmpeg stderr means audio is flowing, NOT that someone spoke.
  `silence_end` is the speech signal. Conflating them ran every silent recording
  to its max duration.
- STT echoes its own priming prompt back as a transcript on silence. Gate on
  energy before spending the call, and reject prompt-shaped replies.
- **cliclick reads a leading sign as RELATIVE.** `m:1000,-500` means "y minus
  500". Kevin's displays sit above the primary one (menu bar at y=-2160), so
  negative absolute coordinates are normal here — this silently walked the cursor
  to y=-379279. Anything negative goes through CGEvent.
- System Events lists processes WITHOUT the Accessibility grant but refuses every
  useful query, so probing the process list proves nothing.
- Chromium AX trees are effectively unreadable: Claude times out at 6s, Chrome
  needs 4.3s for 104 mostly-untitled elements. Fetch properties in bulk (one
  Apple Event per sibling list), cap hard, and treat a timeout as an ordinary
  empty result rather than an error.
- `qmd search --format files` returns CSV rows, not paths. The collection is
  rooted at `<wiki>/wiki`, not the repo root.
- briefd writes to `generated/runtime/brief`; the newest projection is months stale.
- Node readline silently drops piped lines when no question is pending.
- Electron's `setIgnoreMouseEvents` forward option is Windows-only.
- `pnpm run check` is a wrapper — SIGKILL on it orphans tsc/tsx. Spawn detached
  and kill the process group.
- The ack must be chosen from INTENT (a pure keyword match) before context
  gathering, not from the route source afterwards. Keying it on the route put the
  ack at 1153ms, after a 1103ms qmd search — masking nothing.
- A timeout is not evidence an action did not happen. `pressElement` must not
  retry by coordinates after an AX press times out, or it presses twice.
