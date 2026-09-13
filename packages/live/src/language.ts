import type { Accent } from "@jarhead/protocol";

/**
 * The language lock. GPT-Live-1 is speech-to-speech and mirrors what it hears; with
 * the always-on gate it hears media and other people too, so one foreign utterance
 * in the room could flip the reply language, and nothing in the standing orders says
 * "English". This section pins it. It is assembled by the ENGINE into
 * `sessionConfig.instructions` after the base orders (instructions.ts is a rail and
 * its 1100-word budget is nearly spent); if Kevin later says "voice instructions",
 * move it inside `buildLiveInstructions` at position 2 and trim Narration by 8 words.
 * Only "en" is offered today; an unknown tag falls back to English on purpose.
 */

const LANGUAGE_NAMES: Readonly<Record<string, string>> = { en: "English" };

/** "en" / "en-GB" / undefined → "English"; an unknown tag is English until a second language exists. */
export function languageName(tag?: string): string {
  const primary = (tag ?? "en").toLowerCase().split("-")[0] ?? "en";
  return LANGUAGE_NAMES[primary] ?? "English";
}

/** The accent is one fragment of the sentence; "none" lets the voice keep its own rendering. Best effort on the model's side. */
const ACCENT_CLAUSE: Readonly<Record<Accent, string>> = { american: "American accent, ", british: "British accent, ", none: "" };

/** The `# Language` section, exactly as DECISIONS pins it. */
export function languageSection(user: string, language?: string, accent: Accent = "american"): string {
  const lang = languageName(language);
  return `# Language\nSpeak ${lang}, ${ACCENT_CLAUSE[accent] ?? ""}whatever language you hear; if ${user} speaks another language, answer in ${lang} unless he asks you to switch.`;
}
