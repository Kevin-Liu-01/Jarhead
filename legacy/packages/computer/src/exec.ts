import { spawn } from "node:child_process";

/**
 * Every subprocess in this package goes through here so the no-hang rule is
 * structural, not a convention. macOS has two distinct hang modes we have hit
 * on this machine: System Events blocks indefinitely on a wedged app, and
 * ffmpeg waits forever instead of erroring when a TCC grant is missing (see
 * packages/voice/src/mic.ts). A mandatory timeout with SIGKILL covers both.
 */

export interface RunOptions {
  readonly timeoutMs: number;
  readonly stdin?: string | undefined;
}

export interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly ms: number;
}

export class RunTimeoutError extends Error {
  constructor(command: string, timeoutMs: number) {
    super(`${command} did not finish within ${timeoutMs}ms and was killed`);
    this.name = "RunTimeoutError";
  }
}

export function run(command: string, args: readonly string[], opts: RunOptions): Promise<RunResult> {
  const startedAt = Date.now();
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(command, [...args]);
    let stdout = "";
    let stderr = "";
    let settled = false;

    const killer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new RunTimeoutError(command, opts.timeoutMs));
    }, opts.timeoutMs);

    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    // A command that exits before reading stdin (or never spawns) raises EPIPE
    // here; that is the child's business, not a reason to crash this process.
    child.stdin.on("error", () => undefined);
    if (opts.stdin !== undefined) child.stdin.write(opts.stdin);
    child.stdin.end();

    child.on("error", (e) => {
      clearTimeout(killer);
      if (settled) return;
      settled = true;
      reject(new Error(`${command} failed to spawn: ${e.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(killer);
      if (settled) return;
      settled = true;
      resolve({ code, stdout, stderr, ms: Date.now() - startedAt });
    });
  });
}
