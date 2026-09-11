# Amendments to the decision doc

`DECISION.md` is the output of a 12-agent research workflow (Fable 5, ~1.25M tokens,
2026-08-10). It is kept verbatim because its evidence is good. But Kevin overrode two
of its recommendations, and I verified one of its load-bearing claims to be **wrong**.
Where this file and `DECISION.md` disagree, **this file wins**.

## 1. Repo location — OVERRIDDEN, and the doc's argument is refuted

`DECISION.md` §9.1 calls building inside `~/repos/kevin-wiki-rebuild` "mandatory anyway,
since packages export raw `./src/index.ts` and contracts' schemas resolve relative to src."

**That inference is wrong.** The premise is right; the conclusion doesn't follow.
`@kevin-wiki/contracts` resolves schemas from `import.meta.url` → its own
`packages/contracts/schemas/` directory. That path travels with the *package directory*.
It breaks if you **copy** `src/`; it works fine if you **link** the directory.

Verified from this standalone repo on 2026-08-10 — all five bridged packages import,
and `assertContract("scheduler-registration-registry", {})` located and parsed its schema
file, failing only on payload validation (the correct behavior for an empty object):

```
✔ @kevin-wiki/contracts          4 exports
✔ @kevin-wiki/store              7 exports
✔ @kevin-wiki/artifact-store     1 exports
✔ @kevin-wiki/automation-runtime 2 exports
✔ @kevin-wiki/local-search       2 exports
```

**Decision:** standalone `~/jarvis`, consuming the wiki via pnpm `link:` deps declared in
`packages/wiki-bridge/package.json`. No vendoring, no copies.

The doc's *real* cost — risk 5, "coupling uptime to a live rebuild repo" — still stands
and is not solved by this. The wiki checkout is a **linked git worktree** on branch
`codex/full-wiki-rebuild`; a mid-rebase tree there can still mute Jarvis. Mitigation:
`checkWikiLink()` runs at startup and every bridged import is funnelled through
`packages/wiki-bridge/src/index.ts`, so the blast radius is one file.

## 2. Shell — OVERRIDDEN for now, revisit at M3

`DECISION.md` §1 argues Swift over Electron/Tauri "no hedging," and its reasoning is
sound: Electron's forward-click-through is Windows-only, and AXUIElement +
ScreenCaptureKit + `setVoiceProcessingEnabled` are native-only.

Kevin chose **all-TypeScript**. This is not actually a conflict yet — the doc's own build
plan makes **M0 pure TypeScript with zero Swift**, and M0–M2 (voice loop, memory, the
recurring-automation loop) need no native code at all. The fork only becomes real at
**M3**, when the overlay has to point at a button without stealing focus.

**Decision:** build M0–M2 in TypeScript. Treat M3's shell as an open question to settle
with a measurement, not an argument — see §9 below. Nothing in M0–M2 should assume the
answer; that is what the `jarvisd` unix-socket seam is for.

## 3. On-device STT is now the default, not a fallback

`DECISION.md` §9.6 frames cloud STT as an accuracy fallback. Machine check says this
box makes local STT the obvious primary, and there is no STT vendor key:

| | |
|---|---|
| macOS | 26.4 → Apple `SpeechAnalyzer`/`SpeechTranscriber` available on-device |
| CPU / RAM | 18 cores / 128 GB |
| Keys on hand | Anthropic ✔, ElevenLabs ✔, STT vendor ✘ |

**Decision:** on-device STT, no cloud STT key. Revisit only on a measured accuracy
failure, per the doc's own advice.

## 4. Scope of this scaffold

Kevin asked for **plan + scaffold, no feature logic**. What exists is repo, workspace,
config, the wiki bridge, and permissions plumbing. There is no voice loop, no model call,
no overlay. `pnpm run doctor` and `pnpm run typecheck` both pass.

## 5. Corrections to the doc's evidence

- §9.1's "mandatory" claim — refuted above.
- The wiki checkout is a **linked worktree** (`.git` is a file containing `gitdir:`),
  which the doc doesn't mention and which breaks naive `.git/HEAD` reads.
- Unrelated but found en route: the global `~/.claude/CLAUDE.md` points every session at
  `~/Documents/GitHub/kevin-wiki`, **which does not exist**. The live checkout is
  `~/repos/kevin-wiki-rebuild`. Those bootstrap steps have been silently no-oping.
- `npm run status` in the wiki prints its summary then **exits 1**.

## 6. Still unanswered, and I did not guess

- **Voice.** No `ELEVENLABS_VOICE_ID` is set and the wiki holds no voice assets. Jarvis
  has no voice until Kevin picks or clones one.
- **Wake word.** openWakeWord vs. Porcupine (doc §9.3) — not needed until M1.
- **Hermes reconciliation.** Doc §9.4 flags that `jarvisd` would be a second persistent
  operator alongside the Hermes Mac-Mini stack, which `wiki/SOUL.md` warns against.
  Must be settled before M2, and it is a genuine judgment call about Kevin's setup.
- **Apple Developer account.** Only matters if M3 goes native.
