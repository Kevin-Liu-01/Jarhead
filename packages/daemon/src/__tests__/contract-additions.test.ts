// W2-5 on the socket: the two hellos carry PROTOCOL_VERSION (APP-3) and the ledger.days reply carries the
// day totals (LM-6). Both are optional, so a peer from before them still parses. The frames go through the
// wire's own encoder and parser, the way the server and the app read them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PROTOCOL_VERSION, type LedgerDayTotals } from "@jarhead/protocol";
import { FRAME_JSON, FrameParser, encodeJson, parseClientMessage, type ClientMessage, type DaemonMessage } from "../wire.ts";

const roundTrip = (message: DaemonMessage | ClientMessage): Record<string, unknown> => {
  const frames = new FrameParser().push(encodeJson(message));
  assert.equal(frames.length, 1);
  assert.equal(frames[0]?.type, FRAME_JSON);
  return JSON.parse((frames[0]?.payload ?? Buffer.alloc(0)).toString("utf8")) as Record<string, unknown>;
};

test("APP-3: the daemon's hello and the app's hello each carry PROTOCOL_VERSION; a hello without it (a peer from before the field) still parses", () => {
  const daemon: DaemonMessage = { type: "hello", version: "2.0.0", pid: 41, stateDir: "/tmp/jh", protocol: PROTOCOL_VERSION };
  assert.equal(roundTrip(daemon)["protocol"], PROTOCOL_VERSION);
  const app: ClientMessage = { type: "hello", pid: 42, version: "2.0.0", audio: true, protocol: PROTOCOL_VERSION };
  const parsed = parseClientMessage(encodeJson(app).subarray(5));
  assert.ok(parsed?.type === "hello");
  assert.equal(parsed.protocol, PROTOCOL_VERSION);
  const before = parseClientMessage(Buffer.from(JSON.stringify({ type: "hello", pid: 42, version: "2.0.0", audio: true })));
  assert.ok(before?.type === "hello");
  assert.equal(before.protocol, undefined, "absent: the app predates the field, which a surface reads as a skew");
});

test("LM-6: the ledger.days reply keeps its day list and carries each day's totals beside it", () => {
  const totals: LedgerDayTotals[] = [
    { day: "2026-10-05", sessions: 4, billedSeconds: 603 },
    { day: "2026-10-04", sessions: 0, billedSeconds: 0 },
  ];
  const reply: DaemonMessage = { type: "ledger.days", id: "q1", days: ["2026-10-05", "2026-10-04"], totals };
  const back = roundTrip(reply);
  assert.deepEqual(back["days"], ["2026-10-05", "2026-10-04"], "an app that reads only the list still gets it");
  assert.deepEqual(back["totals"], totals);
  const bare: DaemonMessage = { type: "ledger.days", id: "q2", days: [] };
  assert.equal(roundTrip(bare)["totals"], undefined, "a daemon from before the totals sends the list alone");
});
