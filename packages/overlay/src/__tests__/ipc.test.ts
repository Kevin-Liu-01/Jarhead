import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OverlayClient,
  OverlayServer,
  parseCommand,
  parseReply,
  serializeCommand,
  serializeReply,
  splitLines,
  type OverlayCommand,
  type OverlayHandler,
} from "../ipc.ts";

test("every command round-trips through serialize → parse", () => {
  const commands: OverlayCommand[] = [
    { cmd: "setState", state: "thinking" },
    { cmd: "flyTo", x: 812.5, y: -140 },
    { cmd: "say", text: "found it — top left", ttlMs: 4000 },
    { cmd: "say", text: "no ttl", ttlMs: undefined },
    { cmd: "hide" },
    { cmd: "show" },
    { cmd: "setInteractive", interactive: true },
  ];
  for (const command of commands) {
    const line = serializeCommand(command);
    assert.ok(line.endsWith("\n"), "wire format is newline-delimited");
    const parsed = parseCommand(line.trimEnd());
    assert.ok(parsed.ok, `expected ok for ${line.trim()}, got ${JSON.stringify(parsed)}`);
    if (parsed.ok) assert.deepEqual(parsed.command, command);
  }
});

test("malformed input is rejected with a reason, never coerced", () => {
  const bad = [
    "not json at all",
    "42",
    "[1,2,3]",
    "{}",
    '{"cmd":"dance"}',
    '{"cmd":"setState","state":"dancing"}',
    '{"cmd":"setState","state":"hidden"}',
    '{"cmd":"flyTo","x":"12","y":5}',
    '{"cmd":"flyTo","x":1e999,"y":0}',
    '{"cmd":"flyTo"}',
    '{"cmd":"say","text":""}',
    '{"cmd":"say","text":"hi","ttlMs":"soon"}',
    '{"cmd":"say","text":"hi","ttlMs":-5}',
    '{"cmd":"setInteractive","interactive":"yes"}',
  ];
  for (const line of bad) {
    const parsed = parseCommand(line);
    assert.equal(parsed.ok, false, `should reject ${line}`);
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
  const first = splitLines("", '{"cmd":"hi');
  assert.deepEqual(first.lines, []);
  assert.equal(first.rest, '{"cmd":"hi');

  const second = splitLines(first.rest, 'de"}\n{"cmd":"show"}\n\n{"cmd":"sh');
  assert.deepEqual(second.lines, ['{"cmd":"hide"}', '{"cmd":"show"}']);
  assert.equal(second.rest, '{"cmd":"sh');

  const third = splitLines(second.rest, 'ow"}\n');
  assert.deepEqual(third.lines, ['{"cmd":"show"}']);
  assert.equal(third.rest, "");
});

interface Wired {
  readonly server: OverlayServer;
  readonly client: OverlayClient;
  readonly calls: string[];
}

async function wire(name: string, overrides: Partial<OverlayHandler> = {}): Promise<Wired> {
  const calls: string[] = [];
  const handler: OverlayHandler = {
    setState: (state) => void calls.push(`setState:${state}`),
    flyTo: (x, y) => void calls.push(`flyTo:${x},${y}`),
    say: (text, ttlMs) => void calls.push(`say:${text}:${ttlMs}`),
    hide: () => void calls.push("hide"),
    show: () => void calls.push("show"),
    setInteractive: (interactive) => void calls.push(`interactive:${interactive}`),
    ...overrides,
  };
  const socketPath = join(tmpdir(), `jarvis-overlay-${name}-${process.pid}.sock`);
  const server = new OverlayServer(handler, socketPath);
  await server.listen();
  return { server, client: new OverlayClient(socketPath), calls };
}

test("client commands reach the handler over a real unix socket, in order", async () => {
  const { server, client, calls } = await wire("roundtrip");
  try {
    await client.setState("listening");
    await client.flyTo(120, 340);
    await client.say("hello", 500);
    await client.say("untimed");
    await client.setInteractive(true);
    await client.hide();
    await client.show();
    assert.deepEqual(calls, [
      "setState:listening",
      "flyTo:120,340",
      "say:hello:500",
      "say:untimed:undefined",
      "interactive:true",
      "hide",
      "show",
    ]);
  } finally {
    client.close();
    await server.close();
  }
});

test("a handler that throws surfaces as a rejected command, not a dead socket", async () => {
  const { server, client, calls } = await wire("throws", {
    flyTo: () => {
      throw new Error("overlay is hidden; send show first");
    },
  });
  try {
    await assert.rejects(client.flyTo(10, 10), /hidden/);
    // The connection survives the refusal.
    await client.show();
    assert.deepEqual(calls, ["show"]);
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
      client.send({ cmd: "setState", state: "dancing" } as unknown as OverlayCommand),
      /unknown state/,
    );
    await client.setState("idle");
    assert.deepEqual(calls, ["setState:idle"]);
  } finally {
    client.close();
    await server.close();
  }
});

test("connecting to a socket nobody is listening on fails with an actionable error", async () => {
  const client = new OverlayClient(join(tmpdir(), `jarvis-overlay-absent-${process.pid}.sock`));
  await assert.rejects(client.show(), /Is the overlay running/);
});
