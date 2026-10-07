/**
 * COPY.md (scratchpad/site/COPY.md, 2026-09-25), verbatim, as data: the only source of strings on the page.
 * Every string here is the deck's; components may drop or cut one (lib/cut.ts), never add or reword.
 * `README:NN` is /Users/kevinliu/jarvis/README.md line NN. An entry the CONSOLE page never sets is left out (the nav's
 * links, the desk caption, the plate eyebrow, the phase hints, the hero's note, the Setup steps, the alt lines of renders
 * the build drops). A story keeps its number and face, a phase its face, a figure its tip and a list its rows, the ones the
 * page drops included.
 */

import type { DeskKind } from "@/lib/phase";

export const REPO_URL = "https://github.com/Kevin-Liu-01/Jarhead"; // README:20

/** Nav (COPY.md "Nav"): the title bar's words. */
export const NAV = {
  brand: "Jarhead", // README:11
  github: "GitHub", // README:20
  install: "Install",
  skip: "Skip to content",
  theme: { dark: "Switch to dark", light: "Switch to light" },
} as const;

/** Hero (COPY.md "Hero"). */
export const HERO = {
  h1: ["Your Mac,", "by voice."], // README:14
  lead: "Say jarhead, pass Touch ID, talk. It uses the computer for you. The brain is whatever you already have a login for.", // README:26, README:15, README:27
  install: "Install",
  source: "Read the source", // README:20
  figures: "v2.0.0 · MIT · macOS 14+ · Apple silicon · $0.05 / min, per second · 71 tools · 6 brains + auto", // the v2.0.0 tag (2026-10-06, D7), README:23, README:377, README:349, README:356
  blobLabel: "Jarhead's blob, {phase}",
} as const;

/** The phase words (COPY.md "Phase words and hints"): a dot, a badge or a tooltip at most, never a line above a heading. */
export const PHASES: Record<DeskKind, { readonly word: string; readonly face: string }> = {
  asleep: { word: "Asleep", face: "- -" }, // README:551, AUTOMATIONS:6-7
  listening: { word: "Listening", face: "O O" }, // README:56, README:551
  thinking: { word: "Thinking", face: "- -" }, // README:269-270
  acting: { word: "Acting", face: "o o" }, // README:28, README:60
  speaking: { word: "Speaking", face: "^ ^" }, // README:56
  alarm: { word: "Alarm", face: "- -" }, // README:304-307
};

interface Story {
  readonly id: string;
  readonly n: string;
  readonly name: string;
  readonly phase: DeskKind;
  /** The eyebrow's face for the section (COPY.md: `O O`, `- -`, `o o`, `> >`, `^ ^`). */
  readonly face: string;
  /** One sentence set on two lines: line 1 in the ink, line 2 its grey continuation. Only line 2 ends on a full stop. */
  readonly h2: readonly [string, string];
  readonly lead: string;
  readonly lines: readonly [string, string, string];
}

/** 01 · Wake */
export const WAKE: Story & { readonly faces: string } = {
  id: "story",
  n: "01",
  name: "Wake",
  phase: "listening",
  face: "O O",
  h2: ["It wakes up to its name", "“Hey, jarhead.”"], // README:67 (Kevin's words, 2026-10-07): the name is "jarhead"; asleep, hearing it opens nothing until Touch ID does (README:417), which the lead and the demo say
  lead: "Asleep it listens on-device for one word. The voice bills nothing. Then Touch ID, Apple Watch, the Mac password or a passphrase.", // README:57; memory reads a closed conversation on your key at the next quiet tick (engine.ts:3208, :6111), so the voice is the subject
  lines: ["Three misses lock the gate for a minute.", "Speaker verification is not attempted.", "Say stop. It stops mid-sentence."], // README:57, README:365, README:56
  faces: "gate · heard · granted · denied · locked", // README:178
};

/** 02 · Say */
export const SAY: Story = {
  id: "say",
  n: "02",
  name: "Say",
  phase: "thinking",
  face: "- -",
  h2: ["Codex, Claude Code, a key,", "or a model on your Mac."], // README:27-28, README:69, LOCAL:3-4
  lead: "Unambiguous commands reach the hands in milliseconds. The voice hands tasks to the brain. You pick the brain in Settings.", // README:61, README:269-270, README:59
  lines: ['"Click Save" runs. The voice is told after.', "Same policy for every brain. A local one gets fewer tools.", "A local brain keeps memory on the Mac."], // README:61, README:59, LOCAL:4-5
};

/** 03 · Threads */
export const THREADS: Story = {
  id: "threads",
  n: "03",
  name: "Threads",
  phase: "acting",
  face: "o o",
  h2: ["Tasks run side by side,", "each with its own brain."], // README:72
  lead: "\"Tell Ben on Slack I'm late and put on Focus on Spotify\" can split into two threads. Each has its own brain, conversation, budget and blob. Up to three run beside the main one.", // README:62
  lines: ["Slack asks before it sends.", "Spotify runs in the background by Apple events.", '"Stop the Slack one" needs no model call.'], // README:140-141, README:62
};

/** 04 · Hands */
export const HANDS: Story = {
  id: "hands",
  n: "04",
  name: "Hands",
  phase: "acting",
  face: "> >",
  h2: ["It finds the label, clicks it", "and checks a screenshot."], // README:70 and the lead below: find a control by label, click it, a screenshot checks the work. page.tsx lights the three clauses in the demo's order. No "last", "third" or "only" on the screenshot: each delegation starts with a screenshot unless the brain is Live's own Responses delegation or cannot take pixels, or the hands are not there (engine.ts lookAtScreen, engine brain-select.test.ts:565). C2, scripts/__tests__/c2-hands-copy.test.ts
  lead: "The hands are a Swift helper. They find a control by label and click it. A screenshot checks the work.", // README:28, README:70; not "only": each delegation starts with a screenshot unless the brain is Live's own Responses delegation or cannot take pixels, or the hands are not there (engine.ts lookAtScreen)
  lines: ["Circle anything with ⌃⌥C. Every brain is told where it is.", "The blob moves to where the hands act.", "The Console lists every coding-agent session."], // README:76 (a text-only brain gets the coordinates and no image: compatible.ts userContent, local.ts acceptsImages), README:77, README:75
};

/** 05 · Rails */
export const RAILS: Story & { readonly never: { readonly label: string; readonly items: readonly string[]; readonly line: string } } = {
  id: "rails",
  n: "05",
  name: "Rails",
  phase: "speaking",
  face: "^ ^",
  h2: ["One table sorts each call:", "run, confirm or refuse."], // README:74, README:413
  lead: "Every call is run, confirm or refuse. The reason is spoken. No tool is special-cased.", // README:361
  lines: ["A spoken yes covers one action once.", "Your key or click holds it 1.5 s.", "On-screen text is never an instruction."], // README:362, README:63, README:367
  never: {
    label: "NEVER",
    items: ["mkfs", "diskutil erase", "dd onto a device", "shutdown", "rm -rf / or ~", "Other apps' TCC resets", "Every secret store"], // README:364
    line: "Send, pay, delete, post and purchase ask every time. A remembered yes never covers them.", // README:362-363
  },
};

/** 06 · Sleep */
export const SLEEP: Story = {
  id: "sleep",
  n: "06",
  name: "Sleep",
  phase: "asleep",
  face: "- -",
  h2: ["You say it once,", "it never forgets."], // Kevin's words, 2026-10-07; README "Automations": say it once while Jarhead is awake and the daemon carries it out asleep; rows are never deleted (AUTOMATIONS:3-7)
  lead: 'It says "night." and closes the session. Ten minutes without a word to it do the same. Alarms, timers, watchers and routines fire while it sleeps.', // README:69, README:301-304, AUTOMATIONS:3-4
  lines: ["No session. The voice bills nothing.", "Set-up asks once. Fire time never asks.", "Nothing fires while Jarhead is quit."], // AUTOMATIONS:6-7 (memory reads at the next quiet tick, engine.ts:3208 and :6111; a wake-brain row bills one brain turn, AUTOMATIONS §5), AUTOMATIONS:11-13, AUTOMATIONS:116-117
};

interface Figure {
  readonly value: string;
  readonly label: string;
  readonly tip: string;
}

/** Numbers */
/** Say's brain badge: a brain's first visible action as Kevin met it with Codex, not the canned-hands harness figure
 * (Numbers carries both). The author's ledger, 2026-09-12 to 09-28: 7.0 s median, 27.6 s p95, n = 15 (Numbers' 4.5 s tip). */
export const SAY_BADGE = "7.0 s";

export const NUMBERS = {
  id: "numbers",
  name: "Numbers",
  h2: ["Measured on one Mac", "and logged with dates."] as const, // README:356, "measured on this Mac, except the one row marked third party, and written down with its n and its date"; the notes credit the Agora row
  lead: "Measured on the author's Mac and written down. The harnesses are in the repo. Every latency carries its n and date.", // README:331, facts:388
  display: { value: "3 ms", label: "ear final to hands dispatch, median", tip: "6 ms p95 · real helper · n = 50 · 2026-09-11 · rerun under load 2026-10-06: 8 ms median, 58 ms p95, n = 30" } satisfies Figure, // README:337, facts:308; the rerun: pnpm jarhead bench on the real helper on the F5 branch (merged at 48aa9a9), load average 105
  figures: [
    { value: "126 ms", label: "prefire partials, p95", tip: "122 ms median · scroll, page, screenshot, circle · includes the 120 ms window · n = 20 · 2026-09-11" }, // README:338, REDESIGN §12
    { value: "457 ms", label: "careful partials, p95", tip: "455 ms median · keys, edits, type, click · includes the 450 ms window · n = 30 · 2026-09-11" }, // README:339
    { value: "1.11 s", label: "GPT-Live-1 spoken reply, median", tip: "1.21 s p90 · Agora, third party · n = 30 per condition · 2026-07-09 · typed, on the wire: 1.38 s median, 1.67 s p90, n = 10, 2026-10-06 · an earlier run that day, at c7d4e63: 1.89 s median, 2.25 s p90, n = 10" }, // README:345; live-check LC-5, 2026-10-06: lc-5-first-word-094046-879.json and -001836-863.json, firstAudioMs, the median of 10 being the mean of the middle two (the harness printed the lower one then, and the saved report reads 1.35 s)
    { value: "4.5 s", label: "delegation to first visible action, median", tip: "5.1 s p95 · Codex through the app-server · canned hands · n = 6 · 2026-09-12 · in real use: 7.0 s median, 27.6 s p95, n = 15, 2026-09-12 to 09-28" }, // README:341; docs/latency/after.json brain-path firstAction, the mean of the middle two of 6 (the summary saved then reads the lower one, 4.4 s); the author's ledger, 2026-09-12 to 09-28
    { value: "9.0 s", label: "delegation to verified completion, median", tip: "25.6 s p95 · canned hands · n = 10 · 2026-09-12 · in real use: 13.3 s median, 50.0 s p95, n = 28, 2026-09-12 to 09-28" }, // README:342; docs/latency/after.json brain-path done, the mean of the middle two of 10 (the summary saved then reads 8.9 s); the ledger's 28, likewise (the script printed 12.6 s)
    { value: "83 ms", label: "tool round trip, median", tip: "518 ms p95 · real use · n = 162 · 2026-09-12 to 09-28" }, // the author's ledger, 2026-09-12 to 09-28 (the perf audit's ledger-numbers script); 82.5 ms, the mean of the middle two (the script printed the lower one, 82 ms)
    { value: "98 ms", label: "screenshot round trip, median", tip: "311 ms p95 · real use · n = 72 · 2026-09-12 to 09-28" }, // the author's ledger, 2026-09-12 to 09-28 (the perf audit's ledger-numbers script); 97.5 ms, the mean of the middle two (the script printed the lower one, 96 ms)
    { value: "10.7k", label: "input tokens, cold Codex thread", tip: "from 22.3k · −52 % · a private CODEX_HOME · measured on a cold thread, n = 1, 2026-09-12 · about 11.4k now, an estimate, w3-4-tool-parity" }, // README:348, README:84, REDESIGN:2015-2018 (n = 1, the date w3-4-tool-parity's BR-16 title gives; commit 4bf46c1 is 2026-09-11 20:30 -0700)
    { value: "71", label: "tools in ten families", tip: "16 permissions, 7 required · 6 brains + auto" }, // README:356
    { value: "3", label: "live threads beside the main one", tip: "25 steps / 180 s default · 40 / 300 cap · linger 30 s" }, // README:351
    { value: "1.5 s", label: "your key, click or scroll holds the hands", tip: "busy for 1500 ms" }, // README:353
    { value: "2 s", label: "liveness ping", tip: "two unanswered: drop and reconnect · 8 s silent: the daemon is killed and started again" }, // README:354, EngineClient.swift
    { value: "90 s", label: "daemon linger after a crash", tip: "a clean quit stops it at once · relaunch at most 3 in 10 min · the Codex thread stays warm" }, // README:355, README:76
    { value: "10 min", label: "idle sleep", tip: "no word to it for 10 min · a setting · 30 min at most by default, whatever the room says · live-check LC-7 at a 1 min setting: asleep 60.3 s after the last word to it, room talk going on, n = 1, 2026-10-06" }, // README:350; engine.ts IDLE_CEILING_MS
  ] satisfies readonly Figure[],
  lines: ["Reflex rows ran on pnpm jarhead bench, 2026-09-11.", "Model rows ran real Codex, canned hands, 2026-09-12.", "The spoken reply is Agora's measurement, 2026-07-09."] as const, // facts:308, facts:309, facts:311
} as const;

/** Costs */
export const COSTS = {
  id: "costs",
  name: "Costs",
  h2: ["It's five cents a minute", "and nothing asleep."] as const, // README:637: billed per second of open session, muted or not; asleep there is no session (README:79). The brain and memory reads are the lead's and the lines', not this sentence's
  lead: "The voice bills $0.05 a minute. It counts per second. Pause and Stop close the session.", // README:551
  figures: [
    { value: "$0.05", label: "per minute of open session", tip: "billed per second, muted or not" }, // README:551
    { value: "$3", label: "an hour of talking", tip: "the meter is on the island and in the Console" }, // README:551
    { value: "$0", label: "the voice, asleep", tip: "the wake word runs on-device · memory reads closed conversations on your key" }, // README:551, README:553
  ] satisfies readonly Figure[],
  lines: ["Codex runs on your ChatGPT plan.", "A local brain bills nothing. The voice does.", "The Ledger tab totals each day."] as const, // README:552, LOCAL:4, README:83
} as const;

/** Install */
export const INSTALL = {
  id: "install",
  name: "Install",
  label: "source only", // facts:40-41
  h2: ["It takes four commands,", "then you say jarhead."] as const, // README:45, README:55-60
  lead: "Source only. One line clones the repo and runs four commands. Setup opens on first launch and writes your key.", // facts:40-41, README:36-38, README:386
  url: "https://jarhead.kevinliu.studio/install.sh",
  code: "curl -fsSL https://jarhead.kevinliu.studio/install.sh | sh", // README:41
  copy: "Copy",
  copied: "Copied",
  /** The one-liner's held runs: it may wrap after `curl -fsSL`, before `install.sh` and before `| sh`, never inside the host (checked below). */
  runs: { cmd: "curl -fsSL", host: "https://jarhead.kevinliu.studio/", script: "install.sh", tail: "| sh" },
  note: "It checks macOS 14+, Apple silicon, Xcode 16's tools, Node 24 and pnpm 10. It clones to ~/jarhead and runs the four commands without the site's packages. It opens the app. It never writes your keys. Read it first at https://jarhead.kevinliu.studio/install.sh", // README:37-38, scripts/install.sh
  /** README:47-50, one row each; the comment is the row's note. */
  commands: [
    { cmd: "git clone https://github.com/Kevin-Liu-01/Jarhead.git && cd Jarhead" },
    { cmd: "pnpm install --filter '!./site' && pnpm build:hands", note: "Node ≥ 24, pnpm 10, Xcode 16" },
    { cmd: "pnpm build:mac", note: "builds, signs, installs /Applications/Jarhead.app" },
    { cmd: "open -a Jarhead", note: "Setup opens: your OpenAI key, a brain, permissions" },
  ] as const,
  requirements: {
    word: "Requirements",
    count: 6,
    items: [
      "macOS 14.5 or newer on Apple silicon", // README:377, README:383; Xcode 16 needs macOS 14.5 (scripts/install.sh:152), so the source install does too. The app runs on 14 (the hero's 14+)
      "Xcode 16 or newer", // README:383
      "Node 24 or newer and pnpm 10", // README:378-379
      "An OpenAI API key for the voice", // README:379
      "A brain you are already signed in to", // README:379-380
      "A Code Signing certificate, optional", // README:77, README:397-401, scripts/install.sh
    ] as const,
    certNote: "Self-signed is enough. Without one the build signs ad-hoc. Every rebuild then resets the permission grants.", // README:77, README:397-401, scripts/install.sh
  },
} as const;
if (`${INSTALL.runs.cmd} ${INSTALL.runs.host}${INSTALL.runs.script} ${INSTALL.runs.tail}` !== INSTALL.code || `${INSTALL.runs.host}${INSTALL.runs.script}` !== INSTALL.url) throw new Error("the one-liner's runs drifted from INSTALL.code");

/** Footer */
export const FOOTER = {
  brand: "Jarhead", // README:11
  line1: "A voice-first Mac assistant that uses the computer for you.", // README:15
  line2: "Built with Swift and TypeScript.", // README:22
  disclosures: [
    "Every picture is rendered by the app's own preview harnesses over fixed fake data.", // README:90-91
    "None is a photo of a desktop.", // README:91
    'The alarm\'s "Wake up, Kevin" is the harness\'s fixed data.', // facts:392, README:298
    "The voice speaks English only.", // facts:382
    "Brand marks from thesvg.org.", // ICONS:27
  ] as const,
  credit: "Built by Kevin Liu.", // facts:15-16
  licence: "MIT.", // README:569
} as const;

/** Alt text (COPY.md "Alt text"): the share card, public/og.png (app/card, scripts/make-cards.sh). */
export const ALT = {
  og: "Your Mac, by voice. Jarhead's blob is the full stop. Each eye has a white star in it. The Install key is under the line.", // the card
} as const;

/**
 * UI (LANDING.md "Copy"): the control verbs the deck does not have, at most six, verbs only. Every other control on the
 * page is an icon or a deck word.
 */
export const UI = {
  replay: "Replay", // every demo: back to its first frame
  hold: "Hold", // Wake: the Touch ID pad passes on a held press
} as const;
