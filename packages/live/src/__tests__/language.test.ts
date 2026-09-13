import { test } from "node:test";
import assert from "node:assert/strict";
import { ACCENTS, VOICES, DEFAULT_SETTINGS } from "@jarhead/protocol";
import type { BuiltInVoice } from "../events.ts";
import { languageName, languageSection } from "../language.ts";
import { buildLiveInstructions } from "../instructions.ts";

/**
 * The language lock: English is the default and the fallback until a second language
 * exists; the accent is one fragment ("none" drops it); the text is exactly what
 * DECISIONS pins, carries no markdown, and is assembled by the engine after the
 * standing orders — so the rail (instructions.ts) and its word budget do not move.
 */

test("languageName: en and en-GB are English; nothing and an unknown tag fall back to English on purpose", () => {
  assert.equal(languageName("en"), "English");
  assert.equal(languageName("en-GB"), "English");
  assert.equal(languageName("EN-us"), "English");
  assert.equal(languageName(undefined), "English");
  assert.equal(languageName("xx"), "English");
});

test("languageSection: the exact text for each accent; none drops the fragment; the user's name is interpolated", () => {
  assert.equal(languageSection("Kevin", "en", "american"), "# Language\nSpeak English, American accent, whatever language you hear; if Kevin speaks another language, answer in English unless he asks you to switch.");
  assert.equal(languageSection("Kevin", "en", "british"), "# Language\nSpeak English, British accent, whatever language you hear; if Kevin speaks another language, answer in English unless he asks you to switch.");
  assert.equal(languageSection("Kevin", "en", "none"), "# Language\nSpeak English, whatever language you hear; if Kevin speaks another language, answer in English unless he asks you to switch.");
  assert.equal(languageSection("Kevin"), languageSection("Kevin", "en", "american"), "American English is the default");
  assert.match(languageSection("Sam", "en-GB", "none"), /if Sam speaks another language, answer in English/);
  for (const accent of ACCENTS) {
    const s = languageSection("Kevin", DEFAULT_SETTINGS.language, accent);
    assert.ok(!/[*`]/.test(s), "no markdown in a spoken prompt");
    assert.ok(!/^#{2,}/m.test(s), "one level of headers");
    assert.ok(s.startsWith("# Language\n"));
  }
});

test("the rail is untouched: the standing orders carry no # Language of their own and stay under their budget; the engine appends the section after them", () => {
  const orders = buildLiveInstructions({ alwaysOn: true });
  assert.doesNotMatch(orders, /# Language/);
  const joined = [orders, languageSection("Kevin", "en", "american")].join("\n\n");
  assert.ok(joined.indexOf("# Names and numbers") < joined.indexOf("# Language"));
  const words = (s: string): number => s.split(/\s+/).filter(Boolean).length;
  assert.ok(words(orders) <= 1100, `${words(orders)} words`);
  assert.ok(words(languageSection("Kevin", "en", "american")) <= 30, "the section is a couple of lines");
});

test("VOICES: 22 voices, the same set as the wire's BuiltInVoice union (type-level), the default among them; ACCENTS covers its union", () => {
  assert.equal(VOICES.length, 22);
  assert.ok((VOICES as readonly string[]).includes(DEFAULT_SETTINGS.voice));
  // The two lists cannot drift: every VOICES entry is a BuiltInVoice and every BuiltInVoice is in VOICES.
  const all: readonly BuiltInVoice[] = VOICES;
  type Missing = Exclude<BuiltInVoice, (typeof VOICES)[number]>;
  const none: Missing extends never ? true : never = true;
  assert.equal(none, true);
  assert.equal(new Set(all).size, 22);
  assert.deepEqual([...ACCENTS], Object.keys({ american: 0, british: 0, none: 0 }));
});
