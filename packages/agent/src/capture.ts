import { OverlayClient } from "@jarvis/overlay";

/**
 * Take a screenshot without Jarvis photographing itself.
 *
 * The obvious fix — `setContentProtection(true)` on the overlay window — is a
 * no-op on this macOS. Measured: a protected window and an unprotected one
 * produced byte-identical red-pixel counts in the capture. So the buddy really
 * is in every frame unless something removes it, and a vision turn would end up
 * describing Jarvis's own overlay back to Kevin.
 *
 * Hiding it around the capture is deterministic and needs no OS cooperation.
 * The cost is a visible blink, which is honest: the buddy genuinely is not on
 * screen for that instant.
 */

const SETTLE_MS = 120;

export interface CaptureGuardOptions {
  /** Skip the hide/show dance. Useful when no overlay is running. */
  readonly skip?: boolean;
  readonly socketPath?: string;
}

/**
 * Runs `capture` with the overlay hidden.
 *
 * Failing to reach the overlay is not an error: the common case is that no
 * overlay is running at all, and a screenshot with a buddy in it beats no
 * screenshot.
 */
export async function withOverlayHidden<T>(
  capture: () => Promise<T>,
  opts: CaptureGuardOptions = {},
): Promise<T> {
  if (opts.skip) return capture();

  const client = opts.socketPath ? new OverlayClient(opts.socketPath) : new OverlayClient();
  let hidden = false;

  try {
    await client.send({ cmd: "hide" });
    hidden = true;
    // The compositor needs a beat to actually drop the window, otherwise the
    // capture races the hide and the buddy is still in the frame.
    await new Promise((r) => setTimeout(r, SETTLE_MS));
  } catch {
    // No overlay running, or it is not answering. Capture anyway.
  }

  try {
    return await capture();
  } finally {
    if (hidden) {
      try {
        await client.send({ cmd: "show" });
      } catch {
        // Leaving the buddy hidden is bad, but not worth losing the answer over.
      }
    }
    client.close();
  }
}
