import { test } from "node:test";
import assert from "node:assert/strict";
import { CODEX_MCP_SERVER, codexBridgeEnv, codexMcpConfigArgs, type CodexMcpConfig } from "../codex-config.ts";

/**
 * The bridge's env in the Codex argv: `JARHEAD_SOCKET`, plus `JARHEAD_THREAD` when the
 * Codex process is a thread's brain. Both forms are pinned byte for byte — codex.test.ts
 * reads the same argv — because Codex parses the value as TOML.
 */

const base: CodexMcpConfig = {
  node: "/usr/local/bin/node",
  tsxCli: "/repo/node_modules/tsx/dist/cli.mjs",
  bridgePath: "/repo/packages/brain/src/mcp-bridge.ts",
  socketPath: "/Users/k/.jarhead/jarhead.sock",
};

const ENV_KEY = `mcp_servers.${CODEX_MCP_SERVER}.env=`;
const envArg = (args: readonly string[]): string => args.find((a) => a.startsWith(ENV_KEY)) ?? "";

test("codex-config: for the main brain the bridge env is exactly {JARHEAD_SOCKET=…} — one key, no thread", () => {
  const args = codexMcpConfigArgs(base);
  assert.equal(args.filter((a) => a === "-c").length, 6, "six -c pairs, as the exec argv always had");
  assert.equal(envArg(args), 'mcp_servers.jarhead.env={JARHEAD_SOCKET="/Users/k/.jarhead/jarhead.sock"}');
  assert.ok(!args.some((a) => a.includes("JARHEAD_THREAD")), "no thread key anywhere in the argv");
  assert.deepEqual(codexMcpConfigArgs({ ...base, thread: undefined }), args);
  assert.deepEqual(codexMcpConfigArgs({ ...base, thread: "" }), args, "an empty id is no thread");
});

test("codex-config: a thread rides into the bridge env as JARHEAD_THREAD next to the socket, and nothing else in the argv moves", () => {
  const plain = codexMcpConfigArgs(base);
  const thread = codexMcpConfigArgs({ ...base, thread: "t_7f3a" });
  assert.equal(thread.length, plain.length);
  const changed = plain.map((a, i) => [a, thread[i]] as const).filter(([a, b]) => a !== b);
  assert.deepEqual(changed, [
    ['mcp_servers.jarhead.env={JARHEAD_SOCKET="/Users/k/.jarhead/jarhead.sock"}', 'mcp_servers.jarhead.env={JARHEAD_SOCKET="/Users/k/.jarhead/jarhead.sock", JARHEAD_THREAD="t_7f3a"}'],
  ]);
  assert.equal(codexBridgeEnv({ socketPath: base.socketPath, thread: "t_7f3a" }), '{JARHEAD_SOCKET="/Users/k/.jarhead/jarhead.sock", JARHEAD_THREAD="t_7f3a"}');
});

test("codex-config: the thread id is a TOML basic string — quotes, backslashes and a stray brace cannot break out of the inline table", () => {
  const hostile = 't"} \\ evil';
  const env = codexBridgeEnv({ socketPath: base.socketPath, thread: hostile });
  assert.equal(env, `{JARHEAD_SOCKET="/Users/k/.jarhead/jarhead.sock", JARHEAD_THREAD=${JSON.stringify(hostile)}}`);
  // Two keys, both quoted, one table: the shape a TOML inline table has.
  assert.match(env, /^\{JARHEAD_SOCKET="[^"]*", JARHEAD_THREAD="(?:[^"\\]|\\.)*"\}$/);
  assert.equal(envArg(codexMcpConfigArgs({ ...base, thread: hostile })), `${ENV_KEY}${env}`);
});

// ------------------------------------------------------------ TOML, not regex
//
// Codex reads a `-c key=value` value as TOML. No TOML library is in the tree, so a strict
// reader for the one shape the bridge env uses stands in for a live Codex parse (which
// would open a paid session): an inline table of bare keys and basic strings, TOML 1.0 —
// no trailing comma, no newline inside the braces, escapes only from TOML's list, no raw
// control characters. Anything else throws, so the reader is not a mirror of the writer.

const BARE_KEY = /^[A-Za-z0-9_-]+/;
const SHORT_ESCAPES: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };

function readTomlInlineTable(text: string): Map<string, string> {
  let i = 0;
  const ws = (): void => {
    while (text[i] === " " || text[i] === "\t") i++;
  };
  const fail = (why: string): never => {
    throw new Error(`not a TOML inline table at ${i}: ${why}`);
  };
  const basicString = (): string => {
    if (text[i] !== '"') fail("a value must be a basic string here");
    i++;
    let out = "";
    for (;;) {
      const c = text[i];
      if (c === undefined) return fail("unterminated string");
      if (c === '"') {
        i++;
        return out;
      }
      if (c === "\\") {
        const e = text[i + 1];
        if (e !== undefined && e in SHORT_ESCAPES) {
          out += SHORT_ESCAPES[e]!;
          i += 2;
          continue;
        }
        const width = e === "u" ? 4 : e === "U" ? 8 : 0;
        if (!width) fail(`\\${String(e)} is not a TOML escape`);
        const hex = text.slice(i + 2, i + 2 + width);
        if (!new RegExp(`^[0-9A-Fa-f]{${width}}$`).test(hex)) fail("bad unicode escape");
        out += String.fromCodePoint(Number.parseInt(hex, 16));
        i += 2 + width;
        continue;
      }
      const code = c.codePointAt(0)!;
      if (code < 0x20 || code === 0x7f) fail("a raw control character inside a basic string");
      out += c;
      i++;
    }
  };
  const table = new Map<string, string>();
  if (text[i] !== "{") fail("no opening brace");
  i++;
  ws();
  if (text[i] === "}") {
    i++;
  } else {
    for (;;) {
      const m = BARE_KEY.exec(text.slice(i));
      if (!m) return fail("a bare key is expected");
      const key = m[0];
      i += key.length;
      ws();
      if (text[i] !== "=") fail("= after the key");
      i++;
      ws();
      const value = basicString();
      if (table.has(key)) fail(`duplicate key ${key}`);
      table.set(key, value);
      ws();
      if (text[i] === ",") {
        i++;
        ws();
        if (text[i] === "}") fail("a trailing comma");
        continue;
      }
      if (text[i] === "}") {
        i++;
        break;
      }
      fail(", or } after a value");
    }
  }
  if (i !== text.length) fail("text after the closing brace");
  return table;
}

test("codex-config: the reader used below is strict TOML for the inline-table subset — it rejects what TOML rejects", () => {
  const rejected: ReadonlyArray<readonly [string, RegExp]> = [
    ['{JARHEAD_SOCKET="/a",}', /trailing comma/],
    ['{JARHEAD_SOCKET=/a}', /basic string/],
    ['{JARHEAD_SOCKET="/a"', /, or }/],
    ['{JARHEAD_SOCKET="/a" JARHEAD_THREAD="t"}', /, or }/],
    ['{JARHEAD_SOCKET="/a"\n}', /, or }/],
    ['{JARHEAD_SOCKET="/a", JARHEAD_SOCKET="/b"}', /duplicate key/],
    ['{JARHEAD_SOCKET="/a\tb"}', /raw control character/],
    ['{JARHEAD_SOCKET="\\x41"}', /not a TOML escape/],
    ['{JARHEAD_SOCKET="/a"} x', /after the closing brace/],
    ['{"JARHEAD_SOCKET"="/a"}', /bare key/],
  ];
  for (const [text, why] of rejected) assert.throws(() => readTomlInlineTable(text), why, text);
  assert.deepEqual([...readTomlInlineTable("{}")], []);
  assert.deepEqual([...readTomlInlineTable('{ a = "x\\u00e9\\n" ,b="y" }')], [
    ["a", "xé\n"],
    ["b", "y"],
  ]);
});

test("codex-config: the bridge env parses as a TOML inline table and every value comes back as it went in — plain, thread, hostile", () => {
  const plain = readTomlInlineTable(codexBridgeEnv({ socketPath: base.socketPath }));
  assert.deepEqual([...plain], [["JARHEAD_SOCKET", base.socketPath]]);
  const thread = readTomlInlineTable(codexBridgeEnv({ socketPath: base.socketPath, thread: "t_7f3a" }));
  assert.deepEqual([...thread], [
    ["JARHEAD_SOCKET", base.socketPath],
    ["JARHEAD_THREAD", "t_7f3a"],
  ]);
  // Ids and paths that need every escape TOML has: quotes, a backslash, a brace, a tab,
  // a newline, a control character (BEL), DEL (which JSON leaves raw and TOML forbids),
  // a non-ASCII letter and an astral symbol.
  for (const id of ['t"} \\ evil', "t\t\n", `t${String.fromCharCode(7)}`, `t${String.fromCharCode(0x7f)}`, "té😀", "t_{}=,"]) {
    const socket = '/Users/kévin/.jarhead/jar"head.sock';
    const env = readTomlInlineTable(codexBridgeEnv({ socketPath: socket, thread: id }));
    assert.equal(env.get("JARHEAD_SOCKET"), socket, JSON.stringify(id));
    assert.equal(env.get("JARHEAD_THREAD"), id, JSON.stringify(id));
    assert.equal(env.size, 2);
  }
  // The whole -c argument: a dotted key, one =, a TOML value.
  const arg = envArg(codexMcpConfigArgs({ ...base, thread: "t_7f3a" }));
  const eq = arg.indexOf("=");
  assert.equal(arg.slice(0, eq), "mcp_servers.jarhead.env");
  assert.equal(readTomlInlineTable(arg.slice(eq + 1)).get("JARHEAD_THREAD"), "t_7f3a");
});
