# Automations

Jarhead can set things up while you are talking to it and carry them out later with the agent
asleep: alarms, timers, reminders, routines at a time, watchers on a signal. One object — an
**automation**: `when <trigger> then <actions>` — armed by voice while Jarhead is awake, echoed
back as one line, fired by the daemon from its 1 s tick with **no Live session, no brain turn,
nothing billed**. What it can do asleep is the run tier and nothing else: a chime and one line
on the notch island with Snooze · Done, a banner with the same two buttons, a fixed line through
the Mac's own speaker, an app or https page opened, a file moved into a folder, a shell recipe
you approved once, one key in one named app. The one thing that costs anything — `wake-brain`,
one capped headless brain turn, never the voice — is opted into per row with the cost said out
loud before your yes. Nothing asks at fire time; anything that would have to ask is refused at
set-up. Rows are never deleted.

## 1. Set one up by voice

Awake, say it once:

| you say | Jarhead says back |
|---|---|
| "wake me at seven ten on weekdays" | *Weekdays at 07:10, ring "Wake up, Kevin".* |
| "twelve-minute timer for the pasta" | *In 12:00, ring "pasta".* |
| "remind me at three to call mum" | *At 15:00, say "call mum".* |
| "when Slack quits, remind me to log my hours" | *When Slack quits, say "log your hours".* |
| "open my standup notes at nine on weekdays" | *Weekdays at 09:00, open Notes.* |
| "when a PDF lands in Downloads, file it under Papers and tell me" | *When a PDF lands in Downloads, file it under Papers and chime.* |
| "watch the tests and tell me when they go red" | *Every 60 s run recipe "tests"; when it goes red, chime "tests red".* — asks once |
| "run the backup script every night at eleven" | *Nightly at 23:00, run recipe "backup".* — asks once |
| "at six save whatever's open in Cursor" | *Daily at 18:00, press ⌘S in Cursor.* — asks once |
| "at six give me a rundown of what my agents did" | *Daily at 18:00, wake the brain … — about 2 brain min a fire.* — asks once, cost first |

The line it reads back is the row's `echo`; it is what the Console shows and what `jarhead
automations` prints. Then say night. "What alarms do I have", "snooze that", "skip tomorrow's
alarm", "pause the standup routine", "bin the backup" are the same verbs by voice.

## 2. What fires asleep

| kind | what happens, with the meter at zero |
|---|---|
| alarm | chime (`Hero`) + the island opens pinned with `07:10 · Wake up, Kevin` and **Snooze 10 · Done** in the consent rects; a banner with the same two buttons; re-chimes every 30 s; rings through quiet hours |
| timer | chime (`Glass`) + `pasta · 12:00 is up`, Snooze 5 · Done; while running, `pasta 4:12` on the peek chip / foot / lip pill; `caffeinate -t` holds the Mac awake for it |
| reminder | the local speaker reads the fixed line once; banner; island line |
| routine · open | `open_app` through the toolset (policy `run`), one soft `Pop`; deferred by quiet hours |
| routine · recipe | the recipe on the background lane, scrubbed env, capped, output redacted into the row's detail; a red exit is a `failed` row and a quiet banner |
| routine · press | only if the named app is in front and no password field has focus: the key; else `failed: <app> is not in front` — never a question |
| routine · briefing (`wake-brain`) | one headless brain turn `{steps 25, seconds 120}` on the background lane; its one line (≤ 160 chars, redacted) spoken and shown; the meter stays at zero |
| watcher · folder / download | `file` moves it — never overwrites (`name (2).pdf`), never unlinks, stays inside `~`; chime + `Filed · invoice.pdf → Papers` with Open · Done |
| watcher · app / Mac / display / agent | the app forwards `app.quit`, `mac.wake`, `screen.unlock`, `display.connected` as `system.signal` frames; `agent.status` comes from the registry the engine already polls |

**The whole action vocabulary:** `chime · say · notify · open · file · run-recipe · press ·
wake-brain`. A row carries 1–3 actions in order, at most one acting kind (`open`, `file`,
`run-recipe`, `press`, `wake-brain`). Clauses: `window`, `days`, `once`, `cooldown`, `until`,
`quiet`.

## 3. The island, the banner, the chime

A ring takes the island's Allow/Deny rects for **Snooze · Done** (a 500 ms dead-time after a
kind change closes the mis-press); folded, a bell chip comes first and the lip pill reads `🔔 Wake
up, Kevin · Snooze ⌥⇧S`; tucked, a running timer shows `pasta · 4:12` under the lip. The banner
is a `UNNotificationCategory("jarhead.automation")` with Snooze · Done (Open · Done when the
press carries a target); its buttons land the same row as the island's presses. The chime is an
earcon through the app's `LocalSpeaker` — the wake gate's own instance, so the wake listener
never hears "It's seven ten" as the word. A ring stays up ten minutes; an alarm then self-snoozes
once and the second linger ends it (`unanswered`); anything else counts as Done. `⌥⇧S` snoozes
from anywhere while something rings; the status menu shows `Next · 07:10 Wake up, Kevin` and,
while ringing, the two hot rows.

## 4. What asks once, and what is refused

The policy judges a row **at set-up, once, awake** — `classifyAutomation` in
`packages/core/src/policy.ts`, beside the four classifiers. At fire nobody is asked, so anything
that would be confirm-tier at fire is refused now, not asked now.

| action | armed silently when | asks once (the ordinary handshake) | refused |
|---|---|---|---|
| chime / say / notify | a fixed line of 1–160 chars naming no secret | — | empty; a briefing (> 160: "use wake-brain"); names a secret |
| open | an ordinary app; an https URL the URL gate rates run; a readable path | — | a hands-off app; non-https; a payment or credential host; a secret path |
| file | a `folder.file` / `download.done` trigger; `into` inside `~`, never `~/.jarhead`, never a secret store | — | anything else |
| run-recipe | — | the recipe exists (or its command comes with the row) and the shell gate says **run** on its own; no `open`/`osascript`; `mv`/`cp` carry `-n` | the gate says confirm ("would need a yes when it runs; nobody is there then — notify instead") or refuse |
| press | — | an ordinary app, a key or chord: "`⌘S` will be pressed in Cursor unattended, only while it is in front and no password field has focus" | a hands-off app; a malformed key |
| wake-brain | — | Brain minutes > 0, a prompt ≤ 400 chars, from the main conversation: **the cost line** is the question | Brain minutes 0; empty prompt; a spawned thread arming it |

A kind switched off in Settings › Automations › While asleep is refused, naming the chip and the
nearest safe kind ("run-recipe is not allowed while Jarhead is asleep; a notify or a chime is").
A send, type, click, pay, delete, post, a LaunchAgent or crontab write, a keychain read, a
Shortcut, a Live session: refused with the nearest safe version — "when Slack quits, send my
hours" becomes a notify. The yes for a recipe, a press or a brain wake is spent on that one row:
the transcript reads `grant · none — the yes is spent on this one row; nothing widens`.

## 5. The cost line

Only `wake-brain` spends anything, and only after these words, said by the voice exactly and
recorded on the row as `confirmed.heard`:

> "this wakes the brain — not the voice — while Jarhead is asleep: about **N** brain minute(s) per
> fire on Kevin's plan, up to **M** a day; its one-line answer is spoken by the local speaker /
> shown as a banner"

`N = ceil(budget.seconds / 60)`, `M` = Settings › Automations › Brain minutes (default 5; 0 turns
the kind off for every row). Under a local brain the line says "a model warm-up on this Mac"
instead of "on Kevin's plan". The row wears the `billed` badge; its card reads `≈ 2 brain min per
fire · 3 of 5 today`. Every other kind's card reads `cost · nothing billed`. The daily budget is
recomputed from the ledger at each midnight and at start, so a restart cannot forget spend; a
row over budget is a `failed` row and the `automation.budget` problem, never a question.

## 6. Quiet hours

Settings › Automations › Quiet hours (a Console knob; a tool never writes settings). Inside them
a `chime` or `say` becomes a silent banner and an island line at 0.72 (`quiet hours: shown, not
said`); an acting kind waits until they end (`deferred to 07:00`), unless its next regular
occurrence is sooner, in which case that fire is skipped and counted. Alarms default to
`override` and ring through; the voice says so when it arms one inside them.

## 7. Missed fires, and `Open at login`

The daemon is the app's child and dies about 90 s after the app quits: **nothing fires while
Jarhead is quit.** Nothing here is a launchd agent, a login item the brain installed, or a
`pmset` the daemon ran. When Jarhead comes back — or the Mac wakes; a tick gap over 5 s is the
signal — `resync` decides each due row:

| kind | within its grace | later |
|---|---|---|
| alarm (15 min) · timer (10) · reminder (60) | fires now, the head reads `· 12 min late` | `missed` row, the `automation.missed` problem with **Run now**, a repeater rolls on, a one-shot goes `failed: missed` |
| routine | never late — a 01:00 backup at 09:14 is a surprise, not a routine | skipped and counted (`missed 1`), the next occurrence armed |
| watcher | n/a | the folder listing is re-baselined; files that landed while down are not replayed (a folder is not a queue) |

The one mitigation you press is **Open at login** (Settings › Automations): the app registers
itself with `SMAppService` on your press, so Jarhead and its daemon come back when you log in.
Waking a closed lid needs root: `pnpm jarhead doctor` prints the exact `pmset` line for you to
copy and never runs it. `Run now` is refused unless you are there (a session open, or presence
recent) — it fires so you hear it.

## 8. CLI

```
pnpm jarhead automations [list] [--state armed|snoozed|deferred|paused|fired|failed|done|trashed|all]
    automations 6 (5 armed · 1 paused) · next 07:10 Wake up, Kevin (in 6 h) · ringing: —
    ⏰ Wake up, Kevin           weekdays 07:10             chime + say          auto_… · next in 6 h
pnpm jarhead automations add "<words>"      the clock ladder, parsed by core's parseWhen without a brain:
    "at 7:10 weekdays chime 'Wake up'" · "in 12m chime pasta" · "weekdays 09:00 open Notes" · "tomorrow 15:00 say 'call mum'"
    free kinds only (chime · say · notify · open); run recipe, press and wake the brain are set up by voice or in the Console,
    where the yes is heard — no flag stands in for it. The policy judges the draft; a refusal comes back as a toast
pnpm jarhead automations snooze <id|name> [--minutes 10] · done · skip · pause · resume · rename <id|name> "<name>"
pnpm jarhead automations run <id|name>      fires it now so you hear it — refused unless you are there
pnpm jarhead automations trash <id|name> · restore <id>      Move to Trash / Restore. Nothing is deleted
pnpm jarhead recipes [list] · add <name> "<command>" [--cwd DIR] [--timeout 120] · trash <name> · restore <name>
    add prints the shell gate's verdict first; a confirm-tier command saves with `asks` and is never armable
    trash is Move to Trash (the recipe keeps its row with `trashedAt`; list folds it under Trash); restore brings it back
pnpm jarhead status                         … automations 6 (5 armed · 1 paused) · next 07:10 Wake up, Kevin · ringing: —
```

Every verb is one `EngineCommand` over the daemon socket (`automation.set · snooze · done · skip
· pause · resume · rename · trash · restore · run`, `recipe.set · trash · restore`); the daemon owns the
journal and `settings.json`. `automation.set` carries `by: "cli"` from the CLI (the Console sends
none and is stamped `console`; the brain's rows come through its tool as `brain`), so
`createdBy.by` on the row and the ledger's `automation.set` say where each row came from. A name is looked up case-insensitively, live rows first; an `auto_…`
id passes through even when unlisted, so Restore can name a trashed row.

**One `when` grammar.** Core's `parseWhen` (`packages/core/src/schedule.ts`) is the only parser
of a when-phrase, wherever the row comes from: the voice's tool hands it the phrase, the Console's
Add… form sends the phrase itself as `AutomationDraft.whenPhrase` (its `when` may be left out
then) and the engine parses it at `automation.set`, refusing with `parseWhen`'s own error text as
a toast — never a question, never a second grammar in Swift. The CLI's `add` splits `<when>
<verb> <what>` and hands the when-words to the same `parseWhen` before it opens a socket, so a
malformed phrase is refused with the same words and no daemon round trip. Nothing else parses a
clock phrase.

**Recipes are never deleted.** `recipe.trash` stamps the recipe's `trashedAt` — the row stays in
`settings.json` and in the snapshot, hidden from every picker and refused as a `run-recipe`
target; `recipe.restore` clears it. The ledger carries `recipe.trashed` and `recipe.restored`
rows; the Console's Recipes list and `jarhead recipes` fold trashed recipes under **Trash** with
**Restore** on each.

## 9. doctor — group `automations`

```
automations   enabled          ok    6 set · 5 armed · next 07:10 Wake up, Kevin (in 6 h)
              journal          ok    ~/.jarhead/automations/jobs.ndjson · 6 live · 41 rows
              daemon           warn  nothing fires while Jarhead is quit — Open at login is off      (fix: Settings › Automations › Open at login)
              banners          warn  Notifications not granted — the island and the chime still fire     (fix: pnpm jarhead cmd request-permission notifications)
              wake for 07:10   warn  a closed lid sleeps through 07:10 …   (fix: copy (root; never run by Jarhead): sudo pmset repeat wakeorpoweron MTWRF 07:05:00)
              quiet hours      ok    23:00–07:00 · alarms override; chime/say show silently; acting kinds wait
              missed           ok    0 in 7 days                                       warn: 2 missed in 7 days · the Mac slept
              brain budget     ok    wake-brain unused · 0 of 5 min used today          warn: spent — 5 of 5 min used today
              recipes          ok    3 · 2 run-tier · 1 asks (vpn-up: would need a yes when it runs)
              time-sensitive   warn  entitlement absent — alarm banners honour Focus like any banner
              folder grant     warn  watching ~/Downloads needs the Downloads folder grant     (fix: Ask)
```

Every row is advisory. The doctor reads `pmset -g sched` to see whether a wake is already
scheduled and prints the line to copy when none is; it never runs a `pmset` that changes
anything. The recipes row re-judges each recipe with today's shell gate: a command approved last
month that a tighter policy now rates confirm will fail at fire and is never armable until edited.

## 10. What it will never do

- Open the voice session, spend a brain turn without that row's `billed` badge and your yes to
  its cost, or stamp presence: `engine.wake()`, `connect()` and `kevinSpoke()` are never called
  from the executor; the wake-word gate and `JARHEAD_AUTO_WAKE` are not read.
- Ask a question at fire time. A `needs-confirmation` or a hold inside a fire is a `failed` row
  with the reason; no yes is read from a screen, a page, a banner or a flag.
- Send, type, click, pay, delete, post, install, write a LaunchAgent or a crontab, read a
  keychain, run a Shortcut, overwrite or unlink a file, move one out of `~`.
- Delete a row, or a recipe. Move to Trash is a state (`trashed` on a row, `trashedAt` on a
  recipe); Restore undoes it; the journal is append-only and compaction moves the old file to
  `~/.jarhead/trash/automations/`.
- Run `pmset`, `launchctl` or a login-item registration from the daemon. `Open at login` is the
  app registering itself on your press; the `pmset` line is text the doctor prints for you.
- Watch the clipboard, the network, or chain one automation off another — `clipboard.match`,
  `network.changed` and `automation.fired` are reserved words, refused by name until a later pass
  earns them their own TCC story.
