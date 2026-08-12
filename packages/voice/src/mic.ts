import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Mic capture via ffmpeg + avfoundation, with silence-based endpointing.
 *
 * Not the final design — M1 replaces this with Silero VAD + a semantic
 * endpointer, which the DECISION doc measures as 350–650ms faster than naive
 * silence detection. This exists so M0 can capture real speech today without
 * a native helper or a `brew install sox`.
 *
 * Requires the Microphone TCC grant for whatever process tree runs ffmpeg.
 */

export interface MicOptions {
  /**
   * avfoundation device spec without the leading colon.
   *
   * "default" not an index: indices shift when audio devices come and go, and
   * an AirPods disconnect silently moved the built-in mic from 1 to 0.
   */
  readonly device: number | string;
  /** Stop after this much trailing silence, in seconds. */
  readonly silenceSeconds: number;
  /** Silence threshold in dB. Quieter than this counts as silence. */
  readonly thresholdDb: number;
  /** Hard cap so a stuck mic can't record forever. */
  readonly maxSeconds: number;
  /**
   * Abort if no audio flows within this long.
   *
   * Without this the process hangs indefinitely: when the Microphone TCC grant
   * is missing and no GUI prompt can reach the process (a sandboxed or headless
   * shell), ffmpeg neither errors nor exits — it just waits. Verified on this
   * machine. A hang is a much worse failure than a clear message.
   */
  readonly startupTimeoutMs: number;
  /**
   * Give up if the user never actually says anything.
   *
   * Distinct from `startupTimeoutMs`: audio IS flowing, it is just all room
   * tone. Without this the recording runs the full `maxSeconds` every time
   * someone taps the key and changes their mind — observed as a 6.7s wait on a
   * recording containing no speech at all.
   */
  readonly noSpeechTimeoutMs: number;
}

export const DEFAULT_MIC: MicOptions = {
  device: process.env["JARVIS_MIC_DEVICE"] ?? "default",
  silenceSeconds: 1.2,
  thresholdDb: -34,
  maxSeconds: 20,
  startupTimeoutMs: 4000,
  noSpeechTimeoutMs: 6000,
};

export interface Recording {
  readonly path: string;
  /** ms from process start to endpoint decision. */
  readonly durationMs: number;
  readonly endedBy: "silence" | "max-duration" | "manual" | "no-speech";
}

/**
 * No audio arrived. Two very different causes, and guessing wrong wastes real time.
 *
 * A missing TCC grant and a mic already held by another process look identical
 * from here: ffmpeg simply produces nothing and never errors. This blamed
 * permissions unconditionally, which sent me to System Settings while the actual
 * culprit was a stray ffmpeg from an earlier test still holding the device —
 * for hours. So we look for the other holder before accusing the grant.
 */
export class MicPermissionError extends Error {
  constructor(detail: string, holders: readonly string[] = []) {
    const cause =
      holders.length > 0
        ? `The microphone is already in use by:\n  ${holders.join("\n  ")}\n` +
          `Stop it (kill ${holders[0]?.split(/\s+/)[0] ?? "<pid>"}) and retry.`
        : `Microphone access denied. Grant it in System Settings → Privacy & Security → ` +
          `Microphone for your terminal, then retry.`;
    super(`${cause} (ffmpeg: ${detail})`);
    this.name = "MicPermissionError";
  }
}

/**
 * Other processes plausibly holding an audio input device.
 *
 * Best-effort and synchronous: this only runs on the failure path, where a few
 * milliseconds do not matter and a wrong-but-plausible hint still beats a
 * confidently wrong one.
 */
export function audioDeviceHolders(): readonly string[] {
  try {
    const out = execFileSync("/usr/bin/pgrep", ["-fl", "avfoundation"], {
      encoding: "utf8",
      timeout: 2000,
    });
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.includes("pgrep"))
      .map((l) => l.slice(0, 120));
  } catch {
    return [];
  }
}

/** Parses ffmpeg's avfoundation device listing. Returns [index, name] pairs. */
export async function listInputDevices(): Promise<ReadonlyArray<{ index: number; name: string }>> {
  const stderr = await new Promise<string>((resolve) => {
    const p = spawn("ffmpeg", ["-f", "avfoundation", "-list_devices", "true", "-i", ""]);
    let buf = "";
    p.stderr.on("data", (d: Buffer) => (buf += d.toString()));
    p.on("close", () => resolve(buf));
    p.on("error", () => resolve(buf));
  });

  const out: Array<{ index: number; name: string }> = [];
  let inAudio = false;
  for (const line of stderr.split("\n")) {
    if (line.includes("AVFoundation audio devices")) {
      inAudio = true;
      continue;
    }
    if (line.includes("AVFoundation video devices")) {
      inAudio = false;
      continue;
    }
    if (!inAudio) continue;
    const m = /\[(\d+)\]\s+(.+?)\s*$/.exec(line);
    if (m?.[1] && m[2]) out.push({ index: Number(m[1]), name: m[2] });
  }
  return out;
}

/**
 * Record until the speaker stops talking.
 *
 * ffmpeg's `silencedetect` filter only logs; it won't terminate the capture.
 * So we watch stderr and kill ffmpeg ourselves once silence has persisted past
 * the threshold *and* we've heard actual speech first — otherwise it would end
 * the recording during the pause before the user starts.
 */
export function recordUntilSilence(
  opts: MicOptions = DEFAULT_MIC,
  onSpeechStart?: () => void,
): { done: Promise<Recording>; stop: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-mic-"));
  const path = join(dir, "utterance.wav");
  const startedAt = Date.now();

  const ff = spawn("ffmpeg", [
    "-hide_banner",
    "-loglevel", "info",
    "-f", "avfoundation",
    "-i", `:${opts.device}`,
    "-ac", "1",
    "-ar", "16000",
    "-af", `silencedetect=noise=${opts.thresholdDb}dB:d=${opts.silenceSeconds}`,
    "-t", String(opts.maxSeconds),
    "-y", path,
  ]);

  let endedBy: Recording["endedBy"] = "max-duration";
  let audioFlowing = false;
  let heardSpeech = false;
  let stderr = "";
  let settled = false;

  const stop = (): void => {
    if (settled) return;
    endedBy = "manual";
    ff.kill("SIGINT");
  };

  const done = new Promise<Recording>((resolve, reject) => {
    // If no audio has flowed by now, we are almost certainly blocked on a TCC
    // prompt that will never appear. Kill it and say so.
    const startupGuard = setTimeout(() => {
      if (audioFlowing || settled) return;
      settled = true;
      ff.kill("SIGKILL");
      reject(
        new MicPermissionError(
          `no audio after ${opts.startupTimeoutMs}ms`,
          audioDeviceHolders().filter((h) => !h.includes(String(ff.pid))),
        ),
      );
    }, opts.startupTimeoutMs);

    // Audio is flowing but nobody is talking. End it rather than burning maxSeconds.
    const speechGuard = setTimeout(() => {
      if (heardSpeech || settled) return;
      endedBy = "no-speech";
      ff.kill("SIGINT");
    }, opts.noSpeechTimeoutMs);

    const clearGuard = (): void => {
      clearTimeout(startupGuard);
      clearTimeout(speechGuard);
    };

    ff.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;

      // size= progress lines mean audio is reaching us. That is NOT speech —
      // conflating the two made every silent recording run to max duration.
      if (!audioFlowing && /size=\s*\d+/.test(text)) {
        audioFlowing = true;
        clearTimeout(startupGuard);
      }

      // silence_end is the real speech signal: a silent stretch just ended.
      if (!heardSpeech && text.includes("silence_end")) {
        heardSpeech = true;
        clearTimeout(speechGuard);
        onSpeechStart?.();
      }

      if (heardSpeech && text.includes("silence_start")) {
        endedBy = "silence";
        // Let the tail of the silence window land in the file, then cut.
        setTimeout(() => ff.kill("SIGINT"), 120);
      }
    });

    ff.on("error", (e) => {
      clearGuard();
      reject(new Error(`ffmpeg failed to spawn: ${e.message}`));
    });

    ff.on("close", () => {
      clearGuard();
      if (settled) return; // the startup guard already rejected
      settled = true;
      if (/Operation not permitted|Input\/output error|abort\(\)/i.test(stderr) && !audioFlowing) {
        reject(new MicPermissionError(stderr.trim().split("\n").slice(-1)[0] ?? "unknown", audioDeviceHolders()));
        return;
      }
      resolve({ path, durationMs: Date.now() - startedAt, endedBy });
    });
  });

  return { done, stop };
}
