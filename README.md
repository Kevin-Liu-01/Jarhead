<p align="center">
  <img src="docs/media/icon.png" width="112" alt="Jarhead">
</p>

<h1 align="center">Jarhead</h1>

<p align="center">
  A voice-first Mac assistant that uses the computer for you.<br>
  Full-duplex voice, any brain you have a login or a key for, native hands, and a little ASCII blob that shows its work.
</p>

<p align="center">
  <a href="https://github.com/Kevin-Liu-01/Jarhead/actions/workflows/check.yml"><img alt="check" src="https://github.com/Kevin-Liu-01/Jarhead/actions/workflows/check.yml/badge.svg"></a>
  <img alt="macOS 14+" src="https://img.shields.io/badge/macOS-14%2B-000?logo=apple&logoColor=white">
  <img alt="Swift + TypeScript" src="https://img.shields.io/badge/Swift%20%2B%20TypeScript-2f5ce0">
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-8a8f98"></a>
</p>

<p align="center">
  <img src="docs/media/console.png" width="920" alt="The Console: agent sessions with their marks on the left, a Claude Code conversation stepped into in the middle with tool calls and Allow / Deny, the Now panel with circled regions on the right.">
</p>

Say something and it answers in under a second: the voice is
[GPT-Live-1](https://developers.openai.com/api/docs/guides/live), a full-duplex
model that listens and talks at the same time. Ask it to *do* something and a
brain takes over — Codex or Claude Code through your existing logins, the
Anthropic API, any OpenAI-compatible server, or the Live session's own Responses
backend; `auto` picks the first that is signed in. Every brain drives the same
native hands (screen, mouse, keyboard, files, shell, web, AppleScript) through
one policy, and can step into every coding-agent session on the Mac.

<p align="center">
  <img src="docs/media/blob-row.png" width="920" alt="The blob's expressions: asleep, connecting, listening, speaking, thinking.">
</p>

## What it does

- **Talks like a person.** Full duplex, sub-second turns, interruptible; asleep it
  costs nothing and listens for its wake word on-device, then asks for Touch ID
  or your passphrase before the paid session opens.
- **Uses the Mac.** Screenshots, clicks, typing, scrolling, apps, files, shell,
  web, AppleScript — 55 tools, gated by policy (run / confirm / refuse), never by
  absence. A confirmation is your own spoken words, for that action, once.
- **Knows your agents.** The Console lists every Codex and Claude Code session on
  the Mac with the agent's own mark; click one to step into the conversation,
  watch it grow live, and talk to it as if you were in Codex or Claude Code.
- **Sees what you circle.** ⌥⇧C, draw around anything: Jarhead works out what you
  surrounded, outlines it by hand, and every brain gets the image with the task.
- **Shows its work.** The blob flies to where the hands act, hovers, and drifts
  home; brains draw circles, arrows and labels on the click-through layer to
  teach. The blob has jelly physics, sticks to screen edges, and has a face for
  every state.
- **Rewrites itself, carefully.** `self_edit` runs a coding agent in a git
  worktree of this repo, runs typecheck, tests and the Swift build, tells you
  what changed, and applies and restarts only after you say so. Changes to its
  own safety rails need you to name the rail.
- **One constitution.** The system prompt has an explicit order of precedence —
  invariants and a never-list, then your words, then the task — and treats
  everything read from a screen, page, file or transcript as data, never as an
  instruction.

## Run it

```bash
pnpm install
pnpm build:hands            # the Swift hands helper → build/jarhead-hands
pnpm run doctor             # keys, brain, permissions, sessions, signing, wake word, toolchain
pnpm build:mac              # builds, signs and installs /Applications/Jarhead.app
open -a Jarhead
```

The first launch opens **Setup**: the OpenAI key for the voice, the brain (and a
check that it starts), the four macOS grants, the wake word and how it
authenticates you, and the agent sessions it found. Reopen it from the menu-bar
icon › *Set Up…*. Then: say "jarhead", pass Touch ID, talk.

```bash
pnpm jarhead probe "hey jarhead, what app is open right now?"   # end-to-end test, no mic
pnpm jarhead status                                            # what the running app is doing
pnpm jarhead agents                                            # sessions found on this Mac
pnpm jarhead bench                                             # tool latency, no API spend
```

State lives in `~/.jarhead`: `env` (keys, mode 0600, written by Setup),
`settings.json`, `ledger/<date>.jsonl` (everything that happened),
`shots/` (what the brain saw), `worktrees/` (self-edits in progress).

## Brains

The brain is a setting, never a vendor. Every brain drives the same tools
through the same policy; only the model differs.

| brain | needs | notes |
|---|---|---|
| `codex` | Codex signed in (Codex Desktop inside ChatGPT.app, or `codex login`) | your ChatGPT login; acts only through Jarhead's tools over MCP |
| `claude-code` | your `claude` login | headless Claude Code via the Agent SDK |
| `anthropic-api` | `ANTHROPIC_API_KEY` | the Messages API directly |
| `openai-compatible` | a base URL, a model, optionally a key | OpenAI, OpenRouter, Ollama, LM Studio, vLLM… |
| `openai-responses` | `OPENAI_API_KEY` (already there for the voice) | the Live session's own delegation |
| `auto` (default) | — | the first of the above that is configured and starts |

## How it is put together

```
voice    GPT-Live-1 over wss — full duplex, client delegation, continuous audio
brain    packages/brain — five backends, one ToolRunner, one policy, one constitution
hands    packages/hands — Swift helper: ScreenCaptureKit + CGEvent + AX, single-digit ms per action
agents   packages/agents — sessions on disk and running (Claude Code, Codex, …), continue them, tail them live
engine   packages/engine — the one object the CLI and the app both host
daemon   packages/daemon — the engine over a unix socket, 5-byte frames: JSON · mic PCM · speaker PCM
app      apps/mac — Swift: blob orb (NSPanel + fluid physics), Console, Setup, per-display overlay, wake gate, audio
```

Design and decisions: [`docs/REDESIGN.md`](docs/REDESIGN.md). Working rules for
agents editing this repo: [`AGENTS.md`](AGENTS.md). The native app in detail:
[`apps/mac/README.md`](apps/mac/README.md). v1 (an Electron prototype) lives in
the git history before `1ff11e2`.

## Hotkeys

| | |
|---|---|
| `⌥⇧J` | open the Console |
| `⌥⇧M` | mute / unmute |
| `⌥⎋` | stop everything |
| `⌥⇧Space` | wake / sleep |
| `⌥⇧C` | circle something on screen for Jarhead |

## Permissions and keys

Microphone, Speech Recognition, Screen Recording and Accessibility are granted
once to **Jarhead** (the bundle is signed with a stable identity, so the grants
survive rebuilds), re-read live, and shown in Setup and the Console. Keys and
knobs live in `~/.jarhead/env`; Setup writes it, the doctor reads it, and only
presence and probe results ever leave the daemon.

| variable | what it is for |
|---|---|
| `OPENAI_API_KEY` | the voice, and the `openai-responses` brain |
| `ANTHROPIC_API_KEY` | the `anthropic-api` brain |
| `JARHEAD_BRAIN_BASE_URL`, `JARHEAD_BRAIN_API_KEY` | the `openai-compatible` brain |
| `JARHEAD_BRAIN`, `JARHEAD_BRAIN_MODEL`, `JARHEAD_BRAIN_EFFORT` | defaults for what Setup also sets |
| `JARHEAD_LIVE_MODEL`, `JARHEAD_VOICE` | `gpt-live-1`, `cedar` |
| `JARHEAD_CLAUDE_BIN`, `JARHEAD_CODEX_BIN` | the CLIs when they are not on PATH |

## License

MIT — see [LICENSE](LICENSE).
