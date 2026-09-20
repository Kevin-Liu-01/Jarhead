import { test } from "node:test";
import assert from "node:assert/strict";
import { BRAIN_MEMORY_TOKENS, VOICE_MEMORY_TOKENS } from "@jarhead/protocol";
import { localDay } from "../extract/input.ts";
import { BRAIN_MEMORY_LABEL, brainMemoryLabel, renderBrainBlock, renderVoiceBlock, VOICE_FOOTER, VOICE_HEADER, voiceHeader } from "../render.ts";
import { estimateTokens } from "../tokens.ts";
import { item, T0 } from "./helpers.ts";

/**
 * The two blocks: bullets for the brain (procedures prefixed, episodes dated),
 * one spoken paragraph for the voice between its fixed header and footer;
 * both under their budget by chars / 3.2, both free of markdown emphasis.
 */

const items = [
  item({ id: "a", text: "Kevin prefers short answers", kind: "preference" }),
  item({ id: "b", text: "read the diff before saying a PR is fine", kind: "procedure" }),
  item({ id: "c", text: "Kevin shipped the auth branch", kind: "episode", createdAt: T0, sources: [{ at: T0, type: "heard" }] }),
  item({ id: "d", text: "Kevin goes by *Kev* and uses `zsh`", kind: "fact" }),
];

test("brain block: bullets in order, procedures prefixed 'How Kevin likes it done:', episodes dated, emphasis stripped; the label is a constant for promptParts", () => {
  const r = renderBrainBlock(items);
  assert.equal(r.text, ["- Kevin prefers short answers", "- How Kevin likes it done: read the diff before saying a PR is fine", `- Kevin shipped the auth branch (${localDay(T0)})`, "- Kevin goes by Kev and uses zsh"].join("\n"));
  assert.deepEqual(r.ids, ["a", "b", "c", "d"]);
  assert.equal(r.tokens, estimateTokens(r.text!));
  assert.ok(r.tokens <= BRAIN_MEMORY_TOKENS);
  assert.equal(BRAIN_MEMORY_LABEL, "What you know about Kevin (durable memory; use it, do not repeat it back, do not say you remembered):");
  const already = renderBrainBlock([item({ id: "p", text: "How Kevin likes it done: ask first", kind: "procedure" }), item({ id: "e", text: "Kevin flew to Tokyo on 2026-09-08", kind: "episode" })]);
  assert.equal(already.text, "- How Kevin likes it done: ask first\n- Kevin flew to Tokyo on 2026-09-08", "no double prefix, no double date");
});

test("voice block: starts '# Kevin, in brief', one paragraph of sentences, ends with the quiet line; no * or backtick, one header level; ≤ 120 tokens; empty input → no text", () => {
  const r = renderVoiceBlock(items);
  assert.ok(r.text!.startsWith(`${VOICE_HEADER}\n`));
  assert.ok(r.text!.endsWith(`\n${VOICE_FOOTER}`));
  assert.equal(VOICE_HEADER, "# Kevin, in brief");
  assert.equal(VOICE_FOOTER, "Use this quietly; never announce that you remember it.");
  const lines = r.text!.split("\n");
  assert.equal(lines.length, 3, "header, paragraph, footer");
  assert.equal(lines[1], `Kevin prefers short answers. How Kevin likes it done: read the diff before saying a PR is fine. Kevin shipped the auth branch (${localDay(T0)}). Kevin goes by Kev and uses zsh.`);
  assert.ok(!/[*`]/.test(r.text!));
  assert.equal((r.text!.match(/^#/gm) ?? []).length, 1);
  assert.ok(r.tokens <= VOICE_MEMORY_TOKENS);
  assert.deepEqual(renderVoiceBlock([]), { tokens: 0, ids: [] });
  assert.deepEqual(renderBrainBlock([]), { tokens: 0, ids: [] });
});

test("budgets hold: 60 long items → brain ≤ 250 tokens and voice ≤ 120 tokens with header and newlines counted; an item that does not fit is skipped for a shorter one", () => {
  const many = Array.from({ length: 60 }, (_, i) => item({ id: `m${i}`, text: `Kevin's fact number ${i} about his world and how he likes it handled every single time`, kind: "fact" }));
  const brain = renderBrainBlock(many);
  assert.ok(brain.tokens <= BRAIN_MEMORY_TOKENS, `${brain.tokens}`);
  assert.equal(brain.tokens, estimateTokens(brain.text!));
  assert.ok(brain.ids.length >= 5);
  const voice = renderVoiceBlock(many);
  assert.ok(voice.tokens <= VOICE_MEMORY_TOKENS, `${voice.tokens}`);
  assert.equal(voice.tokens, estimateTokens(voice.text!));
  const withShort = renderVoiceBlock([...many.slice(0, 3), item({ id: "s", text: "Kevin is Kev", kind: "fact" })]);
  assert.ok(withShort.ids.includes("s"));
  assert.ok(withShort.tokens <= VOICE_MEMORY_TOKENS);
  const tight = renderVoiceBlock(many, 30);
  assert.deepEqual(tight, { tokens: 0, ids: [] }, "header + footer alone are over 30 tokens: nothing fits, nothing is emitted");
});

test("an episode recalled nine times (sources capped at 8) still renders the date of its first mention, not of the last recall", () => {
  const DAY = 86_400_000;
  const first = T0;
  const sources = [{ at: first, type: "heard" as const }, ...Array.from({ length: 7 }, (_, i) => ({ at: first + (i + 20) * DAY, type: "heard" as const }))];
  const recalled = item({ id: "ep", text: "Kevin shipped the auth branch", kind: "episode", createdAt: first + 3 * DAY, lastSeenAt: first + 26 * DAY, seenCount: 9, sources });
  assert.equal(recalled.sources.length, 8);
  assert.equal(renderBrainBlock([recalled]).text, `- Kevin shipped the auth branch (${localDay(first)})`);
  assert.ok(renderVoiceBlock([recalled]).text!.includes(`(${localDay(first)}).`));
  // and an old log whose sources happen to be out of order still dates by the earliest
  const shuffled = item({ id: "ep2", text: "Kevin moved desks", kind: "episode", createdAt: first + 40 * DAY, sources: [{ at: first + 30 * DAY, type: "heard" }, { at: first + 2 * DAY, type: "heard" }] });
  assert.equal(renderBrainBlock([shuffled]).text, `- Kevin moved desks (${localDay(first + 2 * DAY)})`);
  // no sources at all: the day memory learned it
  const bare = item({ id: "ep3", text: "Kevin fixed the printer", kind: "episode", createdAt: first + 5 * DAY, sources: [] });
  assert.equal(renderBrainBlock([bare]).text, `- Kevin fixed the printer (${localDay(first + 5 * DAY)})`);
});

test("release F1: the voice header and the procedure prefix take the user's name; a procedure the rules already phrased (in any name) is not prefixed twice; the defaults are unchanged", () => {
  const items = [
    item({ id: "m_1", text: "Sam prefers short answers", kind: "preference" }),
    item({ id: "m_2", text: "read the diff before calling a PR fine", kind: "procedure" }),
    item({ id: "m_3", text: "How Kevin likes it done: ask before pushing", kind: "procedure" }),
  ];
  const voice = renderVoiceBlock(items, VOICE_MEMORY_TOKENS, "Sam");
  assert.equal(voice.text, "# Sam, in brief\nSam prefers short answers. How Sam likes it done: read the diff before calling a PR fine. How Kevin likes it done: ask before pushing.\nUse this quietly; never announce that you remember it.");
  const brain = renderBrainBlock(items, BRAIN_MEMORY_TOKENS, "Sam");
  assert.equal(brain.text, "- Sam prefers short answers\n- How Sam likes it done: read the diff before calling a PR fine\n- How Kevin likes it done: ask before pushing");
  assert.equal(voiceHeader("Sam"), "# Sam, in brief");
  assert.equal(voiceHeader(), VOICE_HEADER);
  assert.equal(VOICE_HEADER, "# Kevin, in brief");
  assert.equal(brainMemoryLabel("Sam"), "What you know about Sam (durable memory; use it, do not repeat it back, do not say you remembered):");
  assert.equal(brainMemoryLabel(), BRAIN_MEMORY_LABEL);
  assert.match(renderVoiceBlock(items).text ?? "", /^# Kevin, in brief\n/, "the default stays Kevin");
});
