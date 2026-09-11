import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AnnotateClient,
  AnnotateServer,
  MAX_CELLS,
  parseCommand,
  parseReply,
  serializeCommand,
  serializeReply,
  splitLines,
  type AnnotateCommand,
  type AnnotateHandler,
} from "../protocol.ts";

test("every command round-trips through serialize → parse, negative coordinates included", () => {
  const commands: AnnotateCommand[] = [
    { cmd: "draw", id: "a1", x: 812.5, y: -2100, shape: { kind: "arrow", direction: "NE", length: 6 } },
    { cmd: "draw", id: "ring", x: -400, y: 300, shape: { kind: "circle", radius: 4 } },
    { cmd: "draw", id: "b", x: 0, y: 0, shape: { kind: "box", w: 20, h: 6 } },
    { cmd: "draw", id: "br", x: 5, y: 5, shape: { kind: "bracket", side: "right", height: 9 } },
    { cmd: "draw", id: "l", x: 100, y: 100, shape: { kind: "label", text: "click here", maxWidth: 18 } },
    { cmd: "draw", id: "u", x: 1, y: 2, shape: { kind: "underline", width: 32 } },
    { cmd: "draw", id: "c", x: -1, y: -1, shape: { kind: "crosshair", size: 7 } },
    { cmd: "erase", id: "a1" },
    { cmd: "clear" },
    { cmd: "pulse", id: "ring" },
    { cmd: "trail", from: { x: -2560, y: -2160 }, to: { x: 400, y: 900 } },
  ];
  for (const command of commands) {
    const line = serializeCommand(command);
    assert.ok(line.endsWith("\n"), "wire format is newline-delimited");
    const parsed = parseCommand(line.trimEnd());
    assert.ok(parsed.ok, `expected ok for ${line.trim()}, got ${JSON.stringify(parsed)}`);
    if (parsed.ok) assert.deepEqual(parsed.command, command);
  }
});

test("draw travels flat on the wire: shape name and options are top-level fields", () => {
  const line = serializeCommand({
    cmd: "draw",
    id: "a1",
    x: 10,
    y: 20,
    shape: { kind: "arrow", direction: "SW", length: 5 },
  });
  const raw = JSON.parse(line) as Record<string, unknown>;
  assert.equal(raw["shape"], "arrow");
  assert.equal(raw["direction"], "SW");
  assert.equal(raw["length"], 5);
  assert.equal(raw["kind"], undefined, "the internal discriminant never leaks onto the wire");
});

test("malformed and hostile input is rejected with a reason, never coerced", () => {
  const bad = [
    "not json at all",
    "42",
    "[1,2,3]",
    "{}",
    '{"cmd":"scribble"}',
    '{"cmd":"draw"}',
    '{"cmd":"draw","id":"","shape":"box","x":0,"y":0,"w":4,"h":4}',
    `{"cmd":"draw","id":"${"x".repeat(65)}","shape":"box","x":0,"y":0,"w":4,"h":4}`,
    '{"cmd":"draw","id":"a","shape":"box","x":"12","y":0,"w":4,"h":4}',
    '{"cmd":"draw","id":"a","shape":"box","x":1e999,"y":0,"w":4,"h":4}',
    '{"cmd":"draw","id":"a","shape":"nonagon","x":0,"y":0}',
    '{"cmd":"draw","id":"a","shape":"arrow","x":0,"y":0,"direction":"UP","length":4}',
    '{"cmd":"draw","id":"a","shape":"arrow","x":0,"y":0,"direction":"N","length":1}',
    '{"cmd":"draw","id":"a","shape":"arrow","x":0,"y":0,"direction":"N","length":2.5}',
    `{"cmd":"draw","id":"a","shape":"circle","x":0,"y":0,"radius":${MAX_CELLS + 1}}`,
    '{"cmd":"draw","id":"a","shape":"circle","x":0,"y":0,"radius":1e9}',
    '{"cmd":"draw","id":"a","shape":"box","x":0,"y":0,"w":4}',
    '{"cmd":"draw","id":"a","shape":"bracket","x":0,"y":0,"side":"top","height":4}',
    '{"cmd":"draw","id":"a","shape":"label","x":0,"y":0,"text":"  ","maxWidth":10}',
    `{"cmd":"draw","id":"a","shape":"label","x":0,"y":0,"text":"${"y".repeat(2001)}","maxWidth":10}`,
    '{"cmd":"draw","id":"a","shape":"label","x":0,"y":0,"text":"hi","maxWidth":0}',
    '{"cmd":"draw","id":"a","shape":"crosshair","x":0,"y":0,"size":2}',
    '{"cmd":"erase"}',
    '{"cmd":"erase","id":42}',
    '{"cmd":"pulse","id":null}',
    '{"cmd":"trail"}',
    '{"cmd":"trail","from":{"x":0,"y":0},"to":{"x":"far","y":0}}',
    '{"cmd":"trail","from":[0,0],"to":{"x":1,"y":1}}',
  ];
  for (const line of bad) {
    const parsed = parseCommand(line);
    assert.equal(parsed.ok, false, `should reject ${line.slice(0, 80)}`);
    if (!parsed.ok) assert.ok(parsed.error.length > 0, "rejection must carry a reason");
  }
});

test("replies round-trip, and garbage replies degrade to a described failure", () => {
  assert.deepEqual(parseReply(serializeReply({ ok: true, error: undefined }).trimEnd()), {
    ok: true,
    error: undefined,
  });
  assert.deepEqual(parseReply(serializeReply({ ok: false, error: "nope" }).trimEnd()), {
    ok: false,
    error: "nope",
  });
  const garbage = parseReply("<html>proxy error</html>");
  assert.equal(garbage.ok, false);
  assert.ok(garbage.error && garbage.error.includes("unparseable"));
});

test("splitLines reassembles lines across arbitrary chunk boundaries", () => {
  const first = splitLines("", '{"cmd":"cl');
  assert.deepEqual(first.lines, []);
  assert.equal(first.rest, '{"cmd":"cl');

  const second = splitLines(first.rest, 'ear"}\n{"cmd":"clear"}\n\n{"cmd":"pu');
  assert.deepEqual(second.lines, ['{"cmd":"clear"}', '{"cmd":"clear"}']);
  assert.equal(second.rest, '{"cmd":"pu');
});

interface Wired {
  readonly server: AnnotateServer;
  readonly client: AnnotateClient;
  readonly calls: string[];
}

async function wire(name: string, overrides: Partial<AnnotateHandler> = {}): Promise<Wired> {
  const calls: string[] = [];
  const handler: AnnotateHandler = {
    draw: (command) => void calls.push(`draw:${command.id}:${command.shape.kind}@${command.x},${command.y}`),
    erase: (id) => void calls.push(`erase:${id}`),
    clear: () => void calls.push("clear"),
    pulse: (id) => void calls.push(`pulse:${id}`),
    trail: (from, to) => void calls.push(`trail:${from.x},${from.y}→${to.x},${to.y}`),
    ...overrides,
  };
  const socketPath = join(tmpdir(), `jarvis-annotate-${name}-${process.pid}.sock`);
  const server = new AnnotateServer(handler, socketPath);
  await server.listen();
  return { server, client: new AnnotateClient(socketPath), calls };
}

test("client commands reach the handler over a real unix socket, in order", async () => {
  const { server, client, calls } = await wire("roundtrip");
  try {
    await client.draw("a1", { kind: "crosshair", size: 5 }, -120, -2000);
    await client.pulse("a1");
    await client.trail({ x: 0, y: 0 }, { x: 50, y: -50 });
    await client.erase("a1");
    await client.clear();
    assert.deepEqual(calls, [
      "draw:a1:crosshair@-120,-2000",
      "pulse:a1",
      "trail:0,0→50,-50",
      "erase:a1",
      "clear",
    ]);
  } finally {
    client.close();
    await server.close();
  }
});

test("a handler that throws surfaces as a rejected command, not a dead socket", async () => {
  const { server, client, calls } = await wire("throws", {
    pulse: () => {
      throw new Error("no annotation with id ghost");
    },
  });
  try {
    await assert.rejects(client.pulse("ghost"), /no annotation/);
    // The connection survives the refusal.
    await client.clear();
    assert.deepEqual(calls, ["clear"]);
  } finally {
    client.close();
    await server.close();
  }
});

test("a raw malformed line gets an ok:false reply and the server keeps serving", async () => {
  const { server, client, calls } = await wire("malformed");
  try {
    // Bypass the typed client to send garbage the way a broken caller would.
    await assert.rejects(
      client.send({ cmd: "draw", id: "a", x: 0, y: 0, shape: { kind: "circle", radius: -3 } } as AnnotateCommand),
      /radius/,
    );
    await client.clear();
    assert.deepEqual(calls, ["clear"]);
  } finally {
    client.close();
    await server.close();
  }
});

test("connecting to a socket nobody is listening on fails with an actionable error", async () => {
  const client = new AnnotateClient(join(tmpdir(), `jarvis-annotate-absent-${process.pid}.sock`));
  await assert.rejects(client.clear(), /Is the app running/);
});
