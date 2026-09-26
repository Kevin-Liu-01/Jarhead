/**
 * COPY.md (scratchpad/site/COPY.md, 2026-09-25), verbatim, as data: the only source of strings on the page.
 * Every string here is the deck's; components may drop or cut one (components/sections/cut.ts), never add
 * or reword. `README:NN` is /Users/kevinliu/jarvis/README.md line NN.
 */

import type { DeskKind } from "@/lib/phase";

export const REPO_URL = "https://github.com/Kevin-Liu-01/Jarhead"; // README:10

/** Nav (COPY.md "Nav"). */
export const NAV = {
  brand: "Jarhead", // README:5
  links: [
    { word: "Story", href: "#story" },
    { word: "Numbers", href: "#numbers" },
    { word: "Rails", href: "#rails" },
    { word: "Costs", href: "#costs" },
    { word: "Install", href: "#install" },
  ],
  github: "GitHub", // README:10
  install: "Install",
  skip: "Skip to content",
  theme: { dark: "Switch to dark", light: "Switch to light" },
} as const;

/** Hero (COPY.md "Hero"). */
export const HERO = {
  h1: ["Your Mac,", "by voice."], // README:7
  lead: "Say jarhead, pass Touch ID, talk. It uses the computer for you. The brain is whatever you already have a login for.", // README:16, README:7, README:17
  install: "Install",
  source: "Read the source", // README:10
  note: "Send, pay, delete, post and purchase ask every time.", // README:347
  figures: "v2.0.0 · MIT · macOS 14+ · Apple silicon · $0.05 / min, per second · 71 tools · 6 brains + auto", // facts:15, README:13, README:362, README:334, README:341
} as const;

/** The phase words and hints (COPY.md "Phase words and hints"): a dot, a badge or a tooltip at most, never a line above a heading. */
export const PHASES: Record<DeskKind, { readonly word: string; readonly hint: string }> = {
  asleep: { word: "Asleep", hint: "No session. Nothing billed." }, // README:536, AUTOMATIONS:6-7
  listening: { word: "Listening", hint: "The mic is open. The meter runs." }, // README:41, README:536
  thinking: { word: "Thinking", hint: "The brain has the task." }, // README:254-255
  acting: { word: "Acting", hint: "The hands are using the Mac." }, // README:18, README:45
  speaking: { word: "Speaking", hint: "It is talking. Say stop to interrupt." }, // README:41
  alarm: { word: "Alarm", hint: "Rings asleep. Nothing billed." }, // README:289-292
};

export interface Story {
  readonly id: string;
  readonly n: string;
  readonly name: string;
  readonly phase: DeskKind;
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
  h2: ["Wakes on a word.", "Touch ID opens it."], // README:42, README:350
  lead: "Asleep it listens on-device for one word. Nothing billed. Then Touch ID, Apple Watch, the Mac password or a passphrase.", // README:42
  lines: ["Three misses lock the gate for a minute.", "Speaker verification is not attempted.", "Say stop. It stops mid-sentence."], // README:42, README:350, README:41
  faces: "gate · heard · granted · denied · locked", // README:163
};

/** 02 · Say */
export const SAY: Story = {
  id: "say",
  n: "02",
  name: "Say",
  phase: "thinking",
  h2: ["Codex, Claude Code, a key,", "or a model on this Mac."], // README:17-18, README:44, LOCAL:3-4
  lead: "Unambiguous commands reach the hands in milliseconds. The rest goes to the brain. You pick the brain in Settings.", // README:46, README:254-255, README:44
  lines: ['"Click Save" runs. The brain is told after.', "Same tools and policy for every brain.", "A local brain keeps memory on the Mac."], // README:46, README:44, LOCAL:4-5
};

/** 03 · Threads */
export const THREADS: Story = {
  id: "threads",
  n: "03",
  name: "Threads",
  phase: "acting",
  h2: ["Several things at once.", "Each with its own brain."], // README:47
  lead: "\"Tell Ben on Slack I'm late and put on Focus on Spotify\" splits into two threads. Each has its own brain, conversation, budget and blob. Up to three run beside the main one.", // README:47
  lines: ["Slack asks before it sends.", "Spotify runs in the background by Apple events.", '"Stop the Slack one" needs no model call.'], // README:125-126, README:47
};

/** 04 · Hands */
export const HANDS: Story = {
  id: "hands",
  n: "04",
  name: "Hands",
  phase: "acting",
  h2: ["Label first. Click second.", "Screenshot last."], // README:45
  lead: "The hands are a Swift helper with 71 tools in ten families. They find a control by label and click it. A screenshot only verifies.", // README:18, README:45
  lines: ["Circle anything with ⌥⇧C. Every brain sees it.", "The blob moves to where the hands act.", "The Console lists every coding-agent session."], // README:51, README:52, README:50
};

/** 05 · Rails */
export const RAILS: Story & { readonly never: { readonly label: string; readonly items: readonly string[]; readonly line: string } } = {
  id: "rails",
  n: "05",
  name: "Rails",
  phase: "speaking",
  h2: ["One policy table.", "Run, confirm or refuse."], // README:346
  lead: "Every call is run, confirm or refuse. The reason is spoken. No tool is special-cased.", // README:346
  lines: ["A spoken yes covers one action once.", "Your key or click holds it 1.5 s.", "On-screen text is never an instruction."], // README:347, README:48, README:352
  never: {
    label: "NEVER",
    items: ["mkfs", "diskutil erase", "dd onto a device", "shutdown", "rm -rf / or ~", "Other apps' TCC resets", "Every secret store"], // README:349
    line: "Send, pay, delete, post and purchase ask every time. A remembered yes never covers them.", // README:347-348
  },
};

/** 06 · Sleep */
export const SLEEP: Story = {
  id: "sleep",
  n: "06",
  name: "Sleep",
  phase: "asleep",
  h2: ["Say good night.", "Alarms still ring."], // README:54, README:286-290
  lead: 'It says "night." and closes the session. Ten idle minutes do the same. Alarms, timers, watchers and routines fire while it sleeps.', // README:54, README:286-289, AUTOMATIONS:3-4
  lines: ["No session, no brain turn, nothing billed.", "Set-up asks once. Fire time never asks.", "Nothing fires while Jarhead is quit."], // AUTOMATIONS:6-7, AUTOMATIONS:11-13, AUTOMATIONS:116-117
};

export interface Figure {
  readonly value: string;
  readonly label: string;
  readonly tip: string;
}

/** Numbers */
export const NUMBERS = {
  id: "numbers",
  label: "the ledger",
  h2: ["Measured on one Mac.", "Written down."] as const, // README:316
  lead: "Measured on the author's Mac and written down. The harnesses are in the repo. Every latency carries its n and date.", // README:316, facts:388
  display: { value: "3 ms", label: "ear final to hands dispatch, median", tip: "6 ms p95 · real helper · n = 50 · 2026-09-11" } satisfies Figure, // README:322, facts:308
  figures: [
    { value: "126 ms", label: "prefire partials, p95", tip: "122 ms median · scroll, page, screenshot, circle · includes the 120 ms window · 2026-09-11" }, // README:323
    { value: "457 ms", label: "careful partials, p95", tip: "455 ms median · keys, edits, type, click · includes the 450 ms window · n = 30 · 2026-09-11" }, // README:324
    { value: "1.11 s", label: "GPT-Live-1 reply, median", tip: "1.21 s p90 · Agora, third party · n = 30 per condition · 2026-07-09" }, // README:330
    { value: "4.4 s", label: "delegation to first visible action, median", tip: "5.1 s p95 · Codex through the app-server · canned hands · n = 6 · 2026-09-12" }, // README:326
    { value: "8.9 s", label: "delegation to verified completion, median", tip: "25.6 s p95 · n = 10 · 2026-09-12" }, // README:327
    { value: "55 ms", label: "tool round trip, median", tip: "211 ms p95 · production ledger" }, // README:331
    { value: "48 to 75 ms", label: "screenshot, warm full display", tip: "ScreenCaptureKit" }, // README:332
    { value: "10.7k", label: "input tokens, cold Codex thread", tip: "from 22.3k · −52 % · a private CODEX_HOME" }, // README:333, README:69
    { value: "$0.05", label: "per minute of open session", tip: "billed per second, muted or not · a closed session costs nothing" }, // README:334
    { value: "71", label: "tools in ten families", tip: "16 permissions, 7 required · 6 brains + auto" }, // README:341
    { value: "3", label: "live threads beside the main one", tip: "25 steps / 180 s default · 40 / 300 cap · linger 30 s" }, // README:336
    { value: "1.5 s", label: "your key, click or scroll holds the hands", tip: "busy for 1500 ms" }, // README:338
    { value: "2 s", label: "liveness ping", tip: "two unanswered · drop, reconnect, kick" }, // README:339
    { value: "90 s", label: "daemon linger after a crash", tip: "relaunch at most 3 in 10 min · the Codex thread stays warm" }, // README:340, README:61
    { value: "10 min", label: "idle sleep", tip: "without an addressed turn · a setting" }, // README:335
  ] satisfies readonly Figure[],
  lines: ["Reflex rows ran on pnpm jarhead bench, 2026-09-11.", "Model rows ran real Codex, canned hands, 2026-09-12.", "The voice reply is Agora's measurement, 2026-07-09."] as const, // facts:308, facts:309, facts:311
} as const;

/** Costs */
export const COSTS = {
  id: "costs",
  label: "what it bills",
  h2: ["Five cents a minute.", "Asleep costs nothing."] as const, // README:536
  lead: "The voice bills $0.05 a minute. It counts per second. Pause and Stop close the session.", // README:536
  figures: [
    { value: "$0.05", label: "per minute of open session", tip: "billed per second, muted or not" }, // README:536
    { value: "$3", label: "an hour of talking", tip: "the meter is on the island and in the Console" }, // README:536
    { value: "$0", label: "asleep", tip: "the wake word runs on-device" }, // README:536
  ] satisfies readonly Figure[],
  lines: ["Codex runs on your ChatGPT plan.", "A local brain bills nothing. The voice does.", "The Ledger tab totals each day."] as const, // README:537, LOCAL:4, README:68
} as const;

/** Made */
export const MADE = {
  id: "made",
  label: "how it is made",
  h2: ["Swift in the app.", "TypeScript in the daemon."] as const, // README:224, README:232
  lead: "Jarhead.app is Swift. The daemon jarheadd is TypeScript. Two Swift helpers act on the Mac.", // README:224, README:232, README:245-249
  lines: ["One 8×8 Bayer renderer dithers everything that shades.", "The ledger is append-only. Nothing is deleted.", "Its self-edits apply only on your yes."] as const, // README:67, README:56, README:64
} as const;

/** Install */
export const INSTALL = {
  id: "install",
  label: "source only", // facts:40-41
  h2: ["Four commands.", "Then say jarhead."] as const, // README:21-23, README:36
  lead: "Source only. One line clones the repo and runs four commands. Setup opens on first launch and writes your key.", // facts:40-41, README:21-23, README:371
  eyebrow: "INSTALL · ONE LINE",
  url: "https://jarhead.kevinliu.studio/install.sh",
  code: "curl -fsSL https://jarhead.kevinliu.studio/install.sh | sh", // README:26
  copy: "Copy",
  copied: "Copied",
  note: "It checks macOS 14+, Apple silicon, Xcode's tools, Node 24 and pnpm. It clones to ~/jarhead and runs the four commands. It opens the app. It never writes your keys. Read it first at https://jarhead.kevinliu.studio/install.sh", // README:22-23
  /** README:32-35 verbatim, one row each; the comment is the row's note. */
  commands: [
    { cmd: "git clone https://github.com/Kevin-Liu-01/Jarhead.git && cd Jarhead" },
    { cmd: "pnpm install && pnpm build:hands", note: "Node ≥ 24, pnpm 10 (corepack enable), Xcode" },
    { cmd: "pnpm build:mac", note: "builds, signs, installs /Applications/Jarhead.app" },
    { cmd: "open -a Jarhead", note: "Setup opens: your OpenAI key, a brain, permissions" },
  ] as const,
  then: 'Then say "jarhead", pass Touch ID, talk.', // README:36
  lines: ["Keys go into ~/.jarhead/env at mode 0600.", "Sixteen permissions in one sweep. Seven required.", "pnpm run doctor checks keys, brain and permissions."] as const, // README:375, README:62, README:372
  requirements: {
    word: "Requirements",
    count: 6,
    items: [
      "macOS 14 or newer on Apple silicon", // README:362
      "Xcode 15.3 or newer", // README:362
      "Node 24 or newer and pnpm 10", // README:363-364
      "An OpenAI API key for the voice", // README:364
      "A brain you are already signed in to", // README:364-365
      "A Code Signing certificate in your keychain", // README:62, README:382-386
    ] as const,
    certNote: "Self-signed is enough. Without one every rebuild resets the permission grants.", // README:62, README:382-386
  },
  setup: "Setup has seven steps. Welcome, Voice, Brain, Permissions, Wake, Agents, Done.", // README:66
} as const;

/** Footer */
export const FOOTER = {
  brand: "Jarhead", // README:5
  line1: "A voice-first Mac assistant that uses the computer for you.", // README:7
  line2: "Built with Swift and TypeScript.", // README:12
  mono: "GitHub · MIT · Kevin Liu · v2.0.0 · macOS 14+ · Apple silicon", // README:10, README:554, facts:15-16, README:362
  disclosures: [
    "Every picture is rendered by the app's own preview harnesses over fixed fake data.", // README:75-76
    "None is a photo of a desktop.", // README:76
    'The alarm\'s "Wake up, Kevin" is the harness\'s fixed data.', // facts:392, README:283
    "The voice speaks English only.", // facts:382
    "Brand marks from thesvg.org.", // ICONS:27
  ] as const,
  credit: "Built by Kevin Liu.", // facts:15-16
  licence: "MIT.", // README:554
} as const;

/** Alt text (COPY.md "Alt text"), one line per render the build keeps. */
export const ALT = {
  islandWorking: "The island acting. Two thread tiles, each with a Stop.", // README:92
  islandAlarm: "The island ringing an alarm while asleep. Snooze 10 and Done.", // README:283
  consoleConversation: "A Claude Code session in the Console. Allow and Deny.", // README:131
  consoleLight: "The Console in the light appearance.", // README:157
} as const;

const MEDIA = "/media";
/** The renders the page keeps, at their pixel sizes (docs/media). */
export const SHOTS = {
  islandWorking: { src: `${MEDIA}/notch-island-working.png`, alt: ALT.islandWorking, width: 920, height: 500 },
  islandAlarm: { src: `${MEDIA}/notch-island-alarm.png`, alt: ALT.islandAlarm, width: 920, height: 500 },
  consoleDark: { src: `${MEDIA}/console-conversation.jpg`, alt: ALT.consoleConversation },
  consoleLight: { src: `${MEDIA}/console-light.jpg`, alt: ALT.consoleLight },
} as const;
