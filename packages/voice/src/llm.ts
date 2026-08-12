import Anthropic from "@anthropic-ai/sdk";

/**
 * The brain. Haiku 4.5 for the voice path — it is the fastest tier to first
 * token, and first token is what the whole latency budget is built around.
 *
 * Caching note carried over from the research: Haiku 4.5's minimum cacheable
 * prefix is 4096 tokens, so a short system prompt silently will not cache.
 * The persona below is deliberately kept small and we eat the cheap uncached
 * prefill rather than pretending caching is helping.
 */

export const VOICE_MODEL = "claude-haiku-4-5-20251001";

/**
 * Spoken Answer Mode, distilled from the wiki's kevin-voice skill.
 * The rules that matter for speech: no markdown, no lists, no headers — every
 * one of those reads aloud as noise.
 */
export const SPOKEN_SYSTEM_PROMPT = `You are Jarvis, Kevin's local assistant. You speak out loud; your words go straight to a text-to-speech engine.

How to speak:
- Lead with the answer. No preamble, no "great question", no restating what was asked.
- Your FIRST sentence must be short — twelve words at most. It starts playing before the rest exists, so a long opener is dead air in Kevin's ear. Put the headline in it and elaborate afterwards.
- Two or three sentences unless asked for more. This is conversation, not a document.
- Plain spoken prose only. No markdown, no bullet points, no headings, no emoji, no code blocks, no URLs read aloud — every one of those becomes noise in the ear.
- Numbers and names spoken naturally: "about twelve hundred" not "~1200", "kevin dash wiki" not "kevin-wiki".
- Lowercase register, dry, direct. Never bubbly. Never apologize for what you cannot do — just say what you can do instead.
- If you do not know, say so in a sentence and say what would find out.
- When context is provided below, answer from it and do not invent detail it does not contain. If it is thin, say it is thin.`;

export interface StreamOptions {
  readonly system?: string;
  readonly maxTokens?: number;
  /**
   * Aborts generation mid-stream.
   *
   * Required for barge-in: without it, cutting Jarvis off would silence the
   * audio while the model kept generating (and kept billing) into a void.
   */
  readonly signal?: AbortSignal;
  /** Called with each text delta as it arrives. */
  readonly onToken: (token: string) => void;
  /** Called once, when the very first token lands. */
  readonly onFirstToken?: (ms: number) => void;
}

export interface StreamResult {
  readonly text: string;
  readonly ttftMs: number;
  readonly totalMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** Vision costs tokens per tile, so screen frames go to a cheap-but-capable tier. */
export const VISION_MODEL = "claude-haiku-4-5-20251001";

export class Brain {
  private readonly client: Anthropic;

  constructor(apiKey: string, private readonly model: string = VOICE_MODEL) {
    this.client = new Anthropic({ apiKey });
  }

  /**
   * Answer about an image — a screen frame, in practice.
   *
   * Streams like the text path so the answer starts being spoken before the
   * model has finished looking. Screenshots must be downscaled before they get
   * here: a retina frame is 3456px wide and costs a pile of tiles for detail
   * nobody asks about.
   */
  async streamAboutImage(
    prompt: string,
    image: { readonly base64: string; readonly mediaType: "image/png" | "image/jpeg" },
    opts: StreamOptions,
  ): Promise<StreamResult> {
    const startedAt = Date.now();
    let ttftMs = 0;
    let text = "";

    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: opts.maxTokens ?? 400,
      system: opts.system ?? SPOKEN_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.base64 } },
            { type: "text", text: prompt },
          ],
        },
      ],
    });

    stream.on("text", (delta: string) => {
      if (ttftMs === 0) {
        ttftMs = Date.now() - startedAt;
        opts.onFirstToken?.(ttftMs);
      }
      text += delta;
      opts.onToken(delta);
    });

    const final = await stream.finalMessage();
    return {
      text,
      ttftMs,
      totalMs: Date.now() - startedAt,
      inputTokens: final.usage.input_tokens,
      outputTokens: final.usage.output_tokens,
    };
  }

  async stream(prompt: string, opts: StreamOptions): Promise<StreamResult> {
    const startedAt = Date.now();
    let ttftMs = 0;
    let text = "";
    let inputTokens = 0;
    let outputTokens = 0;

    const stream = this.client.messages.stream(
      {
        model: this.model,
        max_tokens: opts.maxTokens ?? 400,
        system: opts.system ?? SPOKEN_SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }],
      },
      opts.signal ? { signal: opts.signal } : undefined,
    );

    stream.on("text", (delta: string) => {
      if (ttftMs === 0) {
        ttftMs = Date.now() - startedAt;
        opts.onFirstToken?.(ttftMs);
      }
      text += delta;
      opts.onToken(delta);
    });

    const final = await stream.finalMessage();
    inputTokens = final.usage.input_tokens;
    outputTokens = final.usage.output_tokens;

    return { text, ttftMs, totalMs: Date.now() - startedAt, inputTokens, outputTokens };
  }
}
