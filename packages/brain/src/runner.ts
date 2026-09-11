import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyAction, logger, newId, type Decision } from "@jarhead/core";
import type { AgentRegistry } from "@jarhead/agents";
import { ComputerToolset, type ToolResult } from "@jarhead/hands";
import type { OverlayCommand, Point, Rect } from "@jarhead/protocol";
import type { BrainSink } from "./brain.ts";

/**
 * Executes tool calls by name. Both brains route every call through here so the
 * policy, the ledger, the screenshot archive, and the confirmation handshake
 * behave identically regardless of which model is asking.
 */

const log = logger("brain.runner");

export interface RunnerOptions {
  readonly toolset: ComputerToolset;
  readonly agents: AgentRegistry;
  readonly stateDir: string;
  /** Interim speech; wired to the current sink by the brain. */
  readonly speak?: (text: string) => void;
  /** The annotation layer: the show_* teaching shapes go out through here (the engine forwards them to the overlay). */
  readonly overlay?: (cmd: OverlayCommand) => void;
  readonly now?: () => number;
}

export interface RunOutcome {
  readonly result: ToolResult;
  /** Path (relative to stateDir) of the archived screenshot, when the result was an image. */
  readonly screenshotPath?: string;
  readonly ms: number;
}

export class ToolRunner {
  private readonly notes: { at: number; note: string }[] = [];
  private sink: BrainSink | undefined;
  private readonly now: () => number;

  constructor(private readonly opts: RunnerOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** The sink for the task currently running; tools that report progress use it. */
  attach(sink: BrainSink | undefined): void {
    this.sink = sink;
  }

  async run(name: string, input: unknown): Promise<RunOutcome> {
    const started = this.now();
    const args = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
    let result: ToolResult;
    try {
      result = await this.dispatch(name, args);
    } catch (e) {
      result = { kind: "error", message: (e as Error).message };
    }
    const ms = this.now() - started;

    let screenshotPath: string | undefined;
    if (result.kind === "image") {
      screenshotPath = this.archive(result.pngBase64);
      this.sink?.screenshot(screenshotPath, result.note);
    }
    this.sink?.step({
      kind: result.kind === "needs-confirmation" ? "confirm" : result.kind === "error" ? "error" : "tool",
      ...(result.kind === "needs-confirmation" ? { text: result.question } : result.kind === "error" ? { text: result.message } : {}),
      tool: { name, input: redact(args), output: summarize(result), ok: result.kind !== "error", ms },
      ...(screenshotPath ? { screenshotPath } : {}),
    });
    if (result.kind === "error") log.warn(`${name}: ${result.message}`);
    return { result, ...(screenshotPath ? { screenshotPath } : {}), ms };
  }

  private archive(pngBase64: string): string {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const rel = join("shots", day, `${newId("shot")}.png`);
    try {
      mkdirSync(join(this.opts.stateDir, "shots", day), { recursive: true });
      writeFileSync(join(this.opts.stateDir, rel), Buffer.from(pngBase64, "base64"));
    } catch (e) {
      log.warn(`could not archive screenshot: ${(e as Error).message}`);
    }
    return rel;
  }

  private async dispatch(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const { toolset, agents } = this.opts;
    if (toolset.isKnown(name)) return toolset.run(name, args);

    switch (name) {
      case "speak_progress": {
        const text = String(args["text"] ?? "").trim();
        if (!text) return { kind: "error", message: "speak_progress needs text" };
        (this.opts.speak ?? this.sink?.commentary.bind(this.sink))?.(text);
        return { kind: "text", text: "said" };
      }
      case "remember": {
        const note = String(args["note"] ?? "").trim();
        if (!note) return { kind: "error", message: "remember needs a note" };
        this.notes.push({ at: this.now(), note });
        return { kind: "text", text: `remembered (${this.notes.length} notes)` };
      }
      case "recall":
        return { kind: "text", text: this.notes.length ? this.notes.map((n) => `- ${n.note}`).join("\n") : "no notes yet" };
      case "run_shell":
        return this.runShell(String(args["command"] ?? ""), typeof args["cwd"] === "string" ? args["cwd"] : undefined);
      case "agents_list": {
        const { agents: list, health } = await agents.snapshot();
        const down = health.filter((h) => !h.ok).map((h) => `${h.kind}: ${h.detail}`);
        const rows = list.map((a) => `${a.id} | ${a.name} | ${a.status}${a.detail ? ` (${a.detail})` : ""}${a.cwd ? ` | ${a.cwd}` : ""}`);
        return { kind: "text", text: [...rows, ...(down.length ? [`unavailable: ${down.join("; ")}`] : [])].join("\n") || "no agents found" };
      }
      case "agent_send": {
        const target = await agents.find(String(args["agent"] ?? ""));
        if (!target) return { kind: "error", message: `no agent matching "${String(args["agent"])}"; call agents_list` };
        const r = await agents.send(target.id, String(args["text"] ?? ""));
        return r.accepted ? { kind: "text", text: `sent to ${target.name} (${target.id})${r.detail ? `: ${r.detail}` : ""}` } : { kind: "error", message: r.detail ?? "not accepted" };
      }
      case "agent_read": {
        const target = await agents.find(String(args["agent"] ?? ""));
        if (!target) return { kind: "error", message: `no agent matching "${String(args["agent"])}"` };
        const lines = typeof args["lines"] === "number" ? args["lines"] : 80;
        return { kind: "text", text: await agents.read(target.id, { lines }) };
      }
      case "agent_wait": {
        const target = await agents.find(String(args["agent"] ?? ""));
        if (!target) return { kind: "error", message: `no agent matching "${String(args["agent"])}"` };
        const timeoutMs = Math.min(600, Math.max(1, Number(args["timeout"] ?? 120))) * 1000;
        const settled = (await agents.waitSettled(target.id, timeoutMs)) ?? target;
        const output = await agents.read(target.id, { lines: 60 });
        return { kind: "text", text: `${settled.name}: ${settled.status}${settled.detail ? ` (${settled.detail})` : ""}\n${output}` };
      }
      case "agent_start": {
        // Vendor-neutral: `tool` names the CLI (`kind` is the old spelling). Codex threads
        // start through the sessions connector, which persists them like any other thread;
        // Claude Code keeps its own headless connector.
        const tool = String(args["tool"] ?? args["kind"] ?? "").trim().toLowerCase();
        if (!tool) return { kind: "error", message: "agent_start needs a tool: 'codex' or 'claude-code'" };
        const connectorKind = tool === "codex" ? "sessions" : tool === "claude-code" || tool === "claude" ? "claude-code" : undefined;
        if (!connectorKind) return { kind: "error", message: `unknown tool "${tool}"; agent_start starts 'codex' or 'claude-code' sessions` };
        const cwd = typeof args["cwd"] === "string" ? args["cwd"].trim() : "";
        if (!cwd) return { kind: "error", message: "agent_start needs cwd: the folder to work in" };
        const prompt = typeof args["prompt"] === "string" ? args["prompt"] : "";
        if (!prompt.trim()) return { kind: "error", message: "agent_start needs a prompt: the first thing to ask the agent" };
        const info = await agents.start(connectorKind, {
          ...(connectorKind === "sessions" ? { tool } : {}),
          cwd,
          prompt,
          ...(typeof args["name"] === "string" ? { name: args["name"] } : {}),
          ...(typeof args["projectId"] === "string" ? { projectId: args["projectId"] } : {}),
        });
        return { kind: "text", text: `started ${info.id} (${info.name}) in ${info.cwd ?? cwd} — ${info.status}${info.detail ? ` (${info.detail})` : ""}. Use agent_wait / agent_read on ${info.id} for its answer.` };
      }
      case "show_circle":
      case "show_arrow":
      case "show_rect":
      case "show_text":
      case "show_stroke":
      case "show_clear":
        return this.draw(name, args);
      default:
        return { kind: "error", message: `unknown tool ${name}` };
    }
  }

  // ------------------------------------------------------------- drawing

  /**
   * The show_* tools: shapes on the click-through overlay. The brain speaks in
   * pixels of its last screenshot, like every other tool, so the same Screen
   * mapping the clicks use turns them into global points; before any screenshot
   * the numbers are taken as global points as they are. Bad input throws and
   * run() turns that into an error result the model can read.
   */
  private draw(name: string, args: Record<string, unknown>): ToolResult {
    const ttlMs = ttlOf(args);
    const fade = `fades in ${Math.round((ttlMs ?? 6000) / 1000)} s`;
    const label = typeof args["label"] === "string" && args["label"].trim() ? { label: args["label"].trim().slice(0, 60) } : {};
    const ttl = ttlMs !== undefined ? { ttlMs } : {};
    switch (name) {
      case "show_clear":
        this.overlay({ cmd: "clear" });
        return { kind: "text", text: "cleared the drawings" };
      case "show_circle": {
        const p = this.toPoints(numberArg(args, "x"), numberArg(args, "y"));
        const radius = Math.max(4, this.toLength(numberArg(args, "radius")));
        this.overlay({ cmd: "circle", x: p.x, y: p.y, radius, ...label, ...ttl, tone: "accent" });
        return { kind: "text", text: `drew a circle at ${fmt(p)} (global points), radius ${Math.round(radius)}; ${fade}` };
      }
      case "show_arrow": {
        const [fx, fy] = pairArg(args, "from");
        const [tx, ty] = pairArg(args, "to");
        const from = this.toPoints(fx, fy);
        const to = this.toPoints(tx, ty);
        this.overlay({ cmd: "arrow", from, to, ...label, ...ttl, tone: "accent" });
        return { kind: "text", text: `drew an arrow from ${fmt(from)} to ${fmt(to)} (global points); ${fade}` };
      }
      case "show_rect": {
        const raw = args["rect"];
        if (!Array.isArray(raw) || raw.length !== 4 || !raw.every(isFiniteNumber)) throw new Error("rect must be [x, y, w, h] in screenshot pixels");
        const [x, y, w, h] = raw as [number, number, number, number];
        const origin = this.toPoints(Math.min(x, x + w), Math.min(y, y + h));
        const rect: Rect = { x: origin.x, y: origin.y, w: Math.max(1, this.toLength(Math.abs(w))), h: Math.max(1, this.toLength(Math.abs(h))) };
        this.overlay({ cmd: "rect", rect, ...label, ...ttl, tone: "accent" });
        return { kind: "text", text: `framed ${Math.round(rect.w)}×${Math.round(rect.h)} at ${fmt(rect)} (global points); ${fade}` };
      }
      case "show_text": {
        const text = String(args["text"] ?? "").trim();
        if (!text) throw new Error("show_text needs text");
        const p = this.toPoints(numberArg(args, "x"), numberArg(args, "y"));
        this.overlay({ cmd: "text", x: p.x, y: p.y, text: text.slice(0, 80), ...ttl, tone: "accent" });
        return { kind: "text", text: `wrote "${text.slice(0, 40)}" at ${fmt(p)} (global points); ${fade}` };
      }
      case "show_stroke": {
        const raw = args["points"];
        if (!Array.isArray(raw) || raw.length < 2) throw new Error("points must be [[x, y], [x, y], ...] with at least two points");
        const points: Point[] = raw.map((pt, i) => {
          if (!Array.isArray(pt) || pt.length !== 2 || !pt.every(isFiniteNumber)) throw new Error(`points[${i}] must be [x, y]`);
          return this.toPoints(pt[0] as number, pt[1] as number);
        });
        this.overlay({ cmd: "stroke", points, ...label, ...ttl, tone: "accent" });
        return { kind: "text", text: `drew a stroke through ${points.length} points, ${fmt(points[0]!)} to ${fmt(points[points.length - 1]!)} (global points); ${fade}` };
      }
      default:
        return { kind: "error", message: `unknown drawing tool ${name}` };
    }
  }

  private overlay(cmd: OverlayCommand): void {
    if (!this.opts.overlay) {
      log.debug(`no overlay attached; dropping ${cmd.cmd}`);
      return;
    }
    this.opts.overlay(cmd);
  }

  /** Screenshot pixel → global point through the last screenshot; taken as global before one exists. */
  private toPoints(x: number, y: number): Point {
    const screen = this.opts.toolset.screen;
    return screen.last ? screen.toPoints(x, y) : { x, y };
  }

  private toLength(n: number): number {
    const m = this.opts.toolset.screen.last;
    return m ? n / m.scale : n;
  }

  private runShell(command: string, cwd: string | undefined): Promise<ToolResult> {
    if (!command.trim()) return Promise.resolve({ kind: "error", message: "run_shell needs a command" });
    const confirmed = this.opts.toolset.confirmations.consume("run_shell", { command });
    const decision: Decision = classifyAction({ kind: "run_shell", text: command, confirmed });
    if (decision.verdict === "refuse") return Promise.resolve({ kind: "error", message: `refused: ${decision.reason}` });
    if (decision.verdict === "confirm") {
      const pending = this.opts.toolset.confirmations.ask(`run "${command.slice(0, 80)}"`, "run_shell", { command });
      return Promise.resolve({ kind: "needs-confirmation", pendingId: pending.id, question: `About to run "${command.slice(0, 80)}"${cwd ? ` in ${cwd}` : ""}. ${decision.reason}. Ask Kevin to confirm out loud, then stop.` });
    }
    return new Promise((resolve) => {
      execFile("/bin/zsh", ["-lc", command], { cwd: cwd ?? process.env["HOME"], timeout: 30_000, maxBuffer: 512 * 1024 }, (err, stdout, stderr) => {
        const out = `${stdout}${stderr ? `\n[stderr] ${stderr}` : ""}`.trim();
        if (err && (err as NodeJS.ErrnoException).code === "ETIMEDOUT") resolve({ kind: "error", message: `timed out after 30s\n${out.slice(0, 2000)}` });
        else resolve({ kind: "text", text: `${err ? `[exit ${(err as { code?: number }).code ?? "?"}] ` : ""}${out.slice(0, 6000) || "(no output)"}` });
      });
    });
  }
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function numberArg(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  if (!isFiniteNumber(v)) throw new Error(`${key} must be a number (screenshot pixels)`);
  return v;
}

function pairArg(args: Record<string, unknown>, key: string): [number, number] {
  const v = args[key];
  if (!Array.isArray(v) || v.length !== 2 || !v.every(isFiniteNumber)) throw new Error(`${key} must be [x, y] in screenshot pixels`);
  return [v[0] as number, v[1] as number];
}

/** ttlMs (or ttl_ms), clamped to something a person can see and nothing that lingers for minutes. */
function ttlOf(args: Record<string, unknown>): number | undefined {
  const v = args["ttlMs"] ?? args["ttl_ms"];
  if (!isFiniteNumber(v)) return undefined;
  return Math.min(60_000, Math.max(500, Math.round(v)));
}

function fmt(p: { x: number; y: number }): string {
  return `${Math.round(p.x)},${Math.round(p.y)}`;
}

function summarize(result: ToolResult): unknown {
  switch (result.kind) {
    case "image":
      return { image: `${result.width}x${result.height}`, ...(result.note ? { note: result.note } : {}) };
    case "text":
      return result.text.length > 600 ? `${result.text.slice(0, 600)}…` : result.text;
    case "error":
      return { error: result.message };
    case "needs-confirmation":
      return { needsConfirmation: result.question };
  }
}

function redact(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) out[k] = typeof v === "string" && v.length > 300 ? `${v.slice(0, 300)}…` : v;
  return out;
}

/** Render a ToolResult as the text a function-calling model reads. */
export function resultText(result: ToolResult): string {
  switch (result.kind) {
    case "text":
      return result.text;
    case "image":
      return `screenshot attached (${result.width}x${result.height} px)${result.note ? `; ${result.note}` : ""}`;
    case "error":
      return `error: ${result.message}`;
    case "needs-confirmation":
      return `needs_confirmation: ${result.question}`;
  }
}
