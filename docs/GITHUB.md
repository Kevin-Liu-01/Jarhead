# GitHub: description and topics

What the repository page should say. The integrator applies it; nothing here runs on
its own. Read on 2026-09-12 with `gh repo view Kevin-Liu-01/Jarhead --json
description,repositoryTopics,homepageUrl`: the description below replaces the current
one, the topic list keeps all twelve current topics and adds eight.

## Description (≤ 350 characters)

```
Voice-first Mac assistant that uses the computer for you. GPT-Live-1 full-duplex voice behind an on-device wake word and Touch ID; vendor-neutral brains (Codex, Claude Code, any API); native Swift hands, two at once; a Console into every coding-agent session; a dithered ASCII blob in the notch. Rewrites itself in a worktree, with your yes.
```

Every clause is a shipped feature: the voice (`packages/live`), the wake gate
(`apps/mac/Sources/Jarhead/Wake`), the brains (`packages/brain`, `BrainKind`), the
helper and the two lanes (`packages/hands`, `packages/engine/src/workers.ts`), the
Console's Agents rail (`packages/agents`), the notch island over `UI/Dither.swift`,
and `self_edit` / `self_apply` (`packages/brain/src/selfedit.ts`).

## Homepage

Leave empty. There is no site; the README is the page. If a demo recording is
published (docs/DEMO.md is the script), point the homepage at it then.

## Topics (20 — GitHub's maximum)

Kept (the twelve already on the repo):

| topic | why |
|---|---|
| `voice-assistant` | what it is: you talk, it answers and acts |
| `computer-use` | the hands click, type, scroll, read AX and screenshots on the real Mac |
| `macos` | a native macOS 14+ app, arm64 |
| `swift` | the app, the hands helper and the preview harnesses are Swift |
| `typescript` | the engine, brains, daemon and CLI are TypeScript on Node 24 |
| `openai` | GPT-Live-1 is the voice; `openai-responses` and `openai-compatible` are brains |
| `gpt-live` | the specific model and endpoint (`wss://api.openai.com/v1/live/sessions`) |
| `codex` | the default brain: a resident `codex app-server` thread on your ChatGPT login |
| `claude-code` | a brain (headless Agent SDK) and the sessions the Console steps into |
| `mcp` | Jarhead's tools are mounted into Codex as the `jarhead` MCP server |
| `agents` | the Agents rail: every coding-agent session on the Mac, continued live; the `agent_*` tools |
| `accessibility` | the hands are AX-first: `find_element`, `element_at`, `ax_tree`, `read_focused_text` |

Added (eight, each backed by code at bee5cac):

| topic | why |
|---|---|
| `wake-word` | on-device `SFSpeechRecognizer` listens for "jarhead" while asleep; nothing billed, nothing leaves the Mac |
| `speech-recognition` | the same on-device recogniser is the ear that feeds the 250 ms reflex path |
| `anthropic` | the `anthropic-api` brain (Messages API) and the Claude Code brain |
| `swiftui` | the Console and the Setup wizard |
| `appkit` | the blob is an NSPanel with fluid physics; the overlay is one click-through window per display |
| `notch` | the blob's home: tucked asleep, a Dynamic-Island-style island when awake |
| `ascii-art` | the blob is drawn from glyphs, with a face per state (`- -` `O O` `^ ^` `u u` `x x`) |
| `dithering` | every shaded surface is an 8×8 Bayer dither in point-sized cells — island, halo, Dock icon, the Console and Setup grounds, the loading glyphs, the README banner |

Considered and left out: `ollama` / `lm-studio` (supported through `openai-compatible`,
but a topic for each server would be noise), `touch-id` (one step of the wake gate),
`self-improving` (not a term the code uses), `electron` (v1 only, before `1ff11e2`).

## The command

```bash
gh repo edit Kevin-Liu-01/Jarhead \
  --description "Voice-first Mac assistant that uses the computer for you. GPT-Live-1 full-duplex voice behind an on-device wake word and Touch ID; vendor-neutral brains (Codex, Claude Code, any API); native Swift hands, two at once; a Console into every coding-agent session; a dithered ASCII blob in the notch. Rewrites itself in a worktree, with your yes." \
  --add-topic wake-word,speech-recognition,anthropic,swiftui,appkit,notch,ascii-art,dithering
```

`package.json`'s `description` should be brought to the same sentence in the same
change so the two never drift.
