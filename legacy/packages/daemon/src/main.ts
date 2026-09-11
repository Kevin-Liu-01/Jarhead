#!/usr/bin/env tsx
import { readConfig } from "@jarvis/core";
import { buildPrompt, route } from "@jarvis/answers";
import { Brain } from "@jarvis/voice";
import { Daemon } from "./daemon.ts";

/**
 * The launchd entry point. Everything interesting is injected into Daemon so
 * it stays testable; this file is only the wiring that picks the real clock,
 * the real config, and the real answer pipeline.
 *
 * The executor is a headless voice turn: same route → prompt → model path as
 * a live question, minus the speaker. The recorded answer text is what gets
 * spoken later when Jarvis delivers the result.
 */

const config = readConfig();
if (!config.anthropicApiKey) {
  console.error("ANTHROPIC_API_KEY is not set. Run `pnpm run doctor`.");
  process.exit(1);
}

const brain = new Brain(config.anthropicApiKey);

const execute = async (intent: string): Promise<string> => {
  const routed = await route(intent, { wikiRoot: config.kevinWikiRoot });
  const result = await brain.stream(buildPrompt(intent, routed), { onToken: () => undefined });
  return result.text;
};

const daemon = new Daemon({ config, execute });

daemon.start().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
