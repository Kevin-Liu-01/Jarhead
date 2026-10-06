// W3-3 (the review): `jarhead ledger search` reads every live day. The daemon answers one page per request (32 MB of
// day files, `older` where it stopped), so the CLI asks again from there until it has its hits or nothing older is
// left. An older page that does not answer keeps the hits so far, and the last line names the days left unread.
// The CLI runs as a process against a daemon stand-in on a unix socket: no real daemon, no key, nothing under ~/.jarhead.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FRAME_JSON, FrameParser, encodeJson, type ClientMessage } from "@jarhead/daemon";

const stateDir = mkdtempSync(join(tmpdir(), "jh-cli-w33-"));
after(() => rmSync(stateDir, { recursive: true, force: true }));
const MAIN = join(dirname(fileURLToPath(import.meta.url)), "..", "main.ts");

function jarhead(args: readonly string[], socket: string): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", MAIN, ...args], {
      env: { ...process.env, JARHEAD_STATE_DIR: stateDir, JARHEAD_AUTO_WAKE: "0", JARHEAD_NO_AUDIO: "1", JARHEAD_SOCKET: socket },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (err += c.toString()));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

type Search = Extract<ClientMessage, { type: "ledger.search" }>;

/** A daemon stand-in that answers `ledger.search` with `page(msg)` (undefined: stays silent) and keeps every search it was asked. */
function fakeDaemon(path: string, page: (msg: Search) => Record<string, unknown> | undefined): Promise<{ server: Server; asked: Search[] }> {
  const asked: Search[] = [];
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      const parser = new FrameParser();
      socket.on("error", () => undefined);
      socket.on("data", (chunk: Buffer) => {
        for (const f of parser.push(chunk)) {
          if (f.type !== FRAME_JSON) continue;
          const msg = JSON.parse(f.payload.toString("utf8")) as ClientMessage;
          if (msg.type !== "ledger.search") continue;
          asked.push(msg);
          const reply = page(msg);
          if (reply !== undefined) socket.write(encodeJson({ type: "ledger.hits", id: msg.id, ...reply }));
        }
      });
    });
    server.listen(path, () => resolve({ server, asked }));
  });
}

/** One hit on a day at 09:00 local. */
const hit = (day: string, text: string): Record<string, unknown> => ({ sessionId: `s_${day}`, chainId: `s_${day}`, state: "active", at: new Date(`${day}T09:00:00`).getTime(), kind: "heard", text });

/** Three day files, one per page, newest first: `older` names the day each page stopped after. */
const PAGES: Record<string, Record<string, unknown>> = {
  "-": { hits: [hit("2026-09-12", "the needle on the twelfth")], older: "2026-09-12" },
  "2026-09-12": { hits: [hit("2026-09-11", "the needle on the eleventh")], older: "2026-09-11" },
  "2026-09-11": { hits: [hit("2026-09-10", "the needle on the tenth")] },
};

test("jarhead ledger search: reads on page by page from each page's older until nothing older is left, asks each page for what is still missing, and prints every hit; an older page that never answers keeps the hits and names the days left unread", async () => {
  const whole = await fakeDaemon(join(stateDir, "w.sock"), (msg) => PAGES[msg.before ?? "-"]);
  const stalls = await fakeDaemon(join(stateDir, "s.sock"), (msg) => (msg.before === "2026-09-12" ? undefined : PAGES[msg.before ?? "-"]));
  const limited = await fakeDaemon(join(stateDir, "l.sock"), (msg) => PAGES[msg.before ?? "-"]);
  try {
    const [all, stalled, two, help] = await Promise.all([
      jarhead(["ledger", "search", "needle"], join(stateDir, "w.sock")),
      jarhead(["ledger", "search", "needle"], join(stateDir, "s.sock")),
      jarhead(["ledger", "search", "needle", "--limit", "2"], join(stateDir, "l.sock")),
      jarhead(["help"], join(stateDir, "nobody.sock")),
    ]);

    assert.equal(all.code, 0, all.err);
    for (const day of ["twelfth", "eleventh", "tenth"]) assert.match(all.out, new RegExp(`the needle on the ${day}`), day);
    assert.match(all.out, /\n  3 hits\n/);
    assert.doesNotMatch(all.out, /not searched/);
    assert.deepEqual(whole.asked.map((m) => [m.before ?? "-", m.limit]), [["-", 50], ["2026-09-12", 49], ["2026-09-11", 48]], "each page from the last page's older, asking for what is still missing");

    assert.equal(stalled.code, 0, stalled.err);
    assert.match(stalled.out, /the needle on the twelfth/);
    assert.match(stalled.out, /\n  1 hit\n  Days before 2026-09-12 were not searched\. The daemon did not answer in 5 s\.\n/);

    assert.equal(two.code, 0, two.err);
    assert.match(two.out, /\n  2 hits · limit 2 \(--limit N for more\)\n/);
    assert.deepEqual(limited.asked.map((m) => m.before ?? "-"), ["-", "2026-09-12"], "the limit reached: no page past it");

    assert.match(help.out, /jarhead ledger search "<words>" \[--limit N\] .*over every live day/);
    assert.doesNotMatch(help.out, /months of use/);
  } finally {
    whole.server.close();
    stalls.server.close();
    limited.server.close();
  }
});
