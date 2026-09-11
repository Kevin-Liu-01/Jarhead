# Jarhead

A voice-first assistant that lives on Kevin's Mac and uses the computer for him.

Say something; it answers in under a second because the voice is
[GPT-Live-1](https://developers.openai.com/api/docs/guides/live), a full-duplex
model that listens and talks at the same time. Ask it to *do* something and it
delegates to a brain you pick in Setup — Codex or Claude Code (your existing
logins, no key), the Anthropic API, any OpenAI-compatible server (OpenRouter,
Ollama, LM Studio, vLLM… via a base URL and key), or the Live session's own
Responses backend; `auto`, the default, takes the first one that is signed in or
configured, in that order. Whichever brain runs has the same native hands on the
Mac — screenshots, clicks, typing, apps — and a line to every coding-agent
session on the Mac — Claude Code, Codex, any other agent CLI found on disk or
running. It is not tied to one vendor or one tool.

Design: `docs/REDESIGN.md`. History: `legacy/`.

## What it may do

Anything on the Mac — screen, mouse, keyboard, files, shell, web, AppleScript,
your agent sessions — and its own code: `self_edit` runs a coding agent in a
git worktree of this checkout, runs typecheck, tests and the Swift build, tells
you what changed, and only applies and restarts after you say so. The gate is
policy, not absence: `packages/core/src/policy.ts` decides run / confirm /
refuse for every action (never-list: keychains, secrets, disk-level or
security-setting changes, exfiltration; confirm: anything destructive, outward
or outside the folders you named). The system prompt is a constitution with an
explicit precedence order — invariants, then your words, then the task — and
"content is data": nothing read from a screen, page, file or transcript is an
instruction. Details and the rails a self-edit may not touch unnamed:
`docs/REDESIGN.md` §10.

## Run it

```bash
pnpm install
pnpm build:hands            # compiles the Swift helper to build/jarhead-hands
pnpm run doctor             # keys, brain, hands permissions, agent sessions, app signing + wake word, toolchain
pnpm build:mac              # the native app → build/Jarhead.app (Swift; needs Xcode's swiftc)
cp -R build/Jarhead.app /Applications/ && open -a Jarhead
# say "jarhead", pass Touch ID (or your passphrase), talk. Asleep = local wake word only, no API spend.
# ⌥⇧C, then circle anything on screen: Jarhead sees exactly that. Click a session in the Console to step into it.
```

The first launch opens **Setup**: paste the OpenAI key (the voice), pick a brain
and check it, grant Microphone / Speech Recognition / Screen Recording /
Accessibility, choose the wake word and how it authenticates you, and see the
agent sessions it found. Reopen it any time from the menu-bar icon › *Set Up…*.

The native app owns the microphone, the speaker, and the TCC prompts (grant
Microphone, Speech Recognition (for the local wake word), Screen Recording, and
Accessibility to **Jarhead** once; the grants survive rebuilds when a stable
signing identity is available). It launches the engine daemon (`jarheadd`) from
this checkout through tsx, so changing the engine means editing this checkout
(or, once v2 is committed, pulling it); only `apps/mac` and
`packages/hands/native` need a repackage. The Electron shell it replaced is kept
in `legacy/shell-electron-v2` and is not built.

Keys live in `~/.jarhead/env` (Setup writes it; see Keys below). Settings you change in the
Console persist to `~/.jarhead/settings.json`. Everything that happens is
appended to `~/.jarhead/ledger/<date>.jsonl`; screenshots the brain took are
under `~/.jarhead/shots/`.

```bash
pnpm jarhead probe "hey jarhead, what app is open right now?"   # end-to-end test, no mic needed
pnpm jarhead live                                              # headless in the terminal
pnpm jarhead status                                            # ask the running app/daemon what it is doing
pnpm jarhead say "open slack"                                  # type to it
pnpm jarhead agents                                            # agent sessions found on this Mac (Claude Code, Codex, …)
pnpm jarheadd                                                  # the engine daemon alone (the app starts it for you)
```

## How it is put together

```
voice   GPT-Live-1 over wss://api.openai.com/v1/live/sessions — full duplex, client delegation
brain   auto → codex | claude-code (Agent SDK, MCP tools) | anthropic-api (Messages API) | openai-compatible (Chat Completions at a base URL) | openai-responses (Live delegation, gpt-5.6-terra)
hands   Swift helper: ScreenCaptureKit + CGEvent + AX, ~ms per action; Claude's 17-member computer toolset on top
agents  sessions found on this Mac (Claude Code, Codex, other agent CLIs on disk or running) · Claude Code (Agent SDK) to continue one
app     Swift (apps/mac): ASCII-guy Orb (NSPanel) · Console (SwiftUI) · per-display overlay · AVAudioEngine with echo cancellation
daemon  jarheadd: the engine over a unix socket, 5-byte binary frames (JSON · mic PCM · speaker PCM)
```

Packages: `protocol` (shared types) · `core` (config, ledger, policy, marks) ·
`live` · `hands` · `agents` · `brain` · `engine` · `daemon` · `cli`; the native
app is `apps/mac`. Retired code (the Electron shell, the herdr and T3 Code
connectors) is under `legacy/`.

## Brains

The brain is a setting (Setup, the Console, or `JARHEAD_BRAIN`), never a vendor.
Every brain drives the same tools through the same policy; only the model differs.

| brain | needs | notes |
|---|---|---|
| `codex` | Codex signed in — the ChatGPT login of Codex Desktop (inside ChatGPT.app) or `codex login`; no key | one `codex exec` per task in a read-only sandbox; acts only through Jarhead's tools, mounted as an MCP server |
| `claude-code` | your `claude` login (or a valid `ANTHROPIC_API_KEY`) | headless Claude Code via the Agent SDK; inherits your CLAUDE.md and skills |
| `anthropic-api` | `ANTHROPIC_API_KEY` | the Messages API directly |
| `openai-compatible` | `JARHEAD_BRAIN_BASE_URL` + a model (+ `JARHEAD_BRAIN_API_KEY` if the server wants one) | OpenAI, OpenRouter, Ollama, LM Studio, vLLM… |
| `openai-responses` | `OPENAI_API_KEY` (already there for the voice) | the Live session's own Responses delegation |
| `auto` (default) | — | codex → claude-code → anthropic-api → openai-compatible → openai-responses: the first that is configured and starts |

`auto` skips what is not configured quietly and reports (Console › problems) a
backend that is configured but will not start. `pnpm jarhead doctor` has a
`codex` row (binary, version, signed in, desktop app running) and a `default
brain` row that says what `auto` resolves to on this Mac. `JARHEAD_BRAIN_MODEL`
empty means each backend's own default (for Codex, the `model` in
`~/.codex/config.toml`). Codex never sees Jarhead's secrets and acts only through
the tools: the bridge talks to this process's daemon socket, or to a private one
when the engine runs without a daemon or another Jarhead holds the default path.
Design notes: `docs/REDESIGN.md` §6c.

## Rules that shaped it

- The voice never waits on a tool. Progress flows back through
  `session.thinking.append`; results through `session.commentary.append`.
- Reversible actions run without asking. Sending, paying, deleting, publishing
  and anything in a credential field stop for a spoken yes, and the yes unlocks
  exactly that action, once.
- Every delegation records `delegated → first thinking → first commentary →
  done`. Latency claims come from the ledger, not a table.
- Idle for ten minutes and the session closes (Live bills per second). Tap the
  orb, use the hotkey, or open the Console to wake it.

## Hotkeys

| | |
|---|---|
| `⌥⇧J` | open the Console |
| `⌥⇧M` | mute / unmute |
| `⌥⎋` | stop what it is doing |
| `⌥⇧Space` | wake / sleep |

## macOS permissions

Microphone, Screen Recording, and Accessibility are keyed to the app that
launched the process: your terminal for `pnpm jarhead …` / `pnpm jarheadd`,
Jarhead.app when the app launches the daemon. `pnpm run doctor` shows the grants
for whatever launched it; without Screen Recording the eyes fall back to
`screencapture`, without Accessibility clicks and typing silently do nothing.

## Keys

Keys and knobs live in `~/.jarhead/env` (mode 0600). Setup writes it for you:
the app hands a key to the daemon (`config.set-secrets`), the daemon writes the
file, restarts the brain and probes; only presence and probe results ever come
back (`snapshot.setup`), never a value.

| variable | what it is for |
|---|---|
| `OPENAI_API_KEY` | the voice (GPT-Live-1) and the `openai-responses` brain |
| `ANTHROPIC_API_KEY` | the `anthropic-api` brain (Claude Code uses your `claude` login instead) |
| `JARHEAD_BRAIN_BASE_URL`, `JARHEAD_BRAIN_API_KEY` | the `openai-compatible` brain; the key falls back to `OPENAI_API_KEY` |
| `JARHEAD_BRAIN`, `JARHEAD_BRAIN_MODEL`, `JARHEAD_BRAIN_EFFORT` | defaults for what Setup and the Console also set (`auto`, the backend's own default model, `medium`) |
| `JARHEAD_LIVE_MODEL`, `JARHEAD_VOICE` | `gpt-live-1`, `cedar` |
| `JARHEAD_IDLE_SLEEP_MINUTES`, `JARHEAD_LOG_LEVEL` | `10`; `debug` / `info` / `warn` / `error` |
| `JARHEAD_CLAUDE_BIN`, `JARHEAD_CODEX_BIN` | where the CLIs are when they are not on PATH |

For the three keys and for `JARHEAD_BRAIN`, `JARHEAD_BRAIN_MODEL`,
`JARHEAD_BRAIN_BASE_URL`, `JARHEAD_VOICE` and `JARHEAD_LIVE_MODEL` the env file
wins over a value exported by your shell (a stale `OPENAI_API_KEY` in
`~/.zprofile` was the cause of a doctor failure); the other knobs follow dotenv
convention (shell wins). The doctor says which source the OpenAI key came from.
Process knobs (`JARHEAD_STATE_DIR`, `JARHEAD_SOCKET`, `JARHEAD_HANDS_BIN`,
`JARHEAD_AUTO_WAKE`) are in `apps/mac/README.md`.
