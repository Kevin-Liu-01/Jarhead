import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * C3 (launch wave 5): the docs carry no em dash in prose, and D8 is written down.
 *
 * The claim sweep counted em dashes left in prose (AGENTS.md 100 lines, docs/LATENCY.md 51,
 * docs/AUTOMATIONS.md 30, docs/REDESIGN.md 401, docs/AUDIO.md 20). Kevin's copy rule is no
 * em dashes; the one exception is a product string quoted exactly as the product shows it.
 * Every em dash left in these files must sit inside one of the KEPT quotes below, and each
 * KEPT quote must still be what its source file says, so a product string that changes
 * fails here and the doc follows it.
 *
 * D8 is decided: Go / Pause stays ⌥⇧Space, which on the US layout takes the no-break space
 * (U+00A0) while Jarhead runs, the one hotkey `HotkeyCheckMain.swift` allows to type.
 * README.md and AGENTS.md say so where they list the hotkeys.
 */

/** The em dash, spelled out so this file's own code never carries one outside a quote. */
const EM = "\u2014";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const texts = new Map<string, string>();
const read = (path: string): string => {
  let text = texts.get(path);
  if (text === undefined) texts.set(path, (text = readFileSync(join(ROOT, path), "utf8")));
  return text;
};

const DOCS = ["AGENTS.md", "README.md", "apps/mac/README.md", "docs/LATENCY.md", "docs/AUTOMATIONS.md", "docs/REDESIGN.md", "docs/AUDIO.md"] as const;

interface Kept {
  /** The quote as the doc prints it. */
  text: string;
  /** The file the product string lives in. */
  source: string;
  /** What the source must contain, when the doc fills in a template; `text` itself otherwise. */
  sourceHas?: readonly string[];
}

const HELP_COPY = "apps/mac/Sources/Jarhead/UI/HelpCopy.swift";
const DOCTOR = "packages/cli/src/doctor.ts";
const ENGINE = "packages/engine/src/engine.ts";
const CRASH_GUARD = "apps/mac/Sources/Jarhead/App/CrashGuard.swift";

const KEPT: readonly Kept[] = [
  { text: "Hand back the mic, guard the echo — apps keep their sound", source: HELP_COPY },
  { text: "Stopped — nothing running", source: HELP_COPY },
  { text: "Recording — mic shared, echo guarded", source: HELP_COPY },
  { text: "heard himself · muted — Recording off?", source: "apps/mac/Sources/Jarhead/Model/AppState.swift" },
  { text: "tap is pre-duck — measure at the device", source: "apps/mac/Scripts/DuckLeakProbeMain.swift" },
  { text: "would need a yes when it runs; nobody is there then — notify instead", source: "packages/core/src/policy.ts" },
  { text: "this wakes the brain — not the voice — while Jarhead is asleep", source: "apps/mac/Sources/Jarhead/UI/Console/AutomationsRail.swift" },
  { text: "ringing: —", source: "packages/cli/src/automations-cli.ts", sourceHas: ["· ringing: ${ringWords(", 'if (!ring) return "—";'] },
  { text: "nothing fires while Jarhead is quit — Open at login is off", source: DOCTOR },
  { text: "Notifications not granted — the island and the chime still fire", source: DOCTOR, sourceHas: ["`Notifications ${", '"not granted"', "} — the island and the chime still fire`"] },
  { text: "spent — 5 of 5 min used today", source: DOCTOR, sourceHas: ["`spent — ${usedMin} of ${cap} min used today"] },
  { text: "entitlement absent — alarm banners honour Focus like any banner", source: DOCTOR },
  { text: "asleep — press Go", source: ENGINE },
  { text: 'Last task: "<request>" — <status>: <summary>', source: ENGINE, sourceHas: ["`Last task: \"${", "}\" — ${last.status}: ${last.summary}`"] },
  { text: "— defaults import failed (1)", source: ENGINE, sourceHas: ["skipped ? `${text} — ${skipped}` : text"] },
  { text: "Two Jarhead tiles in the Dock — Dock not restarted", source: ENGINE, sourceHas: ['"Two Jarhead tiles in the Dock"', "`${stood} — Dock not restarted`"] },
  { text: "Dock written, not restarted — press Fix the Dock again", source: ENGINE },
  { text: "then: signal SIGABRT (6) — the runtime's abort after the exception above", source: CRASH_GUARD, sourceHas: ['"\\nthen: signal "', "\" — the runtime's abort after the exception above\\n\""] },
  { text: "relaunch: no — 4 crashes in 10 minutes; staying down until you open Jarhead yourself", source: CRASH_GUARD, sourceHas: ['"relaunch: no — "', '" crashes in 10 minutes; staying down until you open Jarhead yourself\\n"'] },
  { text: "relaunch: no — 4 crashes in 10 minutes", source: CRASH_GUARD, sourceHas: ['"relaunch: no — "', '" crashes in 10 minutes;'] },
  { text: "Spotify is thinking — 0 seconds in", source: "packages/engine/src/threads/lines.ts", sourceHas: ['`${name} is ${phrase ?? "thinking"} — ${s} seconds in`'] },
  { text: "not yet — say the date", source: "packages/core/src/schedule.ts" },
];

/** A quote may wrap across lines in the doc: any run of whitespace matches any run. */
const quotePattern = (text: string): RegExp =>
  new RegExp(text.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"), "g");

/** The em dashes in `doc` outside every KEPT quote, as `line: text`. */
function strayDashes(doc: string): string[] {
  const covered = new Set<number>();
  for (const k of KEPT) {
    for (const m of doc.matchAll(quotePattern(k.text))) {
      for (let i = m.index; i < m.index + m[0].length; i++) covered.add(i);
    }
  }
  const stray: string[] = [];
  const lineStarts = [0];
  for (let i = 0; i < doc.length; i++) if (doc[i] === "\n") lineStarts.push(i + 1);
  for (let i = doc.indexOf(EM); i !== -1; i = doc.indexOf(EM, i + 1)) {
    if (covered.has(i)) continue;
    let line = 0;
    while (line + 1 < lineStarts.length && (lineStarts[line + 1] ?? Infinity) <= i) line++;
    const start = lineStarts[line] ?? 0;
    const end = doc.indexOf("\n", start);
    stray.push(`${line + 1}: ${doc.slice(start, end === -1 ? undefined : end).trim().slice(0, 160)}`);
  }
  return stray;
}

test("C3: no em dash in the docs' prose; the only ones left quote a product string", () => {
  const found: string[] = [];
  for (const path of DOCS) for (const s of strayDashes(read(path))) found.push(`${path}:${s}`);
  assert.deepEqual(found, [], `em dashes outside a quoted product string:\n${found.join("\n")}`);
});

test("C3: every quote the docs keep with its em dash is still the product's own words", () => {
  for (const k of KEPT) {
    const src = read(k.source);
    for (const needle of k.sourceHas ?? [k.text]) assert.ok(src.includes(needle), `${k.source} no longer has ${JSON.stringify(needle)} (the docs quote ${JSON.stringify(k.text)})`);
    const quotedBy = DOCS.filter((path) => quotePattern(k.text).test(read(path)));
    assert.ok(quotedBy.length > 0, `no doc quotes ${JSON.stringify(k.text)} any more; drop it from KEPT`);
  }
});

test("C3: the em dash check catches prose and spares a kept quote", () => {
  assert.deepEqual(strayDashes(`one ${EM} two\n\`asleep ${EM} press Go\`\n`), [`1: one ${EM} two`]);
  assert.deepEqual(strayDashes(`toast "asleep\n${EM} press Go" kept`), []);
});

test("D8: Go / Pause stays ⌥⇧Space, the one hotkey allowed the no-break space, said where README.md and AGENTS.md list the hotkeys", () => {
  const check = read("apps/mac/Scripts/HotkeyCheckMain.swift");
  assert.match(check, /let typesAllowed: \[Hotkeys\.Action: String\] = \[\.transportToggle: "U\+00A0"\]/, "the check allows exactly Go / Pause its U+00A0");

  const readme = read("README.md");
  const hotkeys = readme.slice(readme.indexOf("### Hotkeys"), readme.indexOf("\n## ", readme.indexOf("### Hotkeys")));
  assert.match(hotkeys, /`⌥⇧Space` stays go \/ pause\. On the US layout it takes the no-break space \(U\+00A0\) while Jarhead runs, the one\s+hotkey allowed to \(`apps\/mac\/Scripts\/HotkeyCheckMain\.swift`\)\./);

  const agents = read("AGENTS.md");
  const bullet = agents.slice(agents.indexOf("- **The letter hotkeys are"), agents.indexOf("\n- **Version skew"));
  assert.match(bullet, /Go \/ Pause stays ⌥⇧Space \(D8, decided\): on the US layout it\s+takes the no-break space \(U\+00A0\) while Jarhead runs, the one hotkey allowed to\s+\(`HotkeyCheckMain\.swift`'s `typesAllowed`\)\./);
  assert.doesNotMatch(agents, /D8, open/);

  const mac = read("apps/mac/README.md");
  assert.match(mac, /Go \/ Pause stays there \(decision D8\)/);
  assert.doesNotMatch(mac, /open question/);
});
