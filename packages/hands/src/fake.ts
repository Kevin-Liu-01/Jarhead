import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, spawn } from "node:child_process";
import type { NativeHands } from "./native.ts";

/**
 * A stand-in for the Swift helper as a child process: every request line the
 * client writes is answered by `hands.request(op, params)` on the fake's stdout,
 * in the helper's JSON shape. Tests and `jarhead bench --fake-hands` plug this in
 * as `spawnImpl`, so the real client code — the pending map, timeouts, a stop's
 * cancelPending, the late-answer drop — runs unchanged over canned answers.
 */
export function fakeHandsSpawn(hands: NativeHands): typeof spawn {
  return ((): ChildProcess => {
    const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; exitCode: number | null; signalCode: NodeJS.Signals | null; pid: number; kill(): boolean };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.pid = 424242;
    let buffer = "";
    child.stdin.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        let req: { id?: string; op?: string } & Record<string, unknown>;
        try {
          req = JSON.parse(line) as typeof req;
        } catch {
          continue;
        }
        const { id, op, ...params } = req;
        void hands
          .request(String(op), params)
          .then((result) => {
            if (child.exitCode === null) child.stdout.write(`${JSON.stringify({ id, ok: true, result: result ?? {} })}\n`);
          })
          .catch((e: Error & { detail?: { code?: string } }) => {
            if (child.exitCode === null) child.stdout.write(`${JSON.stringify({ id, ok: false, error: { code: e.detail?.code ?? "internal", message: e.message } })}\n`);
          });
      }
    });
    child.kill = () => {
      child.exitCode = 0;
      setImmediate(() => child.emit("exit", 0, null));
      return true;
    };
    setImmediate(() => child.emit("spawn"));
    return child as unknown as ChildProcess;
  }) as unknown as typeof spawn;
}
