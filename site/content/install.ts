/**
 * The Install lane's copy: the plate (design.md §2.1) and the section (design.md §2.11). Every string
 * is final and traced. `README:NN` is /Users/kevinliu/jarvis/README.md line NN; RELEASE is the draft
 * GitHub release "Jarhead v2.0.0" (facts-product.md §4.1). The install path is source only, as
 * facts-product.md §5.1 requires; the script is the site's own, and its steps match README:23-29 (§5.16).
 */

/** A run of text with inline code spans; the components render `{ code }` as `<code>`. */
export type Rich = ReadonlyArray<string | { readonly code: string }>;

export const INSTALL_URL = "https://jarhead.kevinliu.studio/install.sh"; // scripts/install.sh, its header
export const INSTALL_HOST_PATH = "jarhead.kevinliu.studio/install.sh"; // the same address without the scheme, for the desk plate
export const REPO_URL = "https://github.com/Kevin-Liu-01/Jarhead"; // README:10

/** The one-liner, the same string on the desk plate and the rail plate (design.md §6). */
export const ONE_LINER = "curl -fsSL https://jarhead.kevinliu.studio/install.sh | sh";

// ---- the plate (design.md §2.1) ----
export const PLATE_EYEBROW = "INSTALL · ONE LINE";
export const PLATE_COPY = "Copy";
export const PLATE_COPIED = "Copied";
export const PLATE_COPY_LABEL = "Copy the install command";
/** The desk plate's one note; it ends in INSTALL_HOST_PATH, which renders as the link. README:352-355; scripts/install.sh header */
export const PLATE_NOTE_DESK =
  "Clones the repo and runs the four build commands. macOS 14+ · Apple silicon · Xcode 15.3+ · Node ≥ 24 · pnpm 10. Read it first: jarhead.kevinliu.studio/install.sh";
/** The rail plate's "what it does" line; it ends in INSTALL_URL, which renders as the link. scripts/install.sh; README:23-29, README:352-355 */
export const PLATE_LINE_RAIL =
  "What it does, in order: checks macOS 14+ on Apple silicon, Xcode's tools, Node 24 and pnpm; clones github.com/Kevin-Liu-01/Jarhead to ~/jarhead; runs the four commands below; opens the app. Run it again to pull and rebuild. Read it first: https://jarhead.kevinliu.studio/install.sh";

// ---- the section head (design.md §2.11) ----
export const SECTION_ID = "install";
export const SECTION_LABEL = "source only";
export const SECTION_H2 = "Install";
export const SECTION_LEAD =
  "Open source, MIT, four commands to build. One line clones the repo and runs them; Setup opens on first launch and writes your key."; // README:13, README:23-29, README:58, README:365-367

// ---- the command rows, the commands verbatim from README:23-29 ----
export type CommandRow =
  | { readonly n: string; readonly kind: "command"; readonly cmd: string; readonly note: Rich; readonly source: string }
  | { readonly n: string; readonly kind: "spoken"; readonly text: Rich; readonly source: string };

export const COMMANDS: readonly CommandRow[] = [
  {
    n: "01",
    kind: "command",
    cmd: "git clone https://github.com/Kevin-Liu-01/Jarhead.git && cd Jarhead",
    note: ["the repo, MIT"],
    source: "README:24, README:13, LICENSE:1",
  },
  {
    n: "02",
    kind: "command",
    cmd: "pnpm install && pnpm build:hands",
    note: ["Node ≥ 24, pnpm 10 (", { code: "corepack enable" }, "), Xcode. The Swift helper lands in ", { code: "build/jarhead-hands" }, "."],
    source: "README:25, README:358",
  },
  {
    n: "03",
    kind: "command",
    cmd: "pnpm build:mac",
    note: ["builds, signs, installs ", { code: "/Applications/Jarhead.app" }, " in place"],
    source: "README:26, README:359",
  },
  {
    n: "04",
    kind: "command",
    cmd: "open -a Jarhead",
    note: ["Setup opens: your name, voice key, brain, the sixteen permissions, wake word"],
    source: "README:27, README:58; RELEASE Install",
  },
  {
    n: "05",
    kind: "spoken",
    text: ['Then say "jarhead", pass Touch ID, talk.'],
    source: "README:28, README:16",
  },
];

/** The keys and signing paragraph; it stays beside the commands. README:362, README:365-367, README:372-379, README:58 */
export const KEYS_PARAGRAPH: Rich = [
  "Keys go into ",
  { code: "~/.jarhead/env" },
  ", mode 0600. Setup writes them; the app only ever sees that they exist. ",
  { code: "pnpm run doctor" },
  " checks keys, brain, permissions, signing, wake word, install and dock, and is red on the key until Setup has written it. Sign with a real identity before the first ",
  { code: "pnpm build:mac" },
  ", or every rebuild resets the permission grants: a self-signed Code Signing certificate from Keychain Access is enough.",
];

/** README:424-435; ⌥⇧R from docs/AUDIO.md:25 */
export const HOTKEYS: readonly string[] = [
  "⌥⇧J Console",
  "⌥⇧Space go / pause",
  "⌥⎋ stop",
  "⌥⇧M mute",
  "⌥⇧C circle",
  "⌥⇧Return type to Jarhead",
  "⌥⇧S snooze",
  "⌥⇧R recording",
  "⌘P ⌘. in the Console",
];

// ---- requirements, six checks: README:352-355, README:372-379; RELEASE "Requirements" ----
export const REQUIREMENTS_HEAD = { word: "Requirements", count: 6 } as const;
export const REQUIREMENTS: readonly Rich[] = [
  ["macOS 14+ on Apple silicon"], // README:352
  ["Xcode 15.3 or newer, for ", { code: "swift build" }], // README:352-353
  ["Node ≥ 24 · pnpm 10 · ", { code: "corepack enable" }, " picks the pinned version"], // README:354; package.json:14-17
  ["An OpenAI API key with access to ", { code: "gpt-live-1" }, ", for the voice"], // README:355; RELEASE
  ["A brain you are signed in to: Codex, the Claude Code CLI, an API key, or Ollama / LM Studio / llama.cpp with a tool-capable model"], // README:355; RELEASE; docs/LOCAL.md:20
  ["A Code Signing certificate in your keychain, self-signed is enough, so the permission grants survive rebuilds"], // README:372-379; README:54
];

// ---- Setup, seven steps: README:58, README:192-199 ----
export const SETUP_HEAD = { word: "Setup", count: 7 } as const;
export interface SetupStep {
  readonly n: number;
  readonly name: string;
  readonly line: Rich;
}
export const SETUP_STEPS: readonly SetupStep[] = [
  { n: 1, name: "Welcome", line: ["your name, pre-filled from the Mac account"] }, // README:58
  { n: 2, name: "Voice", line: ["the OpenAI key, written to ", { code: "~/.jarhead/env" }] }, // README:365-367
  { n: 3, name: "Brain", line: ["pick one; its login is probed"] }, // README:195
  { n: 4, name: "Permissions", line: ["sixteen in one sweep, the seven required first"] }, // README:54, README:198
  { n: 5, name: "Wake", line: ["the phrases; Touch ID, passphrase, either or none"] }, // README:199
  { n: 6, name: "Agents", line: ["the coding-agent sessions the Console will list"] }, // README:58, README:42
  { n: 7, name: "Done", line: ['say "jarhead"'] }, // README:58, README:16
];

// ---- the onboarding row: four 1× captures (facts-media.md §1), README:192-199 ----
export const ONBOARDING = [
  { src: "/media/onboarding-welcome.png", alt: "Setup, Welcome" },
  { src: "/media/onboarding-brain.png", alt: "Setup, Brain" },
  { src: "/media/onboarding-permissions.png", alt: "Setup, Permissions" },
  { src: "/media/onboarding-wake.png", alt: "Setup, Wake" },
] as const;
export const ONBOARDING_SIZE = { width: 620, height: 552, maxWidth: 310 } as const;

/** README:437-452 */
export const PERMISSIONS_NOTE =
  "Sixteen permissions, seven required: Microphone, Speech Recognition, Screen Recording, Accessibility, Input Monitoring, Full Disk Access, Automation. macOS grants nothing programmatically, so the sweep asks, one dialog at a time, then walks the System Settings panes.";
