import { readFileSync } from "node:fs";
import { captureScreen, downscale, ScreenPermissionError } from "@jarvis/computer";
import { Brain, SentenceSplitter, type Speaker } from "@jarvis/voice";
import { withOverlayHidden } from "./capture.ts";
import type { Timeline } from "./timeline.ts";

/**
 * "Look at my screen and tell me X."
 *
 * Two rules from the plan, both load-bearing:
 *
 * 1. Downscale before sending. A retina frame is 3456px wide; at full size it
 *    costs a pile of image tiles for detail that never affects the answer.
 * 2. Speak while looking. The sentence splitter runs over the vision stream
 *    exactly as it does for text, so audio starts on the first clause rather
 *    than after the model has described everything.
 */

export const SCREEN_MAX_WIDTH = 1024;

export interface LookResult {
  readonly answer: string;
  readonly screenshotPath: string;
  readonly sentPath: string;
  readonly captureMs: number;
  readonly firstAudioMs: number | undefined;
}

export interface LookDeps {
  readonly brain: Brain;
  readonly makeSpeaker: () => Speaker;
}

export async function lookAtScreen(
  question: string,
  deps: LookDeps,
  timeline: Timeline,
): Promise<LookResult> {
  let shot;
  try {
    shot = await withOverlayHidden(() => captureScreen());
  } catch (e) {
    if (e instanceof ScreenPermissionError) throw e;
    throw new Error(`could not capture the screen: ${(e as Error).message}`);
  }
  timeline.mark("capture", `${shot.path.split("/").slice(-1)[0]}`);

  const small = await downscale(shot.path, SCREEN_MAX_WIDTH);
  const sentPath = typeof small === "string" ? small : small.path;
  timeline.mark("downscale", `${SCREEN_MAX_WIDTH}px wide`);

  const base64 = readFileSync(sentPath).toString("base64");

  const speaker = deps.makeSpeaker();
  const splitter = new SentenceSplitter();
  let spokeFirst = false;

  const result = await deps.brain.streamAboutImage(
    `Kevin is looking at this screen and asked, out loud: "${question}"\n\n` +
      `Answer from what is actually visible. If the thing he is asking about is not on screen, say so in one sentence.`,
    { base64, mediaType: "image/png" },
    {
      onFirstToken: () => timeline.mark("vision_ttft"),
      onToken: (token) => {
        for (const sentence of splitter.push(token)) {
          if (!spokeFirst) {
            spokeFirst = true;
            timeline.mark("first_sentence");
          }
          speaker.say(sentence);
        }
      },
    },
  );

  const tail = splitter.flush();
  if (tail) {
    if (!spokeFirst) timeline.mark("first_sentence", "(tail)");
    speaker.say(tail);
  }

  await speaker.idle();
  timeline.mark("audio_done", `${speaker.spoken.length} sentence(s)`);

  return {
    answer: result.text,
    screenshotPath: shot.path,
    sentPath,
    captureMs: shot.ms,
    firstAudioMs: speaker.firstAudioAt === undefined ? undefined : timeline.since(speaker.firstAudioAt),
  };
}
