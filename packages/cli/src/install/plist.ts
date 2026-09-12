/**
 * The XML plist subset `defaults export` emits, read and written without losing a
 * byte of meaning. The Dock domain carries `<data>` bookmark blobs and 14-digit
 * integers: `plutil -convert json` refuses the former and `Number()` would round the
 * latter, so scalars keep their text verbatim and entries keep their order. Nothing
 * here knows about the Dock; dock.ts does.
 */

export type PlistNode =
  | { readonly kind: "string"; readonly value: string }
  /** Digits kept as written ("20404966709239"): never through Number(). */
  | { readonly kind: "integer"; readonly text: string }
  | { readonly kind: "real"; readonly text: string }
  | { readonly kind: "bool"; readonly value: boolean }
  | { readonly kind: "date"; readonly text: string }
  /** Base64 with the whitespace stripped. */
  | { readonly kind: "data"; readonly base64: string }
  | { readonly kind: "array"; readonly items: readonly PlistNode[] }
  | { readonly kind: "dict"; readonly entries: ReadonlyArray<readonly [string, PlistNode]> };

export class PlistSyntaxError extends Error {
  constructor(message: string, readonly offset: number) {
    super(`${message} (at offset ${offset})`);
    this.name = "PlistSyntaxError";
  }
}

export const str = (value: string): PlistNode => ({ kind: "string", value });
export const int = (text: string): PlistNode => ({ kind: "integer", text });
export const dict = (entries: ReadonlyArray<readonly [string, PlistNode]>): PlistNode => ({ kind: "dict", entries });
export const array = (items: readonly PlistNode[]): PlistNode => ({ kind: "array", items });

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x")) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    if (body.startsWith("#")) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    return ENTITIES[body] ?? whole;
  });
}

function encodeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A forward-only cursor over the document: tags, text, and the prologue it skips. */
class Cursor {
  pos = 0;
  constructor(readonly src: string) {}

  fail(message: string): never {
    throw new PlistSyntaxError(message, this.pos);
  }

  /** Skip whitespace, comments, the xml declaration and the DOCTYPE. */
  skipNoise(): void {
    for (;;) {
      while (this.pos < this.src.length && /\s/.test(this.src[this.pos] as string)) this.pos++;
      if (this.src.startsWith("<?", this.pos)) {
        const end = this.src.indexOf("?>", this.pos);
        if (end < 0) this.fail("unterminated <?xml declaration");
        this.pos = end + 2;
        continue;
      }
      if (this.src.startsWith("<!--", this.pos)) {
        const end = this.src.indexOf("-->", this.pos);
        if (end < 0) this.fail("unterminated comment");
        this.pos = end + 3;
        continue;
      }
      if (this.src.startsWith("<!DOCTYPE", this.pos)) {
        const end = this.src.indexOf(">", this.pos);
        if (end < 0) this.fail("unterminated DOCTYPE");
        this.pos = end + 1;
        continue;
      }
      return;
    }
  }

  /** Read one tag: `<name …>`, `<name/>` or `</name>`. */
  tag(): { name: string; closing: boolean; selfClosing: boolean } {
    this.skipNoise();
    if (this.src[this.pos] !== "<") this.fail(`expected a tag, saw ${JSON.stringify(this.src.slice(this.pos, this.pos + 12))}`);
    const end = this.src.indexOf(">", this.pos);
    if (end < 0) this.fail("unterminated tag");
    let body = this.src.slice(this.pos + 1, end).trim();
    this.pos = end + 1;
    const closing = body.startsWith("/");
    if (closing) body = body.slice(1).trim();
    const selfClosing = body.endsWith("/");
    if (selfClosing) body = body.slice(0, -1).trim();
    const name = body.split(/\s+/)[0] ?? "";
    if (!name) this.fail("empty tag");
    return { name, closing, selfClosing };
  }

  /** Text up to the closing tag `</name>`, entities decoded. */
  textUntilClose(name: string): string {
    const close = `</${name}>`;
    const end = this.src.indexOf(close, this.pos);
    if (end < 0) this.fail(`unterminated <${name}>`);
    const raw = this.src.slice(this.pos, end);
    this.pos = end + close.length;
    return decodeEntities(raw);
  }

  expectClose(name: string): void {
    const t = this.tag();
    if (!t.closing || t.name !== name) this.fail(`expected </${name}>, saw <${t.closing ? "/" : ""}${t.name}>`);
  }

  atEnd(): boolean {
    this.skipNoise();
    return this.pos >= this.src.length;
  }
}

function parseNode(c: Cursor, opened?: { name: string; selfClosing: boolean }): PlistNode {
  const t = opened ?? c.tag();
  if (!opened && (t as { closing?: boolean }).closing) c.fail(`unexpected </${t.name}>`);
  switch (t.name) {
    case "string":
      return { kind: "string", value: t.selfClosing ? "" : c.textUntilClose("string") };
    case "integer":
      return { kind: "integer", text: t.selfClosing ? "" : c.textUntilClose("integer").trim() };
    case "real":
      return { kind: "real", text: t.selfClosing ? "" : c.textUntilClose("real").trim() };
    case "date":
      return { kind: "date", text: t.selfClosing ? "" : c.textUntilClose("date").trim() };
    case "data":
      return { kind: "data", base64: t.selfClosing ? "" : c.textUntilClose("data").replace(/\s+/g, "") };
    case "true":
      if (!t.selfClosing) c.expectClose("true");
      return { kind: "bool", value: true };
    case "false":
      if (!t.selfClosing) c.expectClose("false");
      return { kind: "bool", value: false };
    case "array": {
      const items: PlistNode[] = [];
      if (t.selfClosing) return { kind: "array", items };
      for (;;) {
        const next = c.tag();
        if (next.closing) {
          if (next.name !== "array") c.fail(`expected </array>, saw </${next.name}>`);
          return { kind: "array", items };
        }
        items.push(parseNode(c, next));
      }
    }
    case "dict": {
      const entries: Array<readonly [string, PlistNode]> = [];
      if (t.selfClosing) return { kind: "dict", entries };
      for (;;) {
        const next = c.tag();
        if (next.closing) {
          if (next.name !== "dict") c.fail(`expected </dict>, saw </${next.name}>`);
          return { kind: "dict", entries };
        }
        if (next.name !== "key") c.fail(`expected <key>, saw <${next.name}>`);
        const key = next.selfClosing ? "" : c.textUntilClose("key");
        entries.push([key, parseNode(c)]);
      }
    }
    default:
      return c.fail(`unknown element <${t.name}>`);
  }
}

/** Parse one document (`<plist>` wrapper optional). Throws PlistSyntaxError with the offset. */
export function parsePlistXml(xml: string): PlistNode {
  const c = new Cursor(xml);
  let t = c.tag();
  if (t.closing) c.fail("document starts with a closing tag");
  let wrapped = false;
  if (t.name === "plist") {
    if (t.selfClosing) c.fail("empty <plist/>");
    wrapped = true;
    t = c.tag();
    if (t.closing) c.fail("empty <plist>");
  }
  const root = parseNode(c, t);
  if (wrapped) c.expectClose("plist");
  if (!c.atEnd()) c.fail("trailing content after the document");
  return root;
}

/** CoreFoundation wraps base64 so indent (a tab counts 8) plus text stays within 76 columns. */
function dataLines(base64: string, depth: number): string[] {
  const width = Math.max(4, 76 - 8 * depth);
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += width) lines.push(base64.slice(i, i + width));
  return lines.length ? lines : [""];
}

function writeNode(node: PlistNode, depth: number, out: string[]): void {
  const pad = "\t".repeat(depth);
  switch (node.kind) {
    case "string":
      out.push(`${pad}<string>${encodeText(node.value)}</string>`);
      return;
    case "integer":
      out.push(`${pad}<integer>${node.text}</integer>`);
      return;
    case "real":
      out.push(`${pad}<real>${node.text}</real>`);
      return;
    case "date":
      out.push(`${pad}<date>${node.text}</date>`);
      return;
    case "bool":
      out.push(`${pad}<${node.value ? "true" : "false"}/>`);
      return;
    case "data":
      out.push(`${pad}<data>`);
      for (const line of dataLines(node.base64, depth)) out.push(`${pad}${line}`);
      out.push(`${pad}</data>`);
      return;
    case "array":
      if (node.items.length === 0) {
        out.push(`${pad}<array/>`);
        return;
      }
      out.push(`${pad}<array>`);
      for (const item of node.items) writeNode(item, depth + 1, out);
      out.push(`${pad}</array>`);
      return;
    case "dict":
      if (node.entries.length === 0) {
        out.push(`${pad}<dict/>`);
        return;
      }
      out.push(`${pad}<dict>`);
      for (const [key, value] of node.entries) {
        out.push(`${pad}\t<key>${encodeText(key)}</key>`);
        writeNode(value, depth + 1, out);
      }
      out.push(`${pad}</dict>`);
      return;
  }
}

/** Apple's layout: header, DOCTYPE, `<plist version="1.0">`, tab indent, `<array/>` / `<dict/>` for empties, a trailing newline. */
export function serializePlistXml(root: PlistNode): string {
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">', '<plist version="1.0">'];
  writeNode(root, 0, out);
  out.push("</plist>");
  return `${out.join("\n")}\n`;
}

export function dictGet(d: PlistNode, key: string): PlistNode | undefined {
  if (d.kind !== "dict") return undefined;
  return d.entries.find(([k]) => k === key)?.[1];
}

/** A new dict with `key` set: an existing key keeps its place, a new one goes last. */
export function dictSet(d: PlistNode, key: string, value: PlistNode): PlistNode {
  if (d.kind !== "dict") throw new TypeError("dictSet on a non-dict");
  const i = d.entries.findIndex(([k]) => k === key);
  const entries = d.entries.slice();
  if (i >= 0) entries[i] = [key, value];
  else entries.push([key, value]);
  return { kind: "dict", entries };
}

/** A new dict holding exactly `keys`, in that order; keys the dict lacks are skipped. */
export function dictOnly(d: PlistNode, keys: readonly string[]): PlistNode {
  if (d.kind !== "dict") throw new TypeError("dictOnly on a non-dict");
  const entries: Array<readonly [string, PlistNode]> = [];
  for (const key of keys) {
    const v = dictGet(d, key);
    if (v) entries.push([key, v]);
  }
  return { kind: "dict", entries };
}

/** The string value of a dict entry, or undefined when absent or not a string. */
export function stringAt(d: PlistNode, key: string): string | undefined {
  const v = dictGet(d, key);
  return v?.kind === "string" ? v.value : undefined;
}

/** The verbatim text of an integer entry, or undefined. */
export function integerAt(d: PlistNode, key: string): string | undefined {
  const v = dictGet(d, key);
  return v?.kind === "integer" ? v.text : undefined;
}
