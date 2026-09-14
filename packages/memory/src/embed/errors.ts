export type EmbedErrorCode = "no-key" | "http" | "timeout" | "bad-response";

/**
 * Why an embed() failed; the service defers the run on any of these rather than
 * mixing vector spaces. Shared by every network embedder: OpenAI raises all four
 * codes, a local server never `no-key` (nothing on this Mac asks for one).
 */
export class EmbedError extends Error {
  constructor(readonly code: EmbedErrorCode, message: string, readonly status?: number) {
    super(message);
    this.name = "EmbedError";
  }
}
