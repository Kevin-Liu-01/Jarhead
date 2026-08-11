import { spawn } from "node:child_process";
import { captureDiff, digestOfDiff, type SelfModProposal } from "./proposal.ts";

/**
 * The proof gate (DECISION.md §7 step 2): `pnpm run check` inside the
 * worktree — typecheck, tests, doctor. A proposal that fails here can never
 * be approved; the approval layer refuses to even ask the question.
 *
 * The runner is injected so the refusal logic is testable without spending
 * minutes on a real build. The default runner is the real thing.
 */

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type CommandRunner = (command: string, args: readonly string[], cwd: string) => Promise<CommandResult>;

export const GATE_COMMAND = ["pnpm", "run", "check"] as const;

export interface GateResult {
  readonly proposalId: string;
  /** Digest of the worktree diff at the moment the gate ran — what a green result actually proves. */
  readonly digest: string;
  readonly passed: boolean;
  readonly exitCode: number;
  readonly command: string;
  readonly output: string;
  readonly startedAt: string;
  readonly durationMs: number;
}

/**
 * Spawns the check with a hard timeout. Same lesson as the mic: a child that
 * will never finish is a worse failure than a red gate, and a wedged test
 * runner would otherwise park the whole proposal pipeline forever.
 */
/** Kill the whole process group, falling back to the single pid. */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

export function defaultRunner(timeoutMs = 10 * 60 * 1000): CommandRunner {
  return (command, args, cwd) =>
    new Promise((resolvePromise) => {
      // detached puts the wrapper in its own process group so the timeout can
      // kill the whole tree. `pnpm run check` is only a launcher — SIGKILL on it
      // alone leaves tsc and tsx running, holding the pipes and burning CPU long
      // after the gate reported a timeout.
      const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
      let stdout = "";
      let stderr = "";
      let settled = false;

      const guard = setTimeout(() => {
        if (settled) return;
        settled = true;
        killTree(child.pid);
        resolvePromise({ code: 124, stdout, stderr: `${stderr}\n[gate] killed after ${timeoutMs}ms without finishing` });
      }, timeoutMs);

      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("error", (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        resolvePromise({ code: 127, stdout, stderr: `failed to spawn ${command}: ${e.message}` });
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        resolvePromise({ code: code ?? 1, stdout, stderr });
      });
    });
}

export interface RunGateOptions {
  readonly runner?: CommandRunner;
}

export async function runGate(proposal: SelfModProposal, opts: RunGateOptions = {}): Promise<GateResult> {
  const runner = opts.runner ?? defaultRunner();
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const command = GATE_COMMAND.join(" ");

  // The gate certifies bytes, not a directory. If the worktree no longer
  // produces the proposal's diff, a green check would prove the wrong thing —
  // so refuse to run it at all and report the drift as a failure.
  const currentDigest = digestOfDiff(await captureDiff(proposal.worktreePath, proposal.baseRef));
  if (currentDigest !== proposal.digest) {
    return {
      proposalId: proposal.proposalId,
      digest: currentDigest,
      passed: false,
      exitCode: -1,
      command,
      output: `worktree drifted from proposal ${proposal.proposalId}: expected diff digest ${proposal.digest}, found ${currentDigest}. check not run.`,
      startedAt,
      durationMs: Date.now() - t0,
    };
  }

  const [cmd, ...args] = GATE_COMMAND;
  const res = await runner(cmd, args, proposal.worktreePath);

  return {
    proposalId: proposal.proposalId,
    digest: proposal.digest,
    passed: res.code === 0,
    exitCode: res.code,
    command,
    output: tail(`${res.stdout}${res.stderr}`),
    startedAt,
    durationMs: Date.now() - t0,
  };
}

/** Failures print last, so the tail is the part worth keeping. */
function tail(text: string, max = 12_000): string {
  return text.length <= max ? text : `…${text.slice(text.length - max)}`;
}
