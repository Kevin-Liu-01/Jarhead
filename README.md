# jarvis

A local voice assistant for macOS. Ask it something out loud and hear the answer in
about a second. It can look at your screen, point at things, drive a browser, run
research on a schedule, and — under governance — propose changes to its own code.

Runs on this machine. Inspired by [Clicky](https://github.com/farzaa/clicky),
built on Kevin's brain at `~/repos/kevin-wiki-rebuild`.

## What works

| | |
|---|---|
| Speaks answers | ✅ streaming, sentence-pipelined, mp3 piped to ffplay |
| Hears you | ✅ push-to-talk, silence endpointing, on-device-ready |
| Hacker News | ✅ live, disk-cached 15 min |
| Daily briefing | ✅ from the wiki's briefd projection (and says when it's stale) |
| "What do I know about X" | ✅ BM25 over your private qmd collection |
| Web research | ✅ plain fetch + DDG search, escalates to agent-browser only if needed |
| "Make it recurring" | ✅ contract-validated registration |
| Runs them on a schedule | ✅ `jarvisd`, bucket-idempotent, verified end to end |
| Looks at your screen | ✅ capture → downscale → vision, speaks while looking |
| Points at things | ✅ accessibility-first, vision fallback, real cursor glide |
| Overlay buddy | ✅ Electron, transparent, always-on-top, IPC-driven |
| Rewrites its own code | ⚠️ built and tested; never run against this repo for real |
| Wake word ("hey jarvis") | ⚠️ matches on transcript, not a always-on detector — see below |

230 tests. `pnpm run check` (typecheck + tests + doctor) is clean.

## Try it

```bash
pnpm install
pnpm jarvis permissions                       # three macOS grants; --open to fix
pnpm jarvis ask "what's on hackernews"        # speaks out loud
pnpm jarvis text                              # conversation, typed input
pnpm jarvis                                   # conversation, spoken input
pnpm jarvis see "what's on my screen"         # vision
pnpm jarvis point "the address bar"           # finds it and flies the cursor there
pnpm jarvis web "what is raft consensus"      # research, then answer aloud
pnpm jarvisd                                  # the daemon that runs your automations
pnpm overlay                                  # the on-screen buddy
```

The flagship loop, verbatim from a real run:

```
you: what's on hackernews
jarvis: Muse Glimmer's a new thirty billion parameter model for running AI
        agents locally, getting a ton of discussion...

jarvis: want me to make that a recurring thing?
you: go for it, daily
jarvis: done. whats on hackernews, running daily.
```

...and then, from `jarvisd` on its next tick:

```
ran jarvis-whats-on-hackernews-2026-08-11 [.../2026-08-11] -> completed
```

A forced re-tick returns `[]` — the bucket is spent, so it cannot run twice.

## Measured latency

From `pnpm jarvis bench`, real numbers on this machine, not the plan's estimates:

| stage | p50 | p95 |
|---|---|---|
| route (intent + context) | 0ms | 325ms |
| LLM time-to-first-token | 572ms | 1359ms |
| **first audio out** | **1239ms** | **1866ms** |

Over the 1s target; LLM TTFT dominates. `@jarvis/ack` exists to hide it — a
pre-synthesized acknowledgement plays in ~120ms while the real answer generates —
but it is not yet wired into the turn loop. That's the next latency win.

Three things already bought real time and are worth not regressing:

- **Streaming mp3 into `ffplay`** rather than buffering a file. The Clicky teardown
  found whole-file buffering to be its single biggest latency mistake.
- **Breaking the first chunk at a clause**, not a full stop. A 168-character opener
  was 639ms of dead air.
- **Pre-warming the ElevenLabs TLS connection** during generation, off the critical
  path. A greeting went 1934ms → 842ms.

## Computer use, honestly

Accessibility-first, vision fallback. AX gives exact element frames and survives
layout shifts; vision guesses. But measured here:

- **Claude** — AX tree never answers, times out at 6s
- **Chrome** — 4.3s for 104 mostly-untitled elements

Most of your desktop is Chromium, so the "fallback" is the ordinary path. Vision
asks for coordinates as fractions of the **window**, not the display: a crop is a
smaller image so relative error costs fewer pixels, and remapping through the
window origin handles your above-primary displays for free. Verified — found
Chrome's address bar and glided to `702,-2085`.

A per-app cache means an app with a hopeless AX tree is only asked once.

Every action is classified before it runs: read-only, pre-approvable,
always-confirm, hand-off. Unknown actions are hand-off — it fails closed.
`point` moves the cursor and deliberately does **not** click.

## The wake word compromise

The plan wanted openWakeWord, which is Python + ONNX. You chose TypeScript-only,
so the wake word matches against a transcript instead — one STT call per
utterance rather than a continuously running detector. That is a worse latency
story and it is written down as such rather than hidden. Swapping in a real
detector later only replaces `detect()` in `@jarvis/ears`.

Matching is deliberately forgiving: "hey travis" and "hey jervis" both count,
because they're what actually comes back. It will not fire on "I was telling
Sarah about jarvis yesterday" — the name has to be near the start.

## Self-modification

Built, tested, and never run for real against this repo. The tests are the
deliverable: a changed diff invalidates a prior approval, an approval cannot be
replayed across proposals, a failed `pnpm run check` blocks approval, ambiguous
consent is refusal, and dry-run is the default. Pushing requires a spoken
approval bound to the exact diff digest.

## Layout

```
packages/core          config, env, turn/latency contracts
packages/wiki-bridge   the single seam to kevin-wiki
packages/voice         mic, STT, streaming TTS, sentence splitter, Claude (+vision)
packages/ears          wake word, endpointing, barge-in, always-on listening
packages/answers       HN, brief, wiki memory, intent router
packages/automations   "make it recurring" — contract-validated registrations
packages/daemon        jarvisd: the clock that actually runs them
packages/ack           pre-synthesized acks + earcons to mask model latency
packages/computer      screen capture, accessibility tree, input, policy, selection
packages/browser       plain fetch / agent-browser routing, research
packages/overlay       the Electron buddy, flight choreography, IPC
packages/selfmod       worktree, proposal, gate, exact-hash approval, push
packages/agent         turn loop, latency timeline, vision, pointing, CLI
```

## macOS permissions

Three grants, all currently granted here. Each fails in its own confusing way, so
`pnpm jarvis permissions` probes them by attempting the real operation:

| grant | without it |
|---|---|
| Microphone | ffmpeg **hangs forever** — it does not error |
| Screen Recording | `screencapture` prints "could not create image from display" |
| Accessibility | System Events still lists processes but refuses every useful query |

That last one is why the probe queries a window's UI elements rather than the
process list — the process list succeeds without the grant and will convince you
accessibility works when it does not.

## Configuration

Copy `.env.example` → `.env.local`. Shell env wins over the file.

| var | required | notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Haiku 4.5 for voice and vision |
| `ELEVENLABS_API_KEY` | yes | streaming TTS — free tier is 10k chars/month |
| `ELEVENLABS_VOICE_ID` | yes | `pnpm jarvis voices` to change it |
| `OPENAI_API_KEY` | mic only | STT; macOS 26 on-device is the M1 target |
| `KEVIN_WIKI_ROOT` | yes | defaults to `~/repos/kevin-wiki-rebuild` |

## How the wiki is consumed

Standalone repo that **links** packages out of the wiki checkout rather than
vendoring copies. Those packages export raw `./src/index.ts` with no build step,
and `contracts` resolves its JSON schemas relative to its own directory via
`import.meta.url` — copying `src/` breaks schema resolution, linking the directory
does not. Automation registrations are validated against the wiki's real
`scheduler-registration-registry` contract.

Voice-created automations land in `~/.jarvis/`, **not** in the wiki's
`schedulers/registrations.json`: that worktree is shared, and direct-writing it
bypasses the `SCHEDULE_BINDINGS` gate its own ops hub warns about.

What is deliberately *not* bridged, and why, is in `packages/wiki-bridge/src/index.ts`.

## Known limits

- **Electron cannot do per-region click-through on macOS.**
  `setIgnoreMouseEvents(true, {forward: true})`'s forward option is Windows-only.
  This is the concrete thing that argues for a native shell if the overlay ever
  needs to be both see-through and interactive at once.
- **Screenshots go to the API.** `see` and the vision fallback upload a frame of
  your screen. Whatever is on it goes too.
- **The ack bank is built but unwired**, so first-audio latency is still LLM-bound.
- **Semantic search is unusable here** (qmd vsearch: ~7s + a Metal compile error),
  so memory answers are BM25 over a manually-indexed collection.

Plan and milestones: `DECISION.md`. Read `DECISION-AMENDMENTS.md` first — it
overrides the plan where they disagree, including two of its recommendations you
overrode and one claim it got wrong.
