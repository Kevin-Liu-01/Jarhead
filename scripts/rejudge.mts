#!/usr/bin/env node
/**
 * Re-judge saved live-check reports with this checkout's judges (scripts/live-check.mts JUDGES). It is free: no
 * session, no engine, no request. It checks a judge against stored live evidence, and shows what a changed judge says
 * of a run already paid for.
 *
 *   node --import tsx scripts/rejudge.mts <report.json | a day's folder> ...
 *
 * The judge's inputs are rebuilt from the report: the marks, the sessions, the wire, the sink, the speech, the reflexes
 * and reflex rows, the canned brain, the fake hands, the ledger, the engine's delegations, and the day's meter
 * (final.usageSeconds as snapshot.usageToday). A judge that reads a field the report does not keep stops there and
 * prints "not re-judgeable: <field>". What it judged before that is printed as usual.
 *
 * The exit code is 0 when every hard assertion passed, 1 when one failed, 2 when a report could not be re-judged.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { UsageToday } from "@jarhead/protocol";
import { JUDGES, Recorder, idleMsFor, type Assertion, type CheckId, type Judge, type Report } from "./live-check.mts";

/** A hands call as saved: reports from before the parameters were kept have the op and its time only. */
interface SavedCall {
  readonly t: number;
  readonly op: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

/** A report as saved. Those written before a field was kept lack it. */
export type SavedReport = Omit<Report, "wall0" | "scale" | "idleMs" | "delegations" | "hands"> &
  Partial<Pick<Report, "wall0" | "scale" | "idleMs" | "delegations">> & { readonly hands: { readonly acting: readonly SavedCall[]; readonly reading: readonly SavedCall[] } };

export interface Rejudged {
  readonly check: CheckId;
  readonly assertions: readonly Assertion[];
  readonly metrics: Readonly<Record<string, unknown>>;
  /** The field the judge read and the report does not keep: the judge stopped there. */
  readonly notKept?: string;
  /** What the judge was given that the report only approximates. */
  readonly notes: readonly string[];
  /** Every hard assertion passed, and the judge ran to its end. */
  readonly pass: boolean;
}

class NotKept extends Error {
  constructor(readonly field: string) {
    super(`not re-judgeable: ${field}`);
  }
}

/** `o`, where reading a field it lacks throws NotKept naming it. */
function kept<T extends object>(o: T, path: string): T {
  return new Proxy(o, {
    get(target, key, receiver) {
      if (typeof key === "symbol" || key in target) return Reflect.get(target, key, receiver);
      throw new NotKept(path ? `${path}.${key}` : key);
    },
  });
}

type RecorderList = "marks" | "sessions" | "server" | "client" | "inText" | "outText" | "delegations" | "errors" | "usage" | "sockets" | "sink" | "speech" | "reflexes" | "reflexRows" | "events" | "phases" | "net" | "spawns";

/** The run's recorder, refilled from the report. A list the report does not keep throws NotKept when a judge reads it. */
function recorderOf(r: SavedReport, wall0: number): Recorder {
  const rec = new Recorder(wall0);
  const lists: readonly (readonly [RecorderList, unknown, string])[] = [
    ["marks", r.marks, "marks"],
    ["sessions", r.sessions, "sessions"],
    ["server", r.wire?.server, "wire.server"],
    ["client", r.wire?.client, "wire.client"],
    ["inText", r.wire?.inText, "wire.inText"],
    ["outText", r.wire?.outText, "wire.outText"],
    ["delegations", r.wire?.delegations, "wire.delegations"],
    ["errors", r.wire?.errors, "wire.errors"],
    ["usage", r.wire?.usage, "wire.usage"],
    ["sockets", r.wire?.sockets, "wire.sockets"],
    ["sink", r.sink, "sink"],
    ["speech", r.speech, "speech"],
    ["reflexes", r.reflexes, "reflexes"],
    ["reflexRows", r.reflexRows, "reflexRows"],
    ["events", r.events, "events"],
    ["phases", r.phases, "phases"],
    ["net", r.net, "net"],
    ["spawns", r.spawns, "spawns"],
  ];
  for (const [key, saved, field] of lists) {
    if (!Array.isArray(saved)) {
      Object.defineProperty(rec, key, {
        get: (): never => {
          throw new NotKept(field);
        },
      });
      continue;
    }
    const into = rec[key] as unknown[];
    for (const item of saved) into.push(item);
  }
  return rec;
}

/** Judge a saved report again. Never throws for what the report lacks: that is `notKept`. */
export function rejudge(r: SavedReport): Rejudged {
  const notes: string[] = [];
  const wall0 = r.wall0 ?? Date.parse(r.startedAt);
  if (r.wall0 === undefined) notes.push("wall0 is startedAt (the report predates wall0): ledger and hands times may read a few ms late");
  // A live run is judged at scale 1 always; a dry one's scale is kept from when it was.
  const scale = r.scale ?? (r.mode === "live" ? 1 : undefined);
  const idleMs = r.idleMs ?? (scale === undefined ? undefined : idleMsFor(r.check, r.mode, scale));
  const usageToday = r.final.usageSeconds === undefined ? undefined : (kept({ seconds: r.final.usageSeconds }, "snapshot.usageToday") as UsageToday);
  const hands = (calls: readonly SavedCall[], field: string): Judge["acting"] => ({
    calls: calls.map((c) => kept({ op: c.op, at: c.t + wall0, ...(c.params ? { params: c.params } : {}) }, `${field}[]`) as Judge["acting"]["calls"][number]),
  });
  const assertions: Assertion[] = [];
  const metrics: Record<string, unknown> = {};
  const judge = kept(
    {
      rec: recorderOf(r, wall0),
      ledger: r.ledger,
      snapshot: kept({ usageToday, ...(r.delegations ? { delegations: r.delegations } : {}) }, "snapshot") as Judge["snapshot"],
      brain: r.brain,
      acting: hands(r.hands.acting, "hands.acting"),
      reading: hands(r.hands.reading, "hands.reading"),
      ...(idleMs !== undefined ? { idleMs } : {}),
      ...(scale !== undefined ? { scale } : {}),
      // LC-3's scenario marks the oversize probe exactly when the run had --oversize.
      oversize: r.marks.some((m) => m.name === "oversize"),
      mode: r.mode,
      wall0,
      slack: r.slack,
      expect: (name: string, pass: boolean, value?: unknown, expect?: string, o?: { readonly soft?: boolean }): void => void assertions.push({ name, pass, ...(o?.soft ? { soft: true } : {}), ...(value !== undefined ? { value } : {}), ...(expect !== undefined ? { expect } : {}) }),
      metric: (name: string, value: unknown): void => void (metrics[name] = value),
    },
    "",
  ) as Judge;
  let notKept: string | undefined;
  try {
    JUDGES[r.check](judge);
  } catch (e) {
    if (!(e instanceof NotKept)) throw e;
    notKept = e.field;
  }
  const hard = assertions.filter((a) => !a.soft);
  return { check: r.check, assertions, metrics, ...(notKept !== undefined ? { notKept } : {}), notes, pass: notKept === undefined && hard.length > 0 && hard.every((a) => a.pass) };
}

/** The reports a path names: a report file, or every report in a folder (a day's), in name order. */
export function reportFiles(path: string): string[] {
  const full = resolve(path);
  if (!statSync(full).isDirectory()) return [full];
  return readdirSync(full)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => join(full, f));
}

export function main(argv: readonly string[], print: (line: string) => void = (l) => void process.stdout.write(`${l}\n`)): number {
  if (argv.length === 0) {
    print("Name a report: node --import tsx scripts/rejudge.mts <report.json | a day's folder> ...");
    return 2;
  }
  let code = 0;
  for (const file of argv.flatMap(reportFiles)) {
    let r: SavedReport;
    try {
      r = JSON.parse(readFileSync(file, "utf8")) as SavedReport;
    } catch (e) {
      print(`${file}: not a report (${(e as Error).message})`);
      code = 2;
      continue;
    }
    if (!(r.check in JUDGES) || !Array.isArray(r.assertions)) {
      print(`${file}: not a live-check report`);
      code = 2;
      continue;
    }
    if (r.refused) {
      print(`${basename(file)}: ${r.check} was refused, nothing to judge (${r.refused})`);
      continue;
    }
    const out = rejudge(r);
    print(`${basename(file)}: ${r.check} ${r.name}, ${r.mode}, ${r.head}, ${r.startedAt}${r.ran ? "" : `, did not run to its end${r.capHit ? " (cut at the cap)" : r.ceilingHit ? " (cut at the ceiling)" : ""}`}`);
    for (const note of out.notes) print(`  note: ${note}`);
    for (const a of out.assertions) print(`  ${a.pass ? "pass" : "FAIL"}${a.soft ? " (soft)" : ""}  ${a.name}: ${JSON.stringify(a.value)}${a.expect ? `  [${a.expect}]` : ""}`);
    if (out.notKept) print(`  not re-judgeable: ${out.notKept}`);
    for (const [name, value] of Object.entries(out.metrics)) print(`  metric ${name} = ${JSON.stringify(value)}`);
    const hard = out.assertions.filter((a) => !a.soft);
    print(`  ${r.check}: ${out.notKept ? "not re-judgeable" : out.pass ? "pass" : "FAIL"} (${hard.filter((a) => a.pass).length}/${hard.length} hard; the run itself said ${r.pass ? "pass" : "FAIL"})`);
    if (out.notKept) code = 2;
    else if (!out.pass && code === 0) code = 1;
  }
  return code;
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked && import.meta.url === pathToFileURL(invoked).href) {
  process.exitCode = main(process.argv.slice(2));
}
