/**
 * The copy deck of design.md §2.2–§2.10, verbatim, as data. Every string names its source:
 * `README:NN` is /Users/kevinliu/jarvis/README.md line NN; other paths are relative to that repo.
 * Nothing rendered by components/sections/* comes from anywhere else.
 */

export interface Shot {
  readonly src: string;
  readonly alt: string;
  readonly width: number;
  readonly height: number;
}
export interface CardCopy {
  readonly h3: string;
  readonly p: string;
  readonly fig?: string;
}
export interface LedgerRow {
  /** the mono index column, e.g. "§ 1" */
  readonly n?: string;
  readonly title: string;
  /** the title set in mono (a brain kind, a command) */
  readonly mono?: boolean;
  readonly p?: string;
  /** the mono figure at the right */
  readonly value?: string;
}
export interface StatTile {
  readonly figure: string;
  readonly unit?: string;
  readonly label: string;
  readonly proof: string;
}
export interface FacePair {
  readonly face: string;
  readonly label: string;
}
export interface SayPair {
  readonly said: string;
  readonly back: string;
}

const MEDIA = "/media";

/* ---------- 01 · Wake (design.md §2.2; facts-product 2.1, 2.2, 2.3, 2.15, 2.20, 2.31) ---------- */
export const WAKE = {
  id: "story",
  h2: "Wake", // README:34
  lead: 'Asleep it listens on-device for free. Awake only after Touch ID. Hearing "jarhead" opens nothing; Touch ID, Apple Watch, the Mac password or a passphrase does.', // README:34, README:341
  shot: {
    src: `${MEDIA}/blob-gate.png`,
    alt: "The wake gate: the blob asks for Touch ID or the passphrase", // README:162-164
    width: 520,
    height: 520,
  } satisfies Shot,
  card: {
    h3: "Wakes on a word, behind Touch ID", // README:34
    p: 'Asleep, the app runs Apple\'s on-device recogniser for "jarhead". Nothing billed. Then Touch ID, Apple Watch, your Mac password or a passphrase. Three misses lock the gate for a minute. Speaker verification is deliberately not attempted; the gate is Touch ID, never your voice.', // README:34, README:341
  } satisfies CardCopy,
  faces: [
    { face: ". .", label: "gate" }, // BlobField.swift:1620-1657 via facts-orb.md §3
    { face: "O O", label: "heard" },
    { face: "^ ^", label: "granted" },
    { face: "> <", label: "denied" },
    { face: "- -", label: "locked" },
  ] satisfies readonly FacePair[],
  cards: [
    {
      h3: "Talks like a person", // README:33
      p: 'GPT-Live-1 listens and speaks at the same time. A spoken "stop" interrupts mid-sentence; the session stays open. About a second to the first word back.', // README:33
      fig: "reply 1.11 s median · 1.21 s p90 · Agora, n = 30, 2026-07-09", // README:321, docs/LATENCY.md:326
    },
    {
      h3: "Twenty-two voices", // README:50
      p: "English, whatever it hears. British by default (Ballad); American or no accent is a setting, heard at the next wake. Every voice is labelled Name · English.", // README:50
      fig: "alloy · ash · ballad · cedar · coral · marin · sage · verse · 14 more", // packages/live/src/events.ts:8-10
    },
    {
      h3: "Other apps keep their sound", // README:348
      p: "Awake, ducking sits at the least macOS allows, only while a voice is present, released the moment Jarhead stops. The microphone is a ranked list with fallback, re-read on route changes.", // README:348, README:62, docs/AUDIO.md:15-26
      fig: "Recording mode shares the mic · ⌥⇧R", // docs/AUDIO.md:25-26
    },
    {
      h3: "One transport", // README:35
      p: "Go · Pause · Stop. Pause and Stop both close the paid session, so the meter stops the moment you press. Go, or the wake word, resumes with the transcript as continuity. Mute keeps the session open.", // README:35, README:526
      fig: "⌥⇧Space go / pause · ⌥⎋ stop · ⌥⇧M mute", // README:427-429
    },
  ] satisfies readonly CardCopy[],
} as const;

/* ---------- 02 · Say (design.md §2.3; facts-product 2.4, 2.5, 2.7, 2.14, 2.18, 2.24, §6.2) ---------- */
export const SAY = {
  id: "say",
  h2: "Tell Ben on Slack I'm late and put on Focus on Spotify.", // README:39
  lead: "Unambiguous commands go straight through the hands in milliseconds. Everything else goes to the brain, and the brain is whatever you already have a login for.", // README:36-38
  brains: [
    { title: "codex", mono: true, p: "Your ChatGPT login, a resident codex app-server thread. No key." }, // docs/REDESIGN.md:270
    { title: "claude-code", mono: true, p: "Headless Claude Code through the Agent SDK, the claude login." }, // docs/REDESIGN.md:271
    { title: "anthropic-api", mono: true, p: "The Messages API tool loop, ANTHROPIC_API_KEY." }, // docs/REDESIGN.md:272
    { title: "openai-compatible", mono: true, p: "Chat Completions at a URL: OpenAI, OpenRouter, vLLM, a hosted server." }, // docs/REDESIGN.md:273
    { title: "openai-responses", mono: true, p: "The Live session's own Responses delegation, only OPENAI_API_KEY." }, // docs/REDESIGN.md:274
    { title: "local", mono: true, p: "Ollama, LM Studio or llama.cpp on this Mac. Explicit only; pick it in Settings." }, // docs/REDESIGN.md:275, docs/LOCAL.md:48
    { title: "auto", mono: true, p: "The first configured kind that starts, in that order. Never local." }, // docs/REDESIGN.md:276, docs/LOCAL.md:48
  ] satisfies readonly LedgerRow[],
  brainsFoot: "Every brain drives the same 71 tools through one runner, so policy, ledger, screenshots and the confirmation handshake are identical whichever model is thinking.", // docs/REDESIGN.md:264-266
  stripHead: "said · read back", // design.md §2.3
  strip: [
    { said: "jarhead", back: "the wake word · then Touch ID" }, // README:16, README:34
    { said: "Search the wiki for design.", back: "a reflex · under a second later the wiki is in front" }, // README:38, docs/DEMO.md:20
    { said: "What is Spotify doing? Stop the Slack one.", back: "answered from the engine's table · no model call" }, // README:39
    { said: "Wake me at seven ten on weekdays.", back: 'Weekdays at 07:10, ring "Wake up, Kevin".' }, // docs/AUTOMATIONS.md:21
    { said: "Twelve-minute timer for the pasta.", back: 'In 12:00, ring "pasta".' }, // docs/AUTOMATIONS.md:22
    { said: "Move today's screenshots to the Trash.", back: "asks first · No. and nothing moves" }, // docs/DEMO.md:25-26
    { said: "Jarhead, make your greeting one word shorter.", back: "a worktree · typecheck, tests, the Swift build · the rails it touched · applies on your yes" }, // README:485-492
    { said: "That's all. Goodnight.", back: "night. · the meter stops, the blob tucks into the notch" }, // docs/DEMO.md:28, README:46
  ] satisfies readonly SayPair[],
  shot: {
    src: `${MEDIA}/console-settings.jpg`,
    alt: "Settings: voice, brain, what leaves the Mac", // README:136
    width: 1600,
    height: 1220,
  } satisfies Shot,
  cards: [
    {
      h3: "Reflexes under the model", // README:38
      p: 'An on-device ear runs beside the voice. Scroll, page, keys, tabs, "open Safari", "click Save", "search the wiki for design", dictation go through the policy-gated hands at once. The model is told afterwards.', // README:38
      fig: "ear final → hands 3 ms median · n = 50 · 2026-09-11", // README:313, docs/LATENCY.md:321
    },
    {
      h3: "The brain is a setting", // README:36
      p: "Codex, Claude Code, an API key, or a model on this Mac. Same tools, same policy, same constitution. Switch in Settings; memory follows.", // README:36
      fig: "6 kinds + auto · pnpm jarhead brain", // README:332, README:391
    },
    {
      h3: "A local brain", // README:36
      p: "Ollama, LM Studio or llama.cpp found on this Mac. Jarhead never pulls, installs, starts or deletes a model. The brain and memory stay here; the voice stays cloud and still bills.", // docs/LOCAL.md:3-5, README:527
      fig: ":11434 · :1234 · :8080 · needs tools · 16k+ context", // docs/LOCAL.md:3-4, 20, 77
    },
    {
      h3: "Remembers you, quietly", // README:49
      p: "After a conversation closes, a small model reads it once and keeps one-sentence items about you in an append-only store. At most 250 tokens a task, 120 a session, never read back to you. Forget hides. Off with one switch.", // README:49, docs/REDESIGN.md:2767
      fig: "preference · fact · episode · procedure · contact · place", // docs/REDESIGN.md:2764-2766
    },
    {
      h3: "One constitution", // README:57
      p: "The standing orders have an explicit precedence: invariants and a never-list, then your words, then the task. Whatever it reads from a screen, page, file or transcript is data. Under 1250 words, versioned, pinned by tests.", // README:57
      fig: "v3.4 · 1225 words", // packages/brain/src/brain.ts:103, brain.test.ts:254
    },
    {
      h3: "Narrates intent", // README:47
      p: 'One clause per state change: "found the invoice", "typing the amount". Per-click lines stay on the Console\'s timeline.', // README:47
      fig: "1 clause / state", // README:47
    },
  ] satisfies readonly CardCopy[],
} as const;

/* ---------- 03 · Threads (design.md §2.4; facts-product 2.8) ---------- */
export const THREADS = {
  id: "threads",
  h2: "Threads", // README:39
  lead: "Several things at once, each a full Jarhead. Spotify on a background lane by Apple events, Slack on the screen lane. Each thread has its own brain, conversation, budget and blob, up to three beside the main one.", // README:39
  island: {
    src: `${MEDIA}/notch-island-working.png`,
    alt: "The island acting: Slack and Spotify tiles, each with a Stop", // README:85
    width: 920,
    height: 500,
  } satisfies Shot,
  islandCard: {
    h3: "Each thread on the island", // README:45
    p: 'A tile per thread with its own Stop. The satellites peek under the island while they work. Ask "what is Spotify doing" or say "stop the Slack one" and the engine\'s table answers with no model call, without ending what you were saying.', // README:39, README:45
  } satisfies CardCopy,
  rail: {
    src: `${MEDIA}/console-threads.jpg`,
    alt: "The Console's Threads rail: Slack asks, Spotify done, Notes done", // README:117-119
    width: 1600,
    height: 1030,
  } satisfies Shot,
  railCard: {
    h3: "The same handshake in every lane", // README:39
    p: "Notes and Spotify on the background lane finish on their own. Slack on the screen lane stops to ask before it sends. Every thread gets the same prompt, memory, screenshots and confirmation handshake as the main one.", // README:117-119, README:39
  } satisfies CardCopy,
  figures: "main + 3 live · 25 steps / 180 s default · 40 / 300 cap · linger 30 s", // README:327
  footnote: "The lease: hand-over after 3 s idle · a taker waits 1.5 s · a thread waits at most 8 s, three waits fail it. Main + 3 is the cap on purpose.", // README:328, docs/DEMO.md:61
} as const;

/* ---------- 04 · Hands (design.md §2.5; facts-product 2.6, 2.9, 2.10, 2.11, 2.12, 2.25) ---------- */
export const HANDS = {
  id: "hands",
  h2: "Hands", // README:37
  face: "> >", // the acting face turned toward its target; BlobField.swift:1593-1600 via facts-orb.md, README:155; design.md §2.5 eyebrow
  lead: "71 tools in ten families. The hands are AX-first: find a control by label, read the focused text, click the element, screenshot only to verify.", // README:37
  chips: [
    "computer · screen, mouse, keyboard", // README:37
    "desktop · apps, windows, controls",
    "browser",
    "agents",
    "threads",
    "shell, progress, memory",
    "system · files, web, AppleScript, clipboard",
    "self-edit",
    "drawing",
    "automations",
  ],
  overlay: {
    src: `${MEDIA}/overlay-shapes.png`,
    alt: "The overlay: arrow, rect, circle, stroke, your own mark, each with a label", // README:181-186
    width: 1600,
    height: 589,
  } satisfies Shot,
  work: {
    h3: "Shows its work", // README:44
    p: "The blob flies to where the hands act and stays where it worked. Brains draw by hand: the blob becomes the pen and drags the line. Jelly drag, sticky walls, momentum.", // README:44
    fig: "tool round trip 55 ms median · 211 ms p95 · screenshot 48 to 75 ms", // README:322-323
  } satisfies CardCopy,
  workShot: {
    src: `${MEDIA}/blob-trace.png`,
    alt: "The blob as the pen: it drew the rectangle around the Deploy button", // README:174-177
    width: 1600,
    height: 1033,
  } satisfies Shot,
  circle: {
    h3: "Sees what you circle", // README:43
    p: "Press ⌥⇧C, draw around anything. The mark snaps to the largest control under it and every brain gets the image with the task. Films of what you circled sit on the island; a used one dims.", // README:43, README:91-94
    fig: "⌥⇧C · 20 s timeout · Esc cancels", // README:430, apps/mac/README.md:286-289
  } satisfies CardCopy,
  circleShot: {
    src: `${MEDIA}/notch-island-marks.png`,
    alt: "Three circled films on the island", // README:91
    width: 920,
    height: 500,
  } satisfies Shot,
  notch: {
    h3: "Lives in the notch", // README:45
    p: "Tucked asleep, peeking awake, an island under the pointer: 420 by 184 points in four bands. Anchor, display, control row, foot. The peek carries glance chips, never sentences. Drag the blob into the notch and it sleeps.", // README:45, README:79-80
  } satisfies CardCopy,
  notchTucked: {
    src: `${MEDIA}/notch-tucked.png`,
    alt: "Tucked, asleep", // README:79
    width: 920,
    height: 270,
  } satisfies Shot,
  notchTuckedCap: "Tucked · asleep · - - · the lip's glow breathes", // README:79
  notchPeek: {
    src: `${MEDIA}/notch-peek.png`,
    alt: "Peeking, awake", // README:80
    width: 920,
    height: 270,
  } satisfies Shot,
  notchPeekCap: "Peek · awake, pointer away · O O · 7.2 min", // README:80
  agents: {
    h3: "Knows your agents", // README:42
    p: "The Console lists every Claude Code, Codex and other coding-agent session on the Mac with its own mark. Step into one, watch it grow live, answer its Allow · Deny, talk to it. Every utterance, tool call and grant is a row in an append-only ledger; the Console shows only what was recorded.", // README:42, README:48, README:344
    fig: "⌥⇧J Console · Now · Settings · Ledger", // README:426
  } satisfies CardCopy,
  consoleDark: {
    src: `${MEDIA}/console-conversation.jpg`,
    alt: "A Claude Code session in the Console, Allow and Deny at the bottom", // apps/mac/README.md:281-285
    width: 1600,
    height: 1030,
  } satisfies Shot,
  consoleLight: {
    src: `${MEDIA}/console-light.jpg`,
    alt: "The Console in the light appearance", // README:149
    width: 1600,
    height: 1030,
  } satisfies Shot,
  consoleCap: "Left, the days fold and the agents group by tool with their own marks. Centre, the Now stream. Right, Now · Settings · Ledger. Rendered by the app's own preview harness over fixed fake data.", // apps/mac/README.md:281-285, README:67-69
  faces: {
    h3: "A face per state", // README:155
    p: "Asleep - -, listening O O, speaking ^ ^, acting o o, paused u u, error x x. The blob and the notch share one face. Expressions change through a 90 ms blink.", // README:155, README:158
  } satisfies CardCopy,
  facesShot: {
    src: `${MEDIA}/blob-eyes.jpg`,
    alt: "One face per state, sixteen expressions", // README:155
    width: 1600,
    height: 1451,
  } satisfies Shot,
  problems: {
    h3: "Names its problems, remedy attached", // README:52
    p: "A permission not granted, a brain that did not answer, a Live buffer full, low disk, a wedged daemon: each is typed and carries its one-tap fix. The daemon answers a ping every 2 s.", // README:52, README:330
    fig: "ping 2 s · two unanswered → reconnect", // README:330
  } satisfies CardCopy,
  problemsShot: {
    src: `${MEDIA}/console-problems.jpg`,
    alt: "Problems with a remedy on each: Ask, Reveal, Retry", // README:139
    width: 1600,
    height: 1360,
  } satisfies Shot,
} as const;

/* ---------- 05 · Rails (design.md §2.6; facts-product 2.16, 2.17, 2.29; README:335-348) ---------- */
export const RAILS = {
  id: "rails",
  h2: "Rails", // README:41
  lead: "One policy table decides run, confirm or refuse per call, with a spoken reason. Send, pay, delete, post and purchase ask every time, in every lane. A confirmation is your own spoken yes, for that action, once.", // README:41, README:337-338
  precedence: "precedence · invariants and the never-list / then your words / then the task", // README:57
  never: {
    label: "NEVER · REFUSED OUTRIGHT, IN EVERY LANE", // README:340
    list: ["mkfs", "diskutil erase", "dd onto a device", "shutdown", "rm -rf / or ~", "resets of other apps' TCC", "every secret store"], // README:340
    line: "Send, pay, delete, post and purchase ask every time. A remembered yes never covers them.", // README:338-339
  },
  rows: [
    { n: "§ 1", title: "Go · Pause · Stop", p: "Pause and Stop close the paid session. The meter stops." }, // README:35
    { n: "§ 2", title: "One policy table", p: "Run, confirm or refuse, per call, with the reason spoken. No tool is special-cased in the runner." }, // README:337
    { n: "§ 3", title: "Destructive verbs ask", p: "Send, pay, delete, post and purchase ask every time." }, // README:338
    { n: "§ 4", title: "A yes is yours, once", p: "Same tool, same arguments, once. Return is never a yes." }, // README:338, JH/AGENTS.md:814
    { n: "§ 5", title: "Scoped grants", p: "A remembered yes covers one conversation, one app, one action class, and never a destructive verb." }, // README:339
    { n: "§ 6", title: "Your hands win", p: "Your key, click or scroll holds Jarhead's hands for 1.5 seconds. A focus change mid-type cancels the type and says how many characters landed." }, // README:40
    { n: "§ 7", title: "The never-list", p: "Disk wipes, dd onto a device, shutdown, rm -rf /, resets of other apps' TCC and every secret store are refused outright." }, // README:340
    { n: "§ 8", title: "Presence gate", p: "The wake word opens nothing. Touch ID does." }, // README:341
    { n: "§ 9", title: "Secrets flow one way", p: "Keys go into a 0600 file. Spawned processes get none; every text result passes a redactor before a model reads it." }, // README:342
    { n: "§ 10", title: "Content is data", p: "Whatever it reads on a screen, page, file or transcript counts as data only." }, // README:343
    { n: "§ 11", title: "Append-only ledger", p: "Every utterance, tool call and grant is a row it cannot rewrite." }, // README:344
    { n: "§ 12", title: "No Delete anywhere", p: "Move to Trash, Archive, Restore. Empty Trash does not exist in the app." }, // README:51, README:344
    { n: "§ 13", title: "Unattended is the run tier", p: "Asleep it chimes, speaks, opens, files. It never opens the voice." }, // README:345
    { n: "§ 14", title: "Self-edits name their rails", p: "A change that touches a rail applies only if you named it." }, // README:346
    { n: "§ 15", title: "The voice path never waits", p: "Speech goes out and comes back as speech, waiting on no tool." }, // README:347
  ] satisfies readonly LedgerRow[],
  asks: {
    src: `${MEDIA}/console-threads.jpg`,
    alt: "Slack asks: send running late to Ben?", // README:117-119
    width: 1600,
    height: 1030,
  } satisfies Shot,
  asksCap: "The screen lane stops to ask before it sends. The background lanes finish on their own.", // README:117-119
  rewrites: {
    h3: "Rewrites itself, carefully", // README:56
    p: '"Jarhead, make your greeting one word shorter." A coding agent runs in a git worktree of the repo, typecheck, tests and the Swift build run, it tells you what changed and which rails it touched, and it applies only after your yes.', // README:56, README:485-492
    fig: "worktree under ~/.jarhead · fifteen minutes per edit · refused while main is dirty", // README:485-492
  } satisfies CardCopy,
  cleanup: {
    h3: "Cleans up without deleting", // README:51
    p: "Conversations Move to Trash, Archive, Restore, Rename, Pin. A move is a tombstone row; whole days move by rename and come back the same way. Retention is a setting whose default is forever.", // README:51, README:333
  } satisfies CardCopy,
  cleanupShot: {
    src: `${MEDIA}/console-cleanup.jpg`,
    alt: "The left rail: Trash open with Restore on each row", // README:140,144
    width: 1600,
    height: 1030,
  } satisfies Shot,
  railsListHead: "self-edit rails", // design.md §2.6 ("the self-edit rails list"); README:346
  railsList: "policy.ts · brain.ts · instructions.ts · the wake gate · selfedit.ts · the runner · the shell and file tools · the confirmation handshake · build signing · the sandbox flags · the Claude Code permission gate · SECRET_KEYS", // README:346
} as const;

/* ---------- 06 · Sleep (design.md §2.7; facts-product 2.13, 2.23; docs/AUTOMATIONS.md) ---------- */
export const SLEEP = {
  id: "sleep",
  h2: "Sleep", // README:46
  lead: '"That\'s all. Goodnight." It says exactly "night.", closes the session, tucks in. Alarms, timers, watchers and routines fire while it sleeps. Nothing billed.', // README:46, README:277-281
  alarm: {
    src: `${MEDIA}/notch-island-alarm.png`,
    alt: "Asleep, ringing: 07:10 Wake up, Kevin. Snooze 10 or Done", // README:274, README:281
    width: 920,
    height: 500,
  } satisfies Shot,
  automations: {
    h3: "Automations that fire asleep", // README:277
    p: 'Say it once while awake: "wake me at seven ten on weekdays", "twelve-minute timer for the pasta", "when a PDF lands in Downloads, file it under Papers and tell me", "run the backup script every night at eleven". It reads one line back. Then say night. The daemon carries it out from its 1 s tick with the agent asleep: no Live session, no brain turn, nothing billed.', // README:277-286
    fig: "alarm · timer · reminder · routine · watcher · actions: chime · say · notify · open · file · run-recipe · press · wake-brain", // docs/AUTOMATIONS.md:38-52
  } satisfies CardCopy,
  refuse: {
    h3: "Refuse at set-up, never ask at fire", // docs/AUTOMATIONS.md:12-13
    p: "The policy judges a row once, awake. Anything that would have to ask at fire time is refused when you set it. A recipe, a press or a brain wake asks once, cost said first. Rows Move to Trash and Restore.", // docs/AUTOMATIONS.md:10-13, 70-72, README:286-290
  } satisfies CardCopy,
  refuseShot: {
    src: `${MEDIA}/console-automations.jpg`,
    alt: "The Automations rail: Clock, Watchers, Trash with Restore", // README:270-275
    width: 1600,
    height: 1030,
  } satisfies Shot,
  cards: [
    {
      h3: "Sleeps when you say so", // README:46
      p: '"Go to sleep", "that\'s all for now", "power down", "good night". Ten idle minutes do the same. "Shut down my Mac" is a task, and it asks.', // README:46, README:326
      fig: "idle sleep 10 min · a setting", // README:326
    },
    {
      h3: "The ring", // README:281
      p: "A chime, the island opens pinned with the line and Snooze 10 · Done where Allow · Deny usually sit, a banner with the same two buttons. It re-chimes every 30 s and rings through quiet hours.", // README:281, docs/AUTOMATIONS.md:40
      fig: "⌥⇧S snoozes from anywhere", // README:432, docs/AUTOMATIONS.md:64
    },
    {
      h3: "Asleep costs nothing", // README:526
      p: "The wake word runs on-device. A closed session costs nothing. Nothing fires while Jarhead is quit; Open at login brings it back. Memory learns only after a conversation closes.", // README:526, docs/AUTOMATIONS.md:116-128, docs/REDESIGN.md:2782
    },
  ] satisfies readonly CardCopy[],
} as const;

/* ---------- Numbers (design.md §2.8; README:305-333; docs/LATENCY.md:259, 321-326) ---------- */
export const NUMBERS = {
  id: "numbers",
  label: "the ledger",
  h2: "Numbers",
  lead: "Measured on the author's Mac and written down; the harnesses are in the repo. Every latency below carries its n and its date.", // README:307-309
  display: "3 ms", // README:313
  displayLine: "ear final → hands dispatch · median · 6 ms p95 · real helper · n = 50 · 2026-09-11", // README:313, docs/LATENCY.md:321
  tiles: [
    { figure: "126", unit: "ms", label: "ear partial to dispatch, prefire kinds, p95", proof: "122 ms median · scroll, page, screenshot, circle · includes the 120 ms window · 2026-09-11" }, // README:314
    { figure: "457", unit: "ms", label: "careful kinds, p95", proof: "455 ms median · keys, edits, type, click · includes the 450 ms window · n = 30 · 2026-09-11" }, // README:315
    { figure: "1.11", unit: "s", label: "GPT-Live-1 reply, median", proof: "1.21 s p90 · third party, Agora · n = 30 per condition · 2026-07-09" }, // README:321
    { figure: "4.4", unit: "s", label: "delegation to first visible action, median", proof: "5.1 s p95 · Codex through the app-server · canned hands · n = 6 · 2026-09-12" }, // README:317
    { figure: "8.9", unit: "s", label: "delegation to verified completion, median", proof: "25.6 s p95 · n = 10 · 2026-09-12" }, // README:318
    { figure: "55", unit: "ms", label: "tool round trip, median", proof: "211 ms p95 · production ledger" }, // README:322
    { figure: "48–75", unit: "ms", label: "screenshot, warm full display", proof: "ScreenCaptureKit" }, // README:323
    { figure: "10.7", unit: "k", label: "input tokens on a cold Codex thread", proof: "from 22.3k · −52 % · the private home and Jarhead's base prompt" }, // README:324
    { figure: "$0.05", label: "a minute of open session", proof: "per second, muted or not · a closed session costs nothing" }, // README:325
    { figure: "71", label: "tools in ten families", proof: "16 permissions, 7 required · 6 brains + auto" }, // README:332
    { figure: "1225", label: "words in the standing orders", proof: "v3.4 · under 1250 · pinned by tests" }, // README:57, brain.test.ts:254
    { figure: "3", label: "live threads beside the main one", proof: "25 steps / 180 s default · 40 / 300 cap · linger 30 s" }, // README:327
    { figure: "1.5", unit: "s", label: "your key, click or scroll holds the helper", proof: "busy for 1500 ms · your hands win" }, // README:329
    { figure: "2", unit: "s", label: "liveness ping", proof: "two unanswered · drop, reconnect, kick" }, // README:330
    { figure: "90", unit: "s", label: "the daemon lingers after a crash", proof: "relaunch ≤ 3 in 10 min · the Codex thread stays warm" }, // README:331
    { figure: "10", unit: "min", label: "idle sleep", proof: "without an addressed turn · a setting" }, // README:326
  ] satisfies readonly StatTile[],
  rows: [
    { title: "pnpm jarhead bench gate", mono: true, value: "p95 ≤ 250 ms for finals and prefire partials, ≤ 580 ms for careful partials, else exit 1" }, // README:316
    { title: "one model generation (gpt-6-astra, the floor under the model path)", value: "3.8 s median · 6.0 s p95 (n = 24); 3.4 s median · 5.9 s p90 over 35 controlled generations before it" }, // README:319
    { title: "speech end → delegation (Live's own transcription and decision, n = 4)", value: "0.4 to 1.6 s" }, // README:320
    { title: "delegation → first visible action, before", value: "12.5 s median · 17.5 s p90 in production" }, // README:317
    { title: "delegation → verified completion, before", value: "22.1 s · 40.7 s p90" }, // README:318
    { title: "the lease", value: "hand-over after 3 s idle · a taker waits 1.5 s · a thread waits ≤ 8 s, three waits fail it" }, // README:328
    { title: "retention", value: "ledger forever (default) · screenshots 14 days · disk preflight 500 MB" }, // README:333
    { title: "crash", value: "relaunch ≤ 3 in 10 min · daemon lingers 90 s" }, // README:331
    { title: "sources", value: "docs/LATENCY.md · docs/REDESIGN.md §12 · §13 · §16 · §20 · docs/latency/after.json · packages/hands/native/README.md" }, // README:309
  ] satisfies readonly LedgerRow[],
  footnote: "Reflex rows: pnpm jarhead bench on the author's Mac, 2026-09-11; n = 50 for finals, n = 30 for the careful window. Model-path rows: the in-repo harness, real Codex, canned hands, 2026-09-12; n = 6 for first action, n = 10 for completion. GPT-Live-1: Agora, third party, n = 30 per condition, 2026-07-09. The model path is seconds; the reflex path is milliseconds.", // docs/LATENCY.md:259, 321-326; RELEASE "Known limits"
} as const;

/* ---------- Costs (design.md §2.9; README:60, 325, 526-529; docs/REDESIGN.md:2767) ---------- */
export const COSTS = {
  id: "costs",
  label: "what it bills",
  h2: "Costs",
  lead: "$0.05 a minute, billed per second, only while a session is open. The meter is on the capsule, the island and the Console.", // README:325, README:60
  display: "$0.05 / min", // README:325
  displayLine: "per second of open session, muted or not · $3 an hour of talking", // README:325, README:526
  rows: [
    { title: "The voice", p: "GPT-Live-1. Pause and Stop close the session; Mute does not.", value: "$0.05 / min" }, // README:325, README:526
    { title: "Asleep", p: "The wake word runs on-device.", value: "nothing" }, // README:526
    { title: "Paused or stopped", p: "The session is closed.", value: "nothing" }, // README:35
    { title: "codex", mono: true, p: "Your ChatGPT plan.", value: "no API dollars" }, // README:527
    { title: "claude-code", mono: true, p: "Your Claude login.", value: "no API dollars" }, // README:527
    { title: "anthropic-api · openai-compatible · openai-responses", mono: true, p: "Each on its own key.", value: "their own APIs" }, // README:527
    { title: "local", mono: true, p: "Ollama, LM Studio or llama.cpp. The voice still bills.", value: "nothing" }, // README:527, docs/LOCAL.md:4
    { title: "Memory", p: "A cap: about 20k tokens a day at 80 delegations, on the brain's plan.", value: "≈ 20k tokens / day" }, // README:528
    { title: "Benchmarks", p: "pnpm jarhead bench spends nothing by default.", value: "nothing" }, // README:529
  ] satisfies readonly LedgerRow[],
  shot: {
    src: `${MEDIA}/console-ledger.jpg`,
    alt: "The Ledger tab: a day's sessions, utterances, delegations, billed", // README:135
    width: 1600,
    height: 1030,
  } satisfies Shot,
  shotCap: "The Ledger tab totals each day: sessions · utterances · delegations · billed. 17.0 min · $0.85 on the harness's fixed data.", // README:135, README:60
} as const;

/* ---------- Made (design.md §2.10; facts-product 2.19, 2.26, 2.28, 2.30, 2.33; RELEASE) ---------- */
export const MADE = {
  id: "made",
  label: "how it is made",
  h2: "Made",
  lead: "Three processes over a unix socket: Jarhead.app in Swift, jarheadd in TypeScript, jarhead-hands as two Swift helpers, focus and background. The app spawns the daemon or attaches to one already running; the daemon outlives the app.", // README:213-250
  dithered: {
    h3: "Dithered, down to the Dock icon", // README:59, README:209
    p: "Flat fills stay flat. Anything that shades, the island, the blob's halo, the Dock icon, the Console grounds, the meters, is banded and dithered by one renderer, the classic 8×8 Bayer matrix in point-sized cells. Loading states are dither glyphs. Respects Reduce Motion.", // README:59, README:209
  } satisfies CardCopy,
  icons: {
    src: `${MEDIA}/icon-sizes.png`,
    alt: "The Dock icon at 16, 32, 64, 128 and 256", // README:206
    width: 640,
    height: 584,
  } satisfies Shot,
  cards: [
    {
      h3: "One Jarhead", // README:55
      p: "pnpm build:mac installs in place with rsync. The running app keeps its inodes, the Dock pin keeps its bookmark and, signed with a real identity, TCC keeps its grants.", // README:55
      fig: "pnpm jarhead dock audits · --fix repairs", // README:386
    },
    {
      h3: "A clean Codex home", // README:61
      p: "Codex runs from a private CODEX_HOME under ~/.jarhead with Jarhead's own base instructions, so no stray AGENTS.md steers it.", // README:61
      fig: "cold thread 22.3k → 10.7k input tokens · −52 %", // README:324
    },
    {
      h3: "Comes back from a crash", // README:53
      p: "A report with the backtrace, phase and last 40 log lines lands in ~/.jarhead/crashes/, the app relaunches, and the daemon lingers 90 s with the Codex thread warm.", // README:53
      fig: "relaunch ≤ 3 in 10 min", // README:331
    },
    {
      h3: "The Console and its kit", // RELEASE "The Console and its kit"
      p: "One component kit for tooltips, dropdowns, fields, toggles and rows; one dither renderer for everything that shades. Days fold in the left rail; closed conversations show a grey orb. Search the ledger from the rail.", // RELEASE "The Console and its kit", README:48
    },
  ] satisfies readonly CardCopy[],
  homes: {
    h3: "Two homes", // README:136
    p: "The notch, or a capsule beside the blob in free mode: the meter, what it heard and said, the running step, Go · Mute · Stop · Console. Settings › Session › Home.", // README:136, console-settings.jpg, blob-capsule.png
    fig: "Home Free · Notch", // console-settings.jpg
  } satisfies CardCopy,
} as const;
