// W3-5, BL-13: the sessions connector and the runs it drives read one clock, and no timer it sets asks Node for more
// than Node keeps (2^31 − 1 ms). The suite logged ~216 TimeoutOverflowWarnings a run: a resumed Claude session stamped
// its activity on the wall clock while the connector's test clock sat weeks behind it, so waitSettled's recheck asked
// for a 33-day timer, Node fired it after 1 ms, and the check spun every millisecond until the run settled.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AsyncQueue } from "../../claude-code/queue.ts";
import type { SdkLike, SdkMessage, SdkUserMessage } from "../../claude-code/session.ts";
import { SessionsConnector } from "../connector.ts";

const DAY = 86_400_000;
const S1 = "11111111-1111-4111-8111-111111111111";
const ID = `sessions:claude:${S1}`;

/** A temp home holding one Claude Code session whose folder exists, written `at` (on the connector's clock). */
function home(at: number): { home: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "jarhead-w35-"));
  const cwd = join(dir, "demo-app");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(dir, "empty-bin"), { recursive: true });
  mkdirSync(join(dir, ".claude", "sessions"), { recursive: true });
  const project = join(dir, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(project, { recursive: true });
  const file = join(project, `${S1}.jsonl`);
  const ts = new Date(at - 60_000).toISOString();
  writeFileSync(
    file,
    [
      JSON.stringify({ type: "user", message: { role: "user", content: "fix the login bug" }, timestamp: ts, cwd, sessionId: S1 }),
      JSON.stringify({ type: "assistant", message: { id: "msg_1", role: "assistant", content: [{ type: "text", text: "Fixed." }] }, timestamp: ts, cwd, sessionId: S1 }),
    ].join("\n") + "\n",
  );
  utimesSync(file, new Date(at - 60_000), new Date(at - 60_000));
  return { home: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A scripted Claude: every user message is answered with one text block and a result, `delayMs` later. */
function fakeSdk(delayMs: number): SdkLike {
  return {
    query({ prompt, options }: { prompt: AsyncIterable<SdkUserMessage>; options?: Record<string, unknown> }) {
      const out = new AsyncQueue<SdkMessage>();
      out.push({ type: "system", subtype: "init", session_id: String(options?.["resume"] ?? "new"), model: "claude-fable-5-1" });
      void (async () => {
        for await (const _ of prompt) {
          await new Promise((r) => setTimeout(r, delayMs));
          out.push({ type: "assistant", parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
          out.push({ type: "result", subtype: "success", is_error: false, result: "done" });
        }
        out.close();
      })();
      return Object.assign(out, { interrupt: async () => undefined });
    },
  };
}

function connector(h: string, now: () => number, sdk: SdkLike): SessionsConnector {
  return new SessionsConnector({
    home: h,
    env: { PATH: join(h, "empty-bin"), HOME: h },
    applicationsDir: join(h, "Applications"),
    cliSystemDirs: [],
    now,
    processes: async () => [],
    sdk,
    processCacheMs: 0,
    settlePollMs: 10,
    settleQuietMs: 40,
  });
}

/** Every TimeoutOverflowWarning this process emits while `f` runs (and one turn after, since warnings arrive on nextTick). */
async function overflows<T>(f: () => Promise<T>): Promise<{ value: T; warnings: string[] }> {
  const warnings: string[] = [];
  const on = (w: Error): void => {
    if (w.name === "TimeoutOverflowWarning") warnings.push(w.message);
  };
  process.on("warning", on);
  try {
    const value = await f();
    await new Promise((r) => setImmediate(r));
    return { value, warnings };
  } finally {
    process.off("warning", on);
  }
}

test("BL-13: a resumed run reads the connector's clock, so waitSettled on a clock weeks behind the wall asks for no timer Node cannot keep", async () => {
  const NOW = Date.now() - 40 * DAY; // weeks behind the wall clock, as the sessions tests' fixed NOW is
  const h = home(NOW);
  const c = connector(h.home, () => NOW, fakeSdk(150));
  try {
    const { value: settled, warnings } = await overflows(async () => {
      assert.equal((await c.send(ID, "and the signup path")).accepted, true);
      return c.waitSettled(ID, 5_000);
    });
    assert.deepEqual(warnings, [], "no TimeoutOverflowWarning: the recheck waits for the stall bound, never weeks");
    assert.equal(settled.status, "idle", "the wait ended when the run did");
    assert.equal(settled.updatedAt, NOW, "the run's last activity was stamped on the connector's clock, not the wall clock");
  } finally {
    await c.closeAll();
    h.cleanup();
  }
});

test("BL-13: a clock that steps back weeks while a run works still gets a recheck within the stall bound", async () => {
  let offset = 0;
  const now = (): number => Date.now() + offset;
  const h = home(now());
  const c = connector(h.home, now, fakeSdk(150));
  try {
    const { value: settled, warnings } = await overflows(async () => {
      assert.equal((await c.send(ID, "keep going")).accepted, true);
      offset = -40 * DAY; // the run stamped its activity on the old time; the clock now reads 40 days earlier
      return c.waitSettled(ID, 5_000);
    });
    assert.deepEqual(warnings, [], "the recheck is clamped to the stall bound however far ahead of the clock the run's stamp sits");
    assert.equal(settled.status, "idle");
  } finally {
    await c.closeAll();
    h.cleanup();
  }
});

test("BL-13: waitSettled with a timeout past Node's timer ceiling still waits for the run instead of returning at once", async () => {
  const h = home(Date.now());
  const c = connector(h.home, Date.now, fakeSdk(150));
  try {
    const { value, warnings } = await overflows(async () => {
      assert.equal((await c.send(ID, "one more")).accepted, true);
      const t0 = Date.now();
      const settled = await c.waitSettled(ID, 30 * DAY);
      return { settled, took: Date.now() - t0 };
    });
    assert.deepEqual(warnings, [], "a 30-day agent_wait is held at Node's ceiling, not fired after 1 ms");
    assert.equal(value.settled.status, "idle", `waited for the run (${value.took} ms), not returned while it was still working`);
  } finally {
    await c.closeAll();
    h.cleanup();
  }
});
