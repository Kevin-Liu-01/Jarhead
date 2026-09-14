# A local brain

Jarhead's brain can be a model on this Mac: Ollama (127.0.0.1:11434), LM Studio (:1234) or
llama.cpp (:8080). The voice stays GPT-Live-1 on the OpenAI key, billed per second as today;
the brain and memory move here. Jarhead never installs, pulls, starts or deletes anything —
when a step is yours, the row prints the command with a Copy button and you run it.

## 1. Install Ollama

| way | command | notes |
|---|---|---|
| the app | ollama.com/download, open `Ollama.app` | a menu-bar item with a settings pane (context slider, network toggle); updates itself; symlinks the `ollama` CLI into `/usr/local/bin` |
| the app, via Homebrew | `brew install --cask ollama-app` | the same app plus an `ollama` binary in `$HOMEBREW_PREFIX/bin` |
| bare CLI as a service | `brew install ollama` then `brew services start ollama` | no menu bar, no settings pane; environment goes in the launchd plist or the shell |

`curl -s localhost:11434/api/version` answers `{"version":"0.34.x"}` when it is up.

## 2. Pull a model that can call tools

Jarhead needs `tools` among the capabilities `ollama show` reports; a chat-only model is greyed in
the picker and refused as the brain. The suggestion by RAM — what `suggestedPull` prints and what
the empty-list row offers to copy:

| this Mac's RAM | pull | size |
|---|---|---|
| ≤ 8 GB | `ollama pull qwen3.5:4b` | 3.4 GB |
| ≤ 16 GB | `ollama pull qwen3.5:9b` | 6.6 GB |
| ≤ 32 GB | `ollama pull qwen3.5:27b` | 17 GB |
| ≤ 64 GB | `ollama pull qwen3.5:35b` | 24 GB |
| > 64 GB | `ollama pull qwen3.5:27b` — the fast default; the doctor names `gemma4:31b` and `gpt-oss:120b` as alternatives | 17 GB |

For memory matching on the Mac as well: `ollama pull embeddinggemma` (~300 MB). Without an
embedding model, memory matches by keywords — still nothing leaves for memory.

`pnpm jarhead models` lists what is pulled: id · size · trained context · tools / vision /
thinking / embedding · fit against this Mac's RAM · which the brain and memory use. Cloud tags
(`:cloud`, `remote_host` set) are listed dimmed and never offered: they run on ollama.com.

## 3. Pick it

Console › Settings › Brain › Backend → **Local model**. The Model menu's first entry is *best fit*:
Jarhead chooses (fit good > tools + vision > newest pull > smaller) and reports the pick in the
Status line and in `setup.local.picked`; it never writes the id into `settings.json`. Click a
model once to pin it. The Server row shows only when two servers answer (or when
`JARHEAD_BRAIN_BASE_URL` / `brainBaseUrl` pins one); there is no Key row. From a terminal:
`pnpm jarhead brain local [<model>] [--server URL]`; `pnpm jarhead brain auto` puts it back.

`auto` never picks `local`: a server another project left running is not a choice you made.

## 4. What leaves the Mac

Settings › Leaves the Mac and the `privacy` group of `pnpm jarhead doctor` print the same four
rows, from one function (`dataPaths()` in `@jarhead/core`):

| row | where | detail |
|---|---|---|
| voice | cloud | OpenAI gpt-live-1 — every word heard and said; billed per second of open session |
| brain | mac | qwen3.5:27b on Ollama 0.34.0 — nothing leaves (`lan` when the pinned root is not loopback) |
| memory | mac | embeddings embeddinggemma 768 dims · extractor qwen3.5:27b — nothing leaves (or keywords) |
| web | cloud | the sites you ask for (web_fetch, web_search) |

Memory follows the *setting*, not the running brain: if the local server is down and the brain
falls back to OpenAI, the brain row turns cloud and says so; item text and closed conversations
still never go to OpenAI while `brain` is `local`.

## 5. The context trap — why 64k, and why the native route

Jarhead's system prompt and tool table are ~11k tokens before the task begins. Ollama's default
window depends on the Mac's memory — 4k under 24 GB, 32k to 48 GB, 256k above — so a 4k default
silently drops the front of every prompt, and a 256k default on a 128 GB Mac builds a KV cache of
tens of gigabytes for a 27B model. Ollama's OpenAI-compatibility page says it plainly: "The OpenAI
API does not have a way of setting the context size for a model." That is why Jarhead talks to
Ollama over the native `POST /api/chat` and sends `options.num_ctx` on every request: the model's
trained maximum clamped to 65 536 (`LOCAL_NUM_CTX_MAX` — Codex's own guidance for agentic use is
at least 64k; more only grows the cache), `num_predict` 4 096 so a looping model stops,
`truncate: false` so an overflow is a sentence rather than a silent cut, and `think` from
Settings › Effort for thinking models. Below 16k (`LOCAL_NUM_CTX_MIN`) the brain runs but the
Console says to pick a larger model, and tool groups are dropped in a fixed order (draw → browser →
thread) when system + tools would take more than 35 % of the window. LM Studio and llama.cpp set
their windows when the model loads (§8, §9); Jarhead cannot change those per request.

## 6. Keep-alive, wake and sleep

Ollama unloads a model five minutes after the last request by default. Jarhead sends
`keep_alive: 30m` on every turn, preloads at wake (`POST /api/generate {model, keep_alive}` with no
prompt — the documented preload) and unloads at sleep (`keep_alive: 0`), so a 17 GB model does not
sit in memory while Jarhead is in the notch. The first turn after a cold load pays `load_duration`:
Jarhead waits up to 180 s for the first chunk cold, 45 s warm, and 60 s between chunks.

## 7. Threads and `OLLAMA_NUM_PARALLEL`

Ollama serves `OLLAMA_NUM_PARALLEL` requests at once (default 1) and forces 1 for the qwen3.5 and
nemotron families whatever you set. A thread's request therefore queues behind the main brain's;
the scheduler's caps are the brake, and a thread's `secondsCap` is its brain's wall clock. Jarhead
never sets `OLLAMA_NUM_PARALLEL` or `OLLAMA_CONTEXT_LENGTH` for you: it sends `num_ctx` per request
and never edits another app's environment.

## 8. LM Studio

Start the server (the Developer tab, or `lms server start`); Jarhead finds it on :1234 through
`GET /api/v0/models` and talks Chat Completions. Pick a model with the hammer badge (native tool
use: Qwen, Llama 3.x, Mistral…); one without it 400s on the first turn and the Console says
`cannot call tools; pick a model with the tools badge`. If the server wants a token, put
`JARHEAD_BRAIN_API_KEY=…` in `~/.jarhead/env` (Settings › Keys writes it); `OPENAI_API_KEY` is never
sent to a local server. Sizes and fit read `unknown` — LM Studio does not report bytes.

## 9. llama.cpp

`llama-server -m model.gguf --jinja -c 65536` — `--jinja` for tool calling, `-c` for the window
(fixed at launch), `--mmproj` for vision. Found on :8080 through `GET /health`; one model per
process, so the picker has one entry.

## 10. What the Console prints, and what to do

| line | do |
|---|---|
| `Local brain: nothing answers on this Mac (127.0.0.1:11434, :1234, :8080). Open Ollama, or install it — see docs/LOCAL.md.` | open `Ollama.app` or `brew services start ollama`; the row clears within 60 s on its own |
| `Local brain: Ollama 0.34.0 is up but nothing on it can call tools. In a terminal: ollama pull qwen3.5:27b (17 GB, fits this Mac).` | Copy, run it, wait for the pull, Retry |
| `Local brain: qwen3.5:27b is not on Ollama 0.34.0 (it has qwen3.5:9b, gemma4:26b). Pull it, or pick another.` | pull it, or pick a listed model |
| `qwen3 is ambiguous here: qwen3:8b, qwen3:32b — pick one` | pick the full tag |
| `qwen3.5:cloud runs on ollama.com, not this Mac; pick a local tag` | a local tag |
| `gemma3:27b cannot call tools; pick a model with the tools badge (pnpm jarhead models)` | a model with tools |
| `Local brain: qwen3.5:4b's window is 8k tokens; Jarhead's tools alone are ~11k. Pick a larger model.` | informational; a larger model |
| `Local brain on 10.0.0.5:11434: leaves this Mac for your network` | informational; you pinned a LAN root |
| `Local brain unavailable (…); using the OpenAI backend instead — until it is back, the brain's work goes to OpenAI too. Memory stays local.` | the loud fallback; fix the server and it heals within 60 s |
| `the local model went quiet for 60 s` | spoken by the delegator; the server stalled — check `~/.ollama/logs/server.log` |
| `the request did not fit qwen3.5:27b's 65536 context; say it in fewer steps` | spoken by the delegator; a smaller ask, or a model with a larger trained window |

Nothing in this file is run by Jarhead. `ollama pull|rm|create|push|cp` and `lms get|import|rm` are
`confirm` in `classifyAction`, so even the brain must pass the confirmation handshake before it
fetches or removes weights.
