import Anthropic from "@anthropic-ai/sdk";
import { AnnotateClient } from "@jarvis/annotate";
import { SentenceSplitter, type Speaker } from "@jarvis/voice";
import {
  TOOL_DEFINITIONS,
  runChoreography,
  teach,
  type Beat,
  type Command,
  type ModelStep,
  type TeachOutcome,
  type ToolCallRequest,
} from "@jarvis/tools";
import { makeToolDeps } from "./deps.ts";

/**
 * "Do the thing" — the generic act loop.
 *
 * There is nothing app-specific here and there deliberately never will be. The
 * model gets six verbs (look, find, point, draw, path, click) and a list of
 * windows, and works out the rest by looking. An app-specific integration would
 * be faster for that one app and useless for every other, which is the opposite
 * of the trade Kevin wants.
 *
 * Speech and annotation are choreographed rather than sequential: the arrow for
 * a step appears as the sentence describing it is spoken. See choreograph.ts.
 */

const ACT_SYSTEM = `You are Jarvis, showing Kevin things on his own screen.

You can see the screen and point at it. Work only from what you actually observe —
never assume an app's layout from memory, because the version in front of Kevin may
not match and a confidently wrong arrow is worse than saying you cannot find it.

Procedure, in order:
1. If you do not know what is on screen, call look_at_screen first. One look is
   usually enough; looking repeatedly is slow and Kevin is waiting.
2. To locate something specific, call find_on_screen with a plain visual
   description ("the blue send button", "the search box at the top"). It reports
   whether it found it by the accessibility tree (exact) or by vision (an estimate).
3. Point at what you found. Say what you are pointing at as you point.
4. Only click when Kevin asked you to click. Pointing is the default.

How to narrate: one short sentence per step, spoken aloud, no markdown. Say what you
are doing as you do it — "the export button is up here on the right" — because your
words and the arrow land together.

If something cannot be found, say so plainly in one sentence and stop. Do not
invent coordinates.`;

export interface ActOptions {
  readonly anthropicApiKey: string;
  readonly model?: string;
  /** Speaks one sentence and resolves when the audio finishes. */
  readonly speak: (sentence: string) => Promise<void>;
  readonly maxSteps?: number;
  readonly budgetMs?: number;
  readonly signal?: AbortSignal;
  readonly log?: (line: string) => void;
}

export const ACT_MODEL = "claude-haiku-4-5-20251001";

/**
 * Runs the loop until the model stops calling tools, or a governor stops it.
 *
 * Governors are real, not advisory: every await inside teach() is raced against
 * the budget and the abort signal, so a hung vision call cannot strand the lesson
 * and Kevin's interrupt lands mid-step.
 */
export async function act(request: string, opts: ActOptions): Promise<TeachOutcome> {
  const client = new Anthropic({ apiKey: opts.anthropicApiKey });
  const annotate = new AnnotateClient();
  const log = opts.log ?? ((): void => undefined);
  const deps = makeToolDeps({ anthropicApiKey: opts.anthropicApiKey, annotate, log });

  const outcome = await teach(request, {
    deps,
    maxSteps: opts.maxSteps ?? 6,
    budgetMs: opts.budgetMs ?? 90_000,
    ...(opts.signal ? { signal: opts.signal } : {}),

    runModel: async (utterance, transcript): Promise<ModelStep> => {
      const messages = buildMessages(utterance, transcript);
      const reply = await client.messages.create(
        {
          model: opts.model ?? ACT_MODEL,
          max_tokens: 700,
          system: ACT_SYSTEM,
          tools: TOOL_DEFINITIONS as never,
          messages,
        },
        opts.signal ? { signal: opts.signal } : undefined,
      );

      const narration = reply.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join(" ")
        .trim();

      const calls: ToolCallRequest[] = reply.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
        .map((b) => ({ id: b.id, name: b.name, input: b.input as Record<string, unknown> }));

      log(`step: ${calls.length} tool call(s)${calls.length ? ` — ${calls.map((c) => c.name).join(", ")}` : ""}`);
      return { narration, calls };
    },

    present: async (beats: readonly Beat[]) => {
      await runChoreography(beats, {
        speak: opts.speak,
        show: async (commands: readonly Command[]) => {
          for (const c of commands) await sendCommand(annotate, c, log);
        },
        clear: async () => {
          try {
            await annotate.send({ cmd: "clear" });
          } catch {
            // No annotation layer running; the narration still stands.
          }
        },
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    },
  });

  annotate.close();
  return outcome;
}

/**
 * Choreography commands are already in the annotate wire shape; this only
 * swallows failures so a missing annotation layer degrades to voice-only.
 */
async function sendCommand(annotate: AnnotateClient, command: Command, log: (l: string) => void): Promise<void> {
  try {
    await annotate.send(command as never);
  } catch (e) {
    log(`annotation skipped: ${(e as Error).message}`);
  }
}

/**
 * Replays the exchange as an Anthropic message list.
 *
 * Tool results must come back as a user turn keyed by tool_use_id or the model
 * loses the thread entirely and starts over — which looks like Jarvis forgetting
 * what it just did.
 */
function buildMessages(
  utterance: string,
  transcript: readonly { step: ModelStep; results: readonly { id: string; name: string; ok: boolean; detail: string }[] }[],
): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: utterance }];

  for (const exchange of transcript) {
    const content: Anthropic.ContentBlockParam[] = [];
    if (exchange.step.narration) content.push({ type: "text", text: exchange.step.narration });
    for (const call of exchange.step.calls) {
      content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
    }
    if (content.length > 0) messages.push({ role: "assistant", content });

    if (exchange.results.length > 0) {
      messages.push({
        role: "user",
        content: exchange.results.map((r) => ({
          type: "tool_result" as const,
          tool_use_id: r.id,
          content: r.detail,
          is_error: !r.ok,
        })),
      });
    }
  }

  return messages;
}

/** Speaks through a Speaker, splitting into sentences so audio starts early. */
export function speakerNarrator(makeSpeaker: () => Speaker): (sentence: string) => Promise<void> {
  return async (sentence: string) => {
    const speaker = makeSpeaker();
    const splitter = new SentenceSplitter();
    for (const part of splitter.push(sentence)) speaker.say(part);
    const tail = splitter.flush();
    if (tail) speaker.say(tail);
    await speaker.idle();
  };
}
