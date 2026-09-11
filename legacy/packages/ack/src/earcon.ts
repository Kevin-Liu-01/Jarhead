import { spawn } from "node:child_process";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";

/**
 * Earcons: the "mic is hot" chirp and its falling "done" mirror.
 *
 * Generated locally with ffmpeg's sine filter instead of synthesized speech
 * because tones cost zero ElevenLabs characters, and a tone reads as UI state
 * where a spoken word would read as the assistant talking. Cached to disk on
 * first use; after that playback goes through the same instant playFile path
 * as the ack bank.
 */

export type EarconVariant = "listening" | "done";

/** Rising for "listening", falling for "done" — the pitch direction IS the meaning. */
const TONES: Record<EarconVariant, readonly [number, number]> = {
  listening: [740, 1180],
  done: [1180, 740],
};

export function earconPath(stateDir: string, variant: EarconVariant): string {
  return join(stateDir, "ack", `earcon-${variant}.wav`);
}

/**
 * Generate the tone if it is not cached yet, and return its path. The cached
 * case is a single stat, safe on the voice path; the generate case spawns
 * ffmpeg and belongs in startup/warmup, never in a live turn.
 */
export async function ensureEarcon(
  stateDir: string,
  variant: EarconVariant,
  timeoutMs = 5000,
): Promise<string> {
  const path = earconPath(stateDir, variant);
  if (existsSync(path)) return path;

  mkdirSync(join(stateDir, "ack"), { recursive: true });
  const [from, to] = TONES[variant];

  // Two 70ms tones concatenated; the 5/15ms fades stop the edges from
  // clicking, and 0.35 volume keeps a status blip quieter than speech.
  const partPath = `${path}.part.wav`;
  await run(
    "ffmpeg",
    [
      "-y",
      "-loglevel", "error",
      "-f", "lavfi", "-i", `sine=frequency=${from}:duration=0.07`,
      "-f", "lavfi", "-i", `sine=frequency=${to}:duration=0.07`,
      "-filter_complex",
      "[0:a][1:a]concat=n=2:v=0:a=1,afade=t=in:d=0.005,afade=t=out:st=0.125:d=0.015,volume=0.35",
      partPath,
    ],
    timeoutMs,
  );
  // Rename after a clean exit so a killed ffmpeg cannot leave a truncated
  // wav that existsSync would treat as cached forever.
  renameSync(partPath, path);
  return path;
}

/**
 * The lavfi source touches no capture device, so this cannot hit the
 * mic-grant hang documented in mic.ts — but the guard costs nothing and
 * turns any future ffmpeg surprise into an error instead of a wedged process.
 */
function run(cmd: string, args: readonly string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(0, 200)}`));
    });
  });
}
