# jarvis

A local voice assistant for macOS. Ask it something out loud, hear the answer in
about a second, and turn any answer into a recurring automation by saying "go for it."

Runs on this machine. Inspired by [Clicky](https://github.com/farzaa/clicky),
built on Kevin's brain at `~/repos/kevin-wiki-rebuild`.

## Status — M0 works

Voice **out**, three real answer sources, and the recurring-automation loop all
work end to end and are measured. Voice **in** is written but blocked on one
macOS permission click. Nothing sees your screen or clicks anything yet — that
is M3/M4.

| | |
|---|---|
| Speaks answers | ✅ streaming, sentence-pipelined |
| Hacker News | ✅ live, disk-cached 15 min |
| Daily briefing | ✅ from the wiki's briefd projection (and says when it's stale) |
| "What do I know about X" | ✅ BM25 over your private qmd collection |
| "Make it recurring" | ✅ writes a contract-validated registration |
| Microphone | ⚠️ code done, needs the TCC grant — see below |
| Screen / pointing / clicking | ❌ M3–M4 |
| Self-modification | ❌ M5 |

## Try it

```bash
pnpm install
pnpm run doctor                          # keys, wiki link, TCC, toolchain
pnpm jarvis ask "what's on hackernews"   # speaks out loud
pnpm jarvis text                         # conversation, typed input
```

The full flagship loop, verbatim from a real run:

```
you: what's on hackernews
jarvis: Muse Glimmer's a new thirty billion parameter model for running AI
        agents locally, getting a ton of discussion. Mark Zuckerberg's pushing
        Meta back to open source AI while attacking closed competitors...

jarvis: want me to make that a recurring thing?
you: go for it, daily
jarvis: done. whats on hackernews, running daily.
        ~/.jarvis/automations/whats-on-hackernews.md
        ~/.jarvis/automations/registrations.json  (validated against the wiki contract)
```

## Measured latency

Not the plan's estimates — actual numbers from `pnpm jarvis bench`, 15 turns on
this machine:

| stage | p50 | p95 |
|---|---|---|
| route (intent + context) | 0ms | 325ms |
| LLM time-to-first-token | 572ms | 1359ms |
| first speakable chunk ready | 1023ms | 2025ms |
| **first audio out** | **1239ms** | **1866ms** |

Over the 1s target. The LLM's TTFT dominates, and the plan's answer to that —
a pre-synthesized acknowledgement bank plus speculative firing — is M1.

Three things already bought real time and are worth not regressing:

- **Streaming mp3 straight into `ffplay`** instead of buffering a file. The
  Clicky teardown found whole-file buffering to be its biggest latency mistake.
- **Breaking the first chunk at a clause**, not a full stop. A 168-character
  opening sentence was 639ms of dead air; clause-breaking roughly halved it.
- **Pre-warming the ElevenLabs TLS connection** during model generation, off
  the critical path. First audio went 1934ms → 842ms on a greeting.

## The microphone

`pnpm jarvis` (no args) is push-to-talk. It needs the Microphone grant, and
right now **ffmpeg hangs forever** waiting for a TCC prompt that a non-GUI shell
never receives. There's a 4-second startup guard so you get a clear error
instead of a hang, but the fix is a click:

**System Settings → Privacy & Security → Microphone → enable your terminal.**

Then `pnpm jarvis devices` to confirm, and `pnpm jarvis` to talk. STT is OpenAI
`gpt-4o-mini-transcribe` for M0; macOS 26 ships on-device `SpeechAnalyzer`, which
is the M1 target and needs a small Swift helper.

## Layout

```
packages/core          config, env loading, turn/latency contracts
packages/wiki-bridge   the single seam to kevin-wiki — every borrowed import
packages/voice         mic capture, STT, streaming TTS, sentence splitter, Claude
packages/answers       HN, daily brief, wiki memory search, intent router
packages/automations   "make it recurring" — contract-validated registrations
packages/agent         the turn loop, latency timeline, CLI
scripts/doctor.ts      preflight
```

```bash
pnpm run check       # typecheck + 29 tests + doctor
pnpm jarvis bench 3  # measure per-stage latency (add --audio for the TTS leg)
```

## How the wiki is consumed

Standalone repo that **links** packages out of the wiki checkout rather than
vendoring copies:

```jsonc
// packages/wiki-bridge/package.json
"@kevin-wiki/contracts": "link:../../../repos/kevin-wiki-rebuild/packages/contracts"
```

Those packages export raw `./src/index.ts` with no build step, and `contracts`
resolves its JSON schemas relative to its own directory via `import.meta.url`.
Copying `src/` breaks schema resolution; linking the directory does not. All
five bridged packages import cleanly, and automation registrations are validated
against the wiki's real `scheduler-registration-registry` contract.

The cost is a live dependency on that checkout — a **git worktree** on branch
`codex/full-wiki-rebuild`. `checkWikiLink()` runs at startup so a broken wiki
fails loudly instead of silently muting the assistant. What is deliberately
*not* bridged, and why, is documented in `packages/wiki-bridge/src/index.ts`.

## Automations are Jarvis's, not the wiki's

Voice-created automations land in `~/.jarvis/automations/`, not in the wiki's
`schedulers/registrations.json`. Two reasons: the wiki is a shared worktree whose
AGENTS.md says preserve work you did not create, and direct-writing that file
bypasses the `SCHEDULE_BINDINGS` gate its own ops hub warns about. They are still
validated against the real contract, so promoting one later is a file move.

Nothing ticks them yet — that daemon is M1. `pnpm jarvis automations` lists them.

## Configuration

Copy `.env.example` → `.env.local`. Shell env wins over the file.

| var | required | notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Haiku 4.5 on the voice path |
| `ELEVENLABS_API_KEY` | yes | streaming TTS — free tier is 10k chars/month |
| `ELEVENLABS_VOICE_ID` | yes | `pnpm jarvis voices` to change it |
| `OPENAI_API_KEY` | mic only | M0 STT |
| `KEVIN_WIKI_ROOT` | yes | defaults to `~/repos/kevin-wiki-rebuild` |

## Next

**M1** — always-on ears: wake word, on-device STT, the acknowledgement bank and
speculative firing that get first audio under 1s, barge-in, and the resident
daemon that ticks automations. See `DECISION.md` §8; read
`DECISION-AMENDMENTS.md` first, it overrides the plan where they disagree.
